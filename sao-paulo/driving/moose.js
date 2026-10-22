// São Paulo World · driving test track: the moose test (ISO 3888-2 double lane change, the
// "elk test"). The lane is built for the car being tested (the standard sizes it from the car's
// width), with cones the car knocks over. Drive it yourself, or let the robot test driver run it
// at a set speed or as a speed ladder: it releases the throttle at the entry gate, as the
// standard asks, and steers a line that turns in inside the entry lane with a Stanley
// path-tracking controller (heading and cross-track error, curvature feedforward).
// Pass = through the lane with no cone touched. A rollover is reported as such.
// SPDX-License-Identifier: MIT

// ISO 3888-2:2011 layout, metres. W = vehicle width.
//   section 1 (entry):   12 m long, 1.1 W + 0.25 wide
//   section 2 (gap):     13.5 m
//   section 3 (offset):  11 m long, W + 1 wide; its right edge 1 m left of section 1's left edge
//   section 4 (gap):     12.5 m
//   section 5 (exit):    12 m long, 1.3 W + 0.25 wide (at most 3 m), right edge in line with section 1's
export function mooseLayout(W) {
  const w1 = 1.1 * W + 0.25, w3 = W + 1, w5 = Math.min(3, 1.3 * W + 0.25);
  const r1 = -w1 / 2, l1 = w1 / 2;
  const r3 = l1 + 1, l3 = r3 + w3;
  const r5 = r1, l5 = r5 + w5;
  const s = [
    { x0: 0, x1: 12, r: r1, l: l1 },
    { x0: 25.5, x1: 36.5, r: r3, l: l3 },
    { x0: 49, x1: 61, r: r5, l: l5 },
  ];
  return { w1, w3, w5, s, length: 61, centre: [(r1 + l1) / 2, (r3 + l3) / 2, (r5 + l5) / 2] };
}

// The robot's line: hold the entry lane's centre, then a cosine swing into the offset lane that
// starts well inside the entry lane (the car yaws across the gap, as a test driver does), and a
// cosine back. Distances along the course from the entry gate; tuned once on the simulated cars
// (scratch search, all cars, 50-80 km/h).
const LINE = { a: 9.65, b: 24.7, c: 35.2, e: 49.7, o1: -0.07, o2: 0.08, k: 0.91, prev: 0.079, us: -0.001, yd: 0.069 };
function lineAt(L, d) {
  const cs = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
  const dcs = (t) => (t <= 0 || t >= 1 ? 0 : 0.5 * Math.PI * Math.sin(Math.PI * t));
  const ddcs = (t) => (t <= 0 || t >= 1 ? 0 : 0.5 * Math.PI * Math.PI * Math.cos(Math.PI * t));
  const y1 = L.centre[1] + LINE.o1, y2 = L.centre[2] + LINE.o2;
  let y, dy, ddy;
  if (d < LINE.c) { const w = LINE.b - LINE.a, t = (d - LINE.a) / w; y = y1 * cs(t); dy = (y1 * dcs(t)) / w; ddy = (y1 * ddcs(t)) / (w * w); }
  else { const w = LINE.e - LINE.c, t = (d - LINE.c) / w; y = y1 + (y2 - y1) * cs(t); dy = ((y2 - y1) * dcs(t)) / w; ddy = ((y2 - y1) * ddcs(t)) / (w * w); }
  return { y, psi: Math.atan(dy), k: ddy / Math.pow(1 + dy * dy, 1.5) };
}

export class MooseTest {
  constructor(THREE, parent, { M, S, W, store, toast, carName, maxSteer, launch, x0, y0 }) {
    Object.assign(this, { THREE, parent, M, S, W, store, toast, carName, maxSteer, launch, x0, y0 });
    this.group = new THREE.Group(); parent.add(this.group);
    this.cones = [];
    this.coneGeo = new THREE.ConeGeometry(0.16, 0.7, 16);
    this.coneMat = new THREE.MeshStandardMaterial({ color: '#ff6a13', roughness: 0.6 });
    this.run = null;      // the attempt in progress
    this.robot = null;    // { speed, ladder: bool, next, best, failAt }
    this.results = store.get('mooseResults', {});
    this.last = null;
    this.panel = document.createElement('div');
    this.panel.id = 'moose'; this.panel.className = 'panel'; this.panel.hidden = true;
    (document.getElementById('leftcol') || document.body).append(this.panel);
    this.width = 0;
  }

