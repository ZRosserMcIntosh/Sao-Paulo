// São Paulo World · Glass Lab.
// Physics: the Glass Dynamics fracture core (C++, MIT) compiled to WebAssembly.
// Rendering: three.js (MIT), or a flat canvas front view where WebGL is missing.
// This file only draws what the core returns and reads input: every crack,
// fragment and force comes from the core.
import * as THREE from 'three';
import createGlassModule from './glass.mjs';
import { createGTScene } from './scene_gt.js';

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
  test: 'Test standards', everyday: 'Everyday', tool: 'Tools', weather: 'Weather', ballistic: 'Firearms' };

// ---------- Engine ----------
let G, cat;
try {
  G = await createGlassModule();
  const errs = G.load(await (await fetch('library.json')).text());
  if (errs.length) throw new Error(errs.join('; '));
  cat = G.catalog();
} catch (e) {
  $('loadMsg').textContent = 'Could not start the fracture engine in this browser: ' + e.message;
  throw e;
}

// ---------- Device tier ----------
function benchmark() {
  G.gls_bench(2);  // warm the JIT
  const t0 = performance.now();
  let n = 0;
  while (performance.now() - t0 < 70 && n < 400) { G.gls_bench(2); n += 2; }
  const ms = (performance.now() - t0) / Math.max(1, n);
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
let R = null;
try {
  if (!new URLSearchParams(location.search).has('flat')) {
    R = new THREE.WebGLRenderer({ canvas, antialias: tier >= 2, powerPreference: 'high-performance', alpha: false });
  }
} catch { R = null; }
const flat = !R;
// A software rasteriser (no GPU) costs the frame most of its time: go light.
let softwareGL = false;
if (R) {
  try {
    const gl = R.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    softwareGL = /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch { /* no renderer info */ }
}
if (softwareGL && tierChoice === 'auto') { bench.tier = Math.min(bench.tier, 1); tier = bench.tier; }
if (flat) { canvas.style.display = 'none'; canvas2d.style.display = 'block'; }
const ctx2d = flat ? canvas2d.getContext('2d') : null;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b111b);
scene.fog = new THREE.Fog(0x0b111b, 9, 26);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 60);

function pixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  return [0.75, 1, Math.min(dpr, 1.5), Math.min(dpr, 2), Math.min(dpr, 2)][tier];
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (R) { R.setPixelRatio(pixelRatio()); R.setSize(w, h, false); }
  else { const d = Math.min(window.devicePixelRatio || 1, 2); canvas2d.width = w * d; canvas2d.height = h * d; }
  camera.aspect = w / h;
  // On phones the bench sheet covers the lower part: centre the view above it.
  if (w <= 860 && !(GT && GT.active)) camera.setViewOffset(w, h, 0, h * 0.2, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  if (GT && GT.active) GT.frameCamera();
}

let glassMat, fragMat, frameMat;
const labObjects = [];  // the test hall: hidden when a scene takes over
let GT = null;          // the armoured-car scene (3D only)
let tierCap = null;     // a scene that must run in real time caps the automatic tier
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

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x272c33, roughness: 0.82, metalness: 0.05 });
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

  glassMat = tier >= 3
    ? new THREE.MeshPhysicalMaterial({ color: 0xeaf7f3, metalness: 0, roughness: 0.03, transmission: 1, thickness: 0.006, ior: 1.52,
      transparent: true, envMapIntensity: 1.3, side: THREE.DoubleSide, specularIntensity: 1, depthWrite: false })
    : new THREE.MeshStandardMaterial({ color: 0xd4ecef, metalness: 0.15, roughness: 0.04, transparent: true, opacity: 0.2,
      envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false });
  fragMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.5,
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
let gIdx = Math.max(0, cat.glazings.findIndex((g) => g.id === store.get('glazing', 'annealed_6')));
let iIdx = Math.max(0, cat.impactors.findIndex((g) => g.id === store.get('impactor', 'steel_ball_2260')));
let speed = cat.impactors[iIdx].speed;
let yaw = 0, pitch = 0, fromBack = false;
let aim = null;  // pane point {x, y}

