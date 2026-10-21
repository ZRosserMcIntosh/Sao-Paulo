// São Paulo World · Liquids Lab.
// Physics: the Liquid Dynamics fluid core (C++, MIT) compiled to WebAssembly;
// panes of glass are broken by the Glass Dynamics core from the Glass lab.
// Rendering: three.js (MIT). This file only draws what the cores return and
// reads input: every splash, drop, stain and shard comes from the engines.
import * as THREE from 'three';
import createLiquidModule from './liquid.mjs';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw-liquids:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw-liquids:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SCALES = [[1, '1×'], [0.25, '1/4'], [0.1, '1/10'], [0.01, '1/100'], [1e-3, '1/1k']];
const TIER_NAMES = ['Potato', 'Low', 'Medium', 'High', 'Ultra'];
const STATE = { WAITING: 0, FLYING: 1, AT_PANE: 2, STOPPED: 3 };

// ---------- Engines ----------
let L, cat, G = null, gcat = null;
try {
  L = await createLiquidModule();
  const errs = L.load(await (await fetch('library.json')).text());
  if (errs.length) throw new Error(errs.join('; '));
  cat = L.catalog();
} catch (e) {
  $('loadMsg').textContent = 'Could not start the fluid engine in this browser: ' + e.message;
  throw e;
}
// Glass Dynamics for the panes (the round's speed through the glass, its cracks).
try {
  const { default: createGlassModule } = await import('../glass/glass.mjs');
  G = await createGlassModule();
  const errs = G.load(await (await fetch('../glass/library.json')).text());
  if (errs.length) throw new Error(errs.join('; '));
  gcat = G.catalog();
} catch (e) {
  console.warn('Glass Dynamics not available, panes use the built-in estimate:', e);
  G = null;
}

// ---------- Device tier ----------
function benchmark() {
  L.lqd_bench();  // warm the JIT
  const ms = L.lqd_bench();
  let t = ms <= 4 ? 3 : ms <= 9 ? 2 : ms <= 18 ? 1 : 0;
  const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 4;
  if (cores <= 2 || mem <= 2) t = Math.min(t, 1);
  return { tier: t, ms };
}
const bench = benchmark();
let tierChoice = store.get('tier', 'auto');
let tier = tierChoice === 'auto' ? bench.tier : +tierChoice;

// ---------- Renderer ----------
const canvas = $('view');
let R = null;
try { R = new THREE.WebGLRenderer({ canvas, antialias: tier >= 2, powerPreference: 'high-performance' }); } catch { R = null; }
if (!R) {
  $('loadMsg').textContent = 'The Liquids lab needs WebGL, which this browser does not offer.';
  throw new Error('no WebGL');
}
R.outputColorSpace = THREE.SRGBColorSpace;
R.toneMapping = THREE.ACESFilmicToneMapping;
R.toneMappingExposure = 1.05;
R.shadowMap.enabled = tier >= 2;
R.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x343b47);
scene.fog = new THREE.Fog(0x343b47, 9, 26);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 80);
{
  // A studio environment for reflections: gradient dome and two soft boxes.
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'varying vec3 vp; void main(){ float h = normalize(vp).y; vec3 c = mix(vec3(0.05,0.06,0.08), vec3(0.6,0.66,0.75), smoothstep(-0.2,0.9,h)); gl_FragColor = vec4(c,1.); }',
  }));
  env.add(dome);
  for (const [x, y, z, s] of [[4, 5, 3, 3], [-5, 3, -2, 2]]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    b.position.set(x, y, z); b.lookAt(0, 0, 0); env.add(b);
  }
  const pm = new THREE.PMREMGenerator(R);
  scene.environment = pm.fromScene(env, 0.04).texture;
}
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2018, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(2.5, 5, 3.5);
key.castShadow = tier >= 2;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 15 });
key.shadow.bias = -0.0004;
scene.add(key);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  R.setPixelRatio([0.75, 1, Math.min(dpr, 1.5), Math.min(dpr, 2), Math.min(dpr, 2)][tier]);
  R.setSize(w, h, false);
  camera.aspect = w / h;
  if (w <= 860) camera.setViewOffset(w, h, 0, h * 0.18, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------- Materials ----------
const lin = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
const glassMat = tier >= 3
  ? new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, metalness: 0, transmission: 1, thickness: 0.002, ior: 1.52, transparent: true, side: THREE.DoubleSide, envMapIntensity: 1.2 })
  : new THREE.MeshPhysicalMaterial({ color: 0xdfefff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.28, side: THREE.DoubleSide, envMapIntensity: 1.4, clearcoat: 1, depthWrite: false });
