/* GetLow – where drivers, ports and radiators sit on each mounting face (the
 * front baffle and bandpass dividers), and whether each port fits inside its
 * chamber. Ports that are too long to run straight are routed with up to two
 * 90° bends (round) or one fold along the far wall (slot).
 *
 * Coordinates (metres): box centred on the origin, x across the width,
 * y up, z toward the listener. The outer face of the front baffle is z = D/2.
 *
 * Rules used:
 *  - a port's open inner end must be at least one port width (diameter, or
 *    slot width) from whatever it points at: wall, driver, another port
 *  - tubes keep a small gap from walls, drivers, PRs and each other
 *  - lengths are measured along the centre line, sharp corners
 *  - a slot sits against one wall of its chamber. Full span = its panel runs
 *    between the two opposite panels, so it is glued on three edges (a brace)
 */
(function (GL) {
  'use strict';
  const GAP = 0.003;          // tube-to-anything gap
  const STEP = 0.004;         // sampling step for collision checks

  const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const neg = (a) => [-a[0], -a[1], -a[2]];
  const axisOf = (d) => d[0] ? 0 : d[1] ? 1 : 2;
  const signOf = (d) => d[0] + d[1] + d[2];
  const unit = (i, s) => { const v = [0, 0, 0]; v[i] = s; return v; };
  const AX6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  // wall names <-> directions (pointing at the wall)
  const SIDES = { right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0], front: [0, 0, 1], back: [0, 0, -1] };
  const sideName = (d) => Object.keys(SIDES).find(k => same(SIDES[k], d));
  // walls a slot on a face with this plane axis can sit against
  const sidesFor = (planeAxis) => Object.keys(SIDES).filter(k => axisOf(SIDES[k]) !== planeAxis);
  const defaultSide = (planeAxis) => planeAxis === 2 ? 'right' : planeAxis === 0 ? 'bottom' : 'right';

  // Estimated driver depth when the data sheet value isn't known.
  function driverGeom(params) {
    const r = params.dia > 0 ? params.dia / 2 : Math.sqrt(params.sd / Math.PI) * 1.18;
    const depth = params.depth > 0 ? params.depth : r * 1.0;
    return { r, depth, estimated: !(params.depth > 0) };
  }

  // A chamber's free space plus the things already in it.
  function space(lo, hi) {
    const obs = [];
    return {
      lo, hi, obs,
      clear(P, R) {
        for (let i = 0; i < 3; i++) if (P[i] - R < lo[i] || P[i] + R > hi[i]) return false;
        for (const o of obs) if (o.hits(P, R)) return false;
        return true;
      },
      // distance from P to the chamber wall along dir
      reach(P, dir) {
        const i = axisOf(dir);
        return signOf(dir) > 0 ? hi[i] - P[i] : P[i] - lo[i];
      },
    };
  }
  // driver (or PR) as a frustum: full radius at the mounting face B, half at
  // the back of the motor. a = unit axis pointing into the chamber.
  function frustum(B, a, r, depth, taper = 0.5) {
    const ext = r + depth + GAP;          // a box that surely contains it (to skip it when far away)
    return {
      bbox: [[B[0] - ext, B[1] - ext, B[2] - ext], [B[0] + ext, B[1] + ext, B[2] + ext]],
      hits(P, R) {
        const v = [P[0] - B[0], P[1] - B[1], P[2] - B[2]];
        const s = dot(v, a);
        if (s < -R || s > depth + R) return false;
        const k = Math.max(0, Math.min(1, s / depth));
        const rad = Math.hypot(v[0] - a[0] * s, v[1] - a[1] * s, v[2] - a[2] * s);
        return rad < r * (1 - taper * k) + R + GAP;
      },
    };
  }
  function boxObstacle(min, max) {
    return {
      box: [min, max],               // (lets a region be tested against it directly)
      hits(P, R) {
        const g = R + GAP;
        return P[0] > min[0] - g && P[0] < max[0] + g && P[1] > min[1] - g && P[1] < max[1] + g && P[2] > min[2] - g && P[2] < max[2] + g;
      },
    };
  }
  function tubeObstacle(pts, Rt) {
    const e = Rt + GAP;
    return {
      bbox: [[0, 1, 2].map(i => Math.min(...pts.map(q => q[i])) - e), [0, 1, 2].map(i => Math.max(...pts.map(q => q[i])) + e)],
      hits(P, R) {
        for (const q of pts) if (Math.hypot(P[0] - q[0], P[1] - q[1], P[2] - q[2]) < R + Rt + GAP) return true;
        return false;
      },
    };
  }
  // how far a ball of radius R can travel from P along dir
  function walk(sp, P, dir, R, limit) {
    let s = 0;
    while (s < limit) {
      const n = s + STEP;
      if (!sp.clear(add(P, dir, n), R)) break;
      s = n;
    }
    return s;
  }
  function samples(pts) {
    const out = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const n = Math.max(1, Math.ceil(L / (STEP * 2)));
      for (let j = 0; j <= n; j++) out.push(add(a, [b[0] - a[0], b[1] - a[1], b[2] - a[2]], j / n));
    }
    return out;
  }

  // Route a round port from P0 (centre of its outer end, on the mounting
  // face) going `back` into its chamber.
  function routeRound(sp, P0, back, pt, allowBends) {
    const d = pt.d, Ro = d / 2 + (pt.wall || 0), L = pt.len;
    const clr = d;
    const reach0 = sp.reach(P0, back);
    const leg1max = Math.max(0, reach0 - Ro - GAP);
    const perps = AX6.filter(v => dot(v, back) === 0);
    const minLeg = Ro;                                 // an elbow needs some straight after it
    const opts = [{ bends: 0, pts: [P0, add(P0, back, L)], slack: reach0 - L - clr, reach: reach0 - clr, dirs: [back] }];
    // first leg: all the way in, or a bit shorter when only a little is left over
    // ... or where something in the way (a cone on the far divider, a motor) stops it
    // (start once the tube is clear of the panel it goes through)
    const ib = axisOf(back), inWall = signOf(back) > 0 ? sp.lo[ib] : sp.hi[ib];
    const enter = Math.abs(P0[ib] - inWall) + Ro + GAP;
    const leg1free = allowBends && enter < leg1max ? Math.min(leg1max, enter + walk(sp, add(P0, back, enter), back, Ro, leg1max - enter)) : 0;
    const firsts = allowBends ? [...new Set([leg1max, Math.min(leg1max, L - 2 * Ro), leg1free, Math.min(leg1free, L - 2 * Ro)])].filter(v => v > Ro) : [];
    for (const leg1 of firsts) {
      const c1 = add(P0, back, leg1);
      const rem1 = L - leg1;
      for (const d2 of perps) {
        const tube = walk(sp, c1, d2, Ro, 4);
        const open = walk(sp, c1, d2, 1e-4, 4);       // clear run in front of the opening
        if (rem1 >= minLeg) {
          opts.push({ bends: 1, pts: [P0, c1, add(c1, d2, rem1)], dirs: [back, d2],
            slack: Math.min(tube - rem1, open - rem1 - clr), reach: leg1 + Math.min(tube, open - clr) });
        }
        // two bends: try a few lengths for the middle leg, then turn again
        const tries = new Set([tube, tube * 0.75, tube * 0.5, rem1 - 2 * minLeg].map(a => Math.min(tube, a)).filter(a => a >= 2 * Ro));
        for (const a of tries) {
          const c2 = add(c1, d2, a);
          const rem2 = L - leg1 - a;
          for (const d3 of [neg(back), ...perps]) {
            if (same(d3, d2) || same(d3, neg(d2))) continue;
            const t3 = walk(sp, c2, d3, Ro, 4);
            const o3 = walk(sp, c2, d3, 1e-4, 4);
            opts.push({ bends: 2, pts: [P0, c1, c2, add(c2, d3, Math.max(rem2, 0))], dirs: [back, d2, d3],
              slack: rem2 < minLeg ? -1 : Math.min(t3 - rem2, o3 - rem2 - clr), reach: leg1 + a + Math.min(t3, o3 - clr) });
          }
        }
      }
    }
    const fits = opts.filter(o => o.slack >= 0);
    let best;
    if (fits.length) {
      fits.sort((p, q) => p.bends - q.bends || q.slack - p.slack);
      best = fits[0];
    } else {
      opts.sort((p, q) => q.reach - p.reach);
      best = opts[0];
    }
    const legs = [];
    for (let i = 1; i < best.pts.length; i++) {
      const a = best.pts[i - 1], b = best.pts[i];
      legs.push({ from: a, to: b, dir: best.dirs[i - 1], len: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) });
    }
    return { kind: 'round', fits: fits.length > 0, bends: best.bends, legs, pts: best.pts, R: Ro,
      short: fits.length ? 0 : Math.max(0, L - best.reach), straightNeed: L + clr, straightRoom: reach0 };
  }

  // Slot against a wall. Frame: b = into the chamber, n = toward the wall it
  // sits against, m = along its span. Local coords: a along b from the
  // mounting face, c inward from the wall edge, e = world coordinate along m.
  function routeSlot(sp, f) {
    const { pt, b, n, face, wallEdge, e0, e1, t, tb, allowBends, wallName } = f;
    const w = pt.w, L = pt.len;
    const ib = axisOf(b), sb = signOf(b), iN = axisOf(n), sN = signOf(n), im = 3 - ib - iN;
    const onWall = pt.alongWall !== false;
    const cw = onWall ? 0 : t;                       // channel starts here (own outer panel first)
    const toWorld = (a, c, e) => { const P = [0, 0, 0]; P[ib] = face + sb * a; P[iN] = wallEdge - sN * c; P[im] = e; return P; };
    const aabb = (a0, a1, c0, c1, ea = e0, eb = e1) => {
      const p = toWorld(a0, c0, ea), q = toWorld(a1, c1, eb);
      return [[Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])]];
    };
    const A = sp.reach(toWorld(0, 0, e0), b);       // mounting face to far wall
    const Cmax = sp.reach(toWorld(0, 0, e0), neg(n)); // wall edge to the opposite wall
    const span = e1 - e0;
    const name = pt.name;
    // nothing else may sit where a channel or its panels go
    const free = (a0, a1, c0, c1) => {
      if (c1 > Cmax + 1e-9 || a0 < tb - 1e-9) return false;
      // boxes (panels, other slots, braces): overlap of two boxes, exactly
      const [mn, mx] = aabb(a0, a1, c0, c1);
      const boxes = sp.obs.filter(o => o.box), rest = sp.obs.filter(o => !o.box);
      for (const { box: [bmn, bmx] } of boxes) {
        if (mn[0] < bmx[0] + GAP && mx[0] > bmn[0] - GAP && mn[1] < bmx[1] + GAP && mx[1] > bmn[1] - GAP && mn[2] < bmx[2] + GAP && mx[2] > bmn[2] - GAP) return false;
      }
      // only the round ones that could reach this region
      const near = rest.filter(o => !o.bbox || (mn[0] < o.bbox[1][0] && mx[0] > o.bbox[0][0] && mn[1] < o.bbox[1][1] && mx[1] > o.bbox[0][1] && mn[2] < o.bbox[1][2] && mx[2] > o.bbox[0][2]));
      if (!near.length) return true;
      // the rest (driver baskets, round ports) are big and round: sample the region every 2 cm
      const na = Math.max(5, Math.ceil((a1 - a0) / 0.02)), nc = Math.max(3, Math.ceil((c1 - c0) / 0.02)), ne = Math.max(4, Math.ceil((e1 - e0) / 0.02));
      for (let i = 0; i <= na; i++) for (let j = 0; j <= nc; j++) for (let k = 0; k <= ne; k++) {
        const P = toWorld(a0 + (a1 - a0) * i / na, c0 + (c1 - c0) * j / nc, e0 + (e1 - e0) * k / ne);
        for (const o of near) {
          const bb = o.bbox;
          if (bb && (P[0] < bb[0][0] || P[0] > bb[1][0] || P[1] < bb[0][1] || P[1] > bb[1][1] || P[2] < bb[0][2] || P[2] > bb[1][2])) continue;
          if (o.hits(P, 0)) return false;
        }
      }
      return true;
    };
    // A route that doesn't fit can ask for runs longer than the chamber: panels (and their
    // outlines) never reach past its walls, so the cut list stays buildable.
    const inA = (a) => Math.max(tb, Math.min(A, a)), inC = (c) => Math.max(0, Math.min(Cmax, c));
    const panel = (label, a0, a1, c0, c1) => {
      a0 = inA(a0); a1 = inA(a1); c0 = inC(c0); c1 = inC(c1);
      return { name: name + ' ' + label, box: aabb(a0, a1, c0, c1), a: Math.max(a1 - a0, c1 - c0), b: span };   // length (not thickness) x span
    };
    const side = wallName(n), far = wallName(b), opp = wallName(neg(n)), base = face === undefined ? '' : wallName(neg(b));

    // Rounded folds. r = round-over on the inside corner of each fold; fill =
    // fillet blocks in the outer corners (radius r + w, so the width stays
    // constant). Air then follows an arc of radius r + w/2 round the fold,
    // which is shorter than the square-corner centre line, so the straight
    // runs must add up to a little more than the port length.
    const r = Math.max(0, pt.foldR || 0), fill = !!pt.foldFill;
    const rounded = r > 0 || fill;
    const save = (rc) => rounded ? (2 - Math.PI / 2) * (rc + w / 2) : 0;   // per 90° corner
    const rU = Math.min(r, t / 2);                   // a U turns round the panel end: full round at t/2
    // local outlines (a, c) for the 3D view
    const rect = (a0, a1, c0, c1) => { a0 = inA(a0); a1 = inA(a1); c0 = inC(c0); c1 = inC(c1); return [[a0, c0], [a1, c0], [a1, c1], [a0, c1]]; };
    const arc = (ca, cc, R, t0, t1) => { const out = []; for (let i = 0; i <= 10; i++) { const th = t0 + (t1 - t0) * i / 10; out.push([ca + R * Math.cos(th), cc + R * Math.sin(th)]); } return out; };
    // rectangle with rounded (convex) corners, radii keyed by corner
    const rr = (a0, a1, c0, c1, k = {}) => (([a0, a1, c0, c1]) => [
      ...(k.a0c0 > 0 ? arc(a0 + k.a0c0, c0 + k.a0c0, k.a0c0, Math.PI, 1.5 * Math.PI) : [[a0, c0]]),
      ...(k.a1c0 > 0 ? arc(a1 - k.a1c0, c0 + k.a1c0, k.a1c0, -Math.PI / 2, 0) : [[a1, c0]]),
      ...(k.a1c1 > 0 ? arc(a1 - k.a1c1, c1 - k.a1c1, k.a1c1, 0, Math.PI / 2) : [[a1, c1]]),
      ...(k.a0c1 > 0 ? arc(a0 + k.a0c1, c1 - k.a0c1, k.a0c1, Math.PI / 2, Math.PI) : [[a0, c1]])])([inA(a0), inA(a1), inC(c0), inC(c1)]);
    const rrect = (a0, a1, c0, c1, rLo, rHi) => rr(a0, a1, c0, c1, { a1c0: rLo, a1c1: rHi });
    // round-over on the slot panel where the air leaves (inner end)
    const rin = Math.min(Math.max(0, pt.slotIn || 0), t);
    // fillet in a corner at (ca, cc); sa, sc point into the box
    const cove = (ca, cc, ro, sa, sc) => {
      const cxa = ca + sa * ro, cxc = cc + sc * ro;
      const t0 = Math.atan2(-sc, 0), t1 = Math.atan2(0, -sa);
      let d = t1 - t0; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      return [[ca, cc], ...arc(cxa, cxc, ro, t0, t0 + d)];
    };
    const ro = r + w;
    const fillets = (corners) => fill ? corners.map(([ca, cc, sc]) => ({ poly: cove(ca, cc, ro, -1, sc) })) : [];
    const filletPanel = (k) => fill && k ? [{ name: name + ' slot corner fillet', a: span, b: ro, qty: k, fillet: true }] : [];
    const opts = [];

    // straight
    // the run along the wall, from the mounting face to a1
    const firstFree = (a1) => free(tb, Math.max(tb, a1), 0, cw + w + t);
    opts.push({ folds: 0, k: 0, max: A - w, ok: firstFree(Math.min(L, A)), build: () => ({
      segs: [{ len: L, along: side }],
      panels: [panel('slot wall', tb, L, cw + w, cw + w + t)].concat(onWall ? [] : [panel('slot outer wall', tb, L, 0, t)]),
      pieces: [{ poly: rr(tb, L, cw + w, cw + w + t, { a1c0: rin }) }].concat(onWall ? [] : [{ poly: rr(tb, L, 0, t, { a1c1: rin }) }]),
      blocks: [aabb(tb, L, 0, cw + w + t)] }) });
    const leg1 = A - w / 2;
    if (allowBends) {
      const outer = onWall ? [] : [panel('slot outer wall', tb, A, 0, t)];
      const outerP = onWall ? [] : [{ poly: rect(tb, A, 0, t) }];
      // one fold: along the far wall, away from the side wall
      const L1 = L + save(r), rem1 = L1 - leg1, cEnd = cw + w / 2 + rem1, cPanel = Math.max(cEnd, cw + w + t);
      opts.push({ folds: 1, k: 1, Lx: L1, max: leg1 + (Cmax - w) - (cw + w / 2),
        ok: firstFree(A - w - t) && free(A - w - t, A, cw + w + t, Math.min(Cmax, cPanel + w * 0.5)), build: () => ({
          segs: [{ len: leg1, along: side }, { len: rem1, along: far, toward: opp }],
          panels: [panel('slot wall', tb, A - w - t, cw + w, cw + w + t), panel('slot return wall', A - w - t, A - w, cw + w, cPanel), ...outer, ...filletPanel(1)],
          pieces: [{ poly: rect(tb, A - w - t, cw + w, cw + w + t) }, { poly: rrect(A - w - t, A - w, cw + w, cPanel, Math.min(r, t), rin) },
            ...outerP, ...fillets([[A, cw, 1]])],
          blocks: [aabb(tb, A - w - t, 0, cw + w + t), aabb(A - w - t, A, 0, cPanel)] }) });
      // two folds, U: back beside the first run, round the end of the shared panel
      const LU = L + 2 * save(rU);
      const leg2U = w + t, leg3U = LU - leg1 - leg2U, aEndU = A - w / 2 - leg3U, c3 = cw + w + t;
      opts.push({ folds: 2, k: 2, Lx: LU, shape: 'U', legsBefore: leg1 + leg2U, max: leg1 + leg2U + (A - w / 2 - tb - w),
        ok: c3 + w + t <= Cmax && firstFree(A) && free(Math.max(tb, aEndU), A, c3, c3 + w + t), build: () => ({
          segs: [{ len: leg1, along: side }, { len: leg2U, along: far, toward: opp }, { len: leg3U, along: 'first run', toward: base || 'front' }],
          panels: [panel('slot wall', tb, A - w, cw + w, cw + w + t), panel('slot outer wall (U)', aEndU, A, c3 + w, c3 + w + t), ...outer, ...filletPanel(2)],
          pieces: [{ poly: rrect(tb, A - w, cw + w, cw + w + t, rU, rU) }, { poly: rr(aEndU, A, c3 + w, c3 + w + t, { a0c0: rin }) },
            ...outerP, ...fillets([[A, cw, 1], [A, c3 + w, -1]])],
          blocks: [aabb(tb, A, 0, c3 + w + t)] }) });
      // two folds, wrap: across the far wall, then forward along the opposite wall
      const LC = L + 2 * save(r);
      const leg2C = (Cmax - w / 2) - (cw + w / 2), leg3C = LC - leg1 - leg2C, aEndC = A - w / 2 - leg3C;
      opts.push({ folds: 2, k: 2, Lx: LC, shape: 'wrap', legsBefore: leg1 + leg2C, max: leg1 + leg2C + (A - w / 2 - tb - w),
        ok: leg2C > 2 * w + t && firstFree(A - w - t) && free(A - w - t, A, cw + w + t, Cmax) && free(Math.max(tb, aEndC), A, Cmax - w - t, Cmax), build: () => ({
          segs: [{ len: leg1, along: side }, { len: leg2C, along: far, toward: opp }, { len: leg3C, along: opp, toward: base || 'front' }],
          panels: [panel('slot wall', tb, A - w - t, cw + w, cw + w + t), panel('slot return wall', A - w - t, A - w, cw + w, Cmax - w),
            panel('slot third wall', aEndC, A - w - t, Cmax - w - t, Cmax - w), ...outer, ...filletPanel(2)],
          pieces: [{ poly: rect(tb, A - w - t, cw + w, cw + w + t) }, { poly: rrect(A - w - t, A - w, cw + w, Cmax - w, Math.min(r, t), Math.min(r, t)) },
            { poly: rr(aEndC, A - w - t, Cmax - w - t, Cmax - w, { a0c1: rin }) }, ...outerP, ...fillets([[A, cw, 1], [A, Cmax, -1]])],
          blocks: [aabb(tb, A - w - t, 0, cw + w + t), aabb(A - w - t, A, 0, Cmax), aabb(aEndC, A, Cmax - w - t, Cmax)] }) });
    }
    const need = (o) => o.Lx != null ? o.Lx : L;
    // a second fold needs a real last run after it
    for (const o of opts) if (o.folds === 2) o.min = o.legsBefore + w / 2;
    if (f.cMin != null) {
      // through another chamber: the open end must be inside the target chamber
      for (const o of opts) {
        if (o.folds === 0 || o.shape === 'U') { o.ok = false; o.min = null; }
        else if (o.folds === 1) o.min = leg1 + (f.cMin - cw - w / 2);    // shortest slot that reaches it
      }
    }
    const fitting = opts.filter(o => o.ok && need(o) <= o.max + 1e-9 && (o.min == null || need(o) >= o.min));
    const okOpts = opts.filter(o => o.ok);
    const best = fitting[0] || okOpts.sort((p, q) => (need(p) - p.max) - (need(q) - q.max))[0] || opts[0];
    const g = best.build();
    const shortBy = fitting[0] ? 0 : Math.max(0, Math.min(...okOpts.map(o => need(o) - o.max), f.cMin != null ? Infinity : L - (A - w)));
    const tooShortToReach = !fitting[0] && f.cMin != null && okOpts.length > 0 && okOpts.every(o => o.min != null && need(o) < o.min);
    const noRoute = !fitting[0] && !okOpts.length;
    const res = { kind: 'slot', fits: !!fitting[0], bends: best.folds, shape: best.shape || null, short: tooShortToReach || !isFinite(shortBy) ? 0 : shortBy, tooShort: tooShortToReach, noRoute,
      w, span, onWall, wall: side, far, toward: opp, straightNeed: L + w, straightRoom: A,
      foldR: best.shape === 'U' ? rU : r, fill, rounded: rounded && best.folds > 0, corners: best.k,
      segs: g.segs, panels: g.panels, blocks: g.blocks, pieces: g.pieces,
      frame: { ib, sb, iN, sN, im, face, wallEdge, e0, e1 } };
    res.leg1 = g.segs[0].len;
    res.rem = g.segs.slice(1).reduce((s, x) => s + x.len, 0);
    const ro2 = Math.max(0, pt.slotOut || 0);
    res.opening = aabb(-0.0006, 0.0006, onWall ? cw : cw - ro2, cw + w + ro2);
    return res;
  }

  // Lay out every mounting face and route every port.
  // Lay everything out. A slot with no wall chosen goes on the usual wall; if
  // it doesn't fit there, each other wall is tried and the first where it fits
  // (without pushing anything else out) is kept.
  function plan(design, box, layout, params) {
    const sa = box.split === 'W' ? 0 : 1;
    const fitting = (pl) => pl.ports.filter(x => x.route.fits).length;
    let over = {}, best = planOnce(design, box, layout, params, over);
    for (const pt of design.ports) {
      if (pt.shape !== 'slot' || pt.via) continue;
      const plane = pt.to === 'out' ? 2 : sa;
      if (pt.wallSide && sidesFor(plane).includes(pt.wallSide)) continue;      // the user's choice stands
      const cur = best.ports.find(x => x.pt === pt);
      if (!cur || cur.route.fits) continue;
      for (const side of sidesFor(plane)) {
        if (side === cur.route.side) continue;
        const tryOver = Object.assign({}, over, { [pt.id]: side });
        const trial = planOnce(design, box, layout, params, tryOver);
        const mine = trial.ports.find(x => x.pt === pt);
        if (mine && mine.route.fits && fitting(trial) > fitting(best)) {
          mine.route.movedFrom = cur.route.wall;
          best = trial; over = tryOver;
          break;
        }
      }
    }
    return best;
  }

  function planOnce(design, box, layout, params, over) {
    const { W, H, D } = box.ext, t = box.t;
    const sa = box.split === 'W' ? 0 : 1;           // split axis
    const zF = D / 2, zBi = -D / 2 + t, zFi = D / 2 - t * box.layers;
    const drv = driverGeom(params);
    // isobaric tunnel: a sleeve and a second driver behind the first
    const iso = design.iso && design.iso.on ? design.iso.mode : null;
    const one = drv.depth;
    if (iso === 'tunnel') { drv.depth = 2 * one + 0.01; drv.taper = 0.25; }
    drv.iso = iso; drv.one = one;
    const ext = [W, H, D];
    const chambers = {};
    layout.chambers.forEach((c, i) => {
      const a0 = -ext[sa] / 2 + c.start;
      const lo = [-W / 2 + t, -H / 2 + t, zBi], hi = [W / 2 - t, H / 2 - t, zFi];
      lo[sa] = a0; hi[sa] = a0 + c.len;
      chambers[c.id] = { i, lo, hi, sp: space(lo, hi) };
    });
    const nCh = layout.chambers.length;
    // what bounds a chamber in direction dir: a divider or an outside panel
    const wallNameFor = (id) => (dir) => {
      const i = chambers[id].i;
      if (axisOf(dir) === sa && (signOf(dir) > 0 ? i < nCh - 1 : i > 0)) return 'divider';
      return sideName(dir) === 'front' ? 'baffle' : sideName(dir) + ' wall';
    };

    // ---- faces: the front baffle of each chamber, and each divider ----
    const faces = [];
    const front = {};
    for (const id in chambers) {
      const ch = chambers[id];
      const f = { kind: 'front', id, plane: 2, coord: zF, tb: t * box.layers, uv: [0, 1],
        rect: { lo: [ch.lo[0], ch.lo[1]], hi: [ch.hi[0], ch.hi[1]] }, items: [], slots: [], crowded: false };
      faces.push(f);
      front[id] = f;
    }
    const dividers = {};
    const divider = (idA, idB) => {
      const a = chambers[idA], b = chambers[idB];
      if (!a || !b || Math.abs(a.i - b.i) !== 1) return null;
      const lowId = a.i < b.i ? idA : idB, highId = a.i < b.i ? idB : idA;
      const key = lowId + '|' + highId;
      if (!dividers[key]) {
        const pos = chambers[lowId].hi[sa];            // low chamber's wall = divider's low face
        const others = [0, 1, 2].filter(k => k !== sa);
        const lo = chambers[lowId].lo, hi = chambers[lowId].hi;
        dividers[key] = { kind: 'divider', lowId, highId, plane: sa, lowFace: pos, highFace: pos + t, tb: t, uv: others,
          rect: { lo: [lo[others[0]], lo[others[1]]], hi: [hi[others[0]], hi[others[1]]] }, items: [], slots: [], crowded: false };
        faces.push(dividers[key]);
      }
      return dividers[key];
    };

    const mount = design.mount;
    if (mount.front === 'out') {
      if (front[mount.rear]) for (let k = 0; k < design.count; k++) front[mount.rear].items.push({ type: 'drv', size: 2 * drv.r, into: mount.rear });
    } else if (mount.rear2) {
      // manifold: half the drivers on each facing divider
      const a = divider(mount.rear, mount.front), b = divider(mount.rear2, mount.front);
      const half = Math.ceil(design.count / 2);
      if (a) for (let k = 0; k < half; k++) a.items.push({ type: 'drv', size: 2 * drv.r, into: mount.rear, cone: mount.front });
      if (b) for (let k = 0; k < design.count - half; k++) b.items.push({ type: 'drv', size: 2 * drv.r, into: mount.rear2, cone: mount.front });
    } else {
      const f = divider(mount.rear, mount.front);
      if (f) for (let k = 0; k < design.count; k++) f.items.push({ type: 'drv', size: 2 * drv.r, into: mount.rear, cone: mount.front });
    }
    for (const pt of design.ports) {
      let f = null;
      if (pt.to === 'out') f = front[pt.from];
      else f = divider(pt.from, pt.to);
      if (!f) continue;
      const sz = pt.shape === 'slot' ? pt.w : pt.d + 2 * (pt.wall || 0) + 2 * Math.max(pt.flareOut || 0, pt.flareIn || 0);
      // through-chamber slot: mouth on the neighbour's baffle, along its outer wall,
      // along the back wall, through a notch in the divider into its own chamber
      const via = pt.to === 'out' && pt.shape === 'slot' && pt.via && pt.via !== pt.from && front[pt.via] &&
        chambers[pt.via] && chambers[pt.from] && Math.abs(chambers[pt.via].i - chambers[pt.from].i) === 1 ? pt.via : null;
      if (via) {
        const away = chambers[via].i < chambers[pt.from].i ? -1 : 1;
        for (let k = 0; k < pt.count; k++) front[via].slots.push({ type: 'port', pt, k, size: sz, into: pt.from, via, viaSide: sideName(unit(sa, away)) });
        continue;
      }
      for (let k = 0; k < pt.count; k++) (pt.shape === 'slot' ? f.slots : f.items).push({ type: 'port', pt, k, size: sz, into: pt.from });
    }
    for (const pr of design.prs) {
      if (!front[pr.from]) continue;
      const r = Math.sqrt(pr.sd / Math.PI) * 1.15;
      for (let k = 0; k < pr.count; k++) front[pr.from].items.push({ type: 'pr', pr, size: 2 * r, into: pr.from });
    }

    // where an item on a face sits, and which way is "into" a chamber
    // the face of f that looks into chamber id (front baffle: its outer face)
    const faceIn = (f, id) => f.kind === 'front' ? f.coord : (id === f.lowId ? f.lowFace : f.highFace);
    const other = (f, id) => f.kind === 'front' ? null : (id === f.lowId ? f.highId : f.lowId);
    const intoDir = (f, into) => f.kind === 'front' ? [0, 0, -1] : unit(f.plane, into === f.lowId ? -1 : 1);
    const point = (f, u, v, coord) => { const P = [0, 0, 0]; P[f.uv[0]] = u; P[f.uv[1]] = v; P[f.plane] = coord; return P; };

    const out = { faces: {}, dividers: Object.values(dividers), ports: [], drivers: [], prs: [], drv, zFace: zF };
    const slotJobs = [], roundJobs = [];
    // the divider on chamber id's side dir, if something is mounted on it (a slot
    // against it would cover the cone or run through the motor)
    const busyWall = (id, dir) => {
      if (wallNameFor(id)(dir) !== 'divider') return false;
      const i = chambers[id].i + signOf(dir);
      const nb = Object.keys(chambers).find(k => chambers[k].i === i);
      const d = nb && dividers[[id, nb].sort((a, b) => chambers[a].i - chambers[b].i).join('|')];
      return !!(d && d.items.length);
    };
    // no side picked: the usual wall, else the first one that is free
    const autoSide = (f, into) => {
      const order = [defaultSide(f.plane)].concat(sidesFor(f.plane));
      return order.find(k => !busyWall(into, SIDES[k])) || order[0];
    };
    for (const f of faces) {
      if (f.kind === 'front') out.faces[f.id] = f;
      const rect = { lo: f.rect.lo.slice(), hi: f.rect.hi.slice() };
      // slots first: each against its wall, shrinking the free area
      for (const s of f.slots) {
        const pt = s.pt;
        let side = s.viaSide || (pt.wallSide && sidesFor(f.plane).includes(pt.wallSide) ? pt.wallSide : over[pt.id] || autoSide(f, s.into));
        const n = SIDES[side];
        const iN = axisOf(n), j = f.uv.indexOf(iN), jm = 1 - j;
        const wallEdge = signOf(n) > 0 ? rect.hi[j] : rect.lo[j];
        const full = rect.hi[jm] - rect.lo[jm];
        const span = pt.fullHeight ? full : Math.min(pt.h, full);
        const e0 = rect.lo[jm], e1 = e0 + span;
        const onWall = pt.alongWall !== false;
        const used = (onWall ? 0 : t) + pt.w + t + Math.max(0, pt.slotOut || 0);
        if (signOf(n) > 0) rect.hi[j] -= used; else rect.lo[j] += used;
        slotJobs.push({ f, s, side, n, wallEdge, e0, e1, fullSpan: full });
      }
      // a through-chamber slot crosses this divider along the back: keep that strip clear
      if (f.kind === 'divider') {
        const zi = f.uv.indexOf(2);
        for (const pt of design.ports) {
          if (!(pt.via && pt.shape === 'slot' && pt.to === 'out')) continue;
          const pair = [pt.via, pt.from];
          if (!(pair.includes(f.lowId) && pair.includes(f.highId))) continue;
          if (zi >= 0) rect.lo[zi] += (pt.w + t + GAP) * 1;
        }
      }
      // everything round in a row along the longer free direction
      const items = f.items;
      // line array in one box: the drivers sit as a group at design.rowPitch centre to centre
      // (from the top), the rest (ports, PRs) share what's left below
      const drvItems = items.filter(it => it.type === 'drv');
      const pitched = design.rowPitch > 0 && f.kind === 'front' && drvItems.length > 1;
      const dSize = drvItems.length ? drvItems[0].size : 0;
      const pitch = pitched ? Math.max(design.rowPitch, dSize * 0.5) : 0;
      const groupLen = pitched ? (drvItems.length - 1) * pitch + dSize : 0;
      const total = pitched ? groupLen + items.filter(it => it.type !== 'drv').reduce((s, it) => s + it.size, 0)
        : items.reduce((s, it) => s + it.size, 0);
      const span0 = rect.hi[0] - rect.lo[0], span1 = rect.hi[1] - rect.lo[1];
      const row = span0 >= span1 ? 0 : 1;
      const along = row === 0 ? span0 : span1, across = row === 0 ? span1 : span0;
      if (total > along + 1e-6 || items.some(it => it.size > across + 1e-6) || along < 0 || across < 0) f.crowded = true;
      // spare room on this face (for callers that want a margin)
      f.slack = items.length ? Math.min(along - total, across - Math.max(...items.map(it => it.size))) : Math.min(along, across);
      // what the row needs, by box axis (0 = W, 1 = H, 2 = D), so the box can be grown to fit
      f.fit = { rowAxis: f.uv[row], acrossAxis: f.uv[1 - row], along, across, total, maxSize: items.length ? Math.max(...items.map(it => it.size)) : 0, n: items.length,
        hasDriver: items.some(it => it.type === 'drv') };
      const gap = Math.max(0, (along - total) / (items.length + 1));
      let cur = rect.lo[row] + gap;
      // pitched: the driver group from the top end, the others evenly in the rest
      const top = rect.hi[row] - Math.max(0.003, Math.min(pitch - dSize, along - total) || 0.003);
      const others = pitched ? items.filter(it => it.type !== 'drv') : [];
      const restLen = pitched ? Math.max(0, top - groupLen - rect.lo[row]) : 0;
      const restGap = pitched && others.length ? Math.max(0, (restLen - others.reduce((s, it) => s + it.size, 0)) / (others.length + 1)) : 0;
      let restCur = rect.lo[row] + restGap;
      for (const it of items) {
        let c;
        if (pitched && it.type === 'drv') c = top - dSize / 2 - drvItems.indexOf(it) * pitch;
        else if (pitched) { c = restCur + it.size / 2; restCur += it.size + restGap; }
        else { c = cur + it.size / 2; cur += it.size + gap; }
        const uv = row === 0 ? [c, (rect.lo[1] + rect.hi[1]) / 2] : [(rect.lo[0] + rect.hi[0]) / 2, c];
        // a driver can be moved off centre on the front baffle (to spread out edge diffraction)
        if (it.type === 'drv' && f.kind === 'front' && design.offset) {
          const half = it.size / 2;
          uv[0] = Math.max(f.rect.lo[0] + half, Math.min(f.rect.hi[0] - half, uv[0] + (design.offset.x || 0)));
          uv[1] = Math.max(f.rect.lo[1] + half, Math.min(f.rect.hi[1] - half, uv[1] + (design.offset.y || 0)));
        }
        it.u = uv[0]; it.v = uv[1];
        if (f.kind === 'front') { it.x = uv[0]; it.y = uv[1]; }
        const sp = chambers[it.into].sp;
        if (it.type === 'drv') {
          // flange on the cone side, motor into `into`
          const B = point(f, uv[0], uv[1], faceIn(f, it.cone));
          const a = intoDir(f, it.into);
          sp.obs.push(frustum(B, a, drv.r, drv.depth, drv.taper));
          // on a divider the cone fires into the other chamber: keep a clear zone in front of it
          // (cone travel plus room for the air), or a slot panel could end up over the cone
          if (it.cone && chambers[it.cone]) chambers[it.cone].sp.obs.push(frustum(B, neg(a), drv.r, Math.max(0.03, 0.25 * drv.r), 0));
          out.drivers.push({ pos: B, dir: neg(a), r: drv.r, front: f.kind === 'front', into: it.into, iso, one });
        } else if (it.type === 'pr') {
          const B = point(f, uv[0], uv[1], zF);
          sp.obs.push(frustum(B, [0, 0, -1], it.size / 2, it.size * 0.2));
          out.prs.push({ pos: B, dir: [0, 0, 1], r: it.size / 2, front: true });
        } else {
          roundJobs.push({ f, it });
        }
      }
    }
    // each round port's first leg runs straight in at least this far
    for (const j of roundJobs) {
      const { f, it } = j;
      const sp = chambers[it.into].sp;
      const P0 = point(f, it.u, it.v, faceIn(f, other(f, it.into)));
      const back = intoDir(f, it.into);
      const Ro = it.pt.d / 2 + (it.pt.wall || 0);
      const run = Math.min(it.pt.len, sp.reach(P0, back) - Ro - GAP);
      j.P0 = P0; j.back = back;
      j.ph = tubeObstacle(samples([P0, add(P0, back, Math.max(0, run))]), Ro);
      sp.obs.push(j.ph);
    }
    // slots (they hug a wall and can't move), then round ports
    for (const j of slotJobs) {
      const { f, s, n, wallEdge, e0, e1 } = j;
      let sp = chambers[s.into].sp, cMin = null, wallName = wallNameFor(s.into);
      if (s.via) {
        // one space spanning both chambers and the divider between them
        const A = chambers[s.via], B = chambers[s.into];
        sp = space(A.lo.map((v, i) => Math.min(v, B.lo[i])), A.hi.map((v, i) => Math.max(v, B.hi[i])));
        sp.obs.push(...A.sp.obs, ...B.sp.obs);
        // distance from the via chamber's outer wall to just inside the target chamber
        cMin = (A.hi[sa] - A.lo[sa]) + t + s.pt.w;
        const wA = wallNameFor(s.via), wB = wallNameFor(s.into);
        wallName = (d) => axisOf(d) === sa ? (signOf(d) === signOf(n) ? wA(d) : wB(d)) : wA(d);
      }
      const face = f.kind === 'front' ? zF : faceIn(f, other(f, s.into));
      const r = routeSlot(sp, { pt: s.pt, b: intoDir(f, s.into), n, face, wallEdge, e0, e1, t, tb: f.tb, allowBends: s.pt.bends !== 'none', wallName, cMin });
      if (s.via) {
        r.via = s.via;
        // share of the duct inside the via chamber: the run along its wall plus the way across it
        const across = chambers[s.via].hi[sa] - chambers[s.via].lo[sa] - r.w / 2;
        r.viaShare = Math.min(1, (r.leg1 + Math.max(0, across)) / Math.max(1e-6, s.pt.len));
        if (r.segs[1]) r.segs[1].along += ' (through a notch in the divider)';
        for (const bx of r.blocks) chambers[s.via].sp.obs.push(boxObstacle(bx[0], bx[1]));
      }
      r.fullSpan = j.fullSpan;
      r.side = j.side;
      r.front = f.kind === 'front';
      s.route = r;
      for (const bx of r.blocks) sp.obs.push(boxObstacle(bx[0], bx[1]));
      out.ports.push({ pt: s.pt, k: s.k, chamber: s.into, route: r });
    }
    for (const j of roundJobs) {
      const { it } = j;
      const sp = chambers[it.into].sp;
      sp.obs.splice(sp.obs.indexOf(j.ph), 1);
      const r = routeRound(sp, j.P0, j.back, it.pt, it.pt.bends !== 'none');
      r.front = j.f.kind === 'front';
      it.route = r;
      sp.obs.push(tubeObstacle(samples(r.pts), r.R));
      out.ports.push({ pt: it.pt, k: it.k, chamber: it.into, route: r });
    }
    out.braces = [];
    out.braceIssues = [];
    for (const ch of design.chambers) placeBraces(out, ch, chambers[ch.id], { t, zF, zFi, zBi, drv });
    return out;
  }

  function rodClashes(sd, out, id, drivers, drv) {
    const pts = samples([sd.a, sd.b]);
    for (const p of out.ports) {
      if (p.chamber !== id) continue;
      const r = p.route;
      if (r.kind === 'round') {
        const ob = tubeObstacle(samples(r.pts), r.R);
        if (pts.some(P => ob.hits(P, sd.r))) return true;
      } else if (r.blocks.some(([mn, mx]) => pts.some(P => boxObstacle(mn, mx).hits(P, sd.r)))) return true;
    }
    for (const d of drivers) {
      const ob = frustum(d.pos, neg(d.dir), drv.r, drv.depth, drv.taper);
      if (pts.some(P => ob.hits(P, sd.r))) return true;
    }
    return false;
  }

  // Braces sit behind the driver's motor when there's room, evenly spaced.
  function placeBraces(out, ch, c, o) {
    const b = ch.braces;
    if (!b || b.kind === 'none' || !(b.count > 0) || !c) return;
    const { t, zF, zFi, zBi, drv } = o;
    const { lo, hi } = c;
    const drivers = out.drivers.filter(d => d.into === ch.id);
    let zone = zFi;
    const behind = zF - drv.depth - 0.0127;
    if (drivers.some(d => d.front) && behind - zBi > (b.count + 1) * t * 2) zone = Math.min(zFi, behind);
    const solids = [];
    for (let k = 1; k <= b.count; k++) {
      const z = zone - k * (zone - zBi) / (b.count + 1);
      if (b.kind === 'window') {
        const r = b.rim, z0 = z - t / 2, z1 = z + t / 2;
        solids.push({ type: 'box', min: [lo[0], hi[1] - r, z0], max: [hi[0], hi[1], z1] },
          { type: 'box', min: [lo[0], lo[1], z0], max: [hi[0], lo[1] + r, z1] },
          { type: 'box', min: [lo[0], lo[1] + r, z0], max: [lo[0] + r, hi[1] - r, z1] },
          { type: 'box', min: [hi[0] - r, lo[1] + r, z0], max: [hi[0], hi[1] - r, z1] });
        // the driver must pass through the opening
        for (const d of drivers) {
          if (!d.front) continue;
          const s = zF - z;
          if (s > drv.depth + t) continue;
          const rr = drv.r * (1 - 0.5 * Math.max(0, Math.min(1, s / drv.depth)));
          const [x, y] = d.pos;
          if (x - rr < lo[0] + r || x + rr > hi[0] - r || y - rr < lo[1] + r || y + rr > hi[1] - r) {
            out.braceIssues.push({ chamber: ch.id, kind: 'driver', depth: s });
          }
        }
      } else {
        // dowels: first clear spot among a few heights (or across positions)
        const R = b.dia / 2;
        const rod = (f) => b.axis === 'H'
          ? { type: 'rod', a: [lo[0] + (hi[0] - lo[0]) * f, lo[1], z], b: [lo[0] + (hi[0] - lo[0]) * f, hi[1], z], r: R }
          : { type: 'rod', a: [lo[0], lo[1] + (hi[1] - lo[1]) * f, z], b: [hi[0], lo[1] + (hi[1] - lo[1]) * f, z], r: R };
        const cands = [0.5, 0.75, 0.25, 0.85, 0.15, 0.65, 0.35].map(rod);
        solids.push(cands.find(sd => !rodClashes(sd, out, ch.id, drivers, drv)) || cands[0]);
      }
    }
    // does anything run through a brace?
    const hit = (P, Rp) => solids.some(sd => {
      if (sd.type === 'box') return boxObstacle(sd.min, sd.max).hits(P, Rp - GAP);
      const ax = [sd.b[0] - sd.a[0], sd.b[1] - sd.a[1], sd.b[2] - sd.a[2]];
      const L = Math.hypot(...ax), u = ax.map(v => v / L);
      const v = [P[0] - sd.a[0], P[1] - sd.a[1], P[2] - sd.a[2]];
      const s = Math.max(0, Math.min(L, dot(v, u)));
      return Math.hypot(v[0] - u[0] * s, v[1] - u[1] * s, v[2] - u[2] * s) < sd.r + Rp;
    });
    const seen = new Set();
    for (const p of out.ports) {
      if (p.chamber !== ch.id || seen.has(p.pt)) continue;
      const r = p.route;
      let clash = false;
      if (r.kind === 'round') clash = samples(r.pts).some(P => hit(P, r.R));
      else {
        for (const [mn, mx] of r.blocks) {
          for (let i = 0; i <= 6 && !clash; i++) for (let j = 0; j <= 6 && !clash; j++) for (let k = 0; k <= 6 && !clash; k++) {
            clash = hit([mn[0] + (mx[0] - mn[0]) * i / 6, mn[1] + (mx[1] - mn[1]) * j / 6, mn[2] + (mx[2] - mn[2]) * k / 6], 0.001);
          }
        }
      }
      if (clash) { seen.add(p.pt); out.braceIssues.push({ chamber: ch.id, kind: 'port', port: p.pt.name }); }
    }
    // drivers on a divider (and dowels against any driver): sample the brace
    for (const d of drivers) {
      if (b.kind === 'window' && d.front) continue;        // checked through the opening above
      const ob = frustum(d.pos, neg(d.dir), drv.r, drv.depth, drv.taper);
      const touches = solids.some(x => {
        if (x.type === 'rod') return samples([x.a, x.b]).some(P => ob.hits(P, x.r));
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) for (let k = 0; k <= 1; k++) {
          const P = [x.min[0] + (x.max[0] - x.min[0]) * i / 8, x.min[1] + (x.max[1] - x.min[1]) * j / 8, x.min[2] + (x.max[2] - x.min[2]) * k];
          if (ob.hits(P, 0)) return true;
        }
        return false;
      });
      if (touches) { out.braceIssues.push({ chamber: ch.id, kind: 'driver' }); break; }
    }
    out.braces.push({ chamber: ch.id, kind: b.kind, solids, zone });
  }

  // Plain-language description of a route, for the port card and build tab.
  function describe(route, fmt) {
    if (!route) return '';
    if (route.kind === 'round') {
      return route.legs.map((l, i) => i === 0
        ? fmt(l.len) + ' straight ' + (same(l.dir, [0, 0, -1]) ? 'back' : 'in')
        : 'turn 90°, ' + fmt(l.len) + ' toward the ' + sideName(l.dir)).join(', ');
    }
    return route.segs.map((sg, i) => i === 0
      ? fmt(sg.len) + (route.segs.length > 1 ? ' along the ' : ' straight along the ') + sg.along
      : 'fold, ' + fmt(sg.len) + ' along the ' + sg.along + ' toward the ' + sg.toward).join(', ') +
      (route.segs.length > 1 ? (route.rounded ? ' (centre line to each corner; inside corners rounded ' + fmt(route.foldR) + (route.fill ? ', outer corners filled ' + fmt(route.foldR + route.w) : '') + ')' : ' (centre line)') : '');
  }

  GL.placement = { plan, driverGeom, describe, sidesFor, defaultSide, SIDES };
})(window.GL);
