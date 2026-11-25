'use client';
// Per-frame views of the simulation: cars, props and debris, signs, broken glass.
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Simulation } from '../sim/Simulation';
import type { Vehicle } from '../sim/vehicle/Vehicle';
import { ReplayBuffer } from '../sim/replay';
import { applyDents, buildCar, type CarModel } from './carModel';
import { signFace } from './textures';
import type { Part } from '../sim/engines/street';
import type { GlassBreak, GlassCracks, GlassPieces } from '../sim/engines/glass';
import { qslerp } from '../sim/math';

const tmpQ = { x: 0, y: 0, z: 0, w: 1 };

// Pose of a car at render time: live (interpolated) or from the replay buffer.
export function carPose(sim: Simulation, v: Vehicle, outP: THREE.Vector3, outQ: THREE.Quaternion): boolean {
  const r = sim.replayState;
  if (r.active) {
    const loc = sim.replay.locate(r.t);
    const a = sim.replay.cars.get(v.id);
    if (!loc || !a) return false;
    const s = ReplayBuffer.carStride, o0 = loc.i0 * s, o1 = loc.i1 * s;
    if (Number.isNaN(a[o0]) || Number.isNaN(a[o1])) return false;
    const t = loc.a;
    outP.set(a[o0] + (a[o1] - a[o0]) * t, a[o0 + 1] + (a[o1 + 1] - a[o0 + 1]) * t, a[o0 + 2] + (a[o1 + 2] - a[o0 + 2]) * t);
    qslerp({ x: a[o0 + 3], y: a[o0 + 4], z: a[o0 + 5], w: a[o0 + 6] }, { x: a[o1 + 3], y: a[o1 + 4], z: a[o1 + 5], w: a[o1 + 6] }, t, tmpQ);
    outQ.set(tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w);
    return true;
  }
  const t = sim.alpha;
  outP.set(v.prevP.x + (v.p.x - v.prevP.x) * t, v.prevP.y + (v.p.y - v.prevP.y) * t, v.prevP.z + (v.p.z - v.prevP.z) * t);
  qslerp(v.prevQ, v.q, t, tmpQ);
  outQ.set(tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w);
  return true;
}

interface CarEntry { v: Vehicle; model: CarModel; dentVersion: number; detached: Set<string>; crack?: THREE.Mesh; spinPrev: number[] }

