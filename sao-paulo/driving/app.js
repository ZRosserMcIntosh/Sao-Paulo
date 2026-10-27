// São Paulo World · driving test track.
// Physics: the OpenRoad Dynamics core (github.com/ZRosserMcIntosh/Game-Vehicle-Dynamics, MIT)
// compiled to WebAssembly. Rendering: three.js (MIT). This file only renders and reads input;
// every force, slip and aid intervention comes from the core.
import * as THREE from 'three';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/libs/meshopt_decoder.module.js';
import createOrdModule from './ord.mjs';
import { CarAudio } from './audio/audio.js';
import { VOICES } from './audio/engines.js';
import { loadCity, streetNamer } from './city.js';
import { BikeView } from './bike.js';
import { Destruction } from './destruction.js';
import { CrashDummies } from './dummies.js';
import { Garage } from './garage.js';
import { PhysicsOverlay } from './overlay.js';
import { MooseTest } from './moose.js';
import { Crumple } from './crumple.js';
import { CrashLab, TESTS as LAB_TESTS } from './crashlab.js';
import { Rewind, GhostCar } from './rewind.js';
import { Weather, RAIN_LEVELS } from './weather.js';
import { StuntPark } from './stunts.js';
import { GlassFX } from './glassfx.js';
import { CarFlowView } from './carflow.js';
import { TelemetryPanel, captureTelemetry, REC } from './telemetry.js';
import { ReplayViewer } from './replay.js';
import { WindTunnel } from './tunnel.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw-drive:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw-drive:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------- Physics module ----------
let M;
try {
  M = await createOrdModule();
} catch (e) {
  $('loadMsg').textContent = 'Could not start the WebAssembly physics in this browser: ' + e.message;
  throw e;
}
const HEADER = M._ord_state_header(), PER_WHEEL = M._ord_state_per_wheel();
const statePtr = M._ord_state() / 8;
const S = (i) => M.HEAPF64[statePtr + i];
const W = (w, i) => M.HEAPF64[statePtr + HEADER + PER_WHEEL * w + i];
// Per site car id: 0-5 generic cars + Rosser V8, 6-8 two-wheelers, 9-13 real-car approximations
// (engine indices 6-10: 911 Carrera S, 911 Carrera 4S, AMG S 63, S 600 Guard, F1 2026).
const MAXSTEER = [0.55, 0.60, 0.55, 0.55, 0.35, 0.55, 0, 0, 0, 0.50, 0.50, 0.54, 0.52, 0.30]; // full-lock road-wheel angle (rad)
const engineCar = (c) => (c >= 9 ? c - 3 : c);
// Two-wheelers (vehicle 6 bicycle, 7 e-scooter, 8 motorcycle): their own state buffer.
const bikePtr = M._ord_bike_state() / 8;
const B = (i) => M.HEAPF64[bikePtr + i];
const BIKE_LOCK = [1.2, 0.9, 0.55];
const BIKE_NAMES = ['Bicycle', 'E-scooter', 'Motorcycle'];
const isBike = () => settings.car >= 6 && settings.car <= 8;
const LIMITER = [7200, 6500, 6800, 8500, 12500, 9000, 0, 0, 12500, 7500, 7500, 6500, 5800, 15000];
// Engine voice per car (audio/engines.js): each layout sounds like itself. Index 8 = motorcycle.
const VOICE = ['refSports', 'refHatch', 'refSaloon', 'refHyper', 'refRace', 'stella', null, null, 'motorcycle', 'porsche911', 'porsche911', 'amgS63', 's600Guard', 'f1'];
const setVoice = () => { try { audio.setVoice(VOICES[VOICE[settings.car]] || VOICES.stella); } catch { /* audio not built yet */ } };
const G = 9.81;

// ISO 8855 (x forward, y left, z up) -> three.js (y up): (x, z, -y)
const v3 = (x, y, z) => new THREE.Vector3(x, z, -y);

// ---------- World ----------
// 'city' (default): the 500 x 500 m São Paulo World tile around MASP. 'track': the test track.
const WORLD = (() => {
  const q = new URLSearchParams(location.search).get('world');
  if (q === 'city' || q === 'track') { store.set('world', q); return q; }
  return store.get('world', 'city') === 'track' ? 'track' : 'city';
})();
function switchWorld(w) { store.set('world', w); const u = new URL(location.href); u.searchParams.set('world', w); location.href = u.href; }

// ---------- Share links: ?car=&setup=&rain=&zone= (see shareLink below) ----------
const SHARE = (() => {
  const q = new URLSearchParams(location.search);
  const o = { car: q.has('car') ? +q.get('car') : null, setup: q.get('setup'), rain: q.has('rain') ? +q.get('rain') : null, zone: q.get('zone'), preset: q.has('preset') ? +q.get('preset') : null };
  return o.car !== null || o.setup || o.rain !== null || o.zone ? o : null;
})();
async function inflateSetup(b64) {
  const bin = Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  if (typeof DecompressionStream === 'function') {
    try { return await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text(); } catch { /* not compressed */ }
  }
  return new TextDecoder().decode(bin);
}
async function deflateSetup(json) {
  let bin = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'function') bin = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  let s = ''; for (const b of bin) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
if (SHARE?.car !== null && SHARE?.car !== undefined && SHARE.car >= 0 && SHARE.car <= 13) { store.set('car', SHARE.car); store.set('stellaPhysics', true); }
if (SHARE?.setup && SHARE.car !== null) {
  try { store.set('setup' + SHARE.car, JSON.parse(await inflateSetup(SHARE.setup))); } catch (e) { console.warn('shared setup unreadable', e); }
}
if (SHARE?.preset !== null && SHARE?.preset !== undefined && SHARE.preset >= 0 && SHARE.preset <= 3) store.set('preset', SHARE.preset);

// ---------- Settings ----------
const settings = {
  car: store.get('stellaPhysics', false) ? store.get('car', 5) : 5, // the Stella's own physics is the default
  preset: store.get('preset', 0),
  abs: true, tcs: 2, esc: 2, auto: true, drift: 0,
  cam: store.get('cam', 0),
  barTorque: store.get('barTorque', false),       // two-wheelers: steer input = handlebar torque
  lock: store.get('driftLock', false),            // drift steering lock (0.9 rad) on the cars
  diff: store.get('diff', -1),                    // rear diff: -1 stock, 0 open, 1 locked, 2 tight LSD
  dummies: store.get('dummies', true), belted: store.get('belted', true), airbags: store.get('airbags', true), xray: store.get('xray', false),
  damage: store.get('damage', 'cosmetic'),
};
function presetAids(p) {
  if (p === 0) return { abs: true, tcs: 2, esc: 2, auto: true, drift: 0 };
  if (p === 1) return { abs: true, tcs: 1, esc: 0, auto: true, drift: 0 };
  if (p === 3) return { abs: true, tcs: 0, esc: 0, auto: true, drift: 1 };
  return { abs: false, tcs: 0, esc: 0, auto: false, drift: 0 };
}
Object.assign(settings, presetAids(settings.preset));

