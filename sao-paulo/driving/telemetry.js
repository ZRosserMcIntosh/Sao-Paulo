// São Paulo World · driving test track: telemetry pages, Forza style.
// Every frame the page keeps one record of what the physics did (an 80-value Float32Array, with the
// rewind recorder's frame), so the live pages, the traces and the slow-motion replay read the same
// numbers. Pages: suspension (travel, damper speed, load per corner, roll and pitch), tyres
// (temperature, slip, grip used, camber), aero (downforce front, rear and wing, drag, balance,
// clearance and stall), g-forces (a g-g diagram with its trail) and drivetrain (revs, torque,
// power, pedals and steering). Nothing here is physics: it only reads and draws.
// SPDX-License-Identifier: MIT

export const REC = {
  t: 0, speed: 1, lat: 2, yawRate: 3, ax: 4, ay: 5, az: 6, rpm: 7, gear: 8, steer: 9, thrOut: 10, steerIn: 11, thrIn: 12,
  brakeIn: 13, roll: 14, pitch: 15, torque: 16, airspeed: 17, dfF: 18, dfR: 19, wing: 20, drag: 21, clrF: 22, clrR: 23,
  wingStall: 24, floorStall: 25, aeroYaw: 26, sideslip: 27, wheels: 4, W0: 32, WN: 12,
  // per wheel: load, slip ratio, slip angle, Fx, Fy, grip used, compression, travel, damper speed, temp, camber, contact
};
export const REC_SIZE = 32 + 12 * 4;

// One record from the module's buffers. S(i), W(w, i): state accessors; tel: ord_telemetry().
export function captureTelemetry(S, W, tel, simTime) {
  const r = new Float32Array(REC_SIZE);
  r[0] = simTime; r[1] = S(7); r[2] = S(8); r[3] = S(9); r[4] = S(11); r[5] = S(12); r[6] = S(13);
  r[7] = S(14); r[8] = S(15); r[9] = S(16); r[10] = S(17); r[11] = S(27); r[12] = S(28); r[13] = S(29);
  r[14] = tel[0]; r[15] = tel[1]; r[16] = tel[2]; r[17] = tel[5]; r[18] = tel[6]; r[19] = tel[7]; r[20] = tel[8]; r[21] = tel[9];
  r[22] = tel[10]; r[23] = tel[11]; r[24] = tel[13]; r[25] = tel[14]; r[26] = tel[12]; r[27] = S(10);
  const n = Math.min(4, S(22));
  r[REC.wheels] = n;
  for (let w = 0; w < n; ++w) {
    const o = 32 + 12 * w, q = 16 + 6 * w;
    r[o] = W(w, 6); r[o + 1] = W(w, 7); r[o + 2] = W(w, 8); r[o + 3] = W(w, 9); r[o + 4] = W(w, 10); r[o + 5] = W(w, 16);
    r[o + 6] = tel[q]; r[o + 7] = tel[q + 1]; r[o + 8] = tel[q + 2]; r[o + 9] = tel[q + 3]; r[o + 10] = tel[q + 4]; r[o + 11] = W(w, 11);
  }
  return r;
}
// Linear blend of two records (the slow-motion replay draws between recorded frames).
export function blendTelemetry(a, b, k) {
  if (!a) return b; if (!b) return a;
  const r = new Float32Array(REC_SIZE);
  for (let i = 0; i < REC_SIZE; ++i) r[i] = a[i] + (b[i] - a[i]) * k;
  r[8] = k < 0.5 ? a[8] : b[8];
  return r;
}

const PAGES = ['Suspension', 'Tyres', 'Aero', 'G-forces', 'Drivetrain'];
const CORNERS = ['FL', 'FR', 'RL', 'RR'];
const G = 9.80665;

function tempColour(c) {   // blue cold, green in the window, red hot
  const t = Math.max(0, Math.min(1, (c - 40) / 80));
  const h = 220 - 220 * t;
  return `hsl(${h.toFixed(0)} 80% 52%)`;
}

