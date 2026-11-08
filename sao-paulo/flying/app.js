// São Paulo World · flight test bed.
// The Aviation Dynamics flight core (C++20 → WebAssembly) flies the 172 or the Top G;
// this file only draws them and passes the pilot's inputs in. Every number on screen comes from
// the simulation: the HUD from avd_state, the instruments from avd_cockpit.
// World frame: ENU metres (x east, y north, z up) from MASP; three.js: (east, up, −north).
import * as THREE from 'three';
import createAvdModule from './avd.mjs';
import { buildAircraft } from './model.js';
import { buildJet, skin as jetSkin } from './jetmodel.js';
import { K, markingsFrom, drawPanel, PANEL_SPOTS } from './panel.js';
import { drawJetStrip } from './glass.js';
import { drawG1000, g1000Click, g1000Key, g1000WheelTarget, g1000Range, g1000Cursor, G1000_WHEEL, G1000_SPOTS } from './g1000.js';
import { buildCabin } from './cabin.js';
import { buildJetCabin } from './jetcabin.js';
import { buildKingAirCabin } from './kingaircabin.js';
import { FlightAudio, JetAudio, TurbopropAudio } from './audio.js';
import { buildIndex, searchAirports } from './airportsearch.js';
import { buildFlow } from './flow.js';
import { buildSmoke } from './smoke.js';
import { mountLoadSheet } from './loadsheet.js';
import { buildCity } from './buildings.js';
import { buildGround } from './ground.js';
import { buildCrash } from './crash.js';
import { buildIce } from './ice.js';
import { buildRain } from './rain.js';

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
  topg: { id: 'topg', name: 'Top G', file: './top_g.json', jet: true, fuse: { xNose: 0, xTail: -30.4, R: 1.31, z: 0.0 }, chase: 50, zoom: [20, 260], target: [-15, 0, 0.6], eye: [-3.4, 0.52, 0.42], tower: 48, shadow: 24 },
};
// Generated jets (Aviation-Dynamics tools/jetgen): their camera and body
// numbers come from the definition's visual block when it loads.
const JETS = [['phenom300', 'Phenom 300E'], ['cj4', 'Citation CJ4'], ['learjet45', 'Learjet 45'], ['crj700', 'CRJ700'], ['b738', '737-800']];
for (const [id, name] of JETS) PROFILES[id] = { id, name, file: `./${id}.json`, jet: true, fromVisual: true, fuse: { xNose: 0, xTail: -20, R: 1, z: 0 }, chase: 40, zoom: [15, 200], target: [-10, 0, 0.5], eye: [-3.4, 0.52, 0.42], tower: 40, shadow: 20 };
// The King Air 350: twin PT6A turboprops. It takes the jets' glass displays,
// starts, gear and split power levers (jet: true), its own flight deck
// (kingaircabin.js), engine page, propeller and condition levers, beta and
// reverse (turboprop: true).
PROFILES.kingair = { id: 'kingair', name: 'King Air 350', file: './king_air_350.json', jet: true, turboprop: true, fromVisual: true, fuse: { xNose: 0, xTail: -14.2, R: 0.8, z: 0 }, chase: 26, zoom: [10, 130], target: [-6.5, 0, 0.3], eye: [-2.55, 0.42, 0.38], tower: 24, shadow: 14 };
function applyVisual(p, d) {
  const v = d.visual;
  if (!p.fromVisual || !v) return;
  const st = v.fuselage_stations, L = -st[st.length - 1][0], R = Math.max(...st.map((q) => q[1]));
  Object.assign(p, {
    fuse: { xNose: 0, xTail: -L, R, z: 0 }, chase: v.camera.chase, zoom: [0.4 * v.camera.chase, 5 * v.camera.chase],
    target: v.camera.target, eye: v.camera.eye, tower: 0.9 * v.camera.chase, shadow: Math.max(12, 0.8 * Math.max(L, d.reference.span_m)),
  });
}
const hashPick = Object.keys(PROFILES).find((k) => location.hash.toLowerCase() === `#${k === 'c172' ? '172' : k}`);
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
// Spawn airport: 1 Congonhas (runway 35L, the default) or 0 Campo de Marte
// (runway 12). The world is built around it, so changing it reloads the page.
const AIRPORT = store.get('airport', 1) === 0 ? 0 : 1;
let A, def, M, MK;
function loadInto(json) {
  const errors = A.load(json);
  if (errors.length) throw new Error(errors.join('; '));
  def = JSON.parse(json);
  M = markingsFrom(A.markings());
  // The G1000's engine gauge ranges (avd_markings: tachometer, oil, suction, fuel).
  const R = A.markings();
  MK = { tachGreen: [R[9], R[10]], tachRed: R[11], tachMax: Math.min(R[12], 3000), oilP: [R[13], R[14], R[15], R[16]], oilT: [R[17], R[18], R[19]],
    vac: [R[20], R[21]], fuelFull: R[22] };
}
const hashFor = (p) => (p.id === 'c172' ? '#172' : `#${p.id}`);
// The region's terrain between the airfields (the flight core's tools/terrain:
// SRTM, a 200 m grid over 220 x 180 km), and the city's finer grid nested in
// it (50 m over 50 x 62 km round MASP), gzipped. Without them the core blends
// the fields' elevations as before.
async function fetchTerrain(file) {
  try {
    const r = await fetch(file);
    if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    if (b[0] !== 0x1f || b[1] !== 0x8b) return b;  // already decoded on the way
    return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  } catch { return null; }
}
// An AVT1 grid's extent (header: "AVT1", int32 nx, ny, float64 east0, north0, spacing, scale).
function avtExtent(b) {
  if (!b || b.length < 44 || String.fromCharCode(...b.subarray(0, 4)) !== 'AVT1') return null;
  const v = new DataView(b.buffer, b.byteOffset, 44), nx = v.getInt32(4, true), ny = v.getInt32(8, true);
  const e0 = v.getFloat64(12, true), n0 = v.getFloat64(20, true), step = v.getFloat64(28, true);
  return { e0, n0, e1: e0 + (nx - 1) * step, n1: n0 + (ny - 1) * step, step };
}
let FINE = null;  // the city grid's extent, for the drawn ground (ground.js)
// A turboprop's first load builds its propellers' blade-element tables: a few seconds in WebAssembly.
const SLOW_LOAD = (p) => (p.turboprop ? `Loading the ${p.name}: setting up its propellers takes a few seconds…` : '');
if (SLOW_LOAD(P)) loadMsg(SLOW_LOAD(P));
try {
  const [mod, json, terr, city] = await Promise.all([createAvdModule(), fetchDef(P), fetchTerrain('./terrain_sp.avt.gz'), fetchTerrain('./terrain_sp_city.avt.gz')]);
  A = mod;
  A.avd_set_airport(AIRPORT);  // before the first load: every reset uses it
  // Before the ground mesh and the buildings are laid on it.
  if (terr && A.terrain && A.terrain(terr) < 0) console.warn('terrain_sp.avt: not an AVT1 grid');
  if (city && A.terrainDetail) {
    if (A.terrainDetail(city) < 0) console.warn('terrain_sp_city.avt: not an AVT1 grid');
    else FINE = avtExtent(city);
  }
  loadInto(json);
  applyVisual(P, def);
} catch (e) {
  loadMsg('The flight core could not start: ' + e.message);
  throw e;
}
// The core's identity, for bug reports: shown at the foot of the menu.
$('coreId').textContent = `flight core ${A.buildId()} · ABI ${A.abiVersion}`;
const RW = A.runway();  // [paved start east, north, elevation, true heading, length, width] of the runway in use
const AP = A.airport();  // { icao, name, runway, reciprocal }
const ELEV = RW[2];
// The region: every airport (DESTS: names, runway ends, ILSs; REGION: runway
// geometry) and the core's ground, each field at its own elevation.
// A destination anywhere else in Brazil joins them after the region's REGION_N.
let DESTS = A.destinations(), REGION = A.region();
const REGION_N = REGION.length;
const groundAt = (e, n) => A.avd_ground_height(e, n);
const rwDir = [Math.sin(RW[3] * DEG), Math.cos(RW[3] * DEG)];
const rwMid = [RW[0] + rwDir[0] * RW[4] / 2, RW[1] + rwDir[1] * RW[4] / 2];
const rwRight = [rwDir[1], -rwDir[0]];  // right of the runway, looking down it
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
// Fog layer (Weather → Visibility): fog from the ground up to its top, with
// the visibility V inside it (extinction 3/V, the meteorological optical
// range). Every fogged material takes the optical depth of its line of sight
// inside the layer: the path's length times the fraction of it below the top
// (height varies linearly along a ray). Inside, the world greys out at V; from
// above, the ground fades under a white blanket. Uniform shared by reference:
// x top (scene y, m), y extinction (1/m, 0 = no layer), z grey level.
const FOG = { x: -1e9, y: 0, z: 0.8, w: 0 };
for (const k of Object.keys(THREE.ShaderLib)) { const u = THREE.ShaderLib[k].uniforms; if (u && u.fogColor) u.fogLayer = { value: FOG }; }
THREE.ShaderChunk.fog_pars_vertex += '\n#ifdef USE_FOG\n\tvarying vec3 vFogWorld;\n#endif';
THREE.ShaderChunk.fog_vertex += '\n#ifdef USE_FOG\n\tvFogWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );\n#endif';
THREE.ShaderChunk.fog_pars_fragment += '\n#ifdef USE_FOG\n\tvarying vec3 vFogWorld;\n\tuniform vec4 fogLayer;\n#endif';
THREE.ShaderChunk.fog_fragment += `
#ifdef USE_FOG
	if ( fogLayer.y > 0.0 ) {
		float fLo = min( cameraPosition.y, vFogWorld.y ), fHi = max( cameraPosition.y, vFogWorld.y );
		float fIn = fHi - fLo > 0.01 ? clamp( ( fogLayer.x - fLo ) / ( fHi - fLo ), 0.0, 1.0 ) : step( fLo, fogLayer.x );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( fogLayer.z ), 1.0 - exp( - fogLayer.y * distance( vFogWorld, cameraPosition ) * fIn ) );
	}
#endif`;
const camera = new THREE.PerspectiveCamera(60, 1, 0.12, 90000);
const ambient = new THREE.AmbientLight('#ffffff', 0.58);
scene.add(ambient);
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

