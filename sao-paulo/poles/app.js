// São Paulo World — Pole Lab.
// A residential street of 11 m concrete poles; a car hits one. Everything is
// simulated by Pole Dynamics (the game's native C++ module, WebAssembly build:
// poles.wasm). This page builds the street from the world builder's seed
// rules, drives the car up to the pole, reports the hit, steps the world at
// 60 Hz and draws what it says. Sim frame: x east, y north, z up (metres);
// the scene puts it under one group turned to three.js's Y-up.
import * as THREE from 'three';
import createPoleModule from './poles.mjs';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DT = 1 / 60;
const N_POLES = 6, SPACING = 35;
const fmt = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw-poles:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw-poles:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3200); }
function banner(title, sub = '') {
  $('banner-t').textContent = title; $('banner-s').textContent = sub;
  const b = $('banner'); b.classList.add('on'); clearTimeout(banner.h); banner.h = setTimeout(() => b.classList.remove('on'), 2200);
}

// ---------- Configuration ----------
const NOMINAL = [600, 600, 1000, 1500];  // daN, NBR 8451 rating per class
const DEFAULTS = { speed: 80, height: 0.5, yaw: 0, mass: 1300, target: 2, cls: 0, txTarget: false, txFar: true, wet: 0,
  soil: 50, nominal: 600, clamp: 1, trip: 0, crush: 400 };
const PRESETS = [
  { name: '30 km/h · crack', note: 'The section cracks; the pole stays up with a small tilt.', cfg: { speed: 30 } },
  { name: '50 km/h · lean', note: 'The soil yields: the pole is left leaning about 7°.', cfg: { speed: 50 } },
  { name: '80 km/h · snap', note: 'Sheared at the bumper; the top hangs in its wires.', cfg: { speed: 80 } },
  { name: '100 km/h · line down', note: 'The top falls and drags the line down: wires snap, live 13.8 kV on the road arcs, lanes blocked, lights out.', cfg: { speed: 100 } },
  { name: 'Transformer pole · 60 km/h', note: 'The 350 kg tank tears off its brackets; its section loses power.', cfg: { speed: 60, txTarget: true } },
  { name: 'Rainy season · 90 km/h', note: 'Saturated ground: softer, weaker soil.', cfg: { speed: 90, wet: 1 } },
  { name: 'Domino (art-directed)', note: 'Weak soil and strong ties: the wires hold and pull the neighbours over. Not the default physics.', cfg: { speed: 110, soil: 15, clamp: 4, wet: 1 } },
];
let cfg = { ...DEFAULTS, ...store.get('cfg', {}) };

// ---------- The module ----------
let P;
try {
  P = await createPoleModule();
} catch (e) {
  $('loadMsg').textContent = 'Could not load the simulation: ' + e.message;
  throw e;
}

function seedInfo(x, y, cls) {
  const s = P.poleSeed(x, y);
  return { id: s, transformer: s % 100 < 14, light: Math.floor(s / 100) % 100 < [55, 70, 85, 95][cls],
    telecom: 4 + cls * 2 + Math.floor(s / 10000) % 5, drops: Math.floor(s / 100000) % 4 };
}

// The street: poles running east at 35 m, nudged by decimetres (as the tests do)
// until the seeds give transformers exactly where asked.
function streetTile(c) {
  const poles = [], spans = [];
  for (let i = 0; i < N_POLES; ++i) {
    const want = (i === c.target && c.txTarget) || (i === 5 && c.txFar && c.target !== 5);
    let x = i * SPACING, y = 0;
    for (let k = 0; k < 400; ++k) {
      const xx = Math.round((i * SPACING + 0.1 * (k % 20) - 1.0) * 10) / 10, yy = Math.round(0.1 * Math.floor(k / 20) * 10) / 10;
      if (seedInfo(xx, yy, c.cls).transformer === want) { x = xx; y = yy; break; }
    }
    poles.push([x, y, 90, c.cls]);
  }
  for (let i = 0; i + 1 < N_POLES; ++i) spans.push([poles[i][0], poles[i][1], poles[i + 1][0], poles[i + 1][1]]);
  return { json: JSON.stringify({ tile: 'T_p0_p0', v: 1, poles, spans }), poles };
}
// The road (lanes tile T_p0_p0, 0.5 m pixels from the tile's north-west corner):
// two 3.2 m lanes, the kerb 0.5 m south of the pole line.
const ROAD_Y = -3.7;
function lanesTile() {
  const px = (x) => (x + 250) * 2, py = (y) => (250 - y) * 2;
  return JSON.stringify({ t: 'T_p0_p0', e: [[0, 1, 1, 50, 3, px(-60), py(ROAD_Y), px(SPACING * N_POLES + 60), py(ROAD_Y)]], n: [], k: {} });
}

