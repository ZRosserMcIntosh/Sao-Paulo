// São Paulo World · Ballistics Range.
// Physics: the Ballistic Dynamics exterior-ballistics core (C++, MIT) compiled
// to WebAssembly, flying through Aviation Dynamics' standard atmosphere.
// Rendering: three.js (MIT). This file only draws what the core returns and
// reads input: every drop, drift, spin and wobble comes from the core.
import * as THREE from 'three';
import createBallisticModule from './ballistic.mjs';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw-ballistics:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw-ballistics:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const DEG = Math.PI / 180, IN = 0.0254, YD = 0.9144, FT = 0.3048, KMH = 1 / 3.6, MPH = 0.44704;
const ZERO = 100;          // m: every rifle is zeroed at 100 m
const BENCH = 1.2;         // m: the muzzle over the ground (a bench)
const SCALES = [[1, '1×'], [0.1, '1/10'], [0.01, '1/100'], [1e-3, '1/1k']];
const RIFLE_FOR = { fgmm_308_175: 'm24_sws', hornady_65cm_140: 'bolt_65cm', lapua_338lm_250: 'bolt_338lm',
  hornady_50bmg_750: 'm107_50bmg', federal_xm855: 'm16a2', speer_9mm_124gd: 'pistol_9mm' };

// ---------- Engine ----------
let B, cat, raw;
try {
  // The engine and its library must match: revalidate both on every load.
  B = await createBallisticModule(await (await fetch('ballistic.wasm', { cache: 'no-cache' })).arrayBuffer());
  const text = await (await fetch('library.json', { cache: 'no-cache' })).text();
  const errs = B.load(text);
  if (errs.length) throw new Error(errs.join('; '));
  cat = B.catalog();
  raw = JSON.parse(text);
} catch (e) {
  $('loadMsg').textContent = 'Could not start the ballistics engine in this browser: ' + e.message;
  throw e;
}
const cartIndex = (id) => cat.cartridges.findIndex((c) => c.id === id);
const rifleRaw = (cid) => raw.rifles.find((r) => r.id === RIFLE_FOR[cid]);
const projRaw = (cid) => raw.projectiles.find((p) => p.id === cat.cartridges[cartIndex(cid)].projectile);

// ---------- The shot ----------
const layer = (spd, clock, gust = 0) => ({ spd, clock, gust });  // km/h, o'clock (where it blows FROM), km/h RMS
const SCENARIOS = [
  { id: '1k', name: '1 km', sub: '.308 · M24 · São Paulo', feature: true,
    s: { c: 'fgmm_308_175', dist: 1000, size: 0.5, temp: 27, alt: 760, rh: 60, lat: -23.55, az: 0,
      same: true, layers: [layer(12, 3, 1.5), layer(12, 3, 1.5), layer(12, 3, 1.5)], callTrue: true, call: layer(12, 3) } },
  { id: '1mi', name: '1 mile', sub: '.338 Lapua Magnum', feature: true,
    s: { c: 'lapua_338lm_250', dist: 1609, size: 0.75, temp: 15, alt: 0, rh: 50, lat: 45, az: 0,
      same: true, layers: [layer(12, 9, 1), layer(12, 9, 1), layer(12, 9, 1)], callTrue: true, call: layer(12, 9) } },
  { id: '2k', name: '2 km', sub: '.50 BMG · Barrett class', feature: true,
    s: { c: 'hornady_50bmg_750', dist: 2000, size: 1.0, temp: 20, alt: 300, rh: 40, lat: 33, az: 270,
      same: true, layers: [layer(10, 2, 2), layer(10, 2, 2), layer(10, 2, 2)], callTrue: true, call: layer(10, 2) } },
  { id: '2mi', name: '2 miles', sub: '.50 BMG · thin desert air', feature: true,
    s: { c: 'hornady_50bmg_750', dist: 3219, size: 1.5, temp: 32, alt: 1500, rh: 15, lat: 35, az: 90,
      same: false, layers: [layer(6, 4, 2), layer(9, 3, 3), layer(7, 4, 3)], callTrue: true, call: layer(8, 3) } },
  { id: 'wrongcall', name: 'Wrong call', sub: '.308 · called 10, true 15 km/h',
    s: { c: 'fgmm_308_175', dist: 1000, size: 0.5, temp: 20, alt: 0, rh: 50, lat: -23.55, az: 0,
      same: true, layers: [layer(15, 3, 0), layer(15, 3, 0), layer(15, 3, 0)], callTrue: false, call: layer(10, 3) } },
  { id: 'layers', name: 'Three winds', sub: '.338 at 1 mile · the near wind counts most',
    s: { c: 'lapua_338lm_250', dist: 1609, size: 0.75, temp: 15, alt: 0, rh: 50, lat: 45, az: 0,
      same: false, layers: [layer(10, 9, 1), layer(16, 10, 1), layer(13, 8, 1)], callTrue: true, call: layer(13, 9) } },
  { id: 'cold', name: 'Cold morning', sub: '6.5 CM · −15 °C at 1 km',
    s: { c: 'hornady_65cm_140', dist: 1000, size: 0.5, temp: -15, alt: 0, rh: 70, lat: 50, az: 0,
      same: true, layers: [layer(6, 9, 1), layer(6, 9, 1), layer(6, 9, 1)], callTrue: true, call: layer(6, 9) } },
  { id: 'hot', name: 'Hot afternoon', sub: '6.5 CM · 42 °C at 1 km',
    s: { c: 'hornady_65cm_140', dist: 1000, size: 0.5, temp: 42, alt: 0, rh: 20, lat: 25, az: 0,
      same: true, layers: [layer(6, 9, 1), layer(6, 9, 1), layer(6, 9, 1)], callTrue: true, call: layer(6, 9) } },
  { id: 'east', name: 'Coriolis', sub: '.50 at 2 km, east vs west',
    s: { c: 'hornady_50bmg_750', dist: 2000, size: 1.0, temp: 15, alt: 0, rh: 50, lat: 60, az: 90,
      same: true, layers: [layer(0, 3, 0), layer(0, 3, 0), layer(0, 3, 0)], callTrue: true, call: layer(0, 3) } },
  { id: 'm855', name: '600 m', sub: '5.56 M855 · M16A2',
    s: { c: 'federal_xm855', dist: 600, size: 0.5, temp: 25, alt: 0, rh: 50, lat: -23.55, az: 0,
      same: true, layers: [layer(15, 4, 4), layer(15, 4, 4), layer(15, 4, 4)], callTrue: true, call: layer(15, 4) } },
  { id: '9mm', name: '100 m', sub: '9 mm · pistol',
    s: { c: 'speer_9mm_124gd', dist: 100, size: 0.3, temp: 22, alt: 0, rh: 50, lat: -23.55, az: 0,
      same: true, layers: [layer(8, 3, 2), layer(8, 3, 2), layer(8, 3, 2)], callTrue: true, call: layer(8, 3) } },
];
const S = structuredClone(SCENARIOS[0].s);
Object.assign(S, { spin: true, earth: true, solver: true, t0: 10 });
let metric = store.get('metric', true);
let dopeMil = store.get('dopeMil', true);

