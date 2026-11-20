// Street Lab — a car against a person crossing, or against São Paulo street furniture.
//
// Two of the game's native modules run here in WebAssembly: Pedestrian Dynamics (ped.wasm) and
// Street Dynamics (street.wasm). This page drives the car (a rigid body: mass, yaw inertia,
// brakes, tyres), tells both worlds where its exterior is each 60 Hz step, takes back the
// impulses they put on it, and draws what they compute. The car's exterior is the same set of
// boxes for both (vehicle_profiles.json): the bumper, bonnet, windscreen... a person meets.
//
// Sim frame: ENU (x along the road, y across it, z up, metres); the scene puts everything under
// one group turned to three.js's Y-up.
import * as THREE from 'three';
import createPedModule from './ped.mjs';
import createStreetModule from './street.mjs';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const DT = 1 / 60;
const G = 9.80665;
// The car's front as a crush zone (an estimate of a small car's front structure: ~80 kN before it
// gives, stiffening at 600 kN/m, up to half a metre).
const CRUSH_ONSET = 80e3, CRUSH_STIFFNESS = 600e3, MAX_CRUSH = 0.5;
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw-street:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw-street:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3200); }
function banner(title, sub = '') {
  $('banner-t').textContent = title; $('banner-s').textContent = sub;
  const b = $('banner'); b.classList.add('on'); clearTimeout(banner.h); banner.h = setTimeout(() => b.classList.remove('on'), 2600);
}

// ---------- Load the engines and their data ----------
let P, S, BODY, VEHS, LIBS;
try {
  const text = (f) => fetch(f).then((r) => { if (!r.ok) throw new Error(f + ': ' + r.status); return r.text(); });
  [P, S, BODY, VEHS, LIBS] = await Promise.all([createPedModule(), createStreetModule(), text('pedestrian_body.json'),
    text('vehicle_profiles.json'), text('street_library.json')]);
} catch (e) {
  $('loadMsg').textContent = 'Could not load the simulations: ' + e.message;
  throw e;
}
const PROFILES = JSON.parse(VEHS).profiles;
const LIB = JSON.parse(LIBS).types;

