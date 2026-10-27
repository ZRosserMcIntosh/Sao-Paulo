// The player: a port of entity/Player.java. Yaw 0 looks north (-Z) and grows turning left;
// pitch grows looking up. Moving the mouse right turns right, down looks down.
import { isSolid, B } from './blocks.js';

const WALK = 4.317, SPRINT = 5.612, SNEAK = 1.3, JUMP = 8, GRAV = -25, SENS = 0.12;
const EYE = 1.62, HEIGHT = 1.8, WIDTH = 0.6, REACH = 6, STEP = 1.05;

export class Player {
  constructor(x, y, z) {
    this.x = x; this.y = y; this.z = z; this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0; this.pitch = 0; this.onGround = false; this.sneaking = false; this.flying = false; this.air = 0; this.hover = false;
    this.look(0, 0);
  }
  get eyeY() { return this.y + EYE; }
  look(dx, dy) {
    this.yaw = (((this.yaw - dx * SENS) % 360) + 360) % 360;
    this.pitch = Math.max(-89, Math.min(89, this.pitch - dy * SENS));
    this.setLook(this.yaw, this.pitch);
  }
  setLook(yaw, pitch) {
    this.yaw = yaw; this.pitch = pitch;
    const yr = yaw * Math.PI / 180, pr = pitch * Math.PI / 180;
    this.dir = [-Math.sin(yr) * Math.cos(pr), Math.sin(pr), -Math.cos(yr) * Math.cos(pr)];
  }
  /** mx: +1 right; mz: +1 forward. */
  input(mx, mz, jump, sneak, sprint) {
    if (this.flying) return;
    const speed = sneak ? SNEAK : sprint ? SPRINT : WALK;
    this.sneaking = sneak;
    const yr = this.yaw * Math.PI / 180;
    let tx = mx * Math.cos(yr) - mz * Math.sin(yr), tz = -mx * Math.sin(yr) - mz * Math.cos(yr);
    const l = Math.hypot(tx, tz);
    if (l > 1e-4) { tx = tx / l * speed; tz = tz / l * speed; }
    const k = this.onGround ? 0.5 : 0.08;
    this.vx += (tx - this.vx) * k; this.vz += (tz - this.vz) * k;
    if (jump && this.onGround) { this.vy = JUMP; this.onGround = false; }
  }
  launch(vx, vy, vz) { this.vx = vx; this.vy = vy; this.vz = vz; this.flying = true; this.onGround = false; this.air = 0; }
  teleport(x, y, z) { this.x = x; this.y = y; this.z = z; this.vx = this.vy = this.vz = 0; this.flying = false; }
  collides(w, px, py, pz) {
    const h = WIDTH / 2;
    for (let bx = Math.floor(px - h); bx <= Math.floor(px + h - 1e-4); bx++)
      for (let bz = Math.floor(pz - h); bz <= Math.floor(pz + h - 1e-4); bz++)
        for (let by = Math.floor(py); by <= Math.floor(py + HEIGHT - 1e-4); by++)
          if (isSolid(w.getBlock(bx, by, bz))) return true;
    return false;
  }
  canStep(w, px, pz, grounded) {
    if (!grounded || this.flying || this.sneaking) return false;
    const sy = Math.floor(this.y) + 1;
    return sy - this.y <= STEP && !this.collides(w, px, sy, pz);
  }
  /** Returns the landing speed if the player hit the ground this step. */
  update(dt, w) {
    if (!w.isLoaded(Math.floor(this.x), Math.floor(this.z))) return 0;
    if (this.hover) { this.vx = this.vy = this.vz = 0; return 0; }
    const inWater = w.getBlock(Math.floor(this.x), Math.floor(this.y + 0.5), Math.floor(this.z)) === B.WATER;
    this.vy += GRAV * (inWater ? 0.3 : 1) * dt;
    if (inWater) this.vy = Math.max(this.vy, -3);
    if (this.flying) {
      const sp = Math.hypot(this.vx, this.vy, this.vz), d = 0.5 * 1.1 * 0.6 * sp / 80;
      this.vx -= this.vx * d * dt; this.vy -= this.vy * d * dt; this.vz -= this.vz * d * dt;
      this.air += dt;
    }
    this.vy = Math.max(this.vy, -60);
    const fall = -this.vy, grounded = this.onGround;
    let nx = this.x + this.vx * dt;
    if (this.collides(w, nx, this.y, this.z)) {
      if (this.canStep(w, nx, this.z, grounded)) this.y = Math.floor(this.y) + 1;
      else { nx = this.x; this.vx = this.flying ? -this.vx * 0.3 : 0; }
    }
    this.x = nx;
    let nz = this.z + this.vz * dt;
    if (this.collides(w, this.x, this.y, nz)) {
      if (this.canStep(w, this.x, nz, grounded)) this.y = Math.floor(this.y) + 1;
      else { nz = this.z; this.vz = this.flying ? -this.vz * 0.3 : 0; }
    }
    this.z = nz;
    let ny = this.y + this.vy * dt, impact = 0;
    this.onGround = false;
    if (this.collides(w, this.x, ny, this.z)) {
      if (this.vy < 0) {
        ny = Math.floor(ny) + 1;
        for (let i = 0; i < 3 && this.collides(w, this.x, ny, this.z); i++) ny += 1;
        this.onGround = true;
        impact = fall;
        if (this.flying) {
          this.vx *= 0.2; this.vz *= 0.2;
          if (Math.abs(this.vx) + Math.abs(this.vz) < 1 || this.air > 6) this.flying = false;
        }
      } else ny = this.y;
      this.vy = 0;
    }
    this.y = ny;
    if (this.y < 1) { this.y = 1; this.vy = 0; this.onGround = true; }
    return impact;
  }
  target(w) { return w.raycast(this.x, this.eyeY, this.z, this.dir[0], this.dir[1], this.dir[2], REACH); }
  place(w, hit, block) {
    const h = WIDTH / 2;
    if (hit.px + 1 > this.x - h && hit.px < this.x + h && hit.py + 1 > this.y && hit.py < this.y + HEIGHT && hit.pz + 1 > this.z - h && hit.pz < this.z + h) return;
    w.setBlock(hit.px, hit.py, hit.pz, block);
  }
}
