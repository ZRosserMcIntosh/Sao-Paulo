// São Paulo World · Glass Lab.
// Physics: the Glass Dynamics fracture core (C++, MIT) compiled to WebAssembly.
// Rendering: three.js (MIT), or a flat canvas front view where WebGL is missing.
// This file only draws what the core returns and reads input: every crack,
// fragment and force comes from the core.
import * as THREE from 'three';
import { createEngine, wasmFile } from './engine_rpc.js';
import { createGTScene } from './scene_gt.js';
import { createHouseScene } from './scene_house.js';
import { paneLoad, fragmentsThrough, mulberry32, createBlastFX } from './blast.js';
import { GlassAudio, glassProfile } from './glass_audio.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('spw-glass:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spw-glass:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const FLOOR = 0.9;  // m from the floor to the pane's bottom edge
const SCALES = [[1, '1×'], [0.1, '1/10'], [0.01, '1/100'], [1e-3, '1/1k'], [1e-4, '1/10k'], [1e-5, '1/100k']];
const TIER_NAMES = ['Potato', 'Low', 'Medium', 'High', 'Ultra'];
const PH = { FLIGHT: 0, CONTACT: 1, BALLISTIC: 2, MEMBRANE: 3, DONE: 4 };
const KIND = { SPHERE: 0, SHARP: 1, FLAT: 2, PROJECTILE: 3, SOFT: 4 };
const CAT_LABEL = { architectural: 'Buildings', automotive: 'Cars', aviation: 'Aircraft', security: 'Bullet-resistant',
  test: 'Test standards', everyday: 'Everyday', tool: 'Tools', weather: 'Weather', ballistic: 'Firearms', explosive: 'Explosives', artillery: 'Artillery', debris: 'Debris' };

// ---------- Engine ----------
let G, cat;
try {
  // The engine and its library must match: revalidate both on every load, so a
  // browser never pairs a cached engine with a newer library after a deploy.
  G = await createEngine();
  const errs = G.load(await (await fetch('library.json', { cache: 'no-cache' })).text());
  if (errs.length) throw new Error(errs.join('; '));
  cat = G.catalog();
} catch (e) {
  $('loadMsg').textContent = 'Could not start the fracture engine in this browser: ' + e.message;
  throw e;
}

// ---------- Device tier ----------
// The tier is how the lab draws: resolution, shadows, materials, how many
// real dice it shows. The physics is the same on every device (PHYS): a slow
// one takes longer over it (the clock waits for it) rather than computing
// something coarser, so a pane breaks the same way everywhere.
const PHYS = 3;
function benchmark() {
  let ms;
  if (G.remote) ms = G.bench(70);
  else {
    G.gls_bench(2);  // warm the JIT
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 70 && n < 400) { G.gls_bench(2); n += 2; }
    ms = (performance.now() - t0) / Math.max(1, n);
  }
  let t = ms <= 0.4 ? 3 : ms <= 0.8 ? 2 : ms <= 1.6 ? 1 : 0;
  const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 4;
  if (cores <= 2 || mem <= 2) t = Math.min(t, 1);
  if (mem < 1) t = 0;
  return { tier: t, ms };
}
const bench = benchmark();
let tierChoice = store.get('tier', 'auto');
let tier = tierChoice === 'auto' ? bench.tier : +tierChoice;

// ---------- Renderer ----------
const canvas = $('view'), canvas2d = $('view2d');
// A software rasteriser (no GPU) costs the frame most of its time: go light.
function probeSoftwareGL() {
  try {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch { return false; }
}
const softwareGL = probeSoftwareGL();
let R = null;
try {
  // Multisampling on every real GPU: phones resolve it on the chip, nearly free.
  if (!new URLSearchParams(location.search).has('flat'))
    R = new THREE.WebGLRenderer({ canvas, antialias: !softwareGL, powerPreference: 'high-performance', alpha: false });
} catch { R = null; }
const flat = !R;
if (softwareGL && tierChoice === 'auto') { bench.tier = Math.min(bench.tier, 1); tier = bench.tier; }
if (flat) { canvas.style.display = 'none'; canvas2d.style.display = 'block'; }
const ctx2d = flat ? canvas2d.getContext('2d') : null;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b111b);
scene.fog = new THREE.Fog(0x0b111b, 9, 26);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 60);

// Resolution: every tier draws at least one pixel per screen pixel (a
// software rasteriser less); resScale trades it down while frames are slow
// and back up when they are quick again.
let resScale = 1;
function pixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  const base = [Math.min(dpr, 1), Math.min(dpr, 1.25), Math.min(dpr, 1.5), Math.min(dpr, 2), Math.min(dpr, 2)][tier];
  return (softwareGL ? Math.min(base, 0.75) : base) * resScale;
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (R) { R.setPixelRatio(pixelRatio()); R.setSize(w, h, false); }
  else { const d = Math.min(window.devicePixelRatio || 1, 2); canvas2d.width = w * d; canvas2d.height = h * d; }
  camera.aspect = w / h;
  // On phones the bench sheet covers the lower part: centre the view above it.
  if (w <= 860 && !activeScene()) camera.setViewOffset(w, h, 0, h * 0.2, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  if (activeScene()) activeScene().frameCamera();
}

let glassMat, fragMat, frameMat;
const labObjects = [];  // the test hall: hidden when a scene takes over
let GT = null;          // the armoured-car scene (3D only)
let HS = null;          // the grenade-house scene (3D only)
let physCap = null;     // a scene's own physics standard, where it must run many panes or shots at once
// Sound, synthesized from what the engine reports; browsers start it on the first gesture.
const sound = new GlassAudio();
// On unless the visitor turned it off (a new key: the sound was reworked).
sound.enabled = store.get('sound:v3', true);
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => sound.start(), { capture: true });
if (R) {
  R.outputColorSpace = THREE.SRGBColorSpace;
  R.toneMapping = THREE.ACESFilmicToneMapping;
  R.toneMappingExposure = 1.05;
  R.shadowMap.enabled = tier >= 3;
  R.shadowMap.type = THREE.PCFSoftShadowMap;
  // A studio environment for reflections: gradient dome and two soft boxes.
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'varying vec3 vp; void main(){ float h = normalize(vp).y; vec3 c = mix(vec3(0.05,0.06,0.08), vec3(0.55,0.62,0.72), smoothstep(-0.2,0.9,h)); gl_FragColor = vec4(c,1.); }',
  }));
  env.add(dome);
  for (const [x, y, z, w, h, k] of [[-4, 4, 3, 4, 2.5, 6], [5, 2.5, -2, 2, 4, 4], [0, 6, -4, 6, 1, 3]]) {
    const box = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide }));
    box.position.set(x, y, z);
    box.lookAt(0, 1, 0);
    env.add(box);
  }
  const pm = new THREE.PMREMGenerator(R);
  scene.environment = pm.fromScene(env, 0.03).texture;
  pm.dispose();

  const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x1a1410, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-2.5, 4.5, 3.5);
  key.castShadow = tier >= 3;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 3; key.shadow.camera.bottom = -1;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fd6ff, 1.0);
  rim.position.set(3, 2, -3);
  scene.add(rim);

  // The floor fills most of the screen: below High it is flat-shaded (its
  // light on a flat floor is even anyway), with the shadows baked in (buildSlab).
  const floorMat = tier >= 3 ? new THREE.MeshStandardMaterial({ color: 0x272c33, roughness: 0.82, metalness: 0.05 })
    : new THREE.MeshBasicMaterial({ color: 0x515e69 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(30, 60, 0x3a4250, 0x2c323b);
  grid.position.y = 0.001;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);
  labObjects.push(hemi, key, rim, floor, grid);

  // High and Ultra see the scene through the glass (a transmission pass).
  // Below, one pass does what clear glass does to what is behind it: each
  // face passes a share of it, tinted (the blend's constant colour), and adds
  // its reflection and a faint sheen of the room.
  glassMat = tier >= 3
    ? new THREE.MeshPhysicalMaterial({ color: 0xeaf7f3, metalness: 0, roughness: 0.03, transmission: 1, thickness: 0.006, ior: 1.52,
      transparent: true, envMapIntensity: 1.3, side: THREE.DoubleSide, specularIntensity: 1, depthWrite: false })
    : new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0.008, 0.013, 0.016), metalness: 0, roughness: 0.03,
      envMapIntensity: 1.6, transparent: true, side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.ConstantColorFactor,
      blendColor: new THREE.Color(0.70, 0.78, 0.74) });
  fragMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.04, transparent: true, opacity: 0.25,
    envMapIntensity: 1.7, side: THREE.DoubleSide, depthWrite: false });
  frameMat = new THREE.MeshStandardMaterial({ color: 0x8b939e, metalness: 0.85, roughness: 0.35 });
}

// ---------- Small helpers ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function fmtTime(t) {
  if (t < 1e-3) return (t * 1e6).toFixed(1) + ' µs';
  if (t < 1) return (t * 1e3).toFixed(3) + ' ms';
  return t.toFixed(3) + ' s';
}
function fmtScale(s) {
  if (s >= 0.999) return '1× · real time';
  const n = 1 / s;
  return '1/' + (n >= 1000 ? Math.round(n).toLocaleString('en') : n.toFixed(n < 10 ? 1 : 0)) + ' speed';
}
function quatRotate(qw, qx, qy, qz, vx, vy, vz) {
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
let bannerTimer = 0;
function banner(title, sub) {
  $('bTitle').textContent = title;
  $('bSub').textContent = sub || '';
  $('banner').classList.add('on');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.remove('on'), 2800);
}

// ---------- Selection state ----------
// Every visit opens on a storefront panel (fully tempered 10 mm) with three
// 10 mm annealed plates behind it, a metre apart, and the cannonball (until another object
// is picked: a new key, so earlier picks give way to the new default).
let gIdx = Math.max(0, cat.glazings.findIndex((g) => g.id === 'storefront_tempered_10'));
let iIdx = Math.max(0, cat.impactors.findIndex((g) => g.id === store.get('impactor:v2', 'cannonball_9lb')));
let speed = cat.impactors[iIdx].speed;
let yaw = 0, pitch = 0, fromBack = false;
let aim = null;  // pane point {x, y}

// ---------- Pane state (rebuilt per pane) ----------
let P = null;  // { W, H, T, plies: [...], glass: count, seed, shots: [], ... }
const labGroup = new THREE.Group();   // the lab's pane (and the armoured car's windscreen)
let groupPane = labGroup;             // the pane being worked on (a scene of many windows switches it)
scene.add(labGroup);

function toThree(x, y, z) { return [x - P.W / 2, y + FLOOR, -z]; }

// Crack lines of one glass ply: a growing line buffer with a birth time per
// vertex. The shader hides cracks not yet born at the display time and makes
// a fresh crack front glow, so slow motion shows the front racing out.
// On WebGL2 each crack segment knows the pieces either side of it (from the
// engine's cell map) and is drawn while either is still in the frame, so a
// held pane keeps its spider web and the lines go with the glass that falls.
const CRACK_PIECES = R && R.capabilities.isWebGL2;
class CrackView {
  constructor(zMid) {
    this.zMid = zMid;
    this.count = 0;
    this.cap = 0;
    this.map = null;
    this.segs = [];  // flat copies for the 2D view: ax, ay, bx, by, ta, tb, kind
    if (!R) return;
    this.geo = new THREE.BufferGeometry();
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uGlow: { value: 1e3 }, uDefl: { value: deflTex }, uExag: { value: 1 }, uSize: { value: new THREE.Vector2(1, 1) },
        uOff: { value: new THREE.Vector2(0, FLOOR) }, uZ: { value: -zMid }, uPose: { value: null }, uUsePieces: { value: 0 } },
      vertexShader: `
        attribute float aTime; uniform float uTime; uniform sampler2D uDefl; uniform float uExag; uniform vec2 uSize; uniform vec2 uOff; uniform float uZ;
        varying float vAge;
        ${CRACK_PIECES ? `attribute vec2 aPiece; uniform highp sampler2D uPose; uniform float uUsePieces;
        float held(float p) {
          if (p < -1.5) return 1.0;          // not yet known
          if (p < 0.0) return 0.0;           // no glass there
          int i = int(p + 0.5);
          float st = texelFetch(uPose, ivec2((i % ${PPR}) * 3, i / ${PPR}), 0).w;
          return abs(st) < 0.5 ? 1.0 : 0.0;  // held in the frame
        }` : ''}
        void main(){
          vAge = uTime - aTime;
          ${CRACK_PIECES ? `if (uUsePieces > 0.5 && max(held(aPiece.x), held(aPiece.y)) < 0.5) vAge = -1.0;` : ''}
          vec2 uv = (position.xy - vec2(-uSize.x*0.5, uOff.y)) / uSize;
          float w = texture2D(uDefl, uv).r;
          vec3 p = vec3(position.xy, uZ - w * uExag);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        varying float vAge; uniform float uGlow;
        void main(){
          if (vAge < 0.0) discard;
          float g = exp(-vAge * uGlow);
          gl_FragColor = vec4(vec3(0.78, 0.88, 0.95) + g * vec3(0.9, 0.8, 0.5), 0.85);
        }`,
    });
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    groupPane.add(this.lines);
  }
  grow(n) {
    if (!R || n <= this.cap) return;
    const cap = Math.max(1024, 1 << Math.ceil(Math.log2(n)));
    const pos = new Float32Array(cap * 6), tim = new Float32Array(cap * 2), pc = new Float32Array(cap * 4).fill(-2);
    if (this.cap) {
      pos.set(this.geo.attributes.position.array.subarray(0, this.count * 6));
      tim.set(this.geo.attributes.aTime.array.subarray(0, this.count * 2));
      if (CRACK_PIECES) pc.set(this.geo.attributes.aPiece.array.subarray(0, this.count * 4));
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aTime', new THREE.BufferAttribute(tim, 1));
    if (CRACK_PIECES) this.geo.setAttribute('aPiece', new THREE.BufferAttribute(pc, 2));
    this.cap = cap;
  }
  add(buf) {
    const n = buf.length / 7;
    if (!n) return;
    for (let i = 0; i < buf.length; ++i) this.segs.push(buf[i]);
    if (!R) { this.count += n; return; }
    this.grow(this.count + n);
    const pos = this.geo.attributes.position.array, tim = this.geo.attributes.aTime.array;
    for (let i = 0; i < n; ++i) {
      const o = (this.count + i) * 6, b = i * 7;
      pos[o] = buf[b] - P.W / 2; pos[o + 1] = buf[b + 1] + FLOOR; pos[o + 2] = 0;
      pos[o + 3] = buf[b + 2] - P.W / 2; pos[o + 4] = buf[b + 3] + FLOOR; pos[o + 5] = 0;
      tim[(this.count + i) * 2] = buf[b + 4];
      tim[(this.count + i) * 2 + 1] = buf[b + 5];
    }
    if (this.map) this.label(this.count, this.count + n);
    this.count += n;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aTime.needsUpdate = true;
    this.geo.setDrawRange(0, this.count * 2);
  }
  // The engine's cell map for this ply changed: which pieces border each segment.
  setMap(map, cell) {
    if (!CRACK_PIECES) return;
    this.map = map; this.cell = cell;
    this.label(0, this.count);
  }
  label(from, to) {
    if (!CRACK_PIECES || !this.map || to <= from) return;
    const { nx, ny, label } = this.map, cell = this.cell, s = this.segs, pc = this.geo.attributes.aPiece.array;
    const at = (x, y) => {
      const i = Math.floor(x / cell), j = Math.floor(y / cell);
      return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : label[j * nx + i];
    };
    for (let k = from; k < to; ++k) {
      const b = k * 7, mx = (s[b] + s[b + 2]) / 2, my = (s[b + 1] + s[b + 3]) / 2;
      const ex = s[b + 2] - s[b], ey = s[b + 3] - s[b + 1], l = Math.hypot(ex, ey) || 1;
      const ox = -ey / l * 0.9 * cell, oy = ex / l * 0.9 * cell;
      const a = at(mx + ox, my + oy), c = at(mx - ox, my - oy);
      pc.set([a, c, a, c], k * 4);
    }
    this.geo.attributes.aPiece.needsUpdate = true;
  }
  dispose() { if (R) { this.geo.dispose(); this.mat.dispose(); groupPane.remove(this.lines); } }
}

// Fragments: one merged mesh; each piece's vertices are kept in its body
// frame and transformed on the CPU when it moves (works on any GPU).
class FragmentView {
  constructor() {
    this.recs = [];
    this.byIndex = new Map();
    this.nVerts = 0;
    this.cap = 0;
    if (!R) return;
    this.geo = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geo, fragMat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.castShadow = tier >= 3;
    groupPane.add(this.mesh);
  }
  add(shapes) {
    for (const s of shapes) {
      const n = s.outline.length / 2;
      if (n < 3) continue;
      // Shrink a hair about the centroid so the seams between pieces show.
      let rmax = 0;
      for (let i = 0; i < n; ++i) rmax = Math.max(rmax, Math.hypot(s.outline[2 * i], s.outline[2 * i + 1]));
      const k = rmax > 0 ? Math.max(0.6, 1 - 0.0006 / rmax) : 1;
      const pts = [];
      for (let i = 0; i < n; ++i) pts.push(new THREE.Vector2(s.outline[2 * i] * k, s.outline[2 * i + 1] * k));
      const holeLoops = (s.holes || []).map((hl) => {
        const l = [];
        for (let i = 0; i + 1 < hl.length; i += 2) l.push(new THREE.Vector2(hl[i], hl[i + 1]));
        return l;
      }).filter((l) => l.length >= 3);
      let tris = [];
      try { tris = THREE.ShapeUtils.triangulateShape(pts, holeLoops); } catch { tris = []; }
      const allPts = pts.concat(...holeLoops);
      const h = s.thickness / 2;
      const v = [], nrm = [], col = [];
      const push = (x, y, z, nx, ny, nz, c) => { v.push(x, y, z); nrm.push(nx, ny, nz); col.push(c[0], c[1], c[2]); };
      const face = [0.92, 0.97, 0.98], edge = s.chip ? [0.85, 0.95, 0.92] : [0.45, 0.78, 0.62];
      for (const [a, b, c] of tris) {
        const A = allPts[a], B = allPts[b], C = allPts[c];
        push(A.x, A.y, -h, 0, 0, -1, face); push(B.x, B.y, -h, 0, 0, -1, face); push(C.x, C.y, -h, 0, 0, -1, face);
        push(A.x, A.y, h, 0, 0, 1, face); push(C.x, C.y, h, 0, 0, 1, face); push(B.x, B.y, h, 0, 0, 1, face);
      }
      for (const hl of holeLoops) for (let i = 0; i < hl.length; ++i) {
        const p = hl[i], q = hl[(i + 1) % hl.length];
        const ex = q.x - p.x, ey = q.y - p.y, l = Math.hypot(ex, ey) || 1, nx = -ey / l, ny = ex / l;
        push(p.x, p.y, -h, nx, ny, 0, edge); push(q.x, q.y, -h, nx, ny, 0, edge); push(q.x, q.y, h, nx, ny, 0, edge);
        push(p.x, p.y, -h, nx, ny, 0, edge); push(q.x, q.y, h, nx, ny, 0, edge); push(p.x, p.y, h, nx, ny, 0, edge);
      }
      for (let i = 0; i < n; ++i) {
        const p = pts[i], q = pts[(i + 1) % n];
        const ex = q.x - p.x, ey = q.y - p.y, l = Math.hypot(ex, ey) || 1;
        const nx = ey / l, ny = -ex / l;
        push(p.x, p.y, -h, nx, ny, 0, edge); push(q.x, q.y, -h, nx, ny, 0, edge); push(q.x, q.y, h, nx, ny, 0, edge);
        push(p.x, p.y, -h, nx, ny, 0, edge); push(q.x, q.y, h, nx, ny, 0, edge); push(p.x, p.y, h, nx, ny, 0, edge);
      }
      // Crazed tempered dice sit a degree or so out of line with each other
      // and catch the light piece by piece.
      const pl = P.plies.find((q) => q.ply === s.ply);
      if (pl && pl.dicing && !s.chip) {
        const tilt = (hash01(s.index, 3) - 0.5) * 0.05, a = 2 * Math.PI * hash01(s.index, 4);
        const ax = Math.cos(a) * tilt, ay = Math.sin(a) * tilt;
        for (const arr of [v, nrm])
          for (let i = 0; i < arr.length; i += 3) {
            const x = arr[i], y = arr[i + 1], z = arr[i + 2];
            arr[i] = x + ay * z; arr[i + 1] = y - ax * z; arr[i + 2] = z + ax * y - ay * x;
          }
      }
      const rec = { index: s.index, ply: s.ply, chip: s.chip, start: this.nVerts, count: v.length / 3, local: new Float32Array(v),
        localN: new Float32Array(nrm), col: new Float32Array(col), poly: pts.map((p) => [p.x, p.y]), holes: holeLoops.map((l) => l.map((p) => [p.x, p.y])),
        state: -2, still: 0 };
      this.nVerts += rec.count;
      this.recs.push(rec);
      this.byIndex.set(s.index, rec);
    }
    if (!R) return;
    if (this.nVerts > this.cap) {
      const cap = Math.max(4096, 1 << Math.ceil(Math.log2(this.nVerts)));
      const pos = new Float32Array(cap * 3), nor = new Float32Array(cap * 3), col = new Float32Array(cap * 3);
      if (this.cap) {
        pos.set(this.geo.attributes.position.array.subarray(0, this.cap * 3));
        nor.set(this.geo.attributes.normal.array.subarray(0, this.cap * 3));
        col.set(this.geo.attributes.color.array.subarray(0, this.cap * 3));
      }
      this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.cap = cap;
    }
    const col = this.geo.attributes.color.array;
    for (const r of this.recs) if (r.state === -2) col.set(r.col, r.start * 3);
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, this.nVerts);
  }
  // poses: 12 floats per fragment record (see glass_web.cpp).
  update(poses, dtAhead) {
    if (!R) return;
    const pos = this.geo.attributes.position.array, nor = this.geo.attributes.normal.array;
    let dirty = false;
    for (const r of this.recs) {
      const o = r.index * 12;
      const state = poses[o + 10];
      const moving = state === 1 || state === 2;
      if (r.state === state && !moving && r.still > 1) continue;
      r.still = moving ? 0 : r.still + 1;
      r.state = state;
      dirty = true;
      if (state < 0) {  // retired: collapse
        pos.fill(0, r.start * 3, (r.start + r.count) * 3);
        continue;
      }
      const t = state === 2 ? dtAhead : 0;
      const px = poses[o] + poses[o + 7] * t, py = poses[o + 1] + poses[o + 8] * t - 4.9 * t * t, pz = poses[o + 2] + poses[o + 9] * t;
      const qw = poses[o + 3], qx = poses[o + 4], qy = poses[o + 5], qz = poses[o + 6];
      for (let i = 0; i < r.count; ++i) {
        const a = quatRotate(qw, qx, qy, qz, r.local[3 * i], r.local[3 * i + 1], r.local[3 * i + 2]);
        const b = quatRotate(qw, qx, qy, qz, r.localN[3 * i], r.localN[3 * i + 1], r.localN[3 * i + 2]);
        const k = (r.start + i) * 3;
        pos[k] = px + a[0] - P.W / 2; pos[k + 1] = py + a[1] + FLOOR; pos[k + 2] = -(pz + a[2]);
        nor[k] = b[0]; nor[k + 1] = b[1]; nor[k + 2] = -b[2];
      }
    }
    if (dirty) { this.geo.attributes.position.needsUpdate = true; this.geo.attributes.normal.needsUpdate = true; }
  }
  dispose() { if (R) { this.geo.dispose(); groupPane.remove(this.mesh); } }
}

// The real dice. The engine draws a tempered pane coarser than its dice; a
// coarse piece comes apart into its real dice in the air (or on landing), and
// the engine reports each such spray. Every die then flies, bounces, slides
// and tumbles on a closed-form path in engine time, evaluated on the GPU: no
// per-frame work on the CPU, and slow motion or a replay shows the same pile.
const DICE_CAP = [8000, 12000, 20000, 32000, 60000];
function hash01(i, k) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 0x27d4eb2f, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const DICE_VERT_HEAD = `
attribute vec4 aT;   // born, landing (s after born), hop speed, tumble rate
attribute vec3 aP;   // start position
attribute vec3 aV;   // start velocity
attribute vec3 aS;   // size x, thickness, size z
attribute vec4 aR;   // tumble axis, resting yaw
attribute vec3 aSl;  // slide velocity x, z; brightness
uniform float uTime;
varying float vK;
mat3 diceAxisAngle(vec3 a, float t) {
  float c = cos(t), s = sin(t), k = 1.0 - c;
  return mat3(k * a.x * a.x + c, k * a.x * a.y + s * a.z, k * a.x * a.z - s * a.y,
              k * a.x * a.y - s * a.z, k * a.y * a.y + c, k * a.y * a.z + s * a.x,
              k * a.x * a.z + s * a.y, k * a.y * a.z - s * a.x, k * a.z * a.z + c);
}`;
const DICE_VERT_BODY = `
  float tau = max(0.0, uTime - aT.x);
  float tL = aT.y;
  vec3 axis = normalize(aR.xyz);
  mat3 lie = diceAxisAngle(vec3(0.0, 1.0, 0.0), aR.w);
  vec3 dPos; mat3 dRot;
  if (tau < tL) {
    // In the air: gravity, and a tumble.
    dPos = aP + aV * tau + vec3(0.0, -4.905 * tau * tau, 0.0);
    dRot = diceAxisAngle(axis, aT.w * tau) * lie;
  } else {
    // On the floor: a hop, then sliding to rest, the tumble settling flat.
    float u = tau - tL;
    vec3 pL = aP + aV * tL + vec3(0.0, -4.905 * tL * tL, 0.0);
    float sl = (1.0 - exp(-6.0 * u)) / 6.0;
    float hopT = 2.0 * aT.z / 9.81;
    float hy = u < hopT ? aT.z * u - 4.905 * u * u : 0.0;
    dPos = vec3(pL.x + aSl.x * sl, aS.y * 0.5 + hy, pL.z + aSl.y * sl);
    mat3 spun = diceAxisAngle(axis, aT.w * (tL + (1.0 - exp(-4.0 * u)) / 4.0)) * lie;
    float w = hopT > 0.0 ? smoothstep(0.0, hopT, u) : 1.0;
    dRot = mat3(normalize(mix(spun[0], lie[0], w)), normalize(mix(spun[1], lie[1], w)), normalize(mix(spun[2], lie[2], w)));
  }
  if (uTime < aT.x) dPos = vec3(0.0, -100.0, 0.0);
  vK = aSl.z;
  vec3 objectNormal = dRot * normal;`;
