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

// ---------------------------------------------------------------- PFD ----
export function drawPFD(ctx, x, y, w, h, d) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = C.black; ctx.fillRect(x, y, w, h);
  const u = h / 100;  // layout unit
  // Attitude.
  const ax = x + w * 0.2, aw = w * 0.56, ay = y + 8 * u, ah = h * 0.64;
  const cx = ax + aw / 2, cy = ay + ah * 0.48, ppd = ah / 42;
  ctx.save();
  ctx.beginPath(); ctx.rect(ax, ay, aw, ah); ctx.clip();
  ctx.translate(cx, cy); ctx.rotate(-d.roll * DEG); ctx.translate(0, d.pitch * ppd);
  const big = Math.max(aw, ah) * 3;
  ctx.fillStyle = C.sky; ctx.fillRect(-big, -big, 2 * big, big);
  ctx.fillStyle = C.ground; ctx.fillRect(-big, 0, 2 * big, big);
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.35);
  ctx.beginPath(); ctx.moveTo(-big, 0); ctx.lineTo(big, 0); ctx.stroke();
  for (let p = -90; p <= 90; p += 2.5) {
    if (!p) continue;
    const yy = -p * ppd, major = p % 10 === 0, mid = p % 5 === 0;
    if (Math.abs(p - d.pitch) > 24) continue;
    const l = major ? aw * 0.16 : mid ? aw * 0.08 : aw * 0.04;
    ctx.lineWidth = major ? Math.max(1.5, u * 0.3) : Math.max(1, u * 0.2);
    ctx.beginPath(); ctx.moveTo(-l, yy); ctx.lineTo(l, yy); ctx.stroke();
    if (major) { text(ctx, String(Math.abs(p)), -l - u * 3, yy, u * 3.2); text(ctx, String(Math.abs(p)), l + u * 3, yy, u * 3.2); }
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
  // Radio altitude.
  if (d.agl < 2500) text(ctx, String(Math.round(d.agl / 10) * 10), cx, ay + ah * 0.88, u * 4.2, d.agl < 200 ? C.amber : C.green);
  if (d.stall) { box(ctx, cx - u * 9, ay + ah * 0.62, u * 18, u * 6, null, C.red); text(ctx, 'STALL', cx, ay + ah * 0.62 + u * 3, u * 4.5, C.white, 'center', SANS, 800); }

  // Speed tape.
  const sx = x + w * 0.03, sw = w * 0.13, sy = ay, sh = ah, scy = sy + sh * 0.48, ppk = sh / 90;
  box(ctx, sx, sy, sw, sh, null, 'rgba(70,80,95,.55)');
  ctx.save(); ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, u * 0.25);
  const v = Math.max(d.ias, 30);
  for (let k = Math.floor((v - 50) / 10) * 10; k <= v + 50; k += 10) {
    if (k < 30) continue;
    const yy = scy - (k - v) * ppk;
    ctx.beginPath(); ctx.moveTo(sx + sw, yy); ctx.lineTo(sx + sw - u * 2, yy); ctx.stroke();
    if (k % 20 === 0) text(ctx, String(k), sx + sw - u * 3.5, yy, u * 3.4, C.white, 'right');
  }
  // Barber pole: the lower of Vmo and the Mmo speed at this altitude.
  const mmoIas = d.mach > 0.1 ? d.ias * d.mmo / d.mach : 1e9;
  const vmax = Math.min(d.vmo, mmoIas);
  const yMax = scy - (vmax - v) * ppk;
  if (yMax > sy) {
    for (let yy = sy; yy < yMax; yy += u * 2) { ctx.fillStyle = Math.floor((yy - sy) / (u * 2)) % 2 ? C.red : C.black; ctx.fillRect(sx + sw - u * 1.6, yy, u * 1.6, Math.min(u * 2, yMax - yy)); }
  }
  ctx.restore();
  // Current-speed window.
  ctx.fillStyle = C.black; ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.3);
  ctx.beginPath(); ctx.rect(sx + u * 0.5, scy - u * 3.6, sw - u * 1.5, u * 7.2); ctx.fill(); ctx.stroke();
  text(ctx, String(Math.round(Math.max(d.ias, 0))), sx + sw - u * 2.2, scy, u * 5, d.ias > vmax ? C.red : C.white, 'right');
  if (d.mach >= 0.4) text(ctx, 'M .' + String(Math.round(d.mach * 1000)).padStart(3, '0'), sx + sw / 2, sy + sh + u * 4, u * 3.6, C.green);
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
  ctx.restore();
  ctx.fillStyle = C.black; ctx.strokeStyle = C.white;
  ctx.beginPath(); ctx.rect(tx + u * 0.5, tcy - u * 3.6, tw - u, u * 7.2); ctx.fill(); ctx.stroke();
  text(ctx, String(Math.round(d.alt / 10) * 10), tx + tw - u * 1.6, tcy, u * 4.6, C.white, 'right');
  text(ctx, `${d.baro.toFixed(2)} IN`, tx + tw / 2, sy + sh + u * 4, u * 3.2, C.cyan);
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

  // Heading arc.
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
  ctx.restore();
  ctx.fillStyle = C.black; ctx.strokeStyle = C.white;
  ctx.beginPath(); ctx.rect(hcx - u * 5, y + h * 0.755, u * 10, u * 5); ctx.fill(); ctx.stroke();
  text(ctx, String(Math.round((d.hdg + 360) % 360) || 360).padStart(3, '0'), hcx, y + h * 0.755 + u * 2.6, u * 3.8);
  // Mode strip: the assistance level the "autoflight" is really doing.
  text(ctx, d.assist, x + w * 0.5, y + 4 * u, u * 3.2, C.green);
  ctx.restore();
}