// From the URL: a shared shot.
const Q = new URLSearchParams(location.search);
let autoFire = false;
(function readShare() {
  if (!Q.has('c')) return;
  const n = (k, d) => (Q.has(k) && Number.isFinite(+Q.get(k)) ? +Q.get(k) : d);
  if (cartIndex(Q.get('c')) >= 0) S.c = Q.get('c');
  S.dist = n('d', S.dist); S.size = n('sz', S.size); S.temp = n('t', S.temp); S.alt = n('a', S.alt); S.rh = n('h', S.rh);
  S.lat = n('lat', S.lat); S.az = n('az', S.az); S.t0 = n('ts', S.t0);
  if (Q.has('w')) {
    const ls = Q.get('w').split(';').map((x) => x.split(',').map(Number));
    if (ls.length >= 1 && ls.every((l) => l.length === 3 && l.every(Number.isFinite))) {
      S.same = ls.length === 1;
      S.layers = [0, 1, 2].map((i) => layer(...(ls[Math.min(i, ls.length - 1)])));
    }
  }
  if (Q.has('cw')) {
    const v = Q.get('cw').split(',').map(Number);
    if (v.length === 2 && v.every(Number.isFinite)) { S.callTrue = false; S.call = layer(v[0], v[1]); } else S.callTrue = true;
  }
  if (Q.has('f')) { const f = Q.get('f'); S.spin = f.includes('s'); S.earth = f.includes('e'); S.solver = f.includes('k'); }
  autoFire = Q.has('fire');
})();

// ---------- Physics through the engine ----------
const isaPressure = (h) => 101325 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
const ci = () => cartIndex(S.c);
const sightHeight = () => (rifleRaw(S.c)?.sight_height_in ?? 1.5) * IN;
const twist = () => { const r = rifleRaw(S.c); return r ? r.twist_in * IN * (r.twist_direction === 'left' ? -1 : 1) : 0; };

function station() { B.bd_station(isaPressure(S.alt), S.temp + 273.15, S.rh / 100, S.alt); }
function setup(forDope) {
  let f = 0;
  if (S.spin && (!forDope || S.solver)) f |= 1;
  if (S.earth && (!forDope || S.solver)) f |= 2;
  B.bd_setup(twist(), S.lat * DEG, f);
}
const trueLayers = () => {
  const n = S.same ? 1 : 3;
  return S.layers.slice(0, n).map((L, i) => ({ fromRange: (i * S.dist) / 3, speed: L.spd * KMH, fromBearing: (S.az + L.clock * 30) * DEG, gust: L.gust * KMH }));
};
// The average true wind along the range (what a perfect call would be).
function averageWind() {
  const n = S.same ? 1 : 3;
  let x = 0, y = 0;
  for (let i = 0; i < n; ++i) {
    const L = S.layers[i];
    x += (L.spd * Math.sin(L.clock * 30 * DEG)) / n;  // across: + from the right
    y += (L.spd * Math.cos(L.clock * 30 * DEG)) / n;  // along: + head wind
  }
  let clock = Math.atan2(x, y) / DEG / 30;
  if (clock <= 0) clock += 12;
  return layer(Math.hypot(x, y), Math.round(clock * 2) / 2);
}
const call = () => (S.callTrue ? averageWind() : S.call);
const callLayers = () => { const c = call(); return [{ fromRange: 0, speed: c.spd * KMH, fromBearing: (S.az + c.clock * 30) * DEG, gust: 0 }]; };

// ENU <-> the line of fire (downrange d, right r, up u) <-> three.js (x right, y up, -z downrange).
function lof(p) {
  const s = Math.sin(S.az * DEG), c = Math.cos(S.az * DEG);
  return { d: p[0] * s + p[1] * c, r: p[0] * c - p[1] * s, u: p[2] };
}
function enu(d, r, u) {
  const s = Math.sin(S.az * DEG), c = Math.cos(S.az * DEG);
  return [d * s + r * c, d * c - r * s, u];
}
const v3 = (p) => { const l = lof(p); return new THREE.Vector3(l.r, l.u, -l.d); };

// The shooter's solution: holds for the called wind (and, if ticked, the
// spin and the Earth), and a dope card.
function solveDope() {
  station();
  setup(true);
  B.wind(S.az * DEG, callLayers());
  const step = S.dist <= 600 ? 50 : S.dist <= 1200 ? 100 : 200;
  const rows = B.table(ci(), ZERO, sightHeight(), Math.max(S.dist, step), step, S.az * DEG);
  const at = B.table(ci(), ZERO, sightHeight(), S.dist, S.dist, S.az * DEG).at(-1);
  const hold = at && at.range > 0 ? { up: -at.drop / S.dist, right: -at.windage / S.dist } : { up: 0, right: 0 };
  return { rows, hold };
}

// What each effect does at the target, from separate flights in the true air.
function breakdown() {
  const at = (flags, wind) => {
    station();
    B.bd_setup(twist(), S.lat * DEG, flags);
    B.wind(S.az * DEG, wind ? trueLayers() : []);
    return B.table(ci(), ZERO, sightHeight(), S.dist, S.dist, S.az * DEG).at(-1) ?? { drop: 0, windage: 0 };
  };
  const base = at(0, false), wind = at(0, true);
  const out = [{ k: 'Gravity & drag', up: base.drop, right: 0 }, { k: 'Wind', up: wind.drop - base.drop, right: wind.windage }];
  if (S.spin) {
    const spin = at(1, false), spinWind = at(1, true);
    out.push({ k: 'Spin drift', up: spin.drop - base.drop, right: spin.windage });
    out.push({ k: 'Aero jump', up: spinWind.drop - spin.drop - (wind.drop - base.drop), right: 0 });
  }
  if (S.earth) {
    const e = at(2, false);
    out.push({ k: 'Coriolis', up: 0, right: e.windage });
    out.push({ k: 'Eötvös', up: e.drop - base.drop, right: 0 });
  }
  return out;
}

// The flight: holds applied, fired through the true wind, flown to the end
// first ("fly first, then show": docs/bullet-time.md in the engine).
let shot = null;
function fire() {
  const dope = solveDope();
  station();
  setup(false);
  B.wind(S.az * DEG, trueLayers());
  const e0 = B.bd_zero(ci(), ZERO, sightHeight());
  const el = e0 + dope.hold.up, az = S.az * DEG + dope.hold.right;
  if (!Number.isFinite(e0) || !B.bd_fire(ci(), 0, 0, 0, az, el, S.t0)) { toast('This load cannot reach the zero.'); return null; }
  // Fly to the target plane, then on to the ground.
  const t0 = S.t0;
  let t = t0, r = B.round();
  while (!r.stopped && t - t0 < 25) {
    t += 0.05;
    B.bd_advance(t, 0);
    r = B.round();
    const l = lof(r.position);
    if (l.d > S.dist + 1 && l.u < -BENCH) break;
    if (l.d > S.dist * 1.6 + 50) break;
  }
  const tEnd = r.time;
  const downrange = (tt) => lof(B.stateAt(tt).position).d;
  const bisect = (f, a, b) => { for (let k = 0; k < 60; ++k) { const m = 0.5 * (a + b); if (f(m)) b = m; else a = m; } return 0.5 * (a + b); };
  const reaches = downrange(tEnd) >= S.dist;
  let tTarget = reaches ? bisect((tt) => downrange(tt) >= S.dist, t0, tEnd) : null;
  const sh = sightHeight();
  let hit = false, impact = null;
  if (tTarget !== null) {
    const p = lof(B.stateAt(tTarget).position);
    impact = { right: p.r, up: p.u - sh };
    // Hit only if it reached the plane above the ground.
    const above = p.u > -BENCH;
    hit = above && Math.abs(impact.right) <= S.size / 2 && Math.abs(impact.up) <= S.size / 2;
    if (!above) tTarget = null;
  }
  // Where it lands if it misses: the ground.
  let tGround = null;
  if (!hit) {
    const below = (tt) => B.stateAt(tt).position[2] <= -BENCH;
    if (below(tEnd)) tGround = bisect(below, t0, tEnd);
  }
  const tStop = hit ? tTarget : tGround ?? tEnd;
  const air = B.air(0, 0, 0, t0);
  const sg = S.spin ? B.bd_stability(ci()) : 0;
  const atT = tTarget !== null ? B.stateAt(tTarget) : null;
  shot = {
    S: structuredClone(S), dope, t0, tEnd, tTarget, tGround, tStop, hit, impact, air, sg,
    round: B.round(), atTarget: atT, muzzleSpeed: Math.hypot(...B.stateAt(t0).velocity),
    bars: breakdown(),
  };
  // breakdown() reset the engine's air and wind: fly the shot again so the
  // round in the engine is this one (the same inputs give the same bits).
  station();
  setup(false);
  B.wind(S.az * DEG, trueLayers());
  B.bd_fire(ci(), 0, 0, 0, az, el, t0);
  B.bd_advance(tEnd + 0.002, 0);
  return shot;
}