class DiceView {
  constructor() {
    this.cap = DICE_CAP[clamp(P.viewTier ?? tier, 0, 4)];
    this.n = 0;
    this.sprays = 0;
    // Thin dice across every dicing ply; the shown ones grow so the pile keeps its area.
    let expected = 0;
    for (const pl of P.plies) if (pl.dicing && pl.dice > 0) expected += (P.W * P.H) / (pl.dice * pl.dice);
    this.keep = expected > this.cap ? this.cap / expected : 1;
    if (!R) return;
    const geo = new THREE.InstancedBufferGeometry().copy(new THREE.BoxGeometry(1, 1, 1));
    geo.instanceCount = 0;
    const attr = (name, k) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * k), k);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.a = { aT: attr('aT', 4), aP: attr('aP', 3), aV: attr('aV', 3), aS: attr('aS', 3), aR: attr('aR', 4), aSl: attr('aSl', 3) };
    this.uTime = { value: 0 };
    const opts = { color: 0xd3ece4, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.45, envMapIntensity: 2.4 };
    // Below High no clearcoat: a stronger, sharper reflection gives the dice the same glint.
    this.mat = tier >= 3 ? new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 1, clearcoatRoughness: 0.05, ior: 1.52, specularIntensity: 1 })
      : new THREE.MeshStandardMaterial({ ...opts, metalness: 0.4, roughness: 0.02, opacity: 0.5, envMapIntensity: 4.5 });
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + DICE_VERT_HEAD)
        .replace('#include <beginnormal_vertex>', DICE_VERT_BODY)
        .replace('#include <begin_vertex>', 'vec3 transformed = dRot * (position * aS) + dPos;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vK;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vK;');
    };
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    groupPane.add(this.mesh);
  }
  // sprays: 15 floats each (see glass_web.cpp).
  addSprays(sp) {
    const first = this.sprays, start = this.n;
    this.sprays += Math.floor(sp.length / 15);
    if (!R) return;
    const A = this.a;
    for (let o = 0; o + 14 < sp.length; o += 15) {
      const id = first + o / 15;
      const want = sp[o + 6] * this.keep;
      const count = Math.floor(want) + (hash01(id, 1) < want - Math.floor(want) ? 1 : 0);
      if (!count) continue;
      const grow = 1 / Math.sqrt(this.keep), size = sp[o + 7] * grow, thick = sp[o + 8];
      const [cx, cy, cz] = toThree(sp[o], sp[o + 1], sp[o + 2]);
      const vx = sp[o + 3], vy = sp[o + 4], vz = -sp[o + 5];
      const inAir = cy > thick + 0.02;
      const spread = 0.5 * Math.sqrt(sp[o + 6]) * sp[o + 7];
      for (let k = 0; k < count && this.n < this.cap; ++k) {
        const h = (j) => hash01(id, 10 + 13 * k + j);
        const i = this.n++;
        const ang = 2 * Math.PI * h(0), r = spread * Math.sqrt(h(1));
        let px, py, pz, ux = vx, uy = vy, uz = vz, tL, hop, sx, sz;
        if (inAir) {
          // Out of the piece's face (the pane's plane), drifting apart as the mosaic lets go.
          px = cx + r * Math.cos(ang); py = cy + r * Math.sin(ang); pz = cz + (h(2) - 0.5) * thick;
          const sep = 0.08 + 0.35 * h(3), a2 = 2 * Math.PI * h(4);
          ux += sep * Math.cos(a2); uy += sep * Math.sin(a2) * 0.6; uz += (h(5) - 0.5) * 0.5;
          const y0 = py - thick / 2;
          tL = (uy + Math.sqrt(Math.max(0, uy * uy + 2 * 9.81 * y0))) / 9.81;
          const vyL = Math.abs(uy - 9.81 * tL);
          hop = Math.min(1.0, 0.18 * vyL * (0.4 + 1.2 * h(6)));
          const burst = (0.1 + 0.45 * h(7)) * (0.3 + 0.1 * vyL), a3 = 2 * Math.PI * h(8);
          sx = 0.35 * ux + burst * Math.cos(a3); sz = 0.35 * uz + burst * Math.sin(a3);
        } else {
          // A piece that reached the floor whole bursts there.
          px = cx + r * Math.cos(ang); py = thick / 2; pz = cz + r * Math.sin(ang);
          ux = uy = uz = 0; tL = 0;
          const vh = Math.hypot(vx, vz);
          hop = 0.3 + 0.9 * h(6) + 0.1 * vh;
          const burst = (0.25 + 0.9 * h(7)) * (0.4 + 0.25 * Math.abs(vy));
          sx = Math.cos(ang) * burst + 0.4 * vx * h(8); sz = Math.sin(ang) * burst + 0.4 * vz * h(8);
        }
        A.aT.setXYZW(i, sp[o + 9], tL, hop, 2 + 12 * h(9) * h(9));
        A.aP.setXYZ(i, px, py, pz);
        A.aV.setXYZ(i, ux, uy, uz);
        A.aS.setXYZ(i, size * (0.75 + 0.5 * h(10)), thick, size * (0.8 + 0.4 * h(11)));
        A.aR.setXYZW(i, h(12) - 0.5, h(13) - 0.5, h(2) - 0.5 + 1e-3, 2 * Math.PI * h(5));
        A.aSl.setXYZ(i, sx, sz, 0.8 + 0.35 * h(4));
      }
    }
    if (this.n === start) return;
    for (const a of Object.values(A)) {
      a.clearUpdateRanges();
      a.addUpdateRange(start * a.itemSize, (this.n - start) * a.itemSize);
      a.needsUpdate = true;
    }
    this.mesh.geometry.instanceCount = this.n;
  }
  update(t) { if (this.uTime) this.uTime.value = t; }
  dispose() { if (R) { groupPane.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); } }
}

// ---------- Pieces and their real dice, on the GPU ----------
// A tempered piece the engine draws is a patch of real dice. Here each piece is
// cut into them (a seeded Voronoi of real-dice size, extruded to the glass
// thickness: that is what a tempered die is), so the crazed pane shows the
// real dicing pattern. When the engine says a piece came apart, its own dice
// leave from where they sat, with their shapes and orientation, some stuck
// together in small clumps, and fly, bounce, slide and settle on closed-form
// paths. Everything moves in the vertex shader: piece poses and dice flights
// live in two float textures, the geometry never changes after it is built.
const DPR = 292, PPR = 680;   // dice / pieces per texture row (7 / 3 texels each)
const CELL_CAP = [12000, 16000, 24000, 32000, 45000];
const PIECE_HEAD = `
uniform highp sampler2D uDice;
uniform highp sampler2D uPose;
uniform float uTime, uAhead, uW, uLift, uFloor;
attribute float aDie;
varying float vEdge;
varying float vK;
varying float vDice;
mat3 pvAxis(vec3 a, float t) {
  float c = cos(t), s = sin(t), k = 1.0 - c;
  return mat3(k * a.x * a.x + c, k * a.x * a.y + s * a.z, k * a.x * a.z - s * a.y,
              k * a.x * a.y - s * a.z, k * a.y * a.y + c, k * a.y * a.z + s * a.x,
              k * a.x * a.z + s * a.y, k * a.y * a.z - s * a.x, k * a.z * a.z + c);
}
mat3 pvQuat(vec4 q) {
  float w = q.x, x = q.y, y = q.z, z = q.w;
  return mat3(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
              2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
              2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
}`;
const PIECE_BODY = `
  int di = int(aDie + 0.5);
  ivec2 db = ivec2((di % ${DPR}) * 7, di / ${DPR});
  vec4 d0 = texelFetch(uDice, db, 0);                  // born (-1 attached), landing, hop, tumble rate
  vec4 d5 = texelFetch(uDice, db + ivec2(5, 0), 0);    // die centre (piece frame), piece
  vec4 d6 = texelFetch(uDice, db + ivec2(6, 0), 0);    // clump centre (piece frame), half thickness
  int pi = int(d5.w + 0.5);
  ivec2 pb = ivec2((pi % ${PPR}) * 3, pi / ${PPR});
  vec4 p0 = texelFetch(uPose, pb, 0);                  // position, state
  vec3 wPos; mat3 wRot; vec3 rel;
  vEdge = 1.0 - abs(normal.z);
  vK = 0.86 + 0.28 * fract(float(di) * 0.618034);
  vDice = d6.z;
  if (d0.x < 0.0 || uTime < d0.x) {
    // Still part of its piece.
    vec4 pq = texelFetch(uPose, pb + ivec2(1, 0), 0);
    vec4 pv = texelFetch(uPose, pb + ivec2(2, 0), 0);
    float ahead = (p0.w > 1.5 && p0.w < 2.5) ? uAhead : 0.0;
    wPos = p0.xyz + pv.xyz * ahead + vec3(0.0, -4.905 * ahead * ahead, 0.0);
    wRot = pvQuat(pq);
    rel = position;
    if (p0.w < 0.0 || d0.z < 0.0) wPos = vec3(0.0, -1000.0, 0.0);   // gone, or replaced by its dice
  } else {
    vec4 d1 = texelFetch(uDice, db + ivec2(1, 0), 0);  // clump centre at release (pane), resting yaw
    vec4 d2 = texelFetch(uDice, db + ivec2(2, 0), 0);  // clump velocity, slide x
    vec4 d3 = texelFetch(uDice, db + ivec2(3, 0), 0);  // tumble axis, slide z
    vec4 d4 = texelFetch(uDice, db + ivec2(4, 0), 0);  // piece orientation at release
    float tau = uTime - d0.x, tL = d0.y;
    mat3 R0 = pvQuat(d4);
    vec3 axis = normalize(d3.xyz);
    if (tau < tL) {
      // The clump in the air: gravity and a tumble about its centre.
      wPos = d1.xyz + d2.xyz * tau + vec3(0.0, -4.905 * tau * tau, 0.0);
      wRot = pvAxis(axis, d0.w * tau) * R0;
      rel = position - d6.xyz;
    } else {
      // Each die on the floor: a hop, sliding to rest, settling flat.
      float u = tau - tL;
      vec3 cL = d1.xyz + d2.xyz * tL + vec3(0.0, -4.905 * tL * tL, 0.0);
      vec3 dieL = cL + pvAxis(axis, d0.w * tL) * R0 * (d5.xyz - d6.xyz);
      float sl = (1.0 - exp(-6.0 * u)) / 6.0;
      float hopT = 2.0 * d0.z / 9.81;
      float hy = u < hopT ? d0.z * u - 4.905 * u * u : 0.0;
      wPos = vec3(dieL.x + d2.w * sl, uFloor + d6.w + hy, dieL.z + d3.w * sl);
      mat3 spun = pvAxis(axis, d0.w * (tL + (1.0 - exp(-4.0 * u)) / 4.0)) * R0;
      mat3 lie = pvAxis(vec3(0.0, 1.0, 0.0), d1.w) * mat3(1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0);
      float w = hopT > 0.0 ? smoothstep(0.0, hopT, u) : 1.0;
      wRot = mat3(normalize(mix(spun[0], lie[0], w)), normalize(mix(spun[1], lie[1], w)), normalize(mix(spun[2], lie[2], w)));
      rel = position - d5.xyz;
    }
  }
  vec3 wp = wPos + wRot * rel;          // pane frame
  vec3 wn = wRot * normal;
  vec3 objectNormal = vec3(wn.x, wn.y, -wn.z);`;
function polyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; ++i) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
function polyCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; ++i) {
    const p = pts[i], q = pts[(i + 1) % n], c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-14) { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; }
  return [cx / (3 * a), cy / (3 * a)];
}
function insidePoly(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function clipHalf(poly, nx, ny, d) {  // keep nx x + ny y <= d
  const out = [];
  for (let i = 0, n = poly.length; i < n; ++i) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = nx * a[0] + ny * a[1] - d, db = nx * b[0] + ny * b[1] - d;
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
// Cuts a piece's outline into cells about `size` across: seeds on a jittered
// hexagonal lattice at a seeded angle, Voronoi cells clipped to the outline.
function diceCells(outline, size, seed, holes = []) {
  const ang = 2 * Math.PI * hash01(seed, 21), ca = Math.cos(ang), sa = Math.sin(ang);
  const a = size * 1.075, rowH = a * 0.866;
  let r = 0;
  for (const p of outline) r = Math.max(r, Math.hypot(p[0], p[1]));
  const seeds = [];
  const n = Math.ceil(r / rowH) + 1;
  for (let j = -n; j <= n; ++j)
    for (let i = -n; i <= n; ++i) {
      const k = seeds.length + (j + n) * 997 + i;
      const u = (i + (j & 1) * 0.5) * a + (hash01(seed, 100 + 7 * k) - 0.5) * 0.6 * a;
      const v = j * rowH + (hash01(seed, 101 + 7 * k) - 0.5) * 0.6 * a;
      const x = u * ca - v * sa, y = u * sa + v * ca;
      if (Math.hypot(x, y) <= r + a && insidePoly(outline, x, y) && !holes.some((hl) => insidePoly(hl, x, y))) seeds.push([x, y]);
    }
  if (seeds.length < 2) return [{ cell: outline, nb: [] }];
  const reach = 3.2 * a, near = 1.6 * a;
  return seeds.map((sd, i) => {
    let cell = outline;
    const nb = [];
    for (let j = 0; j < seeds.length && cell.length >= 3; ++j) {
      if (j === i) continue;
      const t = seeds[j], dx = t[0] - sd[0], dy = t[1] - sd[1], d2 = dx * dx + dy * dy;
      if (d2 > reach * reach) continue;
      if (d2 < near * near) nb.push(j);
      cell = clipHalf(cell, dx, dy, dx * (sd[0] + t[0]) / 2 + dy * (sd[1] + t[1]) / 2);
    }
    return { cell, nb };
  });
}
class PieceView {
  constructor() {
    this.recs = [];
    this.queue = [];
    this.urgent = [];
    this.pieces = new Map();   // fragment index -> { dice: [first, end], clumps: [[die...]] }
    this.nDice = 0; this.nVerts = 0; this.nIdx = 0;
    this.sprays = 0;
    let expected = 0;
    for (const pl of P.plies) if (pl.dicing && pl.dice > 0) expected += (P.W * P.H) / (pl.dice * pl.dice);
    this.cellArea = (pl) => {
      const keep = expected > 0 ? Math.min(1, CELL_CAP[clamp(P.viewTier ?? tier, 0, 4)] / expected) : 1;
      return pl.dice * pl.dice / keep;
    };
    // CPU mirrors; grown by doubling.
    this.pos = new Float32Array(3 * 8192); this.nor = new Float32Array(3 * 8192); this.die = new Float32Array(8192);
    this.idx = new Uint32Array(16384);
    this.diceTex = this.texture(DPR * 7, 64);
    this.poseTex = this.texture(PPR * 3, 8);
    this.geo = new THREE.BufferGeometry();
    this.attach();
    this.uniforms = { uDice: { value: this.diceTex }, uPose: { value: this.poseTex }, uTime: { value: 0 }, uAhead: { value: 0 },
      uW: { value: P.W }, uLift: { value: FLOOR }, uFloor: { value: P.floor } };
    // Broken glass stays clear: faces about as see-through as the intact pane,
    // the light caught by the cut edges and seams.
    const opts = { color: 0xe4f2ef, metalness: 0.15, roughness: 0.04, transparent: true, opacity: 0.18, envMapIntensity: 1.8,
      side: THREE.DoubleSide };
    // Below High no clearcoat: a stronger, sharper reflection gives the pieces the same glint.
    this.mat = tier >= 3 ? new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 1, clearcoatRoughness: 0.05, ior: 1.52 })
      : new THREE.MeshStandardMaterial({ ...opts, metalness: 0.4, roughness: 0.02, opacity: 0.26, envMapIntensity: 4.5 });
    this.mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + PIECE_HEAD)
        .replace('#include <beginnormal_vertex>', PIECE_BODY)
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(wp.x - 0.5 * uW, wp.y + uLift, -wp.z);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vEdge;\nvarying float vK;\nvarying float vDice;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  float edge = smoothstep(0.3, 0.9, vEdge);\n  diffuseColor.rgb *= mix(vec3(vK), mix(vec3(0.5, 0.86, 0.7), vec3(0.36, 0.62, 0.52), vDice), edge);\n  diffuseColor.a *= mix(1.0, mix(3.6, 1.7, vDice), edge);');
    };
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    groupPane.add(this.mesh);
  }
  texture(w, h) {
    const t = new THREE.DataTexture(new Float32Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.FloatType);
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }
  grow(tex, rows) {
    const w = tex.image.width;
    if (rows <= tex.image.height) return tex;
    const t = this.texture(w, Math.max(rows, 2 * tex.image.height));
    t.image.data.set(tex.image.data);
    tex.dispose();
    return t;
  }
  attach() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    this.geo.setAttribute('aDie', new THREE.BufferAttribute(this.die, 1));
    this.geo.setIndex(new THREE.BufferAttribute(this.idx, 1));
  }
  // One die (or a whole piece): its outline in the piece frame, extruded +-h.
  // Triangles wind inward: the pane-to-scene mirror (z -> -z) turns them out.
  // Room for needV vertices and needI indices: doubling, or straight to what
  // the pane will need (reserve), so the GPU buffers are rebuilt rarely.
  room(needV, needI) {
    if (needV > this.die.length || needI > this.idx.length) {
      const cv = Math.max(2 * this.die.length, needV), ci = Math.max(2 * this.idx.length, needI);
      const pos = new Float32Array(3 * cv), nor = new Float32Array(3 * cv), die = new Float32Array(cv), idx = new Uint32Array(ci);
      pos.set(this.pos); nor.set(this.nor); die.set(this.die); idx.set(this.idx);
      Object.assign(this, { pos, nor, die, idx });
      this.attach();
      this.flushV = 0; this.flushI = 0;   // new buffers: upload them whole
    }
  }
  pushPrism(pts, h, dieIndex, holes = []) {
    const loops = [pts, ...holes], all = [].concat(...loops);
    const n = all.length;
    this.room(this.nVerts + 6 * n, this.nIdx + 6 * n + 6 * n);
    let tris = [];
    let convex = !holes.length;
    for (let i = 0, m = pts.length; i < m && convex; ++i) {
      const a = pts[i], b = pts[(i + 1) % m], c = pts[(i + 2) % m];
      convex = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) >= -1e-12;
    }
    const V2 = (l) => l.map((p) => new THREE.Vector2(p[0], p[1]));
    if (convex) for (let i = 1; i + 1 < n; ++i) tris.push([0, i, i + 1]);
    else try { tris = THREE.ShapeUtils.triangulateShape(V2(pts), holes.map(V2)); } catch { tris = []; }
    const v0 = this.nVerts;
    const vert = (x, y, z, nx, ny, nz) => {
      const i = this.nVerts++;
      this.pos[3 * i] = x; this.pos[3 * i + 1] = y; this.pos[3 * i + 2] = z;
      this.nor[3 * i] = nx; this.nor[3 * i + 1] = ny; this.nor[3 * i + 2] = nz;
      this.die[i] = dieIndex;
      return i;
    };
    for (const p of all) vert(p[0], p[1], -h, 0, 0, -1);
    for (const p of all) vert(p[0], p[1], h, 0, 0, 1);
    const I = (a) => { this.idx[this.nIdx++] = a; };
    for (const [a, b, c] of tris) { I(v0 + a); I(v0 + b); I(v0 + c); I(v0 + n + a); I(v0 + n + c); I(v0 + n + b); }
    // Walls round the outline and round each hole (holes run clockwise, so
    // the same rule points their walls into the hole).
    for (const loop of loops) for (let i = 0, m = loop.length; i < m; ++i) {
      const p = loop[i], q = loop[(i + 1) % m];
      const ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey) || 1, nx = ey / l, ny = -ex / l;
      const a = vert(p[0], p[1], -h, nx, ny, 0), b = vert(q[0], q[1], -h, nx, ny, 0);
      const c = vert(q[0], q[1], h, nx, ny, 0), d = vert(p[0], p[1], h, nx, ny, 0);
      I(a); I(c); I(b); I(a); I(d); I(c);
    }
  }
  dieOffset(di) { return ((di / DPR | 0) * DPR * 7 + (di % DPR) * 7) * 4; }
  ensureDice(n) {
    const rows = Math.ceil(n / DPR) + 1;
    if (rows > this.diceTex.image.height) { this.diceTex = this.grow(this.diceTex, rows); this.uniforms.uDice.value = this.diceTex; }
  }
  // New pieces are drawn whole at once; tempered ones are queued to be cut
  // into their real dice a few at a time (tick), so shattering never stalls a frame.
  add(shapes) {
    // The first pieces of a tempered pane: make room for its dice in one go
    // (a die is about 36 vertices and 72 indices, a whole piece twice that).
    if (!this.reserved && P.plies.some((pl) => pl.dicing)) {
      this.reserved = true;
      const dice = CELL_CAP[clamp(P.viewTier ?? tier, 0, 4)] + 2 * shapes.length;
      this.room(this.nVerts + 36 * dice, this.nIdx + 72 * dice);
    }
    for (const s of shapes) {
      const n = s.outline.length / 2;
      if (n < 3) continue;
      const pts = [];
      for (let i = 0; i < n; ++i) pts.push([s.outline[2 * i], s.outline[2 * i + 1]]);
      if (polyArea(pts) < 0) pts.reverse();
      const holes = (s.holes || []).map((hl) => {
        const l = [];
        for (let i = 0; i + 1 < hl.length; i += 2) l.push([hl[i], hl[i + 1]]);
        return polyArea(l) > 0 ? l.reverse() : l;
      }).filter((l) => l.length >= 3);
      const h = s.thickness / 2;
      const pl = P.plies.find((q) => q.ply === s.ply);
      const dicing = !!(pl && pl.dicing && !s.chip && pl.dice > 0);
      const rec = { index: s.index, poly: pts, holes, h, clumps: null, whole: -1, pending: false };
      this.cut(rec, pts, h, [{ cell: pts, nb: [], holes }], false);
      rec.whole = rec.clumps[0][0];
      if (dicing && Math.abs(polyArea(pts)) > 1.6 * this.cellArea(pl)) { rec.pending = true; rec.size = Math.sqrt(this.cellArea(pl)); this.queue.push(rec); }
      this.pieces.set(s.index, rec);
      this.recs.push(rec);
    }
    this.flush();
  }
  // Cuts queued pieces into dice for up to `ms` milliseconds.
  tick(ms) {
    const t0 = performance.now();
    let any = false;
    // Pieces already on the move first: they are the next to come apart.
    while (this.urgent.length && performance.now() - t0 < ms) { const r = this.urgent.pop(); if (r.pending) { this.dice(r); any = true; } }
    while (this.queue.length && performance.now() - t0 < ms) { const r = this.queue.shift(); if (r.pending) { this.dice(r); any = true; } }
    if (any) this.flush();
  }
  dice(rec) {
    rec.pending = false;
    this.cut(rec, rec.poly, rec.h, diceCells(rec.poly, rec.size, rec.index, rec.holes), true);
    const o = this.dieOffset(rec.whole), D = this.diceTex.image.data;
    D[o + 2] = -1;   // the whole piece gives way to its dice
  }
  // Appends one prism per cell (each its own die), grouped into clumps.
  cut(rec, pts, h, cells, dicing) {
    const clumpOf = new Array(cells.length).fill(-1), clumps = [];
    cells.forEach((c, i) => {
      if (clumpOf[i] >= 0) return;
      const u = hash01(rec.index, 300 + i), want = !dicing ? 1 : u < 0.45 ? 1 : u < 0.7 ? 2 : u < 0.85 ? 3 : 4;
      const g = [i];
      clumpOf[i] = clumps.length;
      for (const j of c.nb) if (g.length < want && clumpOf[j] < 0 && cells[j].cell.length >= 3) { clumpOf[j] = clumps.length; g.push(j); }
      clumps.push(g);
    });
    const first = this.nDice;
    this.ensureDice(first + cells.length);
    const D = this.diceTex.image.data;
    const cen = cells.map((c) => (c.cell.length >= 3 ? polyCentroid(c.cell) : [0, 0]));
    const clumpCen = clumps.map((g) => {
      let x = 0, y = 0, w = 0;
      for (const i of g) { const a = Math.abs(polyArea(cells[i].cell)) + 1e-12; x += cen[i][0] * a; y += cen[i][1] * a; w += a; }
      return [x / w, y / w];
    });
    rec.clumps = clumps.map((g) => g.map((i) => first + i));
    cells.forEach((c, i) => {
      const di = this.nDice++, o = this.dieOffset(di);
      D[o] = -1; D[o + 1] = 0; D[o + 2] = 0; D[o + 3] = 0;
      D[o + 20] = cen[i][0]; D[o + 21] = cen[i][1]; D[o + 22] = 0; D[o + 23] = rec.index;
      const cc = clumpCen[clumpOf[i]];
      D[o + 24] = cc[0]; D[o + 25] = cc[1]; D[o + 26] = dicing ? 1 : 0; D[o + 27] = h;
      if (c.cell.length < 3) return;
      // A seam between dice, and each die a hair out of line so it catches the light.
      let rmax = 0;
      for (const p of c.cell) rmax = Math.max(rmax, Math.hypot(p[0] - cen[i][0], p[1] - cen[i][1]));
      // A whole pane with a hole needs no seam: only cut pieces shrink.
      const k = dicing ? Math.max(0.5, 1 - 0.00028 / Math.max(rmax, 1e-4)) : c.holes && c.holes.length ? 1 : Math.max(0.6, 1 - 0.0006 / Math.max(rmax, 1e-4));
      const cell = c.cell.map((p) => [cen[i][0] + (p[0] - cen[i][0]) * k, cen[i][1] + (p[1] - cen[i][1]) * k]);
      const v0 = this.nVerts;
      this.pushPrism(cell, h, di, c.holes || []);
      if (dicing) {
        const tilt = (hash01(di, 3) - 0.5) * 0.05, a = 2 * Math.PI * hash01(di, 4), ax = Math.cos(a) * tilt, ay = Math.sin(a) * tilt;
        for (let v = v0; v < this.nVerts; ++v) {
          const x = this.pos[3 * v] - cen[i][0], y = this.pos[3 * v + 1] - cen[i][1], z = this.pos[3 * v + 2];
          this.pos[3 * v] = x + ay * z + cen[i][0]; this.pos[3 * v + 1] = y - ax * z + cen[i][1]; this.pos[3 * v + 2] = z + ax * y - ay * x;
          const nx = this.nor[3 * v], ny = this.nor[3 * v + 1], nz = this.nor[3 * v + 2];
          this.nor[3 * v] = nx + ay * nz; this.nor[3 * v + 1] = ny - ax * nz; this.nor[3 * v + 2] = nz + ax * ny - ay * nx;
        }
      }
    });
  }
  // Uploads what was appended since the last flush.
  flush() {
    const ga = this.geo.attributes, v0 = this.flushV || 0, i0 = this.flushI || 0;
    if (this.nVerts > v0) {
      for (const [a, k] of [[ga.position, 3], [ga.normal, 3], [ga.aDie, 1]]) {
        a.clearUpdateRanges(); a.addUpdateRange(v0 * k, (this.nVerts - v0) * k); a.needsUpdate = true;
      }
      this.geo.index.clearUpdateRanges(); this.geo.index.addUpdateRange(i0, this.nIdx - i0); this.geo.index.needsUpdate = true;
      this.geo.setDrawRange(0, this.nIdx);
    }
    this.flushV = this.nVerts; this.flushI = this.nIdx;
    this.diceTex.needsUpdate = true;
  }
  // poses: 12 floats per fragment record (see glass_web.cpp).
  update(poses, dtAhead, t) {
    const n = poses.length / 12;
    const rows = Math.ceil(n / PPR) + 1;
    if (rows > this.poseTex.image.height) { this.poseTex = this.grow(this.poseTex, rows); this.uniforms.uPose.value = this.poseTex; }
    const d = this.poseTex.image.data;
    for (let i = 0; i < n; ++i) {
      const o = ((i / PPR | 0) * PPR * 3 + (i % PPR) * 3) * 4, q = i * 12;
      d[o] = poses[q]; d[o + 1] = poses[q + 1]; d[o + 2] = poses[q + 2]; d[o + 3] = poses[q + 10];
      d[o + 4] = poses[q + 3]; d[o + 5] = poses[q + 4]; d[o + 6] = poses[q + 5]; d[o + 7] = poses[q + 6];
      d[o + 8] = poses[q + 7]; d[o + 9] = poses[q + 8]; d[o + 10] = poses[q + 9];
      if (poses[q + 10] >= 1 && this.queue.length) {
        const r = this.pieces.get(i);
        if (r && r.pending && !r.urgent) { r.urgent = true; this.urgent.push(r); }
      }
    }
    this.poseTex.needsUpdate = true;
    this.uniforms.uAhead.value = dtAhead;
    this.uniforms.uTime.value = t;
  }
  // sprays: 15 floats each (see glass_web.cpp); poses: this frame's poses.
  addSprays(sp, poses) {
    this.sprays += Math.floor(sp.length / 15);
    const g = 9.81, floorY = P.floor, tSpray = performance.now();
    for (let o = 0; o + 14 < sp.length; o += 15) {
      const D = this.diceTex.image.data;
      const rec = this.pieces.get(sp[o + 11]);
      if (!rec) continue;
      // Not cut yet: cut it now while this frame has time; otherwise it falls whole.
      if (rec.pending && performance.now() - tSpray < 6) { this.dice(rec); this.flush(); }
      const f = sp[o + 11] * 12;
      const qw = poses[f + 3], qx = poses[f + 4], qy = poses[f + 5], qz = poses[f + 6];
      const born = sp[o + 9], px = sp[o], py = sp[o + 1], pz = sp[o + 2];
      const vx = sp[o + 3], vy = sp[o + 4], vz = sp[o + 5], wx = sp[o + 12], wy = sp[o + 13], wz = sp[o + 14];
      for (const clump of rec.clumps) {
        const d0 = clump[0], o0 = ((d0 / DPR | 0) * DPR * 7 + (d0 % DPR) * 7) * 4;
        // Where the clump's centre is, and how it moves, as the piece lets go.
        const [rx, ry, rz] = quatRotate(qw, qx, qy, qz, D[o0 + 24], D[o0 + 25], 0);
        const cx = px + rx, cy = py + ry, cz = pz + rz;
        const sep = 0.04 + 0.35 * hash01(d0, 31), a = 2 * Math.PI * hash01(d0, 32);
        const [sx, sy, sz] = quatRotate(qw, qx, qy, qz, Math.cos(a) * sep, Math.sin(a) * sep, (hash01(d0, 33) - 0.5) * 0.3);
        const ux = vx + (wy * rz - wz * ry) + sx, uy = vy + (wz * rx - wx * rz) + sy, uz = vz + (wx * ry - wy * rx) + sz;
        const lift = cy - floorY - rec.h;
        const tL = lift > 0.004 ? (uy + Math.sqrt(Math.max(0, uy * uy + 2 * g * lift))) / g : 0;
        const vyL = Math.abs(uy - g * tL);
        for (const di of clump) {
          const od = ((di / DPR | 0) * DPR * 7 + (di % DPR) * 7) * 4, h = (k) => hash01(di, 40 + k);
          // Each die keeps the piece's spin and gets a tumble of its own as it
          // lets go: every one turning its own way, most of them slowly.
          const kick = 2 + 12 * h(4) * h(4), t1 = 2 * Math.PI * h(5), t2 = Math.acos(2 * h(6) - 1);
          const ox = wx + kick * Math.sin(t2) * Math.cos(t1), oy = wy + kick * Math.sin(t2) * Math.sin(t1), oz = wz + kick * Math.cos(t2);
          const spin = Math.min(40, Math.hypot(ox, oy, oz)), ax = ox, ay = oy, az = oz + 1e-6;
          const burst = (0.04 + 0.35 * h(0)) * (0.3 + 0.12 * vyL), b = 2 * Math.PI * h(1);
          D[od] = born; D[od + 1] = tL; D[od + 2] = Math.min(0.9, 0.16 * vyL * (0.3 + 1.2 * h(2))); D[od + 3] = spin;
          D[od + 4] = cx; D[od + 5] = cy; D[od + 6] = cz; D[od + 7] = 2 * Math.PI * h(3);
          D[od + 8] = ux; D[od + 9] = uy; D[od + 10] = uz; D[od + 11] = 0.3 * ux + burst * Math.cos(b);
          D[od + 12] = ax; D[od + 13] = ay; D[od + 14] = az; D[od + 15] = 0.3 * uz + burst * Math.sin(b);
          D[od + 16] = qw; D[od + 17] = qx; D[od + 18] = qy; D[od + 19] = qz;
        }
      }
    }
    this.diceTex.needsUpdate = true;
  }
  dispose() {
    groupPane.remove(this.mesh);
    this.geo.dispose(); this.mat.dispose(); this.diceTex.dispose(); this.poseTex.dispose();
  }
}

