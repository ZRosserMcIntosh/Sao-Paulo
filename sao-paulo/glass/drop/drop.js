// São Paulo World · Glass Lab · Prince Rupert's drop.
// Physics: the Glass Dynamics fracture core (C++, MIT) compiled to WebAssembly.
// The drop's shape, the stress frozen into it, what a strike does to its skin
// and every fragment of the burst (with the time the front reaches it) come
// from the core; this file only draws them and flies the fragments it was
// given, ballistically, to the bench.
import * as THREE from 'three';
import createGlassModule from '../glass.mjs';
import { GlassAudio } from '../glass_audio.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const LENGTH = 75;        // mm, head front to tail tip
const TIP = 0.35;         // mm
const CORE_SHARE = 0.2;   // core tension / skin compression (the skin then holds about a sixth of the radius)
const BENCH = -0.05;      // m, the bench below the drop's axis
const CLAMP = 0.012;      // m of the tail held in the padded clamp
const SCALES = [[1, '1×'], [1e-3, '1/1k'], [1e-4, '1/10k'], [1e-5, '1/100k'], [1e-6, '1/1M']];
const GUNS = ['lead_22', 'lead_38', 'pistol_9mm', 'magnum_44', 'rifle_762', 'bmg_50'];
const BREWSTER = 2.7e-12; // 1/Pa, stress-optic coefficient of soda-lime glass
const LAMBDA = 550e-9;

// ---------- Engine ----------
let G, cat;
try {
  G = await createGlassModule(await (await fetch('../glass.wasm', { cache: 'no-cache' })).arrayBuffer());
  const errs = G.load(await (await fetch('../library.json', { cache: 'no-cache' })).text());
  if (errs.length) throw new Error(errs.join('; '));
  cat = G.catalog();
} catch (e) {
  $('loadMsg').textContent = 'Could not start the fracture engine in this browser: ' + e.message;
  throw e;
}
const impIndex = (id) => cat.impactors.findIndex((d) => d.id === id);

// ---------- Renderer ----------
const canvas = $('view');
let R = null;
try { R = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); } catch { R = null; }
if (!R) { $('loadMsg').textContent = 'This page needs WebGL.'; throw new Error('no WebGL'); }
R.outputColorSpace = THREE.SRGBColorSpace;
R.toneMapping = THREE.ACESFilmicToneMapping;
R.toneMappingExposure = 1.1;
R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.002, 20);
const BG = new THREE.Color(0x05070b);
scene.background = BG;
{
  // A studio for reflections: a dark dome with soft boxes, as in the lab.
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'varying vec3 vp; void main(){ float h = normalize(vp).y; gl_FragColor = vec4(mix(vec3(0.02,0.025,0.035), vec3(0.3,0.34,0.4), smoothstep(-0.2,0.9,h)),1.); }',
  })));
  for (const [x, y, z, w, h, k] of [[-4, 4, 3, 4, 2.5, 7], [5, 2.5, -2, 2, 4, 5], [0, 6, -4, 6, 1, 3], [0, 0.5, 5, 3, 1.5, 2]]) {
    const box = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide }));
    box.position.set(x, y, z); box.lookAt(0, 0, 0); env.add(box);
  }
  const pm = new THREE.PMREMGenerator(R);
  scene.environment = pm.fromScene(env, 0.03).texture;
  pm.dispose();
}
const key = new THREE.SpotLight(0xffffff, 6, 3, 0.5, 0.6, 1.2);
key.position.set(-0.25, 0.35, 0.3);
key.target.position.set(0.03, 0, 0);
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0x9fd6ff, 1.4);
rim.position.set(0.3, 0.2, -0.4);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0x8090a8, 0x101010, 0.35));
// The bench, the clamp's post and its padded jaws.
const benchMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.6, metalness: 0.2 });
const bench = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.3), benchMat);
bench.position.set(0.04, BENCH - 0.01, 0);
scene.add(bench);
const steel = new THREE.MeshStandardMaterial({ color: 0x8b939e, metalness: 0.85, roughness: 0.35 });
const rubber = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.9 });
const clampGroup = new THREE.Group();
scene.add(clampGroup);
// A dark backdrop that glows a little behind the drop.
{
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), gr = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  gr.addColorStop(0, '#1d2633'); gr.addColorStop(1, '#05070b');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), new THREE.MeshBasicMaterial({ map: t }));
  back.position.set(0.04, 0.05, -0.35);
  back.userData.backdrop = true;
  scene.add(back);
  var backdrop = back;   // eslint-disable-line no-var
}