// ---------- Renderer ----------
const canvas = $('view');
let R;
try {
  R = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
} catch (e) {
  $('loadMsg').textContent = 'This page needs WebGL: ' + e.message;
  throw e;
}
R.outputColorSpace = THREE.SRGBColorSpace;
R.toneMapping = THREE.ACESFilmicToneMapping;
R.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xb9c8d6, 1500, 6500);
const camera = new THREE.PerspectiveCamera(55, 1, 0.005, 12000);
const scopeCam = new THREE.PerspectiveCamera(3, 1, 0.5, 12000);

// Sky.
const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: 'varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: 'varying vec3 vp; void main(){ float h = normalize(vp).y; vec3 c = mix(vec3(0.74,0.80,0.86), vec3(0.28,0.47,0.74), smoothstep(0.0,0.5,h)); c = mix(vec3(0.55,0.52,0.45), c, smoothstep(-0.05,0.01,h)); gl_FragColor = vec4(c,1.); }',
}));
scene.add(sky);
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a5238, 1.1));
const sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
sun.position.set(-300, 600, 200);
scene.add(sun);

// Ground: mown grass with stripes every 25 m.
function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#5f7a3a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; ++i) {
    const v = 70 + Math.random() * 60;
    g.fillStyle = `rgba(${v * 0.75 | 0},${v | 0},${v * 0.45 | 0},0.35)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 3);
  }
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, 0, 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const gtex = grassTexture();
gtex.repeat.set(160, 300);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 7500), new THREE.MeshLambertMaterial({ map: gtex }));
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, -BENCH, -3500);
scene.add(ground);

// Text sprites.
function label(text, h = 1.6, color = '#ffffff', bg = 'rgba(10,17,28,0.75)') {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = '700 52px "JetBrains Mono", monospace';
  const w = Math.ceil(g.measureText(text).width) + 36;
  c.width = w; c.height = 76;
  g.font = '700 52px "JetBrains Mono", monospace';
  g.fillStyle = bg;
  g.fillRect(0, 0, w, 76);
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 18, 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false }));
  s.scale.set((h * w) / 76, h, 1);
  return s;
}

// The range furniture, rebuilt when the distance or the units change.
const range = new THREE.Group();
scene.add(range);
const flags = [];
const steel = new THREE.MeshStandardMaterial({ color: 0xff6a1a, emissive: 0x401400, metalness: 0.2, roughness: 0.6 });  // hi-vis painted steel
const paint = new THREE.MeshStandardMaterial({ color: 0xf6f6f6, roughness: 0.8 });
const wood = new THREE.MeshLambertMaterial({ color: 0x6b4e2e });
const poleMat = new THREE.MeshLambertMaterial({ color: 0xd8d8d8 });
const flagMat = new THREE.MeshLambertMaterial({ color: 0xff5a2a, side: THREE.DoubleSide });
let target = null, plate = null, hitMarks = [];
function buildRange() {
  range.clear();
  flags.length = 0;
  hitMarks = [];
  const D = S.dist;
  // Distance boards on the left.
  const unit = metric ? 1 : YD;
  const every = (metric ? D : D / YD) <= 1200 ? 100 : 250;
  for (let k = every; k * unit <= D + 600; k += every) {
    const s = label(`${k} ${metric ? 'm' : 'yd'}`, 1.2 + (k * unit) / 900);
    s.position.set(-14 - (k * unit) / 150, -BENCH + 2.2 + (k * unit) / 600, -k * unit);
    range.add(s);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2, 6), wood);
    post.position.set(s.position.x, -BENCH + 1, s.position.z);
    range.add(post);
  }
  // Wind flags on the right, every 100 m (200 m past 1 km).
  const fe = D <= 1000 ? 100 : 200;
  for (let d = fe / 2; d < D; d += fe) {
    const g = new THREE.Group();
    const x = 9 + d / 120;
    g.position.set(x, -BENCH, -d);
    const scale = 1 + d / 1200;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * scale, 0.05 * scale, 4 * scale, 6), poleMat);
    pole.position.y = 2 * scale;
    g.add(pole);
    const pivot = new THREE.Group();
    pivot.position.y = 4 * scale;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.4 * scale, 0.5 * scale, 6, 1), flagMat);
    cloth.position.x = 0.7 * scale;
    cloth.position.y = -0.25 * scale;
    pivot.add(cloth);
    g.add(pivot);
    range.add(g);
    flags.push({ g, pivot, cloth, d, r: x, scale, geo0: cloth.geometry.attributes.position.array.slice() });
  }
  // The target: a steel plate with a painted ring, hung from a frame, a berm behind.
  target = new THREE.Group();
  target.position.set(0, sightHeight(), -D);
  const sz = S.size;
  plate = new THREE.Group();
  plate.position.y = sz / 2;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(sz, sz, 0.02), steel);
  slab.position.y = -sz / 2;
  plate.add(slab);
  const ring = new THREE.Mesh(new THREE.RingGeometry(sz * 0.18, sz * 0.24, 40), paint);
  ring.position.set(0, -sz / 2, 0.011);
  plate.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(sz * 0.05, 24), paint);
  dot.position.set(0, -sz / 2, 0.011);
  plate.add(dot);
  target.add(plate);
  const legH = sightHeight() + BENCH + sz / 2 + 0.1;
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, legH, 0.08), wood);
    leg.position.set(sx * (sz / 2 + 0.15), sz / 2 + 0.1 - legH / 2, -0.05);
    target.add(leg);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(sz + 0.38, 0.08, 0.08), wood);
  bar.position.set(0, sz / 2 + 0.1, -0.05);
  target.add(bar);
  range.add(target);
  const berm = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x9a8a68 }));
  berm.scale.set(30 + D / 50, 3 + D / 1000, 12);
  berm.position.set(0, -BENCH, -D - 30);
  range.add(berm);
}

// The rifle on its bench.
const rifle = new THREE.Group();
{
  const metal = new THREE.MeshStandardMaterial({ color: 0x1d2024, metalness: 0.6, roughness: 0.5 });
  const tan = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.8 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.65, 16), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = 0.325;
  rifle.add(barrel);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.75), tan);
  stock.position.set(0, -0.04, 0.95);
  rifle.add(stock);
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.022, 0.36, 16), metal);
  scope.rotation.x = Math.PI / 2;
  scope.name = 'scope';
  rifle.add(scope);
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 1.6), wood);
  bench.position.set(0.1, -0.1, 0.9);
  rifle.add(bench);
  for (const [x, z] of [[-0.3, 0.3], [0.5, 0.3], [-0.3, 1.6], [0.5, 1.6]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, BENCH - 0.13, 0.07), wood);
    leg.position.set(x, -0.13 - (BENCH - 0.13) / 2, z);
    rifle.add(leg);
  }
}
scene.add(rifle);
function placeRifle() { rifle.getObjectByName('scope').position.set(0, sightHeight(), 0.75); }

// The bullet: true size, copper, with the rifling's engraving so the spin shows.
const bullet = new THREE.Group();
const bulletBody = new THREE.Group();
bullet.add(bulletBody);
function buildBullet() {
  bulletBody.clear();
  const p = projRaw(S.c);
  const d = p.diameter_in * IN, L = p.length_in * IN;
  const copper = new THREE.MeshStandardMaterial({ color: 0xc27a45, metalness: 0.85, roughness: 0.28 });
  const groove = new THREE.MeshStandardMaterial({ color: 0x6b3a1c, metalness: 0.6, roughness: 0.5 });
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d * 0.42, L * 0.45, 24), copper);
  shank.rotation.x = Math.PI / 2;
  shank.position.z = -L * 0.05;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(d / 2, L * 0.55, 24), copper);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = L * 0.45;
  bulletBody.add(shank, nose);
  const grooves = (RIFLE_FOR[S.c] === 'm24_sws') ? 5 : 6;
  for (let k = 0; k < grooves; ++k) {
    const a = (k / grooves) * Math.PI * 2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(d * 0.12, d * 0.04, L * 0.42), groove);
    m.position.set(Math.cos(a) * d * 0.5, Math.sin(a) * d * 0.5, -L * 0.05);
    m.rotation.z = a;
    bulletBody.add(m);
  }
  bullet.userData.length = L;
  bullet.userData.diameter = d;
}
bullet.visible = false;
scene.add(bullet);
// The shock cone (Mach angle) and the trail.
const shock = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 32, 1, true), new THREE.MeshBasicMaterial({
  color: 0xdbe8ff, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
shock.visible = false;
scene.add(shock);
const TRAIL = 160;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
trail.frustumCulled = false;
scene.add(trail);
const pathGeo = new THREE.BufferGeometry();
const path = new THREE.Line(pathGeo, new THREE.LineDashedMaterial({ color: 0xffd36b, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.55 }));
path.frustumCulled = false;
scene.add(path);
// Muzzle flash and the dust of a miss.
const flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0 }));
scene.add(flash);
const dust = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshLambertMaterial({ color: 0xb59a74, transparent: true, opacity: 0 }));
scene.add(dust);

// ---------- Scope: render target, mirage, reticle ----------
const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
const post = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const mirage = new THREE.ShaderMaterial({
  uniforms: { tex: { value: rt.texture }, t: { value: 0 }, amp: { value: 0.0006 }, drift: { value: 0 }, aspect: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    uniform sampler2D tex; uniform float t, amp, drift, aspect; varying vec2 vUv;
    void main(){
      vec2 p = vUv;
      // Heat shimmer: rising, boiling waves that lean and run with the crosswind.
      float w1 = sin(p.y * 260. + t * 5.1 - p.x * 60. * drift + drift * t * 9.);
      float w2 = sin(p.y * 170. - t * 3.7 + p.x * 90. + drift * t * 6.);
      p.x += amp * (0.6 * w1 + 0.4 * w2);
      p.y += amp * 0.5 * sin(p.x * 210. + t * 4.3);
      vec3 c = texture2D(tex, p).rgb;
      vec2 q = (vUv - 0.5) * vec2(aspect, 1.);
      float r = length(q);
      float tube = smoothstep(0.47, 0.455, r);
      c *= tube * (1. - 0.25 * smoothstep(0.3, 0.46, r));
      gl_FragColor = vec4(c, 1.);
    }`,
});
post.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mirage));
const ret = $('reticle'), rg = ret.getContext('2d');
let magnification = 20;
const magFor = (d) => Math.max(6, Math.min(25, Math.round(d / 45)));
const scopeFov = () => 35 / magnification;  // degrees, vertical (a typical riflescope's field)

