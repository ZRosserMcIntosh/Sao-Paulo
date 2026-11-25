// Everything the lab panel can change, in one serializable object (export / import as JSON).
import type { VehicleParams } from './vehicle/params';
import { CATALOG, type VehicleKind } from './vehicle/catalog';
import { SURFACES, type SurfaceDef } from './world/terrain';

export interface ArcadeConfig {
  enabled: boolean;
  // Extra yaw impulse on a car struck in its rear quarter (0 = pure rigid body). An arcade aid:
  // it is added on top of Rapier's contact impulse, never instead of it.
  pitAssist: number;
  // Player yaw damping toward the steering's intent (0 = none). Not a real-car system.
  stability: number;
  // Speed-squared downforce on the player (0 = none). Not aero: an arcade grip bonus.
  downforce: number;
  // Lean-in steering help for AI police lining up a PIT (0..1)
  aiPolice: number;
}

export interface LabConfig {
  version: 1;
  preset: number; // 0 FUN, 1 SPORT, 2 SIMULATION, 3 DRIFT (the core's assist bundles)
  driftAssist: number;
  steeringSensitivity: number; // input gain (keyboard steer rate / pad response)
  steeringLockScale: number;
  gripScale: number;
  suspensionScale: number;
  surfaceFriction: number;
  restitution: number;
  substeps: number; // core substeps per 1/120 s host step
  arcade: ArcadeConfig;
  surfaces: Record<number, SurfaceDef>;
  vehicles: Partial<Record<VehicleKind, VehicleParams>>; // overrides of the catalog definitions
}

export function defaultLabConfig(): LabConfig {
  return {
    version: 1,
    preset: 1,
    driftAssist: 0,
    steeringSensitivity: 1,
    steeringLockScale: 1,
    gripScale: 1,
    suspensionScale: 1,
    surfaceFriction: 1,
    restitution: 0.12,
    substeps: 3,
    arcade: { enabled: true, pitAssist: 0.35, stability: 0.3, downforce: 0.15, aiPolice: 0.5 },
    surfaces: JSON.parse(JSON.stringify(SURFACES)),
    vehicles: {},
  };
}

export function vehicleParams(cfg: LabConfig, kind: VehicleKind): VehicleParams {
  return cfg.vehicles[kind] ?? CATALOG[kind].params;
}

export function exportConfig(cfg: LabConfig): string {
  return JSON.stringify({ about: 'Georgia State Pursuit lab configuration', ...cfg }, null, 2);
}

export function importConfig(text: string): LabConfig {
  const j = JSON.parse(text);
  const d = defaultLabConfig();
  if (j.version !== 1) throw new Error('not a GSP lab configuration (version 1)');
  const num = (v: unknown, def: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  const out: LabConfig = {
    ...d,
    preset: num(j.preset, d.preset, 0, 3),
    driftAssist: num(j.driftAssist, d.driftAssist, 0, 1),
    steeringSensitivity: num(j.steeringSensitivity, 1, 0.3, 2.5),
    steeringLockScale: num(j.steeringLockScale, 1, 0.5, 1.6),
    gripScale: num(j.gripScale, 1, 0.3, 2),
    suspensionScale: num(j.suspensionScale, 1, 0.3, 3),
    surfaceFriction: num(j.surfaceFriction, 1, 0.2, 2),
    restitution: num(j.restitution, d.restitution, 0, 0.9),
    substeps: Math.round(num(j.substeps, 3, 1, 8)),
    arcade: {
      enabled: typeof j.arcade?.enabled === 'boolean' ? j.arcade.enabled : true,
      pitAssist: num(j.arcade?.pitAssist, d.arcade.pitAssist, 0, 1),
      stability: num(j.arcade?.stability, d.arcade.stability, 0, 1),
      downforce: num(j.arcade?.downforce, d.arcade.downforce, 0, 1),
      aiPolice: num(j.arcade?.aiPolice, d.arcade.aiPolice, 0, 1),
    },
    surfaces: { ...d.surfaces },
    vehicles: {},
  };
  if (j.surfaces && typeof j.surfaces === 'object') {
    for (const [k, v] of Object.entries(j.surfaces as Record<string, Partial<SurfaceDef>>)) {
      const base = d.surfaces[Number(k)];
      if (base && v) out.surfaces[Number(k)] = { ...base, ...v };
    }
  }
  if (j.vehicles && typeof j.vehicles === 'object') {
    for (const [k, v] of Object.entries(j.vehicles as Record<string, Partial<VehicleParams>>)) {
      const base = CATALOG[k as VehicleKind]?.params;
      if (base && v) out.vehicles[k as VehicleKind] = { ...base, ...v } as VehicleParams;
    }
  }
  return out;
}
