// Web Audio. The engine voice is the driving page's physically inspired synthesizer
// (engine-worklet.js: combustion pulses into exhaust banks), fed the player car's rpm, load and
// shifts from the vehicle core every frame. Tyres, surfaces, wind, sirens, impacts, glass, gear
// changes and radio squelch are synthesized from simulation events. No audio files.
import type { Simulation, ImpactEvent } from './Simulation';
import type { Vehicle } from './vehicle/Vehicle';
import { SURF } from './world/terrain';

// Cross-plane naturally aspirated V8 (the interceptor): bank order L R L R R L R L gives each bank
// uneven pulses, the muscle-car burble. Big bores and long pipes: low resonances. Design estimate.
const HEMI = {
  events: [[0, 0], [1 / 8, 1], [2 / 8, 0], [3 / 8, 1], [4 / 8, 1], [5 / 8, 0], [6 / 8, 1], [7 / 8, 0]],
  jitter: 0.01,
  cycleJitter: 1.2,
  idleRough: 0.5,
  res: [[72, 5, 0.02, 1.0], [230, 12, 0.009, 0.65], [520, 20, 0.0055, 0.45], [1150, 45, 0.003, 0.22], [2500, 100, 0.0016, 0.1]],
  comb: [0.0112, 0.0006],
  intake: [[1500, 0.0026, 1], [3000, 0.0012, 0.4]],
  whineOrder: 22, whineGain: 0.4,
  stereo: 0.7,
  turbo: 0,
  crackle: 1.3,
  interior: 0.14,
  drive: 1.0,
  gain: 1.0,
  rasp: 0.6, raspFreq: 2400,
  highpass: 30,
};
const SMALL = { ...HEMI, events: Array.from({ length: 6 }, (_, k) => [k / 6, k & 1]), res: [[110, 6, 0.014, 0.8], [360, 14, 0.007, 0.5], [800, 25, 0.004, 0.35], [1700, 60, 0.0025, 0.2]], comb: [0.008, 0.0003], crackle: 0.3, rasp: 0.2 };

