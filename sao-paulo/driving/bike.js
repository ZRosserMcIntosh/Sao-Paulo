// São Paulo World · driving test track: two-wheeler view.
// Draws the four bodies of the OpenRoad Dynamics single-track model (rear wheel, rear frame +
// rider, front frame, front wheel) from the physics state. Stand-in models built from primitives;
// every pose comes from the core.
import * as THREE from 'three';

// ISO 8855 (x forward, y left, z up) -> three.js (y up)
const v3 = (x, y, z) => new THREE.Vector3(x, z, -y);
const q3 = (w, x, y, z) => new THREE.Quaternion(x, z, -y, w);

const STATE = { kind: 0, fallen: 1, speed: 3, lean: 4, steer: 5, pitch: 6, rR: 26, rF: 27, wb: 28, bodies: 32, crownR: 62, crownF: 63, tilt: 65 };

const mat = {
  tyre: new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.9 }),
  rim: new THREE.MeshStandardMaterial({ color: '#b9bec6', roughness: 0.35, metalness: 0.85 }),
  frame: new THREE.MeshStandardMaterial({ color: '#d22a1f', roughness: 0.35, metalness: 0.4 }),
  dark: new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.6, metalness: 0.3 }),
  chrome: new THREE.MeshStandardMaterial({ color: '#d7dbe0', roughness: 0.2, metalness: 1 }),
  deck: new THREE.MeshStandardMaterial({ color: '#30353c', roughness: 0.8 }),
  jacket: new THREE.MeshStandardMaterial({ color: '#1d4f91', roughness: 0.7 }),
  pants: new THREE.MeshStandardMaterial({ color: '#23262b', roughness: 0.8 }),
  skin: new THREE.MeshStandardMaterial({ color: '#c58c62', roughness: 0.7 }),
  helmet: new THREE.MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.25, metalness: 0.2 }),
  visor: new THREE.MeshStandardMaterial({ color: '#1b2633', roughness: 0.1, metalness: 0.6 }),
};

// A cylinder between two ISO points.
function tube(a, b, r, m) {
  const pa = v3(...a), pb = v3(...b), d = pb.clone().sub(pa), len = d.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), m);
  mesh.position.copy(pa).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  mesh.castShadow = true;
  return mesh;
}
function box(c, size, m) { // size ISO (x, y, z)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[2], size[1]), m);
  mesh.position.copy(v3(...c)); mesh.castShadow = true;
  return mesh;
}
function ball(c, r, m) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m);
  mesh.position.copy(v3(...c)); mesh.castShadow = true;
  return mesh;
}
function wheel(cx, r, crown, spokes) {
  const g = new THREE.Group();
  const tubeR = Math.max(0.012, crown || 0.02);
  const t = new THREE.Mesh(new THREE.TorusGeometry(r - tubeR, tubeR, 10, 40), mat.tyre);
  t.castShadow = true; g.add(t);
  const rimR = r - 2 * tubeR;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(rimR, Math.max(0.008, tubeR * 0.35), 6, 40), mat.rim); g.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 10), mat.dark); hub.rotation.x = Math.PI / 2; g.add(hub);
  const n = spokes ?? 6;
  for (let k = 0; k < n; ++k) {
    const a = (k / n) * Math.PI * 2;
    const s = new THREE.Mesh(new THREE.BoxGeometry(rimR, n > 8 ? 0.004 : 0.03, n > 8 ? 0.004 : 0.02), n > 8 ? mat.chrome : mat.rim);
    s.position.set(Math.cos(a) * rimR * 0.5, Math.sin(a) * rimR * 0.5, 0); s.rotation.z = a; g.add(s);
  }
  g.position.copy(v3(cx, 0, r));  // torus axis is three z = ISO y: the axle
  return g;
}

