// Loose things Rapier simulates on its own: cones, drums, barricades, and the parts that fall off
// cars (bumpers, mirrors, light bars, hubcaps). Interpolated like the cars for rendering.
// Props sit in a lower dominance group than cars: a 2-tonne car scatters a 20 kg drum, and a
// drum wedged under a car can never act as a ramp and launch it.
import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUPS, type PhysicsWorld } from './physics/world';
import type { Q4, V3 } from './math';
import type { PropSpot } from './world/layout';
import type { PartId } from './vehicle/damage';

export type PropKind = 'cone' | 'drum' | 'barricade' | 'debris';

export interface Prop {
  id: number;
  kind: PropKind;
  part?: PartId;
  color?: string;
  size: [number, number, number]; // half extents (debris)
  body: RAPIER.RigidBody;
  home: V3;
  prevP: V3; prevQ: Q4; p: V3; q: Q4;
  knocked: boolean;
  born: number;
  ownerId?: number;
}

let nextPropId = 1;

export class Props {
  list: Prop[] = [];
  colliderToProp = new Map<number, Prop>();
  constructor(readonly phys: PhysicsWorld) {}

  private add(kind: PropKind, body: RAPIER.RigidBody, size: [number, number, number], born: number, extra: Partial<Prop> = {}) {
    const t = body.translation(), r = body.rotation();
    const p: Prop = {
      id: nextPropId++, kind, size, body, home: { x: t.x, y: t.y, z: t.z },
      prevP: { x: t.x, y: t.y, z: t.z }, prevQ: { x: r.x, y: r.y, z: r.z, w: r.w }, p: { x: t.x, y: t.y, z: t.z }, q: { x: r.x, y: r.y, z: r.z, w: r.w },
      knocked: false, born, ...extra,
    };
    this.list.push(p);
    for (let i = 0; i < body.numColliders(); ++i) this.colliderToProp.set(body.collider(i).handle, p);
    return p;
  }

  spawnSpot(s: PropSpot) {
    const R = this.phys.RAP, w = this.phys.world;
    const q = { x: 0, y: Math.sin(s.heading / 2), z: 0, w: Math.cos(s.heading / 2) };
    if (s.kind === 'cone') {
      const b = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(s.x, s.y + 0.385, s.z).setRotation(q).setCanSleep(true).setLinearDamping(0.05).setAngularDamping(0.3));
      w.createCollider(R.ColliderDesc.cone(0.34, 0.16).setTranslation(0, 0.02, 0).setMass(2.6).setFriction(0.7).setRestitution(0.2).setCollisionGroups(GROUPS.prop).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300), b);
      w.createCollider(R.ColliderDesc.cuboid(0.19, 0.02, 0.19).setTranslation(0, -0.34, 0).setMass(1.8).setFriction(0.9).setCollisionGroups(GROUPS.prop), b);
      b.sleep();
      return this.add('cone', b, [0.19, 0.36, 0.19], 0);
    }
    if (s.kind === 'drum') {
      const b = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(s.x, s.y + 0.505, s.z).setCanSleep(true).setLinearDamping(0.05).setAngularDamping(0.3));
      w.createCollider(R.ColliderDesc.cylinder(0.47, 0.29).setMass(9).setFriction(0.6).setRestitution(0.25).setCollisionGroups(GROUPS.prop).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(400), b);
      w.createCollider(R.ColliderDesc.cylinder(0.04, 0.36).setTranslation(0, -0.45, 0).setMass(14).setFriction(0.9).setCollisionGroups(GROUPS.prop), b);
      b.sleep();
      return this.add('drum', b, [0.36, 0.48, 0.36], 0);
    }
    const b = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(s.x, s.y + 0.56, s.z).setRotation(q).setCanSleep(true));
    w.createCollider(R.ColliderDesc.cuboid(1.2, 0.3, 0.05).setTranslation(0, 0.2, 0).setMass(12).setFriction(0.6).setCollisionGroups(GROUPS.prop).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(400), b);
    w.createCollider(R.ColliderDesc.cuboid(1.1, 0.04, 0.35).setTranslation(0, -0.5, 0).setMass(10).setFriction(0.9).setCollisionGroups(GROUPS.prop), b);
    b.sleep();
    return this.add('barricade', b, [1.2, 0.55, 0.35], 0);
  }

  // A part torn off a car: a box carrying the car's velocity at that point, plus a kick.
  spawnDebris(part: PartId, pos: V3, q: Q4, vel: V3, angvel: V3, half: [number, number, number], mass: number, color: string, time: number, ownerId: number) {
    const R = this.phys.RAP, w = this.phys.world;
    const b = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(q).setLinvel(vel.x, vel.y, vel.z).setAngvel(angvel).setCanSleep(true).setCcdEnabled(true).setLinearDamping(0.08).setAngularDamping(0.15));
    w.createCollider(R.ColliderDesc.cuboid(half[0], half[1], half[2]).setMass(mass).setFriction(0.55).setRestitution(0.2).setCollisionGroups(GROUPS.debris), b);
    const p = this.add('debris', b, half, time, { part, color, ownerId });
    // cap the debris count
    const debris = this.list.filter((x) => x.kind === 'debris');
    if (debris.length > 40) this.remove(debris[0]);
    return p;
  }

  remove(p: Prop) {
    for (let i = 0; i < p.body.numColliders(); ++i) this.colliderToProp.delete(p.body.collider(i).handle);
    this.phys.world.removeRigidBody(p.body);
    this.list.splice(this.list.indexOf(p), 1);
  }

  post() {
    for (const p of this.list) {
      p.prevP.x = p.p.x; p.prevP.y = p.p.y; p.prevP.z = p.p.z;
      p.prevQ.x = p.q.x; p.prevQ.y = p.q.y; p.prevQ.z = p.q.z; p.prevQ.w = p.q.w;
      if (p.body.isSleeping()) continue;
      const t = p.body.translation(), r = p.body.rotation();
      p.p.x = t.x; p.p.y = t.y; p.p.z = t.z;
      p.q.x = r.x; p.q.y = r.y; p.q.z = r.z; p.q.w = r.w;
    }
  }

  clear() {
    for (const p of [...this.list]) this.remove(p);
  }
}