// ---------- The drop ----------
const D = { head: 5, comp: 500, seed: 1, L: LENGTH / 1e3, mesh: null, tip: null, ring: null, frags: null, lead: null,
  fr: null, nFrags: 0, lo: 1, hi: 0, snipX: LENGTH / 1e3, startedAt: -1, event: null, last: null, outcome: '', shots: 0 };
const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xf2fbff, metalness: 0, roughness: 0.02, transmission: 1, thickness: 0.008,
  ior: 1.52, envMapIntensity: 1.6, specularIntensity: 1, transparent: true, side: THREE.DoubleSide });
// Crossed polarisers: retardation N(u) along each line of sight, as three wavelengths.
const polMat = new THREE.ShaderMaterial({
  uniforms: { uTab: { value: new Float32Array(64) }, uK: { value: 1 } },
  vertexShader: `attribute float rad; varying float vR; varying vec3 vN; varying vec3 vV;
    void main(){ vR = rad; vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float uTab[64]; uniform float uK; varying float vR; varying vec3 vN; varying vec3 vV;
    void main(){
      float c = abs(dot(normalize(vN), normalize(vV)));
      float u = sqrt(max(0., 1. - c * c)) * 63.;
      int i = int(floor(u)); float f = fract(u);
      float t = mix(uTab[i], uTab[min(i + 1, 63)], f);
      float N = uK * vR * t;
      vec3 I = vec3(pow(sin(3.14159 * N * 0.846), 2.), pow(sin(3.14159 * N), 2.), pow(sin(3.14159 * N * 1.222), 2.));
      gl_FragColor = vec4(pow(I, vec3(0.8)) * 1.1, 1.);
    }`,
  side: THREE.FrontSide,
});
let polarised = false;

function profileTable() {
  // f(u) = integral of the axial stress along the chord at u = b / r, in Pa x radius.
  const tab = new Float32Array(64);
  for (let i = 0; i < 64; ++i) {
    const u = i / 63, h = Math.sqrt(Math.max(0, 1 - u * u));
    let s = 0;
    const n = 48;
    for (let k = 0; k < n; ++k) {
      const t = -h + (2 * h) * (k + 0.5) / n;
      s += G.gls_drop_residual(Math.min(1, Math.sqrt(u * u + t * t))) * (2 * h) / n;
    }
    tab[i] = Math.abs(s);
  }
  polMat.uniforms.uTab.value = tab;
  polMat.uniforms.uK.value = BREWSTER / LAMBDA;
}

