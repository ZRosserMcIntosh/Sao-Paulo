// São Paulo World · flight test bed.
// The Aviation Dynamics flight core (C++20 → WebAssembly) flies the 172 or the Top G;
// this file only draws them and passes the pilot's inputs in. Every number on screen comes from
// the simulation: the HUD from avd_state, the instruments from avd_cockpit.
// World frame: ENU metres (x east, y north, z up) from MASP; three.js: (east, up, −north).
import * as THREE from 'three';
import createAvdModule from './avd.mjs';
import { buildAircraft } from './model.js';
import { buildJet, skin as jetSkin } from './jetmodel.js';
import { K, markingsFrom, drawPanel } from './panel.js';
import { drawJetStrip } from './glass.js';
import { buildCabin } from './cabin.js';
import { buildJetCabin } from './jetcabin.js';
import { FlightAudio, JetAudio } from './audio.js';
import { buildFlow } from './flow.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEG = Math.PI / 180;
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw.fly.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw.fly.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;

// World mosaic (img/mosaic_world.jpg): 500 m tiles, grid i −13..10 east, j −17..30 north.
const MX0 = -6750, MX1 = 5250, MY0 = -8750, MY1 = 15250;
const LANDMARKS = [
  ['MASP', -1, 1], ['Catedral da Sé', 2193, 1161], ['Copan', 1154, 1665], ['Edifício Itália', 1244, 1784],
  ['Martinelli', 2097, 1794], ['Altino Arantes', 2209, 1768], ['Estação da Luz', 2072, 2948], ['Teatro Municipal', 1747, 1819],
  ['Mercado Municipal', 2684, 2220], ['Parque Ibirapuera', -194, -2904], ['Oca', 87, -2809], ['Obelisco', 143, -2580],
  ['Ponte Estaiada', -4320, -5722], ['Congonhas', -522, -7260], ['Pacaembu', -969, 1417], ['Jockey Club', -4310, -2007],
  ['Conjunto Nacional', -436, 288],
];

const loadMsg = (t) => { $('loadMsg').textContent = t; };
const toastEl = $('toast');
let toastT = 0;
function toast(msg, sec = 3.5) { toastEl.textContent = msg; toastEl.classList.add('on'); toastT = sec; }

// ---------- Aircraft ----------
// Chase distance, camera target and pilot's eye in body FLU metres from each datum.
const PROFILES = {
  c172: { id: 'c172', name: '172', file: './172.json', jet: false, fuse: { xNose: 1.02, xTail: -6.25, R: 0.55, z: 0.0 }, chase: 15, zoom: [7, 120], target: [-1.4, 0, 0.4], eye: [-1.38, 0.27, 0.84], tower: 22, shadow: 9 },
  topg: { id: 'topg', name: 'Top G', file: './top_g.json', jet: true, fuse: { xNose: 0, xTail: -30.4, R: 1.31, z: 0.0 }, chase: 50, zoom: [20, 260], target: [-15, 0, 0.6], eye: [-3.62, 0.52, 0.4], tower: 48, shadow: 24 },
};
const hashPick = { '#topg': 'topg', '#172': 'c172' }[location.hash.toLowerCase()];
let P = PROFILES[hashPick || store.get('aircraft', 'c172')] || PROFILES.c172;
const jsonCache = {};
const fetchDef = async (p) => {
  if (!jsonCache[p.id]) {
    const r = await fetch(p.file);
    if (!r.ok) throw new Error(`${p.file} ${r.status}`);
    jsonCache[p.id] = await r.text();
  }
  return jsonCache[p.id];
};

// ---------- Simulation ----------
let A, def, M;
function loadInto(json) {
  const errors = A.load(json);
  if (errors.length) throw new Error(errors.join('; '));
  def = JSON.parse(json);
  M = markingsFrom(A.markings());
}
try {
  const [mod, json] = await Promise.all([createAvdModule(), fetchDef(P)]);
  A = mod;
  loadInto(json);
} catch (e) {
  loadMsg('The flight core could not start: ' + e.message);
  throw e;
}
const RW = A.runway();  // [threshold east, threshold north, elevation, true heading, length, width] of runway 12
const ELEV = RW[2];
const rwDir = [Math.sin(RW[3] * DEG), Math.cos(RW[3] * DEG)];
const rwMid = [RW[0] + rwDir[0] * RW[4] / 2, RW[1] + rwDir[1] * RW[4] / 2];
const rwRight = [rwDir[1], -rwDir[0]];  // right of runway 12, looking down it
const controlIndex = (id) => A.cockpit().findIndex((c) => c.id === id);
function setControl(id, target) {
  const i = controlIndex(id); if (i < 0) return;
  const n = A.cockpit()[i].positions.length; target = clamp(target, 0, n - 1);
  for (let k = 0; k < n && A.cockpit()[i].position !== target; ++k) A.avd_cockpit_cycle(i);
}
const controlPos = (id) => { const c = A.cockpit().find((x) => x.id === id); return c ? c.position : 0; };

// ---------- Renderer & scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
const RES = { max: Math.min(devicePixelRatio, MOBILE ? 1.5 : 2), min: MOBILE ? 0.6 : 1, cur: 0, acc: 0, n: 0 };
RES.cur = MOBILE ? Math.min(RES.max, 1.1) : RES.max;
renderer.setPixelRatio(RES.cur);
function adaptRes(dt) {
  RES.acc += dt; RES.n++;
  if (RES.acc < 1.5) return;
  const avg = RES.acc / RES.n; RES.acc = 0; RES.n = 0;
  let next = RES.cur;
  if (avg > 1 / 40) next = Math.max(RES.min, RES.cur * 0.85);
  else if (avg < 1 / 57) next = Math.min(RES.max, RES.cur * 1.07);
  if (Math.abs(next - RES.cur) > 0.01) { RES.cur = next; renderer.setPixelRatio(next); resize(); }
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = MOBILE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
// The ground is a photograph: no tone mapping, and light that sums to about 1 on it.
renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene();
const SKY = new THREE.Color('#a9c2dc');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 3000, 26000);
const camera = new THREE.PerspectiveCamera(60, 1, 0.12, 90000);
scene.add(new THREE.AmbientLight('#ffffff', 0.58));
const sun = new THREE.DirectionalLight('#fff6e8', 0.6);
const SUN_DIR = new THREE.Vector3(-0.45, 1, 0.3).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 400 });
sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// Sky dome: horizon haze to a deeper zenith, centred on the camera every frame.
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(80000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { hor: { value: SKY.clone() }, zen: { value: new THREE.Color('#3f6fb2') } },
  vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
  fragmentShader: 'uniform vec3 hor; uniform vec3 zen; varying vec3 vP; void main(){ float y = max(vP.y, 0.0); gl_FragColor = vec4(mix(hor, zen, pow(y, 0.5)), 1.0); }',
}));
skyDome.renderOrder = -1; skyDome.frustumCulled = false;
scene.add(skyDome);

