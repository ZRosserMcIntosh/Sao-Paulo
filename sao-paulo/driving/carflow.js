// São Paulo World · driving test track: the air around the car, as the physics sees it.
// The car's own version of the flight test bed's airflow view (flying/flow.js): a potential-flow
// field built so that it carries the forces the physics is producing this frame, drawn as
// streamlines released upstream and coloured by local speed, or as smoke from a wand.
//
// The field (body axes, x forward, y left, z up, the road at z = zg):
//  - the free stream: the air relative to the car (its speed through the air and the wind);
//  - the body: a closed Rankine body, sources near the nose and sinks near the tail, sized so the
//    flow passes a body of the car's frontal area, with their mirror images under the road (no
//    flow through it);
//  - downforce: each element that makes it is a bound vortex with two trailing legs (a horseshoe),
//    circulation G = D / (rho V b) from Kutta-Joukowski (D its downforce, b its span): the rear
//    wing, and the floor at each axle as an inverted wing in ground effect; with their images
//    under the road (opposite circulation), which is what ground effect is. So the upwash behind
//    the wing and the wing's tip vortices carry the downforce the physics reports;
//  - the wake: a Gaussian momentum deficit behind the car that carries exactly its drag
//    (integral of rho V u dA = D), widening downstream, with a vortex street shedding at a
//    Strouhal number of 0.2 on its width.
// What it is not: CFD. The body is a smooth equivalent of the car, not its shape, so the lines
// show where the air goes and how hard the car is working it, not the flow over its surfaces.
// SPDX-License-Identifier: MIT
import * as THREE from 'three';
import { CarFlowField, smooth } from './carflow_field.js';

