// São Paulo World · flight test bed: the six-pack, drawn from the C++ instrument
// models' cockpit state (avd_cockpit). Ported from the Aviation Dynamics browser
// cockpit (github.com/ZRosserMcIntosh/Aviation-Dynamics, web/cockpit, MIT).
// Every needle shows what the simulated instrument indicates (lags, errors and
// failures included), never the aircraft's true state.

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const FONT = '"Big Shoulders Display","Arial Narrow",sans-serif';
const MONO = '"JetBrains Mono",ui-monospace,monospace';
const C = {
  face: '#121314', bezel: '#0b0c0d', mark: '#f0eee6', dim: '#9fa19c', needle: '#f4f2ea',
  green: '#33b35a', yellow: '#e8c437', red: '#e0402f', white: '#f2f2ee',
  sky: '#4e7fb4', earth: '#6d5435', amber: '#f0a830', flag: '#c8322b', accent: '#ffd36b', lcd: '#9fe3a8',
};

// Cockpit-state buffer layout (Aviation Dynamics web/README.md).
export const K = {
  ias: 0, alt: 1, kollsman: 2, vsi: 3, aiPitch: 4, aiRoll: 5, aiTumbled: 6, dg: 7, bug: 8, tcDefl: 9, tcRate: 10,
  tcFlag: 11, ball: 12, compass: 13, rpm: 14, oilP: 15, oilT: 16, egt: 17, ff: 18, fuelL: 19, fuelR: 20, amps: 21,
  volts: 22, suction: 23, ann: 24, stall: 25, oat: 26, clock: 27, flaps: 28, trim: 29,
  navValid: 37, cdi: 38, toFrom: 39, gsValid: 40, gs: 41, loc: 42,
  panelLights: 30, navAct: 32, navStb: 33, comAct: 34, comStb: 35, obs: 36, avPower: 43, squawk: 44, xpdrMode: 45, repAlt: 46,
  tTas: 48, tCas: 49, tGs: 50, tAlt: 51, tVs: 53, tPitch: 54, tRoll: 55, tHdg: 56, tMag: 57, tAgl: 67, tAlpha: 68,
};

export function markingsFrom(M) {
  return {
    white: [M[0], M[1]], green: [M[2], M[3]], yellow: [M[4], M[5]], vne: M[6], dialMin: M[7], dialMax: M[8],
    tachGreen: [M[9], M[10]], tachRed: M[11], tachMax: M[12], vsiRange: M[23], stdRateDefl: M[27],
  };
}

