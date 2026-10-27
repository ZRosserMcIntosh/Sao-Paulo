// São Paulo World · driving test track: slow-motion replay, Forza style.
// Plays back the rewind recorder's last ~25 s (each frame's pose and telemetry record) at a
// chosen speed, drawn between recorded frames so a tenth of real speed is smooth, with a scrub
// bar; the telemetry pages follow the replay. "Drive from here" hands the frame to the rewind
// recorder, which restores the simulation to it exactly (the physics is deterministic) and lets
// you carry on driving from that moment.
// SPDX-License-Identifier: MIT
import { blendTelemetry } from './telemetry.js';

const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1];

function lerp(a, b, k) { return a + (b - a) * k; }
function lerpArr(a, b, k) { return a && b ? a.map((v, i) => lerp(v, b[i], k)) : (a || b); }
function blendPose(a, b, k) {
  // nlerp the orientation (short way round)
  let bw = b.qw, bx = b.qx, by = b.qy, bz = b.qz;
  if (a.qw * bw + a.qx * bx + a.qy * by + a.qz * bz < 0) { bw = -bw; bx = -bx; by = -by; bz = -bz; }
  let qw = lerp(a.qw, bw, k), qx = lerp(a.qx, bx, k), qy = lerp(a.qy, by, k), qz = lerp(a.qz, bz, k);
  const n = Math.hypot(qw, qx, qy, qz) || 1; qw /= n; qx /= n; qy /= n; qz /= n;
  return { id: k < 0.5 ? a.id : b.id, x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k), qw, qx, qy, qz,
    wx: lerpArr(a.wx, b.wx, k), wy: lerpArr(a.wy, b.wy, k), wz: lerpArr(a.wz, b.wz, k), steer: lerpArr(a.steer, b.steer, k), omega: lerpArr(a.omega, b.omega, k),
    tel: blendTelemetry(a.tel, b.tel, k) };
}

export class ReplayViewer {
  constructor(host) {
    this.on = false;
    this.el = document.createElement('div');
    this.el.id = 'replay'; this.el.className = 'panel'; this.el.hidden = true;
    this.el.innerHTML = `<div class="rrow"><b>Replay</b>
      <button class="rplay" aria-label="Play or pause">❚❚</button>
      <span class="rspeeds">${SPEEDS.map((s) => `<button data-speed="${s}">${s === 1 ? '1×' : s + '×'}</button>`).join('')}</span>
      <span class="rtime"></span>
      <button class="rdrive" title="Carry on driving from this frame">Drive from here</button>
      <button class="rexit" aria-label="Exit replay">✕</button></div>
      <input class="rscrub" type="range" min="0" max="1000" value="1000" aria-label="Scrub">`;
    host.append(this.el);
    this.scrub = this.el.querySelector('.rscrub');
    this.time = this.el.querySelector('.rtime');
    this.el.querySelector('.rplay').onclick = (e) => { this.playing = !this.playing; this.syncButtons(); e.currentTarget.blur(); };
    this.el.querySelectorAll('[data-speed]').forEach((b) => (b.onclick = () => { this.speed = +b.dataset.speed; this.syncButtons(); b.blur(); }));
    this.el.querySelector('.rexit').onclick = () => this.onExit?.();
    this.el.querySelector('.rdrive').onclick = () => this.onDrive?.(this.frameIndex());
    this.scrub.oninput = () => { this.playing = false; this.t = this.t0 + (this.t1 - this.t0) * this.scrub.value / 1000; this.syncButtons(); };
    this.speed = 0.25; this.playing = true;
  }

  // frames: the rewind recorder's frames ({ dt, pose: { ..., tel } }), oldest first.
  open(frames) {
    if (frames.length < 2) return false;
    this.frames = frames;
    this.times = new Float64Array(frames.length);
    let t = 0;
    for (let i = 0; i < frames.length; ++i) { t += frames[i].dt; this.times[i] = t; }
    this.t0 = this.times[0]; this.t1 = t;
    this.t = Math.max(this.t0, this.t1 - 6);   // start 6 s back
    this.on = true; this.playing = true;
    this.el.hidden = false;
    this.syncButtons();
    return true;
  }
  close() { this.on = false; this.el.hidden = true; this.frames = null; }

  frameIndex() {
    const T = this.times;
    let lo = 0, hi = T.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < this.t) lo = m + 1; else hi = m; }
    return lo;
  }

  // realDt: wall-clock seconds. Returns { pose, hist } for this frame.
  update(realDt) {
    if (!this.on) return null;
    if (this.playing) {
      this.t += realDt * this.speed;
      if (this.t >= this.t1) { this.t = this.t1; this.playing = false; this.syncButtons(); }
    }
    const i = this.frameIndex();
    const b = this.frames[i], a = this.frames[Math.max(0, i - 1)];
    const ta = this.times[Math.max(0, i - 1)], tb = this.times[i];
    const k = tb > ta ? Math.min(1, Math.max(0, (this.t - ta) / (tb - ta))) : 1;
    const pose = blendPose(a.pose, b.pose, k);
    if (document.activeElement !== this.scrub) this.scrub.value = String(Math.round(1000 * (this.t - this.t0) / Math.max(1e-6, this.t1 - this.t0)));
    this.time.textContent = `${(this.t - this.t1).toFixed(2)} s`;
    // history for the telemetry traces: recorded frames up to this one
    const hist = [];
    for (let j = Math.max(0, i - 600); j <= i; ++j) if (this.frames[j].pose.tel) hist.push(this.frames[j].pose.tel);
    if (pose.tel) hist.push(pose.tel);
    return { pose, hist, dt: realDt * (this.playing ? this.speed : 0) };
  }

  syncButtons() {
    this.el.querySelector('.rplay').textContent = this.playing ? '❚❚' : '▶';
    this.el.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.speed === this.speed));
  }
}