// ---------- Ground: the São Paulo World map on the core's ground ----------
// The core's ground (avd_ground_height): each airport's field flat at its own
// elevation, the region's real terrain between them (SRTM, a 200 m grid; over
// the city a 50 m grid). Drawn by ground.js in chunks around the camera and
// the aircraft: at the core's own resolution (and finer) near them, coarser
// farther out (under the city's buildings never below the core's ground,
// elsewhere its mean), out to ~100 km beyond the map, the map photo draped
// over its area.
const enu = (e, n, u) => new THREE.Vector3(e, u, -n);
// Vertices relative to (ox, oy), the mesh placed there: far from the world
// origin, 32-bit vertex positions would otherwise lose centimetres.
function heightMesh(x0, y0, nx, ny, step, skip, mat, drop, ox = 0, oy = 0) {
  const pos = new Float32Array((nx + 1) * (ny + 1) * 3), uv = new Float32Array((nx + 1) * (ny + 1) * 2), idx = [];
  for (let j = 0, k = 0; j <= ny; ++j) for (let i = 0; i <= nx; ++i, ++k) {
    const e = x0 + i * step, n = y0 + j * step;
    pos[3 * k] = e - ox; pos[3 * k + 1] = groundAt(e, n) - drop; pos[3 * k + 2] = -(n - oy);
    uv[2 * k] = i / nx; uv[2 * k + 1] = j / ny;
  }
  for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) {
    if (skip && skip(x0 + (i + 0.5) * step, y0 + (j + 0.5) * step)) continue;
    const a = j * (nx + 1) + i, b = a + 1, c2 = a + nx + 1, d2 = c2 + 1;
    idx.push(a, b, c2, b, d2, c2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.position.set(ox, 0, -oy);
  return m;
}
const TN = 104;  // km of terrain beyond the map on each side
const ground = buildGround({ groundAt, bounds: [MX0 - TN * 1000, MY0 - TN * 1000, MX1 + TN * 1000, MY1 + TN * 1000], map: [MX0, MY0, MX1, MY1], fine: FINE });
scene.add(ground.group);
// Where the city has buildings (buildings.js's tile index): the drawn ground
// keeps above the core's there (see ground.js).
fetch('./buildings/index.json').then((r) => r.json()).then((ix) => ground.setBuilt(Object.keys(ix.tiles || {}))).catch(() => { /* buildings everywhere */ });
// Rebuilt when a destination beyond the region joins the ground: it shifts
// the blend everywhere a little, and gets ground of its own (a 1 km patch
// around it, and a coarse corridor from the region to it).
const terrain = new THREE.Group();
scene.add(terrain);
const groundMat = new THREE.MeshLambertMaterial({ color: '#77796f' });
const farMat = new THREE.MeshLambertMaterial({ color: '#77796f', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const inMain = (e, n) => e > MX0 - TN * 1000 && e < MX1 + TN * 1000 && n > MY0 - TN * 1000 && n < MY1 + TN * 1000;
function buildTerrain() {
  for (const m of [...terrain.children]) { m.geometry.dispose(); terrain.remove(m); }
  ground.rebuild();
  for (let i = REGION_N; i < REGION.length; ++i) {
    const [ce, cn] = fieldCentre(REGION[i]);
    if (inMain(ce, cn)) continue;
    // 1 km around the field, then a corridor back to the region (cells of
    // at least 4 km, under 150 a side), pushed back in depth so the finer
    // ground wins where they overlap.
    const half = 25;
    terrain.add(heightMesh(ce - half * 1000, cn - half * 1000, 2 * half, 2 * half, 1000, null, groundMat, 0.3, ce, cn));
    const x0 = Math.min(ce, MX0) - 40000, x1 = Math.max(ce, MX1) + 40000, y0 = Math.min(cn, MY0) - 40000, y1 = Math.max(cn, MY1) + 40000;
    const step = Math.max(4000, Math.max(x1 - x0, y1 - y0) / 150);
    const nx = Math.ceil((x1 - x0) / step), ny = Math.ceil((y1 - y0) / step);
    const nearField = (e, n) => inMain(e, n) || (Math.abs(e - ce) < half * 1000 - step && Math.abs(n - cn) < half * 1000 - step);
    terrain.add(heightMesh(x0, y0, nx, ny, step, nearField, farMat, 2, (x0 + x1) / 2, (y0 + y1) / 2));
  }
}
// The city's buildings from OpenStreetMap (buildings.js): every building
// around the aircraft, the skyline (35 m and up) beyond. Data © OpenStreetMap
// contributors, ODbL.
const city = buildCity({ base: './buildings/', groundAt, mobile: MOBILE, maxAniso: renderer.capabilities.getMaxAnisotropy(),
  physics: { add: (i, j, bytes) => A.buildingsTile(i, j, bytes), drop: (i, j) => A.avd_buildings_drop(i, j) } });
scene.add(city.group);
// What an impact throws up: dust, smoke and pieces (crash.js).
const crashFx = buildCrash({ groundAt: (x, z) => groundAt(x, -z) });
scene.add(crashFx.group);
function impact() {
  const tr = s[61] * DEG, gs = s[12] * 0.514444;
  // Dust off the ground; aloft (a structural failure), smoke.
  crashFx.burst(enu(s[0], s[1], s[2]), new THREE.Vector3(gs * Math.sin(tr), s[15] * 0.00508, -gs * Math.cos(tr)), s[14] > 60 ? '#6b6763' : '#a39886');
}
let showCity = store.get('city', true);
city.group.visible = showCity;
new THREE.TextureLoader().load(MOBILE ? '../img/mosaic_world_sm.jpg' : '../img/mosaic_world.jpg', (t) => {
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  ground.material.map = t; ground.material.needsUpdate = true;
});

// A runway: asphalt, threshold bars, numbers, centreline; from its paved
// start (east, north), true heading, length and width, at an elevation.
function drawRunway(e0, n0, hdg, len, wid, elev, id1, id2, parent = scene) {
  const W = 128, H = 4096, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), pxm = H / len;
  g.fillStyle = '#3c3f43'; g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#e9e9e4';
  const edge = 0.9 * W / wid;
  g.fillRect(2, 0, edge, H); g.fillRect(W - 2 - edge, 0, edge, H);
  for (let y = 70 * pxm; y < H - 70 * pxm; y += 60 * pxm) g.fillRect(W / 2 - 1.5, H - y - 36 * pxm, 3, 36 * pxm);
  const end = (flip) => {
    g.save();
    if (flip) { g.translate(W, H); g.rotate(Math.PI); }
    for (let i = 0; i < 8; ++i) { const x = 8 + i * 14 + (i >= 4 ? 4 : 0); g.fillRect(x, H - 8 - 30 * pxm, 8, 30 * pxm); }
    g.font = `900 ${Math.round(8 * pxm)}px Arial`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.save(); g.translate(W / 2, H - 44 * pxm); g.scale(0.8, 1.6); g.fillText(flip ? id2 : id1, 0, 0); g.restore();
    g.restore();
  };
  end(false); end(true);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // Phong, its highlight off while dry: wet (avd_state[63]) it darkens and shines (setRunwayWet).
  const mat = new THREE.MeshPhongMaterial({ map: t, specular: 0x000000, shininess: 90, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  runwayMats.push(mat);
  const rw = new THREE.Mesh(new THREE.PlaneGeometry(wid, len), mat);
  rw.rotation.set(-Math.PI / 2, 0, -hdg * DEG);
  rw.position.copy(enu(e0 + Math.sin(hdg * DEG) * len / 2, n0 + Math.cos(hdg * DEG) * len / 2, elev + 0.02));
  rw.receiveShadow = true;
  parent.add(rw);
}
// The runways' wetness: the rain's water film or the set runway water (mm):
// darker asphalt and the sky's sheen; standing water (3 mm and more) more so.
const runwayMats = [];
let runwayWet = -1;
function setRunwayWet(mm) {
  const w = mm > 0.02 ? clamp(0.35 + mm / 3, 0, 1) : 0;
  if (Math.abs(w - runwayWet) < 0.01) return;
  runwayWet = w;
  for (const m of runwayMats) { m.color.setScalar(1 - 0.38 * w); m.specular.setScalar(0.45 * w); m.shininess = 40 + 80 * w; }
}
// The runway in use (avd_runway), then every other runway of the region; the
// fields off the map get a grass apron so they read from the air.
drawRunway(RW[0], RW[1], RW[3], RW[4], RW[5], ELEV, AP.runway, AP.reciprocal);
// A field's centre (the mean of its runways' midpoints) and the distance to its farthest runway end.
function fieldCentre(ap) {
  let ce = 0, cn = 0, r = 0;
  for (let k = 0; k < ap.ends.length; k += 2) {
    const a = ap.ends[k];
    ce += a.east + Math.sin(a.heading * DEG) * a.length / 2; cn += a.north + Math.cos(a.heading * DEG) * a.length / 2;
  }
  ce /= ap.ends.length / 2; cn /= ap.ends.length / 2;
  for (const a of ap.ends) r = Math.max(r, Math.hypot(a.east - ce, a.north - cn));
  return [ce, cn, r];
}
function drawField(i, parent) {
  const ap = REGION[i], [ce, cn, r] = fieldCentre(ap);
  for (let k = 0; k < ap.ends.length; k += 2) {
    const a = ap.ends[k], home = Math.hypot(a.east - RW[0], a.north - RW[1]) < 1;
    if (!home) drawRunway(a.east, a.north, a.heading, a.length, a.width, ap.elevation, DESTS[i].ends[k].runway, DESTS[i].ends[k + 1].runway, parent);
  }
  if (ce > MX0 && ce < MX1 && cn > MY0 && cn < MY1) return;
  const apron = new THREE.Mesh(new THREE.CircleGeometry(r + 700, 48),
    new THREE.MeshLambertMaterial({ color: '#717b5f', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  apron.rotation.x = -Math.PI / 2; apron.position.copy(enu(ce, cn, ap.elevation - 0.15)); apron.receiveShadow = true;
  parent.add(apron);
}
for (let i = 0; i < REGION_N; ++i) drawField(i, scene);
// A destination beyond the region: its fields, redrawn when it changes.
const farFields = new THREE.Group();
scene.add(farFields);
function drawFarFields() {
  farFields.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose();
    const k = runwayMats.indexOf(o.material); if (k >= 0) runwayMats.splice(k, 1);
  });
  farFields.clear();
  runwayWet = -1;  // the new runways take the wetness on the next frame
  for (let i = REGION_N; i < REGION.length; ++i) drawField(i, farFields);
}
buildTerrain();
ground.update(RW[0], RW[1], 50, 30000, Infinity);  // the ground around the field before the first frame
{
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
    // The King Air: its own two-crew flight deck in its own metres; the jets: the Top G's, scaled to the nose.
    const cab = p.turboprop ? buildKingAirCabin({ mobile: MOBILE, maxAniso, skin: model.skin || jetSkin, ids: A.cockpit().map((x) => x.id) })
      : p.jet ? buildJetCabin({ mobile: MOBILE, maxAniso, skin: model.skin || jetSkin, scale: def.visual?.nose_scale || 1 })
        : buildCabin({ mobile: MOBILE, maxAniso });
    // The ice the core grows on the leading edges (ice.js).
    model.ice = buildIce(def);
    model.root.add(model.ice.root);
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
const smoke = buildSmoke({ renderer, mobile: MOBILE });
scene.add(smoke.group);
const rainFx = buildRain({ mobile: MOBILE });
scene.add(rainFx.group);
const invM = new THREE.Matrix4();
// The flat ground (ENU height h) as a plane in the aircraft's structural
// frame (x fwd, y right, z down): [n, d] with n . p >= d above the ground.
const gUp = new THREE.Vector3(), gPt = new THREE.Vector3(), gQ = new THREE.Quaternion();
function groundPlane(h) {
  if (!(h > -1e8)) return null;
  acGroup.getWorldQuaternion(gQ).invert();
  gUp.set(0, 1, 0).applyQuaternion(gQ);
  acGroup.getWorldPosition(gPt);
  gPt.y = h;
  gPt.applyMatrix4(invM);
  const n = [gUp.x, -gUp.y, -gUp.z];
  return [n[0], n[1], n[2], n[0] * gPt.x - n[1] * gPt.y - n[2] * gPt.z];
}
const bodyPoint = (x, y, z) => acGroup.localToWorld(new THREE.Vector3(x, y, z));

// ---------- State ----------
const ui = {
  assist: store.get('assist', 0), cam: store.get('cam', 0), instr: store.get('instr', true),
  start: 0, paused: false, crashed: false, sound: false, vol: store.get('vol', 80), slow: 0, vis: 0,
};
// Slow motion: the whole simulation (flight, airflow, smoke, propeller) runs
// this many times slower than real time, as in the golf ball's wind tunnel.
const SLOWS = [1, 10, 100, 1000, 5000];
let crashHeard = false;  // the crash's sound has played: the continuous sounds are silent
let propPhase = 0, simClock = 0, stepPos = null, stepT = 0, stepVel = new THREE.Vector3();
// levers: the jet's two thrust levers while split ([engine 1, engine 2]);
// null while they move together on `throttle`.
const input = { pitch: 0, roll: 0, yaw: 0, throttle: 0.1, mixture: 1, brake: 0, trimRate: 0, starter: 0, levers: null, prop: 1 };
// A turboprop's indication (A.turboprop()), read each frame.
let tp = null;
// The weather at the aircraft and the field (A.weather()) and the ice on it (A.icing()), each frame.
let wx = null, icing = null;
// The attitude reference's state (A.attitude(): AHRS or gyro, the ATT flag while it aligns), each frame.
let att = null;
// One engine's lever (splits them; `throttle` keeps their mean), and the lever as it stands.
function setLever(i, v) {
  if (!input.levers) input.levers = [input.throttle, input.throttle];
  input.levers[i] = clamp(v, 0, 1);
  input.throttle = (input.levers[0] + input.levers[1]) / 2;
}
const leverPos = (i) => (input.levers ? input.levers[i] : input.throttle);
// Every lever together (the plain throttle keys, the slider, the gamepad).
function setThrottle(v) { input.throttle = clamp(v, 0, 1); input.levers = null; }
let trimPulse = null;  // { rate, until }: the cockpit's trim wheel turned by hand
let s = new Float64Array(A.layout.state), c = new Float64Array(A.layout.cockpit), j = new Float64Array(A.layout.jet);
let lastIas = 0, iasAcc = 0;  // speed trend (kt/s, filtered)
const failed = { fuel: false, 0: false, 1: false, 2: false, 3: false, 4: false, 5: false };
let parkHint = false;

const PISTON_STARTS = [
  { name: `Runway ${AP.runway}`, sub: 'engine running', go: () => A.avd_reset(1), thr: 0.1 },
  { name: 'Cold and dark', sub: `runway ${AP.runway}`, go: () => A.avd_reset(0), thr: 0.1 },
  { name: `Final ${AP.runway}`, sub: '3 km, flaps 20', go: () => A.avd_reset(2), trim: true },
  { name: `Downwind ${AP.runway}`, sub: '1000 ft, 90 kt', go: () => A.avd_reset_air(rwMid[0] - rwRight[0] * 1000, rwMid[1] - rwRight[1] * 1000, 305, (RW[3] + 180) % 360, 90, 0), trim: true },
  { name: 'Avenida Paulista', sub: 'toward MASP', go: () => A.avd_reset_air(1600, -1100, 450, 305, 100, 0), trim: true },
  { name: 'Centro', sub: 'Sé, Martinelli, Luz', go: () => A.avd_reset_air(2100, -1000, 400, 0, 100, 0), trim: true },
  { name: 'Ibirapuera', sub: 'park and Obelisco', go: () => A.avd_reset_air(-2000, -4500, 400, 50, 100, 0), trim: true },
  { name: 'Ponte Estaiada', sub: 'Pinheiros river', go: () => A.avd_reset_air(-3800, -8500, 300, 345, 95, 0), trim: true },
];
const JET_STARTS = [
  { name: `Runway ${AP.runway}`, sub: 'engines at idle', go: () => A.avd_reset(1), thr: 0 },
  { name: 'Cold and dark', sub: `runway ${AP.runway}`, go: () => A.avd_reset(0), thr: 0 },
  { name: `Final ${AP.runway}`, sub: '6 km, Vref + 5, full flap', go: () => A.avd_reset(2), trim: true },
  { name: `Downwind ${AP.runway}`, sub: '2000 ft, 180 kt', go: () => A.avd_reset_air(rwMid[0] - rwRight[0] * 2500, rwMid[1] - rwRight[1] * 2500, 610, (RW[3] + 180) % 360, 180, 1), trim: true },
  { name: 'Avenida Paulista', sub: 'low pass, 220 kt', go: () => A.avd_reset_air(3200, -2200, 330, 305, 220, 0), trim: true },
  { name: 'Centro', sub: '2000 ft, 220 kt', go: () => A.avd_reset_air(2100, -3000, 600, 0, 220, 0), trim: true },
  { name: 'Ibirapuera', sub: '2000 ft, 220 kt', go: () => A.avd_reset_air(-4000, -7000, 600, 40, 220, 0), trim: true },
  { name: 'Cruise FL410', sub: 'high and fast over the city', go: () => A.avd_reset_air(0, -9000, 12497 - ELEV, 340, 253, 0), trim: true },
];
const TP_STARTS = [
  { name: `Runway ${AP.runway}`, sub: 'engines at low idle', go: () => A.avd_reset(1), thr: 0 },
  { name: 'Cold and dark', sub: `runway ${AP.runway}`, go: () => A.avd_reset(0), thr: 0 },
  { name: `Final ${AP.runway}`, sub: '6 km, Vref + 5, full flap', go: () => A.avd_reset(2), trim: true },
  { name: `Downwind ${AP.runway}`, sub: '1500 ft, 150 kt', go: () => A.avd_reset_air(rwMid[0] - rwRight[0] * 2000, rwMid[1] - rwRight[1] * 2000, 457, (RW[3] + 180) % 360, 150, 1), trim: true },
  { name: 'Avenida Paulista', sub: 'low pass, 200 kt', go: () => A.avd_reset_air(3200, -2200, 330, 305, 200, 0), trim: true },
  { name: 'Centro', sub: '2000 ft, 200 kt', go: () => A.avd_reset_air(2100, -3000, 600, 0, 200, 0), trim: true },
  { name: 'Ibirapuera', sub: '2000 ft, 200 kt', go: () => A.avd_reset_air(-4000, -7000, 600, 40, 200, 0), trim: true },
  { name: 'Cruise FL240', sub: 'over the city, 190 kt', go: () => A.avd_reset_air(0, -9000, 7315 - ELEV, 340, 190, 0), trim: true },
];
// ---------- Destination: search Brazil's airports; its ILS on NAV 1, a GPS route ----------
let DEST = null;  // { ai, ri, icao, name, runway, ils, khz, synthetic }
let BR = null, brIndex = null;  // airports_br.json records and their search index
const brReady = fetch('./airports_br.json').then((r) => r.json())
  .then((d) => { BR = d.airports; brIndex = buildIndex(BR); }).catch(() => { /* region only */ });
const destQ = $('destQ'), destRes = $('destRes'), destCard = $('destCard');
const regionIndex = (icao) => DESTS.slice(0, REGION_N).findIndex((d) => d.icao === icao);
function kmFromHome(lat, lon) {
  const [la0, lo0] = [-23.5611 * DEG, -46.6558 * DEG], la = lat * DEG, lo = lon * DEG;
  const h = Math.sin((la - la0) / 2) ** 2 + Math.cos(la0) * Math.cos(la) * Math.sin((lo - lo0) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
// An airport's approaches, one per runway end: { runway, ils, khz, synthetic,
// heading (true deg, approximate), length (m) }. A region airport has the
// region's own (Congonhas: 35L and 17R, as modelled); any other its record's.
function approachesOf(rec) {
  const ri = regionIndex(rec.icao);
  if (ri >= 0) return DESTS[ri].ends.map((e, k) => ({ ...e, heading: REGION[ri].ends[k].heading, length: REGION[ri].ends[k].length }));
  return rec.rw.flatMap((w) => w.ends.map((id) => {
    const i = rec.ils.find((x) => x.rwy === id);
    return { runway: id, ils: i?.id || null, khz: i ? Math.round(i.mhz * 1000) : 0, synthetic: false,
      heading: ((parseInt(id, 10) || 0) * 10 - 21.5 + 360) % 360, length: w.len * 0.3048 };
  }));
}
// The approach to fly when an airport is picked: an ILS first, then into the
// set wind, then the longest runway.
function preferredApproach(list) {
  const kt = +$('wind').value, from = +$('windDir').value;
  const score = (e) => (e.ils ? 1000 : 0) + (kt >= 5 ? 50 * Math.cos((e.heading - from) * DEG) : 0) + e.length / 1000;
  return list.reduce((b, e, k) => (score(e) > score(list[b]) ? k : b), 0);
}
// Fly to approach k of an airport (a region index, or a record).
function chooseApproach(rec, k, announce = true) {
  const ri = regionIndex(rec.icao);
  if (ri >= 0) { setDestination(ri, k, announce); return; }
  const ai = A.setDestinationRecord(rec, k);
  if (ai < 0) { toast(`${rec.icao}: that runway can't be flown here.`, 3); return; }
  refreshRegion();
  const id = rec.rw.flatMap((w) => w.ends)[k];
  setDestination(ai, DESTS[ai].ends.findIndex((e) => e.runway === id), announce);
}
let cardRec = null;  // the airport shown in the card
function showCard(rec) {
  cardRec = rec;
  destCard.hidden = !rec;
  if (!rec) return;
  const list = approachesOf(rec), km = kmFromHome(rec.lat, rec.lon);
  destCard.innerHTML = `<div class="dh"><div><b>${rec.icao}${rec.iata ? ` · ${rec.iata}` : ''}</b> ${rec.name}
    <small>${[rec.city, rec.state].filter(Boolean).join(', ')} · ${Math.round(rec.elev)} ft · ${km < 10 ? 'here' : `${Math.round(km)} km`}</small></div>
    <button id="destClear" title="No destination" aria-label="Clear the destination">✕</button></div>
    <div class="row">${list.map((e, k) => `<button data-appr="${k}" aria-pressed="${!!(DEST && DEST.icao === rec.icao && DEST.runway === e.runway)}"
      title="${e.ils ? `ILS ${e.ils} ${(e.khz / 1000).toFixed(2)}${e.synthetic ? ' (a test ILS: Campo de Marte has none)' : ''}` : 'GPS approach with a 3° vertical path'}">${e.ils ? 'ILS' : 'RNAV'} ${e.runway}${e.ils ? ` · ${e.ils} ${(e.khz / 1000).toFixed(2)}` : ''}</button>`).join('')}</div>`;
  destCard.querySelectorAll('[data-appr]').forEach((b) => b.addEventListener('click', () => { chooseApproach(rec, +b.dataset.appr); b.blur(); }));
  $('destClear').addEventListener('click', () => { setDestination(-1, 0, true); destQ.value = ''; });
}
// The search box: results as you type; arrows and Enter pick, Escape closes.
let results = [], active = 0;
function regionRecords() {
  // Before airports_br.json arrives: the region's airports as records.
  return DESTS.slice(0, REGION_N).map((d, i) => ({ icao: d.icao, iata: '', name: d.name, city: d.name, state: 'SP', kind: 'M', elev: REGION[i].elevation / 0.3048, lat: -23.5, lon: -46.6, alias: '', rw: [], ils: [] }));
}
function renderResults() {
  destQ.setAttribute('aria-expanded', String(!destRes.hidden));
  destRes.innerHTML = results.length ? results.map(({ a }, i) => `<button role="option" data-i="${i}" aria-selected="${i === active}"><b>${a.icao}${a.iata ? ` · ${a.iata}` : ''}</b> ${a.name}
    <small>${[a.city, a.state].filter(Boolean).join(', ')}${a.ils?.length ? ` · ILS ${a.ils.map((x) => x.rwy).join(', ')}` : ''} · ${Math.round(kmFromHome(a.lat, a.lon))} km</small></button>`).join('')
    : '<div class="none">No airport matches. Try a city, a name or a code.</div>';
  destRes.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('mousedown', (e) => { e.preventDefault(); pickResult(+b.dataset.i); }));
}
function pickResult(i) {
  const rec = results[i]?.a;
  if (!rec) return;
  destRes.hidden = true; destQ.setAttribute('aria-expanded', 'false');
  destQ.value = `${rec.icao}${rec.iata ? ` · ${rec.iata}` : ''} — ${rec.city || rec.name}`;
  showCard(rec);
  if (rec.rw.length || regionIndex(rec.icao) >= 0) chooseApproach(rec, preferredApproach(approachesOf(rec)));
  destQ.blur();
}
destQ.addEventListener('input', () => {
  const q = destQ.value;
  results = q.trim() ? searchAirports(brIndex || buildIndex(regionRecords()), q, 8) : [];
  active = 0;
  destRes.hidden = !q.trim();
  renderResults();
});
destQ.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { active = (active + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % Math.max(results.length, 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'Enter') { pickResult(active); e.preventDefault(); }
  else if (e.key === 'Escape') { destRes.hidden = true; destQ.blur(); }
});
destQ.addEventListener('focus', () => { if (destQ.value.includes(' — ')) destQ.select(); });
destQ.addEventListener('blur', () => setTimeout(() => { destRes.hidden = true; destQ.setAttribute('aria-expanded', 'false'); }, 150));
// After a destination beyond the region joins the core: its ground, fields and label.
function refreshRegion() {
  DESTS = A.destinations();
  REGION = A.region();
  buildTerrain();
  drawFarFields();
  buildLabels();
}
// The starts: the aircraft's own, plus the destination's approach and final.
function startsFor() {
  const base = P.turboprop ? TP_STARTS : P.jet ? JET_STARTS : PISTON_STARTS;
  if (!DEST) return base;
  return [...base,
    { name: `Approach ${DEST.icao} ${DEST.runway}`, sub: `10 NM out, ${DEST.ils ? `intercept ${DEST.ils}` : 'GPS'}`, go: () => A.avd_reset(4), trim: true },
    { name: `Final ${DEST.icao} ${DEST.runway}`, sub: `${P.jet ? '6' : '3'} km, on the 3° path`, go: () => A.avd_reset(5), trim: true }];
}
const nm = (m, d = 1) => (m / 1852).toFixed(d);
function setDestination(ai, ri, announce) {
  const d = DESTS[ai], e = d?.ends[ri];
  if (!e) { DEST = null; A.avd_set_destination(-1, 0); }
  else { DEST = { ai, ri, icao: d.icao, name: d.name, runway: e.runway, ils: e.ils, khz: e.khz, synthetic: e.synthetic }; A.avd_set_destination(ai, ri); }
  store.set('dest', DEST ? `${DEST.icao}|${DEST.runway}` : '');
  if (!DEST) showCard(null);
  else if (cardRec?.icao === DEST.icao) showCard(cardRec);
  STARTS = startsFor();
  buildStarts();
  if (announce && DEST) {
    const r = A.route();
    toast(`${DEST.icao} ${DEST.runway}: ${DEST.ils ? `NAV 1 on ${DEST.ils} ${(DEST.khz / 1000).toFixed(2)}, course set` : 'no ILS, GPS approach'}; route ${r.wp.map((w) => w.ident).join(' → ')}, ${nm(A.gps()[9], 0)} NM.`, 7);
  } else if (announce) toast('Destination cleared.', 2);
}
// The last destination, back after a reload: a region airport at once, any
// other once the airport list has arrived.
function restoreDestination() {
  const [icao, rwy] = String(store.get('dest', '')).split('|');
  if (!icao || !rwy) return;
  const ri = regionIndex(icao);
  if (ri >= 0) {
    const k = DESTS[ri].ends.findIndex((e) => e.runway === rwy);
    if (k < 0) return;
    setDestination(ri, k, false);
    destQ.value = `${icao} — ${DESTS[ri].name}`;
    brReady.then(() => { const rec = BR?.find((a) => a.icao === icao); if (rec && DEST?.icao === icao) showCard(rec); });
    return;
  }
  brReady.then(() => {
    const rec = BR?.find((a) => a.icao === icao), k = rec ? rec.rw.flatMap((w) => w.ends).indexOf(rwy) : -1;
    if (k < 0) return;
    chooseApproach(rec, k, false);
    showCard(rec);
    destQ.value = `${rec.icao}${rec.iata ? ` · ${rec.iata}` : ''} — ${rec.city || rec.name}`;
  });
}

let STARTS = startsFor();
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
restoreDestination();

function applyWeather() {
  const kt = +$('wind').value, dir = +$('windDir').value, turb = +$('turb').value, temp = +$('temp').value;
  // An icing preset sets the temperature in its layer (the ISA deviation that
  // makes its OAT there), and humid air; else the slider's.
  const ice = ICING[wxx.icing?.level || 0];
  A.avd_set_weather(kt * 0.5144, dir, turb, ice ? ice.oat - (15 - 0.0065 * wxx.icing.alt) : temp, ice ? 0.9 : 0.6);
  if (A.setRain) A.setRain(wxx.rain);
  if (ice) A.avd_set_cloud(wxx.icing.alt - 600, wxx.icing.alt + 600, ice.lwc); else A.avd_set_cloud(0, 0, 0);
  $('temp').disabled = !!ice;
  A.avd_set_wind_detail(+$('turbClass').value, +$('thermals').value, 1500);
  A.avd_set_runway_water(+$('rwyWater').value);
  ui.vis = +$('vis').value || 0;
  $('visNote').hidden = !ui.vis;
  $('visNote').textContent = ui.vis >= 2 ? `${VIS_NOTES[ui.vis]} For an approach: Flight → Destination, pick a runway, then start on its approach.` : VIS_NOTES[ui.vis];
  $('windV').textContent = kt ? `${kt} kt` : 'calm';
  $('windDirV').textContent = `${String(dir).padStart(3, '0')}°`;
  $('turbV').textContent = turb ? `${turb.toFixed(1)} m/s` : 'none';
  $('tempV').textContent = ice ? `${ice.oat} °C in cloud` : temp ? `ISA ${temp > 0 ? '+' : '−'}${Math.abs(temp)} °C` : 'ISA';
}
for (const id of ['wind', 'windDir', 'turb', 'temp']) $(id).addEventListener('input', applyWeather);
// Turbulence class, thermals, hazard and runway: kept across reloads.
// What each visibility means for an approach (ICAO categories: decision height and RVR).
const VIS_NOTES = [
  '',
  'Haze: the far city fades. Visual flying.',
  'Mist: 1,500 m up to about 1,000 ft, under the 5 km visual minimum: fly an instrument approach.',
  'Fog, RVR 550 m, top about 650 ft: CAT I. On the ILS, the approach lights must be in sight at the 200 ft decision height, or go around.',
  'Fog, RVR 300 m, top about 500 ft: CAT II. Decision height 100 ft on the radio altimeter.',
  'Fog, RVR 175 m, top about 400 ft: CAT IIIa. Decision height under 100 ft; airliners land on the autoland or a head-up display.',
  'Fog, RVR 75 m, top about 330 ft: CAT IIIb. The runway shows only in the flare: land on the instruments.',
  'Fog, zero visibility: CAT IIIc. Nothing outside: fly the ILS or GPS needles to the flare on the radio altimeter and steer the rollout on the localizer. The core lands every aircraft this way, blind, within CAT III limits (the Aviation Dynamics blind-landing validation).',
];
for (const id of ['turbClass', 'thermals', 'hazard', 'rwyWater', 'vis']) {
  $(id).value = String(store.get(`wx:${id}`, $(id).value));
  $(id).addEventListener('change', (e) => {
    store.set(`wx:${id}`, e.target.value);
    if (id === 'hazard') { A.avd_set_wind_hazard(+e.target.value); toast(+e.target.value ? `${e.target.selectedOptions[0].textContent}: placed now, around ${AP.name}.` : 'Hazard cleared.', 3); }
    else applyWeather();
    e.target.blur();
  });
}
A.avd_set_wind_hazard(+$('hazard').value);

// ---------- Rain, icing, fronts ----------
// Rain (mm/h, A.setRain): the visibility falls, the runways wet. An icing
// preset: a supercooled stratus 1,200 m deep round the altitude it was chosen
// at (avd_set_cloud) at -5, -7 or -10 °C there; the airframe ices
// (A.icing()). A front (A.setFront) reaching the field in the minutes set.
const ICING = [null, { name: 'light', lwc: 0.2, oat: -5 }, { name: 'moderate', lwc: 0.4, oat: -7 }, { name: 'severe', lwc: 0.8, oat: -10 }];
const wxx = { rain: +store.get('wx:rain', 0) || 0, icing: store.get('wx:icing', null), front: store.get('wx:front', 'none'), eta: +store.get('wx:frontEta', 10) || 10 };
if (!wxx.icing || !ICING[wxx.icing.level] || !Number.isFinite(wxx.icing.alt)) wxx.icing = null;
$('rain').value = String(wxx.rain);
$('icing').value = String(wxx.icing?.level || 0);
$('front').value = ['none', 'cold', 'warm'].includes(wxx.front) ? wxx.front : 'none';
$('frontEta').value = String(wxx.eta);
function applyFront() {
  if (!A.setFront) return;
  A.setFront({ kind: $('front').value, etaMin: wxx.eta });
  $('frontEtaV').textContent = `${wxx.eta} min`;
}
$('rain').addEventListener('change', (e) => { wxx.rain = +e.target.value; store.set('wx:rain', wxx.rain); applyWeather(); e.target.blur(); });
$('icing').addEventListener('change', (e) => {
  const level = +e.target.value;
  wxx.icing = level ? { level, alt: Math.round(s[53] * 0.3048) } : null;
  store.set('wx:icing', wxx.icing);
  applyWeather();
  if (level) toast(`Icing, ${ICING[level].name}: a cloud layer from ${fmt((wxx.icing.alt - 600) / 0.3048 / 100) * 100} to ${fmt((wxx.icing.alt + 600) / 0.3048 / 100) * 100} ft at ${ICING[level].oat} °C, ${ICING[level].lwc} g/m³ of supercooled water. Choose it again to move it to your altitude.`, 6);
  e.target.blur();
});
$('front').addEventListener('change', (e) => { wxx.front = e.target.value; store.set('wx:front', wxx.front); applyFront(); if (wxx.front !== 'none') toast(`A ${wxx.front} front reaches ${AP.icao} in ${wxx.eta} min: watch the QNH and the OAT.`, 4); e.target.blur(); });
$('frontEta').addEventListener('input', (e) => { wxx.eta = +e.target.value; store.set('wx:frontEta', wxx.eta); $('frontEtaV').textContent = `${wxx.eta} min`; });
$('frontEta').addEventListener('change', (e) => { applyFront(); e.target.blur(); });
// Ice protection: the 172's carburettor heat, the jets' wing and tail anti-ice
// (or de-ice boots): buttons for the controls this aircraft has, and \ (Shift+\: the second).
let iceCtl = [];
function buildIceSwitches() {
  iceCtl = A.cockpit().filter((x) => /^(anti_ice\.|engine\d\.carb_heat$)/.test(x.id));
  const row = $('iceSw');
  row.innerHTML = iceCtl.map((x, k) => `<button data-icectl="${x.id}" aria-pressed="false" title="${x.label}${k < 2 ? ` (${k ? 'Shift+' : ''}\\)` : ''}">${x.id.endsWith('carb_heat') ? 'CARB HEAT' : x.label.replace(/ \(.*\)/, '').replace('Anti-Ice', 'A/I').replace('De-Ice Boots', 'boots').toUpperCase()}</button>`).join('');
  row.hidden = !iceCtl.length;
  row.querySelectorAll('[data-icectl]').forEach((b) => b.addEventListener('click', (e) => { toggleIce(b.dataset.icectl); e.currentTarget.blur(); }));
  $('iceNone').hidden = iceCtl.length > 0;
}
function toggleIce(id) {
  const x = A.cockpit().find((q) => q.id === id);
  if (!x) { toast('No ice protection on this aircraft.', 2); return; }
  setControl(id, x.position ? 0 : 1);
  const on = !x.position, label = id.endsWith('carb_heat') ? 'Carburettor heat' : x.label;
  toast(`${label}: ${on ? (id.endsWith('carb_heat') ? 'HOT (some power lost; the ice melts, the engine may run rough as it goes)' : 'ON') : (id.endsWith('carb_heat') ? 'COLD' : 'OFF')}.`, 3);
}

function restart(i = ui.start) {
  ui.start = i;
  smoke.reset();
  crashFx.clear();
  if (ap.on) { ap.on = false; apUi(); }  // the core's reset lets go of it
  minimumsUntil = 0; apStatus = { on: false, lateral: 0, vertical: 0 };
  if (autoland) { A.autoland(false); autoland = false; $('bAutoland').setAttribute('aria-pressed', 'false'); }
  if (!STARTS[i]) ui.start = i = 0;
  const st = STARTS[i];
  applyWeather();
  input.prop = 1;
  if (P.turboprop) { A.setPropLever(1); A.setReverse(0); reverse = 0; }  // propeller levers full forward (rated rpm) before a trimmed spawn
  st.go();
  A.avd_set_assist(ui.assist);
  input.pitch = input.roll = input.yaw = input.trimRate = 0;
  input.throttle = st.trim ? A.avd_trim_throttle() : st.thr;
  input.levers = null;
  input.mixture = st.trim ? A.avd_trim_mixture() : 1;
  for (const k of Object.keys(failed)) failed[k] = false;
  document.querySelectorAll('[data-fail], [data-feather]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  resetPrompts();
  ui.crashed = false; parkHint = false;
  A.events();  // drop the reset's own events
  s = A.state().slice();  // the new spawn's state (the old one's 'on the ground, parking brake set' would release it)
  [...startsEl.children].forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
  snapCamera = true;
  if (i === 0 && P.turboprop) {
    const jj = A.jet(), vr = Math.round(1.1 * jj[33]);
    toast(`Runway ${AP.runway}: propeller levers forward (${MOBILE ? 'full' : '⇧. '}), flaps ${Math.round(jj[49])} or up, power (${MOBILE ? 'slide THR up' : '+ or X'}) to the torque limit, rotate at about ${vr} kt, gear up (${MOBILE ? 'GEAR' : 'G'}).`, 7);
  } else if (i === 0 && P.jet) {
    // VR as the PFD bugs it (glass.js): for the take-off flap, the middle detent.
    const jj = A.jet(), vr = Math.round(1.2 * jj[33]) - 6;
    toast(`Runway ${AP.runway}: flaps ${Math.round(jj[49])} (${MOBILE ? 'FL+' : '.'}), full thrust (${MOBILE ? 'slide THR up' : '+ or X'}), rotate at ${vr} kt, gear up (${MOBILE ? 'GEAR' : 'G'}) once climbing.`, 7);
  }
  else if (i === 0) toast(`Runway ${AP.runway}: full throttle (${MOBILE ? 'slide THR up' : '+ or X'}), keep straight, ease back at 55 kt.`, 6);
  else if (i === 1) toast('Cold and dark: run the Quick Start (Flight menu), or work the switches.', 6);
  else toast(`${st.name}: trimmed and level, ${st.sub}.`);
}

// ---------- Controls ----------
const keys = new Set();
const keyMap = {
  KeyW: 'pitchDown', ArrowUp: 'pitchDown', KeyS: 'pitchUp', ArrowDown: 'pitchUp',
  KeyA: 'rollLeft', ArrowLeft: 'rollLeft', KeyD: 'rollRight', ArrowRight: 'rollRight',
  KeyQ: 'yawLeft', KeyE: 'yawRight', Equal: 'thrUp', NumpadAdd: 'thrUp', KeyX: 'thrUp',
  Minus: 'thrDown', NumpadSubtract: 'thrDown', KeyZ: 'thrDown', KeyB: 'brake',
  BracketLeft: 'trimDown', BracketRight: 'trimUp', KeyN: 'reverse',
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
// The jet's levers one at a time: Shift+X / Shift+Z engine 1, Alt+X / Alt+Z engine 2.
const THR_KEYS = { KeyX: 'thrUp', KeyZ: 'thrDown' };
// A turboprop's propeller levers: Shift+, / Shift+. (held: down to 1,450 rpm, up to 1,700).
const PROP_KEYS = { Comma: 'propDown', Period: 'propUp' };
const CONDITIONS = ['CUT-OFF', 'LOW IDLE', 'HIGH IDLE'];
function setCondition(p) {
  if (!P.turboprop) return;
  A.setCondition(-1, p);
  toast(`Condition levers: ${CONDITIONS[p]}${p === 0 ? ' (fuel off: the engines shut down)' : p === 2 ? ' (Ng 72 %)' : ''}.`, 2.5);
}
function setFeather(i, on) {
  if (!P.turboprop) return;
  A.setFeather(i, on);
  document.querySelectorAll(`[data-feather="${i}"]`).forEach((b) => b.setAttribute('aria-pressed', String(on)));
}
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (THR_KEYS[e.code] && P.jet && (e.shiftKey || e.altKey) && !e.ctrlKey && !e.metaKey) { keys.add(THR_KEYS[e.code] + (e.shiftKey ? 1 : 2)); e.preventDefault(); return; }
  if (PROP_KEYS[e.code] && P.turboprop && e.shiftKey) { keys.add(PROP_KEYS[e.code]); e.preventDefault(); return; }
  if (P.turboprop && e.shiftKey && /^Digit[123]$/.test(e.code)) { if (!e.repeat) setCondition(+e.code[5] - 1); e.preventDefault(); return; }
  if (e.code === 'KeyN' && P.turboprop) { keys.add(e.shiftKey ? 'beta' : 'reverse'); e.preventDefault(); return; }
  if (keyMap[e.code]) { keys.add(keyMap[e.code]); e.preventDefault(); }
  if (e.repeat) return;
  switch (e.code) {
    case 'Comma': flaps(-1); break;
    case 'Period': flaps(1); break;
    case 'KeyP': setControl('brakes.parking', controlPos('brakes.parking') ? 0 : 1); break;
    case 'KeyG': toggleGear(); break;
    case 'Slash': cycleSpeedbrake(); e.preventDefault(); break;
    case 'KeyV': cycleFlow(); break;
    case 'KeyT': setSlow(ui.slow + (e.shiftKey ? -1 : 1)); break;
    case 'KeyK': A.avd_ai_cage(); toast(att?.ahrs ? 'AHRS RESET: the attitude reference re-aligns (ATT flag for about 30 s; hold the wings level).' : P.jet ? 'Attitude reference re-aligned (do it wings level).' : 'Attitude indicator caged (do it wings level).', 3); break;
    // F: the prompt's action when one is up (Easy, Sport); else the heading sync. Esc puts the prompt away.
    case 'KeyF': if (!promptAct()) { A.avd_dg_sync(); toast(P.jet ? 'Heading re-synced to the magnetometer.' : 'Heading indicator set to the compass.', 2); } break;
    case 'Escape': promptDismiss(); break;
    case 'Semicolon': case 'Quote': {
      const step = (e.code === 'Quote' ? 1 : -1) * (e.shiftKey ? 1 : 5);
      A.avd_heading_bug((Math.round(c[K.bug]) + step + 360) % 360); break;
    }
    case 'KeyO': A.avd_altimeter_adjust(e.shiftKey ? -1 : 1); break;
    case 'KeyC': cycleCam(); break;
    case 'KeyI': toggleInstr(); break;
    case 'KeyR': restart(); break;
    case 'KeyH': togglePanel(); break;
    case 'KeyJ': setGlass(!ui.glass, true); break;
    case 'KeyL': setLevel(!ui.level, true); break;
    case 'KeyU': setAutoland(!autoland); break;
    case 'KeyY': if (e.shiftKey) toggleApr(); else setAutopilot(!ap.on); break;
    case 'PageUp': case 'PageDown': apSelect('alt', (e.code === 'PageUp' ? 1 : -1) * (e.shiftKey ? 100 : 500)); e.preventDefault(); break;
    case 'KeyM': toggleSound(); break;
    case 'Backslash': { const x = iceCtl[e.shiftKey ? 1 : 0]; if (x) toggleIce(x.id); else toast('No ice protection to switch here.', 2); break; }
    case 'Space': togglePause(); e.preventDefault(); break;
    default:
  }
});
addEventListener('keyup', (e) => {
  if (keyMap[e.code]) keys.delete(keyMap[e.code]);
  if (THR_KEYS[e.code]) for (const k of ['', 1, 2]) keys.delete(THR_KEYS[e.code] + k);  // the modifier may go first
  if (PROP_KEYS[e.code]) keys.delete(PROP_KEYS[e.code]);
  if (e.code === 'KeyN') keys.delete('beta');
});
addEventListener('blur', () => keys.clear());

// Touch: stick (pitch/roll; on the ground it also steers), throttle slider, flaps and brake.
const touch = { x: 0, y: 0, id: null, thrId: null, brake: false, rev: false };
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
  const setThr = (e) => { const r = thr.getBoundingClientRect(); setThrottle(1 - (e.clientY - r.top - 15) / (r.height - 30)); };
  thr.addEventListener('pointerdown', (e) => { touch.thrId = e.pointerId; thr.setPointerCapture(e.pointerId); setThr(e); });
  thr.addEventListener('pointermove', (e) => { if (e.pointerId === touch.thrId) setThr(e); });
  thr.addEventListener('pointerup', () => { touch.thrId = null; });
  $('tGear').addEventListener('pointerdown', () => toggleGear());
  $('tSpd').addEventListener('pointerdown', () => cycleSpeedbrake());
  const rev = $('tRev');
  rev.addEventListener('pointerdown', (e) => { touch.rev = true; rev.classList.add('on'); rev.setPointerCapture(e.pointerId); });
  const revEnd = () => { touch.rev = false; rev.classList.remove('on'); };
  rev.addEventListener('pointerup', revEnd); rev.addEventListener('pointercancel', revEnd);
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
  const dThr = ((gp.buttons[7]?.value || 0) - (gp.buttons[6]?.value || 0)) * 0.5 * dt;
  if (dThr) setThrottle(input.throttle + dThr);
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
  if (k('thrUp')) setThrottle(input.throttle + 0.5 * dt);
  if (k('thrDown')) setThrottle(input.throttle - 0.5 * dt);
  if (P.jet) for (let i = 0; i < 2; ++i) {
    const d = (k(`thrUp${i + 1}`) ? 1 : 0) - (k(`thrDown${i + 1}`) ? 1 : 0);
    if (d) setLever(i, leverPos(i) + d * 0.5 * dt);
  }
  if (P.turboprop) {
    const d = (k('propUp') ? 1 : 0) - (k('propDown') ? 1 : 0);
    if (d) { input.prop = clamp(input.prop + d * 0.5 * dt, 0, 1); A.setPropLever(input.prop); }
  }
  input.trimRate = k('trimUp') ? 1 : k('trimDown') ? -1 : 0;
  if (trimPulse && performance.now() < trimPulse.until) input.trimRate = trimPulse.rate;
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
// Airport: the world is built around it, so a change reloads the page.
document.querySelectorAll('[data-airport]').forEach((b) => {
  b.setAttribute('aria-pressed', String(+b.dataset.airport === AIRPORT));
  b.addEventListener('click', () => { if (+b.dataset.airport !== AIRPORT) { store.set('airport', +b.dataset.airport); location.reload(); } });
});
// Speed units: the instruments stay in knots; readouts add km/h or mph.
ui.units = store.get('units', 'kt');
const UNIT = { kmh: [1.852, 'km/h'], mph: [1.150779, 'mph'] };
function setUnits(u) {
  ui.units = UNIT[u] ? u : 'kt'; store.set('units', ui.units);
  document.querySelectorAll('[data-units]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.units === ui.units)));
}
document.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => { setUnits(b.dataset.units); b.blur(); }));
function setCity(on) {
  showCity = on; store.set('city', on);
  if (!on) city.clearPhysics();
  city.group.visible = on && ui.flow !== 2;
  $('bCity').setAttribute('aria-pressed', String(on));
  $('bCity').textContent = on ? 'Buildings on' : 'Buildings off';
}
$('bCity').addEventListener('click', (e) => { setCity(!showCity); e.currentTarget.blur(); });
setCity(showCity);
// Graphics (Options): a quality preset sets the render distances, the
// shadows and the resolution cap; each stays adjustable after. Kept across reloads.
// Building detail: every building within it (m, more with height); skyline: the
// tall buildings within it (m, -1 all); view: the fog and the ground's reach;
// shadows 0 off, 1 near the aircraft, 2 everywhere; res: the pixel ratio cap.
const VIEWS = [{ name: 'near', fog: 0.6 }, { name: 'normal', fog: 1 }, { name: 'far', fog: 1.5 }];
const PRESETS = [
  { name: 'Low', detail: 1250, skyline: 10000, view: 0, shadows: 0, res: 1 },
  { name: 'Medium', detail: 2000, skyline: 20000, view: 1, shadows: 1, res: 1.5 },
  { name: 'High', detail: 3500, skyline: -1, view: 1, shadows: 1, res: 2 },
  { name: 'Ultra', detail: 6000, skyline: -1, view: 2, shadows: 2, res: 2 },
];
const gfx = { ...PRESETS[MOBILE ? 0 : 1] };
{
  const g = store.get('gfx', null);
  if (g && typeof g === 'object') for (const k of ['detail', 'skyline', 'view', 'shadows', 'res']) if (Number.isFinite(g[k])) gfx[k] = g[k];
  gfx.detail = clamp(gfx.detail, 1000, 8000); gfx.view = clamp(Math.round(gfx.view), 0, 2); gfx.shadows = clamp(Math.round(gfx.shadows), 0, 2); gfx.res = clamp(gfx.res, 0.5, 3);
}
const RES_MIN = RES.min;
function applyGfx(save = true) {
  city.setOptions({ detail: gfx.detail, skyline: gfx.skyline < 0 ? Infinity : gfx.skyline, shadows: gfx.shadows });
  ground.setOptions({ shadows: gfx.shadows });
  sun.castShadow = gfx.shadows > 0;
  RES.max = Math.min(devicePixelRatio, gfx.res); RES.min = Math.min(RES_MIN, RES.max);
  if (RES.cur > RES.max) { RES.cur = RES.max; renderer.setPixelRatio(RES.cur); if (save) resize(); }  // at start-up the first resize follows
  $('gDetail').value = String(gfx.detail);
  $('gDetailV').textContent = `${(gfx.detail / 1000).toFixed(gfx.detail % 1000 ? 2 : 0).replace(/0$/, '')} km`;
  $('gSkyline').value = String(gfx.skyline);
  $('gView').value = String(gfx.view);
  $('gShadows').value = String(gfx.shadows);
  $('gRes').value = String(gfx.res);
  document.querySelectorAll('[data-quality]').forEach((b) => {
    const p = PRESETS[+b.dataset.quality];
    b.setAttribute('aria-pressed', String(['detail', 'skyline', 'view', 'shadows', 'res'].every((k) => p[k] === gfx[k])));
  });
  if (save) store.set('gfx', gfx);
}
document.querySelectorAll('[data-quality]').forEach((b) => b.addEventListener('click', () => {
  const p = PRESETS[+b.dataset.quality];
  for (const k of ['detail', 'skyline', 'view', 'shadows', 'res']) gfx[k] = p[k];
  applyGfx(); b.blur();
}));
$('gDetail').addEventListener('input', (e) => { gfx.detail = +e.target.value; applyGfx(); });
$('gDetail').addEventListener('change', (e) => e.target.blur());
for (const [id, k] of [['gSkyline', 'skyline'], ['gView', 'view'], ['gShadows', 'shadows'], ['gRes', 'res']]) {
  $(id).addEventListener('change', (e) => { gfx[k] = +e.target.value; applyGfx(); e.target.blur(); });
}
applyGfx(false);
// What it costs, shown under the settings while the Options menu is open.
const cost = { t: 0, n: 0 };
function showCost(dt) {
  cost.t += dt; cost.n++;
  if (cost.t < 0.5) return;
  const fps = cost.n / cost.t; cost.t = 0; cost.n = 0;
  if ($('side').hidden || menu !== 'options') return;
  const st = city.stats, ri = renderer.info.render, M = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : `${Math.round(v / 1000)} k`);
  $('gCost').textContent = `${Math.round(fps)} fps · ${M(ri.triangles)} triangles in ${ri.calls} draw calls · buildings: ${st.tiles} km² in detail, `
    + `${st.buildings.toLocaleString('en')} buildings, ${M(st.triangles)} triangles (skyline ${M(st.tallTriangles)}) · ground: ${ground.stats.chunks} chunks, ${M(ground.stats.triangles)} triangles`;
}
setUnits(ui.units);
// A speed in knots, with the chosen extra unit.
const spd = (kt) => (UNIT[ui.units] ? `${fmt(kt)} kt · ${fmt(kt * UNIT[ui.units][0])} ${UNIT[ui.units][1]}` : `${fmt(kt)} kt`);
const iasHtml = () => {
  const kt = Math.max(0, c[K.ias]);
  return UNIT[ui.units] ? `${fmt(kt)}<small>KIAS · ${fmt(kt * UNIT[ui.units][0])} ${UNIT[ui.units][1].toUpperCase()}</small>` : `${fmt(kt)}<small>KIAS</small>`;
};

// Auto-trim (the core's straight-and-level hold), on top of any assist mode.
ui.level = store.get('level', false);
function setLevel(on, announce) {
  ui.level = on; store.set('level', on); A.avd_set_level_hold(on ? 1 : 0);
  $('bLevel').setAttribute('aria-pressed', String(on));
  if (announce) toast(on ? 'Auto-trim on: let go of the stick and it holds straight and level.' : 'Auto-trim off.', 2.5);
}
$('bLevel').addEventListener('click', (e) => { setLevel(!ui.level, true); e.currentTarget.blur(); });

// Autoland: the flight core's instrument approach pilot down the GPS route to
// the destination (the runway in use if none is picked), to a stop.
const AL_PHASES = ['INTERCEPT', 'FINAL', 'FLARE', 'ROLLOUT', 'STOPPED'];
let autoland = false, alStatus = { phase: 0 };
// The autoland or the autothrottle letting go: the throttle stays where the
// core left it (avd_state[24]), every lever together, and the pilot has it from there.
function handBackThrottle() { input.throttle = clamp(A.state()[24], 0, 1); input.levers = null; }
function setAutoland(on, why) {
  if (on && !A.autoland) { toast('This flight core has no autoland.'); return; }
  if (on) {
    if (!DEST) {
      const ap = A.airport(), ri = regionIndex(ap.icao);
      if (ri >= 0) setDestination(ri, Math.max(0, DESTS[ri].ends.findIndex((e) => e.runway === ap.runway)), false);
    }
    const r = A.autoland(true);
    if (r === -2) { toast('Autoland works in the air: take off first.', 3); return; }
    if (r !== 1) { toast('Autoland: no approach to fly here (pick a destination).', 3.5); return; }
    autoland = true; alStatus = A.autolandStatus();
    if (ap.on) { ap.on = false; apUi(); }  // the autoland takes over from it
    const rt = A.route();
    toast(`Autoland: ${DEST ? `${DEST.icao} ${DEST.runway}` : ''}, ${rt.wp.slice(A.gps()[1]).map((w) => w.ident).join(' → ')}; ${Math.round(alStatus.kias)} kt on the approach. Move the stick, or U, to take over.`, 6);
  } else {
    if (autoland) toast(why || 'Autoland off: you have the controls.', 2.5);
    A.autoland(false);
    if (autoland) handBackThrottle();
    autoland = false;
  }
  $('bAutoland').setAttribute('aria-pressed', String(autoland));
}
$('bAutoland').addEventListener('click', (e) => { setAutoland(!autoland); e.currentTarget.blur(); });

// ---------- Autopilot ----------
// The flight core's autopilot (avd_autopilot), flown from the instruments:
// HDG on the heading bug or NAV on the GPS route; ALT, or VS to the selected
// altitude (captured, then held); SPD, the autothrottle. Y engages it on the
// present heading, altitude and speed; the stick (or Y) gives the controls back.
// APR (lateral 4): the approach (A.autopilotApproach: the ILS on NAV 1 or the
// GPS approach, to a decision altitude), armed on HDG (the ILS intercept on
// the heading bug) or the GPS route, the localizer (final course) captured,
// then the glideslope (glidepath), flown to the DA, where the AP lets go
// (MINIMUMS) and the autothrottle, if on, stays in SPD for the pilot to take.
const AP_LAT = ['', 'ROL', 'HDG', 'NAV', 'APR'], AP_VERT = ['', 'PIT', 'ALT', 'VS', 'ALT*', 'GS'];
const ap = { on: false, lat: 2, vert: 2, at: false, alt: 0, vs: 0, ias: 0, src: store.get('aprSrc', 'ils') === 'gps' ? 'gps' : 'ils', da: 0 };
let apStatus = { on: false, lateral: 0, vertical: 0 };
function apUi() {
  $('apOn').setAttribute('aria-pressed', String(ap.on));
  $('apHdg').setAttribute('aria-pressed', String(ap.on && ap.lat === 2));
  $('apNav').setAttribute('aria-pressed', String(ap.on && ap.lat === 3));
  $('apAlt').setAttribute('aria-pressed', String(ap.on && ap.vert === 2));
  $('apVs').setAttribute('aria-pressed', String(ap.on && ap.vert === 3));
  $('apSpd').setAttribute('aria-pressed', String(ap.on && ap.at));
  $('apApr').setAttribute('aria-pressed', String(ap.on && ap.lat === 4));
  $('apSrc').textContent = ap.src === 'gps' ? 'GPS' : 'ILS';
  $('apDaV').textContent = `${fmt(ap.da || defaultDa())} ft${ap.da ? '' : ' (auto)'}`;
  $('apAltV').textContent = ap.on || ap.alt ? `${fmt(ap.alt)} ft` : '—';
  $('apVsV').textContent = ap.on || ap.vs ? `${ap.vs > 0 ? '+' : ''}${fmt(ap.vs)} fpm` : '—';
  $('apIasV').textContent = ap.on || ap.ias ? `${fmt(ap.ias)} kt` : '—';
}
// Hand the modes and selections to the core; false if it would not engage.
function apApply() {
  const hadThrottle = ap.on && ap.at;
  const r = A.autopilot({ lateral: ap.lat, vertical: ap.vert, autothrottle: ap.at, altFt: ap.alt, vsFpm: ap.vs, iasKt: ap.ias });
  if (r === -3) { toast('NAV needs a route: pick a destination (Flight menu). HDG kept.', 3); ap.lat = 2; return apApply(); }
  if (r === -4) {
    toast(ap.src === 'ils' ? 'APR: no ILS on NAV 1 (pick a destination with an ILS, or switch the source to GPS). HDG kept.' : 'APR: no GPS approach (pick a destination in the Flight menu). HDG kept.', 4);
    ap.lat = 2; return apApply();
  }
  if (r === -2) { toast('The autopilot engages in the air.', 2.5); ap.on = false; if (hadThrottle) handBackThrottle(); apUi(); return false; }
  ap.on = r === 1;
  if (ap.on && autoland) { autoland = false; $('bAutoland').setAttribute('aria-pressed', 'false'); }
  if (hadThrottle && !(ap.on && ap.at)) handBackThrottle();  // SPD off: the autothrottle lets go
  apStatus = A.autopilotStatus();
  apUi();
  return ap.on;
}
function setAutopilot(on, why) {
  if (on && !A.autopilot) { toast('This flight core has no autopilot.'); return; }
  if (on) {
    if (autoland) setAutoland(false);
    // The present heading on the bug, the present altitude and speed selected.
    A.avd_heading_bug(Math.round(((c[K.dg] % 360) + 360) % 360));
    Object.assign(ap, { lat: 2, vert: 2, at: P.jet, alt: Math.round(c[K.alt] / 100) * 100, vs: 0, ias: Math.round(c[K.ias]) });
    if (apApply()) toast(`Autopilot: HDG ${String(Math.round(((c[K.dg] % 360) + 360) % 360)).padStart(3, '0')} · ALT ${fmt(ap.alt)} ft${ap.at ? ` · SPD ${ap.ias} kt` : ''}. The stick or Y gives you the controls.`, 4);
  } else {
    if (ap.on) toast(why || 'Autopilot off: you have the controls.', 2.5);
    if (A.autopilot) A.autopilot({});
    if (ap.on && ap.at) handBackThrottle();
    ap.on = false;
    apUi();
  }
}
// A new selected altitude (or rate) while engaged starts the climb or descent to it.
function apSelect(what, step) {
  if (what === 'alt') {
    ap.alt = Math.max(0, Math.round(((ap.alt || Math.round(c[K.alt] / 100) * 100) + step) / 100) * 100);
    if (ap.on && ap.vert !== 1) {
      const up = ap.alt > c[K.alt];
      if (Math.abs(ap.alt - c[K.alt]) > 50) { ap.vert = 3; ap.vs = (up ? 1 : -1) * Math.max(Math.abs(ap.vs) || 0, P.jet ? 1500 : 500); }
    }
  } else if (what === 'vs') {
    ap.vs = Math.round((ap.vs + step) / 100) * 100;
    if (ap.on && ap.vs !== 0) ap.vert = 3;
  } else if (what === 'ias') {
    ap.ias = Math.max(40, (ap.ias || Math.round(c[K.ias])) + step);
    if (ap.on) ap.at = true;
  }
  if (ap.on) apApply(); else apUi();
}
$('apOn').addEventListener('click', (e) => { setAutopilot(!ap.on); e.currentTarget.blur(); });
const apMode = (fn) => (e) => { e.currentTarget.blur(); if (!ap.on) { setAutopilot(true); if (!ap.on) return; } fn(); apApply(); };
$('apHdg').addEventListener('click', apMode(() => { ap.lat = 2; }));
$('apNav').addEventListener('click', apMode(() => { ap.lat = ap.lat === 3 ? 2 : 3; }));
$('apAlt').addEventListener('click', apMode(() => { ap.vert = 2; ap.alt = Math.round(c[K.alt] / 100) * 100; }));
$('apVs').addEventListener('click', apMode(() => { ap.vert = 3; if (!ap.vs) ap.vs = Math.round(c[K.vsi] / 100) * 100 || (ap.alt >= c[K.alt] ? 500 : -500); }));
$('apSpd').addEventListener('click', apMode(() => { ap.at = !ap.at; if (ap.at) ap.ias = Math.round(c[K.ias]); }));
// APR: the decision altitude (ft on the altimeter; 0: the core's threshold + 200 ft) and the source.
const defaultDa = () => Math.round(((DEST ? REGION[DEST.ai]?.elevation ?? ELEV : ELEV) / 0.3048 + 200) / 10) * 10;
function aprSetup() { return A.autopilotApproach ? A.autopilotApproach({ source: ap.src, daFt: ap.da }) : -1; }
function toggleApr() {
  if (!A.autopilotApproach) { toast('This flight core has no approach mode.', 3); return; }
  if (ap.on && ap.lat === 4) { ap.lat = 2; apApply(); toast('APR off: HDG.', 2); return; }
  if (!ap.on) { setAutopilot(true); if (!ap.on) return; }
  aprSetup();
  ap.lat = 4;
  if (ap.vert !== 2 && ap.vert !== 3) ap.vert = 2;
  if (apApply()) toast(`APR armed: ${ap.src === 'ils' ? 'fly the heading bug to intercept the localizer' : 'the GPS route to the final course'}, the ${ap.src === 'ils' ? 'glideslope' : 'glidepath'} captured from level or below; DA ${fmt(ap.da || defaultDa())} ft.`, 5);
}
$('apApr').addEventListener('click', (e) => { toggleApr(); e.currentTarget.blur(); });
$('apSrc').addEventListener('click', (e) => {
  ap.src = ap.src === 'ils' ? 'gps' : 'ils'; store.set('aprSrc', ap.src);
  toast(`Approach source: ${ap.src === 'ils' ? 'the ILS on NAV 1' : 'the GPS approach (LNAV / LPV)'}.`, 2.5);
  if (ap.on && ap.lat === 4) { aprSetup(); ap.lat = 4; apApply(); }  // re-armed on it (or refused, HDG kept)
  apUi(); e.currentTarget.blur();
});
document.querySelectorAll('[data-dastep]').forEach((b) => b.addEventListener('click', (e) => {
  ap.da = Math.max(0, Math.round(((ap.da || defaultDa()) + +b.dataset.dastep) / 10) * 10);
  if (ap.on && ap.lat === 4 && (apStatus.apr || 0) <= 1) { aprSetup(); apApply(); }
  apUi(); e.currentTarget.blur();
}));
$('apDaV').addEventListener('dblclick', () => { ap.da = 0; apUi(); });
// The flight mode annunciation shared by the HUD, the jets' PFD and the G1000:
// active modes (green) and armed ones (white); APR's at MINIMUMS.
let minimumsUntil = 0;
function fmaModes() {
  const st = apStatus, gps = st.aprSource === 'gps', apr = st.lateral === 4;
  const bug = String(Math.round(st.bugDeg) % 360).padStart(3, '0');
  const m = { lat: '', latArmed: '', vert: '', vertArmed: '', at: st.autothrottle ? `SPD ${fmt(st.iasKt)}` : '', minimums: performance.now() < minimumsUntil, apr: st.apr || 0 };
  if (apr) {
    if ((st.apr || 0) <= 1) { m.lat = gps ? 'GPS' : `HDG ${bug}`; m.latArmed = gps ? 'LNAV' : 'LOC'; }
    else m.lat = gps ? 'LNAV' : 'LOC';
  } else m.lat = st.lateral ? AP_LAT[st.lateral] + (st.lateral === 2 ? ` ${bug}` : '') : '';
  if (st.vertical === 5 || st.apr === 3) m.vert = gps ? 'LPV' : 'GS';
  else {
    m.vert = st.vertical === 3 ? `VS ${st.vsFpm > 0 ? '+' : ''}${fmt(st.vsFpm)}` : st.vertical === 4 ? `ALT* ${fmt(st.altFt)}` : st.vertical === 2 ? `ALT ${fmt(st.altFt)}` : AP_VERT[st.vertical] || '';
    if (apr && st.apr === 2) m.vertArmed = gps ? 'LPV' : 'GS';
    else if (st.vertical === 3) m.vertArmed = `ALT ${fmt(st.altFt)}`;
  }
  return m;
}
// MINIMUMS: the AP let go at the DA. A tone, a flashing annunciation, and the autothrottle's word.
function alertTone() {
  const ctx = audio.ctx;
  if (!ui.sound || !ctx) return;
  const t = ctx.currentTime, g = ctx.createGain(); g.gain.value = 0; g.connect(ctx.destination);
  const o = ctx.createOscillator(); o.type = 'square'; o.connect(g);
  for (let k = 0; k < 4; ++k) {
    o.frequency.setValueAtTime(k % 2 ? 880 : 1175, t + k * 0.22);
    g.gain.setValueAtTime(0.12 * ui.vol / 100, t + k * 0.22); g.gain.setValueAtTime(0, t + k * 0.22 + 0.17);
  }
  o.start(t); o.stop(t + 0.95);
}
function onMinimums(st) {
  minimumsUntil = performance.now() + 9000;
  alertTone();
  toast(st.autothrottle ? 'MINIMUMS — AP DISCONNECT: you have the airplane. SPD is still on: disconnect the autothrottle (SPD, or Y) for the flare.' : 'MINIMUMS — AP DISCONNECT: you have the airplane.', 7);
  ap.lat = 0; ap.vert = 0;
}
document.querySelectorAll('[data-apsel]').forEach((b) => b.addEventListener('click', (e) => { apSelect(b.dataset.apsel, +b.dataset.step); e.currentTarget.blur(); }));
function apText() {
  const st = apStatus;
  if (st.lateral === 4 || st.apr >= 2) {
    const f = fmaModes();
    return ['AP', f.lat + (f.latArmed ? ` | ${f.latArmed} armed` : ''), f.vert + (f.vertArmed ? ` | ${f.vertArmed} armed` : ''), f.at].filter(Boolean).join(' · ');
  }
  const lat = AP_LAT[st.lateral] + (st.lateral === 2 ? ` ${String(Math.round(st.bugDeg) % 360).padStart(3, '0')}` : '');
  const vert = st.vertical === 3 ? `VS ${st.vsFpm > 0 ? '+' : ''}${fmt(st.vsFpm)} → ${fmt(st.altFt)}` : st.vertical === 4 ? `ALT* ${fmt(st.altFt)}` : st.vertical === 2 ? `ALT ${fmt(st.altFt)}` : AP_VERT[st.vertical];
  return ['AP', lat, vert, st.autothrottle ? `SPD ${fmt(st.iasKt)}` : ''].filter(Boolean).join(' · ');
}
// Status after the assist mode: auto-trim state, and Q/E on the tiller.
function assistStatus() {
  if (autoland) return `AUTOLAND · ${AL_PHASES[alStatus.phase] || ''}`;
  if (performance.now() < minimumsUntil) return `<span class="mins">MINIMUMS — AP DISCONNECT</span>${ap.on && ap.at ? ` · SPD ${fmt(apStatus.iasKt)} (A/T ON)` : ''}`;
  if (ap.on) {
    // Active modes green, armed white.
    const f = fmaModes(), g = (t) => (t ? `<span class="fa">${t}</span>` : ''), w = (t) => (t ? ` <span class="fw">${t}</span>` : '');
    return ['AP', g(f.lat) + w(f.latArmed), g(f.vert) + w(f.vertArmed), f.at].filter(Boolean).join(' · ');
  }
  const lvl = !ui.level ? '' : s[58] ? ' · TOO SLOW' : s[55] ? ' · HOLDING LEVEL' : ' · AUTO-TRIM';
  return ASSIST[ui.assist] + lvl + (s[56] ? ' · TILLER' : '');
}

document.querySelectorAll('[data-fail]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.fail, on = !failed[k];
  failed[k] = on; b.setAttribute('aria-pressed', String(on));
  if (k === 'fuel') setControl(P.turboprop ? 'engine1.condition' : P.jet ? 'engine1.fuel' : 'fuel.shutoff', on ? 0 : 1);
  else A.avd_failure(+k, on ? 1 : 0);
  toast(`${b.textContent}: ${on ? (k === 'fuel' ? 'closed' : 'failed') : 'restored'}.`);
  b.blur();
}));

// The King Air's propellers: feather (the propeller lever's detent) and the autofeather switch.
document.querySelectorAll('[data-feather]').forEach((b) => b.addEventListener('click', () => {
  const i = +b.dataset.feather, on = b.getAttribute('aria-pressed') !== 'true';
  setFeather(i, on);
  toast(`Propeller ${i + 1}: ${on ? 'feathered (the blades edge-on: no windmilling drag)' : 'out of feather, back on the governor'}.`, 3);
  b.blur();
}));
$('bAutofeather').addEventListener('click', (e) => {
  setControl('propeller.autofeather', controlPos('propeller.autofeather') ? 0 : 1);
  const on = !!controlPos('propeller.autofeather');
  e.currentTarget.setAttribute('aria-pressed', String(on));
  toast(on ? 'Autofeather ARM: with both power levers above 85 % and both torques above 24 %, an engine whose torque falls under 12 % feathers.' : 'Autofeather off.', 4);
  e.currentTarget.blur();
});
$('bQuick').addEventListener('click', (e) => {
  if (STARTS[ui.start].trim || s[30]) restart(1);
  A.avd_quick_start(); toast(P.jet ? 'Quick Start: battery and generators on, starting engine 1, then engine 2…' : 'Quick Start: working through the checklist…'); e.currentTarget.blur();
});

const audios = { piston: new FlightAudio(), jet: new JetAudio(), tp: new TurbopropAudio() };
const audioFor = (p) => (p.turboprop ? audios.tp : p.jet ? audios.jet : audios.piston);
let audio = audioFor(P);
for (const a of Object.values(audios)) a.setVolume(ui.vol / 100);
$('vol').value = ui.vol;
$('vol').addEventListener('input', (e) => { ui.vol = +e.target.value; for (const a of Object.values(audios)) a.setVolume(ui.vol / 100); store.set('vol', ui.vol); });
function toggleSound() {
  ui.sound = !ui.sound;
  if (ui.sound) audio.start(); else { audio.stop(); speech?.cancel(); }
  const b = $('bSound'); b.setAttribute('aria-pressed', String(ui.sound)); b.textContent = ui.sound ? 'Sound on' : 'Sound off';
}
$('bSound').addEventListener('click', (e) => { toggleSound(); e.currentTarget.blur(); });

const CAMS = ['Chase', 'Cockpit', 'Orbit', 'Tower'];
function cycleCam() { ui.cam = (ui.cam + 1) % CAMS.length; store.set('cam', ui.cam); snapCamera = true; look.yaw = look.pitch = 0; $('bCam').textContent = CAMS[ui.cam]; toast(`Camera: ${CAMS[ui.cam]}`, 1.5); requestAnimationFrame(sizePanel); }
$('bCam').textContent = CAMS[ui.cam];
$('bCam').addEventListener('click', (e) => { cycleCam(); e.currentTarget.blur(); });
// The 172's panel: the analog six-pack (the default) or the G1000 glass
// cockpit (g1000.js), as the 172S NAV III has. The jets keep their own deck.
ui.glass = store.get('panel172', 'analog') === 'g1000';
// The G1000 172 flies on an AHRS and magnetometer (no vacuum-gyro errors, no
// tumble); the analog panel on its vacuum gyros (the aircraft's data). A new
// aircraft load starts on its data: applyProfileUi applies it again.
function applyAttitudeRef() { if (!P.jet && A.setAttitudeReference) A.setAttitudeReference(ui.glass ? 'ahrs' : 'data'); }
function setGlass(on, announce) {
  ui.glass = !!on; store.set('panel172', ui.glass ? 'g1000' : 'analog');
  applyAttitudeRef();
  document.querySelectorAll('[data-panel172]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.panel172 === 'g1000') === ui.glass)));
  document.body.classList.toggle('g1000', ui.glass && !P.jet);
  applyInstrSize();
  if (announce) toast(P.jet ? `172 panel: ${ui.glass ? 'G1000' : 'analog'} (the jets keep their glass deck).` : !ui.glass ? '172 panel: analog six-pack.'
    : MOBILE ? 'G1000: tap the softkeys (CDI, XPDR, STD BARO, TMR/REF; on the MFD, DCLTR and the range).'
    : 'G1000: scroll the HDG, CRS, baro and ALT boxes or the map to turn their knobs; the softkeys click. J: back to the six-pack.', ui.glass ? 5 : 2);
}
document.querySelectorAll('[data-panel172]').forEach((b) => b.addEventListener('click', (e) => { setGlass(b.dataset.panel172 === 'g1000', true); e.currentTarget.blur(); }));
function toggleInstr() { ui.instr = !ui.instr; store.set('instr', ui.instr); $('instr').hidden = !ui.instr; $('bInstr').setAttribute('aria-pressed', String(ui.instr)); sizePanel(); }
$('instr').hidden = !ui.instr; $('bInstr').setAttribute('aria-pressed', String(ui.instr));
$('bInstr').addEventListener('click', (e) => { toggleInstr(); e.currentTarget.blur(); });
$('bReset').addEventListener('click', (e) => { restart(); e.currentTarget.blur(); });
// ---------- Menus: Flight, Load, Weather, Controls, Options (one open at a time) ----------
const MENUS = ['flight', 'load', 'weather', 'controls', 'options'];
let menu = MENUS.includes(store.get('menu', 'flight')) ? store.get('menu', 'flight') : 'flight';
function showMenu(name, open = true) {
  const side = $('side');
  if (MENUS.includes(name)) { menu = name; store.set('menu', name); }
  side.hidden = !open;
  document.querySelectorAll('#side .menu').forEach((m) => { m.hidden = m.dataset.menu !== menu; });
  document.querySelectorAll('#side [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === menu)));
  document.querySelectorAll('.top [data-open]').forEach((b) => b.setAttribute('aria-expanded', String(open && b.dataset.open === menu)));
  $('bPanel').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('side-open', open);
  if (open) side.scrollTop = 0;
  requestAnimationFrame(applyInstrSize);  // the room beside the menu changed
}
// H (and the Menu button) opens the last menu or closes it; a top-bar menu
// button opens its menu, or closes it when it is the one showing.
function togglePanel(force) { showMenu(menu, force ?? $('side').hidden); }
document.querySelectorAll('.top [data-open]').forEach((b) => b.addEventListener('click', (e) => {
  const name = e.currentTarget.dataset.open;
  showMenu(name, $('side').hidden || menu !== name);
  e.currentTarget.blur();
}));
document.querySelectorAll('#side [role="tab"]').forEach((t) => t.addEventListener('click', (e) => { showMenu(e.currentTarget.dataset.tab); e.currentTarget.blur(); }));
$('bPanel').addEventListener('click', (e) => { togglePanel(); e.currentTarget.blur(); });
$('sideClose').addEventListener('click', () => togglePanel(false));
showMenu(menu, !(MOBILE || innerWidth < 900));
// The automatic ground spoilers and thrust reversers, called out as they act.
let revPhaseWas = 0, gndSpWas = 0, reverse = 0, revHint = false;
let betaWas = 0;
function landingRollCallouts() {
  if (P.turboprop) {
    const b = tp && tp.engines.some((e) => e.beta) ? (reverse > 0.42 ? 2 : 1) : 0;
    if (b !== betaWas && b) toast(b === 2 ? 'Reverse: the blades past the reverse stop, Ng rising with the levers (let go of N to come out).' : 'Ground beta: the blades on the power levers, no thrust at idle (Shift+N held; N for reverse).', 3);
    betaWas = b;
    return;
  }
  const ph = j[53] | 0, gs = j[56] | 0;
  if (gs !== gndSpWas) toast(gs ? 'Ground spoilers deployed.' : 'Ground spoilers stowed.', 2);
  if (ph !== revPhaseWas) {
    if (ph === 1) toast('Thrust reversers deploying: reverse thrust.', 2.5);
    else if (ph === 2) toast('60 knots: reverse idle.', 2);
    else if (ph === 3) toast('Thrust reversers stowing.', 2);
    else if (ph === 4) toast('Reverse thrust: the reversers deploy, N1 follows the levers (let go of N to stow).', 3);
  }
  revPhaseWas = ph; gndSpWas = gs;
}
// Why the reverse levers do nothing on the ground (null: they do): the core
// deploys a reverser with its engine running, every thrust lever at idle
// (0.08 at most) and the main wheels on the ground.
// A turboprop's: the blades go to beta (tp's beta flag) with an engine running,
// its power lever under 5 % and the main wheels on the ground.
function reverseBlocked() {
  const lever = input.levers ? Math.max(...input.levers) : input.throttle;
  if (P.turboprop) {
    if (!tp || tp.engines.some((e) => e.beta)) return null;
    const idle = 0.05, what = 'power levers';
    if (!tp.engines.some((e) => e.running)) return 'the engines are not running';
    if (input.levers && lever >= idle) return `the ${what} are split; close both (Z rejoins them and pulls them back)`;
    if (lever >= idle) return `close the ${what} to idle first (Z): ${Math.round(lever * 100)} %, the gate is under 5 %`;
    return 'the main wheels must be on the runway (in the air the flight-idle gate holds)';
  }
  if (j[53] === 4 || j[55] === 4) return null;
  if (!j[13] && !j[21]) return 'the engines are not running';
  if (input.levers && lever > 0.08) return 'the thrust levers are split; close both (Z rejoins them and pulls them back)';
  if (lever > 0.08) return `close the throttles first (Z): ${Math.round(lever * 100)} %, idle is under 8 %`;
  return 'the main wheels must be on the runway';
}
function setSlow(i) {
  ui.slow = clamp(i, 0, SLOWS.length - 1);
  const S = SLOWS[ui.slow];
  const txt = S === 1 ? 'real time' : `1/${S}× · 1 s on screen = ${S >= 1000 ? `${(1000 / S).toFixed(1)} ms` : `${(1000 / S).toFixed(0)} ms`} of flight`;
  $('slowR').value = ui.slow;
  $('slowO').textContent = S === 1 ? 'real time' : `1/${S}×`;
  toast(S === 1 ? 'Real time' : `Slow motion ${txt}`, 2);
}
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


// ---------- Cockpit: point, click, drag and scroll ----------
// In the cockpit view the switches, knobs and levers answer the mouse:
// hover shows what a control is and how it is set; click (right-click the
// other way) switches or steps it, dragging moves a lever, the wheel turns
// a knob. Anywhere else, dragging looks around (double-click looks ahead).
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), mouse = { x: 0, y: 0, in: false };
const hiBox = new THREE.Box3Helper(new THREE.Box3(), 0x50c8ff);
hiBox.visible = false; scene.add(hiBox);
let hot = null, act = null, spots = null, spotsFor = null;
const named = (id) => { const c = A.cockpit().find((x) => x.id === id); return c ? `${c.label}: ${c.positions[c.position]}` : id; };
const toggle = (id) => setControl(id, controlPos(id) ? 0 : 1);
const pct = (v) => `${Math.round(v * 100)} %`;
const lever = (get, set, label, step = 0.02) => ({
  label: () => `${label}: ${pct(get())} (drag or scroll)`, cursor: 'ns-resize',
  down() { act.v0 = get(); }, drag: (dy) => set(clamp(act.v0 + dy / 220, 0, 1)), wheel: (n) => set(clamp(get() + n * step, 0, 1)),
});
const stepper = (id, label) => ({
  label: () => `${named(id)} · click: next, right-click: back${label ? ` · ${label}` : ''}`,
  down: (dir) => setControl(id, controlPos(id) + dir), wheel: (n) => setControl(id, controlPos(id) + n),
});
const switcher = (id) => ({ label: () => `${named(id)} · click to switch`, down: () => toggle(id) });
function buildSpots() {
  const p = cabin.parts || {}, list = [];
  const mesh = (obj, spec) => obj && list.push({ obj, ...spec });
  if (P.jet) {
    (p.throttles || []).forEach((t, i) => mesh(t, lever(() => leverPos(i), (v) => setLever(i, v), `${P.turboprop ? 'Power' : 'Thrust'} lever ${i + 1} (alone: X / Z rejoin them)`)));
    // The King Air's propeller levers (both together, as the core has them; right-click: this one's feather detent) and condition levers.
    (p.props || []).forEach((t, i) => mesh(t, {
      label: () => `Propeller levers: ${fmt(tp?.npSelected)} rpm (drag or scroll, both; ⇧, ⇧.)${tp?.engines[i]?.feather ? ` · propeller ${i + 1} FEATHERED` : ''} · right-click: feather ${i + 1}`,
      cursor: 'ns-resize',
      down(dir) { if (dir < 0) setFeather(i, !tp?.engines[i]?.feather); else act.v0 = input.prop; },
      drag: (dy) => { if (act.v0 === undefined) return; input.prop = clamp(act.v0 + dy / 220, 0, 1); A.setPropLever(input.prop); },
      wheel: (n) => { input.prop = clamp(input.prop + n * 0.02, 0, 1); A.setPropLever(input.prop); },
    }));
    for (const w of p.conditions || []) mesh(w.g, stepper(w.id, '⇧1 ⇧2 ⇧3 all'));
    mesh(p.spd, stepper('speedbrake.lever'));
    mesh(p.flap, stepper('flaps.lever'));
    mesh(p.gear, { label: () => `${named('gear.lever')} · click to move the handle`, down: () => toggleGear() });
    for (const w of p.switches || []) mesh(w.g, switcher(w.id));
    for (const w of p.fuelSw || []) mesh(w.g, P.turboprop ? stepper(w.id.replace('.fuel', '.condition'), '⇧1 ⇧2 ⇧3 all') : switcher(w.id));
    mesh(p.park, switcher('brakes.parking'));
    mesh(p.hdgKnob, { label: () => `Heading bug ${String(Math.round(c[K.bug])).padStart(3, '0')}° · scroll to turn, click to sync to the heading`,
      wheel: (n) => A.avd_heading_bug((Math.round(c[K.bug]) + n + 360) % 360), down: () => A.avd_heading_bug(Math.round(s[9]) % 360) });
    mesh(p.baroKnob, { label: () => `Altimeter ${c[K.kollsman].toFixed(2)} inHg · scroll to set`, wheel: (n) => A.avd_altimeter_adjust(n) });
  } else {
    mesh(p.throttle, lever(() => input.throttle, (v) => setThrottle(v), 'Throttle'));
    mesh(p.mixture, lever(() => input.mixture, (v) => { input.mixture = v; }, 'Mixture'));
    mesh(p.flap, stepper('flaps.lever', 'scroll too'));
    mesh(p.trimWheel, { label: () => `Elevator trim ${Math.round(s[27] * 100)} % · scroll or drag (up: nose down)`, cursor: 'ns-resize',
      down() { act.y0 = mouse.y; }, drag: (dy) => { trimPulse = { rate: clamp(-dy / 40, -1, 1), until: performance.now() + 120 }; },
      wheel: (n) => { trimPulse = { rate: -Math.sign(n), until: performance.now() + 140 }; } });
    mesh(p.fuelSel, stepper('fuel.selector'));
    mesh(p.shutoff, switcher('fuel.shutoff'));
    mesh(p.park, switcher('brakes.parking'));
    if (p.face) list.push({ obj: p.face, panel: true });
  }
  return list;
}
// What a panel-face spot does (the 172's panel: PANEL_SPOTS in panel.js).
function panelSpot(sp) {
  switch (sp.kind) {
    case 'toggle': return { label: () => `${sp.label} · ${named(sp.id).split(': ').pop()} · click to switch`, down: () => toggle(sp.id) };
    case 'mags': return {
      label: () => `${named(sp.id)} · click: next, right-click: back; at BOTH, click and hold to START`,
      down(dir) {
        const pos = controlPos(sp.id);
        if (dir > 0 && pos === 3) { input.starter = 1; act.starting = true; } else setControl(sp.id, pos + dir);
      },
      up() { if (act.starting) input.starter = 0; },
    };
    case 'cage': return { label: () => sp.label, down: () => { A.avd_ai_cage(); toast('Attitude indicator caged.', 1.5); } };
    // The G1000's bezel knobs and softkeys (g1000.js G1000_SPOTS).
    case 'hdgSync': return { label: () => `${sp.label}: heading bug ${String(Math.round(c[K.bug])).padStart(3, '0')}° · scroll to turn, click to sync it to the heading`,
      wheel: (n) => A.avd_heading_bug((Math.round(c[K.bug]) + n + 360) % 360), down: () => A.avd_heading_bug(Math.round(((c[K.dg] % 360) + 360) % 360)) };
    case 'altSel': return { label: () => `${sp.label}: selected altitude ${ap.alt ? `${fmt(ap.alt)} ft` : '—'} · scroll (100 ft)`, wheel: (n) => apSelect('alt', n * 100) };
    case 'range': return { label: () => `${sp.label}: map range · scroll`, wheel: (n) => toast(g1000Range(-n), 1.2) };
    case 'g1key': return { label: () => `${sp.label} · click`, down: () => g1000Act(g1000Key(sp.screen, sp.key)) };
    case 'baro': return { label: () => `Altimeter setting ${c[K.kollsman].toFixed(2)} inHg · scroll to set`, wheel: (n) => A.avd_altimeter_adjust(n) };
    case 'hdg': return { label: () => `Heading bug ${String(Math.round(c[K.bug])).padStart(3, '0')}° · scroll to turn; click: set the indicator to the compass`,
      wheel: (n) => A.avd_heading_bug((Math.round(c[K.bug]) + n + 360) % 360), down: () => { A.avd_dg_sync(); toast('Heading indicator set to the compass.', 1.5); } };
    case 'obs': return { label: () => `Course ${String(Math.round(c[K.obs])).padStart(3, '0')}° · scroll to turn`, wheel: (n) => A.avd_obs_adjust(n) };
    case 'comSwap': case 'navSwap': return { label: () => sp.label, down: () => (sp.kind === 'comSwap' ? A.avd_com_swap() : A.avd_nav_swap()) };
    case 'comTune': return { label: () => `${sp.label} (${c[K.comStb].toFixed(3)})`, wheel: (n) => A.avd_com_tune(n), down: () => A.avd_com_swap() };
    case 'navTune': return { label: () => `${sp.label} (${c[K.navStb].toFixed(2)})`, wheel: (n) => A.avd_nav_tune(n), down: () => A.avd_nav_swap() };
    case 'xpdr': return {
      label: () => `Transponder ${String(c[K.squawk] | 0).padStart(4, '0')} ${['OFF', 'SBY', 'ON', 'ALT'][c[K.xpdrMode] | 0]} · click: mode, scroll: code`,
      down: (dir) => A.avd_xpdr_mode((((c[K.xpdrMode] | 0) + dir) % 4 + 4) % 4),
      wheel(n) {
        // Octal digits: step the last digit, carrying into the others.
        let code = parseInt(String(c[K.squawk] | 0).padStart(4, '0'), 8) + n;
        code = ((code % 4096) + 4096) % 4096;
        A.avd_squawk(+code.toString(8).padStart(4, '0'));
      },
    };
    default: return null;
  }
}
// The 172's panel face: the six-pack's places, or the G1000's with the same switch row.
const G1000_PANEL = [...PANEL_SPOTS.filter((q) => q.kind === 'toggle' || q.kind === 'mags'), ...G1000_SPOTS];
const cockpitSpots = () => (ui.glass ? G1000_PANEL : PANEL_SPOTS);
function cockpitHover() {
  if (ui.cam !== 1 || !mouse.in || look.drag) { setHot(null); return; }
  if (spotsFor !== cabin) { spots = buildSpots(); spotsFor = cabin; }
  ndc.set(mouse.x / innerWidth * 2 - 1, -(mouse.y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(spots.map((x) => x.obj), true);
  let found = null;
  if (hits.length && hits[0].distance < 3) {
    let o = hits[0].object;
    while (o && !found) { found = spots.find((x) => x.obj === o) || null; o = o.parent; }
    if (found && found.panel) {
      const uv = hits[0].uv, [pw, ph] = cabin.parts.size, u = uv.x * pw, v = (1 - uv.y) * ph;
      const r = cockpitSpots().find((q) => u >= q.u && u <= q.u + q.w && v >= q.v && v <= q.v + q.h);
      found = r ? { ...panelSpot(r), rect: r, key: r } : null;
    }
  }
  setHot(found);
}
function setHot(h) {
  if (act) return;  // keep the control being operated
  const same = h && hot && (h.key ? h.key === hot.key : h.obj === hot.obj);
  hot = h;
  if (!same) {
    cabin?.setHover?.(h?.rect || null);
    hiBox.visible = !!(h && h.obj && !h.panel);
    if (hiBox.visible) { hiBox.box.setFromObject(h.obj); hiBox.box.expandByScalar(0.006); }
  }
  canvas.style.cursor = h ? h.cursor || 'pointer' : '';
  const tip = $('cockpitTip');
  if (h && h.label) { tip.textContent = h.label(); tip.hidden = false; tip.style.left = `${mouse.x + 16}px`; tip.style.top = `${mouse.y + 14}px`; }
  else tip.hidden = true;
}
canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY; mouse.in = true;
  if (act && act.spot.drag) act.spot.drag(act.y - e.clientY);
}, { capture: true });
canvas.addEventListener('pointerleave', () => { mouse.in = false; });
canvas.addEventListener('pointerdown', (e) => {
  if (ui.cam !== 1 || !hot || e.pointerType === 'touch' && !e.isPrimary) return;
  e.stopImmediatePropagation(); e.preventDefault();
  act = { spot: hot, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  hot.down?.(e.button === 2 ? -1 : 1);
}, { capture: true });
const endAct = () => { if (!act) return; act.spot.up?.(); act = null; };
canvas.addEventListener('pointerup', endAct); canvas.addEventListener('pointercancel', endAct);
canvas.addEventListener('wheel', (e) => {
  if (ui.cam !== 1 || !hot?.wheel) return;
  e.stopImmediatePropagation(); e.preventDefault();
  hot.wheel(e.deltaY < 0 ? 1 : -1);
}, { capture: true, passive: false });
canvas.addEventListener('contextmenu', (e) => { if (ui.cam === 1) e.preventDefault(); });
canvas.addEventListener('dblclick', () => { if (ui.cam === 1 && !hot) { look.yaw = look.pitch = 0; } });

// ---------- Instrument panel ----------
const panelCv = $('panelCv'), pctx = panelCv.getContext('2d');
let panelLayout = 'row', panelT = 0;
function sizePanel() {
  const r = panelCv.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.min(devicePixelRatio, 2);
  panelCv.width = Math.round(r.width * dpr); panelCv.height = Math.round(r.height * dpr);
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  panelLayout = 'row';
  panelT = 1;  // resizing clears the canvas: draw it again on the next frame
}
// The instrument panel's size: drag a grip at its corner (double-click resets).
// Kept per aircraft in this browser; the flow legend sits above it.
// The jets' and the 172's panels, and the 172's G1000, each keep their own size.
const sizeKey = () => 'instrSize.' + P.id + (!P.jet && ui.glass ? '.g1000' : '');
// The width the panel may take: the window's, less the open side menu beside
// it on a desktop (index.html: body.side-open #instr), less the margins.
const SIDE_BESIDE = matchMedia('(min-width:900px) and (pointer:fine)');
const instrRoom = () => innerWidth - (document.body.classList.contains('side-open') && SIDE_BESIDE.matches ? 358 : 24);
function applyInstrSize() {
  const el = $('instr'), z = store.get(sizeKey(), null);
  if (z && z.w > 0 && z.h > 0) {
    el.style.width = `${Math.round(Math.min(z.w, instrRoom()))}px`;
    document.body.style.setProperty('--instr-h', `${Math.round(Math.min(z.h, innerHeight * 0.85))}px`);
  } else { el.style.width = ''; document.body.style.removeProperty('--instr-h'); }
  sizePanel();
}
for (const g of document.querySelectorAll('#instr .grip')) {
  let start = null;
  g.addEventListener('pointerdown', (e) => {
    const r = $('instr').getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, side: g.classList.contains('l') ? -1 : 1, up: getComputedStyle(g).top.startsWith('-') ? 1 : -1 };
    g.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
  });
  g.addEventListener('pointermove', (e) => {
    if (!start) return;
    const w = clamp(start.w + 2 * start.side * (e.clientX - start.x), 300, instrRoom());
    const h = clamp(start.h + start.up * (start.y - e.clientY), 70, innerHeight * 0.85);
    $('instr').style.width = `${Math.round(w)}px`;
    document.body.style.setProperty('--instr-h', `${Math.round(h)}px`);
    sizePanel();
  });
  const end = () => {
    if (!start) return;
    start = null;
    const r = $('instr').getBoundingClientRect();
    store.set(sizeKey(), { w: Math.round(r.width), h: Math.round(r.height) });
  };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
  g.addEventListener('dblclick', () => { store.set(sizeKey(), null); applyInstrSize(); toast('Instrument panel: default size', 1.5); });
}
// The G1000's softkeys answer clicks; the wheel turns the knob of what it is
// over (heading bug, course, barometer, selected altitude, map range).
const glassOn = () => ui.glass && !P.jet;
const panelXY = (e) => { const r = panelCv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
// A softkey's outcome (g1000Key): a message, or a setting of the simulation's.
function g1000Act(r) {
  if (!r) return;
  if (r.msg) toast(r.msg, 2.5);
  if (r.act === 'xpdr') {
    const m = (((c[K.xpdrMode] | 0) % 3) + 1);  // STBY, ON, ALT
    A.avd_xpdr_mode(m); toast(`Transponder ${['OFF', 'STBY', 'ON', 'ALT'][m]}`, 1.5);
  } else if (r.act === 'stdbaro') {
    A.avd_altimeter_adjust(Math.round((29.92 - c[K.kollsman]) * 100)); toast('Altimeter 29.92 inHg (standard)', 1.5);
  }
  panelT = 1;
}
panelCv.addEventListener('click', (e) => { if (glassOn()) g1000Act(g1000Click(...panelXY(e))); });
panelCv.addEventListener('wheel', (e) => {
  if (!glassOn()) return;
  const what = g1000WheelTarget(...panelXY(e));
  if (!what) return;
  e.preventDefault();
  const n = e.deltaY < 0 ? 1 : -1;
  if (what === 'hdg') A.avd_heading_bug((Math.round(c[K.bug]) + n + 360) % 360);
  else if (what === 'crs') A.avd_obs_adjust(n);
  else if (what === 'baro') A.avd_altimeter_adjust(n);
  else if (what === 'alt') apSelect('alt', n * 100);
  else if (what === 'range') g1000Range(-n);
  panelT = 1;
}, { passive: false });
panelCv.addEventListener('pointermove', (e) => {
  const cur = glassOn() ? g1000Cursor(...panelXY(e)) : '';
  panelCv.style.cursor = cur;
  const w = glassOn() && cur === 'ns-resize' ? g1000WheelTarget(...panelXY(e)) : null;
  panelCv.title = w ? `Scroll: ${G1000_WHEEL[w]}` : '';
});
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = w < h ? 75 : 60; camera.updateProjectionMatrix();
  const L = $('labels'), d = Math.min(devicePixelRatio, 2);
  L.width = w * d; L.height = h * d; lctx.setTransform(d, 0, 0, d, 0, 0);
  sizePanel();
}
const lctx = $('labels').getContext('2d');
addEventListener('resize', () => { resize(); applyInstrSize(); });
resize();

// ---------- HUD ----------
const hRead = $('hRead');
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
// Wind (smoothed by the core), ground track and drift, once moving.
const deg3 = (v) => String(Math.round(((v % 360) + 360) % 360) || 360).padStart(3, '0');
function windRows() {
  const rows = [['Wind', s[60] >= 1 ? `${deg3(s[59])}° / ${spd(s[60])}` : 'calm']];
  if (s[12] > 20 && !s[28]) rows.push(['Track · drift', `${deg3(s[61])}° · ${s[62] >= 0 ? 'R' : 'L'} ${fmt(Math.abs(s[62]))}°`]);
  if (s[63] > 0) rows.push(['Runway', s[63] >= 3 ? `standing water ${fmt(s[63])} mm` : 'wet']);
  if (wx?.rain > 0) rows.push(['Rain', `${fmt(wx.rain, wx.rain < 10 ? 1 : 0)} mm/h${wx.freezingRain ? ' FREEZING' : ''}`]);
  if (wx?.inCloud) rows.push(['Cloud', `in cloud · vis ${wx.visibility < 1000 ? `${fmt(wx.visibility)} m` : `${fmt(wx.visibility / 1000, 1)} km`}`]);
  const iceMm = icing?.surfaces?.length ? Math.max(...icing.surfaces.map((q) => q.mm)) : 0;
  if (iceMm > 0.1) rows.push(['Ice', `${fmt(iceMm, 1)} mm ${icing.surfaces[0].glaze > 0.5 ? 'clear' : 'rime'} · ${['', 'trace', 'light', 'moderate', 'severe'][icing.intensity] || 'none now'}`]);
  if (icing?.carburettor && (icing.carbBlockage > 0.03 || icing.carbHeat > 0.1)) rows.push(['Carb ice', `${fmt(icing.carbBlockage * 100)} % · heat ${controlPos('engine1.carb_heat') ? 'HOT' : 'COLD'}`]);
  return rows;
}
// The navigation card: the GPS leg, then NAV 1 (the ILS) or the GPS approach
// deviation. Bars: full scale both sides, + = needle right (fly right).
const hNav = $('hNav');
function navHud() {
  hNav.hidden = !DEST;
  if (!DEST) return;
  const g = A.gps(), r = A.route(), wp = r.wp[g[1]];
  const rows = [];
  if (g[0] && wp) {
    const ete = s[12] > 30 ? g[7] / (s[12] * 0.5144) : 0;
    rows.push(['GPS ' + ['ENR', 'TERM', 'APR'][g[2]], `${wp.ident} ${nm(g[7])} NM${ete ? ` · ${Math.floor(ete / 60)}:${String(Math.round(ete % 60)).padStart(2, '0')}` : ''}`]);
    rows.push(['DTK · XTK', `${deg3(g[3] - g[13])}° · ${Math.abs(g[4]) < 9 ? 'on course' : `${g[4] > 0 ? 'R' : 'L'} ${nm(Math.abs(g[4]), 2)} NM`}`]);
    rows.push([DEST.icao, `${nm(g[9], 0)} NM to ${DEST.runway}`]);
  }
  const ils = c[K.navValid] && c[K.loc];
  const bar = (v, cls) => `<span class="dev ${cls}"><i style="left:${50 + 50 * clamp(v, -1, 1)}%"></i></span>`;
  const dots = (v, up, down) => (Math.abs(v) < 0.05 ? 'on path' : `${v > 0 ? up : down} ${(Math.abs(v) * 2).toFixed(1)} dot`);
  rows.push(['NAV 1', `${c[K.navAct].toFixed(2)} ${ils ? (DEST.ils && Math.round(c[K.navAct] * 1000) === DEST.khz ? DEST.ils : 'LOC') : c[K.navValid] ? 'VOR' : '· no signal'}`]);
  if (ils) rows.push(['LOC', bar(c[K.cdi], 'ils')]);
  else if (g[0]) rows.push(['GPS', bar(g[6], '')]);
  if (ils && c[K.gsValid]) rows.push(['GS', dots(c[K.gs], 'fly up', 'fly down')]);
  else if (g[10]) rows.push(['GP', dots(g[12], 'fly up', 'fly down')]);
  hNav.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}
function hud() {
  $('hAssist').innerHTML = assistStatus();
  navHud();
  if (P.jet) { jetHud(); return; }
  $('hIas').innerHTML = iasHtml();
  $('hAlt').innerHTML = `${fmt(c[K.alt])}<small>FT MSL</small>`;
  const hdg = String(Math.round(((c[K.dg] % 360) + 360) % 360) || 360).padStart(3, '0');
  const rows = [
    ['Ground speed', spd(s[12])], ['Vertical', `${fmt(c[K.vsi])} fpm`], ['Heading', `${hdg}°`], ...windRows(),
    ['Above field', `${fmt(Math.max(0, s[14]))} ft`], ['Engine', s[30] ? `${fmt(s[19])} rpm` : 'stopped'],
    ['Manifold', `${fmt(s[20], 1)} inHg`], ['Fuel', `${fmt(s[52])} L`], ['Flaps', `${fmt(s[26])}°`],
    ['Trim', `${fmt(s[27] * 100)} %`], ['Load', `${fmt(s[18], 2)} g`], ['α', s[11] > 25 ? `${fmt(s[16], 1)}°` : '—'],
    ['Brakes', s[49] ? 'PARKING SET' : input.brake ? 'on' : 'off'],
  ];
  hRead.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  $('lThr').parentElement.classList.remove('split');
  $('lThr').style.height = `${input.throttle * 100}%`;
  $('lMix').style.height = `${input.mixture * 100}%`;
  $('lFlp').style.height = `${clamp(s[26] / 30, 0, 1) * 100}%`;
  if (MOBILE) $('thr').querySelector('i').style.top = `${(1 - input.throttle) * (170 - 34) + 2}px`;
}

function jetHud() {
  $('hIas').innerHTML = iasHtml();
  $('hAlt').innerHTML = `${fmt(c[K.alt])}<small>FT MSL</small>`;
  const hdg = String(Math.round(((c[K.dg] % 360) + 360) % 360) || 360).padStart(3, '0');
  const gear = j[1] > 0.999 ? 'down' : j[1] < 0.001 ? 'up' : 'in transit';
  if (tp) {
    const [e1, e2] = tp.engines, two = (f, d = 0) => `${fmt(f(e1), d)} / ${fmt(f(e2), d)}`;
    const blades = tp.engines.map((e) => (e.feathered ? 'feathered' : e.beta ? (reverse > 0.42 ? 'reverse' : 'beta') : ''));
    const rows = [
      ['Ground speed', spd(s[12])], ['Vertical', `${fmt(c[K.vsi])} fpm`], ['Heading', `${hdg}°`], ...windRows(), ['Above field', `${fmt(Math.max(0, s[14]))} ft`],
      ['Torque L / R', `${two((e) => e.torque)} %`], ['Np L / R', `${two((e) => e.np)} rpm`], ['Ng L / R', `${two((e) => e.ng, 1)} %`],
      ['ITT L / R', `${two((e) => e.itt)} °C`], ['Fuel flow', `${fmt((e1.fuelFlowLbH + e2.fuelFlowLbH) / 10) * 10 || 0} lb/h`], ['Fuel', `${fmt(j[6] * 2.20462)} lb`],
      ['Flaps', `${fmt(j[27])}°`], ['Gear', gear], ['Power levers', input.levers ? `${fmt(input.levers[0] * 100)} / ${fmt(input.levers[1] * 100)} %` : `${fmt(input.throttle * 100)} %`],
      ['Propellers', `${fmt(tp.npSelected)} rpm${tp.autofeather.armed ? ' · AF armed' : ''}`], ['Condition', tp.engines.map((e) => CONDITIONS[e.condition] || '—').join(' / ')],
      ...(blades.some(Boolean) ? [['Blades', blades.map((b) => b || 'governing').join(' / ')]] : []),
      ['Load', `${fmt(s[18], 2)} g`], ['Brakes', s[49] ? 'PARKING SET' : input.brake ? 'on' : 'off'],
    ];
    hRead.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
    const split = !!input.levers;
    $('lThr').parentElement.classList.toggle('split', split);
    $('lThr').style.height = `${leverPos(0) * 100}%`;
    $('lThr2').style.height = `${leverPos(1) * 100}%`;
    $('lMix').style.height = `${tp.propLever * 100}%`;
    $('lFlp').style.height = `${clamp(j[27] / (j[50] || 35), 0, 1) * 100}%`;
    if (MOBILE) $('thr').querySelector('i').style.top = `${(1 - input.throttle) * (170 - 34) + 2}px`;
    return;
  }
  const rows = [
    ['Mach', j[5] > 0.2 ? fmt(j[5], 3) : '—'], ['Ground speed', spd(s[12])], ['Vertical', `${fmt(c[K.vsi])} fpm`],
    ['Heading', `${hdg}°`], ...windRows(), ['Above field', `${fmt(Math.max(0, s[14]))} ft`],
    ['N1 L / R', `${fmt(j[8], 1)} / ${fmt(j[16], 1)} %`], ['Fuel flow', `${fmt(j[7] * 2.20462 / 10) * 10 || 0} lb/h`],
    ['Fuel', `${fmt(j[6] * 2.20462)} lb`], ['Flaps', `${fmt(j[27])}°`], ['Gear', gear], ['Speedbrake', j[56] ? 'ground spoilers' : j[3] > 0.02 ? `${fmt(j[3] * 100)} %` : 'retracted'],
    ...(j[57] ? [['Reversers', j[52] > 0.02 ? ['', 'reverse thrust', 'reverse idle', 'stowing', 'reverse (levers)'][j[53] | 0] || `${fmt(j[52] * 100)} %` : 'stowed (auto)']] : []),
    ['Thrust levers', input.levers ? `${fmt(j[58] * 100)} / ${fmt(j[59] * 100)} %` : `${fmt(input.throttle * 100)} %`],
    ['Load', `${fmt(s[18], 2)} g`], ['Brakes', s[49] ? 'PARKING SET' : input.brake ? 'on' : 'off'],
  ];
  hRead.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  // Split levers: two thin bars, engine 1 left.
  const split = !!input.levers;
  $('lThr').parentElement.classList.toggle('split', split);
  $('lThr').style.height = `${(split ? j[58] : input.throttle) * 100}%`;
  $('lThr2').style.height = `${(split ? j[59] : input.throttle) * 100}%`;
  $('lMix').style.height = `${j[3] * 100}%`;
  $('lFlp').style.height = `${clamp(j[27] / 39, 0, 1) * 100}%`;
  if (MOBILE) $('thr').querySelector('i').style.top = `${(1 - input.throttle) * (170 - 34) + 2}px`;
}
const FMA = ['EASY · WING LEVEL · AUTO TRIM', 'SPORT · AUTO COORD', 'MANUAL'];
function jetData() {
  const agl = Math.max(0, s[14]);
  return {
    ias: c[K.ias], alt: c[K.alt], baro: c[K.kollsman], vsi: c[K.vsi], pitch: c[K.aiPitch], roll: c[K.aiRoll], hdg: c[K.dg], bug: c[K.bug],
    ball: c[K.ball], stall: c[K.stall] > 0.5, mach: j[5], gs: s[12], tas: j[26], agl: Math.max(0, s[14]), vmo: j[25], mmo: j[24],
    assist: ap.on ? apText() : FMA[ui.assist] + (s[58] ? ' · UNDERSPD' : s[55] ? ' · ALT HDG HOLD' : ''), n1: [j[8], j[16]], n2: [j[9], j[17]], itt: [j[10], j[18]], ff: [j[11], j[19]], oil: [j[30], j[31]],
    run: [j[13], j[21]], starting: [j[14], j[22]], fuelSw: [j[15], j[23]], n1cmd: [22 + 78 * j[58], 22 + 78 * j[59]],
    fuelKg: j[6], gear: j[1], spd: j[3], flaps: j[27], wow: j[29], park: s[49],
    x: s[0], y: s[1], trueHdg: s[9], runway: RW, airport: AP.icao, points: LANDMARKS,
    rangeNm: agl < 4000 ? 5 : agl < 15000 ? 10 : agl < 28000 ? 20 : 40,
    trend: iasAcc * 10, vs1g: j[32], vsTO: j[33], vsLDG: j[34], gw: j[35], fpa: j[36], drift: ((j[37] - s[9] + 540) % 360) - 180,
    windDir: s[59], windKt: s[60], ra: j[40], sat: j[41], nz: j[42], aoa: j[43], gen: j[44], volts: j[45],
    vfe: j[47], vle: j[48], toFlap: j[49], ldgFlap: j[50], trim: j[28], thrLever: Math.max(j[58], j[59]), crashed: ui.crashed, pusher: !!j[51],
    rev: [j[52], j[54]], gndSpoilers: !!j[56], typeName: def.visual?.short_name || 'TOP G',
    // Systems: generators on line, hydraulic pressure A/B, brake accumulator, gear free fall, battery.
    gens: [j[60], j[61]], hyd: [j[62], j[63]], brakeAccum: j[69], gearFreeFall: !!j[70], hydFit: !!j[71], battSoc: j[72], battA: j[73],
    // Essential bus: load shed on (controller or pilot), the controller's own shed, a controller fitted.
    loadShed: !!j[82], autoShed: !!j[83], shedFit: !!j[84],
    // Navigation: the GPS route and leg, the destination runway, NAV 1.
    route: DEST ? A.route() : null, gps: DEST ? A.gps().slice() : null, dest: DEST,
    destRunway: DEST ? REGION[DEST.ai].ends[DEST.ri] : null,
    nav: { valid: !!c[K.navValid], loc: !!c[K.loc], cdi: c[K.cdi], gsValid: !!c[K.gsValid], gs: c[K.gs], mhz: c[K.navAct] },
    taws: tawsUi, fma: ap.on || performance.now() < minimumsUntil ? fmaModes() : null, attFlag: !!att?.attFlag,
    // Ice: the detector's ICE, and the protection switched on (WING A/I, TAIL A/I).
    ice: icing ? { detected: icing.iceDetected, protOn: icing.protectionMask > 0,
      on: iceCtl.filter((x, k) => (icing.protectionMask >> k) & 1).map((x) => (x.id === 'anti_ice.tail' ? 'TAIL A/I' : x.id === 'anti_ice.wing' ? 'WING A/I' : `${x.id.split('.')[1].toUpperCase()} A/I`)) } : null,
    // A turboprop: its engine indication, power levers and the prop lever (glass.js turboprop page).
    ...(tp ? tpData() : {}),
  };
}

// The King Air's engines for the glass deck: the indication (A.turboprop())
// and the engine flags the crew alerting reads (running, starting, fuel on).
function tpData() {
  const E = tp.engines;
  return {
    tp: { ...tp, levers: [leverPos(0), leverPos(1)], reverse }, run: E.map((e) => +e.running), starting: E.map((e) => +(e.starter && !e.running)),
    fuelSw: E.map((e) => +(e.condition > 0)), oil: E.map((e) => e.oilPsi), itt: E.map((e) => e.itt), n1: E.map((e) => e.torque), ff: E.map((e) => e.fuelFlowKgH),
    thrLever: Math.max(leverPos(0), leverPos(1)), fuelLowKg: 230,
  };
}
// The G1000's readings: the instrument models (attitude, heading, air data),
// the engine's sensors, NAV 1 and the GPS (g1000.js).
function g1000Modes() {
  if (autoland) return { on: true, lat: alStatus.phase >= 3 ? 'ROLLOUT' : 'GPS', vert: ['ALT', 'GP', 'FLARE', '', ''][alStatus.phase] || '', armed: 'AUTOLAND' };
  if (!ap.on) return performance.now() < minimumsUntil ? { on: false, minimums: true } : null;
  const st = apStatus, alt = `${fmt(st.altFt)}FT`, f = fmaModes(), gps = st.aprSource === 'gps';
  const glide = st.vertical === 5 || st.apr === 3;
  return { on: true, lat: st.lateral === 4 ? f.lat.split(' ')[0] : ['', 'ROL', 'HDG', 'GPS'][st.lateral] || '', latArmed: f.latArmed,
    vert: glide ? (gps ? 'GP' : 'GS') : ['', 'PIT', 'ALT', 'VS', 'ALTS'][st.vertical] || '',
    ref: glide ? '' : st.vertical === 3 ? `${st.vsFpm > 0 ? '+' : ''}${fmt(st.vsFpm)}FPM` : st.vertical === 2 || st.vertical === 4 ? alt : '',
    armed: st.lateral === 4 && st.apr === 2 ? (gps ? 'GP' : 'GS') : st.vertical === 3 ? 'ALTS' : '', minimums: f.minimums };
}
function g1000Data() {
  const g = A.gps(), bus = !!sw.bat && c[K.volts] > 10;
  return {
    ias: c[K.ias], alt: c[K.alt], baro: c[K.kollsman], vsi: c[K.vsi], pitch: c[K.aiPitch], roll: c[K.aiRoll], tumbled: c[K.aiTumbled] > 0.5,
    hdg: c[K.dg], bug: c[K.bug], ball: c[K.ball], turnRate: c[K.tcRate], tas: s[11], gs: s[12], oat: c[K.oat], trend: iasAcc * 6,
    wow: !!s[28], trueHdg: s[9], track: s[61], windDir: s[59], windKt: s[60], magVar: g[13], selAlt: ap.alt,
    x: s[0], y: s[1], groundAt, runway: RW, airport: AP.icao, points: LANDMARKS,
    route: DEST ? A.route() : null, gps: DEST ? g.slice() : null, dest: DEST, destRunway: DEST ? REGION[DEST.ai].ends[DEST.ri] : null,
    nav: { valid: c[K.navValid] > 0.5, loc: c[K.loc] > 0.5, cdi: c[K.cdi], toFrom: c[K.toFrom], gsValid: c[K.gsValid] > 0.5, gs: c[K.gs],
      mhz: c[K.navAct], stby: c[K.navStb], obs: c[K.obs] },
    com: [c[K.comAct], c[K.comStb]], squawk: c[K.squawk], xpdrMode: c[K.xpdrMode], clock: c[K.clock], av: c[K.avPower] > 0.5,
    m: M, mk: MK, afcs: g1000Modes(), taws: tawsUi, attFlag: !!att?.attFlag, ahrs: !!att?.ahrs,
    eng: { rpm: c[K.rpm], ff: c[K.ff], oilP: c[K.oilP], oilT: c[K.oilT], egt: c[K.egt], fuelL: c[K.fuelL], fuelR: c[K.fuelR],
      amps: c[K.amps], volts: c[K.volts], suction: c[K.suction], ann: c[K.ann], hobbs: (s[42] || 0) / 3600 + 1287.4 },
    // The PFD on the main bus with the master on, the MFD on the avionics bus too.
    power: { pfd: bus, mfd: bus && c[K.avPower] > 0.5 },
  };
}

// ---------- TAWS / GPWS ----------
// The core's terrain awareness and warning system (avd_taws): class A in the
// jets, B in the others. Its top alert on the PFDs (glass.js, g1000.js) and,
// for the analog 172, as a tag on the screen; its phrases spoken.
let taws = null, tawsUi = null;
const TAWS_TERRAIN = new Set([4, 6, 7]);  // TERRAIN TERRAIN, CAUTION TERRAIN, TOO LOW TERRAIN
function readTaws() {
  if (!A.taws) return;
  taws = A.taws();
  const t = taws;
  const text = !t.level || t.top === 8 ? '' : t.level >= 3 ? 'PULL UP' : t.level === 2 && TAWS_TERRAIN.has(t.top) ? 'TERRAIN' : t.alert;
  tawsUi = { level: t.level, text, alert: t.alert, raFt: t.raFt, dhFt: t.dhFt, inhibit: t.inhibit, cls: t.cls };
  speakTaws(t);
  const tag = $('taws'), show = !!text && !ui.crashed && (!P.jet && !ui.glass || !ui.instr && ui.cam !== 1);
  tag.hidden = !show;
  if (show) { tag.textContent = text; tag.className = t.level >= 3 ? 'warn' : t.level === 2 ? 'caut' : ''; }
}
// The voice: each new phrase (a new voiceCount) spoken once, with the sound
// on (M). The core sets the priority and the repeats, so nothing is queued: a
// warning cuts a lesser phrase short; a lesser phrase does not interrupt a warning.
const speech = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
let tawsSaid = null, sayingPri = 0, tawsVoice = null;
// The phrase's urgency: 3 PULL UP, 2 the terrain, configuration and sink cautions, 1 MINIMUMS, GLIDESLOPE and the callouts.
const voicePri = (v) => (v <= 2 ? 3 : v === 4 || v === 11 || v >= 13 ? 1 : 2);
function pickVoice() {
  if (tawsVoice || !speech) return tawsVoice;
  const vs = speech.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
  const like = ['Google US English', 'Samantha', 'Microsoft Aria', 'Microsoft Guy', 'Microsoft Zira', 'Daniel', 'Alex', 'Google UK English Male'];
  tawsVoice = like.map((n) => vs.find((v) => v.name.startsWith(n))).find(Boolean) || vs.find((v) => /en-US/i.test(v.lang)) || vs[0] || null;
  return tawsVoice;
}
if (speech) speech.addEventListener?.('voiceschanged', () => { tawsVoice = null; });
function speakTaws(t) {
  if (t.voiceCount === tawsSaid) return;
  const first = tawsSaid === null;
  tawsSaid = t.voiceCount;
  if (first || !t.voice || !t.say || !ui.sound || !speech || ui.paused) return;
  const pri = voicePri(t.voice);
  if (speech.speaking || speech.pending) {
    if (pri < sayingPri) return;  // a warning is being said: no queue behind it
    speech.cancel();
  }
  const u = new SpeechSynthesisUtterance(t.say.toLowerCase());
  u.lang = 'en-US';
  const v = pickVoice(); if (v) u.voice = v;
  u.rate = pri === 3 ? 1.25 : 1.1;
  u.pitch = pri === 3 ? 1.1 : 1;
  u.volume = clamp((pri === 3 ? 1 : t.voice === 11 && !t.gsLoud ? 0.45 : 0.85) * (0.4 + 0.6 * ui.vol / 100), 0, 1);
  u.onend = u.onerror = () => { if (sayingPri === pri) sayingPri = 0; };
  sayingPri = pri;
  speech.speak(u);
}
// Options → Flying: terrain inhibit (FLTA off; the GPWS modes stay) and the
// decision height for MINIMUMS. Kept across aircraft and reloads (the core keeps them too).
const tawsCfg = { inhibit: !!store.get('tawsInhibit', false), dhFt: +store.get('tawsDh', 200) || 0 };
function applyTawsCfg(announce) {
  if (A.tawsConfig) A.tawsConfig({ inhibit: tawsCfg.inhibit, dhFt: tawsCfg.dhFt });
  store.set('tawsInhibit', tawsCfg.inhibit); store.set('tawsDh', tawsCfg.dhFt);
  $('bTerrInh').setAttribute('aria-pressed', String(tawsCfg.inhibit));
  $('tawsDh').value = String(tawsCfg.dhFt);
  if (announce) toast(tawsCfg.inhibit ? 'TERR INHIB: the forward-looking terrain alerts are off (the GPWS modes stay).' : 'Terrain alerts on.', 3);
}
$('bTerrInh').addEventListener('click', (e) => { tawsCfg.inhibit = !tawsCfg.inhibit; applyTawsCfg(true); e.currentTarget.blur(); });
// ---------- Prompts: what is wrong, and F to deal with it ----------
// Easy and Sport only (Simulation leaves the pilot to the annunciators, the
// EICAS and the TAWS): an abnormal condition read from the core (carburettor
// or airframe ice, an engine out, the gear up near the ground, an overspeed, a
// generator off line, the fuel) shows as one prompt, warnings first, then
// cautions, then advisories: what is happening, its key number, and the action.
// F (or a tap on it) does that action through the cockpit's own controls
// (setControl, the feather detents, the starter): the physics stays honest, the
// prompt only saves finding the switch. Esc puts a prompt away for 90 s. Each
// condition has its own way in and out (hysteresis), must hold a moment
// before it shows, and once acted on stays quiet until it has cleared.
const PROMPT = { cur: null, st: new Map(), pending: null, carbClear: null, tried: new Set(), at: 0 };
const LVL = ['', 'adv', 'caut', 'warn'];
// The fuel the Failures menu shut off, opened again by a prompt: the menu's button follows.
function fuelFailCleared() { failed.fuel = false; document.querySelector('[data-fail="fuel"]')?.setAttribute('aria-pressed', 'false'); }
// The nearest of the region's fields to the aircraft: { icao, name, km }.
function nearestField() {
  let best = null;
  for (let i = 0; i < REGION_N; ++i) {
    const [ce, cn] = fieldCentre(REGION[i]), km = Math.hypot(ce - s[0], cn - s[1]) / 1000;
    if (!best || km < best.km) best = { icao: DESTS[i].icao, name: DESTS[i].name, km };
  }
  return best;
}
// The GPS route to it (the runway into the wind, an ILS first), unless it is the destination already.
function directTo(f) {
  if (!f || DEST?.icao === f.icao) return null;
  return { label: `GPS route to ${f.icao} ${f.name}, ${fmt(f.km, 1)} km`, act: () => chooseApproach({ icao: f.icao }, preferredApproach(approachesOf({ icao: f.icao }))) };
}
// The usable fuel (L) and the minutes it lasts at this burn (s[21]: US gal/h).
function fuelLeft() {
  const L = A.loadsheet(false), litres = L.fuelUsable / (L.density || 0.8), lph = s[21] * 3.785;
  return { litres, min: lph > 1 ? litres / lph * 60 : Infinity, tanks: L.tanks };
}
// The conditions, in the order they rank within a level. Each gives the
// prompts that hold now: { id, level 3 warning | 2 caution | 1 advisory,
// title, detail, action (what F does, or none: F acknowledges), act(), say,
// hold (s the condition must last), retry (s after an action that did not
// clear it before it may come back) }. on(id): that prompt is up now (for the
// way back out).
function promptList(on) {
  const out = [], p = sw.pos || {}, has = (id) => id in p, air = !s[28] && s[14] > 50;
  const ias = c[K.ias], agl = Math.max(0, s[14]);
  if (s[30]) PROMPT.tried.clear();  // running again: a later failure starts from the restart
  // Engines.
  if (!P.jet && air && !s[30]) {
    // The 172 stopped in flight: why (as the core has it), the glide, the restart (POH: carb heat, fuel
    // selector BOTH, mixture RICH, magnetos BOTH, the starter if the propeller has stopped).
    const fl = fuelLeft(), sel = p['fuel.selector'], cause = !p['fuel.shutoff'] && has('fuel.shutoff') ? 'the fuel shutoff valve is closed'
      : fl.litres < 2 ? 'out of fuel' : input.mixture < 0.2 ? 'the mixture is at cut-off' : p['engine1.ignition'] !== 3 ? `the magnetos are on ${['OFF', 'R', 'L'][p['engine1.ignition']]}`
        : sel !== 1 && fl.tanks[sel === 0 ? 0 : 1] && fl.tanks[sel === 0 ? 0 : 1].litres < fl.tanks[sel === 0 ? 0 : 1].unusable + 1 ? `the ${sel === 0 ? 'left' : 'right'} tank it feeds from is empty`
          : icing?.carbBlockage > 0.3 ? `${Math.round(icing.carbBlockage * 100)} % of the carburettor iced` : '';
    // Best glide: 1.37 x the 1-g stall speed the core gives at this weight, flaps up (the POH's 68 KIAS at 2,550 lb).
    const vbg = s[26] < 1 && icing ? Math.round(1.37 * icing.vsCleanKcas) : 0, nf = nearestField();
    const where = `${vbg ? `glide at ${vbg} kt` : 'flaps up, glide'}${nf ? `; ${nf.name} ${fmt(nf.km, 1)} km` : ''}`;
    const tried = PROMPT.tried.has('engine');
    if (fl.litres < 2 || tried) {
      const d = directTo(nf);
      out.push({ id: tried ? 'glide' : 'engine', level: tried ? 1 : 3, title: tried ? 'Engine still out' : 'Engine failure', detail: `${cause ? `${cause[0].toUpperCase()}${cause.slice(1)}: ` : ''}${where}.`, action: d?.label, act: d?.act, say: tried ? '' : 'Engine failure. Glide.', hold: tried ? 12 : 1 });
    } else {
      const crank = s[19] < 400;
      out.push({ id: 'engine', level: 3, title: 'Engine failure', detail: `${cause ? `${cause[0].toUpperCase()}${cause.slice(1)}` : `${fmt(s[19])} rpm, windmilling`}: ${where}.`,
        action: `restart: ${has('fuel.shutoff') ? 'fuel ON, ' : ''}selector BOTH, mixture RICH, carb heat ON, magnetos BOTH${crank ? ', starter' : ''}`, say: 'Engine failure. Restart.',
        act: () => {
          PROMPT.tried.add('engine');
          if (has('fuel.shutoff')) { setControl('fuel.shutoff', 1); fuelFailCleared(); }
          setControl('fuel.selector', 1); setControl('engine1.carb_heat', 1); setControl('engine1.ignition', 3); input.mixture = 1;
          if (crank) { input.starter = 1; setTimeout(() => { input.starter = 0; }, 3000); }
        } });
    }
  } else if (!P.jet && air && has('fuel.shutoff') && !p['fuel.shutoff']) {
    out.push({ id: 'shutoff', level: 3, title: 'Fuel shutoff closed', detail: `The engine is running on the fuel left in its lines (${fmt(s[19])} rpm).`, hold: 0.5,
      action: 'fuel shutoff valve ON', say: 'Fuel off.', act: () => { setControl('fuel.shutoff', 1); fuelFailCleared(); } });
  } else if (P.turboprop && air && tp) {
    tp.engines.forEach((e, i) => {
      const n = i + 1, other = tp.engines[1 - i];
      if (!e.running && !e.feather && !e.feathered) {
        out.push({ id: `eng${i}`, level: 3, title: `Engine ${n} failure`, detail: `Its propeller windmilling at ${fmt(e.np)} rpm: drag on the dead side${other?.running ? `; engine ${2 - i} carries the airplane, rudder toward it` : ''}.`,
          action: `feather propeller ${n}`, say: `Engine ${n} failure. Feather.`, act: () => setFeather(i, true) });
      } else if (!e.running && !e.starter) {
        out.push({ id: `air${i}`, level: 1, title: `Engine ${n} secured`, detail: `Propeller ${n} feathered${e.condition ? '' : ', its condition lever at CUT-OFF'}.`, hold: 3,
          action: `airstart: condition ${n} LOW IDLE, ignition and start ON`, act: () => {
            setControl(`engine${n}.condition`, Math.max(1, controlPos(`engine${n}.condition`))); setControl(`engine${n}.starter`, 1); if (!i) fuelFailCleared();
          } });
      } else if (e.running && e.feather && !e.starter) {
        out.push({ id: `unf${i}`, level: 1, title: `Engine ${n} running`, detail: `Ng ${fmt(e.ng)} %, its propeller still feathered.`, hold: 3,
          action: `propeller ${n} out of feather`, act: () => setFeather(i, false) });
      }
    });
  } else if (P.jet && air) {
    for (const i of [0, 1]) {
      const n = i + 1, id = `engine${n}.fuel`;
      if (j[13 + 8 * i] || j[14 + 8 * i] || !has(id)) continue;
      const cut = !p[id];
      out.push({ id: `eng${i}`, level: 3, title: `Engine ${n} failure`, detail: `${cut ? 'Its fuel control switch at CUTOFF' : 'Flamed out'}: N1 ${fmt(j[8 + 8 * i])} %${j[13 + 8 * (1 - i)] ? `; engine ${2 - i} carries the airplane, rudder toward it` : ''}.`,
        action: `relight: engine ${n} fuel switch ${cut ? 'RUN' : 'CUTOFF, then RUN'}`, say: `Engine ${n} failure. Relight.`, retry: 45,
        act: () => { if (!cut) setControl(id, 0); setControl(id, 1); if (!i) fuelFailCleared(); } });
    }
  }
  // Gear up close to the ground on the way down (the TAWS's TOO LOW GEAR, landing flaps, or sinking low).
  if (P.jet && air && has('gear.lever') && !p['gear.lever'] && !autoland) {
    const lastFlap = (A.cockpit().find((x) => x.id === 'flaps.lever')?.positions.length || 1) - 1;
    const gearAlert = taws?.active.some((a) => /GEAR/.test(A.tawsAlertText(a)));
    if (agl < (on('gear') ? 1500 : 1000) && (gearAlert || (p['flaps.lever'] === lastFlap && c[K.vsi] < 200) || (agl < 500 && c[K.vsi] < -300))) {
      out.push({ id: 'gear', level: 3, title: 'Gear up', detail: `${fmt(agl)} ft above the ground${c[K.vsi] < -100 ? `, descending ${fmt(-c[K.vsi])} fpm` : ''}${p['flaps.lever'] === lastFlap ? ', landing flap' : ''}${ias > j[48] + 2 ? `; ${fmt(ias)} kt, over the ${fmt(j[48])} kt gear limit` : ''}.`,
        action: 'gear DOWN', say: 'Too low. Gear.', hold: 0.5, act: () => { setControl('gear.lever', 1); toast('Gear down', 1.5); } });
    }
  }
  // Overspeed: VMO (the jets' and the King Air's) or VNE (the 172's), MMO.
  {
    const lim = P.jet ? j[25] : M.vne, mmo = P.jet ? j[24] : 0, o = on('overspeed');
    if (lim > 0 && !s[28] && (ias > lim + (o ? -3 : 1) || (mmo > 0 && j[5] > mmo + (o ? -0.01 : 0.004)))) {
      const sb = has('speedbrake.lever') && controlPos('speedbrake.lever') < (A.cockpit().find((x) => x.id === 'speedbrake.lever').positions.length - 1);
      const machOver = mmo > 0 && j[5] > mmo;
      out.push({ id: 'overspeed', level: 3, title: 'Overspeed', detail: machOver ? `Mach ${fmt(j[5], 3)}, over MMO ${fmt(mmo, 3)}.` : `${fmt(ias)} kt, over ${P.jet ? 'VMO' : 'VNE'} ${fmt(lim)} kt.`,
        action: `${P.turboprop ? 'power levers' : P.jet ? 'thrust' : 'throttle'} idle${sb ? ', speedbrake FULL' : ''}${ap.on && ap.at ? ', autothrottle off' : ''}`, say: 'Overspeed.', hold: 0.5,
        act: () => {
          if (ap.on && ap.at) { ap.at = false; apApply(); }
          setThrottle(0);
          if (sb) setControl('speedbrake.lever', 99);
        } });
    }
  }
  // Ice. The airframe: the detector's ICE (the jets), or ice a pilot sees on the leading edges.
  if (icing && air) {
    const mm = icing.surfaces.length ? Math.max(...icing.surfaces.map((q) => q.mm)) : 0, o = on('ice') || on('iceinfo');
    const icy = icing.iceDetected || mm > (o ? 0.1 : 0.4) || (o && wx?.supercooledWater > 0);
    const off = iceCtl.filter((x) => x.id.startsWith('anti_ice.') && !p[x.id]);
    const sev = ['', 'trace', 'light', 'moderate', 'severe'][icing.intensity] || '';
    const fact = `${icing.iceDetected ? 'ICE DETECTED, ' : ''}${fmt(mm, 1)} mm on the leading edges${sev ? `, ${sev} icing` : ''}${icing.vsKcas > icing.vsCleanKcas + 1 ? `; stall speed ${fmt(icing.vsKcas)} kt (${fmt(icing.vsCleanKcas)} clean)` : ''}`;
    const name = (x) => { const k = x.id.split('.')[1]; return /Boots/i.test(x.label) ? `${k} boots` : /de-?ice/i.test(x.label) ? `${k === 'prop' ? 'propeller' : k} de-ice` : `${k} anti-ice`; };
    if (icy && off.length) out.push({ id: 'ice', level: 2, title: 'Airframe icing', detail: `${fact}.`, action: `${off.map(name).join(', ')} ON`, say: 'Ice. Anti-ice on.',
      act: () => { for (const x of off) setControl(x.id, 1); } });
    else if (icy && !iceCtl.some((x) => x.id.startsWith('anti_ice.')) && mm > (o ? 0.3 : 1)) out.push({ id: 'iceinfo', level: 2, title: 'Airframe icing', detail: `${fact}. No ice protection: climb or descend out of the cloud, keep the speed up.`, say: 'Airframe ice.' });
  }
  // The pitot in visible moisture near or below freezing, or blocked in it, with its heat off.
  if (has('electrical.load.pitot_heat') && !p['electrical.load.pitot_heat'] && air && wx) {
    const wet = wx.inCloud || wx.rain > 0, cold = wx.oat < (on('pitot') ? 7 : 5);
    if (wet && (cold || failed[0])) out.push({ id: 'pitot', level: 2, title: failed[0] ? 'Airspeed unreliable' : 'Pitot icing', detail: failed[0] ? `The pitot tube is blocked, in ${wx.inCloud ? 'cloud' : 'rain'} at ${fmt(wx.oat)} °C.` : `In ${wx.inCloud ? 'cloud' : 'rain'} at ${fmt(wx.oat)} °C: the pitot tube can ice and the airspeed fail.`,
      action: `${P.jet ? 'probe' : 'pitot'} heat ON`, say: 'Pitot heat.', hold: 3, act: () => setControl('electrical.load.pitot_heat', 1) });
  }
  // The carburettor: ice in the throat (carb heat HOT), and the heat left on after it has gone.
  if (icing?.carburettor && s[30] && has('engine1.carb_heat')) {
    const hot = !!p['engine1.carb_heat'], b = icing.carbBlockage;
    if (!hot && b > (on('carb') ? 0.05 : 0.12)) out.push({ id: 'carb', level: 2, title: 'Carburettor ice', detail: `${fmt(s[19])} rpm and falling: ${fmt(b * 100)} % of the carburettor throat iced.`,
      action: 'carb heat ON', say: 'Carburettor ice. Carb heat on.', act: () => setControl('engine1.carb_heat', 1) });
    if (hot && icing.carbIceG < 0.01 && input.throttle > 0.35 && s[42] - PROMPT.carbClear > 45) out.push({ id: 'carboff', level: 1, title: 'Carburettor clear', detail: 'The ice has melted; the hot air costs power (about 100 rpm).',
      action: 'carb heat OFF (back ON if the rpm sags again)', act: () => setControl('engine1.carb_heat', 0) });
  }
  // Electrics: the 172's alternator; the generators of the jets and the King Air, each with its engine running.
  if (air && !P.jet && s[30] && has('electrical.alternator')) {
    const shed = has('electrical.load_shed') && !p['electrical.load_shed'];
    if (!p['electrical.alternator']) out.push({ id: 'altsw', level: 2, title: 'Alternator off', detail: `The battery alone carries the bus (${fmt(s[31], 1)} V).`, action: 'alternator switch ON', hold: 3, act: () => setControl('electrical.alternator', 1) });
    else if (!s[32] && shed) out.push({ id: 'alt', level: 2, title: 'Alternator failure', detail: `The battery alone carries the bus: ${fmt(s[31], 1)} V, ${fmt(s[34] * 100)} % charge left.`, hold: 3,
      action: 'load shed (the essential bus only)', say: 'Alternator failure.', act: () => setControl('electrical.load_shed', 1) });
  } else if (air && P.jet) {
    const run = (i) => (tp ? tp.engines[i]?.running : j[13 + 8 * i]);
    const gens = [0, 1].filter((i) => has(`electrical.generator${i + 1}`) && run(i));
    const offSw = gens.filter((i) => !p[`electrical.generator${i + 1}`]), offLine = gens.filter((i) => p[`electrical.generator${i + 1}`] && !j[60 + i]);
    const shed = has('electrical.load_shed') && !p['electrical.load_shed'] && !j[82];
    if (offSw.length) out.push({ id: 'gensw', level: 2, title: `GEN ${offSw.map((i) => i + 1).join(' and ')} switch off`, detail: `Its engine running, the generator not on the bus.`, hold: 3,
      action: `GEN ${offSw.map((i) => i + 1).join(', ')} ON`, act: () => { for (const i of offSw) setControl(`electrical.generator${i + 1}`, 1); } });
    else if (offLine.length && !j[60] && !j[61] && shed) out.push({ id: 'gens', level: 2, title: 'Both generators off', detail: `The battery alone carries the bus: ${fmt(j[45], 1)} V, ${fmt(j[72] * 100)} % charge.`, hold: 3,
      action: 'load shed (the essential bus only)', say: 'Generators off.', act: () => setControl('electrical.load_shed', 1) });
    else for (const i of offLine) {
      if (!j[60 + (1 - i)]) continue;
      out.push({ id: `gen${i}`, level: 1, title: `GEN ${i + 1} off line`, detail: `Generator ${2 - i} carries the bus alone.`, hold: 3,
        action: `GEN ${i + 1} reset (switch OFF, then ON)`, act: () => { setControl(`electrical.generator${i + 1}`, 0); setControl(`electrical.generator${i + 1}`, 1); } });
    }
  }
  // Fuel: the 172 feeding from one tank (running it dry, or lopsided), and fuel for less than half an hour.
  if (air && P.id === 'c172' && p['fuel.selector'] !== undefined && p['fuel.selector'] !== 1 && s[30]) {
    const fl = fuelLeft(), k = p['fuel.selector'] === 0 ? 0 : 1, t = fl.tanks[k], u = fl.tanks[1 - k];
    if (t && u) {
      const left = t.litres - t.unusable, diff = (u.litres - u.unusable) - left;
      if (left < (on('fuelsel') ? 12 : 8) || diff > (on('fuelsel') ? 30 : 40)) out.push({ id: 'fuelsel', level: 2, title: 'Fuel selector', detail: `Feeding from the ${k ? 'right' : 'left'} tank alone: ${fmt(left)} L usable in it, ${fmt(u.litres - u.unusable)} L in the other.`,
        action: 'fuel selector BOTH', act: () => setControl('fuel.selector', 1) });
    }
  }
  if (air && s[30]) {
    const fl = fuelLeft();
    if (fl.min < (on('fuellow') ? 35 : 30)) {
      const d = directTo(nearestField());
      out.push({ id: 'fuellow', level: 2, title: 'Low fuel', detail: `${fmt(fl.min)} minutes of fuel at this burn (${fmt(fl.litres)} L usable).`, action: d?.label, act: d?.act, say: 'Low fuel.', hold: 3 });
    }
  }
  return out;
}
const promptEl = $('prompt');
function showPrompt(pr) {
  PROMPT.cur = pr;
  promptEl.hidden = !pr;
  if (!pr) return;
  promptEl.className = LVL[pr.level];
  $('promptTitle').textContent = pr.title;
  $('promptDetail').textContent = pr.detail;
  $('promptKey').textContent = MOBILE ? 'Tap' : 'F';
  $('promptAction').textContent = pr.action || 'OK';
}
// Every 0.2 s: each prompt's condition held (or gone) for how long (wall-clock seconds); the one to show.
function checkPrompts() {
  const now = performance.now(), dt = clamp((now - (PROMPT.at || now)) / 1000, 0, 1);
  PROMPT.at = now;
  if (ui.assist === 2 || ui.crashed) { PROMPT.st.clear(); if (PROMPT.cur) showPrompt(null); return; }
  // Since when (simulation time) the carburettor has been free of ice with the heat on.
  PROMPT.carbClear = icing?.carburettor && controlPos('engine1.carb_heat') && icing.carbIceG < 0.01 ? PROMPT.carbClear ?? s[42] : null;
  const st = PROMPT.st, list = promptList((id) => !!st.get(id)?.up);
  const live = new Set(list.map((q) => q.id));
  for (const [id, r] of st) if (!live.has(id)) {
    r.held = 0; r.gone += dt;
    // Cleared for a few seconds: forgotten (its action and snooze with it), ready to come back.
    if (r.gone > 2) st.delete(id);
  }
  let best = null;
  for (const q of list) {
    const r = st.get(q.id) || { held: 0, gone: 0, up: false, done: 0, snooze: 0 };
    st.set(q.id, r);
    r.held += dt; r.gone = 0;
    if (r.held >= (q.hold ?? 1)) r.up = true;
    if (!r.up || now < r.snooze || (r.done && !(q.retry && now - r.done > q.retry * 1000))) continue;
    if (!best || q.level > best.level) best = q;
  }
  if (best && PROMPT.cur?.id === best.id) { PROMPT.cur = best; promptEl.className = LVL[best.level]; $('promptDetail').textContent = best.detail; $('promptAction').textContent = best.action || 'OK'; }
  else if (best || PROMPT.cur) {
    showPrompt(best);
    if (best) PROMPT.pending = { pr: best, until: now + 6000 };
  }
  sayPrompt(now);
}
// The prompt's words, once, with the sound on: not over a TAWS caution or warning (it waits for it).
function sayPrompt(now) {
  const q = PROMPT.pending;
  if (!q) return;
  if (!q.pr.say || now > q.until || PROMPT.cur?.id !== q.pr.id || !ui.sound || !speech || ui.paused) { PROMPT.pending = null; return; }
  if ((taws && taws.level >= 2) || ((speech.speaking || speech.pending) && sayingPri >= 1)) return;
  PROMPT.pending = null;
  const u = new SpeechSynthesisUtterance(q.pr.say.toLowerCase());
  u.lang = 'en-US';
  const v = pickVoice(); if (v) u.voice = v;
  u.rate = 1.1; u.volume = clamp(0.8 * (0.4 + 0.6 * ui.vol / 100), 0, 1);
  u.onend = u.onerror = () => { if (sayingPri === 1) sayingPri = 0; };
  sayingPri = 1;
  speech.speak(u);
}
// F or a tap: the action (or, with none, the acknowledgement); Esc: away for 90 s.
function promptAct() {
  const pr = PROMPT.cur;
  if (!pr) return false;
  const r = PROMPT.st.get(pr.id);
  if (pr.act) { toast(`${pr.title}: ${pr.action}.`, 2.5); pr.act(); if (r) r.done = performance.now(); }  // (an action with words of its own has the last one)
  else if (r) r.snooze = Infinity;
  showPrompt(null);
  return true;
}
function promptDismiss() {
  const pr = PROMPT.cur;
  if (!pr) return false;
  const r = PROMPT.st.get(pr.id);
  if (r) r.snooze = performance.now() + 90000;
  showPrompt(null);
  return true;
}
function resetPrompts() { PROMPT.st.clear(); PROMPT.tried.clear(); PROMPT.pending = null; PROMPT.carbClear = null; showPrompt(null); }
$('promptGo').addEventListener('click', (e) => { promptAct(); e.currentTarget.blur(); });
$('promptX').addEventListener('click', (e) => { promptDismiss(); e.currentTarget.blur(); });
$('tawsDh').addEventListener('change', (e) => { tawsCfg.dhFt = +e.target.value; applyTawsCfg(false); toast(tawsCfg.dhFt ? `Decision height ${tawsCfg.dhFt} ft on the radio altimeter: MINIMUMS called there.` : 'No decision height: no MINIMUMS call.', 3); e.target.blur(); });
applyTawsCfg(false);

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
  document.body.classList.toggle('noinstr', !ui.instr || inside);  // (a prompt moves up on a touch screen)
  $('hud').style.display = inside ? 'none' : '';
  // The chase view swings back behind the airplane; in the cockpit the head stays where you turned it.
  if (!look.held && ui.cam !== 2 && ui.cam !== 1) { look.yaw *= Math.exp(-dt * 1.5); look.pitch *= Math.exp(-dt * 1.5); }
  camera.near = ui.cam === 1 ? 0.08 : 0.5;
  if (ui.cam === 1) {
    eye.getWorldPosition(camera.position); eye.getWorldQuaternion(camera.quaternion);
    camera.rotateY(look.yaw); camera.rotateX(-look.pitch * 0.8 - 0.17);
    camera.fov = innerWidth < innerHeight ? 82 : 70;
    camera.updateProjectionMatrix();
    cockpitHover();
    camera.fov = innerWidth < innerHeight ? 82 : 70;
  } else if (ui.cam === 3) {
    camera.position.copy(TOWER); camera.lookAt(target);
    camera.fov = clamp(Math.atan2(P.tower, TOWER.distanceTo(target)) * 2 / DEG, 2, 60);
  } else {
    // Chase follows the track (heading when slow); orbit is fully mouse-driven.
    const h = (ui.cam === 0 ? s[9] * DEG : 0) + look.yaw, el = (ui.cam === 0 ? 0.2 : 0.35) + look.pitch;
    const d = ui.cam === 0 ? look.dist : look.dist * 1.6;
    const want = target.clone().add(new THREE.Vector3(-Math.sin(h) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(h) * Math.cos(el) * d));
    want.y = Math.max(want.y, groundAt(want.x, -want.z) + 1.2);
    if (snapCamera) camPos.copy(want); else camPos.lerp(want, 1 - Math.exp(-dt * (ui.cam === 0 ? 5 : 12)));
    camLook.copy(target);
    camera.position.copy(camPos); camera.lookAt(camLook);
    camera.fov = innerWidth < innerHeight ? 75 : 60;
  }
  snapCamera = false;
  camera.updateProjectionMatrix();
  skyDome.position.copy(camera.position);
  // Shadow follows the airplane; fog opens up with height.
  const agl = Math.max(0, s[14] * 0.3048);
  sun.target.position.copy(target);
  sun.position.copy(target).addScaledVector(SUN_DIR, agl / SUN_DIR.y + 60);
  sun.shadow.camera.far = agl / SUN_DIR.y + 120; sun.shadow.camera.updateProjectionMatrix();
  if (ui.flow === 2) { scene.fog.near = 1.5 * P.chase; scene.fog.far = 7 * P.chase; }
  else { const f = VIEWS[gfx.view].fog; scene.fog.near = (2500 + agl * 3) * f; scene.fog.far = (22000 + agl * 12) * f; }
  updateFogLayer();
  weatherVisibility();
}

// ---------- The weather, seen ----------
// Rain streaks round the camera; the ice on the leading edges; the runways'
// wetness; frost on the windshield (cockpit view); the ATIS line in the
// Weather menu. (Carburettor ice: a prompt in Easy and Sport, checkPrompts.)
const WX_GREY = new THREE.Color().setRGB(0.72, 0.74, 0.77);
const vAc = new THREE.Vector3(), vWind = new THREE.Vector3();
let atisAt = 0;
function weatherFx(dt) {
  const tr = s[61] * DEG, gs = s[12] * 0.514444, wf = s[59] * DEG, wk = s[60] * 0.514444;
  vAc.set(gs * Math.sin(tr), s[15] * 0.00508, -gs * Math.cos(tr));
  vWind.set(-wk * Math.sin(wf), 0, wk * Math.cos(wf));
  rainFx.update(camera, ui.flow === 2 ? 0 : wx?.rain || 0, vAc, vWind, ui.paused ? 0 : dt);
  aircraft.ice?.update(icing);
  setRunwayWet(s[63] || 0);
  $('frost').style.opacity = ui.cam === 1 && icing ? String(clamp(icing.windshieldOpacity, 0, 1)) : '0';
  // The ATIS once a second of wall time while the Weather menu shows.
  if (performance.now() - atisAt > 1000 && !$('side').hidden && menu === 'weather') { atisAt = performance.now(); $('atis').innerHTML = atisText(); }
}
// Haze in the rain and in cloud: the view closes in to the meteorological
// visibility (A.weather().visibility) and the sky greys (after the fog layer's own).
function weatherVisibility() {
  if (ui.flow === 2 || !wx) return;
  const vis = wx.visibility;
  if (!(vis < 30000)) { scene.fog.color.copy(SKY); return; }
  scene.fog.far = Math.min(scene.fog.far, Math.max(60, vis * 1.25));
  scene.fog.near = Math.min(scene.fog.near, vis * 0.05);
  const g = clamp(1 - vis / 12000, 0, 1) * (wx.inCloud ? 1 : 0.85);
  scene.fog.color.copy(SKY).lerp(WX_GREY, g);
  const u = skyDome.material.uniforms;
  u.hor.value.lerp(WX_GREY, g); u.zen.value.lerp(WX_GREY, g * 0.9);
  sun.intensity *= 1 - 0.55 * g; ambient.intensity = Math.max(ambient.intensity, 0.58 + 0.3 * g);
}
// The field's ATIS, from the core: QNH and OAT at the field, the rain, the
// cloud layer, a front's ETA (or how long ago it passed).
function atisText() {
  if (!wx) return '';
  const hpa = wx.fieldQnh, inHg = hpa * 0.02953, kt = +$('wind').value, dir = +$('windDir').value;
  const parts = [`<b>${AP.icao} ATIS</b>`, kt ? `wind ${String(dir).padStart(3, '0')}° ${kt} kt` : 'wind calm'];
  if (wx.rain > 0 || wxx.rain > 0) parts.push(`${wxx.rain >= 50 ? 'torrential' : wxx.rain >= 10 ? 'heavy' : wxx.rain >= 2.5 ? 'moderate' : 'light'} rain (${wxx.rain} mm/h)`);
  if (wx.cloudTop > wx.cloudBase && wx.cloudTop > ELEV) {
    const base = Math.round((wx.cloudBase - ELEV) / 0.3048 / 100) * 100;
    parts.push(`${base > 0 ? `overcast ${base.toLocaleString('en-US')} ft` : 'cloud on the field'}, tops ${(Math.round(wx.cloudTop / 0.3048 / 100) * 100).toLocaleString('en-US')} ft MSL`);
  }
  parts.push(`OAT ${fmt(wx.fieldOat)} °C`, `QNH ${fmt(hpa)} hPa (${inHg.toFixed(2)} inHg)`);
  if (wx.frontEtaMin > 0) parts.push(`${$('front').value} front expected in ${fmt(wx.frontEtaMin)} min`);
  else if (wx.frontBehind >= 0 && wx.frontEtaMin <= 0 && $('front').value !== 'none') parts.push(`${$('front').value} front passed ${fmt(-wx.frontEtaMin)} min ago`);
  if (s[63] > 0) parts.push(s[63] >= 3 ? `standing water on the runway (${fmt(s[63], 1)} mm)` : s[63] < 0.1 ? 'runway damp' : `runway wet (${fmt(s[63], 1)} mm)`);
  return parts.join(' · ');
}

// ---------- Visibility: haze, mist and fog ----------
// [visibility (m, MOR; RVR for the fogs), top of the layer above the ground (m)].
const VIS = [null, [5000, 1200], [1500, 300], [550, 200], [300, 150], [175, 120], [75, 100], [15, 100]];
const FOG_GREY = new THREE.Color().setRGB(0.8, 0.8, 0.8), SKY_ZEN = skyDome.material.uniforms.zen.value.clone();
function updateFogLayer() {
  const p = VIS[ui.vis], u = skyDome.material.uniforms;
  if (!p || ui.flow === 2) {
    FOG.y = 0; u.hor.value.copy(SKY); u.zen.value.copy(SKY_ZEN); sun.intensity = 0.6; ambient.intensity = 0.58;
    return;
  }
  const [vis, top] = p;
  FOG.x = groundAt(s[0], s[1]) + top;  // the layer follows the ground under the airplane
  FOG.y = 3 / vis;
  // The sky through the fog overhead; the horizon is fog all the way inside it.
  const over = Math.max(0, FOG.x - camera.position.y), tUp = Math.exp(-FOG.y * over);
  u.hor.value.copy(SKY).lerp(FOG_GREY, over > 0 ? 1 : 0.6);
  u.zen.value.copy(SKY_ZEN).lerp(FOG_GREY, 1 - tUp);
  // Sunlight through the layer: no shadows under thick fog, light all diffuse.
  const tSun = Math.exp(-FOG.y * top / SUN_DIR.y);
  sun.intensity = 0.6 * tSun; ambient.intensity = 0.58 + 0.42 * (1 - tSun);
}
// Transmission of a line of sight from the camera to a point (scene coords) through the layer.
function fogTransmission(x, y, z) {
  if (!FOG.y) return 1;
  const c = camera.position, lo = Math.min(c.y, y), hi = Math.max(c.y, y);
  const inside = hi - lo > 0.01 ? clamp((FOG.x - lo) / (hi - lo), 0, 1) : (lo < FOG.x ? 1 : 0);
  return Math.exp(-FOG.y * Math.hypot(x - c.x, y - c.y, z - c.z) * inside);
}

// ---------- Landmark labels ----------
// [name, east, north, height above the ground, ground elevation, max distance]:
// the city's landmarks, the home field, and the other airports from afar.
let labelPts = [];
function buildLabels() {
  labelPts = [...LANDMARKS.filter(([n]) => n !== AP.name).map(([n, x, y]) => [n, x, y, 60, groundAt(x, y), 14000]),
    [AP.name, rwMid[0], rwMid[1], 40, ELEV, 14000],
    ...DESTS.map((d, i) => [`${d.name} · ${d.icao}`, ...fieldCentre(REGION[i]).slice(0, 2), 80, REGION[i].elevation, i < REGION_N ? 90000 : Infinity])
      .filter((l) => l[0].split(' · ')[1] !== AP.icao)];
}
buildLabels();
const v = new THREE.Vector3();
// In the cockpit a label hides behind the panel, glareshield and frames: a
// short ray from the eye toward it against the flight deck (refreshed every
// few frames; the deck is a few metres across, so the ray stops at 8 m).
const occRay = new THREE.Raycaster(), occDir = new THREE.Vector3(), occluded = new Map();
let occFrame = 0;
function drawLabels() {
  const w = innerWidth, h = innerHeight;
  lctx.clearRect(0, 0, w, h);
  if (ui.cam === 1 && innerHeight < 500) return;
  const inside = ui.cam === 1, refresh = inside && (occFrame++ % 6 === 0);
  occRay.far = 8;
  lctx.font = `600 ${MOBILE ? 11 : 12}px "Public Sans",system-ui,sans-serif`;
  lctx.textAlign = 'center';
  for (const [name, x, y, up, base, far] of labelPts) {
    const dist = Math.hypot(x - s[0], y - s[1]);
    if (dist > far || dist < 150) continue;
    v.set(x, base + up, -y).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
    if (inside) {
      if (refresh || !occluded.has(name)) {
        occDir.set(x, base + up, -y).sub(camera.position).normalize();
        occRay.set(camera.position, occDir);
        occluded.set(name, occRay.intersectObject(cabin.root, true).length > 0);
      }
      if (occluded.get(name)) continue;
    }
    const fogT = fogTransmission(x, base + up, -y);
    if (fogT < 0.05) continue;  // lost in the fog
    const px = (v.x + 1) / 2 * w, py = (1 - v.y) / 2 * h;
    const a = clamp(1.4 - dist / 10000, 0.35, 1) * Math.min(1, fogT * 1.5);
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
  const plain = [];  // this frame's other events, one toast between them
  for (const e of A.events()) {
    if (e.startsWith('Touchdown')) {
      const fpm = Math.abs(+(e.match(/(-?\d+) fpm/)?.[1] || 0));
      toast(fpm > 600 ? `Hard landing: ${fpm} fpm` : fpm > 300 ? `Touchdown: ${fpm} fpm, firm` : `Touchdown: ${fpm} fpm, smooth`);
    } else if (/tail/.test(e)) {
      toast('Tail strike! Rotate less steeply.', 3);
    } else if (e.startsWith('GEAR COLLAPSE')) {
      toast(`${e.replace('GEAR COLLAPSE', 'Landing gear collapsed')}: the airframe is on its belly.`, 4);
    } else if (e.startsWith('PROPELLER STRIKE') || e.startsWith('Airframe ground contact') || e.startsWith('Building strike') || e.startsWith('STRUCTURAL FAILURE')) {
      ui.crashed = true; impact(); toast(crashReport(e.startsWith('STRUCTURAL FAILURE') ? `${e}: past the ultimate load` : e), 1e9);
    } else if (/^(Generator \d|Alternator) online$/.test(e)) {
      // Expected while the Quick Start brings the engines up; worth a word otherwise.
      if (A.procedure().status !== 1) plain.push(e);
    } else if (e === 'Battery depleted') {
      plain.push('Battery depleted: the bus is dead until a generator comes on line');
    } else if (!e.includes(' -> ')) plain.push(e);
  }
  if (plain.length) toast(plain.join(' · '), 3.5 + plain.length);
  if (s[48] && !ui.crashed) { ui.crashed = true; impact(); toast(crashReport('The airplane is damaged beyond flight'), 1e9); }
}
// The crash dummy in the pilot's seat: its readings against the seat test
// limits (14 CFR 23.562 / 25.562: HIC 1,000, lumbar load 1,500 lbf) and a
// spinal DRI of 18 (about a 5 % risk of spinal injury).
function crashReport(cause) {
  if (!A.occupant) return `${cause}. Press R to restart.`;
  const o = A.occupant(), lbf = o.lumbarN / 4.448;
  const over = [o.hic > 1000 && 'head', lbf > 1500 && 'lumbar spine', o.dri > 18 && 'spine'].filter(Boolean);
  const verdict = over.length ? `beyond the limits (${over.join(', ')})` : 'within the seat test limits';
  return `${cause}. Crash dummy, pilot's seat: ${o.peakG.toFixed(1)} g peak · spine DRI ${o.dri.toFixed(1)} (limit 18) · lumbar ≈ ${Math.round(lbf).toLocaleString('en-US')} lbf (limit 1,500) · HIC ${Math.round(o.hic)} (limit 1,000): ${verdict}. Press R to restart.`;
}

// ---------- Airflow view ----------
const FLOW = ['Airflow', 'Airflow: on', 'Wind tunnel', 'Smoke'];
ui.flow = 0;
const STUDIO = new THREE.Color('#dde1e6');  // wind tunnel: a plain light backdrop, as CFD renders are shown
function cycleFlow() {
  ui.flow = (ui.flow + 1) % 4;
  if (ui.flow === 3 && !smoke.ok) { ui.flow = 0; toast('Smoke needs WebGL2 with float render targets, which this browser does not offer.', 4); }
  flow.group.visible = ui.flow > 0;
  smoke.group.visible = ui.flow === 3;
  flow.reset();
  smoke.reset();
  $('bFlow').textContent = FLOW[ui.flow];
  $('bFlow').setAttribute('aria-pressed', String(ui.flow > 0));
  $('flowLegend').hidden = ui.flow === 0;
  $('flowLegend').classList.toggle('smoke', ui.flow === 3);
  const tunnel = ui.flow === 2;
  scene.background = tunnel ? STUDIO : SKY;
  scene.fog.color.copy(tunnel ? STUDIO : SKY);
  skyDome.visible = !tunnel;
  city.group.visible = showCity && !tunnel;
  if (ui.flow === 1) toast('Airflow: streamlines through the field the physics is making, coloured by local speed (grey: undisturbed). Orbit camera recommended (C).', 5);
  if (tunnel) toast('Wind tunnel: the world fades so the flow stands out. V again for smoke.', 4);
  if (ui.flow === 3) toast('Smoke: from the wingtips, the trailing edge and the engines. It stays in the air, winds into the tip vortices, sinks with them and drifts with the wind. Orbit camera (C).', 6);
}
$('bFlow').addEventListener('click', (e) => { cycleFlow(); e.currentTarget.blur(); });
$('slowR').addEventListener('input', (e) => { setSlow(+e.target.value); e.target.blur(); });

// ---------- Aircraft selection ----------
let loadSheet = null;
function applyProfileUi() {
  document.querySelectorAll('[data-aircraft]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aircraft === P.id)));
  $('lMixLbl').textContent = P.turboprop ? 'PROP' : P.jet ? 'SPD BRK' : 'MIX';
  document.querySelector('[data-fail="fuel"]').textContent = P.jet ? 'Engine 1 cut-off' : 'Fuel shutoff';
  document.querySelector('[data-fail="fuel"]').title = P.turboprop ? 'Engine 1\'s condition lever to CUT-OFF: fuel off, the engine runs down (feather it: Feather 1)'
    : P.jet ? 'Engine 1\'s fuel control switch to CUTOFF' : 'Close the fuel shutoff valve: the engine runs on the fuel in the lines, then quits';
  // .jetonly: the jets and the King Air; .fanonly: the turbofan jets; .tponly: the turboprop.
  document.querySelectorAll('.jetonly').forEach((el) => { el.hidden = !P.jet; });
  document.querySelectorAll('.fanonly').forEach((el) => { el.hidden = !P.jet || !!P.turboprop; });
  document.querySelectorAll('.tponly').forEach((el) => { el.hidden = !P.turboprop; });
  document.querySelectorAll('.pistononly').forEach((el) => { el.hidden = P.jet; });
  document.body.classList.toggle('jet', P.jet);
  applyAttitudeRef();
  document.body.classList.toggle('g1000', ui.glass && !P.jet);
  document.querySelectorAll('[data-panel172]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.panel172 === 'g1000') === ui.glass)));
  applyInstrSize();  // the jet's strip is taller; each aircraft keeps its own size
  $('plateSub').textContent = `Flight test bed · ${P.name}`;
  loadSheet = mountLoadSheet($('loadPanel'), { A, id: P.id, jet: P.jet, store, onApply: () => { restart(ui.start); toast('Restarted with the planned load.', 2); } });
  document.title = `Flight Test Bed · ${P.name}`;
}
async function selectAircraft(id) {
  if (P.id === id) return;
  const next = PROFILES[id];
  try {
    const json = await fetchDef(next);
    // A slow first load (a turboprop's propellers): say so, and let the page paint it first.
    if (SLOW_LOAD(next)) {
      loadMsg(SLOW_LOAD(next)); $('loading').hidden = false; $('loading').style.display = '';
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));
    }
    try { loadInto(json); } finally { $('loading').hidden = true; $('loading').style.display = 'none'; }
    city.resyncPhysics();  // the core was rebuilt without its buildings
    applyVisual(next, def);
    A.avd_set_wind_hazard(+$('hazard').value);  // a new aircraft starts a fresh sim
    applyFront();  // (and its weather: the restart applies the rest)
    buildIceSwitches();
  } catch (e) { toast('Could not load the aircraft: ' + e.message, 6); return; }
  audio.stop();
  P = next;
  store.set('aircraft', P.id);
  try { history.replaceState(null, '', hashFor(P)); } catch { /* sandboxed */ }
  audio = audioFor(P);
  if (ui.sound) audio.start();
  useRig(P);
  flow.reset();
  look.dist = P.chase;
  STARTS = startsFor();
  buildStarts();
  applyProfileUi();
  setAssist(ui.assist);
  setLevel(ui.level, false);
  ui.paused = false;
  restart(0);
  sizePanel();
}
document.querySelectorAll('[data-aircraft]').forEach((b) => b.addEventListener('click', () => { selectAircraft(b.dataset.aircraft); b.blur(); }));

// ---------- Loop ----------
buildIceSwitches();
applyFront();
applyProfileUi();
setAssist(ui.assist);
setLevel(ui.level, false);
restart(0);
$('loading').hidden = true;
$('loading').style.display = 'none';
const clock = new THREE.Clock();
let cabinT = 1, swT = 1;
const sw = { bat: 1, alt: 1, avionics: 1, beacon: 0, land: 0, taxi: 0, nav: 0, strobe: 0, pitot: 0, mags: 3, flaps: 0, fuelSel: 1 };
function readSwitches() {
  const p = Object.fromEntries(A.cockpit().map((x) => [x.id, x.position]));
  Object.assign(sw, {
    bat: p['electrical.battery'], alt: p['electrical.alternator'], avionics: p['electrical.avionics'],
    beacon: p['electrical.load.beacon'], land: p['electrical.load.landing_light'], taxi: p['electrical.load.taxi_light'],
    nav: p['electrical.load.nav_lights'], strobe: p['electrical.load.strobes'], pitot: p['electrical.load.pitot_heat'],
    mags: p['engine1.ignition'], flaps: p['flaps.lever'], fuelSel: p['fuel.selector'], pos: p,
  });
  document.querySelectorAll('[data-icectl]').forEach((b) => b.setAttribute('aria-pressed', String(!!p[b.dataset.icectl])));
  if (P.turboprop) {
    $('bAutofeather').setAttribute('aria-pressed', String(!!p['propeller.autofeather']));
    document.querySelectorAll('[data-feather]').forEach((b) => b.setAttribute('aria-pressed', String(!!tp?.engines[+b.dataset.feather]?.feather)));
  }
}
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!document.hidden) adaptRes(dt);
  crashFx.update(dt);
  const S = SLOWS[ui.slow], running = !ui.paused && !ui.crashed;
  const simDt = running ? dt / S : 0;
  if (running) {
    readInputs(dt);
    // Parking brake: Easy releases it for you when you open the throttle.
    if (s[49] && s[28] && input.throttle > 0.35) {
      if (ui.assist === 0) { setControl('brakes.parking', 0); toast('Parking brake released.', 2); }
      else if (!parkHint) { parkHint = true; toast('The parking brake is set: P releases it.'); }
    }
    // The stick takes over from the autoland.
    if (autoland && (Math.abs(input.pitch) > 0.5 || Math.abs(input.roll) > 0.5)) setAutoland(false, 'Autoland disconnected: you have the controls.');
    if (ap.on && (Math.abs(input.pitch) > 0.5 || Math.abs(input.roll) > 0.5)) setAutopilot(false, 'Autopilot disconnected: you have the controls.');
    // The reverse levers (N held, or REV): up over half a second, the core
    // deploys them at idle on the main wheels.
    // A turboprop's power levers below idle: N to full reverse (0.4 to 1),
    // Shift+N to ground beta alone (0 to 0.4, the blades at the reverse stop at idle Ng).
    if (P.jet && A.setReverse) {
      const want = keys.has('reverse') || touch.rev ? 1 : keys.has('beta') ? 0.4 : 0;
      reverse += clamp(want - reverse, -dt * 2, dt * (P.turboprop ? 1 : 2));
      A.setReverse(reverse);
      if (want && !revHint && s[28] && reverse > Math.min(want, 0.4) - 0.01) {
        const why = reverseBlocked();
        if (why) { revHint = true; toast(`Reverse thrust: ${why}.`, 3); }
      }
      if (!want) revHint = false;
    }
    A.avd_set_input(input.pitch, input.roll, input.yaw, input.throttle, input.mixture, input.brake, input.brake, input.trimRate, input.starter);
    if (input.levers) { A.setThrottle(0, input.levers[0]); A.setThrottle(1, input.levers[1]); }  // set_input rejoined them
    A.avd_advance(simDt);
    if (ap.on) {
      const st = A.autopilotStatus(), was = apStatus.apr || 0;
      if (st.apr === 4 && was !== 4) onMinimums(st);
      else if (st.lateral === 4 && st.apr === 2 && was < 2) toast(`${st.aprSource === 'gps' ? 'LNAV: the final course' : 'LOC'} captured; ${st.aprSource === 'gps' ? 'LPV glidepath' : 'glideslope'} armed.`, 3);
      else if (st.lateral === 4 && st.apr === 3 && was < 3) toast(`${st.aprSource === 'gps' ? 'Glidepath' : 'Glideslope'} captured: down to the DA, ${fmt(st.daFt)} ft.`, 3);
      if (!st.on) setAutopilot(false, st.apr === 4 ? 'MINIMUMS — AP DISCONNECT: you have the airplane.' : s[28] ? 'Autopilot off: on the ground.' : 'Autopilot off.');
      else {
        if (st.vertical === 2 && apStatus.vertical === 4) toast(`Autopilot: level at ${fmt(st.altFt)} ft.`, 2.5);
        apStatus = st;
        // The glideslope coupled (5) keeps the mode the pilot gave (re-sending it keeps the capture).
        if (st.vertical <= 4 && st.apr !== 4) ap.vert = st.vertical === 4 ? 3 : st.vertical;
        if (st.apr === 4) { ap.lat = 0; ap.vert = 0; apUi(); }
      }
    }
    // The autoland or the autothrottle flies the throttle: the levers on screen follow it.
    if (autoland || (ap.on && ap.at)) { input.throttle = clamp(A.state()[24], 0, 1); input.levers = null; }
    if (autoland) {
      const st = A.autolandStatus();
      if (!st.on) { autoland = false; handBackThrottle(); $('bAutoland').setAttribute('aria-pressed', 'false'); }
      else {
        if (st.phase !== alStatus.phase && st.phase === 4) toast('Autoland: stopped on the runway. You have the controls when you want them (U).', 4);
        alStatus = st;
      }
    }
  }
  s = A.state().slice(); c = A.cockpitState().slice(); j = A.jet().slice();
  tp = P.turboprop ? A.turboprop() : null;
  wx = A.weather ? A.weather() : null; icing = A.icing ? A.icing() : null; att = A.attitude ? A.attitude() : null;
  readTaws();
  if (P.jet) landingRollCallouts();
  // The propeller's blade angle (about the thrust axis, right-handed; the
  // flow view's blades and tip vortices use the same angle).
  const spin = P.jet ? 0 : (def.engines?.[0]?.clockwise_from_behind === false ? -1 : 1);
  propPhase = (propPhase + spin * s[19] * Math.PI / 30 * simDt) % (2 * Math.PI);
  if (!ui.paused && dt > 0) {
    const a = clamp((c[K.ias] - lastIas) / dt, -15, 15);
    iasAcc += (a - iasAcc) * (1 - Math.exp(-dt / 1.2));
  }
  lastIas = c[K.ias];
  handleEvents();
  // Airplane pose: datum position and body FLU → ENU attitude.
  acGroup.position.copy(enu(s[0], s[1], s[2]));
  // In slow motion the 240 Hz physics steps come seconds apart on screen:
  // carry the aircraft along its velocity between them.
  simClock += simDt;
  if (s[42] !== stepT) {
    const p = enu(s[0], s[1], s[2]);
    if (stepPos && s[42] > stepT && s[42] - stepT < 0.05) stepVel.copy(p).sub(stepPos).divideScalar(s[42] - stepT);
    else stepVel.set(0, 0, 0);
    stepPos = p; stepT = s[42];
  }
  const lag = simClock - s[42];
  if (lag < 0 || lag > 0.02) simClock = s[42];
  else if (S > 1) acGroup.position.addScaledVector(stepVel, lag);
  acGroup.quaternion.copy(qM).multiply(qBody.set(s[4], s[5], s[6], s[3]));
  const collapsed = A.occupant ? A.occupant().collapsed : null;
  // A turboprop's propellers: Np (the gauges read 0 without bus power: then
  // the core's engine 1 truth for both) and the blade angle.
  const props = tp ? tp.engines.map((e) => ({ np: tp.powered ? e.np : s[19], blade: e.blade })) : null;
  if (P.jet) aircraft.update({ flapDeg: s[26], aileron: s[45], elevator: s[46], rudder: s[47], n1: [j[8], j[16]], gear: j[1], speedbrake: j[3],
    lights: tp ? tp.engines.some((e) => e.running) : !!(j[13] || j[21]), reverser: [j[52], j[54]], props: ui.paused ? props?.map((p) => ({ ...p, np: 0 })) : props,
    disc: ui.cam === 1 ? 0.2 : 1, collapsed, slow: S }, simDt);
  else aircraft.update({ flapDeg: s[26], aileron: s[45], elevator: s[46], rudder: s[47], rpm: ui.paused ? 0 : s[19], disc: ui.cam === 1 ? 0.15 : 1, phase: propPhase, collapsed, slow: S }, simDt);
  if (ui.flow) {
    acGroup.updateMatrixWorld(true);
    const wk = A.wake();
    wk.seg = wk.seg.slice();  // a copy: later calls may move the module's memory
    const bd = A.bodies();
    bd.b = bd.b.slice(0, bd.n * 10);
    const fl = A.flow();
    const fdt = ui.paused ? 0 : dt;
    const fr = flow.update(fl, fdt, { ...P, span: def.reference.span_m },
      { light: ui.flow === 2, windGrid: A.windGrid, wake: wk, bodies: bd, inv: invM.copy(acGroup.matrixWorld).invert(), lines: ui.flow !== 3, ground: groundPlane(wk.ground),
        slow: S, prop: { phase: propPhase, resolved: !P.jet && s[19] * Math.PI / 30 / S < 0.6 } });
    // Smoke runs on the simulation's clock (it may run behind the wall clock).
    const sdt = simDt;
    if (ui.flow === 3) smoke.update(fl, sdt, acGroup, wk, A.windBox, s, { camera, bodies: bd, slow: S, length: P.fuse.xNose - P.fuse.xTail,
      prop: P.jet ? null : { phase: propPhase, blades: def.engines[0].propeller.blades || 2, radius: def.engines[0].propeller.diameter_m / 2, resolved: s[19] * Math.PI / 30 * simDt < 0.6 }, turbulence: +$('turb').value + [0, 0.8, 1.6, 3.2][+$('turbClass').value || 0] });
    $('flowStall').textContent = fr.stalled ? `${fr.stalled} strip${fr.stalled > 1 ? 's' : ''} stalled` : 'no stalled strips';
  }
  acGroup.updateMatrixWorld(true);
  updateCamera(dt);
  weatherFx(simDt);
  if (showCity && ui.flow !== 2) city.update(s[0], s[1], Math.max(0, s[14] * 0.3048), scene.fog.far);
  {
    const ce = camera.position.x, cn = -camera.position.z;
    // No ground past the fog: it would be all fog colour.
    ground.update(ce, cn, Math.max(0, camera.position.y - groundAt(ce, cn)), Math.min(scene.fog.far, camera.far), 2, s[0], s[1], Math.max(0, s[14] * 0.3048));
  }
  renderer.render(scene, camera);
  showCost(dt);
  drawLabels();
  $('warn').classList.toggle('on', c[K.stall] > 0.5 && !ui.crashed);
  hud();
  panelT += dt; cabinT += dt; swT += dt;
  if (swT > 0.2) { swT = 0; readSwitches(); checkPrompts(); }
  if (P.jet) {
    cabin.update({ elev: s[46], ail: s[45], rud: s[47], thr: input.throttle, levers: P.turboprop ? [leverPos(0), leverPos(1)] : [j[58], j[59]], prop: input.prop, spd: j[4] / 2, flapLever: sw.flaps, gearDown: !!j[2], pos: sw.pos });
    if (ui.cam === 1 && cabinT > 1 / 20) { cabinT = 0; cabin.redraw(jetData()); }
  } else {
    cabin.update({ elev: s[46], ail: s[45], rud: s[47], trim: s[27], thr: input.throttle, mix: input.mixture, flapLever: sw.flaps, fuelSel: sw.fuelSel, shutoff: sw.pos?.['fuel.shutoff'], park: s[49] });
    if (ui.cam === 1 && cabinT > 1 / 30) { cabinT = 0; cabin.redraw(c, M, sw, s, c[K.compass], ui.glass ? g1000Data() : null); }
  }
  if (ui.instr && ui.cam !== 1 && panelT > 1 / 30) {
    panelT = 0;
    const r = panelCv.getBoundingClientRect();
    if (P.jet) drawJetStrip(pctx, r.width, r.height, jetData());
    else if (ui.glass) drawG1000(pctx, r.width, r.height, g1000Data());
    else drawPanel(pctx, r.width, r.height, c, M, panelLayout);
  }
  // After a crash, once its sound has played: the engines, the wind, the
  // roll and the horn fall silent until the restart.
  const hush = ui.paused || S > 1 || crashHeard;
  if (tp) audio.update(hush ? null : tp.engines.map((e) => ({ ng: e.ng, np: tp.powered ? e.np : s[19], torque: e.torque, beta: e.beta })), crashHeard ? 0 : s[11], c[K.stall] > 0.5 && !crashHeard, ui.cam === 1);
  else if (P.jet) audio.update(hush ? [0, 0] : [j[8], j[16]], hush ? [0, 0] : [j[9], j[17]], crashHeard ? 0 : (j[12] + j[20]) / 150, crashHeard ? 0 : j[26], c[K.stall] > 0.5 && !crashHeard, ui.cam === 1);
  else audio.update(hush ? 0 : s[19], s[20], crashHeard ? 0 : s[11], c[K.stall] > 0.5 && !crashHeard, ui.cam === 1);
  audio.extras({
    tas: s[11], gs: s[12], vs: s[15], nz: s[18], flapDeg: s[26], flapMax: P.jet ? j[50] : 30,
    gear: P.jet ? j[1] : 1, retractable: !!P.jet, spoiler: P.jet ? Math.max(j[3], j[56] ? 1 : 0) : 0,
    onGround: !!s[28], stalled: s[43], rev: tp ? (tp.engines.some((e) => e.beta) ? clamp((reverse - 0.4) / 0.6, 0, 1) * 0.6 : 0) : P.jet ? (j[52] + j[54]) / 2 : 0, crashed: !!ui.crashed,
    cabin: ui.cam === 1, paused: ui.paused || S > 1 || crashHeard,
  });
  crashHeard = ui.crashed && audio.on;  // the update that fired the crash sound has run
  if (toastT > 0 && (toastT -= dt) <= 0) toastEl.classList.remove('on');
}
requestAnimationFrame(frame);
// For checks (?debug): the core, the drawn ground and the page's state.
if (/[?&]debug\b/.test(location.search)) window.__fly = { A, ground, FINE, get s() { return s; }, get j() { return j; }, get c() { return c; }, input, ui, ap, keys, get P() { return P; }, get autoland() { return autoland; }, get model() { return aircraft; }, look, restart, setControl, prompts: () => promptList(() => false) };