function drawReticle(dope) {
  const w = ret.width, h = ret.height, dpr = window.devicePixelRatio || 1;
  rg.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const pxPerMil = (h / (scopeFov() * DEG)) * 1e-3;
  const R0 = Math.min(w, h) * 0.455;
  rg.save();
  rg.beginPath();
  rg.arc(cx, cy, R0, 0, Math.PI * 2);
  rg.clip();
  rg.strokeStyle = 'rgba(8,8,8,0.92)';
  rg.fillStyle = 'rgba(8,8,8,0.92)';
  rg.lineWidth = 1.4 * dpr;
  rg.beginPath();
  rg.moveTo(cx - R0, cy); rg.lineTo(cx + R0, cy);
  rg.moveTo(cx, cy - R0); rg.lineTo(cx, cy + R0);
  rg.stroke();
  rg.lineWidth = 3.5 * dpr;
  rg.beginPath();
  rg.moveTo(cx - R0, cy); rg.lineTo(cx - pxPerMil * 10, cy);
  rg.moveTo(cx + pxPerMil * 10, cy); rg.lineTo(cx + R0, cy);
  rg.moveTo(cx, cy + pxPerMil * 10); rg.lineTo(cx, cy + R0);
  rg.stroke();
  rg.lineWidth = 1.2 * dpr;
  rg.font = `600 ${10 * dpr}px "JetBrains Mono", monospace`;
  for (let m = -10; m <= 10; m += 0.5) {
    if (m === 0) continue;
    const L = (Number.isInteger(m) ? (m % 5 === 0 ? 9 : 6) : 3) * dpr;
    rg.beginPath();
    rg.moveTo(cx + m * pxPerMil, cy - L); rg.lineTo(cx + m * pxPerMil, cy + L);
    rg.moveTo(cx - L, cy + m * pxPerMil); rg.lineTo(cx + L, cy + m * pxPerMil);
    rg.stroke();
    if (Number.isInteger(m) && m % 2 === 0) {
      rg.fillText(String(Math.abs(m)), cx + m * pxPerMil - 4 * dpr, cy + 22 * dpr);
      if (m > 0) rg.fillText(String(m), cx + 12 * dpr, cy + m * pxPerMil + 4 * dpr);
    }
  }
  // The wind hold: where the shooter puts the target on the reticle.
  if (dope) {
    const hx = cx - (dope.hold.right / 1e-3) * pxPerMil;
    rg.strokeStyle = '#ff3b2f';
    rg.lineWidth = 2 * dpr;
    rg.beginPath();
    rg.arc(hx, cy, 5 * dpr, 0, Math.PI * 2);
    rg.stroke();
  }
  rg.restore();
  rg.fillStyle = 'rgba(231,236,242,0.95)';
  rg.font = `600 ${12 * dpr}px "JetBrains Mono", monospace`;
  rg.textAlign = 'center';
  if (dope) {
    const el = dope.hold.up / 1e-3, wd = dope.hold.right / 1e-3;
    rg.fillText(`${magnification}×   dialled ${el >= 0 ? 'up' : 'down'} ${fmtAngle(Math.abs(el))}   hold ${Math.abs(wd) < 0.05 ? 'centre' : fmtAngle(Math.abs(wd)) + (wd > 0 ? ' right' : ' left')}`, cx, cy + R0 + 20 * dpr);
  }
  rg.textAlign = 'start';
}
const fmtAngle = (mil) => (dopeMil ? `${mil.toFixed(1)} mil` : `${(mil * 3.4377).toFixed(1)} MOA`);

// ---------- Cameras ----------
const CAMS = [['scope', 'Scope'], ['shooter', 'Shooter'], ['bullet', 'Bullet'], ['target', 'Target']];
let cam = 'scope';
let orbit = { yaw: 0, pitch: 0 };
function setCam(c) {
  cam = c;
  for (const b of $('cams').children) b.setAttribute('aria-pressed', String(b.dataset.c === c));
  ret.style.display = c === 'scope' ? 'block' : 'none';
}

