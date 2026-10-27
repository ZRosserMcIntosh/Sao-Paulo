// São Paulo World — Wake Turbulence Lab.
// A 172 on final for 35L at Congonhas; a jet lined up on the wrong runway
// overtakes it just above and to one side, then goes around. Both are flown by
// Aviation Dynamics (WebAssembly, the flying page's build): the jet sheds its
// vortex-lattice wake, and the 172 flies through it. This page only draws.
import * as THREE from 'three';
import createAvdModule from '../flying/avd.mjs';
import { buildAircraft } from '../flying/model.js';
import { buildJet } from '../flying/jetmodel.js';
import { buildCabin } from '../flying/cabin.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEG = Math.PI / 180, FT = 0.3048, KT = 0.514444, NM = 1852;
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw-wake:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw-wake:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
const loadMsg = (m) => { $('loadMsg').textContent = m; };
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3000); }

// ---------- The cast ----------
// The jets: approach speed (kt) and a name for the radio.
const JETS = {
  b738: { name: 'Boeing 737-800', file: '../flying/b738.json', kias: 145, chase: 70 },
  crj700: { name: 'CRJ700', file: '../flying/crj700.json', kias: 140, chase: 55 },
  phenom300: { name: 'Phenom 300', file: '../flying/phenom300.json', kias: 120, chase: 40 },
  learjet45: { name: 'Learjet 45', file: '../flying/learjet45.json', kias: 130, chase: 40 },
  cj4: { name: 'Citation CJ4', file: '../flying/cj4.json', kias: 120, chase: 40 },
};
const KIAS172 = 65, START = 5000;  // the 172's final: 65 KIAS, 5 km before the threshold
const CALL172 = 'PT-WKE', CALLJET = 'Garoa 2737';  // fictional
const SCENES = [
  { id: 'miss', name: 'The near miss', sub: '20 m above, 20 m to the left, goes around late', set: { dh: 20, aside: 20, ga: 1900, xw: 0, turb: 0 } },
  { id: 'over', name: 'Straight over the top', sub: '20 m directly above: the downwash, not a roll', set: { dh: 20, aside: 0, ga: 1900, xw: 0, turb: 0 } },
  { id: 'drift', name: 'The crosswind brings it', sub: '45 m to the left, a 3 m/s crosswind carries the wake over', set: { dh: 15, aside: 45, ga: 1900, xw: -3, turb: 0 } },
  { id: 'early', name: 'Early go-around', sub: 'The crew spots it and climbs away right after passing', set: { dh: 20, aside: 20, ga: 200, xw: 0, turb: 0 } },
  { id: 'rough', name: 'In turbulent air', sub: 'Moderate turbulence breaks the vortices up sooner', set: { dh: 20, aside: 20, ga: 1900, xw: 0, turb: 2 } },
];
const cfg = Object.assign({ jet: 'b738', dh: 20, aside: 20, ga: 1900, xw: 0, turb: 0 }, store.get('cfg', {}));
let sceneId = store.get('scene', 'miss');

// ---------- Engine ----------
let A, json172;
const jsonCache = {};
const fetchText = async (f) => { if (!jsonCache[f]) { const r = await fetch(f); if (!r.ok) throw new Error(`${f} ${r.status}`); jsonCache[f] = await r.text(); } return jsonCache[f]; };
try {
  const [mod, j172] = await Promise.all([createAvdModule(), fetchText('../flying/172.json')]);
  A = mod;
  if (!A.avd_traffic_spawn) throw new Error('this flight core has no traffic (ABI ' + A.abiVersion + ')');
  json172 = j172;
  A.avd_set_airport(1);  // Congonhas, runway 35L
  const errors = A.load(json172);
  if (errors.length) throw new Error(errors.join('; '));
} catch (e) {
  loadMsg('The flight engine could not start: ' + e.message);
  throw e;
}
const def172 = JSON.parse(json172);
const RW = A.runway();  // [paved start east, north, elevation, true heading, length, width]
const ELEV = RW[2], HDG = RW[3];
const fwd = [Math.sin(HDG * DEG), Math.cos(HDG * DEG)];
const left = [-fwd[1], fwd[0]];

// ---------- Renderer & scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));  // lowered for lite (setQuality)
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const SKY = new THREE.Color('#9fb7cf');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 2500, 22000);
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 60000);
scene.add(new THREE.HemisphereLight('#dfe9f5', '#5a5848', 1.3));
const sun = new THREE.DirectionalLight('#fff3df', 2.2);
sun.position.set(-0.4, 1, 0.3);
scene.add(sun);
const enu = (e, n, u) => new THREE.Vector3(e, u, -n);

