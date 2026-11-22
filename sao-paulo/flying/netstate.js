// São Paulo World · flying together: what travels between players, and how a
// received aircraft is placed between and beyond its updates. No three.js, no
// DOM: plain numbers, so it runs (and is tested) in Node as well.
//
// Every browser flies its own aircraft; it only tells the others where it is.
// A state message is one flat array of integers (quantised; ~120 bytes as
// JSON), in the frame every player shares whatever airport each loaded: the
// flight core's world ENU, metres east and north of MASP and metres above sea
// level (app.js: avd_state 0–2; the same numbers at Congonhas and Campo de
// Marte), attitude as the core's body-FLU → ENU quaternion.
//
// Times are the sender's wall clock (ms). Velocity and turn rate are per
// second of that clock (a paused sender sends zeros; slow motion sends them
// slowed), so "position + velocity × time since" is right whatever the
// sender's simulation is doing.

export const PROTO = 1;
// The aircraft a message may name, by index (app.js PROFILES ids). Append only.
export const TYPES = ['c172', 'topg', 'phenom300', 'cj4', 'learjet45', 'crj700', 'b738', 'kingair'];
export const MAX_PLAYERS = 8;
// Flags (bit field).
export const F = { ground: 1, crashed: 2, lights: 4, frozen: 8, away: 16, epochShift: 5, epochMask: 7 };

const N_FIELDS = 26;
const LIM = {
  pos: 4.5e8,          // cm: ±4,500 km of MASP covers Brazil
  upMin: -1e5, upMax: 3e6,  // cm: −1 km .. 30 km
  vel: 60000,          // cm/s: 600 m/s
  rate: 12000,         // mrad/s
  t: 4e12,             // ms: past the year 2096
};
const isInt = Number.isInteger;
const inR = (v, a, b) => isInt(v) && v >= a && v <= b;

// o: { t ms, p [e,n,u] m, q [x,y,z,w], v [m/s], w [rad/s, ENU], type index, flags,
//      gear 0..1, flap deg, e1, e2 (rpm, or N1 % for a jet), aux (propeller blade deg),
//      ail, elev, rud −1..1, spd 0..1 (speedbrake) }
export function encodeState(o) {
  const s = o.q[3] < 0 ? -32767 : 32767, r = Math.round, c = (v, a, b) => Math.min(b, Math.max(a, r(v)));
  return [PROTO, r(o.t),
    c(o.p[0] * 100, -LIM.pos, LIM.pos), c(o.p[1] * 100, -LIM.pos, LIM.pos), c(o.p[2] * 100, LIM.upMin, LIM.upMax),
    c(o.q[0] * s, -32767, 32767), c(o.q[1] * s, -32767, 32767), c(o.q[2] * s, -32767, 32767),
    c(o.v[0] * 100, -LIM.vel, LIM.vel), c(o.v[1] * 100, -LIM.vel, LIM.vel), c(o.v[2] * 100, -LIM.vel, LIM.vel),
    c(o.w[0] * 1000, -LIM.rate, LIM.rate), c(o.w[1] * 1000, -LIM.rate, LIM.rate), c(o.w[2] * 1000, -LIM.rate, LIM.rate),
    o.type, o.flags & 255, c(o.gear * 100, 0, 100), c(o.flap * 10, -100, 900),
    c(o.e1, 0, 20000), c(o.e2, 0, 20000), c(o.aux * 10, -900, 900),
    c(o.ail * 100, -100, 100), c(o.elev * 100, -100, 100), c(o.rud * 100, -100, 100), c(o.spd * 100, 0, 100), 0];
}