// Crushed glass. Each disc of comminuted glass the engine reports is white and
// nearly opaque: a bullet leaves a small dense crater in the struck ply and
// wider, fainter blooms in the plies behind, round a splash of its own lead.
let bloomTex = null;
function bloomTexture() {
  if (bloomTex) return bloomTex;
  const n = 256, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const c = cv.getContext('2d'), h = n / 2;
  const g = c.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(250,252,252,0.97)');
  g.addColorStop(0.68, 'rgba(242,247,247,0.8)');
  g.addColorStop(0.86, 'rgba(236,243,243,0.35)');
  g.addColorStop(1, 'rgba(235,242,242,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, n, n);
  // Crushed grains and the streaks of the cone cracks between them.
  for (let i = 0; i < 1400; ++i) {
    const a = Math.random() * 2 * Math.PI, r = h * Math.pow(Math.random(), 0.7) * 0.9;
    c.fillStyle = Math.random() < 0.25 ? `rgba(120,135,140,${0.25 * Math.random()})` : `rgba(255,255,255,${0.5 * Math.random()})`;
    c.fillRect(h + r * Math.cos(a), h + r * Math.sin(a), 1 + 2 * Math.random(), 1 + 2 * Math.random());
  }
  for (let i = 0; i < 70; ++i) {
    const a = Math.random() * 2 * Math.PI, r0 = h * 0.12, r1 = h * (0.45 + 0.5 * Math.random());
    c.strokeStyle = `rgba(255,255,255,${0.15 + 0.3 * Math.random()})`;
    c.lineWidth = 0.6 + Math.random() * 1.6;
    c.beginPath();
    c.moveTo(h + r0 * Math.cos(a), h + r0 * Math.sin(a));
    c.lineTo(h + r1 * Math.cos(a + 0.05 * (Math.random() - 0.5)), h + r1 * Math.sin(a + 0.05 * (Math.random() - 0.5)));
    c.stroke();
  }
  bloomTex = new THREE.CanvasTexture(cv);
  bloomTex.colorSpace = THREE.SRGBColorSpace;
  return bloomTex;
}
class CrushView {
  constructor() {
    this.count = 0;  // engine records consumed
    this.n = 0;
    this.lead = 0;
    this.discs = [];  // for the 2D view: x, y, r, alpha
    this.at = [];     // per drawn disc: [ply, x, y, r, alpha]
    this.maps = [];   // per glass ply: the engine's cell -> piece map once it is in pieces
    if (!R) return;
    this.cap = 8192;
    const geo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
    geo.instanceCount = 0;
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(this.cap), 1);
    geo.setAttribute('aAlpha', this.alpha);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: bloomTexture() } },
      vertexShader: 'attribute float aAlpha; varying vec2 vUv; varying float vA; void main(){ vUv = uv; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; varying float vA; void main(){ vec4 c = texture2D(map, vUv); gl_FragColor = vec4(c.rgb * 0.92, c.a * vA); }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, this.cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    groupPane.add(this.mesh);
    this.leadMat = new THREE.MeshStandardMaterial({ color: 0x6b6259, metalness: 0.7, roughness: 0.45 });
    this.leadMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 14), this.leadMat, 2048);
    this.leadMesh.count = 0;
    this.leadMesh.frustumCulled = false;
    this.leadMesh.renderOrder = 4;
    groupPane.add(this.leadMesh);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.sc = new THREE.Vector3();
    this.z = new THREE.Vector3(0, 0, 1);
  }
  // rows: 6 floats each (see glass_web.cpp).
  add(rows) {
    this.count += Math.floor(rows.length / 6);
    for (let o = 0; o + 5 < rows.length; o += 6) {
      const g = rows[o], x = rows[o + 1], y = rows[o + 2], r = rows[o + 3], kind = rows[o + 5];
      const pl = P.plies[g];
      if (!pl) continue;
      // The engine gives the crushed cone's radius where it enters each ply;
      // it widens through the ply, and seen from the front the whole cone is
      // white, so each disc is drawn out to about where the cone leaves.
      const depth = fromBack ? P.nGlass - 1 - g : g;
      const alpha = kind === 1 ? 0.95 - 0.06 * Math.min(depth, 4) : 0.75;
      this.discs.push([x, y, r, alpha]);
      if (!R || this.n >= this.cap) continue;
      const [px, py, pz] = toThree(x, y, (pl.z0 + pl.z1) / 2);
      this.v.set(px, py, pz);
      this.q.setFromAxisAngle(this.z, ((x * 7919 + y * 104729) % 1) * 2 * Math.PI);
      const d = (kind === 1 ? 3.4 : 2.4) * r;
      this.sc.set(d, d, 1);
      this.m.compose(this.v, this.q, this.sc);
      this.mesh.setMatrixAt(this.n, this.m);
      this.alpha.array[this.n] = alpha;
      this.at.push([g, x, y, r, alpha]);
      this.n++;
      // (a crater this big is no bullet: nothing of it stays in the glass)
      if (kind === 1 && depth === 0 && r < 0.02 && this.lead < 2048) {
        // The bullet's own lead, flattened into the crater.
        this.v.set(px, py, fromBack ? -(P.T - 0.0005) : -0.0005);
        const s = Math.min(0.009, 0.6 * r);
        this.sc.set(s, s * (0.8 + 0.3 * Math.abs(Math.sin(x * 991))), 1);
        this.m.compose(this.v, this.q, this.sc);
        this.leadMesh.setMatrixAt(this.lead++, this.m);
      }
    }
    if (!R) return;
    this.mesh.count = this.n;
    this.mesh.geometry.instanceCount = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.leadMesh.count = this.lead;
    this.leadMesh.instanceMatrix.needsUpdate = true;
  }
  // Crushed glass goes with the glass round it: once no piece bordering a
  // disc is still in the frame, the disc goes too.
  follow(poses) {
    if (!R || !poses) return;
    let changed = false;
    for (let i = 0; i < this.at.length; ++i) {
      const [g, x, y, r, a0] = this.at[i], m = this.maps[g];
      if (!m) continue;
      let held = false;
      for (let k = 0; k < 8 && !held; ++k) {
        const ang = k * Math.PI / 4, px = x + 1.25 * r * Math.cos(ang), py = y + 1.25 * r * Math.sin(ang);
        const ci = Math.floor(px / m.cell), cj = Math.floor(py / m.cell);
        if (ci < 0 || cj < 0 || ci >= m.nx || cj >= m.ny) continue;
        const piece = m.label[cj * m.nx + ci];
        if (piece >= 0 && 12 * piece + 10 < poses.length && poses[12 * piece + 10] === 0) held = true;
      }
      const a = held ? a0 : 0;
      if (this.alpha.array[i] !== a) { this.alpha.array[i] = a; changed = true; }
    }
    if (changed) this.alpha.needsUpdate = true;
  }
  dispose() {
    if (!R) return;
    groupPane.remove(this.mesh); groupPane.remove(this.leadMesh);
    this.mesh.geometry.dispose(); this.mat.dispose(); this.leadMesh.geometry.dispose(); this.leadMat.dispose();
  }
}

// Deflection lattice shared by the slab, the cracks and the stress view.
const FX = 40, FY = 32;
const deflData = new Uint16Array(FX * FY);
const deflTex = R ? new THREE.DataTexture(deflData, FX, FY, THREE.RedFormat, THREE.HalfFloatType) : null;
if (deflTex) { deflTex.magFilter = deflTex.minFilter = THREE.LinearFilter; deflTex.needsUpdate = true; }
let exaggeration = 1;
let stressOn = false;
const stressCanvas = document.createElement('canvas');
stressCanvas.width = FX; stressCanvas.height = FY;
const stressCtx = stressCanvas.getContext('2d');
const stressTex = R ? new THREE.CanvasTexture(stressCanvas) : null;
if (stressTex) { stressTex.colorSpace = THREE.SRGBColorSpace; stressTex.magFilter = THREE.LinearFilter; }

// Isochromatic fringe colours (white light through crossed polarisers).
const FRINGE = [[0, 0, 0], [0.35, 0.35, 0.36], [0.78, 0.78, 0.8], [0.98, 0.95, 0.75], [0.98, 0.72, 0.3], [0.85, 0.25, 0.25],
  [0.55, 0.15, 0.6], [0.2, 0.3, 0.85], [0.25, 0.75, 0.85], [0.35, 0.85, 0.35], [0.95, 0.9, 0.35], [0.95, 0.45, 0.5]];
