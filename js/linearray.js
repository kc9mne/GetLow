/* GetLow – line arrays of small drivers.
 *
 * Follows Ureda, "Analysis of Loudspeaker Line Arrays" (JAES 52(5), 2004), but
 * with discrete elements instead of continuous lines, so the same sums handle
 * straight, arc, J, progressive (arithmetic splay) and hand-set splays, gaps
 * between drivers and the grating lobes they cause. Each element is the
 * current GetLow design (a driver in its box) radiating as a rigid piston, so
 * its frequency response and beaming are included.
 *
 * Side view, metres: x forward from the top element's face, y up from the
 * floor. Angles: 0 = straight ahead, positive = aimed down.
 *
 *   p(P) = Σ w_i · D(θ_i) · e^(−jk·r_i − jω·τ_i) / r_i       (near field, pressure fields)
 *   R(α) = |Σ w_i · D(θ_i) · e^(jk·(r_i · û(α)))| / Σ w_i      (far-field polar)
 *
 * Shading w_i: uniform, Hann, or Keele's CBT Legendre taper
 *   w(u) = 1 + 0.066u − 1.8691u² + 0.9293u³   (u = 0 at the axis, 1 at the end)
 * Electronic tilt: delays τ_i that line up the elements towards angle β.
 * Floor and ceiling: image sources (rigid surfaces).
 */
