// São Paulo World · driving test track: the crash lab.
// Standard-style crash tests on the crash lane: the car is put on a sled at the test speed
// (ord_launch), coasts into the rigid barrier or the pole, and every physics step around the
// impact is recorded (360 Hz). Then the impact replays in slow motion with the crush growing as
// the pulse the occupants feel (a half sine at the zone's natural frequency, crash.hpp), and the
// report shows the dummies' numbers and the pulse.
// Test conditions follow the published protocols' speeds and angles; the barrier is a rigid wall,
// the structure a lumped crush zone: a game estimate, not a homologation test.
// SPDX-License-Identifier: MIT

export const TESTS = [
  { id: 'fw50', name: 'Full-width frontal · 50 km/h', kind: 'front', v: 50, note: 'Euro NCAP full-width rigid barrier' },
  { id: 'fw56', name: 'Full-width frontal · 56 km/h', kind: 'front', v: 56, note: 'US NCAP frontal (35 mph)' },
  { id: 'fw64', name: 'Frontal · 64 km/h', kind: 'front', v: 64, note: 'the speed of the offset tests (40 mph), here into a full-width rigid wall' },
  { id: 'fw80', name: 'Frontal · 80 km/h', kind: 'front', v: 80, note: 'beyond any test protocol' },
  { id: 'pole32', name: 'Side pole · 32 km/h at 75°', kind: 'pole', v: 32, note: 'Euro NCAP oblique pole, driver side' },
];

const SLOWMO = 0.1, PRE = 0.25, POST = 0.6;

export class CrashLab {
  constructor({ M, S, W, occState, launch, structure, crumpleHit, dummyPose, toast, lane, cageSnap, cageApply, damage }) {
    Object.assign(this, { M, S, W, occState, launch, structure, crumpleHit, dummyPose, toast, lane, cageSnap, cageApply, damage });
    this.mode = 'off';
    this.rec = [];
    this.panel = document.createElement('div');
    this.panel.id = 'lab'; this.panel.className = 'panel'; this.panel.hidden = true;
    (document.getElementById('leftcol') || document.body).append(this.panel);
  }

  get active() { return this.mode === 'run' || this.mode === 'replay'; }

  start(test, geo) {
    this.test = test;
    const L = this.lane;
    const v = test.v / 3.6;
    if (test.kind === 'front') {
      // 6 m of run-up to the barrier face, centred in the lane
      this.launch(L.bx - (geo.xf + 1.0) - 6, L.y, 0, v, 0);
    } else {
      // driver side (left) into the pole, the sled moving 75 degrees off the car's axis; the
      // pole lines up with the driver's seat
      const a = 75 * Math.PI / 180, seatX = geo.seatX;
      const fwd = v * Math.cos(a), lat = v * Math.sin(a);
      const gap = 1.2, side = geo.half + 0.16 + 0.15;  // 1.2 m of air between door and pole
      const t = gap / lat;
      this.launch(L.px - seatX - fwd * t, L.py - side - gap, 0, fwd, lat);
    }
    this.rec = [];
    this.lastCage = null; this.applied = null;
    this.t = 0; this.tImpact = null; this.vImpact = 0; this.hit = null;
    this.events0 = this.occState(0)[6];
    this.mode = 'run';
    this.panel.hidden = false;
    this.panel.innerHTML = `<b>Crash lab</b> · ${test.name}<br><small>${test.note}. Sled at ${test.v} km/h…</small>`;
  }

  // One rendered frame of the live run: real-time fixed steps, every step recorded.
  stepRun(dt) {
    const M = this.M, S = this.S, W = this.W;
    const n = Math.max(1, Math.min(14, Math.round(dt * 360)));
    for (let k = 0; k < n; ++k) {
      M._ord_set_input(0, 0, 0, 0, 0, 0);
      M._ord_step(1);
      this.t += 1 / 360;
      const nh = M._ord_hit_events();
      if (nh && this.tImpact === null) {
        const h = new Float64Array(M.HEAPF64.buffer, M._ord_hit_buffer(), 7 * nh).slice(0, 7);
        if (h[5] > 2) { this.tImpact = this.t; this.vImpact = h[5]; this.hit = h; this.crumple = this.crumpleHit(h, this.test.kind); }
      }
      const o0 = this.occState(0), o1 = this.occState(1);
      // the crash structure's shape this step (realistic damage): a copy only when it changed
      const snap = this.cageSnap?.();
      if (snap !== undefined) this.lastCage = snap;
      this.rec.push({
        cage: this.lastCage, ax: S(11), ay: S(12),
        t: this.t, x: S(0), y: S(1), z: S(2), qw: S(3), qx: S(4), qy: S(5), qz: S(6),
        wz: [0, 1, 2, 3].map((w) => W(w, 2)), steer: [0, 1, 2, 3].map((w) => W(w, 4)), omega: [0, 1, 2, 3].map((w) => W(w, 5)),
        occ: [[o0[0], o0[1], o0[2], o0[3], o0[22]], [o1[0], o1[1], o1[2], o1[3], o1[22]]], g: o0[4],
      });
    }
    if (this.tImpact === null && this.t > 4) { this.mode = 'off'; this.toast('The car never reached the barrier'); return null; }
    if (this.tImpact !== null && this.t > this.tImpact + POST + 0.05) {
      this.mode = 'replay';
      this.replayT = this.tImpact - PRE;
      if (this.crumple) this.crumple.set(0);
      this.showCage(this.rec.find((r) => r.t >= this.replayT), false);
    }
    return this.rec[this.rec.length - 1];
  }

