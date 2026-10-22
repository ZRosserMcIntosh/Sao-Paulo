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
  hornady_50bmg_750: 'm107_50bmg', federal_xm855: 'm16a2', speer_9mm_124gd: 'pistol_9mm',
  cheytac_408_419: 'm200_408', hornady_65cm_147: 'bolt_65cm', ussr_762x54r_l: 'm9130_pu', ussr_762x54r_7n1: 'svd_pso1' };
// The scopes. Any of them goes on any rifle; by default each rifle wears its
// own (the Mosin the PU, the SVD the PSO-1, the rest a mil scope). The Soviet
// scopes are fixed power with a range drum in hundreds of metres, and read
// holds in thousandths (1/6000 of a circle). Field of view: PSO-1 6 deg
// (published); PU about 4.5 deg (estimated). Clicks: mil 0.1 mil, MOA 1/4 MOA,
// PSO-1 windage 0.5 thousandth (published), PU windage 0.5 (estimated).
const THOU = (2 * Math.PI) / 6000, MOA = Math.PI / 10800;
// How each is used: 'dial' the elevation and hold the wind; set the 'drum' and
// hold what it leaves; or 'hold' everything on the reticle (the ACOG's
// bullet-drop marks). The ACOG: Trijicon TA31 class, 4x32, 7 deg field
// (published); its clicks are estimated at 1/4 MOA.
const SCOPES = {
  mil: { kind: 'mil', mode: 'dial', name: 'Mil-dot', unit: 1e-3, unitName: 'mil', click: 1e-4 },
  moa: { kind: 'moa', mode: 'dial', name: 'MOA', unit: MOA, unitName: 'MOA', click: MOA / 4 },
  acog: { kind: 'acog', mode: 'hold', name: 'ACOG', mag: 4, fov: 7, unit: MOA, unitName: 'MOA', click: MOA / 4 },
  pso1: { kind: 'pso1', mode: 'drum', name: 'PSO-1', mag: 4, fov: 6, drumMax: 10, unit: THOU, unitName: 'thousandths', click: THOU / 2 },
  pu: { kind: 'pu', mode: 'drum', name: 'PU', mag: 3.5, fov: 4.5, drumMax: 13, unit: THOU, unitName: 'thousandths', click: THOU / 2 },
};
const RIFLE_SCOPE = { m9130_pu: 'pu', svd_pso1: 'pso1', m16a2: 'acog' };
const scopeKey = () => (S.scope && S.scope !== 'own' ? S.scope : RIFLE_SCOPE[RIFLE_FOR[S.c]] ?? 'mil');
const scopeOf = () => SCOPES[scopeKey()];
// Tracers: the colour is the shooter's choice; the trace lights a little way
// out and burns out about here (m), by calibre. M62 7.62 NATO: at least 775 m
// (published, RWS datasheet); the rest estimated.
const TRACER_COLOURS = { red: 0xff3a24, green: 0x5dff4a, orange: 0xff9a1f, yellow: 0xffe14a, white: 0xf4f1ff };
const TRACER_BURNOUT = { m855_224_62: 800, eldm_264_140: 900, eldm_264_147: 900, smk_308_175: 800, l_762x54r_148: 1000,
  '7n1_762x54r_151': 1000, scenar_338_250: 1000, cheytac_408_419: 1200, amax_510_750: 1600, gdhp_355_124: 250 };
const tracerBurnout = (p) => TRACER_BURNOUT[p.id] ?? 1000;
const TRACER_LIGHTS = 30;  // m: where the trace becomes visible (M62: 13 to 140 m)

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
// The Glass Lab's glazings, for the crash dummy behind glass (the impact itself
// is played in the Liquids Lab, which breaks the glass with Glass Dynamics).
let glazings = [];
try { glazings = (await (await fetch('../glass/library.json')).json()).glazings.map((g) => ({ id: g.id, name: g.name, category: g.category, width: g.width, height: g.height })); } catch { glazings = []; }
// The Rosser V8 with its armoured windscreen: the Glass Lab's engine breaks it.
let G = null, gcat = null, carGltf = null, carLoading = false;
async function ensureGlass() {
  if (G) return G;
  const { default: createGlassModule } = await import('../glass/glass.mjs');
  const g = await createGlassModule();
  const errs = g.load(await (await fetch('../glass/library.json', { cache: 'no-cache' })).text());
  if (errs.length) throw new Error(errs.join('; '));
  gcat = g.catalog();
  G = g;
  return G;
}
function ensureCar() {
  if (carGltf || carLoading) return;
  carLoading = true;
  Promise.all([import('../driving/vendor/loaders/GLTFLoader.js'), import('../driving/vendor/libs/meshopt_decoder.module.js')])
    .then(([{ GLTFLoader }, { MeshoptDecoder }]) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('../driving/models/car.glb'))
    .then((g) => { carGltf = g; if (S.tgt === 'v8') buildRange(); })
    .catch((e) => toast('The V8 model did not load: ' + e.message))
    .finally(() => { carLoading = false; });
}
// The car's frame (as the Glass Lab's armoured-car scene): +Z forward, +X
// the car's left, y up from the ground. The windscreen pane: raked 69.5 deg,
// front face bottom centre at the cowl. The car faces the shooter.
const V8 = { glazing: 'armoured_windscreen_v8', rake: 69.5 * DEG, cowl: [0, 0.807, 0.988], W: 1.0, H: 0.9 };
const V8_AIM = (() => {
  // Aim at the windscreen in front of the driver's face (left-hand drive: x 0.36).
  const y = 0.97, z = V8.cowl[2] - Math.tan(V8.rake) * (y - V8.cowl[1]);
  return [0.36, y, z];
})();
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
  { id: '65cm', name: '1 km', sub: '6.5 Creedmoor 147 ELD-M', feature: true,
    s: { c: 'hornady_65cm_147', dist: 1000, size: 0.5, temp: 20, alt: 0, rh: 50, lat: -23.55, az: 0,
      same: true, layers: [layer(10, 3, 1), layer(10, 3, 1), layer(10, 3, 1)], callTrue: true, call: layer(10, 3) } },
  { id: '408', name: '2.5 km', sub: '.408 CheyTac · M200', feature: true,
    s: { c: 'cheytac_408_419', dist: 2500, size: 1.2, temp: 25, alt: 800, rh: 30, lat: 40, az: 0,
      same: true, layers: [layer(8, 3, 1.5), layer(8, 3, 1.5), layer(8, 3, 1.5)], callTrue: true, call: layer(8, 3) } },
  { id: 'mosin', name: '500 m', sub: 'Mosin M91/30 · PU · a winter at −12 °C', feature: true,
    s: { c: 'ussr_762x54r_l', dist: 500, size: 0.5, temp: -12, alt: 80, rh: 80, lat: 48.7, az: 270,
      same: true, layers: [layer(9, 3, 1.5), layer(9, 3, 1.5), layer(9, 3, 1.5)], callTrue: true, call: layer(9, 3) } },
  { id: 'svd', name: '800 m', sub: 'SVD · PSO-1 · 7N1', feature: true,
    s: { c: 'ussr_762x54r_7n1', dist: 800, size: 0.5, temp: 18, alt: 150, rh: 55, lat: 55.75, az: 0,
      same: true, layers: [layer(10, 9, 1.5), layer(10, 9, 1.5), layer(10, 9, 1.5)], callTrue: true, call: layer(10, 9) } },
  { id: 'dummy', name: 'Through a windscreen', sub: '.308 at 600 m · the dummy behind it', feature: true,
    s: { c: 'fgmm_308_175', dist: 600, size: 0.5, temp: 22, alt: 760, rh: 60, lat: -23.55, az: 0, tgt: 'dummy', glazing: 'windscreen',
      same: true, layers: [layer(8, 3, 1), layer(8, 3, 1), layer(8, 3, 1)], callTrue: true, call: layer(8, 3) } },
  { id: 'v8', name: 'The armoured V8', sub: '.338 at 800 m · dummy at the wheel', feature: true,
    s: { c: 'lapua_338lm_250', dist: 800, size: 0.5, temp: 24, alt: 760, rh: 55, lat: -23.55, az: 0, tgt: 'v8',
      same: true, layers: [layer(6, 3, 1), layer(6, 3, 1), layer(6, 3, 1)], callTrue: true, call: layer(6, 3) } },
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
Object.assign(S, { spin: true, earth: true, solver: true, t0: 10, tgt: 'plate', glazing: 'windscreen', markers: store.get('markers', 'hits'), tracer: store.get('tracer', 'off'), tracerToImpact: store.get('tracerToImpact', true),
  scope: store.get('scope', 'own'), aim: store.get('aim', 'assist'), hint: store.get('hint', true), turret: { el: 0, wd: 0 }, hold: { up: 0, right: 0 } });
