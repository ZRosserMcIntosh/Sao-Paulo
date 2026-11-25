// AI drivers. They only ever move their car the way the player does: steering, throttle, brake,
// handbrake and gear requests into the same core, so they slide, spin and crash by the same
// physics. Road following is pure pursuit on a lane of the interstate; speed is a PI loop
// against curvature, traffic ahead and personality.
import { clamp, Rng, wrapAngle } from '../math';
import { laneCenterOffset, XS, type Track } from '../world/track';
import type { Vehicle } from '../vehicle/Vehicle';

export const SPEED_LIMIT = 31.3; // 70 mph

export interface Personality {
  name: string;
  blurb: string;
  speedFactor: number; // x speed limit when cruising or fleeing
  aggression: number; // 0..1: lane-change eagerness, following distance, contact
  skill: number; // 0..1: cornering confidence, recovery
  erratic: number; // 0..1: random weaving and speed changes
  panicGain: number; // how fast panic builds with police close behind
  courtesy: number; // 0..1: moves over for sirens
}

export const PERSONALITIES: Record<string, Personality> = {
  commuter: { name: 'Commuter', blurb: 'Running late, listening to a podcast.', speedFactor: 1.05, aggression: 0.3, skill: 0.55, erratic: 0.1, panicGain: 0, courtesy: 0.9 },
  trucker: { name: 'Hauler', blurb: 'Cruise control at 68.', speedFactor: 0.97, aggression: 0.15, skill: 0.6, erratic: 0.02, panicGain: 0, courtesy: 0.8 },
  slowpoke: { name: 'Sunday Driver', blurb: 'Left lane, 55, turn signal on since Macon.', speedFactor: 0.82, aggression: 0.05, skill: 0.35, erratic: 0.2, panicGain: 0, courtesy: 0.4 },
  darrell: { name: 'Darrell', blurb: 'Wanted for 14 unpaid Peach Pass tolls and a stolen riding mower (it was his cousin\'s).', speedFactor: 1.32, aggression: 0.45, skill: 0.55, erratic: 0.25, panicGain: 0.35, courtesy: 0 },
  brenda: { name: 'Brenda', blurb: 'Late for bingo. Will not be stopping. Has a casserole on the passenger seat.', speedFactor: 1.45, aggression: 0.75, skill: 0.7, erratic: 0.6, panicGain: 0.6, courtesy: 0 },
  travis: { name: 'Travis', blurb: 'Expired tag (2011). Lifted truck. Strong opinions about the speed limit.', speedFactor: 1.3, aggression: 0.85, skill: 0.5, erratic: 0.45, panicGain: 0.5, courtesy: 0 },
  wanda: { name: 'Wanda', blurb: 'Driving her late husband\'s Corsair. Thinks the lights behind her are for somebody else.', speedFactor: 1.18, aggression: 0.2, skill: 0.4, erratic: 0.7, panicGain: 0.2, courtesy: 0 },
  officer: { name: 'Trooper', blurb: 'Responding.', speedFactor: 1.6, aggression: 0.7, skill: 0.8, erratic: 0, panicGain: 0, courtesy: 0 },
};

export type AiMode = 'cruise' | 'flee' | 'pursue' | 'recover' | 'stopped' | 'surrender';

export interface AiContext {
  vehicles: Vehicle[];
  time: number;
  dt: number;
  sirensNear: (v: Vehicle, r: number) => boolean;
  pitAid: number; // arcade: police steering help (0..1)
}

export class AiDriver {
  mode: AiMode;
  lane: number;
  offset: number; // current lateral offset (m, signed with the carriageway)
  targetOffset: number;
  panic = 0;
  dir: 1 | -1;
  target: Vehicle | null = null; // police: the suspect
  private changeTimer = 0;
  private wobble = 0;
  private recover = { phase: 0, t: 0, side: 1, total: 0 };
  private recoveries = 0;
  giveUp = false;
  private stuck = 0;
  private integ = 0;
  private swerve = 0;
  private speedWave: number;
  private pitSide: 1 | -1 = 1;
  pitting = false;
  private pitTimer = 0;
  lastSteer = 0;