// Reflection environment for the airframe paint (baked once).
{
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vP; void main(){ float y = vP.y;
      vec3 zen = vec3(0.2, 0.36, 0.66), hor = vec3(0.82, 0.87, 0.92), gnd = vec3(0.32, 0.34, 0.3);
      gl_FragColor = vec4(y > 0.0 ? mix(hor, zen, pow(y, 0.55)) : mix(hor * 0.6, gnd, pow(-y, 0.4)), 1.0); }`,
  })));
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(env, 0.02).texture;
  pm.dispose();
}

// ---------- Ground: the São Paulo World map at the field elevation ----------
const enu = (e, n, u) => new THREE.Vector3(e, u, -n);
// Beyond the map: a plain frame around it (four tessellated strips that never overlap the map,
// so there is no depth fight between two coplanar surfaces).
{
  const R = 120000, mat = new THREE.MeshLambertMaterial({ color: '#77796f' });
  for (const [x0, x1, y0, y1] of [[-R, R, MY1, R], [-R, R, -R, MY0], [-R, MX0, MY0, MY1], [MX1, R, MY0, MY1]]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0, 24, 24), mat);
    m.rotation.x = -Math.PI / 2; m.position.copy(enu((x0 + x1) / 2, (y0 + y1) / 2, ELEV - 0.05));
    scene.add(m);
  }
}
const mapMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
const map = new THREE.Mesh(new THREE.PlaneGeometry(MX1 - MX0, MY1 - MY0, 24, 48), mapMat);
map.rotation.x = -Math.PI / 2;  // texture top = north
map.position.copy(enu((MX0 + MX1) / 2, (MY0 + MY1) / 2, ELEV - 0.05));
map.receiveShadow = true;
scene.add(map);
new THREE.TextureLoader().load(MOBILE ? '../img/mosaic_world_sm.jpg' : '../img/mosaic_world.jpg', (t) => {
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  mapMat.map = t; mapMat.needsUpdate = true;
});

// Runway 12/30, drawn from avd_runway: asphalt, threshold bars, numbers, centreline.
{
  const W = 128, H = 4096, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), pxm = H / RW[4];
  g.fillStyle = '#3c3f43'; g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#e9e9e4';
  const edge = 0.9 * W / RW[5];
  g.fillRect(2, 0, edge, H); g.fillRect(W - 2 - edge, 0, edge, H);
  for (let y = 70 * pxm; y < H - 70 * pxm; y += 60 * pxm) g.fillRect(W / 2 - 1.5, H - y - 36 * pxm, 3, 36 * pxm);
  const end = (flip) => {
    g.save();
    if (flip) { g.translate(W, H); g.rotate(Math.PI); }
    for (let i = 0; i < 8; ++i) { const x = 8 + i * 14 + (i >= 4 ? 4 : 0); g.fillRect(x, H - 8 - 30 * pxm, 8, 30 * pxm); }
    g.font = `900 ${Math.round(8 * pxm)}px Arial`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.save(); g.translate(W / 2, H - 44 * pxm); g.scale(0.8, 1.6); g.fillText(flip ? '30' : '12', 0, 0); g.restore();
    g.restore();
  };
  end(false); end(true);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const rw = new THREE.Mesh(new THREE.PlaneGeometry(RW[5], RW[4]),
    new THREE.MeshLambertMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  rw.rotation.set(-Math.PI / 2, 0, -RW[3] * DEG);
  rw.position.copy(enu(rwMid[0], rwMid[1], ELEV + 0.02));
  rw.receiveShadow = true;
  scene.add(rw);
  // A tower and hangars on the south side, so the field reads at a glance.
  const box = (w, d, h, along, across, color) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    m.position.copy(enu(rwMid[0] + rwDir[0] * along + rwRight[0] * across, rwMid[1] + rwDir[1] * along + rwRight[1] * across, ELEV + h / 2));
    m.rotation.y = -RW[3] * DEG; m.castShadow = m.receiveShadow = true; scene.add(m); return m;
  };
  box(5, 5, 22, -120, 140, '#d8d4c8'); box(9, 9, 4, -120, 140, '#9fb9c9').position.y = ELEV + 23;
  for (let i = 0; i < 4; ++i) box(30, 26, 9, 60 + i * 42, 150, i % 2 ? '#b9b3a4' : '#c9c3b2');
}

// ---------- The airplanes ----------
// Each aircraft: exterior model, cabin (seen only from the left seat) and the
// pilot's eye, all in body FLU from its datum; built on first use.
const acGroup = new THREE.Group();
scene.add(acGroup);
const qM = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);  // ENU → three
const qBody = new THREE.Quaternion();
const rigs = {};
let aircraft, cabin, eye;
function useRig(p) {
  if (!rigs[p.id]) {
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const model = p.jet ? buildJet(def) : buildAircraft(def);
    const cab = p.jet ? buildJetCabin({ mobile: MOBILE, maxAniso, skin: jetSkin }) : buildCabin({ mobile: MOBILE, maxAniso });
    const e = new THREE.Object3D();
    e.position.set(...p.eye);
    e.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
    model.root.add(e, cab.root);
    acGroup.add(model.root);
    rigs[p.id] = { model, cab, eye: e };
  }
  for (const [id, r] of Object.entries(rigs)) r.model.root.visible = id === p.id;
  ({ model: aircraft, cab: cabin, eye } = rigs[p.id]);
  Object.assign(sun.shadow.camera, { left: -p.shadow, right: p.shadow, top: p.shadow, bottom: -p.shadow });
  sun.shadow.camera.updateProjectionMatrix();
}
useRig(P);
const flow = buildFlow({ mobile: MOBILE });
acGroup.add(flow.group);
const bodyPoint = (x, y, z) => acGroup.localToWorld(new THREE.Vector3(x, y, z));

// ---------- State ----------
const ui = {
  assist: store.get('assist', 0), cam: store.get('cam', 0), instr: store.get('instr', true),
  start: 0, paused: false, crashed: false, sound: false, vol: store.get('vol', 80),
};
const input = { pitch: 0, roll: 0, yaw: 0, throttle: 0.1, mixture: 1, brake: 0, trimRate: 0 };
let s = new Float64Array(64), c = new Float64Array(96), j = new Float64Array(32);
const failed = { fuel: false, 0: false, 1: false, 2: false, 3: false };
let parkHint = false;

const PISTON_STARTS = [
  { name: 'Runway 12', sub: 'engine running', go: () => A.avd_reset(1), thr: 0.1 },
  { name: 'Cold and dark', sub: 'runway 12', go: () => A.avd_reset(0), thr: 0.1 },
  { name: 'Final 12', sub: '3 km, flaps 20', go: () => A.avd_reset(2), trim: true },
  { name: 'Downwind 12', sub: '1000 ft, 90 kt', go: () => A.avd_reset_air(rwMid[0] - rwRight[0] * 1000, rwMid[1] - rwRight[1] * 1000, 305, (RW[3] + 180) % 360, 90, 0), trim: true },
  { name: 'Avenida Paulista', sub: 'toward MASP', go: () => A.avd_reset_air(1600, -1100, 450, 305, 100, 0), trim: true },
  { name: 'Centro', sub: 'Sé, Martinelli, Luz', go: () => A.avd_reset_air(2100, -1000, 400, 0, 100, 0), trim: true },
  { name: 'Ibirapuera', sub: 'park and Obelisco', go: () => A.avd_reset_air(-2000, -4500, 400, 50, 100, 0), trim: true },
  { name: 'Ponte Estaiada', sub: 'Pinheiros river', go: () => A.avd_reset_air(-3800, -8500, 300, 345, 95, 0), trim: true },
];
const JET_STARTS = [
  { name: 'Runway 12', sub: 'engines at idle', go: () => A.avd_reset(1), thr: 0 },
  { name: 'Cold and dark', sub: 'runway 12', go: () => A.avd_reset(0), thr: 0 },
  { name: 'Final 12', sub: '6 km, 125 kt, flaps 39', go: () => A.avd_reset(2), trim: true },
  { name: 'Downwind 12', sub: '2000 ft, 180 kt', go: () => A.avd_reset_air(rwMid[0] - rwRight[0] * 2500, rwMid[1] - rwRight[1] * 2500, 610, (RW[3] + 180) % 360, 180, 1), trim: true },
  { name: 'Avenida Paulista', sub: 'low pass, 220 kt', go: () => A.avd_reset_air(3200, -2200, 600, 305, 220, 0), trim: true },
  { name: 'Centro', sub: '2000 ft, 220 kt', go: () => A.avd_reset_air(2100, -3000, 600, 0, 220, 0), trim: true },
  { name: 'Ibirapuera', sub: '2000 ft, 220 kt', go: () => A.avd_reset_air(-4000, -7000, 600, 40, 220, 0), trim: true },
  { name: 'Cruise FL410', sub: 'Mach 0.85 over the city', go: () => A.avd_reset_air(0, -9000, 12497 - ELEV, 340, 240, 0), trim: true },
];
let STARTS = P.jet ? JET_STARTS : PISTON_STARTS;
const startsEl = $('starts');
function buildStarts() {
  startsEl.innerHTML = '';
  STARTS.forEach((st, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<span>${st.name}</span><small>${st.sub}</small>`;
    b.addEventListener('click', () => { restart(i); b.blur(); });
    startsEl.appendChild(b);
  });
}
buildStarts();