// ---------- Small vector and quaternion helpers (sim frame; quaternions [w, x, y, z]) ----------
const qmul = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const yawQ = (yaw) => [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
const rotZ = (yaw, v) => [Math.cos(yaw) * v[0] - Math.sin(yaw) * v[1], Math.sin(yaw) * v[0] + Math.cos(yaw) * v[1], v[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const alongBefore0 = (car) => Math.max(0, car.vel[0] * Math.cos(car.yaw) + car.vel[1] * Math.sin(car.yaw));

// A vehicle profile's parts as boxes in the vehicle frame (the same conversion the engine does):
// a box by its corners, a slab by the line of its top surface in side view, a thickness and a y range.
function partsOf(profile) {
  return profile.parts.map((p) => {
    if (p.box) {
      const [a, b] = [p.box.min, p.box.max];
      return { region: p.region, centre: [0, 1, 2].map((k) => (a[k] + b[k]) / 2), half: [0, 1, 2].map((k) => (b[k] - a[k]) / 2), q: [1, 0, 0, 0] };
    }
    const [[x1, z1], [x2, z2]] = p.slab.line, [y0, y1] = p.slab.y, th = p.slab.thickness ?? 0.3;
    let dx = x2 - x1, dz = z2 - z1;
    if (dx < 0) { dx = -dx; dz = -dz; }
    const l = Math.hypot(dx, dz); dx /= l; dz /= l;
    const up = [-dz, 0, dx], mid = [(x1 + x2) / 2, (y0 + y1) / 2, (z1 + z2) / 2];
    const ang = Math.atan2(-dz, dx);
    return { region: p.region, centre: [mid[0] - up[0] * th / 2, mid[1], mid[2] - up[2] * th / 2], half: [l / 2, (y1 - y0) / 2, th / 2],
      q: [Math.cos(ang / 2), 0, Math.sin(ang / 2), 0] };
  });
}

// ---------- The bench ----------
const WHO = {
  man: { stature: 1.75, mass: 75, label: '1.75 m, 75 kg' }, woman: { stature: 1.62, mass: 62, label: '1.62 m, 62 kg' },
  teen: { stature: 1.5, mass: 45, label: '1.50 m, 45 kg' }, child: { stature: 1.2, mass: 23, label: '1.20 m, 23 kg' },
};
const FACING = { left: Math.PI / 2, right: -Math.PI / 2, toward: Math.PI, away: 0 };
const OBJ_NAME = {
  stop_sign_r1: 'Stop sign', regulatory_r19: 'Speed-limit sign', warning_diamond: 'Warning sign', street_name_double: 'Street-name post',
  sign_slip_base: 'Slip-base sign', bollard_cast_iron: 'Frade', bollard_steel: 'Steel bollard', bollard_concrete: 'Concrete bollard',
  bike_rack_u: 'Bike rack',
};
// Where the objects stand across the car's path (relative to the offset), and which way they face
// (Street Dynamics' heading: degrees clockwise from north; signs face the oncoming car, west).
const layout = (type) => (type === 'bollard_cast_iron' ? [-0.7, 0.7] : [0]);
const headingOf = (type) => (type.startsWith('bollard') || type === 'bike_rack_u' ? 0 : 270);

const PRESETS = [
  { name: 'A person crossing · sedan 40 km/h', sub: 'Wrap: onto the bonnet, head on the bonnet', c: { target: 'person', vehicle: 'sedan', speed: 40, who: 'man', facing: 'left', offset: 0 } },
  { name: 'The same, at 60 km/h', sub: 'Higher, harder, further: ~23 m', c: { target: 'person', vehicle: 'sedan', speed: 60, who: 'man', facing: 'left', offset: 0 } },
  { name: 'SUV · 40 km/h', sub: 'Forward projection: the front reaches the hips', c: { target: 'person', vehicle: 'suv', speed: 40, who: 'man', facing: 'left', offset: 0 } },
  { name: 'A child · sedan 35 km/h', sub: 'Projected forward: the bonnet edge is above their centre of mass', c: { target: 'person', vehicle: 'sedan', speed: 35, who: 'child', facing: 'left', offset: 0 } },
  { name: 'The corner · sedan 40 km/h', sub: 'Fender vault over the wing', c: { target: 'person', vehicle: 'sedan', speed: 40, who: 'woman', facing: 'left', offset: 0.8 } },
  { name: 'Flat-fronted van · 30 km/h', sub: 'Thrown ahead; head on the low windscreen', c: { target: 'person', vehicle: 'van', speed: 30, who: 'man', facing: 'left', offset: 0 } },
  { name: 'Stop sign · 50 km/h', sub: 'The post folds; the PARE plate tears free', c: { target: 'object', object: 'stop_sign_r1', vehicle: 'sedan', speed: 50, offset: 0 } },
  { name: 'Breakaway sign · 60 km/h', sub: 'The slip base lets go: a 5 cm stub', c: { target: 'object', object: 'sign_slip_base', vehicle: 'sedan', speed: 60, offset: 0 } },
  { name: 'Cast-iron frades · 40 km/h', sub: 'Brittle: they snap', c: { target: 'object', object: 'bollard_cast_iron', vehicle: 'hatch', speed: 40, offset: 0 } },
  { name: 'Steel bollard · 25 km/h', sub: 'It bends and stops the car', c: { target: 'object', object: 'bollard_steel', vehicle: 'sedan', speed: 25, offset: 0 } },
  { name: 'Bike rack · 30 km/h', sub: 'Folds and tears off a foot', c: { target: 'object', object: 'bike_rack_u', vehicle: 'hatch', speed: 30, offset: 0 } },
  { name: 'Street-name post · 50 km/h', sub: 'Both plates fly', c: { target: 'object', object: 'street_name_double', vehicle: 'sedan', speed: 50, offset: 0 } },
  { name: 'A sign, then a person behind it', sub: 'Both engines at once', c: { target: 'both', object: 'stop_sign_r1', vehicle: 'sedan', speed: 45, who: 'man', facing: 'left', offset: 0 } },
];
const DEFAULT = { target: 'person', vehicle: 'sedan', speed: 40, brake: true, who: 'man', facing: 'left', object: 'stop_sign_r1', offset: 0 };
let cfg = { ...DEFAULT, ...store.get('cfg', {}) };

// ---------- A run: the two worlds, the car, the clock ----------
class Run {
  constructor(c) {
    this.c = { ...c };
    this.pw = P.world(1);
    if (this.pw.loadBody(BODY) < 0 || this.pw.loadVehicles(VEHS) < 0) throw new Error(this.pw.error());
    this.sw = S.world(1);
    if (this.sw.loadLibrary(LIBS) < 0) throw new Error(this.sw.error());
    this.ped = -1;
    this.objs = [];
    if (c.target !== 'person')
      for (const dy of layout(c.object)) this.objs.push({ id: this.sw.add(c.object, 0, c.offset + dy, headingOf(c.object)), type: c.object });
    if (c.target !== 'object') {
      const w = WHO[c.who];
      this.ped = this.pw.add({ x: c.target === 'both' ? 3.2 : 0, y: c.offset, heading: FACING[c.facing], stature: w.stature, mass: w.mass });
      this.pw.setAssist(this.ped, 1);  // standing, holding the pose, until struck
    }
    const prof = PROFILES[c.vehicle];
    this.prof = prof;
    this.profileIndex = this.pw.profile(c.vehicle);
    this.parts = partsOf(prof);
    const v = c.speed / 3.6;
    this.car = { mass: prof.mass, izz: prof.mass * 1.6, pos: [-prof.key.front - Math.max(3, v * 0.7), 0, 0], yaw: 0, vel: [v, 0, 0], yawRate: 0, braking: false, crush: 0 };
    // the front structure: the parts within 1.2 m of the nose draw back as it crushes
    this.frontParts = this.parts.map((p) => p.centre[0] > prof.key.front - 1.2 && p.centre[2] < prof.key.ble_height + 0.2);
    this.t = 0;
    this.steps = 0;
    this.hist = { t: [], car: [], pelvis: [], head: [] };
    this.impactSpeed = null;
    this.hitT = null;
    this.dvHit = 0;
    this.peakDecel = 0;
    this.stopT = null;
    this.done = false;
    this.seg = {};
    for (let s = 0; s < this.pw.segmentCount(); ++s) this.seg[this.pw.segmentName(s)] = s;
  }
  step() {
    const car = this.car, q = yawQ(car.yaw), w = [0, 0, car.yawRate];
    this.pw.setVehicles([{ id: 1, profile: this.profileIndex, position: car.pos, orientation: q, velocity: car.vel, angularVelocity: w }]);
    const bodies = this.parts.map((p, k) => {
      const r = rotZ(car.yaw, this.frontParts[k] ? [p.centre[0] - car.crush, p.centre[1], p.centre[2]] : p.centre);
      return { id: 10 + k, centre: [car.pos[0] + r[0], car.pos[1] + r[1], r[2]], orientation: qmul(q, p.q), half: p.half,
        velocity: [car.vel[0] - w[2] * r[1], car.vel[1] + w[2] * r[0], 0], angularVelocity: w };
    });
    this.sw.setBodies(bodies);
    this.pw.step(DT);
    this.sw.step(DT);
    // What the objects put on the car. The car's front is a crush zone: past CRUSH_ONSET it gives
    // (stiffening as it goes), the front parts draw back by the crush, and the car feels only the
    // crush force; the rest of the step's advance into the object is crumpled metal.
    const fwd0 = [Math.cos(car.yaw), Math.sin(car.yaw)];
    let sx = 0, sy = 0, sl = 0;
    bodies.forEach((b, k) => {
      const J = this.sw.bodyImpulse(10 + k);
      sx += J[0]; sy += J[1];
      sl += (b.centre[0] - car.pos[0]) * J[1] - (b.centre[1] - car.pos[1]) * J[0];
    });
    const force = -(sx * fwd0[0] + sy * fwd0[1]) / DT, cap = CRUSH_ONSET + CRUSH_STIFFNESS * car.crush;
    if (force > cap && car.crush < MAX_CRUSH) {
      const keep = cap / force, along = car.vel[0] * fwd0[0] + car.vel[1] * fwd0[1];
      sx *= keep; sy *= keep; sl *= keep;
      car.crush = Math.min(MAX_CRUSH, car.crush + Math.max(0, along) * DT * (1 - keep));
    }
    // and what the person puts on it
    const pi = this.pw.vehicleImpulse(0);
    let jx = pi.linear[0] + sx, jy = pi.linear[1] + sy, lz = pi.angular[2] + sl;
    const speed0 = Math.hypot(car.vel[0], car.vel[1]);
    const jm = Math.hypot(jx, jy);
    if (jm > 0.5) {
      if (this.impactSpeed == null) { this.impactSpeed = speed0; this.hitT = this.t; }
      if (this.c.brake) car.braking = true;
      this.dvHit += Math.min(alongBefore0(car), (-(jx * Math.cos(car.yaw) + jy * Math.sin(car.yaw))) / car.mass);
      this.peakDecel = Math.max(this.peakDecel, jm / car.mass / DT / G);
    }
    const alongBefore = car.vel[0] * fwd0[0] + car.vel[1] * fwd0[1];
    car.vel[0] += jx / car.mass;
    car.vel[1] += jy / car.mass;
    car.yawRate += lz / car.izz;
    // A car crumpled against a bollard stays there: the hit is plastic. Street furniture can
    // stop the car but not throw it back (the box coupling would return what the crush absorbed).
    const alongAfter = car.vel[0] * fwd0[0] + car.vel[1] * fwd0[1];
    if (alongBefore >= 0 && alongAfter < 0) { car.vel[0] -= alongAfter * fwd0[0]; car.vel[1] -= alongAfter * fwd0[1]; car.yawRate *= 0.5; }
    // tyres: grip across the wheels; brakes, or rolling resistance, along them
    const fwd = [Math.cos(car.yaw), Math.sin(car.yaw)];
    let vf = car.vel[0] * fwd[0] + car.vel[1] * fwd[1], vl = -car.vel[0] * fwd[1] + car.vel[1] * fwd[0];
    vl *= Math.max(0, 1 - 8 * DT);
    const dec = (car.braking ? 0.7 * G : 0.15) * DT;
    vf = vf > 0 ? Math.max(0, vf - dec) : Math.min(0, vf + dec);
    car.vel = [vf * fwd[0] - vl * fwd[1], vf * fwd[1] + vl * fwd[0], 0];
    car.yawRate *= Math.max(0, 1 - 3 * DT);
    car.pos = [car.pos[0] + car.vel[0] * DT, car.pos[1] + car.vel[1] * DT, 0];
    car.yaw += car.yawRate * DT;
    this.t += DT;
    this.steps++;
    if (this.impactSpeed != null && this.stopT == null && Math.hypot(car.vel[0], car.vel[1]) < 0.02) this.stopT = this.t;
    // speeds for the chart
    const h = this.hist;
    h.t.push(this.t);
    h.car.push(Math.hypot(car.vel[0], car.vel[1]) * 3.6);
    h.pelvis.push(this.ped >= 0 ? len(this.pw.velocity(this.ped, this.seg.pelvis)) * 3.6 : 0);
    h.head.push(this.ped >= 0 ? len(this.pw.velocity(this.ped, this.seg.head)) * 3.6 : 0);
    if (h.t.length > 1200) for (const k of Object.keys(h)) h[k].shift();
    // finished: the car has stopped, the person is at rest, and the street has settled (a car
    // parked against a bollard keeps it awake: give that two seconds)
    const personDone = this.ped < 0 || this.pw.report(this.ped).atRest;
    const streetDone = this.sw.stats().awake === 0 || (this.stopT != null && this.t - this.stopT > 2);
    if (!this.done && this.impactSpeed != null && this.stopT != null && personDone && streetDone) this.done = true;
    if (!this.done && this.t > 15) this.done = true;
  }
  hash() { return this.pw.hash() + ' ' + this.sw.hash(); }
  destroy() { this.pw.destroy(); this.sw.destroy(); }
}

// ---------- Scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9cb9d6');
scene.fog = new THREE.Fog('#9cb9d6', 90, 320);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 900);
scene.add(new THREE.HemisphereLight('#dfeaf5', '#5d5348', 1.15));
const sun = new THREE.DirectionalLight('#fff1dc', 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 200 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

const sim = new THREE.Group();
sim.rotation.x = -Math.PI / 2;
scene.add(sim);
const toScene = (p) => new THREE.Vector3(p[0], p[2], -p[1]);

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...o });
const M = {
  ground: mat('#6f7a5d'), road: mat('#3b3e43', { roughness: 0.95 }), walk: mat('#a9a49a'), kerb: mat('#c9c4b8'), paint: mat('#e9e6dc', { roughness: 0.7 }),
  house: [mat('#d8c8a9'), mat('#c99a83'), mat('#b9c4b0'), mat('#d1b4a0'), mat('#c4c0b4'), mat('#d9cfb9')], roof: mat('#8b5a44'), win: mat('#2a3038', { roughness: 0.3 }),
  car: mat('#c8332b', { metalness: 0.45, roughness: 0.35 }), carDark: mat('#7d1d18', { metalness: 0.4, roughness: 0.4 }),
  trim: mat('#22262b', { roughness: 0.6 }), plastic: mat('#3a3f45', { roughness: 0.7 }),
  glass: mat('#8fb6cf', { metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.38 }), tint: mat('#1d2733', { metalness: 0.2, roughness: 0.15 }),
  tyre: mat('#151515'), rim: mat('#9aa3ab', { metalness: 0.7, roughness: 0.35 }),
  shirt: mat('#2f6fb5'), trousers: mat('#2c2f38'), skin: mat('#d29f7c', { roughness: 0.7 }), shoe: mat('#141414'), hair: mat('#2a1d14'),
  galv: mat('#9aa3ab', { metalness: 0.6, roughness: 0.4 }), cast: mat('#33383d', { metalness: 0.3, roughness: 0.6 }),
  concrete: mat('#b9b4aa'), yellow: mat('#d8b43c', { roughness: 0.55 }), back: mat('#8c949b', { metalness: 0.5, roughness: 0.5 }),
};
function box(sx, sy, sz, m, x = 0, y = 0, z = 0) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
  g.position.set(x, y, z); g.castShadow = true; g.receiveShadow = true; return g;
}

