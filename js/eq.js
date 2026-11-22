/* GetLow – EQ: Linkwitz transform and parametric bands (peak, low shelf, high
   shelf), as analog transfer functions H(jω). They go into the signal chain
   with the high- and low-pass filters, so response, excursion, port speed and
   max SPL all follow the boost. Shapes are the usual analog prototypes
   (R. Bristow-Johnson's cookbook, before its bilinear transform). */
(function (GL) {
  'use strict';
  const X = GL.cx;
  const TAU = 2 * Math.PI;

  // second-order polynomial a·s² + b·s + c at s = jω
  const quad = (w, a, b, c) => X.C(c - a * w * w, b * w);

  // Linkwitz transform: moves a sealed box's (f0, Q0) to (fp, Qp); unity at high frequency.
  function linkwitz(w, lt) {
    const w0 = TAU * lt.f0, wp = TAU * lt.fp;
    const num = quad(w, 1, w0 / lt.q0, w0 * w0), den = quad(w, 1, wp / lt.qp, wp * wp);
    return X.cdiv(num, den);
  }

  // One parametric band. gain in dB; q > 0. Peak: gain at f, unity far away.
  // Shelves: the full gain below (low) or above (high) f, unity on the other side.
  function band(w, b) {
    const w0 = TAU * b.f, A = Math.pow(10, b.gain / 40), q = Math.max(0.05, b.q || 0.707), sA = Math.sqrt(A);
    if (b.type === 'lowshelf') {
      return X.cscale(X.cdiv(quad(w, 1, sA / q * w0, A * w0 * w0), quad(w, A, sA / q * w0, w0 * w0)), A);
    }
    if (b.type === 'highshelf') {
      return X.cscale(X.cdiv(quad(w, A, sA / q * w0, w0 * w0), quad(w, 1, sA / q * w0, A * w0 * w0)), A);
    }
    return X.cdiv(quad(w, 1, A / q * w0, w0 * w0), quad(w, 1, w0 / (A * q), w0 * w0));
  }

  // the whole EQ (null-safe): eq = { lt: {on, f0, q0, fp, qp}, bands: [{on, type, f, gain, q}] }
  function response(w, eq) {
    let H = X.C(1);
    if (!eq) return H;
    if (eq.lt && eq.lt.on && eq.lt.f0 > 0 && eq.lt.fp > 0 && eq.lt.q0 > 0 && eq.lt.qp > 0) H = X.cmul(H, linkwitz(w, eq.lt));
    for (const b of eq.bands || []) if (b.on && b.f > 0 && b.gain) H = X.cmul(H, band(w, b));
    return H;
  }
  const active = (eq) => !!eq && ((eq.lt && eq.lt.on) || (eq.bands || []).some(b => b.on && b.gain));

  // largest boost over a band (dB) and where
  function maxBoost(eq, f0, f1) {
    let best = { db: -Infinity, f: f0 };
    for (let i = 0; i <= 200; i++) {
      const f = f0 * Math.pow(f1 / f0, i / 200);
      const db = 20 * Math.log10(X.cabs(response(TAU * f, eq)));
      if (db > best.db) best = { db, f };
    }
    return best;
  }

  const defaults = () => ({ lt: { on: false, f0: 40, q0: 0.9, fp: 20, qp: 0.707 }, bands: [] });

  GL.eq = { linkwitz, band, response, active, maxBoost, defaults };
})(window.GL);
