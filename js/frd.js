/* GetLow – measurement files: .frd (frequency, dB, phase) and .zma (frequency,
   ohms, phase), as exported by REW, ARTA, Room EQ Wizard, Dayton DATS, LIMP,
   VituixCAD and makers' sites. Plain text, one point per line, separated by
   spaces, tabs, commas or semicolons; comment and header lines are skipped. */
(function (GL) {
  'use strict';

  // rows of numbers from the text: [[f, value, phase?], ...], sorted by frequency
  function rows(text) {
    const out = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^[*;#"'!/a-z]/i.test(line)) continue;
      // decimal commas: "20,5;87,3" (only when semicolons or tabs separate the columns)
      const fixed = /[;\t]/.test(line) && /\d,\d/.test(line) ? line.replace(/(\d),(\d)/g, '$1.$2') : line;
      const nums = fixed.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (nums.length < 2 || !nums.slice(0, 2).every(isFinite) || !(nums[0] > 0)) continue;
      out.push([nums[0], nums[1], nums.length > 2 && isFinite(nums[2]) ? nums[2] : null]);
    }
    out.sort((a, b) => a[0] - b[0]);
    // drop repeated frequencies
    return out.filter((r, i) => i === 0 || r[0] > out[i - 1][0]);
  }

  // Response or impedance: the extension when it says, else the values
  // (impedance sits at a few to a few tens of ohms; SPL at 60–120 dB).
  function guessKind(name, ys) {
    const n = String(name || '').toLowerCase();
    if (/\.zma$|imped|\bzma\b|\bimp\b/.test(n)) return 'zma';
    if (/\.frd$|\bspl\b|response/.test(n)) return 'frd';
    const s = ys.slice().sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
    return s[0] > 0 && med < 45 ? 'zma' : 'frd';
  }

  // At most n points, evenly spread on a log scale (averaging in each step), so
  // a 64k-point REW export doesn't fill the project.
  function thin(r, n = 480) {
    if (r.length <= n) return r;
    const lf0 = Math.log(r[0][0]), lf1 = Math.log(r[r.length - 1][0]);
    const out = [];
    let i = 0;
    for (let k = 0; k < n; k++) {
      const hi = Math.exp(lf0 + (lf1 - lf0) * (k + 1) / n);
      const bin = [];
      while (i < r.length && (r[i][0] <= hi || k === n - 1)) bin.push(r[i++]);
      if (!bin.length) continue;
      const f = Math.exp(bin.reduce((s, x) => s + Math.log(x[0]), 0) / bin.length);
      const y = bin.reduce((s, x) => s + x[1], 0) / bin.length;
      const mid = bin[Math.floor(bin.length / 2)];
      out.push([f, y, mid[2]]);
    }
    return out;
  }

  // name, text -> { kind: 'frd'|'zma', f: [], y: [], ph: [] | null }
  function parse(name, text) {
    const r0 = rows(text);
    if (r0.length < 5) throw new Error('no frequency data found (need lines of frequency and value)');
    const r = thin(r0);
    const ys = r.map(x => x[1]);
    const hasPh = r.some(x => x[2] != null);
    return { kind: guessKind(name, ys), f: r.map(x => +x[0].toPrecision(6)), y: ys.map(v => +v.toPrecision(5)),
      ph: hasPh ? r.map(x => x[2] == null ? null : +x[2].toPrecision(4)) : null, points: r0.length };
  }

  // Could this text be a measurement (rather than a driver file)?
  const looksLike = (text) => { try { return rows(text).length >= 20; } catch (e) { return false; } };

  // the dB offset that lines a measured response up with a simulated one over [f0, f1]
  function matchOffset(meas, simF, simY, f0, f1) {
    let sum = 0, n = 0;
    for (let i = 0; i < meas.f.length; i++) {
      const f = meas.f[i];
      if (f < f0 || f > f1 || f < simF[0] || f > simF[simF.length - 1]) continue;
      const v = GL.interp(simF, simY, f);
      if (!isFinite(v)) continue;
      sum += v - meas.y[i]; n++;
    }
    return n ? sum / n : 0;
  }

  GL.frd = { parse, rows, thin, guessKind, looksLike, matchOffset };
})(window.GL);