const bottleMat = new THREE.MeshPhysicalMaterial({ color: 0x1d4a2c, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.62, side: THREE.DoubleSide, envMapIntensity: 1.5, clearcoat: 1, depthWrite: false });
const paneMat = new THREE.MeshPhysicalMaterial({ color: 0xcfe6ff, roughness: 0.02, transparent: true, opacity: 0.16, side: THREE.DoubleSide, envMapIntensity: 1.2, depthWrite: false });
const crackMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
const stringMat = new THREE.LineBasicMaterial({ color: 0xff4b3e, transparent: true, opacity: 0.75 });
const truthMat = new THREE.MeshBasicMaterial({ color: 0x36c483 });
const guessMat = new THREE.MeshBasicMaterial({ color: 0xff4b3e });
const dummyMat = new THREE.MeshStandardMaterial({ color: 0xf2b711, roughness: 0.55, metalness: 0.05 });
const jointMat = new THREE.MeshStandardMaterial({ color: 0x1d1d22, roughness: 0.6 });
let liquidMat = new THREE.MeshPhysicalMaterial({ color: 0x5a0410, roughness: 0.06, transmission: 0, clearcoat: 1, clearcoatRoughness: 0.04 });
let dropMat = liquidMat;
let stainMat = new THREE.MeshStandardMaterial({ color: 0x300410, roughness: 0.4, transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
function liquidMaterials(id) {
  const d = cat.liquids.find((x) => x.id === id) || cat.liquids[0];
  const col = lin(d.color);
  liquidMat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03,
    transparent: d.opacity < 0.9, opacity: Math.max(0.35, d.opacity), envMapIntensity: 1.3, sheen: 0 });
  dropMat = liquidMat;
  stainMat = new THREE.MeshStandardMaterial({ color: lin(d.stainColor), roughness: 0.45, transparent: true, opacity: 0.9,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  return d;
}

// ---------- Scenes and their settings ----------
const SCENES = [
  { id: 'wine_glass', name: 'Wine glass off the table', sub: 'Knocked off the edge, onto the floor', opts: ['liquid', 'floor', 'knock', 'fill'] },
  { id: 'bottle_drop', name: 'Wine bottle on the floor', sub: 'An open bottle let go from a height', opts: ['liquid', 'floor', 'height', 'tilt', 'fill'] },
  { id: 'gunshot', name: 'Crash dummy: the shot', sub: 'Spatter on the wall, the floor and the glass', opts: ['projectile', 'target', 'pane', 'glazing', 'distance', 'floor'], feature: true },
  { id: 'drip', name: 'Drip test', sub: 'Passive drops from seven heights', opts: ['liquid', 'floor', 'height'] },
  { id: 'angles', name: 'Impact-angle card', sub: 'Drops thrown at a wall from 10° to 90°', opts: ['liquid', 'wall'] },
  { id: 'dam_break', name: 'Dam break', sub: 'Martin & Moyce’s water column: the validation case', opts: [] },
];
const GLAZINGS = ['annealed_6', 'tempered_6', 'laminated_6_38', 'storefront_tempered_10', 'windscreen', 'car_side_tempered', 'ul752_l1', 'ul752_l3'];
const defaults = {
  wine_glass: { liquid: 'red_wine', floor: 'ceramic_tile', knock: 0.9, fill: 150 },
  bottle_drop: { liquid: 'red_wine', floor: 'ceramic_tile', height: 1.0, tilt: 25, fill: 700 },
  gunshot: { projectile: 'pistol_9mm_fmj', target: 'chest', pane: 'behind', glazing: 'annealed_6', distance: 3.0, floor: 'concrete' },
  drip: { liquid: 'stage_blood_green', floor: 'ceramic_tile', height: 2.1 },
  angles: { liquid: 'stage_blood_green', wall: 'painted_drywall' },
  dam_break: {},
};
const settings = store.get('settings', {});
for (const k of Object.keys(defaults)) settings[k] = { ...defaults[k], ...(settings[k] || {}) };
let sceneId = store.get('scene', 'wine_glass');
if (!SCENES.find((s) => s.id === sceneId)) sceneId = 'wine_glass';

const OPT = {
  liquid: { label: 'Liquid', type: 'select', items: () => cat.liquids.filter((l) => l.id !== 'water' || sceneId !== 'gunshot').map((l) => [l.id, l.name]) },
  floor: { label: 'Floor', type: 'select', items: () => cat.surfaces.filter((s) => ['ceramic_tile', 'oak_floor', 'concrete', 'carpet'].includes(s.id)).map((s) => [s.id, s.name]) },
  wall: { label: 'Wall', type: 'select', items: () => cat.surfaces.filter((s) => ['painted_drywall', 'glass_pane', 'ceramic_tile', 'concrete'].includes(s.id)).map((s) => [s.id, s.name]) },
  projectile: { label: 'Round', type: 'select', items: () => cat.projectiles.map((p) => [p.id, `${p.name} · ${(p.mass * 1e3).toFixed(1)} g at ${p.speed.toFixed(0)} m/s`]) },
  target: { label: 'Aim', type: 'select', items: () => [['chest', 'Chest'], ['abdomen', 'Abdomen'], ['shoulder', 'Shoulder'], ['thigh', 'Thigh']] },
  pane: { label: 'Glass pane', type: 'select', items: () => [['none', 'No glass'], ['front', 'In front of the dummy (shot through it)'], ['behind', 'Behind the dummy (catches the spatter)']] },
  glazing: { label: 'Glazing', type: 'select', items: () => (gcat ? GLAZINGS.map((id) => gcat.glazings.find((g) => g.id === id)).filter(Boolean).map((g) => [g.id, g.name]) : [['annealed_6', '6 mm annealed (estimate)']]),
    show: () => settings.gunshot.pane !== 'none' },
  knock: { label: 'Knock', type: 'range', min: 0.5, max: 2.0, step: 0.05, fmt: (v) => `${v.toFixed(2)} m/s` },
  fill: { label: 'Fill', type: 'range', min: 30, max: () => (sceneId === 'bottle_drop' ? 750 : 450), step: 10, fmt: (v) => `${v.toFixed(0)} ml` },
  height: { label: 'Height', type: 'range', min: 0.3, max: 2.5, step: 0.05, fmt: (v) => `${v.toFixed(2)} m` },
  tilt: { label: 'Tilt', type: 'range', min: 0, max: 90, step: 1, fmt: (v) => `${v.toFixed(0)}°` },
  distance: { label: 'Muzzle to dummy', type: 'range', min: 1.0, max: 6.0, step: 0.1, fmt: (v) => `${v.toFixed(1)} m` },
};

function buildSceneButtons() {
  const box = $('scenes');
  box.innerHTML = '';
  for (const s of SCENES) {
    const b = document.createElement('button');
    b.className = s.feature ? 'feature' : '';
    b.setAttribute('aria-pressed', String(s.id === sceneId));
    b.innerHTML = `${s.name}<small>${s.sub}</small>`;
    b.onclick = () => { sceneId = s.id; store.set('scene', sceneId); buildSceneButtons(); buildOptions(); go(); };
    box.appendChild(b);
  }
}
function buildOptions() {
  const box = $('opts');
  box.innerHTML = '';
  const S = SCENES.find((s) => s.id === sceneId), cfg = settings[sceneId];
  for (const k of S.opts) {
    const o = OPT[k];
    if (o.show && !o.show()) continue;
    if (o.type === 'select') {
      const f = document.createElement('label');
      f.className = 'field';
      f.textContent = o.label;
      const sel = document.createElement('select');
      for (const [v, t] of o.items()) { const op = document.createElement('option'); op.value = v; op.textContent = t; sel.appendChild(op); }
      if (![...sel.options].some((op) => op.value === cfg[k])) cfg[k] = sel.options[0]?.value;
      sel.value = cfg[k];
      sel.onchange = () => { cfg[k] = sel.value; store.set('settings', settings); if (k === 'pane') buildOptions(); };
      f.appendChild(sel);
      box.appendChild(f);
    } else {
      const f = document.createElement('div');
      f.className = 'slider';
      const max = typeof o.max === 'function' ? o.max() : o.max;
      cfg[k] = clamp(cfg[k], o.min, max);
      f.innerHTML = `<span>${o.label}</span><b>${o.fmt(cfg[k])}</b>`;
      const r = document.createElement('input');
      Object.assign(r, { type: 'range', min: o.min, max, step: o.step, value: cfg[k] });
      r.setAttribute('aria-label', o.label);
      r.oninput = () => { cfg[k] = +r.value; f.querySelector('b').textContent = o.fmt(cfg[k]); store.set('settings', settings); };
      f.appendChild(r);
      box.appendChild(f);
    }
  }
  const notes = {
    wine_glass: 'A sideways knock at the bowl tips it over the table edge; whether it breaks depends on what it lands on and how.',
    bottle_drop: 'Bottles are heavier and thicker: they break less easily, and when they do there is far more wine.',
    gunshot: G ? 'The pane is broken by Glass Dynamics, which tells the round how fast it carries on.' : 'Glass Dynamics did not load: panes use a built-in estimate.',
    drip: 'A 50 µl drop from 0.3 to the height you set: drip stains are round, and grow with the fall.',
    angles: 'Each drop meets the card at a known angle; read it back from the stain with sin(angle) = width ÷ length.',
    dam_break: 'The classic validation of a free-surface solver; its front is checked against Martin & Moyce (1952) in the tests.',
  };
  $('goNote').textContent = notes[sceneId] || '';
}

// ---------- World and its visuals ----------
const world = new THREE.Group();
scene.add(world);
let info = null, liquid = null;
let P = null;  // the current run's visuals and state

function clearWorld() {
  world.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  world.clear();
}

function surfaceMaterial(c) {
  const col = lin(c.color);
  if (c.role === 'floor' && c.surface === 'ceramic_tile') return new THREE.MeshStandardMaterial({ map: tileTexture(), color: 0xffffff, roughness: 0.25, metalness: 0 });
  if (c.role === 'floor' && c.surface === 'oak_floor') return new THREE.MeshStandardMaterial({ map: boardTexture(), color: 0xffffff, roughness: 0.45 });
  if (c.surface === 'carpet') return new THREE.MeshStandardMaterial({ color: col, roughness: 1 });
  if (c.role === 'table') return new THREE.MeshStandardMaterial({ map: boardTexture(true), color: 0xffffff, roughness: 0.5 });
  return new THREE.MeshStandardMaterial({ color: col, roughness: c.role === 'wall' ? 0.9 : 0.6 });
}
let tileTex = null, boardTex = null, tableTex = null;
function tileTexture() {
  if (tileTex) return tileTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#d8d4cc'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#a9a49b'; g.fillRect(0, 0, 256, 4); g.fillRect(0, 0, 4, 256);
  tileTex = new THREE.CanvasTexture(cv); tileTex.colorSpace = THREE.SRGBColorSpace;
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping; tileTex.repeat.set(16, 16);
  return tileTex;
}
function boardTexture(table = false) {
  if (table ? tableTex : boardTex) return table ? tableTex : boardTex;
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  const g = cv.getContext('2d');
  for (let i = 0; i < 8; ++i) {
    const base = table ? [92, 58, 34] : [140, 94, 56];
    const j = (i * 37) % 11 - 5;
    g.fillStyle = `rgb(${base[0] + j * 3},${base[1] + j * 2},${base[2] + j})`;
    g.fillRect(i * 64, 0, 64, 512);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(i * 64, 0, 2, 512);
    for (let k = 0; k < 30; ++k) { g.fillStyle = `rgba(40,20,5,${0.05 + Math.random() * 0.06})`; g.fillRect(i * 64 + Math.random() * 64, 0, 1, 512); }
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(table ? 1 : 5, table ? 1 : 5);
  if (table) tableTex = t; else boardTex = t;
  return t;
}

function addCollider(c) {
  const q = new THREE.Quaternion(c.rot[0], c.rot[1], c.rot[2], c.rot[3]);
  if (c.kind === 'plane' && info.scenario === 'dam_break' && c.role === 'wall') {
    // The tank's glass walls, at their own size.
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const side = Math.abs(n.z) > 0.5;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(side ? 0.584 : 0.04, 0.32), paneMat.clone());
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    m.position.set(side ? 0.292 : c.pos[0], 0.16, side ? c.pos[2] : 0.01);
    world.add(m);
    return m;
  }
  if (c.kind === 'plane') {
    const big = c.role === 'floor' ? 12 : 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(big, c.role === 'floor' ? big : 4), surfaceMaterial(c));
    // Plane geometry faces +z; the collider's normal is rot * (0, 1, 0).
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    m.position.set(c.pos[0], c.pos[1], c.pos[2]);
    if (c.role === 'wall') m.position.y = Math.max(m.position.y, 2);
    m.receiveShadow = true;
    world.add(m);
    return m;
  }
  if (c.kind === 'box') {
    const isPane = c.role === 'pane';
    const m = new THREE.Mesh(new THREE.BoxGeometry(2 * c.half[0], 2 * c.half[1], 2 * c.half[2]), isPane ? paneMat.clone() : surfaceMaterial(c));
    m.position.set(c.pos[0], c.pos[1], c.pos[2]);
    m.quaternion.copy(q);
    m.castShadow = !isPane; m.receiveShadow = true;
    world.add(m);
    if (c.role === 'table') {
      // Legs (drawn only: nothing in the scenes reaches under the table top).
      const top = c.pos[1] - c.half[1];
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, top, 0.05), surfaceMaterial(c));
        leg.position.set(c.pos[0] + sx * (c.half[0] - 0.06), top / 2, c.pos[2] + sz * (c.half[2] - 0.06));
        leg.castShadow = true; world.add(leg);
      }
    }
    if (isPane) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2 * c.half[0] + 0.06, 2 * c.half[1] + 0.06, 0.04),
        new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.5, metalness: 0.6 }));
      // A frame ring: a box with the glass's own box cut out is overkill; four bars instead.
      frame.visible = false;
      const bars = new THREE.Group();
      const W = 2 * c.half[0], H = 2 * c.half[1], b = 0.035;
      for (const [w, h, x, y] of [[W + 2 * b, b, 0, H / 2 + b / 2], [W + 2 * b, b, 0, -H / 2 - b / 2], [b, H, W / 2 + b / 2, 0], [b, H, -W / 2 - b / 2, 0]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), frame.material);
        bar.position.set(x, y, 0); bar.castShadow = true; bars.add(bar);
      }
      bars.position.copy(m.position); bars.quaternion.copy(q);
      world.add(bars);
    }
    return m;
  }
  if (c.kind === 'capsule') {
    const a = new THREE.Vector3(...c.a), b = new THREE.Vector3(...c.b);
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(c.radius, Math.max(len, 1e-4), 6, 16), dummyMat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    if (len > 1e-6) m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = m.receiveShadow = true;
    world.add(m);
    // Black joint rings, crash-test style.
    if (/upper arm|thigh|forearm|shin/.test(c.name)) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(c.radius * 1.01, c.radius * 0.18, 8, 20), jointMat);
      ring.position.copy(a); ring.quaternion.copy(m.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
      world.add(ring);
    }
    if (c.name === 'head') {
      // The calibration target on the side of the head.
      const disc = new THREE.Mesh(new THREE.CircleGeometry(c.radius * 0.45, 24), new THREE.MeshBasicMaterial({ color: 0x111111 }));
      disc.position.set(c.pos[0] + c.radius * 1.01, c.pos[1], c.pos[2]); disc.rotation.y = Math.PI / 2; world.add(disc);
      const half = new THREE.Mesh(new THREE.CircleGeometry(c.radius * 0.45, 24, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xf2b711 }));
      half.position.copy(disc.position).x += 0.0005; half.rotation.y = Math.PI / 2; world.add(half);
      const half2 = half.clone(); half2.rotation.z = Math.PI; world.add(half2);
    }
    return m;
  }
  return null;
}

