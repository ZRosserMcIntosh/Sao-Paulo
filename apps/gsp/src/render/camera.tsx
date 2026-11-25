'use client';
// Cameras: cinematic chase (damped, speed FOV, impact shake), close chase, hood, driver, free
// orbit, trackside cinematic, and the replay director that cuts between angles around an event.
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Simulation } from '../sim/Simulation';
import { carPose } from './views';

export function CameraRig({ sim }: { sim: Simulation }) {
  const { camera, gl } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  const st = useRef({ pos: new THREE.Vector3(), look: new THREE.Vector3(), vel: new THREE.Vector3(), init: true, shake: 0, fov: 60, mode: '' as string, trackside: new THREE.Vector3(), tsTimer: 0, yaw: 0, height: 2, lastY: 0 });
  const orbit = useRef({ yaw: 2.4, pitch: 0.28, dist: 9, drag: false, lx: 0, ly: 0 });
  const P = useMemo(() => new THREE.Vector3(), []), Q = useMemo(() => new THREE.Quaternion(), []);
  useEffect(() => sim.onImpact((e) => { if (e.involvesPlayer) st.current.shake = Math.min(1, st.current.shake + e.strength * 0.9); }), [sim]);
  useEffect(() => {
    const el = gl.domElement;
    const down = (e: PointerEvent) => { orbit.current.drag = true; orbit.current.lx = e.clientX; orbit.current.ly = e.clientY; };
    const move = (e: PointerEvent) => {
      const o = orbit.current;
      if (!o.drag) return;
      if (sim.camera !== 'free') sim.camera = 'free';
      o.yaw -= (e.clientX - o.lx) * 0.006; o.pitch = Math.max(-0.1, Math.min(1.35, o.pitch + (e.clientY - o.ly) * 0.005));
      o.lx = e.clientX; o.ly = e.clientY;
    };
    const up = () => { orbit.current.drag = false; };
    const wheel = (e: WheelEvent) => { if (sim.camera === 'free') orbit.current.dist = Math.max(3, Math.min(60, orbit.current.dist * (1 + Math.sign(e.deltaY) * 0.1))); };
    el.addEventListener('pointerdown', down); window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); el.addEventListener('wheel', wheel, { passive: true });
    return () => { el.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); el.removeEventListener('wheel', wheel); };
  }, [gl, sim]);

  useFrame((_, rdt) => {
    const s = st.current;
    let p = sim.player;
    const dt = Math.min(rdt, 0.05);
    const hook = (globalThis as unknown as { __orbit?: { role: string; yaw: number; pitch: number; dist: number } }).__orbit;
    if (hook) {
      const v = sim.vehicles.find((x) => x.role === hook.role) ?? p;
      if (v) {
        carPose(sim, v, P, Q);
        const f = new THREE.Vector3(1, 0, 0).applyQuaternion(Q); const yaw = hook.yaw + Math.atan2(-f.z, f.x);
        cam.position.set(P.x + Math.cos(yaw) * Math.cos(hook.pitch) * hook.dist, P.y + Math.sin(hook.pitch) * hook.dist + 0.4, P.z - Math.sin(yaw) * Math.cos(hook.pitch) * hook.dist);
        cam.up.set(0, 1, 0); cam.fov = 40; cam.lookAt(P.x, P.y + 0.1, P.z); cam.updateProjectionMatrix();
        return;
      }
    }
    if (!p) return;
    const r = sim.replayState;
    if (r.active) { replayCamera(sim, cam, s, dt); return; }
    carPose(sim, p, P, Q);
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(Q);
    const flatFwd = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(Q);
    const speed = Math.hypot(p.v.x, p.v.z);
    const mode = sim.camera;
    if (mode !== s.mode) { s.init = true; s.mode = mode; }
    let targetFov = 60;
    let desired = new THREE.Vector3(), look = new THREE.Vector3();
    const L = p.cls.look;
    const velDir = speed > 3 ? new THREE.Vector3(p.v.x, 0, p.v.z).normalize() : flatFwd;
    if (mode === 'chase' || mode === 'close') {
      const far = mode === 'chase';
      const dist = far ? 6.4 + speed * 0.04 : 4.6 + speed * 0.018;
      const h = far ? 2.15 : 1.55;
      // the camera's heading eases toward the car's (and, in a slide, partly toward where it is
      // going); its position is then set from the car's current position, so it never trails
      const dir = flatFwd.clone().lerp(velDir, 0.3).normalize();
      const want = Math.atan2(dir.z, dir.x);
      if (s.init) { s.yaw = want; s.height = h; }
      let dy = want - s.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      s.yaw += dy * (1 - Math.exp(-dt * (far ? 4.5 : 6)));
      s.height += (h + Math.max(0, P.y - s.lastY) * 0.0 - s.height) * (1 - Math.exp(-dt * 3));
      const cdir = new THREE.Vector3(Math.cos(s.yaw), 0, Math.sin(s.yaw));
      desired.copy(P).addScaledVector(cdir, -dist).add(new THREE.Vector3(0, s.height, 0));
      // a touch of lag from the car's acceleration feels like weight
      desired.addScaledVector(new THREE.Vector3(p.accel.x * fwd.x, 0, p.accel.x * fwd.z), -0.03);
      look.copy(P).addScaledVector(cdir, far ? 4 : 3).add(new THREE.Vector3(0, far ? 0.9 : 0.8, 0));
      targetFov = (far ? 58 : 62) + Math.min(24, speed * 0.32);
      s.pos.copy(desired);
      // never below the ground
      const gy = sim.ground.heightAt(s.pos.x, s.pos.z) + 0.6;
      if (s.pos.y < gy) s.pos.y = gy;
      s.look.copy(look);
      s.lastY = P.y;
    } else if (mode === 'hood' || mode === 'driver') {
      const lp = mode === 'hood' ? new THREE.Vector3(L.length * 0.18, L.height * 0.72 - p.cls.params.cgHeight + 0.05, 0) : new THREE.Vector3(L.length / 2 - 3.1, L.height * 0.81 - p.cls.params.cgHeight + 0.02, -0.38);
      s.pos.copy(lp).applyQuaternion(Q).add(P);
      s.look.copy(s.pos).addScaledVector(fwd, 20).addScaledVector(up, mode === 'hood' ? -0.6 : -1.2);
      targetFov = mode === 'hood' ? 66 + Math.min(14, speed * 0.2) : 72;
      cam.up.copy(up);
    } else if (mode === 'free') {
      const o = orbit.current;
      const yaw = o.yaw + Math.atan2(-flatFwd.z, flatFwd.x);
      desired.set(P.x + Math.cos(yaw) * Math.cos(o.pitch) * o.dist, P.y + Math.sin(o.pitch) * o.dist + 0.8, P.z - Math.sin(yaw) * Math.cos(o.pitch) * o.dist);
      s.pos.lerp(desired, s.init ? 1 : 1 - Math.exp(-dt * 10));
      s.look.copy(P).add(new THREE.Vector3(0, 0.6, 0));
      targetFov = 55;
    } else {
      // trackside: a camera placed ahead of the car beside the road; cut when it falls far behind
      s.tsTimer -= dt;
      const d = s.trackside.distanceTo(P);
      if (s.init || d > 75 || s.tsTimer < -9) {
        const ahead = P.clone().addScaledVector(velDir, 35 + speed * 1.2);
        const side = new THREE.Vector3(-velDir.z, 0, velDir.x).multiplyScalar(Math.random() < 0.5 ? 9 : -9);
        s.trackside.copy(ahead).add(side);
        s.trackside.y = sim.ground.heightAt(s.trackside.x, s.trackside.z) + 1.2 + Math.random() * 2.5;
        s.tsTimer = 0;
      }
      s.pos.copy(s.trackside);
      s.look.lerp(P, s.init ? 1 : 1 - Math.exp(-dt * 9));
      targetFov = Math.max(14, Math.min(55, 900 / Math.max(10, d)));
    }
    if (mode !== 'hood' && mode !== 'driver') cam.up.set(0, 1, 0);
    s.init = false;
    s.fov += (targetFov - s.fov) * (1 - Math.exp(-dt * 3));
    cam.fov = s.fov;
    cam.position.copy(s.pos);
    // impact shake (decays), plus a faint high-speed rumble
    s.shake *= Math.exp(-dt * 4);
    const t = performance.now() / 1000;
    const amp = s.shake * 0.25 + (mode === 'chase' || mode === 'close' ? Math.min(0.015, speed * 0.0003) : 0);
    cam.position.x += Math.sin(t * 61) * amp; cam.position.y += Math.sin(t * 47 + 1) * amp; cam.position.z += Math.sin(t * 53 + 2) * amp;
    cam.lookAt(s.look);
    cam.updateProjectionMatrix();
  });
  return null;
}