// ---------- Time ----------
let te = 0;          // engine time since the shot (s)
let scale = 1;       // manual playback speed
let auto = true;     // bullet time
let phase = 'idle';  // idle | flight | after
let afterWall = 0;
function autoScale() {
  if (!shot) return 1;
  const tof = (shot.tStop - shot.t0);
  const cruise = Math.min(1, Math.max(0.01, tof / 7));
  const st = B.stateAt(shot.t0 + te);
  const d = lof(st.position).d;
  const rem = Math.max(0, (shot.hit ? S.dist : lof(B.stateAt(shot.tStop).position).d) - d);
  const sm = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  const fromMuzzle = 0.003 + (cruise - 0.003) * sm(1, 40, d);
  const toEnd = 0.0004 + (cruise - 0.0004) * sm(0.5, 35, rem);
  return Math.min(fromMuzzle, toEnd);
}

// ---------- Sound ----------
let ac = null, soundOn = store.get('sound', true);
function audio() {
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { ac = null; } }
  return ac;
}
function noiseBurst(dur, freq, gain, q = 0.7) {
  const a = audio();
  if (!a || !soundOn) return;
  const n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), ch = buf.getChannelData(0);
  for (let i = 0; i < n; ++i) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = q; g.gain.value = gain;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}
function ping() {
  const a = audio();
  if (!a || !soundOn) return;
  for (const [f, d] of [[1830, 1.2], [2710, 0.8], [4130, 0.5]]) {
    const o = a.createOscillator(), g = a.createGain();
    o.frequency.value = f; g.gain.setValueAtTime(0.12, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + d);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + d);
  }
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { const a = audio(); if (a && a.state === 'suspended') a.resume(); }, { capture: true });

// ---------- UI ----------
const fmtDist = (m) => (metric ? `${Math.round(m).toLocaleString()} m` : `${Math.round(m / YD).toLocaleString()} yd`) + (Math.abs(m - 1609) < 6 ? ' · 1 mile' : Math.abs(m - 3219) < 8 ? ' · 2 miles' : '');
const fmtSpeedW = (kmh) => (metric ? `${kmh.toFixed(1)} km/h` : `${(kmh / 1.609344).toFixed(1)} mph`);
const fmtV = (ms) => (metric ? `${ms.toFixed(0)} m/s` : `${(ms / FT).toFixed(0)} ft/s`);
const fmtLen = (m) => (metric ? `${(m * 100).toFixed(1)} cm` : `${(m / IN).toFixed(1)} in`);
const fmtT = (c) => (metric ? `${c.toFixed(0)} °C` : `${(c * 1.8 + 32).toFixed(0)} °F`);
const fmtAlt = (m) => (metric ? `${m.toFixed(0)} m` : `${(m / FT).toFixed(0)} ft`);
const clockName = (c) => `${c % 1 ? c.toFixed(1) : c} o'clock`;

function presetsUI() {
  const box = $('presets');
  box.innerHTML = '';
  for (const p of SCENARIOS) {
    const b = document.createElement('button');
    if (p.feature) b.className = 'feature';
    b.innerHTML = `${p.name}<small>${p.sub}</small>`;
    b.onclick = () => { Object.assign(S, structuredClone(p.s)); S.t0 = 10; syncUI(); changed(true); refresh(); fireNow(); };
    box.appendChild(b);
  }
}
function layersUI() {
  const box = $('layers');
  box.innerHTML = '';
  const n = S.same ? 1 : 3;
  const names = S.same ? ['Wind'] : ['Near third', 'Middle third', 'Far third'];
  for (let i = 0; i < n; ++i) {
    const L = S.layers[i];
    const d = document.createElement('div');
    d.className = 'layer';
    d.innerHTML = `<div class="eyebrow">${names[i]}</div>
      <div class="slider"><span>Speed</span><b>${fmtSpeedW(L.spd)}</b><input type="range" min="0" max="50" step="0.5" value="${L.spd}" data-k="spd" aria-label="${names[i]} wind speed"></div>
      <div class="slider"><span>From</span><b>${clockName(L.clock)}</b><input type="range" min="0" max="12" step="0.5" value="${L.clock}" data-k="clock" aria-label="${names[i]} wind direction"></div>
      <div class="slider"><span>Gusts (RMS)</span><b>${fmtSpeedW(L.gust)}</b><input type="range" min="0" max="12" step="0.5" value="${L.gust}" data-k="gust" aria-label="${names[i]} gusts"></div>`;
    for (const inp of d.querySelectorAll('input')) {
      inp.oninput = () => {
        const v = +inp.value;
        if (S.same) for (const l of S.layers) l[inp.dataset.k] = v; else L[inp.dataset.k] = v;
        inp.previousElementSibling.textContent = inp.dataset.k === 'clock' ? clockName(v) : fmtSpeedW(v);
        changed();
      };
    }
    box.appendChild(d);
  }
}
function syncUI() {
  const sel = $('cartridge');
  if (!sel.options.length)
    for (const c of cat.cartridges) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.appendChild(o); }
  sel.value = S.c;
  $('dist').value = S.dist; $('size').value = S.size; $('temp').value = S.temp; $('alt').value = S.alt; $('rh').value = S.rh;
  $('lat').value = S.lat; $('az').value = S.az;
  $('sameWind').checked = S.same; $('callTrue').checked = S.callTrue; $('callBox').hidden = S.callTrue;
  $('callSpd').value = S.call.spd; $('callDir').value = S.call.clock;
  $('fSpin').checked = S.spin; $('fEarth').checked = S.earth; $('fSolver').checked = S.solver;
  $('bUnits').textContent = metric ? 'Metric' : 'Imperial';
  $('bDopeUnit').textContent = dopeMil ? 'MIL' : 'MOA';
  layersUI();
  labels();
}
function labels() {
  const r = raw.rifles.find((x) => x.id === RIFLE_FOR[S.c]);
  const c = cat.cartridges[ci()];
  $('loadDesc').textContent = `${fmtV(c.muzzleVelocity)} from ${r ? r.name : 'its rifle'}, 1:${r ? r.twist_in : '?'} in ${r && r.twist_direction === 'left' ? 'left' : 'right'}-hand twist, scope ${fmtLen(sightHeight())} over the bore.`;
  $('vDist').textContent = fmtDist(S.dist);
  $('vSize').textContent = fmtLen(S.size) + ` · ${(S.size / S.dist * 1000).toFixed(2)} mil`;
  $('vTemp').textContent = fmtT(S.temp);
  $('vAlt').textContent = `${fmtAlt(S.alt)} · ${(isaPressure(S.alt) / 100).toFixed(0)} hPa`;
  $('vRh').textContent = `${S.rh} %`;
  $('vLat').textContent = `${Math.abs(S.lat).toFixed(1)}° ${S.lat >= 0 ? 'N' : 'S'}`;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  $('vAz').textContent = `${S.az}° · ${dirs[Math.round(S.az / 45) % 8]}`;
  const cw = call();
  $('vCallSpd').textContent = fmtSpeedW(S.call.spd);
  $('vCallDir').textContent = clockName(S.call.clock);
  if (S.callTrue) $('callBox').hidden = true;
  $('callTrue').nextSibling.textContent = ` Call the average true wind exactly (${fmtSpeedW(cw.spd)} from ${clockName(cw.clock)})`;
}

