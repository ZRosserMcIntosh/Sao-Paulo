// São Paulo World · flight test bed: the Top G's glass flight deck, drawn from the
// simulation. The PFD reads the instrument models (indicated airspeed and
// altitude with their lags, the attitude reference, the heading reference);
// the engine display and gear/flap/speedbrake indications read the systems.
// Used for the 2D strip and, at higher resolution, the 3D panel texture.

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MONO = '"JetBrains Mono",ui-monospace,monospace';
const SANS = '"Public Sans",system-ui,sans-serif';
const C = {
  sky: '#2f6fd1', ground: '#7a5230', white: '#f2f4f6', grey: '#8b95a3', dim: '#4b5563', black: '#000',
  green: '#38d26a', cyan: '#3fd6e6', magenta: '#e04fd8', amber: '#f2b33a', red: '#ff3b30', yellow: '#ffe14a',
};
const LB = 2.20462;

function text(ctx, s, x, y, size, color = C.white, align = 'center', font = MONO, weight = 600) {
  ctx.font = `${weight} ${size}px ${font}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}
function box(ctx, x, y, w, h, stroke, fill, lw = 1.5) {
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.strokeRect(x, y, w, h); }
}

// Speed limits shared by the PFD and the crew alerting: the barber pole is
// the lowest of Vmo, the Mmo speed at this altitude, VFE (flaps out) and VLE
// (gear out); the low-speed band starts at the 1-g stall speed for this
// weight and configuration, scaled by the load factor.
function speedLimits(d) {
  const mmoIas = d.mach > 0.1 ? d.ias * d.mmo / d.mach : 1e9;
  let vmax = Math.min(d.vmo, mmoIas);
  if (d.vfe > 0) vmax = Math.min(vmax, d.vfe);
  if (d.gear > 0.01 && d.vle > 0) vmax = Math.min(vmax, d.vle);
  const vss = d.vs1g > 0 ? d.vs1g * Math.sqrt(clamp(d.nz || 1, 0.5, 3)) : 0;
  return { vmax, vss, vmin: vss * 1.13 };
}

// Flight phase for the V-speed bugs: take-off until 1,000 ft with flaps out,
// approach once the landing flap is set (or gear down with flaps out).
function vSpeeds(d) {
  const takeoff = d.wow || (d.ra < 1000 && d.flaps > 1 && d.vsi > 100 && d.flaps < d.ldgFlap - 2);
  if (takeoff && d.vsTO > 0) {
    const v2 = Math.round(1.2 * d.vsTO), vr = v2 - 6, v1 = vr - 4;
    return { phase: 'TO', bugs: [['1', v1], ['R', vr], ['2', v2]], text: `V1 ${v1}  VR ${vr}  V2 ${v2}` };
  }
  if (!d.wow && d.vsLDG > 0 && (d.flaps >= d.ldgFlap - 2 || (d.gear > 0.99 && d.flaps > 1))) {
    const ref = Math.round(1.23 * d.vsLDG);
    return { phase: 'APP', bugs: [['RF', ref], ['AP', ref + 5]], text: `VREF ${ref}` };
  }
  return { phase: '', bugs: [], text: '' };
}

// Crew alerting: [message, level] with 3 warning (red), 2 caution (amber),
// 1 advisory (cyan), 0 status (white); most urgent first.
export function casMessages(d) {
  const m = [];
  const lim = speedLimits(d);
  const side = (i) => (i ? 'R' : 'L');
  for (let i = 0; i < 2; ++i) {
    if (d.fuelSw[i] && !d.run[i] && !d.starting[i]) m.push([`${side(i)} ENGINE FAIL`, 3]);
    if (!d.fuelSw[i] && !d.run[i]) m.push([`${side(i)} ENGINE OFF`, 2]);
    if (d.run[i] && d.oil[i] < 25) m.push([`${side(i)} OIL PRESS LOW`, 2]);
    if (d.starting[i]) m.push([`${side(i)} ENGINE START`, 0]);
  }
  if (!d.wow && d.gear < 0.99 && (d.flaps > 25 || (d.ra < 700 && d.thrLever < 0.3 && d.vsi < -200))) m.push(['GEAR NOT DOWN', 3]);
  if (!d.wow && d.ias > lim.vmax + 3) m.push(['OVERSPEED', 3]);
  if (d.pusher) m.push(['STICK PUSHER', 3]);
  if (d.stall) m.push(['STALL', 3]);
  if (d.wow && d.thrLever > 0.7 && (d.flaps < 9 || d.flaps > 21 || d.spd > 0.02 || d.park)) m.push(['NO TAKEOFF CONFIG', 3]);
  if (d.fuelKg < 1500) m.push(['FUEL LOW', 2]);
  if ((d.run[0] || d.run[1]) && !d.gen) m.push(['GEN OFF', 2]);
  const sbBad = d.spd > 0.02 && (d.flaps > 25 || d.thrLever > 0.6 || (!d.wow && d.ra < 1000));
  if (sbBad) m.push(['SPEEDBRAKE', 2]);
  else if (d.spd > 0.02) m.push(['SPEEDBRAKE EXTENDED', 1]);
  if (d.park) m.push(['PARKING BRAKE', 1]);
  return m.sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------- PFD ----
export function drawPFD(ctx, x, y, w, h, d) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = C.black; ctx.fillRect(x, y, w, h);
  const u = h / 100;  // layout unit
  const lim = speedLimits(d), vs = vSpeeds(d);
  const airborne = !d.wow && d.tas > 40;
  // Attitude.
  const ax = x + w * 0.2, aw = w * 0.56, ay = y + 8 * u, ah = h * 0.64;
  const cx = ax + aw / 2, cy = ay + ah * 0.48, ppd = ah / 42;
  ctx.save();
  ctx.beginPath(); ctx.rect(ax, ay, aw, ah); ctx.clip();
  ctx.translate(cx, cy); ctx.rotate(-d.roll * DEG); ctx.translate(0, d.pitch * ppd);
  const big = Math.max(aw, ah) * 3;
  const sky = ctx.createLinearGradient(0, -ah * 0.9, 0, 0);
  sky.addColorStop(0, '#1d4fa3'); sky.addColorStop(1, C.sky);
  ctx.fillStyle = sky; ctx.fillRect(-big, -big, 2 * big, big);
  const gnd = ctx.createLinearGradient(0, 0, 0, ah * 0.9);
  gnd.addColorStop(0, C.ground); gnd.addColorStop(1, '#4e331d');
  ctx.fillStyle = gnd; ctx.fillRect(-big, 0, 2 * big, big);
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.35);
  ctx.beginPath(); ctx.moveTo(-big, 0); ctx.lineTo(big, 0); ctx.stroke();
  // Heading marks along the horizon, every 10 degrees.
  ctx.lineWidth = Math.max(1, u * 0.2);
  for (let k = -40; k <= 40; k += 10) {
    const hk = Math.round(d.hdg / 10) * 10 + k, xx = (hk - d.hdg) * ppd;
    ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, u * 1.2); ctx.stroke();
  }
  for (let p = -90; p <= 90; p += 2.5) {
    if (!p) continue;
    const yy = -p * ppd, major = p % 10 === 0, mid = p % 5 === 0;
    if (Math.abs(p - d.pitch) > 24) continue;
    const l = major ? aw * 0.16 : mid ? aw * 0.08 : aw * 0.04;
    ctx.strokeStyle = C.white; ctx.lineWidth = major ? Math.max(1.5, u * 0.3) : Math.max(1, u * 0.2);
    ctx.beginPath(); ctx.moveTo(-l, yy); ctx.lineTo(l, yy); ctx.stroke();
    if (major) { text(ctx, String(Math.abs(p)), -l - u * 3, yy, u * 3.2); text(ctx, String(Math.abs(p)), l + u * 3, yy, u * 3.2); }
  }
  // Recovery chevrons: red arrows pointing back to the horizon at extreme pitch.
  ctx.strokeStyle = C.red; ctx.lineWidth = Math.max(2, u * 0.6);
  for (const p of [-75, -60, -45, -30, 45, 60, 75]) {
    if (Math.abs(p - d.pitch) > 26) continue;
    const yy = -p * ppd, dir = p > 0 ? 1 : -1, cw = aw * 0.11, ch = u * 5 * dir;
    ctx.beginPath(); ctx.moveTo(-cw, yy - ch); ctx.lineTo(0, yy + ch * 0.4); ctx.lineTo(cw, yy - ch); ctx.stroke();
  }
  // Flight path vector: where the airplane is actually going.
  if (airborne) {
    const fx = clamp(d.drift, -18, 18) * ppd, fy = -d.fpa * ppd, r = u * 1.7;
    ctx.strokeStyle = C.green; ctx.lineWidth = Math.max(1.5, u * 0.45);
    ctx.beginPath(); ctx.arc(fx, fy, r, 0, 2 * Math.PI);
    ctx.moveTo(fx - r, fy); ctx.lineTo(fx - r * 2.6, fy); ctx.moveTo(fx + r, fy); ctx.lineTo(fx + r * 2.6, fy);
    ctx.moveTo(fx, fy - r); ctx.lineTo(fx, fy - r * 2); ctx.stroke();
  }
  ctx.restore();
  // Roll scale and pointer.
  ctx.save(); ctx.translate(cx, cy);
  const rr = ah * 0.42;
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.3);
  ctx.beginPath(); ctx.arc(0, 0, rr, (-90 - 60) * DEG, (-90 + 60) * DEG); ctx.stroke();
  for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const a = (b - 90) * DEG, l = Math.abs(b) % 30 === 0 ? u * 3 : u * 1.8;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); ctx.lineTo(Math.cos(a) * (rr + l), Math.sin(a) * (rr + l)); ctx.stroke();
  }
  ctx.fillStyle = C.white; ctx.beginPath(); ctx.moveTo(0, -rr); ctx.lineTo(-u * 1.5, -rr - u * 2.5); ctx.lineTo(u * 1.5, -rr - u * 2.5); ctx.fill();
  ctx.rotate(-d.roll * DEG);
  const bankWarn = Math.abs(d.roll) > 35;
  ctx.fillStyle = bankWarn ? C.amber : C.white;
  ctx.beginPath(); ctx.moveTo(0, -rr + u * 0.5); ctx.lineTo(-u * 1.7, -rr + u * 3.2); ctx.lineTo(u * 1.7, -rr + u * 3.2); ctx.fill();
  // Slip/skid: the trapezoid under the pointer moves with the ball.
  const sk = clamp(d.ball / 16, -1, 1) * u * 3;
  ctx.fillRect(-u * 1.8 + sk, -rr + u * 3.8, u * 3.6, u * 0.9);
  ctx.restore();
  // Aircraft symbol.
  ctx.strokeStyle = C.yellow; ctx.fillStyle = C.black; ctx.lineWidth = Math.max(2, u * 0.7);
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(cx + s * aw * 0.3, cy); ctx.lineTo(cx + s * aw * 0.12, cy); ctx.lineTo(cx + s * aw * 0.12, cy + u * 2.5); ctx.stroke();
  }
  ctx.fillStyle = C.yellow; ctx.fillRect(cx - u * 0.9, cy - u * 0.9, u * 1.8, u * 1.8);
  // Radio altitude (over the terrain and buildings below).
  if (d.ra < 2500) {
    const col = d.ra < 200 ? C.amber : C.green;
    box(ctx, cx - u * 6.5, ay + ah * 0.84, u * 13, u * 5.6, col, C.black, 1);
    text(ctx, String(d.ra < 10 ? Math.round(d.ra) : Math.round(d.ra / 10) * 10), cx, ay + ah * 0.84 + u * 2.9, u * 4.2, col);
  }
  if (d.stall) { box(ctx, cx - u * 9, ay + ah * 0.62, u * 18, u * 6, null, C.red); text(ctx, 'STALL', cx, ay + ah * 0.62 + u * 3, u * 4.5, C.white, 'center', SANS, 800); }
  else if (!d.wow && d.ias > lim.vmax + 3) { box(ctx, cx - u * 13, ay + ah * 0.62, u * 26, u * 6, null, C.red); text(ctx, 'OVERSPEED', cx, ay + ah * 0.62 + u * 3, u * 4.2, C.white, 'center', SANS, 800); }

  // Speed tape.
  const sx = x + w * 0.03, sw = w * 0.13, sy = ay, sh = ah, scy = sy + sh * 0.48, ppk = sh / 90;
  box(ctx, sx, sy, sw, sh, null, 'rgba(70,80,95,.55)');
  ctx.save(); ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, u * 0.25);
  const v = Math.max(d.ias, 30);
  const ys = (k) => scy - (k - v) * ppk;
  for (let k = Math.floor((v - 50) / 10) * 10; k <= v + 50; k += 10) {
    if (k < 30) continue;
    ctx.beginPath(); ctx.moveTo(sx + sw, ys(k)); ctx.lineTo(sx + sw - u * 2, ys(k)); ctx.stroke();
    if (k % 20 === 0) text(ctx, String(k), sx + sw - u * 3.5, ys(k), u * 3.4, C.white, 'right');
  }
  const bw = u * 1.6, bx = sx + sw - bw;
  // Barber pole (high-speed limit) and low-speed awareness (red below the stall speed, amber margin).
  const yMax = ys(lim.vmax);
  for (let yy = sy; yy < yMax; yy += u * 2) { ctx.fillStyle = Math.floor((yy - sy) / (u * 2)) % 2 ? C.red : C.black; ctx.fillRect(bx, yy, bw, Math.min(u * 2, yMax - yy)); }
  if (lim.vss > 0 && (!d.wow || d.ias > 40)) {
    const yS = ys(lim.vss), yA = ys(lim.vmin);
    ctx.fillStyle = C.amber; ctx.fillRect(bx + bw * 0.25, yA, bw * 0.5, Math.max(0, yS - yA));
    for (let yy = yS; yy < sy + sh; yy += u * 2) { ctx.fillStyle = Math.floor((yy - yS) / (u * 2)) % 2 ? C.black : C.red; ctx.fillRect(bx, yy, bw, u * 2); }
  }
  // Speed trend: where the speed will be in 10 seconds.
  if (Math.abs(d.trend || 0) > 2 && d.ias > 30) {
    const yt = clamp(ys(v + d.trend), sy, sy + sh), xt = sx + sw - u * 0.6;
    ctx.strokeStyle = C.magenta; ctx.fillStyle = C.magenta; ctx.lineWidth = Math.max(1.5, u * 0.45);
    ctx.beginPath(); ctx.moveTo(xt, scy); ctx.lineTo(xt, yt); ctx.stroke();
    const dir = d.trend > 0 ? -1 : 1;
    ctx.beginPath(); ctx.moveTo(xt, yt); ctx.lineTo(xt - u, yt - dir * u * 1.6); ctx.lineTo(xt + u, yt - dir * u * 1.6); ctx.fill();
  }
  ctx.restore();
  // V-speed bugs: ticks on the tape edge, labels just outside it.
  for (const [lbl, vv] of vs.bugs) {
    const yy = ys(vv);
    if (yy < sy || yy > sy + sh) continue;
    ctx.strokeStyle = C.cyan; ctx.lineWidth = Math.max(1.5, u * 0.4);
    ctx.beginPath(); ctx.moveTo(sx + sw + u * 0.2, yy); ctx.lineTo(sx + sw - u * 2.2, yy); ctx.stroke();
    text(ctx, lbl, sx + sw + u * 0.6, yy, u * 2.4, C.cyan, 'left');
  }
  // Current-speed window.
  const spdCol = d.ias > lim.vmax ? C.red : !d.wow && lim.vss > 0 && d.ias < lim.vss ? C.red : !d.wow && d.ias < lim.vmin ? C.amber : C.white;
  ctx.fillStyle = C.black; ctx.strokeStyle = spdCol === C.white ? C.white : spdCol; ctx.lineWidth = Math.max(1.5, u * 0.3);
  ctx.beginPath(); ctx.rect(sx + u * 0.5, scy - u * 3.6, sw - u * 1.5, u * 7.2); ctx.fill(); ctx.stroke();
  text(ctx, String(Math.round(Math.max(d.ias, 0))), sx + sw - u * 2.2, scy, u * 5, spdCol, 'right');
  if (vs.phase === 'TO' && d.wow) {
    const [b1, br, b2] = vs.bugs;
    text(ctx, `V1 ${b1[1]}  VR ${br[1]}`, sx, y + 2.6 * u, u * 2.3, C.cyan, 'left');
    text(ctx, `V2 ${b2[1]}`, sx, y + 5.6 * u, u * 2.3, C.cyan, 'left');
  }
  if (d.mach >= 0.4) text(ctx, 'M .' + String(Math.round(d.mach * 1000)).padStart(3, '0'), sx + sw / 2, sy + sh + u * 4, u * 3.6, C.green);
  else if (vs.phase === 'APP') text(ctx, vs.text, sx + sw / 2 + u, sy + sh + u * 4, u * 2.8, C.cyan);
  else text(ctx, `GS ${Math.round(d.gs)}`, sx + sw / 2, sy + sh + u * 4, u * 3.2, C.grey);

  // Altitude tape.
  const tx = x + w * 0.79, tw = w * 0.13, tcy = scy, ppf = sh / 900;
  box(ctx, tx, sy, tw, sh, null, 'rgba(70,80,95,.55)');
  ctx.save(); ctx.beginPath(); ctx.rect(tx, sy, tw, sh); ctx.clip();
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, u * 0.25);
  for (let k = Math.floor((d.alt - 500) / 100) * 100; k <= d.alt + 500; k += 100) {
    const yy = tcy - (k - d.alt) * ppf;
    ctx.beginPath(); ctx.moveTo(tx, yy); ctx.lineTo(tx + u * (k % 500 ? 1.5 : 3), yy); ctx.stroke();
    if (k % 500 === 0) text(ctx, String(k), tx + u * 4, yy, u * 3.2, C.white, 'left');
  }
  // Ground: the radio altimeter's terrain level, hatched.
  if (d.ra < 1200) {
    const yg = tcy + d.ra * ppf;
    ctx.fillStyle = 'rgba(122,82,48,.85)'; ctx.fillRect(tx, yg, tw, sh);
    ctx.strokeStyle = C.amber; ctx.lineWidth = Math.max(1, u * 0.3);
    ctx.beginPath(); ctx.moveTo(tx, yg); ctx.lineTo(tx + tw, yg); ctx.stroke();
    for (let xx = tx - sh; xx < tx + tw; xx += u * 2.5) { ctx.beginPath(); ctx.moveTo(xx, yg + sh); ctx.lineTo(xx + sh, yg); ctx.stroke(); }
  }
  ctx.restore();
  // Altitude window with a rolling 20-foot drum for the last two digits.
  const wx = tx + u * 0.5, wy = tcy - u * 3.6, ww = tw - u, wh = u * 7.2;
  ctx.fillStyle = C.black; ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.3);
  ctx.beginPath(); ctx.rect(wx, wy, ww, wh); ctx.fill(); ctx.stroke();
  const altA = Math.abs(d.alt), neg = d.alt < 0;
  const hundreds = Math.floor(altA / 100), rem = altA - hundreds * 100;
  const drumX = wx + ww - u * 0.6, drumW = u * 5;
  text(ctx, (neg ? '-' : '') + String(hundreds), drumX - drumW, tcy, u * 4.6, C.white, 'right');
  ctx.save(); ctx.beginPath(); ctx.rect(drumX - drumW, wy + u * 0.3, drumW, wh - u * 0.6); ctx.clip();
  const step = u * 3.4, base = Math.floor(rem / 20) * 20, frac = (rem - base) / 20;
  for (let k = -2; k <= 2; ++k) {
    const val = (base + k * 20 + 100) % 100;
    text(ctx, String(val).padStart(2, '0'), drumX - drumW / 2, tcy - (k - frac) * step, u * 3.4, C.white);
  }
  ctx.restore();
  const std = Math.abs(d.baro - 29.92) < 0.005;
  text(ctx, std ? 'STD' : `${d.baro.toFixed(2)} IN`, tx + tw / 2, sy + sh + u * 4, u * 3.2, C.cyan);
  // Vertical speed.
  const vx = x + w * 0.93, vcy = tcy, vh = sh * 0.42;
  ctx.strokeStyle = C.grey; ctx.lineWidth = Math.max(1, u * 0.25);
  for (const f of [-6000, -4000, -2000, -1000, 0, 1000, 2000, 4000, 6000]) {
    const yy = vcy - Math.sign(f) * Math.sqrt(Math.abs(f) / 6000) * vh;
    ctx.beginPath(); ctx.moveTo(vx, yy); ctx.lineTo(vx + u * (f % 2000 ? 1 : 2), yy); ctx.stroke();
    if (f && Math.abs(f) % 2000 === 0) text(ctx, String(Math.abs(f) / 1000), vx + u * 4, yy, u * 2.6, C.grey);
  }
  const vy = vcy - Math.sign(d.vsi) * Math.sqrt(Math.min(Math.abs(d.vsi), 6500) / 6000) * vh;
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(2, u * 0.5);
  ctx.beginPath(); ctx.moveTo(vx + w * 0.07, vcy); ctx.lineTo(vx + u * 0.5, vy); ctx.stroke();
  if (Math.abs(d.vsi) > 400) text(ctx, String(Math.round(d.vsi / 50) * 50), vx + u * 3, d.vsi > 0 ? sy - u * 0.5 + u * 3 : sy + sh - u * 2, u * 2.8, C.green);

  // Heading arc with the bug and the track diamond.
  const hcx = cx, hcy = y + h * 1.12, hr = h * 0.36;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y + h * 0.75, w, h * 0.25); ctx.clip();
  ctx.fillStyle = 'rgba(70,80,95,.55)'; ctx.beginPath(); ctx.arc(hcx, hcy, hr, 0, 2 * Math.PI); ctx.fill();
  ctx.translate(hcx, hcy); ctx.rotate(-d.hdg * DEG);
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, u * 0.25);
  for (let k = 0; k < 360; k += 5) {
    ctx.save(); ctx.rotate(k * DEG);
    ctx.beginPath(); ctx.moveTo(0, -hr); ctx.lineTo(0, -hr + u * (k % 10 ? 1.2 : 2.4)); ctx.stroke();
    if (k % 30 === 0) text(ctx, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[k] ?? String(k / 10), 0, -hr + u * 5, u * 3.2);
    ctx.restore();
  }
  ctx.save(); ctx.rotate(d.bug * DEG); ctx.fillStyle = C.cyan; ctx.fillRect(-u * 1.3, -hr - u * 0.2, u * 2.6, u * 1.6); ctx.restore();
  if (airborne) {
    ctx.save(); ctx.rotate((d.hdg + d.drift) * DEG); ctx.strokeStyle = C.green; ctx.lineWidth = Math.max(1.5, u * 0.4);
    ctx.beginPath(); ctx.moveTo(0, -hr + u * 0.3); ctx.lineTo(u * 1, -hr + u * 1.8); ctx.lineTo(0, -hr + u * 3.3); ctx.lineTo(-u * 1, -hr + u * 1.8); ctx.closePath(); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = C.black; ctx.strokeStyle = C.white;
  ctx.beginPath(); ctx.rect(hcx - u * 5, y + h * 0.755, u * 10, u * 5); ctx.fill(); ctx.stroke();
  text(ctx, String(Math.round((d.hdg + 360) % 360) || 360).padStart(3, '0'), hcx, y + h * 0.755 + u * 2.6, u * 3.8);
  // Wind: arrow relative to the nose, direction / speed.
  if (airborne && d.windKt >= 2) {
    const wcx = x + w * 0.1, wcy = y + h * 0.86, rel = (d.windDir + 180 - d.trueHdg) * DEG, L = u * 3;
    ctx.save(); ctx.translate(wcx, wcy); ctx.rotate(rel); ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.4);
    ctx.beginPath(); ctx.moveTo(0, L); ctx.lineTo(0, -L); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -L - u * 0.5); ctx.lineTo(-u, -L + u); ctx.lineTo(u, -L + u); ctx.fill(); ctx.restore();
    text(ctx, `${String(Math.round(d.windDir) % 360 || 360).padStart(3, '0')}/${Math.round(d.windKt)}`, wcx, wcy + u * 6, u * 2.8, C.white);
  }
  // Mode strip: the assistance level the "autoflight" is really doing.
  ctx.fillStyle = '#101418'; ctx.fillRect(x + w * 0.2, y + 0.6 * u, w * 0.56, 6 * u);
  ctx.strokeStyle = '#2b323b'; ctx.lineWidth = 1;
  for (const f of [0.38, 0.58]) { ctx.beginPath(); ctx.moveTo(x + w * f, y + u); ctx.lineTo(x + w * f, y + 6.2 * u); ctx.stroke(); }
  const thrMode = d.wow && d.thrLever > 0.9 ? 'TO' : d.thrLever > 0.9 ? 'MAX' : d.thrLever < 0.05 ? 'IDLE' : 'MAN';
  text(ctx, thrMode, x + w * 0.29, y + 3.6 * u, u * 3.0, C.green);
  text(ctx, d.assist.split(' · ')[0], x + w * 0.48, y + 3.6 * u, u * 3.0, C.green);
  text(ctx, vs.phase === 'APP' ? 'APPR' : vs.phase === 'TO' ? 'TO' : d.assist.split(' · ')[1] || 'HDG', x + w * 0.67, y + 3.6 * u, u * 2.6, C.white);
  ctx.restore();
}

// ---------------------------------------------------------- engine display ----
function n1Dial(ctx, cx, cy, r, n1, cmd, running, u, limit) {
  const a = (p) => (-210 + clamp(p, 0, 110) / 110 * 240) * DEG;
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.35);
  ctx.beginPath(); ctx.arc(cx, cy, r, a(0), a(100)); ctx.stroke();
  ctx.strokeStyle = C.red; ctx.beginPath(); ctx.arc(cx, cy, r, a(100), a(105)); ctx.stroke();
  for (let p = 0; p <= 100; p += 20) {
    const aa = a(p);
    ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, u * 0.25);
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(aa) * r, cy + Math.sin(aa) * r); ctx.lineTo(cx + Math.cos(aa) * (r - u * 1.4), cy + Math.sin(aa) * (r - u * 1.4)); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(242,244,246,.12)';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a(0), a(n1)); ctx.closePath(); ctx.fill();
  // Thrust-rating limit (amber tick).
  const al = a(limit);
  ctx.strokeStyle = C.amber; ctx.lineWidth = Math.max(2, u * 0.6);
  ctx.beginPath(); ctx.moveTo(cx + Math.cos(al) * (r - u * 1.5), cy + Math.sin(al) * (r - u * 1.5)); ctx.lineTo(cx + Math.cos(al) * (r + u * 1.5), cy + Math.sin(al) * (r + u * 1.5)); ctx.stroke();
  ctx.strokeStyle = n1 > 100 ? C.red : running ? C.white : C.amber; ctx.lineWidth = Math.max(2, u * 0.6);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a(n1)) * r * 0.95, cy + Math.sin(a(n1)) * r * 0.95); ctx.stroke();
  // Commanded N1 (thrust lever) caret.
  ctx.fillStyle = C.cyan; const ac = a(cmd);
  ctx.beginPath(); ctx.arc(cx + Math.cos(ac) * r * 1.08, cy + Math.sin(ac) * r * 1.08, u * 0.9, 0, 7); ctx.fill();
  box(ctx, cx - u * 1, cy - r * 0.05, r * 1.0, u * 6.4, C.white, C.black, 1);
  text(ctx, n1.toFixed(1), cx + r * 0.45, cy - r * 0.05 + u * 3.2, u * 4.2, n1 > 100 ? C.red : running ? C.green : C.amber, 'center');
}

const CAS_COL = [C.white, C.cyan, C.amber, C.red];
export function drawEICAS(ctx, x, y, w, h, d) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = C.black; ctx.fillRect(x, y, w, h);
  const u = h / 100;
  const cas = casMessages(d);
  // Thrust rating for the N1 limit: take-off on the ground, climb below FL280, cruise above.
  const [rating, limit] = d.wow || d.ra < 1500 ? ['TO', 100] : d.alt < 28000 ? ['CLB', 96.5] : ['CRZ', 93];
  text(ctx, 'N1', x + w * 0.5, y + 6 * u, u * 3.4, C.grey);
  text(ctx, `${rating} ${limit.toFixed(1)}`, x + w * 0.97, y + 4 * u, u * 2.8, C.green, 'right');
  text(ctx, `SAT ${Math.round(d.sat)}°C`, x + w * 0.03, y + 4 * u, u * 2.6, C.white, 'left');
  for (let i = 0; i < 2; ++i) n1Dial(ctx, x + w * (i ? 0.72 : 0.28), y + 21 * u, 12 * u, d.n1[i], d.n1cmd, d.run[i], u, limit);
  const row = (label, vals, yy, fmt, color = C.green) => {
    text(ctx, label, x + w * 0.5, yy, u * 2.9, C.grey);
    vals.forEach((v, i) => text(ctx, fmt(v, i), x + w * (i ? 0.72 : 0.28), yy, u * 3.6, typeof color === 'function' ? color(v, i) : color));
  };
  row('ITT °C', d.itt, y + 39 * u, (v) => String(Math.round(v)), (v) => (v > 900 ? C.red : v > 860 ? C.amber : C.green));
  row('N2 %', d.n2, y + 45 * u, (v) => v.toFixed(1), (v) => (v > 102 ? C.red : C.green));
  row('FF PPH', d.ff, y + 51 * u, (v) => String(Math.round(v * LB / 10) * 10));
  row('OIL PSI', d.oil, y + 57 * u, (v) => String(Math.round(v)), (v, i) => (d.run[i] && v < 25 ? C.red : C.green));
  ctx.strokeStyle = '#2b323b'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + w * 0.03, y + 61 * u); ctx.lineTo(x + w * 0.97, y + 61 * u); ctx.stroke();
  // Fuel, weight, trim.
  const ffTot = (d.ff[0] + d.ff[1]) * LB;
  text(ctx, `FUEL ${(Math.round(d.fuelKg * LB / 10) * 10).toLocaleString('en-US')} LB`, x + w * 0.03, y + 65 * u, u * 2.9, d.fuelKg < 1500 ? C.amber : C.white, 'left');
  text(ctx, `GW ${(Math.round(d.gw * LB / 100) * 100).toLocaleString('en-US')}`, x + w * 0.97, y + 65 * u, u * 2.9, C.white, 'right');
  text(ctx, `FF ${(Math.round(ffTot / 10) * 10).toLocaleString('en-US')} PPH`, x + w * 0.03, y + 70 * u, u * 2.7, C.grey, 'left');
  const trimDeg = (d.trim || 0) * 14;
  text(ctx, `TRIM ${Math.abs(trimDeg).toFixed(1)} ${trimDeg >= 0 ? 'NU' : 'ND'}`, x + w * 0.97, y + 70 * u, u * 2.7, C.grey, 'right');
  // Gear, flaps, speedbrake.
  const gx = x + w * 0.04, gy = y + 74 * u;
  const gState = d.gear > 0.999 ? 'DN' : d.gear < 0.001 ? 'UP' : '';
  for (let k = 0; k < 3; ++k) {
    const bx = gx + (k === 0 ? 3.5 : k === 1 ? 0 : 7) * u, by = gy + (k === 0 ? 1 : 6) * u;
    const col = gState === 'DN' ? C.green : gState === 'UP' ? C.dim : C.amber;
    box(ctx, bx, by, 4 * u, 4 * u, col, gState === 'DN' ? 'rgba(56,210,106,.15)' : null, 1.5);
    text(ctx, gState || '··', bx + 2 * u, by + 2.1 * u, u * 2.1, col);
  }
  text(ctx, 'GEAR', gx + 5.5 * u, gy + 13 * u, u * 2.3, C.grey);
  const fx = x + w * 0.24;
  box(ctx, fx, gy + 2 * u, 11 * u, 2 * u, C.dim, null, 1);
  ctx.fillStyle = C.white; ctx.fillRect(fx, gy + 2 * u, 11 * u * clamp(d.flaps / (d.ldgFlap || 39), 0, 1), 2 * u);
  text(ctx, String(Math.round(d.flaps)), fx + 5.5 * u, gy + 8 * u, u * 3.4, d.flaps > 0.5 ? C.white : C.grey);
  text(ctx, 'FLAPS', fx + 5.5 * u, gy + 13 * u, u * 2.3, C.grey);
  const bx2 = x + w * 0.44;
  box(ctx, bx2, gy + 2 * u, 11 * u, 2 * u, C.dim, null, 1);
  ctx.fillStyle = d.spd > 0.02 ? C.amber : C.dim; ctx.fillRect(bx2, gy + 2 * u, 11 * u * d.spd, 2 * u);
  text(ctx, d.spd > 0.02 ? 'EXT' : 'RET', bx2 + 5.5 * u, gy + 8 * u, u * 3, d.spd > 0.02 ? C.amber : C.grey);
  text(ctx, 'SPD BRK', bx2 + 5.5 * u, gy + 13 * u, u * 2.3, C.grey);
  // Crew alerting window: the most urgent first.
  const cx0 = x + w * 0.6, cw = w * 0.38;
  box(ctx, cx0, y + 73 * u, cw, 26 * u, '#2b323b', null, 1);
  cas.slice(0, 5).forEach(([m, lvl], k) => {
    const yy = y + (76.5 + k * 4.9) * u;
    if (lvl === 3) { ctx.fillStyle = C.red; ctx.fillRect(cx0 + u * 0.4, yy - u * 2.2, cw - u * 0.8, u * 4.4); }
    text(ctx, m, cx0 + u * 1.2, yy, u * 2.7, lvl === 3 ? C.white : CAS_COL[lvl], 'left', MONO, 700);
  });
  if (cas.length > 5) text(ctx, `+${cas.length - 5}`, cx0 + cw - u, y + 97 * u, u * 2.4, C.grey, 'right');
  ctx.restore();
}

// --------------------------------------------------------------- map ----
export function drawND(ctx, x, y, w, h, d) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = C.black; ctx.fillRect(x, y, w, h);
  const u = h / 100, cx = x + w / 2, cy = y + h * 0.78, R = h * 0.66;
  const rangeM = d.rangeNm * 1852;
  ctx.save(); ctx.translate(cx, cy);
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, u * 0.3);
  ctx.beginPath(); ctx.arc(0, 0, R, (-90 - 60) * DEG, (-90 + 60) * DEG); ctx.stroke();
  ctx.setLineDash([u, u * 1.5]); ctx.beginPath(); ctx.arc(0, 0, R / 2, (-90 - 60) * DEG, (-90 + 60) * DEG); ctx.stroke(); ctx.setLineDash([]);
  text(ctx, String(d.rangeNm / 2), -R / 2 * Math.sin(55 * DEG) - u * 2, -R / 2 * Math.cos(55 * DEG), u * 2.6, C.grey);
  const hdg = d.hdg;
  for (let k = 0; k < 360; k += 10) {
    const rel = ((k - hdg + 540) % 360) - 180;
    if (Math.abs(rel) > 62) continue;
    const a = (rel - 90) * DEG;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R - u * (k % 30 ? 1.5 : 3)), Math.sin(a) * (R - u * (k % 30 ? 1.5 : 3))); ctx.stroke();
    if (k % 30 === 0) text(ctx, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[k] ?? String(k / 10), Math.cos(a) * (R - u * 6), Math.sin(a) * (R - u * 6), u * 3);
  }
  // Heading pointer and the selected-heading bug on the arc.
  ctx.fillStyle = C.white; ctx.beginPath(); ctx.moveTo(0, -R - u * 0.2); ctx.lineTo(-u * 1.4, -R - u * 2.6); ctx.lineTo(u * 1.4, -R - u * 2.6); ctx.fill();
  const relBug = ((d.bug - hdg + 540) % 360) - 180;
  if (Math.abs(relBug) < 62) { ctx.save(); ctx.rotate(relBug * DEG); ctx.fillStyle = C.cyan; ctx.fillRect(-u * 1.2, -R - u * 0.4, u * 2.4, u * 1.4); ctx.restore(); }
  // Track line.
  if (!d.wow && d.tas > 40) {
    ctx.save(); ctx.rotate(clamp(d.drift, -60, 60) * DEG);
    ctx.strokeStyle = C.green; ctx.lineWidth = Math.max(1, u * 0.3); ctx.setLineDash([u * 1.5, u]);
    ctx.beginPath(); ctx.moveTo(0, -u * 3.5); ctx.lineTo(0, -R); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  }
  // Waypoints: the landmarks and the runway, relative to the aircraft (true north-up rotated to the heading).
  const th = d.trueHdg * DEG;
  const put = (e, n) => {
    const de = e - d.x, dn = n - d.y;
    const right = de * Math.cos(th) - dn * Math.sin(th), fwd = de * Math.sin(th) + dn * Math.cos(th);
    return [right / rangeM * R, -fwd / rangeM * R, Math.hypot(right, fwd)];
  };
  let rwInfo = '';
  if (d.runway) {
    const [e0, n0, , hdgRw, len] = d.runway;
    const e1 = e0 + Math.sin(hdgRw * DEG) * len, n1 = n0 + Math.cos(hdgRw * DEG) * len;
    const [ax, ay, dist] = put(e0, n0), [bx, by] = put(e1, n1);
    ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(2, u * 0.8);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 1; ctx.setLineDash([u, u]);
    const ex = e0 - Math.sin(hdgRw * DEG) * 10 * 1852, ny = n0 - Math.cos(hdgRw * DEG) * 10 * 1852;
    const [fx, fy] = put(ex, ny);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(fx, fy); ctx.stroke(); ctx.setLineDash([]);
    text(ctx, 'SBMT', ax + u * 3, ay, u * 2.8, C.cyan, 'left');
    const brg = (Math.atan2(e0 - d.x, n0 - d.y) / DEG - d.trueHdg + hdg + 720) % 360;
    rwInfo = `SBMT ${String(Math.round(brg) % 360 || 360).padStart(3, '0')}° ${(dist / 1852).toFixed(1)} NM`;
  }
  for (const [name, e, n] of d.points || []) {
    const [px, py, dist] = put(e, n);
    if (dist > rangeM * 1.05 || py > u * 8) continue;
    ctx.strokeStyle = C.magenta; ctx.lineWidth = Math.max(1, u * 0.35);
    ctx.beginPath(); ctx.moveTo(px, py - u); ctx.lineTo(px + u, py); ctx.lineTo(px, py + u); ctx.lineTo(px - u, py); ctx.closePath(); ctx.stroke();
    text(ctx, name.toUpperCase().slice(0, 10), px + u * 1.8, py, u * 2.3, C.magenta, 'left');
  }
  // Own ship.
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(2, u * 0.5);
  ctx.beginPath(); ctx.moveTo(0, -u * 3); ctx.lineTo(0, u * 3); ctx.moveTo(-u * 2.5, 0); ctx.lineTo(u * 2.5, 0); ctx.moveTo(-u * 1.2, u * 2.6); ctx.lineTo(u * 1.2, u * 2.6); ctx.stroke();
  ctx.restore();
  text(ctx, `GS ${Math.round(d.gs)}  TAS ${Math.round(d.tas)}`, x + u * 2, y + u * 4, u * 3, C.white, 'left');
  if (!d.wow && d.windKt >= 2) {
    text(ctx, `${String(Math.round(d.windDir) % 360 || 360).padStart(3, '0')}°/${Math.round(d.windKt)}`, x + u * 2, y + u * 8.5, u * 2.8, C.white, 'left');
    const rel = (d.windDir + 180 - d.trueHdg) * DEG, wx = x + u * 17, wy = y + u * 8.5;
    ctx.save(); ctx.translate(wx, wy); ctx.rotate(rel); ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.35);
    ctx.beginPath(); ctx.moveTo(0, u * 2); ctx.lineTo(0, -u * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -u * 2.6); ctx.lineTo(-u * 0.9, -u * 1.2); ctx.lineTo(u * 0.9, -u * 1.2); ctx.fill(); ctx.restore();
  }
  text(ctx, `HDG ${String(Math.round((hdg + 360) % 360)).padStart(3, '0')}`, x + w - u * 2, y + u * 4, u * 3, C.green, 'right');
  if (rwInfo) text(ctx, rwInfo, x + u * 2, y + h - u * 4, u * 2.6, C.cyan, 'left');
  text(ctx, `${d.rangeNm} NM`, x + w - u * 2, y + h - u * 4, u * 2.8, C.grey, 'right');
  ctx.restore();
}

// The 2D instrument strip: PFD, map and engines side by side.
// Displays run off the main bus: dark (with their bezels) when it is dead.
const powered = (d) => d.volts === undefined || d.volts > 18;
function dark(ctx, x, y, w, h) { ctx.fillStyle = '#050607'; ctx.fillRect(x, y, w, h); }
export function drawJetStrip(ctx, w, h, d) {
  ctx.clearRect(0, 0, w, h);
  const on = powered(d);
  const show = (fn, x, y, ww, hh) => (on ? fn(ctx, x, y, ww, hh, d) : dark(ctx, x, y, ww, hh));
  const pad = 4, gap = 6;
  if (w / h > 3.2) {
    // PFD, map, engines at their natural proportions, centred.
    const ih = h - 2 * pad;
    let pw = ih * 1.35, nw = ih * 1.3, ew = ih * 1.0;
    const k = Math.min(1, (w - 2 * pad - 2 * gap) / (pw + nw + ew));
    pw *= k; nw *= k; ew *= k;
    const x0 = (w - (pw + nw + ew + 2 * gap)) / 2;
    show(drawPFD, x0, pad, pw, ih);
    show(drawND, x0 + pw + gap, pad, nw, ih);
    show(drawEICAS, x0 + pw + nw + 2 * gap, pad, ew, ih);
  } else {
    const pw = (w - gap - 2 * pad) * 0.6;
    show(drawPFD, pad, pad, pw, h - 2 * pad);
    show(drawEICAS, pad + pw + gap, pad, w - pw - gap - 2 * pad, h - 2 * pad);
  }
}

// The 3D flight deck's main panel texture (metres: 1.90 x 0.52): four
// displays — pilot PFD, map, engines, copilot PFD — in a dark panel, with the
// standby instrument, master warning/caution and the gear indication under them.
export const JET_PANEL_W = 1.9, JET_PANEL_H = 0.52;
export function drawJetPanel(ctx, W, H, d) {
  const P = W / JET_PANEL_W, X = (m) => m * P;
  const on = powered(d);
  const show = (fn, x, y, ww, hh) => (on ? fn(ctx, x, y, ww, hh, d) : dark(ctx, x, y, ww, hh));
  ctx.fillStyle = '#1b1d21'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#25282d'; ctx.fillRect(0, X(0.36), W, H - X(0.36));
  const dw = 0.36, dh = 0.27, top = 0.05;
  const xs = [0.1, 0.52, 1.02, 1.44];
  for (const x0 of xs) { ctx.fillStyle = '#0a0b0c'; ctx.fillRect(X(x0 - 0.015), X(top - 0.015), X(dw + 0.03), X(dh + 0.03)); }
  show(drawPFD, X(xs[0]), X(top), X(dw), X(dh));
  show(drawND, X(xs[1]), X(top), X(dw), X(dh));
  show(drawEICAS, X(xs[2]), X(top), X(dw), X(dh));
  show(drawPFD, X(xs[3]), X(top), X(dw), X(dh));
  // Placards and labels under the displays.
  text(ctx, 'TOP G', X(0.95), X(0.345), X(0.016), '#c9ccd1', 'center', SANS, 800);
  text(ctx, 'LANDING GEAR', X(0.93), X(0.395), X(0.009), '#c9ccd1', 'center', SANS, 700);
  text(ctx, d.gear > 0.999 ? 'DOWN' : d.gear < 0.001 ? 'UP' : 'TRANSIT', X(0.93), X(0.47), X(0.011), d.gear > 0.999 ? C.green : d.gear < 0.001 ? C.grey : C.amber, 'center', MONO, 700);
  // Master warning / caution: lit (warning flashing) while a message of that level is up.
  const cas = on ? casMessages(d) : [], warn = cas.some((m) => m[1] === 3), caut = cas.some((m) => m[1] === 2);
  const flash = (performance.now() % 1000) < 600;
  for (const [lbl, xx, isWarn] of [['MASTER WARN', 0.08, true], ['MASTER CAUT', 0.2, false], ['MASTER WARN', 1.62, true], ['MASTER CAUT', 1.74, false]]) {
    const lit = isWarn ? warn && flash : caut;
    ctx.fillStyle = lit ? (isWarn ? '#ff3b30' : '#f2b33a') : '#2e3136'; ctx.fillRect(X(xx), X(0.4), X(0.09), X(0.035));
    text(ctx, lbl, X(xx + 0.045), X(0.4175), X(0.008), lit ? '#1b0000' : '#7c818a', 'center', SANS, 800);
  }
  if (d.volts === undefined || d.volts > 10) drawStandby(ctx, X(0.66), X(0.365), X(0.13), X(0.13), d);
  else dark(ctx, X(0.66), X(0.365), X(0.13), X(0.13));
}

// Standby instrument: attitude with speed and altitude, from its own gyro
// (here the same attitude reference) and the standby pitot-static.
function drawStandby(ctx, x, y, w, h, d) {
  ctx.save();
  ctx.fillStyle = '#0a0b0c'; ctx.fillRect(x - w * 0.04, y - w * 0.04, w * 1.08, h * 1.08);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const u = h / 100, cx = x + w / 2, cy = y + h / 2, ppd = h / 50;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-d.roll * DEG); ctx.translate(0, d.pitch * ppd);
  ctx.fillStyle = C.sky; ctx.fillRect(-w * 3, -w * 3, w * 6, w * 3);
  ctx.fillStyle = C.ground; ctx.fillRect(-w * 3, 0, w * 6, w * 3);
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, u * 0.6);
  ctx.beginPath(); ctx.moveTo(-w, 0); ctx.lineTo(w, 0); ctx.stroke();
  for (const p of [-20, -10, 10, 20]) { ctx.beginPath(); ctx.moveTo(-w * 0.1, -p * ppd); ctx.lineTo(w * 0.1, -p * ppd); ctx.stroke(); }
  ctx.restore();
  ctx.strokeStyle = C.yellow; ctx.lineWidth = Math.max(1.5, u * 1.2);
  ctx.beginPath(); ctx.moveTo(cx - w * 0.22, cy); ctx.lineTo(cx - w * 0.08, cy); ctx.moveTo(cx + w * 0.08, cy); ctx.lineTo(cx + w * 0.22, cy); ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(x, y, w * 0.26, h); ctx.fillRect(x + w * 0.74, y, w * 0.26, h);
  text(ctx, String(Math.round(Math.max(d.ias, 0))), x + w * 0.13, cy, u * 9, C.white);
  text(ctx, 'KT', x + w * 0.13, cy + u * 12, u * 6, C.grey);
  text(ctx, String(Math.round(d.alt / 20) * 20), x + w * 0.87, cy, u * 7.5, C.white);
  text(ctx, 'FT', x + w * 0.87, cy + u * 12, u * 6, C.grey);
  text(ctx, std(d.baro), x + w / 2, y + h - u * 7, u * 6.5, C.cyan);
  ctx.restore();
}
const std = (b) => (Math.abs(b - 29.92) < 0.005 ? 'STD' : b.toFixed(2));