export function CarsView({ sim, version }: { sim: Simulation; version: number }) {
  const group = useRef<THREE.Group>(null);
  const entries = useRef(new Map<number, CarEntry>());
  const { scene } = useThree();
  // (re)build models for new vehicles, drop old ones
  useEffect(() => {
    const g = group.current!;
    const live = new Set(sim.vehicles.map((v) => v.id));
    for (const [id, e] of entries.current) if (!live.has(id)) { g.remove(e.model.root); disposeModel(e.model); entries.current.delete(id); }
    for (const v of sim.vehicles) {
      if (entries.current.has(v.id)) continue;
      const model = buildCar(v.cls.look, v.paint, v.wheels.map((w) => ({ x: w.x, z: w.z, radius: w.radius })), v.cls.params.cgHeight, v.cls.params.wheelbase, v.cls.params.frontWeight);
      g.add(model.root);
      if (v.role === 'player') {
        for (const color of ['#ff2020', '#2050ff']) { const l = new THREE.PointLight(color, 0, 18, 2); l.position.set(-0.3, 1.2, 0); model.root.add(l); model.barLights.push(l); }
      }
      entries.current.set(v.id, { v, model, dentVersion: -1, detached: new Set(), spinPrev: [0, 0, 0, 0] });
    }
  }, [sim, version]);
  useEffect(() => () => { for (const e of entries.current.values()) disposeModel(e.model); entries.current.clear(); }, []);
  void scene;

  const P = useMemo(() => new THREE.Vector3(), []), Q = useMemo(() => new THREE.Quaternion(), []);
  useFrame(() => {
    const now = performance.now() / 1000;
    const replay = sim.replayState.active;
    for (const e of entries.current.values()) {
      const { v, model } = e;
      const ok = carPose(sim, v, P, Q);
      model.root.visible = ok;
      if (!ok) continue;
      model.root.position.copy(P);
      model.root.quaternion.copy(Q);
      // wheels
      const rs = replay ? sim.replay.locate(sim.replayState.t) : null;
      const ra = replay ? sim.replay.cars.get(v.id) : null;
      for (let k = 0; k < model.wheels.length; ++k) {
        const w = v.wheels[k], pw = v.prevWheels[k] ?? w, W = model.wheels[k];
        if (!w) continue;
        let y = pw.y + (w.y - pw.y) * sim.alpha, steer = w.steer, spin = pw.spin + (w.spin - pw.spin) * sim.alpha;
        if (rs && ra) { const o = rs.i1 * ReplayBuffer.carStride + 7 + 3 * k; y = ra[o]; steer = ra[o + 1]; spin = ra[o + 2]; }
        W.pivot.position.set(w.x, y, w.z);
        W.pivot.rotation.y = -steer;
        W.spin.rotation.z = -spin;
        if (W.hubcap) W.hubcap.visible = !v.damage.detached.has(`hubcap${k}` as never);
      }
      // lights
      const d = v.damage;
      const brake = v.brakeLight;
      model.tails.forEach((t, i) => {
        const ok2 = i === 0 ? d.lights.tailL : d.lights.tailR;
        const m = t.material as THREE.MeshStandardMaterial;
        m.emissiveIntensity = ok2 ? 0.6 + 3.2 * brake : 0;
        m.color.set(ok2 ? '#5a0606' : '#1a0a0a');
      });
      model.heads.forEach((h, i) => {
        const ok2 = i === 0 ? d.lights.headL : d.lights.headR;
        const m = h.material as THREE.MeshStandardMaterial;
        m.emissiveIntensity = ok2 ? (v.headlights ? 2.2 : 0.4) : 0;
        m.color.set(ok2 ? '#f4f6ff' : '#2a2a2a');
      });
      model.reverse.forEach((r) => ((r.material as THREE.MeshStandardMaterial).emissiveIntensity = v.reversing ? 2.5 : 0));
      // emergency lights: a quad-flash pattern, left/right alternating
      const on = v.emergency && d.lights.bar;
      const ph = (now * 2.2 + v.id * 0.37) % 1;
      let red = 0, blue = 0;
      for (const b of model.bar) {
        const m = b.mesh.material as THREE.MeshStandardMaterial;
        let lit = 0;
        if (on) {
          const flash = Math.floor(ph * 8) % 2 === 0 ? 1 : 0;
          if (b.color === 'red') lit = ph < 0.5 ? flash : 0;
          else if (b.color === 'blue') lit = ph >= 0.5 ? flash : 0;
          else lit = Math.floor(now * 3 + b.phase) % 4 === 0 ? 1 : 0;
          if (b.color === 'red') red = Math.max(red, lit); else if (b.color === 'blue') blue = Math.max(blue, lit);
        }
        m.emissiveIntensity = lit * 9;
      }
      if (model.barLights.length) { model.barLights[0].intensity = red * 18; model.barLights[1].intensity = blue * 22; }
      // detached and hanging parts
      for (const [id, obj] of Object.entries(model.parts)) {
        if (!obj || id.startsWith('hubcap')) continue;
        obj.visible = !d.detached.has(id as never);
        if (d.hanging.has(id as never)) { obj.rotation.z = id === 'bumperF' ? -0.12 : id === 'bumperR' ? 0.12 : 0.25; obj.rotation.x = 0.05; }
        else obj.rotation.set(0, 0, 0);
      }
      // windows
      const wv = model.windows;
      if (wv.sideL) wv.sideL.visible = d.windows.sideL < 2;
      if (wv.sideR) wv.sideR.visible = d.windows.sideR < 2;
      if (wv.rear) wv.rear.visible = d.windows.rear < 2;
      // dents and scratches
      if (e.dentVersion !== d.version) {
        e.dentVersion = d.version;
        applyDents(model, d.dents);
        const rough = 0.32 + d.scratches * 0.45;
        model.mats.paint.roughness = rough;
        model.mats.paint.clearcoat = 1 - d.scratches * 0.8;
        if (model.mats.livery) { model.mats.livery.roughness = rough; model.mats.livery.clearcoat = 1 - d.scratches * 0.8; }
      }
    }
  });
  return <group ref={group} />;
}

function disposeModel(m: CarModel) {
  m.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}

