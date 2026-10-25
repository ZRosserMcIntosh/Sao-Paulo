// Vehicles: ports of entity/vehicle/{Vehicle,Car,Plane}.java. Body frame: +X right, +Y up,
// -Z forward. Car after OpenRoad Dynamics; the plane is the Tupi T-180 (a Cessna 172S).
import { v3, quat, m4 } from './math.js';
import { B, isSolid, isGlass, hardness } from './blocks.js';

export const G = 9.81, RHO = 1.13; // air density at Avenida Paulista (817 m)
const DEG = Math.PI / 180;

export class Controls {
  constructor() { this.throttle = 0; this.brake = 0; this.steer = 0; this.handbrake = false; this.pitch = 0; this.roll = 0; this.yaw = 0; }
}

export class Vehicle {
  constructor() {
    this.pos = [0, 0, 0]; this.vel = [0, 0, 0]; this.rot = quat.identity(); this.omega = [0, 0, 0];
    this.mass = 1000; this.inertia = [1000, 1000, 1000];
    this.force = [0, 0, 0]; this.torque = [0, 0, 0];
    this.hull = []; this.message = null; this.lastImpact = 0; this.destroyed = 0; this.chaseYaw = 0;
  }
  attach(world, particles, sound, glass) { this.world = world; this.particles = particles; this.sound = sound; this.glass = glass; }
  place(x, y, z, yawDeg) { this.pos = [x, y, z]; this.vel = [0, 0, 0]; this.omega = [0, 0, 0]; this.rot = quat.axisAngle(0, 1, 0, yawDeg * DEG); }
  speed() { return v3.len(this.vel); }
  toWorld(b) { return v3.add(quat.rotate(this.rot, b), this.pos); }
  dir(x, y, z) { return quat.rotate(this.rot, [x, y, z]); }
  forward() { return this.dir(0, 0, -1); }
  up() { return this.dir(0, 1, 0); }
  right() { return this.dir(1, 0, 0); }
  pointVel(p) { return v3.add(this.vel, v3.cross(this.omega, v3.sub(p, this.pos))); }
  takeMessage() { const m = this.message; this.message = null; return m; }
  takeImpact() { const s = this.lastImpact; this.lastImpact = 0; return s; }
  model() { return m4.mul(m4.translation(...this.pos), m4.fromQuat(this.rot)); }

  applyForceAt(f, p) {
    this.force = v3.add(this.force, f);
    this.torque = v3.add(this.torque, v3.cross(v3.sub(p, this.pos), f));
  }
  /** Inverse inertia (world) applied to a vector. */
  invI(v) {
    const b = quat.rotate(quat.conj(this.rot), v);
    return quat.rotate(this.rot, [b[0] / this.inertia[0], b[1] / this.inertia[1], b[2] / this.inertia[2]]);
  }
  integrate(dt) {
    this.vel = v3.fma(this.vel, dt / this.mass, this.force);
    const inv = quat.conj(this.rot), I = this.inertia;
    const wb = quat.rotate(inv, this.omega), tb = quat.rotate(inv, this.torque);
    const gyro = v3.cross(wb, [wb[0] * I[0], wb[1] * I[1], wb[2] * I[2]]);
    for (let i = 0; i < 3; i++) wb[i] += (tb[i] - gyro[i]) / I[i] * dt;
    this.omega = quat.rotate(this.rot, wb);
    this.pos = v3.fma(this.pos, dt, this.vel);
    const w = v3.len(this.omega);
    if (w > 1e-9) this.rot = quat.norm(quat.mul(quat.axisAngle(this.omega[0] / w, this.omega[1] / w, this.omega[2] / w, w * dt), this.rot));
    this.force = [0, 0, 0]; this.torque = [0, 0, 0];
  }
  applyImpulse(j, p) {
    this.vel = v3.fma(this.vel, 1 / this.mass, j);
    this.omega = v3.add(this.omega, this.invI(v3.cross(v3.sub(p, this.pos), j)));
  }
  effMass(r, n) { const rn = v3.cross(r, n); return 1 / (1 / this.mass + v3.dot(rn, this.invI(rn))); }

