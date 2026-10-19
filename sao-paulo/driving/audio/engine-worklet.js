// Engine synthesizer (AudioWorklet). Physically inspired: every combustion event is a pressure
// pulse sent down one of the two exhaust banks at the crank angle where that cylinder fires.
// Pulses ring a set of pipe resonances and a pipe-length comb, then go through load-dependent
// saturation. No samples are used.
//
// What makes engines sound different is mostly *when* each bank receives a pulse, so the voice
// is a profile (see engines.js): the firing events (fraction of the four-stroke cycle and bank),
// the pipe resonances and lengths, turbochargers (which soak up pulse energy and add a
// compressor whistle and a blow-off on lift), overrun crackle, hybrid motor whine and how much
// the cabin isolates it. The default profile is the original flat-plane V8 voice (the Rosser
// Stella): eight evenly spaced events alternating banks, so each bank hears even pulses - the
// high, smooth "scream".
//
// Parameters (k-rate, set from the main thread every frame):
//   rpm      engine speed
//   load     0..1 throttle after traction control
//   limiter  rev limit (rpm)
//   cut      0..1 ignition cut (gear shifts)
//   interior 0..1 (0 = outside behind the car, 1 = cabin)

const DEFAULT_VOICE = {
  events: Array.from({ length: 8 }, (_, c) => [c / 8, c & 1]), // [cycle fraction, bank]
  jitter: 0.006,          // per-cylinder timing spread (fraction of a cycle)
  res: [[92, 6, 0.016, 0.9], [300, 14, 0.007, 0.55], [690, 25, 0.0045, 0.5], [1480, 60, 0.003, 0.32], [3100, 120, 0.0016, 0.16]], // [f, bank detune, tau, gain]
  comb: [0.0093, 0.0004], // pipe delay (s) and the second bank's extra length
  combFb: 0.35,
  intake: [[1900, 0.0025, 1], [3600, 0.0012, 0.5]],
  pulseW: 0.0005,         // s
  whineOrder: 24,
  stereo: 0.72,           // share of a bank in its own channel (0.5 = one merged exhaust)
  turbo: 0,               // 0..1: pulse damping, compressor whistle, blow-off
  turboWhistle: 1,        // whistle level relative to the turbo amount
  crackle: 1,             // overrun pops
  hybrid: 0,              // electric motor whine (orders of engine speed)
  hybridOrder: 9,
  interior: 0.16,         // cabin low-pass coefficient (lower = better insulated)
  drive: 1,               // saturation scale
  gain: 1,
};

