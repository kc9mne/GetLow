/* GetLow – driver matcher. Keeps a box exactly as built (chamber volumes,
 * ports, driver count and wiring) and tries other drivers in it: each one is
 * simulated, measured (F3, peaking, output over a band with a given amplifier)
 * and ranked. A driver with a bigger or smaller motor changes the air left in
 * its chamber, so its chamber volume is corrected by the difference in
 * displacement. Ports keep their physical size, so tunings only move with that
 * small volume change. */
(function (GL) {
  'use strict';
  const E = GL.enclosures, DRV = GL.drivers;
  const yieldNow = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Outside diameter of a driver (catalogue value, or estimated from Sd).
  const outerDia = (p) => p.dia > 0 ? p.dia : 2 * Math.sqrt(p.sd / Math.PI) * 1.18;

  // The design with driver p in place of the current one.
  function swapInto(design, p) {
    const d = clone(design);
    const was = design.driverDisp || 0, now = p.dvol || 0;
    d.driverDisp = now;
    const n = d.count, m = d.mount;
    const add = (id, k) => { const c = d.chambers.find(x => x.id === id); if (c) c.vol = Math.max(1e-5, c.vol + (was - now) * k); };
    if (m.rear2) { add(m.rear, n / 2); add(m.rear2, n / 2); }
    else if (d.chambers.find(c => c.id === m.rear)) add(m.rear, n);
    else add(m.front, n);
    for (const pt of d.ports) delete pt.holdFb;   // the port is built: keep its length
    return d;
  }

  // Simulate and measure one driver in the box.
  // o: { design, freqs, drive: { mode: 'amp'|'volts', watts, volts }, filter(w) -> complex, band: [f0, f1], top }
  function tryDriver(entry, o) {
    const pub = entry.vc ? (entry.wiring || (entry.vc.published === 'parallel' ? 'parallel' : 'series')) : null;
    const p = entry.vc ? GL.specparse.forWiring(entry.params, entry.vc, pub) : entry.params;
    const dc = DRV.complete(p);
    const d = swapInto(o.design, p);
    if (pub) d.coilWiring = pub; else delete d.coilWiring;   // carried over by "Use" / "Save"

    const N = d.count, series = d.wiring === 'series';
    const znomTot = series ? dc.model.znom * N : dc.model.znom / N;
    // amplifier power, but never more than the drivers are rated for
    const watts = o.drive.mode === 'amp' ? Math.min(o.drive.watts, dc.params.pe > 0 ? dc.params.pe * N : o.drive.watts) : null;
    const V = watts != null ? Math.sqrt(watts * znomTot) : o.drive.volts;
    const per = series ? V / N : V;
    const model = E.buildModel(d, dc, (w) => GL.cx.cscale(o.filter ? o.filter(w) : GL.cx.C(1), per));
    const res = GL.sweep(model, o.freqs, { volts: V, drive: per, vmax: 0 });
    const ref = dc.derived.spl1w + 20 * Math.log10(N * per / Math.sqrt(dc.model.Re));
    const m = GL.optimize.measure(res, d.type, { top: o.top, refLevel: ref, fs: dc.params.fs });
    // over the band: what it plays at this drive, limited by Xmax and power handling
    const [f0, f1] = o.band;
    let out = 0, lvl = 0, k = 0, xPk = 0, vPk = 0;
    for (let i = 0; i < res.f.length; i++) {
      if (res.f[i] < f0 || res.f[i] > f1) continue;
      out += Math.min(res.spl[i], res.maxSpl[i]); lvl += res.spl[i]; k++;
      xPk = Math.max(xPk, res.xpk[i]);
      for (const pv of res.portVel) vPk = Math.max(vPk, pv.v[i]);
    }
    const xmax = dc.model.Xmax * 1000;
    return {
      entry, dc, design: d, res, V, watts, load: znomTot, coilWiring: pub,
      f3: m.low, ripple: m.ripple, out: k ? out / k : NaN, level: k ? lvl / k : NaN,
      xOver: xmax > 0 ? xPk / xmax : 0, vPort: vPk,
      fbs: model.ports ? model.ports.map(pp => pp.fb) : [],
    };
  }

  // Rank drivers for the box. o adds: drivers [{ key, name, params, vc, ... }],
  // maxDia (biggest outer diameter the mounting face takes), goal 'deep'|'loud'|'blend',
  // ripple (dB allowed), fitCheck(row) -> { ok, why } (optional, run on the best ones),
  // keep (how many to return), onProgress(done, total), stop() -> bool.
  async function run(o) {
    const rows = [];
    let tooBig = 0, failed = 0;
    for (let i = 0; i < o.drivers.length; i++) {
      if (o.stop && o.stop()) break;
      const e = o.drivers[i];
      if (o.maxDia && outerDia(e.params) > o.maxDia) { tooBig++; continue; }
      try {
        const r = tryDriver(e, o);
        if (!isFinite(r.out)) { failed++; continue; }
        // keep memory down: only the best keep their full curves (trimmed below)
        rows.push(r);
      } catch (err) { failed++; }
      if (i % 20 === 19) { if (o.onProgress) o.onProgress(i + 1, o.drivers.length); await yieldNow(); }
    }
    rank(rows, o);
    for (let i = 80; i < rows.length; i++) { rows[i].res = null; rows[i].design = null; }
    const keep = o.keep || 10, out = [];
    let unfit = 0;
    for (const r of rows) {
      if (out.length >= keep) break;
      if (o.fitCheck) {
        const fc = o.fitCheck(r);
        if (!fc.ok) { unfit++; continue; }
        r.fitNote = fc.note || '';
      }
      out.push(r);
    }
    return { rows: out, tried: rows.length, tooBig, failed, unfit, total: o.drivers.length };
  }

  // Best first. Drivers that peak more than allowed (or never roll off) go last.
  function rank(rows, o) {
    const good = (r) => r.f3 != null && r.ripple <= o.ripple;
    if (o.goal === 'blend') {
      // equal weight: one octave lower F3 is worth as much as 6 dB more output
      for (const r of rows) r.score = (r.f3 ? -6 * Math.log2(r.f3) : -99) + r.out;
    }
    const key = o.goal === 'deep' ? (r) => -(r.f3 || 1e3) : o.goal === 'loud' ? (r) => r.out : (r) => r.score;
    rows.sort((a, b) => (good(b) - good(a)) || (key(b) - key(a)));
  }

  // Nominal impedance of one voice coil. Specs for dual-coil drivers are often
  // given for the coils wired together, so work back to one coil.
  const STD = [1, 2, 4, 6, 8, 16];
  const nearestStd = (z) => STD.reduce((a, b) => Math.abs(Math.log(b / z)) < Math.abs(Math.log(a / z)) ? b : a);
  function coilOhms(entry) {
    const p = entry.params, vc = entry.vc;
    const z = p.znom > 0 ? p.znom : p.re > 0 ? nearestStd(p.re / 0.8) : NaN;
    if (!vc) return z;
    if (vc.perCoil > 0) return vc.perCoil;
    return vc.published === 'parallel' ? z * 2 : vc.published === 'single' ? z : z / 2;
  }
  // The load the amplifier sees: per-coil impedance, coil wiring (dual coil),
  // then the drivers' wiring.
  function ampLoad(entry, wiring, count, driversWiring) {
    const c = coilOhms(entry);
    const one = !entry.vc ? c : wiring === 'parallel' ? c / 2 : c * 2;
    return driversWiring === 'series' ? one * count : one / count;
  }
  // Which drivers pass the impedance filters. f: { ohms: 'any'|number (per coil),
  // coils: 'any'|'svc'|'dvc', load: 'any'|number (at the amp) }. A dual-coil driver
  // is wired (series or parallel) to give the load asked for, when it can.
  function filterByImpedance(list, f, count, driversWiring) {
    const out = [];
    let dropped = 0;
    for (const e of list) {
      const c = coilOhms(e);
      if (f.coils === 'svc' && e.vc) { dropped++; continue; }
      if (f.coils === 'dvc' && !e.vc) { dropped++; continue; }
      if (f.ohms !== 'any' && !(Math.abs(c / +f.ohms - 1) < 0.15)) { dropped++; continue; }
      if (f.load === 'any') { out.push(e); continue; }
      const ways = e.vc ? ['series', 'parallel'] : [null];
      const w = ways.find(x => Math.abs(ampLoad(e, x, count, driversWiring) / +f.load - 1) < 0.15);
      if (w === undefined) { dropped++; continue; }
      out.push(w ? Object.assign({}, e, { wiring: w }) : e);
    }
    return { list: out, dropped };
  }

  GL.match = { run, tryDriver, swapInto, rank, outerDia, coilOhms, ampLoad, filterByImpedance };
})(window.GL);
