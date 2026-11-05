// São Paulo World · flight test bed: a G1000-style glass cockpit for the 172
// (the Tupi T-180, a 172S analogue), as the 172S NAV III has it: the PFD
// (attitude, speed and altitude tapes, VSI, HSI) and the MFD (moving map and
// the engine indication system of a piston single). Every reading comes from
// the simulation (app.js, g1000Data): the attitude, heading, airspeed and
// altitude from the instrument models, the engine and fuel from the engine's
// sensors, the course and deviation from NAV 1 or the GPS. The attitude, roll
// scale, altitude drum and map features are the jets' (glass.js).
// Each display is drawn in a 1024 x 768 screen of its own, scaled to fit.
import { attitudeScene, rollScale, altDigits, mapFeatures } from './glass.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SANS = '"Public Sans",system-ui,sans-serif';
const MONO = '"JetBrains Mono",ui-monospace,monospace';
const VW = 1024, VH = 768;
const G = {
  white: '#f4f6f8', grey: '#9aa3ae', dim: '#59616b', black: '#000', cyan: '#2ce6f2', magenta: '#ff4cf0', green: '#3cf05a',
  yellow: '#ffe23a', amber: '#ffb52e', red: '#ff3a30', tape: 'rgba(28,32,40,.62)', bar: '#050608', line: '#3a414b',
};
// The G1000's reference speeds (TMR/REF): the 172S defaults, set by the pilot
// on the real airplane, not computed (the core has no V-speeds for the 172).
const REF = [['R', 55], ['X', 62], ['Y', 74], ['G', 68]];
// Map ranges (NM) the range knob steps through.
const RANGES = [1, 2, 3, 5, 7.5, 10, 15, 20, 35, 50];
const XPDR = ['OFF', 'STBY', 'ON', 'ALT'];
const deg3 = (v) => String(Math.round(((v % 360) + 360) % 360) || 360).padStart(3, '0');

// Pilot settings on the displays (CDI source, map range and declutter, the
// reference speed bugs), and the last layout for the pointer.
export const g1000 = { cdi: 'auto', range: 3, dcltr: 0, refs: true, screens: [] };

