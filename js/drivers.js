/* GetLow – driver files: import (WinISD .wdr, Hornresp, JSON), parameter
 * completion and the local driver library. All parameters are stored in SI. */
(function (GL) {
  'use strict';
  const { phys } = GL;

  // Editable small-signal parameters and how they are shown.
  // f = SI value per display unit.
  const FIELDS = [
    { k: 'fs',   label: 'Fs',   u: 'Hz',   f: 1,      d: 2, tip: 'Free-air resonance' },
    { k: 'qes',  label: 'Qes',  u: '',     f: 1,      d: 3, tip: 'Electrical Q' },
    { k: 'qms',  label: 'Qms',  u: '',     f: 1,      d: 3, tip: 'Mechanical Q' },
    { k: 'vas',  label: 'Vas',  u: 'L',    f: 0.001,  d: 2, tip: 'Equivalent compliance volume' },
    { k: 'sd',   label: 'Sd',   u: 'cm²',  f: 1e-4,   d: 1, tip: 'Effective cone area' },
    { k: 're',   label: 'Re',   u: 'Ω',    f: 1,      d: 2, tip: 'Voice coil DC resistance' },
    { k: 'le',   label: 'Le',   u: 'mH',   f: 0.001,  d: 3, tip: 'Voice coil inductance' },
    { k: 'l2',   label: 'L2',   u: 'mH',   f: 0.001,  d: 3, tip: 'Second inductance of the L2R2 voice-coil model (full-range and mid drivers often list it). Leave empty if not given.' },
    { k: 'r2',   label: 'R2',   u: 'Ω',    f: 1,      d: 2, tip: 'Resistance across L2 in the L2R2 model' },
    { k: 'xmax', label: 'Xmax', u: 'mm',   f: 0.001,  d: 1, tip: 'Linear excursion, one way' },
    { k: 'pe',   label: 'Pe',   u: 'W',    f: 1,      d: 0, tip: 'Thermal power rating (RMS)' },
    { k: 'znom', label: 'Znom', u: 'Ω',    f: 1,      d: 1, tip: 'Nominal impedance' },
    { k: 'dvol', label: 'Displacement', u: 'L', f: 0.001, d: 2, tip: 'Volume the driver takes up inside the box' },
  ];
  // Derived (read-only) values shown below the editable ones.
  const DERIVED = [
    { k: 'qts', label: 'Qts', u: '', f: 1, d: 3 },
    { k: 'BL',  label: 'BL',  u: 'T·m', f: 1, d: 2 },
    { k: 'Mms', label: 'Mms', u: 'g', f: 0.001, d: 1 },
    { k: 'Cms', label: 'Cms', u: 'mm/N', f: 0.001, d: 3 },
    { k: 'Rms', label: 'Rms', u: 'kg/s', f: 1, d: 2 },
    { k: 'vd',  label: 'Vd',  u: 'cm³', f: 1e-6, d: 0 },
    { k: 'ebp', label: 'EBP', u: '', f: 1, d: 0 },
    { k: 'spl1w', label: 'Sens. 1W/1m', u: 'dB', f: 1, d: 1 },
  ];

  const num = (v) => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : NaN; };
  const ok = (v) => isFinite(v) && v > 0;

  // ---- WinISD .wdr ------------------------------------------------------
  // INI style, [Driver] section, SI units (Vas m³, Sd m², Xmax m, Le H, Mms kg ...)
  function parseWdr(text) {
    const kv = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z][\w]*)\s*=\s*(.*?)\s*$/);
      if (m) kv[m[1]] = m[2];
    }
    if (!('Fs' in kv) && !('BL' in kv)) throw new Error('No Thiele/Small parameters found');
    const g = (k) => num(kv[k]);
    return {
      brand: kv.Brand || kv.Manufacturer || '',
      model: kv.Model || 'Unnamed',
      comment: kv.Comment || '',
      source: 'WinISD .wdr',
      params: {
        fs: g('Fs'), qts: g('Qts'), qes: g('Qes'), qms: g('Qms'), vas: g('Vas'), sd: g('Sd'),
        re: g('Re'), le: g('Le'), xmax: g('Xmax'), pe: g('Pe'), znom: g('Znom'),
        BL: g('BL'), Mms: g('Mms'), Cms: g('Cms'), Rms: g('Rms'),
        dvol: ok(g('DVol')) ? g('DVol') : 0,
        dia: ok(g('Dia')) ? g('Dia') : (ok(g('Outer')) ? g('Outer') : NaN),
      },
      extra: kv,
    };
  }

  // ---- Hornresp record / driver text (best effort) ----------------------
  // Lines like "Sd = 506.71", "Bl = 14.21", "Cms = 2.05E-04", "Rms = 2.21",
  // "Mmd = 63.49" (g), "Le = 0.65" (mH), "Re = 5.70".
  function parseHornresp(text) {
    const kv = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z]+)\s*=\s*([-+0-9.eE]+)/);
      if (m) kv[m[1].toLowerCase()] = num(m[2]);
    }
    if (!ok(kv.bl) || !ok(kv.cms) || !ok(kv.sd)) throw new Error('Not a Hornresp record (needs Sd, Bl, Cms)');
    const nd = ok(kv.nd) ? kv.nd : 1;
    return {
      brand: '', model: 'Hornresp driver', comment: nd > 1 ? 'Record had Nd=' + nd + ' drivers' : '',
      source: 'Hornresp',
      params: {
        sd: kv.sd * 1e-4, BL: kv.bl, Cms: kv.cms, Rms: kv.rms,
        Mms: ok(kv.mmd) ? kv.mmd / 1000 : NaN,   // Mmd excludes air load; close enough
        le: ok(kv.le) ? kv.le / 1000 : 0, re: kv.re, dvol: 0,
      },
    };
  }

  function parseJson(text) {
    const o = JSON.parse(text);
    const d = o.driver || o;
    if (!d.params) throw new Error('JSON has no "params"');
    return { brand: d.brand || '', model: d.model || 'Unnamed', comment: d.comment || '', source: 'GetLow JSON', params: d.params };
  }

  function parseDriverFile(name, text) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    let d;
    if (ext === 'json') d = parseJson(text);
    else if (ext === 'wdr' || /\[Driver\]/i.test(text)) d = parseWdr(text);
    else {
      try { d = parseWdr(text); } catch (e) { d = parseHornresp(text); }
    }
    d.id = GL.util.uid('drv');
    if (!d.model || d.model === 'Unnamed' || d.model === 'Hornresp driver') d.model = name.replace(/\.[^.]+$/, '');
    return d;
  }

  // ---- completion -------------------------------------------------------
  // Produces the model the simulator uses (Re, Le, BL, Mms, Cms, Rms, Sd ...)
  // plus derived T/S values. The T/S set (Fs, Qes, Qms, Vas, Sd, Re) is the
  // primary source because that is what spec sheets give; the mechanical set
  // is used when T/S is incomplete (e.g. Hornresp files).
  function complete(params) {
    const p = Object.assign({}, params);
    const rc2 = phys.rc2();
    if (!ok(p.qes) && ok(p.qts) && ok(p.qms)) p.qes = 1 / (1 / p.qts - 1 / p.qms);
    if (!ok(p.qms) && ok(p.qts) && ok(p.qes)) p.qms = 1 / (1 / p.qts - 1 / p.qes);
    const ts = ok(p.fs) && ok(p.qes) && ok(p.qms) && ok(p.vas) && ok(p.sd) && ok(p.re);
    const mech = ok(p.BL) && ok(p.Mms) && ok(p.Cms) && ok(p.Rms) && ok(p.sd) && ok(p.re);
    const m = { Re: p.re, Le: ok(p.le) ? p.le : 0, Sd: p.sd };
    if (ok(p.l2) && ok(p.r2)) { m.L2 = p.l2; m.R2 = p.r2; }     // L2R2 voice coil: Le + (L2 ∥ R2)
    if (ts) {
      const ws = 2 * Math.PI * p.fs;
      m.Cms = p.vas / (rc2 * p.sd * p.sd);
      m.Mms = 1 / (ws * ws * m.Cms);
      m.Rms = ws * m.Mms / p.qms;
      m.BL = Math.sqrt(ws * m.Mms * p.re / p.qes);
    } else if (mech) {
      Object.assign(m, { Cms: p.Cms, Mms: p.Mms, Rms: p.Rms, BL: p.BL });
      const ws = 1 / Math.sqrt(m.Mms * m.Cms);
      p.fs = ws / (2 * Math.PI);
      p.qms = ws * m.Mms / m.Rms;
      p.qes = ws * m.Mms * p.re / (m.BL * m.BL);
      p.vas = m.Cms * rc2 * p.sd * p.sd;
    } else {
      throw new Error('Need Fs, Qes (or Qts), Qms, Vas, Sd and Re');
    }
    p.qts = p.qes * p.qms / (p.qes + p.qms);
    m.Xmax = ok(p.xmax) ? p.xmax : 0;
    m.Pe = ok(p.pe) ? p.pe : 100;
    m.znom = ok(p.znom) ? p.znom : Math.round(p.re * 1.15);
    const eta0 = 4 * Math.PI * Math.PI * Math.pow(p.fs, 3) * p.vas / (Math.pow(phys.c, 3) * p.qes);
    const derived = {
      qts: p.qts, BL: m.BL, Mms: m.Mms, Cms: m.Cms, Rms: m.Rms,
      vd: p.sd * m.Xmax, ebp: p.fs / p.qes, eta0, spl1w: 112.1 + 10 * Math.log10(eta0),
    };
    return { params: p, model: m, derived };
  }

  function toWdr(d) {
    const { params: p, model: m } = complete(d.params);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const lines = ['[Driver]',
      'Brand=' + (d.brand || ''), 'Model=' + d.model, 'Manufacturer=' + (d.brand || ''),
      'ProvidedBy=GetLow export', 'Comment=' + (d.comment || ''),
      'DateAdded=' + today, 'DateModified=' + today,
      'Qts=' + p.qts, 'Znom=' + m.znom, 'Fs=' + p.fs, 'Pe=' + m.Pe, 'Re=' + p.re, 'Le=' + m.Le,
      'BL=' + m.BL, 'Xmax=' + m.Xmax, 'Cms=' + m.Cms, 'Qms=' + p.qms, 'Qes=' + p.qes,
      'Rms=' + m.Rms, 'Mms=' + m.Mms, 'Sd=' + p.sd, 'Vas=' + p.vas, 'Vd=' + p.sd * m.Xmax,
      'numVC=1', 'DVol=' + (p.dvol || 0)];
    return lines.join('\r\n') + '\r\n';
  }

  // ---- library (browser localStorage) -----------------------------------
  const KEY = 'getlow.drivers.v1';
  const library = {
    list: [],
    load() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
      this.list = Array.isArray(saved) && saved.length ? saved : [];
      // make sure the bundled samples are always present
      for (const s of GL.samples || []) {
        if (!this.list.some(d => d.id === s.id)) {
          const d = parseDriverFile(s.file, s.text);
          d.id = s.id;
          d.sample = true;
          this.list.push(d);
        }
      }
      this.save();
    },
    save() { try { localStorage.setItem(KEY, JSON.stringify(this.list)); } catch (e) { /* storage blocked */ } },
    get(id) { return this.list.find(d => d.id === id); },
    add(d) { this.list.push(d); this.save(); return d; },
    remove(id) { this.list = this.list.filter(d => d.id !== id); this.save(); },
    name(d) { return ((d.brand ? d.brand + ' ' : '') + d.model).trim(); },
  };

  // Isobaric pair (two identical drivers working as one): same Fs and Qts,
  // half the Vas, twice the moving mass and power handling. The pair's
  // electrical side depends on how its two drivers are wired.
  function isobaric(p, wiring) {
    const series = wiring === 'series', k = series ? 2 : 0.5;
    const q = Object.assign({}, p, {
      vas: p.vas / 2, re: p.re * k, le: (p.le || 0) * k, pe: p.pe * 2, znom: (p.znom || p.re) * k,
    });
    if (p.BL > 0) q.BL = p.BL * (series ? 2 : 1);
    if (p.Mms > 0) q.Mms = p.Mms * 2;
    if (p.Cms > 0) q.Cms = p.Cms / 2;
    if (p.Rms > 0) q.Rms = p.Rms * 2;
    return q;
  }

  GL.drivers = { isobaric, FIELDS, DERIVED, parseWdr, parseHornresp, parseDriverFile, complete, toWdr, library };
})(window.GL);
