// São Paulo World · flight test bed: rain, drawn round the camera from the
// flight core's rain at the aircraft (A.weather().rain, mm/h): streaks that
// fall at a drop's terminal speed through the air and stream past at the
// aircraft's own speed, each drawn as long as it travels in a short exposure,
// so they slant and lengthen with speed. More of them, and denser, the
// harder it rains (a downpour fills the box; a light shower shows a few).
import * as THREE from 'three';

const N = 6000;        // streaks at most
const BOX = 36;        // m: the half side of the box round the camera they live in
const FALL = 7.5;      // m/s: a 2 mm drop's terminal speed
const EXPOSURE = 0.035; // s: how far a streak travels while the eye sees it

export function buildRain({ mobile = false } = {}) {
  const n = mobile ? N / 2 : N;
  const pos = new Float32Array(n * 6), off = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; ++i) off[i] = (Math.random() * 2 - 1) * BOX;
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3); attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BOX * 2);
  const mat = new THREE.LineBasicMaterial({ color: 0xc9d3de, transparent: true, opacity: 0.45, depthWrite: false, fog: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  const group = new THREE.Group();
  group.add(lines);
  group.visible = false;
  const rel = new THREE.Vector3();
  // camera: its position (the box follows it); rain mm/h; vel: the aircraft's
  // velocity (scene axes, m/s); wind: the air's (scene axes); dt s.
  function update(camera, rain, vel, wind, dt) {
    group.visible = rain > 0.05;
    if (!group.visible) return;
    group.position.copy(camera.position);
    // The drops' velocity relative to the camera: falling, carried by the wind, the aircraft flying through them.
    rel.set(wind.x - vel.x, -FALL + wind.y - vel.y, wind.z - vel.z);
    const count = Math.round(n * Math.min(1, 0.06 + Math.sqrt(rain / 50)));
    const L = Math.min(rel.length() * EXPOSURE, 6) / Math.max(rel.length(), 1e-3);
    for (let i = 0; i < count; ++i) {
      const k = 3 * i;
      for (let a = 0; a < 3; ++a) {
        let v = off[k + a] + rel.getComponent(a) * dt;
        if (v > BOX) v -= 2 * BOX; else if (v < -BOX) v += 2 * BOX;
        off[k + a] = v;
      }
      pos[6 * i] = off[k]; pos[6 * i + 1] = off[k + 1]; pos[6 * i + 2] = off[k + 2];
      pos[6 * i + 3] = off[k] - rel.x * L; pos[6 * i + 4] = off[k + 1] - rel.y * L; pos[6 * i + 5] = off[k + 2] - rel.z * L;
    }
    geo.setDrawRange(0, count * 2);
    attr.needsUpdate = true;
    mat.opacity = Math.min(0.6, 0.25 + rain / 60);
  }
  return { group, update };
}
