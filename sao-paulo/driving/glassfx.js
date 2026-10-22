// São Paulo World · driving test track: storefront glass broken by the Glass Dynamics engine.
// The driving physics decides that a pane gives way (the energy it can take, ord_web.cpp); the
// glass engine decides how: its fracture of that pane under the car's nose, computed in a worker
// (glass_worker.js) as the car approaches, so the pieces are ready the moment it hits. If the
// prediction missed (a swerve, a stop), the procedural shards stand in.
// SPDX-License-Identifier: MIT

export class GlassFX {
  constructor(THREE, scene, { mobile }) {
    this.THREE = THREE; this.scene = scene; this.mobile = mobile;
    this.worker = null; this.failed = false;
    this.jobs = new Map();     // seg -> { id, result, error, t0, hitY, start }
    this.views = [];           // pieces in flight
    this.nextId = 1;
    this.mat = new THREE.MeshPhysicalMaterial({ color: '#d5ecf6', roughness: 0.06, metalness: 0.0, transmission: 0, transparent: true, opacity: 0.55, side: THREE.DoubleSide, vertexColors: true, depthWrite: false, flatShading: true });
  }

  ensureWorker() {
    if (this.worker || this.failed) return !!this.worker;
    try {
      this.worker = new Worker(new URL('./glass_worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        for (const job of this.jobs.values()) if (job.id === e.data.id) {
          if (e.data.error) { job.error = e.data.error; console.warn('glass engine:', e.data.error); }
          else { job.result = e.data; if (job.started) this.play(job); }
        }
      };
      this.worker.onerror = (e) => { console.warn('glass worker failed', e.message); this.failed = true; this.worker = null; };
      return true;
    } catch (e) { this.failed = true; return false; }
  }

  // The car is heading for glass section `seg` (def: ax, ay, bx, by, z0, z1): ask for its break.
  // hitAlong: metres along the section from (ax, ay); hitZ: height above the ground.
  predict(seg, def, hitAlong, hitZ, speed, mass) {
    if (this.jobs.has(seg) || !this.ensureWorker()) return;
    const W = Math.hypot(def.bx - def.ax, def.by - def.ay), H = def.z1 - def.z0;
    const job = { id: this.nextId++, seg, def, started: false };
    this.jobs.set(seg, job);
    this.worker.postMessage({
      id: job.id, glazing: 'annealed_10', tier: this.mobile ? 1 : 2, seed: (Math.random() * 1e9) | 0, W, H, floor: def.z0,
      x: Math.max(0.15, Math.min(W - 0.15, hitAlong)), y: Math.max(0.15, Math.min(H - 0.15, hitZ - def.z0)),
      speed: Math.max(2, speed), yaw: 0, mass, radius: 0.32, T: 3, maxPts: this.mobile ? 8 : 14,
    });
  }

  // The physics broke section `seg`, the car going through along `dir` (ISO, unit, horizontal).
  // Returns true when the glass engine's pieces will show (now, or as soon as they're ready).
  onBreak(seg, dir) {
    const job = this.jobs.get(seg);
    if (!job || job.error) return false;
    job.started = true; job.dir = dir;
    if (job.result) this.play(job);
    return true;
  }

