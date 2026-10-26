// São Paulo World · driving test track: visible crush damage.
// Two sources. "Realistic" damage: the physics' node/beam crash structure deforms, and applyCage
// skins the mesh to it. Otherwise (cosmetic, and the older path below): the physics treats the
// body as rigid and models the crush zone as
// the pulse the occupants feel (crash.hpp: per-zone stiffness and crush limit). This module draws
// that crush on the car's mesh: every vertex within the crush zone behind the point of impact is
// pushed in along the impact direction, most at the surface and nothing past the zone's depth,
// weighted by its distance from the impact axis (a wall flattens the whole nose, a pole bites a
// narrow notch), with buckling folds. Hits add up; R (reset) restores the car.
// SPDX-License-Identifier: MIT

function hash3(x, y, z) {
  let h = Math.imul((x * 73856093) | 0, 0x27d4eb2d) ^ Math.imul((y * 19349663) | 0, 0x165667b1) ^ Math.imul((z * 83492791) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h ^= h >>> 13;
  return ((h >>> 0) % 10007) / 10007;
}

export class Crumple {
  constructor(THREE, root, skip) {
    this.THREE = THREE; this.root = root; this.skip = skip;
    this.meshes = [];
    this.hits = [];
    this.dirty = false;
    // the most any point of the body is drawn pushed in (m); Infinity = as deep as the hits say.
    // A function so the page can switch it (cosmetic damage vs the crash lab) without re-denting.
    this.cap = () => Infinity;
  }

  // Find the deformable meshes (the body, not wheels or overlays) and remember their shape.
  capture() {
    const { THREE } = this;
    this.restore();
    this.meshes = [];
    this.hits = [];
    this.cageKey = null;
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.visible && o.parent === this.root || this.skip(o)) return;
      const pos = o.geometry?.attributes?.position;
      if (!pos || pos.count < 4) return;
      if (o.isInstancedMesh || o.isSkinnedMesh) return;
      // own the geometry: shared geometries would dent every car part that uses them
      if (!o.userData.crumpleOwn) { o.geometry = o.geometry.clone(); o.userData.crumpleOwn = true; }
      const g = o.geometry, p = g.attributes.position;
      const toRoot = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      const fromRoot = new THREE.Matrix4().copy(toRoot).invert();
      const base = new Float32Array(p.array);           // local, original
      const body = new Float32Array(p.count * 3);       // in the car's frame, original
      const v = new THREE.Vector3();
      for (let i = 0; i < p.count; ++i) { v.fromBufferAttribute(p, i).applyMatrix4(toRoot); body.set([v.x, v.y, v.z], 3 * i); }
      this.meshes.push({ mesh: o, base, body, offset: new Float32Array(p.count * 3), toRoot, fromRoot, normal: !!g.attributes.normal });
    });
  }

  restore() {
    for (const m of this.meshes) {
      const p = m.mesh.geometry.attributes.position;
      p.array.set(m.base); p.needsUpdate = true;
      if (m.normal) m.mesh.geometry.computeVertexNormals();
      m.offset.fill(0);
    }
    this.hits = [];
  }

  // A hit at `point` (car frame, three axes) pushing in along unit `dir` (car frame), crushing
  // `depth` metres at the surface, `radius` = lateral reach of the dent (m). amount 0..1 lets a
  // replay grow it; commit() makes it permanent.
  addHit(point, dir, depth, radius) {
    const { THREE } = this;
    const u = dir.clone().normalize();
    // the surface along -u through the point: the outermost vertex near the impact axis
    let sMin = Infinity;
    for (const m of this.meshes) for (let i = 0; i < m.body.length; i += 3) {
      const px = m.body[i] - point.x, py = m.body[i + 1] - point.y, pz = m.body[i + 2] - point.z;
      const s = px * u.x + py * u.y + pz * u.z;
      const rx = px - u.x * s, ry = py - u.y * s, rz = pz - u.z * s;
      if (rx * rx + ry * ry + rz * rz < radius * radius * 2.25) sMin = Math.min(sMin, s);
    }
    if (!Number.isFinite(sMin)) return null;
    const zone = Math.max(0.35, 2.2 * depth);
    // a perpendicular for the folds
    const side = Math.abs(u.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const p1 = side.clone().cross(u).normalize(), p2 = u.clone().cross(p1).normalize();
    const hit = { parts: [], amount: 0 };
    for (let k = 0; k < this.meshes.length; ++k) {
      const m = this.meshes[k];
      const idx = [], disp = [];
      for (let i = 0, n = m.body.length / 3; i < n; ++i) {
        const px = m.body[3 * i] - point.x, py = m.body[3 * i + 1] - point.y, pz = m.body[3 * i + 2] - point.z;
        const s = px * u.x + py * u.y + pz * u.z - sMin;
        if (s < -0.05 || s > zone) continue;
        const rx = px - u.x * (s + sMin), ry = py - u.y * (s + sMin), rz = pz - u.z * (s + sMin);
        const r2 = rx * rx + ry * ry + rz * rz;
        const w = Math.exp(-r2 / (radius * radius));
        if (w < 0.02) continue;
        const f = depth * w * Math.max(0, 1 - Math.max(0, s) / zone);
        // buckling: folds across the crush direction, stronger where the crush is
        const h = hash3(Math.round(m.body[3 * i] * 40), Math.round(m.body[3 * i + 1] * 40), Math.round(m.body[3 * i + 2] * 40));
        const fold = Math.sin((s + sMin) * 22 + h * 2) * 0.22 * f + (h - 0.5) * 0.08 * f;
        idx.push(i);
        disp.push(u.x * f + p2.x * fold, u.y * f + p2.y * fold, u.z * f + p2.z * fold);
      }
      if (idx.length) hit.parts.push({ k, idx: Uint32Array.from(idx), disp: Float32Array.from(disp) });
    }
    this.hits.push(hit);
    return hit;
  }

  // Set how far a hit has gone in (0..1) and redraw the touched meshes.
  setAmount(hit, a) {
    if (!hit) return;
    const da = a - hit.amount;
    if (Math.abs(da) < 1e-4) return;
    hit.amount = a;
    const { THREE } = this;
    const v = new THREE.Vector3();
    const touched = new Set();
    for (const part of hit.parts) {
      const m = this.meshes[part.k];
      for (let j = 0; j < part.idx.length; ++j) {
        const i = part.idx[j];
        m.offset[3 * i] += part.disp[3 * j] * da; m.offset[3 * i + 1] += part.disp[3 * j + 1] * da; m.offset[3 * i + 2] += part.disp[3 * j + 2] * da;
      }
      touched.add(part.k);
    }
    const cap = this.cap();
    for (const k of touched) {
      const m = this.meshes[k], p = m.mesh.geometry.attributes.position;
      for (let i = 0; i < p.count; ++i) {
        let ox = m.offset[3 * i], oy = m.offset[3 * i + 1], oz = m.offset[3 * i + 2];
        if (ox === 0 && oy === 0 && oz === 0) continue;
        // the stored offsets stay exact (so a replay can take them back out); only the drawing is
        // capped, smoothly, so stacked hits flatten out instead of folding the body in
        if (cap < Infinity) { const l = Math.hypot(ox, oy, oz), c = cap * Math.tanh(l / cap) / l; ox *= c; oy *= c; oz *= c; }
        v.set(m.body[3 * i] + ox, m.body[3 * i + 1] + oy, m.body[3 * i + 2] + oz).applyMatrix4(m.fromRoot);
        p.setXYZ(i, v.x, v.y, v.z);
      }
      p.needsUpdate = true;
      if (m.normal) m.mesh.geometry.computeVertexNormals();
      m.mesh.geometry.computeBoundingSphere();
    }
  }

  // ---- The physics' own crash structure (damage mode "realistic") ----
  // `nodes`: the node/beam structure's nodes from ord_cage_nodes(), 8 doubles each (rest x, y, z,
  // deformed x, y, z in the body's ISO frame, zone, free). Each vertex is bound once to its four
  // nearest rest nodes (Gaussian weights, sigma 0.35 m; the cell's anchored nodes count, so the
  // cabin stays put) and follows their displacement. `normals` false skips the (costly) normal
  // recompute while a crash is still moving the shape.
  applyCage(nodes, count, normals = true) {
    if (!this.meshes.length || !count) return;
    const key = `${count}:${nodes[0].toFixed(4)}:${nodes[8 * (count - 1) + 2].toFixed(4)}`;
    if (this.cageKey !== key) this.bindCage(nodes, count, key);
    const disp = new Float32Array(3 * count);
    for (let i = 0; i < count; ++i) {   // ISO (x fwd, y left, z up) -> the car's frame (x, z, -y)
      const o = 8 * i;
      disp[3 * i] = nodes[o + 3] - nodes[o];
      disp[3 * i + 1] = nodes[o + 5] - nodes[o + 2];
      disp[3 * i + 2] = -(nodes[o + 4] - nodes[o + 1]);
    }
    const { THREE } = this;
    const v = new THREE.Vector3();
    for (const m of this.meshes) {
      const b = m.cage, p = m.mesh.geometry.attributes.position;
      if (!b) continue;
      for (let i = 0; i < p.count; ++i) {
        let ox = 0, oy = 0, oz = 0;
        for (let k = 0; k < 4; ++k) {
          const w = b.w[4 * i + k];
          if (w === 0) continue;
          const n = 3 * b.idx[4 * i + k];
          ox += w * disp[n]; oy += w * disp[n + 1]; oz += w * disp[n + 2];
        }
        m.offset[3 * i] = ox; m.offset[3 * i + 1] = oy; m.offset[3 * i + 2] = oz;
        v.set(m.body[3 * i] + ox, m.body[3 * i + 1] + oy, m.body[3 * i + 2] + oz).applyMatrix4(m.fromRoot);
        p.setXYZ(i, v.x, v.y, v.z);
      }
      p.needsUpdate = true;
      if (normals && m.normal) m.mesh.geometry.computeVertexNormals();
      m.mesh.geometry.computeBoundingSphere();
    }
  }

  bindCage(nodes, count, key) {
    const rest = new Float32Array(3 * count);
    for (let i = 0; i < count; ++i) { const o = 8 * i; rest[3 * i] = nodes[o]; rest[3 * i + 1] = nodes[o + 2]; rest[3 * i + 2] = -nodes[o + 1]; }
    const s2 = 0.35 * 0.35;
    for (const m of this.meshes) {
      const n = m.body.length / 3, idx = new Uint16Array(4 * n), w = new Float32Array(4 * n);
      const bd = [1e9, 1e9, 1e9, 1e9], bi = [0, 0, 0, 0];
      for (let i = 0; i < n; ++i) {
        const x = m.body[3 * i], y = m.body[3 * i + 1], z = m.body[3 * i + 2];
        bd.fill(1e9);
        for (let j = 0; j < count; ++j) {
          const dx = rest[3 * j] - x, dy = rest[3 * j + 1] - y, dz = rest[3 * j + 2] - z, d = dx * dx + dy * dy + dz * dz;
          if (d >= bd[3]) continue;
          let k = 3;
          while (k > 0 && bd[k - 1] > d) { bd[k] = bd[k - 1]; bi[k] = bi[k - 1]; --k; }
          bd[k] = d; bi[k] = j;
        }
        let sum = 0;
        for (let k = 0; k < 4; ++k) { const e = Math.exp(-bd[k] / s2); w[4 * i + k] = e; idx[4 * i + k] = bi[k]; sum += e; }
        // far from every node (a spoiler tip, a mirror): follow the nearest one alone
        if (sum < 1e-6) { w.fill(0, 4 * i, 4 * i + 4); w[4 * i] = 1; }
        else for (let k = 0; k < 4; ++k) w[4 * i + k] /= sum;
      }
      m.cage = { idx, w };
    }
    this.cageKey = key;
  }

  // Crush depth of a hit at closing speed `v` (m/s) in a zone of natural frequency `omega`
  // (rad/s) and crush limit `limit` (m): the half-sine pulse's displacement v / omega, capped.
  // Most of it stays (plastic); a little springs back.
  static depth(v, omega, limit) { return Math.min(limit, v / omega) * 0.85; }
}
