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
  cycleJitter: 0,         // cycle-to-cycle combustion timing variation (crank degrees, rms):
                          // smears the upper harmonics into a natural roll-off, keeps the note
  res: [[92, 6, 0.016, 0.9], [300, 14, 0.007, 0.55], [690, 25, 0.0045, 0.5], [1480, 60, 0.003, 0.32], [3100, 120, 0.0016, 0.16]], // [f, bank detune, tau, gain]
  comb: [0.0093, 0.0004], // pipe delay (s) and the second bank's extra length
  combFb: 0.35,
  intake: [[1900, 0.0025, 1], [3600, 0.0012, 0.5]],
  pulseW: 0.0005,         // s
  whineOrder: 24,
  whineGain: 1,           // valvetrain / gear whine level
  stereo: 0.72,           // share of a bank in its own channel (0.5 = one merged exhaust)
  turbo: 0,               // 0..1: pulse damping, compressor whistle, blow-off
  turboWhistle: 1,        // whistle level relative to the turbo amount
  crackle: 1,             // overrun pops
  hybrid: 0,              // electric motor whine (orders of engine speed)
  hybridOrder: 9,
  interior: 0.16,         // cabin low-pass coefficient (lower = better insulated)
  drive: 1,               // saturation scale
  gain: 1,
  lowpass: 0,             // Hz: a 12 dB/oct roll-off on the output (0 = off); mufflers, filters
  highpass: 0,            // Hz: a 12 dB/oct cut below this (0 = off): no subsonic boom that small
                          // speakers can't play and only distort on
  rasp: 0,                // turbulent exhaust flow noise riding each pulse (the grit of a
  raspFreq: 2600,         // free-flowing exhaust at load), centred here (Hz)
  idleRough: 0,           // combustion varies far more cycle to cycle at idle than at full load:
                          // extra pulse-strength and timing spread at low load (0..1)
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
    this.cycTime = new Float64Array(this.nEv);   // this cycle's combustion variation per event
    this.newCycle();
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
      rasp: mk(V.raspFreq, 0.00035, 1),
      hp: 0, hpx: 0, lp: 0, zx: 0, zh: 0,
    }));
    this.banks.forEach((bk) => { bk.res.forEach((r) => this.tune(r)); this.tune(bk.rasp); });
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
    // optional output low-pass (RBJ biquad, Q 0.707), one per channel
    const biquad = (f, hp) => {
      const w0 = 2 * Math.PI * Math.min(f, 0.45 * sr) / sr, al = Math.sin(w0) / (2 * Math.SQRT1_2), cw = Math.cos(w0), a0 = 1 + al;
      const b0 = (hp ? (1 + cw) : (1 - cw)) / 2 / a0;
      return { b0, b1: (hp ? -2 : 2) * b0, b2: b0, a1: -2 * cw / a0, a2: (1 - al) / a0, st: [[0, 0, 0, 0], [0, 0, 0, 0]] };
    };
    this.olp = V.lowpass > 0 ? biquad(V.lowpass, false) : null;
    this.ohp = V.highpass > 0 ? biquad(V.highpass, true) : null;
  }
  // Fresh cycle-to-cycle timing variation (Gaussian, crank degrees -> fraction of 720 deg).
  newCycle() {
    const sd = (this.v.cycleJitter + 6 * this.v.idleRough * Math.max(0, 1 - 2.5 * (this.load || 0))) / 720;
    for (let c = 0; c < this.nEv; ++c) {
      if (!sd) { this.cycTime[c] = 0; continue; }
      const g = Math.sqrt(-2 * Math.log(1 - this.rand())) * Math.cos(2 * Math.PI * this.rand());
      this.cycTime[c] = Math.max(-3, Math.min(3, g)) * sd;
    }
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
      if (this.phase >= 1) { this.phase -= 1; this.nextEvent = 0; this.newCycle(); }
      // Firing events at their crank angles, each down its own bank's exhaust. Event times are
      // kept to a fraction of a sample: rounding them would smear the high harmonics into noise
      // at high rpm.
      const ev = this.v.events;
      while (this.nextEvent < this.nEv && this.phase >= ev[this.nextEvent][0] + this.cylTime[this.nextEvent] + this.cycTime[this.nextEvent]) {
        const c = this.nextEvent;
        const ago = (this.phase - (ev[c][0] + this.cylTime[c] + this.cycTime[c])) / dp; // samples since the event
        this.nextEvent++;
        const bk = this.banks[ev[c][1]];
        const cutNow = Math.max(this.cutS, limiterCut);
        // Combustion strength: strong on load, weak pumping pulses when coasting.
        let e = (0.2 + 0.8 * Math.pow(load, 0.8)) * this.cylAmp[c] * (0.98 + 0.04 * this.rand());
        if (this.v.idleRough > 0) e *= 1 + this.v.idleRough * Math.max(0, 1 - 2.5 * load) * (this.rand() * 1.2 - 0.6);
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
        // flow noise: turbulence gated by the pulse passing through the pipe
        if (this.v.rasp > 0) y += this.ring(bk.rasp, (this.rand() * 2 - 1) * x) * this.v.rasp * (0.25 + 0.75 * load) * (0.3 + 0.7 * rpmN);
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
      let wh = Math.sin(2 * Math.PI * this.whine) * 0.012 * rpmN * this.v.whineGain;
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
        for (const f of [this.olp, this.ohp]) {
          if (!f) continue;
          const z = f.st[b], x = out[b];
          const y = f.b0 * x + f.b1 * z[0] + f.b2 * z[1] - f.a1 * z[2] - f.a2 * z[3];
          z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = y;
          out[b] = y;
        }
      }
      const loud = 0.42 * (0.55 + 0.45 * Math.min(1, rpmN * 1.3)) * this.v.gain;
      const st = this.v.stereo;
      L[i] = Math.tanh((out[0] * st + out[1] * (1 - st)) * loud);
      R[i] = Math.tanh((out[1] * st + out[0] * (1 - st)) * loud);
    }
  }
}