// The ground at the field's elevation, the runways of the region, and a
// city of blocks around Congonhas (it sits in the middle of São Paulo).
{
  const g = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000), new THREE.MeshLambertMaterial({ color: '#6d7564' }));
  g.rotation.x = -Math.PI / 2; g.position.copy(enu(RW[0], RW[1], ELEV - 0.3));
  scene.add(g);
  const tex = (() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 2048;
    const x = c.getContext('2d');
    x.fillStyle = '#3b3e42'; x.fillRect(0, 0, 64, 2048);
    x.fillStyle = '#e9ecef';
    for (let y = 120; y < 1928; y += 44) x.fillRect(31, y, 2, 24);         // centreline
    for (const y0 of [6, 2006]) for (let k = 0; k < 8; ++k) x.fillRect(5 + k * 7 + (k > 3 ? 4 : 0), y0, 4, 36);  // piano keys
    x.fillRect(2, 0, 1.5, 2048); x.fillRect(60.5, 0, 1.5, 2048);         // edges
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  })();
  const rwMat = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const done = new Set();
  const region = A.region();
  const corridors = [];
  for (const ap of region) for (const e of ap.ends) {
    const d = [Math.sin(e.heading * DEG), Math.cos(e.heading * DEG)];
    const mid = [e.east + d[0] * e.length / 2, e.north + d[1] * e.length / 2];
    const key = `${Math.round(mid[0] / 5)},${Math.round(mid[1] / 5)}`;
    if (done.has(key) || Math.hypot(mid[0] - RW[0], mid[1] - RW[1]) > 30000) continue;
    done.add(key);
    corridors.push({ mid, d, len: e.length });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(e.width, e.length), rwMat);
    m.rotation.order = 'YXZ'; m.rotation.y = -e.heading * DEG; m.rotation.x = -Math.PI / 2;
    m.position.copy(enu(mid[0], mid[1], ap.elevation + 0.05));
    scene.add(m);
  }
  // Blocks: kept clear of every runway and its approach.
  const N = MOBILE ? 2500 : 6000;
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: '#b9b2a6' }), N);
  const M4 = new THREE.Matrix4(), col = new THREE.Color();
  let rnd = 7;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  let k = 0;
  for (let tries = 0; k < N && tries < N * 6; ++tries) {
    const r = 300 + 9000 * Math.sqrt(rand()), a = rand() * 2 * Math.PI;
    const e = RW[0] + r * Math.cos(a), n = RW[1] + r * Math.sin(a);
    let clear = true;
    for (const c of corridors) {
      const dx = e - c.mid[0], dy = n - c.mid[1], along = dx * c.d[0] + dy * c.d[1], across = Math.abs(-dx * c.d[1] + dy * c.d[0]);
      if (across < 180 && Math.abs(along) < c.len / 2 + 6000) { clear = false; break; }
    }
    if (!clear) continue;
    const w = 12 + rand() * 30, h = 6 + rand() ** 3 * 90;
    M4.makeRotationY(rand() * Math.PI).setPosition(enu(e, n, ELEV + h / 2)).scale(new THREE.Vector3(w, h, w * (0.6 + rand())));
    boxes.setMatrixAt(k, M4);
    boxes.setColorAt(k, col.setHSL(0.08, 0.06 + rand() * 0.08, 0.55 + rand() * 0.25));
    ++k;
  }
  boxes.count = k;
  scene.add(boxes);
}

// ---------- The aircraft ----------
const qM = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);  // ENU → three
const q = new THREE.Quaternion();
const lt = buildAircraft(def172);
const ltGroup = new THREE.Group();
ltGroup.add(lt.root);
scene.add(ltGroup);
const cabin = buildCabin({ mobile: MOBILE, maxAniso: renderer.capabilities.getMaxAnisotropy() });
lt.root.add(cabin.root);
cabin.root.visible = false;
const eye = new THREE.Object3D();
eye.position.set(-1.38, 0.27, 0.84);
eye.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
lt.root.add(eye);
const jetGroup = new THREE.Group();
scene.add(jetGroup);
let jet = null, jetDef = null, jetTips = [[0, 0, 0], [0, 0, 0]];
// A wing tip in body FLU from the definition's wing panels (structural FRD).
function wingTips(d) {
  const w = d.surfaces.find((s) => /wing/i.test(s.name) && !/tail|stab/i.test(s.name)) || d.surfaces[0];
  let [x, y, z] = w.panels[0].root_quarter_chord_m;
  for (const p of w.panels) { x -= p.span_m * Math.tan((p.sweep_deg || 0) * DEG); y += p.span_m; z -= p.span_m * Math.tan((p.dihedral_deg || 0) * DEG); }
  return [[x, y, -z], [x, -y, -z]];
}
async function useJet(id) {
  const j = await fetchText(JETS[id].file);
  const errors = A.trafficLoad(j);
  if (errors.length) throw new Error(errors.join('; '));
  jetDef = JSON.parse(j);
  if (jet) jetGroup.remove(jet.root);
  jet = buildJet(jetDef);
  jetGroup.add(jet.root);
  jetTips = wingTips(jetDef);
}

// Between the 240 Hz steps (seconds apart on screen in slow motion) each
// aircraft is carried along its velocity, as the flying page does.
function poseTracker() {
  return { p: null, t: -1, v: new THREE.Vector3(), at(pos, t, now) {
    if (t !== this.t) {
      if (this.p && t > this.t && t - this.t < 0.05) this.v.copy(pos).sub(this.p).divideScalar(t - this.t); else this.v.set(0, 0, 0);
      this.p = pos.clone(); this.t = t;
    }
    const lag = now - t;
    return lag > 0 && lag < 0.02 ? pos.clone().addScaledVector(this.v, lag) : pos.clone();
  } };
}
const ltPose = poseTracker(), jetPose = poseTracker();

