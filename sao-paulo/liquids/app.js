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
  // The liquid core fires a shot load pellet by pellet: give Glass Dynamics one pellet of it.
  const glib = await (await fetch('../glass/library.json')).json();
  const buck = (glib.impactors || []).find((i) => i.id === 'buckshot_00');
  if (buck) {
    const one = { ...buck, id: 'buckshot_00_pellet', name: '00 buck pellet', pellets: 1 };
    for (const k of ['spread_mrad', 'range_m', 'shot_string_m']) delete one[k];
    if (one.provenance) { one.provenance = { ...one.provenance }; for (const k of ['spread_mrad', 'shot_string_m']) delete one.provenance[k]; }
    glib.impactors.push(one);
  }
  const errs = G.load(JSON.stringify(glib));
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
  stainPx.value = 1.3 * 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(h, 1) / 2;
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
// Stains are drawn no smaller than about a pixel and a third (in the vertex
// shader, from each one's distance), so fine spatter shows from across the
// room; up close they are their true size.
const stainPx = { value: 0.002 };
function minPixelSize(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uStainPx = stainPx;
    sh.vertexShader = 'uniform float uStainPx;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  {
    vec3 ctr = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float rw = min(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
    float minR = uStainPx * length(cameraPosition - ctr);
    transformed.xy *= max(1.0, minR / max(rw, 1e-7));
  }
#endif`);
  };
  return mat;
}
// Stains are seen from both sides: through a pane of glass from behind, too.
let stainMat = minPixelSize(new THREE.MeshStandardMaterial({ color: 0x300410, roughness: 0.4, transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }));
// The liquid's colour: its own, or one the viewer picked for it (kept per
// liquid). Only the look: the physics is the liquid's. A picked colour's
// stain is the same colour darkened, as the liquid's own stain is.
const tints = store.get('tints', {});
const SWATCHES = [
  ['#7a0a12', 'Blood red'], ['#2f9e3a', 'Green'], ['#1e4fd6', 'Blue'], ['#6b1fa0', 'Purple'], ['#ff4fa3', 'Pink'],
  ['#e8710a', 'Orange'], ['#d8b31a', 'Gold'], ['#111111', 'Ink black'], ['#f2efe6', 'Milk white'],
];
function liquidColours(d) {
  const t = tints[d.id];
  if (!t) return { color: lin(d.color), stain: lin(d.stainColor) };
  const color = new THREE.Color(t);
  return { color, stain: color.clone().multiplyScalar(0.55) };
}
const woundMat = new THREE.MeshBasicMaterial({ color: 0x300410 });
// Recolour what is on screen now, without running the scene again.
function applyColours() {
  if (!liquid) return;
  const c = liquidColours(liquid);
  liquidMat.color.copy(c.color);
  stainMat.color.copy(c.stain);
  woundMat.color.copy(c.stain);
}
// The liquid a scene's colour applies to: the one picked, or the one it holds.
function sceneLiquidId() {
  return settings[sceneId].liquid || (liquid && liquid.id) || (sceneId === 'gunshot' ? 'stage_blood_green' : 'water');
}
function liquidMaterials(id) {
  const d = cat.liquids.find((x) => x.id === id) || cat.liquids[0];
  const { color: col, stain } = liquidColours(d);
  liquidMat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03,
    transparent: d.opacity < 0.9, opacity: Math.max(0.35, d.opacity), envMapIntensity: 1.3, sheen: 0 });
  dropMat = liquidMat;
  woundMat.color.copy(stain);
  stainMat = minPixelSize(new THREE.MeshStandardMaterial({ color: stain, roughness: 0.45, transparent: true, opacity: 0.9,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
  return d;
}

// ---------- Scenes and their settings ----------
const SCENES = [
  { id: 'wine_glass', name: 'Wine glass off the table', sub: 'Knocked off the edge, onto the floor', opts: ['liquid', 'colour', 'floor', 'knock', 'fill'] },
  { id: 'bottle_drop', name: 'Wine bottle on the floor', sub: 'An open bottle let go from a height', opts: ['liquid', 'colour', 'floor', 'height', 'tilt', 'fill'] },
  { id: 'gunshot', name: 'Crash dummy: the shot', sub: 'Click to aim, fire as often as you like', opts: ['projectile', 'target', 'tness', 'colour', 'pane', 'glazing', 'gap', 'distance', 'ragdoll', 'floor'], feature: true },
  { id: 'drip', name: 'Drip test', sub: 'Passive drops from seven heights', opts: ['liquid', 'colour', 'floor', 'height'] },
  { id: 'angles', name: 'Impact-angle card', sub: 'Drops thrown at a wall from 10° to 90°', opts: ['liquid', 'colour', 'wall'] },
  { id: 'dam_break', name: 'Dam break', sub: 'Martin & Moyce’s water column: the validation case', opts: ['colour'] },
];
// Every glazing of the Glass lab, in its groups.
const GLAZING_GROUPS = { architectural: 'Buildings', automotive: 'Cars', security: 'Bullet-resistant', aviation: 'Aircraft' };
const defaults = {
  wine_glass: { liquid: 'red_wine', floor: 'ceramic_tile', knock: 0.9, fill: 150 },
  bottle_drop: { liquid: 'red_wine', floor: 'ceramic_tile', height: 1.0, tilt: 25, fill: 700 },
  gunshot: { projectile: 'pistol_9mm_fmj', target: 'chest', pane: 'front', glazing: 'annealed_6', gap: 0.6, distance: 3.0, ragdoll: 'off', tness: 3, floor: 'concrete' },
  drip: { liquid: 'stage_blood_green', floor: 'ceramic_tile', height: 2.1 },
  angles: { liquid: 'stage_blood_green', wall: 'painted_drywall' },
  dam_break: {},
};
const settings = store.get('settings', {});
for (const k of Object.keys(defaults)) settings[k] = { ...defaults[k], ...(settings[k] || {}) };
// The ragdoll used to be on by default: start everyone from the new default once.
if (store.get('settingsVersion', 1) < 2) {
  settings.gunshot.ragdoll = 'off';
  store.set('settingsVersion', 2);
  store.set('settings', settings);
}
let sceneId = store.get('scene', 'wine_glass');
if (!SCENES.find((s) => s.id === sceneId)) sceneId = 'wine_glass';

const DIRECTOR_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 27 Q32 2 56 27 L56 31 L8 31 Z" fill="#1b1d22"/><circle cx="32" cy="36" r="21" fill="#f0c39b"/><path d="M11 30 Q32 6 53 30 Q46 22 32 22 Q18 22 11 30 Z" fill="#1b1d22"/><rect x="14" y="31" width="16" height="9" rx="4" fill="#111"/><rect x="34" y="31" width="16" height="9" rx="4" fill="#111"/><rect x="29" y="33" width="6" height="2" fill="#111"/><path d="M23 48 Q32 54 41 48" stroke="#7a3b2e" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="47" cy="46" r="3.2" fill="#3fbf4a"/><circle cx="51.5" cy="41" r="1.7" fill="#3fbf4a"/><circle cx="43" cy="52" r="1.3" fill="#3fbf4a"/><circle cx="18" cy="47" r="1.1" fill="#3fbf4a"/></svg>';
const OPT = {
  liquid: { label: 'Liquid', type: 'select', items: () => cat.liquids.filter((l) => l.id !== 'water' || sceneId !== 'gunshot').map((l) => [l.id, l.name]) },
  floor: { label: 'Floor', type: 'select', items: () => cat.surfaces.filter((s) => ['ceramic_tile', 'oak_floor', 'concrete', 'carpet'].includes(s.id)).map((s) => [s.id, s.name]) },
  wall: { label: 'Wall', type: 'select', items: () => cat.surfaces.filter((s) => ['painted_drywall', 'glass_pane', 'ceramic_tile', 'concrete'].includes(s.id)).map((s) => [s.id, s.name]) },
  projectile: { label: 'Round', type: 'select', items: () => cat.projectiles.map((p) => [p.id, p.pellets > 1 ? `${p.name} · ${p.pellets} × ${(p.mass * 1e3).toFixed(1)} g at ${p.speed.toFixed(0)} m/s` : `${p.name} · ${(p.mass * 1e3).toFixed(1)} g at ${p.speed.toFixed(0)} m/s`]) },
  // 1: realistic, as measured. Up from there: more spatter in bigger, faster
  // drops, more bleeding, and hits that knock a ragdoll about; above 5 the
  // wounds spurt like cut arteries; 11 is Kill Bill.
  tness: { label: 'tarantinoness', type: 'range', min: 1, max: 11, step: 0.5, head: true,
    fmt: (v) => (v <= 1 ? '1 · realistic' : v >= 11 ? '11 · Kill Bill' : `${v % 1 ? v.toFixed(1) : v} · ${v}× the spatter${v > 5 ? ', spurting' : ''}`) },
  colour: { label: 'Colour', type: 'colour' },
  ragdoll: { label: 'The dummy', type: 'select', items: () => [['off', 'Stays standing (fixed)'], ['on', 'Falls when hit (ragdoll)']] },
  target: { label: 'Aim', type: 'select', items: () => [['chest', 'Chest'], ['abdomen', 'Abdomen'], ['shoulder', 'Shoulder'], ['thigh', 'Thigh']] },
  pane: { label: 'Glass', type: 'select', items: () => [['none', 'No glass'], ['front', 'In front: shot through it, spatter back onto it'], ['behind', 'Behind: it catches the forward spatter'], ['both', 'Both sides (a car: windscreen and rear window)']] },
  glazing: { label: 'Glazing', type: 'select', items: () => (gcat ? gcat.glazings.map((g) => [g.id, `${g.name} · ${(g.width * 100).toFixed(0)} × ${(g.height * 100).toFixed(0)} cm`, GLAZING_GROUPS[g.category] || g.category]) : [['annealed_6', '6 mm annealed (estimate)']]),
    show: () => settings.gunshot.pane !== 'none' },
  gap: { label: 'Glass to dummy', type: 'range', min: 0.3, max: 1.5, step: 0.05, fmt: (v) => `${v.toFixed(2)} m`, show: () => settings.gunshot.pane !== 'none' },
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
    if (o.type === 'colour') {
      // Swatches, the liquid's own colour, and any colour at all.
      const id = sceneLiquidId(), d = cat.liquids.find((x) => x.id === id) || cat.liquids[0];
      const f = document.createElement('div');
      f.className = 'field';
      f.innerHTML = `<span>${o.label} <small class="mute">${tints[id] ? 'picked' : 'its own'} · the look only</small></span>`;
      const row = document.createElement('div');
      row.className = 'swatches';
      const pick = (hex) => {
        if (hex) tints[id] = hex; else delete tints[id];
        store.set('tints', tints);
        applyColours();
        buildOptions();
      };
      const own = new THREE.Color().setRGB(d.color[0], d.color[1], d.color[2], THREE.LinearSRGBColorSpace).getHexString();
      const sw = (hex, title, on, cls = '') => {
        const b = document.createElement('button');
        b.className = 'swatch ' + cls;
        b.style.background = hex;
        b.title = title;
        b.setAttribute('aria-label', title);
        b.setAttribute('aria-pressed', String(on));
        return b;
      };
      const ownB = sw('#' + own, `${d.name}'s own colour`, !tints[id], 'own');
      ownB.onclick = () => pick(null);
      row.appendChild(ownB);
      for (const [hex, name] of SWATCHES) {
        if (hex.slice(1) === own) continue;
        const b = sw(hex, name, tints[id] === hex);
        b.onclick = () => pick(hex);
        row.appendChild(b);
      }
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.className = 'swatch custom';
      inp.title = 'Any colour';
      inp.setAttribute('aria-label', 'Any colour');
      inp.value = tints[id] || '#' + own;
      inp.oninput = () => { tints[id] = inp.value; store.set('tints', tints); applyColours(); };
      inp.onchange = () => pick(inp.value);
      row.appendChild(inp);
      f.appendChild(row);
      box.appendChild(f);
    } else if (o.type === 'select') {
      const f = document.createElement('label');
      f.className = 'field';
      f.textContent = o.label;
      const sel = document.createElement('select');
      let group = null;
      for (const [v, t, g] of o.items()) {
        const op = document.createElement('option'); op.value = v; op.textContent = t;
        if (g && (!group || group.label !== g)) { group = document.createElement('optgroup'); group.label = g; sel.appendChild(group); }
        (g ? group : sel).appendChild(op);
      }
      if (![...sel.options].some((op) => op.value === cfg[k])) cfg[k] = sel.options[0]?.value;
      sel.value = cfg[k];
      sel.onchange = () => { cfg[k] = sel.value; store.set('settings', settings); if (k === 'pane' || k === 'liquid') buildOptions(); if (sceneId === 'gunshot' && k !== 'projectile') go(); };
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
      let head = null;
      if (o.head) {
        // A cartoon director, bigger the more of it you want.
        head = document.createElement('div');
        head.className = 'thead';
        head.innerHTML = DIRECTOR_SVG;
        f.classList.add('tslider');
        f.querySelector('span').append(head);
      }
      const size = () => { if (head) head.style.width = head.style.height = `${16 + 40 * (cfg[k] - o.min) / (max - o.min)}px`; };
      size();
      r.oninput = () => { cfg[k] = +r.value; f.querySelector('b').textContent = o.fmt(cfg[k]); size(); store.set('settings', settings); };
      if (sceneId === 'gunshot') r.onchange = () => go();
      f.appendChild(r);
      box.appendChild(f);
    }
  }
  const notes = {
    wine_glass: 'A sideways knock at the bowl tips it over the table edge; whether it breaks depends on what it lands on and how.',
    bottle_drop: 'Bottles are heavier and thicker: they break less easily, and when they do there is far more wine.',
    gunshot: 'Nothing fires until you do: click anything in the room to aim and fire there, then Fire (F) as often as you like, with any round; Follow (T) rides along with it. ' + (G ? 'The glass is broken by Glass Dynamics, and the spatter lands on its pieces and falls with them.' : 'Glass Dynamics did not load: panes use a built-in estimate.'),
    drip: 'A 50 µl drop from 0.3 to the height you set: drip stains are round, and grow with the fall.',
    angles: 'Each drop meets the card at a known angle; read it back from the stain with sin(angle) = width ÷ length.',
    dam_break: 'The classic validation of a free-surface solver; its front is checked against Martin & Moyce (1952) in the tests.',
  };
  $('goNote').textContent = notes[sceneId] || '';
  if (sceneId === 'gunshot') {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '10px';
    row.innerHTML = '<button id="bFire" title="Fire at the aim point (F)" style="flex:1;font-weight:800">Fire</button><button id="bFollow" aria-pressed="false" title="Ride along with the round (T)">Follow the round</button>';
    box.appendChild(row);
    row.querySelector('#bFire').onclick = () => fireShot();
    row.querySelector('#bFollow').onclick = () => setFollow(!follow);
    row.querySelector('#bFollow').setAttribute('aria-pressed', String(follow));
  }
}

// ---------- World and its visuals ----------
const world = new THREE.Group();
scene.add(world);
let info = null, liquid = null;
let P = null;  // the current run's visuals and state

function clearWorld() {
  world.traverse((o) => { if (o.geometry && o !== diceMesh) o.geometry.dispose(); });
  world.clear();
  if (diceMesh) diceMesh.count = 0;
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
    // A group along its own +y about the capsule's centre, so the ragdoll can move it.
    const a = new THREE.Vector3(...c.a), b = new THREE.Vector3(...c.b);
    const len = a.distanceTo(b);
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(c.radius, Math.max(len, 1e-4), 6, 16), dummyMat);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    // Black joint rings, crash-test style.
    if (/upper arm|thigh|forearm|shin/.test(c.name)) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(c.radius * 1.01, c.radius * 0.18, 8, 20), jointMat);
      ring.position.set(0, -len / 2, 0); ring.rotation.x = Math.PI / 2;
      g.add(ring);
    }
    if (c.name === 'head') {
      // The calibration target on the side of the head.
      const disc = new THREE.Mesh(new THREE.CircleGeometry(c.radius * 0.45, 24), new THREE.MeshBasicMaterial({ color: 0x111111 }));
      disc.position.set(c.radius * 1.01, 0, 0); disc.rotation.y = Math.PI / 2; g.add(disc);
      const half = new THREE.Mesh(new THREE.CircleGeometry(c.radius * 0.45, 24, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xf2b711 }));
      half.position.set(c.radius * 1.015, 0, 0); half.rotation.y = Math.PI / 2; g.add(half);
      const half2 = half.clone(); half2.rotation.z = Math.PI; g.add(half2);
    }
    placeCapsule(g, a, b);
    g.userData.collider = c.id;
    world.add(g);
    return g;
  }
  return null;
}

