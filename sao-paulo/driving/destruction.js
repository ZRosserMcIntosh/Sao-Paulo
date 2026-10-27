// São Paulo World · driving: destruction of the smash lane's walls.
// The physics (ord_web.cpp) decides whether a wall section breaks and how much speed the car
// keeps; this module makes the pieces. Glass shatters along a radial crack pattern from the
// hit, block walls come apart into their blocks, brick walls into chunks of a few bricks.
// Every piece is a rigid body with gravity, a ground bounce and friction, drawn from one
// dynamic BufferGeometry per material (no per-piece draw calls). Glass fades out; rubble stays.
//
// API: const d = new Destruction(THREE, scene); d.breakSection(seg, hit); d.update(dt); d.reset().
// `seg` is a wall section from ord_obstacles(): { ax, ay, bx, by, z0, z1, material } in ISO
// coordinates (x forward, y left, z up); `hit` is { px, py, nx, ny, speed, kept, vel: [vx, vy] }
// with the car's world velocity. The visuals are a stand-in that a dedicated fracture engine can
// replace by implementing the same two calls.

const G = 9.81;

// Piece budget per field: up to 16 vertices and 28 triangles each.
const PV = 16, PT = 28;

class DebrisField {
  constructor(THREE, scene, material, max) {
    this.THREE = THREE;
    this.max = max;
    this.pieces = [];
    this.next = 0;
    this.pos = new Float32Array(max * PV * 3);
    this.col = new Float32Array(max * PV * 4);
    const idx = new Uint32Array(max * PT * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.idx = idx;
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3();
  }
  // verts: local vertices [x,y,z,...] (ISO axes, metres), tris: index triples, color [r,g,b].
  spawn(verts, tris, color, p) {
    const slot = this.pieces.length < this.max ? this.pieces.length : (this.next++ % this.max);
    const piece = {
      slot, nv: verts.length / 3, verts: Float32Array.from(verts), tris,
      pos: p.pos.clone(), q: new this.THREE.Quaternion(), vel: p.vel.clone(), ang: p.ang.clone(),
      rest: p.rest, color, alpha: 1, life: p.life ?? Infinity, age: 0, asleep: false,
    };
    // a pass of random orientation so identical blocks don't line up
    this.pieces[slot] = piece;
    this.writeIndices(piece);
    return piece;
  }
  writeIndices(piece) {
    const base = piece.slot * PV, o = piece.slot * PT * 3;
    for (let i = 0; i < PT * 3; ++i) this.idx[o + i] = base;  // degenerate by default
    for (let i = 0; i < piece.tris.length && i < PT * 3; ++i) this.idx[o + i] = base + piece.tris[i];
    this.geo.index.needsUpdate = true;
  }
  update(dt) {
    const { THREE } = this;
    let used = 0;
    for (const p of this.pieces) {
      if (!p) continue;
      p.age += dt;
      if (p.age > p.life) { this.kill(p); continue; }
      if (p.life !== Infinity) p.alpha = Math.min(1, (p.life - p.age) / 2);  // fade over the last 2 s
      if (!p.asleep) {
        p.vel.z -= G * dt;
        p.pos.addScaledVector(p.vel, dt);
        // ground: bounce, scrub, spin down
        if (p.pos.z < p.rest) {
          p.pos.z = p.rest;
          p.vel.z = Math.abs(p.vel.z) * 0.25;
          p.vel.x *= 0.55; p.vel.y *= 0.55;
          p.ang.multiplyScalar(0.4);
          if (p.vel.lengthSq() < 0.05 && p.ang.lengthSq() < 0.2) {
            p.asleep = true; p.vel.set(0, 0, 0); p.ang.set(0, 0, 0);
            // settle flat: snap the orientation to the nearest axis-aligned face
            this.settle(p);
          }
        }
        const w = p.ang.length();
        if (w > 1e-6) { this.q.setFromAxisAngle(this.v.copy(p.ang).multiplyScalar(1 / w), w * dt); p.q.premultiply(this.q); }
      }
      this.write(p);
      used = Math.max(used, p.slot + 1);
    }
    this.geo.setDrawRange(0, used * PT * 3);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
  settle(p) {
    // keep the yaw, drop the rest: pieces lie flat on the ground
    const e = new this.THREE.Euler().setFromQuaternion(p.q, 'ZYX');
    e.x = Math.round(e.x / (Math.PI / 2)) * (Math.PI / 2);
    e.y = Math.round(e.y / (Math.PI / 2)) * (Math.PI / 2);
    p.q.setFromEuler(e);
  }
  write(p) {
    const base = p.slot * PV, v = this.v, q = p.q, pos = p.pos;
    for (let i = 0; i < PV; ++i) {
      const o = (base + i) * 3, c = (base + i) * 4;
      if (i < p.nv) {
        v.set(p.verts[i * 3], p.verts[i * 3 + 1], p.verts[i * 3 + 2]).applyQuaternion(q).add(pos);
        // ISO (x, y, z) -> three (x, z, -y)
        this.pos[o] = v.x; this.pos[o + 1] = v.z; this.pos[o + 2] = -v.y;
      } else { this.pos[o] = pos.x; this.pos[o + 1] = pos.z; this.pos[o + 2] = -pos.y; }
      this.col[c] = p.color[0]; this.col[c + 1] = p.color[1]; this.col[c + 2] = p.color[2]; this.col[c + 3] = p.alpha;
    }
  }
  kill(p) {
    this.pieces[p.slot] = null;
    const o = p.slot * PT * 3, base = p.slot * PV;
    for (let i = 0; i < PT * 3; ++i) this.idx[o + i] = base;
    this.geo.index.needsUpdate = true;
  }
  clear() { for (const p of this.pieces) if (p) this.kill(p); this.pieces.length = 0; this.next = 0; this.geo.setDrawRange(0, 0); }
}

// ---- piece shapes (local frame: x along the wall, y through it, z up) ----
function boxShape(sx, sy, sz) {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const verts = [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z];
  const tris = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { verts, tris };
}
// A convex polygon (points [u,v] in the wall plane) extruded through the wall by t.
function prismShape(poly, t) {
  const n = poly.length, verts = [], tris = [];
  for (let k = 0; k < 2; ++k) for (const [u, v] of poly) verts.push(u, (k ? 1 : -1) * t / 2, v);
  for (let i = 1; i < n - 1; ++i) { tris.push(0, i + 1, i); tris.push(n, n + i, n + i + 1); }
  for (let i = 0; i < n; ++i) { const j = (i + 1) % n; tris.push(i, j, n + j, i, n + j, n + i); }
  return { verts, tris };
}
// Sutherland-Hodgman clip of a polygon to the rectangle [0,W] x [0,H].
function clipRect(poly, W, H) {
  const edges = [[1, 0, 0], [-1, 0, W], [0, 1, 0], [0, -1, H]];  // a*u + b*v + c >= 0 inside
  let out = poly;
  for (const [a, b, c] of edges) {
    const inp = out; out = [];
    for (let i = 0; i < inp.length; ++i) {
      const P = inp[i], Q = inp[(i + 1) % inp.length];
      const dp = a * P[0] + b * P[1] + c, dq = a * Q[0] + b * Q[1] + c;
      if (dp >= 0) out.push(P);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
    }
    if (out.length < 3) return [];
  }
  return out;
}
function area(poly) { let a = 0; for (let i = 0; i < poly.length; ++i) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
function centroid(poly) { let u = 0, v = 0; for (const p of poly) { u += p[0]; v += p[1]; } return [u / poly.length, v / poly.length]; }

export class Destruction {
  constructor(THREE, scene) {
    this.THREE = THREE;
    // Flat shading: the pieces carry no normal attribute, so the shader derives each face's
    // normal from its own plane, which is also how shards and bricks should look.
    const glassMat = new THREE.MeshPhysicalMaterial({ color: '#dfeefc', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 1, vertexColors: true, depthWrite: false, side: THREE.DoubleSide, flatShading: true });
    const rubbleMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, vertexColors: true, flatShading: true });
    this.glass = new DebrisField(THREE, scene, glassMat, 320);
    this.rubble = new DebrisField(THREE, scene, rubbleMat, 480);
    this.rng = Math.random;
  }
  reset() { this.glass.clear(); this.rubble.clear(); }
  update(dt) { this.glass.update(dt); this.rubble.update(dt); }

  // Breaks one wall section. Returns the material name for the HUD.
  breakSection(seg, hit) {
    const { THREE } = this;
    const L = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay), H = seg.z1 - seg.z0;
    const ex = (seg.bx - seg.ax) / L, ey = (seg.by - seg.ay) / L;        // along the wall
    const nx = hit.nx, ny = hit.ny;                                     // out of the wall, toward the car
    const uHit = Math.max(0, Math.min(L, (hit.px - seg.ax) * ex + (hit.py - seg.ay) * ey));
    const vHit = Math.max(0.1, Math.min(H, 0.55 - seg.z0));             // bumper height
    // the car's velocity, through the wall (-n) and along it
    const vThrough = -(hit.vel[0] * nx + hit.vel[1] * ny), vAlong = hit.vel[0] * ex + hit.vel[1] * ey;
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(ey, ex));
    const place = (u, v, through) => new THREE.Vector3(seg.ax + ex * u - nx * through, seg.ay + ey * u - ny * through, seg.z0 + v);
    const fling = (u, v, radius, f) => {
      // pieces near the hit carry the car's speed, far ones topple
      const r = Math.hypot(u - uHit, v - vHit);
      const k = Math.max(0.04, Math.min(1, 1 - r / radius)) * f;
      const spread = (this.rng() - 0.5) * 2;
      return new THREE.Vector3(
        -nx * (vThrough * k * (0.6 + 0.4 * this.rng())) + ex * (vAlong * k + spread * 1.5 * k),
        -ny * (vThrough * k * (0.6 + 0.4 * this.rng())) + ey * (vAlong * k + spread * 1.5 * k),
        1.5 * k + this.rng() * 1.2 * k);
    };
    const ang = (k) => new THREE.Vector3((this.rng() - 0.5) * 16 * k, (this.rng() - 0.5) * 16 * k, (this.rng() - 0.5) * 10 * k);