// ---------- Smoke and vortex lines ----------
// Smoke from the jet's wing tips, carried by the air the engine computes
// (the wind and both wakes): each puff's velocity is sampled from the core in
// turn, a share of them every frame.
const NS = 7000, LIFE = 35;
// Quality: full, or lite for slow devices (phones start lite; a desktop that
// cannot hold 30 frames a second drops to it by itself).
const QUALITY = {
  full: { rate: 95, refresh: 2400, pixels: 2, puff: 1 },
  lite: { rate: 45, refresh: 700, pixels: 1, puff: 1.5 },
};
let Q = QUALITY[store.get('quality', MOBILE ? 'lite' : 'full')] || QUALITY.full;
const sPos = new Float32Array(3 * NS), sVel = new Float32Array(3 * NS), sAge = new Float32Array(NS).fill(-1);
let sHead = 0, sRefresh = 0;
const smokeGeo = new THREE.BufferGeometry();
const sDraw = new Float32Array(3 * NS);
smokeGeo.setAttribute('position', new THREE.BufferAttribute(sDraw, 3));
smokeGeo.setAttribute('age', new THREE.BufferAttribute(sAge, 1));
const smokeMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uScale: { value: 600 }, uLife: { value: LIFE }, uPuff: { value: 1 } },
  vertexShader: `attribute float age; uniform float uScale, uLife, uPuff; varying float vA;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
      float a = age < 0.0 ? 0.0 : clamp(1.0 - age / uLife, 0.0, 1.0);
      vA = a * a * min(1.0, age * 4.0 + 0.2);
      gl_PointSize = age < 0.0 ? 0.0 : clamp(uPuff * (1.6 + 0.22 * age) * uScale / -mv.z, 1.5, 120.0);
    }`,
  fragmentShader: `varying float vA;
    #include <common>
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d); if (r2 > 1.0) discard;
      gl_FragColor = vec4(0.97, 0.97, 0.98, 0.3 * vA * exp(-2.5 * r2));
    }`,
});
const smoke = new THREE.Points(smokeGeo, smokeMat);
smoke.frustumCulled = false;
scene.add(smoke);
let lastTips = null;
function emitSmoke(simDt, tipsNow) {
  if (!lastTips) { lastTips = tipsNow; return; }
  const n = Q.rate * simDt;
  for (let side = 0; side < 2; ++side) {
    const a = lastTips[side], b = tipsNow[side];
    let count = Math.floor(n) + (Math.random() < n - Math.floor(n) ? 1 : 0);
    for (let i = 0; i < count; ++i) {
      const u = Math.random(), k = sHead; sHead = (sHead + 1) % NS;
      for (let c = 0; c < 3; ++c) { sPos[3 * k + c] = a[c] + (b[c] - a[c]) * u + (Math.random() - 0.5) * 0.6; sVel[3 * k + c] = 0; }
      sAge[k] = (1 - u) * simDt;
    }
  }
  lastTips = tipsNow;
}
// The puffs' air velocity: the wind at the 172 plus the jet's wake, from the
// wake's own vortex segments (the ones drawn as vortex lines) binned along the
// approach course, each puff summing those within two bins of it with the
// engine's segment formula (Katz & Plotkin, Lamb-Oseen core). That is the
// engine's field to a few percent and about 60 times cheaper per puff than
// asking the engine point by point.
const BIN = 30, REACH = 2, K_LO = 1.25643;
let segs = new Float64Array(0), segN = 0, binStart = new Int32Array(1), binList = new Int32Array(0), bin0 = 0, nBins = 0;
let segLo = new Int32Array(0), segHi = new Int32Array(0), seen = new Int32Array(0), stampN = 0;
const alongOf = (e, n) => (e - RW[0]) * fwd[0] + (n - RW[1]) * fwd[1];
function binWake() {
  const w = A.trafficWake(), sg = w.seg, thr = 0.005 * Math.max(w.gmax, 1);
  if (segs.length < 8 * w.n) { segs = new Float64Array(8 * w.n); segLo = new Int32Array(w.n); segHi = new Int32Array(w.n); seen = new Int32Array(w.n); }
  let m = 0, lo = 1e9, hi = -1e9;
  for (let i = 0; i < w.n; ++i) {
    const o = 9 * i;
    if (Math.abs(sg[o + 6]) < thr) continue;
    for (let c = 0; c < 6; ++c) segs[8 * m + c] = sg[o + c];
    segs[8 * m + 6] = sg[o + 6]; segs[8 * m + 7] = Math.max(sg[o + 7] * sg[o + 7], 1e-12);
    const a = alongOf(sg[o], sg[o + 1]), b = alongOf(sg[o + 3], sg[o + 4]);
    segLo[m] = Math.floor(Math.min(a, b) / BIN); segHi[m] = Math.floor(Math.max(a, b) / BIN);
    lo = Math.min(lo, segLo[m]); hi = Math.max(hi, segHi[m]);
    ++m;
  }
  segN = m; bin0 = lo; nBins = m ? hi - lo + 1 : 0;
  if (binStart.length < nBins + 1) binStart = new Int32Array(nBins + 1); else binStart.fill(0, 0, nBins + 1);
  for (let i = 0; i < m; ++i) for (let b = segLo[i]; b <= segHi[i]; ++b) binStart[b - bin0 + 1]++;
  for (let b = 0; b < nBins; ++b) binStart[b + 1] += binStart[b];
  if (binList.length < binStart[nBins]) binList = new Int32Array(2 * binStart[nBins]);
  const fill = binStart.slice(0, nBins);
  for (let i = 0; i < m; ++i) for (let b = segLo[i]; b <= segHi[i]; ++b) binList[fill[b - bin0]++] = i;
  seen.fill(0); stampN = 0;
}
function wakeVelocity(px, py, pz, k) {
  let ux = 0, uy = 0, uz = 0;
  const stamp = ++stampN;
  const b = Math.floor(alongOf(px, py) / BIN) - bin0;
  for (let bb = Math.max(b - REACH, 0); bb <= Math.min(b + REACH, nBins - 1); ++bb)
    for (let q = binStart[bb]; q < binStart[bb + 1]; ++q) {
      const i = binList[q];
      if (seen[i] === stamp) continue;
      seen[i] = stamp;
      const o = 8 * i, ax = segs[o], ay = segs[o + 1], az = segs[o + 2], bx = segs[o + 3], by = segs[o + 4], bz = segs[o + 5];
      const r0x = bx - ax, r0y = by - ay, r0z = bz - az, r1x = px - ax, r1y = py - ay, r1z = pz - az, r2x = px - bx, r2y = py - by, r2z = pz - bz;
      const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
      const c2 = cx * cx + cy * cy + cz * cz, l2 = r0x * r0x + r0y * r0y + r0z * r0z;
      if (l2 < 1e-12 || c2 < 1e-18 * l2) continue;
      const n1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z), n2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
      if (n1 < 1e-9 || n2 < 1e-9) continue;
      const f = segs[o + 6] / (4 * Math.PI * c2) * (r0x * (r1x / n1 - r2x / n2) + r0y * (r1y / n1 - r2y / n2) + r0z * (r1z / n1 - r2z / n2)) *
        (1 - Math.exp(-K_LO * (c2 / l2) / segs[o + 7]));
      ux += cx * f; uy += cy * f; uz += cz * f;
    }
  sVel[3 * k] = ux + windE; sVel[3 * k + 1] = uy + windN; sVel[3 * k + 2] = uz;
}
let windE = 0, windN = 0;
function advectSmoke(simDt) {
  // The wind at the 172 (from, kt), uniform; then a share of the live puffs'
  // velocities refreshed from the binned wake.
  const from = s[59] * DEG, spd = s[60] * KT;
  windE = -Math.sin(from) * spd; windN = -Math.cos(from) * spd;
  binWake();
  const share = Q.refresh;
  for (let n = 0, tries = 0; tries < NS && n < share; ++tries) {
    const k = sRefresh; sRefresh = (sRefresh + 1) % NS;
    if (sAge[k] < 0) continue;
    wakeVelocity(sPos[3 * k], sPos[3 * k + 1], sPos[3 * k + 2], k);
    ++n;
  }
  for (let k = 0; k < NS; ++k) {
    if (sAge[k] < 0) continue;
    sAge[k] += simDt;
    if (sAge[k] > LIFE) { sAge[k] = -1; continue; }
    sPos[3 * k] += sVel[3 * k] * simDt; sPos[3 * k + 1] += sVel[3 * k + 1] * simDt; sPos[3 * k + 2] += sVel[3 * k + 2] * simDt;
    if (sPos[3 * k + 2] < ELEV + 0.5) sPos[3 * k + 2] = ELEV + 0.5;
  }
}
function drawSmoke() {
  for (let k = 0; k < NS; ++k) { sDraw[3 * k] = sPos[3 * k]; sDraw[3 * k + 1] = sPos[3 * k + 2]; sDraw[3 * k + 2] = -sPos[3 * k + 1]; }
  smokeGeo.attributes.position.needsUpdate = true;
  smokeGeo.attributes.age.needsUpdate = true;
  smokeMat.uniforms.uScale.value = innerHeight / (2 * Math.tan(camera.fov * DEG / 2));
  smokeMat.uniforms.uPuff.value = Q.puff;
}
function clearSmoke() { sAge.fill(-1); lastTips = null; }