function dial(ctx, x, y, r) {
  ctx.fillStyle = C.bezel; ctx.beginPath(); ctx.arc(x, y, r * 1.08, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = C.face; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
}
function glass(ctx, x, y, r) {
  const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
  g.addColorStop(0, 'rgba(255,255,255,0.08)'); g.addColorStop(0.45, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.03)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
}
function needle(ctx, x, y, len, ang, w, tail = 0.18, color = C.needle) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(-w, len * tail); ctx.lineTo(-w * 0.55, -len); ctx.lineTo(0, -len - w * 1.6); ctx.lineTo(w * 0.55, -len); ctx.lineTo(w, len * tail); ctx.closePath(); ctx.fill();
  ctx.fillStyle = C.bezel; ctx.beginPath(); ctx.arc(0, 0, w * 1.5, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
}
function arcBand(ctx, x, y, r, a0, a1, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.arc(x, y, r, a0 - Math.PI / 2, a1 - Math.PI / 2); ctx.stroke();
}
function ticks(ctx, x, y, r, from, to, step, angle, len, width, label, every, fmt) {
  ctx.strokeStyle = C.mark; ctx.fillStyle = C.mark; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let i = 0;
  for (let v = from; v <= to + 1e-9; v += step, ++i) {
    const a = angle(v) - Math.PI / 2, major = every && i % every === 0;
    ctx.lineWidth = major ? width * 1.6 : width;
    const l = major ? len * 1.6 : len;
    ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.lineTo(x + Math.cos(a) * (r - l), y + Math.sin(a) * (r - l)); ctx.stroke();
    if (major && label) ctx.fillText(fmt ? fmt(v) : String(v), x + Math.cos(a) * (r - l - label), y + Math.sin(a) * (r - l - label));
  }
}
function flag(ctx, x, y, r, text) {
  ctx.fillStyle = C.flag; ctx.fillRect(x - r * 0.22, y - r * 0.1, r * 0.44, r * 0.2);
  ctx.fillStyle = '#fff'; ctx.font = `700 ${r * 0.15}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 1);
}

function asi(ctx, x, y, r, c, m) {
  dial(ctx, x, y, r);
  const a = (kt) => {
    const k = clamp(kt, 0, m.dialMax);
    return k <= m.dialMin ? (k / m.dialMin) * 22 * DEG : (22 + (k - m.dialMin) / (m.dialMax - m.dialMin) * 318) * DEG;
  };
  arcBand(ctx, x, y, r * 0.93, a(m.white[0]), a(m.white[1]), C.white, r * 0.05);
  arcBand(ctx, x, y, r * 0.86, a(m.green[0]), a(m.green[1]), C.green, r * 0.07);
  arcBand(ctx, x, y, r * 0.86, a(m.yellow[0]), a(m.yellow[1]), C.yellow, r * 0.07);
  ctx.strokeStyle = C.red; ctx.lineWidth = r * 0.035;
  const rv = a(m.vne) - Math.PI / 2;
  ctx.beginPath(); ctx.moveTo(x + Math.cos(rv) * r * 0.97, y + Math.sin(rv) * r * 0.97); ctx.lineTo(x + Math.cos(rv) * r * 0.76, y + Math.sin(rv) * r * 0.76); ctx.stroke();
  ctx.font = `600 ${r * 0.18}px ${FONT}`;
  ticks(ctx, x, y, r * 0.98, m.dialMin, m.dialMax, 10, a, r * 0.08, Math.max(1, r * 0.016), r * 0.16, 2);
  ctx.fillStyle = C.mark; ctx.font = `600 ${r * 0.13}px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillText('AIRSPEED', x, y - r * 0.3); ctx.fillText('KNOTS', x, y + r * 0.32);
  needle(ctx, x, y, r * 0.8, a(c[K.ias]), r * 0.05);
  glass(ctx, x, y, r);
}

function ai(ctx, x, y, r, c) {
  ctx.save();
  ctx.fillStyle = C.bezel; ctx.beginPath(); ctx.arc(x, y, r * 1.08, 0, 2 * Math.PI); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.clip();
  const pitch = c[K.aiPitch] * DEG, roll = c[K.aiRoll] * DEG, ppx = r * 0.032 / DEG;
  ctx.translate(x, y); ctx.rotate(-roll); ctx.translate(0, pitch * ppx);
  ctx.fillStyle = C.sky; ctx.fillRect(-3 * r, -6 * r, 6 * r, 6 * r);
  ctx.fillStyle = C.earth; ctx.fillRect(-3 * r, 0, 6 * r, 6 * r);
  ctx.strokeStyle = C.mark; ctx.lineWidth = Math.max(1.5, r * 0.025); ctx.beginPath(); ctx.moveTo(-3 * r, 0); ctx.lineTo(3 * r, 0); ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.016); ctx.font = `600 ${r * 0.13}px ${FONT}`; ctx.fillStyle = C.mark; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const p of [-20, -15, -10, -5, 5, 10, 15, 20]) {
    const yy = -p * DEG * ppx, l = p % 10 === 0 ? r * 0.28 : r * 0.14;
    ctx.beginPath(); ctx.moveTo(-l, yy); ctx.lineTo(l, yy); ctx.stroke();
    if (p % 10 === 0) ctx.fillText(String(Math.abs(p)), l + r * 0.05, yy);
  }
  ctx.restore();
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = C.mark; ctx.lineWidth = Math.max(1.5, r * 0.025);
  for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const a = (b - 90) * DEG, l = Math.abs(b) % 30 === 0 ? r * 0.16 : r * 0.09;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineTo(Math.cos(a) * (r - l), Math.sin(a) * (r - l)); ctx.stroke();
  }
  ctx.fillStyle = C.mark; ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(-r * 0.06, -r * 0.88); ctx.lineTo(r * 0.06, -r * 0.88); ctx.fill();
  ctx.rotate(-roll); ctx.fillStyle = C.amber;
  ctx.beginPath(); ctx.moveTo(0, -r * 0.84); ctx.lineTo(-r * 0.06, -r * 0.72); ctx.lineTo(r * 0.06, -r * 0.72); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = C.amber; ctx.lineWidth = r * 0.05; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - r * 0.5, y); ctx.lineTo(x - r * 0.16, y); ctx.lineTo(x - r * 0.08, y + r * 0.08); ctx.moveTo(x + r * 0.5, y); ctx.lineTo(x + r * 0.16, y); ctx.lineTo(x + r * 0.08, y + r * 0.08); ctx.stroke();
  ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(x, y, r * 0.035, 0, 2 * Math.PI); ctx.fill();
  ctx.lineCap = 'butt';
  if (c[K.aiTumbled]) flag(ctx, x, y + r * 0.55, r, 'GYRO');
  glass(ctx, x, y, r);
}

function alt(ctx, x, y, r, c) {
  dial(ctx, x, y, r);
  const h = c[K.alt];
  ctx.font = `600 ${r * 0.2}px ${FONT}`;
  ticks(ctx, x, y, r * 0.98, 0, 9.8, 0.2, (v) => (v / 10) * 2 * Math.PI, r * 0.08, Math.max(1, r * 0.016), r * 0.17, 5, (v) => String(Math.round(v)));
  ctx.fillStyle = '#000'; ctx.fillRect(x + r * 0.26, y - r * 0.1, r * 0.5, r * 0.2);
  ctx.fillStyle = C.mark; ctx.font = `${r * 0.15}px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(c[K.kollsman].toFixed(2), x + r * 0.51, y + 1);
  ctx.font = `600 ${r * 0.11}px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText('ALT · FEET', x, y - r * 0.32);
  const a = (v, per) => ((((v % per) + per) % per) / per) * 2 * Math.PI;
  needle(ctx, x, y, r * 0.86, a(h, 100000), r * 0.02, 0.05, C.mark);
  needle(ctx, x, y, r * 0.48, a(h, 10000), r * 0.065, 0.15);
  needle(ctx, x, y, r * 0.8, a(h, 1000), r * 0.045, 0.2);
  glass(ctx, x, y, r);
}