function applyWeather() {
  const kt = +$('wind').value, dir = +$('windDir').value, turb = +$('turb').value, temp = +$('temp').value;
  A.avd_set_weather(kt * 0.5144, dir, turb, temp, 0.6);
  $('windV').textContent = kt ? `${kt} kt` : 'calm';
  $('windDirV').textContent = `${String(dir).padStart(3, '0')}°`;
  $('turbV').textContent = turb ? `${turb.toFixed(1)} m/s` : 'none';
  $('tempV').textContent = temp ? `ISA ${temp > 0 ? '+' : '−'}${Math.abs(temp)} °C` : 'ISA';
}
for (const id of ['wind', 'windDir', 'turb', 'temp']) $(id).addEventListener('input', applyWeather);

function restart(i = ui.start) {
  ui.start = i;
  const st = STARTS[i];
  applyWeather();
  st.go();
  A.avd_set_assist(ui.assist);
  input.pitch = input.roll = input.yaw = input.trimRate = 0;
  input.throttle = st.trim ? A.avd_trim_throttle() : st.thr;
  input.mixture = st.trim ? A.avd_trim_mixture() : 1;
  for (const k of Object.keys(failed)) failed[k] = false;
  document.querySelectorAll('[data-fail]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  ui.crashed = false; parkHint = false;
  A.events();  // drop the reset's own events
  [...startsEl.children].forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
  snapCamera = true;
  if (i === 0 && P.jet) toast(`Runway 12: full thrust (${MOBILE ? 'slide THR up' : '+ or X'}), rotate at 125 kt, gear up (${MOBILE ? 'GEAR' : 'G'}) once climbing.`, 7);
  else if (i === 0) toast(`Runway 12: full throttle (${MOBILE ? 'slide THR up' : '+ or X'}), keep straight, ease back at 55 kt.`, 6);
  else if (i === 1) toast('Cold and dark: run the Quick Start in Settings, or work the switches.', 6);
  else toast(`${st.name}: trimmed and level, ${st.sub}.`);
}

// ---------- Controls ----------
const keys = new Set();
const keyMap = {
  KeyW: 'pitchDown', ArrowUp: 'pitchDown', KeyS: 'pitchUp', ArrowDown: 'pitchUp',
  KeyA: 'rollLeft', ArrowLeft: 'rollLeft', KeyD: 'rollRight', ArrowRight: 'rollRight',
  KeyQ: 'yawLeft', KeyE: 'yawRight', Equal: 'thrUp', NumpadAdd: 'thrUp', KeyX: 'thrUp',
  Minus: 'thrDown', NumpadSubtract: 'thrDown', KeyZ: 'thrDown', KeyB: 'brake',
  BracketLeft: 'trimDown', BracketRight: 'trimUp',
};
const flaps = (dir) => setControl('flaps.lever', controlPos('flaps.lever') + dir);
function toggleGear() {
  if (!P.jet) { toast('The 172 has fixed gear.', 1.5); return; }
  const down = controlPos('gear.lever') ? 0 : 1;
  if (!down && s[28]) { toast('Weight on wheels: the gear stays down.', 2); return; }
  setControl('gear.lever', down); toast(down ? 'Gear down' : 'Gear up', 1.5);
}
function cycleSpeedbrake() {
  if (!P.jet) return;
  const n = A.cockpit().find((x) => x.id === 'speedbrake.lever')?.positions.length || 3;
  setControl('speedbrake.lever', (controlPos('speedbrake.lever') + 1) % n);
}
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (keyMap[e.code]) { keys.add(keyMap[e.code]); e.preventDefault(); }
  if (e.repeat) return;
  switch (e.code) {
    case 'Comma': flaps(-1); break;
    case 'Period': flaps(1); break;
    case 'KeyP': setControl('brakes.parking', controlPos('brakes.parking') ? 0 : 1); break;
    case 'KeyG': toggleGear(); break;
    case 'Slash': cycleSpeedbrake(); e.preventDefault(); break;
    case 'KeyV': cycleFlow(); break;
    case 'KeyK': A.avd_ai_cage(); toast('Attitude indicator caged (do it wings level).', 2); break;
    case 'KeyC': cycleCam(); break;
    case 'KeyI': toggleInstr(); break;
    case 'KeyR': restart(); break;
    case 'KeyH': togglePanel(); break;
    case 'KeyM': toggleSound(); break;
    case 'Space': togglePause(); e.preventDefault(); break;
    default:
  }
});
addEventListener('keyup', (e) => { if (keyMap[e.code]) keys.delete(keyMap[e.code]); });
addEventListener('blur', () => keys.clear());