// ---------- Renderer & scene ----------
const canvas = $('view');
// Phones and tablets: lighter car model, no MSAA, smaller shadows, and a render resolution that
// adapts to the frame rate (see adaptRes below).
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, powerPreference: 'high-performance' });
const RES = { max: Math.min(devicePixelRatio, MOBILE ? 1.5 : 2), min: MOBILE ? 0.6 : 1, cur: 0, acc: 0, n: 0 };
RES.cur = MOBILE ? Math.min(RES.max, 1.1) : RES.max;
renderer.setPixelRatio(RES.cur);
function adaptRes(dt) {
  RES.acc += dt; RES.n++;
  if (RES.acc < 1.5) return;
  const avg = RES.acc / RES.n; RES.acc = 0; RES.n = 0;
  let next = RES.cur;
  if (avg > 1 / 40) next = Math.max(RES.min, RES.cur * 0.85);       // under ~40 fps: drop resolution
  else if (avg < 1 / 57) next = Math.min(RES.max, RES.cur * 1.07);  // comfortably fast: raise it
  if (Math.abs(next - RES.cur) > 0.01) { RES.cur = next; renderer.setPixelRatio(next); resize(); }
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = MOBILE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
const SKY = new THREE.Color('#9fb8d3');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 180, 900);
const camera = new THREE.PerspectiveCamera(60, 1, 0.2, 2000);
const hemi = new THREE.HemisphereLight('#dbe8ff', '#4a4136', 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff4e0', 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 200 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.5, 1, 0.35).normalize();
sun.shadow.normalBias = 0.03; // no shadow acne (black speckles) on the car's curved panels

// Outdoor reflection environment, baked once: sky gradient, bright horizon, dark asphalt below and
// a hot sun. Every PBR material reflects it, which is what makes metallic paint and chrome read
// as metal instead of flat plastic.
{
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vP; void main(){
      float y = vP.y;
      vec3 zen = vec3(0.16, 0.30, 0.62), hor = vec3(0.80, 0.86, 0.92), gnd = vec3(0.05, 0.05, 0.055);
      vec3 c = y > 0.0 ? mix(hor, zen, pow(y, 0.55)) : mix(hor * 0.45, gnd, pow(-y, 0.35));
      gl_FragColor = vec4(c, 1.0); }`,
  })));
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.86).multiplyScalar(30) }));
  sunBall.position.copy(SUN_DIR).multiplyScalar(45);
  env.add(sunBall);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(env, 0.02).texture;
  pm.dispose();
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 78 : 60; // portrait phones need a wider view of the road
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- Test track (world=track) ----------
const TRACK = WORLD === 'track' ? scene : new THREE.Group();
// ---------- Proving ground ----------
function asphaltTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#4b4f55'; g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 34;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const asphalt = asphaltTexture();
{
  const tex = asphalt.clone(); tex.needsUpdate = true; tex.repeat.set(280, 200);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1000),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.copy(v3(200, -20, 0));
  ground.receiveShadow = true;
  TRACK.add(ground);
  // grass beyond the pad
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(20000, 6000), new THREE.MeshStandardMaterial({ color: '#56703f', roughness: 1 }));
  grass.rotation.x = -Math.PI / 2; grass.position.set(4000, -0.6, 0); TRACK.add(grass);
}
// Road paint and overlays sit on the pad via polygon offset (robust on 16-bit depth buffers).
const decal = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
const paint = new THREE.MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.7, ...decal });
const yellowPaint = new THREE.MeshStandardMaterial({ color: '#f0c419', roughness: 0.7, ...decal });
function stripe(x0, y0, x1, y1, w, mat = paint) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(len, w), mat);
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = Math.atan2(y1 - y0, x1 - x0);
  m.position.copy(v3((x0 + x1) / 2, (y0 + y1) / 2, 0.003));
  m.receiveShadow = true;
  TRACK.add(m);
}
// Straight: 8 km, long enough for every car to reach its top speed and still brake
// (Sports RWD: ~300 km/h by 4 km; Hypercar: ~474 km/h by 5.2 km). Edge lines, dashed centre,
// start line, distance boards, braking boards before the end.
const STRAIGHT_END = 8000;
{
  const tex = asphalt.clone(); tex.needsUpdate = true; tex.repeat.set((STRAIGHT_END - 880) / 5, 36 / 5);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(STRAIGHT_END - 880, 36), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }));
  road.rotation.x = -Math.PI / 2; road.position.copy(v3((880 + STRAIGHT_END) / 2 + 20, 0, -0.002)); road.receiveShadow = true;
  TRACK.add(road);
  // long thin stripes are split so each piece stays well-conditioned on the GPU
  for (let x = -40; x < STRAIGHT_END; x += 500) { const x1 = Math.min(STRAIGHT_END, x + 500); stripe(x, 6, x1, 6, 0.15); stripe(x, -6, x1, -6, 0.15); }
  const dashes = [];
  for (let x = -40; x < STRAIGHT_END; x += 12) dashes.push(x);
  const dg = new THREE.PlaneGeometry(6, 0.12); dg.rotateX(-Math.PI / 2);
  const inst = new THREE.InstancedMesh(dg, paint, dashes.length);
  const mtx = new THREE.Matrix4();
  dashes.forEach((x, i) => { mtx.makeTranslation(x + 3, 0.003, 0); inst.setMatrixAt(i, mtx); });
  inst.receiveShadow = true; TRACK.add(inst);
  stripe(0, -6, 0, 6, 0.5);
  stripe(STRAIGHT_END, -6, STRAIGHT_END, 6, 0.5, yellowPaint);
  // end-of-road barrier
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 30), new THREE.MeshStandardMaterial({ color: '#d43a2c', roughness: 0.6 }));
  wall.position.copy(v3(STRAIGHT_END + 60, 0, 0.55)); wall.castShadow = true; TRACK.add(wall);
}
// Skidpad R40, centre (120, 110)
const SKID = { x: 120, y: 110, r: 40 };
{
  const ring = new THREE.Mesh(new THREE.RingGeometry(SKID.r - 0.15, SKID.r + 0.15, 256), yellowPaint);
  ring.rotation.x = -Math.PI / 2; ring.position.copy(v3(SKID.x, SKID.y, 0.002)); TRACK.add(ring);
  for (const r of [36, 44]) {
    const g = new THREE.Mesh(new THREE.RingGeometry(r - 0.08, r + 0.08, 256), paint);
    g.rotation.x = -Math.PI / 2; g.position.copy(v3(SKID.x, SKID.y, 0.002)); TRACK.add(g);
  }
}
// Wet section (matches the patch in ord_web.cpp: x 250..450, y 25..75)
{
  const wet = new THREE.Mesh(new THREE.PlaneGeometry(200, 50),
    new THREE.MeshStandardMaterial({ color: '#1f2a36', roughness: 0.08, metalness: 0.35, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  wet.rotation.x = -Math.PI / 2; wet.position.copy(v3(350, 50, 0.001)); wet.receiveShadow = true; TRACK.add(wet);
  stripe(250, 25, 450, 25, 0.2, yellowPaint); stripe(250, 75, 450, 75, 0.2, yellowPaint);
}
// Bump lane: height field sampled from the physics' own ground function
const LANE_Y = M._ord_bump_lane_y();
{
  const x0 = 40, x1 = 300, y0 = LANE_Y - 4, y1 = LANE_Y + 4, dx = 0.1, dy = 0.1;
  const nx = Math.round((x1 - x0) / dx) + 1, ny = Math.round((y1 - y0) / dy) + 1;
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  const asphaltC = new THREE.Color('#ffffff'), kerbR = new THREE.Color('#d22a1f'), kerbW = new THREE.Color('#f4f4f4'), bumpC = new THREE.Color('#f0c419');
  for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) {
    const x = x0 + i * dx, y = y0 + j * dy, h = M._ord_ground_height(x, y);
    const k = j * nx + i;
    pos.set([x, h, -y], k * 3);
    uv.set([x / 5, y / 5], k * 2);
    let c = asphaltC;
    const e = y - (LANE_Y + 3);
    if (e > 0 && e < 0.6) c = Math.floor(x) % 2 ? kerbR : kerbW;
    else if (h > 0.004 && Math.abs(y - LANE_Y) < 3) c = Math.floor(y * 2) % 2 ? bumpC : asphaltC;
    col.set([c.r, c.g, c.b], k * 3);
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let p = 0;
  for (let j = 0; j < ny - 1; ++j) for (let i = 0; i < nx - 1; ++i) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx.set([a, b, c, b, d, c], p); p += 6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const tex = asphalt.clone(); tex.needsUpdate = true;
  const lane = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  lane.receiveShadow = true;
  lane.position.y = 0.001;
  TRACK.add(lane);
  stripe(0, LANE_Y - 3, 40, LANE_Y - 3, 0.15); stripe(0, LANE_Y + 3, 40, LANE_Y + 3, 0.15);
}
// ---------- Proving ground (default start), west of the drag strip ----------
// Everything here comes from the physics' own ground (ord_web.cpp): heights are sampled from
// M._ord_ground_height, wet areas match its wet patches exactly.
const PG = { bumpY: M._ord_proving_bump_y(), splitY: M._ord_proving_split_y(), x0: -440, x1: -110,
  dry: { x: -300, y: 55, r: 30 }, wet: { x: -170, y: 55, r: 25 } };
const wetMat = new THREE.MeshStandardMaterial({ color: '#1f2a36', roughness: 0.08, metalness: 0.35, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
function wetPlane(x0, x1, y0, y1) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), wetMat);
  m.rotation.x = -Math.PI / 2; m.position.copy(v3((x0 + x1) / 2, (y0 + y1) / 2, 0.001)); m.receiveShadow = true; TRACK.add(m);
}
function ring(c, r, mat, w = 0.15) {
  const g = new THREE.Mesh(new THREE.RingGeometry(r - w, r + w, 256), mat);
  g.rotation.x = -Math.PI / 2; g.position.copy(v3(c.x, c.y, 0.003)); TRACK.add(g);
}
{
  // central lane into the drag strip
  stripe(-470, 6, -40, 6, 0.15); stripe(-470, -6, -40, -6, 0.15);
  for (let x = -470; x < -40; x += 12) stripe(x, 0, x + 6, 0, 0.12);
  // bump course: height field sampled from the physics
  const x0 = PG.x0, x1 = PG.x1, y0 = PG.bumpY - 4, y1 = PG.bumpY + 4, dx = 0.1, dy = 0.1;
  const nx = Math.round((x1 - x0) / dx) + 1, ny = Math.round((y1 - y0) / dy) + 1;
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  const base = new THREE.Color('#ffffff'), up = new THREE.Color('#f0c419'), down = new THREE.Color('#5aa0ff');
  for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) {
    const x = x0 + i * dx, y = y0 + j * dy, h = M._ord_ground_height(x, y), k = j * nx + i;
    pos.set([x, h, -y], k * 3); uv.set([x / 5, y / 5], k * 2);
    const c = h > 0.004 ? up : h < -0.004 ? down : base;
    col.set([c.r, c.g, c.b], k * 3);
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let p = 0;
  for (let j = 0; j < ny - 1; ++j) for (let i = 0; i < nx - 1; ++i) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.set([a, b, c, b, d, c], p); p += 6; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const tex = asphalt.clone(); tex.needsUpdate = true;
  const lane = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  lane.receiveShadow = true; lane.position.y = 0.001; TRACK.add(lane);
  stripe(x0, PG.bumpY - 4, x1, PG.bumpY - 4, 0.15); stripe(x0, PG.bumpY + 4, x1, PG.bumpY + 4, 0.15);
  // split-mu lane: left wheel track wet
  wetPlane(PG.x0, PG.x1, PG.splitY, PG.splitY + 5);
  stripe(PG.x0, PG.splitY - 3.5, PG.x1, PG.splitY - 3.5, 0.15); stripe(PG.x0, PG.splitY, PG.x1, PG.splitY, 0.1, yellowPaint);
  // dry skidpad R30, wet skidpad R25 on a wet square
  ring(PG.dry, PG.dry.r, yellowPaint); ring(PG.dry, PG.dry.r - 4, paint, 0.08); ring(PG.dry, PG.dry.r + 4, paint, 0.08);
  wetPlane(-200, -140, 25, 85);
  ring(PG.wet, PG.wet.r, yellowPaint); ring(PG.wet, PG.wet.r - 4, paint, 0.08); ring(PG.wet, PG.wet.r + 4, paint, 0.08);
}

// Crash-test lane: run-up, a rigid concrete barrier (the physics' collider is its west face) and a
// 30 cm pole for side impacts.
const CRASH = { y: M._ord_crash_lane_y(), bx: M._ord_crash_barrier_x(), px: M._ord_crash_pole_x() };
if (WORLD === 'track') {
  stripe(-450, CRASH.y - 6, CRASH.bx, CRASH.y - 6, 0.15); stripe(-450, CRASH.y + 6, CRASH.bx, CRASH.y + 6, 0.15);
  for (let x = -450; x < CRASH.bx - 5; x += 12) stripe(x, CRASH.y, x + 6, CRASH.y, 0.12, yellowPaint);
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#f0c419'; g.fillRect(0, 0, 256, 64); g.fillStyle = '#111';
  for (let i = -2; i < 12; ++i) { g.beginPath(); g.moveTo(i * 32, 64); g.lineTo(i * 32 + 16, 64); g.lineTo(i * 32 + 48, 0); g.lineTo(i * 32 + 32, 0); g.fill(); }
  const stripes = new THREE.CanvasTexture(c); stripes.colorSpace = THREE.SRGBColorSpace; stripes.wrapS = THREE.RepeatWrapping; stripes.repeat.set(4, 1);
  const concrete = new THREE.MeshStandardMaterial({ color: '#b9b6ae', roughness: 0.95 });
  const block = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.5, 16), [concrete, concrete, concrete, concrete, concrete, new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.8 })]);
  block.position.copy(v3(CRASH.bx + 0.6, CRASH.y, 0.75)); block.rotation.y = Math.PI; block.castShadow = block.receiveShadow = true; TRACK.add(block);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 6, 20), new THREE.MeshStandardMaterial({ color: '#8d9299', roughness: 0.4, metalness: 0.7 }));
  pole.position.copy(v3(CRASH.px, CRASH.y + 16, 3)); pole.castShadow = true; TRACK.add(pole);
  ring({ x: CRASH.px, y: CRASH.y + 16 }, 1.2, yellowPaint, 0.08);
}

// Smash lane: three breakable walls (glass storefront, hollow blocks, bricks) across three run-up
// lanes north of the crash lane. The walls are drawn from the physics' own segment list; when the
// physics breaks a section, its mesh is hidden and destruction.js makes the pieces.
const SMASH = { y: [0, 1, 2].map((k) => M._ord_smash_lane_y(k)), x: CRASH.bx };
const walls = {};  // physics segment index -> { def, mesh }
let wallsBuilt = false;
const destruction = new Destruction(THREE, scene);
function masonryTexture(kind) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = kind === 'brick' ? '#b9b2a6' : '#a7a7a3'; g.fillRect(0, 0, 512, 256);  // mortar
  const bw = kind === 'brick' ? 128 : 256, bh = kind === 'brick' ? 42.7 : 128, gap = kind === 'brick' ? 6 : 8;
  for (let r = 0; r * bh < 256; ++r) {
    const off = r % 2 ? bw / 2 : 0;
    for (let x = -bw; x < 512 + bw; x += bw) {
      const t = Math.random();
      g.fillStyle = kind === 'brick' ? `rgb(${150 + 55 * t | 0},${62 + 28 * t | 0},${48 + 16 * t | 0})` : `rgb(${125 + 25 * t | 0},${125 + 25 * t | 0},${120 + 25 * t | 0})`;
      g.fillRect(x + off + gap / 2, r * bh + gap / 2, bw - gap, bh - gap);
      if (kind !== 'brick') { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x + off + 18, r * bh + 14, bw / 2 - 30, bh - 28); g.fillRect(x + off + bw / 2 + 12, r * bh + 14, bw / 2 - 30, bh - 28); }
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function buildWalls() {
  if (wallsBuilt || WORLD !== 'track') return;
  wallsBuilt = true;
  const n = M._ord_obstacle_count(), o = new Float64Array(M.HEAPF64.buffer, M._ord_obstacles(), 8 * n);
  const frameMat = new THREE.MeshStandardMaterial({ color: '#2a2d31', roughness: 0.6, metalness: 0.4 });
  const paneMat = new THREE.MeshPhysicalMaterial({ color: '#cfe6f7', roughness: 0.05, metalness: 0.05, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  const mats = { 2: new THREE.MeshStandardMaterial({ map: masonryTexture('block'), roughness: 0.95 }), 3: new THREE.MeshStandardMaterial({ map: masonryTexture('brick'), roughness: 0.9 }) };
  const glassSpan = [];
  for (let i = 0; i < n; ++i) {
    const [ax, ay, bx, by, z0, z1, material] = o.subarray(8 * i, 8 * i + 8);
    if (material < 1) continue;
    const L = Math.hypot(bx - ax, by - ay), H = z1 - z0, yaw = Math.atan2(by - ay, bx - ax);
    const group = new THREE.Group();
    group.position.copy(v3((ax + bx) / 2, (ay + by) / 2, z0 + H / 2)); group.rotation.y = yaw;
    if (material === 1) {
      group.add(new THREE.Mesh(new THREE.BoxGeometry(L - 0.08, H - 0.08, 0.02), paneMat));
      for (const [y, h] of [[H / 2, 0.08], [-H / 2, 0.08]]) { const bar = new THREE.Mesh(new THREE.BoxGeometry(L, h, 0.1), frameMat); bar.position.y = y; bar.castShadow = true; group.add(bar); }
      for (const x of [-L / 2, L / 2]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, H, 0.1), frameMat); m.position.x = x; m.castShadow = true; group.add(m); }
      glassSpan.push({ ax, ay, bx, by, z1 });
    } else {
      const mat = mats[material].clone(); mat.map = mats[material].map.clone(); mat.map.needsUpdate = true;
      mat.map.repeat.set(L / (material === 3 ? 0.9 : 0.8), H / (material === 3 ? 0.3 : 0.4));
      const m = new THREE.Mesh(new THREE.BoxGeometry(L, H, material === 3 ? 0.215 : 0.19), mat);
      m.castShadow = m.receiveShadow = true; group.add(m);
    }
    TRACK.add(group);
    walls[i] = { def: { ax, ay, bx, by, z0, z1, material }, mesh: group };
  }
  if (glassSpan.length) {  // the shop's fascia over its panes
    const ys = glassSpan.flatMap((g) => [g.ay, g.by]), y0 = Math.min(...ys), y1 = Math.max(...ys), z = glassSpan[0].z1;
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, y1 - y0 + 0.6), new THREE.MeshStandardMaterial({ color: '#1d57c2', roughness: 0.7 }));
    fascia.position.copy(v3(glassSpan[0].ax + 0.1, (y0 + y1) / 2, z + 0.3)); fascia.castShadow = true; TRACK.add(fascia);
    for (const side of [y0 - 0.15, y1 + 0.15]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, z + 0.6, 0.2), frameMat); post.position.copy(v3(glassSpan[0].ax, side, (z + 0.6) / 2)); TRACK.add(post); }
  }
}
let lastBreak = null;
function onWallBreak(e) {
  const w = walls[e[0]];
  if (!w) return;
  w.mesh.visible = false;
  const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
  const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
  const vel = [S(7) * Math.cos(yaw) - S(8) * Math.sin(yaw), S(7) * Math.sin(yaw) + S(8) * Math.cos(yaw)];
  const viaEngine = w.def.material === 1 && glassfx?.onBreak(e[0], { x: -e[4], y: -e[5] });
  const name = viaEngine ? 'glass storefront' : destruction.breakSection(w.def, { px: e[2], py: e[3], nx: e[4], ny: e[5], speed: e[6], kept: e[7], vel });
  lastBreak = { name, t: performance.now() };
  try { if (w.def.material === 1) audio.shatter(Math.min(1, e[6] / 12)); else audio.rubble(Math.min(1, e[6] / 15)); } catch { /* audio not ready */ }
}
function resetWalls() {
  M._ord_reset_obstacles();
  destruction.reset();
  glassfx?.reset();
  for (const w of Object.values(walls)) w.mesh.visible = true;
  lastBreak = null;
}
if (WORLD === 'track') {
  for (let k = 0; k < 3; ++k) {
    const y = SMASH.y[k];
    stripe(-380, y - 4, SMASH.x + 20, y - 4, 0.15); stripe(-380, y + 4, SMASH.x + 20, y + 4, 0.15);
    for (let x = -380; x < SMASH.x - 8; x += 12) stripe(x, y, x + 6, y, 0.12, yellowPaint);
  }
}

// Rollover area (ord_web.cpp): a 25 cm trip kerb to slide sideways into, and a one-sided ramp that
// lifts the left wheels 0.9 m and drops them (a corkscrew). Heights sampled from the physics.
const ROLL = { kerbY: M._ord_roll_kerb_y(), rampY: M._ord_roll_ramp_lane_y(), kx0: -420, kx1: -300, rx0: -265, rx1: -255 };
function heightPatch(x0, x1, y0, y1, d, color) {
  const nx = Math.round((x1 - x0) / d) + 1, ny = Math.round((y1 - y0) / d) + 1;
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) {
    const x = x0 + i * d, y = y0 + j * d, h = M._ord_ground_height(x, y), k = j * nx + i;
    pos.set([x, h, -y], k * 3); uv.set([x / 5, y / 5], k * 2);
    const c = color(x, y, h); col.set([c.r, c.g, c.b], k * 3);
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let p = 0;
  for (let j = 0; j < ny - 1; ++j) for (let i = 0; i < nx - 1; ++i) { const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1; idx.set([a, b, c, b, e, c], p); p += 6; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const tex = asphalt.clone(); tex.needsUpdate = true;
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  m.receiveShadow = m.castShadow = true; m.position.y = 0.001; TRACK.add(m);
  return m;
}
if (WORLD === 'track') {
  const white = new THREE.Color('#ffffff'), red = new THREE.Color('#d22a1f'), kw = new THREE.Color('#f4f4f4'), yel = new THREE.Color('#f0c419'), blk = new THREE.Color('#222222');
  heightPatch(ROLL.kx0, ROLL.kx1, ROLL.kerbY - 1, ROLL.kerbY + 0.4, 0.05, (x, y, h) => (h > 0.01 ? (Math.floor(x) % 2 ? red : kw) : white));
  heightPatch(ROLL.rx0 - 1, ROLL.rx1 + 0.5, ROLL.rampY + 0.2, ROLL.rampY + 4.2, 0.05, (x, y, h) => (h > 0.005 ? (Math.floor((x - y) * 1.2) % 2 ? yel : blk) : white));
  // the slide pad north of the kerb, and the ramp lane
  stripe(ROLL.kx0, ROLL.kerbY + 18, ROLL.kx1, ROLL.kerbY + 18, 0.15);
  for (let x = ROLL.kx0; x < ROLL.kx1; x += 12) stripe(x, ROLL.kerbY + 9, x + 6, ROLL.kerbY + 9, 0.12, yellowPaint);
  stripe(-450, ROLL.rampY - 2.5, -230, ROLL.rampY - 2.5, 0.15);
  for (let x = -450; x < ROLL.rx0 - 2; x += 12) stripe(x, ROLL.rampY, x + 6, ROLL.rampY, 0.12, yellowPaint);
}

// Test areas south of the rollover area and the stunt park (ord_web.cpp: ord_test_areas)
const AREAS = new Float64Array(M.HEAPF64.buffer, M._ord_test_areas(), 35).slice();
const AQUA = { y: AREAS[1], pool: [AREAS[2], AREAS[3]], puddle: [AREAS[4], AREAS[5]] };
const SURF = { y: AREAS[6], cobble: [AREAS[7], AREAS[8]], paint: [AREAS[9], AREAS[10]] };
const MOOSE = { y: AREAS[0], x0: -300 };
function settsTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3d3a36'; g.fillRect(0, 0, 256, 256);
  // granite setts in staggered rows (Sao Paulo's paralelepipedos), ~14 cm
  for (let r = 0; r < 8; ++r) for (let k = -1; k < 9; ++k) {
    const t = Math.random(), x = k * 32 + (r % 2) * 16, y = r * 32;
    g.fillStyle = `rgb(${110 + 50 * t | 0},${106 + 46 * t | 0},${100 + 40 * t | 0})`;
    g.beginPath(); g.roundRect(x + 2, y + 2, 28, 28, 5); g.fill();
    g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(x + 5, y + 4, 18, 5);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
if (WORLD === 'track') {
  // aquaplaning lane: an 8 mm pool across it, then a 12 mm puddle under the left wheels
  const water = new THREE.MeshPhysicalMaterial({ color: '#2c4f66', roughness: 0.02, metalness: 0.1, transparent: true, opacity: 0.72, clearcoat: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(AQUA.pool[1] - AQUA.pool[0], 8), water); pool.rotation.x = -Math.PI / 2; pool.position.copy(v3((AQUA.pool[0] + AQUA.pool[1]) / 2, AQUA.y, 0.006)); TRACK.add(pool);
  const pud = new THREE.Mesh(new THREE.PlaneGeometry(AQUA.puddle[1] - AQUA.puddle[0], 3), water); pud.rotation.x = -Math.PI / 2; pud.position.copy(v3((AQUA.puddle[0] + AQUA.puddle[1]) / 2, AQUA.y + 1.5, 0.006)); TRACK.add(pud);
  stripe(-470, AQUA.y - 4, -150, AQUA.y - 4, 0.15); stripe(-470, AQUA.y + 4, -150, AQUA.y + 4, 0.15);
  for (let x = -470; x < AQUA.pool[0] - 4; x += 12) stripe(x, AQUA.y, x + 6, AQUA.y, 0.12, yellowPaint);
  // surfaces lane: cobblestones, then a zebra crossing (0.5 m stripes every metre)
  const setts = settsTexture(); setts.repeat.set((SURF.cobble[1] - SURF.cobble[0]) / 1.1, 8 / 1.1);
  const cob = new THREE.Mesh(new THREE.PlaneGeometry(SURF.cobble[1] - SURF.cobble[0], 8), new THREE.MeshStandardMaterial({ map: setts, roughness: 0.75, ...decal }));
  cob.rotation.x = -Math.PI / 2; cob.position.copy(v3((SURF.cobble[0] + SURF.cobble[1]) / 2, SURF.y, 0.002)); cob.receiveShadow = true; TRACK.add(cob);
  for (let x = SURF.paint[0]; x < SURF.paint[1]; x += 1) stripe(x, SURF.y - 4, x, SURF.y + 4, 0.5);
  stripe(-470, SURF.y - 4, -150, SURF.y - 4, 0.15); stripe(-470, SURF.y + 4, -150, SURF.y + 4, 0.15);
  // moose test: run-up lane to the entry gate (the cones are moose.js's, sized to the car)
  stripe(-470, MOOSE.y - 1.7, MOOSE.x0, MOOSE.y - 1.7, 0.12); stripe(-470, MOOSE.y + 1.7, MOOSE.x0, MOOSE.y + 1.7, 0.12);
  stripe(MOOSE.x0, MOOSE.y - 6, MOOSE.x0, MOOSE.y + 6, 0.3, yellowPaint);
  document.fonts?.ready.then(() => {
    sign('AQUAPLANING', -462, AQUA.y + 5, '8 mm pool · then a puddle on the left');
    sign('COBBLES & PAINT', -462, SURF.y + 5, 'setts · zebra · slick when it rains');
    sign('MOOSE TEST', -462, MOOSE.y + 5, 'ISO 3888-2 · lift off at the yellow line');
  });
}

// Slalom cones: 10 cones, 18 m apart, at y = -45
const SLALOM = { y: -45, x0: 40, gap: 18, n: 10 };
const cones = [];
{
  const coneGeo = new THREE.ConeGeometry(0.17, 0.7, 20);
  const coneMat = new THREE.MeshStandardMaterial({ color: '#ff6a13', roughness: 0.6 });
  for (let i = 0; i < SLALOM.n; ++i) {
    const m = new THREE.Mesh(coneGeo, coneMat);
    m.castShadow = true;
    const x = SLALOM.x0 + i * SLALOM.gap;
    m.position.copy(v3(x, SLALOM.y, 0.35));
    TRACK.add(m);
    cones.push({ mesh: m, home: m.position.clone(), hit: false, vel: new THREE.Vector3(), spin: 0 });
  }
}
function sign(text, x, y, sub = '') {
  const c = document.createElement('canvas'); c.width = 512; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#1d57c2'; g.fillRect(0, 0, 512, 160);
  g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(8, 8, 496, 144);
  g.fillStyle = '#fff'; g.textAlign = 'center';
  g.font = '900 64px "Big Shoulders Display", Impact, sans-serif'; g.fillText(text, 256, sub ? 82 : 102);
  if (sub) { g.font = '600 28px "Public Sans", sans-serif'; g.fillText(sub, 256, 128); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 1.5), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
  board.position.copy(v3(x, y, 2.6));
  board.rotation.y = -Math.PI / 2; // faces the approaching car (+x travel)
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.9), new THREE.MeshStandardMaterial({ color: '#888' }));
  post.position.copy(v3(x, y, 0.95)); post.castShadow = true;
  TRACK.add(board, post);
}
document.fonts?.ready.then(() => {
  sign('STRAIGHT', -12, 9, '8 km · top speed');
  sign('PROVING GROUND', -452, 9, 'bumps · skidpads · wet · split-µ');
  sign('BUMP COURSE', -447, PG.bumpY + 5, '2 → 12 cm · washboard · crest · dip');
  sign('SPLIT-µ', -447, PG.splitY + 6, 'left wheels wet · brake & launch');
  sign('SKIDPAD R30', PG.dry.x - PG.dry.r - 6, PG.dry.y, 'dry');
  sign('WET SKIDPAD', PG.wet.x - PG.wet.r - 6, PG.wet.y, 'R25 · wet');
  sign('DRAG STRIP', -60, 9, 'straight ahead · 8 km');
  sign('SKIDPAD', 105, 72, 'R40 · constant radius');
  sign('SLALOM', 22, -40, '10 cones · 18 m');
  sign('BUMPS', 25, LANE_Y + 5, 'bumps · rumble · pothole · kerb');
  sign('WET', 240, 50, 'reduced grip · 200 m');
  sign('CRASH TEST', -446, CRASH.y + 7, 'rigid barrier ahead · pole on the left');
  sign('TRIP KERB', ROLL.kx0 - 6, ROLL.kerbY + 9, 'slide sideways into the 25 cm kerb');
  sign('CORKSCREW', -446, ROLL.rampY - 3.5, 'one-sided ramp · keep left wheels on it');
  sign('STOREFRONT', -376, SMASH.y[0] + 5, '10 mm glass · breaks at a walk');
  sign('BLOCK WALL', -376, SMASH.y[1] + 5, 'hollow blocks · breaks past ~20 km/h');
  sign('BRICK WALL', -376, SMASH.y[2] + 5, 'double brick · breaks past ~45 km/h');
  for (let x = 100; x <= 1000; x += 100) sign(`${x} m`, x, 9);
  for (let x = 1500; x < STRAIGHT_END - 1000; x += 500) sign(`${(x / 1000).toFixed(1)} km`, x, 9);
  for (const d of [1000, 600, 400, 300, 200, 100]) sign(`${d}`, STRAIGHT_END - d, 9, 'brake · end of straight');
  sign('END', STRAIGHT_END + 20, 9, 'turn around');
});

// ---------- Car ----------
const carRoot = new THREE.Group();
scene.add(carRoot);
const placeholder = new THREE.Group();
carRoot.add(placeholder);
const wheelRigs = []; // placeholder wheels: {steer, spin}
let restWheelZ = [0, 0, 0, 0];
let restWheelXY = [];
let groundZBody = -0.45;
let model = null; // { wrapper, rigs:[{steer,spin}|null x4], hasWheels }
let spinAngle = [0, 0, 0, 0];

const bodyMat = new THREE.MeshPhysicalMaterial({ color: '#d22a1f', roughness: 0.32, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.12 });
const glassMat = new THREE.MeshPhysicalMaterial({ color: '#33465e', roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.45 });
const tireMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.85 });
const rimMat = new THREE.MeshStandardMaterial({ color: '#c9ccd1', roughness: 0.3, metalness: 0.9 });

function geometryFromState() {
  const n = S(22);
  const wheels = [];
  for (let w = 0; w < n; ++w) wheels.push({ x: W(w, 0), y: W(w, 1), z: W(w, 2), r: W(w, 3) });
  return wheels;
}

function buildPlaceholder() {
  placeholder.clear();
  wheelRigs.length = 0;
  const wh = geometryFromState();
  const xf = Math.max(...wh.map((w) => w.x)), xr = Math.min(...wh.map((w) => w.x));
  const half = Math.max(...wh.map((w) => Math.abs(w.y)));
  const r = wh[0].r;
  const len = xf - xr + 1.7, wid = 2 * half - 0.3;
  const bottom = groundZBody + 0.16, top = groundZBody + 0.92;
  const midX = (xf + xr) / 2;
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.copy(v3(x, y, z)); m.castShadow = true; placeholder.add(m); return m; };
  add(new THREE.BoxGeometry(len, top - bottom, wid), bodyMat, midX, 0, (top + bottom) / 2);
  add(new THREE.BoxGeometry(len * 0.48, 0.42, wid * 0.86), glassMat, midX - len * 0.08, 0, top + 0.21);
  add(new THREE.BoxGeometry(0.06, 0.12, wid * 0.7), new THREE.MeshStandardMaterial({ color: '#fff7d6', emissive: '#fff2c0', emissiveIntensity: 0.6 }), midX + len / 2, 0, top - 0.12);
  phTail = new THREE.MeshStandardMaterial({ color: '#600', emissive: '#c00', emissiveIntensity: 0.5 });
  add(new THREE.BoxGeometry(0.06, 0.1, wid * 0.8), phTail, midX - len / 2, 0, top - 0.1);
  for (const w of wh) {
    const steer = new THREE.Group();
    steer.position.copy(v3(w.x, w.y, w.z));
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(w.r, w.r, 0.24, 32), tireMat);
    tire.rotation.x = Math.PI / 2; tire.castShadow = true;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(w.r * 0.62, w.r * 0.62, 0.25, 6), rimMat);
    rim.rotation.x = Math.PI / 2;
    spin.add(tire, rim); steer.add(spin); placeholder.add(steer);
    steer.userData.noCrumple = true;
    wheelRigs.push({ steer, spin, base: steer.position.clone() });
  }
  return { xf, xr, half, r, midX };
}

// ---------- Crash dummies ----------
const dummies = new CrashDummies(carRoot);
const GLASS_RE = /(glass|window|vidro|windscreen|windshield)/i;
// Glass is see-through so the dummies show; "See-through" fades the whole body.
function applySeeThrough() {
  carRoot.traverse((o) => {
    if (!o.isMesh || o === dummies.group || dummies.group.getObjectById(o.id)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      if (m.userData.op0 === undefined) m.userData.op0 = { t: m.transparent, o: m.opacity, d: m.depthWrite };
      const glass = GLASS_RE.test(m.name || '') || m === glassMat;
      if (settings.xray) { m.transparent = true; m.opacity = glass ? 0.12 : 0.22; m.depthWrite = false; }
      else if (glass) { m.transparent = true; m.opacity = 0.4; m.depthWrite = false; }
      else { m.transparent = m.userData.op0.t; m.opacity = m.userData.op0.o; m.depthWrite = m.userData.op0.d; }
      m.needsUpdate = true;
    }
  });
}

// ---------- Blender model loading (.glb) ----------
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
let modelSource = null; // { buffer, name }
const WHEEL_RE = /(wheel|tire|tyre|rim|roda|pneu)/i;
const CALIPER_RE = /^caliper/i;

function isWheelNode(o) {
  for (let n = o; n && n !== modelSource?.sceneRoot; n = n.parent) if (WHEEL_RE.test(n.name || '')) return true;
  return false;
}

async function loadModel(buffer, name, announce = true) {
  modelSource = { buffer, name };
  const gltf = await loader.parseAsync(buffer, './');
  const inner = gltf.scene;
  modelSource.sceneRoot = inner;
  if (model) carRoot.remove(model.wrapper);
  // Fit in the car's own frame: park the root at the origin (the next frame restores the pose).
  carRoot.position.set(0, 0, 0); carRoot.quaternion.identity(); carRoot.updateMatrixWorld(true);
  const wrapper = new THREE.Group();
  wrapper.add(inner);
  carRoot.add(wrapper);
  // Orientation: the car must face +X (three.js). Blender's default glTF export maps
  // Blender -Y (the usual "front") to +Z, so a model longer along Z is turned 90°.
  let turn = store.get('turn:' + name, null);
  if (turn === null) {
    const b = new THREE.Box3().setFromObject(inner), sz = b.getSize(new THREE.Vector3());
    turn = sz.z > sz.x ? 1 : 0;
  }
  inner.rotation.y = turn * Math.PI / 2;
  inner.updateMatrixWorld(true);
  // Scale: keep real metres if the model is car-sized, else fit to the physics car's length.
  const geo = geometryFromState();
  const xf = Math.max(...geo.map((w) => w.x)), xr = Math.min(...geo.map((w) => w.x));
  wrapper.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(inner);
  let size = box.getSize(new THREE.Vector3());
  const len = Math.max(size.x, size.z);
  if (len < 2.5 || len > 7) inner.scale.multiplyScalar((xf - xr + 1.8) / len);
  inner.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(inner);
  size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  // Centre between the physics axles, tyres on the ground at rest.
  const target = v3((xf + xr) / 2, 0, groundZBody);
  inner.position.add(new THREE.Vector3(target.x - c.x, target.y - box.min.y, target.z - c.z));
  inner.updateMatrixWorld(true);
  carRoot.updateMatrixWorld(true);

  // Wheels: nodes named wheel/tire/tyre/rim (any language variant above), grouped per corner.
  const quads = [[], [], [], []]; // FL FR RL RR (physics order)
  const calipers = [[], [], [], []]; // steer and bounce with the wheel, but don't spin
  const mid = new THREE.Box3().setFromObject(inner).getCenter(new THREE.Vector3());
  inner.traverse((o) => {
    const isCal = o.isMesh && CALIPER_RE.test(o.name || '') && !isWheelNode(o);
    if (!o.isMesh || (!isWheelNode(o) && !isCal)) return;
    const bc = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
    carRoot.worldToLocal(bc);
    const front = bc.x > mid.x, left = bc.z < mid.z; // three -Z is ISO +Y (left)
    (isCal ? calipers : quads)[(front ? 0 : 2) + (left ? 0 : 1)].push(o);
  });
  const rigs = [null, null, null, null];
  const hasWheels = quads.every((q) => q.length > 0);
  if (hasWheels) {
    // Line the model's axles up with the physics axles (not just the body's bounding box).
    const cx = (meshes) => { const b = new THREE.Box3(); for (const m of meshes) b.union(new THREE.Box3().setFromObject(m)); return carRoot.worldToLocal(b.getCenter(new THREE.Vector3())).x; };
    const modelMid = (cx([...quads[0], ...quads[1]]) + cx([...quads[2], ...quads[3]])) / 2;
    inner.position.x += (xf + xr) / 2 - modelMid;
    inner.updateMatrixWorld(true); carRoot.updateMatrixWorld(true);
  }
  if (hasWheels) {
    quads.forEach((meshes, w) => {
      const box = new THREE.Box3();
      for (const m of meshes) box.union(new THREE.Box3().setFromObject(m));
      const centre = carRoot.worldToLocal(box.getCenter(new THREE.Vector3()));
      const steer = new THREE.Group(), spin = new THREE.Group();
      steer.userData.noCrumple = true;
      steer.position.copy(centre); steer.add(spin); wrapper.add(steer);
      steer.updateMatrixWorld(true);
      for (const m of meshes) spin.attach(m);
      for (const m of calipers[w]) steer.attach(m);
      rigs[w] = { steer, spin, base: centre.clone() };
    });
  }
  inner.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  model = { wrapper, rigs, hasWheels, turn };
  applySeeThrough();
  setupLights(inner);
  setupPaint(inner);
  placeholder.visible = false;
  crumple?.capture();
  $('modelNote').innerHTML = `Driving <b>${escapeHtml(name)}</b> (${size.x.toFixed(2)} × ${size.z.toFixed(2)} m). ` +
    (hasWheels ? 'Wheels found and animated from the physics.' : 'No separate wheel objects found (name them “Wheel_FL”, “Tire_RR”…, to animate them).');
  if (announce) toast(`Loaded ${name}`);
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function loadModelFile(file) {
  if (!/\.glb$/i.test(file.name)) { toast('Please use a binary glTF (.glb). In Blender: File › Export › glTF 2.0, format “glTF Binary”.'); return; }
  try { await loadModel(await file.arrayBuffer(), file.name); }
  catch (e) { toast('Could not read that model: ' + e.message); }
}
$('bModel').onclick = () => $('file').click();
$('file').onchange = (e) => { const f = e.target.files[0]; if (f) loadModelFile(f); e.target.value = ''; };
$('bTurn').onclick = async () => {
  if (!modelSource) { toast('Load a model first'); return; }
  const turn = ((model?.turn ?? 0) + 1) % 4;
  store.set('turn:' + modelSource.name, turn);
  await loadModel(modelSource.buffer, modelSource.name, false);
};
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('drop').classList.add('on'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('on'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop').classList.remove('on');
  const f = e.dataTransfer?.files?.[0]; if (f) loadModelFile(f);
});

// ---------- Paint ----------
// Metallic blue with a clearcoat, in the spirit of Alfa Romeo Misano Blue: dark blue base, metal
// flakes (a fine random normal map under the clearcoat) and a mirror-smooth lacquer on top.
// The body panels arrive as the untextured "StellaPaint" material (split from the scan's atlas).
const PAINT_MATS = /^(StellaPaint|BodyPaintPatch)$/;
let paintMat = null;
function flakeNormalMap() {
  const n = 256, d = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; ++i) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 0.55;
    d[i * 4] = 128 + 127 * r * Math.cos(a); d[i * 4 + 1] = 128 + 127 * r * Math.sin(a); d[i * 4 + 2] = 255; d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, n, n); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 40);
  t.magFilter = THREE.NearestFilter; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true;
  return t;
}
function setupPaint(root) {
  paintMat ??= new THREE.MeshPhysicalMaterial({
    name: 'StellaPaint', color: new THREE.Color('#0B2C7A'), metalness: 0.7, roughness: 0.38,
    clearcoat: 1, clearcoatRoughness: 0.03, normalMap: flakeNormalMap(), normalScale: new THREE.Vector2(0.18, 0.18),
    envMapIntensity: 1.25,
  });
  root.traverse((o) => {
    if (!o.isMesh) return;
    // What's left of the scanned body after the paint split is trim, glass surrounds, intakes and
    // the cabin: dark satin, not metal.
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (/^(tripo_material|CarPaintClean)/.test(m?.name || '')) { m.metalness = 0.05; m.roughness = 0.5; m.clearcoat = 0.4; m.clearcoatRoughness = 0.1; }
      if (m?.name === 'WheelDiamondFace') m.envMapIntensity = 0.6;
    }
    if (Array.isArray(o.material)) o.material = o.material.map((m) => (PAINT_MATS.test(m?.name || '') ? paintMat : m));
    else if (PAINT_MATS.test(o.material?.name || '')) o.material = paintMat;
  });
}

// ---------- Tail and brake lights ----------
// Tail lamps glow whenever the car is on; braking brightens them and lights the centre brake bar.
// Material names come from the Blender file (TL_* lamp parts, BrakeBarLED).
const lamps = { tail: [], bar: [], glow: null, x: 0 };
const TAIL_MATS = /^(TL_LightPipe|TL_LightPipeInner|TL_LEDDot)$/;
function setupLights(root) {
  lamps.tail = []; lamps.bar = [];
  if (lamps.glow) lamps.glow.removeFromParent();
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || seen.has(m)) continue; seen.add(m);
      if (TAIL_MATS.test(m.name)) { m.emissive = new THREE.Color('#ff1a0d'); lamps.tail.push(m); }
      else if (m.name === 'BrakeBarLED') { m.emissive = new THREE.Color('#ff1208'); lamps.bar.push(m); }
    }
  });
  // red light spilling onto the road behind the car when braking
  const box = new THREE.Box3().setFromObject(root); carRoot.worldToLocal(box.min); carRoot.worldToLocal(box.max);
  const glow = new THREE.PointLight('#ff2010', 0, 5, 2);
  glow.position.set(Math.min(box.min.x, box.max.x) - 0.25, groundZBody + 0.75, 0);
  carRoot.add(glow); lamps.glow = glow;
}
function updateLights(brake) {
  const b = Math.min(1, brake * 3);
  for (const m of lamps.tail) m.emissiveIntensity = 0.9 + 3.6 * b;
  for (const m of lamps.bar) m.emissiveIntensity = 0.05 + 5 * b;
  if (lamps.glow) lamps.glow.intensity = 3.5 * b;
  if (phTail) phTail.emissiveIntensity = 0.5 + 2.5 * b;
}
let phTail = null;

// ---------- City (world=city) ----------
let CITY = null, nameAt = null;
if (WORLD === 'city') {
  try {
    CITY = await loadCity({ scene, M, loader: new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), mobile: MOBILE, asphalt, status: (t) => { $('loadMsg').textContent = t; } });
    nameAt = streetNamer(CITY.info.streets);
    scene.fog = new THREE.Fog(SKY, 140, MOBILE ? 420 : 620);
  } catch (e) {
    console.error('city failed to load', e);
    $('loadMsg').textContent = 'The city could not be loaded (' + e.message + '). Opening the test track.';
    setTimeout(() => switchWorld('track'), 1800);
    await new Promise(() => {});
  }
}

// The track itself shouldn't mirror the sky: keep its reflections subtle.
scene.traverse((o) => { if (o.isMesh && o.material?.isMeshStandardMaterial) o.material.envMapIntensity = 0.3; });

// ---------- Create car ----------
const CITY_ZONES = CITY ? [
  { name: 'Av. Paulista · MASP', x: CITY.info.spawn.x, y: CITY.info.spawn.y, yaw: (CITY.info.spawn.yaw * Math.PI) / 180 },
  { name: 'Under MASP', x: -12, y: 12, yaw: -0.73 },
  { name: 'Paulista → Paraíso', x: -150, y: 87, yaw: -0.74 },
  { name: 'Rua Itapeva', x: 115, y: -97.5, yaw: 0.73 },
  { name: 'Viaduto Tranchesi', x: 118, y: 61, yaw: 2.40 },
  { name: 'Av. Nove de Julho (valley)', x: 88, y: 102, yaw: 1.035 },
] : null;
const ZONES = CITY_ZONES || [
  { name: 'Proving ground', x: -462, y: 0, yaw: 0 },
  { name: 'Drag strip', x: 0, y: 0, yaw: 0 },
  { name: 'Bump course', x: -452, y: PG.bumpY, yaw: 0 },
  { name: 'Wet skidpad', x: PG.wet.x, y: PG.wet.y - PG.wet.r, yaw: 0 },
  { name: 'Split-µ', x: -452, y: PG.splitY, yaw: 0 },
  { name: 'Skidpad', x: SKID.x, y: SKID.y - SKID.r, yaw: 0 },
  { name: 'Slalom', x: 10, y: SLALOM.y, yaw: 0 },
  { name: 'Bumps', x: 15, y: LANE_Y, yaw: 0 },
  { name: 'Wet', x: 200, y: 50, yaw: 0 },
  { name: 'Crash barrier', x: M._ord_crash_barrier_x() - 260, y: M._ord_crash_lane_y(), yaw: 0 },
  { name: 'Pole test (side)', x: M._ord_crash_pole_x() - 120, y: M._ord_crash_lane_y() + 16, yaw: 0 },
  { name: 'Rollover: corkscrew ramp', x: -440, y: M._ord_roll_ramp_lane_y(), yaw: 0 },
  { name: 'Rollover: trip kerb', x: -440, y: M._ord_roll_kerb_y() + 9, yaw: 0 },
  { name: 'Smash: glass storefront', x: M._ord_crash_barrier_x() - 110, y: M._ord_smash_lane_y(0), yaw: 0 },
  { name: 'Smash: block wall', x: M._ord_crash_barrier_x() - 160, y: M._ord_smash_lane_y(1), yaw: 0 },
  { name: 'Smash: brick wall', x: M._ord_crash_barrier_x() - 220, y: M._ord_smash_lane_y(2), yaw: 0 },
  { name: 'Moose test (ISO 3888-2)', x: -440, y: AREAS[0], yaw: 0 },
  { name: 'Aquaplaning', x: -462, y: AREAS[1] + 1.5, yaw: 0 },
  { name: 'Cobbles & paint', x: -462, y: AREAS[6], yaw: 0 },
  { name: 'Stunt: jumps', x: -462, y: AREAS[11], yaw: 0 },
  { name: 'Stunt: big jump', x: -462, y: AREAS[12], yaw: 0 },
  { name: 'Stunt: half-pipe', x: -455, y: AREAS[23], yaw: 0 },
  // the loop: on its approach line, already rolling at 110 km/h (the loop assist steers the ribbon)
  { name: 'Stunt: loop (110 km/h)', x: -400, y: AREAS[30] - (AREAS[29] + 400) * Math.tan(AREAS[34]), yaw: AREAS[34], v: 110 / 3.6 },
];
let bikeView = null, crashT = 0;
function createBike(z, speed = 0) {
  if (!bikeView) bikeView = new BikeView(scene);
  applyAids();
  M._ord_bike_create(settings.car - 6, z.x, z.y, z.yaw, speed);
  bikeView.build(B);
  bikeView.root.visible = true; carRoot.visible = false;
  $('hGear').style.display = ''; document.querySelector('.tachp').style.display = 'none';
  hudLabels(true); applyDummies();
  crashT = 0; camInit = true;
}
function hudLabels(bike) {
  $('iEsc').textContent = bike ? 'BAL' : 'ESC'; $('iDrift').textContent = bike ? 'WHEELIE' : 'DRIFT';
  $('iCs').style.display = bike ? 'none' : '';
  wheelEls.forEach((e, w) => { e.el.style.display = bike && w > 1 ? 'none' : ''; e.el.querySelector('span').textContent = ['FL', 'FR', 'RL', 'RR'][w]; });
  $('hGear').title = bike ? 'Lean angle' : 'Gear';
}
// Tuning garage (U): a full setup for the car, applied by the physics core.
const garage = new Garage(M, { store, toast, isBike, carIndex: () => settings.car, startYaw: () => ZONES[0].yaw });
$('bGarage').onclick = (e) => { garage.toggle(); e.currentTarget.blur(); };

// ---------- Showcases: overlay, crumple, rewind, ghost & shadow car, weather, stunts, moose, crash lab, glass ----------
const overlay = new PhysicsOverlay(THREE, M, { S, W, parent: carRoot, garageState: () => garage.gs() });
overlay.group.userData.noCrumple = true;
dummies.group.userData.noCrumple = true;
function skipCrumple(o) {
  for (let n = o; n && n !== carRoot; n = n.parent) if (!n.visible || n.userData.noCrumple) return true;
  return false;
}
const crumple = new Crumple(THREE, carRoot, skipCrumple);
// Damage modes. Cosmetic (the default, game-like): shallow dents and scuffs, no injury report, a
// car that ends up on its side or roof is put back on its wheels by itself; the car always drives
// the same. Realistic: the physics' node/beam crash structure takes every hit (the body crushes as
// it absorbs the energy, the mesh is skinned to it) and breaks parts: alignment, wheels, tyres,
// steering, radiator and engine, aero; plus the dummies' crash report. Off: no dents. The crash
// lab always runs on the crash structure.
const COSMETIC_CAP = 0.08;
const labOn = () => !!(lab && lab.mode !== 'off');
crumple.cap = () => (settings.damage === 'cosmetic' && !labOn() ? COSMETIC_CAP : Infinity);
const crumpleLog = [];   // { frame, point, dir, depth, radius } for rewinding through crashes
// ---------- Realistic damage: the crash structure, its skin and the parts ----------
const DMG = { version: -1, normalsAt: 0, dirtyNormals: false, detached: [false, false, false, false], debris: [], labPrev: null, shown: false };
const DMG_SIZE = 22 + 6 * 8;
const realisticOn = () => !!M._ord_damage_mode && M._ord_damage_mode() === 1;
const damageState = () => new Float64Array(M.HEAPF64.buffer, M._ord_damage_state(), DMG_SIZE);
const cageNodes = () => { const n = M._ord_cage_count(); return { n, nodes: new Float64Array(M.HEAPF64.buffer, M._ord_cage_nodes(), 8 * Math.max(n, 1)) }; };
function physicsDamage(on) {
  if (!M._ord_set_damage) return;
  M._ord_set_damage(on ? 1 : 0);
  DMG.version = -1;
  crumple.restore();
  for (let w = 0; w < 4; ++w) showWheel(w, true);
  DMG.detached.fill(false);
}
function wheelRig(w) { const rigs = model?.hasWheels ? model.rigs : model ? null : wheelRigs; return rigs?.[w] || null; }
function showWheel(w, on) { const r = wheelRig(w); if (r) r.steer.visible = on; }
// A wheel torn off flies on from where it was, bounces and rolls to a stop.
function spawnWheelDebris(w, worldVel) {
  const r = wheelRig(w);
  if (!r) return;
  carRoot.updateMatrixWorld(true);
  const obj = r.steer.clone(true);
  r.steer.getWorldPosition(obj.position);
  r.steer.getWorldQuaternion(obj.quaternion);
  scene.add(obj);
  const side = W(w, 1) >= 0 ? 1 : -1;
  const out = v3(0, side * 3, 0).applyQuaternion(carRoot.quaternion);
  DMG.debris.push({ obj, vel: worldVel.clone().add(out).add(new THREE.Vector3(0, 2.5, 0)), spin: new THREE.Vector3(Math.random() * 6 - 3, 0, Math.random() * 20 - 10), r: W(w, 3) || 0.33, t: 0 });
  if (DMG.debris.length > 6) { const d = DMG.debris.shift(); scene.remove(d.obj); }
}
function updateDebris(dt) {
  for (let i = DMG.debris.length - 1; i >= 0; --i) {
    const d = DMG.debris[i];
    d.t += dt;
    d.vel.y -= 9.81 * dt;
    d.obj.position.addScaledVector(d.vel, dt);
    const gy = M._ord_ground_height(d.obj.position.x, -d.obj.position.z) + d.r * 0.6;
    if (d.obj.position.y < gy) {
      d.obj.position.y = gy;
      if (d.vel.y < 0) d.vel.y *= -0.35;
      d.vel.x *= 0.97; d.vel.z *= 0.97; d.spin.multiplyScalar(0.97);
    }
    d.obj.rotation.x += d.spin.x * dt; d.obj.rotation.z += d.spin.z * dt;
    if (d.t > 15) { scene.remove(d.obj); DMG.debris.splice(i, 1); }
  }
}
function clearDebris() { for (const d of DMG.debris) scene.remove(d.obj); DMG.debris.length = 0; }
// Each frame: redraw the body when the structure's shape changed, tear off wheels, the panel.
function syncDamage(now, worldVel) {
  if (!realisticOn() || isBike() || labOn()) { if (DMG.shown) { $('dmgPanel').hidden = true; DMG.shown = false; } if (!labOn()) return; }
  const d = damageState();
  if (!d[0]) return;
  if (d[2] !== DMG.version) {
    DMG.version = d[2];
    const { n, nodes } = cageNodes();
    const normals = !d[1] || now - DMG.normalsAt > 250;   // normals are costly: not every frame of a crash
    if (normals) DMG.normalsAt = now;
    crumple.applyCage(nodes, n, normals);
    DMG.dirtyNormals = !normals;
    for (let w = 0; w < 4; ++w) {
      const gone = d[22 + 6 * w + 3] === 1;
      if (gone && !DMG.detached[w]) { spawnWheelDebris(w, worldVel || new THREE.Vector3()); showWheel(w, false); toast(`${['Front-left', 'Front-right', 'Rear-left', 'Rear-right'][w]} wheel torn off`); }
      if (!gone && DMG.detached[w]) showWheel(w, true);
      DMG.detached[w] = gone;
    }
    updateDamagePanel(d);
  } else if (DMG.dirtyNormals && now - DMG.normalsAt > 250) {
    const { n, nodes } = cageNodes();
    crumple.applyCage(nodes, n, true);
    DMG.normalsAt = now; DMG.dirtyNormals = false;
  }
  if (DMG.shown && now - (DMG.panelAt || 0) > 500) { DMG.panelAt = now; updateDamagePanel(d); }   // temperatures, coolant
}
function updateDamagePanel(d) {
  if (labOn()) { $('dmgPanel').hidden = true; DMG.shown = false; return; }
  const any = d[9] > 300 || d[11] > 0 || d[15] || [0, 1, 2, 3].some((w) => d[22 + 6 * w + 3] || d[22 + 6 * w + 4] || Math.abs(d[22 + 6 * w]) > 0.005 || d[22 + 6 * w + 2] > 0.005);
  const el = $('dmgPanel');
  el.hidden = !any; DMG.shown = any;
  if (!any) return;
  const cm = (m) => `${Math.round(m * 100)} cm`;
  const deg = (r) => `${(r * 180 / Math.PI).toFixed(1)}°`;
  const wheel = (w) => {
    const q = 22 + 6 * w;
    if (d[q + 3]) return '<b class="bad">gone</b>';
    if (d[q + 4]) return d[q + 5] >= 1 ? '<b class="bad">flat</b>' : `<b class="warn">puncture ${Math.round(d[q + 5] * 100)}%</b>`;
    const toe = d[q] + d[q + 2];
    return Math.abs(toe) > 0.005 || Math.abs(d[q + 1]) > 0.005 ? `<b class="warn">bent ${deg(Math.abs(toe))}</b>` : '<b class="ok">ok</b>';
  };
  const crush = [['front', d[3]], ['rear', d[4]], ['left', d[5]], ['right', d[6]], ['roof', d[7]]].filter(([, v]) => v > 0.01).map(([k, v]) => `${k} ${cm(v)}`).join(', ') || 'scuffs';
  const steer = Math.abs(d[17]) > 0.003 ? `pulls ${d[17] > 0 ? 'left' : 'right'} ${deg(Math.abs(d[17]))}` : 'straight';
  const eng = d[15] ? '<b class="bad">seized</b>' : `${Math.round(d[13])} °C, ${Math.round(d[16] * 100)}% power`;
  el.innerHTML = `<div class="lhead"><b>Damage</b><small>F repairs</small></div>` +
    `<span>Body</span> ${crush}${d[8] > 0.01 ? ` · <b class="bad">cabin intrusion ${cm(d[8])}</b>` : ''}<br>` +
    `<span>Wheels</span> FL ${wheel(0)} FR ${wheel(1)} RL ${wheel(2)} RR ${wheel(3)}<br>` +
    `<span>Steering</span> ${steer}${d[18] < 0.98 ? `, ${Math.round(d[18] * 100)}% lock` : ''}<br>` +
    `<span>Cooling</span> radiator ${d[11] >= 1 ? '<b class="bad">destroyed</b>' : d[11] > 0 ? `<b class="warn">${Math.round(d[11] * 100)}% damaged</b>` : 'ok'}${d[11] > 0 ? `, coolant ${Math.round(d[12] * 100)}%` : ''}<br>` +
    `<span>Engine</span> ${eng}${d[14] > 0.01 ? ` · bay crushed ${Math.round(d[14] * 100)}%` : ''}`;
}
const rewind = new Rewind(M);
// ---------- Airflow, wind tunnel, telemetry, slow motion and replay ----------
const flowView = new CarFlowView({ parent: carRoot, mobile: MOBILE });
const telemetry = new TelemetryPanel(document.body);
const replay = new ReplayViewer(document.body);
const tunnel = new WindTunnel({ THREE, scene, M, host: $('leftcol'), toast });
const FLOWS = ['Airflow', 'Airflow: lines', 'Airflow: smoke'];
const VIEW = { flow: 0, timeScale: 1, simTime: 0, aero: null, lastRec: null, camSaved: null };
const TIME_SCALES = [0.05, 0.1, 0.25, 0.5, 1];
const telBuf = () => new Float64Array(M.HEAPF64.buffer, M._ord_telemetry(), 16 + 6 * 8);
function aeroInfo() { if (!VIEW.aero) VIEW.aero = new Float64Array(M.HEAPF64.buffer, M._ord_aero_info(), 24).slice(); return VIEW.aero; }
// The airflow view's inputs from a telemetry record: the geometry, the forces, the air.
function flowInputs(rec) {
  const A = aeroInfo(), geo = carGeo();
  const yaw = rec[REC.aeroYaw], v = rec[REC.airspeed];
  return {
    geo: { front: A[11], rear: A[12], hw: A[13], floor: A[14], roof: A[15], zg: groundZBody },
    forces: { rho: A[10] || 1.225, dfFront: rec[REC.dfF], dfRearFloor: rec[REC.dfR] - rec[REC.wing], wing: rec[REC.wing], drag: rec[REC.drag] },
    wing: A[3] > 0 ? { span: A[3], chord: A[4], x: A[5], z: A[7] } : null,
    axles: { xf: geo.xf, xr: geo.xr },
    U: [-v * Math.cos(yaw), -v * Math.sin(yaw), 0],
    floorStalled: !!rec[REC.floorStall], wingStalled: !!rec[REC.wingStall],
    both: tunnel.on && tunnel.flow === 'both',
  };
}
function flowMode() {
  if (tunnel.on) return tunnel.flow === 'lines' ? 2 : 3;
  return VIEW.flow === 1 ? 1 : VIEW.flow === 2 ? 3 : 0;
}
function cycleFlow() {
  if (isBike()) return;
  VIEW.flow = (VIEW.flow + 1) % 3;
  flowView.reset();
  $('bFlow').textContent = FLOWS[VIEW.flow];
  $('bFlow').setAttribute('aria-pressed', VIEW.flow > 0);
  if (VIEW.flow === 1) toast('Airflow: streamlines through the field the car\'s drag and downforce imply, coloured by local speed (grey: undisturbed). V again for smoke.');
  if (VIEW.flow === 2) toast('Smoke: a wand ahead of the car; the puffs ride the same field. Try the wind tunnel for a steady view.');
}
function setTimeScale(k) {
  VIEW.timeScale = k;
  $('slowmo').hidden = k >= 1;
  $('slowmo').textContent = `Slow motion ${k}×`;
  document.querySelectorAll('[data-time]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.time === k));
}
function stepTimeScale(dir) {
  const i = TIME_SCALES.indexOf(VIEW.timeScale);
  setTimeScale(TIME_SCALES[Math.max(0, Math.min(TIME_SCALES.length - 1, (i < 0 ? 4 : i) + dir))]);
}
function telemetryHistory() {
  const out = [], f = rewind.frames;
  for (let i = Math.max(0, f.length - 400); i < f.length; ++i) if (f[i].pose.tel) out.push(f[i].pose.tel);
  return out;
}
function openReplay() {
  if (isBike() || tunnel.on || lab?.active) return;
  if (!replay.open(rewind.frames)) { toast('Drive a little first: the replay plays the last 25 seconds'); return; }
  VIEW.camSaved = settings.cam; settings.cam = 4; camInit = true;
  document.body.classList.add('replaymode');
  toast('Replay: slow motion, scrub, drag to orbit. Drive from here carries on from the frame shown.');
}
function closeReplay(drive = null) {
  if (!replay.on) return;
  if (drive !== null) { rewind.active = true; rewind.cursor = rewind.frames.length - 1 - drive; }
  replay.close();
  document.body.classList.remove('replaymode');
  if (VIEW.camSaved !== null) { settings.cam = VIEW.camSaved; VIEW.camSaved = null; camInit = true; }
}
replay.onExit = () => closeReplay();
replay.onDrive = (i) => closeReplay(i);
function enterTunnel() {
  if (isBike() || tunnel.on) return;
  closeReplay();
  const z = ZONES[0];
  placeAt(z);
  M._ord_launch(z.x, z.y, z.yaw, tunnel.speed, 0);
  M._ord_tunnel(1, tunnel.speed);
  tunnel.enter(z.yaw, { x: z.x, y: z.y });
  flowView.light = true; flowView.reset();
  VIEW.camSaved = settings.cam; settings.cam = 4; orbit.yaw = 2.35; orbit.pitch = 0.22; orbit.dist = 7.5; camInit = true;
  $('side').hidden = true;
  document.body.classList.add('tunnelmode');
  if (!telemetry.on) { telemetry.toggle(true); telemetry.setPage(2); }
  toast('Wind tunnel: the car on a rolling road. Drag to orbit, P for telemetry, [ ] for slow motion.');
}
function exitTunnel() {
  if (!tunnel.on) return;
  M._ord_tunnel(0, 0);
  tunnel.exit();
  document.body.classList.remove('tunnelmode');
  garage.applyWind();
  flowView.light = false; flowView.reset();
  if (VIEW.camSaved !== null) { settings.cam = VIEW.camSaved; VIEW.camSaved = null; }
  placeAt(ZONES[0]);
}
tunnel.onExit = () => exitTunnel();
telemetry.onToggle = (on) => $('bTelemetry')?.setAttribute('aria-pressed', on);
const ghostCar = new GhostCar(THREE, scene, '#8fd3ff');
const shadowCar = new GhostCar(THREE, scene, '#ffb347');
const ghost = { on: store.get('ghost', true), runs: {}, rec: [], t: 0, idx: 0, zone: null };
const shadow = { on: false, car: -1, stock: true };
const weather = (() => {
  const ground = [];
  scene.traverse((o) => {
    if (!o.isMesh || carRoot.getObjectById(o.id)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m?.isMeshStandardMaterial && !m.transparent && m.roughness >= 0.7 && !ground.some((g) => g.mat === m)) ground.push({ mat: m, roughness: m.roughness, color: m.color.clone(), env: m.envMapIntensity ?? 1 });
    }
  });
  return new Weather(THREE, scene, M, { mobile: MOBILE, sky: SKY, fog: scene.fog, sun, hemi, ground });
})();
let rainIdx = Math.max(0, RAIN_LEVELS.findIndex((r) => r.rain === (SHARE?.rain ?? store.get('rain', 0))));
const stunts = WORLD === 'track' ? new StuntPark(THREE, TRACK, M, { heightPatch, sign, toast, S, W }) : null;
const glassfx = WORLD === 'track' ? new GlassFX(THREE, scene, { mobile: MOBILE }) : null;
const crashStructure = () => new Float64Array(M.HEAPF64.buffer, M._ord_crash_structure(), 7).slice();
function launch(x, y, yaw, v, lat = 0) {
  M._ord_launch(x, y, yaw, v, lat);
  resetSkidTrail?.(); resetWalls(); crumple.restore(); crumpleLog.length = 0;
  rewind.clear(); camInit = true;
}
const moose = WORLD === 'track' ? new MooseTest(THREE, TRACK, {
  M, S, W, store, toast, carName: () => $('car').selectedOptions[0]?.textContent.split(' · ')[0] || 'car',
  maxSteer: () => (settings.lock ? 0.9 : MAXSTEER[settings.car] || 0.55), launch: (x, y, yaw, v) => launch(x, y, yaw, v), x0: MOOSE.x0, y0: MOOSE.y,
}) : null;
const lab = WORLD === 'track' ? new CrashLab({
  M, S, W, occState: (seat) => occState(seat), launch, structure: crashStructure, toast,
  lane: { y: CRASH.y, bx: CRASH.bx, px: CRASH.px, py: CRASH.y + 16 },
  crumpleHit: (h, kind) => { const hit = crumpleFromEvent(h, true); return hit ? { set: (a) => crumple.setAmount(hit, a) } : null; },
  // the structure's shape each recorded step (a copy only when it changed) and its crush for the report
  cageSnap: () => {
    if (!realisticOn()) return null;
    const d = damageState();
    if (d[2] === DMG.labVersion) return undefined;   // unchanged: the recording reuses the last one
    DMG.labVersion = d[2];
    const { nodes } = cageNodes();
    return nodes.slice();
  },
  cageApply: (nodes, normals) => { if (nodes) crumple.applyCage(nodes, nodes.length / 8, normals); },
  damage: () => (realisticOn() ? damageState().slice() : null),
}) : null;
if (lab) { lab.onAgain = (t) => runLabTest(t); lab.onClose = () => endLabDamage(); }
function carGeo() {
  const wh = geometryFromState();
  const xf = Math.max(...wh.map((w) => w.x)), xr = Math.min(...wh.map((w) => w.x)), half = Math.max(...wh.map((w) => Math.abs(w.y)));
  return { wheels: wh, xf, xr, half, groundZ: groundZBody, seatX: xr + 0.42 * (xf - xr) };
}
// The crash lab runs on the crash structure whatever the damage setting; the setting comes back
// when you leave the lab.
function endLabDamage() {
  if (DMG.labPrev === null) return;
  if (DMG.labPrev !== 'realistic') physicsDamage(false);
  DMG.labPrev = null;
}
function runLabTest(test) {
  if (!lab || isBike()) return;
  if (DMG.labPrev === null) DMG.labPrev = settings.damage;
  physicsDamage(true);
  clearDebris();
  lab.start(test, carGeo());
  crashSeen[0] = occState(0)[6]; crashSeen[1] = occState(1)[6];
}
// A hit from the physics -> a dent: depth from the crush model, where and which way in the car's frame.
function crumpleFromEvent(h, deferred = false) {
  const [px, py, pz, nx, ny, speed, kind] = h;
  if (speed < 2.5 || isBike()) return null;
  if (realisticOn()) return null;   // the crash structure deforms the body itself
  const mode = deferred ? 'realistic' : settings.damage;   // deferred = the crash lab's replay
  if (mode === 'off') return null;
  const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
  const q = new THREE.Quaternion(qx, qy, qz, qw).invert();   // ISO world -> ISO body
  const rel = new THREE.Vector3(px - S(0), py - S(1), pz - S(2)).applyQuaternion(q);
  const n = new THREE.Vector3(nx, ny, 0).applyQuaternion(q);   // wall normal, pointing into the car
  const st = crashStructure();
  const zone = n.x < -0.6 ? 0 : n.x > 0.6 ? 1 : 2;             // front, rear, side
  const omega = st[zone], limit = st[3 + zone];
  let depth = Crumple.depth(speed, omega, limit);
  if (kind === 2) depth *= 0.35;   // a wall that gave way took most of it
  let radius = kind === 1 ? 0.22 : zone === 2 ? 0.8 : 1.15;
  // cosmetic: a few centimetres that grow gently with the hit, over a smaller patch
  if (mode === 'cosmetic') { depth = COSMETIC_CAP * (1 - Math.exp(-depth / 0.25)); radius *= 0.75; }
  const args = { point: new THREE.Vector3(rel.x, rel.z, -rel.y), dir: new THREE.Vector3(n.x, n.z, -n.y), depth, radius };
  const hit = crumple.addHit(args.point, args.dir, args.depth, args.radius);
  crumpleLog.push({ frame: frameNo, ...args });
  if (!deferred) crumple.setAmount(hit, 1);
  return hit;
}

// ---------- Damage mode and repair ----------
function repairBody(say) {
  if (isBike() || labOn()) return;
  let had = crumpleLog.length;
  if (realisticOn()) { had = damageState()[9] > 0 ? 1 : had; M._ord_repair(); DMG.version = -1; clearDebris(); for (let w = 0; w < 4; ++w) showWheel(w, true); DMG.detached.fill(false); }
  crumple.restore(); crumpleLog.length = 0;
  if (say) toast(had ? 'Body repaired' : 'Not a scratch on it');
}
function applyDamageUi() {
  document.querySelectorAll('[data-damage]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.damage === settings.damage));
}
function setDamage(mode) {
  settings.damage = mode; store.set('damage', mode); applyDamageUi();
  if (!labOn()) physicsDamage(mode === 'realistic');
  // redraw what is already there at the new depth (the hits are kept exactly)
  const keep = crumpleLog.slice();
  crumple.restore(); crumpleLog.length = 0;
  if (mode !== 'off') for (const c of keep) { crumple.setAmount(crumple.addHit(c.point, c.dir, c.depth, c.radius), 1); crumpleLog.push(c); }
  toast({ cosmetic: 'Cosmetic damage: dents and scuffs, the car always drives on', realistic: 'Realistic damage: the crash structure crushes and parts break', off: 'Damage off' }[mode]);
}
document.querySelectorAll('[data-damage]').forEach((b) => (b.onclick = () => { setDamage(b.dataset.damage); b.blur(); }));
$('bRepair').onclick = (e) => { repairBody(true); e.currentTarget.blur(); };
applyDamageUi();

$('bGarage2').onclick = (e) => { garage.toggle(true); e.currentTarget.blur(); };
function createCar() {
  setVoice();
  if (isBike()) { createBike(ZONES[0]); garage.afterCreate(); resetTimers(); return; }
  if (bikeView) { M._ord_bike_remove(); bikeView.root.visible = false; }
  carRoot.visible = true; document.querySelector('.tachp').style.display = '';
  hudLabels(false);
  applyAids();
  if (!M._ord_create(engineCar(settings.car), ZONES[0].x, ZONES[0].y, ZONES[0].yaw)) { toast('Vehicle definition rejected by the physics core'); return; }
  garage.afterCreate();
  buildWalls();
  // Settle on the brakes so the rest pose is the loaded suspension.
  for (let i = 0; i < 90; ++i) { M._ord_set_input(0, 0, 1, 0, 0, 0); M._ord_advance(1 / 60); }
  restWheelZ = [0, 1, 2, 3].map((w) => W(w, 2));
  restWheelXY = [0, 1, 2, 3].map((w) => [W(w, 0), W(w, 1)]);
  groundZBody = Math.min(...[0, 1, 2, 3].map((w) => W(w, 2) - W(w, 3)));
  const ph = buildPlaceholder();
  // hip points: ~42% of the wheelbase ahead of the rear axle, low sports-car seating
  dummies.place(ph.xr + 0.42 * (ph.xf - ph.xr), groundZBody + 0.36);
  M._ord_set_occupants(settings.belted ? 1 : 0, settings.airbags ? 1 : 0, settings.airbags ? 1 : 0);
  buildTach();
  if (modelSource) loadModel(modelSource.buffer, modelSource.name, false);
  M._ord_reset(ZONES[0].x, ZONES[0].y, ZONES[0].yaw);
  applySeeThrough(); applyDummies();
  crashSeen[0] = crashSeen[1] = 0;
  resetTimers();
  const geo = carGeo();
  overlay.reset(groundZBody);
  moose?.build(geo.half);
  ghostCar.build(geo);
  ghost.runs = {}; ghost.rec = []; ghost.t = 0;
  crumple.capture(); crumpleLog.length = 0;
  physicsDamage(settings.damage === 'realistic');
  clearDebris();
  VIEW.aero = null; flowView.reset();
  rewind.clear();
  if (shadow.on) startShadow(); else shadowCar.draw(null);
}
// R: a car on its side or roof is put back on its wheels where it lies; otherwise back to the start.
function resetCar() {
  if (!isBike() && S(36) < 0.5) {
    const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
    const fx = 1 - 2 * (qy * qy + qz * qz), fy = 2 * (qx * qy + qw * qz);
    M._ord_reset(S(0), S(1), Math.atan2(fy, fx));
    resetSkidTrail?.(); resetWalls(); tipped.t = 0; tipped.hinted = false;
    return;
  }
  placeAt(ZONES[0]);
}
const tipped = { t: 0, hinted: false, contacts: 0 };
function placeAt(z) {
  if (tunnel.on && z !== ZONES[0]) { M._ord_tunnel(0, 0); tunnel.exit(); document.body.classList.remove('tunnelmode'); garage.applyWind(); flowView.light = false; if (VIEW.camSaved !== null) { settings.cam = VIEW.camSaved; VIEW.camSaved = null; } }
  closeReplay();
  // the last run from this start becomes its ghost
  if (!isBike() && ghost.zone && ghost.rec.length > 180) ghost.runs[ghost.zone] = ghost.rec;
  ghost.rec = []; ghost.t = 0; ghost.idx = 0; ghost.zone = z.name || null;
  if (isBike()) createBike(z);
  else if (z.v) M._ord_launch(z.x, z.y, z.yaw, z.v, 0);
  else M._ord_reset(z.x, z.y, z.yaw);
  if (lab) { lab.mode = 'off'; lab.panel.hidden = true; }
  endLabDamage();
  moose?.stopRobot?.();
  crumple.restore(); crumpleLog.length = 0;
  if (realisticOn()) { M._ord_repair(); DMG.version = -1; clearDebris(); for (let w = 0; w < 4; ++w) showWheel(w, true); DMG.detached.fill(false); }
  rewind.clear();
  if (shadow.on && !isBike()) startShadow();
  resetSkidTrail?.();
  resetWalls();
  for (const c of cones) { c.hit = false; c.mesh.position.copy(c.home); c.mesh.rotation.set(0, 0, 0); c.vel.set(0, 0, 0); }
  resetTimers();
  camInit = true;
}
for (const z of ZONES) {
  const b = document.createElement('button'); b.textContent = z.name; b.onclick = () => { placeAt(z); b.blur(); };
  $('zones').append(b);
}
for (const [w, label] of [['city', 'São Paulo · MASP'], ['track', 'Test track']]) {
  const b = $(w === 'city' ? 'wCity' : 'wTrack');
  b.setAttribute('aria-pressed', WORLD === w);
  b.onclick = () => { if (WORLD !== w) switchWorld(w); };
}

// ---------- Aids & presets ----------
// Two-wheeler aids from the same presets: Fun = everything, Sport = ABS, Simulation = none,
// Drift (key 4) = wheelie assist that holds the front up. Balance at walking pace is always on
// (it stands in for the rider's foot). Bar-torque steering is its own switch (L).
function applyBikeAids() {
  const p = settings.preset;
  const wheelie = p === 0 ? 1 : p === 3 ? 1 : 0, pitch = p === 3 ? 0.42 : 0.04;
  M._ord_bike_set_assists(settings.barTorque ? 1 : 0, 1, settings.abs ? 1 : 0, settings.tcs > 0 ? 1 : 0, wheelie, pitch);
}
function applyTuning() {
  M._ord_set_tuning(settings.lock ? 0.9 : 0, settings.diff, 220, 0.7, 0.5);
  $('bLock').setAttribute('aria-pressed', settings.lock);
  $('bDiff').textContent = 'Rear diff: ' + (settings.diff < 0 ? 'stock' : ['open', 'locked', 'tight LSD'][settings.diff]);
  $('bDiff').setAttribute('aria-pressed', settings.diff >= 0);
}
function applyAids() {
  applyBikeAids(); applyTuning();
  $('bBar').setAttribute('aria-pressed', settings.barTorque);
  M._ord_set_preset(settings.preset);
  M._ord_set_aids(settings.abs ? 1 : 0, settings.tcs, settings.esc, settings.auto ? 1 : 0);
  M._ord_set_drift_assist?.(settings.drift);
  $('aDrift').setAttribute('aria-pressed', settings.drift > 0);
  $('iDrift').classList.toggle('on', settings.drift > 0);
  const lv = ['off', 'sport', 'full'];
  $('aAbs').setAttribute('aria-pressed', settings.abs);
  $('aTcs').textContent = 'TCS: ' + lv[settings.tcs]; $('aTcs').setAttribute('aria-pressed', settings.tcs > 0);
  $('aEsc').textContent = 'ESC: ' + lv[settings.esc]; $('aEsc').setAttribute('aria-pressed', settings.esc > 0);
  $('aBox').textContent = settings.auto ? 'Auto gearbox' : 'Manual gearbox'; $('aBox').setAttribute('aria-pressed', settings.auto);
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.preset === settings.preset));
  $('hPreset').textContent = ['Fun', 'Sport', 'Simulation', isBike() ? 'Wheelie' : 'Drift'][settings.preset] + (customised() ? ' · custom' : '');
  $('iAbs').classList.toggle('on', settings.abs); $('iTcs').classList.toggle('on', settings.tcs > 0);
  $('iEsc').classList.toggle('on', settings.esc > 0); $('iCs').classList.toggle('on', settings.preset < 2);
}
function customised() { const d = presetAids(settings.preset); return d.abs !== settings.abs || d.tcs !== settings.tcs || d.esc !== settings.esc || d.auto !== settings.auto || d.drift !== settings.drift; }
// Drift preset fits the drift kit (52° angle kit + tight LSD) on the cars: stock steering can only
// catch ~32° of drift, the big, GTA-style angles need the lock. Leaving Drift puts the previous
// setup back. A garage change, not an aid: the buttons under "Drift setup" still override it.
let kitBefore = store.get('kitBefore', null);
function fitDriftKit(on) {
  if (isBike()) return;
  if (on && !kitBefore) {
    kitBefore = { lock: settings.lock, diff: settings.diff };
    settings.lock = true; settings.diff = 2;
  } else if (!on && kitBefore) {
    settings.lock = kitBefore.lock; settings.diff = kitBefore.diff; kitBefore = null;
  } else return;
  store.set('kitBefore', kitBefore); store.set('driftLock', settings.lock); store.set('diff', settings.diff);
}
function setPreset(p) {
  fitDriftKit(p === 3);
  settings.preset = p; Object.assign(settings, presetAids(p)); store.set('preset', p); applyAids();
  if (isBike()) toast(['FUN: ABS, traction and wheelie control, the rider leans for you', 'SPORT: ABS only', 'SIMULATION: no aids (L for bar-torque steering)', 'WHEELIE: open the throttle, the assist holds the front up'][p]);
  else toast(['FUN: every aid on', 'SPORT: ABS + light TCS', 'SIMULATION: no aids, manual gearbox (E/Q)', 'DRIFT (drift kit fitted: 52° lock, tight LSD): turn in on the throttle and the rear steps out; steer and throttle set the angle, centre to straighten. Handbrake for big entries. Donuts: full lock + throttle from a crawl'][p]);
}
document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => setPreset(+b.dataset.preset)));
$('aAbs').onclick = () => { settings.abs = !settings.abs; applyAids(); };
$('aTcs').onclick = () => { settings.tcs = (settings.tcs + 1) % 3; applyAids(); };
$('aEsc').onclick = () => { settings.esc = (settings.esc + 1) % 3; applyAids(); };
$('aBox').onclick = () => { settings.auto = !settings.auto; applyAids(); };
$('bBar').onclick = (e) => { settings.barTorque = !settings.barTorque; store.set('barTorque', settings.barTorque); applyAids(); toast(settings.barTorque ? 'Bar-torque steering: input = handlebar torque. Push left to go right (counter-steer)!' : 'Lean steering: input = lean angle, the rider counter-steers for you'); e.currentTarget.blur(); };
$('bLock').onclick = (e) => { settings.lock = !settings.lock; store.set('driftLock', settings.lock); applyTuning(); toast(settings.lock ? 'Drift steering lock: 52° (catches drifts up to ~50°)' : 'Stock steering lock'); e.currentTarget.blur(); };
$('bDiff').onclick = (e) => { settings.diff = settings.diff >= 2 ? -1 : settings.diff + 1; store.set('diff', settings.diff); applyTuning(); e.currentTarget.blur(); };
$('aDrift').onclick = () => { settings.drift = settings.drift > 0 ? 0 : 1; applyAids(); toast(settings.drift ? 'Drift assist on: in a slide, hold the turn to drift, let go to straighten' : 'Drift assist off'); };
// Paddle shifts (+ / − keys, the on-screen − / + buttons): the first press switches the box to
// manual, like pulling a paddle on a dual-clutch car. G (or the Auto gearbox button) goes back.
function paddle(dir) {
  if (settings.auto) { settings.auto = false; applyAids(); toast('Manual gearbox · G for automatic'); }
  if (dir > 0) edge.up = true; else edge.down = true;
}
for (const [id, dir] of [['tUp', 1], ['tDown', -1]]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('on'); paddle(dir); });
  const up = () => el.classList.remove('on');
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
$('car').value = settings.car;
$('car').onchange = (e) => { settings.car = +e.target.value; camInit = true; store.set('car', settings.car); store.set('stellaPhysics', true); createCar(); e.target.blur(); };
$('bReset').onclick = (e) => { placeAt(ZONES[0]); e.currentTarget.blur(); };
$('bCam').onclick = (e) => { cycleCam(); e.currentTarget.blur(); };
function togglePanel() {
  const side = $('side'); side.hidden = !side.hidden; $('bPanel').setAttribute('aria-expanded', !side.hidden); store.set('panel', !side.hidden);
}
$('bPanel').onclick = (e) => { togglePanel(); e.currentTarget.blur(); };
if (store.get('panel', innerWidth > 900) === false) togglePanel();

let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600); }

// ---------- Input ----------
const keys = new Set();
const edge = { up: false, down: false };
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if (e.repeat) return;
  keys.add(k);
  if (k === 'e') edge.up = true;
  if (k === 'q') edge.down = true;
  if (k === '+' || k === '=') { e.preventDefault(); paddle(1); }
  if (k === '-' || k === '_') { e.preventDefault(); paddle(-1); }
  if (k === 'r') resetCar();
  if (k === 'c') cycleCam();
  if (k === 'h') togglePanel();
  if (k === '1' || k === '2' || k === '3' || k === '4') setPreset(+k - 1);
  if (k === 'x') $('aDrift').click();
  if (k === 'k') $('bMouse').click();
  if (k === 'l') $('bBar').click();
  if (k === 'z') mouseSteer.value = 0;
  if (k === 'b') $('aAbs').click();
  if (k === 't') $('aTcs').click();
  if (k === 'y') $('aEsc').click();
  if (k === 'g') $('aBox').click();
  if (k === 'u') garage.toggle();
  if (k === 'o') $('bOverlay').click();
  if (k === 'j') $('bShadow').click();
  if (k === 'n') $('bGhost').click();
  if (k === 'i') setRain((rainIdx + 1) % RAIN_LEVELS.length, true);
  if (k === 'f') repairBody(true);
  if (k === 'v') cycleFlow();
  if (k === 'p') telemetry.next();
  if (k === '[') stepTimeScale(-1);
  if (k === ']') stepTimeScale(1);
  if (e.code === 'Backquote') { if (replay.on) closeReplay(); else openReplay(); }
  if (k === 'escape' && tunnel.on) exitTunnel();
  if (k === 'backspace') { e.preventDefault(); if (!isBike() && !lab?.active) rewindHold = true; }
});
addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); keys.delete(k); if (k === 'backspace') rewindHold = false; });
addEventListener('blur', () => keys.clear());
const touch = { steer: 0, gas: 0, brake: 0, hand: 0 };
function bindHold(id, prop) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); touch[prop] = 1; el.classList.add('on'); });
  const up = () => { touch[prop] = 0; el.classList.remove('on'); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
bindHold('tGas', 'gas'); bindHold('tBrake', 'brake'); bindHold('tHand', 'hand');
{
  const el = $('tSteer'), knob = el.querySelector('i');
  const set = (e) => {
    const r = el.getBoundingClientRect();
    const u = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    touch.steer = -u; knob.style.left = `calc(${(u + 1) * 50}% - 17px)`;
  };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); set(e); });
  el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) set(e); });
  const up = () => { touch.steer = 0; knob.style.left = 'calc(50% - 17px)'; };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
const pad = { prev: [] };
let kbSteer = 0, reverseHold = 0;
// ---------- Mouse steering ----------
// A virtual steering wheel: with the pointer locked to the view, horizontal mouse movement turns
// the wheel (it stays where you leave it unless self-centring is on); left button = throttle,
// right = brake. Analog and unfiltered by the page, so the preset's own steering mapping (direct
// in Simulation) is what the car sees. Without pointer lock, the cursor's horizontal offset from
// the centre of the view is used instead.
const mouseSteer = { on: store.get('mouseSteer', false), value: 0, sens: store.get('mouseSens', 1), centre: store.get('mouseCentre', false),
  locked: false, abs: false, absX: 0, gas: 0, brake: 0 };
function setMouseSteer(on) {
  mouseSteer.on = on; store.set('mouseSteer', on); mouseSteer.value = 0; mouseSteer.gas = mouseSteer.brake = 0;
  $('bMouse').setAttribute('aria-pressed', on);
  if (!on && document.pointerLockElement === canvas) document.exitPointerLock();
  toast(on ? 'Mouse steering on: click the view to grab the mouse (Esc lets go)' : 'Mouse steering off');
}
$('bMouse').onclick = (e) => { setMouseSteer(!mouseSteer.on); e.currentTarget.blur(); };
$('bMouse').setAttribute('aria-pressed', mouseSteer.on);
$('mSens').value = mouseSteer.sens;
$('mSens').oninput = (e) => { mouseSteer.sens = +e.target.value; store.set('mouseSens', mouseSteer.sens); };
$('mCentre').checked = mouseSteer.centre;
$('mCentre').onchange = (e) => { mouseSteer.centre = e.target.checked; store.set('mouseCentre', mouseSteer.centre); };
canvas.addEventListener('click', () => {
  if (mouseSteer.on && document.pointerLockElement !== canvas && canvas.requestPointerLock) {
    try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => { mouseSteer.abs = true; }); } catch { mouseSteer.abs = true; }
  }
});
document.addEventListener('pointerlockchange', () => {
  mouseSteer.locked = document.pointerLockElement === canvas;
  if (!mouseSteer.locked) { mouseSteer.gas = mouseSteer.brake = 0; }
});
document.addEventListener('pointerlockerror', () => { mouseSteer.abs = true; toast('Pointer lock unavailable: steering follows the cursor position instead'); });
document.addEventListener('mousemove', (e) => {
  if (!mouseSteer.on) return;
  // Some browsers emit a single huge movement when the lock engages or the cursor is warped;
  // a real flick never moves hundreds of pixels in one event, so those are ignored.
  if (mouseSteer.locked) { if (Math.abs(e.movementX) < 250) mouseSteer.value = Math.max(-1, Math.min(1, mouseSteer.value - (e.movementX * mouseSteer.sens) / 450)); }
  else if (mouseSteer.abs) { const r = canvas.getBoundingClientRect(); mouseSteer.absX = ((e.clientX - r.left) / r.width - 0.5) * 2; }
});
canvas.addEventListener('mousedown', (e) => {
  if (!mouseSteer.on || !mouseSteer.locked) return;
  if (e.button === 0) mouseSteer.gas = 1;
  else if (e.button === 2) mouseSteer.brake = 1;
  else if (e.button === 1) { mouseSteer.value = 0; e.preventDefault(); }
});
addEventListener('mouseup', (e) => { if (e.button === 0) mouseSteer.gas = 0; else if (e.button === 2) mouseSteer.brake = 0; });
canvas.addEventListener('contextmenu', (e) => { if (mouseSteer.on) e.preventDefault(); });
function mouseSteerInput(dt) {
  if (!mouseSteer.on) return null;
  if (mouseSteer.locked) {
    if (mouseSteer.centre) mouseSteer.value *= Math.exp(-dt * 1.5);  // springs back over ~0.7 s
    return mouseSteer.value;
  }
  if (mouseSteer.abs) { const x = mouseSteer.absX * mouseSteer.sens; return -Math.sign(x) * Math.min(1, Math.max(0, Math.abs(x) - 0.03) / 0.97); }
  return null;
}

function readInput(dt, gear, speed) {
  // Keyboard steering is digital; ramp it like a driver turning a wheel (the presets add their own shaping).
  const target = (keys.has('a') || keys.has('arrowleft') ? 1 : 0) - (keys.has('d') || keys.has('arrowright') ? 1 : 0);
  const rate = target === 0 || Math.sign(target) !== Math.sign(kbSteer) ? 6 : 3;
  kbSteer += Math.max(-rate * dt, Math.min(rate * dt, target - kbSteer));
  let steer = kbSteer;
  const ms = mouseSteerInput(dt);
  if (ms !== null && target === 0) steer = ms;  // keys still win while held
  let up = Math.max(keys.has('w') || keys.has('arrowup') ? 1 : 0, mouseSteer.gas);
  let down = Math.max(keys.has('s') || keys.has('arrowdown') ? 1 : 0, mouseSteer.brake);
  let hand = keys.has(' ') ? 1 : 0;
  let shiftUp = edge.up, shiftDown = edge.down;
  edge.up = edge.down = false;
  const gp = navigator.getGamepads ? [...navigator.getGamepads()].find((g) => g && g.connected) : null;
  if (gp) {
    const btn = (i) => gp.buttons[i] ? gp.buttons[i].value : 0;
    const pressed = (i) => !!gp.buttons[i]?.pressed;
    const was = (i) => !!pad.prev[i];
    const ax = gp.axes[0] ?? 0;
    const sx = Math.abs(ax) < 0.08 ? 0 : (ax - Math.sign(ax) * 0.08) / 0.92;
    if (Math.abs(sx) > Math.abs(steer)) steer = -sx;
    up = Math.max(up, btn(7)); down = Math.max(down, btn(6)); hand = Math.max(hand, btn(0));
    if (pressed(5) && !was(5)) shiftUp = true;
    if (pressed(4) && !was(4)) shiftDown = true;
    if (pressed(3) && !was(3)) resetCar();
    if (pressed(8) && !was(8)) cycleCam();
    if (pressed(9) && !was(9)) setPreset((settings.preset + 1) % 4);
    pad.prev = gp.buttons.map((b) => b.pressed);
  }
  if (Math.abs(touch.steer) > Math.abs(steer)) steer = touch.steer;
  up = Math.max(up, touch.gas); down = Math.max(down, touch.brake); hand = Math.max(hand, touch.hand);
  // Automatic gearbox: hold brake at a standstill to engage reverse, then "brake" drives backwards.
  let throttle = up, brake = down;
  if (settings.auto) {
    if (gear >= 1 && Math.abs(speed) < 0.4 && down > 0.5 && up === 0) { reverseHold += dt; if (reverseHold > 0.35) { shiftDown = true; reverseHold = 0; } }
    else reverseHold = 0;
    if (gear === -1) {
      throttle = down; brake = up;
      if (Math.abs(speed) < 0.4 && up > 0.5) shiftUp = true;
    }
  }
  return { steer: Math.max(-1, Math.min(1, steer)), throttle, brake, hand, shiftUp, shiftDown };
}

// ---------- Camera ----------
const CAMS = ['Chase', 'Far chase', 'Bonnet / helmet', 'Overhead', 'Free (drag to orbit)', 'Drift (follows where you travel)'];
let camInit = true;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function cycleCam() { settings.cam = (settings.cam + 1) % CAMS.length; store.set('cam', settings.cam); camInit = true; toast('Camera: ' + CAMS[settings.cam]); }
// Free camera: drag to orbit around the car, wheel / pinch to zoom. The orbit is relative to the
// car's heading so the chosen angle holds while driving. Dragging in any other camera switches to it.
const orbit = { yaw: store.get('orbitYaw', 2.6), pitch: store.get('orbitPitch', 0.32), dist: store.get('orbitDist', 7.5) };
{
  const ptrs = new Map(); let pinch0 = 0, dist0 = 0;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => { if (document.pointerLockElement === canvas) return; // mouse steering owns the mouse
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); dist0 = orbit.dist; } });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1 && Math.hypot(dx, dy) > 0) {
      if (settings.cam !== 4) { settings.cam = 4; store.set('cam', 4); camInit = true; toast('Camera: free — drag to orbit, scroll to zoom'); }
      orbit.yaw -= dx * 0.008; orbit.pitch = Math.max(-0.05, Math.min(1.45, orbit.pitch + dy * 0.006));
    } else if (ptrs.size === 2 && pinch0 > 0) {
      const [a, b] = [...ptrs.values()]; orbit.dist = Math.max(2.8, Math.min(40, dist0 * pinch0 / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y))));
    }
  });
  const end = (e) => { ptrs.delete(e.pointerId); pinch0 = 0; store.set('orbitYaw', orbit.yaw); store.set('orbitPitch', orbit.pitch); store.set('orbitDist', orbit.dist); };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = Math.max(2.8, Math.min(40, orbit.dist * Math.exp(e.deltaY * 0.0012))); store.set('orbitDist', orbit.dist); }, { passive: false });
}
// Chase cameras: only the viewing direction is smoothed. The follow distance is fixed (plus at
// most ~0.4 m that eases in under hard acceleration), so the car no longer runs away from the
// camera when you floor it.
const chaseDir = new THREE.Vector3(1, 0, 0);
let chaseAccel = 0;
const driftDir = new THREE.Vector3(1, 0, 0);
function updateCamera(dt, carPos, carQuat, vel, spd = S(7), ax = S(11)) {
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuat); fwd.y = 0; fwd.normalize();
  const vh = new THREE.Vector3(vel.x, 0, vel.z);
  const fov = settings.cam === 5 ? 68 : 60;
  if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  if (settings.cam === 5) {
    // Drift camera: sits behind the direction of travel, not behind the nose, so a car at 40° of
    // sideslip is seen side-on, sliding across the view. Swings to the nose when slow or reversing.
    const travel = vh.length() > 3 && spd > 1 ? vh.clone().normalize() : fwd;
    if (camInit) driftDir.copy(travel); else driftDir.lerp(travel, 1 - Math.exp(-dt * 2.2)).normalize();
    const want5 = carPos.clone().addScaledVector(driftDir, -7.8); want5.y = carPos.y + 2.7;
    const look5 = carPos.clone().addScaledVector(driftDir, 2.5); look5.y = carPos.y + 0.6;
    if (camInit) camPos.copy(want5); else camPos.lerp(want5, 1 - Math.exp(-dt * 6));
    camLook.copy(look5); camInit = false;
    camera.position.copy(camPos); camera.lookAt(camLook); return;
  }
  const dir = vh.length() > 4 && spd > 2 ? vh.normalize().lerp(fwd, 0.5).normalize() : fwd;
  let want, look;
  if (settings.cam === 0 || settings.cam === 1) {
    if (camInit) chaseDir.copy(dir); else chaseDir.lerp(dir, 1 - Math.exp(-dt * 3.5)).normalize();
    chaseAccel += (Math.max(-1, Math.min(1, ax / G)) - chaseAccel) * (1 - Math.exp(-dt * 2));
    const far = settings.cam === 1;
    const bike = isBike();
    const dist = (far ? (bike ? 8 : 12) : bike ? 4.2 : 6.2) + 0.4 * chaseAccel, h = far ? (bike ? 3.2 : 4.5) : bike ? 1.7 : 2.1;
    want = carPos.clone().addScaledVector(chaseDir, -dist); want.y = carPos.y + h;
    look = carPos.clone().addScaledVector(chaseDir, far ? 6 : 4); look.y = carPos.y + (far ? 0 : 0.7);
    // smooth only vertical motion (bumps), keep the horizontal follow rigid
    if (camInit) camPos.copy(want); else { const y = camPos.y + (want.y - camPos.y) * (1 - Math.exp(-dt * 8)); camPos.copy(want); camPos.y = y; }
    camLook.copy(look); camInit = false;
    camera.position.copy(camPos); camera.lookAt(camLook); return;
  }
  else if (settings.cam === 2) {
    want = new THREE.Vector3(0.3, groundZBody + 1.25, 0).applyQuaternion(carQuat).add(carPos);
    look = new THREE.Vector3(30, groundZBody + 0.9, 0).applyQuaternion(carQuat).add(carPos);
    camPos.copy(want); camLook.copy(look); camera.position.copy(camPos); camera.lookAt(camLook); return;
  }
  else if (settings.cam === 4) {
    const heading = Math.atan2(-fwd.z, fwd.x); // three.js yaw of the car
    const a = heading + orbit.yaw, cp = Math.cos(orbit.pitch);
    look = carPos.clone().add(new THREE.Vector3(0, 0.55, 0));
    want = look.clone().add(new THREE.Vector3(Math.cos(a) * cp, Math.sin(orbit.pitch), -Math.sin(a) * cp).multiplyScalar(orbit.dist));
    if (want.y < 0.25) want.y = 0.25;
    camPos.copy(want); camLook.copy(look); camInit = false; camera.position.copy(camPos); camera.lookAt(camLook); return;
  }
  else { want = carPos.clone().add(new THREE.Vector3(-0.01, 45, 0)); look = carPos.clone(); }
  const k = camInit ? 1 : 1 - Math.exp(-dt * (settings.cam === 3 ? 6 : 5));
  camPos.lerp(want, k); camLook.lerp(look, camInit ? 1 : 1 - Math.exp(-dt * 10));
  camInit = false;
  camera.position.copy(camPos); camera.lookAt(camLook);
}

// ---------- Crash dummies: settings and the crash report ----------
function applyDummies() {
  dummies.visible = settings.dummies && !isBike();
  dummies.setBelted(settings.belted);
  for (const [id, on] of [['bDummies', settings.dummies], ['bBelt', settings.belted], ['bAirbag', settings.airbags], ['bXray', settings.xray]]) $(id).setAttribute('aria-pressed', on);
}
function setOccupants() { M._ord_set_occupants(settings.belted ? 1 : 0, settings.airbags ? 1 : 0, settings.airbags ? 1 : 0); applyDummies(); }
$('bDummies').onclick = (e) => { settings.dummies = !settings.dummies; store.set('dummies', settings.dummies); applyDummies(); e.currentTarget.blur(); };
$('bBelt').onclick = (e) => { settings.belted = !settings.belted; store.set('belted', settings.belted); setOccupants(); toast(settings.belted ? 'Dummies belted' : 'Dummies unbelted: only the airbags (and the dash) stop them'); e.currentTarget.blur(); };
$('bAirbag').onclick = (e) => { settings.airbags = !settings.airbags; store.set('airbags', settings.airbags); setOccupants(); toast(settings.airbags ? 'Front and curtain airbags on' : 'Airbags off'); e.currentTarget.blur(); };
$('bXray').onclick = (e) => { settings.xray = !settings.xray; store.set('xray', settings.xray); applySeeThrough(); applyDummies(); e.currentTarget.blur(); };
const ZONE_NAMES = ['', 'frontal', 'rear', 'left side', 'right side'];
const VERDICTS = ['walks away', 'bruised', 'injured', 'seriously injured', 'critical'];
const VERDICT_CSS = ['#2fbf71', '#9bd14b', '#f0c419', '#ff8a2a', '#e5383b'];
const crashSeen = [0, 0, 0];
let crashHide = 0;
const occState = (seat) => { const p = M._ord_occupant_state(seat) / 8; return Array.from(M.HEAPF64.subarray(p, p + 24)); };
function seatHtml(name, r) {
  const v = r[15], pct = (x) => (x < 0.001 ? '<0.1' : (100 * x).toFixed(x < 0.1 ? 1 : 0));
  return `<div class="seat"><b>${name}</b> · <span class="v" style="color:${VERDICT_CSS[v] || '#fff'}">${VERDICTS[v] || '—'}</span><br>` +
    `<small>chest</small> ${r[6].toFixed(0)} g <small>(3 ms)</small> · <small>head</small> ${r[5].toFixed(0)} g · <small>HIC15</small> ${r[7].toFixed(0)}<br>` +
    `<small>life-threatening injury risk</small> <b>${pct(r[13])}%</b> · <small>serious head</small> ${pct(r[12])}%` +
    (r[11] ? ' · <b>hit the ' + (r[1] >= 3 ? 'door' : 'wheel/dash') + '</b>' : '') + (r[10] > 0.02 ? ` · intrusion ${(100 * r[10]).toFixed(0)} cm` : '') + '</div>';
}
function updateCrash(now) {
  // dummies follow the occupant model
  if (!isBike()) for (const seat of [0, 1]) { const o = occState(seat); dummies.update(seat, o[0], o[1], o[2], o[3], o[22]); }
  const seats = isBike() ? [2] : [0, 1];
  for (const seat of seats) {
    const o = occState(seat);
    if (o[6] <= crashSeen[seat]) continue;
    crashSeen[seat] = o[6];
    const r = o.slice(7, 23);
    if (seat === 1) continue; // shown together with the driver
    let html;
    if (seat === 2) {
      html = `<h3>Rider down</h3><small>impact speed change</small> <b>${(r[2] * 3.6).toFixed(0)} km/h</b>` + seatHtml(settings.car === 6 ? 'Cyclist (no helmet)' : 'Rider (helmet)', r);
    } else {
      const p = occState(1).slice(7, 23);
      crashSeen[1] = occState(1)[6];
      html = `<h3>Crash · ${ZONE_NAMES[r[1]] || 'impact'}${lastBreak && performance.now() - lastBreak.t < 10000 ? ' · ' + lastBreak.name : ''}</h3><small>speed change (delta-V)</small> <b>${(r[2] * 3.6).toFixed(0)} km/h</b> · <small>car pulse peak</small> ${r[3].toFixed(0)} g` +
        seatHtml('Driver', r) + seatHtml('Passenger', p) +
        `<div class="seat"><small>delta-V fatality statistic (Joksch 1993): ${(100 * r[14]).toFixed(r[14] < 0.1 ? 1 : 0)}%. ${settings.belted ? 'Belted' : 'Unbelted'}, airbags ${settings.airbags ? 'on' : 'off'}.</small></div>`;
    }
    lastCrash = { dv: r[2], verdict: r[15] };
    if (lab && lab.mode !== 'off') continue;   // the crash lab's own report has it all
    if (settings.damage !== 'realistic' && seat !== 2) continue;   // game modes: no injury report
    $('crash').innerHTML = html; $('crash').classList.add('on'); crashHide = now + 12000;
  }
  if (crashHide && now > crashHide) { $('crash').classList.remove('on'); crashHide = 0; }
}
let lastCrash = null;

// ---------- Analog tachometer ----------
// 240° sweep, numbered every 1000 rpm, red zone from 92 % of the limiter; scale follows the selected car.
const TACH = { a0: -210, a1: 30, max: 8000, needle: 0 };
function buildTach() {
  const lim = LIMITER[settings.car];
  const max = Math.ceil((lim * 1.06) / 1000) * 1000; TACH.max = max;
  const ang = (r) => TACH.a0 + (TACH.a1 - TACH.a0) * (r / max);
  const pt = (deg, rad) => [Math.cos((deg * Math.PI) / 180) * rad, Math.sin((deg * Math.PI) / 180) * rad];
  const arc = (r0, r1, rad) => { const [x0, y0] = pt(ang(r0), rad), [x1, y1] = pt(ang(r1), rad); return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${rad} ${rad} 0 ${ang(r1) - ang(r0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
  const big = max <= 10000 ? 1000 : 2000, small = big / 4;
  let ticks = '', nums = '';
  for (let r = 0; r <= max + 1; r += small) {
    const major = r % big === 0, [xa, ya] = pt(ang(r), major ? 37 : 40), [xb, yb] = pt(ang(r), 44.5);
    const red = r >= lim * 0.92;
    ticks += `<line x1="${xa.toFixed(2)}" y1="${ya.toFixed(2)}" x2="${xb.toFixed(2)}" y2="${yb.toFixed(2)}" stroke="${red ? '#ff4b3e' : '#e7ecf2'}" stroke-width="${major ? 1.8 : 0.9}" stroke-linecap="round"/>`;
    if (major) { const [xn, yn] = pt(ang(r), 29); nums += `<text x="${xn.toFixed(2)}" y="${(yn + 3).toFixed(2)}" fill="${red ? '#ff6a5e' : '#e7ecf2'}">${r / 1000}</text>`; }
  }
  $('tach').innerHTML =
    `<defs><radialGradient id="tachBg" cx="50%" cy="40%" r="65%"><stop offset="0" stop-color="#1b2433"/><stop offset="1" stop-color="#06090f"/></radialGradient></defs>` +
    `<circle r="49" fill="url(#tachBg)" stroke="rgba(255,255,255,.28)" stroke-width="1.2"/>` +
    `<path d="${arc(lim * 0.92, max, 42.2)}" stroke="#ff3b2f" stroke-width="5" fill="none" opacity=".85"/>` +
    `<g class="tick">${ticks}</g><g class="num">${nums}</g>` +
    `<text class="unit" y="-14">×1000 r/min</text>` +
    `<text class="tgear" id="tGear" y="22">N</text>` +
    `<circle id="tShift" cx="0" cy="-26" r="3.2" fill="#ff3b2f" opacity="0"/>` +
    `<g id="tNeedle"><path d="M-1.6 6 L-0.5 -41 L0.5 -41 L1.6 6 Z" fill="#ff5a3c"/><circle r="4.6" fill="#0b111b" stroke="#ff5a3c" stroke-width="1.4"/></g>`;
}
function updateTach(dt, rpm) {
  const k = 1 - Math.exp(-dt * 25);
  TACH.needle += (Math.max(0, rpm) - TACH.needle) * k;
  const deg = TACH.a0 + (TACH.a1 - TACH.a0) * Math.min(1.02, TACH.needle / TACH.max) + 90;
  $('tNeedle').setAttribute('transform', `rotate(${deg.toFixed(2)})`);
  const lim = LIMITER[settings.car];
  $('tShift').setAttribute('opacity', TACH.needle > lim * 0.94 ? ((performance.now() / 70) % 2 < 1 ? 1 : 0.25) : 0);
  const g = S(15); $('tGear').textContent = g === -1 ? 'R' : g === 0 ? 'N' : String(g);
}

// ---------- HUD ----------
const wheelEls = [];
{
  const names = ['FL', 'FR', 'RL', 'RR'];
  for (let w = 0; w < 4; ++w) {
    const d = document.createElement('div'); d.className = 'wheel';
    d.innerHTML = `<span>${names[w]}</span> <span class="v"></span><div class="bar"><i></i></div>`;
    $('hWheels').append(d); wheelEls.push({ v: d.querySelector('.v'), bar: d.querySelector('i'), el: d });
  }
}
const gg = $('gg');
gg.innerHTML = `<circle r="40" fill="none" stroke="rgba(255,255,255,.25)"/><circle r="20" fill="none" stroke="rgba(255,255,255,.12)"/>
<line x1="-46" x2="46" stroke="rgba(255,255,255,.12)"/><line y1="-46" y2="46" stroke="rgba(255,255,255,.12)"/>
<text x="0" y="-42" fill="rgba(255,255,255,.45)" font-size="8" text-anchor="middle">1 g</text>
<polyline id="ggTrail" fill="none" stroke="rgba(255,211,107,.45)" stroke-width="1.5"/><circle id="ggDot" r="4" fill="#ffd36b"/>`;
const trail = [];
let odo = 0, lastImpact = 0;
const timers = { vmax: 0, t0: null, best0100: null, last0100: null, brakeStart: null, last1000: null, maxLat: 0, slalomStart: null, slalomLast: null, conesHit: 0 };
function resetTimers() { Object.assign(bikeT, { maxLean: 0, wheelie: 0, wheelieDist: 0, lastWheelie: 0, prevV: 0, ax: 0 }); odo = 0; lastImpact = 0; Object.assign(timers, { vmax: 0, t0: null, last0100: null, brakeStart: null, last1000: null, maxLat: 0, slalomStart: null, slalomLast: null, conesHit: 0 }); trail.length = 0; }
let latF = 0, lonF = 0;
const gripF = [0, 0, 0, 0];
function gripBar(e, load, grip, locked, contact) {
  const i = wheelEls.indexOf(e);
  gripF[i] += (grip - gripF[i]) * 0.35; // light smoothing so it reads, not flickers
  e.v.textContent = `${(load / 1000).toFixed(1)}kN`;
  e.bar.style.width = Math.min(100, gripF[i] * 100) + '%';
  e.bar.style.background = locked ? 'var(--bad)' : gripF[i] > 0.95 ? 'var(--bad)' : gripF[i] > 0.8 ? 'var(--warn)' : 'var(--good)';
  e.el.style.opacity = contact ? 1 : 0.4;
}

function updateHud(dt, inp, sp = null) {
  garage.updateHud();
  const kmh = S(7) * 3.6;
  $('hSpeed').firstChild.nodeValue = Math.abs(Math.round(kmh)).toString();
  const gear = S(15);
  $('hGear').textContent = gear === -1 ? 'R' : gear === 0 ? 'N' : String(gear);
  updateTach(dt, S(14));
  {
    const inp01 = Math.max(-1, Math.min(1, S(27))), ang01 = Math.max(-1, Math.min(1, S(16) / (settings.lock ? 0.9 : MAXSTEER[settings.car] || 0.55)));
    $('hSteerIn').style.left = (50 - inp01 * 50) + '%';   // + = left in ISO; drawn left of centre
    const b = $('hSteerOut'); b.style.width = Math.abs(ang01) * 50 + '%'; b.style.left = ang01 > 0 ? (50 - ang01 * 50) + '%' : '50%';
  }
  let abs = false, esc = false;
  for (let w = 0; w < 4; ++w) {
    abs ||= W(w, 13) > 0; esc ||= W(w, 14) > 1;
    // Grip used = tyre force / what the tyre can give at this load (friction circle):
    // the bar is how close the tyre is to letting go; past ~95% it is at the limit.
    const load = W(w, 6), grip = Math.min(1.2, W(w, 16));
    gripBar(wheelEls[w], load, grip, W(w, 12) > 0, W(w, 11) > 0);
  }
  $('iAbs').classList.toggle('act', abs);
  $('iTcs').classList.toggle('act', S(18) > 0.02);
  $('iEsc').classList.toggle('act', esc);
  $('iCs').classList.toggle('act', Math.abs(S(19)) > 0.004);
  $('iDrift').classList.toggle('act', S(32) > 0);
  // g-g
  const k = 1 - Math.exp(-dt * 12);
  latF += (S(12) / G - latF) * k; lonF += (S(11) / G - lonF) * k;
  const px = -latF * 40, py = -lonF * 40;
  $('ggDot').setAttribute('cx', px.toFixed(1)); $('ggDot').setAttribute('cy', py.toFixed(1));
  trail.push(`${px.toFixed(1)},${py.toFixed(1)}`); if (trail.length > 90) trail.shift();
  $('ggTrail').setAttribute('points', trail.join(' '));
  // timers
  const v = S(7), t = S(21);
  if (Math.abs(v) < 0.3 && inp.throttle > 0.05 && timers.t0 === null && gear >= 1) timers.t0 = t;
  if (timers.t0 !== null && (inp.brake > 0.1 || v < -0.5)) timers.t0 = null;
  if (timers.t0 !== null && v >= 100 / 3.6) { timers.last0100 = t - timers.t0; timers.best0100 = Math.min(timers.best0100 ?? Infinity, timers.last0100); timers.t0 = null; }
  const x = S(0), y = S(1);
  if (timers.brakeStart === null && v > 99 / 3.6 && v < 101 / 3.6 && inp.brake > 0.5) timers.brakeStart = { x, y };
  if (timers.brakeStart && inp.brake < 0.2 && v > 1) timers.brakeStart = null;
  if (timers.brakeStart && Math.abs(v) < 0.2) { timers.last1000 = Math.hypot(x - timers.brakeStart.x, y - timers.brakeStart.y); timers.brakeStart = null; }
  if (Math.abs(v) > 5) timers.maxLat = Math.max(timers.maxLat, Math.abs(latF));
  timers.vmax = Math.max(timers.vmax, v * 3.6);
  odo += Math.abs(v) * dt;
  // slalom gate timing
  const inLane = Math.abs(y - SLALOM.y) < 6;
  if (inLane && timers.slalomStart === null && x > SLALOM.x0 - 2 && x < SLALOM.x0) { timers.slalomStart = t; timers.conesHit = 0; }
  const xEnd = SLALOM.x0 + (SLALOM.n - 1) * SLALOM.gap;
  if (timers.slalomStart !== null && x > xEnd + 2) { timers.slalomLast = { time: t - timers.slalomStart, cones: timers.conesHit }; timers.slalomStart = null; }
  if (timers.slalomStart !== null && !inLane) timers.slalomStart = null;
  const dSkid = Math.hypot(x - SKID.x, y - SKID.y);
  const onSkid = Math.abs(dSkid - SKID.r) < 6 && Math.abs(v) > 3;
  const fmt = (n, d = 2) => (n == null ? '—' : n.toFixed(d));
  $('hTimers').innerHTML =
    `<span>0–100 km/h</span> <b>${fmt(timers.last0100)} s</b>${timers.best0100 ? ` <span>best ${fmt(timers.best0100)}</span>` : ''}<br>` +
    `<span>100–0 km/h</span> <b>${fmt(timers.last1000, 1)} m</b><br>` +
    `<span>Top speed</span> <b>${fmt(timers.vmax, 0)} km/h</b> <span>${((CITY ? odo : Math.max(0, S(0))) / 1000).toFixed(2)} km</span><br>` +
    `<span>Lateral</span> <b>${fmt(Math.abs(latF))} g</b> <span>max ${fmt(timers.maxLat)}</span><br>` +
    (onSkid ? `<span>Skidpad radius</span> <b>${fmt(Math.abs(v / (S(9) || 1e-6)), 1)} m</b><br>` : '') +
    (CITY ? `<span>Last impact</span> <b>${lastImpact ? fmt(lastImpact * 3.6, 0) + ' km/h' : '—'}</b><br>`
      : `<span>Slalom</span> <b>${timers.slalomLast ? fmt(timers.slalomLast.time) + ' s' : '—'}</b>${timers.slalomLast ? ` <span>${timers.slalomLast.cones} cones</span>` : ''}<br>`) +
    `<span>Sideslip</span> <b>${fmt((S(10) * 180) / Math.PI, 1)}°</b>` +
    (sp ? (() => {
      // the shadow car: how far ahead along your heading, and its speed
      const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
      const fx = 1 - 2 * (qy * qy + qz * qz), fy = 2 * (qx * qy + qw * qz);
      const d = (sp.x - S(0)) * fx + (sp.y - S(1)) * fy;
      return `<br><span>Shadow</span> <b style="color:#ffb347">${d >= 0 ? '+' : ''}${fmt(d, 1)} m</b> <span>${fmt(sp.v * 3.6, 0)} km/h</span>`;
    })() : '');
}

// ---------- Two-wheeler HUD ----------
const bikeT = { maxLean: 0, wheelie: 0, wheelieDist: 0, bestWheelie: store.get('bestWheelie', 0), lastWheelie: 0, crashes: 0, prevV: 0, ax: 0 };
function updateBikeHud(dt, inp) {
  const v = B(3), kmh = v * 3.6, lean = B(4), pitch = B(6), kind = settings.car - 6;
  $('hSpeed').firstChild.nodeValue = Math.abs(Math.round(kmh)).toString();
  $('hGear').textContent = `${Math.abs(Math.round((lean * 180) / Math.PI))}°`;
  $('hGear').title = 'Lean angle';
  {
    const inp01 = Math.max(-1, Math.min(1, B(30))), ang01 = Math.max(-1, Math.min(1, -B(5) / BIKE_LOCK[kind]));
    $('hSteerIn').style.left = (50 - inp01 * 50) + '%';
    const b = $('hSteerOut'); b.style.width = Math.abs(ang01) * 50 + '%'; b.style.left = ang01 > 0 ? (50 - ang01 * 50) + '%' : '50%';
  }
  // two wheels: F and R grip used (friction circle incl. camber thrust)
  wheelEls[0].el.querySelector('span').textContent = 'F'; wheelEls[1].el.querySelector('span').textContent = 'R';
  gripBar(wheelEls[0], B(19), Math.min(1.2, B(17)), false, B(19) > 1);
  gripBar(wheelEls[1], B(18), Math.min(1.2, B(16)), false, B(18) > 1);
  $('iAbs').classList.toggle('act', B(13) > 0); $('iTcs').classList.toggle('act', B(14) > 0);
  $('iEsc').classList.toggle('act', Math.abs(B(12)) > 2); $('iDrift').classList.toggle('act', B(15) > 0);
  // g-g from the turn (v * yaw rate) and the speed change
  bikeT.ax += ((v - bikeT.prevV) / Math.max(dt, 1e-3) - bikeT.ax) * (1 - Math.exp(-dt * 6)); bikeT.prevV = v;
  const lat = Math.max(-2, Math.min(2, Math.tan(Math.min(1.2, Math.abs(lean))) * Math.sign(-lean))); // balanced turn: a_y / g = tan(lean)
  const k = 1 - Math.exp(-dt * 12);
  latF += (lat - latF) * k; lonF += (Math.max(-2, Math.min(2, bikeT.ax / G)) - lonF) * k;
  if (!Number.isFinite(latF) || !Number.isFinite(lonF)) latF = lonF = 0;
  const px = -latF * 40, py = -lonF * 40;
  $('ggDot').setAttribute('cx', px.toFixed(1)); $('ggDot').setAttribute('cy', py.toFixed(1));
  trail.push(`${px.toFixed(1)},${py.toFixed(1)}`); if (trail.length > 90) trail.shift();
  $('ggTrail').setAttribute('points', trail.join(' '));
  // timers: 0-100, top speed, lean, wheelies
  const t = B(2);
  if (Math.abs(v) < 0.3 && inp.throttle > 0.05 && timers.t0 === null) timers.t0 = t;
  if (timers.t0 !== null && inp.brake > 0.1) timers.t0 = null;
  if (timers.t0 !== null && v >= 100 / 3.6) { timers.last0100 = t - timers.t0; timers.best0100 = Math.min(timers.best0100 ?? Infinity, timers.last0100); timers.t0 = null; }
  timers.vmax = Math.max(timers.vmax, kmh);
  if (Math.abs(v) > 3) bikeT.maxLean = Math.max(bikeT.maxLean, Math.abs(lean));
  if (B(19) < 1 && pitch > 0.03 && !B(1)) { bikeT.wheelie += dt; bikeT.wheelieDist += Math.abs(v) * dt; }
  else if (bikeT.wheelie > 0) {
    if (bikeT.wheelie > 0.5) { bikeT.lastWheelie = bikeT.wheelieDist; if (bikeT.wheelieDist > bikeT.bestWheelie) { bikeT.bestWheelie = bikeT.wheelieDist; store.set('bestWheelie', bikeT.bestWheelie); } }
    bikeT.wheelie = 0; bikeT.wheelieDist = 0;
  }
  odo += Math.abs(v) * dt;
  const fmt = (n, d = 2) => (n == null ? '—' : n.toFixed(d));
  const deg = (r) => ((r * 180) / Math.PI).toFixed(0) + '°';
  $('hTimers').innerHTML =
    `<span>${BIKE_NAMES[kind]}</span> <b>${settings.barTorque ? 'bar-torque steering' : 'lean steering'}</b><br>` +
    `<span>0–100 km/h</span> <b>${fmt(timers.last0100)} s</b>${timers.best0100 ? ` <span>best ${fmt(timers.best0100)}</span>` : ''}<br>` +
    `<span>Top speed</span> <b>${fmt(timers.vmax, 0)} km/h</b> <span>${(odo / 1000).toFixed(2)} km</span><br>` +
    `<span>Lean</span> <b>${deg(Math.abs(lean))}</b> <span>max ${deg(bikeT.maxLean)} · asked ${deg(Math.abs(B(7)))}</span><br>` +
    `<span>Wheelie</span> <b>${bikeT.wheelie > 0 ? fmt(bikeT.wheelieDist, 0) + ' m' : bikeT.lastWheelie ? fmt(bikeT.lastWheelie, 0) + ' m' : '—'}</b>${bikeT.bestWheelie ? ` <span>best ${fmt(bikeT.bestWheelie, 0)} m</span>` : ''}<br>` +
    `<span>Bar torque</span> <b>${fmt(B(8), 0)} N·m</b> <span>pitch ${deg(pitch)}</span>` +
    (bikeT.crashes ? `<br><span>Crashes</span> <b>${bikeT.crashes}</b>` : '');
}

// zone banner
let currentZone = '';
let nameTick = 0, lastName = '';
function zoneAt(x, y) {
  if (CITY) { if (++nameTick % 15 === 0) lastName = nameAt(x, y); return lastName; }
  if (x > PG.x0 - 5 && x < PG.x1 + 5 && Math.abs(y - PG.bumpY) < 5) return 'Bump course';
  if (x > PG.x0 - 5 && x < PG.x1 + 5 && Math.abs(y - PG.splitY) < 5) return 'Split-µ';
  if (Math.abs(Math.hypot(x - PG.dry.x, y - PG.dry.y) - PG.dry.r) < 7) return 'Skidpad · R30';
  if (x > -200 && x < -140 && y > 25 && y < 85) return 'Wet skidpad · R25';
  if (Math.abs(y) < 7 && x < -40 && x > -480) return 'Proving ground';
  if (x > 250 && x < 450 && y > 25 && y < 75) return 'Wet section';
  if (Math.abs(Math.hypot(x - SKID.x, y - SKID.y) - SKID.r) < 8) return 'Skidpad · R40';
  if (Math.abs(y - SLALOM.y) < 6 && x > 25 && x < 220) return 'Slalom';
  if (Math.abs(y - LANE_Y) < 5 && x > 30 && x < 310) return 'Bumps & kerb';
  if (Math.abs(y) < 7 && x > STRAIGHT_END) return 'End of straight';
  if (Math.abs(y) < 7 && x > 5) return 'Straight';
  return '';
}

// ---------- Telemetry recording ----------
let rec = null;
$('bRec').onclick = (e) => {
  if (rec) { rec.on = false; $('bRec').setAttribute('aria-pressed', 'false'); $('bRec').textContent = 'Record CSV'; $('bCsv').disabled = rec.rows.length === 0; $('recNote').textContent = `${rec.rows.length} frames recorded.`; }
  else { rec = { on: true, rows: [] }; $('bRec').setAttribute('aria-pressed', 'true'); $('bRec').textContent = 'Stop'; $('bCsv').disabled = true; }
  e.currentTarget.blur();
};
$('bCsv').onclick = () => {
  const head = 'time,x,y,z,speed_ms,lat_vel_ms,yaw_rate,sideslip,ax,ay,az,rpm,gear,steer_in,throttle_in,brake_in,steer_angle,throttle_out,tcs_cut,' +
    [0, 1, 2, 3].map((w) => ['FL', 'FR', 'RL', 'RR'][w]).map((n) => `${n}_load,${n}_kappa,${n}_alpha,${n}_fx,${n}_fy,${n}_abs,${n}_esc`).join(',');
  const blob = new Blob([head + '\n' + rec.rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `ord-drive-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
function recordRow() {
  if (!rec?.on) return;
  const r = [21, 0, 1, 2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 27, 28, 29, 16, 17, 18].map((i) => +S(i).toFixed(5));
  for (let w = 0; w < 4; ++w) r.push(...[6, 7, 8, 9, 10, 13, 14].map((i) => +W(w, i).toFixed(4)));
  rec.rows.push(r.join(','));
  if (rec.rows.length > 60 * 600) $('bRec').click(); // stop after 10 minutes
}

// ---------- Cones ----------
function updateCones(dt, carPosIso, carVelIso) {
  for (const c of cones) {
    if (!c.hit) {
      const dx = c.home.x - carPosIso.x, dy = -c.home.z - carPosIso.y;
      if (Math.hypot(dx, dy) < 1.3) {
        c.hit = true; timers.conesHit++;
        c.vel.copy(v3(carVelIso.x * 0.7 + dx, carVelIso.y * 0.7 + dy, 2)); c.spin = 8;
      }
    } else if (c.mesh.position.y > 0.17 || c.vel.lengthSq() > 0.01) {
      c.vel.y -= G * dt; c.mesh.position.addScaledVector(c.vel, dt);
      if (c.mesh.position.y < 0.17) { c.mesh.position.y = 0.17; c.vel.multiplyScalar(0.5); c.vel.y = Math.abs(c.vel.y) * 0.3; }
      c.mesh.rotation.z += c.spin * dt; c.spin *= 0.97;
      if (c.mesh.rotation.z > Math.PI / 2) c.mesh.rotation.z = Math.PI / 2;
    }
  }
}

// ---------- Skid marks ----------
// One ring-buffer mesh of quads laid at each tyre's contact patch while it slides. Darkness follows
// the physics slip (longitudinal and lateral), so ABS cycling leaves dashed marks and a locked
// wheel a solid one. Oldest marks are recycled.
const SKID_N = 6000;
const skid = { i: 0, last: [null, null, null, null], pos: new Float32Array(SKID_N * 12), col: new Float32Array(SKID_N * 16) };
const skidGeo = new THREE.BufferGeometry();
skidGeo.setAttribute('position', new THREE.BufferAttribute(skid.pos, 3).setUsage(THREE.DynamicDrawUsage));
skidGeo.setAttribute('color', new THREE.BufferAttribute(skid.col, 4).setUsage(THREE.DynamicDrawUsage));
{
  const idx = new Uint32Array(SKID_N * 6);
  for (let q = 0; q < SKID_N; ++q) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
  skidGeo.setIndex(new THREE.BufferAttribute(idx, 1));
}
const skidMesh = new THREE.Mesh(skidGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
skidMesh.frustumCulled = false; skidMesh.renderOrder = 1;
scene.add(skidMesh);
const _cp = new THREE.Vector3();
function updateSkids() {
  const speed = Math.abs(S(7));
  let dirty = false;
  for (let w = 0; w < 4; ++w) {
    _cp.copy(v3(W(w, 0), W(w, 1), W(w, 2) - W(w, 3)));
    carRoot.localToWorld(_cp);
    const slip = Math.max(Math.abs(W(w, 7)) / 0.12, Math.abs(W(w, 8)) / 0.12);
    const a = W(w, 11) > 0 && speed > 0.8 ? Math.min(0.85, Math.max(0, (slip - 1.05) * 0.9)) : 0;
    const last = skid.last[w];
    if (!last || last.p.distanceToSquared(_cp) > 4) { skid.last[w] = { p: _cp.clone(), a }; continue; }
    if (last.p.distanceToSquared(_cp) < 0.0225) continue; // lay a quad every ~15 cm
    if (a > 0.02 || last.a > 0.02) {
      const dx = _cp.x - last.p.x, dz = _cp.z - last.p.z, len = Math.hypot(dx, dz) || 1;
      const hw = 0.12, nx = (-dz / len) * hw, nz = (dx / len) * hw;
      const q = skid.i; skid.i = (skid.i + 1) % SKID_N;
      const y0 = last.p.y + 0.012, y1 = _cp.y + 0.012;
      skid.pos.set([last.p.x + nx, y0, last.p.z + nz, last.p.x - nx, y0, last.p.z - nz, _cp.x + nx, y1, _cp.z + nz, _cp.x - nx, y1, _cp.z - nz], q * 12);
      const c = 0.04;
      skid.col.set([c, c, c, last.a, c, c, c, last.a, c, c, c, a, c, c, c, a], q * 16);
      dirty = true;
    }
    last.p.copy(_cp); last.a = a;
  }
  if (dirty) { skidGeo.attributes.position.needsUpdate = true; skidGeo.attributes.color.needsUpdate = true; }
}
window.__spwSkid = skid; // debugging
function resetSkidTrail() { skid.last = [null, null, null, null]; }

// ---------- Drift score ----------
// Points flow while the car is sideways at speed: (angle - 5 deg) x speed, times a multiplier that
// grows every 2.5 s of unbroken drifting (up to x5). A drift banks 1.2 s after it ends; hitting a
// wall or spinning out loses the unbanked points.
const drift = { combo: 0, time: 0, grace: 0, total: 0, best: store.get('driftBest', 0), flash: 0, cls: '' };
function driftMult() { return Math.min(5, 1 + Math.floor(drift.time / 2.5)); }
function updateDrift(dt) {
  const vx = S(7), vy = S(8), speed = Math.hypot(vx, vy);
  const angle = Math.abs(S(10)) * 180 / Math.PI;
  const rearDown = W(2, 11) > 0 || W(3, 11) > 0;
  const sideways = angle > 10 && angle < 100 && speed > 6 && vx > 0 && rearDown;
  const el = $('drift');
  if (S(31) > 3 || (angle > 100 && drift.combo > 0) || (speed < 1.5 && drift.combo > 0 && angle > 50)) {
    if (drift.combo > 50) { drift.flash = 1.2; drift.cls = 'fail'; $('dScore').textContent = 'Wipeout'; $('dMult').textContent = ''; $('dInfo').textContent = `lost ${Math.round(drift.combo).toLocaleString()}`; }
    drift.combo = 0; drift.time = 0; drift.grace = 0;
  } else if (sideways) {
    drift.time += dt; drift.grace = 0;
    drift.combo += dt * (angle - 5) * speed * 0.6 * driftMult();
  } else if (drift.combo > 0) {
    drift.grace += dt;
    if (drift.grace > 1.2) {
      const pts = Math.round(drift.combo);
      drift.total += pts;
      if (pts > drift.best) { drift.best = pts; store.set('driftBest', pts); }
      drift.flash = 1.4; drift.cls = 'bank';
      $('dScore').textContent = '+' + pts.toLocaleString(); $('dMult').textContent = '';
      $('dInfo').textContent = `total ${drift.total.toLocaleString()} · best drift ${drift.best.toLocaleString()}`;
      drift.combo = 0; drift.time = 0; drift.grace = 0;
    }
  }
  if (drift.combo > 0) {
    $('dScore').textContent = Math.round(drift.combo).toLocaleString();
    $('dMult').textContent = '×' + driftMult();
    $('dInfo').textContent = `${angle.toFixed(0)}° · ${(speed * 3.6).toFixed(0)} km/h` + (S(32) > 0 ? ` · holding ${(Math.abs(S(33)) * 180 / Math.PI).toFixed(0)}°` : '');
    el.className = 'on'; drift.flash = 0;
  } else if (drift.flash > 0) {
    drift.flash -= dt; el.className = 'on ' + drift.cls;
  } else el.className = '';
}

// ---------- Tyre smoke ----------
// Soft billboard puffs from wheels that are sliding fast (drifts, burnouts, lock-ups).
const SMOKE_N = MOBILE ? 260 : 700;
const smoke = { pos: new Float32Array(SMOKE_N * 3), alpha: new Float32Array(SMOKE_N), size: new Float32Array(SMOKE_N),
  vel: new Float32Array(SMOKE_N * 3), age: new Float32Array(SMOKE_N).fill(99), life: new Float32Array(SMOKE_N), a0: new Float32Array(SMOKE_N), i: 0, acc: [0, 0, 0, 0] };
const smokeGeo = new THREE.BufferGeometry();
smokeGeo.setAttribute('position', new THREE.BufferAttribute(smoke.pos, 3).setUsage(THREE.DynamicDrawUsage));
smokeGeo.setAttribute('alpha', new THREE.BufferAttribute(smoke.alpha, 1).setUsage(THREE.DynamicDrawUsage));
smokeGeo.setAttribute('size', new THREE.BufferAttribute(smoke.size, 1).setUsage(THREE.DynamicDrawUsage));
const smokeMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 400 } },
  vertexShader: `attribute float alpha; attribute float size; varying float vA; uniform float uScale;
    void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * uScale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
    gl_FragColor = vec4(vec3(0.86, 0.87, 0.88), vA * (1.0 - r) * (1.0 - r)); }`,
  transparent: true, depthWrite: false,
});
const smokePts = new THREE.Points(smokeGeo, smokeMat);
smokePts.frustumCulled = false;
scene.add(smokePts);
const _sp = new THREE.Vector3();
function updateSmoke(dt, worldVel) {
  smokeMat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
  const v = S(7);
  for (let w = 0; w < 4; ++w) {
    if (!(W(w, 11) > 0)) { smoke.acc[w] = 0; continue; }
    const kappa = Math.abs(W(w, 7)), alpha = Math.abs(W(w, 8));
    const slipSpeed = Math.hypot(W(w, 5) * W(w, 3) - v, Math.tan(Math.min(1.4, alpha)) * Math.abs(v));
    const intensity = Math.min(1, Math.max(0, (Math.max(kappa, alpha) / 0.12 - 1.6) / 2.5)) * Math.min(1, Math.max(0, (slipSpeed - 2.5) / 6));
    if (intensity <= 0) { smoke.acc[w] = 0; continue; }
    smoke.acc[w] += dt * intensity * (MOBILE ? 22 : 45);
    while (smoke.acc[w] >= 1) {
      smoke.acc[w] -= 1;
      const k = smoke.i; smoke.i = (smoke.i + 1) % SMOKE_N;
      _sp.copy(v3(W(w, 0), W(w, 1), W(w, 2) - W(w, 3) * 0.6));
      carRoot.localToWorld(_sp);
      smoke.pos.set([_sp.x + (Math.random() - 0.5) * 0.3, _sp.y, _sp.z + (Math.random() - 0.5) * 0.3], k * 3);
      smoke.vel.set([worldVel.x * 0.15 + (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.6, worldVel.z * 0.15 + (Math.random() - 0.5) * 1.2], k * 3);
      smoke.age[k] = 0; smoke.life[k] = 1.8 + Math.random() * 1.4; smoke.a0[k] = 0.22 + 0.28 * intensity;
    }
  }
  for (let k = 0; k < SMOKE_N; ++k) {
    if (smoke.age[k] >= smoke.life[k]) { smoke.alpha[k] = 0; continue; }
    smoke.age[k] += dt;
    const u = smoke.age[k] / smoke.life[k];
    const drag = Math.exp(-dt * 1.6);
    smoke.vel[k * 3] *= drag; smoke.vel[k * 3 + 1] *= drag; smoke.vel[k * 3 + 2] *= drag;
    smoke.pos[k * 3] += smoke.vel[k * 3] * dt; smoke.pos[k * 3 + 1] += smoke.vel[k * 3 + 1] * dt; smoke.pos[k * 3 + 2] += smoke.vel[k * 3 + 2] * dt;
    smoke.size[k] = 0.7 + 3.2 * Math.sqrt(u);
    smoke.alpha[k] = smoke.a0[k] * Math.min(1, u * 8) * (1 - u);
  }
  smokeGeo.attributes.position.needsUpdate = true; smokeGeo.attributes.alpha.needsUpdate = true; smokeGeo.attributes.size.needsUpdate = true;
}

// ---------- Mobile niceties ----------
{
  const el = document.documentElement;
  const fs = el.requestFullscreen ? () => el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen ? () => el.webkitRequestFullscreen() : null;
  const b = $('bFull');
  if (fs && MOBILE) {
    b.hidden = false;
    b.onclick = async (e) => {
      e.currentTarget.blur();
      try {
        if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        else { await fs(); await screen.orientation?.lock?.('landscape').catch(() => {}); }
      } catch { /* not allowed here */ }
    };
  }
  if (MOBILE && innerHeight > innerWidth) setTimeout(() => toast('Tip: turn your phone sideways for a wider view'), 1500);
  // No pinch-zoom / double-tap zoom of the page itself (the canvas handles its own pinch through
  // pointer events). iOS Safari ignores user-scalable=no, so block the gestures directly...
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 || (e.scale !== undefined && e.scale !== 1)) e.preventDefault();
  }, { passive: false });
  // ...and if the page does end up zoomed anyway, snap it back to 1:1 by re-applying the viewport.
  const meta = document.querySelector('meta[name=viewport]');
  const base = meta?.content || '';
  const vv = window.visualViewport;
  if (vv && meta) {
    let fixing = false;
    vv.addEventListener('resize', () => {
      if (fixing || vv.scale <= 1.01) return;
      fixing = true;
      meta.content = base.replace('initial-scale=1', 'initial-scale=1.0001');
      requestAnimationFrame(() => { meta.content = base; fixing = false; });
    });
  }
  let lastTap = 0;
  addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTap < 320 && !(e.target instanceof Element && e.target.closest('button,input,select,a'))) e.preventDefault(); lastTap = n; }, { passive: false });
}