// The vortex lines: every segment of the jet's wake (bound, shed and rolled
// up), bright where the circulation is strong; the ground's mirror images
// are left out.
const VMAX = 4096;
const vGeo = new THREE.BufferGeometry();
const vPos = new Float32Array(6 * VMAX), vCol = new Float32Array(6 * VMAX);
vGeo.setAttribute('position', new THREE.BufferAttribute(vPos, 3));
vGeo.setAttribute('color', new THREE.BufferAttribute(vCol, 3));
const vLines = new THREE.LineSegments(vGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
vLines.frustumCulled = false;
scene.add(vLines);
const cPos = new THREE.Color('#ff8a5c'), cNeg = new THREE.Color('#5cc8ff');
function drawVortices() {
  const w = A.trafficWake();
  let m = 0;
  const gmax = Math.max(w.gmax, 1);
  for (let i = 0; i < w.n && m < VMAX; ++i) {
    const o = 9 * i, s = w.seg;
    if (s[o + 2] < ELEV - 0.5 && s[o + 5] < ELEV - 0.5) continue;  // a ground image
    const k = clamp(Math.abs(s[o + 6]) / gmax, 0, 1) ** 0.7 * Math.max(0.15, 1 - s[o + 8] / 90);
    const c = s[o + 6] >= 0 ? cPos : cNeg;
    vPos.set([s[o], s[o + 2], -s[o + 1], s[o + 3], s[o + 5], -s[o + 4]], 6 * m);
    vCol.set([c.r * k, c.g * k, c.b * k, c.r * k, c.g * k, c.b * k], 6 * m);
    ++m;
  }
  vGeo.setDrawRange(0, 2 * m);
  vGeo.attributes.position.needsUpdate = true;
  vGeo.attributes.color.needsUpdate = true;
}

// ---------- The run ----------
const SPEEDS = [1, 0.5, 0.25, 0.1, 0.05, 0.02];
const ui = { paused: false, speed: store.get('speed', 0), auto: store.get('auto', true), cam: store.get('cam', 0), smoke: store.get('smoke', true), cores: store.get('cores', true) };
let run = null;  // the run's own record: start, worst values, radio calls made
let s = new Float64Array(A.layout.state), T = new Float64Array(A.layout.traffic);
let autoScale = 1, wakeFelt = -1e9, prevRoll = 0, prevRollT = -1, rollRate = 0;

function radio(who, text) {
  const el = document.createElement('div');
  el.className = who;
  const tt = run ? (s[42] - run.t0).toFixed(1).padStart(5) : '  0.0';
  el.textContent = `${tt}  ${text}`;
  $('radio').appendChild(el);
  $('radio').scrollTop = 1e9;
}
function banner(title, sub, sec = 4) {
  $('bTitle').textContent = title; $('bSub').textContent = sub; $('banner').classList.add('on');
  clearTimeout(banner.h); banner.h = setTimeout(() => $('banner').classList.remove('on'), sec * 1000);
}

async function start() {
  store.set('cfg', cfg); store.set('scene', sceneId);
  $('brasher').classList.remove('on');
  $('radio').textContent = '';
  if (!jetDef || jetDef.__id !== cfg.jet) { await useJet(cfg.jet); jetDef.__id = cfg.jet; }
  // The weather first: every reset flies in it. Crosswind + from the right.
  const xw = cfg.xw;
  const turb = [0, 0.6, 1.6][cfg.turb];
  A.avd_set_weather(Math.abs(xw), (HDG + (xw >= 0 ? 90 : -90) + 360) % 360, turb, 0, 0.6);
  A.avd_set_wind_detail(cfg.turb, 0, 0);
  A.avd_reset_final(START, KIAS172);
  A.linePilot(1, KIAS172, -3);
  A.avd_set_wake(0);  // the 172's own wake: it never meets it here (no turns), and it costs a third of the step
  s = A.state().slice();
  // The jet: on its own 3 deg line, behind, above and to one side, timed to
  // overtake the 172 about 10 s in; it goes around `ga` m after passing it.
  const J = JETS[cfg.jet];
  const tasK = s[11] / Math.max(s[10], 1);
  const v172 = s[11] * KT, vJet = J.kias * tasK * KT, closing = Math.max(vJet - v172, 5);
  const back = closing * 10;
  const h172 = s[14] * FT;
  const e = s[0] - fwd[0] * back + left[0] * cfg.aside, n = s[1] - fwd[1] * back + left[1] * cfg.aside;
  if (!A.trafficSpawn(e, n, h172 + back * Math.tan(3 * DEG) + cfg.dh, HDG, -3, J.kias, 99, true)) throw new Error('the jet could not be spawned');
  A.trafficGoAround(back + v172 * (back / closing) + cfg.ga);
  T = A.traffic().slice();
  clearSmoke();
  run = { t0: s[42], p0: [s[0], s[1]], h0: h172, worstBank: 0, worstRate: 0, worstLost: 0, worstAil: 0, calls: new Set(), done: false, encounterT: -1, gaT: -1, crashed: false };
  autoScale = 1; wakeFelt = -1e9; prevRollT = -1; rollRate = 0;
  ui.paused = false; syncButtons();
  radio('tw', `TWR  ${CALL172}, Congonhas Tower, runway 35L, wind ${windText()}, cleared to land.`);
  radio('lt', `172  Cleared to land 35L, ${CALL172}.`);
  radio('tw', `TWR  ${CALLJET}, runway 35R, cleared to land, traffic a 172 on final for the parallel.`);
  radio('jt', `JET  Cleared to land 35R, ${CALLJET}.`);
  $('rJet').textContent = J.name;
  closeSheetOnPhone();
}
function windText() { return cfg.xw === 0 ? 'calm' : `${Math.round((HDG + (cfg.xw >= 0 ? 90 : -90) + 360) % 360).toString().padStart(3, '0')} at ${Math.round(Math.abs(cfg.xw) / KT)} kt`; }

// The 172 against its glide path, and the story's calls as it unfolds.
function judge() {
  const r = run;
  if (!r) return;
  const t = s[42] - r.t0;
  const along = (s[0] - r.p0[0]) * fwd[0] + (s[1] - r.p0[1]) * fwd[1];
  r.lost = r.h0 - along * Math.tan(3 * DEG) - s[14] * FT;
  r.along = along;
  r.worstBank = Math.max(r.worstBank, Math.abs(s[7]));
  r.worstRate = Math.max(r.worstRate, Math.abs(rollRate));
  r.worstLost = Math.max(r.worstLost, r.lost);
  r.worstAil = Math.max(r.worstAil, Math.abs(s[45]));
  const once = (k, f) => { if (!r.calls.has(k)) { r.calls.add(k); f(); } };
  if (T[20] < 200 && !T[14]) once('ga', () => radio('tw', `TWR  ${CALLJET}, GO AROUND, you are lined up on 35L, traffic a 172 right below you!`));
  if (T[14]) once('gaack', () => { r.gaT = t; radio('jt', `JET  Going around, ${CALLJET}.`); banner('Go around', `${CALLJET} climbs away`, 2.5); });
  if (T[20] < 120) once('close', () => banner(`${Math.round(T[20])} m`, 'closest approach so far', 2.5));
  // The slow motion follows the hard moments; the radio call the first real roll.
  if (Math.abs(rollRate) > 12 || Math.abs(s[7]) > 25) wakeFelt = t;
  if (Math.abs(rollRate) > 8 || Math.abs(s[7]) > 15 || r.lost > 10) once('wake', () => { r.encounterT = t; radio('lt', `172  ${CALL172}, WAKE TURBULENCE!`); });
  if (r.encounterT >= 0 && t - r.encounterT > 8 && r.gaT >= 0 && t - r.gaT > 6) once('brasher', brasher);
  if (s[48] || (s[28] && r.along < START - 700)) { r.crashed = true; finish(); }
  else if (r.along > START - 600 || t > 85) finish();
}
function brasher() {
  radio('tw', `TWR  ${CALLJET}, possible pilot deviation, advise you contact Congonhas Tower at (11) 5555-0137.`);
  radio('jt', `JET  ...copy, ${CALLJET}.`);
  $('brText').textContent = `${CALLJET}, possible pilot deviation, advise you contact Congonhas Tower. Ready to copy the number?`;
  $('brNum').textContent = '(11) 5555-0137';
  $('brasher').classList.add('on');
}
function finish() {
  const r = run;
  if (r.done) return;
  r.done = true;
  ui.paused = true; syncButtons();
  if (r.crashed) banner('The 172 hit the ground', `${Math.round(r.worstBank)}° of bank in the wake, ${Math.round(r.worstLost)} m below the path`, 8);
  else if (r.worstBank > 30 || r.worstLost > 15) banner('Wake upset', `${Math.round(r.worstBank)}° of bank, ${Math.round(r.worstRate)}°/s, ${Math.round(r.worstLost)} m below the glide path`, 8);
  else banner('It held', `${Math.round(r.worstBank)}° of bank at worst, ${Math.round(Math.max(r.worstLost, 0))} m below the path`, 8);
  if (!r.calls.has('brasher') && T[23] < 150) brasher();
  radio('tw', `TWR  ${CALL172}, ${r.crashed ? 'Tower, crash crew rolling.' : 'caution wake turbulence. Say intentions.'}`);
}

// ---------- Cameras ----------
// 0 chase the 172, 1 its cockpit, 2 the tower, 3 beside the two, 4 behind the jet.
const CAMS = ['Chase', 'Cockpit', 'Tower', 'Beside', 'Jet'];
const orbit = { yaw: 0, pitch: 0, zoom: 1 };
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
function placeCamera(ltPos, jetPos) {
  cabin.root.visible = ui.cam === 1;
  camera.fov = 55;
  const hd = s[9] * DEG;
  if (ui.cam === 1) {
    eye.getWorldPosition(camera.position);
    eye.getWorldQuaternion(camera.quaternion);
    camera.rotateY(-orbit.yaw); camera.rotateX(orbit.pitch);
    camera.fov = 70;
  } else if (ui.cam === 2) {
    // The tower: beside the runway's middle, the 172 framed by zoom.
    camera.position.copy(enu(RW[0] + fwd[0] * 900 - left[0] * 450, RW[1] + fwd[1] * 900 - left[1] * 450, ELEV + 45));
    camera.lookAt(ltPos.clone().lerp(jetPos, 0.3));
    const d = camera.position.distanceTo(ltPos);
    camera.fov = clamp(2 * Math.atan(60 * orbit.zoom / d) / DEG, 1.5, 60);
  } else {
    const target = ui.cam === 4 ? jetPos : ui.cam === 3 ? ltPos.clone().lerp(jetPos, clamp(1 - T[20] / 400, 0, 0.5)) : ltPos;
    const dist = (ui.cam === 4 ? JETS[cfg.jet].chase : ui.cam === 3 ? 75 : 22) * orbit.zoom;
    const yaw = (ui.cam === 3 ? hd - Math.PI / 2 - (cfg.aside >= 0 ? 0 : Math.PI) : hd) + orbit.yaw;
    const pitch = (ui.cam === 3 ? 0.04 : 0.2) + orbit.pitch;
    tmp.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));  // behind, in three (x east, -z north)
    camera.position.copy(target).addScaledVector(tmp, dist);
    if (camera.position.y < ELEV + 2) camera.position.y = ELEV + 2;
    camera.lookAt(target);
  }
  camera.updateProjectionMatrix();
}