// Touch: stick (pitch/roll; on the ground it also steers), throttle slider, flaps and brake.
const touch = { x: 0, y: 0, id: null, thrId: null, brake: false };
{
  const stick = $('stick'), knob = stick.querySelector('i');
  const move = (e) => {
    const r = stick.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    touch.x = x; touch.y = y; knob.style.transform = `translate(${x * R * 0.7}px,${y * R * 0.7}px)`;
  };
  stick.addEventListener('pointerdown', (e) => { touch.id = e.pointerId; stick.setPointerCapture(e.pointerId); move(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === touch.id) move(e); });
  const end = (e) => { if (e.pointerId !== touch.id) return; touch.id = null; touch.x = touch.y = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
  const thr = $('thr');
  const setThr = (e) => { const r = thr.getBoundingClientRect(); input.throttle = clamp(1 - (e.clientY - r.top - 15) / (r.height - 30), 0, 1); };
  thr.addEventListener('pointerdown', (e) => { touch.thrId = e.pointerId; thr.setPointerCapture(e.pointerId); setThr(e); });
  thr.addEventListener('pointermove', (e) => { if (e.pointerId === touch.thrId) setThr(e); });
  thr.addEventListener('pointerup', () => { touch.thrId = null; });
  $('tGear').addEventListener('pointerdown', () => toggleGear());
  $('tSpd').addEventListener('pointerdown', () => cycleSpeedbrake());
  $('tFu').addEventListener('pointerdown', () => flaps(-1));
  $('tFd').addEventListener('pointerdown', () => flaps(1));
  const br = $('tBr');
  br.addEventListener('pointerdown', (e) => { touch.brake = true; br.classList.add('on'); br.setPointerCapture(e.pointerId); });
  const brEnd = () => { touch.brake = false; br.classList.remove('on'); };
  br.addEventListener('pointerup', brEnd); br.addEventListener('pointercancel', brEnd);
}

// Gamepad (standard mapping).
const padPrev = [];
function readPad(dt) {
  const gp = [...(navigator.getGamepads?.() || [])].find((p) => p && p.mapping === 'standard');
  if (!gp) return null;
  const dz = (v) => (Math.abs(v) < 0.08 ? 0 : v);
  const edge = (i) => { const on = !!gp.buttons[i]?.pressed, was = padPrev[i]; padPrev[i] = on; return on && !was; };
  input.throttle = clamp(input.throttle + ((gp.buttons[7]?.value || 0) - (gp.buttons[6]?.value || 0)) * 0.5 * dt, 0, 1);
  if (edge(5)) flaps(1);
  if (edge(4)) flaps(-1);
  if (edge(3)) restart();
  if (edge(8)) cycleCam();
  return {
    pitch: dz(gp.axes[1] || 0), roll: dz(gp.axes[0] || 0), yaw: dz(gp.axes[2] || 0), brake: gp.buttons[0]?.pressed ? 1 : 0,
    trim: gp.buttons[12]?.pressed ? -1 : gp.buttons[13]?.pressed ? 1 : 0,
  };
}

const approach = (v, t, rate, dt) => (v < t ? Math.min(v + rate * dt, t) : Math.max(v - rate * dt, t));
function readInputs(dt) {
  const k = (n) => keys.has(n);
  const pitchT = k('pitchUp') ? 1 : k('pitchDown') ? -1 : 0, rollT = k('rollRight') ? 1 : k('rollLeft') ? -1 : 0;
  input.pitch = approach(input.pitch, pitchT, pitchT ? 1.5 : 3, dt);
  input.roll = approach(input.roll, rollT, rollT ? 2 : 4, dt);
  input.yaw = approach(input.yaw, k('yawRight') ? 1 : k('yawLeft') ? -1 : 0, 3, dt);
  if (k('thrUp')) input.throttle = clamp(input.throttle + 0.5 * dt, 0, 1);
  if (k('thrDown')) input.throttle = clamp(input.throttle - 0.5 * dt, 0, 1);
  input.trimRate = k('trimUp') ? 1 : k('trimDown') ? -1 : 0;
  input.brake = k('brake') || touch.brake ? 1 : 0;
  if (touch.id !== null) {
    input.pitch = touch.y; input.roll = touch.x;
    if (s[28]) input.yaw = touch.x;  // nosewheel steering from the stick on the ground
  }
  const gp = readPad(dt);
  if (gp) {
    if (gp.pitch || gp.roll) { input.pitch = gp.pitch; input.roll = gp.roll; }
    if (gp.yaw) input.yaw = gp.yaw;
    if (gp.brake) input.brake = 1;
    if (gp.trim) input.trimRate = gp.trim;
  }
}

// ---------- UI wiring ----------
const ASSIST = ['Easy', 'Sport', 'Simulation'];
function setAssist(n) {
  ui.assist = n; store.set('assist', n); A.avd_set_assist(n);
  document.querySelectorAll('[data-assist]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.assist === n)));
  $('hAssist').textContent = ASSIST[n];
}
document.querySelectorAll('[data-assist]').forEach((b) => b.addEventListener('click', () => { setAssist(+b.dataset.assist); b.blur(); }));

document.querySelectorAll('[data-fail]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.fail, on = !failed[k];
  failed[k] = on; b.setAttribute('aria-pressed', String(on));
  if (k === 'fuel') setControl(P.jet ? 'engine1.fuel' : 'fuel.shutoff', on ? 0 : 1);
  else A.avd_failure(+k, on ? 1 : 0);
  toast(`${b.textContent}: ${on ? (k === 'fuel' ? 'closed' : 'failed') : 'restored'}.`);
  b.blur();
}));