// Cones, drums, barricades and debris (car parts), interpolated or from the replay buffer.
export function PropsView({ sim, version }: { sim: Simulation; version: number }) {
  const group = useRef<THREE.Group>(null);
  const objs = useRef(new Map<number, THREE.Object3D>());
  const proto = useMemo(() => {
    const coneMat = new THREE.MeshStandardMaterial({ color: '#ff6a10', roughness: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: '#f4f4f0', roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0.05 });
    const cone = new THREE.Group();
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.68, 16), coneMat); c.position.y = 0.0;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.12, 0.12, 16, 1, true), white); band.position.y = 0.06;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.04, 0.38), new THREE.MeshStandardMaterial({ color: '#222', roughness: 0.9 })); base.position.y = -0.34;
    cone.add(c, band, base);
    const drum = new THREE.Group();
    const dm = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.3, 0.94, 18), coneMat);
    drum.add(dm);
    for (const y of [-0.2, 0.15]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.295, 0.295, 0.12, 18, 1, true), white); b.position.y = y; drum.add(b); }
    const db = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 18), new THREE.MeshStandardMaterial({ color: '#111' })); db.position.y = -0.45; drum.add(db);
    const bar = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.3, 0.05), new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.6 }));
    board.position.y = 0.2;
    bar.add(board);
    for (const s of [-1, 1]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.7), new THREE.MeshStandardMaterial({ color: '#e8e8e8' })); leg.position.set(s * 1.0, -0.15, 0); bar.add(leg); }
    for (const o of [cone, drum, bar]) o.traverse((x) => { (x as THREE.Mesh).castShadow = true; });
    return { cone, drum, barricade: bar };
  }, []);
  const carParts = useRef(new Map<number, THREE.Object3D>());

  useEffect(() => {
    const g = group.current!;
    const live = new Set(sim.props.list.map((p) => p.id));
    for (const [id, o] of objs.current) if (!live.has(id)) { g.remove(o); objs.current.delete(id); }
    for (const p of sim.props.list) {
      if (objs.current.has(p.id)) continue;
      let o: THREE.Object3D;
      if (p.kind === 'debris') {
        // a box in the part's colour, shaped like the part
        const geo = new THREE.BoxGeometry(p.size[0] * 2, p.size[1] * 2, p.size[2] * 2);
        o = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: p.color ?? '#333', roughness: 0.4, metalness: 0.5, clearcoat: 0.6 }));
        (o as THREE.Mesh).castShadow = true;
        if (p.part === 'lightbar') { const lens = new THREE.Mesh(new THREE.BoxGeometry(p.size[0] * 1.8, p.size[1] * 1.2, p.size[2] * 1.9), new THREE.MeshStandardMaterial({ color: '#3a0a0a', emissive: '#300', roughness: 0.2 })); lens.position.y = p.size[1] * 0.6; o.add(lens); }
      } else o = proto[p.kind].clone();
      g.add(o);
      objs.current.set(p.id, o);
    }
  }, [sim, version, proto]);
  void carParts;

  useFrame(() => {
    const r = sim.replayState, t = sim.alpha;
    const loc = r.active ? sim.replay.locate(r.t) : null;
    for (const p of sim.props.list) {
      const o = objs.current.get(p.id);
      if (!o) continue;
      if (loc) {
        const a = sim.replay.props.get(p.id);
        if (a) {
          const s = ReplayBuffer.propStride, o0 = loc.i0 * s, o1 = loc.i1 * s;
          if (!Number.isNaN(a[o0]) && !Number.isNaN(a[o1])) {
            o.position.set(a[o0] + (a[o1] - a[o0]) * loc.a, a[o0 + 1] + (a[o1 + 1] - a[o0 + 1]) * loc.a, a[o0 + 2] + (a[o1 + 2] - a[o0 + 2]) * loc.a);
            o.quaternion.set(a[o1 + 3], a[o1 + 4], a[o1 + 5], a[o1 + 6]);
            o.visible = true;
            continue;
          }
        }
        o.visible = p.kind !== 'debris' || p.born < r.t;
        if (p.kind !== 'debris') { o.position.set(p.home.x, p.home.y, p.home.z); o.quaternion.set(0, 0, 0, 1); }
        continue;
      }
      o.visible = true;
      o.position.set(p.prevP.x + (p.p.x - p.prevP.x) * t, p.prevP.y + (p.p.y - p.prevP.y) * t, p.prevP.z + (p.p.z - p.prevP.z) * t);
      qslerp(p.prevQ, p.q, t, tmpQ);
      o.quaternion.set(tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w);
    }
  });
  return <group ref={group} />;
}

let stripeTex: THREE.Texture | null = null;
function stripeTexture() {
  if (stripeTex) return stripeTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, 256, 32);
  g.fillStyle = '#ff6a10';
  for (let x = -32; x < 256; x += 40) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 20, 32); g.lineTo(x + 52, 0); g.lineTo(x + 32, 0); g.fill(); }
  stripeTex = new THREE.CanvasTexture(c); stripeTex.colorSpace = THREE.SRGBColorSpace;
  return stripeTex;
}

