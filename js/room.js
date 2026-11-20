/* GetLow – room modes and subwoofer placement.
 *
 * A rectangular room L × W × H with hard-ish walls, solved as a sum of its
 * standing waves (the modal model, good below the Schroeder frequency):
 *   fn = c/2 · √((nx/L)² + (ny/W)² + (nz/H)²)
 *   ψn(x,y,z) = cos(nx·π·x/L) · cos(ny·π·y/W) · cos(nz·π·z/H),  Λn = Π (½ for each n ≠ 0)
 *   p(ω) = ωρc²Q/V · |Σ ψn(sub)·ψn(seat) / (Λn·(ωn² − ω² + 2jδω))|
 * δ = 3·ln10 / RT60 is the decay rate of every mode. The (0,0,0) term is the
 * pressure-vessel room gain below the lowest mode. The result is given relative
 * to the same sub at 1 m in half space, which is what GetLow's SPL chart shows,
 * so it adds straight on in dB.
 * Positions: x from the front wall, y from the left wall, z up from the floor.
 */
(function (GL) {
  'use strict';
  const C = () => GL.phys.c || 343.68;
  const delta = (rt60) => 3 * Math.LN10 / rt60;

  // Every mode up to fmax, lowest first.
  function modes(room, fmax) {
    const c = C(), { L, W, H } = room, out = [];
    const nL = Math.floor(2 * L * fmax / c), nW = Math.floor(2 * W * fmax / c), nH = Math.floor(2 * H * fmax / c);
    for (let i = 0; i <= nL; i++) for (let j = 0; j <= nW; j++) for (let k = 0; k <= nH; k++) {
      const f = c / 2 * Math.sqrt((i / L) ** 2 + (j / W) ** 2 + (k / H) ** 2);
      if (f > fmax) continue;
      const nz = (i > 0) + (j > 0) + (k > 0);
      out.push({ n: [i, j, k], f, kind: ['room gain', 'axial', 'tangential', 'oblique'][nz], lam: Math.pow(0.5, nz) });
    }
    return out.sort((a, b) => a.f - b.f);
  }

  const shape = (m, room, p) => Math.cos(m.n[0] * Math.PI * p.x / room.L) * Math.cos(m.n[1] * Math.PI * p.y / room.W) * Math.cos(m.n[2] * Math.PI * p.z / room.H);

  // Above this the modes overlap and the room behaves statistically.
  const schroeder = (room) => 2000 * Math.sqrt(room.rt60 / (room.L * room.W * room.H));

  // Mode list (with sum-over-modes coefficients) for a frequency range, cached
  // per room, since the placement scan reuses it hundreds of times.
  let cache = null;
  function modeSet(room, fTop) {
    const key = [room.L, room.W, room.H, room.rt60, fTop].join();
    if (cache && cache.key === key) return cache.ms;
    // modes well above the band still add a little (mass-like) to it
    const ms = modes(room, Math.max(2.5 * fTop, 120)).map(m => Object.assign(m, { w2: (2 * Math.PI * m.f) ** 2 }));
    cache = { key, ms };
    return ms;
  }

  // Seat SPL relative to 1 m half space, in dB, at each frequency. Several subs
  // (all driven the same) are summed.
  function response(room, subs, seat, freqs) {
    const fTop = freqs.reduce((a, b) => Math.max(a, b), 0);
    const ms = modeSet(room, fTop);
    const c = C(), V = room.L * room.W * room.H, d2 = 2 * delta(room.rt60);
    subs = [].concat(subs);
    const coef = ms.map(m => shape(m, room, seat) * subs.reduce((s, p) => s + shape(m, room, p), 0) / subs.length / m.lam);
    const out = new Float64Array(freqs.length);
    for (let i = 0; i < freqs.length; i++) {
      const w = 2 * Math.PI * freqs[i];
      let re = 0, im = 0;
      for (let k = 0; k < ms.length; k++) {
        const a = coef[k];
        if (!a) continue;
        const dr = ms[k].w2 - w * w, di = d2 * w, q = a / (dr * dr + di * di);
        re += q * dr; im -= q * di;
      }
      // |p_room / p_halfspace@1m| = (ωρc²/V·|Σ|) / (ωρ/2π)
      out[i] = 20 * Math.log10(2 * Math.PI * c * c / V * Math.hypot(re, im));
    }
    return out;
  }

  // Log-spaced points across a band, 1/24 octave apart.
  function band(f0, f1, perOct = 24) {
    const n = Math.max(2, Math.round(Math.log2(f1 / f0) * perOct) + 1), out = [];
    for (let i = 0; i < n; i++) out.push(f0 * Math.pow(f1 / f0, i / (n - 1)));
    return out;
  }

  // How even the bass is: standard deviation (dB) of the room's effect over the band.
  function evenness(db) {
    let s = 0, s2 = 0;
    for (const v of db) { s += v; s2 += v * v; }
    const m = s / db.length;
    return { sd: Math.sqrt(Math.max(0, s2 / db.length - m * m)), mean: m };
  }

  // Try the sub (or the seat) at every spot on a grid across the room, at its
  // current height, keeping the other where it is. `move` is 'sub' or 'seat'.
  // With two subs, the second follows the first mirrored across the room
  // (opts.mirror = 'width' | 'length' | 'both').
  function scan(room, place, move, f0, f1, nx = 24) {
    const fr = band(f0, f1);
    const ny = Math.max(4, Math.round(nx * room.W / room.L));
    const cells = [];
    let best = null;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const p = { x: (i + 0.5) * room.L / nx, y: (j + 0.5) * room.W / ny };
      const q = move === 'seat' ? { subs: subsFor(room, place), seat: Object.assign({}, place.seat, p) }
        : { subs: subsFor(room, Object.assign({}, place, { sub: Object.assign({}, place.sub, p) })), seat: place.seat };
      const e = evenness(response(room, q.subs, q.seat, fr));
      // right beside the seat the sub always sounds smooth (you hear it before the room),
      // but nobody puts it there: leave spots within 1 m out of the "best" pick
      const near = q.subs.some(s => Math.hypot(s.x - q.seat.x, s.y - q.seat.y) < 1);
      const cell = { i, j, x: p.x, y: p.y, sd: e.sd, mean: e.mean, near };
      cells.push(cell);
      if (!near && (!best || cell.sd < best.sd)) best = cell;
    }
    return { nx, ny, cells, best, dx: room.L / nx, dy: room.W / ny };
  }

  // Positions of every sub: the first where it is, a second one mirrored.
  function subsFor(room, place) {
    const s = place.sub, out = [s];
    if (place.count === 2) {
      const m = place.mirror || 'width';
      out.push({ x: m === 'width' ? s.x : room.L - s.x, y: m === 'length' ? s.y : room.W - s.y, z: s.z });
    }
    return out;
  }

  // How strongly a mode is excited at a point: 1 = pressure peak, 0 = null.
  const level = (m, room, p) => Math.abs(shape(m, room, p));

  GL.room = { modes, response, band, evenness, scan, subsFor, schroeder, level, delta };
})(window.GL);