// A received array → a state, or null for anything that is not exactly a
// well-formed message (wrong type or length, a non-integer, NaN, out of
// range). Nothing a stranger sends gets past here unchecked. o: where the
// state starts in the array (the sender's id comes first on the wire).
export function decodeState(a, o = 0) {
  if (!Array.isArray(a) || a.length !== N_FIELDS + o || a[o] !== PROTO) return null;
  const g = (i) => a[i + o];
  if (!inR(g(1), 1, LIM.t)) return null;
  if (!inR(g(2), -LIM.pos, LIM.pos) || !inR(g(3), -LIM.pos, LIM.pos) || !inR(g(4), LIM.upMin, LIM.upMax)) return null;
  for (let i = 5; i < 8; ++i) if (!inR(g(i), -32767, 32767)) return null;
  for (let i = 8; i < 11; ++i) if (!inR(g(i), -LIM.vel, LIM.vel)) return null;
  for (let i = 11; i < 14; ++i) if (!inR(g(i), -LIM.rate, LIM.rate)) return null;
  if (!inR(g(14), 0, TYPES.length - 1) || !inR(g(15), 0, 255) || !inR(g(16), 0, 100) || !inR(g(17), -100, 900)) return null;
  if (!inR(g(18), 0, 20000) || !inR(g(19), 0, 20000) || !inR(g(20), -900, 900)) return null;
  for (let i = 21; i < 24; ++i) if (!inR(g(i), -100, 100)) return null;
  if (!inR(g(24), 0, 100) || !isInt(g(25))) return null;
  const x = g(5) / 32767, y = g(6) / 32767, z = g(7) / 32767, n2 = x * x + y * y + z * z;
  if (n2 > 1.001) return null;
  const q = [x, y, z, Math.sqrt(Math.max(0, 1 - n2))], k = 1 / Math.hypot(q[0], q[1], q[2], q[3]);
  q[0] *= k; q[1] *= k; q[2] *= k; q[3] *= k;
  return {
    t: g(1), p: [g(2) / 100, g(3) / 100, g(4) / 100], q,
    v: [g(8) / 100, g(9) / 100, g(10) / 100], w: [g(11) / 1000, g(12) / 1000, g(13) / 1000],
    type: g(14), flags: g(15), gear: g(16) / 100, flap: g(17) / 10, e1: g(18), e2: g(19), aux: g(20) / 10,
    ail: g(21) / 100, elev: g(22) / 100, rud: g(23) / 100, spd: g(24) / 100,
  };
}

// ---- Names, ids, rooms: untrusted text ------------------------------------------
// A player's name as shown: at most 16 characters, no control, formatting or
// invisible characters, single spaces. It is only ever drawn as text
// (canvas fillText, textContent), never as HTML.
export function cleanName(v, fallback = 'Pilot') {
  if (typeof v !== 'string') return fallback;
  const s = Array.from(v.normalize('NFC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim()).slice(0, 16).join('').trim();
  return s || fallback;
}
export const validId = (v) => typeof v === 'string' && /^[a-z0-9]{4,12}$/.test(v);
export function newId(n = 6) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789', r = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(r, (v) => a[v % a.length]).join('');
}
// What a player publishes about themself and (the host) about the room: every
// field checked, anything else dropped. `room` is the host's small shared
// object (world settings and whatever the game layer attaches), bounded in size.
export function cleanMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {
    name: cleanName(m.name), color: inR(m.color, 0, 7) ? m.color : 0, type: inR(m.type, 0, TYPES.length - 1) ? m.type : 0,
    since: Number.isFinite(m.since) && m.since > 0 && m.since < LIM.t ? Math.floor(m.since) : LIM.t, host: m.host === 1 ? 1 : 0, room: null,
  };
  if (out.host && m.room && typeof m.room === 'object') {
    try {
      const txt = JSON.stringify(m.room);
      if (txt.length <= 2048 && inR(m.room.rv, 0, 1e9)) out.room = JSON.parse(txt);
    } catch { /* not plain data */ }
  }
  return out;
}

// ---- The message budget -----------------------------------------------------------
// The relay counts every message sent and every copy delivered, across the
// whole project (Supabase Realtime: 100 a second on the Free plan, 500 on
// Pro), so n players each sending f a second cost n·n·f. A room keeps under
// `roomEvents`: fewer, later updates as it fills; the interpolation delay
// grows to match. One place to change it (relay.js overrides roomEvents).
export const BUDGET = {
  roomEvents: 80,   // messages a second a whole room may cost (sent + delivered)
  hzMax: 12,        // updates a second at most, each player
  hzMin: 1,         // and at least, however full the room
  steadyHz: 2,      // flying straight (the others' extrapolation still holds): this often
  parkedSec: 2,     // standing still on the ground: one update every so many seconds
  posErr: 0.75,     // m: send early once the others' extrapolation would be this far off
  angErr: 2.5,      // degrees, likewise
};
export function sendHz(players, budget = BUDGET) {
  const n = Math.max(2, players);
  return Math.min(budget.hzMax, Math.max(budget.hzMin, budget.roomEvents / (n * n)));
}
// How far behind the newest update a player is drawn (ms): a little more than
// one update interval, so there is normally one ahead to interpolate toward.
export const renderDelay = (hz) => Math.max(150, 1250 / hz + 60);