// ---------- A run: the world, the car, the clock (also used to replay) ----------
const CAR = { length: 4.4, width: 1.8, height: 1.45 };
class Run {
  constructor(c) {
    this.cfg = { ...c };
    this.w = P.world(1);
    const t = streetTile(c);
    this.tile = t.json;
    this.spec = t.poles.map(([x, y]) => seedInfo(x, y, c.cls));
    if (this.w.loadTile(this.tile) !== N_POLES) throw new Error('load: ' + this.w.error());
    this.w.loadLanes(lanesTile());
    this.w.setWetness(c.wet);
    this.w.setParam('soil.yield', c.soil * 1000);
    this.w.setParam('strength.nominal.' + c.cls, c.nominal * 10);
    this.w.setParam('wire.mv.clamp', 8000 * c.clamp);
    this.w.setParam('wire.lv.clamp', 4000 * c.clamp);
    this.w.setParam('wire.telecom.clamp', 5000 * c.clamp);
    this.w.setParam('wire.drop.clamp', 800 * c.clamp);
    this.w.setParam('sim.mv_trip_time', c.trip);
    this.w.setParam('sim.car_crush_stiffness', c.crush * 1000);
    this.ids = this.w.poleIds();
    this.steps = 0;
    this.car = null;
    this.launchStep = -1;
    this.result = null;
    for (let i = 0; i < 30; ++i) this.tick(true);  // settle, as the tests do
  }
  launch() {
    const c = this.cfg, yaw = c.yaw * Math.PI / 180;
    const n = [Math.sin(yaw), Math.cos(yaw)];
    const base = this.w.pole(this.ids[c.target]).piece[0].position;
    const contact = [base[0] - n[0] * 0.15, base[1] - n[1] * 0.15];
    const v = c.speed / 3.6, lead = CAR.length / 2 + v * 1.2;
    this.car = { n, v, contact, pos: [contact[0] - n[0] * lead, contact[1] - n[1] * lead], phase: 'approach', hitAt: 0 };
    this.launchStep = this.steps;
  }
  tick(quiet = false) {
    const car = this.car;
    if (car) {
      const front = () => (car.pos[0] + car.n[0] * CAR.length / 2 - car.contact[0]) * car.n[0] + (car.pos[1] + car.n[1] * CAR.length / 2 - car.contact[1]) * car.n[1];
      if (car.phase === 'approach') {
        car.pos[0] += car.n[0] * car.v * DT; car.pos[1] += car.n[1] * car.v * DT;
        if (front() >= 0) {
          car.pos[0] -= car.n[0] * front(); car.pos[1] -= car.n[1] * front();
          const c = this.cfg, v = c.speed / 3.6;
          this.result = this.w.impact({ point: [car.contact[0], car.contact[1], c.height], normal: [car.n[0], car.n[1], 0],
            velocity: [car.n[0] * v, car.n[1] * v, 0], mass: c.mass, crushStiffness: c.crush * 1000 });
          car.v = Math.max(0, v - this.result.deltaV);
          if (!this.result.broke) car.v = 0;
          car.phase = 'after'; car.hitAt = this.steps;
        }
      } else if (car.v > 0) {
        car.pos[0] += car.n[0] * car.v * DT; car.pos[1] += car.n[1] * car.v * DT;
        car.v = Math.max(0, car.v - 9 * DT);  // wrecked front, braking, scraping over the stub
        if (car.pos[1] + Math.abs(car.n[1]) * CAR.length / 2 > 10.5) car.v = 0;  // the house fronts
      }
      const h = CAR.length / 2 - 0.95;
      this.w.setBodies([{ id: 1, a: [car.pos[0] - car.n[0] * h, car.pos[1] - car.n[1] * h, 0.75],
        b: [car.pos[0] + car.n[0] * h, car.pos[1] + car.n[1] * h, 0.75], radius: 0.85,
        velocity: [car.n[0] * car.v, car.n[1] * car.v, 0] }]);
    }
    this.w.step(DT);
    this.steps++;
    return quiet ? this.w.events() : null;
  }
  destroy() { this.w.destroy(); }
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
scene.fog = new THREE.Fog('#9cb9d6', 120, 420);
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1200);
scene.add(new THREE.HemisphereLight('#dfeaf5', '#5d5348', 1.1));
const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 300 });
scene.add(sun, sun.target);

// Everything below is placed in sim coordinates (z up).
const sim = new THREE.Group();
sim.rotation.x = -Math.PI / 2;
scene.add(sim);
const toScene = (p) => new THREE.Vector3(p[0], p[2], -p[1]);

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...o });
const M = {
  ground: mat('#6f7a5d'), road: mat('#3b3e43', { roughness: 0.95 }), walk: mat('#a9a49a'), kerb: mat('#c9c4b8'),
  concrete: mat('#b9b3a7'), steel: mat('#6c7278', { metalness: 0.5, roughness: 0.5 }), porcelain: mat('#e9e4d8', { roughness: 0.3 }),
  tank: mat('#7c8a86', { metalness: 0.3, roughness: 0.55 }), car: mat('#c8332b', { metalness: 0.4, roughness: 0.4 }),
  glass: mat('#1d2733', { metalness: 0.2, roughness: 0.15 }), tyre: mat('#151515'), paint: mat('#e9e6dc', { roughness: 0.7 }),
  lampOn: mat('#fff3c4', { emissive: '#ffd982', emissiveIntensity: 2.2 }), lampOff: mat('#565a5e'),
  winOn: mat('#ffdf9a', { emissive: '#ffc864', emissiveIntensity: 0.9 }), winOff: mat('#2a3038', { roughness: 0.3 }),
  house: [mat('#d8c8a9'), mat('#c99a83'), mat('#b9c4b0'), mat('#d1b4a0'), mat('#c4c0b4'), mat('#d9cfb9')], roof: mat('#8b5a44'),
};
function box(sx, sy, sz, m, x = 0, y = 0, z = 0) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
  g.position.set(x, y, z); g.castShadow = true; g.receiveShadow = true; return g;
}
function cyl(r, h, m, x = 0, y = 0, z = 0) {  // axis along sim z
  const g = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), m);
  g.rotation.x = Math.PI / 2; g.position.set(x, y, z); g.castShadow = true; return g;
}