// ---------------------------------------------------------- engine display ----
function n1Dial(ctx, cx, cy, r, n1, cmd, running, u) {
  const a = (p) => (-210 + clamp(p, 0, 110) / 110 * 240) * DEG;
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1.5, u * 0.35);
  ctx.beginPath(); ctx.arc(cx, cy, r, a(0), a(100)); ctx.stroke();
  ctx.strokeStyle = C.red; ctx.beginPath(); ctx.arc(cx, cy, r, a(100), a(105)); ctx.stroke();
  ctx.fillStyle = 'rgba(242,244,246,.12)';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a(0), a(n1)); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = running ? C.white : C.amber; ctx.lineWidth = Math.max(2, u * 0.6);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a(n1)) * r * 0.95, cy + Math.sin(a(n1)) * r * 0.95); ctx.stroke();
  // Commanded N1 (thrust lever) caret.
  ctx.fillStyle = C.cyan; const ac = a(cmd);
  ctx.beginPath(); ctx.arc(cx + Math.cos(ac) * r * 1.08, cy + Math.sin(ac) * r * 1.08, u * 0.9, 0, 7); ctx.fill();
  box(ctx, cx - u * 1, cy - r * 0.05, r * 1.0, u * 6.4, C.white, C.black, 1);
  text(ctx, n1.toFixed(1), cx + r * 0.45, cy - r * 0.05 + u * 3.2, u * 4.2, running ? C.green : C.amber, 'center');
}