const MAX_STAINS = 24000;
function go() {
  const S = settings[sceneId];
  const config = { scenario: sceneId, tier, seed: P && P.again ? P.seed : (P ? P.seed + 1 : 1) };
  if (S.liquid) config.liquid = S.liquid;
  if (S.floor) config.floor = S.floor;
  if (S.wall) config.wall = S.wall;
  if (S.knock !== undefined) config.knock_ms = S.knock;
  if (S.fill !== undefined) config.fill_ml = S.fill;
  if (S.height !== undefined) config.height_m = S.height;
  if (S.tilt !== undefined) config.tilt_deg = S.tilt;
  let paneGlazing = -1;
  if (sceneId === 'gunshot') {
    Object.assign(config, { projectile: S.projectile, target: S.target, distance_m: S.distance, pane: S.pane, glazing: S.glazing });
    if (S.pane !== 'none' && G) {
      paneGlazing = gcat.glazings.findIndex((g) => g.id === S.glazing);
      if (paneGlazing >= 0) {
        const g = gcat.glazings[paneGlazing];
        Object.assign(config, { pane_width_m: g.width, pane_height_m: g.height, pane_thickness_mm: g.thickness * 1e3, defer_panes: true });
      }
    }
  }
  const seed = config.seed;
  try { info = L.build(config); } catch (e) { toast('Could not build the scene: ' + e.message); return; }
  clearWorld();
  const d = liquidMaterials(info.liquid);
  liquid = d;
  P = {
    seed, again: false, config, t0: performance.now(), simClock: 0, eventsFrom: 0, stainsFrom: 0, stainList: [],
    colliders: info.colliders, bodies: [], meshesDirty: true, paneGlazing, pane: null, log: [], outcome: '',
    lastBreak: -1, lastSource: -1, bpaAt: -1, bpaStains: -1, recordFps: sceneId === 'gunshot' ? 240 : 60,
  };
  for (const c of info.colliders) {
    const m = addCollider(c);
    if (c.role === 'pane') P.pane = { collider: c, mesh: m, cracks: null, cracksFrom: [], offset: null, collapsed: false, nGlass: 0, shots: 0 };
  }
  // Glass Dynamics pane for the strike.
  if (P.pane && G && paneGlazing >= 0) {
    G.gls_select(0);
    G.gls_new_pane(paneGlazing, Math.min(tier, 3), seed);
    const gs = G.state();
    P.pane.nGlass = gs[2];
    P.pane.cracksFrom = new Array(P.pane.nGlass).fill(0);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 60000), 3));
    geo.setDrawRange(0, 0);
    P.pane.cracks = new THREE.LineSegments(geo, crackMat);
    P.pane.cracks.position.copy(P.pane.mesh.position);
    P.pane.cracks.quaternion.copy(P.pane.mesh.quaternion);
    P.pane.cracks.frustumCulled = false;
    P.pane.crackCount = 0;
    world.add(P.pane.cracks);
  }
  // The liquid.
  P.surface = new THREE.Mesh(new THREE.BufferGeometry(), liquidMat);
  P.surface.castShadow = tier >= 2; P.surface.receiveShadow = true; P.surface.frustumCulled = false;
  world.add(P.surface);
  const st = L.state();
  P.maxDrops = Math.max(2000, cat.tiers[clamp(tier, 0, 4)].drops);
  P.drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), dropMat, P.maxDrops);
  P.drops.count = 0; P.drops.frustumCulled = false;
  world.add(P.drops);
  P.stains = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 20), stainMat, MAX_STAINS);
  P.stains.count = 0; P.stains.frustumCulled = false;
  world.add(P.stains);
  // The round and its tracer.
  P.bullet = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.016, 12), new THREE.MeshStandardMaterial({ color: 0xc89a4a, metalness: 0.9, roughness: 0.25 }));
  P.bullet.visible = false; world.add(P.bullet);
  P.tracer = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.55 }));
  P.tracer.frustumCulled = false; world.add(P.tracer);
  P.woundGroup = new THREE.Group(); world.add(P.woundGroup); P.wounds = 0;
  P.strings = new THREE.LineSegments(new THREE.BufferGeometry(), stringMat);
  P.strings.frustumCulled = false; P.strings.visible = false; world.add(P.strings);
  P.truth = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 8), truthMat); P.truth.visible = false; world.add(P.truth);
  P.guess = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 8), guessMat); P.guess.visible = false; world.add(P.guess);
  P.conv = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.04, 32), guessMat); P.conv.visible = false; world.add(P.conv);
  if (sceneId === 'gunshot') {
    // The muzzle: a small black box where the shot comes from.
    const mz = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.18), new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.7, roughness: 0.4 }));
    const a = new THREE.Vector3(...info.muzzle), b = new THREE.Vector3(...info.aim);
    mz.position.copy(a).addScaledVector(b.clone().sub(a).normalize(), -0.09);
    mz.lookAt(b); world.add(mz);
  }
  L.lqd_record(P.recordFps, 900);
  L.lqd_capture();
  syncBodies();
  $('log').textContent = '';
  $('rWhat').textContent = SCENES.find((s) => s.id === sceneId).name;
  buildBpaSurfaces();
  frameCamera(false);
  const s = L.state();
  banner(SCENES.find((x) => x.id === sceneId).name, `${d.name} · ${TIER_NAMES[tier]} quality · ${(s[8] * 1e3).toFixed(1)} mm particles`);
  scaleNow = auto ? autoTarget() : scaleManual;
  updateReadouts();
}