// Tyre noise, from how tyres actually make it rather than as a whistle.
//
// Squeal is a friction-induced vibration: near the grip peak the tread at the trailing edge of
// the contact patch sticks, is dragged, and slips, over and over (stick-slip), and each slip
// rings the tread-block / belt modes. So, per tyre:
//  - a tone whose fundamental sits around 0.5-1.1 kHz and rises with the sliding speed of the
//    patch (stick-slip runs faster when the road drags the tread faster) and a little with load:
//    a locked-wheel skid falls in pitch as the car slows, a drift howls steadily;
//  - mode hopping: the vibration locks onto one of a few nearby modes and jumps between them
//    (the warble of a real squeal), with fast and slow pitch jitter on top;
//  - a stick-slip waveform (a slow ramp and a fast release): many overtones, slightly stretched
//    (inharmonic) because the modes are not a string's;
//  - chirping at the onset: just below the peak the squeal comes and goes in bursts; past it,
//    it holds;
//  - sliding hiss: rubber sliding on the texture of the road, broadband and brighter with speed,
//    with grit (tread tearing on coarse asphalt) and a low roar for a locked or spinning tyre;
//  - surface: smooth concrete squeals clearly, coarse asphalt mostly hisses, water kills the
//    squeal (the film lubricates the stick-slip) and leaves a swish;
//  - radiation: the wedge between the tyre and the road is a horn that lifts ~1-3 kHz, the road
//    reflects (a short delayed copy), and very little comes out below ~200 Hz.
// Four voices (one per tyre), panned by corner. Everything is noise-driven and seeded, so no two
// squeals repeat. No samples.
//
// 'tyre-squeal' parameters (k-rate), per tyre k = 0 FL, 1 FR, 2 RL, 3 RR:
//   s<k>  squeal drive 0..1 (how close to / past the grip peak, x load)
//   v<k>  sliding speed of the contact patch, m/s
//   h<k>  sliding hiss 0..1 (well past the peak, locked or spinning)
//   r<k>  surface roughness 0..1 (0 polished concrete .. 1 coarse chip seal)
// and wet 0..1, interior 0..1 (heard from the cabin).
// 'tyre-noise' keeps the old interface (squeal, scrub, pitch, speed) on the same voices.

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  set(type, f, q, sr, gainDb = 0) {
    const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; } // peaking
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const MODES = [1, 1, 1.07, 0.94, 1.15];  // the nearby modes a squeal hops between (ratios; the first, twice as likely)
const NH = 6;                         // overtones of the stick-slip waveform
// sine table (linear interpolation) for the overtones: the audio thread's budget is tight
const SIN_N = 4096, SIN = new Float32Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; ++i) SIN[i] = Math.sin((2 * Math.PI * i) / SIN_N);
function fsin(ph) { const x = ph * (SIN_N / 6.283185307179586), i = x | 0; return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i); }