class EngineSynth {
  constructor(sr, seed = 7, voice = null) {
    this.sr = sr;
    const V = (this.v = Object.assign({}, DEFAULT_VOICE, voice || {}));
    this.nEv = V.events.length;
    let s = seed >>> 0;
    this.rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    // Per-cylinder character: small, fixed differences in pulse strength and timing give the
    // half-order "burble" at low rpm that a perfectly even pulse train would not have.
    this.cylAmp = Array.from({ length: this.nEv }, () => 0.9 + 0.2 * this.rand());
    this.cylTime = Array.from({ length: this.nEv }, () => (this.rand() - 0.5) * V.jitter);
    this.phase = 0; // 0..1 per four-stroke cycle (two crank revolutions)
    this.nextEvent = 0;
    this.rpm = 1000; this.load = 0; this.cutS = 0;
    this.prevRpm = 1000; this.decel = 0;
    // Two exhaust banks, each with its own resonators (slightly detuned = stereo width).
    const mk = (f, tau, g) => ({ f, tau, g, y1: 0, y2: 0, a1: 0, a2: 0 });
    this.banks = [0, 1].map((b) => ({
      res: V.res.map(([f, det, tau, g]) => mk(f + b * det, tau, g)),
      comb: new Float32Array(4096), ci: 0, combLen: Math.min(4095, Math.round(sr * (V.comb[0] + b * V.comb[1]))),
      exc: 0, excLeft: 0, excAmp: 0,
      hp: 0, hpx: 0, lp: 0, zx: 0, zh: 0,
    }));
    this.banks.forEach((bk) => bk.res.forEach((r) => this.tune(r)));
    // Intake: a bright resonator excited by every event, strongest at high rpm and full load.
    this.intake = V.intake.map(([f, tau, g]) => mk(f, tau, g));
    this.intake.forEach((r) => this.tune(r));
    this.pulseW = sr * V.pulseW; // pulse length in samples (fractional)
    this.t = 0;
    this.banks.forEach((bk) => (bk.pulses = []));
    this.ik = [];
    this.pop = 0; this.popLp = 0;
    this.limT = 0;
    this.whine = 0;
    this.air = 0;
    // turbo state: boost 0..1 (spools with load and rpm), whistle phase, blow-off envelope,
    // and a one-pole low-pass that stands for the turbine soaking up the pulse edges
    this.boost = 0; this.tw = 0; this.bov = 0; this.bovLp = 0; this.prevLoad = 0;
    this.tLp = [0, 0];
    this.hy = 0;
  }
  tune(r) {
    const rr = Math.exp(-1 / (r.tau * this.sr));
    r.a1 = 2 * rr * Math.cos((2 * Math.PI * r.f) / this.sr);
    r.a2 = -rr * rr;
    r.norm = (1 - rr) * 2;
  }
  // Sum of raised-cosine pulses that are still sounding; list holds [start, amp] pairs.
  pulseSum(list) {
    let x = 0;
    for (let k = 0; k < list.length; k += 2) {
      const u = (this.t - list[k]) / this.pulseW;
      if (u >= 0 && u < 1) x += list[k + 1] * (1 - Math.cos(2 * Math.PI * u)) * 0.5;
    }
    while (list.length && this.t - list[0] >= this.pulseW) list.splice(0, 2);
    return x * 2.2;
  }
  ring(r, x) {
    const y = r.a1 * r.y1 + r.a2 * r.y2 + x * r.norm;
    r.y2 = r.y1; r.y1 = y;
    return y * r.g;
  }
  // Render n samples of stereo into L and R.
  render(L, R, n, p) {
    const sr = this.sr;
    const kS = 1 - Math.exp(-1 / (0.004 * sr));
    const kUp = 1 - Math.exp(-1 / (0.06 * sr)); // parameter smoothing (short: no audible lag)
    const inter = p.interior;
    // rpm fall rate (rpm/s), smoothed per block: drives overrun pops
    const drop = (this.prevRpm - p.rpm) * (sr / n);
    this.decel = 0.85 * this.decel + 0.15 * Math.max(0, drop);
    this.prevRpm = p.rpm;
    for (let i = 0; i < n; ++i) {
      this.rpm += (p.rpm - this.rpm) * kS;
      // Throttle swells in over ~60 ms (a stab of the pedal at low rpm no longer slams the
      // speakers) but drops instantly on a lift so the overrun crackle starts right away.
      this.load += (p.load - this.load) * (p.load > this.load ? kUp : kS);
      this.cutS += (p.cut - this.cutS) * kS * 4;
      const rpm = Math.max(300, this.rpm), load = this.load;
      const rpmN = Math.min(1.2, rpm / p.limiter);
      // Rev limiter: fuel cut bounces at ~22 Hz while held against it.
      let limiterCut = 0;
      if (rpm > p.limiter - 60 && p.load > 0.4) { this.limT += 1 / sr; limiterCut = (this.limT * 22) % 1 < 0.55 ? 1 : 0; }
      else this.limT = 0;
      const dp = rpm / 120 / sr;
      this.phase += dp;
      this.t += 1;
      if (this.phase >= 1) { this.phase -= 1; this.nextEvent = 0; }
      // Firing events at their crank angles, each down its own bank's exhaust. Event times are
      // kept to a fraction of a sample: rounding them would smear the high harmonics into noise
      // at high rpm.
      const ev = this.v.events;
      while (this.nextEvent < this.nEv && this.phase >= ev[this.nextEvent][0] + this.cylTime[this.nextEvent]) {
        const c = this.nextEvent;
        const ago = (this.phase - (ev[c][0] + this.cylTime[c])) / dp; // samples since the event
        this.nextEvent++;
        const bk = this.banks[ev[c][1]];
        const cutNow = Math.max(this.cutS, limiterCut);
        // Combustion strength: strong on load, weak pumping pulses when coasting.
        let e = (0.2 + 0.8 * Math.pow(load, 0.8)) * this.cylAmp[c] * (0.98 + 0.04 * this.rand());
        if (cutNow > 0.5) e = 0.1 * this.cylAmp[c];
        // Overrun: unburnt fuel popping in the exhaust when lifting at high rpm.
        if (load < 0.08 && rpm > 3200 && this.decel > 300 && this.rand() < (0.035 + 0.08 * Math.min(1, this.decel / 4000)) * this.v.crackle * (8 / this.nEv)) this.pop = 0.6 + 0.7 * this.rand();
        if (cutNow > 0.5 && this.rand() < 0.3) this.pop = Math.max(this.pop, 0.5 * this.rand() + 0.3);
        bk.pulses.push(this.t - ago, e);
        this.ik.push(this.t - ago, e);
      }
      // Each bank: half-cosine pulse -> resonators + pipe comb.
      let out = [0, 0];
      for (let b = 0; b < 2; ++b) {
        const bk = this.banks[b];
        let x = 0;
        x = this.pulseSum(bk.pulses);
        // pop: a broadband thump into the low resonances
        if (this.pop > 0) { x += this.pop * (this.rand() * 2 - 1) * 2.0; }
        let y = 0;
        for (const r of bk.res) y += this.ring(r, x);
        // open-ended pipe: negative reflection
        const d = bk.comb[(bk.ci - bk.combLen + 4096) & 4095];
        let z = y - this.v.combFb * d;
        // turbine: takes the sharp edge off every pulse (more so as it spools)
        if (this.v.turbo > 0) {
          const k = 1 - this.v.turbo * (0.55 + 0.35 * this.boost);
          this.tLp[b] += (z - this.tLp[b]) * k;
          z = this.tLp[b];
        }
        bk.comb[bk.ci] = z; bk.ci = (bk.ci + 1) & 4095;
        // Remove the DC the one-sided pressure pulses build up in the low resonances before the
        // clipper; otherwise dense pulse trains rail it and the sound drops out in some rpm bands.
        const zh = z - bk.zx + 0.996 * bk.zh; bk.zx = z; bk.zh = zh;
        out[b] = zh;
      }
      this.pop *= 0.9965;
      if (this.pop < 0.01) this.pop = 0;
      // Intake howl (mostly heard in the cabin and at high rpm).
      let ik = 0;
      const ix = this.pulseSum(this.ik);
      // induction air rush: soft filtered noise under load
      this.air += ((this.rand() * 2 - 1) - this.air) * 0.25;
      const air = this.air * 0.03 * load * rpmN * rpmN;
      for (const r of this.intake) ik += this.ring(r, ix);
      ik *= (0.15 + 0.85 * load) * Math.pow(rpmN, 1.6) * (0.35 + 0.65 * inter);
      // Valvetrain / gear whine: faint tone that rises with rpm.
      this.whine += (rpm / 60) * this.v.whineOrder / sr; if (this.whine > 1) this.whine -= 1;
      let wh = Math.sin(2 * Math.PI * this.whine) * 0.012 * rpmN;
      if (this.v.turbo > 0) {
        // Boost builds with load and revs (spool lag ~0.4 s), falls fast on a lift. Lifting
        // off with boost up dumps it through the blow-off / bypass valve: a short "pssh".
        const want = load * Math.min(1, Math.max(0, (rpmN - 0.2) / 0.45));
        this.boost += (want - this.boost) * (want > this.boost ? 1 / (0.4 * sr) : 1 / (0.12 * sr));
        if (this.prevLoad > 0.5 && load < 0.15 && this.boost > 0.3) this.bov = Math.max(this.bov, this.boost);
        this.prevLoad = load;
        this.tw += (900 + 5200 * this.boost * Math.min(1, rpmN * 1.2)) / sr; if (this.tw > 1) this.tw -= 1;
        const wn = this.rand() * 2 - 1;
        this.bovLp += (wn - this.bovLp) * 0.35;
        wh += this.v.turbo * this.v.turboWhistle * this.boost * this.boost * (0.02 * Math.sin(2 * Math.PI * this.tw) + 0.006 * wn) * (0.4 + 0.6 * inter);
        wh += this.bov * (wn - this.bovLp) * 0.09 * this.v.turbo;
        this.bov *= 1 - 1 / (0.35 * sr);
      }
      if (this.v.hybrid > 0) {
        // electric motor geared to the crank: a clean, high whine that grows with load
        this.hy += (rpm / 60) * this.v.hybridOrder / sr; if (this.hy > 1) this.hy -= 1;
        wh += this.v.hybrid * (0.3 + 0.7 * load) * rpmN * (0.02 * Math.sin(2 * Math.PI * this.hy) + 0.008 * Math.sin(4 * Math.PI * this.hy));
      }
      // Saturation grows with load and rpm: the edge on a hard-revved V8.
      const drive = (1.2 + 1.8 * load * (0.4 + 0.6 * rpmN)) * this.v.drive;
      for (let b = 0; b < 2; ++b) {
        const bk = this.banks[b];
        // cubic soft clip: adds only odd low harmonics, so it does not alias into hiss
        let v = Math.max(-1, Math.min(1, out[b] * drive * 0.9));
        v = (1.5 * v - 0.5 * v * v * v) * 1.4;
        // cabin: muffle the exhaust
        const cut = this.v.interior + (1 - this.v.interior) * (1 - inter);
        bk.lp += (v - bk.lp) * cut;
        v = bk.lp + ik * 0.6 + wh + air;
        // DC / sub-sonic block
        const hp = v - bk.hpx + 0.995 * bk.hp; bk.hpx = v; bk.hp = hp;
        out[b] = hp;
      }
      const loud = 0.42 * (0.55 + 0.45 * Math.min(1, rpmN * 1.3)) * this.v.gain;
      const st = this.v.stereo;
      L[i] = Math.tanh((out[0] * st + out[1] * (1 - st)) * loud);
      R[i] = Math.tanh((out[1] * st + out[0] * (1 - st)) * loud);
    }
  }
}

