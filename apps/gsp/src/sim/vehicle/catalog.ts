// Vehicle classes. Every number is a design estimate for a fictional vehicle; no real model's
// data. Each entry is a full physical definition (VehicleParams, what the core simulates) plus
// how it looks (VehicleLook, what the renderer builds procedurally).
import type { VehicleParams } from './params';

export type BodyStyle = 'sedan' | 'pickup' | 'suv' | 'hatch' | 'van';
export type VehicleKind = 'interceptor' | 'sedan' | 'pickup' | 'suv' | 'hatch' | 'van' | 'coupe';

export interface VehicleLook {
  style: BodyStyle;
  length: number;
  width: number;
  height: number;
  groundClearance: number;
  police: boolean;
  paint: string; // body colour
  paint2?: string; // secondary (police: silver)
  wheel: string; // rim colour
  name: string; // shown in the UI
  maker: string; // fictional
}

export interface VehicleClass {
  kind: VehicleKind;
  params: VehicleParams;
  look: VehicleLook;
  repairCostPerDv: number; // $ per m/s of impact delta-v (insurance humour)
  value: number; // $ (total-loss value)
}

function inertias(m: number, L: number, W: number, H: number) {
  return {
    inertiaRoll: Math.round(m * (W * W + H * H) / 12 * 0.72),
    inertiaPitch: Math.round(m * (L * L + H * H) / 12 * 0.78),
    inertiaYaw: Math.round(m * (L * L + W * W) / 12 * 0.8),
  };
}

const base: Omit<VehicleParams, 'mass' | 'inertiaRoll' | 'inertiaPitch' | 'inertiaYaw'> = {
  wheelbase: 2.8, frontWeight: 0.55, trackFront: 1.58, trackRear: 1.58, cgHeight: 0.55,
  tireRadiusFront: 0.34, tireRadiusRear: 0.34,
  gripLongFront: 1.02, gripLatFront: 0.98, gripLongRear: 1.04, gripLatRear: 1.0, corneringStiffness: 15,
  springFront: 36000, springRear: 34000, suspensionTravel: 0.2,
  bumpFront: 2800, reboundFront: 4200, bumpRear: 2600, reboundRear: 4000,
  antiRollFront: 18000, antiRollRear: 9000, steeringLock: 0.6,
  brakeFront: 2600, brakeRear: 1400, handbrake: 2200,
  drive: 1, awdFrontShare: 0.4, differential: 0, finalDrive: 3.6, transmission: 0, shiftTime: 0.3,
  gears: [4.15, 2.37, 1.56, 1.16, 0.86, 0.69], reverseRatio: 3.4, idleRpm: 750, redlineRpm: 6500, engineInertia: 0.2,
  torqueCurve: [[1000, 220], [2000, 280], [3500, 330], [4800, 340], [6000, 300], [6500, 270]],
  dragArea: 0.72, topSpeed: 58, overhangFront: 0.95, overhangRear: 1.05, halfWidth: 0.9, bodyHeight: 1.2,
  bodyFriction: 0.5, unsprungMass: 40, ackermann: 0.5, clutchTorque: 700, wetGrip: 0.85, looseGrip: 0.8,
  lsdPreload: 60, lsdPower: 0.4, lsdCoast: 0.2,
};

// GSP-71 "Peach State" Pursuit Interceptor: big RWD V8 sedan, 8-speed auto, clutch LSD,
// pursuit-rated brakes and suspension, push bar, 150 mph limiter.
const interceptor: VehicleClass = {
  kind: 'interceptor',
  params: {
    ...base, mass: 1950, ...inertias(1950, 5.1, 1.91, 1.48),
    wheelbase: 3.05, frontWeight: 0.52, trackFront: 1.62, trackRear: 1.62, cgHeight: 0.54,
    tireRadiusFront: 0.36, tireRadiusRear: 0.36,
    gripLongFront: 1.1, gripLatFront: 1.06, gripLongRear: 1.12, gripLatRear: 1.08, corneringStiffness: 16,
    springFront: 44000, springRear: 47000, bumpFront: 3500, reboundFront: 5200, bumpRear: 3500, reboundRear: 5200,
    antiRollFront: 26000, antiRollRear: 14000, steeringLock: 0.58,
    brakeFront: 3400, brakeRear: 2000, handbrake: 2800,
    drive: 0, differential: 2, finalDrive: 3.07, transmission: 0, shiftTime: 0.16,
    gears: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67], reverseRatio: 3.53, idleRpm: 700, redlineRpm: 6200, engineInertia: 0.25,
    torqueCurve: [[1000, 410], [2000, 490], [3000, 530], [4200, 545], [5200, 525], [5800, 485], [6200, 440]],
    dragArea: 0.82, topSpeed: 67, overhangFront: 0.98, overhangRear: 1.08, halfWidth: 0.95, bodyHeight: 1.26,
    unsprungMass: 46, clutchTorque: 1000, lsdPreload: 90, lsdPower: 0.45, lsdCoast: 0.25,
  },
  look: { style: 'sedan', length: 5.1, width: 1.91, height: 1.48, groundClearance: 0.14, police: true, paint: '#173a7a', paint2: '#c8ccd2', wheel: '#141414', name: 'GSP-71 Pursuit Interceptor', maker: 'Peach State Patrol Fleet' },
  repairCostPerDv: 1900,
  value: 52000,
};

