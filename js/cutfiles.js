/* GetLow – cutting files from the build sheet's panels: DXF (CNC routers,
   laser cutters, CAD), SVG (laser cutters, Inkscape) and STL (3D printers).
   All in millimetres. Panels come from GL.buildsheet.panels(): w × h with
   holes in the panel's own frame (u from the left, v up from the bottom). */
(function (GL) {
  'use strict';
  const MM = 1000;
  const EPS = 1e-6;

  // ---------------------------------------------------------------- 2D shapes
  // A panel as an outline (with any notches cut from its edges) and holes, in mm.
  function shape(p, opts = {}) {
    const W = p.w * MM, H = p.h * MM, seg = opts.seg || 72;
    const notches = [], holes = [];
    for (const hh of p.holes || []) {
      if (hh.shape === 'rect') {
        const r = { x0: hh.u * MM, y0: hh.v * MM, x1: (hh.u + hh.w) * MM, y1: (hh.v + hh.h) * MM, kind: hh.kind };
        const touches = r.x0 <= 0.01 || r.y0 <= 0.01 || r.x1 >= W - 0.01 || r.y1 >= H - 0.01;
        if (touches) notches.push(r); else holes.push({ type: 'rect', ...r });
      } else {
        holes.push({ type: 'circle', cx: hh.u * MM, cy: hh.v * MM, r: hh.d * MM / 2, kind: hh.kind, seg: hh.screw ? 16 : seg });
      }
    }
    return { W, H, outline: outlineWithNotches(W, H, notches), holes };
  }

  // Rectangle minus axis-aligned notches, traced as polygons (counter-clockwise).
  function outlineWithNotches(W, H, notches) {
    if (!notches.length) return [[[0, 0], [W, 0], [W, H], [0, H]]];
    const clip = (v, hi) => Math.max(0, Math.min(hi, v));
    const xs = [...new Set([0, W, ...notches.flatMap(n => [clip(n.x0, W), clip(n.x1, W)])].map(v => +v.toFixed(6)))].sort((a, b) => a - b);
    const ys = [...new Set([0, H, ...notches.flatMap(n => [clip(n.y0, H), clip(n.y1, H)])].map(v => +v.toFixed(6)))].sort((a, b) => a - b);
    const filled = (i, j) => {
      if (i < 0 || j < 0 || i >= xs.length - 1 || j >= ys.length - 1) return false;
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      return !notches.some(n => cx > n.x0 && cx < n.x1 && cy > n.y0 && cy < n.y1);
    };
    // boundary edges of the filled cells, counter-clockwise round each cell
    const next = new Map();
    const key = (x, y) => x + ',' + y;
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
      if (!filled(i, j)) continue;
      const a = [xs[i], ys[j]], b = [xs[i + 1], ys[j]], c = [xs[i + 1], ys[j + 1]], d = [xs[i], ys[j + 1]];
      if (!filled(i, j - 1)) next.set(key(...a), b);
      if (!filled(i + 1, j)) next.set(key(...b), c);
      if (!filled(i, j + 1)) next.set(key(...c), d);
      if (!filled(i - 1, j)) next.set(key(...d), a);
    }
    const loops = [];
    while (next.size) {
      const [k0] = next.keys();
      const start = k0.split(',').map(Number), loop = [start];
      let cur = k0;
      for (let guard = 0; guard < 10000; guard++) {
        const nx = next.get(cur);
        next.delete(cur);
        if (!nx) break;
        const k = key(...nx);
        if (k === k0) break;
        loop.push(nx);
        cur = k;
      }
      loops.push(simplify(loop));
    }
    return loops;
  }
  // drop points in the middle of straight runs
  function simplify(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if (Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > EPS) out.push(b);
    }
    return out;
  }
  const circlePts = (h, ccw) => {
    const pts = [];
    for (let k = 0; k < h.seg; k++) { const a = (ccw ? 1 : -1) * 2 * Math.PI * k / h.seg; pts.push([h.cx + h.r * Math.cos(a), h.cy + h.r * Math.sin(a)]); }
    return pts;
  };
  const rectPts = (h, ccw) => ccw ? [[h.x0, h.y0], [h.x1, h.y0], [h.x1, h.y1], [h.x0, h.y1]] : [[h.x0, h.y0], [h.x0, h.y1], [h.x1, h.y1], [h.x1, h.y0]];
  const area2 = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

  // ---------------------------------------------------------------- DXF (R12, mm)
  function dxfWriter() {
    const out = [];
    const put = (...pairs) => { for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), String(pairs[i + 1])); };
    const f = (v) => (+v).toFixed(3);
    return {
      line(layer, a, b) { put(0, 'LINE', 8, layer, 10, f(a[0]), 20, f(a[1]), 30, 0, 11, f(b[0]), 21, f(b[1]), 31, 0); },
      poly(layer, pts) { for (let i = 0; i < pts.length; i++) this.line(layer, pts[i], pts[(i + 1) % pts.length]); },
      circle(layer, c, r) { put(0, 'CIRCLE', 8, layer, 10, f(c[0]), 20, f(c[1]), 30, 0, 40, f(r)); },
      text(layer, at, h, s) { put(0, 'TEXT', 8, layer, 10, f(at[0]), 20, f(at[1]), 30, 0, 40, f(h), 1, String(s).replace(/[^\x20-\x7e]/g, '')); },
      done() {
        const layers = [['OUTLINE', 7], ['CUTOUT', 1], ['PILOT', 3], ['NOTE', 8], ['SHEET', 5]];
        const head = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
          '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.length),
          ...layers.flatMap(([n, c]) => ['0', 'LAYER', '2', n, '70', '0', '62', String(c), '6', 'CONTINUOUS']),
          '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
        return head.concat(out, ['0', 'ENDSEC', '0', 'EOF']).join('\r\n') + '\r\n';
      },
    };
  }
  // one panel into a writer, at (ox, oy), turned a quarter (counter-clockwise) when rot
  function drawPanel(wr, p, ox, oy, rot, label) {
    const sh = shape(p);
    const T = (x, y) => rot ? [ox + (sh.H - y), oy + x] : [ox + x, oy + y];
    for (const loop of sh.outline) wr.poly('OUTLINE', loop.map(q => T(q[0], q[1])));
    for (const h of sh.holes) {
      const layer = h.kind === 'screw' ? 'PILOT' : 'CUTOUT';
      if (h.type === 'circle') wr.circle(layer, T(h.cx, h.cy), h.r);
      else wr.poly(layer, rectPts(h, true).map(q => T(q[0], q[1])));
    }
    if (label && wr.text) {
      const tw = rot ? sh.H : sh.W, th = rot ? sh.W : sh.H, ht = Math.max(4, Math.min(12, Math.min(tw, th) * 0.06));
      wr.text('NOTE', [ox + ht * 0.6, oy + th - ht * 1.6], ht, label);
    }
    return { w: rot ? sh.H : sh.W, h: rot ? sh.W : sh.H };
  }
  const labelOf = (p) => (p.key ? p.key + ' ' : '') + p.name;

  // every panel side by side, each once (with its quantity in the label)
  function dxfPanels(parts) {
    const wr = dxfWriter(), gap = 20;
    let x = 0;
    for (const p of parts.filter(q => !q.stock)) {
      const d = drawPanel(wr, p, x, 0, false, labelOf(p) + (p.qty > 1 ? ' x' + p.qty : ''));
      x += d.w + gap;
    }
    return wr.done();
  }
  // each sheet as laid out by GL.buildsheet.nest, one under the other
  function dxfSheets(nestRes) {
    const wr = dxfWriter(), L = nestRes.L * MM, S = nestRes.S * MM;
    nestRes.sheets.forEach((sh, i) => {
      const oy = -i * (S + 100);
      wr.poly('SHEET', [[0, oy], [L, oy], [L, oy + S], [0, oy + S]]);
      wr.text('NOTE', [0, oy + S + 12], 10, 'Sheet ' + (i + 1) + ' of ' + nestRes.sheets.length);
      for (const pl of sh.placed) drawPanel(wr, pl.it.part, pl.x * MM, oy + pl.y * MM, pl.it.rot, labelOf(pl.it.part));
    });
    return wr.done();
  }

  // ---------------------------------------------------------------- SVG (mm)
  function svgWriter() {
    const els = [];
    const f = (v) => (+v).toFixed(2);
    let maxX = 0, maxY = 0, minY = 0;
    const seen = (x, y) => { maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); minY = Math.min(minY, y); };
    const STYLE = { OUTLINE: 'stroke="#000" stroke-width="0.3"', CUTOUT: 'stroke="#d00" stroke-width="0.3"', PILOT: 'stroke="#0a0" stroke-width="0.3"', SHEET: 'stroke="#00c" stroke-width="0.5"', NOTE: 'fill="#666"' };
    return {
      poly(layer, pts) { pts.forEach(q => seen(q[0], q[1])); els.push([layer, `<polygon points="${pts.map(q => f(q[0]) + ',' + f(-q[1])).join(' ')}" fill="none" ${STYLE[layer]}/>`]); },
      circle(layer, c, r) { seen(c[0] + r, c[1] + r); els.push([layer, `<circle cx="${f(c[0])}" cy="${f(-c[1])}" r="${f(r)}" fill="none" ${STYLE[layer]}/>`]); },
      text(layer, at, h, s) { els.push([layer, `<text x="${f(at[0])}" y="${f(-at[1])}" font-size="${f(h)}" font-family="sans-serif" ${STYLE.NOTE}>${String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`]); },
      done() {
        const pad = 10, x0 = -pad, y0 = -maxY - pad, w = maxX + 2 * pad, hgt = maxY - minY + 2 * pad;
        const groups = ['SHEET', 'OUTLINE', 'CUTOUT', 'PILOT', 'NOTE'].map(l => `<g id="${l.toLowerCase()}">${els.filter(e => e[0] === l).map(e => e[1]).join('')}</g>`).join('\n');
        return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}mm" height="${f(hgt)}mm" viewBox="${f(x0)} ${f(y0)} ${f(w)} ${f(hgt)}">\n${groups}\n</svg>\n`;
      },
    };
  }
  function svgPanels(parts) {
    const wr = svgWriter(), gap = 20;
    let x = 0;
    for (const p of parts.filter(q => !q.stock)) x += drawPanel(wr, p, x, 0, false, labelOf(p) + (p.qty > 1 ? ' x' + p.qty : '')).w + gap;
    return wr.done();
  }
  function svgSheets(nestRes) {
    const wr = svgWriter(), L = nestRes.L * MM, S = nestRes.S * MM;
    nestRes.sheets.forEach((sh, i) => {
      const oy = -i * (S + 100);
      wr.poly('SHEET', [[0, oy], [L, oy], [L, oy + S], [0, oy + S]]);
      wr.text('NOTE', [0, oy + S + 12], 10, 'Sheet ' + (i + 1) + ' of ' + nestRes.sheets.length);
      for (const pl of sh.placed) drawPanel(wr, pl.it.part, pl.x * MM, oy + pl.y * MM, pl.it.rot, labelOf(pl.it.part));
    });
    return wr.done();
  }

  // ---------------------------------------------------------------- triangulation
  // Ear clipping of a polygon with holes (holes are bridged into the outline
  // first). Small polygons only: O(n²), plenty for a panel and its holes.
  function triangulate(outer, holes) {
    let ring = outer.slice();
    if (area2(ring) < 0) ring.reverse();
    // holes: clockwise, rightmost first
    const hs = holes.map(h => (area2(h) > 0 ? h.slice().reverse() : h.slice()))
      .sort((a, b) => Math.max(...b.map(p => p[0])) - Math.max(...a.map(p => p[0])));
    for (const h of hs) ring = bridge(ring, h);
    return earClip(ring);
  }
  // join a hole to the ring with a two-way cut from the hole's rightmost point
  function bridge(ring, hole) {
    let mi = 0;
    for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[mi][0]) mi = i;
    const M = hole[mi];
    // nearest ring edge hit by a ray from M toward +x
    let best = null, bx = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[1] === b[1] || M[1] < Math.min(a[1], b[1]) || M[1] > Math.max(a[1], b[1])) continue;
      const t = (M[1] - a[1]) / (b[1] - a[1]);
      if (t < 0 || t > 1) continue;
      const x = a[0] + t * (b[0] - a[0]);
      if (x >= M[0] - EPS && x < bx) { bx = x; best = a[0] > b[0] ? i : (i + 1) % ring.length; }
    }
    if (best == null) best = 0;
    // a ring point visible from M: the edge end, or the reflex point inside (M, I, P) nearest the ray
    const P = ring[best], I = [bx, M[1]];
    let pick = best, bestAng = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const q = ring[i];
      if (i === best || q[0] < M[0] - EPS) continue;
      if (inTri(M, I, P, q) || inTri(M, P, I, q)) {
        const ang = Math.abs(Math.atan2(q[1] - M[1], q[0] - M[0]));
        if (ang < bestAng - EPS || (Math.abs(ang - bestAng) <= EPS && q[0] < ring[pick][0])) { bestAng = ang; pick = i; }
      }
    }
    const hs = hole.slice(mi).concat(hole.slice(0, mi));
    return ring.slice(0, pick + 1).concat(hs, [hs[0]], [ring[pick]], ring.slice(pick + 1));
  }
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (a, b, c, p) => cross(a, b, p) >= -EPS && cross(b, c, p) >= -EPS && cross(c, a, p) >= -EPS;
  function earClip(pts) {
    const idx = pts.map((_, i) => i), tris = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < 100000) {
      let clipped = false;
      for (let k = 0; k < idx.length; k++) {
        const ia = idx[(k - 1 + idx.length) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
        const a = pts[ia], b = pts[ib], c = pts[ic];
        if (cross(a, b, c) <= EPS) continue;                     // reflex or flat
        let inside = false;
        for (const j of idx) {
          if (j === ia || j === ib || j === ic) continue;
          const q = pts[j];
          if ((q[0] === a[0] && q[1] === a[1]) || (q[0] === b[0] && q[1] === b[1]) || (q[0] === c[0] && q[1] === c[1])) continue;
          if (cross(a, b, q) > EPS && cross(b, c, q) > EPS && cross(c, a, q) > EPS) { inside = true; break; }
        }
        if (inside) continue;
        tris.push([a, b, c]);
        idx.splice(k, 1);
        clipped = true;
        break;
      }
      if (!clipped) {
        // drop a flat point and go on (left by bridges)
        let dropped = false;
        for (let k = 0; k < idx.length; k++) {
          const a = pts[idx[(k - 1 + idx.length) % idx.length]], b = pts[idx[k]], c = pts[idx[(k + 1) % idx.length]];
          if (Math.abs(cross(a, b, c)) <= EPS) { idx.splice(k, 1); dropped = true; break; }
        }
        if (!dropped) break;
      }
    }
    if (idx.length === 3) { const [a, b, c] = idx.map(i => pts[i]); if (cross(a, b, c) > EPS) tris.push([a, b, c]); }
    return tris;
  }

  // ---------------------------------------------------------------- STL
  // A panel as a solid plate t thick: top and bottom faces, outline walls and hole walls.
  function plate(p, t) {
    const sh = shape(p, { seg: 48 }), T = t * MM, out = [];
    const holeRings = sh.holes.map(h => h.type === 'circle' ? circlePts(h, true) : rectPts(h, true));
    for (const loop of sh.outline) {
      const inside = holeRings.filter(r => pointIn(r[0], loop));
      const tris = triangulate(loop, inside);
      for (const [a, b, c] of tris) {
        out.push([[a[0], a[1], T], [b[0], b[1], T], [c[0], c[1], T]]);
        out.push([[a[0], a[1], 0], [c[0], c[1], 0], [b[0], b[1], 0]]);
      }
      walls(out, area2(loop) > 0 ? loop : loop.slice().reverse(), T, false);
      for (const r of inside) walls(out, area2(r) > 0 ? r : r.slice().reverse(), T, true);
    }
    return out;
  }
  // side walls along a counter-clockwise ring (facing out, or into a hole)
  function walls(out, ring, T, hole) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const A0 = [a[0], a[1], 0], B0 = [b[0], b[1], 0], A1 = [a[0], a[1], T], B1 = [b[0], b[1], T];
      if (!hole) { out.push([A0, B0, B1]); out.push([A0, B1, A1]); }
      else { out.push([A0, B1, B0]); out.push([A0, A1, B1]); }
    }
  }
  function pointIn(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  // move or turn a list of triangles: fn maps [x, y, z] -> [x, y, z]
  const place = (tris, fn) => tris.map(t => t.map(fn));

  // every panel, flat on the bed, in a row (each as many times as it's needed)
  function stlFlat(parts, t) {
    const all = [], gap = 10;
    let x = 0;
    for (const p of parts.filter(q => !q.stock)) {
      for (let k = 0; k < p.qty; k++) {
        const pl = plate(p, t);
        all.push(...place(pl, ([a, b, c]) => [a + x, b, c]));
        x += p.w * MM + gap;
      }
    }
    return all;
  }
  // The box as built: the six outer panels (butt joints), extra baffle layers and
  // the dividers, each with its holes. Panels are found by name.
  function stlBox(parts, box) {
    const { W, H, D } = box.ext, t = box.t, all = [];
    const w = W * MM, hh = H * MM, d = D * MM, T = t * MM;
    const find = (re) => parts.find(p => re.test(p.name));
    const put = (p, fn) => { if (p) all.push(...place(plate(p, t), fn)); };
    // panel frames: u along one box axis, v along another, plate thickness along the third
    const top = find(/^Top$|^Top \/ bottom/), bottom = find(/^Bottom$|^Top \/ bottom/);
    const left = find(/^Left side$|^Sides/), right = find(/^Right side$|^Sides/), back = find(/^Back/);
    const fronts = parts.filter(p => /^Front baffle/.test(p.name));
    // butt-joint sizes, whatever joint the build sheet uses
    const bt = (p, a, b) => p && Object.assign({}, p, { w: a, h: b, holes: p.holes.map(x => Object.assign({}, x, x.shape === 'circle'
      ? { u: x.u - (p.w - a) / 2, v: x.v - (p.h - b) / 2 } : { u: x.u - (p.w - a) / 2, v: x.v - (p.h - b) / 2 })) });
    const iw = W - 2 * t, ih = H - 2 * t;
    // (every mapping is a turn, never a mirror, so the faces keep pointing out)
    // panels are drawn as seen from outside: top u = x, v from the back; bottom mirrored in x;
    // sides u along the depth (left from the back, right from the front), v up
    put(bt(bottom, W, D), ([u, v, z]) => [w - u, T - z, d - v]);                 // bottom
    put(bt(top, W, D), ([u, v, z]) => [u, hh - T + z, d - v]);                   // top
    put(bt(left, D, ih), ([u, v, z]) => [T - z, T + v, u]);                      // left
    put(bt(right, D, ih), ([u, v, z]) => [w - T + z, T + v, d - u]);             // right
    if (back) put(bt(back, iw, ih), ([u, v, z]) => [T + (iw * MM - u), T + v, T - z]);  // back, seen from behind
    let zf = d - T;
    for (const f of fronts) {
      for (let k = 0; k < f.qty; k++) {
        const z0 = zf;
        put(bt(f, iw, ih), ([u, v, z]) => [T + u, T + v, z0 + z]);
        zf -= T;
      }
    }
    // dividers (their own frames, as on the build sheet)
    const divs = parts.filter(p => /^Divider/.test(p.name));
    if (divs.length && box.layout) {
      const sa = box.split === 'W' ? 0 : 1, ext = [W, H, D];
      box.layout.chambers.slice(0, -1).forEach((c, i) => {
        const p = divs[i] || divs[0];
        const at = (ext[sa] / 2 - ext[sa] / 2 + c.start + c.len) * MM;        // low face, from the box's low side
        if (sa === 0) put(p, ([u, v, z]) => [at + T - z, T + v, T + u]);         // u = depth from the back, v = height
        else put(p, ([u, v, z]) => [T + u, at + T - z, T + v]);                  // u = width, v = depth from the back
      });
    }
    return all;
  }
  function stlBinary(tris, name) {
    const buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
    const head = ('GetLow ' + (name || '')).slice(0, 79);
    for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i) & 0x7f);
    dv.setUint32(80, tris.length, true);
    let o = 84;
    for (const [a, b, c] of tris) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
      for (const q of [n.map(x => x / l), a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, q[k], true); o += 4; }
      dv.setUint16(o, 0, true); o += 2;
    }
    return new Blob([buf], { type: 'model/stl' });
  }

  GL.cutfiles = { shape, outlineWithNotches, triangulate, plate, stlFlat, stlBox, stlBinary, dxfPanels, dxfSheets, svgPanels, svgSheets, area2 };
})(window.GL);