// ---------- Pane state (rebuilt per pane) ----------
let P = null;  // { W, H, T, plies: [...], glass: count, seed, shots: [], ... }
const groupPane = new THREE.Group();
scene.add(groupPane);

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
const DICE_CAP = [2000, 6000, 16000, 32000, 60000];
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
    this.cap = DICE_CAP[clamp(tier, 0, 4)];
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
    const opts = { color: 0xd3ece4, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.85, envMapIntensity: 2.4 };
    this.mat = tier >= 3 ? new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 1, clearcoatRoughness: 0.05, ior: 1.52, specularIntensity: 1 })
      : new THREE.MeshStandardMaterial(opts);
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
        A.aT.setXYZW(i, sp[o + 9], tL, hop, 15 + 55 * h(9));
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
const CELL_CAP = [2500, 7000, 16000, 28000, 45000];
const PIECE_HEAD = `
uniform highp sampler2D uDice;
uniform highp sampler2D uPose;
uniform float uTime, uAhead, uW, uLift;
attribute float aDie;
varying float vEdge;
varying float vK;
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
      wPos = vec3(dieL.x + d2.w * sl, -uLift + d6.w + hy, dieL.z + d3.w * sl);
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
      const keep = expected > 0 ? Math.min(1, CELL_CAP[clamp(tier, 0, 4)] / expected) : 1;
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
      uW: { value: P.W }, uLift: { value: FLOOR } };
    const opts = { color: 0xeef8f4, metalness: 0.05, roughness: 0.06, transparent: true, opacity: 0.5, envMapIntensity: 2.0,
      side: THREE.DoubleSide };
    this.mat = tier >= 3 ? new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 1, clearcoatRoughness: 0.05, ior: 1.52 })
      : new THREE.MeshStandardMaterial(opts);
    this.mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + PIECE_HEAD)
        .replace('#include <beginnormal_vertex>', PIECE_BODY)
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(wp.x - 0.5 * uW, wp.y + uLift, -wp.z);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vEdge;\nvarying float vK;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= mix(vec3(vK), vec3(0.42, 0.78, 0.6), smoothstep(0.3, 0.9, vEdge));\n  diffuseColor.a *= mix(1.0, 1.35, vEdge);');
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
  pushPrism(pts, h, dieIndex, holes = []) {
    const loops = [pts, ...holes], all = [].concat(...loops);
    const n = all.length;
    const needV = this.nVerts + 6 * n, needI = this.nIdx + 6 * n + 6 * n;
    if (needV > this.die.length || needI > this.idx.length) {
      const cv = Math.max(2 * this.die.length, needV), ci = Math.max(2 * this.idx.length, needI);
      const pos = new Float32Array(3 * cv), nor = new Float32Array(3 * cv), die = new Float32Array(cv), idx = new Uint32Array(ci);
      pos.set(this.pos); nor.set(this.nor); die.set(this.die); idx.set(this.idx);
      Object.assign(this, { pos, nor, die, idx });
      this.attach();
      this.flushV = 0; this.flushI = 0;   // new buffers: upload them whole
    }
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
      D[o + 24] = cc[0]; D[o + 25] = cc[1]; D[o + 26] = 0; D[o + 27] = h;
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
    const g = 9.81, floorY = -FLOOR, tSpray = performance.now();
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
        const spin = 8 + 50 * hash01(d0, 34);
        const ax = hash01(d0, 35) - 0.5, ay = hash01(d0, 36) - 0.5, az = hash01(d0, 37) - 0.5 + 1e-3;
        for (const di of clump) {
          const od = ((di / DPR | 0) * DPR * 7 + (di % DPR) * 7) * 4, h = (k) => hash01(di, 40 + k);
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
      this.n++;
      if (kind === 1 && depth === 0 && this.lead < 2048) {
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

function newPane(seed = (Math.random() * 1e9) | 0, keepShots = false) {
  if (P) {
    for (const c of P.cracks) c.dispose();
    P.frags.dispose();
    if (P.dice) P.dice.dispose();
    if (P.crush) P.crush.dispose();
    for (const m of P.meshes) groupPane.remove(m);
    for (const m of P.impMeshes) if (m) groupPane.remove(m);
  }
  if (!G.gls_new_pane(gIdx, tierCap === null ? tier : Math.min(tier, tierCap), seed)) throw new Error('could not build the pane');
  G.gls_set_floor(-FLOOR);
  const s = G.state();
  const g = cat.glazings[gIdx];
  P = { W: s[14], H: s[15], T: s[13], nGlass: s[2], seed, cracks: [], frags: null, meshes: [], impMeshes: [], nImp: 0,
    shots: keepShots && P ? P.shots : [], shotDefs: [], pendingShots: [], fragShapes: 0, eventsShown: 0, broke: false, announced: new Set(),
    plies: [], monolithic: g.plies.every((p) => p.kind === 'glass'), simClock: 0, fieldTick: 0, glazing: g };
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
  aim = { x: P.W / 2, y: P.H / 2 };
  placeAimMarker();
  $('log').textContent = '';
  updatePaneInfo();
  frameCamera(false);
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
  const bar = (w, h, x, y) => {
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
    leg.userData.lab = true;
    groupPane.add(leg); P.meshes.push(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 0.6), frameMat);
    foot.position.set(sx * (W / 2 + fw / 2), 0.015, -T / 2);
    foot.userData.lab = true;
    groupPane.add(foot); P.meshes.push(foot);
  }
  // Stress view: the front sheet again, drawn with the fringe texture.
  const front = new THREE.BufferGeometry();
  front.setAttribute('position', geo.attributes.position);
  front.setAttribute('uv', geo.attributes.uv);
  front.setIndex(idx.slice(0, (FX - 1) * (FY - 1) * 6));
  stressMesh = new THREE.Mesh(front, new THREE.MeshBasicMaterial({ map: stressTex, transparent: true, opacity: 0.9, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }));
  stressMesh.visible = stressOn;
  stressMesh.renderOrder = 4;
  groupPane.add(stressMesh);
  P.meshes.push(stressMesh);
  aimMarker = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.016, 32), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.9, depthTest: false }));
  aimMarker.renderOrder = 6;
  aimMarker.userData.lab = true;
  groupPane.add(aimMarker);
  P.meshes.push(aimMarker);
}
function placeAimMarker() {
  if (!aimMarker || !aim) return;
  aimMarker.position.set(aim.x - P.W / 2, aim.y + FLOOR, fromBack ? -P.T - 0.002 : 0.002);
  const s = Math.max(0.6, Math.min(P.W, P.H) / 0.8);
  aimMarker.scale.set(s, s, s);
}

// ---------- Impactor meshes ----------
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
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffd36b, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
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
    }
  }
  P.nImp = n;
  P.lastShot = h;
  if (auto) { scaleNow = Math.min(scaleNow, approachScale(def, lead)); }
  playing = true;
  syncPlay();
  $('rWhat').textContent = `${def.name} · ${speed.toFixed(speed < 10 ? 2 : 1)} m/s`;
}
function approachScale(def, lead) {
  const tFlight = lead / Math.max(speed, 0.1);
  return clamp(tFlight / 0.9, 1e-5, 1);
}

function replay() {
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
function autoTarget(imps, plies) {
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
    out.textContent = r.outcome || (v[5] >= 0 ? 'In contact…' : 'On its way…');
    out.className = v[11] ? 'bad' : v[10] ? 'warn' : r.outcome ? 'ok' : '';
    kv.push(['Impact speed', `${v[0].toFixed(v[0] < 10 ? 2 : 1)} m/s (${(v[0] * 3.6).toFixed(0)} km/h)`]);
    kv.push(['Kinetic energy', v[2] < 10 ? `${v[2].toFixed(2)} J` : `${v[2].toFixed(0)} J`]);
    if (v[4] > 0) kv.push(['Peak force', v[4] >= 1e3 ? `${(v[4] / 1e3).toFixed(2)} kN` : `${v[4].toFixed(0)} N`]);
    if (v[6] > 0) kv.push(['Contact time', fmtTime(v[6])]);
    if (v[7] > 0) kv.push(['Peak stress at load', `${(v[7] / 1e6).toFixed(0)} MPa`]);
    if (r.outcome) kv.push(['Energy absorbed', `${Math.max(0, v[3]).toFixed(v[3] < 10 ? 2 : 0)} J`]);
    if (r.outcome && v[1] > 0) kv.push(['Leaves at', `${v[1].toFixed(1)} m/s`]);
    if (v[8] > 0) kv.push(['Depth reached', `${(v[8] * 1e3).toFixed(1)} mm of ${(P.T * 1e3).toFixed(1)}`]);
    if (v[9] > 0.0005) kv.push(['Bulge', `${(v[9] * 1e3).toFixed(0)} mm`]);
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
    if (tp.drawn > tp.dice * 1.05) pv.push(['Dice drawn', `${(tp.drawn * 1e3).toFixed(0)} mm (${TIER_NAMES[tier]} tier)`]);
    pv.push(['ECE R43 window', real >= 40 && real <= 400 ? 'within 40–400 ✓' : 'outside 40–400']);
  }
  pv.push(['Plate', `${s[16].toFixed(1)} Hz fundamental · ${s[18]}×${s[19]} modes to ${(s[17] / 1e3).toFixed(1)} kHz`]);
  pv.push(['Quality', `${TIER_NAMES[tier]} · ${(s[20] * 1e3).toFixed(1)} mm crack grid`]);
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
  if (GT && GT.active) return;
  for (let k = 0; k < P.nImp; ++k) {
    if (P.announced.has(k)) continue;
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
if (R) GT = createGTScene({ THREE, scene, groupPane, camera, cam, applyCamera, FLOOR, tier, labObjects, leave: () => leaveScene(true), layout: resize });
let camMode = 0;
function frameCamera(keepAngles = true) {
  if (GT && GT.active) { GT.frameCamera(); return; }
  const m = Math.max(P.W, P.H);
  cam.tx = 0; cam.ty = FLOOR + P.H / 2; cam.tz = -P.T / 2;
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
  surface.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, theta: cam.theta, phi: cam.phi };
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); drag = null; }
});
surface.addEventListener('pointermove', (e) => {
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
  pointers.delete(e.pointerId);
  if (drag && drag.moved <= 6 && performance.now() - drag.t < 450 && P) {
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
  if (k === ' ') { e.preventDefault(); fire(); }
  else if (k === 'p') { playing = !playing; syncPlay(); }
  else if (k === 'z') replay();
  else if (k === 'r') $('bReset').click();
  else if (k === 'c') { if (GT && GT.active) GT.nextView(); else { camMode = (camMode + 1) % 3; frameCamera(false); } }
  else if (k === 's') $('bStress').click();
  else if (k === 'a') $('bAuto').click();
  else if (k === 'h' || k === '?') $('help').classList.toggle('on');
  else if (k === 'escape') $('help').classList.remove('on');
  else if (k >= '1' && k <= '6') { auto = false; scaleManual = SCALES[+k - 1][0]; buildScaleButtons(); syncAuto(); }
});

// ---------- UI ----------
function speedToSlider(v, d) { return Math.round(1000 * Math.log(v / d.minSpeed) / Math.log(d.maxSpeed / d.minSpeed)); }
function sliderToSpeed(s, d) { return d.minSpeed * Math.pow(d.maxSpeed / d.minSpeed, s / 1000); }
function syncSpeed() {
  const d = cat.impactors[iIdx];
  $('speed').value = String(speedToSlider(speed, d));
  const drop = speed * speed / (2 * 9.80665);
  $('vSpeed').textContent = `${speed.toFixed(speed < 10 ? 2 : speed < 100 ? 1 : 0)} m/s · ${(speed * 3.6).toFixed(0)} km/h` +
    (drop < 30 && d.kind !== 'projectile' ? ` · ${drop.toFixed(drop < 1 ? 2 : 1)} m drop` : '') + (speed > 50 ? ` · ${(speed / 0.5144).toFixed(0)} kt` : '');
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
  if (GT && GT.active) leaveScene(false);
  gIdx = i;
  store.set('glazing', cat.glazings[i].id);
  chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
  newPane();
  simClockReset();
  updatePaneInfo();
}
function pickImpactor(i, keepSpeed = false) {
  iIdx = i;
  store.set('impactor', cat.impactors[i].id);
  if (!keepSpeed) speed = cat.impactors[i].speed;
  chipGroup($('impactors'), cat.impactors, iIdx, (k) => pickImpactor(k));
  $('iDesc').textContent = cat.impactors[i].description;
  syncSpeed();
}
const PRESETS = [
  ['Ball through a window', 'annealed_6', 'steel_ball_2260', 8.86, 'A 2.26 kg steel ball dropped 4 m onto 6 mm plate glass'],
  ['Baseball through a house window', 'annealed_4', 'baseball', 40, '90 mph fastball, thin annealed glass'],
  ['Escape tool on a car door', 'car_side_tempered', 'window_punch', 5.5, 'Spring punch: tempered glass crumbles from a 0.3 J tap'],
  ['ECE R43 windscreen ball test', 'windscreen', 'steel_ball_2260', 8.86, 'The PVB must catch a 2.26 kg ball from 4 m'],
  ['Pedestrian head on a windscreen', 'windscreen', 'headform', 11.1, 'Euro NCAP adult headform at 40 km/h', { y: 0.32 }],
  ['Occupant head from inside', 'windscreen', 'headform', 7, 'Unbelted head strike, 25 km/h, from the cabin', { back: true, y: 0.55 }],
  ['Stone chip at highway speed', 'windscreen', 'stone', 30, 'A granite chip stars the outer ply only'],
  ['Bird strike at 250 kt', 'aircraft_windshield', 'bird_4lb', 128.6, '14 CFR 25.775: 4 lb bird, pressurised cabin'],
  ['Hail on a window', 'annealed_4', 'hail_50', 33, '50 mm hailstone at terminal velocity'],
  ['Hurricane debris', 'hurricane', 'timber_2x4', 15.2, 'ASTM E1996 missile D: 2x4 stud at 15 m/s'],
  ['Falling into a shower door', 'tempered_6', 'body_bag', 4.89, 'ANSI Z97.1 bag from 48 in: tempered glass'],
  ['Falling into an old door', 'annealed_6', 'body_bag', 4.89, 'The same fall into annealed glass'],
  ['9 mm vs Level 1', 'ul752_l1', 'pistol_9mm', 380, 'UL 752 Level 1 class all-glass laminate'],
  ['.44 Magnum vs Level 3', 'ul752_l3', 'magnum_44', 430, 'Glass-clad polycarbonate catches it'],
  ['Rifle vs Level 3', 'ul752_l3', 'rifle_762', 850, 'A handgun rating does not stop 7.62 mm'],
  ['Rifle vs Level 8', 'ul752_l8', 'rifle_762', 850, 'Rifle-rated: stopped deep in the layup'],
  ['BB gun vs plate glass', 'annealed_6', 'bb', 120, 'Hertzian cone: the classic conical hole'],
  ['Buckshot through a window', 'annealed_6', 'buckshot_00', 395, 'A 12-gauge 00 buck shell from 7 m: nine pellets, one after another'],
  ['Buckshot vs car door glass', 'car_side_tempered', 'buckshot_00', 395, 'Nine pellets into tempered side glass'],
  ['Brick vs tempered', 'tempered_6', 'brick', 10, 'Tempered glass is four to five times stronger'],
];
// ---------- The armoured car ----------
function startScene() {
  if (!GT) { toast('The armoured-car scene needs WebGL; this device is drawing in 2D'); return; }
  const gi = cat.glazings.findIndex((g) => g.id === 'armoured_windscreen'), ii = cat.impactors.findIndex((g) => g.id === 'smg_9mm');
  if (gi < 0 || ii < 0) return;
  gIdx = gi;
  chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
  pickImpactor(ii);
  speed = cat.impactors[ii].speed;
  yaw = 0; pitch = 0; fromBack = false;
  $('bSide').setAttribute('aria-pressed', 'false');
  syncSpeed();
  // ~190 rounds in ten seconds: keep the automatic tier where that runs in real time.
  tierCap = tierChoice === 'auto' ? 2 : null;
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
function leaveScene(rebuild) {
  if (!GT || !GT.active) return;
  GT.leave();
  tierCap = null;
  if (window.innerWidth > 860) $('lab').hidden = false;
  auto = store.get('auto', true); syncAuto(); buildScaleButtons();
  if (rebuild) { newPane(); simClockReset(); updatePaneInfo(); }
  frameCamera(false);
}

function buildPresets() {
  const box = $('presets');
  {
    const b = document.createElement('button');
    b.className = 'feature';
    b.innerHTML = 'Armoured GT under fire<small>Sit in a 1960s grand tourer with armoured glass while five gunmen empty submachine guns into it</small>';
    b.onclick = startScene;
    box.appendChild(b);
  }
  for (const [name, gid, iid, v, sub, opt = {}] of PRESETS) {
    const gi = cat.glazings.findIndex((g) => g.id === gid), ii = cat.impactors.findIndex((g) => g.id === iid);
    if (gi < 0 || ii < 0) continue;
    const b = document.createElement('button');
    b.innerHTML = `${name}<small>${sub}</small>`;
    b.onclick = () => {
      if (GT && GT.active) leaveScene(false);
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
    toast(`${TIER_NAMES[tier]} quality: the same physics at ${['coarse', 'low', 'medium', 'fine', 'finest'][tier]} resolution`);
  };
}
$('speed').oninput = () => { speed = sliderToSpeed(+$('speed').value, cat.impactors[iIdx]); syncSpeed(); };
for (const id of ['yaw', 'pitch']) $(id).oninput = () => { yaw = +$('yaw').value; pitch = +$('pitch').value; $('vAngle').textContent = `${yaw}° / ${pitch}°`; };
$('bSide').onclick = () => { fromBack = !fromBack; $('bSide').setAttribute('aria-pressed', String(fromBack)); placeAimMarker(); };
$('bCentre').onclick = () => { aim = { x: P.W / 2, y: P.H / 2 }; placeAimMarker(); };
$('fire').onclick = () => fire();
$('bPlay').onclick = () => { playing = !playing; syncPlay(); };
$('bReplay').onclick = replay;
$('bAuto').onclick = () => { auto = !auto; store.set('auto', auto); syncAuto(); buildScaleButtons(); };
$('bReset').onclick = () => { if (GT && GT.active) startScene(); else { newPane(); simClockReset(); } };
$('bCam').onclick = () => { if (GT && GT.active) GT.nextView(); else { camMode = (camMode + 1) % 3; frameCamera(false); } };
$('bStress').onclick = () => {
  stressOn = !stressOn;
  $('bStress').setAttribute('aria-pressed', String(stressOn));
  if (stressMesh) stressMesh.visible = stressOn;
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
let last = performance.now(), uiTick = 0, slowFrames = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!P) return;
  let s = G.state();
  const plies0 = G.plies(P.nGlass);
  // Bullet time eases down fast and back up gently (in log space).
  let target = auto ? autoTarget(G.impactors(P.nImp), plies0) : scaleManual;
  if (auto) {
    const lg = Math.log10(scaleNow), lt = Math.log10(target);
    scaleNow = Math.pow(10, lt < lg ? Math.max(lt, lg - dt * 6) : Math.min(lt, lg + dt * 0.9));
  } else scaleNow = target;
  // Replayed shots fire at the engine time they were first fired.
  while (P.pendingShots.length && P.pendingShots[0].t <= G.gls_time() + 1e-12) {
    const sh = P.pendingShots.shift();
    iIdx = sh.iIdx; speed = sh.speed; yaw = sh.yaw; pitch = sh.pitch; fromBack = sh.fromBack;
    fire({ x: sh.x, y: sh.y }, false);
  }
  if (playing) {
    P.simClock = Math.max(P.simClock, G.gls_time()) + dt * scaleNow;
    if (P.pendingShots.length) P.simClock = Math.min(P.simClock, P.pendingShots[0].t);
    // Physics gets a share of the frame: more per frame when frames are slow.
    const budgetMs = clamp(0.45 * dt * 1000, tier <= 1 ? 8 : 11, 80);
    const maxSteps = Math.max(20, Math.floor(budgetMs / Math.max(msPerStep, 1e-4)));
    const t0 = performance.now();
    const steps = G.gls_advance(P.simClock, maxSteps);
    const el = performance.now() - t0;
    if (steps > 0) msPerStep = 0.85 * msPerStep + 0.15 * (el / steps);
    limited = steps >= maxSteps && G.gls_time() < P.simClock - 1e-12;
    if (limited) P.simClock = G.gls_time();
    s = G.state();
  }
  const tEng = G.gls_time();
  // New cracks.
  const pl = G.plies(P.nGlass);
  for (let k = 0; k < P.nGlass; ++k) {
    const n = pl[12 * k + 2], cv = P.cracks[k];
    if (n > cv.count) cv.add(G.cracks(k, cv.count).slice());
    if (R) {
      cv.mat.uniforms.uTime.value = tEng;
      cv.mat.uniforms.uGlow.value = 1 / Math.max(1e-7, 0.25 * scaleNow);
      cv.mat.uniforms.uExag.value = exaggeration;
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
    P.frags.add(G.fragmentShapes(P.fragShapes)); P.fragShapes = nFrag;
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
  if (P.frags.tick) P.frags.tick(tier >= 3 ? 6 : 4);   // cut whole tempered pieces into their dice, a few per frame
  let poses = null;
  if (nFrag > 0) {
    poses = G.fragmentPoses(nFrag).slice();
    P.frags.update(poses, Math.max(0, tEng - s[23]), tEng);  // pieces step every 0.5 ms; extrapolate between
  }
  if (s[26] > P.crush.count) P.crush.add(G.crushes(P.crush.count).slice());
  const sprayView = P.dice || P.frags;
  if (s[24] > sprayView.sprays) {
    // The first dice to come loose: bring the floor into the shot.
    if (!sprayView.sprays && !pointers.size && !(GT && GT.active)) P.glide = { ty: (FLOOR + P.H) / 2, r: cam.r * 1.2 };
    sprayView.addSprays(G.sprays(sprayView.sprays).slice(), poses);
  }
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
  // The intact sheet goes once a monolithic pane is in pieces.
  if (slab) {
    const gone = P.monolithic && pl[4] > 0;
    slab.visible = !gone;
    if (P.edges) P.edges.visible = !gone;
    if (stressMesh) stressMesh.visible = stressOn && !gone;
  }
  // Deflection and stress, a few times a second (every frame while it moves fast).
  const dynamic = s[1] === 0;
  if (dynamic || stressOn) {
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
      if (m.userData.glow) {
        const d = camera.position.distanceTo(m.position);
        m.userData.glow.scale.setScalar(0.012 * d);
        m.userData.glow.visible = imps[o + 9] !== PH.DONE;
      }
    }
  }
  if (GT) GT.update(tEng, scaleNow, s);
  // Readouts.
  if ((uiTick += dt) > 0.12) {
    uiTick = 0;
    updateReadouts();
    announce();
    $('clock').innerHTML = `${fmtTime(tEng)}<small>${fmtScale(scaleNow)}${auto ? ' · auto' : ''}</small>`;
    $('limit').textContent = limited ? 'device-limited' : '';
  }
  // Adaptive resolution if the GPU struggles.
  if (R) {
    slowFrames = dt > 0.045 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
    if (slowFrames > 90 && R.getPixelRatio() > 0.6) { R.setPixelRatio(R.getPixelRatio() * 0.8); slowFrames = 0; }
    R.render(scene, camera);
  } else {
    draw2d(tEng, poses);
  }
}

// Hook for automated browser tests.
window.__glass = { get P() { return P; }, THREE, scene, camera, G, get GT() { return GT; }, groupPane, cam, applyCamera };

// ---------- Boot ----------
resize();
window.addEventListener('resize', resize);
chipGroup($('glazings'), cat.glazings, gIdx, pickGlazing);
pickImpactor(iIdx);
buildPresets();
buildScaleButtons();
syncAuto();
syncPlay();
newPane();
simClockReset();
if (window.innerWidth <= 860) showTab('lab');
$('loading').remove();
if (!store.get('seenHelp', false)) { toast('Tap the glass to fire · drag to orbit · ? for how it works', 4500); store.set('seenHelp', true); }
if (flat) toast('No WebGL here: drawing the front view in 2D. The physics is the same.', 4000);
if (new URLSearchParams(location.search).get('scene') === 'gt') startScene();
requestAnimationFrame(frame);
