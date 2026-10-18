// São Paulo World · flight test bed: smoke trails, as an airshow or a smoke
// tunnel shows the air.
//
// Smoke is released from the aircraft (wingtip generators, a rake along the
// wing's trailing edge, and the engines' exhaust) and then belongs to the air:
// it never follows the aircraft again. Every particle is moved on the GPU
// through the velocity field the flight core says is there:
//
//   - the wake (avd_wake): the bound vortices of the lift and every vortex the
//     wing has shed since, rolling up into the tip-vortex pair, sinking,
//     spreading over the ground and decaying (Biot-Savart with Lamb-Oseen
//     cores, the same segments the core uses for wake encounters);
//   - the wind (avd_wind_box): the core's weather sampled on a grid around
//     the aircraft (shear, turbulence, thermals, microbursts), with a small
//     divergence-free (ABC-flow) stir below the grid scale;
//   - the propeller slipstream and jet exhaust (momentum theory, avd_flow);
//   - the wakes of the extended gear and raised spoilers (avd_bodies): the
//     air each drags along, carrying exactly its drag, and the Karman street
//     it sheds (St 0.2). Smoke from the wheels shows them.
//
// So the trailing-edge sheet visibly winds itself into the tip vortices, the
// pair drifts down and away with the wind, a gust tears the trails, and a
// steep turn puts you back into your own smoke. Particles live in a pair of
// float textures (ping-pong); positions are kept relative to a floating
// origin so float32 stays exact to millimetres. Needs WebGL2 with float
// render targets; without them, smoke reports itself unavailable.
import * as THREE from 'three';

const STRIDE = 18;
const MAX_EMIT = 32;
const MAX_BODY = 16;