function placeCapsule(g, a, b) {
  g.position.copy(a).add(b).multiplyScalar(0.5);
  const e = b.clone().sub(a);
  if (e.lengthSq() > 1e-12) g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.normalize());
}

const MAX_STAINS = 60000;
const MAX_ROUNDS = 256, TRACERS = 40;  // rounds drawn in flight; the latest rounds' tracers
// Auto quality per scene: the cost of a step grows with the particles, so a
// 700 ml bottle gets coarser particles than a 150 ml glass on the same device.
function sceneTier() {
  if (tierChoice !== 'auto') return +tierChoice;
  const S = settings[sceneId];
  const litres = sceneId === 'wine_glass' || sceneId === 'bottle_drop' ? (S.fill || 150) * 1e-6
    : sceneId === 'dam_break' ? 0.146 * 0.292 * 0.02 : 0;
  if (!litres) return bench.tier;
  for (let t = bench.tier; t > 0; --t) {
    const h = cat.tiers[t].spacing, n = 1.05 * litres / (h * h * h);
    if (bench.ms * n / 2000 <= 4) return t;
  }
  return 0;
}
function go() {
  const S = settings[sceneId];
  if (tierChoice === 'auto') { const t = sceneTier(); if (t !== tier) { tier = t; resize(); } }
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
    Object.assign(config, { projectile: S.projectile, target: S.target, distance_m: S.distance, pane: S.pane, glazing: S.glazing, ragdoll: S.ragdoll === 'on' });
    if (S.pane !== 'none') config.pane_gap_m = S.gap;
    // Nothing fires until the player does.
    config.fire = false;
    config.spatter_boost = clamp(S.tness, 1, 11);
    config.knockback = Math.min(0.25, 0.025 * (config.spatter_boost - 1));
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
  P.capsules = [];
  P.panes = [];
  for (const c of info.colliders) {
    const m = addCollider(c);
    if (c.role === 'dummy') P.capsules.push(m);
    if (c.role === 'pane') P.panes.push({ collider: c, mesh: m, slot: P.panes.length, offset: null, shots: 0 });
  }
  // A Glass Dynamics pane for each, in its own slot.
  if (G && paneGlazing >= 0) for (const p of P.panes) newGlassPane(p, paneGlazing, seed);
  // The liquid.
  P.surface = new THREE.Mesh(new THREE.BufferGeometry(), liquidMat);
  P.surface.castShadow = tier >= 2; P.surface.receiveShadow = true; P.surface.frustumCulled = false;
  world.add(P.surface);
  const st = L.state();
  P.maxDrops = Math.max(2000, cat.tiers[clamp(tier, 0, 4)].drops);
  P.drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), dropMat, P.maxDrops);
  P.drops.count = 0; P.drops.frustumCulled = false;
  world.add(P.drops);
  P.stains = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 14), stainMat, MAX_STAINS);
  P.stains.count = 0; P.stains.frustumCulled = false;
  world.add(P.stains);
  // Every round in flight (each pellet of a shot load), and their tracers.
  P.bullets = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.016, 12), new THREE.MeshStandardMaterial({ color: 0xc89a4a, metalness: 0.9, roughness: 0.25, emissive: 0x6a4a10 }), MAX_ROUNDS);
  P.bullets.count = 0; P.bullets.frustumCulled = false; world.add(P.bullets);
  P.tracer = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.5 }));
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
    P.muzzle = a; P.muzzleMesh = mz; P.aim = b.clone();
    P.aimMark = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.018, 24), new THREE.MeshBasicMaterial({ color: 0xff4b3e, depthTest: false, transparent: true }));
    P.aimMark.renderOrder = 10; P.aimMark.position.copy(b); P.aimMark.lookAt(a); world.add(P.aimMark);
    P.shots = 1;
  }
  L.lqd_record(P.recordFps, 900);
  L.lqd_capture();
  syncBodies();
  $('log').textContent = '';
  $('rWhat').textContent = SCENES.find((s) => s.id === sceneId).name;
  $('sTier').textContent = `${TIER_NAMES[tier]} · ${bench.ms.toFixed(1)} ms/step`;
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
  const d = L.drops(), n = Math.min(d.length / 8, P.maxDrops);
  // Drawn no smaller than about a pixel and a half, so fine mist stays visible,
  // and drawn along their motion over the frame (what a camera's shutter sees),
  // so a flying drop reads as liquid, not a bead.
  const px = 1.5 * 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(window.innerHeight, 1);
  const shutter = 0.5 * (1 / 60) * scaleNow;
  for (let i = 0; i < n; ++i) {
    const o = 8 * i;
    V.set(d[o], d[o + 1], d[o + 2]);
    const r = Math.max(0.5 * d[o + 3], px * camera.position.distanceTo(V) * 0.5);
    X.set(d[o + 4], d[o + 5], d[o + 6]);
    const sp = X.length();
    const stretch = clamp(1 + sp * shutter / r, 1, 14);
    if (sp > 1e-6) Q.setFromUnitVectors(Y.set(0, 1, 0), X.multiplyScalar(1 / sp)); else Q.identity();
    M4.compose(V, Q, S3.set(r / Math.sqrt(stretch * 0.8 + 0.2), r * stretch, r / Math.sqrt(stretch * 0.8 + 0.2)));
    P.drops.setMatrixAt(i, M4);
  }
  // A few hundred particles of liquid (spatter that ran together on a wall,
  // a small puddle) are too few to make a surface: drawn as drops.
  let m = n;
  if (st[2] > 0 && st[2] < 400) {
    const pp = L.particles(), rp = 0.5 * st[8];
    for (let i = 0; i < pp.length / 4 && m < P.maxDrops; ++i) {
      V.set(pp[4 * i], pp[4 * i + 1], pp[4 * i + 2]);
      M4.compose(V, Q.identity(), S3.set(rp, rp, rp));
      P.drops.setMatrixAt(m++, M4);
    }
  }
  P.drops.count = m;
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
  let live = 0;
  const seg = [];
  for (let k = Math.max(0, n - TRACERS); k < n; ++k) {
    const o = 10 * k, state = pr[o + 7];
    if (t <= pr[o + 8]) continue;  // not fired yet
    const path = L.path(k);
    const flying = state === STATE.FLYING || state === STATE.AT_PANE;
    const m = path.length / 3;
    for (let i = 0; i + 1 < m; ++i) seg.push(path[3 * i], path[3 * i + 1], path[3 * i + 2], path[3 * i + 3], path[3 * i + 4], path[3 * i + 5]);
    if (flying && m > 0) seg.push(path[3 * m - 3], path[3 * m - 2], path[3 * m - 1], pr[o], pr[o + 1], pr[o + 2]);
  }
  for (let k = 0; k < n && live < MAX_ROUNDS; ++k) {
    const o = 10 * k, state = pr[o + 7];
    if (state !== STATE.FLYING && state !== STATE.AT_PANE) continue;
    V.set(pr[o], pr[o + 1], pr[o + 2]);
    Q.setFromUnitVectors(Y.set(0, 1, 0), X.set(pr[o + 3], pr[o + 4], pr[o + 5]));
    M4.compose(V, Q, S3.set(1, 1, 1));
    P.bullets.setMatrixAt(live++, M4);
  }
  P.bullets.count = live;
  P.bullets.instanceMatrix.needsUpdate = true;
  P.tracer.geometry.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  P.flying = live;
  // The ragdoll.
  const rd = L.dummy();
  if (rd.length && P.capsules) {
    for (let k = 0; k < rd.length / 7 && k < P.capsules.length; ++k)
      placeCapsule(P.capsules[k], V.set(rd[7 * k], rd[7 * k + 1], rd[7 * k + 2]), X.set(rd[7 * k + 3], rd[7 * k + 4], rd[7 * k + 5]));
  }
  // Stains riding on something that moved: the dummy, pieces of glass.
  const ms = L.movedStains();
  for (let i = 0; i < ms.length / 11; ++i) {
    const o = 11 * i, k = ms[o];
    const st = P.stainList[k];
    if (!st || k >= MAX_STAINS) continue;
    if (ms[o + 10]) { M4.makeScale(0, 0, 0); P.stains.setMatrixAt(k, M4); continue; }  // gone with the glass
    Z.set(ms[o + 4], ms[o + 5], ms[o + 6]).normalize();
    X.set(ms[o + 7], ms[o + 8], ms[o + 9]); X.addScaledVector(Z, -X.dot(Z));
    if (X.lengthSq() < 1e-10) X.set(1, 0, 0).addScaledVector(Z, -Z.x);
    X.normalize(); Y.crossVectors(Z, X); B.makeBasis(X, Y, Z); Q.setFromRotationMatrix(B);
    V.set(ms[o + 1], ms[o + 2], ms[o + 3]).addScaledVector(Z, 0.0006);
    M4.compose(V, Q, S3.set(0.5 * st[10], 0.5 * st[9], 1));
    P.stains.setMatrixAt(k, M4);
  }
  if (ms.length) P.stains.instanceMatrix.needsUpdate = true;
  // Wound marks (they move with the dummy).
  const w = L.wounds(), nw = w.length / 8;
  for (let k = 0; k < Math.min(P.wounds, nw); ++k) {
    const o = 8 * k, disc = P.woundGroup.children[k];
    if (!disc) continue;
    Z.set(w[o + 3], w[o + 4], w[o + 5]);
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), Z);
    disc.position.set(w[o], w[o + 1], w[o + 2]).addScaledVector(Z, 0.001);
  }
  for (let k = P.wounds; k < nw; ++k) {
    const o = 8 * k;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(w[o + 6] ? 0.012 : 0.006, 16), woundMat);
    Z.set(w[o + 3], w[o + 4], w[o + 5]);
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), Z);
    disc.position.set(w[o], w[o + 1], w[o + 2]).addScaledVector(Z, 0.001);
    P.woundGroup.add(disc);
  }
  P.wounds = nw;
}

