/* GetLow – box geometry: true internal volume (walls, dividers, double
 * baffles, driver / port / brace displacement), dimension solving that holds
 * chamber volumes, and the cut list. */
(function (GL) {
  'use strict';
  const IN = GL.units.IN;
  const E = () => GL.enclosures;

  // sub = what it's made of (stiffness, density and damping in GL.panels.SUBSTANCES)
  const MATERIALS = [
    { id: 'ply12',  name: '½" plywood (0.50")', t: 0.5 * IN, sub: 'ply' },
    { id: 'ply1532', name: '½" plywood, real size (15/32")', t: 0.46875 * IN, sub: 'ply' },
    { id: 'ply34',  name: '¾" plywood (0.75")', t: 0.75 * IN, sub: 'ply' },
    { id: 'mdf58',  name: '⅝" MDF', t: 0.625 * IN, sub: 'mdf' },
    { id: 'mdf34',  name: '¾" MDF', t: 0.75 * IN, sub: 'mdf' },
    { id: 'bb12',   name: '12 mm Baltic birch', t: 0.012, sub: 'birch' },
    { id: 'bb18',   name: '18 mm Baltic birch', t: 0.018, sub: 'birch' },
    { id: 'bb6',    name: '6 mm Baltic birch', t: 0.006, sub: 'birch' },
    { id: 'alu2',   name: '2 mm aluminium', t: 0.002, sub: 'alu' },
    { id: 'alu3',   name: '3 mm aluminium', t: 0.003, sub: 'alu' },
    { id: 'alu5',   name: '5 mm aluminium', t: 0.005, sub: 'alu' },
    { id: 'steel15', name: '1.5 mm steel', t: 0.0015, sub: 'steel' },
    { id: 'acr6',   name: '6 mm acrylic', t: 0.006, sub: 'acrylic' },
    { id: 'pla3',   name: '3 mm 3D print, PLA', t: 0.003, sub: 'pla' },
    { id: 'pla5',   name: '5 mm 3D print, PLA', t: 0.005, sub: 'pla' },
    { id: 'petg3',  name: '3 mm 3D print, PETG', t: 0.003, sub: 'petg' },
    { id: 'abs3',   name: '3 mm 3D print, ABS / ASA', t: 0.003, sub: 'abs' },
    { id: 'resin3', name: '3 mm resin print (SLA)', t: 0.003, sub: 'resin' },
    { id: 'custom', name: 'Custom thickness', t: null },
  ];

  const KEYS = ['W', 'H', 'D'];

  function defaultBox() {
    return {
      material: 'ply12', t: 0.5 * IN, layers: 1, split: 'W', sub: 'ply',
      joint: 'butt',                              // butt, rabbet (half the thickness) or mitre
      terminal: { on: true, shape: 'square', size: 2.5 * IN },   // terminal cup on the back
      print: { skin: 0.0012, infill: 0.25 },    // 3D prints: solid perimeters on each face, infill fraction
      ext: { W: 16 * IN, H: 14 * IN, D: 14 * IN },
      lock: { W: false, H: false, D: false },
      hold: true,
    };
  }

  // Panels that eat into each internal dimension.
  function walls(box, axis, n) {
    const base = axis === 'D' ? 1 + box.layers : 2;
    return base + (axis === box.split ? Math.max(0, n - 1) : 0);
  }
  const internal = (box, axis, n) => box.ext[axis] - box.t * walls(box, axis, n);

  // Volume each chamber loses to things inside it.
  // Brace kinds. Window brace: a panel parallel to the baffle with a big
  // opening, `rim` wide all round. Dowel: round rod wall to wall along `axis`.
  const BRACES = [['none', 'None'], ['window', 'Window braces'], ['dowel', 'Dowels']];
  const defaultBraces = () => ({ kind: 'none', count: 1, rim: 1.5 * IN, dia: 1 * IN, axis: 'W' });
  // Inside size of a chamber {x, y, z}: across, up, front-to-back.
  function chamberSize(box, n, len) {
    const s = { x: internal(box, 'W', n), y: internal(box, 'H', n), z: internal(box, 'D', n) };
    if (n > 1 && len != null) s[box.split === 'W' ? 'x' : 'y'] = len;
    return s;
  }
  function braceVolume(b, size, t) {
    if (!b || b.kind === 'none' || !(b.count > 0)) return 0;
    if (b.kind === 'window') {
      const ox = Math.max(0, size.x - 2 * b.rim), oy = Math.max(0, size.y - 2 * b.rim);
      return (size.x * size.y - ox * oy) * t * b.count;
    }
    const L = b.axis === 'H' ? size.y : b.axis === 'D' ? size.z : size.x;
    return Math.PI * b.dia * b.dia / 4 * L * b.count;
  }

  function displacements(design, box) {
    const out = {};
    for (const ch of design.chambers) out[ch.id] = { driver: 0, ports: 0, prs: 0, bracing: ch.bracing || 0, braces: 0 };
    const where = (id) => out[id] ? id : null;
    const dch = where(design.mount.rear) || where(design.mount.front);
    // isobaric pairs: clamshell has one motor inside; tunnel has the rear
    // driver plus the sealed sleeve between the two
    const iso = design.iso && design.iso.on ? design.iso : null;
    const per = (design.driverDisp || 0) + (iso && iso.mode === 'tunnel' ? (iso.sleeve || 0) : 0);
    // manifold: half the drivers on each side
    const r2 = design.mount.rear2 && out[design.mount.rear2] ? design.mount.rear2 : null;
    // a reversed driver leaves only its cone's dish on the rear side; its motor goes to the
    // cone side (another chamber, or outside the box through the baffle)
    const fr = where(design.mount.front) && design.mount.front !== dch ? design.mount.front : null;
    const n = design.count, half = r2 ? Math.ceil(n / 2) : n;
    for (let k = 0; k < n; k++) {
      const back = r2 && k >= half ? r2 : dch;
      if (!back) continue;
      if (E().flipped(design, k)) {
        out[back].driver += per * E().CONE_CAVITY;
        if (fr) out[fr].driver += per;
      } else out[back].driver += per;
    }
    for (const p of design.ports) {
      const c = where(p.from) || where(p.to);
      if (!c) continue;
      const v = E().portDisplacement(p, box.t);          // air channel + tube wall or slot panels
      // a slot that runs through the neighbouring chamber takes room in both
      const via = p.via && p.shape === 'slot' && p.to === 'out' && where(p.via) && p.via !== c ? p.via : null;
      const share = via ? Math.min(1, Math.max(0, p.viaShare != null ? p.viaShare : 0.6)) : 0;
      out[c].ports += v * (1 - share);
      if (via) out[via].ports += v * share;
    }
    for (const r of design.prs) if (out[r.from]) out[r.from].prs += (r.disp || 0) * r.count;
    // braces depend on the chamber's size, which depends on its gross volume
    if (box.ext && design.chambers.some(c => c.braces && c.braces.kind !== 'none')) {
      const n = design.chambers.length;
      const I = { W: internal(box, 'W', n), H: internal(box, 'H', n), D: internal(box, 'D', n) };
      const cross = KEYS.filter(k => k !== box.split).reduce((s, k) => s * I[k], 1);
      for (let it = 0; it < 4; it++) {
        for (const ch of design.chambers) {
          const d = out[ch.id];
          const len = (ch.vol + d.driver + d.ports + d.prs + (ch.bracing || 0) + d.braces) / cross;
          d.braces = braceVolume(ch.braces, chamberSize(box, n, len), box.t);
        }
      }
      for (const ch of design.chambers) out[ch.id].bracing = (ch.bracing || 0) + out[ch.id].braces;
    }
    return out;
  }

  // Full layout for a box-type design (not transmission lines).
  function layout(design, box) {
    const n = design.chambers.length;
    const disp = displacements(design, box);
    const chambers = design.chambers.map(ch => {
      const d = disp[ch.id];
      const gross = ch.vol + d.driver + d.ports + d.prs + d.bracing;
      return { id: ch.id, name: ch.name, net: ch.vol, disp: d, gross };
    });
    const gross = chambers.reduce((s, c) => s + c.gross, 0);
    const int = {};
    for (const k of KEYS) int[k] = internal(box, k, n);
    const cross = KEYS.filter(k => k !== box.split).reduce((s, k) => s * int[k], 1);
    // internal length along the split axis: what the volume needs, or longer
    // where something must fit (box.minLen, e.g. a driver's motor)
    for (const c of chambers) {
      const byVol = c.gross / cross, min = (box.minLen && box.minLen[c.id]) || 0;
      c.len = Math.max(byVol, min);
      c.spare = (c.len - byVol) * cross;
    }
    // the inside volume the chambers need (more than gross when some are held longer)
    const need = chambers.reduce((s, c) => s + c.len, 0) * cross;
    // a box held bigger than that (every dimension pinned): the chambers fill it
    const sum = need / cross;
    if (int[box.split] > sum + 1e-9 && sum > 0) {
      const k = int[box.split] / sum;
      for (const c of chambers) { c.spare += c.len * (k - 1) * cross; c.len *= k; }
    }
    const spare = chambers.reduce((s, c) => s + c.spare, 0);
    let pos = box.t;
    for (const c of chambers) {
      c.start = pos;                  // offset from outside face
      pos += c.len + box.t;
    }
    const extVol = box.ext.W * box.ext.H * box.ext.D;
    const intVol = int.W * int.H * int.D;
    return {
      n, chambers, gross, need, int, cross, extVol, intVol, spare,
      // what fits in the current dims minus what is needed
      mismatch: intVol - need,
      panels: panels(design, box, n, chambers),
    };
  }

  // Keep `edited` (if given) and locked dimensions; resize the rest so the
  // internal volume equals `gross`. Free dimensions keep their mutual ratio.
  // mins: smallest internal size per axis (e.g. so the drivers fit their baffle);
  // a free dimension that would come out smaller is held there and the others
  // take up the rest of the volume.
  function solveDims(box, gross, n, edited, mins) {
    let fixed = KEYS.filter(k => box.lock[k] || k === edited);
    let note = '';
    if (fixed.length === 3) {
      const give = edited !== box.split ? box.split : KEYS.find(k => k !== edited);
      fixed = fixed.filter(k => k !== give);
      note = 'All dimensions were locked, so ' + give + ' was adjusted to hold the volume.';
    }
    const free = KEYS.filter(k => !fixed.includes(k));
    const write = free.slice();          // the dimensions this call may change
    const I = {};
    for (const k of KEYS) I[k] = internal(box, k, n);
    const prodFixed = fixed.reduce((s, k) => s * I[k], 1);
    if (fixed.some(k => I[k] <= 0)) return { ok: false, note: 'A fixed dimension is smaller than its walls.' };
    const target = gross / prodFixed;
    if (free.length === 1) {
      I[free[0]] = target;
    } else if (free.length === 2) {
      const [a, b] = free;
      const r = I[a] > 0 && I[b] > 0 ? I[a] / I[b] : 1;
      I[b] = Math.sqrt(target / r);
      I[a] = r * I[b];
    } else {
      const cur = I.W * I.H * I.D;
      const s = cur > 0 ? Math.cbrt(gross / cur) : 1;
      if (cur > 0) for (const k of KEYS) I[k] *= s;
      else { const c = Math.cbrt(gross); for (const k of KEYS) I[k] = c; }
    }
    if (mins) {
      // pin any free dimension below its minimum, re-share the volume among the rest
      for (let it = 0; it < 3; it++) {
        const low = free.filter(k => mins[k] > 0 && I[k] < mins[k] - 1e-9);
        if (!low.length) break;
        for (const k of low) { I[k] = mins[k]; free.splice(free.indexOf(k), 1); fixed.push(k); }
        if (!free.length) { note = note || 'The box is as small as the drivers allow; it has a little more room than the volumes need.'; break; }
        const pf = fixed.reduce((s, k) => s * I[k], 1), tg = gross / pf;
        if (free.length === 1) I[free[0]] = tg;
        else { const [a, b] = free, r = I[a] > 0 && I[b] > 0 ? I[a] / I[b] : 1; I[b] = Math.sqrt(tg / r); I[a] = r * I[b]; }
      }
      for (const k of fixed) if (mins[k] > 0 && I[k] < mins[k] - 1e-4) note = note || 'A locked dimension is too small for the drivers to fit.';
    }
    for (const k of write) box.ext[k] = I[k] + box.t * walls(box, k, n);
    return { ok: true, note, changed: write };
  }

  // Set internal proportions (W:H:D) explicitly, holding the volume.
  function applyRatio(box, gross, n, ratio) {
    const s = Math.cbrt(gross / (ratio.W * ratio.H * ratio.D));
    for (const k of KEYS) box.ext[k] = ratio[k] * s + box.t * walls(box, k, n);
  }

  // Panel list. Butt joints: top & bottom run full width and depth, sides fit
  // between them, front baffle(s) and back fit inside all four. Rabbets (half
  // the thickness deep) add half a thickness wherever a panel sits in one;
  // mitres make every outer panel its full outside size. The inside is the same
  // whichever joint, so volumes don't change. Extra baffle layers sit inside.
  function panels(design, box, n, chambers) {
    const { W, H, D } = box.ext, t = box.t;
    const intD = D - t * (1 + box.layers);
    const j = box.joint || 'butt', e = j === 'rabbet' ? t / 2 : j === 'mitre' ? t : 0;
    const list = [
      { name: 'Top / bottom', qty: 2, a: W, b: D },
      { name: 'Sides', qty: 2, a: H - 2 * t + 2 * e, b: D },
      { name: 'Back', qty: 1, a: W - 2 * t + 2 * e, b: H - 2 * t + 2 * e },
    ];
    if (box.layers > 1 && e > 0) {
      list.push({ name: 'Front baffle (outer layer)', qty: 1, a: W - 2 * t + 2 * e, b: H - 2 * t + 2 * e });
      list.push({ name: 'Front baffle (inner layers)', qty: box.layers - 1, a: W - 2 * t, b: H - 2 * t });
    } else {
      list.push({ name: box.layers > 1 ? 'Front baffle (layered)' : 'Front baffle', qty: box.layers, a: W - 2 * t + 2 * e, b: H - 2 * t + 2 * e });
    }
    if (n > 1) {
      list.push(box.split === 'W'
        ? { name: 'Divider', qty: n - 1, a: H - 2 * t, b: intD }
        : { name: 'Divider', qty: n - 1, a: W - 2 * t, b: intD });
    }
    for (const p of design.ports) {
      if (p.shape === 'slot') list.push({ name: p.name + ' slot wall', qty: p.count * (p.alongWall !== false ? 1 : 2), a: p.len, b: p.h });
    }
    for (const ch of design.chambers) {
      const b = ch.braces, c = chambers && chambers.find(x => x.id === ch.id);
      if (!b || b.kind === 'none' || !c || !(b.count > 0)) continue;
      const size = chamberSize(box, n, c.len);
      const where = n > 1 ? ' (' + ch.name.toLowerCase() + ')' : '';
      if (b.kind === 'window') {
        list.push({ name: 'Window brace' + where, qty: b.count, a: size.x, b: size.y,
          opening: [Math.max(0, size.x - 2 * b.rim), Math.max(0, size.y - 2 * b.rim)] });
      } else {
        const L = b.axis === 'H' ? size.y : b.axis === 'D' ? size.z : size.x;
        list.push({ name: 'Dowel' + where, qty: b.count, a: L, b: b.dia, dowel: true });
      }
    }
    const area = list.filter(p => !p.dowel).reduce((s, p) => s + p.qty * p.a * p.b, 0);
    return { list, area, wood: area * t };
  }

  // Inside height available to a full-height slot in a chamber.
  function slotFullHeight(design, box, chamberId) {
    const n = design.chambers.length;
    if (box.split === 'H' && n > 1) {
      const c = layout(design, box).chambers.find(x => x.id === chamberId);
      if (c) return c.len;
    }
    return internal(box, 'H', n);
  }

  // Horn: path length, air volume, chamber volumes and a build table of the
  // cross-section along the path (fold the path however you like).
  function hornLayout(design, stations) {
    const H = design.horn;
    const disp = displacements(design, { t: 0 });
    const chambers = design.chambers.map(c => {
      const d = disp[c.id];
      return { id: c.id, name: c.name, net: c.vol, gross: c.vol + d.driver + d.bracing };
    });
    const L = E().hornLength(H), air = E().hornVolume(H);
    const prof = E().hornProfile(H, 48);
    const n = stations || 20;
    const table = [];
    for (let i = 0; i <= n; i++) {
      const x = L * i / n;
      let j = 1;
      while (j < prof.length - 1 && prof[j].x < x) j++;
      const a = prof[j - 1], b = prof[j];
      const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
      const S = a.S + (b.S - a.S) * t;
      table.push({ x, S, h: S / H.width, d: 2 * Math.sqrt(S / Math.PI) });
    }
    return { length: L, air, s1: H.s1, mouth: E().hornMouth(H), chambers, table, profile: prof,
      total: air + chambers.reduce((s, c) => s + c.gross, 0) };
  }

  // Transmission line / pipe: air volume and end dimensions.
  function lineLayout(design) {
    const L = design.line;
    const { s0, sL } = E().lineAreas(L);
    const air = L.length * (s0 + sL) / 2;
    const rear = design.chambers[0];
    let rearGross = 0;
    if (rear) {
      const d = displacements(design, { t: 0 })[rear.id];
      rearGross = rear.vol + d.driver + d.bracing;
    }
    return { s0, sL, air, rearGross, quarter: E().quarterWave(L, 4) };
  }

  // Folded transmission line: the line's legs side by side in a box, front to back,
  // leg 1 behind the front baffle (the driver is on it). Lengths are measured along
  // the centre of the path: each leg to the middle of its turn, plus the step across.
  //   fold: { n, legs: 'vertical'|'horizontal', start: 'top'|'bottom', dividers: 'angled'|'parallel',
  //           gap (turn gap / line height), mouth: 'back'|'end', deflect, t (wall and divider thickness) }
  const FOLD_DEFAULT = { n: 0, legs: 'vertical', start: 'top', dividers: 'angled', gap: 1, mouth: 'back', deflect: true, t: 0.75 * IN };
  function lineFold(design) {
    const L = design.line;
    const f = Object.assign({}, FOLD_DEFAULT, L.fold || {});
    const n = Math.max(0, Math.round(f.n)), legs = n + 1, t = f.t, w = L.width;
    const hAt = (u) => L.h0 + (L.hL - L.h0) * Math.min(1, Math.max(0, u));
    // each leg's height at its start and end (along the path)
    const leg = [];
    for (let k = 0; k < legs; k++) {
      const u0 = k / legs, u1 = (k + 1) / legs;
      const par = f.dividers === 'parallel' ? hAt((u0 + u1) / 2) : null;
      leg.push({ k, h0: par ?? hAt(u0), h1: par ?? hAt(u1), fromA: k % 2 === 0 });
    }
    // height of each leg at end A (where the line starts) and end B
    for (const g of leg) { g.hA = g.fromA ? g.h0 : g.h1; g.hB = g.fromA ? g.h1 : g.h0; g.avg = (g.h0 + g.h1) / 2; }
    const sumA = leg.reduce((s, g) => s + g.hA, 0), sumB = leg.reduce((s, g) => s + g.hB, 0);
    const Din = Math.max(sumA, sumB) + n * t;
    // the back leg takes up any difference so the back wall is square
    const last = leg[legs - 1];
    last.hA += Din - n * t - sumA; last.hB += Din - n * t - sumB;
    const turns = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 1) / legs;
      const at = leg[i].fromA ? 'B' : 'A';
      const hT = at === 'B' ? leg[i].hB : leg[i].hA;
      turns.push({ i, at, gap: f.gap * hT, pitch: (leg[i].avg + leg[i + 1].avg) / 2 + t, u });
    }
    const mouthEnd = last.fromA ? 'B' : 'A';
    // an MLTL ends in its port: the opening is the port's size along the leg
    const pt = design.type === 'mltl' && L.port;
    const mouthH = pt ? (pt.shape === 'slot' ? pt.h : pt.d) : L.hL;
    // an MLTL port set up from the end is on the back panel, over the last leg, and the line runs to the end wall
    const tapped = pt && (pt.at || 0) > 0;
    const mouthBack = f.mouth === 'back' && n > 0 && !tapped;
    const sumGap = turns.reduce((s, x) => s + x.gap, 0), sumPitch = turns.reduce((s, x) => s + x.pitch, 0);
    // path = (n+1)·Lin − Σgap + Σpitch (− half the mouth opening when it is in the back panel)
    const Lin = (L.length + sumGap - sumPitch + (mouthBack ? mouthH / 2 : 0)) / legs;
    // leg path lengths
    for (const g of leg) {
      let len = Lin;
      for (const x of turns) if (x.i === g.k || x.i === g.k - 1) len -= x.gap / 2;
      if (mouthBack && g === last) len -= mouthH / 2;
      g.len = len;
    }
    // dividers: between leg i and i+1, fixed to the wall at the far end from their turn
    let zA = 0, zB = 0;
    const dividers = turns.map(x => {
      zA += leg[x.i].hA; zB += leg[x.i].hB;
      const d = { i: x.i, len: Lin - x.gap, from: x.at === 'B' ? 'A' : 'B', zA, zB };
      zA += t; zB += t;
      return d;
    });
    const lean = dividers.map(d => Math.atan2(d.zB - d.zA, Lin) * 180 / Math.PI);
    // 45° corner blocks in the two outer corners of each turn
    const defl = f.deflect ? turns.map(x => {
      const s = 0.5 * Math.min(x.gap, leg[x.i].avg, leg[x.i + 1].avg);
      return { at: x.at, i: x.i, s };
    }) : [];
    const deflVol = defl.reduce((s, d) => s + 2 * w * d.s * d.s / 2, 0);
    const divVol = dividers.reduce((s, d) => s + d.len * w * t, 0);
    const air = Lin * w * Din - divVol - deflVol;
    const inside = f.legs === 'vertical' ? { W: w, H: Lin, D: Din } : { W: Lin, H: w, D: Din };
    const ext = { W: inside.W + 2 * t, H: inside.H + 2 * t, D: inside.D + 2 * t };
    const drvAlong = L.drvPos * L.length;
    const warn = [];
    if (Lin < 2 * Math.max(...leg.map(g => Math.max(g.hA, g.hB)), 0) || leg.some(g => g.len <= 0)) warn.push('Too many folds for this length: the legs are shorter than the line is wide.');
    if (n > 0 && drvAlong > leg[0].len) warn.push('The driver sits past the first turn; it has to be on the first leg, behind the front baffle. Move it nearer the closed end.');
    return { n, legs: leg, turns, dividers, lean, defl, Lin, Din, w, t, inside, ext, air, mouthEnd, mouthBack, mouthH, port: pt || null, portAt: tapped ? pt.at : 0,
      drvAlong, fold: f, warn, path: leg.reduce((s, g) => s + g.len, 0) + sumPitch };
  }

  GL.geometry = { MATERIALS, KEYS, BRACES, defaultBraces, braceVolume, chamberSize, defaultBox, walls, internal, displacements, layout, solveDims, applyRatio, slotFullHeight, lineLayout, hornLayout, lineFold, FOLD_DEFAULT };
})(window.GL);