function fringe(order) {
  const f = clamp(order, 0, FRINGE.length - 1.001);
  const i = Math.floor(f), u = f - i, a = FRINGE[i], b = FRINGE[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
{
  const lb = $('legendBar');
  lb.style.background = 'linear-gradient(90deg,' + Array.from({ length: 24 }, (_, i) => {
    const c = fringe(i / 23 * 10);
    return `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
  }).join(',') + ')';
}
const FRINGE_MPA = 20;  // stress per fringe order in the view

// opts: glazing (index, else the picked one), tier, quiet (a scene's window:
// no aim marker, readouts or camera move), width and height (m: the glazing
// cut to another size).
function newPane(seed = (Math.random() * 1e9) | 0, keepShots = false, opts = {}) {
  disposePane(P, groupPane);
  const gi = opts.glazing ?? gIdx;
  const t = opts.tier ?? (physCap === null ? PHYS : Math.min(PHYS, physCap));
  const sized = opts.width > 0 && opts.height > 0;
  if (!(sized ? G.gls_new_pane_sized(gi, t, seed, opts.width, opts.height) : G.gls_new_pane(gi, t, seed)))
    throw new Error('could not build the pane');
  const floor = opts.floor ?? -FLOOR;   // pane frame: the ground below the pane's bottom edge
  G.gls_set_floor(floor);
  const s = G.state();
  const g = cat.glazings[gi];
  P = { W: s[14], H: s[15], T: s[13], nGlass: s[2], seed, cracks: [], frags: null, meshes: [], impMeshes: [], nImp: 0,
    shots: keepShots && P ? P.shots : [], shotDefs: [], pendingShots: [], fragShapes: 0, eventsShown: 0, broke: false, announced: new Set(),
    plies: [], monolithic: g.plies.every((p) => p.kind === 'glass'), simClock: 0, fieldTick: 0, glazing: g,
    profile: glassProfile(g), heard: [], broken: [], pieceSize: [], prevVy: new Float32Array(0), viewTier: opts.viewTier, floor };
  const pl = G.plies(P.nGlass);
  for (let k = 0; k < P.nGlass; ++k) {
    P.plies.push({ z0: pl[12 * k], z1: pl[12 * k + 1], ply: pl[12 * k + 10], dicing: pl[12 * k + 5] > 0, ct: pl[12 * k + 6],
      sc: pl[12 * k + 7], dice: pl[12 * k + 8], drawn: pl[12 * k + 9] });
    P.cracks.push(new CrackView((pl[12 * k] + pl[12 * k + 1]) / 2));
  }
  // WebGL2 draws every piece and its real dice on the GPU; older contexts get
  // the CPU pieces and box dice.
  if (R && R.capabilities.isWebGL2) { P.frags = new PieceView(); P.dice = null; }
  else { P.frags = new FragmentView(); P.dice = new DiceView(); }
  P.crush = new CrushView();
  buildSlab();
  if (opts.quiet) return P;
  aim = { x: P.W / 2, y: P.H / 2 };
  placeAimMarker();
  $('log').textContent = '';
  updatePaneInfo();
  frameCamera(false);
  toneNewPane();
  return P;
}

// The intact pane: a deflectable front and back sheet, edges and a frame.
let slab = null, stressMesh = null, aimMarker = null;
function buildSlab() {
  if (!R) return;
  const { W, H, T } = P;
  const geo = new THREE.BufferGeometry();
  const nv = FX * FY;
  const pos = new Float32Array(nv * 2 * 3), uv = new Float32Array(nv * 2 * 2);
  const idx = [];
  for (let side = 0; side < 2; ++side)
    for (let j = 0; j < FY; ++j)
      for (let i = 0; i < FX; ++i) {
        const v = side * nv + j * FX + i;
        pos[3 * v] = W * i / (FX - 1) - W / 2;
        pos[3 * v + 1] = H * j / (FY - 1) + FLOOR;
        pos[3 * v + 2] = side ? -T : 0;
        uv[2 * v] = i / (FX - 1); uv[2 * v + 1] = j / (FY - 1);
      }
  for (let side = 0; side < 2; ++side)
    for (let j = 0; j < FY - 1; ++j)
      for (let i = 0; i < FX - 1; ++i) {
        const a = side * nv + j * FX + i, b = a + 1, c = a + FX, d = c + 1;
        if (side) idx.push(a, b, d, a, d, c); else idx.push(a, d, b, a, c, d);
      }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if (glassMat.thickness !== undefined) glassMat.thickness = T;
  slab = new THREE.Mesh(geo, glassMat);
  slab.renderOrder = 1;
  slab.castShadow = false;
  groupPane.add(slab);
  P.meshes.push(slab);
  // Edges: glass is green edge-on (iron oxide), interlayers show as a pale line.
  const edgeGeo = new THREE.BufferGeometry();
  const e = [], ec = [];
  const quad = (x0, y0, x1, y1) => {
    e.push(x0, y0, 0, x1, y1, 0, x1, y1, -T, x0, y0, 0, x1, y1, -T, x0, y0, -T);
    for (let k = 0; k < 6; ++k) ec.push(0.35, 0.68, 0.55);
  };
  const xl = -W / 2, xr = W / 2, yb = FLOOR, yt = FLOOR + H;
  quad(xl, yb, xr, yb); quad(xr, yb, xr, yt); quad(xr, yt, xl, yt); quad(xl, yt, xl, yb);
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(e, 3));
  edgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(ec, 3));
  edgeGeo.computeVertexNormals();
  const edges = new THREE.Mesh(edgeGeo, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.7, roughness: 0.1, side: THREE.DoubleSide }));
  groupPane.add(edges);
  P.meshes.push(edges);
  P.edges = edges;
  // Frame: an aluminium rebate around the pane, on two feet.
  const fw = 0.035, fd = Math.max(0.05, T + 0.03);
  const boxes = [];
  const bar = (w, h, x, y) => {
    boxes.push([w, h, fd, x, y, -T / 2]);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, fd), frameMat);
    m.position.set(x, y, -T / 2);
    m.castShadow = m.receiveShadow = tier >= 3;
    m.userData.lab = true;
    groupPane.add(m);
    P.meshes.push(m);
  };
  bar(W + 2 * fw, fw, 0, FLOOR - fw / 2); bar(W + 2 * fw, fw, 0, FLOOR + H + fw / 2);
  bar(fw, H, -W / 2 - fw / 2, FLOOR + H / 2); bar(fw, H, W / 2 + fw / 2, FLOOR + H / 2);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, FLOOR - fw, 0.05), frameMat);
    leg.position.set(sx * (W / 2 + fw / 2), (FLOOR - fw) / 2, -T / 2);
    boxes.push([0.05, FLOOR - fw, 0.05, sx * (W / 2 + fw / 2), (FLOOR - fw) / 2, -T / 2], [0.08, 0.03, 0.6, sx * (W / 2 + fw / 2), 0.015, -T / 2]);
    leg.userData.lab = true;
    groupPane.add(leg); P.meshes.push(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 0.6), frameMat);
    foot.position.set(sx * (W / 2 + fw / 2), 0.015, -T / 2);
    foot.userData.lab = true;
    groupPane.add(foot); P.meshes.push(foot);
  }
  // Below High there is no shadow map: the frame's shadow is drawn on the floor once.
  if (tier < 3) {
    const sh = bakedShadow(boxes);
    sh.userData.lab = true;
    groupPane.add(sh);
    P.meshes.push(sh);
  }
  // Stress view: the front sheet again, drawn with the fringe texture.
  const front = new THREE.BufferGeometry();
  front.setAttribute('position', geo.attributes.position);
  front.setAttribute('uv', geo.attributes.uv);
  front.setIndex(idx.slice(0, (FX - 1) * (FY - 1) * 6));
  stressMesh = new THREE.Mesh(front, new THREE.MeshBasicMaterial({ map: stressTex, transparent: true, opacity: 0.9, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }));
  stressMesh.visible = overlayOn();
  stressMesh.renderOrder = 4;
  groupPane.add(stressMesh);
  P.meshes.push(stressMesh);
  aimMarker = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.016, 32), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.9, depthTest: false }));
  aimMarker.renderOrder = 6;
  aimMarker.userData.lab = true;
  groupPane.add(aimMarker);
  P.meshes.push(aimMarker);
}
// Soft shadows for tiers without a shadow map: the frame's, baked once for
// the pane, and a blob under each impactor that follows it.
const KEY_DIR = new THREE.Vector3(-2.5, 4.5, 3.5).normalize();   // toward the key light
function onFloor(x, y, z) { const k = y / KEY_DIR.y; return [x - KEY_DIR.x * k, z - KEY_DIR.z * k]; }
function hull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function bakedShadow(boxes) {
  const N = 512, span = 6, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const px = ([x, z]) => [(x / span + 0.5) * N, (z / span + 0.5) * N];
  const draw = (dx, dy, a) => {
    g.globalAlpha = a;
    for (const [w, h, d, x, y, z] of boxes) {
      const pts = [];
      for (const ax of [-0.5, 0.5]) for (const ay of [-0.5, 0.5]) for (const az of [-0.5, 0.5]) pts.push(px(onFloor(x + ax * w, y + ay * h, z + az * d)));
      g.beginPath();
      hull(pts).forEach(([u, v], i) => (i ? g.lineTo(u + dx, v + dy) : g.moveTo(u + dx, v + dy)));
      g.closePath();
      g.fill();
    }
  };
  g.fillStyle = '#fff';
  // A soft edge, as a shadow map's filtering gives (canvas blur where there is one).
  if ('filter' in g) { g.filter = 'blur(5px)'; draw(0, 0, 1); }
  else for (const [dx, dy] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) draw(dx, dy, 0.35);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(span, span),
    new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: tex, transparent: true, opacity: 0.2, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.002;
  m.renderOrder = 0;
  return m;
}
let blobTex = null;
function impactorBlob() {
  if (!blobTex) {
    const n = 64, c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d'), gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, n, n);
    blobTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: blobTex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 0;
  return m;
}
function placeAimMarker() {
  if (!aimMarker || !aim) return;
  aimMarker.position.set(aim.x - P.W / 2, aim.y + FLOOR, fromBack ? -P.T - 0.002 : 0.002);
  const s = Math.max(0.6, Math.min(P.W, P.H) / 0.8);
  aimMarker.scale.set(s, s, s);
}

// ---------- Impactor meshes ----------
let glowTex = null;
function glowDot() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
function impactorMesh(def) {
  const g = new THREE.Group();  // +Z is the travel direction
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0, ...o });
  const steel = std(0xc9cdd3, { metalness: 1, roughness: 0.18 });
  const r = def.radius, L = def.length || 2 * r;
  let body;
  switch (def.id) {
    case 'baseball': {
      body = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), std(0xf3efe6, { roughness: 0.75 }));
      const seam = new THREE.Mesh(new THREE.TorusGeometry(r * 1.002, r * 0.04, 6, 48), std(0xc4302b));
      seam.rotation.x = 0.5;
      g.add(seam);
      break;
    }
    case 'hand_grenade': {
      body = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), std(0x4b5233, { roughness: 0.55, metalness: 0.3 }));
      const fuse = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.34, r, 12), std(0x777b70, { metalness: 0.8, roughness: 0.35 }));
      fuse.position.y = r * 1.2;
      g.add(fuse);
      break;
    }
    case 'cannonball_9lb': body = new THREE.Mesh(new THREE.SphereGeometry(r, 36, 20), std(0x2b2a29, { metalness: 0.55, roughness: 0.62 })); break;
    case 'glass_shard': body = new THREE.Mesh(new THREE.TetrahedronGeometry(r), std(0xcfe8ef, { transparent: true, opacity: 0.6, roughness: 0.05, metalness: 0.1, flatShading: true })); break;
    case 'grenade_fragment': body = new THREE.Mesh(new THREE.TetrahedronGeometry(r * 1.3), std(0x3c3a38, { metalness: 0.7, roughness: 0.5, flatShading: true })); break;
    case 'buckshot_00': body = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), std(0x8e9196, { metalness: 0.6, roughness: 0.45 })); break;
    case 'golf_ball': body = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 3), std(0xffffff, { roughness: 0.35, flatShading: true })); break;
    case 'hail_50': body = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), std(0xd8f0ff, { roughness: 0.25, transparent: true, opacity: 0.8 })); break;
    case 'stone': body = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 0.9, 0), std(0x8a8580, { roughness: 0.9, flatShading: true })); break;
    case 'brick': {
      body = new THREE.Mesh(new THREE.BoxGeometry(0.215, 0.065, 0.1025), std(0xa2452f, { roughness: 0.95 }));
      body.rotation.set(0.6, 0.7, 0.3);
      body.position.z = -0.03;
      break;
    }
    case 'hammer': {
      body = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.11, 24), steel);
      body.rotation.x = Math.PI / 2;
      body.position.z = -0.04;
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.33, 12), std(0x3a2a1e));
      handle.position.set(0, -0.17, -0.04);
      g.add(handle);
      break;
    }
    case 'headform': body = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 20), std(0xd9b38c, { roughness: 0.6 })); break;
    case 'body_bag': body = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), std(0x5b3b24, { roughness: 0.85 })); break;
    case 'timber_2x4': {
      body = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.089, L), std(0xc9a46a, { roughness: 0.9 }));
      break;
    }
    case 'window_punch': {
      body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L * 0.9, 20), std(0xd84a2a, { roughness: 0.4 }));
      body.rotation.x = Math.PI / 2;
      body.position.z = -L * 0.05;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(r * 0.4, L * 0.1, 16), steel);
      tip.rotation.x = Math.PI / 2;
      tip.position.z = L * 0.45;
      g.add(tip);
      break;
    }
    case 'bird_4lb': body = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14), std(0x8c6a4f, { roughness: 0.7, transparent: true, opacity: 0.92 }));
      body.scale.set(r, r, L / 2);
      break;
    default:
      if (def.kind === 'projectile') {
        const mat = std(def.id === 'magnum_44' ? 0x8f8f95 : 0xc87533, { metalness: 0.9, roughness: 0.3 });
        body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L * 0.6, 16), mat);
        body.rotation.x = Math.PI / 2;
        body.position.z = -L * 0.2;
        const nose = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat);
        nose.rotation.x = Math.PI / 2;
        nose.scale.set(1, (L * 0.4) / r, 1);
        nose.position.z = L * 0.1;
        g.add(nose);
      } else {
        body = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), steel);
      }
  }
  body.castShadow = tier >= 3;
  g.add(body);
  g.userData.body = body;
  // Something this small and fast gets a glow so the eye can follow it.
  if (def.kind === 'projectile' || def.id === 'bb' || def.id === 'stone') {
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowDot(), color: 0xffd36b, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(0.02, 0.02, 1);
    g.add(glow);
    g.userData.glow = glow;
  }
  return g;
}

// ---------- Firing ----------
function fire(at = aim, record = true) {
  if (!P) return;
  const def = cat.impactors[iIdx];
  const lead = clamp(0.25 + 0.0015 * speed, 0.25, 0.9);
  const t = G.gls_time();
  const h = G.gls_fire(iIdx, at.x, at.y, speed, yaw * Math.PI / 180, pitch * Math.PI / 180, fromBack ? 1 : 0, lead);
  if (h < 0) return;
  if (record) P.shots.push({ t, iIdx, x: at.x, y: at.y, speed, yaw, pitch, fromBack });
  // A shot load fires several pellets; they follow the first one's index.
  const n = Math.max(h + 1, G.state()[3]);
  for (let k = h; k < n; ++k) {
    P.shotDefs[k] = iIdx;
    P.announced.delete(k);
    if (R) {
      const m = impactorMesh(def);
      groupPane.add(m);
      P.impMeshes[k] = m;
      if (tier < 3 && !rigs && !activeScene()) {
        const b = impactorBlob();
        m.userData.blob = b;
        groupPane.add(b);
        P.meshes.push(b);
      }
    }
  }
  P.nImp = n;
  P.lastShot = h;
  if (GRENADES[def.id] && !rigs) armGrenade(h, def.id);
  if (auto) { scaleNow = Math.min(scaleNow, approachScale(def, lead)); }
  playing = true;
  syncPlay();
  $('rWhat').textContent = `${def.name} · ${fmtSpeed(speed)}`;
}
function approachScale(def, lead) {
  const tFlight = lead / Math.max(speed, 0.1);
  return clamp(tFlight / 0.9, 1e-5, 1);
}

function replay() {
  if (HS && HS.active) { HS.restart(true); return; }
  if (stackOn) {
    const shots = rigs[0].P.shots.slice();
    if (!shots.length) { toast('Nothing to replay yet'); return; }
    buildStack(rigs.map((r) => r.P.seed));
    P.shots = shots;
    P.pendingShots = shots.slice();
    simClockReset();
    return;
  }
  if (P && P.nis && !P.shots.length) { const n = P.nis; newPane(P.seed); simClockReset(); plantStone(n, 0.4); return; }
  if (!P || !P.shots.length) { toast('Nothing to replay yet'); return; }
  const shots = P.shots.slice();
  newPane(P.seed, true);
  if (GT && GT.active) GT.attach(P, P.seed, shots[0].iIdx);
  P.shots = shots;
  P.pendingShots = shots.slice();
  simClockReset();
}

// ---------- Time ----------
let playing = true, auto = store.get('auto', true), scaleManual = store.get('scale', 1e-3), scaleNow = 1;
let msPerStep = 0.003, limited = false;
function simClockReset() { P.simClock = G.gls_time(); }
function syncPlay() { $('bPlay').textContent = playing ? 'Pause' : 'Play'; $('bPlay').setAttribute('aria-pressed', String(!playing)); }
function buildScaleButtons() {
  const box = $('scale');
  box.textContent = '';
  for (const [s, label] of SCALES) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = s === 1 ? 'Real time' : `1 second on screen = ${fmtTime(s)} of glass`;
    b.setAttribute('aria-pressed', String(!auto && Math.abs(Math.log10(s) - Math.log10(scaleManual)) < 0.01));
    b.onclick = () => { auto = false; scaleManual = s; store.set('auto', false); store.set('scale', s); buildScaleButtons(); syncAuto(); };
    box.appendChild(b);
  }
}
function syncAuto() { $('bAuto').setAttribute('aria-pressed', String(auto)); }

// What the bullet-time controller wants now.
// ---------- The lab's grenades ----------
// A hand grenade goes off `fuse` s after it leaves the hand, wherever it is
// then; a 40 mm round the instant it touches. Their steel fragments and their
// blast wave load the pane (blast.js: free-air TNT, reflected off the glass,
// arriving at the shock's speed), and the engine breaks the glass. The lab is
// a big open hall: no room gas.
const GRENADES = {
  hand_grenade: { fuse: 1.5, tnt: 0.22, frags: 800, label: 'Hand grenade' },     // ~180 g Composition B
  grenade_40mm: { impact: true, tnt: 0.04, frags: 300, label: '40 mm grenade' },   // ~32 g Composition B
};
function armGrenade(k, id) {
  const g = GRENADES[id];
  (P.grenades ||= []).push({ k, id, t: g.impact ? Infinity : G.gls_time() + g.fuse, done: false });
}
// Impact fuses: the first moment the round touches the glass.
function checkImpactFuses() {
  if (!P.grenades) return;
  const imps = G.impactors(P.nImp);
  for (const gr of P.grenades) {
    if (gr.done || gr.t < Infinity) continue;
    const o = 20 * gr.k, ph = imps[o + 9];
    if (ph === PH.CONTACT || ph === PH.BALLISTIC || imps[o + 17] !== 0 || imps[o + 18] !== 0) gr.t = G.gls_time();
  }
}
function grenadeDue() {
  let t = Infinity;
  for (const g of P.grenades || []) if (!g.done) t = Math.min(t, g.t);
  return t;
}
function detonateGrenades(tEng) {
  for (const gr of P.grenades || []) {
    if (gr.done || tEng < gr.t - 1e-9) continue;
    gr.done = true;
    const spec = GRENADES[gr.id], GRENADE_TNT = spec.tnt, GRENADE_FRAGS = spec.frags;
    const imps = G.impactors(P.nImp), o = 20 * gr.k;
    const x = imps[o], y = imps[o + 1], z = imps[o + 2];             // pane frame
    const dx = P.W / 2 - x, dy = P.H / 2 - y, dz = P.T / 2 - z;
    const far = Math.max(0.15, Math.hypot(dx, dy, dz)), cosI = Math.abs(dz) / far;
    const front = z < P.T / 2;                                       // in front: pushes toward the back face
    const L = paneLoad(GRENADE_TNT, far, cosI);
    G.gls_blast(gr.t + L.arrival, (front ? 1 : -1) * L.peak, L.td, L.decay, 0, 1e-3, 0);
    // The steel that reaches the glass, each splinter an engine projectile.
    const rnd = mulberry32((P.seed ^ (gr.k * 7919)) >>> 0), fi = cat.impactors.findIndex((d) => d.id === 'grenade_fragment');
    const n = fragmentsThrough(rnd, GRENADE_FRAGS, P.W * P.H, cosI, far, 10);
    for (let i = 0; i < n && fi >= 0; ++i) {
      const hx = 0.03 + (P.W - 0.06) * rnd(), hy = 0.03 + (P.H - 0.06) * rnd(), hz = front ? 0 : P.T;
      const d = [hx - x, hy - y, hz - z], dist = Math.hypot(...d);
      const dp = front ? [d[0] / dist, d[1] / dist, d[2] / dist] : [d[0] / dist, d[1] / dist, -d[2] / dist];
      if (dp[2] < 0.25) continue;
      const v = 1400 * (0.9 + 0.2 * rnd()), sh = { t: gr.t + Math.max(0, dist - 0.9) / v, iIdx: fi, x: hx, y: hy, speed: v,
        yaw: Math.atan2(dp[0], dp[2]) * 180 / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, dp[1]))) * 180 / Math.PI, fromBack: !front };
      const q = P.pendingShots; let j = q.length; while (j > 0 && q[j - 1].t > sh.t) --j; q.splice(j, 0, sh);
    }
    if (P.impMeshes[gr.k]) P.impMeshes[gr.k].visible = false;
    if (R) (P.blastFX ||= []).push(createBlastFX(THREE, groupPane, new THREE.Vector3(x - P.W / 2, y + FLOOR, -z), gr.t,
      { W: GRENADE_TNT, seed: P.seed + gr.k, scale: 0.8 }));
    sound.explosion(panAt(x, y));
    $('rWhat').textContent = `${spec.label} · went off ${(far * 100).toFixed(0)} cm from the glass centre · ${(L.peak / 1000).toFixed(0)} kPa on the glass`;
  }
}
// Bullet time round a grenade: crawl through the shock and the first
// milliseconds, then ease out as the glass flies.
function grenadeTarget(tEng) {
  let s = 1;
  for (const gr of P.grenades || []) {
    const a = tEng - gr.t;
    if (a > -0.004 && a < 0.008) s = Math.min(s, 1 / 600);
    else if (a >= 0.008 && a < 0.06) s = Math.min(s, 1 / 80);
    else if (a >= 0.06 && a < 0.6) s = Math.min(s, 1 / 8);
  }
  return s;
}
function autoTarget(imps, plies) {
  return Math.min(autoTargetBase(imps, plies), grenadeTarget(G.gls_time()));
}
function autoTargetBase(imps, plies) {
  let approach = Infinity, contact = false, membrane = false;
  for (let k = 0; k < P.nImp; ++k) {
    const o = 20 * k, phase = imps[o + 9];
    if (phase === PH.CONTACT || phase === PH.BALLISTIC) contact = true;
    if (phase === PH.MEMBRANE) membrane = true;
    if (phase === PH.FLIGHT) {
      const side = imps[o + 16], vz = imps[o + 5];
      if (side * vz > 0) {
        const def = cat.impactors[P.shotDefs?.[k] ?? iIdx];
        const nose = def.kind === 'sphere' ? def.radius : (def.length ? def.length / 2 : def.radius);
        const face = side > 0 ? 0 : P.T;
        const gap = side * (face - (imps[o + 2] + side * nose));
        if (gap > -0.01) approach = Math.min(approach, Math.max(0, gap) / Math.abs(vz));
      }
    }
  }
  let tips = 0;
  for (let k = 0; k < P.nGlass; ++k) tips += plies[12 * k + 11];
  if (contact || tips > 0) return 1 / 5000;
  // A note building up to break the glass: slow enough to watch it swing.
  if (TONE.on) return TONE_SLOW;
  if (membrane) return 1 / 400;
  if (approach < Infinity) return clamp(approach / 0.8, 1 / 5000, 1);
  const s = G.state();
  // Quarter speed while the glass is coming down, not for the last strays.
  if (s[12] > 30 && !s[1]) return 0.25;
  return 1;
}

// ---------- Readouts ----------
function updatePaneInfo() {
  const g = cat.glazings[gIdx];
  $('gDims').textContent = `${(P?.W ?? g.width).toFixed(2)} × ${(P?.H ?? g.height).toFixed(2)} m · ${(g.thickness * 1e3).toFixed(1)} mm`;
  const st = $('stack');
  st.textContent = '';
  for (const p of g.plies) {
    const i = document.createElement('i');
    i.className = p.kind + (p.treatment === 'fully tempered' ? ' tempered' : p.treatment === 'chemically strengthened' ? ' chem' : '');
    i.style.flex = String(p.thickness);
    i.title = `${p.material} ${(p.thickness * 1e3).toFixed(2)} mm${p.kind === 'glass' ? ' · ' + p.treatment : ''}${p.surfaceCompression ? ` · ${(p.surfaceCompression / 1e6).toFixed(0)} MPa surface compression` : ''}`;
    st.appendChild(i);
  }
  $('gDesc').textContent = g.description;
  $('gStd').textContent = g.standard + (g.pressure ? ` · ${(-g.pressure / 1e3).toFixed(1)} kPa cabin pressure` : '');
}

function updateReadouts(final) {
  if (!P) return;
  const s = G.state();
  const kv = [];
  const k = P.lastShot ?? -1;
  if (k >= 0) {
    const r = G.report(k), v = r.v;
    const out = $('outcome');
    out.textContent = (r.outcome || (v[5] >= 0 ? 'In contact…' : 'On its way…')).replace(/(\d+(?:\.\d+)?) m\/s/g, (m, x) => fmtSpeed(+x));
    out.className = v[11] ? 'bad' : v[10] ? 'warn' : r.outcome ? 'ok' : '';
    if (P.scores && P.scores.length && s[6] && r.outcome) {
      // The score let go (often as the pane rang down, after the knock).
      const loop = P.scores.some((sc) => sc.closed);
      out.textContent = loop ? 'The score gave way: the crack ran round it and the disc dropped out' : 'The score gave way: the glass snapped along it';
      out.className = 'warn';
    }
    kv.push(['Impact speed', fmtSpeed2(v[0])]);
    kv.push(['Kinetic energy', v[2] < 10 ? `${v[2].toFixed(2)} J` : `${v[2].toFixed(0)} J`]);
    if (v[4] > 0) kv.push(['Peak force', v[4] >= 1e3 ? `${(v[4] / 1e3).toFixed(2)} kN` : `${v[4].toFixed(0)} N`]);
    if (v[6] > 0) kv.push(['Contact time', fmtTime(v[6])]);
    if (v[7] > 0) kv.push(['Peak stress at load', `${(v[7] / 1e6).toFixed(0)} MPa`]);
    if (r.outcome) kv.push(['Energy absorbed', `${Math.max(0, v[3]).toFixed(v[3] < 10 ? 2 : 0)} J`]);
    if (r.outcome && v[1] > 0) kv.push(['Leaves at', fmtSpeed(v[1])]);
    if (v[8] > 0) kv.push(['Depth reached', `${(v[8] * 1e3).toFixed(1)} mm of ${(P.T * 1e3).toFixed(1)}`]);
    if (v[9] > 0.0005) kv.push(['Bulge', `${(v[9] * 1e3).toFixed(0)} mm`]);
    const verdict = P.test && (r.outcome || (P.test === 'z97' && s[6])) ? testVerdict(P.test, v, s) : null;
    if (verdict) {
      kv.unshift(['Test', `<span style="color:var(--${verdict.pass ? 'good' : 'bad'})">${verdict.pass ? 'PASS' : 'FAIL'}</span> · ${verdict.name}`]);
      kv.push(['Why', verdict.why]);
    }
  } else if (P.nis && P.nis.text) {
    const out = $('outcome');
    out.textContent = P.nis.text;
    out.className = P.nis.broke ? 'bad' : 'ok';
  } else if (TONE.on || TONE.broke) {
    const out = $('outcome');
    out.textContent = TONE.broke ? TONE.brokeText : `Playing ${fmtHz(TONE.freq)} at the glass…`;
    out.className = TONE.broke ? 'bad' : '';
  }
  if (P.puzzle) {
    // The puzzle says what it needs; the shots' numbers would give it away.
    $('outcome').textContent = P.puzzle.text;
    $('outcome').className = P.puzzle.cls || '';
    if (P.puzzle.phase !== 'done') kv.length = 0;
  }
  $('kv').innerHTML = kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
  // Plies
  const pl = G.plies(P.nGlass);
  const g = P.glazing;
  let html = '', gi = 0;
  g.plies.forEach((p, idx) => {
    const label = `${idx + 1}. ${p.kind === 'glass' ? 'glass' : p.kind} ${(p.thickness * 1e3).toFixed(p.thickness < 0.001 ? 2 : 1)} mm`;
    if (p.kind !== 'glass') { html += `<div><span>${label}</span><b>${p.material.split(' ')[0]}</b></div>`; return; }
    const segs = pl[12 * gi + 2], cell = pl[12 * gi + 3], frag = pl[12 * gi + 4] > 0;
    const len = segs * cell;
    const what = frag ? 'in pieces' : segs ? `${len.toFixed(2)} m of cracks` : 'intact';
    html += `<div><span>${label} · ${p.treatment}</span><b>${what}</b></div>`;
    ++gi;
  });
  $('plies').innerHTML = html;
  // Pane
  const pv = [];
  pv.push(['Visibility', `${(s[10] * 100).toFixed(0)} %`]);
  if (s[9] > 1e-6) pv.push(['Open area', `${(s[9] * 1e4).toFixed(s[9] < 1e-3 ? 1 : 0)} cm²`]);
  pv.push(['Barrier', s[8] ? 'intact' : 'breached']);
  if (s[11] > 0.001) pv.push(['Interlayer bulge', `${(s[11] * 1e3).toFixed(0)} mm`]);
  if (s[12] > 0) pv.push(['Loose pieces', String(s[12])]);
  const tp = P.plies.find((p) => p.dicing);
  if (tp && pl[4] > 0) {
    // ECE R43 / EN 12150 count: fragments in the densest 50 x 50 mm square near the origin.
    let best = 0;
    for (const [dx, dy] of [[0.1, 0.1], [-0.1, 0.1], [0.1, -0.1], [-0.1, -0.1], [0.15, 0]]) {
      const x = clamp(P.W / 2 + dx, 0.03, P.W - 0.03), y = clamp(P.H / 2 + dy, 0.03, P.H - 0.03);
      best = Math.max(best, G.gls_count_fragments(0, x, y, 0.05));
    }
    const real = tp.dice > 0 ? Math.round(0.0025 / (tp.dice * tp.dice)) : 0;
    pv.push(['Dice (real glass)', `≈${(tp.dice * 1e3).toFixed(1)} mm · ≈${real} per 50 mm square`]);
    if (tp.drawn > tp.dice * 1.05) pv.push(['Dice simulated', `${(tp.drawn * 1e3).toFixed(0)} mm, drawn as their real dice`]);
    pv.push(['ECE R43 window', real >= 40 && real <= 400 ? 'within 40–400 ✓' : 'outside 40–400']);
  }
  pv.push(['Plate', `${s[16].toFixed(1)} Hz fundamental · ${s[18]}×${s[19]} modes to ${(s[17] / 1e3).toFixed(1)} kHz`]);
  pv.push(['Physics', `${(s[20] * 1e3).toFixed(1)} mm crack grid · the same on every device`]);
  pv.push(['Drawing', `${TIER_NAMES[tier]}${G.remote ? ' · physics on its own core' : ''}`]);
  $('pane').innerHTML = pv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
  // Events
  if (s[21] > P.eventsShown) {
    const ev = G.events(P.eventsShown);
    P.eventsShown = s[21];
    const log = $('log');
    log.textContent += ev.join('\n') + '\n';
    log.scrollTop = log.scrollHeight;
  }
}

// Announce what happened to each shot once.
function announce() {
  if (activeScene()) return;
  if (P.puzzle) { for (let k = 0; k < P.nImp; ++k) P.announced.add(k); return; }   // no spoilers
  for (let k = 0; k < P.nImp; ++k) {
    if (P.announced.has(k)) continue;
    // Shards from another pane of a stack are not the shot: no banner for them.
    if (P.shotDefs[k] === shardIdx) { P.announced.add(k); continue; }
    const r = G.report(k), v = r.v;
    if (!r.outcome) continue;
    P.announced.add(k);
    let title = 'Held';
    if (v[13]) title = 'Stopped';
    else if (v[14]) title = 'Shattered';
    else if (v[11]) title = 'Penetrated';
    else if (v[10]) title = 'Cracked';
    banner(title, r.outcome);
  }
}

// ---------- Field (deflection + stress) ----------
function updateField() {
  const f = G.field(0, FX, FY);
  let maxW = 0;
  for (let i = 0; i < FX * FY; ++i) {
    deflData[i] = THREE.DataUtils.toHalfFloat(f[i]);
    maxW = Math.max(maxW, Math.abs(f[i]));
  }
  if (deflTex) deflTex.needsUpdate = true;
  if (slab) {
    const pos = slab.geometry.attributes.position.array, nv = FX * FY;
    for (let i = 0; i < nv; ++i) {
      const w = f[i] * exaggeration;
      pos[3 * i + 2] = -w;
      pos[3 * (nv + i) + 2] = -P.T - w;
    }
    slab.geometry.attributes.position.needsUpdate = true;
    if (maxW * exaggeration > 1e-4) slab.geometry.computeVertexNormals();
  }
  toneField(f);
  if (stressOn) {
    const img = stressCtx.createImageData(FX, FY);
    let smax = 0;
    for (let j = 0; j < FY; ++j)
      for (let i = 0; i < FX; ++i) {
        const sBack = f[2 * FX * FY + j * FX + i], sFront = f[FX * FY + j * FX + i];
        const sig = Math.max(sBack, sFront, 0) / 1e6;
        smax = Math.max(smax, sig);
        const c = fringe(sig / FRINGE_MPA);
        const o = ((FY - 1 - j) * FX + i) * 4;
        img.data[o] = c[0] * 255; img.data[o + 1] = c[1] * 255; img.data[o + 2] = c[2] * 255; img.data[o + 3] = 235;
      }
    stressCtx.putImageData(img, 0, 0);
    if (stressTex) stressTex.needsUpdate = true;
    $('legendMax').textContent = `${(FRINGE_MPA * 10).toFixed(0)} MPa (peak now ${smax.toFixed(0)})`;
  }
  return maxW;
}

// ---------- Camera ----------
const cam = { theta: -0.55, phi: 1.32, r: 2.6, tx: 0, ty: 1.4, tz: 0 };
if (R) GT = createGTScene({ THREE, scene, groupPane, camera, cam, applyCamera, FLOOR, tier, labObjects, leave: () => leaveScene(true), layout: resize,
  glassSound: () => sound.live, soundOn: () => sound.enabled, toggleSound: () => $('bSound').click() });
if (R) HS = createHouseScene({ THREE, scene, camera, cam, applyCamera, FLOOR, tier, labObjects, leave: () => leaveScene(true), layout: resize,
  renderer: R, toast, G, cat, sound, impactorMesh, soundOn: () => sound.enabled, toggleSound: () => $('bSound').click(),
  makeRigs, useRig, setClock: (next, target) => { multiNext = next; multiTarget = target; },
  autoTargetOf: (r) => { useRig(r); return autoTarget(G.impactors(P.nImp), G.plies(P.nGlass)); },
  insertShot: (r, sh) => { const q = r.P.pendingShots; let i = q.length; while (i > 0 && q[i - 1].t > sh.t) --i; q.splice(i, 0, sh); } });
let camMode = 0;
function frameCamera(keepAngles = true) {
  if (activeScene()) { activeScene().frameCamera(); return; }
  const depth = stackDepthTotal();
  const m = Math.max(P.W, P.H, 0.8 * depth);
  cam.tx = 0; cam.ty = FLOOR + P.H / 2; cam.tz = -depth / 2;
  if (!keepAngles) {
    const presets = [[-0.55, 1.32, 2.2], [0, Math.PI / 2 - 0.02, 1.9], [-1.25, 1.42, 2.0]];
    const [t, p, r] = presets[camMode];
    // Fit the pane's width on narrow (portrait) screens too.
    const fit = Math.max(1, (P.W / Math.max(P.H, 1e-3)) / Math.max(camera.aspect, 0.3) * 0.8);
    cam.theta = t; cam.phi = p; cam.r = r * m * fit + 0.4;
  }
  applyCamera();
}
function applyCamera() {
  cam.phi = clamp(cam.phi, 0.25, Math.PI - 0.6);
  cam.r = clamp(cam.r, 0.2, 12);
  const sp = Math.sin(cam.phi);
  camera.position.set(cam.tx + cam.r * sp * Math.sin(cam.theta), cam.ty + cam.r * Math.cos(cam.phi), cam.tz + cam.r * sp * Math.cos(cam.theta));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
}

// ---------- Input ----------
const ray = new THREE.Raycaster();
function panePointFromEvent(ev) {
  const rect = (flat ? canvas2d : canvas).getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  if (flat) {
    const v = view2d();
    return { x: (x - v.ox) / v.s, y: (v.oy - y) / v.s };
  }
  const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  // Into the pane group's frame (the pane may be mounted in a car).
  const inv = new THREE.Matrix4().copy(groupPane.matrixWorld).invert();
  const local = ray.ray.clone().applyMatrix4(inv);
  const zPlane = fromBack ? -P.T : 0;
  const o = local.origin, d = local.direction;
  if (Math.abs(d.z) < 1e-6) return null;
  const t = (zPlane - o.z) / d.z;
  if (t <= 0) return null;
  return { x: o.x + d.x * t + P.W / 2, y: o.y + d.y * t - FLOOR };
}
const pointers = new Map();
let drag = null, pinch0 = 0;
const surface = flat ? canvas2d : canvas;
surface.addEventListener('pointerdown', (e) => {
  if (cutMode && P && !rigs && !activeScene()) {
    const p = panePointFromEvent(e);
    if (p && p.x > 0 && p.y > 0 && p.x < P.W && p.y < P.H) {
      surface.setPointerCapture(e.pointerId);
      if (cutMode === 'circle') { addScore(circlePts(p, 0.1), true); setCutMode('circle'); }
      else cutLine = { id: e.pointerId, pts: [p] };
      return;
    }
  }
  surface.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, theta: cam.theta, phi: cam.phi };
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); drag = null; }
});
surface.addEventListener('pointermove', (e) => {
  if (cutLine && e.pointerId === cutLine.id) {
    const p = panePointFromEvent(e), last = cutLine.pts[cutLine.pts.length - 1];
    if (p && p.x > 0 && p.y > 0 && p.x < P.W && p.y < P.H && Math.hypot(p.x - last.x, p.y - last.y) > 0.005) cutLine.pts.push(p);
    return;
  }
  if (!pointers.has(e.pointerId)) {
    if (e.pointerType === 'mouse' && P) {
      const p = panePointFromEvent(e);
      surface.style.cursor = p && p.x > 0 && p.y > 0 && p.x < P.W && p.y < P.H ? 'crosshair' : 'grab';
    }
    return;
  }
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch0 > 0) { cam.r *= pinch0 / d; pinch0 = d; applyCamera(); }
    return;
  }
  if (drag) {
    drag.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
    if (!flat && drag.moved > 6) {
      cam.theta = drag.theta - (e.clientX - drag.x) * 0.006;
      cam.phi = drag.phi - (e.clientY - drag.y) * 0.006;
      applyCamera();
    }
  }
});
function endPointer(e) {
  if (cutLine && e.pointerId === cutLine.id) {
    const pts = cutLine.pts;
    cutLine = null;
    if (pts.length >= 2) { addScore(pts, false); setCutMode('line'); }
    return;
  }
  pointers.delete(e.pointerId);
  // A tap in the shop picks the pane to throw through.
  if (drag && drag.moved <= 6 && performance.now() - drag.t < 450 && HS && HS.active) {
    const rect = canvas.getBoundingClientRect();
    HS.pick(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }
  if (drag && drag.moved <= 6 && performance.now() - drag.t < 450 && P && P.puzzle && P.puzzle.phase !== 'done') {
    puzzleTap(panePointFromEvent(e));
    drag = null;
    return;
  }
  if (drag && drag.moved <= 6 && performance.now() - drag.t < 450 && P && (!rigs || stackOn)) {
    if (stackOn) useRig(rigs[0]);
    const p = panePointFromEvent(e);
    if (p && p.x > 0.005 && p.y > 0.005 && p.x < P.W - 0.005 && p.y < P.H - 0.005) {
      aim = p;
      placeAimMarker();
      fire(p);
    }
  }
  drag = null;
  if (pointers.size < 2) pinch0 = 0;
}
surface.addEventListener('pointerup', endPointer);
surface.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); drag = null; });
surface.addEventListener('wheel', (e) => { e.preventDefault(); cam.r *= Math.exp(e.deltaY * 0.001); applyCamera(); }, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); if (stackOn) useRig(rigs[0]); if (!rigs || stackOn) fire(); }
  else if (k === 'p') { playing = !playing; syncPlay(); }
  else if (k === 'z') replay();
  else if (k === 'r') $('bReset').click();
  else if (k === 'c') $('bCam').click();
  else if (k === 's') $('bStress').click();
  else if (k === 'm') $('bSound').click();
  else if (k === 't') $('bTone').click();
  else if (k === 'a') $('bAuto').click();
  else if (k === 'h' || k === '?') $('help').classList.toggle('on');
  else if (k === 'escape') $('help').classList.remove('on');
  else if (k >= '1' && k <= '6') { auto = false; scaleManual = SCALES[+k - 1][0]; buildScaleButtons(); syncAuto(); }
});

// ---------- UI ----------
// Speeds in the visitor's unit (click the unit to change it; remembered).
const UNITS = [['m/s', 1], ['km/h', 3.6], ['mph', 2.2369363], ['ft/s', 3.2808399], ['kt', 1.9438445]];
let unit = Math.max(0, UNITS.findIndex((u) => u[0] === store.get('unit', 'm/s')));
const imperial = () => UNITS[unit][0] !== 'm/s' && UNITS[unit][0] !== 'km/h';
function fmtSpeed(v) {
  const [name, k] = UNITS[unit], x = v * k;
  return `${x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0)} ${name}`;
}
// The unit, and a second one beside it for a feel of the number.
function fmtSpeed2(v) {
  const other = UNITS[unit][0] === 'm/s' ? 1 : unit === 1 ? 0 : UNITS[unit][0] === 'kt' ? 2 : 4;
  const [name, k] = UNITS[other], x = v * k;
  return `${fmtSpeed(v)} · ${x.toFixed(x < 10 ? 1 : 0)} ${name}`;
}
function syncUnit() { $('bUnit').textContent = UNITS[unit][0]; syncSpeed(); if (P && !rigs) updateReadouts(); }
$('bUnit').onclick = () => { unit = (unit + 1) % UNITS.length; store.set('unit', UNITS[unit][0]); syncUnit(); };
function speedToSlider(v, d) { return Math.round(1000 * Math.log(v / d.minSpeed) / Math.log(d.maxSpeed / d.minSpeed)); }
function sliderToSpeed(s, d) { return d.minSpeed * Math.pow(d.maxSpeed / d.minSpeed, s / 1000); }
function syncSpeed() {
  const d = cat.impactors[iIdx];
  $('speed').value = String(speedToSlider(speed, d));
  const drop = speed * speed / (2 * 9.80665);
  const dropU = imperial() ? drop * 3.2808399 : drop, dropName = imperial() ? 'ft' : 'm';
  $('vSpeed').textContent = fmtSpeed2(speed) +
    (drop < 30 && d.kind !== 'projectile' ? ` · ${dropU.toFixed(dropU < 1 ? 2 : 1)} ${dropName} drop` : '');
  $('iMass').textContent = `${d.mass < 1 ? (d.mass * 1e3).toFixed(d.mass < 0.01 ? 2 : 1) + ' g' : d.mass.toFixed(2) + ' kg'} · ${(0.5 * d.mass * speed * speed).toFixed(speed * speed * d.mass < 20 ? 2 : 0)} J`;
}
function chipGroup(box, list, current, onPick) {
  box.textContent = '';
  let lastCat = null;
  list.forEach((d, i) => {
    if (d.category !== lastCat) {
      const c = document.createElement('div');
      c.className = 'cat';
      c.textContent = CAT_LABEL[d.category] || d.category;
      box.appendChild(c);
      lastCat = d.category;
    }
    const b = document.createElement('button');
    b.textContent = d.name.replace(/ \(UL 752.*\)/, '').replace('Bullet-resistant laminate, ', 'BR laminate ').replace('Transport aircraft windshield (chemically strengthened, 3 plies)', 'Airliner windshield');
    b.title = d.description;
    b.setAttribute('aria-pressed', String(i === current));
    b.onclick = () => onPick(i);
    box.appendChild(b);
  });
}
function pickGlazing(i) {
  if (activeScene()) leaveScene(false);
  gIdx = i;
  chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
  rebuildLab();
}
function pickImpactor(i, keepSpeed = false) {
  iIdx = i;
  store.set('impactor:v2', cat.impactors[i].id);
  if (!keepSpeed) speed = cat.impactors[i].speed;
  chipGroup($('impactors'), cat.impactors, iIdx, (k) => pickImpactor(k));
  $('iDesc').textContent = cat.impactors[i].description;
  syncSpeed();
}
const PRESETS = [
  ['Ball through a window', 'annealed_6', 'steel_ball_2260', 8.86, 'A 2.26 kg steel ball dropped 4 m onto 6 mm plate glass'],
  ['Baseball through a house window', 'annealed_4', 'baseball', 40, '90 mph fastball, thin annealed glass'],
  ['Escape tool on a car door', 'car_side_tempered', 'window_punch', 5.5, 'Spring punch: tempered glass crumbles from a 0.3 J tap'],
  ['ECE R43 windscreen ball test', 'windscreen', 'steel_ball_2260', 8.86, 'The PVB must catch a 2.26 kg ball from 4 m', { test: 'r43' }],
  ['Pedestrian head on a windscreen', 'windscreen', 'headform', 11.1, 'Euro NCAP adult headform at 40 km/h', { y: 0.32 }],
  ['Occupant head from inside', 'windscreen', 'headform', 7, 'Unbelted head strike, 25 km/h, from the cabin', { back: true, y: 0.55 }],
  ['Stone chip at highway speed', 'windscreen', 'stone', 30, 'A granite chip stars the outer ply only'],
  ['Bird strike at 250 kt', 'aircraft_windshield', 'bird_4lb', 128.6, '14 CFR 25.775: 4 lb bird, pressurised cabin', { test: 'far25' }],
  ['Bird strike at 350 kt', 'aircraft_windshield', 'bird_4lb', 180, 'The same bird at a typical airliner design cruise speed', { test: 'far25' }],
  ['Hail on a window', 'annealed_4', 'hail_50', 33, '50 mm hailstone at terminal velocity'],
  ['Hurricane debris', 'hurricane', 'timber_2x4', 15.2, 'ASTM E1996 missile D: 2x4 stud at 15 m/s', { test: 'e1996' }],
  ['Hurricane debris vs a plain window', 'annealed_6', 'timber_2x4', 15.2, 'The same 2x4 into ordinary 6 mm glass', { test: 'e1996' }],
  ['Falling into a shower door', 'tempered_6', 'body_bag', 4.89, 'ANSI Z97.1 bag from 48 in: tempered glass', { test: 'z97' }],
  ['Falling into an old door', 'annealed_6', 'body_bag', 4.89, 'The same fall into annealed glass', { test: 'z97' }],
  ['9 mm vs Level 1', 'ul752_l1', 'pistol_9mm', 380, 'UL 752 Level 1 class all-glass laminate', { test: 'ul752' }],
  ['.44 Magnum vs Level 3', 'ul752_l3', 'magnum_44', 430, 'Glass-clad polycarbonate catches it', { test: 'ul752' }],
  ['Rifle vs Level 3', 'ul752_l3', 'rifle_762', 850, 'A handgun rating does not stop 7.62 mm', { test: 'ul752' }],
  ['Rifle vs Level 8', 'ul752_l8', 'rifle_762', 850, 'Rifle-rated: stopped deep in the layup', { test: 'ul752' }],
  ['.50 BMG vs Level 8', 'ul752_l8', 'bmg_50', 900, 'A heavy machine-gun round has five times a rifle\'s energy: straight through', { test: 'ul752' }],
  ['.50 BMG vs Level 10', 'ul752_l10', 'bmg_50', 900, 'Nearly 4 in of glass-clad polycarbonate stops it', { test: 'ul752' }],
  ['BB gun vs plate glass', 'annealed_6', 'bb', 120, 'Hertzian cone: the classic conical hole'],
  ['Buckshot through a window', 'annealed_6', 'buckshot_00', 395, 'A 12-gauge 00 buck shell from 7 m: nine pellets, one after another'],
  ['Buckshot vs car door glass', 'car_side_tempered', 'buckshot_00', 395, 'Nine pellets into tempered side glass'],
  ['Brick vs tempered', 'tempered_6', 'brick', 10, 'Tempered glass is four to five times stronger'],
  ['Cannonball through a shop window', 'annealed_6', 'cannonball_9lb', 440, 'A Revolutionary War 9-pounder: 4 kg of iron at 1,450 ft/s'],
  ['Cannonball vs tempered', 'tempered_6', 'cannonball_9lb', 440, 'The same round shot into fully tempered glass'],
  ['Cannonball vs bulletproof glass', 'ul752_l3', 'cannonball_9lb', 440, 'The polycarbonate wraps round the ball and the whole window goes with it'],
];
// ---------- The armoured car ----------
let sceneLoading = false;
async function startScene() {
  if (TONE.on) setTone(false);
  leaveStack(true);
  if (!GT) { toast('The armoured-car scene needs WebGL; this device is drawing in 2D'); return; }
  if (sceneLoading) return;
  if (HS && HS.active) leaveScene(false);
  // The car (the Rosser V8) loads once; its windscreen sets the glazing.
  sceneLoading = true;
  const slow = setTimeout(() => toast('Bringing out the Rosser V8…', 6000), 400);
  let gid;
  try { gid = await GT.prepare(); } finally { clearTimeout(slow); sceneLoading = false; }
  const gi = cat.glazings.findIndex((g) => g.id === gid), ii = cat.impactors.findIndex((g) => g.id === 'smg_9mm');
  if (gi < 0 || ii < 0) return;
  gIdx = gi;
  chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
  pickImpactor(ii);
  speed = cat.impactors[ii].speed;
  yaw = 0; pitch = 0; fromBack = false;
  $('bSide').setAttribute('aria-pressed', 'false');
  syncSpeed();
  // ~190 rounds in ten seconds: the scene's physics is a step coarser, on every device.
  physCap = 2;
  newPane();
  GT.enter(P, P.seed, ii);
  P.shots = GT.schedule.shots.slice();
  P.pendingShots = GT.schedule.shots.slice();
  auto = false; scaleManual = 1; scaleNow = 1;
  syncAuto(); buildScaleButtons();
  simClockReset();
  playing = true; syncPlay();
  updatePaneInfo();
  if (window.innerWidth <= 860) showTab('none'); else $('lab').hidden = true;
  toast('Drag to look around · Camera switches view · Replay shows it again, at any speed', 4500);
}
// ---------- The grenade house ----------
function startHouse() {
  if (TONE.on) setTone(false);
  leaveStack(true);
  if (!HS) { toast('The house scene needs WebGL; this device is drawing in 2D'); return; }
  if (activeScene()) leaveScene(false);
  HS.enter();
  $('res').hidden = true;   // one pane's results; the scene has its own readout
  auto = true; syncAuto(); buildScaleButtons();
  scaleNow = 1;
  playing = true; syncPlay();
  if (window.innerWidth <= 860) showTab('none'); else $('lab').hidden = true;
  toast('Tap a window to throw the grenade through it · Drag to look around · Replay throws it again', 5000);
}
function leaveScene(rebuild) {
  const sc = activeScene();
  if (!sc) return;
  sc.leave();
  if (sc === HS) {
    // The windows go; the lab's own pane comes back.
    dropRigs();
    multiNext = () => Infinity; multiTarget = null;
    $('res').hidden = false;
    rebuild = true;
  }
  physCap = null;
  if (window.innerWidth > 860) $('lab').hidden = false;
  auto = store.get('auto', true); syncAuto(); buildScaleButtons();
  if (rebuild) rebuildLab();
  frameCamera(false);
}

function buildPresets() {
  const box = $('presets');
  {
    const b = document.createElement('button');
    b.className = 'feature';
    b.innerHTML = 'Armoured V8 under fire<small>Sit in the Rosser V8 behind an armoured windscreen while five gunmen empty submachine guns into it</small>';
    b.onclick = startScene;
    box.appendChild(b);
  }
  {
    const b = document.createElement('button');
    b.className = 'feature';
    b.innerHTML = 'Grenade in the shop<small>Pick a window of a glass shop at night: a crash dummy throws a grenade through it and the blast blows out the storefront and every window</small>';
    b.onclick = startHouse;
    box.appendChild(b);
  }
  {
    const b = document.createElement('button');
    b.className = 'feature';
    b.innerHTML = 'Cut a hole like a burglar<small>Score a circle in a window with a glass cutter, knock it from behind with a rubber mallet, and the disc drops out along the score</small>';
    b.onclick = startBurglar;
    box.appendChild(b);
  }
  {
    const b = document.createElement('button');
    b.className = 'feature';
    b.innerHTML = 'Read the cracks<small>Three stones hit a windscreen while you look away. Can you tell which came first, the way a forensic examiner would?</small>';
    b.onclick = startForensics;
    box.appendChild(b);
  }
  {
    const gi = cat.glazings.findIndex((g) => g.id === 'storefront_tempered_10');
    if (gi >= 0) {
      const b = document.createElement('button');
      b.className = 'feature';
      b.innerHTML = 'A window that explodes on its own<small>A storefront of tempered glass, years after it was fitted: a 0.4 mm nickel-sulfide stone in its core swells as it changes phase, and the whole panel dices with nothing touching it</small>';
      b.onclick = () => {
        if (activeScene()) leaveScene(false);
        if (stackOn || stack.length) { stack = []; leaveStack(false); renderLayers(); }
        if (TONE.on) setTone(false);
        gIdx = gi;
        chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
        newPane();
        simClockReset();
        const r = mulberry32(P.seed);
        plantStone({ x: P.W * (0.3 + 0.4 * r()), y: P.H * (0.25 + 0.3 * r()), d: 0.4 });
      };
      box.appendChild(b);
    }
  }
  {
    const b = document.createElement('button');
    b.className = 'feature';
    b.innerHTML = "Prince Rupert's drop<small>Its head stops a bullet; snap its tail and the whole drop explodes at 1.5 km/s. Under a high-speed camera and between crossed polarisers</small>";
    b.onclick = () => { location.href = 'drop/'; };
    box.appendChild(b);
  }
  {
    const gi = cat.glazings.findIndex((g) => g.id === 'picture_glass_2');
    if (gi >= 0) {
      const b = document.createElement('button');
      b.className = 'feature';
      b.innerHTML = 'Sing a picture frame to pieces<small>2 mm of picture glass rings at about 135 Hz, in the range of a voice. Play its note at 145 dB and watch the swing build up until it shatters</small>';
      b.onclick = () => {
        if (activeScene()) leaveScene(false);
        if (stackOn || stack.length) { stack = []; leaveStack(false); renderLayers(); }
        gIdx = gi;
        chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
        newPane();
        simClockReset();
        TONE.shaker = false;
        TONE.freq = TONE.modes[0].f;
        TONE.dB = 145;
        TONE.holo = true;
        if (stressOn) $('bStress').click();
        if (stressMesh) stressMesh.visible = true;
        renderModes();
        setTone(true);
      };
      box.appendChild(b);
    }
  }
  for (const [name, gid, iid, v, sub, opt = {}] of PRESETS) {
    const gi = cat.glazings.findIndex((g) => g.id === gid), ii = cat.impactors.findIndex((g) => g.id === iid);
    if (gi < 0 || ii < 0) continue;
    const b = document.createElement('button');
    b.innerHTML = `${name}<small>${sub}</small>`;
    b.onclick = () => {
      if (activeScene()) leaveScene(false);
      if (stackOn || stack.length) { stack = []; leaveStack(false); renderLayers(); }
      gIdx = gi;
      chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
      pickImpactor(ii);
      speed = v;
      yaw = 0; pitch = 0; $('yaw').value = '0'; $('pitch').value = '0'; $('vAngle').textContent = '0° / 0°';
      fromBack = !!opt.back;
      $('bSide').setAttribute('aria-pressed', String(fromBack));
      syncSpeed();
      newPane();
      simClockReset();
      updatePaneInfo();
      auto = true; syncAuto(); buildScaleButtons();
      const at = { x: P.W / 2, y: P.H * (opt.y ?? 0.5) };
      aim = at;
      placeAimMarker();
      P.test = opt.test || null;
      fire(at);
      if (window.innerWidth <= 860) showTab('res');
    };
    box.appendChild(b);
  }
}

function showTab(which) {
  $('lab').hidden = which !== 'lab';
  $('res').hidden = which !== 'res';
  $('tLab').setAttribute('aria-pressed', String(which === 'lab'));
  $('tRes').setAttribute('aria-pressed', String(which === 'res'));
  $('tHide').setAttribute('aria-pressed', String(which === 'none'));
  $('tabs').classList.toggle('closed', which === 'none');
}

// Tier menu
{
  const sel = $('tier');
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  add('auto', `Auto (${TIER_NAMES[bench.tier]})`);
  TIER_NAMES.forEach((n, i) => add(String(i), n));
  sel.value = String(tierChoice);
  sel.onchange = () => {
    tierChoice = sel.value;
    store.set('tier', tierChoice);
    tier = tierChoice === 'auto' ? bench.tier : +tierChoice;
    resize();
    newPane();
    simClockReset();
    toast(`${TIER_NAMES[tier]} drawing: the physics is the same on every setting`);
  };
}
$('speed').oninput = () => { speed = sliderToSpeed(+$('speed').value, cat.impactors[iIdx]); syncSpeed(); };
for (const id of ['yaw', 'pitch']) $(id).oninput = () => { yaw = +$('yaw').value; pitch = +$('pitch').value; $('vAngle').textContent = `${yaw}° / ${pitch}°`; };
$('bSide').onclick = () => { fromBack = !fromBack; $('bSide').setAttribute('aria-pressed', String(fromBack)); placeAimMarker(); };
$('bCentre').onclick = () => { aim = { x: P.W / 2, y: P.H / 2 }; placeAimMarker(); };
$('fire').onclick = () => { if (stackOn) useRig(rigs[0]); if (!rigs || stackOn) fire(); };
$('bPlay').onclick = () => { playing = !playing; syncPlay(); };
$('bReplay').onclick = replay;
$('bAuto').onclick = () => { auto = !auto; store.set('auto', auto); syncAuto(); buildScaleButtons(); };
$('bReset').onclick = () => {
  if (GT && GT.active) startScene();
  else if (HS && HS.active) HS.restart(false);
  else rebuildLab();
};
function syncSound() {
  $('bSound').setAttribute('aria-pressed', String(sound.enabled)); $('bSound').textContent = sound.enabled ? 'Sound' : 'Muted';
  if (GT) GT.syncSound();
  if (HS) HS.syncSound();
}
$('bSound').onclick = () => { sound.setEnabled(!sound.enabled); store.set('sound:v3', sound.enabled); syncSound(); };
syncSound();
$('bCam').onclick = () => { if (activeScene()) activeScene().nextView(); else { camMode = (camMode + 1) % 3; frameCamera(false); } };
$('bStress').onclick = () => {
  stressOn = !stressOn;
  $('bStress').setAttribute('aria-pressed', String(stressOn));
  if (stressOn && TONE.holo) { TONE.holo = false; syncToneUI(); }
  if (stressMesh) stressMesh.visible = overlayOn();
  $('legend').classList.toggle('on', stressOn);
  if (stressOn) updateField();
};
$('bHelp').onclick = () => $('help').classList.add('on');
$('bHelpClose').onclick = () => $('help').classList.remove('on');
$('help').onclick = (e) => { if (e.target === $('help')) $('help').classList.remove('on'); };
$('tLab').onclick = () => showTab('lab');
$('tRes').onclick = () => showTab('res');
$('tHide').onclick = () => showTab('none');

// ---------- Flat (2D) view ----------
function view2d() {
  const w = canvas2d.clientWidth, h = canvas2d.clientHeight;
  const s = Math.min(w * 0.8 / P.W, h * 0.62 / (P.H + FLOOR * 0.4));
  return { s, ox: (w - P.W * s) / 2, oy: h * 0.42 + P.H * s / 2 };
}
function draw2d(tShow, poses) {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const c = ctx2d;
  c.setTransform(d, 0, 0, d, 0, 0);
  const w = canvas2d.clientWidth, h = canvas2d.clientHeight;
  c.fillStyle = '#0b111b';
  c.fillRect(0, 0, w, h);
  const v = view2d();
  const X = (x) => v.ox + x * v.s, Y = (y) => v.oy - y * v.s;
  c.fillStyle = '#272c33';
  c.fillRect(0, Y(-FLOOR), w, h - Y(-FLOOR));
  c.fillStyle = '#8b939e';
  c.fillRect(X(0) - 8, Y(P.H) - 8, P.W * v.s + 16, P.H * v.s + 16);
  const anyFrag = P.plies.some((p, k) => G.plies(P.nGlass)[12 * k + 4] > 0);
  if (!anyFrag || !P.monolithic) {
    c.fillStyle = 'rgba(190,225,235,0.42)';
    c.fillRect(X(0), Y(P.H), P.W * v.s, P.H * v.s);
  } else {
    c.fillStyle = '#0b111b';
    c.fillRect(X(0), Y(P.H), P.W * v.s, P.H * v.s);
  }
  if (stressOn) {
    c.globalAlpha = 0.85;
    c.imageSmoothingEnabled = true;
    c.save();
    c.translate(X(0), Y(P.H));
    c.scale(P.W * v.s / FX, P.H * v.s / FY);
    c.drawImage(stressCanvas, 0, 0);
    c.restore();
    c.globalAlpha = 1;
  }
  // Pieces (front view, rotated about their own axes).
  if (poses) {
    for (const r of P.frags.recs) {
      const o = r.index * 12, st = poses[o + 10];
      if (st < 0) continue;
      const qw = poses[o + 3], qx = poses[o + 4], qy = poses[o + 5], qz = poses[o + 6];
      c.beginPath();
      for (const loop of [r.poly, ...(r.holes || [])]) {
        loop.forEach(([px, py], i) => {
          const a = quatRotate(qw, qx, qy, qz, px, py, 0);
          const sx = X(poses[o] + a[0]), sy = Y(poses[o + 1] + a[1]);
          if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy);
        });
        c.closePath();
      }
      c.fillStyle = st === 0 ? 'rgba(190,225,235,0.42)' : 'rgba(205,235,240,0.6)';
      c.fill('evenodd');
      c.strokeStyle = 'rgba(120,200,170,0.8)';
      c.lineWidth = 0.6;
      c.stroke();
    }
  }
  // Crushed glass.
  for (const [x, y, r, a] of P.crush.discs) {
    const g = c.createRadialGradient(X(x), Y(y), 0, X(x), Y(y), r * 1.2 * v.s);
    g.addColorStop(0, `rgba(250,252,252,${a})`);
    g.addColorStop(0.5, `rgba(240,246,246,${0.5 * a})`);
    g.addColorStop(1, 'rgba(240,246,246,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(X(x), Y(y), r * 1.2 * v.s, 0, 2 * Math.PI);
    c.fill();
  }
  // Cracks born by now.
  c.strokeStyle = 'rgba(235,245,255,0.85)';
  c.lineWidth = 0.8;
  P.cracks.forEach((cv, k) => {
    if (P.monolithic && G.plies(P.nGlass)[12 * k + 4] > 0) return;
    c.beginPath();
    const s = cv.segs;
    for (let i = 0; i < s.length; i += 7) {
      if (s[i + 4] > tShow) continue;
      c.moveTo(X(s[i]), Y(s[i + 1]));
      c.lineTo(X(s[i + 2]), Y(s[i + 3]));
    }
    c.stroke();
  });
  // Impactors.
  const imps = G.impactors(P.nImp);
  for (let k = 0; k < P.nImp; ++k) {
    const o = 20 * k;
    const r = Math.max(2, imps[o + 13] * v.s);
    c.beginPath();
    c.arc(X(imps[o]), Y(imps[o + 1]), r, 0, Math.PI * 2);
    c.fillStyle = imps[o + 2] < 0 ? '#ffd36b' : 'rgba(255,211,107,0.45)';
    c.fill();
  }
  if (aim) {
    c.strokeStyle = '#ffd36b';
    c.beginPath();
    c.arc(X(aim.x), Y(aim.y), 7, 0, Math.PI * 2);
    c.stroke();
  }
}

// ---------- Main loop ----------
let last = performance.now(), uiTick = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!P) return;
  let tEng, s, poses = null;
  if (rigs) {
    if (G.remote) G.hold();   // several panes: the frame steps each in turn
    tEng = multiFrame(dt);
    if (stackOn) stackHandOff();
    s = G.state();
  } else {
    // The engine in its worker: if it is in the middle of a few milliseconds
    // of steps, wait for them briefly; otherwise draw this frame as it stands.
    if (G.remote && G.hold()) {
      const t0 = performance.now();
      while (G.hold() && performance.now() - t0 < 4) { /* the worker stops at its next step */ }
      if (G.hold()) {
        if (R) R.render(scene, camera);
        return;
      }
    }
    s = G.state();
    const plies0 = G.plies(P.nGlass);
    // Bullet time eases down fast and back up gently (in log space).
    easeScale(auto ? autoTarget(G.impactors(P.nImp), plies0) : scaleManual, dt);
    fireDueShots();
    if (playing && G.remote) {
      // The worker stepped toward last frame's time while the page drew. If it
      // has not got there, the clock waits for it: the physics is never cut short.
      const eng = G.gls_time();
      limited = eng < P.goal - 1e-12;
      P.simClock = (limited ? eng : Math.max(P.simClock, eng)) + dt * scaleNow;
      if (P.pendingShots.length) P.simClock = Math.min(P.simClock, P.pendingShots[0].t);
      P.simClock = Math.min(P.simClock, grenadeDue());
    } else if (playing) {
      P.simClock = Math.max(P.simClock, G.gls_time()) + dt * scaleNow;
      if (P.pendingShots.length) P.simClock = Math.min(P.simClock, P.pendingShots[0].t);
      P.simClock = Math.min(P.simClock, grenadeDue());
      // Physics gets a share of the frame: more per frame when frames are slow.
      const steps = advancePane(P.simClock, physicsBudget(dt));
      limited = steps.limited;
      if (limited) P.simClock = G.gls_time();
      s = G.state();
    }
    tEng = G.gls_time();
    checkImpactFuses();
    detonateGrenades(tEng);
    poses = paneFrame(dt, s, tEng);
    toneFrame(dt, s, tEng);
    for (const fx of P.blastFX || []) fx.update(tEng);
  }
  sound.frame(tEng, playing ? scaleNow : 0.0001, dt);
  if (GT) GT.update(tEng, scaleNow, s);
  if (HS) HS.update(tEng, scaleNow, dt);
  // Readouts.
  if ((uiTick += dt) > 0.12) {
    uiTick = 0;
    if (!rigs) { updateReadouts(); announce(); toneReadout(); }
    else if (stackOn) { useRig(rigs[0]); updateReadouts(); announce(); stackReadout(); }
    $('clock').innerHTML = `${fmtTime(tEng)}<small>${fmtScale(scaleNow)}${auto ? ' · auto' : ''}</small>`;
    $('limit').textContent = limited ? 'device-limited' : '';
  }
  // The worker steps on toward the clock while this frame draws (after the
  // frame's last call, so none of them waits on its steps).
  if (G.remote && !rigs && P) {
    if (playing) { P.goal = P.simClock; G.go(P.goal); }
    else { P.goal = 0; G.stop(); }
  }
  if (R) {
    adaptResolution(dt);
    if (!idle(now, tEng, s)) R.render(scene, camera);
  } else {
    draw2d(tEng, poses);
  }
}

// Resolution follows the frame rate both ways: down a step while frames are
// slow (a burst of thousands of pieces), back up once they are quick again.
let frameAvg = 1 / 60, slowRun = 0, quickRun = 0;
function adaptResolution(dt) {
  frameAvg += (dt - frameAvg) * 0.1;
  slowRun = frameAvg > 1 / 24 ? slowRun + 1 : 0;
  quickRun = frameAvg < 1 / 45 ? quickRun + 1 : 0;
  const before = resScale;
  if (slowRun > 30) { resScale = Math.max(0.55, resScale * 0.85); slowRun = 0; }
  else if (quickRun > 120 && resScale < 1) { resScale = Math.min(1, resScale * 1.12); quickRun = 0; }
  if (resScale !== before) R.setPixelRatio(pixelRatio());
}
// Nothing on screen changes while the pane is settled, the camera still and
// nobody touching anything: keep the last frame (phones stay cool). A frame
// is still drawn every second.
let lastInput = performance.now(), lastDrawn = 0, quietFrom = null;
const lastCam = new Float32Array(16);
for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'resize', 'input', 'change'])
  window.addEventListener(ev, () => { lastInput = performance.now(); }, { passive: true, capture: true });
function idle(now, tEng, s) {
  let still = true;
  const e = camera.matrixWorld.elements;
  for (let i = 0; i < 16; ++i) if (lastCam[i] !== e[i]) { still = false; lastCam[i] = e[i]; }
  // Settled: the engine quiet, and three seconds of engine time for the dice
  // to land (they fly on the GPU by the clock). Paused, nothing moves at all.
  const lab = !!P && !rigs && !activeScene() && !TONE.on && !TONE.mic;
  const quiet = lab && !!s && s[1] === 1;
  if (!quiet) quietFrom = null;
  else if (quietFrom === null) quietFrom = tEng;
  const settled = lab && (!playing || (quiet && tEng - quietFrom > 3));
  const skip = still && settled && now - lastInput > 1500 && now - lastDrawn < 1000;
  if (!skip) lastDrawn = now;
  return skip;
}
function easeScale(target, dt) {
  if (auto) {
    const lg = Math.log10(scaleNow), lt = Math.log10(target);
    scaleNow = Math.pow(10, lt < lg ? Math.max(lt, lg - dt * 6) : Math.min(lt, lg + dt * 0.9));
  } else scaleNow = target;
}
// Replayed (and scripted) shots fire at the engine time they were first fired.
function fireDueShots() {
  while (P.pendingShots.length && P.pendingShots[0].t <= G.gls_time() + 1e-12) {
    const sh = P.pendingShots.shift();
    iIdx = sh.iIdx; speed = sh.speed; yaw = sh.yaw; pitch = sh.pitch; fromBack = sh.fromBack;
    fire({ x: sh.x, y: sh.y }, false);
  }
}
function physicsBudget(dt) { return clamp(0.45 * dt * 1000, tier <= 1 ? 8 : 11, 80); }
// Whole engine steps toward `t` within `budgetMs`; learns the cost of a step.
function advancePane(t, budgetMs) {
  const maxSteps = Math.max(20, Math.floor(budgetMs / Math.max(msPerStep, 1e-4)));
  const t0 = performance.now();
  const steps = G.gls_advance(t, maxSteps);
  const el = performance.now() - t0;
  if (steps > 0) msPerStep = 0.85 * msPerStep + 0.15 * (el / steps);
  return { steps, limited: steps >= maxSteps && G.gls_time() < t - 1e-12 };
}

// Everything one pane shows this frame: new cracks, pieces, dice, crushed
// glass, the impactors, and the sound of it. Returns the piece poses.
function paneFrame(dt, s, tEng) {
  // New cracks.
  const pl = G.plies(P.nGlass);
  for (let k = 0; k < P.nGlass; ++k) {
    const n = pl[12 * k + 2], cv = P.cracks[k];
    if (n > cv.count) {
      const segs = G.cracks(k, cv.count).slice();
      cv.add(segs);
      sound.cracks(segs, P.profile, panAt);
    }
    if (pl[12 * k + 4] > 0 && !P.broken[k]) { P.broken[k] = true; sound.shatter(P.profile, P.plies[k].dicing, panAt(P.W / 2, P.H / 2)); }
    if (R) {
      cv.mat.uniforms.uTime.value = tEng;
      cv.mat.uniforms.uGlow.value = 1 / Math.max(1e-7, 0.25 * scaleNow);
      cv.mat.uniforms.uExag.value = rigs ? 0 : exaggeration;
      cv.mat.uniforms.uSize.value.set(P.W, P.H);
      // A pane in pieces: tempered dice draw their own pattern; other glass keeps
      // its cracks while the pieces they lie on are in the frame.
      cv.lines.visible = !(P.monolithic && pl[12 * k + 4] > 0) || (CRACK_PIECES && !!P.frags.uniforms && !P.plies[k].dicing);
      if (CRACK_PIECES && P.frags.uniforms) cv.mat.uniforms.uPose.value = P.frags.uniforms.uPose.value;
    }
  }
  // New pieces, then where every piece is.
  const nFrag = s[4];
  if (nFrag > P.fragShapes) {
    const shapes = G.fragmentShapes(P.fragShapes);
    for (const sh of shapes) {
      let r = 0;
      for (let i = 0; i + 1 < sh.outline.length; i += 2) r = Math.max(r, Math.hypot(sh.outline[i], sh.outline[i + 1]));
      P.pieceSize[sh.index] = r;
    }
    P.frags.add(shapes); P.fragShapes = nFrag;
    // Crushed discs follow the pieces round them.
    {
      const plm = G.plies(P.nGlass);
      for (let k = 0; k < P.nGlass; ++k)
        if (plm[12 * k + 4] > 0) { const m = G.fragmentMap(P.plies[k].ply); P.crush.maps[k] = { nx: m.nx, ny: m.ny, label: m.label.slice(), cell: plm[12 * k + 3] }; }
    }
    // Monolithic plies in pieces: tell their crack lines which pieces they lie on.
    if (CRACK_PIECES && P.frags.uniforms) {
      const plk = G.plies(P.nGlass);
      for (let k = 0; k < P.nGlass; ++k) {
        if (!(plk[12 * k + 4] > 0) || P.plies[k].dicing) continue;
        const cv = P.cracks[k];
        cv.mat.uniforms.uUsePieces.value = 1;
        cv.setMap(G.fragmentMap(P.plies[k].ply), plk[12 * k + 3]);
      }
    }
  }
  if (P.frags.tick) P.frags.tick(rigs ? 2 : tier >= 3 ? 6 : 4);   // cut whole tempered pieces into their dice, a few per frame
  let poses = null;
  if (nFrag > 0) {
    poses = G.fragmentPoses(nFrag).slice();
    P.frags.update(poses, Math.max(0, tEng - s[23]), tEng);  // pieces step every 0.5 ms; extrapolate between
  }
  if (s[26] > P.crush.count) P.crush.add(G.crushes(P.crush.count).slice());
  if (poses && P.crush.maps.length) P.crush.follow(poses);
  const sprayView = P.dice || P.frags;
  if (s[24] > sprayView.sprays) {
    // The first dice to come loose: bring the floor into the shot.
    if (!sprayView.sprays && !pointers.size && !activeScene()) P.glide = { ty: (FLOOR + P.H) / 2, r: cam.r * 1.2 };
    const rows = G.sprays(sprayView.sprays).slice();
    sprayView.addSprays(rows, poses);
    // When each spray's dice reach the floor, for the sound of them landing.
    for (let o = 0; o + 14 < rows.length; o += 15) {
      const lift = Math.max(0, rows[o + 1] - P.floor), vy = rows[o + 4];
      sound.dice(rows[o + 9] + (vy + Math.sqrt(vy * vy + 2 * 9.81 * lift)) / 9.81, rows[o + 6], panAt(rows[o], P.floor));
    }
  }
  listen(poses, nFrag);
  if (P.dice) P.dice.update(tEng);
  if (P.glide) {
    if (pointers.size) P.glide = null;
    else {
      const k = 1 - Math.exp(-2.5 * dt);
      cam.ty += (P.glide.ty - cam.ty) * k;
      cam.r += (P.glide.r - cam.r) * k;
      applyCamera();
      if (Math.abs(P.glide.ty - cam.ty) < 1e-3) P.glide = null;
    }
  }
  // The intact sheet goes once a monolithic pane is in pieces, or a laminate
  // has been pulled out of its frame whole.
  if (slab) {
    const gone = (P.monolithic && pl[4] > 0) || s[28] > 0;
    slab.visible = !gone;
    if (P.edges) P.edges.visible = !gone;
    if (stressMesh) stressMesh.visible = overlayOn() && !gone;
  }
  // Deflection and stress, a few times a second (every frame while it moves
  // fast). One shared field: a scene of many panes goes without it.
  const dynamic = s[1] === 0;
  if (!rigs && (dynamic || overlayOn())) {
    if (++P.fieldTick >= (tier <= 1 ? 4 : 2)) { P.fieldTick = 0; updateField(); }
  }
  // Impactors.
  if (R) {
    const imps = G.impactors(P.nImp);
    for (let k = 0; k < P.nImp; ++k) {
      const m = P.impMeshes[k];
      if (!m) continue;
      const o = 20 * k;
      m.position.set(imps[o] - P.W / 2, imps[o + 1] + FLOOR, -imps[o + 2]);
      const dir = new THREE.Vector3(imps[o + 6], imps[o + 7], -imps[o + 8]).normalize();
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      const L = imps[o + 14] || 2 * imps[o + 13];
      if (imps[o + 15] === KIND.SOFT) {
        const sq = clamp(1 - imps[o + 11] / L, 0.08, 1);
        m.scale.set(1 / Math.sqrt(sq), 1 / Math.sqrt(sq), sq);
      }
      if (m.userData.blob) {
        const b = m.userData.blob, y = Math.max(0, m.position.y), [bx, bz] = onFloor(m.position.x, y, m.position.z);
        const size = 2.4 * imps[o + 13] + 0.12 * y;
        b.position.set(bx, 0.003, bz);
        b.scale.set(size, size, 1);
        b.material.opacity = 0.45 * clamp(1 - y / 3, 0.15, 1);
        b.visible = m.visible;
      }
      if (m.userData.glow) {
        const d = camera.position.distanceTo(m.getWorldPosition(_impW));
        m.userData.glow.scale.setScalar(0.012 * d);
        m.userData.glow.visible = imps[o + 9] !== PH.DONE;
      }
    }
  }
  return poses;
}
const _impW = R ? new THREE.Vector3() : null;

// ---------- Several panes at once (a building's windows) ----------
// A rig is one window: its engine slot, its pane (P), the group it is drawn in
// and its intact sheet. The globals P, groupPane and slab point at the rig in
// use, so all of the single-pane code above works on whichever is selected.
let rigs = null, curRig = null, multiClock = 0, multiNext = () => Infinity, multiTarget = null;
function useRig(r) {
  if (curRig === r) return;
  if (curRig) Object.assign(curRig, { P, slab, stressMesh, aimMarker });
  curRig = r;
  G.gls_select(r.slot);
  ({ P, slab, stressMesh, aimMarker } = r);
  groupPane = r.group;
}
function disposePane(p, group) {
  if (!p) return;
  const prev = groupPane;
  groupPane = group;
  for (const c of p.cracks) c.dispose();
  p.frags.dispose();
  if (p.dice) p.dice.dispose();
  if (p.crush) p.crush.dispose();
  for (const fx of p.blastFX || []) fx.dispose();
  for (const m of p.meshes) group.remove(m);
  for (const m of p.impMeshes) if (m) group.remove(m);
  groupPane = prev;
}
// Builds one rig per spec ({ glazing id, seed, group, tier, viewTier }) in
// slots 1.., each pane in its own group; the lab's pane (slot 0) is put away
// meanwhile.
function makeRigs(specs) {
  dropRigs();
  disposePane(P, labGroup);
  P = null; slab = stressMesh = aimMarker = null;
  G.gls_select(0); G.gls_free_pane();
  rigs = [];
  specs.forEach((sp, i) => {
    const r = { slot: i + 1, group: sp.group, P: null, slab: null, stressMesh: null, aimMarker: null, spec: sp };
    curRig = r;
    G.gls_select(r.slot);
    groupPane = r.group;
    P = null;
    newPane(sp.seed, false, { glazing: cat.glazings.findIndex((g) => g.id === sp.glazing), tier: sp.tier, viewTier: sp.viewTier, floor: sp.floor,
      width: sp.w, height: sp.h, quiet: true });
    if (!sp.frame) for (const m of P.meshes) if (m.userData.lab) m.visible = false;
    Object.assign(r, { P, slab, stressMesh, aimMarker });
    rigs.push(r);
  });
  multiClock = 0;
  deflData.fill(0); if (deflTex) deflTex.needsUpdate = true;
  useRig(rigs[0]);
  return rigs;
}
function dropRigs() {
  if (!rigs) return;
  for (const r of rigs) {
    disposePane(r.P, r.group);
    G.gls_select(r.slot); G.gls_free_pane();
  }
  rigs = null; curRig = null;
  P = null; slab = stressMesh = aimMarker = null;
  groupPane = labGroup;
  G.gls_select(0);
}
// One frame of every rig on a shared engine clock: shots due, physics (the
// frame's budget shared between them), then what each shows.
function multiFrame(dt) {
  easeScale(auto && multiTarget ? multiTarget() : auto ? 1 : scaleManual, dt);
  for (const r of rigs) { useRig(r); fireDueShots(); }
  if (playing) {
    multiClock += dt * scaleNow;
    let next = multiNext();
    for (const r of rigs) if (r.P.pendingShots.length) next = Math.min(next, r.P.pendingShots[0].t);
    multiClock = Math.min(multiClock, next);
    const budget = physicsBudget(dt) * 1.3;
    let tMin = Infinity, lim = false;
    for (const r of rigs) {
      useRig(r);
      const res = advancePane(multiClock, budget / rigs.length);
      lim = lim || res.limited;
      tMin = Math.min(tMin, G.gls_time());
    }
    limited = lim;
    if (lim) multiClock = tMin;
  }
  // What each pane shows, at the detail its scene gives it from where the
  // camera is (2 near, 1 small on the screen, 0 out of sight): a small pane
  // catches up every other frame, one out of sight every eighth and isn't
  // drawn. The physics is the same for all of them.
  for (const r of rigs) {
    const d = r.detail ?? 2;
    r.group.visible = d > 0;
    r.lag = (r.lag || 0) + dt;
    r.skipped = (r.skipped || 0) + 1;
    if (r.skipped < (d >= 2 ? 1 : d === 1 ? 2 : 8)) continue;
    useRig(r);
    paneFrame(r.lag, G.state(), G.gls_time());
    r.lag = 0; r.skipped = 0;
  }
  return multiClock;
}
function activeScene() { return GT && GT.active ? GT : HS && HS.active ? HS : null; }

// ---------- Glass stacks ----------
// Panes one behind another along the shot, each its own glazing cut to the
// first pane's size, `gap` metres apart. Each is its own engine pane on the
// rigs' shared clock. What leaves one pane toward another is fired into it:
// the projectile with the speed and direction it left at, and every flying
// piece of glass as a glass shard of its own mass and size, which then leaves
// the pane it came from.
const MAX_LAYERS = 4;
let stack = [];        // the panes behind the first: { gid, gap (m) }
let stackOn = false;   // the rigs are a stack (not a scene's windows)
let stackDepth = [];   // m from the first pane's front face to each pane's front face
let stackGroups = [];
let stackLastT = 0;
const shardIdx = cat.impactors.findIndex((d) => d.id === 'glass_shard');
const SHARDS_PER_PANE = 30;   // pieces fired into one pane at most (each is an impactor to solve)
const SHARD_MIN_ENERGY = 0.05; // J: a piece with less cannot mark glass, and is left to fly

function stackDepthTotal() {
  return stackOn ? stackDepth[stackDepth.length - 1] + rigs[rigs.length - 1].P.T : P ? P.T : 0;
}
// (Re)builds the stack; seeds: one per pane to rebuild the same panes.
function buildStack(seeds) {
  if (TONE.on) setTone(false);
  if (activeScene()) leaveScene(false);
  for (const g of stackGroups) scene.remove(g);
  stackGroups = [];
  const g0 = cat.glazings[gIdx];
  const ids = [gIdx, ...stack.map((l) => l.gid)];
  stackDepth = [];
  let z = 0;
  const specs = ids.map((gi, k) => {
    if (k > 0) z += stack[k - 1].gap;
    stackDepth.push(z);
    const group = new THREE.Group();
    group.position.z = -z;
    scene.add(group);
    stackGroups.push(group);
    z += cat.glazings[gi].thickness;
    // The panes behind share the work: their physics a step coarser than the first's.
    return { glazing: cat.glazings[gi].id, seed: seeds?.[k] ?? ((Math.random() * 1e9) | 0), group, w: g0.width, h: g0.height,
      tier: k ? PHYS - 1 : PHYS, viewTier: tier, frame: true };
  });
  makeRigs(specs);
  stackOn = true;
  stackLastT = 0;
  multiNext = () => Infinity;
  multiTarget = stackTarget;
  for (const r of rigs) Object.assign(r, { hits: [], shards: 0, shardMax: 0 });
  useRig(rigs[0]);
  aim = { x: P.W / 2, y: P.H / 2 };
  placeAimMarker();
  $('log').textContent = '';
  updatePaneInfo();
  frameCamera(false);
}
function leaveStack(rebuild = true) {
  if (!stackOn) return;
  stackOn = false;
  dropRigs();
  for (const g of stackGroups) scene.remove(g);
  stackGroups = [];
  multiNext = () => Infinity; multiTarget = null;
  if (rebuild) { newPane(); simClockReset(); updatePaneInfo(); frameCamera(false); }
}
// The lab's pane as it now stands: one pane, or a stack.
function rebuildLab(seeds) {
  if (stack.length) buildStack(seeds);
  else { leaveStack(false); newPane(seeds?.[0]); simClockReset(); updatePaneInfo(); }
  renderLayers();
}
// Bullet time follows whichever pane has most going on.
function stackTarget() {
  let t = 1;
  for (const r of rigs) { useRig(r); t = Math.min(t, autoTarget(G.impactors(P.nImp), G.plies(P.nGlass))); }
  return t;
}
// Fires impactor `di` into rig r without touching the lab's own selection.
function fireInto(r, di, x, y, sp, yawD, pitchD, back, lead, mass = 0, radius = 0) {
  useRig(r);
  const def = cat.impactors[di];
  const h = G.gls_fire_as(di, x, y, sp, yawD * Math.PI / 180, pitchD * Math.PI / 180, back ? 1 : 0, lead, mass, radius);
  if (h < 0) return -1;
  const n = Math.max(h + 1, G.state()[3]);
  P.shotMass ||= []; P.shotRadius ||= [];
  for (let k = h; k < n; ++k) {
    P.shotDefs[k] = di;
    P.shotMass[k] = mass; P.shotRadius[k] = radius;
    if (R) {
      const m = impactorMesh(def);
      if (radius > 0) m.scale.setScalar(radius / def.radius);
      groupPane.add(m);
      P.impMeshes[k] = m;
    }
  }
  P.nImp = n;
  return h;
}
// Everything flying off a pane toward another, about to reach it, goes into it.
function stackHandOff() {
  const n = rigs.length, t = multiClock;
  const ahead = Math.max(2e-3, 3 * Math.max(1e-6, t - stackLastT));  // engine s we look ahead
  stackLastT = t;
  for (let k = 0; k < n; ++k) {
    const r = rigs[k];
    useRig(r);
    const Pk = r.P;
    Pk.handed ||= new Set(); Pk.thrown ||= new Set();
    const out = [];
    const imps = G.impactors(Pk.nImp);
    for (let m = 0; m < Pk.nImp; ++m) {
      const o = 20 * m;
      if (Pk.handed.has(m) || imps[o + 9] !== PH.FLIGHT) continue;
      const z = imps[o + 2], vz = imps[o + 5];
      if (vz > 0 ? z < Pk.T + 0.003 : z > -0.003) continue;   // not through or off this pane yet
      const it = { m, x: imps[o], y: imps[o + 1], z, vx: imps[o + 3], vy: imps[o + 4], vz, di: Pk.shotDefs[m] ?? iIdx,
        mass: Pk.shotMass?.[m] || 0, radius: Pk.shotRadius?.[m] || 0 };
      // Wrapped in the laminate it ripped out: the next pane is hit by the whole bundle.
      const sheet = G.gls_carried_sheet(m);
      if (sheet >= 0) Object.assign(it, { sheet, mass: G.gls_sheet_mass(sheet), radius: 1.6 * imps[o + 13] });
      out.push(it);
    }
    const nf = G.state()[4];
    if (nf && shardIdx >= 0) {
      const poses = G.fragmentPoses(nf), tPly = Pk.T / Math.max(1, Pk.nGlass);
      for (let i = 0; i < nf; ++i) {
        const q = 12 * i;
        if (poses[q + 10] !== 2 || Pk.thrown.has(i) || G.gls_fragment_sheet(i) >= 0) continue;  // bonded glass goes as its sheet
        const vx = poses[q + 7], vy = poses[q + 8], vz = poses[q + 9];
        if (vx * vx + vy * vy + vz * vz < 4) continue;
        const rr = Math.max(0.002, Pk.pieceSize[i] || 0.01);
        const mass = 2500 * tPly * 0.5 * Math.PI * rr * rr;
        if (0.5 * mass * (vx * vx + vy * vy + vz * vz) < SHARD_MIN_ENERGY) continue;
        out.push({ frag: i, x: poses[q], y: poses[q + 1], z: poses[q + 2], vx, vy, vz, di: shardIdx, mass, radius: rr });
      }
    }
    for (const it of out) {
      const j = it.vz > 0 ? k + 1 : k - 1;
      const done = () => (it.frag === undefined ? Pk.handed.add(it.m) : Pk.thrown.add(it.frag));
      if (j < 0 || j >= n) { done(); continue; }
      const rj = rigs[j];
      const zt = it.vz > 0 ? stackDepth[j] - stackDepth[k] : stackDepth[j] + rj.P.T - stackDepth[k];
      const ttc = (zt - it.z) / it.vz;
      if (ttc > ahead) continue;   // still on its way
      done();
      const tc = Math.max(0, ttc);
      const x = it.x + it.vx * tc, y = it.y + it.vy * tc - 4.905 * tc * tc;
      if (ttc < -0.05 || x <= 0.003 || y <= 0.003 || x >= rj.P.W - 0.003 || y >= rj.P.H - 0.003) continue;  // past it, or misses
      const shard = it.di === shardIdx;
      if (shard && (rj.shards >= SHARDS_PER_PANE || 0.5 * (it.mass || cat.impactors[it.di].mass) * (it.vx ** 2 + it.vy ** 2 + it.vz ** 2) < SHARD_MIN_ENERGY)) continue;
      const vy = it.vy - 9.81 * tc, sp = Math.hypot(it.vx, vy, it.vz);
      const yawD = Math.atan2(it.vx, Math.abs(it.vz)) * 180 / Math.PI, pitchD = Math.asin(clamp(vy / sp, -1, 1)) * 180 / Math.PI;
      if (fireInto(rj, it.di, x, y, sp, yawD, pitchD, it.vz < 0, Math.max(0.004, sp * tc), it.mass, it.radius) < 0) continue;
      if (shard) { ++rj.shards; rj.shardMax = Math.max(rj.shardMax, sp); }
      else rj.hits.push({ name: cat.impactors[it.di].name, speed: sp });
      useRig(r);
      if (it.frag !== undefined) G.gls_drop_fragment(it.frag);
      else if (Pk.impMeshes[it.m]) Pk.impMeshes[it.m].visible = false;
      if (it.sheet !== undefined)
        for (let i = 0, nf = G.state()[4]; i < nf; ++i) if (G.gls_fragment_sheet(i) === it.sheet) G.gls_drop_fragment(i);
    }
  }
  useRig(rigs[0]);
}
// What happened to each pane of the stack.
function stackReadout() {
  const el = $('stackRes');
  if (!stackOn) { el.hidden = true; return; }
  const rows = rigs.map((r, k) => {
    useRig(r);
    const s = G.state(), g = r.P.glazing;
    const what = [];
    for (const h of r.hits) what.push(`${h.name} at ${fmtSpeed(h.speed)}`);
    if (r.shards) what.push(`${r.shards} shard${r.shards > 1 ? 's' : ''} (up to ${fmtSpeed(r.shardMax)})`);
    const state = s[7] ? 'went through' : s[9] > 0.5 * r.P.W * r.P.H ? 'gone' : s[6] ? (s[12] ? `broken, ${s[12]} pieces loose` : 'cracked') : 'intact';
    return [`${k + 1}. ${g.name.replace(/,.*$/, '')}`, `${state}${what.length ? ' · hit by ' + what.join(', ') : ''}`];
  });
  useRig(rigs[0]);
  el.hidden = false;
  el.innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
}
// The layer list under the glass chips.
function renderLayers() {
  const box = $('layers');
  box.textContent = '';
  const opts = (sel) => cat.glazings.map((g, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${g.name}</option>`).join('');
  stack.forEach((l, k) => {
    const d = document.createElement('div');
    d.className = 'layer';
    d.innerHTML = `<b>${k + 2}</b><select aria-label="Pane ${k + 2} glass">${opts(l.gid)}</select><button title="Take this pane out">✕</button>` +
      `<label class="gap">Gap <input type="range" min="0" max="100" step="1" value="${Math.round(Math.sqrt(l.gap / 1.5) * 100)}" aria-label="Gap in front of pane ${k + 2}"><span></span></label>`;
    const [sel, del] = [d.querySelector('select'), d.querySelector('button')];
    const range = d.querySelector('input'), lab = d.querySelector('.gap span');
    // 0..1.5 m, finer near the glass.
    const show = () => { lab.textContent = l.gap < 0.1 ? `${(l.gap * 100).toFixed(1)} cm` : `${(l.gap * 100).toFixed(0)} cm`; };
    show();
    sel.onchange = () => { l.gid = +sel.value; rebuildLab(); };
    del.onclick = () => { stack.splice(k, 1); rebuildLab(); };
    range.oninput = () => { l.gap = Math.max(0.002, 1.5 * (range.value / 100) ** 2); show(); };
    range.onchange = () => rebuildLab();
    box.appendChild(d);
  });
  $('bAddLayer').hidden = stack.length >= MAX_LAYERS - 1;
}
$('bAddLayer').onclick = () => {
  if (stack.length >= MAX_LAYERS - 1) return;
  stack.push({ gid: gIdx, gap: 0.1 });
  rebuildLab();
};

// Stereo position of a pane point: where it sits across the screen.
const panV = R ? new THREE.Vector3() : null;
function panAt(x, y) {
  if (!R) return clamp(2 * x / P.W - 1, -1, 1) * 0.7;
  const [a, b, c] = toThree(x, y, 0);
  panV.set(a, b, c);
  groupPane.localToWorld(panV);
  panV.project(camera);
  return clamp(panV.x, -1, 1) * 0.85;
}
// Sound from this frame's engine news: strikes, pieces landing.
function listen(poses, nFrag) {
  if (!sound.live) return;
  const imps = G.impactors(P.nImp);
  for (let k = 0; k < P.nImp; ++k) {
    if (P.heard[k]) continue;
    const o = 20 * k, phase = imps[o + 9], hx = imps[o + 17], hy = imps[o + 18];
    const touched = phase === PH.CONTACT || phase === PH.BALLISTIC || phase === PH.MEMBRANE || ((phase === PH.FLIGHT || phase === PH.DONE) && (hx !== 0 || hy !== 0));
    if (!touched) continue;
    P.heard[k] = true;
    const def = cat.impactors[P.shotDefs[k] ?? iIdx], v = G.report(k).v, pan = panAt(hx, hy);
    sound.impact(def, v[0], v[2], P.profile, pan);
    if (def.kind === 'projectile' && v[12] && !v[11] && !v[13]) sound.ricochet(pan);
  }
  // Pieces that have just hit the floor: falling fast last frame, not now.
  if (!poses) return;
  if (P.prevVy.length < nFrag) { const a = new Float32Array(Math.max(nFrag, 2 * P.prevVy.length)); a.set(P.prevVy); P.prevVy = a; }
  let landed = 0;
  for (let i = 0; i < nFrag; ++i) {
    const q = i * 12, st = poses[q + 10], vy = poses[q + 8], before = P.prevVy[i];
    P.prevVy[i] = st === 2 || st === 3 ? vy : 0;
    if (landed >= 8 || before > -0.8 || vy < 0.4 * before || poses[q + 1] > P.floor + 0.3) continue;
    const size = P.pieceSize[i] || 0.01;
    sound.landing(size, -before, P.profile, panAt(poses[q], poses[q + 1] + FLOOR));
    ++landed;
  }
}

// Hook for automated browser tests.
window.__glass = { get P() { return P; }, THREE, scene, camera, G, get GT() { return GT; }, get HS() { return HS; }, get rigs() { return rigs; },
  get groupPane() { return groupPane; }, useRig, cam, applyCamera, sound, R, bench, get tier() { return tier; } };

// ---------- Odds of breaking ----------
// The same shot into a hundred panes, each with its own flaws, at the lab's
// physics, on copies of the engine in workers: each takes its share of the speeds.
let oddsWorkers = [], oddsId = 0, oddsPts = [], oddsSpeeds = [], oddsTicks = 0, oddsLeft = 0;
const ODDS_SEEDS = 10;
function oddsRange() {
  const d = cat.impactors[iIdx];
  const lo = Math.max(d.minSpeed || 0.1, speed / 20), hi = Math.min(Math.max(d.maxSpeed || speed, speed) * 1.5, 4 * speed);
  return Array.from({ length: 10 }, (_, i) => lo * Math.pow(hi / lo, i / 9));
}
function openOdds() {
  $('odds').classList.add('on');
  $('oddsWhat').textContent = `${cat.impactors[iIdx].name} into ${cat.glazings[gIdx].name}${P ? ` (${P.W.toFixed(2)} × ${P.H.toFixed(2)} m)` : ''}, square on at the centre.`;
  oddsSpeeds = oddsRange();
  oddsPts = [];
  $('oddsStatus').textContent = '';
  drawOdds();
}
function oddsDone() {
  const half = (key) => {
    for (let i = 1; i < oddsPts.length; ++i) {
      const a = oddsPts[i - 1], b = oddsPts[i];
      if (a[key] < 0.5 && b[key] >= 0.5) return a.v * Math.pow(b.v / a.v, (0.5 - a[key]) / Math.max(1e-9, b[key] - a[key]));
    }
    return oddsPts.length && oddsPts[0][key] >= 0.5 ? -1 : null;
  };
  const hb = half('broke'), ht = half('through');
  const say = (h, what) => (h === null ? `never ${what} in this range` : h < 0 ? `${what} half the time or more even at the slowest` : `${what} half the time at ${fmtSpeed(h)}`);
  $('oddsStatus').textContent = `${say(hb, 'breaks')} · ${say(ht, 'goes through')}`;
  $('bOddsRun').disabled = false;
}
function runOdds() {
  const n = clamp((navigator.hardwareConcurrency || 2) - 1, 1, 6);
  while (oddsWorkers.length < n) {
    const w = new Worker('odds_worker.js', { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.id !== oddsId) return;
      if (m.error) { $('oddsStatus').textContent = 'Could not run: ' + m.error; $('bOddsRun').disabled = false; return; }
      if (m.tick !== undefined) {
        ++oddsTicks;
        $('oddsStatus').textContent = `${Math.round(100 * oddsTicks / (oddsSpeeds.length * ODDS_SEEDS))} % · ${oddsPts.length} of ${oddsSpeeds.length} speeds`;
      }
      if (m.point) { oddsPts.push(m.point); oddsPts.sort((a, b) => a.v - b.v); drawOdds(); }
      if (m.done && --oddsLeft === 0) oddsDone();
    };
    oddsWorkers.push(w);
  }
  oddsId++;
  oddsPts = [];
  oddsTicks = 0;
  oddsSpeeds = oddsRange();
  const seeds = Array.from({ length: ODDS_SEEDS }, () => (Math.random() * 1e9) >>> 0);
  $('bOddsRun').disabled = true;
  $('oddsStatus').textContent = `Starting ${n > 1 ? n + ' more engines' : 'a second engine'}…`;
  drawOdds();
  // Speeds dealt out in turn, so every worker gets slow and fast ones.
  const used = oddsWorkers.slice(0, n).map((w, k) => ({ w, speeds: oddsSpeeds.filter((_, i) => i % n === k) })).filter((x) => x.speeds.length);
  oddsLeft = used.length;
  for (const { w, speeds } of used)
    w.postMessage({ id: oddsId, glazing: gIdx, impactor: iIdx, speeds, seeds, tier: PHYS, width: P ? P.W : 0, height: P ? P.H : 0 });
}
function drawOdds() {
  const c = $('oddsChart'), g = c.getContext('2d'), W = c.width, H = c.height;
  const L = 52, Rm = 14, T = 16, B = 40;
  g.clearRect(0, 0, W, H);
  g.font = '11px "JetBrains Mono", monospace';
  g.fillStyle = '#93a0b2'; g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
  const v0 = oddsSpeeds[0] || 1, v1 = oddsSpeeds[oddsSpeeds.length - 1] || 2;
  const X = (v) => L + (W - L - Rm) * Math.log(v / v0) / Math.log(v1 / v0), Y = (p) => T + (H - T - B) * (1 - p);
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    g.beginPath(); g.moveTo(L, Y(p)); g.lineTo(W - Rm, Y(p)); g.stroke();
    g.fillText(`${Math.round(100 * p)} %`, 8, Y(p) + 4);
  }
  for (let i = 0; i < oddsSpeeds.length; i += 3) {
    const v = oddsSpeeds[i];
    g.fillText(fmtSpeed(v), X(v) - 18, H - B + 18);
  }
  g.fillText('speed', W - Rm - 40, H - 6);
  // The speed set in the lab.
  if (speed >= v0 && speed <= v1) {
    g.strokeStyle = 'rgba(255,211,107,0.6)'; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(X(speed), T); g.lineTo(X(speed), H - B); g.stroke(); g.setLineDash([]);
  }
  for (const [key, col, label] of [['broke', '#f0b43a', 'breaks'], ['through', '#ef5d4f', 'goes through']]) {
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2;
    g.beginPath();
    oddsPts.forEach((pt, i) => (i ? g.lineTo(X(pt.v), Y(pt[key])) : g.moveTo(X(pt.v), Y(pt[key]))));
    g.stroke();
    for (const pt of oddsPts) { g.beginPath(); g.arc(X(pt.v), Y(pt[key]), 3.5, 0, 2 * Math.PI); g.fill(); }
    g.fillText(label, key === 'broke' ? L + 8 : L + 80, T + 12);
  }
}
$('bOdds').onclick = openOdds;
$('bOddsRun').onclick = runOdds;
$('bOddsClose').onclick = () => $('odds').classList.remove('on');
$('odds').onclick = (e) => { if (e.target === $('odds')) $('odds').classList.remove('on'); };

// ---------- A glass cutter ----------
// A score is a scratch with a vent crack under it: it gives at a fraction of
// the glass's strength, and a crack that meets it follows it. Knocking it from
// the far side opens it (bending closes a score on the side you push).
let cutMode = null, cutLine = null;
function addScore(pts, closed) {
  if (!P || rigs || activeScene() || pts.length < 2) return;
  G.gls_score_begin();
  for (const p of pts) G.gls_score_point(p.x, p.y);
  if (G.gls_score_end(closed ? 1 : 0, 0) < 0) return;
  (P.scores ||= []).push({ pts: pts.map((p) => ({ x: p.x, y: p.y })), closed });
  if (R) {
    const v = pts.map((p) => new THREE.Vector3(p.x - P.W / 2, p.y + FLOOR, 0.0006));
    if (closed) v.push(v[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0.75 }));
    line.renderOrder = 3;
    groupPane.add(line); P.meshes.push(line);
  }
  $('bKnock').disabled = false;
  toast(closed ? 'Scored a circle. Now knock it out from behind' : 'Scored. Knock it from behind to snap it', 2600);
}
function circlePts(c, r) { return Array.from({ length: 64 }, (_, i) => ({ x: c.x + r * Math.cos(2 * Math.PI * i / 64), y: c.y + r * Math.sin(2 * Math.PI * i / 64) })); }
function setCutMode(m) {
  cutMode = cutMode === m ? null : m;
  $('bCutter').setAttribute('aria-pressed', String(cutMode === 'line'));
  $('bCircle').setAttribute('aria-pressed', String(cutMode === 'circle'));
  if (cutMode) toast(cutMode === 'line' ? 'Drag across the glass to score it' : 'Tap the glass where the circle goes');
}
// Behind the last score: inside a circle, or 4 cm beside the middle of a line.
function knockOut() {
  const sc = P && P.scores && P.scores[P.scores.length - 1];
  if (!sc) return;
  const n = sc.pts.length;
  let at;
  if (sc.closed) at = sc.pts.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n }), { x: 0, y: 0 });
  else {
    const i = Math.floor((n - 1) / 2), a = sc.pts[i], b = sc.pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    at = { x: (a.x + b.x) / 2 - 0.04 * dy / L, y: (a.y + b.y) / 2 + 0.04 * dx / L };
  }
  const ii = cat.impactors.findIndex((d) => d.id === 'rubber_mallet');
  if (ii < 0) return;
  pickImpactor(ii);
  speed = 5; fromBack = true;
  $('bSide').setAttribute('aria-pressed', 'true');
  syncSpeed();
  aim = { x: clamp(at.x, 0.01, P.W - 0.01), y: clamp(at.y, 0.01, P.H - 0.01) };
  placeAimMarker();
  fire(aim);
}
$('bCutter').onclick = () => setCutMode('line');
$('bCircle').onclick = () => setCutMode('circle');
$('bKnock').onclick = knockOut;
function startBurglar() {
  const gi = cat.glazings.findIndex((g) => g.id === 'annealed_6');
  if (gi < 0) return;
  if (activeScene()) leaveScene(false);
  if (stackOn || stack.length) { stack = []; leaveStack(false); renderLayers(); }
  if (TONE.on) setTone(false);
  gIdx = gi;
  chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
  newPane();
  simClockReset();
  addScore(circlePts({ x: P.W / 2, y: P.H / 2 }, 0.1), true);
  setTimeout(() => { if (P && P.scores) knockOut(); }, 1400);
}

