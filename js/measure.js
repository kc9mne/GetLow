/* GetLow – work out a driver's T/S parameters from your own measurements.
 *
 * Free-air impedance (the classic three-point method):
 *   r0 = Zmax / Re;  f1, f2 = where |Z| = √(Re·Zmax), either side of Fs
 *   Qms = Fs·√r0 / (f2 − f1);  Qes = Qms / (r0 − 1);  Qts = Qms / r0
 * Then either
 *   added mass:  Mms = m / ((Fs / Fs′)² − 1)       (Fs′ = resonance with mass m stuck on the cone)
 *                Cms = 1 / ((2π Fs)² Mms);  Vas = ρc² Sd² Cms
 *   test box:    Vas = Vb · (Fc·Qec / (Fs·Qes) − 1)   (Fc, Qec from the same impedance test in a sealed box Vb)
 *                Cms = Vas / (ρc² Sd²);  Mms = 1 / ((2π Fs)² Cms)
 *   BL = √(2π Fs · Mms · Re / Qes)
 * All values SI.
 */
(function (GL) {
  'use strict';
  const rc2 = () => GL.phys.rc2();

  // Q values from a free-air (or in-box) impedance sweep.
  function qFromImpedance({ re, f0, zmax, f1, f2 }) {
    const r0 = zmax / re;
    const qm = f0 * Math.sqrt(r0) / (f2 - f1);
    const qe = qm / (r0 - 1);
    return { r0, qms: qm, qes: qe, qts: qm / r0, zTarget: Math.sqrt(re * zmax), fGeo: Math.sqrt(f1 * f2) };
  }

  // Impedance from the constant-current method: series resistor R, voltage Vs
  // across resistor + driver, Vd across the driver alone.
  const zFromVoltages = (R, vs, vd) => R * vd / (vs - vd);

  // Everything from the measurements. m = { re, fs, zmax, f1, f2, sd, method,
  //   added: { mass, fs2 }  or  box: { vb, fc, zmax, f1, f2 } }
  function solve(m) {
    const notes = [];
    const fa = qFromImpedance({ re: m.re, f0: m.fs, zmax: m.zmax, f1: m.f1, f2: m.f2 });
    if (!(m.zmax > m.re * 1.5)) notes.push(['warn', 'Zmax should be several times Re. Check the readings.']);
    if (!(m.f1 < m.fs && m.fs < m.f2)) notes.push(['warn', 'f1 must be below Fs and f2 above it.']);
    else if (Math.abs(fa.fGeo / m.fs - 1) > 0.05) notes.push(['info', `√(f1·f2) is ${fa.fGeo.toFixed(1)} Hz, more than 5% from Fs. The sweep may be too coarse, or Le is skewing the peak.`]);
    const w = 2 * Math.PI * m.fs;
    let mms, cms, vas;
    if (m.method === 'box') {
      const b = m.box;
      const inBox = qFromImpedance({ re: m.re, f0: b.fc, zmax: b.zmax, f1: b.f1, f2: b.f2 });
      vas = b.vb * (b.fc * inBox.qes / (m.fs * fa.qes) - 1);
      cms = vas / (rc2() * m.sd * m.sd);
      mms = 1 / (w * w * cms);
      if (!(b.fc > m.fs * 1.25)) notes.push(['warn', 'The box should raise the resonance by at least 25%; use a smaller test box for a clearer result.']);
      return finish({ fs: m.fs, re: m.re, sd: m.sd, ...fa, mms, cms, vas, qec: inBox.qes, fc: b.fc }, notes);
    }
    const a = m.added;
    const k = (m.fs / a.fs2) ** 2 - 1;
    mms = a.mass / k;
    cms = 1 / (w * w * mms);
    vas = rc2() * m.sd * m.sd * cms;
    if (!(a.fs2 < m.fs)) notes.push(['warn', 'With mass added the resonance must go down.']);
    else if (a.fs2 > m.fs * 0.85) notes.push(['info', 'The added mass only lowered Fs by ' + ((1 - a.fs2 / m.fs) * 100).toFixed(0) + '%. More mass (about the cone\'s own mass) gives a more accurate Mms.']);
    return finish({ fs: m.fs, re: m.re, sd: m.sd, ...fa, mms, cms, vas }, notes);
  }

  function finish(r, notes) {
    r.BL = Math.sqrt(2 * Math.PI * r.fs * r.mms * r.re / r.qes);
    r.notes = notes;
    r.ok = [r.qms, r.qes, r.mms, r.cms, r.vas, r.BL].every(v => isFinite(v) && v > 0);
    if (!r.ok) notes.unshift(['warn', 'Those readings don\'t give a usable result. Check each value and its unit.']);
    return r;
  }

  // Effective cone area from the effective diameter (cone plus about a third to half of the surround).
  const sdFromDiameter = (d) => Math.PI * d * d / 4;

  GL.measure = { qFromImpedance, zFromVoltages, solve, sdFromDiameter };
})(window.GL);
