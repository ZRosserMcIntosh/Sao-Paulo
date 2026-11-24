// São Paulo World · driving test track: traffic around MASP.
// The traffic is the site's own AI (../ai/sim.js, the AI logic demo) on its Paulista lane graph
// (../ai/data/paulista.json, cut from the same tile T_p0_p0): signals, give-way, bus lanes,
// motorcycles in the corridor, drivers with personalities (IDM car-following, MOBIL-style lane
// changes). Here it runs without pedestrians, and your car is one of the vehicles it sees: a
// driver behind you keeps its distance, one in the next lane can change lanes around you.
// The physics gets every traffic car as a moving box (ord_traffic_buffer): hit one and it is
// knocked loose and slides to a stop where the impact puts it; the AI treats it as a wreck,
// queues behind it and changes lanes around it. Wrecks clear after 30 s.
// The section's coordinates are the tile's, shifted by its centre (centre_world).
// SPDX-License-Identifier: MIT
import * as THREE from 'three';
import { World } from '../ai/sim.js';

export const DENSITY = { off: 0, light: 18, normal: 40, heavy: 70 };
const K = 12;                                   // doubles per car in the physics' traffic buffer
const MASS = { car: 1400, bus: 12000, moto: 220 }, HEIGHT = { car: 1.45, bus: 3.1, moto: 1.2 };
const WRECK_S = 30;

// Low-poly bodies: a painted part (instance colour) and a fixed part (glass, tyres, lights).
// Built along +x (forward), +y up, centred on the footprint, at length 1 / width 1 / height 1
// scale where noted, so one geometry fits every car of that kind.
function box(g, sx, sy, sz, x, y, z, col) {
  const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(x, y, z);
  const n = b.attributes.position.count, c = new Float32Array(n * 3);
  const k = new THREE.Color(col);
  for (let i = 0; i < n; ++i) { c[3 * i] = k.r; c[3 * i + 1] = k.g; c[3 * i + 2] = k.b; }
  b.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.push(b.toNonIndexed ? b.toNonIndexed() : b);
}
function merge(list) {
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const p = new Float32Array(n * 3), no = new Float32Array(n * 3), c = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) { p.set(g.attributes.position.array, o * 3); no.set(g.attributes.normal.array, o * 3); c.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(p, 3)); m.setAttribute('normal', new THREE.BufferAttribute(no, 3)); m.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return m;
}
function wheels(f, L, W, r, x0, x1) {
  for (const x of [x0, x1]) for (const s of [-1, 1]) {
    const t = new THREE.CylinderGeometry(r, r, 0.24, 14); t.rotateX(Math.PI / 2); t.translate(x * L, r, s * (W / 2 - 0.12));
    const n = t.attributes.position.count, c = new Float32Array(n * 3).fill(0.06);
    t.setAttribute('color', new THREE.BufferAttribute(c, 3)); f.push(t.toNonIndexed());
  }
}
function bodies() {
  const out = {};
  {   // car: 4.5 x 1.85 x 1.45
    const p = [], f = [], L = 4.5, W = 1.85;
    box(p, L, 0.62, W, 0, 0.62, 0, '#fff');                                 // body
    box(p, 2.3, 0.08, W * 0.86, -0.2, 1.4, 0, '#fff');                      // roof
    box(f, 2.4, 0.5, W * 0.88, -0.2, 1.13, 0, '#1a2129');                   // glasshouse
    box(f, 0.06, 0.14, 0.32, L / 2 + 0.01, 0.78, 0.6, '#fff6d8'); box(f, 0.06, 0.14, 0.32, L / 2 + 0.01, 0.78, -0.6, '#fff6d8');
    box(f, 0.06, 0.12, 0.34, -L / 2 - 0.01, 0.82, 0.62, '#b0161a'); box(f, 0.06, 0.12, 0.34, -L / 2 - 0.01, 0.82, -0.62, '#b0161a');
    wheels(f, L, W, 0.32, 0.31, -0.3);
    out.car = { paint: merge(p), fixed: merge(f), max: 90 };
  }
  {   // bus: 12 x 2.6 x 3.1
    const p = [], f = [], L = 12, W = 2.6;
    box(p, L, 2.5, W, 0, 1.75, 0, '#fff');
    box(f, L * 0.92, 0.95, W + 0.02, 0.2, 2.1, 0, '#1a2129');
    box(f, 0.04, 1.4, W * 0.9, L / 2 + 0.01, 2.0, 0, '#1a2129');
    wheels(f, L, W, 0.5, 0.33, -0.25);
    out.bus = { paint: merge(p), fixed: merge(f), max: 10 };
  }
  {   // motorcycle and rider: 2.1 x 0.8
    const p = [], f = [];
    box(p, 1.2, 0.45, 0.32, 0.05, 0.72, 0, '#fff');
    box(f, 0.5, 0.75, 0.42, -0.25, 1.25, 0, '#222831');                   // rider
    box(f, 0.32, 0.3, 0.3, -0.12, 1.75, 0, '#e8e2d0');                    // helmet
    for (const x of [0.72, -0.72]) { const t = new THREE.CylinderGeometry(0.3, 0.3, 0.12, 12); t.rotateX(Math.PI / 2); t.translate(x, 0.3, 0); t.setAttribute('color', new THREE.BufferAttribute(new Float32Array(t.attributes.position.count * 3).fill(0.06), 3)); f.push(t.toNonIndexed()); }
    out.moto = { paint: merge(p), fixed: merge(f), max: 30 };
  }
  return out;
}