// ---------- Read the cracks ----------
// Three stones hit a windscreen while you look away. Their cracks say in which
// order: a running crack stops where it meets one already there, so the first
// star's cracks run out to the frame and the later ones' end at the earlier.
function startForensics() {
  const gi = cat.glazings.findIndex((g) => g.id === 'windscreen'), ii = cat.impactors.findIndex((d) => d.id === 'steel_ball_227');
  if (gi < 0 || ii < 0) return;
  if (activeScene()) leaveScene(false);
  if (stackOn || stack.length) { stack = []; leaveStack(false); renderLayers(); }
  if (TONE.on) setTone(false);
  gIdx = gi;
  chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
  pickImpactor(ii);
  speed = 16; yaw = 0; pitch = 0; fromBack = false;
  $('bSide').setAttribute('aria-pressed', 'false');
  syncSpeed();
  newPane();
  simClockReset();
  P.puzzle = { phase: 'hidden', text: 'Three stones are about to hit this windscreen while you look away…' };
  if (aimMarker) aimMarker.visible = false;
  toast('Look away… three stones hit the windscreen', 2400);
  setTimeout(() => {
    // Across the windscreen, in a random order, 60 ms apart; every one must
    // have broken the glass (a stone can bounce off), or the evidence is
    // thrown away and it happens again.
    for (let attempt = 0; attempt < 8; ++attempt) {
      if (attempt) newPane();
      const r = mulberry32((P.seed ^ 0x9e3779b9) >>> 0);
      const cols = [0.2, 0.5, 0.8].sort(() => r() - 0.5);
      const pts = cols.map((c) => ({ x: P.W * (c + 0.06 * (r() - 0.5)), y: P.H * (0.3 + 0.4 * r()) }));
      const t0 = G.gls_time();
      pts.forEach((p, k) => { G.gls_advance(t0 + 0.06 * k, 50000000); fire(p); });
      G.gls_advance(t0 + 0.12 + 0.4, 50000000);
      P.puzzle = { pts, guess: [], phase: 'hidden' };
      let all = true;
      for (let k = 0; k < 3; ++k) all = all && G.report(k).v[10] > 0;
      if (all) break;
    }
    for (const m of P.impMeshes) if (m) m.visible = false;
    if (aimMarker) aimMarker.visible = false;
    simClockReset();
    auto = true; syncAuto(); buildScaleButtons();
    P.puzzle.phase = 'guess';
    P.puzzle.text = 'Which came first? Tap the three impact points in the order they happened.';
    P.puzzle.cls = '';
    $('rWhat').textContent = 'Read the cracks';
    banner('Which came first?', 'Tap the impact points in order');
  }, 1200);
}
function puzzleLabel(text, color) {
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = color; g.beginPath(); g.arc(48, 48, 40, 0, 2 * Math.PI); g.fill();
  g.fillStyle = '#0a1830'; g.font = '900 44px "Big Shoulders Display", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 48, 51);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.renderOrder = 8;
  return sp;
}
function puzzleTap(p) {
  const pz = P.puzzle;
  if (!p || pz.phase !== 'guess') return;
  let best = -1, bd = 0.1;
  pz.pts.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd && !pz.guess.includes(i)) { bd = d; best = i; } });
  if (best < 0) { toast('Tap right on an impact point'); return; }
  pz.guess.push(best);
  if (R) {
    const q = pz.pts[best], sp = puzzleLabel(String(pz.guess.length), '#ffd36b');
    sp.position.set(q.x - P.W / 2, q.y + FLOOR, 0.02);
    sp.scale.setScalar(0.09);
    groupPane.add(sp); P.meshes.push(sp);
  }
  if (pz.guess.length < pz.pts.length) return;
  // The reveal: the true order beside each guess.
  pz.phase = 'done';
  const right = pz.guess.every((g, k) => g === k);
  if (R) pz.pts.forEach((q, i) => {
    const rank = pz.guess.indexOf(i) + 1, ok = rank === i + 1;
    const sp = puzzleLabel(String(i + 1), ok ? '#36c483' : '#ef5d4f');
    sp.position.set(q.x - P.W / 2 + 0.07, q.y + FLOOR + 0.06, 0.02);
    sp.scale.setScalar(0.07);
    groupPane.add(sp); P.meshes.push(sp);
  });
  banner(right ? 'Read it right' : 'Not quite', right ? 'The order of the stones, from their cracks alone' : 'Green: the true order, where you had it right');
  pz.cls = right ? 'ok' : 'bad';
  pz.text = (right ? 'Right. ' : 'Not quite. ') + 'The first star\'s cracks run out to the frame; the second\'s stop where they meet the first\'s; the third\'s stop at both. Replay (Z) shows it happening.';
  updateReadouts();
}