// ---------- Glass bodies ----------
function syncBodies() {
  const b = L.bodies(), n = b.length / 12;
  for (let i = P.bodies.length; i < n; ++i) {
    const m = L.bodyMesh(i);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const mesh = new THREE.Mesh(geo, sceneId === 'bottle_drop' ? bottleMat : glassMat);
    mesh.castShadow = tier >= 2;
    mesh.renderOrder = 2;
    world.add(mesh);
    P.bodies.push(mesh);
  }
  for (let i = 0; i < n; ++i) {
    const o = 12 * i, mesh = P.bodies[i];
    mesh.position.set(b[o], b[o + 1], b[o + 2]);
    mesh.quaternion.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]);
    mesh.visible = b[o + 7] > 0;
  }
}

// ---------- The liquid, drops and stains ----------
const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S3 = new THREE.Vector3();
const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), B = new THREE.Matrix4();
let meshedAt = -1;
function drawLiquid(t) {
  const st = L.state();
  if (st[2] > 0 && t !== meshedAt) {
    meshedAt = t;
    const m = L.surface(tier <= 0 ? 0.9 : tier === 1 ? 0.75 : 0.6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    P.surface.geometry.dispose();
    P.surface.geometry = g;
  } else if (st[2] === 0 && P.surface.geometry.index) {
    P.surface.geometry.dispose();
    P.surface.geometry = new THREE.BufferGeometry();
  }
  const d = L.drops(), n = Math.min(d.length / 4, P.maxDrops);
  // Drawn no smaller than about a pixel and a half, so fine mist stays visible.
  const px = 1.5 * 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(window.innerHeight, 1);
  for (let i = 0; i < n; ++i) {
    V.set(d[4 * i], d[4 * i + 1], d[4 * i + 2]);
    const r = Math.max(0.5 * d[4 * i + 3], px * camera.position.distanceTo(V) * 0.5);
    M4.compose(V, Q.identity(), S3.set(r, r, r));
    P.drops.setMatrixAt(i, M4);
  }
  P.drops.count = n;
  P.drops.instanceMatrix.needsUpdate = true;
  // New stains: flat ellipses on their surfaces, long axis along the tail.
  const s = L.stains(P.stainsFrom);
  const ns = s.length / 16;
  for (let k = 0; k < ns; ++k) {
    const o = 16 * k;
    P.stainList.push(Array.from(s.subarray(o, o + 16)));
    const slot = P.stains.count < MAX_STAINS ? P.stains.count++ : (P.stainsFrom + k) % MAX_STAINS;
    Z.set(s[o + 3], s[o + 4], s[o + 5]).normalize();
    X.set(s[o + 6], s[o + 7], s[o + 8]);
    X.addScaledVector(Z, -X.dot(Z));
    if (X.lengthSq() < 1e-10) X.set(1, 0, 0).addScaledVector(Z, -Z.x);
    X.normalize();
    Y.crossVectors(Z, X);
    B.makeBasis(X, Y, Z);
    Q.setFromRotationMatrix(B);
    const lift = 0.0005 + (s[o + 14] ? 0.0002 : 0) + 0.00002 * (slot % 7);
    V.set(s[o], s[o + 1], s[o + 2]).addScaledVector(Z, lift);
    M4.compose(V, Q, S3.set(0.5 * s[o + 10], 0.5 * s[o + 9], 1));
    P.stains.setMatrixAt(slot, M4);
  }
  if (ns) { P.stainsFrom += ns; P.stains.instanceMatrix.needsUpdate = true; }
}

function drawRounds(t) {
  const pr = L.projectiles(), n = pr.length / 10;
  P.bullet.visible = false;
  for (let k = 0; k < n; ++k) {
    const o = 10 * k, state = pr[o + 7];
    const path = L.path(k), pts = [];
    for (let i = 0; i < path.length; i += 3) pts.push(new THREE.Vector3(path[i], path[i + 1], path[i + 2]));
    if (state === STATE.FLYING || state === STATE.AT_PANE) {
      pts.push(new THREE.Vector3(pr[o], pr[o + 1], pr[o + 2]));
      P.bullet.visible = true;
      P.bullet.position.set(pr[o], pr[o + 1], pr[o + 2]);
      P.bullet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), V.set(pr[o + 3], pr[o + 4], pr[o + 5]));
    }
    if (pts.length >= 2 && t > pr[o + 8]) P.tracer.geometry.setFromPoints(pts);
  }
  // Wound marks.
  const w = L.wounds(), nw = w.length / 8;
  for (let k = P.wounds; k < nw; ++k) {
    const o = 8 * k;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(w[o + 6] ? 0.012 : 0.006, 16), new THREE.MeshBasicMaterial({ color: lin(liquid.stainColor) }));
    Z.set(w[o + 3], w[o + 4], w[o + 5]);
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), Z);
    disc.position.set(w[o], w[o + 1], w[o + 2]).addScaledVector(Z, 0.001);
    P.woundGroup.add(disc);
  }
  P.wounds = nw;
}

