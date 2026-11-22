// São Paulo World · flight test bed: lights that are seen, not lights that
// light. Every runway, approach and aircraft light is one point of a Points
// object, drawn by one small shader: its size from its distance, its colour
// and whether it shows from where it is looked at (a runway light's beam, a
// PAPI unit's red and white by the viewer's angle above it, a beacon's or a
// strobe's flash from a shared clock). Nothing here is a three.js light,
// except the one landing light (a spot light on the player's own aircraft).
//
//   buildRunwayLights({ fogLayer })      the airports' lights: .group, .setFields(region), .setFar(region), .update(...)
//   buildAircraftLights(model, o)        an aircraft's lights from a small flags value (LIGHT.*): .set(flags)
//   buildLandingLight()                  the player's landing light: .attach(root, at), .set(level)
//   tickLights(camera, renderer, scene, time, dark)   once a frame: the shared clock and scale
import * as THREE from 'three';

const DEG = Math.PI / 180;
// An aircraft's lights, as bits (what the multiplayer link sends).
export const LIGHT = { NAV: 1, BEACON: 2, STROBE: 4, LANDING: 8, TAXI: 16 };

// Shared by every light material (by reference): uPx the pixels a metre covers at 1 m; uTime s; uDim the aircraft lights' daytime dimming.
const SHARED = { uPx: { value: 800 }, uTime: { value: 0 }, uMin: { value: 2 }, uDim: { value: 1 }, fogNear: { value: 3000 }, fogFar: { value: 26000 }, fogLayer: { value: { x: -1e9, y: 0, z: 0.8, w: 0 } } };