  constructor(readonly v: Vehicle, readonly track: Track, readonly p: Personality, readonly rng: Rng, mode: AiMode, dir: 1 | -1, lane: number) {
    this.mode = mode;
    this.dir = dir;
    this.lane = lane;
    this.offset = this.targetOffset = laneCenterOffset(lane);
    this.speedWave = rng.range(0, 100);
    this.pitSide = rng.chance(0.5) ? 1 : -1;
  }

  // d of a lateral offset on this carriageway
  private dOf(off: number) { return this.dir * off; }

  update(ctx: AiContext) {
    this.ctxVehicles = ctx.vehicles;
    const v = this.v, c = v.controls, dt = ctx.dt;
    if (this.mode === 'stopped' || this.mode === 'surrender') {
      c.throttle = 0; c.brake = 1; c.handbrake = Math.abs(v.speed) < 1 ? 1 : 0; c.steer = 0; c.reverse = false;
      return;
    }
    const tr = this.track;
    const s = v.trackS, d = v.trackD;
    // heading error against the carriageway direction
    const roadYaw = tr.headingAt(s, this.dir);
    const headErr = wrapAngle(v.heading() - roadYaw);
    const speed = v.speed;

    // ---- spin / stuck detection -> recovery ----
    if (this.mode !== 'recover') {
      const spun = Math.abs(headErr) > 1.75 && Math.abs(speed) < 9;
      const slowStuck = Math.abs(speed) < 1.2 && c.throttle > 0.5;
      this.stuck = slowStuck ? this.stuck + dt : Math.max(0, this.stuck - dt);
      if (spun || this.stuck > 2.2 || v.upright < 0.5) {
        this.recover = { phase: 0, t: 0, side: headErr > 0 ? 1 : -1, total: 0 };
        this.recoveries++;
        this.prevMode = this.mode;
        this.mode = 'recover';
        this.stuck = 0;
      }
    }
    if (this.mode === 'recover') { this.doRecover(ctx, headErr); return; }

    // ---- lane choice ----
    this.changeTimer -= dt;
    const fleeing = this.mode === 'flee';
    const pursuing = this.mode === 'pursue' && this.target;
    if (fleeing) {
      const police = ctx.vehicles.find((o) => o.role !== 'suspect' && o.emergency && this.distAlong(o) < 0 && this.distAlong(o) > -90);
      this.panic = clamp(this.panic + (police ? this.p.panicGain * dt * 0.15 : -dt * 0.03), 0, 1);
    }
    const ahead = this.leader(this.offset, 70);
    if (this.changeTimer <= 0) {
      this.changeTimer = this.rng.range(1.5, 4) / (0.4 + this.p.erratic + this.panic);
      let want = this.lane;
      if (ahead && ahead.gap < 45 && ahead.v.speed < speed - 1) {
        // blocked: pass on whichever side is free
        const opts = [this.lane - 1, this.lane + 1].filter((l) => l >= 0 && l <= 2 && this.laneFree(l));
        if (opts.length) want = this.rng.pick(opts);
      } else if (this.rng.chance(this.p.erratic * 0.5 + this.panic * 0.4)) {
        want = clamp(this.lane + (this.rng.chance(0.5) ? 1 : -1), 0, 2);
      } else if (this.mode === 'cruise' && this.lane < 2 && this.laneFree(this.lane + 1) && this.rng.chance(0.35)) {
        want = this.lane + 1; // keep right except to pass
      }
      // move over for sirens (Georgia law, and good manners)
      if (this.mode === 'cruise' && ctx.sirensNear(v, 120) && this.rng.chance(this.p.courtesy)) want = 2;
      if (want !== this.lane && (fleeing ? this.laneFree(want, 0.5) : this.laneFree(want))) this.lane = want;
      // panicked suspects use the shoulder
      if (fleeing && this.panic > 0.7 && this.rng.chance(0.15)) this.targetOffset = this.rng.chance(0.5) ? XS.outerShoulder - 1.6 : XS.median + 1.4;
      else this.targetOffset = laneCenterOffset(this.lane);
    }
    // lateral motion toward the target lane
    const latRate = (1.6 + 2.6 * this.p.aggression + 2 * this.panic) * dt;
    this.offset += clamp(this.targetOffset - this.offset, -latRate, latRate);

    // ---- speed target ----
    let vWant: number;
    const variation = 1 + this.p.erratic * 0.12 * Math.sin(ctx.time * 0.23 + this.speedWave) + this.panic * 0.12;
    if (fleeing) vWant = SPEED_LIMIT * this.p.speedFactor * variation;
    else if (pursuing) vWant = this.target!.speed + 6;
    else vWant = SPEED_LIMIT * this.p.speedFactor * variation;
    // curvature ahead
    const latMax = (fleeing || pursuing ? 5.2 : 3.6) * (0.75 + 0.5 * this.p.skill) * (v.cls.params.gripLatFront);
    let kMax = 0;
    for (let k = 10; k < Math.max(60, Math.abs(speed) * 3.5); k += 10) kMax = Math.max(kMax, Math.abs(tr.sampleAt(s + this.dir * k).k));
    if (kMax > 1e-4) vWant = Math.min(vWant, Math.sqrt(latMax / kMax));
    // the car ahead in my path
    const leader = this.leader(this.offset, 80);
    if (leader && !(pursuing && leader.v === this.target)) {
      const T = 1.4 - this.p.aggression * 0.8, s0 = 6;
      const want = s0 + Math.max(0, speed) * T;
      if (leader.gap < want) vWant = Math.min(vWant, leader.v.speed + (leader.gap - want) * 0.6);
      // too close and closing fast: swerve
      const closing = speed - leader.v.speed;
      if (closing > 4 && leader.gap / Math.max(closing, 0.1) < 1.2 && !fleeing) this.swerve = clamp(this.swerve + (this.rng.chance(0.5) ? 1 : -1) * 2.5, -3, 3);
      if (fleeing && leader.gap < 25 && closing > 2) this.swerve = (this.offset > 14 ? -1 : 1) * 3;
    }
    this.swerve *= Math.exp(-dt * 1.2);

    // ---- steering: pure pursuit to a point on the lane (or on the suspect) ----
    let tx: number, tz: number;
    const Ld = clamp(10 + Math.abs(speed) * 0.65, 12, 48);
    if (pursuing) {
      const t = this.target!;
      const dist = Math.hypot(t.p.x - v.p.x, t.p.z - v.p.z);
      this.updatePit(ctx, dist);
      if (Math.abs(t.speed) < 3 && dist < 80) {
        // the suspect has stopped: pull up behind it, angled, and stop (a felony stop, sort of)
        const tf = t.forward();
        tx = t.p.x - tf.x * (t.cls.look.length / 2 + 7) + -tf.z * this.pitSide * 2.5;
        tz = t.p.z - tf.z * (t.cls.look.length / 2 + 7) + tf.x * this.pitSide * 2.5;
        const dd = Math.hypot(tx - v.p.x, tz - v.p.z);
        vWant = dd < 4 ? 0 : Math.min(14, dd * 0.6);
        if (dd < 4 && Math.abs(speed) < 1) { c.throttle = 0; c.brake = 1; c.steer = 0; c.reverse = false; return; }
      } else if (dist < 70 && Math.abs(headErr) < 0.9) {
        // aim at a point beside the suspect's rear quarter (or behind it when following)
        const tf = t.forward(), right = { x: -tf.z, z: tf.x };
        const half = t.cls.look.length / 2, w = t.cls.look.width / 2;
        const lag = this.pitting ? -half * 0.55 : -(half + 10 + (1 - this.p.aggression) * 12);
        const side = this.pitting ? this.pitSide * (w + v.cls.look.width / 2 - 0.25 - 0.6 * ctx.pitAid) : this.pitSide * 1.8;
        tx = t.p.x + tf.x * (lag + t.speed * 0.25) + right.x * side;
        tz = t.p.z + tf.z * (lag + t.speed * 0.25) + right.z * side;
        // look ahead along the suspect's path rather than at its bumper (smoother)
        tx += tf.x * Math.min(Ld * 0.5, 12); tz += tf.z * Math.min(Ld * 0.5, 12);
        const along = (v.p.x - t.p.x) * tf.x + (v.p.z - t.p.z) * tf.z;
        // speed: close the gap, match when alongside
        const gapAlong = lag - along;
        vWant = Math.max(5, t.speed + clamp(gapAlong * 0.6, -8, 12));
        if (this.pitting && gapAlong > -1 && gapAlong < 2.5) vWant = t.speed + 0.8;
      } else {
        const ts = tr.sampleAt(s + this.dir * Ld);
        const td = this.dOf(this.offset) + this.swerve;
        tx = ts.x + ts.rx * td; tz = ts.z + ts.rz * td;
        // stay on the suspect's carriageway
        if (t.trackD * this.dir < 0 && Math.abs(t.trackD) > XS.median) this.dir = t.trackD > 0 ? 1 : -1;
      }
    } else {
      const ts = tr.sampleAt(s + this.dir * Ld);
      const td = this.dOf(this.offset) + this.swerve * this.dir;
      tx = ts.x + ts.rx * td; tz = ts.z + ts.rz * td;
    }
    const local = v.toLocal({ x: tx, y: v.p.y, z: tz });
    const alpha = Math.atan2(local.z, Math.max(0.5, local.x));
    const L = v.cls.params.wheelbase;
    let delta = Math.atan((2 * L * Math.sin(alpha)) / Math.max(8, Math.hypot(local.x, local.z)));
    // yaw-rate damping (skill): steadier at speed
    delta -= v.yawRate * 0.04 * (0.5 + this.p.skill);
    let steer = delta / v.cls.params.steeringLock;
    // sloppy hands
    this.wobble += (this.rng.next() - 0.5) * dt * 4 * (1 - this.p.skill) * (1 + this.panic);
    this.wobble *= Math.exp(-dt * 2);
    steer += this.wobble * 0.05;
    // traction recovery: countersteer into a slide, ease off
    let thrCap = 1;
    if (Math.abs(v.sideslip) > 0.12 && Math.abs(speed) > 5) {
      steer = steer * 0.3 + v.sideslip * (1.1 + this.p.skill) / Math.max(0.3, v.cls.params.steeringLock) * 0.7;
      thrCap = 0.25 + 0.3 * this.p.skill;
    }
    steer = clamp(steer, -1, 1);
    const sr = (2.5 + 3 * this.p.skill) * dt;
    this.lastSteer += clamp(steer - this.lastSteer, -sr, sr);
    c.steer = this.lastSteer;

    // ---- throttle / brake (PI) ----
    const err = vWant - speed;
    this.integ = clamp(this.integ + err * dt, -5, 10);
    if (err > -0.5) {
      c.throttle = clamp(0.08 + err * 0.32 + this.integ * 0.05, 0, thrCap);
      c.brake = 0;
    } else {
      c.throttle = 0;
      c.brake = clamp(-err * 0.12, 0, 1);
      this.integ *= 0.9;
    }
    c.handbrake = 0;
    c.reverse = false;
    // off the road on the wrong side of the median: head back
    if (Math.abs(d) < XS.median && !pursuing) this.targetOffset = laneCenterOffset(this.lane);
  }