// A body of revolution about x from x0 to x1, its ends closed.
function lathe(x0, x1) {
  const segs = 44, pos = [], rad = [], idx = [];
  const n = Math.max(8, Math.ceil((x1 - x0) / 0.0003));
  const xs = [];
  for (let i = 0; i <= n; ++i) {
    const t = i / n;
    // Denser round the head, where the radius changes fastest.
    xs.push(x0 + (x1 - x0) * (x0 < 0.012 ? Math.pow(t, 1.6) : t));
  }
  for (const x of xs) {
    const r = Math.max(1e-6, G.gls_drop_radius(Math.min(D.L - 1e-6, Math.max(1e-6, x))));
    for (let j = 0; j <= segs; ++j) {
      const a = (j / segs) * Math.PI * 2;
      pos.push(x, r * Math.cos(a), r * Math.sin(a)); rad.push(r);
    }
  }
  for (let i = 0; i < xs.length - 1; ++i)
    for (let j = 0; j < segs; ++j) {
      const a = i * (segs + 1) + j, b = a + segs + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  // Caps.
  for (const [ring, x, flip] of [[0, xs[0], true], [xs.length - 1, xs[xs.length - 1], false]]) {
    const c = pos.length / 3, r = G.gls_drop_radius(Math.min(D.L - 1e-6, Math.max(1e-6, x)));
    pos.push(x, 0, 0); rad.push(r);
    for (let j = 0; j < segs; ++j) {
      const a = ring * (segs + 1) + j;
      if (flip) idx.push(c, a + 1, a); else idx.push(c, a, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('rad', new THREE.Float32BufferAttribute(rad, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildIntact() {
  if (D.mesh) { scene.remove(D.mesh); D.mesh.traverse((o) => o.geometry && o.geometry.dispose()); }
  const grp = new THREE.Group();
  const mat = polarised ? polMat : glassMat;
  // Whole until the front gets there: the head ahead of a front running up
  // from the tail, the tail behind one running down from the head.
  const pieces = [];
  if (D.startedAt < 0) pieces.push([0, D.snipX]);
  else {
    if (D.lo > 1e-4) pieces.push([0, D.lo]);
    if (D.hi < D.snipX - 1e-4) pieces.push([D.hi, D.snipX]);
  }
  if (D.snipX < D.L - 1e-4) pieces.push([D.snipX, D.L]);   // the snapped-off tip stays in the clamp
  for (const [a, b] of pieces) grp.add(new THREE.Mesh(lathe(a, b), mat));
  D.mesh = grp;
  scene.add(grp);
}

function buildClamp() {
  clampGroup.clear();
  const x0 = D.L - CLAMP;
  for (const s of [1, -1]) {
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(CLAMP + 0.004, 0.004, 0.012), rubber);
    jaw.position.set(x0 + CLAMP / 2, s * 0.0024, 0);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(CLAMP + 0.008, 0.003, 0.016), steel);
    plate.position.set(x0 + CLAMP / 2, s * 0.0058, 0);
    clampGroup.add(jaw, plate);
  }
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, -BENCH + 0.006, 16), steel);
  post.position.set(x0 + CLAMP / 2, (BENCH - 0.006) / 2, 0);
  clampGroup.add(post);
}

// ---------- Fragments ----------
const fragGeo = new THREE.TetrahedronGeometry(1);
const fragMat = new THREE.MeshStandardMaterial({ color: 0xeef6ff, roughness: 0.25, metalness: 0.05, transparent: true, opacity: 0.85, envMapIntensity: 1.8 });
const leadMat = new THREE.MeshStandardMaterial({ color: 0x7a7d82, roughness: 0.35, metalness: 0.9 });
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _ax = new THREE.Vector3();
function fragmentsFromEngine() {
  const n = G.dropState()[6];
  if (n <= D.nFrags) return;
  const rows = G.dropFragments(D.nFrags);
  D.fr = D.fr ? concat(D.fr, rows) : rows;
  D.nFrags = n;
  for (const m of [D.frags, D.lead]) if (m) { scene.remove(m); m.dispose(); }
  let glass = 0, lead = 0;
  for (let i = 0; i < n; ++i) (D.fr[9 * i + 8] ? ++lead : ++glass);
  D.frags = glass ? new THREE.InstancedMesh(fragGeo, fragMat, glass) : null;
  D.lead = lead ? new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), leadMat, lead) : null;
  D.map = new Int32Array(n);
  let gi = 0, li = 0;
  for (let i = 0; i < n; ++i) D.map[i] = D.fr[9 * i + 8] ? -1 - li++ : gi++;
  for (const m of [D.frags, D.lead]) if (m) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
  // Spin axes and rates, and when each one lands on the bench.
  D.spin = new Float32Array(4 * n);
  D.land = new Float32Array(n);
  for (let i = 0; i < n; ++i) {
    const o = 9 * i, h = hash(i);
    _ax.set(h[0] - 0.5, h[1] - 0.5, h[2] - 0.5).normalize();
    const v = Math.hypot(D.fr[o + 4], D.fr[o + 5], D.fr[o + 6]);
    D.spin.set([_ax.x, _ax.y, _ax.z, (0.3 + h[3]) * v / Math.max(D.fr[o + 7], 1e-4)], 4 * i);
    const y0 = D.fr[o + 2] - (BENCH + 0.5 * D.fr[o + 7]), vy = D.fr[o + 5];
    D.land[i] = (vy + Math.sqrt(vy * vy + 2 * 9.81 * Math.max(0, y0))) / 9.81;
  }
}
function concat(a, b) { const c = new Float32Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }
function hash(i) {
  let x = (i * 2654435761) >>> 0;
  const out = [];
  for (let k = 0; k < 4; ++k) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out.push(((x >>> 0) % 10000) / 10000); }
  return out;
}
function drawFragments(T) {
  if (!D.fr) return;
  const n = D.nFrags;
  for (let i = 0; i < n; ++i) {
    const o = 9 * i, tau = T - D.fr[o];
    const k = D.map[i], mesh = k >= 0 ? D.frags : D.lead, idx = k >= 0 ? k : -1 - k;
    if (tau < 0) { _m.makeScale(0, 0, 0); mesh.setMatrixAt(idx, _m); continue; }
    const tf = Math.min(tau, D.land[i]);
    _p.set(D.fr[o + 1] + D.fr[o + 4] * tf, D.fr[o + 2] + D.fr[o + 5] * tf - 4.905 * tf * tf, D.fr[o + 3] + D.fr[o + 6] * tf);
    _ax.set(D.spin[4 * i], D.spin[4 * i + 1], D.spin[4 * i + 2]);
    _q.setFromAxisAngle(_ax, D.spin[4 * i + 3] * tf);
    const sz = 0.5 * D.fr[o + 7];
    _s.set(sz, sz * (k >= 0 ? 0.6 : 0.3), sz);   // lead goes as flakes
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(idx, _m);
  }
  for (const m of [D.frags, D.lead]) if (m) m.instanceMatrix.needsUpdate = true;
}