// ---------- Panes: the Glass Dynamics hand-off ----------
const PH_DONE = 4;
// The pieces of a broken pane, drawn as one mesh: each piece's outline extruded
// to its thickness, moved on the CPU to where Glass Dynamics says it is.
const pieceMat = new THREE.MeshPhysicalMaterial({ color: 0xd6ebff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.32,
  side: THREE.DoubleSide, envMapIntensity: 1.5, clearcoat: 1, depthWrite: false, vertexColors: true });
class PieceView {
  constructor(pane) {
    this.pane = pane;
    this.recs = [];
    this.nVerts = 0;
    this.cap = 0;
    this.geo = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geo, pieceMat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    pane.group.add(this.mesh);
  }
  add(shapes) {
    for (const sh of shapes) {
      const n = sh.outline.length / 2;
      if (n < 3) continue;
      // A hair smaller about the centroid, so the cracks between pieces show.
      let rmax = 0;
      for (let i = 0; i < n; ++i) rmax = Math.max(rmax, Math.hypot(sh.outline[2 * i], sh.outline[2 * i + 1]));
      const k = rmax > 0 ? Math.max(0.6, 1 - 0.0005 / rmax) : 1;
      const pts = [];
      for (let i = 0; i < n; ++i) pts.push(new THREE.Vector2(sh.outline[2 * i] * k, sh.outline[2 * i + 1] * k));
      const holes = (sh.holes || []).map((h) => { const l = []; for (let i = 0; i + 1 < h.length; i += 2) l.push(new THREE.Vector2(h[i], h[i + 1])); return l; }).filter((l) => l.length >= 3);
      let tris = [];
      try { tris = THREE.ShapeUtils.triangulateShape(pts, holes); } catch { tris = []; }
      const all = pts.concat(...holes), h = sh.thickness / 2;
      const v = [], nr = [], col = [];
      const face = sh.chip ? [0.9, 0.95, 0.95] : [0.92, 0.97, 1.0], edge = [0.45, 0.78, 0.66];
      const push = (x, y, z, nx, ny, nz, c) => { v.push(x, y, z); nr.push(nx, ny, nz); col.push(c[0], c[1], c[2]); };
      for (const [a, b, c] of tris) {
        const A = all[a], Bv = all[b], C = all[c];
        push(A.x, A.y, -h, 0, 0, -1, face); push(C.x, C.y, -h, 0, 0, -1, face); push(Bv.x, Bv.y, -h, 0, 0, -1, face);
        push(A.x, A.y, h, 0, 0, 1, face); push(Bv.x, Bv.y, h, 0, 0, 1, face); push(C.x, C.y, h, 0, 0, 1, face);
      }
      for (const loop of [pts, ...holes]) for (let i = 0; i < loop.length; ++i) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey) || 1, nx = ey / l, ny = -ex / l;
        push(a.x, a.y, -h, nx, ny, 0, edge); push(b.x, b.y, -h, nx, ny, 0, edge); push(b.x, b.y, h, nx, ny, 0, edge);
        push(a.x, a.y, -h, nx, ny, 0, edge); push(b.x, b.y, h, nx, ny, 0, edge); push(a.x, a.y, h, nx, ny, 0, edge);
      }
      this.recs[sh.index] = { start: this.nVerts, count: v.length / 3, local: new Float32Array(v), localN: new Float32Array(nr), col: new Float32Array(col), key: '' };
      this.nVerts += v.length / 3;
    }
    if (this.nVerts > this.cap) {
      const cap = Math.max(4096, 1 << Math.ceil(Math.log2(this.nVerts)));
      const grow = (name) => {
        const a = new Float32Array(cap * 3);
        if (this.cap) a.set(this.geo.attributes[name].array.subarray(0, this.cap * 3));
        this.geo.setAttribute(name, new THREE.BufferAttribute(a, 3));
      };
      grow('position'); grow('normal'); grow('color');
      this.cap = cap;
    }
    const col = this.geo.attributes.color.array;
    for (const r of this.recs) if (r && !r.colored) { col.set(r.col, r.start * 3); r.colored = true; }
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, this.nVerts);
  }
  // poses: 12 floats per piece in Glass Dynamics' pane frame (pos, quat wxyz, vel, state, born).
  update(poses, n, laminate) {
    const p = this.pane, pos = this.geo.attributes.position.array, nor = this.geo.attributes.normal.array;
    const q = new THREE.Quaternion(), t = new THREE.Vector3(), a = new THREE.Vector3();
    let dirty = false;
    for (let i = 0; i < n; ++i) {
      const r = this.recs[i];
      if (!r) continue;
      const o = 12 * i, state = poses[o + 10];
      // A laminate's cracked glass stays on its interlayer: only loose pieces are drawn on their own.
      const shown = state !== -1 && !(laminate && state < 2);
      const key = shown ? `${poses[o]},${poses[o + 1]},${poses[o + 2]},${poses[o + 3]},${poses[o + 4]},${poses[o + 5]},${poses[o + 6]}` : 'hidden';
      if (key === r.key) continue;
      r.key = key;
      dirty = true;
      if (!shown) { pos.fill(0, r.start * 3, (r.start + r.count) * 3); continue; }
      // Glass Dynamics' frame to the pane's: z is reflected.
      t.set(poses[o] - p.W / 2, poses[o + 1] - p.H / 2, p.T / 2 - poses[o + 2]);
      q.set(-poses[o + 4], -poses[o + 5], poses[o + 6], poses[o + 3]).normalize();
      for (let k = 0; k < r.count; ++k) {
        const j = (r.start + k) * 3;
        a.set(r.local[3 * k], r.local[3 * k + 1], r.local[3 * k + 2]).applyQuaternion(q).add(t);
        pos[j] = a.x; pos[j + 1] = a.y; pos[j + 2] = a.z;
        a.set(r.localN[3 * k], r.localN[3 * k + 1], r.localN[3 * k + 2]).applyQuaternion(q);
        nor[j] = a.x; nor[j + 1] = a.y; nor[j + 2] = a.z;
      }
    }
    if (dirty) { this.geo.attributes.position.needsUpdate = true; this.geo.attributes.normal.needsUpdate = true; }
  }
}
function newGlassPane(p, glazing, seed) {
  G.gls_select(p.slot);
  G.gls_new_pane(glazing, Math.min(tier, 3), seed + 7919 * p.slot);
  // Its pieces fall to the floor below the pane.
  G.gls_set_floor(-(p.collider.pos[1] - p.collider.half[1]));
  const gs = G.state();
  Object.assign(p, { nGlass: gs[2], W: gs[14], H: gs[15], T: gs[13], cracksFrom: new Array(gs[2]).fill(0), crackCount: 0,
    fragShapes: 0, revision: -1, loose: 0, pieces: 0 });
  const pl = G.plies(p.nGlass);
  p.plies = [];
  for (let k = 0; k < p.nGlass; ++k) p.plies.push({ z0: pl[12 * k], ply: pl[12 * k + 10] });
  p.plies.sort((a, b) => a.z0 - b.z0);
  const g = gcat.glazings[glazing];
  p.laminate = !(g.plies.length === 1);
  p.group = new THREE.Group();
  p.group.position.copy(p.mesh.position);
  p.group.quaternion.copy(p.mesh.quaternion);
  world.add(p.group);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 60000), 3));
  geo.setDrawRange(0, 0);
  p.cracks = new THREE.LineSegments(geo, crackMat);
  p.cracks.frustumCulled = false;
  p.group.add(p.cracks);
  p.view = new PieceView(p);
  p.sprays = 0;
}
// Tempered pieces crumble into dice where they land: a handful of real-size
// dice round each spray Glass Dynamics reports, on the floor.
const MAX_DICE = 12000;
let diceMesh = null;
function addDice(p) {
  const s = G.state();
  if (s[24] <= p.sprays) return;
  if (!diceMesh) {
    diceMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhysicalMaterial({ color: 0xcfe6e0, roughness: 0.15, transparent: true, opacity: 0.6, clearcoat: 1, envMapIntensity: 1.3 }), MAX_DICE);
    diceMesh.count = 0; diceMesh.frustumCulled = false; diceMesh.receiveShadow = true;
  }
  if (diceMesh.parent !== world) world.add(diceMesh);
  const rows = G.sprays(p.sprays);
  for (let o = 0; o + 14 < rows.length; o += 15) {
    const n = Math.min(rows[o + 6], 24), size = Math.max(rows[o + 7], 0.004), th = rows[o + 8];
    // Where it comes to rest: thrown on along the floor a little way.
    V.set(rows[o] - p.W / 2 + rows[o + 3] * 0.04, 0, p.T / 2 - rows[o + 2] - rows[o + 5] * 0.04);
    p.group.localToWorld(V);
    for (let k = 0; k < n && diceMesh.count < MAX_DICE; ++k) {
      const r = 0.04 * Math.sqrt(Math.random()), a = 2 * Math.PI * Math.random();
      X.set(V.x + r * Math.cos(a), th / 2 + 0.0005, V.z + r * Math.sin(a));
      Q.setFromAxisAngle(Y.set(0, 1, 0), 2 * Math.PI * Math.random());
      M4.compose(X, Q, S3.set(size * (0.7 + 0.6 * Math.random()), th, size * (0.7 + 0.6 * Math.random())));
      diceMesh.setMatrixAt(diceMesh.count++, M4);
    }
  }
  diceMesh.instanceMatrix.needsUpdate = true;
  p.sprays = s[24];
}
function paneOf(collider) { return P.panes.find((p) => p.collider.id === collider); }
function resolvePanes() {
  let strikes = L.strikes();
  let guard = 0;
  while (strikes.length && guard++ < 16) {
    const s = strikes[0];
    const pane = paneOf(s.collider);
    if (G && pane && pane.view && P.paneGlazing >= 0) {
      let imp = gcat.impactors.findIndex((x) => x.id === s.impactor);
      if (imp < 0) imp = gcat.impactors.findIndex((x) => x.id === 'pistol_9mm');
      G.gls_select(pane.slot);
      // One pane for every strike: bring its clock to the strike's moment first.
      if (pane.offset === null) pane.offset = s.time - G.gls_time();
      else G.gls_advance(Math.max(G.gls_time(), s.time - pane.offset), 200000);
      const k = G.state()[3], openBefore = G.state()[9];
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
      const W = pane.collider.half[0] * 2, H = pane.collider.half[1] * 2;
      const open = gs[9] - openBefore;  // what this strike opened
      // A monolithic pane's hole is the pieces that left it; a laminate's is the tear in its interlayer.
      const hole = clamp(Math.sqrt(Math.max(open, 0) / Math.PI), 0.004, 0.5 * Math.min(W, H));
      L.lqd_resolve_strike(0, pen ? 1 : 0, out, pen ? (pane.laminate ? hole : Math.min(hole, 0.6 * gcat.impactors[imp].radius * 2 + 0.004)) : 0, 0);
      pane.shots++;
      feedPieces(pane);
      P.log.push({ time: s.time, text: `Glass Dynamics${P.panes.length > 1 ? ` (${pane.collider.name})` : ''}: ${rep.outcome}` });
    } else {
      L.lqd_estimate_strike(0);
    }
    strikes = L.strikes();
  }
}
// Hands a pane's pieces to the liquid core: new pieces, the map of which piece
// each cell holds (when the pieces change), and where every piece is now.
function feedPieces(p) {
  const s = G.state(), nFrag = s[4];
  if (nFrag > p.fragShapes) {
    const shapes = G.fragmentShapes(p.fragShapes);
    for (const sh of shapes) L.panePiece(p.collider.id, sh);
    p.view.add(shapes);
    p.fragShapes = nFrag;
  }
  if (nFrag > 0 && s[5] !== p.revision) {
    p.revision = s[5];
    const pl = G.plies(p.nGlass);
    const front = G.fragmentMap(p.plies[0].ply), back = p.plies.length > 1 ? G.fragmentMap(p.plies[p.plies.length - 1].ply) : null;
    const k = Math.max(0, [...Array(p.nGlass).keys()].find((i) => pl[12 * i + 10] === p.plies[0].ply) ?? 0);
    if (front.nx > 0) L.paneMap(p.collider.id, pl[12 * k + 3], front, back && back.nx === front.nx && back.ny === front.ny ? back : null, p.laminate);
  }
  if (nFrag > 0) {
    const poses = G.fragmentPoses(nFrag);
    L.panePoses(p.collider.id, poses, nFrag);
    p.view.update(poses, nFrag, p.laminate);
    let loose = 0;
    for (let i = 0; i < nFrag; ++i) if (poses[12 * i + 10] >= 2) ++loose;
    p.loose = loose; p.pieces = nFrag;
  }
  // A monolithic pane in pieces is drawn as its pieces; its cracks stay drawn
  // while most of it is still in the frame.
  const pl = G.plies(p.nGlass);
  if (!p.laminate && pl[4] > 0 && p.mesh.visible) p.mesh.visible = false;
  if (p.cracks.visible && s[9] > 0.3 * p.W * p.H) p.cracks.visible = false;
}
function stepPane(t) {
  if (!G || !P.panes) return;
  for (const p of P.panes) if (p.view && p.offset !== null) stepOnePane(p, t);
}
function stepOnePane(p, t) {
  G.gls_select(p.slot);
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
  feedPieces(p);
  addDice(p);
  const gs = G.state();
  if (!p.fellOut && gs[8] < 0.5 && gs[9] > 0.3 * W * H) {
    p.fellOut = true;
    P.log.push({ time: t, text: `the ${p.collider.name} has fallen out of its frame` });
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
  const pane = settings.gunshot.pane;
  const pref = sceneId === 'gunshot' ? (info.colliders.find((c) => c.role === 'pane' && (pane === 'behind' || pane === 'front' || c.name === 'back pane')) || info.colliders.find((c) => c.name === 'back wall'))
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

// ---------- Aim, fire, follow ----------
let follow = store.get('follow', false), followCam = null;
function setFollow(on) {
  follow = on; store.set('follow', on);
  const b = $('bFollow'); if (b) b.setAttribute('aria-pressed', String(on));
  if (!on && followCam) { Object.assign(cam, followCam); followCam = null; applyCamera(); }
}
function fireShot() {
  if (!P || sceneId !== 'gunshot' || !P.muzzle) return;
  const k = cat.projectiles.findIndex((p) => p.id === settings.gunshot.projectile);
  const d = P.aim.clone().sub(P.muzzle);
  L.lqd_shoot(Math.max(0, k), P.muzzle.x, P.muzzle.y, P.muzzle.z, d.x, d.y, d.z, 0, 0.002);
  P.shots++;
  P.lastShot = L.lqd_time();
  if (auto) scaleNow = Math.min(scaleNow, 0.01);
  toast(`Shot ${P.shots}`);
}
function aimAt(clientX, clientY) {
  if (!P || sceneId !== 'gunshot' || !P.muzzle) return false;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const targets = [];
  world.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o !== P.surface && o !== P.aimMark && o !== P.muzzleMesh && o.visible) targets.push(o); });
  const hit = ray.intersectObjects(targets, false)[0];
  if (!hit) return false;
  P.aim.copy(hit.point);
  P.aimMark.position.copy(hit.point);
  P.aimMark.lookAt(P.muzzle);
  P.muzzleMesh.lookAt(hit.point);
  return true;
}
function followRound() {
  if (!follow || !P) return;
  const pr = L.projectiles();
  let best = -1;
  for (let k = 0; k < pr.length; k += 10) if (pr[k + 7] === STATE.FLYING || pr[k + 7] === STATE.AT_PANE) { best = k; break; }
  if (best < 0) {
    if (followCam && L.lqd_time() - (P.lastShot ?? 0) > 0.05) { Object.assign(cam, followCam); followCam = null; applyCamera(); }
    return;
  }
  if (!followCam) followCam = { ...cam };
  const pos = new THREE.Vector3(pr[best], pr[best + 1], pr[best + 2]), dir = new THREE.Vector3(pr[best + 3], pr[best + 4], pr[best + 5]);
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  // Beside and a little behind the round, looking along its path: the round,
  // and what it is about to hit, both in view.
  camera.position.copy(pos).addScaledVector(dir, -0.45).addScaledVector(side, 0.55).add(new THREE.Vector3(0, 0.12, 0));
  camera.lookAt(pos.clone().addScaledVector(dir, 0.12));
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
  let lastLaunch = -1;
  for (let k = 0; k < pr.length; k += 10) lastLaunch = Math.max(lastLaunch, pr[k + 8]);
  const sinceShot = lastLaunch >= 0 ? t - lastLaunch : 1e9;
  if (sinceShot < 0.03) return 0.01;
  if (sinceShot < 0.4) return 0.1;
  // Glassware about to land, or just broken.
  if (P.lastBreak >= 0 && t - P.lastBreak < 0.08) return 0.1;
  if (P.lastBreak >= 0 && t - P.lastBreak < 0.3) return 0.35;
  // Glassware about to land: slow only for the last few hundredths of a second.
  const b = L.bodies();
  if (P.lastBreak < 0 && P.prevBodies) {
    for (let i = 0; i < b.length; i += 12) {
      if (b[i + 7] <= 0 || b[i + 8] >= 0) continue;
      const vy = (b[i + 1] - P.prevBodies[i + 1]) / Math.max(t - P.prevBodiesT, 1e-6);
      const h = b[i + 1] - 0.12;
      if (vy < -0.5 && h / -vy < 0.04) { P.prevBodies = b.slice(); P.prevBodiesT = t; return 0.1; }
    }
  }
  if (!P.prevBodies || t - P.prevBodiesT > 0.01) { P.prevBodies = b.slice(); P.prevBodiesT = t; }
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
  if (pr.length) {
    let live = -1;
    for (let k = 0; k < pr.length; k += 10) if (pr[k + 7] === STATE.FLYING || pr[k + 7] === STATE.AT_PANE) live = k;
    const n = pr.length / 10;
    kv.push([n > 1 ? `Rounds (${n})` : 'Round', live < 0 ? 'all stopped' : `${pr[live + 6].toFixed(0)} m/s in flight`]);
  }
  if (s[23] > 0) kv.push(['Wounds', `${s[23]} · dripping ${ml(s[27])}`]);
  if (P.panes && P.panes.some((p) => p.view)) {
    const panes = new Set(P.panes.map((p) => p.collider.id)), nStatic = info.colliders.length;
    let onGlass = 0, falling = 0;
    for (const st of P.stainList) {
      if (st[13] >= nStatic) { ++onGlass; ++falling; } else if (panes.has(st[13])) ++onGlass;
    }
    kv.push(['Glass', P.panes.filter((p) => p.view).map((p) => (p.pieces ? `${p.pieces.toLocaleString('en')} pieces, ${p.loose.toLocaleString('en')} loose` : p.shots ? 'cracked' : 'intact')).join(' · ')]);
    if (onGlass) kv.push(['On the glass', `${onGlass.toLocaleString('en')} stains${falling ? ` · ${falling.toLocaleString('en')} landed on falling pieces` : ''}`]);
  }
  kv.push(['Steps', `${s[7].toLocaleString('en')} · next ${(s[22] * 1e6).toFixed(0)} µs`]);
  $('kv').innerHTML = kv.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  // Where the liquid is.
  const total = Math.max(s[11], 1e-12);
  const parts = [[s[12], '#3a7bd5', 'puddle'], [s[13], '#9fd6ff', 'air'], [s[14], liquidColours(liquid).stain.getStyle(), 'stains'], [s[15], '#93a0b2', 'absorbed'], [s[16], '#ef5d4f', 'lost']];
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
    if (!L.projectiles().length) { o = 'Ready. Click anything to aim and fire there, or press F.'; cls = ''; }
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
  let v = VIEWS[sceneId] || VIEWS.wine_glass;
  if (sceneId === 'gunshot' && info) {
    // The glass seen from the dummy's side: where the spatter lands on it.
    const extra = [];
    for (const c of info.colliders.filter((k) => k.role === 'pane'))
      extra.push(c.pos[2] > 0 ? [c.pos[0], c.pos[1] - 0.1, c.pos[2], 2.3, 1.2, 0.85] : [c.pos[0], c.pos[1] - 0.1, c.pos[2], 0.85, 1.2, 0.85]);
    v = [v[0], ...extra, ...v.slice(1)];
  }
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
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('click', (e) => {
    // A click (not a drag) in the shot scene aims there and fires.
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 400) return;
    if (aimAt(e.clientX, e.clientY)) fireShot();
  });
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
    else if (k === 'f') fireShot();
    else if (k === 't') setFollow(!follow);
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
  followRound();
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
// For the browser console: the engines and the current run.
window.liquidsLab = { L, G, get run() { return P; }, get msPerStep() { return msPerStep; } };