// ---------- Panes: the Glass Dynamics hand-off ----------
const PH_DONE = 4;
function resolvePanes() {
  let strikes = L.strikes();
  let guard = 0;
  while (strikes.length && guard++ < 8) {
    const s = strikes[0];
    if (G && P.pane && P.paneGlazing >= 0) {
      let imp = gcat.impactors.findIndex((x) => x.id === s.impactor);
      if (imp < 0) imp = gcat.impactors.findIndex((x) => x.id === 'pistol_9mm');
      const k = G.state()[3];
      const h = G.gls_fire(imp, s.x, s.y, s.speed, s.yaw, s.pitch, s.fromBack ? 1 : 0, 0.01);
      const which = h >= 0 ? h : k;
      // The strike itself is over within a few hundred microseconds.
      const start = G.gls_time();
      for (let i = 0; i < 400; ++i) {
        G.gls_advance(G.gls_time() + 2e-5, 20000);
        const imps = G.impactors(G.state()[3]);
        if (imps[20 * which + 9] >= PH_DONE || G.gls_time() - start > 0.006) break;
      }
      const rep = G.report(which);
      const gs = G.state();
      const pen = rep.v[11] > 0, out = pen ? rep.v[1] : 0;
      const W = P.pane.collider.half[0] * 2, H = P.pane.collider.half[1] * 2;
      const open = gs[9];
      const hole = clamp(Math.sqrt(Math.max(open, 0) / Math.PI), 0.004, 0.5 * Math.min(W, H));
      L.lqd_resolve_strike(0, pen ? 1 : 0, out, pen ? hole : 0, 0);
      P.pane.offset = s.time - G.gls_time();
      P.pane.shots++;
      P.log.push({ time: s.time, text: `Glass Dynamics: ${rep.outcome}` });
    } else {
      L.lqd_estimate_strike(0);
    }
    strikes = L.strikes();
  }
}
function stepPane(t) {
  const p = P.pane;
  if (!p || !G || p.offset === null) return;
  G.gls_advance(t - p.offset, 3000);
  // New crack segments of every glass ply, in the pane's frame.
  const W = p.collider.half[0] * 2, H = p.collider.half[1] * 2, T = p.collider.half[2];
  const pos = p.cracks.geometry.attributes.position;
  for (let g = 0; g < p.nGlass; ++g) {
    const c = G.cracks(g, p.cracksFrom[g]), n = c.length / 7;
    const z = (g + 0.5) / p.nGlass * 2 * T - T;
    for (let i = 0; i < n && p.crackCount < pos.count / 2; ++i) {
      const o = 7 * i, j = 6 * p.crackCount;
      pos.array.set([c[o] - W / 2, c[o + 1] - H / 2, z, c[o + 2] - W / 2, c[o + 3] - H / 2, z], j);
      ++p.crackCount;
    }
    p.cracksFrom[g] += n;
  }
  p.cracks.geometry.setDrawRange(0, 2 * p.crackCount);
  pos.needsUpdate = true;
  // A crazed tempered pane comes down: the liquid flies through what's left.
  const gs = G.state();
  if (!p.collapsed && gs[8] < 0.5 && gs[9] > 0.3 * W * H) {
    p.collapsed = true;
    L.lqd_collider_enable(p.collider.id, 0);
    p.mesh.material.opacity = 0.05;
    P.log.push({ time: t, text: 'the pane has fallen out of its frame' });
  }
}

