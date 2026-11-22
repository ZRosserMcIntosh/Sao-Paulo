// São Paulo World · flying together: several players in one sky, by link.
//
// Every browser flies its own aircraft with the full physics; nobody's flight
// waits on the network. Each tells the room where it is a few times a second
// (netstate.js: one small array of integers), and draws the others a moment
// in the past, between two updates, carried on along their last velocity
// when an update is late and faded out after a few seconds of silence: lag
// only ever looks like a slightly late aircraft.
//
// The room is a channel on a relay (netlink.js): tabs of one browser
// ('local'), or Supabase Realtime Broadcast + Presence (relay.js). What must
// outlive a message (who is here, their names, the host's world settings and
// the room's shared object) rides on presence, so a late joiner gets it.
//
// app.js mounts it (mountNet) and calls update() and draw() each frame.
// For the other modules: startRoom(), joinRoom(), leaveRoom(), setShared(),
// onShared() and world() below.
import * as THREE from 'three';
import { openLink } from './netlink.js';
import RELAY from './relay.js';
import {
  TYPES, MAX_PLAYERS, F, BUDGET, STALE_FADE, encodeState, decodeState, cleanName, cleanMeta, validId, newId, sendHz, renderDelay,
  Track, newPose, qAdvance, qAngle, qDelta, qSlerp, turnTime,
} from './netstate.js';

