/* GetLow – design search. For one driver, runs through enclosure types,
 * volumes and tunings, simulates each, and ranks them against a goal:
 *   small  – smallest box whose F3 reaches the target
 *   deep   – lowest F3 within a maximum box size
 *   blend  – a weighted mix of box size (vs the maximum) and F3 (vs the target)
 * Every candidate must also stay flat enough (ripple), keep its port under an
 * air-speed limit at full power (ports are sized up to suit), and, for
 * bandpass, reach up to the top of the band. */
(function (GL) {
  'use strict';
  const E = GL.enclosures;

  const TYPES = [['sealed', 'Sealed'], ['ported', 'Ported'], ['bp4', '4th-order bandpass'], ['bp6p', '6th-order bandpass, dual reflex'],
    ['bp6s', '6th-order bandpass, series tuned'], ['manifold', 'Manifold (2+ drivers)']];
  const logspace = (a, b, n) => GL.util.logspace(a, b, n);
  const interp = (f, y, x) => {
    if (x <= f[0]) return y[0];
    for (let i = 1; i < f.length; i++) if (f[i] >= x) {
      const t = Math.log(x / f[i - 1]) / Math.log(f[i] / f[i - 1]);
      return y[i - 1] + t * (y[i] - y[i - 1]);
    }
    return y[y.length - 1];
  };

  // F3 and flatness, using the same reference as the main summary:
  // box types against the driver's own passband level, bandpass against its peak.
  function measure(res, type, o) {
    const { f, spl } = res, n = f.length;
    const bp = E.isBandpass(type);
    let ref, i0 = 0;
    if (bp) {
      for (let i = 1; i < n; i++) if (f[i] <= o.top * 1.5 && spl[i] > spl[i0]) i0 = i;
      ref = spl[i0];
    } else {
      ref = o.refLevel;
      while (i0 < n - 1 && f[i0] < o.fs * 3) i0++;
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
    const low = cross(i0, -1);
    const high = bp ? cross(i0, 1) : null;
    let peak = -Infinity;
    for (let i = 0; i < n; i++) if (f[i] >= (low || f[0]) && f[i] <= o.top) peak = Math.max(peak, spl[i]);
    // bandpass: how deep the passband sags below its peak (6th order can dip in the middle)
    // (a valley: the lower of the highest levels either side of a point, minus its level)
    let dip = 0;
    if (bp && low) {
      const hi = Math.min(high || o.top, o.top);
      const idx = [];
      for (let i = 0; i < n; i++) if (f[i] >= low && f[i] <= hi) idx.push(i);
      const left = [], right = [];
      let m = -Infinity;
      for (const i of idx) { m = Math.max(m, spl[i]); left.push(m); }
      m = -Infinity;
      for (let k = idx.length - 1; k >= 0; k--) { m = Math.max(m, spl[idx[k]]); right[k] = m; }
      idx.forEach((i, k) => { dip = Math.max(dip, Math.min(left[k], right[k]) - spl[i]); });
    }
    return { low, high, ref, ripple: bp ? dip : peak - ref };
  }

  // Build one candidate design and simulate it, sizing ports for air speed.
  function evaluate(type, vols, fbs, o) {
    const d = E.makeDesign(type, o.dc, o.count);
    d.wiring = o.wiring;
    if (o.iso) d.iso = o.iso;
    d.chambers.forEach((c, i) => { c.vol = vols[i]; });
    d.ports.forEach((pt, i) => { pt.fb = fbs[i]; pt.holdFb = true; });
    let prShort = false;
    if (d.prs.length && fbs.length) {
      // a passive radiator (o.pr: a real one from the catalogue), tuned with added mass
      const pr = d.prs[0];
      if (o.pr) Object.assign(pr, o.pr, { count: o.prCount || 1 });
      const m = E.addedForFb(pr, vols[0], fbs[0]);
      prShort = m < 0;
      pr.added = Math.max(0, m);
    }
    if (o.portShape === 'slot') {
      // slot against a wall, full span: the inside height of a 1.25 : 1 : 0.9 box
      const gross = vols.reduce((s, v) => s + v, 0) * 1.08;
      const hIn = Math.cbrt(gross / (1.25 * 0.9));
      for (const pt of d.ports) {
        const area = E.portArea(pt);
        Object.assign(pt, { shape: 'slot', alongWall: true, fullHeight: true, slotSet: true, h: hIn, w: area / hIn });
      }
    }
    const vol = (pt) => d.chambers.find(c => c.id === pt.from).vol;
    const tune = () => d.ports.forEach(pt => { pt.len = E.lenForFb(pt, vol(pt), pt.fb); });
    tune();
    const run = () => GL.sweep(E.buildModel(d, o.dc, () => GL.cx.C(o.per)), o.freqs, { volts: o.volts, drive: o.per, vmax: o.vmaxAir });
    let res = run();
    // ports too small for full power: open them up (same tuning) and re-run
    if (o.portLimit > 0 && d.ports.length) {
      let again = false;
      res.portVel.forEach((pv, i) => {
        const v = Math.max(...pv.full), pt = d.ports[i];
        if (v > o.portLimit) {
          const k = Math.sqrt(v / o.portLimit * 1.04);
          pt.d *= k; pt.w *= k * k; again = true;
        }
      });
      if (again) { tune(); res = run(); }
    }
    const m = measure(res, type, o);
    const net = vols.reduce((s, v) => s + v, 0);
    const gross = net + d.ports.reduce((s, pt) => s + E.portDisplacement(pt, 0.0127), 0);
    const why = [];
    if (m.low == null) why.push('no low-end roll-off found');
    if (prShort) why.push("the passive radiator can't tune that high");
    if (m.ripple > o.ripple) why.push((E.isBandpass(type) ? 'sags ' : 'peaks ') + m.ripple.toFixed(1) + ' dB');
    if (E.isBandpass(type) && m.high != null && m.high < o.top) why.push('upper roll-off below ' + o.top.toFixed(0) + ' Hz');
    for (let i = 0; i < d.ports.length; i++) {
      const pt = d.ports[i], v = Math.max(...res.portVel[i].full);
      if (o.portLimit > 0 && v > o.portLimit * 1.05) why.push('port air speed ' + v.toFixed(0) + ' m/s');
      // rough fit: with two bends a port can run about three box sides
      if (pt.len > 3 * Math.cbrt(gross) || pt.len <= 0) why.push('port ' + (pt.len > 0 ? 'too long' : 'too short') + ' for the box');
    }
    return {
      type, vols, fbs: d.prs.length ? [E.prFb(d.prs[0], vols[0])] : d.ports.map(pt => pt.fb), ports: d.ports.map(pt => ({ d: pt.d, w: pt.w, shape: pt.shape, len: pt.len, name: pt.name })),
      net, gross, f3: m.low, high: m.high, ripple: m.ripple, ref: m.ref, ok: why.length === 0, why,
      maxAt: interp(res.f, Array.from(res.maxSpl), o.target || 30),
      vFull: res.portVel.length ? Math.max(...res.portVel.map(pv => Math.max(...pv.full))) : 0,
      design: d, shape: d.ports.length ? d.ports[0].shape : null, res,
    };
  }

  // Volumes and tunings to try for one driver in a box of net volume V.
  // (logspace gives a typed array: Array.from so each tuning can be a list)
  function boxGrid(type, V, fs, top) {
    const tunes = (a, b, n) => Array.from(logspace(Math.max(12, a), Math.min(b, 250), n));
    if (type === 'sealed') return [{ vols: [V], fbs: [] }];
    if (type === 'ported' || type === 'pr') return tunes(0.45 * fs, 2.2 * fs, 10).map(f => ({ vols: [V], fbs: [f] }));
    const out = [];
    if (type === 'bp4') {
      // sealed rear, ported front
      for (const r of [0.35, 0.45, 0.55, 0.65, 0.75]) for (const f of tunes(0.7 * fs, Math.max(3 * fs, top * 0.8), 8)) out.push({ vols: [V * r, V * (1 - r)], fbs: [f] });
    } else if (type === 'bp6p') {
      // both chambers ported: the rear tuned low, the front higher
      for (const r of [0.5, 0.6, 0.7]) for (const a of tunes(0.5 * fs, 1.6 * fs, 5)) for (const b of tunes(fs, Math.max(4 * fs, top), 5)) {
        if (b > a * 1.3) out.push({ vols: [V * r, V * (1 - r)], fbs: [a, b] });
      }
    }
    return out;
  }

  // Box first: a fixed net volume (and alignment); try every driver in it and
  // rank them. Ported boxes get the best tuning for each driver from a small
  // sweep. o: { drivers: [{ name, params, vc, ... }], type: 'sealed'|'ported', vol (m³),
  //   goal: 'deep'|'loud'|'blend', ripple, top, band: [f0, f1], portLimit, portShape,
  //   prFor(entry, dc) -> { spec, name } (passive radiator to use, for type 'pr'),
  //   fits(entry) -> bool (optional), keep, onProgress, stop }
  async function forBox(o) {
    const rows = [];
    let tooBig = 0, failed = 0, noPr = 0;
    const freqs = logspace(8, Math.max(250, o.top * 2.5), 90);
    for (let i = 0; i < o.drivers.length; i++) {
      if (o.stop && o.stop()) break;
      const e = o.drivers[i];
      if (o.fits && !o.fits(e)) { tooBig++; continue; }
      try {
        const pub = e.vc ? (e.vc.published === 'parallel' ? 'parallel' : 'series') : null;
        const dc = GL.drivers.complete(e.vc ? GL.specparse.forWiring(e.params, e.vc, pub) : e.params);
        const per = 2.83;
        // o.count drivers share the box, wired in parallel (each gets the full voltage)
        const N = Math.max(1, o.count || 1);
        const base = { dc, count: N, wiring: 'parallel', per, volts: per, freqs, vmaxAir: 0, portLimit: o.portLimit || 25, portShape: o.portShape || 'round',
          ripple: o.ripple, top: o.top, fs: dc.params.fs, target: o.band[0], refLevel: dc.derived.spl1w + 20 * Math.log10(N * per / Math.sqrt(dc.model.Re)) };
        let best = null;
        const V = o.volFor ? o.volFor(e) : o.vol;
        // passive radiators: one, two, or each count that has a radiator that suits
        const setups = [];
        if (o.type === 'pr') {
          for (const n of o.prCounts || [1]) {
            const pr = o.prFor ? o.prFor(e, dc, n) : null;
            if (pr) setups.push({ pr, n });
          }
          if (!setups.length) { noPr++; continue; }
        } else setups.push(null);
        for (const su of setups) for (const g of boxGrid(o.type, V, dc.params.fs, o.top)) {
          const b2 = su ? Object.assign({}, base, { pr: su.pr.spec, prCount: su.n }) : base;
          const c = evaluate(o.type, g.vols, g.fbs, b2);
          if (su) { c.prName = su.pr.name; c.prCount = su.n; }
          if (!c.f3) continue;
          // what it plays across the band: limited by Xmax and power (thermal)
          let out = 0, k = 0;
          for (let j = 0; j < c.res.f.length; j++) if (c.res.f[j] >= o.band[0] && c.res.f[j] <= o.band[1]) { out += c.res.maxSpl[j]; k++; }
          c.out = k ? out / k : -Infinity;
          c.entry = e; c.dc = dc;
          c.score = o.goal === 'deep' ? -c.f3 : o.goal === 'loud' ? c.out : -6 * Math.log2(c.f3) + c.out;
          if (!best || (c.ok - best.ok) > 0 || (c.ok === best.ok && c.score > best.score)) best = c;
        }
        if (best) rows.push(best); else failed++;
      } catch (err) { failed++; }
      if (i % 20 === 19) { if (o.onProgress) o.onProgress(i + 1, o.drivers.length); await yieldNow(); }
    }
    rows.sort((a, b) => (b.ok - a.ok) || (b.score - a.score));
    // the best ones, checked for a real fit in the box (ports routed, faces, motor), until enough fit
    const out = [];
    let unfit = 0;
    for (const r of rows) {
      if (out.length >= (o.keep || 3)) break;
      if (o.fitCheck && !o.fitCheck(r)) { unfit++; if (unfit > 60) break; continue; }
      out.push(r);
    }
    for (const r of rows) if (!out.includes(r)) r.res = null;
    return { rows: out, tried: rows.length, tooBig, failed, noPr, unfit, total: o.drivers.length };
  }

  function score(c, o) {
    const f3 = c.f3 || 1e3;
    // misses rank by closeness, then by size
    if (o.goal === 'small') return c.f3 && f3 <= o.target ? c.net : 1e3 + Math.round(f3 * 10) / 10 / o.target + c.net * 1e-3;
    if (o.goal === 'deep') return c.net <= o.vmax ? f3 : 1e3 + c.net / o.vmax;
    return o.alpha * (c.net / o.vmax) + (1 - o.alpha) * (f3 / o.target) + (c.net > o.vmax ? 1e3 : 0);
  }

  function* candidates(type, o) {
    const vas = o.dc.params.vas * o.count, fs = o.dc.params.fs;
    const vHi = o.vmax > 0 ? o.vmax : Math.min(8 * vas, 0.45);
    const vLo = Math.max(0.08 * vas, 0.002);
    if (type === 'sealed') {
      for (const v of logspace(vLo, vHi, 40)) yield [[v], []];
    } else if (type === 'ported') {
      const fbs = logspace(Math.max(10, 0.45 * fs), Math.min(2 * fs, 80), 22);
      for (const v of logspace(vLo, vHi, 28)) for (const fb of fbs) yield [[v], [fb]];
    } else if (type === 'bp6p') {
      // rear and front chambers both vented out: two tunings
      const fbR = logspace(Math.max(12, 0.5 * fs), Math.min(1.6 * fs, 60), 7);
      const fbF = logspace(Math.max(30, fs), Math.min(4 * fs, 150), 7);
      for (const vr of logspace(vLo, vHi * 0.65, 9)) for (const vf of logspace(vLo, vHi * 0.5, 8)) {
        if (vr + vf > vHi) continue;
        for (const a of fbR) for (const b of fbF) if (b > a * 1.3) yield [[vr, vf], [a, b]];
      }
    } else if (type === 'bp6s') {
      // sealed rear, middle vents into a front chamber that vents out
      const fbIn = logspace(Math.max(15, 0.6 * fs), Math.min(2.5 * fs, 90), 6);
      const fbOut = logspace(Math.max(30, fs), Math.min(4 * fs, 150), 6);
      for (const vr of logspace(vLo, vHi * 0.5, 7)) for (const vf of logspace(vLo, vHi * 0.4, 6)) for (const vc of logspace(vLo, vHi * 0.4, 5)) {
        if (vr + vf + vc > vHi) continue;
        for (const a of fbIn) for (const b of fbOut) if (b > a * 1.2) yield [[vr, vf, vc], [a, b]];
      }
    } else if (type === 'manifold') {
      // same search as bp4, rear volume split over the two sides
      const fbs = logspace(Math.max(15, 0.7 * fs), Math.min(3 * fs, 120), 12);
      for (const vr of logspace(vLo, vHi * 0.6, 12)) for (const vf of logspace(vLo, vHi * 0.5, 12)) {
        if (vr + vf > vHi) continue;
        for (const fb of fbs) yield [[vr / 2, vf, vr / 2], [fb]];
      }
    } else if (type === 'bp4') {
      const fbs = logspace(Math.max(15, 0.7 * fs), Math.min(3 * fs, 120), 12);
      for (const vr of logspace(vLo, vHi * 0.6, 12)) for (const vf of logspace(vLo, vHi * 0.5, 12)) {
        if (vr + vf > vHi) continue;
        for (const fb of fbs) yield [[vr, vf], [fb]];
      }
    }
  }

  // Smallest scale of all chambers (same tunings) that still meets the goal.
  function refine(best, o) {
    if (o.goal !== 'small' || !best.ok || !best.f3 || best.f3 > o.target) return best;
    let lo = 0.5, hi = 1, keep = best;
    for (let i = 0; i < 10; i++) {
      const s = (lo + hi) / 2;
      const c = evaluate(best.type, best.vols.map(v => v * s), best.fbs, o);
      if (c.ok && c.f3 && c.f3 <= o.target && o.fitCheck && c.ports.length) Object.assign(c, o.fitCheck(c));
      // (fitCheck may clear ok when the buildable port size runs too fast)
      if (c.ok && c.f3 && c.f3 <= o.target && c.fit !== false) { hi = s; keep = c; } else lo = s;
    }
    return keep;
  }

  // Give the page a moment between slices. A message channel isn't throttled
  // when the tab is in the background, unlike setTimeout.
  const yieldNow = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

  // Runs in slices so the page stays responsive. onProgress(done, total).
  async function run(o) {
    o.freqs = logspace(8, Math.max(250, o.top * 2.5), 90);
    const all = [];
    // a manifold needs an even number of drivers (half on each side)
    const types = o.types.filter(t => t !== 'manifold' || (o.count >= 2 && o.count % 2 === 0));
    const lists = types.map(t => [t, [...candidates(t, o)]]);
    const total = lists.reduce((s, [, l]) => s + l.length, 0);
    let done = 0;
    for (const [type, list] of lists) {
      for (let i = 0; i < list.length; i++) {
        const c = evaluate(type, list[i][0], list[i][1], o);
        c.score = score(c, o);
        c.res = null;                       // (curves aren't needed for the ranking)
        all.push(c);
        if (++done % 60 === 0) {
          if (o.onProgress) o.onProgress(done, total);
          await yieldNow();
          if (o.cancelled && o.cancelled()) return null;
        }
      }
    }
    // best few per type, each checked for a real port fit (o.fitCheck), the
    // winner tightened up
    const out = [];
    for (const [type] of lists) {
      // ties (same box) go shortest port first: the likeliest to fit
      const plen = (c) => c.ports.reduce((s, p) => s + p.len, 0);
      const mine = all.filter(c => c.type === type).sort((a, b) => (b.ok - a.ok) || (a.score - b.score) || plen(a) - plen(b));
      const pick = [];
      const noRoom = new Set();             // boxes whose shortest port already failed
      const boxKey = (c) => c.vols.map(v => v.toPrecision(4)).join('/');
      let checks = 0, closest = null;
      for (const c of mine) {
        if (noRoom.has(boxKey(c))) continue;
        // skip near-duplicates of an already picked one
        if (pick.some(p => Math.abs(p.net / c.net - 1) < 0.08 && p.fbs.every((f, i) => Math.abs(f / c.fbs[i] - 1) < 0.06))) continue;
        if (o.fitCheck && c.ports.length) {
          if (checks++ > 120) break;
          const wasOk = c.ok;
          Object.assign(c, o.fitCheck(c));
          if (c.fit === false) noRoom.add(boxKey(c));
          if (c.fit === false || (wasOk && !c.ok)) { closest = closest || c; continue; }
        }
        pick.push(c);
        if (pick.length >= 3) break;
      }
      if (!pick.length && closest) pick.push(closest);
      if (pick[0] && pick[0].fit !== false) {
        pick[0] = refine(pick[0], o);
        pick[0].score = score(pick[0], o);
      }
      out.push(...pick);
    }
    out.sort((a, b) => (b.ok - a.ok) || a.score - b.score);
    if (o.onProgress) o.onProgress(total, total);
    return out;
  }

  GL.optimize = { TYPES, run, evaluate, measure, forBox, boxGrid };
})(window.GL);
