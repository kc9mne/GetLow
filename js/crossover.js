/* GetLow – passive crossovers. Ladder networks (series and shunt parts, amp to
   driver) designed from the textbook all-pole alignments for a resistive load,
   then simulated exactly against each driver's own complex impedance, with an
   L-pad and a Zobel (impedance compensation) where wanted.

   A network is a list of parts from the amplifier toward the driver:
     { at: 'series' | 'shunt', type: 'L' | 'C' | 'R' | 'RC', value, c? }
   (RC = a resistor and capacitor in series, used for the Zobel). */
(function (GL) {
  'use strict';
  const X = GL.cx, TAU = 2 * Math.PI;

  // Normalised ladder values (load 1 Ω, 1 rad/s), first part next to the amplifier.
  // Low-pass: series L, shunt C, series L, ...; the high-pass is the dual
  // (series C = 1/g, shunt L = 1/g in the same order).
  const PROTO = {
    bw1: [1],
    lr2: [2, 0.5],                 // Q = 0.5
    bw2: [Math.SQRT2, 1 / Math.SQRT2],   // Q = 0.707
    bw3: [1.5, 4 / 3, 0.5],
    // LR4 = (s² + √2·s + 1)²: matching the ladder's polynomial term by term gives
    // C4 = 1/(2√2), L1·C2 = 3, L1 + L3 = 2√2, L1·C2·L3 = 2√2
    lr4: [2 * Math.SQRT2 - 2 * Math.SQRT2 / 3, 3 / (2 * Math.SQRT2 - 2 * Math.SQRT2 / 3), 2 * Math.SQRT2 / 3, 1 / (2 * Math.SQRT2)],
  };
  const ALIGN = [['bw1', '1st order (6 dB/oct)'], ['lr2', '2nd order Linkwitz-Riley (12 dB/oct)'], ['bw2', '2nd order Butterworth (12 dB/oct)'],
    ['bw3', '3rd order Butterworth (18 dB/oct)'], ['lr4', '4th order Linkwitz-Riley (24 dB/oct)']];
  // the ideal (all-pole) shapes the ladders are meant to give into a resistor
  const TARGET = { bw1: [1], lr2: [0.5, 0.5], bw2: [Math.SQRT1_2], bw3: [1, 1], lr4: [Math.SQRT1_2, Math.SQRT1_2] };

  // parts for a low- or high-pass of alignment al at f into R ohms
  function section(al, f, R, high) {
    const g = PROTO[al], w = TAU * f;
    return g.map((gi, i) => {
      const series = i % 2 === 0;
      if (!high) return series ? { at: 'series', type: 'L', value: gi * R / w } : { at: 'shunt', type: 'C', value: gi / (R * w) };
      return series ? { at: 'series', type: 'C', value: 1 / (gi * R * w) } : { at: 'shunt', type: 'L', value: R / (gi * w) };
    });
  }
  // L-pad: cut by db while the driver still sees about R
  function lpad(db, R) {
    if (!(db > 0.05)) return [];
    const a = Math.pow(10, -db / 20);
    return [{ at: 'series', type: 'R', value: R * (1 - a), role: 'L-pad' }, { at: 'shunt', type: 'R', value: R * a / (1 - a), role: 'L-pad' }];
  }
  // Zobel: flattens the rising impedance of the voice coil's inductance
  function zobel(re, le) {
    if (!(re > 0 && le > 0)) return [];
    const r = 1.25 * re;
    return [{ at: 'shunt', type: 'RC', value: r, c: le / (r * r), role: 'Zobel' }];
  }

  const zOf = (part, w) => {
    switch (part.type) {
      case 'L': return X.C(part.r || 0, w * part.value);         // r: the coil's own resistance
      case 'C': return X.C(0, -1 / (w * part.value));
      case 'R': return X.C(part.value, 0);
      case 'RC': return X.C(part.value, -1 / (w * part.c));
      default: return X.C(1e12, 0);
    }
  };
  const par = (a, b) => X.cdiv(X.cmul(a, b), X.cadd(a, b));

  // Voltage at the driver over voltage from the amp, and what the amp sees.
  function solve(parts, zLoad, w) {
    let Z = zLoad, H = X.C(1);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i], ze = zOf(p, w);
      if (p.at === 'shunt') Z = par(Z, ze);
      else { H = X.cmul(H, X.cdiv(Z, X.cadd(Z, ze))); Z = X.cadd(Z, ze); }
    }
    return { H, Zin: Z };
  }

  // Everything for one way: filter(s), then L-pad, then Zobel across the driver.
  function wayParts(o) {
    const out = [];
    if (o.hp) out.push(...section(o.hp.al, o.hp.f, o.R, true));
    if (o.lp) out.push(...section(o.lp.al, o.lp.f, o.R, false));
    out.push(...lpad(o.pad, o.R));
    if (o.zobel) out.push(...zobel(o.re, o.le));
    return out;
  }

  // A small driver (tweeter or mid in its own chamber) from a few figures:
  // response a 2nd-order high-pass at fs/Qts from its sensitivity, impedance
  // Re + jωLe plus the resonance peak.
  function smallDriver(t) {
    const re = t.re || 5.6, zmax = Math.max(re * 1.2, t.zmax || re * 3), qts = t.qts || 0.7;
    const qms = qts * zmax / re, rres = zmax - re;
    return {
      z: (w) => {
        const f = w / TAU, x = qms * (f / t.fs - t.fs / f);
        return X.cadd(X.C(re, w * (t.le || 0.00005)), X.cdiv(X.C(rres, 0), X.C(1, x)));
      },
      // pressure for 1 V at its terminals, as a complex number (20 µPa = 0 dB)
      p: (w) => {
        const w0 = TAU * t.fs, p0 = 20e-6 * Math.pow(10, t.sens / 20) / 2.83;
        return X.cdiv(X.C(-w * w * p0, 0), X.C(w0 * w0 - w * w, w * w0 / qts));
      },
    };
  }

  // Nearest preferred value (E12 for capacitors and resistors, E24 for coils).
  const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
  const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
  function nearest(v, series = E12) {
    if (!(v > 0)) return v;
    const e = Math.floor(Math.log10(v)), m = v / Math.pow(10, e);
    let best = series[0], d = Infinity;
    for (const s of series.concat([10])) { const dd = Math.abs(Math.log(m / s)); if (dd < d) { d = dd; best = s; } }
    return best * Math.pow(10, e);
  }

  GL.crossover = { PROTO, TARGET, ALIGN, section, lpad, zobel, solve, wayParts, smallDriver, nearest, E12, E24 };
})(window.GL);