  columnTop(bx, bz, y) {
    const top = Math.floor(y + 0.5);
    for (let by = top; by >= top - 4; by--) {
      if (isSolid(this.world.getBlock(bx, by, bz)) && !isSolid(this.world.getBlock(bx, by + 1, bz))) return by + 1;
    }
    return -Infinity;
  }
  /** Ground under (x, z): one-block steps smoothed into ~2-block ramps, taller ones are walls. */
  groundHeight(x, z, y) {
    const c = this.columnTop(Math.floor(x), Math.floor(z), y);
    if (c === -Infinity) return c;
    let sum = 0;
    for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) {
      sum += this.bilinear(x + i * 0.7, z + k * 0.7, y, c) * (i === 0 && k === 0 ? 4 : i === 0 || k === 0 ? 2 : 1);
    }
    return Math.max(sum / 16, c - 0.6);
  }
  bilinear(x, z, y, c) {
    const fx = x - 0.5, fz = z - 0.5, x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
    const near = (h) => (Math.abs(h - c) <= 1.01 ? h : c);
    const h00 = near(this.columnTop(x0, z0, y)), h10 = near(this.columnTop(x0 + 1, z0, y));
    const h01 = near(this.columnTop(x0, z0 + 1, y)), h11 = near(this.columnTop(x0 + 1, z0 + 1, y));
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Hull points in blocks: knock the block out if the impact beats its hardness, else bounce. */
  collide(dt) {
    const W = this.world;
    for (const h of this.hull) {
      const p = this.toWorld([h[0], h[1], h[2]]);
      const bx = Math.floor(p[0]), by = Math.floor(p[1]), bz = Math.floor(p[2]);
      const block = W.getBlock(bx, by, bz);
      if (!isSolid(block)) continue;
      const v = this.pointVel(p), prev = v3.fma(p, -dt, v);
      const px = Math.floor(prev[0]), py = Math.floor(prev[1]), pz = Math.floor(prev[2]);
      let n, depth;
      if (py !== by && Math.abs(v[1]) > 1e-6) { n = [0, py > by ? 1 : -1, 0]; depth = py > by ? by + 1 - p[1] : p[1] - by; }
      else if (px !== bx) { n = [px > bx ? 1 : -1, 0, 0]; depth = px > bx ? bx + 1 - p[0] : p[0] - bx; }
      else if (pz !== bz) { n = [0, 0, pz > bz ? 1 : -1]; depth = pz > bz ? bz + 1 - p[2] : p[2] - bz; }
      else {
        const ox = this.pos[0] - (bx + 0.5), oy = this.pos[1] - (by + 0.5), oz = this.pos[2] - (bz + 0.5);
        if (Math.abs(oy) >= Math.abs(ox) && Math.abs(oy) >= Math.abs(oz)) { n = [0, Math.sign(oy), 0]; depth = oy > 0 ? by + 1 - p[1] : p[1] - by; }
        else if (Math.abs(ox) >= Math.abs(oz)) { n = [Math.sign(ox), 0, 0]; depth = ox > 0 ? bx + 1 - p[0] : p[0] - bx; }
        else { n = [0, 0, Math.sign(oz)]; depth = oz > 0 ? bz + 1 - p[2] : p[2] - bz; }
      }
      if (h[3] && !isSolid(W.getBlock(bx, by + 1, bz))) { n = [0, 1, 0]; depth = by + 1 - p[1]; } // skid on a ledge
      const vn = v3.dot(v, n);
      if (vn >= 0) { this.pos = v3.fma(this.pos, Math.min(depth, 0.5) * 0.5, n); continue; }
      const r = v3.sub(p, this.pos), me = this.effMass(r, n), energy = 0.5 * me * vn * vn;
      if (isGlass(block)) {
        const absorbed = this.glass.impact(bx, by, bz, energy, v[0], v[1], v[2]);
        if (absorbed >= 0) { this.takeEnergy(n, vn, me, Math.min(absorbed, energy * 0.9), p); this.destroyed++; continue; }
      } else if (energy > hardness(block) * 1000) {
        W.setBlock(bx, by, bz, B.AIR);
        this.destroyed++;
        this.particles.debris(bx, by, bz, block, v[0] * 0.6, Math.abs(vn) * 0.3, v[2] * 0.6, 6);
        this.takeEnergy(n, vn, me, hardness(block) * 1000, p);
        if (hardness(block) > 20) this.sound.play('thud', Math.min(1, energy / 4e5));
        this.lastImpact = Math.max(this.lastImpact, Math.sqrt(2 * hardness(block) * 1000 / this.mass));
        continue;
      }
      const jn = -1.15 * vn * me;
      const vt = v3.fma(v, -vn, n), vtl = v3.len(vt);
      let j = v3.scale(n, jn);
      if (vtl > 1e-6) j = v3.fma(j, -Math.min(0.6 * jn, vtl * me) / vtl, vt);
      this.applyImpulse(j, p);
      this.pos = v3.fma(this.pos, Math.min(depth, 0.5) * 0.8, n);
      this.lastImpact = Math.max(this.lastImpact, -vn);
      if (-vn > 3) this.sound.play('thud', Math.min(1, -vn / 15));
    }
  }
  takeEnergy(n, vn, me, joules, p) {
    const e = 0.5 * me * vn * vn, after = -Math.sqrt(Math.max(0, e - joules) * 2 / me);
    this.applyImpulse(v3.scale(n, (after - vn) * me), p);
  }
  fixNaN() {
    if (Number.isNaN(this.pos[0] + this.vel[0] + this.omega[0] + this.rot[3])) {
      this.vel = [0, 0, 0]; this.omega = [0, 0, 0]; this.rot = quat.identity(); this.pos[1] += 2;
    }
  }
  upsideDown() { return this.up()[1] < 0.3; }
  rightSideUp() {
    const f = this.forward();
    this.rot = quat.axisAngle(0, 1, 0, Math.atan2(-f[0], -f[2]));
    this.omega = [0, 0, 0]; this.vel = [0, 0, 0]; this.pos[1] += 1.5;
  }

  /** Chase camera (orbit in degrees) or the driver's eyes. */
  camera(cam, cockpit, orbitYaw, orbitPitch) {
    const f = this.forward();
    if (cockpit) {
      const eye = this.toWorld(this.seat()), r = this.right();
      const yaw = Math.atan2(-f[0], -f[2]) / DEG, pitch = Math.asin(Math.max(-1, Math.min(1, f[1]))) / DEG;
      const yr = yaw * DEG, lr = [Math.cos(yr), 0, -Math.sin(yr)], lu = v3.scale(v3.cross(f, lr), -1);
      const roll = Math.atan2(-v3.dot(r, lu), v3.dot(r, lr)) / DEG;
      Object.assign(cam, { x: eye[0], y: eye[1], z: eye[2], yaw: yaw + orbitYaw, pitch: pitch + orbitPitch, roll });
      return;
    }
    let yaw = Math.hypot(f[0], f[2]) > 0.2 ? Math.atan2(-f[0], -f[2]) : this.chaseYaw * DEG;
    this.chaseYaw = yaw / DEG;
    yaw += orbitYaw * DEG;
    const pitch = (-12 + orbitPitch) * DEG, d = this.chaseDistance();
    let cx = this.pos[0] + Math.sin(yaw) * Math.cos(pitch) * d, cz = this.pos[2] + Math.cos(yaw) * Math.cos(pitch) * d;
    let cy = this.pos[1] + this.chaseHeight() - Math.sin(pitch) * d * 0.5;
    for (let i = 0; i < 12 && isSolid(this.world.getBlock(Math.floor(cx), Math.floor(cy), Math.floor(cz))); i++) {
      cx = this.pos[0] + (cx - this.pos[0]) * 0.8; cz = this.pos[2] + (cz - this.pos[2]) * 0.8; cy = this.pos[1] + (cy - this.pos[1]) * 0.8 + 0.3;
    }
    Object.assign(cam, {
      x: cx, y: cy, z: cz, roll: 0,
      yaw: Math.atan2(cx - this.pos[0], cz - this.pos[2]) / DEG,
      pitch: Math.atan2(this.pos[1] + 1 - cy, Math.hypot(this.pos[0] - cx, this.pos[2] - cz)) / DEG,
    });
  }
  chaseDistance() { return 7.5; }
  chaseHeight() { return 2.4; }
}