// Breakaway signs from Street Dynamics: posts (segments) and panels, posed from the engine.
export function SignsView({ sim }: { sim: Simulation }) {
  const group = useRef<THREE.Group>(null);
  const built = useRef<{ id: number; segs: THREE.Mesh[]; panels: THREE.Mesh[] }[]>([]);
  const parts: Part[] = useMemo(() => [], []);
  useEffect(() => {
    const st = sim.street, g = group.current!;
    if (!st) return;
    const postMat = new THREE.MeshStandardMaterial({ color: '#9aa0a6', metalness: 0.8, roughness: 0.4 });
    const backMat = new THREE.MeshStandardMaterial({ color: '#8d9298', metalness: 0.7, roughness: 0.5 });
    st.ids.forEach((id, i) => {
      const spot = st.spots[i];
      st.parts(id, parts);
      const segs: THREE.Mesh[] = [], panels: THREE.Mesh[] = [];
      for (const p of parts) {
        if (p.kind === 1) {
          const face = new THREE.MeshStandardMaterial({ map: signFace(spot.style, spot.legend), roughness: 0.45, emissive: '#ffffff', emissiveIntensity: 0.04, emissiveMap: signFace(spot.style, spot.legend) });
          // panel box: thin along local z; the face toward traffic is the -z side
          const geo = new THREE.BoxGeometry(p.hx * 2, p.hy * 2, p.hz * 2 + 0.004);
          const mats = [backMat, backMat, backMat, backMat, backMat, face];
          const m = new THREE.Mesh(geo, mats);
          m.castShadow = true;
          g.add(m);
          panels.push(m);
        } else {
          const m = new THREE.Mesh(new THREE.BoxGeometry(p.hx * 2, p.hy * 2, p.hz * 2), postMat);
          m.castShadow = true;
          g.add(m);
          segs.push(m);
        }
      }
      built.current.push({ id, segs, panels });
    });
    return () => { for (const b of built.current) for (const m of [...b.segs, ...b.panels]) g.remove(m); built.current = []; };
  }, [sim, parts]);
  useFrame(() => {
    const st = sim.street;
    if (!st) return;
    for (const b of built.current) {
      st.parts(b.id, parts);
      let si = 0, pi = 0;
      for (const p of parts) {
        const m = p.kind === 1 ? b.panels[pi++] : b.segs[si++];
        if (!m) continue;
        m.position.set(p.x, p.y, p.z);
        m.quaternion.set(p.qx, p.qy, p.qz, p.qw);
      }
    }
  });
  return <group ref={group} />;
}