// ---- Quaternions ([x, y, z, w]) -----------------------------------------------------
export function qMul(a, b, o = [0, 0, 0, 1]) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[0] = aw * bx + ax * bw + ay * bz - az * by; o[1] = aw * by - ax * bz + ay * bw + az * bx;
  o[2] = aw * bz + ax * by - ay * bx + az * bw; o[3] = aw * bw - ax * bx - ay * by - az * bz;
  return o;
}
export function qSlerp(a, b, t, o = [0, 0, 0, 1]) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1;
  if (d < 0) { d = -d; s = -1; }
  let ka = 1 - t, kb = t;
  if (d < 0.9995) { const th = Math.acos(d), sn = Math.sin(th); ka = Math.sin((1 - t) * th) / sn; kb = Math.sin(t * th) / sn; }
  kb *= s;
  const x = ka * a[0] + kb * b[0], y = ka * a[1] + kb * b[1], z = ka * a[2] + kb * b[2], w = ka * a[3] + kb * b[3], k = 1 / Math.hypot(x, y, z, w);
  o[0] = x * k; o[1] = y * k; o[2] = z * k; o[3] = w * k;
  return o;
}
// q turned by the rotation vector w·dt (world axes): exp(w dt) · q.
const qTmp = [0, 0, 0, 1];
export function qAdvance(q, w, dt, o = [0, 0, 0, 1]) {
  const ang = Math.hypot(w[0], w[1], w[2]) * dt;
  if (ang < 1e-9) { o[0] = q[0]; o[1] = q[1]; o[2] = q[2]; o[3] = q[3]; return o; }
  const k = Math.sin(ang / 2) / (ang / dt);
  qTmp[0] = w[0] * k; qTmp[1] = w[1] * k; qTmp[2] = w[2] * k; qTmp[3] = Math.cos(ang / 2);
  return qMul(qTmp, q, o);
}
// The rotation vector (world axes, radians) that takes a to b.
export function qDelta(a, b, o = [0, 0, 0]) {
  // b · conj(a)
  const x = -a[0], y = -a[1], z = -a[2], w = a[3];
  let dx = b[3] * x + b[0] * w + b[1] * z - b[2] * y, dy = b[3] * y - b[0] * z + b[1] * w + b[2] * x;
  let dz = b[3] * z + b[0] * y - b[1] * x + b[2] * w, dw = b[3] * w - b[0] * x - b[1] * y - b[2] * z;
  if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; dw = -dw; }
  const sn = Math.hypot(dx, dy, dz);
  if (sn < 1e-9) { o[0] = o[1] = o[2] = 0; return o; }
  const k = 2 * Math.atan2(sn, dw) / sn;
  o[0] = dx * k; o[1] = dy * k; o[2] = dz * k;
  return o;
}
export const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

// ---- One remote player's updates, and where they are now --------------------------
const MAX_BUF = 24;
const MAX_EXTRAP = 2.5;   // s: carried on along the last velocity this long, then held
// Turning is carried on less far than moving: a roll rate lasts a moment, and
// a lost update must not leave an aircraft rolling on by itself. The time a
// turn rate is applied for, t seconds after its update (sender and receiver
// use the same, so the sender knows what the others see).
const TURN_TAU = 0.4;
export const turnTime = (t) => TURN_TAU * (1 - Math.exp(-t / TURN_TAU));
export const STALE_FADE = [3, 5];  // s without an update: fading from, gone at
const epochOf = (s) => (s.flags >> F.epochShift) & F.epochMask;

