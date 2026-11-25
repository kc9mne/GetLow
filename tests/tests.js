/* GetLow physics tests: compare the network solver with closed-form results. */
(function (GL) {
  'use strict';
  const results = [];
  const near = (name, got, want, tol) => {
    const ok = Math.abs(got - want) <= tol;
    results.push({ name, ok, detail: `got ${(+got).toFixed(4)}, want ${(+want).toFixed(4)} ± ${tol}` });
  };
  const truthy = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' });
  const asyncTests = [];       // checks that finish later (async searches)

  const E = GL.enclosures, G = GL.geometry, D = GL.drivers, IN = GL.units.IN;
  const sample = (id) => D.parseDriverFile(GL.samples.find(s => s.id === id).file, GL.samples.find(s => s.id === id).text);
  const grs = sample('sample-grs-8sw-4he');
  const lossless = (design) => {
    for (const c of design.chambers) { c.ql = 1e9; c.qa = 1e9; }
    for (const p of design.ports) p.qp = 1e9;
    return design;
  };
  const run = (design, drvc, volts, f0, f1, n) => {
    const model = E.buildModel(design, drvc, () => GL.cx.C(volts));
    return GL.sweep(model, GL.util.logspace(f0 || 5, f1 || 500, n || 2000), { volts });
  };
  const argmax = (a) => a.reduce((b, v, i) => (v > a[b] ? i : b), 0);
  const argmin = (a) => a.reduce((b, v, i) => (v < a[b] ? i : b), 0);

  // ---- driver file ----
  near('wdr: Fs parsed', grs.params.fs, 24.787021, 1e-6);
  near('wdr: Vas parsed (m³)', grs.params.vas, 0.03160077, 1e-9);
  const dc = D.complete(grs.params);
  near('wdr: Qts derived from Qes/Qms', dc.params.qts, 0.4508, 0.001);
  near('wdr: BL derived close to file BL', dc.model.BL, 10.51, 0.15);
  near('wdr: sensitivity matches file SPL', dc.derived.spl1w, 81.717, 0.15);

  const hr = D.parseHornresp('Sd = 506.71\nBl = 14.21\nCms = 2.05E-04\nRms = 2.21\nMmd = 63.49\nLe = 0.65\nRe = 5.70\n');
  const hrc = D.complete(hr.params);
  near('hornresp: Fs from Mmd/Cms', hrc.params.fs, 1 / (2 * Math.PI * Math.sqrt(0.06349 * 2.05e-4)), 1e-6);

  // Same model with Le = 0 for the small-signal checks
  const ideal = D.complete(Object.assign({}, grs.params, { le: 0 }));
  const p = ideal.params;

  // ---- sensitivity in the mass-controlled region (1 W into Re, near infinite baffle) ----
  {
    const d = lossless(E.makeDesign('sealed', ideal, 1));
    d.chambers[0].vol = 1000;
    const r = run(d, ideal, Math.sqrt(p.re), 150, 400, 50);
    near('SPL 1W/1m at ~10×Fs equals 112.1 + 10·log(η0)', r.spl[r.spl.length - 1], ideal.derived.spl1w, 0.3);
  }

  // ---- sealed: impedance peak at Fc, SPL at Fc equals 20·log(Qtc) below asymptote ----
  {
    const d = lossless(E.makeDesign('sealed', ideal, 1));
    const V = 0.02;
    d.chambers[0].vol = V;
    const a = p.vas / V;
    const fc = p.fs * Math.sqrt(1 + a), qtc = p.qts * Math.sqrt(1 + a);
    const r = run(d, ideal, 2.83, 5, 2000, 4000);
    near('sealed: impedance peak at Fc (Hz)', r.f[argmax(r.zmag)], fc, fc * 0.01);
    const asym = r.spl[r.spl.length - 1];
    const iFc = r.f.findIndex(f => f >= fc);
    near('sealed: SPL at Fc = asymptote + 20·log(Qtc) (dB)', r.spl[iFc] - asym, 20 * Math.log10(qtc), 0.15);
  }

  // ---- ported: cone excursion minimum at the Helmholtz tuning ----
  {
    const d = lossless(E.makeDesign('ported', ideal, 1));
    const fb = E.portFb(d.ports[0], d.chambers[0].vol);
    const r = run(d, ideal, 2.83, 5, 200, 4000);
    near('ported: excursion minimum at Fb (Hz)', r.f[argmin(r.xpk)], fb, fb * 0.01);
    const L = E.lenForFb(d.ports[0], d.chambers[0].vol, 30);
    const pt = Object.assign({}, d.ports[0], { len: L });
    near('ported: length-for-Fb round trip', E.portFb(pt, d.chambers[0].vol), 30, 1e-9);
  }

  // ---- WinISD 0.7.0.950 reference: GRS 8SW-4HE, 1.25 ft³, 30 Hz, one 3" port,
  // end correction 0.732, Ql 10. Values read from its transfer-function graph. ----
  {
    const FT3 = GL.units.FT3;
    const d = E.makeDesign('ported', ideal, 1);
    d.chambers[0].vol = 1.25 * FT3; d.chambers[0].ql = 10; d.chambers[0].qa = 100;
    Object.assign(d.ports[0], { shape: 'round', d: 3 * IN, count: 1, end: 'flanged-free', qp: 100 });
    d.ports[0].len = E.lenForFb(d.ports[0], 1.25 * FT3, 30);
    near('WinISD: vent length for 30 Hz (in)', d.ports[0].len / IN, 14.67, 0.005);
    const r = run(d, ideal, 2.83, 10, 2000, 3000);
    const ref = r.spl[r.spl.length - 1];
    const rel = (f) => GL.interp(r.f, Array.from(r.spl, v => v - ref), f);
    for (const [f, want] of [[20, -10.92], [25, -3.51], [30, 1.63], [35.5, 3.62], [50, 2.26], [100, 0.59]]) {
      near(`WinISD: response at ${f} Hz (dB)`, rel(f), want, 0.6);
    }
  }

  // ---- flared and slot ports ----
  {
    const vol = 1.25 * GL.units.FT3;
    const base = { shape: 'round', d: 3 * IN, len: 14 * IN, count: 1, end: 'flanged-free', wall: 0.25 * IN, flareOut: 0, flareIn: 0 };
    // WinISD shows the factor rounded to 0.732 (exact 0.73165)
    near('straight port: end correction = 0.732 × D', E.portEnd(base) / IN, 0.732 * 3, 0.002);
    // A flare of ~zero radius must behave like the straight port.
    const tiny = Object.assign({}, base, { flareOut: 1e-7, flareIn: 1e-7 });
    near('flare → 0 equals straight port (Hz)', E.portFb(tiny, vol), E.portFb(base, vol), 1e-4);
    // Integral check against a brute-force sum of the same profile.
    const fl = Object.assign({}, base, { flareOut: 1.5 * IN, flareIn: 1 * IN });
    const prof = (x) => { const a = base.d / 2, L = fl.len;
      const r = (R, s) => a + R - Math.sqrt(Math.max(0, R * R - (R - s) * (R - s)));
      return x < fl.flareOut ? r(fl.flareOut, x) : x > L - fl.flareIn ? r(fl.flareIn, L - x) : a; };
    let sum = 0; const N = 200000;
    for (let i = 0; i < N; i++) { const r = prof((i + 0.5) / N * fl.len); sum += (fl.len / N) / (Math.PI * r * r); }
    const endTerms = 0.85 / (Math.PI * (base.d / 2 + fl.flareOut)) + 0.6133 / (Math.PI * (base.d / 2 + fl.flareIn));
    near('flared port: acoustic mass matches brute-force integral', E.portMass(fl) / (GL.phys.rho * (sum + endTerms)), 1, 1e-4);
    truthy('flares raise tuning at the same length', E.portFb(fl, vol) > E.portFb(base, vol),
      `${E.portFb(fl, vol).toFixed(2)} Hz vs ${E.portFb(base, vol).toFixed(2)} Hz straight`);
    const L30 = E.lenForFb(fl, vol, 30);
    near('flared port: length-for-Fb round trip', E.portFb(Object.assign({}, fl, { len: L30 }), vol), 30, 1e-9);
    truthy('flared port takes more box volume than straight', E.portDisplacement(fl, 0) > E.portDisplacement(base, 0));
    near('straight port displacement = π(r+wall)²·L', E.portDisplacement(base, 0), Math.PI * Math.pow(1.75 * IN, 2) * 14 * IN, 1e-12);

    const slot = { shape: 'slot', w: 2 * IN, h: 12 * IN, len: 20 * IN, count: 1, end: 'flanged-free', alongWall: false, fullHeight: false };
    const sw = Object.assign({}, slot, { alongWall: true });
    const sf = Object.assign({}, sw, { fullHeight: true });
    truthy('slot against a wall tunes lower than a free-standing slot', E.portFb(sw, vol) < E.portFb(slot, vol),
      `${E.portFb(slot, vol).toFixed(2)} → ${E.portFb(sw, vol).toFixed(2)} Hz`);
    truthy('full-height slot tunes lower again', E.portFb(sf, vol) < E.portFb(sw, vol), `${E.portFb(sf, vol).toFixed(2)} Hz`);
    const t = 0.75 * IN;
    near('wall slot displacement = (w + one panel)·h·L', E.portDisplacement(sw, t), (2 + 0.75) * 12 * 20 * Math.pow(IN, 3), 1e-12);
    near('free slot displacement = (w + two panels)·h·L', E.portDisplacement(slot, t), (2 + 1.5) * 12 * 20 * Math.pow(IN, 3), 1e-12);
  }

  // ---- pasted spec sheets ----
  {
    const SP = GL.specparse;
    const FT3 = GL.units.FT3;
    // Parts Express product page, copied as the browser gives it (tabs)
    const pe = ['Product Details', 'Brand\tGRS', 'Model\t8SW-4HE', 'Part Number\t292-816', 'Product Specifications',
      'Nominal Diameter\t8"', 'Power Handling (RMS)\t150 Watts', 'Power Handling (MAX)\t300 Watts', 'Impedance\t4Ω',
      'Frequency Response\t30 to 700Hz', 'Sensitivity\t85dB 2.83V/1m', 'Magnet Weight\t57oz.', 'Thiele-Small Parameters',
      'Resonant Frequency (Fs)\t24.9Hz', 'DC Resistance (Re)\t3.8Ω', 'Voice Coil Inductance (Le)\t2.7mH', 'Mechanical Q (Qms)\t4.42',
      'Electromagnetic Q (Qes)\t0.51', 'Total Q (Qts)\t0.45', 'Compliance Equivalent Volume (Vas)\t1.12ft³',
      'Mechanical Compliance of Suspension (Cms)\t0.44mm/N', 'BL Product (BL)\t10.5T·m', 'Diaphragm Mass Inc. Airload (Mms)\t93.7g',
      'Maximum Linear Excursion (Xmax)\t10.8mm', 'Surface Area of Cone (Sd)\t227cm²', 'Mounting Information',
      'Overall Outside Diameter\t8.23"', 'Baffle Cutout Diameter\t7.125"', 'Depth\t4.6"', '# Mounting Holes\t8',
      'Sealed Volume\t0.5ft³', 'Vented Volume\t1ft³'].join('\n');
    const a = SP.parse(pe);
    const ap = a.params;
    truthy('PE page: brand/model/part', a.meta.brand === 'GRS' && a.meta.model === '8SW-4HE' && a.meta.part === '292-816', JSON.stringify(a.meta));
    near('PE page: Vas 1.12 ft³ → m³', ap.vas, 1.12 * FT3, 1e-9);
    near('PE page: Sd 227 cm²', ap.sd, 0.0227, 1e-12);
    near('PE page: Cms 0.44 mm/N', ap.Cms, 0.00044, 1e-12);
    near('PE page: Le 2.7 mH', ap.le, 0.0027, 1e-12);
    near('PE page: Mms 93.7 g', ap.Mms, 0.0937, 1e-12);
    near('PE page: Xmax 10.8 mm', ap.xmax, 0.0108, 1e-12);
    near('PE page: Pe from RMS row (not MAX, not mech. Rms)', ap.pe, 150, 0);
    truthy('PE page: "Power Handling (RMS)" not read as mechanical Rms', !('Rms' in ap), 'Rms = ' + ap.Rms);
    near('PE page: outside diameter 8.23"', ap.dia, 8.23 * IN, 1e-12);
    truthy('PE page: displacement estimated from cutout and depth', ap.dvolEstimated && ap.dvol > 0.0005 && ap.dvol < 0.002, (ap.dvol * 1000).toFixed(2) + ' L');
    truthy('PE page: no consistency warnings', !a.notes.some(n => n[0] === 'warn'), a.notes.filter(n => n[0] === 'warn').map(n => n[1]).join(' / '));
    const fromWdr = D.complete(grs.params), fromPaste = D.complete(ap);
    near('PE paste vs WinISD file: Fs', fromPaste.params.fs, fromWdr.params.fs, 0.2);
    near('PE paste vs WinISD file: Vas (L)', fromPaste.params.vas * 1000, fromWdr.params.vas * 1000, 0.3);

    // Dual voice coil sub, published with coils in series
    const dvc = ['Dayton Audio UMII12-22 Ultimax II 12" DVC Subwoofer 2 Ohm Per Coil', 'Impedance\t4Ω', 'Power Handling (RMS)\t800 Watts',
      'Resonant Frequency (Fs)\t31Hz', 'DC Resistance (Re)\t4.2Ω', 'Voice Coil Inductance (Le)\t0.66mH', 'Mechanical Q (Qms)\t2.75',
      'Electromagnetic Q (Qes)\t0.71', 'Total Q (Qts)\t0.56', 'Compliance Equivalent Volume (Vas)\t1.87ft³',
      'Mechanical Compliance of Suspension (Cms)\t0.133mm/N', 'BL Product (BL)\t14.8T·m', 'Diaphragm Mass Inc. Airload (Mms)\t189g',
      'Maximum Linear Excursion (Xmax)\t22mm', 'Surface Area of Cone (Sd)\t528cm²'].join('\n');
    const b = SP.parse(dvc);
    truthy('DVC: brand/model from title', b.meta.brand === 'Dayton Audio' && b.meta.model === 'UMII12-22', JSON.stringify(b.meta));
    truthy('DVC: detected, published as series', b.dvc && b.dvc.coils === 2 && b.dvc.published === 'series' && b.dvc.perCoil === 2, JSON.stringify(b.dvc));
    const par = D.complete(SP.forWiring(b.params, b.dvc, 'parallel')), ser = D.complete(SP.forWiring(b.params, b.dvc, 'series'));
    near('DVC parallel: Re = series / 4', par.params.re, 4.2 / 4, 1e-12);
    near('DVC parallel: BL = series / 2', par.model.BL / ser.model.BL, 0.5, 1e-9);
    near('DVC parallel: Qts unchanged', par.params.qts, ser.params.qts, 1e-12);
    near('DVC parallel: Znom 1 Ω', par.model.znom, 1, 1e-12);

    // European datasheet: comma decimals, µm/N, N/A, gr, liters, m²
    const eu = ['Example Audio TEST-12', 'Fs 24,5 Hz', 'Re 5,5 ohm', 'Le 1,32 mH @ 1kHz', 'Qms 4,57', 'Qes 0,65', 'Qts 0,57',
      'Mms 145 gr', 'Cms 291 µm/N', 'Rms 4,89 kg/s', 'Bl 13,7 N/A', 'Vas 144 l', 'Sd 0,0590 m²', 'Xmax ± 13,5 mm'].join('\n');
    const c = SP.parse(eu).params;
    near('EU sheet: Fs 24,5', c.fs, 24.5, 1e-12);
    near('EU sheet: Cms 291 µm/N', c.Cms, 291e-6, 1e-15);
    near('EU sheet: BL 13,7 N/A', c.BL, 13.7, 1e-12);
    near('EU sheet: Vas 144 l', c.vas, 0.144, 1e-12);
    near('EU sheet: Sd 0,0590 m²', c.sd, 0.059, 1e-12);
    near('EU sheet: Xmax ± 13,5 mm', c.xmax, 0.0135, 1e-12);
    near('EU sheet: Le with "@ 1kHz"', c.le, 0.00132, 1e-12);
    near('EU sheet: Mms 145 gr', c.Mms, 0.145, 1e-12);

    // Imperial sheet
    const us = ['Vas: 1.87 cu.ft.', 'Sd: 81.8 sq. in.', 'Xmax: .866 in', 'Mms: 189 grams', 'Cms: .133 mm/N', 'Fs: 31 Hz', 'Re: 4.2 ohms',
      'Qes: .71', 'Qms: 2.75', 'RMS power: 1,600 watts'].join('\n');
    const d = SP.parse(us);
    near('US sheet: Vas 1.87 cu.ft.', d.params.vas, 1.87 * FT3, 1e-9);
    near('US sheet: Sd 81.8 sq. in.', d.params.sd, 81.8 * IN * IN, 1e-12);
    near('US sheet: Xmax .866 in', d.params.xmax, 0.866 * IN, 1e-12);
    near('US sheet: 1,600 watts', d.params.pe, 1600, 0);
    truthy('US sheet: consistent, no warnings', !d.notes.some(n => n[0] === 'warn'), d.notes.map(n => n[1]).join(' / '));

    // Liters mislabelled as ft³ must be flagged
    const bad = SP.parse('Vas 53 ft³\nSd 528 cm²\nCms 0.133 mm/N\nFs 31 Hz\nRe 4.2\nQes 0.71\nQms 2.75');
    truthy('mislabelled Vas flagged as liters-as-ft³', bad.notes.some(n => n[0] === 'warn' && /liters value labelled as ft³/.test(n[1])), bad.notes.map(n => n[1]).join(' / '));

    // No units at all: plausible ranges pick L and cm²
    const nu = SP.parse('Fs 31\nVas 53\nSd 528\nRe 4.2\nQes 0.71\nQms 2.75\nXmax 22');
    near('no units: Vas 53 → liters', nu.params.vas, 0.053, 1e-12);
    near('no units: Sd 528 → cm²', nu.params.sd, 0.0528, 1e-12);
    near('no units: Xmax 22 → mm', nu.params.xmax, 0.022, 1e-12);
  }

  // ---- horns ----
  {
    const SPc = GL.special, X = GL.cx, ph = GL.phys;
    const rc = ph.rho * ph.c;
    // baffled piston: published values R1(2) = 0.4233, X1(2) = 0.6468, R1(10) = 0.9913
    near('piston: R1(2ka = 2)', 1 - 2 * SPc.besselJ1(2) / 2, 0.4233, 2e-4);
    near('piston: X1(2ka = 2) = H1(2)', SPc.struveH1(2), 0.6468, 2e-4);
    near('piston: R1(2ka = 10)', 1 - 2 * SPc.besselJ1(10) / 10, 0.9913, 2e-4);
    near('Struve H1: series and large-x formula agree at 10', SPc.struveH1(9.9999), 2 / Math.PI - SPc.besselJ0(9.9999) + (16 / Math.PI - 5) * Math.sin(9.9999) / 9.9999 + (12 - 36 / Math.PI) * (1 - Math.cos(9.9999)) / (9.9999 ** 2), 0.005);
    const zlow = SPc.pistonZ(0.01, 2 * Math.PI * 20);
    near('piston: low-frequency resistance = ρck²/2π', zlow.re, ph.rho * ph.c * Math.pow(2 * Math.PI * 20 / ph.c, 2) / (2 * Math.PI), 1e-3 * zlow.re);

    // straight section must equal a plane-wave tube: A = cos kL, B = j(ρc/S) sin kL
    const S = 0.002, L = 0.7, w = 2 * Math.PI * 300, kL = w / ph.c * L;
    const Tc = SPc.sectionT(E.makeSection(S, S, L, 'exp'), w, 0);
    near('cylinder section: A = cos kL', Tc[0].re, Math.cos(kL), 1e-9);
    near('cylinder section: B = j·ρc/S·sin kL', Tc[1].im, rc / S * Math.sin(kL), 1e-6 * rc / S);
    for (const [type, T] of [['exp', 1], ['hyp', 0.5], ['con', 0]]) {
      const Tm = SPc.sectionT(E.makeSection(0.001, 0.05, 1.2, type, T), 2 * Math.PI * 150, 0);
      const det = X.csub(X.cmul(Tm[0], Tm[3]), X.cmul(Tm[1], Tm[2]));
      near(`${type} section: reciprocal (det T = 1)`, X.cabs(det), 1, 1e-9);
    }

    // infinite exponential horn: Z_throat = ρc/S1·(√(1−(fc/f)²) + j·fc/f)
    {
      const sec = E.makeSection(0.001, 0.2, 1.5, 'exp');
      const fc = sec.fc;
      for (const ratio of [1.5, 2, 4]) {
        const f = fc * ratio, w2 = 2 * Math.PI * f, k = w2 / ph.c;
        const T = SPc.sectionT(sec, w2, 0);
        // load the mouth with the outgoing wave's own impedance → acts infinitely long
        const kap = Math.sqrt(k * k - sec.c0), fL = sec.f(sec.L), dfL = sec.df(sec.L), SL = sec.S1 * fL * fL;
        const psi = X.C(Math.cos(kap * sec.L), -Math.sin(kap * sec.L));
        const p = X.cscale(psi, 1 / fL);
        const dp = X.csub(X.cscale(X.cmul(X.C(0, -kap), psi), 1 / fL), X.cscale(psi, dfL / (fL * fL)));
        const U = X.cdiv(X.cscale(dp, -SL), X.C(0, w2 * ph.rho));
        const Zl = X.cdiv(p, U);
        const Zin = X.cdiv(X.cadd(X.cmul(T[0], Zl), T[1]), X.cadd(X.cmul(T[2], Zl), T[3]));
        const want = X.cscale(X.C(Math.sqrt(1 - 1 / (ratio * ratio)), 1 / ratio), rc / 0.001);
        near(`exp horn throat R at ${ratio}×fc (vs infinite-horn formula)`, Zin.re / want.re, 1, 1e-6);
        near(`exp horn throat X at ${ratio}×fc`, Zin.im / want.im, 1, 1e-6);
      }
    }

    // conical horn vs 400 short uniform tubes (independent method)
    {
      const s1 = 0.0012, s2 = 0.03, Lh = 0.9;
      const Hh = { s1, segments: [{ flare: 'con', len: Lh, s2 }], space: '2pi' };
      const zThroat = (useHorn, f) => {
        const net = new GL.Network();
        const a = net.node('a');
        let b;
        if (useHorn) { b = net.node('b'); net.add(GL.el.horn(a, b, E.hornSegments(Hh)[0])); }
        else {
          let prev = a; const N = 400;
          for (let i = 0; i < N; i++) {
            const r = Math.sqrt(s1 / Math.PI) + (Math.sqrt(s2 / Math.PI) - Math.sqrt(s1 / Math.PI)) * (i + 0.5) / N;
            const nx = net.node('n' + i);
            net.add(GL.el.tube(prev, nx, Math.PI * r * r, Lh / N, () => ({ alpha: 3e-5 * Math.sqrt(f) / r, cs: ph.c })));
            prev = nx;
          }
          b = prev;
        }
        net.add(GL.el.pistonMouth(b, s2, 2 * Math.PI));
        net.add({ stamp(st) { st.inj(a, X.C(1e-4)); } });
        return X.cabs(net.solve(2 * Math.PI * f)[a]) / 1e-4;
      };
      for (const f of [100, 400, 1000]) near(`conical horn: throat |Z| at ${f} Hz vs 400-step tube`, zThroat(true, f) / zThroat(false, f), 1, 0.02);
    }

    // design from cutoff
    const seg = E.hornFromCutoff(100, 0.001, 0.04, 'exp');
    near('horn from cutoff: exponential section has that cutoff', E.makeSection(0.001, 0.04, seg.len, 'exp').fc, 100, 1e-9);
    const segH = E.hornFromCutoff(100, 0.001, 0.04, 'hyp', 0.6);
    near('horn from cutoff: hyperbolic section has that cutoff', E.makeSection(0.001, 0.04, segH.len, 'hyp', 0.6).fc, 100, 1e-6);
    truthy('hyperbolic (T<1) horn is longer than exponential for the same areas', segH.len > seg.len, `${segH.len.toFixed(3)} vs ${seg.len.toFixed(3)} m`);

    // full designs with a generic 2" full-range driver, 20 Hz - 20 kHz
    const fr = D.complete({ fs: 120, qes: 0.6, qms: 3, vas: 0.00025, sd: 0.00125, re: 3.5, le: 0.00005, xmax: 0.002, pe: 10, znom: 4 });
    for (const type of ['blh', 'flh', 'th']) {
      const d = E.makeDesign(type, fr, 1);
      const t0 = performance.now();
      const r = run(d, fr, 2.83, 20, 20000, 480);
      const ms = performance.now() - t0;
      truthy(`${type}: 480-point sweep to 20 kHz runs cleanly`, Array.from(r.spl).every(isFinite) && ms < 1500, `${ms.toFixed(0)} ms, SPL ${Math.min(...r.spl).toFixed(0)}–${Math.max(...r.spl).toFixed(0)} dB`);
    }
  }

  // ---- passive radiator: excursion minimum at prFb ----
  {
    const d = lossless(E.makeDesign('pr', ideal, 1));
    const fb = E.prFb(d.prs[0], d.chambers[0].vol);
    // excursion keeps falling above the band, so look for the dip near the tuning only
    const r = run(d, ideal, 2.83, fb / 2, fb * 2, 4000);
    near('PR: cone excursion minimum at PR tuning (Hz)', r.f[argmin(r.xpk)], fb, fb * 0.01);
    const m = E.addedForFb(d.prs[0], d.chambers[0].vol, 22);
    const pr = Object.assign({}, d.prs[0], { added: m });
    near('PR: added mass for target tuning round trip', E.prFb(pr, d.chambers[0].vol), 22, 1e-9);
  }

  // ---- bandpass sanity: a peak with roll-off on both sides ----
  for (const type of ['bp4', 'bp6p', 'bp6s', 'bp8']) {
    const r = run(E.makeDesign(type, dc, 1), dc, 2.83, 10, 1000, 400);
    const i = argmax(r.spl);
    truthy(type + ': band-limited response', r.spl[i] - r.spl[0] > 10 && r.spl[i] - r.spl[r.spl.length - 1] > 10,
      `peak ${r.spl[i].toFixed(1)} dB at ${r.f[i].toFixed(0)} Hz; ends ${r.spl[0].toFixed(1)} / ${r.spl[r.spl.length - 1].toFixed(1)} dB`);
  }

  // ---- tube: closed-open quarter-wave resonance ----
  {
    const net = new GL.Network();
    const N = 60, L = 1.5, S = 0.01;
    const nodes = [];
    for (let i = 0; i <= N; i++) nodes.push(net.node('n' + i));
    for (let i = 0; i < N; i++) net.add(GL.el.tube(nodes[i], nodes[i + 1], S, L / N, () => ({ alpha: 0.002, cs: GL.phys.c })));
    net.add(GL.el.mouth(nodes[N], S, false));
    net.add({ stamp(st) { st.inj(nodes[0], GL.cx.C(1e-3)); } });
    const fs = GL.util.logspace(20, 150, 3000);
    const mag = Array.from(fs, f => GL.cx.cabs(net.solve(2 * Math.PI * f)[nodes[0]]));
    const want = GL.phys.c / (4 * (L + 0.6133 * Math.sqrt(S / Math.PI)));
    near('tube: closed-end pressure peak at c/4(L+δ) (Hz)', fs[argmax(mag)], want, want * 0.01);
    const qw = E.quarterWave({ shape: 'round', d0: 0.1128, dL: Math.sqrt(4 * S / Math.PI), length: L, mouthFlanged: false }, 1)[0];
    near('quarterWave() helper agrees', qw, want, 0.01);
  }

  // ---- geometry: true internal volume ----
  {
    const box = G.defaultBox();
    box.t = 0.5 * IN; box.layers = 1;
    box.ext = { W: 12 * IN, H: 12 * IN, D: 12 * IN };
    const d = { chambers: [{ id: 'A', name: 'Box', vol: 0, bracing: 0 }], ports: [], prs: [], mount: { rear: 'A', front: 'out' }, count: 1, driverDisp: 0 };
    const lay = G.layout(d, box);
    near('12" cube of ½" ply = 11×11×11 = 1331 in³', lay.intVol / Math.pow(IN, 3), 1331, 1e-6);
    box.layers = 2;
    near('double baffle: 11×11×10.5 in³', G.layout(d, box).intVol / Math.pow(IN, 3), 11 * 11 * 10.5, 1e-6);
  }
  {
    const box = G.defaultBox();
    const d = { chambers: [{ id: 'R', name: 'R', vol: 0.03, bracing: 0 }, { id: 'F', name: 'F', vol: 0.02, bracing: 0.001 }],
      ports: [{ from: 'F', to: 'out', shape: 'round', d: 0.08, wall: 0.003, len: 0.3, count: 1 }], prs: [],
      mount: { rear: 'R', front: 'F' }, count: 1, driverDisp: 0.002 };
    let lay = G.layout(d, box);
    G.solveDims(box, lay.gross, 2, null);
    lay = G.layout(d, box);
    near('solveDims: internal volume = net + displacement', lay.intVol, 0.05 + 0.002 + 0.001 + Math.PI * 0.043 * 0.043 * 0.3, 1e-9);
    box.lock.D = true;
    const D0 = box.ext.D;
    box.ext.W = box.ext.W * 1.3;
    G.solveDims(box, lay.gross, 2, 'W');
    const lay2 = G.layout(d, box);
    near('solveDims: volume held after changing width', lay2.intVol, lay.intVol, 1e-9);
    near('solveDims: locked depth unchanged', box.ext.D, D0, 1e-12);
    near('chambers split by gross share', lay2.chambers[0].len * lay2.cross, lay2.chambers[0].gross, 1e-9);
  }

  // ---- port routing ----
  {
    const PL = GL.placement;
    const box = G.defaultBox();
    box.ext = { W: 16.87 * IN, H: 13.69 * IN, D: 12.42 * IN };
    const drvP = { dia: 0.209, sd: 0.0227 };
    const mk = (len, extra) => ({ chambers: [{ id: 'A', name: 'Box', vol: 0.0354, bracing: 0 }], prs: [], count: 1, driverDisp: 0,
      mount: { rear: 'A', front: 'out' },
      // routing from the front baffle (on "auto" a port that can't fit there would move to another wall)
      ports: [Object.assign({ from: 'A', to: 'out', shape: 'round', d: 3 * IN, wall: 0.25 * IN, len, count: 1, face: 'front' }, extra)] });
    const route = (d) => PL.plan(d, box, G.layout(d, box), drvP).ports[0].route;
    const total = (r) => r.legs.reduce((s, l) => s + l.len, 0);
    const reach = box.ext.D - box.t;
    let r = route(mk(reach - 3 * IN));
    truthy('routing: port with exactly one diameter of clearance runs straight', r.fits && r.bends === 0, 'bends ' + r.bends);
    r = route(mk(14.67 * IN));
    truthy('routing: 14.7" port in a 12.4" deep box takes one bend', r.fits && r.bends === 1, PL.describe(r, x => (x / IN).toFixed(2)));
    near('routing: centre-line length equals port length', total(r), 14.67 * IN, 1e-9);
    // open end at least one diameter from every wall
    const end = r.pts[r.pts.length - 1], dir = r.legs[r.legs.length - 1].dir;
    const lay = G.layout(mk(14.67 * IN), box);
    const x0 = -box.ext.W / 2 + box.t, x1 = box.ext.W / 2 - box.t;
    const gapAhead = dir[0] < 0 ? end[0] - x0 : dir[0] > 0 ? x1 - end[0] : dir[1] !== 0 ? (box.ext.H / 2 - box.t) - Math.abs(end[1]) : end[2] - (-box.ext.D / 2 + box.t);
    truthy('routing: open end has a port diameter of clear space ahead', gapAhead >= 3 * IN - 1e-6, (gapAhead / IN).toFixed(2) + ' in');
    // second leg passes behind the driver's motor, not through it
    const pd = PL.plan(mk(14.67 * IN), box, lay, drvP);
    const drv = pd.faces.A.items.find(i => i.type === 'drv');
    const backOfMotor = box.ext.D / 2 - pd.drv.depth;
    truthy('routing: bent leg clears the driver motor', r.legs[1].from[2] + r.R < backOfMotor || Math.abs(r.legs[1].from[0] - drv.x) > pd.drv.r, 'leg z ' + (r.legs[1].from[2] / IN).toFixed(2) + ', motor back ' + (backOfMotor / IN).toFixed(2));
    r = route(mk(20 * IN));
    truthy('routing: 20" port fits with two bends', r.fits && r.bends === 2, PL.describe(r, x => (x / IN).toFixed(2)));
    r = route(mk(30 * IN));
    truthy('routing: 30" port is reported as not fitting', !r.fits && r.short > 0, 'short ' + (r.short / IN).toFixed(2) + ' in');
    r = route(mk(14.67 * IN, { bends: 'none' }));
    truthy('routing: bends off means straight only', !r.fits && r.bends === 0, '');
    near('routing: shortfall when straight = length + diameter - depth', r.short, 14.67 * IN + 3 * IN - reach, 1e-9);
    const sl = route(mk(16 * IN, { shape: 'slot', w: 2 * IN, h: 10 * IN }));
    truthy('routing: long slot folds along the back wall', sl.fits && sl.bends === 1, PL.describe(sl, x => (x / IN).toFixed(2)));
    near('routing: folded slot centre line adds up', sl.leg1 + sl.rem, 16 * IN, 1e-9);
  }

  // ---- divider port routing (bandpass) ----
  {
    const PL = GL.placement;
    const d = E.makeDesign('bp8', D.complete(grs.params), 1);
    // the cone fires into F: give it room for a port to turn in front of the cone (the default is
    // only 3.6 in deep, too shallow for a 3 in tube plus the clear zone in front of the cone)
    d.chambers.find(c => c.id === 'F').vol *= 2;
    const box = G.defaultBox();
    let lay = G.layout(d, box);
    G.solveDims(box, lay.gross, d.chambers.length, null);
    lay = G.layout(d, box);
    const pl = PL.plan(d, box, lay, grs.params);
    const inner = pl.ports.find(p => p.pt.to !== 'out').route;
    const innerPt = d.ports.find(p => p.to !== 'out');
    const chLen = lay.chambers.find(c => c.id === innerPt.from).len;
    truthy('divider: inner port longer than its chamber is routed with bends', inner.fits && inner.bends > 0 && innerPt.len > chLen, PL.describe(inner, x => (x / IN).toFixed(2)));
    near('divider: centre-line length equals port length', inner.legs.reduce((s, l) => s + l.len, 0), innerPt.len, 1e-9);
    truthy('divider: first leg runs along the split axis', inner.legs[0].dir[box.split === 'W' ? 0 : 1] !== 0, JSON.stringify(inner.legs[0].dir));
    truthy('divider: driver sits on the divider', pl.drivers.length === 1 && !pl.drivers[0].front, '');
    // the port is aimed straight at the cone: it must turn before the clear zone in front of it
    const dv = pl.drivers[0], zone = Math.max(0.03, 0.25 * pl.drv.r);
    const overCone = inner.pts.some((P, i) => i && [0, 0.25, 0.5, 0.75, 1].some(f => {
      const Q = P.map((v, m) => inner.pts[i - 1][m] + (v - inner.pts[i - 1][m]) * f), w = Q.map((v, m) => v - dv.pos[m]);
      const s2 = w[0] * dv.dir[0] + w[1] * dv.dir[1] + w[2] * dv.dir[2];
      return s2 >= 0 && s2 < zone + inner.R - 1e-4 && Math.hypot(w[0] - dv.dir[0] * s2, w[1] - dv.dir[1] * s2, w[2] - dv.dir[2] * s2) < dv.r + inner.R;
    }));
    truthy('divider: port keeps clear of the cone it faces', !overCone, '');
    // same port as a full-span slot against the bottom panel
    Object.assign(innerPt, { shape: 'slot', w: 1.5 * IN, h: 0.1, alongWall: true, fullHeight: true, wallSide: 'bottom' });
    const sl = PL.plan(d, box, lay, grs.params).ports.find(p => p.pt === innerPt).route;
    near('divider: full-span slot spans the inside depth', sl.fullSpan, box.ext.D - box.t * (1 + box.layers), 1e-9);
    truthy('divider: long slot folds along the far divider', sl.fits && sl.bends >= 1 && sl.far === 'divider', PL.describe(sl, x => (x / IN).toFixed(2)));
  }

  // ---- port noise and braces ----
  {
    const lim = E.portSpeedLimits({ shape: 'round', d: 0.1, flareOut: 0, flareIn: 0 });
    near('noise: straight port quiet limit 17 m/s', lim.quiet, 17, 1e-9);
    near('noise: full round-over both ends raises the limit by 8 m/s', E.portSpeedLimits({ shape: 'round', d: 0.1, flareOut: 0.05, flareIn: 0.06 }).quiet, 25, 1e-9);
    const pt = { shape: 'round', d: 3 * IN, len: 0.37, count: 1, end: 'flanged-free', flareOut: 0, flareIn: 0 };
    const q = E.quietSize(pt, 0.0354, 30, 34, 17);
    near('noise: quiet size doubles the area for half the speed', E.portArea(q) / E.portArea(pt), 2, 1e-9);
    near('noise: quiet size keeps the tuning', E.portFb(q, 0.0354), 30, 1e-6);
    // full-power speed = speed at the test drive x the max-SPL scale (no air limit)
    const d = E.makeDesign('ported', dc, 1);
    const m = E.buildModel(d, dc, () => GL.cx.C(2.83));
    const r = GL.sweep(m, GL.util.logspace(10, 200, 60), { volts: 2.83 });
    const i = 20;
    near('noise: full-power air speed scales with max SPL headroom', r.portVel[0].full[i], r.portVel[0].v[i] * Math.pow(10, (r.maxSpl[i] - r.spl[i]) / 20), 1e-9);

    const box = G.defaultBox();
    const sb = { chambers: [{ id: 'A', name: 'Box', vol: 0.03, bracing: 0, braces: { kind: 'window', count: 2, rim: 1.5 * IN, dia: IN, axis: 'W' } }],
      ports: [], prs: [], mount: { rear: 'A', front: 'out' }, count: 1, driverDisp: 0 };
    let lay = G.layout(sb, box);
    for (let it = 0; it < 6; it++) { G.solveDims(box, lay.gross, 1, null); lay = G.layout(sb, box); }
    const sz = { x: lay.int.W, y: lay.int.H };
    const want = 2 * (sz.x * sz.y - (sz.x - 3 * IN) * (sz.y - 3 * IN)) * box.t;
    near('braces: window brace volume = frame area x thickness x count', lay.chambers[0].disp.braces, want, 1e-7);
    near('braces: box grows so the net volume holds', lay.intVol, 0.03 + want, 1e-6);
    truthy('braces: window braces in the cut list with their opening', lay.panels.list.some(r => r.name === 'Window brace' && r.qty === 2 && r.opening), '');
    sb.chambers[0].braces = { kind: 'dowel', count: 3, rim: 0, dia: IN, axis: 'W' };
    lay = G.layout(sb, box);
    near('braces: dowel volume', lay.chambers[0].disp.braces, 3 * Math.PI * (IN / 2) ** 2 * lay.int.W, 1e-7);
    const pl = GL.placement.plan(sb, box, lay, grs.params);
    truthy('braces: three dowels placed', pl.braces[0].solids.length === 3, '');
  }

  // ---- slot folds ----
  {
    const PL = GL.placement;
    const box = G.defaultBox();
    box.ext = { W: 18.45 * IN, H: 14.95 * IN, D: 13.56 * IN };
    const mk = (len, w) => ({ chambers: [{ id: 'A', name: 'Box', vol: 0.0354, bracing: 0 }], prs: [], count: 1, driverDisp: 0,
      mount: { rear: 'A', front: 'out' },
      ports: [{ name: 'Port', from: 'A', to: 'out', shape: 'slot', w: w * IN, h: 12 * IN, len: len * IN, count: 1, alongWall: true, fullHeight: true }] });
    const route = (d) => PL.plan(d, box, G.layout(d, box), grs.params).ports[0].route;
    const sum = (r) => r.segs.reduce((s, x) => s + x.len, 0);
    let r = route(mk(36.71, 1.25));
    truthy('slot: 36.7" slot in an 18.5 x 13.6" box fits with two folds', r.fits && r.bends === 2, PL.describe(r, x => (x / IN).toFixed(2)));
    near('slot: two-fold centre line adds up', sum(r), 36.71 * IN, 1e-9);
    // the open end faces the baffle with a slot width of room
    const last = r.segs[r.segs.length - 1].len, A = box.ext.D - box.t;
    truthy('slot: two-fold open end clear of the baffle', (A - 0.625 * IN) - last >= box.t + 1.25 * IN - 1e-9, ((A - 0.625 * IN - last) / IN).toFixed(2) + ' in from the face');
    r = route(mk(60, 1.25));
    truthy('slot: 60" slot does not fit', !r.fits && r.short > 0, 'short ' + (r.short / IN).toFixed(2));
    // a U fits where the wrap would hit a driver: narrow box, port short enough for a U
    r = route(mk(22, 1.0));
    truthy('slot: 22" slot fits with at most two folds', r.fits && r.bends <= 2, PL.describe(r, x => (x / IN).toFixed(2)));
  }

  // ---- rounded slot folds ----
  {
    const PL = GL.placement;
    const box = G.defaultBox();
    box.ext = { W: 18.45 * IN, H: 14.95 * IN, D: 13.56 * IN };
    const mk = (extra) => ({ chambers: [{ id: 'A', name: 'Box', vol: 0.0354, bracing: 0 }], prs: [], count: 1, driverDisp: 0,
      mount: { rear: 'A', front: 'out' },
      ports: [Object.assign({ name: 'Port', from: 'A', to: 'out', shape: 'slot', w: 1.25 * IN, h: 12 * IN, len: 36.71 * IN, count: 1, alongWall: true, fullHeight: true }, extra)] });
    const route = (d) => PL.plan(d, box, G.layout(d, box), grs.params).ports[0].route;
    const sharp = route(mk({}));
    const round = route(mk({ foldR: 0.5 * IN, foldFill: true }));
    const sum = (r) => r.segs.reduce((s, x) => s + x.len, 0);
    const per = (2 - Math.PI / 2) * (0.5 * IN + 0.625 * IN);
    near('rounded folds: runs add the arc saving at each corner', sum(round) - sum(sharp), round.corners * per, 1e-9);
    truthy('rounded folds: fillet blocks listed, one per outer corner', round.panels.some(p => p.fillet && p.qty === round.corners && Math.abs(p.b - 1.75 * IN) < 1e-9), '');
    truthy('rounded folds: return wall listed by its length, not its thickness', round.panels.filter(p => / return wall$/.test(p.name)).every(p => p.a > box.t * 2), '');
    truthy('rounded folds: 3D outlines include the fillets', round.pieces.length >= round.panels.filter(p => !p.fillet).length + round.corners, round.pieces.length + ' pieces');
  }

  // ---- slot end round-overs ----
  {
    const base = { shape: 'slot', w: 1.25 * IN, h: 14 * IN, len: 0.9, count: 1, end: 'flanged-free', alongWall: true, fullHeight: true };
    const vol = 0.0354;
    const sq = Object.assign({}, base), rd = Object.assign({}, base, { slotOut: 0.5 * IN, slotIn: 0.5 * IN });
    // square ends: same end correction as before (image method only)
    const S = base.w * base.h, [ko, ki] = E.END_CORR['flanged-free'].k;
    near('slot ends: square ends unchanged', E.portEnd(sq), ko * Math.sqrt(S / Math.PI) + ki * Math.sqrt(S * 4 / Math.PI), 1e-12);
    const Lsq = E.lenForFb(sq, vol, 30), Lrd = E.lenForFb(rd, vol, 30);
    truthy('slot ends: rounded ends need a longer slot for the same tuning', Lrd > Lsq && Lrd - Lsq < 1.0 * IN, ((Lrd - Lsq) / IN).toFixed(3) + ' in longer');
    rd.len = Lrd;
    near('slot ends: tuning holds after the length change', E.portFb(rd, vol), 30, 1e-6);
    near('slot ends: round-overs raise the quiet limit', E.portSpeedLimits(rd).quiet, 17 + 8 * 0.8, 1e-9);
    // a tiny round-over is almost a square end
    const tiny = Object.assign({}, base, { slotOut: 1e-5, slotIn: 1e-5 });
    near('slot ends: tiny round-over is continuous with square', E.portEnd(tiny), E.portEnd(sq), 1e-4);
  }

  // ---- isobaric ----
  {
    const p = grs.params;
    const one = D.complete(p), pairS = D.complete(D.isobaric(p, 'series')), pairP = D.complete(D.isobaric(p, 'parallel'));
    near('isobaric: Vas halves', pairS.params.vas, p.vas / 2, 1e-12);
    near('isobaric: Fs unchanged', pairS.params.fs, p.fs, 1e-9);
    near('isobaric: Qts unchanged', pairS.derived.qts || pairS.params.qts, one.derived.qts || one.params.qts, 1e-9);
    near('isobaric: moving mass doubles', pairS.model.Mms, 2 * one.model.Mms, 1e-9);
    near('isobaric series: Re doubles, BL doubles', pairS.model.Re / one.model.Re + pairS.model.BL / one.model.BL, 4, 1e-6);
    near('isobaric parallel: Re halves, BL same', pairP.model.Re / one.model.Re + pairP.model.BL / one.model.BL, 1.5, 1e-6);
    // same sealed alignment in half the box
    const d1 = E.makeDesign('sealed', one, 1), d2 = E.makeDesign('sealed', pairS, 1);
    d2.chambers[0].vol = d1.chambers[0].vol / 2;
    const r1 = run(d1, one, 2.83, 10, 200, 60), r2 = run(d2, pairS, 2 * 2.83, 10, 200, 60);
    near('isobaric: half-size box, same response shape (2x volts in series)', r2.spl[10] - r2.spl[59], r1.spl[10] - r1.spl[59], 0.05);
  }

  // ---- optimizer ----
  {
    const dc1 = D.complete(grs.params);
    const o = { dc: dc1, count: 1, wiring: 'parallel', iso: null, volts: 2.83, per: 2.83, vmaxAir: 34, goal: 'small', target: 45, vmax: 0, ripple: 2, top: 80,
      portLimit: 25, fs: dc1.params.fs, refLevel: dc1.derived.spl1w + 20 * Math.log10(2.83 / Math.sqrt(dc1.model.Re)), portShape: 'round',
      freqs: GL.util.logspace(8, 250, 90) };
    const big = GL.optimize.evaluate('sealed', [0.05], [], o);
    truthy('optimizer: sealed F3 measured', big.f3 > 30 && big.f3 < 60, (big.f3 || 0).toFixed(1) + ' Hz');
    const p = GL.optimize.evaluate('ported', [0.03], [30], o);
    truthy('optimizer: ported port sized for the air limit', p.vFull <= 25 * 1.06, p.vFull.toFixed(1) + ' m/s');
    near('optimizer: ported keeps its tuning', E.portFb(p.design.ports[0], 0.03), 30, 1e-6);
  }

  // ---- manifold ----
  {
    const dc2 = D.complete(grs.params);
    const m = E.makeDesign('manifold', dc2, 2), b = E.makeDesign('bp4', dc2, 2);
    m.chambers.find(c => c.id === 'R1').vol = 0.012; m.chambers.find(c => c.id === 'R2').vol = 0.012; m.chambers.find(c => c.id === 'F').vol = 0.01;
    b.chambers.find(c => c.id === 'R').vol = 0.024; b.chambers.find(c => c.id === 'F').vol = 0.01;
    for (const d of [m, b]) { d.ports[0].len = 0.3; d.ports[0].d = 0.075; }
    const rm = run(m, dc2, 2.83, 10, 300, 80), rb = run(b, dc2, 2.83, 10, 300, 80);
    near('manifold: same response as a 4th-order bandpass with the rear volume combined', Math.max(...rm.spl.map((v, i) => Math.abs(v - rb.spl[i]))), 0, 1e-9);
    near('manifold: same impedance', Math.max(...rm.zmag.map((v, i) => Math.abs(v - rb.zmag[i]))), 0, 1e-9);
    const box = G.defaultBox();
    m.driverDisp = 0.002;
    const lay = G.layout(m, box);
    near('manifold: driver displacement split over both rear chambers', lay.chambers.find(c => c.id === 'R1').disp.driver, 0.002, 1e-12);
    truthy('manifold: the manifold sits between the two rear chambers', lay.chambers.map(c => c.id).join() === 'R1,F,R2', lay.chambers.map(c => c.id).join());
    const pl = GL.placement.plan(m, box, lay, grs.params);
    const dirs = pl.drivers.map(d => d.dir[0]);
    truthy('manifold: one driver on each divider, facing each other', pl.drivers.length === 2 && dirs[0] === -dirs[1] && pl.drivers.every(d => !d.front), JSON.stringify(dirs));
  }

  // ---- through-chamber slot, 6th-order search ----
  {
    const dc1 = D.complete(grs.params);
    const d = E.makeDesign('bp4', dc1, 1);
    d.chambers.find(c => c.id === 'R').vol = 0.319 * 0.0283168;
    d.chambers.find(c => c.id === 'F').vol = 0.209 * 0.0283168;
    Object.assign(d.ports[0], { shape: 'slot', w: 0.5 * IN, h: 9 * IN, len: 23.2 * IN, alongWall: true, fullHeight: true, via: 'R' });
    const box = G.defaultBox();
    let lay = G.layout(d, box);
    G.applyRatio(box, lay.gross, lay.n, { W: 1.25, H: 1, D: 0.9 });
    box.ext.D = 12 * IN; box.lock = { W: false, H: false, D: true };
    G.solveDims(box, G.layout(d, box).gross, 2, null);
    lay = G.layout(d, box);
    const pl = GL.placement.plan(d, box, lay, grs.params);
    const r = pl.ports[0].route;
    truthy('via slot: routes through the sealed chamber into the ported one', r.fits && r.via === 'R' && r.bends >= 1, GL.placement.describe(r, x => (x / IN).toFixed(2)));
    near('via slot: centre line adds up', r.segs.reduce((s, x) => s + x.len, 0), 23.2 * IN, 1e-9);
    // the driver on the divider moved forward, clear of the duct
    const drv = pl.drivers[0];
    truthy('via slot: driver frame stays in front of the duct', drv.pos[2] - pl.drv.r > -box.ext.D / 2 + box.t + 0.5 * IN + box.t, (drv.pos[2] / IN).toFixed(2));
    truthy('via slot: some of its volume is charged to the sealed chamber', r.viaShare > 0.3 && r.viaShare < 1, r.viaShare.toFixed(2));
    d.ports[0].viaShare = r.viaShare;
    const disp = G.displacements(d, box);
    near('via slot: displacement split adds up', disp.R.ports + disp.F.ports, E.portDisplacement(d.ports[0], box.t), 1e-12);
    // a slot too short to reach the far chamber is reported as such
    d.ports[0].len = 5 * IN;
    const r2 = GL.placement.plan(d, box, G.layout(d, box), grs.params).ports[0].route;
    truthy('via slot: too short to reach is reported', !r2.fits && r2.tooShort, '');
    // 6th-order bandpass measure: a mid-band dip counts as sag
    const f = GL.util.logspace(10, 200, 50), spl = f.map(x => 90 - 2 * Math.exp(-Math.pow(Math.log(x / 50), 2) / 0.05) + (x < 25 ? -40 * Math.log10(25 / x) : 0) + (x > 120 ? -40 * Math.log10(x / 120) : 0));
    const m = GL.optimize.measure({ f, spl }, 'bp6p', { top: 100 });
    truthy('optimizer: bandpass sag is measured', m.ripple > 1, m.ripple.toFixed(1) + ' dB');
  }

  // ---- OpenISD catalogue ----
  if (GL.catalogue) {
    const cat = GL.catalogue;
    truthy('catalogue: loaded with drivers and passive radiators', cat.drivers.length > 1500 && cat.prs.length > 50, cat.drivers.length + ' drivers, ' + cat.prs.length + ' PRs');
    const g = cat.drivers.find(d => d.id === 'grs/8sw-4he');
    near('catalogue: GRS 8SW-4HE Fs agrees with its WinISD file (within 1%)', g.p.fs / grs.params.fs, 1, 0.01);
    near('catalogue: GRS 8SW-4HE Vas agrees with its WinISD file', g.p.vas / grs.params.vas, 1, 0.01);
    // every driver must simulate: complete() gives finite T/S and a sensible Qts
    let bad = [];
    for (const d of cat.drivers) {
      try {
        const c = D.complete(Object.assign({}, d.p));
        const q = c.derived.qts || c.params.qts;
        if (!(isFinite(c.model.BL) && c.model.BL > 0 && isFinite(c.model.Mms) && q > 0.05 && q < 5)) bad.push(d.id);
      } catch (e) { bad.push(d.id + ' (' + e.message + ')'); }
    }
    truthy('catalogue: every driver gives a usable model', bad.length === 0, bad.slice(0, 5).join(', ') + (bad.length > 5 ? ' …' : ''));
    const dvc = cat.drivers.filter(d => d.vc);
    truthy('catalogue: dual-coil drivers say how specs were published', dvc.length > 20 && dvc.every(d => ['series', 'parallel', 'single'].includes(d.vc.published)), dvc.length + ' DVC');
    const rss = cat.drivers.find(d => /RSS265HO-44/.test(d.model));
    truthy('catalogue: parallel-published DVC recognised (RSS265HO-44, Re 1.6 at 4 ohm per coil)', rss && rss.vc.published === 'parallel', rss ? JSON.stringify(rss.vc) : 'missing');
  }

  // ---- Parts Express extras (only when data/catalogue-pe.js was built) ----
  if (GL.catalogue && GL.catalogueExtra) {
    const cat = { drivers: [], prs: [] };
    GL.catalogueTools.mergePartsExpress(cat, GL.catalogueExtra);
    truthy('PE extras: drivers kept and some screened out', cat.pe.kept > 200 && cat.pe.skipped.length > 0, cat.pe.kept + ' kept, ' + cat.pe.skipped.length + ' left out, ' + cat.pe.fixed + ' corrected');
    let bad = [];
    for (const d of cat.drivers) {
      const c = D.complete(Object.assign({}, d.p));
      const q = c.derived.qts || c.params.qts;
      const v = GL.specparse.check(d.p).filter(n => n[0] === 'warn');
      if (!(c.model.BL > 0 && q > 0.05 && q < 10) || v.length) bad.push(d.brand + ' ' + d.model);   // tiny buyout speakers can have Qts ~5
    }
    truthy('PE extras: every kept driver simulates and passes the consistency checks', bad.length === 0, bad.slice(0, 4).join(', '));
    const frs = cat.drivers.find(d => d.model === 'FRS8M');
    truthy('PE extras: a tenfold Vas typo is corrected from Sd and Cms (Visaton FRS8M)', frs && Math.abs(frs.p.vas * 1000 - 1.1) < 0.15, frs ? (frs.p.vas * 1000).toFixed(2) + ' L' : 'missing');
    const none = cat.drivers.find(d => d.model === 'WS20E-4');
    truthy('PE extras: a page with only Fs is left out', !none, '');
    const ids = new Set(GL.catalogue.drivers.filter(d => d.src !== 'pe').map(d => (d.brand + d.model).toLowerCase().replace(/[^a-z0-9]/g, '')));
    const dup = cat.drivers.filter(d => ids.has((d.brand + d.model).toLowerCase().replace(/[^a-z0-9]/g, '')));
    truthy('PE extras: nothing duplicates an OpenISD driver', dup.length === 0, dup.slice(0, 3).map(d => d.model).join(', '));
  }

  // ---- measure your own T/S ----
  {
    const M = GL.measure, g = D.complete(grs.params).model;
    // exact free-air impedance (Le = 0) for a mechanical system with compliance C
    const zAt = (f, C, mass) => {
      const w = 2 * Math.PI * f, m = mass || g.Mms;
      const re = g.Rms, im = w * m - 1 / (w * C);
      const den = re * re + im * im;
      return Math.hypot(g.Re + g.BL * g.BL * re / den, -g.BL * g.BL * im / den);
    };
    // what a careful measurement would read: Fs, Zmax and the √(Re·Zmax) points
    const read = (C, mass) => {
      const f0 = 1 / (2 * Math.PI * Math.sqrt((mass || g.Mms) * C));
      const zmax = zAt(f0, C, mass), zt = Math.sqrt(g.Re * zmax);
      const find = (a, b) => { for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if ((zAt(m, C, mass) - zt) * (zAt(a, C, mass) - zt) > 0) a = m; else b = m; } return (a + b) / 2; };
      return { f0, zmax, f1: find(f0 / 4, f0), f2: find(f0, f0 * 4) };
    };
    const fa = read(g.Cms);
    const added = 0.05;                                         // 50 g of putty on the cone
    const r = M.solve({ method: 'added', re: g.Re, fs: fa.f0, zmax: fa.zmax, f1: fa.f1, f2: fa.f2, sd: g.Sd, added: { mass: added, fs2: read(g.Cms, g.Mms + added).f0 } });
    const one = D.complete(grs.params);
    near('measure: Qms from the impedance peak', r.qms / one.params.qms, 1, 0.005);
    near('measure: Qes from the impedance peak', r.qes / one.params.qes, 1, 0.005);
    near('measure: Mms from the added-mass shift', r.mms / g.Mms, 1, 0.005);
    near('measure: Vas from added mass and Sd', r.vas / one.params.vas, 1, 0.005);
    near('measure: BL', r.BL / g.BL, 1, 0.005);
    // sealed test box: compliance of the trapped air in series with the suspension
    const vb = 0.02, cab = vb / (GL.phys.rc2() * g.Sd * g.Sd), cBox = g.Cms * cab / (g.Cms + cab);
    const bx = read(cBox);
    const r2 = M.solve({ method: 'box', re: g.Re, fs: fa.f0, zmax: fa.zmax, f1: fa.f1, f2: fa.f2, sd: g.Sd, box: { vb, fc: bx.f0, zmax: bx.zmax, f1: bx.f1, f2: bx.f2 } });
    near('measure: Vas from a sealed test box', r2.vas / one.params.vas, 1, 0.01);
    near('measure: Mms from a sealed test box', r2.mms / g.Mms, 1, 0.01);
    near('measure: impedance from constant-current voltages', M.zFromVoltages(1000, 10, 0.05), 1000 * 0.05 / 9.95, 1e-12);
    truthy('measure: nonsense readings are flagged', !M.solve({ method: 'added', re: 4, fs: 30, zmax: 3, f1: 40, f2: 20, sd: 0.02, added: { mass: 0.01, fs2: 35 } }).ok, '');
  }

  // ---- slots keep clear of a driver on the divider ----
  {
    const p15 = { fs: 20.7, qes: 0.55, qms: 4.27, vas: 0.1966, sd: 0.08194, re: 4.2, le: 0.0037, xmax: 0.0123, pe: 300, BL: 16.6, Mms: 0.2838, Cms: 0.00021, dia: 0.38989, depth: 0.152 };
    const d = E.makeDesign('bp6p', D.complete(p15), 1);
    d.chambers.find(c => c.id === 'R').vol = 0.0691;
    d.chambers.find(c => c.id === 'F').vol = 0.0238;
    const rear = d.ports.find(x => x.from === 'R'), frontP = d.ports.find(x => x.from === 'F');
    Object.assign(rear, { shape: 'slot', w: 0.0254, h: 0.475, len: 1.1856, alongWall: true, fullHeight: true });
    Object.assign(frontP, { shape: 'slot', w: 0.027, h: 0.475, len: 0.3302, alongWall: true, fullHeight: true });
    const box = G.defaultBox();
    box.ext = { W: 0.6319, H: 0.5004, D: 0.4529 };
    const pl = GL.placement.plan(d, box, G.layout(d, box), p15);
    const r = pl.ports.find(x => x.pt === rear).route;
    truthy('driver clash: slot is not put against the divider carrying the driver', r.wall !== 'divider', r.wall);
    // nothing of any slot may sit inside a driver's basket
    const inDriver = (P) => pl.drivers.some(dv => {
      const a = dv.dir.map(v => -v), v = P.map((q, m) => q - dv.pos[m]), s2 = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
      return s2 > 0 && s2 < pl.drv.depth && Math.hypot(v[0] - a[0] * s2, v[1] - a[1] * s2, v[2] - a[2] * s2) < dv.r * (1 - 0.5 * s2 / pl.drv.depth) - 1e-3;
    });
    const hit = pl.ports.some(x => (x.route.blocks || []).some(([mn, mx]) => {
      for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) for (let k = 0; k <= 10; k++)
        if (inDriver([0, 1, 2].map(m => mn[m] + (mx[m] - mn[m]) * [i, j, k][m] / 10))) return true;
      return false;
    }));
    truthy('driver clash: no slot runs through the driver', !hit, '');
    truthy('driver clash: a 47 in slot that can\'t get past the driver is reported as not fitting', !r.fits, GL.placement.describe(r, x => (x / IN).toFixed(2)));
    // forced against the divider anyway: the first run hits the driver, so it can't fit
    rear.wallSide = 'right';
    const r2 = GL.placement.plan(d, box, G.layout(d, box), p15).ports.find(x => x.pt === rear).route;
    truthy('driver clash: a slot forced along the driver\'s divider does not fit', r2.wall === 'divider' && !r2.fits, '');
    // and on the cone side: a slot panel over the cone doesn't fit either
    rear.wallSide = null; frontP.wallSide = 'left';
    const r3 = GL.placement.plan(d, box, G.layout(d, box), p15).ports.find(x => x.pt === frontP).route;
    truthy('driver clash: a slot over the cone (cone side of the divider) does not fit', r3.wall === 'divider' && !r3.fits, r3.wall);
    frontP.wallSide = null;
    const r4 = GL.placement.plan(d, box, G.layout(d, box), p15).ports.find(x => x.pt === frontP).route;
    truthy('driver clash: left to itself the front slot avoids the divider', r4.wall !== 'divider', r4.wall);
  }

  // ---- a slot that doesn't fit on its usual wall tries the others ----
  {
    const d = E.makeDesign('ported', D.complete(grs.params), 1);
    Object.assign(d.ports[0], { shape: 'slot', w: 0.03, h: 0.1, len: 0.9, alongWall: true, fullHeight: true });
    const box = G.defaultBox(); box.ext = { W: 0.32, H: 0.6, D: 0.3 };      // tall and narrow: the long way is up
    const r = GL.placement.plan(d, box, G.layout(d, box), grs.params).ports[0].route;
    truthy('other walls: moves to a wall where it fits', r.fits && r.side !== 'right' && r.movedFrom === 'right wall', r.wall);
    d.ports[0].wallSide = 'right';
    const r2 = GL.placement.plan(d, box, G.layout(d, box), grs.params).ports[0].route;
    truthy('other walls: a wall you picked stays put', r2.side === 'right' && !r2.fits && !r2.movedFrom, '');
    d.ports[0].wallSide = null; d.ports[0].len = 0.25;
    const r3 = GL.placement.plan(d, box, G.layout(d, box), grs.params).ports[0].route;
    truthy('other walls: a slot that fits stays on the usual wall', r3.side === 'right' && r3.fits && !r3.movedFrom, '');
  }

  // ---- driver matcher ----
  {
    const M = GL.match, dc = D.complete(grs.params);
    const d = E.makeDesign('ported', dc, 1);
    d.chambers[0].vol = 0.035; d.driverDisp = 0.001;
    d.ports[0].fb = 30; d.ports[0].len = E.lenForFb(d.ports[0], 0.035, 30);
    // a driver with a bigger motor leaves less air in the box
    const sw = M.swapInto(d, Object.assign({}, grs.params, { dvol: 0.003 }));
    near('matcher: chamber loses the extra motor displacement', sw.chambers[0].vol, 0.035 - 0.002, 1e-12);
    near('matcher: port keeps its length', sw.ports[0].len, d.ports[0].len, 1e-12);
    // the same driver through the matcher gives the same curve as a direct simulation
    const freqs = GL.util.logspace(10, 200, 60);
    const o = { design: d, freqs, drive: { mode: 'volts', volts: 2.83 }, band: [25, 80], top: 80 };
    const r = M.tryDriver({ name: 'GRS', params: Object.assign({}, grs.params, { dvol: 0.001 }) }, o);
    const direct = GL.sweep(E.buildModel(d, dc, () => GL.cx.C(2.83)), freqs, { volts: 2.83, drive: 2.83, vmax: 0 });
    truthy('matcher: same driver, same response', r.res.spl.every((v, i) => Math.abs(v - direct.spl[i]) < 1e-9), '');
    // amplifier power is capped at the driver's rating
    const ra = M.tryDriver({ name: 'GRS', params: grs.params }, Object.assign({}, o, { drive: { mode: 'amp', watts: 5000 } }));
    near('matcher: power capped at the rating', ra.watts, dc.params.pe, 1e-9);
    // ranking: within the peaking limit first, then the goal
    const rows = [{ f3: 30, ripple: 0.5, out: 100 }, { f3: 22, ripple: 4, out: 104 }, { f3: 25, ripple: 1, out: 98 }];
    M.rank(rows, { goal: 'deep', ripple: 2 });
    truthy('matcher: deepest F3 within the peaking limit ranks first', rows[0].f3 === 25 && rows[2].ripple === 4, rows.map(x => x.f3).join(','));
    M.rank(rows, { goal: 'loud', ripple: 2 });
    truthy('matcher: most output ranks first for "loud"', rows[0].out === 100, '');
  }
  {
    // impedance filters
    const M = GL.match;
    const svc4 = { name: 'svc4', params: { znom: 4, re: 3.3 } };
    const svc8 = { name: 'svc8', params: { re: 6.4 } };                                   // no Znom: from Re
    const dvc2 = { name: 'dvc2', params: { znom: 4, re: 3.4 }, vc: { coils: 2, published: 'series' } };   // 2+2 published in series
    const dvc4 = { name: 'dvc4', params: { znom: 2, re: 1.7 }, vc: { coils: 2, published: 'parallel', perCoil: 4 } };
    truthy('impedance: per-coil ohms', [svc4, svc8, dvc2, dvc4].map(M.coilOhms).join() === '4,8,2,4', [svc4, svc8, dvc2, dvc4].map(M.coilOhms).join());
    near('impedance: DVC 2 Ω in parallel, two drivers in parallel = 0.5 Ω', M.ampLoad(dvc2, 'parallel', 2, 'parallel'), 0.5, 1e-12);
    near('impedance: DVC 4 Ω in series, one driver = 8 Ω', M.ampLoad(dvc4, 'series', 1, 'parallel'), 8, 1e-12);
    const all = [svc4, svc8, dvc2, dvc4];
    const names = (f, n = 1, w = 'parallel') => M.filterByImpedance(all, Object.assign({ ohms: 'any', coils: 'any', load: 'any' }, f), n, w).list.map(e => e.name + (e.wiring ? ':' + e.wiring : '')).join();
    truthy('impedance: 4 Ω coils', names({ ohms: '4' }) === 'svc4,dvc4', names({ ohms: '4' }));
    truthy('impedance: dual coil only', names({ coils: 'dvc' }) === 'dvc2,dvc4', names({ coils: 'dvc' }));
    truthy('impedance: 1 Ω at the amp picks the coil wiring', names({ load: '1' }) === 'dvc2:parallel', names({ load: '1' }));
    truthy('impedance: 4 Ω at the amp, one driver', names({ load: '4' }) === 'svc4,dvc2:series', names({ load: '4' }));
    truthy('impedance: 2 Ω at the amp, two drivers in parallel', names({ load: '2' }, 2) === 'svc4,dvc2:series', names({ load: '2' }, 2));
  }
  {
    // the full search: a too-big driver is skipped, the rest ranked
    const M = GL.match, dc = D.complete(grs.params);
    const d = E.makeDesign('ported', dc, 1);
    d.ports[0].len = E.lenForFb(d.ports[0], d.chambers[0].vol, 30);
    const big = Object.assign({}, grs.params, { dia: 0.4 });
    const soft = Object.assign({}, grs.params, { qms: grs.params.qms * 3 });
    asyncTests.push(M.run({ design: d, drivers: [{ name: 'GRS', params: grs.params }, { name: 'huge', params: big }, { name: 'soft', params: soft }],
      freqs: GL.util.logspace(10, 200, 60), drive: { mode: 'volts', volts: 2.83 }, band: [25, 80], top: 80, goal: 'deep', ripple: 6, maxDia: 0.3 })
      .then(res => {
        truthy('matcher: driver too big for the baffle is skipped', res.tooBig === 1 && res.rows.length === 2, res.tooBig + ' skipped');
        truthy('matcher: rows come ranked', res.rows[0].f3 <= res.rows[1].f3 || res.rows[1].ripple > 6, res.rows.map(x => x.entry.name + ' ' + (x.f3 || 0).toFixed(1)).join(', '));
      }));
  }

  // ---- baffle step, diffraction, directivity, compensation ----
  {
    const B = GL.baffle, X = GL.cx;
    const db = (z) => 20 * Math.log10(X.cabs(z));
    const W = 0.15, H = 0.13;
    const fld = B.makeField([{ pts: [[0, 0]], r: 0.03 }], { W, H, round: 0 }, 2);
    const at = (f, ang = 0, F = fld) => F(0, 2 * Math.PI * f, ang);
    near('baffle: full space below the step (-6 dB)', db(at(20)), -6.02, 0.3);
    // high up the edges average out: mean level back to half space
    const hi = GL.util.logspace(8000, 16000, 40).map(f => db(at(f)));
    near('baffle: half space well above the step', hi.reduce((a, b) => a + b, 0) / hi.length, 0, 1.2);
    // a round-over smooths the edge ripple around a few kHz
    const ripple = (F) => { const v = GL.util.logspace(1500, 6000, 60).map(f => db(at(f, 0, F))); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
    const rounded = B.makeField([{ pts: [[0, 0]], r: 0.03 }], { W, H, round: 0.03 }, 2);
    truthy('baffle: round-over reduces edge ripple', ripple(rounded) < ripple(fld), ripple(fld).toFixed(2) + ' → ' + ripple(rounded).toFixed(2) + ' dB');
    // in a wall: no step at all, only directivity
    const wall = B.makeField([{ pts: [[0, 0]], r: 0.03 }], null, 2);
    near('baffle: in a wall, on axis is unchanged', db(wall(0, 2 * Math.PI * 300, 0)), 0, 1e-9);
    near('directivity: rigid piston 2·J1(x)/x', B.piston(2.85, 1), 2 * GL.special.besselJ1(2.85) / 2.85, 1e-12);
    near('directivity: 3" piston, 30° off axis at 10 kHz', db(wall(0, 2 * Math.PI * 10000, Math.PI / 6)), 20 * Math.log10(Math.abs(B.piston(2 * Math.PI * 10000 / GL.phys.c * 0.03, 0.5))), 1e-9);
    // compensation network: full depth up high, half of it (in dB) at the step
    const bs = B.bscValues(4, 6, 1000), Z = B.bscZ(bs.L, bs.R);
    const att = (f) => 20 * Math.log10(X.cabs(X.cdiv(X.C(4), X.cadd(X.C(4), Z(2 * Math.PI * f)))));
    near('BSC: 6 dB shelf up high', att(50000), -6, 0.05);
    near('BSC: half the shelf at the step', att(1000), -3, 0.01);
    near('BSC: nothing in the bass', att(20), 0, 0.05);
  }
  // ---- L2R2 voice coil, and the sweep with a baffle ----
  {
    const pFR = { fs: 80, qts: 0.55, qms: 4, vas: 0.002, sd: 0.003, re: 3.9, le: 0.0004 };
    const d = E.makeDesign('sealed', D.complete(pFR), 1);
    d.chambers[0].vol = 0.0012;
    const fr = [30, 1000, 10000];
    const z = (p) => GL.sweep(E.buildModel(d, D.complete(p), () => GL.cx.C(2.83)), fr, { volts: 2.83, drive: 2.83 }).zmag;
    const plain = z(pFR), lossy = z(Object.assign({}, pFR, { l2: 0.0005, r2: 3 }));
    truthy('L2R2: adds impedance up high, not in the bass', lossy[2] > plain[2] + 0.5 && Math.abs(lossy[0] / plain[0] - 1) < 0.02, plain[2].toFixed(1) + ' → ' + lossy[2].toFixed(1) + ' Ω');
    const parsed = GL.specparse.parse('Re 3.9 ohm\nLe 0.4 mH\nL2 0.5 mH\nR2 3.0 ohm').params;
    truthy('L2R2: read from pasted specs', Math.abs(parsed.l2 - 0.0005) < 1e-9 && Math.abs(parsed.r2 - 3) < 1e-9 && Math.abs(parsed.le - 0.0004) < 1e-9, JSON.stringify([parsed.le, parsed.l2, parsed.r2]));
    // sweep with a field: the box-only curve stays the plain one
    const dc = D.complete(pFR), freqs = GL.util.logspace(50, 5000, 40);
    const mdl = () => E.buildModel(d, dc, () => GL.cx.C(2.83));
    const plainRes = GL.sweep(mdl(), freqs, { volts: 2.83, drive: 2.83 });
    const f2 = GL.baffle.makeField([{ pts: [[0, 0]], r: 0.03 }], { W: 0.15, H: 0.13, round: 0 }, 1);
    const withB = GL.sweep(mdl(), freqs, { volts: 2.83, drive: 2.83, field: f2, angles: [30] });
    truthy('baffle sweep: box-only curve unchanged', withB.splBox.every((v, i) => Math.abs(v - plainRes.spl[i]) < 1e-9), '');
    near('baffle sweep: 6 dB less at 50 Hz', withB.spl[0] - plainRes.spl[0], -6, 0.4);
    truthy('baffle sweep: off-axis curve computed', withB.offAxis.length === 1 && withB.offAxis[0].spl[39] < withB.spl[39], '');
  }
  // ---- panel resonance ----
  {
    const P = GL.panels;
    const w = P.wall('alu', 0.002);
    const Dk = 69e9 * 0.002 ** 3 / (12 * (1 - 0.33 * 0.33));
    near('panels: plate stiffness E·t³/12(1−ν²)', w.D, Dk, 1e-9);
    const f = P.plate(0.124, 0.103, w).lo;
    near('panels: 2 mm aluminium 124 × 103 mm, simply supported', f, Math.PI / 2 * (1 / 0.124 ** 2 + 1 / 0.103 ** 2) * Math.sqrt(Dk / (2700 * 0.002)), 1e-9);
    const solid = P.wall('pla', 0.004, { skin: 0.001, infill: 1 }), part = P.wall('pla', 0.004, { skin: 0.001, infill: 0.2 }), plain = P.wall('pla', 0.004);
    near('panels: 100% infill is a solid wall', solid.D, plain.D, 1e-9);
    truthy('panels: low infill is lighter and less stiff', part.D < solid.D && part.m < solid.m && part.D / part.m > 0.5 * solid.D / solid.m, '');
    const box = Object.assign(G.defaultBox(), { ext: { W: 0.4, H: 0.3, D: 0.3 }, t: 0.0127, sub: 'ply', split: 'W' });
    const d2 = E.makeDesign('bp4', D.complete(grs.params), 1);
    const lay = G.layout(d2, box);
    const sp = P.spans(box, lay);
    truthy('panels: two chambers give per-chamber walls and a divider', sp.some(p => p.name === 'Divider') && sp.filter(p => /^Back/.test(p.name)).length === 2, sp.map(p => p.name).join(', '));
    truthy('panels: aluminium rings, plywood does not', P.panelModes(Object.assign({}, box, { sub: 'alu', t: 0.002 }), lay, 20, 20000).some(p => p.rings) && !P.panelModes(box, lay, 20, 20000).some(p => p.rings), '');
  }

  // ---- line arrays (after Ureda, JAES 2004) ----
  {
    const LA = GL.linearray, c = GL.phys.c;
    const base = { n: 64, pitch: 0.0625, shape: 'straight', angle: 0, tilt: 0, steer: 0, shade: 'uniform', place: 'free', top: 4 };
    const els = LA.elements(base, 0.0005);                      // 4 m of near-point sources
    const L = 4, f = 4 * c / L, kL2 = Math.PI * f * L / c;      // L = 4λ
    const sinc = (a) => { const z = kL2 * Math.sin(a * Math.PI / 180); return Math.abs(z) < 1e-9 ? 1 : Math.abs(Math.sin(z) / z); };
    const R = LA.polar(els, f, [0, 5, 10, 20], 0.05);
    truthy('line array: straight line matches sin(z)/z', [0, 5, 10, 20].every((a, i) => Math.abs(R[i] - sinc(a)) < 0.02), R.map(v => v.toFixed(3)).join(' ') + ' vs ' + [0, 5, 10, 20].map(a => sinc(a).toFixed(3)).join(' '));
    const bw = LA.beamwidth(els, f, 0.05).width;
    near('line array: quarter-power angle 2·asin(0.6λ/L)', bw, 2 * Math.asin(1.895 / Math.PI * (c / f) / L) * 180 / Math.PI, 0.6);
    // an arc's coverage approaches its included angle at high frequency
    // (closely spaced, as a continuous arc: 2 m in 1 cm steps)
    const arc = LA.elements(Object.assign({}, base, { n: 200, pitch: 0.01, shape: 'arc', angle: 40 }), 0.0005);
    const abw = LA.beamwidth(arc, 6000, 0.05).width;
    truthy('line array: 40° arc covers about 40° up high', abw > 30 && abw < 48, abw.toFixed(1) + '°');
    // progressive splays add up to the terminal angle
    const sp = LA.splays({ n: 10, shape: 'progressive', angle: 45 });
    near('line array: progressive splays add up to the terminal angle', sp.reduce((a2, b) => a2 + b, 0), 45, 1e-9);
    truthy('line array: progressive splays grow down the array', sp.every((v, i) => !i || v > sp[i - 1]), sp.map(v => v.toFixed(2)).join(' '));
    // electronic tilt steers the beam
    const st = LA.elements(Object.assign({}, base, { n: 16, pitch: 0.1, steer: 10 }), 0.0005);
    near('line array: delays steer the beam to 10°', LA.beamwidth(st, 2000, 0.05).aim, 10, 1);
    // floor reflection = the array plus its mirror image
    const small = Object.assign({}, base, { n: 4, pitch: 0.1, top: 1.2 });
    const e4 = LA.elements(small, 0.03);
    const withFloor = LA.pressureAt(e4, LA.images(Object.assign({}, small, { place: 'floor' })), 1000, 3, 1, 0.05);
    const mirror = e4.concat(e4.map(e => Object.assign({}, e, { y: -e.y, aim: -e.aim })));
    const byHand = LA.pressureAt(mirror, [{ s: 1, o: 0, g: 1 }], 1000, 3, 1, 0.05);
    truthy('line array: floor reflection is the mirror image', Math.abs(withFloor.re - byHand.re) < 1e-9 && Math.abs(withFloor.im - byHand.im) < 1e-9, '');
    // CBT taper: full in the middle, about 0.13 at the ends
    const cbt = LA.elements(Object.assign({}, base, { n: 9, shade: 'legendre' }), 0.03);
    truthy('line array: Legendre taper 1 → 0.126', Math.abs(cbt[4].w - 1) < 1e-9 && Math.abs(cbt[0].w - 0.1262) < 1e-3, cbt.map(e => e.w.toFixed(2)).join(' '));
    const lim = LA.limits({ n: 8, pitch: 0.1 }, 0.08);
    near('line array: grating lobes above c / pitch', lim.grating, c / 0.1, 1e-9);
    near('line array: near field at 4 kHz, 0.8 m (Heil)', lim.near(4000), 1.5 * 4 * 0.64 * Math.sqrt(1 - 1 / (3 * 4 * 0.8) ** 2), 1e-9);
  }

  // ---- cone breakup ----
  {
    const B = GL.breakup, X = GL.cx;
    const est = B.estimate(0.00302, 'paper');                  // a 3" full-range
    truthy('breakup: 3" paper cone estimated around 8–10 kHz', est.f > 8000 && est.f < 10000, est.f + ' Hz');
    truthy('breakup: metal peaks higher and sharper than paper', B.CONES.alu.db > B.CONES.paper.db && B.CONES.alu.q > B.CONES.paper.q, '');
    const bu = { f: 5000, db: 10, q: 8 };
    const at = (f) => 20 * Math.log10(X.cabs(B.H(2 * Math.PI * f, bu)));
    near('breakup: peak height at the breakup frequency (less the start of the roll-off)', at(5000), 10 + 20 * Math.log10(1 / Math.hypot(1, 0.5)), 0.05);
    near('breakup: nothing well below it', at(500), 0, 0.1);
    truthy('breakup: falls away above it', at(20000) < at(5000) - 15, at(20000).toFixed(1) + ' dB');
    near('breakup: full cone radiates below breakup', B.radius(0.03, 2000, bu), 0.03, 1e-12);
    near('breakup: only the middle radiates above it', B.radius(0.03, 20000, bu), 0.03 * Math.sqrt(5000 / 20000), 1e-12);
    // a breaking-up cone beams less than a rigid one of the same size
    const LA = GL.linearray;
    const one = (r) => [{ x: 0, y: 0, aim: 0, r, w: 1, tau: 0 }];
    const rigid = LA.beamwidth(one(0.05), 12000, 0.05).width, flexing = LA.beamwidth(one((f) => B.radius(0.05, f, { f: 3000 })), 12000, 0.05).width;
    truthy('breakup: wider dispersion than a rigid piston up high', flexing > rigid * 1.3, rigid.toFixed(1) + '° → ' + flexing.toFixed(1) + '°');
  }
  // ---- tweeter line ----
  {
    const LA = GL.linearray;
    const main = LA.elements({ n: 8, pitch: 0.13, shape: 'straight', tilt: 0, steer: 0, shade: 'uniform', place: 'free', top: 2 }, 0.03);
    const tw = LA.tweeterElements(main, 0.13, { n: 20, pitch: 0.052, type: 'dome', size: 0.025 });
    const cy = (els) => els.reduce((s2, e) => s2 + e.y, 0) / els.length;
    truthy('tweeter line: count and centred on the main line', tw.length === 20 && Math.abs(cy(tw) - cy(main)) < 1e-9, cy(tw).toFixed(4) + ' vs ' + cy(main).toFixed(4));
    near('tweeter line: pitch kept', tw[0].y - tw[1].y, 0.052, 1e-9);
    const arc = LA.elements({ n: 8, pitch: 0.13, shape: 'arc', angle: 21, tilt: 0, steer: 0, shade: 'uniform', place: 'free', top: 2 }, 0.03);
    const twA = LA.tweeterElements(arc, 0.13, { n: 20, pitch: 0.052, type: 'dome', size: 0.025 });
    truthy('tweeter line: follows the curve (aims spread like the main line)', twA[0].aim < twA[19].aim && twA[19].aim <= arc[7].aim + 1e-9 && twA[0].x > twA[19].x, (twA[0].aim * 180 / Math.PI).toFixed(1) + '° → ' + (twA[19].aim * 180 / Math.PI).toFixed(1) + '°');
    // a ribbon is a tall strip: sin x / x vertically
    const k = 2 * Math.PI * 10000 / GL.phys.c, h2 = 0.1;
    const rib = { r: 0, rect: h2 }, x = k * h2 / 2 * Math.sin(Math.PI / 12);
    near('tweeter line: ribbon directivity sin(x)/x', LA.elemD(k, rib, Math.PI / 12, 0.05), Math.sin(x) / x, 1e-12);
    // each element's own source multiplies in
    const e1 = [{ x: 0, y: 1, aim: 0, r: 0.001, w: 1, tau: 0 }];
    const p1 = LA.pressureAt(e1, [{ s: 1, o: 0, g: 1 }], 1000, 2, 1, 0.05);
    const p2 = LA.pressureAt([Object.assign({}, e1[0], { src: () => GL.cx.C(0, 2) })], [{ s: 1, o: 0, g: 1 }], 1000, 2, 1, 0.05);
    truthy('tweeter line: element source scales and turns the pressure', Math.abs(p2.re + 2 * p1.im) < 1e-12 && Math.abs(p2.im - 2 * p1.re) < 1e-12, '');
  }

  // ---- standing waves inside the box, stuffing ----
  {
    const SW = GL.standing, c = GL.phys.c;
    const ms = SW.modes([{ axis: 'H', len: 0.8, at: null }], 1000);
    near('standing waves: first mode of a 0.8 m column is c/2L', ms[0].f, c / 1.6, 1e-9);
    truthy('standing waves: harmonics up to the top of the band', ms.length === 4 && Math.abs(ms[3].f - 4 * c / 1.6) < 1e-9, ms.map(m => m.f.toFixed(0)).join(' '));
    const mid = SW.modes([{ axis: 'W', len: 0.2, at: 0.5 }], 4000), end = SW.modes([{ axis: 'W', len: 0.2, at: 0 }], 4000);
    truthy('standing waves: a driver in the middle sits in the odd modes\' null', mid[0].couple < 1e-9 && Math.abs(mid[1].couple - 1) < 1e-9, mid.map(m => m.couple.toFixed(2)).join(' '));
    truthy('standing waves: a driver at the end drives them all', end.every(m => Math.abs(m.couple - 1) < 1e-9), '');
    const e = SW.effect({ mat: 'poly', fill: 1 });
    near('stuffing: full polyester fill acts 15% bigger', e.k, 1.15, 1e-12);
    near('stuffing: half fill, half the extra', SW.effect({ mat: 'poly', fill: 0.5 }).k, 1.075, 1e-12);
    truthy('stuffing: none changes nothing', SW.effect({ mat: 'none', fill: 1 }).k === 1 && SW.effect(undefined).qa === Infinity, '');
    truthy('stuffing: 30% fill damps, 10% only partly', SW.damping({ mat: 'wool', fill: 0.3 }, 500) === 'damped' && SW.damping({ mat: 'wool', fill: 0.1 }, 500) === 'partly', '');
    truthy('stuffing: a 25 mm lining works up high, not low down', SW.damping({ mat: 'lining', fill: 1, thick: 0.025 }, 3000) === 'damped' && SW.damping({ mat: 'lining', fill: 1, thick: 0.025 }, 300) === 'undamped', '');
    // in the model: a stuffed sealed box acts bigger, so the system resonance drops
    const dc = D.complete(grs.params), d = E.makeDesign('sealed', dc, 1);
    const fr = GL.util.logspace(20, 200, 400);
    const peakZ = (des) => { const r = GL.sweep(E.buildModel(des, dc, () => GL.cx.C(2.83)), fr, { volts: 2.83, drive: 2.83 }); let i0 = 0; r.zmag.forEach((z, i) => { if (z > r.zmag[i0]) i0 = i; }); return fr[i0]; };
    const fPlain = peakZ(d);
    d.chambers[0].stuff = { mat: 'poly', fill: 1 };
    const fStuffed = peakZ(d);
    const a = dc.params.vas / d.chambers[0].vol;
    // (the stuffing's absorption damps the impedance peak too, which pulls it a little lower still)
    near('stuffing: sealed Fc follows the bigger effective volume', fStuffed / fPlain, Math.sqrt((1 + a / 1.15) / (1 + a)), 0.02);
  }

  // ---- box keeps room for the drivers ----
  {
    const box = G.defaultBox();
    box.ext = { W: 0.7, H: 0.5, D: 0.5 }; box.split = 'W';
    const n = 2, gross = 0.12;
    const vol = () => ['W', 'H', 'D'].reduce((p2, k) => p2 * (box.ext[k] - box.t * (k === 'D' ? 1 + box.layers : 2 + (k === box.split ? n - 1 : 0))), 1);
    G.solveDims(box, gross, n, null, { H: 0.65 });
    near('box fit: a dimension below its minimum is held there', box.ext.H - 2 * box.t, 0.65, 1e-9);
    near('box fit: the others still hold the volume', vol(), gross, 1e-9);
    const H0 = box.ext.H;
    G.solveDims(box, gross, n, null, { H: 0.3 });
    near('box fit: a minimum already met changes nothing', box.ext.H, H0, 1e-9);
    // the placement reports what each face needs: two 12" drivers on a bandpass divider
    const p12 = Object.assign({}, grs.params, { dia: 0.32, sd: 0.05 });
    const d = E.makeDesign('bp6p', D.complete(p12), 2);
    d.chambers[0].vol = 5 * 0.0283168; d.chambers[1].vol = 3 * 0.0283168;
    const b2 = G.defaultBox(); let lay = G.layout(d, b2);
    G.applyRatio(b2, lay.gross, lay.n, { W: 1.25, H: 1, D: 0.9 }); lay = G.layout(d, b2);
    const div = GL.placement.plan(d, b2, lay, p12).dividers[0];
    near('box fit: the divider row needs both drivers', div.fit.total, 0.64, 1e-9);
    truthy('box fit: at the starting proportions they don\'t fit', div.crowded && div.fit.along < div.fit.total, (div.fit.along / IN).toFixed(1) + ' in for ' + (div.fit.total / IN).toFixed(1));
    // grow the row axis to what they need, hold the volume, and they fit
    const K = ['W', 'H', 'D'], k = K[div.fit.rowAxis];
    G.solveDims(b2, lay.gross, lay.n, null, { [k]: lay.int[k] - div.fit.along + div.fit.total + 0.02 });
    const div2 = GL.placement.plan(d, b2, G.layout(d, b2), p12).dividers[0];
    truthy('box fit: grown to fit, the drivers sit on the divider', !div2.crowded, '');
    near('box fit: and the volume is unchanged', G.layout(d, b2).mismatch, 0, 1e-7);
    // stacked, the same drivers lie across the width
    const b3 = Object.assign(G.defaultBox(), { split: 'H' }); let l3 = G.layout(d, b3);
    G.applyRatio(b3, l3.gross, l3.n, { W: 1.25, H: 1, D: 0.9 }); l3 = G.layout(d, b3);
    const div3 = GL.placement.plan(d, b3, l3, p12).dividers[0];
    truthy('box fit: stacked, the divider lies flat and the drivers sit across the width', K[div3.fit.rowAxis] === 'W' && !div3.crowded, K[div3.fit.rowAxis]);
  }

  // ---- room for the motor ----
  {
    const d = E.makeDesign('bp4', D.complete(grs.params), 1);
    d.chambers.find(c => c.id === 'R').vol = 0.5 * 0.0283168; d.chambers.find(c => c.id === 'F').vol = 1.5 * 0.0283168;
    const box = Object.assign(G.defaultBox(), { split: 'W' });
    let lay = G.layout(d, box); G.applyRatio(box, lay.gross, lay.n, { W: 1.25, H: 1, D: 0.9 }); lay = G.layout(d, box);
    const rear = () => G.layout(d, box).chambers.find(c => c.id === 'R');
    const lenByVol = rear().len;
    // ask for a longer rear chamber (a deep motor): only that chamber grows
    box.minLen = { R: lenByVol * 1.6 };
    const lay2 = G.layout(d, box);
    near('motor room: the chamber is held at its minimum length', lay2.chambers.find(c => c.id === 'R').len, lenByVol * 1.6, 1e-12);
    near('motor room: it holds the extra air, the other chamber none', lay2.chambers.find(c => c.id === 'F').spare, 0, 1e-12);
    near('motor room: extra air = extra length × cross-section', lay2.spare, lenByVol * 0.6 * lay2.cross, 1e-12);
    // (the extra depends on the cross-section the solve picks, so settle it a few times, as the app does)
    for (let i = 0; i < 8; i++) { const l = G.layout(d, box); G.solveDims(box, l.need, l.n, null); }
    const lay3 = G.layout(d, box);
    near('motor room: the box grows to hold it (volume matches what the chambers need)', lay3.mismatch, 0, 1e-6);
    near('motor room: the front chamber keeps exactly its volume', lay3.chambers.find(c => c.id === 'F').len * lay3.cross, lay3.chambers.find(c => c.id === 'F').gross, 1e-12);
    // front-mounted drivers: the plan reports the depth the motor needs
    const s1 = E.makeDesign('sealed', D.complete(grs.params), 1);
    const b1 = G.defaultBox(); let l1 = G.layout(s1, b1); G.applyRatio(b1, l1.gross, l1.n, { W: 1.25, H: 1, D: 0.9 }); l1 = G.layout(s1, b1);
    const pl = GL.placement.plan(s1, b1, l1, grs.params);
    truthy('motor room: depth comes from the driver (or is estimated from its size)', pl.drv.depth > 0.05 && pl.drv.depth < 0.2, (pl.drv.depth / IN).toFixed(2) + ' in' + (pl.drv.estimated ? ' (estimated)' : ''));
    G.solveDims(b1, l1.gross, l1.n, null, { D: pl.drv.depth + 0.02 - b1.t * b1.layers });
    near('motor room: a shallow box is made deep enough for the motor', G.layout(s1, b1).int.D + b1.t * b1.layers, Math.max(pl.drv.depth + 0.02, l1.int.D + b1.t * b1.layers), 1e-9);
  }

  // ---- box first: the best drivers for a given box ----
  {
    const soft = Object.assign({}, grs.params, { qms: grs.params.qms * 0.5 });           // a lossier twin: should rank lower
    const big = Object.assign({}, grs.params, { dia: 0.4 });
    const drivers = [{ name: 'GRS', params: grs.params }, { name: 'soft', params: soft }, { name: 'huge', params: big }];
    const base = { drivers, vol: 1.25 * 0.0283168, goal: 'deep', ripple: 3, top: 100, band: [25, 80], portShape: 'round', portLimit: 25, keep: 3 };
    asyncTests.push(GL.optimize.forBox(Object.assign({}, base, { type: 'sealed', fits: (e) => !(e.params.dia > 0.3) })).then(r => {
      truthy('box first: a driver too big for the box is left out', r.tooBig === 1 && r.rows.length === 2, r.tooBig + ' left out');
      truthy('box first: results carry their curves for the preview', r.rows.every(x => x.res && x.res.spl.length === x.res.f.length), '');
      truthy('box first: deepest first', r.rows[0].f3 <= r.rows[1].f3, r.rows.map(x => x.entry.name + ' ' + x.f3.toFixed(1)).join(', '));
    }));
    asyncTests.push(GL.optimize.forBox(Object.assign({}, base, { type: 'ported', drivers: drivers.slice(0, 1) })).then(r => {
      const c = r.rows[0];
      truthy('box first: ported gets a tuning and a port', c && c.fbs.length === 1 && c.fbs[0] > 10 && c.ports[0].len > 0, c ? c.fbs[0].toFixed(1) + ' Hz' : 'none');
      truthy('box first: ported goes deeper than sealed in the same box', c && c.f3 < 40, c ? c.f3.toFixed(1) + ' Hz' : '');
    }));
  }

  // ---- box first: bandpass, passive radiators, real fit ----
  {
    const OPT = GL.optimize;
    const g4 = OPT.boxGrid('bp4', 0.05, 30, 100), g6 = OPT.boxGrid('bp6p', 0.05, 30, 100);
    truthy('box first: bandpass grids split the volume', g4.length > 10 && g4.every(g => Math.abs(g.vols[0] + g.vols[1] - 0.05) < 1e-12 && g.fbs.length === 1), g4.length + ' trials');
    truthy('box first: 6th-order front tuned above the rear', g6.length > 10 && g6.every(g => g.fbs[1] > g.fbs[0] * 1.3), g6.length + ' trials');
    // a passive radiator from the catalogue, tuned with added mass to the asked frequency
    const dc = D.complete(grs.params), per = 2.83;
    const base = { dc, count: 1, wiring: 'parallel', per, volts: per, freqs: GL.util.logspace(8, 250, 90), vmaxAir: 0, portLimit: 25, portShape: 'round', ripple: 3, top: 100, fs: dc.params.fs, target: 25, refLevel: dc.derived.spl1w + 20 * Math.log10(per / Math.sqrt(dc.model.Re)) };
    const prSpec = { fs: 18, vas: 0.08, sd: 0.033, qms: 7, xmax: 0.02 };
    const c = OPT.evaluate('pr', [0.04], [28], Object.assign({}, base, { pr: prSpec }));
    near('box first: the passive radiator is tuned to the frequency asked', c.fbs[0], 28, 0.01);
    truthy('box first: the catalogue radiator is the one used', c.design.prs[0].sd === 0.033 && c.design.prs[0].added > 0, (c.design.prs[0].added * 1000).toFixed(0) + ' g added');
    const high = OPT.evaluate('pr', [0.04], [200], Object.assign({}, base, { pr: prSpec }));
    truthy('box first: a tuning the radiator can\'t reach is flagged', !high.ok && high.why.some(w => /tune that high/.test(w)), high.why.join(', '));
    // the fit check keeps out results that don't really fit, and the next ones step up
    asyncTests.push(OPT.forBox({ drivers: [{ name: 'a', params: grs.params }, { name: 'b', params: Object.assign({}, grs.params, { qms: 3 }) }], type: 'sealed', vol: 0.03,
      goal: 'deep', ripple: 3, top: 100, band: [25, 80], keep: 3, fitCheck: (r) => r.entry.name !== 'a' }).then(r => {
      truthy('box first: results that fail the fit check are skipped', r.rows.length === 1 && r.rows[0].entry.name === 'b' && r.unfit === 1, r.rows.map(x => x.entry.name).join(','));
    }));
  }

  // ---- line array in one box: drivers at a set pitch on the baffle ----
  {
    const p3 = Object.assign({}, grs.params, { dia: 0.075, sd: 0.003, depth: 0.04 });
    const d = E.makeDesign('sealed', D.complete(p3), 8);
    d.rowPitch = 0.08;
    d.chambers[0].vol = 0.0105;                // fits the column below
    const box = Object.assign(G.defaultBox(), { ext: { W: 0.1, H: 0.9, D: 0.2 }, t: 0.012 });
    const pl = GL.placement.plan(d, box, G.layout(d, box), p3);
    const ys = pl.drivers.map(x => x.pos[1]).sort((a, b) => b - a);
    truthy('one-box array: all drivers on the front baffle in one line', pl.drivers.length === 8 && pl.drivers.every(x => x.front && Math.abs(x.pos[0]) < 1e-9), '');
    truthy('one-box array: centre to centre at the pitch', ys.slice(1).every((y, i) => Math.abs(ys[i] - y - 0.08) < 1e-9), ys.slice(1).map((y, i) => (ys[i] - y).toFixed(4)).join(' '));
    const f = Object.values(pl.faces)[0];
    near('one-box array: the row needs the whole group', f.fit.total, 7 * 0.08 + 0.075 * 1.0 + 0, 0.02);
    d.rowPitch = 0.2;
    const tall = GL.placement.plan(d, box, G.layout(d, box), p3);
    truthy('one-box array: too wide a pitch for the box is flagged', Object.values(tall.faces)[0].crowded, '');
  }
  // ---- two passive radiators ----
  {
    const prSpec = { fs: 18, vas: 0.05, sd: 0.02, qms: 7, xmax: 0.015 };
    asyncTests.push(GL.optimize.forBox({ drivers: [{ name: 'GRS', params: grs.params }], type: 'pr', vol: 0.04, goal: 'deep', ripple: 3, top: 100, band: [25, 80], keep: 3,
      prCounts: [1, 2], prFor: (e, dc, n) => ({ spec: prSpec, name: 'PR' + n }) }).then(r => {
      const c = r.rows[0];
      truthy('two radiators: the search tries one and two', c && (c.prCount === 1 || c.prCount === 2) && c.design.prs[0].count === c.prCount, c ? c.prCount + ' × ' + c.prName : 'none');
    }));
    const dc = D.complete(grs.params), per = 2.83;
    const base = { dc, count: 1, wiring: 'parallel', per, volts: per, freqs: GL.util.logspace(8, 250, 90), vmaxAir: 0, portLimit: 25, portShape: 'round', ripple: 3, top: 100, fs: dc.params.fs, target: 25, refLevel: 0 };
    const one = GL.optimize.evaluate('pr', [0.04], [26], Object.assign({}, base, { pr: prSpec, prCount: 1 }));
    const two = GL.optimize.evaluate('pr', [0.04], [26], Object.assign({}, base, { pr: prSpec, prCount: 2 }));
    near('two radiators: both tuned to the same frequency', two.fbs[0], one.fbs[0], 0.01);
    truthy('two radiators: each carries more added mass (twice the area on the same air)', two.design.prs[0].added > one.design.prs[0].added, (one.design.prs[0].added * 1000).toFixed(0) + ' g vs ' + (two.design.prs[0].added * 1000).toFixed(0) + ' g each');
  }

  // ---- box first with several drivers sharing the box ----
  {
    const one = GL.optimize.forBox({ drivers: [{ name: 'GRS', params: grs.params }], type: 'sealed', vol: 0.03, count: 1, goal: 'deep', ripple: 3, top: 100, band: [25, 80], keep: 1 });
    const two = GL.optimize.forBox({ drivers: [{ name: 'GRS', params: grs.params }], type: 'sealed', vol: 0.06, count: 2, goal: 'deep', ripple: 3, top: 100, band: [25, 80], keep: 1 });
    asyncTests.push(Promise.all([one, two]).then(([a, b]) => {
      const A = a.rows[0], B = b.rows[0];
      truthy('several drivers: the design holds them all', B.design.count === 2, '');
      near('several drivers: two in twice the box roll off where one in the box does', B.f3, A.f3, 0.2);
      near('several drivers: and play 6 dB louder', B.out - A.out, 6.02, 0.3);
    }));
  }

  // ---- starting volumes: one driver's box, times the count ----
  {
    const small = D.complete({ fs: 102, qts: 0.65, qms: 4, vas: 0.00036, sd: 0.00165, re: 7.4, le: 0.00061, pe: 15, xmax: 0.0035 });
    const s1 = E.makeDesign('sealed', small, 1).chambers[0].vol, s8 = E.makeDesign('sealed', small, 8).chambers[0].vol;
    truthy('starting volume: a 2" driver gets a box its own size, not a sub\'s', s1 < 0.001, (s1 * 1000).toFixed(2) + ' L');
    near('starting volume: eight drivers get eight times one', s8 / s1, 8, 1e-9);
    const v1 = E.makeDesign('ported', small, 1), v8 = E.makeDesign('ported', small, 8);
    near('starting volume: ported, eight times one too', v8.chambers[0].vol / v1.chambers[0].vol, 8, 1e-9);
    near('starting volume: and the same tuning', E.portFb(v8.ports[0], v8.chambers[0].vol), E.portFb(v1.ports[0], v1.chambers[0].vol), 0.5);
    const g = D.complete(grs.params), sg = E.makeDesign('sealed', g, 1).chambers[0].vol;
    near('starting volume: sealed is Qtc 0.707 when the driver allows', g.params.qts * Math.sqrt(1 + g.params.vas / sg), 0.707, 1e-6);
  }

  // ---- build sheet: cutouts where the plan puts them, parts nested on sheets ----
  {
    const BS = GL.buildsheet;
    const box = G.defaultBox();
    const sb = { chambers: [{ id: 'A', name: 'Box', vol: 0.04, bracing: 0 }],
      ports: [{ id: 'p', name: 'Port', from: 'A', to: 'out', shape: 'round', d: 3 * IN, len: 6 * IN, count: 1, wall: 0 }],
      prs: [], mount: { rear: 'A', front: 'out' }, count: 1, driverDisp: 0 };
    let lay = G.layout(sb, box);
    for (let it = 0; it < 6; it++) { G.solveDims(box, lay.gross, 1, null); lay = G.layout(sb, box); }
    const pl = GL.placement.plan(sb, box, lay, grs.params);
    const parts = BS.panels({ list: lay.panels.list, box, plan: pl, layout: lay, design: sb, drvCut: BS.driverCutout(grs.params) });
    const fb = parts.find(p => /^Front baffle/.test(p.name));
    const dh = fb.holes.find(x => x.kind === 'driver'), ph = fb.holes.find(x => x.kind === 'port');
    truthy('build sheet: the front baffle has the driver and the port', !!dh && !!ph, fb.holes.map(x => x.kind).join(','));
    near('build sheet: driver centre measured from the baffle\'s left edge', dh.u, pl.drivers[0].pos[0] + box.ext.W / 2 - box.t, 1e-9);
    near('build sheet: and from its bottom edge', dh.v, pl.drivers[0].pos[1] + box.ext.H / 2 - box.t, 1e-9);
    near('build sheet: port hole is the tube size', ph.d, 3 * IN, 1e-9);
    truthy('build sheet: every hole inside its panel', parts.every(p => p.holes.every(x => x.shape !== 'circle' || (x.u - x.d / 2 >= -1e-9 && x.u + x.d / 2 <= p.w + 1e-9 && x.v - x.d / 2 >= -1e-9 && x.v + x.d / 2 <= p.h + 1e-9))), '');
    const est = BS.driverCutout({ sd: grs.params.sd, dia: 0.21 }), given = BS.driverCutout({ sd: grs.params.sd, dia: 0.21, cutout: 0.185 });
    truthy('build sheet: cutout estimated from the frame unless given', est.est && Math.abs(est.d - 0.21 * 0.88) < 1e-9 && !given.est && given.d === 0.185, '');
    // nesting
    const sheet = { w: 2.44, h: 1.22, kerf: 0.003, rotate: true };
    const many = [{ name: 'a', qty: 4, w: 1.0, h: 0.5, holes: [] }, { name: 'b', qty: 3, w: 0.4, h: 0.6, holes: [] }];
    const n = BS.nest(many, sheet);
    const all = n.sheets.flatMap(sh => sh.placed.map(pp => ({ sh, x: pp.x, y: pp.y, w: pp.it.w, h: pp.it.h })));
    truthy('nest: every part placed', all.length === 7 && !n.tooBig.length, all.length + ' placed');
    truthy('nest: all on the sheet', all.every(r => r.x >= 0 && r.y >= 0 && r.x + r.w <= 2.44 + 1e-9 && r.y + r.h <= 1.22 + 1e-9), '');
    const overlap = all.some((r, i) => all.some((q, j) => j > i && q.sh === r.sh && r.x < q.x + q.w + 0.003 - 1e-9 && q.x < r.x + r.w + 0.003 - 1e-9 && r.y < q.y + q.h + 0.003 - 1e-9 && q.y < r.y + r.h + 0.003 - 1e-9));
    truthy('nest: no two parts closer than the kerf', !overlap, '');
    truthy('nest: a part bigger than the sheet is reported', BS.nest([{ name: 'big', qty: 1, w: 3, h: 1.5, holes: [] }], sheet).tooBig.length === 1, '');
    const svg = BS.panelSvg(fb, (m) => (m * 1000).toFixed(0));
    truthy('build sheet: drawing has the panel and its holes', /<svg/.test(svg) && (svg.match(/class="bs-hole/g) || []).length === fb.holes.length, '');
  }

  // ---- a slot too long for its chamber: panels stay inside the box ----
  {
    const box = G.defaultBox();
    const sb = { chambers: [{ id: 'A', name: 'Box', vol: 0.03, bracing: 0 }],
      ports: [{ id: 'p', name: 'Port', from: 'A', to: 'out', shape: 'slot', w: 1.5 * IN, h: 0.1, len: 80 * IN, count: 1, end: 'flanged-free', alongWall: true, fullHeight: true }],
      prs: [], mount: { rear: 'A', front: 'out' }, count: 1, driverDisp: 0 };
    let lay = G.layout(sb, box);
    for (let it = 0; it < 6; it++) { G.solveDims(box, lay.gross, 1, null); lay = G.layout(sb, box); }
    const pl = GL.placement.plan(sb, box, lay, grs.params);
    const r = pl.ports[0].route, longest = Math.max(box.ext.W, box.ext.H, box.ext.D);
    truthy('long slot: reported as not fitting', r && !r.fits, r ? 'fits ' + r.fits : 'no route');
    truthy('long slot: no panel longer than the box', r.panels.every(p => p.a <= longest + 1e-9 && p.a >= 0), r.panels.map(p => p.name + ' ' + (p.a / IN).toFixed(2)).join(', ') + ' vs ' + (longest / IN).toFixed(2));
  }

  // ---- EQ: Linkwitz transform and parametric bands ----
  {
    const Q = GL.eq, X2 = GL.cx, T = 2 * Math.PI;
    const hp2 = (w, f, q) => { const w0 = T * f; return X2.cdiv(X2.C(-w * w, 0), X2.C(w0 * w0 - w * w, w * w0 / q)); };
    const lt = { on: true, f0: 45, q0: 0.95, fp: 22, qp: 0.707 };
    const worst = Math.max(...[10, 18, 25, 40, 60, 100, 300].map(f => {
      const w = T * f, a = X2.cmul(hp2(w, 45, 0.95), Q.linkwitz(w, lt)), b = hp2(w, 22, 0.707);
      return Math.abs(20 * Math.log10(X2.cabs(a) / X2.cabs(b)));
    }));
    truthy('EQ: a Linkwitz transform turns a 45 Hz, Q 0.95 box into a 22 Hz, Q 0.707 one', worst < 1e-6, worst.toExponential(2) + ' dB');
    near('EQ: Linkwitz transform is flat up high', 20 * Math.log10(X2.cabs(Q.linkwitz(T * 5000, lt))), 0, 0.01);
    near('EQ: peak band has its gain at its frequency', 20 * Math.log10(X2.cabs(Q.band(T * 60, { type: 'peak', f: 60, gain: -6, q: 3 }))), -6, 1e-9);
    near('EQ: and none far away', 20 * Math.log10(X2.cabs(Q.band(T * 2000, { type: 'peak', f: 60, gain: -6, q: 3 }))), 0, 0.05);
    near('EQ: low shelf, full gain far below', 20 * Math.log10(X2.cabs(Q.band(T * 2, { type: 'lowshelf', f: 100, gain: 4, q: 0.707 }))), 4, 0.01);
    near('EQ: low shelf, none far above', 20 * Math.log10(X2.cabs(Q.band(T * 10000, { type: 'lowshelf', f: 100, gain: 4, q: 0.707 }))), 0, 0.01);
    near('EQ: high shelf, full gain far above', 20 * Math.log10(X2.cabs(Q.band(T * 20000, { type: 'highshelf', f: 1000, gain: -3, q: 0.707 }))), -3, 0.01);
    near('EQ: the most boost is found', Q.maxBoost({ bands: [{ on: true, type: 'peak', f: 30, gain: 6, q: 2 }] }, 10, 200).db, 6, 0.05);
  }

  // ---- measurement files (.frd / .zma) ----
  {
    const F = GL.frd;
    const frd = '* REW export\n* Freq(Hz) SPL(dB) Phase(degrees)\n' + Array.from({ length: 300 }, (_, i) => { const f = 10 * Math.pow(2000, i / 299); return f.toFixed(3) + ' ' + (85 + Math.sin(i / 20)).toFixed(3) + ' ' + (-i).toFixed(1); }).join('\n');
    const m = F.parse('woofer.frd', frd);
    truthy('measurements: an .frd reads as a response, with phase', m.kind === 'frd' && m.f.length === 300 && m.ph && m.ph[5] === -5, m.kind + ' ' + m.f.length);
    const zma = 'Freq;Ohms;Deg\n' + Array.from({ length: 40 }, (_, i) => { const f = 10 * Math.pow(100, i / 39); return (f.toFixed(2) + ';' + (6 + 30 / (1 + Math.pow(Math.log(f / 40) * 4, 2))).toFixed(2) + ';0').replace(/\./g, ','); }).join('\n');
    const z = F.parse('sweep.txt', zma);
    truthy('measurements: a decimal-comma table of ohms reads as impedance', z.kind === 'zma' && z.f.length === 40 && Math.abs(z.f[0] - 10) < 1e-9, z.kind + ' ' + z.f.length + ' ' + z.f[0]);
    const big = Array.from({ length: 20000 }, (_, i) => (10 + i) + ' 90').join('\n');
    const b = F.parse('big.frd', big);
    truthy('measurements: a huge export is thinned', b.f.length <= 480 && b.points === 20000 && Math.abs(b.y[100] - 90) < 1e-9, b.f.length + ' kept');
    near('measurements: level match lines a response up', F.matchOffset({ f: [50, 100, 200], y: [80, 80, 80] }, [10, 1000], [92, 92], 40, 300), 12, 1e-9);
    truthy('measurements: a driver file is not taken for one', !F.looksLike('Fs=30\nQts=0.4\nVas=50\n'), '');
  }

  // ---- cutting files: DXF, SVG, STL ----
  {
    const CF = GL.cutfiles;
    // closed: every edge used twice, once each way; volume from the divergence theorem
    const check = (tris) => {
      const k = (p) => p.map(v => v.toFixed(4)).join(',');
      const edges = new Map();
      for (const t of tris) for (let i = 0; i < 3; i++) { const e = k(t[i]) + '>' + k(t[(i + 1) % 3]); edges.set(e, (edges.get(e) || 0) + 1); }
      let open = 0;
      // balanced: each edge used as often one way as the other (touching panels share edges)
      for (const [e, n] of edges) { const [a, b] = e.split('>'); if (edges.get(b + '>' + a) !== n) open++; }
      let vol = 0;
      for (const [a, b, c] of tris) vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      return { open, vol };
    };
    const panel = { name: 'Front', qty: 1, w: 0.4, h: 0.3, holes: [
      { kind: 'driver', shape: 'circle', u: 0.15, v: 0.15, d: 0.18 },
      { kind: 'port', shape: 'circle', u: 0.33, v: 0.08, d: 0.07 },
      { kind: 'slot', shape: 'rect', u: 0.37, v: 0, w: 0.03, h: 0.3 },        // a full-height slot opening at the right edge
      { kind: 'window', shape: 'rect', u: 0.28, v: 0.18, w: 0.06, h: 0.06 }] };
    const tris = CF.plate(panel, 0.012), c = check(tris);
    const sh = CF.shape(panel, { seg: 48 });
    const holeArea = sh.holes.reduce((s, h) => s + (h.type === 'circle' ? 0.5 * h.seg * h.r * h.r * Math.sin(2 * Math.PI / h.seg) : (h.x1 - h.x0) * (h.y1 - h.y0)), 0);
    const outArea = sh.outline.reduce((s, l) => s + Math.abs(CF.area2(l)), 0);
    truthy('cut files: a panel with holes and an edge notch prints as a closed solid', c.open === 0, c.open + ' open edges');
    near('cut files: its volume is (outline - holes) x thickness', c.vol, (outArea - holeArea) * 12, 1e-6 * c.vol);
    near('cut files: the notch comes off the outline', outArea, 400 * 300 - 30 * 300, 1e-6);
    // the assembled box: closed panels, all facing out (positive volume)
    const box = G.defaultBox();
    const sb = { chambers: [{ id: 'A', name: 'Box', vol: 0.03, bracing: 0 }], ports: [], prs: [], mount: { rear: 'A', front: 'out' }, count: 1, driverDisp: 0 };
    let lay = G.layout(sb, box);
    for (let it = 0; it < 6; it++) { G.solveDims(box, lay.gross, 1, null); lay = G.layout(sb, box); }
    const pl = GL.placement.plan(sb, box, lay, grs.params);
    const parts = GL.buildsheet.panels({ list: lay.panels.list, box, plan: pl, layout: lay, design: sb, drvCut: GL.buildsheet.driverCutout(grs.params) });
    const bx = CF.stlBox(parts, Object.assign({}, box, { layout: lay })), cb = check(bx);
    const wood = parts.filter(p => !p.stock).reduce((s, p) => s + p.qty * p.w * p.h, 0) * box.t * 1e9;
    truthy('cut files: the assembled box is closed and faces out', cb.open === 0 && cb.vol > 0, cb.open + ' open edges, ' + (cb.vol / 1e6).toFixed(2) + ' L of wood');
    truthy('cut files: and holds about the wood the cut list says', cb.vol < wood && cb.vol > wood * 0.85, (cb.vol / wood * 100).toFixed(1) + '%');
    const dxf = CF.dxfPanels(parts);
    truthy('cut files: DXF has the outlines and the driver cutout', /\nOUTLINE\r?\n/.test(dxf) && (dxf.match(/\nCIRCLE\r?\n/g) || []).length >= 1 && /EOF\r?\n$/.test(dxf), '');
    truthy('cut files: SVG is in millimetres', /width="[\d.]+mm"/.test(CF.svgPanels(parts)), '');
    const blob = CF.stlBinary(tris, 'test');
    truthy('cut files: binary STL is the right size', blob.size === 84 + 50 * tris.length, blob.size + ' bytes');
  }

  // ---- passive crossovers ----
  {
    const XO = GL.crossover, X2 = GL.cx, T = 2 * Math.PI, R0 = 8, fc = 2000;
    const mag = (parts, f) => X2.cabs(XO.solve(parts, X2.C(R0, 0), T * f).H);
    const ideal = { bw1: (x) => 1 / Math.sqrt(1 + x * x), lr2: (x) => 1 / (1 + x * x), bw2: (x) => 1 / Math.sqrt(1 + x ** 4), bw3: (x) => 1 / Math.sqrt(1 + x ** 6), lr4: (x) => 1 / (1 + x ** 4) };
    for (const al of Object.keys(ideal)) {
      const lp = XO.section(al, fc, R0, false), hp = XO.section(al, fc, R0, true);
      const err = Math.max(...[300, 1000, 2000, 3000, 9000].map(f => Math.max(
        Math.abs(20 * Math.log10(mag(lp, f) / ideal[al](f / fc))), Math.abs(20 * Math.log10(mag(hp, f) / ideal[al](fc / f))))));
      truthy('crossover: ' + al + ' ladder into 8 Ω gives the textbook low- and high-pass', err < 0.01, err.toFixed(4) + ' dB');
    }
    // LR4 halves sum flat (in phase); LR2 does with the tweeter reversed
    const sum = (al, inv) => Math.max(...[500, 1500, 2000, 2600, 6000].map(f => {
      const a = XO.solve(XO.section(al, fc, R0, false), X2.C(R0, 0), T * f).H, b = XO.solve(XO.section(al, fc, R0, true), X2.C(R0, 0), T * f).H;
      return Math.abs(20 * Math.log10(X2.cabs(inv ? X2.csub(a, b) : X2.cadd(a, b))));
    }));
    truthy('crossover: LR4 low and high sum flat', sum('lr4') < 0.01, sum('lr4').toFixed(4) + ' dB');
    truthy('crossover: LR2 sums flat with the tweeter reversed', sum('lr2', true) < 0.01, sum('lr2', true).toFixed(4) + ' dB');
    // L-pad: the cut, and the amp still sees about R
    const pad = XO.lpad(6, R0), sp = XO.solve(pad, X2.C(R0, 0), T * 1000);
    near('crossover: L-pad cuts by its setting', 20 * Math.log10(X2.cabs(sp.H)), -6, 1e-9);
    near('crossover: and keeps the load', X2.cabs(sp.Zin), R0, 1e-9);
    // Zobel: Re + jωLe in parallel with it is close to flat
    const zl = (w) => X2.C(6, w * 0.0008), zb = XO.zobel(6, 0.0008);
    const flat = Math.max(...[2000, 10000, 20000].map(f => Math.abs(X2.cabs(XO.solve(zb, zl(T * f), T * f).Zin) / 7.5 - 1)));
    truthy('crossover: Zobel flattens the coil\'s rising impedance', flat < 0.05, (flat * 100).toFixed(1) + '%');
    near('crossover: preferred values', XO.nearest(4.42e-6), 4.7e-6, 1e-12);
  }

  // ---- power compression and large signal ----
  {
    const LS = GL.largesignal;
    const cold = LS.hotCoil({ re: 3.6, pe: 300, vPer: 0.001, duty: 'sine', rise: 180, coil: 'cu' });
    near('compression: no heat at a whisper', cold.dT, 0, 1e-3);
    // at rated power, continuously: about the rated rise (a little less, since the hot coil draws less)
    const full = LS.hotCoil({ re: 3.6, pe: 300, vPer: Math.sqrt(300 * 3.6), duty: 'sine', rise: 180, coil: 'cu' });
    truthy('compression: rated power heats the coil by about its rated rise', full.dT > 100 && full.dT < 180, full.dT.toFixed(0) + ' °C, ' + full.db.toFixed(1) + ' dB');
    near('compression: and is self-consistent (P = V²/Re_hot)', full.P, 300 * 3.6 / full.re, 1e-6);
    const music = LS.hotCoil({ re: 3.6, pe: 300, vPer: Math.sqrt(300 * 3.6), duty: 'music', rise: 180, coil: 'cu' });
    truthy('compression: music heats it less than a steady tone', music.dT < full.dT / 4, music.dT.toFixed(0) + ' °C');
    const e = LS.effective(0.01, 0.01, 0.82, 1.33);
    truthy('large signal: at a peak of Xmax, BL and stiffness are part way to their Xmax values', Math.abs(e.bl - 0.91) < 1e-9 && Math.abs(e.kms - 1.165) < 1e-9, e.bl + ' ' + e.kms);
    // a fixed point: excursion that falls with BL settles
    const res = LS.solve([30], [12], 0.01, 0.82, 1.33, (b) => b, (b) => ({ spl: 100 + 20 * Math.log10(b), xpk: 12 * b }));
    truthy('large signal: the excursion settles below the linear guess', res.xpk[0] < 12 && res.xpk[0] > 9, res.xpk[0].toFixed(2) + ' mm');
  }

  // ---- round ports on any outer wall ----
  {
    const box = G.defaultBox();
    const mk = (face) => ({ chambers: [{ id: 'A', name: 'Box', vol: 0.04, bracing: 0 }],
      ports: [{ id: 'p', name: 'Port', from: 'A', to: 'out', shape: 'round', d: 3 * IN, len: 5 * IN, count: 1, wall: 0.125 * IN, face }],
      prs: [], mount: { rear: 'A', front: 'out' }, count: 1, driverDisp: 0 });
    let sb = mk('back'), lay = G.layout(sb, box);
    for (let it = 0; it < 6; it++) { G.solveDims(box, lay.gross, 1, null); lay = G.layout(sb, box); }
    for (const face of ['back', 'left', 'top', 'bottom']) {
      sb = mk(face);
      const r = GL.placement.plan(sb, box, G.layout(sb, box), grs.params).ports[0].route;
      const ax = { back: 2, left: 0, top: 1, bottom: 1 }[face], sg = { back: -1, left: -1, top: 1, bottom: -1 }[face];
      truthy('ports on any wall: ' + face + ' port starts on that wall and runs inward', r.wall === face && r.fits && Math.abs(r.pts[0][ax] - sg * box.ext['WHD'[ax]] / 2) < 1e-9 && (r.pts[1][ax] - r.pts[0][ax]) * sg < 0, r.wall + ' ' + r.fits);
    }
    // "auto": a front with no room left sends it to the back
    const tight = G.defaultBox();
    const sb2 = mk('auto');
    const g = GL.placement.driverGeom(grs.params);
    // a front just big enough for the driver; the depth holds the volume
    tight.ext.W = tight.ext.H = 2 * g.r + 2 * tight.t + 0.004;
    tight.lock = { W: true, H: true, D: false };
    for (let it = 0; it < 6; it++) G.solveDims(tight, G.layout(sb2, tight).gross, 1, null);
    const full = GL.placement.plan(mk('front'), tight, G.layout(mk('front'), tight), grs.params).faces.A.crowded;
    const r2 = GL.placement.plan(sb2, tight, G.layout(sb2, tight), grs.params).ports[0].route;
    truthy('ports on any wall: auto moves off a full front', full && r2.wall !== 'front' && r2.movedFrom === 'front', 'front full: ' + full + ', port on ' + r2.wall);
    const parts = GL.buildsheet.panels({ list: G.layout(mk('back'), box).panels.list, box, plan: GL.placement.plan(mk('back'), box, G.layout(mk('back'), box), grs.params), layout: G.layout(mk('back'), box), design: mk('back'), drvCut: GL.buildsheet.driverCutout(grs.params) });
    const back = parts.find(p => p.name === 'Back'), front = parts.find(p => /^Front/.test(p.name));
    truthy('ports on any wall: the build sheet puts the hole on the back, not the front', back.holes.some(h => h.kind === 'port') && !front.holes.some(h => h.kind === 'port'), '');
  }

  // ---- every script compiles (the page itself isn't loaded here) ----
  {
    const files = ['app', 'util', 'physics', 'eq', 'crossover', 'largesignal', 'drivers', 'specparse', 'enclosures', 'geometry', 'placement', 'optimize', 'match',
      'catalogue', 'measure', 'acoustics', 'linearray', 'room', 'buildsheet', 'cutfiles', 'charts', 'frd', 'view3d', 'version'];
    asyncTests.push(Promise.all(files.map(f => fetch('../js/' + f + '.js', { cache: 'no-store' }).then(r => r.text()).then(t => {
      try { new Function(t); return null; } catch (e) { return f + '.js: ' + e.message; }
    }))).then(errs => {
      const bad = errs.filter(Boolean);
      truthy('scripts: every file in js/ compiles', !bad.length, bad.join('; ') || files.length + ' files');
    }));
  }

  // ---- folded transmission line ----
  {
    const G = GL.geometry, E = GL.enclosures;
    const line = (fold) => ({ length: 2.4, width: 0.25, h0: 0.12, hL: 0.08, drvPos: 0.15, shape: 'rect', mouthFlanged: true, stuffing: 0.3, fold });
    for (const fo of [{ n: 1 }, { n: 2 }, { n: 3, mouth: 'end' }, { n: 2, dividers: 'parallel', legs: 'horizontal' }]) {
      const r = G.lineFold({ line: line(fo) });
      near('folded line: the path along the centre is the line length (' + JSON.stringify(fo) + ')', r.path, 2.4, 1e-9);
    }
    const r2 = G.lineFold({ line: line({ n: 2 }) });
    truthy('folded line: legs stack to the inside depth at both ends', Math.abs(r2.legs.reduce((s, g) => s + g.hA, 0) + 2 * r2.t - r2.Din) < 1e-9 && Math.abs(r2.legs.reduce((s, g) => s + g.hB, 0) + 2 * r2.t - r2.Din) < 1e-9, '');
    truthy('folded line: outside is inside plus two walls', Math.abs(r2.ext.H - r2.Lin - 2 * r2.t) < 1e-12 && Math.abs(r2.ext.W - 0.25 - 2 * r2.t) < 1e-12, '');
    // a square line's area across a corner's diagonal is √2 times (no corner block), back to the gap mid-turn
    const sq = { length: 2, width: 0.1, h0: 0.1, hL: 0.1, shape: 'rect', drvPos: 0.1, fold: { n: 1, deflect: false, gap: 1, mouth: 'end', t: 0.01 } };
    const rs = G.lineFold({ line: sq }), fn = E.lineAreaFn(sq), c1 = rs.legs[0].len;
    near('folded line: the corner diagonal is √2 × the area', fn(c1 + 1e-6) / 0.01, Math.SQRT2, 0.01);
    near('folded line: mid-turn area is the turn gap', fn(c1 + rs.turns[0].pitch / 2) / 0.01, 1, 0.01);
    near('folded line: away from the turn it is the line', fn(0.3) / 0.01, 1, 1e-9);
    const blk = Object.assign({}, sq, { fold: Object.assign({}, sq.fold, { deflect: true }) });
    truthy('folded line: corner blocks lower the corner peak', E.lineAreaFn(blk)(c1 + 1e-6) < fn(c1 + 1e-6) - 1e-4, '');
    const par = E.lineAreaFn(line({ n: 2, dividers: 'parallel', deflect: false }));
    near('folded line: parallel dividers make a stepped taper (first leg = its middle)', par(0.05) / 0.25, 0.12 + (0.08 - 0.12) / 6, 1e-9);
  }

  // ---- room modes and placement ----
  {
    const RM = GL.room, c = GL.phys.c;
    const room = { L: 5.5, W: 4.0, H: 2.4, rt60: 0.4 };
    const ms = RM.modes(room, 100);
    near('room: first length mode is c/2L', ms.find(m => m.n.join() === '1,0,0').f, c / (2 * room.L), 1e-9);
    near('room: first oblique mode', ms.find(m => m.n.join() === '1,1,1').f, c / 2 * Math.hypot(1 / room.L, 1 / room.W, 1 / room.H), 1e-9);
    truthy('room: modes come lowest first', ms.every((m, i) => !i || m.f >= ms[i - 1].f), '');
    near('room: Schroeder frequency 2000·√(RT60/V)', RM.schroeder(room), 2000 * Math.sqrt(0.4 / (5.5 * 4 * 2.4)), 1e-9);
    const corner = { x: 0.2, y: 0.2, z: 0.2 }, seat = { x: 3.5, y: 1.3, z: 1.0 };
    // below the first mode a sealed room is a pressure vessel: +12 dB/oct towards DC relative to outdoors
    // (with real damping the walls leak it away below a few Hz, so test a nearly undamped room)
    const lo = RM.response(Object.assign({}, room, { rt60: 20 }), corner, seat, [4, 8]);
    near('room: pressure-vessel gain rises 12 dB/oct below the first mode', lo[0] - lo[1], 12, 1.5);
    // reciprocity: swap sub and seat, same answer
    const fr = RM.band(20, 120);
    const a = RM.response(room, corner, seat, fr), b = RM.response(room, seat, corner, fr);
    truthy('room: sub and seat can be swapped (reciprocity)', a.every((v, i) => Math.abs(v - b[i]) < 1e-9), '');
    // a seat at mid-length sits in the null of the first length mode
    const f100 = [c / (2 * room.L)];
    const atWall = RM.response(room, corner, { x: 5.3, y: 2.0, z: 1.0 }, f100)[0], atMid = RM.response(room, corner, { x: 2.75, y: 2.0, z: 1.0 }, f100)[0];
    truthy('room: mid-length seat misses the first length mode', atWall - atMid > 10, (atWall - atMid).toFixed(1) + ' dB');
    // two subs mirrored across the width cancel the odd width modes
    const f010 = [c / (2 * room.W)], seatSide = { x: 2.75, y: 0.3, z: 1.0 };
    const one = RM.response(room, corner, seatSide, f010)[0];
    const two = RM.response(room, RM.subsFor(room, { sub: corner, count: 2, mirror: 'width' }), seatSide, f010)[0];
    truthy('room: mirrored pair cancels the first width mode', one - two > 10, (one - two).toFixed(1) + ' dB');
    near('room: corner mirror goes to the opposite corner', RM.subsFor(room, { sub: corner, count: 2, mirror: 'both' })[1].x, room.L - 0.2, 1e-12);
    // more damping, smaller peaks and dips
    const ev = (rt) => RM.evenness(RM.response(Object.assign({}, room, { rt60: rt }), corner, seat, RM.band(20, 80))).sd;
    truthy('room: a damped room is smoother than a live one', ev(0.25) < ev(0.6), ev(0.25).toFixed(1) + ' vs ' + ev(0.6).toFixed(1) + ' dB');
    // placement scan
    const sc = RM.scan(room, { sub: corner, seat, count: 1 }, 'sub', 20, 80, 12);
    truthy('room: scan picks the smoothest spot away from the seat', sc.best && !sc.best.near && sc.cells.every(x => x.near || x.sd >= sc.best.sd), sc.best && sc.best.sd.toFixed(1));
    truthy('room: scan beats the corner here', sc.best.sd < ev(0.4), sc.best.sd.toFixed(1) + ' vs ' + ev(0.4).toFixed(1));
  }

  Promise.all(asyncTests).catch(e => truthy('async tests ran', false, e.message)).then(() => {
    // ---- render ----
    const out = document.getElementById('out');
    for (const r of results) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'}</td><td>${r.name}</td><td>${r.detail}</td>`;
      out.append(tr);
    }
    const failed = results.filter(r => !r.ok).length;
    document.getElementById('sum').textContent = `${results.length - failed} / ${results.length} passed`;
    window.TEST_RESULTS = { total: results.length, failed, results };
  });
})(window.GL);