// ---------- Stain analysis ----------
function buildBpaSurfaces() {
  const sel = $('bpaSurf');
  sel.innerHTML = '';
  const roles = ['wall', 'floor', 'pane', 'table'];
  for (const c of info.colliders.filter((c) => roles.includes(c.role)).sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role))) {
    const op = document.createElement('option');
    op.value = c.id; op.textContent = c.name[0].toUpperCase() + c.name.slice(1);
    sel.appendChild(op);
  }
  const pref = sceneId === 'gunshot' ? (info.colliders.find((c) => c.role === 'pane' && settings.gunshot.pane === 'behind') || info.colliders.find((c) => c.name === 'back wall'))
    : sceneId === 'angles' ? info.colliders.find((c) => c.name === 'card') : info.colliders.find((c) => c.role === 'floor');
  if (pref) sel.value = pref.id;
  sel.onchange = () => { P.bpaStains = -1; updateBpa(true); };
}
function updateBpa(force = false) {
  const n = P.stainList.length;
  if (!force && (n === P.bpaStains || n === 0)) return;
  P.bpaStains = n;
  const id = +$('bpaSurf').value;
  const onIt = P.stainList.filter((s) => s[13] === id).length;
  if (!onIt) { $('bpaText').textContent = 'No stains on that surface yet.'; P.bpa = null; drawStrings(); return; }
  if (sceneId === 'angles') {
    // The card: each drop's true angle against the one its stain gives.
    const rows = P.stainList.filter((s) => s[13] === id && !s[14]).sort((a, b) => a[11] - b[11]);
    const deg = (a) => (a * 180 / Math.PI).toFixed(1);
    $('bpaText').innerHTML = rows.length
      ? 'True impact angle → read from the stain, asin(width ÷ length):<br>' + rows.map((s) => `<b>${deg(s[11])}°</b> → ${deg(Math.asin(Math.min(1, s[9] / s[10])))}° <span style="color:var(--mute)">(${(s[9] * 1e3).toFixed(1)} × ${(s[10] * 1e3).toFixed(1)} mm)</span>`).join('<br>')
      : 'Waiting for the drops.';
    P.bpa = null;
    drawStrings();
    return;
  }
  const r = L.bpa(id, -1, 0.25, false);
  P.bpa = r;
  if (!r.ok) { $('bpaText').innerHTML = `${onIt} stains. ${r.summary || ''}`; drawStrings(); return; }
  const deg = (a) => (a * 180 / Math.PI).toFixed(1);
  let h = `<b>${r.used}</b> of ${r.considered} stains measurable (read to 0.25 mm). Impact angles from width ÷ length, within <b>${deg(r.meanAngleError)}°</b> of the truth on average.`;
  h += ` Area of convergence: lines miss it by ${(r.convergenceRms * 1e3).toFixed(0)} mm rms.`;
  h += ` Area of origin by the tangent method: <b>${r.height.toFixed(2)} m</b> from the surface (middle half ${r.heightLow.toFixed(2)}–${r.heightHigh.toFixed(2)} m).`;
  if (r.truth) {
    const trueH = r.height - r.heightError;
    h += ` The truth: ${trueH.toFixed(2)} m, ${(r.convergenceError * 1e3).toFixed(0)} mm from the convergence. The strings are <b>${Math.abs(r.heightError * 1e3).toFixed(0)} mm ${r.heightError > 0 ? 'too far out' : 'too close'}</b>${r.heightError > 0.15 ? ' — drops fall in arcs, so straight strings overshoot' : ''}.`;
  }
  $('bpaText').innerHTML = h;
  drawStrings();
}
function drawStrings() {
  const on = stringsOn && P.bpa && P.bpa.ok;
  P.strings.visible = P.truth.visible = P.guess.visible = P.conv.visible = !!on;
  if (!on) return;
  const r = P.bpa, n = new THREE.Vector3(...r.normal), c = new THREE.Vector3(...r.convergence);
  const pts = [];
  for (const l of r.lines) {
    const s = P.stainList[l[0]];
    if (!s) continue;
    // The analyst's string: from the stain, back along its tail, rising at its impact angle.
    pts.push(new THREE.Vector3(s[0], s[1], s[2]), c.clone().addScaledVector(n, l[4]));
  }
  P.strings.geometry.setFromPoints(pts);
  P.guess.position.set(...r.origin);
  P.conv.position.copy(c).addScaledVector(n, 0.002);
  P.conv.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  P.truth.visible = !!r.truth;
  if (r.truth) P.truth.position.set(...r.trueOrigin);
}

// ---------- Clock ----------
let playing = true, auto = store.get('auto', true), scaleManual = store.get('scale', 1), scaleNow = 1;
let msPerStep = 2, limited = false, stringsOn = store.get('strings', false);
function buildScaleButtons() {
  const box = $('scale');
  box.innerHTML = '';
  for (const [s, label] of SCALES) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(!auto && Math.abs(s - scaleManual) < 1e-9));
    b.onclick = () => { auto = false; scaleManual = s; store.set('auto', false); store.set('scale', s); buildScaleButtons(); syncAuto(); };
    box.appendChild(b);
  }
}
function syncAuto() { $('bAuto').setAttribute('aria-pressed', String(auto)); }
// Bullet time: slow for the fast moments, real time for the rest.
function autoTarget() {
  if (!P) return 1;
  const st = L.state(), t = st[0];
  const pr = L.projectiles();
  for (let k = 0; k < pr.length; k += 10) {
    const s = pr[k + 7];
    if (s === STATE.FLYING || s === STATE.AT_PANE || (s === STATE.WAITING && pr[k + 8] - t < 0.004)) return 1e-3;
  }
  let newest = -1;
  for (const e of P.log) newest = Math.max(newest, e.time);
  const sinceShot = pr.length ? t - pr[8] : 1e9;
  if (sinceShot < 0.03) return 0.01;
  if (sinceShot < 0.4) return 0.1;
  // Glassware about to land, or just broken.
  if (P.lastBreak >= 0 && t - P.lastBreak < 0.12) return 0.05;
  const b = L.bodies();
  for (let i = 0; i < b.length; i += 12) {
    if (b[i + 7] > 0 && b[i + 8] < 0 && b[i + 1] < 0.32 && t > 0.15 && !(P.lastBreak >= 0)) {
      return 0.1;
    }
  }
  if (sceneId === 'drip' || sceneId === 'angles') return st[4] < 1 ? 0.25 : 1;
  if (sceneId === 'dam_break') return 0.25;
  return 1;
}
function easeScale(target, dt) {
  if (!auto) { scaleNow = target; return; }
  const lg = Math.log10(scaleNow), lt = Math.log10(target);
  scaleNow = Math.pow(10, lt < lg ? Math.max(lt, lg - dt * 8) : Math.min(lt, lg + dt * 1.2));
}
function fmtTime(t) { return t < 0.1 ? `${(t * 1e3).toFixed(2)} ms` : `${t.toFixed(3)} s`; }
function fmtScale(s) { return s >= 0.95 ? '1× · real time' : `1/${Math.round(1 / s).toLocaleString('en')} speed`; }