// ---------- Certification tests ----------
// Each scenario that reproduces a published test says whether the glass would
// pass it, by that test's own criterion, and what of the test is not simulated.
// v: the shot's report; s: the pane's state.
function testVerdict(kind, v, s) {
  const through = !!v[11], stopped = !!v[13], broke = !!s[6], intact = !!s[8];
  switch (kind) {
    case 'r43': return { name: 'ECE R43 2.26 kg ball', pass: !through,
      why: through ? 'the ball went through the windscreen' : 'the interlayer held the ball' };
    case 'e1996': return { name: 'ASTM E1996 missile D', pass: !through,
      why: (through ? 'the 2x4 went through' : 'no penetration on impact') + '; the 9,000 pressure cycles that follow in the real test are not simulated' };
    case 'far25': return { name: '14 CFR 25.775 bird strike', pass: intact && !through,
      why: intact ? 'the windshield kept the cabin sealed' : 'the windshield was breached: the cabin would depressurise' };
    case 'z97': {
      const tempered = P.plies.some((p) => p.dicing);
      return { name: 'ANSI Z97.1 impact', pass: !broke || tempered,
        why: !broke ? 'it did not break' : tempered ? 'it broke into small dice, as safety glass must' : 'it broke into long sharp shards: annealed glass cannot pass' };
    }
    case 'ul752': return { name: 'UL 752 (one shot)', pass: stopped && !through,
      why: stopped ? 'the round was stopped in the layup' : 'the round went through' };
    default: return null;
  }
}

