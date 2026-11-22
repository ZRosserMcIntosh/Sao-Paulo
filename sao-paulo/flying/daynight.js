// São Paulo World · flight test bed: the time of day.
// One value, the local solar time over São Paulo (hours, 0 to 24), sets the
// sun (and at night the moon), the light on the world, the sky, the haze and
// the city's lights. The sun's path is a midsummer day at São Paulo's
// latitude (up at 05:16 in the east-south-east, overhead at noon, down at
// 18:44 in the west-south-west), the same on every date so two players who
// share a time see the same sky. The afternoon sun of 14:00, 62° up in the
// west, is the light the page always had: the time a first visit starts at.
//
// For the other modules (import { timeOfDay } from './daynight.js'):
//   timeOfDay.get()                 the time now, hours
//   timeOfDay.set(hours, { live, save })  set it (live: follow São Paulo's clock from then on; save: false for a
//                                   time that is not the player's own choice, a challenge's or a host's: it is not kept)
//   timeOfDay.onChange(fn)          fn(hours, state) on every change; returns its remover
//   timeOfDay.state                 { hours, live, elevation (deg), dark 0..1, city 0..1 }
// The page (app.js) makes the one instance with createDayNight and calls its
// frame() once a frame after its own weather has set the lights and the sky.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const LAT = -23.55 * DEG, DECL = -23.44 * DEG;  // São Paulo; the sun's declination at the December solstice
export const DEFAULT_HOURS = 14;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// What a player picks from (the menu's buttons, and anything else that offers a time).
export const TIMES = [
  { id: 'dawn', name: 'Dawn', hours: 5.05 },
  { id: 'day', name: 'Day', hours: DEFAULT_HOURS },
  { id: 'golden', name: 'Golden hour', hours: 18.1 },
  { id: 'dusk', name: 'Dusk', hours: 19.1 },
  { id: 'night', name: 'Night', hours: 22 },
];
export const TEXT = { heading: 'Time of day', now: 'Now in São Paulo', time: 'Time', live: 'São Paulo time' };
// São Paulo's clock (UTC−3 all year), hours.
export const saoPauloNow = () => { const d = new Date(); return (d.getUTCHours() + 21 + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600) % 24; };
const fmtTime = (h) => { const m = Math.round(h * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// The look by the sun's elevation (deg), from high sun down to full night;
// between two rows everything blends. Colours as written are what the screen
// shows. sun, amb: the direct and the ambient light; haze: the horizon and
// the fog; low, zen: the sky above the haze and overhead; glow: the low
// sun's glow in the sky; fog: the fog layer's grey; cloud: rain's and
// cloud's grey.
const LOOK = [
  // el   sun        sunI  amb        ambI  haze       low        zen        glow       glowI fog    cloud
  [30, '#fff6e8', 0.60, '#ffffff', 0.58, '#a9c2dc', '#6589b7', '#0d2871', '#ffb46a', 0.00, 0.80, '#dfe0e2'],
  [14, '#ffe6ba', 0.66, '#f1f2f8', 0.54, '#b8c5d3', '#7190b8', '#11306f', '#ffb46a', 0.18, 0.78, '#dcdcdc'],
  [6, '#ffb868', 0.85, '#c8cee6', 0.44, '#d8c0a6', '#8fa0bd', '#1a376f', '#ff9a48', 0.50, 0.70, '#cdc6c2'],
  [0, '#ff7e3c', 0.50, '#a9a9cc', 0.38, '#cfa58e', '#8c88aa', '#1f2f60', '#ff6a2c', 0.85, 0.48, '#a39a9d'],
  [-4, '#ff7038', 0.00, '#9096c2', 0.34, '#7f7391', '#57547a', '#131e46', '#e8562a', 0.60, 0.21, '#655f6c'],
  [-9, '#a9bfee', 0.00, '#6e7db4', 0.27, '#2f3252', '#20243f', '#090f26', '#8a3a22', 0.22, 0.08, '#3a3840'],
  [-15, '#a9bfee', 0.13, '#6f84c6', 0.21, '#181b2c', '#0d101e', '#04060d', '#000000', 0.00, 0.05, '#2d2826'],
];
const srgb = (hex) => new THREE.Color(hex);  // (to the renderer's linear working space)
const shown = (hex) => new THREE.Color().setHex(parseInt(hex.slice(1), 16), THREE.LinearSRGBColorSpace);  // kept as written: the sky's shader shows it as it is
const ROWS = LOOK.map((r) => ({ el: r[0], sun: srgb(r[1]), sunI: r[2], amb: srgb(r[3]), ambI: r[4], haze: srgb(r[5]), low: shown(r[6]), zen: shown(r[7]), glow: shown(r[8]).multiplyScalar(r[9]), fog: r[10], cloud: srgb(r[11]) }));
// The day exactly as the page had it (its sky showed its colours' linear values as they were; its cloud grey was written in them).
ROWS[0].low.set('#a9c2dc'); ROWS[0].zen.set('#3f6fb2'); ROWS[0].cloud.setRGB(0.72, 0.74, 0.77);

const SKY_VERT = 'varying vec3 vP; void main(){ vP = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }';
// hor and zen are the page's (its weather greys them every frame); low is
// the hour's sky above the haze, and haze the page's hor as the fogged ground
// shows it, so sky and ground meet without a line (both set in frame()).
// The sun's, the moon's and the night's parts are skipped while they are off.
const SKY_FRAG = `uniform vec3 hor; uniform vec3 haze; uniform vec3 low; uniform vec3 zen; uniform vec3 sunDir; uniform vec3 sunCol; uniform vec3 glowCol; uniform vec3 moonDir; uniform vec3 moonCol; uniform float dith;
varying vec3 vP;
void main(){
  vec3 d = normalize(vP);
  float y = max(d.y, 0.0);
  vec3 col = mix(haze, mix(low, zen, pow(y, 0.5)), smoothstep(0.0, 0.09, y));
  if (sunCol.r + glowCol.r > 0.0) {
    float s = max(dot(d, sunDir), 0.0);
    col += sunCol * smoothstep(0.99988, 0.99996, s);
    if (glowCol.r > 0.0) { float s8 = s * s; s8 *= s8; s8 *= s8; col += glowCol * (0.6 * s8 * exp(-4.0 * y) + 0.5 * pow(s8, 12.0)); }
  }
  if (dith > 0.0) {
    float m = dot(d, moonDir);
    if (m > 0.995) col += moonCol * (smoothstep(0.99986, 0.99992, m) + 0.05 * pow(m, 900.0));
    col += (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * dith;  // (no bands in the dark gradient)
  }
  gl_FragColor = vec4(col, 1.0);
}`;

let instance = null;
const pending = [];  // listeners added before the page made the instance
export const timeOfDay = {
  get: () => (instance ? instance.state.hours : DEFAULT_HOURS),
  set: (hours, o) => instance && instance.setTime(hours, o),
  onChange: (fn) => (instance ? instance.onChange(fn) : (pending.push(fn), () => { const k = pending.indexOf(fn); if (k >= 0) pending.splice(k, 1); })),
  get state() { return instance ? instance.state : { hours: DEFAULT_HOURS, live: false, elevation: 62, dark: 0, city: 0 }; },
};

// sun, ambient: the scene's lights; SKY: the haze colour (the fog's and the
// horizon's); SUN_DIR: where the light comes from (scene axes); FOG: the fog
// layer's uniform (its z the grey, its w the warmth). All are the page's own objects, changed
// in place, so its weather code goes on using them as it did.
export function createDayNight({ renderer, scene, sun, ambient, skyDome, SKY, SUN_DIR, FOG, store, mobile = false }) {
  const state = { hours: DEFAULT_HOURS, live: false, elevation: 62, azimuth: 264, dark: 0, city: 0, stars: 0, sunI: 0.6, ambI: 0.58 };
  const P = { sun: new THREE.Color(), amb: new THREE.Color(), haze: new THREE.Color(), low: new THREE.Color(), zen: new THREE.Color(), glow: new THREE.Color(), cloud: new THREE.Color(), sunI: 0.6, ambI: 0.58, fog: 0.8 };
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
      hor: { value: SKY.clone() }, haze: { value: SKY.clone().convertLinearToSRGB() }, low: { value: ROWS[0].low.clone() }, zen: { value: ROWS[0].zen.clone() }, sunDir: { value: sunDir }, sunCol: { value: new THREE.Color(0, 0, 0) }, glowCol: { value: new THREE.Color(0, 0, 0) },
      moonDir: { value: moonDir }, moonCol: { value: new THREE.Color(0, 0, 0) }, dith: { value: 0 },
    },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
  });
  skyDome.material.dispose();
  skyDome.material = sky;

  // Stars: points on the dome, turning with the hours about the south celestial pole.
  const NS = mobile ? 450 : 900;
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
    P.sun.copy(a.sun).lerp(b.sun, t); P.amb.copy(a.amb).lerp(b.amb, t); P.haze.copy(a.haze).lerp(b.haze, t); P.low.copy(a.low).lerp(b.low, t); P.zen.copy(a.zen).lerp(b.zen, t);
    P.glow.copy(a.glow).lerp(b.glow, t); P.cloud.copy(a.cloud).lerp(b.cloud, t);
    P.sunI = a.sunI + (b.sunI - a.sunI) * t; P.ambI = a.ambI + (b.ambI - a.ambI) * t; P.fog = a.fog + (b.fog - a.fog) * t;
  };
  // Everything that follows from the hour: once per change, not per frame.
  function apply() {
    const H = (state.hours - 12) * 15 * DEG;
    // The sun, scene axes (x east, y up, z south), from its hour angle H.
    sunDir.set(-Math.cos(DECL) * Math.sin(H), Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H),
      -(Math.cos(LAT) * Math.sin(DECL) - Math.sin(LAT) * Math.cos(DECL) * Math.cos(H))).normalize();
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
    // The fog layer: grey by day; after dark the city's lamps warm it.
    FOG.z = P.fog; FOG.w = 0.3 * state.city;
    if (bound) { bound.SKY_ZEN.copy(P.zen); bound.FOG_GREY.setRGB(P.fog * (1 + FOG.w), P.fog, P.fog * (1 - FOG.w)); bound.WX_GREY.copy(P.cloud); }
    sky.uniforms.dith.value = 0.012 * state.dark;
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
  // sky: the hour's light on them. wx: the core's weather (its visibility
  // and the fog layer close the sky in: the sun, the moon and the stars go
  // with it). studio: the wind tunnel's plain light (no time of day there).
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
    u.haze.value.copy(u.hor.value).convertLinearToSRGB();
    // The sky above the haze: the hour's; as the weather closes in, the page's grey (by day as it always
    // showed it, after dark as the fogged ground shows it, so the murk is one colour).
    if (clear < 1) u.low.value.copy(u.haze.value).lerp(u.hor.value, 1 - state.dark).lerp(P.low, clear);
    else u.low.value.copy(P.low);
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
    const rng = document.createElement('input'); Object.assign(rng, { type: 'range', min: '0', max: '24', step: '0.1', value: String(DEFAULT_HOURS) });
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
  // The saved time; São Paulo's clock if that was the choice. (The first time: the afternoon the page always had.)
  const saved = store ? store.get('time', null) : null;
  if (saved && saved.live) setTime(saoPauloNow(), { live: true, save: false });
  else setTime(saved && Number.isFinite(saved.hours) ? saved.hours : DEFAULT_HOURS, { save: false });
  return api;
}