// ---------- Readouts ----------
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–');
function kv(el, rows) { el.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join(''); }
function readouts() {
  const r = run || {};
  kv($('kv172'), [
    ['Airspeed', `${fmt(s[10])} kt`], ['Bank', `${fmt(s[7], 1)}°`], ['Roll rate', `${fmt(rollRate)}°/s`],
    ['Height', `${fmt(s[14] * FT)} m`], ['Below the glide path', `${fmt(Math.max(r.lost || 0, 0), 1)} m`], ['Vertical speed', `${fmt(s[15])} ft/min`],
    ['Worst bank', `${fmt(r.worstBank, 1)}°`], ['Worst roll rate', `${fmt(r.worstRate)}°/s`], ['Most below the path', `${fmt(Math.max(r.worstLost || 0, 0), 1)} m`],
  ]);
  const ail = clamp(s[45], -1, 1);
  const g = $('ail');
  g.style.left = `${50 + Math.min(ail, 0) * 50}%`; g.style.width = `${Math.abs(ail) * 50}%`;
  g.classList.toggle('hot', Math.abs(ail) > 0.95);
  const span = T[28] || 34, b0 = Math.PI / 4 * span, gam = T[27];
  kv($('kvJet'), [
    ['Airspeed', `${fmt(T[11])} kt`], ['Above the 172', `${fmt(T[22], 1)} m`], ['Distance', `${fmt(T[20])} m`],
    ['Closest', `${fmt(T[23], 1)} m (${fmt(T[25], 0)} up, ${fmt(T[24], 0)} across)`],
    ['Wake circulation', `${fmt(gam)} m²/s`], ['Vortex pair', `${fmt(b0, 1)} m apart, sinking ${fmt(gam / (2 * Math.PI * b0), 1)} m/s`],
    ['Mass', `${fmt(T[29] / 1000, 1)} t`], ['', T[14] ? 'going around' : 'on final, the wrong runway'],
  ]);
  const heavy = T[29] > 136000, light = T[29] <= 7000;
  const req = heavy ? 6 : light ? 3 : 5;
  $('sep').innerHTML = `A LIGHT 172 behind a ${heavy ? 'HEAVY' : light ? 'LIGHT' : 'MEDIUM'} ${JETS[cfg.jet].name}: <b>${req} NM</b> (${fmt(req * NM / 1000, 1)} km) on approach. Closest here: <b>${fmt(T[23], 0)} m</b>, ${fmt(T[23] / (req * NM) * 100, 2)}% of it.`;
  const bad = (el, v, w, b) => { el.className = Math.abs(v) > b ? 'bad' : Math.abs(v) > w ? 'warn' : ''; };
  $('hBank').firstChild.nodeValue = `${fmt(s[7])}°`; bad($('hBank'), s[7], 20, 45);
  $('hRate').firstChild.nodeValue = `${fmt(rollRate)}°/s`; bad($('hRate'), rollRate, 10, 30);
  $('hLost').firstChild.nodeValue = `${fmt(Math.max(r.lost || 0, 0))} m`; bad($('hLost'), r.lost || 0, 5, 15);
  $('hSep').firstChild.nodeValue = `${fmt(T[20])} m`; bad($('hSep'), 1000 / Math.max(T[20], 1), 1000 / 300, 1000 / 80);
  $('sumGeom').textContent = `${cfg.dh} m up · ${Math.abs(cfg.aside)} m ${cfg.aside >= 0 ? 'left' : 'right'}`;
}