// Ground, road and sidewalk.
const X0 = -60, X1 = SPACING * N_POLES + 60;
{
  const g = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), M.ground); g.receiveShadow = true; g.position.z = -0.02; sim.add(g);
  const road = box(X1 - X0, 6.4, 0.04, M.road, (X0 + X1) / 2, ROAD_Y, 0); road.castShadow = false; sim.add(road);
  // The simulation's ground is flat at z = 0, so the sidewalks are too (a raised
  // kerb would hide wires lying on them).
  const south = box(X1 - X0, 3, 0.04, M.walk, (X0 + X1) / 2, ROAD_Y - 3.2 - 1.5, 0.0); south.castShadow = false; sim.add(south);
  const north = box(X1 - X0, 11, 0.04, M.walk, (X0 + X1) / 2, -0.5 + 5.5, 0.0); north.castShadow = false; sim.add(north);
  for (const y of [-0.5, ROAD_Y - 3.2]) { const k = box(X1 - X0, 0.18, 0.05, M.kerb, (X0 + X1) / 2, y, 0.005); k.castShadow = false; sim.add(k); }
  for (let x = X0; x < X1; x += 6) sim.add(box(3, 0.12, 0.01, M.paint, x + 1.5, ROAD_Y, 0.03));
  // A cross street beyond the last pole, so the road goes somewhere.
  sim.add(box(9, 120, 0.04, M.road, SPACING * N_POLES + 30, ROAD_Y, 0.005));
}
// Lane overlays (blocked lanes light up).
const laneOverlay = [0, 1].map((lane) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(X1 - X0, 3.1), new THREE.MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0, depthWrite: false }));
  m.position.set((X0 + X1) / 2, -0.5 - 1.6 - 3.2 * lane, 0.03); sim.add(m); return m;
});
// Houses north of the poles, fed by the service drops.
const houses = [];
for (let i = -1; i <= N_POLES; ++i) {
  const x = i * SPACING + 17.5, wdt = 14 + (i * 7919 % 5), hgt = 6.5 + ((i + 3) * 31 % 4);
  const h = new THREE.Group();
  h.add(box(wdt, 9, hgt, M.house[(i + 6) % 6], x, 16.5, hgt / 2));
  h.add(box(wdt + 0.6, 9.6, 0.4, M.roof, x, 16.5, hgt + 0.2));
  const wins = [];
  for (let f = 0; f < Math.floor(hgt / 3); ++f)
    for (let k = -2; k <= 2; k++) { const wm = box(1.3, 0.1, 1.2, M.winOn, x + k * wdt / 5.5, 11.97, 1.6 + f * 3); wm.castShadow = false; h.add(wm); wins.push(wm); }
  sim.add(h);
  houses.push({ x, wins });
}

// The car.
const carMesh = new THREE.Group();
{
  carMesh.add(box(CAR.length, CAR.width, 0.7, M.car, 0, 0, 0.62));
  carMesh.add(box(2.2, 1.64, 0.5, M.glass, -0.25, 0, 1.2));
  carMesh.add(box(2.0, 1.66, 0.06, M.car, -0.3, 0, 1.46));
  for (const [x, y] of [[1.35, 0.8], [1.35, -0.8], [-1.35, 0.8], [-1.35, -0.8]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.24, 18), M.tyre); t.position.set(x, y, 0.32); t.castShadow = true; carMesh.add(t);
  }
  carMesh.visible = false;
  sim.add(carMesh);
}

// A pole piece: the shaft from z0 to z1 and the hardware in that stretch, with
// its origin on the axis at z0 (how Pole Dynamics reports a piece's pose).
// Pole frame: x along the line, y left (the street is -y), z up.
function taper(z) { return 1 - 0.55 * clamp(z / 11, 0, 1); }
function shaft(z0, z1) {
  const a = taper(Math.max(z0, 0)), b = taper(Math.max(z1, 0)), W = 0.26 / 2, D = 0.30 / 2;
  const v = [];
  for (const [s, z] of [[a, z0], [b, z1]]) for (const [x, y] of [[-W, -D], [W, -D], [W, D], [-W, D]]) v.push(x * s, y * s, z);
  const idx = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7, 0, 3, 2, 0, 2, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.setIndex(idx);
  const ng = g.toNonIndexed(); ng.computeVertexNormals();
  const m = new THREE.Mesh(ng, M.concrete); m.castShadow = true; m.receiveShadow = true; return m;
}
function buildPiece(z0, z1, spec, lit) {
  const outer = new THREE.Group(), g = new THREE.Group();
  g.position.z = -z0; outer.add(g);
  g.add(shaft(z0, z1));
  const inside = (z) => z >= z0 - 1e-6 && z <= z1 + 1e-6;
  if (inside(10.55)) {
    g.add(box(0.09, 2.75, 0.09, M.steel, 0.12, 0.52, 10.55));
    for (const off of [-1.65, -0.55, 0.55]) g.add(cyl(0.055, 0.34, M.porcelain, 0.12, -off, 10.78));
  }
  for (const h of [7.40, 7.62, 7.84, 8.06]) if (inside(h)) g.add(cyl(0.05, 0.12, M.porcelain, 0, -0.2, h));
  if (inside(7.7)) g.add(box(0.05, 0.05, 0.85, M.steel, 0, -0.16, 7.73));
  if (inside(5.92)) g.add(box(0.12, 0.12, 0.16, M.steel, 0, 0.18, 5.92));
  let lamp = null;
  if (spec.light && inside(9.0)) {
    const arm = box(0.06, 1.7, 0.06, M.steel, 0, -0.85, 9.2); arm.rotation.x = -0.24; g.add(arm);
    lamp = box(0.32, 0.6, 0.1, lit ? M.lampOn : M.lampOff, 0, -1.75, 9.38); g.add(lamp);
  }
  return { group: outer, lamp };
}
function buildTank() {
  const g = new THREE.Group();
  g.add(cyl(0.33, 0.95, M.tank));
  for (const y of [-0.15, 0.15]) g.add(cyl(0.04, 0.22, M.porcelain, 0, y, 0.58));
  g.add(box(0.3, 0.12, 0.1, M.steel, 0, 0.36, 0.2));
  return g;
}

