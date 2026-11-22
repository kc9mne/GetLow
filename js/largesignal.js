/* GetLow – beyond the small-signal model.
   Power compression: the voice coil heats with the long-term power and its
   resistance rises (copper +0.393 %/°C), which lowers the level and raises the
   driver's Q. Large signal: BL falls and the suspension stiffens as the cone
   moves further, solved at each frequency until the excursion settles. */
(function (GL) {
  'use strict';
  const ALPHA = { cu: 0.00393, al: 0.00403 };     // per °C
  // how much of the amp's power the coil heats with over time
  const DUTY = { sine: 1, noise: 0.5, music: 0.125 };

  // Hot voice coil at vPer (rms volts per driver) for a long-term duty.
  // rise: the coil's temperature rise at its rated power (°C).
  function hotCoil(o) {
    const a = ALPHA[o.coil] || ALPHA.cu, rth = (o.rise || 180) / Math.max(1, o.pe), duty = DUTY[o.duty] ?? 0.125;
    let re = o.re, P = 0;
    for (let k = 0; k < 40; k++) {
      P = duty * o.vPer * o.vPer / re;                  // into the coil (worst case: impedance near Re)
      const next = o.re * (1 + a * rth * P);
      if (Math.abs(next - re) < 1e-9) { re = next; break; }
      re = 0.5 * (re + next);
    }
    const dT = (re / o.re - 1) / a;
    return { re, dT, P, db: -20 * Math.log10(re / o.re) };
  }

  // BL and stiffness averaged over a sine of peak X (both quadratic in x):
  // BL(x) = BL0·(1 − (1 − b)·(x/Xmax)²), K(x) = K0·(1 + (k − 1)·(x/Xmax)²); mean of x² is X²/2.
  function effective(X, xmax, b, k) {
    if (!(xmax > 0)) return { bl: 1, kms: 1 };
    const r2 = (X / xmax) * (X / xmax) / 2;
    return { bl: Math.max(0.25, 1 - (1 - b) * r2), kms: 1 + (k - 1) * r2 };
  }

  // Large-signal response: for each frequency, re-solve with BL and Cms at the
  // excursion they produce. build(blFactor, kmsFactor) -> model; one(model, f) -> { spl, xpk (mm), phase }.
  function solve(freqs, X0, xmax, b, k, build, one) {
    const spl = [], xpk = [];
    freqs.forEach((f, i) => {
      let X = X0[i] / 1000, r = null;
      for (let it = 0; it < 8; it++) {
        const e = effective(X, xmax, b, k);
        r = one(build(e.bl, e.kms), f);
        const Xn = r.xpk / 1000;
        if (Math.abs(Xn - X) < 1e-6) { X = Xn; break; }
        X = 0.5 * (X + Xn);
      }
      spl.push(r.spl); xpk.push(r.xpk);
    });
    return { f: Array.from(freqs), spl, xpk };
  }

  GL.largesignal = { hotCoil, effective, solve, ALPHA, DUTY };
})(window.GL);
