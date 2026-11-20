/* GetLow – what happens outside and in the walls of a box:
 *
 * Baffle step and edge diffraction. A box standing free radiates into half
 * space only while its front panel is large compared with the wavelength; at
 * low frequencies it radiates into full space and loses 6 dB. Each baffle edge
 * re-radiates an inverted copy of the wave reaching it (the classic
 * edge-source model: half the incident pressure, spread evenly by angle as
 * seen from the source), which gives both the step and the ripple from the
 * edges. A round-over smears each edge over its arc, which averages out the
 * ripple at short wavelengths.
 *
 * Off-axis response of each radiator as a rigid piston in a baffle:
 *   D(θ) = 2·J1(ka·sinθ) / (ka·sinθ)
 *
 * Panel resonance: the first bending mode of a rectangular plate,
 *   f11 = (π/2)·(1/a² + 1/b²)·√(D/m),  D = E·t³ / 12(1−ν²),  m = ρ·t
 * for simply supported edges; clamped edges are about 1.8× higher, and glued
 * box joints sit between the two. 3D-printed walls are a sandwich: solid skins
 * (the perimeters) over a partly filled core (the infill).
 */
(function (GL) {
  'use strict';
  const X = GL.cx, C = X.C;
  const c0 = () => GL.phys.c;

  // ---------------------------------------------------------------- baffle
  // Distance from s along unit direction (ux, uy) to the edge of the
  // rectangle [-W/2, W/2] × [-H/2, H/2].
  function toEdge(s, ux, uy, W, H) {
    let t = Infinity;
    if (ux > 1e-12) t = Math.min(t, (W / 2 - s[0]) / ux); else if (ux < -1e-12) t = Math.min(t, (-W / 2 - s[0]) / ux);
    if (uy > 1e-12) t = Math.min(t, (H / 2 - s[1]) / uy); else if (uy < -1e-12) t = Math.min(t, (-H / 2 - s[1]) / uy);
    return Math.max(0, t);
  }

  // Edge points around a source at s = [x, y] on a W × H baffle (centre at 0).
  function edgePoints(s, W, H, n = 96) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const th = 2 * Math.PI * (i + 0.5) / n, ux = Math.cos(th), uy = Math.sin(th);
      const t = toEdge(s, ux, uy, W, H);
      pts.push([s[0] + ux * t, s[1] + uy * t, t]);
    }
    return pts;
  }

  // Piston directivity (pressure, relative to on axis).
  function piston(ka, sinT) {
    const x = ka * sinT;
    if (x < 1e-6) return 1;
    return 2 * GL.special.besselJ1(x) / x;
  }

  // Transfer of one radiator to a listener at distance dist and angle (radians,
  // horizontal), relative to the same radiator in an infinite baffle on axis
  // at that distance. src: { x, y, r } on the baffle (metres, centre = 0).
  // baffle: { W, H, round } or null (in a wall: no edges).
  // srcs[j] = { pts: [[x, y], ...] (one per driver or port of that radiator), r } or null.
  function makeField(srcs, baffle, dist) {
    const cache = new Map();
    const geo = (j, i, ang) => {
      const key = j + '|' + i + '|' + ang;
      if (cache.has(key)) return cache.get(key);
      const [sx, sy] = srcs[j].pts[i];
      const L = [dist * Math.sin(ang), 0, dist * Math.cos(ang)];
      const direct = Math.hypot(L[0] - sx, L[1] - sy, L[2]);
      const edges = baffle ? edgePoints([sx, sy], baffle.W, baffle.H).map(([ex, ey, t]) => {
        const back = Math.hypot(L[0] - ex, L[1] - ey, L[2]);
        return { extra: t + back - direct, amp: direct / back };
      }) : [];
      // phase of the direct path relative to the baffle centre, so several sources add up properly
      const g = { delay: direct - dist, edges, sinT: Math.sin(ang) };
      cache.set(key, g);
      return g;
    };
    return (j, w, ang = 0) => {
      const s = srcs[j];
      if (!s) return C(1);
      if (!s.pts.length) return s.mul ? s.mul(w) : C(1);
      const k = w / c0(), rad = typeof s.r === 'function' ? s.r(w / (2 * Math.PI)) : (s.r || 0), ka = k * rad;
      const dirT = piston(ka, Math.abs(Math.sin(ang)));
      const grazing = piston(ka, 1);       // what the piston sends along the baffle
      // a round-over spreads each edge over a quarter circle: average the phase over it
      const arcX = baffle ? k * (baffle.round || 0) * Math.PI / 4 : 0;
      const smear = arcX > 1e-6 ? Math.sin(arcX) / arcX : 1;
      let re = 0, im = 0;
      for (let i = 0; i < s.pts.length; i++) {
        const g = geo(j, i, ang);
        let r1 = dirT, i1 = 0;
        if (g.edges.length) {
          const a = -0.5 / g.edges.length * grazing * smear;
          for (const e of g.edges) {
            const ph = -k * e.extra;
            r1 += a * e.amp * Math.cos(ph); i1 += a * e.amp * Math.sin(ph);
          }
        }
        // only spread between several sources matters, not their shared distance
        const ph0 = s.pts.length > 1 ? -k * g.delay : 0;
        const c = Math.cos(ph0), sn = Math.sin(ph0);
        re += (r1 * c - i1 * sn) / s.pts.length; im += (r1 * sn + i1 * c) / s.pts.length;
      }
      return s.mul ? X.cmul(C(re, im), s.mul(w)) : C(re, im);
    };
  }

  // Rough centre of the baffle step: where the wavelength is about the size of the baffle.
  const stepFreq = (W, H) => 115 / Math.min(W, H);

  // Baffle-step compensation: coil L in parallel with resistor R, in series
  // with the driver. R sets the shelf depth; L is chosen so half the shelf
  // (in dB) is reached at fStep, taking the driver as a resistor Re.
  function bscValues(re, dB, fStep) {
    const R = re * (Math.pow(10, dB / 20) - 1);
    const att = (L) => {
      const w = 2 * Math.PI * fStep, z = X.cdiv(C(0, w * L * R), C(R, w * L));
      return 20 * Math.log10(X.cabs(X.cdiv(C(re), X.cadd(C(re), z))));
    };
    let lo = 1e-6, hi = 0.1;
    for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (-att(m) < dB / 2) lo = m; else hi = m; }
    return { R, L: Math.sqrt(lo * hi) };
  }
  // Its impedance at w (to add to the voice coil's).
  const bscZ = (L, R) => (w) => X.cdiv(C(0, w * L * R), C(R, w * L));

  // ---------------------------------------------------------------- panels
  // Wall materials. E (Pa), rho (kg/m³), nu, eta = loss factor (panel Q ≈ 1/eta).
  // Typical values; real batches and grain directions vary.
  const SUBSTANCES = {
    ply:     { name: 'Plywood',            E: 7e9,   rho: 600,  nu: 0.3,  eta: 0.02 },
    birch:   { name: 'Baltic birch ply',   E: 9e9,   rho: 680,  nu: 0.3,  eta: 0.02 },
    mdf:     { name: 'MDF',                E: 3.5e9, rho: 750,  nu: 0.25, eta: 0.04 },
    alu:     { name: 'Aluminium',          E: 69e9,  rho: 2700, nu: 0.33, eta: 0.002 },
    steel:   { name: 'Steel',              E: 200e9, rho: 7850, nu: 0.29, eta: 0.001 },
    acrylic: { name: 'Acrylic',            E: 3.2e9, rho: 1190, nu: 0.37, eta: 0.04 },
    pla:     { name: 'PLA (3D print)',     E: 3.5e9, rho: 1240, nu: 0.36, eta: 0.02,  print: true },
    petg:    { name: 'PETG (3D print)',    E: 2.1e9, rho: 1270, nu: 0.38, eta: 0.03,  print: true },
    abs:     { name: 'ABS / ASA (3D print)', E: 2.2e9, rho: 1050, nu: 0.35, eta: 0.03, print: true },
    resin:   { name: 'Resin (SLA print)',  E: 2.6e9, rho: 1180, nu: 0.35, eta: 0.04 },
  };

  // Bending stiffness (N·m) and mass per area (kg/m²) of a wall.
  // print: { skin (m, solid perimeters on each face), infill (0–1) }.
  function wall(sub, t, print) {
    const m = SUBSTANCES[sub] || SUBSTANCES.ply;
    const k = m.E / (12 * (1 - m.nu * m.nu));
    if (m.print && print && print.infill < 1) {
      const core = Math.max(0, t - 2 * (print.skin || 0));
      const fill = Math.max(0, Math.min(1, print.infill));
      return { D: k * (Math.pow(t, 3) - (1 - fill) * Math.pow(core, 3)), m: m.rho * (t - (1 - fill) * core), eta: m.eta };
    }
    return { D: k * Math.pow(t, 3), m: m.rho * t, eta: m.eta };
  }

  // First bending mode of an a × b panel: simply supported .. clamped.
  function plate(a, b, w) {
    const ss = Math.PI / 2 * (1 / (a * a) + 1 / (b * b)) * Math.sqrt(w.D / w.m);
    return { lo: ss, hi: ss * 1.8, q: 1 / w.eta };
  }

  // The free spans of a box's walls (inside faces, split by dividers).
  function spans(box, layout) {
    const I = layout.int, t = box.t, ch = layout.chambers, out = [];
    const along = box.split, other = along === 'W' ? 'H' : 'W';
    const multi = ch.length > 1;
    const wallName = { W: 'Sides', H: 'Top and bottom' };          // by the axis the wall faces
    const each = (base, fn) => multi
      ? ch.forEach(c => out.push(Object.assign({ name: base + ' (' + c.name.toLowerCase() + ')' }, fn(c.len))))
      : out.push(Object.assign({ name: base }, fn(I[along])));
    // walls facing the other axis run the length of every chamber
    each(wallName[other], (len) => ({ a: len, b: I.D, qty: 2, t }));
    out.push({ name: wallName[along], a: I[other], b: I.D, qty: 2, t });
    each('Back', (len) => ({ a: len, b: I[other], qty: 1, t }));
    each('Front baffle', (len) => ({ a: len, b: I[other], qty: 1, t: t * (box.layers || 1) }));
    if (multi) out.push({ name: 'Divider', a: I[other], b: I.D, qty: ch.length - 1, t });
    return out;
  }

  // Every panel's resonance, flagged when it falls inside the band [f0, f1].
  function panelModes(box, layout, f0, f1) {
    const sub = box.sub || 'ply';
    return spans(box, layout).map(p => {
      const r = plate(p.a, p.b, wall(sub, p.t, box.print));
      const inBand = r.lo < f1 && r.hi > f0;
      return Object.assign(p, r, { inBand, rings: inBand && r.q > 100 });   // metal-like: almost no damping of its own
    });
  }

  // ---------------------------------------------------------------- cone breakup
  // Above its first breakup mode a cone stops moving as one piece: the response
  // gets a resonant peak (sharp for stiff metal and ceramic cones, mild for
  // damped paper and polypropylene), then falls, and only the middle of the cone
  // keeps radiating, so it beams less than a rigid piston of the same size.
  // Datasheets seldom give the frequency; the estimate f ≈ K / D (D = effective
  // cone diameter) is a starting point to replace with the peak you see on the
  // datasheet's response graph.
  const CONES = {
    paper:  { name: 'Paper',                  K: 560, db: 4,  q: 2 },
    coated: { name: 'Coated / treated paper', K: 600, db: 3,  q: 2 },
    poly:   { name: 'Polypropylene',          K: 450, db: 2,  q: 1.2 },
    aramid: { name: 'Kevlar / aramid',        K: 520, db: 5,  q: 3 },
    glass:  { name: 'Glass fibre',            K: 520, db: 4,  q: 2.5 },
    carbon: { name: 'Carbon fibre',           K: 650, db: 6,  q: 4 },
    alu:    { name: 'Aluminium',              K: 700, db: 10, q: 8 },
    mag:    { name: 'Magnesium',              K: 650, db: 7,  q: 6 },
    ceramic:{ name: 'Ceramic',                K: 750, db: 14, q: 12 },
  };
  const coneDia = (sd) => 2 * Math.sqrt(sd / Math.PI);
  function breakupEstimate(sd, mat) {
    const m = CONES[mat] || CONES.paper;
    return { mat, f: Math.round(m.K / coneDia(sd) / 10) * 10, db: m.db, q: m.q };
  }
  // Response change from breakup: a peak (bell) at f, then a first-order roll-off from 2·f.
  function breakupH(w, bu) {
    const w0 = 2 * Math.PI * bu.f, A = Math.pow(10, bu.db / 40), q = bu.q;
    const num = C(w0 * w0 - w * w, w * w0 * A / q), den = C(w0 * w0 - w * w, w * w0 / (A * q));
    const lp = X.cinv(C(1, w / (2 * w0)));
    return X.cmul(X.cdiv(num, den), lp);
  }
  // Effective radiating radius: the whole cone below breakup, shrinking above it.
  const breakupRadius = (a, f, bu) => bu && bu.f > 0 && f > bu.f ? a * Math.sqrt(bu.f / f) : a;

  // ---------------------------------------------------------------- inside the box
  // Standing waves: a closed chamber has axial modes at n·c / 2L along each
  // inside dimension. They show up as peaks and dips once the box is big next
  // to the wavelength (columns, tall cabinets, small full-range boxes). The
  // driver excites a mode in proportion to |cos(nπ·x/L)| at its position: at
  // the middle of a dimension it sits in the null of the odd modes. Absorbent
  // filling damps them (it works on air movement, which peaks mid-chamber);
  // a wall lining only works once it is about an eighth of a wavelength thick.
  //
  // Stuffing also makes the chamber act bigger (the air inside a fibre fill
  // compresses isothermally rather than adiabatically) and adds absorption
  // loss, which lowers the box Q. Typical figures at full fill:
  const STUFF = {
    none:  { name: 'None',                                 grow: 0,    qa: Infinity, fill: false },
    poly:  { name: 'Polyester fibre fill',                 grow: 0.15, qa: 4,        fill: true },
    wool:  { name: 'Long-fibre wool',                      grow: 0.2,  qa: 3,        fill: true },
    lining:{ name: 'Foam or felt lining on the walls',     grow: 0.02, qa: 15,       fill: false },
  };
  // Effect of stuffing { mat, fill (0–1 of the volume, or of the wall area for a lining), thick (lining, m) }.
  function stuffEffect(st) {
    const m = st && STUFF[st.mat];
    if (!m || st.mat === 'none' || !(st.fill > 0)) return { k: 1, qa: Infinity, m: STUFF.none };
    const f = Math.min(1, st.fill);
    return { k: 1 + m.grow * f, qa: m.qa / f, m };
  }
  // How well the stuffing damps a mode at frequency f: 'damped' | 'partly' | 'undamped'.
  function damping(st, f) {
    const m = st && STUFF[st.mat];
    if (!m || st.mat === 'none' || !(st.fill > 0)) return 'undamped';
    if (m.fill) return st.fill >= 0.3 ? 'damped' : 'partly';
    const thick = st.thick || 0.025, from = c0() / (8 * thick);       // a lining works above about λ/8 of its thickness
    return f >= from && st.fill >= 0.5 ? 'damped' : f >= from / 2 ? 'partly' : 'undamped';
  }
  // Axial modes of one chamber. dims: [{ axis: 'W'|'H'|'D', len, at: driver position as a fraction 0–1, or null }]
  function chamberModes(dims, fmax, nmax = 4) {
    const out = [];
    for (const d of dims) for (let n = 1; n <= nmax; n++) {
      const f = n * c0() / (2 * d.len);
      if (n > 1 && f > fmax) break;
      const couple = d.at == null ? 1 : Math.abs(Math.cos(n * Math.PI * d.at));
      out.push({ axis: d.axis, len: d.len, n, f, couple });
    }
    return out.sort((a, b) => a.f - b.f);
  }

  GL.standing = { STUFF, effect: stuffEffect, damping, modes: chamberModes };
  GL.breakup = { CONES, estimate: breakupEstimate, H: breakupH, radius: breakupRadius };
  GL.baffle = { makeField, edgePoints, piston, stepFreq, bscValues, bscZ };
  GL.panels = { SUBSTANCES, wall, plate, spans, panelModes };
})(window.GL);
