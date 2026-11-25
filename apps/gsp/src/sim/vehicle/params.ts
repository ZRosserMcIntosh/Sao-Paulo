// The vehicle definition the physics core builds every car from: a named mirror of the flat
// GSP_* parameter block in Vehicle-Dynamics web/gsp_web.cpp. Every field here is live-tunable
// in the lab panel and exported / imported as JSON.

export interface VehicleParams {
  mass: number; // kg, total
  inertiaRoll: number; // kg m^2 about the CoM
  inertiaPitch: number;
  inertiaYaw: number;
  wheelbase: number; // m
  frontWeight: number; // static share of weight on the front axle
  trackFront: number; // m
  trackRear: number;
  cgHeight: number; // m above ground at rest (rollover!)
  tireRadiusFront: number; // m
  tireRadiusRear: number;
  gripLongFront: number; // peak mu, longitudinal
  gripLatFront: number; // peak mu, lateral
  gripLongRear: number;
  gripLatRear: number;
  corneringStiffness: number; // Fz0 per rad
  springFront: number; // N/m at the wheel
  springRear: number;
  suspensionTravel: number; // m
  bumpFront: number; // N s/m
  reboundFront: number;
  bumpRear: number;
  reboundRear: number;
  antiRollFront: number; // N/m
  antiRollRear: number;
  steeringLock: number; // rad at the road wheel
  brakeFront: number; // N m per wheel
  brakeRear: number;
  handbrake: number; // N m per rear wheel
  drive: 0 | 1 | 2; // RWD, FWD, AWD
  awdFrontShare: number;
  differential: 0 | 1 | 2; // open, locked, clutch LSD
  finalDrive: number;
  transmission: 0 | 1 | 2; // automatic, dual clutch, manual
  shiftTime: number; // s
  gears: number[]; // forward ratios (1..10)
  reverseRatio: number;
  idleRpm: number;
  redlineRpm: number;
  engineInertia: number; // kg m^2
  torqueCurve: [number, number][]; // (rpm, N m), up to 8 points
  dragArea: number; // Cd A, m^2
  topSpeed: number; // m/s electronic limiter, 0 = none
  overhangFront: number; // m ahead of the front axle (body hull)
  overhangRear: number;
  halfWidth: number; // m
  bodyHeight: number; // m floor to roof
  bodyFriction: number; // body sliding on the road (rollovers)
  unsprungMass: number; // kg per corner
  ackermann: number; // 0..1
  clutchTorque: number; // N m
  wetGrip: number; // tyre mu multiplier on a fully wet road
  looseGrip: number; // ... on gravel, grass, clay
  lsdPreload: number; // N m
  lsdPower: number; // 0..1 ramp on power
  lsdCoast: number; // 0..1 ramp on overrun
}

export const PARAM_COUNT = 96;

// Writes the block in the C++ layout.
export function paramsToArray(p: VehicleParams, out: Float64Array, base = 0) {
  out.fill(0, base, base + PARAM_COUNT);
  const s = (i: number, v: number) => (out[base + i] = Number.isFinite(v) ? v : 0);
  s(0, p.mass); s(1, p.inertiaRoll); s(2, p.inertiaPitch); s(3, p.inertiaYaw);
  s(4, p.wheelbase); s(5, p.frontWeight); s(6, p.trackFront); s(7, p.trackRear); s(8, p.cgHeight);
  s(9, p.tireRadiusFront); s(10, p.tireRadiusRear);
  s(11, p.gripLongFront); s(12, p.gripLatFront); s(13, p.gripLongRear); s(14, p.gripLatRear);
  s(15, p.corneringStiffness); s(16, p.springFront); s(17, p.springRear); s(18, p.suspensionTravel);
  s(19, p.bumpFront); s(20, p.reboundFront); s(21, p.bumpRear); s(22, p.reboundRear);
  s(23, p.antiRollFront); s(24, p.antiRollRear); s(25, p.steeringLock);
  s(26, p.brakeFront); s(27, p.brakeRear); s(28, p.handbrake);
  s(29, p.drive); s(30, p.awdFrontShare); s(31, p.differential); s(32, p.finalDrive);
  s(33, p.transmission); s(34, p.shiftTime);
  const g = p.gears.slice(0, 10);
  s(35, g.length);
  g.forEach((r, k) => s(36 + k, r));
  s(46, p.reverseRatio); s(47, p.idleRpm); s(48, p.redlineRpm); s(49, p.engineInertia);
  const c = p.torqueCurve.slice(0, 8);
  s(50, c.length);
  c.forEach(([rpm, nm], k) => { s(51 + 2 * k, rpm); s(52 + 2 * k, nm); });
  s(67, p.dragArea); s(68, p.topSpeed); s(69, p.overhangFront); s(70, p.overhangRear);
  s(71, p.halfWidth); s(72, p.bodyHeight); s(73, p.bodyFriction); s(74, p.unsprungMass);
  s(75, p.ackermann); s(76, p.clutchTorque); s(77, p.wetGrip); s(78, p.looseGrip);
  s(79, p.lsdPreload); s(80, p.lsdPower); s(81, p.lsdCoast);
}

