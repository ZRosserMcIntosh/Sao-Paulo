// Grenade in the shop: a scripted scene for the glass lab.
//
// A one-room shop at night. Its front is a storefront: four floor-to-ceiling
// panels of 10 mm fully tempered glass, a frameless glass door and a transom
// over it; the other three walls each have three 6 mm tempered windows. A
// crash-test dummy throws a grenade through whichever pane the player taps; it
// rattles round the room and goes off. Every pane is one of the engine's: the
// grenade breaks the first for real (a soft throw can bounce off), the steel
// fragments are fired into the panes they reach, and the blast wave reaches
// each pane with the pressure, duration and arrival time that its distance and
// angle from the charge give (blast.js). The engine breaks the glass and blows
// it out; this file works out the loads, draws the shop, the street, the
// throw and the explosion, and works out what reaches the dummy: the blast,
// the steel and the flying glass.
//
// Deterministic from the seed and the pane picked: Replay throws the same
// throw again.

import { mulberry32, gasPressure, paneLoad, sideOn, positivePhase, fragmentsThrough, createBlastFX } from './blast.js';

const ROOM = 3.0;                 // m, half the room's inside width
const WALL_T = 0.2;               // m
const ROOM_H = 2.8;               // m
const SILL = 0.9;                 // m, side and back windows
// Walls by outward normal; the front (+z) is the storefront, facing the street.
const WALLS = [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]];
// Every pane: wall, centre along it (m), which of the shop's glass it takes,
// its size (m) and the height of its bottom edge.
const PANES = [
  { wall: 0, u: -2.35, role: 'front', w: 1.1, h: 2.55, bottom: 0.1 },
  { wall: 0, u: -1.15, role: 'front', w: 1.1, h: 2.55, bottom: 0.1 },
  { wall: 0, u: 0, role: 'door', w: 0.95, h: 2.1, bottom: 0.03, door: true },
  { wall: 0, u: 0, role: 'transom', w: 0.95, h: 0.45, bottom: 2.2 },
  { wall: 0, u: 1.15, role: 'front', w: 1.1, h: 2.55, bottom: 0.1 },
  { wall: 0, u: 2.35, role: 'front', w: 1.1, h: 2.55, bottom: 0.1 },
];
for (const wall of [1, 2, 3]) for (const u of [-1.8, 0, 1.8]) PANES.push({ wall, u, role: 'window', w: 0.9, h: 1.2, bottom: SILL });
const DOOR = PANES.findIndex((p) => p.door);
// What the shop can be glazed with, by role, each glazing cut to the opening.
// Where the front would stop a thrown grenade (it bounces off, or the
// interlayer catches it) the door is propped open to throw through.
const GLASS = {
  tempered: { label: 'Tempered', front: 'storefront_tempered_10', door: 'glass_door_10', transom: 'transom_tempered_6', window: 'tempered_6' },
  annealed: { label: 'Annealed', front: 'annealed_10', door: 'annealed_10', transom: 'annealed_6', window: 'annealed_6' },
  laminated: { label: 'Laminated', front: 'laminated_10_76', door: 'laminated_10_76', transom: 'laminated_6_38', window: 'laminated_6_38', doorOpen: true },
  hurricane: { label: 'Hurricane', front: 'hurricane', door: 'hurricane', transom: 'hurricane', window: 'hurricane', doorOpen: true },
  armoured: { label: 'Bullet-resistant', front: 'ul752_l3', door: 'ul752_l3', transom: 'ul752_l3', window: 'ul752_l3', doorOpen: true, heavy: true },
};
const DOOR_SWING = 1.75;          // rad the propped door stands open
const DOOR_SPEED = 12;            // m/s, a lob through the open door
const DEFAULT_TARGET = 4;         // right of the door
const STAND_OFF = 5.4;            // m from the wall the dummy throws from
const WINDUP = 0.35;              // s from the tap to the grenade leaving the hand
const FUSE = 1.6;                 // s after the throw (cooked off)
const HIT_SPEED = 25;             // m/s at the glass: a hard throw (10 mm tempered takes it)
// The charge: about 180 g of Composition B in a 400 g steel body.
const CHARGE_TNT = 0.22;          // kg TNT equivalent
const FRAGMENTS = 800;            // effective steel fragments, spread evenly
const FRAG_SPEED = 1400;          // m/s
const FRAG_MASS = 0.0002;         // kg
const FRAG_DECAY = 55;            // m: a 0.2 g splinter's speed falls e-fold over this (air drag)
const LAMPS = [[-5, 9.7], [8.5, 9.7], [-14, 9.7], [18, 9.7]];

