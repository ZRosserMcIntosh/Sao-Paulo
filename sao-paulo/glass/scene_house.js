// Grenade in the house: a scripted scene for the glass lab.
//
// A one-room house with three windows of 6 mm fully tempered glass on every
// wall. Someone outside throws a grenade through the middle front window; it
// bounces round the room and goes off. Every window is one of the engine's
// panes: the grenade breaks the first for real (it can bounce off a weak
// throw), the steel fragments are fired into the windows they reach, and the
// blast wave reaches each window with the pressure, duration and arrival time
// that its distance and angle from the charge give (Kinney-Graham fits for a
// TNT-equivalent charge, normal reflection, and the confined gas of a closed
// room venting through its windows). The engine breaks the panes and blows
// them out; this file only works out the loads and draws the house, the
// throw, the fireball, the shock and the smoke.
//
// Deterministic from the seed: Replay throws the same throw again.

const ROOM = 3.0;                 // m, half the room's inside width
const WALL_T = 0.2;               // m
const ROOM_H = 2.8;               // m
const WIN_U = [-1.8, 0, 1.8];     // m along each wall, window centres
const GLAZING = 'tempered_6';
// Walls by outward normal; the front (+z) faces the thrower.
const WALLS = [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]];
const ENTRY = 1;                  // the rig the grenade goes through: front wall, middle window
const THROWER = [0.7, 0, 8.6];
const HAND = [0.95, 1.78, 8.35];
const T_THROW = 0.2;              // s, engine time the grenade leaves the hand
const FUSE = 2.0;                 // s after the throw (cooked off)
const HIT_SPEED = 20;             // m/s at the glass
// The charge: about 180 g of Composition B in a 400 g steel body.
const CHARGE_TNT = 0.22;          // kg TNT equivalent
const FRAGMENTS = 800;            // effective steel fragments, spread evenly
const FRAG_SPEED = 1400;          // m/s
const P0 = 101325, C0 = 343;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Blast physics (free air, TNT, Kinney & Graham 1985) ----------
// Side-on overpressure (Pa) at scaled distance Z (m/kg^1/3).
function sideOn(Z) {
  const r = 808 * (1 + (Z / 4.5) ** 2) / Math.sqrt((1 + (Z / 0.048) ** 2) * (1 + (Z / 0.32) ** 2) * (1 + (Z / 1.35) ** 2));
  return r * P0;
}
// Positive phase (s) for a W kg charge.
function positivePhase(Z, W) {
  const ms = 980 * (1 + (Z / 0.54) ** 10) / ((1 + (Z / 0.02) ** 3) * (1 + (Z / 0.74) ** 6) * Math.sqrt(1 + (Z / 6.9) ** 2));
  return ms * Math.cbrt(W) * 1e-3;
}
// Side-on impulse (Pa s).
function impulse(Z, W) {
  const barMs = 0.067 * Math.sqrt(1 + (Z / 0.23) ** 4) / (Z * Z * Math.cbrt(1 + (Z / 1.55) ** 3));
  return barMs * Math.cbrt(W) * 100;
}
// Normal reflection of a shock of overpressure p.
function reflected(p) { return 2 * p * (7 * P0 + 4 * p) / (7 * P0 + p); }
// Friedlander decay b that gives impulse I for peak p and duration td.
function decayFor(I, p, td) {
  const f = (b) => 1 / b - (1 - Math.exp(-b)) / (b * b);
  const want = I / (p * td);
  if (want >= f(0.05)) return 0.05;
  let lo = 0.05, hi = 20;
  for (let i = 0; i < 50; ++i) { const m = 0.5 * (lo + hi); if (f(m) > want) lo = m; else hi = m; }
  return 0.5 * (lo + hi);
}
// When the shock reaches distance R (s): its front runs at c0 sqrt(1 + 6p/7P0).
function arrivalTime(R, W) {
  let t = 0;
  const r0 = 0.05, n = 60;
  for (let i = 0; i < n; ++i) {
    const a = r0 + (R - r0) * i / n, b = r0 + (R - r0) * (i + 1) / n, r = 0.5 * (a + b);
    t += (b - a) / (C0 * Math.sqrt(1 + 6 * sideOn(r / Math.cbrt(W)) / (7 * P0)));
  }
  return t;
}
// Quasi-static gas pressure of a charge W kg in a closed volume V m^3 (Pa),
// UFC 3-340-02 fit.
function gasPressure(W, V) { return 2410e3 * Math.pow(W / V, 0.72); }