class TyreVoice {
  constructor(sr, rand, pan, flavour) {
    this.sr = sr; this.rand = rand; this.pan = pan; this.flavour = flavour;
    this.ph = new Float64Array(NH);
    this.amp = new Float64Array(NH);
    this.stretch = new Float64Array(NH);
    for (let k = 0; k < NH; ++k) this.stretch[k] = (k + 1) * (1 + 0.0045 * ((k + 1) * (k + 1) - 1));
    for (let k = 0; k < NH; ++k) this.ph[k] = rand() * 2 * Math.PI;
    this.freq = 600 * flavour; this.mode = 0; this.dwell = 0;
    // random lines: a new random target every `period` s, approached with time constant `tau`
    const line = (period, tau) => ({ v: 0, t: 0, timer: 0, period, k: 1 - Math.exp(-1 / (tau * sr)) });
    this.wander = line(0.15, 0.05);   // slow pitch wander (~4-6 Hz)
    this.flutter = line(0.014, 0.004); // fast pitch flutter (~40-70 Hz)
    this.rough = line(0.02, 0.005);    // stick-slip amplitude roughness
    this.gate = 0; this.env = 0;
    this.S = 0; this.V = 0; this.H = 0; this.Rf = 0.5;
    this.hissA = new Biquad(); this.hissB = new Biquad(); this.roar = new Biquad(); this.grit = new Biquad().set('bp', 2600, 3, sr);
    this.gritE = 0;
  }
  step(l, lo, hi) {
    if ((l.timer -= 1 / this.sr) <= 0) { l.timer = l.period * (0.5 + this.rand()); l.t = lo + (hi - lo) * this.rand(); }
    l.v += (l.t - l.v) * l.k;
    return l.v;
  }
  // Once per block (128 samples, ~2.7 ms): smooth the drives and precompute everything that
  // changes slowly; the per-sample loop only ramps between blocks.
  params(S, V, H, R, wet) {
    const sr = this.sr;
    this.tS = S * (1 - 0.95 * wet); this.tH = H; this.Rf = R; this.wet = wet;
    const a = 0.11, av = 0.05;   // ~23 ms (drives), ~55 ms (sliding speed)
    this.S0 = this.S; this.H0 = this.H;
    this.S += (this.tS - this.S) * a; this.H += (this.tH - this.H) * a; this.V += (V - this.V) * av;
    const Vc = Math.max(0, this.V);
    this.hissA.set('bp', 900 + 160 * Math.min(Vc, 25), 0.8, sr);
    this.hissB.set('bp', 3600 + 40 * Math.min(Vc, 25), 1.4, sr);
    this.roar.set('lp', 220 + 12 * Math.min(Vc, 25), 0.7, sr);
    const p = 2.1 - 0.5 * Math.min(1, Vc / 10);
    for (let k = 0; k < NH; ++k) this.amp[k] = 1 / Math.pow(k + 1, p);
    // per-block levels (the sample loop ramps from the last block's)
    const tonal = (1 - 0.62 * R);
    this.toneA0 = this.toneA ?? 0;
    this.toneA = 0.42 * Math.pow(Math.max(0, this.S), 0.8) * tonal;
    this.hissL0 = this.hissL ?? 0;
    this.hissL = (this.H + 0.18 * this.S) * (0.45 + 0.55 * R) * Math.min(1, 0.25 + Vc / 6) * 0.32;
    this.roarL0 = this.roarL ?? 0;
    this.roarL = this.H * Math.min(1, Vc / 12) * 1.6 * (1 - 0.5 * wet);
    this.swish = 0.6 * wet * (this.H + 0.5 * this.S);
    this.gritRate = (Vc * 25 * R * (this.H + 0.3 * this.S)) / sr;
    const pOn = Math.min(1, this.S * 1.6);
    this.pOn = pOn;
    this.offRate = (0.5 + 30 * (1 - pOn)) / sr; this.onRate = (3 + 45 * pOn) / sr;
    this.base = (430 + 700 * (1 - Math.exp(-Vc / 5))) * this.flavour;
    this.stable = Math.min(1, this.S * 1.4);
    this.rough0 = 1 - 0.35 - 0.3 * R;
    this.t = 0;
  }
  active() { return this.S > 2e-4 || this.H > 2e-4 || this.tS > 2e-4 || this.tH > 2e-4; }
  sample() {
    const sr = this.sr, rnd = this.rand;
    const u = (this.t += 1 / 128) > 1 ? 1 : this.t;   // ramp across the block
    let out = 0;
    const toneA = this.toneA0 + (this.toneA - this.toneA0) * u;
    if (toneA > 1e-5) {
      // mode hopping: dwell on a mode for a random time, shorter when the squeal is unstable
      if ((this.dwell -= 1 / sr) <= 0) {
        this.dwell = -Math.log(1e-6 + rnd()) * (0.05 + 0.45 * this.stable);
        if (rnd() < 0.75 - 0.45 * this.stable) this.mode = Math.floor(rnd() * MODES.length);
        else if (rnd() < 0.5) this.mode = 0;
      }
      this.freq += (this.base * MODES[this.mode] - this.freq) * 0.0035;   // ~6 ms glide
      // pitch jitter: a slow wander (+-2.5 %) and a fast flutter (+-0.8 %)
      const f = this.freq * (1 + this.step(this.wander, -0.025, 0.025) + this.step(this.flutter, -0.008, 0.008));
      // chirping: an on/off process whose on-share grows with the drive
      if (this.gate) { if (rnd() < this.offRate) this.gate = 0; }
      else if (rnd() < this.onRate) this.gate = 1;
      this.env += ((this.gate ? 1 : 0.06 * this.pOn) - this.env) * (this.gate ? 0.012 : 0.0016);
      // stick-slip roughness: a random amplitude flutter around 30-70 Hz, deeper on rough roads
      const am = this.step(this.rough, this.rough0, 1);
      // the stick-slip waveform: falling overtone amplitudes (per block), slightly stretched,
      // with a little phase noise so the lines have width
      let y = 0;
      const w0 = (6.283185307179586 * f) / sr, jit = (rnd() - 0.5) * 0.08;
      for (let k = 0; k < NH; ++k) {
        const dw = w0 * this.stretch[k];
        if (dw > 2.8) break;
        let ph = this.ph[k] + dw + jit * (1 + 0.3 * k);
        if (ph >= 6.283185307179586) ph -= 6.283185307179586; else if (ph < 0) ph += 6.283185307179586;
        this.ph[k] = ph;
        y += fsin(ph) * this.amp[k];
      }
      out += y * toneA * this.env * am;
    }
    const hl = this.hissL0 + (this.hissL - this.hissL0) * u, rl = this.roarL0 + (this.roarL - this.roarL0) * u;
    if (hl > 1e-5 || rl > 1e-5) {
      const n = rnd() * 2 - 1;
      // sliding hiss: rubber sliding on the road's texture; coarser roads hiss more
      let hiss = this.hissA.run(n) * 0.9 + this.hissB.run(n) * 0.5;
      // grit: tread tearing on the aggregate, a sparse crackle with sliding speed
      if (rnd() < this.gritRate) this.gritE = 0.5 + rnd();
      if (this.gritE > 1e-3) { this.gritE *= 0.996; hiss += this.grit.run(n * this.gritE) * 1.4; }
      out += hiss * hl;
      // locked or spinning tyre: a low roar
      if (rl > 1e-5) out += this.roar.run(n) * rl;
      // on a wet road a slide is a swish of water instead
      if (this.swish > 0) out += this.hissB.y1 * this.swish;
    }
    return out;
  }
}