function turbo(t, out) {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  out[0] = Math.min(1, Math.max(0, r)); out[1] = Math.min(1, Math.max(0, g)); out[2] = Math.min(1, Math.max(0, b));
  return out;
}
// Streamlines and smoke, drawn in the car's group (three axes: x, z, -y).
export class CarFlowView {
  constructor({ parent, mobile }) {
    this.field = new CarFlowField();
    this.group = new THREE.Group(); this.group.visible = false;
    parent.add(this.group);
    this.NL = mobile ? 120 : 220; this.NPT = mobile ? 80 : 120;
    const NL = this.NL, NPT = this.NPT;
    this.lp = new Float32Array(NL * NPT * 3); this.ls = new Float32Array(NL * NPT); this.ld = new Float32Array(NL * NPT);
    this.lt = new Float32Array(NL * NPT); this.ln = new Uint16Array(NL);
    this.phase = new Float32Array(NL).map(() => Math.random());
    this.segPos = new Float32Array(NL * (NPT - 1) * 6); this.segCol = new Float32Array(NL * (NPT - 1) * 8);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.segPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.segCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.lines.frustumCulled = false; this.lines.renderOrder = 3;
    this.group.add(this.lines);
    // smoke: particles advected through the field
    this.NP = mobile ? 1600 : 3600;
    this.pp = new Float32Array(this.NP * 3); this.page = new Float32Array(this.NP).fill(1e9); this.pnext = 0;
    this.smPos = new Float32Array(this.NP * 3); this.smCol = new Float32Array(this.NP * 4);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.smPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(this.smCol, 4).setUsage(THREE.DynamicDrawUsage));
    // a soft round puff
    const pc = document.createElement('canvas'); pc.width = pc.height = 64;
    const px = pc.getContext('2d'), grd = px.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    px.fillStyle = grd; px.fillRect(0, 0, 64, 64);
    this.smoke = new THREE.Points(sg, new THREE.PointsMaterial({ size: mobile ? 0.3 : 0.24, map: new THREE.CanvasTexture(pc), vertexColors: true, transparent: true, depthWrite: false }));
    this.smoke.frustumCulled = false; this.smoke.renderOrder = 3; this.smoke.visible = false;
    this.group.add(this.smoke);
    // the wing and the floor, glowing with their load (red when stalled)
    const pm = () => new THREE.MeshBasicMaterial({ color: '#2a7fff', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), pm());
    this.wingM = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), pm());
    this.floor.renderOrder = this.wingM.renderOrder = 2;
    this.group.add(this.floor, this.wingM);
    this.next = 0; this.traced = 0;
    this.light = false;   // the wind tunnel's light backdrop: darker smoke, slightly heavier lines
    this.wandY = 0;       // the smoke wand's lateral position (m, body y)
  }

  reset() { this.traced = 0; this.next = 0; this.ln.fill(0); this.page.fill(1e9); }

  // Seeds: a rake upstream, across the car and from the road to above the roof, denser low down.
  seed(i, out) {
    const f = this.field, g = f.geo, Uh = f.Uh;
    const NY = this.NL >= 200 ? 20 : 15, NZ = Math.ceil(this.NL / NY);
    const iy = i % NY, iz = Math.floor(i / NY);
    const ty = NY > 1 ? iy / (NY - 1) : 0.5, tz = NZ > 1 ? iz / (NZ - 1) : 0.5;
    const lat = (ty * 2 - 1) * 1.7 * g.hw;
    const z = f.zg + 0.04 + (g.roof - f.zg + 0.8) * tz * tz * 0.75 + (g.roof - f.zg + 0.8) * tz * 0.25;
    const cx = 0.5 * (g.front + g.rear), up = 0.5 * (g.front - g.rear) + 3;
    // the lateral axis across the stream (horizontal)
    out[0] = cx - Uh[0] * up - Uh[1] * lat;
    out[1] = -Uh[1] * up + Uh[0] * lat;
    out[2] = z;
    return out;
  }

  inside(p) {
    const g = this.field.geo;
    return p[0] < g.front && p[0] > g.rear && Math.abs(p[1]) < g.hw * 0.92 && p[2] > g.floor + 0.02 && p[2] < g.roof - 0.02;
  }

  trace(i) {
    const f = this.field, NPT = this.NPT, V = f.V;
    const p = this.seed(i, [0, 0, 0]), u = [0, 0, 0], u2 = [0, 0, 0], m = [0, 0, 0];
    const ds = 0.16;
    let n = 0, t = 0;
    const tailX = f.geo.rear - 14;
    for (; n < NPT; ++n) {
      f.at(p, u);
      const sp = Math.hypot(u[0], u[1], u[2]) + 1e-6;
      const o = (i * NPT + n);
      this.lp[3 * o] = p[0]; this.lp[3 * o + 1] = p[1]; this.lp[3 * o + 2] = p[2];
      this.ls[o] = sp / V;
      this.ld[o] = Math.hypot(u[0] - f.U[0], u[1] - f.U[1], u[2] - f.U[2]) / V;
      this.lt[o] = t;
      // RK2 by arc length
      const h = ds / sp;
      m[0] = p[0] + 0.5 * h * u[0]; m[1] = p[1] + 0.5 * h * u[1]; m[2] = p[2] + 0.5 * h * u[2];
      f.at(m, u2);
      const s2 = Math.hypot(u2[0], u2[1], u2[2]) + 1e-6, h2 = ds / s2;
      p[0] += h2 * u2[0]; p[1] += h2 * u2[1]; p[2] += h2 * u2[2];
      t += h2;
      if (p[2] < f.zg + 0.01) p[2] = f.zg + 0.01;
      if (this.inside(p) || (p[0] - tailX) * f.Uh[0] + p[1] * f.Uh[1] > 0) { ++n; break; }
    }
    this.ln[i] = n;
  }

  // dt: simulation seconds (slow motion runs it slower); mode 1 lines, 2 lines (tunnel), 3 smoke.
  update(dt, mode, inputs) {
    const f = this.field;
    // standing still there is no flow to show
    const v = Math.hypot(inputs.U[0], inputs.U[1], inputs.U[2]);
    this.group.visible = v > 3;
    if (v <= 3) return;
    f.t += dt;
    f.build(inputs.geo, inputs.forces, inputs.wing, inputs.axles, inputs.U);
    const lines = mode !== 3 || inputs.both;
    this.lines.visible = lines;
    this.smoke.visible = mode === 3;
    if (lines) {
      const per = this.traced < this.NL ? this.NL : Math.max(12, Math.round(this.NL / 6));
      for (let k = 0; k < per; ++k) { this.trace(this.next); this.next = (this.next + 1) % this.NL; }
      this.traced += per;
      this.drawLines(f.t);
    }
    if (mode === 3) this.stepSmoke(dt);
    // wing and floor glow with their load (blue), red when stalled
    const g = inputs.geo, fz = inputs.forces;
    const glow = (mesh, x, z, len, wid, load, stalled) => {
      mesh.position.set(x, z, 0); mesh.scale.set(len, 1, wid);
      mesh.material.color.set(stalled ? '#ff3b2f' : '#2a7fff');
      mesh.material.opacity = Math.min(0.55, Math.abs(load) / 6000 * 0.55 + (stalled ? 0.3 : 0));
    };
    glow(this.floor, 0.5 * (g.front + g.rear), g.floor - 0.01, (g.front - g.rear) * 0.8, 2 * g.hw * 0.8, fz.dfFront + fz.dfRearFloor, inputs.floorStalled);
    this.wingM.visible = !!inputs.wing;
    if (inputs.wing) glow(this.wingM, inputs.wing.x, inputs.wing.z, inputs.wing.chord || 0.3, inputs.wing.span, fz.wing, inputs.wingStalled);
  }

  drawLines(time) {
    const NL = this.NL, NPT = this.NPT, c = [0, 0, 0];
    const grey = this.light ? [0.42, 0.45, 0.5] : [0.78, 0.8, 0.84];
    const aBase = this.light ? 0.5 : 0.32;
    let k = 0;
    for (let i = 0; i < NL; ++i) {
      const n = this.ln[i];
      for (let j = 0; j + 1 < n; ++j) {
        const a = i * NPT + j, b = a + 1;
        for (const [idx, slot] of [[a, 0], [b, 1]]) {
          const o = 6 * k + 3 * slot;
          this.segPos[o] = this.lp[3 * idx]; this.segPos[o + 1] = this.lp[3 * idx + 2]; this.segPos[o + 2] = -this.lp[3 * idx + 1];
          const dist = smooth(0.008, 0.06, this.ld[idx]);
          turbo((this.ls[idx] - 0.55) / 0.8, c);
          const q = 8 * k + 4 * slot;
          this.segCol[q] = grey[0] + (c[0] - grey[0]) * dist;
          this.segCol[q + 1] = grey[1] + (c[1] - grey[1]) * dist;
          this.segCol[q + 2] = grey[2] + (c[2] - grey[2]) * dist;
          // a pulse travels along each line with the air
          const ph = ((time * 1.4 - this.lt[idx] * 1.4 + this.phase[i]) % 1 + 1) % 1;
          this.segCol[q + 3] = aBase + (0.95 - aBase) * Math.pow(1 - ph, 6) * (0.4 + 0.6 * dist);
        }
        ++k;
      }
    }
    for (let z = k; z < this.segPos.length / 6; ++z) { this.segPos.fill(0, 6 * z, 6 * z + 6); this.segCol.fill(0, 8 * z, 8 * z + 8); }
    const g = this.lines.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    g.setDrawRange(0, 2 * k);
  }

  // A wand of nozzles upstream of the car, at the wand's lateral position, from the road to above
  // the roof; each puff drifts with the field (simulation time: slow motion slows it).
  stepSmoke(dt) {
    const f = this.field, g = f.geo, Uh = f.Uh;
    const nozzles = 22;
    const up = 0.5 * (g.front - g.rear) + 2.2, cx = 0.5 * (g.front + g.rear);
    // a puff lives while it crosses from the wand to ~6 m past the tail (the near wake), so the
    // whole budget stays around the car at any speed: dense filaments, not a 200 m long trail
    const life = (up + 0.5 * (g.front - g.rear) + 6) / Math.max(3, f.V);
    this.life = life;
    const rate = (this.NP / life) / nozzles;   // puffs per second per nozzle to fill the budget
    this.emit = (this.emit || 0) + rate * dt;
    // puffs released through the frame, each placed where the free stream has carried it since its
    // release (a long frame would otherwise drop them all at once: columns, not filaments)
    let n = Math.min(Math.floor(this.emit), Math.floor(this.NP / nozzles));
    this.emit -= Math.floor(this.emit);
    const U = f.U;
    while (n-- > 0) {
      const age = (n + this.emit) / rate - dt;   // its age at the frame's start (negative: released in it)
      for (let k = 0; k < nozzles; ++k) {
        const i = this.pnext; this.pnext = (this.pnext + 1) % this.NP;
        const z = f.zg + 0.05 + (g.roof - f.zg + 0.5) * (k / (nozzles - 1));
        this.pp[3 * i] = cx - Uh[0] * up - Uh[1] * this.wandY + U[0] * age + (Math.random() - 0.5) * 0.03;
        this.pp[3 * i + 1] = -Uh[1] * up + Uh[0] * this.wandY + U[1] * age + (Math.random() - 0.5) * 0.03;
        this.pp[3 * i + 2] = z + (Math.random() - 0.5) * 0.03;
        this.page[i] = age;
      }
    }
    const u = [0, 0, 0], p = [0, 0, 0];
    const sub = Math.max(1, Math.ceil(dt / 0.012));
    const h = dt / sub;
    const col = this.light ? [0.18, 0.21, 0.27] : [0.92, 0.94, 0.97];
    for (let i = 0; i < this.NP; ++i) {
      if (this.page[i] > life) { this.smPos[3 * i + 1] = -1e4; this.smCol[4 * i + 3] = 0; continue; }
      p[0] = this.pp[3 * i]; p[1] = this.pp[3 * i + 1]; p[2] = this.pp[3 * i + 2];
      for (let s = 0; s < sub; ++s) {
        f.at(p, u);
        p[0] += u[0] * h; p[1] += u[1] * h; p[2] += u[2] * h;
        if (p[2] < f.zg + 0.01) p[2] = f.zg + 0.01;
      }
      if (this.inside(p)) this.page[i] = 1e9;   // a puff that cuts a corner of the equivalent body
      this.pp[3 * i] = p[0]; this.pp[3 * i + 1] = p[1]; this.pp[3 * i + 2] = p[2];
      this.page[i] += dt;
      this.smPos[3 * i] = p[0]; this.smPos[3 * i + 1] = p[2]; this.smPos[3 * i + 2] = -p[1];
      const a = Math.min(1, this.page[i] / (0.05 * life)) * Math.min(1, 3 * (1 - this.page[i] / life));
      this.smCol[4 * i] = col[0]; this.smCol[4 * i + 1] = col[1]; this.smCol[4 * i + 2] = col[2]; this.smCol[4 * i + 3] = (this.light ? 0.7 : 0.55) * a;
    }
    const sg = this.smoke.geometry;
    sg.attributes.position.needsUpdate = true; sg.attributes.color.needsUpdate = true;
  }
}