// Broken glass: tempered pieces flying from the glass engine's frames; windscreen crack overlays.
export function GlassView({ sim }: { sim: Simulation }) {
  const group = useRef<THREE.Group>(null);
  const views = useRef(new Map<number, { mesh: THREE.Mesh; recs: { index: number; start: number; count: number; local: Float32Array }[]; b: GlassBreak; t: number }>());
  const mat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#cfe6ef', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.6, side: THREE.DoubleSide, flatShading: true, clearcoat: 1 }), []);
  const crackMat = useMemo(() => ({} as Record<number, THREE.MeshBasicMaterial>), []);
  useEffect(() => {
    sim.glass.onResult = () => {};
  }, [sim]);
  useFrame((_, dt) => {
    const g = group.current!;
    const live = new Set(sim.glass.breaks.map((b) => b.id));
    for (const [id, v] of views.current) if (!live.has(id)) { g.remove(v.mesh); v.mesh.geometry.dispose(); views.current.delete(id); }
    for (const b of sim.glass.breaks) {
      if (!b.result || views.current.has(b.id)) continue;
      if (b.result.kind === 'pieces') views.current.set(b.id, buildPieces(b, b.result, mat, g));
      else views.current.set(b.id, buildCracks(sim, b, b.result, crackMat, g));
    }
    for (const v of views.current.values()) {
      if (v.b.result?.kind !== 'pieces') {
        // keep the crack overlay on its car
        const car = sim.vehicles.find((x) => x.id === v.b.vehicleId);
        if (car) {
          const f = sim.windowFrame(car, 'windscreen');
          const P = new THREE.Vector3(), Q = new THREE.Quaternion();
          carPose(sim, car, P, Q);
          const o = new THREE.Vector3(f.origin.x, f.origin.y, f.origin.z).applyQuaternion(Q).add(P);
          const along = new THREE.Vector3(f.along.x, f.along.y, f.along.z).applyQuaternion(Q);
          const up = new THREE.Vector3(f.up.x, f.up.y, f.up.z).applyQuaternion(Q);
          const thr = new THREE.Vector3().crossVectors(along, up);
          v.mesh.matrix.makeBasis(along, up, thr).setPosition(o.addScaledVector(thr, 0.012));
          v.mesh.matrixAutoUpdate = false;
        }
        continue;
      }
      const r = v.b.result as GlassPieces;
      if (!sim.paused && !sim.replayState.active) v.t = Math.min(v.t + dt * (sim.slowmo ? sim.slowmoScale : 1), (r.frames.length - 1) / r.fps);
      const f = v.t * r.fps, i0 = Math.floor(f), i1 = Math.min(r.frames.length - 1, i0 + 1), a = f - i0;
      const F0 = r.frames[i0], F1 = r.frames[i1];
      const pos = v.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const b = v.b;
      for (const rec of v.recs) {
        const o0 = 8 * rec.index;
        if (o0 + 7 >= F1.length) continue;
        const has0 = o0 + 7 < F0.length;
        const L = (k: number) => (has0 ? F0[o0 + k] + (F1[o0 + k] - F0[o0 + k]) * a : F1[o0 + k]);
        const px = L(0), py = L(1), pz = L(2);
        let qw = L(3), qx = L(4), qy = L(5), qz = L(6);
        const ql = Math.hypot(qw, qx, qy, qz) || 1; qw /= ql; qx /= ql; qy /= ql; qz /= ql;
        for (let j = 0; j < rec.count; ++j) {
          const lx = rec.local[3 * j], ly = rec.local[3 * j + 1], lz = rec.local[3 * j + 2];
          const tx = 2 * (qy * lz - qz * ly), ty = 2 * (qz * lx - qx * lz), tz = 2 * (qx * ly - qy * lx);
          const rx = lx + qw * tx + (qy * tz - qz * ty), ry = ly + qw * ty + (qz * tx - qx * tz), rz = lz + qw * tz + (qx * ty - qy * tx);
          const X = px + rx, Y = py + ry, Z = pz + rz;
          const k = (rec.start + j) * 3;
          arr[k] = b.origin.x + b.along.x * X + b.up.x * Y + b.through.x * Z;
          arr[k + 1] = b.origin.y + b.along.y * X + b.up.y * Y + b.through.y * Z;
          arr[k + 2] = b.origin.z + b.along.z * X + b.up.z * Y + b.through.z * Z;
        }
      }
      pos.needsUpdate = true;
    }
  });
  return <group ref={group} />;
}

function buildPieces(b: GlassBreak, r: GlassPieces, mat: THREE.Material, g: THREE.Group) {
  const recs: { index: number; start: number; count: number; local: Float32Array }[] = [];
  let nv = 0;
  const all: number[] = [];
  for (const s of r.shapes) {
    const n = s.outline.length / 2;
    if (n < 3) continue;
    const local: number[] = [];
    const h = Math.max(0.002, s.thickness / 2);
    // fan triangulation (pieces are near-convex dice)
    for (let i = 1; i + 1 < n; ++i) {
      for (const k of [0, i, i + 1]) local.push(s.outline[2 * k], s.outline[2 * k + 1], h);
      for (const k of [0, i + 1, i]) local.push(s.outline[2 * k], s.outline[2 * k + 1], -h);
    }
    recs.push({ index: s.index, start: nv, count: local.length / 3, local: Float32Array.from(local) });
    nv += local.length / 3;
    all.push(...local);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  g.add(mesh);
  return { mesh, recs, b, t: 0 };
}

function buildCracks(sim: Simulation, b: GlassBreak, r: GlassCracks, cache: Record<number, THREE.MeshBasicMaterial>, g: THREE.Group) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = Math.round(512 * (b.H / b.W));
  const x = c.getContext('2d')!;
  x.strokeStyle = 'rgba(235,245,255,0.85)';
  x.lineWidth = 1.2;
  x.beginPath();
  const sx = c.width / b.W, sy = c.height / b.H;
  for (let k = 0; k < r.segs.length; k += 4) { x.moveTo(r.segs[k] * sx, c.height - r.segs[k + 1] * sy); x.lineTo(r.segs[k + 2] * sx, c.height - r.segs[k + 3] * sy); }
  x.stroke();
  const tex = new THREE.CanvasTexture(c);
  const mat = (cache[b.id] = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  const geo = new THREE.PlaneGeometry(b.W, b.H);
  geo.translate(b.W / 2, b.H / 2, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 4;
  g.add(mesh);
  void sim;
  return { mesh, recs: [], b, t: 0 };
}