function vsi(ctx, x, y, r, c, m) {
  dial(ctx, x, y, r);
  const range = m.vsiRange;
  const a = (fpm) => -Math.PI / 2 + (clamp(fpm, -range * 1.08, range * 1.08) / range) * 170 * DEG;
  ctx.font = `600 ${r * 0.19}px ${FONT}`;
  ticks(ctx, x, y, r * 0.98, -range, range, 100, a, r * 0.08, Math.max(1, r * 0.015), r * 0.17, 5, (v) => String(Math.abs(v / 100) | 0));
  ctx.fillStyle = C.dim; ctx.font = `600 ${r * 0.11}px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillText('UP', x - r * 0.35, y - r * 0.25); ctx.fillText('DOWN', x - r * 0.35, y + r * 0.27);
  ctx.fillText('VERT SPEED', x + r * 0.22, y - r * 0.12); ctx.fillText('100 FT/MIN', x + r * 0.22, y + r * 0.12);
  needle(ctx, x, y, r * 0.8, a(c[K.vsi]), r * 0.05);
  glass(ctx, x, y, r);
}

function hi(ctx, x, y, r, c) {
  dial(ctx, x, y, r);
  ctx.save(); ctx.translate(x, y); ctx.rotate(-c[K.dg] * DEG);
  ctx.strokeStyle = C.mark; ctx.fillStyle = C.mark; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 5) {
    const a = (d - 90) * DEG, l = d % 10 === 0 ? r * 0.12 : r * 0.07;
    ctx.lineWidth = d % 30 === 0 ? Math.max(1.5, r * 0.025) : Math.max(1, r * 0.015);
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.96, Math.sin(a) * r * 0.96); ctx.lineTo(Math.cos(a) * (r * 0.96 - l), Math.sin(a) * (r * 0.96 - l)); ctx.stroke();
    if (d % 30 === 0) {
      ctx.save(); ctx.rotate(d * DEG); ctx.font = `600 ${r * 0.2}px ${FONT}`;
      ctx.fillText({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10), 0, -r * 0.66); ctx.restore();
    }
  }
  ctx.rotate(c[K.bug] * DEG); ctx.fillStyle = C.accent; ctx.fillRect(-r * 0.07, -r * 0.99, r * 0.14, r * 0.07);
  ctx.restore();
  ctx.fillStyle = C.amber; ctx.beginPath(); ctx.moveTo(x, y - r * 0.82); ctx.lineTo(x - r * 0.05, y - r * 0.97); ctx.lineTo(x + r * 0.05, y - r * 0.97); ctx.fill();
  ctx.strokeStyle = C.amber; ctx.lineWidth = r * 0.045; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, y - r * 0.3); ctx.lineTo(x, y + r * 0.3); ctx.moveTo(x - r * 0.28, y - r * 0.02); ctx.lineTo(x + r * 0.28, y - r * 0.02); ctx.moveTo(x - r * 0.12, y + r * 0.26); ctx.lineTo(x + r * 0.12, y + r * 0.26); ctx.stroke();
  ctx.lineCap = 'butt';
  glass(ctx, x, y, r);
}

function tc(ctx, x, y, r, c, m) {
  dial(ctx, x, y, r);
  ctx.fillStyle = C.mark; ctx.font = `600 ${r * 0.13}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('TURN COORDINATOR', x, y - r * 0.55); ctx.fillText('2 MIN', x, y + r * 0.75);
  ctx.fillText('L', x - r * 0.72, y + r * 0.42); ctx.fillText('R', x + r * 0.72, y + r * 0.42);
  ctx.strokeStyle = C.mark; ctx.lineWidth = Math.max(2, r * 0.035);
  for (const a of [0, m.stdRateDefl, -m.stdRateDefl]) for (const side of [-1, 1]) {
    const ang = a * DEG + (side < 0 ? Math.PI : 0);
    ctx.beginPath(); ctx.moveTo(x + Math.cos(ang) * r * 0.78, y + Math.sin(ang) * r * 0.78); ctx.lineTo(x + Math.cos(ang) * r * 0.94, y + Math.sin(ang) * r * 0.94); ctx.stroke();
  }
  ctx.save(); ctx.translate(x, y); ctx.rotate(c[K.tcDefl] * DEG);
  ctx.strokeStyle = C.mark; ctx.fillStyle = C.mark; ctx.lineWidth = r * 0.055; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-r * 0.7, 0); ctx.lineTo(r * 0.7, 0); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.1, 0, 2 * Math.PI); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-r * 0.18, -r * 0.2); ctx.lineTo(r * 0.18, -r * 0.2); ctx.moveTo(0, -r * 0.08); ctx.lineTo(0, -r * 0.28); ctx.stroke();
  ctx.restore(); ctx.lineCap = 'butt';
  const ty = y + r * 0.42, tr = r * 1.6, limit = 16;
  ctx.save();
  ctx.strokeStyle = '#d8d6cc'; ctx.lineWidth = r * 0.16; ctx.globalAlpha = 0.25;
  ctx.beginPath(); ctx.arc(x, ty - tr, tr, Math.PI / 2 - 0.2, Math.PI / 2 + 0.2); ctx.stroke();
  ctx.globalAlpha = 1;
  const ba = Math.PI / 2 - clamp(c[K.ball], -limit, limit) / limit * 0.18;
  ctx.fillStyle = '#0a0a0a'; ctx.strokeStyle = C.mark; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x + Math.cos(ba) * tr, ty - tr + Math.sin(ba) * tr, r * 0.065, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.018);
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + s * r * 0.085, ty - r * 0.09); ctx.lineTo(x + s * r * 0.085, ty + r * 0.09); ctx.stroke(); }
  ctx.restore();
  if (c[K.tcFlag]) flag(ctx, x - r * 0.48, y - r * 0.3, r, 'OFF');
  glass(ctx, x, y, r);
}

