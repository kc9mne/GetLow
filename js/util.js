/* GetLow – shared helpers: units, formatting, DOM building. */
window.GL = window.GL || {};
(function (GL) {
  'use strict';

  const IN = 0.0254;
  const FT3 = 0.028316846592;

  // Every value is stored in SI. A "kind" says how to show it in each unit system.
  const KINDS = {
    len:   { imperial: { u: 'in', f: IN, d: 2 },        metric: { u: 'cm', f: 0.01, d: 1 } },
    room:  { imperial: { u: 'ft', f: 12 * IN, d: 1 },   metric: { u: 'm', f: 1, d: 2 } },
    thick: { imperial: { u: 'in', f: IN, d: 3 },        metric: { u: 'mm', f: 0.001, d: 1 } },
    vol:   { imperial: { u: 'ft³', f: FT3, d: 3 },      metric: { u: 'L', f: 0.001, d: 2 } },
    dvol:  { imperial: { u: 'in³', f: IN * IN * IN, d: 1 }, metric: { u: 'L', f: 0.001, d: 3 } },
    area:  { imperial: { u: 'in²', f: IN * IN, d: 2 },  metric: { u: 'cm²', f: 1e-4, d: 1 } },
    mass:  { imperial: { u: 'g', f: 0.001, d: 1 },      metric: { u: 'g', f: 0.001, d: 1 } },
    freq:  { imperial: { u: 'Hz', f: 1, d: 1 },         metric: { u: 'Hz', f: 1, d: 1 } },
    mm:    { imperial: { u: 'mm', f: 0.001, d: 1 },     metric: { u: 'mm', f: 0.001, d: 1 } },
    volt:  { imperial: { u: 'V', f: 1, d: 2 },          metric: { u: 'V', f: 1, d: 2 } },
    watt:  { imperial: { u: 'W', f: 1, d: 0 },          metric: { u: 'W', f: 1, d: 0 } },
    pct:   { imperial: { u: '%', f: 0.01, d: 0 },       metric: { u: '%', f: 0.01, d: 0 } },
    db:    { imperial: { u: 'dB', f: 1, d: 1 },         metric: { u: 'dB', f: 1, d: 1 } },
    num:   { imperial: { u: '', f: 1, d: 2 },           metric: { u: '', f: 1, d: 2 } },
  };

  const units = {
    system: 'imperial',
    IN, FT3,
    spec(kind) { return KINDS[kind][units.system]; },
    label(kind) { return units.spec(kind).u; },
    toDisplay(kind, si) { return si / units.spec(kind).f; },
    fromDisplay(kind, v) { return v * units.spec(kind).f; },
    fmt(kind, si, digits) {
      const s = units.spec(kind);
      const d = digits == null ? s.d : digits;
      return fmtNum(si / s.f, d) + (s.u ? ' ' + s.u : '');
    },
    // Volume in both systems, e.g. "0.770 ft³ (21.81 L)"
    volBoth(si) {
      return (si / FT3).toFixed(3) + ' ft³ · ' + (si * 1000).toFixed(2) + ' L';
    },
  };

  function fmtNum(v, d) {
    if (!isFinite(v)) return '–';
    return Number(v).toFixed(d);
  }

  // Nearest 1/16" fraction for cut lists: 11.375 -> 11 3/8"
  function inchFraction(m) {
    const inches = m / IN;
    let sixteenths = Math.round(inches * 16);
    const whole = Math.floor(sixteenths / 16);
    let rem = sixteenths - whole * 16;
    if (rem === 0) return whole + '"';
    let den = 16;
    while (rem % 2 === 0) { rem /= 2; den /= 2; }
    return (whole ? whole + ' ' : '') + rem + '/' + den + '"';
  }

  // h('div', {class: 'x', onclick: fn}, child, [children], 'text')
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'html') el.innerHTML = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }

  function uid(prefix) { return (prefix || 'id') + Math.random().toString(36).slice(2, 9); }

  function downloadText(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function readFileText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsText(file);
    });
  }

  function logspace(f0, f1, n) {
    const out = new Float64Array(n);
    const a = Math.log(f0), b = Math.log(f1);
    for (let i = 0; i < n; i++) out[i] = Math.exp(a + (b - a) * i / (n - 1));
    return out;
  }

  GL.units = units;
  GL.util = { h, fmtNum, inchFraction, uid, downloadText, readFileText, logspace };
})(window.GL);