// The front: a bright ring where the cracks are running.
const ringMat = new THREE.MeshBasicMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
D.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 8, 40), ringMat);
D.ring.rotation.y = Math.PI / 2;
D.ring.visible = false;
scene.add(D.ring);
// And a glow round it: fractured glass scatters the light, white.
const flash = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(235,245,255,1)'); gr.addColorStop(0.25, 'rgba(180,215,255,.55)'); gr.addColorStop(1, 'rgba(120,170,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  sp.visible = false;
  scene.add(sp);
  return sp;
})();

// ---------- Projectiles and tools ----------
let proj = null;
function projectileMesh(def) {
  const g = new THREE.Group();
  if (def.kind === 'projectile') {
    const r = def.radius, L = def.length || 3 * r;
    const lead = /lead/.test(def.id);
    const mat = new THREE.MeshStandardMaterial({ color: lead ? 0x8a8d92 : 0xc07a3a, metalness: 0.9, roughness: lead ? 0.45 : 0.25 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.6 * L, 24), mat);
    body.rotation.z = Math.PI / 2; body.position.x = -0.3 * L - 0.4 * L;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(r, 0.4 * L, 24), mat);
    nose.rotation.z = -Math.PI / 2; nose.position.x = -0.2 * L;
    g.add(body, nose);
  } else {
    // A hammer: its steel head, face toward the drop, and a wooden handle.
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), steel);
    head.position.x = -0.015;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.25, 12), new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.7 }));
    handle.position.set(-0.015, -0.13, 0);
    g.add(head, handle);
  }
  scene.add(g);
  return g;
}
let pliers = null;
// Small side cutters: steel jaws either side of the tail, their red handles
// running away behind it.
function pliersMesh() {
  const g = new THREE.Group(), mat = new THREE.MeshStandardMaterial({ color: 0xb33a2e, roughness: 0.5, metalness: 0.4 });
  for (const s of [1, -1]) {
    const jaw = new THREE.Group();
    const tipM = new THREE.Mesh(new THREE.BoxGeometry(0.0025, 0.003, 0.012), steel);
    tipM.position.z = -0.004;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.06), mat);
    grip.position.set(0, s * 0.004, -0.042);
    jaw.add(tipM, grip);
    jaw.userData.s = s;
    g.add(jaw);
  }
  scene.add(g);
  return g;
}

// ---------- Time ----------
let T = 0, playing = true, auto = true, scaleNow = 1, scaleManual = 1, last = performance.now();
function easeScale(target, dt) {
  if (!auto) { scaleNow = scaleManual; return; }
  // Down at once (a front crosses the drop in tens of microseconds), back up gently.
  const lg = Math.log10(scaleNow), lt = Math.log10(target);
  scaleNow = Math.pow(10, lt < lg ? lt : Math.min(lt, lg + dt * 0.8));
}
function autoTarget() {
  const s = G.dropState(), ev = D.event;
  if (ev && !ev.done) {
    const ttc = ev.at - T;
    return clamp(ttc / 0.6, 1e-5, ev.kind === 'snip' ? 0.02 : 1);
  }
  const t0 = s[3] ? s[15] : D.hitAt ?? -1;
  if (t0 < 0) return 1;
  const since = T - t0, front = s[3] ? s[4] / s[5] : 0;
  if (since < front + 4e-6) return 1e-5;
  if (since < front + 150e-6) return 1e-4;
  if (since < 0.015) return 2e-3;
  if (since < 0.3) return 0.05;
  return 0.25;
}

// ---------- Actions ----------
let gun = impIndex('lead_38'), speed = cat.impactors[gun]?.speed || 230;
const sound = new GlassAudio();
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => sound.start(), { capture: true });