let metric = store.get('metric', true);

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
  if (Q.get('tg') === 'v8') S.tgt = 'v8';
  if (Q.has('sc') && Q.get('sc') in SCOPES) S.scope = Q.get('sc');
  if (Q.get('am') === 'm') {
    S.aim = 'manual';
    const tu = (Q.get('tu') || '').split(',').map(Number), ho = (Q.get('ho') || '').split(',').map(Number);
    if (tu.length === 2 && tu.every(Number.isInteger)) S.turret = { el: tu[0], wd: tu[1] };
    if (ho.length === 2 && ho.every(Number.isFinite)) S.hold = { up: ho[0] / 1e6, right: ho[1] / 1e6 };
  }
  if (Q.has('tr')) {
    const [c, burn] = Q.get('tr').split('.');
    S.tracer = c in TRACER_COLOURS ? c : 'off';
    S.tracerToImpact = burn !== 'real';
  }
  if (Q.has('hm')) S.markers = ['off', 'hits', 'all'].includes(Q.get('hm')) ? Q.get('hm') : 'hits';
  if (Q.get('tg') === 'dummy') { S.tgt = 'dummy'; S.glazing = (Q.get('gz') || 'windscreen').replace(/[^a-z0-9_]/g, ''); }
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
  drumTable();  // engraved before the day's air goes in
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

// The crash dummy: its chest at the aim point. Which part a shot meets
// (torso 0.42 x 0.62 m, head, upper legs), in the Liquids Lab's names.
function dummyPart(o) {
  if (Math.abs(o.right) <= 0.21 && o.up <= 0.22 && o.up >= -0.4) return Math.abs(o.right) > 0.15 && o.up > 0.05 ? 'shoulder' : o.up < -0.14 ? 'abdomen' : 'chest';
  if (Math.hypot(o.right, o.up - 0.38) <= 0.11) return 'chest';  // the head: the lab aims the chest
  if (Math.abs(o.right) <= 0.2 && o.up < -0.4 && o.up >= -0.85) return 'thigh';
  return null;
}
// The glass impactor nearest in calibre (Glass Dynamics' own bullets).
const glassImpactor = (p) => (p.diameter_in >= 0.4 ? 'bmg_50' : p.diameter_in >= 0.3 && p.mass_gr < 140 ? 'pistol_9mm' : 'rifle_762');
function liquidsUrl(sh) {
  const p = projRaw(sh.S.c), at = sh.atTarget;
  const v = lof(at.velocity), speed = Math.hypot(...at.velocity);
  const q = new URLSearchParams({ from: 'ballistics', name: cat.cartridges[cartIndex(sh.S.c)].name.replace(/\s*\(.*\)$/, ''),
    range: Math.round(sh.S.dist), mass_g: (p.mass_gr * 0.06479891).toFixed(2), dia_mm: (p.diameter_in * 25.4).toFixed(2), v: speed.toFixed(1),
    desc: (Math.atan2(-v.u, v.d) / DEG).toFixed(2), drift: (Math.atan2(v.r, v.d) / DEG).toFixed(2), gi: glassImpactor(p),
    glazing: sh.S.glazing, pane: sh.S.glazing === 'none' ? 'none' : 'front', target: dummyPart(sh.impact) || 'chest', back: shareUrl(sh, false) });
  if (sh.S.tgt === 'v8' && sh.glass) {
    // Through the V8's windscreen already (Glass Dynamics here): the dummy gets what is left.
    q.set('v', sh.glass.vout.toFixed(1));
    q.set('pane', 'none');
    q.set('target', 'shoulder');
    q.set('via', `through the Rosser V8's armoured windscreen, ${sh.glass.vin.toFixed(0)} → ${sh.glass.vout.toFixed(0)} m/s`);
  }
  return `/sao-paulo/liquids/?${q}`;
}