$('bQuick').addEventListener('click', (e) => {
  if (STARTS[ui.start].trim || s[30]) restart(1);
  A.avd_quick_start(); toast(P.jet ? 'Quick Start: battery and generators on, starting engine 1, then engine 2…' : 'Quick Start: working through the checklist…'); e.currentTarget.blur();
});

const audios = { piston: new FlightAudio(), jet: new JetAudio() };
let audio = P.jet ? audios.jet : audios.piston;
for (const a of Object.values(audios)) a.setVolume(ui.vol / 100);
$('vol').value = ui.vol;
$('vol').addEventListener('input', (e) => { ui.vol = +e.target.value; for (const a of Object.values(audios)) a.setVolume(ui.vol / 100); store.set('vol', ui.vol); });
function toggleSound() {
  ui.sound = !ui.sound;
  if (ui.sound) audio.start(); else audio.stop();
  const b = $('bSound'); b.setAttribute('aria-pressed', String(ui.sound)); b.textContent = ui.sound ? 'Sound on' : 'Sound off';
}
$('bSound').addEventListener('click', (e) => { toggleSound(); e.currentTarget.blur(); });

const CAMS = ['Chase', 'Cockpit', 'Orbit', 'Tower'];
function cycleCam() { ui.cam = (ui.cam + 1) % CAMS.length; store.set('cam', ui.cam); snapCamera = true; look.yaw = look.pitch = 0; $('bCam').textContent = CAMS[ui.cam]; toast(`Camera: ${CAMS[ui.cam]}`, 1.5); requestAnimationFrame(sizePanel); }
$('bCam').textContent = CAMS[ui.cam];
$('bCam').addEventListener('click', (e) => { cycleCam(); e.currentTarget.blur(); });
function toggleInstr() { ui.instr = !ui.instr; store.set('instr', ui.instr); $('instr').hidden = !ui.instr; $('bInstr').setAttribute('aria-pressed', String(ui.instr)); sizePanel(); }
$('instr').hidden = !ui.instr; $('bInstr').setAttribute('aria-pressed', String(ui.instr));
$('bInstr').addEventListener('click', (e) => { toggleInstr(); e.currentTarget.blur(); });
$('bReset').addEventListener('click', (e) => { restart(); e.currentTarget.blur(); });
function togglePanel(force) {
  const side = $('side'), show = force ?? side.hidden;
  side.hidden = !show; $('bPanel').setAttribute('aria-expanded', String(show));
}
$('bPanel').addEventListener('click', (e) => { togglePanel(); e.currentTarget.blur(); });
if (MOBILE || innerWidth < 900) togglePanel(false);
function togglePause() { ui.paused = !ui.paused; toast(ui.paused ? 'Paused (Space to resume)' : 'Resumed', ui.paused ? 1e9 : 1.2); }

// Mouse: drag to look around, wheel to zoom.
const look = { yaw: 0, pitch: 0, dist: P.chase, drag: false, x: 0, y: 0, held: false };
canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && e.isPrimary === false) return; look.drag = true; look.held = true; look.x = e.clientX; look.y = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!look.drag) return;
  look.yaw -= (e.clientX - look.x) * 0.006; look.pitch = clamp(look.pitch + (e.clientY - look.y) * 0.005, -1.2, 1.2);
  look.x = e.clientX; look.y = e.clientY;
});
const endDrag = () => { look.drag = false; look.held = false; };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => { look.dist = clamp(look.dist * (1 + Math.sign(e.deltaY) * 0.1), P.zoom[0], P.zoom[1]); e.preventDefault(); }, { passive: false });

// ---------- Instrument panel ----------
const panelCv = $('panelCv'), pctx = panelCv.getContext('2d');
let panelLayout = 'row';
function sizePanel() {
  const r = panelCv.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.min(devicePixelRatio, 2);
  panelCv.width = Math.round(r.width * dpr); panelCv.height = Math.round(r.height * dpr);
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  panelLayout = 'row';
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = w < h ? 75 : 60; camera.updateProjectionMatrix();
  const L = $('labels'), d = Math.min(devicePixelRatio, 2);
  L.width = w * d; L.height = h * d; lctx.setTransform(d, 0, 0, d, 0, 0);
  sizePanel();
}
const lctx = $('labels').getContext('2d');
addEventListener('resize', resize);
resize();

