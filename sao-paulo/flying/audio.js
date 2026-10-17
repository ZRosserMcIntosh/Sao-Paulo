// São Paulo World · flight test bed: synthesized sound (no recordings).
// Engine: a four-cylinder four-stroke fires twice per crank revolution, and the
// two-blade propeller passes twice per revolution, so both live at rpm/30 Hz;
// harmonics through a body resonance, louder with manifold pressure. Wind: noise
// rising with dynamic pressure. Stall warning: the 172's pneumatic reed horn.
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
    this.on = true;
  }

  stop() { if (this.ctx) this.ctx.suspend(); this.on = false; }
  setVolume(v) { this.vol = v; if (this.master) this.master.gain.value = v; }

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
    this.on = true;
  }

  stop() { if (this.ctx) this.ctx.suspend(); this.on = false; }
  setVolume(v) { this.vol = v; if (this.master) this.master.gain.value = v; }

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
