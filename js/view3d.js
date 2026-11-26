/* GetLow – 3D preview of the enclosure (Three.js, loaded from CDN). */
(function (GL) {
  'use strict';

  const WOOD = 0xc9a26b, PVC = 0xd9dde3, DARK = 0x2a2a2a, METAL = 0x77797d;
  const BAD = 0xd64545;

  function cssColor(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  class BoxView {
    constructor(host) {
      this.host = host;
      this.ok = typeof THREE !== 'undefined';
      if (!this.ok) {
        host.innerHTML = '<div class="empty">3D view needs an internet connection the first time (Three.js loads from a CDN).</div>';
        return;
      }
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      host.appendChild(this.renderer.domElement);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
      const sun = new THREE.DirectionalLight(0xffffff, 0.7);
      sun.position.set(2, 3, 4);
      this.scene.add(sun);
      const fill = new THREE.DirectionalLight(0xffffff, 0.25);
      fill.position.set(-3, -1, -2);
      this.scene.add(fill);
      this.group = new THREE.Group();
      this.scene.add(this.group);
      this.orbit = { theta: -0.6, phi: 1.1, r: 2 };
      this.size = 1;
      this.bindControls();
      new ResizeObserver(() => this.resize()).observe(host);
      this.resize();
    }

    bindControls() {
      const el = this.renderer.domElement;
      let drag = null;
      el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); });
      el.addEventListener('pointerup', () => { drag = null; });
      el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        this.orbit.theta -= (e.clientX - drag.x) * 0.008;
        this.orbit.phi = Math.min(3.0, Math.max(0.15, this.orbit.phi - (e.clientY - drag.y) * 0.008));
        drag = { x: e.clientX, y: e.clientY };
        this.draw();
      });
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.orbit.r = Math.min(this.size * 8, Math.max(this.size * 0.8, this.orbit.r * (e.deltaY > 0 ? 1.1 : 0.9)));
        this.draw();
      }, { passive: false });
    }

    resize() {
      if (!this.ok) return;
      const w = this.host.clientWidth, h = this.host.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.draw();
    }

    draw() {
      if (!this.ok) return;
      const o = this.orbit;
      this.camera.position.set(
        o.r * Math.sin(o.phi) * Math.sin(o.theta),
        o.r * Math.cos(o.phi),
        o.r * Math.sin(o.phi) * Math.cos(o.theta));
      this.camera.lookAt(0, 0, 0);
      this.renderer.render(this.scene, this.camera);
    }

    clear() {
      for (const c of [...this.group.children]) {
        this.group.remove(c);
        c.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) n.material.dispose(); });
      }
    }

    fit(size) {
      const first = this.size === 1;
      const ratio = size / this.size;
      this.size = size;
      this.orbit.r = first ? size * 2.4 : this.orbit.r * ratio;
    }

    // ---- primitives ----
    panel(w, h, d, x, y, z, opts) {
      const mat = new THREE.MeshStandardMaterial({ color: opts.color ?? WOOD, roughness: 0.85,
        transparent: opts.opacity < 1, opacity: opts.opacity, depthWrite: opts.opacity >= 1 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry),
        new THREE.LineBasicMaterial({ color: 0x5b4426, transparent: true, opacity: 0.6 }));
      m.add(edges);
      this.group.add(m);
      return m;
    }
    air(w, h, d, x, y, z, color) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.16, depthWrite: false }));
      m.position.set(x, y, z);
      this.group.add(m);
    }
    // driver whose cone faces along +axis vector `dir`, mounted at point p
    driver(p, dir, r) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.93, r * 0.07, 10, 48), new THREE.MeshStandardMaterial({ color: METAL, roughness: 0.5 }));
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 0.86, r * 0.45, 48, 1, true),
        new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.9, side: THREE.DoubleSide }));
      ring.rotation.x = Math.PI / 2;          // torus lies flat in the mounting plane
      cone.rotation.x = Math.PI;              // open side toward +y
      cone.position.y = -r * 0.225 + 0.002;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r * 0.22, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6 }));
      cap.position.y = -r * 0.3;
      const magnet = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, r * 0.35, 32),
        new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.4 }));
      magnet.position.y = -r * 0.62;
      g.add(ring, cone, cap, magnet);
      this.orient(g, dir);
      g.position.copy(p);
      this.group.add(g);
    }
    // Round port along its route: one lathe per leg, a ball at each bend.
    portRoute(route, pt, exF) {
      const wall = pt.wall || 0;
      const prof = GL.enclosures.portProfile(pt);
      const mat = new THREE.MeshStandardMaterial({ color: route.fits ? 0x3d3d3d : BAD, roughness: 0.7, side: THREE.DoubleSide });
      const at = (x) => {               // radius at distance x from the outer end
        for (let i = 1; i < prof.length; i++) {
          const [x0, r0] = prof[i - 1], [x1, r1] = prof[i];
          if (x <= x1 || i === prof.length - 1) return x1 > x0 ? r0 + (r1 - r0) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : r1;
        }
        return prof[0][1];
      };
      let s0 = 0;
      route.legs.forEach((leg, i) => {
        const s1 = i === route.legs.length - 1 ? Math.max(pt.len, s0 + leg.len) : s0 + leg.len;
        const xs = [s0, ...prof.map(q => q[0]).filter(x => x > s0 && x < s1), s1];
        const pts = xs.map(x => new THREE.Vector2(at(x) + wall / 2, x - s0));
        const g = new THREE.Group();
        g.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 40), mat));
        this.orient(g, new THREE.Vector3(...leg.dir));
        g.position.set(leg.from[0], leg.from[1], leg.from[2] + exF);
        this.group.add(g);
        if (i > 0) {
          const ball = new THREE.Mesh(new THREE.SphereGeometry(pt.d / 2 + wall / 2, 24, 16), mat);
          ball.position.set(leg.from[0], leg.from[1], leg.from[2] + exF);
          this.group.add(ball);
        }
        s0 = s1;
      });
    }
    // Slot panels, rounded corners and fillets: outlines in the slot's own
    // frame (a = into the chamber, c = away from its wall), extruded along its span.
    slotPieces(route, shift, opts) {
      const f = route.frame;
      const ax = (i, s) => { const v = new THREE.Vector3(); v.setComponent(i, s); return v; };
      const X = ax(f.ib, f.sb), Y = ax(f.iN, -f.sN), Z = ax(f.im, 1);
      const O = new THREE.Vector3(); O.setComponent(f.ib, f.face); O.setComponent(f.iN, f.wallEdge); O.setComponent(f.im, f.e0);
      O.z += shift;
      const M = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(O);
      const mat = new THREE.MeshStandardMaterial({ color: opts.color ?? WOOD, roughness: 0.85, side: THREE.DoubleSide,
        transparent: opts.opacity < 1, opacity: opts.opacity, depthWrite: opts.opacity >= 1 });
      for (const pc of route.pieces) {
        const sh = new THREE.Shape(pc.poly.map(([a, c]) => new THREE.Vector2(a, c)));
        const g = new THREE.ExtrudeGeometry(sh, { depth: f.e1 - f.e0, bevelEnabled: false, curveSegments: 12 });
        g.applyMatrix4(M);
        const m = new THREE.Mesh(g, mat);
        m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: 0x5b4426, transparent: true, opacity: 0.6 })));
        this.group.add(m);
      }
    }
    disc(p, dir, r) {
      const g = new THREE.Group();
      const d = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r * 0.85, r * 0.06, 48),
        new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.6 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.93, r * 0.07, 10, 48), new THREE.MeshStandardMaterial({ color: METAL }));
      ring.rotation.x = Math.PI / 2;
      g.add(d, ring);
      this.orient(g, dir);
      g.position.copy(p);
      this.group.add(g);
    }
    // rotate a group built around +y so +y points along dir
    orient(g, dir) {
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    }

    // ---- scenes ----
    update(spec) {
      if (!this.ok) return;
      this.clear();
      if (spec.kind === 'line') this.buildLine(spec);
      else if (spec.kind === 'horn') this.buildHorn(spec);
      else this.buildBox(spec);
      this.draw();
    }

    buildBox({ design, box, layout, drvc, xray, explode }) {
      const { W, H, D } = box.ext, t = box.t;
      const op = xray ? 0.28 : 1;
      const ex = explode ? Math.max(W, H, D) * 0.18 : 0;
      const intD = D - t * (1 + box.layers);
      const zBack = -D / 2 + t, zFront = D / 2 - t * box.layers, zMid = (zBack + zFront) / 2;
      const o = { opacity: op };
      this.fit(Math.max(W, H, D));

      this.panel(W, t, D, 0, H / 2 - t / 2 + ex, 0, o);
      this.panel(W, t, D, 0, -H / 2 + t / 2 - ex, 0, o);
      this.panel(t, H - 2 * t, D, -W / 2 + t / 2 - ex, 0, 0, o);
      this.panel(t, H - 2 * t, D, W / 2 - t / 2 + ex, 0, 0, o);
      this.panel(W - 2 * t, H - 2 * t, t, 0, 0, -D / 2 + t / 2 - ex, o);
      for (let i = 0; i < box.layers; i++) {
        this.panel(W - 2 * t, H - 2 * t, t, 0, 0, D / 2 - t / 2 - i * t + ex * (1 + i * 0.4), { opacity: xray ? 0.22 : 1 });
      }

      const alongW = box.split === 'W';
      const iw = W - 2 * t, ih = H - 2 * t;
      const colors = ['--series-1', '--series-2', '--series-3'].map((v, i) => cssColor(v, ['#2a78d6', '#eb6834', '#1baf7a'][i]));
      const region = {};
      layout.chambers.forEach((c, i) => {
        const a0 = (alongW ? -W / 2 : -H / 2) + c.start;
        const a1 = a0 + c.len;
        region[c.id] = { a0, a1, i };
        if (alongW) this.air(c.len, ih, intD, (a0 + a1) / 2, 0, zMid, colors[i % 3]);
        else this.air(iw, c.len, intD, 0, (a0 + a1) / 2, zMid, colors[i % 3]);
        if (i < layout.chambers.length - 1) {
          const pos = a1 + t / 2;
          if (alongW) this.panel(t, ih, intD, pos, 0, zMid, { opacity: xray ? 0.4 : 1 });
          else this.panel(iw, t, intD, 0, pos, zMid, { opacity: xray ? 0.4 : 1 });
        }
      });

      const plan = GL.placement.plan(design, box, layout, drvc.params);
      const exF = ex * (box.layers > 0 ? 1 : 0);
      const V = (P, shift) => new THREE.Vector3(P[0], P[1], P[2] + (shift ? exF : 0));
      for (const d of plan.drivers) {
        const dir = new THREE.Vector3(...d.dir), pos = V(d.pos, d.front);
        this.driver(pos, dir, d.r);
        if (d.iso === 'clamshell') {
          // second driver outside, cone to cone, magnet facing out
          this.driver(pos.clone().add(dir.clone().multiplyScalar(d.r * 0.5)), dir.clone().negate(), d.r);
        } else if (d.iso === 'tunnel') {
          // second driver behind the first, inside a sealed sleeve
          const back = dir.clone().negate();
          this.driver(pos.clone().add(back.clone().multiplyScalar(d.one + 0.01)), dir, d.r);
          const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(d.r, d.r, d.one + 0.01, 40, 1, true),
            new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.85, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
          const g = new THREE.Group();
          g.add(sleeve);
          this.orient(g, back);
          g.position.copy(pos.clone().add(back.clone().multiplyScalar((d.one + 0.01) / 2)));
          this.group.add(g);
        }
      }
      for (const r of plan.prs) this.disc(V(r.pos, true), new THREE.Vector3(...r.dir), r.r);
      // braces: window frames and dowels
      const bo = { opacity: xray ? 0.5 : 1 };
      for (const br of plan.braces) {
        for (const sd of br.solids) {
          if (sd.type === 'box') {
            this.panel(sd.max[0] - sd.min[0], sd.max[1] - sd.min[1], sd.max[2] - sd.min[2], (sd.min[0] + sd.max[0]) / 2, (sd.min[1] + sd.max[1]) / 2, (sd.min[2] + sd.max[2]) / 2, bo);
          } else {
            const a = new THREE.Vector3(...sd.a), b = new THREE.Vector3(...sd.b);
            const rod = new THREE.Mesh(new THREE.CylinderGeometry(sd.r, sd.r, a.distanceTo(b), 20),
              new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.8, transparent: xray, opacity: xray ? 0.7 : 1 }));
            const g = new THREE.Group();
            g.add(rod);
            this.orient(g, b.clone().sub(a));
            g.position.copy(a.clone().add(b).multiplyScalar(0.5));
            this.group.add(g);
          }
        }
      }
      for (const { pt, route } of plan.ports) {
        const shift = route.front ? exF : 0;
        if (route.kind === 'round') { this.portRoute(route, pt, shift); continue; }
        // slot: dark opening plus its wall panels
        const [o0, o1] = route.opening;
        const open = new THREE.Mesh(new THREE.BoxGeometry(o1[0] - o0[0], o1[1] - o0[1], o1[2] - o0[2]), new THREE.MeshBasicMaterial({ color: 0x111111 }));
        open.position.set((o0[0] + o1[0]) / 2, (o0[1] + o1[1]) / 2, (o0[2] + o1[2]) / 2 + shift + (route.front ? 0.001 : 0));
        this.group.add(open);
        const po = { opacity: Math.max(op, 0.6), color: route.fits ? null : BAD };
        if (route.pieces) this.slotPieces(route, shift, po);
        else for (const pn of route.panels) {
          const [m0, m1] = pn.box;
          this.panel(m1[0] - m0[0], m1[1] - m0[1], m1[2] - m0[2], (m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2, (m0[2] + m1[2]) / 2 + shift, po);
        }
      }
    }

    buildLine({ design, lineLay, drvc }) {
      if (arguments[0].fold) return this.buildFold(arguments[0]);
      const L = design.line;
      const len = L.length;
      const p = drvc.params;
      const rDrv = (p.dia > 0 ? p.dia / 2 : Math.sqrt(p.sd / Math.PI) * 1.18);
      const rearVol = lineLay.rearGross;
      const side = rearVol > 0 ? Math.cbrt(rearVol) : 0;
      this.fit(len + side);
      const x0 = -(len + side) / 2 + side;   // closed end of line
      const xAxis = new THREE.Vector3(1, 0, 0);

      if (L.shape === 'round') {
        const r0 = L.d0 / 2, rL = L.dL / 2;
        const m = new THREE.Mesh(new THREE.CylinderGeometry(rL, r0, len, 48, 1, true),
          new THREE.MeshStandardMaterial({ color: PVC, roughness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }));
        m.rotation.z = -Math.PI / 2;           // cylinder +y -> +x
        m.position.x = x0 + len / 2;
        this.group.add(m);
        const edge = new THREE.Mesh(new THREE.TorusGeometry(rL, Math.max(0.003, rL * 0.04), 8, 48), new THREE.MeshStandardMaterial({ color: 0x9aa0a8 }));
        edge.rotation.y = Math.PI / 2;
        edge.position.x = x0 + len;
        this.group.add(edge);
      } else {
        const w = L.width;
        const geo = frustumRect(len, w, L.h0, L.hL);
        const air = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.85, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false }));
        air.position.x = x0;
        air.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x5b4426 })));
        this.group.add(air);
      }

      if (GL.enclosures.endPort(design)) {
        // the end port: a short dark tube on the end of the line
        const pt = L.port, pr = pt.shape === 'slot' ? Math.sqrt(pt.w * pt.h / Math.PI) : pt.d / 2;
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr, Math.max(pt.len, 0.005), 32, 1, true), new THREE.MeshStandardMaterial({ color: DARK, side: THREE.DoubleSide }));
        if ((pt.at || 0) > 0) {
          // on the baffle (the driver's side), up from the closed end of the line
          tube.rotation.x = Math.PI / 2;
          tube.position.set(x0 + len - pt.at, 0, (L.width / 2) - Math.max(pt.len, 0.005) / 2 + 0.002);
        } else {
          tube.rotation.z = -Math.PI / 2;
          tube.position.x = x0 + len + Math.max(pt.len, 0.005) / 2;
        }
        this.group.add(tube);
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(L.width, L.hL), new THREE.MeshStandardMaterial({ color: WOOD, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
        cap.rotation.y = Math.PI / 2; cap.position.x = x0 + len;
        if (L.shape !== 'round') this.group.add(cap);
      }
      const xd = x0 + GL.enclosures.drvAt(design) * len;
      if (design.mount.front !== 'line' && L.shape === 'round' && !L.mountSide) {
        // a tube's driver sits in the end cap, firing out of the closed end
        this.driver(new THREE.Vector3(x0, 0, 0), new THREE.Vector3(-1, 0, 0), Math.min(rDrv, L.d0 / 2));
      } else if (design.mount.front === 'line') {
        // driver at (or near) the closed end firing down the pipe
        this.driver(new THREE.Vector3(xd, 0, 0), xAxis, Math.min(rDrv, (L.d0 || L.h0) / 2));
        if (side > 0) this.panel(side, side, side, x0 - side / 2, 0, 0, { opacity: 0.5 });
      } else {
        // rear-loaded line: driver on the side wall, rear facing into the line
        const zOff = (L.shape === 'round' ? L.d0 / 2 : L.width / 2);
        this.driver(new THREE.Vector3(xd + rDrv, 0, zOff), new THREE.Vector3(0, 0, 1), rDrv);
      }
    }
  }

  // Folded transmission line: walls see-through, dividers, 45° corner blocks, driver and mouth.
  // a runs along the legs from the closed end's end wall, z back from the inside of the front.
  BoxView.prototype.buildFold = function ({ design, drvc, fold: r }) {
    const f = r.fold, t = r.t, w = r.w, vert = f.legs === 'vertical', flip = f.start === 'bottom';
    this.fit(Math.max(r.ext.W, r.ext.H, r.ext.D));
    const M = (a, z, u) => {
      const aa = (flip ? -1 : 1) * (a - r.Lin / 2), zz = r.Din / 2 - z;
      return vert ? new THREE.Vector3(u, -aa, zz) : new THREE.Vector3(aa, u, zz);
    };
    // a convex outline in (a, z), extruded across the width from u0 to u1
    const solid = (pts, u0, u1, color, opacity) => {
      const pos = [];
      const P = (i, u) => M(pts[i][0], pts[i][1], u);
      const tri = (p, q, s2) => pos.push(p.x, p.y, p.z, q.x, q.y, q.z, s2.x, s2.y, s2.z);
      for (let i = 1; i < pts.length - 1; i++) { tri(P(0, u0), P(i, u0), P(i + 1, u0)); tri(P(0, u1), P(i + 1, u1), P(i, u1)); }
      for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; tri(P(i, u0), P(j, u0), P(j, u1)); tri(P(i, u0), P(j, u1), P(i, u1)); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), new THREE.LineBasicMaterial({ color: 0x5b4426, transparent: true, opacity: 0.6 })));
      this.group.add(m);
    };
    const rect = (a0, a1, z0, z1) => [[a0, z0], [a1, z0], [a1, z1], [a0, z1]];
    const hw = w / 2, op = 0.22;
    // outer walls: the two that show the fold, front, back, and the two ends
    solid(rect(-t, r.Lin + t, -t, r.Din + t), -hw - t, -hw, WOOD, op);
    solid(rect(-t, r.Lin + t, -t, r.Din + t), hw, hw + t, WOOD, op);
    solid(rect(0, r.Lin, -t, 0), -hw, hw, WOOD, op);
    solid(rect(0, r.Lin, r.Din, r.Din + t), -hw, hw, WOOD, op);
    solid(rect(-t, 0, -t, r.Din + t), -hw, hw, WOOD, op);
    solid(rect(r.Lin, r.Lin + t, -t, r.Din + t), -hw, hw, WOOD, op);
    // dividers
    const zAt = (dv, a) => dv.zA + (dv.zB - dv.zA) * a / r.Lin;
    for (const dv of r.dividers) {
      const a0 = dv.from === 'A' ? 0 : r.Lin - dv.len, a1 = dv.from === 'A' ? dv.len : r.Lin;
      solid([[a0, zAt(dv, a0)], [a1, zAt(dv, a1)], [a1, zAt(dv, a1) + t], [a0, zAt(dv, a0) + t]], -hw, hw, WOOD, 1);
    }
    // corner blocks
    const edge = (k, end) => { let z = 0; for (let j = 0; j < k; j++) z += (end === 'A' ? r.legs[j].hA : r.legs[j].hB) + t; return [z, z + (end === 'A' ? r.legs[k].hA : r.legs[k].hB)]; };
    for (const df of r.defl) {
      const a = df.at === 'A' ? 0 : r.Lin, sg = df.at === 'A' ? 1 : -1;
      const zf = edge(df.i, df.at)[0], zb = edge(df.i + 1, df.at)[1];
      solid([[a, zf], [a + sg * df.s, zf], [a, zf + df.s]], -hw, hw, WOOD, 1);
      solid([[a, zb], [a, zb - df.s], [a + sg * df.s, zb]], -hw, hw, WOOD, 1);
    }
    // mouth
    const last = r.legs.length - 1, mEnd = r.mouthEnd;
    const pw = r.port ? Math.min(w, r.port.shape === 'slot' ? r.port.w : r.port.d) / 2 : hw;   // opening across the width
    if (r.port && r.portAt > 0) {
      // port on the back panel, up from the closed end of the last leg
      const am = mEnd === 'A' ? r.portAt : r.Lin - r.portAt;
      if (r.port.shape === 'slot') solid(rect(am - r.mouthH / 2, am + r.mouthH / 2, r.Din + t, r.Din + t + 0.002), -pw, pw, DARK, 1);
      else {
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r.port.d / 2, 40), new THREE.MeshStandardMaterial({ color: DARK, side: THREE.DoubleSide }));
        disc.position.copy(M(am, r.Din + t + 0.002, 0));
        this.group.add(disc);
      }
    } else if (r.port && r.port.shape !== 'slot') {
      // a round end port: a disc on the panel
      const e = edge(last, mEnd);
      const at = r.mouthBack ? M(mEnd === 'A' ? r.mouthH / 2 : r.Lin - r.mouthH / 2, r.Din + t + 0.002, 0) : M(mEnd === 'A' ? -t - 0.002 : r.Lin + t + 0.002, (e[0] + e[1]) / 2, 0);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r.port.d / 2, 40), new THREE.MeshStandardMaterial({ color: DARK, side: THREE.DoubleSide }));
      disc.position.copy(at);
      const nrm = r.mouthBack ? new THREE.Vector3(0, 0, -1) : M(mEnd === 'A' ? -1 : r.Lin + 1, 0, 0).sub(M(mEnd === 'A' ? 0 : r.Lin, 0, 0)).normalize();
      disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
      this.group.add(disc);
    } else if (r.mouthBack) {
      const a0 = mEnd === 'A' ? 0 : r.Lin - r.mouthH, a1 = a0 + r.mouthH;
      solid(rect(a0, a1, r.Din + t, r.Din + t + 0.002), -pw, pw, DARK, 1);
    } else {
      const e = edge(last, mEnd), a = mEnd === 'A' ? -t - 0.002 : r.Lin + t;
      const zc = (e[0] + e[1]) / 2, half = r.port ? r.port.h / 2 : (e[1] - e[0]) / 2;
      solid(rect(a, a + 0.002, zc - half, zc + half), -pw, pw, DARK, 1);
    }
    // driver on the front baffle, over the first leg
    const p = drvc.params, rd = Math.min(p.dia > 0 ? p.dia / 2 : Math.sqrt(p.sd / Math.PI) * 1.18, hw);
    this.driver(M(r.drvAlong, -t, 0), new THREE.Vector3(0, 0, 1), rd);
  };

  // Horn shown unfolded along +x: throat at the left, mouth at the right.
  BoxView.prototype.buildHorn = function ({ design, hornLay, drvc }) {
    const H = design.horn, prof = hornLay.profile, L = hornLay.length;
    const p = drvc.params;
    const rDrv = p.dia > 0 ? p.dia / 2 : Math.sqrt(p.sd / Math.PI) * 1.18;
    const sides = Object.fromEntries(hornLay.chambers.map(c => [c.id, Math.cbrt(c.gross)]));
    const back = Object.values(sides).reduce((s, v) => s + v, 0);
    this.fit(L + back);
    const x0 = -(L + back) / 2 + back;                     // throat position
    const mat = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.85, side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false });
    if (H.shape === 'round') {
      const m = new THREE.Mesh(new THREE.LatheGeometry(prof.map(q => new THREE.Vector2(Math.sqrt(q.S / Math.PI), q.x)), 48), mat);
      m.rotation.z = -Math.PI / 2;                          // lathe axis +y → +x
      m.position.x = x0;
      this.group.add(m);
    } else {
      const geo = ductGeometry(prof, H.width);
      const m = new THREE.Mesh(geo, mat);
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x5b4426 })));
      m.position.x = x0;
      this.group.add(m);
    }
    const throatH = H.shape === 'rect' ? H.s1 / H.width : 2 * Math.sqrt(H.s1 / Math.PI);
    const mount = design.mount;
    if (design.type === 'blh') {
      // rear chamber behind the throat; the cone's front faces the listener (+z)
      const s = sides.R || 0.05;
      this.panel(s, s, s, x0 - s / 2, 0, 0, { opacity: 0.5 });
      this.driver(new THREE.Vector3(x0 - s / 2, 0, s / 2), new THREE.Vector3(0, 0, 1), Math.min(rDrv, s / 2));
    } else if (design.type === 'flh') {
      // rear chamber | driver | throat chamber | horn
      const sT = sides.T || 0.01, sR = sides.R || 0.05;
      this.panel(sT, Math.max(sT, throatH), Math.max(sT, throatH), x0 - sT / 2, 0, 0, { opacity: 0.45 });
      this.panel(sR, sR, sR, x0 - sT - sR / 2, 0, 0, { opacity: 0.5 });
      this.driver(new THREE.Vector3(x0 - sT, 0, 0), new THREE.Vector3(1, 0, 0), Math.min(rDrv, sR / 2));
    } else {
      // tapped horn: closed throat end; driver rear taps in where a segment ends
      const k = +(mount.rear || 'h1').slice(1);
      const xTap = design.horn.segments.slice(0, k).reduce((s, g) => s + g.len, 0);
      const cap = H.shape === 'rect' ? [0.01, throatH, H.width] : [0.01, throatH, throatH];
      this.panel(cap[0], cap[1], cap[2], x0 - 0.005, 0, 0, { opacity: 0.8 });
      this.driver(new THREE.Vector3(x0 + xTap, 0, (H.shape === 'rect' ? H.width : throatH) / 2), new THREE.Vector3(0, 0, -1), rDrv);
    }
  };

  // Constant-width rectangular duct following an area profile [{x, S}].
  function ductGeometry(prof, w) {
    const pos = [];
    const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 1; i < prof.length; i++) {
      const xa = prof[i - 1].x, xb = prof[i].x;
      const ha = prof[i - 1].S / w / 2, hb = prof[i].S / w / 2, z = w / 2;
      quad([xa, ha, -z], [xb, hb, -z], [xb, hb, z], [xa, ha, z]);       // top
      quad([xa, -ha, -z], [xa, -ha, z], [xb, -hb, z], [xb, -hb, -z]);   // bottom
      quad([xa, -ha, z], [xa, ha, z], [xb, hb, z], [xb, -hb, z]);       // side
      quad([xa, -ha, -z], [xb, -hb, -z], [xb, hb, -z], [xa, ha, -z]);   // side
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  // Rectangular duct from x=0 (w x h0) to x=len (w x hL), open at x=len.
  function frustumRect(len, w, h0, hL) {
    const v = [
      [0, -h0 / 2, -w / 2], [0, h0 / 2, -w / 2], [0, h0 / 2, w / 2], [0, -h0 / 2, w / 2],
      [len, -hL / 2, -w / 2], [len, hL / 2, -w / 2], [len, hL / 2, w / 2], [len, -hL / 2, w / 2],
    ];
    const quads = [[0, 1, 2, 3], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
    const pos = [];
    for (const q of quads) for (const i of [q[0], q[1], q[2], q[0], q[2], q[3]]) pos.push(...v[i]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  GL.BoxView = BoxView;
})(window.GL);
