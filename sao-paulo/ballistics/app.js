// São Paulo World · Ballistics Range.
// Physics: the Ballistic Dynamics exterior-ballistics core (C++, MIT) compiled
// to WebAssembly, flying through Aviation Dynamics' standard atmosphere.
// Rendering: three.js (MIT). This file only draws what the core returns and
// reads input: every drop, drift, spin and wobble comes from the core.
import * as THREE from 'three';
import createBallisticModule from './ballistic.mjs';
import { hostRtc, joinRtc, deliverAnswer, localLink, meetLink, newDuelId } from './duel-net.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw-ballistics:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw-ballistics:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const DEG = Math.PI / 180, IN = 0.0254, YD = 0.9144, FT = 0.3048, KMH = 1 / 3.6, MPH = 0.44704;
// The zero: rifles at 100 m; pistols at 25 m and sub-machine guns at 50 m
// (the P90 and its reflex sight at 100 m), the distances their sights are
// usually set for. The shooter can change it.
const ZERO_FOR = { pistol_9mm: 25, glock_17: 25, colt_1911: 25, sw_686: 25, fn_fiveseven: 25, mp5a3: 50, thompson_m1a1: 50, fn_p90: 100 };
const ZEROS = [10, 15, 25, 50, 100, 200, 300];
const defaultZero = (cid) => ZERO_FOR[RIFLE_FOR[cid]] ?? 100;
const zero = () => S.zero ?? defaultZero(S.c);
const BENCH = 1.2;         // m: the muzzle over the ground (a bench)
const SCALES = [[1, '1×'], [0.1, '1/10'], [0.01, '1/100'], [1e-3, '1/1k']];
const RIFLE_FOR = { fgmm_308_175: 'm24_sws', hornady_65cm_140: 'bolt_65cm', lapua_338lm_250: 'bolt_338lm',
  hornady_50bmg_750: 'm107_50bmg', federal_xm855: 'm16a2', speer_9mm_124gd: 'pistol_9mm',
  cheytac_408_419: 'm200_408', hornady_65cm_147: 'bolt_65cm', ussr_762x54r_l: 'm9130_pu', ussr_762x54r_7n1: 'svd_pso1',
  federal_9mm_115_fmj: 'glock_17', federal_9mm_124_fmj: 'glock_17', mp5_9mm_124_fmj: 'mp5a3', federal_45acp_230_fmj: 'colt_1911',
  thompson_45acp_230: 'thompson_m1a1', federal_357mag_158_jsp: 'sw_686', fn_57_ss197sr: 'fn_fiveseven', fn_57_ss197sr_p90: 'fn_p90' };
// What kind of gun: it sets the sights, the zero and the model on the bench.
const HANDGUNS = new Set(['pistol_9mm', 'glock_17', 'colt_1911', 'sw_686', 'fn_fiveseven']);
const SMGS = new Set(['mp5a3', 'fn_p90', 'thompson_m1a1']);
// Fully automatic: holding Space keeps firing at the gun's cyclic rate.
const AUTOMATIC = new Set(['mp5a3', 'fn_p90', 'thompson_m1a1']);
const gunClass = (cid = S.c) => (HANDGUNS.has(RIFLE_FOR[cid]) ? 'handgun' : SMGS.has(RIFLE_FOR[cid]) ? 'smg' : 'rifle');
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
  // Travel and a turn of the turret: typical of 3-32x long-range scopes
  // (estimated): about 30 mil (100 MOA) of elevation, 10 mil (35 MOA) of
  // windage each way, 10 mil or 15 MOA a turn.
  mil: { kind: 'mil', mode: 'dial', name: 'Mil-dot', unit: 1e-3, unitName: 'mil', click: 1e-4, travel: 0.030, wTravel: 0.010, rev: 0.010 },
  moa: { kind: 'moa', mode: 'dial', name: 'MOA', unit: MOA, unitName: 'MOA', click: MOA / 4, travel: 100 * MOA, wTravel: 35 * MOA, rev: 15 * MOA },
  acog: { kind: 'acog', mode: 'hold', name: 'ACOG', mag: 4, fov: 7, unit: MOA, unitName: 'MOA', click: MOA / 4 },
  pso1: { kind: 'pso1', mode: 'drum', name: 'PSO-1', mag: 4, fov: 6, drumMax: 10, unit: THOU, unitName: 'thousandths', click: THOU / 2 },
  pu: { kind: 'pu', mode: 'drum', name: 'PU', mag: 3.5, fov: 4.5, drumMax: 13, unit: THOU, unitName: 'thousandths', click: THOU / 2 },
  // No magnification and no tube: the eye's own view, the sight drawn over
  // it. Irons: a square post in a square notch, the target sitting on the
  // post (the post covers about 1.1 deg; the notch shows a little light each
  // side, estimated from service pistols). Red dot: a 2 MOA dot (as common
  // pistol and carbine dots). Field shown: 20 deg (a reading of the scene,
  // not a property of the sight).
  iron: { kind: 'iron', mode: 'hold', name: 'Iron sights', mag: 1, fov: 20, tube: false, unit: MOA, unitName: 'MOA', click: MOA },
  dot: { kind: 'dot', mode: 'hold', name: 'Red dot', mag: 1, fov: 20, tube: false, unit: MOA, unitName: 'MOA', click: MOA },
};
const RIFLE_SCOPE = { m9130_pu: 'pu', svd_pso1: 'pso1', m16a2: 'acog', pistol_9mm: 'iron', glock_17: 'iron', colt_1911: 'iron', sw_686: 'iron',
  fn_fiveseven: 'iron', mp5a3: 'iron', thompson_m1a1: 'iron', fn_p90: 'dot' };
const scopeKey = () => (S.scope && S.scope !== 'own' ? S.scope : RIFLE_SCOPE[RIFLE_FOR[S.c]] ?? 'mil');
const scopeOf = () => SCOPES[scopeKey()];
// Tracers: the colour is the shooter's choice; the trace lights a little way
// out and burns out about here (m), by calibre. M62 7.62 NATO: at least 775 m
// (published, RWS datasheet); the rest estimated.
const TRACER_COLOURS = { red: 0xff3a24, green: 0x5dff4a, orange: 0xff9a1f, yellow: 0xffe14a, white: 0xf4f1ff };
const TRACER_BURNOUT = { m855_224_62: 800, eldm_264_140: 900, eldm_264_147: 900, smk_308_175: 800, l_762x54r_148: 1000,
  '7n1_762x54r_151': 1000, scenar_338_250: 1000, cheytac_408_419: 1200, amax_510_750: 1600, gdhp_355_124: 250,
  fmj_355_115: 200, fmj_355_124: 200, fmj_452_230: 200, jsp_357_158: 200, vmax_224_40_57: 300 };
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
  Object.defineProperty(raw, '__text', { value: text });
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
  // Pistols and sub-machine guns (the second group of buttons).
  { id: 'g17_7', short: true, feature: true, name: '7 m', sub: 'Glock 17 · 9 mm · it hits low up close',
    s: { c: 'federal_9mm_124_fmj', zero: 25, dist: 7, size: 0.15, temp: 24, alt: 760, rh: 60, lat: -23.55, az: 0,
      same: true, layers: [layer(5, 3, 1), layer(5, 3, 1), layer(5, 3, 1)], callTrue: true, call: layer(5, 3) } },
  { id: 'g17_25', short: true, feature: true, name: '25 m', sub: 'Glock 17 · on the zero',
    s: { c: 'federal_9mm_124_fmj', zero: 25, dist: 25, size: 0.15, temp: 24, alt: 760, rh: 60, lat: -23.55, az: 0,
      same: true, layers: [layer(8, 3, 2), layer(8, 3, 2), layer(8, 3, 2)], callTrue: true, call: layer(8, 3) } },
  { id: '1911_50', short: true, feature: true, name: '50 m', sub: '1911 · .45 ACP · left-hand twist',
    s: { c: 'federal_45acp_230_fmj', zero: 25, dist: 50, size: 0.2, temp: 20, alt: 0, rh: 50, lat: 40.7, az: 0,
      same: true, layers: [layer(12, 9, 2), layer(12, 9, 2), layer(12, 9, 2)], callTrue: true, call: layer(12, 9) } },
  { id: '686_50', short: true, name: '50 m', sub: '.357 Magnum · S&W 686 revolver',
    s: { c: 'federal_357mag_158_jsp', zero: 25, dist: 50, size: 0.2, temp: 22, alt: 0, rh: 50, lat: -23.55, az: 0,
      same: true, layers: [layer(10, 3, 2), layer(10, 3, 2), layer(10, 3, 2)], callTrue: true, call: layer(10, 3) } },
  { id: '57_100', short: true, name: '100 m', sub: 'Five-seveN · 5.7 mm · flat for a pistol',
    s: { c: 'fn_57_ss197sr', zero: 25, dist: 100, size: 0.25, temp: 22, alt: 0, rh: 50, lat: -23.55, az: 0,
      same: true, layers: [layer(10, 3, 2), layer(10, 3, 2), layer(10, 3, 2)], callTrue: true, call: layer(10, 3) } },
  { id: 'g17_200', short: true, feature: true, name: '200 m', sub: 'Glock 17 · the pistol rainbow',
    s: { c: 'federal_9mm_124_fmj', zero: 25, dist: 200, size: 0.5, temp: 24, alt: 760, rh: 60, lat: -23.55, az: 0,
      same: true, layers: [layer(8, 3, 1), layer(8, 3, 1), layer(8, 3, 1)], callTrue: true, call: layer(8, 3) } },
  { id: 'mp5_100', short: true, feature: true, name: '100 m', sub: 'MP5 · 9 mm · hold Space for full auto',
    s: { c: 'mp5_9mm_124_fmj', zero: 50, dist: 100, size: 0.3, temp: 22, alt: 760, rh: 60, lat: -23.55, az: 0,
      same: true, layers: [layer(10, 3, 3), layer(10, 3, 3), layer(10, 3, 3)], callTrue: true, call: layer(10, 3) } },
  { id: 'p90_150', short: true, feature: true, name: '150 m', sub: 'P90 · 5.7 mm · red dot',
    s: { c: 'fn_57_ss197sr_p90', zero: 100, dist: 150, size: 0.3, temp: 22, alt: 0, rh: 50, lat: 50.6, az: 90,
      same: true, layers: [layer(15, 4, 3), layer(15, 4, 3), layer(15, 4, 3)], callTrue: true, call: layer(15, 4) } },
  { id: 'tommy_100', short: true, name: '100 m', sub: 'Thompson · .45 ACP · the slow heavy ball',
    s: { c: 'thompson_45acp_230', zero: 50, dist: 100, size: 0.4, temp: 10, alt: 0, rh: 70, lat: 49.3, az: 180,
      same: true, layers: [layer(15, 3, 3), layer(15, 3, 3), layer(15, 3, 3)], callTrue: true, call: layer(15, 3) } },
  { id: '9mm', short: true, name: '100 m', sub: '9 mm Gold Dot · service pistol',
    s: { c: 'speer_9mm_124gd', zero: 25, dist: 100, size: 0.3, temp: 22, alt: 0, rh: 50, lat: -23.55, az: 0,
      same: true, layers: [layer(8, 3, 2), layer(8, 3, 2), layer(8, 3, 2)], callTrue: true, call: layer(8, 3) } },
];
const S = structuredClone(SCENARIOS[0].s);
S.zero = 100;
Object.assign(S, { spin: true, earth: true, solver: true, t0: 10, tgt: 'plate', glazing: 'windscreen', markers: store.get('markers', 'hits'), tracer: store.get('tracer', 'off'), tracerToImpact: store.get('tracerToImpact', true),
  scope: store.get('scope', 'own'), aim: store.get('aim', 'assist'), hint: store.get('hint', true), turret: { el: 0, wd: 0 }, hold: { up: 0, right: 0 },
  unique: store.get('unique', true), seedNext: null });
let metric = store.get('metric', true);
// The duel (see the Duel section): null when shooting alone. Seat A is the
// challenger at the range's origin, seat B the friend at the far end, facing
// back down the same range; each draws the range from their own seat.
let duel = null;
const seat = () => (duel ? duel.seat : 'A');
const myAzDeg = () => S.az + (seat() === 'B' ? 180 : 0);