// ---------- View state ----------
let run = null;
const view = { poles: [], wires: new Map(), hazards: [], flashes: [], fires: [], puddles: [] };
const flashGeo = new THREE.SphereGeometry(1, 16, 12);
const arcLight = new THREE.PointLight('#b9dcff', 0, 30, 1.6);
sim.add(arcLight);
const WIRE_COLOR = ['#b4bcc6', '#1d1f22', '#141414', '#2a2c2f'];

function clearView() {
  for (const p of view.poles) { sim.remove(p.group); if (p.tank) sim.remove(p.tank); }
  for (const l of view.wires.values()) { sim.remove(l); l.geometry.dispose(); }
  for (const h of [...view.hazards, ...view.flashes, ...view.fires, ...view.puddles]) sim.remove(h.obj ?? h);
  view.poles = []; view.wires.clear(); view.hazards = []; view.flashes = []; view.fires = []; view.puddles = [];
  laneOverlay.forEach((m) => { m.material.opacity = 0; });
}

function setupView() {
  clearView();
  run.ids.forEach((id, i) => {
    const group = new THREE.Group(); sim.add(group);
    const tank = run.spec[i].transformer ? buildTank() : null;
    if (tank) sim.add(tank);
    view.poles.push({ id, i, group, key: '', pieces: [], tank });
  });
}

function syncPoles() {
  const states = [];
  for (const p of view.poles) {
    const s = run.w.pole(p.id);
    if (!s) { p.group.visible = false; if (p.tank) p.tank.visible = false; states.push(null); continue; }
    p.group.visible = true;
    states.push(s);
    const key = s.pieces + ':' + s.piece.slice(0, s.pieces).map((q) => q.z0.toFixed(2) + '/' + q.z1.toFixed(2)).join(',') + ':' + s.lit;
    if (key !== p.key) {
      p.group.clear();
      p.pieces = [];
      for (let k = 0; k < s.pieces; ++k) {
        const piece = buildPiece(s.piece[k].z0, s.piece[k].z1, run.spec[p.i], s.lit);
        p.group.add(piece.group); p.pieces.push(piece.group);
      }
      p.key = key;
    }
    for (let k = 0; k < s.pieces; ++k) {
      const q = s.piece[k], g = p.pieces[k];
      g.position.set(q.position[0], q.position[1], q.position[2]);
      g.quaternion.set(q.rotation[1], q.rotation[2], q.rotation[3], q.rotation[0]);
    }
    if (p.tank) {
      p.tank.visible = s.transformer !== 0;
      p.tank.position.set(...s.transformerPosition);
      const r = s.transformerRotation; p.tank.quaternion.set(r[1], r[2], r[3], r[0]);
    }
  }
  return states;
}

function syncWires() {
  const n = run.w.spanCount();
  for (let s = 0; s < n; ++s) {
    const wires = run.w.wires(s, 22);
    wires.forEach((wr, k) => {
      const key = s * 16 + k;
      let line = view.wires.get(key);
      const count = wr.points.length / 3;
      if (!line) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 3 * 64), 3));
        line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: WIRE_COLOR[wr.kind] ?? '#222' }));
        line.frustumCulled = false;
        sim.add(line); view.wires.set(key, line);
      }
      const a = line.geometry.attributes.position.array;
      let m = 0;
      for (let i = 0; i + 1 < count && m < 63; ++i) {
        if (wr.broken & (1 << i)) continue;
        a.set(wr.points.subarray(3 * i, 3 * i + 6), 6 * m); m++;
      }
      line.geometry.setDrawRange(0, 2 * m);
      line.geometry.attributes.position.needsUpdate = true;
    });
  }
}

function syncCar() {
  const c = run?.car;
  carMesh.visible = !!c;
  if (!c) return;
  carMesh.position.set(c.pos[0], c.pos[1], 0);
  carMesh.rotation.set(0, 0, Math.atan2(c.n[1], c.n[0]));
}

