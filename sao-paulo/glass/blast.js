// Blasts for the glass lab: the loads a charge puts on a pane, and what it
// looks like going off. Shared by the lab's own grenade and the house scene.
//
// Loads: free-air TNT (Kinney & Graham 1985) at scaled distance
// Z = R / W^(1/3), the shock reflected off the glass (normal reflection,
// less at a glancing angle), a Friedlander decay solved for the right
// impulse, the arrival integrated at the shock's own speed, and for a charge
// in a closed room its gas pressure (UFC 3-340-02). The engine takes the
// result as gls_blast(arrival, peak, duration, decay, gas, rise, venting).

export const P0 = 101325, C0 = 343;

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Side-on overpressure (Pa) at scaled distance Z (m/kg^1/3).
export function sideOn(Z) {
  return P0 * 808 * (1 + (Z / 4.5) ** 2) / Math.sqrt((1 + (Z / 0.048) ** 2) * (1 + (Z / 0.32) ** 2) * (1 + (Z / 1.35) ** 2));
}
// Positive phase (s) of a W kg charge.
export function positivePhase(Z, W) {
  return 1e-3 * Math.cbrt(W) * 980 * (1 + (Z / 0.54) ** 10) / ((1 + (Z / 0.02) ** 3) * (1 + (Z / 0.74) ** 6) * Math.sqrt(1 + (Z / 6.9) ** 2));
}
// Side-on impulse (Pa s).
export function impulse(Z, W) {
  return 100 * Math.cbrt(W) * 0.067 * Math.sqrt(1 + (Z / 0.23) ** 4) / (Z * Z * Math.cbrt(1 + (Z / 1.55) ** 3));
}
// Normal reflection of a shock of overpressure p.
export function reflected(p) { return 2 * p * (7 * P0 + 4 * p) / (7 * P0 + p); }
// Friedlander decay b that gives impulse I for peak p and duration td.
export function decayFor(I, p, td) {
  const f = (b) => 1 / b - (1 - Math.exp(-b)) / (b * b), want = I / (p * td);
  if (want >= f(0.05)) return 0.05;
  let lo = 0.05, hi = 20;
  for (let i = 0; i < 50; ++i) { const m = 0.5 * (lo + hi); if (f(m) > want) lo = m; else hi = m; }
  return 0.5 * (lo + hi);
}
// When the shock reaches distance R (s): its front runs at c0 sqrt(1 + 6p/7P0).
export function arrivalTime(R, W) {
  let t = 0;
  const r0 = 0.05, n = 60;
  for (let i = 0; i < n; ++i) {
    const a = r0 + (R - r0) * i / n, b = r0 + (R - r0) * (i + 1) / n;
    t += (b - a) / (C0 * Math.sqrt(1 + 6 * sideOn(0.5 * (a + b) / Math.cbrt(W)) / (7 * P0)));
  }
  return t;
}
// Quasi-static gas pressure of W kg in a closed volume V m^3 (Pa).
export function gasPressure(W, V) { return 2410e3 * Math.pow(W / V, 0.72); }

// The load on a pane R m from a W kg charge, seen at cosI from face-on.
export function paneLoad(W, R, cosI) {
  const Z = Math.max(0.3, R) / Math.cbrt(W), ps = sideOn(Z), pr = reflected(ps);
  const peak = ps + (pr - ps) * cosI * cosI, td = positivePhase(Z, W);
  return { peak, td, decay: decayFor(impulse(Z, W) * peak / ps, peak, td), arrival: arrivalTime(Math.max(0.3, R), W), Z };
}

// How many of `n` fragments thrown evenly in every direction cross an area A
// seen at cosI from distance R: a Poisson draw with that mean.
export function fragmentsThrough(rnd, n, A, cosI, R, cap) {
  const mean = n * A * cosI / (4 * Math.PI * R * R), L = Math.exp(-mean);
  let k = 0, p = 1;
  do { ++k; p *= rnd(); } while (p > L && k < 64);
  return Math.min(k - 1, cap);
}