// The round at the V8: the target plane (across the line of fire at the aim
// point) is where the range measured it; follow its path on to the raked
// pane, and fire it into Glass Dynamics there at its real angle, with its own
// mass and radius.
function strikeV8(impact, at) {
  const r = V8.rake, X = [1, 0, 0], Vv = [0, Math.cos(r), -Math.sin(r)], N = [0, Math.sin(r), Math.cos(r)];
  const dotp = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // In the car's frame the shooter is toward +Z; shooter's right is the car's +X.
  const l = lof(at.velocity), sp = Math.hypot(l.r, l.u, l.d);
  const d = [l.r / sp, l.u / sp, -l.d / sp];
  const q0 = [V8_AIM[0] + impact.right, V8_AIM[1] + impact.up, V8_AIM[2]];
  const rel = [q0[0] - V8.cowl[0], q0[1] - V8.cowl[1], q0[2] - V8.cowl[2]];
  const s = -dotp(N, rel) / dotp(N, d);
  const q = [rel[0] + s * d[0], rel[1] + s * d[1], rel[2] + s * d[2]];
  const u = dotp(q, X), v = dotp(q, Vv);
  const out = { onGlass: Math.abs(u) <= V8.W / 2 - 0.01 && v >= 0.01 && v <= V8.H - 0.01, u, v, vin: sp };
  if (!out.onGlass || !G) return out;
  const gi = gcat.glazings.findIndex((g) => g.id === V8.glazing);
  const p = projRaw(S.c);
  const ii = Math.max(0, gcat.impactors.findIndex((x) => x.id === glassImpactor(p)));
  const dl = [dotp(d, X), dotp(d, Vv), dotp(d, N)], dp = [dl[0], dl[1], -dl[2]];
  out.yaw = Math.atan2(dp[0], dp[2]); out.pitch = Math.asin(Math.max(-1, Math.min(1, dp[1])));
  if (gi < 0 || !G.gls_new_pane(gi, 2, 1)) return out;
  G.gls_fire_as(ii, u + V8.W / 2, v, sp, out.yaw, out.pitch, 0, 0.002, p.mass_gr * 6.479891e-5, (p.diameter_in * IN) / 2);
  for (let k = 0; k < 400; ++k) {
    G.gls_advance(G.gls_time() + 2.5e-4, 1 << 16);
    const rep = G.report(0);
    if ((rep.v[11] || rep.v[12] || rep.v[13]) && G.gls_time() > rep.v[5] + 0.002) break;
  }
  const rep = G.report(0);
  Object.assign(out, { vout: rep.v[1], penetrated: !!rep.v[11], rebounded: !!rep.v[12], embedded: !!rep.v[13], outcome: rep.outcome, depth: rep.v[8] });
  out.cracks = [];
  const plies = G.state()[2];
  for (let g = 0; g < plies; ++g) out.cracks.push(Array.from(G.cracks(g, 0)));
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
  const aim = shotHold(dope);
  const el = e0 + aim.up, az = S.az * DEG + aim.right;
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
    hit = above && (S.tgt === 'dummy' ? dummyPart(impact) !== null : S.tgt === 'v8' ? true : Math.abs(impact.right) <= S.size / 2 && Math.abs(impact.up) <= S.size / 2);
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
  // The V8: where the round meets the raked windscreen, and what the glass does to it.
  let glass = null;
  if (S.tgt === 'v8' && hit && atT) {
    glass = strikeV8(impact, atT);
    hit = glass.onGlass;
  }
  shot = {
    S: structuredClone(S), dope, aim, t0, tEnd, tTarget, tGround, tStop, hit, impact, air, sg,
    round: B.round(), atTarget: atT, muzzleSpeed: Math.hypot(...B.stateAt(t0).velocity), glass,
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
let target = null, plate = null, hitMarks = [], v8Cracks = null;
// Where the last shots went (the reticle's impact marks), and the 3D marks of misses.
let impacts = [], missMarks = [];
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
  if (S.tgt === 'v8') {
    // The car, placed so the aim point on its windscreen is the target centre,
    // on a gravel ramp; the dummy at the wheel; the armoured pane where the
    // Glass Lab mounts it, with its cracks drawn from Glass Dynamics.
    const car = new THREE.Group();
    car.position.set(-V8_AIM[0], sightHeight() - V8_AIM[1], -D - V8_AIM[2]);
    if (carGltf) {
      const inner = carGltf.scene.clone(true);
      inner.rotation.y = -Math.PI / 2;
      inner.traverse((o) => {
        if (!o.isMesh) return;
        const fix = (m) => { if (m && m.transmission > 0) { m = m.clone(); m.transmission = 0; m.transparent = true; m.opacity = 0.3; m.depthWrite = false; } return m; };
        o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
      });
      car.add(inner);
    } else {
      ensureCar();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.75, 4.4), new THREE.MeshStandardMaterial({ color: 0x0b2c7a, metalness: 0.6, roughness: 0.4 }));
      body.position.set(0, 0.55, 0);
      car.add(body);
    }
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b711, roughness: 0.55 });
    const cap = (r, len, x, y, z, rx = 0) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), yellow); m.position.set(x, y, z); m.rotation.x = rx; car.add(m); };
    cap(0.1, 0.06, 0.36, 0.98, -0.42);                 // head, at the driver's eye
    cap(0.16, 0.36, 0.36, 0.62, -0.5, 0.25);           // torso, leaning back
    cap(0.05, 0.42, 0.18, 0.72, -0.15, 1.1); cap(0.05, 0.42, 0.54, 0.72, -0.15, 1.1);  // arms to the wheel
    const pane = new THREE.Group();
    pane.position.set(V8.cowl[0], V8.cowl[1], V8.cowl[2]);
    pane.rotation.x = -V8.rake;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(V8.W, V8.H), new THREE.MeshPhysicalMaterial({ color: 0xbfe0f0, transparent: true, opacity: 0.18, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    sheet.position.y = V8.H / 2;
    pane.add(sheet);
    v8Cracks = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    v8Cracks.position.set(-V8.W / 2, 0, 0.004);
    pane.add(v8Cracks);
    car.add(pane);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(3.4, Math.max(0.05, car.position.y + BENCH), 6), new THREE.MeshLambertMaterial({ color: 0x8b8378 }));
    ramp.position.set(car.position.x, (-BENCH + car.position.y) / 2, car.position.z);
    range.add(ramp, car);
    target = new THREE.Group();
    target.position.set(0, sightHeight(), -D);
    plate = new THREE.Group();
    plate.add(new THREE.Group());
    target.add(plate);
    range.add(target);
    return;
  }
  if (S.tgt === 'dummy') {
    // A crash dummy (chest at the aim point) behind a pane of the chosen glass.
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b711, roughness: 0.55 });
    const cap = (r, len, x, y, z = 0) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), yellow); m.position.set(x, y, z); target.add(m); return m; };
    cap(0.17, 0.42, 0, -0.08);                        // torso
    cap(0.1, 0.06, 0, 0.38);                          // head
    cap(0.055, 0.5, -0.27, -0.06); cap(0.055, 0.5, 0.27, -0.06);  // arms
    cap(0.075, 0.75, -0.1, -0.85); cap(0.075, 0.75, 0.1, -0.85);  // legs
    const g = glazings.find((x) => x.id === S.glazing);
    if (S.glazing !== 'none' && g) {
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(g.width, g.height), new THREE.MeshPhysicalMaterial({ color: 0xcfe8f5, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0, side: THREE.DoubleSide }));
      pane.position.set(0, 0, 0.6);
      target.add(pane);
    }
    plate = new THREE.Group();  // nothing swings
    plate.add(new THREE.Group());
    target.add(plate);
    range.add(target);
    const bermD = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x9a8a68 }));
    bermD.scale.set(30 + D / 50, 3 + D / 1000, 12);
    bermD.position.set(0, -BENCH, -D - 30);
    range.add(bermD);
    return;
  }
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
// The shock cone (Mach angle) and the dashed path.
const shock = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 32, 1, true), new THREE.MeshBasicMaterial({
  color: 0xdbe8ff, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
shock.visible = false;
scene.add(shock);
const pathGeo = new THREE.BufferGeometry();
const path = new THREE.Line(pathGeo, new THREE.LineDashedMaterial({ color: 0xffd36b, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.55 }));
path.frustumCulled = false;
scene.add(path);
// Muzzle flash and the dust of a miss.
const flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0 }));
scene.add(flash);
const dust = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshLambertMaterial({ color: 0xb59a74, transparent: true, opacity: 0 }));
scene.add(dust);
// The tracer: the burning base of the round, and the streak the eye keeps
// behind it. Two sets of glows: a fixed size on screen (seen from the rifle
// or through the scope) and life size (the bullet camera).
const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.9)');
  gr.addColorStop(0.55, 'rgba(255,255,255,0.28)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const TRACER_N = 28, TRACER_DT = 0.0025;  // glows along the last 0.07 s of flight
const tracerSets = [false, true].map((life) => {
  const grp = new THREE.Group();
  for (let k = 0; k < TRACER_N; ++k)
    grp.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: life })));
  grp.visible = false;
  scene.add(grp);
  return grp;
});
function updateTracer(tEngine, life, fov) {
  for (const g of tracerSets) g.visible = false;
  if (!shot || phase === 'idle' || S.tracer === 'off') return;
  const fade = phase === 'after' ? Math.exp(-afterWall * 8) : 1;
  if (fade < 0.02) return;
  const grp = tracerSets[life ? 1 : 0], burn = S.tracerToImpact ? Infinity : tracerBurnout(projRaw(shot.S.c)), col = TRACER_COLOURS[S.tracer];
  const screen = 2 * Math.tan((fov * DEG) / 2);  // a glow's size as a share of the view's height
  grp.visible = true;
  for (let k = 0; k < TRACER_N; ++k) {
    const sp = grp.children[k], t = tEngine - k * TRACER_DT;
    const st = t >= shot.t0 ? B.stateAt(t) : null, d = st ? lof(st.position).d : -1;
    sp.visible = !!st && d >= TRACER_LIGHTS && d <= burn;
    if (!sp.visible) continue;
    sp.position.copy(v3(st.position));
    if (k === 0 && life) sp.position.addScaledVector(v3(st.velocity).normalize(), -bullet.userData.length * 0.5);
    const f = 1 - k / TRACER_N;
    // A white-hot core at the head, the colour along the streak.
    sp.material.color.setHex(col);
    if (k === 0) sp.material.color.lerp(new THREE.Color(0xffffff), life ? 0.35 : 0.12);
    sp.material.opacity = (k === 0 ? 1 : 0.45 * f * f) * fade;
    const sz = life ? (k === 0 ? 0.03 : 0.02 * f) : screen * (k === 0 ? 0.022 : 0.012 * (0.4 + 0.6 * f));
    sp.scale.set(sz, sz, 1);
  }
}

