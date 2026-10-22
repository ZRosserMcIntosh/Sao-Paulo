// São Paulo World · driving test track: the stunt park (north of the smash lanes).
// Two kicker ramps with their landing ramps, a half-pipe with concrete parapets, and a loop.
// Every surface is drawn from the physics' own ground (ord_web.cpp): the ramps and the pipe from
// its height function, the loop from the profile the physics tabulates (a clothoid loop on the
// inside of a cylinder, shifted sideways so the way in and the way out pass side by side).
// The loop assist (on by default) steers the small corrections that keep the car on the ribbon,
// like a stunt driver's hands; the physics decides whether it makes it over the top.
// SPDX-License-Identifier: MIT

export class StuntPark {
  constructor(THREE, parent, M, { heightPatch, sign, toast, S, W }) {
    Object.assign(this, { THREE, parent, M, toast, S, W });
    const A = new Float64Array(M.HEAPF64.buffer, M._ord_test_areas(), 35).slice();
    this.A = A;
    this.jumpY = [A[11], A[12]]; this.kickX0 = [A[13], A[14]]; this.kickLen = [A[15], A[16]]; this.kickH = [A[17], A[18]];
    this.landX0 = [A[19], A[20]]; this.landLen = [A[21], A[22]];
    this.pipe = { y: A[23], x0: A[24], x1: A[25], floor: A[26], r: A[27], deck: A[28] };
    this.loop = { x: A[29], y: A[30], r: A[31], shift: A[32], hw: A[33], heading: A[34] };
    const n = M._ord_loop_profile_count();
    this.prof = new Float64Array(M.HEAPF64.buffer, M._ord_loop_profile(), 4 * n).slice();
    this.profN = n;
    this.loopLen = this.prof[4 * (n - 1) + 3];
    let zMax = 0, xMax = 0;
    for (let i = 0; i < n; ++i) { zMax = Math.max(zMax, this.prof[4 * i + 1]); xMax = Math.max(xMax, this.prof[4 * i]); }
    this.loopTop = zMax; this.loopXMax = xMax;
    this.assist = true;
    this.sPrev = 0;
    this.air = { t: 0, x0: 0, y0: 0, maxH: 0, landingG: 0, landT: 0, flying: false };
    this.loopRun = null;
    this.build(heightPatch, sign);
  }

