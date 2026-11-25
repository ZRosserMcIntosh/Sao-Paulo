// The Rapier world: the host rigid-body engine. It integrates every car's chassis (forces from
// OpenRoad Dynamics), resolves car-to-car, car-to-barrier and car-to-prop contacts, and runs the
// props and debris. Car bodies do NOT collide with the terrain: the core's tyres and body hull
// carry them on the ground (with the same heightfield), so Rapier and the core never fight over
// the same contact.
import RAPIER from '@dimforge/rapier3d-compat';
import type { Ground, Features } from '../world/terrain';
import type { Layout } from '../world/layout';
import type { Track } from '../world/track';

export type R = typeof RAPIER;

export const G = { TERRAIN: 1, STATIC: 2, VEHICLE: 4, PROP: 8, DEBRIS: 16 } as const;
const groups = (member: number, filter: number) => (member << 16) | filter;
export const GROUPS = {
  terrain: groups(G.TERRAIN, G.PROP | G.DEBRIS),
  static: groups(G.STATIC, G.VEHICLE | G.PROP | G.DEBRIS),
  vehicle: groups(G.VEHICLE, G.STATIC | G.VEHICLE | G.PROP | G.DEBRIS),
  prop: groups(G.PROP, G.TERRAIN | G.STATIC | G.VEHICLE | G.PROP | G.DEBRIS),
  debris: groups(G.DEBRIS, G.TERRAIN | G.STATIC | G.VEHICLE | G.PROP),
};

// What a static collider is, for damage bills and humour.
export type StaticKind = 'guardrail' | 'barrier' | 'pier' | 'abutment' | 'deck' | 'rail' | 'tree' | 'pole' | 'billboard';