// ---------- What it looks like ----------
function softDisc(THREE) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let disc = null;

// Flash, fireball, the shock front (a shell, bright where seen edge-on, at the
// radius its arrival times give), glowing steel streaks and smoke, at `c`
// (world) going off at engine time `t0`. opts: W (kg TNT), seed, frag speed,
// room { lo: [x,y,z], hi: [x,y,z] } the streaks stop at (else the ground at
// y = 0), scale (smoke size). Call update(tEngine) every frame.
export function createBlastFX(THREE, parent, c, t0, opts = {}) {
  const W = opts.W ?? 0.22, rnd = mulberry32((opts.seed ?? 1) ^ 0x5c4a), vFrag = opts.fragSpeed ?? 1400, size = opts.scale ?? 1;
  disc ||= softDisc(THREE);
  const group = new THREE.Group();
  const light = new THREE.PointLight(0xffd7a0, 0, 30 * size, 2);
  light.position.copy(c).add(new THREE.Vector3(0, 0.3, 0));
  group.add(light);
  const fire = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  fire.position.copy(c);
  group.add(fire);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: disc, color: 0xfff3d6, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  flash.position.copy(c);
  group.add(flash);
  const shock = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uA: { value: 0 } },
    vertexShader: 'varying float vF; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vec3 n = normalize(normalMatrix * normal); vF = 1.0 - abs(dot(n, normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vF; uniform float uA; void main(){ gl_FragColor = vec4(vec3(0.85,0.92,1.0), uA * pow(vF, 7.0)); }',
  }));
  shock.position.copy(c);
  group.add(shock);
  const table = [];
  for (let k = 0; k <= 60; ++k) { const R = 0.05 + 10 * (k / 60) ** 1.5; table.push([arrivalTime(R, W), R]); }
  // Steel: streaks out in every direction, stopped by the room or the ground.
  const dirs = [], n = 160;
  for (let i = 0; i < n; ++i) {
    const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), s = Math.sqrt(1 - z * z);
    const d = new THREE.Vector3(s * Math.cos(a), z * 0.8 + 0.1, s * Math.sin(a)).normalize();
    let tMax = 25;
    const room = opts.room;
    if (room && c.x > room.lo[0] && c.x < room.hi[0] && c.z > room.lo[2] && c.z < room.hi[2]) {
      ['x', 'y', 'z'].forEach((ax, k) => {
        if (d[ax] > 1e-6) tMax = Math.min(tMax, (room.hi[k] - c[ax]) / d[ax]);
        if (d[ax] < -1e-6) tMax = Math.min(tMax, (room.lo[k] - c[ax]) / d[ax]);
      });
    } else if (d.y < 0) tMax = Math.min(tMax, -c.y / d.y);
    dirs.push({ d, len: Math.max(0.05, tMax), v: vFrag * (0.85 + 0.3 * rnd()) });
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
  const tracers = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  tracers.frustumCulled = false;
  group.add(tracers);
  const sprite = (color) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: disc, color, transparent: true, opacity: 0, depthWrite: false })); sp.position.copy(c); group.add(sp); return sp; };
  const smoke = [];
  for (let i = 0; i < 26; ++i) {
    const a = 2 * Math.PI * rnd();
    smoke.push({ sp: sprite(0x8a8580), out: new THREE.Vector3(Math.cos(a), 0.4 + 0.6 * rnd(), Math.sin(a)), delay: 0.004 + 0.02 * rnd(), size: (1.2 + 1.6 * rnd()) * size, speed: (1.5 + 2.5 * rnd()) * size });
  }
  const jets = [];
  parent.add(group);
  const up = new THREE.Vector3(0, 1, 0);
  return {
    t0, c: c.clone(),
    // A jet of smoke and dust out of an opening (a window going) from engine time `at`.
    addJet(pos, dir, at) {
      for (let k = 0; k < 4; ++k) {
        const d = dir.clone().add(new THREE.Vector3(0.5 * (rnd() - 0.5), 0.25 + 0.3 * rnd(), 0.5 * (rnd() - 0.5))).normalize();
        jets.push({ sp: sprite(0x9a948c), at: pos.clone(), dir: d, t0: at - t0 + 0.006 + 0.01 * k + 0.004 * rnd(), reach: 1.4 + 1.8 * rnd(), size: 0.8 + 0.9 * rnd() });
      }
    },
    update(tEng) {
      const t = tEng - t0;
      const fireR = 0.9 * size * (1 - Math.exp(-t / 0.0015)) * (t < 0.03 ? 1 : Math.exp(-(t - 0.03) / 0.04));
      fire.scale.setScalar(Math.max(1e-3, fireR));
      fire.material.opacity = t < 0 ? 0 : Math.min(1, 0.95 * Math.exp(-t / 0.012));
      fire.material.color.setHSL(0.09 - 0.05 * Math.min(1, t / 0.02), 1, 0.75 - 0.35 * Math.min(1, t / 0.02));
      flash.scale.setScalar(t < 0 ? 0 : (2.2 * Math.exp(-t / 0.0015) + 0.25) * size);
      flash.material.opacity = t < 0 ? 0 : Math.exp(-t / 0.004);
      light.intensity = t < 0 ? 0 : 160 * Math.exp(-t / 0.0012) + 12 * Math.exp(-t / 0.03);
      let R = table[table.length - 1][1];
      for (let k = 1; k < table.length; ++k) if (table[k][0] >= t) { const [ta, ra] = table[k - 1], [tb, rb] = table[k]; R = ra + (rb - ra) * (t - ta) / Math.max(1e-9, tb - ta); break; }
      shock.scale.setScalar(Math.max(0.01, R));
      shock.material.uniforms.uA.value = t < 0 || R > 9.5 ? 0 : 0.3 * Math.min(1, 1.2 / Math.max(R, 0.3));
      const pos = tracers.geometry.attributes.position.array;
      dirs.forEach((f, i) => {
        const alive = t >= 0 && f.v * t - 0.25 < f.len;
        const a = alive ? Math.max(0, Math.min(f.len, f.v * t - 0.25)) : 0, b = alive ? Math.min(f.len, f.v * t) : 0;
        pos.set([c.x + f.d.x * a, c.y + f.d.y * a, c.z + f.d.z * a, c.x + f.d.x * b, c.y + f.d.y * b, c.z + f.d.z * b], i * 6);
      });
      tracers.geometry.attributes.position.needsUpdate = true;
      for (const s of smoke) {
        const ts = t - s.delay;
        if (ts < 0) { s.sp.material.opacity = 0; continue; }
        s.sp.position.copy(c).addScaledVector(s.out, s.speed * Math.log(1 + ts / 0.15) * 0.6).addScaledVector(up, 0.25 * ts);
        s.sp.scale.setScalar(0.2 + s.size * (1 - Math.exp(-ts / 0.25)));
        s.sp.material.opacity = 0.55 * Math.min(1, ts / 0.03) * Math.exp(-ts / 3.5);
      }
      for (const j of jets) {
        const ts = t - j.t0;
        if (ts < 0) { j.sp.material.opacity = 0; continue; }
        j.sp.position.copy(j.at).addScaledVector(j.dir, j.reach * (1 - Math.exp(-ts / 0.12))).addScaledVector(up, 0.2 * ts);
        j.sp.scale.setScalar(0.25 + j.size * (1 - Math.exp(-ts / 0.2)));
        j.sp.material.opacity = 0.5 * Math.min(1, ts / 0.01) * Math.exp(-ts / 2.5);
      }
    },
    dispose() {
      parent.remove(group);
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    },
  };
}