export function drawEICAS(ctx, x, y, w, h, d) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = C.black; ctx.fillRect(x, y, w, h);
  const u = h / 100;
  text(ctx, 'N1', x + w * 0.5, y + 6 * u, u * 3.4, C.grey);
  for (let i = 0; i < 2; ++i) n1Dial(ctx, x + w * (i ? 0.72 : 0.28), y + 22 * u, 13 * u, d.n1[i], d.n1cmd, d.run[i], u);
  const row = (label, vals, yy, fmt, color = C.green) => {
    text(ctx, label, x + w * 0.5, yy, u * 3, C.grey);
    vals.forEach((v, i) => text(ctx, fmt(v, i), x + w * (i ? 0.72 : 0.28), yy, u * 3.8, typeof color === 'function' ? color(v, i) : color));
  };
  row('ITT °C', d.itt, y + 44 * u, (v) => String(Math.round(v)), (v) => (v > 880 ? C.red : v > 840 ? C.amber : C.green));
  row('N2 %', d.n2, y + 51 * u, (v) => v.toFixed(1));
  row('FF PPH', d.ff, y + 58 * u, (v) => String(Math.round(v * LB / 10) * 10));
  row('OIL PSI', d.oil, y + 65 * u, (v) => String(Math.round(v)), (v, i) => (d.run[i] && v < 25 ? C.red : C.green));
  // Fuel, gear, flaps, speedbrake, trim.
  text(ctx, `FUEL ${Math.round(d.fuelKg * LB / 10) * 10} LB`, x + w * 0.5, y + 73 * u, u * 3.4, d.fuelKg < 1000 ? C.amber : C.white);
  const gx = x + w * 0.12, gy = y + 79 * u;
  text(ctx, 'GEAR', gx + 7 * u, gy + 1 * u, u * 2.6, C.grey);
  const gState = d.gear > 0.999 ? 'DN' : d.gear < 0.001 ? 'UP' : '';
  for (let k = 0; k < 3; ++k) {
    const bx = gx + (k === 0 ? 4.5 : k === 1 ? 0 : 9) * u, by = gy + (k === 0 ? 3 : 9) * u;
    const col = gState === 'DN' ? C.green : gState === 'UP' ? C.dim : C.amber;
    box(ctx, bx, by, 5 * u, 5 * u, col, gState === 'DN' ? 'rgba(56,210,106,.15)' : null, 1.5);
    text(ctx, gState || '··', bx + 2.5 * u, by + 2.6 * u, u * 2.4, col);
  }
  const fx = x + w * 0.45;
  text(ctx, 'FLAPS', fx + 6 * u, gy + 1 * u, u * 2.6, C.grey);
  box(ctx, fx, gy + 4 * u, 12 * u, 2 * u, C.dim, null, 1);
  ctx.fillStyle = C.white; ctx.fillRect(fx, gy + 4 * u, 12 * u * clamp(d.flaps / 39, 0, 1), 2 * u);
  text(ctx, String(Math.round(d.flaps)), fx + 6 * u, gy + 10 * u, u * 3.6, d.flaps > 0.5 ? C.white : C.grey);
  const bx2 = x + w * 0.74;
  text(ctx, 'SPD BRK', bx2 + 6 * u, gy + 1 * u, u * 2.6, C.grey);
  box(ctx, bx2, gy + 4 * u, 12 * u, 2 * u, C.dim, null, 1);
  ctx.fillStyle = d.spd > 0.02 ? C.amber : C.dim; ctx.fillRect(bx2, gy + 4 * u, 12 * u * d.spd, 2 * u);
  text(ctx, d.spd > 0.02 ? 'EXT' : 'RET', bx2 + 6 * u, gy + 10 * u, u * 3.2, d.spd > 0.02 ? C.amber : C.grey);
  // Crew alerting.
  const msgs = [];
  for (let i = 0; i < 2; ++i) {
    if (d.fuelSw[i] && !d.run[i] && !d.starting[i]) msgs.push([`${i ? 'R' : 'L'} ENGINE FAIL`, C.red]);
    if (d.starting[i]) msgs.push([`${i ? 'R' : 'L'} ENGINE START`, C.white]);
    if (!d.fuelSw[i] && !d.run[i]) msgs.push([`${i ? 'R' : 'L'} ENGINE OFF`, C.amber]);
  }
  if (d.flaps > 25 && d.gear < 0.99 && !d.wow) msgs.push(['GEAR NOT DOWN', C.red]);
  if (d.spd > 0.02 && d.flaps > 25) msgs.push(['SPEEDBRAKE', C.amber]);
  if (d.park) msgs.push(['PARKING BRAKE', C.cyan]);
  msgs.slice(0, 3).forEach(([m, col], k) => text(ctx, m, x + w * 0.04, y + (93 + k * 0) * u - (msgs.length > 1 ? 0 : 0), u * 3.1, col, 'left'));
  if (msgs.length) {
    ctx.fillStyle = C.black; ctx.fillRect(x, y + 90 * u, w, 10 * u);
    msgs.slice(0, 2).forEach(([m, col], k) => text(ctx, m, x + w * 0.04 + k * w * 0.5, y + 95 * u, u * 3.1, col, 'left'));
  }
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
  // Waypoints: the landmarks and the runway, relative to the aircraft (true north-up rotated to the heading).
  const th = d.trueHdg * DEG;
  const put = (e, n) => {
    const de = e - d.x, dn = n - d.y;
    const right = de * Math.cos(th) - dn * Math.sin(th), fwd = de * Math.sin(th) + dn * Math.cos(th);
    return [right / rangeM * R, -fwd / rangeM * R, Math.hypot(right, fwd)];
  };
  if (d.runway) {
    const [e0, n0, , hdgRw, len] = d.runway;
    const e1 = e0 + Math.sin(hdgRw * DEG) * len, n1 = n0 + Math.cos(hdgRw * DEG) * len;
    const [ax, ay] = put(e0, n0), [bx, by] = put(e1, n1);
    ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(2, u * 0.8);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 1; ctx.setLineDash([u, u]);
    const ex = e0 - Math.sin(hdgRw * DEG) * 10 * 1852, ny = n0 - Math.cos(hdgRw * DEG) * 10 * 1852;
    const [fx, fy] = put(ex, ny);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(fx, fy); ctx.stroke(); ctx.setLineDash([]);
    text(ctx, 'SBMT', ax + u * 3, ay, u * 2.8, C.cyan, 'left');
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
  text(ctx, `HDG ${String(Math.round((hdg + 360) % 360)).padStart(3, '0')}`, x + w - u * 2, y + u * 4, u * 3, C.green, 'right');
  text(ctx, `${d.rangeNm} NM`, x + w - u * 2, y + h - u * 4, u * 2.8, C.grey, 'right');
  ctx.restore();
}