// aParm: x the glow's diameter (m: the glare round a lamp, not its lens), y the kind, z a phase (flashers) or an angle (PAPI, rad), w its own brightness.
// Kinds: 0 all round · 1 a beam along aDir · 2 a PAPI unit · 3 a sequenced flasher (beam) ·
// 4 navigation · 5 beacon · 6 strobe · 7 landing or taxi light (beam) (4 to 7: an aircraft's, switched by uOn).
const VERT = `
attribute vec3 aColor; attribute vec3 aDir; attribute vec4 aParm;
uniform float uPx, uTime, uMin, uDim, uGain, uPapi, fogNear, fogFar; uniform vec4 fogLayer; uniform vec4 uOn;
varying vec4 vCol;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vec3 toCam = cameraPosition - wp.xyz;
  float dist = max( length( toCam ), 0.01 );
  vec3 v = toCam / dist;
  float kind = aParm.y, g = uGain * aParm.w;
  vec3 col = aColor;
  float beam = smoothstep( -0.15, 0.15, dot( v, normalize( mat3( modelMatrix ) * ( aDir + vec3( 0.0, 1e-5, 0.0 ) ) ) ) );
  if ( kind > 0.5 && kind < 1.5 ) g *= beam;
  else if ( kind < 2.5 && kind > 1.5 ) {
    // Red below the unit's angle, white above it, over 3 minutes of arc.
    col = mix( vec3( 1.0, 0.07, 0.04 ), vec3( 1.0, 0.97, 0.9 ), smoothstep( -0.0005, 0.0005, asin( clamp( v.y, -1.0, 1.0 ) ) - aParm.z ) );
    g = uPapi * aParm.w * beam * beam;
  }
  else if ( kind < 3.5 && kind > 2.5 ) g *= beam * step( fract( uTime * 2.0 - aParm.z ), 0.07 );
  else if ( kind < 4.5 && kind > 3.5 ) g = uOn.x * uDim * aParm.w;
  else if ( kind < 5.5 && kind > 4.5 ) g = uOn.y * aParm.w * step( fract( uTime / 1.1 + aParm.z ), 0.11 );
  else if ( kind < 6.5 && kind > 5.5 ) { float t = fract( uTime / 1.3 + aParm.z ) * 1.3; g = uOn.z * aParm.w * ( step( t, 0.06 ) + step( 0.16, t ) * step( t, 0.21 ) ); }
  else if ( kind > 6.5 ) g = uOn.w * aParm.w * ( 0.12 + 0.88 * smoothstep( 0.2, 0.9, dot( v, normalize( mat3( modelMatrix ) * aDir ) ) ) );
  // Through the haze a light carries farther than a surface shows; through the fog layer, the same.
  float T = pow( 1.0 - smoothstep( fogNear, fogFar * 1.5, dist ), 0.7 );
  if ( fogLayer.y > 0.0 ) {
    float lo = min( cameraPosition.y, wp.y ), hi = max( cameraPosition.y, wp.y );
    float inside = hi - lo > 0.01 ? clamp( ( fogLayer.x - lo ) / ( hi - lo ), 0.0, 1.0 ) : step( lo, fogLayer.x );
    T *= exp( -0.45 * fogLayer.y * dist * inside );
  }
  // The glow's size on screen: never under a couple of pixels (dimmer instead), never a ball in the face.
  float px = aParm.x * uPx / dist, least = kind > 1.5 && kind < 2.5 ? 1.6 * uMin : uMin;
  float a = g * T * max( sqrt( min( 1.0, px / least ) ), 0.16 );
  vCol = vec4( col, min( a, 1.6 ) );
  gl_PointSize = clamp( px, least, min( 44.0, 3.0 * uMin + 2.5 * aParm.x ) );
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
  if ( a < 0.004 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );  // off: not drawn
}`;
const FRAG = `
varying vec4 vCol;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float r = max( 0.0, 1.0 - length( gl_PointCoord - 0.5 ) * 2.0 );
  float a = min( 1.0, 4.0 * r * r * vCol.a );  // solid over the inner half, soft to the edge
  // A white-hot core, the colour round it.
  gl_FragColor = vec4( mix( vCol.rgb, vec3( 1.0 ), 0.5 * smoothstep( 0.6, 1.0, r * a ) ) * a, a * 0.9 );
}`;
function lightMaterial(own) {
  return new THREE.ShaderMaterial({
    uniforms: { ...SHARED, uGain: { value: 1 }, uPapi: { value: 1 }, uOn: { value: new THREE.Vector4(0, 0, 0, 0) }, ...own },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}
// Points from a flat list of lights [x, y, z, r, g, b, dx, dy, dz, size, kind, phase, gain].
const STRIDE = 13;
function pointsFrom(list, material) {
  const n = list.length / STRIDE, pos = new Float32Array(3 * n), col = new Float32Array(3 * n), dir = new Float32Array(3 * n), parm = new Float32Array(4 * n);
  for (let i = 0; i < n; ++i) {
    const k = STRIDE * i;
    pos.set(list.slice(k, k + 3), 3 * i); col.set(list.slice(k + 3, k + 6), 3 * i); dir.set(list.slice(k + 6, k + 9), 3 * i); parm.set(list.slice(k + 9, k + 13), 4 * i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  geo.setAttribute('aParm', new THREE.BufferAttribute(parm, 4));
  geo.computeBoundingSphere();
  const pts = new THREE.Points(geo, material);
  pts.renderOrder = 5;  // after the world's own transparent things
  return pts;
}

// Once a frame: the scale from metres to pixels, the flashers' clock, the haze. dark 0..1.
export function tickLights(camera, renderer, scene, time, dark) {
  const h = renderer.domElement.height;  // drawing-buffer pixels
  SHARED.uPx.value = h / (2 * Math.tan(camera.fov * DEG / 2));
  SHARED.uMin.value = Math.max(2, h / 330);
  SHARED.uTime.value = time % 3600;
  SHARED.uDim.value = 0.6 + 0.4 * dark;
  if (scene.fog) { SHARED.fogNear.value = scene.fog.near; SHARED.fogFar.value = scene.fog.far; }
}

// ---------- Runways ----------
const WHITE = [1, 0.95, 0.84], YELLOW = [1, 0.72, 0.16], RED = [1, 0.1, 0.06], GREEN = [0.12, 1, 0.42];
const GLIDE = 3 * DEG, AIM = 295;  // the flight core's glide path: 3°, to a point 295 m past the threshold
// One airport's lights. `ap`: { elevation, ends: [{ east, north, heading, length, width, displaced }, its reciprocal, ...] } (A.region()).
// Per landing direction: green threshold bar, red end bar, edge lights (red
// before a displaced threshold, yellow over the last 600 m), centreline
// lights on the long runways (red and white over the last 900 m, red over the
// last 300), approach lights with a running flash before them (runway end
// flashers on the short ones), and a PAPI on the left.
function fieldLights(ap, material) {
  const L = [];
  let ce = 0, cn = 0;
  for (const e of ap.ends) { ce += e.east + Math.sin(e.heading * DEG) * e.length / 2; cn += e.north + Math.cos(e.heading * DEG) * e.length / 2; }
  ce /= ap.ends.length; cn /= ap.ends.length;
  for (const e of ap.ends) {
    const h = e.heading * DEG, de = Math.sin(h), dn = Math.cos(h), re = dn, rn = -de, W = e.width, len = e.length, D = e.displaced || 0;
    const big = len >= 1500 && W >= 40;
    // A light `x` m along from this end's paved start, `y` m right of the centreline, `up` m above the runway, seen by traffic landing this way.
    const put = (x, y, up, c, size, kind = 1, phase = 0, gain = 1) => L.push(e.east + de * x + re * y - ce, up, -(e.north + dn * x + rn * y - cn), c[0], c[1], c[2], -de, 0.06, dn, size, kind, phase, gain);
    const nT = Math.max(6, Math.round(W / 3));
    for (let i = 0; i <= nT; ++i) put(D, (i / nT - 0.5) * W, 0.3, GREEN, 4.5);
    for (let i = 0; i <= 7; ++i) put(len, (i / 7 - 0.5) * W, 0.3, RED, 4.5);
    const nE = Math.max(2, Math.round(len / 60)), caution = Math.min(600, len / 2);
    for (let i = 0; i <= nE; ++i) {
      const x = len * i / nE, c = x < D - 1 ? RED : x > len - caution ? YELLOW : WHITE;
      put(x, -(W / 2 + 1.5), 0.35, c, 4); put(x, W / 2 + 1.5, 0.35, c, 4);
    }
    if (big) {
      for (let x = D + 15, i = 0; x < len - 10; x += 30, ++i) { const left = len - x; put(x, 0, 0.12, left < 300 || (left < 900 && i % 2) ? RED : WHITE, 2.4, 1, 0, 0.8); }
      for (let k = 1; k <= 14; ++k) {
        put(D - 30 * k, 0, 0.5, WHITE, 5);
        if (k === 10) for (const y of [-13.5, -9, -4.5, 4.5, 9, 13.5]) put(D - 30 * k, y, 0.5, WHITE, 4);
        if (k >= 5) put(D - 30 * k, 0, 0.6, [0.9, 0.95, 1], 11, 3, (14 - k) / 20, 1.8);
      }
    } else {
      for (const y of [-(W / 2 + 6), W / 2 + 6]) put(D, y, 0.5, [0.9, 0.95, 1], 10, 3, 0, 1.6);
    }
    const aim = D + Math.min(AIM, 0.25 * len);
    for (let i = 0; i < 4; ++i) put(aim, -(W / 2 + 15 + 9 * i), 0.5, WHITE, 8, 2, GLIDE + (1.5 - i) * (1 / 3) * DEG, 1);
  }
  const pts = pointsFrom(L, material);
  pts.position.set(ce, ap.elevation, -cn);
  pts.matrixAutoUpdate = false; pts.updateMatrix();
  return pts;
}
export function buildRunwayLights({ fogLayer }) {
  SHARED.fogLayer.value = fogLayer;
  const group = new THREE.Group(), near = new THREE.Group(), far = new THREE.Group();
  group.name = 'runway lights';
  group.add(near, far);
  const material = lightMaterial();
  const fill = (g, fields) => {
    for (const p of [...g.children]) { p.geometry.dispose(); g.remove(p); }
    for (const ap of fields) if (ap.ends.length) g.add(fieldLights(ap, material));
  };
  // dark 0..1 (the lights come on with the dusk); visibility m (they come on by day too when it closes in).
  // The PAPI is lit by day as well.
  function update(dark, visibility = 1e9) {
    const low = 1 - Math.min(1, Math.max(0, (visibility - 2500) / 5500));
    const g = Math.max(dark, 0.9 * low);
    material.uniforms.uGain.value = g;
    material.uniforms.uPapi.value = Math.max(0.8, g);
  }
  return { group, material, setFields: (fields) => fill(near, fields), setFar: (fields) => fill(far, fields), update };
}

// ---------- Aircraft ----------
// The lights of one aircraft, added to its model (model.root, body axes x
// forward, y left, z up). Where they sit: model.lamps ({ left, right, tail,
// beacons, strobes, landing }: what the model knows) and, for the rest, the
// model's own size. set(flags): LIGHT bits; they flash by the shared clock.
const NAV_RED = [1, 0.08, 0.05], NAV_GREEN = [0.1, 1, 0.3], LAMP = [1, 0.97, 0.9];
export function buildAircraftLights(model) {
  const box = new THREE.Box3().setFromObject(model.root);
  if (model.root.parent) box.applyMatrix4(model.root.matrixWorld.clone().invert());
  const len = box.max.x - box.min.x, half = Math.max(box.max.y, -box.min.y), k = Math.max(0.7, Math.min(2.2, half / 8));  // glows grow with the aircraft
  const lm = model.lamps || {}, at = (v, d) => (v ? (v.isVector3 ? [v.x, v.y, v.z] : v) : d);
  const left = at(lm.left, [box.max.x - 0.45 * len, half, 0.5 * (box.min.z + box.max.z)]), right = at(lm.right, [left[0], -left[1], left[2]]);
  const tail = at(lm.tail, [box.min.x, 0, 0.5 * (box.min.z + box.max.z)]);
  const beacons = (lm.beacons || [[box.min.x + 0.12 * len, 0, box.max.z + 0.05]]).map((v) => at(v));
  const strobes = (lm.strobes || [[left[0] - 0.15, left[1], left[2]], [right[0] - 0.15, right[1], right[2]]]).map((v) => at(v));
  const landing = (lm.landing || [[box.max.x - 0.2 * len, 0, box.min.z + 0.3 * (box.max.z - box.min.z)]]).map((v) => at(v));
  const L = [];
  const put = (p, c, size, kind, phase = 0, gain = 1, d = [0, 0, 0]) => L.push(p[0], p[1], p[2], c[0], c[1], c[2], d[0], d[1], d[2], size * k, kind, phase, gain);
  put(left, NAV_RED, 0.9, 4); put(right, NAV_GREEN, 0.9, 4); put(tail, LAMP, 0.8, 4, 0, 0.8);
  beacons.forEach((p, i) => put(p, NAV_RED, 1.8, 5, i * 0.5, 1.3));
  strobes.forEach((p) => put(p, [0.92, 0.96, 1], 2.6, 6, 0, 1.6));
  put(tail, [0.92, 0.96, 1], 2.2, 6, 0.5, 1.3);
  landing.forEach((p) => put(p, LAMP, 2.4, 7, 0, 1.5, [1, 0, -0.07]));
  const material = lightMaterial();
  const points = pointsFrom(L, material);
  points.frustumCulled = false;  // a handful of points that ride with the aircraft
  model.root.add(points);
  let flags = -1;
  function set(f) {
    if (f === flags) return;
    flags = f;
    material.uniforms.uOn.value.set(f & LIGHT.NAV ? 1 : 0, f & LIGHT.BEACON ? 1 : 0, f & LIGHT.STROBE ? 1 : 0, f & LIGHT.LANDING ? 1 : f & LIGHT.TAXI ? 0.5 : 0);
    points.visible = f !== 0;
  }
  set(0);
  return { points, set, landingAt: landing[0], dispose: () => { model.root.remove(points); points.geometry.dispose(); material.dispose(); } };
}

// The player's landing light: one spot light, down the approach path ahead
// of the nose. It is in the scene only while it is lit (a light that is off
// still costs every lit surface its arithmetic), so the first night landing
// compiles the shaders' spot-light variants once (warm()).
export function buildLandingLight() {
  const holder = new THREE.Group();
  const spot = new THREE.SpotLight(0xfff0d8, 0, 800, 15 * DEG, 0.75, 1);
  spot.target.position.set(40, 0, -4);  // 6° below the nose
  holder.add(spot, spot.target);
  spot.visible = false;
  let level = 0;
  // root: the aircraft model's root; at: where the lamp is (body axes).
  function attach(root, at) { root.add(holder); holder.position.set(at[0] + 1.5, at[1], at[2]); }
  // level 0 off, 0.5 the taxi light, 1 the landing light.
  function set(l) {
    if (l === level) return;
    level = l;
    spot.visible = l > 0;
    spot.intensity = 3200 * l;
  }
  // Compile the lit variant ahead of need (the page calls this once it is dark, from a menu rather than on short final).
  function warm(renderer, scene, camera) {
    if (spot.visible) return;
    spot.visible = true;
    renderer.compile(scene, camera);
    spot.visible = false;
  }
  return { holder, spot, attach, set, warm };
}