  private prevMode: AiMode = 'cruise';

  private updatePit(ctx: AiContext, dist: number) {
    this.pitTimer -= ctx.dt;
    if (this.pitTimer <= 0) {
      this.pitTimer = this.rng.range(4, 9);
      const t = this.target!;
      // a PIT only below ~85 mph and with some aggression
      this.pitting = this.p.aggression > 0.4 && t.speed < 38 && dist < 60 && this.rng.chance(0.55 + 0.3 * ctx.pitAid);
      this.pitSide = this.rng.chance(0.5) ? 1 : -1;
    }
  }

  private doRecover(ctx: AiContext, headErr: number) {
    const v = this.v, c = v.controls, r = this.recover, dt = ctx.dt;
    r.t += dt;
    r.total += dt;
    c.handbrake = 0;
    // a fleeing driver who keeps spinning out (or is stuck for good) gives up; traffic waits
    if (r.total > 18 || (this.prevMode === 'flee' && this.recoveries > 3) || v.upright < 0.5) {
      this.mode = this.prevMode === 'flee' ? 'stopped' : 'stopped';
      this.giveUp = this.prevMode === 'flee';
      return;
    }
    if (r.phase === 0) {
      // stop
      c.throttle = 0; c.brake = 1; c.steer = 0; c.reverse = false;
      if (Math.abs(v.speed) < 0.8 || r.t > 4) { r.phase = Math.abs(headErr) < 0.9 ? 3 : 1; r.t = 0; }
    } else if (r.phase === 1) {
      // reverse with the wheel turned to swing the nose toward the road direction
      c.reverse = true; c.brake = 0; c.throttle = 0.55;
      c.steer = r.side > 0 ? 1 : -1;
      if ((r.t > 1.0 && Math.abs(v.speed) < 0.3 && v.gear !== -1) || r.t > 2.6) { r.phase = 2; r.t = 0; }
    } else if (r.phase === 2) {
      // forward on opposite lock
      c.reverse = false; c.throttle = 0.5; c.brake = 0;
      c.steer = r.side > 0 ? -1 : 1;
      if (Math.abs(headErr) < 0.6 || r.t > 3.0) { r.phase = Math.abs(headErr) < 0.9 ? 3 : 0; r.t = 0; if (r.phase === 0) r.side = headErr > 0 ? 1 : -1; }
    } else {
      // back to the road: rejoin the nearest lane
      const off = Math.abs(v.trackD);
      this.lane = clamp(Math.round((off - XS.innerShoulder) / XS.laneWidth - 0.5), 0, 2);
      this.offset = clamp(off, XS.median + 1, XS.outerShoulder);
      this.targetOffset = laneCenterOffset(this.lane);
      this.dir = v.trackD >= 0 ? 1 : -1;
      this.mode = this.prevMode === 'recover' ? 'cruise' : this.prevMode;
      if (v.upright < 0.5) this.mode = 'stopped';
    }
  }