let dope = null, dopeTimer = 0;
function changed(rebuild = false) {
  labels();
  clearTimeout(dopeTimer);
  dopeTimer = setTimeout(refresh, rebuild ? 0 : 90);
  if (rebuild) { buildRange(); buildBullet(); placeRifle(); magnification = magFor(S.dist); }
}
// The dope for the call, then the true air back in the engine for the flags.
function refresh() {
  clearTimeout(dopeTimer);
  {
    dope = solveDope();
    dopeUI();
    // The engine's air now shows the true wind (for the flags).
    station();
    setup(false);
    B.wind(S.az * DEG, trueLayers());
    const a = B.air(0, 0, 0, 0);
    $('daInfo').textContent = `ρ ${a.density.toFixed(3)} kg/m³ · DA ${fmtAlt(a.densityAltitude)}`;
    const sg = S.spin ? B.bd_stability(ci()) : 0;
    $('sgInfo').textContent = S.spin ? `Sg ${sg.toFixed(2)}${sg < 1 ? ' · unstable' : sg < 1.4 ? ' · marginal' : ''}` : '';
    // New air or wind replaced the round in the engine: the last shot is gone.
    phase = 'idle'; shot = null; bullet.visible = false; path.visible = false;
  }
}
function dopeUI() {
  const t = $('dope');
  const k = dopeMil ? 1e3 : 1e3 * 3.4377;
  $('dopeWhat').textContent = `${dopeMil ? 'mil' : 'MOA'} · call ${fmtSpeedW(call().spd)} from ${clockName(call().clock)}`;
  let h = `<tr><th>${metric ? 'm' : 'yd'}</th><th>Elev</th><th>Wind</th><th>${metric ? 'm/s' : 'ft/s'}</th><th>s</th></tr>`;
  for (const r of dope.rows) {
    if (r.range <= 0) continue;
    const el = (-r.drop / r.range) * k, wd = (-r.windage / r.range) * k;
    h += `<tr class="${Math.abs(r.range - S.dist) < 1 ? 'at' : ''}"><td>${(metric ? r.range : r.range / YD).toFixed(0)}</td><td>${el.toFixed(1)}</td><td>${Math.abs(wd).toFixed(1)}${wd > 0.05 ? 'R' : wd < -0.05 ? 'L' : ''}</td><td>${(metric ? r.speed : r.speed / FT).toFixed(0)}</td><td>${r.time.toFixed(2)}</td></tr>`;
  }
  t.innerHTML = h;
}

function resultsUI() {
  if (!shot) return;
  const o = $('outcome');
  const sh = shot;
  const mil = (m) => ((m / S.dist) * 1e3).toFixed(2);
  if (sh.hit) {
    o.className = 'ok';
    o.textContent = `Hit: ${fmtLen(Math.abs(sh.impact.right))} ${sh.impact.right >= 0 ? 'right' : 'left'}, ${fmtLen(Math.abs(sh.impact.up))} ${sh.impact.up >= 0 ? 'high' : 'low'}.`;
  } else if (sh.impact) {
    o.className = 'bad';
    o.textContent = `Miss: ${fmtLen(Math.abs(sh.impact.right))} ${sh.impact.right >= 0 ? 'right' : 'left'}, ${fmtLen(Math.abs(sh.impact.up))} ${sh.impact.up >= 0 ? 'high' : 'low'} of centre.`;
  } else {
    o.className = 'bad';
    o.textContent = 'The round never reached the target: it hit the ground short.';
  }
  $('rWhat').textContent = `${fmtDist(S.dist)}`;
  const at = sh.atTarget;
  const kv = [];
  if (sh.impact) kv.push(['Off centre', `${mil(sh.impact.right)} R, ${mil(sh.impact.up)} U mil`]);
  if (at) {
    const v = Math.hypot(...at.velocity), m = projRaw(S.c).mass_gr * 6.479891e-5;
    const a = B.air(at.position[0], at.position[1], at.position[2], at.time);
    kv.push(['Time of flight', `${(sh.tTarget - sh.t0).toFixed(3)} s`]);
    kv.push(['Speed at the target', `${fmtV(v)} · Mach ${(v / a.speedOfSound).toFixed(2)}`]);
    kv.push(['Energy', metric ? `${(0.5 * m * v * v).toFixed(0)} J` : `${(0.5 * m * v * v / 1.3558).toFixed(0)} ft·lbf`]);
    kv.push(['Spin at the target', `${(at.spin / (2 * Math.PI)).toFixed(0)} turns/s`]);
    const lag = (sh.tTarget - sh.t0) - S.dist / a.speedOfSound;
    kv.push(['The report reaches the target', `${Math.abs(lag).toFixed(2)} s ${lag > 0 ? 'before' : 'after'} the round`]);
  }
  kv.push(['Muzzle', `${fmtV(sh.muzzleSpeed)} · Mach ${(sh.muzzleSpeed / sh.air.speedOfSound).toFixed(2)}`]);
  if (S.spin) kv.push(['Stability Sg', `${sh.sg.toFixed(2)} → ${sh.round.stability.toFixed(2)}${sh.round.tumbling ? ' · TUMBLED' : ''}`]);
  if (sh.round.subsonicTime > 0) {
    const st = B.stateAt(sh.t0 + sh.round.subsonicTime);
    kv.push(['Went subsonic at', fmtDist(lof(st.position).d)]);
  }
  kv.push(['Holds used', `${fmtAngle(sh.dope.hold.up / 1e-3)} up · ${fmtAngle(Math.abs(sh.dope.hold.right / 1e-3))} ${sh.dope.hold.right >= 0 ? 'R' : 'L'}`]);
  kv.push(['Air', `${fmtT(S.temp)} · ${(isaPressure(S.alt) / 100).toFixed(0)} hPa · DA ${fmtAlt(sh.air.densityAltitude)}`]);
  $('kv').innerHTML = kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
  // What moved it.
  const all = sh.bars.flatMap((b) => [Math.abs(b.up), Math.abs(b.right)]);
  const big = Math.max(...all, 1e-6);
  let h = '';
  for (const b of sh.bars) {
    const parts = [];
    if (Math.abs(b.right) >= 0.0005) parts.push({ v: b.right, s: b.right >= 0 ? 'R' : 'L' });
    if (Math.abs(b.up) >= 0.0005) parts.push({ v: b.up, s: b.up >= 0 ? 'U' : 'D' });
    for (const p of parts)
      h += `<div><span>${b.k}</span><i class="${p.v < 0 ? 'neg' : ''}" style="width:${Math.max(1, (Math.sqrt(Math.abs(p.v) / big) * 100)).toFixed(1)}%"></i><b>${fmtLen(Math.abs(p.v))} ${p.s}</b></div>`;
  }
  $('bars').innerHTML = h || '<div><span>Nothing</span></div>';
}

function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2400); }
function banner(a, b) { $('bTitle').textContent = a; $('bSub').textContent = b; $('banner').classList.add('on'); clearTimeout(banner.t); banner.t = setTimeout(() => $('banner').classList.remove('on'), 3200); }

function fireNow() {
  if (dopeTimer) refresh();  // settings still pending: apply them first
  if (!fire()) return;
  te = 0;
  phase = 'flight';
  bullet.visible = true;
  hitMarks.forEach((m) => target.remove(m));
  hitMarks = [];
  plate.rotation.x = 0;
  plate.userData.swing = 0;
  flash.material.opacity = 1;
  dust.material.opacity = 0;
  noiseBurst(0.5, 2200, 0.5);
  if (auto) setCam('bullet');
  resultsUI();
  // The dashed path of the whole flight, for the scope and shooter views.
  const pts = [];
  for (let t = shot.t0; t <= shot.tStop; t += Math.max(0.002, (shot.tStop - shot.t0) / 400)) pts.push(v3(B.stateAt(t).position));
  pts.push(v3(B.stateAt(shot.tStop).position));
  pathGeo.setFromPoints(pts);
  path.computeLineDistances();
  path.visible = false;
  S.t0 = shot.t0 + 7.3;  // the next shot meets the gusts at another moment
}

$('cartridge').onchange = (e) => { S.c = e.target.value; changed(true); };
for (const [id, k, rebuild] of [['dist', 'dist', true], ['size', 'size', true], ['temp', 'temp'], ['alt', 'alt'], ['rh', 'rh'], ['lat', 'lat'], ['az', 'az']])
  $(id).oninput = (e) => { S[k] = +e.target.value; changed(!!rebuild); };