// ---------- Readouts ----------
function updateReadouts() {
  if (!P) return;
  const s = L.state();
  const ml = (v) => `${(v * 1e6).toFixed(v < 1e-6 ? 2 : 0)} ml`;
  const kv = [];
  kv.push(['Time', fmtTime(s[0])]);
  kv.push(['Liquid', `${liquid.name}, ${ml(s[11])}`]);
  if (s[2] > 0) kv.push(['Bulk', `${s[2].toLocaleString('en')} particles · ${ml(s[12])}`]);
  kv.push(['In the air', `${s[3].toLocaleString('en')} drops`]);
  kv.push(['Stains', s[4].toLocaleString('en')]);
  if (s[9] > 0) kv.push(['Puddle', `${(s[10] * 1e4).toFixed(0)} cm² now · ${(s[9] * 1e4).toFixed(0)} cm² wetted`]);
  const nb = s[5];
  if (nb > 0) kv.push(['Glass', s[17] > 0 ? `broken · ${nb - 1} pieces` : 'intact']);
  const pr = L.projectiles();
  if (pr.length) kv.push(['Round', pr[7] === STATE.STOPPED ? 'stopped' : `${pr[6].toFixed(0)} m/s`]);
  if (s[23] > 0) kv.push(['Wounds', `${s[23]} · dripping ${ml(s[27])}`]);
  kv.push(['Steps', `${s[7].toLocaleString('en')} · next ${(s[22] * 1e6).toFixed(0)} µs`]);
  $('kv').innerHTML = kv.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  // Where the liquid is.
  const total = Math.max(s[11], 1e-12);
  const parts = [[s[12], '#3a7bd5', 'puddle'], [s[13], '#9fd6ff', 'air'], [s[14], lin(liquid.stainColor).getStyle(), 'stains'], [s[15], '#93a0b2', 'absorbed'], [s[16], '#ef5d4f', 'lost']];
  $('vbar').innerHTML = parts.map(([v, c]) => `<i style="width:${(100 * v / total).toFixed(2)}%;background:${c}"></i>`).join('');
  $('vlegend').innerHTML = parts.filter(([v]) => v > 0).map(([v, c, n]) => `<span class="swatch" style="background:${c}"></span>${n} ${(100 * v / total).toFixed(1)}%`).join(' &nbsp; ');
  // Events.
  const ev = L.events(P.eventsFrom);
  P.eventsFrom += ev.length;
  for (const e of ev) {
    P.log.push(e);
    if (/breaks$/.test(e.text) || e.text.includes('shattered')) P.lastBreak = e.time;
  }
  if (ev.length || P.log.length !== P.logShown) {
    P.log.sort((a, b) => a.time - b.time);
    $('log').textContent = P.log.map((e) => `${fmtTime(e.time).padStart(10)}  ${e.text}`).join('\n');
    $('log').scrollTop = $('log').scrollHeight;
    P.logShown = P.log.length;
  }
  outcome();
  updateBpa();
}
function outcome() {
  const el = $('outcome');
  const txt = P.log.map((e) => e.text);
  let o = 'Running…', cls = '';
  const strike = [...txt].reverse().find((t) => / struck (floor|table|back wall|the)/.test(t) && /P\(break\)/.test(t));
  if (sceneId === 'wine_glass' || sceneId === 'bottle_drop') {
    const broke = txt.find((t) => /-> breaks$/.test(t));
    const pieces = txt.find((t) => t.includes('shattered into'));
    if (broke) { o = broke.replace(/^Bordeaux wine /, 'The ').replace(/ -> breaks$/, '.') + (pieces ? ` It ${pieces.trim().replace(/^shattered/, 'shattered')}.` : ''); cls = 'bad'; }
    else if (strike) { o = strike.replace(/^Bordeaux wine /, 'The ').replace(/ -> holds$/, ' — and it holds.'); cls = 'ok'; }
  } else if (sceneId === 'gunshot') {
    const exit = txt.find((t) => t.startsWith('exit wound'));
    const lodged = txt.find((t) => t.includes('lodged'));
    const stopped = txt.find((t) => t.includes('stopped by the pane'));
    if (stopped) { o = 'The glass stopped the round.'; cls = 'ok'; }
    else if (exit) { o = `Through and through: ${exit.replace('exit wound: ', '')}.`; cls = 'bad'; }
    else if (lodged) { o = `The round ${lodged.replace('round ', '')}.`; cls = 'warn'; }
  } else {
    o = `${L.state()[4]} stains so far.`;
  }
  el.textContent = o;
  el.className = cls;
}

// ---------- Camera ----------
const cam = { tx: 0, ty: 0.5, tz: 0, theta: 0.6, phi: 1.2, r: 2.5 };
let camMode = 0;
const VIEWS = {
  wine_glass: [[0.72, 0.32, 0.05, 1.25, 1.12, 1.65], [0.8, 0.06, 0.05, 1.7, 1.15, 0.95], [0.8, 0.02, 0.05, 0.6, 0.32, 1.25]],
  bottle_drop: [[0, 0.4, 0, 0.7, 1.2, 2.2], [0, 0.08, 0, 0.3, 0.9, 1.4], [0, 0.05, 0, 0, 0.35, 2.0]],
  gunshot: [[0, 1.0, 0.3, 1.45, 1.38, 5.2], [0.0, 1.1, -0.4, 0.65, 1.3, 4.2], [0, 1.3, 1.2, 0.0, 1.45, 3.2], [0, 0.6, -1.4, 0.5, 0.75, 3.0]],
  drip: [[0, 0.4, 0, 0.35, 0.9, 2.6], [0, 0.0, 0, 0, 0.25, 2.0]],
  angles: [[0, 0.95, 0, 0.0, 1.5, 2.5], [0, 0.95, 0, 0.6, 1.2, 2.4]],
  dam_break: [[0.3, 0.12, 0.02, 0.0, 1.45, 0.85], [0.3, 0.1, 0.02, 0.6, 1.1, 0.9]],
};
function frameCamera(keepAngles = true) {
  const v = VIEWS[sceneId] || VIEWS.wine_glass;
  if (!keepAngles) camMode = 0;
  const [tx, ty, tz, th, ph, r] = v[camMode % v.length];
  Object.assign(cam, { tx, ty, tz, theta: th, phi: ph, r: r * Math.max(1, 1.1 / Math.max(camera.aspect, 0.5)) });
  applyCamera();
}
function applyCamera() {
  cam.phi = clamp(cam.phi, 0.08, Math.PI - 0.3);
  cam.r = clamp(cam.r, 0.15, 14);
  const sp = Math.sin(cam.phi);
  camera.position.set(cam.tx + cam.r * sp * Math.sin(cam.theta), cam.ty + cam.r * Math.cos(cam.phi), cam.tz + cam.r * sp * Math.cos(cam.theta));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
}
{
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
      if (pinch && d0 > 0) { cam.r *= d0 / Math.max(d1, 1); applyCamera(); }
      pinch = 1;
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (e.shiftKey || e.buttons === 2) {
      // Pan in the view plane.
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const k = cam.r * 0.0015;
      cam.tx -= (right.x * dx - up.x * dy) * k; cam.ty -= (right.y * dx - up.y * dy) * k; cam.tz -= (right.z * dx - up.z * dy) * k;
    } else {
      cam.theta -= dx * 0.006; cam.phi -= dy * 0.006;
    }
    applyCamera();
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = 0; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.r *= Math.exp(e.deltaY * 0.001); applyCamera(); }, { passive: false });
}