function t(ctx, s, x, y, size, color = G.white, align = 'left', weight = 600, font = SANS) {
  ctx.font = `${weight} ${size}px ${font}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}
function rect(ctx, x, y, w, h, fill, stroke, lw = 2) {
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.strokeRect(x, y, w, h); }
}
// Label then value, left to right from x.
function pair(ctx, x, y, size, label, value, color, gap = 6) {
  ctx.font = `600 ${size * 0.8}px ${SANS}`;
  const lw = ctx.measureText(label).width;
  t(ctx, label, x, y, size * 0.8, G.white);
  t(ctx, value, x + lw + gap, y, size, color);
}

// ------------------------------------------------------------- sources ----
// The CDI source: the pilot's choice (CDI softkey), or automatic: the
// localizer once NAV 1 has one, else the GPS with a route, else VOR 1.
function cdi(d) {
  const gpsOk = !!(d.gps && d.gps[0] && d.route), loc = d.nav.valid && d.nav.loc;
  const src = g1000.cdi === 'gps' ? 'GPS' : g1000.cdi === 'nav' ? (loc ? 'LOC1' : 'VOR1') : loc ? 'LOC1' : gpsOk ? 'GPS' : 'VOR1';
  if (src === 'GPS') {
    const g = d.gps;
    const phase = !gpsOk ? '' : g[2] === 2 ? (g[10] ? 'LPV' : 'LNAV') : ['ENR', 'TERM'][g[2]] || 'ENR';
    return { src, color: G.magenta, valid: gpsOk, crs: gpsOk ? g[3] - g[13] : null, dev: gpsOk ? g[6] : 0, toFrom: 1, phase,
      vert: gpsOk && g[10] ? g[12] : null };
  }
  return { src, color: G.green, valid: d.nav.valid, crs: d.nav.obs, dev: d.nav.cdi, toFrom: d.nav.toFrom, phase: '',
    vert: loc && d.nav.gsValid ? d.nav.gs : null };
}

// Annunciations (the 172S's): [text, 3 warning red | 2 caution yellow].
function annunciations(d) {
  const a = d.eng.ann | 0, m = [];
  if (a & 1) m.push(['OIL PRESSURE', 3]);
  if (a & 4) m.push(['LOW VOLTS', 3]);
  if (a & 2) m.push(['LOW VACUUM', 2]);
  if (a & 8) m.push(['LOW FUEL L', 2]);
  if (a & 16) m.push(['LOW FUEL R', 2]);
  return m;
}

// ------------------------------------------------------------- top bar ----
function radios(ctx, d, src) {
  rect(ctx, 0, 0, VW, 34, G.bar);
  ctx.strokeStyle = G.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 34); ctx.lineTo(VW, 34); ctx.stroke();
  const f = (v, n) => (d.av && Number.isFinite(v) ? v.toFixed(n) : '---.--');
  const navCol = src.startsWith('GPS') ? G.white : G.green;
  t(ctx, 'NAV1', 8, 17, 15, G.white);
  t(ctx, f(d.nav.mhz, 2), 54, 17, 21, d.av ? navCol : G.dim, 'left', 600, MONO);
  t(ctx, '↔', 136, 17, 18, G.white);
  ctx.strokeStyle = G.cyan; ctx.lineWidth = 2; ctx.strokeRect(160, 5, 92, 24);
  t(ctx, f(d.nav.stby, 2), 166, 17, 21, d.av ? G.white : G.dim, 'left', 600, MONO);
  t(ctx, f(d.com[0], 3), VW - 268, 17, 21, d.av ? G.green : G.dim, 'left', 600, MONO);
  t(ctx, '↔', VW - 172, 17, 18, G.white);
  ctx.strokeStyle = G.cyan; ctx.strokeRect(VW - 146, 5, 98, 24);
  t(ctx, f(d.com[1], 3), VW - 142, 17, 21, d.av ? G.white : G.dim, 'left', 600, MONO);
  t(ctx, 'COM1', VW - 6, 17, 15, G.white, 'right');
}

// The PFD's navigation status: the active GPS leg, its distance and track.
function navStatus(ctx, d) {
  const g = d.gps, r = d.route;
  if (!g || !g[0] || !r || !r.wp[g[1]]) return;
  const to = r.wp[g[1]].ident, from = r.wp[g[1] - 1]?.ident || '';
  ctx.font = `600 19px ${SANS}`;
  const parts = [[from ? `${from} ` : '', G.magenta], ['▸ ', G.magenta], [to, G.magenta], ['   DIS ', G.white], [`${(g[7] / 1852).toFixed(1)}NM`, G.magenta],
    ['   DTK ', G.white], [`${deg3(g[3] - g[13])}°`, G.magenta]];
  const widths = parts.map(([s]) => ctx.measureText(s).width);
  let x = 514 - widths.reduce((a, b) => a + b, 0) / 2;
  parts.forEach(([s, col], i) => { t(ctx, s, x, 17, 19, col); x += widths[i]; });
}

// --------------------------------------------------------------- PFD ----
function speedTape(ctx, d) {
  const x0 = 162, w = 88, y0 = 104, h = 392, cy = 300, ppk = 6;
  const m = d.m, v = Math.max(d.ias, 20), ys = (k) => cy - (k - v) * ppk;
  rect(ctx, x0, y0, w, h, G.tape);
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w + 24, h); ctx.clip();
  // Colour bands at the edge: red below the white arc, the white arc (flaps),
  // green, yellow, and red above the never-exceed speed.
  const band = (a, b, col, x, bw) => { const ya = ys(a), yb = ys(b); ctx.fillStyle = col; ctx.fillRect(x, Math.min(ya, yb), bw, Math.abs(ya - yb)); };
  const bx = x0 + w - 9;
  band(20, m.white[0], G.red, bx, 9);
  band(m.white[0], m.white[1], G.white, bx - 7, 5);
  band(m.green[0], m.green[1], G.green, bx, 9);
  band(m.yellow[0], m.yellow[1], G.yellow, bx, 9);
  for (let k = m.vne; k < v + 40; k += 4) band(k, k + 2, G.red, bx, 9), band(k + 2, k + 4, G.white, bx, 9);
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (let k = Math.max(20, Math.floor((v - 40) / 5) * 5); k <= v + 40; k += 5) {
    const yy = ys(k), major = k % 10 === 0;
    ctx.beginPath(); ctx.moveTo(x0 + w - 9, yy); ctx.lineTo(x0 + w - 9 - (major ? 16 : 9), yy); ctx.stroke();
    if (major) t(ctx, String(k), x0 + w - 30, yy, 23, G.white, 'right', 600, MONO);
  }
  // Trend: where the speed will be in 6 seconds.
  if (Math.abs(d.trend) > 1 && d.ias > 20) {
    ctx.fillStyle = G.magenta; const yt = clamp(ys(v + d.trend), y0, y0 + h);
    ctx.fillRect(x0 + w - 4, Math.min(cy, yt), 4, Math.abs(cy - yt));
  }
  ctx.restore();
  // Reference speeds (TMR/REF).
  if (g1000.refs) {
    for (const [l, k] of REF) {
      const yy = ys(k); if (yy < y0 + 10 || yy > y0 + h - 10) continue;
      rect(ctx, x0 + w + 1, yy - 10, 20, 20, G.black, G.cyan, 1.5);
      t(ctx, l, x0 + w + 11, yy + 1, 16, G.cyan, 'center', 700);
    }
  }
  // The pointer window, the last digit rolling.
  const col = d.ias > m.vne ? G.red : d.ias > m.yellow[0] ? G.yellow : G.white;
  ctx.fillStyle = G.black; ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0 + 2, cy - 24); ctx.lineTo(x0 + w - 16, cy - 24); ctx.lineTo(x0 + w - 16, cy - 12); ctx.lineTo(x0 + w - 2, cy);
  ctx.lineTo(x0 + w - 16, cy + 12); ctx.lineTo(x0 + w - 16, cy + 24); ctx.lineTo(x0 + 2, cy + 24); ctx.closePath(); ctx.fill(); ctx.stroke();
  if (d.ias < 20) t(ctx, '---', x0 + w - 20, cy, 30, G.white, 'right', 700, MONO);
  else {
    const tens = Math.floor(d.ias / 10), ones = d.ias - tens * 10, dx = x0 + w - 40;
    t(ctx, String(tens), dx, cy + 1, 31, col, 'right', 700, MONO);
    ctx.save(); ctx.beginPath(); ctx.rect(dx, cy - 22, 22, 44); ctx.clip();
    const base = Math.floor(ones), frac = ones - base;
    for (let k = -1; k <= 2; ++k) t(ctx, String((base + k + 10) % 10), dx + 11, cy + 1 - (k - frac) * 30, 31, col, 'center', 700, MONO);
    ctx.restore();
  }
  rect(ctx, x0, y0 + h, w, 28, G.black, G.line, 1);
  pair(ctx, x0 + 6, y0 + h + 14, 19, 'TAS', `${Math.round(Math.max(0, d.tas))}KT`, G.white, 4);
}

function altTape(ctx, d) {
  const x0 = 662, w = 98, y0 = 104, h = 392, cy = 300, ppf = h / 2 / 300;
  const ys = (a) => cy - (a - d.alt) * ppf;
  rect(ctx, x0, y0, w, h, G.tape);
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (let k = Math.floor((d.alt - 320) / 20) * 20; k <= d.alt + 320; k += 20) {
    const yy = ys(k), major = k % 100 === 0;
    ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + (major ? 16 : 8), yy); ctx.stroke();
    if (major) {
      const hi = Math.trunc(k / 100), lo = '00';
      ctx.font = `600 23px ${MONO}`; const wh = ctx.measureText(String(hi)).width;
      t(ctx, String(hi), x0 + 22, yy, 23, G.white, 'left', 600, MONO);
      t(ctx, lo, x0 + 22 + wh, yy + 1, 17, G.white, 'left', 600, MONO);
    }
  }
  // Trend (6 s) on the left edge, and the selected-altitude bug.
  const trend = d.vsi * 0.1;
  if (Math.abs(trend) > 10) { ctx.fillStyle = G.magenta; const yt = clamp(ys(d.alt + trend), y0, y0 + h); ctx.fillRect(x0, Math.min(cy, yt), 4, Math.abs(cy - yt)); }
  if (d.selAlt > 0) {
    const yb = clamp(ys(d.selAlt), y0 + 8, y0 + h - 8);
    ctx.fillStyle = G.cyan;
    ctx.beginPath(); ctx.moveTo(x0, yb - 14); ctx.lineTo(x0 + 10, yb - 14); ctx.lineTo(x0 + 10, yb - 6); ctx.lineTo(x0 + 4, yb); ctx.lineTo(x0 + 10, yb + 6);
    ctx.lineTo(x0 + 10, yb + 14); ctx.lineTo(x0, yb + 14); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // Pointer window with the rolling 20-foot drum.
  const wx = x0 + 6, wy = cy - 24, ww = w - 6, wh = 48;
  ctx.fillStyle = G.black; ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(wx, wy); ctx.lineTo(wx + ww, wy); ctx.lineTo(wx + ww, wy + wh); ctx.lineTo(wx, wy + wh); ctx.lineTo(wx, cy + 10); ctx.lineTo(wx - 12, cy);
  ctx.lineTo(wx, cy - 10); ctx.closePath(); ctx.fill(); ctx.stroke();
  altDigits(ctx, wx, wy, ww, wh, cy, d.alt, wh / 7.2);
  // Selected altitude above, the barometric setting below.
  rect(ctx, x0, 66, w, 32, G.black, G.line, 1);
  if (d.selAlt > 0) {
    ctx.fillStyle = G.cyan; ctx.fillRect(x0 + 6, 72, 6, 20);
    t(ctx, String(Math.round(d.selAlt)), x0 + w - 26, 83, 23, G.cyan, 'right', 600, MONO); t(ctx, 'FT', x0 + w - 4, 85, 13, G.cyan, 'right');
  } else t(ctx, '----', x0 + w - 26, 83, 23, G.cyan, 'right', 600, MONO);
  rect(ctx, x0, y0 + h, w, 28, G.black, G.line, 1);
  t(ctx, d.baro.toFixed(2), x0 + w - 26, y0 + h + 14, 21, G.cyan, 'right', 600, MONO);
  t(ctx, 'IN', x0 + w - 4, y0 + h + 16, 13, G.cyan, 'right');
}

function vsiTape(ctx, d) {
  const x0 = 762, w = 62, cy = 300, half = 180, k = half / 2000;
  ctx.fillStyle = G.tape;
  ctx.beginPath(); ctx.moveTo(x0, cy - half - 10); ctx.lineTo(x0 + w * 0.55, cy - half - 10); ctx.lineTo(x0 + w * 0.55, cy + half + 10); ctx.lineTo(x0, cy + half + 10); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (let f = -2000; f <= 2000; f += 500) {
    const yy = cy - f * k, major = f % 1000 === 0;
    ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + (major ? 14 : 8), yy); ctx.stroke();
    if (major && f) t(ctx, String(Math.abs(f / 1000)), x0 + 18, yy, 17, G.white, 'left', 600, MONO);
  }
  const yp = cy - clamp(d.vsi, -2050, 2050) * k;
  ctx.fillStyle = G.black; ctx.strokeStyle = G.white;
  const big = Math.abs(d.vsi) >= 100, pw = big ? w + 6 : 34;
  ctx.beginPath(); ctx.moveTo(x0 + 2, yp); ctx.lineTo(x0 + 14, yp - 12); ctx.lineTo(x0 + pw, yp - 12); ctx.lineTo(x0 + pw, yp + 12); ctx.lineTo(x0 + 14, yp + 12); ctx.closePath(); ctx.fill(); ctx.stroke();
  if (big) t(ctx, String(Math.round(d.vsi / 50) * 50), x0 + w + 2, yp + 1, 17, G.white, 'right', 600, MONO);
}

// Vertical deviation: the glideslope (green) or the GPS glidepath (magenta).
function vdi(ctx, src) {
  if (src.vert === null) return;
  const x = 640, cy = 300, dot = 38;
  rect(ctx, x - 13, cy - 2.4 * dot, 26, 4.8 * dot, 'rgba(0,0,0,.45)');
  t(ctx, 'G', x, cy - 2.4 * dot - 12, 17, src.color, 'center', 700);
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (const k of [-2, -1, 1, 2]) { ctx.beginPath(); ctx.arc(x, cy + k * dot, 5, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(x - 11, cy); ctx.lineTo(x + 11, cy); ctx.stroke();
  const y = cy - clamp(src.vert, -1.15, 1.15) * 2 * dot;
  ctx.fillStyle = src.color; ctx.beginPath(); ctx.moveTo(x, y - 11); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 11); ctx.lineTo(x - 9, y); ctx.closePath(); ctx.fill();
}

function hsi(ctx, d, src) {
  const cx = 456, cy = 632, R = 108, hdg = d.hdg;
  // Heading and course boxes.
  rect(ctx, 304, 492, 96, 28, G.black, G.line, 1);
  pair(ctx, 310, 506, 20, 'HDG', `${deg3(d.bug)}°`, G.cyan);
  rect(ctx, 512, 492, 100, 28, G.black, G.line, 1);
  pair(ctx, 518, 506, 20, 'CRS', src.crs === null ? '---°' : `${deg3(src.crs)}°`, src.color);
  ctx.save(); ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(30,34,40,.88)'; ctx.beginPath(); ctx.arc(0, 0, R, 0, 2 * Math.PI); ctx.fill();
  // Fixed marks every 45°, the rate-of-turn scale over the lubber line.
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (const a of [45, 90, 135, 225, 270, 315]) { ctx.save(); ctx.rotate(a * DEG); ctx.beginPath(); ctx.moveTo(0, -R - 3); ctx.lineTo(0, -R - 12); ctx.stroke(); ctx.restore(); }
  const rr = R + 7, rot = clamp(d.turnRate * 6, -24, 24);
  ctx.strokeStyle = G.white; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, rr, (-90 - 22) * DEG, (-90 + 22) * DEG); ctx.stroke();
  for (const a of [-18, -9, 9, 18]) { ctx.save(); ctx.rotate(a * DEG); ctx.beginPath(); ctx.moveTo(0, -rr); ctx.lineTo(0, -rr - (Math.abs(a) === 18 ? 8 : 5)); ctx.stroke(); ctx.restore(); }
  if (Math.abs(rot) > 0.5) {
    ctx.strokeStyle = G.magenta; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, rr + 3, -90 * DEG, (-90 + rot) * DEG, rot < 0); ctx.stroke();
  }
  // The rose, heading up.
  ctx.save(); ctx.rotate(-hdg * DEG);
  for (let k = 0; k < 360; k += 5) {
    ctx.save(); ctx.rotate(k * DEG);
    ctx.lineWidth = 2; ctx.strokeStyle = G.white;
    ctx.beginPath(); ctx.moveTo(0, -R); ctx.lineTo(0, -R + (k % 10 ? 8 : 15)); ctx.stroke();
    if (k % 30 === 0) t(ctx, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[k] ?? String(k / 10), 0, -R + 30, k % 90 ? 18 : 21, G.white, 'center', 700);
    ctx.restore();
  }
  // Heading bug, current track.
  ctx.save(); ctx.rotate(d.bug * DEG); ctx.fillStyle = G.cyan;
  ctx.beginPath(); ctx.moveTo(-10, -R - 1); ctx.lineTo(-10, -R + 8); ctx.lineTo(-4, -R + 8); ctx.lineTo(0, -R + 2); ctx.lineTo(4, -R + 8); ctx.lineTo(10, -R + 8); ctx.lineTo(10, -R - 1); ctx.closePath(); ctx.fill();
  ctx.restore();
  if (!d.wow && d.gs > 30) {
    ctx.save(); ctx.rotate((d.track - d.magVar) * DEG); ctx.fillStyle = G.magenta;
    ctx.beginPath(); ctx.moveTo(0, -R + 2); ctx.lineTo(6, -R + 10); ctx.lineTo(0, -R + 18); ctx.lineTo(-6, -R + 10); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  // Course pointer and deviation bar (±2 dots), TO/FROM.
  if (src.crs !== null) {
    ctx.save(); ctx.rotate(src.crs * DEG);
    const dot = R * 0.22, col = src.color;
    ctx.strokeStyle = G.white; ctx.lineWidth = 2;
    for (const k of [-2, -1, 1, 2]) { ctx.beginPath(); ctx.arc(k * dot, 0, 5, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(0, -R + 20); ctx.lineTo(0, -R * 0.5); ctx.moveTo(0, R * 0.5); ctx.lineTo(0, R - 8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -R + 6); ctx.lineTo(-10, -R + 24); ctx.lineTo(10, -R + 24); ctx.closePath(); ctx.fill();
    if (src.valid) {
      const dx = clamp(src.dev, -1.2, 1.2) * 2 * dot;
      ctx.beginPath(); ctx.moveTo(dx, -R * 0.45); ctx.lineTo(dx, R * 0.45); ctx.stroke();
      if (src.toFrom) {
        const ty = -src.toFrom * R * 0.3;
        ctx.beginPath(); ctx.moveTo(R * 0.12 + 0, ty - src.toFrom * 10); ctx.lineTo(R * 0.12 - 8, ty + src.toFrom * 4); ctx.lineTo(R * 0.12 + 8, ty + src.toFrom * 4); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }
  ctx.restore();
  // Lubber line, own ship, the source and the GPS phase.
  ctx.fillStyle = G.white; ctx.beginPath(); ctx.moveTo(0, -R + 1); ctx.lineTo(-8, -R - 10); ctx.lineTo(8, -R - 10); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = G.white; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(0, 18); ctx.moveTo(-18, -2); ctx.lineTo(18, -2); ctx.moveTo(-8, 15); ctx.lineTo(8, 15); ctx.stroke(); ctx.lineCap = 'butt';
  t(ctx, src.src, -R * 0.46, -R * 0.3, 18, src.color, 'center', 700);
  if (src.phase) t(ctx, src.phase, R * 0.46, -R * 0.3, 17, G.magenta, 'center', 700);
  if (!src.valid && src.src !== 'GPS') t(ctx, 'NO SIGNAL', 0, R * 0.36, 14, G.amber, 'center', 700);
  ctx.restore();
  // Heading box on the lubber line.
  rect(ctx, cx - 34, cy - R - 42, 68, 30, G.black, G.white, 2);
  t(ctx, `${deg3(hdg)}°`, cx + 2, cy - R - 27, 23, G.white, 'center', 700, MONO);
}

function afcs(ctx, d) {
  rect(ctx, 170, 34, 480, 30, G.bar);
  ctx.strokeStyle = G.line; ctx.lineWidth = 1.5;
  for (const x of [330, 410, 490]) { ctx.beginPath(); ctx.moveTo(x, 38); ctx.lineTo(x, 60); ctx.stroke(); }
  const a = d.afcs;
  if (!a || !a.on) return;
  t(ctx, a.lat, 250, 49, 20, G.green, 'center', 700);
  t(ctx, a.label || 'AP', 370, 49, 20, G.green, 'center', 700);
  t(ctx, a.vert, 450, 49, 20, G.green, 'center', 700);
  if (a.ref) t(ctx, a.ref, 498, 49, 19, G.green, 'left', 600);
  if (a.armed) t(ctx, a.armed, 644, 49, 15, G.white, 'right', 700);
}

function boxes(ctx, d) {
  // Wind (direction arrow relative to the nose, then direction and speed).
  rect(ctx, 160, 646, 134, 58, G.black, G.line, 1);
  if (d.wow || d.gs < 30) t(ctx, 'NO WIND DATA', 227, 675, 14, G.white, 'center');
  else if (d.windKt < 1) t(ctx, 'CALM', 227, 675, 17, G.white, 'center');
  else {
    ctx.save(); ctx.translate(186, 675); ctx.rotate((d.windDir + 180 - d.trueHdg) * DEG);
    ctx.strokeStyle = G.white; ctx.fillStyle = G.white; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 16); ctx.lineTo(0, -10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(-8, -8); ctx.lineTo(8, -8); ctx.closePath(); ctx.fill(); ctx.restore();
    t(ctx, `${deg3(d.windDir - d.magVar)}°`, 218, 662, 18, G.white, 'left', 600, MONO);
    t(ctx, `${Math.round(d.windKt)}KT`, 218, 688, 18, G.white, 'left', 600, MONO);
  }
  rect(ctx, 160, 710, 134, 28, G.black, G.line, 1);
  pair(ctx, 166, 724, 19, 'OAT', `${Math.round(d.oat)}°C`, G.white);
  // Transponder and the clock.
  rect(ctx, 856, 682, 164, 56, G.black, G.line, 1);
  const mode = d.xpdrMode | 0, on = d.av && mode > 0;
  t(ctx, 'XPDR', 862, 696, 15, G.white);
  t(ctx, on ? String(d.squawk | 0).padStart(4, '0') : '----', 912, 696, 19, on ? (mode >= 2 ? G.green : G.white) : G.dim, 'left', 600, MONO);
  t(ctx, d.av ? XPDR[mode] : '', 1014, 696, 15, mode >= 2 ? G.green : G.white, 'right', 700);
  const s = ((d.clock % 86400) + 86400) % 86400;
  t(ctx, 'LCL', 862, 724, 15, G.white);
  t(ctx, [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'), 912, 724, 19, G.white, 'left', 600, MONO);
}

function alerts(ctx, d) {
  const m = annunciations(d);
  if (!m.length) return;
  const x = 846, w = 172, y = 104;
  rect(ctx, x, y, w, 10 + m.length * 28, G.black, G.line, 1.5);
  const flash = (d.clock * 2 | 0) % 2;
  m.forEach(([s, lvl], i) => {
    const yy = y + 19 + i * 28, col = lvl === 3 ? G.red : G.yellow;
    if (lvl === 3 && flash) { rect(ctx, x + 4, yy - 12, w - 8, 24, col); t(ctx, s, x + w / 2, yy + 1, 17, G.black, 'center', 800); }
    else t(ctx, s, x + w / 2, yy + 1, 17, col, 'center', 800);
  });
}

function softkeys(ctx, labels, lit = []) {
  rect(ctx, 0, 742, VW, 26, '#101317');
  const kw = VW / 12;
  ctx.strokeStyle = G.line; ctx.lineWidth = 1.5;
  for (let i = 1; i < 12; ++i) { ctx.beginPath(); ctx.moveTo(i * kw, 745); ctx.lineTo(i * kw, 765); ctx.stroke(); }
  labels.forEach((l, i) => {
    if (!l) return;
    if (lit[i]) rect(ctx, i * kw + 3, 745, kw - 6, 20, '#c9d1da');
    t(ctx, l, (i + 0.5) * kw, 756, 14, lit[i] ? G.black : G.white, 'center', 700);
  });
}
const PFD_KEYS = ['', '', '', 'CDI', '', 'XPDR', '', 'STD BARO', '', 'TMR/REF', '', ''];

function pfd(ctx, d, withEis) {
  const src = cdi(d);
  // Attitude across the whole screen behind the tapes and the HSI.
  const cx = 456, cy = 300, ppd = 8.6;
  attitudeScene(ctx, 0, 34, VW, 708, cx, cy, ppd, 7.68, d, { ladder: 330, span: 15 });
  rollScale(ctx, cx, cy, 172, 6.4, d);
  // Aircraft symbol (the single-cue delta).
  ctx.fillStyle = G.yellow; ctx.strokeStyle = G.black; ctx.lineWidth = 2;
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + s * 108, cy + 38); ctx.lineTo(cx + s * 64, cy + 38); ctx.lineTo(cx, cy + 14); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillRect(cx + s * 150 - 14, cy - 4, 28, 8); ctx.strokeRect(cx + s * 150 - 14, cy - 4, 28, 8);
  }
  if (d.tumbled) {
    ctx.strokeStyle = G.red; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(260, 90); ctx.lineTo(640, 480); ctx.moveTo(640, 90); ctx.lineTo(260, 480); ctx.stroke();
    t(ctx, 'ATTITUDE FAIL', cx, 340, 22, G.yellow, 'center', 800);
  }
  speedTape(ctx, d);
  altTape(ctx, d);
  vsiTape(ctx, d);
  vdi(ctx, src);
  hsi(ctx, d, src);
  boxes(ctx, d);
  alerts(ctx, d);
  radios(ctx, d, src.src);
  navStatus(ctx, d);
  afcs(ctx, d);
  if (withEis) eis(ctx, d, 0, 34, 150, 708);
  softkeys(ctx, PFD_KEYS, [false, false, false, g1000.cdi !== 'auto', false, false, false, false, false, g1000.refs]);
}

// ---------------------------------------------------- engine indication ----
// A horizontal gauge: label and reading over a scale with its bands and a
// white pointer (none without a reading); the label goes red or yellow in a band.
function hbar(ctx, x, y, w, label, unit, v, min, max, bands, digits = 0, alarm = null) {
  const sx = x + 10, sw = w - 20, sy = y + 38, at = (q) => sx + (clamp(q, min, max) - min) / (max - min) * sw;
  const ok = Number.isFinite(v);
  const col = !ok ? G.white : alarm ? alarm(v) || G.white : G.white;
  t(ctx, label, x + 8, y + 14, 15, col, 'left', 700);
  t(ctx, ok ? v.toFixed(digits) : '---', x + w - 8, y + 14, 17, ok ? col : G.grey, 'right', 600, MONO);
  ctx.fillStyle = '#3a4048'; ctx.fillRect(sx, sy - 3, sw, 6);
  for (const [a, b, c] of bands) { ctx.fillStyle = c; ctx.fillRect(at(a), sy - 4, at(b) - at(a), 8); }
  if (unit) t(ctx, unit, x + 8, y + 52, 11, G.grey);
  if (ok) {
    const px = at(v); ctx.fillStyle = G.white; ctx.strokeStyle = G.black; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, sy + 2); ctx.lineTo(px - 7, sy - 12); ctx.lineTo(px + 7, sy - 12); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}
function eis(ctx, d, x, y, w, h) {
  const e = d.eng, mk = d.mk;
  rect(ctx, x, y, w, h, '#0b0d10');
  ctx.strokeStyle = G.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.stroke();
  const red = (lo, hi) => (v) => (v < lo || v >= hi ? G.red : null);
  // Tachometer: an arc, its green band and red line, and the digital rpm.
  const cx = x + w / 2, cy = y + 92, r = 56, max = mk.tachMax, a = (v) => (-210 + clamp(v, 0, max) / max * 240) * DEG;
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#3a4048'; ctx.beginPath(); ctx.arc(cx, cy, r, a(0), a(max)); ctx.stroke();
  ctx.strokeStyle = G.green; ctx.beginPath(); ctx.arc(cx, cy, r, a(mk.tachGreen[0]), a(mk.tachGreen[1])); ctx.stroke();
  ctx.strokeStyle = G.red; ctx.beginPath(); ctx.arc(cx, cy, r, a(mk.tachRed), a(max)); ctx.stroke();
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (let v = 0; v <= max; v += 500) { const q = a(v); ctx.beginPath(); ctx.moveTo(cx + Math.cos(q) * (r - 7), cy + Math.sin(q) * (r - 7)); ctx.lineTo(cx + Math.cos(q) * (r + 7), cy + Math.sin(q) * (r + 7)); ctx.stroke(); }
  if (Number.isFinite(e.rpm)) {
    const q = a(e.rpm); ctx.fillStyle = G.white; ctx.strokeStyle = G.black; ctx.lineWidth = 1.5;
    ctx.save(); ctx.translate(cx + Math.cos(q) * (r - 4), cy + Math.sin(q) * (r - 4)); ctx.rotate(q + Math.PI / 2);
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(-7, 8); ctx.lineTo(7, 8); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  const rpmCol = e.rpm >= mk.tachRed + 1 ? G.red : G.white;
  t(ctx, Number.isFinite(e.rpm) ? String(Math.round(e.rpm / 10) * 10) : '---', cx, cy + 4, 24, rpmCol, 'center', 700, MONO);
  t(ctx, 'RPM', cx, cy + 30, 14, G.white, 'center', 700);
  // The bar gauges, top to bottom as the 172S's engine page has them.
  let yy = y + 150;
  const row = (...args) => { hbar(ctx, x, yy, w, ...args); yy += 56; };
  row('FFLOW GPH', '', e.ff, 0, 20, [[0, 12, G.green]], 1);
  row('OIL PRES', 'PSI', e.oilP, 0, mk.oilP[3], [[0, mk.oilP[2], G.red], [mk.oilP[0], mk.oilP[1], G.green], [mk.oilP[3] - 2, mk.oilP[3], G.red]], 0, red(mk.oilP[2], mk.oilP[3]));
  row('OIL TEMP', '°F', e.oilT, 50, mk.oilT[2] + 5, [[mk.oilT[0], mk.oilT[1], G.green], [mk.oilT[2], mk.oilT[2] + 5, G.red]], 0, (v) => (v >= mk.oilT[2] ? G.red : null));
  row('CHT', '°F', NaN, 100, 500, [[200, 500, G.green]]);  // no cylinder-head temperature from the core
  row('EGT', '°F', e.egt, 1000, 1700, [], 0);
  row('VAC', 'IN HG', e.suction, 3, 7, [[mk.vac[0], mk.vac[1], G.green]], 1, (v) => (v < mk.vac[0] - 0.5 ? G.yellow : null));
  // Fuel quantity: one scale, a pointer each side.
  const full = mk.fuelFull, sx = x + 10, sw = w - 20, sy = yy + 40, at = (q) => sx + clamp(q, 0, full) / full * sw;
  const lowF = (v) => v < 1.5;
  t(ctx, 'FUEL QTY GAL', x + 8, yy + 14, 15, lowF(e.fuelL) || lowF(e.fuelR) ? G.yellow : G.white, 'left', 700);
  ctx.fillStyle = '#3a4048'; ctx.fillRect(sx, sy - 3, sw, 6);
  ctx.fillStyle = G.red; ctx.fillRect(sx, sy - 4, at(1.5) - sx, 8);
  ctx.fillStyle = G.white; ctx.strokeStyle = G.black; ctx.lineWidth = 1.5;
  for (const [v, up, l] of [[e.fuelL, true, 'L'], [e.fuelR, false, 'R']]) {
    if (!Number.isFinite(v)) continue;
    const px = at(v), s = up ? -1 : 1;
    ctx.beginPath(); ctx.moveTo(px, sy + s * 3); ctx.lineTo(px - 8, sy + s * 19); ctx.lineTo(px + 8, sy + s * 19); ctx.closePath(); ctx.fill(); ctx.stroke();
    t(ctx, l, px, sy + s * 13 + (up ? -1 : 2), 10, G.black, 'center', 800);
  }
  t(ctx, '0', sx, sy + 26, 11, G.grey, 'center'); t(ctx, 'F', sx + sw, sy + 26, 11, G.grey, 'center');
  yy += 74;
  // Numbers: engine hours, the bus and the battery, fuel left and endurance.
  ctx.strokeStyle = G.line; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x + 6, yy); ctx.lineTo(x + w - 6, yy); ctx.stroke();
  const num = (label, value, color = G.white) => { yy += 23; t(ctx, label, x + 8, yy, 14, G.white, 'left', 700); t(ctx, value, x + w - 8, yy, 16, color, 'right', 600, MONO); };
  num('ENG HRS', e.hobbs.toFixed(1));
  num('M BUS V', Number.isFinite(e.volts) ? e.volts.toFixed(1) : '--', e.volts < 24.5 ? G.red : e.volts > 32 ? G.red : G.white);
  num('M BATT A', Number.isFinite(e.amps) ? `${e.amps >= 0 ? '+' : ''}${e.amps.toFixed(1)}` : '--', e.amps < -1 ? G.yellow : G.white);
  const rem = (e.fuelL || 0) + (e.fuelR || 0);
  num('GAL REM', rem.toFixed(1), rem < 5 ? G.yellow : G.white);
  const end = e.ff > 0.5 ? rem / e.ff : null;
  num('ENDUR', end === null ? '--:--' : `${Math.floor(end)}:${String(Math.floor((end % 1) * 60)).padStart(2, '0')}`);
}

// ---------------------------------------------------------------- MFD ----
// Topography under the map: the core's ground (SRTM between the fields),
// sampled north up around the aircraft and kept until it has moved on.
let topo = null;
const TOPO = [[0, [32, 74, 44]], [1000, [44, 92, 46]], [2000, [80, 108, 48]], [2600, [110, 112, 56]], [3200, [132, 114, 62]], [4000, [138, 102, 64]],
  [5000, [124, 90, 62]], [6500, [154, 140, 126]], [9000, [210, 210, 210]]];
function topoColour(ft) {
  for (let i = 1; i < TOPO.length; ++i) {
    if (ft <= TOPO[i][0]) {
      const [a, ca] = TOPO[i - 1], [b, cb] = TOPO[i], f = clamp((ft - a) / (b - a), 0, 1);
      return ca.map((v, k) => v + (cb[k] - v) * f);
    }
  }
  return TOPO[TOPO.length - 1][1];
}
function topoImage(d, rangeM) {
  const half = 1.9 * rangeM;
  if (topo && topo.rangeM === rangeM && Math.hypot(d.x - topo.e, d.y - topo.n) < 0.3 * rangeM) return topo;
  const N = 128, cell = 2 * half / N, cv = topo?.cv || document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d'), img = g.createImageData(N, N), hgt = new Float32Array((N + 1) * (N + 1));
  const e0 = d.x - half, n1 = d.y + half;
  for (let j = 0; j <= N; ++j) for (let i = 0; i <= N; ++i) hgt[j * (N + 1) + i] = d.groundAt(e0 + (i + 0.5) * cell, n1 - (j + 0.5) * cell);
  for (let j = 0; j < N; ++j) for (let i = 0; i < N; ++i) {
    const hm = hgt[j * (N + 1) + i], k = 4 * (j * N + i);
    // Light from the north-west over the slope, gently.
    const sh = clamp(1 + ((hgt[j * (N + 1) + i + 1] - hm) * -0.7 + (hgt[(j + 1) * (N + 1) + i] - hm) * -0.7) / cell * 2.2, 0.72, 1.28);
    const col = hm < 0.5 ? [12, 40, 86] : topoColour(hm / 0.3048).map((v) => v * sh);
    img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  topo = { cv, e: d.x, n: d.y, rangeM, half };
  return topo;
}

function mfd(ctx, d) {
  const src = cdi(d);
  rect(ctx, 0, 0, VW, VH, G.black);
  // The map: heading up, the aircraft in the middle of it.
  const mx = 150, my = 34, mw = VW - 150, mh = 708, cx = mx + mw / 2, cy = my + 372, R = 290;
  const rangeNm = RANGES[g1000.range], rangeM = rangeNm * 1852, k = R / rangeM, th = d.trueHdg * DEG;
  ctx.save(); ctx.beginPath(); ctx.rect(mx, my, mw, mh); ctx.clip();
  ctx.translate(cx, cy);
  if (g1000.dcltr < 2) {
    const tp = topoImage(d, rangeM);
    ctx.save(); ctx.rotate(-th); ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tp.cv, (tp.e - tp.half - d.x) * k, -(tp.n + tp.half - d.y) * k, 2 * tp.half * k, 2 * tp.half * k);
    ctx.restore();
  }
  // The compass ring at the range.
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, 2 * Math.PI); ctx.stroke();
  ctx.setLineDash([6, 8]); ctx.beginPath(); ctx.arc(0, 0, R / 2, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
  for (let a = 0; a < 360; a += 10) {
    const rel = (a - d.hdg) * DEG, l = a % 30 ? 8 : 16;
    ctx.beginPath(); ctx.moveTo(Math.sin(rel) * R, -Math.cos(rel) * R); ctx.lineTo(Math.sin(rel) * (R - l), -Math.cos(rel) * (R - l)); ctx.stroke();
    if (a % 30 === 0) t(ctx, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[a] ?? String(a / 10), Math.sin(rel) * (R - 30), -Math.cos(rel) * (R - 30), 19, G.white, 'center', 700);
  }
  rect(ctx, -R * 0.72 - 30, R * 0.7 - 12, 60, 24, G.black, G.white, 1.5);
  t(ctx, `${rangeNm}NM`, -R * 0.72, R * 0.7 + 1, 15, G.cyan, 'center', 700);
  const put = (e, n) => {
    const de = e - d.x, dn = n - d.y, right = de * Math.cos(th) - dn * Math.sin(th), fwd = de * Math.sin(th) + dn * Math.cos(th);
    return [right * k, -fwd * k, Math.hypot(right, fwd)];
  };
  mapFeatures(ctx, put, 7.2, rangeM, { ...d, points: g1000.dcltr ? [] : d.points }, { behind: Infinity });
  // Own ship.
  ctx.fillStyle = G.white; ctx.strokeStyle = G.black; ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [px, py] of [[0, -20], [3, -12], [3, -4], [18, 4], [18, 8], [3, 4], [2, 13], [7, 17], [7, 20], [0, 18], [-7, 20], [-7, 17], [-2, 13], [-3, 4], [-18, 8], [-18, 4], [-3, -4], [-3, -12]]) ctx.lineTo(px, py);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  // Orientation, north, the page title.
  rect(ctx, mx, my, mw, 24, 'rgba(20,24,30,.85)');
  t(ctx, 'MAP - NAVIGATION MAP', mx + mw / 2, my + 12, 15, G.white, 'center', 700);
  t(ctx, 'HDG UP', mx + 8, my + 40, 14, G.white, 'left', 700);
  ctx.save(); ctx.translate(VW - 26, my + 48); ctx.rotate(-th);
  ctx.fillStyle = G.white; ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(7, 6); ctx.lineTo(0, 2); ctx.lineTo(-7, 6); ctx.closePath(); ctx.fill();
  ctx.restore();
  t(ctx, 'N', VW - 26, my + 72, 14, G.white, 'center', 700);
  flightPlan(ctx, d);
  if (g1000.dcltr) t(ctx, `DCLTR-${g1000.dcltr}`, mx + 8, my + mh - 14, 14, G.white, 'left', 700);
  // Top bar: the radios and the four navigation fields.
  radios(ctx, d, src.src);
  const g = d.gps && d.gps[0] && d.route ? d.gps : null;
  const ete = g && d.gs > 30 ? g[7] / (d.gs * 0.514444) : null;
  const fields = [['GS', `${Math.round(Math.max(0, d.gs))}KT`], ['DTK', g ? `${deg3(g[3] - g[13])}°` : '___°'], ['TRK', d.gs > 5 ? `${deg3(d.track - d.magVar)}°` : '___°'],
    ['ETE', ete === null ? '__:__' : `${Math.floor(ete / 60)}:${String(Math.floor(ete % 60)).padStart(2, '0')}`]];
  fields.forEach(([l, v], i) => pair(ctx, 300 + i * 112, 17, 19, l, v, G.magenta, 4));
  eis(ctx, d, 0, 34, 150, 708);
  softkeys(ctx, ['ENGINE', '', 'MAP', '', '', g1000.dcltr ? `DCLTR-${g1000.dcltr}` : 'DCLTR', '', '', '', '', 'RNG −', 'RNG +'], [true, false, true]);
}

// The active flight plan: the legs still to fly, the active one magenta.
function flightPlan(ctx, d) {
  const r = d.route, g = d.gps;
  if (!r || !g || !g[0] || r.wp.length < 2) return;
  const act = g[1], rows = [];
  let dist = g[7];
  for (let i = Math.max(1, act); i < r.wp.length && rows.length < 6; ++i) {
    if (i > act) dist += Math.hypot(r.wp[i].east - r.wp[i - 1].east, r.wp[i].north - r.wp[i - 1].north);
    const dtk = Math.atan2(r.wp[i].east - r.wp[i - 1].east, r.wp[i].north - r.wp[i - 1].north) / DEG - g[13];
    rows.push([r.wp[i].ident, deg3(dtk), (dist / 1852).toFixed(1), i === act]);
  }
  const x = VW - 238, y = 122, w = 230;
  rect(ctx, x, y, w, 34 + rows.length * 24, 'rgba(0,0,0,.78)', G.line, 1.5);
  t(ctx, 'ACTIVE FLIGHT PLAN', x + w / 2, y + 14, 13, G.cyan, 'center', 700);
  rows.forEach(([id, dtk, dis, on], i) => {
    const yy = y + 40 + i * 24, col = on ? G.magenta : G.white;
    t(ctx, id.slice(0, 8), x + 8, yy, 15, col, 'left', 700);
    t(ctx, `${dtk}°`, x + 148, yy, 15, col, 'right', 600, MONO);
    t(ctx, `${dis}NM`, x + w - 8, yy, 15, col, 'right', 600, MONO);
  });
}

// ------------------------------------------------------------- layout ----
// A display: its bezel, then its 1024 x 768 screen scaled into the rect.
function screen(ctx, x, y, w, h, kind, on, draw, track = true) {
  ctx.fillStyle = '#16181c'; ctx.fillRect(x, y, w, h);
  const s = Math.min((w - 6) / VW, (h - 6) / VH), ox = x + (w - VW * s) / 2, oy = y + (h - VH * s) / 2;
  if (track) g1000.screens.push({ kind, x: ox, y: oy, s });
  ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, VW * s, VH * s); ctx.clip();
  ctx.translate(ox, oy); ctx.scale(s, s);
  ctx.fillStyle = '#030405'; ctx.fillRect(0, 0, VW, VH);
  if (on) draw(ctx);
  ctx.restore();
}

// The 2D strip: PFD and MFD side by side (or one over the other in a tall
// panel); where both would be under two thirds of one alone (a phone), the
// PFD alone with the engine strip down its left side, as in reversionary mode.
// The PFD shows the engine strip too while the MFD is dark.
export function drawG1000(ctx, w, h, d) {
  ctx.clearRect(0, 0, w, h);
  g1000.screens = [];
  const pad = 3, gap = 6, W = w - 2 * pad, H = h - 2 * pad, AR = VW / VH;
  const side = Math.min(H, (W - gap) / (2 * AR)), stack = Math.min((H - gap) / 2, W / AR), one = Math.min(H, W / AR);
  const pfdOn = d.power.pfd, mfdOn = d.power.mfd;
  if (Math.max(side, stack) >= 0.66 * one) {
    const dh = Math.max(side, stack), dw = dh * AR;
    const [px, py, mx, my] = side >= stack ? [(w - 2 * dw - gap) / 2, (h - dh) / 2, (w + gap) / 2, (h - dh) / 2]
      : [(w - dw) / 2, (h - 2 * dh - gap) / 2, (w - dw) / 2, (h + gap) / 2];
    screen(ctx, px, py, dw, dh, 'pfd', pfdOn, (c) => pfd(c, d, !mfdOn));
    screen(ctx, mx, my, dw, dh, 'mfd', mfdOn, (c) => mfd(c, d));
  } else {
    const dw = one * AR;
    screen(ctx, (w - dw) / 2, (h - one) / 2, dw, one, 'pfd', pfdOn, (c) => pfd(c, d, true));
  }
}

// ------------------------------------------------------- pointer input ----
// Where (x, y) on the panel canvas falls: the softkeys, and the knob-like
// places (heading, course, barometer, selected altitude, map range).
function hit(x, y) {
  for (const sc of g1000.screens) {
    const vx = (x - sc.x) / sc.s, vy = (y - sc.y) / sc.s;
    if (vx < 0 || vy < 0 || vx > VW || vy > VH) continue;
    const key = vy >= 742 ? Math.floor(vx / (VW / 12)) : -1;
    return { kind: sc.kind, vx, vy, key };
  }
  return null;
}
const inBox = (h, x0, y0, x1, y1) => h.vx >= x0 && h.vx <= x1 && h.vy >= y0 && h.vy <= y1;
// What the wheel turns there: 'hdg', 'crs', 'baro', 'alt', 'range' (null: nothing).
export function g1000WheelTarget(x, y) {
  const h = hit(x, y);
  if (!h || h.key >= 0) return null;
  if (h.kind === 'mfd') return h.vx > 150 ? 'range' : null;
  if (inBox(h, 662, 60, 760, 100)) return 'alt';
  if (inBox(h, 662, 494, 760, 526)) return 'baro';
  if (inBox(h, 506, 488, 620, 524)) return 'crs';
  if (inBox(h, 296, 488, 406, 524) || Math.hypot(h.vx - 456, h.vy - 632) < 130) return 'hdg';
  return null;
}
// Map range: the wheel (n > 0 zooms out) or the RNG softkeys.
export function g1000Range(n) {
  g1000.range = clamp(g1000.range + n, 0, RANGES.length - 1);
  return `Map range ${RANGES[g1000.range]} NM`;
}
// A click: the softkeys.
export function g1000Click(x, y) {
  const h = hit(x, y);
  return h && h.key >= 0 ? g1000Key(h.kind, h.key) : null;
}
// Softkey `key` (0-11) of the 'pfd' or the 'mfd'. Returns { msg } for a
// setting changed here, or { act } for one the app carries out ('xpdr', 'stdbaro').
export function g1000Key(kind, key) {
  if (kind === 'pfd') {
    switch (key) {
      case 3: g1000.cdi = { auto: 'gps', gps: 'nav', nav: 'auto' }[g1000.cdi];
        return { msg: `CDI: ${{ auto: 'automatic (LOC once tuned, else GPS with a route, else VOR 1)', gps: 'GPS', nav: 'NAV 1 (VOR / LOC)' }[g1000.cdi]}` };
      case 5: return { act: 'xpdr' };
      case 7: return { act: 'stdbaro' };
      case 9: g1000.refs = !g1000.refs; return { msg: `Reference speeds ${g1000.refs ? 'on: Vr 55, Vx 62, Vy 74, glide 68 KIAS' : 'off'}` };
      default: return null;
    }
  }
  switch (key) {
    case 5: g1000.dcltr = (g1000.dcltr + 1) % 3; return { msg: ['Map: everything', 'Map: landmarks off', 'Map: landmarks and topography off'][g1000.dcltr] };
    case 10: return { msg: g1000Range(-1) };
    case 11: return { msg: g1000Range(1) };
    default: return null;
  }
}
// The pointer's cursor over the panel.
export function g1000Cursor(x, y) {
  const h = hit(x, y);
  if (!h) return '';
  if (h.key >= 0) {
    const live = h.kind === 'pfd' ? [3, 5, 7, 9] : [5, 10, 11];
    return live.includes(h.key) ? 'pointer' : '';
  }
  return g1000WheelTarget(x, y) ? 'ns-resize' : '';
}
// The labels of the places the wheel turns.
export const G1000_WHEEL = { hdg: 'heading bug', crs: 'course', baro: 'altimeter setting', alt: 'selected altitude', range: 'map range' };

// --------------------------------------------------------- 3D cockpit ----
// The displays on the 3D cockpit's panel (panel.js; panel metres: u right
// from the pilot's edge, v down from the glareshield; X(m) gives pixels):
// two GDU bezels with their knobs and softkeys, the audio panel between.
const GDU = { pfd: 0.095, mfd: 0.455 }, BZ = { v: 0.022, w: 0.29, h: 0.226 }, SCR = { du: 0.0395, v: 0.034, w: 0.211, h: 0.1583 };
const KNOBS = [['NAV', 0.02, 0.07], ['HDG', 0.02, 0.135], ['ALT', 0.02, 0.2], ['COM', 0.27, 0.07], ['CRS', 0.27, 0.12], ['BARO', 0.27, 0.16], ['RANGE', 0.27, 0.2]];
const LIVE = { pfd: { 3: 'CDI', 5: 'XPDR', 7: 'STD BARO', 9: 'TMR/REF' }, mfd: { 5: 'DCLTR', 10: 'RNG −', 11: 'RNG +' } };
export function drawG1000Cockpit(ctx, X, d) {
  const lbl = (s, x, y, size) => { ctx.font = `700 ${size}px ${SANS}`; ctx.fillStyle = '#c9ccd1'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y); };
  for (const [kind, u0] of Object.entries(GDU)) {
    ctx.fillStyle = '#0b0c0e'; ctx.fillRect(X(u0 - 0.004), X(BZ.v - 0.004), X(BZ.w + 0.008), X(BZ.h + 0.008));
    ctx.fillStyle = '#2b2e33'; ctx.fillRect(X(u0), X(BZ.v), X(BZ.w), X(BZ.h));
    const on = kind === 'pfd' ? d.power.pfd : d.power.mfd;
    screen(ctx, X(u0 + SCR.du), X(SCR.v), X(SCR.w), X(SCR.h), kind, on, (c) => (kind === 'pfd' ? pfd(c, d, !d.power.mfd) : mfd(c, d)), false);
    for (let i = 0; i < 12; ++i) {
      const x = X(u0 + SCR.du + (i + 0.15) * SCR.w / 12), w = X(SCR.w / 12 * 0.7);
      ctx.fillStyle = '#17191c'; ctx.fillRect(x, X(0.2), w, X(0.011));
      ctx.fillStyle = '#3d4148'; ctx.fillRect(x + 1, X(0.2) + 1, w - 2, X(0.011) - 2);
    }
    for (const [name, du, v] of KNOBS) {
      if (name === 'RANGE' && kind === 'pfd') continue;
      const x = X(u0 + du), y = X(v), r = X(0.0085);
      ctx.fillStyle = '#121315'; ctx.beginPath(); ctx.arc(x, y, r * 1.25, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#3b3f45'; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#26292d'; ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, 2 * Math.PI); ctx.fill();
      lbl(name, x, y - r * 1.25 - X(0.005), X(0.0058));
    }
    lbl('GARMIN', X(u0 + BZ.w / 2), X(BZ.v + 0.007), X(0.0062));
  }
  // The audio panel (GMA 1347): its buttons, marker lights dark.
  const ax = X(0.393), aw = X(0.054);
  ctx.fillStyle = '#0b0c0e'; ctx.fillRect(ax - 2, X(0.026), aw + 4, X(0.212));
  ctx.fillStyle = '#2b2e33'; ctx.fillRect(ax, X(0.03), aw, X(0.204));
  ['COM1 MIC', 'COM1', 'COM2 MIC', 'COM2', 'COM3', 'PA', 'SPKR', 'MKR', 'DME', 'NAV1', 'ADF', 'NAV2', 'AUX', 'MAN SQ', 'PILOT', 'COPLT'].forEach((n, i) => {
    const x = ax + X(0.004 + (i % 2) * 0.025), y = X(0.042 + Math.floor(i / 2) * 0.023);
    ctx.fillStyle = '#17191c'; ctx.fillRect(x, y, X(0.021), X(0.012));
    lbl(n, x + X(0.0105), y + X(0.006), X(0.0042));
  });
  lbl('AUDIO', ax + aw / 2, X(0.226), X(0.006));
}
// The clickable places on those bezels (panel metres), the knobs and the live
// softkeys, plus the standby attitude indicator and altimeter (panel.js):
// kinds the app maps to the simulation like the six-pack's (app.js panelSpot).
export const G1000_SPOTS = (() => {
  const out = [];
  const knob = { NAV: ['navTune', 'NAV knob: scroll to tune the standby, click to swap'], HDG: ['hdgSync', 'HDG knob'], ALT: ['altSel', 'ALT knob'],
    COM: ['comTune', 'COM knob: scroll to tune the standby, click to swap'], CRS: ['obs', 'CRS knob'], BARO: ['baro', 'BARO knob'], RANGE: ['range', 'RANGE knob'] };
  for (const [kind, u0] of Object.entries(GDU)) {
    for (const [name, du, v] of KNOBS) {
      if (name === 'RANGE' && kind === 'pfd') continue;
      out.push({ kind: knob[name][0], label: knob[name][1], u: u0 + du - 0.011, v: v - 0.011, w: 0.022, h: 0.022 });
    }
    for (const [key, name] of Object.entries(LIVE[kind])) {
      out.push({ kind: 'g1key', screen: kind, key: +key, label: `${kind.toUpperCase()} softkey ${name}`, u: u0 + SCR.du + +key * SCR.w / 12, v: 0.197, w: SCR.w / 12, h: 0.017 });
    }
  }
  out.push({ kind: 'cage', label: 'Standby attitude indicator: click to cage (wings level)', u: 0.211, v: 0.271, w: 0.058, h: 0.058 });
  out.push({ kind: 'baro', label: 'Standby altimeter', u: 0.296, v: 0.271, w: 0.058, h: 0.058 });
  return out;
})();
