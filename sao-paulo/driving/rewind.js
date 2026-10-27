// São Paulo World · driving test track: rewind, ghosts and the shadow car.
//
// Rewind (hold Backspace, or the ⟲ button): the physics core is deterministic, so a drive is
// its starting state plus the frame times and inputs that followed. Every ~0.1 s the page asks
// the core for a snapshot of the whole simulation (car, dummies, walls); in between it keeps each
// frame's time step and inputs, and the pose to draw. Rewinding plays the poses backwards; letting
// go restores the snapshot before that moment and replays the frames up to it, so the car carries
// on from exactly that frame, as if you had driven it from there.
//
// Ghost: your previous run from the same start, drawn as a see-through car beside you.
// Shadow car: a second car the core drives with your exact inputs, with the stock setup or another
// model, colliding with nothing: your setup against stock, or one car against another, same hands.
// SPDX-License-Identifier: MIT

const FRAMES = 1500;         // ~25 s at 60 fps
const SNAP_EVERY = 6;        // frames between snapshots (~0.1 s)

export class Rewind {
  constructor(M) {
    this.M = M;
    this.frames = [];         // { dt, inp, pose, snap: bool }
    this.active = false;
    this.cursor = 0;          // frames back from the newest while rewinding
    this.sinceSnap = SNAP_EVERY;
  }

  clear() { this.frames = []; this.M._ord_snap_clear(); this.sinceSnap = SNAP_EVERY; this.active = false; }

  // Before a live frame's physics: snapshot when due. After it: remember dt, inputs and the pose.
  beforeFrame() {
    if (this.sinceSnap >= SNAP_EVERY) { this.M._ord_snap_push(); this.sinceSnap = 0; return true; }
    return false;
  }
  afterFrame(snap, dt, inp, pose) {
    ++this.sinceSnap;
    this.frames.push({ dt, inp: { ...inp }, pose, snap });
    if (this.frames.length > FRAMES) this.frames.shift();
  }

  // Hold to rewind: `speed` frames per rendered frame. Returns the pose to draw.
  stepBack(speed = 2) {
    if (!this.frames.length) return null;
    this.active = true;
    this.cursor = Math.min(this.frames.length - 1, this.cursor + speed);
    return this.frames[this.frames.length - 1 - this.cursor].pose;
  }

  // Let go: restore the latest snapshot at or before the shown frame and re-run to it.
  resume(applyInput) {
    if (!this.active) return false;
    this.active = false;
    const target = this.frames.length - 1 - this.cursor;  // index of the frame now shown
    this.cursor = 0;
    // frames[i].snap: a snapshot was taken just before frame i ran
    let s = target;
    while (s >= 0 && !this.frames[s].snap) --s;
    if (s < 0) { return false; }
    // snapshots newer than frames[s] are dropped: count them
    let newer = 0;
    for (let i = s + 1; i < this.frames.length; ++i) if (this.frames[i].snap) ++newer;
    if (!this.M._ord_snap_restore(newer)) return false;
    // the restored snapshot stays; re-run frames s..target, then forget the rest
    for (let i = s; i <= target; ++i) { const f = this.frames[i]; applyInput(f.inp); this.M._ord_advance(f.dt); }
    this.frames.length = target + 1;
    // frames[s].snap remains valid; next live frame continues counting from there
    this.sinceSnap = target - s + 1;
    return true;
  }
}

// A see-through car drawn from a pose stream: the ghost and the shadow car share it.
export class GhostCar {
  constructor(THREE, scene, color) {
    this.THREE = THREE;
    this.root = new THREE.Group(); this.root.visible = false;
    scene.add(this.root);
    this.mat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, roughness: 0.5 });
    this.wheels = [];
  }
  build(geo) {
    const { THREE } = this;
    this.root.clear(); this.wheels = [];
    const len = geo.xf - geo.xr + 1.7, wid = 2 * geo.half - 0.3, bottom = geo.groundZ + 0.16, top = geo.groundZ + 0.92;
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, top - bottom, wid), this.mat);
    body.position.set((geo.xf + geo.xr) / 2, (top + bottom) / 2, 0);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(len * 0.48, 0.42, wid * 0.86), this.mat);
    cabin.position.set((geo.xf + geo.xr) / 2 - len * 0.08, top + 0.21, 0);
    this.root.add(body, cabin);
    for (const w of geo.wheels) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(w.r, w.r, 0.24, 20), this.mat);
      m.rotation.x = Math.PI / 2;
      const g = new THREE.Group(); g.position.set(w.x, w.z, -w.y); g.add(m);
      this.root.add(g); this.wheels.push({ g, base: w.z });
    }
  }
  // pose: { x, y, z, qw, qx, qy, qz, wz[], steer[] } in ISO
  draw(p) {
    if (!p) { this.root.visible = false; return; }
    this.root.visible = true;
    this.root.position.set(p.x, p.z, -p.y);
    this.root.quaternion.set(p.qx, p.qz, -p.qy, p.qw);
    for (let w = 0; w < this.wheels.length; ++w) {
      const wh = this.wheels[w];
      if (p.wz) wh.g.position.y = p.wz[w];
      if (p.steer) wh.g.rotation.y = p.steer[w];
    }
  }
}