export class Traffic {
  constructor({ scene, M, toast }) {
    Object.assign(this, { scene, M, toast });
    this.world = null; this.level = 'off'; this.loading = null;
    this.player = { id: -1, kind: 'car', player: true, s: 0, v: 0, len: 4.6, wid: 1.9, lat: 0, latT: 0, path: null };
    this.group = new THREE.Group(); this.group.name = 'traffic'; scene.add(this.group);
    this.meshes = {};
    const B = bodies();
    for (const [kind, b] of Object.entries(B)) {
      const paint = new THREE.InstancedMesh(b.paint, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.4 }), b.max);
      const fixed = new THREE.InstancedMesh(b.fixed, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 }), b.max);
      for (const m of [paint, fixed]) { m.count = 0; m.castShadow = true; m.frustumCulled = false; this.group.add(m); }
      this.meshes[kind] = { paint, fixed, max: b.max };
    }
    this.mtx = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.col = new THREE.Color();
  }

  get on() { return !!this.world && this.level !== 'off'; }

  async set(level) {
    this.level = DENSITY[level] !== undefined ? level : 'off';
    if (this.level === 'off') { this.clear(); return; }
    if (!this.world) {
      this.loading ||= fetch(new URL('../ai/data/paulista.json', import.meta.url)).then((r) => r.json());
      const d = await this.loading;
      if (this.world || this.level === 'off') return;
      const w = new World(d);
      [this.ox, this.oy] = d.centre_world || [0, 0];
      w.targets = () => ({ v: DENSITY[this.level] || 0, p: 0 });   // no pedestrians on the driving page
      w.t = 10 * 3600;
      this.world = w;
      // a running start: the section fills over a minute of traffic
      for (let i = 0; i < 600; ++i) w.step(0.1);
    }
  }

  clear() {
    if (this.world) { this.world.vehicles.forEach((v) => { if (v.path) { const i = v.path.agents.indexOf(v); if (i >= 0) v.path.agents.splice(i, 1); } }); }
    this.world = null;
    this.M._ord_traffic_buffer(0);
    for (const m of Object.values(this.meshes)) { m.paint.count = 0; m.fixed.count = 0; }
  }

  // Your car as a vehicle on the nearest lane it fits (heading within 50°), so the AI sees it.
  placePlayer(x, y, yaw, speed) {
    const w = this.world, P = this.player;
    const lx = x - this.ox, ly = y - this.oy;
    let best = null, bd = 1e9, bs = 0;
    for (const L of w.drive) {
      const p0 = L.pts[0], p1 = L.pts[L.pts.length - 1];
      if (Math.min(Math.hypot(lx - p0[0], ly - p0[1]), Math.hypot(lx - p1[0], ly - p1[1])) > L.len + 10) continue;
      for (let i = 1; i < L.pts.length; ++i) {
        const a = L.pts[i - 1], b = L.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((lx - a[0]) * dx + (ly - a[1]) * dy) / l2));
        const d = Math.hypot(lx - a[0] - dx * t, ly - a[1] - dy * t);
        if (d >= bd || d > L.w / 2 + 0.8) continue;
        if (Math.cos(Math.atan2(dy, dx) - yaw) < 0.64) continue;
        bd = d; best = L; bs = L.cum[i - 1] + t * Math.sqrt(l2);
      }
    }
    if (P.path && P.path !== best) { const i = P.path.agents.indexOf(P); if (i >= 0) P.path.agents.splice(i, 1); }
    if (best && P.path !== best) best.agents.push(P);
    P.path = best; P.s = bs; P.v = Math.max(0, speed);
  }

  // Before the physics advances: step the AI and hand the physics every car's pose and velocity.
  beforeAdvance(dt, S) {
    if (!this.on) return;
    const w = this.world;
    const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
    this.placePlayer(S(0), S(1), Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)), S(7));
    if (dt > 0) {
      for (const v of w.vehicles) if (v.kind !== 'wreck') { v._px = v.x; v._py = v.y; v._ph = v.h; }
      const n = Math.max(1, Math.ceil(dt / 0.05));
      for (let i = 0; i < n; ++i) w.step(Math.min(dt, 0.25) / n);
      for (const v of w.vehicles) if (v.kind === 'wreck' && w.simT > v.until + 1) v.dead = true;
    }
    const list = w.vehicles.filter((v) => !v.dead && v.x !== undefined && (v.alpha > 0.05 || v.kind === 'wreck'));
    this.list = list.slice(0, 128);
    const buf = new Float64Array(this.M.HEAPF64.buffer, this.M._ord_traffic_buffer(this.list.length), K * this.list.length);
    this.list.forEach((v, i) => {
      const o = K * i;
      if (v.eng) { buf.set(v.eng, o); buf[o + 11] = 0; return; }            // loose: the physics drives it
      const body = v.body || v.kind, h = v.h ?? 0;
      let vx = 0, vy = 0, r = 0;
      if (dt > 0 && v._px !== undefined) { vx = (v.x - v._px) / dt; vy = (v.y - v._py) / dt; r = Math.atan2(Math.sin(h - v._ph), Math.cos(h - v._ph)) / dt; }
      if (Math.hypot(vx, vy) > 40) { vx = vy = 0; r = 0; }                  // a lane-change jump, not motion
      // the physics advances them from where the AI put them, at that velocity
      buf.set([v.x + this.ox, v.y + this.oy, h, vx, vy, r, v.len, v.wid, HEIGHT[body] || 1.45, MASS[body] || 1400, 0, 0], o);
    });
  }

  // After the physics: cars it knocked loose become wrecks where they stopped.
  afterAdvance() {
    if (!this.on || !this.list) return;
    const w = this.world;
    const buf = new Float64Array(this.M.HEAPF64.buffer, this.M._ord_traffic_buffer(this.list.length), K * this.list.length);
    this.list.forEach((v, i) => {
      const o = K * i;
      if (buf[o + 10] < 1) return;
      v.eng = Array.from(buf.subarray(o, o + K));
      if (v.kind !== 'wreck') {
        v.body = v.kind; v.kind = 'wreck'; v.until = w.simT + WRECK_S; v.v = 0; v.alpha = 1; v.state = 'crashed';
        if (v.path?.occ === v) v.path.occ = null;
      }
      v.x = v.eng[0] - this.ox; v.y = v.eng[1] - this.oy; v.h = v.eng[2];
    });
  }

  draw() {
    const counts = { car: 0, bus: 0, moto: 0 };
    if (this.on && this.list) {
      for (const v of this.list) {
        const kind = v.body || v.kind, m = this.meshes[kind];
        if (!m || counts[kind] >= m.max) continue;
        const x = v.x + this.ox, y = v.y + this.oy, h = v.h ?? 0;
        const sc = kind === 'car' ? [v.len / 4.5, 1, v.wid / 1.85] : [1, 1, 1];
        const fade = v.kind === 'wreck' ? Math.max(0, Math.min(1, v.until + 1 - this.world.simT)) : Math.min(1, v.alpha);
        if (fade <= 0.02) continue;
        this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, h);
        this.mtx.compose(new THREE.Vector3(x, this.M._ord_ground_height(x, y) - (1 - fade) * 2, -y), this.q, new THREE.Vector3(...sc));
        const k = counts[kind]++;
        m.paint.setMatrixAt(k, this.mtx); m.fixed.setMatrixAt(k, this.mtx);
        m.paint.setColorAt(k, this.col.set(v.col || '#c8ced6'));
      }
    }
    for (const [kind, m] of Object.entries(this.meshes)) {
      m.paint.count = m.fixed.count = counts[kind];
      m.paint.instanceMatrix.needsUpdate = m.fixed.instanceMatrix.needsUpdate = true;
      if (m.paint.instanceColor) m.paint.instanceColor.needsUpdate = true;
    }
  }
}