  // Rebuild the cones for a car of half-track `half` (m): the body is ~12 cm wider each side.
  build(half) {
    const W = 2 * (half + 0.12);
    if (Math.abs(W - this.width) < 1e-3 && this.cones.length) return;
    this.width = W;
    this.L = mooseLayout(W);
    for (const c of this.cones) this.group.remove(c.mesh);
    this.cones = [];
    const { THREE } = this;
    for (const s of this.L.s) {
      const n = Math.round((s.x1 - s.x0) / 3);
      for (let i = 0; i <= n; ++i) for (const side of [s.r, s.l]) {
        const x = this.x0 + s.x0 + (i * (s.x1 - s.x0)) / n, y = this.y0 + side;
        const m = new THREE.Mesh(this.coneGeo, this.coneMat); m.castShadow = true;
        m.position.set(x, 0.35, -y);
        this.group.add(m);
        this.cones.push({ x, y, mesh: m, hit: false, vel: new THREE.Vector3(), spin: 0, axis: new THREE.Vector3(1, 0, 0) });
      }
    }
  }

  resetCones() {
    for (const c of this.cones) { c.hit = false; c.mesh.position.set(c.x, 0.35, -c.y); c.mesh.rotation.set(0, 0, 0); c.vel.set(0, 0, 0); c.spin = 0; }
  }

  // The robot test driver's input; null when it isn't driving.
  control(dt) {
    const R = this.robot;
    if (!R || !R.driving) return null;
    const { S, W } = this;
    const x = S(0), y = S(1), v = S(7);
    const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
    const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
    const d = x - this.x0;
    // Stanley path tracking at the front axle (heading error + cross-track error), with the
    // line's curvature as feedforward a little ahead, and a touch of yaw damping
    const xs = [0, 1, 2, 3].map((w) => W(w, 0)), xfa = Math.max(...xs), wb = Math.max(1.5, xfa - Math.min(...xs));
    const fd = d + xfa * Math.cos(yaw), fy = y - this.y0 + xfa * Math.sin(yaw);
    const r = lineAt(this.L, fd), rp = lineAt(this.L, fd + LINE.prev * Math.max(1, v));
    const delta = Math.atan(wb * rp.k * (1 + LINE.us * v * v)) + (r.psi - yaw) + Math.atan2(LINE.k * (r.y - fy), Math.max(1, v) + 2) - LINE.yd * S(9);
    // the presets shape the steering (speed-sensitive in Fun and Sport): close the loop on the
    // road-wheel angle the physics reports, so the robot gets the angle it asks for
    const ms = this.maxSteer() || 0.55;
    R.trim = Math.max(-1, Math.min(1, (R.trim || 0) + ((delta - S(16)) / ms) * 10 * dt));
    const steer = Math.max(-1, Math.min(1, delta / ms + R.trim));
    // hold the target speed up to the entry gate, then coast (ISO 3888-2: throttle released)
    const target = R.speed / 3.6;
    const throttle = d < -1 ? Math.max(0, Math.min(1, (target - v) * 0.6)) : 0;
    const brake = d < -1 && v > target + 1 ? Math.min(1, (v - target) * 0.3) : d > this.L.length + 10 ? 0.6 : 0;
    return { steer, throttle, brake, hand: 0, shiftUp: false, shiftDown: false };
  }

  startRobot(speed, ladder) {
    this.robot = { speed, ladder, driving: true, best: null, failAt: null, wait: 0, trim: 0 };
    this.panel.hidden = false;
    this.attempt();
  }
  stopRobot() { if (this.robot) { this.robot = null; this.toast('Robot driver stopped'); } }

  attempt() {
    this.resetCones();
    this.run = null;
    this.robot.driving = true; this.robot.trim = 0;
    // a run-up long enough to settle at the speed
    this.launch(this.x0 - 70, this.y0 + this.L.centre[0], 0, this.robot.speed / 3.6);
  }