// ---------- Events ----------
let log = [], counts = {};
const blockedLanes = new Set();
const BIG = {
  POLE_CRACKED: ['Cracked', 'the section has cracked'], POLE_LEANING: ['Leaning', 'the soil has given way'], POLE_SNAPPED: ['Snapped', 'sheared at the bumper'],
  POLE_FELL: ['Pole down', ''], TRANSFORMER_DETACHED: ['Transformer off', '350 kg tank, brackets torn'], POWER_OUT: ['Power out', ''],
  WIRE_ON_GROUND_LIVE: ['Live wire down', '13.8 kV on the ground · keep 4 m away'], LANE_BLOCKED: ['Lane blocked', ''],
};
const poleNo = (id) => { const i = run.ids.indexOf(id); return i >= 0 ? 'pole ' + (i + 1) : 'pole ?'; };
function describe(e) {
  switch (e.name) {
    case 'WIRE_SNAPPED': return `${['MV', 'LV', 'telecom', 'drop'][Number(e.ids)] ?? 'wire'} conductor snapped at ${fmt(e.value / 1000, 1)} kN`;
    case 'CLAMP_FAILED': return `tie let go on ${poleNo(e.pole)} (${fmt(e.value / 1000, 1)} kN)`;
    case 'POWER_OUT': return `power out: ${fmt(e.value)} poles dark (section of ${poleNo(Number(e.ids))})`;
    case 'LANE_BLOCKED': { const l = P.unpackLane(e.ids); return `lane ${l.lane + 1} blocked (tile ${l.tileX},${l.tileY} · edge ${l.edge})`; }
    case 'TRANSFORMER_LANDED': return `transformer landed at ${fmt(e.value, 1)} m/s${Number(e.ids) & 1 ? ' · oil leak' : ''}${Number(e.ids) & 2 ? ' · fire' : ''}`;
    case 'POLE_HIT_BODY': return `falling pole hit the car (${fmt(e.value)} N·s)`;
    case 'ARC': return `arc (${fmt(e.value / 1000, 1)} kV)`;
    case 'LIGHT_CHANGED': return `${poleNo(e.pole)} light ${e.value > 0.5 ? 'on' : 'off'}`;
    default: return `${e.name.toLowerCase().replace(/_/g, ' ')} ${e.pole !== -1 ? poleNo(e.pole) : ''}`;
  }
}
function onEvents(evs) {
  for (const e of evs) {
    counts[e.name] = (counts[e.name] ?? 0) + 1;
    if (e.name !== 'ARC' || counts.ARC <= 3) log.push(`${(run.steps * DT).toFixed(2)} s  ${describe(e)}`);
    const big = BIG[e.name];
    if (big && counts[e.name] === 1) banner(big[0], e.name === 'POLE_FELL' || e.name === 'POWER_OUT' ? describe(e) : big[1]);
    if (e.name === 'ARC') {
      arcLight.position.set(...e.at); arcLight.position.z = 0.4; arcLight.intensity = 60;
      const sp = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color: '#d8ecff', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sp.position.set(e.at[0], e.at[1], 0.25); sp.scale.setScalar(0.6 + 0.5 * ((counts.ARC * 0.618) % 1)); sim.add(sp); view.flashes.push({ obj: sp, t: 0.18 });
    } else if (e.name === 'WIRE_ON_GROUND_LIVE') {
      const r = Number(e.ids) / 1000 || 4;
      const d = new THREE.Mesh(new THREE.RingGeometry(r - 0.25, r, 48), new THREE.MeshBasicMaterial({ color: '#ff2d20', transparent: true, opacity: 0.6, depthWrite: false }));
      d.add(new THREE.Mesh(new THREE.CircleGeometry(r - 0.25, 48), new THREE.MeshBasicMaterial({ color: '#ff2d20', transparent: true, opacity: 0.2, depthWrite: false })));
      d.position.set(e.at[0], e.at[1], 0.04); sim.add(d); view.hazards.push({ obj: d, t: 0 });
    } else if (e.name === 'LANE_BLOCKED') {
      const lane = e.value | 0; blockedLanes.add(String(e.ids)); if (laneOverlay[lane]) laneOverlay[lane].material.opacity = 0.28;
    } else if (e.name === 'LANE_CLEARED') {
      laneOverlay.forEach((m) => { m.material.opacity = 0; }); blockedLanes.clear();
    } else if (e.name === 'TRANSFORMER_LANDED') {
      const f = Number(e.ids);
      if (f & 1) { const d = new THREE.Mesh(new THREE.CircleGeometry(1.6, 32), new THREE.MeshStandardMaterial({ color: '#0d0c0a', roughness: 0.05, metalness: 0.2 })); d.position.set(e.at[0], e.at[1], 0.03); sim.add(d); view.puddles.push(d); }
      if (f & 2) { const l = new THREE.PointLight('#ff7a1a', 30, 14, 1.5); l.position.set(e.at[0], e.at[1], 1); sim.add(l); view.fires.push({ obj: l, t: 0 }); }
    }
  }
  $('evcount').textContent = Object.values(counts).reduce((a, b) => a + b, 0);
  if (evs.length) { const el = $('log'); el.textContent = log.slice(-60).join('\n'); el.scrollTop = el.scrollHeight; }
}