// The street: a two-lane road along x with a zebra crossing at x = 0, pavements and houses.
{
  const g = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), M.ground); g.receiveShadow = true; g.position.z = -0.02; sim.add(g);
  const flat = (o) => { o.castShadow = false; sim.add(o); return o; };
  flat(box(260, 7, 0.04, M.road, 40, 0, 0));
  flat(box(260, 3.5, 0.04, M.walk, 40, 5.25, 0.001));
  flat(box(260, 3.5, 0.04, M.walk, 40, -5.25, 0.001));
  for (const y of [3.5, -3.5]) flat(box(260, 0.16, 0.05, M.kerb, 40, y, 0.005));
  for (let x = -90; x < 170; x += 6) if (Math.abs(x) > 4) flat(box(3, 0.12, 0.01, M.paint, x + 1.5, 0, 0.03));
  for (let y = -3.0; y <= 3.0; y += 0.9) flat(box(3.2, 0.45, 0.01, M.paint, 0, y, 0.031));  // the faixa de pedestre
  // houses along the far side only: the camera stands on the near pavement
  for (const side of [1])
    for (let i = -8; i < 16; ++i) {
      const x = i * 12, w = 10 + ((i * 7919) % 3), h = 6 + (((i + 4) * 31) % 7);
      sim.add(box(w, 8, h, M.house[(i + 12) % 6], x, side * 11.2, h / 2));
      sim.add(box(w + 0.4, 8.4, 0.3, M.roof, x, side * 11.2, h + 0.15));
      for (let f = 0; f < Math.floor(h / 3); ++f) for (let k = -1; k <= 1; k++) { const wm = box(1.2, 0.08, 1.1, M.win, x + k * w / 3.5, side * 7.17, 1.7 + f * 3); wm.castShadow = false; sim.add(wm); }
    }
}

