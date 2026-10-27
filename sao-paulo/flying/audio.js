// São Paulo World · flight test bed: synthesized sound (no recordings).
// Engine: a four-cylinder four-stroke fires twice per crank revolution, and the
// two-blade propeller passes twice per revolution, so both live at rpm/30 Hz;
// harmonics through a body resonance, louder with manifold pressure. Wind: noise
// rising with dynamic pressure. Stall warning: the 172's pneumatic reed horn.
// Both aircraft classes add the airframe (AirframeSound): the extra wind of
// the gear, flaps and speedbrakes, buffet, the ground roll, the touchdown,
// the flap motor, the gear locks, reverse thrust and a crash.

// One-shot: a gain node's envelope from `peak` down to silence over `dur` s.
function hit(g, t, peak, dur) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(Math.max(peak, 1e-4), t);
  g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
}

export class AirframeSound {
  // ctx, the node to play into, a looping noise source; `jet` sets the flap
  // motor (hydraulic whine) and the speed scale of the wind.
  constructor(ctx, out, noise, jet) {
    this.ctx = ctx; this.jet = jet; this.prev = null;
    const g = (v = 0) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const f = (type, freq, q = 1) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = freq; n.Q.value = q; return n; };
    // The gear's rumble in the airflow (low) and the flaps' and spoilers' hiss (broad).
    this.gearWind = g(); noise.connect(f('lowpass', 220, 0.7)).connect(this.gearWind).connect(out);
    this.dragWind = g(); noise.connect(f('bandpass', 700, 0.4)).connect(this.dragWind).connect(out);
    // Buffet: a low rumble beating at ~12 Hz, the stalled wing's.
    this.buffet = g(); const bAm = g(0.5);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 12; const lfoG = g(0.5); lfo.connect(lfoG).connect(bAm.gain); lfo.start();
    noise.connect(f('lowpass', 90, 1)).connect(bAm).connect(this.buffet).connect(out);
    // The ground roll: runway rumble and the tyres' hum, with the speed.
    this.roll = g(); this.rollF = f('lowpass', 120, 0.8); noise.connect(this.rollF).connect(this.roll).connect(out);
    this.hum = g(); this.humF = f('bandpass', 300, 6); noise.connect(this.humF).connect(this.hum).connect(out);
    // Touchdown: the thump through the gear, the tyres' chirp spinning up.
    this.thump = g(); const to = ctx.createOscillator(); to.type = 'sine'; to.frequency.value = 52; to.connect(this.thump).connect(out); to.start();
    this.thumpN = g(); noise.connect(f('lowpass', 160, 1)).connect(this.thumpN).connect(out);
    this.chirp = g(); noise.connect(f('bandpass', 1700, 4)).connect(this.chirp).connect(out);
    // The flap motor (electric on the 172, the hydraulics' whine on the jets) and the gear's locks.
    this.motor = g(); this.motorO = ctx.createOscillator(); this.motorO.type = jet ? 'sine' : 'sawtooth';
    this.motorO.frequency.value = jet ? 820 : 360; this.motorO.connect(f('bandpass', jet ? 820 : 360, 3)).connect(this.motor).connect(out); this.motorO.start();
    this.clunk = g(); const co = ctx.createOscillator(); co.type = 'triangle'; co.frequency.value = 95; co.connect(this.clunk).connect(out); co.start();
    // Reverse thrust: the roar thrown forward.
    this.rev = g(); noise.connect(f('lowpass', 900, 0.7)).connect(this.rev).connect(out);
    // A crash: a burst of noise and a deep thump.
    this.crash = g(); noise.connect(f('lowpass', 2500, 0.5)).connect(this.crash).connect(out);
  }

  // o: { tas, gs (kt), vs (fpm), nz, flapDeg, flapMax, gear (0..1, fixed: 1), retractable, spoiler (0..1),
  //      onGround, stalled (strips), rev (0..1), crashed, cabin, paused }
  update(o) {
    const t = this.ctx.currentTime, p = this.prev;
    const run = !o.paused;
    const q = Math.min(o.tas / (this.jet ? 250 : 120), 1.4), q2 = q * q * (o.cabin ? 0.55 : 1);
    // Gusts: the wind's roar swells with the load factor's jolts.
    const jolt = p ? Math.min(Math.abs(o.nz - p.nz) * 4, 0.6) : 0;
    this.gearWind.gain.setTargetAtTime(run && o.retractable ? 0.22 * o.gear * q2 : 0, t, 0.3);
    const flapFrac = o.flapMax > 0 ? o.flapDeg / o.flapMax : 0;
    this.dragWind.gain.setTargetAtTime(run ? (0.08 * flapFrac + 0.14 * o.spoiler + 0.05 * jolt) * q2 : 0, t, 0.15);
    this.buffet.gain.setTargetAtTime(run && !o.onGround ? Math.min(o.stalled / 8, 1) * 0.35 * Math.min(q * 1.4, 1) : 0, t, 0.1);
    const gs = Math.min(o.gs / (this.jet ? 140 : 70), 1.3);
    this.roll.gain.setTargetAtTime(run && o.onGround ? 0.18 * Math.min(gs * 2, 1) * (o.cabin ? 1 : 0.7) : 0, t, 0.08);
    this.rollF.frequency.setTargetAtTime(70 + 120 * gs, t, 0.2);
    this.hum.gain.setTargetAtTime(run && o.onGround ? 0.03 * gs : 0, t, 0.1);
    this.humF.frequency.setTargetAtTime(150 + 350 * gs, t, 0.2);
    this.rev.gain.setTargetAtTime(run ? 0.45 * o.rev : 0, t, 0.15);
    if (p && run) {
      // Touchdown: air to ground.
      if (o.onGround && !p.onGround && o.gs > 20) {
        const sink = Math.min(Math.abs(Math.min(p.vs, 0)) / 600, 1.5);
        hit(this.thump, t, 0.25 + 0.5 * sink, 0.35); hit(this.thumpN, t, 0.15 + 0.4 * sink, 0.25);
        hit(this.chirp, t, 0.12 + 0.15 * Math.min(o.gs / 120, 1), 0.22);
      }
      // The flap motor while the flaps move; the gear's lock at either end of its travel.
      const moving = Math.abs(o.flapDeg - p.flapDeg) > 0.004;
      this.motor.gain.setTargetAtTime(moving ? (o.cabin ? 0.05 : 0.025) : 0, t, 0.08);
      if (o.retractable && ((o.gear >= 0.999 && p.gear < 0.999) || (o.gear <= 0.001 && p.gear > 0.001))) hit(this.clunk, t, o.cabin ? 0.35 : 0.15, 0.18);
      if (o.crashed && !p.crashed) { hit(this.crash, t, 0.9, 1.6); hit(this.thump, t, 1.0, 0.8); }
    }
    if (!run) this.motor.gain.setTargetAtTime(0, t, 0.05);
    this.prev = { ...o };
  }
}