// ---------- Charts ----------
const hist = { t: [], tilt: [], tension: [] };
const COLORS = ['#5aa9ff', '#ff6b6b', '#ffd36b', '#36c483', '#c58cff', '#4fd1c5'];
function sample() {
  hist.t.push(run.steps * DT);
  hist.tilt.push(view.lastStates.map((s) => s?.tiltDeg ?? 0));
  const ten = [];
  for (let s = 0; s < N_POLES - 1; ++s) ten.push(run.w.spanInfo(s).tension / 1000);
  hist.tension.push(ten);
  if (hist.t.length > 900) { hist.t.shift(); hist.tilt.shift(); hist.tension.shift(); }
}
function chart(id, series, unit) {
  const c = $(id), x = c.getContext('2d'), W = c.width, H = c.height, pad = 30;
  x.clearRect(0, 0, W, H);
  if (hist.t.length < 2) return;
  const t0 = hist.t[0], t1 = hist.t[hist.t.length - 1];
  let vmax = 0; for (const r of series) for (const v of r) vmax = Math.max(vmax, v);
  vmax = vmax <= 1 ? 1 : vmax <= 2 ? 2 : vmax <= 5 ? 5 : vmax <= 10 ? 10 : vmax <= 20 ? 20 : vmax <= 50 ? 50 : 100 * Math.ceil(vmax / 100);
  x.font = '18px JetBrains Mono, monospace'; x.fillStyle = '#93a0b2'; x.strokeStyle = 'rgba(255,255,255,.08)';
  for (let k = 0; k <= 4; ++k) { const y = H - pad + (-(H - pad - 10) * k) / 4; x.beginPath(); x.moveTo(pad + 18, y); x.lineTo(W, y); x.stroke(); x.fillText(String(+(vmax * k / 4).toFixed(2)), 0, y + 6); }
  x.fillText(`${(t1 - t0).toFixed(1)} s · ${unit}`, W - 190, H - 4);
  const n = series[0].length;
  for (let j = 0; j < n; ++j) {
    x.strokeStyle = COLORS[j % COLORS.length]; x.lineWidth = 2.4; x.beginPath();
    series.forEach((r, i) => { const px = pad + 18 + (W - pad - 18) * (hist.t[i] - t0) / Math.max(t1 - t0, 1e-6), py = H - pad - (H - pad - 10) * r[j] / vmax; i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.stroke();
  }
}

// ---------- Readouts ----------
const STATE_NAMES = ['Intact', 'Cracked', 'Leaning', 'Snapped', 'Fallen'];
function readouts(states) {
  const r = run.result;
  $('r-force').textContent = r ? fmt(r.peakForce / 1000) + ' kN' : '–';
  $('r-impulse').textContent = r ? fmt(r.impulse) + ' N·s' : '–';
  $('r-dv').textContent = r ? fmt(r.deltaV * 3.6) + ' km/h' : '–';
  $('r-dur').textContent = r ? fmt(r.duration * 1000) + ' ms' : '–';
  $('poles').innerHTML = states.map((s, i) => s
    ? `<div class="s${s.state}${i === cfg.target ? ' sel' : ''}" data-i="${i}" title="Pole ${i + 1}${run.spec[i].transformer ? ' · transformer' : ''}${run.spec[i].light ? ' · streetlight' : ''}${s.powered ? '' : ' · no power'}"><b>${i + 1}${run.spec[i].transformer ? '⚡' : ''}</b>${['OK', 'Crack', 'Lean', 'Snap', 'Down'][s.state]}<br>${s.tiltDeg.toFixed(1)}°</div>`
    : `<div data-i="${i}">${i + 1}<br>unloaded</div>`).join('');
  const st = run.w.stats();
  $('s-spans').textContent = `${st.awakeSpans} awake · ${st.frozenSpans} frozen / ${st.spans}`;
  $('s-nodes').textContent = fmt(st.nodes);
  $('s-bodies').textContent = fmt(st.bodies);
  $('s-ms').textContent = st.lastStepMs.toFixed(3) + ' ms';
  $('hash').textContent = run.w.hash();
  $('clock').innerHTML = `${(run.steps * DT).toFixed(2)} s<small>SIM TIME · 240 Hz INSIDE</small>`;
  // Outcome line.
  const tgt = states[cfg.target];
  let text = 'Ready: set up a hit and press the button.', cls = '';
  if (r && tgt) {
    const down = counts.WIRE_SNAPPED ?? 0, lanes = blockedLanes.size, dark = states.filter((s) => s && !s.powered).length;
    const pulled = states.filter((s, i) => s && i !== cfg.target && s.tiltDeg > 1).length;
    text = `Pole ${cfg.target + 1}: ${STATE_NAMES[tgt.state].toLowerCase()} (${tgt.tiltDeg.toFixed(1)}°).`;
    if (down) text += ` ${down} wire${down > 1 ? 's' : ''} snapped.`;
    if (pulled) text += ` ${pulled} neighbour${pulled > 1 ? 's' : ''} pulled out of plumb.`;
    if (counts.TRANSFORMER_DETACHED) text += ' Transformer down.';
    if (lanes) text += ` ${lanes} lane${lanes > 1 ? 's' : ''} blocked.`;
    if (counts.WIRE_ON_GROUND_LIVE) text += ' Live wire on the ground.';
    if (dark) text += ` ${dark} pole${dark > 1 ? 's' : ''} without power.`;
    cls = tgt.state >= 3 || counts.WIRE_ON_GROUND_LIVE ? 'bad' : tgt.state >= 1 ? 'warn' : 'ok';
  }
  const o = $('outcome'); o.textContent = text; o.className = cls;
  // Houses and windows follow the nearest pole's power.
  for (const h of houses) {
    const i = clamp(Math.round((h.x - 17.5) / SPACING), 0, N_POLES - 1), s = states[i];
    const on = !s || s.powered;
    if (h.on !== on) { h.on = on; h.wins.forEach((w) => { w.material = on ? M.winOn : M.winOff; }); }
  }
}

// ---------- Camera (orbit) ----------
const orbit = { target: new THREE.Vector3(), r: 34, th: -0.95, ph: 1.2 };
function placeCamera() {
  orbit.ph = clamp(orbit.ph, 0.12, 1.52); orbit.r = clamp(orbit.r, 4, 260);
  const t = orbit.target;
  camera.position.set(t.x + orbit.r * Math.sin(orbit.ph) * Math.sin(orbit.th), t.y + orbit.r * Math.cos(orbit.ph), t.z + orbit.r * Math.sin(orbit.ph) * Math.cos(orbit.th));
  camera.lookAt(t);
}
function aimAt(i, preset = 'street') {
  const x = run ? run.w.pole(run.ids[i])?.piece[0].position[0] ?? i * SPACING : i * SPACING;
  orbit.target.copy(toScene([x, -1, 4.5]));
  if (preset === 'street') Object.assign(orbit, { r: 30, th: -0.85, ph: 1.25 });
  if (preset === 'top') Object.assign(orbit, { r: 120, th: 0, ph: 0.25 });
  if (preset === 'pole') Object.assign(orbit, { r: 17, th: -0.35, ph: 1.22 });
  placeCamera();
}
{
  const ptrs = new Map(); let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey }); canvas.style.cursor = 'grabbing'; });
  canvas.addEventListener('pointerup', (e) => { ptrs.delete(e.pointerId); pinch = 0; canvas.style.cursor = 'grab'; });
  canvas.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); pinch = 0; });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) orbit.r *= pinch / d; pinch = d; placeCamera(); return;
    }
    if (p.b === 2 || p.shift) {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0), fwd = new THREE.Vector3(-right.z, 0, right.x);
      orbit.target.addScaledVector(right, -dx * orbit.r * 0.0016).addScaledVector(fwd, dy * orbit.r * 0.0016);
    } else { orbit.th -= dx * 0.006; orbit.ph -= dy * 0.005; }
    placeCamera();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.r *= Math.exp(e.deltaY * 0.001); placeCamera(); }, { passive: false });
}

