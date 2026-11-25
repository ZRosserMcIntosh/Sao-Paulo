// One car: an OpenRoad Dynamics vehicle (tyres, suspension, drivetrain, assists) hosted by a
// Rapier rigid body (chassis, contacts). Player, suspect, police and traffic are all this class;
// only who sets `controls` differs.
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GspEngine, BodyInfo } from '../engines/gsp';
import { STATE, WHEEL } from '../engines/gsp';
import { GROUPS, type PhysicsWorld } from '../physics/world';
import type { Q4, V3 } from '../math';
import { qinvrot, qrot } from '../math';
import type { VehicleClass } from './catalog';
import { scaledParams, type HandlingScales, type VehicleParams } from './params';
import { DamageState } from './damage';

export type Role = 'player' | 'suspect' | 'police' | 'traffic';

export interface Controls { steer: number; throttle: number; brake: number; handbrake: number; shiftUp: boolean; shiftDown: boolean; reverse?: boolean }

export interface WheelView { x: number; y: number; z: number; steer: number; spin: number; omega: number; radius: number; contact: boolean; slip: number; slipAngle: number; slipRatio: number; load: number; surface: number; compression: number; locked: boolean }

let nextId = 1;

export class Vehicle {
  readonly id = nextId++;
  handle: number;
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[] = [];
  info: BodyInfo;
  params: VehicleParams;
  controls: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false };
  emergency = false;
  siren = false;
  headlights = true;
  damage: DamageState;
  preset = 1;
  label = '';
  // interpolation
  prevP: V3 = { x: 0, y: 0, z: 0 };
  prevQ: Q4 = { x: 0, y: 0, z: 0, w: 1 };
  p: V3 = { x: 0, y: 0, z: 0 };
  q: Q4 = { x: 0, y: 0, z: 0, w: 1 };
  v: V3 = { x: 0, y: 0, z: 0 };
  w: V3 = { x: 0, y: 0, z: 0 };
  wheels: WheelView[] = [];
  prevWheels: WheelView[] = [];
  // derived each step
  speed = 0; // forward, m/s
  lateral = 0;
  yawRate = 0;
  rpm = 0;
  gear = 1;
  throttleOut = 0;
  upright = 1;
  accel: V3 = { x: 0, y: 0, z: 0 };
  sideslip = 0;
  brakeLight = 0;
  reversing = false;
  faultCount = 0;
  trackS = 0; // nearest centreline arc length (maintained by the simulation)
  trackD = 0;
  airborne = false;
  lastImpact = 0; // sim time of the last big hit
  stuckTime = 0;
  totaled = false;
  detained = false;
  billed = 0; // $ of damage charged so far
  stopTimer = 0;
  private F: V3 = { x: 0, y: 0, z: 0 };
  private T: V3 = { x: 0, y: 0, z: 0 };
  private reverseHold = 0;

  constructor(
    readonly gsp: GspEngine,
    readonly phys: PhysicsWorld,
    readonly cls: VehicleClass,
    readonly role: Role,
    x: number, z: number, yaw: number, speed: number, yHint: number,
    readonly fidelity: number,
    scales: HandlingScales,
    readonly paint: string,
  ) {
    this.params = cls.params;
    const p = scaledParams(cls.params, scales);
    const h = gsp.create(p, x, yHint, z, yaw, speed, fidelity);
    if (h < 0) throw new Error('could not create vehicle ' + cls.kind);
    this.handle = h;
    this.info = gsp.bodyInfo(h);
    const L = cls.look;
    this.damage = new DamageState(L.length / 2, L.width / 2, L.height, cls.repairCostPerDv, L.police);
    const R = phys.RAP;
    gsp.pose(h, this.p, this.q, this.v, this.w);
    const I = this.info.inertia; // ISO roll, pitch, yaw -> three X (roll), Y (yaw), Z (pitch)
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(this.p.x, this.p.y, this.p.z)
      .setRotation(this.q)
      .setLinvel(this.v.x, this.v.y, this.v.z)
      .setAngvel(this.w)
      .setCcdEnabled(true)
      .setCanSleep(false)
      .setDominanceGroup(10)
      .setLinearDamping(0)
      .setAngularDamping(0.02)
      .setAdditionalMassProperties(this.info.mass, { x: 0, y: 0, z: 0 }, { x: I[0], y: I[2], z: I[1] }, { x: 0, y: 0, z: 0, w: 1 });
    this.body = phys.world.createRigidBody(desc);
    this.body.userData = { vehicle: this.id };
    this.buildColliders();
    this.copyPose();
    this.copyPose();
    this.readState(0);
    this.prevWheels = this.wheels.map((w) => ({ ...w }));
  }

  private buildColliders() {
    const R = this.phys.RAP, b = this.info;
    // ISO body (x fwd, y left, z up) -> three body (x fwd, y up, z right): (x, z, -y)
    const lowerH = (b.belt - b.floor) / 2, lowerC = (b.belt + b.floor) / 2;
    const look = this.cls.look;
    const mk = (hx: number, hy: number, hz: number, cx: number, cy: number, cz: number, r: number) => {
      const c = this.phys.world.createCollider(
        R.ColliderDesc.roundCuboid(Math.max(0.05, hx - r), Math.max(0.05, hy - r), Math.max(0.05, hz - r), r)
          .setTranslation(cx, cy, cz).setDensity(0).setFriction(0.32).setRestitution(this.phys.restitution)
          .setCollisionGroups(GROUPS.vehicle)
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(2500),
        this.body,
      );
      this.colliders.push(c);
    };
    // lower body: full length, from the floor to the belt line
    mk((b.front - b.rear) / 2, lowerH, b.halfWidth, (b.front + b.rear) / 2, lowerC, 0, 0.12);
    // greenhouse (a pickup's cab is shorter; its bed sides come from the lower box)
    const cabFront = look.style === 'pickup' ? b.front - 1.55 : b.roofFront + 0.35;
    const cabRear = look.style === 'pickup' ? cabFront - 1.95 : look.style === 'hatch' || look.style === 'van' || look.style === 'suv' ? b.rear + 0.25 : b.roofRear - 0.3;
    const roofTop = b.floor + look.height - look.groundClearance - 0.02;
    const cabH = Math.max(0.2, (roofTop - b.belt) / 2);
    mk((cabFront - cabRear) / 2, cabH, b.halfWidth * 0.86, (cabFront + cabRear) / 2, b.belt + cabH, 0, 0.1);
  }

  setRestitution(r: number) { for (const c of this.colliders) c.setRestitution(r); }

  // Rebuilds the car's definition in place (lab sliders, JSON import), keeping its motion.
  applyParams(params: VehicleParams, scales: HandlingScales) {
    this.params = params;
    this.gsp.rebuild(this.handle, scaledParams(params, scales));
  }

  private copyPose() {
    this.prevP.x = this.p.x; this.prevP.y = this.p.y; this.prevP.z = this.p.z;
    this.prevQ.x = this.q.x; this.prevQ.y = this.q.y; this.prevQ.z = this.q.z; this.prevQ.w = this.q.w;
    const t = this.body.translation(), r = this.body.rotation();
    this.p.x = t.x; this.p.y = t.y; this.p.z = t.z;
    this.q.x = r.x; this.q.y = r.y; this.q.z = r.z; this.q.w = r.w;
  }

  // Before the Rapier step: hand the host state to the core, step the tyres and suspension,
  // apply their force and torque to the body.
  prePhysics(dt: number, substeps: number, extra?: (F: V3, T: V3) => void) {
    const b = this.body, gsp = this.gsp, h = this.handle;
    const t = b.translation(), r = b.rotation(), lv = b.linvel(), av = b.angvel();
    gsp.setBody(h, t, r, lv, av);
    // automatic gearbox: hold the brake at a standstill to engage reverse, then the brake pedal drives
    const c = this.controls;
    let throttle = c.throttle, brake = c.brake, up = c.shiftUp, down = c.shiftDown;
    if (this.role === 'player') {
      if (this.gear >= 1 && Math.abs(this.speed) < 0.6 && c.brake > 0.5 && c.throttle < 0.05) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.3) { down = true; this.reverseHold = 0; }
      } else this.reverseHold = 0;
      if (this.gear === -1) {
        throttle = c.brake; brake = c.throttle;
        if (Math.abs(this.speed) < 0.6 && c.throttle > 0.4) up = true;
      }
    } else {
      // AI asks for reverse explicitly (recovering from a spin); throttle then drives backwards
      if (c.reverse && this.gear >= 1 && Math.abs(this.speed) < 0.8) down = true;
      if (!c.reverse && this.gear === -1 && Math.abs(this.speed) < 0.8) up = true;
    }
    const power = this.damage.power * (this.totaled ? 0.25 : 1);
    const steer = Math.max(-1, Math.min(1, c.steer + this.damage.pull));
    // three: + steer = right; the core: + = left
    gsp.setInput(h, -steer, throttle * power, brake, c.handbrake, up, down);
    c.shiftUp = c.shiftDown = false;
    if (!gsp.step(h, dt, substeps)) {
      this.faultCount++;
      gsp.clearFault(h);
    }
    gsp.forces(h, this.F, this.T);
    extra?.(this.F, this.T);
    b.resetForces(false);
    b.resetTorques(false);
    b.addForce(this.F, true);
    b.addTorque(this.T, true);
  }

  // After the Rapier step: pose for interpolation, telemetry from the core.
  postPhysics(dt: number) {
    this.copyPose();
    const lv = this.body.linvel(), av = this.body.angvel();
    this.v.x = lv.x; this.v.y = lv.y; this.v.z = lv.z;
    this.w.x = av.x; this.w.y = av.y; this.w.z = av.z;
    this.readState(dt);
  }

  readState(dt: number) {
    const H = this.gsp.heap(), o = this.gsp.stateOffset(this.handle);
    const local = qinvrot(this.q, this.v);
    this.speed = local.x;
    this.lateral = local.z;
    this.yawRate = qinvrot(this.q, this.w).y;
    this.sideslip = Math.abs(local.x) > 1 ? Math.atan2(local.z, Math.abs(local.x)) : 0;
    this.rpm = H[o + STATE.rpm];
    this.gear = H[o + STATE.gear];
    this.throttleOut = H[o + STATE.throttle];
    this.upright = H[o + STATE.upright];
    // accelerations (ISO body x, y, z) -> three body (x, z, -y): forward, up, right
    this.accel.x = H[o + STATE.ax]; this.accel.y = H[o + STATE.az]; this.accel.z = -H[o + STATE.ay];
    this.reversing = this.gear === -1;
    this.brakeLight = Math.max(H[o + STATE.brakeIn], this.controls.brake > 0.05 && this.gear !== -1 ? this.controls.brake : 0);
    const nw = H[o + STATE.wheels] | 0, base = o + this.gsp.header;
    let contacts = 0;
    for (let k = 0; k < nw; ++k) {
      const p = base + this.gsp.perWheel * k;
      let w = this.wheels[k];
      if (!w) this.wheels.push((w = { x: 0, y: 0, z: 0, steer: 0, spin: 0, omega: 0, radius: 0.33, contact: false, slip: 0, slipAngle: 0, slipRatio: 0, load: 0, surface: 0, compression: 0, locked: false }));
      const pw = this.prevWheels[k];
      if (pw) { pw.x = w.x; pw.y = w.y; pw.z = w.z; pw.steer = w.steer; pw.spin = w.spin; }
      // ISO body (x, y, z) -> three body (x, z, -y)
      w.x = H[p + WHEEL.hx]; w.y = H[p + WHEEL.cz]; w.z = -H[p + WHEEL.hy];
      w.radius = H[p + WHEEL.radius];
      w.steer = -H[p + WHEEL.steer];
      w.omega = H[p + WHEEL.omega];
      w.spin += w.omega * dt;
      w.contact = H[p + WHEEL.contact] > 0.5;
      w.slipRatio = H[p + WHEEL.slipRatio];
      w.slipAngle = H[p + WHEEL.slipAngle];
      w.slip = H[p + WHEEL.grip];
      w.load = H[p + WHEEL.load];
      w.surface = H[p + WHEEL.surface];
      w.compression = H[p + WHEEL.compression];
      w.locked = H[p + WHEEL.locked] > 0.5;
      if (w.contact) ++contacts;
    }
    this.airborne = contacts === 0;
  }

  // World position of a body-frame point.
  toWorld(lp: V3): V3 { const r = qrot(this.q, lp); return { x: r.x + this.p.x, y: r.y + this.p.y, z: r.z + this.p.z }; }
  toLocal(wp: V3): V3 { return qinvrot(this.q, { x: wp.x - this.p.x, y: wp.y - this.p.y, z: wp.z - this.p.z }); }
  forward(): V3 { return qrot(this.q, { x: 1, y: 0, z: 0 }); }
  heading(): number { const f = this.forward(); return Math.atan2(-f.z, f.x); }

  respawn(x: number, yHint: number, z: number, yaw: number, speed: number) {
    this.gsp.place(this.handle, x, yHint, z, yaw, speed);
    this.gsp.pose(this.handle, this.p, this.q, this.v, this.w);
    this.body.setTranslation(this.p, true);
    this.body.setRotation(this.q, true);
    this.body.setLinvel(this.v, true);
    this.body.setAngvel(this.w, true);
    this.copyPose();
    this.copyPose();
    this.stuckTime = 0;
  }

  destroy() {
    this.phys.world.removeRigidBody(this.body);
    this.gsp.remove(this.handle);
  }
}