// The suspect's sedan: a tired FWD V6 midsize, 6-speed automatic, open diff.
const sedan: VehicleClass = {
  kind: 'sedan',
  params: {
    ...base, mass: 1540, ...inertias(1540, 4.88, 1.84, 1.45),
    wheelbase: 2.78, frontWeight: 0.6, trackFront: 1.58, trackRear: 1.57, cgHeight: 0.55,
    tireRadiusFront: 0.33, tireRadiusRear: 0.33,
    gripLongFront: 0.98, gripLatFront: 0.95, gripLongRear: 0.98, gripLatRear: 0.94,
    springFront: 32000, springRear: 28000, antiRollFront: 16000, antiRollRear: 6000,
    drive: 1, finalDrive: 3.5, torqueCurve: [[1000, 230], [2000, 290], [3500, 340], [4800, 350], [6000, 320], [6600, 290]],
    redlineRpm: 6600, dragArea: 0.68, topSpeed: 60, overhangFront: 0.95, overhangRear: 1.12, halfWidth: 0.9, bodyHeight: 1.22,
  },
  look: { style: 'sedan', length: 4.88, width: 1.84, height: 1.45, groundClearance: 0.14, police: false, paint: '#8a1d1d', wheel: '#b9bcc0', name: '2009 Magnolia Corsair LX', maker: 'Magnolia Motors' },
  repairCostPerDv: 900,
  value: 6400,
};

// Heavy pickup: 2.8 t body-on-frame, tall, soft, V8 torque, RWD with an open diff.
const pickup: VehicleClass = {
  kind: 'pickup',
  params: {
    ...base, mass: 2780, ...inertias(2780, 5.9, 2.03, 1.95),
    wheelbase: 3.68, frontWeight: 0.57, trackFront: 1.74, trackRear: 1.74, cgHeight: 0.84,
    tireRadiusFront: 0.41, tireRadiusRear: 0.41,
    gripLongFront: 0.95, gripLatFront: 0.9, gripLongRear: 0.95, gripLatRear: 0.9, corneringStiffness: 12,
    springFront: 70000, springRear: 62000, suspensionTravel: 0.26,
    bumpFront: 5200, reboundFront: 7400, bumpRear: 5000, reboundRear: 7000,
    antiRollFront: 30000, antiRollRear: 4000, steeringLock: 0.62,
    brakeFront: 4200, brakeRear: 3000, handbrake: 3000,
    drive: 0, differential: 0, finalDrive: 3.73,
    gears: [4.03, 2.36, 1.53, 1.15, 0.85, 0.67], redlineRpm: 5800, engineInertia: 0.4,
    torqueCurve: [[1000, 480], [2000, 580], [3000, 620], [4000, 610], [5000, 540], [5800, 470]],
    dragArea: 1.3, topSpeed: 52, overhangFront: 0.95, overhangRear: 1.3, halfWidth: 1.0, bodyHeight: 1.55,
    unsprungMass: 75, clutchTorque: 1200, looseGrip: 0.95,
  },
  look: { style: 'pickup', length: 5.9, width: 2.03, height: 1.95, groundClearance: 0.24, police: false, paint: '#e6e3da', wheel: '#9a9da1', name: '2014 Bulldog 2500 HD', maker: 'Okefenokee Truck Works' },
  repairCostPerDv: 1500,
  value: 18500,
};

const suv: VehicleClass = {
  kind: 'suv',
  params: {
    ...base, mass: 2280, ...inertias(2280, 5.05, 2.0, 1.82),
    wheelbase: 3.0, frontWeight: 0.55, trackFront: 1.7, trackRear: 1.7, cgHeight: 0.72,
    tireRadiusFront: 0.38, tireRadiusRear: 0.38, gripLatFront: 0.94, gripLatRear: 0.95,
    springFront: 48000, springRear: 46000, suspensionTravel: 0.24, antiRollFront: 26000, antiRollRear: 9000,
    brakeFront: 3400, brakeRear: 2200,
    drive: 2, awdFrontShare: 0.4, finalDrive: 3.4,
    torqueCurve: [[1000, 320], [2000, 400], [3500, 450], [4800, 440], [5800, 400], [6200, 360]], redlineRpm: 6200,
    dragArea: 1.0, topSpeed: 55, overhangFront: 0.92, overhangRear: 1.1, halfWidth: 0.98, bodyHeight: 1.5, unsprungMass: 55,
  },
  look: { style: 'suv', length: 5.05, width: 2.0, height: 1.82, groundClearance: 0.21, police: false, paint: '#2f3b2c', wheel: '#a8abb0', name: '2017 Chattahoochee Ridgeline', maker: 'Magnolia Motors' },
  repairCostPerDv: 1300,
  value: 21000,
};