// ---------- Controls ----------
const bind = (id, key, label, parse = Number) => {
  const el = $(id);
  const show = () => { $('v-' + id).textContent = label(cfg[key]); };
  el.value = cfg[key];
  el.addEventListener('input', () => { cfg[key] = parse(el.value); show(); store.set('cfg', cfg); if (key === 'target') aimAt(cfg.target); });
  show();
};
bind('speed', 'speed', (v) => `${v} km/h`);
bind('height', 'height', (v) => `${(+v).toFixed(2)} m`);
bind('yaw', 'yaw', (v) => `${v}°`);
bind('mass', 'mass', (v) => `${fmt(v)} kg`);
bind('target', 'target', (v) => `${v + 1} of 6`);
bind('wet', 'wet', (v) => (v <= 0 ? 'dry' : v >= 1 ? 'saturated' : v < 0.5 ? 'damp' : 'wet'));
bind('soil', 'soil', (v) => `${v} kN·m`);
bind('nominal', 'nominal', (v) => `${fmt(v)} daN`);
bind('clamp', 'clamp', (v) => `×${(+v).toFixed(2)}`);
bind('trip', 'trip', (v) => (v > 0 ? `${v} s` : 'never'));
bind('crush', 'crush', (v) => `${v} kN/m`);
$('cls').value = cfg.cls;
$('cls').addEventListener('change', () => { cfg.cls = +$('cls').value; cfg.nominal = NOMINAL[cfg.cls]; $('nominal').value = cfg.nominal; $('v-nominal').textContent = `${fmt(cfg.nominal)} daN`; store.set('cfg', cfg); reset(); });
$('tx-target').checked = cfg.txTarget; $('tx-far').checked = cfg.txFar;
$('tx-target').addEventListener('change', () => { cfg.txTarget = $('tx-target').checked; store.set('cfg', cfg); reset(); });
$('tx-far').addEventListener('change', () => { cfg.txFar = $('tx-far').checked; store.set('cfg', cfg); reset(); });
function applyCfg(c) {
  cfg = { ...DEFAULTS, ...c, nominal: c.nominal ?? NOMINAL[c.cls ?? 0] };
  for (const id of ['speed', 'height', 'yaw', 'mass', 'target', 'wet', 'soil', 'nominal', 'clamp', 'trip', 'crush']) { $(id).value = cfg[id]; $(id).dispatchEvent(new Event('input')); }
  $('cls').value = cfg.cls; $('tx-target').checked = cfg.txTarget; $('tx-far').checked = cfg.txFar;
  store.set('cfg', cfg);
}
$('presets').innerHTML = PRESETS.map((p, i) => `<button data-p="${i}"><b>${p.name}</b><small>${p.note}</small></button>`).join('');
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  applyCfg(PRESETS[+b.dataset.p].cfg); hit();
});
$('poles').addEventListener('click', (e) => {
  const d = e.target.closest('[data-i]'); if (!d) return;
  cfg.target = +d.dataset.i; $('target').value = cfg.target; $('v-target').textContent = `${cfg.target + 1} of 6`; store.set('cfg', cfg); aimAt(cfg.target);
});