// ---------- Scope: render target, mirage, reticle ----------
const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
// The trace: the engine's wake, drawn as how much it bends the light behind
// it (a refractive tube along the path), into its own buffer.
const wakeRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const wakeScene = new THREE.Scene();
const MAX_WAKE = 4000;
const wakeGeo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(2, 2));
const wCenter = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WAKE * 3), 3);
const wRadius = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WAKE), 1);
const wStrength = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WAKE), 1);
wakeGeo.setAttribute('aCenter', wCenter); wakeGeo.setAttribute('aRadius', wRadius); wakeGeo.setAttribute('aStrength', wStrength);
wakeGeo.instanceCount = 0;
const wakeMat = new THREE.ShaderMaterial({
  uniforms: { pxScale: { value: 0.001 } },
  vertexShader: `attribute vec3 aCenter; attribute float aRadius, aStrength; uniform float pxScale; varying vec2 vC; varying float vS;
    void main(){ vec4 mv = viewMatrix * vec4(aCenter, 1.); float depth = max(0.01, -mv.z);
      // A wake thinner than a few pixels is drawn a few pixels wide, keeping its integrated strength.
      float r = max(aRadius, 2.5 * pxScale * depth);
      mv.xy += position.xy * r; vC = position.xy;
      // Shown with a contrast curve (the square root of the deficit), as a spotter's eye and scope pick out a faint trace.
      vS = sqrt(aStrength) * aRadius / r; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec2 vC; varying float vS;
    void main(){ float r2 = dot(vC, vC); if (r2 > 1.) discard; float f = exp(-3. * r2);
      gl_FragColor = vec4(-vC * f * vS, f * vS, 1.); }`,
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
});
const wakeMesh = new THREE.Mesh(wakeGeo, wakeMat);
wakeMesh.frustumCulled = false;
wakeScene.add(wakeMesh);
let showTrace = store.get('trace', true);
const post = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const mirage = new THREE.ShaderMaterial({
  uniforms: { tex: { value: rt.texture }, wake: { value: wakeRT.texture }, wakeGain: { value: 0 }, scope: { value: 1 },
    t: { value: 0 }, amp: { value: 0.0006 }, drift: { value: 0 }, aspect: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    uniform sampler2D tex, wake; uniform float t, amp, drift, aspect, wakeGain, scope; varying vec2 vUv;
    void main(){
      vec2 p = vUv;
      // The trace: the wake bends the light through it.
      vec3 wk = texture2D(wake, vUv).xyz;
      p += wk.xy * wakeGain;
      // Heat shimmer: rising, boiling waves that lean and run with the crosswind.
      float w1 = sin(p.y * 260. + t * 5.1 - p.x * 60. * drift + drift * t * 9.);
      float w2 = sin(p.y * 170. - t * 3.7 + p.x * 90. + drift * t * 6.);
      p.x += amp * (0.6 * w1 + 0.4 * w2);
      p.y += amp * 0.5 * sin(p.x * 210. + t * 4.3);
      vec3 c = texture2D(tex, p).rgb;
      c = mix(c, vec3(0.92, 0.95, 1.0), min(0.45, wk.z * 0.9));
      vec2 q = (vUv - 0.5) * vec2(aspect, 1.);
      float r = length(q);
      float tube = mix(1., smoothstep(0.47, 0.455, r) * (1. - 0.25 * smoothstep(0.3, 0.46, r)), scope);
      c *= tube;
      gl_FragColor = vec4(c, 1.);
    }`,
});
post.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mirage));
const ret = $('reticle'), rg = ret.getContext('2d');
let magnification = 20;
const magFor = (d) => { const sc = scopeOf(); return sc.fov ? sc.mag : Math.max(6, Math.min(25, Math.round(d / 45))); };
const zoomBy = (k) => { if (!scopeOf().fov) magnification = Math.max(3, Math.min(32, magnification + k)); };
// Degrees, vertical: a Soviet scope's own field, else a typical riflescope's.
const scopeFov = () => { const sc = scopeOf(); return sc.fov ? sc.fov : 35 / magnification; };

// The Soviet drum: the elevation (from the 100 m zero) each mark gives, worked
// out by the engine for this load in the tables' normal conditions (15 C,
// 750 mmHg, still air): the drum is engraved once, and the day's air is a hold.
const drumCache = {};
function drumTable() {
  if (drumCache[S.c]) return drumCache[S.c];
  B.bd_station(99992, 288.15, 0.5, 0);
  B.bd_setup(twist(), 0, 0);
  B.wind(0, []);
  const el = [0, 0];
  for (const r of B.table(ci(), ZERO, sightHeight(), 1300, 100, 0)) if (r.range > 0) el[Math.round(r.range / 100)] = -r.drop / r.range;
  return (drumCache[S.c] = el);
}
// A hold (rad up) on a Soviet scope: the drum mark that comes nearest, and
// what is left to hold (rad, + aim higher).
function drumFor(up) {
  const sc = scopeOf(), el = drumTable();
  let k = 1;
  for (let i = 1; i <= sc.drumMax; ++i) if (Number.isFinite(el[i]) && Math.abs(up - el[i]) < Math.abs(up - el[k])) k = i;
  return { drum: k, rest: up - el[k] };
}

// The ACOG's bullet-drop marks (hundreds of metres): the chevron's tip is the
// 100 m zero, the bars 400 to 800 m. The nearest mark to a hold, and the rest.
const ACOG_MARKS = [1, 4, 5, 6, 7, 8];
function bdcFor(up) {
  const el = drumTable();
  let k = 1;
  for (const i of ACOG_MARKS) if (Math.abs(up - el[i]) < Math.abs(up - el[k])) k = i;
  return { mark: k, rest: up - el[k] };
}
// What the shooter does with a solution (rad up and right of the target's
// centre): dial it, set the drum and hold the rest, or hold it all.
function plan(hold) {
  const sc = scopeOf();
  if (sc.mode === 'drum') { const d = drumFor(hold.up); return { drum: d.drum, dialUp: drumTable()[d.drum], holdUp: d.rest, holdRight: hold.right }; }
  if (sc.mode === 'hold') { const b = bdcFor(hold.up); return { mark: b.mark, dialUp: 0, holdUp: hold.up, holdRight: hold.right }; }
  return { dialUp: hold.up, holdUp: 0, holdRight: hold.right };
}
// Manual aim: the turrets (clicks; on a Soviet scope the elevation is the
// drum mark) and the crosshair (rad from the target's centre).
const turretUp = () => { const sc = scopeOf(); return sc.mode === 'drum' ? drumTable()[Math.max(1, Math.min(sc.drumMax, S.turret.el))] : S.turret.el * sc.click; };
const turretRight = () => S.turret.wd * scopeOf().click;
function resetAim() {
  S.turret = { el: scopeOf().mode === 'drum' ? 1 : 0, wd: 0 };
  S.hold = { up: 0, right: 0 };
}
// Where the scope looks (the crosshair, from the target's centre), and the
// angles the shot leaves at (from the zero).
function sightHold() {
  if (S.aim === 'manual') return S.hold;
  if (!dope) return { up: 0, right: 0 };
  const p = plan(dope.hold);
  return { up: p.holdUp, right: p.holdRight };
}
const shotHold = (d) => (S.aim === 'manual' ? { up: turretUp() + S.hold.up, right: turretRight() + S.hold.right } : d.hold);
const fmtU = (rad, sc = scopeOf()) => `${(Math.abs(rad) / sc.unit).toFixed(sc.unit === MOA ? 1 : 1)} ${sc.unitName}`;
function turretText() {
  const sc = scopeOf();
  const el = sc.mode === 'drum' ? `drum ${Math.max(1, Math.min(sc.drumMax, S.turret.el))}` : `${turretUp() >= 0 ? 'up' : 'down'} ${fmtU(turretUp())}`;
  return { el, wd: `${Math.abs(S.turret.wd) < 1 ? 'zero' : fmtU(turretRight()) + (turretRight() > 0 ? ' R' : ' L')}` };
}

function drawReticle(dope) {
  const w = ret.width, h = ret.height, dpr = window.devicePixelRatio || 1;
  rg.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const px = h / (scopeFov() * DEG);  // pixels per radian
  const R0 = Math.min(w, h) * 0.455;
  const sc = scopeOf(), sh = sightHold();
  // The target's centre on the screen (the crosshair is on the screen's centre).
  const tx = cx - sh.right * px, ty = cy + sh.up * px;
  rg.save();
  rg.beginPath();
  rg.arc(cx, cy, R0, 0, Math.PI * 2);
  rg.clip();
  rg.strokeStyle = 'rgba(8,8,8,0.92)';
  rg.fillStyle = 'rgba(8,8,8,0.92)';
  if (sc.kind === 'mil') milReticle(cx, cy, R0, px * 1e-3, dpr, 10, 0.5, 5, 2);
  else if (sc.kind === 'moa') milReticle(cx, cy, R0, px * MOA, dpr, 40, 1, 10, 10);
  else if (sc.kind === 'acog') acogReticle(cx, cy, R0, px, dpr);
  else if (sc.kind === 'pu') puReticle(cx, cy, R0, px * THOU, dpr);
  else pso1Reticle(cx, cy, R0, px * THOU, dpr);
  // The target's centre (a small ring: at a kilometre the plate is a few pixels).
  rg.strokeStyle = '#ff3b2f';
  rg.lineWidth = 2 * dpr;
  rg.beginPath();
  rg.arc(tx, ty, 5 * dpr, 0, Math.PI * 2);
  rg.stroke();
  // Manual: where the crosshair should go for the call, with the turrets as set.
  if (dope && S.aim === 'manual' && S.hint) {
    const nx = tx + (dope.hold.right - turretRight()) * px, ny = ty - (dope.hold.up - turretUp()) * px;
    rg.setLineDash([3 * dpr, 3 * dpr]);
    rg.strokeStyle = '#ffd36b';
    rg.beginPath();
    rg.arc(nx, ny, 8 * dpr, 0, Math.PI * 2);
    rg.stroke();
    rg.setLineDash([]);
  }
  // Where the last shots went, as the spotter saw them.
  if (S.markers !== 'off')
    for (const im of impacts) {
      const x = tx + (im.right / S.dist) * px, y = ty - (im.up / S.dist) * px, k = 5 * dpr;
      rg.strokeStyle = im.hit ? 'rgba(255,255,255,0.95)' : '#ff3b2f';
      rg.lineWidth = 2 * dpr;
      rg.beginPath();
      rg.moveTo(x - k, y - k); rg.lineTo(x + k, y + k); rg.moveTo(x + k, y - k); rg.lineTo(x - k, y + k);
      rg.stroke();
    }
  rg.restore();
  rg.fillStyle = 'rgba(231,236,242,0.95)';
  rg.font = `600 ${12 * dpr}px "JetBrains Mono", monospace`;
  rg.textAlign = 'center';
  const head = `${sc.name} ${sc.fov ? sc.mag : magnification}×`;
  const side = (r) => (r > 0 ? ' right' : ' left');
  let line = '';
  if (S.aim === 'manual') {
    const t = turretText();
    line = `${head}   elevation ${t.el}   windage ${t.wd}   crosshair ${fmtU(S.hold.up)} ${S.hold.up >= 0 ? 'high' : 'low'}, ${fmtU(S.hold.right)}${side(S.hold.right)}`;
  } else if (dope) {
    const p = plan(dope.hold), wd = Math.abs(p.holdRight) < 0.05 * sc.unit ? 'centre' : fmtU(p.holdRight) + side(p.holdRight);
    const rest = (r) => (Math.abs(r) < 0.1 * sc.unit ? 'on' : fmtU(r) + (r > 0 ? ' high' : ' low'));
    if (sc.mode === 'drum') {
      const over = sc.kind === 'pso1' && p.drum === 10 && p.holdUp > 0.2 * THOU ? ` (chevron ${pso1Chevron(dope.hold.up)})` : '';
      line = `${head}   drum ${p.drum}   hold ${rest(p.holdUp)}${over}   wind ${wd}`;
    } else if (sc.mode === 'hold') {
      const b = bdcFor(dope.hold.up);
      line = `${head}   ${b.mark === 1 ? 'chevron tip' : b.mark * 100 + ' m bar'}, ${rest(b.rest)}   wind ${wd}`;
    } else line = `${head}   dialled ${dope.hold.up >= 0 ? 'up' : 'down'} ${fmtU(dope.hold.up)}   hold ${wd}`;
  }
  if (line) rg.fillText(line, cx, cy + R0 + 20 * dpr);
  rg.textAlign = 'start';
}
// A mil or MOA reticle: fine crosshair, heavy outer posts from `span` units,
// a tick every `step`, longer every `major`, numbered every `label`.
function milReticle(cx, cy, R0, u, dpr, span, step, major, label) {
  rg.lineWidth = 1.4 * dpr;
  rg.beginPath();
  rg.moveTo(cx - R0, cy); rg.lineTo(cx + R0, cy);
  rg.moveTo(cx, cy - R0); rg.lineTo(cx, cy + R0);
  rg.stroke();
  rg.lineWidth = 3.5 * dpr;
  rg.beginPath();
  rg.moveTo(cx - R0, cy); rg.lineTo(cx - u * span, cy);
  rg.moveTo(cx + u * span, cy); rg.lineTo(cx + R0, cy);
  rg.moveTo(cx, cy + u * span); rg.lineTo(cx, cy + R0);
  rg.stroke();
  rg.lineWidth = 1.2 * dpr;
  rg.font = `600 ${10 * dpr}px "JetBrains Mono", monospace`;
  for (let i = -Math.round(span / step); i <= Math.round(span / step); ++i) {
    const m = i * step;
    if (i === 0) continue;
    const L = (Number.isInteger(m) ? (m % major === 0 ? 9 : 6) : 3) * dpr;
    rg.beginPath();
    rg.moveTo(cx + m * u, cy - L); rg.lineTo(cx + m * u, cy + L);
    rg.moveTo(cx - L, cy + m * u); rg.lineTo(cx + L, cy + m * u);
    rg.stroke();
    if (Number.isInteger(m) && m % label === 0) {
      rg.fillText(String(Math.abs(m)), cx + m * u - 4 * dpr, cy + 22 * dpr);
      if (m > 0) rg.fillText(String(m), cx + 12 * dpr, cy + m * u + 4 * dpr);
    }
  }
}
// The ACOG (TA31 class): an illuminated red chevron, its tip the 100 m zero,
// on a post with the bullet-drop bars for 400 to 800 m. Each bar is placed by
// the engine from this load's trajectory in standard air (the real reticle is
// engraved for M855 from a 20 in barrel) and is as wide as a man's shoulders
// (19 in) at its range, so it is a rangefinder too. Chevron size estimated.
function acogReticle(cx, cy, R0, px, dpr) {
  const el = drumTable(), m = px * MOA;
  rg.lineWidth = 1.4 * dpr;
  let yl = cy + 2.2 * m;
  for (const k of [4, 5, 6, 7, 8]) {
    if (!Number.isFinite(el[k])) continue;
    const y = cy + (el[k] - el[1]) * px, half = (0.4826 / (k * 100) / 2) * px;
    rg.beginPath();
    rg.moveTo(cx - half, y); rg.lineTo(cx + half, y);
    rg.stroke();
    rg.font = `600 ${10 * dpr}px "JetBrains Mono", monospace`;
    rg.fillText(String(k), cx - half - 10 * dpr, y + 4 * dpr);
    yl = y;
  }
  rg.beginPath();
  rg.moveTo(cx, cy + 2.2 * m); rg.lineTo(cx, yl);
  rg.stroke();
  // The chevron, lit red with a dark edge.
  rg.beginPath();
  rg.moveTo(cx, cy);
  rg.lineTo(cx + 2.2 * m, cy + 2.4 * m);
  rg.lineTo(cx + 1.4 * m, cy + 2.4 * m);
  rg.lineTo(cx, cy + 0.9 * m);
  rg.lineTo(cx - 1.4 * m, cy + 2.4 * m);
  rg.lineTo(cx - 2.2 * m, cy + 2.4 * m);
  rg.closePath();
  rg.fillStyle = 'rgba(255,48,36,0.95)';
  rg.fill();
  rg.lineWidth = 1 * dpr;
  rg.strokeStyle = 'rgba(60,0,0,0.9)';
  rg.stroke();
  rg.strokeStyle = 'rgba(8,8,8,0.92)';
  rg.fillStyle = 'rgba(8,8,8,0.92)';
}
// The PU (1940): a pointed post rising from the bottom to the aim point, and a
// heavy horizontal bar from each side, stopping short of it. No scales: wind
// and range beyond the drum are held by eye. Widths estimated from photographs.
function puReticle(cx, cy, R0, u, dpr) {
  const pw = 1.1 * u, tip = 1.6 * u;
  rg.beginPath();
  rg.moveTo(cx, cy);
  rg.lineTo(cx + pw / 2, cy + tip);
  rg.lineTo(cx + pw / 2, cy + R0);
  rg.lineTo(cx - pw / 2, cy + R0);
  rg.lineTo(cx - pw / 2, cy + tip);
  rg.closePath();
  rg.fill();
  const bh = 0.7 * u, gap = 4 * u;
  rg.fillRect(cx - R0, cy - bh / 2, R0 - gap, bh);
  rg.fillRect(cx + gap, cy - bh / 2, R0 - gap, bh);
}
// Which PSO-1 chevron (11, 12, 13 hundred metres) a hold past the drum's 10 is nearest.
function pso1Chevron(up) {
  const el = drumTable();
  let k = 11;
  for (const i of [11, 12, 13]) if (Math.abs(up - el[i]) < Math.abs(up - el[k])) k = i;
  return k * 100 + ' m';
}
// The PSO-1 (1964): the aiming chevron; below it the chevrons for 1100, 1200
// and 1300 m with the drum on 10 (placed here by the engine from the 7N1's
// trajectory in the tables' normal conditions); the wind and lead scale, a
// mark every thousandth to 10 each side; and the rangefinder for a 1.7 m man,
// 200 to 1000 m, bottom left.
function pso1Reticle(cx, cy, R0, u, dpr) {
  const chevron = (y, size, lw) => {
    rg.lineWidth = lw * dpr;
    rg.beginPath();
    rg.moveTo(cx - size, y + size * 1.1); rg.lineTo(cx, y); rg.lineTo(cx + size, y + size * 1.1);
    rg.stroke();
  };
  chevron(cy, 1.0 * u, 2.4);
  const el = drumTable();
  let yl = cy;
  for (const k of [11, 12, 13]) {
    if (!Number.isFinite(el[k])) continue;
    yl = cy + (el[k] - el[10]) * (u / THOU);
    chevron(yl, 0.5 * u, 1.6);
  }
  // The post below the chevrons.
  rg.lineWidth = 1.6 * dpr;
  rg.beginPath();
  rg.moveTo(cx, yl + 1.2 * u); rg.lineTo(cx, cy + R0);
  rg.stroke();
  // The wind scale: ticks hanging from the chevron's level, a line beyond 10.
  rg.lineWidth = 1.3 * dpr;
  rg.beginPath();
  for (let m = 1; m <= 10; ++m) {
    const L = (m % 5 === 0 ? 1.0 : 0.55) * u;
    for (const sgn of [-1, 1]) { rg.moveTo(cx + sgn * m * u, cy); rg.lineTo(cx + sgn * m * u, cy + L); }
  }
  rg.moveTo(cx - 10 * u, cy); rg.lineTo(cx - R0, cy);
  rg.moveTo(cx + 10 * u, cy); rg.lineTo(cx + R0, cy);
  rg.stroke();
  rg.font = `600 ${10 * dpr}px "JetBrains Mono", monospace`;
  rg.fillText('10', cx - 10 * u - 7 * dpr, cy - 4 * dpr);
  rg.fillText('10', cx + 10 * u - 7 * dpr, cy - 4 * dpr);
  // The rangefinder: a 1.7 m man between the base line and the curve.
  const base = cy + 13 * u, x0 = cx - 24 * u, x1 = cx - 6 * u;
  const xOf = (R) => x0 + ((R - 200) / 800) * (x1 - x0);
  rg.lineWidth = 1.3 * dpr;
  rg.beginPath();
  rg.moveTo(x0, base); rg.lineTo(x1, base);
  for (let R = 200; R <= 1000; R += 10) {
    const y = base - (1.7 / R / THOU) * u;
    if (R === 200) rg.moveTo(xOf(R), y); else rg.lineTo(xOf(R), y);
  }
  rg.stroke();
  rg.beginPath();
  for (let R = 200; R <= 1000; R += 100) { rg.moveTo(xOf(R), base); rg.lineTo(xOf(R), base + 0.4 * u); }
  rg.stroke();
  for (const R of [200, 400, 600, 800, 1000]) rg.fillText(String(R / 100), xOf(R) - 3 * dpr, base + 0.4 * u + 11 * dpr);
}

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
    b.onclick = () => { Object.assign(S, { tgt: 'plate', glazing: 'windscreen' }, structuredClone(p.s)); S.t0 = 10; resetAim(); syncUI(); changed(true); refresh(); fireNow(); };
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
  $('tgt').value = S.tgt; $('glazing').value = S.glazing; $('glazeBox').hidden = S.tgt !== 'dummy'; $('sizeBox').hidden = S.tgt !== 'plate';
  $('markers').value = S.markers;
  $('tracer').value = S.tracer;
  $('tracerToImpact').checked = S.tracerToImpact;
  $('scope').value = S.scope; $('aim').value = S.aim; $('hint').checked = S.hint;
  $('manualBox').hidden = S.aim !== 'manual';
  turretUI();
  if (S.tgt === 'v8') { ensureCar(); ensureGlass().catch(() => {}); }
  $('dist').value = S.dist; $('size').value = S.size; $('temp').value = S.temp; $('alt').value = S.alt; $('rh').value = S.rh;
  $('lat').value = S.lat; $('az').value = S.az;
  $('sameWind').checked = S.same; $('callTrue').checked = S.callTrue; $('callBox').hidden = S.callTrue;
  $('callSpd').value = S.call.spd; $('callDir').value = S.call.clock;
  $('fSpin').checked = S.spin; $('fEarth').checked = S.earth; $('fSolver').checked = S.solver;
  $('bUnits').textContent = metric ? 'Metric' : 'Imperial';
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
  if (rebuild) { impacts = []; missMarks = []; buildRange(); buildBullet(); placeRifle(); magnification = magFor(S.dist); }
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
  const sc = scopeOf(), u = sc.unit;
  const what = { dial: `${sc.unitName}, dialled`, drum: `${sc.name} drum, holds in ${sc.unitName}`, hold: `${sc.name} marks, holds in ${sc.unitName}` }[sc.mode];
  $('dopeWhat').textContent = `${what} · call ${fmtSpeedW(call().spd)} from ${clockName(call().clock)}`;
  const second = { dial: 'Elev', drum: 'Drum', hold: 'Mark' }[sc.mode];
  const arrow = (r) => (Math.abs(r) < 0.05 ? '·' : Math.abs(r).toFixed(1) + (r > 0 ? '↑' : '↓'));
  let h = `<tr><th>${metric ? 'm' : 'yd'}</th><th>${second}</th>${sc.mode === 'dial' ? '' : '<th>Hold</th>'}<th>Wind</th><th>${metric ? 'm/s' : 'ft/s'}</th><th>s</th></tr>`;
  for (const r of dope.rows) {
    if (r.range <= 0) continue;
    const up = -r.drop / r.range, wd = (-r.windage / r.range) / u;
    let cells;
    if (sc.mode === 'drum') { const d = drumFor(up); cells = `<td>${d.drum}</td><td>${arrow(d.rest / u)}</td>`; }
    else if (sc.mode === 'hold') { const b = bdcFor(up); cells = `<td>${b.mark === 1 ? 'tip' : b.mark}</td><td>${arrow(b.rest / u)}</td>`; }
    else cells = `<td>${(up / u).toFixed(1)}</td>`;
    h += `<tr class="${Math.abs(r.range - S.dist) < 1 ? 'at' : ''}"><td>${(metric ? r.range : r.range / YD).toFixed(0)}</td>${cells}<td>${Math.abs(wd).toFixed(1)}${wd > 0.05 ? 'R' : wd < -0.05 ? 'L' : ''}</td><td>${(metric ? r.speed : r.speed / FT).toFixed(0)}</td><td>${r.time.toFixed(2)}</td></tr>`;
  }
  t.innerHTML = h;
}

function resultsUI() {
  if (!shot) return;
  const o = $('outcome');
  const sh = shot;
  const mil = (m) => ((m / S.dist) * 1e3).toFixed(2);
  $('watch').hidden = !((sh.hit && S.tgt === 'dummy') || (S.tgt === 'v8' && sh.glass && sh.glass.penetrated));
  if (S.tgt === 'v8' && sh.glass && sh.glass.onGlass) {
    const gl = sh.glass;
    if (gl.penetrated) { o.className = 'bad'; o.textContent = `Through the armoured windscreen: ${gl.vin.toFixed(0)} → ${gl.vout.toFixed(0)} m/s, on to the driver.`; $('watch').href = liquidsUrl(sh); }
    else if (gl.rebounded) { o.className = 'ok'; o.textContent = `Glanced off the windscreen at ${(90 - Math.abs(gl.pitch) / DEG).toFixed(0)}° to the glass: the driver is safe.`; }
    else { o.className = 'ok'; o.textContent = `The armoured windscreen stopped it ${(gl.depth * 1000).toFixed(0)} mm in: the driver is safe.`; }
  } else if (S.tgt === 'v8') {
    o.className = 'warn';
    o.textContent = sh.impact ? `It missed the windscreen: ${fmtLen(Math.abs(sh.impact.right))} ${sh.impact.right >= 0 ? 'right' : 'left'}, ${fmtLen(Math.abs(sh.impact.up))} ${sh.impact.up >= 0 ? 'high' : 'low'} (bodywork or past).` : 'It never reached the car.';
  } else if (sh.hit && S.tgt === 'dummy') {
    o.className = 'ok';
    o.textContent = `Hit the dummy (${dummyPart(sh.impact)}) through ${sh.S.glazing === 'none' ? 'the open air' : 'the glass'}: watch it in the Liquids Lab.`;
    $('watch').href = liquidsUrl(sh);
  } else if (sh.hit) {
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
  if (sh.glass && sh.glass.onGlass) kv.push(['Glass Dynamics', `${sh.glass.outcome} · struck at ${(90 - Math.abs(sh.glass.pitch) / DEG).toFixed(0)}° to the glass`]);
  kv.push(['Muzzle', `${fmtV(sh.muzzleSpeed)} · Mach ${(sh.muzzleSpeed / sh.air.speedOfSound).toFixed(2)}`]);
  if (S.spin) kv.push(['Stability Sg', `${sh.sg.toFixed(2)} → ${sh.round.stability.toFixed(2)}${sh.round.tumbling ? ' · TUMBLED' : ''}`]);
  if (sh.round.subsonicTime > 0) {
    const st = B.stateAt(sh.t0 + sh.round.subsonicTime);
    kv.push(['Went subsonic at', fmtDist(lof(st.position).d)]);
  }
  {
    const sc = scopeOf(), a = sh.aim, side = (r) => (r >= 0 ? 'R' : 'L');
    kv.push(['Aimed', sh.S.aim === 'manual' ? `by hand: ${fmtU(a.up)} ${a.up >= 0 ? 'up' : 'down'} · ${fmtU(a.right)} ${side(a.right)}`
      : `${fmtU(a.up)} ${a.up >= 0 ? 'up' : 'down'} · ${fmtU(a.right)} ${side(a.right)} (${sc.name})`]);
  }
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

function drawV8Cracks(gl) {
  if (!v8Cracks || !gl.cracks) return;
  const pts = [];
  for (const seg of gl.cracks)
    for (let k = 0; k + 6 < seg.length; k += 7) pts.push(seg[k], seg[k + 1], 0, seg[k + 2], seg[k + 3], 0);
  v8Cracks.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
}
// Hit markers: an X flash and a tick on a hit (MW2 style), and on the reticle
// where every shot went; misses marked too when set to every impact.
function hitFeedback(sh) {
  if (S.markers === 'off' || !sh.impact) return;
  const isHit = sh.hit;
  if (isHit) {
    const m = $('hitmark');
    m.classList.remove('on', 'kill');
    void m.offsetWidth;
    m.classList.add('on');
    // Red when it reached the dummy (through the V8's glass, or the dummy target).
    if (S.tgt === 'dummy' || (S.tgt === 'v8' && sh.glass && sh.glass.penetrated)) m.classList.add('kill');
    tick();
  }
  if (isHit || S.markers === 'all') {
    impacts.push({ right: sh.impact.right, up: sh.impact.up, hit: isHit });
    if (impacts.length > 6) impacts.shift();
    if (!isHit && S.tgt === 'plate') {
      const x = label('×', Math.max(0.15, S.size * 0.3), '#ff3b2f', 'rgba(0,0,0,0)');
      x.position.set(sh.impact.right, sightHeight() + sh.impact.up, -S.dist + 0.05);
      range.add(x);
      missMarks.push(x);
      if (missMarks.length > 6) range.remove(missMarks.shift());
    }
  }
}
function tick() {
  const a = audio();
  if (!a || !soundOn) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = 'square'; o.frequency.value = 2400;
  g.gain.setValueAtTime(0.08, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.06);
  o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.07);
}
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2400); }
function banner(a, b) { $('bTitle').textContent = a; $('bSub').textContent = b; $('banner').classList.add('on'); clearTimeout(banner.t); banner.t = setTimeout(() => $('banner').classList.remove('on'), 3200); }

function fireNow() {
  if (S.tgt === 'v8' && !G) { toast('Loading the glass engine for the windscreen…'); $('outcome').className = ''; $('outcome').textContent = 'Loading the glass engine…'; $('watch').hidden = true; ensureGlass().then(() => fireNow()).catch((e) => toast('Glass engine: ' + e.message)); return; }
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

$('cartridge').onchange = (e) => { S.c = e.target.value; resetAim(); syncUI(); changed(true); };
{
  const gsel = $('glazing');
  const none = document.createElement('option'); none.value = 'none'; none.textContent = 'No glass'; gsel.appendChild(none);
  const groups = {};
  for (const g of glazings) {
    if (!['automotive', 'architectural', 'security'].includes(g.category)) continue;
    if (!groups[g.category]) { groups[g.category] = document.createElement('optgroup'); groups[g.category].label = { automotive: 'Cars', architectural: 'Buildings', security: 'Bullet-resistant' }[g.category]; gsel.appendChild(groups[g.category]); }
    const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; groups[g.category].appendChild(o);
  }
}
$('tgt').onchange = (e) => { S.tgt = e.target.value; if (S.tgt === 'v8') { ensureCar(); ensureGlass().catch(() => {}); } syncUI(); changed(true); };
$('markers').onchange = (e) => { S.markers = e.target.value; store.set('markers', S.markers); };
$('tracer').onchange = (e) => { S.tracer = e.target.value; store.set('tracer', S.tracer); };
$('tracerToImpact').onchange = (e) => { S.tracerToImpact = e.target.checked; store.set('tracerToImpact', S.tracerToImpact); };
// Scope and aim.
function turretUI() {
  const t = turretText();
  $('tEl').textContent = t.el;
  $('tWd').textContent = t.wd;
}
const click = () => noiseBurst(0.012, 5200, 0.1, 4);  // a turret detent
function turn(which, k) {
  const sc = scopeOf();
  if (which === 'el') S.turret.el = sc.mode === 'drum' ? Math.max(1, Math.min(sc.drumMax, S.turret.el + k)) : S.turret.el + k;
  else S.turret.wd += k;
  turretUI();
  click();
}
function nudge(up, right) {
  const u = scopeOf().unit;
  S.hold.up += up * u;
  S.hold.right += right * u;
}
$('scope').onchange = (e) => { S.scope = e.target.value; store.set('scope', S.scope); resetAim(); syncUI(); changed(true); };
$('aim').onchange = (e) => { S.aim = e.target.value; store.set('aim', S.aim); resetAim(); syncUI(); };
$('hint').onchange = (e) => { S.hint = e.target.checked; store.set('hint', S.hint); };
$('tElUp').onclick = () => turn('el', 1);
$('tElDn').onclick = () => turn('el', -1);
$('tWdR').onclick = () => turn('wd', 1);
$('tWdL').onclick = () => turn('wd', -1);
$('bDial').onclick = () => {
  const sc = scopeOf(), p = plan(dope.hold);
  S.turret.el = sc.mode === 'drum' ? p.drum : sc.mode === 'hold' ? 0 : Math.round(dope.hold.up / sc.click);
  S.turret.wd = 0;
  turretUI();
};
$('bCentre').onclick = () => { S.hold = { up: 0, right: 0 }; };
$('bTrace').onclick = () => { showTrace = !showTrace; store.set('trace', showTrace); $('bTrace').setAttribute('aria-pressed', String(showTrace)); };
$('bTrace').setAttribute('aria-pressed', String(showTrace));
$('glazing').onchange = (e) => { S.glazing = e.target.value; changed(true); };
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
$('bHelp').onclick = () => $('help').classList.add('on');
$('bHelpClose').onclick = () => $('help').classList.remove('on');
$('help').onclick = (e) => { if (e.target.id === 'help') $('help').classList.remove('on'); };
function shareUrl(sh, absolute = true) {
  const X = sh ? sh.S : S;
  const q = new URLSearchParams({ c: X.c, d: X.dist, sz: X.size, t: X.temp, a: X.alt, h: X.rh, lat: X.lat, az: X.az,
    w: (X.same ? X.layers.slice(0, 1) : X.layers).map((l) => [l.spd, l.clock, l.gust].join(',')).join(';'),
    cw: X.callTrue ? 'true' : [X.call.spd, X.call.clock].join(','),
    f: (X.spin ? 's' : '') + (X.earth ? 'e' : '') + (X.solver ? 'k' : ''), ts: sh ? sh.t0 : X.t0, fire: 1 });
  if (X.tgt === 'dummy') { q.set('tg', 'dummy'); q.set('gz', X.glazing); }
  if (X.tgt === 'v8') q.set('tg', 'v8');
  if (S.tracer !== 'off') q.set('tr', S.tracer + (S.tracerToImpact ? '' : '.real'));
  if (X.scope && X.scope !== 'own') q.set('sc', X.scope);
  if (X.aim === 'manual') {
    q.set('am', 'm');
    q.set('tu', `${X.turret.el},${X.turret.wd}`);
    q.set('ho', `${Math.round(X.hold.up * 1e6)},${Math.round(X.hold.right * 1e6)}`);
  }
  return `${absolute ? location.origin : ''}/sao-paulo/ballistics/?${q}`;
}
$('bShare').onclick = async () => {
  const url = shareUrl(shot);
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
  else if (e.key === 't' || e.key === 'T') $('bTrace').click();
  else if (e.key === 'u' || e.key === 'U') $('bUnits').click();
  else if (e.key === 'h' || e.key === 'H') $('help').classList.toggle('on');
  else if (S.aim === 'manual' && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const k = e.shiftKey ? 0.5 : 0.1;
    nudge(e.key === 'ArrowUp' ? k : e.key === 'ArrowDown' ? -k : 0, e.key === 'ArrowRight' ? k : e.key === 'ArrowLeft' ? -k : 0);
  }
  else if (S.aim === 'manual' && (e.key === 'r' || e.key === 'R')) turn('el', 1);
  else if (S.aim === 'manual' && (e.key === 'f' || e.key === 'F')) turn('el', -1);
  else if (S.aim === 'manual' && (e.key === 'e' || e.key === 'E')) turn('wd', 1);
  else if (S.aim === 'manual' && (e.key === 'q' || e.key === 'Q')) turn('wd', -1);
  else if (e.key === '+' || e.key === '=') zoomBy(1);
  else if (e.key === '-') zoomBy(-1);
});
// Drag to look around (shooter and target cameras); wheel zooms the scope.
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ...orbit, hold: { ...S.hold } }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (cam === 'scope' && S.aim === 'manual') {
    const k = (scopeFov() * DEG) / canvas.clientHeight / 3;  // a third of the screen's motion: a steady hand
    S.hold = { up: drag.hold.up - (e.clientY - drag.y) * k, right: drag.hold.right + (e.clientX - drag.x) * k };
    return;
  }
  orbit.yaw = drag.yaw - (e.clientX - drag.x) * 0.004; orbit.pitch = Math.max(-0.6, Math.min(0.6, drag.pitch + (e.clientY - drag.y) * 0.003)); });
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => { if (cam === 'scope') zoomBy(e.deltaY < 0 ? 1 : -1); }, { passive: true });

// ---------- Frame ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
  R.setPixelRatio(dpr);
  R.setSize(w, h, false);
  rt.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
  wakeRT.setSize(Math.floor(w * dpr / 2), Math.floor(h * dpr / 2));
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
      hitFeedback(shot);
      if (S.tgt === 'v8' && shot.glass && shot.glass.onGlass) {
        drawV8Cracks(shot.glass);
        noiseBurst(0.35, 3000, 0.4);
        banner(shot.glass.penetrated ? 'Through the glass' : 'Stopped', shot.glass.penetrated ? `${shot.glass.vin.toFixed(0)} → ${shot.glass.vout.toFixed(0)} m/s: watch it in the Liquids Lab` : 'the armoured windscreen held');
      } else if (shot.hit && S.tgt === 'dummy') {
        banner('Hit', `the dummy's ${dummyPart(shot.impact)} at ${fmtDist(S.dist)}: watch it in the Liquids Lab`);
      } else if (shot.hit) {
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
    const hud = `${fmtDist(lof(st.position).d)}<span>·</span>${fmtV(Math.hypot(...st.velocity))}<span>·</span>Mach ${M.toFixed(2)}<span>·</span>${(st.spin / (2 * Math.PI)).toFixed(0)} turns/s`;
    $('hud').innerHTML = phase === 'flight' ? hud : '';
  } else {
    $('hud').innerHTML = '';
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
    const ah = sightHold();
    scopeCam.lookAt(ah.right * D, sightHeight() + ah.up * D, -D);
    scopeCam.updateProjectionMatrix();
    rifle.visible = false;
    mirage.uniforms.scope.value = 1;
    updateTracer(tEngine, false, scopeCam.fov);
    present(scopeCam, tEngine);
    drawReticle(dope);
    path.visible = false;
    return;
  }
  mirage.uniforms.scope.value = 0;
  mirage.uniforms.amp.value = 0;
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
    path.visible = !!shot && phase === 'after';  // in flight the trace shows the way
  }
  camera.updateProjectionMatrix();
  updateTracer(tEngine, cam === 'bullet', camera.fov);
  present(camera, tEngine);
}