// ---------- Sound ----------
const audio = new CarAudio();
window.__spwAudio = audio; // for debugging in the console
window.__spwDebris = () => ({ glass: destruction.glass.pieces.filter(Boolean).length, rubble: destruction.rubble.pieces.filter(Boolean).length, hidden: Object.values(walls).filter((w) => !w.mesh.visible).length });
window.__spwState = () => ({ pos: [S(0), S(1), S(2)], v: S(7), rpm: S(14), gear: S(15), thr: S(17), tcs: S(18), contact: [0, 1, 2, 3].map((w) => W(w, 11)), impact: S(31), upright: S(36), body: S(37) });
window.__spwPlace = (x, y = 0, yaw = 0) => placeAt({ x, y, yaw });
window.__spwBike = () => ({ t: B(2), frames: window.__frames, kind: B(0), fallen: B(1), v: B(3), lean: B(4), steer: B(5), pitch: B(6), target: B(7), torque: B(8), yaw: B(22), pos: [B(23), B(24), B(25)], grip: [B(16), B(17)] });
audio.enabled = store.get('sound', true); audio.volume = store.get('volume', 0.8);
async function unlockAudio() {
  try { await audio.start(); audio.setEnabled(audio.enabled); } catch (e) { console.warn('audio unavailable', e); }
}
addEventListener('pointerdown', unlockAudio, { once: true });
addEventListener('keydown', unlockAudio, { once: true });
function setSound(on) {
  audio.setEnabled(on); store.set('sound', on);
  $('bSound').setAttribute('aria-pressed', on); $('bSound').textContent = on ? 'Sound on' : 'Sound off';
  if (on) unlockAudio();
}
$('bSound').onclick = (e) => { setSound(!audio.enabled); e.currentTarget.blur(); };
$('vol').value = Math.round(audio.volume * 100);
$('vol').oninput = (e) => { audio.setVolume(+e.target.value / 100); store.set('volume', audio.volume); };
setSound(audio.enabled);
addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'm' && !e.repeat && !(e.target instanceof HTMLInputElement)) { setSound(!audio.enabled); toast(audio.enabled ? 'Sound on' : 'Sound off'); } });
// Tyre noise from the physics: squeal near and just past the grip peak, scrub when a tyre is
// sliding well past it or locked. Both need real sliding speed at the contact patch.
const tyreSnd = { squeal: 0, scrub: 0, pitch: 0 };
function tyreState() {
  let sq = 0, sc = 0, pitch = 0;
  const v = S(7);
  for (let w = 0; w < 4; ++w) {
    if (!(W(w, 11) > 0)) continue;
    const kappa = Math.abs(W(w, 7)), alpha = Math.abs(W(w, 8));
    const norm = Math.max(kappa / 0.12, alpha / 0.12);
    const slipSpeed = Math.hypot(W(w, 5) * W(w, 3) - v, Math.tan(Math.min(1.4, alpha)) * Math.abs(v));
    const loadF = Math.max(0.4, Math.min(1.4, W(w, 6) / 4000));
    const bell = Math.min(1, Math.max(0, (norm - 0.9) / 0.5)) * (norm < 2.5 ? 1 : Math.max(0.35, 1 - (norm - 2.5) / 3));
    sq = Math.max(sq, bell * Math.min(1, slipSpeed / 2) * loadF);
    let s = Math.min(1, Math.max(0, (norm - 1.8) / 2.5)) * Math.min(1, slipSpeed / 4) * loadF;
    if (W(w, 12) > 0) s = Math.max(s, Math.min(1, Math.abs(v) / 10) * loadF);
    sc = Math.max(sc, s);
    pitch = Math.max(pitch, Math.min(1, Math.max(0, (norm - 1) / 2)));
  }
  tyreSnd.squeal = Math.min(1, sq); tyreSnd.scrub = Math.min(1, sc); tyreSnd.pitch = pitch;
  return tyreSnd;
}