let scale = store.get('scale', 0.25), paused = false;
function setScale(s) { scale = s; store.set('scale', s); document.querySelectorAll('#scale button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.scale === s))); }
$('scale').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setScale(+b.dataset.scale); });
setScale(scale);
$('btn-pause').addEventListener('click', () => { paused = !paused; $('btn-pause').textContent = paused ? 'Play' : 'Pause'; });
$('btn-reset').addEventListener('click', () => reset());
$('hit').addEventListener('click', () => hit());
$('cam-street').addEventListener('click', () => aimAt(cfg.target, 'street'));
$('cam-top').addEventListener('click', () => aimAt(cfg.target, 'top'));
$('cam-follow').addEventListener('click', () => aimAt(cfg.target, 'pole'));
$('btn-help').addEventListener('click', () => $('help').classList.add('on'));
$('help-close').addEventListener('click', () => $('help').classList.remove('on'));
$('help').addEventListener('click', (e) => { if (e.target.id === 'help') $('help').classList.remove('on'); });
for (const [tab, panel] of [['tab-lab', 'lab'], ['tab-res', 'res']]) $(tab).addEventListener('click', () => {
  for (const [t2, p2] of [['tab-lab', 'lab'], ['tab-res', 'res']]) { $(t2).setAttribute('aria-pressed', String(t2 === tab)); if (matchMedia('(max-width:860px)').matches) $(p2).hidden = t2 !== tab; }
});
matchMedia('(max-width:860px)').addEventListener('change', (m) => { $('res').hidden = m.matches && $('tab-res').getAttribute('aria-pressed') !== 'true'; $('lab').hidden = m.matches && $('tab-lab').getAttribute('aria-pressed') !== 'true'; });
if (matchMedia('(max-width:860px)').matches) $('res').hidden = true;

$('btn-repair').addEventListener('click', () => {
  if (!run) return;
  run.car = null; run.w.setBodies([]);
  if (run.w.repair(run.ids[cfg.target])) { onEvents(run.w.events()); toast(`Pole ${cfg.target + 1} repaired: back up, spans re-strung, power restored.`); }
});
$('btn-persist').addEventListener('click', () => {
  if (!run) return;
  const diff = run.w.saveTile(0, 0);
  run.w.unloadTile(0, 0);
  syncPoles();
  run.w.loadTile(run.tile);
  run.w.events();
  toast(`Tile unloaded and loaded again: ${fmt(diff.length)} bytes of damage diff kept the street as it was.`);
});
$('btn-replay').addEventListener('click', () => {
  if (!run || run.launchStep < 0) { toast('Hit a pole first, then replay it.'); return; }
  const target = run.steps, mine = run.w.hash();
  const r2 = new Run(run.cfg);
  while (r2.steps < target) { if (r2.steps === run.launchStep) r2.launch(); r2.tick(true); }
  const theirs = r2.w.hash(); r2.destroy();
  toast(theirs === mine ? `Replayed ${fmt(target)} steps from scratch: state hash ${theirs}, identical.` : `Replay differs: ${theirs} vs ${mine}`);
});

// ---------- Run control ----------
function reset() {
  run?.destroy();
  run = new Run(cfg);
  log = []; counts = {}; blockedLanes.clear(); hist.t.length = hist.tilt.length = hist.tension.length = 0;
  $('log').textContent = ''; $('evcount').textContent = '0';
  setupView();
  view.lastStates = syncPoles();
  if (!reset.aimed) { aimAt(cfg.target, 'street'); reset.aimed = true; }
}
function hit() {
  reset();
  run.launch();
  aimAt(cfg.target, 'street');
}

// ---------- Main loop ----------
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  // On phones the bench is a bottom sheet: frame the scene in the space above it.
  if (w <= 860) camera.setViewOffset(w, h, 0, h * 0.2, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
reset();
$('loading').remove();
if (!store.get('seenHelp', false)) { store.set('seenHelp', true); toast('Pick a scenario on the left, or set up your own hit.'); }

let last = performance.now(), acc = 0, frame = 0;
function loop(now) {
  const real = Math.min((now - last) / 1000, 0.1); last = now;
  if (!paused) acc += real * scale;
  let n = 0;
  while (acc >= DT && n < 8) {
    run.tick();
    onEvents(run.w.events());
    acc -= DT; n++;
    if (run.steps % 2 === 0) { view.lastStates = syncPoles(); sample(); }
  }
  view.lastStates = syncPoles();
  syncWires();
  syncCar();
  // Effects.
  arcLight.intensity *= Math.pow(0.0005, real);
  view.flashes = view.flashes.filter((f) => { f.t -= real; f.obj.material.opacity = clamp(f.t / 0.18, 0, 1); if (f.t <= 0) { sim.remove(f.obj); return false; } return true; });
  for (const h of view.hazards) { h.t += real; h.obj.material.opacity = 0.45 + 0.25 * Math.sin(h.t * 6); }
  for (const f of view.fires) { f.t += real; f.obj.intensity = 24 + 10 * Math.sin(f.t * 23) * Math.sin(f.t * 7.3); }
  sun.position.copy(orbit.target).add(new THREE.Vector3(40, 70, 30)); sun.target.position.copy(orbit.target);
  if (++frame % 6 === 0) { readouts(view.lastStates); chart('chart-tilt', hist.tilt, '°'); chart('chart-tension', hist.tension, 'kN'); }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