// From the URL: a shared shot.
const Q = new URLSearchParams(location.search);
let autoFire = false;
(function readShare() {
  if (!Q.has('c')) return;
  const n = (k, d) => (Q.has(k) && Number.isFinite(+Q.get(k)) ? +Q.get(k) : d);
  if (cartIndex(Q.get('c')) >= 0) S.c = Q.get('c');
  S.dist = n('d', S.dist); S.size = n('sz', S.size); S.temp = n('t', S.temp); S.alt = n('a', S.alt); S.rh = n('h', S.rh);
  S.lat = n('lat', S.lat); S.az = n('az', S.az); S.t0 = n('ts', S.t0);
  S.zero = Q.has('zr') && ZEROS.includes(+Q.get('zr')) ? +Q.get('zr') : defaultZero(S.c);
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
  if (Q.has('f')) { const f = Q.get('f'); S.spin = f.includes('s'); S.earth = f.includes('e'); S.solver = f.includes('k'); S.unique = f.includes('u'); }
  if (Q.has('sd') && Q.has('sk')) { const sd = Number(Q.get('sd')), sk = Number(Q.get('sk')); if (Number.isSafeInteger(sd) && Number.isSafeInteger(sk) && sd > 0 && sk >= 0) S.seedNext = { seed: sd, stream: sk }; }
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
// Every round unique (the engine's Milestone 4). The ammunition is at the
// air's temperature (it has sat out on the bench); the rifle was zeroed at
// the published velocity, so cold powder hits low and hot powder high. The
// dope knows the powder's temperature when "my dope accounts for…" is on (a
// shooter with a chronograph or a temperature table).
const powderK = () => (S.unique ? S.temp + 273.15 : 0);
const groupOf = (cid) => (S.unique ? rifleRaw(cid)?.group_moa ?? 0 : 0);
function setup(forDope) {
  let f = 0;
  if (S.spin && (!forDope || S.solver)) f |= 1;
  if (S.earth && (!forDope || S.solver)) f |= 2;
  B.bd_setup(twist(), S.lat * DEG, f);
  B.bd_powder(forDope && !S.solver ? 0 : powderK());
  B.bd_group(groupOf(S.c));
}
// Each round's draw: its own stream of a seed. A shared link replays its
// shot's (seed, stream); in a duel both browsers use the shooter's.
const sessionSeed = Number(crypto.getRandomValues(new Uint32Array(1))[0]) * 1024 + 1;
let streamCount = 0;
function nextSeed() {
  if (!S.unique) return null;
  if (S.seedNext) { const x = S.seedNext; S.seedNext = null; return x; }
  if (duel) return { seed: duel.seed, stream: (duel.seat === 'A' ? 1 : 2) * 1e6 + duel.sent + 1 };
  return { seed: sessionSeed, stream: ++streamCount };
}
// The chance that a round lands inside a centred w x h box, or a circle of
// radius r, for normal spreads sh (across) and sv (vertical): perfect call.
function erf(x) {  // Abramowitz and Stegun 7.1.26, to 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const chanceBox = (w, h, sh, sv) => erf(w / 2 / (Math.SQRT2 * sh)) * erf(h / 2 / (Math.SQRT2 * sv));
const chanceCircle = (r, sh, sv) => 1 - Math.exp(-(r * r) / (2 * sh * sv));
// My last shots at these settings, for the group they make.
let groupLog = [];
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
  let clock = Math.atan2(x, y) / DEG / 30 + (seat() === 'B' ? 6 : 0);  // the layers are in seat A's frame
  if (clock <= 0) clock += 12;
  if (clock > 12) clock -= 12;
  return layer(Math.hypot(x, y), clock);  // exact; shown to a tenth of an hour
}
const call = () => (S.callTrue ? averageWind() : S.call);
const callLayers = () => { const c = call(); return [{ fromRange: 0, speed: c.spd * KMH, fromBearing: (myAzDeg() + c.clock * 30) * DEG, gust: 0 }]; };

// ENU <-> the line of fire (downrange d, right r, up u) <-> three.js (x right, y up, -z downrange).
function lof(p) {
  const s = Math.sin(S.az * DEG), c = Math.cos(S.az * DEG);
  const d = p[0] * s + p[1] * c, r = p[0] * c - p[1] * s;
  // From seat B the range runs the other way: downrange from the far end.
  return seat() === 'B' ? { d: S.dist - d, r: -r, u: p[2] } : { d, r, u: p[2] };
}
function enu(d, r, u) {
  if (seat() === 'B') { d = S.dist - d; r = -r; }
  const s = Math.sin(S.az * DEG), c = Math.cos(S.az * DEG);
  return [d * s + r * c, d * c - r * s, u];
}
const v3 = (p) => { const l = lof(p); return new THREE.Vector3(l.r, l.u, -l.d); };

const dopeStep = (d) => (d <= 30 ? 5 : d <= 120 ? 10 : d <= 300 ? 25 : d <= 600 ? 50 : d <= 1200 ? 100 : 200);
// The shooter's solution: holds for the called wind (and, if ticked, the
// spin and the Earth), and a dope card.
function solveDope() {
  drumTable();  // engraved before the day's air goes in
  station();
  setup(true);
  B.wind(S.az * DEG, callLayers());
  const step = dopeStep(S.dist);
  const rows = B.table(ci(), zero(), sightHeight(), Math.max(S.dist, step), step, myAzDeg() * DEG);
  const at = B.table(ci(), zero(), sightHeight(), S.dist, S.dist, myAzDeg() * DEG).at(-1);
  // The target's own row, when the steps pass it by (1 mile, 2 miles).
  if (at && !rows.some((r) => Math.abs(r.range - S.dist) < 0.5)) { rows.push(at); rows.sort((a, b) => a.range - b.range); }
  const hold = at && at.range > 0 ? { up: -at.drop / S.dist, right: -at.windage / S.dist } : { up: 0, right: 0 };
  // How far apart the rounds land at the target (with this dope's powder).
  const spread = S.unique ? B.spread(ci(), zero(), sightHeight(), S.dist, myAzDeg() * DEG) : null;
  return { rows, hold, spread };
}

// What each effect does at the target, from separate flights in the true air.
// Each flown at the shot's own moment (t0), so the wind bars meet the same
// gusts the round did.
function breakdown(t0) {
  const at = (flags, wind, powder = powderK()) => {
    station();
    B.bd_setup(twist(), S.lat * DEG, flags);
    B.bd_powder(powder);
    B.wind(S.az * DEG, wind ? trueLayers() : []);
    return B.table(ci(), zero(), sightHeight(), S.dist, S.dist, myAzDeg() * DEG, t0).at(-1) ?? { drop: 0, windage: 0 };
  };
  const base = at(0, false), wind = at(0, true);
  const out = [{ k: 'Gravity & drag', up: base.drop, right: 0 }, { k: 'Wind', up: wind.drop - base.drop, right: wind.windage }];
  if (powderK()) out.push({ k: 'Powder temp', up: base.drop - at(0, false, 0).drop, right: 0 });
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

// The crash dummy: its chest at the aim point. Which part a shot meets, from
// the same capsules that are drawn (radius, straight length, centre), in the
// Liquids Lab's names.
const DUMMY = { torso: [0.17, 0.42, 0, -0.08], head: [0.1, 0.06, 0, 0.38], arms: [0.055, 0.5, 0.27, -0.06], legs: [0.075, 0.75, 0.1, -0.85] };
function dummyPart(o) {
  const inCap = ([r, len, x, y], mirror) => [x, mirror ? -x : x].some((cx) => Math.hypot(o.right - cx, Math.max(0, Math.abs(o.up - y) - len / 2)) <= r);
  if (inCap(DUMMY.head)) return 'chest';  // the head: the lab aims the chest
  if (inCap(DUMMY.torso)) return Math.abs(o.right) > 0.11 && o.up > 0.05 ? 'shoulder' : o.up < -0.14 ? 'abdomen' : 'chest';
  if (inCap(DUMMY.arms, true)) return 'shoulder';  // an arm: the lab's nearest part
  if (inCap(DUMMY.legs, true)) return 'thigh';
  return null;
}
// The glass impactor nearest in calibre (Glass Dynamics' own bullets).
const glassImpactor = (cid) => {
  const p = projRaw(cid), mv = cat.cartridges[cartIndex(cid)].muzzleVelocity;
  if (mv < 600) return 'pistol_9mm';  // handgun and sub-machine-gun speeds
  return p.diameter_in >= 0.4 ? 'bmg_50' : 'rifle_762';
};
function liquidsUrl(sh) {
  const p = projRaw(sh.S.c), at = sh.atTarget;
  const v = lof(at.velocity), speed = Math.hypot(...at.velocity);
  const q = new URLSearchParams({ from: 'ballistics', name: cat.cartridges[cartIndex(sh.S.c)].name.replace(/\s*\(.*\)$/, ''),
    range: Math.round(sh.S.dist), mass_g: (p.mass_gr * 0.06479891).toFixed(2), dia_mm: (p.diameter_in * 25.4).toFixed(2), v: speed.toFixed(1),
    desc: (Math.atan2(-v.u, v.d) / DEG).toFixed(2), drift: (Math.atan2(v.r, v.d) / DEG).toFixed(2), gi: glassImpactor(sh.S.c),
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
  const ii = Math.max(0, gcat.impactors.findIndex((x) => x.id === glassImpactor(S.c)));
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
// Every round fired is in `shots`, each with its engine id; `shot` is the
// latest, the one the cameras, bullet time and results follow.
let shot = null;
const shots = [];
let tNow = S.t0;     // the range's clock: engine time (s)
let nowWall = 0;     // the page's clock (s)
// Reads a round's state from the engine (selecting it first).
const stateOf = (sh, t) => { B.bd_select(sh.id); return B.stateAt(t); };
function retire(sh) {
  scene.remove(sh.mesh);
  if (sh.tracerGroups) for (const g of sh.tracerGroups) scene.remove(g);
  B.bd_release(sh.id);
  shots.splice(shots.indexOf(sh), 1);
}
function retireAll(keep = null) { for (const sh of [...shots]) if (sh !== keep) retire(sh); }
function fire(tFire) {
  const dope = solveDope();
  station();
  setup(false);
  B.wind(S.az * DEG, trueLayers());
  const e0 = B.bd_zero(ci(), zero(), sightHeight());
  const aim = shotHold(dope);
  const el = e0 + aim.up, az = myAzDeg() * DEG + aim.right, o = enu(0, 0, 0);
  const seed = Number.isFinite(e0) ? nextSeed() : null;
  const id = !Number.isFinite(e0) ? 0 : seed ? B.bd_fire_round(ci(), o[0], o[1], o[2], az, el, tFire, seed.seed, seed.stream) : B.bd_fire(ci(), o[0], o[1], o[2], az, el, tFire);
  const draw = id ? B.lastDraw() : null;
  if (!id) { toast('This load cannot reach the zero.'); return null; }
  // Fly to the target plane, then on to the ground.
  const t0 = tFire;
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
    hit = above && (S.tgt === 'duel' ? figurePart(p.r, p.u) !== null : S.tgt === 'dummy' ? dummyPart(impact) !== null : S.tgt === 'v8' ? true : Math.abs(impact.right) <= S.size / 2 && Math.abs(impact.up) <= S.size / 2);
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
  // Sg where the round meets the target (the flight goes on past it).
  const sgTarget = S.spin && tTarget !== null ? B.table(ci(), zero(), sightHeight(), S.dist, S.dist, myAzDeg() * DEG, t0).at(-1)?.stability ?? 0 : 0;
  const atT = tTarget !== null ? B.stateAt(tTarget) : null;
  // The V8: where the round meets the raked windscreen, and what the glass does to it.
  let glass = null;
  if (S.tgt === 'v8' && hit && atT) {
    glass = strikeV8(impact, atT);
    hit = glass.onGlass;
  }
  const mesh = bullet.clone(true);
  mesh.visible = true;
  scene.add(mesh);
  shot = {
    id, S: structuredClone(S), dope, aim, t0, tEnd, tTarget, tGround, tStop, hit, impact, air, sg, sgTarget, el, az, seed, draw,
    part: S.tgt === 'duel' && hit && atT ? figurePart(lof(atT.position).r, lof(atT.position).u) : null,
    round: B.round(), atTarget: atT, muzzleSpeed: Math.hypot(...B.stateAt(t0).velocity), glass,
    mesh, body: mesh.getObjectByName('body'), len: bullet.userData.length, done: false, doneWall: 0, left: false,
    // The engine keeps the round in the air it was fired into, so the
    // breakdown's flights (new air, new wind) leave it alone.
    bars: breakdown(t0),
  };
  shots.push(shot);
  if (shots.length > 40) retire(shots[0]);  // a full 30-round magazine stays in the air
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
gtex.repeat.set(640, 640);  // 25 m tiles; wide enough that no edge shows from the bullet camera
const ground = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), new THREE.MeshLambertMaterial({ map: gtex }));
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
  // Distance boards on the left (closer in, smaller and more often on a short range).
  const unit = metric ? 1 : YD, near = D < 150;
  const DU = metric ? D : D / YD;
  const every = DU <= 30 ? 5 : DU <= 120 ? 10 : DU <= 300 ? 25 : DU <= 1200 ? 100 : 250;
  for (let k = every; k * unit <= D + (near ? Math.max(10, D * 0.5) : 600); k += every) {
    const x = k * unit;
    const s = label(`${k} ${metric ? 'm' : 'yd'}`, near ? 0.22 + x / 140 : 1.2 + x / 900);
    s.position.set(near ? -1.6 - x * 0.07 : -14 - x / 150, near ? -BENCH + 1.0 + x / 200 : -BENCH + 2.2 + x / 600, -x);
    range.add(s);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2, 6), wood);
    post.position.set(s.position.x, -BENCH + 1, s.position.z);
    range.add(post);
  }
  // Wind flags on the right, every 100 m (200 m past 1 km; closer on a short range).
  const fe = D <= 30 ? 5 : D <= 150 ? 25 : D <= 1000 ? 100 : 200;
  for (let d = fe / 2; d < D; d += fe) {
    const g = new THREE.Group();
    const x = near ? 2 + d * 0.05 : 9 + d / 120;
    g.position.set(x, -BENCH, -d);
    const scale = near ? 0.45 : 1 + d / 1200;
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
  if (S.tgt === 'duel') {
    // The other shooter, prone behind sandbags at the far end, facing you:
    // the head and shoulders over the cover are all there is to hit (the same
    // FIGURE the hit test uses), the muzzle at the bore line.
    const fig = new THREE.Group();
    fig.position.set(0, 0, -D);
    const camo = new THREE.MeshStandardMaterial({ color: 0x5b5d3a, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x4a4a32, roughness: 0.8 });
    const bags = new THREE.MeshStandardMaterial({ color: 0x8c7b57, roughness: 1 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(FIGURE.head.r, 20, 14), skin);
    head.position.set(0, FIGURE.head.z, -0.25);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(FIGURE.torso.w, FIGURE.torso.z1 - FIGURE.torso.z0, 0.5), camo);
    torso.position.set(0, (FIGURE.torso.z0 + FIGURE.torso.z1) / 2, -0.45);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1.6, BENCH + FIGURE.cover, 0.6), bags);
    wall.position.set(0, (-BENCH + FIGURE.cover) / 2, 0.1);
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.7, 10), gunMetal);
    gun.rotation.x = Math.PI / 2;
    gun.position.set(0, 0, 0.05);
    fig.add(head, torso, wall, gun);
    oppFlash.position.set(0, 0, 0.66);
    fig.add(oppFlash);
    range.add(fig);
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
    cap(...DUMMY.torso);                              // torso
    cap(...DUMMY.head);                               // head
    { const [r, l, x, y] = DUMMY.arms; cap(r, l, -x, y); cap(r, l, x, y); }  // arms
    { const [r, l, x, y] = DUMMY.legs; cap(r, l, -x, y); cap(r, l, x, y); }  // legs
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
    bermD.scale.set(near ? 8 : 30 + D / 50, near ? 2.5 : 3 + D / 1000, near ? 3 : 12);
    bermD.position.set(0, -BENCH, -D - (near ? 5 : 30));
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
  berm.scale.set(near ? 8 : 30 + D / 50, near ? 2.5 : 3 + D / 1000, near ? 3 : 12);
  berm.position.set(0, -BENCH, -D - (near ? 5 : 30));
  range.add(berm);
}