const SIM_VERT = /* glsl */ `
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const SIM_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 outState;
uniform sampler2D uState;
uniform sampler2D uSeg;      // 2 texels a segment: (a.xyz, gamma), (b.xyz, core)
uniform int uNSeg;
uniform sampler2D uWind;     // nx by (ny * nz): wind (three axes) at the grid nodes
uniform ivec3 uWindN;
uniform vec3 uWindLo, uWindSize;
uniform bool uHasWind;
uniform vec3 uWind0;         // wind at the aircraft (outside the grid)
uniform float uDt;
uniform int uSub;
uniform float uTime;
uniform vec3 uShift;         // origin moved: add to every position
uniform int uSpawnStart, uSpawnCount, uN;
uniform ivec2 uSize;
uniform vec4 uEmitA[${MAX_EMIT}];  // previous position, jitter radius
uniform vec4 uEmitB[${MAX_EMIT}];  // current position, kind
uniform float uEmitCum[${MAX_EMIT}];
uniform int uNEmit;
uniform vec4 uJetP[4];       // nozzle / disc centre, radius
uniform vec4 uJetA[4];       // axis (thrust direction), velocity increment
uniform float uJetK[4];      // 1 jet, 0 propeller
uniform int uNJet;
uniform vec4 uBodyP[${MAX_BODY}];  // centre, diameter
uniform vec4 uBodyA[${MAX_BODY}];  // axis square to the flight path, half length
uniform vec4 uBodyN[${MAX_BODY}];  // lateral (across axis and path), drag area per length
uniform int uNBody;
uniform vec4 uFlight;        // direction of flight through the air, airspeed
uniform float uNoise;
uniform float uGround;
uniform bool uClear;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

vec3 windAt(vec3 p) {
  if (!uHasWind) return uWind0;
  vec3 f = clamp((p - uWindLo) / uWindSize, 0.0, 1.0) * vec3(uWindN - 1);
  ivec3 i = min(ivec3(f), uWindN - 2);
  vec3 t = f - vec3(i);
  vec3 w = vec3(0.0);
  for (int c = 0; c < 8; ++c) {
    ivec3 d = ivec3(c & 1, (c >> 1) & 1, c >> 2);
    vec3 wt = mix(1.0 - t, t, vec3(d));
    ivec3 q = i + d;
    w += wt.x * wt.y * wt.z * texelFetch(uWind, ivec2(q.x, q.y + q.z * uWindN.y), 0).xyz;
  }
  return w;
}

// Arnold-Beltrami-Childress flow: divergence free, at two scales, drifting.
vec3 abc(vec3 p, float k, float t) {
  vec3 q = p * k + vec3(t * 0.31, t * 0.23, t * 0.17);
  return vec3(sin(q.z) + cos(q.y), sin(q.x) + cos(q.z), sin(q.y) + cos(q.x));
}

vec3 velocity(vec3 p) {
  vec3 v = windAt(p);
  for (int k = 0; k < uNSeg; ++k) {
    vec4 A = texelFetch(uSeg, ivec2(2 * k, 0), 0);
    vec4 B = texelFetch(uSeg, ivec2(2 * k + 1, 0), 0);
    vec3 r0 = B.xyz - A.xyz, r1 = p - A.xyz, r2 = p - B.xyz;
    vec3 c = cross(r1, r2);
    float c2 = dot(c, c), l2 = dot(r0, r0);
    float n1 = length(r1), n2 = length(r2);
    if (c2 < 1e-10 * l2 || n1 < 1e-4 || n2 < 1e-4) continue;
    float h2 = c2 / l2;
    float core = 1.0 - exp(-1.25643 * h2 / (B.w * B.w));
    v += c * (A.w / (12.566371 * c2) * dot(r0, r1 / n1 - r2 / n2) * core);
  }
  for (int j = 0; j < uNJet; ++j) {
    vec3 d = p - uJetP[j].xyz;
    vec3 ax = uJetA[j].xyz;
    float along = -dot(d, ax);
    if (along < -0.2) continue;
    float r = length(d + along * ax), R0 = uJetP[j].w;
    float R = uJetK[j] > 0.5 ? R0 * (1.0 + 0.08 * along / R0) : R0 * (0.82 + 0.18 * exp(-along / R0));
    if (r > 1.3 * R) continue;
    float decay = uJetK[j] > 0.5 ? (R0 / R) * (R0 / R) : exp(-along / (40.0 * R0));
    float prof = max(0.0, 1.0 - pow(r / (1.3 * R), 4.0));
    v -= ax * (uJetA[j].w * decay * prof);
  }
  for (int b = 0; b < uNBody; ++b) {
    // In the air's frame the wake is air dragged along behind the body: a
    // Gaussian of half width d/2 (1 + 0.4 sqrt(x/d)) whose momentum is the
    // body's drag, and the Karman street's lateral velocity convecting at
    // 0.85 U relative to the body.
    vec3 d = p - uBodyP[b].xyz;
    float D = uBodyP[b].w, U = uFlight.w;
    float xd = -dot(d, uFlight.xyz);
    if (xd < -0.3 * D || xd > 80.0 * D) continue;
    float xs = max(xd, 0.0);
    float sg = 0.5 * D * (1.0 + 0.4 * sqrt(xs / D));
    float over = max(0.0, abs(dot(d, uBodyA[b].xyz)) - uBodyA[b].w);
    float eta = dot(d, uBodyN[b].xyz);
    float g = exp(-(eta * eta + over * over) / (2.0 * sg * sg));
    float ramp = clamp((xd + 0.3 * D) / (0.6 * D), 0.0, 1.0);
    float umax = min(0.8, uBodyN[b].w / (5.0132565 * sg)) * U;
    v += uFlight.xyz * (umax * g * ramp);
    float k = 6.2831853 * 0.2 / (0.85 * D);
    float fade = exp(-xs / (40.0 * D)) * min(1.0, xs / D);
    v += uBodyN[b].xyz * (0.35 * umax * fade * g * sin(k * (xs - 0.85 * U * uTime) + float(b) * 1.3));
  }
  v += uNoise * (0.65 * abc(p, 0.9, uTime) + 0.35 * abc(p, 0.16, uTime * 0.5));
  return v;
}

void main() {
  if (uClear) { outState = vec4(0.0, 0.0, 0.0, -1.0); return; }
  ivec2 ij = ivec2(gl_FragCoord.xy);
  int id = ij.x + ij.y * uSize.x;
  vec4 s = texelFetch(uState, ij, 0);
  // Newborn: on its emitter, somewhere along the emitter's path this frame.
  int k = (id - uSpawnStart + uN) % uN;
  if (k < uSpawnCount) {
    float fr = (float(k) + 0.5) / float(uSpawnCount);
    // Golden-ratio sequence: each emitter's share spread evenly along the path.
    float pick = fract(float(k) * 0.6180339887 + fract(uTime * 7.31));
    int e = 0;
    for (int m = 0; m < ${MAX_EMIT}; ++m) { if (m >= uNEmit - 1 || pick < uEmitCum[m]) break; e = m + 1; }
    vec3 p = mix(uEmitA[e].xyz, uEmitB[e].xyz, fr);
    vec3 j = vec3(hash(float(id) + 0.1), hash(float(id) + 0.2), hash(float(id) + 0.3)) * 2.0 - 1.0;
    p += j * uEmitA[e].w;
    outState = vec4(p, uEmitB[e].w * 1000.0 + (1.0 - fr) * uDt);
    return;
  }
  if (s.w < 0.0) { outState = s; return; }
  vec3 p = s.xyz + uShift;
  float h = uDt / float(uSub);
  for (int n = 0; n < 3; ++n) {
    if (n >= uSub) break;
    vec3 v1 = velocity(p);
    vec3 v2 = velocity(p + 0.5 * h * v1);
    p += h * v2;
  }
  p.y = max(p.y, uGround + 0.05);
  outState = vec4(p, s.w + uDt);
}`;

