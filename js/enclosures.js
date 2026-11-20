/* GetLow – enclosure types: default designs, port / passive-radiator math and
 * conversion of a design into an acoustic network for the simulator. */
(function (GL) {
  'use strict';
  const { phys, el } = GL;
  const IN = GL.units.IN;

  const TYPES = [
    { id: 'sealed', name: 'Sealed' },
    { id: 'ported', name: 'Ported (vented)' },
    { id: 'pr',     name: 'Passive radiator' },
    { id: 'bp4',    name: '4th order bandpass' },
    { id: 'manifold', name: 'Manifold (bandpass, drivers facing each other)' },
    { id: 'bp6p',   name: '6th order bandpass – parallel (dual reflex)' },
    { id: 'bp6s',   name: '6th order bandpass – series tuned' },
    { id: 'bp8',    name: '8th order bandpass' },
    { id: 'tl',     name: 'Transmission line / quarter-wave' },
    { id: 'pipe',   name: 'Pipe / tube (front loaded)' },
    { id: 'blh',    name: 'Back-loaded horn' },
    { id: 'flh',    name: 'Front-loaded horn' },
    { id: 'th',     name: 'Tapped horn' },
  ];
  const typeName = (id) => (TYPES.find(t => t.id === id) || {}).name || id;
  const isLine = (type) => type === 'tl' || type === 'pipe';
  // bandpass family: F3 measured against the peak, with an upper roll-off
  const isBandpass = (type) => /^bp/.test(type) || type === 'manifold';
  const isHorn = (type) => type === 'blh' || type === 'flh' || type === 'th';
  const isBoxless = (type) => isLine(type) || isHorn(type);

  // ---- horns ----
  const FLARES = [
    { id: 'exp', name: 'Exponential' },
    { id: 'hyp', name: 'Hyperbolic-exponential (T)' },
    { id: 'con', name: 'Conical' },
    { id: 'par', name: 'Parabolic (area grows linearly)' },
  ];
  const SPACES = [
    { id: '4pi', name: 'Free air (4π)', omega: 4 * Math.PI },
    { id: '2pi', name: 'On the floor / in a wall (2π)', omega: 2 * Math.PI },
    { id: '1pi', name: 'Floor and wall (π)', omega: Math.PI },
    { id: 'half', name: 'In a corner (π/2)', omega: Math.PI / 2 },
  ];
  const spaceOmega = (id) => (SPACES.find(s => s.id === id) || SPACES[1]).omega;

  // cosh u + T sinh u = r  → u (hyperbolic-exponential flare)
  function solveU(r, T) {
    const g = (u) => Math.cosh(u) + T * Math.sinh(u) - r;
    let lo = 0, hi = 1;
    while (g(hi) < 0 && hi < 200) hi *= 2;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (g(m) < 0) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  // One flare section, area S(x) = S1·f(x)² with f''/f constant (see physics.sectionT).
  function makeSection(S1, S2, L, type, T) {
    const r = Math.sqrt(S2 / S1);
    const sec = { S1, S2, L, Smean: (S1 + S2) / 2, c0: 0, fc: 0, f: () => 1, df: () => 0 };
    if (Math.abs(r - 1) < 1e-9) return sec;
    if (type === 'con') {
      const g = (r - 1) / L;
      sec.f = (x) => 1 + g * x; sec.df = () => g;
    } else if (type === 'hyp' && r > 1) {
      const t = Math.max(0, T == null ? 0.7 : T), x0 = L / solveU(r, t);
      sec.c0 = 1 / (x0 * x0); sec.fc = phys.c / (2 * Math.PI * x0);
      sec.f = (x) => Math.cosh(x / x0) + t * Math.sinh(x / x0);
      sec.df = (x) => (Math.sinh(x / x0) + t * Math.cosh(x / x0)) / x0;
    } else {                                    // exponential (also used for a shrinking 'hyp')
      const x0 = L / Math.log(r);
      sec.c0 = 1 / (x0 * x0); sec.fc = phys.c / (2 * Math.PI * Math.abs(x0));
      sec.f = (x) => Math.exp(x / x0); sec.df = (x) => Math.exp(x / x0) / x0;
    }
    return sec;
  }
  // Sections for one horn segment starting at area S1. Parabolic = linear
  // area growth, built from short conical pieces.
  function segSections(S1, seg) {
    const L = Math.max(1e-4, seg.len);
    if (seg.flare !== 'par') return [makeSection(S1, seg.s2, L, seg.flare, seg.T)];
    const n = 24, out = [];
    for (let i = 0; i < n; i++) out.push(makeSection(S1 + (seg.s2 - S1) * i / n, S1 + (seg.s2 - S1) * (i + 1) / n, L / n, 'con'));
    return out;
  }
  function hornSegments(H) {
    let S1 = H.s1;
    return H.segments.map(seg => { const s = segSections(S1, seg); S1 = seg.s2; return s; });
  }
  // Area along the horn: [{x, S}], sampled for tables, volume and 3D.
  function hornProfile(H, perSeg) {
    const pts = [];
    let x0 = 0;
    for (const secs of hornSegments(H)) {
      for (const s of secs) {
        const n = perSeg || 16;
        for (let i = (pts.length ? 1 : 0); i <= n; i++) {
          const x = s.L * i / n, f = s.f(x);
          pts.push({ x: x0 + x, S: s.S1 * f * f });
        }
        x0 += s.L;
      }
    }
    return pts;
  }
  function hornVolume(H) {
    const p = hornProfile(H, 32);
    let v = 0;
    for (let i = 1; i < p.length; i++) v += (p[i].x - p[i - 1].x) * (p[i].S + p[i - 1].S) / 2;
    return v;
  }
  const hornLength = (H) => H.segments.reduce((s, g) => s + g.len, 0);
  const hornMouth = (H) => H.segments.length ? H.segments[H.segments.length - 1].s2 : H.s1;
  // Keele: mouth circumference ≈ one wavelength at cutoff in free air; each
  // halving of the radiation space halves the area needed.
  const idealMouth = (fc, spaceId) => {
    const lam = phys.c / fc;
    return lam * lam / (4 * Math.PI) * spaceOmega(spaceId) / (4 * Math.PI);
  };
  // One-segment horn from a cutoff frequency, throat area and mouth area.
  function hornFromCutoff(fc, s1, s2, flare, T) {
    const x0 = phys.c / (2 * Math.PI * fc);
    const r = Math.sqrt(s2 / s1);
    let len;
    if (flare === 'hyp') len = x0 * solveU(r, T == null ? 0.7 : T);
    else len = x0 * Math.log(r);               // exponential length (also used for conical/parabolic)
    return { flare, len, s2, T: T == null ? 0.7 : T };
  }

  // End correction per end as a multiple of that end's radius: [outer, inner].
  // flanged-free sums to 1.4633 r = WinISD's 0.732 x diameter.
  const END_CORR = {
    'flanged-free':    { k: [0.85, 0.6133], name: 'One end flanged (flush on baffle)' },
    'flanged-flanged': { k: [0.85, 0.85],   name: 'Both ends flanged' },
    'free-free':       { k: [0.6133, 0.6133], name: 'Both ends free' },
  };

  // ---- ports ----
  // Round ports: d is the throat (narrowest) diameter; flareOut / flareIn are
  // round-over radii at each end (0 = straight). Slots: alongWall = one side
  // is the cabinet wall, fullHeight = runs between the top and bottom panels.
  const portArea = (p) => p.shape === 'slot' ? p.w * p.h : Math.PI * p.d * p.d / 4;
  const flareLen = (p) => p.shape === 'slot' ? (p.slotOut || 0) + (p.slotIn || 0) : (p.flareOut || 0) + (p.flareIn || 0);
  // Slots: round-overs on the edges at each end (slotOut at the baffle,
  // slotIn inside). A slot against a wall has one free edge at each end
  // (the other side is the wall); a free-standing slot has two.
  const slotEdges = (p) => p.alongWall !== false ? 1 : 2;

  // Round-over profile: radius at distance x (0..R) from the flared end.
  const flareR = (a, R, x) => a + R - Math.sqrt(Math.max(0, R * R - (R - x) * (R - x)));
  // ∫ dx / S(x) over one flare (Simpson's rule)
  function flareIntegral(a, R) {
    if (!(R > 0)) return 0;
    const n = 64, hh = R / n;
    let s = 0;
    for (let i = 0; i <= n; i++) {
      const r = flareR(a, R, i * hh);
      s += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) / (Math.PI * r * r);
    }
    return s * hh / 3;
  }

  // Extra acoustic length beyond the physical length, in throat-area terms:
  // the port acts like a straight throat-size tube of length len + portEnd(p).
  function portEnd(p) {
    const S = portArea(p);
    const [ko, ki] = END_CORR[p.end].k;
    if (p.shape === 'slot') {
      // Image method at the inner end: the cabinet wall (and top/bottom for a
      // full-height slot) mirror the opening, enlarging its effective size.
      // The outer end opens onto the baffle, where those walls stop.
      // Rounded ends: the width grows along each round-over; integrate 1/S
      // through it and take the end correction at the wider mouth.
      const Ro = p.slotOut || 0, Ri = p.slotIn || 0, k = slotEdges(p);
      const fl = (R) => {
        if (!(R > 0)) return 0;
        const n = 64, hh = R / n;
        let sum = 0;
        for (let i = 0; i <= n; i++) sum += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) / (p.h * (p.w + k * flareR(0, R, i * hh)));
        return sum * hh / 3;
      };
      const So = p.h * (p.w + k * Ro), Si = p.h * (p.w + k * Ri);
      const img = (p.alongWall !== false ? 2 : 1) * (p.fullHeight ? 2 : 1);
      const extra = fl(Ro) + fl(Ri) + ko * Math.sqrt(So / Math.PI) / So + ki * Math.sqrt(Si * img / Math.PI) / Si;
      return extra * S - (Ro + Ri);
    }
    const a = p.d / 2;
    const Ro = p.flareOut || 0, Ri = p.flareIn || 0;
    // a flared end radiates from its wider mouth: correction k*r at radius r
    const end = (k, R) => k / (Math.PI * (a + R));
    const extra = flareIntegral(a, Ro) + flareIntegral(a, Ri) + end(ko, Ro) + end(ki, Ri);
    return extra * S - (Ro + Ri);
  }
  const portMass = (p) => phys.rho * (Math.max(p.len, flareLen(p)) + portEnd(p)) / (portArea(p) * p.count);

  // Profile from the outer end inward: [[x, r], ...] (round ports only)
  function portProfile(p) {
    const a = p.d / 2, Ro = p.flareOut || 0, Ri = p.flareIn || 0;
    const L = Math.max(p.len, Ro + Ri);
    const pts = [];
    const n = 12;
    if (Ro > 0) for (let i = 0; i <= n; i++) pts.push([Ro * i / n, flareR(a, Ro, Ro * i / n)]);
    else pts.push([0, a]);
    if (Ri > 0) for (let i = n; i >= 0; i--) pts.push([L - Ri * i / n, flareR(a, Ri, Ri * i / n)]);
    else pts.push([L, a]);
    return pts;
  }
  // Volume the port takes up inside the box (air + tube wall).
  function portDisplacement(p, panelT) {
    if (p.shape === 'slot') return (p.w + panelT * (p.alongWall !== false ? 1 : 2)) * p.h * p.len * p.count;
    const wall = p.wall || 0;
    const prof = portProfile(p);
    let v = 0;
    for (let i = 1; i < prof.length; i++) {
      const [x0, r0] = prof[i - 1], [x1, r1] = prof[i];
      const R0 = r0 + wall, R1 = r1 + wall;
      v += Math.PI * (x1 - x0) * (R0 * R0 + R0 * R1 + R1 * R1) / 3;   // conical frustum
    }
    return v * p.count;
  }
  const cab = (vol) => vol / phys.rc2();
  const helmholtz = (Map, Cab) => 1 / (2 * Math.PI * Math.sqrt(Map * Cab));
  const portFb = (p, vol) => helmholtz(portMass(p), cab(vol));
  function lenForFb(p, vol, fb) {
    const w = 2 * Math.PI * fb;
    const Leff = portArea(p) * p.count * phys.c * phys.c / (w * w * vol);
    return Leff - portEnd(p);
  }

  // Air-speed guidelines for port noise (peak m/s). A straight port with
  // square edges starts to be heard around 17 m/s (5% of c) and chuffs and
  // compresses audibly by about 25 m/s. Generous round-overs at both ends
  // delay the separation that makes the noise: up to +8 m/s when the flare
  // radius reaches the port radius.
  function portSpeedLimits(p) {
    let fr = 0;
    if (p && p.shape === 'round') fr = Math.min(1, Math.min(p.flareOut || 0, p.flareIn || 0) / (p.d / 2));
    if (p && p.shape === 'slot') fr = Math.min(1, Math.min(p.slotOut || 0, p.slotIn || 0) / (p.w / 2));
    return { quiet: 17 + 8 * fr, loud: 25 + 8 * fr, flared: fr > 0 };
  }
  // Smallest port (same count, same tuning) that stays under `vlim` when it
  // now peaks at `vpk`. Flow is fixed by the box, so speed scales as 1/area.
  function quietSize(p, vol, fb, vpk, vlim) {
    const k = vpk / vlim;
    const q = Object.assign({}, p);
    if (p.shape === 'round') q.d = p.d * Math.sqrt(k);
    else q.w = p.w * k;
    q.len = lenForFb(q, vol, fb);
    return q;
  }

  // ---- passive radiators ----
  function prMech(pr) {
    const Cm = pr.vas / (phys.rc2() * pr.sd * pr.sd);
    const ws = 2 * Math.PI * pr.fs;
    const M0 = 1 / (ws * ws * Cm);
    return { Cm, M0, Mm: M0 + (pr.added || 0), Rm: ws * M0 / pr.qms };
  }
  // Box + PR tuning: PR mass resonating with box and PR suspension in series.
  function prFb(pr, vol) {
    const { Cm, Mm } = prMech(pr);
    const Map = Mm / (pr.sd * pr.sd * pr.count);
    const Cap = Cm * pr.sd * pr.sd * pr.count;
    const Cab = cab(vol);
    return helmholtz(Map, Cab * Cap / (Cab + Cap));
  }
  function addedForFb(pr, vol, fb) {
    const { Cm, M0 } = prMech(pr);
    const Cap = Cm * pr.sd * pr.sd * pr.count, Cab = cab(vol);
    const w = 2 * Math.PI * fb;
    const Map = 1 / (w * w * (Cab * Cap / (Cab + Cap)));
    return Map * pr.sd * pr.sd * pr.count - M0;
  }

  // ---- transmission line / pipe geometry ----
  function lineAreas(line) {
    if (line.shape === 'round') return { s0: Math.PI * line.d0 * line.d0 / 4, sL: Math.PI * line.dL * line.dL / 4 };
    return { s0: line.width * line.h0, sL: line.width * line.hL };
  }
  // Closed-open pipe resonances with mouth end correction.
  function quarterWave(line, n) {
    const { sL } = lineAreas(line);
    const corr = (line.mouthFlanged ? 0.8216 : 0.6133) * Math.sqrt(sL / Math.PI);
    const out = [];
    for (let k = 1; k <= (n || 4); k++) out.push((2 * k - 1) * phys.c / (4 * (line.length + corr)));
    return out;
  }
  // Simple stuffing model: extra attenuation rising with frequency and a
  // modest drop in sound speed. Approximate - tune by ear / measurement.
  function lineLoss(S, stuffing) {
    const r = Math.sqrt(S / Math.PI);
    const cs = phys.c / (1 + 0.12 * stuffing);
    return (w) => {
      const f = w / (2 * Math.PI);
      return { alpha: 3e-5 * Math.sqrt(f) / r + stuffing * 0.004 * f, cs };
    };
  }

  // ---- defaults ----
  const roundIn = (m, step) => Math.max(step, Math.round(m / IN / step) * step) * IN;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let seq = 0;
  const pid = (pfx) => pfx + (++seq) + Math.random().toString(36).slice(2, 5);

  function chamber(id, name, vol) { return { id, name, vol, ql: 10, qa: 100, bracing: 0 }; }
  function makePort(name, from, to, area) {
    const d = roundIn(Math.sqrt(4 * area / Math.PI), 0.5);
    return {
      id: pid('p'), name, from, to, shape: 'round', d, w: roundIn(Math.sqrt(area / 4), 0.25),
      h: roundIn(Math.sqrt(area * 4), 0.25), len: 0.2, count: 1, end: 'flanged-free', qp: 100, wall: 0.25 * IN,
      flareOut: 0, flareIn: 0, alongWall: true, fullHeight: false,
    };
  }

  function makeDesign(type, drvc, count) {
    const p = drvc.params;
    const n = count || 1;
    const vas = p.vas * n, qts = p.qts, fs = p.fs;
    const sdT = p.sd * n;
    // Starting volumes: worked out for ONE driver from its own Fs, Qts and Vas,
    // then multiplied by the number of drivers. Only token floors, so small
    // full-range drivers aren't blown up to subwoofer-sized boxes.
    const vas1 = p.vas;
    // sealed: Qtc 0.707, or for high-Qts drivers the nearest sensible Qtc (1.3 × Qts, up to 1.0)
    const qtc = qts < 0.6 ? 0.707 : Math.min(1.0, qts * 1.3);
    const vSealed1 = qtc > qts * 1.01 ? vas1 / (Math.pow(qtc / qts, 2) - 1) : vas1;
    const vSealed = clamp(vSealed1, 0.00005, 0.25) * n;
    const fc = fs * Math.sqrt(1 + vas / vSealed);
    // vented: QB3-style alignment (Keele): Vb = 15 Qts^2.87 Vas, Fb = 0.42 Fs Qts^-0.9
    const vVent = clamp(clamp(15 * Math.pow(qts, 2.87) * vas1, 0.2 * vas1, 6 * vas1), 0.0001, 0.4) * n;
    const fbVent = clamp(0.42 * fs * Math.pow(qts, -0.9), 12, 250);
    const pArea = sdT * 0.15;

    const D = {
      type, count: n, wiring: 'parallel', driverDisp: p.dvol || 0,
      mount: { rear: 'A', front: 'out' }, chambers: [], ports: [], prs: [], line: null, horn: null,
    };
    const tunePort = (pt, fb) => {
      const vol = D.chambers.find(c => c.id === pt.from).vol;
      pt.len = Math.max(0.02, lenForFb(pt, vol, fb));
      return pt;
    };

    switch (type) {
      case 'sealed':
        D.chambers = [chamber('A', 'Box', vSealed)];
        break;
      case 'ported':
        D.chambers = [chamber('A', 'Box', vVent)];
        D.ports = [tunePort(makePort('Port', 'A', 'out', pArea), fbVent)];
        break;
      case 'pr': {
        D.chambers = [chamber('A', 'Box', vVent)];
        const pr = { id: pid('r'), name: 'Passive radiator', from: 'A', fs: fs * 0.6, qms: 8, vas: p.vas, sd: p.sd,
          added: 0, count: n, xmax: (p.xmax || 0.01) * 2, disp: 0 };
        pr.added = Math.max(0, addedForFb(pr, vVent, fbVent));
        D.prs = [pr];
        break;
      }
      case 'manifold':
        // Drivers on two facing dividers, each with its own sealed rear
        // chamber, firing into a shared vented middle chamber. Both sides
        // are identical, so acoustically it's a 4th-order bandpass with the
        // rear volume split in two.
        D.mount = { rear: 'R1', front: 'F', rear2: 'R2' };
        D.chambers = [chamber('R1', 'Rear, side A (sealed)', vSealed / 2), chamber('F', 'Manifold (ported)', vSealed * 0.8),
                      chamber('R2', 'Rear, side B (sealed)', vSealed / 2)];
        D.ports = [tunePort(makePort('Manifold port', 'F', 'out', pArea), fc * 1.1)];
        break;
      case 'bp4':
        D.mount = { rear: 'R', front: 'F' };
        D.chambers = [chamber('R', 'Rear (sealed)', vSealed), chamber('F', 'Front (ported)', vSealed * 0.8)];
        D.ports = [tunePort(makePort('Front port', 'F', 'out', pArea), fc * 1.1)];
        break;
      case 'bp6p':
        D.mount = { rear: 'R', front: 'F' };
        D.chambers = [chamber('R', 'Rear (ported)', vVent), chamber('F', 'Front (ported)', vSealed * 0.8)];
        D.ports = [tunePort(makePort('Rear port', 'R', 'out', pArea), fbVent * 0.9),
                   tunePort(makePort('Front port', 'F', 'out', pArea), fc * 1.8)];
        break;
      case 'bp6s':
        D.mount = { rear: 'R', front: 'F' };
        D.chambers = [chamber('R', 'Rear (sealed)', vSealed), chamber('F', 'Middle', vSealed * 0.8),
                      chamber('C', 'Front (vented out)', vSealed * 0.7)];
        D.ports = [tunePort(makePort('Inner port', 'F', 'C', pArea), fc * 1.0),
                   tunePort(makePort('Outer port', 'C', 'out', pArea), fc * 1.7)];
        break;
      case 'bp8':
        D.mount = { rear: 'R', front: 'F' };
        D.chambers = [chamber('R', 'Rear (ported)', vVent), chamber('F', 'Middle', vSealed * 0.7),
                      chamber('C', 'Front (vented out)', vSealed * 0.7)];
        D.ports = [tunePort(makePort('Rear port', 'R', 'out', pArea), fbVent * 0.85),
                   tunePort(makePort('Inner port', 'F', 'C', pArea), fc * 1.1),
                   tunePort(makePort('Outer port', 'C', 'out', pArea), fc * 1.9)];
        break;
      case 'tl': {
        // quarter-wave fundamental near Fs, offset driver, gentle taper
        const L = phys.c / (4 * fs);
        const s0 = sdT * 1.2, sL = sdT * 0.8;
        const width = roundIn(Math.sqrt(s0), 0.25);
        D.mount = { rear: 'line', front: 'out' };
        D.line = { shape: 'rect', length: L, width, h0: s0 / width, hL: sL / width,
          d0: Math.sqrt(4 * s0 / Math.PI), dL: Math.sqrt(4 * sL / Math.PI),
          drvPos: 0.2, stuffing: 0.3, mouthFlanged: true, segments: 48 };
        break;
      }
      case 'blh': {
        // cone front plays directly; rear chamber → horn. The chamber and the
        // throat form a low-pass (f = c·St / 2πV) that hands over to the front.
        const st = sdT * 0.8, fc = clamp(fs * 0.8, 30, 200);
        D.mount = { rear: 'R', front: 'out' };
        D.chambers = [chamber('R', 'Rear chamber', phys.c * st / (2 * Math.PI * 180))];
        const s2 = Math.min(idealMouth(fc, '2pi'), st * 40);
        D.horn = { s1: st, attach: 'R', space: '2pi', shape: 'rect', width: Math.sqrt(st) * 1.5, segments: [hornFromCutoff(fc, st, s2, 'exp')] };
        break;
      }
      case 'flh': {
        // cone fires into a small throat chamber, then the horn; sealed rear chamber
        const st = sdT * 0.5, fc = clamp(fs * 1.2, 40, 400);
        const vr = fc > fs * 1.05 ? vas / (Math.pow(fc / fs, 2) - 1) : vas;
        const vtc = Math.max(phys.c * st / (2 * Math.PI * 6000), sdT * 0.002);
        D.mount = { rear: 'R', front: 'T' };
        D.chambers = [chamber('R', 'Rear chamber (sealed)', clamp(vr, 0.0002 * n, 0.3 * n)), chamber('T', 'Throat chamber', vtc)];
        const s2 = idealMouth(fc, '2pi') * 0.5;
        D.horn = { s1: st, attach: 'T', space: '2pi', shape: 'round', width: Math.sqrt(st), segments: [hornFromCutoff(fc, st, Math.max(s2, st * 4), 'hyp', 0.7)] };
        break;
      }
      case 'th': {
        // tapped horn: cone front at the closed throat end, rear tapped in a
        // short way along; total path about a quarter wave at ~0.8·Fs
        const L = phys.c / (4 * fs * 0.8);
        const s1 = sdT * 0.6, s2 = sdT * 1.2, s3 = sdT * 2.5;
        D.mount = { rear: 'h1', front: 'h0' };
        D.chambers = [];
        D.horn = { s1, attach: null, space: '2pi', shape: 'rect', width: Math.sqrt(sdT) * 1.2,
          segments: [{ flare: 'con', len: L * 0.25, s2, T: 0.7 }, { flare: 'con', len: L * 0.75, s2: s3, T: 0.7 }] };
        break;
      }
      case 'pipe': {
        // driver fires into the closed end of a pipe; rear in a small sealed chamber
        const dia = roundIn(Math.sqrt(4 * sdT * 1.2 / Math.PI), 1);
        D.mount = { rear: 'R', front: 'line' };
        D.chambers = [chamber('R', 'Rear (sealed)', vSealed * 0.6)];
        D.line = { shape: 'round', length: phys.c / (4 * 45), width: dia, h0: dia, hL: dia, d0: dia, dL: dia,
          drvPos: 0, stuffing: 0, mouthFlanged: false, segments: 48 };
        break;
      }
    }
    return D;
  }

  // ---- network construction ----
  // eg(w) -> complex volts per driver.
  function buildModel(design, drvc, eg) {
    const net = new GL.Network();
    const nodes = { out: 0 };
    const vol = {};
    // manifold: the two identical rear chambers act as one (same pressure)
    const twin = design.mount.rear2 && design.chambers.find(c => c.id === design.mount.rear2);
    for (const ch of design.chambers) {
      if (twin && ch === twin) continue;
      nodes[ch.id] = net.node(ch.name); vol[ch.id] = ch.vol;
    }
    if (twin) { nodes[twin.id] = nodes[design.mount.rear]; vol[design.mount.rear] += twin.vol; }
    const model = { net, drivers: [], radiators: [], ports: [], prs: [], wiring: design.wiring, tunings: [] };

    for (const pt of design.ports) {
      const Map = portMass(pt);
      const fb = helmholtz(Map, cab(vol[pt.from]));
      const e = net.add(el.port(nodes[pt.from], nodes[pt.to], Map, 2 * Math.PI * fb * Map / pt.qp, portArea(pt) * pt.count));
      model.ports.push({ el: e, label: pt.name, area: portArea(pt) * pt.count, cfg: pt, fb });
      if (pt.to === 'out') model.radiators.push({ label: pt.name, kind: 'port', id: pt.id, flow: (w, p) => e.flow(w, p) });
    }
    for (const pr of design.prs) {
      const m = prMech(pr);
      const e = net.add(el.passiveRadiator(nodes[pr.from], 0, m.Mm, m.Cm, m.Rm, pr.sd, pr.count));
      const fb = prFb(pr, vol[pr.from]);
      model.prs.push({ el: e, label: pr.name, xmax: pr.xmax, cfg: pr, fb });
      model.radiators.push({ label: pr.name, kind: 'pr', id: pr.id, flow: (w, p) => e.flow(w, p) });
    }

    // Chamber losses are given as Q values referenced to the chamber's own tuning.
    const p = drvc.params;
    for (const ch of design.chambers) {
      if (twin && ch === twin) continue;
      // stuffing: the chamber acts bigger and absorbs (GL.standing, if loaded)
      const stf = GL.standing ? GL.standing.effect(ch.stuff) : { k: 1, qa: Infinity };
      const C = cab(vol[ch.id] * stf.k);
      const vent = model.ports.find(x => x.cfg.from === ch.id || x.cfg.to === ch.id);
      const prv = model.prs.find(x => x.cfg.from === ch.id);
      let fref;
      if (vent) fref = helmholtz(vent.el.Map, C);
      else if (prv) fref = prv.fb;
      else fref = p.fs * Math.sqrt(1 + p.vas * design.count / vol[ch.id]);
      const wr = 2 * Math.PI * fref;
      const qa = 1 / (1 / ch.qa + 1 / stf.qa);
      net.add(el.compliance(nodes[ch.id], C, ch.ql / (wr * C), 1 / (wr * C * qa)));
    }

    if (design.line) {
      const L = design.line;
      const { s0, sL } = lineAreas(L);
      const N = L.segments || 48;
      const ln = [];
      for (let i = 0; i <= N; i++) ln.push(net.node('Line ' + i));
      for (let i = 0; i < N; i++) {
        const S = s0 + (sL - s0) * (i + 0.5) / N;
        net.add(el.tube(ln[i], ln[i + 1], S, L.length / N, lineLoss(S, L.stuffing)));
      }
      const m = net.add(el.mouth(ln[N], sL, L.mouthFlanged));
      model.radiators.push({ label: 'Line mouth', flow: (w, pp) => m.flow(w, pp) });
      model.ports.push({ el: m, label: 'Line mouth', area: sL, cfg: null, fb: quarterWave(L, 1)[0], mouth: true });
      nodes.line = ln[Math.min(N - 1, Math.round(L.drvPos * N))];
    }

    if (design.horn) {
      const H = design.horn;
      const segs = hornSegments(H);
      const hn = [H.attach ? nodes[H.attach] : net.node('Horn throat')];
      segs.forEach((_, i) => hn.push(net.node('Horn ' + (i + 1))));
      hn.forEach((nd, i) => { nodes['h' + i] = nd; });
      const els = segs.map((secs, i) => net.add(el.horn(hn[i], hn[i + 1], secs)));
      model.omega = spaceOmega(H.space);
      const m = net.add(el.pistonMouth(hn[hn.length - 1], hornMouth(H), model.omega));
      model.radiators.push({ label: 'Horn mouth', flow: (w, pp) => m.flow(w, pp) });
      model.ports.push({ el: { flow: (w, pp) => els[0].throatFlow(w, pp) }, label: 'Horn throat', area: H.s1, cfg: null, mouth: true, fix: 'a larger throat' });
      model.ports.push({ el: m, label: 'Horn mouth', area: hornMouth(H), cfg: null, mouth: true, fix: 'a larger mouth' });
      model.hornCutoffs = segs.map(secs => secs[0].fc);
    }

    const rear = nodes[design.mount.rear], front = nodes[design.mount.front];
    const d = net.add(el.driver(rear, front, drvc.model, design.count, eg));
    model.drivers.push(d);
    if (front === 0) model.radiators.unshift({ label: 'Driver', kind: 'driver', flow: (w, pp) => GL.cx.cscale(d.state(w, pp).U, design.count) });
    if (rear === 0) model.radiators.unshift({ label: 'Driver rear', kind: 'rear', flow: (w, pp) => GL.cx.cscale(d.state(w, pp).U, -design.count) });
    return model;
  }

  // Human readable signal path, e.g. "Driver rear → Rear (sealed) · front → Front → Front port → outside"
  function describe(design) {
    const nm = (id) => {
      if (id === 'out') return 'outside';
      if (id === 'line') return 'line';
      const hm = /^h(\d+)$/.exec(id);
      if (hm) return +hm[1] === 0 ? 'horn throat' : 'horn, end of segment ' + hm[1];
      return (design.chambers.find(c => c.id === id) || {}).name;
    };
    const parts = ['Cone rear → ' + nm(design.mount.rear) + (design.mount.rear2 ? ' / ' + nm(design.mount.rear2) : ''), 'cone front → ' + nm(design.mount.front)];
    for (const p of design.ports) parts.push(nm(p.from) + ' → ' + p.name + ' → ' + nm(p.to));
    for (const r of design.prs) parts.push(nm(r.from) + ' → ' + r.name + ' → outside');
    if (design.line) parts.push('line mouth → outside');
    if (design.horn) parts.push((design.horn.attach ? nm(design.horn.attach) + ' → ' : '') + 'horn → mouth → outside');
    return parts.join(' · ');
  }

  GL.enclosures = {
    TYPES, END_CORR, typeName, isLine, isHorn, isBandpass, isBoxless, makeDesign, buildModel, describe,
    FLARES, SPACES, spaceOmega, makeSection, segSections, hornSegments, hornProfile, hornVolume, hornLength, hornMouth,
    idealMouth, hornFromCutoff, solveU,
    portArea, portEnd, portMass, portFb, lenForFb, portSpeedLimits, quietSize, flareLen, slotEdges, portProfile, portDisplacement, prMech, prFb, addedForFb,
    lineAreas, quarterWave, cab, helmholtz,
  };
})(window.GL);