$('sameWind').onchange = (e) => { S.same = e.target.checked; if (S.same) for (const l of S.layers) Object.assign(l, S.layers[0]); layersUI(); changed(); };
$('callTrue').onchange = (e) => { S.callTrue = e.target.checked; if (!S.callTrue) S.call = averageWind(); syncUI(); changed(); };
$('callSpd').oninput = (e) => { S.call.spd = +e.target.value; changed(); };
$('callDir').oninput = (e) => { S.call.clock = +e.target.value; changed(); };
$('fSpin').onchange = (e) => { S.spin = e.target.checked; changed(); };
$('fEarth').onchange = (e) => { S.earth = e.target.checked; changed(); };
$('fSolver').onchange = (e) => { S.solver = e.target.checked; changed(); };
$('fire').onclick = () => fireNow();
$('bReplay').onclick = () => { if (!shot) return; te = 0; phase = 'flight'; bullet.visible = true; plate.rotation.x = 0; dust.material.opacity = 0; flash.material.opacity = 1; noiseBurst(0.5, 2200, 0.5); if (auto) setCam('bullet'); };
$('bAuto').onclick = () => { auto = !auto; $('bAuto').setAttribute('aria-pressed', String(auto)); };
$('bSound').onclick = () => { soundOn = !soundOn; store.set('sound', soundOn); $('bSound').setAttribute('aria-pressed', String(soundOn)); };
$('bSound').setAttribute('aria-pressed', String(soundOn));
$('bUnits').onclick = () => { metric = !metric; store.set('metric', metric); syncUI(); changed(true); resultsUI(); };
$('bDopeUnit').onclick = () => { dopeMil = !dopeMil; store.set('dopeMil', dopeMil); syncUI(); dopeUI(); resultsUI(); };
$('bHelp').onclick = () => $('help').classList.add('on');
$('bHelpClose').onclick = () => $('help').classList.remove('on');
$('help').onclick = (e) => { if (e.target.id === 'help') $('help').classList.remove('on'); };
$('bShare').onclick = async () => {
  const q = new URLSearchParams({ c: S.c, d: S.dist, sz: S.size, t: S.temp, a: S.alt, h: S.rh, lat: S.lat, az: S.az,
    w: (S.same ? S.layers.slice(0, 1) : S.layers).map((l) => [l.spd, l.clock, l.gust].join(',')).join(';'),
    cw: S.callTrue ? 'true' : [S.call.spd, S.call.clock].join(','),
    f: (S.spin ? 's' : '') + (S.earth ? 'e' : '') + (S.solver ? 'k' : ''), ts: shot ? shot.t0 : S.t0, fire: 1 });
  const url = `${location.origin}/sao-paulo/ballistics/?${q}`;
  try { await navigator.clipboard.writeText(url); toast('Link copied: it fires exactly this shot.'); } catch { prompt('Copy this link:', url); }
};
for (const [s, n] of SCALES) {
  const b = document.createElement('button');
  b.textContent = n;
  b.onclick = () => { scale = s; auto = false; $('bAuto').setAttribute('aria-pressed', 'false'); for (const x of $('scale').children) x.setAttribute('aria-pressed', String(x === b)); };
  $('scale').appendChild(b);
}
for (const [c, n] of CAMS) {
  const b = document.createElement('button');
  b.textContent = n;
  b.dataset.c = c;
  b.onclick = () => setCam(c);
  $('cams').appendChild(b);
}
// Mobile tabs.
const tabs = { tLab: 'lab', tRes: 'res' };
for (const [t, p] of Object.entries(tabs)) $(t).onclick = () => { for (const [u, q] of Object.entries(tabs)) { $(q).hidden = u !== t; $(u).setAttribute('aria-pressed', String(u === t)); } $('tabs').classList.remove('closed'); };
$('tHide').onclick = () => { $('lab').hidden = $('res').hidden = true; $('tabs').classList.add('closed'); };
if (window.innerWidth <= 860) $('res').hidden = true;
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); fireNow(); }
  else if (e.key === 'c' || e.key === 'C') setCam(CAMS[(CAMS.findIndex((x) => x[0] === cam) + 1) % CAMS.length][0]);
  else if (e.key === 'b' || e.key === 'B') $('bAuto').click();
  else if (e.key === 'z' || e.key === 'Z') $('bReplay').click();
  else if (e.key === 'm' || e.key === 'M') $('bSound').click();
  else if (e.key === 'u' || e.key === 'U') $('bUnits').click();
  else if (e.key === 'h' || e.key === 'H') $('help').classList.toggle('on');
  else if (e.key === '+' || e.key === '=') magnification = Math.min(32, magnification + 1);
  else if (e.key === '-') magnification = Math.max(3, magnification - 1);
});
// Drag to look around (shooter and target cameras); wheel zooms the scope.
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ...orbit }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (!drag) return; orbit.yaw = drag.yaw - (e.clientX - drag.x) * 0.004; orbit.pitch = Math.max(-0.6, Math.min(0.6, drag.pitch + (e.clientY - drag.y) * 0.003)); });
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => { if (cam === 'scope') { magnification = Math.max(3, Math.min(32, magnification + (e.deltaY < 0 ? 1 : -1))); } }, { passive: true });

// ---------- Frame ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
  R.setPixelRatio(dpr);
  R.setSize(w, h, false);
  rt.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
  ret.width = Math.floor(w * dpr); ret.height = Math.floor(h * dpr);
  camera.aspect = scopeCam.aspect = w / h;
  camera.updateProjectionMatrix();
  mirage.uniforms.aspect.value = w / h;
}
window.addEventListener('resize', resize);