// ---------- HUD ----------
const hRead = $('hRead');
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
function hud() {
  if (P.jet) { jetHud(); return; }
  $('hIas').innerHTML = `${fmt(Math.max(0, c[K.ias]))}<small>KIAS</small>`;
  $('hAlt').innerHTML = `${fmt(c[K.alt])}<small>FT MSL</small>`;
  const hdg = String(Math.round(((c[K.dg] % 360) + 360) % 360) || 360).padStart(3, '0');
  const rows = [
    ['Ground speed', `${fmt(s[12])} kt`], ['Vertical', `${fmt(c[K.vsi])} fpm`], ['Heading', `${hdg}°`],
    ['Above field', `${fmt(Math.max(0, s[14]))} ft`], ['Engine', s[30] ? `${fmt(s[19])} rpm` : 'stopped'],
    ['Manifold', `${fmt(s[20], 1)} inHg`], ['Fuel', `${fmt(s[52])} L`], ['Flaps', `${fmt(s[26])}°`],
    ['Trim', `${fmt(s[27] * 100)} %`], ['Load', `${fmt(s[18], 2)} g`], ['α', s[11] > 25 ? `${fmt(s[16], 1)}°` : '—'],
    ['Brakes', s[49] ? 'PARKING SET' : input.brake ? 'on' : 'off'],
  ];
  hRead.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  $('lThr').style.height = `${input.throttle * 100}%`;
  $('lMix').style.height = `${input.mixture * 100}%`;
  $('lFlp').style.height = `${clamp(s[26] / 30, 0, 1) * 100}%`;
  if (MOBILE) $('thr').querySelector('i').style.top = `${(1 - input.throttle) * (170 - 34) + 2}px`;
}

function jetHud() {
  $('hIas').innerHTML = `${fmt(Math.max(0, c[K.ias]))}<small>KIAS</small>`;
  $('hAlt').innerHTML = `${fmt(c[K.alt])}<small>FT MSL</small>`;
  const hdg = String(Math.round(((c[K.dg] % 360) + 360) % 360) || 360).padStart(3, '0');
  const gear = j[1] > 0.999 ? 'down' : j[1] < 0.001 ? 'up' : 'in transit';
  const rows = [
    ['Mach', j[5] > 0.2 ? fmt(j[5], 3) : '—'], ['Ground speed', `${fmt(s[12])} kt`], ['Vertical', `${fmt(c[K.vsi])} fpm`],
    ['Heading', `${hdg}°`], ['Above field', `${fmt(Math.max(0, s[14]))} ft`],
    ['N1 L / R', `${fmt(j[8], 1)} / ${fmt(j[16], 1)} %`], ['Fuel flow', `${fmt(j[7] * 2.20462 / 10) * 10 || 0} lb/h`],
    ['Fuel', `${fmt(j[6] * 2.20462)} lb`], ['Flaps', `${fmt(j[27])}°`], ['Gear', gear], ['Speedbrake', j[3] > 0.02 ? `${fmt(j[3] * 100)} %` : 'retracted'],
    ['Load', `${fmt(s[18], 2)} g`], ['Brakes', s[49] ? 'PARKING SET' : input.brake ? 'on' : 'off'],
  ];
  hRead.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  $('lThr').style.height = `${input.throttle * 100}%`;
  $('lMix').style.height = `${j[3] * 100}%`;
  $('lFlp').style.height = `${clamp(j[27] / 39, 0, 1) * 100}%`;
  if (MOBILE) $('thr').querySelector('i').style.top = `${(1 - input.throttle) * (170 - 34) + 2}px`;
}
const FMA = ['EASY · WING LEVEL · AUTO TRIM', 'SPORT · AUTO COORD', 'MANUAL'];
function jetData() {
  return {
    ias: c[K.ias], alt: c[K.alt], baro: c[K.kollsman], vsi: c[K.vsi], pitch: c[K.aiPitch], roll: c[K.aiRoll], hdg: c[K.dg], bug: c[K.bug],
    ball: c[K.ball], stall: c[K.stall] > 0.5, mach: j[5], gs: s[12], tas: j[26], agl: Math.max(0, s[14]), vmo: j[25], mmo: j[24],
    assist: FMA[ui.assist], n1: [j[8], j[16]], n2: [j[9], j[17]], itt: [j[10], j[18]], ff: [j[11], j[19]], oil: [j[30], j[31]],
    run: [j[13], j[21]], starting: [j[14], j[22]], fuelSw: [j[15], j[23]], n1cmd: 22 + 78 * input.throttle,
    fuelKg: j[6], gear: j[1], spd: j[3], flaps: j[27], wow: j[29], park: s[49],
    x: s[0], y: s[1], trueHdg: s[9], rangeNm: 10, runway: RW, points: LANDMARKS,
  };
}