  play(job) {
    const { THREE } = this, r = job.result;
    const pos = [], col = [], recs = [];
    let nv = 0;
    for (const s of r.shapes) {
      const n = s.outline.length / 2;
      if (n < 3) continue;
      const pts = []; for (let i = 0; i < n; ++i) pts.push(new THREE.Vector2(s.outline[2 * i], s.outline[2 * i + 1]));
      let tris; try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch { continue; }
      const h = Math.max(0.004, s.thickness / 2), local = [];
      const edge = [0.55, 0.85, 0.75], face = [0.9, 0.97, 1.0];
      const push = (x, y, z, c) => { local.push(x, y, z); col.push(c[0], c[1], c[2]); };
      for (const [a, b, c] of tris) { push(pts[a].x, pts[a].y, h, face); push(pts[b].x, pts[b].y, h, face); push(pts[c].x, pts[c].y, h, face); push(pts[a].x, pts[a].y, -h, face); push(pts[c].x, pts[c].y, -h, face); push(pts[b].x, pts[b].y, -h, face); }
      for (let i = 0; i < n; ++i) { const p = pts[i], q = pts[(i + 1) % n]; push(p.x, p.y, -h, edge); push(q.x, q.y, -h, edge); push(q.x, q.y, h, edge); push(p.x, p.y, -h, edge); push(q.x, q.y, h, edge); push(p.x, p.y, h, edge); }
      recs.push({ index: s.index, start: nv, count: local.length / 3, local: Float32Array.from(local), last: -2 });
      nv += local.length / 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    const mesh = new THREE.Mesh(geo, this.mat); mesh.frustumCulled = false; mesh.renderOrder = 3;
    this.scene.add(mesh);
    const d = job.def, L = Math.hypot(d.bx - d.ax, d.by - d.ay);
    // pane frame -> world: x along the section, y up from its bottom, z the car's direction through it
    this.views.push({ job, mesh, recs, t: 0, along: { x: (d.bx - d.ax) / L, y: (d.by - d.ay) / L }, origin: { x: d.ax, y: d.ay, z: d.z0 }, dir: job.dir });
  }

  update(dt) {
    for (const v of this.views) {
      const r = v.job.result;
      v.t = Math.min(v.t + dt, (r.frames.length - 1) / r.fps);
      const f = v.t * r.fps, i0 = Math.floor(f), i1 = Math.min(r.frames.length - 1, i0 + 1), a = f - i0;
      const F0 = r.frames[i0], F1 = r.frames[i1];
      const pos = v.mesh.geometry.attributes.position.array;
      let dirty = false;
      for (const rec of v.recs) {
        const o0 = 8 * rec.index;
        if (o0 + 7 >= F1.length) { continue; }  // not broken off yet
        const st = F1[o0 + 7];
        if (rec.last === i1 && st !== 1 && st !== 2) continue;
        rec.last = i1; dirty = true;
        if (st < 0) { pos.fill(0, rec.start * 3, (rec.start + rec.count) * 3); continue; }
        const has0 = o0 + 7 < F0.length;
        const lerp = (k) => (has0 ? F0[o0 + k] + (F1[o0 + k] - F0[o0 + k]) * a : F1[o0 + k]);
        const px = lerp(0), py = lerp(1), pz = lerp(2);
        let qw = lerp(3), qx = lerp(4), qy = lerp(5), qz = lerp(6);
        const ql = Math.hypot(qw, qx, qy, qz) || 1; qw /= ql; qx /= ql; qy /= ql; qz /= ql;
        for (let j = 0; j < rec.count; ++j) {
          const lx = rec.local[3 * j], ly = rec.local[3 * j + 1], lz = rec.local[3 * j + 2];
          // rotate by q: t = 2 q.xyz x v; v' = v + w t + q.xyz x t
          const tx = 2 * (qy * lz - qz * ly), ty = 2 * (qz * lx - qx * lz), tz = 2 * (qx * ly - qy * lx);
          const rx = lx + qw * tx + (qy * tz - qz * ty), ry = ly + qw * ty + (qz * tx - qx * tz), rz = lz + qw * tz + (qx * ty - qy * tx);
          const X = px + rx, Y = py + ry, Z = pz + rz;
          // world ISO: origin + along * X + dir * Z, height origin.z + Y; then three (x, z, -y)
          const wx = v.origin.x + v.along.x * X + v.dir.x * Z, wy = v.origin.y + v.along.y * X + v.dir.y * Z, wz = v.origin.z + Y;
          const k = (rec.start + j) * 3;
          pos[k] = wx; pos[k + 1] = wz; pos[k + 2] = -wy;
        }
      }
      if (dirty) v.mesh.geometry.attributes.position.needsUpdate = true;
    }
  }

  reset() {
    for (const v of this.views) { this.scene.remove(v.mesh); v.mesh.geometry.dispose(); }
    this.views = [];
    this.jobs.clear();
  }
}