// The gun on its bench (the muzzle at the origin, pointing down -z).
const rifle = new THREE.Group();
const gun = new THREE.Group();
rifle.add(gun);
const gunMetal = new THREE.MeshStandardMaterial({ color: 0x1d2024, metalness: 0.6, roughness: 0.5 });
const gunTan = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.8 });
const gunPoly = new THREE.MeshStandardMaterial({ color: 0x24272b, metalness: 0.1, roughness: 0.75 });
function buildGun() {
  gun.clear();
  const r = rifleRaw(S.c), kind = gunClass(), bl = (r?.barrel_in ?? 24) * IN, sh = sightHeight();
  const box = (w, h, d, x, y, z, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); gun.add(o); return o; };
  const tube = (r0, r1, len, z, y, m, name) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 16), m); o.rotation.x = Math.PI / 2; o.position.set(0, y, z); if (name) o.name = name; gun.add(o); return o; };
  if (kind === 'handgun') {
    // Slide over the barrel, the grip behind and below it, the sights on top.
    box(0.03, 0.034, bl + 0.05, 0, 0.004, bl / 2 + 0.02, gunMetal);
    box(0.03, 0.11, 0.05, 0, -0.07, bl + 0.01, gunPoly).rotation.x = -0.25;
    box(0.006, sh - 0.017, 0.006, 0, (sh + 0.017) / 2, 0.012, gunMetal);
    box(0.022, sh - 0.017, 0.008, 0, (sh + 0.017) / 2, bl + 0.03, gunMetal);
    return;
  }
  tube(0.009, 0.012, bl, bl / 2, 0, gunMetal);
  if (kind === 'smg') {
    box(0.05, 0.07, 0.3, 0, -0.005, bl + 0.15, gunPoly);       // receiver
    box(0.035, 0.12, 0.05, 0, -0.09, bl + 0.12, gunPoly);       // magazine
    box(0.03, 0.06, 0.25, 0, -0.04, bl + 0.42, gunTan);        // stock
    if (scopeKey() === 'dot') tube(0.016, 0.016, 0.07, bl + 0.12, sh, gunMetal, 'scope');
    else { box(0.006, sh - 0.03, 0.006, 0, sh / 2 + 0.015, 0.03, gunMetal); box(0.02, sh - 0.03, 0.02, 0, sh / 2 + 0.015, bl + 0.25, gunMetal); }
    return;
  }
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.75), gunTan);
  stock.position.set(0, -0.04, bl + 0.3);
  gun.add(stock);
  const sc = scopeOf();
  if (sc.tube === false) { box(0.006, sh - 0.012, 0.006, 0, sh / 2, 0.02, gunMetal); box(0.02, sh - 0.012, 0.02, 0, sh / 2, bl * 0.8, gunMetal); }
  else tube(0.017, 0.022, 0.36, bl + 0.1, sh, gunMetal, 'scope');
}
{
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
function placeRifle() { buildGun(); }

// The bullet: true size, copper, with the rifling's engraving so the spin shows.
const bullet = new THREE.Group();
const bulletBody = new THREE.Group();
bulletBody.name = 'body';
bullet.add(bulletBody);
bullet.visible = false;  // the pattern each round's own copy is made from
function buildBullet() { makeBullet(S.c, bullet, bulletBody); }
function makeBullet(cid, group, bodyGroup) {
  bodyGroup.clear();
  const p = projRaw(cid);
  const d = p.diameter_in * IN, L = p.length_in * IN;
  const copper = new THREE.MeshStandardMaterial({ color: 0xc27a45, metalness: 0.85, roughness: 0.28 });
  const groove = new THREE.MeshStandardMaterial({ color: 0x6b3a1c, metalness: 0.6, roughness: 0.5 });
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d * 0.42, L * 0.45, 24), copper);
  shank.rotation.x = Math.PI / 2;
  shank.position.z = -L * 0.05;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(d / 2, L * 0.55, 24), copper);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = L * 0.45;
  bodyGroup.add(shank, nose);
  const grooves = (RIFLE_FOR[cid] === 'm24_sws') ? 5 : 6;
  for (let k = 0; k < grooves; ++k) {
    const a = (k / grooves) * Math.PI * 2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(d * 0.12, d * 0.04, L * 0.42), groove);
    m.position.set(Math.cos(a) * d * 0.5, Math.sin(a) * d * 0.5, -L * 0.05);
    m.rotation.z = a;
    bodyGroup.add(m);
  }
  group.userData.length = L;
  group.userData.diameter = d;
  return group;
}
bullet.visible = false;
scene.add(bullet);
// The dashed path. (The shock cone is drawn into the trace's buffer below:
// it bends the light, it does not glow.)
const pathGeo = new THREE.BufferGeometry();
const path = new THREE.Line(pathGeo, new THREE.LineDashedMaterial({ color: 0xffd36b, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.55 }));
path.frustumCulled = false;
scene.add(path);
// Muzzle flash and the dust of a miss.
const flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0 }));
scene.add(flash);
const dust = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshLambertMaterial({ color: 0xb59a74, transparent: true, opacity: 0 }));
scene.add(dust);
// The opponent's muzzle flash (parented to their figure in a duel).
const oppFlash = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0 }));
// What can be hit of a shooter in a duel, from their own muzzle (m: right,
// up): a head over the sights and the shoulders above the sandbags. The
// head is a 22 cm sphere, the shoulders 44 cm wide; everything below the
// cover's top is behind it. Both browsers test against these same numbers.
const FIGURE = { head: { z: 0.06, r: 0.11 }, torso: { w: 0.44, z0: -0.3, z1: -0.04 }, cover: -0.3 };
function figurePart(right, z) {
  if (Math.hypot(right, z - FIGURE.head.z) <= FIGURE.head.r) return 'head';
  if (Math.abs(right) <= FIGURE.torso.w / 2 && z >= FIGURE.torso.z0 && z <= FIGURE.torso.z1) return 'shoulder';
  return null;
}
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
function tracerGroups(sh) {
  if (!sh.tracerGroups)
    sh.tracerGroups = [false, true].map((life) => {
      const grp = new THREE.Group();
      for (let k = 0; k < TRACER_N; ++k)
        grp.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: life })));
      grp.visible = false;
      scene.add(grp);
      return grp;
    });
  return sh.tracerGroups;
}
function updateTracer(life, fov) {
  const screen = 2 * Math.tan((fov * DEG) / 2);  // a glow's size as a share of the view's height
  const col = TRACER_COLOURS[S.tracer];
  for (const sh of shots) {
    if (sh.tracerGroups) for (const g of sh.tracerGroups) g.visible = false;
    if (S.tracer === 'off' || tNow < sh.t0) continue;
    const fade = sh.done ? Math.exp(-(nowWall - sh.doneWall) * 8) : 1;
    if (fade < 0.02) continue;
    const grp = tracerGroups(sh)[life ? 1 : 0], burn = S.tracerToImpact ? Infinity : tracerBurnout(projRaw(sh.S.c));
    const tE = Math.min(tNow, sh.tStop);
    grp.visible = true;
    B.bd_select(sh.id);
    for (let k = 0; k < TRACER_N; ++k) {
      const sp = grp.children[k], t = tE - k * TRACER_DT;
      const st = t >= sh.t0 ? B.stateAt(t) : null, d = st ? (sh.remote ? S.dist - lof(st.position).d : lof(st.position).d) : -1;
      sp.visible = !!st && d >= TRACER_LIGHTS && d <= burn;
      if (!sp.visible) continue;
      sp.position.copy(v3(st.position));
      if (k === 0 && life) sp.position.addScaledVector(v3(st.velocity).normalize(), -sh.len * 0.5);
      const f = 1 - k / TRACER_N;
      // A white-hot core at the head, the colour along the streak.
      sp.material.color.setHex(col);
      if (k === 0) sp.material.color.lerp(new THREE.Color(0xffffff), life ? 0.35 : 0.12);
      sp.material.opacity = (k === 0 ? 1 : 0.45 * f * f) * fade;
      const sz = life ? (k === 0 ? 0.03 : 0.02 * f) : screen * (k === 0 ? 0.022 : 0.012 * (0.4 + 0.6 * f));
      sp.scale.set(sz, sz, 1);
    }
  }
}
// ---------- Scope: render target, mirage, reticle ----------
const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
// The trace: the engine's wake, drawn as how much it bends the light behind
// it (a refractive tube along the path), into its own buffer.
const wakeRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const wakeScene = new THREE.Scene();
const MAX_WAKE = 6000;
const wakeGeo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(2, 2));
const wCenter = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WAKE * 3), 3);
const wRadius = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WAKE), 1);
const wStrength = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WAKE), 1);
const wDir = new THREE.InstancedBufferAttribute(new Float32Array(MAX_WAKE * 4), 4);
wakeGeo.setAttribute('aCenter', wCenter); wakeGeo.setAttribute('aRadius', wRadius); wakeGeo.setAttribute('aStrength', wStrength); wakeGeo.setAttribute('aDir', wDir);
wakeGeo.instanceCount = 0;
// Each stretch of wake bends the light that crosses it. Its index change
// is the engine's `index` (in sea-level n - 1 = 2.9e-4), so a ray that runs
// a length l through it, across a width r, turns by about
// 2.9e-4 index l / r. Seen from the side l is its width (2r): next to
// nothing. Seen end-on from behind the rifle, l is the stretch's length
// along the path, and the stretches line up and add: a .308's trace then
// turns the light by a few tenths of a milliradian, many times the mirage,
// and a spotter sees it. The output is in pixels of the wake buffer.
const wakeMat = new THREE.ShaderMaterial({
  uniforms: { pxScale: { value: 0.001 } },
  vertexShader: `attribute vec3 aCenter; attribute vec4 aDir; attribute float aRadius, aStrength; uniform float pxScale;
    varying vec2 vC; varying float vS, vH;
    void main(){ vec4 mv = viewMatrix * vec4(aCenter, 1.); float depth = max(0.01, -mv.z);
      // The length a ray from the eye runs inside this stretch.
      vec3 ray = normalize(aCenter - cameraPosition);
      float c = abs(dot(ray, aDir.xyz)), s = sqrt(max(0., 1. - c * c));
      float len = min(aDir.w / max(c, 1e-3), 2. * aRadius / max(s, 1e-3));
      // Its turn (rad), capped where the near wake is not modelled anyway.
      float turn = min(2.9e-4 * aStrength * len / aRadius, 2e-3);
      // A wake thinner than a few pixels is drawn a few pixels wide, keeping its integrated turn.
      float r = max(aRadius, 2.5 * pxScale * depth);
      mv.xy += position.xy * r; vC = position.xy;
      vS = turn / pxScale * aRadius / r;               // pixels
      vH = sqrt(aStrength) * aRadius / r;              // for condensation haze only
      gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec2 vC; varying float vS, vH;
    void main(){ float r2 = dot(vC, vC); if (r2 > 1.) discard; float f = exp(-3. * r2);
      // Hot air has the lower index: light leaving the eye bends away from the
      // wake's core, so the scene behind is fetched from further out.
      gl_FragColor = vec4(vC * f * vS, f * vH, 1.); }`,
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
});
const wakeMesh = new THREE.Mesh(wakeGeo, wakeMat);
wakeMesh.frustumCulled = false;
wakeScene.add(wakeMesh);
// The Mach cone, seen from the bullet camera: a thin shell where the air
// jumps in density, so it bends light most where the eye looks along it
// (its edge on the screen). Its apex at the nose, its axis along the round's
// velocity through the air, its half-angle asin(1/M). The jump at the cone's
// rim from Whitham's far-field rule for a projectile, dp/p = 0.53 (M^2 - 1)^(1/8)
// d / (r^(3/4) l^(1/4)), and drho/rho = dp / (gamma p): a few per cent a
// hand's width from a rifle bullet, falling as r^(-3/4) (the rule is a
// far-field one, stretched here to tens of centimetres).
// To the naked eye that jump turns light by only a few tenths of a
// milliradian, at the cone's edge: invisible from the bullet camera. It is
// drawn 20 times stronger, as a schlieren photograph shows it: presentation,
// not physics (said so on How it works).
const SCHLIEREN = 20;
const shock = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 48, 1, true), new THREE.ShaderMaterial({
  uniforms: { strength: { value: 0 }, pxScale: { value: 0.001 } },
  vertexShader: `varying vec3 vN, vV; varying float vK; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); vV = mv.xyz; vK = 0.5 - position.y; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float strength, pxScale; varying vec3 vN, vV; varying float vK;
    void main(){ float g = 1. - abs(dot(normalize(vN), normalize(-vV))); g = g * g * g;
      // strength is the jump at the drawn rim (vK = 1); it grows toward the
      // apex as r^(-3/4), and fades out before the drawn cone ends so its
      // edge does not show (the real cone goes on, ever weaker).
      g *= min(4., pow(max(vK, 0.02), -0.75)) * smoothstep(1., 0.45, vK);
      g *= smoothstep(0.04, 0.12, length(vV));  // not where the shell passes the eye
      gl_FragColor = vec4(normalize(vN).xy * g * strength / pxScale, 0., 1.); }`,
  transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
}));
shock.frustumCulled = false;
shock.visible = false;
wakeScene.add(shock);
// Condensation: the trace is refraction only, unless the air is near
// saturation, when the cooling behind the round can fog it (photographs of
// bullets in humid air show it). The white haze is kept for that case.
const hazeFor = (rh) => Math.max(0, Math.min(1, (rh - 85) / 15));
let showTrace = store.get('trace', true);
const post = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const mirage = new THREE.ShaderMaterial({
  uniforms: { tex: { value: rt.texture }, wake: { value: wakeRT.texture }, wakeGain: { value: 0 }, scope: { value: 1 },
    t: { value: 0 }, amp: { value: 0.0006 }, drift: { value: 0 }, aspect: { value: 1 }, haze: { value: 0 }, cell: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    uniform sampler2D tex, wake; uniform float t, amp, drift, aspect, wakeGain, scope, haze, cell; varying vec2 vUv;
    void main(){
      vec2 p = vUv;
      // The trace: the wake bends the light through it.
      vec3 wk = texture2D(wake, vUv).xyz;
      p += wk.xy * wakeGain * vec2(1. / aspect, 1.);  // pixels to the view's width and height
      // Heat shimmer: rising, boiling waves that lean and run with the crosswind.
      // (cell: the shimmer's cells have a fixed size in the sky, so they
      // fill more of a narrower view.)
      float w1 = sin(cell * (p.y * 260. - p.x * 60. * drift) + t * 5.1 + drift * t * 9.);
      float w2 = sin(cell * (p.y * 170. + p.x * 90.) - t * 3.7 + drift * t * 6.);
      p.x += amp * (0.6 * w1 + 0.4 * w2);
      p.y += amp * 0.5 * sin(cell * p.x * 210. + t * 4.3);
      vec3 c = texture2D(tex, p).rgb;
      c = mix(c, vec3(0.92, 0.95, 1.0), min(0.45, wk.z * 0.9 * haze));
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
const magFor = (d) => { const sc = scopeOf(); return sc.fov ? sc.mag : Math.max(3, Math.min(25, Math.round(d / 45))); };
const zoomBy = (k) => { if (!scopeOf().fov) magnification = Math.max(3, Math.min(32, magnification + k)); };
// Degrees, vertical: a Soviet scope's own field, else a typical riflescope's.
const scopeFov = () => { const sc = scopeOf(); return sc.fov ? sc.fov : 35 / magnification; };
// The tube shows a circle 0.91 of the screen's height across, so the camera
// sees a little more: the circle then spans the scope's stated field.
const TUBE = 0.455;
const scopeCamFov = () => (scopeOf().tube === false ? scopeFov() : scopeFov() / (2 * TUBE));

// The Soviet drum: the elevation (from the zero) each mark gives, worked
// out by the engine for this load in the tables' normal conditions (15 C,
// 750 mmHg, still air): the drum is engraved once, and the day's air is a hold.
const drumCache = {};
function drumTable() {
  const key = `${S.c}@${zero()}`;
  if (drumCache[key]) return drumCache[key];
  B.bd_station(99992, 288.15, 0.5, 0);
  B.bd_setup(twist(), 0, 0);
  B.bd_powder(0);  // the tables' normal conditions: the published velocity
  B.wind(0, []);
  const el = [0, 0];
  for (const r of B.table(ci(), zero(), sightHeight(), 1300, 100, 0)) if (r.range > 0) el[Math.round(r.range / 100)] = -r.drop / r.range;
  return (drumCache[key] = el);
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
  if (sc.mode === 'hold' && sc.kind === 'acog') { const b = bdcFor(hold.up); return { mark: b.mark, dialUp: 0, holdUp: hold.up, holdRight: hold.right }; }
  if (sc.mode === 'hold') return { dialUp: 0, holdUp: hold.up, holdRight: hold.right };
  return { dialUp: hold.up, holdUp: 0, holdRight: hold.right };
}
// Manual aim: the turrets (clicks; on a Soviet scope the elevation is the
// drum mark) and the crosshair (rad from the target's centre).
const turretUp = () => { const sc = scopeOf(); return sc.mode === 'drum' ? drumTable()[Math.max(1, Math.min(sc.drumMax, S.turret.el))] : S.turret.el * sc.click; };
const turretRight = () => S.turret.wd * scopeOf().click;
function resetAim() {
  S.turret = { el: scopeOf().mode === 'drum' ? Math.max(1, Math.round(zero() / 100)) : 0, wd: 0 };
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
// A value in the scope's unit, to its click: quarter MOA shows two decimals.
const unitDigits = (sc = scopeOf()) => (sc.click / sc.unit < 0.1 - 1e-9 || Math.abs((sc.click / sc.unit) * 10 - Math.round((sc.click / sc.unit) * 10)) > 1e-6 ? 2 : 1);
const fmtU = (rad, sc = scopeOf()) => `${(Math.abs(rad) / sc.unit).toFixed(unitDigits(sc))} ${sc.unitName}`;
function turretText() {
  const sc = scopeOf();
  const el = sc.mode === 'drum' ? `drum ${Math.max(1, Math.min(sc.drumMax, S.turret.el))}` : `${turretUp() >= 0 ? 'up' : 'down'} ${fmtU(turretUp())}`;
  return { el, wd: `${Math.abs(S.turret.wd) < 1 ? 'zero' : fmtU(turretRight()) + (turretRight() > 0 ? ' R' : ' L')}` };
}

function drawReticle(dope) {
  const w = ret.width, h = ret.height, dpr = window.devicePixelRatio || 1;
  rg.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const px = h / (scopeCamFov() * DEG);  // pixels per radian
  const R0 = h * TUBE;  // the same circle as the tube in the final pass
  const sc = scopeOf(), sh = sightHold();
  // The target's centre on the screen (the crosshair is on the screen's centre).
  const tx = cx - sh.right * px, ty = cy + sh.up * px;
  rg.save();
  rg.beginPath();
  if (sc.tube === false) rg.rect(0, 0, w, h); else rg.arc(cx, cy, R0, 0, Math.PI * 2);
  rg.clip();
  rg.strokeStyle = 'rgba(8,8,8,0.92)';
  rg.fillStyle = 'rgba(8,8,8,0.92)';
  if (sc.kind === 'mil') milReticle(cx, cy, R0, px * 1e-3, dpr, 10, 0.5, 5, 2);
  else if (sc.kind === 'moa') milReticle(cx, cy, R0, px * MOA, dpr, 40, 1, 10, 10);
  else if (sc.kind === 'acog') acogReticle(cx, cy, R0, px, dpr);
  else if (sc.kind === 'pu') puReticle(cx, cy, R0, px * THOU, dpr);
  else if (sc.kind === 'iron') ironSights(cx, cy, h, px, dpr);
  else if (sc.kind === 'dot') redDot(cx, cy, px, dpr);
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
  const head = sc.tube === false ? sc.name : `${sc.name} ${sc.fov ? sc.mag : magnification}×`;
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
    } else if (sc.mode === 'hold' && sc.kind !== 'acog') {
      // Held on the target: how far above or below its centre, in its own size.
      const cm = (r) => fmtLen(Math.abs(r) * S.dist);
      const v = Math.abs(p.holdUp) < 0.05 * sc.unit ? 'on the centre' : `${cm(p.holdUp)} ${p.holdUp > 0 ? 'high' : 'low'} (${fmtU(p.holdUp)})`;
      line = `${head}   hold ${v}   wind ${Math.abs(p.holdRight) < 0.05 * sc.unit ? 'centre' : cm(p.holdRight) + side(p.holdRight)}`;
    } else if (sc.mode === 'hold') {
      const b = bdcFor(dope.hold.up);
      line = `${head}   ${b.mark === 1 ? 'chevron tip' : b.mark * 100 + ' m bar'}, ${rest(b.rest)}   wind ${wd}`;
    } else line = `${head}   dialled ${dope.hold.up >= 0 ? 'up' : 'down'} ${fmtU(dope.hold.up)}   hold ${wd}`;
  }
  if (line) rg.fillText(line, cx, cy + R0 + 20 * dpr);
  rg.textAlign = 'start';
}
// Iron sights, as the eye sees them with the front sight in focus: the rear
// notch (blurred) and the front post, its top level with the notch's and
// on the aim point (a centre hold: the post's top on the target's centre).
// A pistol's 0.14 in post at arm's length (about 30 in) covers about 0.26
// deg, its notch 0.4 deg and its rear blade about 2.2 by 0.6 deg; a carbine's
// hooded post at half a metre is much the same (estimated; sights vary).
function ironSights(cx, cy, h, px, dpr) {
  const post = 0.26 * DEG * px, notch = 0.4 * DEG * px, rearW = 2.2 * DEG * px, rearH = 0.6 * DEG * px;
  rg.save();
  rg.filter = `blur(${(1.5 * dpr).toFixed(1)}px)`;
  rg.fillStyle = 'rgba(14,14,16,0.88)';
  // The rear sight: a blade with a square notch, its top at the aim line,
  // and the slide below it.
  rg.fillRect(cx - rearW / 2, cy, rearW / 2 - notch / 2, rearH);
  rg.fillRect(cx + notch / 2, cy, rearW / 2 - notch / 2, rearH);
  rg.fillRect(cx - rearW / 2, cy + rearH, rearW, h);
  rg.restore();
  // The front post, sharp, rising to the aim point; a white dot near its top.
  rg.fillStyle = 'rgba(10,10,12,0.96)';
  rg.fillRect(cx - post / 2, cy, post, rearH * 1.6);
  rg.fillStyle = 'rgba(235,240,230,0.9)';
  rg.beginPath();
  rg.arc(cx, cy + post * 0.7, post * 0.25, 0, Math.PI * 2);
  rg.fill();
  rg.fillStyle = 'rgba(8,8,8,0.92)';
}
// A red dot: 2 MOA, lit, with a soft glow; the window's edge is not drawn.
function redDot(cx, cy, px, dpr) {
  const r = Math.max(1.5 * dpr, MOA * px);
  const g = rg.createRadialGradient(cx, cy, 0, cx, cy, r * 3);
  g.addColorStop(0, 'rgba(255,60,40,1)'); g.addColorStop(0.33, 'rgba(255,40,30,0.95)'); g.addColorStop(1, 'rgba(255,30,20,0)');
  rg.fillStyle = g;
  rg.beginPath();
  rg.arc(cx, cy, r * 3, 0, Math.PI * 2);
  rg.fill();
  rg.fillStyle = 'rgba(8,8,8,0.92)';
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
let te = 0;          // engine time since the latest shot (s)
let scale = 1;       // manual playback speed
let auto = true;     // bullet time
let phase = 'idle';  // idle | flight | after
let afterWall = 0;
function autoScale(sh) {
  const tof = (sh.tStop - sh.t0);
  const cruise = Math.min(1, Math.max(0.01, tof / 7));
  // Downrange from whoever fired it (an opponent's round comes from the far end).
  const along = (p) => (sh.remote ? sh.S.dist - lof(p).d : lof(p).d);
  const st = stateOf(sh, Math.min(tNow, sh.tStop));
  const d = along(st.position);
  const rem = Math.max(0, (sh.hit ? sh.S.dist : along(B.stateAt(sh.tStop).position)) - d);
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
const clockName = (c) => `${Math.abs(c - Math.round(c)) < 0.05 ? Math.round(c) : c.toFixed(1)} o'clock`;

function presetsUI() {
  const box = $('presets'), shortBox = $('presetsShort');
  box.innerHTML = shortBox.innerHTML = '';
  for (const p of SCENARIOS) {
    const b = document.createElement('button');
    if (p.feature) b.className = 'feature';
    b.innerHTML = `${p.name}<small>${p.sub}</small>`;
    b.onclick = () => { Object.assign(S, { tgt: 'plate', glazing: 'windscreen' }, structuredClone(p.s)); S.zero = p.s.zero ?? defaultZero(p.s.c); S.t0 = 10; resetAim(); syncUI(); changed(true); refresh(); tNow = S.t0; fireNow(); };
    (p.short ? shortBox : box).appendChild(b);
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
  $('zero').value = String(zero());
  $('dist').value = S.dist; $('size').value = S.size; $('temp').value = S.temp; $('alt').value = S.alt; $('rh').value = S.rh;
  $('lat').value = S.lat; $('az').value = S.az;
  $('sameWind').checked = S.same; $('callTrue').checked = S.callTrue; $('callBox').hidden = S.callTrue;
  $('callSpd').value = S.call.spd; $('callDir').value = S.call.clock;
  $('fSpin').checked = S.spin; $('fEarth').checked = S.earth; $('fSolver').checked = S.solver; $('fUnique').checked = S.unique;
  $('bUnits').textContent = metric ? 'Metric' : 'Imperial';
  layersUI();
  labels();
}
function labels() {
  const r = raw.rifles.find((x) => x.id === RIFLE_FOR[S.c]);
  const c = cat.cartridges[ci()];
  const sights = scopeOf().tube === false ? (scopeKey() === 'dot' ? 'red dot' : 'sights') : 'scope';
  $('loadDesc').textContent = `${fmtV(c.muzzleVelocity)} from ${r ? r.name : 'its rifle'} (${r ? r.barrel_in : '?'} in barrel), 1:${r ? r.twist_in : '?'} in ${r && r.twist_direction === 'left' ? 'left' : 'right'}-hand twist, ${sights} ${fmtLen(sightHeight())} over the bore.`;
  $('zeroNote').textContent = `${gunClass() === 'rifle' ? 'The rifle' : 'The gun'} is zeroed at ${zero()} m. ${scopeOf().mode === 'dial' ? 'The elevation from your dope is dialled; the wind is held on the reticle.' : scopeOf().tube === false ? 'Everything is held: put the sight where the dope says, above or beside the target.' : 'Set the marks your dope gives and hold the rest.'}`;
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
  $('callTrue').nextSibling.textContent = duel ? ' Call the average true wind exactly (not in a duel)' : ` Call the average true wind exactly (${fmtSpeedW(cw.spd)} from ${clockName(cw.clock)})`;
}

let dope = null, dopeTimer = 0;
function changed(rebuild = false) {
  labels();
  clearTimeout(dopeTimer);
  dopeTimer = setTimeout(refresh, rebuild ? 0 : 90);
  if (rebuild) { retireAll(); shot = null; path.visible = false; impacts = []; missMarks = []; buildRange(); buildBullet(); placeRifle(); magnification = magFor(S.dist); }
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
  }
}
function dopeUI() {
  turretUI();
  const sp = dope?.spread, el = $('spreadInfo');
  if (!sp || !(sp.vertical > 0)) el.textContent = S.unique ? '' : 'Every round the same: switch on "Every round unique" for their spread.';
  else {
    const what = S.tgt === 'plate' ? `hit chance on this plate ${Math.round(100 * chanceBox(S.size, S.size, sp.horizontal, sp.vertical))} %`
      : S.tgt === 'duel' ? `a head at this range ${Math.round(100 * chanceCircle(FIGURE.head.r, sp.horizontal, sp.vertical))} % of the time` : '';
    el.textContent = `Rounds scatter ${fmtLen(sp.vertical)} up and down, ${fmtLen(sp.horizontal)} across (1 SD) at the target${what ? ': ' + what : ''}, if the wind call is right.`;
  }
  const t = $('dope');
  const sc = scopeOf(), u = sc.unit;
  const plain = sc.mode === 'hold' && sc.kind !== 'acog';
  const what = plain ? `${sc.name}: holds in ${sc.unitName}, zeroed at ${zero()} m` : { dial: `${sc.unitName}, dialled`, drum: `${sc.name} drum, holds in ${sc.unitName}`, hold: `${sc.name} marks, holds in ${sc.unitName}` }[sc.mode];
  $('dopeWhat').textContent = `${what} · call ${fmtSpeedW(call().spd)} from ${clockName(call().clock)}`;
  const second = plain ? 'Hold' : { dial: 'Elev', drum: 'Drum', hold: 'Mark' }[sc.mode];
  const arrow = (r) => (Math.abs(r) < 0.05 ? '·' : Math.abs(r).toFixed(1) + (r > 0 ? '↑' : '↓'));
  let h = `<tr><th>${metric ? 'm' : 'yd'}</th><th>${second}</th>${sc.mode === 'dial' || plain ? '' : '<th>Hold</th>'}${plain ? `<th>${metric ? 'cm' : 'in'}</th>` : ''}<th>Wind</th><th>${metric ? 'm/s' : 'ft/s'}</th><th>s</th></tr>`;
  for (const r of dope.rows) {
    if (r.range <= 0) continue;
    const up = -r.drop / r.range, wd = (-r.windage / r.range) / u;
    let cells;
    if (sc.mode === 'drum') { const d = drumFor(up); cells = `<td>${d.drum}</td><td>${arrow(d.rest / u)}</td>`; }
    else if (plain) cells = `<td>${arrow(up / u)}</td><td>${arrow((up * r.range) / (metric ? 0.01 : IN))}</td>`;
    else if (sc.mode === 'hold') { const b = bdcFor(up); cells = `<td>${b.mark === 1 ? 'tip' : b.mark}</td><td>${arrow(b.rest / u)}</td>`; }
    else cells = `<td>${((Math.round(up / sc.click) * sc.click) / u).toFixed(unitDigits(sc))}</td>`;  // to the click you would dial
    h += `<tr class="${Math.abs(r.range - S.dist) < 1 ? 'at' : ''}"><td>${(metric ? r.range : r.range / YD).toFixed(r.range < 50 && !Number.isInteger(metric ? r.range : r.range / YD) ? 1 : 0)}</td>${cells}<td>${Math.abs(wd).toFixed(1)}${wd > 0.05 ? 'R' : wd < -0.05 ? 'L' : ''}</td><td>${(metric ? r.speed : r.speed / FT).toFixed(0)}</td><td>${r.time.toFixed(2)}</td></tr>`;
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
  } else if (S.tgt === 'duel' && sh.impact) {
    o.className = sh.hit ? 'ok' : 'bad';
    o.textContent = sh.hit ? `Hit: your friend's ${sh.part} (${sh.part === 'head' ? 2 : 1} ${sh.part === 'head' ? 'points' : 'point'}).`
      : `Miss: ${fmtLen(Math.abs(sh.impact.right))} ${sh.impact.right >= 0 ? 'right' : 'left'}, ${fmtLen(Math.abs(sh.impact.up))} ${sh.impact.up >= 0 ? 'high' : 'low'} of the head.`;
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
    // Mach from the speed through the air (the wind counts), energy from the ground speed.
    const u = Math.hypot(at.velocity[0] - a.wind[0], at.velocity[1] - a.wind[1], at.velocity[2] - a.wind[2]);
    kv.push(['Speed at the target', `${fmtV(v)} · Mach ${(u / a.speedOfSound).toFixed(2)}`]);
    kv.push(['Energy', metric ? `${(0.5 * m * v * v).toFixed(0)} J` : `${(0.5 * m * v * v / 1.3558).toFixed(0)} ft·lbf`]);
    kv.push(['Spin at the target', `${(at.spin / (2 * Math.PI)).toFixed(0)} turns/s`]);
    const lag = (sh.tTarget - sh.t0) - S.dist / a.speedOfSound;
    kv.push(['The report reaches the target', `${Math.abs(lag).toFixed(2)} s ${lag > 0 ? 'before' : 'after'} the round`]);
  }
  if (sh.glass && sh.glass.onGlass) kv.push(['Glass Dynamics', `${sh.glass.outcome} · struck at ${(90 - Math.abs(sh.glass.pitch) / DEG).toFixed(0)}° to the glass`]);
  kv.push(['Muzzle', `${fmtV(sh.muzzleSpeed)} · Mach ${(sh.muzzleSpeed / sh.air.speedOfSound).toFixed(2)}`]);
  if (sh.draw && sh.seed) {
    const d = sh.draw, dv = d.velocityOffset, sc = scopeOf();
    const dvs = metric ? `${Math.abs(dv).toFixed(1)} m/s` : `${(Math.abs(dv) / FT).toFixed(0)} ft/s`;
    kv.push(['This round', `${dv >= 0 ? '+' : '−'}${dvs} · BC ${d.bcFactor >= 1 ? '+' : '−'}${(Math.abs(d.bcFactor - 1) * 100).toFixed(1)} % · barrel ${fmtU(d.up, sc)} ${d.up >= 0 ? 'up' : 'down'}, ${fmtU(d.right, sc)} ${d.right >= 0 ? 'R' : 'L'}`]);
  }
  if (groupLog.length >= 2) {
    let es = 0;
    for (let i = 0; i < groupLog.length; ++i) for (let j = i + 1; j < groupLog.length; ++j) es = Math.max(es, Math.hypot(groupLog[i].right - groupLog[j].right, groupLog[i].up - groupLog[j].up));
    kv.push([`Group, last ${groupLog.length}`, `${fmtLen(es)} · ${(es / S.dist / MOA).toFixed(2)} MOA`]);
  }
  // Muzzle to target (not the flight on past it).
  const tUntil = (sh.tTarget ?? sh.tStop) - sh.t0;
  if (S.spin) {
    const unstable = sh.sg < 1 || (sh.sgTarget > 0 && sh.sgTarget < 1);
    kv.push(['Stability Sg', `${sh.sg.toFixed(2)}${sh.sgTarget > 0 ? ' → ' + sh.sgTarget.toFixed(2) : ''}${unstable ? ' · TUMBLED' : ''}`]);
  }
  if (sh.muzzleSpeed < sh.air.speedOfSound) kv.push(['Subsonic', 'from the muzzle (no sonic crack)']);
  else if (sh.round.subsonicTime > 0 && sh.round.subsonicTime <= tUntil) {
    const st = stateOf(sh, sh.t0 + sh.round.subsonicTime);
    kv.push(['Went subsonic at', fmtDist(lof(st.position).d)]);
  }
  {
    const sc = scopeOf(), a = sh.aim, side = (r) => (r >= 0 ? 'R' : 'L');
    kv.push(['Aimed', sh.S.aim === 'manual' ? `by hand: ${fmtU(a.up)} ${a.up >= 0 ? 'up' : 'down'} · ${fmtU(a.right)} ${side(a.right)}`
      : `${fmtU(a.up)} ${a.up >= 0 ? 'up' : 'down'} · ${fmtU(a.right)} ${side(a.right)} (${sc.name})`]);
  }
  // A real scope runs out of elevation long before 2 miles: say so when the dope asks for more.
  if (sh.S.aim !== 'manual' && scopeOf().mode === 'dial' && Math.abs(sh.aim.up) > 0.03)
    kv.push(['Turret', `${fmtU(sh.aim.up)}: past most scopes' ~30 mil of travel (a canted base and holdover)`]);
  kv.push(['Air', `${fmtT(S.temp)} · ${(isaPressure(S.alt) / 100).toFixed(0)} hPa · DA ${fmtAlt(sh.air.densityAltitude)}${S.unique ? ' · powder at the air' : ''}`]);
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
  const T = sh.S;  // the range as it was for this round
  const isHit = sh.hit;
  if (isHit) {
    const m = $('hitmark');
    m.classList.remove('on', 'kill');
    void m.offsetWidth;
    m.classList.add('on');
    // Red when it reached the dummy (through the V8's glass, or the dummy target).
    if (T.tgt === 'dummy' || (T.tgt === 'v8' && sh.glass && sh.glass.penetrated)) m.classList.add('kill');
    tick();
  }
  if (isHit || S.markers === 'all') {
    impacts.push({ right: sh.impact.right, up: sh.impact.up, hit: isHit });
    if (impacts.length > 6) impacts.shift();
    if (!isHit && T.tgt === 'plate') {
      const x = label('×', Math.max(0.15, T.size * 0.3), '#ff3b2f', 'rgba(0,0,0,0)');
      x.position.set(sh.impact.right, sightHeight() + sh.impact.up, -T.dist + 0.05);
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

// The quickest a rifle shoots again (s of engine time): a bolt has to be
// worked, a semi-automatic is ready as fast as the trigger. Estimated. A shot
// asked for sooner waits its turn: in bullet time the rounds still leave the
// muzzle at the rifle's true cadence.
// The automatics fire at their cyclic rate (published: MP5 about 800 rounds a
// minute, P90 about 900, Thompson M1A1 about 700); a revolver's double-action
// pull is slower than a pistol's trigger (estimated).
const RIFLE_CYCLE = { m24_sws: 1.2, bolt_65cm: 1.2, bolt_338lm: 1.4, m200_408: 1.6, m9130_pu: 1.3, m107_50bmg: 0.25, svd_pso1: 0.2, m16a2: 0.12, pistol_9mm: 0.12,
  glock_17: 0.12, colt_1911: 0.15, sw_686: 0.3, fn_fiveseven: 0.12, mp5a3: 60 / 800, fn_p90: 60 / 900, thompson_m1a1: 60 / 700 };
// A round arrives: the plate rings and swings, the glass breaks, the dust flies.
function logGroup(sh) {
  if (sh.remote || !sh.impact) return;
  const key = `${sh.S.c}|${sh.S.dist}|${zero()}|${sh.S.aim}`;
  if (groupLog.key !== key) { groupLog = []; groupLog.key = key; }
  groupLog.push({ right: sh.impact.right, up: sh.impact.up });
  if (groupLog.length > 5) groupLog.shift();
  if (sh === shot) resultsUI();
}
function arrive(sh) {
  logGroup(sh);
  if (duel && duelArrive(sh)) return;
  const T = sh.S;
  hitFeedback(sh);
  if (T.tgt === 'v8' && sh.glass && sh.glass.onGlass) {
    drawV8Cracks(sh.glass);
    noiseBurst(0.35, 3000, 0.4);
    banner(sh.glass.penetrated ? 'Through the glass' : 'Stopped', sh.glass.penetrated ? `${sh.glass.vin.toFixed(0)} → ${sh.glass.vout.toFixed(0)} m/s: watch it in the Liquids Lab` : 'the armoured windscreen held');
  } else if (sh.hit && T.tgt === 'dummy') {
    banner('Hit', `the dummy's ${dummyPart(sh.impact)} at ${fmtDist(T.dist)}: watch it in the Liquids Lab`);
  } else if (sh.hit) {
    ping();
    plate.userData.swing = Math.min(0.9, 0.2 + (sh.atTarget ? Math.hypot(...sh.atTarget.velocity) / 2000 : 0.3));
    plate.userData.phase = 0;
    const mark = new THREE.Mesh(new THREE.CircleGeometry(Math.max(0.012, T.size * 0.02), 16), new THREE.MeshBasicMaterial({ color: 0xd9d4c8 }));
    mark.position.set(sh.impact.right, sh.impact.up, 0.012);
    plate.children[0].add(mark);
    hitMarks.push(mark);
    if (hitMarks.length > 12) plate.children[0].remove(hitMarks.shift());
    banner('Hit', `${fmtLen(Math.hypot(sh.impact.right, sh.impact.up))} from centre at ${fmtDist(T.dist)}`);
  } else {
    const p = v3(stateOf(sh, sh.tStop).position);
    dust.position.copy(p);
    dust.scale.setScalar(0.3);
    dust.material.opacity = 0.85;
    noiseBurst(0.25, 600, 0.25);
    banner('Miss', sh.impact ? `${fmtLen(Math.abs(sh.impact.right))} ${sh.impact.right >= 0 ? 'right' : 'left'}, ${fmtLen(Math.abs(sh.impact.up))} ${sh.impact.up >= 0 ? 'high' : 'low'}` : 'short of the target');
  }
}

function fireNow() {
  if (S.tgt === 'v8' && !G) { toast('Loading the glass engine for the windscreen…'); $('outcome').className = ''; $('outcome').textContent = 'Loading the glass engine…'; $('watch').hidden = true; ensureGlass().then(() => fireNow()).catch((e) => toast('Glass engine: ' + e.message)); return; }
  if (duel && !duelMayFire()) return;
  const cycle = RIFLE_CYCLE[RIFLE_FOR[S.c]] ?? 0.9;
  const prev = shots.filter((x) => !x.remote).at(-1), t0 = Math.max(tNow, prev ? prev.t0 + cycle : tNow);
  const queue = AUTOMATIC.has(RIFLE_FOR[S.c]) ? 30 : 8;
  if (t0 - tNow > queue * cycle) { if (queue === 8) toast('Eight rounds are already waiting to go'); return; }
  if (dopeTimer) refresh();  // settings still pending: apply them first
  if (!fire(t0)) return;
  if (duel) duelSent(shot);
  if (t0 > tNow + 1e-6 && !AUTOMATIC.has(RIFLE_FOR[S.c])) toast(cycle > 0.5 ? 'Working the bolt…' : 'Next round');
  if (auto && !duel) setCam('bullet');
  resultsUI();
  // The dashed path of the whole flight, for the scope and shooter views.
  const pts = [];
  B.bd_select(shot.id);
  for (let t = shot.t0; t <= shot.tStop; t += Math.max(0.002, (shot.tStop - shot.t0) / 400)) pts.push(v3(B.stateAt(t).position));
  pts.push(v3(B.stateAt(shot.tStop).position));
  pathGeo.setFromPoints(pts);
  path.computeLineDistances();
  path.visible = false;
}

$('cartridge').onchange = (e) => { S.c = e.target.value; S.zero = defaultZero(S.c); resetAim(); syncUI(); changed(true); };
{
  const z = $('zero');
  for (const m of ZEROS) { const o = document.createElement('option'); o.value = String(m); o.textContent = `${m} m`; z.appendChild(o); }
  z.onchange = (e) => { S.zero = +e.target.value; resetAim(); syncUI(); changed(true); };
}
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
  const sc = scopeOf(), drum = sc.mode === 'drum', hold = sc.mode === 'hold';
  // Sights with nothing to dial for range (irons, a red dot, the ACOG's
  // marks): everything is held, so the turrets are not offered.
  $('turrets').hidden = hold;
  $('holdOnly').hidden = !hold;
  if (hold) return;
  const t = turretText();
  const elIn = $('tElIn'), wdIn = $('tWdIn');
  elIn.step = drum ? 1 : String(sc.click / sc.unit);
  wdIn.step = String(sc.click / sc.unit);
  if (document.activeElement !== elIn) elIn.value = drum ? String(Math.max(1, Math.min(sc.drumMax, S.turret.el))) : ((S.turret.el * sc.click) / sc.unit).toFixed(unitDigits(sc));
  if (document.activeElement !== wdIn) wdIn.value = ((S.turret.wd * sc.click) / sc.unit).toFixed(unitDigits(sc));
  $('tElUnit').textContent = drum ? 'drum (×100 m)' : `${sc.unitName} ${turretUp() >= 0 ? 'up' : 'down'}`;
  $('tWdUnit').textContent = `${sc.unitName} ${turretRight() >= 0 ? 'R' : 'L'}`;
  // Clicks, the turn of the turret, and how far the card is from the dial.
  const turns = (clicks) => { if (!sc.rev) return ''; const per = Math.round(sc.rev / sc.click), n = Math.floor(Math.abs(clicks) / per); return n ? ` · turn ${n + 1}` : ''; };
  const need = dope && !drum ? { el: Math.round(dope.hold.up / sc.click), wd: Math.round(dope.hold.right / sc.click) } : null;
  const diff = (have, want, up, down) => (want === have ? '<b class="ok">on the card</b>' : `${Math.abs(want - have)} clicks ${want > have ? up : down} to the card`);
  $('tElSub').innerHTML = drum ? `${t.el}${dope ? ` · the card says drum ${plan(dope.hold).drum}` : ''}`
    : `${Math.abs(S.turret.el)} clicks${turns(S.turret.el)}${need ? ' · ' + diff(S.turret.el, need.el, 'up', 'down') : ''}${Math.abs(turretUp()) > (sc.travel ?? Infinity) ? ' · <b class="warn">past this scope\'s travel: hold the rest</b>' : ''}`;
  $('tWdSub').innerHTML = `${Math.abs(S.turret.wd)} clicks${need ? ' · ' + diff(S.turret.wd, need.wd, 'R', 'L') : ''}${Math.abs(turretRight()) > (sc.wTravel ?? Infinity) ? ' · <b class="warn">past this scope\'s travel</b>' : ''}`;
}
const click = () => noiseBurst(0.012, 5200, 0.1, 4);  // a turret detent
function turn(which, k, sound = true) {
  const sc = scopeOf();
  if (which === 'el') S.turret.el = sc.mode === 'drum' ? Math.max(1, Math.min(sc.drumMax, S.turret.el + k)) : S.turret.el + k;
  else S.turret.wd += k;
  turretUI();
  if (sound) click();
}
function nudge(up, right) {
  const u = scopeOf().unit;
  S.hold.up += up * u;
  S.hold.right += right * u;
}
$('scope').onchange = (e) => { S.scope = e.target.value; store.set('scope', S.scope); resetAim(); syncUI(); changed(true); };
$('aim').onchange = (e) => { S.aim = e.target.value; store.set('aim', S.aim); resetAim(); syncUI(); };
$('hint').onchange = (e) => { S.hint = e.target.checked; store.set('hint', S.hint); };
// Hold a turret button to keep turning it: a click, then after 0.35 s ten
// clicks a second, then after 1.2 s a hundred (a fast spin, a mil-scope turn
// a second); Shift-click turns ten clicks at once.
function holdToTurn(btn, which, dir) {
  let timer = 0, started = 0;
  const stop = () => { clearTimeout(timer); timer = 0; };
  const step = () => {
    const held = performance.now() - started;
    turn(which, dir * (held > 1200 ? 10 : 1), true);
    timer = setTimeout(step, 100);
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    started = performance.now();
    turn(which, dir * (e.shiftKey ? 10 : 1));
    stop();
    timer = setTimeout(step, 350);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) btn.addEventListener(ev, stop);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); turn(which, dir * (e.shiftKey ? 10 : 1)); } });
}
holdToTurn($('tElUp'), 'el', 1);
holdToTurn($('tElDn'), 'el', -1);
holdToTurn($('tWdR'), 'wd', 1);
holdToTurn($('tWdL'), 'wd', -1);
// Or type the value: it goes to the nearest click (or drum mark).
$('tElIn').onchange = (e) => {
  const sc = scopeOf(), v = parseFloat(e.target.value);
  if (Number.isFinite(v)) S.turret.el = sc.mode === 'drum' ? Math.max(1, Math.min(sc.drumMax, Math.round(v))) : Math.round((v * sc.unit) / sc.click);
  e.target.blur(); turretUI(); click();  // shown back at the click it went to
};
$('tWdIn').onchange = (e) => {
  const sc = scopeOf(), v = parseFloat(e.target.value);
  if (Number.isFinite(v)) S.turret.wd = Math.round((v * sc.unit) / sc.click);
  e.target.blur(); turretUI(); click();
};
$('bDial').onclick = () => {
  const sc = scopeOf(), p = plan(dope.hold);
  S.turret.el = sc.mode === 'drum' ? p.drum : sc.mode === 'hold' ? 0 : Math.round(dope.hold.up / sc.click);
  turretUI(); click();
};
// The wind on the turret too (many shooters dial it on a steady wind and
// keep the reticle for the gusts).
$('bDialWd').onclick = () => {
  const sc = scopeOf();
  S.turret.wd = Math.round(dope.hold.right / sc.click);
  S.hold.right = 0;
  turretUI(); click();
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
$('fUnique').onchange = (e) => { S.unique = e.target.checked; store.set('unique', S.unique); changed(); };
$('fire').onclick = () => fireNow();
$('bReplay').onclick = () => { if (duel) { killcam(); return; } if (!shot) return; retireAll(shot); tNow = shot.t0; shot.done = false; shot.left = false; plate.rotation.x = 0; if (auto) setCam('bullet'); };
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
    f: (X.spin ? 's' : '') + (X.earth ? 'e' : '') + (X.solver ? 'k' : '') + (X.unique ? 'u' : ''), zr: X.zero ?? defaultZero(X.c), ts: sh ? sh.t0 : X.t0, fire: 1 });
  if (sh?.seed) { q.set('sd', String(sh.seed.seed)); q.set('sk', String(sh.seed.stream)); }
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
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat || AUTOMATIC.has(RIFLE_FOR[S.c])) fireNow(); }
  else if (e.key === 'c' || e.key === 'C') setCam(CAMS[(CAMS.findIndex((x) => x[0] === cam) + 1) % CAMS.length][0]);
  else if (e.key === 'b' || e.key === 'B') $('bAuto').click();
  else if (e.key === 'z' || e.key === 'Z') $('bReplay').click();
  else if (e.key === 'm' || e.key === 'M') $('bSound').click();
  else if (e.key === 't' || e.key === 'T') $('bTrace').click();
  else if (e.key === 'u' || e.key === 'U') $('bUnits').click();
  else if (e.key === 'h' || e.key === 'H') $('help').classList.toggle('on');
  else if (duel && (e.key === 'k' || e.key === 'K')) killcam();
  else if (duel && (e.key === 'v' || e.key === 'V')) setMic(!duel.micOn);
  else if (S.aim === 'manual' && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const k = e.shiftKey ? 0.5 : 0.1;
    nudge(e.key === 'ArrowUp' ? k : e.key === 'ArrowDown' ? -k : 0, e.key === 'ArrowRight' ? k : e.key === 'ArrowLeft' ? -k : 0);
  }
  else if (S.aim === 'manual' && scopeOf().mode !== 'hold' && 'rRfFeEqQ'.includes(e.key)) {
    const k = e.shiftKey ? 10 : 1, key = e.key.toLowerCase();
    turn(key === 'r' || key === 'f' ? 'el' : 'wd', key === 'r' || key === 'e' ? k : -k);
  }
  else if (e.key === '+' || e.key === '=') zoomBy(1);
  else if (e.key === '-') zoomBy(-1);
});
// Drag to look around (shooter and target cameras); wheel zooms the scope.
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ...orbit, hold: { ...S.hold } }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (cam === 'scope' && S.aim === 'manual') {
    const k = (scopeCamFov() * DEG) / canvas.clientHeight / 3;  // a third of the screen's motion: a steady hand
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
let mirageAngle = 0;  // rad RMS, set each frame
function frame(now) {
  requestAnimationFrame(frame);
  const wallDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const wall = now / 1000;
  nowWall = wall;
  // The range's clock. Bullet time follows the latest round still flying.
  let s = 1;
  const replay = duel?.replay;
  const lead = replay ? (tNow < replay.tStop ? replay : null) : [...shots].reverse().find((x) => !x.remote && tNow < x.tStop && tNow >= x.t0);
  if (duel && duel.live && !replay) tNow = duelNow();  // a duel runs on the shared clock, at 1x
  else {
    if (lead) s = auto ? autoScale(lead) : scale;
    if (replay) s = Math.max(s, 0.03);  // a killcam: bullet time, but done in seconds
    tNow += wallDt * s;
  }
  if (replay && tNow >= replay.tStop + 0.8) endKillcam();
  // Rounds leaving the muzzle: the flash and the report (the opponent's
  // flash is seen at once; its report arrives at the speed of sound).
  for (const sh of shots) if (!sh.left && tNow >= sh.t0) {
    sh.left = true;
    if (sh.remote) { oppFlash.material.opacity = 1; continue; }
    flash.material.opacity = 1; dust.material.opacity = 0; noiseBurst(0.5, 2200, 0.5);
  }
  for (const sh of shots) if (sh.remote && !sh.heard && tNow >= sh.t0 + sh.reportDelay) { sh.heard = true; if (!replay) noiseBurst(0.6, 900 + 1300 * Math.exp(-S.dist / 800), 0.35); }
  // Rounds arriving: what each does at the end of its flight.
  for (const sh of shots) if (!sh.done && tNow >= sh.tStop && tNow >= sh.t0) { sh.done = true; sh.doneWall = wall; arrive(sh); }
  // Rounds long since landed go (the latest stays, for replay and the results).
  for (const sh of [...shots]) if (sh !== shot && sh !== duel?.last && sh !== replay && sh.done && wall - sh.doneWall > 4) retire(sh);
  // The round the cameras and the HUD follow: the latest of mine to have
  // left the muzzle (in a killcam, the round replayed).
  const fs = replay ?? [...shots].reverse().find((x) => !x.remote && tNow >= x.t0) ?? shot;
  phase = !fs ? 'idle' : tNow < fs.tStop ? 'flight' : 'after';
  te = fs ? Math.max(0, Math.min(tNow, fs.tStop) - fs.t0) : 0;
  afterWall = fs && fs.done ? wall - fs.doneWall : 0;
  if (phase === 'after' && auto && afterWall > 1.2 && cam === 'bullet' && !lead) setCam('target');
  const tEngine = tNow;
  updateFlags(tNow, wall);
  mirage.uniforms.t.value = wall;
  // Mirage: stronger in heat and still air, leaning with the crosswind at the target.
  {
    const pTarget = enu(S.dist * 0.7, 0, -BENCH + 0.5);
    const w = lof(B.air(pTarget[0], pTarget[1], pTarget[2], tEngine).wind);
    // The image dances by an angle, not a share of the screen: about 30
    // microradians RMS over a kilometre of sunny ground (the angle-of-arrival
    // spread 2.91 Cn^2 L D^(-1/3) for Cn^2 near 1e-13 and a 5 cm objective),
    // growing as the square root of the path. Heat stands in for the sun on
    // the ground (estimated); a crosswind of 4 m/s or more washes it out.
    const heat = Math.max(0.15, Math.min(1.4, (S.temp + 5) / 30));
    mirageAngle = (2.4e-5 * (0.32 + heat)) / (1 + Math.abs(w.r) / 4) * Math.sqrt(Math.min(S.dist, 3000) / 1000);
    mirage.uniforms.drift.value = Math.max(-1.5, Math.min(1.5, w.r / 3));
  }
  // The rounds.
  for (const sh of shots) {
    if (tNow < sh.t0) { sh.mesh.visible = false; continue; }
    const tt = Math.min(tNow, sh.tStop), x = stateOf(sh, tt);
    sh.mesh.position.copy(v3(x.position));
    sh.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v3(B.noseAt(tt)).normalize());
    sh.body.rotation.z = -x.roll;  // the engraving turns with the spin
    sh.mesh.visible = !(sh.done && sh.hit);
  }
  // The latest: the shock cone and the HUD.
  let st = null;
  if (fs && phase !== 'idle' && tNow >= fs.t0) {
    st = stateOf(fs, fs.t0 + te);
    const p = v3(st.position);
    const nose = v3(B.noseAt(fs.t0 + te)).normalize();
    const a = B.air(st.position[0], st.position[1], st.position[2], tEngine);
    const u = Math.hypot(st.velocity[0] - a.wind[0], st.velocity[1] - a.wind[1], st.velocity[2] - a.wind[2]);
    const M = u / a.speedOfSound;
    shock.visible = M > 1.01 && phase === 'flight' && cam === 'bullet';
    if (shock.visible) {
      // Close to Mach 1 the shock stands off the nose as a bow wave and its
      // cone flattens: the half-angle is held to 75 deg there.
      const L = 0.35, half = Math.min(75 * DEG, Math.asin(1 / M)), rim = L * Math.tan(half);
      const air = v3([st.velocity[0] - a.wind[0], st.velocity[1] - a.wind[1], st.velocity[2] - a.wind[2]]).normalize();
      shock.scale.set(rim, L, rim);
      shock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), air);  // the apex (+y) leads
      shock.position.copy(p).addScaledVector(nose, fs.len * 0.5).addScaledVector(air, -L / 2);
      const pr = projRaw(fs.S.c), d = pr.diameter_in * IN, l = pr.length_in * IN, r = Math.max(rim, 2 * d);
      const jump = (0.53 * Math.pow(M * M - 1, 1 / 8) * d) / (Math.pow(r, 0.75) * Math.pow(l, 0.25)) / 1.4;
      // The turn at grazing incidence: the index jump over the shell's own
      // thickness, seen along a chord of the cone about 30 times as long (estimated).
      shock.material.uniforms.strength.value = SCHLIEREN * 2.9e-4 * (a.density / 1.225) * jump * 30;
    }
    const inAir = shots.filter((x) => tNow >= x.t0 && tNow < x.tStop).length;
    const hud = `${fmtDist(lof(st.position).d)}<span>·</span>${fmtV(Math.hypot(...st.velocity))}<span>·</span>Mach ${M.toFixed(2)}<span>·</span>${(st.spin / (2 * Math.PI)).toFixed(0)} turns/s${inAir > 1 ? `<span>·</span>${inAir} rounds in the air` : ''}`;
    $('hud').innerHTML = phase === 'flight' ? hud : '';
  } else {
    $('hud').innerHTML = '';
    shock.visible = false;
  }
  // Muzzle flash, dust, the plate swinging.
  flash.position.set(0, 0, -0.66);
  flash.material.opacity *= Math.pow(0.02, wallDt * (phase === 'flight' ? Math.max(0.02, s) * 40 : 6));
  oppFlash.material.opacity *= Math.pow(0.02, wallDt * 12);
  if (duel) duelFrame(wall);
  if (dust.material.opacity > 0) { dust.scale.multiplyScalar(1 + wallDt * 1.5); dust.material.opacity *= Math.pow(0.4, wallDt); }
  if (plate.userData.swing) {
    plate.userData.phase = (plate.userData.phase || 0) + wallDt * 5;
    plate.rotation.x = -plate.userData.swing * Math.exp(-plate.userData.phase / 6) * Math.sin(plate.userData.phase);
  }
  // Clock.
  if (fs && phase !== 'idle') {
    const sp = s >= 0.95 ? '1×' : `1/${Math.round(1 / s).toLocaleString()}`;
    $('clock').innerHTML = `${te.toFixed(4)} s<small>${phase === 'flight' ? sp + (auto ? ' · bullet time' : '') : 'impact'}</small>`;
  } else $('clock').innerHTML = `0.000 s<small>ready</small>`;
  // Cameras.
  const D = S.dist;
  if (cam === 'scope') {
    scopeCam.fov = scopeCamFov();
    scopeCam.position.set(0, sightHeight(), 0);
    const ah = sightHold();
    scopeCam.lookAt(ah.right * D, sightHeight() + ah.up * D, -D);
    scopeCam.updateProjectionMatrix();
    // The mirage in this view: its angle over the view's height, its cells at their size in the sky.
    mirage.uniforms.amp.value = mirageAngle / (scopeCam.fov * DEG);
    mirage.uniforms.cell.value = Math.max(0.25, Math.min(4, (scopeCam.fov * DEG) / 0.0244));
    rifle.visible = false;
    // The flash is a sphere 0.66 m out from the muzzle: through open sights'
    // wide view it would hang in front of the eye all through bullet time.
    flash.visible = false;
    mirage.uniforms.scope.value = scopeOf().tube === false ? 0 : 1;
    updateTracer(false, scopeCam.fov);
    present(scopeCam, tEngine);
    drawReticle(dope);
    path.visible = false;
    return;
  }
  mirage.uniforms.scope.value = 0;
  mirage.uniforms.amp.value = 0;
  rifle.visible = true;
  flash.visible = true;
  if (cam === 'bullet' && st) {
    const p = fs.mesh.position;
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
  updateTracer(cam === 'bullet', camera.fov);
  present(camera, tEngine);
}