// ---------- Showcase controls ----------
function setRain(i, announce) {
  rainIdx = i; const r = RAIN_LEVELS[i];
  weather.set(r.rain); store.set('rain', r.rain);
  document.querySelectorAll('[data-rain]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.rain === i));
  if (announce) toast(r.rain ? `${r.name}: wet road, slick paint and cobbles, puddles that can make a tyre hydroplane` : 'Dry');
}
document.querySelectorAll('[data-rain]').forEach((b) => (b.onclick = (e) => { setRain(+b.dataset.rain, true); e.currentTarget.blur(); }));
$('bFlow').onclick = (e) => { cycleFlow(); e.currentTarget.blur(); };
$('bTunnel').onclick = (e) => { if (tunnel.on) exitTunnel(); else enterTunnel(); e.currentTarget.blur(); };
$('bTelemetry').onclick = (e) => { telemetry.toggle(); e.currentTarget.blur(); };
$('bReplay').onclick = (e) => { if (replay.on) closeReplay(); else openReplay(); e.currentTarget.blur(); };
document.querySelectorAll('[data-time]').forEach((b) => (b.onclick = () => { setTimeScale(+b.dataset.time); b.blur(); }));
window.__spwView = () => ({ flow: VIEW.flow, timeScale: VIEW.timeScale, tunnel: tunnel.on, replay: replay.on, telemetry: telemetry.on, page: telemetry.page,
  flowLines: flowView.ln.reduce((a, b) => a + b, 0), smoke: flowView.page.filter((a) => a < 1e8).length, rec: rewind.frames.length ? Array.from(rewind.frames[rewind.frames.length - 1].pose.tel || []) : null });
window.__spwTunnel = (on, kmh, yawDeg, flow) => { if (kmh) tunnel.speed = kmh / 3.6; if (yawDeg !== undefined) tunnel.yaw = yawDeg * Math.PI / 180; if (flow) tunnel.flow = flow; tunnel.label(); if (on) enterTunnel(); else exitTunnel(); tunnel.applyWind(); };
window.__spwTime = (k) => setTimeScale(k);
window.__spwReplay = (on, speed) => { if (on) { openReplay(); if (speed) replay.speed = speed; } else closeReplay(); };
$('bOverlay').onclick = (e) => { const on = overlay.toggle(); $('bOverlay').setAttribute('aria-pressed', on); if (on) toast('Physics overlay: friction circles, tyre forces, loads, g and the roll axis'); e.currentTarget.blur(); };
$('bGhost').onclick = (e) => { ghost.on = !ghost.on; store.set('ghost', ghost.on); $('bGhost').setAttribute('aria-pressed', ghost.on); toast(ghost.on ? 'Ghost on: your last run from the same start drives beside you' : 'Ghost off'); e.currentTarget.blur(); };
$('bGhost').setAttribute('aria-pressed', ghost.on);
$('bShadow').onclick = (e) => {
  if (isBike()) return;
  shadow.on = !shadow.on; $('bShadow').setAttribute('aria-pressed', shadow.on);
  if (shadow.on) { startShadow(); toast(shadow.car < 0 ? 'Shadow car: the stock version of your car, driven with your inputs' : 'Shadow car: ' + $('shadowCar').selectedOptions[0].textContent + ', driven with your inputs'); }
  else { M._ord_shadow_stop(); shadowCar.draw(null); }
  e.currentTarget.blur();
};
$('shadowCar').onchange = (e) => { shadow.car = +e.target.value; shadow.stock = true; if (shadow.on) startShadow(); e.target.blur(); };
{
  // the shadow car list: the stock version of this car, or any other car
  const sel = $('shadowCar');
  for (const o of $('car').querySelectorAll('option')) { if (+o.value >= 6 && +o.value <= 8) continue; const c = document.createElement('option'); c.value = o.value; c.textContent = o.textContent.split(' · ')[0]; sel.append(c); }
}
$('bShare').onclick = (e) => { shareLink(); e.currentTarget.blur(); };
{
  const hold = $('bRewind');
  hold.addEventListener('pointerdown', (e) => { e.preventDefault(); if (!isBike() && !lab?.active) rewindHold = true; hold.classList.add('on'); });
  const up = () => { rewindHold = false; hold.classList.remove('on'); };
  hold.addEventListener('pointerup', up); hold.addEventListener('pointercancel', up); hold.addEventListener('pointerleave', up);
}
if (WORLD === 'track') {
  $('mooseSpeed').oninput = (e) => { $('mooseSpeedV').textContent = e.target.value + ' km/h'; };
  $('bMooseRun').onclick = (e) => { if (!isBike()) moose.startRobot(+$('mooseSpeed').value, false); e.currentTarget.blur(); };
  $('bMooseLadder').onclick = (e) => { if (!isBike()) { moose.startRobot(Math.max(40, +$('mooseSpeed').value - 12), true); toast('Speed ladder: the robot runs the lane 4 km/h faster each time until it fails'); } e.currentTarget.blur(); };
  $('bMooseStop').onclick = (e) => { moose.stopRobot(); e.currentTarget.blur(); };
  for (const t of LAB_TESTS) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; $('labTest').append(o); }
  $('bLabRun').onclick = (e) => { runLabTest(LAB_TESTS.find((t) => t.id === $('labTest').value)); e.currentTarget.blur(); };
  $('bLoopAssist').onclick = (e) => { stunts.assist = !stunts.assist; $('bLoopAssist').setAttribute('aria-pressed', stunts.assist); toast(stunts.assist ? 'Loop assist on: it steers the small corrections that keep you on the ribbon' : 'Loop assist off: steer the loop yourself'); e.currentTarget.blur(); };
} else for (const id of ['bMooseRun', 'bMooseLadder', 'bMooseStop', 'bLabRun', 'bLoopAssist', 'labTest', 'mooseSpeed']) $(id).disabled = true;
window.__spwShow = () => ({ overlay: overlay.on, rain: weather.rain, puddles: weather.puddles.count, ghost: ghost.on, ghostRuns: Object.keys(ghost.runs), shadow: shadow.on, rewindFrames: rewind.frames.length, dents: crumpleLog.length,
  lab: lab?.mode, moose: moose ? { run: moose.run, robot: moose.robot, last: moose.last, results: moose.results } : null, glassViews: glassfx?.views.length ?? 0, glassJobs: glassfx ? [...glassfx.jobs.values()].map((j) => ({ seg: j.seg, ready: !!j.result, error: j.error, started: j.started, ms: j.result?.ms, pieces: j.result?.shapes.length })) : [] });