export class GameAudio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private engine: AudioWorkletNode | null = null;
  private engine2: AudioWorkletNode | null = null;
  private tyres: AudioWorkletNode | null = null;
  private engineGain!: GainNode;
  private engine2Gain!: GainNode;
  private noise!: AudioBuffer;
  private wind!: { g: GainNode; f: BiquadFilterNode };
  private gravel!: { g: GainNode; f: BiquadFilterNode };
  private siren!: { o1: OscillatorNode; o2: OscillatorNode; g: GainNode; f: BiquadFilterNode };
  private siren2!: { o1: OscillatorNode; g: GainNode; pan: StereoPannerNode };
  private horn!: { g: GainNode };
  private lastGear = 1;
  private sirenPhase = 0;
  private sirenMode = 0;
  private unsub: (() => void) | null = null;
  private failed = false;
  volume = 0.7;
  voice = true;

  constructor(private readonly base: string) {}

  async start(sim: Simulation) {
    if (this.ctx || this.failed) return;
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(comp).connect(ctx.destination);
      // white noise buffer
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; ++i) d[i] = Math.random() * 2 - 1;
      const loop = (filterType: BiquadFilterType, f: number, q: number) => {
        const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
        const fl = ctx.createBiquadFilter(); fl.type = filterType; fl.frequency.value = f; fl.Q.value = q;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(fl).connect(g).connect(this.master); src.start();
        return { g, f: fl };
      };
      this.wind = loop('bandpass', 500, 0.6);
      this.gravel = loop('bandpass', 1800, 0.8);
      // sirens
      {
        const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
        o1.type = 'sawtooth'; o2.type = 'square';
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 3200;
        const g = ctx.createGain(); g.gain.value = 0;
        o1.connect(f); o2.connect(f); f.connect(g).connect(this.master);
        o1.start(); o2.start();
        this.siren = { o1, o2, g, f };
        const s1 = ctx.createOscillator(); s1.type = 'sawtooth';
        const g2 = ctx.createGain(); g2.gain.value = 0;
        const pan = ctx.createStereoPanner();
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
        s1.connect(lp).connect(g2).connect(pan).connect(this.master); s1.start();
        this.siren2 = { o1: s1, g: g2, pan };
      }
      {
        const g = ctx.createGain(); g.gain.value = 0;
        for (const fq of [392, 494]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = fq; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800; o.connect(f).connect(g); o.start(); }
        g.connect(this.master);
        this.horn = { g };
      }
      this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0.55; this.engineGain.connect(this.master);
      this.engine2Gain = ctx.createGain(); this.engine2Gain.gain.value = 0; this.engine2Gain.connect(this.master);
      try {
        await ctx.audioWorklet.addModule(this.base + 'engine-worklet.js');
        this.engine = new AudioWorkletNode(ctx, 'v8-engine', { outputChannelCount: [2] });
        this.engine.port.postMessage({ voice: HEMI });
        this.engine.connect(this.engineGain);
        this.engine2 = new AudioWorkletNode(ctx, 'v8-engine', { outputChannelCount: [2] });
        this.engine2.port.postMessage({ voice: SMALL });
        this.engine2.connect(this.engine2Gain);
        this.tyres = new AudioWorkletNode(ctx, 'tyre-noise', { outputChannelCount: [2] });
        const tg = ctx.createGain(); tg.gain.value = 0.5;
        this.tyres.connect(tg).connect(this.master);
      } catch (e) {
        console.warn('engine worklet unavailable', e);
      }
      this.unsub = sim.onImpact((e) => this.impact(sim, e));
      if (ctx.state !== 'running') await ctx.resume();
    } catch (e) {
      console.warn('audio unavailable', e);
      this.failed = true;
    }
  }

  setVolume(v: number, muted: boolean) {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  stop() { this.unsub?.(); this.ctx?.close(); this.ctx = null; }

  private P(node: AudioWorkletNode | null, name: string, v: number) {
    if (!node || !this.ctx || !Number.isFinite(v)) return;
    node.parameters.get(name)?.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  update(sim: Simulation, dt: number) {
    const ctx = this.ctx, p = sim.player;
    if (!ctx || !p) return;
    const t = ctx.currentTime;
    const frozen = sim.paused || sim.replayState.active;
    const slow = sim.slowmo ? 0.6 : 1;
    const interior = sim.camera === 'driver' || sim.camera === 'hood' ? 1 : 0;
    // engine
    this.P(this.engine, 'rpm', frozen ? 750 : p.rpm * (sim.slowmo ? 0.75 : 1));
    this.P(this.engine, 'load', frozen ? 0 : p.throttleOut);
    this.P(this.engine, 'limiter', p.cls.params.redlineRpm);
    this.P(this.engine, 'interior', interior);
    this.P(this.engine, 'cut', sim.gsp.heap()[sim.gsp.stateOffset(p.handle) + 24] > 0.5 ? 1 : 0);
    this.engineGain.gain.setTargetAtTime(frozen ? 0.05 : 0.55, t, 0.1);
    if (p.gear !== this.lastGear && !frozen) { this.clunk(0.25); this.lastGear = p.gear; }
    // the nearest other car's engine (the suspect, usually)
    let near: Vehicle | null = null, nd = 80;
    for (const v of sim.vehicles) { if (v === p) continue; const d = Math.hypot(v.p.x - p.p.x, v.p.z - p.p.z); if (d < nd) { nd = d; near = v; } }
    if (near) {
      this.P(this.engine2, 'rpm', near.rpm);
      this.P(this.engine2, 'load', near.throttleOut);
      this.P(this.engine2, 'limiter', near.cls.params.redlineRpm);
      this.engine2Gain.gain.setTargetAtTime(frozen ? 0 : 0.35 * Math.max(0, 1 - nd / 80) ** 2, t, 0.1);
    } else this.engine2Gain.gain.setTargetAtTime(0, t, 0.2);
    // tyres: squeal from the combined slip of the loaded wheels on pavement, scrub on gravel
    let squeal = 0, scrub = 0, loose = 0;
    const spd = Math.hypot(p.v.x, p.v.z);
    for (const w of p.wheels) {
      if (!w.contact) continue;
      const slip = Math.max(Math.abs(w.slipRatio) - 0.08, 0) * 2 + Math.max(Math.abs(w.slipAngle) - 0.07, 0) * 3.5;
      const paved = w.surface === SURF.ASPHALT || w.surface === SURF.PAD || w.surface === SURF.SHOULDER || w.surface === SURF.CONCRETE || w.surface === SURF.DECK || w.surface === SURF.COUNTY;
      if (paved) squeal += Math.min(1, slip) * (w.load / 5000);
      else { scrub += Math.min(1, slip + 0.2); loose += 1; }
    }
    const wet = sim.weather.rain > 0.2;
    this.P(this.tyres, 'squeal', frozen ? 0 : Math.min(1.5, squeal * (wet ? 0.25 : 0.8)) * slow);
    this.P(this.tyres, 'scrub', frozen ? 0 : Math.min(1.5, scrub * 0.4 + (wet ? spd * 0.012 : 0)));
    this.P(this.tyres, 'pitch', 0.9 + Math.min(0.5, spd * 0.006));
    this.P(this.tyres, 'speed', spd);
    this.gravel.g.gain.setTargetAtTime(frozen ? 0 : Math.min(0.4, (loose / 4) * spd * 0.03), t, 0.05);
    this.gravel.f.frequency.setTargetAtTime(900 + spd * 25, t, 0.1);
    // wind
    this.wind.g.gain.setTargetAtTime(frozen ? 0 : Math.min(0.32, (spd / 60) ** 2 * 0.35) * (interior ? 0.4 : 1), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(300 + spd * 14, t, 0.1);
    // player siren: wail, switching to yelp when close to the suspect
    const sus = sim.vehicles.find((v) => v.role === 'suspect');
    const close = sus ? Math.hypot(sus.p.x - p.p.x, sus.p.z - p.p.z) < 30 : false;
    this.sirenMode = close ? 1 : 0;
    const period = this.sirenMode ? 0.32 : 3.6;
    this.sirenPhase = (this.sirenPhase + dt / period) % 1;
    const sweep = this.sirenMode ? (this.sirenPhase < 0.5 ? this.sirenPhase * 2 : 2 - this.sirenPhase * 2) : 0.5 - 0.5 * Math.cos(this.sirenPhase * 2 * Math.PI);
    const f = 640 + sweep * 760;
    this.siren.o1.frequency.setTargetAtTime(f, t, 0.01);
    this.siren.o2.frequency.setTargetAtTime(f * 1.003, t, 0.01);
    this.siren.g.gain.setTargetAtTime(p.siren && !frozen ? (interior ? 0.06 : 0.11) : 0, t, 0.05);
    // the nearest other siren, panned and Doppler-shifted
    let cop: Vehicle | null = null, cd = 350;
    for (const v of sim.vehicles) { if (v === p || !v.siren) continue; const d = Math.hypot(v.p.x - p.p.x, v.p.z - p.p.z); if (d < cd) { cd = d; cop = v; } }
    if (cop && !frozen) {
      const dx = cop.p.x - p.p.x, dz = cop.p.z - p.p.z, d = Math.max(1, Math.hypot(dx, dz));
      const vr = ((cop.v.x - p.v.x) * dx + (cop.v.z - p.v.z) * dz) / d; // + = moving apart
      const dop = 343 / (343 + vr);
      const ph = ((performance.now() / 1000 + cop.id) / 4.2) % 1;
      this.siren2.o1.frequency.setTargetAtTime((660 + 700 * (0.5 - 0.5 * Math.cos(ph * 2 * Math.PI))) * dop, t, 0.02);
      this.siren2.g.gain.setTargetAtTime(0.09 / (1 + d / 25), t, 0.05);
      const fx = Math.cos(-p.heading()), fz = Math.sin(-p.heading());
      this.siren2.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, (dx * -fz + dz * fx) / d)), t, 0.05);
    } else this.siren2.g.gain.setTargetAtTime(0, t, 0.1);
    this.horn.g.gain.setTargetAtTime(sim.input.horn && !frozen ? 0.12 : 0, t, 0.02);
  }

  private clunk(level: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 90;
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level * 0.3, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.1);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.15);
  }

  impact(sim: Simulation, e: ImpactEvent) {
    const ctx = this.ctx;
    if (!ctx) return;
    const p = sim.player;
    const d = p ? Math.hypot(e.x - p.p.x, e.z - p.p.z) : 0;
    const att = 1 / (1 + d / 20);
    const k = Math.min(1, e.strength) * att;
    if (k < 0.01) return;
    const t = ctx.currentTime;
    const burst = (type: BiquadFilterType, f: number, q: number, level: number, dur: number) => {
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      src.connect(fl).connect(g).connect(this.master);
      src.start(t, Math.random()); src.stop(t + dur + 0.05);
    };
    if (e.kind === 'glass') {
      for (let i = 0; i < 7; ++i) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2500 + Math.random() * 5000;
        const g = ctx.createGain(); const t0 = t + Math.random() * 0.35;
        g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.08 * k, t0 + 0.002); g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.2);
        o.connect(g).connect(this.master); o.start(t0); o.stop(t0 + 0.25);
      }
      burst('highpass', 3000, 0.7, 0.4 * k, 0.4);
      return;
    }
    // the body: a low thump, crunch and (metal) ring
    burst('lowpass', 180 + 200 * (1 - e.strength), 0.9, 0.9 * k, 0.25 + 0.3 * e.strength);
    burst('bandpass', 900, 0.8, 0.5 * k, 0.18 + 0.2 * e.strength);
    if (e.kind === 'metal' || e.kind === 'car') { burst('bandpass', 2600 + Math.random() * 1500, 9, 0.35 * k, 0.5); burst('bandpass', 4100, 14, 0.18 * k, 0.6); }
    if (e.kind === 'prop') burst('bandpass', 600, 2, 0.4 * k, 0.15);
    if (e.kind === 'sign') burst('bandpass', 1900, 6, 0.5 * k, 0.5);
  }

  // Dispatch: a squelch, then the line (speech synthesis, if the browser has it)
  radio(text: string) {
    const ctx = this.ctx;
    if (ctx) {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const fl = ctx.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = 2200; fl.Q.value = 1.5;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.01); g.gain.setValueAtTime(0.12, t + 0.18); g.gain.linearRampToValueAtTime(0, t + 0.22);
      src.connect(fl).connect(g).connect(this.master); src.start(t); src.stop(t + 0.3);
      const beep = ctx.createOscillator(); beep.frequency.value = 1300; const bg = ctx.createGain();
      bg.gain.setValueAtTime(0, t + 0.24); bg.gain.linearRampToValueAtTime(0.05, t + 0.25); bg.gain.setValueAtTime(0.05, t + 0.33); bg.gain.linearRampToValueAtTime(0, t + 0.34);
      beep.connect(bg).connect(this.master); beep.start(t + 0.24); beep.stop(t + 0.4);
    }
    if (this.voice && typeof speechSynthesis !== 'undefined' && this.volume > 0.05) {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text.replace(/\*/g, ''));
        u.rate = 1.12; u.pitch = 0.85; u.volume = Math.min(1, this.volume * 0.9);
        setTimeout(() => speechSynthesis.speak(u), 350);
      } catch { /* no voice */ }
    }
  }
}
