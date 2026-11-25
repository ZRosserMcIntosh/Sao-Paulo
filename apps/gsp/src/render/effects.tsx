'use client';
// Tyre smoke, red-clay dust, sparks, engine smoke, skid marks, rain and puddles. All driven by
// what the physics reports (wheel slip and surface, impacts, damage), never by canned animations.
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Simulation, ImpactEvent } from '../sim/Simulation';
import { SURF } from '../sim/world/terrain';
import { qrot } from '../sim/math';

const N = 5000;

const vert = /* glsl */ `
attribute float size; attribute float alpha; attribute vec3 tint;
varying float vAlpha; varying vec3 vTint;
void main() {
  vAlpha = alpha; vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (420.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const frag = /* glsl */ `
varying float vAlpha; varying vec3 vTint;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float a = vAlpha * (1.0 - smoothstep(0.15, 0.5, r));
  gl_FragColor = vec4(vTint * a, a);
}`;

class Particles {
  pos = new Float32Array(N * 3); vel = new Float32Array(N * 3); size = new Float32Array(N); alpha = new Float32Array(N); tint = new Float32Array(N * 3);
  life = new Float32Array(N); max = new Float32Array(N); grow = new Float32Array(N); a0 = new Float32Array(N); drag = new Float32Array(N); grav = new Float32Array(N);
  head = 0;
  geo = new THREE.BufferGeometry();
  points: THREE.Points;
  constructor(additive: boolean) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, premultipliedAlpha: true, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.points = new THREE.Points(this.geo, m);
    this.points.frustumCulled = false;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grow: number, life: number, alpha: number, r: number, g: number, b: number, drag = 1.5, grav = 0) {
    const i = this.head; this.head = (this.head + 1) % N;
    this.pos[3 * i] = x; this.pos[3 * i + 1] = y; this.pos[3 * i + 2] = z;
    this.vel[3 * i] = vx; this.vel[3 * i + 1] = vy; this.vel[3 * i + 2] = vz;
    this.size[i] = size; this.grow[i] = grow; this.life[i] = life; this.max[i] = life; this.a0[i] = alpha; this.alpha[i] = alpha;
    this.tint[3 * i] = r; this.tint[3 * i + 1] = g; this.tint[3 * i + 2] = b; this.drag[i] = drag; this.grav[i] = grav;
  }
  update(dt: number) {
    for (let i = 0; i < N; ++i) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[3 * i] *= k; this.vel[3 * i + 1] = this.vel[3 * i + 1] * k - this.grav[i] * dt; this.vel[3 * i + 2] *= k;
      this.pos[3 * i] += this.vel[3 * i] * dt; this.pos[3 * i + 1] += this.vel[3 * i + 1] * dt; this.pos[3 * i + 2] += this.vel[3 * i + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.max[i];
      this.alpha[i] = this.a0[i] * Math.min(1, t * 2.5) * Math.min(1, (1 - t) * 8 + 0.2);
    }
    for (const a of ['position', 'size', 'alpha', 'tint']) (this.geo.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
  }
}

// Skid marks: dark quads laid where a sliding tyre was, recycled oldest-first.
class Skids {
  readonly cap = 4000;
  mesh: THREE.InstancedMesh;
  head = 0;
  last = new Map<string, THREE.Vector3>();
  dark = new THREE.Color('#0b0b0b');
  m = new THREE.Matrix4(); q = new THREE.Quaternion(); s = new THREE.Vector3(); p = new THREE.Vector3();
  constructor() {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.mesh = new THREE.InstancedMesh(g, mat, this.cap);
    this.mesh.frustumCulled = false;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < this.cap; ++i) this.mesh.setMatrixAt(i, this.m);
    this.mesh.renderOrder = 1;
  }
  add(key: string, x: number, y: number, z: number, width: number, on: boolean, tint?: THREE.Color) {
    const prev = this.last.get(key);
    const cur = new THREE.Vector3(x, y + 0.06, z);
    if (!on) { this.last.delete(key); return; }
    if (!prev) { this.last.set(key, cur); return; }
    const d = cur.distanceTo(prev);
    if (d < 0.35) return;
    if (d > 4) { this.last.set(key, cur); return; }
    this.p.copy(prev).add(cur).multiplyScalar(0.5);
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-(cur.z - prev.z), cur.x - prev.x));
    this.s.set(d + 0.05, 1, width);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.head, this.m);
    this.mesh.setColorAt(this.head, tint ?? this.dark);
    this.head = (this.head + 1) % this.cap;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.last.set(key, cur);
  }
  clear() { this.m.makeScale(0, 0, 0); for (let i = 0; i < this.cap; ++i) this.mesh.setMatrixAt(i, this.m); this.mesh.instanceMatrix.needsUpdate = true; this.last.clear(); }
}

export function Effects({ sim, rainCount, version }: { sim: Simulation; rainCount: number; version: number }) {
  const { scene, camera } = useThree();
  const smoke = useMemo(() => new Particles(false), []);
  const sparks = useMemo(() => new Particles(true), []);
  const skids = useMemo(() => new Skids(), []);
  const rain = useMemo(() => {
    const n = rainCount;
    const pos = new Float32Array(n * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#aebccb', transparent: true, opacity: 0.38, depthWrite: false }));
    m.frustumCulled = false;
    const seeds = new Float32Array(n * 3);
    for (let i = 0; i < n; ++i) { seeds[3 * i] = Math.random(); seeds[3 * i + 1] = Math.random(); seeds[3 * i + 2] = Math.random(); }
    return { mesh: m, seeds, n };
  }, [rainCount]);
  const puddles = useMemo(() => {
    const g = new THREE.CircleGeometry(1, 20);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: '#2a3138', roughness: 0.02, metalness: 0.9, transparent: true, opacity: 0.75, polygonOffset: true, polygonOffsetFactor: -3 }), 256);
    m.count = 0;
    m.frustumCulled = false;
    return m;
  }, []);
  useEffect(() => {
    scene.add(smoke.points, sparks.points, skids.mesh, rain.mesh, puddles);
    return () => { scene.remove(smoke.points, sparks.points, skids.mesh, rain.mesh, puddles); };
  }, [scene, smoke, sparks, skids, rain, puddles]);
  useEffect(() => { skids.clear(); }, [sim.scenario, skids, version]);
  useEffect(() => sim.onImpact((e: ImpactEvent) => {
    const n = Math.round(10 + e.strength * 60);
    if (e.kind === 'metal' || e.kind === 'car' || e.kind === 'scrape') {
      for (let i = 0; i < n; ++i) sparks.emit(e.x, e.y, e.z, (Math.random() - 0.5) * 9, Math.random() * 5, (Math.random() - 0.5) * 9, 0.08, -0.05, 0.25 + Math.random() * 0.4, 1, 1, 0.65 + Math.random() * 0.2, 0.25, 0.6, 9.8);
    }
    if (e.kind === 'glass') for (let i = 0; i < 24; ++i) sparks.emit(e.x, e.y, e.z, (Math.random() - 0.5) * 5, Math.random() * 3, (Math.random() - 0.5) * 5, 0.05, 0, 0.5, 0.8, 0.8, 0.9, 1, 0.3, 9.8);
    if (e.kind !== 'glass' && e.strength > 0.25) for (let i = 0; i < 3 + e.strength * 8; ++i) smoke.emit(e.x, e.y, e.z, (Math.random() - 0.5) * 3, Math.random() * 1.2, (Math.random() - 0.5) * 3, 0.4, 0.9, 0.9, 0.22, 0.55, 0.53, 0.5);
  }), [sim, sparks, smoke]);

  const puddleTimer = useRef(0);
  const clay = useMemo(() => new THREE.Color('#5a2a18'), []);
  useFrame((_, rdt) => {
    const live = !sim.paused && !sim.replayState.active;
    const dt = live ? rdt * (sim.slowmo ? sim.slowmoScale : 1) : 0;
    if (live) {
      for (const v of sim.vehicles) {
        const spd = Math.hypot(v.v.x, v.v.z);
        v.wheels.forEach((w, k) => {
          const wp = v.toWorld({ x: w.x, y: w.y - w.radius, z: w.z });
          const slipping = w.contact && (Math.abs(w.slipRatio) > 0.18 || Math.abs(w.slipAngle) > 0.14) && (spd > 2.5 || Math.abs(w.slipRatio) > 0.4);
          const paved = w.surface === SURF.ASPHALT || w.surface === SURF.SHOULDER || w.surface === SURF.CONCRETE || w.surface === SURF.PAD || w.surface === SURF.DECK || w.surface === SURF.COUNTY;
          const loose = !paved && w.surface !== SURF.PUDDLE;
          const intensity = Math.min(1, (Math.max(Math.abs(w.slipRatio) - 0.12, 0) * 2 + Math.max(Math.abs(w.slipAngle) - 0.1, 0) * 3)) * Math.min(1, spd / 8 + 0.3);
          skids.add(`${v.id}:${k}`, wp.x, wp.y, wp.z, 0.24, slipping && (paved || loose) && w.load > 1500, loose ? clay : undefined);
          if (slipping && Math.random() < dt * 60 * (0.4 + intensity)) {
            const wet = sim.weather.rain > 0.2 && paved;
            if (loose) smoke.emit(wp.x, wp.y + 0.2, wp.z, v.v.x * 0.3 + (Math.random() - 0.5) * 2, 0.8 + Math.random(), v.v.z * 0.3 + (Math.random() - 0.5) * 2, 0.7, 2.6, 1.8, 0.5, w.surface === SURF.CLAY ? 0.62 : 0.52, w.surface === SURF.CLAY ? 0.33 : 0.45, w.surface === SURF.CLAY ? 0.2 : 0.3, 1.2);
            else if (wet) smoke.emit(wp.x, wp.y + 0.15, wp.z, v.v.x * 0.4, 0.6, v.v.z * 0.4, 0.5, 1.6, 0.7, 0.3, 0.75, 0.8, 0.85, 2);
            else smoke.emit(wp.x, wp.y + 0.25, wp.z, v.v.x * 0.15 + (Math.random() - 0.5), 0.6 + Math.random() * 0.6, v.v.z * 0.15 + (Math.random() - 0.5), 0.6, 3.2 * (0.5 + intensity), 2.6, 0.42 * (0.4 + intensity), 0.86, 0.86, 0.88, 0.9);
          }
          // spray off a wet road
          if (sim.weather.rain > 0.2 && w.contact && spd > 12 && Math.random() < dt * 40) smoke.emit(wp.x, wp.y + 0.3, wp.z, v.v.x * 0.6, 1.2, v.v.z * 0.6, 0.6, 2.5, 0.6, 0.18, 0.8, 0.84, 0.88, 2.5);
        });
        // engine smoke from a damaged front, sparks from a body sliding on the road
        if (v.damage.smoke > 0 && Math.random() < dt * 30 * v.damage.smoke) {
          const p = v.toWorld({ x: v.cls.look.length * 0.38, y: 0.45, z: 0 });
          const dark = v.damage.smoke > 0.6;
          smoke.emit(p.x, p.y, p.z, (Math.random() - 0.5), 1.2 + Math.random(), (Math.random() - 0.5), 0.5, 2.4, 2.5, 0.45 * v.damage.smoke + 0.1, dark ? 0.18 : 0.7, dark ? 0.18 : 0.7, dark ? 0.19 : 0.72, 0.8);
        }
        const gs = sim.gsp.heap()[sim.gsp.stateOffset(v.handle) + 37];
        if (gs > 0 && spd > 3) {
          const up = qrot(v.q, { x: 0, y: -1, z: 0 });
          for (let i = 0; i < 3; ++i) sparks.emit(v.p.x + up.x * 0.7 + (Math.random() - 0.5) * 2, v.p.y + up.y * 0.7, v.p.z + up.z * 0.7 + (Math.random() - 0.5) * 2, v.v.x * 0.6 + (Math.random() - 0.5) * 4, Math.random() * 3, v.v.z * 0.6 + (Math.random() - 0.5) * 4, 0.07, 0, 0.3, 1, 1, 0.7, 0.3, 0.5, 9.8);
        }
      }
    }
    smoke.update(dt);
    sparks.update(dt);
    // rain around the camera
    const rr = sim.weather.rain;
    rain.mesh.visible = rr > 0.01;
    if (rr > 0.01) {
      const a = rain.mesh.geometry.getAttribute('position') as THREE.BufferAttribute, arr = a.array as Float32Array;
      const t = performance.now() / 1000, c = camera.position;
      const n = Math.floor(rain.n * Math.min(1, rr + 0.2));
      for (let i = 0; i < rain.n; ++i) {
        const s = rain.seeds;
        if (i >= n) { arr.fill(0, 6 * i, 6 * i + 6); continue; }
        const x = c.x + (s[3 * i] - 0.5) * 60, z = c.z + (s[3 * i + 2] - 0.5) * 60;
        const y = c.y + 25 - (((t * 22 + s[3 * i + 1] * 40) % 40));
        arr[6 * i] = x; arr[6 * i + 1] = y; arr[6 * i + 2] = z;
        arr[6 * i + 3] = x + 0.08; arr[6 * i + 4] = y - 0.9; arr[6 * i + 5] = z + 0.05;
      }
      a.needsUpdate = true;
      puddleTimer.current -= rdt;
      if (puddleTimer.current <= 0) {
        puddleTimer.current = 0.5;
        const list = sim.gsp.puddles(c.x, c.z, 140);
        const m = new THREE.Matrix4();
        puddles.count = Math.min(256, list.length);
        list.slice(0, 256).forEach((p, i) => {
          const y = sim.gsp.groundHeight(p.x, p.z, c.y + 2) + 0.05;
          m.compose(new THREE.Vector3(p.x, y, p.z), new THREE.Quaternion(), new THREE.Vector3(p.r, 1, p.r * 0.6));
          puddles.setMatrixAt(i, m);
        });
        puddles.instanceMatrix.needsUpdate = true;
      }
    } else puddles.count = 0;
  });
  return null;
}
