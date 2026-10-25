// São Paulo World · flight test bed: what an impact throws up. A cloud of
// dust and smoke that billows, rises and fades over ~8 s, and pieces of the
// airframe thrown ballistically, bouncing on the ground (groundAt) until they
// come to rest. Purely visual: the flight core has already ended the flight.
import * as THREE from 'three';

function puffTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// { group, burst(pos (three.js world), velocity (m/s, world), colour), update(dt), clear() }.
// `groundAt(x, z)` in three.js world coordinates: the ground's height (y).
export function buildCrash({ groundAt }) {
  const group = new THREE.Group();
  group.name = 'crash';
  const tex = puffTexture();
  const puffs = [], pieces = [];
  const pieceGeo = [new THREE.BoxGeometry(0.9, 0.06, 0.5), new THREE.BoxGeometry(0.4, 0.3, 0.3), new THREE.BoxGeometry(1.4, 0.05, 0.25)];
  const metal = new THREE.MeshLambertMaterial({ color: '#c9ccd1' }), dark = new THREE.MeshLambertMaterial({ color: '#3a3d42' });

  function burst(pos, vel, colour = '#a39886') {
    clear();
    const v = vel.clone();
    for (let i = 0; i < 48; ++i) {
      const mat = new THREE.SpriteMaterial({ map: tex, color: i % 3 ? colour : '#55524e', transparent: true, depthWrite: false, opacity: 0 });
      const sp = new THREE.Sprite(mat);
      sp.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 2, (Math.random() - 0.5) * 6));
      const dir = new THREE.Vector3(Math.random() - 0.5, 0.35 + Math.random() * 0.5, Math.random() - 0.5).normalize();
      puffs.push({ sp, vel: dir.multiplyScalar(3 + Math.random() * 9).addScaledVector(v, 0.25 + Math.random() * 0.3), age: -Math.random() * 0.6,
        life: 5 + Math.random() * 4, size: 3 + Math.random() * 4, grow: 2.5 + Math.random() * 3 });
      group.add(sp);
    }
    for (let i = 0; i < 14; ++i) {
      const m = new THREE.Mesh(pieceGeo[i % pieceGeo.length], i % 4 ? metal : dark);
      m.position.copy(pos).add(new THREE.Vector3(0, 0.5, 0));
      const dir = new THREE.Vector3(Math.random() - 0.5, 0.4 + Math.random() * 0.8, Math.random() - 0.5).normalize();
      pieces.push({ m, vel: dir.multiplyScalar(4 + Math.random() * 12).addScaledVector(v, 0.5 + Math.random() * 0.4),
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14), rest: false });
      m.castShadow = true;
      group.add(m);
    }
  }

  function update(dt) {
    for (const p of puffs) {
      p.age += dt;
      if (p.age < 0) continue;
      const k = p.age / p.life;
      p.vel.multiplyScalar(Math.exp(-1.2 * dt));
      p.vel.y += 0.6 * dt;  // the hot cloud rises
      p.sp.position.addScaledVector(p.vel, dt);
      const s = p.size + p.grow * p.age * 2;
      p.sp.scale.set(s, s, s);
      p.sp.material.opacity = Math.max(0, Math.min(1, p.age * 4) * (1 - k)) * 0.75;
    }
    for (const p of pieces) {
      if (p.rest) continue;
      p.vel.y -= 9.81 * dt;
      p.m.position.addScaledVector(p.vel, dt);
      p.m.rotation.x += p.spin.x * dt; p.m.rotation.y += p.spin.y * dt; p.m.rotation.z += p.spin.z * dt;
      const gy = groundAt(p.m.position.x, p.m.position.z) + 0.05;
      if (p.m.position.y < gy) {
        p.m.position.y = gy;
        if (Math.abs(p.vel.y) < 1.5 && Math.hypot(p.vel.x, p.vel.z) < 1.5) { p.rest = true; continue; }
        p.vel.y = -p.vel.y * 0.3; p.vel.x *= 0.5; p.vel.z *= 0.5; p.spin.multiplyScalar(0.6);
      }
    }
    for (let i = puffs.length - 1; i >= 0; --i) if (puffs[i].age > puffs[i].life) { group.remove(puffs[i].sp); puffs[i].sp.material.dispose(); puffs.splice(i, 1); }
  }

  function clear() {
    for (const p of puffs) { group.remove(p.sp); p.sp.material.dispose(); }
    for (const p of pieces) group.remove(p.m);
    puffs.length = 0; pieces.length = 0;
  }
  return { group, burst, update, clear };
}