(function (GL) {
  'use strict';
  const c0 = () => GL.phys.c;
  const D2R = Math.PI / 180;
  const piston = (ka, s) => GL.baffle.piston(ka, s);

  // ---------------------------------------------------------------- layout
  // Splay (degrees) between element i and i+1, for i = 0 .. N−2.
  function splays(a) {
    const N = a.n, out = [];
    for (let i = 0; i < N - 1; i++) {
      let s = 0;
      if (a.shape === 'arc') s = a.angle / Math.max(1, N - 1);
      else if (a.shape === 'j') s = i + 1 < a.straight ? 0 : a.angle / Math.max(1, N - a.straight);
      else if (a.shape === 'progressive') s = (i + 1) * 2 * a.angle / (N * (N - 1));      // 1Δ, 2Δ, 3Δ … adding up to the terminal angle
      else if (a.shape === 'custom') s = +((a.custom || '').split(/[,\s]+/).filter(Boolean)[i]) || 0;
      out.push(s);
    }
    return out;
  }

  // Elements: centre (x, y), aim (radians, + down), face height h, cone radius r, gain w, delay τ.
  function elements(a, coneR) {
    const N = Math.max(1, Math.round(a.n)), sp = splays(a), els = [];
    let aim = (a.tilt || 0) * D2R, x = 0, y = a.top - a.pitch / 2;
    for (let i = 0; i < N; i++) {
      if (i) {
        // walk down the faces: half a pitch along the last face, turn, half along this one
        const t0 = [-Math.sin(aim), -Math.cos(aim)];
        aim += sp[i - 1] * D2R;
        const t1 = [-Math.sin(aim), -Math.cos(aim)];
        x += a.pitch / 2 * (t0[0] + t1[0]); y += a.pitch / 2 * (t0[1] + t1[1]);
      }
      els.push({ x, y, aim, r: coneR });
    }
    // shading
    const mid = (N - 1) / 2;
    els.forEach((e, i) => {
      let w = 1;
      if (a.shade === 'hann') w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (N + 1));
      else if (a.shade === 'legendre') {
        // from the floor up when the array stands on it (its mirror image makes the other half)
        const u = a.place !== 'free' ? (N - 1 - i) / Math.max(1, N - 1) : Math.abs(i - mid) / Math.max(1, mid);
        w = Math.max(0, 1 + 0.066 * u - 1.8691 * u * u + 0.9293 * u * u * u);
      }
      e.w = w;
    });
    // electronic tilt: delays that grow down the array by height, the way a
    // straight line is steered. On a curved array this tilts the whole
    // pattern by about β without undoing the curve. (0 = no delays at all.)
    const b = (a.steer || 0) * D2R;
    const proj = els.map(e => -e.y * Math.sin(b));
    const pmin = Math.min(...proj);
    els.forEach((e, i) => { e.tau = b ? (proj[i] - pmin) / c0() : 0; });
    return els;
  }

  // Mirror images in a rigid floor (y = 0) and ceiling (y = H): [{ y-map, flip }]
  function images(a) {
    const out = [{ s: 1, o: 0, g: 1 }];
    if (a.place === 'floor' || a.place === 'both') out.push({ s: -1, o: 0, g: 1 });
    if (a.place === 'both') {
      const H = a.ceiling;
      // alternate reflections between floor and ceiling, a few orders
      for (let k = 1; k <= 4; k++) {
        out.push({ s: 1, o: 2 * k * H, g: 1 }, { s: 1, o: -2 * k * H, g: 1 }, { s: -1, o: 2 * k * H, g: 1 }, { s: -1, o: -2 * k * H, g: 1 });
      }
    }
    return out;
  }

  // Directivity of one element towards a direction at angle th from its axis:
  // a rigid piston in front; behind, the box wraps the sound round at low
  // frequency and shades it at high frequency.
  // e.r: cone radius (number, or a function of frequency when the cone breaks up);
  // e.rect: height of a ribbon / AMT (a rectangle: sin x / x vertically).
  function elemD(k, e, th, boxR) {
    const a = Math.abs(th);
    const front = (s) => {
      if (e.rect) { const x = k * e.rect / 2 * s; return Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x; }
      const r = typeof e.r === 'function' ? e.r(k * c0() / (2 * Math.PI)) : e.r;
      return piston(k * r, s);
    };
    if (a <= Math.PI / 2) return front(Math.sin(a));
    const side = front(1), g = 1 / Math.sqrt(1 + Math.pow(k * boxR, 2));
    return side * (1 - (1 - g) * Math.sin(a - Math.PI / 2));
  }

  // A second line (tweeters) along the same curve, centred on the first:
  // positions and aims are interpolated along the main line's chain.
  function tweeterElements(main, mainPitch, t) {
    const n = Math.max(1, Math.round(t.n)), L = main.length * mainPitch;
    const s0 = L / 2 - n * t.pitch / 2;
    const at = (s) => {
      // s = distance from the top of the main line along its faces
      const u = Math.max(0, Math.min(main.length - 1, s / mainPitch - 0.5));
      const i = Math.min(main.length - 2, Math.floor(u)), f = u - i;
      if (main.length < 2) return { x: main[0].x, y: main[0].y - (s - mainPitch / 2), aim: main[0].aim };
      const A = main[i], B = main[i + 1];
      // beyond either end: carry on along the end element's face
      if (s / mainPitch - 0.5 < 0 || s / mainPitch - 0.5 > main.length - 1) {
        const E = s / mainPitch - 0.5 < 0 ? main[0] : main[main.length - 1], d = s - (main.indexOf(E) + 0.5) * mainPitch;
        return { x: E.x - Math.sin(E.aim) * d, y: E.y - Math.cos(E.aim) * d, aim: E.aim };
      }
      return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, aim: A.aim + (B.aim - A.aim) * f };
    };
    const out = [];
    for (let j = 0; j < n; j++) {
      const p = at(s0 + (j + 0.5) * t.pitch);
      out.push({ x: p.x, y: p.y, aim: p.aim, r: t.type === 'ribbon' ? 0 : t.size / 2, rect: t.type === 'ribbon' ? t.size : 0, w: 1, tau: 0, tw: true });
    }
    return out;
  }

  // Complex pressure at point (px, py) for frequency f (per unit element source), summed over elements and images.
  function pressureAt(els, imgs, f, px, py, boxR) {
    const w = 2 * Math.PI * f, k = w / c0();
    let re = 0, im = 0;
    for (const img of imgs) {
      for (const e of els) {
        const ey = img.s * e.y + img.o, aim = img.s * e.aim;
        const dx = px - e.x, dy = py - ey, r = Math.max(1e-3, Math.hypot(dx, dy));
        const th = Math.atan2(-dy, dx) - aim;                 // angle off the element's axis (+ down)
        let amp = e.w * elemD(k, e, Math.atan2(Math.sin(th), Math.cos(th)), boxR) * img.g / r;
        let ph = -k * r - w * e.tau;
        if (e.src) { const q = e.src(f); amp *= Math.hypot(q.re, q.im); ph += Math.atan2(q.im, q.re); }
        re += amp * Math.cos(ph); im += amp * Math.sin(ph);
      }
    }
    return { re, im };
  }

  // Far-field polar (free field, no floor): |R(α)| for α in degrees (0 = ahead, + down).
  function polar(els, f, angles, boxR) {
    const w = 2 * Math.PI * f, k = w / c0();
    const cx = els.reduce((s, e) => s + e.x, 0) / els.length, cy = els.reduce((s, e) => s + e.y, 0) / els.length;
    const W = els.reduce((s, e) => s + e.w, 0) || 1;
    return angles.map(adeg => {
      const al = adeg * D2R, u = [Math.cos(al), -Math.sin(al)];
      let re = 0, im = 0;
      for (const e of els) {
        const th = al - e.aim;
        let amp = e.w * elemD(k, e, Math.atan2(Math.sin(th), Math.cos(th)), boxR);
        let ph = k * ((e.x - cx) * u[0] + (e.y - cy) * u[1]) - w * e.tau;
        if (e.src) { const q = e.src(f); amp *= Math.hypot(q.re, q.im); ph += Math.atan2(q.im, q.re); }
        re += amp * Math.cos(ph); im += amp * Math.sin(ph);
      }
      return Math.hypot(re, im) / W;
    });
  }

  // −6 dB coverage: the included angle of the main lobe (degrees), and where it points.
  function beamwidth(els, f, boxR) {
    const angs = [];
    for (let a = -90; a <= 90; a += 0.25) angs.push(a);
    const R = polar(els, f, angs, boxR);
    let iMax = 0;
    R.forEach((v, i) => { if (v > R[iMax]) iMax = i; });
    const lim = R[iMax] / 2;
    let lo = iMax, hi = iMax;
    while (lo > 0 && R[lo] > lim) lo--;
    while (hi < R.length - 1 && R[hi] > lim) hi++;
    return { width: angs[hi] - angs[lo], aim: angs[iMax], up: angs[lo], down: angs[hi], open: R[lo] > lim || R[hi] > lim };
  }

  // Pressure field (dB re the loudest point beyond minR), nx × ny over [0, xmax] × [y0, y1].
  function field(els, imgs, f, xmax, y0, y1, nx, ny, boxR, minR = 0.3) {
    const out = new Float32Array(nx * ny);
    let max = -Infinity;
    for (let j = 0; j < ny; j++) {
      const py = y1 - (j + 0.5) * (y1 - y0) / ny;
      for (let i = 0; i < nx; i++) {
        const px = (i + 0.5) * xmax / nx;
        const p = pressureAt(els, imgs, f, px, py, boxR);
        const v = 20 * Math.log10(Math.max(1e-12, Math.hypot(p.re, p.im)));
        out[j * nx + i] = v;
        if (px > minR && v > max) max = v;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] -= max;
    return out;
  }

  // Practical limits from the spacing (Urban et al. / Ureda):
  //  - acts as one continuous line while the pitch is under half a wavelength
  //  - grating lobes once the pitch passes a wavelength
  //  - near field reaches about (3/2)·f·L²·√(1 − 1/(3fL)²)  (f in kHz, L in m → metres)
  function limits(a, coneD) {
    const c = c0(), N = Math.round(a.n);
    const L = N * a.pitch;
    const near = (f) => { const F = f / 1000, x = 3 * F * L; return x > 1 ? 1.5 * F * L * L * Math.sqrt(1 - 1 / (x * x)) : 0; };
    return { length: L, continuous: c / (2 * a.pitch), grating: c / a.pitch, fill: Math.min(1, coneD / a.pitch), near };
  }

  GL.linearray = { splays, elements, tweeterElements, images, pressureAt, polar, beamwidth, field, limits, elemD };
})(window.GL);
