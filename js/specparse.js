/* GetLow – read driver specs from pasted text (Parts Express pages, maker
 * datasheets, forum posts). Understands both metric and imperial units,
 * guesses missing units from plausible ranges, and cross-checks the
 * parameters against each other to catch unit mix-ups. */
(function (GL) {
  'use strict';
  const { phys } = GL;
  const IN = 0.0254, FT3 = 0.028316846592;

  // ---- units: [regex on normalised unit text, factor to SI, display] -----
  const UNITS = {
    freq: [[/^khz/, 1000, 'kHz'], [/^hz/, 1, 'Hz']],
    vol: [
      [/^(l|ltr|liters?|litres?|dm3)$/, 1e-3, 'L'],
      [/^(ft3|cuft|cubicf(ee|oo)t|ft\^3|cf)$/, FT3, 'ft³'],
      [/^(in3|cuin|cubicinch(es)?|in\^3)$/, IN * IN * IN, 'in³'],
      [/^(cm3|cc|ml)$/, 1e-6, 'cm³'],
      [/^m3$/, 1, 'm³'],
    ],
    area: [
      [/^(cm2|sqcm|cm\^2|squarecentimet(er|re)s?)$/, 1e-4, 'cm²'],
      [/^(in2|sqin|in\^2|squareinch(es)?|sqinch(es)?)$/, IN * IN, 'in²'],
      [/^(mm2|sqmm)$/, 1e-6, 'mm²'],
      [/^(m2|sqm)$/, 1, 'm²'],
    ],
    len: [
      [/^(mm|millimet(er|re)s?)$/, 1e-3, 'mm'],
      [/^(in|inch|inches|"|”|'')$/, IN, 'in'],
      [/^(cm)$/, 1e-2, 'cm'],
      [/^(m|met(er|re)s?)$/, 1, 'm'],
    ],
    ohm: [[/^(ω|ohms?|Ω)$/i, 1, 'Ω']],
    ind: [[/^mh$/, 1e-3, 'mH'], [/^(uh|µh|μh)$/, 1e-6, 'µH'], [/^h$/, 1, 'H']],
    bl: [[/^(tm|t·m|n\/a|wb\/m|tesla?m(et(er|re)s?)?)$/, 1, 'T·m']],
    mass: [[/^(g|gr|grams?|gm)$/, 1e-3, 'g'], [/^kg$/, 1, 'kg'], [/^oz$/, 0.0283495, 'oz']],
    comp: [[/^mm\/n$/, 1e-3, 'mm/N'], [/^(um\/n|µm\/n|μm\/n)$/, 1e-6, 'µm/N'], [/^m\/n$/, 1, 'm/N']],
    mres: [[/^(kg\/s|ns\/m|n·s\/m|mechohms?|mechanicalohms?)$/, 1, 'kg/s']],
    power: [[/^(w|watts?)$/, 1, 'W']],
    none: [],
  };

  // ---- labels: first match wins, so order matters -----------------------
  // q = quantity used to read the unit.
  const RULES = [
    { k: 'pe',     q: 'power', re: /(power|watt).*(rms|continuous|nominal|rated)|(rms|continuous|nominal|rated) power|^pe$|power handling$|^power$/, not: /max|peak|program|music|transient/ },
    { k: '_pmax',  q: 'power', re: /power/ },
    { k: 'fs',     q: 'freq',  re: /\bfs\b|resonan(t|ce) freq|free.?air res/ },
    { k: 'qts',    q: 'none',  re: /\bqts\b|total q\b/ },
    { k: 'qes',    q: 'none',  re: /\bqes\b|electr\w* q\b/ },
    { k: 'qms',    q: 'none',  re: /\bqms\b|mechanical q\b/ },
    { k: 'vas',    q: 'vol',   re: /\bvas\b|equivalent (air |compliance )?volume|compliance equivalent volume/ },
    { k: '_vd',    q: 'vol',   re: /\bvd\b|peak displacement|displacement volume.*(xmax|peak)|volume displacement/ },
    { k: 'dvol',   q: 'vol',   re: /displacement/ },
    { k: 'sd',     q: 'area',  re: /\bsd\b|(effective|surface|piston|radiating|projected|cone)\b.*\barea|area of (the )?cone/ },
    { k: 'r2',     q: 'ohm',   re: /^r2\b|\bre2\b/ },
    { k: 'l2',     q: 'ind',   re: /^l2\b|\ble2\b/ },
    { k: 're',     q: 'ohm',   re: /\brevc\b|\bre\b|dc resistance|voice coil resistance|\brdc\b/ },
    { k: 'le',     q: 'ind',   re: /\blevc\b|\ble\b|inductance/ },
    { k: 'BL',     q: 'bl',    re: /\bbl\b|force factor|motor strength|bl product/ },
    { k: 'Mmd',    q: 'mass',  re: /\bmmd\b|without air ?load|excl\w* air/ },
    { k: 'Mms',    q: 'mass',  re: /\bmms\b|moving mass|diaphragm mass/ },
    { k: 'Cms',    q: 'comp',  re: /\bcms\b|compliance of (the )?suspension|mechanical compliance|suspension compliance/ },
    { k: 'Rms',    q: 'mres',  re: /\brms\b|mechanical resistance|mechanical loss/ },
    { k: 'xmax',   q: 'len',   re: /\bxmax\b|linear excursion|max\w* (linear )?excursion|one.?way excursion/, not: /mech|xmech|damage|limit/ },
    { k: '_perCoil', q: 'ohm', re: /impedance.*per coil|per coil.*impedance/ },
    { k: 'znom',   q: 'ohm',   re: /^impedance$|nominal impedance|\bznom\b|^impedance \(?nominal\)?/ },
    { k: 'bolt',   q: 'len',   re: /bolt circle|(mounting )?hole circle|mounting (hole )?(pcd|pitch circle)/ },
    { k: 'dia',    q: 'len',   re: /overall (outside |outer )?diameter|outer diameter|outside diameter|frame diameter/ },
    { k: 'cutout', q: 'len',   re: /cut.?out/ },
    { k: 'depth',  q: 'len',   re: /^depth$|mounting depth|overall depth|total depth/ },
  ];

  const SECTION = /^(product details|product specifications|thiele.?small|materials|mounting|parts express staff|specifications?|t\/s parameters)/i;
  const META = {
    brand: /^(brand|manufacturer|make)$/, model: /^(model|model number|model no)$/, part: /^(part ?(number|#|no)|sku|item)$/,
    title: /^title$/, source: /^(source|url)$/,
  };

  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  function normUnit(u) {
    return u.toLowerCase().replace(/³/g, '3').replace(/²/g, '2').replace(/[µμ]/g, 'u')
      .replace(/[·*\-]/g, '').replace(/\./g, '').replace(/\s+/g, '');
  }

  // First number in a value string, plus whatever unit text follows it.
  function readValue(s) {
    const clean = s.replace(/[±~≈]/g, ' ').replace(/−/g, '-').replace(/ /g, ' ');
    const m = clean.match(/-?(\d[\d,]*\.?\d*|\.\d+)/);
    if (!m) return null;
    let tok = m[0];
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(tok)) tok = tok.replace(/,/g, '');   // 1,600
    else tok = tok.replace(',', '.');                                            // 14,8 (EU)
    const v = parseFloat(tok);
    if (!isFinite(v)) return null;
    let unit = clean.slice(m.index + m[0].length).trim();
    unit = unit.split(/@| at |\(|,|;|\s(?=\d)|\s-\s/)[0].trim();
    if (/^(cu\.?|sq\.?|cubic|square)\s/i.test(unit)) unit = unit.split(/\s+/).slice(0, 2).join(' ');
    else unit = unit.split(/\s+/)[0] || '';
    return { v, unit };
  }

  function unitFor(q, unitText) {
    if (!unitText) return null;
    const n = normUnit(unitText);
    for (const [re, f, disp] of UNITS[q] || []) if (re.test(n) || re.test(unitText.trim())) return { f, disp };
    return null;
  }

  // Unit defaults when none is printed, chosen from plausible magnitudes.
  function guessUnit(k, v) {
    switch (k) {
      case 'vas': case 'dvol': return v >= 8 ? { f: 1e-3, disp: 'L' } : { f: FT3, disp: 'ft³' };
      case 'sd': return v > 150 ? { f: 1e-4, disp: 'cm²' } : v < 1 ? { f: 1, disp: 'm²' } : { f: IN * IN, disp: 'in²' };
      case 'xmax': return v < 1.2 ? { f: IN, disp: 'in' } : { f: 1e-3, disp: 'mm' };
      case 'le': case 'l2': return v > 20 ? { f: 1e-6, disp: 'µH' } : { f: 1e-3, disp: 'mH' };
      case 'Mms': case 'Mmd': return v < 1 ? { f: 1, disp: 'kg' } : { f: 1e-3, disp: 'g' };
      case 'Cms': return v < 0.01 ? { f: 1, disp: 'm/N' } : v > 20 ? { f: 1e-6, disp: 'µm/N' } : { f: 1e-3, disp: 'mm/N' };
      case 'dia': case 'cutout': case 'depth': case 'bolt': return v > 60 ? { f: 1e-3, disp: 'mm' } : { f: IN, disp: 'in' };
      default: return { f: 1, disp: (UNITS[RULES.find(r => r.k === k).q][0] || [, , ''])[2] };
    }
  }

  // number, optional unit, optional "@ 1kHz" / "(31.7 L)" tail
  const valueLike = (s) => /^[-±~≈]?\s*\d[\d.,]*\s*[^\d@(]*(?:[@(].*)?$/.test(s.trim());

  // Split text into label/value pairs: "Label<TAB>Value", "Label: Value",
  // "Label = Value", "Label | Value", "Label   Value", or value on next line.
  function pairs(text) {
    const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m = line.match(/^(.+?)\s*(?:\t|\||:|=|\s{2,})\s*(.+)$/);
      if (m) { out.push([m[1].trim(), m[2].trim()]); continue; }
      // "L2 0.5 mH": the L2R2 labels end in a digit, so the rule below can't split them
      m = line.match(/^([LR]e?2)\s+([-.\d].*)$/i);
      if (m && valueLike(m[2])) { out.push([m[1], m[2].trim()]); continue; }
      // "Fs 31 Hz" style: label words then a number and unit (but not a
      // product name like "GRS 8SW-4HE 8 inch ...")
      m = line.match(/^([A-Za-z][A-Za-z ()\/#.'-]*?)\s+([-±~.\d].*)$/);
      if (m && valueLike(m[2])) { out.push([m[1].trim(), m[2].trim()]); continue; }
      // label alone, value on the next line
      if (i + 1 < lines.length && valueLike(lines[i + 1])) { out.push([line, lines[i + 1]]); i++; continue; }
      out.push([line, '']);
    }
    return out;
  }

  const KNOWN_BRANDS = ['Dayton Audio', 'GRS', 'Peerless', 'Tang Band', 'SB Acoustics', 'Skar Audio', 'Sundown Audio', 'Kicker', 'JL Audio',
    'Rockford Fosgate', 'Alpine', 'Pioneer', 'Polk Audio', 'Morel', 'Scan-Speak', 'SEAS', 'Eminence', 'B&C', 'Beyma', 'Faital Pro', '18 Sound',
    'Celestion', 'Fountek', 'Aurum Cantus', 'Wavecor', 'Purifi', 'Audax', 'Tymphany', 'Visaton', 'Monacor', 'Fostex', 'Markaudio', 'Vifa',
    'Dayton', 'Parts Express', 'Pyle', 'Kenwood', 'JBL', 'Infinity', 'MTX', 'Orion', 'DD Audio', 'Fi Car Audio', 'American Bass', 'Image Dynamics',
    'Hertz', 'Focal', 'Audiofrog', 'Stereo Integrity', 'Resolution Acoustics', 'Ultimax', 'Sound Splinter', 'Silver Flute', 'HiVi', 'Morel', 'Satori', 'Eighteen Sound'];

  function guessBrandModel(title) {
    const t = title.trim();
    const brand = KNOWN_BRANDS.find(b => t.toLowerCase().startsWith(b.toLowerCase()));
    if (!brand) return { brand: '', model: '' };
    const rest = t.slice(brand.length).trim();
    const model = (rest.match(/^[A-Z0-9][A-Za-z0-9\-\/.]*\d[A-Za-z0-9\-\/.]*/) || [rest.split(/\s+/)[0] || ''])[0];
    return { brand, model };
  }

  // ---- main -------------------------------------------------------------
  function parse(text) {
    const fields = {}, meta = { brand: '', model: '', part: '', title: '', source: '' }, unused = [];
    const ps = pairs(text);
    for (const [labelRaw, value] of ps) {
      const label = norm(labelRaw);
      if (!value) {
        // a product name: starts with a known brand, or is short and has a number in it
        const looksLikeName = guessBrandModel(labelRaw).brand || (/\d/.test(labelRaw) && labelRaw.length < 100);
        if (!meta.title && looksLikeName && !SECTION.test(label) && !/getlow specs/i.test(labelRaw)) meta.title = labelRaw;
        continue;
      }
      const mk = Object.keys(META).find(k => META[k].test(label));
      if (mk) { if (!meta[mk]) meta[mk] = value; continue; }
      // Full label first ("Power Handling (RMS)" is power, not Rms), then the
      // abbreviation in brackets for unusual wording ("Equiv. vol (Vas)").
      const abbr = (labelRaw.match(/\(([^)]+)\)\s*$/) || [])[1];
      const tryLabels = abbr ? [label, norm(abbr)] : [label];
      let rule = null;
      for (const L of tryLabels) {
        rule = RULES.find(r => r.re.test(L) && !(r.not && r.not.test(L)));
        if (rule) break;
      }
      if (!rule) { unused.push(labelRaw + ': ' + value); continue; }
      if (fields[rule.k]) continue;   // keep the first occurrence
      const rv = readValue(value);
      if (!rv) { unused.push(labelRaw + ': ' + value); continue; }
      let u = rule.q === 'none' ? { f: 1, disp: '' } : unitFor(rule.q, rv.unit);
      let guessed = false;
      if (!u) { u = guessUnit(rule.k, rv.v); guessed = rule.q !== 'none' && rule.q !== 'ohm' && rule.q !== 'freq' && rule.q !== 'power'; }
      fields[rule.k] = { si: rv.v * u.f, num: rv.v, unit: u.disp, raw: value, label: labelRaw, guessed };
    }

    if (!meta.brand || !meta.model) {
      const g = guessBrandModel(meta.title || '');
      meta.brand = meta.brand || g.brand;
      meta.model = meta.model || g.model;
    }
    const notes = [];
    resolveAmbiguous(fields, notes);
    const dvc = detectDvc(text, meta, fields, notes);
    const params = toParams(fields, notes);
    const checks = check(params);
    return { fields, meta, params, dvc, parseNotes: notes, notes: notes.concat(checks), unused,
      count: Object.keys(fields).filter(k => !k.startsWith('_')).length };
  }
  // Consistency checks only, for re-checking after the user edits values.
  function check(params) { const out = []; checkConsistency(params, {}, out); return out; }

  // Use the other parameters to settle a guessed Vas or Sd unit.
  function resolveAmbiguous(F, notes) {
    const rc2 = phys.rc2();
    const cms = F.Cms && !F.Cms.guessed ? F.Cms.si : null;
    if (F.vas && F.vas.guessed && cms && F.sd && !F.sd.guessed) {
      const want = rc2 * F.sd.si * F.sd.si * cms;
      const opts = [[1e-3, 'L'], [FT3, 'ft³']];
      const best = opts.reduce((b, o) => Math.abs(Math.log(F.vas.num * o[0] / want)) < Math.abs(Math.log(F.vas.num * b[0] / want)) ? o : b);
      F.vas.si = F.vas.num * best[0]; F.vas.unit = best[1];
      notes.push(['info', `Vas had no unit; read as ${best[1]} because that matches Cms and Sd.`]);
    } else if (F.vas && F.vas.guessed) {
      notes.push(['warn', `Vas had no unit; assumed ${F.vas.unit}. Check it.`]);
    }
    if (F.sd && F.sd.guessed && cms && F.vas && !F.vas.guessed) {
      const want = Math.sqrt(F.vas.si / (rc2 * cms));
      const opts = [[1e-4, 'cm²'], [IN * IN, 'in²']];
      const best = opts.reduce((b, o) => Math.abs(Math.log(F.sd.num * o[0] / want)) < Math.abs(Math.log(F.sd.num * b[0] / want)) ? o : b);
      F.sd.si = F.sd.num * best[0]; F.sd.unit = best[1];
      notes.push(['info', `Sd had no unit; read as ${best[1]} because that matches Vas and Cms.`]);
    } else if (F.sd && F.sd.guessed) {
      notes.push(['warn', `Sd had no unit; assumed ${F.sd.unit}. Check it.`]);
    }
    for (const k of ['xmax', 'le', 'Mms', 'Cms']) {
      if (F[k] && F[k].guessed) notes.push(['info', `${k} had no unit; assumed ${F[k].unit}.`]);
    }
  }

  // Dual voice coil: work out how the published numbers were measured.
  function detectDvc(text, meta, F, notes) {
    const isDvc = /\bdvc\b|dual voice coil|dual[- ]?\d\s*(ohm|Ω)|per coil/i.test(text);
    if (!isDvc) return null;
    let perCoil = F._perCoil ? F._perCoil.si : null;
    if (!perCoil) {
      const m = text.match(/(\d+(?:\.\d+)?)\s*(?:ohms?|Ω)\s*per\s*coil|dual\s*(\d+(?:\.\d+)?)\s*(?:ohms?|Ω)|dvc\s*(\d+(?:\.\d+)?)\s*(?:ohms?|Ω)/i);
      if (m) perCoil = parseFloat(m[1] || m[2] || m[3]);
    }
    const re = F.re ? F.re.si : null;
    let published = 'series';
    if (perCoil && re) {
      const r = re / perCoil;                 // series ≈ 2, one coil ≈ 1, parallel ≈ 0.5 (Re ~ 0.7-1.05 x Z)
      published = r > 1.4 ? 'series' : r > 0.7 ? 'single' : 'parallel';
    }
    const desc = { series: 'both coils in series', parallel: 'both coils in parallel', single: 'one coil' }[published];
    notes.push(['info', `Dual voice coil driver${perCoil ? ` (${perCoil} Ω per coil)` : ''}. The published Re ${re ? re.toFixed(2) + ' Ω ' : ''}looks like ${desc}. You can change this below, and pick series or parallel wiring per design.`]);
    return { coils: 2, published, perCoil };
  }

  function toParams(F, notes) {
    const p = {};
    const take = (k, to) => { if (F[k]) p[to || k] = F[k].si; };
    ['fs', 'qts', 'qes', 'qms', 'vas', 'sd', 're', 'le', 'l2', 'r2', 'xmax', 'pe', 'znom', 'BL', 'Mms', 'Cms', 'Rms', 'dvol', 'dia', 'cutout', 'bolt', 'depth'].forEach(k => take(k));
    if (!p.Mms && F.Mmd) { p.Mms = F.Mmd.si; notes.push(['info', 'Only Mmd (without air load) was given; used it as Mms. Mms is usually a few grams higher.']); }
    // Vd is Sd x Xmax, not the space the driver takes in the box
    if (p.dvol && p.sd && p.xmax && Math.abs(p.dvol / (p.sd * p.xmax) - 1) < 0.15) {
      delete p.dvol;
      notes.push(['info', '"Displacement" equals Sd × Xmax, so it was read as Vd (air moved), not the driver\'s volume in the box.']);
    }
    if (!p.dvol && F.cutout && F.depth) {
      const r = F.cutout.si / 2;
      p.dvol = Math.PI * r * r * F.depth.si / 3;
      p.dvolEstimated = true;
      notes.push(['info', `No driver displacement listed. Estimated ${(p.dvol / IN ** 3).toFixed(0)} in³ (${(p.dvol * 1000).toFixed(2)} L) from the cutout and depth, treating the driver as a cone. Use the maker's figure if you find one.`]);
    }
    if (!p.pe && F._pmax) { p.pe = F._pmax.si / 2; notes.push(['info', 'Only peak/max power found; using half of it as the RMS rating.']); }
    return p;
  }

  // Cross-check: catches typos and unit slips like liters labelled ft³.
  function checkConsistency(p, F, notes) {
    const ok = (v) => isFinite(v) && v > 0;
    const pct = (a, b) => Math.abs(a / b - 1) * 100;
    const rc2 = phys.rc2();
    if (ok(p.qes) && ok(p.qms) && ok(p.qts)) {
      const q = p.qes * p.qms / (p.qes + p.qms);
      if (pct(p.qts, q) > 6) notes.push(['warn', `Qts ${p.qts} doesn't match Qes and Qms (they give ${q.toFixed(3)}). One of them may be a typo.`]);
    }
    if (ok(p.Mms) && ok(p.Cms) && ok(p.fs)) {
      const f = 1 / (2 * Math.PI * Math.sqrt(p.Mms * p.Cms));
      if (pct(p.fs, f) > 10) notes.push(['warn', `Fs ${p.fs} Hz doesn't match Mms and Cms (they give ${f.toFixed(1)} Hz). Check the Mms and Cms units.`]);
    }
    if (ok(p.vas) && ok(p.sd) && ok(p.Cms)) {
      const v = rc2 * p.sd * p.sd * p.Cms;
      const r = p.vas / v;
      if (Math.abs(Math.log(r)) > Math.log(1.15)) {
        let hint = '';
        if (Math.abs(r / 28.3 - 1) < 0.15) hint = ' It looks like a liters value labelled as ft³.';
        else if (Math.abs(r * 28.3 - 1) < 0.15) hint = ' It looks like an ft³ value labelled as liters.';
        else if (Math.abs(r / 41.6 - 1) < 0.2 || Math.abs(r * 41.6 - 1) < 0.2) hint = ' Sd may be in the wrong unit (cm² vs in²).';
        notes.push(['warn', `Vas (${(p.vas * 1000).toFixed(1)} L) doesn't match Sd and Cms (they give ${(v * 1000).toFixed(1)} L).${hint}`]);
      }
    }
    if (ok(p.BL) && ok(p.re) && ok(p.Mms) && ok(p.fs) && ok(p.qes)) {
      const q = 2 * Math.PI * p.fs * p.Mms * p.re / (p.BL * p.BL);
      if (pct(p.qes, q) > 12) notes.push(['warn', `Qes ${p.qes} doesn't match BL, Re, Mms and Fs (they give ${q.toFixed(3)}). On dual-coil drivers this often means Re and BL are for a different coil wiring.`]);
    }
    if (ok(p.xmax) && p.xmax > 0.06) notes.push(['warn', `Xmax ${(p.xmax * 1000).toFixed(0)} mm is unusually large. Check its unit.`]);
    const need = ['fs', 'vas', 'sd', 're'].filter(k => !ok(p[k]));
    if (!(ok(p.qes) || (ok(p.qts) && ok(p.qms)))) need.push('qes');
    if (!(ok(p.qms) || (ok(p.qts) && ok(p.qes)))) need.push('qms');
    if (need.length) notes.unshift(['warn', 'Missing for simulation: ' + need.map(k => k === 're' ? 'Re' : k.charAt(0).toUpperCase() + k.slice(1)).join(', ') + '.']);
  }

  // Adjust published parameters for how a dual-coil driver is wired.
  // Coils are tightly coupled, so series vs parallel scales Re and Le by 4
  // and BL by 2 while Fs, Q and Vas stay the same.
  function forWiring(params, vc, wiring) {
    if (!vc || vc.coils !== 2 || !wiring) return params;
    const p = Object.assign({}, params);
    // first bring the published numbers to "series"
    let kR = 1, kQe = 1;
    if (vc.published === 'parallel') kR = 4;
    else if (vc.published === 'single') { kR = 2; kQe = 0.5; }
    if (wiring === 'parallel') kR /= 4;
    const scale = (k, f) => { if (isFinite(p[k])) p[k] *= f; };
    scale('re', kR); scale('znom', kR); scale('qes', kQe); scale('r2', kR); scale('l2', kR);
    scale('le', vc.published === 'single' ? kR * 2 : kR);
    if (isFinite(p.BL)) p.BL *= Math.sqrt(kR / kQe);   // keeps Qes = w·Mms·Re / BL² consistent
    if (kQe !== 1) p.qts = NaN;
    return p;
  }

  GL.specparse = { parse, check, readValue, normUnit, forWiring };
})(window.GL);