// Parts per body, in the bike's reference frame (ISO, origin at the rear contact, heading +x).
function buildParts(kind, s) {
  const { rR, rF, wb, tilt, crownR, crownF } = s;
  const ax = -Math.sin(tilt), az = Math.cos(tilt); // up the steer axis
  const forkLen = [0.78, 0.98, 0.62][kind];
  const fTop = [wb + ax * forkLen, 0, rF + az * forkLen];
  const bar = [fTop[0] - 0.04, 0, fTop[2] + 0.03];
  const halfBar = [0.26, 0.24, 0.33][kind];
  const parts = [[], [], [], []];
  // wheels
  parts[0].push(wheel(0, rR, crownR, kind === 0 ? 24 : 5));
  parts[3].push(wheel(wb, rF, crownF, kind === 0 ? 24 : 5));
  // front frame: fork, stem and handlebar
  const P = parts[2];
  if (kind === 2) {
    for (const y of [-0.09, 0.09]) P.push(tube([wb, y, rF], [fTop[0], y, fTop[2]], 0.026, mat.chrome));
    P.push(box([fTop[0], 0, fTop[2]], [0.08, 0.24, 0.05], mat.dark));
    P.push(box([wb - 0.02, 0, rF + 0.2], [0.34, 0.16, 0.03], mat.frame)); // mudguard
    P.push(box([fTop[0] + 0.12, 0, fTop[2] - 0.05], [0.14, 0.18, 0.12], mat.frame)); // headlight cowl
  } else {
    for (const y of kind === 0 ? [-0.045, 0.045] : [0]) P.push(tube([wb, y, rF], [fTop[0], y, fTop[2]], kind === 0 ? 0.012 : 0.022, kind === 0 ? mat.frame : mat.dark));
  }
  P.push(tube([bar[0], -halfBar, bar[2]], [bar[0], halfBar, bar[2]], 0.014, mat.dark));
  for (const y of [-halfBar, halfBar]) P.push(tube([bar[0], y * 0.82, bar[2]], [bar[0], y, bar[2]], 0.02, mat.dark));
  // rear frame and rider
  const R = parts[1];
  let hip, shoulder, head, feet, knees;
  const headTop = [wb + ax * forkLen * 0.62, 0, rF + az * forkLen * 0.62];
  const headBot = [wb + ax * forkLen * 0.4, 0, rF + az * forkLen * 0.4];
  if (kind === 0) {
    const bb = [0.42, 0, 0.27], seat = [0.27, 0, 0.88], cluster = [0.31, 0, 0.78];
    R.push(tube([0, 0, rR], bb, 0.011, mat.frame), tube([0, 0, rR], cluster, 0.010, mat.frame));
    R.push(tube(bb, cluster, 0.016, mat.frame), tube(cluster, headTop, 0.015, mat.frame), tube(bb, headBot, 0.018, mat.frame));
    R.push(tube(cluster, seat, 0.012, mat.chrome), box([seat[0], 0, seat[2] + 0.02], [0.24, 0.12, 0.04], mat.dark));
    R.push(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.01, 18), mat.chrome));
    R[R.length - 1].position.copy(v3(...bb)); R[R.length - 1].rotation.x = Math.PI / 2;
    hip = [0.28, 0, 0.98]; shoulder = [0.6, 0, 1.36]; head = [0.68, 0, 1.53];
    feet = [[0.5, 0.15, 0.2], [0.34, -0.15, 0.36]]; knees = [[0.55, 0.15, 0.62], [0.52, -0.15, 0.7]];
  } else if (kind === 1) {
    R.push(box([0.42, 0, 0.14], [0.66, 0.16, 0.05], mat.deck));
    R.push(tube([0, 0, rR], [0.12, 0, 0.14], 0.014, mat.dark));
    R.push(tube([0.72, 0, 0.14], headBot, 0.02, mat.dark));
    hip = [0.38, 0, 0.98]; shoulder = [0.47, 0, 1.47]; head = [0.5, 0, 1.64];
    feet = [[0.5, 0.05, 0.18], [0.3, -0.05, 0.18]]; knees = [[0.45, 0.07, 0.58], [0.35, -0.07, 0.58]];
  } else {
    R.push(box([0.78, 0, 0.42], [0.52, 0.3, 0.38], mat.dark));        // engine
    R.push(box([0.98, 0, 0.78], [0.42, 0.3, 0.2], mat.frame));       // tank
    R.push(box([0.5, 0, 0.8], [0.42, 0.24, 0.07], mat.dark));        // seat
    R.push(box([0.24, 0, 0.86], [0.34, 0.16, 0.1], mat.frame));      // tail
    R.push(box([1.15, 0, 0.62], [0.3, 0.36, 0.42], mat.frame));      // fairing sides
    for (const y of [-0.08, 0.08]) R.push(tube([0, y, rR], [0.6, y, 0.42], 0.025, mat.chrome)); // swingarm
    R.push(tube([0.62, 0.12, 0.36], [-0.05, 0.18, 0.42], 0.035, mat.chrome)); // exhaust
    hip = [0.48, 0, 0.9]; shoulder = [0.86, 0, 1.24]; head = [0.95, 0, 1.38];
    feet = [[0.45, 0.24, 0.36], [0.45, -0.24, 0.36]]; knees = [[0.78, 0.24, 0.68], [0.78, -0.24, 0.68]];
  }
  // rider (rigid with the rear frame, like the physics)
  R.push(tube(hip, shoulder, kind === 2 ? 0.15 : 0.13, mat.jacket));
  R.push(ball(head, kind === 1 ? 0.11 : 0.13, kind === 0 ? mat.skin : mat.helmet));
  if (kind !== 0) R.push(box([head[0] + 0.1, 0, head[2]], [0.04, 0.17, 0.07], mat.visor));
  for (const side of [1, -1]) {
    const sh = [shoulder[0], 0.18 * side, shoulder[2] - 0.03];
    const hand = [bar[0] + 0.02, (halfBar - 0.04) * side, bar[2] + 0.02];
    const elbow = [(sh[0] + hand[0]) / 2 - 0.02, 0.22 * side, (sh[2] + hand[2]) / 2 - 0.06];
    R.push(tube(sh, elbow, 0.045, mat.jacket), tube(elbow, hand, 0.04, mat.jacket), ball(hand, 0.045, mat.skin));
  }
  for (let k = 0; k < 2; ++k) {
    const hp = [hip[0], (k === 0 ? 0.1 : -0.1), hip[2] - 0.02];
    R.push(tube(hp, knees[k], 0.07, mat.pants), tube(knees[k], feet[k], 0.055, mat.pants), box(feet[k], [0.22, 0.09, 0.07], mat.dark));
  }
  return parts;
}