// ---------- A pane that breaks by itself ----------
// Nickel sulfide: a stone in the glass that slowly changes phase and swells,
// years after tempering. In the tensile core of a tempered pane, a big enough
// one breaks it with nothing touching it.
function plantStone(n, delay = 1.6) {
  if (!P || rigs || activeScene()) return;
  P.nis = { x: n.x, y: n.y, d: n.d };
  toast(delay > 0.5 ? `A ${n.d.toFixed(2)} mm nickel-sulfide stone sits in the glass. Years pass…` : 'Again', 2600);
  setTimeout(() => {
    if (!P || !P.nis) return;
    const broke = G.gls_nickel_sulfide(n.x, n.y, n.d);
    P.nis.broke = !!broke;
    P.nis.text = (G.text() || '').replace(/^\s*[\d.]+ us\s+/, '').replace(/^./, (c) => c.toUpperCase());
    banner(broke ? 'Exploded on its own' : 'Still standing', broke ? 'Nothing touched it' : 'The stone is too small to break it');
    simClockReset();
    auto = true; syncAuto(); buildScaleButtons();
  }, delay * 1000);
}

// ---------- Sound: a steady note at the glass ----------
// A loudspeaker (or a voice) is a plane wave on the struck face: the engine
// gets its peak pressure at the glass, doubled by the reflection there. A
// shaker pushes at one point instead, and can drive every mode.
const TONE = { ratio: 0, on: false, freq: 0, dB: 140, shaker: false, mic: null, boost: 40, holo: false, env: null, envT: 0,
  swing: 0, stress: 0, strength: 0, stressT: 0, startT: 0, osc: null, gain: null, broke: false, modes: [], lastSent: '' };