function tach(ctx, x, y, r, c, m) {
  dial(ctx, x, y, r);
  const a = (rpm) => (-130 + clamp(rpm, 0, m.tachMax) / m.tachMax * 260) * DEG;
  arcBand(ctx, x, y, r * 0.88, a(m.tachGreen[0]), a(m.tachGreen[1]), C.green, r * 0.11);
  ctx.strokeStyle = C.red; ctx.lineWidth = r * 0.05; const tr = a(m.tachRed) - Math.PI / 2;
  ctx.beginPath(); ctx.moveTo(x + Math.cos(tr) * r * 0.98, y + Math.sin(tr) * r * 0.98); ctx.lineTo(x + Math.cos(tr) * r * 0.72, y + Math.sin(tr) * r * 0.72); ctx.stroke();
  ctx.font = `600 ${r * 0.2}px ${FONT}`;
  ticks(ctx, x, y, r * 0.98, 0, m.tachMax, 500, a, r * 0.09, Math.max(1, r * 0.018), r * 0.17, 2, (v) => String(v / 100));
  ctx.fillStyle = C.dim; ctx.font = `600 ${r * 0.13}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('RPM × 100', x, y + r * 0.38);
  ctx.fillStyle = C.lcd; ctx.font = `${r * 0.2}px ${MONO}`; ctx.fillText(c[K.rpm].toFixed(0), x, y + r * 0.66);
  needle(ctx, x, y, r * 0.8, a(c[K.rpm]), r * 0.05);
  glass(ctx, x, y, r);
}

// Draws the panel into `ctx` (CSS pixels). Layout "row": seven dials in a line
// (ASI AI ALT TC HI VSI TACH); "grid": the classic 3 x 2 six-pack plus the tach.
export function drawPanel(ctx, w, h, c, m, layout) {
  ctx.clearRect(0, 0, w, h);
  if (layout === 'row') {
    const r = Math.min(h * 0.44, w / 15.4);
    const step = w / 7;
    const fns = [asi, ai, alt, tc, hi, vsi, tach];
    fns.forEach((f, i) => f(ctx, step * (i + 0.5), h / 2, r, c, m));
  } else {
    const r = Math.min(w / 7.2, h / 4.6);
    const cols = [w / 6, w / 2, (5 * w) / 6], rows = [r * 1.15, r * 3.45];
    asi(ctx, cols[0], rows[0], r, c, m); ai(ctx, cols[1], rows[0], r, c); alt(ctx, cols[2], rows[0], r, c);
    tc(ctx, cols[0], rows[1], r, c, m); hi(ctx, cols[1], rows[1], r, c); vsi(ctx, cols[2], rows[1], r, c, m);
  }
}

// ---------------------------------------------------------------------------
// The full panel face for the 3D cockpit, drawn into one texture. Panel space is
// metres: u from the pilot's-side edge (body y = +0.52) rightwards, v down from
// the glareshield (body z = 0.60); P is pixels per metre.
export const PANEL_W = 1.04, PANEL_H = 0.56;

// Clickable places on the 3D cockpit's panel face (metres from its top-left
// corner as the pilot sees it, the same coordinates the drawing uses): the
// switches, the key, the instrument knobs and the radios. Each names what
// it does; the app maps the kinds to the simulation.
const ROCKERS = [['BCN', 'electrical.load.beacon'], ['LAND', 'electrical.load.landing_light'], ['TAXI', 'electrical.load.taxi_light'],
  ['NAV', 'electrical.load.nav_lights'], ['STROBE', 'electrical.load.strobes'], ['PITOT HT', 'electrical.load.pitot_heat'], ['AVIONICS', 'electrical.avionics']];
export const PANEL_SPOTS = [
  { kind: 'toggle', id: 'electrical.battery', label: 'Master: battery', u: 0.085, v: 0.445, w: 0.016, h: 0.03 },
  { kind: 'toggle', id: 'electrical.alternator', label: 'Master: alternator', u: 0.103, v: 0.445, w: 0.016, h: 0.03 },
  ...ROCKERS.map(([label, id], i) => ({ kind: 'toggle', id, label, u: 0.135 + i * 0.03, v: 0.445, w: 0.016, h: 0.03 })),
  { kind: 'mags', id: 'engine1.ignition', label: 'Ignition key', u: 0.025, v: 0.45, w: 0.04, h: 0.04 },
  { kind: 'cage', label: 'Attitude indicator: click to cage (wings level)', u: 0.2, v: 0.075, w: 0.08, h: 0.08 },
  { kind: 'baro', label: 'Altimeter: scroll to set the pressure', u: 0.295, v: 0.075, w: 0.08, h: 0.08 },
  { kind: 'hdg', label: 'Heading indicator: scroll the bug, click to set it to the compass', u: 0.2, v: 0.175, w: 0.08, h: 0.08 },
  { kind: 'obs', label: 'Course (OBS): scroll to turn', u: 0.392, v: 0.077, w: 0.076, h: 0.076 },
  { kind: 'comSwap', label: 'COM: click to swap active and standby', u: 0.512, v: 0.083, w: 0.085, h: 0.022 },
  { kind: 'comTune', label: 'COM standby: scroll to tune, click to swap', u: 0.603, v: 0.083, w: 0.085, h: 0.022 },
  { kind: 'navSwap', label: 'NAV: click to swap active and standby', u: 0.512, v: 0.113, w: 0.085, h: 0.022 },
  { kind: 'navTune', label: 'NAV standby: scroll to tune, click to swap', u: 0.603, v: 0.113, w: 0.085, h: 0.022 },
  { kind: 'xpdr', label: 'Transponder: click for the mode, scroll the code', u: 0.512, v: 0.163, w: 0.13, h: 0.024 },
];

function cdi(ctx, x, y, r, c) {
  dial(ctx, x, y, r);
  ctx.save(); ctx.translate(x, y); ctx.rotate(-c[K.obs] * DEG);
  ctx.strokeStyle = C.mark; ctx.fillStyle = C.mark; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 5) {
    const a = (d - 90) * DEG, l = d % 10 === 0 ? r * 0.1 : r * 0.06;
    ctx.lineWidth = Math.max(1, r * 0.016);
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97); ctx.lineTo(Math.cos(a) * (r * 0.97 - l), Math.sin(a) * (r * 0.97 - l)); ctx.stroke();
    if (d % 30 === 0) { ctx.save(); ctx.rotate(d * DEG); ctx.font = `600 ${r * 0.16}px ${FONT}`; ctx.fillText({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10), 0, -r * 0.74); ctx.restore(); }
  }
  ctx.restore();
  ctx.fillStyle = C.amber;
  ctx.beginPath(); ctx.moveTo(x, y - r * 0.6); ctx.lineTo(x - r * 0.06, y - r * 0.5); ctx.lineTo(x + r * 0.06, y - r * 0.5); ctx.fill();
  ctx.fillStyle = C.mark;
  for (let i = -5; i <= 5; ++i) if (i) { ctx.beginPath(); ctx.arc(x + i * r * 0.1, y, r * 0.022, 0, 2 * Math.PI); ctx.fill(); }
  for (let i = -5; i <= 5; ++i) if (i) { ctx.beginPath(); ctx.arc(x + r * 0.62, y + i * r * 0.08, r * 0.018, 0, 2 * Math.PI); ctx.fill(); }
  ctx.strokeStyle = C.mark; ctx.lineWidth = r * 0.012; ctx.beginPath(); ctx.arc(x, y, r * 0.06, 0, 2 * Math.PI); ctx.stroke();
  const valid = c[K.navValid] > 0.5;
  if (valid) {
    const tf = c[K.toFrom];
    if (tf) { ctx.fillStyle = C.mark; ctx.beginPath(); const ty = y - r * 0.28 * tf; ctx.moveTo(x + r * 0.3, ty - r * 0.07 * tf); ctx.lineTo(x + r * 0.24, ty + r * 0.03 * tf); ctx.lineTo(x + r * 0.36, ty + r * 0.03 * tf); ctx.fill(); }
  }
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, r * 0.95, 0, 2 * Math.PI); ctx.clip();
  ctx.strokeStyle = C.white; ctx.lineWidth = r * 0.035;
  const dx = clamp(valid ? c[K.cdi] : 0, -1.2, 1.2) * r * 0.5;
  ctx.beginPath(); ctx.moveTo(x + dx, y - r * 0.55); ctx.lineTo(x + dx, y + r * 0.55); ctx.stroke();
  const gsOn = c[K.gsValid] > 0.5;
  const dy = gsOn ? -clamp(c[K.gs], -1.2, 1.2) * r * 0.4 : -r * 0.75;
  ctx.beginPath(); ctx.moveTo(x - r * 0.55, y + dy); ctx.lineTo(x + r * 0.55, y + dy); ctx.stroke();
  ctx.restore();
  if (!valid) flag(ctx, x - r * 0.42, y + r * 0.3, r, 'NAV');
  if (c[K.loc] > 0.5 && !gsOn) flag(ctx, x + r * 0.45, y - r * 0.1, r, 'GS');
  ctx.fillStyle = C.dim; ctx.font = `600 ${r * 0.11}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('VOR / LOC', x, y + r * 0.8);
  glass(ctx, x, y, r);
}