class TyreSquealSynth {
  constructor(sr, seed = 23) {
    this.sr = sr;
    let s = seed >>> 0;
    this.rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    // FL, FR, RL, RR: panned by side, each tyre a slightly different "instrument"
    this.voices = [0.3, 0.7, 0.36, 0.64].map((pan, k) => {
      const v = new TyreVoice(sr, this.rand, pan, [1.0, 1.045, 0.94, 0.985][k]);
      v.gl = Math.cos((pan * Math.PI) / 2); v.gr = Math.sin((pan * Math.PI) / 2);
      return v;
    });
    this.lpL = new Biquad(); this.lpR = new Biquad(); this.cab = -1;
    // radiation, per channel: the tyre-road horn (~1-3 kHz lift), no rumble, the road's reflection
    this.rad = [0, 1].map((c) => ({ horn: new Biquad().set('pk', 1700, 0.9, sr, 6), hp: new Biquad().set('hp', 190, 0.7, sr), d: new Float32Array(256), i: 0, lag: Math.round(sr * (0.0007 + 0.0003 * c)) }));
  }
  radiate(c, x) {
    x = c.hp.run(c.horn.run(x));
    c.d[c.i] = x;
    const refl = c.d[(c.i - c.lag + 256) & 255];
    c.i = (c.i + 1) & 255;
    return x + 0.55 * refl;
  }
  render(L, R, n, p) {
    for (let k = 0; k < 4; ++k) this.voices[k].params(p.s[k], p.v[k], p.h[k], p.r[k], p.wet);
    if (this.cab !== p.interior) { this.cab = p.interior; this.lpL.set('lp', 2200 + 9000 * (1 - p.interior), 0.7, this.sr); this.lpR.set('lp', 2200 + 9000 * (1 - p.interior), 0.7, this.sr); }
    const g = 1 - 0.45 * p.interior;
    const act = this.voices.filter((v) => v.active());
    for (let i = 0; i < n; ++i) {
      let l = 0, r = 0;
      for (const v of act) { const y = v.sample(); l += y * v.gl; r += y * v.gr; }
      l = this.radiate(this.rad[0], l); r = this.radiate(this.rad[1], r);
      L[i] = Math.tanh(this.lpL.run(l) * 1.3 * g);
      R[i] = Math.tanh(this.lpR.run(r) * 1.3 * g);
    }
  }
}

