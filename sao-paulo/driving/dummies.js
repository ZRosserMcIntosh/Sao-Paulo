// São Paulo World · driving test track: crash test dummies.
// Two seated dummies (driver left, passenger right). Their torso and head follow the occupant
// model in the physics core (ord/crash.hpp): the travel of the torso from the seat and of the head
// on the neck, in the car's frame. Stand-in figures built from primitives.
import * as THREE from 'three';

const v3 = (x, y, z) => new THREE.Vector3(x, z, -y); // ISO -> three.js

const yellow = new THREE.MeshStandardMaterial({ color: '#f2c51b', roughness: 0.55 });
const black = new THREE.MeshStandardMaterial({ color: '#1b1c1f', roughness: 0.6 });
const belt = new THREE.MeshStandardMaterial({ color: '#2a2e35', roughness: 0.8 });
const VERDICT_COLOURS = ['#2fbf71', '#9bd14b', '#f0c419', '#ff8a2a', '#e5383b'];

function targetTexture() {
  // the black-and-yellow quadrant target painted on crash dummies' heads
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#f2c51b'; g.fillRect(0, 0, 128, 64);
  for (const cx of [32, 96]) {
    g.fillStyle = '#111';
    g.beginPath(); g.moveTo(cx, 32); g.arc(cx, 32, 14, 0, Math.PI / 2); g.fill();
    g.beginPath(); g.moveTo(cx, 32); g.arc(cx, 32, 14, Math.PI, Math.PI * 1.5); g.fill();
    g.strokeStyle = '#111'; g.lineWidth = 2; g.beginPath(); g.arc(cx, 32, 14, 0, Math.PI * 2); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const headMat = new THREE.MeshStandardMaterial({ map: targetTexture(), roughness: 0.5 });

function limb(a, b, r, m) {
  const pa = v3(...a), pb = v3(...b), d = pb.clone().sub(pa), len = d.length();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 10), m);
  mesh.position.copy(pa).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  mesh.castShadow = true;
  return mesh;
}
function joint(p, r) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), black); m.position.copy(v3(...p)); return m; }

class Dummy {
  constructor(side) {
    this.root = new THREE.Group();
    // legs and pelvis stay in the seat
    this.root.add(joint([0, 0, 0], 0.11));
    for (const y of [0.1, -0.1]) {
      this.root.add(limb([0, y, 0], [0.42, y, 0.04], 0.075, yellow), joint([0.42, y, 0.04], 0.06));
      this.root.add(limb([0.42, y, 0.04], [0.52, y, -0.38], 0.06, yellow), limb([0.52, y, -0.4], [0.64, y, -0.42], 0.045, black));
    }
    // torso pivots at the hip, head at the neck
    this.torso = new THREE.Group(); this.root.add(this.torso);
    this.torso.add(limb([0, 0, 0.05], [-0.1, 0, 0.5], 0.14, yellow));
    this.band = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 6, 20), new THREE.MeshStandardMaterial({ color: '#2fbf71', roughness: 0.5 }));
    this.band.position.copy(v3(-0.06, 0, 0.32)); this.band.rotation.x = Math.PI / 2; this.torso.add(this.band);
    // seat belt: diagonal sash and lap belt (hidden when unbelted)
    this.belts = new THREE.Group();
    this.belts.add(limb([-0.12, 0.17 * side, 0.52], [0.06, -0.15 * side, 0.06], 0.02, belt), limb([0.05, 0.17, 0.05], [0.05, -0.17, 0.05], 0.02, belt));
    this.torso.add(this.belts);
    for (const y of [0.2, -0.2]) {
      this.torso.add(joint([-0.1, y, 0.47], 0.055));
      this.torso.add(limb([-0.1, y, 0.47], [0.12, y * 1.05, 0.3], 0.045, yellow), joint([0.12, y * 1.05, 0.3], 0.04));
      this.torso.add(limb([0.12, y * 1.05, 0.3], [0.36, y * 0.9, 0.42], 0.04, yellow));
    }
    this.neck = new THREE.Group(); this.neck.position.copy(v3(-0.1, 0, 0.56)); this.torso.add(this.neck);
    this.neck.add(limb([0, 0, 0], [0.02, 0, 0.1], 0.035, black));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), headMat);
    head.scale.set(1, 1.18, 0.92); head.position.copy(v3(0.03, 0, 0.2)); head.rotation.y = Math.PI / 2; head.castShadow = true;
    this.neck.add(head);
  }
}

export class CrashDummies {
  constructor(parent) {
    this.group = new THREE.Group();
    this.dummies = [new Dummy(1), new Dummy(-1)];
    for (const d of this.dummies) this.group.add(d.root);
    parent.add(this.group);
  }
  // Seats in the car's body frame (ISO, m): hip point x, z and the two seat y's.
  place(x, z, ys = [0.37, -0.37]) {
    this.dummies.forEach((d, i) => d.root.position.copy(v3(x, ys[i], z)));
  }
  set visible(v) { this.group.visible = v; }
  get visible() { return this.group.visible; }
  setBelted(on) { for (const d of this.dummies) d.belts.visible = on; }
  // occ: [torso dx, dy, head dx, dy] per seat (body frame, m); verdict code per seat (-1 = none yet)
  update(i, tdx, tdy, hdx, hdy, verdict) {
    const d = this.dummies[i];
    const sh = 0.4, nk = 0.22; // chest above the hip, head above the neck pivot
    const pitch = Math.max(-0.5, Math.min(1.2, Math.atan2(tdx, sh))), roll = Math.max(-0.9, Math.min(0.9, Math.atan2(tdy, sh)));
    d.torso.rotation.set(-roll, 0, -pitch, 'XZY');           // forward = about three z, sideways = about three x
    const hp = Math.atan2(hdx - tdx, nk), hr = Math.atan2(hdy - tdy, nk);
    d.neck.rotation.set(-hr, 0, -hp, 'XZY');
    d.band.material.color.set(verdict >= 0 ? VERDICT_COLOURS[verdict] : '#2fbf71');
  }
}