export function createHouseScene(ctx) {
  const { THREE, scene, camera, cam, applyCamera, FLOOR, G, cat } = ctx;
  const S = {
    active: false, world: null, roof: null, hud: null, saved: null, view: 0, seed: 1, night: true,
    rigs: [], grenade: null, det: null, effects: null, stats: null, dummy: null, hurt: null, target: DEFAULT_TARGET, plan: null,
    glass: 'tempered',
  };
  const gIdx = cat.impactors.findIndex((d) => d.id === 'hand_grenade');
  const fIdx = cat.impactors.findIndex((d) => d.id === 'grenade_fragment');
  const kind = () => GLASS[S.glass];
  const doorOpen = () => !!kind().doorOpen;
  // All glass: in pieces it falls out of the frame and the room vents through it.
  const solid = (id) => cat.glazings.find((g) => g.id === id).plies.every((p) => p.kind === 'glass');
  // Fully tempered: breaks into dice (sprays), not shards.
  const diced = (id) => cat.glazings.find((g) => g.id === id).plies.some((p) => p.treatment === 'fully tempered');

  function canvasTex(w, h, draw, repeat) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
    return t;
  }
  function wallFrame(n) {
    const N = new THREE.Vector3(...n), U = new THREE.Vector3(0, 1, 0), T = new THREE.Vector3().crossVectors(U, N);
    return { N, U, T };
  }
  // A pane's group: its -Z (the engine's back face) points out of the shop, so
  // a blast inside pushes the glass out; its bottom edge at the pane's height.
  // `open`: swung out about its hinge (the edge at local -x), propped open.
  function paneGroup(p, open = false) {
    const { N, T } = wallFrame(WALLS[p.wall]);
    const g = new THREE.Group();
    const c = N.clone().multiplyScalar(ROOM + WALL_T / 2).addScaledVector(T, p.u);
    g.position.set(c.x, p.bottom - FLOOR, c.z);
    g.rotation.y = Math.atan2(-N.x, -N.z);
    if (open) {
      const hinge = new THREE.Vector3(-p.w / 2, 0, 0).applyQuaternion(g.quaternion).add(g.position);
      for (const a of [DOOR_SWING, -DOOR_SWING]) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a).multiply(g.quaternion);
        const pos = new THREE.Vector3(p.w / 2, 0, 0).applyQuaternion(q).add(hinge);
        if (pos.clone().sub(g.position).dot(N) > 0) { g.quaternion.copy(q); g.position.copy(pos); break; }
      }
    }
    g.updateMatrixWorld(true);
    return g;
  }
  const paneCentre = (r) => r.group.localToWorld(new THREE.Vector3(0, FLOOR + r.spec.h / 2, 0));
  // What a throw at pane i aims at: the pane, or the doorway of the propped door.
  let doorway = null;
  const aimGroup = (i) => (i === DOOR && doorOpen() ? (doorway ||= paneGroup(PANES[DOOR])) : S.rigs[i].group);
  const aimCentre = (i) => aimGroup(i).localToWorld(new THREE.Vector3(0, FLOOR + PANES[i].h / 2, 0));

  // ---------- The shop and the street ----------
  const M = {};
  function buildWorld() {
    const world = new THREE.Group();
    const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...o });
    Object.assign(M, {
      plaster: std(0xe2d9c8), alu: std(0x2b2d31, { metalness: 0.65, roughness: 0.38 }), trim: std(0xf4f4f2, { roughness: 0.5 }),
      wood: std(0x8a5a36, { roughness: 0.6 }), fabric: std(0x4d6a86, { roughness: 0.95 }), rug: std(0x7a3b33, { roughness: 1 }),
      asphalt: std(0x24262a, { roughness: 0.95 }), kerb: std(0x9a968e), pave: std(0xa49c90, { roughness: 0.95 }),
      pole: std(0x3a3d42, { metalness: 0.6, roughness: 0.45 }), shelf: std(0xd9d4ca, { roughness: 0.6 }), roof: std(0x6f6a63), ceiling: std(0xf4efe6, { roughness: 0.95 }),
    });
    const shadows = (o) => { o.castShadow = o.receiveShadow = ctx.tier >= 3; return o; };
    const plane = (w, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = ctx.tier >= 3; world.add(m); return m; };
    // Ground: a lawn round the shop, the pavement, the kerb and the road.
    const grass = canvasTex(256, 256, (c, w) => {
      c.fillStyle = '#5f7f3e'; c.fillRect(0, 0, w, w);
      for (let i = 0; i < 2500; ++i) { c.fillStyle = `rgba(${40 + Math.random() * 60},${80 + Math.random() * 70},${20 + Math.random() * 30},0.35)`; c.fillRect(Math.random() * w, Math.random() * w, 2, 3); }
    }, [60, 60]);
    M.grass = new THREE.MeshStandardMaterial({ map: grass, roughness: 0.98 });
    plane(240, 240, M.grass, 0, 0, 0);
    plane(60, 4.4, M.pave, 0, 0.004, 7.6);
    plane(60, 0.25, M.kerb, 0, 0.012, 9.92);
    plane(80, 8, M.asphalt, 0, 0.003, 14);
    const lines = new THREE.MeshBasicMaterial({ color: 0xd8d2b0 });
    for (let x = -36; x < 36; x += 4) plane(2, 0.12, lines, x, 0.006, 14);
    const boards = canvasTex(256, 256, (c, w) => {
      c.fillStyle = '#b98a5c'; c.fillRect(0, 0, w, w);
      for (let j = 0; j < 8; ++j) { c.fillStyle = `rgba(80,45,20,${0.08 + Math.random() * 0.12})`; c.fillRect(0, j * 32, w, 31); c.fillStyle = 'rgba(40,20,10,0.4)'; c.fillRect(0, j * 32 + 31, w, 1); }
    }, [4, 4]);
    M.floor = new THREE.MeshStandardMaterial({ map: boards, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1 });
    plane(2 * ROOM, 2 * ROOM, M.floor, 0, 0.001, 0);
    // Walls with their openings: the storefront is aluminium mullions round its
    // glass, the others plaster with sills.
    WALLS.forEach((n, wi) => {
      const { N, U, T } = wallFrame(n);
      const half = wi % 2 === 0 ? ROOM + WALL_T : ROOM;
      const sh = new THREE.Shape();
      sh.moveTo(-half, 0); sh.lineTo(half, 0); sh.lineTo(half, ROOM_H); sh.lineTo(-half, ROOM_H); sh.lineTo(-half, 0);
      for (const p of PANES.filter((q) => q.wall === wi)) {
        const hole = new THREE.Path(), x0 = p.u - p.w / 2, x1 = p.u + p.w / 2, y0 = p.bottom, y1 = p.bottom + p.h;
        hole.moveTo(x0, y0); hole.lineTo(x0, y1); hole.lineTo(x1, y1); hole.lineTo(x1, y0); hole.lineTo(x0, y0);
        sh.holes.push(hole);
      }
      const geo = new THREE.ExtrudeGeometry(sh, { depth: WALL_T, bevelEnabled: false });
      geo.applyMatrix4(new THREE.Matrix4().makeBasis(T, U, N).setPosition(N.clone().multiplyScalar(ROOM)));
      const mat = wi === 0 ? M.alu : M.plaster;
      world.add(shadows(new THREE.Mesh(geo, [mat, mat])));
      if (wi === 0) return;
      for (const p of PANES.filter((q) => q.wall === wi)) {
        const c = N.clone().multiplyScalar(ROOM + WALL_T / 2).addScaledVector(T, p.u);
        const box = (w, h, d, off, y) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.trim);
          b.position.copy(c).addScaledVector(N, off); b.position.y = y;
          b.rotation.y = Math.atan2(N.x, N.z);
          world.add(shadows(b));
        };
        box(p.w + 0.16, 0.05, 0.12, WALL_T / 2 + 0.03, p.bottom - 0.025);
        box(p.w + 0.1, 0.03, 0.1, -WALL_T / 2 - 0.02, p.bottom - 0.015);
      }
    });
    const door = PANES.find((p) => p.door);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 10), new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 1, roughness: 0.2 }));
    handle.position.set(door.u - door.w / 2 + 0.12, 1.05, ROOM + WALL_T + 0.05);
    world.add(handle);
    S.handle = handle;
    // Roof, a lit sign over the storefront.
    const roof = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * (ROOM + WALL_T) + 0.5, 0.22, 2 * (ROOM + WALL_T) + 0.5), M.roof);
    slab.position.y = ROOM_H + 0.11;
    roof.add(shadows(slab));
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(2 * ROOM, 2 * ROOM), M.ceiling);
    ceiling.rotation.x = Math.PI / 2; ceiling.position.y = ROOM_H - 0.002;
    roof.add(ceiling);
    world.add(roof);
    S.roof = roof;
    const signTex = canvasTex(1024, 160, (c, w, h) => {
      c.fillStyle = '#0d1a33'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#f2f4f8'; c.font = '900 78px "Big Shoulders Display", Impact, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('SÃO PAULO GLASS CO.', w / 2, h / 2 + 4);
    });
    M.sign = new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 1.2, roughness: 0.4 });
    const sign = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.62, 0.08), [M.alu, M.alu, M.alu, M.alu, M.sign, M.alu]);
    sign.position.set(0, ROOM_H + 0.55, ROOM + WALL_T + 0.2);
    roof.add(sign);   // goes with the roof in the cutaway
    // A shop's worth of furniture: counter, shelves, a rug, a sofa.
    const furn = (w, h, d, x, y, z, mat, ry = 0) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      b.position.set(x, y, z); b.rotation.y = ry;
      world.add(shadows(b));
    };
    furn(2.2, 0.95, 0.6, -1.0, 0.475, -1.6, M.wood);
    for (const x of [-2.4, -1.2, 0, 1.2]) furn(1.0, 1.9, 0.35, x, 0.95, -2.75, M.shelf);
    furn(2.0, 0.42, 0.85, 1.9, 0.21, 0.2, M.fabric, Math.PI / 2); furn(2.0, 0.45, 0.2, 2.25, 0.62, 0.2, M.fabric, Math.PI / 2);
    furn(1.6, 0.02, 1.1, 0.0, 0.012, 0.6, M.rug);
    // Street lights: a pole, an arm, a glowing head, a light.
    S.lamps = [];
    for (const [x, z] of LAMPS) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 6, 12), M.pole);
      p.position.set(x, 3, z); world.add(p);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.4), M.pole);
      arm.position.set(x, 5.9, z - 0.65); world.add(arm);
      const headMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xffd7a0, emissiveIntensity: 0 });
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.28), headMat);
      head.position.set(x, 5.83, z - 1.3); world.add(head);
      const light = new THREE.PointLight(0xffd2a0, 0, 26, 1.6);
      light.position.set(x, 5.6, z - 1.3); world.add(light);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex(), color: 0xffd9a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.position.copy(light.position); glow.scale.setScalar(1.6); world.add(glow);
      S.lamps.push({ headMat, light, glow });
    }
    S.sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
    S.sun.position.set(-14, 22, 16);
    S.sun.castShadow = ctx.tier >= 3;
    S.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(S.sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 80 });
    world.add(S.sun);
    S.hemi = new THREE.HemisphereLight(0xd6e6f6, 0x6c7a4c, 1.1);
    world.add(S.hemi);
    S.shopLights = [[-1.2, -0.6], [1.2, 0.8]].map(([x, z]) => { const l = new THREE.PointLight(0xffe4bd, 6, 10, 1.8); l.position.set(x, ROOM_H - 0.25, z); world.add(l); return l; });
    S.dummy = buildDummy();
    world.add(S.dummy.root);
    // The picked pane: a soft outline.
    S.pickRing = new THREE.Group();
    const gold = new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.9, depthWrite: false });
    for (let k = 0; k < 4; ++k) S.pickRing.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.01), gold));
    world.add(S.pickRing);
    return world;
  }
  let dot = null;
  function dotTex() {
    return dot ||= canvasTex(64, 64, (c, w) => {
      const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, w);
    });
  }

  // ---------- Day and night ----------
  // At night the street lamps and the shop's lights are the only light, and the
  // glass reflects a night sky with the lamps in it: every shard glints.
  let nightEnv = null;
  function makeNightEnv() {
    if (nightEnv || !ctx.renderer) return nightEnv;
    const es = new THREE.Scene();
    es.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = mix(vec3(0.02,0.025,0.035), vec3(0.05,0.07,0.12), smoothstep(-0.1,0.6,h)); c += vec3(0.10,0.08,0.06) * exp(-abs(h) * 14.0); gl_FragColor = vec4(c,1.0); }',
    })));
    const bulb = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 7, 5) });
    for (const [x, z] of LAMPS) { const b = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), bulb); b.position.set(x * 2, 12, z * 2 - 6); es.add(b); }
    const win = new THREE.Mesh(new THREE.PlaneGeometry(14, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, 1.2), side: THREE.DoubleSide }));
    win.position.set(0, 2, -30); es.add(win);
    const pm = new THREE.PMREMGenerator(ctx.renderer);
    nightEnv = pm.fromScene(es, 0.02).texture;
    pm.dispose();
    return nightEnv;
  }
  function applyLight() {
    const n = S.night;
    scene.background = new THREE.Color(n ? 0x05080f : 0xa9c9e8);
    scene.fog = new THREE.Fog(n ? 0x070b14 : 0xbcd3ea, n ? 30 : 40, n ? 120 : 160);
    scene.environment = n ? (makeNightEnv() || S.saved.env) : S.saved.env;
    S.sun.color.set(n ? 0x8fa6ff : 0xfff1dc); S.sun.intensity = n ? 0.25 : 3.0;
    S.hemi.color.set(n ? 0x1c2741 : 0xd6e6f6); S.hemi.groundColor.set(n ? 0x0b0c0f : 0x6c7a4c); S.hemi.intensity = n ? 0.35 : 1.1;
    for (const l of S.lamps) { l.light.intensity = n ? 55 : 0; l.headMat.emissiveIntensity = n ? 3 : 0; l.glow.material.opacity = n ? 0.85 : 0; }
    for (const l of S.shopLights) l.intensity = n ? 14 : 5;
    M.sign.emissiveIntensity = n ? 1.4 : 0.15;
    // Walls and ground take little of the environment at night; the glass a lot.
    for (const m of Object.values(M)) if (m !== M.sign && 'envMapIntensity' in m) m.envMapIntensity = n ? 0.12 : 1;
    if (S.hud) S.hud.querySelector('#hsNight').textContent = n ? 'Night' : 'Day';
  }

  // ---------- The crash dummy ----------
  function buildDummy() {
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c51b, roughness: 0.55 });
    const black = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.6 });
    const head = canvasTex(128, 64, (g) => {
      g.fillStyle = '#f2c51b'; g.fillRect(0, 0, 128, 64);
      for (const cx of [32, 96]) {
        g.fillStyle = '#111';
        g.beginPath(); g.moveTo(cx, 32); g.arc(cx, 32, 14, 0, Math.PI / 2); g.fill();
        g.beginPath(); g.moveTo(cx, 32); g.arc(cx, 32, 14, Math.PI, Math.PI * 1.5); g.fill();
        g.strokeStyle = '#111'; g.lineWidth = 2; g.beginPath(); g.arc(cx, 32, 14, 0, Math.PI * 2); g.stroke();
      }
    });
    const root = new THREE.Group();
    const seg = (a, b, r, m, parent = root) => {
      const pa = new THREE.Vector3(...a), pb = new THREE.Vector3(...b), d = pb.clone().sub(pa), len = d.length();
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 10), m);
      mesh.position.copy(pa).addScaledVector(d, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      mesh.castShadow = ctx.tier >= 3;
      parent.add(mesh);
    };
    const joint = (p, r, parent = root) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), black); m.position.set(...p); parent.add(m); };
    for (const s of [-1, 1]) {
      seg([0.1 * s, 0.95, 0], [0.11 * s, 0.5, 0.04 * s], 0.075, yellow); joint([0.11 * s, 0.5, 0.04 * s], 0.06);
      seg([0.11 * s, 0.5, 0.04 * s], [0.12 * s, 0.08, -0.02], 0.06, yellow);
      seg([0.12 * s, 0.05, -0.04], [0.12 * s, 0.05, 0.12], 0.045, black);
    }
    joint([0, 0.98, 0], 0.12);
    seg([0, 1.0, 0], [0, 1.45, -0.02], 0.15, yellow);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 6, 20), new THREE.MeshStandardMaterial({ color: 0x2fbf71, roughness: 0.5 }));
    band.position.set(0, 1.22, 0); band.rotation.x = Math.PI / 2; root.add(band);
    joint([0, 1.58, 0], 0.04);
    seg([0, 1.55, 0], [0, 1.64, 0], 0.035, black);
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), new THREE.MeshStandardMaterial({ map: head, roughness: 0.5 }));
    h.scale.set(0.92, 1.18, 1); h.position.set(0, 1.75, 0.01); h.rotation.y = Math.PI / 2; h.castShadow = ctx.tier >= 3; root.add(h);
    joint([0.22, 1.47, 0], 0.055);
    seg([0.22, 1.47, 0], [0.26, 1.12, 0.04], 0.045, yellow); seg([0.26, 1.12, 0.04], [0.27, 0.86, 0.1], 0.04, yellow);
    // The right arm (it faces +z, so its right is -x) throws, pivoting at the
    // shoulder: rotation.x turns the hanging arm forward and up over the top.
    const shoulder = new THREE.Group(); shoulder.position.set(-0.22, 1.47, 0); root.add(shoulder);
    joint([0, 0, 0], 0.055, shoulder);
    seg([0, 0, 0], [-0.02, -0.33, 0.02], 0.045, yellow, shoulder); seg([-0.02, -0.33, 0.02], [-0.02, -0.6, 0], 0.04, yellow, shoulder);
    const marks = new THREE.Group(); root.add(marks);
    return { root, shoulder, band, marks };
  }
  // Where the dummy stands to throw at pane p: out from its wall, facing it.
  function placeDummy(p) {
    const { N, T } = wallFrame(WALLS[p.wall]);
    const at = N.clone().multiplyScalar(ROOM + WALL_T + STAND_OFF).addScaledVector(T, p.u + 0.15);
    S.dummy.root.position.set(at.x, 0, at.z);
    const aim = N.clone().multiplyScalar(ROOM).addScaledVector(T, p.u);
    S.dummy.root.lookAt(aim.x, 0, aim.z);
    S.dummy.root.updateMatrixWorld(true);
  }
  function markHit(y, side, steel) {
    const r = y > 1.62 ? 0.1 : y > 0.98 ? 0.15 : 0.07;
    const m = new THREE.Mesh(new THREE.SphereGeometry(steel ? 0.022 : 0.012, 8, 6), new THREE.MeshBasicMaterial({ color: steel ? 0xd01818 : 0x7fb4d6 }));
    m.position.set(Math.sin(side) * r, y, Math.cos(side) * r);
    S.dummy.marks.add(m);
  }

  // ---------- The grenade ----------
  function grenadeMesh() {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.032, 24, 16), new THREE.MeshStandardMaterial({ color: 0x4b5233, roughness: 0.55, metalness: 0.3 })));
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.03, 12), new THREE.MeshStandardMaterial({ color: 0x777b70, metalness: 0.8, roughness: 0.35 }));
    fuse.position.y = 0.04; g.add(fuse);
    return g;
  }
  // The arm's angle: cocked behind the head while it waits, drawn back, swung
  // over the top to let go up and forward, then followed through.
  const ARM_READY = 2.3, ARM_BACK = 1.9, ARM_RELEASE = 3.9, ARM_FOLLOW = 5.0;
  const handPos = () => {
    const a = S.dummy.shoulder.rotation.x;
    return S.dummy.root.localToWorld(new THREE.Vector3(-0.24, 1.47 - 0.62 * Math.cos(a), -0.62 * Math.sin(a)));
  };
  // The throw: a ballistic arc from the hand onto the pane's outer face.
  // Through the propped door: a lob that lands about a metre inside.
  function planThrow(i, tThrow) {
    const open = i === DOOR && doorOpen();
    let target, hitPane = null;
    if (open) {
      target = aimGroup(i).localToWorld(new THREE.Vector3(0.1 * (S.rnd() - 0.5), FLOOR + 1.0, 0.8));
    } else {
      const rig = S.rigs[i];
      const hitLocal = new THREE.Vector3(0.06 * (S.rnd() - 0.5), FLOOR + Math.min(1.25 - rig.spec.bottom, rig.spec.h * 0.55) + 0.1 * (S.rnd() - 0.5), -rig.P.T - 0.032);
      hitLocal.y = Math.min(Math.max(hitLocal.y, FLOOR + 0.12), FLOOR + rig.spec.h - 0.12);
      target = rig.group.localToWorld(hitLocal.clone());
      hitPane = { x: hitLocal.x + rig.spec.w / 2, y: hitLocal.y - FLOOR };
    }
    const speed = open ? DOOR_SPEED : HIT_SPEED;
    S.dummy.shoulder.rotation.x = ARM_RELEASE;
    const hand = handPos(), g = new THREE.Vector3(0, -9.81, 0);
    let T = 0.25, v0, v1;
    for (let k = 0; k < 30; ++k) {
      v0 = target.clone().sub(hand).divideScalar(T).addScaledVector(g, -0.5 * T);
      v1 = v0.clone().addScaledVector(g, T);
      T *= Math.pow(v1.length() / speed, 0.7);
    }
    return { p0: hand, v0, v1, T, tThrow, tHit: tThrow + T, hitPane, open, target };
  }
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
  function detonate(c, t) {
    const Wt = CHARGE_TNT, inside = Math.abs(c.x) < ROOM && Math.abs(c.z) < ROOM;
    // The room vents through what falls out of its frame (all-glass panes) and the propped door.
    const V = (2 * ROOM) ** 2 * ROOM_H;
    const vent = Math.max(0.05, PANES.reduce((a, p, i) => a + ((i === DOOR && doorOpen()) || solid(kind()[p.role]) ? p.w * p.h : 0), 0));
    const gas = inside ? gasPressure(Wt, V) : 0, gasTau = V / (vent * 150);
    const rnd = mulberry32(S.seed ^ 0xb1a57);
    let peakMax = 0, frags = 0;
    S.effects = createBlastFX(THREE, S.world, c, t, { W: Wt, seed: S.seed, fragSpeed: FRAG_SPEED, room: { lo: [-ROOM, 0, -ROOM], hi: [ROOM, ROOM_H, ROOM] } });
    S.rigs.forEach((r) => {
      const { w, h } = r.spec, N = new THREE.Vector3(0, 0, -1).applyQuaternion(r.group.quaternion);  // out of its outer face
      const centre = paneCentre(r), d = centre.clone().sub(c), R = Math.max(0.3, d.length());
      const facing = d.clone().normalize().dot(N), cosI = Math.abs(facing);
      // From inside, each pane is pushed away from the charge (the propped door
      // stands outside, side-on); from outside, every pane is pushed in.
      const sign = inside && facing > 0 ? 1 : -1;
      const L = paneLoad(Wt, R, cosI);
      if (!inside && facing > 0) L.peak *= 0.25;      // behind the shop: diffracted round it
      const g = inside && !(r.spec.door && doorOpen()) ? gas : 0;   // the room's gas only on its own walls
      ctx.useRig(r);
      G.gls_blast(t + L.arrival, sign * L.peak, L.td, L.decay, g, 2e-3, gasTau);
      r.blast = { t: t + L.arrival, peak: L.peak };
      peakMax = Math.max(peakMax, L.peak);
      S.effects.addJet(centre, N, t + L.arrival);
      const n = fragmentsThrough(rnd, FRAGMENTS, w * h, cosI, R, 6);
      for (let k = 0; k < n; ++k) {
        const hx = 0.04 + (w - 0.08) * rnd(), hy = 0.04 + (h - 0.08) * rnd();
        const hit = r.group.localToWorld(new THREE.Vector3(hx - w / 2, hy + FLOOR, 0));
        const dl = hit.clone().sub(c).normalize().applyQuaternion(new THREE.Quaternion().copy(r.group.quaternion).invert());
        const back = dl.z > 0;
        const dp = back ? [dl.x, dl.y, dl.z] : [dl.x, dl.y, -dl.z];
        if (dp[2] < 0.25) continue;
        const dist = hit.distanceTo(c), v = FRAG_SPEED * (0.9 + 0.2 * rnd());
        ctx.insertShot(r, { t: t + Math.max(0, dist - 0.9) / v, iIdx: fIdx, x: hx, y: hy, speed: v,
          yaw: Math.atan2(dp[0], dp[2]) * 180 / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, dp[1]))) * 180 / Math.PI, fromBack: back });
        ++frags;
      }
    });
    S.stats = { peak: peakMax, fragments: frags, gas };
    S.det = { t, c: c.clone(), inside };
    planInjuries(c, t, inside, rnd);
    if (ctx.soundOn()) ctx.sound.explosion?.(0);
  }
  function clearEffects() {
    if (S.effects) S.effects.dispose();
    S.effects = null;
  }

  // ---------- What reaches the dummy ----------
  // Blast: the free-air shock at its distance, with the shop's wall (mostly
  // glass in front, going as the shock arrives) passing about 60 % of it.
  // Eardrum rupture by the Eisenberg probit, Y = -12.6 + 1.524 ln p; lungs
  // against the ~70 kPa threshold of the Bowen curves. Steel: a Poisson draw
  // for the fragments its frontal area (0.55 m^2) catches, each slowed by drag
  // over the distance, against the 79 J incapacitation criterion. Glass: every
  // spray of dice from its side of the shop flown ballistically to see whether
  // it crosses the dummy.
  function planInjuries(c, t, inside, rnd) {
    const chest = S.dummy.root.localToWorld(new THREE.Vector3(0, 1.3, 0));
    const R = chest.distanceTo(c), Z = R / Math.cbrt(CHARGE_TNT);
    // Inside, the shop's walls stand between: most of a glass front is gone by
    // the time the shock gets there, but glass that holds leaves only the door.
    const p = sideOn(Z) * (inside ? (doorOpen() ? 0.35 : 0.6) : 1), td = positivePhase(Z, CHARGE_TNT);
    const ear = phi(-12.6 + 1.524 * Math.log(p) - 5);
    const tShock = t + R / (343 * Math.sqrt(1 + 6 * p / (7 * 101325)));
    const steel = [];
    const n = shielded(c, chest) ? 0 : fragmentsThrough(rnd, FRAGMENTS, 0.55, 1, R, 8);
    for (let k = 0; k < n; ++k) {
      const v = FRAG_SPEED * (0.85 + 0.3 * rnd()) * Math.exp(-R / FRAG_DECAY);
      steel.push({ t: t + R / v, v, E: 0.5 * FRAG_MASS * v * v, y: 0.15 + 1.65 * rnd(), side: (rnd() - 0.5) * 1.6, shown: false });
    }
    S.hurt = { R, p, td, ear, lungs: p > 70e3, tShock, steel, glass: 0, glassMax: 0, read: new Map(), pending: [],
      shards: 0, shardMax: 0, seen: new Map(), shardTick: 0 };
  }
  // Whether walls, or glass that holds (laminates), stand between from and to:
  // steel goes through all-glass panes (they shatter) and the open door.
  function shielded(from, to) {
    const mid = ROOM + WALL_T / 2, x = new THREE.Vector3();
    for (let wi = 0; wi < 4; ++wi) {
      const { N, T } = wallFrame(WALLS[wi]), a = from.dot(N) - mid, b = to.dot(N) - mid;
      if ((a > 0) === (b > 0)) continue;
      x.copy(from).lerp(to, a / (a - b));
      const u = x.dot(T), y = x.y;
      if (y < 0 || y > ROOM_H || Math.abs(u) > ROOM + WALL_T) continue;
      const i = PANES.findIndex((p) => p.wall === wi && Math.abs(u - p.u) < p.w / 2 && y > p.bottom && y < p.bottom + p.h);
      if (i < 0 || !((i === DOOR && doorOpen()) || solid(kind()[PANES[i].role]))) return true;
    }
    return false;
  }
  function phi(x) {
    const a = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * a);
    const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496735) * t + 0.254829592) * t * Math.exp(-a * a);
    return 0.5 * (1 + Math.sign(x) * e);
  }
  const _p = new THREE.Vector3(), _v = new THREE.Vector3();
  // Flies a piece from p at v (world) and returns the time it crosses the
  // dummy, or -1.
  function crossesDummy(p, v) {
    const base = S.dummy.root.position;
    for (let s = 0.005; s < 1.5; s += 0.005) {
      const x = p.x + v.x * s, y = p.y + v.y * s - 4.905 * s * s, z = p.z + v.z * s;
      if (y < 0) return -1;
      if (Math.hypot(x - base.x, z - base.z) < 0.28 && y < 1.85) return s;
    }
    return -1;
  }
  function markLater(t, s) {
    const at = _p.clone().addScaledVector(_v, s), y = at.y - 4.905 * s * s;
    const local = S.dummy.root.worldToLocal(at.setY(y));
    S.hurt.pending.push({ t: t + s, y, side: Math.atan2(local.x, local.z) });
  }
  function glassAtDummy(tEng, dt) {
    const H = S.hurt, wall = PANES[S.target].wall;
    // Shards of annealed (and heat-strengthened) glass fly as whole pieces:
    // each new loose one on the dummy's side is flown to see whether it hits.
    const shardsDue = (H.shardTick += dt) > 0.05;
    if (shardsDue) H.shardTick = 0;
    for (const r of S.rigs) {
      if (r.spec.wall !== wall) continue;
      ctx.useRig(r);
      const nf = shardsDue && !diced(r.spec.glazing) ? G.state()[4] : 0;
      if (nf) {
        const poses = G.fragmentPoses(nf), seen = H.seen.get(r) || new Set();
        H.seen.set(r, seen);
        for (let i = 0; i < nf; ++i) {
          const q = 12 * i;
          if (poses[q + 10] !== 2 || seen.has(i)) continue;
          const vx = poses[q + 7], vy = poses[q + 8], vz = poses[q + 9];
          if (vx * vx + vy * vy + vz * vz < 9) continue;
          seen.add(i);
          _p.set(poses[q] - r.spec.w / 2, poses[q + 1] + FLOOR, -poses[q + 2]); r.group.localToWorld(_p);
          _v.set(vx, vy, -vz).applyQuaternion(r.group.quaternion);
          const s = crossesDummy(_p, _v);
          if (s < 0) continue;
          ++H.shards;
          H.shardMax = Math.max(H.shardMax, Math.hypot(_v.x, _v.y - 9.81 * s, _v.z));
          markLater(tEng, s);
        }
      }
      const n = G.state()[24], from = H.read.get(r) || 0;
      if (n <= from) continue;
      const rows = G.sprays(from).slice();
      H.read.set(r, n);
      for (let o = 0; o + 14 < rows.length; o += 15) {
        _p.set(rows[o] - r.spec.w / 2, rows[o + 1] + FLOOR, -rows[o + 2]); r.group.localToWorld(_p);
        _v.set(rows[o + 3], rows[o + 4], -rows[o + 5]).applyQuaternion(r.group.quaternion);
        const s = crossesDummy(_p, _v);
        if (s < 0) continue;
        H.glass += Math.max(1, Math.round(rows[o + 6] * 0.35));
        H.glassMax = Math.max(H.glassMax, Math.hypot(_v.x, _v.y - 9.81 * s, _v.z));
        markLater(rows[o + 9], s);
      }
    }
    H.pending = H.pending.filter((h) => { if (h.t > tEng) return true; markHit(h.y, h.side, false); return false; });
  }
  function injuryReport(tEng) {
    const H = S.hurt;
    for (const s of H.steel) if (!s.shown && tEng >= s.t) { s.shown = true; markHit(s.y, s.side, true); }
    const shock = tEng >= H.tShock, hits = H.steel.filter((s) => s.shown);
    const lines = [];
    lines.push(shock ? `Blast: ${(H.p / 1000).toFixed(H.p < 1e4 ? 1 : 0)} kPa (${(H.p / 6894.76).toFixed(1)} psi) for ${(H.td * 1000).toFixed(1)} ms · eardrum rupture ${(100 * H.ear).toFixed(H.ear < 0.1 ? 1 : 0)} % · lungs ${H.lungs ? 'injured (over ~70 kPa)' : 'below the injury threshold'}` : 'Blast: on its way');
    lines.push(hits.length ? `Steel: ${hits.length} fragment${hits.length > 1 ? 's' : ''}, up to ${Math.max(...hits.map((s) => s.v)).toFixed(0)} m/s and ${Math.max(...hits.map((s) => s.E)).toFixed(0)} J (${hits.filter((s) => s.E > 79).length} over the 79 J incapacitation mark)` : H.steel.length && hits.length < H.steel.length ? 'Steel: on its way' : 'Steel: none hit it');
    const glass = [];
    if (H.glass) glass.push(`about ${H.glass} tempered dice, up to ${H.glassMax.toFixed(0)} m/s (blunt cubes: bruises and shallow cuts)`);
    if (H.shards) glass.push(`${H.shards} shard${H.shards > 1 ? 's' : ''} of annealed glass, up to ${H.shardMax.toFixed(0)} m/s (sharp blades: deep cuts)`);
    lines.push(glass.length ? 'Glass: ' + glass.join('; ') : 'Glass: none has reached it');
    const sev = (hits.some((s) => s.E > 79) || (shock && H.lungs)) ? 3 : (hits.length || H.shards || (shock && H.ear > 0.2)) ? 2 : (H.glass || (shock && H.ear > 0.01)) ? 1 : 0;
    S.dummy.band.material.color.set(['#2fbf71', '#f0c419', '#ff8a2a', '#e5383b'][sev]);
    return lines;
  }

  // ---------- Timeline ----------
  // Waiting for a pick: real time. The grenade flies from the hand at full
  // speed and slows only as it reaches the glass; the fuse burns in real time;
  // bullet time round the explosion.
  function timeTarget() {
    const t = S.lastT;
    if (!S.plan) return 1;
    if (!S.det) {
      if (S.tDet - t < 0.004) return 1 / 300;
      if (S.plan.open) return 1;   // nothing to break on the way in
      const toGlass = S.plan.tHit - t;
      if (toGlass > 0.03) return 1;
      if (t < S.plan.tHit + 0.03) return Math.max(1 / 40, ctx.autoTargetOf(S.rigs[S.target]));
      return 1;
    }
    const a = t - S.tDet;
    if (a < 0.006) return 1 / 600;
    if (a < 0.03) return 1 / 100;
    if (a < 0.4) return 1 / 12;
    if (a < 1.4) return 1 / 3;
    return 1;
  }

  // ---------- Picking a pane and throwing ----------
  const ray = new THREE.Raycaster();
  function paneUnder(ndcX, ndcY) {
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    let best = -1, bestD = Infinity;
    PANES.forEach((p, i) => {
      if (!S.rigs[i]) return;
      const inv = new THREE.Matrix4().copy(aimGroup(i).matrixWorld).invert();
      const o = ray.ray.origin.clone().applyMatrix4(inv), d = ray.ray.direction.clone().transformDirection(inv);
      if (Math.abs(d.z) < 1e-6) return;
      const k = -o.z / d.z;
      if (k <= 0 || k >= bestD) return;
      const x = o.x + d.x * k, y = o.y + d.y * k - FLOOR;
      if (Math.abs(x) <= p.w / 2 && y >= 0 && y <= p.h) { best = i; bestD = k; }
    });
    return best;
  }
  function showPick() {
    const i = S.target, p = PANES[i];
    S.pickRing.visible = !S.plan;
    if (!S.rigs[i]) return;
    // A gold frame just outside the wall, round the opening.
    S.pickRing.position.copy(aimCentre(i)).addScaledVector(wallFrame(WALLS[p.wall]).N, WALL_T / 2 + 0.03);
    S.pickRing.quaternion.copy(aimGroup(i).quaternion);
    const { w, h } = p, b = 0.035, [top, bot, left, right] = S.pickRing.children;
    top.scale.set(w + 2 * b, b, 1); top.position.set(0, (h + b) / 2, 0);
    bot.scale.set(w + 2 * b, b, 1); bot.position.set(0, -(h + b) / 2, 0);
    left.scale.set(b, h, 1); left.position.set(-(w + b) / 2, 0, 0);
    right.scale.set(b, h, 1); right.position.set((w + b) / 2, 0, 0);
  }
  // A tap on the scene: a pane picks the target and throws at it.
  S.pick = (ndcX, ndcY) => {
    if (!S.active || S.plan) return false;
    const i = paneUnder(ndcX, ndcY);
    if (i < 0) return false;
    S.throwAt(i);
    return true;
  };
  S.throwAt = (i = S.target) => {
    if (S.plan) return;
    S.target = i;
    placeDummy(PANES[i]);
    showPick();
    const t0 = S.lastT + WINDUP;
    S.plan = planThrow(i, t0);
    S.tDet = t0 + FUSE;
    S.pickRing.visible = false;
    const r = S.rigs[i], v1 = S.plan.v1;
    if (!S.plan.open) {
      // The engine takes the grenade over just before it reaches the glass.
      const dl = v1.clone().normalize().applyQuaternion(new THREE.Quaternion().copy(r.group.quaternion).invert());
      const speed = v1.length(), lead = Math.min(0.9, Math.max(0.25, 0.25 + 0.0015 * speed));
      ctx.insertShot(r, { t: S.plan.tHit - lead / speed, iIdx: gIdx, x: S.plan.hitPane.x, y: S.plan.hitPane.y, speed,
        yaw: Math.atan2(dl.x, dl.z) * 180 / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, dl.y))) * 180 / Math.PI, fromBack: true });
    }
    S.grenade = { pos: handPos(), vel: new THREE.Vector3(), mode: 'hand', spin: 0, k: -1, rig: r };
    S.grenadeMesh.visible = true;
    S.hud.querySelector('#hsThrow').disabled = true;
    frame();
  };

  // ---------- Detail by view ----------
  // A few times a second every pane gets a level of detail from where the
  // camera is: 0 when it is out of the picture or every line of sight to it
  // goes through a wall or the roof, 1 when it is small on the screen, 2
  // otherwise (and always for the pane thrown through). app.js draws a pane
  // at 0 not at all and updates it every eighth frame, one at 1 every other
  // frame; the physics doesn't change.
  const FR = WALLS.map(wallFrame), _fr = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere();
  const _a = new THREE.Vector3(), _q = new THREE.Vector3(), _x = new THREE.Vector3();
  function blocked(from, to, own) {
    const mid = ROOM + WALL_T / 2;
    for (let wi = 0; wi < 4; ++wi) {
      if (wi === own) continue;
      const { N, T } = FR[wi], a = from.dot(N) - mid, b = to.dot(N) - mid;
      if ((a > 0) === (b > 0)) continue;
      _x.copy(from).lerp(to, a / (a - b));
      const u = _x.dot(T), y = _x.y;
      if (y < 0 || y > ROOM_H || Math.abs(u) > ROOM + WALL_T) continue;
      if (!PANES.some((p) => p.wall === wi && Math.abs(u - p.u) < p.w / 2 && y > p.bottom && y < p.bottom + p.h)) return true;
    }
    if (S.roof.visible && (from.y - ROOM_H) * (to.y - ROOM_H) < 0) {
      _x.copy(from).lerp(to, (from.y - ROOM_H) / (from.y - to.y));
      if (Math.abs(_x.x) < ROOM + WALL_T && Math.abs(_x.z) < ROOM + WALL_T) return true;
    }
    return false;
  }
  function updateDetail() {
    camera.updateMatrixWorld();
    _fr.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const eye = camera.position, px = window.innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
    S.rigs.forEach((r, i) => {
      const { w, h, wall } = r.spec, c = paneCentre(r), dist = eye.distanceTo(c);
      let d = 2;
      if (i === S.target && S.plan) d = 2;
      else if (!_fr.intersectsSphere(_sph.set(c, Math.hypot(w, h) / 2 + 0.8))) d = 0;
      else {
        let seen = false;
        for (const [sx, sy] of [[0.5, 0.5], [0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) {
          _q.set((sx - 0.5) * w, FLOOR + sy * h, -r.P.T / 2);
          if (!blocked(_a.copy(eye), r.group.localToWorld(_q), wall)) { seen = true; break; }
        }
        d = !seen ? 0 : Math.max(w, h) * px / dist < 140 ? 1 : 2;
      }
      r.detail = d;
    });
  }

  // ---------- Readout and controls ----------
  function hud() {
    if (S.hud) return S.hud;
    const d = document.createElement('div');
    d.id = 'hsHud';
    d.className = 'panel';
    d.setAttribute('role', 'status');
    const css = document.createElement('style');
    css.textContent = '#hsHud{position:fixed;left:50%;top:62px;transform:translateX(-50%);width:max-content;z-index:3;gap:8px 10px;align-items:center;flex-wrap:wrap;' +
      'justify-content:center;padding:7px 10px;max-width:calc(100% - 24px);font-size:13px}' +
      '#hsDummy{position:fixed;right:12px;bottom:76px;z-index:3;max-width:min(440px,calc(100% - 24px));font-size:12.5px;line-height:1.45}' +
      '@media (max-width:860px){#hsHud{top:80px;font-size:12px;padding:5px 8px;gap:5px 6px}#hsHud>b{display:none}#hsHud button{padding:5px 8px}' +
      '#hsDummy{left:12px;right:12px;bottom:96px;font-size:11.5px;line-height:1.35;padding:8px 10px}}';
    document.head.appendChild(css);
    d.innerHTML = '<b style="font-family:var(--display,inherit);letter-spacing:.04em">GRENADE IN THE SHOP</b>' +
      '<span id="hsStats"></span>' +
      '<button id="hsThrow" style="background:#ffd36b;color:#1a1300;border-color:#ffd36b">Throw</button>' +
      '<select id="hsGlass" title="What the shop is glazed with" aria-label="Glass">' +
      Object.entries(GLASS).map(([id, g]) => `<option value="${id}">${g.label}</option>`).join('') + '</select>' +
      '<button id="hsCam" title="Street, the dummy, inside, low, cutaway (C)">Street</button>' +
      '<button id="hsNight" title="Night or day">Night</button>' +
      '<button id="hsShare" title="Share a link straight to this scene">Share</button>' +
      '<button id="hsExit" title="Back to the test frame">Leave</button>';
    document.body.appendChild(d);
    const rep = document.createElement('div');
    rep.id = 'hsDummy';
    rep.className = 'panel';
    rep.style.display = 'none';
    document.body.appendChild(rep);
    S.rep = rep;
    d.querySelector('#hsThrow').onclick = () => S.throwAt();
    d.querySelector('#hsCam').onclick = () => S.nextView();
    d.querySelector('#hsNight').onclick = () => { S.night = !S.night; applyLight(); };
    d.querySelector('#hsExit').onclick = () => ctx.leave();
    d.querySelector('#hsGlass').onchange = (e) => {
      S.glass = e.target.value;
      S.target = doorOpen() ? DOOR : DEFAULT_TARGET;
      if (doorOpen()) ctx.toast?.(`${kind().label} glass would stop a thrown grenade: the door is propped open to throw through`, 4500);
      begin((Math.random() * 1e9) >>> 0);
      frame();
    };
    d.querySelector('#hsShare').onclick = async () => {
      const url = new URL('grenade/' + (S.glass === 'tempered' ? '' : '?glass=' + S.glass), document.baseURI).href;
      try {
        if (navigator.share) await navigator.share({ title: 'Grenade in the shop · São Paulo World', url });
        else { await navigator.clipboard.writeText(url); ctx.toast?.('Link copied: ' + url); }
      } catch { /* cancelled */ }
    };
    S.hud = d;
    return d;
  }
  S.syncSound = () => {};   // the lab's own Sound button stays on screen

  // Cameras, relative to where the dummy throws from (the front, or a side).
  const VIEWS = ['Street', 'Dummy', 'Inside', 'Low', 'Cutaway'];
  function frame() {
    const name = VIEWS[S.view], p = PANES[S.target], { N, T } = wallFrame(WALLS[p.wall]);
    const at = (n, t, y) => N.clone().multiplyScalar(n).addScaledVector(T, t).setY(y);
    let eye, target;
    if (name === 'Street') { eye = at(ROOM + 11.5, 9, 3.4); target = at(ROOM + 1.4, p.u * 0.5, 1.2); }   // between the shop and the dummy
    else if (name === 'Dummy') { const d = S.dummy.root.position; eye = d.clone().addScaledVector(N, 4.2).addScaledVector(T, 1.4).setY(2.3); target = at(ROOM, p.u, 1.3); }
    else if (name === 'Inside') { eye = at(-ROOM + 0.45, -(ROOM - 0.45), 1.65); target = at(ROOM, p.u * 0.5, 1.1); }
    else if (name === 'Low') { eye = at(ROOM + 6.6, -9, 0.9); target = at(ROOM + 1.5, 1.2, 1.4); }
    else { eye = at(ROOM + 5.5, 0.01, 13); target = at(ROOM - 1.5, 0, 0.4); }
    const v = eye.clone().sub(target);
    cam.tx = target.x; cam.ty = target.y; cam.tz = target.z;
    cam.r = v.length(); cam.phi = Math.acos(v.y / cam.r); cam.theta = Math.atan2(v.x, v.z);
    const across = (deg) => 2 * Math.atan(Math.tan(deg * Math.PI / 360) / Math.max(camera.aspect, 0.3)) * 180 / Math.PI;
    camera.fov = Math.min(95, Math.max(name === 'Inside' ? 60 : 45, across(name === 'Inside' ? 70 : 52)));
    camera.updateProjectionMatrix();
    applyCamera();
    if (S.roof) S.roof.visible = name !== 'Cutaway';
    if (S.hud) S.hud.querySelector('#hsCam').textContent = name;
    if (S.rigs.length) updateDetail();
  }
  S.frameCamera = frame;
  S.nextView = () => { S.view = (S.view + 1) % VIEWS.length; frame(); };

  // (Re)builds the panes. `throwAt`: a pane to throw at straight away (Replay).
  function begin(seed, throwAt = -1) {
    S.seed = seed;
    S.rnd = mulberry32(seed);
    for (const r of S.rigs) S.world.remove(r.group);
    clearEffects();
    S.dummy.marks.clear();
    S.dummy.band.material.color.set('#2fbf71');
    S.dummy.shoulder.rotation.x = ARM_READY;
    const k = kind(), top = k.heavy ? 1 : 2;   // laminates of many plies cost more per pane
    const specs = PANES.map((p, i) => {
      const group = paneGroup(p, i === DOOR && doorOpen());
      S.world.add(group);
      return { ...p, glazing: k[p.role], seed: (seed + 7919 * i) >>> 0, group, floor: -p.bottom,
        tier: Math.max(0, Math.min(ctx.tier, p.wall === 0 ? top : top - 1)), viewTier: Math.min(ctx.tier, 1) };
    });
    S.handle.visible = !doorOpen();
    S.rigs = ctx.makeRigs(specs);
    S.plan = null; S.det = null; S.hurt = null; S.tDet = Infinity; S.lastT = 0;
    S.stats = { peak: 0, fragments: 0, gas: 0 };
    if (S.rep) S.rep.style.display = 'none';
    if (!S.grenadeMesh) S.grenadeMesh = grenadeMesh();
    S.world.add(S.grenadeMesh);
    placeDummy(PANES[S.target]);
    S.dummy.shoulder.rotation.x = ARM_READY;
    S.grenadeMesh.position.copy(handPos());
    S.grenadeMesh.visible = true;
    S.hud.querySelector('#hsThrow').disabled = false;
    showPick();
    updateDetail();
    ctx.setClock(() => (S.det ? Infinity : S.tDet), timeTarget);
    if (throwAt >= 0) S.throwAt(throwAt);
  }

  S.enter = () => {
    S.active = true;
    if (!S.world) S.world = buildWorld();
    scene.add(S.world);
    S.saved = { bg: scene.background, fog: scene.fog, far: camera.far, near: camera.near, fov: camera.fov, env: scene.environment };
    camera.far = 400; camera.near = 0.02; camera.updateProjectionMatrix();
    for (const o of ctx.labObjects) o.visible = false;
    hud();
    S.hud.style.display = 'flex';
    applyLight();
    S.view = 0;
    const asked = new URLSearchParams(location.search).get('glass');
    if (asked && GLASS[asked]) S.glass = asked;
    S.hud.querySelector('#hsGlass').value = S.glass;
    S.target = doorOpen() ? DOOR : DEFAULT_TARGET;
    begin((Math.random() * 1e9) >>> 0);
    ctx.layout();
    frame();
  };
  S.restart = (same) => { if (S.active) begin(same ? S.seed : (Math.random() * 1e9) >>> 0, same && S.plan ? S.target : -1); };

  S.leave = () => {
    if (!S.active) return;
    S.active = false;
    clearEffects();
    for (const r of S.rigs) S.world.remove(r.group);
    S.rigs = [];
    scene.remove(S.world);
    scene.background = S.saved.bg; scene.fog = S.saved.fog; scene.environment = S.saved.env;
    camera.far = S.saved.far; camera.near = S.saved.near; camera.fov = S.saved.fov; camera.updateProjectionMatrix();
    for (const o of ctx.labObjects) o.visible = true;
    if (S.hud) S.hud.style.display = 'none';
    if (S.rep) S.rep.style.display = 'none';
    ctx.layout();
  };

  // Every frame, after the engine: the throw, the grenade, the detonation,
  // the effects, the dummy, the readout.
  S.update = (tEng, scale, dt) => {
    if (!S.active) return;
    const prevT = S.lastT;
    S.lastT = tEng;
    const gr = S.grenade;
    if (!S.plan) {
      // Waiting: the dummy holds the grenade up, the picked pane outlined.
      S.grenadeMesh.position.copy(handPos());
      S.pickRing.children[0].material.opacity = 0.55 + 0.4 * Math.sin(performance.now() / 260);
    } else {
      const r = gr.rig, P = r.P, { w } = r.spec;
      for (let k = 0; k < P.nImp; ++k) if (P.shotDefs[k] === gIdx && P.impMeshes[k]) { P.impMeshes[k].visible = false; if (gr.k < 0) gr.k = k; }
      const step = Math.max(0, tEng - prevT), T0 = S.plan.tThrow;
      if (gr.mode === 'hand') {
        if (tEng < T0) {
          const k = Math.max(0, (tEng - (T0 - WINDUP)) / WINDUP);
          S.dummy.shoulder.rotation.x = k < 0.6 ? ARM_READY + (ARM_BACK - ARM_READY) * k / 0.6 : ARM_BACK + (ARM_RELEASE - ARM_BACK) * ((k - 0.6) / 0.4) ** 2;
          gr.pos.copy(handPos());
        } else {
          const t = tEng - T0;
          gr.pos.copy(S.plan.p0).addScaledVector(S.plan.v0, t).add(new THREE.Vector3(0, -4.905 * t * t, 0));
          S.dummy.shoulder.rotation.x = Math.min(ARM_FOLLOW, ARM_RELEASE + 8 * t);
          if (S.plan.open && tEng >= S.plan.tHit) {
            // In through the door: on its own from here.
            gr.mode = 'free';
            gr.pos.copy(S.plan.target);
            gr.vel.copy(S.plan.v1);
          } else if (gr.k >= 0 && tEng >= S.plan.tHit - 0.02) gr.mode = 'engine';
        }
      }
      if (gr.mode === 'engine') {
        ctx.useRig(r);
        const imp = G.impactors(P.nImp), o = 20 * gr.k;
        gr.pos.copy(r.group.localToWorld(new THREE.Vector3(imp[o] - w / 2, imp[o + 1] + FLOOR, -imp[o + 2])));
        gr.vel.set(imp[o + 3], imp[o + 4], -imp[o + 5]).applyQuaternion(r.group.quaternion);
        const z = imp[o + 2];
        if (z < -0.12 || (z > P.T + 0.12 && imp[o + 5] > 0) || imp[o + 9] === 4) gr.mode = 'free';
      } else if (gr.mode === 'free' && tEng < S.tDet) {
        let left = Math.min(step, S.tDet - prevT);
        while (left > 1e-9) { const h = Math.min(left, 0.002); stepGrenade(gr, h); left -= h; }
      }
      if (!S.det && tEng >= S.tDet - 1e-9) {
        detonate(gr.pos.clone(), S.tDet);
        S.grenadeMesh.visible = false;
      }
      S.grenadeMesh.position.copy(gr.pos);
      S.grenadeMesh.rotation.set(gr.spin, 0, gr.spin * 0.3);
    }
    if (S.effects) S.effects.update(tEng);
    if (S.hurt) glassAtDummy(tEng, dt);
    if ((S.lodTick = (S.lodTick || 0) + dt) > 0.15) { S.lodTick = 0; updateDetail(); }
    if (S.hud && (S.uiTick = (S.uiTick || 0) + dt) > 0.12) {
      S.uiTick = 0;
      let broken = 0, out = 0;
      for (const rr of S.rigs) {
        ctx.useRig(rr);
        const s = G.state();
        if (s[6]) ++broken;
        if (s[9] > 0.8 * rr.spec.w * rr.spec.h) ++out;
      }
      const t = tEng - S.tDet;
      S.hud.querySelector('#hsStats').textContent = !S.plan ? 'tap a pane to throw at it'
        : !S.det ? (tEng < S.plan.tHit ? 'grenade in the air' : `fuse burning · ${Math.max(0, S.tDet - tEng).toFixed(2)} s`)
        : `${(t * 1000).toFixed(t < 0.1 ? 2 : 0)} ms after it went off · ${broken} of ${S.rigs.length} panes broken · ${out} blown out · peak ${(S.stats.peak / 1000).toFixed(0)} kPa`;
      if (S.hurt) {
        S.rep.style.display = 'block';
        S.rep.innerHTML = `<b style="font-family:var(--display,inherit);letter-spacing:.04em">THE DUMMY</b> · ${S.hurt.R.toFixed(1)} m from the blast<br>` + injuryReport(tEng).join('<br>');
      }
    }
  };

  return S;
}