function replayCamera(sim: Simulation, cam: THREE.PerspectiveCamera, s: { pos: THREE.Vector3; look: THREE.Vector3; fov: number; init: boolean }, dt: number) {
  const r = sim.replayState;
  const e = r.event;
  // the focus: the event's first car, else the player
  const focusCar = (e && sim.vehicles.find((v) => v.id === e.ids[0])) || sim.player!;
  const P = new THREE.Vector3(), Q = new THREE.Quaternion();
  carPose(sim, focusCar, P, Q);
  const center = e ? new THREE.Vector3(e.x, e.y, e.z).lerp(P, 0.6) : P;
  const shot = Math.floor((r.t - r.t0) / 2.2) % 4;
  const ang = r.angle * 0.25;
  let pos: THREE.Vector3;
  let fov = 45;
  if (shot === 0) { pos = center.clone().add(new THREE.Vector3(Math.cos(ang) * 11, 3.2, Math.sin(ang) * 11)); }
  else if (shot === 1) { pos = center.clone().add(new THREE.Vector3(14, 0.6, -6)); fov = 32; pos.y = sim.ground.heightAt(pos.x, pos.z) + 0.5; }
  else if (shot === 2) { pos = center.clone().add(new THREE.Vector3(0.1, 22, 0.1)); fov = 50; }
  else { const f = new THREE.Vector3(-1, 0, 0).applyQuaternion(Q); pos = P.clone().addScaledVector(f, 7).add(new THREE.Vector3(0, 2.2, 0)); fov = 55; }
  s.pos.lerp(pos, s.init ? 1 : 1 - Math.exp(-dt * 6));
  s.look.lerp(center, 1 - Math.exp(-dt * 8));
  s.fov += (fov - s.fov) * (1 - Math.exp(-dt * 4));
  cam.fov = s.fov;
  cam.up.set(0, 1, 0);
  cam.position.copy(s.pos);
  cam.lookAt(s.look);
  cam.updateProjectionMatrix();
}
