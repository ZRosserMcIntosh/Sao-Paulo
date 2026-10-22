// São Paulo World · driving test track: rain.
// The physics does the part that matters (ord_set_weather): a wet road has less grip, a water
// film, slicker cobblestones and paint, and puddles 6-20 mm deep where a tyre can hydroplane and
// the water drags at it. This module draws it: falling rain, a darker sky, a glossy wet road,
// the puddles exactly where the physics put them, and spray off the tyres.
// SPDX-License-Identifier: MIT

export const RAIN_LEVELS = [
  { name: 'Dry', rain: 0 },
  { name: 'Drizzle', rain: 0.25 },
  { name: 'Rain', rain: 0.6 },
  { name: 'Downpour', rain: 1 },
];

export class Weather {
  constructor(THREE, scene, M, { mobile, sky, fog, sun, hemi, ground }) {
    Object.assign(this, { THREE, scene, M, sun, hemi });
    this.rain = 0;
    this.sky0 = sky.clone(); this.fog0 = { near: fog.near, far: fog.far };
    this.sun0 = sun.intensity; this.hemi0 = hemi.intensity;
    this.groundMats = ground;   // materials that get wet: [{ mat, roughness, color }]
    // rain streaks: short line segments around the camera
    this.N = mobile ? 1600 : 5000;
    this.pos = new Float32Array(this.N * 6);
    this.drops = new Float32Array(this.N * 3);
    for (let i = 0; i < this.N; ++i) this.respawn(i, true, new THREE.Vector3());
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.streaks = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#b9c8d8', transparent: true, opacity: 0.5, depthWrite: false }));
    this.streaks.frustumCulled = false; this.streaks.visible = false;
    scene.add(this.streaks);
    // puddles from the physics
    this.pudMat = new THREE.MeshStandardMaterial({ color: '#25303b', roughness: 0.04, metalness: 0.55, transparent: true, opacity: 0.88, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.puddles = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2), this.pudMat, 256);
    this.puddles.count = 0; this.puddles.frustumCulled = false; this.puddles.receiveShadow = true;
    scene.add(this.puddles);
    this.pudT = 0; this.pudList = [];
    // spray
    this.SN = mobile ? 400 : 1200;
    this.sp = { pos: new Float32Array(this.SN * 3), vel: new Float32Array(this.SN * 3), life: new Float32Array(this.SN), i: 0 };
    for (let i = 0; i < this.SN; ++i) this.sp.pos[3 * i + 1] = -1e4;  // parked out of sight
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(this.sp.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.spray = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#dfe9f3', size: 0.09, transparent: true, opacity: 0.55, depthWrite: false }));
    this.spray.frustumCulled = false;
    scene.add(this.spray);
    this.inPuddle = [false, false, false, false];
    this.mtx = new THREE.Matrix4();
  }

  respawn(i, anywhere, c) {
    const x = c.x + (Math.random() - 0.5) * 60, z = c.z + (Math.random() - 0.5) * 60;
    const y = anywhere ? c.y - 5 + Math.random() * 30 : c.y + 18 + Math.random() * 8;
    this.drops.set([x, y, z], 3 * i);
  }

  set(level) {
    this.rain = level;
    this.M._ord_set_weather(level);
    const THREE = this.THREE, k = level;
    this.scene.background.copy(this.sky0).lerp(new THREE.Color('#6f7882'), Math.min(1, k * 1.2));
    this.scene.fog.color.copy(this.scene.background);
    this.scene.fog.near = this.fog0.near * (1 - 0.6 * k); this.scene.fog.far = this.fog0.far * (1 - 0.55 * k);
    this.sun.intensity = this.sun0 * (1 - 0.65 * k); this.hemi.intensity = this.hemi0 * (1 - 0.25 * k);
    for (const g of this.groundMats) {
      g.mat.roughness = g.roughness + (0.22 - g.roughness) * Math.min(1, k * 1.4);
      g.mat.color.copy(g.color).multiplyScalar(1 - 0.38 * Math.min(1, k * 1.3));
      g.mat.envMapIntensity = g.env + (0.9 - g.env) * Math.min(1, k * 1.4);
    }
    this.streaks.visible = k > 0;
    this.streaks.material.opacity = 0.25 + 0.35 * k;
    if (k === 0) { this.puddles.count = 0; this.pudList = []; }
    this.pudT = 0;
  }

  // car: world (three) position; wheels: [{ x, y, z (three), load, contact }]; speed m/s
  update(dt, camPos, carPos, speed, wheels, onSplash) {
    if (this.rain <= 0) { this.decaySpray(dt); return; }
    const { THREE } = this;
    // rain falls ~9 m/s, slanting with a light breeze, and with the car's speed in view
    const n = Math.round(this.N * Math.min(1, 0.25 + this.rain));
    const fall = 9 * dt, drift = 1.2 * dt;
    for (let i = 0; i < this.N; ++i) {
      const o = 3 * i;
      if (i >= n) { this.pos[6 * i + 1] = this.pos[6 * i + 4] = -1e4; continue; }
      this.drops[o + 1] -= fall; this.drops[o] += drift;
      if (this.drops[o + 1] < camPos.y - 6 || Math.abs(this.drops[o] - camPos.x) > 32 || Math.abs(this.drops[o + 2] - camPos.z) > 32) this.respawn(i, false, camPos);
      const x = this.drops[o], y = this.drops[o + 1], z = this.drops[o + 2];
      this.pos.set([x, y, z, x - 0.04, y + 0.45, z], 6 * i);
    }
    this.streaks.geometry.attributes.position.needsUpdate = true;
    // puddles near the car, from the physics (refresh twice a second)
    this.pudT -= dt;
    if (this.pudT <= 0) {
      this.pudT = 0.5;
      const iso = { x: carPos.x, y: -carPos.z };
      const cnt = this.M._ord_puddles(iso.x, iso.y, 90);
      const b = new Float64Array(this.M.HEAPF64.buffer, this.M._ord_puddle_buffer(), 4 * cnt);
      this.pudList = [];
      for (let i = 0; i < cnt; ++i) {
        const x = b[4 * i], y = b[4 * i + 1], r = b[4 * i + 2], depth = b[4 * i + 3];
        const h = this.M._ord_ground_height(x, y) + 0.004;
        this.mtx.makeScale(r, 1, 0.6 * r).setPosition(x, h, -y);
        this.puddles.setMatrixAt(i, this.mtx);
        this.pudList.push({ x, y, r, depth });
      }
      this.puddles.count = cnt;
      this.puddles.instanceMatrix.needsUpdate = true;
    }
    // spray: each tyre on the road throws water behind it, much more out of a puddle
    for (let w = 0; w < wheels.length; ++w) {
      const wh = wheels[w];
      if (!wh.contact) { this.inPuddle[w] = false; continue; }
      const iso = { x: wh.x, y: -wh.z };
      let pud = null;
      for (const p of this.pudList) { const dx = (iso.x - p.x) / p.r, dy = (iso.y - p.y) / (0.6 * p.r); if (dx * dx + dy * dy < 1) { pud = p; break; } }
      if (pud && !this.inPuddle[w] && speed > 4) onSplash?.(Math.min(1, speed / 25));
      this.inPuddle[w] = !!pud;
      const rate = (pud ? 400 : 60 * this.rain) * Math.min(1, speed / 25);
      let k = rate * dt; if (Math.random() < k % 1) k = Math.ceil(k); else k = Math.floor(k);
      for (let j = 0; j < k; ++j) this.emit(wh, speed, pud ? 1 : 0.4);
    }
    this.decaySpray(dt);
  }

  emit(wh, speed, power) {
    const s = this.sp, i = s.i; s.i = (s.i + 1) % this.SN;
    s.pos.set([wh.x + (Math.random() - 0.5) * 0.2, wh.y + 0.05, wh.z + (Math.random() - 0.5) * 0.2], 3 * i);
    // backward relative to the car's motion, up and out
    const b = wh.back || { x: -1, z: 0 };
    const v = speed * (0.25 + 0.3 * Math.random()) * power;
    s.vel.set([b.x * v + (Math.random() - 0.5) * 2, (1.2 + 2.5 * Math.random()) * power, b.z * v + (Math.random() - 0.5) * 2], 3 * i);
    s.life[i] = 0.5 + 0.6 * Math.random();
  }

  decaySpray(dt) {
    const s = this.sp;
    let any = false;
    for (let i = 0; i < this.SN; ++i) {
      if (s.life[i] <= 0) continue;
      any = true;
      s.life[i] -= dt;
      s.vel[3 * i + 1] -= 9.81 * dt;
      for (let a = 0; a < 3; ++a) s.pos[3 * i + a] += s.vel[3 * i + a] * dt;
      if (s.life[i] <= 0) s.pos[3 * i + 1] = -1e4;
    }
    if (any) this.spray.geometry.attributes.position.needsUpdate = true;
  }
}
