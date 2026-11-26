/* GetLow — build sheet: each panel drawn with its cutouts, and the panels
   nested onto stock sheets. Pure functions; the drawings come back as SVG text
   so the app and the printable page share them.

   Box coordinates (from GL.placement): origin at the middle of the box,
   x across the width, y up, z toward the front. Panel drawings use their own
   frame: u from the left edge, v up from the bottom edge, in metres. */
(function () {
  'use strict';
  const GL = window.GL = window.GL || {};
  const IN = 0.0254;

  // Mounting screws: the datasheet's bolt circle, else midway between the cutout
  // and the frame's edge; 4 screws below 8", 8 from 8" up (the usual).
  function screws(params, cut) {
    const outer = params.dia > 0 ? params.dia : 2 * Math.sqrt(params.sd / Math.PI) * 1.18;
    const bolt = params.bolt > 0 ? params.bolt : (outer + cut) / 2;
    const n = params.holes > 0 ? Math.round(params.holes) : outer < 0.2 ? 4 : 8;
    return { n, bolt, est: !(params.bolt > 0), d: outer < 0.12 ? 0.0025 : 0.0035 };
  }
  // Cutout for a driver: the datasheet figure, else about 88% of the frame.
  function driverCutout(params) {
    if (params.cutout > 0) return { d: params.cutout, est: false };
    const outer = params.dia > 0 ? params.dia : 2 * Math.sqrt(params.sd / Math.PI) * 1.18;
    return { d: outer * 0.88, est: true };
  }
  // passive radiator: frame from its cone area (as placement does), cutout 88% of that
  const prCutout = (sd) => ({ d: 2 * Math.sqrt(sd / Math.PI) * 1.15 * 0.88, est: true });

  // The panels as drawings, one entry per distinct panel.
  //   list:   the merged cut list (name, qty, a, b, opening, dowel, fillet)
  //   plan:   GL.placement plan (may be null)
  //   layout: GL.geometry layout (chambers with start and len)
  function panels(o) {
    const { list, box, plan, layout, design } = o;
    const { W, H, D } = box.ext, t = box.t;
    const zBi = -D / 2 + t, zFi = D / 2 - t * box.layers, intD = zFi - zBi;
    const sa = box.split === 'W' ? 0 : 1;
    const drvCut = o.drvCut || { d: 0.1, est: true };
    const scr = o.screws || null;
    const out = [];
    const near = (a, b) => Math.abs(a - b) < 1e-4;

    // everything that makes a hole, in box coordinates
    const feats = [];
    if (plan) {
      for (const d of plan.drivers) {
        feats.push({ kind: 'driver', face: d.front ? 'front' : 'divider', P: d.pos, d: drvCut.d, est: drvCut.est, label: d.flip ? 'Driver cutout (reversed: mount it from the other side, magnet out; wire it + to −)' : 'Driver cutout', screws: scr, dir: d.dir });
      }
      for (const p of plan.prs) {
        const pr = design.prs[0];
        const c = pr ? prCutout(pr.sd) : { d: 2 * p.r * 0.88, est: true };
        feats.push({ kind: 'pr', face: 'front', P: p.pos, d: c.d, est: c.est, label: 'Passive radiator cutout' });
      }
      for (const p of plan.ports) {
        const r = p.route;
        if (!r) continue;
        if (r.kind === 'round' && r.pts && r.pts.length) {
          feats.push({ kind: 'port', face: r.wall || (r.front ? 'front' : 'divider'), P: r.pts[0], d: p.pt.d + 2 * (p.pt.wall || 0), label: p.pt.name + ' hole (tube outside)' });
        } else if (r.kind === 'slot' && r.opening) {
          feats.push({ kind: 'slot', face: r.front ? 'front' : 'divider', box3: r.opening, label: p.pt.name + ' slot opening' });
          if (r.via && r.frame) {
            // the notch in the divider the slot passes through, at the back
            const lo = [0, 0, 0], hi = [0, 0, 0], f = r.frame;
            lo[f.im] = f.e0; hi[f.im] = f.e1;
            lo[2] = zBi; hi[2] = zBi + r.w + (r.onWall ? 0 : t);
            feats.push({ kind: 'notch', box3: [lo, hi], via: [r.via, p.chamber], label: p.pt.name + ' notch' });
          }
        }
      }
    }

    // frame for each panel: which axes run left-right and bottom-up, and its origin
    const frontFrame = { face: 'front', u: 0, v: 1, u0: -W / 2 + t, v0: -H / 2 + t, w: W - 2 * t, h: H - 2 * t, plane: 2,
      edges: { left: 'left side', right: 'right side', top: 'top', bottom: 'bottom' }, view: 'Seen from the front' };
    // a frame may flip an axis (su, sv = -1) so every panel is drawn as seen from outside
    const toPanel = (fr, P) => [(fr.su || 1) * P[fr.u] + (fr.cu != null ? fr.cu : -fr.u0), (fr.sv || 1) * P[fr.v] + (fr.cv != null ? fr.cv : -fr.v0)];
    const near0 = (lo, hi) => (x) => x > lo - 1e-4 && x < hi + 1e-4;
    const holesOn = (fr, onPlane, notchOk) => {
      const holes = [];
      for (const f of feats) {
        if (fr.face && f.face && f.face !== fr.face && f.kind !== 'notch') continue;
        if (f.kind === 'notch') {
          if (!notchOk || !notchOk(f)) continue;
        } else if (f.P) {
          if (!onPlane(f.P[fr.plane])) continue;
        } else if (f.box3) {
          if (!onPlane((f.box3[0][fr.plane] + f.box3[1][fr.plane]) / 2)) continue;
        }
        if (f.P) {
          const [u, v] = toPanel(fr, f.P);
          holes.push({ kind: f.kind, shape: 'circle', u, v, d: f.d, est: f.est, label: f.label });
          if (f.screws) {
            const sc = f.screws, start = Math.PI / sc.n;
            for (let k = 0; k < sc.n; k++) {
              const a = start + k * 2 * Math.PI / sc.n;
              holes.push({ kind: 'screw', shape: 'circle', u: u + sc.bolt / 2 * Math.cos(a), v: v + sc.bolt / 2 * Math.sin(a), d: sc.d, bolt: sc.bolt, est: sc.est, label: 'Pilot hole' });
            }
          }
        } else {
          const [a0, b0] = toPanel(fr, f.box3[0]), [a1, b1] = toPanel(fr, f.box3[1]);
          const u = Math.max(0, Math.min(a0, a1)), v = Math.max(0, Math.min(b0, b1));
          const u1 = Math.min(fr.w, Math.max(a0, a1)), v1 = Math.min(fr.h, Math.max(b0, b1));
          if (u1 - u > 1e-4 && v1 - v > 1e-4) holes.push({ kind: f.kind, shape: 'rect', u, v, w: u1 - u, h: v1 - v, label: f.label });
        }
      }
      return holes;
    };

    for (const r of list) {
      if (r.dowel || r.fillet) {
        out.push({ name: r.name, qty: r.qty, w: r.a, h: r.b, stock: true, dowel: !!r.dowel, fillet: !!r.fillet, holes: [] });
        continue;
      }
      if (/^Front baffle/.test(r.name)) {
        const zf = D / 2;
        const fr = Object.assign({}, frontFrame, { u0: -r.a / 2, v0: -r.b / 2, w: r.a, h: r.b });
        const holes = holesOn(fr, (z) => z > zFi - 1e-4 && z < zf + 1e-4);
        const inner = /inner layers/.test(r.name);
        out.push({ name: r.name, qty: r.qty, w: fr.w, h: fr.h, holes, edges: fr.edges, view: fr.view,
          note: r.qty > 1 || /outer layer/.test(r.name) ? 'Every layer gets the same cutouts' + (inner ? '' : '; screw the drivers into the outer one') + '. To flush-mount the drivers, rebate the outer layer to the frame size.' : null });
        continue;
      }
      if (r.name === 'Top / bottom' || r.name === 'Sides') {
        // seen from outside; a pair with a port on one of them becomes two panels
        const top = r.name === 'Top / bottom';
        const w = top ? r.a : r.b, hh = top ? r.b : r.a;
        const frames = top
          ? [{ name: 'Top', face: 'top', u: 0, v: 2, su: 1, sv: -1, cu: w / 2, cv: hh / 2, plane: 1, on: near0(H / 2 - t, H / 2), view: 'Seen from above',
               edges: { left: 'left side', right: 'right side', top: 'back', bottom: 'front' } },
             { name: 'Bottom', face: 'bottom', u: 0, v: 2, su: -1, sv: -1, cu: w / 2, cv: hh / 2, plane: 1, on: near0(-H / 2, -H / 2 + t), view: 'Seen from below',
               edges: { left: 'right side', right: 'left side', top: 'back', bottom: 'front' } }]
          : [{ name: 'Left side', face: 'left', u: 2, v: 1, su: 1, sv: 1, cu: w / 2, cv: hh / 2, plane: 0, on: near0(-W / 2, -W / 2 + t), view: 'Seen from the left',
               edges: { left: 'back', right: 'front', top: 'top', bottom: 'bottom' } },
             { name: 'Right side', face: 'right', u: 2, v: 1, su: -1, sv: 1, cu: w / 2, cv: hh / 2, plane: 0, on: near0(W / 2 - t, W / 2), view: 'Seen from the right',
               edges: { left: 'front', right: 'back', top: 'top', bottom: 'bottom' } }];
        const each = frames.map(fr => { Object.assign(fr, { w, h: hh }); fr.holes = holesOn(fr, fr.on); return fr; });
        if (each.some(fr => fr.holes.length)) {
          for (const fr of each) out.push({ name: fr.name, qty: 1, w, h: hh, holes: fr.holes, edges: fr.edges, view: fr.view });
        } else out.push({ name: r.name, qty: r.qty, w, h: hh, holes: [], edges: each[0].edges, view: top ? 'Top seen from above' : 'Left side seen from the left' });
        continue;
      }
      if (r.name === 'Back') {
        const fr = { face: 'back', u: 0, v: 1, su: -1, sv: 1, cu: r.a / 2, cv: r.b / 2, w: r.a, h: r.b, plane: 2 };
        const holes = holesOn(fr, near0(-D / 2, -D / 2 + t));
        const cup = o.terminal && o.terminal.on && o.terminal.size > 0;
        if (!cup) {
          out.push({ name: r.name, qty: r.qty, w: r.a, h: r.b, holes, edges: { left: 'right side', right: 'left side', top: 'top', bottom: 'bottom' }, view: 'Seen from behind' });
          continue;
        }
        // terminal cup: in the chamber the driver's motor is in, low on the back
        let cx = 0, cy = -H / 2 + t + Math.max(o.terminal.size, (H - 2 * t) * 0.3);
        if (layout && layout.chambers.length > 1 && design.mount) {
          const ext = [W, H, D], c = layout.chambers.find(x => x.id === design.mount.rear) || layout.chambers[0];
          const mid = -ext[sa] / 2 + c.start + c.len / 2;
          if (sa === 0) cx = mid; else cy = mid;
        }
        // seen from behind, left and right swap
        const [u, v] = toPanel(fr, [cx, cy, 0]), s2 = o.terminal.size;
        holes.push(o.terminal.shape === 'round'
          ? { kind: 'terminal', shape: 'circle', u, v, d: s2, label: 'Terminal cup cutout' }
          : { kind: 'terminal', shape: 'rect', u: u - s2 / 2, v: v - s2 / 2, w: s2, h: s2, label: 'Terminal cup cutout' });
        out.push({ name: r.name, qty: r.qty, w: r.a, h: r.b, holes, edges: { left: 'right side', right: 'left side', top: 'top', bottom: 'bottom' }, view: 'Seen from behind',
          note: 'Check the cup\'s own cutout size before cutting; seal it with its gasket or a bead of caulk.' });
        continue;
      }
      if (r.name === 'Divider' && layout && layout.chambers.length > 1) {
        const ext = [W, H, D];
        for (let i = 0; i < layout.chambers.length - 1; i++) {
          const c = layout.chambers[i], c2 = layout.chambers[i + 1];
          const low = -ext[sa] / 2 + c.start + c.len, high = low + t;
          const fr = sa === 0
            ? { face: 'divider', u: 2, v: 1, u0: zBi, v0: -H / 2 + t, w: intD, h: H - 2 * t, plane: 0,
                edges: { left: 'back', right: 'front', top: 'top', bottom: 'bottom' }, view: 'Seen from the ' + (c.name || 'left chamber').toLowerCase() + ' side' }
            : { face: 'divider', u: 0, v: 2, u0: -W / 2 + t, v0: zBi, w: W - 2 * t, h: intD, plane: 1,
                edges: { left: 'left side', right: 'right side', top: 'front', bottom: 'back' }, view: 'Seen from above' };
          const ids = [c.id, c2.id];
          const holes = holesOn(fr, (x) => x > low - 1e-4 && x < high + 1e-4, (f) => f.via && f.via.every(id => ids.includes(id)));
          out.push({ name: layout.chambers.length > 2 ? 'Divider ' + (i + 1) + ' (' + c.name + ' / ' + c2.name + ')' : 'Divider',
            qty: 1, w: fr.w, h: fr.h, holes, edges: fr.edges, view: fr.view });
        }
        continue;
      }
      const holes = r.opening ? [{ kind: 'window', shape: 'rect', u: (r.a - r.opening[0]) / 2, v: (r.b - r.opening[1]) / 2, w: r.opening[0], h: r.opening[1], label: 'Window' }] : [];
      out.push({ name: r.name, qty: r.qty, w: r.a, h: r.b, holes });
    }
    // labels A, B, C … for the sheet parts
    let k = 0;
    for (const p of out) if (!p.stock) p.key = String.fromCharCode(65 + (k++ % 26)) + (k > 26 ? Math.ceil(k / 26) : '');
    // number the holes on each panel
    for (const p of out) {
      let k = 0, last = null;
      for (const hh of p.holes) {
        if (hh.kind === 'screw') { hh.n = last; hh.screw = true; continue; }
        hh.n = ++k; last = k;
      }
    }
    return out;
  }

  // Shelf packing (first fit, tallest first) onto sheets of sheet.w × sheet.h
  // (the long side across). kerf is left between parts and at no edge.
  function nest(parts, sheet) {
    const L = Math.max(sheet.w, sheet.h), S = Math.min(sheet.w, sheet.h), kerf = sheet.kerf || 0;
    const items = [];
    for (const p of parts) {
      if (p.stock) continue;
      for (let q = 0; q < p.qty; q++) items.push({ part: p, a: p.w, b: p.h });
    }
    // orient: long side across the sheet when it can turn
    for (const it of items) {
      const lo = Math.min(it.a, it.b), hi = Math.max(it.a, it.b);
      if (sheet.rotate !== false) { it.w = hi; it.h = lo; if (hi > L + 1e-9 && hi <= S + 1e-9 && lo <= L) { it.w = lo; it.h = hi; } }
      else { it.w = it.a; it.h = it.b; }
      it.rot = it.w !== it.a;
    }
    items.sort((p, q) => q.h - p.h || q.w - p.w);
    const sheets = [], tooBig = [];
    for (const it of items) {
      if (it.w > L + 1e-9 || it.h > S + 1e-9) { tooBig.push(it); continue; }
      let placed = false;
      for (const sh of sheets) {
        for (const shelf of sh.shelves) {
          if (it.h <= shelf.h + 1e-9 && shelf.x + it.w <= L + 1e-9) {
            sh.placed.push({ it, x: shelf.x, y: shelf.y });
            shelf.x += it.w + kerf;
            placed = true; break;
          }
        }
        if (placed) break;
        if (sh.top + it.h <= S + 1e-9 && it.w <= L + 1e-9) {
          const shelf = { y: sh.top, h: it.h, x: it.w + kerf };
          sh.shelves.push(shelf);
          sh.placed.push({ it, x: 0, y: sh.top });
          sh.top += it.h + kerf;
          placed = true; break;
        }
      }
      if (!placed) {
        const sh = { shelves: [{ y: 0, h: it.h, x: it.w + kerf }], placed: [{ it, x: 0, y: 0 }], top: it.h + kerf };
        sheets.push(sh);
      }
    }
    for (const sh of sheets) sh.used = sh.placed.reduce((s, p) => s + p.it.w * p.it.h, 0) / (L * S);
    return { sheets, tooBig, L, S };
  }

  // ---------------------------------------------------------------- drawing
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const n2 = (v) => (Math.round(v * 10) / 10).toString();

  // One panel, with overall dimensions, edge names and numbered cutouts.
  // ref: the biggest panel's size (m), so every drawing at one scale has the same text size
  function panelSvg(p, fmt, ref) {
    const mm = 1000, w = p.w * mm, h = p.h * mm, big = Math.max(ref ? ref * mm : 0, w, h);
    const fs = Math.max(6, big * 0.04), pad = fs * 4.2;
    const vb = [-pad, -pad * 0.9, w + pad * 1.6, h + pad * 2];
    const y = (v) => h - v * mm;              // panel v is up; SVG y is down
    const s = [];
    s.push(`<svg xmlns="http://www.w3.org/2000/svg" class="bs-svg" viewBox="${vb.map(n2).join(' ')}" role="img" aria-label="${esc(p.name)}">`);
    s.push(`<rect class="bs-panel" x="0" y="0" width="${n2(w)}" height="${n2(h)}"/>`);
    for (const hh of p.holes) {
      if (hh.shape === 'circle') {
        const cx = hh.u * mm, cy = y(hh.v), r = hh.d * mm / 2;
        if (hh.screw) { s.push(`<circle class="bs-screw" cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(Math.max(r, fs * 0.12))}"/>`); continue; }
        s.push(`<circle class="bs-hole bs-${hh.kind}" cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r)}"/>`);
        s.push(`<path class="bs-centre" d="M${n2(cx - fs * 0.7)} ${n2(cy)}h${n2(fs * 1.4)}M${n2(cx)} ${n2(cy - fs * 0.7)}v${n2(fs * 1.4)}"/>`);
        s.push(`<text class="bs-num" x="${n2(cx + fs * 0.5)}" y="${n2(cy - fs * 0.5)}" font-size="${n2(fs)}">${hh.n}</text>`);
      } else {
        const x0 = hh.u * mm, y0 = y(hh.v + hh.h);
        s.push(`<rect class="bs-hole bs-${hh.kind}" x="${n2(x0)}" y="${n2(y0)}" width="${n2(hh.w * mm)}" height="${n2(hh.h * mm)}"/>`);
        s.push(`<text class="bs-num" x="${n2(x0 + hh.w * mm / 2)}" y="${n2(y0 + hh.h * mm / 2 + fs * 0.35)}" font-size="${n2(fs)}" text-anchor="middle">${hh.n}</text>`);
      }
    }
    // overall dimensions: width below, height on the right
    const dy = h + fs * 1.6, dx = w + fs * 1.6, tk = fs * 0.5;
    s.push(`<path class="bs-dim" d="M0 ${n2(dy)}H${n2(w)}M0 ${n2(dy - tk)}v${n2(2 * tk)}M${n2(w)} ${n2(dy - tk)}v${n2(2 * tk)}"/>`);
    s.push(`<text class="bs-dimtext" x="${n2(w / 2)}" y="${n2(dy + fs * 1.25)}" font-size="${n2(fs)}" text-anchor="middle">${esc(fmt(p.w))}</text>`);
    s.push(`<path class="bs-dim" d="M${n2(dx)} 0V${n2(h)}M${n2(dx - tk)} 0h${n2(2 * tk)}M${n2(dx - tk)} ${n2(h)}h${n2(2 * tk)}"/>`);
    s.push(`<text class="bs-dimtext" x="${n2(dx + fs * 1.3)}" y="${n2(h / 2)}" font-size="${n2(fs)}" transform="rotate(-90 ${n2(dx + fs * 1.3)} ${n2(h / 2)})" text-anchor="middle">${esc(fmt(p.h))}</text>`);
    // edge names (which way round it goes in)
    if (p.edges) {
      const e = p.edges, ef = fs * 0.8;
      s.push(`<text class="bs-edge" x="${n2(w / 2)}" y="${n2(-fs * 0.6)}" font-size="${n2(ef)}" text-anchor="middle">${esc(e.top)}</text>`);
      s.push(`<text class="bs-edge" x="${n2(-fs * 0.6)}" y="${n2(h / 2)}" font-size="${n2(ef)}" text-anchor="middle" transform="rotate(-90 ${n2(-fs * 0.6)} ${n2(h / 2)})">${esc(e.left)}</text>`);
      s.push(`<text class="bs-edge" x="${n2(w / 2)}" y="${n2(h - fs * 0.5)}" font-size="${n2(ef)}" text-anchor="middle">${esc(e.bottom)} edge</text>`);
    }
    s.push('</svg>');
    return s.join('');
  }

  // Where each cutout goes, measured from the left and bottom edges.
  function holeRows(p, fmt) {
    const rows = [];
    for (const hh of p.holes) {
      if (hh.screw) {
        // one row per cutout: n pilot holes on its bolt circle
        const r = rows[rows.length - 1];
        if (r && r.n === hh.n && !r.screwRow) rows.push({ n: hh.n, screwRow: true, what: 'Screws for ' + hh.n, size: p.holes.filter(x => x.screw && x.n === hh.n).length + ' pilot holes Ø ' + fmt(hh.d), at: 'evenly on a Ø ' + fmt(hh.bolt) + ' circle round it' + (hh.est ? ' (estimated: mark them from the driver)' : '') });
        continue;
      }
      rows.push(rowFor(hh, fmt));
    }
    return rows;
  }
  function rowFor(hh, fmt) {
    return hh.shape === 'circle'
      ? { n: hh.n, what: hh.label, size: 'Ø ' + fmt(hh.d) + (hh.est ? ' (estimated)' : ''), at: 'centre ' + fmt(hh.u) + ' from the left, ' + fmt(hh.v) + ' from the bottom' }
      : { n: hh.n, what: hh.label, size: fmt(hh.w) + ' × ' + fmt(hh.h), at: 'corner ' + fmt(hh.u) + ' from the left, ' + fmt(hh.v) + ' from the bottom' };
  }

  // One stock sheet with its parts.
  function sheetSvg(sh, nestRes, fmt) {
    const mm = 1000, L = nestRes.L * mm, S = nestRes.S * mm;
    const fs = L * 0.018, pad = fs * 2.4;
    const s = [];
    s.push(`<svg xmlns="http://www.w3.org/2000/svg" class="bs-svg bs-sheetsvg" viewBox="${n2(-pad)} ${n2(-pad)} ${n2(L + 2 * pad)} ${n2(S + pad * 2.2)}" role="img" aria-label="Sheet layout">`);
    s.push(`<rect class="bs-sheet" x="0" y="0" width="${n2(L)}" height="${n2(S)}"/>`);
    for (const pl of sh.placed) {
      const x = pl.x * mm, y = pl.y * mm, w = pl.it.w * mm, h = pl.it.h * mm;
      s.push(`<rect class="bs-part" x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}"/>`);
      const f = Math.min(fs * 1.4, h * 0.32, w * 0.2);
      if (f > fs * 0.35) {
        s.push(`<text class="bs-key" x="${n2(x + w / 2)}" y="${n2(y + h / 2 - f * 0.1)}" font-size="${n2(f)}" text-anchor="middle">${esc(pl.it.part.key)}</text>`);
        const f2 = Math.min(fs * 0.8, h * 0.18, w / 9);
        if (f2 > fs * 0.3) s.push(`<text class="bs-sz" x="${n2(x + w / 2)}" y="${n2(y + h / 2 + f2 * 1.3)}" font-size="${n2(f2)}" text-anchor="middle">${esc(fmt(pl.it.w) + ' × ' + fmt(pl.it.h))}</text>`);
      }
    }
    s.push(`<text class="bs-dimtext" x="${n2(L / 2)}" y="${n2(S + pad * 1.25)}" font-size="${n2(fs)}" text-anchor="middle">${esc(fmt(nestRes.L) + ' × ' + fmt(nestRes.S) + ' · ' + (sh.used * 100).toFixed(0) + '% used')}</text>`);
    s.push('</svg>');
    return s.join('');
  }

  // Styles for the drawings. Colours come from the page's own tokens when it has them.
  const CSS = `
.bs-svg { width: 100%; height: auto; display: block; font-family: inherit; }
.bs-panel { fill: var(--bs-wood, #e9d8b8); stroke: var(--bs-ink, #222); stroke-width: 0.35%; vector-effect: non-scaling-stroke; }
.bs-hole { fill: var(--bs-hole, #fff); stroke: var(--bs-cut, #c0392b); stroke-width: 1.6px; vector-effect: non-scaling-stroke; stroke-dasharray: 6 3; }
.bs-centre, .bs-dim { stroke: var(--bs-ink, #222); stroke-width: 1px; vector-effect: non-scaling-stroke; fill: none; }
.bs-num { fill: var(--bs-cut, #c0392b); font-weight: 700; }
.bs-screw { fill: var(--bs-hole, #fff); stroke: var(--bs-cut, #c0392b); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.bs-dimtext { fill: var(--bs-ink, #222); }
.bs-edge { fill: var(--bs-muted, #666); font-style: italic; }
.bs-sheet { fill: var(--bs-hole, #fff); stroke: var(--bs-ink, #222); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
.bs-part { fill: var(--bs-wood, #e9d8b8); stroke: var(--bs-ink, #222); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.bs-key { fill: var(--bs-ink, #222); font-weight: 700; }
.bs-sz { fill: var(--bs-muted, #555); }
`;

  GL.buildsheet = { driverCutout, prCutout, screws, panels, nest, panelSvg, holeRows, sheetSvg, CSS, IN };
})();
