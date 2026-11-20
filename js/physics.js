/* GetLow – acoustic simulation core.
 *
 * Every enclosure is turned into a lumped-element acoustic network and solved
 * by nodal analysis at each frequency. Pressures are node "voltages", volume
 * velocities are "currents". Node 0 is the outside air (p = 0); any volume
 * velocity flowing into node 0 is radiated sound.
 *
 * Elements: chamber compliance (with leakage/absorption losses), port mass,
 * passive radiator, driver (Norton source), transmission-line segment
 * (distributed two-port) and mouth radiation impedance.
 */
(function (GL) {
  'use strict';

  // WinISD's defaults for air, so results line up with its driver files.
  const phys = { rho: 1.20095, c: 343.68, pRef: 2e-5 };
  phys.rc2 = () => phys.rho * phys.c * phys.c;

  // ---- complex numbers as {re, im} ---------------------------------------
  const C = (re, im = 0) => ({ re, im });
  const cadd = (a, b) => C(a.re + b.re, a.im + b.im);
  const csub = (a, b) => C(a.re - b.re, a.im - b.im);
  const cmul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const cdiv = (a, b) => {
    const d = b.re * b.re + b.im * b.im;
    return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
  };
  const cinv = (b) => cdiv(C(1), b);
  const cscale = (a, s) => C(a.re * s, a.im * s);
  const cabs = (a) => Math.hypot(a.re, a.im);
  const carg = (a) => Math.atan2(a.im, a.re);
  const ccosh = (z) => C(Math.cosh(z.re) * Math.cos(z.im), Math.sinh(z.re) * Math.sin(z.im));
  const csinh = (z) => C(Math.sinh(z.re) * Math.cos(z.im), Math.cosh(z.re) * Math.sin(z.im));
  const cx = { C, cadd, csub, cmul, cdiv, cinv, cscale, cabs, carg, ccosh, csinh };

  // ---- dense complex linear solve (Gaussian elimination, partial pivot) ---
  function solveLinear(Ar, Ai, br, bi, n) {
    for (let k = 0; k < n; k++) {
      let piv = k, best = -1;
      for (let i = k; i < n; i++) {
        const m = Ar[i][k] * Ar[i][k] + Ai[i][k] * Ai[i][k];
        if (m > best) { best = m; piv = i; }
      }
      if (!(best > 0)) throw new Error('Network is singular (a chamber or line has nothing connected?)');
      if (piv !== k) {
        [Ar[k], Ar[piv]] = [Ar[piv], Ar[k]];
        [Ai[k], Ai[piv]] = [Ai[piv], Ai[k]];
        [br[k], br[piv]] = [br[piv], br[k]];
        [bi[k], bi[piv]] = [bi[piv], bi[k]];
      }
      const pr = Ar[k][k], pi = Ai[k][k], d = pr * pr + pi * pi;
      const rowR = Ar[k], rowI = Ai[k];
      for (let i = k + 1; i < n; i++) {
        const ar = Ar[i][k], ai = Ai[i][k];
        if (ar === 0 && ai === 0) continue;
        const fr = (ar * pr + ai * pi) / d, fi = (ai * pr - ar * pi) / d;
        const tr = Ar[i], ti = Ai[i];
        for (let j = k; j < n; j++) {
          const xr = rowR[j], xi = rowI[j];
          tr[j] -= fr * xr - fi * xi;
          ti[j] -= fr * xi + fi * xr;
        }
        br[i] -= fr * br[k] - fi * bi[k];
        bi[i] -= fr * bi[k] + fi * br[k];
      }
    }
    const xr = new Float64Array(n), xi = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let sr = br[i], si = bi[i];
      for (let j = i + 1; j < n; j++) {
        sr -= Ar[i][j] * xr[j] - Ai[i][j] * xi[j];
        si -= Ar[i][j] * xi[j] + Ai[i][j] * xr[j];
      }
      const pr = Ar[i][i], pi = Ai[i][i], d = pr * pr + pi * pi;
      xr[i] = (sr * pr + si * pi) / d;
      xi[i] = (si * pr - sr * pi) / d;
    }
    return { xr, xi };
  }

  class Network {
    constructor() { this.names = ['Outside']; this.elements = []; }
    node(name) { this.names.push(name); return this.names.length - 1; }
    add(el) { this.elements.push(el); return el; }

    // Returns complex node pressures, index 0 = outside (always 0).
    solve(w) {
      const n = this.names.length - 1;
      const Ar = [], Ai = [];
      for (let i = 0; i < n; i++) { Ar.push(new Float64Array(n)); Ai.push(new Float64Array(n)); }
      const br = new Float64Array(n), bi = new Float64Array(n);
      const st = {
        // two-terminal admittance between nodes a and b
        y(a, b, y) {
          if (a) { Ar[a - 1][a - 1] += y.re; Ai[a - 1][a - 1] += y.im; }
          if (b) { Ar[b - 1][b - 1] += y.re; Ai[b - 1][b - 1] += y.im; }
          if (a && b) {
            Ar[a - 1][b - 1] -= y.re; Ai[a - 1][b - 1] -= y.im;
            Ar[b - 1][a - 1] -= y.re; Ai[b - 1][a - 1] -= y.im;
          }
        },
        // two-port given by Y parameters, both ports referenced to outside
        y2(a, b, y11, y12, y21, y22) {
          const add = (r, c, v) => { if (r && c) { Ar[r - 1][c - 1] += v.re; Ai[r - 1][c - 1] += v.im; } };
          add(a, a, y11); add(a, b, y12); add(b, a, y21); add(b, b, y22);
        },
        // source volume velocity injected into node a
        inj(a, I) { if (a) { br[a - 1] += I.re; bi[a - 1] += I.im; } },
      };
      for (const el of this.elements) el.stamp(st, w);
      const { xr, xi } = solveLinear(Ar, Ai, br, bi, n);
      const p = [C(0)];
      for (let i = 0; i < n; i++) p.push(C(xr[i], xi[i]));
      return p;
    }
  }

  // ---- elements ---------------------------------------------------------

  // Chamber air spring to ground. Ral = leakage (parallel), Raa = absorption (series).
  function compliance(node, Cab, Ral, Raa) {
    return {
      kind: 'compliance', node,
      stamp(st, w) {
        let y = cinv(C(Raa || 0, -1 / (w * Cab)));
        if (isFinite(Ral) && Ral > 0) y = cadd(y, C(1 / Ral));
        st.y(node, 0, y);
      },
    };
  }

  // Acoustic mass + resistance between two nodes: a port / vent.
  function port(a, b, Map, Rap, area) {
    return {
      kind: 'port', a, b, Map, Rap, area,
      z(w) { return C(Rap, w * Map); },
      stamp(st, w) { st.y(a, b, cinv(this.z(w))); },
      flow(w, p) { return cdiv(csub(p[a], p[b]), this.z(w)); },
    };
  }

  // Passive radiator(s): mechanical series RLC seen through its area.
  function passiveRadiator(a, b, Mm, Cm, Rm, S, count) {
    return {
      kind: 'pr', a, b, S, count,
      z(w) { return cscale(C(Rm, w * Mm - 1 / (w * Cm)), 1 / (S * S * count)); },
      stamp(st, w) { st.y(a, b, cinv(this.z(w))); },
      flow(w, p) { return cdiv(csub(p[a], p[b]), this.z(w)); },
      excursion(w, p) { return cdiv(cscale(this.flow(w, p), 1 / (S * count)), C(0, w)); },
    };
  }

  // Driver(s): Thevenin source Pg behind Za between rear and front nodes,
  // stamped as its Norton equivalent. `eg(w)` = complex volts on EACH driver.
  // Positive U flows out of the cone front into the front node.
  function driver(rear, front, d, count, eg) {
    return {
      kind: 'driver', rear, front, count, d,
      parts(w) {
        // voice coil: Re + Le, plus L2 ∥ R2 (lossy inductance) and anything in series (e.g. a baffle-step coil)
        let Ze = C(d.Re, w * d.Le);
        if (d.L2 > 0 && d.R2 > 0) Ze = cadd(Ze, cdiv(C(0, w * d.L2 * d.R2), C(d.R2, w * d.L2)));
        if (d.zs) Ze = cadd(Ze, d.zs(w));
        const Zm = C(d.Rms, w * d.Mms - 1 / (w * d.Cms));
        const Za = cscale(cadd(Zm, cdiv(C(d.BL * d.BL), Ze)), 1 / (d.Sd * d.Sd));
        const Eg = eg(w);
        const Pg = cdiv(cscale(Eg, d.BL / d.Sd), Ze);
        return { Ze, Za, Eg, Pg };
      },
      stamp(st, w) {
        const { Za, Pg } = this.parts(w);
        const Y = cscale(cinv(Za), count);
        const In = cmul(Pg, Y);
        st.y(rear, front, Y);
        st.inj(front, In);
        st.inj(rear, cscale(In, -1));
      },
      state(w, p) {
        const { Ze, Za, Eg, Pg } = this.parts(w);
        const U = cdiv(csub(Pg, csub(p[front], p[rear])), Za);   // per driver
        const u = cscale(U, 1 / d.Sd);
        const x = cdiv(u, C(0, w));
        const i = cdiv(csub(Eg, cscale(u, d.BL)), Ze);
        return { U, u, x, i, Eg, Z: cdiv(Eg, i) };
      },
    };
  }

  // Uniform tube segment as a distributed two-port. loss(w) -> {alpha (Np/m), cs (m/s)}
  function tube(a, b, S, L, loss) {
    return {
      kind: 'tube', a, b, S, L,
      stamp(st, w) {
        const { alpha, cs } = loss(w);
        const g = C(alpha * L, (w / cs) * L);
        const Z0 = phys.rho * phys.c / S;
        const sh = csinh(g), ch = ccosh(g);
        const y11 = cscale(cdiv(ch, sh), 1 / Z0);
        const y12 = cscale(cinv(sh), -1 / Z0);
        st.y2(a, b, y11, y12, y12, y11);
      },
    };
  }

  // Radiation impedance of an open mouth of area S (low-ka piston model,
  // resistance saturating to rho*c/S). Flanged = mouth set in a baffle.
  function mouth(node, S, flanged) {
    const a = Math.sqrt(S / Math.PI);
    const delta = (flanged ? 0.8216 : 0.6133) * a;
    return {
      kind: 'mouth', node, S,
      z(w) {
        const k = w / phys.c;
        const x = (k * a) * (k * a) / (flanged ? 2 : 4);
        return cscale(C(x / (1 + x), k * delta), phys.rho * phys.c / S);
      },
      stamp(st, w) { st.y(node, 0, cinv(this.z(w))); },
      flow(w, p) { return cdiv(p[node], this.z(w)); },
    };
  }

  // ---- special functions for piston radiation --------------------------
  // Bessel J0/J1: Abramowitz & Stegun 9.4.1-9.4.6 (error < 1e-7).
  function besselJ0(x) {
    const ax = Math.abs(x);
    if (ax <= 3) {
      const y = (x / 3) * (x / 3);
      return 1 + y * (-2.2499997 + y * (1.2656208 + y * (-0.3163866 + y * (0.0444479 + y * (-0.0039444 + y * 0.0002100)))));
    }
    const y = 3 / ax;
    const f0 = 0.79788456 + y * (-0.00000077 + y * (-0.00552740 + y * (-0.00009512 + y * (0.00137237 + y * (-0.00072805 + y * 0.00014476)))));
    const t0 = ax - 0.78539816 + y * (-0.04166397 + y * (-0.00003954 + y * (0.00262573 + y * (-0.00054125 + y * (-0.00029333 + y * 0.00013558)))));
    return f0 * Math.cos(t0) / Math.sqrt(ax);
  }
  function besselJ1(x) {
    const ax = Math.abs(x);
    let r;
    if (ax <= 3) {
      const y = (x / 3) * (x / 3);
      r = ax * (0.5 + y * (-0.56249985 + y * (0.21093573 + y * (-0.03954289 + y * (0.00443319 + y * (-0.00031761 + y * 0.00001109))))));
    } else {
      const y = 3 / ax;
      const f1 = 0.79788456 + y * (0.00000156 + y * (0.01659667 + y * (0.00017105 + y * (-0.00249511 + y * (0.00113653 + y * -0.00020033)))));
      const t1 = ax - 2.35619449 + y * (0.12499612 + y * (0.00005650 + y * (-0.00637879 + y * (0.00074348 + y * (0.00079824 + y * -0.00029166)))));
      r = f1 * Math.cos(t1) / Math.sqrt(ax);
    }
    return x < 0 ? -r : r;
  }
  // Struve H1: power series for small x, Aarts & Janssen (2003) beyond.
  function struveH1(x) {
    if (x < 10) {
      let a = Math.sqrt(Math.PI) / 2, b = a * 1.5;     // Γ(m+3/2), Γ(m+5/2) at m = 0
      let s = 0, pw = (x / 2) * (x / 2);
      for (let m = 0; m < 60; m++) {
        const term = pw / (a * b);
        s += m % 2 ? -term : term;
        if (Math.abs(term) < 1e-17 * Math.abs(s)) break;
        pw *= (x / 2) * (x / 2);
        a = b; b = b * (m + 2.5);
      }
      return s;
    }
    return 2 / Math.PI - besselJ0(x) + (16 / Math.PI - 5) * Math.sin(x) / x + (12 - 36 / Math.PI) * (1 - Math.cos(x)) / (x * x);
  }
  // Normalised radiation impedance of a rigid piston in an infinite baffle:
  // Z = rho*c/S * (R1(2ka) + j X1(2ka)).
  function pistonZ(S, w) {
    const a = Math.sqrt(S / Math.PI);
    const x = 2 * (w / phys.c) * a;
    if (x < 1e-6) return C(0, 0);
    return cscale(C(1 - 2 * besselJ1(x) / x, 2 * struveH1(x) / x), phys.rho * phys.c / S);
  }

  // Horn / line mouth radiating into solid angle `omega` (2π = mouth in a
  // large baffle, 4π = free air, π = against a wall and the floor, π/2 = in a
  // corner). Other angles use the image-source estimate (2π/Ω)·Zpiston(S·2π/Ω),
  // which is exact at low and high frequency and approximate between.
  function pistonMouth(node, S, omega) {
    const n = 2 * Math.PI / omega;
    return {
      kind: 'mouth', node, S,
      z(w) { return cscale(pistonZ(S * n, w), n); },
      stamp(st, w) { st.y(node, 0, cinv(this.z(w))); },
      flow(w, p) { return cdiv(p[node], this.z(w)); },
    };
  }

  // ---- horns: exact Webster-equation two-ports -------------------------
  const csqrt = (z) => {
    const r = Math.hypot(z.re, z.im);
    const re = Math.sqrt((r + z.re) / 2), im = Math.sqrt(Math.max(0, (r - z.re) / 2));
    return C(re, z.im < 0 ? -im : im);
  };
  const cexp = (z) => { const e = Math.exp(z.re); return C(e * Math.cos(z.im), e * Math.sin(z.im)); };
  const mat = (a, b, c, d) => [a, b, c, d];
  const mmul = (A, B) => mat(
    cadd(cmul(A[0], B[0]), cmul(A[1], B[2])), cadd(cmul(A[0], B[1]), cmul(A[1], B[3])),
    cadd(cmul(A[2], B[0]), cmul(A[3], B[2])), cadd(cmul(A[2], B[1]), cmul(A[3], B[3])));
  const minv = (A) => {
    const det = csub(cmul(A[0], A[3]), cmul(A[1], A[2]));
    return mat(cdiv(A[3], det), cdiv(cscale(A[1], -1), det), cdiv(cscale(A[2], -1), det), cdiv(A[0], det));
  };

  // One horn section with area S(x) = S1·f(x)², where f''/f = c0 is
  // constant (conical/cylinder: c0 = 0; exponential, hyperbolic-exponential
  // and catenoidal: c0 = 1/x0²). Then p = ψ/f with ψ'' + (k² − c0)ψ = 0,
  // which is solved exactly. sec = { S1, L, c0, f(x), df(x) }.
  // Returns the transfer matrix [p1; U1] = T [p2; U2] (U flowing toward the mouth).
  function sectionT(sec, w, alpha) {
    const k = C(w / phys.c, -alpha);                       // small loss: e^{-jkx} decays
    let kap = csqrt(csub(cmul(k, k), C(sec.c0)));
    if (Math.hypot(kap.re, kap.im) * sec.L < 1e-7) kap = cadd(kap, C(1e-7 / sec.L));   // avoid the degenerate case
    const jwr = C(0, w * phys.rho);
    const M = (x) => {
      const f = sec.f(x), df = sec.df(x), S = sec.S1 * f * f;
      const col = (sgn) => {
        const jk = cmul(C(0, -sgn), kap);                 // ψ = e^{jk·x}, ψ' = jk·ψ
        const psi = cexp(cscale(jk, x));
        const p = cscale(psi, 1 / f);
        const dp = csub(cscale(cmul(jk, psi), 1 / f), cscale(psi, df / (f * f)));
        return [p, cdiv(cscale(dp, -S), jwr)];             // U = -S/(jωρ) dp/dx
      };
      const a = col(1), b = col(-1);
      return mat(a[0], b[0], a[1], b[1]);
    };
    return mmul(M(0), minv(M(sec.L)));
  }

  // Whole horn between two nodes (throat a, mouth-end b). sections: list from
  // GL.enclosures.hornSections(); stamped through its Y parameters.
  function horn(a, b, sections) {
    return {
      kind: 'horn', a, b, sections,
      T(w) {
        let T = mat(C(1), C(0), C(0), C(1));
        const f = w / (2 * Math.PI);
        for (const s of sections) {
          // wall loss (viscous/thermal) for the section's mean radius
          const alpha = 3e-5 * Math.sqrt(f) / Math.sqrt(s.Smean / Math.PI);
          T = mmul(T, sectionT(s, w, alpha));
        }
        return T;
      },
      stamp(st, w) {
        const [A, B, Cc, D] = this.T(w);
        const det = csub(cmul(A, D), cmul(B, Cc));
        st.y2(a, b, cdiv(D, B), cscale(cdiv(det, B), -1), cscale(cinv(B), -1), cdiv(A, B));
      },
      // volume velocity entering the throat
      throatFlow(w, p) {
        const [A, B, Cc, D] = this.T(w);
        const det = csub(cmul(A, D), cmul(B, Cc));
        return csub(cmul(cdiv(D, B), p[a]), cmul(cdiv(det, B), p[b]));
      },
    };
  }

  // ---- frequency sweep ---------------------------------------------------
  // model = { net, drivers:[driver el], radiators:[{label, flow(w,p)}],
  //           ports:[{el, label, area}], prs:[{el, label, xmax}], wiring, drv }
  function sweep(model, freqs, opts) {
    const n = freqs.length;
    const out = {
      f: freqs,
      spl: new Float64Array(n), phase: new Float64Array(n), gd: new Float64Array(n),
      zmag: new Float64Array(n), zph: new Float64Array(n),
      xpk: new Float64Array(n),       // cone excursion, mm peak, per driver
      maxSpl: new Float64Array(n),    // excursion / thermal limited
      maxV: new Float64Array(n),      // amp volts (rms) at that limit
      contrib: model.radiators.map(r => ({ label: r.label, spl: new Float64Array(n) })),
      // extra listening angles (opts.angles, degrees), with opts.field(j, w, angle) per radiator
      offAxis: (opts.angles || []).map(a => ({ angle: a, spl: new Float64Array(n) })),
      splBox: opts.field ? new Float64Array(n) : null,   // without the baffle (the box's own alignment)
      phaseBox: opts.field ? new Float64Array(n) : null,
      portVel: model.ports.map(p => ({ label: p.label, v: new Float64Array(n), full: new Float64Array(n) })),   // m/s peak (full = at full power)
      prX: model.prs.map(p => ({ label: p.label, x: new Float64Array(n), xmax: p.xmax })), // mm peak
    };
    const drvEl = model.drivers[0];
    const d = drvEl.d;
    const N = drvEl.count;
    const vTherm = Math.sqrt(d.Pe * d.Re);   // per-driver rms volts at rated power
    // |p| at 1 m per unit volume velocity, radiating into solid angle Ω (2π = half space)
    const omega = model.omega || 2 * Math.PI;
    const k = (w) => w * phys.rho / omega;
    const ph = new Float64Array(n), phB = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const w = 2 * Math.PI * freqs[i];
      const p = model.net.solve(w);
      let Ut = C(0), Ub = C(0);
      const Us = [];
      model.radiators.forEach((r, j) => {
        let U = r.flow(w, p);
        Us.push(U);
        Ub = cadd(Ub, U);
        // baffle diffraction and directivity of this radiator (on axis)
        if (opts.field) U = cmul(U, opts.field(j, w, 0));
        Ut = cadd(Ut, U);
        out.contrib[j].spl[i] = 20 * Math.log10(Math.max(1e-30, cabs(U) * k(w)) / phys.pRef);
      });
      if (out.splBox) { const pb = cmul(Ub, C(0, k(w))); out.splBox[i] = 20 * Math.log10(Math.max(1e-30, cabs(pb)) / phys.pRef); phB[i] = carg(pb); }
      out.offAxis.forEach((oa) => {
        let Ua = C(0);
        Us.forEach((U, j) => { Ua = cadd(Ua, cmul(U, opts.field(j, w, oa.angle * Math.PI / 180))); });
        oa.spl[i] = 20 * Math.log10(Math.max(1e-30, cabs(Ua) * k(w)) / phys.pRef);
      });
      const pres = cmul(Ut, C(0, k(w)));   // j*w*rho*U / (2*pi*r)
      out.spl[i] = 20 * Math.log10(Math.max(1e-30, cabs(pres)) / phys.pRef);
      ph[i] = carg(pres);

      const s = drvEl.state(w, p);
      const zd = cabs(s.Z);
      out.zmag[i] = model.wiring === 'series' ? zd * N : zd / N;
      out.zph[i] = carg(s.Z) * 180 / Math.PI;
      const xpk = Math.SQRT2 * cabs(s.x);
      out.xpk[i] = xpk * 1000;

      // Largest scale factor on the drive signal before a limit is hit.
      // With opts.drive (unfiltered volts per driver) the amp is capped at the
      // driver's rated power before the filters, so filters lower max SPL
      // where they cut instead of being "turned up" to compensate.
      let scale = vTherm / Math.max(1e-12, opts.drive || cabs(s.Eg));
      if (d.Xmax > 0) scale = Math.min(scale, d.Xmax / Math.max(1e-15, xpk));
      model.prs.forEach((pr, j) => {
        const x = Math.SQRT2 * cabs(pr.el.excursion(w, p));
        out.prX[j].x[i] = x * 1000;
        if (pr.xmax > 0) scale = Math.min(scale, pr.xmax / Math.max(1e-15, x));
      });
      // Port / line-mouth air speed, at this drive and at full power (thermal,
      // Xmax and PR limits only). Optional limit: the linear model has no port
      // compression, so without it resonant designs show impossible max SPL.
      const full = scale;
      model.ports.forEach((pt, j) => {
        const v = Math.SQRT2 * cabs(pt.el.flow(w, p)) / pt.area;
        out.portVel[j].v[i] = v;
        out.portVel[j].full[i] = v * full;
        if (opts.vmax > 0) scale = Math.min(scale, opts.vmax / Math.max(1e-12, v));
      });
      out.maxSpl[i] = out.spl[i] + 20 * Math.log10(scale);
      out.maxV[i] = opts.volts * scale;
    }

    // unwrap phase, then group delay = -dphi/dw (ms)
    let off = 0;
    for (let i = 0; i < n; i++) {
      if (i) {
        const dphi = ph[i] + off - out.phase[i - 1];
        if (dphi > Math.PI) off -= 2 * Math.PI;
        else if (dphi < -Math.PI) off += 2 * Math.PI;
      }
      out.phase[i] = ph[i] + off;
    }
    if (out.phaseBox) {
      let o2 = 0;
      for (let i = 0; i < n; i++) {
        if (i) { const d = phB[i] + o2 - out.phaseBox[i - 1]; if (d > Math.PI) o2 -= 2 * Math.PI; else if (d < -Math.PI) o2 += 2 * Math.PI; }
        out.phaseBox[i] = phB[i] + o2;
      }
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dw = 2 * Math.PI * (freqs[b] - freqs[a]);
      out.gd[i] = -(out.phase[b] - out.phase[a]) / dw * 1000;
    }
    return out;
  }

  GL.phys = phys;
  GL.cx = cx;
  GL.Network = Network;
  GL.el = { compliance, port, passiveRadiator, driver, tube, mouth, pistonMouth, horn };
  GL.special = { besselJ0, besselJ1, struveH1, pistonZ, sectionT };
  GL.sweep = sweep;
})(window.GL);