function newDrop(seed = (Math.random() * 1e9) | 0) {
  D.seed = seed;
  G.gls_drop_new(D.head, LENGTH, TIP, D.comp, D.comp * CORE_SHARE, seed);
  T = 0; G.gls_drop_advance(0);
  D.lo = 1; D.hi = 0; D.snipX = D.L; D.startedAt = -1; D.event = null; D.hitAt = undefined; D.burstHeard = false;
  D.nFrags = 0; D.fr = null;
  for (const m of [D.frags, D.lead]) if (m) { scene.remove(m); m.dispose(); }
  D.frags = D.lead = null;
  if (proj) { scene.remove(proj); proj = null; }
  if (pliers) { scene.remove(pliers); pliers = null; }
  profileTable();
  buildIntact();
  buildClamp();
  $('outcome').textContent = 'Fire at the head, or snap the tail.';
  $('outcome').className = '';
  $('kv').innerHTML = '';
  dropReadout();
  scaleNow = 1;
}
function act(a) {
  if (G.dropState()[3] || (D.event && !D.event.done) || D.hitAt !== undefined) newDrop(D.seed);
  D.last = a;
  sound.start();
  if (a.kind === 'snip') {
    D.event = { kind: 'snip', x: a.x, at: T + 0.0015, done: false };
    pliers = pliersMesh();
    pliers.position.set(a.x, 0, 0);
    sound.play('knock', { gain: 0.3, rate: 1.6 });
  } else {
    const def = cat.impactors[a.idx];
    const v = a.speed;
    const dist = def.kind === 'projectile' ? 0.3 : 0.08;
    D.event = { kind: 'strike', idx: a.idx, speed: v, at: T + dist / v, done: false, rigid: def.kind !== 'projectile', def };
    proj = projectileMesh(def);
    if (def.kind === 'projectile') sound.play('boom', { gain: 0.6, rate: 1.5, important: true });
  }
  if (window.innerWidth <= 860) showTab('res');
}
function fire() { act({ kind: 'strike', idx: gun, speed }); }

// Per frame: the event in flight, the drop's broken stretch, readouts.
function step(dt) {
  if (playing) {
    easeScale(autoTarget(), dt);
    let next = T + dt * scaleNow;
    const ev = D.event;
    if (ev && !ev.done && next >= ev.at) {
      next = ev.at;
      G.gls_drop_advance(next);
      T = next;
      if (ev.kind === 'snip') {
        G.gls_drop_snip(ev.x);
        sound.play('snap', { gain: 0.9, important: true });
      } else {
        const broke = G.gls_drop_strike(ev.idx, ev.speed);
        D.hitAt = T;
        ev.broke = !!broke;
        sound.play(ev.rigid ? 'knock' : 'chip', { gain: 0.9, rate: ev.rigid ? 1.2 : 0.7, important: true });
      }
      ev.done = true;
      D.outcome = G.text();
      fragmentsFromEngine();
      showOutcome();
    } else {
      T = next;
      G.gls_drop_advance(T);
    }
  }
  const s = G.dropState();
  const lo = s[3] ? s[1] : 1, hi = s[3] ? s[2] : 0;
  D.snipX = s[4]; D.startedAt = s[15];
  if (Math.abs(lo - D.lo) > 2e-5 || Math.abs(hi - D.hi) > 2e-5 || (s[3] && !D.mesh.userData.broken)) {
    D.lo = lo; D.hi = hi;
    buildIntact();
    D.mesh.userData.broken = !!s[3];
  }
  // The front.
  const running = s[3] && (lo > 1e-4 || hi < D.snipX - 1e-4) && (T - s[15]) < (D.snipX / s[5]) + 1e-6;
  D.ring.visible = !!running;
  flash.visible = !!running;
  if (running) {
    const x = s[15] >= 0 && s[1] < s[2] && lo > 1e-4 ? lo : hi;
    const r = G.gls_drop_radius(Math.max(1e-5, Math.min(D.L - 1e-5, x)));
    D.ring.position.set(x, 0, 0);
    D.ring.scale.setScalar(Math.max(r * 1.3, 6e-4));
    flash.position.set(x, 0, 0);
    flash.scale.setScalar(Math.max(6 * r, 0.006));
    if (!D.burstHeard) { D.burstHeard = true; sound.play('fizz', { gain: 1, rate: 0.9, important: true }); }
  }
  // The projectile or hammer.
  const ev = D.event;
  if (proj && ev && ev.kind === 'strike') {
    const v = ev.speed;
    let x;
    if (!ev.done) x = -(ev.at - T) * v;
    else if (ev.broke && !ev.rigid) x = (T - ev.at) * v * 0.9;
    else if (ev.rigid) x = -(T - ev.at) * v * 0.3;
    else x = null;   // splashed away
    proj.visible = x !== null;
    if (x !== null) proj.position.set(x, 0, 0);
  }
  if (pliers && ev && ev.kind === 'snip') {
    const closing = clamp(1 - (ev.at - T) / 0.0015, 0, 1);
    for (const c of pliers.children) c.position.y = c.userData.s * (0.0045 - 0.0027 * closing);
  }
  drawFragments(T);
}

