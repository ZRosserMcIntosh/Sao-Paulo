// São Paulo World · driving test track.
// Physics: the OpenRoad Dynamics core (github.com/ZRosserMcIntosh/Game-Vehicle-Dynamics, MIT)
// compiled to WebAssembly. Rendering: three.js (MIT). This file only renders and reads input;
// every force, slip and aid intervention comes from the core.
import * as THREE from 'three';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/libs/meshopt_decoder.module.js';
import createOrdModule from './ord.mjs';
import { CarAudio } from './audio/audio.js';
import { loadCity, streetNamer } from './city.js';

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
const LIMITER = [7200, 6500, 6800, 8500, 12500, 9000];
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

// ---------- Settings ----------
const settings = {
  car: store.get('stellaPhysics', false) ? store.get('car', 5) : 5, // the Stella's own physics is the default
  preset: store.get('preset', 0),
  abs: true, tcs: 2, esc: 2, auto: true, drift: 0,
  cam: store.get('cam', 0),
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
scene.add(new THREE.HemisphereLight('#dbe8ff', '#4a4136', 0.9));
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
let groundZBody = -0.45;
let model = null; // { wrapper, rigs:[{steer,spin}|null x4], hasWheels }
let spinAngle = [0, 0, 0, 0];

const bodyMat = new THREE.MeshPhysicalMaterial({ color: '#d22a1f', roughness: 0.32, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.12 });
const glassMat = new THREE.MeshPhysicalMaterial({ color: '#33465e', roughness: 0.08, metalness: 0.6 });
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
    wheelRigs.push({ steer, spin, base: steer.position.clone() });
  }
  return { xf, xr, half, r, midX };
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
      steer.position.copy(centre); steer.add(spin); wrapper.add(steer);
      steer.updateMatrixWorld(true);
      for (const m of meshes) spin.attach(m);
      for (const m of calipers[w]) steer.attach(m);
      rigs[w] = { steer, spin, base: centre.clone() };
    });
  }
  inner.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  model = { wrapper, rigs, hasWheels, turn };
  setupLights(inner);
  setupPaint(inner);
  placeholder.visible = false;
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
];
function createCar() {
  applyAids();
  if (!M._ord_create(settings.car, ZONES[0].x, ZONES[0].y, ZONES[0].yaw)) { toast('Vehicle definition rejected by the physics core'); return; }
  // Settle on the brakes so the rest pose is the loaded suspension.
  for (let i = 0; i < 90; ++i) { M._ord_set_input(0, 0, 1, 0, 0, 0); M._ord_advance(1 / 60); }
  restWheelZ = [0, 1, 2, 3].map((w) => W(w, 2));
  groundZBody = Math.min(...[0, 1, 2, 3].map((w) => W(w, 2) - W(w, 3)));
  buildPlaceholder();
  buildTach();
  if (modelSource) loadModel(modelSource.buffer, modelSource.name, false);
  M._ord_reset(ZONES[0].x, ZONES[0].y, ZONES[0].yaw);
  resetTimers();
}
function placeAt(z) {
  M._ord_reset(z.x, z.y, z.yaw);
  resetSkidTrail?.();
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
function applyAids() {
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
  $('hPreset').textContent = ['Fun', 'Sport', 'Simulation', 'Drift'][settings.preset] + (customised() ? ' · custom' : '');
  $('iAbs').classList.toggle('on', settings.abs); $('iTcs').classList.toggle('on', settings.tcs > 0);
  $('iEsc').classList.toggle('on', settings.esc > 0); $('iCs').classList.toggle('on', settings.preset < 2);
}
function customised() { const d = presetAids(settings.preset); return d.abs !== settings.abs || d.tcs !== settings.tcs || d.esc !== settings.esc || d.auto !== settings.auto || d.drift !== settings.drift; }
function setPreset(p) { settings.preset = p; Object.assign(settings, presetAids(p)); store.set('preset', p); applyAids(); toast(['FUN: every aid on', 'SPORT: ABS + light TCS', 'SIMULATION: no aids, manual gearbox (E/Q)', 'DRIFT: throw it sideways, keep the throttle in, hold the turn to drift, let go to straighten'][p]); }
document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => setPreset(+b.dataset.preset)));
$('aAbs').onclick = () => { settings.abs = !settings.abs; applyAids(); };
$('aTcs').onclick = () => { settings.tcs = (settings.tcs + 1) % 3; applyAids(); };
$('aEsc').onclick = () => { settings.esc = (settings.esc + 1) % 3; applyAids(); };
$('aBox').onclick = () => { settings.auto = !settings.auto; applyAids(); };
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
$('car').onchange = (e) => { settings.car = +e.target.value; store.set('car', settings.car); store.set('stellaPhysics', true); createCar(); e.target.blur(); };
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
  if (k === 'r') placeAt(ZONES[0]);
  if (k === 'c') cycleCam();
  if (k === 'h') togglePanel();
  if (k === '1' || k === '2' || k === '3' || k === '4') setPreset(+k - 1);
  if (k === 'x') $('aDrift').click();
  if (k === 'b') $('aAbs').click();
  if (k === 't') $('aTcs').click();
  if (k === 'y') $('aEsc').click();
  if (k === 'g') $('aBox').click();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
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
function readInput(dt, gear, speed) {
  // Keyboard steering is digital; ramp it like a driver turning a wheel (the presets add their own shaping).
  const target = (keys.has('a') || keys.has('arrowleft') ? 1 : 0) - (keys.has('d') || keys.has('arrowright') ? 1 : 0);
  const rate = target === 0 || Math.sign(target) !== Math.sign(kbSteer) ? 6 : 3;
  kbSteer += Math.max(-rate * dt, Math.min(rate * dt, target - kbSteer));
  let steer = kbSteer;
  let up = keys.has('w') || keys.has('arrowup') ? 1 : 0;
  let down = keys.has('s') || keys.has('arrowdown') ? 1 : 0;
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
    if (pressed(3) && !was(3)) placeAt(ZONES[0]);
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
const CAMS = ['Chase', 'Far chase', 'Bonnet', 'Overhead', 'Free (drag to orbit)'];
let camInit = true;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function cycleCam() { settings.cam = (settings.cam + 1) % CAMS.length; store.set('cam', settings.cam); camInit = true; toast('Camera: ' + CAMS[settings.cam]); }
// Free camera: drag to orbit around the car, wheel / pinch to zoom. The orbit is relative to the
// car's heading so the chosen angle holds while driving. Dragging in any other camera switches to it.
const orbit = { yaw: store.get('orbitYaw', 2.6), pitch: store.get('orbitPitch', 0.32), dist: store.get('orbitDist', 7.5) };
{
  const ptrs = new Map(); let pinch0 = 0, dist0 = 0;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => { ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId);
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
function updateCamera(dt, carPos, carQuat, vel) {
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuat); fwd.y = 0; fwd.normalize();
  const vh = new THREE.Vector3(vel.x, 0, vel.z);
  const dir = vh.length() > 4 && S(7) > 2 ? vh.normalize().lerp(fwd, 0.5).normalize() : fwd;
  let want, look;
  if (settings.cam === 0 || settings.cam === 1) {
    if (camInit) chaseDir.copy(dir); else chaseDir.lerp(dir, 1 - Math.exp(-dt * 3.5)).normalize();
    chaseAccel += (Math.max(-1, Math.min(1, S(11) / G)) - chaseAccel) * (1 - Math.exp(-dt * 2));
    const far = settings.cam === 1;
    const dist = (far ? 12 : 6.2) + 0.4 * chaseAccel, h = far ? 4.5 : 2.1;
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
function resetTimers() { odo = 0; lastImpact = 0; Object.assign(timers, { vmax: 0, t0: null, last0100: null, brakeStart: null, last1000: null, maxLat: 0, slalomStart: null, slalomLast: null, conesHit: 0 }); trail.length = 0; }
let latF = 0, lonF = 0;

function updateHud(dt, inp) {
  const kmh = S(7) * 3.6;
  $('hSpeed').firstChild.nodeValue = Math.abs(Math.round(kmh)).toString();
  const gear = S(15);
  $('hGear').textContent = gear === -1 ? 'R' : gear === 0 ? 'N' : String(gear);
  updateTach(dt, S(14));
  let abs = false, esc = false;
  for (let w = 0; w < 4; ++w) {
    abs ||= W(w, 13) > 0; esc ||= W(w, 14) > 1;
    const load = W(w, 6), kappa = W(w, 7), alpha = W(w, 8);
    const slip = Math.max(Math.abs(kappa) / 0.12, Math.abs(alpha) / 0.12); // 1 ≈ near the tyre's peak
    const e = wheelEls[w];
    e.v.textContent = `${(load / 1000).toFixed(1)}kN`;
    e.bar.style.width = Math.min(100, slip * 70) + '%';
    e.bar.style.background = W(w, 12) > 0 ? 'var(--bad)' : slip > 1.15 ? 'var(--warn)' : 'var(--good)';
    e.el.style.opacity = W(w, 11) > 0 ? 1 : 0.4;
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
    `<span>Sideslip</span> <b>${fmt((S(10) * 180) / Math.PI, 1)}°</b>`;
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
window.__spwState = () => ({ pos: [S(0), S(1), S(2)], v: S(7), rpm: S(14), gear: S(15), thr: S(17), tcs: S(18), contact: [0, 1, 2, 3].map((w) => W(w, 11)), impact: S(31) });
window.__spwPlace = (x, y = 0, yaw = 0) => placeAt({ x, y, yaw });
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

// ---------- Main loop ----------
createCar();
const MODEL_URL = MOBILE ? 'models/car_mobile.glb' : 'models/car.glb';
const savedModel = await fetch(MODEL_URL, { method: 'HEAD' }).then((r) => (r.ok ? true : false)).catch(() => false);
if (savedModel) {
  try { await loadModel(await (await fetch(MODEL_URL)).arrayBuffer(), 'Rosser V8', false); }
  catch (e) { console.warn('models/car.glb failed to load', e); }
}
$('loading').remove();
let last = performance.now();
const qIso = new THREE.Quaternion();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  adaptRes(dt);
  const inp = readInput(dt, S(15), S(7));
  M._ord_set_input(inp.steer, inp.throttle, inp.brake, inp.hand, inp.shiftUp ? 1 : 0, inp.shiftDown ? 1 : 0);
  M._ord_advance(dt);
  const hit = S(31);
  if (hit > 1.2) { lastImpact = hit; try { audio.impact(Math.min(1, hit / 12)); } catch { /* audio not ready */ } }
  if (S(23)) { toast('The simulation faulted (non-finite state). Resetting.'); placeAt(ZONES[0]); }
  // car pose: ISO quaternion (w,x,y,z) -> three (w, x, z, -y)
  qIso.set(S(4), S(6), -S(5), S(3));
  carRoot.quaternion.copy(qIso);
  carRoot.position.copy(v3(S(0), S(1), S(2)));
  const rigs = model?.hasWheels ? model.rigs : model ? null : wheelRigs;
  for (let w = 0; w < 4; ++w) {
    spinAngle[w] = (spinAngle[w] + W(w, 5) * dt) % (Math.PI * 2);
    const r = rigs?.[w];
    if (!r) continue;
    r.steer.position.copy(r.base); r.steer.position.y += W(w, 2) - restWheelZ[w];
    r.steer.rotation.y = W(w, 4);
    r.spin.rotation.z = -spinAngle[w];
  }
  const worldVel = new THREE.Vector3(S(7), 0, -S(8)).applyQuaternion(carRoot.quaternion);
  updateCamera(dt, carRoot.position, carRoot.quaternion, worldVel);
  sun.position.copy(carRoot.position).addScaledVector(SUN_DIR, 80); sun.target.position.copy(carRoot.position);
  updateCones(dt, { x: S(0), y: S(1) }, { x: worldVel.x, y: -worldVel.z });
  updateHud(dt, inp);
  updateLights(S(15) === -1 ? 0 : inp.brake);
  updateSkids();
  updateDrift(dt);
  updateSmoke(dt, worldVel);
  try { audio.update({ dt, rpm: S(14), load: S(17), limiter: LIMITER[settings.car], gear: S(15), speed: S(7), tyre: tyreState(), interior: settings.cam === 2 }); } catch (e) { console.warn('audio update', e); }
  recordRow();
  const z = zoneAt(S(0), S(1));
  if (z !== currentZone) { currentZone = z; $('zone').textContent = z; $('zone').classList.toggle('on', !!z); }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