export function createHouseScene(ctx) {
  const { THREE, scene, camera, cam, applyCamera, FLOOR, G, cat } = ctx;
  const S = {
    active: false, world: null, roof: null, hud: null, saved: null, view: 0, seed: 1,
    rigs: [], grenade: null, det: null, effects: null, stats: null,
  };
  const gIdx = cat.impactors.findIndex((d) => d.id === 'hand_grenade');
  const fIdx = cat.impactors.findIndex((d) => d.id === 'grenade_fragment');
  const glazing = cat.glazings.find((g) => g.id === GLAZING);
  const W = glazing.width, H = glazing.height;

  function canvasTex(w, h, draw, repeat) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
    return t;
  }
  function softDisc() {
    return canvasTex(64, 64, (c, w) => {
      const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, w);
    });
  }

  // ---------- The house ----------
  function wallFrame(n) {
    const N = new THREE.Vector3(...n), U = new THREE.Vector3(0, 1, 0), T = new THREE.Vector3().crossVectors(U, N);
    return { N, U, T };
  }
  // Rig i: wall floor(i / 3), window i % 3. Its group's -Z (the engine's back
  // face) points out of the house, so a blast inside pushes the glass out.
  function windowGroup(i) {
    const { N, T } = wallFrame(WALLS[Math.floor(i / 3)]);
    const g = new THREE.Group();
    const c = N.clone().multiplyScalar(ROOM + WALL_T / 2).addScaledVector(T, WIN_U[i % 3]);
    g.position.set(c.x, 0, c.z);   // pane bottom edge at FLOOR = the sill
    g.rotation.y = Math.atan2(-N.x, -N.z);
    g.updateMatrixWorld(true);
    return g;
  }
  function buildHouse() {
    const hi = ctx.tier >= 2;
    const world = new THREE.Group();
    const plaster = new THREE.MeshStandardMaterial({ color: 0xe9e1d2, roughness: 0.92 });
    const inner = new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.95 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.7 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.6 });
    const fabric = new THREE.MeshStandardMaterial({ color: 0x4d6a86, roughness: 0.95 });
    const shadows = (o) => { o.castShadow = o.receiveShadow = ctx.tier >= 3; return o; };
    // Ground: a lawn and a path to the door side.
    const grass = canvasTex(256, 256, (c, w) => {
      c.fillStyle = '#5f7f3e'; c.fillRect(0, 0, w, w);
      for (let i = 0; i < 2500; ++i) { c.fillStyle = `rgba(${40 + Math.random() * 60},${80 + Math.random() * 70},${20 + Math.random() * 30},0.35)`; c.fillRect(Math.random() * w, Math.random() * w, 2, 3); }
    }, [60, 60]);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ map: grass, roughness: 0.98 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = ctx.tier >= 3;
    world.add(ground);
    const path = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 9), new THREE.MeshStandardMaterial({ color: 0xb9ac98, roughness: 0.95 }));
    path.rotation.x = -Math.PI / 2; path.position.set(0.7, 0.004, 8); world.add(path);
    // Floor inside.
    const boards = canvasTex(256, 256, (c, w) => {
      c.fillStyle = '#b98a5c'; c.fillRect(0, 0, w, w);
      for (let j = 0; j < 8; ++j) { c.fillStyle = `rgba(80,45,20,${0.08 + Math.random() * 0.12})`; c.fillRect(0, j * 32, w, 31); c.fillStyle = 'rgba(40,20,10,0.4)'; c.fillRect(0, j * 32 + 31, w, 1); }
    }, [4, 4]);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * ROOM, 2 * ROOM), new THREE.MeshStandardMaterial({ map: boards, roughness: 0.7,
      polygonOffset: true, polygonOffsetFactor: -1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.001; floor.receiveShadow = ctx.tier >= 3;
    world.add(floor);
    // Walls with their three openings each, a plinth and a roof slab.
    WALLS.forEach((n, wi) => {
      const { N, U, T } = wallFrame(n);
      const half = wi % 2 === 0 ? ROOM + WALL_T : ROOM;   // front and back walls run past the side walls' ends
      const sh = new THREE.Shape();
      sh.moveTo(-half, 0); sh.lineTo(half, 0); sh.lineTo(half, ROOM_H); sh.lineTo(-half, ROOM_H); sh.lineTo(-half, 0);
      for (const u of WIN_U) {
        const hole = new THREE.Path();
        hole.moveTo(u - W / 2, FLOOR); hole.lineTo(u - W / 2, FLOOR + H); hole.lineTo(u + W / 2, FLOOR + H); hole.lineTo(u + W / 2, FLOOR); hole.lineTo(u - W / 2, FLOOR);
        sh.holes.push(hole);
      }
      const geo = new THREE.ExtrudeGeometry(sh, { depth: WALL_T, bevelEnabled: false });
      const m4 = new THREE.Matrix4().makeBasis(T, U, N).setPosition(N.clone().multiplyScalar(ROOM));
      geo.applyMatrix4(m4);
      world.add(shadows(new THREE.Mesh(geo, [plaster, plaster])));
      // Window surrounds: sills outside and in, and a thin frame.
      for (const u of WIN_U) {
        const c = N.clone().multiplyScalar(ROOM + WALL_T / 2).addScaledVector(T, u);
        const box = (w, h, d, off, y, mat) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
          b.position.copy(c).addScaledVector(N, off); b.position.y = y;
          b.rotation.y = Math.atan2(N.x, N.z);
          world.add(shadows(b));
        };
        box(W + 0.16, 0.05, 0.12, WALL_T / 2 + 0.03, FLOOR - 0.025, trim);       // outside sill
        box(W + 0.1, 0.03, 0.1, -WALL_T / 2 - 0.02, FLOOR - 0.015, trim);        // inside sill
        box(W + 0.08, 0.04, WALL_T * 0.6, 0, FLOOR + H + 0.02, trim);             // head
        for (const s of [-1, 1]) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.04, H + 0.08, WALL_T * 0.6), trim);
          b.position.copy(c).addScaledVector(T, s * (W / 2 + 0.02)); b.position.y = FLOOR + H / 2;
          b.rotation.y = Math.atan2(N.x, N.z);
          world.add(b);
        }
      }
    });
    // A dark plinth band round the outside (the floor inside stays at ground level, where the glass lands).
    WALLS.forEach((n, wi) => {
      const { N, T } = wallFrame(n);
      const len = 2 * (ROOM + WALL_T) + 0.04;
      const b = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 0.03), dark);
      b.position.copy(N.clone().multiplyScalar(ROOM + WALL_T + 0.015)); b.position.y = 0.15;
      b.rotation.y = Math.atan2(N.x, N.z);
      world.add(b);
    });
    const roof = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * (ROOM + WALL_T) + 0.5, 0.22, 2 * (ROOM + WALL_T) + 0.5), new THREE.MeshStandardMaterial({ color: 0x8c8378, roughness: 0.9 }));
    slab.position.y = ROOM_H + 0.11;
    roof.add(shadows(slab));
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(2 * ROOM, 2 * ROOM), inner);
    ceiling.rotation.x = Math.PI / 2; ceiling.position.y = ROOM_H - 0.002;
    roof.add(ceiling);
    world.add(roof);
    S.roof = roof;
    // A room's worth of furniture, for scale.
    const furn = (w, h, d, x, y, z, mat, ry = 0) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      b.position.set(x, y, z); b.rotation.y = ry;
      world.add(shadows(b));
      return b;
    };
    furn(1.4, 0.05, 0.8, -1.2, 0.74, -1.3, wood);
    for (const [x, z] of [[-1.82, -1.62], [-0.58, -1.62], [-1.82, -0.98], [-0.58, -0.98]]) furn(0.05, 0.72, 0.05, x, 0.36, z, wood);
    furn(2.0, 0.42, 0.85, 1.6, 0.21, -2.4, fabric); furn(2.0, 0.45, 0.2, 1.6, 0.62, -2.75, fabric);
    furn(1.0, 1.9, 0.35, -2.75, 0.95, 1.0, wood, Math.PI / 2);
    furn(1.6, 0.02, 1.1, 0.4, 0.012, -0.5, new THREE.MeshStandardMaterial({ color: 0x7a3b33, roughness: 1 }));
    // The thrower.
    const suit = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.85 }), skin = new THREE.MeshStandardMaterial({ color: 0x8a6a55, roughness: 0.8 });
    const man = new THREE.Group();
    const limb = (r, len, x, y, z, rx = 0, mat = suit) => { const o = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat); o.position.set(x, y, z); o.rotation.x = rx; man.add(shadows(o)); return o; };
    limb(0.075, 0.72, 0.11, 0.46, 0.1, -0.15); limb(0.075, 0.72, -0.11, 0.46, -0.12, 0.15);
    limb(0.19, 0.36, 0, 1.15, 0).scale.set(1, 1, 0.7);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 18, 14), skin); head.position.set(0, 1.6, 0); man.add(head);
    S.arm = limb(0.05, 0.42, 0.24, 1.4, 0.05, -2.4);
    limb(0.05, 0.36, -0.2, 1.2, 0.1, 0.3);
    man.position.set(...THROWER);
    man.lookAt(0, 0, ROOM);
    world.add(man);
    // Light: afternoon sun and sky.
    const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
    sun.position.set(-14, 22, 16);
    sun.castShadow = ctx.tier >= 3;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 70 });
    world.add(sun);
    world.add(new THREE.HemisphereLight(0xd6e6f6, 0x6c7a4c, hi ? 1.0 : 1.2));
    // Inside: a soft ceiling light so the room is not black.
    const lamp = new THREE.PointLight(0xfff0dd, 6, 9, 2);
    lamp.position.set(0, ROOM_H - 0.3, 0);
    world.add(lamp);
    return world;
  }

  // ---------- The grenade ----------
  function grenadeMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.032, 24, 16), new THREE.MeshStandardMaterial({ color: 0x4b5233, roughness: 0.55, metalness: 0.3 }));
    g.add(body);
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.03, 12), new THREE.MeshStandardMaterial({ color: 0x777b70, metalness: 0.8, roughness: 0.35 }));
    fuse.position.y = 0.04; g.add(fuse);
    g.castShadow = true;
    return g;
  }
  // The throw: a ballistic arc from the hand onto the entry window's outer
  // face, arriving at HIT_SPEED.
  function planThrow(rig) {
    const hitLocal = new THREE.Vector3(0.04 * (S.rnd() - 0.5), FLOOR + H * (0.5 + 0.1 * (S.rnd() - 0.5)), -rig.P.T - 0.032);
    const target = rig.group.localToWorld(hitLocal.clone());
    const p0 = new THREE.Vector3(...HAND), g = new THREE.Vector3(0, -9.81, 0);
    let T = 0.3, v0, v1;
    for (let i = 0; i < 30; ++i) {
      v0 = target.clone().sub(p0).divideScalar(T).addScaledVector(g, -0.5 * T);
      v1 = v0.clone().addScaledVector(g, T);
      T *= Math.pow(v1.length() / HIT_SPEED, 0.7);
    }
    return { p0, v0, v1, T, target, tHit: T_THROW + T, hitPane: { x: hitLocal.x + W / 2, y: hitLocal.y - FLOOR } };
  }
  // Grenade motion after the engine lets go of it: gravity, the floor and
  // (inside) the walls, rolling to a stop.
  function stepGrenade(gr, dt) {
    const r = 0.032;
    gr.vel.y -= 9.81 * dt;
    gr.pos.addScaledVector(gr.vel, dt);
    const inside = Math.abs(gr.pos.x) < ROOM + 0.05 && Math.abs(gr.pos.z) < ROOM + 0.05;
    if (gr.pos.y < r) {
      gr.pos.y = r;
      if (gr.vel.y < 0) gr.vel.y *= -0.3;
      gr.vel.x *= 0.82; gr.vel.z *= 0.82;
      if (Math.abs(gr.vel.y) < 0.2) { gr.vel.y = 0; const k = Math.exp(-2.2 * dt); gr.vel.x *= k; gr.vel.z *= k; }
    }
    if (inside) for (const ax of ['x', 'z']) {
      const lim = ROOM - r;
      if (gr.pos[ax] > lim && gr.vel[ax] > 0) { gr.pos[ax] = lim; gr.vel[ax] *= -0.35; }
      if (gr.pos[ax] < -lim && gr.vel[ax] < 0) { gr.pos[ax] = -lim; gr.vel[ax] *= -0.35; }
    }
    gr.spin += Math.hypot(gr.vel.x, gr.vel.z) / r * dt;
  }

  // ---------- The detonation ----------
  // Loads for every window from the charge at `c` (world), at engine time t.
  function detonate(c, t) {
    const Wt = CHARGE_TNT, inside = Math.abs(c.x) < ROOM && Math.abs(c.z) < ROOM;
    const V = (2 * ROOM) ** 2 * ROOM_H, vent = 12 * W * H;
    const gas = inside ? gasPressure(Wt, V) : 0;
    const gasTau = V / (vent * 150);
    const rnd = mulberry32(S.seed ^ 0xb1a57);
    let peakMax = 0, frags = 0;
    S.rigs.forEach((r, i) => {
      const { N } = wallFrame(WALLS[Math.floor(i / 3)]);
      const centre = r.group.localToWorld(new THREE.Vector3(0, FLOOR + H / 2, 0));
      const d = centre.clone().sub(c), R = Math.max(0.3, d.length()), Z = R / Math.cbrt(Wt);
      // The charge on the room side: pressure pushes the glass out (+);
      // outside, only the windows facing it are loaded, inward.
      const facing = d.clone().normalize().dot(N);           // > 0: the charge is on the inside of this wall
      const sign = inside ? 1 : -1;
      const cosI = Math.abs(facing);
      const ps = sideOn(Z), pr = reflected(ps);
      let peak = ps + (pr - ps) * cosI * cosI;
      if (!inside && facing > 0) peak *= 0.25;                // behind the house: diffracted round it
      const td = positivePhase(Z, Wt), b = decayFor(impulse(Z, Wt) * peak / ps, peak, td);
      const ta = arrivalTime(R, Wt);
      ctx.useRig(r);
      G.gls_blast(t + ta, sign * peak, td, b, sign * gas, 2e-3, gasTau);
      r.blast = { t: t + ta, peak };
      peakMax = Math.max(peakMax, peak);
      // Steel fragments that reach this window: expected count from its solid angle.
      const expect = FRAGMENTS * W * H * cosI / (4 * Math.PI * R * R);
      let n = 0;
      { let L = Math.exp(-expect), p = 1; do { ++n; p *= rnd(); } while (p > L && n < 12); --n; }   // Poisson
      n = Math.min(n, 6);
      for (let k = 0; k < n; ++k) {
        const hx = 0.04 + (W - 0.08) * rnd(), hy = 0.04 + (H - 0.08) * rnd();
        const hit = r.group.localToWorld(new THREE.Vector3(hx - W / 2, hy + FLOOR, 0));
        const dirW = hit.clone().sub(c).normalize();
        const inv = new THREE.Quaternion().copy(r.group.quaternion).invert();
        const dl = dirW.clone().applyQuaternion(inv);
        const back = dl.z > 0;   // travelling against the group's -Z: in from outside
        const dp = back ? [dl.x, dl.y, dl.z] : [dl.x, dl.y, -dl.z];
        if (dp[2] < 0.25) continue;
        const dist = hit.distanceTo(c), lead = 0.9;
        const v = FRAG_SPEED * (0.9 + 0.2 * rnd());
        ctx.insertShot(r, { t: t + Math.max(0, dist - lead) / v, iIdx: fIdx, x: hx, y: hy, speed: v,
          yaw: Math.atan2(dp[0], dp[2]) * 180 / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, dp[1]))) * 180 / Math.PI, fromBack: back });
        ++frags;
      }
    });
    S.stats.peak = peakMax; S.stats.fragments = frags; S.stats.gas = gas;
    S.det = { t, c: c.clone(), inside, shockTable: [] };
    for (let k = 0; k <= 60; ++k) { const R = 0.05 + 10 * (k / 60) ** 1.5; S.det.shockTable.push([arrivalTime(R, Wt), R]); }
    startEffects(c, t);
    if (ctx.soundOn()) ctx.sound.explosion?.(0);
  }

  // ---------- Effects: flash, fireball, shock front, steel, smoke ----------
  function startEffects(c, t) {
    const E = { t, group: new THREE.Group(), smoke: [], tracers: null, dirs: [] };
    const disc = S.disc || (S.disc = softDisc());
    E.light = new THREE.PointLight(0xffd7a0, 0, 30, 2);
    E.light.position.copy(c).add(new THREE.Vector3(0, 0.3, 0));
    E.group.add(E.light);
    E.fire = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    E.fire.position.copy(c);
    E.group.add(E.fire);
    E.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: disc, color: 0xfff3d6, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    E.flash.position.copy(c);
    E.group.add(E.flash);
    // The shock front: a shell, bright where it is seen edge-on.
    E.shock = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uA: { value: 0 } },
      vertexShader: 'varying float vF; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vec3 n = normalize(normalMatrix * normal); vF = 1.0 - abs(dot(n, normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying float vF; uniform float uA; void main(){ gl_FragColor = vec4(vec3(0.85,0.92,1.0), uA * pow(vF, 7.0)); }',
    }));
    E.shock.position.copy(c);
    E.group.add(E.shock);
    // Steel: a spray of glowing streaks in every direction, stopped by the walls.
    const n = 160, pos = new Float32Array(n * 6);
    const rnd = mulberry32(S.seed ^ 0x5c4a);
    for (let i = 0; i < n; ++i) {
      const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), s = Math.sqrt(1 - z * z);
      const d = new THREE.Vector3(s * Math.cos(a), z * 0.8 + 0.1, s * Math.sin(a)).normalize();
      // Where it stops: the room's box (or 25 m outside).
      let tMax = 25;
      if (Math.abs(c.x) < ROOM && Math.abs(c.z) < ROOM) {
        for (const [ax, lo, hi] of [['x', -ROOM, ROOM], ['y', 0, ROOM_H], ['z', -ROOM, ROOM]]) {
          if (d[ax] > 1e-6) tMax = Math.min(tMax, (hi - c[ax]) / d[ax]);
          if (d[ax] < -1e-6) tMax = Math.min(tMax, (lo - c[ax]) / d[ax]);
        }
      } else if (d.y < 0) tMax = Math.min(tMax, -c.y / d.y);
      E.dirs.push({ d, len: Math.max(0.05, tMax), v: FRAG_SPEED * (0.85 + 0.3 * rnd()) });
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    E.tracers = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    E.tracers.frustumCulled = false;
    E.group.add(E.tracers);
    // Smoke: grey puffs that swell and drift up and out of the broken windows.
    for (let i = 0; i < 26; ++i) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: disc, color: 0x8a8580, transparent: true, opacity: 0, depthWrite: false }));
      const a = 2 * Math.PI * rnd(), out = new THREE.Vector3(Math.cos(a), 0.4 + 0.6 * rnd(), Math.sin(a));
      sp.position.copy(c);
      E.smoke.push({ sp, out, delay: 0.004 + 0.02 * rnd(), size: 1.2 + 1.6 * rnd(), speed: 1.5 + 2.5 * rnd() });
      E.group.add(sp);
    }
    S.world.add(E.group);
    S.effects = E;
  }
  function updateEffects(tEng) {
    const E = S.effects;
    if (!E) return;
    const t = tEng - E.t, c = S.det.c;
    // Flash and fireball: a few milliseconds of white-hot gas.
    const fireR = 0.9 * (1 - Math.exp(-t / 0.0015)) * (t < 0.03 ? 1 : Math.exp(-(t - 0.03) / 0.04));
    E.fire.scale.setScalar(Math.max(1e-3, fireR));
    E.fire.material.opacity = t < 0 ? 0 : Math.min(1, 0.95 * Math.exp(-t / 0.012));
    E.fire.material.color.setHSL(0.09 - 0.05 * Math.min(1, t / 0.02), 1, 0.75 - 0.35 * Math.min(1, t / 0.02));
    E.flash.scale.setScalar(t < 0 ? 0 : 2.2 * Math.exp(-t / 0.0015) + 0.25);
    E.flash.material.opacity = t < 0 ? 0 : Math.exp(-t / 0.004);
    E.light.intensity = t < 0 ? 0 : 160 * Math.exp(-t / 0.0012) + 12 * Math.exp(-t / 0.03);
    // Shock: radius from its arrival times.
    const tab = S.det.shockTable;
    let R = tab[tab.length - 1][1];
    for (let k = 1; k < tab.length; ++k) if (tab[k][0] >= t) { const [t0, r0] = tab[k - 1], [t1, r1] = tab[k]; R = r0 + (r1 - r0) * (t - t0) / Math.max(1e-9, t1 - t0); break; }
    E.shock.scale.setScalar(Math.max(0.01, R));
    E.shock.material.uniforms.uA.value = t < 0 || R > 9.5 ? 0 : 0.3 * Math.min(1, 1.2 / Math.max(R, 0.3));
    // Steel streaks: a short glowing segment running out at fragment speed.
    const pos = E.tracers.geometry.attributes.position.array;
    E.dirs.forEach((f, i) => {
      const head = Math.min(f.len, f.v * t), tail = Math.max(0, Math.min(f.len, f.v * t - 0.25));
      const alive = t >= 0 && f.v * t - 0.25 < f.len;
      const a = alive ? tail : 0, b = alive ? head : 0;
      pos.set([c.x + f.d.x * a, c.y + f.d.y * a, c.z + f.d.z * a, c.x + f.d.x * b, c.y + f.d.y * b, c.z + f.d.z * b], i * 6);
    });
    E.tracers.geometry.attributes.position.needsUpdate = true;
    // Smoke.
    for (const s of E.smoke) {
      const ts = t - s.delay;
      if (ts < 0) { s.sp.material.opacity = 0; continue; }
      const grow = 1 - Math.exp(-ts / 0.25);
      s.sp.position.copy(c).addScaledVector(s.out, s.speed * Math.log(1 + ts / 0.15) * 0.6).add(new THREE.Vector3(0, 0.25 * ts, 0));
      s.sp.scale.setScalar(0.2 + s.size * grow);
      s.sp.material.opacity = 0.55 * Math.min(1, ts / 0.03) * Math.exp(-ts / 3.5);
    }
  }
  function clearEffects() {
    if (!S.effects) return;
    S.world.remove(S.effects.group);
    S.effects.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    S.effects = null;
  }

  // ---------- Timeline ----------
  // Bullet time: the scene sets the pace (the engine's own auto would crawl
  // through every window's cracks one after another).
  function timeTarget() {
    const t = S.lastT, entry = ctx.autoTargetOf(S.rigs[ENTRY]);
    if (!S.det) {
      // The throw and the window breaking: the engine's own pace (it slows as
      // the grenade reaches the glass); then the fuse burns in real time and
      // time drags just before it goes.
      const left = S.tDet - t;
      if (left < 0.02) return 1 / 400;
      if (left < 0.3) return 0.1;
      return t < S.plan.tHit + 0.05 ? Math.max(1 / 1500, entry) : Math.max(1 / 40, entry);
    }
    const a = t - S.tDet;
    if (a < 0.010) return 1 / 800;   // steel, then the shock crossing the room, the windows crazing
    if (a < 0.05) return 1 / 120;    // the dice leaving the frames
    if (a < 0.4) return 1 / 15;      // the clouds of glass flying out
    if (a < 1.5) return 1 / 3;
    return 1;
  }



  function hud() {
    if (S.hud) return S.hud;
    const d = document.createElement('div');
    d.id = 'hsHud';
    d.className = 'panel';
    d.setAttribute('role', 'status');
    d.style.cssText = 'position:fixed;left:50%;top:62px;transform:translateX(-50%);z-index:3;display:flex;gap:10px;align-items:center;' +
      'flex-wrap:wrap;justify-content:center;padding:7px 10px;max-width:calc(100% - 24px);font-size:13px';
    d.innerHTML = '<b style="font-family:var(--display,inherit);letter-spacing:.04em">GRENADE IN THE HOUSE</b>' +
      '<span id="hsStats"></span>' +
      '<button id="hsCam" title="Outside, thrower, inside, cutaway (C)">Outside</button>' +
      '<button id="hsMute" aria-pressed="false" title="Sound on / off (M)">Muted</button>' +
      '<button id="hsExit" title="Back to the test frame">Leave</button>';
    document.body.appendChild(d);
    d.querySelector('#hsCam').onclick = () => S.nextView();
    d.querySelector('#hsMute').onclick = () => ctx.toggleSound();
    d.querySelector('#hsExit').onclick = () => ctx.leave();
    S.hud = d;
    S.syncSound();
    return d;
  }
  S.syncSound = () => {
    if (!S.hud) return;
    const on = ctx.soundOn(), b = S.hud.querySelector('#hsMute');
    b.textContent = on ? 'Sound' : 'Muted';
    b.setAttribute('aria-pressed', String(on));
  };

  const VIEWS = [
    ['Outside', [8.6, 4.2, 10.4], [0, 1.3, 0.4]],
    ['Thrower', [2.3, 2.35, 11.8], [0, 1.3, 3.0]],
    ['Inside', [-2.55, 1.65, -2.55], [0.6, 1.0, 1.6]],
    ['Cutaway', [0.01, 12.5, 6.5], [0, 0.4, 0]],
  ];
  function frame() {
    const [name, eye, target] = VIEWS[S.view];
    const v = new THREE.Vector3(...eye).sub(new THREE.Vector3(...target));
    cam.tx = target[0]; cam.ty = target[1]; cam.tz = target[2];
    cam.r = v.length(); cam.phi = Math.acos(v.y / cam.r); cam.theta = Math.atan2(v.x, v.z);
    const across = (deg) => 2 * Math.atan(Math.tan(deg * Math.PI / 360) / Math.max(camera.aspect, 0.3)) * 180 / Math.PI;
    camera.fov = Math.min(95, Math.max(S.view === 2 ? 60 : 45, across(S.view === 2 ? 70 : 50)));
    camera.updateProjectionMatrix();
    applyCamera();
    if (S.roof) S.roof.visible = S.view !== 3;
    if (S.hud) S.hud.querySelector('#hsCam').textContent = name;
  }
  S.frameCamera = frame;
  S.nextView = () => { S.view = (S.view + 1) % VIEWS.length; frame(); };

  // (Re)builds the windows and scripts the throw. Same seed: the same throw.
  function begin(seed) {
    S.seed = seed;
    S.rnd = mulberry32(seed);
    for (const r of S.rigs) S.world.remove(r.group);
    clearEffects();
    const specs = [];
    for (let i = 0; i < 12; ++i) {
      const group = windowGroup(i);
      S.world.add(group);
      // The window the grenade meets gets the finer grid.
      const t = i === ENTRY ? Math.min(ctx.tier, 2) : Math.min(ctx.tier, 1);
      specs.push({ glazing: GLAZING, seed: (seed + 7919 * i) >>> 0, group, tier: t, viewTier: Math.min(ctx.tier, 1) });
    }
    S.rigs = ctx.makeRigs(specs);
    S.plan = planThrow(S.rigs[ENTRY]);
    S.tDet = T_THROW + FUSE;
    S.lastT = 0;
    S.det = null;
    S.stats = { peak: 0, fragments: 0, gas: 0 };
    // The engine takes the grenade 0.3 m before the glass, at the arc's speed and angle.
    const r = S.rigs[ENTRY], v1 = S.plan.v1;
    const inv = new THREE.Quaternion().copy(r.group.quaternion).invert();
    const dl = v1.clone().normalize().applyQuaternion(inv);
    const dp = [dl.x, dl.y, dl.z];   // in from the back face
    const speed = v1.length(), lead = Math.min(0.9, Math.max(0.25, 0.25 + 0.0015 * speed));
    ctx.insertShot(r, { t: S.plan.tHit - lead / speed, iIdx: gIdx, x: S.plan.hitPane.x, y: S.plan.hitPane.y, speed,
      yaw: Math.atan2(dp[0], dp[2]) * 180 / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, dp[1]))) * 180 / Math.PI, fromBack: true });
    S.grenade = { pos: S.plan.p0.clone(), vel: S.plan.v0.clone(), mode: 'hand', spin: 0, k: -1 };
    if (!S.grenadeMesh) S.grenadeMesh = grenadeMesh();
    S.world.add(S.grenadeMesh);
    S.grenadeMesh.visible = true;
    ctx.setClock(() => (S.det ? Infinity : S.tDet), timeTarget);
  }

  S.enter = () => {
    S.active = true;
    if (!S.world) S.world = buildHouse();
    scene.add(S.world);
    S.saved = { bg: scene.background, fog: scene.fog, far: camera.far, near: camera.near, fov: camera.fov };
    scene.background = new THREE.Color(0xa9c9e8);
    scene.fog = new THREE.Fog(0xbcd3ea, 40, 160);
    camera.far = 400; camera.near = 0.02; camera.updateProjectionMatrix();
    for (const o of ctx.labObjects) o.visible = false;
    hud();
    S.hud.style.display = 'flex';
    S.view = 0;
    begin((Math.random() * 1e9) >>> 0);
    ctx.layout();
    frame();
  };
  S.restart = (same) => { if (S.active) begin(same ? S.seed : (Math.random() * 1e9) >>> 0); };

  S.leave = () => {
    if (!S.active) return;
    S.active = false;
    clearEffects();
    for (const r of S.rigs) S.world.remove(r.group);
    S.rigs = [];
    scene.remove(S.world);
    scene.background = S.saved.bg; scene.fog = S.saved.fog;
    camera.far = S.saved.far; camera.near = S.saved.near; camera.fov = S.saved.fov; camera.updateProjectionMatrix();
    for (const o of ctx.labObjects) o.visible = true;
    if (S.hud) S.hud.style.display = 'none';
    ctx.layout();
  };

  // Every frame, after the engine: the grenade, the detonation, the effects, the readout.
  const _w = new THREE.Vector3();
  S.update = (tEng, scale, dt) => {
    if (!S.active || !S.plan) return;
    const prevT = S.lastT;
    S.lastT = tEng;
    const gr = S.grenade, r = S.rigs[ENTRY], P = r.P;
    // The engine's grenade is drawn here, not by the lab.
    for (let k = 0; k < P.nImp; ++k) if (P.shotDefs[k] === gIdx && P.impMeshes[k]) { P.impMeshes[k].visible = false; if (gr.k < 0) gr.k = k; }
    const step = Math.max(0, tEng - prevT);
    if (gr.mode === 'hand') {
      if (tEng < T_THROW) { gr.pos.copy(S.plan.p0); S.arm.rotation.x = -2.4 + 0.6 * Math.min(1, tEng / T_THROW); }
      else {
        const t = tEng - T_THROW;
        gr.pos.copy(S.plan.p0).addScaledVector(S.plan.v0, t).add(new THREE.Vector3(0, -4.905 * t * t, 0));
        S.arm.rotation.x = Math.min(0.6, -1.8 + 12 * t);
        if (gr.k >= 0 && tEng >= S.plan.tHit - 0.02) gr.mode = 'engine';
      }
    }
    if (gr.mode === 'engine') {
      // Follow the engine's grenade through the glass, then take over.
      ctx.useRig(r);
      const imp = G.impactors(P.nImp), o = 20 * gr.k;
      const local = new THREE.Vector3(imp[o] - W / 2, imp[o + 1] + FLOOR, -imp[o + 2]);
      gr.pos.copy(r.group.localToWorld(local));
      gr.vel.set(imp[o + 3], imp[o + 4], -imp[o + 5]).applyQuaternion(r.group.quaternion);
      const z = imp[o + 2], phase = imp[o + 9];
      if (z < -0.12 || (z > P.T + 0.12 && imp[o + 5] > 0) || phase === 4) gr.mode = 'free';
    } else if (gr.mode === 'free' && tEng < S.tDet) {
      // Small fixed steps: the clock can jump a frame's worth in real time.
      let left = Math.min(step, S.tDet - prevT);
      while (left > 1e-9) { const h = Math.min(left, 0.002); stepGrenade(gr, h); left -= h; }
    }
    if (!S.det && tEng >= S.tDet - 1e-9) {
      detonate(gr.pos.clone(), S.tDet);
      S.grenadeMesh.visible = false;
    }
    S.grenadeMesh.position.copy(gr.pos);
    S.grenadeMesh.rotation.set(gr.spin, 0, gr.spin * 0.3);
    updateEffects(tEng);
    // Readout.
    if (S.hud && (S.uiTick = (S.uiTick || 0) + dt) > 0.12) {
      S.uiTick = 0;
      let broken = 0, out = 0;
      for (const rr of S.rigs) {
        ctx.useRig(rr);
        const s = G.state();
        if (s[6]) ++broken;
        if (s[9] > 0.8 * W * H) ++out;
      }
      const t = tEng - S.tDet;
      S.hud.querySelector('#hsStats').textContent = !S.det
        ? (tEng < S.plan.tHit ? 'grenade in the air' : `fuse burning · ${Math.max(0, S.tDet - tEng).toFixed(2)} s`)
        : `${(t * 1000).toFixed(t < 0.1 ? 2 : 0)} ms after it went off · ${broken} of 12 broken · ${out} blown out · peak ${(S.stats.peak / 1000).toFixed(0)} kPa`;
    }
  };

  return S;
}