  // Slow-motion replay: the recorded frame at replay time, and the crush grown to match.
  stepReplay(dt) {
    this.replayT += dt * SLOWMO;
    const end = this.tImpact + POST;
    if (this.replayT >= end) { this.finishReplay(); return this.rec[this.rec.length - 1]; }
    // the crush follows the pulse's displacement: (1 - cos(w t)) / 2 over half a period
    if (this.crumple) {
      const s = this.structure(), om = this.test.kind === 'front' ? s[0] : s[2];
      const tt = this.replayT - this.tImpact;
      this.crumple.set(tt <= 0 ? 0 : tt >= Math.PI / om ? 1 : 0.5 * (1 - Math.cos(om * tt)));
    }
    let i = this.rec.findIndex((r) => r.t >= this.replayT);
    if (i < 0) i = this.rec.length - 1;
    this.showCage(this.rec[i], false);
    return this.rec[i];
  }

  // The structure as recorded at that step, on the mesh (realistic damage).
  showCage(r, normals) {
    if (!r || !r.cage || !this.cageApply || (r.cage === this.applied && !normals)) return;
    this.applied = r.cage;
    this.cageApply(r.cage, normals);
  }

  finishReplay() {
    this.mode = 'report';
    if (this.crumple) this.crumple.set(1);
    this.showCage(this.rec[this.rec.length - 1], true);
    this.report();
  }

  // Camera for the live run and the replay: from the side, turning slowly with the replay.
  camera(cam, carPos) {
    const k = this.mode === 'replay' ? (this.replayT - (this.tImpact - PRE)) / (PRE + POST) : this.mode === 'report' ? 1 : 0;
    // frontal: swings from the rear quarter to the side (ahead of that is the barrier) and looks
    // down at the bonnet; pole: from the front quarter round to the struck door
    const a = this.test.kind === 'front' ? -1.95 + 0.5 * k : -0.6 - 0.9 * k;
    const d = this.mode === 'run' ? 9 : 6.5;
    cam.position.set(carPos.x + Math.cos(a) * d, carPos.y + 1.6 + 0.8 * k, carPos.z + Math.sin(a) * d);
    cam.lookAt(carPos.x, carPos.y + 0.5, carPos.z);
  }

