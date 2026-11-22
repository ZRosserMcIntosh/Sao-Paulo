// São Paulo World · flight test bed: the time of day.
// One value, the local solar time over São Paulo (hours, 0 to 24), sets the
// sun (and at night the moon), the light on the world, the sky, the haze and
// the city's lights. The sun's path is an equinox day at São Paulo's latitude
// (up at 06:00 in the east, 66° high in the north at noon, down at 18:00), the
// same on every date so two players who share a time see the same sky.
//
// For the other modules (import { timeOfDay } from './daynight.js'):
//   timeOfDay.get()                 the time now, hours
//   timeOfDay.set(hours, { live })  set it (live: follow São Paulo's clock from then on)
//   timeOfDay.onChange(fn)          fn(hours, state) on every change; returns its remover
//   timeOfDay.state                 { hours, live, elevation (deg), dark 0..1, city 0..1 }
// The page (app.js) makes the one instance with createDayNight and calls its
// frame() once a frame after its own weather has set the lights and the sky.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const LAT = -23.55 * DEG;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// What a player picks from (the menu's buttons, and anything else that offers a time).
export const TIMES = [
  { id: 'dawn', name: 'Dawn', hours: 5.8 },
  { id: 'day', name: 'Day', hours: 12 },
  { id: 'golden', name: 'Golden hour', hours: 17.4 },
  { id: 'dusk', name: 'Dusk', hours: 18.3 },
  { id: 'night', name: 'Night', hours: 22 },
];
export const TEXT = { heading: 'Time of day', now: 'Now in São Paulo', time: 'Time', live: 'São Paulo time' };
// São Paulo's clock (UTC−3 all year), hours.
export const saoPauloNow = () => { const d = new Date(); return (d.getUTCHours() + 21 + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600) % 24; };
const fmtTime = (h) => { const m = Math.round(h * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// The look by the sun's elevation (deg), from high sun down to full night;
// between two rows everything blends. Colours as written are what the screen
// shows. sun, amb: the direct and the ambient light; haze: the horizon and
// the fog; zen: the sky overhead; glow: the low sun's glow in the sky; fog:
// the fog layer's grey; cloud: rain's and cloud's grey; own: how much the
// sky keeps its own deeper blue over the haze line (the daytime look).
const LOOK = [
  // el   sun        sunI  amb        ambI  haze       zen        glow       glowI fog    cloud      own
  [30, '#fff6e8', 0.60, '#ffffff', 0.58, '#a9c2dc', '#0d2871', '#ffb46a', 0.00, 0.80, '#dfe0e2', 1.0],
  [14, '#ffeccb', 0.60, '#fff5ec', 0.56, '#b8c5d3', '#11306f', '#ffb46a', 0.18, 0.78, '#dcdcdc', 1.0],
  [6, '#ffc67f', 0.58, '#f3dfd3', 0.50, '#d8c0a6', '#1a376f', '#ff9a48', 0.50, 0.70, '#cdc6c2', 0.6],
  [0, '#ff8c48', 0.30, '#c9b4c2', 0.42, '#cfa58e', '#1f2f60', '#ff6a2c', 0.85, 0.48, '#a39a9d', 0.25],
  [-4, '#ff7038', 0.00, '#9096c2', 0.34, '#7f7391', '#131e46', '#e8562a', 0.60, 0.21, '#655f6c', 0.0],
  [-9, '#a9bfee', 0.00, '#6e7db4', 0.27, '#2f3252', '#090f26', '#8a3a22', 0.22, 0.07, '#39373f', 0.0],
  [-15, '#a9bfee', 0.13, '#6f84c6', 0.21, '#181b2c', '#04060d', '#000000', 0.00, 0.035, '#292629', 0.0],
];
const srgb = (hex) => new THREE.Color(hex);  // (to the renderer's linear working space)
const shown = (hex) => new THREE.Color().setHex(parseInt(hex.slice(1), 16), THREE.LinearSRGBColorSpace);  // kept as written: the sky's shader shows it as it is
const ROWS = LOOK.map((r) => ({ el: r[0], sun: srgb(r[1]), sunI: r[2], amb: srgb(r[3]), ambI: r[4], haze: srgb(r[5]), zen: shown(r[6]), glow: shown(r[7]).multiplyScalar(r[8]), fog: r[9], cloud: srgb(r[10]), own: r[11] }));
// The day exactly as the page had it (its zenith and its cloud grey were written in other units).
ROWS[0].zen.set('#3f6fb2'); ROWS[0].cloud.setRGB(0.72, 0.74, 0.77);

const SKY_VERT = 'varying vec3 vP; void main(){ vP = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }';
// hor and zen are the page's (its weather greys them every frame). The haze
// at the horizon is shown as the fogged ground shows it, so sky and ground
// meet without a line; above it the daytime sky keeps its own blue (own = 1)
// and the dusk and night skies rise from the haze itself (own = 0).
const SKY_FRAG = `uniform vec3 hor; uniform vec3 zen; uniform vec3 sunDir; uniform vec3 sunCol; uniform vec3 glowCol; uniform vec3 moonDir; uniform vec3 moonCol; uniform float own; uniform float dith;
varying vec3 vP;
void main(){
  vec3 d = normalize(vP);
  float y = max(d.y, 0.0);
  vec3 haze = pow(hor, vec3(0.4545));
  vec3 col = mix(mix(haze, hor, own), zen, pow(y, 0.5));
  col = mix(haze, col, smoothstep(0.0, 0.09, y));
  float s = max(dot(d, sunDir), 0.0), s8 = s * s; s8 *= s8; s8 *= s8;
  col += glowCol * (0.6 * s8 * exp(-4.0 * y) + 0.5 * pow(s8, 12.0)) + sunCol * smoothstep(0.99988, 0.99996, s);
  float m = max(dot(d, moonDir), 0.0);
  col += moonCol * (smoothstep(0.99986, 0.99992, m) + 0.05 * pow(m, 900.0));
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * dith;
  gl_FragColor = vec4(col, 1.0);
}`;

let instance = null;
const pending = [];  // listeners added before the page made the instance
export const timeOfDay = {
  get: () => (instance ? instance.state.hours : 12),
  set: (hours, o) => instance && instance.setTime(hours, o),
  onChange: (fn) => (instance ? instance.onChange(fn) : (pending.push(fn), () => { const k = pending.indexOf(fn); if (k >= 0) pending.splice(k, 1); })),
  get state() { return instance ? instance.state : { hours: 12, live: false, elevation: 66, dark: 0, city: 0 }; },
};

// sun, ambient: the scene's lights; SKY: the haze colour (the fog's and the
// horizon's); SUN_DIR: where the light comes from (scene axes); FOG: the fog
// layer's uniform (its z the grey). All are the page's own objects, changed
// in place, so its weather code goes on using them as it did.
export function createDayNight({ renderer, scene, sun, ambient, skyDome, SKY, SUN_DIR, FOG, store, mobile = false }) {
  const state = { hours: 12, live: false, elevation: 66, azimuth: 0, dark: 0, city: 0, stars: 0, sunI: 0.6, ambI: 0.58 };
  const P = { sun: new THREE.Color(), amb: new THREE.Color(), haze: new THREE.Color(), zen: new THREE.Color(), glow: new THREE.Color(), cloud: new THREE.Color(), sunI: 0.6, ambI: 0.58, fog: 0.8, own: 1 };
  const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3();
  // Shared with the ground's, the buildings' and the lights' shaders (by reference).
  const uniforms = { uNight: { value: 0 }, uLate: { value: 1 } };
  let bound = null;  // { SKY_ZEN, FOG_GREY, WX_GREY }: the page's other sky colours
  const listeners = new Set(pending);
  pending.length = 0;

  // The sky: the page's dome with a shader that knows the sun, the moon and the haze line.
  const sky = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      hor: { value: SKY.clone() }, zen: { value: ROWS[0].zen.clone() }, sunDir: { value: sunDir }, sunCol: { value: new THREE.Color(0, 0, 0) }, glowCol: { value: new THREE.Color(0, 0, 0) },
      moonDir: { value: moonDir }, moonCol: { value: new THREE.Color(0, 0, 0) }, own: { value: 1 }, dith: { value: 0 },
    },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
  });
  skyDome.material.dispose();
  skyDome.material = sky;

  // Stars: points on the dome, turning with the hours about the south celestial pole.
  const NS = mobile ? 700 : 1400;
  const stars = (() => {
    const pos = new Float32Array(NS * 3), mag = new Float32Array(NS);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < NS; ++i) {
      const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
      pos[3 * i] = 70000 * r * Math.cos(a); pos[3 * i + 1] = 70000 * z; pos[3 * i + 2] = 70000 * r * Math.sin(a);
      mag[i] = 0.25 + 0.75 * Math.pow(rnd(), 4);  // a few bright ones, many faint
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
      uniforms: { gain: { value: 0 }, px: { value: 1 } },
      vertexShader: `attribute float mag; uniform float gain; uniform float px; varying float vA;
        void main(){ vec3 w = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          vA = gain * mag * smoothstep(0.02, 0.3, w.y);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; gl_PointSize = px * (1.2 + 1.6 * mag); }`,
      fragmentShader: 'varying float vA; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; gl_FragColor = vec4(vec3(0.86, 0.9, 1.0) * vA * max(0.0, 1.0 - r * r), 1.0); }',
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; pts.visible = false; pts.renderOrder = -1;
    skyDome.add(pts);
    return pts;
  })();
  const POLE = new THREE.Vector3(0, Math.sin(-LAT), Math.cos(-LAT));  // the south celestial pole: 23.5° up, due south

  // Reflections on the paint and the glass: the page's baked sky for the day
  // (kept as it is), a darker one baked here for the other hours.
  let env0 = null, envRT = null, pmrem = null, envScene = null, envU = null, envEl = 99, envTimer = 0;
  function bakeEnv() {
    envTimer = 0;
    if (env0 === null) env0 = scene.environment;
    if (state.elevation >= 30) { scene.environment = env0; if (envRT) { envRT.dispose(); envRT = null; } envEl = 99; return; }
    if (!pmrem) {
      pmrem = new THREE.PMREMGenerator(renderer);
      envU = { zen: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, gnd: { value: new THREE.Color() } };
      envScene = new THREE.Scene();
      envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
        side: THREE.BackSide, uniforms: envU,
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 zen; uniform vec3 hor; uniform vec3 gnd; varying vec3 vP; void main(){ float y = vP.y; gl_FragColor = vec4(y > 0.0 ? mix(hor, zen, pow(y, 0.55)) : mix(hor * 0.6, gnd, pow(-y, 0.4)), 1.0); }',
      })));
    }
    // The day's sky and ground (as the page bakes them), dimmed and tinted with the light; the city's glow from below at night.
    const k = (P.ambI + 0.5 * P.sunI) / 0.88;
    envU.zen.value.setRGB(0.2, 0.36, 0.66).multiplyScalar(k).lerp(P.zen, 1 - k);
    envU.hor.value.setRGB(0.82, 0.87, 0.92).multiply(P.haze).multiplyScalar(1.9);
    envU.gnd.value.setRGB(0.32, 0.34, 0.3).multiply(P.amb).multiplyScalar(k);
    envU.gnd.value.r += 0.05 * state.city; envU.gnd.value.g += 0.035 * state.city; envU.gnd.value.b += 0.02 * state.city;
    const rt = pmrem.fromScene(envScene, 0.02);
    scene.environment = rt.texture;
    if (envRT) envRT.dispose();
    envRT = rt; envEl = state.elevation;
  }

  const lerpRow = (a, b, t) => {
    P.sun.copy(a.sun).lerp(b.sun, t); P.amb.copy(a.amb).lerp(b.amb, t); P.haze.copy(a.haze).lerp(b.haze, t); P.zen.copy(a.zen).lerp(b.zen, t);
    P.glow.copy(a.glow).lerp(b.glow, t); P.cloud.copy(a.cloud).lerp(b.cloud, t);
    P.sunI = a.sunI + (b.sunI - a.sunI) * t; P.ambI = a.ambI + (b.ambI - a.ambI) * t; P.fog = a.fog + (b.fog - a.fog) * t; P.own = a.own + (b.own - a.own) * t;
  };
  // Everything that follows from the hour: once per change, not per frame.
  function apply() {
    const H = (state.hours - 12) * 15 * DEG;
    // The sun, scene axes (x east, y up, z south), declination 0.
    sunDir.set(-Math.sin(H), Math.cos(LAT) * Math.cos(H), Math.sin(LAT) * Math.cos(H)).normalize();
    moonDir.copy(sunDir).negate();  // a full moon: up while the sun is down
    const el = Math.asin(clamp(sunDir.y, -1, 1)) / DEG;
    state.elevation = el; state.azimuth = (Math.atan2(sunDir.x, -sunDir.z) / DEG + 360) % 360;
    let k = 0;
    while (k < ROWS.length - 2 && el < ROWS[k + 1].el) ++k;
    lerpRow(ROWS[k], ROWS[k + 1], clamp((ROWS[k].el - el) / (ROWS[k].el - ROWS[k + 1].el), 0, 1));
    state.dark = smooth(4, -8, el);          // how dark it is to the eye
    state.city = smooth(1.5, -5.5, el);      // the city's and the airports' lights coming on
    state.stars = smooth(-5, -13, el);
    state.sunI = P.sunI; state.ambI = P.ambI;
    // The light comes from the sun, or from the moon once the sun's is gone;
    // never from lower than 10° (the shadow's frustum would run to the horizon).
    const from = el > -5 ? sunDir : moonDir;
    SUN_DIR.set(from.x, Math.max(from.y, 0.17), from.z).normalize();
    SKY.copy(P.haze);
    FOG.z = P.fog;
    if (bound) { bound.SKY_ZEN.copy(P.zen); bound.FOG_GREY.setRGB(P.fog, P.fog, P.fog); bound.WX_GREY.copy(P.cloud); }
    const u = sky.uniforms;
    u.own.value = P.own;
    u.dith.value = 0.012 * state.dark;
    stars.quaternion.setFromAxisAngle(POLE, -H);
    uniforms.uNight.value = state.city;
    // Fewer windows lit as the night goes on: all of the evening's by 20:00, a third of them at 03:00.
    const late = state.hours >= 12 ? clamp((state.hours - 21) / 5, 0, 1) : clamp((5 - state.hours) / 3 + 0.4, 0, 1);
    uniforms.uLate.value = 1 - 0.65 * late;
    if (Math.abs(el - envEl) > 0.4 && !envTimer) envTimer = setTimeout(bakeEnv, 180);
  }

  let liveTimer = 0;
  function setTime(hours, { live = false, save = true } = {}) {
    if (!Number.isFinite(hours)) return;
    state.hours = ((hours % 24) + 24) % 24; state.live = !!live;
    apply();
    if (save && store) store.set('time', { hours: Math.round(state.hours * 1000) / 1000, live: state.live });
    clearInterval(liveTimer); liveTimer = 0;
    if (state.live) liveTimer = setInterval(() => { state.hours = saoPauloNow(); apply(); for (const f of listeners) f(state.hours, state); }, 30000);
    for (const f of listeners) f(state.hours, state);
  }
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  // Once a frame, after the page's own weather has set its day's lights and
  // sky: the hour's light on them. haze 0..1: how far rain, cloud or fog have
  // closed the sky in (the sun, the moon and the stars go with it).
  // studio: the wind tunnel's plain light (no time of day there).
  const DAY_SUN = srgb(LOOK[0][1]), WHITE = new THREE.Color(1, 1, 1);
  function frame(camera, wx, studio = false) {
    const u = sky.uniforms;
    if (studio) { sun.color.copy(DAY_SUN); ambient.color.copy(WHITE); uniforms.uNight.value = 0; stars.visible = false; return; }
    uniforms.uNight.value = state.city;
    let clear = 1;
    if (wx && wx.visibility < 30000) clear *= 1 - clamp(1 - wx.visibility / 12000, 0, 1) * (wx.inCloud ? 1 : 0.85);
    if (FOG.y > 0) clear *= Math.exp(-FOG.y * Math.max(0, FOG.x - camera.position.y));
    sun.color.copy(P.sun); ambient.color.copy(P.amb);
    sun.intensity *= P.sunI / 0.6; ambient.intensity *= P.ambI / 0.58;
    u.glowCol.value.copy(P.glow).multiplyScalar(clear);
    const up = smooth(-1.5, 0.5, state.elevation) * clear;  // the disc, while it is above the horizon
    u.sunCol.value.copy(P.sun).multiplyScalar(up * (0.55 + 0.45 * smooth(0, 12, state.elevation)));
    u.moonCol.value.setRGB(0.8, 0.84, 0.9).multiplyScalar(state.stars * clear);
    const st = state.stars * clear;
    stars.visible = st > 0.02;
    if (stars.visible) { stars.material.uniforms.gain.value = st; stars.material.uniforms.px.value = renderer.getPixelRatio(); }
  }

  // The time-of-day control: the presets, São Paulo's clock, and a slider.
  function mountUi(el) {
    if (!el) return;
    const h = document.createElement('h2'); h.textContent = TEXT.heading;
    const row = document.createElement('div'); row.className = 'row'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', TEXT.heading);
    const btn = (label, go) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', () => { go(); b.blur(); }); row.append(b); return b; };
    const bs = TIMES.map((t) => [t, btn(t.name, () => setTime(t.hours))]);
    const bNow = btn(TEXT.now, () => setTime(saoPauloNow(), { live: true }));
    const lab = document.createElement('label'); lab.className = 'ctl'; lab.append(TEXT.time + ' ');
    const rng = document.createElement('input'); Object.assign(rng, { type: 'range', min: '0', max: '24', step: '0.1', value: '12' });
    const out = document.createElement('output');
    lab.append(rng, out);
    rng.addEventListener('input', () => setTime(+rng.value));
    rng.addEventListener('change', () => rng.blur());
    el.append(h, row, lab);
    const show = () => {
      for (const [t, b] of bs) b.setAttribute('aria-pressed', String(!state.live && Math.abs(t.hours - state.hours) < 0.06));
      bNow.setAttribute('aria-pressed', String(state.live));
      if (document.activeElement !== rng) rng.value = String(state.hours);
      out.textContent = state.live ? `${fmtTime(state.hours)} · ${TEXT.live}` : fmtTime(state.hours);
    };
    onChange(show); show();
  }

  const api = { state, uniforms, setTime, onChange, frame, mountUi, bind: (b) => { bound = b; apply(); }, get sunDir() { return sunDir; } };
  instance = api;
  // The saved time; São Paulo's clock if that was the choice. (Noon the first time: the day as it was.)
  const saved = store ? store.get('time', null) : null;
  if (saved && saved.live) setTime(saoPauloNow(), { live: true, save: false });
  else setTime(saved && Number.isFinite(saved.hours) ? saved.hours : 12, { save: false });
  return api;
}