window.__spwCam = (cam, yaw, pitch, dist) => { settings.cam = cam; if (yaw !== undefined) { orbit.yaw = yaw; orbit.pitch = pitch; orbit.dist = dist; } camInit = true; };
window.__spwDamage = (m) => { if (m) setDamage(m); let mx = 0; for (const mm of crumple.meshes) for (let i = 0; i < mm.offset.length; i += 3) mx = Math.max(mx, Math.hypot(mm.offset[i], mm.offset[i + 1], mm.offset[i + 2])); return { mode: settings.damage, dents: crumpleLog.length, rawMax: mx, cap: crumple.cap(), card: $('crash').classList.contains('on'), phys: realisticOn() ? Array.from(damageState().slice(0, 46)) : null, panel: !$('dmgPanel').hidden, panelText: $('dmgPanel').innerText, debris: DMG.debris.length, ...(() => { let f0 = -1e9, f = -1e9; for (const mm of crumple.meshes) for (let i = 0; i < mm.body.length; i += 3) { f0 = Math.max(f0, mm.body[i]); f = Math.max(f, mm.body[i] + mm.offset[i]); } return { meshFront0: f0, meshFront: f }; })() }; };
window.__spwRewind = () => ({ hold: rewindHold, active: rewind.active, cursor: rewind.cursor, frames: rewind.frames.length, snaps: M._ord_snap_count() });
window.__spwLab = (id) => runLabTest(LAB_TESTS.find((t) => t.id === id));
window.__spwZone = (name) => { const z = ZONES.find((q) => q.name.startsWith(name)); if (z) placeAt(z); return !!z; };