// ------------------------------------------------------------------ cars

const spec = (o) => o;
export const CARS = [
  spec({ name: 'VW Fusca 1300', mass: 880, I: [1050, 1100, 280], wheelbase: 2.4, front: 0.42, trackF: 1.31, trackR: 1.35, cg: 0.55,
    R: 0.32, muX: 0.95, muY: 0.85, cs: 12, kF: 19000, kR: 24000, damper: 2200, steer: 0.55,
    rpms: [800, 1500, 2600, 3600, 4600, 5200], nms: [60, 80, 89, 86, 70, 50], idle: 800, limiter: 5200,
    ratios: [3.80, 2.06, 1.32, 0.89], reverse: 3.88, final: 4.375, eff: 0.88, brakeT: 1400, cdA: 0.86,
    L: 4.08, W: 1.54, H: 1.5, paint: 0x8fc7e8, cyl: 4, kind: 'fusca' }),
  spec({ name: 'Porsche 911 Carrera S', mass: 1553, I: [1850, 2000, 470], wheelbase: 2.45, front: 0.38, trackF: 1.601, trackR: 1.555, cg: 0.47,
    R: 0.345, muX: 1.15, muY: 1.10, cs: 16, kF: 36000, kR: 52000, damper: 3600, steer: 0.5,
    rpms: [800, 1500, 2300, 5000, 6000, 6500, 7000, 7500, 7700], nms: [240, 380, 530, 530, 525, 518, 470, 410, 330], idle: 800, limiter: 7500,
    ratios: [4.89, 3.17, 2.15, 1.56, 1.18, 0.94, 0.76, 0.61], reverse: 3.99, final: 3.12, eff: 0.92, brakeT: 3400, cdA: 0.70,
    L: 4.54, W: 1.85, H: 1.3, paint: 0xc8102e, cyl: 6, kind: '911' }),
  spec({ name: 'Mercedes S 600 Guard (VR9)', mass: 4160, I: [6800, 7200, 1500], wheelbase: 3.165, front: 0.52, trackF: 1.643, trackR: 1.643, cg: 0.6,
    R: 0.36, muX: 1.0, muY: 0.95, cs: 14, kF: 90000, kR: 95000, damper: 9000, steer: 0.52,
    rpms: [600, 1200, 1900, 4000, 4900, 5300, 5800, 6000], nms: [450, 650, 830, 830, 760, 703, 610, 520], idle: 600, limiter: 6000,
    ratios: [4.38, 2.86, 1.92, 1.37, 1.00, 0.82, 0.73], reverse: 3.42, final: 2.82, eff: 0.9, brakeT: 6200, cdA: 0.72,
    L: 5.25, W: 1.9, H: 1.5, paint: 0x14161a, cyl: 12, kind: 's600' }),
];

function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[ys.length - 1];
}

