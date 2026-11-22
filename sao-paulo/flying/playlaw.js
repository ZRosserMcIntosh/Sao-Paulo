// São Paulo World · flying game: Casual mode's control laws.
// Casual flies the same aircraft in the same air as the simulator. These laws
// are a co-pilot between the player and the controls: they read what a pilot
// can see (attitude, speed, height, vertical speed) and move the stick,
// rudder, throttle and brakes through avd_set_input, as a pilot would. They
// never touch the physics, so the airplane still stalls if it is forced to,
// and still hits what it is flown into.
//
// The player's stick means: left/right a bank angle (released: roll level and
// hold the heading), up/down a climb or descent angle (released: level off
// and hold the height). The speed is held on the throttle. The climb gives
// way before the speed falls to the floor, and the dive before it passes the
// ceiling, so neither a stall nor an overspeed comes from holding the stick.
//
// They run on the core's Sport preset (its rudder coordination and automatic
// mixture, at 240 Hz) with the core's straight-and-level hold off: Arcade's
// wing leveller and the hold would each fight a commanded bank or path. The
// trim wheel follows the pitch output here instead, as Arcade's auto-trim does.
// No DOM here: play.js feeds it, and scripts can fly it against the core in Node.

const DEG = Math.PI / 180, KT = 0.514444, G = 9.80665;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap180 = (d) => ((d + 540) % 360) - 180;
// The preset these laws fly on (avd_set_assist), and its stick shaping (30 % cubic):
// the inverse, so an output arrives at the controls as meant.
export const LAW_ASSIST = 1;
const EXPO = 0.3;
const unshape = (u) => {
  const a = Math.min(1, Math.abs(u));
  let r = a;
  for (let i = 0; i < 5; ++i) r -= ((1 - EXPO) * r + EXPO * r * r * r - a) / (1 - EXPO + 3 * EXPO * r * r);
  return Math.sign(u) * clamp(r, 0, 1);
};

// What Casual asks of each kind of aircraft: bank and path limits (deg), and
// the three speeds (kt) from its clean stall speed `vs` (the core's, at this weight).
export function casualLimits(kind, vs, vmo = 0) {
  // rollK: the roll gain (the heavier types answer the ailerons slowly); err: the path error the pitch law acts on at most (deg); dn: the g it may add.
  if (kind === 'piston') return { bank: 38, up: 9, down: 9, floor: Math.round(1.32 * vs), ceil: 138, speeds: [Math.round(1.45 * vs), 100, 125], rollK: 1, dn: 1, err: 10 };
  if (kind === 'turboprop') return { bank: 33, up: 11, down: 8, floor: Math.round(1.3 * vs), ceil: Math.min(245, vmo ? vmo - 15 : 245), speeds: [Math.round(1.45 * vs), 180, 230], rollK: 1.6, dn: 0.8, err: 5 };
  const fast = Math.min(290, vmo ? vmo - 25 : 290);
  return { bank: 33, up: 12, down: 7, floor: Math.round(1.3 * vs), ceil: fast + 12, speeds: [Math.round(1.45 * vs), Math.max(210, Math.round(1.75 * vs)), fast], rollK: 2.2, dn: 0.7, err: 4 };
}