function updateFlags(tEngine, wall) {
  for (const f of flags) {
    const p = enu(f.d, f.r, -BENCH + 4 * f.scale);
    const a = B.air(p[0], p[1], p[2], tEngine);
    // The wind in the line-of-fire frame: blowing toward (right, downrange).
    const w = lof(a.wind);
    const spd = Math.hypot(w.r, w.d);
    const mph = spd / MPH;
    // The flag's angle from the pole: about 4 degrees per mph, up to nearly level.
    const lift = Math.min(85, mph * 4) * DEG;
    f.pivot.rotation.set(0, 0, 0);
    f.pivot.rotation.y = Math.atan2(w.d, w.r);  // point the cloth down the wind
    f.pivot.rotateZ(-(Math.PI / 2 - lift));
    // Flutter.
    const pos = f.cloth.geometry.attributes.position;
    for (let i = 0; i < pos.count; ++i) {
      const x0 = f.geo0[i * 3], fl = (x0 / (1.4 * f.scale) + 0.5);
      pos.array[i * 3 + 2] = Math.sin(wall * (4 + spd) + x0 * 6 + f.d) * 0.08 * f.scale * fl * Math.min(1, spd / 3);
    }
    pos.needsUpdate = true;
  }
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const wallDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const wall = now / 1000;
  let s = 1;
  if (phase === 'flight' && shot) {
    s = auto ? autoScale() : scale;
    te += wallDt * s;
    if (te >= shot.tStop - shot.t0) {
      te = shot.tStop - shot.t0;
      phase = 'after';
      afterWall = 0;
      if (shot.hit) {
        ping();
        plate.userData.swing = Math.min(0.9, 0.2 + (shot.atTarget ? Math.hypot(...shot.atTarget.velocity) / 2000 : 0.3));
        const mark = new THREE.Mesh(new THREE.CircleGeometry(Math.max(0.012, S.size * 0.02), 16), new THREE.MeshBasicMaterial({ color: 0xd9d4c8 }));
        mark.position.set(shot.impact.right, shot.impact.up, 0.012);
        plate.children[0].add(mark);
        hitMarks.push(mark);
        banner('Hit', `${fmtLen(Math.hypot(shot.impact.right, shot.impact.up))} from centre at ${fmtDist(S.dist)}`);
      } else {
        const p = v3(B.stateAt(shot.tStop).position);
        dust.position.copy(p);
        dust.scale.setScalar(0.3);
        dust.material.opacity = 0.85;
        noiseBurst(0.25, 600, 0.25);
        banner('Miss', shot.impact ? `${fmtLen(Math.abs(shot.impact.right))} ${shot.impact.right >= 0 ? 'right' : 'left'}, ${fmtLen(Math.abs(shot.impact.up))} ${shot.impact.up >= 0 ? 'high' : 'low'}` : 'short of the target');
      }
    }
  } else if (phase === 'after') {
    afterWall += wallDt;
    if (auto && afterWall > 1.2 && cam === 'bullet') setCam('target');
  }
  const tEngine = shot ? shot.t0 + te : 0;
  updateFlags(phase === 'idle' || !shot ? wall : tEngine, wall);
  mirage.uniforms.t.value = wall;
  // Mirage: stronger in heat and still air, leaning with the crosswind at the target.
  {
    const pTarget = enu(S.dist * 0.7, 0, -BENCH + 0.5);
    const w = lof(B.air(pTarget[0], pTarget[1], pTarget[2], tEngine).wind);
    const heat = Math.max(0.15, Math.min(1.4, (S.temp + 5) / 30));
    mirage.uniforms.amp.value = (0.00035 + 0.0011 * heat) / (1 + Math.abs(w.r) / 4) * Math.min(1.6, S.dist / 800);
    mirage.uniforms.drift.value = Math.max(-1.5, Math.min(1.5, w.r / 3));
  }
  // The round.
  let st = null;
  if (shot && phase !== 'idle') {
    st = B.stateAt(tEngine);
    const p = v3(st.position);
    bullet.position.copy(p);
    const nose = v3(B.noseAt(tEngine)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), nose);
    bullet.quaternion.copy(q);
    bulletBody.rotation.z = -st.roll;  // the engraving turns with the spin
    bullet.visible = !(phase === 'after' && shot.hit);
    // Shock cone while supersonic.
    const a = B.air(st.position[0], st.position[1], st.position[2], tEngine);
    const u = Math.hypot(st.velocity[0] - a.wind[0], st.velocity[1] - a.wind[1], st.velocity[2] - a.wind[2]);
    const M = u / a.speedOfSound;
    shock.visible = M > 1.01 && phase === 'flight' && cam === 'bullet';
    if (shock.visible) {
      const L = 0.35, half = Math.asin(1 / M);
      shock.scale.set(L * Math.tan(half), L, L * Math.tan(half));
      shock.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      shock.position.copy(p).addScaledVector(nose, bullet.userData.length * 0.5 - L / 2);
    }
    // The trail: the last stretch of the flight behind it.
    const pos = trailGeo.attributes.position.array, col = trailGeo.attributes.color.array;
    const span = cam === 'bullet' ? 0.04 : 0.6;
    for (let k = 0; k < TRAIL; ++k) {
      const tk = Math.max(shot.t0, tEngine - (k / (TRAIL - 1)) * span);
      const pk = v3(B.stateAt(tk).position);
      pos[k * 3] = pk.x; pos[k * 3 + 1] = pk.y; pos[k * 3 + 2] = pk.z;
      const f = 1 - k / TRAIL;
      col[k * 3] = 0.85 * f + 0.1; col[k * 3 + 1] = 0.9 * f + 0.1; col[k * 3 + 2] = 1.0 * f + 0.15;
    }
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
    trail.visible = phase === 'flight';
    const hud = `${fmtDist(lof(st.position).d)}<span>·</span>${fmtV(Math.hypot(...st.velocity))}<span>·</span>Mach ${M.toFixed(2)}<span>·</span>${(st.spin / (2 * Math.PI)).toFixed(0)} turns/s`;
    $('hud').innerHTML = phase === 'flight' ? hud : '';
  } else {
    $('hud').innerHTML = '';
    trail.visible = false;
    shock.visible = false;
  }
  // Muzzle flash, dust, the plate swinging.
  flash.position.set(0, 0, -0.66);
  flash.material.opacity *= Math.pow(0.02, wallDt * (phase === 'flight' ? Math.max(0.02, s) * 40 : 6));
  if (dust.material.opacity > 0) { dust.scale.multiplyScalar(1 + wallDt * 1.5); dust.material.opacity *= Math.pow(0.4, wallDt); }
  if (plate.userData.swing) {
    plate.userData.phase = (plate.userData.phase || 0) + wallDt * 5;
    plate.rotation.x = -plate.userData.swing * Math.exp(-plate.userData.phase / 6) * Math.sin(plate.userData.phase);
  }
  // Clock.
  if (shot && phase !== 'idle') {
    const sp = s >= 0.95 ? '1×' : `1/${Math.round(1 / s).toLocaleString()}`;
    $('clock').innerHTML = `${te.toFixed(4)} s<small>${phase === 'flight' ? sp + (auto ? ' · bullet time' : '') : 'impact'}</small>`;
  } else $('clock').innerHTML = `0.000 s<small>ready</small>`;
  // Cameras.
  const D = S.dist;
  if (cam === 'scope') {
    scopeCam.fov = scopeFov();
    scopeCam.position.set(0, sightHeight(), 0);
    scopeCam.lookAt(0, sightHeight(), -D);
    scopeCam.updateProjectionMatrix();
    rifle.visible = false;
    R.setRenderTarget(rt);
    R.render(scene, scopeCam);
    R.setRenderTarget(null);
    R.render(post, postCam);
    drawReticle(dope);
    path.visible = false;
    return;
  }
  rifle.visible = true;
  if (cam === 'bullet' && st) {
    const p = bullet.position;
    const dir = v3(st.velocity).normalize();  // v3 is linear: it converts directions too
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    // Behind and beside the round, orbiting it slowly (drag to swing round it).
    const a = 0.4 + orbit.yaw + 0.12 * Math.sin(wall * 0.3);
    const dist = 0.22;
    camera.position.copy(p).addScaledVector(dir, -dist * Math.cos(a)).addScaledVector(side, dist * Math.sin(a))
      .add(new THREE.Vector3(0, 0.035 + orbit.pitch * 0.2, 0));
    camera.near = 0.002;
    camera.fov = 40;
    camera.lookAt(p.clone().addScaledVector(dir, 0.04));
  } else if (cam === 'target') {
    const tp = target.position;
    camera.near = 0.05;
    camera.fov = 45;
    const yaw = 0.5 + orbit.yaw;
    camera.position.set(tp.x + Math.sin(yaw) * 5.5, tp.y + 0.6 + orbit.pitch * 4, tp.z + Math.cos(yaw) * 5.5);
    camera.lookAt(tp.x, tp.y, tp.z);
  } else {
    camera.near = 0.02;
    camera.fov = 55;
    camera.position.set(0.55, sightHeight() + 0.35, 1.9);
    camera.lookAt(new THREE.Vector3(Math.sin(orbit.yaw) * 60, sightHeight() + orbit.pitch * 40 - 1, -60 * Math.cos(orbit.yaw)));
    path.visible = !!shot;
  }
  camera.updateProjectionMatrix();
  R.render(scene, camera);
}

// ---------- Start ----------
presetsUI();
syncUI();
setCam('scope');
resize();
changed(true);
dope = solveDope();
dopeUI();
$('loading').remove();
requestAnimationFrame(frame);
if (autoFire) setTimeout(fireNow, 300);