// ---------- Readouts ----------
function fmtT(t) { return t < 1e-3 ? `${(t * 1e6).toFixed(t < 1e-4 ? 2 : 1)} µs` : t < 1 ? `${(t * 1e3).toFixed(3)} ms` : `${t.toFixed(3)} s`; }
function fmtScale(s) { return s >= 0.999 ? '1× · real time' : `1/${Math.round(1 / s).toLocaleString('en-US')} speed`; }
function showOutcome() {
  const s = G.dropState(), ev = D.last;
  const broke = !!s[3];
  $('outcome').textContent = D.outcome;
  $('outcome').className = broke ? 'bad' : 'ok';
  banner(broke ? 'Exploded' : 'Not a scratch', broke ? `A front of cracks at ${(s[5] / 1000).toFixed(2)} km/s` : 'The skin held');
  const kv = [];
  if (ev.kind === 'strike') {
    const def = cat.impactors[ev.idx];
    kv.push(['Hit by', `${def.name} at ${ev.speed.toFixed(0)} m/s`]);
    kv.push(['Contact pressure', `${(s[7] / 1e9).toFixed(2)} GPa`]);
    kv.push(s[10] ? ['Blow / needed', `${(s[8] / 1e3).toFixed(1)} / ${(s[9] / 1e3).toFixed(1)} kN`] : ['Pull at its edge / needed', `${(s[8] / 1e6).toFixed(0)} / ${(s[9] / 1e6).toFixed(0)} MPa`]);
  } else kv.push(['Tail snapped at', `${(ev.x * 1e3).toFixed(0)} mm from the head`]);
  if (broke) {
    kv.push(['Front speed', `${(s[5]).toFixed(0)} m/s`]);
    kv.push(['Head to tail in', fmtT((ev.kind === 'snip' ? ev.x : s[4]) / s[5])]);
    let n = 0, vmax = 0;
    for (let i = 0; i < D.nFrags; ++i) if (!D.fr[9 * i + 8]) { ++n; vmax = Math.max(vmax, Math.hypot(D.fr[9 * i + 4], D.fr[9 * i + 5], D.fr[9 * i + 6])); }
    kv.push(['Fragments', `${n.toLocaleString('en-US')} drawn · fastest ${vmax.toFixed(1)} m/s`]);
  }
  $('kv').innerHTML = kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
}
function dropReadout() {
  const s = G.dropState();
  $('dropDims').textContent = `${(2 * D.head).toFixed(0)} mm head · ${LENGTH} mm long`;
  $('vHead').textContent = `${D.head.toFixed(1)} mm`;
  $('vComp').textContent = `${D.comp.toFixed(0)} MPa`;
  $('dropKv').innerHTML = [
    ['Skin compression', `${D.comp.toFixed(0)} MPa at the surface`],
    ['Core tension', `${(D.comp * CORE_SHARE).toFixed(0)} MPa on the axis`],
    ['Compressed skin', `${(s[11] * 1e3).toFixed(2)} mm deep (mean ${(s[12] / 1e6).toFixed(0)} MPa)`],
    ['Bursts into', `pieces about ${(s[13] * 1e3).toFixed(1)} mm`],
  ].map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
}
let bannerTimer = 0;
function banner(t, sub) {
  $('bTitle').textContent = t; $('bSub').textContent = sub;
  $('banner').classList.add('on');
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => $('banner').classList.remove('on'), 3200);
}
function toast(msg, ms = 2600) {
  const el = $('toast'); el.textContent = msg; el.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), ms);
}