// ---------- The loop ----------
let last = performance.now(), simClock = 0, propPhase = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  // Slow motion: by hand, or by itself while the 172 is in the wake (and as the jet passes).
  if (run && ui.auto && !run.done) {
    const t = s[42] - run.t0;
    const want = t - wakeFelt < 2 ? 0.2 : T[20] < 70 ? 0.25 : 1;
    autoScale += (want - autoScale) * Math.min(1, dt * (want < autoScale ? 6 : 1.2));
  } else autoScale = 1;
  const scale = SPEEDS[ui.speed] * autoScale;
  const simDt = ui.paused || !run ? 0 : dt * scale;
  if (simDt > 0) {
    A.avd_advance(simDt);
    s = A.state().slice(); T = A.traffic().slice();
    if (s[42] !== prevRollT) {
      if (prevRollT >= 0 && s[42] > prevRollT) {
        let d = s[7] - prevRoll; if (d > 180) d -= 360; if (d < -180) d += 360;
        rollRate += (d / (s[42] - prevRollT) - rollRate) * Math.min(1, (s[42] - prevRollT) / 0.15);
      }
      prevRoll = s[7]; prevRollT = s[42];
    }
    judge();
  }
  simClock = simDt > 0 ? (Math.abs(simClock - s[42]) > 0.02 ? s[42] : simClock + simDt) : simClock;
  const ltPos = ltPose.at(enu(s[0], s[1], s[2]), s[42], simClock);
  ltGroup.position.copy(ltPos);
  ltGroup.quaternion.copy(qM).multiply(q.set(s[4], s[5], s[6], s[3]));
  propPhase += (s[19] / 60) * 2 * Math.PI * simDt;
  lt.update({ flapDeg: s[26], aileron: s[45], elevator: s[46], rudder: s[47], rpm: simDt > 0 ? s[19] : 0, disc: ui.cam === 1 ? 0.15 : 1, phase: propPhase, slow: 1 / Math.max(scale, 1e-3) }, simDt);
  if (ui.cam === 1) cabin.update({ elev: s[46], ail: s[45], rud: s[47], trim: s[27], thr: 0.5, mix: 1, flapLever: 2, park: 0 });
  const jetPos = jetPose.at(enu(T[1], T[2], T[3]), T[30], simClock);
  jetGroup.visible = !!T[0];
  if (jet && T[0]) {
    jetGroup.position.copy(jetPos);
    jetGroup.quaternion.copy(qM).multiply(q.set(T[5], T[6], T[7], T[4]));
    jet.update({ flapDeg: T[18], aileron: 0, elevator: 0, rudder: 0, n1: T[14] ? [95, 95] : [55, 55], gear: T[19], speedbrake: 0, lights: true, reverser: [0, 0], slow: 1 / Math.max(scale, 1e-3) }, simDt);
    jetGroup.updateMatrixWorld(true);
    if (simDt > 0 && ui.smoke) {
      const tips = jetTips.map((p) => { const w = jetGroup.localToWorld(tmp2.set(p[0], p[1], p[2])); return [w.x, -w.z, w.y]; });
      emitSmoke(simDt, tips);
    }
  }
  if (simDt > 0 && ui.smoke) advectSmoke(simDt);
  smoke.visible = ui.smoke;
  if (ui.smoke) drawSmoke();
  vLines.visible = ui.cores;
  if (ui.cores && simDt > 0) drawVortices();
  ltGroup.updateMatrixWorld(true);
  placeCamera(ltPos, jetPos);
  const rt = run ? s[42] - run.t0 : 0;
  $('clock').innerHTML = `${rt.toFixed(1)} s<small>${Math.round(1 / scale) <= 1 ? '1× · real time' : `1/${Math.round(1 / scale)} · slow motion`}${ui.paused ? ' · paused' : ''}</small>`;
  watchFrameRate(dt);
  if (Math.floor(now / 120) !== frame.k) { frame.k = Math.floor(now / 120); readouts(); }
  renderer.render(scene, camera);
}
function setQuality(name, chosen) {
  Q = QUALITY[name];
  if (chosen) store.set('quality', name);
  renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixels));
  resize();
  syncButtons();
}
// A device that cannot keep up on full quality (an average frame over 36 ms
// for 3 s of flying) goes lite by itself, once, unless the viewer chose.
const perf = { t: 0, sum: 0, n: 0, done: store.get('quality', null) !== null };
function watchFrameRate(dt) {
  if (perf.done || !run || ui.paused || Q === QUALITY.lite) return;
  perf.t += dt; perf.sum += dt; perf.n++;
  if (perf.t < 3) return;
  if (perf.sum / perf.n > 0.036) { setQuality('lite', false); toast('Running lighter for this device (Lite, top right).'); }
  perf.done = true;
}
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixels));
resize();