function smallDial(ctx, x, y, r, label, v, min, max, bands, fmtLabels) {
  dial(ctx, x, y, r);
  const a = (q) => (-120 + (clamp(q, min, max) - min) / (max - min) * 240) * DEG;
  for (const [b0, b1, col] of bands) arcBand(ctx, x, y, r * 0.84, a(b0), a(b1), col, r * 0.13);
  ctx.font = `600 ${r * 0.26}px ${FONT}`;
  for (const t of fmtLabels) {
    const ang = a(t) - Math.PI / 2; ctx.fillStyle = C.mark; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(t), x + Math.cos(ang) * r * 0.58, y + Math.sin(ang) * r * 0.58);
  }
  ctx.fillStyle = C.dim; ctx.font = `600 ${r * 0.2}px ${FONT}`; ctx.fillText(label, x, y + r * 0.62);
  needle(ctx, x, y, r * 0.8, Number.isFinite(v) ? a(v) : a(min), r * 0.07);
  glass(ctx, x, y, r);
}

// Edgewise engine gauge (a pair per housing, like the 172's engine cluster).
function bar(ctx, x, y, w, h, label, v, min, max, bands, ends) {
  ctx.fillStyle = '#0c0d0e'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#2b2d30'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
  const sx = x + w * 0.1, sw = w * 0.8, sy = y + h * 0.56;
  const at = (q) => sx + (clamp(q, min, max) - min) / (max - min) * sw;
  ctx.fillStyle = '#3a3c3f'; ctx.fillRect(sx, sy - h * 0.05, sw, h * 0.1);
  for (const [b0, b1, col] of bands) { ctx.fillStyle = col; ctx.fillRect(at(b0), sy - h * 0.07, at(b1) - at(b0), h * 0.14); }
  ctx.fillStyle = C.mark; ctx.font = `600 ${h * 0.22}px ${FONT}`; ctx.textBaseline = 'middle';
  ctx.textAlign = 'left'; ctx.fillText(ends[0], sx, y + h * 0.82); ctx.textAlign = 'right'; ctx.fillText(ends[1], sx + sw, y + h * 0.82);
  ctx.textAlign = 'center'; ctx.fillStyle = C.dim; ctx.fillText(label, x + w / 2, y + h * 0.2);
  if (Number.isFinite(v)) {
    const px = at(v); ctx.fillStyle = C.white;
    ctx.beginPath(); ctx.moveTo(px, sy + h * 0.02); ctx.lineTo(px - h * 0.08, sy - h * 0.2); ctx.lineTo(px + h * 0.08, sy - h * 0.2); ctx.fill();
  }
}

