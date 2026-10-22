// São Paulo World · driving test track: the physics overlay (O).
// Draws what the core computes, on the car, every frame:
//  - each tyre's friction circle: how much force the tyre can give at its load (radius) and the
//    force it is giving now (the arrow); the arrow touching the circle is the tyre at its limit;
//  - each tyre's vertical load as a bar (load transfer you can see);
//  - the centre of mass, the acceleration (g) and velocity vectors;
//  - the front and rear roll centres and the roll axis through them.
// Plus a small readout: load transfer, front vs rear slip angle (understeer / oversteer),
// grip used. Everything is read from the state buffers; nothing here is physics.
// SPDX-License-Identifier: MIT

const ISO = (THREE, x, y, z) => new THREE.Vector3(x, z, -y);  // body ISO 8855 -> three local

function arrow(THREE, color, shaft = 0.035) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(shaft, shaft, 1, 8), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(shaft * 2.6, 1, 12), mat);
  body.renderOrder = head.renderOrder = 20;
  g.add(body, head);
  const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion();
  g.set = (from, vec, maxLen = 4) => {
    let len = vec.length();
    if (len < 1e-3) { g.visible = false; return; }
    g.visible = true;
    len = Math.min(len, maxLen);
    const hl = Math.min(0.22, len * 0.35);
    q.setFromUnitVectors(up, vec.clone().normalize());
    g.position.copy(from); g.quaternion.copy(q);
    body.scale.set(1, Math.max(1e-3, len - hl), 1); body.position.set(0, (len - hl) / 2, 0);
    head.scale.set(1, hl, 1); head.position.set(0, len - hl / 2, 0);
  };
  return g;
}