export class TelemetryPanel {
  constructor(host) {
    this.page = 0;
    this.el = document.createElement('aside');
    this.el.id = 'telemetry'; this.el.className = 'panel'; this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Telemetry');
    this.el.innerHTML = `<div class="thead"><b>Telemetry</b><span class="tabs">${PAGES.map((p, i) => `<button data-page="${i}">${p}</button>`).join('')}</span><button class="tclose" aria-label="Close">✕</button></div>
      <div class="tbody"></div><canvas class="trace" width="680" height="150"></canvas><div class="tfoot"></div>`;
    host.append(this.el);
    this.body = this.el.querySelector('.tbody');
    this.canvas = this.el.querySelector('.trace');
    this.foot = this.el.querySelector('.tfoot');
    this.el.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => { this.setPage(+b.dataset.page); b.blur(); }));
    this.el.querySelector('.tclose').onclick = () => this.toggle(false);
    this.lastDraw = 0;
    this.peak = { lat: 0, lon: 0, vert: 0 };
    this.setPage(0);
  }
  get on() { return !this.el.hidden; }
  toggle(on = !this.on) { this.el.hidden = !on; this.onToggle?.(on); return on; }
  next() { if (!this.on) { this.toggle(true); return; } this.setPage((this.page + 1) % PAGES.length); }
  setPage(p) {
    this.page = p;
    this.el.querySelectorAll('[data-page]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.page === p));
    this.lastDraw = 0;
  }

  // rec: this frame's record; hist: records, oldest first (the traces show the last 5 s);
  // note: a line under the pages (slow motion, replay).
  update(now, rec, hist, note = '') {
    if (!this.on || !rec) return;
    this.peak.lat = Math.max(this.peak.lat, Math.abs(rec[REC.ay]) / G);
    this.peak.lon = Math.max(this.peak.lon, Math.abs(rec[REC.ax]) / G);
    this.peak.vert = Math.max(this.peak.vert, Math.abs(rec[REC.az] / G));
    if (now - this.lastDraw < 66) return;   // ~15 Hz is plenty for numbers
    this.lastDraw = now;
    const n = rec[REC.wheels] | 0;
    const W = (w, i) => rec[REC.W0 + REC.WN * w + i];
    const kn = (x) => (x / 1000).toFixed(2);
    const corner = (w, html) => `<div class="corner c${w}"><b>${CORNERS[w] || w}</b>${html}</div>`;
    let html = '';
    if (this.page === 0) {
      html = '<div class="corners">' + [0, 1, 2, 3].slice(0, n).map((w) => {
        const travel = W(w, 7) || 0.1, c = W(w, 6), frac = Math.max(0, Math.min(1, c / travel)), v = W(w, 8);
        return corner(w, `<div class="bar"><i style="height:${(frac * 100).toFixed(0)}%;background:${frac > 0.92 ? 'var(--bad)' : 'var(--accent)'}"></i></div>
          <span>travel</span> ${(c * 1000).toFixed(0)} / ${(travel * 1000).toFixed(0)} mm<br>
          <span>damper</span> <b class="${v > 0 ? 'bump' : 'reb'}">${(v * 1000).toFixed(0)} mm/s</b> ${v > 0 ? 'bump' : 'rebound'}<br>
          <span>load</span> ${kn(W(w, 0))} kN${W(w, 11) ? '' : ' · <b class="bad">airborne</b>'}`);
      }).join('') + '</div>' +
        `<div class="row2"><span>Roll</span> ${(rec[REC.roll] * 180 / Math.PI).toFixed(1)}° <span>Pitch</span> ${(rec[REC.pitch] * 180 / Math.PI).toFixed(1)}° <span>Load F/R</span> ${this.split(rec, n, true)}</div>`;
    } else if (this.page === 1) {
      html = '<div class="corners">' + [0, 1, 2, 3].slice(0, n).map((w) => {
        const t = W(w, 9);
        return corner(w, `<div class="tyre" style="background:${tempColour(t)}">${t.toFixed(0)}°C</div>
          <span>slip</span> ${(W(w, 1) * 100).toFixed(1)}% · ${(W(w, 2) * 180 / Math.PI).toFixed(1)}°<br>
          <span>grip used</span> <b class="${W(w, 5) > 0.95 ? 'bad' : W(w, 5) > 0.8 ? 'warn' : ''}">${(W(w, 5) * 100).toFixed(0)}%</b><br>
          <span>camber</span> ${(W(w, 10) * 180 / Math.PI).toFixed(2)}° · ${kn(W(w, 0))} kN`);
      }).join('') + '</div>';
    } else if (this.page === 2) {
      const f = rec[REC.dfF], r = rec[REC.dfR], wing = rec[REC.wing], tot = f + r, v = rec[REC.airspeed];
      const bal = Math.abs(tot) > 1 ? 100 * f / tot : 50;
      const q = 0.5 * 1.225 * v * v;
      html = `<div class="aero">
        <div><span>Airspeed</span> <b>${(v * 3.6).toFixed(0)} km/h</b> <span>yaw</span> ${(rec[REC.aeroYaw] * 180 / Math.PI).toFixed(1)}°</div>
        <div><span>Downforce</span> <b>${tot.toFixed(0)} N</b> (${(tot / G).toFixed(0)} kg) · <span>front</span> ${f.toFixed(0)} · <span>rear</span> ${r.toFixed(0)}${wing ? ` (wing ${wing.toFixed(0)})` : ''}</div>
        <div><span>Aero balance</span> <b>${bal.toFixed(1)}% front</b></div>
        <div><span>Drag</span> <b>${rec[REC.drag].toFixed(0)} N</b> · ${(rec[REC.drag] * v / 1000).toFixed(1)} kW · <span>CdA</span> ${q > 1 ? (rec[REC.drag] / q).toFixed(3) : '—'} m² · <span>L/D</span> ${rec[REC.drag] > 1 ? (tot / rec[REC.drag]).toFixed(2) : '—'}</div>
        <div>${this.hasFloor ? `<span>Floor clearance</span> F ${(rec[REC.clrF] * 1000).toFixed(0)} mm · R ${(rec[REC.clrR] * 1000).toFixed(0)} mm` : '<span>Floor</span> not ride-height sensitive on this car'}${rec[REC.floorStall] ? ' · <b class="bad">floor stalled</b>' : ''}${rec[REC.wingStall] ? ' · <b class="bad">wing stalled</b>' : ''}</div></div>`;
    } else if (this.page === 3) {
      const lat = rec[REC.ay] / G, lon = rec[REC.ax] / G, vert = rec[REC.az] / G;
      html = `<div class="gg"><canvas class="ggc" width="190" height="190"></canvas><div>
        <span>Lateral</span> <b>${lat.toFixed(2)} g</b> <small>peak ${this.peak.lat.toFixed(2)}</small><br>
        <span>Longitudinal</span> <b>${lon.toFixed(2)} g</b> <small>peak ${this.peak.lon.toFixed(2)}</small><br>
        <span>Vertical</span> <b>${vert.toFixed(2)} g</b> <small>peak ${this.peak.vert.toFixed(2)}</small><br>
        <span>Combined</span> <b>${Math.hypot(lat, lon).toFixed(2)} g</b><br>
        <span>Sideslip</span> ${(rec[REC.sideslip] * 180 / Math.PI).toFixed(1)}° · <span>yaw rate</span> ${(rec[REC.yawRate] * 180 / Math.PI).toFixed(0)}°/s<br>
        <button class="tpeak">Reset peaks</button></div></div>`;
    } else {
      const rpm = rec[REC.rpm], tq = rec[REC.torque], kw = tq * rpm * Math.PI / 30 / 1000;
      html = `<div class="aero">
        <div><span>Engine</span> <b>${rpm.toFixed(0)} rpm</b> · gear <b>${rec[REC.gear] === -1 ? 'R' : rec[REC.gear] === 0 ? 'N' : rec[REC.gear]}</b> · ${(rec[REC.speed] * 3.6).toFixed(0)} km/h</div>
        <div><span>Crank torque</span> ${tq.toFixed(0)} N·m · <span>power</span> <b>${kw.toFixed(0)} kW</b> (${(kw * 1.341).toFixed(0)} hp)</div>
        <div><span>Throttle</span> ${(rec[REC.thrIn] * 100).toFixed(0)}% (after TCS ${(rec[REC.thrOut] * 100).toFixed(0)}%) · <span>brake</span> ${(rec[REC.brakeIn] * 100).toFixed(0)}% · <span>steering</span> ${(rec[REC.steer] * 180 / Math.PI).toFixed(1)}°</div></div>`;
    }
    this.body.innerHTML = html;
    this.body.querySelector('.tpeak')?.addEventListener('click', () => { this.peak = { lat: 0, lon: 0, vert: 0 }; });
    if (this.page === 3) this.drawGG(this.body.querySelector('.ggc'), rec, hist);
    this.drawTrace(rec, hist);
    this.foot.textContent = note;
  }

  split(rec, n, frontRear) {
    let a = 0, b = 0;
    for (let w = 0; w < n; ++w) { const l = rec[REC.W0 + REC.WN * w]; if (w < 2) a += l; else b += l; }
    const t = a + b || 1;
    return `${(100 * a / t).toFixed(0)} / ${(100 * b / t).toFixed(0)} %`;
  }

  drawGG(c, rec, hist) {
    const x = c.getContext('2d'), W = c.width, H = c.height, cx = W / 2, cy = H / 2, R = W / 2 - 10, gMax = 2;
    x.clearRect(0, 0, W, H);
    x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = 1;
    for (const g of [0.5, 1, 1.5, 2]) { x.beginPath(); x.arc(cx, cy, R * g / gMax, 0, Math.PI * 2); x.stroke(); }
    x.beginPath(); x.moveTo(cx - R, cy); x.lineTo(cx + R, cy); x.moveTo(cx, cy - R); x.lineTo(cx, cy + R); x.stroke();
    x.fillStyle = 'rgba(255,255,255,.45)'; x.font = '10px system-ui'; x.fillText('1 g', cx + R / 2 + 2, cy - 3); x.fillText('2 g', cx + R - 14, cy - 3);
    const t0 = rec[REC.t] - 3;
    x.beginPath();
    let first = true;
    for (const h of hist) {
      if (h[REC.t] < t0) continue;
      const px = cx - (h[REC.ay] / G) / gMax * R, py = cy - (h[REC.ax] / G) / gMax * R;   // left turn to the left, braking down
      if (first) { x.moveTo(px, py); first = false; } else x.lineTo(px, py);
    }
    x.strokeStyle = 'rgba(255,211,107,.8)'; x.lineWidth = 1.5; x.stroke();
    x.fillStyle = '#ef5d4f';
    x.beginPath(); x.arc(cx - (rec[REC.ay] / G) / gMax * R, cy - (rec[REC.ax] / G) / gMax * R, 5, 0, Math.PI * 2); x.fill();
  }

  // The last 5 s of the page's key channels.
  drawTrace(rec, hist) {
    const c = this.canvas, x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H);
    const t1 = rec[REC.t], t0 = t1 - 5;
    const pts = hist.filter((h) => h[REC.t] >= t0 && h[REC.t] <= t1 + 1e-6);
    if (pts.length < 2) return;
    const n = rec[REC.wheels] | 0;
    const W_ = (h, w, i) => h[REC.W0 + REC.WN * w + i];
    let series = [];
    const colours = ['#5aa0ff', '#36c483', '#ffd36b', '#ef5d4f'];
    if (this.page === 0) series = [0, 1, 2, 3].slice(0, n).map((w) => ({ label: `${CORNERS[w]} travel`, unit: 'mm', f: (h) => W_(h, w, 6) * 1000, c: colours[w] }));
    else if (this.page === 1) series = [0, 1, 2, 3].slice(0, n).map((w) => ({ label: `${CORNERS[w]} grip used`, unit: '%', f: (h) => W_(h, w, 5) * 100, c: colours[w] }));
    else if (this.page === 2) series = [{ label: 'front', unit: 'N', f: (h) => h[REC.dfF], c: colours[0] }, { label: 'rear', unit: 'N', f: (h) => h[REC.dfR], c: colours[1] }, { label: 'drag', unit: 'N', f: (h) => h[REC.drag], c: colours[3] }];
    else if (this.page === 3) series = [{ label: 'lateral', unit: 'g', f: (h) => h[REC.ay] / G, c: colours[0] }, { label: 'longitudinal', unit: 'g', f: (h) => h[REC.ax] / G, c: colours[2] }, { label: 'vertical', unit: 'g', f: (h) => h[REC.az] / G, c: colours[3] }];
    else series = [{ label: 'throttle', unit: '%', f: (h) => h[REC.thrIn] * 100, c: colours[1] }, { label: 'brake', unit: '%', f: (h) => h[REC.brakeIn] * 100, c: colours[3] }, { label: 'rpm/100', unit: '', f: (h) => h[REC.rpm] / 100, c: colours[2] }];
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const h of pts) { const v = s.f(h); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const X = (t) => 8 + (t - t0) / 5 * (W - 16), Y = (v) => H - 16 - (v - lo) / (hi - lo) * (H - 28);
    x.strokeStyle = 'rgba(255,255,255,.12)'; x.beginPath(); if (lo < 0 && hi > 0) { x.moveTo(8, Y(0)); x.lineTo(W - 8, Y(0)); } x.stroke();
    x.font = '11px system-ui';
    series.forEach((s, k) => {
      x.strokeStyle = s.c; x.lineWidth = 1.6; x.beginPath();
      pts.forEach((h, i) => { const px = X(h[REC.t]), py = Y(s.f(h)); if (i) x.lineTo(px, py); else x.moveTo(px, py); });
      x.stroke();
      x.fillStyle = s.c; x.fillText(`${s.label} ${s.f(rec).toFixed(s.unit === 'g' ? 2 : 0)}${s.unit ? ' ' + s.unit : ''}`, 10 + k * 165, 12);
    });
    x.fillStyle = 'rgba(255,255,255,.4)'; x.fillText('−5 s', 8, H - 3); x.fillText('now', W - 30, H - 3);
  }
}