const SHAKER_AT = [0.31, 0.37];   // share of the width and height: off every line of symmetry
const EXAGS = [1, 10, 50];
const TONE_SLOW = 1 / 12;   // playback speed while a note builds up
const dBToPa = (dB) => 2 * Math.SQRT2 * 20e-6 * Math.pow(10, dB / 20);
const levelToN = (v) => Math.pow(10, (v - 140) / 20);   // the shaker's slider: 140 = 1 N peak
function toneLevel() { return TONE.shaker ? levelToN(TONE.dB) : dBToPa(TONE.dB); }
function fmtHz(f) { return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${f.toFixed(f < 100 ? 1 : 0)} Hz`; }
function freqToSlider(f) { return Math.round(2000 * Math.log(f / 10) / Math.log(500)); }
function sliderToFreq(v) { return 10 * Math.pow(500, v / 2000); }
function toneAvailable() { return !!P && !rigs && !activeScene(); }
// Send the note to the engine (only when it changed).
function applyTone(force = false) {
  if (!toneAvailable()) return;
  const lvl = TONE.on ? toneLevel() * (TONE.mic ? TONE.mic.gate : 1) : 0;
  const key = `${TONE.freq.toFixed(3)}|${lvl.toPrecision(4)}|${TONE.shaker}`;
  if (!force && key === TONE.lastSent) return;
  TONE.lastSent = key;
  G.gls_tone(TONE.freq, lvl, TONE.mic ? 0.03 : 0.05, TONE.shaker ? 1 : 0, SHAKER_AT[0] * P.W, SHAKER_AT[1] * P.H);
}
// The pane's lowest notes, as chips (a loudspeaker only drives the ones odd both ways).
function toneNewPane() {
  TONE.env = null; TONE.swing = TONE.stress = TONE.ratio = 0; TONE.broke = false; TONE.lastSent = '';
  if (!P || rigs) return;
  const fresh = TONE.gid !== P.glazing.id;
  TONE.gid = P.glazing.id;
  const s = G.state(), M = Math.min(s[18], 7), N = Math.min(s[19], 7), list = [];
  for (let m = 1; m <= M; ++m) for (let n = 1; n <= N; ++n) list.push({ m, n, f: G.gls_mode_hz(m, n) });
  list.sort((a, b) => a.f - b.f);
  TONE.modes = list.slice(0, 8);
  if ((!TONE.freq || fresh) && !TONE.mic) TONE.freq = TONE.modes[0]?.f || 100;
  renderModes();
  syncToneUI();
  if (TONE.on) { TONE.startT = G.gls_time(); applyTone(true); }
}
function renderModes() {
  const box = $('modes');
  box.textContent = '';
  for (const md of TONE.modes) {
    const b = document.createElement('button');
    const odd = md.m % 2 && md.n % 2;
    b.innerHTML = `${fmtHz(md.f)}<small>${md.m}·${md.n}</small>`;
    b.title = `Mode ${md.m}×${md.n}: ${md.m} half-waves across, ${md.n} up` + (odd || TONE.shaker ? '' : '. Sound pushes the whole face evenly and cannot drive this one: use the shaker');
    b.setAttribute('aria-pressed', String(Math.abs(TONE.freq / md.f - 1) < 0.002));
    if (!odd && !TONE.shaker) b.style.opacity = '0.55';
    b.onclick = () => { TONE.freq = md.f; syncToneUI(); applyTone(); };
    box.appendChild(b);
  }
}
function syncToneUI() {
  $('bTone').setAttribute('aria-pressed', String(TONE.on));
  $('bTone').textContent = TONE.on ? 'Stop note' : 'Play note';
  $('bMic').setAttribute('aria-pressed', String(!!TONE.mic));
  $('bDrive').textContent = TONE.shaker ? 'Shaker' : 'Loudspeaker';
  $('freq').value = String(freqToSlider(Math.max(10, TONE.freq)));
  $('vFreq').textContent = fmtHz(TONE.freq);
  $('level').value = String(TONE.dB);
  $('lLevel').textContent = TONE.shaker ? 'Shaker force' : TONE.mic ? 'Your voice at the glass' : 'Level at the glass';
  const n = levelToN(TONE.dB);
  $('vLevel').textContent = TONE.shaker ? (n >= 1 ? `${n.toFixed(n >= 10 ? 0 : 1)} N` : `${(n * 1e3).toFixed(n >= 0.01 ? 0 : 1)} mN`)
    : `${TONE.dB.toFixed(0)} dB · ${fmtPa(dBToPa(TONE.dB))}`;
  $('boostRow').hidden = !TONE.mic;
  $('vBoost').textContent = `+${TONE.boost} dB`;
  $('level').disabled = !!TONE.mic;
  $('freq').disabled = !!TONE.mic;
  $('bHolo').setAttribute('aria-pressed', String(TONE.holo));
  $('bExag').textContent = `Swing ×${exaggeration}`;
  for (const b of $('modes').children) b.setAttribute('aria-pressed', 'false');
  TONE.modes.forEach((md, i) => { if (Math.abs(TONE.freq / md.f - 1) < 0.002) $('modes').children[i]?.setAttribute('aria-pressed', 'true'); });
  const ok = toneAvailable();
  for (const id of ['bTone', 'bMic', 'bDrive']) $(id).disabled = !ok;
}
function fmtPa(p) { return p >= 1000 ? `${(p / 1000).toFixed(p >= 1e4 ? 0 : 1)} kPa` : `${p.toFixed(p >= 10 ? 0 : 1)} Pa`; }
function setTone(on) {
  if (on && !toneAvailable()) return;
  TONE.on = on;
  TONE.broke = false;
  if (on) {
    sound.start();
    if (P && (P.broken.some(Boolean) || G.state()[6])) newPane();   // a fresh pane to sing at
    TONE.startT = G.gls_time();
    TONE.env = null;
    playing = true; syncPlay();
    auto = true; syncAuto(); buildScaleButtons();
  }
  if (!on && TONE.mic) stopMic();
  applyTone(true);
  syncToneUI();
}
// What you hear: the note itself, quietly (not while singing, so the
// microphone does not hear it), stopping when the glass breaks.
function toneSound() {
  const live = sound.live && TONE.on && !TONE.mic;
  if (!live) { if (TONE.gain) TONE.gain.gain.setTargetAtTime(0, sound.ctx.currentTime, 0.05); return; }
  const c = sound.ctx;
  if (!TONE.osc) {
    TONE.osc = c.createOscillator(); TONE.gain = c.createGain(); TONE.gain.gain.value = 0;
    TONE.osc.type = 'sine'; TONE.osc.connect(TONE.gain).connect(c.destination); TONE.osc.start();
  }
  // At its own pitch while it builds up, even in slow motion: it is the note being played.
  const heard = playing ? TONE.freq : 0;
  const g = heard < 25 || heard > 16000 ? 0 : clamp(0.02 + 0.0016 * (TONE.dB - 60), 0.02, 0.16);
  TONE.osc.frequency.setTargetAtTime(Math.max(20, heard), c.currentTime, 0.02);
  TONE.gain.gain.setTargetAtTime(g, c.currentTime, 0.05);
}
// Every frame of a single pane.
function toneFrame(dt, s, tEng) {
  toneSound();
  if (!TONE.on || !P) return;
  if (TONE.mic) micFrame();
  applyTone();
  if (!TONE.broke && (s[6] || P.broken.some(Boolean))) {
    TONE.broke = true;
    applyTone(true);
    const took = tEng - TONE.startT;
    const sub = `${fmtHz(TONE.freq)} at ${TONE.shaker ? $('vLevel').textContent : `${TONE.dB.toFixed(0)} dB`}, after ${took < 1 ? `${(took * 1e3).toFixed(0)} ms` : `${took.toFixed(2)} s`} of it`;
    TONE.brokeText = `Shattered by sound: ${sub}, swinging ${(TONE.swing * 1e3).toFixed(1)} mm`;
    banner('Shattered by sound', sub);
    // The note ends with the glass (the readouts keep what it reached).
    TONE.on = false;
    if (TONE.mic) stopMic();
    syncToneUI();
    return;
  }
  // How near a flaw has come to failing, held over the last few cycles.
  const ss = G.stressStrength();
  const keep = Math.exp(-Math.max(0, tEng - TONE.stressT) * TONE.freq / 4);
  if (ss[0] >= TONE.ratio * keep) { TONE.ratio = ss[0]; TONE.stress = ss[1]; TONE.strength = ss[2]; } else TONE.ratio *= keep;
  TONE.stressT = tEng;
  TONE.swing = G.gls_tone_swing();
}
function toneReadout() {
  if (!TONE.on && !TONE.broke) { $('toneKv').innerHTML = ''; $('meterBar').style.width = '0'; $('toneInfo').textContent = ''; return; }
  const net = Math.max(0, TONE.stress), ratio = TONE.ratio;
  $('meterBar').style.width = `${clamp(100 * ratio, 0, 100)}%`;
  const near = TONE.modes.reduce((b, md) => (Math.abs(Math.log(TONE.freq / md.f)) < Math.abs(Math.log(TONE.freq / b.f)) ? md : b), TONE.modes[0] || { f: TONE.freq, m: 1, n: 1 });
  const cents = 1200 * Math.log2(TONE.freq / near.f);
  const rows = [
    ['Nearest note', `${fmtHz(near.f)} (mode ${near.m}×${near.n}) · ${Math.abs(cents) < 1 ? 'on it' : `${cents > 0 ? '+' : '−'}${Math.abs(cents).toFixed(0)} cents`}`],
    ['Swing', `${(TONE.swing * 1e3).toFixed(TONE.swing < 1e-3 ? 3 : 1)} mm${P ? ` · ${(TONE.swing / P.T).toFixed(1)}× its thickness` : ''}`],
    ['Weakest flaw', `${(net / 1e6).toFixed(net < 1e7 ? 1 : 0)} of the ${(TONE.strength / 1e6).toFixed(0)} MPa it takes (${(100 * ratio).toFixed(0)} %)`],
  ];
  if (TONE.mic) rows.unshift(['Your voice', TONE.mic.pitch ? `${fmtHz(TONE.mic.pitch)} · about ${TONE.mic.db.toFixed(0)} dB + ${TONE.boost} boost` : 'listening…']);
  $('toneKv').innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
  $('toneInfo').textContent = TONE.broke ? 'broken' : TONE.on ? 'playing' : '';
  $('toneNote').textContent = P && TONE.swing > P.T
    ? 'Swinging further than its own thickness: a real pane would stretch, stiffen and drift off the note here, so this linear plate is generous past this point.'
    : 'Every pane has notes it rings at. Play one of them loud enough and the swing builds up until the glass breaks.';
}
// The swing of every point, from the deflection field, and the hologram of it.
function toneField(f) {
  if ((!TONE.on && !TONE.holo) || TONE.broke) return;
  const n = FX * FY, t = G.gls_time();
  if (!TONE.env || TONE.env.length !== n) TONE.env = new Float32Array(n);
  const keep = Math.exp(-Math.max(0, t - TONE.envT) * Math.max(TONE.freq, 1) / 4);
  TONE.envT = t;
  let mx = 0;
  for (let i = 0; i < n; ++i) { TONE.env[i] = Math.max(Math.abs(f[i]), TONE.env[i] * keep); mx = Math.max(mx, TONE.env[i]); }
  if (!TONE.holo) return;
  // Time-averaged holography: brightness J0(2 pi A / step)^2, so the still
  // lines (nodes) shine and each dark band is a step more swing.
  const step = Math.max(mx / 4, 1e-9), img = stressCtx.createImageData(FX, FY);
  for (let j = 0; j < FY; ++j)
    for (let i = 0; i < FX; ++i) {
      const a = TONE.env[j * FX + i], b = besselJ0(2.405 * a / step * 1.25);
      const I = b * b, o = ((FY - 1 - j) * FX + i) * 4;
      img.data[o] = 255 * (0.08 + 0.92 * I); img.data[o + 1] = 255 * (0.03 + 0.42 * I); img.data[o + 2] = 255 * (0.04 + 0.3 * I); img.data[o + 3] = 230;
    }
  stressCtx.putImageData(img, 0, 0);
  if (stressTex) stressTex.needsUpdate = true;
}
function besselJ0(x) {
  const ax = Math.abs(x);
  if (ax < 8) {
    const y = x * x;
    return (57568490574.0 + y * (-13362590354.0 + y * (651619640.7 + y * (-11214424.18 + y * (77392.33017 + y * -184.9052456))))) /
      (57568490411.0 + y * (1029532985.0 + y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y)))));
  }
  const z = 8 / ax, y = z * z, xx = ax - 0.785398164;
  const p1 = 1 + y * (-0.1098628627e-2 + y * (0.2734510407e-4 + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
  const p2 = -0.1562499995e-1 + y * (0.1430488765e-3 + y * (-0.6911147651e-5 + y * (0.7621095161e-6 - y * 0.934935152e-7)));
  return Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p1 - z * Math.sin(xx) * p2);
}
function overlayOn() { return stressOn || TONE.holo; }

// Singing: the voice's pitch (autocorrelation) and loudness drive the note.
// A phone or laptop microphone is not calibrated: full scale is taken as
// about 120 dB SPL, so the level shown is a rough one.
async function startMic() {
  if (!toneAvailable()) return;
  try {
    sound.start();
    const c = sound.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = c.createMediaStreamSource(stream), an = c.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    TONE.mic = { stream, an, buf: new Float32Array(an.fftSize), rate: c.sampleRate, pitch: 0, db: 0, gate: 0 };
    setTone(true);
    toast('Sing a steady note near one of the glass\'s notes');
  } catch (e) {
    toast('The microphone is not available here');
    TONE.mic = null;
  }
  syncToneUI();
}
function stopMic() {
  if (!TONE.mic) return;
  for (const tr of TONE.mic.stream.getTracks()) tr.stop();
  TONE.mic = null;
  syncToneUI();
}
function micFrame() {
  const m = TONE.mic, b = m.buf;
  m.an.getFloatTimeDomainData(b);
  let rms = 0;
  for (let i = 0; i < b.length; ++i) rms += b[i] * b[i];
  rms = Math.sqrt(rms / b.length);
  const dbfs = 20 * Math.log10(Math.max(rms, 1e-8));
  const f = dbfs > -55 ? pitchOf(b, m.rate) : 0;
  m.gate = f ? 1 : 0;
  if (!f) return;
  m.pitch = m.pitch ? m.pitch + (f - m.pitch) * 0.35 : f;
  m.db = dbfs + 120;
  TONE.freq = m.pitch;
  TONE.dB = clamp(m.db + TONE.boost, 60, 175);
}
// Normalised autocorrelation, 70 Hz to 1.2 kHz, refined by a parabola.
function pitchOf(b, rate) {
  const n = b.length, lo = Math.floor(rate / 1200), hi = Math.min(Math.floor(rate / 70), n >> 1);
  let best = 0, lag = 0;
  const corr = new Float32Array(hi + 2);
  for (let L = lo; L <= hi + 1; ++L) {
    let c = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + L < n; ++i) { c += b[i] * b[i + L]; e1 += b[i] * b[i]; e2 += b[i + L] * b[i + L]; }
    corr[L] = c / Math.sqrt(e1 * e2 + 1e-12);
    if (L <= hi && corr[L] > best) { best = corr[L]; lag = L; }
  }
  if (best < 0.85 || !lag) return 0;
  const a = corr[lag - 1] || 0, c2 = corr[lag + 1] || 0, d = a - 2 * corr[lag] + c2;
  return rate / (lag + (d ? 0.5 * (a - c2) / d : 0));
}

$('bTone').onclick = () => setTone(!TONE.on);
$('bMic').onclick = () => (TONE.mic ? setTone(false) : startMic());
$('bDrive').onclick = () => { TONE.shaker = !TONE.shaker; if (TONE.shaker && TONE.dB > 165) TONE.dB = 150; renderModes(); syncToneUI(); applyTone(true); };
$('freq').oninput = (e) => { TONE.freq = sliderToFreq(+e.target.value); syncToneUI(); applyTone(); };
$('level').oninput = (e) => { TONE.dB = +e.target.value; syncToneUI(); applyTone(); };
$('boost').oninput = (e) => { TONE.boost = +e.target.value; syncToneUI(); };
$('bHolo').onclick = () => {
  TONE.holo = !TONE.holo;
  if (TONE.holo && stressOn) $('bStress').click();
  if (stressMesh) stressMesh.visible = overlayOn();
  syncToneUI();
};
$('bExag').onclick = () => {
  exaggeration = EXAGS[(EXAGS.indexOf(exaggeration) + 1) % EXAGS.length];
  syncToneUI();
  if (P) updateField();
};

// ---------- Share links ----------
// The lab's whole setup in the address: the glass and any panes behind it,
// every shot fired (object, speed, angles, side, aim point, time) and the
// panes' seeds, so whoever opens it sees the same break.
function shareURL() {
  if (HS && HS.active) return new URL('grenade/' + (HS.glass && HS.glass !== 'tempered' ? '?glass=' + HS.glass : ''), document.baseURI).href;
  const u = new URL('./', document.baseURI);
  if (GT && GT.active) { u.searchParams.set('scene', 'gt'); return u.href; }
  const pane = stackOn ? rigs[0].P : P, q = u.searchParams;
  q.set('g', cat.glazings[gIdx].id);
  for (const l of stack) q.append('L', `${cat.glazings[l.gid].id}:${+(l.gap * 100).toFixed(1)}`);
  q.set('seed', (stackOn ? rigs.map((r) => r.P.seed) : [pane.seed]).join('.'));
  const at = aim || { x: pane.W / 2, y: pane.H / 2 };
  if (P && P.scores && !stackOn)
    for (const sc of P.scores) q.append('cut', (sc.closed ? 'c' : 'l') + sc.pts.map((p) => `${+p.x.toFixed(4)},${+p.y.toFixed(4)}`).join(';'));
  if (P && P.nis && !stackOn) q.set('nis', [+P.nis.x.toFixed(4), +P.nis.y.toFixed(4), +P.nis.d.toFixed(3)].join(','));
  const toned = (TONE.on || TONE.broke) && !stackOn;
  if (toned) q.set('tone', [+TONE.freq.toFixed(2), +TONE.dB.toFixed(1), TONE.shaker ? 1 : 0].join(','));
  const shots = pane.shots.length ? pane.shots : toned || P.nis ? [] : [{ t: 0, iIdx, x: at.x, y: at.y, speed, yaw, pitch, fromBack }];
  const t0 = shots.length ? shots[0].t : 0;
  for (const sh of shots)
    q.append('shot', [cat.impactors[sh.iIdx].id, +sh.speed.toFixed(2), +sh.x.toFixed(4), +sh.y.toFixed(4), +sh.yaw.toFixed(1),
      +sh.pitch.toFixed(1), sh.fromBack ? 1 : 0, +(sh.t - t0).toFixed(5)].join(','));
  return u.href;
}
function shareText() {
  if (HS && HS.active) return 'Grenade in the shop';
  if (GT && GT.active) return 'Rosser V8 under fire';
  if (P.nis && !stackOn && !P.shots.length) return `${cat.glazings[gIdx].name} with a ${P.nis.d.toFixed(2)} mm nickel-sulfide stone`;
  if ((TONE.on || TONE.broke) && !stackOn && !P.shots.length) return `${cat.glazings[gIdx].name} sung at ${fmtHz(TONE.freq)}, ${TONE.shaker ? $('vLevel').textContent + ' shaker' : `${TONE.dB.toFixed(0)} dB`}`;
  const pane = stackOn ? rigs[0].P : P;
  const sh = pane.shots[pane.shots.length - 1] || { iIdx, speed };
  const glass = [cat.glazings[gIdx], ...stack.map((l) => cat.glazings[l.gid])].map((g) => g.name).join(' + ');
  return `${cat.impactors[sh.iIdx].name} at ${fmtSpeed(sh.speed)} into ${glass}`;
}
$('bShare').onclick = async () => {
  const url = shareURL(), text = shareText();
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Glass Lab · ' + text, text, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied: ' + text, 3500); }
  } catch { /* cancelled */ }
};
// Opens a shared setup: builds it and fires its shots as they were fired.
function applyShareLink() {
  const q = new URLSearchParams(location.search);
  if (!q.has('g') && !q.has('shot')) return false;
  const gi = cat.glazings.findIndex((g) => g.id === q.get('g'));
  if (gi >= 0) gIdx = gi;
  stack = q.getAll('L').map((v) => {
    const [id, cm] = v.split(':');
    return { gid: cat.glazings.findIndex((g) => g.id === id), gap: clamp((Number(cm) || 10) / 100, 0.002, 1.5) };
  }).filter((l) => l.gid >= 0).slice(0, MAX_LAYERS - 1);
  const seeds = (q.get('seed') || '').split('.').map(Number).filter((v) => Number.isFinite(v) && v >= 0);
  const shots = q.getAll('shot').map((v) => {
    const a = v.split(','), ii = cat.impactors.findIndex((d) => d.id === a[0]);
    if (ii < 0 || !(Number(a[1]) > 0)) return null;
    return { iIdx: ii, speed: +a[1], x: +a[2] || 0, y: +a[3] || 0, yaw: clamp(+a[4] || 0, -60, 60), pitch: clamp(+a[5] || 0, -60, 60),
      fromBack: a[6] === '1', t: Math.max(0, +a[7] || 0) };
  }).filter(Boolean).slice(0, 200);
  chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
  const last = shots[shots.length - 1];
  if (last) {
    pickImpactor(last.iIdx, true);
    speed = last.speed; yaw = last.yaw; pitch = last.pitch; fromBack = last.fromBack;
    $('yaw').value = String(yaw); $('pitch').value = String(pitch); $('vAngle').textContent = `${yaw}° / ${pitch}°`;
    $('bSide').setAttribute('aria-pressed', String(fromBack));
    syncSpeed();
  }
  rebuildLab(seeds.length ? seeds : undefined);
  if (stackOn) useRig(rigs[0]);
  const t = G.gls_time() + 0.3;
  P.shots = shots.map((sh) => ({ ...sh, x: clamp(sh.x, 0.005, P.W - 0.005), y: clamp(sh.y, 0.005, P.H - 0.005), t: t + sh.t }));
  P.pendingShots = P.shots.slice();
  if (last) { aim = { x: P.shots[P.shots.length - 1].x, y: P.shots[P.shots.length - 1].y }; placeAimMarker(); }
  auto = true; syncAuto(); buildScaleButtons();
  simClockReset();
  for (const c of q.getAll('cut').slice(0, 20)) {
    const pts = c.slice(1).split(';').map((v) => v.split(',').map(Number)).filter((v) => v.length === 2 && v.every(Number.isFinite)).slice(0, 400).map(([x, y]) => ({ x, y }));
    if (!stackOn) addScore(pts, c[0] === 'c');
  }
  const ns = (q.get('nis') || '').split(',').map(Number);
  if (ns.length === 3 && ns[2] > 0 && !stackOn) plantStone({ x: clamp(ns[0], 0, P.W), y: clamp(ns[1], 0, P.H), d: clamp(ns[2], 0.01, 2) });
  const tn = (q.get('tone') || '').split(',').map(Number);
  if (tn[0] > 0 && !stackOn) {
    TONE.freq = clamp(tn[0], 10, 5000);
    TONE.dB = clamp(tn[1] || 140, 60, 175);
    TONE.shaker = tn[2] === 1;
    renderModes();
    setTone(true);
  } else if (window.innerWidth <= 860) showTab('res');
  return true;
}

// ---------- Boot ----------
resize();
window.addEventListener('resize', resize);
chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
pickImpactor(iIdx);
buildPresets();
$('bUnit').textContent = UNITS[unit][0];
buildScaleButtons();
syncAuto();
syncPlay();
{
  const q = new URLSearchParams(location.search);
  if (!q.has('g') && !q.has('shot')) {
    const plate = cat.glazings.findIndex((g) => g.id === 'annealed_10');
    if (plate >= 0) stack = [0, 1, 2].map(() => ({ gid: plate, gap: 1.0 }));
  }
}
rebuildLab();
simClockReset();
const shared = applyShareLink();
if (window.innerWidth <= 860 && !shared) showTab('lab');
$('loading').remove();
if (!store.get('seenHelp', false)) { toast('Tap the glass to fire · drag to orbit · ? for how it works', 4500); store.set('seenHelp', true); }
if (flat) toast('No WebGL here: drawing the front view in 2D. The physics is the same.', 4000);
if (new URLSearchParams(location.search).get('scene') === 'gt') startScene();
if (new URLSearchParams(location.search).get('scene') === 'house') startHouse();
requestAnimationFrame(frame);