function ringLine(THREE, color, n = 64) {
  const pos = new Float32Array((n + 1) * 3);
  for (let i = 0; i <= n; ++i) { const a = (i / n) * Math.PI * 2; pos.set([Math.cos(a), 0, Math.sin(a)], i * 3); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
  line.renderOrder = 19;
  return line;
}

export class PhysicsOverlay {
  // M: the module; S(i), W(w, i): state accessors; parent: the car's group (body frame)
  constructor(THREE, M, { S, W, parent, garageState }) {
    Object.assign(this, { THREE, M, S, W, parent, garageState });
    this.on = false;
    this.group = new THREE.Group(); this.group.visible = false;
    parent.add(this.group);
    this.wheels = [];
    const disc = new THREE.MeshBasicMaterial({ color: '#0b111b', transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide });
    for (let w = 0; w < 4; ++w) {
      const root = new THREE.Group();
      const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), disc); fill.renderOrder = 18;
      const circle = ringLine(THREE, '#ffd36b');
      const force = arrow(THREE, '#36c483', 0.03);
      const load = arrow(THREE, '#5aa0ff', 0.045);
      root.add(fill, circle);
      this.group.add(root, force, load);
      this.wheels.push({ root, fill, circle, force, load });
    }
    this.accel = arrow(THREE, '#ef5d4f', 0.05);
    this.vel = arrow(THREE, '#e7ecf2', 0.025);
    const mk = (c, r) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color: c, depthTest: false })); m.renderOrder = 21; return m; };
    this.com = mk('#ffffff', 0.09);
    this.rcF = mk('#c18cff', 0.07); this.rcR = mk('#c18cff', 0.07);
    const axisGeo = new THREE.BufferGeometry(); axisGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.rollAxis = new THREE.Line(axisGeo, new THREE.LineDashedMaterial({ color: '#c18cff', dashSize: 0.12, gapSize: 0.08, depthTest: false }));
    this.rollAxis.renderOrder = 19;
    this.group.add(this.accel, this.vel, this.com, this.rcF, this.rcR, this.rollAxis);
    this.panel = document.createElement('div');
    this.panel.id = 'xray'; this.panel.className = 'panel'; this.panel.hidden = true;
    (document.getElementById('leftcol') || document.body).append(this.panel);
    this.scale = 0.6 / 3500;  // m per N, set per car in reset()
    this.groundZ = -0.45;
    this.smooth = { lt: 0, lat: 0, af: 0, ar: 0 };
  }

  // After a car is created: scale so a corner's static load draws ~0.6 m.
  reset(groundZBody) {
    this.groundZ = groundZBody;
    const info = new Float64Array(this.M.HEAPF64.buffer, this.M._ord_vehicle_info(), 7);
    this.mass = info[3] || 1500;
    this.comBody = [info[0], info[1], info[2]];
    this.scale = 0.6 / (this.mass * 9.81 / 4);
  }

  toggle(on = !this.on) { this.on = on; this.group.visible = on; this.panel.hidden = !on; return on; }

  update(dt) {
    if (!this.on) return;
    const { THREE, S, W } = this;
    const n = Math.min(4, S(22));
    let loadF = 0, loadR = 0, loadL = 0, loadRt = 0, used = 0, uN = 0;
    const slip = [0, 0, 0, 0];
    for (let w = 0; w < 4; ++w) {
      const o = this.wheels[w];
      const show = w < n && W(w, 11) > 0;
      o.root.visible = o.force.visible = o.load.visible = show;
      if (!show) continue;
      const x = W(w, 0), y = W(w, 1), zc = W(w, 2), r = W(w, 3), steer = W(w, 4);
      const load = W(w, 6), fx = W(w, 9), fy = W(w, 10), grip = W(w, 16);
      const patch = ISO(THREE, x, y, zc - r + 0.02);
      // available force: what the tyre gives / the share of its limit in use (the engine's own
      // friction-circle ratio); at tiny forces fall back to mu ~ 1 x load
      const f = Math.hypot(fx, fy);
      const avail = grip > 0.05 ? f / grip : load;
      const rad = Math.max(0.05, avail * this.scale);
      o.root.position.copy(patch); o.root.rotation.set(0, steer, 0); o.root.scale.set(rad, 1, rad);
      const c = grip > 0.95 ? '#ef5d4f' : grip > 0.8 ? '#f0b43a' : '#36c483';
      o.force.children[0].material.color.set(c);
      const cs = Math.cos(steer), sn = Math.sin(steer);
      o.force.set(patch.clone().add(new THREE.Vector3(0, 0.01, 0)), ISO(THREE, (fx * cs - fy * sn) * this.scale, (fx * sn + fy * cs) * this.scale, 0), 3);
      o.load.set(patch, new THREE.Vector3(0, load * this.scale, 0), 3);
      if (x > 0) loadF += load; else loadR += load;
      if (y > 0) loadL += load; else loadRt += load;
      used += Math.min(1.2, grip); uN++;
      slip[w] = W(w, 8);
    }
    // centre of mass, acceleration (g, horizontal in the body frame) and velocity
    const com = ISO(THREE, this.comBody[0], this.comBody[1], this.comBody[2]);
    this.com.position.copy(com);
    this.accel.set(com, ISO(THREE, S(11) / 9.81, S(12) / 9.81, 0), 3);
    this.vel.set(com.clone().add(new THREE.Vector3(0, 0.35, 0)), ISO(THREE, S(7) * 0.06, S(8) * 0.06, 0), 4);
    // roll centres (garage state 12, 13: height above the ground) at each axle
    const gs = this.garageState();
    const xs = [0, 1, 2, 3].slice(0, n).map((w) => W(w, 0));
    const xf = Math.max(...xs), xr = Math.min(...xs);
    const hf = gs[12], hr = gs[13];
    this.rcF.position.copy(ISO(THREE, xf, 0, this.groundZ + hf)); this.rcR.position.copy(ISO(THREE, xr, 0, this.groundZ + hr));
    const ap = this.rollAxis.geometry.attributes.position;
    ap.setXYZ(0, this.rcF.position.x, this.rcF.position.y, this.rcF.position.z); ap.setXYZ(1, this.rcR.position.x, this.rcR.position.y, this.rcR.position.z);
    ap.needsUpdate = true; this.rollAxis.computeLineDistances();
    this.rcF.visible = this.rcR.visible = this.rollAxis.visible = Math.abs(hf) + Math.abs(hr) > 1e-4;
    // readout
    const k = 1 - Math.exp(-dt * 6), sm = this.smooth, total = loadF + loadR || 1;
    sm.lt += ((loadF / total) - sm.lt) * k;
    sm.lat += ((loadL / total) - sm.lat) * k;
    const af = (Math.abs(slip[0]) + Math.abs(slip[1])) / 2, ar = (Math.abs(slip[2]) + Math.abs(slip[3])) / 2;
    sm.af += (af - sm.af) * k; sm.ar += (ar - sm.ar) * k;
    const bal = (sm.af - sm.ar) * 180 / Math.PI;
    const tendency = Math.abs(S(7)) < 3 || (sm.af + sm.ar) < 0.01 ? 'neutral' : bal > 0.4 ? 'understeer' : bal < -0.4 ? 'oversteer' : 'neutral';
    const g = Math.hypot(S(11), S(12)) / 9.81, gz = S(13) / 9.81;
    this.panel.innerHTML = `<b>Physics overlay</b> <small>O to hide</small><br>` +
      `<span>Load front / rear</span> <b>${(100 * sm.lt).toFixed(0)} / ${(100 - 100 * sm.lt).toFixed(0)} %</b><br>` +
      `<span>Load left / right</span> <b>${(100 * sm.lat).toFixed(0)} / ${(100 - 100 * sm.lat).toFixed(0)} %</b><br>` +
      `<span>Slip angle F / R</span> <b>${(sm.af * 180 / Math.PI).toFixed(1)}° / ${(sm.ar * 180 / Math.PI).toFixed(1)}°</b> <i class="${tendency}">${tendency}</i><br>` +
      `<span>Grip used (mean)</span> <b>${uN ? (100 * used / uN).toFixed(0) : 0} %</b><br>` +
      `<span>Acceleration</span> <b>${g.toFixed(2)} g</b> <span>vertical ${gz.toFixed(2)} g</span><br>` +
      (this.rcF.visible ? `<span>Roll centres F / R</span> <b>${(hf * 1000).toFixed(0)} / ${(hr * 1000).toFixed(0)} mm</b><br>` : '') +
      `<small><i class="k" style="background:#ffd36b"></i>friction circle <i class="k" style="background:#36c483"></i>tyre force <i class="k" style="background:#5aa0ff"></i>load <i class="k" style="background:#ef5d4f"></i>g <i class="k" style="background:#c18cff"></i>roll axis</small>`;
  }
}