// Draw the scene through the final pass: the trace bends it, the scope adds
// its tube and the mirage.
const clearTmp = new THREE.Color();
function present(cam, tEngine) {
  R.setRenderTarget(rt);
  R.render(scene, cam);
  let n = 0;
  if (showTrace)
    for (const sh of shots) {
      if (tNow < sh.t0 || n >= MAX_WAKE) continue;
      const p = projRaw(sh.S.c);
      B.bd_select(sh.id);
      // Each stretch stands for `spacing` metres of path (the shader turns
      // that into the length a ray runs inside it), so the trace does not
      // change with how finely it is sampled.
      const spacing = Math.max(0.25, sh.S.dist / 6000);
      const w = B.wake(Math.min(tNow, sh.tStop), spacing, 0.5, p.mass_gr * 6.479891e-5, p.diameter_in * IN);
      const m = w.length / 7;
      for (let k = 0; k < m && n < MAX_WAKE; ++k, ++n) {
        const q = v3([w[7 * k], w[7 * k + 1], w[7 * k + 2]]);
        // The path's direction here, from the neighbouring stretches.
        const i0 = Math.max(0, k - 1), i1 = Math.min(m - 1, k + 1);
        const dv = v3([w[7 * i1] - w[7 * i0], w[7 * i1 + 1] - w[7 * i0 + 1], w[7 * i1 + 2] - w[7 * i0 + 2]]);
        if (dv.lengthSq() > 0) dv.normalize(); else dv.set(0, 0, -1);
        wCenter.setXYZ(n, q.x, q.y, q.z);
        wRadius.setX(n, w[7 * k + 3]);
        wStrength.setX(n, w[7 * k + 6]);
        wDir.setXYZW(n, dv.x, dv.y, dv.z, spacing);
      }
    }
  if (n) wCenter.needsUpdate = wRadius.needsUpdate = wStrength.needsUpdate = wDir.needsUpdate = true;
  wakeGeo.instanceCount = n;
  const any = n > 0 || shock.visible;
  R.getClearColor(clearTmp);
  const ca = R.getClearAlpha();
  R.setRenderTarget(wakeRT);
  R.setClearColor(0x000000, 0);
  R.clear();
  if (any) {
    wakeMat.uniforms.pxScale.value = shock.material.uniforms.pxScale.value = (2 * Math.tan((cam.fov * DEG) / 2)) / (wakeRT.height || 1);
    R.render(wakeScene, cam);
  }
  R.setClearColor(clearTmp, ca);
  mirage.uniforms.wakeGain.value = any ? 1 / (wakeRT.height || 1) : 0;  // the buffer holds pixels
  mirage.uniforms.haze.value = hazeFor(S.rh);
  R.setRenderTarget(null);
  R.render(post, postCam);
}


