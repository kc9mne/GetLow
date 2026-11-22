/* GetLow – log-frequency line chart in SVG with crosshair tooltip. */
(function (GL) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  function niceStep(span, target) {
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  const LOG_MAJOR = [1, 2, 5];

  class Chart {
    constructor(host) {
      this.host = host;
      host.classList.add('chart');
      this.svg = s('svg', { class: 'chart-svg' });
      this.tip = document.createElement('div');
      this.tip.className = 'chart-tip';
      this.legend = document.createElement('div');
      this.legend.className = 'chart-legend';
      host.append(this.legend, this.svg, this.tip);
      // save as a picture or as data, from the corner of every chart
      this.saveBtn = document.createElement('button');
      this.saveBtn.className = 'chart-save';
      this.saveBtn.type = 'button';
      this.saveBtn.title = 'Save this chart';
      this.saveBtn.setAttribute('aria-label', 'Save this chart');
      this.saveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v8.5M4.5 6.5 8 10l3.5-3.5M2.5 11.5v2h11v-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      this.saveBtn.onclick = (e) => { e.stopPropagation(); this.saveMenu(); };
      host.append(this.saveBtn);
      this.cfg = null;
      new ResizeObserver(() => this.render()).observe(host);
      this.svg.addEventListener('mousemove', (e) => this.hover(e));
      this.svg.addEventListener('mouseleave', () => this.unhover());
    }

    set(cfg) { this.cfg = cfg; this.render(); }

    render() {
      const cfg = this.cfg;
      const svg = this.svg;
      svg.innerHTML = '';
      if (!cfg) return;
      const W = this.host.clientWidth, Hh = this.host.clientHeight - this.legend.offsetHeight;
      if (W < 50 || Hh < 50) return;
      svg.setAttribute('width', W); svg.setAttribute('height', Hh);
      const m = { l: 52, r: 16, t: 12, b: 30 };
      const pw = W - m.l - m.r, ph = Hh - m.t - m.b;
      const [f0, f1] = cfg.xRange;
      const lx0 = Math.log10(f0), lx1 = Math.log10(f1);
      const X = (f) => m.l + (Math.log10(f) - lx0) / (lx1 - lx0) * pw;

      // y range
      let lo = Infinity, hi = -Infinity;
      for (const se of cfg.series) {
        for (let i = 0; i < se.x.length; i++) {
          const f = se.x[i], v = se.y[i];
          if (f < f0 || f > f1 || !isFinite(v)) continue;
          if (v < lo) lo = v; if (v > hi) hi = v;
        }
      }
      for (const r of cfg.refs || []) { lo = Math.min(lo, r.y); hi = Math.max(hi, r.y); }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (cfg.span) { hi = Math.ceil((hi + 3) / 5) * 5; lo = Math.max(lo - 2, hi - cfg.span); }
      if (cfg.zero) lo = Math.min(0, lo);
      if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
      const step = niceStep(hi - lo, Math.max(3, Math.floor(ph / 45)));
      lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
      const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ph;
      this.geo = { m, pw, ph, X, Y, f0, f1, lx0, lx1, lo, hi };

      const grid = s('g', { class: 'grid' });
      for (let v = lo; v <= hi + step / 2; v += step) {
        grid.append(s('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v) }));
        const t = s('text', { x: m.l - 6, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' });
        t.textContent = +v.toFixed(step < 1 ? 2 : 0);
        svg.append(t);
      }
      for (let dec = Math.floor(lx0); dec <= Math.ceil(lx1); dec++) {
        for (let k = 1; k < 10; k++) {
          const f = k * Math.pow(10, dec);
          if (f < f0 * 0.999 || f > f1 * 1.001) continue;
          const major = LOG_MAJOR.includes(k);
          grid.append(s('line', { x1: X(f), x2: X(f), y1: m.t, y2: m.t + ph, class: major ? '' : 'minor' }));
          if (major) {
            const t = s('text', { x: X(f), y: m.t + ph + 18, class: 'tick', 'text-anchor': 'middle' });
            t.textContent = f >= 1000 && !cfg.xunit ? f / 1000 + 'k' : f;
            svg.append(t);
          }
        }
      }
      svg.prepend(grid);
      svg.append(s('line', { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, class: 'axis' }));
      const yl = s('text', { x: 12, y: m.t + ph / 2, class: 'axis-label', transform: `rotate(-90 12 ${m.t + ph / 2})`, 'text-anchor': 'middle' });
      yl.textContent = cfg.ylabel + (cfg.unit ? ' (' + cfg.unit + ')' : '');
      svg.append(yl);

      // reference lines (Xmax, port-velocity guideline ...)
      for (const r of cfg.refs || []) {
        if (r.y < lo || r.y > hi) continue;
        svg.append(s('line', { x1: m.l, x2: m.l + pw, y1: Y(r.y), y2: Y(r.y), class: 'ref' }));
        const t = s('text', { x: m.l + pw - 4, y: Y(r.y) - 5, class: 'ref-label', 'text-anchor': 'end' });
        t.textContent = r.label;
        svg.append(t);
      }

      const clip = 'clip' + Math.random().toString(36).slice(2, 7);
      const cp = s('clipPath', { id: clip });
      cp.append(s('rect', { x: m.l, y: m.t, width: pw, height: ph }));
      svg.append(cp);
      const lines = s('g', { 'clip-path': `url(#${clip})` });
      // reversed so series 1 (current design) paints on top
      for (const se of [...cfg.series].reverse()) {
        let d = '';
        for (let i = 0; i < se.x.length; i++) {
          const v = se.y[i];
          if (!isFinite(v)) continue;
          d += (d ? 'L' : 'M') + X(se.x[i]).toFixed(1) + ',' + Y(Math.max(lo - step, Math.min(hi + step, v))).toFixed(1);
        }
        lines.append(s('path', { d, class: 'series', style: `stroke:${se.color}`, 'stroke-dasharray': se.dash || '' }));
      }
      svg.append(lines);

      this.cross = s('line', { y1: m.t, y2: m.t + ph, class: 'cross', visibility: 'hidden' });
      this.dots = s('g', { visibility: 'hidden' });
      svg.append(this.cross, this.dots);

      // legend whenever there is more than one series
      this.legend.innerHTML = '';
      if (cfg.series.length > 1) {
        for (const se of cfg.series) {
          const it = document.createElement('span');
          it.className = 'lg-item';
          it.innerHTML = swatch(se);
          it.append(se.name);
          this.legend.append(it);
        }
      }
    }

    hover(e) {
      const g = this.geo, cfg = this.cfg;
      if (!g || !cfg) return;
      const r = this.svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      if (px < g.m.l || px > g.m.l + g.pw) return this.unhover();
      const f = Math.pow(10, g.lx0 + (px - g.m.l) / g.pw * (g.lx1 - g.lx0));
      this.cross.setAttribute('x1', px); this.cross.setAttribute('x2', px);
      this.cross.setAttribute('visibility', 'visible');
      this.dots.innerHTML = '';
      this.dots.setAttribute('visibility', 'visible');
      const rows = [];
      for (const se of cfg.series) {
        const v = interp(se.x, se.y, f);
        if (!isFinite(v)) continue;
        if (v >= g.lo && v <= g.hi) this.dots.append(s('circle', { cx: px, cy: g.Y(v), r: 4, class: 'dot', style: `fill:${se.color}` }));
        rows.push(`<div>${swatch(se)}${esc(se.name)}<b>${v.toFixed(cfg.digits ?? 1)} ${cfg.unit || ''}</b></div>`);
      }
      this.tip.innerHTML = `<div class="tip-f">${f < 100 ? f.toFixed(1) : f.toFixed(0)} ${cfg.xunit || 'Hz'}</div>` + rows.join('');
      this.tip.style.display = 'block';
      const tw = this.tip.offsetWidth;
      let left = px + 14;
      if (left + tw > r.width - 4) left = px - tw - 14;
      this.tip.style.left = left + 'px';
      this.tip.style.top = (this.legend.offsetHeight + g.m.t + 6) + 'px';
    }

    // ---- export ----
    name() { return (this.cfg && (this.cfg.title || this.cfg.ylabel)) || 'chart'; }
    fileBase() { return ('GetLow ' + (this.cfg && this.cfg.fileTitle ? this.cfg.fileTitle + ' ' : '') + this.name()).replace(/[^\w.-]+/g, '_'); }
    saveMenu() {
      const old = this.host.querySelector('.chart-menu');
      if (old) { old.remove(); return; }
      if (!this.cfg || !this.cfg.series.length) return;
      const menu = document.createElement('div');
      menu.className = 'chart-menu';
      const item = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = () => { menu.remove(); fn(); }; menu.append(b); };
      item('Picture (PNG)', () => this.savePng());
      item('Data (CSV)', () => GL.util.downloadText(this.fileBase() + '.csv', this.toCSV(), 'text/csv'));
      this.host.append(menu);
      const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); } };
      setTimeout(() => document.addEventListener('mousedown', off), 0);
    }
    // One column per curve on a shared frequency column when they share one;
    // otherwise a frequency and value column for each curve.
    toCSV() {
      const cfg = this.cfg, ser = cfg.series;
      const q = (t) => '"' + String(t).replace(/"/g, '""') + '"';
      const head = (se) => q(se.name + (cfg.unit ? ' (' + cfg.unit + ')' : ''));
      const xu = cfg.xunit || 'Hz';
      const same = ser.every(se => se.x.length === ser[0].x.length && Array.from(se.x).every((v, i) => Math.abs(v - ser[0].x[i]) <= 1e-9 * Math.max(1, v)));
      const num = (v) => isFinite(v) ? +(+v).toPrecision(6) : '';
      const lines = [];
      if (same) {
        lines.push([q('Frequency (' + xu + ')'), ...ser.map(head)].join(','));
        for (let i = 0; i < ser[0].x.length; i++) lines.push([num(ser[0].x[i]), ...ser.map(se => num(se.y[i]))].join(','));
      } else {
        lines.push(ser.flatMap(se => [q(se.name + ': frequency (' + xu + ')'), head(se)]).join(','));
        const n = Math.max(...ser.map(se => se.x.length));
        for (let i = 0; i < n; i++) lines.push(ser.flatMap(se => i < se.x.length ? [num(se.x[i]), num(se.y[i])] : ['', '']).join(','));
      }
      return lines.join('\r\n') + '\r\n';
    }
    // The chart as drawn (colours from the page's theme), with its title and legend, at twice the size.
    savePng() {
      const src = this.svg, W = +src.getAttribute('width'), H = +src.getAttribute('height');
      if (!W || !H) return;
      const cs = getComputedStyle(this.host);
      const bg = cs.getPropertyValue('--surface-1').trim() || '#fff', ink = cs.getPropertyValue('--text-primary').trim() || '#111', ink2 = cs.getPropertyValue('--text-secondary').trim() || '#555';
      const clone = src.cloneNode(true);
      // copy the computed look onto each element, so the picture doesn't need the page's CSS
      const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'fill-opacity', 'opacity', 'font-size', 'font-family', 'font-weight', 'visibility'];
      const a = src.querySelectorAll('*'), b = clone.querySelectorAll('*');
      for (let i = 0; i < a.length; i++) {
        const st = getComputedStyle(a[i]);
        b[i].setAttribute('style', props.map(p => p + ':' + st.getPropertyValue(p)).join(';'));
      }
      for (const el of clone.querySelectorAll('.cross, .dot')) el.remove();
      // title and legend above the plot
      const ser = this.cfg.series, lgH = 18, perRow = Math.max(1, Math.floor((W - 60) / 230));
      const rows = ser.length > 1 ? Math.ceil(ser.length / perRow) : 0, top = 30 + rows * lgH + (rows ? 6 : 0);
      const out = s('svg', { xmlns: NS, width: W, height: H + top + 8, viewBox: `0 0 ${W} ${H + top + 8}` });
      out.append(s('rect', { x: 0, y: 0, width: W, height: H + top + 8, fill: bg }));
      const title = s('text', { x: 52, y: 20, fill: ink, 'font-size': 14, 'font-weight': 600, 'font-family': 'system-ui, sans-serif' });
      title.textContent = (this.cfg.fileTitle ? this.cfg.fileTitle + ' · ' : '') + this.name();
      out.append(title);
      ser.forEach((se, i) => {
        if (ser.length < 2) return;
        const x = 52 + (i % perRow) * 230, y = 30 + Math.floor(i / perRow) * lgH + 9;
        const col = se.color.startsWith('var(') ? cs.getPropertyValue(se.color.slice(4, -1).trim()).trim() || ink : se.color;
        out.append(s('line', { x1: x, y1: y - 4, x2: x + 18, y2: y - 4, stroke: col, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-dasharray': se.dash || '' }));
        const t = s('text', { x: x + 24, y, fill: ink2, 'font-size': 12, 'font-family': 'system-ui, sans-serif' });
        t.textContent = se.name.length > 34 ? se.name.slice(0, 33) + '…' : se.name;
        out.append(t);
      });
      const g = s('g', { transform: `translate(0 ${top})` });
      while (clone.firstChild) g.append(clone.firstChild);
      out.append(g);
      const text = new XMLSerializer().serializeToString(out);
      const img = new Image();
      img.onload = () => {
        const k = 2, c = document.createElement('canvas');
        c.width = W * k; c.height = (H + top + 8) * k;
        const g2 = c.getContext('2d');
        g2.scale(k, k);
        g2.drawImage(img, 0, 0);
        c.toBlob((blob) => GL.util.downloadBlob(this.fileBase() + '.png', blob), 'image/png');
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    }

    unhover() {
      if (this.cross) this.cross.setAttribute('visibility', 'hidden');
      if (this.dots) this.dots.setAttribute('visibility', 'hidden');
      this.tip.style.display = 'none';
    }
  }

  // legend / tooltip key: a short stretch of the line itself, so dashes show
  const swatch = (se) => `<svg class="lg-line" width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" style="stroke:${se.color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${se.dash ? se.dash.split(' ').map(v => Math.max(1, v * 0.6)).join(' ') : ''}"/></svg>`;
  const esc = (t) => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // log-frequency interpolation on a sorted grid
  function interp(xs, ys, f) {
    const n = xs.length;
    if (f <= xs[0]) return ys[0];
    if (f >= xs[n - 1]) return ys[n - 1];
    let a = 0, b = n - 1;
    while (b - a > 1) { const mid = (a + b) >> 1; if (xs[mid] > f) b = mid; else a = mid; }
    const t = (Math.log(f) - Math.log(xs[a])) / (Math.log(xs[b]) - Math.log(xs[a]));
    return ys[a] + (ys[b] - ys[a]) * t;
  }

  GL.Chart = Chart;
  GL.interp = interp;
})(window.GL);