// ---------- Camera ----------
const cam = { theta: 0.35, phi: 1.38, r: 0.17, t: new THREE.Vector3(0.028, 0, 0) };
const VIEWS = [[0.35, 1.38, 0.17, 0.028], [-1.25, 1.45, 0.09, 0.0], [1.35, 1.3, 0.13, 0.05]];
let view = 0;
function applyCamera() {
  cam.phi = clamp(cam.phi, 0.3, Math.PI - 0.3);
  cam.r = clamp(cam.r, 0.03, 1.2);
  camera.position.set(cam.t.x + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta), cam.t.y + cam.r * Math.cos(cam.phi), cam.t.z + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta));
  camera.lookAt(cam.t);
}
function setView(i) {
  view = i; const [th, ph, r, tx] = VIEWS[i];
  cam.theta = th; cam.phi = ph; cam.r = r * (camera.aspect < 1 ? 1.3 : 1); cam.t.set(tx, 0, 0);
  applyCamera();
}
const ptr = new Map();
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
canvas.addEventListener('pointermove', (e) => {
  const p = ptr.get(e.pointerId); if (!p) return;
  if (ptr.size === 1) { cam.theta -= (e.clientX - p.x) * 0.006; cam.phi -= (e.clientY - p.y) * 0.006; applyCamera(); }
  else if (ptr.size === 2) {
    const [a, b] = [...ptr.values()], d0 = Math.hypot(a.x - b.x, a.y - b.y);
    p.x = e.clientX; p.y = e.clientY;
    const [c, d] = [...ptr.values()], d1 = Math.hypot(c.x - d.x, c.y - d.y);
    if (d0 > 0 && d1 > 0) { cam.r *= d0 / d1; applyCamera(); }
    return;
  }
  p.x = e.clientX; p.y = e.clientY;
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, (e) => ptr.delete(e.pointerId));
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.r *= Math.exp(e.deltaY * 0.001); applyCamera(); }, { passive: false });
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  R.setSize(w, h, false); camera.aspect = w / h;
  // On a phone the panels take the bottom of the screen: show the drop above them.
  if (w <= 860) camera.setViewOffset(w, h, 0, 0.24 * h, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------- UI ----------
function chips() {
  const box = $('guns'); box.textContent = '';
  for (const id of GUNS) {
    const i = impIndex(id); if (i < 0) continue;
    const d = cat.impactors[i], b = document.createElement('button');
    b.innerHTML = `${d.name.replace(/ FMJ|, lead/, '')}<small>${d.speed.toFixed(0)} m/s</small>`;
    b.setAttribute('aria-pressed', String(i === gun));
    b.onclick = () => { gun = i; speed = d.speed; syncSpeed(); chips(); };
    box.appendChild(b);
  }
}
function syncSpeed() {
  const d = cat.impactors[gun];
  const lo = d.minSpeed || 50, hi = Math.max(d.maxSpeed || 1000, speed);
  $('speed').value = String(Math.round(1000 * Math.log(speed / lo) / Math.log(hi / lo)));
  $('vSpeed').textContent = `${speed.toFixed(0)} m/s · ${(0.5 * d.mass * speed * speed).toFixed(0)} J`;
}
$('speed').oninput = (e) => { const d = cat.impactors[gun], lo = d.minSpeed || 50, hi = d.maxSpeed || 1000; speed = lo * Math.pow(hi / lo, +e.target.value / 1000); syncSpeed(); };
$('head').oninput = (e) => { D.head = +e.target.value; newDrop(D.seed); };
$('comp').oninput = (e) => { D.comp = +e.target.value; newDrop(D.seed); };
$('snip').oninput = (e) => { $('vSnip').textContent = `${e.target.value} mm from the head`; };
$('vSnip').textContent = `${$('snip').value} mm from the head`;
$('bFire').onclick = fire;
$('bSnip').onclick = () => act({ kind: 'snip', x: +$('snip').value / 1e3 });
$('bTap').onclick = () => act({ kind: 'strike', idx: impIndex('hammer'), speed: 1 });
$('bSwing').onclick = () => act({ kind: 'strike', idx: impIndex('hammer'), speed: 8 });
$('bNew').onclick = () => newDrop();
$('bReplay').onclick = replay;
function replay() { const a = D.last; newDrop(D.seed); if (a) act(a); }
$('bPlay').onclick = () => { playing = !playing; syncPlay(); };
function syncPlay() { $('bPlay').textContent = playing ? 'Pause' : 'Play'; $('bPlay').setAttribute('aria-pressed', String(!playing)); }
$('bAuto').onclick = () => { auto = !auto; $('bAuto').setAttribute('aria-pressed', String(auto)); buildScale(); };
function buildScale() {
  const box = $('scale'); box.textContent = '';
  for (const [s, label] of SCALES) {
    const b = document.createElement('button'); b.textContent = label;
    b.setAttribute('aria-pressed', String(!auto && Math.abs(Math.log10(s / scaleManual)) < 0.01));
    b.onclick = () => { auto = false; scaleManual = s; $('bAuto').setAttribute('aria-pressed', 'false'); buildScale(); };
    box.appendChild(b);
  }
}
$('bCam').onclick = () => setView((view + 1) % VIEWS.length);
$('bPol').onclick = () => {
  polarised = !polarised;
  $('bPol').setAttribute('aria-pressed', String(polarised));
  $('legend').classList.toggle('on', polarised);
  scene.background = polarised ? new THREE.Color(0x000000) : BG;
  backdrop.visible = !polarised;
  buildIntact();
};
{
  // The legend: white-light retardation colours from 0 to 3 orders.
  const c = document.createElement('canvas'); c.width = 256; c.height = 1;
  const g = c.getContext('2d'), img = g.createImageData(256, 1);
  for (let i = 0; i < 256; ++i) {
    const N = 3 * i / 255, I = [Math.sin(Math.PI * N * 0.846) ** 2, Math.sin(Math.PI * N) ** 2, Math.sin(Math.PI * N * 1.222) ** 2];
    for (let k = 0; k < 3; ++k) img.data[4 * i + k] = 255 * Math.min(1, 1.1 * Math.pow(I[k], 0.8));
    img.data[4 * i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  $('legendBar').style.background = `url(${c.toDataURL()})`;
  $('legendBar').style.backgroundSize = '100% 100%';
}
let soundOn = true;
$('bSound').onclick = () => { soundOn = !soundOn; sound.setEnabled(soundOn); $('bSound').setAttribute('aria-pressed', String(soundOn)); $('bSound').textContent = soundOn ? 'Sound' : 'Muted'; };
function showTab(w) {
  $('lab').hidden = w !== 'lab'; $('res').hidden = w !== 'res';
  $('tLab').setAttribute('aria-pressed', String(w === 'lab')); $('tRes').setAttribute('aria-pressed', String(w === 'res'));
  $('tabs').classList.toggle('closed', w === 'none');
}
$('tLab').onclick = () => showTab('lab'); $('tRes').onclick = () => showTab('res'); $('tHide').onclick = () => showTab('none');
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); fire(); }
  else if (k === 't') $('bSnip').click();
  else if (k === 'p') $('bPlay').click();
  else if (k === 'z') replay();
  else if (k === 'r') newDrop();
  else if (k === 'c') $('bCam').click();
  else if (k === 's') $('bPol').click();
  else if (k === 'm') $('bSound').click();
  else if (k === 'a') $('bAuto').click();
});