// ---------- Cameras ----------
let snapCamera = true;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const TOWER = enu(rwMid[0] + rwDir[0] * -120 + rwRight[0] * 140, rwMid[1] + rwDir[1] * -120 + rwRight[1] * 140, ELEV + 26);
function updateCamera(dt) {
  const target = bodyPoint(...P.target);
  const inside = ui.cam === 1;
  cabin.root.visible = inside;
  aircraft.glass.opacity = inside ? 0.06 : 0.88;
  $('instr').hidden = !ui.instr || inside;
  $('hud').style.display = inside ? 'none' : '';
  if (!look.held && ui.cam !== 2) { look.yaw *= Math.exp(-dt * 1.5); look.pitch *= Math.exp(-dt * 1.5); }
  camera.near = ui.cam === 1 ? 0.08 : 0.5;
  if (ui.cam === 1) {
    eye.getWorldPosition(camera.position); eye.getWorldQuaternion(camera.quaternion);
    camera.rotateY(look.yaw); camera.rotateX(-look.pitch * 0.8 - 0.17);
    camera.fov = innerWidth < innerHeight ? 82 : 70;
  } else if (ui.cam === 3) {
    camera.position.copy(TOWER); camera.lookAt(target);
    camera.fov = clamp(Math.atan2(P.tower, TOWER.distanceTo(target)) * 2 / DEG, 2, 60);
  } else {
    // Chase follows the track (heading when slow); orbit is fully mouse-driven.
    const h = (ui.cam === 0 ? s[9] * DEG : 0) + look.yaw, el = (ui.cam === 0 ? 0.2 : 0.35) + look.pitch;
    const d = ui.cam === 0 ? look.dist : look.dist * 1.6;
    const want = target.clone().add(new THREE.Vector3(-Math.sin(h) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(h) * Math.cos(el) * d));
    want.y = Math.max(want.y, ELEV + 1.2);
    if (snapCamera) camPos.copy(want); else camPos.lerp(want, 1 - Math.exp(-dt * (ui.cam === 0 ? 5 : 12)));
    camLook.copy(target);
    camera.position.copy(camPos); camera.lookAt(camLook);
    camera.fov = innerWidth < innerHeight ? 75 : 60;
  }
  snapCamera = false;
  camera.updateProjectionMatrix();
  skyDome.position.copy(camera.position);
  // Shadow follows the airplane; fog opens up with height.
  const agl = Math.max(0, s[2] - ELEV);
  sun.target.position.copy(target);
  sun.position.copy(target).addScaledVector(SUN_DIR, agl / SUN_DIR.y + 60);
  sun.shadow.camera.far = agl / SUN_DIR.y + 120; sun.shadow.camera.updateProjectionMatrix();
  if (ui.flow === 2) { scene.fog.near = 1.5 * P.chase; scene.fog.far = 7 * P.chase; }
  else { scene.fog.near = 2500 + agl * 3; scene.fog.far = 22000 + agl * 12; }
}

// ---------- Landmark labels ----------
const labelPts = [...LANDMARKS.map(([n, x, y]) => [n, x, y, 60]), ['Campo de Marte', rwMid[0], rwMid[1], 40]];
const v = new THREE.Vector3();
function drawLabels() {
  const w = innerWidth, h = innerHeight;
  lctx.clearRect(0, 0, w, h);
  if (ui.cam === 1 && innerHeight < 500) return;
  lctx.font = `600 ${MOBILE ? 11 : 12}px "Public Sans",system-ui,sans-serif`;
  lctx.textAlign = 'center';
  for (const [name, x, y, up] of labelPts) {
    const dist = Math.hypot(x - s[0], y - s[1]);
    if (dist > 14000 || dist < 150) continue;
    v.set(x, ELEV + up, -y).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
    const px = (v.x + 1) / 2 * w, py = (1 - v.y) / 2 * h;
    const a = clamp(1.4 - dist / 10000, 0.35, 1);
    lctx.globalAlpha = a;
    lctx.strokeStyle = 'rgba(255,255,255,.7)'; lctx.lineWidth = 1;
    lctx.beginPath(); lctx.moveTo(px, py); lctx.lineTo(px, py - 12); lctx.stroke();
    const txt = `${name} · ${dist < 1000 ? Math.round(dist) + ' m' : (dist / 1000).toFixed(1) + ' km'}`;
    const tw = lctx.measureText(txt).width + 12;
    lctx.fillStyle = 'rgba(10,17,28,.72)'; lctx.fillRect(px - tw / 2, py - 32, tw, 19);
    lctx.fillStyle = '#e7ecf2'; lctx.fillText(txt, px, py - 18);
  }
  lctx.globalAlpha = 1;
}

// ---------- Events ----------
function handleEvents() {
  for (const e of A.events()) {
    if (e.startsWith('Touchdown')) {
      const fpm = Math.abs(+(e.match(/(-?\d+) fpm/)?.[1] || 0));
      toast(fpm > 600 ? `Hard landing: ${fpm} fpm` : fpm > 300 ? `Touchdown: ${fpm} fpm, firm` : `Touchdown: ${fpm} fpm, smooth`);
    } else if (/tail/.test(e)) {
      toast('Tail strike! Rotate less steeply.', 3);
    } else if (e.startsWith('PROPELLER STRIKE') || e.startsWith('Airframe ground contact')) {
      ui.crashed = true; toast(`${e}. Press R to restart.`, 1e9);
    } else if (!e.includes(' -> ')) toast(e);
  }
  if (s[48] && !ui.crashed) { ui.crashed = true; toast('The airplane is damaged beyond flight. Press R to restart.', 1e9); }
}

// ---------- Airflow view ----------
const FLOW = ['Airflow', 'Airflow: on', 'Wind tunnel'];
ui.flow = 0;
const DARK = new THREE.Color('#05080d');
function cycleFlow() {
  ui.flow = (ui.flow + 1) % 3;
  flow.group.visible = ui.flow > 0;
  flow.reset();
  $('bFlow').textContent = FLOW[ui.flow];
  $('bFlow').setAttribute('aria-pressed', String(ui.flow > 0));
  $('flowLegend').hidden = ui.flow === 0;
  const tunnel = ui.flow === 2;
  scene.background = tunnel ? DARK : SKY;
  scene.fog.color.copy(tunnel ? DARK : SKY);
  skyDome.visible = !tunnel;
  if (ui.flow === 1) toast('Airflow: streamlines from the lift the physics is making, coloured by pressure. Orbit camera recommended (C).', 5);
  if (tunnel) toast('Wind tunnel: the world goes dark so the flow stands out. V again to turn it off.', 4);
}
$('bFlow').addEventListener('click', (e) => { cycleFlow(); e.currentTarget.blur(); });