{
  // trees on the near pavement (sim -y), for depth, well clear of the action
  const trunk = mat('#5b4636'), leaves = mat('#3f6b3a');
  for (let i = -6; i < 14; ++i) {
    const x = i * 11 + 5.5;
    if (Math.abs(x) < 9) continue;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.6, 8), trunk); t.rotation.x = Math.PI / 2; t.position.set(x, -6.2, 1.3); t.castShadow = true; sim.add(t);
    const c = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4, 1), leaves); c.position.set(x, -6.2, 3.3); c.castShadow = true; sim.add(c);
  }
}

// ---------- The car: its exterior as the engines see it, plus wheels ----------
const REGION_MAT = { bumper: M.plastic, grille: M.trim, bonnet: M.car, cowl: M.trim, windscreen: M.glass, a_pillar: M.carDark, roof_header: M.car, roof: M.tint, body: M.car };
let carGroup = null, crackTex = null;
function buildCar(run) {
  if (carGroup) { sim.remove(carGroup); carGroup.traverse((o) => o.geometry?.dispose()); }
  carGroup = new THREE.Group();
  carGroup.userData.front = [];
  run.parts.forEach((p, k) => {
    const m = box(p.half[0] * 2, p.half[1] * 2, p.half[2] * 2, REGION_MAT[p.region] ?? M.car, ...p.centre);
    if (run.frontParts[k]) carGroup.userData.front.push({ m, x: p.centre[0] });
    m.quaternion.set(p.q[1], p.q[2], p.q[3], p.q[0]);
    if (p.region === 'windscreen') m.castShadow = false;
    carGroup.add(m);
    if (p.region === 'roof') {  // the roof panel over the tinted side windows
      const top = box(p.half[0] * 2 + 0.02, p.half[1] * 2 + 0.02, 0.05, M.car, p.centre[0], p.centre[1], p.centre[2] + p.half[2] - 0.02);
      carGroup.add(top);
    }
  });
  const k = run.prof.key, ax = k.front - 0.95;
  for (const [x, y] of [[ax, k.half_width - 0.12], [ax, -k.half_width + 0.12], [-ax + 0.15, k.half_width - 0.12], [-ax + 0.15, -k.half_width + 0.12]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.22, 20), M.tyre); t.position.set(x, y, 0.31); t.castShadow = true; carGroup.add(t);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.23, 12), M.rim); r.position.copy(t.position); carGroup.add(r);
  }
  sim.add(carGroup);
}
function crackTexture() {
  if (crackTex) return crackTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.strokeStyle = 'rgba(235,245,255,.9)'; x.lineWidth = 2;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 16; ++i) {
    let a = (i / 16) * Math.PI * 2 + rnd() * 0.3, r = 6, px = 128, py = 128;
    x.beginPath(); x.moveTo(px, py);
    while (r < 125) { r += 10 + rnd() * 18; a += (rnd() - 0.5) * 0.35; px = 128 + Math.cos(a) * r; py = 128 + Math.sin(a) * r; x.lineTo(px, py); }
    x.stroke();
  }
  x.lineWidth = 1.2;
  for (const r of [18, 34, 55]) { x.beginPath(); for (let i = 0; i <= 24; ++i) { const a = (i / 24) * Math.PI * 2, rr = r + (rnd() - 0.5) * 6; x[i ? 'lineTo' : 'moveTo'](128 + Math.cos(a) * rr, 128 + Math.sin(a) * rr); } x.stroke(); }
  crackTex = new THREE.CanvasTexture(c); crackTex.colorSpace = THREE.SRGBColorSpace;
  return crackTex;
}
function crackAt(run, at, speed) {
  const ws = run.parts.find((p) => p.region === 'windscreen');
  if (!ws || !carGroup) return;
  const c = run.car, d = [at[0] - c.pos[0], at[1] - c.pos[1], at[2]];
  const local = rotZ(-c.yaw, d);
  const size = clamp(0.18 + speed * 0.03, 0.2, 0.6);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, depthWrite: false }));
  m.quaternion.set(ws.q[1], ws.q[2], ws.q[3], ws.q[0]);
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion);
  m.position.set(local[0] + n.x * 0.012, local[1] + n.y * 0.012, local[2] + n.z * 0.012);
  carGroup.add(m);
}

// ---------- The person: a capsule per segment ----------
const SEG_MAT = (name) => (name === 'head' ? M.skin : /hand|forearm/.test(name) ? M.skin : /foot/.test(name) ? M.shoe
  : /pelvis|thigh|shank/.test(name) ? M.trousers : M.shirt);
let pedMeshes = [];
function buildPerson(run) {
  for (const g of pedMeshes) { sim.remove(g); g.traverse((o) => o.geometry?.dispose()); }
  pedMeshes = [];
  if (run.ped < 0) return;
  const parts = run.pw.parts(run.ped);
  for (let s = 0; s < parts.length / 14; ++s) {
    const o = s * 14, a = [parts[o + 7], parts[o + 8], parts[o + 9]], b = [parts[o + 10], parts[o + 11], parts[o + 12]], r = parts[o + 13];
    const axis = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), L = axis.length();
    const name = run.pw.segmentName(s);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, L, 6, 14), SEG_MAT(name));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
    mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    mesh.castShadow = true;
    const g = new THREE.Group();
    g.add(mesh);
    if (name === 'head') {  // hair, to show which way the head faces
      const hair = new THREE.Mesh(new THREE.SphereGeometry(r * 1.04, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), M.hair);
      hair.rotation.x = Math.PI / 2; hair.position.set(b[0] - 0.012, b[1], b[2] - r * 0.15); hair.castShadow = true; g.add(hair);
    }
    sim.add(g);
    pedMeshes.push(g);
  }
}
function syncPerson(run) {
  if (run.ped < 0) return;
  const parts = run.pw.parts(run.ped);
  pedMeshes.forEach((g, s) => {
    const o = s * 14;
    g.position.set(parts[o], parts[o + 1], parts[o + 2]);
    g.quaternion.set(parts[o + 4], parts[o + 5], parts[o + 6], parts[o + 3]);
  });
}

