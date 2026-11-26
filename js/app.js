/* GetLow – application: state, side panels, summary, charts and 3D wiring. */
(function (GL) {
  'use strict';
  const { h } = GL.util;
  const U = GL.units, E = GL.enclosures, G = GL.geometry, DRV = GL.drivers, X = GL.cx;
  const PKEY = 'getlow.project.v1';
  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

  const CHARTS = [
    { id: 'spl', name: 'SPL', ylabel: 'SPL @ 1 m', unit: 'dB', span: 50 },
    { id: 'max', name: 'Max SPL', ylabel: 'Max SPL @ 1 m', unit: 'dB', span: 50 },
    { id: 'imp', name: 'Impedance', ylabel: 'Impedance', unit: 'Ω', zero: true },
    { id: 'exc', name: 'Excursion', ylabel: 'Cone excursion (peak)', unit: 'mm', zero: true },
    { id: 'vel', name: 'Port air speed', ylabel: 'Port air speed (peak)', unit: 'm/s', zero: true },
    { id: 'gd',  name: 'Group delay', ylabel: 'Group delay', unit: 'ms', zero: true },
  ];

  // ---------------------------------------------------------------- state
  // passive crossover: the design's driver is the woofer; tweeter (and mid) from a few figures
  function defaultXo() {
    return { on: false, ways: 2, al: 'lr4', f1: 2500, f2: 3000, zobel: true, offset: 0.02,
      tw: { sens: 90, fs: 900, qts: 0.7, re: 5.6, le: 0.00005, zmax: 14, pad: 0, invert: false },
      mid: { sens: 88, fs: 120, qts: 0.7, re: 5.6, le: 0.0003, zmax: 25, pad: 0, invert: false } };
  }
  function defaultSignal() {
    return { mode: 'volts', volts: 2.83, watts: 100, hp: { on: false, f: 20, order: 2 }, lp: { on: false, f: 80, order: 'lr4' },
      cabin: { on: false, f: 40, max: 20 },
      airLimit: { on: true, v: 34 }, fmin: 10, fmax: 500, eq: GL.eq.defaults(), xo: defaultXo(),
      ls: { heat: false, duty: 'music', rise: 180, coil: 'cu', big: false, bl: 0.82, kms: 1.33 } };
  }
  // A typical living room: 18 × 13 × 8 ft, sub in a front corner, seat about 2/3 back.
  function defaultRoom() {
    const ft = 0.3048;
    return { L: 18 * ft, W: 13 * ft, H: 8 * ft, rt60: 0.4, sub: { x: 1 * ft, y: 1 * ft, z: 1 * ft }, seat: { x: 12 * ft, y: 6.5 * ft, z: 3.25 * ft },
      count: 1, mirror: 'width', move: 'sub', f0: 20, f1: 80, onMain: false };
  }
  // How the box is heard: in a wall / on the floor (half space, no baffle edges)
  // or standing free (baffle step and edge diffraction), plus off-axis angles
  // and an optional baffle-step compensation network.
  function defaultBaffle() {
    return { mode: 'wall', dist: 1, round: 0, angles: [], bsc: { on: false, db: 4, L: 0, R: 0 } };
  }
  // Line array of the current design (one driver in its box = one element).
  function defaultArray() {
    return { on: false, shared: true, n: 8, pitch: 0.1, shape: 'straight', angle: 20, straight: 4, custom: '', tilt: 0, steer: 0, shade: 'uniform',
      place: 'free', top: 1.8, ceiling: 2.44, listen: { d: 3, h: 1.1 }, fieldF: 2000, fieldX: 4, polarF: [500, 2000, 8000], smooth: 6, fieldMode: 'layers', layerF: [500, 1000, 5000, 8000], layerDb: 6,
      tw: { on: false, type: 'dome', size: 0.025, n: 16, pitch: 0.05, sens: 90, fs: 900, qts: 0.7, xo: 3000, order: 'lr4', trim: 0, invert: false, delay: 0 } };
  }
  function defaultTools() {
    return { pipe: { len: 1.0, d: 0.1, ends: 'co', tempC: 20, flanged: false, target: 40 }, measure: { method: 'added', sdFrom: 'driver', R: 1000 } };
  }
  const S = {
    name: 'Untitled design',
    units: 'imperial',
    driverId: null,
    design: null,
    box: G.defaultBox(),
    signal: defaultSignal(),
    room: defaultRoom(),
    saved: [], lookNext: 0,           // designs kept for comparison
    tools: defaultTools(),
    baffle: defaultBaffle(),
    array: defaultArray(),
    tab: 'driver', chart: 'spl', xray: true, explode: false, contrib: false,
  };
  let simCount = 0;          // bumps on every simulation (for caches)
  let loadBefore = null;      // the design that was there before "Load"
  let matchRes = null, matchRunning = null;
  let R = null;            // last computed results
  let liveSide = [];       // updaters for inputs in the side panel
  let liveMain = [];       // ... and for the view in the main area
  let buildingMain = false;
  const live = { push: (f) => (buildingMain ? liveMain : liveSide).push(f) };
  let boxNote = '';
  let view = null, chart = null;

  const driver = () => DRV.library.get(S.driverId) || DRV.library.list[0];
  // Dual-coil drivers: how this design wires the coils (defaults to how the specs were published).
  const coilWiring = () => {
    const vc = driver().vc;
    if (!vc) return null;
    return (S.design && S.design.coilWiring) || (vc.published === 'parallel' ? 'parallel' : 'series');
  };
  const isoOn = () => !!(S.design && S.design.iso && S.design.iso.on);
  // one "driver" in the model = one isobaric pair when isobaric is on
  const drvc = () => {
    const p = GL.specparse.forWiring(driver().params, driver().vc, coilWiring());
    return DRV.complete(isoOn() ? DRV.isobaric(p, S.design.iso.wiring) : p);
  };
  const chamberById = (id) => S.design.chambers.find(c => c.id === id);

  // ---------------------------------------------------------------- workspace: projects in tabs
  // Each open project is a whole GetLow project (state + drivers). The one in
  // the selected tab lives in S; the others are kept as project JSON, with the
  // curves from their last simulation so they can be drawn alongside it.
  const WKEY = 'getlow.workspace.v1';
  const MAX_SHOWN = 4;
  let projects = [];          // { id, show, slot, text (project JSON when not selected), curves }
  let activeId = null;
  let lastClosed = null;
  const activeProj = () => projects.find(p => p.id === activeId) || null;
  const hasProject = () => !!activeProj();

  function save() {
    const a = activeProj();
    if (!a) { saveWorkspace(); return; }
    a.text = null;
    if (R && R.res) a.curves = { f: Array.from(R.res.f, v => +v.toPrecision(5)), data: curves(R.res) };
    saveWorkspace();
  }
  function saveWorkspace() {
    try {
      const list = projects.map(p => ({ id: p.id, show: p.show, slot: p.slot,
        project: p.id === activeId ? projectJson() : JSON.parse(p.text), curves: p.curves || null }));
      localStorage.setItem(WKEY, JSON.stringify({ active: activeId, projects: list }));
    } catch (e) { /* storage full or blocked */ }
  }
  // Put the selected project away (as JSON) before another takes its place.
  function stash() {
    const a = activeProj();
    if (!a) return;
    if (R && R.res) a.curves = { f: Array.from(R.res.f, v => +v.toPrecision(5)), data: curves(R.res) };
    a.text = JSON.stringify(projectJson());
  }
  // Module state that belongs to one project only.
  function forgetProjectState() { matchRes = null; loadBefore = null; optResults = null; optBefore = null; R = null; }

  const freeSlot = (exclude) => {
    const used = new Set(projects.filter(p => p !== exclude && (p.show || p.id === activeId)).map(p => p.slot));
    for (let i = 0; i < MAX_SHOWN; i++) if (!used.has(i)) return i;
    return 0;
  };
  function addProject(json, opts = {}) {
    stash();
    const p = { id: GL.util.uid('pj'), show: false, slot: 0, text: JSON.stringify(json), curves: null };
    p.slot = freeSlot(p);
    projects.push(p);
    if (opts.select !== false) selectProject(p.id, true);
    return p;
  }
  function selectProject(id, skipStash) {
    if (!skipStash) stash();
    const p = projects.find(x => x.id === id);
    if (!p) return;
    forgetProjectState();
    activeId = id;
    loadProject(JSON.parse(p.text));
    p.text = null;
    renderAll();
  }
  function closeProject(id) {
    const i = projects.findIndex(p => p.id === id);
    if (i < 0) return;
    if (id === activeId) stash();
    lastClosed = { p: projects[i], at: i };
    projects.splice(i, 1);
    if (id === activeId) {
      activeId = null;
      forgetProjectState();
      const next = projects[Math.min(i, projects.length - 1)];
      if (next) selectProject(next.id, true); else { renderAll(); saveWorkspace(); }
    } else { renderProjectTabs(); drawChart(); saveWorkspace(); }
    toast('Closed ' + JSON.parse(lastClosed.p.text).state.name + '.', false, { label: 'Undo', run: () => {
      if (!lastClosed) return;
      projects.splice(Math.min(lastClosed.at, projects.length), 0, lastClosed.p);
      const back = lastClosed.p; lastClosed = null;
      selectProject(back.id);
    } });
  }
  function toggleShow(id, on) {
    const p = projects.find(x => x.id === id);
    if (!p) return;
    if (on && projects.filter(x => x.show || x.id === activeId).length >= MAX_SHOWN && !(p.show || p.id === activeId)) {
      toast('Up to ' + MAX_SHOWN + ' projects on the graphs at once. Untick one first.', true);
      renderProjectTabs();
      return;
    }
    p.show = on;
    if (on) {
      if (projects.some(x => x !== p && (x.show || x.id === activeId) && x.slot === p.slot)) p.slot = freeSlot(p);
      if (!p.curves && p.text) p.curves = curvesFor(JSON.parse(p.text));
    }
    renderProjectTabs(); drawChart(); saveWorkspace();
  }
  // Simulate a project that isn't selected (for its curves), then put the selected one back.
  function curvesFor(json) {
    const keep = JSON.stringify(projectJson()), keepNote = boxNote, keepR = R;
    try {
      loadProject(json);
      const out = simulate();
      return out.res ? { f: Array.from(out.res.f, v => +v.toPrecision(5)), data: curves(out.res) } : null;
    } catch (e) { console.error(e); return null; }
    finally { loadProject(JSON.parse(keep)); boxNote = keepNote; R = keepR; }
  }
  const projName = (p) => p.id === activeId ? S.name : (JSON.parse(p.text).state || {}).name || 'Project';

  function renderProjectTabs() {
    const nav = document.getElementById('ptabs');
    nav.innerHTML = '';
    for (const p of projects) {
      const active = p.id === activeId;
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Show ' + projName(p) + ' on the graphs', title: active ? 'The selected project is always on the graphs' : 'Show on the graphs' });
      cb.checked = active || p.show;
      cb.disabled = active;
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => toggleShow(p.id, cb.checked);
      const label = h('span', { class: 'ptab-name', title: active ? 'Double-click to rename' : projName(p) }, projName(p));
      if (active) label.ondblclick = (e) => {
        e.stopPropagation();
        const inp = h('input', { class: 'ptab-edit', value: S.name, 'aria-label': 'Project name' });
        const done = () => { S.name = inp.value.trim() || S.name; save(); renderProjectTabs(); drawChart(); };
        inp.onblur = done;
        inp.onkeydown = (ev) => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = S.name; inp.blur(); } };
        label.replaceWith(inp); inp.focus(); inp.select();
      };
      const sw = h('span', { class: 'ptab-sw' });
      sw.style.background = SERIES[p.slot % SERIES.length];
      const x = h('button', { class: 'ptab-x', title: 'Close ' + projName(p), 'aria-label': 'Close ' + projName(p) }, '×');
      x.onclick = (e) => { e.stopPropagation(); closeProject(p.id); };
      const tab = h('div', { class: 'ptab' + (active ? ' on' : ''), role: 'tab', 'aria-selected': active ? 'true' : 'false', tabindex: 0 }, cb, sw, label, x);
      tab.onclick = () => { if (!active) selectProject(p.id); };
      tab.onkeydown = (e) => { if (e.key === 'Enter' && !active) selectProject(p.id); };
      nav.append(tab);
    }
  }
  // The project file holds the whole state (design, box, signal, optimizer,
  // matcher, room, tools, saved comparisons, units, open tab) and every driver
  // it refers to, so it opens the same on another computer.
  function projectJson() {
    S.opt = Object.assign(defaultOpt(), S.opt || {});       // settings the Optimize tab hasn't filled in yet
    S.match = Object.assign(defaultMatch(), S.match || {});
    const drivers = [driver()];
    for (const it of S.saved || []) if (it.driver && !drivers.some(d => d.id === it.driver.id)) drivers.push(it.driver);
    return { app: 'GetLow', version: 2, saved: new Date().toISOString(), state: S, driver: driver(), drivers };
  }
  function loadProject(o) {
    if (!o || !o.state || !o.state.design) throw new Error('Not a GetLow project');
    if (o.driver && !DRV.library.get(o.driver.id)) DRV.library.add(o.driver);
    for (const d of o.drivers || []) if (d && d.id && !DRV.library.get(d.id)) DRV.library.add(d);
    // start from defaults so nothing from the previous project lingers
    Object.assign(S, { opt: undefined, match: undefined, saved: [], meas: [], lookNext: 0, room: defaultRoom(), tools: defaultTools(), baffle: defaultBaffle(), array: defaultArray(), contrib: false, kind: undefined });
    Object.assign(S, o.state);
    S.tools = Object.assign(defaultTools(), o.state.tools);
    S.baffle = Object.assign(defaultBaffle(), o.state.baffle);
    S.array = Object.assign(defaultArray(), o.state.array);
    // arrays saved before one-box arrays existed were separate cabinets
    if (o.state.array && o.state.array.shared === undefined) S.array.shared = false;
    S.array.listen = Object.assign(defaultArray().listen, S.array.listen);
    S.array.tw = Object.assign(defaultArray().tw, S.array.tw);
    S.baffle.bsc = Object.assign(defaultBaffle().bsc, S.baffle.bsc);
    S.tools.pipe = Object.assign(defaultTools().pipe, S.tools.pipe);
    S.tools.measure = Object.assign(defaultTools().measure, S.tools.measure);
    S.box = Object.assign(G.defaultBox(), o.state.box);
    // projects from before joints and terminal cups: butt joints, and a cup only if asked for
    if (!(o.state.box && o.state.box.terminal)) S.box.terminal = Object.assign(G.defaultBox().terminal, { on: false });
    if (!(o.state.box && o.state.box.sub)) { const mt = G.MATERIALS.find(x => x.id === S.box.material); S.box.sub = (mt && mt.sub) || 'ply'; }
    S.signal = Object.assign(defaultSignal(), o.state.signal);   // older saves lack newer fields
    S.signal.eq = Object.assign(GL.eq.defaults(), S.signal.eq);
    S.signal.eq.lt = Object.assign(GL.eq.defaults().lt, S.signal.eq.lt);
    S.signal.xo = Object.assign(defaultXo(), S.signal.xo);
    S.signal.ls = Object.assign(defaultSignal().ls, S.signal.ls);
    S.signal.xo.tw = Object.assign(defaultXo().tw, S.signal.xo.tw);
    S.signal.xo.mid = Object.assign(defaultXo().mid, S.signal.xo.mid);
    S.room = Object.assign(defaultRoom(), o.state.room);
    S.saved = Array.isArray(o.state.saved) ? o.state.saved : [];
    S.meas = Array.isArray(o.state.meas) ? o.state.meas : [];
    S.lookNext = Math.max(o.state.lookNext || 0, ...S.saved.map(x => (x.look || 0) + 1), 0);
    U.system = S.units;
  }

  // ---------------------------------------------------------------- design helpers
  // A new alignment. By default it keeps the box you have (size, locks, the line
  // array's column) and fills it; opts.reset starts from the suggested volume
  // instead, still keeping the shape you've locked.
  function newDesign(type, opts = {}) {
    const old = S.design;
    const keepBox = !opts.reset && !opts.fresh && old && !E.isBoxless(old.type) && !E.isLine(old.type) && !E.isHorn(old.type) &&
      !E.isBoxless(type) && !E.isLine(type) && !E.isHorn(type) && S.box.ext.W > 0;
    const keep = S.design ? { count: S.design.count, wiring: S.design.wiring, iso: S.design.iso } : { count: 1, wiring: 'parallel' };
    if (type === 'manifold') keep.count = Math.max(2, keep.count + (keep.count % 2));   // half on each side
    const d = E.makeDesign(type, drvc(), keep.count);
    d.wiring = keep.wiring;
    if (keep.iso) d.iso = keep.iso;
    S.design = d;
    S.box.minLen = {};                // (worked out again for the new design)
    for (const pt of d.ports) { pt.holdFb = true; pt.fb = E.portFb(pt, chamberById(pt.from).vol); }
    if (sharedArray() && type !== 'manifold') d.rowPitch = S.array.pitch;
    if (keepBox) fillBox(d);
    else if (!E.isBoxless(type)) {
      const lay = G.layout(d, S.box);
      if (sharedArray()) { columnBox(); G.solveDims(S.box, lay.gross, lay.n, null); }
      else if (opts.reset && ['W', 'H', 'D'].some(k => S.box.lock[k])) G.solveDims(S.box, lay.gross, lay.n, null);
      else G.applyRatio(S.box, lay.gross, lay.n, { W: 1.25, H: 1, D: 0.9 });
    }
    // Horns usually carry midrange too: open the charts to 20 kHz, and put
    // the bass range back when leaving horns (unless the user changed it).
    const sig = S.signal;
    if (E.isHorn(type) && !sig.hornRange) {
      sig.hornRange = { fmin: sig.fmin, fmax: sig.fmax };
      sig.fmin = Math.max(sig.fmin, 20); sig.fmax = 20000;
    } else if (!E.isHorn(type) && sig.hornRange) {
      if (sig.fmax === 20000) { sig.fmin = sig.hornRange.fmin; sig.fmax = sig.hornRange.fmax; }
      delete sig.hornRange;
    }
  }

  // Fill the box as it is: share out whatever the walls, drivers and ports leave,
  // in the proportions the new design suggests; ports keep their tuning.
  function fillBox(d) {
    const total0 = d.chambers.reduce((s2, c) => s2 + c.vol, 0);
    const chamberOf = (pt) => d.chambers.find(c => c.id === pt.from);
    // the air the box has for the chambers, with the new design's ports in it
    const room = () => { const lay = G.layout(d, S.box); return lay.intVol > 0 ? d.chambers.reduce((s2, c) => s2 + c.vol, 0) + lay.mismatch : 0; };
    let avail = room();
    if (!(avail > 0)) return total0;
    // share it in the proportions the new design suggests
    const share = (v) => d.chambers.forEach(c => { c.vol = Math.max(0.0001, v * c.vol / d.chambers.reduce((s2, x) => s2 + x.vol, 0)); });
    share(avail);
    // A one-chamber vented box: tune for the volume it actually has. Keele's QB3,
    // fb = 0.42·Fs·Qts^-0.9 at Vb = 15·Qts^2.87·Vas, is fb ≈ 0.97·Fs·(Vas/Vb)^0.31 at any Vb.
    if (d.chambers.length === 1 && d.ports.length) {
      const p = drvc().params, vasAll = p.vas * Math.max(1, d.count);
      const fb = Math.max(15, Math.min(250, 0.97 * p.fs * Math.pow(vasAll / d.chambers[0].vol, 0.31)));
      for (const pt of d.ports) { pt.fb = fb; pt.holdFb = true; }
    }
    for (let it = 0; it < 20; it++) {
      for (const pt of d.ports) if (pt.holdFb && pt.fb > 0) pt.len = Math.max(0.005, E.lenForFb(pt, chamberOf(pt).vol, pt.fb));
      const now = room();
      // a port too big for this box would eat it: stop rather than run away
      if (!(now > 0.15 * avail)) break;
      share(now);
      if (Math.abs(now - avail) < 1e-7) break;
      avail = now;
    }
    return total0;
  }

  // Manifold: both rear chambers stay the same size (side B follows side A).
  function syncManifold() {
    const m = S.design.mount;
    if (!m || !m.rear2) return;
    const a = chamberById(m.rear), b = chamberById(m.rear2);
    if (a && b) { b.vol = a.vol; b.ql = a.ql; b.qa = a.qa; b.bracing = a.bracing; b.braces = a.braces; }
    if (S.design.count % 2) S.design.count += 1;
  }

  // Keep port tuning when volumes or port sizes change (WinISD behaviour).
  function retune() {
    for (const pt of S.design.ports) {
      const minLen = Math.max(0.005, E.flareLen(pt));   // flares need room
      if (pt.holdFb && pt.fb > 0) {
        const raw = E.lenForFb(pt, chamberById(pt.from).vol, pt.fb);
        pt.short = raw < minLen;
        pt.len = Math.max(minLen, raw);
      } else {
        pt.short = pt.len < minLen;
      }
    }
  }

  // Full-height slots follow the box, and the box follows their displacement,
  // so settle the two together.
  function settlePorts(params) {
    const slots = S.design.ports.filter(p => p.shape === 'slot' && (p.fullHeight || p.via));
    const braced = S.design.chambers.some(c => c.braces && c.braces.kind !== 'none');
    const boxed = !E.isBoxless(S.design.type);
    for (let it = 0; it < (slots.length || braced ? 5 : 3); it++) {
      const plan = boxed ? GL.placement.plan(S.design, S.box, G.layout(S.design, S.box), params) : null;
      if (slots.length && plan) {
        // full span = the inside of whichever wall the slot sits against
        for (const p of slots) {
          const r = plan.ports.find(x => x.pt === p);
          if (r && p.fullHeight && r.route.fullSpan > 0) p.h = r.route.fullSpan;
          if (r && r.route.via) p.viaShare = r.route.viaShare;
        }
      }
      retune();
      boxMins = plan ? faceMins(plan, S.box, G.layout(S.design, S.box)) : null;
      S.box.minLen = boxMins ? boxMins.minLen : {};
      syncBox(boxMins && boxMins.mins);
    }
  }

  // Smallest inside size along each axis that lets every face hold what's on
  // it (drivers, round ports, PRs in a row, plus the slots against its walls),
  // from the placement's own numbers. Absolute sizes, so they stay put once met.
  let boxMins = null;
  // Returns { mins: smallest inside size per axis, minLen: smallest length per chamber along the split }.
  function faceMins(plan, box, lay) {
    const K = ['W', 'H', 'D'], I = lay.int, mins = {}, minLen = {};
    const n = lay.n;
    for (const f of Object.values(plan.faces).concat(plan.dividers, plan.walls || [])) {
      // round ports on "auto" don't count: when the front is full they move to another wall
      const ft = f.fit && f.fit.fixed ? Object.assign({}, f.fit, f.fit.fixed) : f.fit;
      if (!ft || !ft.n) continue;
      const gap = 0.006;                                  // about ¼" between and around items
      const want = (axis, need) => {
        const k = K[axis];
        if (n > 1 && k === box.split) {
          // a front baffle's width along the split is its chamber's length, which
          // follows the volumes: ask for the split length that makes it long enough
          const c = f.kind === 'front' && lay.chambers.find(x => x.id === f.id);
          if (c) minLen[c.id] = Math.max(minLen[c.id] || 0, c.len + need - lay.int[k]);
          return;
        }
        mins[k] = Math.max(mins[k] || 0, need);
      };
      want(ft.rowAxis, I[K[ft.rowAxis]] - ft.along + ft.total + gap * (ft.n + 1));
      want(ft.acrossAxis, I[K[ft.acrossAxis]] - ft.across + ft.maxSize + 2 * gap);
    }
    // the motor must fit behind the driver, with room to breathe
    for (const m of motorRoom(plan, box, lay)) {
      if (m.front) mins.D = Math.max(mins.D || 0, m.need - box.t * box.layers);
      else minLen[m.chamber.id] = Math.max(minLen[m.chamber.id] || 0, m.need - box.t);     // that chamber gets longer
    }
    return { mins, minLen };
  }

  // Room behind each driver's motor: needed (depth plus a gap for the pole
  // vent) and available (to the back panel, or to the far wall of its chamber).
  const MOTOR_GAP = 0.02;          // about ¾"
  function motorRoom(plan, box, lay) {
    const out = [], depth = plan.drv.depth, seen = new Set();
    for (const d of plan.drivers) {
      const key = d.front ? 'front' : d.into;
      if (seen.has(key)) continue;
      seen.add(key);
      const need = depth + MOTOR_GAP;
      if (d.front) out.push({ front: true, need, have: lay.int.D + box.t * box.layers, estimated: plan.drv.estimated });
      else {
        const c = lay.chambers.find(x => x.id === d.into);
        if (c) out.push({ front: false, chamber: c, need, have: c.len + box.t, estimated: plan.drv.estimated });
      }
    }
    return out;
  }

  // Box dims must always contain the required gross volume, and be big enough
  // for what sits on each face.
  function syncBox(mins) {
    if (E.isBoxless(S.design.type)) return;
    const lay = G.layout(S.design, S.box);
    const short = mins && Object.keys(mins).some(k => mins[k] > lay.int[k] + 1e-5);
    if (Math.abs(lay.mismatch) > 1e-7 || short) {
      const r = G.solveDims(S.box, lay.need, lay.n, null, mins);
      if (r.note) boxNote = r.note;
    }
  }

  // the smallest outside size along k that still holds the drivers and ports (0: no limit known)
  function minOutside(k) {
    const m = boxMins && boxMins.mins && boxMins.mins[k];
    return m > 0 ? m + S.box.t * G.walls(S.box, k, S.design.chambers.length) : 0;
  }
  // Outside size with locks: lock up to two, and the volume moves the third.
  function dimsCard(title) {
    const b = S.box, n = S.design.chambers.length;
    const nLocked = () => ['W', 'H', 'D'].filter(k => b.lock[k]).length;
    const dimRow = (k, name) => {
      const cb = h('input', { type: 'checkbox', checked: b.lock[k], 'aria-label': 'Lock the ' + name.toLowerCase(),
        onchange: (e) => { b.lock[k] = e.target.checked; changed(true); } });
      // one dimension must stay free to hold the volume
      if (!b.lock[k] && nLocked() >= 2) { cb.disabled = true; }
      return h('div', { class: 'dimrow' },
        uf(name, 'len', () => b.ext[k], (v) => setDim(k, v), { structural: false }),
        h('label', { class: 'lock', title: !b.lock[k] && nLocked() >= 2 ? 'Two are locked: the third has to move to hold the volume' : 'Lock this dimension' }, cb, 'lock'));
    };
    return card(title,
      check('Hold chamber volumes when I change a dimension', () => b.hold, (v) => { b.hold = v; }, { structural: true }),
      h('p', { class: 'hint' }, b.hold
        ? 'Lock the dimensions you want fixed (up to two). Changing the volume, or a size, moves the ones left free.'
        : 'Volumes follow the box: type the outside size and see what you get inside.'),
      dimRow('W', 'Width'), dimRow('H', 'Height'), dimRow('D', 'Depth'),
      liveText(() => {
        const need = ['W', 'H', 'D'].map(k => [k, minOutside(k)]).filter(x => x[1] > 0);
        return need.length ? 'Smallest that holds the drivers: ' + need.map(([k, v]) => ({ W: 'width', H: 'height', D: 'depth' }[k]) + ' ' + U.fmt('len', v)).join(', ') + '.' : '';
      }, 'hint'),
      h('div', { class: 'row-btns' },
        btn('Golden ratio', () => { const l = G.layout(S.design, b); G.applyRatio(b, l.gross, n, { W: 1.618, H: 1, D: 0.618 }); changed(); }),
        btn('Cube', () => { const l = G.layout(S.design, b); G.applyRatio(b, l.gross, n, { W: 1, H: 1, D: 1 }); changed(); })),
      liveText(() => boxNote, 'hint note'));
  }

  // User typed a new outside dimension.
  function setDim(k, v) {
    boxNote = '';
    const n = S.design.chambers.length;
    const lo = minOutside(k);
    if (lo && v < lo - 1e-6) {
      v = lo;
      boxNote = 'Held at ' + U.fmt('len', lo) + ': the drivers (and ports) need that much ' + { W: 'width', H: 'height', D: 'depth' }[k] + '.';
    }
    S.box.ext[k] = v;
    if (S.box.hold) {
      const lay = G.layout(S.design, S.box);
      const r = G.solveDims(S.box, lay.need, n, k, boxMins && boxMins.mins);
      boxNote = r.ok ? r.note : r.note;
      if (!r.ok) return;
    } else {
      // volumes follow the box: share the new internal volume by current proportions
      for (let it = 0; it < 6; it++) {
        const lay = G.layout(S.design, S.box);
        if (lay.intVol <= 0) { boxNote = 'Box is smaller than its walls.'; return; }
        lay.chambers.forEach((c) => {
          const ch = chamberById(c.id);
          const share = c.gross / lay.gross;
          const d = c.disp;
          ch.vol = Math.max(0.0001, share * lay.intVol - d.driver - d.ports - d.prs - d.bracing);
        });
        retune();
      }
    }
  }

  // ---------------------------------------------------------------- signal
  // Filter slopes: 2 = 12 dB/oct Butterworth, 4 = 24 dB/oct Butterworth, 'lr4' = 24 dB/oct Linkwitz-Riley
  const SLOPES = [['2', '12 dB/oct Butterworth'], ['4', '24 dB/oct Butterworth'], ['lr4', '24 dB/oct Linkwitz-Riley']];
  // LR4 = two cascaded 2nd-order Butterworth sections (-6 dB at the corner)
  const slopeQs = (order) => order === 'lr4' ? [0.7071, 0.7071] : +order === 4 ? [0.5412, 1.3066] : [0.7071];
  // Cascade of 2nd-order sections; numerator s² for high-pass, w0² for low-pass.
  function filterResp(w, flt, highPass) {
    const w0 = 2 * Math.PI * flt.f;
    let H = X.C(1);
    for (const q of slopeQs(flt.order)) {
      const num = highPass ? X.C(-w * w, 0) : X.C(w0 * w0, 0);
      H = X.cmul(H, X.cdiv(num, X.C(w0 * w0 - w * w, w * w0 / q)));
    }
    return H;
  }
  // the whole signal chain before the amp: subsonic, low-pass and EQ
  function chainH(w, sig = S.signal) {
    let H = X.C(1);
    if (sig.hp.on) H = X.cmul(H, filterResp(w, sig.hp, true));
    if (sig.lp.on) H = X.cmul(H, filterResp(w, sig.lp, false));
    return X.cmul(H, GL.eq.response(w, sig.eq));
  }
  // a sealed box's Fc and Qtc (for the Linkwitz transform's starting point)
  function sealedFcQ() {
    const d = S.design;
    if (!d || d.type !== 'sealed') return null;
    const dc = drvc(), p = dc.params, N = Math.max(1, d.count);
    const qts = dc.derived.qts || p.qts, k = GL.standing.effect(d.chambers[0].stuff).k;
    const ar = p.vas * N / (d.chambers[0].vol * k);
    return { fc: p.fs * Math.sqrt(1 + ar), qtc: qts * Math.sqrt(1 + ar) };
  }
  function signalFor(dc) {
    const N = S.design.count, series = S.design.wiring === 'series';
    const znomTot = series ? dc.model.znom * N : dc.model.znom / N;
    const V = S.signal.mode === 'watts' ? Math.sqrt(S.signal.watts * znomTot) : S.signal.volts;
    const per = series ? V / N : V;
    const { hp, lp } = S.signal;
    const eg = (w) => X.cscale(chainH(w), per);
    return { V, per, znomTot, W: V * V / znomTot, eg };
  }
  const cabinDb = (f) => {
    const c = S.signal.cabin;
    if (!c.on) return 0;
    return Math.min(c.max, 10 * Math.log10(1 + Math.pow(c.f / f, 4)));
  };

  // ---------------------------------------------------------------- compute
  let pending = false;
  function changed(structural) {
    histLater();
    if (structural) { renderSide(); if (S.view && S.view !== 'response') renderMainView(); }
    if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; compute(); }); }
  }

  // Cone breakup of the current driver (null when it isn't modelled).
  const breakup = () => { const b = driver().breakup; return b && b.on && b.f > 0 ? b : null; };

  // Where each radiator sits on the front baffle (from the layout), and how big it is.
  // Also carries the cone breakup (response and beaming) of the driver.
  function baffleField(out, model) {
    const B = S.baffle, bu = breakup();
    const coneR = Math.sqrt(out.drvc.params.sd / Math.PI);
    const drvR = bu ? (f) => GL.breakup.radius(coneR, f, bu) : coneR, drvMul = bu ? (w) => GL.breakup.H(w, bu) : null;
    if (!out.plan || !out.layout || (B.mode !== 'stand' && !B.angles.length)) {
      if (!bu) return null;
      return GL.baffle.makeField(model.radiators.map(r => r.kind === 'driver' ? { pts: [], r: 0, mul: drvMul } : null), null, 1);
    }
    const P = out.plan, pl = (v) => [v[0], v[1]];
    const srcs = model.radiators.map(r => {
      if (r.kind === 'driver') {
        const ds = P.drivers.filter(d => d.front);
        if (!ds.length) return null;
        return { pts: ds.map(d => pl(d.pos)), r: drvR, mul: drvMul };
      }
      if (r.kind === 'port') {
        const ps = P.ports.filter(x => x.pt.id === r.id && x.route.front);
        if (!ps.length) return null;
        const pt = ps[0].pt;
        const at = (x) => x.route.kind === 'slot'
          ? [(x.route.opening[0][0] + x.route.opening[1][0]) / 2, (x.route.opening[0][1] + x.route.opening[1][1]) / 2]
          : pl(x.route.pts[0]);
        return { pts: ps.map(at), r: pt.shape === 'slot' ? Math.sqrt(pt.w * pt.h / Math.PI) : pt.d / 2 };
      }
      if (r.kind === 'pr' && P.prs.length) return { pts: P.prs.map(x => pl(x.pos)), r: P.prs[0].r };
      return r.kind === 'driver' && drvMul ? { pts: [], r: 0, mul: drvMul } : null;
    });
    const baffle = B.mode === 'stand' ? { W: S.box.ext.W, H: S.box.ext.H, round: B.round } : null;
    return GL.baffle.makeField(srcs, baffle, B.dist);
  }

  // the response at the listening position on the SPL chart (older projects: whenever the array was on)
  const listenOn = () => S.array.listenOn !== undefined ? !!S.array.listenOn : !!S.array.on;
  // Line array in one box: the design holds every driver, in a line on its baffle at the array's pitch.
  const sharedArray = () => S.array.on && S.array.shared && S.design && !E.isBoxless(S.design.type) && !E.isLine(S.design.type) && !E.isHorn(S.design.type);
  function syncArray() {
    if (sharedArray()) {
      S.design.count = Math.max(2, Math.round(S.array.n));
      S.design.rowPitch = S.array.pitch;
    } else if (S.design) delete S.design.rowPitch;
  }
  // A column just wide enough for the drivers (plus a little), its height set by the row, its depth by the volume.
  function columnBox() {
    const dd = GL.match.outerDia(driver().params), t = S.box.t;
    S.box.ext.W = dd + 2 * t + 0.012;
    S.box.lock = { W: true, H: false, D: false };
    S.box.split = 'H';
  }

  function compute() {
    if (!hasProject()) return;
    syncArray();
    // a small driver: show the treble (once per driver, until the top is set by hand)
    const dp = driver().params;
    if (S.signal.topFor !== S.driverId) {
      S.signal.topFor = S.driverId;
      if (dp.sd > 0 && dp.sd < 0.0130 && S.signal.fmax < 2000) { S.signal.fmax = 20000; setTimeout(() => toast('Chart now runs to 20 kHz for this full-range size driver (Signal tab).'), 0); }
    }
    const out = simulate();
    simCount++;
    R = out;
    // If the design was replaced underneath the panel, its fields point at
    // stale objects: rebuild the panel instead of updating it.
    try { for (const f of liveSide) f(); } catch (e) { renderSide(); }
    try { for (const f of liveMain) f(); } catch (e) { console.error(e); renderMainView(); }
    renderMain();
    save();
  }

  // Power compression and large-signal curves, when asked for on the Signal tab.
  function beyondSmallSignal(out, dc, sig, freqs, field) {
    const ls = S.signal.ls, LS = GL.largesignal;
    const opts = { volts: sig.V, drive: sig.per, vmax: S.signal.airLimit.on ? S.signal.airLimit.v : 0, field };
    const withModel = (m) => ({ params: dc.params, model: Object.assign({}, dc.model, m), derived: dc.derived });
    out.hot = null; out.big = null;
    if (ls.heat) {
      const hc = LS.hotCoil({ re: dc.model.Re, pe: dc.model.Pe, vPer: sig.per, duty: ls.duty, rise: ls.rise, coil: ls.coil });
      // same power rating: the limit stays at the rated volts into the cold coil
      const d2 = withModel({ Re: hc.re, Pe: dc.model.Pe * dc.model.Re / hc.re });
      const m2 = E.buildModel(S.design, d2, sig.eg);
      out.hot = Object.assign(GL.sweep(m2, freqs, Object.assign({}, opts, { field: baffleField(out, m2) })), { coil: hc });
    }
    if (ls.big && dc.model.Xmax > 0) {
      const fr = GL.util.logspace(S.signal.fmin, Math.min(S.signal.fmax, 2000), 60);
      const X0 = Array.from(fr, f => GL.interp(out.res.f, out.res.xpk, f));
      const build = (b, k) => E.buildModel(S.design, withModel({ BL: dc.model.BL * b, Cms: dc.model.Cms / k }), sig.eg);
      const one = (m, f) => { const r = GL.sweep(m, Float64Array.of(f), Object.assign({}, opts, { field: baffleField(out, m) })); return { spl: r.spl[0], xpk: r.xpk[0] }; };
      out.big = LS.solve(Array.from(fr), X0, dc.model.Xmax, ls.bl, ls.kms, build, one);
    }
  }
  function simulate() {
    const out = { warnings: [], error: null };
    try {
      const dc = drvc();
      out.drvc = dc;
      if (isoOn()) {
        // tunnel sleeve: a cylinder the size of the driver, as deep as one driver
        const g = GL.placement.driverGeom(driver().params);
        S.design.iso.sleeve = Math.PI * g.r * g.r * g.depth;
      }
      syncManifold();
      settlePorts(dc.params);
      const type = S.design.type;
      if (E.isLine(type)) out.lineLay = G.lineLayout(S.design);
      else if (E.isHorn(type)) out.hornLay = G.hornLayout(S.design);
      else {
        out.layout = G.layout(S.design, S.box);
        try { out.plan = GL.placement.plan(S.design, S.box, out.layout, dc.params); } catch (e) { console.error(e); }
      }
      const bsc = S.baffle.bsc;
      if (bsc.on && bsc.L > 0 && bsc.R > 0) dc.model.zs = GL.baffle.bscZ(bsc.L, bsc.R);
      const sig = signalFor(dc);
      out.sig = sig;
      const model = E.buildModel(S.design, dc, sig.eg);
      out.model = model;
      // horns have fine ripple across a wide range: use more points
      const freqs = GL.util.logspace(S.signal.fmin, S.signal.fmax, E.isHorn(type) ? 560 : 320);
      const field = baffleField(out, model);
      out.res = GL.sweep(model, freqs, { volts: sig.V, drive: sig.per, vmax: S.signal.airLimit.on ? S.signal.airLimit.v : 0,
        field, angles: field ? S.baffle.angles.slice().sort((a, b) => a - b) : [] });
      beyondSmallSignal(out, dc, sig, freqs, field);
      out.summary = summarize(out, dc);
      out.warnings = warnings(out, dc);
    } catch (e) {
      console.error(e);
      out.error = e.message || String(e);
    }
    return out;
  }

  // Bandpass: -3 dB from the peak. Everything else: -3 dB from the driver's
  // ideal mass-controlled level (no Le), which is how WinISD reports F3.
  function f3(res, out) {
    // standing free: F3 of the box itself, before the baffle step takes its 6 dB
    const f = res.f, spl = res.splBox || res.spl;
    const n = f.length;
    const bp = E.isBandpass(S.design.type);
    let ref, i0 = 0;
    if (bp) {
      for (let i = 1; i < n; i++) if (spl[i] > spl[i0]) i0 = i;
      ref = spl[i0];
    } else if (out.hornLay) {
      // horns: -3 dB from the median level of the horn's working band
      const fc = out.model.hornCutoffs[0] || out.drvc.params.fs;
      const a = fc * 2, b = Math.min(f[n - 1], fc * 10);
      const band = [];
      for (let i = 0; i < n; i++) if (f[i] >= a && f[i] <= b) band.push(spl[i]);
      band.sort((x, y) => x - y);
      ref = band.length ? band[band.length >> 1] : spl[n - 1];
      while (i0 < n - 1 && f[i0] < a) i0++;
    } else {
      const N = S.design.count;
      const vPer = S.design.wiring === 'series' ? out.sig.V / N : out.sig.V;
      ref = out.drvc.derived.spl1w + 20 * Math.log10(N * vPer / Math.sqrt(out.drvc.model.Re));
      const fs = out.drvc.params.fs;
      while (i0 < n - 1 && f[i0] < fs * 3) i0++;
    }
    const cross = (from, step) => {
      for (let i = from; i >= 0 && i < n; i += step) {
        if (spl[i] < ref - 3) {
          const j = i - step;
          const t = (ref - 3 - spl[j]) / (spl[i] - spl[j]);
          return Math.exp(Math.log(f[j]) + t * (Math.log(f[i]) - Math.log(f[j])));
        }
      }
      return null;
    };
    return { low: cross(i0, -1), high: bp ? cross(i0, 1) : null, ref };
  }

  function summarize(out, dc) {
    const res = out.res, d = S.design, p = dc.params;
    const items = [];
    const f = f3(res, out);
    if (out.hornLay) {
      const hl = out.hornLay, fc = out.model.hornCutoffs[0];
      items.push(['Horn', fc ? fc.toFixed(0) + ' Hz cutoff' : 'conical', U.fmt('len', hl.length) + ' long · mouth ' + U.fmt('area', hl.mouth) +
        ' (' + Math.round(100 * hl.mouth / E.idealMouth(fc || p.fs, d.horn.space)) + '% of ideal)']);
      items.push(['Compression', (p.sd * d.count / hl.s1).toFixed(2) + ' : 1', 'cone area ÷ throat area']);
      if (d.chambers.length) items.push(['Chambers', d.chambers.map(c => U.fmt('dvol', c.vol)).join(' + '), d.chambers.map(c => c.name.toLowerCase()).join(', ')]);
    }
    if (!E.isBoxless(d.type)) {
      const net = d.chambers.reduce((s, c) => s + c.vol, 0);
      items.push(['Net volume', U.fmt('vol', net), d.chambers.length > 1 ? d.chambers.map(c => U.fmt('vol', c.vol)).join(' + ') : U.volBoth(net)]);
    }
    if (d.type === 'sealed') {
      const a = p.vas * d.count / (d.chambers[0].vol * GL.standing.effect(d.chambers[0].stuff).k);
      items.push(['Fc / Qtc', (p.fs * Math.sqrt(1 + a)).toFixed(1) + ' Hz', 'Qtc ' + (p.qts * Math.sqrt(1 + a)).toFixed(3)]);
    }
    const speed = (pt) => maxOf(res.portVel[out.model.ports.indexOf(pt)].v).toFixed(1) + ' m/s';
    const fullSpeed = (pt) => maxOf(res.portVel[out.model.ports.indexOf(pt)].full).toFixed(1) + ' m/s';
    for (const pt of out.model.ports) if (!pt.mouth) items.push([pt.label, pt.fb.toFixed(1) + ' Hz', fullSpeed(pt) + ' at full power']);
    for (const pr of out.model.prs) items.push(['PR tuning', pr.fb.toFixed(1) + ' Hz', 'added mass ' + (pr.cfg.added * 1000).toFixed(0) + ' g']);
    if (out.lineLay && S.design.type === 'mltl') {
      items.push(['Line alone', out.lineLay.quarter[0].toFixed(1) + ' Hz', 'open-ended quarter wave · air ' + U.fmt('vol', out.lineLay.air)]);
    } else if (out.lineLay) {
      const m = out.model.ports.find(pt => pt.mouth);
      items.push(['Quarter-wave', out.lineLay.quarter[0].toFixed(1) + ' Hz', 'mouth peak ' + speed(m) + ' · air ' + U.fmt('vol', out.lineLay.air)]);
    }
    items.push(['F3', f.low ? f.low.toFixed(1) + ' Hz' : '–', f.high ? 'upper ' + f.high.toFixed(0) + ' Hz' : res.splBox ? 'box alone, before the baffle step' : (out.hornLay ? 'from horn band ' : 'ref ') + f.ref.toFixed(1) + ' dB']);
    const xm = maxOf(res.xpk);
    items.push(['Peak excursion', xm.toFixed(1) + ' mm', 'Xmax ' + (dc.model.Xmax * 1000).toFixed(1) + ' mm']);
    items.push(['Input', out.sig.V.toFixed(2) + ' V', out.sig.W.toFixed(1) + ' W into ' + out.sig.znomTot.toFixed(2) + ' Ω']);
    if (out.layout) {
      const e = S.box.ext;
      items.push(['Outside', [e.W, e.H, e.D].map(v => U.fmt('len', v, U.system === 'imperial' ? 2 : 1).replace(/ \S+$/, '')).join(' × ') + ' ' + U.label('len'),
        U.fmt('vol', out.layout.extVol) + ' outside → ' + U.fmt('vol', out.layout.intVol) + ' inside']);
    }
    return items;
  }
  const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), 0);

  function warnings(out, dc) {
    const w = [];
    if (out.layout && out.layout.spare > out.layout.gross * 0.01) {
      const many = out.layout.chambers.length > 1;
      const list = out.layout.chambers.filter(c => c.spare > out.layout.gross * 0.005).map(c => (many ? c.name + ' ' : '') + U.fmt('vol', c.spare)).join(', ');
      w.push(['warn', `To fit the drivers (face or motor), the box holds more air than you set: ${list} extra. To keep the tuning, glue in a filler block of that much (Extra displacement on the chamber card), or raise the volume to use it.`]);
    }
    if (out.plan && out.layout) {
      const short = motorRoom(out.plan, S.box, out.layout).filter(m => m.have < m.need - 1e-3);
      if (short.length) {
        const m = short[0];
        w.push(['warn', `The driver's motor needs ${U.fmt('len', m.need)} behind its mounting face (its depth plus about ¾" to breathe) but ${m.front ? 'the box is only ' + U.fmt('len', m.have) + ' deep inside the baffle' : (m.chamber.name.toLowerCase() + ' is only ' + U.fmt('len', m.have) + ' long')}. ${m.front ? 'Unlock the depth so the box can grow' : 'Unlock the dimensions so the chamber can get longer, or try the other layout'}.${m.estimated ? ' (Depth estimated from the driver size: enter the mounting depth on the Driver tab for an exact check.)' : ''}`]);
      }
    }
    if (out.plan) {
      const tight = Object.values(out.plan.faces).concat(out.plan.dividers).filter(f => f.crowded && f.fit && f.fit.hasDriver);
      if (tight.length) w.push(['warn', `The ${tight.some(f => f.kind === 'divider') ? 'divider' : 'baffle'} is too small for the drivers${out.layout.chambers.length > 1 ? ', even with the box grown as far as the volumes and locks allow. Try the other layout (Enclosure tab, Layout)' : '. Unlock a dimension so the box can grow'}, or use fewer or smaller drivers.`]);
    }
    if (out.layout) {
      try {
        const flagged = standingWaves(out).flatMap(r => r.modes.filter(m => m.flag).map(m => (out.layout.chambers.length > 1 ? r.chamber.name.toLowerCase() + ' ' : '') + (m.f >= 1000 ? (m.f / 1000).toFixed(1) + ' kHz' : m.f.toFixed(0) + ' Hz')));
        if (flagged.length) w.push(['info', `Standing waves inside the box at ${flagged.slice(0, 4).join(', ')}${flagged.length > 4 ? ' and more' : ''} fall where the speaker plays, and nothing damps them. Add stuffing (chamber card, Enclosure tab); see Standing waves inside on the Build tab.`]);
      } catch (e) { /* layout not ready */ }
    }
    const bu = breakup();
    if (bu) {
      const top = S.signal.lp.on ? S.signal.lp.f : S.signal.fmax;
      const kh = (f) => f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : f.toFixed(0) + ' Hz';
      if (top > bu.f / 2) w.push([top > bu.f ? 'warn' : 'info', `Cone breakup peak near ${kh(bu.f)} (+${bu.db} dB) is ${top > bu.f ? 'inside' : 'close to'} the band it plays. Cross over (or low-pass) below about ${kh(bu.f / 2)}, an octave under it, or add a notch filter there.`]);
    }
    if (out.layout && S.box.sub && S.box.sub !== 'ply' && S.box.sub !== 'mdf' && S.box.sub !== 'birch') {
      try {
        const f0 = f3(out.res, out).low || S.signal.fmin, f1 = playTop();
        const ring = GL.panels.panelModes(S.box, out.layout, f0, f1).filter(p => p.rings);
        if (ring.length) w.push(['warn', `${ring.map(p => p.name).join(', ')}: the first panel resonance falls where the speaker plays, and ${GL.panels.SUBSTANCES[S.box.sub].name} barely damps it. See Panel resonance on the Build tab.`]);
      } catch (e) { /* layout not ready */ }
    }
    const res = out.res, d = S.design;
    const fAt = (arr, val) => res.f[arr.indexOf(val)];
    if (dc.model.Xmax > 0) {
      const xm = maxOf(res.xpk);
      if (xm > dc.model.Xmax * 1000) w.push(['warn', `Cone goes past Xmax (${xm.toFixed(1)} mm vs ${(dc.model.Xmax * 1000).toFixed(1)} mm) at ${fAt(res.xpk, xm).toFixed(0)} Hz with ${out.sig.V.toFixed(1)} V. A subsonic filter or less power will help.`]);
    }
    const fullW = dc.params.pe * S.design.count;
    out.model.ports.forEach((pt, i) => {
      const n = portNoise(out, i);
      const where = `at full power (${fullW.toFixed(0)} W, or Xmax if that comes first)`;
      if (n.vFull > n.lim.quiet) {
        let fix = pt.fix || (pt.mouth ? 'a larger mouth' : 'a bigger port');
        if (n.quiet) {
          const q = n.quiet;
          fix = 'a ' + (pt.cfg.shape === 'round' ? U.fmt('len', q.d) + ' diameter port' : U.fmt('len', q.w) + ' wide slot') +
            (pt.cfg.count > 1 ? ' (each of ' + pt.cfg.count + ')' : '') + ', about ' + U.fmt('len', q.len) + ' long at ' + pt.fb.toFixed(1) + ' Hz';
          if (!n.lim.flared) fix += ', or round over both ends to raise the limit';
        }
        if (n.vFull > n.lim.loud) w.push(['warn', `${pt.label}: ${n.vFull.toFixed(1)} m/s ${where} at ${n.fFull.toFixed(0)} Hz. Expect chuffing and port compression above ${n.lim.loud.toFixed(0)} m/s. To stay under the ${n.lim.quiet.toFixed(0)} m/s quiet guideline use ${fix}.`]);
        else w.push(['info', `${pt.label}: ${n.vFull.toFixed(1)} m/s ${where} at ${n.fFull.toFixed(0)} Hz, above the ${n.lim.quiet.toFixed(0)} m/s quiet guideline. Port noise may be heard on loud bass notes. Quiet size: ${fix}.`]);
      }
      // square folds shed eddies at the inside corners
      if (pt.cfg && pt.cfg.shape === 'slot' && out.plan) {
        const f = portFit(pt.cfg, out);
        if (f && f.route.bends && !f.route.rounded && n.vFull > 0.7 * n.lim.quiet) {
          w.push(['info', `${pt.label}: its folds have square inside corners and the air reaches ${n.vFull.toFixed(1)} m/s at full power. Round them over (port card) to keep the flow attached through the turns.`]);
        }
      }
      // a long port is also a pipe: its first half-wave resonance can honk
      if (pt.cfg && !pt.mouth) {
        const fp = pipeRes(pt.cfg);
        const lp = S.signal.lp.on ? S.signal.lp.f : 0;
        const near = lp ? fp < lp * 3 : fp < 150;
        if (near) w.push(['info', `${pt.label}: its own pipe resonance is about ${fp.toFixed(0)} Hz (half-wave along ${U.fmt('len', pt.cfg.len)}). The simulation treats the port as a lumped mass, so this peak isn't in the curves. ${lp ? 'With the low-pass at ' + lp.toFixed(0) + ' Hz it is only cut ' + ((+S.signal.lp.order === 2 ? 40 : 80) * Math.log10(fp / lp)).toFixed(0) + ' dB or so.' : 'Use a low-pass well below it.'} A little stuffing near the inner end, or a shorter port, tames it.`]);
      }
      if (pt.cfg && pt.cfg.short) {
        w.push(['warn', E.flareLen(pt.cfg) > 0
          ? `${pt.label}: too short for its flares at this tuning. Use smaller flares, a smaller port or a lower tuning.`
          : `${pt.label}: that tuning needs a negative length. Use a smaller port or lower the tuning.`]);
      }
    });
    out.model.prs.forEach((pr, i) => {
      const xm = maxOf(res.prX[i].x);
      if (pr.xmax > 0 && xm > pr.xmax * 1000) w.push(['warn', `${pr.label}: excursion ${xm.toFixed(1)} mm exceeds its Xmax of ${(pr.xmax * 1000).toFixed(1)} mm.`]);
    });
    if (out.layout) {
      const lay = out.layout;
      const P = out.plan;
      for (const pt of d.ports) {
        const c = lay.chambers.find(x => x.id === pt.from);
        if (!c) continue;
        const fit = portFit(pt, out);
        if (!fit) continue;
        const r = fit.route;
        if (!r.fits && r.noRoute) {
          w.push(['warn', `${pt.name}: no clear route in ${c.name.toLowerCase()}${r.via ? ' through ' + (lay.chambers.find(x => x.id === r.via) || {}).name.toLowerCase() : ''}. The driver or another port is in the way of every fold. A bigger box, or opening it on the other baffle, should free a path.`]);
        } else if (!r.fits && r.tooShort) {
          w.push(['warn', `${pt.name} is too short to run through ${(lay.chambers.find(x => x.id === r.via) || {}).name.toLowerCase()} and reach ${c.name.toLowerCase()}. Tune it lower, make the slot wider (both make it longer), or open it on its own baffle.`]);
        } else if (!r.fits) {
          const why = pt.bends === 'none' ? `doesn't fit straight in ${c.name.toLowerCase()}` : `doesn't fit in ${c.name.toLowerCase()}, even with bends`;
          w.push(['warn', `${pt.name} (${U.fmt('len', pt.len)}) ${why}${r.short > 0.0005 ? `: about ${U.fmt('len', r.short)} too long` : ''}. Its open end needs one port width of clear space. Give ${c.name.toLowerCase()} more room in that direction, use a smaller ${pt.shape === 'slot' ? 'slot' : 'port'} (shorter, but faster air), or tune higher.`]);
        }
        if (r.fits && r.movedFrom) {
          w.push(['info', `${pt.name} didn't fit against the ${r.movedFrom}, so it runs along the ${r.wall} instead. Pick another wall under "Against" on its port card to override.`]);
        }
        if (r.fits && r.bends) {
          w.push(['info', `${pt.name} is too long to run straight in ${c.name.toLowerCase()}, so it's routed with ${pt.shape === 'slot' ? (r.bends === 1 ? 'a fold along the ' + r.far : 'two folds' + (r.shape === 'U' ? ' (a U beside its first run)' : ' (wrapped around the chamber)')) : r.bends === 1 ? 'one 90° bend' : 'two 90° bends'}. See the 3D view and the Build tab.`]);
        }
      }
      if (P) {
        for (const id in P.faces) {
          const c = lay.chambers.find(x => x.id === id);
          if (P.faces[id].crowded) w.push(['warn', `The driver, ports and radiators don't fit side by side on the ${c ? c.name.toLowerCase() : ''} baffle. Make that face bigger, or use fewer or smaller ports.`]);
        }
        const said = new Set();
        for (const bi of P.braceIssues || []) {
          const key = bi.chamber + bi.kind + (bi.port || '');
          if (said.has(key)) continue;
          said.add(key);
          const cn = (lay.chambers.find(x => x.id === bi.chamber) || {}).name || '';
          const kind = (S.design.chambers.find(x => x.id === bi.chamber).braces || {}).kind === 'window' ? 'window brace' : 'dowel';
          if (bi.kind === 'port') w.push(['info', kind === 'dowel'
            ? `${bi.port} runs through a dowel in ${cn.toLowerCase()} and there was no clear spot for it. Use fewer dowels, run them the other way, or shorten one to stop at the port.`
            : `${bi.port} runs through the window brace in ${cn.toLowerCase()}. Notch the brace around the port (that's normal), or switch to dowels.`]);
          else w.push(['warn', `A ${kind} in ${cn.toLowerCase()} hits the driver. ${kind === 'window brace' ? 'Use a narrower frame, or fewer braces' : 'Use fewer dowels, or run them the other way'}${P.drv.estimated ? ' (the driver depth is estimated; enter its mounting depth on the Driver tab)' : ''}.`]);
        }
        for (const f of P.dividers) {
          if (f.crowded) w.push(['warn', `The driver and ports don't fit side by side on the divider. Make the box bigger across the divider, or use fewer or smaller ports.`]);
        }
        const room = S.box.ext.D - S.box.t;          // baffle face to back wall
        if (S.design.mount.front === 'out' && P.drv.depth > room) {
          w.push(['warn', `The driver is ${P.drv.estimated ? 'probably about ' : ''}${U.fmt('len', P.drv.depth)} deep, more than the box's ${U.fmt('len', room)} from baffle face to back wall.${P.drv.estimated ? ' (Depth estimated from its size; enter the real mounting depth on the Driver tab.)' : ''}`]);
        }
      }
      for (const c of lay.chambers) if (c.net <= 0.0002) w.push(['warn', `${c.name} is (almost) empty.`]);
    }
    return w;
  }

  // First half-wave resonance of the port as an open pipe.
  const pipeRes = (p) => GL.phys.c / (2 * (Math.max(p.len, E.flareLen(p)) + E.portEnd(p)));

  // Find the biggest port (same tuning) or the lowest tuning (same size) that
  // fits its chamber, settling box size, slot span and displacement each try.
  function fitPort(pt, mode) {
    const params = drvc().params;
    const keep = { ext: { ...S.box.ext }, ports: S.design.ports.map(p => ({ p, v: { len: p.len, fb: p.fb, h: p.h, w: p.w, d: p.d, short: p.short, holdFb: p.holdFb } })) };
    const restore = () => { Object.assign(S.box.ext, keep.ext); for (const { p, v } of keep.ports) Object.assign(p, v); };
    const fb0 = E.portFb(pt, chamberById(pt.from).vol);
    const key = pt.shape === 'slot' ? 'w' : 'd';
    const step = U.system === 'imperial' ? U.IN / 16 : 0.001;
    const fits = (x) => {
      restore();
      pt.holdFb = true;
      if (mode === 'size') { pt[key] = x; pt.fb = fb0; } else pt.fb = x;
      settlePorts(params);
      const plan = GL.placement.plan(S.design, S.box, G.layout(S.design, S.box), params);
      const r = plan.ports.filter(q => q.pt === pt);
      return r.length && r.every(q => q.route.fits) && !pt.short;
    };
    let best = null;
    if (mode === 'size') {
      // whole steps between a sensible minimum and the current size
      let lo = 1, hi = Math.floor(pt[key] / step);
      if (fits(lo * step)) {
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid * step)) lo = mid; else hi = mid; }
        best = lo * step;
      }
    } else {
      // too low = too long, far too high = no length left: scan up, then refine
      let lo = fb0, hi = null;
      for (let f = fb0 + 0.5; f <= fb0 * 3; f += 0.5) { if (fits(f)) { hi = f; break; } lo = f; }
      if (hi != null) {
        for (let i = 0; i < 12 && hi - lo > 0.05; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
        best = Math.ceil(hi * 10) / 10;
        if (!fits(best)) best = hi;
      }
    }
    restore();
    if (best == null) {
      toast(mode === 'size' ? 'No size of this port fits that chamber at this tuning.' : "Even tuned three times higher, this port won't fit.", true);
      return;
    }
    pt.holdFb = true;
    if (mode === 'size') { pt[key] = best; pt.fb = fb0; } else pt.fb = best;
    changed(true);
    toast(mode === 'size'
      ? (pt.shape === 'slot' ? 'Slot width ' : 'Diameter ') + U.fmt('len', best) + ', tuned to ' + fb0.toFixed(1) + ' Hz. Check the air speed: a smaller port runs faster.'
      : 'Tuned to ' + best.toFixed(1) + ' Hz so it fits. Check the response: higher tuning trades low extension for output.');
  }

  // Port air speed now and at full power, the noise limits for its shape, and
  // the smallest quiet size at the same tuning.
  function portNoise(out, i) {
    const pv = out.res.portVel[i], pt = out.model.ports[i];
    const vNow = maxOf(pv.v), vFull = maxOf(pv.full);
    const fFull = out.res.f[Array.prototype.indexOf.call(pv.full, vFull)];
    const lim = E.portSpeedLimits(pt.cfg);
    let quiet = null;
    if (pt.cfg && !pt.mouth && vFull > lim.quiet) {
      const ch = S.design.chambers.find(c => c.id === pt.cfg.from) || S.design.chambers.find(c => c.id === pt.cfg.to);
      if (ch) quiet = E.quietSize(pt.cfg, ch.vol, pt.fb, vFull, lim.quiet);
    }
    return { vNow, vFull, fFull, lim, quiet };
  }

  // Worst-placed copy of a port (fails first, then most bends).
  function portFit(pt, res = R) {
    if (!res || !res.plan) return null;
    const all = res.plan.ports.filter(x => x.pt === pt);
    if (!all.length) return null;
    all.sort((a, b) => (a.route.fits - b.route.fits) || (b.route.bends - a.route.bends));
    return all[0];
  }

  // ---------------------------------------------------------------- UI helpers
  function field(label, unit, toD, fromD, digits, get, set, o = {}) {
    const inp = h('input', { type: 'number', step: o.step || 'any', class: 'num', 'aria-label': label });
    // the arrows move by about a tenth of the value's size: 1.54 by 0.1, 0.54 by 0.01, 15 by 1
    const fitStep = () => {
      if (o.step) return;
      const x = Math.abs(parseFloat(inp.value));
      const st = isFinite(x) && x > 0 ? Math.max(Math.pow(10, -digits), Math.pow(10, Math.floor(Math.log10(x)) - 1)) : Math.pow(10, -Math.min(digits, 2));
      inp.step = String(+st.toPrecision(1));
      // a value that can't be zero or less stops one step above zero
      if (o.positive) inp.min = String(+st.toPrecision(1));
      else if (o.min != null) inp.min = String(toD(o.min));
    };
    const show = (force) => {
      if (!force && document.activeElement === inp) return;
      const v = get();
      inp.value = isFinite(v) ? String(+toD(v).toFixed(digits)) : '';
      fitStep();
    };
    show();
    live.push(() => show());
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      // not allowed (a negative volume, say): put the real value straight back
      if (!isFinite(v) || (o.positive && v <= 0) || (o.min != null && fromD(v) < o.min)) { show(true); return; }
      set(fromD(v));
      fitStep();
      changed(o.structural);
    });
    return h('label', { class: 'field', title: o.tip || null },
      h('span', { class: 'fl' }, label),
      h('span', { class: 'fi' }, inp, unit ? h('span', { class: 'fu' }, unit) : null));
  }
  function uf(label, kind, get, set, o = {}) {
    const s = U.spec(kind);
    return field(label, s.u, (v) => v / s.f, (v) => v * s.f, o.digits ?? s.d + 1, get, set, Object.assign({ positive: kind !== 'num' && kind !== 'db' }, o));
  }
  function nf(label, get, set, o = {}) { return field(label, o.unit || '', (v) => v, (v) => v, o.digits ?? 2, get, set, o); }
  function sel(label, options, get, set, o = {}) {
    const s = h('select', { 'aria-label': label, onchange: (e) => { set(e.target.value); changed(o.structural !== false); } },
      options.map(([v, t]) => h('option', { value: v }, t)));
    s.value = get();
    return h('label', { class: 'field' }, h('span', { class: 'fl' }, label), h('span', { class: 'fi' }, s));
  }
  function check(label, get, set, o = {}) {
    return h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: get(), onchange: (e) => { set(e.target.checked); changed(o.structural); } }), label);
  }
  function liveText(fn, cls) {
    const el = h('div', { class: cls || 'live' });
    const up = () => { try { el.textContent = fn(); } catch (e) { el.textContent = ''; } };
    up();
    live.push(up);
    return el;
  }
  const card = (title, ...kids) => h('section', { class: 'card' }, title ? h('h3', null, title) : null, ...kids);
  const btn = (text, onclick, cls) => h('button', { class: cls || 'btn', onclick }, text);

  // ---------------------------------------------------------------- side panel
  const TABS = [['driver', 'Driver'], ['enclosure', 'Enclosure'], ['optimize', 'Optimize'], ['compare', 'Compare'], ['array', 'Array'], ['build', 'Build'], ['signal', 'Signal'], ['tools', 'Tools']];

  function renderSide() {
    liveSide = [];
    const tabs = document.getElementById('tabs');
    tabs.innerHTML = '';
    for (const [id, t] of TABS) {
      tabs.append(h('button', { class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'aria-selected': S.tab === id ? 'true' : 'false',
        onclick: () => {
          S.tab = id;
          const v = { array: S.array.on || S.kind === 'array' ? 'line' : null, build: 'build', tools: 'room', optimize: optResults || matchRes ? 'results' : null }[id];
          renderSide();
          if (v && views().some(x => x[0] === v)) showView(v);
        } }, t));
    }
    const panel = document.getElementById('panel');
    panel.innerHTML = '';
    const fn = { driver: driverPanel, enclosure: enclosurePanel, optimize: optimizePanel, compare: () => [comparePanel(), measCard()], array: arrayPanel, build: buildPanel, signal: signalPanel, tools: toolsPanel }[S.tab];
    panel.append(...[].concat(fn()));
  }

  // ---------------------------------------------------------------- main area views
  // Settings live in the side panel; what you read (graphs, maps, tables) gets the main area.
  function views() {
    const boxed = S.design && !E.isBoxless(S.design.type) && !E.isLine(S.design.type) && !E.isHorn(S.design.type);
    const line = S.array.on || S.kind === 'array';
    return [['response', 'Response'], line ? ['line', 'Line array'] : ['3d', '3D view'],
      ['side', 'Side view'], ['polar', 'Polar'], ['coverage', 'Coverage'], ['distance', 'Level vs distance'],
      ['room', 'Room'],
      ...(boxed ? [['build', 'Build sheet']] : []),
      ...(optResults || matchRes ? [['results', 'Search results']] : [])];
  }
  function showView(v) { S.view = v; renderMainView(); saveWorkspace(); }
  function renderMainView() {
    const list = views();
    if (!list.some(x => x[0] === S.view)) S.view = 'response';
    const nav = document.getElementById('viewtabs');
    nav.innerHTML = '';
    for (const [id, t] of list) nav.append(h('button', { class: 'tab' + (S.view === id ? ' on' : ''), role: 'tab', 'aria-selected': S.view === id ? 'true' : 'false',
      onclick: () => showView(id) }, t));
    // Response: the chart alone; 3D view: the box alone; Line array: the box and the design's summary;
    // the plots: one each, full size; Room, Build sheet, Search results: one part at a time
    const own = S.view === 'response' || S.view === '3d' || S.view === 'line';
    const vw = document.querySelector('.views');
    vw.style.display = own ? '' : 'none';
    vw.classList.toggle('only-chart', S.view === 'response');
    vw.classList.toggle('only-3d', S.view === '3d' || S.view === 'line');
    vw.classList.toggle('with-sum', S.view === 'line');
    const sum = document.getElementById('arraysum');
    sum.hidden = S.view !== 'line';
    sum.innerHTML = '';
    const pane = document.getElementById('viewpane');
    pane.hidden = own;
    pane.innerHTML = '';
    liveMain = [];
    if (S.view === 'line') {
      buildingMain = true;
      try { sum.append(...[].concat(lineSummary())); } finally { buildingMain = false; }
      return;
    }
    if (own) return;
    buildingMain = true;
    try {
      const plot = { side: 0, polar: 1, coverage: 2, distance: 3 }[S.view];
      const cards = plot != null ? [arrayPanel('main')[plot]]
        : [].concat({ room: () => roomCard('main'), build: () => buildPanel('main'), results: resultsView }[S.view]()).filter(Boolean);
      const titles = cards.map(c => (c.querySelector('h3') || {}).textContent || '');
      S.sub = S.sub || {};
      let pick = titles.indexOf(S.sub[S.view]);
      if (pick < 0) pick = 0;
      if (cards.length > 1) {
        pane.append(h('nav', { class: 'subtabs', role: 'tablist', 'aria-label': 'Parts of this view' }, titles.map((t, i) => h('button', {
          class: 'subtab' + (i === pick ? ' on' : ''), role: 'tab', 'aria-selected': i === pick ? 'true' : 'false',
          onclick: () => { S.sub[S.view] = t; renderMainView(); saveWorkspace(); } }, t))));
      }
      cards[pick].classList.add('bigcard');
      pane.append(h('div', { class: 'viewgrid one view-' + S.view }, cards[pick]));
    } finally { buildingMain = false; }
  }
  // Optimizer results and drivers-for-this-box results, side by side.
  function resultsView() {
    const out = [];
    if (optResults) {
      const table = h('div', { class: 'voltable' });
      fillResults(table, optResults);
      out.push(card('Optimizer results', table,
        h('p', { class: 'hint' }, 'F3 is measured like the summary: box types against the driver\'s own passband level, bandpass against its peak (so its level can be higher). ' +
          'Ports are sized for the air-speed limit at full power. "Use" loads the design and sizes the box; check the port fit on the Enclosure tab.')));
    }
    if (matchRes) out.push(matchCard('main'));
    return out;
  }

  // ---------------------------------------------------------------- optimizer
  let optResults = null, optRunning = null, optBefore = null;
  const defaultOpt = () => ({ goal: 'small', target: 30, vmax: 2 * 0.0283168, alpha: 0.5, ripple: 2, top: 80, air: 25, portShape: 'slot',
    types: { sealed: true, ported: true, bp4: true } });
  function optimizePanel() {
    const o = (S.opt = Object.assign(defaultOpt(), S.opt || {}));
    const goal = o.goal;
    const status = h('div', { class: 'hint' }, optRunning ? 'Searching…' : '');
    const table = h('div', { class: 'voltable' });
    const runBtn = btn(optRunning ? 'Stop' : 'Find designs', () => {
      if (optRunning) { optRunning.stop = true; return; }
      startSearch(status, table, runBtn);
    }, 'btn primary');
    const setup = card('What to optimize for',
      h('p', { class: 'hint' }, 'Runs through enclosure types, volumes and tunings for ' + DRV.library.name(driver()) +
        (S.design.count > 1 ? ' (×' + S.design.count + (isoOn() ? ' isobaric pairs' : '') + ')' : isoOn() ? ' (isobaric pair)' : '') +
        ', simulates each one, and ranks them. Uses the driver count, wiring and isobaric setting from the Driver tab.'),
      h('div', { class: 'grid2' },
        sel('Goal', [['small', 'Smallest box that reaches the target F3'], ['deep', 'Deepest F3 within a box size'], ['blend', 'Blend of size and extension']],
          () => o.goal, (v) => { o.goal = v; }),
        goal !== 'deep' ? uf('Target F3', 'freq', () => o.target, (v) => { o.target = v; }, { structural: false }) : null,
        goal !== 'small' ? uf('Largest box (net)', 'vol', () => o.vmax, (v) => { o.vmax = v; }, { structural: false }) : null,
        goal === 'blend' ? nf('Weight on size (0 = extension, 1 = size)', () => o.alpha, (v) => { o.alpha = Math.min(1, Math.max(0, v)); }, { digits: 2, structural: false }) : null,
        nf('Allowed peaking', () => o.ripple, (v) => { o.ripple = Math.max(0, v); }, { unit: 'dB', digits: 1, structural: false, tip: 'How far the response may rise above its passband level' }),
        uf('Covers up to', 'freq', () => o.top, (v) => { o.top = v; }, { structural: false, tip: 'Top of the band it must play (your low-pass). Bandpass designs must reach it.' }),
        sel('Port', [['slot', 'Slot against a wall, full span'], ['round', 'Round tube']], () => o.portShape, (v) => { o.portShape = v; }, { structural: false }),
        check('Let slots run through the neighbouring chamber when that is the only way they fit', () => o.through !== false, (v) => { o.through = v; }, { structural: false }),
        sel('Port air speed at full power', [['17', 'Quiet (17 m/s)'], ['25', 'No chuffing (25 m/s)'], ['0', "Don't limit"]], () => String(o.air), (v) => { o.air = +v; }, { structural: false })),
      h('div', { class: 'checks' }, GL.optimize.TYPES.map(([k, name]) =>
        check(name, () => o.types[k] !== false, (v) => { o.types[k] = v; }, { structural: false }))),
      o.types.manifold !== false && (S.design.count < 2 || S.design.count % 2)
        ? h('p', { class: 'hint' }, 'Manifold designs need an even number of drivers (half on each side). Set the count on the Driver tab to include them.') : null,
      h('div', { class: 'btnrow' }, runBtn,
        optBefore ? btn('Back to the design before', () => { S.design = optBefore.design; S.box = optBefore.box; optBefore = null; changed(true); }, 'btn') : null),
      status);
    return [setup, optResults ? h('p', { class: 'hint' }, 'Results are in Search results, above the graphs.') : null, matchCard('side')].filter(Boolean);
  }

  // Optimizer finalist: build its box (1.25 : 1 : 0.9), settle slot spans
  // and through-chamber shares, round ports to buildable sizes, and route
  // them. If a port won't fit on its own baffle, try running it through the
  // neighbouring chamber (when allowed).
  function fitFinalist(c, dc, o) {
    const d = c.design;
    const keep = d.ports.map(pt => ({ d: pt.d, w: pt.w, h: pt.h, len: pt.len }));
    const vol = (pt) => d.chambers.find(x => x.id === pt.from).vol;
    const attempt = () => {
      d.ports.forEach((pt, i) => Object.assign(pt, keep[i]));
      const box = JSON.parse(JSON.stringify(S.box));
      box.lock = { W: false, H: false, D: false };
      box.minLen = {};                 // (the current design's chamber lengths don't apply)
      let lay, plan;
      const recheck = () => {
        lay = G.layout(d, box);
        G.applyRatio(box, lay.gross, lay.n, { W: 1.25, H: 1, D: 0.9 });
        lay = G.layout(d, box);
        plan = GL.placement.plan(d, box, lay, dc.params);
      };
      recheck();
      // full-span slots take the real span (same area, retuned); through-chamber
      // slots charge their real share of volume to each chamber
      for (let it = 0; it < 3; it++) {
        let moved = false;
        for (const x of plan.ports) {
          const pt = x.pt;
          if (pt.shape === 'slot' && pt.fullHeight && x.route.fullSpan > 0 && Math.abs(x.route.fullSpan - pt.h) > 1e-4) {
            const area = pt.w * pt.h;
            pt.h = x.route.fullSpan; pt.w = area / pt.h; pt.len = E.lenForFb(pt, vol(pt), pt.fb);
            moved = true;
          }
          if (x.route.via && Math.abs((pt.viaShare || 0) - x.route.viaShare) > 0.01) { pt.viaShare = x.route.viaShare; moved = true; }
        }
        if (!moved) break;
        recheck();
      }
      // buildable sizes: the next size up (slower air), else the next size down (shorter port)
      let vScale = 1;
      for (const pt of d.ports) {
        const key = pt.shape === 'slot' ? 'w' : 'd';
        const step = pt.shape === 'slot' ? (U.system === 'imperial' ? U.IN / 16 : 0.001) : (U.system === 'imperial' ? U.IN / 8 : 0.005);
        const x0 = pt[key], a0 = E.portArea(pt);
        // 2% length margin: the loaded design settles box and span slightly differently
        const tryX = (x) => {
          pt[key] = x;
          const len = E.lenForFb(pt, vol(pt), pt.fb);
          pt.len = len * 1.02; recheck();
          const ok = plan.ports.filter(q => q.pt === pt).every(q => q.route.fits);
          pt.len = len;
          return ok;
        };
        const up = Math.ceil(x0 / step - 1e-6) * step, down = Math.max(step, Math.floor(x0 / step + 1e-6) * step);
        if (!tryX(up)) tryX(down);
        vScale = Math.max(vScale, a0 / E.portArea(pt));
      }
      for (const pt of d.ports) pt.len *= 1.02;
      recheck();
      for (const pt of d.ports) pt.len /= 1.02;
      // drivers, ports and radiators must also fit side by side on every face
      // (with a quarter inch to spare: the loaded box settles a hair differently)
      const faces = Object.values(plan.faces).concat(plan.dividers, plan.walls || []);
      const crowded = faces.some(f => f.crowded || (f.slack != null && f.slack < 0.00635));
      return { fit: !crowded && plan.ports.every(x => x.route.fits), bends: Math.max(0, ...plan.ports.map(x => x.route.bends || 0)), vScale };
    };
    try {
      for (const pt of d.ports) { delete pt.via; delete pt.viaShare; }
      let r = attempt();
      let through = null;
      if (!r.fit && o.through !== false) {
        // slots venting out of a chamber that has a neighbour: try opening on the neighbour's baffle
        const order = d.chambers.map(ch => ch.id);
        for (const pt of d.ports.filter(q => q.shape === 'slot' && q.to === 'out')) {
          const i = order.indexOf(pt.from);
          for (const nb of [order[i - 1], order[i + 1]].filter(Boolean)) {
            pt.via = nb; delete pt.viaShare;
            const r2 = attempt();
            if (r2.fit) { r = r2; through = { port: pt.name, via: d.chambers.find(ch => ch.id === nb).name }; break; }
            delete pt.via; delete pt.viaShare;
          }
          if (through) break;
        }
        if (!through) r = attempt();          // back to the plain layout for the report
      }
      c.vFull *= r.vScale;
      if (o.air > 0 && c.vFull > o.air) { c.ok = false; c.why = c.why.concat('port air speed ' + c.vFull.toFixed(0) + ' m/s at a buildable size'); }
      c.ports = d.ports.map(pt => ({ d: pt.d, w: pt.w, shape: pt.shape, len: pt.len, name: pt.name }));
      c.through = through;
      return { fit: r.fit, bends: r.bends };
    } catch (e) { console.error(e); return {}; }
  }

  function startSearch(status, table, runBtn) {
    const o = S.opt;
    const types = GL.optimize.TYPES.map(t => t[0]).filter(k => o.types[k] !== false);
    if (!types.length) return toast('Pick at least one enclosure type.', true);
    const dc = drvc();
    const N = S.design.count, series = S.design.wiring === 'series';
    const volts = 2.83, per = series ? volts / N : volts;
    const job = { stop: false };
    optRunning = job;
    runBtn.textContent = 'Stop';
    const t0 = performance.now();
    GL.optimize.run({
      dc, count: N, wiring: S.design.wiring, iso: S.design.iso && S.design.iso.on ? { ...S.design.iso } : null,
      volts, per, vmaxAir: S.signal.airLimit.on ? S.signal.airLimit.v : 0,
      goal: o.goal, target: o.target, vmax: o.goal === 'small' ? 0 : o.vmax, alpha: o.alpha, ripple: o.ripple, top: o.top,
      portLimit: o.air, types, fs: dc.params.fs,
      refLevel: dc.derived.spl1w + 20 * Math.log10(N * per / Math.sqrt(dc.model.Re)),
      portShape: o.portShape,
      // real layout check: build the finalist's box and route its ports
      fitCheck: (c) => fitFinalist(c, dc, o),
      onProgress: (d, t) => { status.textContent = 'Searching… ' + d + ' of ' + t + ' designs'; },
      cancelled: () => job.stop,
    }).then(res => {
      optRunning = null;
      runBtn.textContent = 'Find designs';
      if (!res) { status.textContent = 'Stopped.'; return; }
      optResults = res;
      status.textContent = 'Checked ' + res.length + ' finalists in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s. The results are in Search results.';
      showView('results');
    }).catch(e => { optRunning = null; runBtn.textContent = 'Find designs'; status.textContent = 'Search failed: ' + e.message; console.error(e); });
  }

  function fillResults(table, res) {
    const o = S.opt;
    const name = (t) => (GL.optimize.TYPES.find(x => x[0] === t) || [t, t])[1];
    const vol = (c) => c.vols.length > 1 ? c.vols.map(v => U.fmt('vol', v)).join(' + ') : U.fmt('vol', c.net);
    const port = (c) => c.ports.length ? c.ports.map(p => (p.shape === 'slot' ? U.fmt('len', p.w) + ' slot' : U.fmt('len', p.d) + ' round') + ' × ' + U.fmt('len', p.len)).join(', ') : '–';
    const meets = (c) => c.ok && c.fit !== false && (o.goal === 'deep' || (c.f3 && c.f3 <= o.target)) && (o.goal === 'small' || c.net <= o.vmax * 1.001);
    table.innerHTML = '';
    table.append(h('table', null,
      h('thead', null, h('tr', null, ['', 'Type', 'Net volume', 'Tuning', 'F3', 'Level', 'Max SPL @ ' + o.target.toFixed(0) + ' Hz', 'Port (size × length)', ''].map(x => h('th', null, x)))),
      h('tbody', null, res.map((c, i) => h('tr', { class: meets(c) ? '' : 'miss' },
        h('td', null, meets(c) ? (i === 0 ? '★' : '✓') : '–'),
        h('th', null, name(c.type)),
        h('td', null, vol(c)),
        h('td', null, c.fbs.length ? c.fbs.map(f => f.toFixed(1) + ' Hz').join(', ') : '–'),
        h('td', null, c.f3 ? c.f3.toFixed(1) + ' Hz' + (c.high ? '–' + c.high.toFixed(0) : '') : '–'),
        h('td', null, c.ref.toFixed(1) + ' dB'),
        h('td', null, c.maxAt.toFixed(1) + ' dB'),
        h('td', null, port(c) + (c.fit === false ? " · won't fit even with two bends: try a slot port or a bigger box" : c.bends ? ' · fits with ' + c.bends + (c.bends > 1 ? ' bends' : ' bend') : '') +
          (c.through ? ' through ' + c.through.via.toLowerCase() : '') +
          (c.why.length ? ' · ' + c.why.join(', ') : '')),
        h('td', null, btn('Use', () => useCandidate(c), 'btn small')))))));
  }

  function useCandidate(c) {
    optBefore = { design: S.design, box: JSON.parse(JSON.stringify(S.box)) };
    const d = c.design;
    d.coilWiring = S.design.coilWiring;
    d.driverDisp = S.design.driverDisp;
    // sizes were already rounded to buildable steps by the fit check
    for (const pt of d.ports) pt.holdFb = true;
    S.design = d;
    S.box.minLen = {};
    const lay = G.layout(d, S.box);
    G.applyRatio(S.box, lay.gross, lay.n, { W: 1.25, H: 1, D: 0.9 });
    toast('Loaded: ' + E.typeName(c.type) + ', ' + U.fmt('vol', c.net) + ' net. Check the port fit on the Enclosure tab.');
    changed(true);
  }

  function driverPanel() {
    const lib = DRV.library;
    const d = driver();
    const opts = lib.list.map(x => [x.id, DRV.library.name(x) + (x.sample ? ' (sample)' : '')]);
    const fileIn = h('input', { type: 'file', multiple: true, accept: '.wdr,.txt,.json', style: { display: 'none' }, onchange: (e) => importFiles(e.target.files) });
    const pick = card('Driver',
      sel('Driver', opts, () => S.driverId, (v) => { S.driverId = v; S.design.driverDisp = driver().params.dvol || 0; }),
      h('div', { class: 'row-btns' },
        btn('Import…', () => fileIn.click()),
        btn('Paste specs…', () => openImport('')),
        btn('Browse catalogue…', () => openCatalogue()),
        btn('New', () => {
          const nd = JSON.parse(JSON.stringify(d));
          nd.id = GL.util.uid('drv'); nd.sample = false; nd.model = d.model + ' (copy)';
          lib.add(nd); S.driverId = nd.id; changed(true);
        }),
        btn('Export .wdr', () => GL.util.downloadText(DRV.library.name(d).replace(/[^\w.-]+/g, '_') + '.wdr', DRV.toWdr(d))),
        d.sample ? null : btn('Delete', () => {
          if (!confirm('Remove ' + DRV.library.name(d) + ' from your library?')) return;
          lib.remove(d.id); S.driverId = lib.list[0].id; changed(true);
        }, 'btn danger')),
      fileIn,
      h('p', { class: 'hint' }, 'Imports WinISD .wdr, Hornresp records and GetLow .json (or drop files on the window). Paste specs reads a copied spec table; Ctrl+V anywhere outside a text box works too.'),
      d.comment ? h('p', { class: 'hint' }, d.comment) : null);

    const dd = S.design;
    const iso = () => (dd.iso = dd.iso || { on: false, mode: 'clamshell', wiring: 'series' });
    const setup = card('Drivers in this design',
      dd.mount && dd.mount.rear2
        ? nf(isoOn() ? 'Isobaric pairs (total, half on each side)' : 'Drivers (total, half on each side)', () => dd.count, (v) => { const n = Math.max(2, Math.round(v)); dd.count = n + (n % 2); }, { digits: 0, min: 2, step: 2 })
        : nf(isoOn() ? 'Isobaric pairs' : 'Count', () => dd.count, (v) => { dd.count = Math.max(1, Math.round(v)); }, { digits: 0, min: 1 }),
      check('Isobaric (two drivers per position, working as one)', () => isoOn(), (v) => { iso().on = v; }, { structural: true }),
      isoOn() ? [
        h('div', { class: 'grid2' },
          sel('Mounting', [['clamshell', 'Clamshell (face to face, one outside)'], ['tunnel', 'Tunnel (one behind the other, inside)']], () => iso().mode, (v) => { iso().mode = v; }),
          sel('Pair wiring', [['series', 'Series'], ['parallel', 'Parallel']], () => iso().wiring, (v) => { iso().wiring = v; })),
        liveText(() => {
          const p = driver().params, m = drvc();
          return 'Each pair acts like one driver with Vas ' + U.fmt('vol', m.params.vas) + ' (half of ' + U.fmt('vol', p.vas) + '), Fs and Qts unchanged, Re ' +
            m.model.Re.toFixed(2) + ' Ω, ' + (m.params.pe).toFixed(0) + ' W. Same box tuning in about half the volume, for about 3 dB less sensitivity. ' +
            (iso().mode === 'clamshell' ? 'Wire the outer (reversed) driver with opposite polarity so both cones move together.' : 'The sleeve between the two is sealed and counted as displacement.');
        }, 'hint'),
      ] : null,
      sel('Wiring', [['parallel', 'Parallel'], ['series', 'Series']], () => dd.wiring, (v) => { dd.wiring = v; }, { structural: false }),
      uf('Displacement each', 'dvol', () => dd.driverDisp, (v) => { dd.driverDisp = v; }, { positive: false, min: 0, tip: 'Magnet + basket volume inside the box' }),
      d.vc ? [
        sel('Voice coils (dual coil)', [['series', 'Series'], ['parallel', 'Parallel']], () => coilWiring(), (v) => { dd.coilWiring = v; }),
        liveText(() => { const m = drvc().model; return 'Each driver: Re ' + m.Re.toFixed(2) + ' Ω, nominal ' + m.znom.toFixed(1) + ' Ω, BL ' + m.BL.toFixed(1) + ' T·m'; }, 'hint'),
      ] : null);
    const bookmark = card('Parts Express button', bookmarkletLink(),
      h('p', { class: 'hint' }, 'Drag the button above to your bookmarks bar. On a Parts Express product page (or most other spec pages), click it to send the specs here. ' +
        (/^https?:/.test(location.protocol) ? 'GetLow opens with the import ready.' : 'It copies them; then click into GetLow and press Ctrl+V.')),
      h('p', { class: 'hint' }, 'If you select part of a page first, only the selection is sent.'));

    const names = h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Brand'),
        h('span', { class: 'fi' }, h('input', { type: 'text', value: d.brand, onchange: (e) => { d.brand = e.target.value; lib.save(); changed(true); } }))),
      h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Model'),
        h('span', { class: 'fi' }, h('input', { type: 'text', value: d.model, onchange: (e) => { d.model = e.target.value; lib.save(); changed(true); } }))));
    const params = DRV.FIELDS.map(F => field(F.label, F.u, (v) => v / F.f, (v) => v * F.f, F.d + 1,
      () => d.params[F.k], (v) => {
        d.params[F.k] = v;
        if (F.k === 'qes' || F.k === 'qms') d.params.qts = NaN;   // re-derive
        if (F.k === 'dvol') S.design.driverDisp = v;
        lib.save();
      }, { tip: F.tip, positive: F.k !== 'le' && F.k !== 'dvol' }));
    // size, used to place the driver and route ports around it
    const save = () => lib.save();
    params.push(
      uf('Outside diameter', 'len', () => d.params.dia || NaN, (v) => { d.params.dia = v; save(); }, { tip: 'Frame diameter, for the 3D view and baffle layout' }),
      uf('Bolt circle', 'len', () => d.params.bolt || 0, (v) => { d.params.bolt = v; save(); }, { positive: false, min: 0, tip: 'Diameter of the circle the mounting screws sit on. 0 = estimate. Used for the pilot holes on the build sheet.' }),
      nf('Mounting holes', () => d.params.holes || 0, (v) => { d.params.holes = Math.max(0, Math.round(v)); save(); }, { digits: 0, positive: false, min: 0, tip: '0 = estimate (4 below 8", 8 from 8" up)' }),
      uf('Cutout diameter', 'len', () => d.params.cutout || 0, (v) => { d.params.cutout = v; save(); }, { positive: false, min: 0, tip: 'The hole in the baffle, from the datasheet. 0 = estimate (about 88% of the outside diameter). Used on the build sheet.' }),
      uf('Mounting depth', 'len', () => d.params.depth || 0, (v) => { d.params.depth = v; save(); }, { positive: false, min: 0, tip: 'From the mounting flange to the back of the magnet. 0 = estimate from the diameter. Used to keep bent ports clear of the motor.' }));
    let dc = null;
    try { dc = DRV.complete(d.params); } catch (e) { /* shown below */ }
    const derived = h('div', { class: 'kv' },
      DRV.DERIVED.map(F => [h('span', null, F.label), liveText(() => {
        const c = DRV.complete(d.params);
        const v = F.k in c.derived ? c.derived[F.k] : c.model[F.k];
        return (v / F.f).toFixed(F.d) + (F.u ? ' ' + F.u : '');
      }, 'kv-v')]));
    const vcNote = d.vc ? h('p', { class: 'hint' }, 'Dual voice coil. Values are as published (' +
      { series: 'coils in series', parallel: 'coils in parallel', single: 'one coil' }[d.vc.published] + '); each design picks its own coil wiring.') : null;
    return [pick, setup, card('Parameters', names, vcNote, h('div', { class: 'grid2' }, params),
      dc ? null : h('p', { class: 'warn' }, 'Need Fs, Qes, Qms, Vas, Sd and Re.'),
      h('h4', null, 'Derived'), derived,
      liveText(() => {
        // EBP = Fs / Qes: a quick read on which box suits the driver
        const c = DRV.complete(d.params);
        const ebp = c.derived.ebp, qts = c.derived.qts || c.params.qts;
        if (!isFinite(ebp)) return '';
        const box = ebp < 50 ? 'suits a sealed box' : ebp > 100 ? 'suits a ported box (or bandpass)' : 'works sealed or ported';
        const q = qts > 0.7 ? ' Qts ' + qts.toFixed(2) + ' is high: free-air or a large sealed box, or the box will boom.'
          : qts < 0.3 ? ' Qts ' + qts.toFixed(2) + ' is low: it wants a ported box or a horn, and rolls off early sealed.' : '';
        return 'EBP ' + ebp.toFixed(0) + ': ' + box + '. (Under about 50 leans sealed, over about 100 leans ported. It is a rule of thumb, so model both.)' + q;
      }, 'hint')), breakupCard(d), bookmark];
  }

  // ---------------------------------------------------------------- spec import
  // Review screen for pasted specs: shows how each value was read, converted
  // into both unit systems, with consistency checks re-run on every edit.
  function openImport(text, opt = {}) {
    const dlg = document.getElementById('importdlg');
    const SP = GL.specparse;
    let parsed = null, params = {}, pub = 'series';
    const ta = h('textarea', { class: 'paste', placeholder: 'Paste a spec table here (Ctrl+V)…', spellcheck: 'false' });
    ta.value = text || '';
    const brand = h('input', { type: 'text' }), model = h('input', { type: 'text' }), part = h('input', { type: 'text' });
    const review = h('div', { class: 'review' });
    const saveBtn = h('button', { class: 'btn primary' }, 'Add to library');

    const both = {
      vas: (v) => (v * 1000).toFixed(2) + ' L · ' + (v / U.FT3).toFixed(3) + ' ft³',
      dvol: (v) => (v * 1000).toFixed(3) + ' L · ' + (v / Math.pow(U.IN, 3)).toFixed(1) + ' in³',
      sd: (v) => (v * 1e4).toFixed(1) + ' cm² · ' + (v / (U.IN * U.IN)).toFixed(2) + ' in²',
      xmax: (v) => (v * 1000).toFixed(2) + ' mm · ' + (v / U.IN).toFixed(3) + ' in',
      dia: (v) => (v * 100).toFixed(2) + ' cm · ' + (v / U.IN).toFixed(2) + ' in',
      depth: (v) => (v * 100).toFixed(2) + ' cm · ' + (v / U.IN).toFixed(2) + ' in',
    };
    const ROWS = DRV.FIELDS.concat([
      { k: 'qts', label: 'Qts', u: '', f: 1, d: 3 }, { k: 'BL', label: 'BL', u: 'T·m', f: 1, d: 2 },
      { k: 'Mms', label: 'Mms', u: 'g', f: 0.001, d: 1 }, { k: 'Cms', label: 'Cms', u: 'mm/N', f: 0.001, d: 3 },
      { k: 'dia', label: 'Outside dia.', u: 'cm', f: 0.01, d: 2 },
      { k: 'depth', label: 'Mounting depth', u: 'cm', f: 0.01, d: 2 },
    ]);

    const parse = () => {
      parsed = SP.parse(ta.value);
      params = Object.assign({}, parsed.params);
      brand.value = parsed.meta.brand; model.value = parsed.meta.model; part.value = parsed.meta.part;
      pub = parsed.dvc ? parsed.dvc.published : 'series';
      draw();
    };
    const draw = () => {
      review.innerHTML = '';
      if (!ta.value.trim()) { review.append(h('p', { class: 'hint' }, 'Nothing pasted yet.')); saveBtn.disabled = true; return; }
      const rows = ROWS.filter(R => parsed.fields[R.k] || isFinite(params[R.k])).map(R => {
        const f = parsed.fields[R.k];
        const inp = h('input', { type: 'number', step: 'any', class: 'num' });
        inp.value = isFinite(params[R.k]) ? String(+(params[R.k] / R.f).toFixed(R.d + 2)) : '';
        const conv = h('td', { class: 'conv' }, both[R.k] && isFinite(params[R.k]) ? both[R.k](params[R.k]) : '');
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          if (isFinite(v)) params[R.k] = v * R.f; else delete params[R.k];
          if (R.k === 'dvol') delete params.dvolEstimated;
          drawChecks();
          conv.textContent = both[R.k] && isFinite(params[R.k]) ? both[R.k](params[R.k]) : '';
        });
        const src = f ? f.label + ': ' + f.raw : (R.k === 'dvol' && params.dvolEstimated ? 'estimated' : '');
        return h('tr', { class: f && f.guessed ? 'guessed' : '' },
          h('th', null, R.label), h('td', { class: 'src', title: src }, src, f && f.guessed ? h('em', null, ' unit guessed') : null),
          h('td', null, h('span', { class: 'fi' }, inp, h('span', { class: 'fu' }, R.u))), conv);
      });
      review.append(h('table', { class: 'imp' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Read from'), h('th', null, 'Value'), h('th', null, 'Both systems'))),
        h('tbody', null, rows)));
      if (parsed.dvc) {
        const s = h('select', { onchange: (e) => { pub = e.target.value; } },
          [['series', 'Both coils in series'], ['parallel', 'Both coils in parallel'], ['single', 'One coil']].map(([v, t]) => h('option', { value: v }, t)));
        s.value = pub;
        review.append(h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Published specs are for'), h('span', { class: 'fi' }, s)));
      }
      review.append(checksEl);
      drawChecks();
    };
    const checksEl = h('div', { class: 'warnings' });
    const drawChecks = () => {
      checksEl.innerHTML = '';
      const notes = parsed.parseNotes.concat(SP.check(params));
      for (const [lvl, t] of notes) checksEl.append(h('div', { class: 'w ' + lvl }, h('span', { class: 'ic' }, lvl === 'warn' ? '!' : 'i'), t));
      let ok = true;
      try { DRV.complete(params); } catch (e) { ok = false; }
      saveBtn.disabled = !ok;
    };

    saveBtn.onclick = () => {
      const lib = DRV.library;
      const meta = parsed.meta;
      const d = {
        id: GL.util.uid('drv'), brand: brand.value.trim(), model: model.value.trim() || 'Pasted driver',
        comment: [part.value ? 'Part # ' + part.value.trim() : '', meta.source].filter(Boolean).join(' · '),
        source: 'Pasted specs', params,
      };
      if (parsed.dvc) d.vc = { coils: 2, published: pub, perCoil: parsed.dvc.perCoil };
      const same = lib.list.find(x => !x.sample && lib.name(x).toLowerCase() === lib.name(d).toLowerCase());
      if (same) {
        if (!confirm(lib.name(d) + ' is already in your library. Replace its specs?')) return;
        Object.assign(same, { params: d.params, comment: d.comment, vc: d.vc, source: d.source });
        lib.save();
      } else {
        lib.add(d);
      }
      const added = same || d;
      dlg.close();
      const note = params.dvolEstimated ? ' (displacement estimated, check it)' : '';
      // from the new-project dialog, or with no project open, it only goes into the library
      if (opt.onAdded) { opt.onAdded(added); toast('Added ' + lib.name(added) + note); return; }
      if (!hasProject()) { toast('Added ' + lib.name(added) + ' to your drivers' + note + '. Start a new project and search for it.'); return; }
      S.driverId = added.id;
      S.design.driverDisp = params.dvol || 0;
      changed(true);
      toast('Added ' + lib.name(added) + note);
    };

    ta.addEventListener('input', parse);
    dlg.innerHTML = '';
    dlg.append(
      h('div', { class: 'dlg-head' }, h('h3', null, 'Import driver specs'), h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Close')),
      h('p', { class: 'hint' }, 'Paste a spec table from Parts Express or a maker\'s datasheet. Metric and imperial units are both understood; check the values before adding.'),
      ta,
      h('div', { class: 'grid3' },
        h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Brand'), h('span', { class: 'fi' }, brand)),
        h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Model'), h('span', { class: 'fi' }, model)),
        h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Part #'), h('span', { class: 'fi' }, part))),
      review,
      h('div', { class: 'row-btns end' }, saveBtn));
    parse();
    if (!dlg.open) dlg.showModal();
    if (!text) ta.focus();
  }

  // The bookmark: reads two-column spec tables (or the user's selection) on
  // the page it is clicked on, then hands them to GetLow.
  function bookmarkletLink() {
    const home = location.href.split('#')[0];
    const code = `(function(){var G=${JSON.stringify(home)};var o=['GetLow specs','Source: '+location.href.split('?')[0]];` +
      `var h=document.querySelector('h1');if(h)o.push('Title: '+h.innerText.trim());var seen={},n=0;` +
      `function add(k,v){k=k.replace(/\\s+/g,' ').trim();v=v.replace(/\\s+/g,' ').trim();if(!k||!v||k.length>90||v.length>90)return;` +
      `if(seen[k+'|'+v])return;seen[k+'|'+v]=1;n++;o.push(k+'\\t'+v);}` +
      `var s=String(window.getSelection()).trim();if(s.length>20){o.push(s);n=s.split('\\n').length;}else{` +
      `document.querySelectorAll('tr').forEach(function(r){var c=r.querySelectorAll('th,td');if(c.length===2)add(c[0].innerText,c[1].innerText);});` +
      `document.querySelectorAll('dt').forEach(function(d){var e=d.nextElementSibling;if(e&&e.tagName==='DD')add(d.innerText,e.innerText);});` +
      // grid layouts: an element whose two children are a short label and a short value
      `document.querySelectorAll('div,li,p,span').forEach(function(x){var c=x.children;if(c.length===2&&!c[0].children.length&&!c[1].children.length){var a=c[0].innerText||'',b=c[1].innerText||'';if(a.length<40&&b.length<40&&/\d/.test(b)&&!/\d/.test(a.replace(/\(.*?\)/g,'')))add(a,b);}});` +
      // still little found: send the page text and let GetLow pick out the values
      `if(n<6){var m=document.querySelector('main,article,[role=main]')||document.body;var tx=m.innerText.split('\n').map(function(l){return l.trim();}).filter(function(l){return l&&l.length<120;}).join('\n').slice(0,6000);o.push(tx);n+=tx.split('\n').length;}}` +
      `if(!n){alert('GetLow: no specs found. Select the specs on the page and click again.');return;}` +
      `var t=o.join('\\n');var a=document.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();` +
      `try{document.execCommand('copy');}catch(e){}a.remove();` +
      `if(/^https?:/.test(G)){window.open(G+'#specs='+encodeURIComponent(t),'getlow');}` +
      `else{alert('GetLow: copied '+n+' rows. Switch to GetLow and press Ctrl+V.');}})();`;
    return h('a', {
      class: 'bookmarklet', href: 'javascript:' + encodeURIComponent(code), draggable: 'true',
      onclick: (e) => { e.preventDefault(); toast('Drag this button to your bookmarks bar, then click it on a product page.'); },
    }, '⇪ Send to GetLow');
  }


  // ---------------------------------------------------------------- driver catalogue
  // OpenISD's catalogue (data/catalogue.js, built by tools/build-catalogue.py),
  // loaded on first use. With { pr } it picks a passive radiator for that PR.
  const loadScript = (src) => new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = src;
    sc.onload = ok;
    sc.onerror = () => fail(new Error(src + ' not found'));
    document.head.append(sc);
  });
  let catReady = null;
  function loadCatalogue() {
    if (catReady) return catReady;
    catReady = loadScript('data/catalogue.js')
      .then(() => { if (!GL.catalogue) throw new Error('catalogue file is empty'); })
      // optional: Parts Express drivers OpenISD lacks (built locally by tools/build-pe-extra.py)
      .then(() => loadScript('data/catalogue-pe.js').catch(() => null))
      .then(() => { GL.catalogueTools.mergePartsExpress(GL.catalogue, GL.catalogueExtra); return GL.catalogue; })
      .catch(e => { catReady = null; throw new Error(e.message + ' (run tools/build-catalogue.py)'); });
    return catReady;
  }

  const CAT_TYPES = [['', 'All types'], ['sub', 'Subwoofers'], ['bass', 'Woofers / bass'], ['mid', 'Midrange / midbass'], ['fullrange', 'Full-range'], ['coax', 'Coaxial']];
  let catState = { q: '', type: 'sub', size: '', hideOld: true, sort: 'name' };

  function openCatalogue(opt = {}) {
    const dlg = document.getElementById('importdlg');
    const forPr = !!opt.pr;
    dlg.innerHTML = '';
    const close = () => dlg.close();
    const status = h('p', { class: 'hint' }, 'Loading the catalogue…');
    const list = h('div', { class: 'voltable catlist' });
    dlg.append(h('div', { class: 'dlg-head' }, h('h3', null, forPr ? 'Passive radiator catalogue' : 'Driver catalogue'), btn('Close', close, 'btn ghost')), status, list);
    if (!dlg.open) dlg.showModal();
    loadCatalogue().then(cat => {
      status.textContent = '';
      status.append('From the ', h('a', { href: 'https://github.com/Johnlon/openisd', target: '_blank', rel: 'noopener' }, 'OpenISD'),
        ' catalogue (' + (forPr ? cat.prs.length + ' passive radiators' : (cat.drivers.length - (cat.pe ? cat.pe.kept : 0)) + ' drivers') + ', built ' + cat.built + ', MIT licence). ' +
        (!forPr && cat.pe ? 'Plus ' + cat.pe.kept + ' Parts Express drivers it lacks, read from product pages scraped ' + cat.pe.scraped +
          ' (' + cat.pe.fixed + ' with a unit slip or rounded Vas corrected from Sd and Cms, ' + cat.pe.skipped.length + ' left out because their numbers don\'t add up). ' : '') +
        'Check the datasheet or product page before you build.');
      const q = h('input', { type: 'search', placeholder: 'Search brand, model or description', value: catState.q, 'aria-label': 'Search' });
      const typeSel = h('select', { 'aria-label': 'Type' }, CAT_TYPES.map(([v, t]) => h('option', { value: v }, t)));
      typeSel.value = catState.type;
      const sizes = [...new Set(cat.drivers.map(d => d.size).filter(Boolean))].sort((a, b) => a - b);
      const sizeSel = h('select', { 'aria-label': 'Size' }, [h('option', { value: '' }, 'Any size')].concat(sizes.map(x => h('option', { value: x }, x + '"'))));
      sizeSel.value = catState.size;
      const sortSel = h('select', { 'aria-label': 'Sort' }, [['name', 'Sort by name'], ['fs', 'Lowest Fs'], ['xmax', 'Most Xmax'], ['vd', 'Most Vd (Sd × Xmax)'], ['vas', 'Smallest Vas']].map(([v, t]) => h('option', { value: v }, t)));
      sortSel.value = catState.sort;
      const old = h('input', { type: 'checkbox', checked: catState.hideOld });
      const controls = forPr
        ? h('div', { class: 'catbar' }, q)
        : h('div', { class: 'catbar' }, q, typeSel, sizeSel, sortSel, h('label', { class: 'check' }, old, 'Hide discontinued'));
      dlg.insertBefore(controls, list);
      const draw = () => {
        catState = { q: q.value, type: typeSel.value, size: sizeSel.value, hideOld: old.checked, sort: sortSel.value };
        const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
        const hay = (d) => (d.brand + ' ' + d.model + ' ' + (d.desc || '') + ' ' + d.id).toLowerCase();
        let rows = (forPr ? cat.prs : cat.drivers).filter(d => words.every(w => hay(d).includes(w)));
        if (!forPr) {
          rows = rows.filter(d => (!catState.type || (d.types || []).includes(catState.type)) && (!catState.size || String(d.size) === catState.size) && (!catState.hideOld || !d.disc));
          const P = (d, k) => d.p[k] || 0;
          const by = { name: (a, b) => (a.brand + a.model).localeCompare(b.brand + b.model), fs: (a, b) => P(a, 'fs') - P(b, 'fs'),
            xmax: (a, b) => P(b, 'xmax') - P(a, 'xmax'), vd: (a, b) => P(b, 'xmax') * P(b, 'sd') - P(a, 'xmax') * P(a, 'sd'), vas: (a, b) => P(a, 'vas') - P(b, 'vas') }[catState.sort];
          rows.sort(by);
        }
        const shown = rows.slice(0, 150);
        list.innerHTML = '';
        const cell = (v) => h('td', null, v);
        const qts = (p) => p.qts || (p.qes && p.qms ? 1 / (1 / p.qes + 1 / p.qms) : NaN);
        list.append(
          h('p', { class: 'hint' }, rows.length + ' match' + (rows.length === 1 ? '' : 'es') + (rows.length > shown.length ? ', showing the first ' + shown.length + ' (narrow the search)' : '')),
          h('table', null,
            h('thead', null, h('tr', null, (forPr ? ['Radiator', 'Fs', 'Sd', 'Vas', 'Xmax', ''] : ['Driver', 'Size', 'Fs', 'Qts', 'Vas', 'Xmax', 'Pe', 'Re', '']).map(x => h('th', null, x)))),
            h('tbody', null, shown.map(d => {
              const p = d.p;
              const name = h('th', null, d.brand + ' ' + d.model, d.vc ? h('span', { class: 'tag' }, 'DVC') : null, d.disc ? h('span', { class: 'tag' }, 'discontinued') : null,
                d.src === 'pe' ? h('span', { class: 'tag', title: 'Read from the Parts Express product page' + (d.fixedVas ? ' (Vas or Sd corrected: the page values did not agree with each other)' : '') }, 'PE' + (d.price ? ' $' + d.price.toFixed(2) : '')) : null,
                d.sdEst ? h('span', { class: 'tag', title: 'The product page has no Sd; estimated from the frame diameter' }, 'Sd estimated') : null,
                d.page ? h('a', { href: d.page, target: '_blank', rel: 'noopener', class: 'catlink', title: 'Product page' }, '↗') : null);
              const use = btn(forPr ? 'Use' : 'Add', () => forPr ? usePr(opt.pr, d) : addFromCatalogue(d), 'btn small');
              return forPr
                ? h('tr', null, name, cell(p.fs ? p.fs.toFixed(1) + ' Hz' : '–'), cell(U.fmt('area', p.sd)), cell(p.vas ? U.fmt('vol', p.vas) : '–'), cell(p.xmax ? (p.xmax * 1000).toFixed(1) + ' mm' : '–'), h('td', null, use))
                : h('tr', null, name, cell(d.size ? d.size + '"' : '–'), cell(p.fs.toFixed(1) + ' Hz'), cell(qts(p).toFixed(2)), cell(U.fmt('vol', p.vas)),
                  cell(p.xmax ? (p.xmax * 1000).toFixed(1) + ' mm' : '–'), cell(p.pe ? p.pe.toFixed(0) + ' W' : '–'), cell(p.re.toFixed(1) + ' Ω'), h('td', null, use));
            }))));
      };
      [q, typeSel, sizeSel, sortSel, old].forEach(el => el.addEventListener(el === q ? 'input' : 'change', draw));
      draw();
      q.focus();
    }).catch(e => { status.textContent = 'Could not load the catalogue: ' + e.message; });
  }

  // A catalogue record as a library driver (added once; found again by name or id).
  function catalogueToLibrary(c) {
    const lib = DRV.library;
    const name = (c.brand + ' ' + c.model).toLowerCase();
    const have = lib.list.find(x => !x.sample && (x.catalogueId === c.id || lib.name(x).toLowerCase() === name));
    if (have) return have;
    const params = Object.assign({}, c.p);
    if (!params.dvol && params.dia && params.depth) { params.dvol = Math.PI * (params.dia / 2) ** 2 * params.depth / 3; params.dvolEstimated = true; }
    const est = c.sdEst ? 'Sd estimated from the frame size (not on the product page)' : '';
    const box = c.peBox ? 'Parts Express suggests ' + Object.entries(c.peBox).map(([k, v]) => k + ' ' + v).join(', ') : '';
    return lib.add({ id: GL.util.uid('drv'), brand: c.brand, model: c.model, comment: [c.desc, c.pn ? 'Part # ' + c.pn : '', est, box, c.page].filter(Boolean).join(' · '),
      source: c.src === 'pe' ? 'Parts Express page (scraped ' + (GL.catalogue.pe ? GL.catalogue.pe.scraped : '') + ')' : 'OpenISD catalogue',
      catalogueId: c.id, page: c.page, sheet: c.sheet, params, vc: c.vc });
  }

  function addFromCatalogue(c) {
    const lib = DRV.library;
    const params = Object.assign({}, c.p);
    // no displacement listed: estimate it as a cone from the frame size and depth
    if (!params.dvol && params.dia && params.depth) { params.dvol = Math.PI * (params.dia / 2) ** 2 * params.depth / 3; params.dvolEstimated = true; }
    const name = (c.brand + ' ' + c.model).toLowerCase();
    let d = lib.list.find(x => !x.sample && (x.catalogueId === c.id || lib.name(x).toLowerCase() === name));
    if (d) {
      toast(lib.name(d) + ' is already in your library; selected it.');
    } else {
      const est = c.sdEst ? 'Sd estimated from the frame size (not on the product page)' : '';
      const box = c.peBox ? 'Parts Express suggests ' + Object.entries(c.peBox).map(([k, v]) => k + ' ' + v).join(', ') : '';
      d = lib.add({ id: GL.util.uid('drv'), brand: c.brand, model: c.model, comment: [c.desc, c.pn ? 'Part # ' + c.pn : '', est, box, c.page].filter(Boolean).join(' · '),
        source: c.src === 'pe' ? 'Parts Express page (scraped ' + (GL.catalogue.pe ? GL.catalogue.pe.scraped : '') + ')' : 'OpenISD catalogue',
        catalogueId: c.id, page: c.page, sheet: c.sheet, params, vc: c.vc });
      toast('Added ' + lib.name(d) + (params.dvolEstimated ? ' (displacement estimated from its size)' : ''));
    }
    S.driverId = d.id;
    S.design.driverDisp = d.params.dvol || 0;
    document.getElementById('importdlg').close();
    changed(true);
  }

  // Fill a passive radiator from a catalogue record (fills in Fs/Vas from Mms and Cms when needed).
  function usePr(pr, c) {
    const p = c.p, ph = GL.phys;
    const fs = p.fs || (p.Mms && p.Cms ? 1 / (2 * Math.PI * Math.sqrt(p.Mms * p.Cms)) : pr.fs);
    const vas = p.vas || (p.Cms ? ph.rho * ph.c * ph.c * p.sd * p.sd * p.Cms : pr.vas);
    Object.assign(pr, { fs, vas, sd: p.sd, qms: p.qms || pr.qms || 8, xmax: p.xmax || pr.xmax, catalogue: c.brand + ' ' + c.model });
    document.getElementById('importdlg').close();
    toast('Passive radiator set to ' + c.brand + ' ' + c.model + (p.qms ? '' : ' (Qms not listed; kept ' + pr.qms + ')') + '. Retune with "Set added mass".');
    changed(true);
  }

  // Specs arriving by paste (anywhere outside a text field) or by the bookmark (#specs=...)
  function bindImport() {
    document.addEventListener('paste', (e) => {
      if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text) return;
      if (/^GetLow specs/i.test(text) || GL.specparse.parse(text).count >= 4) {
        e.preventDefault();
        // pasted while picking a driver for a new project: add it and pick it there
        const nd = document.getElementById('newdlg');
        openImport(text, nd.open && nd._onAdded ? { onAdded: nd._onAdded } : {});
      }
    });
    const fromHash = () => {
      const m = location.hash.match(/^#specs=(.*)$/s);
      if (!m) return;
      history.replaceState(null, '', location.pathname + location.search);
      try { openImport(decodeURIComponent(m[1])); } catch (e) { toast('Could not read the specs from the bookmark.', true); }
    };
    window.addEventListener('hashchange', fromHash);
    fromHash();
    // a driver added in another GetLow tab shows up here too
    window.addEventListener('storage', (e) => {
      if (e.key && e.key.startsWith('getlow.drivers')) { DRV.library.load(); renderSide(); }
    });
  }

  // dropped files: measurements (by extension, or a .txt/.csv that is a table of numbers) or drivers
  async function dropFiles(files) {
    const meas = [], rest = [];
    for (const f of files) {
      if (/\.(frd|zma)$/i.test(f.name)) meas.push(f);
      else if (/\.(txt|csv)$/i.test(f.name) && hasProject() && GL.frd.looksLike(await GL.util.readFileText(f))) meas.push(f);
      else rest.push(f);
    }
    if (meas.length) {
      if (!hasProject()) toast('Open or start a project first: measurements are kept with a project.', true);
      else importMeasurements(meas);
    }
    if (rest.length) importFiles(rest);
  }
  async function importFiles(files, opt = {}) {
    const done = [], bad = [];
    for (const f of files) {
      try {
        const d = DRV.parseDriverFile(f.name, await GL.util.readFileText(f));
        DRV.complete(d.params);
        DRV.library.add(d);
        done.push(d);
      } catch (e) {
        try {
          const o = JSON.parse(await GL.util.readFileText(f));
          if (o.app === 'GetLow') { addProject(o); toast('Opened project ' + S.name + ' in a new tab'); continue; }
        } catch (e2) { /* not a project */ }
        bad.push(f.name + ': ' + e.message);
      }
    }
    const names = done.map(d => DRV.library.name(d)).join(', ');
    if (opt.onAdded || !hasProject()) {
      if (done.length) {
        if (opt.onAdded) opt.onAdded(done[done.length - 1]);
        toast('Imported ' + names + (opt.onAdded ? '' : ' to your drivers. Start a new project and search for it.'));
      }
    } else {
      if (done.length) { S.driverId = done[done.length - 1].id; S.design.driverDisp = driver().params.dvol || 0; }
      changed(true);
      if (done.length) toast('Imported ' + names);
    }
    if (bad.length) toast('Could not read ' + bad.join('; '), true);
  }

  function enclosurePanel() {
    const d = S.design;
    const out = [];
    out.push(card('Type',
      sel('Enclosure', E.TYPES.map(t => [t.id, t.name]), () => d.type, (v) => newDesign(v)),
      h('p', { class: 'hint' }, E.describe(d)),
      h('div', { class: 'row-btns' }, btn('Reset to suggested start', () => { newDesign(d.type, { reset: true }); changed(true); })),
      h('p', { class: 'hint' }, 'Changing the type keeps this box and fills it. "Reset to suggested start" goes back to the suggested volume, keeping any dimensions that are locked.')));

    if (d.type === 'sealed') {
      let qtc = 0.707;
      out.push(card('Alignment',
        nf('Target Qtc', () => qtc, (v) => { qtc = v; }, { digits: 3 }),
        btn('Size box for this Qtc', () => {
          const p = drvc().params;
          if (qtc <= p.qts) return toast('Qtc must be above the driver Qts (' + p.qts.toFixed(3) + ')', true);
          d.chambers[0].vol = p.vas * d.count / (Math.pow(qtc / p.qts, 2) - 1);
          changed(true);
        })));
    }
    if (d.type === 'ported') {
      out.push(card('Alignment', btn('Apply QB3 alignment', () => {
        const p = drvc().params;
        d.chambers[0].vol = 15 * Math.pow(p.qts, 2.87) * p.vas * d.count;
        d.ports[0].fb = 0.42 * p.fs * Math.pow(p.qts, -0.9);
        changed(true);
      }), h('p', { class: 'hint' }, 'Keele\'s QB3 formulas: Vb = 15·Qts^2.87·Vas, Fb = 0.42·Fs·Qts^-0.9. Best for Qts ≈ 0.2–0.5.')));
    }

    const horn = E.isHorn(d.type);
    if (d.mount.rear2) {
      out.push(card('Manifold layout',
        h('p', { class: 'hint' }, 'The drivers face each other across the middle chamber, half on each divider, each side with its own sealed rear chamber. ' +
          'The middle chamber vents out through the port. Acoustically this is a 4th-order bandpass with all the drivers in parallel; the facing drivers cancel each other\'s vibration, ' +
          'and the layout keeps the middle chamber small and the cut list symmetrical.'),
        liveText(() => 'Rear total ' + U.fmt('vol', chamberById(d.mount.rear).vol * 2) + ' (two × ' + U.fmt('vol', chamberById(d.mount.rear).vol) + '), manifold ' + U.fmt('vol', chamberById(d.mount.front).vol) + ', ' + d.count + ' drivers (' + d.count / 2 + ' per side).', 'hint')));
    }
    for (const ch of d.chambers) {
      if (d.mount.rear2 && ch.id === d.mount.rear2) continue;        // manifold: side B follows side A
      out.push(card(d.mount.rear2 && ch.id === d.mount.rear ? 'Rear chambers (each side, sealed)' : ch.name,
        // horn chambers are small: show them in in³ / liters
        uf('Net volume', horn ? 'dvol' : 'vol', () => ch.vol, (v) => { ch.vol = v; }, { tip: 'Air volume the driver sees, after walls and displacement' }),
        liveText(() => U.volBoth(ch.vol) + (horn && d.horn.attach === ch.id
          ? ' · with the throat it rolls off above ≈ ' + (GL.phys.c * d.horn.s1 / (2 * Math.PI * ch.vol)).toFixed(0) + ' Hz'
          : ''), 'hint'),
        horn || E.isLine(d.type) ? uf('Bracing displacement', 'dvol', () => ch.bracing, (v) => { ch.bracing = v; }, { positive: false, min: 0 }) : braceFields(ch),
        horn || E.isLine(d.type) ? null : stuffFields(ch),
        h('details', null, h('summary', null, 'Losses'),
          h('div', { class: 'grid2' },
            nf('Ql (leakage)', () => ch.ql, (v) => { ch.ql = v; }, { positive: true, digits: 1 }),
            nf('Qa (absorption)', () => ch.qa, (v) => { ch.qa = v; }, { positive: true, digits: 1, tip: 'Before stuffing; the stuffing adds its own absorption on top' })))));
    }
    if (!E.isBoxless(d.type) && !E.isLine(d.type) && !horn) out.push(dimsCard('Box shape'));
    for (const pt of d.ports) out.push(portCard(pt));
    for (const pr of d.prs) out.push(prCard(pr));
    if (d.line) out.push(lineCard());
    if (d.type === 'tl') out.push(kingCard());
    if (d.type === 'mltl' && d.line.port) out.push(endPortCard());
    if (E.isTL(d.type) && d.line.shape === 'rect') out.push(foldCard());
    if (d.horn) out.push(...hornCards());
    if (!E.isBoxless(d.type) && !E.isLine(d.type) && !E.isHorn(d.type)) {
      if (d.chambers.length > 1) out.push(layoutCard());
      out.push(baffleCard());
    }
    return out;
  }

  function hornCards() {
    const d = S.design, H = d.horn;
    const p = () => drvc().params;
    const segCards = H.segments.map((seg, i) => {
      const startArea = () => i ? H.segments[i - 1].s2 : H.s1;
      return h('div', { class: 'seg' },
        h('div', { class: 'seg-head' }, h('b', null, 'Segment ' + (i + 1)),
          H.segments.length > 1 ? btn('Remove', () => {
            H.segments.splice(i, 1);
            if (/^h\d+$/.test(d.mount.rear) && +d.mount.rear.slice(1) > H.segments.length - 1) d.mount.rear = 'h1';
            changed(true);
          }, 'btn ghost') : null),
        h('div', { class: 'grid2' },
          sel('Flare', E.FLARES.map(f => [f.id, f.name]), () => seg.flare, (v) => { seg.flare = v; }),
          seg.flare === 'hyp' ? nf('T (0 = catenoidal, 1 = exponential)', () => seg.T, (v) => { seg.T = Math.max(0, Math.min(1, v)); }, { digits: 2, min: 0 }) : h('span'),
          uf('Length', 'len', () => seg.len, (v) => { seg.len = v; }),
          uf('End area', 'area', () => seg.s2, (v) => { seg.s2 = v; })),
        liveText(() => {
          const sec = E.makeSection(startArea(), seg.s2, seg.len, seg.flare === 'par' ? 'con' : seg.flare, seg.T);
          const dims = H.shape === 'rect'
            ? 'height ' + U.fmt('len', startArea() / H.width) + ' → ' + U.fmt('len', seg.s2 / H.width)
            : 'diameter ' + U.fmt('len', 2 * Math.sqrt(startArea() / Math.PI)) + ' → ' + U.fmt('len', 2 * Math.sqrt(seg.s2 / Math.PI));
          return (sec.fc ? 'Cutoff ' + sec.fc.toFixed(0) + ' Hz · ' : '') + dims;
        }, 'hint'));
    });

    const kids = [
      sel('Mouth radiates into', E.SPACES.map(s => [s.id, s.name]), () => H.space, (v) => { H.space = v; }),
      uf('Throat area', 'area', () => H.s1, (v) => { H.s1 = v; }),
      liveText(() => 'Compression ratio ' + (p().sd * d.count / H.s1).toFixed(2) + ' : 1 (cone area ÷ throat area)', 'hint'),
      segCards,
      h('div', { class: 'row-btns' }, btn('Add segment', () => {
        const last = H.segments[H.segments.length - 1];
        H.segments.push({ flare: last ? last.flare : 'exp', len: (last ? last.len : 0.5) / 2, s2: (last ? last.s2 : H.s1) * 2, T: 0.7 });
        changed(true);
      })),
    ];
    if (d.type === 'th') {
      const opts = H.segments.slice(0, -1).map((_, i) => ['h' + (i + 1), 'End of segment ' + (i + 1)]);
      kids.push(opts.length
        ? sel('Driver rear connects at', opts, () => d.mount.rear, (v) => { d.mount.rear = v; })
        : h('p', { class: 'warn' }, 'A tapped horn needs at least two segments: the driver rear taps in where segment 1 ends.'));
    }
    kids.push(h('p', { class: 'hint' }, 'Simulated as an exact flare per segment (no bends). Fold the path however you like; keep the length and areas.'));

    // design from cutoff (single-segment horns)
    const helper = { fc: (E.makeSection(H.s1, H.segments[0].s2, H.segments[0].len, H.segments[0].flare === 'hyp' ? 'hyp' : 'exp', H.segments[0].T).fc) || 100,
      flare: H.segments[0].flare === 'hyp' ? 'hyp' : 'exp', T: H.segments[0].T || 0.7, pct: 100 };
    const design = card('Design from cutoff',
      h('p', { class: 'hint' }, 'Picks the flare length and mouth for a cutoff frequency, using the throat area above. Replaces the segments with one.'),
      h('div', { class: 'grid2' },
        uf('Cutoff (fc)', 'freq', () => helper.fc, (v) => { helper.fc = v; }),
        sel('Flare', [['exp', 'Exponential'], ['hyp', 'Hyperbolic-exponential']], () => helper.flare, (v) => { helper.flare = v; }, { structural: false }),
        nf('T (hyperbolic)', () => helper.T, (v) => { helper.T = Math.max(0, Math.min(1, v)); }, { digits: 2, min: 0 }),
        nf('Mouth size, % of ideal', () => helper.pct, (v) => { helper.pct = Math.max(5, v); }, { digits: 0, unit: '%' })),
      liveText(() => {
        const ideal = E.idealMouth(helper.fc, H.space);
        const seg = E.hornFromCutoff(helper.fc, H.s1, Math.max(H.s1 * 1.01, ideal * helper.pct / 100), helper.flare, helper.T);
        return 'Ideal mouth ' + U.fmt('area', ideal) + '. This gives a ' + U.fmt('len', seg.len) + ' horn with a ' + U.fmt('area', seg.s2) + ' mouth.';
      }, 'hint'),
      h('div', { class: 'row-btns' }, btn('Apply', () => {
        const ideal = E.idealMouth(helper.fc, H.space);
        const seg = E.hornFromCutoff(helper.fc, H.s1, Math.max(H.s1 * 1.01, ideal * helper.pct / 100), helper.flare, helper.T);
        H.segments = [seg];
        if (d.type === 'th') d.mount.rear = 'h0';
        changed(true);
      })),
      h('p', { class: 'hint' }, 'A full-size mouth gives the smoothest response; smaller mouths are common in practice and add ripple.'));
    return d.type === 'th' ? [card('Horn', ...kids)] : [card('Horn', ...kids), design];
  }

  // Braces in a box chamber: real parts (3D, cut list, volume) plus any
  // extra displacement typed in by hand.
  function braceFields(ch) {
    const b = () => (ch.braces = ch.braces || G.defaultBraces());
    const kind = b().kind;
    return h('div', null,
      h('div', { class: 'grid2' },
        sel('Bracing', G.BRACES, () => b().kind, (v) => { b().kind = v; }),
        kind !== 'none' ? nf('How many', () => b().count, (v) => { b().count = Math.max(1, Math.round(v)); }, { digits: 0, min: 1 }) : null,
        kind === 'window' ? uf('Frame width', 'len', () => b().rim, (v) => { b().rim = v; }, { tip: 'Width of the brace all round its opening' }) : null,
        kind === 'dowel' ? uf('Dowel diameter', 'len', () => b().dia, (v) => { b().dia = v; }) : null,
        kind === 'dowel' ? sel('Runs', [['W', 'Side to side'], ['H', 'Top to bottom']], () => b().axis, (v) => { b().axis = v; }) : null,
        uf('Extra displacement', 'dvol', () => ch.bracing, (v) => { ch.bracing = v; }, { positive: false, min: 0, tip: 'Anything else inside: cleats, terminal cups, extra braces' })),
      kind !== 'none' ? liveText(() => {
        const c = R && R.layout && R.layout.chambers.find(x => x.id === ch.id);
        return c ? 'Braces take ' + U.fmt('dvol', c.disp.braces) + '. They sit behind the driver motor where the box is deep enough, evenly spaced, and are added to the cut list.' : '';
      }, 'hint') : null);
  }

  function portCard(pt) {
    const d = S.design;
    const vol = () => chamberById(pt.from).vol;
    const nm = (id) => id === 'out' ? 'outside' : chamberById(id).name;
    return card(pt.name,
      h('p', { class: 'hint' }, nm(pt.from) + ' → ' + nm(pt.to)),
      h('div', { class: 'grid2' },
        sel('Shape', [['round', 'Round'], ['slot', 'Slot']], () => pt.shape, (v) => {
          pt.shape = v;
          // first time as a slot: against a wall, full span (simplest to build, and it braces the box)
          if (v === 'slot' && !pt.slotSet) { pt.slotSet = true; pt.alongWall = true; pt.fullHeight = true; }
        }),
        nf('Count', () => pt.count, (v) => { pt.count = Math.max(1, Math.round(v)); }, { digits: 0, min: 1 }),
        pt.shape === 'round'
          ? [uf(pt.flareOut || pt.flareIn ? 'Throat diameter' : 'Diameter', 'len', () => pt.d, (v) => { pt.d = v; }),
             uf('Tube wall', 'thick', () => pt.wall, (v) => { pt.wall = v; }, { positive: false, min: 0 }),
             uf('Flare radius, outer end', 'len', () => pt.flareOut || 0, (v) => { pt.flareOut = v; }, { positive: false, min: 0, structural: true, tip: 'Round-over radius where the port meets the baffle. 0 = straight.' }),
             uf('Flare radius, inner end', 'len', () => pt.flareIn || 0, (v) => { pt.flareIn = v; }, { positive: false, min: 0, structural: true, tip: 'Round-over radius inside the box. 0 = straight.' })]
          : [uf('Width', 'len', () => pt.w, (v) => { pt.w = v; }),
             pt.fullHeight
               ? liveText(() => 'Span ' + U.fmt('len', pt.h) + ' (full inside, panel to panel)', 'hint')
               : uf('Span', 'len', () => pt.h, (v) => { pt.h = v; }, { tip: 'Length of the opening along the wall' }),
             uf('Round-over, outer end', 'len', () => pt.slotOut || 0, (v) => { pt.slotOut = v; }, { positive: false, min: 0, structural: true,
               tip: 'Radius on the slot edges at the baffle opening (the baffle cutout and the slot panel). 0 = square.' }),
             uf('Round-over, inner end', 'len', () => pt.slotIn || 0, (v) => { pt.slotIn = v; }, { positive: false, min: 0, structural: true,
               tip: 'Radius on the end of the slot panel where the air leaves inside the box. Up to the panel thickness on a plain panel edge.' })],
        uf('Tuning (Fb)', 'freq', () => E.portFb(pt, vol()), (v) => { pt.fb = v; pt.holdFb = true; }, { tip: 'Sets the port length' }),
        uf('Length', 'len', () => pt.len, (v) => { pt.len = v; pt.fb = E.portFb(pt, vol()); }, { tip: pt.shape === 'round' ? 'End to end, flares included' : null }),
        // round ports to the outside can go on any outer wall of their chamber
        pt.shape === 'round' && pt.to === 'out' && !E.isBoxless(d.type) && !E.isLine(d.type) && !E.isHorn(d.type)
          ? sel('On the', [['auto', 'Front, or wherever there is room'], ['front', 'Front baffle'], ['back', 'Back'], ['left', 'Left side'], ['right', 'Right side'], ['top', 'Top'], ['bottom', 'Bottom']],
            () => pt.face || 'auto', (v) => { pt.face = v; }) : null),
      pt.shape === 'round' && pt.to === 'out' ? liveText(() => {
        const f = portFit(pt), w = f && f.route.wall;
        const nm2 = { front: 'the front baffle', back: 'the back', left: 'the left side', right: 'the right side', top: 'the top', bottom: 'the bottom' };
        if (!w) return '';
        if (pt.face && pt.face !== 'auto' && pt.face !== w) return 'That chamber does not reach ' + nm2[pt.face] + ', so it stays on ' + nm2[w] + '.';
        return f.route.movedFrom ? 'On ' + nm2[w] + ': there was no room on the front.' : (w !== 'front' ? 'On ' + nm2[w] + '. A port off the front radiates from there; low down that makes no difference, higher up it does.' : '');
      }, 'hint') : null,
      pt.shape === 'slot' ? (() => {
        const plane = pt.to === 'out' ? 2 : (S.box.split === 'W' ? 0 : 1);
        const names = { right: 'Right side', left: 'Left side', top: 'Top panel', bottom: 'Bottom panel', back: 'Back panel', front: 'Front baffle' };
        const sides = GL.placement.sidesFor(plane);
        // neighbours whose baffle the slot could open on (it then runs through them)
        const order = S.design.chambers.map(c => c.id);
        const i0 = order.indexOf(pt.from);
        const nbrs = pt.to === 'out' && !E.isBoxless(S.design.type) ? [order[i0 - 1], order[i0 + 1]].filter(Boolean) : [];
        return [
          nbrs.length ? sel('Mouth on the baffle of', [['', chamberById(pt.from).name + ' (its own)']].concat(nbrs.map(id => [id, chamberById(id).name + ' (runs through it)'])),
            () => pt.via || '', (v) => { pt.via = v || null; if (!v) delete pt.viaShare; }) : null,
          pt.via ? h('p', { class: 'hint' }, 'The slot opens on the baffle of ' + chamberById(pt.via).name.toLowerCase() + ', runs back along its outer wall, along the back wall, ' +
            'through a notch in the divider and opens inside ' + chamberById(pt.from).name.toLowerCase() + '. That keeps the duct clear of the driver and frees the ported chamber\'s baffle. ' +
            'Its volume is shared between the two chambers by length.') : null,
          pt.via ? null : sel('Against', sides.map(k => [k, names[k]]), () => sides.includes(pt.wallSide) ? pt.wallSide : ((portFit(pt) || {}).route || {}).side || GL.placement.defaultSide(plane), (v) => { pt.wallSide = v; }),
          check('That wall is one side of the slot (no extra panel)', () => pt.alongWall !== false, (v) => { pt.alongWall = v; }),
          check('Full span: the slot panel runs between the two opposite panels', () => !!pt.fullHeight, (v) => { pt.fullHeight = v; }, { structural: true }),
          h('div', { class: 'grid2' },
            uf('Round-over at folds', 'len', () => pt.foldR || 0, (v) => { pt.foldR = v; }, { positive: false, min: 0,
              tip: 'Radius on the inside corner of each fold, where the air turns. A U-turn rounds the panel end (full round = half the panel thickness).' }),
            check('Fill the outer corners', () => !!pt.foldFill, (v) => { pt.foldFill = v; }, { structural: false })),
          liveText(() => {
            const f = portFit(pt);
            if (!f || !f.route.bends) return 'Round-overs apply when the slot folds.';
            const r = f.route;
            return (r.rounded ? 'Air takes an arc of radius ' + U.fmt('len', r.foldR + r.w / 2) + ' round each fold, so the runs are a little longer for the same tuning. ' : 'Square folds: air separates at the inside corners, which adds noise and loss at high air speed. ') +
              (r.foldR > S.box.t && r.shape !== 'U' ? 'A radius over the panel thickness needs a glued block or a half-round. ' : '') +
              (r.fill ? 'Fillet blocks of radius ' + U.fmt('len', r.foldR + r.w) + ' keep the slot the same width through the turn.' : '');
          }, 'hint'),
          h('p', { class: 'hint' }, 'Tip: against a wall with full span is the easiest slot to build. The slot panel is a plain rectangle, glued on three edges, so it braces the box. The wall saves a panel and the volume that panel would take.'),
        ];
      })() : null,
      check('Hold tuning when volume or port size changes', () => pt.holdFb, (v) => { pt.holdFb = v; pt.fb = E.portFb(pt, vol()); }),
      [
        check(pt.shape === 'slot' ? 'Allow folds (up to two)' : 'Allow 90° bends (up to two)', () => pt.bends !== 'none', (v) => { pt.bends = v ? 'auto' : 'none'; }, { structural: true }),
        liveText(() => {
          const f = portFit(pt);
          if (!f) return '';
          const r = f.route;
          const path = GL.placement.describe(r, (x) => U.fmt('len', x));
          if (!r.fits && r.noRoute) return 'No clear route: the driver or another port is in the way of every fold. Move things apart (a bigger box), or try the other baffle.';
          if (!r.fits && r.tooShort) return 'Too short to reach ' + chamberById(pt.from).name.toLowerCase() + ' through ' + chamberById(r.via).name.toLowerCase() + '. Tune lower, use a wider slot, or open it on its own baffle.';
          if (!r.fits) return "Doesn't fit" + (r.short > 0.0005 ? ' (about ' + U.fmt('len', r.short) + ' too long)' : '') + '. Closest route: ' + path + '.';
          return (r.bends ? 'Fits with ' + (pt.shape === 'slot' ? (r.bends > 1 ? 'two folds' : 'a fold') : r.bends + (r.bends > 1 ? ' bends' : ' bend')) : 'Fits straight') + ': ' + path + '. Open end at least one port width from any wall.';
        }, 'hint'),
        (() => {
          const b = btn('Make the box deep enough to run it straight', () => {
            const f = portFit(pt);
            if (!f) return;
            S.box.lock.D = false;
            setDim('D', f.route.straightNeed + S.box.t);
            changed(true);
          }, 'btn small');
          live.push(() => { const f = portFit(pt); b.hidden = !f || !f.route.front || (f.route.fits && !f.route.bends); });
          liveSide[liveSide.length - 1]();
          return b;
        })(),
        (() => {
          const row = h('div', { class: 'btnrow' },
            btn(pt.shape === 'slot' ? 'Narrow it to fit (same tuning)' : 'Shrink it to fit (same tuning)', () => fitPort(pt, 'size'), 'btn small'),
            btn('Tune higher to fit (same size)', () => fitPort(pt, 'tune'), 'btn small'));
          live.push(() => { const f = portFit(pt); row.style.display = !f || f.route.fits ? 'none' : ''; });
          liveSide[liveSide.length - 1]();
          return row;
        })(),
      ],
      liveText(() => {
        const i = R && R.model ? R.model.ports.findIndex(x => x.cfg === pt) : -1;
        const v = i >= 0 ? maxOf(R.res.portVel[i].v) : NaN;
        const parts = ['Area ' + U.fmt('area', E.portArea(pt) * pt.count)];
        if (pt.shape === 'round' && (pt.flareOut || pt.flareIn)) {
          parts.push('mouth ' + U.fmt('len', pt.d + 2 * Math.max(pt.flareOut || 0, pt.flareIn || 0)));
        }
        if (pt.shape === 'slot' && (pt.slotOut || pt.slotIn)) {
          parts.push('opening ' + U.fmt('len', pt.w + E.slotEdges(pt) * (pt.slotOut || 0)) + ' wide at the baffle');
          if ((pt.slotIn || 0) > S.box.t) parts.push('inner round-over is bigger than the panel thickness: glue on a half-round or block');
        }
        parts.push('acts like ' + U.fmt('len', pt.len + E.portEnd(pt)) + ' of straight port');
        parts.push('pipe resonance ≈ ' + pipeRes(pt).toFixed(0) + ' Hz');
        const n = i >= 0 ? portNoise(R, i) : null;
        parts.push('peak air speed ' + (isFinite(v) ? v.toFixed(1) + ' m/s now, ' + n.vFull.toFixed(1) + ' m/s at full power' : '–') +
          ((pt.shape === 'round' && (pt.flareOut || pt.flareIn)) || (pt.shape === 'slot' && (pt.slotOut || pt.slotIn)) ? ' (at the throat)' : '') +
          (n ? ' · quiet below ' + n.lim.quiet.toFixed(0) + ' m/s' + (n.quiet ? ', needs ' + (pt.shape === 'round' ? U.fmt('len', n.quiet.d) + ' dia.' : U.fmt('len', n.quiet.w) + ' wide') : '') : ''));
        return parts.join(' · ');
      }, 'hint'),
      h('details', null, h('summary', null, 'Advanced'),
        sel('End correction', Object.entries(E.END_CORR).map(([k, v]) => [k, v.name]), () => pt.end, (v) => { pt.end = v; }),
        nf('Qp (port loss)', () => pt.qp, (v) => { pt.qp = v; }, { positive: true, digits: 0 })));
  }

  function prCard(pr) {
    const vol = () => chamberById(pr.from).vol;
    let target = E.prFb(pr, vol());
    return card(pr.name,
      h('div', { class: 'btnrow' }, btn('Pick from catalogue…', () => openCatalogue({ pr }), 'btn small'),
        pr.catalogue ? h('span', { class: 'hint' }, 'From the catalogue: ' + pr.catalogue) : null),
      h('div', { class: 'grid2' },
        uf('Fs', 'freq', () => pr.fs, (v) => { pr.fs = v; }),
        nf('Qms', () => pr.qms, (v) => { pr.qms = v; }, { positive: true }),
        uf('Vas', 'vol', () => pr.vas, (v) => { pr.vas = v; }),
        uf('Sd', 'area', () => pr.sd, (v) => { pr.sd = v; }),
        uf('Xmax', 'mm', () => pr.xmax, (v) => { pr.xmax = v; }),
        nf('Count', () => pr.count, (v) => { pr.count = Math.max(1, Math.round(v)); }, { digits: 0, min: 1 }),
        uf('Added mass', 'mass', () => pr.added, (v) => { pr.added = v; }, { positive: false, min: 0 }),
        uf('Displacement', 'dvol', () => pr.disp, (v) => { pr.disp = v; }, { positive: false, min: 0 })),
      h('div', { class: 'grid2' },
        uf('Target tuning', 'freq', () => target, (v) => { target = v; }),
        btn('Set added mass', () => {
          const m = E.addedForFb(pr, vol(), target);
          if (m < 0) return toast('That tuning is above what this PR reaches with no added mass.', true);
          pr.added = m; changed(true);
        })),
      liveText(() => 'Box tuning ' + E.prFb(pr, vol()).toFixed(1) + ' Hz · moving mass ' + (E.prMech(pr).Mm * 1000).toFixed(0) + ' g', 'hint'));
  }


  // ---- folded transmission line
  const foldOf = (L) => (L.fold = Object.assign({}, G.FOLD_DEFAULT, L.fold || {}));
  const folded = (d) => d && E.isTL(d.type) && d.line && d.line.shape === 'rect' && d.line.fold && d.line.fold.n > 0;
  function foldCard() {
    const d = S.design, L = d.line, f = foldOf(L);
    const vert = f.legs === 'vertical';
    const kids = [
      nf('Folds', () => f.n, (v) => { f.n = Math.max(0, Math.min(9, Math.round(v))); }, { digits: 0, min: 0, step: 1, structural: true, tip: '0 = a straight line' }),
    ];
    if (f.n > 0) {
      kids.push(h('div', { class: 'grid2' },
        sel('Legs run', [['vertical', 'Up and down (a tower)'], ['horizontal', 'Side to side (a low box)']], () => f.legs, (v) => { f.legs = v; }),
        sel('Closed end at', vert ? [['top', 'Top'], ['bottom', 'Bottom']] : [['top', 'Left'], ['bottom', 'Right']], () => f.start, (v) => { f.start = v; }),
        sel('Dividers', [['angled', 'Angled to follow the taper'], ['parallel', 'Parallel (stepped taper)']], () => f.dividers, (v) => { f.dividers = v; }),
        sel('Mouth', [['back', 'In the back panel'], ['end', vert ? 'In the top or bottom panel' : 'In the end panel']], () => f.mouth, (v) => { f.mouth = v; }),
        uf('Turn gap', 'pct', () => f.gap, (v) => { f.gap = Math.max(0.5, Math.min(2, v)); }, { tip: 'Gap at each turn as a share of the line height there: 100% keeps the area through the turn' }),
        uf('Wall and divider thickness', 'thick', () => f.t, (v) => { f.t = v; })),
        check('45° corner blocks in the turns', () => f.deflect, (v) => { f.deflect = v; }));
    }
    kids.push(liveText(() => {
      const r = G.lineFold(d);
      if (!r.n) return 'Straight: outside ' + U.fmt('len', r.ext.W) + ' × ' + U.fmt('len', r.ext.H) + ' × ' + U.fmt('len', r.ext.D) + ' (W × H × D). Add folds to fit it in a box.';
      return 'Outside ' + U.fmt('len', r.ext.W) + ' W × ' + U.fmt('len', r.ext.H) + ' H × ' + U.fmt('len', r.ext.D) + ' D · legs ' +
        r.legs.map(g => U.fmt('len', g.len)).join(', ') + ' · air ' + U.fmt('vol', r.air) + ' (line ' + U.fmt('vol', G.lineLayout(d).air) + ')' +
        (r.warn.length ? ' · ' + r.warn.join(' ') : '');
    }, 'hint'));
    // every fold count at a glance
    const tbl = h('div', { class: 'voltable' });
    const fillT = () => {
      tbl.innerHTML = '';
      const rows = [];
      for (let k = 0; k <= 5; k++) {
        const r = G.lineFold({ line: Object.assign({}, L, { fold: Object.assign({}, f, { n: k }) }) });
        rows.push(h('tr', { class: k === f.n ? 'on' : null },
          h('th', null, k === 0 ? 'Straight' : k + ' fold' + (k > 1 ? 's' : '')),
          ...['W', 'H', 'D'].map(x => h('td', null, U.fmt('len', r.ext[x]))),
          h('td', null, r.warn.length ? '!' : k === f.n ? 'chosen' : h('button', { class: 'btn small ghost', onclick: () => { f.n = k; changed(true); } }, 'Use'))));
      }
      tbl.append(h('table', null, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Width'), h('th', null, 'Height'), h('th', null, 'Depth'), h('th', null, ''))), h('tbody', null, rows)));
    };
    fillT(); live.push(fillT);
    kids.push(tbl, h('p', { class: 'hint' }, 'Length is measured along the centre of the path, so folding keeps the tuning. The first leg runs behind the front baffle, where the driver goes; each turn keeps the line\'s area (gap = line height) and the corner blocks smooth the flow. Parallel dividers are simpler to cut and are simulated as a stepped taper. See the Build tab for the side view and cut list.'));
    return card('Folding', ...kids);
  }

  // Side view of a folded line: walls, dividers, corner blocks, the path, driver and mouth.
  function foldSvg(d) {
    const r = G.lineFold(d), L = d.line, f = r.fold, t = r.t, vert = f.legs === 'vertical';
    const NS = 'http://www.w3.org/2000/svg', sv = (tg, at, txt) => { const e = document.createElementNS(NS, tg); for (const k in at) e.setAttribute(k, at[k]); if (txt) e.textContent = txt; return e; };
    const Lo = r.Lin + 2 * t, Do = r.Din + 2 * t;
    // a: along the legs from end A (inside), z: depth from the inside of the front
    const flipA = f.start === 'bottom';
    const P = (a, z) => {
      const aa = flipA ? r.Lin - a : a;
      return vert ? [t + z, t + aa] : [t + aa, t + r.Din - z];
    };
    const Wv = vert ? Do : Lo, Hv = vert ? Lo : Do;
    const pad = Math.max(Wv, Hv) * 0.12;
    const svg = sv('svg', { viewBox: `${-pad} ${-pad} ${Wv + 2 * pad} ${Hv + 2 * pad}`, class: 'foldsvg', role: 'img', 'aria-label': 'Side view of the folded line' });
    const poly = (pts, cls) => svg.append(sv('polygon', { points: pts.map(p => p.join(',')).join(' '), class: cls }));
    svg.append(sv('rect', { x: 0, y: 0, width: Wv, height: Hv, class: 'wall' }));
    const ip = [P(0, 0), P(r.Lin, 0), P(r.Lin, r.Din), P(0, r.Din)];
    poly(ip, 'airin');
    const zAt = (dv, a) => dv.zA + (dv.zB - dv.zA) * a / r.Lin;
    for (const dv of r.dividers) {
      const a0 = dv.from === 'A' ? 0 : r.Lin - dv.len, a1 = dv.from === 'A' ? dv.len : r.Lin;
      poly([P(a0, zAt(dv, a0)), P(a1, zAt(dv, a1)), P(a1, zAt(dv, a1) + t), P(a0, zAt(dv, a0) + t)], 'div');
    }
    // leg fronts/backs at each end
    const edge = (k, end) => { let z = 0; for (let j = 0; j < k; j++) z += (end === 'A' ? r.legs[j].hA : r.legs[j].hB) + t; return [z, z + (end === 'A' ? r.legs[k].hA : r.legs[k].hB)]; };
    for (const df of r.defl) {
      const a = df.at === 'A' ? 0 : r.Lin, sgn = df.at === 'A' ? 1 : -1;
      const zf = edge(df.i, df.at)[0], zb = edge(df.i + 1, df.at)[1];
      poly([P(a, zf), P(a + sgn * df.s, zf), P(a, zf + df.s)], 'div');
      poly([P(a, zb), P(a + sgn * df.s, zb), P(a, zb - df.s)], 'div');
    }
    // centre of the path
    const mid = (k, end) => { const e = edge(k, end); return (e[0] + e[1]) / 2; };
    const pts = [P(0, mid(0, 'A'))];
    r.turns.forEach((x) => {
      const a = x.at === 'B' ? r.Lin - x.gap / 2 : x.gap / 2;
      pts.push(P(a, mid(x.i, x.at)), P(a, mid(x.i + 1, x.at)));
    });
    const lastK = r.legs.length - 1, mEnd = r.mouthEnd;
    const aMouthEnd = mEnd === 'A' ? 0 : r.Lin;
    if (r.portAt > 0) {
      // MLTL port on the back panel, a little up from the closed end of the last leg
      const am = mEnd === 'A' ? r.portAt : r.Lin - r.portAt;
      pts.push(P(aMouthEnd, mid(lastK, mEnd)));
      const o0 = P(am - r.mouthH / 2, r.Din), o1 = P(am + r.mouthH / 2, r.Din + t);
      svg.append(sv('rect', { x: Math.min(o0[0], o1[0]), y: Math.min(o0[1], o1[1]), width: Math.abs(o1[0] - o0[0]), height: Math.abs(o1[1] - o0[1]), class: 'mouth' }));
    } else if (r.mouthBack) {
      const am = mEnd === 'A' ? r.mouthH / 2 : r.Lin - r.mouthH / 2;
      pts.push(P(am, mid(lastK, mEnd)), P(am, r.Din + t));
      const o0 = P(mEnd === 'A' ? 0 : r.Lin - r.mouthH, r.Din), o1 = P(mEnd === 'A' ? r.mouthH : r.Lin, r.Din + t);
      svg.append(sv('rect', { x: Math.min(o0[0], o1[0]), y: Math.min(o0[1], o1[1]), width: Math.abs(o1[0] - o0[0]), height: Math.abs(o1[1] - o0[1]), class: 'mouth' }));
    } else {
      const e = edge(lastK, mEnd);
      pts.push(P(aMouthEnd + (mEnd === 'A' ? -t : t), mid(lastK, mEnd)));
      const o0 = P(aMouthEnd, e[0]), o1 = P(aMouthEnd + (mEnd === 'A' ? -t : t), e[1]);
      svg.append(sv('rect', { x: Math.min(o0[0], o1[0]), y: Math.min(o0[1], o1[1]), width: Math.abs(o1[0] - o0[0]), height: Math.abs(o1[1] - o0[1]), class: 'mouth' }));
    }
    svg.append(sv('polyline', { points: pts.map(p => p.join(',')).join(' '), class: 'path' }));
    // driver on the front baffle
    const p = drvc().params, dd = p.dia > 0 ? p.dia : 2 * Math.sqrt(p.sd / Math.PI) * 1.18;
    const d0 = P(Math.max(0, r.drvAlong - dd / 2), -t), d1 = P(Math.min(r.Lin, r.drvAlong + dd / 2), 0);
    svg.append(sv('rect', { x: Math.min(d0[0], d1[0]), y: Math.min(d0[1], d1[1]), width: Math.abs(d1[0] - d0[0]), height: Math.abs(d1[1] - d0[1]), class: 'drv' }));
    const fs = Math.max(Wv, Hv) * 0.035;
    const lab = (x, y, txt, anchor) => svg.append(sv('text', { x, y, 'font-size': fs, 'text-anchor': anchor || 'middle' }, txt));
    lab(Wv / 2, -pad * 0.35, U.fmt('len', Wv) + (vert ? ' deep' : ' wide'));
    { const x = -pad * 0.4, tx = sv('text', { x, y: Hv / 2, 'font-size': fs, 'text-anchor': 'middle', transform: `rotate(-90 ${x} ${Hv / 2})` }, U.fmt('len', Hv) + (vert ? ' tall' : ' deep')); svg.append(tx); }
    lab(Wv / 2, Hv + pad * 0.6, vert ? 'front ← | → back' : 'front (bottom of this view)');
    return svg;
  }

  // Area along the path, folded (as simulated) against the straight line.
  function areaSvg(d) {
    const L = d.line, fn = E.lineAreaFn(L, d.type), st = E.lineAreaFn(Object.assign({}, L, { fold: null }), d.type);
    const N = 400, xs = [], ys = [], y2 = [];
    for (let i = 0; i <= N; i++) { const x = L.length * i / N; xs.push(x); ys.push(fn(Math.min(x, L.length - 1e-9))); y2.push(st(x)); }
    const top = Math.max(...ys, ...y2) * 1.1, Wd = 600, Hd = 150, m = 34;
    const X = (x) => m + (Wd - m - 8) * x / L.length, Y = (y) => Hd - 20 - (Hd - 30) * y / top;
    const NS = 'http://www.w3.org/2000/svg', sv = (tg, at, txt) => { const e = document.createElementNS(NS, tg); for (const k in at) e.setAttribute(k, at[k]); if (txt) e.textContent = txt; return e; };
    const svg = sv('svg', { viewBox: `0 0 ${Wd} ${Hd}`, class: 'areasvg', role: 'img', 'aria-label': 'Line area along the path' });
    svg.append(sv('line', { x1: m, y1: Y(0), x2: Wd - 8, y2: Y(0), class: 'ax' }), sv('line', { x1: m, y1: Y(0), x2: m, y2: 8, class: 'ax' }));
    svg.append(sv('polyline', { points: xs.map((x, i) => X(x) + ',' + Y(y2[i])).join(' '), class: 'straight' }));
    svg.append(sv('polyline', { points: xs.map((x, i) => X(x) + ',' + Y(ys[i])).join(' '), class: 'fold' }));
    svg.append(sv('text', { x: m + 4, y: 16 }, 'Area along the path: folded (as simulated, solid) and straight (dashed)'));
    svg.append(sv('text', { x: m, y: Hd - 4 }, 'closed end'), sv('text', { x: Wd - 8, y: Hd - 4, 'text-anchor': 'end' }, 'mouth, ' + U.fmt('len', L.length)));
    svg.append(sv('text', { x: m + 4, y: Y(ys[0]) - 6 }, U.fmt('area', ys[0])));
    return svg;
  }

  // Cut list for a folded line (butt joints: sides full size, the rest between them).
  function foldCutList(d) {
    const r = G.lineFold(d), t = r.t, e = r.ext, vert = r.fold.legs === 'vertical';
    const list = [];
    // the two panels that show the fold (the "sides" of the path) are full size
    if (vert) {
      list.push({ name: 'Side (shows the fold)', qty: 2, a: e.H, b: e.D });
      list.push({ name: 'Front baffle', qty: 1, a: e.H - 2 * t, b: e.W - 2 * t });
      list.push({ name: 'Back', qty: 1, a: e.H - 2 * t, b: e.W - 2 * t });
      list.push({ name: 'Top and bottom', qty: 2, a: e.W - 2 * t, b: e.D - 2 * t });
    } else {
      list.push({ name: 'Top and bottom (show the fold)', qty: 2, a: e.W, b: e.D });
      list.push({ name: 'Front baffle', qty: 1, a: e.W, b: e.H - 2 * t });
      list.push({ name: 'Back', qty: 1, a: e.W, b: e.H - 2 * t });
      list.push({ name: 'Ends', qty: 2, a: e.H - 2 * t, b: e.D - 2 * t });
    }
    r.dividers.forEach((dv, i) => list.push({ name: 'Divider ' + (i + 1) + (Math.abs(r.lean[i]) > 0.05 ? ' (leans ' + Math.abs(r.lean[i]).toFixed(1) + '°)' : ''), qty: 1, a: dv.len, b: r.w }));
    if (r.defl.length) {
      const by = {};
      for (const x of r.defl) { const k = x.s.toFixed(4); by[k] = (by[k] || 0) + 2; }
      for (const [s, q] of Object.entries(by)) list.push({ name: '45° corner block, ' + U.fmt('len', +s) + ' legs', qty: q, a: r.w, b: +s, tri: true });
    }
    return { r, list };
  }

  // M. J. King's method: a transmission line with the volume and tuning of a
  // ported box alignment, for a chosen taper ratio (TR = mouth area / closed-end area).
  const kingState = { vb: 0, fb: 0, tr: 0.2 };
  function kingCard() {
    const d = S.design, L = d.line, p = drvc().params, n = d.count;
    const qb3 = () => { kingState.vb = 15 * Math.pow(p.qts, 2.87) * p.vas * n; kingState.fb = 0.42 * p.fs * Math.pow(p.qts, -0.9); };
    if (!(kingState.vb > 0)) qb3();
    const k = kingState;
    const res = () => E.tlFromAlignment(k.vb, k.fb, k.tr);
    return card('Size from a ported alignment',
      h('p', { class: 'hint' }, 'Martin J. King\'s method: take a ported box\'s volume and tuning (from an alignment table, or QB3 here) and give the line that volume, with a length set by the tuning and the taper. ' +
        'L = SF × c / (4·fb), S0 = Vb / (½·(1 + TR)·L), SL = TR × S0. SF comes from King\'s table: 0.71 for a 5:1 taper, 1.00 straight, 1.32 for 1:5 expanding.'),
      h('div', { class: 'grid2' },
        uf('Box volume', 'vol', () => k.vb, (v) => { k.vb = v; }, { structural: false }),
        uf('Tuning', 'freq', () => k.fb, (v) => { k.fb = v; }, { structural: false }),
        nf('Taper ratio (mouth : closed end)', () => k.tr, (v) => { k.tr = Math.min(10, Math.max(0.1, v)); }, { digits: 2, structural: false, tip: '0.2 = tapered 5:1, 1 = straight, 5 = expanding 1:5' }),
        btn('QB3 for this driver', () => { qb3(); renderSide(); }, 'btn small')),
      h('div', { class: 'row-btns' },
        btn('Tapered 5:1', () => { k.tr = 0.2; renderSide(); }, 'btn small ghost'),
        btn('Straight', () => { k.tr = 1; renderSide(); }, 'btn small ghost'),
        btn('Expanding 1:5', () => { k.tr = 5; renderSide(); }, 'btn small ghost')),
      liveText(() => {
        const r = res(), sd = p.sd * n;
        return 'SF ' + E.taperSF(k.tr).toFixed(2) + ' → length ' + U.fmt('len', r.length) + ', closed end ' + U.fmt('area', r.s0) + ' (' + (r.s0 / sd).toFixed(2) + ' × Sd), mouth ' + U.fmt('area', r.sL) + ' (' + (r.sL / sd).toFixed(2) + ' × Sd)';
      }, 'hint'),
      h('div', { class: 'row-btns' }, btn('Apply to the line', () => {
        const r = res();
        L.length = r.length;
        if (L.shape === 'round') { L.d0 = Math.sqrt(4 * r.s0 / Math.PI); L.dL = Math.sqrt(4 * r.sL / Math.PI); }
        else {
          // keep the width unless the line would get very flat or very deep
          const big = Math.max(r.s0, r.sL);
          if (big / L.width > 3 * L.width || big / L.width < L.width / 3) L.width = Math.sqrt(big);
          L.h0 = r.s0 / L.width; L.hL = r.sL / L.width;
        }
        changed(true);
      }, 'btn primary')),
      h('p', { class: 'hint' }, 'King then offsets the driver along the line (to clean up the ¾-wave resonance) and stuffs the first ¾ of the line with about 0.5 lb/ft³ of fibre. Tune without stuffing first, so the resonances are easy to see.'));
  }

  // MLTL: the port that closes the end of the line
  function endPortCard() {
    const d = S.design, L = d.line, pt = L.port;
    let target = E.mltlTuning(L);
    const kids = [
      sel('Shape', [['round', 'Round'], ['slot', 'Slot (rectangular)']], () => pt.shape, (v) => {
        if (v === 'slot' && pt.shape !== 'slot') { const a = Math.PI * pt.d * pt.d / 4; pt.w = Math.min(L.width, Math.sqrt(a) * 2); pt.h = a / pt.w; }
        if (v === 'round' && pt.shape === 'slot') pt.d = Math.sqrt(4 * pt.w * pt.h / Math.PI);
        pt.shape = v;
      }),
      pt.shape === 'slot'
        ? h('div', { class: 'grid2' }, uf('Width', 'len', () => pt.w, (v) => { pt.w = v; }), uf('Height', 'len', () => pt.h, (v) => { pt.h = v; }))
        : uf('Diameter', 'len', () => pt.d, (v) => { pt.d = v; }),
      h('div', { class: 'grid2' },
        uf('Length', 'len', () => pt.len, (v) => { pt.len = v; }, { positive: false, min: 0, tip: '0 = a hole in the panel (its thickness still counts as length if you enter it)' }),
        nf('Count', () => pt.count, (v) => { pt.count = Math.max(1, Math.round(v)); }, { digits: 0, min: 1 })),
      sel('End correction', Object.entries(E.END_CORR).map(([k, v]) => [k, v.name]), () => pt.end, (v) => { pt.end = v; }),
      uf('Port centre up from the end', 'len', () => pt.at || 0, (v) => { pt.at = Math.max(0, Math.min(L.length * 0.5, v)); }, { positive: false, min: 0, structural: true,
        tip: '0 = the port closes the end of the line. A few inches up (on the baffle) can cancel some of the line\'s harmonics: try steps of an inch and watch 400–900 Hz' }),
      h('div', { class: 'grid2' },
        uf('Tune to', 'freq', () => target, (v) => { target = v; }, { structural: false }),
        btn('Set port length', () => {
          const len = E.mltlPortLen(L, target);
          if (len <= 0) return toast('Even a hole tunes below ' + target.toFixed(1) + ' Hz with this port: make the port bigger or the line shorter.', true);
          pt.len = len; changed(true);
        })),
      liveText(() => {
        const f = E.mltlTuning(L), a = (pt.shape === 'slot' ? pt.w * pt.h : Math.PI * pt.d * pt.d / 4) * pt.count, S0 = E.lineAreas(L).sL;
        return 'Tuning ' + f.toFixed(1) + ' Hz (line ' + E.quarterWave(L, 1)[0].toFixed(1) + ' Hz alone) · port ' + U.fmt('area', a) + ', ' + (100 * a / S0).toFixed(0) + '% of the line\'s end';
      }, 'hint'),
      h('p', { class: 'hint' }, 'The port\'s air mass lowers the line\'s tuning, so the line can be about a third shorter than a plain one for the same bass. ' +
        'Starting points (B. Brines, via Neurochrome): see the shapes on the Line card, a port about 0.5 × Sd in area, tuned at or a little below Fs. A bigger port needs to be longer. ' +
        'Port air speed shows on the Port air speed chart; keep it under about 10 m/s at normal levels. ' +
        'Bob Brines\'s method: tune with no stuffing first, so the line\'s resonances are easy to see; nudge the driver position (a few mm can remove a harmonic blob), set the port length for the lowest flat bass, move the port up from the end an inch at a time to cancel harmonics, then stuff the top half of the line just enough to calm what is left.'),
    ];
    return card('End port (mass loading)', ...kids);
  }

  function lineCard() {
    const d = S.design, L = d.line;
    const kids = [
      sel('Shape', [['rect', 'Rectangular'], ['round', 'Round (pipe)']], () => L.shape, (v) => { L.shape = v; }),
      uf('Length', 'len', () => L.length, (v) => { L.length = v; }),
    ];
    if (L.shape === 'rect') kids.push(h('div', { class: 'grid2' },
      uf('Width', 'len', () => L.width, (v) => { L.width = v; }),
      uf('Height at closed end', 'len', () => L.h0, (v) => { L.h0 = v; }),
      uf('Height at mouth', 'len', () => L.hL, (v) => { L.hL = v; })));
    else kids.push(h('div', { class: 'grid2' },
      uf('Diameter at closed end', 'len', () => L.d0, (v) => { L.d0 = v; }),
      uf('Diameter at mouth', 'len', () => L.dL, (v) => { L.dL = v; })));
    kids.push(h('div', { class: 'grid2' },
      uf('Driver position', 'pct', () => L.drvPos, (v) => { L.drvPos = Math.min(0.95, Math.max(0, v)); }, { positive: false, min: 0, tip: '0% = at the closed end' }),
      uf('Stuffing', 'pct', () => L.stuffing, (v) => { L.stuffing = Math.min(1, Math.max(0, v)); }, { positive: false, min: 0, tip: 'Simplified damping model' }),
      uf('Stuffed down to', 'pct', () => L.stuffTo ?? 1, (v) => { L.stuffTo = Math.min(1, Math.max(0, v)); }, { positive: false, min: 0, tip: 'How far down the line the stuffing goes, from the closed end: 50% = the top half' })),
      d.type === 'mltl' ? null : check('Mouth set in a baffle (flanged)', () => L.mouthFlanged, (v) => { L.mouthFlanged = v; }));
    if (d.type === 'mltl' && L.shape === 'rect') {
      // B. Brines's three MLTL shapes (driver position as a share of the length)
      const sdT = drvc().params.sd * d.count;
      const shape = (top, bottom, pos) => () => { L.h0 = top * sdT / L.width; L.hL = bottom * sdT / L.width; L.drvPos = pos; changed(true); };
      kids.push(h('div', { class: 'row-btns' },
        btn('Straight (4·Sd)', shape(4, 4, 0.25), 'btn small'),
        btn('Narrow top (TQWT)', shape(1, 4, 0.45), 'btn small'),
        btn('Wide top', shape(4, 1, 0.2), 'btn small')),
        h('p', { class: 'hint' }, 'Shapes from Bob Brines: straight 4·Sd with the driver at 0.25 of the length; narrow top 1·Sd → 4·Sd, driver at 0.40–0.50; wide top 4·Sd → 1·Sd, driver at 0.20. Drivers with Qts under about 0.35 usually suit the straight line. After a change, set the port length again on the End port card.'));
    }
    if (d.type === 'pipe') {
      kids.push(check('Open back (no rear chamber)', () => d.mount.rear === 'out', (v) => {
        if (v) { d._rear = d.chambers[0]; d.chambers = []; d.mount.rear = 'out'; }
        else { d.chambers = [d._rear || { id: 'R', name: 'Rear (sealed)', vol: 0.01, ql: 10, qa: 100, bracing: 0 }]; d.mount.rear = 'R'; }
      }, { structural: true }));
    }
    kids.push(liveText(() => {
      const q = E.quarterWave(L, 4);
      const a = E.lineAreas(L);
      if (d.type === 'mltl' && L.port) return 'Line alone (open end) ' + q[0].toFixed(0) + ' Hz; with the end port ' + E.mltlTuning(L).toFixed(1) + ' Hz · area ' + U.fmt('area', a.s0) + ' → ' + U.fmt('area', a.sL);
      return 'Resonances ' + q.map(x => x.toFixed(0)).join(', ') + ' Hz · area ' + U.fmt('area', a.s0) + ' → ' + U.fmt('area', a.sL);
    }, 'hint'));
    kids.push(h('p', { class: 'hint' }, 'The line is modelled as a stepped tube (48 segments; more when folded, to follow each turn). Stuffing uses a simplified loss model, so treat damping results as a guide.'));
    return card(d.type === 'pipe' ? 'Pipe' : 'Line', ...kids);
  }

  function foldBuildCard(d) {
    const host = h('div');
    const fill = () => {
      const { r, list } = foldCutList(d);
      const sz = (m) => U.system === 'imperial' ? GL.util.inchFraction(m) : (m * 100).toFixed(1) + ' cm';
      host.innerHTML = '';
      host.append(foldSvg(d), areaSvg(d),
        h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Panel'), h('th', null, 'Qty'), h('th', null, 'Size'))),
          h('tbody', null, list.map(p => h('tr', null, h('th', null, p.name), h('td', null, p.qty),
            h('td', null, p.tri ? sz(p.b) + ' × ' + sz(p.b) + ' triangle (cut a square strip corner to corner), ' + sz(p.a) + ' long' : sz(p.a) + ' × ' + sz(p.b)))))),
        h('p', { class: 'hint' }, 'Outside ' + ['W', 'H', 'D'].map(k => sz(r.ext[k])).join(' × ') + ' (W × H × D), ' + sz(r.t) + ' panels, butt joints. ' +
          'Legs along the path: ' + r.legs.map((g, i) => (i + 1) + ': ' + sz(g.len) + ' long, ' + sz(g.hA) + (Math.abs(g.hA - g.hB) > 1e-4 ? ' → ' + sz(g.hB) : '') + ' deep').join('; ') + '. ' +
          'Turn gaps ' + r.turns.map(x => sz(x.gap)).join(', ') + '. ' +
          r.dividers.map((dv, i) => 'Divider ' + (i + 1) + ': ' + sz(dv.zA) + ' behind the front at the ' + endName(r, 'A') + ', ' + sz(dv.zB) + ' at the ' + endName(r, 'B') + ', fixed to the ' + endName(r, dv.from) + '.').join(' ') +
          ' Driver centre ' + sz(r.drvAlong) + ' from the closed end, on the front baffle. ' +
          (r.port ? 'End port ' + portSize(r.port, sz) : 'Mouth ' + U.fmt('area', r.w * r.mouthH)) +
          (r.portAt > 0 ? ' in the back panel, its centre ' + sz(r.portAt) + ' from the ' + endName(r, r.mouthEnd) + ' inside' : r.mouthBack ? ' in the back panel at the ' + endName(r, r.mouthEnd) : ' through the ' + endName(r, r.mouthEnd) + ' panel') +
          (r.port ? ', centred on the last leg; a long port can run inside the leg' : '') + '.'),
        r.warn.length ? h('p', { class: 'hint warnline' }, r.warn.join(' ')) : null);
    };
    fill(); live.push(fill);
    return card('Folded line: side view and cut list', host);
  }
  function portSize(pt, sz) {
    return (pt.count > 1 ? pt.count + ' × ' : '') + (pt.shape === 'slot' ? sz(pt.w) + ' × ' + sz(pt.h) : 'Ø' + sz(pt.d)) + ', ' + sz(pt.len) + ' long';
  }
  function endName(r, end) {
    const f = r.fold, first = f.start === 'top';
    const isTop = (end === 'A') === first;
    return f.legs === 'vertical' ? (isTop ? 'top' : 'bottom') : (isTop ? 'left end' : 'right end');
  }

  function buildPanel(part = 'side') {
    const d = S.design, b = S.box;
    if (E.isHorn(d.type)) return hornBuildPanel();
    if (E.isLine(d.type)) {
      return [card('Line volume',
        liveText(() => {
          const l = G.lineLayout(d);
          return 'Air inside the line: ' + U.volBoth(l.air) + (l.rearGross ? ' · rear chamber gross ' + U.fmt('vol', l.rearGross) : '') +
            (d.type === 'mltl' && d.line.port ? ' · end port ' + portSize(d.line.port, (m) => U.fmt('len', m)) : '');
        }, 'live'),
        h('p', { class: 'hint' }, folded(d) ? 'Folded as set on the Enclosure tab.' : 'A straight line. A rectangular transmission line can be folded into a box on the Enclosure tab (Folding).'))]
        .concat(folded(d) ? [foldBuildCard(d)] : []);
    }
    const n = d.chambers.length;
    const lay = () => G.layout(d, b);
    const matOpts = G.MATERIALS.map(m => [m.id, m.name]);
    const material = card('Material',
      sel('Material', matOpts, () => b.material, (v) => {
        b.material = v;
        const m = G.MATERIALS.find(x => x.id === v);
        if (m.t) b.t = m.t;
        if (m.sub) b.sub = m.sub;
      }),
      b.material === 'custom' ? sel('Made of', Object.entries(GL.panels.SUBSTANCES).map(([k, v]) => [k, v.name]), () => b.sub || 'ply', (v) => { b.sub = v; }, { structural: true }) : null,
      (GL.panels.SUBSTANCES[b.sub] || {}).print ? h('div', { class: 'grid2' },
        nf('Solid skin each side', () => (b.print || {}).skin * 1000, (v) => { b.print = Object.assign({}, b.print, { skin: Math.max(0, v) / 1000 }); }, { unit: 'mm', digits: 2, structural: false, tip: 'Perimeters × line width, e.g. 3 × 0.4 mm' }),
        nf('Infill', () => (b.print || {}).infill * 100, (v) => { b.print = Object.assign({}, b.print, { infill: Math.max(0, Math.min(100, v)) / 100 }); }, { unit: '%', digits: 0, structural: false })) : null,
      uf('Thickness', 'thick', () => b.t, (v) => { b.t = v; b.material = 'custom'; }, { structural: true }),
      nf('Front baffle layers', () => b.layers, (v) => { b.layers = Math.max(1, Math.min(3, Math.round(v))); }, { digits: 0, min: 1 }),
      sel('Joints', [['butt', 'Butt joints (the simplest)'], ['rabbet', 'Rabbets, half the thickness deep'], ['mitre', 'Mitres (45° on every edge)']], () => b.joint || 'butt', (v) => { b.joint = v; }, { structural: true }),
      check('Terminal cup on the back', () => b.terminal && b.terminal.on, (v) => { b.terminal = Object.assign({ shape: 'square', size: 2.5 * U.IN }, b.terminal, { on: v }); }, { structural: true }),
      b.terminal && b.terminal.on ? h('div', { class: 'grid2' },
        sel('Cup', [['square', 'Square'], ['round', 'Round']], () => b.terminal.shape, (v) => { b.terminal.shape = v; }, { structural: true }),
        uf('Cutout size', 'len', () => b.terminal.size, (v) => { b.terminal.size = v; }, { tip: 'The hole the cup needs (square side or round diameter): check the cup\'s datasheet' })) : null,
      n > 1 ? sel('Chambers side by side', [['W', 'Across the width'], ['H', 'Stacked (height)']], () => b.split, (v) => { b.split = v; }) : null);

    const dims = dimsCard('Outside dimensions');

    const vt = h('div', { class: 'voltable' });
    const fill = () => {
      const l = lay();
      const v = (x) => x > 0 ? U.fmt('vol', x) : '–';
      const rows = l.chambers.map(c => h('tr', null, h('th', null, c.name),
        h('td', null, v(c.net)), h('td', null, v(c.disp.driver)), h('td', null, v(c.disp.ports)),
        h('td', null, v(c.disp.prs + c.disp.bracing)), h('td', { class: 'b' }, v(c.gross))));
      vt.innerHTML = '';
      vt.append(h('table', null,
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Net'), h('th', null, '+Driver'), h('th', null, '+Ports'), h('th', null, '+PR/brace'), h('th', null, 'Gross'))),
        h('tbody', null, rows)),
        h('p', { class: 'hint' }, 'Inside: ' + ['W', 'H', 'D'].map(k => U.fmt('len', l.int[k])).join(' × ') +
          ' · outside ' + U.fmt('vol', l.extVol) + ' → inside ' + U.fmt('vol', l.intVol) +
          ' (' + (100 * (1 - l.intVol / l.extVol)).toFixed(0) + '% is wood)'));
    };
    fill();
    live.push(fill);

    const cut = h('div', { class: 'voltable' });
    const fillCut = () => {
      const p = cutList();
      const sz = (m) => U.system === 'imperial' ? GL.util.inchFraction(m) : (m * 100).toFixed(1) + ' cm';
      const keys = {};
      for (const sp of sheetParts()) if (sp.key) keys[sp.name.replace(/^Divider .*/, 'Divider')] = (keys[sp.name.replace(/^Divider .*/, 'Divider')] ? keys[sp.name.replace(/^Divider .*/, 'Divider')] + ', ' : '') + sp.key;
      cut.innerHTML = '';
      cut.append(h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Panel'), h('th', null, 'Qty'), h('th', null, 'Size'))),
        h('tbody', null, p.list.map(r => h('tr', null, h('th', null, (keys[r.name] ? keys[r.name] + ' · ' : '') + r.name), h('td', null, r.qty),
          h('td', null, r.dowel ? 'Ø' + sz(r.b) + ' × ' + sz(r.a)
            : r.fillet ? sz(r.b) + ' × ' + sz(r.b) + ' block, ' + sz(r.a) + ' long, cove radius ' + sz(r.b)
            : sz(r.a) + ' × ' + sz(r.b) + (r.opening ? ', opening ' + sz(r.opening[0]) + ' × ' + sz(r.opening[1]) : '')))))),
        h('p', { class: 'hint' }, 'Sheet area ' + (U.system === 'imperial' ? (p.area / 0.09290304).toFixed(2) + ' ft²' : p.area.toFixed(2) + ' m²') +
          '. ' + jointNote() + ' Slot panels start at the inside face of the baffle (or divider). No saw kerf included.'));
    };
    fillCut();
    live.push(fillCut);
    const runs = d.ports;
    const portRuns = runs.length ? card('Port runs',
      liveText(() => runs.map(pt => {
        const f = portFit(pt);
        if (!f) return '';
        const notch = f.route.via ? '. Cut a ' + U.fmt('len', f.route.w) + ' × ' + U.fmt('len', f.route.span) + ' notch at the back of the divider for it to pass' : '';
        return pt.name + ': ' + GL.placement.describe(f.route, (x) => U.fmt('len', x)) + notch + (f.route.fits ? '' : ' (does not fit' + (f.route.short > 0 ? ': about ' + U.fmt('len', f.route.short) + ' too long for this chamber' : '') + ')');
      }).filter(Boolean).join('\n'), 'hint pre'),
      h('p', { class: 'hint' }, 'Round ports: lengths run along the centre line of the tube, through the middle of each bend; measure elbow fittings the same way. Slots: each run is measured to the centre of the corner. Panel sizes are in the cut list.')) : null;
    const printBtn = () => btn('Print build sheet', printBuildSheet, 'btn small');
    if (part === 'main') return [panelsCard(printBtn), sheetCard(), cutFilesCard(), card('Cut list', cut, h('div', { class: 'btnrow' }, printBtn())), card('Volume breakdown', vt), panelCard(), standingCard(), portRuns].filter(Boolean);
    return [material, dims, h('div', { class: 'btnrow' }, btn('Open the Build sheet', () => showView('build'), 'btn small'), printBtn())];
  }

  // ---------------------------------------------------------------- build sheet drawings
  // The cut list, with slot panels from the routed plan (folds, wall side, full span).
  function cutList() {
    const p0 = G.layout(S.design, S.box).panels;
    const slotPanels = R && R.plan ? R.plan.ports.filter(x => x.route.kind === 'slot').flatMap(x => x.route.panels) : null;
    const p = { list: p0.list, area: p0.area };
    if (slotPanels) {
      const merged = [];
      for (const sp of slotPanels) {
        const m = merged.find(r => r.name === sp.name && Math.abs(r.a - sp.a) < 1e-4 && Math.abs(r.b - sp.b) < 1e-4);
        if (m) m.qty += sp.qty || 1; else merged.push({ name: sp.name, qty: sp.qty || 1, a: sp.a, b: sp.b, fillet: sp.fillet });
      }
      p.list = p0.list.filter(r => !/ slot wall$/.test(r.name)).concat(merged);
      p.area = p.list.filter(r => !r.dowel && !r.fillet).reduce((s, r) => s + r.qty * r.a * r.b, 0);
    }
    return p;
  }
  const BS = () => GL.buildsheet;
  // how the outer panels go together, for the notes
  function jointNote() {
    const j = S.box.joint || 'butt', half = U.system === 'imperial' ? GL.util.inchFraction(S.box.t / 2) : Math.round(S.box.t * 500) + ' mm';
    if (j === 'mitre') return 'Mitred: every outer panel is its full outside size, with a 45° mitre on each edge that meets another panel.';
    if (j === 'rabbet') return 'Rabbeted: cut rabbets ' + half + ' deep and one thickness wide along the side edges of the top and bottom, and along the front and back edges of the top, bottom and sides. The sides sit in the top and bottom; the back and front sit in all four.';
    return 'Butt joints: the top and bottom run the full size, the sides fit between them, the front and back fit inside all four.';
  }
  // ports that don't fit: their panels and holes on the build sheet aren't real yet
  const unfitPorts = () => R && R.plan ? [...new Set(R.plan.ports.filter(p => p.route && !p.route.fits).map(p => p.pt.name))] : [];
  const unfitText = () => { const u = unfitPorts(); return u.length ? u.join(' and ') + (u.length > 1 ? ' do' : ' does') + ' not fit in this box, so ' + (u.length > 1 ? 'their' : 'its') + ' panels and holes here are not real. Fix it on the Enclosure tab before cutting.' : ''; };
  // every panel with its cutouts (drivers, radiators, ports, slot mouths, notches, windows)
  function sheetParts() {
    const dcut = BS().driverCutout(driver().params);
    return BS().panels({ list: cutList().list, box: S.box, plan: R && R.plan, layout: G.layout(S.design, S.box), design: S.design,
      drvCut: dcut, screws: BS().screws(driver().params, dcut.d), terminal: S.box.terminal });
  }
  // sizes to cut to: fractions of an inch, or whole millimetres
  const cutFmt = (m) => U.system === 'imperial' ? GL.util.inchFraction(m) : Math.round(m * 1000) + ' mm';
  function sheetCfg() {
    if (!S.box.sheet) S.box.sheet = U.system === 'imperial'
      ? { w: 96 * U.IN, h: 48 * U.IN, kerf: 0.125 * U.IN, rotate: true }
      : { w: 2.44, h: 1.22, kerf: 0.003, rotate: true };
    return S.box.sheet;
  }
  // one figure per panel: the drawing and where each cutout goes
  function panelFigure(p, biggest, widest) {
    const fig = h('figure', { class: 'bs-fig' });
    fig.append(h('figcaption', null, h('b', null, (p.key ? p.key + ' · ' : '') + p.name), ' × ' + p.qty + ' · ' + cutFmt(p.w) + ' × ' + cutFmt(p.h) + (p.view ? ' · ' + p.view : '')));
    const art = h('div', { class: 'bs-art' });
    art.innerHTML = BS().panelSvg(p, cutFmt, biggest);
    // all panels at one scale, so their sizes compare at a glance
    if (biggest) {
      // the drawing's own width (panel plus margin for the dimensions) against the widest one
      const pad = Math.max(6, biggest * 1000 * 0.04) * 4.2, vbw = (x) => x * 1000 + 1.6 * pad;
      art.style.width = Math.max(12, 100 * vbw(p.w) / vbw(widest)).toFixed(1) + '%';
    }
    fig.append(art);
    const rows = BS().holeRows(p, cutFmt);
    if (rows.length) fig.append(h('table', { class: 'bs-holes' }, h('tbody', null, rows.map(r => h('tr', null,
      h('td', { class: 'bs-n' }, String(r.n)), h('td', null, r.what), h('td', null, r.size), h('td', null, r.at))))));
    if (p.note) fig.append(h('p', { class: 'hint' }, p.note));
    return fig;
  }
  function panelsCard(printBtn) {
    const grid = h('div', { class: 'bs-grid' }), extra = h('p', { class: 'hint' }), warn = h('p', { class: 'warnline' });
    const fill = () => {
      grid.innerHTML = '';
      warn.textContent = unfitText();
      warn.hidden = !warn.textContent;
      const parts = sheetParts();
      const sheet = parts.filter(x => !x.stock), biggest = Math.max(...sheet.map(x => Math.max(x.w, x.h))), widest = Math.max(...sheet.map(x => x.w));
      for (const p of sheet) grid.append(panelFigure(p, biggest, widest));
      const stock = parts.filter(x => x.stock);
      extra.textContent = stock.length ? 'Also: ' + stock.map(x => x.qty + ' × ' + x.name + (x.dowel ? ', Ø' + cutFmt(x.h) + ' × ' + cutFmt(x.w) : ', ' + cutFmt(x.h) + ' square, ' + cutFmt(x.w) + ' long')).join('; ') + '.' : '';
    };
    live.push(fill);
    fill();
    const dc = BS().driverCutout(driver().params);
    return card('Panels', h('div', { class: 'btnrow' }, printBtn()), warn, grid, extra,
      h('p', { class: 'hint' }, 'Drawn to scale as you would mark them out: cutouts dashed in red and numbered, positions measured from the left and bottom edges to the centre of round holes (or the corner of square ones). ' +
        jointNote() + ' Dividers fit inside all four walls.' +
        (dc.est ? ' The driver cutout is estimated from its size: check it against the datasheet, or enter it on the Driver tab.' : '')));
  }
  function sheetCard() {
    const c = sheetCfg();
    const host = h('div', { class: 'bs-sheets' }), msg = h('p', { class: 'hint' });
    const fill = () => {
      const cfg = sheetCfg(), parts = sheetParts();
      const res = BS().nest(parts, cfg);
      host.innerHTML = '';
      res.sheets.forEach((sh, i) => {
        const art = h('div', { class: 'bs-art' });
        art.innerHTML = BS().sheetSvg(sh, res, cutFmt);
        host.append(h('figure', { class: 'bs-fig' }, h('figcaption', null, h('b', null, 'Sheet ' + (i + 1) + ' of ' + res.sheets.length)), art));
      });
      const key = parts.filter(p => p.key).map(p => p.key + ' ' + p.name + (p.qty > 1 ? ' × ' + p.qty : '')).join(' · ');
      msg.textContent = (res.sheets.length ? res.sheets.length + (res.sheets.length > 1 ? ' sheets' : ' sheet') + ' of ' + cutFmt(res.L) + ' × ' + cutFmt(res.S) + ', ' + cutFmt(cfg.kerf) + ' saw kerf between parts. ' : '') +
        (res.tooBig.length ? 'Too big for the sheet: ' + [...new Set(res.tooBig.map(x => x.it ? x.it.part.key : x.part.key + ' ' + x.part.name))].join(', ') + '. ' : '') + key;
    };
    live.push(fill);
    fill();
    return card('Sheet layout',
      h('div', { class: 'grid2' },
        uf('Sheet length', 'len', () => c.w, (v) => { c.w = v; }, { structural: false }),
        uf('Sheet width', 'len', () => c.h, (v) => { c.h = v; }, { structural: false }),
        uf('Saw kerf', 'len', () => c.kerf, (v) => { c.kerf = Math.max(0, v); }, { structural: false, positive: false, min: 0 }),
        check('Parts can turn (no grain to follow)', () => c.rotate !== false, (v) => { c.rotate = v; })),
      host, msg,
      h('p', { class: 'hint' }, 'A quick layout for buying material: parts in rows, the biggest first, with the kerf between them. Leave a little extra for squaring up the factory edges, and check the sheet\'s real thickness before cutting.'));
  }
  // DXF / SVG for a CNC or laser, STL for a 3D printer
  function cutFilesCard() {
    const CF = GL.cutfiles, base = () => (S.name || 'GetLow').replace(/[^\w.-]+/g, '_');
    const nested = () => BS().nest(sheetParts(), sheetCfg());
    const txt = (ext, mime, make) => () => {
      try { GL.util.downloadText(base() + ext, make(), mime); } catch (e) { console.error(e); toast('Could not make the file: ' + e.message, true); }
    };
    const stl = (ext, make) => () => {
      try { const tris = make(); GL.util.downloadBlob(base() + ext, CF.stlBinary(tris, S.name)); toast('STL: ' + tris.length.toLocaleString() + ' triangles, in millimetres.'); }
      catch (e) { console.error(e); toast('Could not make the STL: ' + e.message, true); }
    };
    const warn = h('p', { class: 'warnline' });
    const fill = () => { warn.textContent = unfitText(); warn.hidden = !warn.textContent; };
    live.push(fill); fill();
    return card('Cutting files', warn,
      h('h4', null, 'CNC router or laser cutter'),
      h('div', { class: 'btnrow' },
        btn('Panels (DXF)', txt('-panels.dxf', 'application/dxf', () => CF.dxfPanels(sheetParts())), 'btn small'),
        btn('Sheet layout (DXF)', txt('-sheets.dxf', 'application/dxf', () => CF.dxfSheets(nested())), 'btn small'),
        btn('Panels (SVG)', txt('-panels.svg', 'image/svg+xml', () => CF.svgPanels(sheetParts())), 'btn small ghost'),
        btn('Sheet layout (SVG)', txt('-sheets.svg', 'image/svg+xml', () => CF.svgSheets(nested())), 'btn small ghost')),
      h('p', { class: 'hint' }, 'In millimetres, on layers: OUTLINE (panel edges), CUTOUT (driver, port and other holes), PILOT (screw holes), NOTE (labels) and SHEET. Cut the holes first, then the outlines. Allow for your bit or kerf in the toolpath, not in the drawing. ' +
        (S.box.joint && S.box.joint !== 'butt' ? 'The drawings are the panels\' outer faces: cut the ' + (S.box.joint === 'mitre' ? 'mitres' : 'rabbets') + ' separately.' : '')),
      h('h4', null, '3D printer'),
      h('div', { class: 'btnrow' },
        btn('Panels laid flat (STL)', stl('-panels.stl', () => CF.stlFlat(sheetParts(), S.box.t)), 'btn small'),
        btn('Assembled box (STL)', stl('-box.stl', () => CF.stlBox(sheetParts(), Object.assign({}, S.box, { layout: G.layout(S.design, S.box) }))), 'btn small ghost')),
      h('p', { class: 'hint' }, 'In millimetres. "Panels laid flat" prints each piece on its side to glue up like a wooden box, the most reliable way. "Assembled box" is the shell as built (outer walls, baffle layers and dividers, with their holes) to print in one go or slice into parts; ports, braces and slot panels go in separately. For prints, set the wall thickness on the Material card to what you\'ll print.'));
  }

  // A page to print (or save as PDF): the design, the cut list, every panel and the sheet layout.
  function printBuildSheet() {
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const d = S.design, b = S.box, l = G.layout(d, b), parts = sheetParts(), list = cutList();
    const mat = (G.MATERIALS.find(m => m.id === b.material) || {}).name || 'Custom';
    const nestRes = BS().nest(parts, sheetCfg());
    const f3v = R && R.res ? f3(R.res, R) : null;
    const tunings = R ? R.model.ports.filter(pt => !pt.mouth).map(pt => pt.fb.toFixed(1) + ' Hz') : [];
    const kv = [
      ['Design', E.typeName(d.type)],
      ['Driver', d.count + ' × ' + DRV.library.name(driver()) + (d.count > 1 ? ', wired ' + d.wiring : '')],
      ['Outside', ['W', 'H', 'D'].map(k => cutFmt(b.ext[k])).join(' × ') + ' (width × height × depth)'],
      ['Inside', ['W', 'H', 'D'].map(k => cutFmt(l.int[k])).join(' × ')],
      ['Material', (b.material === 'custom' ? 'Custom, ' + cutFmt(b.t) + ' thick' : mat) + (b.layers > 1 ? ', front baffle ' + b.layers + ' layers' : '')],
      ...l.chambers.map(c => [c.name, U.fmt('vol', c.net) + ' net, ' + U.fmt('vol', c.gross) + ' gross' +
        (() => { const ch = d.chambers.find(x => x.id === c.id); const st = ch && ch.stuff; return st && st.mat && st.mat !== 'none' ? ' · stuffing: ' + (GL.standing.STUFF[st.mat] || {}).name + (GL.standing.STUFF[st.mat].fill ? ', ' + Math.round((st.fill || 0) * 100) + '% of the volume' : '') : ''; })()]),
      tunings.length ? ['Tuning', tunings.join(' / ')] : null,
      f3v && f3v.low ? ['F3', f3v.low.toFixed(1) + ' Hz'] : null].filter(Boolean);
    const runs = d.ports.map(pt => {
      const f = portFit(pt);
      return f ? pt.name + ': ' + GL.placement.describe(f.route, cutFmt) + (f.route.fits ? '' : ' (does not fit' + (f.route.short > 0 ? ': about ' + cutFmt(f.route.short) + ' too long for this chamber' : '') + ')') : '';
    }).filter(Boolean);
    const flat = parts.filter(p => !p.stock), biggest = Math.max(...flat.map(x => Math.max(x.w, x.h))), widest = Math.max(...flat.map(x => x.w));
    const padM = Math.max(6, biggest * 1000 * 0.04) * 4.2, vbw = (x) => x * 1000 + 1.6 * padM;
    const figs = flat.map(p => {
      const rows = BS().holeRows(p, cutFmt);
      return '<figure class="fig"><figcaption><b>' + esc((p.key ? p.key + ' · ' : '') + p.name) + '</b> × ' + p.qty + ' · ' + esc(cutFmt(p.w) + ' × ' + cutFmt(p.h)) + (p.view ? ' · ' + esc(p.view) : '') + '</figcaption>' +
        '<div style="width:' + Math.max(12, 100 * vbw(p.w) / vbw(widest)).toFixed(1) + '%">' + BS().panelSvg(p, cutFmt, biggest) + '</div>' +
        (rows.length ? '<table class="holes">' + rows.map(r => '<tr><td class="n">' + r.n + '</td><td>' + esc(r.what) + '</td><td>' + esc(r.size) + '</td><td>' + esc(r.at) + '</td></tr>').join('') + '</table>' : '') +
        (p.note ? '<p class="note">' + esc(p.note) + '</p>' : '') + '</figure>';
    }).join('');
    const stock = parts.filter(x => x.stock);
    const sheets = nestRes.sheets.map((sh, i) => '<figure class="fig sheet"><figcaption><b>Sheet ' + (i + 1) + ' of ' + nestRes.sheets.length + '</b></figcaption>' + BS().sheetSvg(sh, nestRes, cutFmt) + '</figure>').join('');
    const dc = BS().driverCutout(driver().params);
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(S.name || 'Build sheet') + ' build sheet</title><style>' +
      'body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;background:#fff;margin:24px auto;max-width:1000px;padding:0 16px}' +
      'h1{font-size:22px;margin:0 0 2px}h2{font-size:16px;margin:22px 0 8px;border-bottom:1px solid #ccc;padding-bottom:3px}' +
      '.sub{color:#555;margin:0 0 14px}table{border-collapse:collapse;width:100%}td,th{padding:3px 8px;border-bottom:1px solid #e3e3e3;text-align:left;vertical-align:top}' +
      'th{font-weight:600;width:24%}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.fig{margin:0;break-inside:avoid;page-break-inside:avoid}' +
      'figcaption{margin:0 0 4px}.holes td{font-size:12px}.holes .n{color:#c0392b;font-weight:700;width:1.5em}.note{color:#555;font-size:12px}' +
      '.warn{border:1.5px solid #c0392b;color:#c0392b;padding:6px 10px;border-radius:6px;font-weight:600}.sheet{margin-bottom:14px}.tick td:first-child{width:1.6em;font-size:16px}.bar{margin:0 0 12px}.bar button{font:inherit;padding:6px 14px}' +
      '@media print{.bar{display:none}body{margin:0}h2{break-after:avoid}}' + BS().CSS + '</style></head><body>' +
      '<div class="bar"><button onclick="print()">Print or save as PDF</button></div>' +
      '<h1>' + esc(S.name || 'Untitled design') + '</h1><p class="sub">Build sheet from GetLow · ' + esc(new Date().toLocaleDateString()) + ' · all sizes in ' + (U.system === 'imperial' ? 'inches (to 1/16")' : 'millimetres') + '</p>' +
      (unfitText() ? '<p class="warn">' + esc(unfitText()) + '</p>' : '') +
      '<h2>The design</h2><table>' + kv.map(([k, v]) => '<tr><th>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>').join('') + '</table>' +
      '<h2>Cut list</h2><table><tr><th>Panel</th><th>Qty</th><th>Size</th></tr>' + list.list.map(r => {
        const keys = parts.filter(p => p.key && (p.name === r.name || (r.name === 'Divider' && /^Divider/.test(p.name)))).map(p => p.key).join(', ');
        const size = r.dowel ? 'Ø' + cutFmt(r.b) + ' × ' + cutFmt(r.a) : r.fillet ? cutFmt(r.b) + ' square block, ' + cutFmt(r.a) + ' long' : cutFmt(r.a) + ' × ' + cutFmt(r.b) + (r.opening ? ', window ' + cutFmt(r.opening[0]) + ' × ' + cutFmt(r.opening[1]) : '');
        return '<tr><td>' + esc((keys ? keys + ' · ' : '') + r.name) + '</td><td>' + r.qty + '</td><td>' + esc(size) + '</td></tr>';
      }).join('') + '</table>' +
      '<p class="note">' + esc(jointNote()) + ' Dividers fit inside all four walls. No saw kerf included in the sizes.</p>' +
      '<h2>Panels</h2><p class="note">To scale. Cutouts are dashed and numbered; positions are from the left and bottom edges to the centre of round holes or the corner of square ones.' +
      (dc.est ? ' The driver cutout (Ø ' + esc(cutFmt(dc.d)) + ') is estimated: check it against the driver before cutting.' : '') + '</p>' +
      '<div class="grid">' + figs + '</div>' +
      (stock.length ? '<p>Also: ' + esc(stock.map(x => x.qty + ' × ' + x.name + (x.dowel ? ', Ø' + cutFmt(x.h) + ' × ' + cutFmt(x.w) : ', ' + cutFmt(x.h) + ' square, ' + cutFmt(x.w) + ' long')).join('; ')) + '.</p>' : '') +
      (runs.length ? '<h2>Ports</h2><table>' + runs.map(r => '<tr><td>' + esc(r) + '</td></tr>').join('') + '</table>' : '') +
      '<h2>Sheet layout</h2><p class="note">' + nestRes.sheets.length + ' × ' + esc(cutFmt(nestRes.L) + ' × ' + cutFmt(nestRes.S)) + ' sheet' + (nestRes.sheets.length > 1 ? 's' : '') + ', ' + esc(cutFmt(sheetCfg().kerf)) + ' kerf.' +
      (nestRes.tooBig.length ? ' Too big for the sheet: ' + esc([...new Set(nestRes.tooBig.map(x => x.part.key))].join(', ')) + '.' : '') + '</p>' + sheets +
      '<h2>Assembly</h2><table class="tick">' + [
        'Cut every panel and check them against the list before cutting any holes.',
        'Mark and cut the driver, radiator and port holes. Test-fit the drivers before gluing.',
        S.box.joint === 'mitre' ? 'Glue the mitred sides, top and bottom into a frame (band clamps help), then fit the dividers, braces and slot panels.'
          : S.box.joint === 'rabbet' ? 'Cut the rabbets, then glue the sides into the top and bottom and fit the dividers, braces and slot panels.'
          : 'Glue the sides between the top and bottom, then fit the dividers, braces and slot panels.',
        'Fit the back and front baffle inside the four walls. Seal every inside joint (glue fillet or caulk).',
        'Add the stuffing or lining, the terminal cup and the wiring, then mount the drivers with a gasket.',
        'Check for leaks: with the drivers in, push a cone gently. It should come back slowly in a sealed box.'].map(x => '<tr><td>☐</td><td>' + esc(x) + '</td></tr>').join('') + '</table>' +
      '</body></html>';
    // a full-screen preview with the page in a frame: works where pop-ups are blocked
    const file = (S.name || 'build-sheet').replace(/[^\w.-]+/g, '_') + '-build-sheet.html';
    const frame = h('iframe', { class: 'bs-frame', title: 'Build sheet preview' });
    frame.srcdoc = html.replace('<div class="bar"><button onclick="print()">Print or save as PDF</button></div>', '');
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const ov = h('div', { class: 'bs-overlay', role: 'dialog', 'aria-label': 'Build sheet' },
      h('div', { class: 'bs-bar' },
        h('b', null, 'Build sheet'),
        h('span', { class: 'hint' }, 'Print it, or choose "Save as PDF" in the print dialog.'),
        h('span', { style: { flex: '1' } }),
        btn('Print', () => frame.contentWindow.print(), 'btn'),
        btn('Save as page', () => GL.util.downloadText(file, html, 'text/html'), 'btn ghost'),
        btn('Close', close, 'btn ghost')),
      frame);
    document.body.append(ov);
    document.addEventListener('keydown', onKey);
  }

  // Build tab for horns: volumes plus a station table (area and height or
  // diameter along the path) to mark out a folded horn from.
  function hornBuildPanel() {
    const d = S.design, H = d.horn;
    const imp = U.system === 'imperial';
    const sz = (m) => imp ? GL.util.inchFraction(m) : (m * 100).toFixed(1) + ' cm';
    const summary = card('Horn volume',
      liveText(() => {
        const l = G.hornLayout(d);
        const ch = l.chambers.map(c => c.name + ' ' + U.fmt('dvol', c.gross) + ' gross').join(' · ');
        return 'Path ' + U.fmt('len', l.length) + ' · horn air ' + U.volBoth(l.air) + (ch ? ' · ' + ch : '') + ' · total ' + U.volBoth(l.total);
      }, 'live'),
      h('p', { class: 'hint' }, 'Inside volumes only. Panel thickness, bends and bracing come on top when you fold the horn into a cabinet.'));
    const shape = card('Cross-section',
      sel('Shape', [['rect', 'Rectangular, constant width (typical folded horn)'], ['round', 'Round']], () => H.shape, (v) => { H.shape = v; }),
      H.shape === 'rect' ? uf('Inside width', 'len', () => H.width, (v) => { H.width = v; }) : null);
    const tbl = h('div', { class: 'voltable' });
    const fill = () => {
      const l = G.hornLayout(d, 20);
      tbl.innerHTML = '';
      tbl.append(h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'From throat'), h('th', null, 'Area'), h('th', null, H.shape === 'rect' ? 'Inside height' : 'Inside diameter'))),
        h('tbody', null, l.table.map(r => h('tr', null, h('th', null, sz(r.x)), h('td', null, U.fmt('area', r.S)), h('td', null, sz(H.shape === 'rect' ? r.h : r.d)))))),
        h('p', { class: 'hint' }, H.shape === 'rect'
          ? 'Width stays ' + sz(H.width) + '; mark these heights along the centre line of the path.'
          : 'Diameters along the centre line of the path.'));
    };
    fill();
    live.push(fill);
    return [summary, shape, card('Build table', tbl)];
  }

  function signalPanel() {
    const s = S.signal, a = S.array;
    const listening = card('Listening position',
      h('p', { class: 'hint' }, 'Where the speaker stands and where you listen. Used by the side view, level against distance and the response at the listening position.'),
      h('div', { class: 'grid2' },
        sel('Placement', [['free', 'Free standing (no reflections)'], ['floor', 'Standing on the floor (floor reflection)'], ['both', 'Floor to ceiling (floor and ceiling reflections)']], () => a.place, (v) => { a.place = v; }),
        uf('Top of the speaker', 'room', () => a.top, (v) => { a.top = v; }, { structural: false, tip: 'Height of the top of the box (or of the line) above the floor' }),
        a.place === 'both' ? uf('Ceiling height', 'room', () => a.ceiling, (v) => { a.ceiling = v; }, { structural: false }) : null,
        uf('Listener distance', 'room', () => a.listen.d, (v) => { a.listen.d = v; }, { structural: false }),
        uf('Ear height', 'room', () => a.listen.h, (v) => { a.listen.h = v; }, { structural: false }),
        sel('Smoothing (SPL chart)', [['0', 'None (pure tone)'], ['12', '1/12 octave'], ['6', '1/6 octave'], ['3', '1/3 octave']], () => String(a.smooth || 0), (v) => { a.smooth = +v; }, { structural: false })),
      check('Show the response at the listening position on the SPL chart', () => listenOn(), (v) => { a.listenOn = v; }));
    return [listening,
      card('Amplifier',
        sel('Set input by', [['volts', 'Voltage'], ['watts', 'Power into nominal impedance']], () => s.mode, (v) => { s.mode = v; }),
        s.mode === 'volts'
          ? uf('Voltage (RMS)', 'volt', () => s.volts, (v) => { s.volts = v; })
          : uf('Power', 'watt', () => s.watts, (v) => { s.watts = v; }),
        liveText(() => R && R.sig ? R.sig.V.toFixed(2) + ' V · ' + R.sig.W.toFixed(1) + ' W into ' + R.sig.znomTot.toFixed(2) + ' Ω nominal' : '', 'hint')),
      card('Subsonic (high-pass) filter',
        check('Enabled', () => s.hp.on, (v) => { s.hp.on = v; }),
        uf('Frequency', 'freq', () => s.hp.f, (v) => { s.hp.f = v; }),
        sel('Slope', SLOPES, () => String(s.hp.order), (v) => { s.hp.order = v === 'lr4' ? v : +v; }, { structural: false })),
      card('Low-pass filter (crossover)',
        check('Enabled', () => s.lp.on, (v) => { s.lp.on = v; }),
        uf('Frequency', 'freq', () => s.lp.f, (v) => { s.lp.f = v; }),
        sel('Slope', SLOPES, () => String(s.lp.order), (v) => { s.lp.order = v === 'lr4' ? v : +v; }, { structural: false }),
        h('p', { class: 'hint' }, 'Like the LPF on a sub amp. It shapes every chart, and max SPL drops where it cuts.')),
      eqCard(),
      xoCard(),
      lsCard(),
      card('Max SPL limits',
        h('p', { class: 'hint' }, 'Max SPL always stops at Xmax and the driver\'s power rating.'),
        check('Also stop when port or line-mouth air speed reaches', () => s.airLimit.on, (v) => { s.airLimit.on = v; }),
        nf('Air speed (peak)', () => s.airLimit.v, (v) => { s.airLimit.v = v; }, { unit: 'm/s', digits: 0, positive: true }),
        h('p', { class: 'hint' }, 'The simulation is linear, so on its own it has no port compression. Without this limit, resonant designs (pipes, lines, high-Q bandpass) can show max SPL that is impossible in practice. 34 m/s ≈ 10% of the speed of sound. WinISD has no such limit, so turn this off to compare max SPL with it.')),
      card('Cabin gain',
        check('Add car cabin gain to SPL', () => s.cabin.on, (v) => { s.cabin.on = v; }),
        uf('Corner frequency', 'freq', () => s.cabin.f, (v) => { s.cabin.f = v; }),
        uf('Maximum gain', 'db', () => s.cabin.max, (v) => { s.cabin.max = v; }),
        h('p', { class: 'hint' }, '+12 dB/octave below the corner, capped. Typical cars: 35–60 Hz corner.')),
      card('Frequency range',
        h('div', { class: 'grid2' },
          uf('From', 'freq', () => s.fmin, (v) => { s.fmin = Math.max(1, Math.min(v, s.fmax / 2)); }),
          uf('To', 'freq', () => s.fmax, (v) => { s.fmax = Math.min(20000, Math.max(v, s.fmin * 2)); }))),
    ];
  }

  // ---------------------------------------------------------------- EQ
  function eqCard() {
    const eq = S.signal.eq, lt = eq.lt, fc = sealedFcQ();
    const host = h('div', { class: 'roomchart eqchart' });
    let ch = null;
    const draw = () => {
      if (!host.isConnected) return;
      if (!ch) ch = new GL.Chart(host);
      const fr = Array.from(GL.util.logspace(Math.max(5, S.signal.fmin), Math.min(20000, Math.max(S.signal.fmax, 200)), 160));
      const all = fr.map(f => 20 * Math.log10(X.cabs(chainH(2 * Math.PI * f))));
      const only = fr.map(f => 20 * Math.log10(X.cabs(GL.eq.response(2 * Math.PI * f, eq))));
      ch.set({ title: 'Signal chain', fileTitle: S.name, series: [{ name: 'Filters and EQ', color: SERIES[0], x: fr, y: all }, { name: 'EQ alone', color: 'var(--text-secondary)', x: fr, y: only, dash: '5 4' }],
        refs: [{ y: 0, label: '0 dB' }], ylabel: 'Gain', unit: 'dB', xRange: [fr[0], fr[fr.length - 1]], digits: 1 });
    };
    live.push(draw);
    requestAnimationFrame(draw);
    const boostNote = liveText(() => {
      if (!GL.eq.active(eq)) return 'No EQ on.';
      const b = GL.eq.maxBoost(eq, S.signal.fmin, S.signal.fmax);
      return b.db > 0.05 ? 'Most boost: +' + b.db.toFixed(1) + ' dB at ' + b.f.toFixed(0) + ' Hz. The amp needs ' + Math.pow(10, b.db / 10).toFixed(1) + '× the power there; max SPL and excursion include it.' : 'The EQ only cuts.';
    }, 'hint');
    const bandRow = (b, i) => h('div', { class: 'eqband' },
      h('div', { class: 'grid2' },
        check('Band ' + (i + 1), () => b.on, (v) => { b.on = v; }),
        sel('Type', [['peak', 'Peak / dip'], ['lowshelf', 'Low shelf'], ['highshelf', 'High shelf']], () => b.type, (v) => { b.type = v; }, { structural: false }),
        uf('Frequency', 'freq', () => b.f, (v) => { b.f = v; }),
        uf('Gain', 'db', () => b.gain, (v) => { b.gain = Math.max(-30, Math.min(20, v)); }, { positive: false }),
        nf('Q', () => b.q, (v) => { b.q = Math.max(0.1, Math.min(20, v)); }, { digits: 2, positive: true })),
      h('div', { class: 'btnrow' }, btn('Remove', () => { eq.bands.splice(i, 1); changed(true); }, 'btn ghost small')));
    return card('EQ',
      h('h4', null, 'Linkwitz transform'),
      h('p', { class: 'hint' }, 'Makes a sealed box behave like one with a lower Fc and a different Q, using boost from the amp: the classic way to get deep, flat bass from a small sealed sub.'),
      check('On', () => lt.on, (v) => { lt.on = v; }),
      h('div', { class: 'grid2' },
        uf('Box Fc (from)', 'freq', () => lt.f0, (v) => { lt.f0 = v; }),
        nf('Box Qtc (from)', () => lt.q0, (v) => { lt.q0 = Math.max(0.2, v); }, { digits: 2, positive: true }),
        uf('Target Fc', 'freq', () => lt.fp, (v) => { lt.fp = v; }),
        nf('Target Q', () => lt.qp, (v) => { lt.qp = Math.max(0.2, v); }, { digits: 3, positive: true })),
      fc ? h('div', { class: 'btnrow' }, btn('Use this box (Fc ' + fc.fc.toFixed(1) + ' Hz, Qtc ' + fc.qtc.toFixed(2) + ')', () => { lt.f0 = +fc.fc.toFixed(1); lt.q0 = +fc.qtc.toFixed(3); changed(true); }, 'btn small')) : null,
      h('h4', null, 'Parametric bands'),
      ...eq.bands.map(bandRow),
      h('div', { class: 'btnrow' }, btn('Add a band', () => { eq.bands.push({ on: true, type: 'peak', f: 50, gain: -3, q: 2 }); changed(true); }, 'btn small')),
      boostNote,
      host,
      h('p', { class: 'hint' }, 'Like a DSP or a plate amp\'s EQ, ahead of the amp. Every chart follows it: a boost raises excursion and needs more power, so watch Xmax and max SPL.'));
  }

  // ---------------------------------------------------------------- power compression and large signal
  function lsCard() {
    const ls = S.signal.ls;
    return card('Power compression and large signal',
      h('p', { class: 'hint' }, 'The main curves are the small-signal model: they scale straight up with power. Real drivers don\'t. Tick these to see the difference at the drive level set above.'),
      check('Voice coil heating (power compression)', () => ls.heat, (v) => { ls.heat = v; }, { structural: true }),
      ls.heat ? h('div', null,
        h('div', { class: 'grid2' },
          sel('What you play', [['music', 'Music (about 1/8 of the amp\'s power over time)'], ['noise', 'Pink noise (about 1/2)'], ['sine', 'A steady tone (all of it)']], () => ls.duty, (v) => { ls.duty = v; }, { structural: false }),
          sel('Voice coil wire', [['cu', 'Copper'], ['al', 'Aluminium (CCAW)']], () => ls.coil, (v) => { ls.coil = v; }, { structural: false }),
          nf('Coil temperature rise at rated power', () => ls.rise, (v) => { ls.rise = Math.max(20, Math.min(300, v)); }, { unit: '°C', digits: 0, positive: true, tip: 'Typical: 150–200 °C for subwoofers with good venting, more for small drivers' })),
        liveText(() => {
          const hc = R && R.hot && R.hot.coil;
          return hc ? 'At this drive: ' + hc.P.toFixed(1) + ' W into each coil over time, the coil runs ' + hc.dT.toFixed(0) + ' °C hotter, Re ' + drvc().model.Re.toFixed(2) + ' → ' + hc.re.toFixed(2) + ' Ω: about ' + hc.db.toFixed(1) + ' dB where the impedance is near Re, and the driver\'s Q rises.' : '';
        }, 'hint')) : null,
      check('BL and suspension changing with excursion', () => ls.big, (v) => { ls.big = v; }, { structural: true }),
      ls.big ? h('div', null,
        h('div', { class: 'grid2' },
          nf('BL at Xmax', () => ls.bl * 100, (v) => { ls.bl = Math.max(30, Math.min(100, v)) / 100; }, { unit: '% of rest', digits: 0, positive: true }),
          nf('Stiffness at Xmax', () => ls.kms, (v) => { ls.kms = Math.max(1, Math.min(4, v)); }, { unit: '× rest', digits: 2, positive: true })),
        h('p', { class: 'hint' }, 'Defaults follow Klippel\'s Xmax: where BL has fallen to 82% or the suspension is a third stiffer. With a measured BL(x) or Kms(x), set them from that. Shown to 2 kHz; excursion matters most low down, where the curves bend over.'),
        drvc().model.Xmax > 0 ? null : h('p', { class: 'warn' }, 'Needs the driver\'s Xmax.')) : null);
  }

  // ---------------------------------------------------------------- passive crossover
  // the woofer's own figures for the whole design (count and wiring)
  function wooferRL() {
    const dc = drvc(), N = Math.max(1, S.design.count), ser = S.design.wiring === 'series';
    const k = ser ? N : 1 / N;
    return { R: R && R.sig ? R.sig.znomTot : dc.model.znom * k, re: (dc.params.re || dc.model.re || 6) * k, le: (dc.params.le || 0) * k };
  }
  // Networks for each way, designed for each driver's nominal load.
  function xoNetworks() {
    const x = S.signal.xo, XO = GL.crossover, w = wooferRL();
    const twR = Math.max(x.tw.re * 1.15, 2), midR = Math.max(x.mid.re * 1.15, 2);
    const three = x.ways === 3;
    return {
      woofer: XO.wayParts({ lp: { al: x.al, f: x.f1 }, R: w.R, zobel: x.zobel, re: w.re, le: w.le }),
      mid: three ? XO.wayParts({ hp: { al: x.al, f: x.f1 }, lp: { al: x.al, f: x.f2 }, R: midR, pad: x.mid.pad }) : null,
      tweeter: XO.wayParts({ hp: { al: x.al, f: three ? x.f2 : x.f1 }, R: twR, pad: x.tw.pad }),
    };
  }
  // SPL of each way and of the sum, and the amp's load, on the design's frequencies
  let xoCache = null;
  function xoCurves() {
    if (!R || !R.res || !S.signal.xo.on) return null;
    const key = R.res;
    if (xoCache && xoCache.key === key && xoCache.state === JSON.stringify(S.signal.xo)) return xoCache.out;
    const x = S.signal.xo, XO = GL.crossover, res = R.res, nets = xoNetworks();
    const V = R.sig.V, f = Array.from(res.f), n = f.length;
    const tw = XO.smallDriver(x.tw), mid = x.ways === 3 ? XO.smallDriver(x.mid) : null;
    const out = { f, w: new Array(n), t: new Array(n), m: mid ? new Array(n) : null, sum: new Array(n), z: new Array(n), nets };
    const db = (p) => 20 * Math.log10(Math.max(1e-12, X.cabs(p)) / 20e-6);
    const par = (a, b) => X.cdiv(X.cmul(a, b), X.cadd(a, b));
    for (let i = 0; i < n; i++) {
      const wv = 2 * Math.PI * f[i];
      // woofer: the simulated design (its pressure and impedance), through its network
      const zW = X.C(res.zmag[i] * Math.cos(res.zph[i] * Math.PI / 180), res.zmag[i] * Math.sin(res.zph[i] * Math.PI / 180));
      const amp = 20e-6 * Math.pow(10, res.spl[i] / 20), lag = -wv * (x.offset || 0) / GL.phys.c;
      const pW0 = X.C(amp * Math.cos(res.phase[i] + lag), amp * Math.sin(res.phase[i] + lag));
      const sw = XO.solve(nets.woofer, zW, wv);
      const pW = X.cmul(pW0, sw.H);
      const st = XO.solve(nets.tweeter, tw.z(wv), wv);
      const pT = X.cscale(X.cmul(tw.p(wv), st.H), V * (x.tw.invert ? -1 : 1));
      let pS = X.cadd(pW, pT), zin = par(sw.Zin, st.Zin);
      if (mid) {
        const sm = XO.solve(nets.mid, mid.z(wv), wv);
        const pM = X.cscale(X.cmul(mid.p(wv), sm.H), V * (x.mid.invert ? -1 : 1));
        out.m[i] = db(pM);
        pS = X.cadd(pS, pM);
        zin = par(zin, sm.Zin);
      }
      out.w[i] = db(pW); out.t[i] = db(pT); out.sum[i] = db(pS); out.z[i] = X.cabs(zin);
    }
    xoCache = { key, state: JSON.stringify(x), out };
    return out;
  }
  function xoCard() {
    const x = S.signal.xo, XO = GL.crossover;
    const small = (t, label) => [
      h('h4', null, label),
      h('div', { class: 'grid2' },
        uf('Sensitivity (2.83 V, 1 m)', 'db', () => t.sens, (v) => { t.sens = v; }, { positive: false }),
        uf('Fs (in its chamber)', 'freq', () => t.fs, (v) => { t.fs = v; }),
        nf('Qts (in its chamber)', () => t.qts, (v) => { t.qts = Math.max(0.2, v); }, { digits: 2, positive: true }),
        nf('Re', () => t.re, (v) => { t.re = Math.max(0.5, v); }, { unit: 'Ω', digits: 2, positive: true }),
        nf('Le', () => t.le * 1000, (v) => { t.le = Math.max(0, v) / 1000; }, { unit: 'mH', digits: 3, positive: false }),
        nf('Impedance peak', () => t.zmax, (v) => { t.zmax = Math.max(t.re * 1.2, v); }, { unit: 'Ω', digits: 1, positive: true }),
        uf('Level cut (L-pad)', 'db', () => t.pad, (v) => { t.pad = Math.max(0, Math.min(20, v)); }, { positive: false }),
        check('Wired reversed', () => t.invert, (v) => { t.invert = v; }))];
    const parts = h('div', { class: 'voltable' });
    const fmtPart = (p) => {
      const v = p.type === 'L' ? (p.value * 1000).toFixed(3) + ' mH' : p.type === 'C' ? (p.value * 1e6).toFixed(2) + ' µF' : p.type === 'R' ? p.value.toFixed(2) + ' Ω' : p.value.toFixed(2) + ' Ω + ' + (p.c * 1e6).toFixed(2) + ' µF';
      const p2 = (v) => String(+v.toPrecision(2));
      const near = p.type === 'L' ? p2(XO.nearest(p.value * 1000, XO.E24)) + ' mH' : p.type === 'C' ? p2(XO.nearest(p.value * 1e6)) + ' µF' : p.type === 'R' ? p2(XO.nearest(p.value)) + ' Ω' : p2(XO.nearest(p.value)) + ' Ω + ' + p2(XO.nearest(p.c * 1e6)) + ' µF';
      return [p.role || { L: 'Coil', C: 'Capacitor', R: 'Resistor', RC: 'Zobel' }[p.type], p.at === 'series' ? 'in series' : 'across', v, near];
    };
    const fill = () => {
      parts.innerHTML = '';
      if (!x.on || !R || !R.res) return;
      const nets = xoNetworks(), xo = xoCurves();
      const rows = [];
      for (const [name, net] of [['Woofer', nets.woofer], ['Mid', nets.mid], ['Tweeter', nets.tweeter]]) {
        if (!net) continue;
        rows.push(h('tr', null, h('th', { colspan: 4 }, name + ' (amp side first)')));
        net.forEach(p => { const r = fmtPart(p); rows.push(h('tr', null, h('td', null, r[0]), h('td', null, r[1]), h('td', null, r[2]), h('td', null, r[3]))); });
      }
      const zmin = xo ? Math.min(...xo.z.filter(isFinite)) : 0;
      parts.append(h('table', null, h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', null, 'Where'), h('th', null, 'Value'), h('th', null, 'Nearest stock value'))), h('tbody', null, rows)),
        h('p', { class: 'hint' }, 'The amp sees as little as ' + zmin.toFixed(1) + ' Ω. Parts are designed for each driver\'s nominal load, then the response is simulated with its real impedance. Use air-core coils with low resistance and film capacitors; a coil\'s own resistance lowers that way\'s level a little.'));
    };
    live.push(fill); fill();
    return card('Passive crossover',
      h('p', { class: 'hint' }, 'For 2- and 3-way speakers: the design\'s driver is the woofer; give the tweeter (and mid) a few figures from their datasheets. The SPL chart shows each way through its network and the sum; the impedance chart shows what the amp sees.'),
      check('On', () => x.on, (v) => { x.on = v; if (v && S.signal.fmax < 20000) S.signal.fmax = 20000; }, { structural: true }),
      x.on ? h('div', null,
        h('div', { class: 'grid2' },
          sel('Ways', [['2', '2-way'], ['3', '3-way']], () => String(x.ways), (v) => { x.ways = +v; }, { structural: true }),
          sel('Slopes', XO.ALIGN, () => x.al, (v) => { x.al = v; }, { structural: false }),
          uf(x.ways === 3 ? 'Woofer to mid' : 'Crossover', 'freq', () => x.f1, (v) => { x.f1 = v; }),
          x.ways === 3 ? uf('Mid to tweeter', 'freq', () => x.f2, (v) => { x.f2 = Math.max(v, x.f1 * 1.5); }) : null,
          check('Zobel on the woofer', () => x.zobel, (v) => { x.zobel = v; }),
          uf('Woofer sits behind the tweeter', 'len', () => x.offset, (v) => { x.offset = Math.max(0, v); }, { positive: false, tip: 'Acoustic centre: about the depth of the cone at its middle, on a flat baffle' })),
        h('p', { class: 'hint' }, x.al === 'lr2' || x.al === 'bw2' ? 'Second-order slopes usually need the tweeter wired reversed to sum flat: try it both ways.' : x.al === 'bw3' ? 'Third-order: the two ways are 90° apart at the crossover in either polarity; listen for which sounds better.' : ''),
        ...(x.ways === 3 ? small(x.mid, 'Mid') : []),
        ...small(x.tw, 'Tweeter'),
        h('h4', null, 'Parts'),
        parts) : null);
  }

  // ---------------------------------------------------------------- your data
  // Projects and drivers live in this browser's storage. One file holds all of
  // them; restoring only adds (nothing is replaced or deleted).
  function backupData() {
    const projs = projects.map(p => p.id === activeId ? projectJson() : JSON.parse(p.text));
    return { getlow: 'backup', version: 1, saved: new Date().toISOString(), app: GL.VERSION || '',
      projects: projs, drivers: DRV.library.list.filter(d => !d.sample), units: S.units };
  }
  function backupAll() {
    const o = backupData();
    GL.util.downloadText('getlow-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(o), 'application/json');
    try { localStorage.setItem('getlow.lastBackup', new Date().toISOString()); } catch (e) { /* blocked */ }
    toast('Backed up ' + o.projects.length + (o.projects.length === 1 ? ' project' : ' projects') + ' and ' + o.drivers.length + (o.drivers.length === 1 ? ' driver.' : ' drivers.'));
    if (S.tab === 'tools') renderSide();
  }
  function restoreBackup(o) {
    let nd = 0, np = 0;
    for (const d of o.drivers || []) {
      if (!d || !d.id || !d.params || DRV.library.get(d.id)) continue;
      DRV.library.list.push(d); nd++;
    }
    DRV.library.save();
    const had = !!activeProj();
    for (const p of o.projects || []) {
      if (!p || !p.state || !p.state.design) continue;
      addProject(p, { select: false }); np++;
    }
    if (!had && projects.length) selectProject(projects[0].id, true);
    else { renderProjectTabs(); renderSide(); }
    saveWorkspace();
    toast('Restored ' + np + (np === 1 ? ' project' : ' projects') + ' (as new tabs) and ' + nd + (nd === 1 ? ' driver' : ' drivers') + ' not already in your library.');
  }
  // ask the browser to keep GetLow's storage when space runs low (installed apps usually get it)
  async function keepStorage() {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { /* not offered */ }
  }
  async function storageNote() {
    const bits = [];
    try {
      if (navigator.storage && navigator.storage.persisted) bits.push(await navigator.storage.persisted()
        ? 'This browser has agreed to keep GetLow\'s storage.'
        : 'This browser may clear GetLow\'s storage if space runs low or you clear browsing data.');
    } catch (e) { /* unknown */ }
    let last = null;
    try { last = localStorage.getItem('getlow.lastBackup'); } catch (e) { /* blocked */ }
    bits.push(last ? 'Last backup ' + new Date(last).toLocaleDateString() + '.' : 'No backup made from this browser yet.');
    return bits.join(' ');
  }
  function dataCard() {
    const note = h('p', { class: 'hint' });
    storageNote().then(t => { note.textContent = t; });
    const pick = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
      const f = pick.files[0];
      pick.value = '';
      if (!f) return;
      try {
        const o = JSON.parse(await GL.util.readFileText(f));
        if (!o || o.getlow !== 'backup') throw new Error('not a GetLow backup');
        restoreBackup(o);
      } catch (e) { toast('Could not restore ' + f.name + ': ' + e.message, true); }
    } });
    return card('Your data',
      h('p', { class: 'hint' }, 'Projects and your driver library are kept in this browser only. Back them up to a file now and then, and to move them to another computer or browser.'),
      h('div', { class: 'btnrow' }, btn('Back up everything', backupAll, 'btn'), btn('Restore from a backup…', () => pick.click(), 'btn ghost'), pick),
      note,
      h('p', { class: 'hint' }, 'Restoring adds the backup\'s projects as new tabs and any drivers you don\'t already have. Nothing is replaced or deleted.'));
  }

  // ---------------------------------------------------------------- about and what's new
  function aboutDialog(onlyNew) {
    const dlg = document.getElementById('aboutdlg');
    let seen = null;
    try { seen = localStorage.getItem('getlow.seenVersion'); } catch (e) { /* blocked */ }
    const list = onlyNew ? GL.CHANGES.filter(c => !seen || cmpVer(c.v, seen) > 0) : GL.CHANGES;
    dlg.innerHTML = '';
    dlg.append(
      h('div', { class: 'dlg-head' }, h('h3', null, onlyNew ? 'What\'s new in GetLow ' + GL.VERSION : 'GetLow ' + GL.VERSION),
        h('button', { class: 'btn ghost small', onclick: () => dlg.close() }, 'Close')),
      onlyNew ? null : h('p', { class: 'hint' }, 'Subwoofer and speaker enclosure design. Free and open source (MIT licence). Driver data from OpenISD (MIT) and the makers\' published specifications.'),
      ...list.map(c => h('div', { class: 'changes' }, h('h4', null, c.v + (c.date ? ' · ' + new Date(c.date + 'T12:00').toLocaleDateString() : '')),
        h('ul', null, c.items.map(t => h('li', null, t))))));
    try { localStorage.setItem('getlow.seenVersion', GL.VERSION); } catch (e) { /* blocked */ }
    dlg.showModal();
  }
  const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
  // once after an update (not on a first visit: nothing is new then)
  function newsAfterUpdate() {
    let seen = null;
    try { seen = localStorage.getItem('getlow.seenVersion'); } catch (e) { return; }
    const used = (() => { try { return !!localStorage.getItem(WKEY); } catch (e) { return false; } })();
    if (!seen && !used) { try { localStorage.setItem('getlow.seenVersion', GL.VERSION); } catch (e) { /* blocked */ } return; }
    if (!seen || cmpVer(GL.VERSION, seen) > 0) aboutDialog(true);
  }

  function toolsPanel() {
    const t = S.tools.pipe;
    const speed = () => 331.3 * Math.sqrt(1 + t.tempC / 273.15);
    const corr = () => (t.flanged ? 0.8216 : 0.6133) * t.d / 2;
    const effLen = () => t.ends === 'co' ? t.len + corr() : t.len + 2 * corr();
    const harmonic = (k) => t.ends === 'co' ? (2 * k - 1) * speed() / (4 * effLen()) : k * speed() / (2 * effLen());
    const tempField = U.system === 'imperial'
      ? field('Air temperature', '°F', (c) => c * 9 / 5 + 32, (f) => (f - 32) * 5 / 9, 0, () => t.tempC, (v) => { t.tempC = v; })
      : field('Air temperature', '°C', (c) => c, (c) => c, 0, () => t.tempC, (v) => { t.tempC = v; });
    return [dataCard(), roomCard(), measureCard(), card('Pipe resonance calculator',
      sel('Pipe ends', [['co', 'One end closed (quarter-wave)'], ['oo', 'Both ends open (half-wave)']], () => t.ends, (v) => { t.ends = v; }),
      uf('Length', 'len', () => t.len, (v) => { t.len = v; }),
      uf('Inside diameter', 'len', () => t.d, (v) => { t.d = v; }),
      tempField,
      check('Open end in a baffle (flanged)', () => t.flanged, (v) => { t.flanged = v; }),
      liveText(() => 'Speed of sound ' + speed().toFixed(1) + ' m/s · end correction ' + U.fmt('len', corr()) + (t.ends === 'oo' ? ' per end' : ''), 'hint'),
      liveText(() => [1, 2, 3, 4, 5, 6].map(k => (t.ends === 'co' ? (2 * k - 1) : k) + '× ' + harmonic(k).toFixed(1) + ' Hz').join('\n'), 'live pre'),
      h('h4', null, 'Length for a target frequency'),
      uf('Fundamental', 'freq', () => t.target, (v) => { t.target = v; }),
      liveText(() => {
        const L = (t.ends === 'co' ? speed() / (4 * t.target) - corr() : speed() / (2 * t.target) - 2 * corr());
        return 'Cut the pipe to ' + U.fmt('len', L) + (U.system === 'imperial' ? ' (' + GL.util.inchFraction(L) + ')' : '');
      }, 'live'),
      h('p', { class: 'hint' }, 'Same physics as online pipe calculators: f = (2n−1)·c / 4L for closed-open, f = n·c / 2L for open-open, with end correction. For a driver loaded pipe, use the Pipe / tube enclosure type to see the full response.'))];
  }


  // ---------------------------------------------------------------- room modes and placement
  const ROOM_TOP = 200;          // the modal model is only meant for the bass
  const roomPlace = () => {
    const r = S.room, cl = (v, a) => Math.min(a, Math.max(0, v));
    const pt = (p) => ({ x: cl(p.x, r.L), y: cl(p.y, r.W), z: cl(p.z, r.H) });
    return { sub: pt(r.sub), seat: pt(r.seat), count: r.count, mirror: r.mirror };
  };
  // SPL at the seat: the design's 1 m curve plus what the room does to it.
  function roomOverlay(f, spl) {
    const idx = [], fr = [];
    f.forEach((v, i) => { if (v <= ROOM_TOP) { idx.push(i); fr.push(v); } });
    if (!fr.length) return null;
    const pl = roomPlace(), h = GL.room.response(S.room, GL.room.subsFor(S.room, pl), pl.seat, fr);
    const y = Array.from(f, () => NaN);
    idx.forEach((i, k) => { y[i] = spl[i] + h[k]; });
    return y;
  }

  function roomCard(part = 'side') {
    const r = S.room, RM = GL.room;
    const len = (label, get, set, tip) => uf(label, 'room', get, set, { structural: false, tip });
    const hzf = (label, k) => uf(label, 'freq', () => r[k], (v) => { r[k] = v; }, { structural: false });
    const ns = (v) => U.fmt('room', v);
    let scanKey = '', scanRes = null;
    const map = h('div', { class: 'roommap' });
    const bestText = h('div', { class: 'live lines' });
    const chartHost = h('div', { class: 'roomchart' });
    let roomChart = null;
    const modesBox = h('div', { class: 'voltable' });

    const fill = () => {
      const pl = roomPlace(), subs = RM.subsFor(r, pl);
      // placement map
      const key = JSON.stringify([r.L, r.W, r.H, r.rt60, pl, r.move, r.f0, r.f1]);
      if (key !== scanKey) { scanKey = key; scanRes = r.f1 > r.f0 ? RM.scan(r, pl, r.move, r.f0, r.f1) : null; }
      map.innerHTML = '';
      bestText.textContent = '';
      if (scanRes) {
        const NS = 'http://www.w3.org/2000/svg', sv = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
        const svg = sv('svg', { viewBox: `0 0 ${r.W} ${r.L}`, class: 'roomsvg', role: 'img', 'aria-label': 'Top view of the room: stronger colour is smoother bass at the seat' });
        // shade by the spots that count (right beside the seat is always smooth and would wash the rest out)
        const sds = scanRes.cells.filter(c => !c.near).map(c => c.sd), lo = Math.min(...sds), hi = Math.max(...sds);
        for (const c of scanRes.cells) {
          const rect = sv('rect', { x: c.y - scanRes.dy / 2, y: c.x - scanRes.dx / 2, width: scanRes.dy, height: scanRes.dx, class: 'cell',
            'fill-opacity': (0.06 + 0.84 * Math.min(1, Math.max(0, 1 - (c.sd - lo) / (hi - lo || 1)))).toFixed(3) });
          const t = sv('title', {});
          t.textContent = ns(c.x) + ' from the front wall, ' + ns(c.y) + ' from the left: ±' + c.sd.toFixed(1) + ' dB. Click to put the ' + r.move + ' here.';
          rect.append(t);
          rect.addEventListener('click', () => { Object.assign(r[r.move], { x: c.x, y: c.y }); changed(false); });
          svg.append(rect);
        }
        const b = scanRes.best || scanRes.cells[0];
        svg.append(sv('rect', { x: b.y - scanRes.dy / 2, y: b.x - scanRes.dx / 2, width: scanRes.dy, height: scanRes.dx, class: 'best' }));
        svg.append(sv('rect', { x: 0, y: 0, width: r.W, height: r.L, class: 'walls' }));
        const u = Math.max(r.L, r.W) * 0.022;
        for (const p of subs) svg.append(sv('rect', { x: p.y - u, y: p.x - u, width: 2 * u, height: 2 * u, class: 'sub' }));
        svg.append(sv('circle', { cx: pl.seat.y, cy: pl.seat.x, r: 1, class: 'nearseat' }));
        svg.append(sv('circle', { cx: pl.seat.y, cy: pl.seat.x, r: u * 1.1, class: 'seat' }));
        map.append(h('div', { class: 'roomcap' }, 'Front wall'), svg,
          h('div', { class: 'roomkey' }, h('span', { class: 'k sub' }), 'Sub', h('span', { class: 'k seat' }), 'Seat',
            h('span', { class: 'k best' }), 'Smoothest spot', h('span', { class: 'k nearseat' }), 'Too close to judge', h('span', { class: 'k grad' }), 'Stronger colour = smoother bass'));
        const now = RM.evenness(RM.response(r, subs, pl.seat, RM.band(r.f0, r.f1)));
        const what = r.move === 'seat' ? 'seat' : r.count === 2 ? 'first sub (the second mirrors it)' : 'sub';
        bestText.textContent = 'Now: ±' + now.sd.toFixed(1) + ' dB from ' + r.f0.toFixed(0) + ' to ' + r.f1.toFixed(0) + ' Hz at the seat.\n' +
          'Smoothest spot for the ' + what + ': ' + ns(b.x) + ' from the front wall, ' + ns(b.y) + ' from the left wall (±' + b.sd.toFixed(1) + ' dB' +
          (Math.abs(b.mean - now.mean) >= 1 ? ', ' + (b.mean > now.mean ? '+' : '') + (b.mean - now.mean).toFixed(1) + ' dB average level' : '') + '). ' +
          'Spots within ' + ns(1) + ' of the seat are left out.';
      }
      // response at the seat
      if (R && R.res) {
        if (!roomChart) roomChart = new GL.Chart(chartHost);
        const f = R.res.f, spl = Array.from(R.res.spl);
        const y = roomOverlay(f, spl);
        roomChart.set({ series: [
          { name: 'In the room, at the seat', color: SERIES[0], x: f, y },
          { name: 'Outdoors, at 1 m', color: 'var(--text-secondary)', x: f, y: spl, dash: '5 4' }],
          refs: [], ylabel: 'SPL', unit: 'dB', span: 60, xRange: [Math.max(10, S.signal.fmin), ROOM_TOP], digits: 1 });
      }
      // mode list
      modesBox.innerHTML = '';
      const fs = RM.schroeder(r);
      const list = RM.modes(r, Math.min(ROOM_TOP, Math.max(100, fs))).filter(m => m.kind !== 'room gain').slice(0, 24);
      const at = (m, ps) => Math.abs(ps.reduce((s, p) => s + Math.cos(m.n[0] * Math.PI * p.x / r.L) * Math.cos(m.n[1] * Math.PI * p.y / r.W) * Math.cos(m.n[2] * Math.PI * p.z / r.H), 0) / ps.length);
      const word = (v) => v >= 0.7 ? 'strong' : v <= 0.25 ? 'null' : 'some';
      const close = new Set();
      list.forEach((m, i) => { if (i && m.f / list[i - 1].f < 1.04) { close.add(i); close.add(i - 1); } });
      modesBox.append(h('table', null,
        h('thead', null, h('tr', null, ['Hz', 'Mode', 'Type', r.count === 2 ? 'Subs' : 'Sub', 'Seat'].map(x => h('th', null, x)))),
        h('tbody', null, list.map((m, i) => h('tr', { class: m.kind === 'axial' ? '' : 'miss' },
          h('th', null, m.f.toFixed(1) + (close.has(i) ? ' •' : '')), h('td', null, m.n.join(',')), h('td', null, m.kind),
          h('td', null, word(at(m, subs))), h('td', null, word(at(m, [pl.seat]))))))));
      const pairs = list.filter((m, i) => close.has(i) && !close.has(i - 1)).map(m => m.f.toFixed(0) + ' Hz');
      modesBox.append(h('p', { class: 'hint' }, 'Axial modes (one pair of walls) are the strongest; tangential and oblique ones are greyed. ' +
        '"Strong" means the sub or seat sits on a pressure peak of that mode, "null" in its dead spot, so a mode needs both to be loud. ' +
        (pairs.length ? '• marks modes within 4% of each other, which stack into one strong boom (around ' + pairs.join(', ') + '). ' : '') +
        'Above about ' + fs.toFixed(0) + ' Hz (the Schroeder frequency for this room) the modes overlap and placement matters much less.'));
    };
    if (part === 'main') {
      live.push(fill);
      // draw once the cards are in the page, so the chart can size itself
      requestAnimationFrame(fill);
      return [card('Placement map', map, bestText),
        card('At the seat', chartHost, h('p', { class: 'hint' }, 'The design\'s response at the seat in this room, next to its outdoor response at 1 m.')),
        card('Room modes', modesBox)];
    }
    return card('Room modes and placement',
      h('p', { class: 'hint' }, 'Your box at the seat, in a rectangular room. The room\'s standing waves add peaks and nulls below about 200 Hz that often matter more than the box. Move the sub or the seat on the map to find the smoothest spot.'),
      h('div', { class: 'grid2' },
        len('Length (front to back)', () => r.L, (v) => { r.L = v; }), len('Width', () => r.W, (v) => { r.W = v; }),
        len('Ceiling height', () => r.H, (v) => { r.H = v; })),
      sel('Room', [['0.6', 'Live: bare walls, hard floor'], ['0.4', 'Average living room'], ['0.25', 'Well damped: heavy furnishing or bass traps']],
        () => String(r.rt60), (v) => { r.rt60 = +v; }, { structural: false }),
      h('h4', null, 'Sub'),
      sel('Subs', [['1', 'One sub'], ['2w', 'Two, mirrored across the width'], ['2l', 'Two, mirrored front to back'], ['2b', 'Two, in opposite corners']],
        () => r.count === 2 ? '2' + r.mirror[0] : '1', (v) => { r.count = v === '1' ? 1 : 2; r.mirror = { w: 'width', l: 'length', b: 'both' }[v[1]] || r.mirror; }, { structural: false }),
      h('div', { class: 'grid2' },
        len('From the front wall', () => r.sub.x, (v) => { r.sub.x = v; }, 'To the centre of the driver'),
        len('From the left wall', () => r.sub.y, (v) => { r.sub.y = v; }, 'Facing the front wall'),
        len('Driver height', () => r.sub.z, (v) => { r.sub.z = v; })),
      h('h4', null, 'Seat'),
      h('div', { class: 'grid2' },
        len('From the front wall', () => r.seat.x, (v) => { r.seat.x = v; }),
        len('From the left wall', () => r.seat.y, (v) => { r.seat.y = v; }),
        len('Ear height', () => r.seat.z, (v) => { r.seat.z = v; })),
      h('h4', null, 'Placement map'),
      sel('Move', [['sub', 'The sub (seat stays put)'], ['seat', 'The seat (sub stays put)']], () => r.move, (v) => { r.move = v; }, { structural: false }),
      h('div', { class: 'grid2' }, hzf('Judge from', 'f0'), hzf('to', 'f1')),
      check('Show the response at the seat on the SPL chart', () => r.onMain, (v) => { r.onMain = v; }),
      h('div', { class: 'btnrow' }, btn('Open the Room view', () => showView('room'), 'btn small')),
      h('p', { class: 'hint' }, 'A model of an empty, closed, rectangular room with even damping: open doorways, L-shaped rooms, soft walls and big furniture shift the details, so confirm with a measurement at the seat. The heights stay where you set them; the map moves things across the floor.'));
  }

  // ---------------------------------------------------------------- measure your own T/S
  function measureCard() {
    const m = S.tools.measure;
    const ohm = (label, k, tip) => nf(label, () => m[k], (v) => { m[k] = v; }, { unit: 'Ω', digits: 2, positive: true, structural: false, tip });
    const hz = (label, k, tip) => uf(label, 'freq', () => m[k], (v) => { m[k] = v; }, { structural: false, tip });
    const drv = driver();
    const input = () => {
      const sd = m.sdFrom === 'driver' ? drv.params.sd : (m.dEff > 0 ? GL.measure.sdFromDiameter(m.dEff) : NaN);
      const need = [m.re, m.fs, m.zmax, m.f1, m.f2, sd].concat(m.method === 'box' ? [m.vb, m.fc, m.zc, m.f1c, m.f2c] : [m.mass, m.fs2]);
      if (!need.every(v => isFinite(v) && v > 0)) return null;
      return { method: m.method, re: m.re, fs: m.fs, zmax: m.zmax, f1: m.f1, f2: m.f2, sd,
        added: { mass: m.mass, fs2: m.fs2 }, box: { vb: m.vb, fc: m.fc, zmax: m.zc, f1: m.f1c, f2: m.f2c } };
    };
    const solve = () => { const i = input(); return i ? GL.measure.solve(i) : null; };
    const target = (zmax) => m.re > 0 && zmax > 0 ? ' Find f1 and f2 where the impedance is ' + Math.sqrt(m.re * zmax).toFixed(2) + ' Ω.' : '';
    const results = h('div', { class: 'voltable' });
    const fillResults = () => {
      results.innerHTML = '';
      const r = solve();
      if (!r) { results.append(h('p', { class: 'hint' }, 'Fill in every reading above to see the results.')); return; }
      const ds = DRV.complete(drv.params);
      const rows = [
        ['Fs', r.fs, ds.params.fs, (v) => v.toFixed(1) + ' Hz'], ['Qts', r.qts, ds.derived.qts || ds.params.qts, (v) => v.toFixed(3)],
        ['Qes', r.qes, ds.params.qes, (v) => v.toFixed(3)], ['Qms', r.qms, ds.params.qms, (v) => v.toFixed(2)],
        ['Vas', r.vas, ds.params.vas, (v) => U.fmt('vol', v)], ['Mms', r.mms, ds.model.Mms, (v) => (v * 1000).toFixed(1) + ' g'],
        ['Cms', r.cms, ds.model.Cms, (v) => (v * 1000).toFixed(3) + ' mm/N'], ['BL', r.BL, ds.model.BL, (v) => v.toFixed(2) + ' T·m'],
        ['Re', r.re, ds.params.re, (v) => v.toFixed(2) + ' Ω'], ['Sd', r.sd, ds.params.sd, (v) => U.fmt('area', v)]];
      results.append(
        h('table', null, h('thead', null, h('tr', null, ['', 'Measured', DRV.library.name(drv) + ' datasheet', 'Difference'].map(x => h('th', null, x)))),
          h('tbody', null, rows.map(([k, a, b, f]) => h('tr', null, h('th', null, k), h('td', null, f(a)), h('td', null, isFinite(b) ? f(b) : '–'),
            h('td', null, isFinite(b) && b ? ((d) => (d > 0 ? '+' : '') + d + '%')(Math.round((a / b - 1) * 100) || 0) : '–'))))),
        ...r.notes.map(([lvl, t]) => h('p', { class: lvl === 'warn' ? 'warn' : 'hint' }, t)),
        r.ok ? h('div', { class: 'btnrow' }, btn('Save as a new driver', () => saveMeasured(r), 'btn primary')) : null);
    };
    live.push(fillResults);
    fillResults();
    const zr = () => isFinite(m.R) && isFinite(m.vs) && isFinite(m.vd) && m.vs > m.vd ? GL.measure.zFromVoltages(m.R, m.vs, m.vd) : NaN;
    return card('Measure your own T/S',
      h('p', { class: 'hint' }, 'Check a driver against its datasheet (or measure one that has none) with an impedance sweep. Use a DATS or REW, or a tone generator, a resistor and a meter (see below). Let the driver hang in free air, away from walls, and run it for a few minutes first so the suspension loosens up.'),
      sel('Method', [['added', 'Added mass (stick a known mass on the cone)'], ['box', 'Test box (a sealed box of known volume)']], () => m.method, (v) => { m.method = v; }),
      h('h4', null, '1. Free air'),
      h('div', { class: 'grid2' },
        ohm('Re (DC resistance, from a meter)', 're', 'Measure across the terminals with a multimeter; subtract the meter leads.'),
        hz('Fs (frequency of the impedance peak)', 'fs'),
        ohm('Zmax (impedance at the peak)', 'zmax'),
        hz('f1 (below the peak)', 'f1'), hz('f2 (above the peak)', 'f2')),
      liveText(() => target(m.zmax), 'hint'),
      h('h4', null, m.method === 'box' ? '2. In the test box' : '2. With added mass'),
      m.method === 'box'
        ? [h('div', { class: 'grid2' },
            uf('Box volume (net, inside)', 'vol', () => m.vb, (v) => { m.vb = v; }, { structural: false, tip: 'Air inside the box with the driver mounted, minus the driver and any bracing' }),
            hz('Fc (new impedance peak)', 'fc'), ohm('Zmax in the box', 'zc'), hz('f1 in the box', 'f1c'), hz('f2 in the box', 'f2c')),
          liveText(() => target(m.zc), 'hint'),
          h('p', { class: 'hint' }, 'Seal the driver to the box face-down or on a cutout; the box should raise the resonance by 25% or more.')]
        : [h('div', { class: 'grid2' },
            uf('Mass added', 'mass', () => m.mass, (v) => { m.mass = v; }, { structural: false, tip: 'Weigh it on a kitchen or jewellery scale' }),
            hz('Fs with the mass on', 'fs2')),
          h('p', { class: 'hint' }, 'Spread putty or coins evenly around the cone near the voice coil; aim for roughly the cone\'s own moving mass so Fs drops by 25 to 40%.')],
      h('h4', null, '3. Cone area'),
      sel('Sd', [['driver', 'Use the datasheet Sd of ' + DRV.library.name(drv)], ['diameter', 'From the effective cone diameter I measured']], () => m.sdFrom, (v) => { m.sdFrom = v; }),
      m.sdFrom === 'diameter' ? [uf('Effective cone diameter', 'len', () => m.dEff, (v) => { m.dEff = v; }, { structural: false }),
        h('p', { class: 'hint' }, 'Measure across the cone including about a third of the surround on each side.')] : null,
      h('h4', null, 'Results'),
      results,
      h('details', null, h('summary', null, 'Measuring impedance with a resistor and a meter'),
        h('p', { class: 'hint' }, 'Put a resistor (about 1 kΩ) in series with the driver and feed a sine tone from an amplifier. Measure the AC voltage across resistor + driver (Vs) and across the driver alone (Vd). Sweep to find the peak (Fs, highest Vd), then the two frequencies where the impedance falls to the target shown above.'),
        h('div', { class: 'grid2' },
          nf('Resistor', () => m.R, (v) => { m.R = v; }, { unit: 'Ω', digits: 0, structural: false }),
          uf('Vs (resistor + driver)', 'volt', () => m.vs, (v) => { m.vs = v; }, { structural: false }),
          uf('Vd (driver)', 'volt', () => m.vd, (v) => { m.vd = v; }, { structural: false })),
        liveText(() => isFinite(zr()) ? 'Impedance at that frequency: ' + zr().toFixed(2) + ' Ω' : '', 'live')));
  }

  function saveMeasured(r) {
    const lib = DRV.library, src = driver();
    const method = S.tools.measure.method === 'box' ? 'test box' : 'added mass';
    // keep what the measurement doesn't cover (Le, Xmax, power, size) from the datasheet
    const params = Object.assign({}, src.params, { fs: r.fs, qes: r.qes, qms: r.qms, qts: NaN, vas: r.vas, sd: r.sd, re: r.re,
      BL: r.BL, Mms: r.mms, Cms: r.cms, Rms: 2 * Math.PI * r.fs * r.mms / r.qms });
    const d = lib.add({ id: GL.util.uid('drv'), brand: src.brand, model: src.model + ' (measured)', vc: src.vc,
      comment: 'Measured with ' + method + ' on ' + new Date().toISOString().slice(0, 10) + '. Le, Xmax, power and size are from the datasheet.',
      source: 'Measured (' + method + ')', params });
    S.driverId = d.id;
    toast('Saved ' + lib.name(d) + ' and selected it. Compare it with the datasheet version using "Compare: keep curve".');
    changed(true);
  }

  // ---------------------------------------------------------------- main area
  function renderMain() {
    const sum = document.getElementById('summary');
    sum.innerHTML = '';
    if (R.error) {
      sum.append(h('div', { class: 'chip err' }, h('b', null, 'Cannot simulate'), h('span', null, R.error)));
      document.getElementById('warnings').innerHTML = '';
      return;
    }
    for (const [k, v, sub] of R.summary) sum.append(h('div', { class: 'chip' }, h('span', { class: 'k' }, k), h('b', null, v), h('span', { class: 's' }, sub)));

    const warn = document.getElementById('warnings');
    warn.innerHTML = '';
    for (const [lvl, text] of R.warnings) warn.append(h('div', { class: 'w ' + lvl }, h('span', { class: 'ic' }, lvl === 'warn' ? '!' : 'i'), text));

    renderChartTabs();
    drawChart();
    if (view) {
      if (R.layout) view.update({ kind: 'box', design: S.design, box: S.box, layout: R.layout, drvc: R.drvc, xray: S.xray, explode: S.explode });
      else if (R.hornLay) view.update({ kind: 'horn', design: S.design, hornLay: R.hornLay, drvc: R.drvc });
      else view.update({ kind: 'line', design: S.design, lineLay: R.lineLay, drvc: R.drvc, fold: folded(S.design) ? G.lineFold(S.design) : null });
    }
    const dimEl = document.getElementById('dims3d');
    dimEl.textContent = R.layout
      ? ['W', 'H', 'D'].map(k => k + ' ' + U.fmt('len', S.box.ext[k])).join(' · ')
      : R.hornLay ? 'Horn path ' + U.fmt('len', R.hornLay.length) + ', shown unfolded'
      : folded(S.design) ? (() => { const e = G.lineFold(S.design).ext; return ['W', 'H', 'D'].map(k => k + ' ' + U.fmt('len', e[k])).join(' · ') + ' · line ' + U.fmt('len', S.design.line.length) + ' folded'; })()
      : 'Line ' + U.fmt('len', S.design.line.length);
    document.getElementById('title').textContent = DRV.library.name(driver()) + ' · ' + E.typeName(S.design.type);
  }

  function renderChartTabs() {
    const el = document.getElementById('chart-tabs');
    el.innerHTML = '';
    const vents = R && R.model ? R.model.ports.length : S.design.ports.length;
    for (const c of CHARTS) {
      if (c.id === 'vel' && !vents) continue;
      el.append(h('button', { class: 'tab' + (S.chart === c.id ? ' on' : ''), onclick: () => { S.chart = c.id; renderChartTabs(); drawChart(); } }, c.name));
    }
    if (S.chart === 'vel' && !vents) S.chart = 'spl';
  }

  function seriesData(res, id) {
    const f = res.f;
    const withCabin = (a) => Array.from(a, (v, i) => v + cabinDb(f[i]));
    switch (id) {
      case 'spl': return withCabin(res.spl);
      case 'max': return withCabin(res.maxSpl);
      case 'imp': return Array.from(res.zmag);
      case 'exc': return Array.from(res.xpk);
      case 'vel': return res.portVel.length ? Array.from(f, (_, i) => Math.max(...res.portVel.map(p => p.v[i]))) : null;
      case 'gd': return Array.from(res.gd);
    }
  }

  function drawChart() {
    if (!R || !R.res) return;
    const c = CHARTS.find(x => x.id === S.chart);
    const res = R.res;
    const me = activeProj();
    const series = [{ name: (S.name || 'This design') + (c.id === 'vel' ? ' at ' + R.sig.V.toFixed(2) + ' V' : ''), color: SERIES[me ? me.slot % SERIES.length : 0], x: res.f, y: seriesData(res, c.id) }];
    for (const p of projects) {
      if (p.id === activeId || !p.show || !p.curves || !p.curves.data[c.id]) continue;
      series.push({ name: projName(p), color: SERIES[p.slot % SERIES.length], x: p.curves.f, y: p.curves.data[c.id] });
    }
    for (const it of S.saved) {
      const y = it.show && it.data && it.data[c.id];
      if (y) series.push(Object.assign({ name: it.name, x: it.f, y }, savedLook(it)));
    }
    if (R.hot && (c.id === 'spl' || c.id === 'max' || c.id === 'exc' || c.id === 'imp')) {
      const y = seriesData(R.hot, c.id);
      series.push({ name: 'Voice coil hot (+' + R.hot.coil.dT.toFixed(0) + ' °C)', color: 'var(--warn)', x: R.hot.f, y, dash: '4 3' });
    }
    if (R.big && (c.id === 'spl' || c.id === 'exc')) {
      const y = c.id === 'spl' ? R.big.spl.map((v, j) => v + cabinDb(R.big.f[j])) : R.big.xpk;
      series.push({ name: 'Large signal (BL and suspension changing)', color: 'var(--series-4)', x: R.big.f, y, dash: '8 3' });
    }
    if ((c.id === 'spl' || c.id === 'imp') && S.signal.xo.on) {
      const xo = xoCurves();
      if (xo && c.id === 'spl') {
        const cab = (arr) => arr.map((v, j) => v + cabinDb(xo.f[j]));
        series.push({ name: 'With crossover: woofer', color: 'var(--series-2)', x: xo.f, y: cab(xo.w), dash: '6 3' });
        if (xo.m) series.push({ name: 'With crossover: mid', color: 'var(--series-4)', x: xo.f, y: cab(xo.m), dash: '6 3' });
        series.push({ name: 'With crossover: tweeter', color: 'var(--series-3)', x: xo.f, y: cab(xo.t), dash: '6 3' });
        series.push({ name: 'With crossover: all together', color: 'var(--text-primary)', x: xo.f, y: cab(xo.sum), dash: '' });
      }
      if (xo && c.id === 'imp') series.push({ name: 'With crossover: what the amp sees', color: 'var(--text-primary)', x: xo.f, y: xo.z, dash: '' });
    }
    (S.meas || []).forEach((m, i) => {
      if (!m.show || (c.id === 'spl' ? m.kind !== 'frd' : c.id === 'imp' ? m.kind !== 'zma' : true)) return;
      series.push({ name: m.name + ' (measured)', color: measColor(i), x: m.f, y: m.kind === 'frd' ? m.y.map(v => v + (m.offset || 0)) : m.y, dash: '1 3' });
    });
    if (matchRes) matchRes.rows.forEach((r, i) => {
      const y = r.show && r.res ? seriesData(r.res, c.id) : null;
      if (y) series.push(Object.assign({ name: '#' + (i + 1) + ' ' + r.entry.name, x: r.res.f, y }, matchLook(i)));
    });
    const refs = [];
    const extra = (name, y, dash) => series.push({ name, color: 'var(--text-secondary)', x: res.f, y, dash });
    if (c.id === 'spl' && S.contrib && res.contrib.length > 1) {
      res.contrib.forEach((ct, i) => extra(ct.label, Array.from(ct.spl, (v, j) => v + cabinDb(res.f[j])), ['5 4', '2 3', '8 3 2 3'][i % 3]));
    }
    if (c.id === 'spl' && res.offAxis) {
      res.offAxis.forEach((oa, i) => extra(oa.angle + '° off axis', Array.from(oa.spl, (v, j) => v + cabinDb(res.f[j])), ['6 3', '3 3', '10 3 2 3', '1 3'][i % 4]));
    }
    if (c.id === 'spl' && listenOn()) {
      const y = arrayAtListener(res);
      const what = S.array.on ? 'Line array (' + Math.round(S.array.n) + (S.array.tw.on ? ' + ' + Math.round(S.array.tw.n) + ' tweeters' : ' drivers') + ')' : 'This design';
      if (y) series.push({ name: what + ' at ' + U.fmt('room', S.array.listen.d) + (S.array.smooth ? ', 1/' + S.array.smooth + ' oct' : ''), color: 'var(--text-primary)', x: res.f, y, dash: '' });
      if (y && S.array.tw.on) {
        extra('Main line (low-passed)', arrayAtListener(res, 'main'), '5 4');
        extra('Tweeter line', arrayAtListener(res, 'tweeters'), '2 3');
      }
    }
    if (c.id === 'spl' && S.room.onMain) {
      const y = roomOverlay(res.f, seriesData(res, 'spl'));
      if (y) series.push({ name: 'In the room, at the seat', color: 'var(--text-primary)', x: res.f, y });
    }
    if (c.id === 'exc') {
      if (R.drvc.model.Xmax > 0) refs.push({ y: R.drvc.model.Xmax * 1000, label: 'Xmax ' + (R.drvc.model.Xmax * 1000).toFixed(1) + ' mm' });
      res.prX.forEach((p, i) => extra(p.label, Array.from(p.x), ['5 4', '2 3'][i % 2]));
    }
    if (c.id === 'vel') {
      const lim = E.portSpeedLimits(R.model.ports[0] && R.model.ports[0].cfg);
      refs.push({ y: lim.quiet, label: lim.quiet.toFixed(0) + ' m/s quiet' }, { y: lim.loud, label: lim.loud.toFixed(0) + ' m/s chuffing' });
      if (res.portVel.length > 1) res.portVel.forEach((p, i) => extra(p.label, Array.from(p.v), ['5 4', '2 3', '8 3 2 3'][i % 3]));
      res.portVel.forEach((p, i) => extra(p.label + ' at full power', Array.from(p.full), ['6 3', '3 3', '9 3 2 3'][i % 3]));
    }
    chart.set({ series, refs, title: c.title || c.label || c.ylabel, fileTitle: S.name, ylabel: c.ylabel, unit: c.unit, span: c.span, zero: c.zero, xRange: [S.signal.fmin, S.signal.fmax], digits: c.id === 'imp' ? 2 : 1 });
    document.getElementById('contrib').style.display = c.id === 'spl' && res.contrib.length > 1 ? '' : 'none';
  }

  // Top of the band the speaker plays: the low-pass (plus a half octave), or the
  // chart's top. Woofers 7" and up with no low-pass set are taken as subs (200 Hz).
  const isSubSize = () => driver().params.sd >= 0.02;
  const playTop = () => S.signal.lp.on ? S.signal.lp.f * 1.5 : isSubSize() ? Math.min(S.signal.fmax, 200) : S.signal.fmax;
  const topNote = () => !S.signal.lp.on && isSubSize() ? ' (no low-pass is set on the Signal tab, so a woofer this size is taken as a sub played up to 200 Hz)' : '';
  // The band the speaker plays: from F3 up to that top.
  const playBand = () => {
    const f3v = R && R.res ? f3(R.res, R).low : null;
    return [f3v || S.signal.fmin, playTop()];
  };

  function panelCard() {
    const b = S.box;
    const box = h('div', { class: 'voltable' });
    const fill = () => {
      box.innerHTML = '';
      const [f0, f1] = playBand();
      const list = GL.panels.panelModes(b, G.layout(S.design, b), f0, f1);
      const hz = (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0);
      box.append(h('table', null,
        h('thead', null, h('tr', null, ['Panel', 'Free span', 'First resonance', 'Q', ''].map(x => h('th', null, x)))),
        h('tbody', null, list.map(p => h('tr', { class: p.inBand ? '' : 'miss' },
          h('th', null, p.name + (p.qty > 1 ? ' ×' + p.qty : '')),
          h('td', null, U.fmt('len', p.a, 1) + ' × ' + U.fmt('len', p.b, 1)),
          h('td', null, hz(p.lo) + '–' + hz(p.hi) + ' Hz'),
          h('td', null, p.q.toFixed(0)),
          h('td', null, p.rings ? 'rings in band' : p.inBand ? 'in band' : ''))))));
      const sub = GL.panels.SUBSTANCES[b.sub] || GL.panels.SUBSTANCES.ply;
      const tips = [];
      if (list.some(p => p.rings)) tips.push(sub.name + ' barely damps itself (Q ' + (1 / sub.eta).toFixed(0) + '), so in-band panels ring like a bell. Stick a damping layer on them (bitumen or butyl pad, or a constrained layer: a thin sheet glued on with viscoelastic adhesive), or brace them to push the resonance above the band.');
      else if (list.some(p => p.inBand)) tips.push('Panels marked "in band" resonate where the speaker plays. Bracing (the Enclosure tab), a thicker wall or damping pads move or tame them.');
      if (sub.print) tips.push('3D prints: more perimeters stiffen a wall more than more infill. Thin or low-infill walls can leak air, which acts like a small extra port and loses bass: seal the inside (epoxy or a coat of paint) and test that it holds pressure.');
      box.append(h('p', { class: 'hint' }, 'First bending mode of each wall\'s free span (between corners and dividers; bracing not counted), from simply supported to clamped edges; glued joints sit nearer the top. Greyed panels resonate outside the band the speaker plays (' +
        f0.toFixed(0) + ' Hz to ' + (f1 >= 1000 ? (f1 / 1000).toFixed(1) + ' kHz' : f1.toFixed(0) + ' Hz') + topNote() + '). ' + tips.join(' ')));
    };
    fill();
    live.push(fill);
    return card('Panel resonance', box);
  }

  // ---------------------------------------------------------------- stuffing and standing waves
  function stuffFields(ch) {
    const st = ch.stuff || (ch.stuff = { mat: 'none', fill: 0, thick: 0.025 });
    const SW = GL.standing;
    return [
      h('div', { class: 'grid2' },
        sel('Stuffing', Object.entries(SW.STUFF).map(([k, v]) => [k, v.name]), () => st.mat, (v) => {
          st.mat = v; if (v !== 'none' && !(st.fill > 0)) st.fill = v === 'lining' ? 1 : 0.5;
        }),
        st.mat === 'none' ? null : nf(st.mat === 'lining' ? 'Walls covered' : 'Fill (of the volume)', () => st.fill * 100, (v) => { st.fill = Math.max(0, Math.min(100, v)) / 100; }, { unit: '%', digits: 0 }),
        st.mat === 'lining' ? uf('Lining thickness', 'thick', () => st.thick, (v) => { st.thick = v; }) : null),
      st.mat === 'none' ? null : liveText(() => {
        const e = SW.effect(st);
        return 'Acts like ' + U.fmt('vol', ch.vol * e.k) + ' (+' + ((e.k - 1) * 100).toFixed(0) + '%), and adds absorption (Qa about ' + e.qa.toFixed(0) + ').' +
          (st.mat === 'lining' ? ' A ' + U.fmt('thick', st.thick) + ' lining damps standing waves above about ' + (GL.phys.c / (8 * st.thick)).toFixed(0) + ' Hz.' : '');
      }, 'hint'),
    ];
  }

  // Axial standing waves in every chamber, with how hard the driver drives each
  // one (from where it sits) and whether the stuffing damps it.
  function standingWaves(out) {
    const d = S.design, b = S.box, lay = out.layout, P = out.plan;
    if (!lay) return [];
    const f3v = out.res ? f3(out.res, out).low : null;
    const band = [f3v || S.signal.fmin, playTop()];
    const I = lay.int, t = b.t, along = b.split;
    const lo = { W: -b.ext.W / 2 + t, H: -b.ext.H / 2 + t };
    const rows = [];
    for (const c of lay.chambers) {
      const ch = d.chambers.find(x => x.id === c.id);
      if (!ch) continue;      // a result from before the design changed: it is about to be redone
      const start = { W: lo.W, H: lo.H }, len = { W: I.W, H: I.H, D: I.D };
      len[along] = c.len; start[along] = -b.ext[along] / 2 + c.start;
      // drivers that radiate into this chamber (motor side or cone side)
      // drivers that radiate into this chamber: the motor side, or the cone side of a divider driver
      const all = P ? P.drivers.filter(x => x.into === c.id || (!x.front && d.mount.front === c.id)) : [];
      const zBack = -b.ext.D / 2 + t;
      const frac = (axis) => {
        if (!all.length) return null;
        // depth: front-mounted drivers sit at the baffle end; on a divider they sit at the end along the split
        const vals = all.map(x => {
          if (axis === 'D') return x.front ? 0 : (x.pos[2] - zBack) / I.D;
          const ia = axis === 'W' ? 0 : 1;
          if (!x.front && axis === along) return 0;
          return (x.pos[ia] - start[axis]) / len[axis];
        });
        return vals;          // the strongest coupling of any driver wins (below)
      };
      const dims = ['W', 'H', 'D'].map(axis => ({ axis, len: len[axis], at: frac(axis) }));
      const modes = [];
      for (const dm of dims) {
        const pos = dm.at;
        for (const m of GL.standing.modes([{ axis: dm.axis, len: dm.len, at: null }], band[1])) {
          m.couple = pos ? Math.max(...pos.map(x => Math.abs(Math.cos(m.n * Math.PI * Math.max(0, Math.min(1, x)))))) : 1;
          m.inBand = m.f >= band[0] && m.f <= band[1];
          m.damp = GL.standing.damping(ch.stuff, m.f);
          m.flag = m.inBand && m.couple > 0.3 && m.damp !== 'damped';
          modes.push(m);
        }
      }
      modes.sort((x, y) => x.f - y.f);
      rows.push({ chamber: c, ch, modes, band });
    }
    return rows;
  }

  function standingCard() {
    const box = h('div', { class: 'voltable' });
    const AX = { W: 'width', H: 'height', D: 'depth' };
    const fill = () => {
      box.innerHTML = '';
      if (!R || !R.layout) return;
      const rows = standingWaves(R);
      const hz = (v) => v >= 1000 ? (v / 1000).toFixed(2) + ' kHz' : v.toFixed(0) + ' Hz';
      for (const r of rows) {
        const shown = r.modes.filter(m => m.n === 1 || m.inBand).slice(0, 9);
        box.append(h('table', null,
          h('thead', null, h('tr', null, [(rows.length > 1 ? r.chamber.name : 'Mode'), 'Along', 'Driver', 'Stuffing', ''].map(x => h('th', null, x)))),
          h('tbody', null, shown.map(m => h('tr', { class: m.inBand ? '' : 'miss' },
            h('th', null, hz(m.f) + (m.n > 1 ? ' (' + m.n + '×)' : '')),
            h('td', null, AX[m.axis] + ' ' + U.fmt('len', m.len, 1)),
            h('td', null, m.couple >= 0.7 ? 'drives it' : m.couple <= 0.3 ? 'at its null' : 'partly'),
            h('td', null, m.damp),
            h('td', null, m.flag ? 'check' : ''))))));
      }
      const band = rows[0] ? rows[0].band : [0, 0];
      const flagged = rows.flatMap(r => r.modes.filter(m => m.flag).map(m => ({ r, m })));
      box.append(h('p', { class: 'hint' }, 'Half-wave standing waves along each inside dimension, from ' + band[0].toFixed(0) + ' Hz to ' + (band[1] >= 1000 ? (band[1] / 1000).toFixed(1) + ' kHz' : band[1].toFixed(0) + ' Hz') +
        ' (greyed: outside the band the speaker plays' + topNote() + '). A driver in the middle of a dimension sits in the null of its odd modes; at an end it drives them all. ' +
        (flagged.length ? 'To tame the ones marked "check": fill that chamber with polyester or wool (30% or more of the volume), or line the walls with foam or felt at least an eighth of a wavelength thick; damping across the middle of the long dimension does most. A port opening inside the box also leaks these out, so keep it away from the ends of that dimension.'
          : 'Nothing in the band needs damping.')));
    };
    fill();
    live.push(fill);
    return card('Standing waves inside', box);
  }

  // ---------------------------------------------------------------- chamber layout
  // How a box with this design would come out with the chambers side by side
  // or stacked: settle a copy and report its size and whether the drivers fit.
  const layoutCache = new Map();
  function tryLayout(split) {
    const key = JSON.stringify([split, S.design, S.box, S.driverId]);
    if (layoutCache.has(key)) return layoutCache.get(key);
    if (layoutCache.size > 20) layoutCache.clear();
    const r = tryLayoutNow(split);
    layoutCache.set(key, r);
    return r;
  }
  function tryLayoutNow(split) {
    const box = JSON.parse(JSON.stringify(S.box));
    box.split = split;
    box.lock = { W: false, H: false, D: false };
    const params = drvc().params;
    // start each layout from the same proportions, then let the faces grow it
    const lay0 = G.layout(S.design, box);
    G.applyRatio(box, lay0.gross, lay0.n, { W: 1.25, H: 1, D: 0.9 });
    let plan = null;
    for (let it = 0; it < 4; it++) {
      const lay = G.layout(S.design, box);
      plan = GL.placement.plan(S.design, box, lay, params);
      const fm = faceMins(plan, box, lay);
      box.minLen = fm.minLen;
      const lay2 = G.layout(S.design, box);
      G.solveDims(box, lay2.need, lay2.n, null, fm.mins);
    }
    const lay = G.layout(S.design, box);
    plan = GL.placement.plan(S.design, box, lay, params);
    const faces = Object.values(plan.faces).concat(plan.dividers, plan.walls || []);
    const motorOk = motorRoom(plan, box, lay).every(m => m.have >= m.need - 1e-3);
    return { ext: box.ext, fits: motorOk && !faces.some(f => f.crowded && f.fit && f.fit.hasDriver), ports: plan.ports.every(x => x.route.fits), vol: box.ext.W * box.ext.H * box.ext.D };
  }
  function layoutCard() {
    const b = S.box;
    const dims = (e) => ['W', 'H', 'D'].map(k => U.fmt('len', e[k], 1)).join(' × ');
    return card('Layout',
      sel('Chambers', [['W', 'Side by side (divider stands upright)'], ['H', 'Stacked (divider lies flat)']], () => b.split, (v) => {
        b.split = v;
        // a new layout starts from the usual proportions (the faces then grow it to fit)
        const lay = G.layout(S.design, b);
        G.applyRatio(b, lay.gross, lay.n, { W: 1.25, H: 1, D: 0.9 });
      }),
      liveText(() => {
        const a = tryLayout('W'), c = tryLayout('H');
        const say = (name, r) => name + ': ' + dims(r.ext) + ' outside' + (r.fits ? '' : ', drivers don\'t fit') + (r.ports ? '' : ', a port doesn\'t fit');
        const best = a.fits !== c.fits ? (a.fits ? 'W' : 'H') : a.ports !== c.ports ? (a.ports ? 'W' : 'H') : a.vol <= c.vol ? 'W' : 'H';
        const ok = (r) => r.fits && r.ports;
        const name = (k) => k === 'H' ? 'stacked' : 'side by side';
        let verdict;
        if (ok(a) && ok(c)) {
          const d = Math.abs(a.vol - c.vol) / Math.min(a.vol, c.vol);
          verdict = 'Both fit. ' + (d < 0.03 ? 'They come out about the same size.' : 'The ' + name(best) + ' box is ' + (d * 100).toFixed(0) + '% smaller outside (' + U.fmt('vol', Math.min(a.vol, c.vol)) + ' vs ' + U.fmt('vol', Math.max(a.vol, c.vol)) + ').');
        } else verdict = best === b.split ? 'The current layout is the better fit.' : 'The ' + name(best) + ' layout fits better.';
        return say('Side by side', a) + '\n' + say('Stacked', c) + '\n' + verdict;
      }, 'live lines'),
      h('p', { class: 'hint' }, 'With a divider standing upright, drivers on it line up along its height; lying flat, they line up across the width and the ports sit on the front of the top and bottom chambers. The box keeps each face big enough for what is on it and resizes the rest to hold the volumes.'));
  }

  // ---------------------------------------------------------------- baffle, off-axis, compensation
  function baffleCard() {
    const B = S.baffle, d = S.design;
    const off = d.offset || (d.offset = { x: 0, y: 0 });
    const step = () => GL.baffle.stepFreq(S.box.ext.W, S.box.ext.H);
    const suggest = () => {
      const re = drvc().model.Re;
      Object.assign(B.bsc, GL.baffle.bscValues(re, B.bsc.db, step()));
    };
    const angles = [15, 30, 45, 60, 90];
    return card('Baffle and listening',
      sel('Where it plays', [['wall', 'In a wall, on the floor, or a sub in a room or car (half space)'], ['stand', 'Standing free, e.g. on a stand or desk (baffle step and edge diffraction)']],
        () => B.mode, (v) => { B.mode = v; }),
      B.mode === 'stand' ? [
        h('div', { class: 'grid2' },
          uf('Listening distance', 'room', () => B.dist, (v) => { B.dist = v; }, { structural: false }),
          uf('Edge round-over', 'len', () => B.round, (v) => { B.round = v; }, { positive: false, min: 0, structural: false, tip: 'Radius on the front edges of the box. Bigger round-overs smooth the ripple from the edges.' }),
          uf('Driver offset across', 'len', () => off.x, (v) => { off.x = v; }, { positive: false, tip: 'From the centre of the baffle, + to the right. An off-centre driver spreads the edge ripple out.' }),
          uf('Driver offset up', 'len', () => off.y, (v) => { off.y = v; }, { positive: false, tip: 'From the centre of the baffle, + up' })),
        liveText(() => 'Baffle ' + U.fmt('len', S.box.ext.W) + ' × ' + U.fmt('len', S.box.ext.H) + ': the step is centred near ' + step().toFixed(0) +
          ' Hz. Below it the box loses up to 6 dB (it radiates all round instead of forward only). The SPL chart includes the step and the ripple from the edges.', 'hint'),
      ] : h('p', { class: 'hint' }, 'The response is for a box in a large wall (half space), which suits subwoofers. Pick "standing free" for small speakers on a stand or desk: they lose up to 6 dB below the baffle step.'),
      h('div', { class: 'checks' }, h('span', { class: 'fl' }, 'Also show off axis'),
        angles.map(a => check(a + '°', () => B.angles.includes(a), (v) => { B.angles = v ? B.angles.concat(a) : B.angles.filter(x => x !== a); }))),
      h('p', { class: 'hint' }, 'Off-axis curves (SPL chart) treat the cone and ports as flat pistons, so they show beaming from cone size but not cone break-up.'),
      check('Baffle-step compensation (coil and resistor in series with the driver)', () => B.bsc.on, (v) => { B.bsc.on = v; if (v && !(B.bsc.L > 0)) suggest(); }),
      B.bsc.on ? [
        h('div', { class: 'grid2' },
          nf('Coil L', () => B.bsc.L * 1000, (v) => { B.bsc.L = v / 1000; }, { unit: 'mH', digits: 2, positive: true, structural: false }),
          nf('Resistor R (across the coil)', () => B.bsc.R, (v) => { B.bsc.R = v; }, { unit: 'Ω', digits: 2, positive: true, structural: false }),
          nf('Compensation', () => B.bsc.db, (v) => { B.bsc.db = Math.max(0.5, Math.min(6, v)); }, { unit: 'dB', digits: 1, structural: false, tip: 'About 6 dB for a speaker far from walls; 2 to 4 dB near a wall or on a desk' })),
        h('div', { class: 'btnrow' }, btn('Suggest from the baffle', () => { suggest(); changed(true); }, 'btn small')),
        h('p', { class: 'hint' }, 'Wire the coil and resistor in parallel with each other, then in series with the driver. It lowers everything above the step by the compensation amount, so the bass matches. The impedance and SPL charts include it.'),
      ] : null);
  }

  // ---------------------------------------------------------------- cone breakup (Driver tab)
  function breakupCard(d) {
    const b = d.breakup || null;
    const saveLib = () => { DRV.library.save(); };
    const est = (mat) => GL.breakup.estimate(d.params.sd, mat);
    const enable = (v) => {
      d.breakup = v ? Object.assign({ on: true }, b && b.f ? b : est((b && b.mat) || 'paper'), { on: true }) : Object.assign({}, b, { on: false });
      saveLib();
    };
    const on = !!(b && b.on);
    const set = (k) => (v) => { d.breakup[k] = v; saveLib(); };
    return card('Cone breakup',
      h('p', { class: 'hint' }, 'Above its first breakup mode a cone flexes instead of moving as one piece: the response gets a peak, then falls, and the cone beams less than its size suggests. It matters for full-range and mid drivers, and when crossing a woofer high.'),
      check('Model cone breakup for ' + DRV.library.name(d), () => on, (v) => enable(v), { structural: true }),
      on ? [
        h('div', { class: 'grid2' },
          sel('Cone material', Object.entries(GL.breakup.CONES).map(([k, v]) => [k, v.name]), () => b.mat || 'paper', (v) => { Object.assign(d.breakup, est(v)); saveLib(); }, { structural: true }),
          uf('Breakup peak', 'freq', () => b.f, set('f'), { tip: 'Read it off the datasheet\'s frequency response: the first big peak at the top' }),
          nf('Peak height', () => b.db, set('db'), { unit: 'dB', digits: 1, min: 0 }),
          nf('Peak sharpness (Q)', () => b.q, set('q'), { digits: 1, positive: true, tip: 'About 1–2 for damped paper or polypropylene, 6–15 for metal and ceramic' })),
        h('div', { class: 'btnrow' }, btn('Estimate from the material', () => { Object.assign(d.breakup, est(b.mat || 'paper')); saveLib(); changed(true); }, 'btn small ghost')),
        h('p', { class: 'hint' }, 'The estimate (about ' + (GL.breakup.CONES[b.mat || 'paper'].K) + ' ÷ cone diameter for ' + GL.breakup.CONES[b.mat || 'paper'].name.toLowerCase() + ') is rough. The datasheet\'s on-axis response shows the real peak: put its frequency, height and sharpness here. The SPL chart, off-axis curves and line arrays all include it.'),
      ] : null);
  }

  // ---------------------------------------------------------------- line array
  const LA = () => GL.linearray;
  // Elements of the current array, with the driver's cone radius.
  // Remember the last answer: the same frequency is asked for once per element and point.
  const memo = (fn) => { let lf = NaN, lv = null; return (f) => f === lf ? lv : (lf = f, lv = fn(f)); };
  // One driver of the current design at 1 m (Pa, complex), from the last simulation,
  // with the box alone (before any baffle step) and the cone breakup.
  function elementResponse(res) {
    const f = res.f, spl = res.splBox || res.spl, ph = res.phaseBox || res.phase, n = f.length;
    const per = 1 / Math.max(1, S.design.count), bu = breakup();
    return (x) => {
      let i = 1;
      if (x <= f[0]) i = 1; else if (x >= f[n - 1]) i = n - 1; else { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (f[m] > x) hi = m; else lo = m; } i = hi; }
      const t = Math.max(0, Math.min(1, Math.log(x / f[i - 1]) / Math.log(f[i] / f[i - 1])));
      const db = spl[i - 1] + (spl[i] - spl[i - 1]) * t, phi = ph[i - 1] + (ph[i] - ph[i - 1]) * t;
      const amp = 20e-6 * Math.pow(10, db / 20) * per;
      let z = X.C(amp * Math.cos(phi), amp * Math.sin(phi));
      if (bu) z = X.cmul(z, GL.breakup.H(2 * Math.PI * x, bu));
      return z;
    };
  }
  // Tweeter at 1 m (Pa, complex): sensitivity, its own 2nd-order roll-off at Fs, then the crossover.
  function tweeterResponse(t) {
    const V = R && R.sig ? R.sig.per : 2.83;
    const p0 = 20e-6 * Math.pow(10, t.sens / 20) * V / 2.83 * Math.pow(10, t.trim / 20) * (t.invert ? -1 : 1);
    return (f) => {
      const w = 2 * Math.PI * f, w0 = 2 * Math.PI * t.fs;
      let z = X.cdiv(X.C(-w * w * p0, 0), X.C(w0 * w0 - w * w, w * w0 / t.qts));
      z = X.cmul(z, filterResp(w, { f: t.xo, order: t.order }, true));
      if (t.delay) z = X.cmul(z, X.C(Math.cos(-w * t.delay / 1000), Math.sin(-w * t.delay / 1000)));
      return z;
    };
  }
  // Every element of the array, each with its own source: the design (low-passed
  // when there's a tweeter line) and the tweeters.
  // A design that isn't a line array: its own front-mounted drivers where they sit on
  // the baffle (heights from "Top of the speaker"), or one source at the middle
  // of the box when nothing is on the front (bandpass, horns, lines).
  function designElements(rad) {
    const a = S.array, P = R && R.plan, H = S.box.ext.H || 0.3;
    const front = P ? P.drivers.filter(d => d.front) : [];
    if (front.length) return { els: front.map(d => ({ x: 0, y: a.top - (H / 2 - d.pos[1]), aim: 0, r: rad, w: 1, tau: 0 })), whole: false };
    return { els: [{ x: 0, y: a.top - H / 2, aim: 0, r: 0.02, w: 1, tau: 0 }], whole: true };
  }
  function arrayEls(which) {
    const a = S.array, bu = breakup(), a0 = Math.sqrt(driver().params.sd / Math.PI);
    const rad = bu ? (f) => GL.breakup.radius(a0, f, bu) : a0;
    const isLine = a.on || S.kind === 'array';
    const de = isLine ? null : designElements(rad);
    const main = isLine ? LA().elements(a, rad) : de.els;
    if (!R || !R.res) return main;
    const er0 = elementResponse(R.res);
    // one source standing in for the whole design carries all of its drivers
    const er = de && de.whole ? (f) => X.cscale(er0(f), Math.max(1, S.design.count)) : er0;
    const wsrc = a.tw.on ? memo((f) => X.cmul(er(f), filterResp(2 * Math.PI * f, { f: a.tw.xo, order: a.tw.order }, false))) : memo(er);
    main.forEach(e => { e.src = wsrc; });
    if (!isLine || !a.tw.on || which === 'main') return main;
    const tsrc = memo(tweeterResponse(a.tw));
    const tw = LA().tweeterElements(main, a.pitch, a.tw).map(e => Object.assign(e, { src: tsrc }));
    return which === 'tweeters' ? tw : main.concat(tw);
  }
  const boxR = () => Math.min(S.box.ext.W, S.box.ext.H) / 2;
  const coneDia = () => GL.match.outerDia(driver().params);

  // SPL at the listener: every element is one driver of the current design
  // (its own response and phase), summed with distance, angle and delays.
  function arrayAtListener(res, which) {
    const a = S.array, els = arrayEls(which), imgs = LA().images(a);
    const out = new Array(res.f.length);
    for (let i = 0; i < res.f.length; i++) {
      const f = res.f[i];
      const g = LA().pressureAt(els, imgs, f, a.listen.d, a.listen.h, boxR());
      out[i] = 20 * Math.log10(Math.max(1e-12, Math.hypot(g.re, g.im)) / 20e-6) + cabinDb(f);
    }
    // fractional-octave smoothing (power average), as a measurement with noise would show it
    if (!(a.smooth > 0)) return out;
    const half = Math.pow(2, 1 / (2 * a.smooth));
    return out.map((_, i) => {
      let s2 = 0, n = 0;
      for (let j = 0; j < out.length; j++) if (res.f[j] >= res.f[i] / half && res.f[j] <= res.f[i] * half) { s2 += Math.pow(10, out[j] / 10); n++; }
      return 10 * Math.log10(s2 / n);
    });
  }

  // Bands of 6 dB, from the surface colour (quiet) to the accent colour (loud).
  function bandColours(n) {
    const cs = getComputedStyle(document.documentElement);
    const hex = (v, d) => { const m = (cs.getPropertyValue(v).trim() || d).match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); return m ? [1, 2, 3].map(i => parseInt(m[i], 16)) : [128, 128, 128]; };
    const a = hex('--series-1', '#2a78d6'), b = hex('--surface-1', '#fcfcfb');
    return Array.from({ length: n }, (_, i) => { const t = 1 - i / n; return 'rgb(' + a.map((v, j) => Math.round(b[j] + (v - b[j]) * t)).join(',') + ')'; });
  }

  function arrayPanel(part = 'side') {
    const a = S.array;
    const deg = (label, get, set, tip) => nf(label, get, set, { unit: '°', digits: 1, structural: false, tip });
    const lim = () => LA().limits(a, coneDia());
    const hz = (f) => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz' : f.toFixed(0) + ' Hz';

    const setup = card('Line array',
      h('p', { class: 'hint' }, 'Stacks the current design (driver ' + DRV.library.name(driver()) + ' in its box) into a vertical line. Each element radiates as a piston with that design\'s own response, so the pattern, the near field and the level at your seat all come out of one sum (after Ureda, JAES 2004).'),
      check('This design is a line array', () => a.on, (v) => { a.on = v; if (v && a.listenOn === undefined) a.listenOn = true; }, { structural: true }),
      a.on ? null : h('p', { class: 'hint' }, 'Tick to stack this design into a line: a column of drivers in one box, or separate cabinets. The side view, polar, coverage and level plots work either way.'),
      sel('Box', [['shared', 'One box: drivers in a line on its baffle (a column)'], ['separate', 'Separate cabinets stacked (each the box on the Enclosure tab)']],
        () => a.shared ? 'shared' : 'separate', (v) => {
          a.shared = v === 'shared';
          if (a.shared) {
            // the design now holds all of them: same air per driver
            const n0 = S.design.count || 1, n1 = Math.max(2, Math.round(a.n));
            for (const c of S.design.chambers) c.vol *= n1 / n0;
            S.design.count = n1;
            columnBox();
          }
        }),
      // the column's baffle: set its width or height and the depth takes the volume
      a.shared ? [
        h('div', { class: 'grid2' },
          uf('Column width (outside)', 'len', () => S.box.ext.W, (v) => { S.box.lock.W = true; setDim('W', v); }, { structural: false, tip: 'Held at this; the depth takes up the volume. It can\'t go narrower than the drivers.' }),
          uf('Column height (outside)', 'len', () => S.box.ext.H, (v) => { S.box.lock.H = true; setDim('H', v); }, { structural: false, tip: 'A taller baffle leaves room below the drivers (ports, a passive radiator) and makes the box shallower.' })),
        h('div', { class: 'btnrow' },
          btn('Narrowest', () => { columnBox(); changed(true); }, 'btn small ghost'),
          btn('Height follows the row', () => { S.box.lock.H = false; changed(true); }, 'btn small ghost')),
        liveText(() => 'Depth ' + U.fmt('len', S.box.ext.D) + ' to hold the volume' + (S.box.lock.H ? ' (height held)' : ' (height follows the row)') + '.', 'hint'),
      ] : null,
      h('div', { class: 'grid2' },
        nf(a.shared ? 'Drivers' : 'Elements', () => a.n, (v) => {
          const n1 = Math.max(2, Math.min(64, Math.round(v)));
          // one box: keep each driver's share of the air
          if (a.shared && sharedArray()) for (const c of S.design.chambers) c.vol *= n1 / Math.max(1, Math.round(a.n));
          a.n = n1;
        }, { digits: 0, structural: false }),
        uf(a.shared ? 'Driver spacing (centre to centre)' : 'Pitch (centre to centre)', 'len', () => a.pitch, (v) => { a.pitch = v; }, { structural: false,
          tip: 'Closest is edge to edge. Wider spacing makes the line break up lower: compare the coverage and the side view as you open it up' }),
        sel('Shape', [['straight', 'Straight'], ['arc', 'Arc (even splay)'], ['j', 'J (straight top, curved bottom)'], ['progressive', 'Progressive (splay grows down the array)'], ['custom', 'My own splay angles']],
          () => a.shape, (v) => { a.shape = v; }),
        a.shape === 'arc' || a.shape === 'j' ? deg('Total curve', () => a.angle, (v) => { a.angle = v; }, 'From the first curved element to the last') : null,
        a.shape === 'progressive' ? deg('Bottom element aims down by', () => a.angle, (v) => { a.angle = v; }, 'Terminal angle: the splays grow 1Δ, 2Δ, 3Δ … down the array to reach it') : null,
        a.shape === 'j' ? nf('Straight elements at the top', () => a.straight, (v) => { a.straight = Math.max(1, Math.round(v)); }, { digits: 0, structural: false }) : null,
        deg('Tilt (whole array, + down)', () => a.tilt, (v) => { a.tilt = v; }),
        deg('Electronic tilt (delays)', () => a.steer, (v) => { a.steer = v; }, 'Aim the beam with DSP delays instead of tilting the box'),
        sel('Shading', [['uniform', 'None (all equal)'], ['hann', 'Hann taper'], ['legendre', 'CBT Legendre taper']], () => a.shade, (v) => { a.shade = v; }, { structural: false })),
      a.shape === 'custom' ? h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Splay between each pair, top down (°)'),
        h('span', { class: 'fi' }, h('input', { type: 'text', class: 'txt', value: a.custom, placeholder: 'e.g. 0 0 1 2 3 5 8', onchange: (e) => { a.custom = e.target.value; changed(false); } }))) : null,
      h('div', { class: 'btnrow' },
        btn(a.shared ? 'Edge to edge' : 'Pack the drivers tight', () => { a.pitch = (a.shared ? coneDia() : Math.max(coneDia(), S.box.ext.H)) + 0.002; changed(true); }, 'btn small'),
        btn('Fill floor to ceiling', () => { a.place = 'both'; a.top = a.ceiling; a.n = Math.max(2, Math.floor(a.ceiling / a.pitch)); changed(true); }, 'btn small ghost')),
      h('p', { class: 'hint' }, 'The line\'s limits, coverage and the drivers\' key figures are in the Line array view; where it stands and where you listen are on the Signal tab.'),
      liveText(() => {
        const cd = coneDia(), bh = S.box.ext.H;
        if (a.pitch < cd - 1e-4) return 'The pitch is less than the outside diameter of the driver (' + U.fmt('len', cd) + '): the drivers would overlap.';
        if (!a.shared && a.pitch < bh - 1e-4 && S.design.count < Math.round(a.n)) return 'Each element is ' + U.fmt('len', bh) + ' tall on its own, more than the pitch. That only works if the drivers share one tall box (set the driver count to ' + Math.round(a.n) + ').';
        return '';
      }, 'warn'),
      liveText(() => a.shared ? 'One box holds all ' + Math.round(a.n) + ' drivers (' + S.design.chambers.map(c => U.fmt('vol', c.vol)).join(' + ') + ' net, ' +
        U.fmt('vol', S.design.chambers.reduce((s2, c) => s2 + c.vol, 0) / Math.max(1, Math.round(a.n))) + ' per driver), in a line on its baffle. Its height follows the row; set the volume on the Enclosure tab.' +
        (a.shape !== 'straight' ? ' A curved line needs a curved (segmented) baffle.' : '') :
        S.design.count === Math.round(a.n) ? '' : 'The box on the Enclosure tab is designed for ' + S.design.count + ' driver' + (S.design.count > 1 ? 's' : '') +
        '. Each element here uses one driver\'s share of it; set the driver count to ' + Math.round(a.n) + ' if they all share one box.', 'hint'));

    // ---- tweeter line ----
    const t = a.tw;
    const twCard = card('Tweeter line',
      check('Add a line of tweeters beside the drivers (same curve)', () => t.on, (v) => { t.on = v; if (v && !(t.n > 1)) t.n = Math.max(2, Math.round(a.n * a.pitch / t.pitch)); }, { structural: true }),
      t.on ? [
        h('div', { class: 'grid2' },
          sel('Type', [['dome', 'Dome (round)'], ['ribbon', 'Ribbon / AMT (tall strip)']], () => t.type, (v) => { t.type = v; }),
          uf(t.type === 'ribbon' ? 'Ribbon height' : 'Dome diameter', 'len', () => t.size, (v) => { t.size = v; }, { structural: false, tip: 'The radiating part only' }),
          nf('Tweeters', () => t.n, (v) => { t.n = Math.max(1, Math.min(128, Math.round(v))); }, { digits: 0, structural: false }),
          uf('Tweeter pitch', 'len', () => t.pitch, (v) => { t.pitch = v; }, { structural: false }),
          nf('Sensitivity (2.83 V, 1 m)', () => t.sens, (v) => { t.sens = v; }, { unit: 'dB', digits: 1, structural: false }),
          uf('Tweeter Fs', 'freq', () => t.fs, (v) => { t.fs = v; }, { structural: false }),
          nf('Tweeter Qts', () => t.qts, (v) => { t.qts = v; }, { digits: 2, positive: true, structural: false }),
          uf('Crossover', 'freq', () => t.xo, (v) => { t.xo = v; }, { structural: false }),
          sel('Slope', SLOPES, () => t.order, (v) => { t.order = v; }, { structural: false }),
          nf('Tweeter level', () => t.trim, (v) => { t.trim = v; }, { unit: 'dB', digits: 1, structural: false, tip: 'Padding (−) or boost (+) for the whole tweeter line' }),
          nf('Tweeter delay', () => t.delay, (v) => { t.delay = v; }, { unit: 'ms', digits: 3, structural: false, tip: 'For lining up the acoustic centres: about 0.03 ms per centimetre the tweeter sits in front of the cones' })),
        check('Tweeters wired in reverse polarity', () => t.invert, (v) => { t.invert = v; }),
        h('div', { class: 'btnrow' },
          btn('Cover the same length', () => { t.n = Math.max(1, Math.round(a.n * a.pitch / t.pitch)); changed(true); }, 'btn small'),
          btn('Pack the tweeters tight', () => { t.pitch = t.size + (t.type === 'ribbon' ? 0.004 : 0.012); t.n = Math.max(1, Math.round(a.n * a.pitch / t.pitch)); changed(true); }, 'btn small ghost'),
          btn('Match the tweeter level', () => {
            // main line an octave below the crossover vs tweeters an octave above, at the listener
            if (!R || !R.res) return;
            const imgs = LA().images(a), lvl = (which, f0, f1) => {
              const els = arrayEls(which), fr = GL.util.logspace(f0, f1, 12);
              return fr.reduce((s2, f) => { const g = LA().pressureAt(els, imgs, f, a.listen.d, a.listen.h, boxR()); return s2 + 20 * Math.log10(Math.max(1e-12, Math.hypot(g.re, g.im))); }, 0) / fr.length;
            };
            const diff = lvl('tweeters', t.xo * 2, t.xo * 4) - lvl('main', t.xo / 4, t.xo / 2);
            t.trim = Math.round((t.trim - diff) * 10) / 10;
            toast('Tweeter level set to ' + (t.trim > 0 ? '+' : '') + t.trim.toFixed(1) + ' dB to match the main line at the listener.');
            changed(true);
          }, 'btn small ghost')),
        liveText(() => {
          const c = GL.phys.c, kh = hz;
          const wg = c / a.pitch, wc = c / (2 * a.pitch), tg = c / t.pitch, tc = c / (2 * t.pitch);
          const lines = ['Tweeter line ' + U.fmt('room', t.n * t.pitch) + ' long: one continuous line up to about ' + kh(tc) + ', grating lobes above ' + kh(tg) + '.'];
          if (t.xo > wc) lines.push('The main line stops acting as one line at ' + kh(wc) + ', below the ' + kh(t.xo) + ' crossover' + (t.xo > wg ? ', and throws grating lobes from ' + kh(wg) : '') + '. Crossing lower (or packing the drivers closer) keeps the pattern clean.');
          const bu = breakup();
          if (bu && t.xo > bu.f / 2) lines.push('The cone breakup peak (' + kh(bu.f) + ') is less than an octave above the crossover; cross lower or use a steeper slope.');
          if (t.order === '2' && !t.invert) lines.push('12 dB/oct crossovers usually want the tweeters in reverse polarity: try the switch and compare.');
          return lines.join('\n');
        }, 'live lines'),
        h('p', { class: 'hint' }, 'Tweeters follow the main line\'s curve, centred on it. Each one is modelled from its sensitivity, Fs and Qts as a dome (piston) or a ribbon (tall strip), driven with the same voltage as one main driver, through the crossover. The SPL chart shows the total and both lines dashed.'),
      ] : null);

    // ---- side view: pressure field ----
    const fieldBox = h('div', { class: 'lafield' });
    // layers: one colour per frequency, lowest at the bottom, so the beam can be seen narrowing as frequency rises
    const LAYERS = [[500, '#d6453d', 'red'], [1000, '#8b5cf6', 'purple'], [5000, '#1baf7a', 'green'], [8000, '#2a78d6', 'blue']];
    const single = a.fieldMode === 'single';
    const fieldCard = card('Side view',
      h('div', { class: 'grid2' },
        single ? sel('Frequency', [250, 500, 1000, 2000, 4000, 8000, 16000].map(f => [String(f), hz(f)]), () => String(a.fieldF), (v) => { a.fieldF = +v; }, { structural: false })
          : sel('Shade where it is within', [['3', '3 dB of the loudest at that distance'], ['6', '6 dB of the loudest at that distance'], ['10', '10 dB of the loudest at that distance']], () => String(a.layerDb), (v) => { a.layerDb = +v; }, { structural: true }),
        sel('Out to', [2, 4, 6, 10, 20, 40].map(m => [String(m), U.fmt('room', m, 0)]), () => String(a.fieldX), (v) => { a.fieldX = +v; }, { structural: false })),
      single ? null : h('div', { class: 'checks' }, LAYERS.map(([f, col]) => h('span', { class: 'layerchk' }, h('span', { class: 'k', style: { background: col } }),
        check(hz(f), () => a.layerF.includes(f), (v) => { a.layerF = v ? a.layerF.concat(f).sort((x, y) => x - y) : a.layerF.filter(x => x !== f); })))),
      check('Single frequency, in 6 dB bands', () => single, (v) => { a.fieldMode = v ? 'single' : 'layers'; }, { structural: true }),
      check('Angle lines (every 10° from the centre of the speaker)', () => a.angleLines !== false, (v) => { a.angleLines = v; }, { structural: false }),
      fieldBox,
      h('p', { class: 'hint' }, single
        ? 'Sound level from the side at one frequency, in bands 6 dB apart, measured down from the loudest spot (not angles). The speaker is on the left, the listener is the ring. Floor and ceiling reflections are included when the placement says so.'
        : 'Each colour is one frequency: shaded where it is within ' + a.layerDb + ' dB of its loudest point at the same distance (so the beam\'s shape, all the way out), outlined in the same colour. Lower frequencies are underneath: where a higher one narrows or breaks into lobes, the colours below show through. The speaker is on the left, the listener is the ring.'));
    let fieldKey = '';
    const drawField = () => {
      if (!fieldBox.isConnected) return;          // another part of the view is showing
      const els = arrayEls(), imgs = LA().images(a);
      let yTop = Math.max(a.place === 'both' ? a.ceiling : a.top + 0.3, a.listen.h + 0.3, a.top + 0.2), yBot = a.place === 'free' ? Math.min(0, ...els.map(e => e.y)) - 0.3 : 0;
      // centred on the speaker, as much above it as below (the floor and ceiling stay where they are)
      const cy = els.reduce((s2, e) => s2 + e.y, 0) / Math.max(1, els.length);
      if (a.place === 'free') { const half = Math.max(yTop - cy, cy - yBot, a.fieldX * 0.3); yTop = cy + half; yBot = cy - half; }
      else if (a.place === 'floor') yTop = Math.max(yTop, 2 * cy, cy + a.fieldX * 0.3);
      // as wide as the card allows, true to scale
      const W = Math.max(360, Math.min(1400, (fieldBox.clientWidth || 360) - 2));
      const key = JSON.stringify([a, driver().params.sd, driver().breakup, S.box.ext, yTop, yBot, simCount, W]);
      if (key === fieldKey) return;
      fieldKey = key;
      const Hc = Math.round(Math.max(160, Math.min(720, W * (yTop - yBot) / a.fieldX)));
      // about 4 px a cell, fewer when there are many sources to sum
      const work = els.length * imgs.length * (single ? 1 : Math.max(1, a.layerF.length));
      const px = Math.max(3, Math.min(10, 4 * Math.sqrt(work / 40)));
      const nx = Math.round(W / px), ny = Math.max(20, Math.round(Hc / px));
      const surf = getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim() || '#fff';
      const cv = h('canvas', { width: W * 2, height: Hc * 2, class: 'lacanvas', role: 'img',
        'aria-label': single ? 'Side view of the sound field at ' + hz(a.fieldF) : 'Side view: where each of ' + a.layerF.map(hz).join(', ') + ' is within ' + a.layerDb + ' dB of its loudest' });
      const g = cv.getContext('2d');
      g.scale(2, 2);
      const cw = W / nx, ch = Hc / ny;
      let key2 = null;
      if (single) {
        const vals = LA().field(els, imgs, a.fieldF, a.fieldX, yBot, yTop, nx, ny, boxR());
        const cols = bandColours(6);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const v = vals[j * nx + i], band = Math.floor(-v / 6);
          g.fillStyle = band < 6 ? cols[Math.max(0, band)] : surf;
          g.fillRect(i * cw, j * ch, cw + 0.6, ch + 0.6);
        }
        key2 = h('div', { class: 'roomkey' }, h('span', { class: 'keytitle' }, 'Below the loudest spot:'),
          ...cols.flatMap((c, i) => [h('span', { class: 'k', style: { background: c } }), (i ? '−' + (6 * i) : '0') + ' to −' + (6 * i + 6) + ' dB']),
          h('span', { class: 'k', style: { background: surf, border: '1px solid var(--border)' } }), 'below −36 dB');
      } else {
        g.fillStyle = surf; g.fillRect(0, 0, W, Hc);
        const thr = a.layerDb;
        g.imageSmoothingEnabled = false;
        // lowest frequency first, so the higher ones sit on top
        for (const [f, col] of LAYERS.filter(l => a.layerF.includes(l[0]))) {
          const vals = LA().field(els, imgs, f, a.fieldX, yBot, yTop, nx, ny, boxR());
          // compare each point with the loudest point at the same distance: the beam's shape all the way out
          const colMax = new Float32Array(nx).fill(-Infinity);
          for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) colMax[i] = Math.max(colMax[i], vals[j * nx + i]);
          const inside = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && vals[j * nx + i] >= colMax[i] - thr;
          // paint the layer as one image (translucent inside, solid edge), then scale it up
          const lay = document.createElement('canvas');
          lay.width = nx; lay.height = ny;
          const lg = lay.getContext('2d'), img = lg.createImageData(nx, ny);
          const rgb = [1, 3, 5].map(k => parseInt(col.slice(k, k + 2), 16));
          for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            if (!inside(i, j)) continue;
            const edge = !(inside(i - 1, j) && inside(i + 1, j) && inside(i, j - 1) && inside(i, j + 1));
            const o = (j * nx + i) * 4;
            img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = edge ? 255 : 90;
          }
          lg.putImageData(img, 0, 0);
          g.drawImage(lay, 0, 0, W, Hc);
        }
        key2 = h('div', { class: 'roomkey' }, h('span', { class: 'keytitle' }, 'Within ' + a.layerDb + ' dB of the loudest point at the same distance, at:'),
          ...LAYERS.filter(l => a.layerF.includes(l[0])).flatMap(([f, col]) => [h('span', { class: 'k', style: { background: col } }), hz(f)]));
      }
      const X = (x) => x / a.fieldX * W, Y = (y) => (yTop - y) / (yTop - yBot) * Hc;
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#000';
      g.strokeStyle = ink; g.lineWidth = 1.5;
      if (a.place !== 'free') { g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke(); }
      if (a.place === 'both') { g.beginPath(); g.moveTo(0, Y(a.ceiling)); g.lineTo(W, Y(a.ceiling)); g.stroke(); }
      // elements: short faces, aimed
      for (const e of els) {
        g.lineWidth = e.tw ? 2 : 3;
        const t = [-Math.sin(e.aim), -Math.cos(e.aim)], hh = (e.tw ? a.tw.pitch : a.on ? a.pitch : coneDia()) * 0.45;
        g.beginPath(); g.moveTo(X(Math.max(0, e.x - t[0] * hh)) + 2, Y(e.y - t[1] * hh)); g.lineTo(X(Math.max(0, e.x + t[0] * hh)) + 2, Y(e.y + t[1] * hh)); g.stroke();
      }
      g.lineWidth = 2; g.beginPath(); g.arc(X(a.listen.d), Y(a.listen.h), 5, 0, 2 * Math.PI); g.stroke();
      // angle lines from the speaker's centre, every 10° (true angles, whatever the picture's scale)
      if (a.angleLines !== false) {
        g.save();
        g.setLineDash([4, 5]); g.lineWidth = 1; g.globalAlpha = 0.55; g.strokeStyle = ink; g.fillStyle = ink;
        g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
        const x0 = X(0) + 2, y0 = Y(cy), L = Math.hypot(a.fieldX, yTop - yBot) * 2;
        for (let deg = -80; deg <= 80; deg += 10) {
          const r = deg * Math.PI / 180, x1 = X(L * Math.cos(r)), y1 = Y(cy + L * Math.sin(r));
          g.globalAlpha = deg === 0 ? 0.7 : deg % 30 === 0 ? 0.5 : 0.3;
          g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
          // label where the line leaves the picture
          const tx = (W - 4 - x0) / Math.max(1e-6, x1 - x0), ty = ((y1 < y0 ? 4 : Hc - 4) - y0) / Math.max(1e-6, Math.abs(y1 - y0)) * Math.sign(y1 - y0 || 1);
          const k = Math.min(tx, Math.abs(ty) || Infinity);
          const lx = x0 + (x1 - x0) * k, ly = y0 + (y1 - y0) * k;
          g.globalAlpha = 0.85;
          const txt = (deg > 0 ? '+' : '') + deg + '°';
          const tw = g.measureText(txt).width;
          g.fillText(txt, Math.min(W - tw - 3, Math.max(3, lx - (lx > W - 30 ? tw + 4 : tw / 2))), Math.min(Hc - 8, Math.max(8, ly + (ly < 12 ? 8 : ly > Hc - 12 ? -8 : 0))));
        }
        g.restore();
      }
      fieldBox.innerHTML = '';
      fieldBox.append(cv, key2);
    };

    // ---- vertical polar ----
    const polarBox = h('div', { class: 'lapolar' });
    const freqs = [250, 500, 1000, 2000, 4000, 8000, 16000];
    const polarCard = card('Vertical polar',
      h('div', { class: 'checks' }, freqs.map(f => check(hz(f), () => a.polarF.includes(f), (v) => { a.polarF = v ? a.polarF.concat(f).sort((x, y) => x - y) : a.polarF.filter(x => x !== f); }))),
      polarBox,
      h('p', { class: 'hint' }, 'Far away, with no floor or ceiling. 0° is straight ahead, up is above the array\'s axis. Rings every 10 dB.'));
    const drawPolar = () => {
      const els = arrayEls(), NS = 'http://www.w3.org/2000/svg', R0 = 150, C = 170, RANGE = 40;
      const sv = (t, at) => { const e = document.createElementNS(NS, t); for (const k in at) e.setAttribute(k, at[k]); return e; };
      const svg = sv('svg', { viewBox: '0 0 340 340', class: 'polarsvg', role: 'img', 'aria-label': 'Vertical polar response' });
      for (let r = 0; r <= RANGE; r += 10) svg.append(sv('circle', { cx: C, cy: C, r: R0 * (1 - r / RANGE), class: 'pgrid' }));
      for (let a2 = 0; a2 < 360; a2 += 30) {
        const t = a2 * D2R_;
        svg.append(sv('line', { x1: C, y1: C, x2: C + R0 * Math.cos(t), y2: C + R0 * Math.sin(t), class: 'pgrid' }));
      }
      const lab = (txt, x, y, anchor) => { const t = sv('text', { x, y, class: 'ptick', 'text-anchor': anchor || 'middle' }); t.textContent = txt; svg.append(t); };
      lab('0°', C + R0 + 4, C + 4, 'start'); lab('up', C, C - R0 - 6); lab('down', C, C + R0 + 14); lab('−10', C + R0 * 0.75 + 2, C - 3, 'start'); lab('−20', C + R0 * 0.5 + 2, C - 3, 'start');
      const angs = []; for (let d = -180; d <= 180; d += 1) angs.push(d);
      a.polarF.forEach((f, idx) => {
        const R = LA().polar(els, f, angs, boxR());
        const mx = Math.max(...R);
        let dpath = '';
        angs.forEach((d, i) => {
          const db = Math.max(-RANGE, 20 * Math.log10(Math.max(1e-9, R[i] / mx)));
          const rr = R0 * (1 + db / RANGE), t = d * D2R_;
          dpath += (i ? 'L' : 'M') + (C + rr * Math.cos(t)).toFixed(1) + ',' + (C + rr * Math.sin(t)).toFixed(1);
        });
        const pth = sv('path', { d: dpath + 'Z', class: 'pline' });
        pth.style.stroke = SERIES[idx % 4];
        if (idx >= 4) pth.setAttribute('stroke-dasharray', '5 3');
        svg.append(pth);
      });
      polarBox.innerHTML = '';
      polarBox.append(svg, h('div', { class: 'roomkey' }, ...a.polarF.flatMap((f, idx) => [lineSwatch({ color: SERIES[idx % 4], dash: idx >= 4 ? '5 3' : '' }), hz(f)])));
    };

    // ---- coverage and level vs distance ----
    const bwHost = h('div', { class: 'roomchart' }), distHost = h('div', { class: 'roomchart' });
    let bwChart = null, distChart = null;
    const bwCard = card('Coverage angle',
      bwHost,
      liveText(() => { const l = lim(); return 'Quarter-power (−6 dB) angle of the main beam, top to bottom. Several drivers in a line narrow it; a uniform straight line narrows to about 68.8° × wavelength ÷ length (Ureda); curving, shading and the drivers\' own beaming widen or shape it.'; }, 'hint'));
    const distCard = card('Level against distance', distHost,
      h('p', { class: 'hint' }, 'At ear height, relative to 1 m. Close to a line the level drops about 3 dB per doubling of distance, further out 6 dB like any small speaker; the ripples are the near field.'));
    const drawCharts = () => {
      const els = arrayEls(), imgs = LA().images(a);
      if (!bwChart) bwChart = new GL.Chart(bwHost);
      const fr = GL.util.logspace(100, 20000, 70);
      // (logspace gives a typed array, which can't hold the results: Array.from)
      const bw = Array.from(fr, f => LA().beamwidth(els, f, boxR()));
      const single = Array.from(fr, f => LA().beamwidth([Object.assign({}, els[0], { w: 1, tau: 0, x: 0, y: 0, aim: els[0].aim })], f, boxR()));
      bwChart.set({ series: [
        { name: a.on || S.kind === 'array' ? 'Array' : 'This design', color: SERIES[0], x: fr, y: bw.map(b => Math.min(180, b.width)) },
        { name: 'One driver', color: 'var(--text-secondary)', x: fr, y: single.map(b => Math.min(180, b.width)), dash: '5 4' }],
        refs: [], ylabel: 'Coverage', unit: '°', zero: true, xRange: [100, 20000], digits: 0 });
      if (!distChart) distChart = new GL.Chart(distHost);
      const ds = GL.util.logspace(0.3, Math.max(4, a.fieldX * 4), 90);
      const ser = [500, 2000, 8000].map((f, idx) => {
        const ref = LA().pressureAt(els, imgs, f, 1, a.listen.h, boxR());
        const r0 = Math.hypot(ref.re, ref.im);
        return { name: hz(f), color: SERIES[idx + 1], x: ds, y: ds.map(d => { const p = LA().pressureAt(els, imgs, f, d, a.listen.h, boxR()); return 20 * Math.log10(Math.max(1e-12, Math.hypot(p.re, p.im)) / r0); }) };
      });
      ser.push({ name: 'Small speaker (−6 dB per doubling)', color: 'var(--text-secondary)', dash: '5 4', x: ds, y: ds.map(d => -20 * Math.log10(d)) });
      distChart.set({ series: ser, refs: [], ylabel: 'Level', unit: 'dB', span: 50, xRange: [ds[0], ds[ds.length - 1]], digits: 1, xunit: 'm' });
    };

    if (part !== 'main') return [setup, twCard];
    const fill = () => { try { drawField(); drawPolar(); drawCharts(); } catch (e) { console.error(e); } };
    live.push(fill);
    requestAnimationFrame(fill);
    return [fieldCard, polarCard, bwCard, distCard];
  }
  const D2R_ = Math.PI / 180;

  // ---------------------------------------------------------------- new project
  const KINDS = [
    { id: 'sub', name: 'Subwoofer', desc: 'Bass in a room or car: sealed, ported, bandpass, horns.',
      types: ['sealed', 'ported', 'pr', 'bp4', 'bp6p', 'bp6s', 'bp8', 'manifold', 'th', 'flh', 'tl', 'mltl'] },
    { id: 'full', name: 'Full-range or bookshelf speaker', desc: 'A small speaker on a stand or desk: baffle step, off-axis and treble shown.',
      types: ['sealed', 'ported', 'pr', 'tl', 'mltl', 'pipe', 'blh'] },
    { id: 'array', name: 'Line array or column', desc: 'Small drivers stacked in a line, with or without a tweeter line.',
      types: ['sealed', 'ported', 'pr'] },
  ];
  const TYPE_HINT = {
    sealed: 'Tight, simple, rolls off gently (12 dB/oct).', ported: 'Deeper and louder for its size; a port tuned below the driver.',
    pr: 'Like ported, with a passive cone instead of a port: no port noise.', bp4: 'Sealed rear, ported front: loud in a narrow band.',
    bp6p: 'Both chambers ported: wider band, more output.', bp6s: 'Ported into a ported chamber: steep and loud.',
    bp8: 'Three chambers; very narrow, very loud.', manifold: 'Drivers face each other across a ported chamber.',
    th: 'A folded horn driven from both sides of the cone: big output from a modest box.', flh: 'A horn on the front of the cone: efficient, large.',
    tl: 'A long folded line that reinforces the bass.', mltl: 'A shorter line closed by a port: deep bass from a slim column.', pipe: 'A straight tube loaded on the front.', blh: 'A horn on the back of the cone, for full-range drivers.',
  };
  const KIND_SIZES = { sub: [5.25, 6.5, 8, 10, 12, 15, 18, 21], full: [2, 3, 4, 5.25, 6.5, 8], array: [2, 3, 4, 5.25] };
  const KIND_DEFAULT_SIZE = { sub: 12, full: 3, array: 3 };
  // band judged when ranking drivers for a box, and the top of what the kind plays
  const KIND_BAND = { sub: { band: [25, 80], top: 100 }, full: { band: [60, 300], top: 300 }, array: { band: [80, 400], top: 400 } };

  function newProjectDialog() {
    const dlg = document.getElementById('newdlg');
    const st = { kind: null, type: null, driverId: null, entry: null, name: '', size: null, q: '',
      box: { mode: 'dims', vol: 0.0283168, W: 20 * U.IN, H: 4 * U.IN, D: 4 * U.IN, t: 0.25 * U.IN, type: 'sealed', goal: 'blend', prs: 'best' }, count: 1 };
    let pool = null, poolNote = '';
    const kind = () => KINDS.find(x => x.id === st.kind);
    const close = () => dlg.close();

    // ---- step 1: what are you building
    const step1 = () => {
      dlg._onAdded = null;
      dlg.innerHTML = '';
      dlg.append(h('h3', null, 'New project'), h('p', { class: 'hint' }, 'What are you building?'),
        h('div', { class: 'kindlist' }, KINDS.map(k => h('button', { class: 'kindbtn', onclick: () => {
          st.kind = k.id; st.type = k.types[0]; st.size = KIND_DEFAULT_SIZE[k.id]; st.entry = null;
          st.box.type = 'sealed';
          st.count = k.id === 'array' ? 8 : 1;
          if (k.id === 'sub') Object.assign(st.box, { mode: 'vol', vol: 1.25 * 0.0283168 });
          // an array's box is the whole column
          if (k.id === 'array') Object.assign(st.box, { mode: 'dims', W: 4 * U.IN, H: 26 * U.IN, D: 4 * U.IN, t: 0.25 * U.IN });
          step2();
        } }, h('b', null, k.name), h('span', { class: 'hint' }, k.desc)))),
        h('div', { class: 'btnrow' }, btn('Cancel', close, 'btn ghost')));
    };

    // ---- step 2: find a driver, or start from a box
    const step2 = async () => {
      const k = kind();
      dlg.innerHTML = '';
      const list = h('div', { class: 'drvlist', role: 'listbox', 'aria-label': 'Drivers' });
      const count = h('span', { class: 'hint' });
      const nextBtn = btn('Next: alignment', () => step3(), 'btn primary');
      nextBtn.disabled = !st.entry;
      const sizeSel = h('select', { 'aria-label': 'Driver size' }, [['', 'Any size']].concat(KIND_SIZES[k.id].map(v => [String(v), v + '"'])).map(([v, t]) => h('option', { value: v }, t)));
      sizeSel.value = st.size ? String(st.size) : '';
      const search = h('input', { type: 'search', class: 'txt', placeholder: 'Search brand or model', value: st.q, 'aria-label': 'Search drivers' });
      // the nominal size picked, not the next one up or down (2" is not 2.5")
      const inSize = (e) => !st.size || (e.size && Math.abs(e.size - st.size) <= (st.size < 5 ? 0.25 : 0.5));
      const fillList = () => {
        list.innerHTML = '';
        if (!pool) { list.append(h('p', { class: 'hint' }, 'Loading drivers…')); return; }
        const q = st.q.trim().toLowerCase();
        const hits = pool.filter(e => inSize(e) && (!q || e.name.toLowerCase().includes(q)));
        count.textContent = hits.length + ' driver' + (hits.length === 1 ? '' : 's') + (hits.length > 80 ? ' (showing 80; search to narrow)' : '');
        for (const e of hits.slice(0, 80)) {
          const p = e.params;
          const row = h('button', { class: 'drvrow' + (st.entry === e ? ' on' : ''), role: 'option', 'aria-selected': st.entry === e ? 'true' : 'false', onclick: () => {
            st.entry = e; nextBtn.disabled = false;
            for (const r of list.querySelectorAll('.drvrow')) r.classList.toggle('on', r === row);
          } },
            h('span', { class: 'drvname' }, e.name, e.lib ? h('span', { class: 'tag' }, 'library') : null, e.cat && e.cat.src === 'pe' ? h('span', { class: 'tag' }, 'PE' + (e.price ? ' $' + e.price.toFixed(2) : '')) : null, e.disc ? h('span', { class: 'tag' }, 'discontinued') : null),
            h('span', { class: 'drvstats' }, [e.size ? (+e.size).toFixed(e.size % 1 ? 2 : 0) + '"' : '', 'Fs ' + (p.fs || 0).toFixed(0), 'Qts ' + (p.qts || (p.qes && p.qms ? p.qes * p.qms / (p.qes + p.qms) : 0)).toFixed(2), 'Vas ' + U.fmt('vol', p.vas || 0), p.xmax ? 'Xmax ' + (p.xmax * 1000).toFixed(1) + ' mm' : ''].filter(Boolean).join(' · ')));
          list.append(row);
        }
        if (!hits.length) list.append(h('p', { class: 'hint' }, 'No drivers match. Try "Any size", another search, or add the driver below.'));
      };
      sizeSel.onchange = () => { st.size = sizeSel.value ? +sizeSel.value : null; fillList(); };
      // a driver added here goes into the library and is picked, whatever its size
      const onAdded = async (d) => {
        pool = null; fillList();
        const r = await matchDrivers({ pe: true });
        pool = r.list.filter(e => e.params && e.params.fs > 0 && e.params.sd > 0);
        poolNote = r.note || '';
        st.entry = pool.find(e => e.lib && e.lib.id === d.id) || null;
        st.size = null; sizeSel.value = '';
        st.q = DRV.library.name(d); search.value = st.q;
        nextBtn.disabled = !st.entry;
        fillList();
        if (!dlg.open) dlg.showModal();
      };
      dlg._onAdded = onAdded;
      const addFile = h('input', { type: 'file', multiple: true, accept: '.wdr,.txt,.json', style: { display: 'none' }, onchange: (e) => { importFiles(e.target.files, { onAdded }); e.target.value = ''; } });
      search.oninput = () => { st.q = search.value; fillList(); };

      // box first
      const b = st.box;
      const numIn = (kind2, get, set, label) => {
        const sp = U.spec(kind2), inp = h('input', { type: 'number', step: 'any', class: 'num', 'aria-label': label });
        inp.value = +(get() / sp.f).toFixed(sp.d + 1);
        inp.onchange = () => { const v = parseFloat(inp.value); if (v > 0) { set(v * sp.f); showInside(); } };
        return h('label', { class: 'field' }, h('span', { class: 'fl' }, label), h('span', { class: 'fi' }, inp, h('span', { class: 'fu' }, sp.u)));
      };
      const inside = h('div', { class: 'hint' });
      const internal = () => b.mode === 'vol' ? b.vol : Math.max(0, (b.W - 2 * b.t) * (b.H - 2 * b.t) * (b.D - 2 * b.t));
      const showInside = () => {
        inside.textContent = b.mode === 'vol' ? 'Net volume ' + U.volBoth(b.vol) + '.'
          : 'Inside ' + ['W', 'H', 'D'].map(x => U.fmt('len', b[x] - 2 * b.t)).join(' × ') + ' = ' + U.volBoth(internal()) + ', less the drivers\' own displacement. ' +
            (st.count > 1 ? 'All ' + st.count + ' drivers share it, wired in parallel. ' : '') + 'Drivers that don\'t fit the front (or are too deep) are left out.';
      };
      const modeSel = h('select', { 'aria-label': 'Box given as' }, [['dims', 'Outside dimensions'], ['vol', 'Net volume']].map(([v, t]) => h('option', { value: v }, t)));
      modeSel.value = b.mode;
      const boxFields = h('div');
      const drawBoxFields = () => {
        boxFields.innerHTML = '';
        boxFields.append(b.mode === 'vol'
          ? h('div', { class: 'grid2' }, numIn('vol', () => b.vol, (v) => { b.vol = v; }, 'Net volume'))
          : h('div', { class: 'grid2' }, numIn('len', () => b.W, (v) => { b.W = v; }, 'Width'), numIn('len', () => b.H, (v) => { b.H = v; }, 'Height'),
              numIn('len', () => b.D, (v) => { b.D = v; }, 'Depth'), numIn('thick', () => b.t, (v) => { b.t = v; }, 'Wall thickness')));
        showInside();
      };
      modeSel.onchange = () => { b.mode = modeSel.value; drawBoxFields(); };
      const boxTypes = [['sealed', 'Sealed'], ['ported', 'Ported (the box\'s best tuning, for each candidate)'], ['pr', 'Passive radiator (picked and tuned for each candidate)']]
        .concat(k.id === 'sub' ? [['bp4', '4th-order bandpass (best split and tuning)'], ['bp6p', '6th-order bandpass, dual reflex (best split and tunings)']] : []);
      const typeSel = h('select', { 'aria-label': 'Alignment' }, boxTypes.map(([v, t]) => h('option', { value: v }, t)));
      const prsSel = h('select', { 'aria-label': 'Passive radiators' }, [['best', 'One or two, whichever works better'], ['1', 'One'], ['2', 'Two']].map(([v, t]) => h('option', { value: v }, t)));
      prsSel.value = b.prs; prsSel.onchange = () => { b.prs = prsSel.value; };
      const prsField = h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Passive radiators'), h('span', { class: 'fi' }, prsSel));
      const cntIn = h('input', { type: 'number', min: 1, max: 64, step: 1, class: 'num', value: st.count, 'aria-label': 'Number of drivers' });
      cntIn.onchange = () => { st.count = Math.max(1, Math.min(64, Math.round(+cntIn.value || 1))); cntIn.value = st.count; showInside(); };
      const cntField = h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Drivers'), h('span', { class: 'fi' }, cntIn));
      prsField.hidden = b.type !== 'pr';
      typeSel.value = b.type; typeSel.onchange = () => { b.type = typeSel.value; prsField.hidden = b.type !== 'pr'; };
      const goalSel = h('select', { 'aria-label': 'Rank by' }, [['blend', 'Balance of depth and output'], ['deep', 'Deepest bass (F3)'], ['loud', 'Most output']].map(([v, t]) => h('option', { value: v }, t)));
      goalSel.value = b.goal; goalSel.onchange = () => { b.goal = goalSel.value; };
      const results = h('div', { class: 'boxresults' });
      const status = h('div', { class: 'hint' });
      let running = null;
      const findBtn = btn('Find the best 3', async () => {
        if (running) { running.stop = true; return; }
        if (!pool) return;
        const cand = pool.filter(inSize);
        if (!cand.length) { status.textContent = 'No drivers of that size to try.'; return; }
        running = { stop: false }; findBtn.textContent = 'Stop';
        results.innerHTML = '';
        const kb = KIND_BAND[k.id];
        const disp = (e) => e.params.dvol > 0 ? e.params.dvol : (() => { const g = GL.placement.driverGeom(e.params); return Math.PI * g.r * g.r * g.depth / 3; })();
        const bp = b.type === 'bp4' || b.type === 'bp6p';
        const iw = b.W - 2 * b.t, ih = b.H - 2 * b.t, id = b.D - 2 * b.t;
        const prDia = (pr) => pr.dia > 0 ? pr.dia : 2 * Math.sqrt(pr.sd / Math.PI) * 1.25;
        // on a bandpass the driver sits on the divider: whichever way the chambers go, its face must take the driver
        const N = st.count;
        const row = (dd, a1, a2) => dd <= Math.min(a1, a2) - 0.004 && N * dd + 0.006 * (N + 1) <= Math.max(a1, a2) + 1e-9;
        const fits = b.mode === 'vol' ? null : (e) => {
          const g = GL.placement.driverGeom(e.params), dd = 2 * g.r;
          if (bp) return row(dd, ih, id) || row(dd, iw, id);
          return row(dd, iw, ih) && g.depth + 0.015 <= b.D - b.t;
        };
        // passive radiator: from the catalogue, cone area 1.2-3x the driver's, the smallest that moves
        // at least twice its air (Sd x Xmax); it has to fit beside the driver on the front
        const prList = b.type === 'pr' ? catalogueRadiators() : [];
        // with two, each carries half: 0.6-1.6x the driver's cone area, together moving twice its air,
        // and the driver and both radiators in a row on the front
        const prFor = (e, dc, n = 1) => {
          // (sized for all the drivers together)
          const sd = dc.params.sd * N, vd = sd * (dc.model.Xmax || 0.003), dd = 2 * GL.placement.driverGeom(e.params).r;
          const [lo, hi] = n === 1 ? [1.2, 3] : [0.6, 1.6];
          const ok = prList.filter(pr => pr.sd >= lo * sd && pr.sd <= hi * sd &&
            (b.mode === 'vol' || (Math.max(dd, prDia(pr)) <= Math.min(iw, ih) - 0.004 && N * dd + n * prDia(pr) + 0.006 * (N + n + 1) <= Math.max(iw, ih))));
          if (!ok.length) return null;
          const enough = ok.filter(pr => n * pr.sd * (pr.xmax || 0) >= 2 * vd).sort((x, y) => x.sd - y.sd);
          const pick = enough[0] || ok.sort((x, y) => y.sd * (y.xmax || 0) - x.sd * (x.xmax || 0))[0];
          return { spec: { fs: pick.fs, vas: pick.vas, sd: pick.sd, qms: pick.qms, xmax: pick.xmax, catalogue: pick.name, disp: 0 }, name: pick.name };
        };
        if (b.type === 'pr' && !prList.length) {
          status.textContent = "The catalogue's passive radiators aren't available (build data/catalogue.js), so passive-radiator boxes can't be searched.";
          running = null; findBtn.textContent = 'Find the best 3';
          return;
        }
        const t0 = performance.now();
        const res = await GL.optimize.forBox({
          drivers: cand, type: b.type,
          // net volume: inside, less the driver, the ports (about 4%) and a bandpass divider
          volFor: (e) => Math.max(1e-4, internal() - (b.mode === 'vol' ? 0 : N * disp(e) + (bp ? b.t * Math.min(ih * id, iw * id) : 0)) - (b.type === 'sealed' || b.type === 'pr' ? 0 : internal() * 0.04)),
          count: N,
          goal: b.goal, ripple: bp ? 3 : 2, top: kb.top, band: kb.band, portShape: 'round', portLimit: 25, fits, prFor, keep: 3,
          prCounts: b.prs === 'best' ? [1, 2] : [+b.prs || 1],
          fitCheck: b.mode === 'dims' ? (r) => resultFits(r, b, k.id === 'array') : null,
          stop: () => running && running.stop, onProgress: (i, n) => { status.textContent = 'Simulating ' + i + ' of ' + n + ' drivers…'; },
        });
        running = null; findBtn.textContent = 'Find the best 3';
        status.textContent = 'Tried ' + res.tried + ' of ' + res.total + ' drivers in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s' +
          (res.tooBig ? '; ' + res.tooBig + ' too big or too deep for the box' : '') + (res.unfit ? '; ' + res.unfit + ' of the best skipped because a port or the motor would not fit' : '') + (res.noPr ? '; ' + res.noPr + ' with no passive radiator in the catalogue that suits and fits' : '') + (res.failed ? '; ' + res.failed + ' with incomplete specs' : '') + '. ' + poolNote;
        showResults(res.rows);
      }, 'btn primary');
      const showResults = (rows) => {
        results.innerHTML = '';
        if (!rows.length) { results.append(h('p', { class: 'hint' }, 'Nothing worked in that box. Try another size, alignment or a bigger box.')); return; }
        const chartHost = h('div', { class: 'npchart' });
        results.append(chartHost);
        const cards = h('div', { class: 'npcards' });
        rows.forEach((r, i) => {
          const pt = r.ports && r.ports[0];
          cards.append(h('div', { class: 'npcard' },
            h('div', { class: 'savedtop' }, lineSwatch({ color: SERIES[i + 1] }), h('b', { class: 'mname' }, (st.count > 1 ? st.count + ' × ' : '') + r.entry.name),
              r.entry.size ? h('span', { class: 'tag' }, (+r.entry.size).toFixed(r.entry.size % 1 ? 2 : 0) + '"') : null,
              r.entry.cat && r.entry.cat.src === 'pe' && r.entry.price ? h('span', { class: 'tag' }, '$' + r.entry.price.toFixed(2)) : null),
            h('div', { class: 'mstats' },
              h('span', null, 'F3 ', h('b', null, r.f3.toFixed(1) + ' Hz')),
              h('span', null, 'Max output ', h('b', null, r.out.toFixed(1) + ' dB')),
              r.fbs.length ? h('span', null, 'Fb ', h('b', null, r.fbs.map(f => f.toFixed(1)).join(' / ') + ' Hz')) : null,
              pt ? h('span', null, 'Port ' + r.ports.map(x => U.fmt('len', x.d) + ' × ' + U.fmt('len', x.len)).join(', ')) : null,
              r.prName ? h('span', null, 'PR ' + (r.prCount > 1 ? r.prCount + ' × ' : '') + r.prName) : null,
              h('span', null, r.vols.length > 1 ? r.vols.map(v => U.fmt('vol', v)).join(' + ') + ' net' : U.fmt('vol', r.net) + ' net')),
            r.ok ? null : h('div', { class: 'hint' }, r.why.join(', ')),
            h('div', { class: 'btnrow' }, btn('Use this one', () => { close(); createFromBox(r, st); }, 'btn small primary'))));
        });
        results.append(cards);
        // preview: SPL at 2.83 V, 1 m
        requestAnimationFrame(() => {
          const ch = new GL.Chart(chartHost);
          ch.set({ series: rows.map((r, i) => ({ name: r.entry.name, color: SERIES[i + 1], x: r.res.f, y: Array.from(r.res.spl) })),
            refs: [], ylabel: 'SPL 2.83 V, 1 m', unit: 'dB', span: 40, xRange: [10, r0top(rows)], digits: 1 });
        });
      };
      const r0top = (rows) => Math.min(rows[0].res.f[rows[0].res.f.length - 1], KIND_BAND[k.id].top * 2.5);

      dlg.append(h('h3', null, 'New ' + k.name.toLowerCase()),
        h('h4', null, 'Pick a driver'),
        h('div', { class: 'npfilter' }, h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Size'), h('span', { class: 'fi' }, sizeSel)), search),
        count, list,
        h('div', { class: 'npadd' }, h('span', { class: 'hint' }, 'Not listed?'),
          btn('Paste specs…', () => openImport('', { onAdded }), 'btn small'),
          btn('Import .wdr file…', () => addFile.click(), 'btn small'), addFile,
          h('span', { class: 'hint' }, 'Copy the spec table from the Parts Express page (or a datasheet) and paste it.')),
        h('div', { class: 'btnrow' }, nextBtn, btn('Back', step1, 'btn ghost'), btn('Cancel', close, 'btn ghost')),
        h('details', { class: 'npbox', open: true },
          h('summary', null, 'Or start from a box and find the best drivers for it'),
          h('p', { class: 'hint' }, 'Give the box' + (k.id === 'array' ? ' (the whole column)' : '') + ' and how many drivers share it, and every driver of the size above is simulated in it. The best three are shown with their response; pick one to start the project.'),
          h('div', { class: 'grid2' },
            h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Box given as'), h('span', { class: 'fi' }, modeSel)),
            h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Alignment'), h('span', { class: 'fi' }, typeSel)),
            h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Rank by'), h('span', { class: 'fi' }, goalSel)), cntField, prsField),
          boxFields, inside,
          h('div', { class: 'btnrow' }, findBtn), status, results));
      drawBoxFields();
      fillList();
      if (!pool) {
        const r = await matchDrivers({ pe: true });
        pool = r.list.filter(e => e.params && e.params.fs > 0 && e.params.sd > 0);
        poolNote = r.note || '';
        fillList();
      }
    };

    // ---- step 3: alignment and name for a driver picked by hand
    const step3 = () => {
      dlg._onAdded = null;
      const k = kind();
      const n = projects.filter(p => (p.id === activeId ? S.kind : (JSON.parse(p.text).state || {}).kind) === k.id).length + 1;
      st.name = st.name || (k.id === 'sub' ? 'Subwoofer ' : k.id === 'full' ? 'Speaker ' : 'Line array ') + n;
      dlg.innerHTML = '';
      const nameIn = h('input', { type: 'text', class: 'txt', value: st.name, 'aria-label': 'Project name' });
      nameIn.oninput = () => { st.name = nameIn.value; };
      const typeList = h('div', { class: 'typelist', role: 'radiogroup', 'aria-label': 'Alignment' }, k.types.map(t => {
        const r = h('input', { type: 'radio', name: 'nptype', value: t });
        r.checked = t === st.type;
        r.onchange = () => { st.type = t; };
        return h('label', { class: 'typeopt' }, r, h('span', null, h('b', null, E.typeName(t)), h('span', { class: 'hint' }, TYPE_HINT[t] || '')));
      }));
      const cnt3 = h('input', { type: 'number', min: 1, max: 64, step: 1, class: 'num', value: st.count, 'aria-label': 'Number of drivers' });
      cnt3.onchange = () => { st.count = Math.max(k.id === 'array' ? 2 : 1, Math.min(64, Math.round(+cnt3.value || 1))); cnt3.value = st.count; };
      dlg.append(h('h3', null, 'New ' + k.name.toLowerCase() + ': ' + st.entry.name),
        h('label', { class: 'field' }, h('span', { class: 'fl' }, 'Name'), h('span', { class: 'fi' }, nameIn)),
        h('label', { class: 'field' }, h('span', { class: 'fl' }, k.id === 'array' ? 'Drivers in the line' : 'Number of drivers'), h('span', { class: 'fi' }, cnt3)),
        h('h4', null, k.id === 'array' ? 'Each element is a driver in a box like this' : 'Alignment'), typeList,
        h('div', { class: 'btnrow' }, btn('Create', () => {
          close();
          st.driverId = libraryDriver(st.entry).id;
          createProject(st);
        }, 'btn primary'), btn('Back', step2, 'btn ghost'), btn('Cancel', close, 'btn ghost')));
    };
    step1();
    if (!dlg.open) dlg.showModal();
  }

  // Passive radiators from the catalogue, with Fs and Vas filled in from Mms and Cms where needed.
  function catalogueRadiators() {
    const ph = GL.phys;
    return ((GL.catalogue && GL.catalogue.prs) || []).map(c => {
      const p = c.p;
      const fs = p.fs || (p.Mms && p.Cms ? 1 / (2 * Math.PI * Math.sqrt(p.Mms * p.Cms)) : 0);
      const vas = p.vas || (p.Cms ? ph.rho * ph.c * ph.c * p.sd * p.sd * p.Cms : 0);
      return { name: c.brand + ' ' + c.model, fs, vas, sd: p.sd, qms: p.qms || 8, xmax: p.xmax || 0, dia: p.dia || 0, disc: c.disc };
    }).filter(r => r.fs > 0 && r.vas > 0 && r.sd > 0 && !r.disc);
  }

  // A driver from the search (library or catalogue) as a library entry.
  function libraryDriver(e) {
    if (e.lib) return e.lib;
    return catalogueToLibrary(e.cat);
  }

  // Shared start of every new project: fresh settings for that kind.
  function startProject(st, type) {
    stash();
    forgetProjectState();
    const units = S.units;
    Object.assign(S, { name: st.name || 'Untitled design', units, kind: st.kind, driverId: st.driverId, design: null, box: G.defaultBox(), signal: defaultSignal(),
      room: defaultRoom(), tools: defaultTools(), baffle: defaultBaffle(), array: defaultArray(), saved: [], lookNext: 0, opt: undefined, match: undefined,
      tab: 'driver', chart: 'spl', contrib: false });
    S.box.sub = 'ply';
    // N drivers sharing the box (parallel); newDesign sizes the volumes and ports for all of them
    S.design = { count: Math.max(1, st.count || 1), wiring: 'parallel' };
    newDesign(type, { fresh: true });
    S.design.driverDisp = driver().params.dvol || 0;
    S.signal.topFor = st.driverId;
    S.tab = 'enclosure';
    if (st.kind === 'full' || st.kind === 'array') {
      S.baffle.mode = 'stand';
      S.signal.fmax = 20000;
      S.box.material = 'bb12'; S.box.t = 0.012; S.box.sub = 'birch';
    }
    if (st.kind === 'array') {
      S.array.on = true;
      S.array.shared = true;
      // drivers edge to edge (outer diameter + 2 mm), all in one column box sized for them
      S.array.pitch = GL.match.outerDia(driver().params) + 0.002;
      S.array.n = Math.max(2, st.count || S.array.n);
      if (S.design.count !== S.array.n) { S.design.count = S.array.n; newDesign(type, { fresh: true }); }      // volumes and ports for all of them
      columnBox();
      S.tab = 'array';
    }
  }
  function finishProject() {
    const p = { id: GL.util.uid('pj'), show: false, slot: 0, text: null, curves: null };
    p.slot = freeSlot(p);
    projects.push(p);
    activeId = p.id;
    renderAll();
    toast('Created ' + S.name + '. Tick other tabs to compare them on the graphs.');
  }

  // A fresh project of that kind and alignment, with settings that suit it.
  function createProject(st) {
    startProject(st, st.type);
    finishProject();
  }

  // A box-first result laid out in the box that was given: the outside
  // dimensions and walls as typed, the chambers scaled to fill what's inside
  // (keeping their shares and tunings), and a layout that holds the driver.
  function boxForResult(r, b, params, line) {
    const d = JSON.parse(JSON.stringify(r.design));
    if (line && d.count > 1) d.rowPitch = GL.match.outerDia(params) + 0.002;          // a line array: drivers edge to edge
    for (const pt of d.ports) pt.holdFb = true;
    d.driverDisp = params.dvol || 0;
    const box = Object.assign(G.defaultBox(), { material: 'custom', sub: 'ply', t: b.t, layers: 1, ext: { W: b.W, H: b.H, D: b.D }, lock: { W: true, H: true, D: true }, minLen: {} });
    if (d.chambers.length > 1) {
      // divider upright (side by side) unless only the flat one takes the driver
      const dd = 2 * GL.placement.driverGeom(params).r, ih = b.H - 2 * b.t, iw = b.W - 2 * b.t, id = b.D - 2 * b.t;
      box.split = Math.min(ih, id) >= dd + 0.004 || Math.min(iw, id) < Math.min(ih, id) ? 'W' : 'H';
    }
    const vol = (id2) => d.chambers.find(c => c.id === id2).vol;
    for (let i = 0; i < 10; i++) {
      const lay = G.layout(d, box);
      const net = d.chambers.reduce((s2, c) => s2 + c.vol, 0), k = 1 + (lay.intVol - lay.gross) / net;
      for (const c of d.chambers) c.vol = Math.max(1e-5, c.vol * k);       // every chamber keeps its share
      for (const pt of d.ports) pt.len = Math.max(0.005, E.lenForFb(pt, vol(pt.from), pt.fb));
      // a passive radiator keeps the tuning it was found at
      if (d.prs.length && r.fbs.length) { const pr = d.prs[0], m = E.addedForFb(pr, vol(pr.from), r.fbs[0]); if (m >= 0) pr.added = m; }
    }
    return { design: d, box };
  }
  // Does it really go in? Ports routed, drivers on their faces, room for the motor.
  function resultFits(r, b, line) {
    try {
      const params = r.dc.params;
      const { design: d, box } = boxForResult(r, b, params, line);
      const lay = G.layout(d, box);
      const plan = GL.placement.plan(d, box, lay, params);
      if (Object.values(plan.faces).concat(plan.dividers, plan.walls || []).some(f => f.crowded && f.fit && f.fit.n)) return false;
      if (!plan.ports.every(x => x.route.fits)) return false;
      return motorRoom(plan, box, lay).every(m => m.have >= m.need - 1e-3);
    } catch (e) { return false; }
  }

  // A project from the box-first search: that driver, in that box.
  function createFromBox(r, st) {
    const k = KINDS.find(x => x.id === st.kind);
    const n = projects.filter(p => (p.id === activeId ? S.kind : (JSON.parse(p.text).state || {}).kind) === k.id).length + 1;
    const lib = libraryDriver(r.entry);
    startProject(Object.assign({}, st, { count: r.design.count, driverId: lib.id, name: (k.id === 'sub' ? 'Subwoofer ' : k.id === 'full' ? 'Speaker ' : 'Line array ') + n + ' (' + lib.model + ')' }), r.type);
    // the simulated design: its volume, tuning and port size
    const d = r.design;
    d.wiring = S.design.wiring; d.driverDisp = lib.params.dvol || 0;
    for (const pt of d.ports) pt.holdFb = true;
    S.design = d;
    S.box.minLen = {};
    const b = st.box;
    if (b.mode === 'dims') {
      const fitted = boxForResult(r, b, lib.params, st.kind === 'array');
      fitted.design.wiring = S.design.wiring;
      S.design = fitted.design;
      S.box = Object.assign(S.box, fitted.box, { material: 'custom', sub: S.box.sub || 'ply' });
      if (st.kind === 'array') {
        // the column you gave: width and height held, drivers edge to edge in a line
        S.array.n = S.design.count; S.array.shared = true; S.array.pitch = GL.match.outerDia(lib.params) + 0.002;
        S.box.lock = { W: true, H: true, D: false };
      }
    } else {
      const lay = G.layout(S.design, S.box);
      G.applyRatio(S.box, lay.gross, lay.n, { W: 1.25, H: 1, D: 0.9 });
    }
    finishProject();
  }

  // ---------------------------------------------------------------- line array: design summary
  function lineSummary() {
    const box = h('div', { class: 'sumbox' });
    const hz = (f) => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz' : f.toFixed(0) + ' Hz';
    const fill = () => {
      box.innerHTML = '';
      if (!R || !R.res) return;
      const a = S.array, d = S.design, drv = driver(), p = drv.params, dc = drvc();
      const N = Math.max(1, Math.round(a.n)), od = coneDia(), l = LA().limits(a, od);
      const els = arrayEls('main');
      const sp = LA().splays(a), curve = sp.reduce((s2, v) => s2 + v, 0);
      const bw = (f) => { const b = LA().beamwidth(els, f, boxR()); return b.open ? 'wide (no −6 dB edge)' : b.width.toFixed(0) + '°' + (Math.abs(b.aim) > 0.5 ? ', aimed ' + b.aim.toFixed(0) + '°' : ''); };
      const table = (title, rows) => h('div', { class: 'voltable' }, h('h4', null, title), h('table', null, h('tbody', null,
        rows.filter(Boolean).map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))));
      const f3v = f3(R.res, R);
      const fbs = R.model.ports.filter(pt => !pt.mouth).map(pt => pt.fb.toFixed(1) + ' Hz');
      const at1k = (() => {
        const g = LA().pressureAt(arrayEls(), LA().images(a), 1000, a.listen.d, a.listen.h, boxR());
        return 20 * Math.log10(Math.max(1e-12, Math.hypot(g.re, g.im)) / 20e-6);
      })();
      box.append(
        table('Drivers', [
          ['Driver', N + ' × ' + DRV.library.name(drv)],
          ['Size', U.fmt('len', od) + ' outside · Sd ' + U.fmt('area', p.sd) + ' each, ' + U.fmt('area', p.sd * N) + ' in all'],
          ['Fs · Qts · Vas', p.fs.toFixed(0) + ' Hz · ' + (dc.derived.qts || p.qts || 0).toFixed(2) + ' · ' + U.fmt('vol', p.vas)],
          ['Xmax · moving air', (dc.model.Xmax * 1000).toFixed(1) + ' mm · Vd ' + (p.sd * dc.model.Xmax * N * 1e6).toFixed(0) + ' cm³ in all'],
          ['Power', (dc.model.Pe || 0).toFixed(0) + ' W each, ' + ((dc.model.Pe || 0) * N).toFixed(0) + ' W in all'],
          ['Sensitivity', dc.derived.spl1w.toFixed(1) + ' dB (1 W, 1 m) each'],
          ['Wiring · load', d.wiring + ' · ' + R.sig.znomTot.toFixed(2) + ' Ω at the amplifier'],
          breakup() ? ['Cone breakup', 'about ' + hz(breakup().f)] : null]),
        table('Line', [
          ['Length', U.fmt('room', l.length) + (a.shared ? ' on one baffle' : ' of stacked cabinets')],
          ['Spacing', U.fmt('len', a.pitch) + ' centre to centre · ' + (a.pitch >= od ? U.fmt('len', a.pitch - od) + ' between frames' : 'frames overlap by ' + U.fmt('len', od - a.pitch))],
          ['Cones fill', (l.fill * 100).toFixed(0) + '% of the line'],
          ['Shape', { straight: 'Straight', arc: 'Arc', j: 'J', progressive: 'Progressive', custom: 'Own splays' }[a.shape] + (curve ? ', ' + curve.toFixed(1) + '° of curve' : '') +
            (a.tilt ? ', tilted ' + a.tilt + '°' : '') + (a.steer ? ', steered ' + a.steer + '°' : '')],
          ['Shading', { uniform: 'None', hann: 'Hann taper', legendre: 'CBT Legendre taper' }[a.shade]]]),
        table('How it behaves', [
          ['One continuous line', 'up to about ' + hz(l.continuous)],
          ['Grating lobes', 'above ' + hz(l.grating) + ' (the gaps between drivers)'],
          ['Near field reaches', [1000, 4000, 10000].map(f => U.fmt('room', l.near(f)) + ' at ' + hz(f)).join(', ')],
          ['Vertical coverage (−6 dB)', [1000, 4000, 10000].map(f => hz(f) + ' ' + bw(f)).join(' · ')],
          ['At the listener', at1k.toFixed(1) + ' dB at 1 kHz, ' + U.fmt('room', a.listen.d) + ' away, with ' + R.sig.V.toFixed(2) + ' V']]),
        table('Box', [
          ['Alignment', E.typeName(d.type)],
          ['Volume', d.chambers.map(c => U.fmt('vol', c.vol)).join(' + ') + ' net · ' + U.fmt('vol', d.chambers.reduce((s2, c) => s2 + c.vol, 0) / N) + ' per driver'],
          d.type === 'sealed' ? ['Fc · Qtc', (() => { const k = GL.standing.effect(d.chambers[0].stuff).k, ar = p.vas * N / (d.chambers[0].vol * k); return (p.fs * Math.sqrt(1 + ar)).toFixed(0) + ' Hz · ' + ((dc.derived.qts || p.qts) * Math.sqrt(1 + ar)).toFixed(2); })()] : null,
          fbs.length ? ['Tuning', fbs.join(' / ')] : null,
          ['F3', f3v.low ? f3v.low.toFixed(1) + ' Hz' : '–'],
          ['Outside', ['W', 'H', 'D'].map(k => U.fmt('len', S.box.ext[k])).join(' × ')]]),
        a.tw.on ? table('Tweeter line', [
          ['Tweeters', Math.round(a.tw.n) + ' × ' + (a.tw.type === 'ribbon' ? 'ribbon ' + U.fmt('len', a.tw.size) + ' tall' : U.fmt('len', a.tw.size) + ' dome') + ' at ' + U.fmt('len', a.tw.pitch)],
          ['Crossover', hz(a.tw.xo) + ' · ' + (SLOPES.find(x => x[0] === a.tw.order) || ['', a.tw.order])[1] + (a.tw.trim ? ' · ' + (a.tw.trim > 0 ? '+' : '') + a.tw.trim + ' dB' : '') + (a.tw.invert ? ' · reversed' : '')],
          ['One continuous line', 'up to about ' + hz(GL.phys.c / (2 * a.tw.pitch)) + ' · grating lobes above ' + hz(GL.phys.c / a.tw.pitch)]]) : '');
    };
    live.push(fill);
    fill();
    return [h('h3', null, 'Line array design'), box,
      h('p', { class: 'hint' }, 'Change the line on the Array tab, where it stands and where you listen on the Signal tab. Side view, Polar, Coverage and Level vs distance show how it radiates.')];
  }

  // ---------------------------------------------------------------- compare designs
  // Each saved design keeps its own colour and line pattern for good (colour
  // follows the design, not its place in the list).
  const LOOK_DASH = ['', '9 4', '2 3', '12 3 2 3'];
  const savedLook = (it) => ({ color: SERIES[1 + (it.look || 0) % 3], dash: LOOK_DASH[Math.floor((it.look || 0) / 3) % LOOK_DASH.length] });
  const MATCH_DASH = ['6 3', '2 3', '10 3 2 3', '1 3'];
  const matchLook = (i) => ({ color: SERIES[1 + i % 3], dash: MATCH_DASH[Math.floor(i / 3) % MATCH_DASH.length] });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const r2 = (v) => isFinite(v) ? Math.round(v * 100) / 100 : null;
  const lineSwatch = (look) => {
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), ln = document.createElementNS(NS, 'line');
    svg.setAttribute('width', '26'); svg.setAttribute('height', '10'); svg.setAttribute('class', 'lg-line'); svg.setAttribute('aria-hidden', 'true');
    for (const [k, v] of Object.entries({ x1: 2, y1: 5, x2: 24, y2: 5, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-dasharray': look.dash ? look.dash.split(' ').map(x => Math.max(1, x * 0.7)).join(' ') : '' })) ln.setAttribute(k, v);
    ln.style.stroke = look.color;
    svg.append(ln);
    return svg;
  };

  function designName() {
    const d = S.design;
    const vol = d.chambers.reduce((s, c) => s + c.vol, 0);
    return DRV.library.name(driver()) + (d.count > 1 ? ' ×' + d.count : '') + ' · ' + E.typeName(d.type).split(/[ (,–-]/)[0] + (vol ? ' ' + U.fmt('vol', vol) : '') +
      (R && R.model && R.model.ports[0] && !R.model.ports[0].mouth ? ' @' + R.model.ports[0].fb.toFixed(0) + ' Hz' : '');
  }
  // One line about a design, from its last simulation.
  function designInfo(out, dc) {
    const d = S.design, f = f3(out.res, out), bits = [];
    if (!E.isBoxless(d.type)) bits.push(d.chambers.map(c => U.fmt('vol', c.vol)).join(' + '));
    const fbs = out.model.ports.filter(pt => !pt.mouth).map(pt => pt.fb.toFixed(1));
    if (fbs.length) bits.push('Fb ' + fbs.join(' / ') + ' Hz');
    bits.push('F3 ' + (f.low ? f.low.toFixed(1) + ' Hz' : '–'));
    bits.push(out.sig.W.toFixed(0) + ' W');
    if (out.layout) bits.push(['W', 'H', 'D'].map(k => U.fmt('len', S.box.ext[k], 1)).join(' × '));
    return E.typeName(d.type) + ' · ' + bits.join(' · ');
  }
  // Curves for every chart, rounded to keep saved projects small.
  const curves = (res) => {
    const data = {};
    for (const c of CHARTS) { const y = seriesData(res, c.id); data[c.id] = y ? y.map(r2) : null; }
    return data;
  };

  // A saved-design entry for what's in S now, simulated as `out`.
  function makeSaved(out, name) {
    return { id: GL.util.uid('sv'), name: (name || '').trim() || designName(), look: S.lookNext++, show: true, savedOn: new Date().toISOString().slice(0, 10),
      state: clone({ design: S.design, box: S.box, signal: S.signal }), driver: clone(driver()),
      f: Array.from(out.res.f, v => +v.toPrecision(5)), data: curves(out.res), info: designInfo(out, out.drvc) };
  }
  function saveDesign(name) {
    if (!R || !R.res) return null;
    const it = makeSaved(R, name);
    S.saved.push(it);
    save();
    if (S.tab === 'compare') renderSide();
    drawChart();
    toast('Saved "' + it.name + '". Tick it on the Compare tab to show or hide it.');
    return it;
  }
  function updateSaved(it) {
    if (!R || !R.res) return;
    Object.assign(it, { state: clone({ design: S.design, box: S.box, signal: S.signal }), driver: clone(driver()),
      f: Array.from(R.res.f, v => +v.toPrecision(5)), data: curves(R.res), info: designInfo(R, R.drvc), savedOn: new Date().toISOString().slice(0, 10) });
    save(); renderSide(); drawChart();
    toast('Updated "' + it.name + '" with the current design.');
  }
  function loadSaved(it) {
    loadBefore = clone({ design: S.design, box: S.box, signal: S.signal, driverId: S.driverId });
    if (!DRV.library.get(it.driver.id)) DRV.library.add(clone(it.driver));
    S.design = clone(it.state.design);
    S.box = Object.assign(G.defaultBox(), clone(it.state.box));
    S.signal = Object.assign(defaultSignal(), clone(it.state.signal));
    S.driverId = it.driver.id;
    toast('Loaded "' + it.name + '".');
    changed(true);
  }

  // Bring designs in from project files: each file's own design (simulated
  // here, with its own driver, box and drive) plus any designs saved in it.
  async function importProjects(files) {
    let added = 0;
    const bad = [];
    for (const file of files) {
      let o;
      try { o = JSON.parse(await GL.util.readFileText(file)); } catch (e) { bad.push(file.name); continue; }
      if (!o || o.app !== 'GetLow' || !o.state || !o.state.design) { bad.push(file.name); continue; }
      const title = o.state.name && o.state.name !== 'Untitled design' ? o.state.name : file.name.replace(/\.getlow\.json$|\.json$/i, '');
      // the file's drivers (kept in the library so "Load" works later)
      for (const d of [o.driver].concat(o.drivers || [])) if (d && d.id && !DRV.library.get(d.id)) DRV.library.add(d);
      const keep = { design: S.design, box: S.box, signal: S.signal, driverId: S.driverId }, keepNote = boxNote;
      try {
        S.design = clone(o.state.design);
        S.box = Object.assign(G.defaultBox(), clone(o.state.box || {}));
        S.signal = Object.assign(defaultSignal(), clone(o.state.signal || {}));
        S.driverId = (o.driver && o.driver.id) || o.state.driverId;
        if (!DRV.library.get(S.driverId)) throw new Error('its driver is missing');
        const out = simulate();
        if (out.error || !out.res) throw new Error(out.error || 'no result');
        S.saved.push(makeSaved(out, title));
        added++;
      } catch (e) {
        bad.push(file.name + ' (' + e.message + ')');
      } finally {
        Object.assign(S, keep);
        boxNote = keepNote;
      }
      for (const it of o.state.saved || []) {
        if (!it || !it.data || !it.f) continue;
        if (it.driver && !DRV.library.get(it.driver.id)) DRV.library.add(clone(it.driver));
        S.saved.push(Object.assign(clone(it), { id: GL.util.uid('sv'), look: S.lookNext++, name: title + ': ' + it.name }));
        added++;
      }
    }
    save();
    renderSide();
    drawChart();
    if (added) toast('Added ' + added + ' design' + (added > 1 ? 's' : '') + ' to compare' + (bad.length ? '. Couldn\'t read ' + bad.join(', ') : '') + '.', !!bad.length);
    else toast('No designs found' + (bad.length ? ' in ' + bad.join(', ') : '') + '.', true);
  }

  // ---------------------------------------------------------------- measurements
  const measColor = (i) => ['var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--text-primary)'][i % 4];
  async function importMeasurements(files) {
    const done = [];
    for (const f of files) {
      try {
        const m = GL.frd.parse(f.name, await GL.util.readFileText(f));
        S.meas.push(Object.assign({ id: GL.util.uid('ms'), name: f.name.replace(/\.(frd|zma|txt|csv)$/i, ''), show: true, offset: 0 }, m));
        done.push(f.name + ' (' + (m.kind === 'zma' ? 'impedance' : 'response') + ', ' + m.points + ' points)');
      } catch (e) { toast('Could not read ' + f.name + ': ' + e.message, true); }
    }
    if (!done.length) return;
    // show it where it belongs
    const last = S.meas[S.meas.length - 1];
    S.chart = last.kind === 'zma' ? 'imp' : 'spl';
    toast('Imported ' + done.join(', ') + '.');
    changed(true);
    if (typeof renderChartTabs === 'function') renderChartTabs();
    drawChart();
  }
  function measCard() {
    const pick = h('input', { type: 'file', multiple: true, accept: '.frd,.zma,.txt,.csv', hidden: true, onchange: () => { importMeasurements(Array.from(pick.files)); pick.value = ''; } });
    const list = h('div', { class: 'savedlist' });
    S.meas.forEach((m, i) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Show ' + m.name });
      cb.checked = !!m.show;
      cb.onchange = () => { m.show = cb.checked; changed(); drawChart(); };
      const nm = h('input', { type: 'text', class: 'txt', value: m.name, 'aria-label': 'Name' });
      nm.onchange = () => { m.name = nm.value.trim() || m.name; changed(); drawChart(); };
      const range = m.f[0].toFixed(0) + '–' + (m.f[m.f.length - 1] >= 1000 ? (m.f[m.f.length - 1] / 1000).toFixed(1) + 'k' : m.f[m.f.length - 1].toFixed(0)) + ' Hz';
      list.append(h('div', { class: 'saved' },
        h('div', { class: 'savedtop' }, cb, lineSwatch({ color: measColor(i), dash: '1 3' }), nm),
        h('div', { class: 'grid2' },
          sel('Kind', [['frd', 'Response (SPL chart)'], ['zma', 'Impedance (impedance chart)']], () => m.kind, (v) => { m.kind = v; drawChart(); }, { structural: true }),
          m.kind === 'frd' ? nf('Level offset', () => m.offset || 0, (v) => { m.offset = v; }, { unit: 'dB', digits: 1, positive: false }) : null),
        h('div', { class: 'hint' }, range + (m.ph ? ' · with phase' : '') + ' · ' + m.f.length + ' points kept'),
        h('div', { class: 'btnrow' },
          m.kind === 'frd' && R && R.res ? btn('Match level to the simulation', () => {
            const top = Math.min(S.signal.fmax, playTop());
            m.offset = +GL.frd.matchOffset({ f: m.f, y: m.y }, Array.from(R.res.f), seriesData(R.res, 'spl'), Math.max(S.signal.fmin, (f3(R.res, R).low || S.signal.fmin) * 1.5), top).toFixed(1);
            changed(true); drawChart();
          }, 'btn small') : null,
          btn('Delete', () => { S.meas.splice(i, 1); changed(true); drawChart(); }, 'btn small ghost'))));
    });
    return card('Measurements',
      h('p', { class: 'hint' }, 'Put a real measurement next to the simulation: .frd (response) or .zma (impedance) files from REW, ARTA, DATS, LIMP and others, or any text file of frequency, value and phase. Drop them on the window or:'),
      h('div', { class: 'btnrow' }, btn('Import measurements…', () => pick.click(), 'btn'), pick),
      S.meas.length ? list : h('p', { class: 'hint' }, 'None yet.'),
      h('p', { class: 'hint' }, 'A measurement is rarely at 1 m and 2.83 V like the simulation: "Match level" lines them up over the band the speaker plays, so you can compare the shapes. Measurements near the floor or in a room add reflections the simulation doesn\'t have. They\'re saved in the project.'));
  }

  function comparePanel() {
    const nameIn = h('input', { type: 'text', class: 'txt', placeholder: R && R.res ? designName() : 'Name', 'aria-label': 'Name for the saved design' });
    const list = h('div', { class: 'savedlist' });
    if (!S.saved.length) list.append(h('p', { class: 'hint' }, 'Nothing saved yet. Set up a design (driver, box and drive), then save it here. Do the same for the next one.'));
    for (const it of S.saved) {
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Show ' + it.name + ' on the graph' });
      cb.checked = !!it.show;
      cb.onchange = () => { it.show = cb.checked; save(); drawChart(); };
      const nm = h('input', { type: 'text', class: 'txt', value: it.name, 'aria-label': 'Name' });
      nm.onchange = () => { it.name = nm.value.trim() || it.name; save(); drawChart(); };
      list.append(h('div', { class: 'saved' },
        h('div', { class: 'savedtop' }, cb, lineSwatch(savedLook(it)), nm),
        h('div', { class: 'hint' }, it.driver ? DRV.library.name(it.driver) + ' · ' + it.info : it.info),
        h('div', { class: 'btnrow' },
          btn('Load', () => loadSaved(it), 'btn small'),
          btn('Update with current', () => updateSaved(it), 'btn small ghost'),
          btn('Delete', () => { S.saved.splice(S.saved.indexOf(it), 1); save(); renderSide(); drawChart(); }, 'btn small ghost'))));
    }
    const all = (v) => { for (const it of S.saved) it.show = v; save(); renderSide(); drawChart(); };
    return card('Compare designs',
      h('p', { class: 'hint' }, 'Save each design you want to compare: its driver, box and drive level. Tick a design to put it on the graph beside the current one; each keeps its own colour and line pattern on every chart. Load one to carry on working on it.'),
      h('div', { class: 'savebar' }, nameIn, btn('Save current design', () => { if (saveDesign(nameIn.value)) nameIn.value = ''; }, 'btn primary')),
      (() => {
        const fi = h('input', { type: 'file', multiple: true, accept: '.json', style: { display: 'none' }, onchange: (e) => { importProjects(Array.from(e.target.files)); e.target.value = ''; } });
        return h('div', { class: 'btnrow' }, fi, btn('Load projects…', () => fi.click(), 'btn'),
          h('span', { class: 'hint' }, 'Pick one or more saved project files (.getlow.json) to add their designs here, ready to compare.'));
      })(),
      list,
      S.saved.length ? h('div', { class: 'btnrow' }, btn('Show all', () => all(true), 'btn small'), btn('Hide all', () => all(false), 'btn small ghost')) : null,
      loadBefore ? h('div', { class: 'btnrow' }, btn('Back to the design before', () => {
        const b = loadBefore; loadBefore = null;
        S.design = b.design; S.box = Object.assign(G.defaultBox(), b.box); S.signal = Object.assign(defaultSignal(), b.signal); S.driverId = b.driverId;
        changed(true);
      }, 'btn')) : null,
      h('p', { class: 'hint' }, 'A saved curve is kept as it was simulated, with that design\'s own drive level and filters. After changing the Signal tab, load a design and press "Update with current" to refresh it. Saved designs go into the project file.'));
  }

  // ---------------------------------------------------------------- drivers for this box
  function defaultMatch() { return { goal: 'blend', drive: 'amp', watts: 300, volts: 2.83, f0: 25, f1: 80, ripple: 2, size: 'fits', pe: true, keep: 10, ohms: 'any', coils: 'any', load: 'any' }; }

  // Every driver we know of: the catalogue (when built) and the library.
  // A library driver's nominal size from its cone area (typical Sd of each size, cm²), so a pasted
  // 5-1/4" woofer shows as 5.25", not as its 4" cone
  const NOMINAL_SD = [[2, 12], [3, 30], [4, 55], [5.25, 88], [6.5, 135], [8, 215], [10, 340], [12, 495], [15, 860], [18, 1210], [21, 1650]];
  function nominalSize(p) {
    const cm2 = (p.sd || 0) * 1e4;
    if (!(cm2 > 0)) return GL.match.outerDia(p) / 1.18 / U.IN;
    return NOMINAL_SD.reduce((b, x) => Math.abs(Math.log(x[1] / cm2)) < Math.abs(Math.log(b[1] / cm2)) ? x : b)[0];
  }
  async function matchDrivers(o) {
    const out = [], seen = new Set();
    const push = (e) => { const k = e.name.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push(e); };
    for (const d of DRV.library.list) {
      if (!(d.params && d.params.fs > 0 && d.params.sd > 0)) continue;
      push({ key: 'lib:' + d.id, name: DRV.library.name(d), params: d.params, vc: d.vc, lib: d, size: nominalSize(d.params) });
    }
    let note = '';
    try {
      const cat = await loadCatalogue();
      for (const c of cat.drivers) {
        if (c.src === 'pe' && !o.pe) continue;
        const params = Object.assign({}, c.p);
        if (!params.dvol && params.dia && params.depth) params.dvol = Math.PI * (params.dia / 2) ** 2 * params.depth / 3;
        push({ key: 'cat:' + c.id, name: c.brand + ' ' + c.model, params, vc: c.vc, cat: c, size: c.size, price: c.price, disc: c.disc });
      }
    } catch (e) { note = 'The driver catalogue isn\'t built (tools/build-catalogue.py), so only your library was searched.'; }
    return { list: out, note };
  }

  // Can it physically go in? Same face, same ports, motor depth.
  function matchFits(r) {
    const d = r.design, box = S.box, base = R && R.plan;
    try {
      const lay = G.layout(d, box);
      const pl = GL.placement.plan(d, box, lay, r.dc.params);
      const faces = Object.values(pl.faces).concat(pl.dividers);
      if (faces.some(f => f.crowded)) return { ok: false, why: 'too big for its mounting face' };
      for (const x of pl.ports) {
        const was = base && base.ports.find(y => y.pt.id === x.pt.id);
        if (!x.route.fits && (!was || was.route.fits)) return { ok: false, why: 'a port no longer fits' };
      }
      const m = d.mount, depth = pl.drv.depth;
      const room = m.front === 'out' ? box.ext.D - box.t * (1 + box.layers) : (lay.chambers.find(c => c.id === m.rear) || {}).len;
      if (room && depth > room - 0.01) return { ok: false, why: 'too deep' };
      // the depth is guessed from the size when the specs don't give it: say so only when it's tight
      return { ok: true, note: pl.drv.estimated && room && depth > room - 0.035 ? 'depth estimated, tight' : '' };
    } catch (e) { return { ok: true, note: '' }; }
  }

  // Biggest outer diameter the driver's mounting face takes, from the current layout.
  function matchMaxDia() {
    if (!R || !R.plan) return 0;
    const d = S.design, m = d.mount;
    const f = m.front === 'out' ? R.plan.faces[m.rear] : R.plan.dividers.find(x => x.items.some(it => it.type === 'drv'));
    if (!f) return 0;
    const cur = 2 * R.plan.drv.r;
    return cur + Math.max(0, f.slack || 0) / Math.max(1, f.items.filter(it => it.type === 'drv').length) + 0.002;
  }

  async function startMatch(status, table, runBtn) {
    const o = S.match;
    matchRunning = { stop: false };
    runBtn.textContent = 'Stop';
    status.textContent = 'Loading drivers…';
    const { list, note } = await matchDrivers(o);
    const cur = Math.round(GL.match.outerDia(driver().params) / 1.18 / U.IN * 2) / 2;
    const sized = o.size === 'fits' ? list : list.filter(e => e.size && Math.abs(e.size - (o.size === 'same' ? cur : +o.size)) < 0.75);
    const zf = GL.match.filterByImpedance(sized, o, S.design.count, S.design.wiring);
    const pool = zf.list;
    const sig = S.signal;
    const filter = (w) => chainH(w, sig);
    const t0 = performance.now();
    try {
      const res = await GL.match.run({
        design: S.design, drivers: pool, freqs: GL.util.logspace(S.signal.fmin, S.signal.fmax, 200),
        drive: { mode: o.drive, watts: o.watts, volts: o.volts }, filter, band: [o.f0, o.f1], top: o.f1,
        goal: o.goal, ripple: o.ripple, keep: o.keep, maxDia: matchMaxDia(), fitCheck: matchFits,
        stop: () => matchRunning && matchRunning.stop,
        onProgress: (k, n) => { status.textContent = 'Simulating ' + k + ' of ' + n + ' drivers…'; },
      });
      res.rows.forEach((r, i) => { r.show = i < 5; });
      res.note = note; res.zDropped = zf.dropped; res.secs = (performance.now() - t0) / 1000; res.pool = pool.length;
      res.curName = DRV.library.name(driver()).toLowerCase();
      matchRes = res;
    } catch (e) { console.error(e); status.textContent = 'Search failed: ' + e.message; }
    matchRunning = null;
    renderSide();
    if (matchRes) showView('results');
    drawChart();
  }

  function useMatch(r) {
    const e = r.entry;
    const design = clone(r.design);
    if (e.cat) addFromCatalogue(e.cat);
    else { S.driverId = e.lib.id; }
    S.design = design;                     // the same box, volumes corrected for this driver's motor
    toast('Using ' + e.name + ' in this box.');
    changed(true);
  }
  function saveMatch(r) {
    const e = r.entry;
    const drv = e.lib ? clone(e.lib) : { id: GL.util.uid('drv'), brand: e.cat.brand, model: e.cat.model, params: clone(e.params), vc: e.cat.vc,
      source: e.cat.src === 'pe' ? 'Parts Express page' : 'OpenISD catalogue', catalogueId: e.cat.id, page: e.cat.page, sheet: e.cat.sheet };
    const signal = Object.assign(clone(S.signal), r.watts != null ? { mode: 'watts', watts: r.watts } : { mode: 'volts', volts: r.V });
    const it = { id: GL.util.uid('sv'), name: e.name + ' in this box', look: S.lookNext++, show: true, savedOn: new Date().toISOString().slice(0, 10),
      state: { design: clone(r.design), box: clone(S.box), signal }, driver: drv,
      f: Array.from(r.res.f, v => +v.toPrecision(5)), data: curves(r.res),
      info: E.typeName(r.design.type) + ' · F3 ' + (r.f3 ? r.f3.toFixed(1) + ' Hz' : '–') + ' · ' + (r.watts != null ? r.watts.toFixed(0) + ' W' : r.V.toFixed(2) + ' V') };
    S.saved.push(it); save(); drawChart();
    toast('Saved "' + it.name + '" to the Compare tab.');
  }

  const fmtOhm = (z) => (Math.abs(z - Math.round(z)) < 0.05 ? Math.round(z) : z.toFixed(1)) + ' Ω';
  function matchCard(part = 'side') {
    const o = (S.match = Object.assign(defaultMatch(), S.match || {}));
    const status = h('div', { class: 'hint' }, matchRunning ? 'Searching…' : '');
    const table = h('div', { class: 'voltable' });
    const runBtn = btn(matchRunning ? 'Stop' : 'Find drivers', () => {
      if (matchRunning) { matchRunning.stop = true; return; }
      startMatch(status, table, runBtn);
    }, 'btn primary');
    const boxless = E.isBoxless(S.design.type) || E.isLine(S.design.type) || E.isHorn(S.design.type);
    const sizes = [['fits', 'Any size that fits'], ['same', 'Same size as ' + DRV.library.name(driver())], ...[6.5, 8, 10, 12, 15, 18, 21].map(v => [String(v), v + '"'])];
    if (matchRes) {
      const mr = matchRes;
      const list = h('div', { class: 'savedlist' });
      mr.rows.forEach((r, i) => {
        const cb = h('input', { type: 'checkbox', 'aria-label': 'Show ' + r.entry.name + ' on the graph' });
        cb.checked = !!r.show;
        cb.onchange = () => { r.show = cb.checked; drawChart(); };
        const notes = [];
        if (r.ripple > o.ripple) notes.push('peaks ' + r.ripple.toFixed(1) + ' dB');
        if (r.xOver > 1) notes.push('hits Xmax');
        if (r.vPort > 17) notes.push('port ' + r.vPort.toFixed(0) + ' m/s');
        if (r.fitNote) notes.push(r.fitNote);
        if (r.entry.disc) notes.push('discontinued');
        const cur = r.entry.name.toLowerCase() === mr.curName;
        const fbs = r.fbs.filter(v => isFinite(v) && v > 0).map(v => v.toFixed(1)).join(' / ');
        list.append(h('div', { class: 'saved' },
          h('div', { class: 'savedtop' }, cb, lineSwatch(matchLook(i)),
            h('b', { class: 'mname' }, '#' + (i + 1) + ' ' + r.entry.name),
            r.entry.size ? h('span', { class: 'tag' }, (+r.entry.size).toFixed(r.entry.size % 1 ? 1 : 0) + '"') : null,
            cur ? h('span', { class: 'tag' }, 'current') : null,
            r.entry.cat && r.entry.cat.src === 'pe' ? h('span', { class: 'tag' }, 'PE' + (r.entry.price ? ' $' + r.entry.price.toFixed(2) : '')) : null),
          h('div', { class: 'mstats' },
            h('span', null, 'F3 ', h('b', null, r.f3 ? r.f3.toFixed(1) + ' Hz' : '–')),
            h('span', null, 'Peaking ', h('b', null, r.ripple > 0.05 ? '+' + r.ripple.toFixed(1) + ' dB' : 'flat')),
            h('span', null, 'Output ', h('b', null, r.out.toFixed(1) + ' dB')),
            h('span', null, (r.watts != null ? r.watts.toFixed(0) + ' W' : r.V.toFixed(2) + ' V') + ' into ' + fmtOhm(r.load) +
              (r.entry.vc ? ' (' + fmtOhm(GL.match.coilOhms(r.entry)) + ' DVC, coils in ' + r.coilWiring + ')' : '') + (fbs ? ' · Fb ' + fbs + ' Hz' : ''))),
          notes.length ? h('div', { class: 'hint' }, notes.join(' · ')) : null,
          h('div', { class: 'btnrow' }, cur ? null : btn('Use in this box', () => useMatch(r), 'btn small'), btn('Save to compare', () => saveMatch(r), 'btn small ghost'))));
      });
      table.append(list);
      table.append(h('p', { class: 'hint' }, 'Simulated ' + mr.tried + ' of ' + mr.pool + ' drivers in ' + mr.secs.toFixed(1) + ' s' +
        (mr.tooBig ? '; ' + mr.tooBig + ' too big for the baffle' : '') + (mr.unfit ? '; ' + mr.unfit + ' of the best didn\'t fit (port, depth or face)' : '') +
        (mr.failed ? '; ' + mr.failed + ' with incomplete specs' : '') + (mr.zDropped ? '; ' + mr.zDropped + ' left out by the impedance filter' : '') + '. ' + (mr.note || '') +
        ' Output is the average level over the band at that power, limited by Xmax and each driver\'s rating. Tick a driver to put it on the graph (any chart). "Use" swaps it into this box; "Save" keeps it on the Compare tab.'));
    }
    if (part === 'main') return card('Drivers for this box', table,
      h('div', { class: 'btnrow' }, btn('Clear', () => { matchRes = null; renderSide(); renderMainView(); drawChart(); }, 'btn ghost')));
    return card('Drivers for this box',
      h('p', { class: 'hint' }, 'Keeps the current box exactly as it is (volumes, ports, driver count and wiring) and tries every driver in the catalogue and your library in it. Each one\'s motor displacement is allowed for.'),
      boxless ? h('p', { class: 'warn' }, 'Works with box designs (sealed, ported, bandpass, PR). Pick one on the Enclosure tab.') : null,
      h('div', { class: 'grid2' },
        sel('Rank by', [['blend', 'Balance of depth and output'], ['deep', 'Deepest F3'], ['loud', 'Most output in the band']], () => o.goal, (v) => { o.goal = v; }, { structural: false }),
        sel('Drive', [['amp', 'My amplifier (capped at each driver\'s rating)'], ['volts', 'The same voltage for all']], () => o.drive, (v) => { o.drive = v; }),
        o.drive === 'amp' ? uf('Amplifier power', 'watt', () => o.watts, (v) => { o.watts = v; }, { structural: false })
          : uf('Voltage', 'volt', () => o.volts, (v) => { o.volts = v; }, { structural: false }),
        sel('Size', sizes, () => o.size, (v) => { o.size = v; }, { structural: false }),
        uf('Judge from', 'freq', () => o.f0, (v) => { o.f0 = v; }, { structural: false }),
        uf('to', 'freq', () => o.f1, (v) => { o.f1 = v; }, { structural: false }),
        nf('Allowed peaking', () => o.ripple, (v) => { o.ripple = Math.max(0, v); }, { unit: 'dB', digits: 1, structural: false }),
        sel('Impedance (each coil)', [['any', 'Any'], ...[1, 2, 4, 8, 16].map(z => [String(z), z + ' Ω'])], () => String(o.ohms), (v) => { o.ohms = v; }, { structural: false }),
        sel('Voice coils', [['any', 'Single or dual'], ['svc', 'Single only'], ['dvc', 'Dual only']], () => o.coils, (v) => { o.coils = v; }, { structural: false }),
        sel('Load at the amplifier', [['any', 'Any'], ...[0.5, 1, 2, 4, 8].map(z => [String(z), z + ' Ω'])], () => String(o.load), (v) => { o.load = v; }, { structural: false }),
        nf('Show the best', () => o.keep, (v) => { o.keep = Math.max(1, Math.min(30, Math.round(v))); }, { digits: 0, structural: false })),
      h('p', { class: 'hint' }, 'Load at the amplifier allows for your ' + S.design.count + ' driver' + (S.design.count > 1 ? 's wired in ' + S.design.wiring : '') +
        ' (Driver tab). Dual-coil drivers are wired series or parallel, whichever gives that load.'),
      check('Include Parts Express drivers (if built)', () => o.pe !== false, (v) => { o.pe = v; }),
      h('div', { class: 'btnrow' }, boxless ? null : runBtn),
      status, matchRes ? h('p', { class: 'hint' }, 'Results are in Search results, above the graphs.') : null);
  }

  function toast(msg, bad, action) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg,
      action ? h('button', { class: 'btn small toast-act', onclick: () => { t.remove(); action.run(); } }, action.label) : null);
    document.body.append(t);
    setTimeout(() => t.remove(), action ? (action.ms || 8000) : bad ? 6000 : 3000);
  }

  // ---------------------------------------------------------------- top bar
  function bindTop() {
    const unitsSel = document.getElementById('units');
    unitsSel.value = S.units;
    unitsSel.onchange = () => { S.units = U.system = unitsSel.value; renderSide(); compute(); };
    document.getElementById('save').onclick = () => {
      if (!hasProject()) return toast('Nothing to save yet: start or open a project.', true);
      GL.util.downloadText(S.name.replace(/[^\w.-]+/g, '_') + '.getlow.json', JSON.stringify(projectJson(), null, 1), 'application/json');
    };
    const open = document.getElementById('openfile');
    document.getElementById('open').onclick = () => open.click();
    document.getElementById('wopen').onclick = () => open.click();
    document.getElementById('newproj').onclick = () => newProjectDialog();
    document.getElementById('wnew').onclick = () => newProjectDialog();
    document.getElementById('wpaste').onclick = () => openImport('');
    const wfile = document.getElementById('wdrvfile');
    document.getElementById('wdrv').onclick = () => wfile.click();
    wfile.onchange = () => { importFiles(wfile.files); wfile.value = ''; };
    open.onchange = async () => {
      // each file opens in a tab of its own
      for (const f of Array.from(open.files)) {
        try {
          const o = JSON.parse(await GL.util.readFileText(f));
          if (o && o.getlow === 'backup') { restoreBackup(o); continue; }
          if (!o || !o.state || !o.state.design) throw new Error('not a GetLow project');
          addProject(o);
          toast('Opened ' + S.name);
        } catch (e) { toast('Could not open ' + f.name + ': ' + e.message, true); }
      }
      open.value = '';
    };
    document.getElementById('snap').onclick = () => saveDesign();
    document.getElementById('clearsnap').onclick = () => {
      for (const it of S.saved) it.show = false;
      if (matchRes) for (const r of matchRes.rows) r.show = false;
      save(); drawChart(); if (S.tab === 'compare' || S.tab === 'optimize') renderSide();
    };
    const ct = document.getElementById('contrib-cb');
    ct.checked = S.contrib;
    ct.onchange = () => { S.contrib = ct.checked; drawChart(); };
    const xr = document.getElementById('xray');
    xr.checked = S.xray;
    xr.onchange = () => { S.xray = xr.checked; renderMain(); };
    const exb = document.getElementById('explode');
    exb.checked = S.explode;
    exb.onchange = () => { S.explode = exb.checked; renderMain(); };

    // drop driver files or projects anywhere
    window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dropping');
      if (e.dataTransfer.files.length) dropFiles(Array.from(e.dataTransfer.files));
    });
  }

  function renderAll() {
    renderProjectTabs();
    const none = !hasProject();
    document.body.classList.toggle('noproj', none);
    document.getElementById('welcome').hidden = !none;
    if (none) storageNote().then(t => { document.getElementById('wstore').textContent = t; });
    if (none) { R = null; histReset(); return; }
    const fresh = hist.owner !== activeId;
    document.getElementById('units').value = S.units;
    renderSide();
    renderMainView();
    compute();
    // start the history after the first solve (it may settle the box or ports)
    if (fresh) histReset();
  }

  // ---------------------------------------------------------------- undo and redo
  // Snapshots of the project (everything but which tab and view you're looking
  // at), taken a moment after each change so a burst of typing is one step.
  const hist = { owner: undefined, stack: [], i: -1, timer: 0, restoring: false };
  const VIEW_KEYS = ['tab', 'view', 'sub'];
  const snap = () => JSON.stringify(S, (k, v) => VIEW_KEYS.includes(k) ? undefined : v);
  function histReset() {
    clearTimeout(hist.timer); hist.timer = 0;
    hist.owner = activeId;
    hist.stack = hasProject() ? [snap()] : [];
    hist.i = hist.stack.length - 1;
    histButtons();
  }
  function histRecord() {
    clearTimeout(hist.timer); hist.timer = 0;
    if (hist.restoring || !hasProject() || hist.owner !== activeId) return;
    const s = snap();
    if (s === hist.stack[hist.i]) return;
    hist.stack = hist.stack.slice(0, hist.i + 1);
    hist.stack.push(s);
    if (hist.stack.length > 100) hist.stack.shift();
    hist.i = hist.stack.length - 1;
    histButtons();
  }
  function histLater() {
    if (hist.restoring) return;
    clearTimeout(hist.timer);
    hist.timer = setTimeout(histRecord, 500);
  }
  function histGo(step) {
    if (hist.timer) histRecord();          // a change still waiting counts as a step
    const j = hist.i + step;
    if (j < 0 || j >= hist.stack.length) return;
    hist.i = j;
    const keep = { tab: S.tab, view: S.view, sub: S.sub };
    hist.restoring = true;
    try {
      loadProject({ state: Object.assign(JSON.parse(hist.stack[j]), keep) });
      document.getElementById('units').value = S.units;
      renderProjectTabs();
      renderSide();
      renderMainView();
      compute();
    } finally { hist.restoring = false; }
    histButtons();
    saveWorkspace();
  }
  function histButtons() {
    const u = document.getElementById('undo'), r = document.getElementById('redo');
    if (u) u.disabled = hist.i <= 0;
    if (r) r.disabled = hist.i >= hist.stack.length - 1;
  }
  function bindHistory() {
    document.getElementById('undo').onclick = () => histGo(-1);
    document.getElementById('redo').onclick = () => histGo(1);
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // inside a text box the browser's own undo works on the text
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(t.type)) || t.isContentEditable)) return;
      if (document.querySelector('dialog[open], .bs-overlay')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); histGo(-1); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); histGo(1); }
    });
  }

  // ---------------------------------------------------------------- boot
  // The splash: real progress while GetLow starts, gone as soon as it's ready
  // (at least a moment, so it doesn't flash), or on a click or a key.
  const splash = (() => {
    const el = document.getElementById('splash');
    if (!el) return { step() {}, done() {} };
    const t0 = performance.now(), fill = document.getElementById('splash-fill'), msg = document.getElementById('splash-msg');
    const quick = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let gone = false;
    const hide = () => {
      if (gone) return;
      gone = true;
      el.classList.add('out');
      setTimeout(() => el.remove(), quick ? 0 : 450);
    };
    el.addEventListener('click', hide);
    window.addEventListener('keydown', hide, { once: true });
    return {
      step(pct, text) { if (fill) fill.style.width = pct + '%'; if (msg && text) msg.textContent = text; },
      done() {
        this.step(100, 'Ready');
        const wait = Math.max(0, (quick ? 300 : 1100) - (performance.now() - t0));
        setTimeout(hide, wait);
      },
    };
  })();
  splash.step(35, 'Loading your drivers…');

  function boot() {
    DRV.library.load();
    splash.step(55, 'Opening your projects…');
    // a usable state underneath, even with no project open
    S.driverId = (DRV.library.get('sample-grs-8sw-4he') || DRV.library.list[0]).id;
    newDesign('ported');
    try {
      const w = JSON.parse(localStorage.getItem(WKEY) || 'null');
      if (w && Array.isArray(w.projects)) {
        projects = w.projects.filter(x => x.project && x.project.state).map(x => ({ id: x.id, show: !!x.show, slot: x.slot || 0, text: JSON.stringify(x.project), curves: x.curves || null }));
        activeId = projects.some(x => x.id === w.active) ? w.active : (projects[0] && projects[0].id) || null;
      } else {
        // first run with tabs: the single project saved by older versions becomes the first tab
        const o = JSON.parse(localStorage.getItem(PKEY) || 'null');
        if (o && o.state && o.state.design) {
          projects = [{ id: GL.util.uid('pj'), show: false, slot: 0, text: JSON.stringify(o), curves: null }];
          activeId = projects[0].id;
        }
      }
    } catch (e) { projects = []; activeId = null; }
    const a = activeProj();
    if (a) { try { loadProject(JSON.parse(a.text)); a.text = null; } catch (e) { projects = projects.filter(p => p !== a); activeId = null; } }
    if (!DRV.library.get(S.driverId)) S.driverId = DRV.library.list[0].id;
    U.system = S.units;
    chart = new GL.Chart(document.getElementById('chart'));
    view = new GL.BoxView(document.getElementById('view3d'));
    bindTop();
    splash.step(80, 'Simulating…');
    renderAll();
    bindImport();
    bindHistory();
    offline();
    keepStorage();
    document.getElementById('ver').textContent = GL.VERSION;
    document.getElementById('brand').onclick = () => aboutDialog(false);
    splash.done();
    newsAfterUpdate();
  }

  // Installed (or visited) from a web address: keep a copy for offline use, and
  // offer the new version when one is uploaded. Not on a local dev server, where
  // a cached copy would hide your edits.
  function offline() {
    const local = /^(localhost|127\.|\[::1\]|.*\.localhost$)/.test(location.hostname);
    // ?sw tries it on a local server too (to test a build before uploading it)
    const force = /[?&]sw(=|&|$)/.test(location.search) && local;
    if (!('serviceWorker' in navigator) || !(force || (location.protocol === 'https:' && !local))) return;
    // reload only when a new version replaces the old one, not on the first visit
    const had = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!had || reloading) return;
      reloading = true;
      try { saveWorkspace(); } catch (e) { /* nothing to keep */ }
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = (w) => toast('A new version of GetLow is ready.', false, { label: 'Update now', run: () => w.postMessage('skip'), ms: 30000 });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
      // look for a new version now and then while it's open
      setInterval(() => reg.update().catch(() => null), 60 * 60 * 1000);
    }).catch(() => null);
  }

  GL.app = { S, boot, compute, newDesign, setDim, get results() { return R; } };
  document.addEventListener('DOMContentLoaded', boot);
})(window.GL);