export class Track {
  constructor() { this.buf = []; this.off = Infinity; this.last = 0; this.dropped = 0; this.got = 0; }
  // A decoded state received at `now` (ms, this browser's clock). False: dropped
  // (out of order, or faster than anyone sends: a flood costs nothing more).
  push(st, now) {
    const b = this.buf, n = b.length;
    if (n) {
      const lt = b[n - 1].t;
      if (st.t <= lt) {
        if (st.t > lt - 5000) { this.dropped++; return false; }
        b.length = 0; this.off = Infinity;  // far back: the sender's clock started again (a new session)
      } else if (st.t - lt < 20) { this.dropped++; return false; }
    }
    // The clocks' offset: the smallest (arrival − sent) seen is the fastest
    // trip; it creeps up slowly so a drifting clock is followed.
    this.off = Math.min(this.off + 0.001 * Math.min(1000, now - this.last), now - st.t);
    this.last = now; this.got++;
    b.push(st);
    if (b.length > MAX_BUF) b.shift();
    return true;
  }
  get newest() { return this.buf[this.buf.length - 1] || null; }
  // The state to draw at `now`, `delay` ms behind the sender: into `o` (p, q, v,
  // w and the visual fields). Returns the seconds past the newest update
  // (≤ 0 while interpolating), or null with nothing to draw.
  sample(now, delay, o) {
    const b = this.buf, n = b.length;
    if (!n) return null;
    const T = now - this.off - delay;
    let i = n - 1;
    while (i > 0 && b[i].t > T) --i;
    const a = b[i], c = b[i + 1];
    if (c && T >= a.t && epochOf(a) === epochOf(c)) {
      const h = (c.t - a.t) / 1000, s = (T - a.t) / (c.t - a.t);
      // Cubic Hermite through both positions with both velocities; a straight
      // line when the velocities do not fit the gap (a long silence).
      const s2 = s * s, s3 = s2 * s, h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
      let fit = h < 1.6;
      for (let k = 0; k < 3 && fit; ++k) fit = Math.abs(c.p[k] - a.p[k] - (a.v[k] + c.v[k]) * h / 2) < 4 + 0.25 * Math.abs(c.p[k] - a.p[k]);
      for (let k = 0; k < 3; ++k) {
        o.p[k] = fit ? h00 * a.p[k] + h10 * h * a.v[k] + h01 * c.p[k] + h11 * h * c.v[k] : a.p[k] + (c.p[k] - a.p[k]) * s;
        o.v[k] = fit ? a.v[k] + (c.v[k] - a.v[k]) * s : (c.p[k] - a.p[k]) / h;
        o.w[k] = a.w[k] + (c.w[k] - a.w[k]) * s;
      }
      qSlerp(a.q, c.q, s, o.q);
      const d = s < 0.5 ? a : c;
      o.type = d.type; o.flags = d.flags;
      o.gear = a.gear + (c.gear - a.gear) * s; o.flap = a.flap + (c.flap - a.flap) * s;
      o.e1 = a.e1 + (c.e1 - a.e1) * s; o.e2 = a.e2 + (c.e2 - a.e2) * s; o.aux = a.aux + (c.aux - a.aux) * s;
      o.ail = a.ail + (c.ail - a.ail) * s; o.elev = a.elev + (c.elev - a.elev) * s; o.rud = a.rud + (c.rud - a.rud) * s; o.spd = a.spd + (c.spd - a.spd) * s;
      o.epoch = epochOf(d);
      return (T - b[n - 1].t) / 1000;
    }
    // Before the first update, across a restart, or past the newest: from the
    // one update, carried along its velocity and turn rate for a while.
    const age = (T - a.t) / 1000, dt = Math.min(Math.max(age, 0), MAX_EXTRAP);
    for (let k = 0; k < 3; ++k) { o.p[k] = a.p[k] + a.v[k] * dt; o.v[k] = age > MAX_EXTRAP ? 0 : a.v[k]; o.w[k] = age > MAX_EXTRAP ? 0 : a.w[k]; }
    qAdvance(a.q, a.w, turnTime(dt), o.q);
    o.type = a.type; o.flags = a.flags; o.gear = a.gear; o.flap = a.flap; o.e1 = a.e1; o.e2 = a.e2; o.aux = a.aux;
    o.ail = a.ail; o.elev = a.elev; o.rud = a.rud; o.spd = a.spd; o.epoch = epochOf(a);
    return c ? 0 : (T - b[n - 1].t) / 1000;
  }
}
export const newPose = () => ({ p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], type: 0, flags: 0, gear: 1, flap: 0, e1: 0, e2: 0, aux: 0, ail: 0, elev: 0, rud: 0, spd: 0, epoch: 0 });

// ---- A flight, recorded: the same states, packed for a link or a file ---------------
// (replay.js) Rows of the integers above, delta-coded column by column, then
// deflated: a steady minute at 4 a second is about 2 kB.
export function packRows(rows) {
  const n = rows.length, out = new Int32Array(1 + n * (N_FIELDS - 1));
  out[0] = n;
  // Times as offsets from the first row (they do not fit 32 bits); the rest delta-coded.
  for (let i = 0, k = 1; i < n; ++i) for (let c = 1; c < N_FIELDS; ++c, ++k) {
    out[k] = i ? rows[i][c] - rows[i - 1][c] : c === 1 ? 0 : rows[0][c];
  }
  return out;
}
export function unpackRows(ints, t0 = 1) {
  const n = ints[0];
  if (!isInt(n) || n < 0 || n > 20000 || ints.length !== 1 + n * (N_FIELDS - 1)) return null;
  const rows = [];
  for (let i = 0, k = 1; i < n; ++i) {
    const r = new Array(N_FIELDS);
    r[0] = PROTO;
    for (let c = 1; c < N_FIELDS; ++c, ++k) r[c] = ints[k] + (i ? rows[i - 1][c] : c === 1 ? t0 : 0);
    rows.push(r);
  }
  return rows;
}