// ---------- UI ----------
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); }
function banner(title, sub) { $('bTitle').textContent = title; $('bSub').textContent = sub; $('banner').classList.add('on'); clearTimeout(banner.h); banner.h = setTimeout(() => $('banner').classList.remove('on'), 2600); }
function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function setupUi() {
  const sel = $('tier');
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  add('auto', `Auto (${TIER_NAMES[bench.tier]})`);
  TIER_NAMES.forEach((n, i) => add(String(i), `${n} · ${(cat.tiers[i].spacing * 1e3).toFixed(1)} mm`));
  sel.value = String(tierChoice);
  sel.onchange = () => {
    tierChoice = sel.value; store.set('tier', tierChoice);
    tier = tierChoice === 'auto' ? bench.tier : +tierChoice;
    toast(`${TIER_NAMES[tier]} quality: the same physics with ${(cat.tiers[tier].spacing * 1e3).toFixed(1)} mm particles`);
    resize(); P.again = true; go();
  };
  $('go').onclick = () => { if (P) P.again = false; go(); };
  $('bReset').onclick = () => { if (P) P.again = true; go(); };
  $('bPlay').onclick = () => { playing = !playing; $('bPlay').textContent = playing ? 'Pause' : 'Play'; $('bPlay').setAttribute('aria-pressed', String(!playing)); };
  $('bAuto').onclick = () => { auto = !auto; store.set('auto', auto); syncAuto(); buildScaleButtons(); };
  $('bStrings').onclick = () => { stringsOn = !stringsOn; store.set('strings', stringsOn); $('bStrings').setAttribute('aria-pressed', String(stringsOn)); drawStrings(); };
  $('bStrings').setAttribute('aria-pressed', String(stringsOn));
  $('bCam').onclick = () => { camMode++; frameCamera(); };
  $('bHelp').onclick = () => $('help').classList.add('on');
  $('bHelpClose').onclick = () => $('help').classList.remove('on');
  $('help').onclick = (e) => { if (e.target === $('help')) $('help').classList.remove('on'); };
  $('xGlb').onclick = () => {
    toast('Writing the glTF… (the liquid is meshed for every recorded frame)');
    setTimeout(() => {
      const bytes = L.exportGlb(true, 1);
      download(bytes, `liquids-${sceneId}-${P.seed}.glb`, 'model/gltf-binary');
      toast(`${(bytes.length / 1e6).toFixed(1)} MB glTF: import into Unreal (Interchange) or Unity (glTFast)`);
    }, 30);
  };
  $('xStains').onclick = () => download(L.exportStains(), `liquids-${sceneId}-${P.seed}-stains.json`, 'application/json');
  $('xPly').onclick = () => download(L.exportPly(), `liquids-${sceneId}-${P.seed}-${(L.lqd_time() * 1e3).toFixed(0)}ms.ply`, 'application/octet-stream');
  // Phone tabs.
  const show = (which) => {
    $('lab').hidden = which !== 'lab'; $('res').hidden = which !== 'res';
    $('tLab').setAttribute('aria-pressed', String(which === 'lab')); $('tRes').setAttribute('aria-pressed', String(which === 'res')); $('tHide').setAttribute('aria-pressed', String(which === 'none'));
    $('tabs').classList.toggle('closed', which === 'none');
  };
  $('tLab').onclick = () => show('lab'); $('tRes').onclick = () => show('res'); $('tHide').onclick = () => show('none');
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); $('go').click(); }
    else if (k === 'r') $('bReset').click();
    else if (k === 'p') $('bPlay').click();
    else if (k === 'a') $('bAuto').click();
    else if (k === 's') $('bStrings').click();
    else if (k === 'c') $('bCam').click();
    else if (k === 'h' || k === '?') $('help').classList.toggle('on');
    else if (k === 'escape') $('help').classList.remove('on');
    else if (k >= '1' && k <= '5') { auto = false; scaleManual = SCALES[+k - 1][0]; buildScaleButtons(); syncAuto(); }
  });
}

// ---------- Frame loop ----------
let last = performance.now(), uiTick = 0;
function physicsBudget(dt) { return clamp(0.5 * dt * 1000, tier <= 1 ? 9 : 12, 45); }
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!P) return;
  easeScale(auto ? autoTarget() : scaleManual, dt);
  if (playing) {
    P.simClock = Math.max(P.simClock, L.lqd_time()) + dt * scaleNow;
    const budget = physicsBudget(dt), t0 = performance.now();
    limited = false;
    for (let pass = 0; pass < 4; ++pass) {
      const left = budget - (performance.now() - t0);
      if (left <= 0) { limited = true; break; }
      const steps = Math.max(1, Math.floor(left / Math.max(msPerStep, 0.02)));
      const a = performance.now();
      const n = L.lqd_advance(P.simClock, steps);
      if (n > 0) msPerStep = 0.8 * msPerStep + 0.2 * ((performance.now() - a) / n);
      L.lqd_capture();
      if (L.state()[20] > 0) { resolvePanes(); continue; }
      if (L.lqd_time() >= P.simClock - 1e-12) break;
      if (n < steps) break;
    }
    if (L.lqd_time() < P.simClock - 1e-9) { limited = true; P.simClock = L.lqd_time(); }
  }
  const t = L.lqd_time();
  syncBodies();
  drawLiquid(t);
  drawRounds(t);
  stepPane(t);
  if ((uiTick += dt) > 0.15) {
    uiTick = 0;
    updateReadouts();
    $('clock').innerHTML = `${fmtTime(t)}<small>${fmtScale(scaleNow)}${auto ? ' · auto' : ''}</small>`;
    $('limit').textContent = limited ? 'device-limited' : '';
  }
  R.render(scene, camera);
}

// ---------- Start ----------
$('sTier').textContent = `${TIER_NAMES[tier]} · ${bench.ms.toFixed(1)} ms/step`;
setupUi();
buildScaleButtons();
syncAuto();
buildSceneButtons();
buildOptions();
resize();
go();
$('loading').remove();
requestAnimationFrame(frame);