// Tyre noise, modelled on how real tyres sound rather than as a whistle:
//  squeal - stick-slip of the tread near the grip peak excites a few lightly damped tread/carcass
//           modes (~0.65-1.1 kHz plus overtones). They are driven by noise, so pitch and level
//           wander naturally; the stick-slip itself shows up as irregular flutter. Two voices
//           (left/right tyres) are detuned and panned so it isn't one pure tone.
//  scrub  - a tyre sliding well past the peak (locked wheel, big drift, burnout): broadband rasp
//           through the tread, with tread-block chatter that speeds up with sliding speed.
// Parameters (k-rate): squeal 0..1, scrub 0..1, pitch 0..1 (how far past the peak), speed m/s.
class TyreSynth {
  constructor(sr, seed = 11) {
    this.sr = sr;
    let s = seed >>> 0;
    this.rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const mk = (f, tau, g) => ({ f, tau, g, y1: 0, y2: 0 });
    this.voices = [0, 1].map((v) => ({
      modes: [mk(800, 0.03, 1), mk(1600, 0.022, 0.45), mk(2400, 0.016, 0.2)],
      detune: v ? 1.034 : 0.982, drift: 0, flut: 1, flutLp: 1, pan: v ? 0.75 : 0.25,
    }));
    this.scr = [mk(450, 0.0016, 1.1), mk(1200, 0.0011, 1), mk(2600, 0.0007, 0.6)];
    this.sq = 0; this.sc = 0; this.chat = 0; this.chatAmp = 1; this.rum = 0; this.lpL = 0; this.lpR = 0;
    this.scr.forEach((r) => this.tune(r));
  }
  tune(r) {
    const rr = Math.exp(-1 / (r.tau * this.sr));
    r.a1 = 2 * rr * Math.cos((2 * Math.PI * r.f) / this.sr); r.a2 = -rr * rr; r.norm = (1 - rr) * 2;
  }
  ring(r, x) { const y = r.a1 * r.y1 + r.a2 * r.y2 + x * r.norm; r.y2 = r.y1; r.y1 = y; return y * r.g; }
  render(L, R, n, p) {
    const sr = this.sr, k = 1 - Math.exp(-1 / (0.04 * sr));
    const base = 650 + 380 * Math.min(1, p.pitch) + 3.5 * Math.min(40, p.speed);
    for (const v of this.voices) {
      // slow random drift of the mode frequencies (+-4 %), retuned once per block
      v.drift = Math.max(-0.04, Math.min(0.04, v.drift + (this.rand() - 0.5) * 0.004));
      const f = base * v.detune * (1 + v.drift);
      v.modes[0].f = f; v.modes[1].f = f * 2.01; v.modes[2].f = f * 2.97;
      v.modes.forEach((m) => this.tune(m));
    }
    const chatRate = Math.min(260, 14 + p.speed * 8);
    for (let i = 0; i < n; ++i) {
      this.sq += (p.squeal - this.sq) * k; this.sc += (p.scrub - this.sc) * k;
      let l = 0, r = 0;
      if (this.sq > 1e-4) {
        for (const v of this.voices) {
          // stick-slip flutter: low-passed, rectified noise -> irregular 10-40 Hz level changes
          v.flut += (Math.abs(this.rand() * 2 - 1) * 2 - v.flut) * 0.004;
          v.flutLp += (v.flut - v.flutLp) * 0.02;
          const w = this.rand() * 2 - 1;
          let y = 0;
          for (const m of v.modes) y += this.ring(m, w);
          y *= 1.2 * (0.35 + 0.9 * v.flutLp) * this.sq;
          l += y * (1 - v.pan); r += y * v.pan;
        }
      }
      if (this.sc > 1e-4) {
        // tread-block chatter with jittered rate
        this.chat += (chatRate * (0.85 + 0.3 * this.rand())) / sr;
        if (this.chat > 1) { this.chat -= 1; this.chatAmp = 0.5 + 0.7 * this.rand(); }
        const env = this.chatAmp * (0.5 + 0.5 * Math.sin(2 * Math.PI * this.chat));
        const w = this.rand() * 2 - 1;
        let rasp = 0;
        for (const q of this.scr) rasp += this.ring(q, w);
        this.rum += (w - this.rum) * 0.015;
        const y = (rasp * (0.45 + 0.55 * env) * 2.2 + this.rum * 1.4) * this.sc * 0.15;
        l += y; r += y;
      }
      // soften the very top so it never turns into hiss
      this.lpL += (l - this.lpL) * 0.55; this.lpR += (r - this.lpR) * 0.55;
      L[i] = Math.tanh(this.lpL * 1.1); R[i] = Math.tanh(this.lpR * 1.1);
    }
  }
}