    if (seg.material === 1) {
      // Glass: radial cracks from the hit, rings growing outward, cells clipped to the pane.
      const rays = 11 + Math.floor(this.rng() * 4), rings = [0.12, 0.26, 0.45, 0.72, 1.05, 1.5, 2.1, 2.9, 4.2, 6.0];
      const angles = []; for (let i = 0; i < rays; ++i) angles.push((i + 0.6 * (this.rng() - 0.5)) * 2 * Math.PI / rays);
      const pt = (a, r) => [uHit + Math.cos(a) * r, vHit + Math.sin(a) * r];
      const jit = () => 1 + (this.rng() - 0.5) * 0.35;
      for (let i = 0; i < rays; ++i) {
        const a0 = angles[i], a1 = angles[(i + 1) % rays] + (i === rays - 1 ? 2 * Math.PI : 0);
        for (let k = 0; k < rings.length; ++k) {
          const r0 = k === 0 ? 0 : rings[k - 1] * jit(), r1 = rings[k] * jit();
          const poly = clipRect(k === 0 ? [[uHit, vHit], pt(a0, r1), pt(0.5 * (a0 + a1), r1 * 1.05), pt(a1, r1)]
                                        : [pt(a0, r0), pt(a0, r1), pt(0.5 * (a0 + a1), r1 * 1.05), pt(a1, r1), pt(a1, r0)], L, H);
          if (poly.length < 3 || area(poly) < 0.002) continue;
          const [cu, cv] = centroid(poly);
          const local = poly.map(([u, v]) => [u - cu, v - cv]);
          const { verts, tris } = prismShape(local, 0.01);
          const p = this.glass.spawn(verts, tris, [0.86, 0.93, 1.0], {
            pos: place(cu, cv, 0), vel: fling(cu, cv, 2.6, 0.9), ang: ang(Math.max(0.2, 1 - Math.hypot(cu - uHit, cv - vHit) / 2.6)),
            rest: 0.01, life: 7 + this.rng() * 5,
          });
          p.q.copy(yawQ);
        }
      }
      return 'glass storefront';
    }
    if (seg.material === 2) {
      // Hollow blocks, 390 x 190 x 190 mm in running bond.
      const bw = 0.39 + 0.01, bh = 0.19 + 0.01, bt = 0.19;
      const rows = Math.round(H / bh);
      for (let r = 0; r < rows; ++r) {
        const off = r % 2 ? bw / 2 : 0;
        for (let u0 = -off; u0 < L; u0 += bw) {
          const u1 = Math.min(L, u0 + bw), uu = Math.max(0, u0);
          if (u1 - uu < 0.08) continue;
          const w = u1 - uu, cu = uu + w / 2, cv = r * bh + bh / 2;
          const { verts, tris } = boxShape(w - 0.01, bt, bh - 0.01);
          const shade = 0.55 + this.rng() * 0.15;
          const p = this.rubble.spawn(verts, tris, [shade, shade * 0.98, shade * 0.93], {
            pos: place(cu, cv, 0), vel: fling(cu, cv, 1.7, 0.75), ang: ang(Math.max(0.1, 1 - Math.hypot(cu - uHit, cv - vHit) / 1.7)), rest: bt / 2,
          });
          p.q.copy(yawQ);
        }
      }
      return 'block wall';
    }
    // Bricks, 215 x 102 x 65 mm, two leaves: chunks of 2-3 bricks across and 1-2 courses high,
    // smaller near the hit.
    const bl = 0.225, bh = 0.075, bt = 0.215;
    let v = 0;
    while (v < H - 0.02) {
      const courses = (this.rng() < 0.5 ? 2 : 1), ch = Math.min(courses * bh, H - v);
      let u = (v / bh) % 2 ? -bl / 2 : 0;
      while (u < L - 0.03) {
        const near = Math.hypot(u - uHit, v - vHit) < 0.9;
        const n = near ? 1 + Math.floor(this.rng() * 2) : 2 + Math.floor(this.rng() * 2);
        const u1 = Math.min(L, u + n * bl), uu = Math.max(0, u), w = u1 - uu;
        if (w > 0.06) {
          const cu = uu + w / 2, cv = v + ch / 2;
          const { verts, tris } = boxShape(w - 0.008, bt, ch - 0.008);
          const t = this.rng();
          const col = [0.62 + 0.2 * t, 0.27 + 0.1 * t, 0.2 + 0.06 * t];
          const p = this.rubble.spawn(verts, tris, col, {
            pos: place(cu, cv, 0), vel: fling(cu, cv, 1.5, 0.7), ang: ang(Math.max(0.1, 1 - Math.hypot(cu - uHit, cv - vHit) / 1.5)), rest: Math.min(bt, ch) / 2,
          });
          p.q.copy(yawQ);
        }
        u = u1;
      }
      v += ch;
    }
    return 'brick wall';
  }
}
