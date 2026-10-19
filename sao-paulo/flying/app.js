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
import { buildCabin } from './cabin.js';
import { buildJetCabin } from './jetcabin.js';
import { FlightAudio, JetAudio } from './audio.js';
import { buildIndex, searchAirports } from './airportsearch.js';
import { buildFlow } from './flow.js';
import { buildSmoke } from './smoke.js';
import { mountLoadSheet } from './loadsheet.js';

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
let A, def, M;
function loadInto(json) {
  const errors = A.load(json);
  if (errors.length) throw new Error(errors.join('; '));
  def = JSON.parse(json);
  M = markingsFrom(A.markings());
}
const hashFor = (p) => (p.id === 'c172' ? '#172' : `#${p.id}`);
try {
  const [mod, json] = await Promise.all([createAvdModule(), fetchDef(P)]);
  A = mod;
  A.avd_set_airport(AIRPORT);  // before the first load: every reset uses it
  loadInto(json);
  applyVisual(P, def);
} catch (e) {
  loadMsg('The flight core could not start: ' + e.message);
  throw e;
}
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
// elevation, the terrain between blended. One mesh out to ~100 km on a 1 km
// grid aligned with the map, with a hole where the map is; the map itself on a
// 500 m grid, both following the same heights.
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
// Rebuilt when a destination beyond the region joins the ground: it shifts
// the blend everywhere a little, and gets ground of its own (a 1 km patch
// around it, and a coarse corridor from the region to it).
const terrain = new THREE.Group();
scene.add(terrain);
const groundMat = new THREE.MeshLambertMaterial({ color: '#77796f' });
const farMat = new THREE.MeshLambertMaterial({ color: '#77796f', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const mapMat = new THREE.MeshLambertMaterial({ color: '#ffffff', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
const TN = 104;  // km of terrain beyond the map on each side
const inMain = (e, n) => e > MX0 - TN * 1000 && e < MX1 + TN * 1000 && n > MY0 - TN * 1000 && n < MY1 + TN * 1000;
function buildTerrain() {
  for (const m of [...terrain.children]) { m.geometry.dispose(); terrain.remove(m); }
  const inMap = (e, n) => e > MX0 && e < MX1 && n > MY0 && n < MY1;
  terrain.add(heightMesh(MX0 - TN * 1000, MY0 - TN * 1000, (MX1 - MX0) / 1000 + 2 * TN, (MY1 - MY0) / 1000 + 2 * TN, 1000, inMap, groundMat, 0.3));
  const map = heightMesh(MX0, MY0, (MX1 - MX0) / 500, (MY1 - MY0) / 500, 500, null, mapMat, 0.05);
  map.receiveShadow = true;
  terrain.add(map);
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
new THREE.TextureLoader().load(MOBILE ? '../img/mosaic_world_sm.jpg' : '../img/mosaic_world.jpg', (t) => {
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  mapMat.map = t; mapMat.needsUpdate = true;
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
  const rw = new THREE.Mesh(new THREE.PlaneGeometry(wid, len),
    new THREE.MeshLambertMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  rw.rotation.set(-Math.PI / 2, 0, -hdg * DEG);
  rw.position.copy(enu(e0 + Math.sin(hdg * DEG) * len / 2, n0 + Math.cos(hdg * DEG) * len / 2, elev + 0.02));
  rw.receiveShadow = true;
  parent.add(rw);
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
  farFields.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
  farFields.clear();
  for (let i = REGION_N; i < REGION.length; ++i) drawField(i, farFields);
}
buildTerrain();
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
    const cab = p.jet ? buildJetCabin({ mobile: MOBILE, maxAniso, skin: model.skin || jetSkin, scale: def.visual?.nose_scale || 1 })
      : buildCabin({ mobile: MOBILE, maxAniso });
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
let propPhase = 0, simClock = 0, stepPos = null, stepT = 0, stepVel = new THREE.Vector3();
const input = { pitch: 0, roll: 0, yaw: 0, throttle: 0.1, mixture: 1, brake: 0, trimRate: 0, starter: 0 };
let trimPulse = null;  // { rate, until }: the cockpit's trim wheel turned by hand
let s = new Float64Array(64), c = new Float64Array(96), j = new Float64Array(64);
let lastIas = 0, iasAcc = 0;  // speed trend (kt/s, filtered)
const failed = { fuel: false, 0: false, 1: false, 2: false, 3: false };
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
  const base = P.jet ? JET_STARTS : PISTON_STARTS;
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
  A.avd_set_weather(kt * 0.5144, dir, turb, temp, 0.6);
  A.avd_set_wind_detail(+$('turbClass').value, +$('thermals').value, 1500);
  A.avd_set_runway_water(+$('rwyWater').value);
  ui.vis = +$('vis').value || 0;
  $('visNote').hidden = !ui.vis;
  $('visNote').textContent = ui.vis >= 2 ? `${VIS_NOTES[ui.vis]} For an approach: Flight → Destination, pick a runway, then start on its approach.` : VIS_NOTES[ui.vis];
  $('windV').textContent = kt ? `${kt} kt` : 'calm';
  $('windDirV').textContent = `${String(dir).padStart(3, '0')}°`;
  $('turbV').textContent = turb ? `${turb.toFixed(1)} m/s` : 'none';
  $('tempV').textContent = temp ? `ISA ${temp > 0 ? '+' : '−'}${Math.abs(temp)} °C` : 'ISA';
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

function restart(i = ui.start) {
  ui.start = i;
  smoke.reset();
  if (!STARTS[i]) ui.start = i = 0;
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
  if (i === 0 && P.jet) {
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
    case 'KeyT': setSlow(ui.slow + (e.shiftKey ? -1 : 1)); break;
    case 'KeyK': A.avd_ai_cage(); toast(P.jet ? 'Attitude reference re-aligned (do it wings level).' : 'Attitude indicator caged (do it wings level).', 2); break;
    case 'KeyF': A.avd_dg_sync(); toast(P.jet ? 'Heading re-synced to the magnetometer.' : 'Heading indicator set to the compass.', 2); break;
    case 'Semicolon': case 'Quote': {
      const step = (e.code === 'Quote' ? 1 : -1) * (e.shiftKey ? 1 : 5);
      A.avd_heading_bug((Math.round(c[K.bug]) + step + 360) % 360); break;
    }
    case 'KeyO': A.avd_altimeter_adjust(e.shiftKey ? -1 : 1); break;
    case 'KeyC': cycleCam(); break;
    case 'KeyI': toggleInstr(); break;
    case 'KeyR': restart(); break;
    case 'KeyH': togglePanel(); break;
    case 'KeyL': setLevel(!ui.level, true); break;
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
// Status after the assist mode: auto-trim state, and Q/E on the tiller.
function assistStatus() {
  const lvl = !ui.level ? '' : s[58] ? ' · TOO SLOW' : s[55] ? ' · HOLDING LEVEL' : ' · AUTO-TRIM';
  return ASSIST[ui.assist] + lvl + (s[56] ? ' · TILLER' : '');
}

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
  requestAnimationFrame(sizePanel);
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
let revPhaseWas = 0, gndSpWas = 0;
function landingRollCallouts() {
  const ph = j[53] | 0, gs = j[56] | 0;
  if (gs !== gndSpWas) toast(gs ? 'Ground spoilers deployed.' : 'Ground spoilers stowed.', 2);
  if (ph !== revPhaseWas) {
    if (ph === 1) toast('Thrust reversers deploying: reverse thrust.', 2.5);
    else if (ph === 2) toast('60 knots: reverse idle.', 2);
    else if (ph === 3) toast('Thrust reversers stowing.', 2);
  }
  revPhaseWas = ph; gndSpWas = gs;
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
    for (const t of p.throttles || []) mesh(t, lever(() => input.throttle, (v) => { input.throttle = v; }, 'Thrust levers'));
    mesh(p.spd, stepper('speedbrake.lever'));
    mesh(p.flap, stepper('flaps.lever'));
    mesh(p.gear, { label: () => `${named('gear.lever')} · click to move the handle`, down: () => toggleGear() });
    for (const w of p.switches || []) mesh(w.g, switcher(w.id));
    for (const w of p.fuelSw || []) mesh(w.g, switcher(w.id));
    mesh(p.park, switcher('brakes.parking'));
    mesh(p.hdgKnob, { label: () => `Heading bug ${String(Math.round(c[K.bug])).padStart(3, '0')}° · scroll to turn, click to sync to the heading`,
      wheel: (n) => A.avd_heading_bug((Math.round(c[K.bug]) + n + 360) % 360), down: () => A.avd_heading_bug(Math.round(s[9]) % 360) });
    mesh(p.baroKnob, { label: () => `Altimeter ${c[K.kollsman].toFixed(2)} inHg · scroll to set`, wheel: (n) => A.avd_altimeter_adjust(n) });
  } else {
    mesh(p.throttle, lever(() => input.throttle, (v) => { input.throttle = v; }, 'Throttle'));
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
      const r = PANEL_SPOTS.find((q) => u >= q.u && u <= q.u + q.w && v >= q.v && v <= q.v + q.h);
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
function applyInstrSize() {
  const el = $('instr'), z = store.get('instrSize.' + P.id, null);
  if (z && z.w > 0 && z.h > 0) {
    el.style.width = `${Math.round(Math.min(z.w, innerWidth - 24))}px`;
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
    const w = clamp(start.w + 2 * start.side * (e.clientX - start.x), 300, innerWidth - 24);
    const h = clamp(start.h + start.up * (start.y - e.clientY), 70, innerHeight * 0.85);
    $('instr').style.width = `${Math.round(w)}px`;
    document.body.style.setProperty('--instr-h', `${Math.round(h)}px`);
    sizePanel();
  });
  const end = () => {
    if (!start) return;
    start = null;
    const r = $('instr').getBoundingClientRect();
    store.set('instrSize.' + P.id, { w: Math.round(r.width), h: Math.round(r.height) });
  };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
  g.addEventListener('dblclick', () => { store.set('instrSize.' + P.id, null); applyInstrSize(); toast('Instrument panel: default size', 1.5); });
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
// Wind (smoothed by the core), ground track and drift, once moving.
const deg3 = (v) => String(Math.round(((v % 360) + 360) % 360) || 360).padStart(3, '0');
function windRows() {
  const rows = [['Wind', s[60] >= 1 ? `${deg3(s[59])}° / ${spd(s[60])}` : 'calm']];
  if (s[12] > 20 && !s[28]) rows.push(['Track · drift', `${deg3(s[61])}° · ${s[62] >= 0 ? 'R' : 'L'} ${fmt(Math.abs(s[62]))}°`]);
  if (s[63] > 0) rows.push(['Runway', s[63] >= 3 ? `standing water ${fmt(s[63])} mm` : 'wet']);
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
  $('hAssist').textContent = assistStatus();
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
  const rows = [
    ['Mach', j[5] > 0.2 ? fmt(j[5], 3) : '—'], ['Ground speed', spd(s[12])], ['Vertical', `${fmt(c[K.vsi])} fpm`],
    ['Heading', `${hdg}°`], ...windRows(), ['Above field', `${fmt(Math.max(0, s[14]))} ft`],
    ['N1 L / R', `${fmt(j[8], 1)} / ${fmt(j[16], 1)} %`], ['Fuel flow', `${fmt(j[7] * 2.20462 / 10) * 10 || 0} lb/h`],
    ['Fuel', `${fmt(j[6] * 2.20462)} lb`], ['Flaps', `${fmt(j[27])}°`], ['Gear', gear], ['Speedbrake', j[56] ? 'ground spoilers' : j[3] > 0.02 ? `${fmt(j[3] * 100)} %` : 'retracted'],
    ...(j[57] ? [['Reversers', j[52] > 0.02 ? ['', 'reverse thrust', 'reverse idle', 'stowing'][j[53] | 0] || `${fmt(j[52] * 100)} %` : 'stowed (auto)']] : []),
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
  const agl = Math.max(0, s[14]);
  return {
    ias: c[K.ias], alt: c[K.alt], baro: c[K.kollsman], vsi: c[K.vsi], pitch: c[K.aiPitch], roll: c[K.aiRoll], hdg: c[K.dg], bug: c[K.bug],
    ball: c[K.ball], stall: c[K.stall] > 0.5, mach: j[5], gs: s[12], tas: j[26], agl: Math.max(0, s[14]), vmo: j[25], mmo: j[24],
    assist: FMA[ui.assist] + (s[58] ? ' · UNDERSPD' : s[55] ? ' · ALT HDG HOLD' : ''), n1: [j[8], j[16]], n2: [j[9], j[17]], itt: [j[10], j[18]], ff: [j[11], j[19]], oil: [j[30], j[31]],
    run: [j[13], j[21]], starting: [j[14], j[22]], fuelSw: [j[15], j[23]], n1cmd: 22 + 78 * input.throttle,
    fuelKg: j[6], gear: j[1], spd: j[3], flaps: j[27], wow: j[29], park: s[49],
    x: s[0], y: s[1], trueHdg: s[9], runway: RW, airport: AP.icao, points: LANDMARKS,
    rangeNm: agl < 4000 ? 5 : agl < 15000 ? 10 : agl < 28000 ? 20 : 40,
    trend: iasAcc * 10, vs1g: j[32], vsTO: j[33], vsLDG: j[34], gw: j[35], fpa: j[36], drift: ((j[37] - s[9] + 540) % 360) - 180,
    windDir: s[59], windKt: s[60], ra: j[40], sat: j[41], nz: j[42], aoa: j[43], gen: j[44], volts: j[45],
    vfe: j[47], vle: j[48], toFlap: j[49], ldgFlap: j[50], trim: j[28], thrLever: input.throttle, crashed: ui.crashed, pusher: !!j[51],
    rev: [j[52], j[54]], gndSpoilers: !!j[56], typeName: def.visual?.short_name || 'TOP G',
    // Navigation: the GPS route and leg, the destination runway, NAV 1.
    route: DEST ? A.route() : null, gps: DEST ? A.gps().slice() : null, dest: DEST,
    destRunway: DEST ? REGION[DEST.ai].ends[DEST.ri] : null,
    nav: { valid: !!c[K.navValid], loc: !!c[K.loc], cdi: c[K.cdi], gsValid: !!c[K.gsValid], gs: c[K.gs], mhz: c[K.navAct] },
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
  else { scene.fog.near = 2500 + agl * 3; scene.fog.far = 22000 + agl * 12; }
  updateFogLayer();
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
  $('lMixLbl').textContent = P.jet ? 'SPD BRK' : 'MIX';
  document.querySelector('[data-fail="fuel"]').textContent = P.jet ? 'Engine 1 cut-off' : 'Fuel shutoff';
  document.querySelector('[data-fail="2"]').hidden = P.jet;
  document.querySelector('[data-fail="3"]').textContent = P.jet ? 'Generators' : 'Alternator';
  document.querySelectorAll('.jetonly').forEach((el) => { el.hidden = !P.jet; });
  document.querySelectorAll('.pistononly').forEach((el) => { el.hidden = P.jet; });
  document.body.classList.toggle('jet', P.jet);
  applyInstrSize();  // the jet's strip is taller; each aircraft keeps its own size
  $('plateSub').textContent = `Flight test bed · ${P.name}`;
  loadSheet = mountLoadSheet($('loadPanel'), { A, id: P.id, jet: P.jet, store, onApply: () => { restart(ui.start); toast('Restarted with the planned load.', 2); } });
  document.title = `Flight Test Bed · ${P.name}`;
}
async function selectAircraft(id) {
  if (P.id === id) return;
  const next = PROFILES[id];
  try {
    loadInto(await fetchDef(next));
    applyVisual(next, def);
    A.avd_set_wind_hazard(+$('hazard').value);  // a new aircraft starts a fresh sim
  } catch (e) { toast('Could not load the aircraft: ' + e.message, 6); return; }
  audio.stop();
  P = next;
  store.set('aircraft', P.id);
  try { history.replaceState(null, '', hashFor(P)); } catch { /* sandboxed */ }
  audio = P.jet ? audios.jet : audios.piston;
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
}
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!document.hidden) adaptRes(dt);
  const S = SLOWS[ui.slow], running = !ui.paused && !ui.crashed;
  const simDt = running ? dt / S : 0;
  if (running) {
    readInputs(dt);
    // Parking brake: Easy releases it for you when you open the throttle.
    if (s[49] && s[28] && input.throttle > 0.35) {
      if (ui.assist === 0) { setControl('brakes.parking', 0); toast('Parking brake released.', 2); }
      else if (!parkHint) { parkHint = true; toast('The parking brake is set: P releases it.'); }
    }
    A.avd_set_input(input.pitch, input.roll, input.yaw, input.throttle, input.mixture, input.brake, input.brake, input.trimRate, input.starter);
    A.avd_advance(simDt);
  }
  s = A.state().slice(); c = A.cockpitState().slice(); j = A.jet().slice();
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
  if (P.jet) aircraft.update({ flapDeg: s[26], aileron: s[45], elevator: s[46], rudder: s[47], n1: [j[8], j[16]], gear: j[1], speedbrake: j[3], lights: !!(j[13] || j[21]), reverser: [j[52], j[54]], slow: S }, simDt);
  else aircraft.update({ flapDeg: s[26], aileron: s[45], elevator: s[46], rudder: s[47], rpm: ui.paused ? 0 : s[19], disc: ui.cam === 1 ? 0.15 : 1, phase: propPhase, slow: S }, simDt);
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
  renderer.render(scene, camera);
  drawLabels();
  $('warn').classList.toggle('on', c[K.stall] > 0.5 && !ui.crashed);
  hud();
  panelT += dt; cabinT += dt; swT += dt;
  if (swT > 0.2) { swT = 0; readSwitches(); }
  if (P.jet) {
    cabin.update({ elev: s[46], ail: s[45], rud: s[47], thr: input.throttle, spd: j[4] / 2, flapLever: sw.flaps, gearDown: !!j[2], pos: sw.pos });
    if (ui.cam === 1 && cabinT > 1 / 20) { cabinT = 0; cabin.redraw(jetData()); }
  } else {
    cabin.update({ elev: s[46], ail: s[45], rud: s[47], trim: s[27], thr: input.throttle, mix: input.mixture, flapLever: sw.flaps, fuelSel: sw.fuelSel, shutoff: sw.pos?.['fuel.shutoff'], park: s[49] });
    if (ui.cam === 1 && cabinT > 1 / 30) { cabinT = 0; cabin.redraw(c, M, sw, s, c[K.compass]); }
  }
  if (ui.instr && ui.cam !== 1 && panelT > 1 / 30) {
    panelT = 0;
    const r = panelCv.getBoundingClientRect();
    if (P.jet) drawJetStrip(pctx, r.width, r.height, jetData());
    else drawPanel(pctx, r.width, r.height, c, M, panelLayout);
  }
  if (P.jet) audio.update(ui.paused || S > 1 ? [0, 0] : [j[8], j[16]], ui.paused || S > 1 ? [0, 0] : [j[9], j[17]], (j[12] + j[20]) / 150, j[26], c[K.stall] > 0.5, ui.cam === 1);
  else audio.update(ui.paused || S > 1 ? 0 : s[19], s[20], s[11], c[K.stall] > 0.5, ui.cam === 1);
  if (toastT > 0 && (toastT -= dt) <= 0) toastEl.classList.remove('on');
}
requestAnimationFrame(frame);