const DRAW_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 ref;
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D uState;
uniform vec3 uOrigin;
uniform float uScale, uLife;
uniform vec3 uCol[3];
uniform float uAlpha[3], uSize0[3], uGrow[3];
out vec4 vCol;
void main() {
  vec4 s = texture(uState, ref);
  if (s.w < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec4(0.0); return; }
  int kind = int(floor(s.w / 1000.0));
  float age = s.w - float(kind) * 1000.0;
  vec4 mv = modelViewMatrix * vec4(s.xyz + uOrigin, 1.0);
  float size = uSize0[kind] + uGrow[kind] * sqrt(age);
  gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 72.0);
  float fade = (1.0 - smoothstep(0.55 * uLife, uLife, age)) * min(1.0, age * 10.0);
  // Thinning as it spreads: the same smoke over a larger volume.
  float thin = uSize0[kind] / size;
  vCol = vec4(uCol[kind], uAlpha[kind] * fade * (0.35 + 0.65 * thin));
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const DRAW_FRAG = /* glsl */ `
precision highp float;
in vec4 vCol;
out vec4 outColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  outColor = vec4(vCol.rgb, vCol.a * exp(-3.0 * r2));
}`;

export function buildSmoke({ renderer, mobile }) {
  const gl = renderer.getContext();
  const ok = renderer.capabilities.isWebGL2 && !!gl.getExtension('EXT_color_buffer_float');
  const SX = mobile ? 96 : 192, SY = mobile ? 64 : 128, N = SX * SY;
  const NSEG = mobile ? 160 : 320;
  const LIFE = mobile ? 20 : 40;
  const group = new THREE.Group();
  group.visible = false;
  if (!ok) return { ok, group, update() {}, reset() {} };

  const rtOpts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false };
  const rt = [new THREE.WebGLRenderTarget(SX, SY, rtOpts), new THREE.WebGLRenderTarget(SX, SY, rtOpts)];
  let cur = 0;

  const segData = new Float32Array(NSEG * 2 * 4);
  const segTex = new THREE.DataTexture(segData, NSEG * 2, 1, THREE.RGBAFormat, THREE.FloatType);
  segTex.needsUpdate = true;
  let windTex = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);

  const emitA = Array.from({ length: MAX_EMIT }, () => new THREE.Vector4());
  const emitB = Array.from({ length: MAX_EMIT }, () => new THREE.Vector4());
  const jetP = Array.from({ length: 4 }, () => new THREE.Vector4()), jetA = Array.from({ length: 4 }, () => new THREE.Vector4());
  const vec4s = (n) => Array.from({ length: n }, () => new THREE.Vector4());
  const bodyP = vec4s(MAX_BODY), bodyA = vec4s(MAX_BODY), bodyN = vec4s(MAX_BODY);
  const simMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: SIM_VERT, fragmentShader: SIM_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      uState: { value: null }, uSeg: { value: segTex }, uNSeg: { value: 0 },
      uWind: { value: windTex }, uWindN: { value: [2, 2, 2] }, uWindLo: { value: new THREE.Vector3() }, uWindSize: { value: new THREE.Vector3(1, 1, 1) },
      uHasWind: { value: false }, uWind0: { value: new THREE.Vector3() },
      uDt: { value: 0 }, uSub: { value: 1 }, uTime: { value: 0 }, uShift: { value: new THREE.Vector3() },
      uSpawnStart: { value: 0 }, uSpawnCount: { value: 0 }, uN: { value: N }, uSize: { value: [SX, SY] },
      uEmitA: { value: emitA }, uEmitB: { value: emitB }, uEmitCum: { value: new Array(MAX_EMIT).fill(1) }, uNEmit: { value: 0 },
      uJetP: { value: jetP }, uJetA: { value: jetA }, uJetK: { value: [0, 0, 0, 0] }, uNJet: { value: 0 },
      uBodyP: { value: bodyP }, uBodyA: { value: bodyA }, uBodyN: { value: bodyN }, uNBody: { value: 0 }, uFlight: { value: new THREE.Vector4() },
      uNoise: { value: 0.15 }, uGround: { value: -1e9 }, uClear: { value: false },
    },
  });
  const simScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMat);
  quad.frustumCulled = false;
  simScene.add(quad);
  const simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Drawn as one point per particle.
  const ref = new Float32Array(N * 2);
  for (let i = 0; i < N; ++i) { ref[2 * i] = ((i % SX) + 0.5) / SX; ref[2 * i + 1] = (Math.floor(i / SX) + 0.5) / SY; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('ref', new THREE.BufferAttribute(ref, 2));
  const drawMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: DRAW_VERT, fragmentShader: DRAW_FRAG,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    uniforms: {
      uState: { value: null }, uOrigin: { value: new THREE.Vector3() }, uScale: { value: 600 }, uLife: { value: LIFE },
      uCol: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
      uAlpha: { value: [0.34, 0.2, 0.22] }, uSize0: { value: [0.8, 0.5, 1.0] }, uGrow: { value: [0.35, 0.25, 0.5] },
    },
  });
  const points = new THREE.Points(geo, drawMat);
  points.frustumCulled = false;
  points.renderOrder = 4;
  group.add(points);

  const origin = new THREE.Vector3();
  let haveOrigin = false, head = 0, carry = 0, clockT = 0, windAge = 1e9, cleared = false;
  let windBox = null;

  function clear() {
    // Every particle dead (age < 0).
    simMat.uniforms.uClear.value = true;
    for (const r of rt) { renderer.setRenderTarget(r); renderer.render(simScene, simCam); }
    renderer.setRenderTarget(null);
    simMat.uniforms.uClear.value = false;
    head = 0; carry = 0; cleared = true;
  }

  const v = new THREE.Vector3(), w = new THREE.Vector3();
  const lastEmit = [];
  // ENU (e, n, u) to three (e, u, -n), relative to the origin.
  const three = (e, n, u, out) => out.set(e - origin.x, u - origin.y, -n - origin.z);

  // f: avd_flow(); acGroup: the aircraft (structural x, -y, -z in its frame);
  // wake: A.wake(); windBox(c, h, nx, ny, nz): A.windBox; s: avd_state;
  // opts: { light, turbulence (m/s RMS), camera, bodies: A.bodies() }.
  function update(f, dt, acGroup, wake, windBoxFn, s, opts = {}) {
    if (!cleared) clear();
    clockT += dt;
    const sx = (x, y, z, out) => acGroup.localToWorld(out.set(x, -y, -z));
    // Floating origin: snapped to 512 m around the aircraft.
    acGroup.getWorldPosition(v);
    const snap = (a) => Math.round(a / 512) * 512;
    const shift = simMat.uniforms.uShift.value.set(0, 0, 0);
    if (!haveOrigin) { origin.set(snap(v.x), snap(v.y), snap(v.z)); haveOrigin = true; }
    else if (Math.abs(v.x - origin.x) > 400 || Math.abs(v.y - origin.y) > 400 || Math.abs(v.z - origin.z) > 400) {
      const o2 = new THREE.Vector3(snap(v.x), snap(v.y), snap(v.z));
      shift.copy(origin).sub(o2);
      origin.copy(o2);
      for (const e of lastEmit) e.add(shift);
    }

    // Emitters (structural frame -> world -> origin frame).
    const n = f[0] | 0;
    const tips = [], sheet = [];
    for (let i = 0; i < n; ++i) {
      const o = 16 + i * STRIDE;
      if (f[o + 15] !== 0) continue;  // the main wing
      const S = [f[o + 3], f[o + 4], f[o + 5]], Nn = [f[o + 6], f[o + 7], f[o + 8]];
      const c = f[o + 9], b = f[o + 10] / Math.max(c, 1e-3);
      let C = [S[1] * Nn[2] - S[2] * Nn[1], S[2] * Nn[0] - S[0] * Nn[2], S[0] * Nn[1] - S[1] * Nn[0]];
      if (C[0] < 0) C = C.map((x) => -x);
      const te = (k) => [0, 1, 2].map((j) => f[o + j] + S[j] * k * b * 0.5 - C[j] * 0.75 * c);
      sheet.push(te(0));
      tips.push(te(-1), te(1));
    }
    tips.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const tipL = tips.find((p) => p[1] < 0), tipR = tips.find((p) => p[1] > 0);
    const emit = [];
    if (tipL && tipR) { emit.push([tipL, 0.12, 0, 2.5]); emit.push([tipR, 0.12, 0, 2.5]); }
    sheet.sort((a, b) => a[1] - b[1]);
    const step = Math.max(1, Math.floor(sheet.length / (mobile ? 8 : 14)));
    for (let i = 0; i < sheet.length; i += step) emit.push([sheet[i], 0.08, 1, 3.5 / Math.ceil(sheet.length / step)]);
    // Engines.
    const e0 = 16 + 64 * STRIDE;
    let nj = 0;
    for (let k = 0; k < (f[1] | 0) && nj < 4; ++k) {
      const o = e0 + k * 10;
      if (f[o + 8] <= 50) continue;  // not producing thrust
      const jet = f[o + 9] > 0.5;
      emit.push([[f[o], f[o + 1], f[o + 2]], f[o + 6] * (jet ? 0.5 : 0.25), 2, jet ? 1.6 : 1.0]);
      sx(f[o], f[o + 1], f[o + 2], w);
      jetP[nj].set(w.x - origin.x, w.y - origin.y, w.z - origin.z, f[o + 6]);
      // Axis: a structural direction, rotated with the aircraft.
      v.set(f[o + 3], -f[o + 4], -f[o + 5]).applyQuaternion(acGroup.getWorldQuaternion(new THREE.Quaternion()));
      jetA[nj].set(v.x, v.y, v.z, f[o + 7]);
      simMat.uniforms.uJetK.value[nj] = jet ? 1 : 0;
      ++nj;
    }
    simMat.uniforms.uNJet.value = nj;
    // Bluff bodies: into the world (origin frame), the axis made square to
    // the flight path. Smoke from each wheel, and from every other spoiler.
    const qa = acGroup.getWorldQuaternion(new THREE.Quaternion());
    const tas = f[2], al = f[3], be = f[4];
    const F = new THREE.Vector3(Math.cos(al) * Math.cos(be), -Math.sin(be), -Math.sin(al) * Math.cos(be)).applyQuaternion(qa);
    simMat.uniforms.uFlight.value.set(F.x, F.y, F.z, tas);
    let nb = 0, nsp = 0;
    const bd = opts.bodies;
    for (let k = 0; bd && k < bd.n && nb < MAX_BODY && tas > 3; ++k) {
      const o = k * 10, B = bd.b;
      if (B[o + 8] <= 0) continue;
      const a = v.set(B[o + 3], -B[o + 4], -B[o + 5]).applyQuaternion(qa);
      a.addScaledVector(F, -a.dot(F));
      const am = a.length();
      if (am < 0.2) continue;
      a.divideScalar(am);
      const len = Math.max(B[o + 7], 0.05) * am;
      sx(B[o], B[o + 1], B[o + 2], w);
      bodyP[nb].set(w.x - origin.x, w.y - origin.y, w.z - origin.z, Math.max(B[o + 6], 0.05));
      bodyA[nb].set(a.x, a.y, a.z, 0.5 * len);
      const lat = new THREE.Vector3().crossVectors(F, a).normalize();
      bodyN[nb].set(lat.x, lat.y, lat.z, B[o + 8] / len);
      ++nb;
      // The emitter: the wheel (the leg's lower end) or the panel's top edge.
      const kind = B[o + 9] | 0;
      if (kind === 1 && nsp++ % 2) continue;
      const end = kind === 0 ? 0.4 * B[o + 7] : 0;
      emit.push([[B[o] + B[o + 3] * end, B[o + 1] + B[o + 4] * end, B[o + 2] + B[o + 5] * end], 0.25 * B[o + 6], 1, 0.35]);
    }
    simMat.uniforms.uNBody.value = nb;
    const ne = Math.min(emit.length, MAX_EMIT);
    let tot = 0;
    for (let i = 0; i < ne; ++i) tot += emit[i][3];
    let cum = 0;
    for (let i = 0; i < ne; ++i) {
      const [p, r, kind, wt] = emit[i];
      sx(p[0], p[1], p[2], w).sub(origin);
      const prev = lastEmit[i] && lastEmit[i].distanceTo(w) < 60 ? lastEmit[i] : w;
      emitA[i].set(prev.x, prev.y, prev.z, r);
      emitB[i].set(w.x, w.y, w.z, kind);
      cum += wt / tot;
      simMat.uniforms.uEmitCum.value[i] = cum;
      (lastEmit[i] ||= new THREE.Vector3()).copy(w);
    }
    lastEmit.length = ne;
    simMat.uniforms.uNEmit.value = ne;

    // Wake segments: the strongest, the nearest-in-time first.
    const nW = wake.n;
    let ns = 0;
    if (nW > 0) {
      // Segments of negligible circulation (the shed vorticity of steady
      // flight) are left out; past the budget, the strongest and youngest stay.
      const sg = wake.seg, tiny = 0.004 * wake.gmax;
      let order = [];
      for (let k = 0; k < nW; ++k) if (Math.abs(sg[k * 9 + 6]) > tiny) order.push(k);
      if (order.length > NSEG) {
        const pri = new Float32Array(nW);
        for (const k of order) {
          const o = k * 9;
          const len = Math.hypot(sg[o + 3] - sg[o], sg[o + 4] - sg[o + 1], sg[o + 5] - sg[o + 2]);
          pri[k] = Math.abs(sg[o + 6]) * Math.min(len, 12) / (1 + sg[o + 8] / 30);
        }
        order = order.sort((a, b) => pri[b] - pri[a]).slice(0, NSEG);
      }
      for (let q = 0; q < order.length; ++q) {
        const o = order[q] * 9;
        three(sg[o], sg[o + 1], sg[o + 2], v);
        three(sg[o + 3], sg[o + 4], sg[o + 5], w);
        segData.set([v.x, v.y, v.z, sg[o + 6], w.x, w.y, w.z, Math.max(sg[o + 7], 0.05)], ns * 8);
        ++ns;
      }
      segTex.needsUpdate = true;
    }
    simMat.uniforms.uNSeg.value = ns;
    simMat.uniforms.uGround.value = wake.ground > -1e8 ? wake.ground - origin.y : -1e9;

    // The weather around the aircraft, twice a second.
    windAge += dt;
    if (windBoxFn && windAge > 0.5) {
      windAge = 0;
      const [nx, ny, nz] = mobile ? [10, 10, 4] : [16, 16, 6];
      const H = [1500, 1500, 300];
      const c = [s[0], s[1], s[2]];
      const box = windBoxFn(c, H, nx, ny, nz);
      // Texel (i, k + nz * jj): i east, k up, jj north to south (three z
      // increases southward); the value in three axes (east, up, -north).
      const data = new Float32Array(nx * ny * nz * 4);
      for (let k = 0; k < nz; ++k)
        for (let j = 0; j < ny; ++j)
          for (let i = 0; i < nx; ++i) {
            const src = 3 * (i + nx * (j + ny * k));
            const dst = 4 * (i + nx * (k + nz * (ny - 1 - j)));
            data[dst] = box[src]; data[dst + 1] = box[src + 2]; data[dst + 2] = -box[src + 1];
          }
      windTex.dispose();
      windTex = new THREE.DataTexture(data, nx, nz * ny, THREE.RGBAFormat, THREE.FloatType);
      windTex.needsUpdate = true;
      simMat.uniforms.uWind.value = windTex;
      simMat.uniforms.uWindN.value = [nx, nz, ny];
      // Low corner (three axes): east - H, up - H, -(north + H).
      three(c[0] - H[0], c[1] + H[1], c[2] - H[2], v);
      simMat.uniforms.uWindLo.value.copy(v);
      simMat.uniforms.uWindSize.value.set(2 * H[0], 2 * H[2], 2 * H[1]);
      simMat.uniforms.uHasWind.value = true;
      windBox = { c, H };
    }
    if (windBox) {
      // The low corner moves with the origin.
      three(windBox.c[0] - windBox.H[0], windBox.c[1] + windBox.H[1], windBox.c[2] - windBox.H[2], simMat.uniforms.uWindLo.value);
    }
    simMat.uniforms.uNoise.value = 0.12 + 0.25 * (opts.turbulence || 0);

    // Spawn and advect.
    const want = N * dt / LIFE + carry;
    const count = Math.min(Math.floor(want), N);
    carry = want - count;
    const u = simMat.uniforms;
    u.uSpawnStart.value = head; u.uSpawnCount.value = ne ? count : 0;
    head = (head + (ne ? count : 0)) % N;
    u.uDt.value = dt; u.uSub.value = dt > 0.025 ? Math.min(3, Math.ceil(dt / 0.02)) : 1; u.uTime.value = clockT;
    if (dt > 0 || shift.lengthSq() > 0) {
      u.uState.value = rt[cur].texture;
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(rt[1 - cur]);
      renderer.render(simScene, simCam);
      renderer.setRenderTarget(prevTarget);
      cur = 1 - cur;
    }

    // Draw.
    drawMat.uniforms.uState.value = rt[cur].texture;
    drawMat.uniforms.uOrigin.value.copy(origin);
    const cam = opts.camera;
    if (cam) drawMat.uniforms.uScale.value = renderer.getDrawingBufferSize(v).y / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const col = drawMat.uniforms.uCol.value;
    if (opts.light) { col[0].setRGB(0.1, 0.25, 0.75); col[1].setRGB(0.05, 0.5, 0.55); col[2].setRGB(0.3, 0.3, 0.32); }
    else { col[0].setRGB(0.97, 0.97, 0.98); col[1].setRGB(0.72, 0.88, 1.0); col[2].setRGB(0.62, 0.6, 0.58); }
  }
  function reset() { cleared = false; haveOrigin = false; lastEmit.length = 0; windAge = 1e9; windBox = null; }
  return { ok, group, update, reset };
}