  update(dt, carVisible = true) {
    const { S, W } = this;
    const x = S(0), y = S(1), v = S(7), up = S(36);
    const d = x - this.x0;
    const inLane = d > -5 && d < this.L.length + 20 && Math.abs(y - this.y0) < 9;
    if (inLane || this.robot) this.panel.hidden = false;
    // start: the car's centre crosses the entry gate inside the lane
    if (!this.run && d >= 0 && d < 3 && Math.abs(y - (this.y0 + this.L.centre[0])) < this.L.w1 / 2 + 0.5 && v > 2) {
      this.run = { vIn: v * 3.6, cones: 0, rolled: false, t: 0 };
      this.resetCones();
    }
    // cones: the body's footprint (wheel layout + overhangs, as the physics uses for walls)
    const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
    const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const xs = [0, 1, 2, 3].map((w) => W(w, 0)), ys = [0, 1, 2, 3].map((w) => Math.abs(W(w, 1)));
    const xf = Math.max(...xs) + 1.0, xr = Math.min(...xs) - 1.15, hw = Math.max(...ys) + 0.16 + 0.12;
    for (const cn of this.cones) {
      if (!cn.hit) {
        const dx = cn.x - x, dy = cn.y - y;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) continue;
        const lx = dx * c + dy * s, ly = -dx * s + dy * c;
        if (lx > xr && lx < xf && Math.abs(ly) < hw && S(2) < 1.6) {
          cn.hit = true;
          if (this.run) this.run.cones++;
          const vx = S(7) * c - S(8) * s, vy = S(7) * s + S(8) * c;
          cn.vel.set(vx * 0.8 + Math.sign(dx) * 0.5, 1.5 + Math.random(), -(vy * 0.8 + Math.sign(dy) * 1.5));
          cn.spin = 6 + 6 * Math.random(); cn.axis.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
        }
      } else if (cn.mesh.position.y > 0.17 || cn.vel.lengthSq() > 0.01) {
        cn.vel.y -= 9.81 * dt; cn.mesh.position.addScaledVector(cn.vel, dt);
        if (cn.mesh.position.y < 0.17) { cn.mesh.position.y = 0.17; cn.vel.multiplyScalar(0.5); cn.vel.y = Math.abs(cn.vel.y) * 0.3; }
        cn.mesh.rotateOnAxis(cn.axis, cn.spin * dt); cn.spin *= 0.97;
      }
    }
    if (this.run) {
      this.run.t += dt;
      if (up < 0.3) this.run.rolled = true;
      const done = d > this.L.length + 2;
      const lost = Math.abs(y - this.y0) > 12 || (v < 1 && this.run.t > 1.5) || this.run.t > 12 || this.run.rolled;
      if (done || lost) this.finish(done && !this.run.rolled ? (this.run.cones === 0 ? 'pass' : 'cones') : this.run.rolled ? 'rolled' : 'out');
    }
    if (this.robot && !this.run && this.robot.wait > 0) {
      this.robot.wait -= dt;
      if (this.robot.wait <= 0) this.attempt();
    }
    this.render();
  }

  finish(kind) {
    const r = this.run; this.run = null;
    const name = this.carName();
    const res = (this.results[name] ||= { best: null, tries: [] });
    const vIn = Math.round(r.vIn);
    res.tries.push({ v: vIn, kind, cones: r.cones });
    if (res.tries.length > 30) res.tries.shift();
    if (kind === 'pass') res.best = Math.max(res.best ?? 0, vIn);
    this.store.set('mooseResults', this.results);
    this.last = { kind, vIn, cones: r.cones, name };
    const text = kind === 'pass' ? `Clean at ${vIn} km/h` : kind === 'cones' ? `${r.cones} cone${r.cones > 1 ? 's' : ''} down at ${vIn} km/h` : kind === 'rolled' ? `Rolled over at ${vIn} km/h` : `Off the course at ${vIn} km/h`;
    this.toast('Moose test: ' + text);
    const R = this.robot;
    if (!R) return;
    R.driving = false;
    if (R.ladder) {
      if (kind === 'pass') { R.best = vIn; R.speed += 4; R.wait = 1.6; }
      else {
        R.failAt = { v: vIn, kind };
        this.toast(`Ladder done: best clean entry ${R.best ?? '—'} km/h (${text.toLowerCase()})`);
        this.robot = null;
      }
    } else this.robot = null;
  }

  render() {
    const rows = Object.entries(this.results).map(([n, r]) => {
      const fails = r.tries.filter((t) => t.kind !== 'pass');
      const worst = fails.length ? fails.reduce((a, b) => (b.v < a.v ? b : a)) : null;
      return `<tr><td>${n}</td><td>${r.best ? r.best + ' km/h' : '—'}</td><td>${worst ? worst.v + ' ' + (worst.kind === 'rolled' ? 'rolled' : worst.kind === 'cones' ? worst.cones + ' cones' : 'off') : ''}</td></tr>`;
    }).join('');
    const cur = this.run ? `<b>Running</b> · entry ${this.run.vIn.toFixed(0)} km/h · cones ${this.run.cones}` :
      this.robot ? `<b>Robot driver</b> · ${this.robot.ladder ? 'ladder, next ' : ''}${this.robot.speed} km/h` :
      this.last ? `<b>Last:</b> ${this.last.kind === 'pass' ? 'clean' : this.last.kind} at ${this.last.vIn} km/h` : 'Drive through at a steady speed, then lift off at the gate.';
    this.panel.innerHTML = `<b>Moose test</b> <small>ISO 3888-2 · lane for a ${this.width.toFixed(2)} m car</small><br>${cur}` +
      (rows ? `<table><tr><th>Car</th><th>Best clean</th><th>First fail</th></tr>${rows}</table>` : '');
  }
}