export class BikeView {
  constructor(scene) {
    this.root = new THREE.Group();
    this.bodies = [0, 1, 2, 3].map(() => { const g = new THREE.Group(); this.root.add(g); return g; });
    this.root.visible = false;
    scene.add(this.root);
    this.kind = -1;
    this.rearFrameInv = new THREE.Matrix4();
  }
  // Rebuilds the meshes for `kind` from the state right after ord_bike_create (upright, at rest
  // pose), so each part sits in its body's frame exactly where the physics has that body.
  build(B) {
    const kind = B(STATE.kind);
    for (const g of this.bodies) g.clear();
    const s = { rR: B(STATE.rR), rF: B(STATE.rF), wb: B(STATE.wb), tilt: B(STATE.tilt), crownR: B(STATE.crownR), crownF: B(STATE.crownF) };
    const parts = buildParts(kind, s);
    const yaw = B(22), c0 = v3(B(23), B(24), B(25));
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (let i = 0; i < 4; ++i) {
      const o = STATE.bodies + 7 * i;
      const xi = v3(B(o), B(o + 1), B(o + 2)), qi = q3(B(o + 3), B(o + 4), B(o + 5), B(o + 6));
      const qInv = qi.clone().invert();
      const content = new THREE.Group();
      content.quaternion.copy(qInv).multiply(qYaw);
      content.position.copy(c0).sub(xi).applyQuaternion(qInv);
      for (const p of parts[i]) content.add(p);
      this.bodies[i].add(content);
      if (i === 1) this.headLocal = { content, head: [s, kind] };
    }
    this.kind = kind;
    this.headRef = kind === 2 ? [1.0, 0, 1.45] : kind === 1 ? [0.55, 0, 1.72] : [0.74, 0, 1.62];
    this.update(B);
  }
  update(B) {
    for (let i = 0; i < 4; ++i) {
      const o = STATE.bodies + 7 * i;
      this.bodies[i].position.copy(v3(B(o), B(o + 1), B(o + 2)));
      this.bodies[i].quaternion.copy(q3(B(o + 3), B(o + 4), B(o + 5), B(o + 6)));
    }
  }
  // Rider's eye in world coordinates (helmet camera), and the rear-frame orientation.
  eye(out) {
    const c = this.headLocal?.content; if (!c) return out;
    c.updateWorldMatrix(true, false);
    return out.copy(v3(...this.headRef)).applyMatrix4(c.matrixWorld);
  }
  frameQuat(out) { return out.copy(this.bodies[1].quaternion); }
  framePos(out) { return out.copy(this.bodies[1].position); }
}