// ---------- Main loop ----------
createCar();
setRain(rainIdx, false);
if (SHARE?.zone) { const z = ZONES.find((q) => q.name === SHARE.zone); if (z) placeAt(z); }
const MODEL_URL = MOBILE ? 'models/car_mobile.glb' : 'models/car.glb';
const savedModel = await fetch(MODEL_URL, { method: 'HEAD' }).then((r) => (r.ok ? true : false)).catch(() => false);
if (savedModel) {
  try { await loadModel(await (await fetch(MODEL_URL)).arrayBuffer(), 'Rosser V8', false); }
  catch (e) { console.warn('models/car.glb failed to load', e); }
}
$('loading').remove();
let last = performance.now();
const qIso = new THREE.Quaternion();
const _bp = new THREE.Vector3(), _bq = new THREE.Quaternion(), _bv = new THREE.Vector3(), _eye = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0), _zAxis = new THREE.Vector3(0, 0, 1);
const motoGears = [0, 12, 19, 26, 33, 40, 200]; // m/s: a pseudo 6-speed box, only for the engine sound
function frameBike(dt, now) {
  const inp = readInput(dt, 1, B(3));
  // Brake key: both brakes (front harder, like a rider); handbrake key: rear brake only.
  M._ord_bike_set_input(inp.steer, inp.throttle, inp.brake, Math.max(0.6 * inp.brake, inp.hand));
  M._ord_bike_advance(dt);
  bikeView.update(B);
  if (B(1) && !crashT) {
    crashT = now; bikeT.crashes++;
    toast(B(29) > 0 ? 'Crashed into something! Back on in 2 s' : Math.abs(B(6)) > 1 ? (B(6) > 0 ? 'Looped it! Back on in 2 s' : 'Over the bars! Back on in 2 s') : 'Down! Back on in 2 s · R resets');
    try { audio.impact(Math.min(1, Math.max(0.4, Math.abs(B(3)) / 10))); } catch { /* audio not ready */ }
  }
  if (crashT && now - crashT > 2000) {
    const yaw = B(22);
    createBike({ x: B(23) - Math.cos(yaw) * 1.5, y: B(24) - Math.sin(yaw) * 1.5, yaw }); // back on, upright, where it went down
  }
  const yaw = B(22), v = B(3);
  bikeView.framePos(_bp);
  _bq.setFromAxisAngle(_yAxis, yaw);
  _bv.set(Math.cos(yaw) * v, 0, -Math.sin(yaw) * v);
  if (settings.cam === 2) {
    // helmet camera: the rider's eye, leaning with the bike (half the lean, as a head would)
    bikeView.eye(_eye);
    camera.position.copy(_eye);
    camera.quaternion.copy(_bq).multiply(new THREE.Quaternion().setFromAxisAngle(_yAxis, -Math.PI / 2));
    camera.rotateZ(-0.5 * B(4));
    camera.rotateX(-0.06 + Math.max(-0.4, Math.min(0.4, B(6))));
    if (camera.fov !== 60) { camera.fov = 60; camera.updateProjectionMatrix(); }
    camInit = true;
  } else {
    updateCamera(dt, _bp, _bq, _bv, v, bikeT.ax);
    // chase cameras roll a little with the bike, so a lean reads as a lean
    if (settings.cam === 0 || settings.cam === 1 || settings.cam === 5) camera.rotateZ(-0.3 * B(4));
  }
  sun.position.copy(_bp).addScaledVector(SUN_DIR, 80); sun.target.position.copy(_bp);
  updateCones(dt, { x: B(23), y: B(24) }, { x: _bv.x, y: -_bv.z });
  updateBikeHud(dt, inp);
  updateCrash(now);
  try {
    if (settings.car === 8) {
      let g = 1; while (g < 6 && v > motoGears[g]) ++g;
      const lo = motoGears[g - 1], hi = Math.min(motoGears[g], 75);
      const rpm = 2200 + 9800 * Math.max(0, Math.min(1, (v - lo) / Math.max(1, hi - lo)));
      audio.update({ dt, rpm, load: inp.throttle, limiter: 12500, gear: g, speed: v, tyre: { squeal: 0, scrub: 0, pitch: 0 }, interior: false });
    } else {
      audio.update({ dt, rpm: 0, load: 0, limiter: 12500, gear: 0, speed: v, tyre: { squeal: 0, scrub: 0, pitch: 0 }, interior: false, engineOn: false });
    }
  } catch (e) { console.warn('audio update', e); }
  const z = zoneAt(B(23), B(24));
  if (z !== currentZone) { currentZone = z; $('zone').textContent = z; $('zone').classList.toggle('on', !!z); }
}
// ---------- Pose: read from the physics, or from a recording (rewind, ghost, crash-lab replay) ----------
let frameNo = 0;
function poseNow() {
  return { id: frameNo, x: S(0), y: S(1), z: S(2), qw: S(3), qx: S(4), qy: S(5), qz: S(6),
    wx: [W(0, 0), W(1, 0), W(2, 0), W(3, 0)], wy: [W(0, 1), W(1, 1), W(2, 1), W(3, 1)],
    wz: [W(0, 2), W(1, 2), W(2, 2), W(3, 2)], steer: [W(0, 4), W(1, 4), W(2, 4), W(3, 4)], omega: [W(0, 5), W(1, 5), W(2, 5), W(3, 5)] };
}
function drawPose(p, dt) {
  qIso.set(p.qx, p.qz, -p.qy, p.qw);
  carRoot.quaternion.copy(qIso);
  carRoot.position.copy(v3(p.x, p.y, p.z));
  const rigs = model?.hasWheels ? model.rigs : model ? null : wheelRigs;
  for (let w = 0; w < 4; ++w) {
    spinAngle[w] = (spinAngle[w] + p.omega[w] * dt) % (Math.PI * 2);
    const r = rigs?.[w];
    if (!r) continue;
    r.steer.position.copy(r.base); r.steer.position.y += p.wz[w] - restWheelZ[w];
    // a crushed corner moves the wheel's mount (realistic damage)
    if (p.wx && restWheelXY[w]) { r.steer.position.x += p.wx[w] - restWheelXY[w][0]; r.steer.position.z -= p.wy[w] - restWheelXY[w][1]; }
    r.steer.rotation.y = p.steer[w];
    r.spin.rotation.z = -spinAngle[w];
  }
}
// Shadow car: the same inputs, another setup or model, from where you are now.
function startShadow() {
  if (isBike()) return;
  const idx = shadow.car < 0 ? -1 : engineCar(shadow.car);
  if (!M._ord_shadow_start(idx, shadow.stock ? 1 : 0)) { toast('That car cannot run as a shadow'); shadow.on = false; return; }
  const p = M._ord_shadow_state() / 8, wh = [];
  for (let w = 0; w < M.HEAPF64[p + 22]; ++w) { const o = p + HEADER + PER_WHEEL * w; wh.push({ x: M.HEAPF64[o], y: M.HEAPF64[o + 1], z: M.HEAPF64[o + 2], r: M.HEAPF64[o + 3] }); }
  const xs = wh.map((w) => w.x);
  shadowCar.build({ wheels: wh, xf: Math.max(...xs), xr: Math.min(...xs), half: Math.max(...wh.map((w) => Math.abs(w.y))), groundZ: Math.min(...wh.map((w) => w.z - w.r)) });
}
function shadowPose() {
  const p = M._ord_shadow_state() / 8, H = M.HEAPF64;
  if (!H[p + 3] && !H[p + 4] && !H[p + 5] && !H[p + 6]) return null;
  const wl = (i) => [0, 1, 2, 3].map((w) => H[p + HEADER + PER_WHEEL * w + i]);
  return { x: H[p], y: H[p + 1], z: H[p + 2], qw: H[p + 3], qx: H[p + 4], qy: H[p + 5], qz: H[p + 6], wz: wl(2), steer: wl(4), v: H[p + 7] };
}
// Glass: when the car is heading for a pane fast enough to break it, have the glass engine break
// it ahead of time (~1.6 s), where the car will hit it.
function predictGlass() {
  if (!glassfx || isBike()) return;
  const v = S(7), x = S(0), y = S(1);
  if (v < 2.5 || Math.abs(y - SMASH.y[0]) > 6) return;
  const dist = SMASH.x - x;
  if (dist < 0 || dist > Math.max(6, v * 1.6)) return;
  const geo = carGeo(), mass = new Float64Array(M.HEAPF64.buffer, M._ord_vehicle_info(), 7)[3];
  for (const [seg, w] of Object.entries(walls)) {
    if (w.def.material !== 1 || !w.mesh.visible) continue;
    const y0 = Math.min(w.def.ay, w.def.by), y1 = Math.max(w.def.ay, w.def.by);
    if (y + geo.half + 0.2 < y0 || y - geo.half - 0.2 > y1) continue;
    // where along this section (from its first end) the car's centre line meets it, at bumper height
    glassfx.predict(+seg, w.def, (y - w.def.ay) * Math.sign(w.def.by - w.def.ay), 0.55, v, mass || 1500);
  }
}
// Share: this car, its setup, the weather and where you are, as a link.
async function shareLink() {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('world', WORLD);
  u.searchParams.set('car', settings.car);
  u.searchParams.set('preset', settings.preset);
  if (!isBike() && garage.setup) u.searchParams.set('setup', await deflateSetup(JSON.stringify(garage.setup)));
  if (weather.rain > 0) u.searchParams.set('rain', weather.rain);
  if (ghost.zone) u.searchParams.set('zone', ghost.zone);
  const link = u.href;
  try { await navigator.clipboard.writeText(link); toast('Link copied: this car, its setup, the weather and the place'); }
  catch { prompt('Copy this link', link); }
  return link;
}
window.__spwShare = shareLink;
let rewindHold = false;