  report() {
    const o = this.occState(0), p = this.occState(1);
    const r = o.slice(7, 23), q = p.slice(7, 23);
    const pct = (x) => (x < 0.001 ? '<0.1' : (100 * x).toFixed(x < 0.1 ? 1 : 0));
    const VERD = ['walks away', 'bruised', 'injured', 'seriously injured', 'critical'], CSS = ['#2fbf71', '#9bd14b', '#f0c419', '#ff8a2a', '#e5383b'];
    const s = this.structure(), om = this.test.kind === 'front' ? s[0] : s[2], lim = this.test.kind === 'front' ? s[3] : s[5];
    const dv = r[0] ? r[2] : this.vImpact;
    // The chart: the car's pulse and the driver's chest, -20..200 ms. With the crash structure
    // the car's pulse is measured (the body's own deceleration each step); otherwise it is the
    // crush model's half sine.
    const dmg = this.damage?.();
    const front = this.test.kind === 'front';
    const carG = (rr) => (front ? -rr.ax : Math.abs(rr.ay)) / 9.81;
    const t0 = this.tImpact, T = Math.PI / om;
    let peak = dv * om / 2 / 9.81;
    if (dmg) peak = Math.max(...this.rec.filter((rr) => rr.t >= t0 - 0.01 && rr.t <= t0 + 0.25).map(carG), 0);
    const gmax = Math.max(10, peak * 1.25, ...this.rec.map((rr) => rr.g));
    const W = 300, H = 120, x = (t) => 30 + (t + 0.02) / 0.22 * (W - 40), y = (g) => H - 18 - Math.max(0, g) / gmax * (H - 30);
    let pulse = '', chest = '';
    if (dmg) for (const rr of this.rec) { const t = rr.t - t0; if (t < -0.02 || t > 0.2) continue; pulse += `${x(t).toFixed(1)},${y(carG(rr)).toFixed(1)} `; }
    else for (let i = 0; i <= 60; ++i) { const t = -0.02 + i * 0.22 / 60; const g = t < 0 || t > T ? 0 : peak * Math.sin(om * t); pulse += `${x(t).toFixed(1)},${y(g).toFixed(1)} `; }
    for (const rr of this.rec) { const t = rr.t - t0; if (t < -0.02 || t > 0.2) continue; chest += `${x(t).toFixed(1)},${y(rr.g).toFixed(1)} `; }
    const crush = dmg ? (front ? dmg[3] : dmg[5]) : Math.min(lim, dv / om);
    let pulseMs = T * 1000;
    if (dmg) { let tEnd = t0; for (const rr of this.rec) if (rr.t > t0 && carG(rr) > 2) tEnd = rr.t; pulseMs = (tEnd - t0) * 1000; }
    const seat = (name, v) => `<tr><td>${name}</td><td style="color:${CSS[v[15]] || '#fff'}"><b>${VERD[v[15]] || '—'}</b></td><td>${v[6].toFixed(0)} g</td><td>${v[7].toFixed(0)}</td><td>${v[5].toFixed(0)} g</td><td>${(100 * v[8]).toFixed(0)} cm</td><td>${pct(v[13])} %</td></tr>`;
    this.panel.innerHTML = `<div class="lhead"><b>Crash lab · ${this.test.name}</b><button id="labClose" aria-label="Close">✕</button></div>
      <small>${this.test.note}. Impact at ${(this.vImpact * 3.6).toFixed(0)} km/h, speed change ${(dv * 3.6).toFixed(0)} km/h, car pulse peak ${peak.toFixed(0)} g over ${pulseMs.toFixed(0)} ms, crush ${(crush * 100).toFixed(0)} cm${dmg ? (dmg[8] > 0.01 ? `, cabin intrusion ${(dmg[8] * 100).toFixed(0)} cm` : '') : ` of ${(lim * 100).toFixed(0)}`}.</small>
      <table><tr><th></th><th></th><th>Chest 3 ms</th><th>HIC15</th><th>Head</th><th>Travel</th><th title="Risk of a life-threatening (AIS 4+) injury">Risk</th></tr>${seat('Driver', r)}${seat('Passenger', q)}</table>
      <svg viewBox="0 0 ${W} ${H}" class="pulse" aria-label="Crash pulse">
        <line x1="30" x2="${W - 10}" y1="${H - 18}" y2="${H - 18}" stroke="rgba(255,255,255,.3)"/>
        <line x1="${x(0)}" x2="${x(0)}" y1="8" y2="${H - 18}" stroke="rgba(255,255,255,.2)" stroke-dasharray="3 3"/>
        <polyline points="${pulse}" fill="none" stroke="#ef5d4f" stroke-width="1.6"/>
        <polyline points="${chest}" fill="none" stroke="#ffd36b" stroke-width="1.4"/>
        <text x="30" y="${H - 4}" fill="#93a0b2" font-size="9">0</text><text x="${x(0.1)}" y="${H - 4}" fill="#93a0b2" font-size="9">100 ms</text><text x="${x(0.2) - 20}" y="${H - 4}" fill="#93a0b2" font-size="9">200 ms</text>
        <text x="2" y="${y(gmax * 0.9) + 3}" fill="#93a0b2" font-size="9">${(gmax * 0.9).toFixed(0)} g</text>
        <text x="${W - 120}" y="16" fill="#ef5d4f" font-size="9">car pulse</text><text x="${W - 120}" y="28" fill="#ffd36b" font-size="9">driver chest</text>
      </svg>
      <div class="row"><button id="labAgain">Run again</button><button id="labReplay">Replay</button></div>
      <small>${dmg ? `Rigid wall, the car's node/beam crash structure (it crushes as it absorbs the energy: the pulse above is measured, not assumed)` : `Rigid wall, lumped crush zone (${(lim * 100).toFixed(0)} cm, ${(om / (2 * Math.PI)).toFixed(1)} Hz)`}; dummies from NHTSA's published risk curves. A game estimate that ranks crashes sensibly, not a rating.</small>`;
    this.panel.querySelector('#labClose').onclick = () => { this.panel.hidden = true; this.mode = 'off'; this.onClose?.(); };
    this.panel.querySelector('#labAgain').onclick = () => this.onAgain?.(this.test);
    this.panel.querySelector('#labReplay').onclick = () => { this.mode = 'replay'; this.replayT = this.tImpact - PRE; if (this.crumple) this.crumple.set(0); this.applied = null; this.showCage(this.rec.find((r) => r.t >= this.replayT), false); };
  }
}