// The 2D instrument strip: PFD, map and engines side by side.
export function drawJetStrip(ctx, w, h, d) {
  ctx.clearRect(0, 0, w, h);
  const pad = 4, gap = 6;
  if (w / h > 3.2) {
    // PFD, map, engines at their natural proportions, centred.
    const ih = h - 2 * pad;
    let pw = ih * 1.35, nw = ih * 1.3, ew = ih * 1.0;
    const k = Math.min(1, (w - 2 * pad - 2 * gap) / (pw + nw + ew));
    pw *= k; nw *= k; ew *= k;
    const x0 = (w - (pw + nw + ew + 2 * gap)) / 2;
    drawPFD(ctx, x0, pad, pw, ih, d);
    drawND(ctx, x0 + pw + gap, pad, nw, ih, d);
    drawEICAS(ctx, x0 + pw + nw + 2 * gap, pad, ew, ih, d);
  } else {
    const pw = (w - gap - 2 * pad) * 0.6;
    drawPFD(ctx, pad, pad, pw, h - 2 * pad, d);
    drawEICAS(ctx, pad + pw + gap, pad, w - pw - gap - 2 * pad, h - 2 * pad, d);
  }
}

// The 3D flight deck's main panel texture (metres: 1.90 x 0.52): four
// displays — pilot PFD, map, engines, copilot PFD — in a dark panel, with the
// standby attitude and gear/brake placards under them.
export const JET_PANEL_W = 1.9, JET_PANEL_H = 0.52;
export function drawJetPanel(ctx, W, H, d) {
  const P = W / JET_PANEL_W, X = (m) => m * P;
  ctx.fillStyle = '#1b1d21'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#25282d'; ctx.fillRect(0, X(0.36), W, H - X(0.36));
  const dw = 0.36, dh = 0.27, top = 0.05;
  const xs = [0.1, 0.52, 1.02, 1.44];
  for (const x0 of xs) { ctx.fillStyle = '#0a0b0c'; ctx.fillRect(X(x0 - 0.015), X(top - 0.015), X(dw + 0.03), X(dh + 0.03)); }
  drawPFD(ctx, X(xs[0]), X(top), X(dw), X(dh), d);
  drawND(ctx, X(xs[1]), X(top), X(dw), X(dh), d);
  drawEICAS(ctx, X(xs[2]), X(top), X(dw), X(dh), d);
  drawPFD(ctx, X(xs[3]), X(top), X(dw), X(dh), d);
  // Placards and labels under the displays.
  text(ctx, 'TOP G', X(0.95), X(0.345), X(0.016), '#c9ccd1', 'center', SANS, 800);
  text(ctx, 'LANDING GEAR', X(0.93), X(0.395), X(0.009), '#c9ccd1', 'center', SANS, 700);
  text(ctx, d.gear > 0.999 ? 'DOWN' : d.gear < 0.001 ? 'UP' : 'TRANSIT', X(0.93), X(0.47), X(0.011), d.gear > 0.999 ? C.green : d.gear < 0.001 ? C.grey : C.amber, 'center', MONO, 700);
  for (const [lbl, xx] of [['MASTER WARN', 0.08], ['MASTER CAUT', 0.2], ['MASTER WARN', 1.62], ['MASTER CAUT', 1.74]]) {
    ctx.fillStyle = '#2e3136'; ctx.fillRect(X(xx), X(0.4), X(0.09), X(0.035));
    text(ctx, lbl, X(xx + 0.045), X(0.4175), X(0.008), '#7c818a', 'center', SANS, 700);
  }
}