  // signed distance along my direction to another car (positive = ahead)
  distAlong(o: Vehicle) { return this.track.wrapDelta(o.trackS - this.v.trackS) * this.dir; }

  private leader(offset: number, range: number): { v: Vehicle; gap: number } | null {
    let best: { v: Vehicle; gap: number } | null = null;
    const myD = this.dOf(offset);
    for (const o of this.ctxVehicles) {
      if (o === this.v) continue;
      const ds = this.distAlong(o);
      if (ds <= 0 || ds > range) continue;
      if (Math.abs(o.trackD - myD) > 2.6) continue;
      const gap = ds - (o.cls.look.length + this.v.cls.look.length) / 2;
      if (!best || gap < best.gap) best = { v: o, gap };
    }
    return best;
  }
  private laneFree(lane: number, margin = 1) {
    const d = this.dOf(laneCenterOffset(lane));
    for (const o of this.ctxVehicles) {
      if (o === this.v) continue;
      if (Math.abs(o.trackD - d) > 2.8) continue;
      const ds = this.distAlong(o);
      const rel = o.speed - this.v.speed;
      if (ds > -12 * margin - Math.max(0, rel) * 2.5 && ds < 14 * margin) return false;
    }
    return true;
  }
  ctxVehicles: Vehicle[] = [];
}