// The old two-parameter interface (squeal, scrub, pitch 0..1 = how far past the peak, speed m/s)
// mapped onto the same tyre voices: the squeal and scrub are split over the two front and two
// rear voices, with a sliding speed estimated from how far past the peak the tyres are.
class TyreSynth {
  constructor(sr, seed = 11) { this.q = new TyreSquealSynth(sr, seed); this.p = { s: [0, 0, 0, 0], v: [0, 0, 0, 0], h: [0, 0, 0, 0], r: [0.5, 0.5, 0.5, 0.5], wet: 0, interior: 0 }; }
  render(L, R, n, p) {
    const sq = Math.min(1, p.squeal), sc = Math.min(1, p.scrub);
    const V = 0.8 + 5 * Math.min(1, p.pitch) + Math.min(40, p.speed) * 0.35 * sc;
    for (let k = 0; k < 4; ++k) { this.p.s[k] = sq * (k < 2 ? 0.8 : 1); this.p.v[k] = V * (k < 2 ? 0.9 : 1); this.p.h[k] = sc; }
    this.q.render(L, R, n, this.p);
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
if (typeof registerProcessor !== 'undefined') {
  const names = [];
  for (let k = 0; k < 4; ++k) names.push('s' + k, 'v' + k, 'h' + k, 'r' + k);
  registerProcessor('tyre-squeal', class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [...names, 'wet', 'interior'].map((name) => ({ name, defaultValue: name[0] === 'r' ? 0.5 : 0, minValue: 0, maxValue: 200, automationRate: 'k-rate' }));
    }
    constructor() { super(); this.s = new TyreSquealSynth(sampleRate); this.p = { s: [0, 0, 0, 0], v: [0, 0, 0, 0], h: [0, 0, 0, 0], r: [0.5, 0.5, 0.5, 0.5], wet: 0, interior: 0 }; }
    process(_in, outputs, P) {
      const o = outputs[0], L = o[0], R = o[1] || o[0], p = this.p;
      for (let k = 0; k < 4; ++k) {
        p.s[k] = Math.min(1.5, fin(P['s' + k][0], 0)); p.v[k] = Math.min(60, fin(P['v' + k][0], 0));
        p.h[k] = Math.min(1.5, fin(P['h' + k][0], 0)); p.r[k] = Math.min(1, fin(P['r' + k][0], 0.5));
      }
      p.wet = Math.min(1, fin(P.wet[0], 0)); p.interior = Math.min(1, fin(P.interior[0], 0));
      safeRender(this, () => new TyreSquealSynth(sampleRate), L, R, p);
      return true;
    }
  });
}
if (typeof module !== 'undefined') module.exports = { EngineSynth, TyreSynth, TyreSquealSynth, DEFAULT_VOICE };