// ---------- Duel ----------
// Two shooters, one range: you at one end, your friend at the other, each
// shooting at the other's head and shoulders over the sandbags. Every round
// is flown by both browsers from the same inputs (the rifle, the bore's
// elevation and azimuth, the instant it left), so both see the same flight
// and agree on every hit without a server deciding. Conditions come from
// the challenger's link and are locked; the wind is rolled at random and
// hidden from both: read it off the flags and the mirage. Body 1, head 2,
// first to 3. A hit calls a 4 s cease-fire; K replays the last hit in
// bullet time.
const DUEL_TO = 3, CEASE = 4, DUEL_KEYS = ['dist', 'size', 'temp', 'alt', 'rh', 'lat', 'az', 'tgt', 'sameWind', 'callTrue', 'fSpin', 'fEarth', 'glazing'];
const libHash = (() => { let h = 2166136261; for (let i = 0; i < raw.__text.length; ++i) h = Math.imul(h ^ raw.__text.charCodeAt(i), 16777619); return (h >>> 0).toString(16); })();
const engineId = () => B.determinism().join('.');
const duelNow = () => (duel.seat === 'A' ? 10 + performance.now() / 1000 - duel.epoch : performance.now() / 1000 + duel.offset);
function duelMayFire() {
  if (!duel.live) { toast(duel.link?.open ? 'Waiting for the clocks to agree…' : 'Waiting for your friend to connect'); return false; }
  if (duel.replay) return false;
  if (duel.over) { toast('The duel is over: press Rematch'); return false; }
  if (tNow < duel.startAt) { toast(`Fire at will in ${Math.ceil(duel.startAt - tNow)} s`); return false; }
  if (tNow < duel.ceaseUntil) { toast('Cease fire'); return false; }
  return true;
}
// The settings both browsers must share: locked for the duel.
function lockForDuel(on) {
  for (const id of DUEL_KEYS) { const el = $(id); if (el) el.disabled = on; }
  for (const b of document.querySelectorAll('#presets button, #presetsShort button')) b.disabled = on;
  $('layers').hidden = on;
  $('duelWindNote').hidden = !on;
}
// A random wind for the duel, in the challenger's frame: 0 to 25 km/h from
// any clock, gusts of 5 to 20 % of it (both see only its flags).
function rollWind() {
  const r = crypto.getRandomValues(new Uint16Array(3)), u = (k) => r[k] / 65535;
  const spd = Math.round(u(0) * 50) / 2, clock = Math.round(u(1) * 24) / 2, gust = Math.round(spd * (0.05 + 0.15 * u(2)) * 2) / 2;
  S.same = true;
  S.layers = [0, 1, 2].map(() => layer(spd, clock, gust));
}
function duelUrl(extra) {
  const q = new URLSearchParams(new URL(shareUrl(null)).search);
  q.delete('fire'); q.delete('cw'); q.delete('am'); q.delete('tu'); q.delete('ho'); q.delete('tr'); q.delete('sc');
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${location.origin}/sao-paulo/ballistics/?${q}`;
}
function duelUI() {
  const st = $('duelState'), sc = $('duelScore');
  if (!duel) { st.textContent = 'challenge a friend'; sc.hidden = true; $('bDuel').hidden = false; $('bDuelEnd').hidden = true; $('bRematch').hidden = true; return; }
  $('bDuel').hidden = true; $('bDuelEnd').hidden = false;
  st.textContent = duel.link?.open ? (duel.live ? `connected · ${duel.rtt != null ? Math.round(duel.rtt * 1000) + ' ms' : ''}` : 'connected · syncing clocks') : duel.state;
  sc.hidden = false;
  const me = duel.score[duel.seat], them = duel.score[duel.seat === 'A' ? 'B' : 'A'];
  let line = `You <b>${me}</b> · <b>${them}</b> Friend`;
  if (duel.over) line += ` · ${me > them ? 'you win' : 'your friend wins'}`;
  else if (duel.live && tNow < duel.startAt) line += ` · fire at will in ${Math.max(0, Math.ceil(duel.startAt - tNow))}`;
  else if (duel.live && tNow < duel.ceaseUntil) line += ' · cease fire';
  sc.innerHTML = line;
  $('bRematch').hidden = !duel.over;
  $('bMic').hidden = !duel.link?.mic;
  $('bMic').setAttribute('aria-pressed', String(!!duel.micOn));
}
function startDuelCommon(seatName, id) {
  duel = { id, seed: parseInt(id.slice(0, 12), 16) + 1, seat: seatName, link: null, live: false, epoch: performance.now() / 1000, offset: 0, rtt: null, startAt: Infinity, ceaseUntil: 0,
    score: { A: 0, B: 0 }, over: false, sent: 0, mine: new Map(), theirs: new Map(), state: 'connecting', replay: null, last: null, lastPing: 0, best: Infinity };
  S.tgt = 'duel'; S.callTrue = false; S.call = layer(0, 12);
  auto = false; $('bAuto').setAttribute('aria-pressed', 'false');
  retireAll(); shot = null;
  resetAim(); syncUI(); changed(true); refresh();
  lockForDuel(true);
  setCam('scope');
  duelUI();
}
function wireLink(link) {
  duel.link = link;
  link.onopen = () => {
    duel.state = 'connected';
    link.send({ t: 'hello', v: 1, seat: duel.seat, engine: engineId(), lib: libHash });
    if (duel.seat === 'B') duelPing();
    $('duelShare').hidden = true;
    toast('Connected to your friend');
    duelUI();
  };
  link.onclose = () => { if (!duel) return; duel.state = 'disconnected'; duel.live = false; toast('Your friend disconnected'); duelUI(); };
  link.onmessage = onDuelMessage;
}
async function challenge(kind = 'rtc') {
  const id = newDuelId();
  rollWind();
  startDuelCommon('A', id);
  duel.state = 'making the link…';
  duelUI();
  if (kind === 'local') {
    wireLink(localLink(id, 'A'));
    showDuelLink(duelUrl({ duel: id, net: 'local' }), 'Open this link in another tab of this browser.');
    return;
  }
  // Railgun Meet first (one link, voice, any network); if it does not
  // answer, a direct browser-to-browser link with a reply.
  try {
    duel.state = 'opening a voice channel…';
    duelUI();
    const link = await meetLink(id, 'A');
    wireLink(link);
    duel.state = 'waiting for your friend';
    showDuelLink(duelUrl({ duel: id, net: 'meet' }), 'Send this link to your friend: the duel starts when they open it. You can talk to each other (Mic).');
    duelUI();
    return;
  } catch { /* Meet is not reachable from here: the direct link */ }
  try {
    const link = await hostRtc(id);
    wireLink(link);
    duel.state = 'waiting for your friend';
    showDuelLink(duelUrl({ duel: id, offer: link.offer }), 'Send this link to your friend. When they send you their reply link, open it in this browser (or paste it below).');
  } catch (e) { duel.state = 'could not start: ' + e.message; }
  duelUI();
}
async function acceptChallenge(id, offer, net) {
  startDuelCommon('B', id);
  if (net === 'local') { wireLink(localLink(id, 'B')); duelUI(); return; }
  if (net === 'meet') {
    try {
      duel.state = 'joining the voice channel…';
      duelUI();
      wireLink(await meetLink(id, 'B', 10000));
      duel.state = 'waiting for your friend';
    } catch (e) { duel.state = 'could not join: ' + e.message; }
    duelUI();
    return;
  }
  try {
    duel.state = 'answering…';
    duelUI();
    const link = await joinRtc(offer);
    wireLink(link);
    duel.state = 'waiting for your friend to open your reply';
    showDuelLink(`${location.origin}/sao-paulo/ballistics/?duel=${id}&answer=${link.answer}`, 'Send this reply link back to your friend: the duel starts when they open it.');
  } catch (e) { duel.state = 'could not answer: ' + e.message; }
  duelUI();
}
function showDuelLink(url, note) {
  $('duelShare').hidden = false;
  $('duelLink').value = url;
  $('duelNote').textContent = note;
  $('duelPaste').hidden = duel.seat !== 'A' || duel.link?.kind !== 'rtc';
}
function endDuel() {
  duel?.link?.close?.();
  duel = null;
  lockForDuel(false);
  $('duelShare').hidden = true;
  S.tgt = 'plate';
  retireAll(); shot = null;
  syncUI(); changed(true); refresh();
  duelUI();
}
// Clock: the challenger's is the duel's. The friend pings; the reply with
// the shortest round trip sets the offset (half the trip each way).
function duelPing() { duel.lastPing = performance.now(); duel.link.send({ t: 'ping', a: performance.now() / 1000 }); }
function onDuelMessage(m) {
  if (!duel) return;
  const L = duel.link;
  if (m.t === 'hello') {
    if (m.engine !== engineId() || m.lib !== libHash) toast('Your friend runs another version of the range: reload both pages');
    return;
  }
  if (m.t === 'ping' && duel.seat === 'A') { L.send({ t: 'pong', a: m.a, h: duelNow() }); return; }
  if (m.t === 'pong' && duel.seat === 'B') {
    const b = performance.now() / 1000, rtt = b - m.a;
    if (rtt < duel.best) { duel.best = rtt; duel.offset = m.h + rtt / 2 - b; }
    duel.rtt = rtt;
    duel.pings = (duel.pings ?? 0) + 1;
    if (duel.pings === 5 && !duel.live) L.send({ t: 'ready' });
    return;
  }
  if (m.t === 'ready' && duel.seat === 'A') { goLive(duelNow() + 5); L.send({ t: 'start', at: duel.startAt }); return; }
  if (m.t === 'start' && duel.seat === 'B') { goLive(m.at); return; }
  if (m.t === 'shot') { fireRemote(m); return; }
  if (m.t === 'outcome') { checkOutcome(m); return; }
  if (m.t === 'rematch') { rematch(false); return; }
}
function goLive(at) {
  duel.live = true;
  duel.startAt = at;
  tNow = duelNow();
  duelUI();
  banner('Duel', `${fmtDist(S.dist)} · fire at will in ${Math.round(at - tNow)} s`);
}
function duelFrame() {
  if (duel.seat === 'B' && duel.link?.open && performance.now() - duel.lastPing > (duel.live ? 3000 : 250)) duelPing();
  if (Math.floor(performance.now() / 250) !== duel.uiTick) { duel.uiTick = Math.floor(performance.now() / 250); duelUI(); }
}
// My shot leaves: tell the other browser exactly what left the muzzle.
function duelSent(sh) {
  const k = ++duel.sent;
  sh.k = k;
  duel.mine.set(k, sh);
  duel.link.send({ t: 'shot', k, c: sh.S.c, el: sh.el, az: sh.az, t0: sh.t0, ...(sh.seed ? { seed: sh.seed.seed, stream: sh.seed.stream } : {}) });
}
// The other shooter's round, flown here from their muzzle at the far end
// toward mine: the same call, so the same round as in their browser.
function fireRemote(m) {
  if (!duel || duel.theirs.has(m.k)) return;
  const k = cartIndex(m.c);
  if (k < 0) return;
  const r = raw.rifles.find((x) => x.id === RIFLE_FOR[m.c]);
  station();
  B.bd_setup(r ? r.twist_in * IN * (r.twist_direction === 'left' ? -1 : 1) : 0, S.lat * DEG, (S.spin ? 1 : 0) | (S.earth ? 2 : 0));
  // Their round's own draw: their rifle's group, the powder at this air (a
  // shot without a seed is a round of the published load).
  B.bd_powder(m.seed ? S.temp + 273.15 : 0);
  B.bd_group(m.seed ? r?.group_moa ?? 0 : 0);
  B.wind(S.az * DEG, trueLayers());
  const o = enu(S.dist, 0, 0);
  const id = m.seed ? B.bd_fire_round(k, o[0], o[1], o[2], m.az, m.el, m.t0, m.seed, m.stream) : B.bd_fire(k, o[0], o[1], o[2], m.az, m.el, m.t0);
  if (!id) return;
  let t = m.t0, rr = B.round();
  while (!rr.stopped && t - m.t0 < 25) {
    t += 0.05;
    B.bd_advance(t, 0);
    rr = B.round();
    const l = lof(rr.position);
    if (l.d < -1 && l.u < -BENCH) break;
    if (l.d < -(S.dist * 0.6 + 50)) break;
  }
  const tEnd = rr.time;
  const toMe = (tt) => lof(B.stateAt(tt).position).d;  // my distance from it: 0 at my muzzle
  const bisect = (f, a, b) => { for (let i = 0; i < 60; ++i) { const c = 0.5 * (a + b); if (f(c)) b = c; else a = c; } return 0.5 * (a + b); };
  let tTarget = toMe(tEnd) <= 0 ? bisect((tt) => toMe(tt) <= 0, m.t0, tEnd) : null;
  let hit = false, part = null, impact = null, pass = null;
  if (tTarget !== null) {
    const p = lof(B.stateAt(tTarget).position);
    // In their frame right is my left; the figure is symmetric, so the test is the same.
    if (p.u > -BENCH) {
      part = figurePart(-p.r, p.u);
      hit = part !== null;
      impact = { right: p.r, up: p.u - FIGURE.head.z };  // as I see it
      const st = B.stateAt(tTarget), a = B.air(st.position[0], st.position[1], st.position[2], tTarget);
      pass = { miss: Math.hypot(p.r, p.u - FIGURE.head.z), mach: Math.hypot(st.velocity[0] - a.wind[0], st.velocity[1] - a.wind[1], st.velocity[2] - a.wind[2]) / a.speedOfSound };
    } else tTarget = null;
  }
  let tGround = null;
  if (!hit) { const below = (tt) => B.stateAt(tt).position[2] <= -BENCH; if (below(tEnd)) tGround = bisect(below, m.t0, tEnd); }
  const mesh = new THREE.Group(), body = new THREE.Group();
  body.name = 'body';
  mesh.add(body);
  makeBullet(m.c, mesh, body);
  scene.add(mesh);
  const air = B.air(0, 0, 0, m.t0);
  const sh = { id, remote: true, k: m.k, S: { ...structuredClone(S), c: m.c }, t0: m.t0, tEnd, tTarget, tGround, tStop: hit ? tTarget : tGround ?? (tTarget ?? tEnd),
    hit, part, impact, pass, mesh, body, len: mesh.userData.length, done: false, doneWall: 0, left: false, heard: false, reportDelay: S.dist / air.speedOfSound };
  shots.push(sh);
  duel.theirs.set(m.k, sh);
  if (shots.length > 40) retire(shots.find((x) => x !== shot));
  // Back to my rifle in the engine.
  setup(false);
  if (duel.pendingOutcome?.has(m.k)) checkOutcome(duel.pendingOutcome.get(m.k));
}
// Both browsers flew it; the shooter's says what it found, the other checks.
function checkOutcome(m) {
  const sh = duel.theirs.get(m.k);
  if (!sh) { (duel.pendingOutcome ??= new Map()).set(m.k, m); return; }
  if (sh.hit !== m.hit || sh.part !== m.part) { duel.mismatch = true; toast(`Our two browsers disagree about shot ${m.k}: please report it`); }
}
function score(seatName, part) {
  duel.score[seatName] += part === 'head' ? 2 : 1;
  if (duel.score[seatName] >= DUEL_TO) duel.over = true;
}
// A round ends its flight: score it the same way in both browsers.
function duelArrive(sh) {
  if (S.tgt !== 'duel') return false;
  const ceaseFrom = (x) => { duel.ceaseUntil = Math.max(duel.ceaseUntil, x.tStop + CEASE); duel.last = x; };
  if (!sh.remote) {
    duel.link?.send({ t: 'outcome', k: sh.k, hit: sh.hit, part: sh.part });
    if (sh.hit) {
      score(duel.seat, sh.part);
      ceaseFrom(sh);
      ping(); tick();
      const m = $('hitmark'); m.classList.remove('on', 'kill'); void m.offsetWidth; m.classList.add('on', 'kill');
      banner(sh.part === 'head' ? 'Headshot' : 'Hit', duel.over ? 'you win the duel · K for the killcam' : `your friend's ${sh.part} · K for the killcam`);
    } else if (sh.impact) {
      banner('Miss', `${fmtLen(Math.abs(sh.impact.right))} ${sh.impact.right >= 0 ? 'right' : 'left'}, ${fmtLen(Math.abs(sh.impact.up))} ${sh.impact.up >= 0 ? 'high' : 'low'} of the head`);
      impacts.push({ right: sh.impact.right, up: sh.impact.up, hit: false }); if (impacts.length > 6) impacts.shift();
    } else banner('Miss', 'short of your friend');
    duelUI();
    return true;
  }
  // Theirs, at me.
  if (sh.hit) {
    score(duel.seat === 'A' ? 'B' : 'A', sh.part);
    ceaseFrom(sh);
    noiseBurst(0.3, 500, 0.6);
    $('hurt').classList.remove('on'); void $('hurt').offsetWidth; $('hurt').classList.add('on');
    banner(sh.part === 'head' ? 'Headshot' : 'You are hit', duel.over ? 'your friend wins the duel · K for the killcam' : `in the ${sh.part} · K to see it`);
  } else if (sh.pass) {
    // A supersonic round passing close cracks; a subsonic one only hisses.
    if (sh.pass.miss < 4) noiseBurst(sh.pass.mach > 1 ? 0.06 : 0.25, sh.pass.mach > 1 ? 5200 : 1800, sh.pass.mach > 1 ? 0.7 : 0.15, 1.5);
    banner(sh.pass.mach > 1 && sh.pass.miss < 4 ? 'Snap' : 'Incoming', `${fmtLen(sh.pass.miss)} from your head (${Math.abs(sh.impact.right) > Math.abs(sh.impact.up) ? (sh.impact.right > 0 ? 'right' : 'left') : sh.impact.up > 0 ? 'high' : 'low'})`);
  } else banner('Incoming', 'it landed short of you');
  duelUI();
  return true;
}
// K: the last hit again, in bullet time, from behind the round.
function killcam() {
  // The last hit, or else my last round.
  const sh = duel?.last ?? shot;
  if (!duel || !sh || duel.replay) return;
  duel.replay = sh;
  tNow = sh.t0;
  auto = true;
  setCam('bullet');
}
function endKillcam() {
  duel.replay = null;
  auto = false;
  tNow = duel.live ? duelNow() : tNow;
  setCam('scope');
}
function rematch(tell) {
  duel.score = { A: 0, B: 0 };
  duel.over = false;
  duel.ceaseUntil = 0;
  duel.startAt = duelNow() + 5;
  if (tell) duel.link?.send({ t: 'rematch' });
  banner('Rematch', 'fire at will in 5 s');
  duelUI();
}
$('bDuel').onclick = () => challenge(Q.get('net') === 'local' ? 'local' : 'rtc');
$('bDuelEnd').onclick = () => endDuel();
$('duelLink').onfocus = (e) => e.target.select();
$('bRematch').onclick = () => rematch(true);
// Voice (Railgun Meet duels): the microphone is off until you turn it on.
async function setMic(on) {
  if (!duel?.link?.mic) return;
  try { await duel.link.mic(on); duel.micOn = on; } catch (e) { toast('Microphone: ' + e.message); duel.micOn = false; }
  duelUI();
}
$('bMic').onclick = () => setMic(!duel?.micOn);
// Browsers start remote audio only after a gesture.
window.addEventListener('pointerdown', () => duel?.link?.startAudio?.(), { capture: true });
$('bDuelCopy').onclick = async () => { try { await navigator.clipboard.writeText($('duelLink').value); toast('Link copied'); } catch { $('duelLink').select(); } };
$('bDuelShare').onclick = async () => { try { await navigator.share({ title: 'Sniper duel', text: 'A sniper duel on the São Paulo World range', url: $('duelLink').value }); } catch { $('bDuelCopy').click(); } };
$('duelReply').onchange = async (e) => {
  const v = e.target.value.trim(), code = v.includes('answer=') ? new URL(v, location.origin).searchParams.get('answer') : v;
  if (duel?.link?.accept && code && (await duel.link.accept(code).catch(() => false))) toast('Connecting…'); else toast('That is not a reply to this duel');
};

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
if (Q.has('duel') && Q.has('answer')) {
  // A reply link: hand the answer to the duel tab in this browser.
  deliverAnswer(Q.get('duel'), Q.get('answer')).then((ok) => {
    $('duelShare').hidden = false;
    $('duelLink').value = '';
    $('duelNote').textContent = ok ? 'Your friend is connecting: go back to your duel tab.' : 'No duel tab took this reply. Open it in the browser where you made the challenge, or paste it into that tab.';
    banner(ok ? 'Reply delivered' : 'Reply not delivered', ok ? 'go back to your duel tab' : 'open it in the browser with the duel');
  });
} else if (Q.has('duel')) acceptChallenge(Q.get('duel').replace(/[^0-9a-f]/g, '').slice(0, 24), Q.get('offer') || '', Q.get('net') || 'rtc');
else if (autoFire) setTimeout(fireNow, 300);
duelUI();
// The Glass engine (for the V8's windscreen) loads in the background.
setTimeout(() => ensureGlass().catch(() => {}), 1500);
// For the browser console: the engine and the current shot.
window.ballisticsRange = { B, R, wakeRT, wakeGeo, shock, get duel() { return duel; }, challenge, killcam, get shot() { return shot; }, get G() { return G; }, get S() { return S; }, get dope() { return dope; }, shots, get tNow() { return tNow; }, get flags() { return flags; } };