export class FlightAudio {
  constructor() { this.ctx = null; this.on = false; this.vol = 0.8; }

  start() {
    if (this.ctx) { this.ctx.resume(); this.on = true; return; }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const master = (this.master = ctx.createGain());
    master.gain.value = this.vol;
    master.connect(ctx.destination);
    // Engine: firing pulse train approximated by stacked harmonics.
    this.eng = ctx.createGain(); this.eng.gain.value = 0;
    const body = ctx.createBiquadFilter(); body.type = 'lowpass'; body.frequency.value = 900; body.Q.value = 1.2;
    this.eng.connect(body).connect(master);
    this.osc = [1, 2, 3, 4, 6].map((h, i) => {
      const o = ctx.createOscillator(); o.type = i === 0 ? 'sawtooth' : 'square';
      const g = ctx.createGain(); g.gain.value = [0.5, 0.28, 0.16, 0.1, 0.05][i];
      o.connect(g).connect(this.eng); o.start(); return { o, h };
    });
    // Noise source shared by the exhaust rasp and the wind.
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; ++i) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    this.rasp = ctx.createGain(); this.rasp.gain.value = 0;
    const raspF = (this.raspF = ctx.createBiquadFilter()); raspF.type = 'bandpass'; raspF.Q.value = 2;
    noise.connect(raspF).connect(this.rasp).connect(master);
    this.wind = ctx.createGain(); this.wind.gain.value = 0;
    const windF = (this.windF = ctx.createBiquadFilter()); windF.type = 'bandpass'; windF.frequency.value = 500; windF.Q.value = 0.6;
    noise.connect(windF).connect(this.wind).connect(master);
    // Stall horn: a reed near 2.9 kHz with a slight beat.
    this.horn = ctx.createGain(); this.horn.gain.value = 0;
    const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 2900; hf.Q.value = 5;
    for (const f of [2905, 2950]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(hf); o.start(); }
    hf.connect(this.horn).connect(master);
    this.airframe = new AirframeSound(ctx, master, noise, false);
    this.on = true;
  }

  stop() { if (this.ctx) this.ctx.suspend(); this.on = false; }
  setVolume(v) { this.vol = v; if (this.master) this.master.gain.value = v; }
  // The airframe's sounds (AirframeSound.update's argument).
  extras(o) { if (this.ctx && this.on && this.airframe) this.airframe.update(o); }

  // rpm, manifold pressure (inHg), true airspeed (kt), stall horn (bool), in cabin (bool)
  update(rpm, map, tas, horn, cabin) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime, k = 0.06;
    const f0 = Math.max(rpm / 30, 1);
    for (const { o, h } of this.osc) o.frequency.setTargetAtTime(f0 * h, t, 0.03);
    const running = rpm > 300;
    const load = Math.min(Math.max((map - 10) / 19, 0), 1);
    this.eng.gain.setTargetAtTime(running ? (0.12 + 0.22 * load) * (cabin ? 1 : 0.8) : 0, t, k);
    this.raspF.frequency.setTargetAtTime(f0 * 8, t, k);
    this.rasp.gain.setTargetAtTime(running ? 0.03 + 0.06 * load : 0, t, k);
    const q = Math.min(tas / 120, 1.4);
    this.windF.frequency.setTargetAtTime(300 + 900 * q, t, 0.2);
    this.wind.gain.setTargetAtTime(0.25 * q * q * (cabin ? 0.6 : 1), t, 0.2);
    this.horn.gain.setTargetAtTime(horn ? 0.08 : 0, t, 0.02);
  }
}