// Global live multipliers from the lab panel, applied on top of a definition.
export interface HandlingScales {
  grip: number; // tyre mu
  suspension: number; // springs, dampers, bars
  steeringLock: number;
}

export function scaledParams(p: VehicleParams, k: HandlingScales): VehicleParams {
  const sus = k.suspension, dmp = Math.sqrt(sus);
  return {
    ...p,
    gripLongFront: p.gripLongFront * k.grip,
    gripLatFront: p.gripLatFront * k.grip,
    gripLongRear: p.gripLongRear * k.grip,
    gripLatRear: p.gripLatRear * k.grip,
    springFront: p.springFront * sus,
    springRear: p.springRear * sus,
    bumpFront: p.bumpFront * dmp,
    reboundFront: p.reboundFront * dmp,
    bumpRear: p.bumpRear * dmp,
    reboundRear: p.reboundRear * dmp,
    antiRollFront: p.antiRollFront * sus,
    antiRollRear: p.antiRollRear * sus,
    steeringLock: p.steeringLock * k.steeringLock,
  };
}

// Field metadata for the lab panel's definition editor: [key, label, min, max, step, unit].
export const PARAM_FIELDS: [keyof VehicleParams, string, number, number, number, string][] = [
  ['mass', 'Mass', 600, 6000, 10, 'kg'],
  ['cgHeight', 'CoM height', 0.3, 1.4, 0.01, 'm'],
  ['frontWeight', 'Front weight', 0.3, 0.7, 0.01, ''],
  ['inertiaYaw', 'Yaw inertia', 500, 12000, 50, 'kg·m²'],
  ['inertiaRoll', 'Roll inertia', 200, 4000, 10, 'kg·m²'],
  ['inertiaPitch', 'Pitch inertia', 500, 12000, 50, 'kg·m²'],
  ['wheelbase', 'Wheelbase', 2.2, 4.4, 0.01, 'm'],
  ['trackFront', 'Track front', 1.3, 2.0, 0.01, 'm'],
  ['trackRear', 'Track rear', 1.3, 2.0, 0.01, 'm'],
  ['gripLongFront', 'Grip long. F', 0.4, 2.0, 0.01, 'μ'],
  ['gripLatFront', 'Grip lat. F', 0.4, 2.0, 0.01, 'μ'],
  ['gripLongRear', 'Grip long. R', 0.4, 2.0, 0.01, 'μ'],
  ['gripLatRear', 'Grip lat. R', 0.4, 2.0, 0.01, 'μ'],
  ['corneringStiffness', 'Cornering stiffness', 6, 30, 0.5, 'Fz/rad'],
  ['springFront', 'Spring F', 10000, 200000, 500, 'N/m'],
  ['springRear', 'Spring R', 10000, 200000, 500, 'N/m'],
  ['suspensionTravel', 'Travel', 0.08, 0.4, 0.005, 'm'],
  ['bumpFront', 'Bump F', 500, 15000, 100, 'N·s/m'],
  ['reboundFront', 'Rebound F', 500, 20000, 100, 'N·s/m'],
  ['bumpRear', 'Bump R', 500, 15000, 100, 'N·s/m'],
  ['reboundRear', 'Rebound R', 500, 20000, 100, 'N·s/m'],
  ['antiRollFront', 'Anti-roll F', 0, 80000, 500, 'N/m'],
  ['antiRollRear', 'Anti-roll R', 0, 80000, 500, 'N/m'],
  ['steeringLock', 'Steering lock', 0.25, 1.0, 0.01, 'rad'],
  ['brakeFront', 'Brake F', 500, 8000, 50, 'N·m'],
  ['brakeRear', 'Brake R', 300, 6000, 50, 'N·m'],
  ['handbrake', 'Handbrake', 0, 8000, 50, 'N·m'],
  ['finalDrive', 'Final drive', 2.0, 5.5, 0.01, ''],
  ['redlineRpm', 'Redline', 4000, 9000, 50, 'rpm'],
  ['dragArea', 'Drag area', 0.4, 2.0, 0.01, 'm²'],
  ['topSpeed', 'Top speed limiter', 0, 90, 0.5, 'm/s'],
  ['bodyFriction', 'Body friction', 0.1, 1.0, 0.01, ''],
  ['wetGrip', 'Wet grip', 0.4, 1.2, 0.01, '×'],
  ['looseGrip', 'Loose grip', 0.4, 1.2, 0.01, '×'],
  ['lsdPreload', 'LSD preload', 0, 400, 5, 'N·m'],
  ['lsdPower', 'LSD power ramp', 0, 1, 0.01, ''],
];