export class Car extends Vehicle {
  constructor(s) {
    super();
    this.s = s; this.mass = s.mass; this.inertia = s.I.slice();
    const a = s.wheelbase * (1 - s.front), b = s.wheelbase * s.front, hy = -s.cg + s.R + 0.15;
    this.hp = [[-s.trackF / 2, hy, -a], [s.trackF / 2, hy, -a], [-s.trackR / 2, hy, b], [s.trackR / 2, hy, b]];
    this.comp = [0, 0, 0, 0]; this.load = [0, 0, 0, 0]; this.spin = [0, 0, 0, 0]; this.skid = [false, false, false, false];
    this.steerAngle = 0; this.gear = 1; this.rpm = 0; this.shiftT = 0; this.thrShown = 0; this.seatbelt = false;
    // probes sit just over a block above the road: one-block steps are left to the wheels
    const l = s.L / 2, w = s.W / 2, top = s.H - s.cg, bot = -s.cg + 1.08;
    this.hull = [[-w, bot, -l], [w, bot, -l], [-w, bot, l], [w, bot, l], [-w, top * 0.6, -l], [w, top * 0.6, -l], [-w, top * 0.6, l], [w, top * 0.6, l],
      [0, bot + 0.1, -l - 0.05], [0, top * 0.5, -l - 0.05], [0, bot + 0.1, l + 0.05], [-w - 0.05, bot + 0.1, 0], [w + 0.05, bot + 0.1, 0],
      [-w * 0.8, top, 0], [w * 0.8, top, 0], [0, top, -l * 0.3], [0, top, l * 0.4]];
  }
  get name() { return this.s.name; }
  seat() { return [-0.35, this.s.H - this.s.cg - 0.42, this.s.wheelbase * 0.05]; }
  toggleSeatbelt() { this.seatbelt = !this.seatbelt; this.message = this.seatbelt ? "Seatbelt on. Boring, but you'll live." : 'Seatbelt off. Fusca physics enabled.'; }
  engineHz() { return this.rpm / 60 * this.s.cyl / 2; }
  update(dt, c) {
    for (let i = 0; i < 4; i++) this.step(dt / 4, c);
    this.collide(dt);
    this.fixNaN();
  }
  step(dt, c) {
    const s = this.s, fwd = this.forward(), up = this.up(), right = this.right();
    const vLong = v3.dot(this.vel, fwd), speed = this.speed();
    const target = c.steer * s.steer / (1 + Math.max(0, Math.abs(vLong) - 5) / 18);
    this.steerAngle += (target - this.steerAngle) * Math.min(1, dt * 8);
    let throttle = c.throttle, brake = c.brake;
    if (brake > 0 && vLong < 0.8 && throttle === 0) { this.gear = -1; throttle = brake; brake = 0; }
    else if (this.gear === -1 && throttle > 0) { if (vLong < -0.5) { brake = throttle; throttle = 0; } else this.gear = 1; }
    this.thrShown = throttle;
    const wheelRpm = Math.abs(vLong) / s.R * 60 / (2 * Math.PI);
    const ratio = this.gear < 0 ? s.reverse : s.ratios[this.gear - 1];
    const coupled = wheelRpm * ratio * s.final;
    const launch = s.idle + (s.limiter - s.idle) * 0.35 * throttle;
    const engineRpm = Math.max(coupled, Math.max(s.idle, coupled < launch ? launch : 0));
    this.rpm += (Math.min(engineRpm, s.limiter * 1.02) - this.rpm) * Math.min(1, dt * 12);
    if (this.gear > 0 && this.shiftT <= 0) {
      if (coupled > s.limiter * 0.94 && this.gear < s.ratios.length) { this.gear++; this.shiftT = 0.25; }
      else if (this.gear > 1 && coupled < s.limiter * 0.42) { this.gear--; this.shiftT = 0.2; }
    }
    this.shiftT -= dt;
    const torque = this.shiftT > 0 || this.rpm >= s.limiter ? 0 : interp(this.rpm, s.rpms, s.nms) * throttle;
    const wheelTorque = torque * ratio * s.final * s.eff * (this.gear < 0 ? -1 : 1);
    this.onGround = false;
    for (let w = 0; w < 4; w++) {
      const front = w < 2, p = this.toWorld(this.hp[w]);
      const ground = this.groundHeight(p[0], p[2], p[1]);
      const reach = (p[1] - ground) / Math.max(0.35, up[1]);
      let comp = 0.32 + s.R - reach;
      const prev = this.comp[w];
      this.comp[w] = Math.max(0, comp); this.load[w] = 0; this.skid[w] = false;
      this.spin[w] += v3.dot(this.vel, fwd) / s.R * dt;
      if (comp <= 0 || ground === -Infinity) continue;
      this.onGround = true;
      comp = Math.min(comp, 0.5);
      const fz = Math.max(0, Math.min((front ? s.kF : s.kR) * comp + s.damper * (comp - prev) / dt, this.mass * G * 4));
      this.load[w] = fz;
      const contact = v3.fma(p, -reach, up);
      this.applyForceAt(v3.scale(up, fz), contact);
      const st = front ? this.steerAngle : 0;
      let wf = v3.fma(v3.scale(fwd, Math.cos(st)), -Math.sin(st), right);
      wf[1] = 0;
      if (wf[0] * wf[0] + wf[2] * wf[2] < 1e-6) continue;
      wf = v3.norm(wf);
      const wr = [-wf[2], 0, wf[0]];
      const pv = this.pointVel(contact), vx = v3.dot(pv, wf), vy = v3.dot(pv, wr);
      const fz0 = this.mass * G / 4, dfz = (fz - fz0) / fz0;
      const Dy = s.muY * (1 - 0.10 * dfz) * fz, Dx = s.muX * (1 - 0.08 * dfz) * fz;
      const ky = s.cs * fz0 * Math.sin(2 * Math.atan(fz / (1.9 * fz0)));
      const alpha = Math.atan2(vy, Math.max(Math.abs(vx), 1.2));
      const Cy = 1.35, Ey = -0.4, By = ky / (Cy * Dy + 1e-9), ba = By * alpha;
      let fy = -Dy * Math.sin(Cy * Math.atan(ba - Ey * (ba - Math.atan(ba))));
      let fx = front ? 0 : wheelTorque / 2 / s.R;
      let bf = brake * s.brakeT * (front ? 0.62 : 0.38) / s.R;
      if (c.handbrake && !front) bf += s.brakeT * 1.4 / s.R;
      if (bf > 0) { const stop = -vx * this.mass / 4 / dt; fx += Math.abs(stop) < bf ? stop : -Math.sign(vx) * bf; }
      fx -= 0.012 * fz * Math.sign(vx);
      const e = Math.hypot(fx / Dx, fy / Dy);
      if (e > 1) { fx /= e; fy /= e; this.skid[w] = Math.abs(vx) > 3 || Math.abs(vy) > 1.5; }
      if (c.handbrake && !front && Math.abs(vx) > 2) { fy *= 0.35; this.skid[w] = true; }
      this.applyForceAt(v3.fma(v3.scale(wf, fx), fy, wr), contact);
    }
    this.force[1] -= this.mass * G;
    if (speed > 0.01) this.force = v3.fma(this.force, -0.5 * RHO * s.cdA * speed, this.vel);
    this.torque = v3.fma(this.torque, -this.mass * 0.4, this.omega);
    this.integrate(dt);
  }
  emitSmoke() {
    for (let w = 0; w < 4; w++) {
      if (!this.skid[w] || this.load[w] <= 0) continue;
      const p = this.toWorld(this.hp[w]);
      this.particles.smoke(p[0], p[1] - 0.4, p[2], this.vel[0], this.vel[2], 0.85);
    }
  }
  render(r, fromInside) {
    if (fromInside) return;
    const s = this.s, base = m4.mul(this.model(), m4.translation(0, -s.cg, 0));
    const L = s.L, W = s.W, paint = s.paint, glass = 0x2a3a44, chrome = 0xc8ccd0, dark = 0x1a1a1a;
    if (s.kind === 'fusca') {
      r.part(base, 0, 0.62, 0.05, W * 0.86, 0.5, L * 0.92, paint);
      r.part(base, 0, 0.92, -1.35, W * 0.7, 0.25, 1.0, paint);
      r.part(base, 0, 0.98, 1.25, W * 0.72, 0.32, 1.2, paint);
      r.part(base, 0, 1.18, 0.1, W * 0.78, 0.55, 1.85, paint);
      r.part(base, 0, 1.18, 0.1, W * 0.8, 0.4, 1.6, glass, 0.75);
      r.part(base, 0, 1.47, 0.15, W * 0.66, 0.06, 1.5, paint);
      for (const sx of [-1, 1]) {
        r.part(base, sx * W * 0.42, 0.62, -1.18, 0.32, 0.42, 0.95, paint);
        r.part(base, sx * W * 0.42, 0.62, 1.2, 0.32, 0.42, 0.95, paint);
        r.part(base, sx * W * 0.47, 0.32, 0.02, 0.12, 0.06, 1.3, dark);
        r.part(base, sx * 0.42, 0.82, -L / 2 + 0.12, 0.16, 0.16, 0.06, 0xfff4c0);
        r.part(base, sx * W * 0.42, 0.86, L / 2 - 0.22, 0.14, 0.2, 0.06, 0xc01818);
      }
      r.part(base, 0, 0.42, -L / 2 + 0.05, W * 0.95, 0.08, 0.08, chrome);
      r.part(base, 0, 0.42, L / 2 - 0.05, W * 0.95, 0.08, 0.08, chrome);
    } else if (s.kind === '911') {
      r.part(base, 0, 0.55, 0, W, 0.42, L, paint);
      r.part(base, 0, 0.92, 0.25, W * 0.82, 0.38, 1.9, paint);
      r.part(base, 0, 0.94, 0.2, W * 0.84, 0.3, 1.7, glass, 0.8);
      r.part(base, 0, 0.9, L / 2 - 0.15, W * 0.9, 0.06, 0.35, dark);
      for (const sx of [-1, 1]) { r.part(base, sx * 0.62, 0.7, -L / 2 + 0.08, 0.2, 0.12, 0.06, 0xfff4e0); r.part(base, sx * 0.6, 0.72, L / 2 - 0.02, 0.5, 0.07, 0.05, 0xd01010); }
    } else {
      r.part(base, 0, 0.62, 0, W, 0.62, L, paint);
      r.part(base, 0, 1.15, 0.15, W * 0.9, 0.5, 2.9, paint);
      r.part(base, 0, 1.17, 0.15, W * 0.92, 0.38, 2.7, 0x1c2630, 0.85);
      r.part(base, 0, 0.75, -L / 2 + 0.03, 0.75, 0.32, 0.05, chrome);
      for (const sx of [-1, 1]) { r.part(base, sx * 0.7, 0.82, -L / 2 + 0.05, 0.35, 0.1, 0.05, 0xe8f0ff); r.part(base, sx * 0.7, 0.85, L / 2 - 0.03, 0.4, 0.12, 0.05, 0xb01010); }
    }
    for (let w = 0; w < 4; w++) {
      const hp = this.hp[w];
      let m = m4.mul(base, m4.translation(hp[0], hp[1] + s.cg - 0.32 + this.comp[w], hp[2]));
      if (w < 2) m = m4.mul(m, m4.rotY(-this.steerAngle));
      m = m4.mul(m, m4.rotX(-this.spin[w]));
      const d = s.R * 2;
      r.part(m, 0, 0, 0, 0.22, d, d * 0.72, dark);
      r.part(m, 0, 0, 0, 0.22, d * 0.72, d, dark);
      r.part(m, 0, 0, 0, 0.24, d * 0.4, d * 0.4, s.kind === 's600' ? 0x9aa0a6 : chrome);
    }
    const st = this.seat();
    r.part(base, st[0], st[1] + s.cg - 0.05, st[2], 0.25, 0.28, 0.25, 0xc69c6d);
  }
  hud() {
    const kmh = Math.abs(v3.dot(this.vel, this.forward())) * 3.6;
    return `<div class="big">${kmh.toFixed(0)}<small> km/h</small><span class="gear">${this.gear < 0 ? 'R' : this.gear}</span></div>
      <div class="bar"><i style="width:${Math.min(100, this.rpm / this.s.limiter * 100).toFixed(0)}%;${this.rpm > 0.9 * this.s.limiter ? 'background:#e03030' : ''}"></i></div>
      <div class="row">${this.rpm.toFixed(0)} rpm <span style="color:${this.seatbelt ? '#80ff80' : '#ff8080'}">belt ${this.seatbelt ? 'ON' : 'OFF'}</span></div>
      <div class="name">${this.s.name}</div>`;
  }
}