// ---------- Aircraft selection ----------
function applyProfileUi() {
  document.querySelectorAll('[data-aircraft]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aircraft === P.id)));
  $('lMixLbl').textContent = P.jet ? 'SPD BRK' : 'MIX';
  document.querySelector('[data-fail="fuel"]').textContent = P.jet ? 'Engine 1 cut-off' : 'Fuel shutoff';
  document.querySelector('[data-fail="2"]').hidden = P.jet;
  document.querySelector('[data-fail="3"]').textContent = P.jet ? 'Generators' : 'Alternator';
  document.querySelectorAll('.jetonly').forEach((el) => { el.hidden = !P.jet; });
  document.querySelectorAll('.pistononly').forEach((el) => { el.hidden = P.jet; });
  $('plateSub').textContent = `Flight test bed · ${P.name}`;
  document.title = `Flight Test Bed · ${P.name}`;
}
async function selectAircraft(id) {
  if (P.id === id) return;
  const next = PROFILES[id];
  try {
    loadInto(await fetchDef(next));
  } catch (e) { toast('Could not load the aircraft: ' + e.message, 6); return; }
  audio.stop();
  P = next;
  store.set('aircraft', P.id);
  try { history.replaceState(null, '', P.jet ? '#topg' : '#172'); } catch { /* sandboxed */ }
  audio = P.jet ? audios.jet : audios.piston;
  if (ui.sound) audio.start();
  useRig(P);
  flow.reset();
  look.dist = P.chase;
  STARTS = P.jet ? JET_STARTS : PISTON_STARTS;
  buildStarts();
  applyProfileUi();
  setAssist(ui.assist);
  restart(0);
  sizePanel();
}
document.querySelectorAll('[data-aircraft]').forEach((b) => b.addEventListener('click', () => { selectAircraft(b.dataset.aircraft); b.blur(); }));

// ---------- Loop ----------
applyProfileUi();
setAssist(ui.assist);
restart(0);
$('loading').hidden = true;
$('loading').style.display = 'none';
const clock = new THREE.Clock();
let panelT = 0, cabinT = 1, swT = 1;
const sw = { bat: 1, alt: 1, avionics: 1, beacon: 0, land: 0, taxi: 0, nav: 0, strobe: 0, pitot: 0, mags: 3, flaps: 0, fuelSel: 1 };
function readSwitches() {
  const p = Object.fromEntries(A.cockpit().map((x) => [x.id, x.position]));
  Object.assign(sw, {
    bat: p['electrical.battery'], alt: p['electrical.alternator'], avionics: p['electrical.avionics'],
    beacon: p['electrical.load.beacon'], land: p['electrical.load.landing_light'], taxi: p['electrical.load.taxi_light'],
    nav: p['electrical.load.nav_lights'], strobe: p['electrical.load.strobes'], pitot: p['electrical.load.pitot_heat'],
    mags: p['engine1.ignition'], flaps: p['flaps.lever'], fuelSel: p['fuel.selector'],
  });
}
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!document.hidden) adaptRes(dt);
  if (!ui.paused && !ui.crashed) {
    readInputs(dt);
    // Parking brake: Easy releases it for you when you open the throttle.
    if (s[49] && s[28] && input.throttle > 0.35) {
      if (ui.assist === 0) { setControl('brakes.parking', 0); toast('Parking brake released.', 2); }
      else if (!parkHint) { parkHint = true; toast('The parking brake is set: P releases it.'); }
    }
    A.avd_set_input(input.pitch, input.roll, input.yaw, input.throttle, input.mixture, input.brake, input.brake, input.trimRate, 0);
    A.avd_advance(dt);
  }
  s = A.state().slice(); c = A.cockpitState().slice(); j = A.jet().slice();
  handleEvents();
  // Airplane pose: datum position and body FLU → ENU attitude.
  acGroup.position.copy(enu(s[0], s[1], s[2]));
  acGroup.quaternion.copy(qM).multiply(qBody.set(s[4], s[5], s[6], s[3]));
  if (P.jet) aircraft.update({ flapDeg: s[26], aileron: s[45], elevator: s[46], rudder: s[47], n1: [j[8], j[16]], gear: j[1], speedbrake: j[3], lights: !!(j[13] || j[21]) }, ui.paused ? 0 : dt);
  else aircraft.update({ flapDeg: s[26], aileron: s[45], elevator: s[46], rudder: s[47], rpm: ui.paused ? 0 : s[19], disc: ui.cam === 1 ? 0.15 : 1 }, ui.paused ? 0 : dt);
  if (ui.flow) {
    const fr = flow.update(A.flow(), ui.paused ? 0 : dt, { ...P, span: def.reference.span_m });
    $('flowStall').textContent = fr.stalled ? `${fr.stalled} strip${fr.stalled > 1 ? 's' : ''} stalled` : 'no stalled strips';
  }
  acGroup.updateMatrixWorld(true);
  updateCamera(dt);
  renderer.render(scene, camera);
  drawLabels();
  $('warn').classList.toggle('on', c[K.stall] > 0.5 && !ui.crashed);
  hud();
  panelT += dt; cabinT += dt; swT += dt;
  if (swT > 0.2) { swT = 0; readSwitches(); }
  if (P.jet) {
    cabin.update({ elev: s[46], ail: s[45], rud: s[47], thr: input.throttle, spd: j[4] / 2, flapLever: sw.flaps, gearDown: !!j[2] });
    if (ui.cam === 1 && cabinT > 1 / 20) { cabinT = 0; cabin.redraw(jetData()); }
  } else {
    cabin.update({ elev: s[46], ail: s[45], rud: s[47], trim: s[27], thr: input.throttle, mix: input.mixture, flapLever: sw.flaps, fuelSel: sw.fuelSel });
    if (ui.cam === 1 && cabinT > 1 / 30) { cabinT = 0; cabin.redraw(c, M, sw, s, c[K.compass]); }
  }
  if (ui.instr && ui.cam !== 1 && panelT > 1 / 30) {
    panelT = 0;
    const r = panelCv.getBoundingClientRect();
    if (P.jet) drawJetStrip(pctx, r.width, r.height, jetData());
    else drawPanel(pctx, r.width, r.height, c, M, panelLayout);
  }
  if (P.jet) audio.update(ui.paused ? [0, 0] : [j[8], j[16]], ui.paused ? [0, 0] : [j[9], j[17]], (j[12] + j[20]) / 150, j[26], c[K.stall] > 0.5, ui.cam === 1);
  else audio.update(ui.paused ? 0 : s[19], s[20], s[11], c[K.stall] > 0.5, ui.cam === 1);
  if (toastT > 0 && (toastT -= dt) <= 0) toastEl.classList.remove('on');
}
requestAnimationFrame(frame);