// ---------- Share ----------
function shareURL() {
  const u = new URL(location.href.split('?')[0]), q = u.searchParams, a = D.last;
  q.set('h', D.head.toFixed(1)); q.set('c', D.comp.toFixed(0)); q.set('seed', String(D.seed));
  if (a && a.kind === 'snip') { q.set('a', 'snip'); q.set('x', (a.x * 1e3).toFixed(0)); }
  else if (a) { q.set('a', 'hit'); q.set('p', cat.impactors[a.idx].id); q.set('v', a.speed.toFixed(1)); }
  return u.href;
}
$('bShare').onclick = async () => {
  const url = shareURL(), text = D.last ? (D.last.kind === 'snip' ? 'Snapping the tail of a Prince Rupert\'s drop' : `${cat.impactors[D.last.idx].name} at ${D.last.speed.toFixed(0)} m/s into a Prince Rupert's drop`) : 'A Prince Rupert\'s drop';
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Glass Lab · ' + text, text, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied: ' + text, 3500); }
  } catch { /* cancelled */ }
};
function applyLink() {
  const q = new URLSearchParams(location.search);
  if (q.has('h')) D.head = clamp(+q.get('h') || 5, 3, 8);
  if (q.has('c')) D.comp = clamp(+q.get('c') || 500, 200, 800);
  $('head').value = String(D.head); $('comp').value = String(D.comp);
  const seed = q.has('seed') ? (+q.get('seed') >>> 0) : undefined;
  newDrop(seed);
  const a = q.get('a');
  if (a === 'snip') { const x = clamp(+q.get('x') || 50, 20, 70); $('snip').value = String(x); $('vSnip').textContent = `${x} mm from the head`; setTimeout(() => act({ kind: 'snip', x: x / 1e3 }), 600); }
  else if (a === 'hit') {
    const i = impIndex(q.get('p') || 'lead_38');
    if (i >= 0) { gun = i; speed = clamp(+q.get('v') || cat.impactors[i].speed, 0.1, 2000); if (GUNS.includes(cat.impactors[i].id)) { chips(); syncSpeed(); } setTimeout(() => act({ kind: 'strike', idx: i, speed }), 600); }
  }
}

// ---------- Boot ----------
resize();
chips();
syncSpeed();
buildScale();
syncPlay();
setView(0);
applyLink();
$('loading').remove();
if (window.innerWidth <= 860) showTab('lab');
toast('Fire at the head, or snap the tail · drag to look around', 4000);
window.__drop = { G, D, get T() { return T; }, cam, applyCamera, scene };
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  step(dt);
  sound.frame(T, playing ? scaleNow : 1e-4, dt);
  $('clock').innerHTML = `${fmtT(T)}<small>${fmtScale(scaleNow)}${auto ? ' · auto' : ''}</small>`;
  $('hudText').textContent = scaleNow < 0.999 ? `High-speed camera · ${(60 / scaleNow).toLocaleString('en-US', { maximumFractionDigits: 0 })} fps` : 'Camera · 60 fps';
  R.render(scene, camera);
}
requestAnimationFrame(frame);