// ------------------------------------------------------------------ the Tupi T-180

const S = 16.17, SPAN = 11.0, CHORD = 1.494, POWER = 134.2e3, AR = SPAN * SPAN / S, E = 0.86;
const CL_A = 6.0 / (1 + 6.0 / (Math.PI * AR * E)), A0 = -3.5 * DEG, CL_MAX = 1.55, CL_FLAP = 0.62, CD0 = 0.031, K = 1 / (Math.PI * AR * E);
const CM0 = 0.04, CM_A = -0.89, CM_Q = -12.4, CM_DE = -1.28, CL_Q = 3.9, CL_DE = 0.43, CY_B = -0.31, CY_DR = 0.187;
const CR_B = -0.089, CR_P = -0.47, CR_R = 0.096, CR_DA = 0.178, CR_DR = 0.0147;
const CN_B = 0.065, CN_P = -0.03, CN_R = -0.099, CN_DA = -0.053, CN_DR = -0.0657;
const EL_MAX = 25 * DEG, AIL_MAX = 17 * DEG, RUD_MAX = 16 * DEG;

export class Plane extends Vehicle {
  constructor() {
    super();
    this.mass = 1050; this.inertia = [1825, 2667, 1285];
    this.gear = [[0, -0.95, -1.35], [-1.25, -0.95, 0.25], [1.25, -0.95, 0.25]];
    this.gearComp = [0, 0, 0];
    this.hull = [[0, 0.1, -2.6], [-5.5, 1.0, 0], [5.5, 1.0, 0], [-2.5, 1.0, 0], [2.5, 1.0, 0], [0, 0.5, 5.9, 1], [0, 1.9, 6.4],
      [-1.7, 0.4, 5.9, 1], [1.7, 0.4, 5.9, 1], [0, 1.2, -0.6], [0, -0.1, 1.5, 1]];
    this.throttle = 0; this.flapNotch = 0; this.flap = 0; this.elevator = 0; this.aileron = 0; this.rudder = 0;
    this.alpha = 0; this.airspeed = 0; this.propAngle = 0; this.onGround = false; this.crashed = false; this.g = 1;
    this.name = 'Tupi T-180';
  }
  seat() { return [-0.3, 0.85, -1.0]; }
  chaseDistance() { return 15; }
  chaseHeight() { return 4; }
  cycleFlaps() { this.flapNotch = (this.flapNotch + 1) % 4; this.message = `Flaps ${this.flapNotch * 10}°`; }
  altitudeFt() { return (this.pos[1] - 64 + 817.3) * 3.28084; }
  airspeedKt() { return this.airspeed * 1.94384; }
  stallAlpha() { return (CL_MAX + CL_FLAP * this.flap / 30) / CL_A + A0; }
  stallWarning() { return !this.onGround && !this.crashed && this.airspeed > 5 && this.alpha > this.stallAlpha() - 3.5 * DEG; }
  update(dt, c) {
    if (this.crashed) { this.vel = [0, 0, 0]; this.omega = [0, 0, 0]; return; }
    this.throttle = Math.max(0, Math.min(1, this.throttle + c.throttle * dt * 0.6));
    const ft = this.flapNotch * 10;
    this.flap += Math.sign(ft - this.flap) * Math.min(Math.abs(ft - this.flap), 6 * dt);
    // sign conventions: trailing edge down elevator, right aileron up, rudder TE left are positive
    this.elevator += (-c.pitch * EL_MAX - this.elevator) * Math.min(1, dt * 6);
    this.aileron += (c.roll * AIL_MAX - this.aileron) * Math.min(1, dt * 6);
    this.rudder += (-c.yaw * RUD_MAX - this.rudder) * Math.min(1, dt * 6);
    const v0 = this.vel.slice();
    for (let i = 0; i < 4; i++) this.step(dt / 4, c);
    const acc = v3.scale(v3.sub(this.vel, v0), 1 / dt); acc[1] += G;
    this.g = this.g * 0.9 + 0.1 * v3.dot(acc, this.up()) / G;
    const before = this.speed();
    this.collide(dt);
    const hit = this.takeImpact();
    if (hit > 14 || (!this.onGround && hit > 9)) this.crash(before);
    else if (hit > 0) this.lastImpact = hit;
    this.fixNaN();
  }
  step(dt, c) {
    const f = this.forward(), u = this.up(), r = this.right();
    const vf = v3.dot(this.vel, f), vr = v3.dot(this.vel, r), vd = -v3.dot(this.vel, u);
    this.airspeed = this.speed();
    const V = Math.max(this.airspeed, 0.1);
    this.alpha = Math.atan2(vd, Math.max(Math.abs(vf), 0.1)) * (vf < 0 ? -1 : 1);
    const beta = Math.asin(Math.max(-1, Math.min(1, vr / V))), qbar = 0.5 * RHO * this.airspeed ** 2;
    const p = v3.dot(this.omega, f), q = v3.dot(this.omega, r), rr = -v3.dot(this.omega, u);
    const ph = p * SPAN / (2 * V), qh = q * CHORD / (2 * V), rh = rr * SPAN / (2 * V);
    const clFlap = CL_FLAP * this.flap / 30, alphaStall = (CL_MAX + clFlap) / CL_A + A0 - DEG * this.flap / 30;
    const a = this.alpha;
    let cl;
    if (Math.abs(a) <= alphaStall) cl = CL_A * (a - A0) + clFlap;
    else {
      const over = Math.abs(a) - alphaStall, peak = (CL_MAX + clFlap) * Math.sign(a), t = Math.min(1, over / (8 * DEG));
      cl = peak * (1 - t) * Math.exp(-over * 3) + Math.sin(2 * a) * t + peak * (1 - t) * 0.15;
    }
    cl += CL_Q * qh + CL_DE * this.elevator;
    let cd = CD0 + K * cl * cl + 0.03 * this.flap / 30 + (Math.abs(a) > alphaStall ? 0.9 * Math.sin(a) ** 2 : 0);
    const cy = CY_B * beta + CY_DR * this.rudder;
    const agl = this.pos[1] - this.groundHeight(this.pos[0], this.pos[2], this.pos[1]);
    if (agl < SPAN) { const x = (16 * agl / SPAN) ** 2; cd -= K * cl * cl * (1 - x / (1 + x)); }
    const ca = Math.cos(a), sa = Math.sin(a);
    const fx = qbar * S * (-cd * ca + cl * sa), fzd = qbar * S * (-cd * sa - cl * ca), fy = qbar * S * cy;
    this.force = v3.add(this.force, v3.fma(v3.fma(v3.scale(f, fx), fy, r), -fzd, u));
    const thrust = Math.min(2600 * this.throttle, 0.78 * POWER * this.throttle / Math.max(V, 1));
    this.force = v3.fma(this.force, thrust, f);
    this.propAngle += (0.15 + this.throttle) * 45 * dt;
    const cm = CM0 + CM_A * a + CM_Q * qh + CM_DE * this.elevator - 0.06 * this.flap / 30;
    const croll = CR_B * beta + CR_P * ph + CR_R * rh + CR_DA * this.aileron + CR_DR * this.rudder;
    const cn = CN_B * beta + CN_P * ph + CN_R * rh + CN_DA * this.aileron + CN_DR * this.rudder;
    const wash = 0.5 * RHO * (2600 * this.throttle / (RHO * 2.5)) * S;
    const M = qbar * S * CHORD * cm + wash * CHORD * CM_DE * this.elevator * 0.25;
    const Lr = qbar * S * SPAN * croll, N = qbar * S * SPAN * cn + wash * SPAN * CN_DR * this.rudder * 0.5;
    this.torque = v3.fma(v3.fma(v3.fma(this.torque, Lr, f), M, r), -N, u);
    this.force[1] -= this.mass * G;
    this.gearForces(dt, c, f);
    this.integrate(dt);
  }
  gearForces(dt, c, f) {
    this.onGround = false;
    for (let i = 0; i < 3; i++) {
      const p = this.toWorld(this.gear[i]);
      const ground = this.groundHeight(p[0], p[2], p[1] + 0.5);
      let comp = ground - (p[1] - 0.25);
      const prev = this.gearComp[i];
      this.gearComp[i] = Math.max(0, comp);
      if (comp <= 0 || ground === -Infinity) continue;
      this.onGround = true;
      comp = Math.min(comp, 0.4);
      const fz = Math.min(Math.max(0, (i === 0 ? 40000 : 55000) * comp + 3500 * (comp - prev) / dt), this.mass * G * 5);
      const contact = [p[0], ground, p[2]];
      this.applyForceAt([0, fz, 0], contact);
      let wf = [f[0], 0, f[2]];
      if (wf[0] * wf[0] + wf[2] * wf[2] < 1e-6) continue;
      wf = v3.norm(wf);
      if (i === 0) { const st = -c.yaw * 10 * DEG, cs = Math.cos(st), sn = Math.sin(st); wf = [wf[0] * cs + wf[2] * sn, 0, -wf[0] * sn + wf[2] * cs]; }
      const wr = [-wf[2], 0, wf[0]];
      const pv = this.pointVel(contact), vx = v3.dot(pv, wf), vy = v3.dot(pv, wr);
      const fyN = -Math.max(-0.8 * fz, Math.min(0.8 * fz, vy * 9000));
      let fxN = -0.03 * fz * Math.sign(vx);
      if (i > 0 && c.brake > 0) { const stop = -vx * this.mass / 3 / dt, max = 0.55 * fz * c.brake; fxN += Math.abs(stop) < max ? stop : -Math.sign(vx) * max; }
      this.applyForceAt(v3.fma(v3.scale(wf, fxN), fyN, wr), contact);
    }
  }
  crash(speed) {
    this.crashed = true;
    const rad = Math.floor(Math.min(5, 2 + speed / 18)), W = this.world;
    const cx = Math.floor(this.pos[0]), cy = Math.floor(this.pos[1]), cz = Math.floor(this.pos[2]);
    let removed = 0;
    for (let x = -rad; x <= rad; x++) for (let y = -rad; y <= rad; y++) for (let z = -rad; z <= rad; z++) {
      if (x * x + y * y + z * z > rad * rad) continue;
      const b = W.getBlock(cx + x, cy + y, cz + z);
      if (b === B.AIR || b === B.BEDROCK || b === B.WATER) continue;
      if (isGlass(b)) { this.glass.smash(cx + x, cy + y, cz + z, x, y + 1, z); continue; }
      W.setBlock(cx + x, cy + y, cz + z, B.AIR);
      if (removed++ % 3 === 0) this.particles.debris(cx + x, cy + y, cz + z, b, x * 3, 6, z * 3, 3);
    }
    const parts = [[1, 1, 1], [0.85, 0.1, 0.15], [0.1, 0.55, 0.25], [0.95, 0.8, 0.1]];
    for (let i = 0; i < 60; i++) {
      const cc = parts[i % 4], s = 0.3 + Math.random() * 1.2;
      this.particles.add(this.pos[0], this.pos[1] + 1, this.pos[2], this.vel[0] * 0.3 + (Math.random() - 0.5) * 16, Math.random() * 14,
        this.vel[2] * 0.3 + (Math.random() - 0.5) * 16, s, s * 0.2, s * 0.7, cc[0], cc[1], cc[2], 1, 12, 0.2, 1);
    }
    for (let i = 0; i < 40; i++) this.particles.smoke(this.pos[0], this.pos[1] + 1, this.pos[2], 0, 0, 0.25);
    this.destroyed += removed;
    this.sound.play('crash', 1);
    this.throttle = 0;
    this.message = `CRASH at ${(speed * 1.94384).toFixed(0)} kt. ${removed} blocks of São Paulo rearranged. R: new aeroplane`;
  }
  render(bx, fromInside) {
    if (this.crashed) return;
    const base = this.model();
    const white = 0xf2f2ee, green = 0x0b8f3c, yellow = 0xf2c80f, blue = 0x1a3c8c, dark = 0x222222;
    const at = (x, y, z, ...rest) => m4.mul(m4.mul(base, m4.translation(x, y, z)), rest.reduce((m, r) => m4.mul(m, r), m4.identity()));
    bx.part(base, 0, 0.08, -1.6, 1.05, 0.86, 1.3, white);
    if (!fromInside) { bx.part(base, 0, 0.3, -0.3, 1.15, 1.35, 1.6, white); bx.part(base, 0, 0.55, -0.4, 1.17, 0.6, 1.3, 0x3a4c58, 0.8); }
    bx.part(base, 0, 0.35, 1.6, 0.85, 0.95, 2.4, white);
    bx.part(base, 0, 0.5, 4.0, 0.45, 0.55, 2.6, white);
    bx.part(base, 0, 0.0, 1.0, 1.18, 0.12, 6.0, green);
    bx.part(base, 0, 0.15, 1.0, 1.18, 0.07, 6.0, yellow);
    bx.part(base, 0, 1.05, -0.15, 11.0, 0.14, 1.5, white);
    bx.part(base, -5.2, 1.05, -0.15, 0.6, 0.15, 1.52, green);
    bx.part(base, 5.2, 1.05, -0.15, 0.6, 0.15, 1.52, yellow);
    for (const sx of [-1, 1]) {
      bx.part(at(sx * 1.9, 1.02, 0.62, m4.rotX(-this.flap * DEG)), 0, 0, 0.22, 2.6, 0.08, 0.45, white);
      bx.part(at(sx * 4.3, 1.02, 0.62, m4.rotX(this.aileron * sx)), 0, 0, 0.18, 2.0, 0.07, 0.36, white);
      bx.part(at(sx * 1.55, 0.35, -0.1, m4.rotZ(sx * -0.75)), 0, 0, 0, 0.07, 1.75, 0.12, 0xbbbbbb);
    }
    bx.part(base, 0, 0.55, 5.5, 3.4, 0.08, 0.9, white);
    bx.part(at(0, 0.55, 5.95, m4.rotX(this.elevator)), 0, 0, 0.25, 3.3, 0.07, 0.5, blue);
    bx.part(base, 0, 1.3, 5.6, 0.08, 1.5, 1.1, white);
    bx.part(at(0, 1.2, 6.15, m4.rotY(-this.rudder)), 0, 0, 0.2, 0.07, 1.4, 0.4, green);
    for (let i = 0; i < 3; i++) {
      const g = this.gear[i];
      bx.part(base, g[0] * 0.8, g[1] + 0.45, g[2], 0.07, 0.9, 0.07, 0x888888);
      bx.part(base, g[0], g[1] + 0.02 + this.gearComp[i], g[2], 0.15, 0.5, 0.5, dark);
    }
    bx.part(base, 0, 0.15, -2.35, 0.3, 0.3, 0.3, white);
    const prop = at(0, 0.15, -2.45, m4.rotZ(this.propAngle));
    if (this.throttle > 0.25) {
      bx.part(prop, 0, 0, 0, 1.35, 1.35, 0.02, 0x777777, 0.15);
      bx.part(m4.mul(prop, m4.rotZ(Math.PI / 4)), 0, 0, 0, 1.35, 1.35, 0.02, 0x777777, 0.15);
    } else bx.part(prop, 0, 0, 0, 1.9, 0.16, 0.04, dark);
    if (!fromInside) bx.part(base, -0.3, 0.7, -0.55, 0.28, 0.3, 0.28, 0xc69c6d);
  }
  hud() {
    const f = this.forward(), r = this.right(), kt = this.airspeedKt();
    const pitch = Math.asin(Math.max(-1, Math.min(1, f[1]))) / DEG, bank = Math.asin(Math.max(-1, Math.min(1, -r[1]))) / DEG;
    return `<div class="big" style="${kt < 50 && !this.onGround ? 'color:#ff5050' : ''}">${kt.toFixed(0)}<small> kt</small>
      <span class="alt">${this.altitudeFt().toFixed(0)} ft<br><small>${(this.vel[1] * 196.85 >= 0 ? '+' : '') + (this.vel[1] * 196.85).toFixed(0)} fpm</small></span></div>
      <div class="bar"><i style="width:${(this.throttle * 100).toFixed(0)}%"></i></div>
      <div class="row">Throttle ${(this.throttle * 100).toFixed(0)}% · Flaps ${this.flap.toFixed(0)}° · AoA ${(this.alpha / DEG).toFixed(1)}° · ${this.g.toFixed(1)} g</div>
      <div class="row">Pitch ${pitch >= 0 ? '+' : ''}${pitch.toFixed(0)}° · Bank ${bank >= 0 ? '+' : ''}${bank.toFixed(0)}°</div>
      <div class="name">Tupi T-180 (Cessna 172S)</div>`;
  }
}