function frameOnce(now, draw) {
  const dt = TICKS > 1 ? 1 / 60 : Math.min(0.1, (now - last) / 1000); last = now;
  adaptRes(dt);
  window.__frames = (window.__frames || 0) + 1;
  if (isBike()) { frameBike(dt, now); if (draw) renderer.render(scene, camera); return; }
  // crash lab: the live run and the slow-motion replay drive the car themselves
  if (lab?.active) {
    const rec = lab.mode === 'run' ? lab.stepRun(dt) : lab.stepReplay(dt);
    if (rec) {
      drawPose(rec, lab.mode === 'replay' ? dt * 0.1 : dt);
      if (!isBike()) for (const seat of [0, 1]) { const o = rec.occ[seat]; dummies.update(seat, o[0], o[1], o[2], o[3], o[4]); }
    }
    lab.camera(camera, carRoot.position);
    {
      const nb = M._ord_break_events();
      if (nb) { const buf = new Float64Array(M.HEAPF64.buffer, M._ord_break_buffer(), 8 * nb); for (let k = 0; k < nb; ++k) onWallBreak(Array.from(buf.subarray(8 * k, 8 * k + 8))); }
    }
    destruction.update(dt); glassfx?.update(dt);
    sun.position.copy(carRoot.position).addScaledVector(SUN_DIR, 80); sun.target.position.copy(carRoot.position);
    if (lab.mode === 'report') updateCrash(now);
    if (draw) renderer.render(scene, camera);
    return;
  }
  // replay: the recorded frames in slow motion, physics paused; the telemetry pages follow it
  if (replay.on) {
    const r = replay.update(dt);
    if (r) {
      drawPose(r.pose, r.dt);
      const fm = flowMode();
      if (!fm || !r.pose.tel) flowView.group.visible = false;
      if (fm && r.pose.tel) flowView.update(r.dt, fm, flowInputs(r.pose.tel));
      telemetry.update(now, r.pose.tel, r.hist, `Replay ${replay.speed}× · ${replay.playing ? 'playing' : 'paused'}`);
    }
    updateCamera(dt, carRoot.position, carRoot.quaternion, new THREE.Vector3(), 0, 0);
    sun.position.copy(carRoot.position).addScaledVector(SUN_DIR, 80); sun.target.position.copy(carRoot.position);
    if (draw) renderer.render(scene, camera);
    return;
  }
  // rewind: hold Backspace; the car runs backwards through its recent past, physics paused
  if (rewindHold) {
    const p = rewind.stepBack(2);
    if (p) drawPose(p, -dt * 2);
    const worldVel = new THREE.Vector3();
    updateCamera(dt, carRoot.position, carRoot.quaternion, worldVel, 0, 0);
    $('zone').textContent = '⟲ Rewind'; $('zone').classList.add('on'); currentZone = '⟲';
    if (draw) renderer.render(scene, camera);
    return;
  }
  if (rewind.active) {
    const target = rewind.frames[rewind.frames.length - 1 - rewind.cursor]?.pose.id ?? frameNo;
    rewind.resume((inp) => M._ord_set_input(inp.steer, inp.throttle, inp.brake, inp.hand, inp.shiftUp ? 1 : 0, inp.shiftDown ? 1 : 0));
    // walls, glass and dents back to how they were at that frame
    const n = M._ord_obstacle_count(), o = new Float64Array(M.HEAPF64.buffer, M._ord_obstacles(), 8 * n);
    for (const [i, w] of Object.entries(walls)) w.mesh.visible = !o[8 * i + 7];
    destruction.reset(); glassfx?.reset();
    const keep = crumpleLog.filter((c) => c.frame <= target);
    crumple.restore(); crumpleLog.length = 0;
    for (const c of keep) { crumple.setAmount(crumple.addHit(c.point, c.dir, c.depth, c.radius), 1); crumpleLog.push(c); }
    DMG.version = -1;   // the structure was rewound with the car: redraw it
    ghost.rec = ghost.rec.filter((g) => g.id <= target);
    ghost.t = ghost.rec.length ? ghost.rec[ghost.rec.length - 1].t : 0;
    if (shadow.on) startShadow();
    frameNo = target;
  }
  // slow motion: the world runs on simDt (the camera and the sound keep the wall clock)
  const simDt = dt * VIEW.timeScale;
  let inp = readInput(dt, S(15), S(7));
  const robot = moose?.control(dt);
  if (robot) inp = robot;
  if (stunts) inp.steer = stunts.assistSteer(inp.steer);
  if (tunnel.on) inp = tunnel.drive(simDt, S, carRoot.position, M._ord_ground_height(S(0), S(1)));
  const snap = rewind.beforeFrame();
  M._ord_set_input(inp.steer, inp.throttle, inp.brake, inp.hand, inp.shiftUp ? 1 : 0, inp.shiftDown ? 1 : 0);
  M._ord_advance(simDt);
  ++frameNo;
  const pose = poseNow();
  VIEW.simTime += simDt;
  pose.tel = captureTelemetry(S, W, telBuf(), VIEW.simTime);
  rewind.afterFrame(snap, simDt, inp, pose);
  const hit = S(31);
  if (hit > 1.2) { lastImpact = hit; try { audio.impact(Math.min(1, hit / 12)); } catch { /* audio not ready */ } }
  {
    const nh = M._ord_hit_events();
    if (nh) { const hb = new Float64Array(M.HEAPF64.buffer, M._ord_hit_buffer(), 7 * nh).slice(); for (let k = 0; k < nh; ++k) crumpleFromEvent(Array.from(hb.subarray(7 * k, 7 * k + 7))); }
    predictGlass();
    const nb = M._ord_break_events();
    if (nb) { const buf = new Float64Array(M.HEAPF64.buffer, M._ord_break_buffer(), 8 * nb); for (let k = 0; k < nb; ++k) onWallBreak(Array.from(buf.subarray(8 * k, 8 * k + 8))); }
    destruction.update(simDt);
    glassfx?.update(simDt);
  }
  if (S(23)) { toast('The simulation faulted (non-finite state). Resetting.'); placeAt(ZONES[0]); }
  // the body landing on the ground (rollover): a thump as hull points first touch
  if (tipped.contacts === 0 && S(37) > 0 && S(38) > 15000) { try { audio.impact(Math.min(1, S(38) / 120000)); } catch { /* audio not ready */ } }
  tipped.contacts = S(37);
  tipped.t = S(36) < 0.5 && Math.hypot(S(7), S(8)) < 2 ? tipped.t + simDt : 0;
  if (tipped.t > 1.5 && settings.damage === 'cosmetic' && !isBike() && !labOn() && !rewindHold) { resetCar(); toast('Back on your wheels'); }
  else if (tipped.t > 1.5 && !tipped.hinted) { toast(S(36) < -0.5 ? 'On its roof. Press R to put it back on its wheels' : 'On its side. Press R to put it back on its wheels'); tipped.hinted = true; }
  if (S(36) > 0.9) tipped.hinted = false;
  drawPose(pose, simDt);
  // ghost: this run is recorded; the last run from the same start plays beside it
  ghost.t += simDt;
  ghost.rec.push({ ...pose, t: ghost.t });
  if (ghost.rec.length > 60 * 120) ghost.rec.shift();
  const gRun = ghost.on && ghost.zone ? ghost.runs[ghost.zone] : null;
  if (gRun) {
    if (ghost.idx >= gRun.length || (ghost.idx > 0 && gRun[ghost.idx - 1].t > ghost.t)) ghost.idx = 0;
    while (ghost.idx < gRun.length - 1 && gRun[ghost.idx].t < ghost.t) ++ghost.idx;
    ghostCar.draw(ghost.t <= gRun[gRun.length - 1].t ? gRun[ghost.idx] : null);
  } else ghostCar.draw(null);
  const sp = shadow.on ? shadowPose() : null;
  shadowCar.draw(sp);
  const worldVel = new THREE.Vector3(S(7), 0, -S(8)).applyQuaternion(carRoot.quaternion);
  syncDamage(now, worldVel);
  updateDebris(simDt);
  // after a crash-lab test the camera stays on the wreck until you drive
  if (lab?.mode === 'report' && !(inp.throttle > 0.05 || inp.brake > 0.05 || Math.abs(inp.steer) > 0.05)) lab.camera(camera, carRoot.position);
  else updateCamera(dt, carRoot.position, carRoot.quaternion, worldVel);
  sun.position.copy(carRoot.position).addScaledVector(SUN_DIR, 80); sun.target.position.copy(carRoot.position);
  updateCones(simDt, { x: S(0), y: S(1) }, { x: worldVel.x, y: -worldVel.z });
  updateHud(simDt, inp, sp);
  updateCrash(now);
  updateLights(S(15) === -1 ? 0 : inp.brake);
  updateSkids();
  updateDrift(simDt);
  updateSmoke(simDt, worldVel);
  overlay.update(dt);
  moose?.update(simDt);
  stunts?.update(simDt);
  {
    const fm = flowMode();
    if (!fm) flowView.group.visible = false;
    if (fm) { flowView.wandY = tunnel.wandY; flowView.update(simDt, fm, flowInputs(pose.tel)); }
    telemetry.update(now, pose.tel, telemetryHistory(), VIEW.timeScale < 1 ? `Slow motion ${VIEW.timeScale}× (] faster)` : '');
    telemetry.hasFloor = aeroInfo()[20] > 0;
    if (tunnel.on) tunnel.read(now, pose.tel, aeroInfo()[10], aeroInfo()[20] > 0);
  }
  if (weather.rain > 0) {
    const wheels = [];
    const back = new THREE.Vector3(-1, 0, 0).applyQuaternion(carRoot.quaternion);
    for (let w = 0; w < 4; ++w) {
      const pw = v3(W(w, 0), W(w, 1), W(w, 2) - W(w, 3)).applyQuaternion(carRoot.quaternion).add(carRoot.position);
      wheels.push({ x: pw.x, y: pw.y, z: pw.z, contact: W(w, 11) > 0, back });
    }
    weather.update(simDt, camera.position, carRoot.position, Math.abs(S(7)), wheels, (k) => { try { audio.splash(k); } catch { /* audio not ready */ } });
  }
  try { audio.update({ dt, rpm: S(14), load: S(17), limiter: LIMITER[settings.car], gear: S(15), speed: S(7), tyre: tyreState(), interior: settings.cam === 2, rain: weather.rain, wet: weather.rain }); } catch (e) { console.warn('audio update', e); }
  recordRow();
  const z = zoneAt(S(0), S(1));
  if (z !== currentZone) { currentZone = z; $('zone').textContent = z; $('zone').classList.toggle('on', !!z); }
  if (draw) renderer.render(scene, camera);
}
// ?ticks=N (tests on slow software renderers): N fixed 1/60 s frames of logic per drawn frame.
const TICKS = Math.max(1, Math.min(30, +new URLSearchParams(location.search).get('ticks') || 1));
function frame(now) {
  for (let k = 0; k < TICKS; ++k) frameOnce(now, k === TICKS - 1);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