// ---------- Controls ----------
function syncButtons() {
  $('bPlay').textContent = ui.paused ? 'Play' : 'Pause';
  $('bPlay').setAttribute('aria-pressed', String(ui.paused));
  $('bAuto').setAttribute('aria-pressed', String(ui.auto));
  $('bSmoke').setAttribute('aria-pressed', String(ui.smoke));
  $('bCores').setAttribute('aria-pressed', String(ui.cores));
  $('bCam').textContent = `Camera: ${CAMS[ui.cam]}`;
  $('bLite').setAttribute('aria-pressed', String(Q === QUALITY.lite));
  for (const b of $('scale').children) b.setAttribute('aria-pressed', String(+b.dataset.i === ui.speed));
  for (const b of $('scenes').children) b.setAttribute('aria-pressed', String(b.dataset.id === sceneId));
  $('vDh').textContent = `${cfg.dh} m`; $('dh').value = cfg.dh;
  $('vAside').textContent = cfg.aside === 0 ? 'right over it' : `${Math.abs(cfg.aside)} m ${cfg.aside > 0 ? 'left' : 'right'}`; $('aside').value = cfg.aside;
  $('vGa').textContent = `${(cfg.ga / 1000).toFixed(2)} km`; $('ga').value = cfg.ga;
  $('vXw').textContent = cfg.xw === 0 ? 'none' : `${Math.abs(cfg.xw)} m/s from the ${cfg.xw > 0 ? 'right' : 'left'}`; $('xw').value = cfg.xw;
  $('turb').value = String(cfg.turb); $('jet').value = cfg.jet;
}
SPEEDS.forEach((v, i) => {
  const b = document.createElement('button'); b.dataset.i = i; b.textContent = v === 1 ? '1×' : `1/${Math.round(1 / v)}`;
  b.title = v === 1 ? 'Real time' : `${Math.round(1 / v)} times slower`;
  b.onclick = () => { ui.speed = i; store.set('speed', i); syncButtons(); };
  $('scale').appendChild(b);
});
for (const sc of SCENES) {
  const b = document.createElement('button'); b.dataset.id = sc.id;
  b.innerHTML = `${sc.name}<small>${sc.sub}</small>`;
  b.onclick = () => { sceneId = sc.id; Object.assign(cfg, sc.set); syncButtons(); start(); };
  $('scenes').appendChild(b);
}
for (const [id, j] of Object.entries(JETS)) { const o = document.createElement('option'); o.value = id; o.textContent = j.name; $('jet').appendChild(o); }
const edited = () => { sceneId = ''; syncButtons(); };
$('dh').oninput = (e) => { cfg.dh = +e.target.value; edited(); };
$('aside').oninput = (e) => { cfg.aside = +e.target.value; edited(); };
$('ga').oninput = (e) => { cfg.ga = +e.target.value; edited(); };
$('xw').oninput = (e) => { cfg.xw = +e.target.value; edited(); };
$('turb').onchange = (e) => { cfg.turb = +e.target.value; edited(); };
$('jet').onchange = (e) => { cfg.jet = e.target.value; edited(); };
$('go').onclick = () => start();
$('bReset').onclick = () => start();
$('bPlay').onclick = () => { if (run?.done) { start(); return; } ui.paused = !ui.paused; syncButtons(); };
$('bAuto').onclick = () => { ui.auto = !ui.auto; store.set('auto', ui.auto); syncButtons(); };
$('bSmoke').onclick = () => { ui.smoke = !ui.smoke; store.set('smoke', ui.smoke); if (!ui.smoke) clearSmoke(); syncButtons(); };
$('bCores').onclick = () => { ui.cores = !ui.cores; store.set('cores', ui.cores); syncButtons(); };
$('bCam').onclick = () => { ui.cam = (ui.cam + 1) % CAMS.length; store.set('cam', ui.cam); Object.assign(orbit, { yaw: 0, pitch: 0, zoom: 1 }); syncButtons(); toast(CAMS[ui.cam]); };
$('bLite').onclick = () => setQuality(Q === QUALITY.lite ? 'full' : 'lite', true);
$('bHelp').onclick = () => $('help').classList.add('on');
$('bHelpClose').onclick = () => $('help').classList.remove('on');
$('help').onclick = (e) => { if (e.target === $('help')) $('help').classList.remove('on'); };
$('brClose').onclick = () => $('brasher').classList.remove('on');
const show = (which) => {
  $('lab').hidden = which !== 'lab'; $('res').hidden = which !== 'res';
  $('tLab').setAttribute('aria-pressed', String(which === 'lab')); $('tRes').setAttribute('aria-pressed', String(which === 'res')); $('tHide').setAttribute('aria-pressed', String(which === 'none'));
  $('tabs').classList.toggle('closed', which === 'none');
};
function closeSheetOnPhone() { if (innerWidth <= 860) show('res'); }
$('tLab').onclick = () => show('lab'); $('tRes').onclick = () => show('res'); $('tHide').onclick = () => show('none');
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); start(); }
  else if (k === 'r') start();
  else if (k === 'p') $('bPlay').onclick();
  else if (k === 'a') $('bAuto').onclick();
  else if (k === 'c') $('bCam').onclick();
  else if (k === 'm') $('bSmoke').onclick();
  else if (k === 'v') $('bCores').onclick();
  else if (k === 'h' || k === '?') $('help').classList.toggle('on');
  else if (k === 'escape') { $('help').classList.remove('on'); $('brasher').classList.remove('on'); }
  else if (k >= '1' && k <= String(SPEEDS.length)) { ui.speed = +k - 1; store.set('speed', ui.speed); syncButtons(); }
});
{
  // Drag to orbit (turn your head in the cockpit), scroll or pinch to zoom.
  const ptrs = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const [c, d] = [...ptrs.values()];
      const d1 = Math.hypot(c.x - d.x, c.y - d.y);
      if (pinch && d0 > 0) orbit.zoom = clamp(orbit.zoom * d0 / Math.max(d1, 1), 0.25, 8);
      pinch = 1;
      return;
    }
    orbit.yaw -= (e.clientX - p.x) * 0.006; orbit.pitch = clamp(orbit.pitch + (e.clientY - p.y) * 0.004, -0.6, 1.2);
    p.x = e.clientX; p.y = e.clientY;
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = 0; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.zoom = clamp(orbit.zoom * Math.exp(e.deltaY * 0.001), 0.25, 8); }, { passive: false });
}

syncButtons();
$('loading').remove();
await start();
requestAnimationFrame(frame);
toast('The 172 is on final. Watch the jet behind it.');