const hatch: VehicleClass = {
  kind: 'hatch',
  params: {
    ...base, mass: 1260, ...inertias(1260, 4.3, 1.78, 1.46),
    wheelbase: 2.6, frontWeight: 0.61, trackFront: 1.53, trackRear: 1.52, cgHeight: 0.53,
    tireRadiusFront: 0.31, tireRadiusRear: 0.31,
    springFront: 30000, springRear: 26000, antiRollFront: 15000, antiRollRear: 8000,
    brakeFront: 2100, brakeRear: 1000, handbrake: 1600,
    finalDrive: 4.1, gears: [3.6, 2.1, 1.4, 1.03, 0.82], torqueCurve: [[1000, 120], [2000, 160], [3500, 190], [5000, 185], [6200, 160], [6600, 140]],
    redlineRpm: 6600, dragArea: 0.62, topSpeed: 52, overhangFront: 0.85, overhangRear: 0.82, halfWidth: 0.88, bodyHeight: 1.22, unsprungMass: 34,
  },
  look: { style: 'hatch', length: 4.3, width: 1.78, height: 1.46, groundClearance: 0.14, police: false, paint: '#2a6f9b', wheel: '#c0c3c8', name: '2012 Peachtree Zephyr', maker: 'Peachtree Autoworks' },
  repairCostPerDv: 700,
  value: 5200,
};

const van: VehicleClass = {
  kind: 'van',
  params: {
    ...base, mass: 2080, ...inertias(2080, 5.15, 1.99, 1.77),
    wheelbase: 3.08, frontWeight: 0.57, trackFront: 1.72, trackRear: 1.72, cgHeight: 0.66,
    tireRadiusFront: 0.35, tireRadiusRear: 0.35, gripLatFront: 0.93, gripLatRear: 0.93,
    springFront: 40000, springRear: 42000, antiRollFront: 22000, antiRollRear: 9000,
    brakeFront: 3000, brakeRear: 1800,
    torqueCurve: [[1000, 250], [2000, 310], [3500, 350], [4800, 345], [6000, 310], [6400, 280]], redlineRpm: 6400,
    dragArea: 0.95, topSpeed: 52, overhangFront: 0.98, overhangRear: 1.08, halfWidth: 0.98, bodyHeight: 1.48, unsprungMass: 45,
  },
  look: { style: 'van', length: 5.15, width: 1.99, height: 1.77, groundClearance: 0.15, police: false, paint: '#7d7f83', wheel: '#a5a8ad', name: '2011 Okefenokee Family Hauler', maker: 'Okefenokee Truck Works' },
  repairCostPerDv: 1000,
  value: 7800,
};

const coupe: VehicleClass = {
  kind: 'coupe',
  params: {
    ...interceptor.params, mass: 1680, ...inertias(1680, 4.78, 1.92, 1.36),
    wheelbase: 2.82, frontWeight: 0.54, cgHeight: 0.5, bodyHeight: 1.12, overhangFront: 0.92, overhangRear: 1.04, halfWidth: 0.95,
    torqueCurve: [[1000, 380], [2000, 460], [3000, 520], [4200, 540], [5200, 520], [5800, 490], [6400, 440]], redlineRpm: 6400,
    topSpeed: 72, dragArea: 0.74, gears: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67], finalDrive: 3.09,
  },
  look: { style: 'sedan', length: 4.78, width: 1.92, height: 1.36, groundClearance: 0.13, police: false, paint: '#d8b21c', paint2: '#111111', wheel: '#1a1a1a', name: '2016 Thunderbolt SS "Hemi-ish"', maker: 'Peach State Muscle' },
  repairCostPerDv: 1600,
  value: 24000,
};

export const CATALOG: Record<VehicleKind, VehicleClass> = { interceptor, sedan, pickup, suv, hatch, van, coupe };

export const TRAFFIC_KINDS: VehicleKind[] = ['sedan', 'hatch', 'van', 'suv', 'pickup', 'sedan', 'hatch'];
export const TRAFFIC_PAINTS = ['#ececec', '#1c1c1c', '#7a7e84', '#2a3f6b', '#7d1414', '#3c5e3a', '#c9b38a', '#4b3a2a', '#b8bcc2', '#d6d1c4', '#204c63'];

export function cloneClass(k: VehicleKind): VehicleClass {
  const c = CATALOG[k];
  return {
    ...c,
    params: { ...c.params, gears: [...c.params.gears], torqueCurve: c.params.torqueCurve.map((p) => [p[0], p[1]] as [number, number]) },
    look: { ...c.look },
  };
}