// Draw the scene through the final pass: the trace bends it, the scope adds
// its tube and the mirage.
const clearTmp = new THREE.Color();
function present(cam, tEngine) {
  R.setRenderTarget(rt);
  R.render(scene, cam);
  let n = 0;
  if (showTrace && shot && phase !== 'idle') {
    const p = projRaw(shot.S.c);
    const w = B.wake(tEngine, Math.max(0.25, shot.S.dist / 6000), 0.5, p.mass_gr * 6.479891e-5, p.diameter_in * IN);
    n = Math.min(MAX_WAKE, w.length / 6);
    for (let k = 0; k < n; ++k) {
      const q = v3([w[6 * k], w[6 * k + 1], w[6 * k + 2]]);
      wCenter.setXYZ(k, q.x, q.y, q.z);
      wRadius.setX(k, w[6 * k + 3]);
      wStrength.setX(k, w[6 * k + 4]);
    }
    wCenter.needsUpdate = wRadius.needsUpdate = wStrength.needsUpdate = true;
  }
  wakeGeo.instanceCount = n;
  R.getClearColor(clearTmp);
  const ca = R.getClearAlpha();
  R.setRenderTarget(wakeRT);
  R.setClearColor(0x000000, 0);
  R.clear();
  if (n) {
    wakeMat.uniforms.pxScale.value = (2 * Math.tan((cam.fov * DEG) / 2)) / (wakeRT.height || 1);
    R.render(wakeScene, cam);
  }
  R.setClearColor(clearTmp, ca);
  mirage.uniforms.wakeGain.value = n ? 0.012 : 0;
  R.setRenderTarget(null);
  R.render(post, postCam);
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
// The Glass engine (for the V8's windscreen) loads in the background.
setTimeout(() => ensureGlass().catch(() => {}), 1500);
// For the browser console: the engine and the current shot.
window.ballisticsRange = { B, R, wakeRT, wakeGeo, get shot() { return shot; }, get G() { return G; }, get S() { return S; }, get dope() { return dope; } };