function clockFace(ctx, x, y, r, sec) {
  dial(ctx, x, y, r);
  ctx.font = `600 ${r * 0.24}px ${FONT}`;
  ticks(ctx, x, y, r * 0.97, 0, 59, 1, (v) => v / 60 * 2 * Math.PI, r * 0.06, Math.max(1, r * 0.02), r * 0.2, 5, (v) => String(v / 5 || 12));
  const t = ((sec % 43200) + 43200) % 43200;
  needle(ctx, x, y, r * 0.5, t / 43200 * 2 * Math.PI, r * 0.06, 0.1);
  needle(ctx, x, y, r * 0.78, (t % 3600) / 3600 * 2 * Math.PI, r * 0.045, 0.1);
  needle(ctx, x, y, r * 0.85, (t % 60) / 60 * 2 * Math.PI, r * 0.015, 0.2, C.red);
  glass(ctx, x, y, r);
}

function lcd(ctx, x, y, w, h, on, parts) {
  ctx.fillStyle = '#050607'; ctx.fillRect(x, y, w, h);
  if (!on) return;
  ctx.textBaseline = 'middle';
  for (const [text, fx, size, color, align] of parts) {
    ctx.fillStyle = color || '#ffbf5a'; ctx.font = `600 ${h * size}px ${MONO}`; ctx.textAlign = align || 'left';
    ctx.fillText(text, x + w * fx, y + h / 2);
  }
}