// The Top G: two turbofans. Fan tone and buzz-saw from N1, a high core whine
// from N2, broadband jet roar growing with thrust, wind from the airspeed and
// the stall warning. Cabin listening position muffles the outside sources.
export class JetAudio {
  constructor() { this.ctx = null; this.on = false; this.vol = 0.8; }

  start() {
    if (this.ctx) { this.ctx.resume(); this.on = true; return; }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const master = (this.master = ctx.createGain());
    master.gain.value = this.vol;
    master.connect(ctx.destination);
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; ++i) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    // Cabin muffling for everything engine-related.
    this.muffle = ctx.createBiquadFilter(); this.muffle.type = 'lowpass'; this.muffle.frequency.value = 18000;
    this.muffle.connect(master);
    // Roar.
    this.roar = ctx.createGain(); this.roar.gain.value = 0;
    this.roarF = ctx.createBiquadFilter(); this.roarF.type = 'lowpass'; this.roarF.frequency.value = 600;
    noise.connect(this.roarF).connect(this.roar).connect(this.muffle);
    // Fan: a buzz-saw fundamental with harmonics.
    this.fan = ctx.createGain(); this.fan.gain.value = 0;
    this.fanOsc = [1, 2, 3].map((h, i) => {
      const o = ctx.createOscillator(); o.type = i ? 'triangle' : 'sawtooth';
      const g = ctx.createGain(); g.gain.value = [0.4, 0.2, 0.08][i]; o.connect(g).connect(this.fan); o.start(); return { o, h };
    });
    const fanBody = ctx.createBiquadFilter(); fanBody.type = 'bandpass'; fanBody.Q.value = 0.8; fanBody.frequency.value = 900;
    this.fan.connect(fanBody).connect(this.muffle);
    // Core whine.
    this.whine = ctx.createGain(); this.whine.gain.value = 0;
    this.whineOsc = [1, 1.5].map((m) => { const o = ctx.createOscillator(); o.type = 'sine'; o.connect(this.whine); o.start(); return { o, m }; });
    this.whine.connect(this.muffle);
    // Wind.
    this.wind = ctx.createGain(); this.wind.gain.value = 0;
    const windF = (this.windF = ctx.createBiquadFilter()); windF.type = 'bandpass'; windF.Q.value = 0.5;
    noise.connect(windF).connect(this.wind).connect(master);
    // Stall warning: a fast intermittent tone (with the shaker).
    this.horn = ctx.createGain(); this.horn.gain.value = 0;
    const ho = ctx.createOscillator(); ho.type = 'square'; ho.frequency.value = 1450; ho.start();
    const trem = ctx.createOscillator(); trem.frequency.value = 9; const tg = ctx.createGain(); tg.gain.value = 0.5;
    const hb = ctx.createGain(); hb.gain.value = 0.5; trem.connect(tg).connect(hb.gain); trem.start();
    ho.connect(hb).connect(this.horn).connect(master);
    this.airframe = new AirframeSound(ctx, master, noise, true);
    this.on = true;
  }

  stop() { if (this.ctx) this.ctx.suspend(); this.on = false; }
  setVolume(v) { this.vol = v; if (this.master) this.master.gain.value = v; }
  // The airframe's sounds (AirframeSound.update's argument).
  extras(o) { if (this.ctx && this.on && this.airframe) this.airframe.update(o); }

  // n1, n2: arrays of % per engine; thrustFrac 0..1; tas kt; horn; cabin
  update(n1, n2, thrustFrac, tas, horn, cabin) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime, k = 0.08;
    const a1 = (n1[0] + (n1[1] ?? n1[0])) / 2, a2 = (n2[0] + (n2[1] ?? n2[0])) / 2;
    const fanF = 30 + a1 * 7;
    for (const { o, h } of this.fanOsc) o.frequency.setTargetAtTime(fanF * h, t, k);
    for (const { o, m } of this.whineOsc) o.frequency.setTargetAtTime((1200 + a2 * 38) * m, t, k);
    const spin = Math.min(a2 / 60, 1);
    this.fan.gain.setTargetAtTime(0.05 * spin + 0.12 * (a1 / 100) ** 2, t, k);
    this.whine.gain.setTargetAtTime(0.018 * spin, t, k);
    this.roar.gain.setTargetAtTime(0.02 * spin + 0.35 * thrustFrac ** 1.5, t, k);
    this.roarF.frequency.setTargetAtTime(300 + 1500 * thrustFrac, t, k);
    this.muffle.frequency.setTargetAtTime(cabin ? 1400 : 18000, t, 0.1);
    const q = Math.min(tas / 250, 1.4);
    this.windF.frequency.setTargetAtTime(300 + 1100 * q, t, 0.2);
    this.wind.gain.setTargetAtTime(0.2 * q * q * (cabin ? 0.5 : 1), t, 0.2);
    this.horn.gain.setTargetAtTime(horn ? 0.06 : 0, t, 0.02);
  }
}