// Everything a player reads, in one place.
const STR = {
  button: 'Fly together',
  title: 'Fly together',
  intro: 'Fly the same sky as your friends. Send them a link: no account, nothing to install.',
  off: 'Flying together is not switched on yet. Check back soon.',
  name: 'Your name',
  colour: 'Your colour',
  start: 'Start a flight together',
  invited: 'You are invited to fly over São Paulo with friends.',
  joinAir: 'Join in the air',
  joinGround: 'Start on the runway',
  link: 'Send this link to your friends',
  copy: 'Copy link',
  copied: 'Copied!',
  share: 'Share…',
  shareText: 'Come fly over São Paulo with me!',
  leave: 'Leave',
  close: 'Close',
  flyTo: 'Fly to',
  you: 'you',
  host: 'host',
  away: 'away',
  onGround: 'on the ground',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  failed: 'Could not reach the room. Check your connection and try again.',
  full: `This flight is full (${MAX_PLAYERS} players). Try again later, or start your own.`,
  alone: 'Connected · waiting for friends',
  flying: (n) => `Connected · ${n} flying`,
  chip: (n) => `${n} flying`,
  joined: (name) => `${name} joined.`,
  left: (name) => `${name} left.`,
  with: (name) => `You are flying with ${name}.`,
  nobody: 'Nobody else is here yet. Send the link to a friend.',
  noTarget: (name) => `${name} is not flying right now.`,
  weather: (name) => `Weather set by ${name}.`,
  nowHost: 'You are the host now.',
  ghost: 'Your ghost',
};
const FIRST = ['Sunny', 'Happy', 'Brave', 'Swift', 'Lucky', 'Merry', 'Bright', 'Bold', 'Calm', 'Clever', 'Jolly', 'Golden'];
const SECOND = ['Toucan', 'Macaw', 'Capybara', 'Jaguar', 'Parrot', 'Condor', 'Falcon', 'Heron', 'Tamarin', 'Dolphin', 'Otter', 'Hummingbird'];
export const COLORS = ['#ffd36b', '#8fd8ff', '#ff8c7a', '#9cf08a', '#d9a5ff', '#ffffff', '#ffb35c', '#7ff0e0'];
const TYPE_NAMES = { c172: '172', topg: 'Top G', phenom300: 'Phenom 300E', cj4: 'Citation CJ4', learjet45: 'Learjet 45', crj700: 'CRJ700', b738: '737-800', kingair: 'King Air 350' };

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wallNow = () => performance.timeOrigin + performance.now();
const km = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`);

// Levels of detail: the game's own model with its moving parts close by; the
// same shape baked into three meshes farther off; a few boxes beyond; then
// only the name tag.
const LOD = { full: 260, baked: 2600, far: 14000 };

// ---- The models ----------------------------------------------------------------------
// One per aircraft type, built once from its definition: the baked meshes
// every player of that type shares (their own tint aside).
function visibleMeshes(root, out = []) {
  if (!root.visible) return out;
  if (root.isMesh) out.push(root);
  for (const c of root.children) visibleMeshes(c, out);
  return out;
}
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3();
function bake(meshes, minR) {
  const pos = [], nor = [], col = [];
  for (const m of meshes) {
    const g = m.geometry, mat = m.material, P = g.attributes.position, N = g.attributes.normal;
    if (!P || !N || !mat.color || (mat.transparent && mat.opacity < 0.5)) continue;
    if (!g.boundingSphere) g.computeBoundingSphere();
    // (small parts, and the cabin windows: thousands of triangles nobody sees from here)
    if (g.boundingSphere.radius * m.matrixWorld.getMaxScaleOnAxis() < (mat.transparent ? 0.5 : minR)) continue;
    _nm.getNormalMatrix(m.matrixWorld);
    const idx = g.index, n = idx ? idx.count : P.count, flip = m.matrixWorld.determinant() < 0, c = mat.color;
    for (let i = 0; i < n; ++i) {
      // (a mirrored part: its triangles the other way round)
      const k = flip ? i - (i % 3) + (2 - (i % 3)) : i, v = idx ? idx.getX(k) : k;
      _v.fromBufferAttribute(P, v).applyMatrix4(m.matrixWorld); pos.push(_v.x, _v.y, _v.z);
      _n.fromBufferAttribute(N, v).applyMatrix3(_nm).normalize(); nor.push(_n.x, _n.y, _n.z);
      col.push(c.r, c.g, c.b);
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}
const REST = { flapDeg: 0, aileron: 0, elevator: 0, rudder: 0, rpm: 0, n1: [0, 0], speedbrake: 0, lights: false, reverser: [0, 0], props: null, disc: 1, slow: 1, phase: 0 };
function buildKind(profile, def, builders) {
  const make = () => (profile.jet ? builders.buildJet(def) : builders.buildAircraft(def));
  const model = make();
  // The livery colour a player's own colour replaces.
  const primary = new THREE.Color(profile.jet ? (def.visual?.colors?.primary ?? 0x0b2f6e) : 0x1d57c2).getHex();
  model.root.updateMatrixWorld(true);
  model.update({ ...REST, gear: 0 }, 0);
  model.root.updateMatrixWorld(true);
  const up = visibleMeshes(model.root), isTint = (m) => m.material.color?.getHex() === primary;
  model.update({ ...REST, gear: 1 }, 0);
  model.root.updateMatrixWorld(true);
  const upSet = new Set(up), legs = visibleMeshes(model.root).filter((m) => !upSet.has(m));
  const body = bake(up.filter((m) => !isTint(m)), 0.3), tint = bake(up.filter(isTint), 0.2), gear = bake(legs, 0.12);
  // The far shape: fuselage, wing and fin as boxes, from the baked body's size.
  body.computeBoundingBox();
  const bb = body.boundingBox, L = bb.max.x - bb.min.x, span = bb.max.y - bb.min.y, H = bb.max.z - bb.min.z;
  const box = (sx, sy, sz, x, y, z) => { const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed(); g.translate(x, y, z); return g; };
  const parts = [box(L, 0.1 * L, 0.1 * L, bb.min.x + L / 2, 0, bb.min.z + 0.5 * H), box(0.13 * L, span, 0.02 * L, bb.min.x + 0.55 * L, 0, bb.min.z + 0.45 * H), box(0.14 * L, 0.02 * L, 0.6 * H, bb.min.x + 0.07 * L, 0, bb.max.z - 0.3 * H)];
  const far = new THREE.BufferGeometry();
  for (const a of ['position', 'normal']) far.setAttribute(a, new THREE.Float32BufferAttribute(parts.flatMap((g) => Array.from(g.attributes[a].array)), 3));
  far.computeBoundingSphere();
  for (const g of parts) g.dispose();
  // Its shadow: the plan view (fuselage, wings, tailplane) as flat quads that
  // do not overlap, cast along the sun's rays onto the ground (Remote.update).
  const quad = (x0, x1, y0, y1) => [x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0];
  const fw = 0.05 * L, xw = bb.min.x + 0.55 * L, cw = 0.07 * L;
  const flat = [...quad(bb.min.x, bb.max.x, -fw, fw), ...quad(xw - cw, xw + cw, fw, span / 2), ...quad(xw - cw, xw + cw, -span / 2, -fw),
    ...quad(bb.min.x, bb.min.x + 0.1 * L, fw, 0.19 * span), ...quad(bb.min.x, bb.min.x + 0.1 * L, -0.19 * span, -fw)];
  const shadow = new THREE.BufferGeometry();
  shadow.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
  return { profile, def, make, primary, body, tint, gear, far, shadow, span, length: L, top: bb.max.z, spare: model };
}

// ---- One other player (or a ghost) ---------------------------------------------------
const qM = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);  // ENU → three
const _q = new THREE.Quaternion(), _cam = new THREE.Vector3(), _w3 = [0, 0, 0];
class Remote {
  constructor(id, net) {
    this.id = id; this.net = net;
    this.meta = { name: 'Pilot', color: 0, type: 0, since: 0, host: 0, room: null };
    this.present = false;        // listed by the room's presence
    this.track = new Track();
    this.sampler = null;         // a ghost: (now, pose) → age, in place of the track
    this.pose = newPose();
    this.age = null;             // s past the newest update (null: nothing to draw)
    this.p = [0, 0, 0]; this.q = [0, 0, 0, 1]; this.has = false; this.epoch = -1;
    this.type = -1; this.kind = null; this.typeAt = 0;
    this.group = new THREE.Group(); this.group.visible = false;
    this.model = null; this.lod = -1; this.alpha = 0; this.dist = Infinity;
    this.shadow = null; this.mats = null; this.baked = null; this.far = null;
    net.ctx.scene.add(this.group);
  }
  get color() { return COLORS[this.meta.color] || COLORS[0]; }
  setKind(kind) {
    this.clearMeshes();
    this.kind = kind;
    const tint = new THREE.Color(this.color);
    const mk = (c, vertexColors) => new THREE.MeshLambertMaterial({ color: c, vertexColors, transparent: false });
    this.mats = { body: mk(0xffffff, true), tint: mk(tint, false), far: mk(0xdfe3e6, false) };
    this.baked = new THREE.Group();
    this.baked.add(new THREE.Mesh(kind.body, this.mats.body));
    if (kind.tint) this.baked.add(new THREE.Mesh(kind.tint, this.mats.tint));
    this.legs = kind.gear ? new THREE.Mesh(kind.gear, this.mats.body) : null;
    if (this.legs) this.baked.add(this.legs);
    this.far = new THREE.Mesh(kind.far, this.mats.far);
    this.group.add(this.baked, this.far);
    // A soft shadow on the ground under it (the sun's shadow map follows the player's own aircraft only).
    this.shadow = new THREE.Mesh(kind.shadow, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    this.shadow.matrixAutoUpdate = false; this.shadow.frustumCulled = false; this.shadow.visible = false; this.shadow.renderOrder = 1;
    this.net.ctx.scene.add(this.shadow);
    this.lod = -1;
  }
  // The game's own model, with its moving parts: built when first seen close.
  wantModel() {
    if (this.model || !this.kind || this.net.buildAt > performance.now()) return;
    this.net.buildAt = performance.now() + 400;  // at most one build every so often: each takes tens of ms
    const m = this.kind.spare || this.kind.make();
    this.kind.spare = null;
    // (Each built model has its own materials: the livery colour is repainted in place.)
    m.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false;
      if (!this.tintMat && o.material.color?.getHex() === this.kind.primary) this.tintMat = o.material;
    });
    if (this.tintMat) this.tintMat.color.set(this.color);
    this.model = m;
    m.root.visible = false;
    this.group.add(m.root);
  }
  retint() {
    if (this.mats) this.mats.tint.color.set(this.color);
    if (this.tintMat) this.tintMat.color.set(this.color);
  }
  clearMeshes() {
    if (this.model) { this.group.remove(this.model.root); disposeTree(this.model.root); this.model = null; this.tintMat = null; }
    if (this.baked) { this.group.remove(this.baked, this.far); this.baked = this.far = this.legs = null; }
    if (this.mats) { for (const m of Object.values(this.mats)) m.dispose(); this.mats = null; }
    if (this.shadow) { this.net.ctx.scene.remove(this.shadow); this.shadow.material.dispose(); this.shadow = null; }
  }
  dispose() { this.dead = true; this.clearMeshes(); this.net.ctx.scene.remove(this.group); }
  // Where it is now, and how it is drawn from the camera's distance.
  update(now, dt, fullLeft) {
    const net = this.net, ctx = net.ctx, o = this.pose;
    this.age = this.sampler ? this.sampler(now, o) : this.track.sample(now, net.delay, o);
    if (this.age === null) { this.group.visible = false; if (this.shadow) this.shadow.visible = false; this.alpha = 0; this.has = false; return false; }
    // Its aircraft type: a change rebuilds, at most every two seconds.
    if (o.type !== this.type && now - this.typeAt > 2000) {
      this.type = o.type; this.typeAt = now; this.kind = null;
      this.clearMeshes();
      net.kind(o.type).then((k) => { if (k && !this.dead && this.type === k.index) this.setKind(k); });
    }
    // The drawn aircraft keeps moving the way the target does and closes on it
    // over a fraction of a second: a late or missing update never shows as a jump.
    const far = Math.hypot(o.p[0] - this.p[0], o.p[1] - this.p[1], o.p[2] - this.p[2]);
    if (!this.has || o.epoch !== this.epoch || far > 80) {
      this.p[0] = o.p[0]; this.p[1] = o.p[1]; this.p[2] = o.p[2];
      this.q[0] = o.q[0]; this.q[1] = o.q[1]; this.q[2] = o.q[2]; this.q[3] = o.q[3];
      this.has = true; this.epoch = o.epoch;
    } else {
      const k = Math.exp(-dt / 0.18);
      for (let i = 0; i < 3; ++i) this.p[i] = o.p[i] + (this.p[i] + o.v[i] * dt - o.p[i]) * k;
      qAdvance(this.q, o.w, dt, this.q);
      qSlerp(this.q, o.q, 1 - k, this.q);
    }
    this.group.position.set(this.p[0], this.p[2], -this.p[1]);
    this.group.quaternion.copy(qM).multiply(_q.set(this.q[0], this.q[1], this.q[2], this.q[3]));
    this.dist = _cam.copy(ctx.camera.position).distanceTo(this.group.position);
    // Silence: fading from three seconds, gone at five.
    this.alpha = this.age <= STALE_FADE[0] ? 1 : clamp(1 - (this.age - STALE_FADE[0]) / (STALE_FADE[1] - STALE_FADE[0]), 0, 1);
    const k = this.kind;
    if (!k || this.alpha <= 0 || this.dist > LOD.far) { this.group.visible = false; if (this.shadow) this.shadow.visible = false; return false; }
    this.group.visible = true;
    let lod = this.dist < LOD.full && this.alpha >= 1 && fullLeft > 0 ? 0 : this.dist < LOD.baked ? 1 : 2;
    if (lod === 0) { this.wantModel(); if (!this.model) lod = 1; }
    if (lod !== this.lod) {
      this.lod = lod;
      if (this.model) this.model.root.visible = lod === 0;
      this.baked.visible = lod === 1; this.far.visible = lod === 2;
    }
    if (lod === 0) this.animate(dt);
    else if (this.legs) this.legs.visible = o.gear > 0.5;
    const fade = this.alpha < 1, ms = this.mats;
    if (ms.body.transparent !== fade) for (const m of [ms.body, ms.tint, ms.far]) { m.transparent = fade; m.needsUpdate = true; }
    ms.body.opacity = ms.tint.opacity = ms.far.opacity = this.alpha;
    // The shadow: straight down the sun's rays onto the ground, fainter with height.
    const sun = ctx.sunDir(), h = this.p[2] - ctx.groundAt(this.p[0], this.p[1]);
    if (h < 400 && sun.y > 0.08 && this.dist < 6000) {
      // (the ground taken as level at the height under the shadow's middle)
      const kx = sun.x / sun.y, kz = sun.z / sun.y, g = ctx.groundAt(this.p[0] - kx * h, this.p[1] + kz * h) + 0.12;
      this.group.updateMatrix();
      this.shadow.matrix.set(1, -kx, 0, kx * g, 0, 0, 0, g, 0, -kz, 1, kz * g, 0, 0, 0, 1).multiply(this.group.matrix);
      this.shadow.matrixWorldNeedsUpdate = true;
      this.shadow.material.opacity = 0.36 * this.alpha * clamp(1.15 - h / 350, 0, 1) * (ctx.shadowStrength?.() ?? 1);
      this.shadow.visible = this.shadow.material.opacity > 0.01;
    } else this.shadow.visible = false;
    return lod === 0;
  }
  animate(dt) {
    const o = this.pose, k = this.kind, p = k.profile, frozen = !!(o.flags & F.frozen);
    const lights = !!(o.flags & F.lights);
    if (p.turboprop) this.model.update({ flapDeg: o.flap, aileron: o.ail, elevator: o.elev, rudder: o.rud, n1: [0, 0], gear: o.gear, speedbrake: 0, lights, reverser: [0, 0], props: [{ np: frozen ? 0 : o.e1, blade: o.aux }, { np: frozen ? 0 : o.e2, blade: o.aux }], disc: 1, slow: 1 }, dt);
    else if (p.jet) this.model.update({ flapDeg: o.flap, aileron: o.ail, elevator: o.elev, rudder: o.rud, n1: frozen ? [0, 0] : [o.e1 / 10, o.e2 / 10], gear: o.gear, speedbrake: o.spd, lights, reverser: [0, 0], props: null, disc: 1, slow: 1 }, dt);
    else this.model.update({ flapDeg: o.flap, aileron: o.ail, elevator: o.elev, rudder: o.rud, rpm: frozen ? 0 : o.e1, disc: 1, slow: 1 }, dt);
  }
}
function disposeTree(root) {
  const mats = new Set();
  root.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); mats.add(o.material); } });
  for (const m of mats) { m.map?.dispose(); m.dispose(); }
}

// ---- The room --------------------------------------------------------------------------
let mounted = null;
// For the other modules (the welcome screen's "Fly with friends" card, the
// challenges, the day/night module): the same calls as on the object mountNet returns.
export const startRoom = (opts) => mounted?.start(opts);
export const joinRoom = (room) => mounted?.join(room);
export const leaveRoom = () => mounted?.leave();
export const setShared = (obj) => mounted?.setShared(obj);
export const onShared = (fn) => mounted?.onShared(fn);
export const world = (name, provider) => mounted?.world(name, provider);

export function mountNet(ctx) {
  const params = new URLSearchParams(location.search);
  const store = ctx.store, session = {
    get(k) { try { return sessionStorage.getItem('spw.fly.net:' + k); } catch { return null; } },
    set(k, v) { try { if (v === null) sessionStorage.removeItem('spw.fly.net:' + k); else sessionStorage.setItem('spw.fly.net:' + k, v); } catch { /* blocked */ } },
  };
  // The relay: the site's own (relay.js). A link must not be able to point
  // players' browsers at a server it names, so ?relay= is honoured only for
  // this browser's tabs ('local') and a relay on this machine (tests).
  const relay = (() => {
    const r = params.get('relay');
    if (r === 'local') return { kind: 'local', roomEvents: BUDGET.hzMax * MAX_PLAYERS * MAX_PLAYERS };
    if (r) { try { const u = new URL(r); if ((u.protocol === 'ws:' || u.protocol === 'wss:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return { kind: 'supabase', url: u.origin.replace(/^ws/, 'http'), key: 'local-test', dev: r, roomEvents: RELAY.roomEvents }; } catch { /* ignored */ } }
    if (RELAY.url && RELAY.key) return { kind: 'supabase', url: RELAY.url, key: RELAY.key, roomEvents: RELAY.roomEvents };
    return null;
  })();
  const budget = { ...BUDGET, roomEvents: Number.isFinite(+params.get('netbudget')) && params.get('netbudget') ? +params.get('netbudget') : relay?.roomEvents > 0 ? relay.roomEvents : BUDGET.roomEvents };

  const me = {
    id: (() => { let v = session.get('peer'); if (!validId(v)) { v = newId(8); session.set('peer', v); } return v; })(),
    name: cleanName(store.get('net:name', ''), ''), color: clamp(store.get('net:color', -1) | 0, -1, 7), since: 0, host: 0,
  };
  if (!me.name) me.name = `${FIRST[Math.floor(Math.random() * FIRST.length)]} ${SECOND[Math.floor(Math.random() * SECOND.length)]}`;
  if (me.color < 0) me.color = Math.floor(Math.random() * COLORS.length);

  const net = {
    ctx, me, relay, budget, remotes: new Map(), link: null, room: null, status: 'off', detail: '', delay: 200, hz: BUDGET.hzMax,
    buildAt: 0, sent: 0, received: 0, rejected: 0, kinds: new Map(), ghost: null,
    roomState: { rv: 0, w: {}, s: null }, providers: new Map(), sharedFns: [], applied: {},
  };
  mounted = net;

  // ---- Aircraft types ----
  net.kind = (index) => {
    if (!net.kinds.has(index)) {
      const profile = ctx.PROFILES[TYPES[index]];
      net.kinds.set(index, (async () => {
        try {
          const def = JSON.parse(await ctx.fetchDef(profile));
          const k = buildKind(profile, def, ctx);
          k.index = index;
          return k;
        } catch (e) { console.warn('flying together: aircraft', TYPES[index], e); net.kinds.delete(index); return null; }
      })());
    }
    return net.kinds.get(index);
  };

  // ---- This player's own state, out ----
  const own = { p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], type: 0, flags: 0, gear: 1, flap: 0, e1: 0, e2: 0, aux: 0, ail: 0, elev: 0, rud: 0, spd: 0, t: 0 };
  const prev = { q: [0, 0, 0, 1], p: [0, 0, 0], has: false, t42: 0 }, sentSt = { ...own, p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], at: 0 };
  let rate = 1, epoch = 0, forceSend = false, away = false;
  const RW_N = 64, rw = { s: new Float64Array(RW_N), w: new Float64Array(RW_N), i: 0, n: 0, sim: 0, wall: 0 };
  const qPred = [0, 0, 0, 1];
  // Reads the aircraft (avd_state s, avd_jet j, the turboprop's indication) once a frame.
  // Velocity and turn rate from the state's own change over the core's clock
  // (s[42]): exactly how it is moving, whatever the frame's length.
  function readOwn(now, s, j, tp, P, crashed) {
    own.t = now;
    own.q[0] = s[4]; own.q[1] = s[5]; own.q[2] = s[6]; own.q[3] = s[3];
    const dts = s[42] - prev.t42;
    const jump = !prev.has || dts < 0 || Math.hypot(s[0] - prev.p[0], s[1] - prev.p[1], s[2] - prev.p[2]) > 400 * Math.max(dts, 0.02) + 5;
    if (jump) {
      // A restart or a new spot: another stretch of flight (the others snap to it), its velocity as the core reports it.
      const gs = s[12] * 0.514444, tr = s[61] * DEG;
      own.v[0] = gs * Math.sin(tr); own.v[1] = gs * Math.cos(tr); own.v[2] = ctx.verticalSpeed() * 0.00508;
      own.w[0] = own.w[1] = own.w[2] = 0;
      epoch = (epoch + 1) & F.epochMask; forceSend = true;
    } else if (dts > 1e-4) {
      qDelta(prev.q, own.q, _w3);
      for (let i = 0; i < 3; ++i) { own.v[i] = (s[i] - prev.p[i]) / dts; own.w[i] += (_w3[i] / dts - own.w[i]) * 0.6; }
    }
    if (jump || dts > 1e-4) {
      prev.p[0] = s[0]; prev.p[1] = s[1]; prev.p[2] = s[2]; prev.q[0] = own.q[0]; prev.q[1] = own.q[1]; prev.q[2] = own.q[2]; prev.q[3] = own.q[3]; prev.t42 = s[42]; prev.has = true;
    }
    own.p[0] = s[0]; own.p[1] = s[1]; own.p[2] = s[2];
    own.type = Math.max(0, TYPES.indexOf(P.id));
    const running = tp ? tp.engines.some((e) => e.running) : P.jet ? !!(j[13] || j[21]) : !!s[30];
    own.flags = (s[28] ? F.ground : 0) | (crashed ? F.crashed : 0) | (running ? F.lights : 0) | (rate === 0 ? F.frozen : 0) | (away ? F.away : 0) | (epoch << F.epochShift);
    own.gear = P.jet ? j[1] : 1; own.flap = s[26]; own.ail = s[45]; own.elev = s[46]; own.rud = s[47]; own.spd = P.jet && !P.turboprop ? j[3] : 0;
    if (tp) { own.e1 = tp.powered ? tp.engines[0].np : s[19]; own.e2 = tp.powered ? tp.engines[1].np : s[19]; own.aux = tp.engines[0].blade; }
    else if (P.jet) { own.e1 = j[8] * 10; own.e2 = j[16] * 10; own.aux = 0; }
    else { own.e1 = own.e2 = s[19]; own.aux = 0; }
  }
  const scaled = { ...own, v: [0, 0, 0], w: [0, 0, 0] };
  function encodeOwn() {
    Object.assign(scaled, own, { v: scaled.v, w: scaled.w });
    for (let i = 0; i < 3; ++i) { scaled.v[i] = own.v[i] * rate; scaled.w[i] = own.w[i] * rate; }
    return encodeState(scaled);
  }
  // Is an update due? Not more often than the room's budget allows; at once
  // when the others' picture of this aircraft has gone wrong (their
  // extrapolation from the last update, checked here the way they do it) or
  // something visible changed; otherwise only now and then.
  function due(now) {
    const since = now - sentSt.at, gap = 1000 / net.hz;
    if (since < gap && !(forceSend && since > 60)) return false;
    if (forceSend) return true;
    const parked = (own.flags & F.ground) && Math.hypot(own.v[0], own.v[1]) < 0.3;
    if (since >= (parked ? budget.parkedSec * 1000 : Math.max(gap, 1000 / budget.steadyHz))) return true;
    const dt = since / 1000, e = own.e1 - sentSt.e1;
    if (Math.hypot(sentSt.p[0] + sentSt.v[0] * dt - own.p[0], sentSt.p[1] + sentSt.v[1] * dt - own.p[1], sentSt.p[2] + sentSt.v[2] * dt - own.p[2]) > budget.posErr) return true;
    if (qAngle(qAdvance(sentSt.q, sentSt.w, turnTime(dt), qPred), own.q) > budget.angErr * DEG) return true;
    return own.flags !== sentSt.flags || own.type !== sentSt.type || Math.abs(own.gear - sentSt.gear) > 0.08 || Math.abs(own.flap - sentSt.flap) > 1.5
      || Math.abs(e) > Math.max(60, 0.08 * sentSt.e1) || Math.abs(own.spd - sentSt.spd) > 0.1;
  }
  function sendOwn(now) {
    const a = encodeOwn();
    a.unshift(me.id);
    net.link.send('s', a);
    net.sent++; forceSend = false;
    sentSt.at = now; sentSt.flags = own.flags; sentSt.type = own.type; sentSt.gear = own.gear; sentSt.flap = own.flap; sentSt.e1 = own.e1; sentSt.spd = own.spd;
    for (let i = 0; i < 3; ++i) { sentSt.p[i] = own.p[i]; sentSt.v[i] = own.v[i] * rate; sentSt.w[i] = own.w[i] * rate; }
    for (let i = 0; i < 4; ++i) sentSt.q[i] = own.q[i];
  }

  // ---- The others' states, in ----
  function remoteFor(id) {
    let r = net.remotes.get(id);
    if (!r) {
      if (net.remotes.size >= MAX_PLAYERS - 1 + (net.ghost ? 1 : 0)) return null;
      r = new Remote(id, net);
      net.remotes.set(id, r);
    }
    return r;
  }
  function onMessage(ev, d) {
    if (ev !== 's' || !Array.isArray(d) || d.length !== 27) { net.rejected++; return; }
    const id = d[0];
    if (!validId(id) || id === me.id) { net.rejected++; return; }
    const st = decodeState(d, 1);
    if (!st) { net.rejected++; return; }
    const r = remoteFor(id);
    if (!r || r.sampler) { net.rejected++; return; }
    if (r.track.push(st, wallNow())) net.received++; else net.rejected++;
  }

  // ---- Who is here (presence), the host and the room's settings ----
  let firstSync = 0, openAt = 0, wantFly = null, nPresent = 0;
  const present = () => [...net.remotes.values()].filter((r) => r.present);
  const players = () => 1 + present().length;
  const hostOf = () => {
    if (me.host) return null;
    let h = null;
    for (const r of present()) if (r.meta.host && (!h || r.meta.since < h.meta.since || (r.meta.since === h.meta.since && r.id < h.id))) h = r;
    return h;
  };
  const myMeta = () => ({ name: me.name, color: me.color, type: Math.max(0, TYPES.indexOf(ctx.profile().id)), since: me.since, host: me.host, room: me.host ? net.roomState : undefined });
  let metaTimer = 0;
  function publishMeta() {
    // (Presence updates are few: debounced, the newest wins.)
    clearTimeout(metaTimer);
    metaTimer = setTimeout(() => { if (net.link) net.link.setMeta(myMeta()); }, 150);
  }
  function onPeers(peers) {
    const seen = new Set();
    let n = 0, before = 0;
    for (const [id, raw] of peers) {
      if (id === me.id || !validId(id) || ++n > 2 * MAX_PLAYERS) continue;
      const meta = cleanMeta(raw);
      if (!meta) continue;
      if (meta.since < me.since || (meta.since === me.since && id < me.id)) before++;  // here before this player
      const r = remoteFor(id);
      if (!r || r.sampler) continue;
      seen.add(id);
      const was = r.present, colorWas = r.meta.color;
      r.meta = meta; r.present = true;
      if (meta.color !== colorWas) r.retint();
      if (!was) { forceSend = true; if (firstSync) ctx.toast(STR.joined(meta.name), 2.5); }
    }
    for (const r of [...net.remotes.values()]) {
      if (r.present && !seen.has(r.id)) {
        r.present = false;
        ctx.toast(STR.left(r.meta.name), 2.5);
        dropRemote(r);
      }
    }
    nPresent = seen.size;
    if (!firstSync && (seen.size || performance.now() - openAt > 1500)) firstSync = performance.now();
    // Full: this player arrived after the room filled.
    if (before >= MAX_PLAYERS) { leave('full'); return; }
    roomLogic();
    net.hz = sendHz(players(), budget);
    net.delay = renderDelay(net.hz);
    ui.refresh();
  }
  function dropRemote(r) { if (r.sampler) return; r.dispose(); net.remotes.delete(r.id); }
  function roomLogic() {
    const h = hostOf();
    if (me.host) {
      // Two hosts (a split healed): the earlier one keeps it.
      const other = present().find((r) => r.meta.host && (r.meta.since < me.since || (r.meta.since === me.since && r.id < me.id)));
      if (other) { me.host = 0; publishMeta(); }
    } else if (!h && firstSync && performance.now() - openAt > 2500) {
      // No host (they left): the longest here takes over, with the room as last seen.
      const first = present().every((r) => me.since < r.meta.since || (me.since === r.meta.since && me.id < r.id));
      if (first) { me.host = 1; publishMeta(); if (present().length) ctx.toast(STR.nowHost, 2.5); }
    }
    if (h && h.meta.room && h.meta.room.rv !== net.roomState.rv) {
      net.roomState = h.meta.room;
      applyWorld(h); notifyShared(h);
    }
  }
  // The host's world settings (weather; time of day through the day/night
  // module's provider) and the room's shared object, applied when they change.
  function applyWorld(from) {
    const w = net.roomState.w && typeof net.roomState.w === 'object' ? net.roomState.w : {};
    for (const [name, p] of net.providers) {
      if (!(name in w) || !p.apply) continue;
      const txt = JSON.stringify(w[name]);
      if (txt === net.applied[name]) continue;
      net.applied[name] = txt;
      try { p.apply(w[name]); if (name === 'wx' && from) ctx.toast(STR.weather(from.meta.name), 2.5); } catch (e) { console.warn('flying together: world setting', name, e); }
    }
  }
  let sharedTxt = 'null';
  function notifyShared(from) {
    const s = net.roomState.s ?? null, txt = JSON.stringify(s);
    if (txt === sharedTxt) return;
    sharedTxt = txt;
    for (const fn of net.sharedFns) { try { fn(s, from ? from.id : me.id); } catch (e) { console.warn('flying together: shared', e); } }
  }
  // The host: its settings, read once a second; a change goes out on presence.
  function hostTick() {
    if (net.link && net.status === 'open') roomLogic();  // (a host who left in this player's first seconds: noticed here)
    if (!me.host || !net.link) return;
    const w = {};
    for (const [name, p] of net.providers) { if (p.get) { try { const v = p.get(); if (v !== undefined) w[name] = v; } catch { /* skip */ } } }
    if (JSON.stringify(w) !== JSON.stringify(net.roomState.w)) { net.roomState = { ...net.roomState, w, rv: net.roomState.rv + 1 }; publishMeta(); }
  }
  setInterval(hostTick, 1000);

  net.world = (name, provider) => { net.providers.set(name, provider); if (!me.host) applyWorld(hostOf()); };
  net.setShared = (obj) => {
    if (net.room && !me.host) return false;  // the host's to set
    net.roomState = { ...net.roomState, s: obj ?? null, rv: net.roomState.rv + 1 };
    if (me.host) publishMeta();
    notifyShared(null);
    return true;
  };
  net.onShared = (fn) => { net.sharedFns.push(fn); if (net.roomState.s) fn(net.roomState.s, hostOf()?.id || me.id); };  // fn(shared object or null, the host's id)
  Object.defineProperty(net, 'shared', { get: () => net.roomState.s ?? null });
  Object.defineProperty(net, 'isHost', { get: () => me.host === 1 });
  Object.defineProperty(net, 'players', { get: players });
  // Live rooms are switched on (a relay is configured): where they are not, the game layer's card says "soon".
  Object.defineProperty(net, 'available', { get: () => !!relay });
  net.nameOf = (id) => net.remotes.get(id)?.meta.name || '';
  // A room link waiting for the player's answer (the welcome screen can stand aside).
  Object.defineProperty(net, 'pending', { get: () => ui.inviteOpen() });

  // ---- Joining and leaving ----
  function connect(room, { host = false, fly = false, shared } = {}) {
    if (net.link) leave();
    if (!relay) { net.status = 'off'; ui.refresh(); return false; }
    net.room = room; net.status = 'connecting'; net.detail = '';
    me.since = Date.now(); me.host = host ? 1 : 0;
    net.roomState = { rv: host ? 1 : 0, w: {}, s: shared ?? null };
    net.applied = {};
    firstSync = 0; openAt = performance.now(); wantFly = fly ? { until: performance.now() + 9000 } : null;
    session.set('room', room); session.set('host', host ? room : null);
    try {
      const u = new URL(location.href);
      u.searchParams.set('room', room);
      history.replaceState(null, '', u.pathname + u.search.replace(/=(&|$)/g, '$1') + u.hash);
    } catch { /* sandboxed */ }
    const link = net.link = openLink({ relay, room, peer: me.id, meta: myMeta() });
    if (ctx.debug && params.get('netlag')) link.impair = { lag: +params.get('netlag') || 0, jitter: +params.get('netjitter') || 0, loss: +params.get('netloss') || 0 };
    link.onmessage = onMessage;
    link.onpeers = onPeers;
    // A duplicated tab carries this tab's id with it: one of the two takes a new one and joins again.
    link.onclash = () => { if (net.link !== link) return; me.id = newId(8); session.set('peer', me.id); connect(room, { host: false, fly: false }); };
    link.onstatus = (s, detail) => {
      if (net.link !== link) return;
      net.status = s; net.detail = detail || '';
      if (s === 'open') { openAt = performance.now(); forceSend = true; link.setMeta(myMeta()); }
      ui.refresh();
    };
    ui.refresh();
    return true;
  }
  function leave(why) {
    const link = net.link;
    net.link = null;
    if (link) link.close();
    for (const r of [...net.remotes.values()]) { r.present = false; dropRemote(r); }
    nPresent = 0;
    net.room = null; net.status = why === 'full' ? 'full' : 'off'; me.host = 0; wantFly = null;
    session.set('room', null); session.set('host', null);
    try {
      const u = new URL(location.href);
      u.searchParams.delete('room');
      history.replaceState(null, '', u.pathname + u.search.replace(/=(&|$)/g, '$1') + u.hash);
    } catch { /* sandboxed */ }
    ui.refresh();
    if (why === 'full') { ctx.toast(STR.full, 5); ui.open(); }
  }
  // Start a room (this player hosts): returns { room, link } or null where live
  // rooms are off. opts.shared: the room's small shared object (a challenge, a seed).
  net.start = (opts = {}) => {
    if (!relay) { ui.open(); return null; }
    if (!net.room) connect(newId(6), { host: true, shared: opts.shared });
    else if (opts.shared !== undefined) net.setShared(opts.shared);
    if (opts.panel !== false) ui.open();
    return { room: net.room, link: net.linkUrl() };
  };
  net.join = (room, opts = {}) => (validId(room) ? connect(room, { fly: opts.fly !== false }) : false);
  net.leave = () => leave();
  net.linkUrl = () => {
    const u = new URL(location.origin + location.pathname.replace(/index\.html$/, ''));
    u.searchParams.set('room', net.room || '');
    if (relay?.kind === 'local') u.searchParams.set('relay', 'local');
    else if (relay?.dev) u.searchParams.set('relay', relay.dev);
    return u.href;
  };
  net.setName = (name, color) => {
    me.name = cleanName(name, me.name); store.set('net:name', me.name);
    if (Number.isInteger(color) && color >= 0 && color < COLORS.length) { me.color = color; store.set('net:color', color); }
    if (net.link) publishMeta();
    ui.refresh();
  };

  // ---- Fly to a player: in the air beside them, going their way ----
  const _f = new THREE.Vector3();
  function spotNear(r) {
    const o = r.pose, speed = Math.hypot(o.v[0], o.v[1]);
    // (The speed sent is the one seen on the wall clock: a friend whose device runs the flight slowly is still flying.)
    const moving = !(o.flags & (F.ground | F.crashed | F.frozen | F.away)) && speed > 1.5;
    // Their heading: along the track when moving, else where the nose points.
    _f.set(1, 0, 0).applyQuaternion(_q.set(o.q[0], o.q[1], o.q[2], o.q[3]));
    const hdg = moving ? Math.atan2(o.v[0], o.v[1]) : Math.atan2(_f.x, _f.y);
    const fe = Math.sin(hdg), fn = Math.cos(hdg), sigma = Math.pow(Math.max(0.2, 1 - 2.25577e-5 * o.p[2]), 4.2559);
    if (moving) {
      // Loose formation: behind and to the right, a little above, at their speed.
      const back = 60 + 1.2 * (r.kind?.length || 15), right = 35 + 0.8 * (r.kind?.span || 12);
      return { e: o.p[0] - fe * back + fn * right, n: o.p[1] - fn * back - fe * right, u: o.p[2] + 8, hdg: (hdg / DEG + 360) % 360, kias: Math.hypot(speed, o.v[2]) * Math.sqrt(sigma) / 0.514444 };
    }
    // Not flying (parked, taxiing, paused): a mile out, above, heading for them.
    return { e: o.p[0] - fe * 1600, n: o.p[1] - fn * 1600, u: Math.max(o.p[2], ctx.groundAt(o.p[0], o.p[1])) + 300, hdg: (hdg / DEG + 360) % 360, kias: 0 };
  }
  net.flyTo = (id) => {
    const r = net.remotes.get(id);
    if (!r || r.age === null || r.age > STALE_FADE[1]) { if (r) ctx.toast(STR.noTarget(r.meta.name), 2.5); return false; }
    ctx.spawn(() => spotNear(r));
    ctx.toast(STR.with(r.meta.name), 3);
    forceSend = true;
    return true;
  };
  // After joining from a link: beside the host as soon as they are seen (else anyone flying).
  function autoFly() {
    if (!wantFly) return;
    const t = performance.now();
    const cands = present().filter((r) => r.age !== null && r.age < 2);
    const pick = cands.find((r) => r.meta.host && !(r.pose.flags & F.ground)) || cands.find((r) => !(r.pose.flags & F.ground)) || (t > wantFly.until - 6500 ? cands.find((r) => r.meta.host) || cands[0] : null);
    if (pick) { wantFly = null; net.flyTo(pick.id); return; }
    if (t > wantFly.until) { wantFly = null; if (!present().length) ctx.toast(STR.nobody, 4); }
  }

  // ---- A ghost: a recorded flight (replay.js), drawn and flown to like another player ----
  // rows: state arrays as recorded; it starts now, plays once, and fades out at its end.
  net.playGhost = (rows, meta = {}) => {
    net.stopGhost();
    const states = [];
    for (const row of rows) { const st = decodeState(row); if (st && (!states.length || st.t > states[states.length - 1].t)) states.push(st); }
    if (states.length < 2) return false;
    const r = new Remote('#ghost', net), tr = new Track(), t0 = states[0].t;
    let next = 0, began = 0;
    r.meta = { ...r.meta, name: cleanName(meta.name, STR.ghost), color: Number.isInteger(meta.color) && meta.color >= 0 && meta.color < COLORS.length ? meta.color : me.color };
    r.seconds = (states[states.length - 1].t - t0) / 1000;
    r.sampler = (now, pose) => {
      if (!began) { began = now; tr.off = now - t0; }
      while (next < states.length && states[next].t <= now - tr.off + 1500) { tr.buf.push(states[next++]); if (tr.buf.length > 24) tr.buf.shift(); }
      r.played = (now - began) / 1000;
      return tr.sample(now, 0, pose);
    };
    net.remotes.set(r.id, r);
    net.ghost = r;
    ui.refresh();
    return true;
  };
  net.stopGhost = () => {
    const r = net.ghost;
    if (!r) return;
    net.ghost = null; r.sampler = null; r.dispose(); net.remotes.delete(r.id);
    ui.refresh();
  };

  // ---- Each frame ----
  const order = [];
  // dt: wall seconds this frame; simDt: seconds of flight it advanced; s, j, tp: the core's state.
  // Every time here is the frame's own start on the wall clock (ctx.frameStart:
  // where the app's step counts from), for this aircraft's state and for
  // where the others are drawn. Reading the clock at this point instead, some
  // milliseconds into the frame and never the same number, would put every
  // aircraft that far off along its path: at 120 kt, 10 ms is over half a metre.
  // The core flies in whole 1/240 s steps, so its state is up to one step
  // older than the frame's start: in real time that remainder comes off too.
  let startWas = 0, t42Was = 0, simAcc = 0, drawWas = 0;
  net.update = (dt, simDt, s, j, tp, P, crashed) => {
    const start = performance.timeOrigin + ctx.frameStart();
    // Seconds of flight per second of wall clock, over the last half second: 1,
    // less in slow motion or while frames run long (the core steps 0.1 s at most), 0 paused.
    const wallDt = startWas ? (start - startWas) / 1000 : 0, flew = s[42] - t42Was;
    startWas = start; t42Was = s[42];
    if (simDt <= 0) { rate = 0; rw.n = 0; rw.sim = rw.wall = 0; }
    else if (wallDt > 1e-4 && wallDt < 2 && flew >= 0 && flew < 0.2) {
      while (rw.n && (rw.n === RW_N || rw.wall > 0.5)) { const old = (rw.i - rw.n + RW_N) % RW_N; rw.sim -= rw.s[old]; rw.wall -= rw.w[old]; rw.n--; }
      rw.s[rw.i] = flew; rw.w[rw.i] = wallDt; rw.sim += flew; rw.wall += wallDt; rw.i = (rw.i + 1) % RW_N; rw.n++;
      const r = clamp(rw.sim / rw.wall, 0, 1);
      rate = r > 0.97 || rw.wall < 0.1 ? 1 : r;
    }
    simAcc += simDt;
    let behind = simAcc - s[42];
    if (behind < 0 || behind > 0.02) { simAcc = s[42]; behind = 0; }
    const now = net.now = start - (rate === 1 ? behind * 1000 : 0);
    dt = drawWas ? clamp((now - drawWas) / 1000, 0, 0.5) : dt;  // the others move on the wall clock, whatever this frame's flight step was
    drawWas = now;
    readOwn(now, s, j, tp, P, crashed);
    if (net.recordFrame) net.recordFrame(now, own, rate, encodeOwn);
    if (net.link && net.status === 'open' && nPresent && due(now)) sendOwn(now);
    autoFly();
    if (!net.remotes.size) { net.sound.update(own); return; }
    // The game's own animated model for the nearest few only.
    order.length = 0;
    for (const r of net.remotes.values()) order.push(r);
    order.sort((a, b) => a.dist - b.dist);
    let fullLeft = ctx.MOBILE ? 2 : 3;
    for (const r of order) {
      if (r.update(now, dt, fullLeft)) fullLeft--;
      // A player the room no longer lists, silent: gone.
      if (!r.present && !r.sampler && (r.age === null || r.age > STALE_FADE[1])) dropRemote(r);
    }
    if (net.ghost && net.ghost.age > STALE_FADE[1]) net.stopGhost();  // played out
    net.sound.update(own);
  };
  // Seen off-tab: tell the others this aircraft is parked in the sky for now.
  document.addEventListener('visibilitychange', () => {
    away = document.hidden;
    if (!net.link || net.status !== 'open' || !prev.has) return;
    if (away) { rate = 0; own.flags |= F.away | F.frozen; own.t = wallNow(); sendOwn(own.t); } else forceSend = true;
  });

  // ---- Name tags, and arrows to friends off the screen ----
  // On a canvas of their own above the flight readouts (an arrow at the
  // screen's edge must not hide behind a panel), shown only while there is
  // someone to point at.
  const tags = document.createElement('canvas');
  tags.id = 'netTags'; tags.setAttribute('aria-hidden', 'true'); tags.hidden = true;
  document.body.append(tags);
  const g = tags.getContext('2d');
  let tagW = 0, tagH = 0, tagD = 0;
  const _p = new THREE.Vector3();
  function pill(x, y, label, color, tw) {
    g.fillStyle = 'rgba(10,17,28,.8)'; g.beginPath();
    if (g.roundRect) g.roundRect(x, y - 10, tw, 20, 10); else g.rect(x, y - 10, tw, 20);  // (older browsers: square corners)
    g.fill();
    g.fillStyle = color; g.beginPath(); g.arc(x + 11, y, 4, 0, 6.2832); g.fill();
    g.fillStyle = '#e7ecf2'; g.fillText(label, x + 20, y + 0.5);
  }
  net.draw = () => {
    let any = false;
    for (const r of net.remotes.values()) if (r.has && r.alpha > 0) { any = true; break; }
    if (tags.hidden === any) tags.hidden = !any;
    if (!any) return;
    const w = innerWidth, h = innerHeight, d = Math.min(devicePixelRatio, 2), cam = ctx.camera, small = ctx.MOBILE;
    if (w !== tagW || h !== tagH || d !== tagD) { tagW = w; tagH = h; tagD = d; tags.width = w * d; tags.height = h * d; }
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = `600 ${small ? 11 : 12}px "Public Sans",system-ui,sans-serif`;
    g.textBaseline = 'middle'; g.textAlign = 'left';
    // The edge arrows keep clear of the top bar and, on a phone, of the stick and throttle.
    const padX = small ? 24 : 30, top0 = small ? 104 : 76, bot = small ? 190 : 56;
    for (const r of net.remotes.values()) {
      if (!r.has || r.alpha <= 0) continue;
      const top = (r.kind?.top || 2) + 1.5, dist = r.dist;
      _p.set(r.p[0], r.p[2] + top, -r.p[1]).applyMatrix4(cam.matrixWorldInverse);
      const behind = _p.z > -0.5;
      _p.applyMatrix4(cam.projectionMatrix);
      let x = _p.x, y = _p.y;
      if (behind) { x = -x; y = -y; }
      const label = `${r.meta.name} · ${km(dist)}`, tw = g.measureText(label).width + 28;
      g.globalAlpha = r.alpha;
      if (!behind && Math.abs(x) < 0.96 && y < 0.88 && y > -0.94) {
        // On screen: the tag above it, a small ring round it once it is a speck.
        const px = (x + 1) / 2 * w, py = (1 - y) / 2 * h;
        if (dist > 900) { g.strokeStyle = r.color; g.lineWidth = 1.5; g.beginPath(); g.arc(px, py + 12, 8, 0, 6.2832); g.stroke(); }
        pill(clamp(px - tw / 2, 6, w - tw - 6), Math.max(py - 16, 14), label, r.color, tw);
      } else {
        // Off screen: an arrow at the edge pointing the way to look, the name inside it.
        const m = Math.max(Math.abs(x), Math.abs(y), 1e-6);
        const px = clamp((x / m + 1) / 2 * w, padX, w - padX), py = clamp((1 - y / m) / 2 * h, top0, h - bot);
        let dx = px - w / 2, dy = py - h / 2;
        const n = Math.hypot(dx, dy) || 1;
        dx /= n; dy /= n;
        g.save(); g.translate(px, py); g.rotate(Math.atan2(dy, dx));
        g.fillStyle = r.color; g.strokeStyle = 'rgba(10,17,28,.9)'; g.lineWidth = 2; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(13, 0); g.lineTo(-9, -10); g.lineTo(-4, 0); g.lineTo(-9, 10); g.closePath(); g.stroke(); g.fill();
        g.restore();
        const cx = px - dx * (22 + Math.abs(dx) * tw / 2), cy = py - dy * (20 + Math.abs(dy) * 6);
        pill(clamp(cx - tw / 2, 6, w - tw - 6), clamp(cy, top0 - 8, h - bot + 8), label, r.color, tw);
      }
    }
    g.globalAlpha = 1;
  };
  // For the moving maps (the jets' navigation display, the G1000's map):
  // [name, east, north, feet above this aircraft, colour].
  const blips = [];
  net.traffic = () => {
    blips.length = 0;
    for (const r of net.remotes.values()) if (r.has && r.alpha > 0) blips.push([r.meta.name, r.p[0], r.p[1], (r.p[2] - own.p[2]) / 0.3048, r.color]);
    return blips;
  };

  net.sound = mountSound(net, ctx);
  const ui = mountUi(net, ctx, STR, { connect, leave, players, present });
  net.ui = ui;
  // A link with a room: ask (name, in the air or on the runway); a reload of a
  // tab already in that room goes straight back in.
  const linked = params.get('room');
  if (validId(linked)) {
    if (session.get('room') === linked && relay) connect(linked, { host: session.get('host') === linked, fly: true });
    else ui.invite(linked);
  }
  return net;
}

// ---- The others' engines, heard when they are near -------------------------------------------
// Two voices at most (the nearest two within earshot), on an audio context of
// its own, apart from the player's own aircraft's sound (audio.js): a
// propeller's beat or a jet's hiss and rumble, louder close by, shifted by
// the speed they close or open at. On only while the game's sound is on.
const EARSHOT = 900;
function mountSound(net, ctx) {
  let ac = null, voices = null, master = null;
  function start() {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination);
    const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; ++i) d[i] = Math.random() * 2 - 1;
    voices = [0, 1].map(() => {
      const out = ac.createGain(); out.gain.value = 0; out.connect(master);
      const osc = ac.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 80;
      const tone = ac.createGain(); tone.gain.value = 0;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      osc.connect(lp).connect(tone).connect(out); osc.start();
      const noise = ac.createBufferSource(); noise.buffer = buf; noise.loop = true;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
      const hiss = ac.createGain(); hiss.gain.value = 0;
      noise.connect(bp).connect(hiss).connect(out); noise.start();
      return { out, osc, tone, bp, hiss, id: null };
    });
  }
  const near = [];
  return {
    get on() { return !!ac && ac.state === 'running'; },
    voices: () => voices,
    update(own) {
      const vol = ctx.sound ? ctx.sound() : 0;
      if (!ac) { if (vol <= 0 || !net.remotes.size) return; try { start(); } catch { return; } }
      if (vol <= 0 || !net.remotes.size) { if (ac.state === 'running') ac.suspend(); return; }
      if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime;
      master.gain.setTargetAtTime(vol * (ctx.cockpit?.() ? 0.45 : 1), t, 0.1);
      near.length = 0;
      for (const r of net.remotes.values()) if (r.has && r.alpha > 0 && r.kind && r.dist < EARSHOT && !(r.pose.flags & F.frozen)) near.push(r);
      near.sort((a, b) => a.dist - b.dist);
      for (let i = 0; i < 2; ++i) {
        const v = voices[i], r = near[i];
        if (!r) { v.out.gain.setTargetAtTime(0, t, 0.15); continue; }
        const o = r.pose, p = r.kind.profile, d = Math.max(r.dist, 12);
        // Closing speed along the line between the two (m/s, + approaching): the pitch shift.
        const ux = (r.p[0] - own.p[0]) / d, uy = (r.p[1] - own.p[1]) / d, uz = (r.p[2] - own.p[2]) / d;
        const closing = -((o.v[0] - own.v[0]) * ux + (o.v[1] - own.v[1]) * uy + (o.v[2] - own.v[2]) * uz);
        const dop = clamp(1 + closing / 340, 0.7, 1.4), gain = clamp(30 / d, 0, 1) * clamp(1 - d / EARSHOT, 0, 1) * 1.6;
        if (p.jet && !p.turboprop) {
          const n1 = clamp(o.e1 / 1000, 0, 1.1);
          v.osc.frequency.setTargetAtTime((55 + 70 * n1) * dop, t, 0.1); v.tone.gain.setTargetAtTime(0.25 * n1, t, 0.1);
          v.bp.frequency.setTargetAtTime((900 + 2600 * n1) * dop, t, 0.1); v.hiss.gain.setTargetAtTime(0.1 + 0.5 * n1, t, 0.1);
        } else {
          // Blade-pass: a 172's two blades at engine speed; a King Air's four at propeller speed.
          const rpm = o.e1, f = rpm / 60 * (p.turboprop ? 4 : 2);
          v.osc.frequency.setTargetAtTime(Math.max(20, f) * dop, t, 0.08); v.tone.gain.setTargetAtTime(rpm > 200 ? 0.55 : 0, t, 0.1);
          v.bp.frequency.setTargetAtTime(1200 * dop, t, 0.1); v.hiss.gain.setTargetAtTime(p.turboprop ? 0.2 : 0.06, t, 0.1);
        }
        v.out.gain.setTargetAtTime(gain, t, 0.12);
        v.id = r.id;
      }
    },
  };
}

// ---- The panel, the invitation and the status chip ------------------------------------------
const CSS = `
#bNet .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--good);margin-right:6px;vertical-align:1px}
#bNet .dot.wait{background:var(--warn)} #bNet .dot.bad{background:var(--bad)}
#netTags{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2}
#netTags[hidden]{display:none}
#netPanel{position:fixed;right:12px;top:66px;width:320px;max-width:calc(100% - 24px);max-height:calc(100% - 78px);overflow:auto;z-index:6;touch-action:pan-y}
#netPanel[hidden],#netInvite[hidden]{display:none}
#netPanel h2,#netInvite h2{font:800 17px/1 var(--display);text-transform:uppercase;letter-spacing:.03em;margin:0 0 8px}
#netPanel p,#netInvite p{margin:0 0 10px;color:var(--mute);font-size:13px}
#netPanel .x{position:absolute;right:8px;top:8px;padding:4px 8px}
.net-field{display:flex;gap:8px;align-items:center;margin:0 0 10px}
.net-field span{font-size:12px;color:var(--mute);white-space:nowrap}
.net-field input{flex:1;min-width:0;font:600 14px var(--body);color:var(--ink);background:#141d2b;border:1px solid var(--line);border-radius:6px;padding:8px 9px;-webkit-user-select:text;user-select:text;touch-action:auto}
.net-sw{display:flex;gap:6px;margin:0 0 12px}
.net-sw button{width:26px;height:26px;border-radius:50%;padding:0;border:2px solid transparent}
.net-sw button[aria-pressed="true"]{border-color:#fff;box-shadow:0 0 0 2px rgba(10,17,28,.9) inset}
.net-go{display:block;width:100%;padding:11px 12px;font-size:14px;background:var(--plate);border-color:var(--plate);color:#fff;margin:0 0 8px}
.net-go:hover{background:#2a66d6}
.net-go[disabled]{opacity:.45;cursor:default}
.net-alt{display:block;width:100%;padding:9px 12px;margin:0 0 4px}
.net-status{font:600 12px var(--mono);color:var(--ink);margin:0 0 10px}
.net-status.bad{color:var(--bad)} .net-status.wait{color:var(--warn)}
.net-link{display:flex;gap:6px;margin:0 0 10px}
.net-link input{flex:1;min-width:0;font:500 12px var(--mono);color:var(--ink);background:#141d2b;border:1px solid var(--line);border-radius:6px;padding:7px 8px;-webkit-user-select:text;user-select:text;touch-action:auto}
.net-list{display:grid;gap:4px;margin:0 0 12px}
.net-row{display:grid;grid-template-columns:12px minmax(0,1fr) auto;gap:8px;align-items:center;background:rgba(255,255,255,.05);border-radius:6px;padding:6px 8px}
.net-row i{width:10px;height:10px;border-radius:50%}
.net-row b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.net-row small{display:block;color:var(--mute);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.net-row button{padding:5px 9px}
.net-foot{display:flex;gap:6px;justify-content:space-between;flex-wrap:wrap}
#netInvite{position:fixed;inset:0;z-index:20;display:flex;overflow:auto;background:rgba(5,9,16,.55);padding:16px;touch-action:pan-y}
#netInvite .panel{width:340px;max-width:100%;margin:auto}
@media (max-width:720px){#netPanel{left:12px;right:12px;width:auto;top:auto;bottom:12px;max-height:70%}}
`;
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  e.append(...kids.filter(Boolean));
  return e;
}
function mountUi(net, ctx, STR, { connect, leave, players, present }) {
  document.head.append(el('style', { text: CSS }));
  const me = net.me;
  // The button in the top bar: "Fly together", or the room's status once in one.
  const btn = el('button', { id: 'bNet', title: STR.title, 'aria-expanded': 'false', onclick: (e) => { toggle(); e.currentTarget.blur(); } });
  const bar = document.querySelector('.top .row') || document.body;
  bar.prepend(btn);
  const panel = el('aside', { id: 'netPanel', class: 'panel', 'aria-label': STR.title, hidden: '' });
  const invite = el('div', { id: 'netInvite', role: 'dialog', 'aria-modal': 'true', 'aria-label': STR.title, hidden: '' });
  document.body.append(panel, invite);
  let inviteRoom = null, copiedT = 0;

  // Name and colour, shared by the panel and the invitation. Typed text never
  // reaches the page as HTML: inputs' values and textContent only.
  function identity(onEnter) {
    const input = el('input', { type: 'text', maxlength: '16', autocomplete: 'off', spellcheck: 'false', class: 'net-name' });
    input.value = me.name;
    input.addEventListener('change', () => { net.setName(input.value, me.color); input.value = me.name; });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { input.blur(); onEnter?.(); } });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    const sw = el('div', { class: 'net-sw', role: 'group', 'aria-label': STR.colour });
    COLORS.forEach((c, i) => {
      const b = el('button', { 'aria-pressed': String(i === me.color), 'aria-label': `${STR.colour} ${i + 1}`, onclick: () => { net.setName(input.value, i); sw.querySelectorAll('button').forEach((x, k) => x.setAttribute('aria-pressed', String(k === i))); } });
      b.style.background = c;
      sw.append(b);
    });
    return [el('label', { class: 'net-field' }, el('span', { text: STR.name }), input), sw];
  }
  function statusLine() {
    const n = players();
    const [text, cls] = net.status === 'open' ? [n > 1 ? STR.flying(n) : STR.alone, '']
      : net.status === 'connecting' ? [STR.connecting, 'wait'] : net.status === 'reconnecting' ? [STR.reconnecting, 'wait']
        : net.status === 'failed' ? [STR.failed, 'bad'] : net.status === 'full' ? [STR.full, 'bad'] : ['', ''];
    return el('div', { class: `net-status ${cls}`, role: 'status', text });
  }
  let listEl = null;
  function renderList() {
    if (!listEl) return;
    const rows = [el('div', { class: 'net-row' }, dot(COLORS[me.color]), el('div', {}, el('b', { text: me.name }), el('small', { text: `${STR.you}${me.host ? ` · ${STR.host}` : ''} · ${TYPE_NAMES[ctx.profile().id] || ''}` })), null)];
    for (const r of present().sort((a, b) => a.dist - b.dist)) {
      const seen = r.age !== null && r.age < STALE_FADE[1], awayNow = !seen || !!(r.pose.flags & F.away);
      const where = awayNow ? STR.away : `${km(r.dist)}${r.pose.flags & F.ground ? ` · ${STR.onGround}` : ''}`;
      const go = el('button', { text: STR.flyTo, onclick: (e) => { net.flyTo(r.id); e.currentTarget.blur(); if (ctx.MOBILE) close(); } });
      if (!seen) go.disabled = true;
      rows.push(el('div', { class: 'net-row' }, dot(r.color), el('div', {}, el('b', { text: r.meta.name }), el('small', { text: `${TYPE_NAMES[TYPES[seen ? r.pose.type : r.meta.type]] || ''}${r.meta.host ? ` · ${STR.host}` : ''} · ${where}` })), go));
    }
    const gh = net.ghost;
    if (gh) rows.push(el('div', { class: 'net-row' }, dot(gh.color), el('div', {}, el('b', { text: gh.meta.name }), el('small', { text: gh.has ? km(gh.dist) : '' })),
      el('button', { text: STR.flyTo, onclick: (e) => { net.flyTo(gh.id); e.currentTarget.blur(); if (ctx.MOBILE) close(); } })));
    listEl.replaceChildren(...rows);
  }
  const dot = (c) => { const i = el('i'); i.style.background = c; return i; };
  function renderPanel() {
    const kids = [el('button', { class: 'x', 'aria-label': STR.close, text: '✕', onclick: close }), el('h2', { text: STR.title })];
    listEl = null;
    if (!net.room) {
      kids.push(el('p', { text: STR.intro }));
      if (net.status === 'full') kids.push(statusLine());
      if (!net.relay) kids.push(el('p', { class: 'net-status wait', id: 'netOff', text: STR.off }));
      kids.push(...identity(net.relay ? () => net.start() : null));
      const go = el('button', { class: 'net-go', id: 'netStart', text: STR.start, onclick: () => net.start() });
      if (!net.relay) go.disabled = true;
      kids.push(go);
    } else {
      kids.push(statusLine());
      const link = el('input', { type: 'text', readonly: '', id: 'netLink', 'aria-label': STR.link });
      link.value = net.linkUrl();
      link.addEventListener('focus', () => link.select());
      link.addEventListener('keydown', (e) => e.stopPropagation());
      const copy = el('button', { id: 'netCopy', text: performance.now() < copiedT ? STR.copied : STR.copy, onclick: async () => {
        try { await navigator.clipboard.writeText(link.value); } catch { link.select(); try { document.execCommand('copy'); } catch { /* the field is selected: copy by hand */ } }
        copiedT = performance.now() + 1600; copy.textContent = STR.copied; setTimeout(() => { copy.textContent = STR.copy; }, 1600);
      } });
      const row = el('div', { class: 'net-link' }, link, copy);
      if (navigator.share) row.append(el('button', { id: 'netShare', text: STR.share, onclick: () => { navigator.share({ title: STR.title, text: STR.shareText, url: link.value }).catch(() => {}); } }));
      kids.push(el('p', { text: STR.link }), row);
      listEl = el('div', { class: 'net-list', id: 'netList' });
      kids.push(listEl, ...identity(null), el('div', { class: 'net-foot' }, el('button', { id: 'netLeave', text: STR.leave, onclick: () => { leave(); } })));
    }
    if (net.panelExtra) kids.push(...net.panelExtra(el));  // (replay.js: the ghost's buttons)
    panel.replaceChildren(...kids);
    renderList();
  }
  function renderInvite() {
    const kids = [el('h2', { text: STR.title }), el('p', { text: STR.invited })];
    if (!net.relay) kids.push(el('p', { class: 'net-status wait', id: 'netOff', text: STR.off }));
    const go = (fly) => { const room = inviteRoom; inviteRoom = null; invite.hidden = true; connect(room, { fly }); refresh(); };
    kids.push(...identity(net.relay ? () => go(true) : null));
    const a = el('button', { class: 'net-go', id: 'netJoinAir', text: STR.joinAir, onclick: () => go(true) });
    if (!net.relay) a.disabled = true;
    kids.push(a, net.relay ? el('button', { class: 'net-alt', id: 'netJoinGround', text: STR.joinGround, onclick: () => go(false) })
      : el('button', { class: 'net-alt', id: 'netInviteClose', text: STR.close, onclick: () => { inviteRoom = null; invite.hidden = true; } }));
    invite.replaceChildren(el('div', { class: 'panel' }, ...kids));
  }
  function refresh() {
    const n = players(), inRoom = !!net.room;
    const cls = net.status === 'open' ? '' : net.status === 'failed' ? 'bad' : 'wait';
    btn.replaceChildren(...(inRoom ? [el('span', { class: `dot ${cls}` }), net.status === 'open' ? STR.chip(n) : net.status === 'failed' ? STR.button : STR.reconnecting.replace('…', '')] : [STR.button]));
    btn.setAttribute('aria-pressed', 'false');
    btn.title = inRoom && net.status === 'open' ? (n > 1 ? STR.flying(n) : STR.alone) : STR.title;
    if (!panel.hidden) {
      // Typing a name: leave the field alone.
      const typing = panel.contains(document.activeElement) && document.activeElement.matches('input:not([readonly])');
      if (typing && (panel.querySelector('#netList') !== null) === inRoom) {
        const st = panel.querySelector('.net-status'); if (st && inRoom) st.replaceWith(statusLine());
        renderList();
      } else renderPanel();
    }
  }
  function open() { ctx.closeMenus?.(); panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); renderPanel(); }
  function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  function toggle() { if (panel.hidden) open(); else close(); }
  // The list's distances, twice a second while the panel shows.
  setInterval(() => { if (!panel.hidden && net.room) renderList(); }, 500);
  refresh();
  return {
    refresh, open, close, toggle,
    invite(room) { inviteRoom = room; invite.hidden = false; renderInvite(); },
    inviteOpen: () => !invite.hidden,
  };
}