export function makeLaw() {
  const st = {};
  const out = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, trim: 0 };
  function reset(throttle = 0.5) {
    Object.assign(st, { have: false, phi: 0, theta: 0, ias: 0, acc: 0, hdg: null, alt: null, rs: 1, thr: throttle, psi0: null, t: 0, phase: 0 });
  }
  reset();
  // Rates by difference between steps (the state gives angles, not rates).
  function rates(s, dt) {
    const phi = s[7] * DEG, theta = s[8] * DEG, ias = s[10];
    const ok = st.have && dt > 1e-4;
    const p = ok ? (phi - st.phi) / dt : 0, q = ok ? (theta - st.theta) / dt : 0;
    const a = ok ? clamp((ias - st.ias) / dt, -20, 20) : 0;
    st.acc += (a - st.acc) * (ok ? 1 - Math.exp(-dt / 0.6) : 0);
    // The climb rate from the height itself: the VSI (s[15]) lags and stops at its pegs.
    const vs = ok ? (s[2] - st.z) / dt : s[15] * 0.00508;
    st.phi = phi; st.theta = theta; st.ias = ias; st.z = s[2]; st.have = true;
    return { phi, theta, p, q, vs };
  }
  // Authority falls with dynamic pressure, as the core's own hold scales it.
  const qScale = (ias) => clamp(1531 / Math.max(0.6125 * (ias * KT) ** 2, 200), 0.3, 3);

  // In the air. x: -1 left .. 1 right; y: -1 down .. 1 up; vT: the speed to hold (kt);
  // L: casualLimits(); path0: the path flown with the stick centred (deg; null: level
  // and hold the height), thrust: false leaves the throttle closed (a glide, a flare);
  // floor: the speed the climb gives way to (kt; with flaps out it is lower than L.floor).
  function fly(s, dt, { x = 0, y = 0, vT, L, path0 = null, thrust = true, bank = L.bank, floor = L.floor }) {
    const { phi, p, q, vs } = rates(s, dt);
    const ias = s[10], tas = Math.max(s[11] * KT, 15), qS = qScale(ias);
    const gamma = Math.asin(clamp(vs / tas, -1, 1));
    // Roll: a bank angle from the stick; released, level the wings and hold the heading it then has.
    let phiCmd;
    if (Math.abs(x) > 0.02) { st.hdg = null; phiCmd = x * bank * DEG; }
    else if (st.hdg === null) { phiCmd = 0; if (Math.abs(phi) < 4 * DEG && Math.abs(p) < 0.1) st.hdg = s[9]; }
    else phiCmd = clamp(1.2 * wrap180(st.hdg - s[9]) * DEG, -12 * DEG, 12 * DEG);
    const ePhi = phiCmd - phi;
    const roll = clamp((2.4 * ePhi - 0.55 * p) * qS * L.rollK, -0.9, 0.9);
    // Pitch: a path angle from the stick; released, level off, then hold that height.
    let gCmd;
    if (Math.abs(y) > 0.02) { st.alt = null; gCmd = (path0 ?? 0) * DEG + y * (y > 0 ? L.up : L.down) * DEG; }
    else if (path0 !== null) { st.alt = null; gCmd = path0 * DEG; }
    else if (st.alt === null) { gCmd = 0; if (Math.abs(vs) < 0.8) st.alt = s[2]; }
    else gCmd = Math.asin(clamp(clamp(0.12 * (st.alt - s[2]), -3, 3) / tas, -1, 1));
    // The speed comes first: the climb gives way near the floor, the dive near the ceiling.
    const kV = 1.1 * DEG;
    gCmd = Math.min(gCmd, Math.max(-L.down * DEG, (ias - floor) * kV));
    gCmd = Math.max(gCmd, Math.min(L.up * DEG, (ias - L.ceil) * kV));
    const gRate = G / tas * (s[18] * Math.cos(phi) - Math.cos(gamma));
    const ff = 0.25 * (1 / Math.max(Math.cos(phi), 0.5) - 1);  // the pull a turn needs
    // The path error it acts on is bounded, and the g it may add or take away: a held stick never loads the wing to its limit.
    const eG = clamp(gCmd - gamma, -L.err * DEG, L.err * DEG);
    let pitch = (6 * eG - 2 * gRate - 1.5 * q) * qS + ff;
    pitch -= 0.6 * qS * (Math.max(0, s[18] - 1 - L.dn) - Math.max(0, 1 - 0.8 * L.dn - s[18]));
    pitch = clamp(pitch, -0.6, 0.8);
    // The stall warning has the last word: no more nose-up while it sounds.
    if (s[29] > 0.5) pitch = Math.min(pitch, -0.08);
    // Speed on the throttle: an acceleration asked for by the speed error, the lever moved until it comes.
    if (thrust) {
      const aCmd = clamp(0.35 * (vT - ias), -3, 3);
      st.thr = clamp(st.thr + 0.09 * (aCmd - st.acc) * dt, 0, 1);
    } else st.thr = Math.max(0, st.thr - 1.5 * dt);
    // The trim wheel takes over what the elevator holds, so the stick stays near the middle.
    out.pitch = unshape(pitch); out.roll = unshape(roll); out.yaw = 0; out.throttle = st.thr; out.brake = 0; out.trim = clamp(1.5 * pitch, -1, 1);
    out.gCmd = gCmd / DEG; out.phiCmd = phiCmd / DEG; out.vs = vs;
    return out;
  }
  // The take-off roll: power up, keep the runway's centreline (`off`: metres right of it)
  // and heading on the rudder and nose wheel, ease the nose up at vR to `nose` deg. Airborne, play.js goes over to fly() on a climb path.
  function takeoff(s, dt, { hdg, vR, nose = 9, off = 0 }) {
    const { q } = rates(s, dt);
    const r = st.psi === undefined ? 0 : wrap180(s[9] - st.psi) / Math.max(dt, 1e-3);
    st.psi = s[9];
    st.thr = Math.min(1, st.thr + 0.7 * dt);
    const fast = s[10] > 30;
    out.yaw = clamp((fast ? 0.05 : 0.09) * wrap180(hdg - clamp(0.4 * off, -8, 8) - s[9]) - (fast ? 0.02 : 0.03) * r, -0.6, 0.6);
    out.pitch = s[10] >= vR ? clamp(0.07 * (nose - s[8]) - 0.6 * q, -0.1, 0.65) : 0;
    out.roll = clamp(-0.03 * s[7], -0.3, 0.3);
    out.throttle = st.thr; out.brake = 0; out.trim = 0;
    return out;
  }
  // The landing roll: power off, brakes on below `brakeBelow` kt, steered back to the
  // runway's centreline (`off`: metres right of it) and along its heading.
  function rollout(s, dt, { hdg, off = 0, x = 0, brakeBelow = 90 }) {
    rates(s, dt);
    const r = st.psi === undefined ? 0 : wrap180(s[9] - st.psi) / Math.max(dt, 1e-3);
    st.psi = s[9];
    st.thr = Math.max(0, st.thr - 2 * dt);
    const want = hdg - clamp(0.4 * off, -8, 8) + 12 * x;
    const fast = s[12] > 30;
    out.yaw = clamp((fast ? 0.05 : 0.09) * wrap180(want - s[9]) - (fast ? 0.02 : 0.03) * r, -0.6, 0.6);
    out.pitch = 0; out.roll = clamp(-0.03 * s[7], -0.3, 0.3);
    out.throttle = st.thr; out.brake = s[12] < brakeBelow ? 0.7 : 0; out.trim = 0;
    return out;
  }
  return { reset, fly, takeoff, rollout, out, st, get throttle() { return st.thr; }, set throttle(v) { st.thr = clamp(v, 0, 1); } };
}