let rapierReady: Promise<void> | null = null;
export function initRapier() {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export interface StaticInfo { kind: StaticKind; id: number; segment?: number }

export class PhysicsWorld {
  world: RAPIER.World;
  events: RAPIER.EventQueue;
  staticInfo = new Map<number, StaticInfo>(); // collider handle -> what it is
  railSegments: { run: number; k: number; x: number; y: number; z: number; yaw: number; len: number; hits: number; offset: number; tilt: number }[] = [];
  restitution = 0.12;

  constructor(readonly RAP: R) {
    this.world = new RAP.World({ x: 0, y: -9.80665, z: 0 });
    this.world.timestep = 1 / 120;
    this.world.integrationParameters.numSolverIterations = 6;
    this.events = new RAP.EventQueue(true);
  }

  buildStatic(track: Track, ground: Ground, f: Features, layout: Layout) {
    const RAP = this.RAP, w = this.world;
    // terrain heightfield (props and debris land on it). Rapier: rows along Z, columns along X,
    // column-major, centred on the collider.
    const { nx, nz, cell, minX, minZ, heights } = ground;
    const hf = new Float32Array(nx * nz);
    for (let iz = 0; iz < nz; ++iz) for (let ix = 0; ix < nx; ++ix) hf[iz + ix * nz] = heights[iz * nx + ix];
    const sx = (nx - 1) * cell, sz = (nz - 1) * cell;
    const tb = w.createRigidBody(RAP.RigidBodyDesc.fixed().setTranslation(minX + sx / 2, 0, minZ + sz / 2));
    w.createCollider(RAP.ColliderDesc.heightfield(nz - 1, nx - 1, hf, { x: sx, y: 1, z: sz }).setCollisionGroups(GROUPS.terrain).setFriction(0.8), tb);

    const fixed = w.createRigidBody(RAP.RigidBodyDesc.fixed());
    const box = (kind: StaticKind, id: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, friction = 0.35) => {
      const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
      const c = w.createCollider(
        RAP.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRotation(q).setCollisionGroups(GROUPS.static).setFriction(friction).setRestitution(this.restitution)
          .setActiveEvents(RAP.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(1500),
        fixed,
      );
      this.staticInfo.set(c.handle, { kind, id });
      return c;
    };
    const cyl = (kind: StaticKind, id: number, x: number, y: number, z: number, r: number, hh: number) => {
      const c = w.createCollider(
        RAP.ColliderDesc.cylinder(hh, r).setTranslation(x, y + hh, z).setCollisionGroups(GROUPS.static).setFriction(0.5).setRestitution(this.restitution)
          .setActiveEvents(RAP.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(1500),
        fixed,
      );
      this.staticInfo.set(c.handle, { kind, id });
      return c;
    };

    // guardrails and the median barrier, one box per segment
    layout.rails.forEach((run, ri) => {
      for (let k = 0; k + 1 < run.pts.length; ++k) {
        const a = run.pts[k], b = run.pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
        if (len < 0.1) continue;
        const yaw = Math.atan2(-dz, dx);
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = (a.y + b.y) / 2;
        let c;
        if (run.kind === 'barrier') c = box('barrier', ri, mx, my + 0.46, mz, len / 2 + 0.02, 0.46, 0.3, yaw, 0.3);
        else c = box('guardrail', ri, mx, my + 0.62, mz, len / 2 + 0.05, 0.2, 0.22, yaw, 0.25);
        this.staticInfo.get(c.handle)!.segment = this.railSegments.length;
        this.railSegments.push({ run: ri, k, x: mx, y: my, z: mz, yaw, len, hits: 0, offset: 0, tilt: 0 });
      }
    });

    // the overpass: deck, parapets, centre pier, abutments
    const op = f.overpass;
    const yawU = Math.atan2(-op.uz, op.ux);
    const deckThick = 1.3;
    box('deck', 0, op.x, f.deckY - deckThick / 2, op.z, op.halfSpan + 0.2, deckThick / 2, op.halfWidth + 0.6, yawU);
    for (const vs of [1, -1]) {
      const px = op.x + op.vx * vs * (op.halfWidth + 0.35), pz = op.z + op.vz * vs * (op.halfWidth + 0.35);
      box('rail', 0, px, f.deckY + 0.55, pz, op.halfSpan + 0.2, 0.55, 0.25, yawU);
    }
    for (const vs of [-1, 1]) {
      const px = op.x + op.vx * vs * 3.2, pz = op.z + op.vz * vs * 3.2;
      cyl('pier', 0, px, op.y - 0.2, pz, 0.6, (f.deckY - deckThick - op.y) / 2 + 0.2);
    }
    for (const us of [1, -1]) {
      const ax = op.x + op.ux * us * (op.halfSpan + 0.6), az = op.z + op.uz * us * (op.halfSpan + 0.6);
      const hy = (f.deckY - op.y) / 2 + 1;
      box('abutment', 0, ax, op.y + hy - 1.5, az, 1.0, hy, op.halfWidth + 6, yawU);
    }

    // tree trunks near the road (the forest beyond is out of reach anyway)
    layout.trees.forEach((t, i) => {
      const k = Math.round((t.z - minZ) / cell) * nx + Math.round((t.x - minX) / cell);
      if (ground.near[k] < 140) cyl('tree', i, t.x, t.y - 0.5, t.z, 0.22 + t.h * 0.006, 2.5);
    });
    layout.billboards.forEach((b, i) => {
      const rx = Math.cos(b.heading + Math.PI / 2), rz = -Math.sin(b.heading + Math.PI / 2);
      for (const s of [-1, 1]) cyl('billboard', i, b.x + rx * s * 3.5, b.y - 0.5, b.z + rz * s * 3.5, 0.25, 3.5);
    });
    layout.lights.forEach((l, i) => cyl('pole', i, l.x, l.y, l.z, 0.18, 2));
    void track;
  }

  setRestitution(r: number) {
    this.restitution = r;
    this.world.forEachCollider((c) => c.setRestitution(r));
  }
}