// ---------- Street furniture: posts, panels and bars as Street Dynamics reports them ----------
const texCache = {};
function signTexture(kind, legend) {
  const key = kind + ':' + legend;
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), C = 128;
  const poly = (n, r, rot, fill, stroke, lw) => {
    x.beginPath(); for (let i = 0; i < n; ++i) { const a = rot + (i / n) * Math.PI * 2; x[i ? 'lineTo' : 'moveTo'](C + r * Math.cos(a), C + r * Math.sin(a)); }
    x.closePath(); if (fill) { x.fillStyle = fill; x.fill(); } if (stroke) { x.strokeStyle = stroke; x.lineWidth = lw; x.stroke(); }
  };
  x.textAlign = 'center'; x.textBaseline = 'middle';
  if (kind === 'octagon') { poly(8, 126, Math.PI / 8, '#c8102e'); poly(8, 112, Math.PI / 8, null, '#fff', 8); x.fillStyle = '#fff'; x.font = '900 70px Arial, sans-serif'; x.fillText(legend, C, C + 4); }
  else if (kind === 'circle') { x.fillStyle = '#fff'; x.beginPath(); x.arc(C, C, 126, 0, 7); x.fill(); x.strokeStyle = '#c8102e'; x.lineWidth = 26; x.beginPath(); x.arc(C, C, 110, 0, 7); x.stroke(); x.fillStyle = '#111'; x.font = '900 96px Arial, sans-serif'; x.fillText(legend, C, C + 4); x.font = '700 26px Arial'; x.fillText('km/h', C, C + 70); }
  else if (kind === 'diamond') { poly(4, 126, 0, '#f2c200'); poly(4, 110, 0, null, '#111', 8); x.fillStyle = '#111'; x.font = '900 120px Arial, sans-serif'; x.fillText(legend, C, C + 6); }
  else { x.fillStyle = '#1d4fa3'; x.fillRect(0, 0, 256, 256); x.strokeStyle = '#fff'; x.lineWidth = 10; x.strokeRect(10, 10, 236, 236); x.fillStyle = '#fff'; x.font = '800 56px Arial, sans-serif'; x.fillText(legend, C, C + 4); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  // the cylinder cap's uv runs round from the panel's +x; turn the face upright
  t.center.set(0.5, 0.5); t.rotation = -Math.PI / 2;
  return (texCache[key] = t);
}
// The square face texture of a non-square plate (street names are 2:1).
function plateTexture(legend, w, h) {
  const key = 'plate:' + legend + ':' + w + 'x' + h;
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas'); c.width = 512; c.height = Math.round(512 * h / w);
  const x = c.getContext('2d');
  x.fillStyle = '#1d4fa3'; x.fillRect(0, 0, c.width, c.height); x.strokeStyle = '#fff'; x.lineWidth = 12; x.strokeRect(12, 12, c.width - 24, c.height - 24);
  x.fillStyle = '#fff'; x.font = `800 ${Math.round(c.height * 0.42)}px Arial, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(legend, c.width / 2, c.height / 2 + 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.center.set(0.5, 0.5); t.rotation = Math.PI;  // the box's +y face runs its uv the other way up
  return (texCache[key] = t);
}
const POST_MAT = (type) => (type === 'bollard_cast_iron' ? M.cast : type === 'bollard_concrete' ? M.concrete : type === 'bollard_steel' ? M.yellow : M.galv);
let objMeshes = [];
function partMesh(type, kind, index, half) {
  if (kind === 1) {
    const pd = LIB[type]?.panels?.[index] ?? { shape: 'rect', legend: '' };
    const front = new THREE.MeshStandardMaterial({ map: null, roughness: 0.5 });
    if (pd.shape === 'rect') {
      front.map = plateTexture(pd.legend ?? '', half[0] * 2, half[2] * 2);
      const mats = [M.back, M.back, front, M.back, M.back, M.back];  // +y is the face
      return new THREE.Mesh(new THREE.BoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2), mats);
    }
    front.map = signTexture(pd.shape, pd.legend ?? '');
    const n = pd.shape === 'octagon' ? 8 : pd.shape === 'diamond' ? 4 : 32;
    const rot = pd.shape === 'octagon' ? Math.PI / 8 : 0;
    const R = half[0] / (pd.shape === 'octagon' ? Math.cos(Math.PI / 8) : 1);
    const g = new THREE.CylinderGeometry(R, R, half[1] * 2, n, 1, false, rot);
    // the cylinder's caps face +-y: the +y cap is the face; its uv runs over the square texture
    return new THREE.Mesh(g, [M.back, front, M.back]);
  }
  const m = new THREE.Mesh(new THREE.CylinderGeometry(half[0], half[0], half[2] * 2, 16), POST_MAT(type));
  m.rotation.x = Math.PI / 2;  // the cylinder's axis (y) along the part's z
  const g = new THREE.Group(); g.add(m); return g;
}
function buildObjects(run) {
  for (const o of objMeshes) for (const g of o.meshes) { sim.remove(g); g.traverse((m) => m.geometry?.dispose()); }
  objMeshes = run.objs.map((o) => {
    const parts = run.sw.parts(o.id), meshes = [];
    for (let k = 0; k < parts.length / 13; ++k) {
      const b = k * 13, g = partMesh(o.type, parts[b], parts[b + 1], [parts[b + 9], parts[b + 10], parts[b + 11]]);
      g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      sim.add(g); meshes.push(g);
    }
    return { id: o.id, meshes };
  });
  syncObjects(run);
}
function syncObjects(run) {
  for (const o of objMeshes) {
    const parts = run.sw.parts(o.id);
    o.meshes.forEach((g, k) => {
      const b = k * 13;
      g.position.set(parts[b + 2], parts[b + 3], parts[b + 4]);
      g.quaternion.set(parts[b + 6], parts[b + 7], parts[b + 8], parts[b + 5]);
    });
  }
}
function syncCar(run) {
  if (!carGroup) return;
  carGroup.position.set(run.car.pos[0], run.car.pos[1], 0);
  carGroup.rotation.set(0, 0, run.car.yaw);
  for (const f of carGroup.userData.front) f.m.position.x = f.x - run.car.crush;
}

// ---------- Readouts ----------
const JOINT = { abdomen: 'lower back', thorax: 'upper back', head: 'neck', thigh: 'hip', shank: 'knee', foot: 'ankle', upperarm: 'shoulder', forearm: 'elbow', hand: 'wrist' };
const jointName = (seg) => { const [base, side] = seg.split('_'); return (side ? (side === 'l' ? 'left ' : 'right ') : '') + (JOINT[base] ?? base); };
const searle = (v) => [v * v / (2 * 0.66 * G), v * v * (1 + 0.66 * 0.66) / (2 * 0.66 * G)];
const rate = (v, warn, bad) => (v >= bad ? 'bad' : v >= warn ? 'warn' : 'good');
function setKv(id, text, cls = '') { const e = $(id); e.textContent = text; e.className = cls; }
let log = [], evCount = 0;
function addLog(t, text) {
  log.push(`${t >= 0 ? '+' : ''}${(t * 1000).toFixed(0).padStart(5)} ms  ${text}`);
  if (log.length > 120) log.shift();
  evCount++;
}
function onEvents(run, pedEv, strEv) {
  const t0 = run.hitT ?? run.t;
  const tt = () => run.t - t0;
  for (const e of pedEv) {
    const seg = run.pw.segmentName(e.part) ?? '?';
    if (e.name === 'VEHICLE_CONTACT') addLog(tt(), `the ${e.region} meets the ${seg.replace('_l', ' (left)').replace('_r', ' (right)')} at ${e.value.toFixed(1)} m/s`);
    else if (e.name === 'HEAD_IMPACT') {
      addLog(tt(), `head strikes the ${e.region} at ${e.value.toFixed(1)} m/s`);
      if (e.region === 'windscreen' && e.value > 3) crackAt(run, e.at, e.value);
      if (e.region !== 'ground' && !run.headShown) { run.headShown = true; banner('Head on the ' + e.region, `${e.value.toFixed(1)} m/s · ${(tt() * 1000).toFixed(0)} ms after the bumper`); }
    } else if (e.name === 'LIGAMENT_TEAR') addLog(tt(), `${jointName(seg)} ligaments tear (${fmt(e.value)} N·m)`);
    else if (e.name === 'LANDED') addLog(tt(), `lands after ${e.value.toFixed(2)} s in the air`);
    else if (e.name === 'AT_REST') {
      const r = run.pw.report(run.ped);
      addLog(tt(), `comes to rest ${e.value.toFixed(1)} m from the impact (${r.trajectory})`);
      banner(`Thrown ${e.value.toFixed(1)} m`, `${r.trajectory} · HIC ${fmt(Math.max(r.hicVehicle, r.hicGround))}`);
    }
  }
  for (const e of strEv) {
    const o = run.objs.find((x) => x.id === e.object), name = o ? OBJ_NAME[o.type] : 'object';
    const text = {
      OBJECT_HIT: `${name}: struck (${fmt(e.value)} N·s)`, POST_BENT: `${name}: the post bends`, POST_DOWN: `${name}: down`,
      POST_BROKEN: `${name}: the post breaks${e.value > 0.01 ? ` (${e.value.toFixed(2)} m up)` : ''}`, BASE_RELEASED: `${name}: the base lets go`,
      PANEL_DETACHED: `${name}: a plate tears off its clamps`, PANEL_LANDED: `${name}: a plate lands`, DEBRIS_HIT_BODY: `${name}: a loose part strikes the car`,
    }[e.name];
    if (text) addLog(tt(), text);
    if (e.name === 'POST_BROKEN' || e.name === 'BASE_RELEASED') banner(name + (e.name === 'BASE_RELEASED' ? ': breakaway' : ': broken'), `${(tt() * 1000).toFixed(0)} ms`);
  }
}
function readouts(run) {
  $('clock').innerHTML = `${run.t.toFixed(2)} s<small>SIM TIME · ${run.pw.stats().awake ? '960 Hz INSIDE' : 'AT REST'}</small>`;
  setKv('r-impact', run.impactSpeed != null ? `${fmt(run.impactSpeed * 3.6, 1)} km/h` : '–');
  setKv('r-dv', run.impactSpeed != null ? `${fmt(run.dvHit * 3.6, 1)} km/h` : '–');
  setKv('r-decel', run.impactSpeed != null ? `${fmt(run.peakDecel, 1)} g` : '–', run.peakDecel > 10 ? 'bad' : run.peakDecel > 4 ? 'warn' : '');
  setKv('r-stop', run.stopT != null && run.hitT != null ? `${fmt(run.stopT - run.hitT, 2)} s` : '–');
  setKv('r-crush', run.car.crush > 0.005 ? `${fmt(run.car.crush * 100)} cm` : run.impactSpeed != null ? 'none' : '–');
  $('res-person').hidden = run.ped < 0;
  $('res-object').hidden = run.objs.length === 0;
  let text = 'Press Drive.', cls = '';
  if (run.ped >= 0) {
    const r = run.pw.report(run.ped);
    $('who-label').textContent = WHO[run.c.who].label;
    setKv('r-traj', r.struck ? r.trajectory + (r.atRest ? '' : '…') : '–');
    setKv('r-throw', r.atRest ? `${fmt(r.throwDistance, 1)} m` : r.struck ? 'in motion' : '–');
    const v = run.impactSpeed ?? run.c.speed / 3.6, [lo, hi] = searle(v), top = Math.max(hi * 1.5, r.throwDistance * 1.1, 1);
    $('band-rng').style.left = `${(100 * lo) / top}%`; $('band-rng').style.width = `${(100 * (hi - lo)) / top}%`;
    $('band-mark').style.left = `${(100 * (r.atRest ? r.throwDistance : 0)) / top}%`; $('band-mark').hidden = !r.atRest;
    $('band-lo').textContent = `${lo.toFixed(1)}`; $('band-lo').style.left = `calc(${(100 * lo) / top}% + 3px)`; $('band-hi').textContent = `${hi.toFixed(1)} m`;
    setKv('r-head', r.headRegion ? `${r.headRegion}, ${r.headImpactSpeed.toFixed(1)} m/s at ${(r.headImpactTime * 1000).toFixed(0)} ms` : r.struck ? 'no hard strike' : '–');
    setKv('r-hicv', r.struck ? fmt(r.hicVehicle) : '–', r.struck ? rate(r.hicVehicle, 700, 1000) : '');
    setKv('r-hicg', r.struck ? fmt(r.hicGround) : '–', r.struck ? rate(r.hicGround, 700, 1000) : '');
    setKv('r-headg', r.struck ? `${fmt(r.headPeakG)} g` : '–');
    setKv('r-tibia', r.struck ? `${fmt(r.tibiaG[0])} / ${fmt(r.tibiaG[1])} g` : '–', r.struck ? rate(Math.max(...r.tibiaG), 150, 250) : '');
    setKv('r-knee', r.struck ? `${fmt(r.kneeBendDeg[0])}° / ${fmt(r.kneeBendDeg[1])}°` : '–', r.struck ? rate(Math.max(...r.kneeBendDeg), 15, 25) : '');
    const torn = [];
    for (let s = 1; s < run.pw.segmentCount(); ++s) if (r.torn & (1 << s)) torn.push(jointName(run.pw.segmentName(s)));
    setKv('r-torn', r.struck ? (torn.length ? torn.join(', ') : 'none') : '–', torn.length ? 'warn' : '');
    setKv('r-carry', r.struck ? `${fmt(r.carryTime, 2)} s` : '–');
    setKv('r-air', r.struck ? `${fmt(r.airTime, 2)} s` : '–');
    setKv('r-pelvis', r.struck ? `${fmt(r.maxPelvisHeight, 2)} m` : '–');
    if (r.struck) {
      const hic = Math.max(r.hicVehicle, r.hicGround);
      text = `${r.trajectory[0].toUpperCase() + r.trajectory.slice(1)}${r.atRest ? `: thrown ${fmt(r.throwDistance, 1)} m.` : '…'}`;
      if (r.headRegion) text += ` Head on the ${r.headRegion} at ${r.headImpactSpeed.toFixed(1)} m/s.`;
      text += ` HIC ${fmt(hic)}.`;
      cls = hic >= 1000 ? 'bad' : hic >= 500 || torn.length ? 'warn' : 'ok';
    }
  }
  if (run.objs.length) {
    const rows = run.objs.map((o, i) => {
      const s = run.sw.object(o.id);
      const sc = s.state === 'INTACT' ? 'good' : s.state === 'BENT' ? 'warn' : 'bad';
      const extra = s.stubHeight > 0.001 ? `, stub ${(s.stubHeight * 100).toFixed(0)} cm` : '';
      return `<span>${OBJ_NAME[o.type]}${run.objs.length > 1 ? ' ' + (i + 1) : ''}</span><b class="${sc}">${s.state.toLowerCase()}, ${s.tiltDeg.toFixed(0)}°${extra}</b>`;
    });
    $('r-objects').innerHTML = rows.join('');
    if (run.ped < 0 && run.impactSpeed != null) {
      const s = run.sw.object(run.objs[0].id);
      text = `${OBJ_NAME[run.objs[0].type]}: ${s.state.toLowerCase()}. The car lost ${fmt(run.dvHit * 3.6, 1)} km/h to it.`;
      cls = s.state === 'INTACT' ? 'ok' : s.state === 'BENT' ? 'warn' : 'bad';
    }
  }
  const o = $('outcome'); o.textContent = text; o.className = cls;
  $('log').textContent = log.join('\n'); $('log').scrollTop = 1e9;
  $('evcount').textContent = String(evCount);
  const ps = run.pw.stats(), ss = run.sw.stats();
  $('s-ped').textContent = `${ps.awake} awake · ${ps.lastStepMs.toFixed(3)} ms`;
  $('s-street').textContent = `${ss.awake} awake · ${ss.lastStepMs.toFixed(3)} ms`;
  $('hash').textContent = run.hash();
}
function chart(run) {
  const c = $('chart-speed'), x = c.getContext('2d'), W = c.width, H = c.height, pad = 30, h = run.hist;
  x.clearRect(0, 0, W, H);
  if (h.t.length < 2) return;
  const t0 = h.t[0], t1 = h.t[h.t.length - 1];
  let vmax = 10; for (const k of ['car', 'pelvis', 'head']) for (const v of h[k]) vmax = Math.max(vmax, v);
  vmax = 10 * Math.ceil(vmax / 10);
  x.font = '18px JetBrains Mono, monospace'; x.fillStyle = '#93a0b2'; x.strokeStyle = 'rgba(255,255,255,.08)';
  for (let k = 0; k <= 4; ++k) { const y = H - pad - ((H - pad - 10) * k) / 4; x.beginPath(); x.moveTo(pad + 18, y); x.lineTo(W, y); x.stroke(); x.fillText(String(Math.round((vmax * k) / 4)), 0, y + 6); }
  x.fillText(`${(t1 - t0).toFixed(1)} s`, W - 90, H - 4);
  const series = [['car', '#9fd6ff'], ['pelvis', '#ffd36b'], ['head', '#ef5d4f']];
  for (const [k, col] of series) {
    if (k !== 'car' && run.ped < 0) continue;
    x.strokeStyle = col; x.lineWidth = 2.4; x.beginPath();
    h[k].forEach((v, i) => { const px = pad + 18 + ((W - pad - 18) * (h.t[i] - t0)) / Math.max(t1 - t0, 1e-6), py = H - pad - ((H - pad - 10) * v) / vmax; i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.stroke();
  }
  if (run.hitT != null) { const px = pad + 18 + ((W - pad - 18) * (run.hitT - t0)) / Math.max(t1 - t0, 1e-6); x.strokeStyle = 'rgba(255,255,255,.35)'; x.setLineDash([6, 6]); x.beginPath(); x.moveTo(px, 10); x.lineTo(px, H - pad); x.stroke(); x.setLineDash([]); }
}

// ---------- Camera ----------
const orbit = { target: new THREE.Vector3(), r: 12, th: 0.25, ph: 1.3 };
let camMode = 'side', userCam = false;
function placeCamera() {
  orbit.ph = clamp(orbit.ph, 0.1, 1.53); orbit.r = clamp(orbit.r, 2, 160);
  const t = orbit.target;
  camera.position.set(t.x + orbit.r * Math.sin(orbit.ph) * Math.sin(orbit.th), t.y + orbit.r * Math.cos(orbit.ph), t.z + orbit.r * Math.sin(orbit.ph) * Math.cos(orbit.th));
  camera.lookAt(t);
}
function focusPoint(run) {
  if (run.ped >= 0) { const p = run.pw.parts(run.ped); return [p[0], p[1], Math.max(0.6, p[2])]; }
  if (run.objs.length) { const p = run.sw.parts(run.objs[0].id); return [p[2], p[3], 1.0]; }
  return [0, 0, 1];
}
function setCam(mode) {
  camMode = mode; userCam = false;
  document.querySelectorAll('.top [id^=cam-]').forEach((b) => b.setAttribute('aria-pressed', String(b.id === 'cam-' + mode)));
  if (mode === 'side') Object.assign(orbit, { r: 13, th: 0.32, ph: 1.32 });
  if (mode === 'top') Object.assign(orbit, { r: 34, th: 0, ph: 0.18 });
  if (mode === 'follow') Object.assign(orbit, { r: 7.5, th: -0.55, ph: 1.22 });
  if (mode === 'chase') Object.assign(orbit, { r: 9, th: -Math.PI / 2 + 0.25, ph: 1.2 });
  aim(1);
}
function aim(k) {
  if (!run) return;
  let p;
  if (camMode === 'chase') { const c = run.car.pos; p = [c[0], c[1], 1.0]; }
  else if (camMode === 'follow') p = focusPoint(run);
  else {
    // side and above: frame the car's nose and the person or object together
    const f = focusPoint(run), nose = run.car.pos[0] + run.prof.key.front;
    const a = Math.min(nose, f[0]), b = Math.max(nose, f[0]);
    const lo = run.hitT == null ? Math.max(a, f[0] - 8) : a;
    p = [(lo + b) / 2, f[1] * 0.5, 0.9];
    if (!userCam) {
      const narrow = Math.max(0.55, Math.min(1, camera.aspect / 1.5));
      const want = Math.max(camMode === 'top' ? 30 : 12, ((b - lo) * 0.95 + 5) / narrow);
      orbit.r += (want - orbit.r) * k;
    }
  }
  orbit.target.lerp(toScene(p), k);
  placeCamera();
}
{
  const ptrs = new Map(); let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => { userCam = true; canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey }); canvas.style.cursor = 'grabbing'; });
  canvas.addEventListener('pointerup', (e) => { ptrs.delete(e.pointerId); pinch = 0; canvas.style.cursor = 'grab'; });
  canvas.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); pinch = 0; });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) orbit.r *= pinch / d; pinch = d; placeCamera(); return; }
    if (p.b === 2 || p.shift) {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0), fwd = new THREE.Vector3(-right.z, 0, right.x);
      orbit.target.addScaledVector(right, -dx * orbit.r * 0.0016).addScaledVector(fwd, dy * orbit.r * 0.0016);
    } else { orbit.th -= dx * 0.006; orbit.ph -= dy * 0.005; }
    placeCamera();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.r *= Math.exp(e.deltaY * 0.001); placeCamera(); }, { passive: false });
}
for (const m of ['side', 'top', 'follow', 'chase']) $('cam-' + m).addEventListener('click', () => setCam(m));

// ---------- Controls ----------
function showControls() {
  for (const id of ['vehicle', 'who', 'facing', 'object', 'target']) $(id).value = cfg[id];
  $('speed').value = cfg.speed; $('v-speed').textContent = `${cfg.speed} km/h`;
  $('offset').value = cfg.offset; $('v-offset').textContent = Math.abs(cfg.offset) < 0.05 ? 'centre' : `${Math.abs(cfg.offset).toFixed(1)} m ${cfg.offset > 0 ? 'left' : 'right'}`;
  $('brake').checked = cfg.brake;
  $('person-box').hidden = cfg.target === 'object';
  $('object-box').hidden = cfg.target === 'person';
}
for (const id of ['vehicle', 'who', 'facing', 'object', 'target']) $(id).addEventListener('change', () => { cfg[id] = $(id).value; store.set('cfg', cfg); showControls(); reset(); });
$('speed').addEventListener('input', () => { cfg.speed = +$('speed').value; store.set('cfg', cfg); showControls(); });
$('offset').addEventListener('input', () => { cfg.offset = +$('offset').value; store.set('cfg', cfg); showControls(); });
$('offset').addEventListener('change', () => reset());
$('brake').addEventListener('change', () => { cfg.brake = $('brake').checked; store.set('cfg', cfg); });
$('presets').innerHTML = PRESETS.map((p, i) => `<button data-i="${i}"><b>${p.name}</b><small>${p.sub}</small></button>`).join('');
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  cfg = { ...DEFAULT, ...PRESETS[+b.dataset.i].c, brake: cfg.brake };
  store.set('cfg', cfg); showControls(); drive();
});
let scale = store.get('scale', 0.25), paused = false;
function setScale(s) { scale = s; store.set('scale', s); document.querySelectorAll('#scale button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.scale === s))); }
$('scale').addEventListener('click', (e) => { const b = e.target.closest('button[data-scale]'); if (b) setScale(+b.dataset.scale); });
setScale(scale);
$('btn-pause').addEventListener('click', () => { paused = !paused; $('btn-pause').textContent = paused ? 'Play' : 'Pause'; });
$('btn-reset').addEventListener('click', () => reset());
$('hit').addEventListener('click', () => drive());
$('btn-help').addEventListener('click', () => $('help').classList.add('on'));
$('help-close').addEventListener('click', () => $('help').classList.remove('on'));
$('help').addEventListener('click', (e) => { if (e.target.id === 'help') $('help').classList.remove('on'); });
$('tab-lab').addEventListener('click', () => { $('lab').hidden = false; $('res').hidden = true; $('tab-lab').setAttribute('aria-pressed', 'true'); $('tab-res').setAttribute('aria-pressed', 'false'); });
$('tab-res').addEventListener('click', () => { $('lab').hidden = true; $('res').hidden = false; $('tab-lab').setAttribute('aria-pressed', 'false'); $('tab-res').setAttribute('aria-pressed', 'true'); });
if (matchMedia('(max-width:860px)').matches) $('res').hidden = true;
$('btn-replay').addEventListener('click', () => {
  if (!run) return;
  // The same set-up, run again from the start for as many steps: the state hash must match.
  const again = new Run(run.c);
  for (let k = 0; k < run.steps; ++k) { again.step(); again.pw.events(); again.sw.events(); }
  const same = again.hash() === run.hash();
  toast(same ? `Replayed ${run.steps} steps: identical, ${run.hash()}` : `Replay differs: ${again.hash()} vs ${run.hash()}`);
  again.destroy();
});

// ---------- Running ----------
let run = null, started = false;
function reset() {
  run?.destroy();
  run = new Run(cfg);
  started = false;
  log = []; evCount = 0;
  buildCar(run); buildPerson(run); buildObjects(run);
  syncCar(run); syncPerson(run);
  readouts(run); chart(run);
  aim(1);
}
function drive() {
  reset();
  started = true;
  paused = false; $('btn-pause').textContent = 'Pause';
  setCam(camMode === 'top' ? 'top' : camMode === 'chase' ? 'chase' : 'side');
  if (matchMedia('(max-width:860px)').matches) { $('lab').hidden = true; $('res').hidden = true; clearTimeout(drive.h); drive.h = setTimeout(() => $('tab-res').click(), 6000); }
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  if (w <= 860) camera.setViewOffset(w, h, 0, h * 0.2, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
showControls();
setCam('side');
reset();
$('loading').remove();
if (!store.get('seenHelp', false)) { store.set('seenHelp', true); toast('Pick a scenario on the left, or set up the car and press Drive.'); }

let last = performance.now(), acc = 0, frame = 0;
function loop(now) {
  const real = Math.min((now - last) / 1000, 0.1); last = now;
  if (started && !paused && !run.done) acc += real * scale;
  let n = 0;
  while (acc >= DT && n < 6) {
    run.step();
    onEvents(run, run.pw.events(), run.sw.events());
    acc -= DT; n++;
  }
  if (run.done) acc = 0;
  syncCar(run); syncPerson(run); syncObjects(run);
  if (!userCam) aim(Math.min(1, real * 3));
  sun.position.copy(orbit.target).add(new THREE.Vector3(18, 40, 14)); sun.target.position.copy(orbit.target);
  if (++frame % 4 === 0) { readouts(run); chart(run); }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