// Never let one bad value kill the sound: inputs are sanitised, and if the synth state ever goes
// non-finite (or throws), it is rebuilt and this block is output as silence.
function fin(x, d) { return Number.isFinite(x) ? x : d; }
function safeRender(proc, make, L, R, p) {
  try { proc.s.render(L, R, L.length, p); } catch { L.fill(0); R.fill(0); proc.s = make(); return; }
  if (!Number.isFinite(L[0]) || !Number.isFinite(L[L.length - 1]) || !Number.isFinite(R[L.length - 1])) {
    L.fill(0); if (R !== L) R.fill(0); proc.s = make();
  }
}
if (typeof registerProcessor !== 'undefined') {
  registerProcessor('v8-engine', class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
        { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        { name: 'limiter', defaultValue: 7200, minValue: 1000, maxValue: 20000, automationRate: 'k-rate' },
        { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        { name: 'interior', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      ];
    }
    constructor() {
      super(); this.voice = null; this.s = new EngineSynth(sampleRate); this.n = 0;
      // a new car: swap the voice (validated by the constructor; a bad one falls back to default)
      this.port.onmessage = (e) => {
        if (!e.data || !e.data.voice) return;
        try { this.s = new EngineSynth(sampleRate, 7, e.data.voice); this.voice = e.data.voice; } catch { this.s = new EngineSynth(sampleRate); this.voice = null; }
      };
    }
    process(_in, outputs, P) {
      const o = outputs[0];
      const L = o[0], R = o[1] || o[0];
      safeRender(this, () => new EngineSynth(sampleRate, 7, this.voice), L, R, { rpm: fin(P.rpm[0], 900), load: fin(P.load[0], 0), limiter: fin(P.limiter[0], 9000), cut: fin(P.cut[0], 0), interior: fin(P.interior[0], 0) });
      if (++this.n % 200 === 0) this.port.postMessage(0); // heartbeat (~every 0.5 s)
      return true;
    }
  });
}
if (typeof registerProcessor !== 'undefined') {
  registerProcessor('tyre-noise', class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return ['squeal', 'scrub', 'pitch', 'speed'].map((name) => ({ name, defaultValue: 0, minValue: 0, maxValue: 200, automationRate: 'k-rate' }));
    }
    constructor() { super(); this.s = new TyreSynth(sampleRate); }
    process(_in, outputs, P) {
      const o = outputs[0], L = o[0], R = o[1] || o[0];
      safeRender(this, () => new TyreSynth(sampleRate), L, R, { squeal: fin(P.squeal[0], 0), scrub: fin(P.scrub[0], 0), pitch: fin(P.pitch[0], 0), speed: fin(P.speed[0], 0) });
      return true;
    }
  });
}
if (typeof module !== 'undefined') module.exports = { EngineSynth, TyreSynth, DEFAULT_VOICE };