function screw(ctx, x, y, s) {
  ctx.fillStyle = '#4a4c50'; ctx.beginPath(); ctx.arc(x, y, s, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = '#1a1b1d'; ctx.lineWidth = s * 0.35; ctx.beginPath(); ctx.moveTo(x - s * 0.7, y - s * 0.3); ctx.lineTo(x + s * 0.7, y + s * 0.3); ctx.stroke();
}

let panelBase = null;
function drawBase(W, H, P) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#26272a'; g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 7; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  // Sub-panels: pilot's flight-instrument panel, the radio stack, copilot's side.
  const sub = (u0, v0, u1, v1, col) => {
    g.fillStyle = col; g.fillRect(u0 * P, v0 * P, (u1 - u0) * P, (v1 - v0) * P);
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 3; g.strokeRect(u0 * P, v0 * P, (u1 - u0) * P, (v1 - v0) * P);
    for (const [uu, vv] of [[u0 + 0.008, v0 + 0.008], [u1 - 0.008, v0 + 0.008], [u0 + 0.008, v1 - 0.008], [u1 - 0.008, v1 - 0.008]]) screw(g, uu * P, vv * P, 0.0028 * P);
  };
  sub(0.01, 0.02, 0.475, 0.42, '#1f2022');
  sub(0.49, 0.02, 0.71, 0.42, '#151617');
  sub(0.725, 0.02, 1.03, 0.42, '#232427');
  g.fillStyle = '#1b1c1e'; g.fillRect(0, 0.425 * P, W, H - 0.425 * P);
  // Circuit breakers along the bottom.
  g.font = `600 ${0.0075 * P}px ${FONT}`; g.textAlign = 'center'; g.fillStyle = '#9a9b97';
  const cbs = ['FLAP', 'INST', 'AVN BUS', 'TURN', 'NAV LT', 'LAND', 'TAXI', 'BCN', 'STROBE', 'PITOT', 'FUEL PMP', 'ALT FLD', 'ALT', 'BAT'];
  cbs.forEach((n, i) => {
    const u = 0.74 + i * 0.0205;
    g.fillStyle = '#0d0d0e'; g.beginPath(); g.arc(u * P, 0.51 * P, 0.0055 * P, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#d9d7cf'; g.beginPath(); g.arc(u * P, 0.51 * P, 0.0032 * P, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#9a9b97'; g.fillText(n, u * P, 0.53 * P);
  });
  // Placards.
  g.fillStyle = '#c9c6bb'; g.font = `600 ${0.0085 * P}px ${FONT}`; g.textAlign = 'left';
  const plac = ['THIS AIRPLANE MUST BE OPERATED AS A NORMAL OR UTILITY', 'CATEGORY AIRPLANE IN COMPLIANCE WITH THE OPERATING', 'LIMITATIONS IN THE PILOT\'S OPERATING HANDBOOK.', 'NO ACROBATIC MANEUVERS, INCLUDING SPINS, APPROVED.'];
  plac.forEach((t, i) => g.fillText(t, 0.75 * P, (0.05 + i * 0.012) * P));
  g.fillText('MANEUVERING SPEED 105 KIAS', 0.75 * P, 0.11 * P);
  g.fillText('172', 0.95 * P, 0.11 * P);
  // Glovebox.
  g.strokeStyle = '#121314'; g.lineWidth = 4; g.strokeRect(0.79 * P, 0.25 * P, 0.2 * P, 0.13 * P);
  g.fillStyle = '#18191b'; g.fillRect(0.865 * P, 0.265 * P, 0.05 * P, 0.012 * P);
  // Labels for the knobs and levers that are 3D.
  g.fillStyle = '#d9d7cf'; g.font = `700 ${0.009 * P}px ${FONT}`; g.textAlign = 'center';
  for (const [t, u] of [['CARB HEAT', 0.45], ['THROTTLE', 0.52], ['MIXTURE', 0.61]]) g.fillText(t, u * P, 0.535 * P);
  g.fillText('WING FLAPS', 0.665 * P, 0.31 * P);
  for (const [t, v] of [['0°', 0.33], ['10°', 0.355], ['20°', 0.38], ['FULL', 0.405]]) { g.textAlign = 'right'; g.fillText(t, 0.65 * P, v * P); }
  g.textAlign = 'center';
  // Magneto switch ring.
  const mx = 0.045 * P, my = 0.47 * P;
  g.fillStyle = '#101112'; g.beginPath(); g.arc(mx, my, 0.02 * P, 0, 2 * Math.PI); g.fill();
  g.fillStyle = '#d9d7cf'; g.font = `700 ${0.0075 * P}px ${FONT}`;
  [['OFF', -60], ['R', -30], ['L', 0], ['BOTH', 30], ['START', 60]].forEach(([t, a]) => {
    const r = 0.028 * P, ang = (a - 90) * DEG; g.fillText(t, mx + Math.cos(ang) * r, my + Math.sin(ang) * r);
  });
  return cv;
}

// sw: switch positions read from the cockpit registry; s: avd_state.
export function drawCockpitPanel(ctx, W, H, c, m, sw, s) {
  const P = W / PANEL_W;
  if (!panelBase || panelBase.width !== W) panelBase = drawBase(W, H, P);
  ctx.drawImage(panelBase, 0, 0);
  const R = 0.04 * P, X = (u) => u * P;
  // Annunciators above the six-pack.
  const ann = c[K.ann] | 0, cells = [['OIL PRESS', 1, C.red], ['LOW VAC', 2, C.amber], ['VOLTS', 4, C.red], ['L FUEL', 8, C.amber], ['R FUEL', 16, C.amber]];
  cells.forEach(([t, bit, col], i) => {
    const x = X(0.1 + i * 0.058), y = X(0.03), w = X(0.054), h = X(0.016), on = (ann & bit) && sw.bat;
    ctx.fillStyle = on ? col : '#151515'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = on ? '#fff' : '#454545'; ctx.font = `700 ${h * 0.6}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x + w / 2, y + h / 2 + 1);
  });
  // Six-pack, centred in front of the pilot, plus CDI, clock, suction and tach.
  asi(ctx, X(0.145), X(0.115), R, c, m); ai(ctx, X(0.24), X(0.115), R, c); alt(ctx, X(0.335), X(0.115), R, c);
  tc(ctx, X(0.145), X(0.215), R, c, m); hi(ctx, X(0.24), X(0.215), R, c); vsi(ctx, X(0.335), X(0.215), R, c, m);
  cdi(ctx, X(0.43), X(0.115), R * 0.95, c);
  clockFace(ctx, X(0.05), X(0.1), R * 0.62, c[K.clock]);
  smallDial(ctx, X(0.05), X(0.2), R * 0.62, 'SUCTION', c[K.suction], 0, 10, [[4.5, 5.5, C.green]], [0, 5, 10]);
  tach(ctx, X(0.43), X(0.215), R * 0.95, c, m);
  // Engine cluster below the six-pack.
  const bw = X(0.085), bh = X(0.03), bp = (i) => [X(i < 4 ? 0.012 : 0.388), X(0.27 + (i % 4) * 0.036)];
  bar(ctx, ...bp(0), bw, bh, 'FUEL L  GAL', c[K.fuelL], 0, 26, [[0, 1.5, C.red]], ['E', 'F']);
  bar(ctx, ...bp(1), bw, bh, 'FUEL R  GAL', c[K.fuelR], 0, 26, [[0, 1.5, C.red]], ['E', 'F']);
  bar(ctx, ...bp(2), bw, bh, 'FUEL FLOW GPH', c[K.ff], 0, 19, [[4.5, 11.5, C.green]], ['0', '19']);
  bar(ctx, ...bp(3), bw, bh, 'EGT', c[K.egt], 1000, 1700, [], ['', '']);
  bar(ctx, ...bp(4), bw, bh, 'OIL TEMP', c[K.oilT], 75, 250, [[100, 245, C.green]], ['', '']);
  bar(ctx, ...bp(5), bw, bh, 'OIL PRESS', c[K.oilP], 0, 115, [[0, 20, C.red], [50, 90, C.green], [100, 115, C.red]], ['', '']);
  bar(ctx, ...bp(6), bw, bh, 'AMPS', c[K.amps], -60, 60, [], ['−', '+']);
  bar(ctx, ...bp(7), bw, bh, 'VOLTS', c[K.volts], 8, 32, [[24, 30, C.green]], ['', '']);
  // Radio stack: audio panel, NAV/COM, transponder, hobbs.
  const av = c[K.avPower] > 0.5 && sw.avionics && sw.bat;
  const rx = X(0.5), rw = X(0.2);
  ctx.fillStyle = '#0e0f10'; ctx.fillRect(rx, X(0.035), rw, X(0.03));
  ctx.fillStyle = '#3c3e41';
  for (let i = 0; i < 9; ++i) { ctx.fillRect(rx + X(0.01 + i * 0.021), X(0.042), X(0.015), X(0.009)); }
  ctx.fillStyle = av ? '#7cd67c' : '#2a2a2a'; for (const i of [0, 4]) { ctx.beginPath(); ctx.arc(rx + X(0.0175 + i * 0.021), X(0.057), X(0.0015), 0, 7); ctx.fill(); }
  ctx.fillStyle = '#0e0f10'; ctx.fillRect(rx, X(0.075), rw, X(0.07));
  const f = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '---');
  lcd(ctx, rx + X(0.012), X(0.083), X(0.085), X(0.022), av, [[f(c[K.comAct], 3), 0.06, 0.7], ['COM', 0.75, 0.32, '#c98a3a']]);
  lcd(ctx, rx + X(0.103), X(0.083), X(0.085), X(0.022), av, [[f(c[K.comStb], 3), 0.06, 0.7], ['STBY', 0.73, 0.32, '#c98a3a']]);
  lcd(ctx, rx + X(0.012), X(0.113), X(0.085), X(0.022), av, [[f(c[K.navAct], 2), 0.1, 0.7], ['NAV', 0.75, 0.32, '#c98a3a']]);
  lcd(ctx, rx + X(0.103), X(0.113), X(0.085), X(0.022), av, [[f(c[K.navStb], 2), 0.1, 0.7], ['STBY', 0.73, 0.32, '#c98a3a']]);
  ctx.fillStyle = '#3c3e41'; for (const u of [0.01, 0.185]) { ctx.beginPath(); ctx.arc(rx + X(u) + X(0.004), X(0.14), X(0.004), 0, 7); ctx.fill(); }
  ctx.fillStyle = '#0e0f10'; ctx.fillRect(rx, X(0.155), rw, X(0.04));
  const modes = ['OFF', 'SBY', 'ON', 'ALT'];
  lcd(ctx, rx + X(0.012), X(0.163), X(0.13), X(0.024), av && c[K.xpdrMode] > 0, [[String(c[K.squawk] | 0).padStart(4, '0'), 0.05, 0.75], [modes[c[K.xpdrMode] | 0] || '', 0.55, 0.42], [c[K.xpdrMode] >= 3 ? `FL${String(Math.round(c[K.repAlt] / 100)).padStart(3, '0')}` : '', 0.78, 0.36]]);
  ctx.fillStyle = '#d9d7cf'; ctx.font = `700 ${X(0.007)}px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillText('AUDIO', rx + rw / 2, X(0.072)); ctx.fillText('NAV / COM 1', rx + rw / 2, X(0.152)); ctx.fillText('TRANSPONDER', rx + rw / 2, X(0.202));
  ctx.fillStyle = '#0e0f10'; ctx.fillRect(rx + X(0.05), X(0.215), X(0.1), X(0.024));
  ctx.fillStyle = '#e8e6de'; ctx.font = `600 ${X(0.014)}px ${MONO}`;
  ctx.fillText(((s[42] || 0) / 3600 + 1287.4).toFixed(1).padStart(6, '0'), rx + X(0.1), X(0.228));
  ctx.fillStyle = '#9a9b97'; ctx.font = `700 ${X(0.007)}px ${FONT}`; ctx.fillText('HOURS', rx + X(0.1), X(0.248));
  // Switch row: split master, then the light and avionics rockers.
  const rocker = (u, label, on, red) => {
    const x = X(u), y = X(0.445), w = X(0.016), h = X(0.03);
    ctx.fillStyle = '#0a0a0b'; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = red ? '#b5332a' : '#e5e3db'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(x, on ? y + h / 2 : y, w, h / 2);
    ctx.fillStyle = '#d9d7cf'; ctx.font = `700 ${X(0.0072)}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(label, x + w / 2, y + h + X(0.011));
  };
  rocker(0.085, 'BAT', sw.bat, true); rocker(0.103, 'ALT', sw.alt, true);
  [['BCN', sw.beacon], ['LAND', sw.land], ['TAXI', sw.taxi], ['NAV', sw.nav], ['STROBE', sw.strobe], ['PITOT HT', sw.pitot], ['AVIONICS', sw.avionics]].forEach(([t, on], i) => rocker(0.135 + i * 0.03, t, on));
  ctx.fillStyle = '#d9d7cf'; ctx.font = `700 ${X(0.0072)}px ${FONT}`; ctx.fillText('MASTER', X(0.102), X(0.437));
  // Magneto key.
  const ka = [-60, -30, 0, 30][sw.mags | 0] * DEG;
  ctx.save(); ctx.translate(X(0.045), X(0.47)); ctx.rotate(ka);
  ctx.fillStyle = '#b9b7ae'; ctx.beginPath(); ctx.arc(0, 0, X(0.012), 0, 7); ctx.fill();
  ctx.fillStyle = '#2a2b2d'; ctx.fillRect(-X(0.0035), -X(0.016), X(0.007), X(0.032));
  ctx.restore();
  // Flap position indicator beside the lever.
  const fv = 0.33 + clamp(c[K.flaps] / 30, 0, 1) * 0.075;
  ctx.fillStyle = '#e5e3db'; ctx.beginPath(); ctx.moveTo(X(0.655), X(fv)); ctx.lineTo(X(0.665), X(fv) - X(0.004)); ctx.lineTo(X(0.665), X(fv) + X(0.004)); ctx.fill();
}

// Whiskey compass card for the 3D cockpit: a horizontal strip around the reading.
export function drawCompassCard(ctx, w, h, hdg) {
  ctx.fillStyle = '#0b0b0b'; ctx.fillRect(0, 0, w, h);
  const pxd = w / 40;
  ctx.fillStyle = '#e9e5d6'; ctx.strokeStyle = '#e9e5d6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let d = Math.floor(hdg / 5) * 5 - 25; d <= hdg + 25; d += 5) {
    const x = w / 2 + (d - hdg) * pxd, dd = ((d % 360) + 360) % 360;
    ctx.lineWidth = dd % 10 === 0 ? 3 : 2;
    ctx.beginPath(); ctx.moveTo(x, h * 0.62); ctx.lineTo(x, h * (dd % 10 === 0 ? 0.88 : 0.8)); ctx.stroke();
    if (dd % 30 === 0) { ctx.font = `700 ${h * 0.42}px ${FONT}`; ctx.fillText({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[dd] ?? String(dd / 10), x, h * 0.32); }
  }
  ctx.strokeStyle = '#ff6a3a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
}