  build(heightPatch, sign) {
    const { THREE, parent, M } = this;
    const yel = new THREE.Color('#f0c419'), blk = new THREE.Color('#202226'), conc = new THREE.Color('#c9c5bc'), red = new THREE.Color('#d22a1f'), wht = new THREE.Color('#f2f2ee');
    // ramps: their top surface from the physics, plus solid sides down to the ground
    const sideMat = new THREE.MeshStandardMaterial({ color: '#6b6e73', roughness: 0.8, metalness: 0.3, side: THREE.DoubleSide });
    for (let k = 0; k < 2; ++k) {
      const y = this.jumpY[k];
      heightPatch(this.kickX0[k], this.kickX0[k] + this.kickLen[k] - 0.05, y - 2.5, y + 2.5, 0.1, (x) => (Math.floor(x / 1.5) % 2 ? yel : blk));
      heightPatch(this.landX0[k] + 0.05, this.landX0[k] + this.landLen[k], y - 2.5, y + 2.5, 0.2, (x) => (Math.floor(x / 3) % 2 ? yel : blk));
      for (const [x0, len] of [[this.kickX0[k], this.kickLen[k]], [this.landX0[k], this.landLen[k]]]) {
        for (const side of [-2.5, 2.5]) {
          const pos = [];
          const steps = Math.round(len / 0.25);
          for (let i = 0; i < steps; ++i) {
            const xa = x0 + (i * len) / steps, xb = x0 + ((i + 1) * len) / steps;
            const ha = M._ord_ground_height(xa + 0.01, y), hb = M._ord_ground_height(xb - 0.01, y);
            pos.push(xa, 0, -(y + side), xb, 0, -(y + side), xb, hb, -(y + side), xa, 0, -(y + side), xb, hb, -(y + side), xa, ha, -(y + side));
          }
          const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
          const m = new THREE.Mesh(g, sideMat); m.castShadow = m.receiveShadow = true; parent.add(m);
        }
        // the end face (the kicker's lip, the landing ramp's front wall)
        const xe = x0 === this.kickX0[k] ? x0 + this.kickLen[k] - 0.02 : x0 + 0.02;
        const he = M._ord_ground_height(xe + (x0 === this.kickX0[k] ? -0.03 : 0.03), y);
        const face = new THREE.Mesh(new THREE.PlaneGeometry(5, he), sideMat);
        face.position.set(xe, he / 2, -y); face.rotation.y = Math.PI / 2; parent.add(face);
      }
    }
    // half-pipe: concrete with blue copings, parapets along the decks
    const P = this.pipe;
    const uMax = P.r * Math.sin(50 * Math.PI / 180), top = P.r * (1 - Math.cos(50 * Math.PI / 180));
    const span = P.floor + uMax + P.deck;
    const pipeMesh = heightPatch(P.x0, P.x1, P.y - span - 0.2, P.y + span + 0.2, 0.25, (x, y, h) => {
      const u = Math.abs(y - P.y);
      return u > P.floor + uMax - 0.15 && u < P.floor + uMax + 0.15 ? new THREE.Color('#1d57c2') : Math.floor(x / 10) % 2 ? conc : new THREE.Color('#bdb9b0');
    });
    if (pipeMesh) pipeMesh.castShadow = false;   // it is ground: receiving is enough, and it is big
    const parapetMat = new THREE.MeshStandardMaterial({ color: '#a9a59d', roughness: 0.95 });
    for (const s of [1, -1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(P.x1 - P.x0, 1.1, 0.35), parapetMat);
      m.position.set((P.x0 + P.x1) / 2, top + 0.55, -(P.y + s * span)); m.castShadow = m.receiveShadow = true; parent.add(m);
    }
    // the loop: a ribbon along the profile, red and white every 3 m, with a steel underside
    const L = this.loop, pr = this.prof, n = this.profN;
    const pos = [], col = [], idx = [], under = [];
    const step = 2;
    for (let i = 0, v = 0; i < n; i += step, ++v) {
      const x = L.x + pr[4 * i], z = pr[4 * i + 1], th = pr[4 * i + 2], s = pr[4 * i + 3];
      const yc = L.y + (L.shift * s) / this.loopLen;
      const nx = -Math.sin(th), nz = Math.cos(th);  // inward normal in x-z
      const c = Math.floor(s / 3) % 2 ? red : wht;
      for (const side of [-L.hw, L.hw]) {
        pos.push(x + nx * 0.005, z + nz * 0.005, -(yc + side));
        col.push(c.r, c.g, c.b);
        under.push(x - nx * 0.18, z - nz * 0.18, -(yc + side));
      }
      if (v > 0) { const a = 2 * (v - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); rg.setIndex(idx); rg.computeVertexNormals();
    const ribbon = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }));
    ribbon.castShadow = ribbon.receiveShadow = true; parent.add(ribbon);
    const ug = new THREE.BufferGeometry(); ug.setAttribute('position', new THREE.Float32BufferAttribute(under, 3)); ug.setIndex(idx); ug.computeVertexNormals();
    const steel = new THREE.MeshStandardMaterial({ color: '#7d8590', roughness: 0.45, metalness: 0.7, side: THREE.DoubleSide });
    parent.add(new THREE.Mesh(ug, steel));
    // supports: steel legs under the upper half
    for (let i = 0; i < n; i += Math.round(n / 14)) {
      const z = pr[4 * i + 1];
      if (z < 3) continue;
      const x = L.x + pr[4 * i], s = pr[4 * i + 3], yc = L.y + (L.shift * s) / this.loopLen;
      for (const side of [-L.hw - 0.3, L.hw + 0.3]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, z, 10), steel);
        leg.position.set(x, z / 2, -(yc + side)); leg.castShadow = true; parent.add(leg);
      }
    }
    sign('JUMPS', this.kickX0[0] - 40, this.jumpY[0] - 4.5, '1.5 m kicker · 18 m gap · ~80 km/h');
    sign('BIG JUMP', this.kickX0[1] - 40, this.jumpY[1] + 4.5, '3 m kicker · 28 m gap · ~100 km/h');
    sign('HALF-PIPE', P.x0 - 8, P.y + P.floor + 1, 'banked walls to 50° · parapets');
    sign('LOOP', L.x - 120, L.y - (L.x + 120 - L.x) * Math.tan(L.heading) - 5, `${this.loopTop.toFixed(0)} m tall · ~100 km/h · loop assist on`);
  }

  // The loop's lane centre for the car at (x, y, z): nearest profile point, keeping continuity.
  laneAt(x, y, z) {
    const L = this.loop, pr = this.prof;
    let best = 1e9, s = -1;
    for (let i = 0; i < this.profN; ++i) {
      const si = pr[4 * i + 3];
      if (Math.abs(si - this.sPrev) > 8) continue;
      const dx = L.x + pr[4 * i] - x, dz = pr[4 * i + 1] - z, d = dx * dx + dz * dz;
      if (d < best) { best = d; s = si; }
    }
    if (s < 0) return null;
    this.sPrev = s;
    return { s, yc: L.y + (L.shift * s) / this.loopLen };
  }

  inLoopZone(x, y) { const L = this.loop; return x > L.x - 3 && x < L.x + this.loopXMax + 5 && y > L.y - 6 && y < L.y + L.shift + 6; }

  // Adds the loop assist's correction to the driver's steering.
  assistSteer(steer) {
    const { S } = this;
    const x = S(0), y = S(1), z = S(2);
    if (!this.assist || !this.inLoopZone(x, y)) { this.sPrev = 0; return steer; }
    const lane = this.laneAt(x, y, z);
    if (!lane) return steer;
    const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
    // world velocity y (lateral to the loop's axis)
    const vx = S(7), vyb = S(8);
    const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz);
    const vy = r10 * vx + r11 * vyb;
    const vyT = Math.abs(vx) * Math.sin(this.loop.heading);
    const corr = Math.max(-0.3, Math.min(0.3, 0.25 * (lane.yc - y) - 0.25 * (vy - vyT)));
    return Math.max(-1, Math.min(1, steer + corr));
  }

  // Airtime, jump length, landing g, and loop runs.
  update(dt) {
    const { S, W } = this;
    const x = S(0), y = S(1), z = S(2), v = S(7);
    const contacts = [0, 1, 2, 3].reduce((a, w) => a + (W(w, 11) > 0 ? 1 : 0), 0);
    const A = this.air;
    if (!contacts && Math.abs(v) > 3 && z > 0.6) {
      if (!A.flying) Object.assign(A, { flying: true, t: 0, x0: x, y0: y, maxH: z });
      A.t += dt; A.maxH = Math.max(A.maxH, z);
    } else if (A.flying && contacts >= 2) {
      A.flying = false;
      if (A.t > 0.35) { A.landT = 0.25; A.landingG = 0; A.result = { t: A.t, dist: Math.hypot(x - A.x0, y - A.y0), h: A.maxH }; }
    }
    if (A.landT > 0) {
      A.landT -= dt; A.landingG = Math.max(A.landingG, S(13) / 9.81);
      if (A.landT <= 0 && A.result) {
        this.toast(`Airtime ${A.result.t.toFixed(2)} s · ${A.result.dist.toFixed(1)} m · ${A.result.h.toFixed(1)} m high · landed at ${A.landingG.toFixed(1)} g${S(36) < 0.5 ? ' · and crashed' : ''}`);
        A.result = null;
      }
    }
    // loop runs: in the zone, track the height reached, the g at the bottom, the speed at the top
    if (this.inLoopZone(x, y)) {
      const R = (this.loopRun ||= { maxZ: 0, maxG: 0, vTop: 0, done: false });
      R.maxG = Math.max(R.maxG, S(13) / 9.81);
      if (z > R.maxZ) { R.maxZ = z; R.vTop = v; }
      if (!R.done && R.maxZ > this.loopTop - 3 && z < 1.2 && S(36) > 0.8 && this.sPrev > this.loopLen * 0.9) {
        R.done = true;
        this.toast(`Looped it! ${R.maxG.toFixed(1)} g at the bottom, ${(R.vTop * 3.6).toFixed(0)} km/h over the top`);
      }
    } else if (this.loopRun) {
      const R = this.loopRun;
      if (!R.done && R.maxZ > 4) this.toast(R.maxZ > this.loopTop - 3 ? 'Over the top, but off the ribbon on the way down' : `Fell from ${R.maxZ.toFixed(0)} m: the loop needs ~100 km/h`);
      this.loopRun = null;
    }
  }
}
