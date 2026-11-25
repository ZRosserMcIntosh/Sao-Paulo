// Web Audio. The engine voice is the driving page's physically inspired synthesizer
// (engine-worklet.js: combustion pulses into exhaust banks), fed the player car's rpm, load and
// shifts from the vehicle core every frame. Tyres, surfaces, wind, sirens, impacts, glass, gear
// changes and radio squelch are synthesized from simulation events. No audio files.
import type { Simulation, ImpactEvent } from './Simulation';
import type { Vehicle } from './vehicle/Vehicle';
import { SURF } from './world/terrain';

// Per tyre, what the squeal synth needs (engine-worklet.js 'tyre-squeal'): how close the tyre is
// to and past its grip peak, the sliding speed of its contact patch, how hard it is sliding, and
// how rough the surface is. Loose surfaces don't squeal (the gravel noise covers them).
const ROUGH: Record<number, number> = {
  [SURF.ASPHALT]: 0.5, [SURF.SHOULDER]: 0.68, [SURF.CONCRETE]: 0.18, [SURF.PAD]: 0.28, [SURF.DECK]: 0.22, [SURF.COUNTY]: 0.62,
};
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export interface TyreInputs { s: number[]; v: number[]; h: number[]; r: number[]; loose: number }
export function tyreInputs(veh: Vehicle, out: TyreInputs): TyreInputs {
  out.loose = 0;
  const speed = veh.speed;
  for (let k = 0; k < 4; ++k) {
    const w = veh.wheels[k];
    out.s[k] = 0; out.v[k] = 0; out.h[k] = 0; out.r[k] = 0.5;
    if (!w || !w.contact) continue;
    const kappa = Math.abs(w.slipRatio), alpha = Math.abs(w.slipAngle);
    const norm = Math.max(kappa / 0.12, alpha / 0.12);   // 1 = at the peak of the tyre curve
    const vs = Math.hypot(w.omega * w.radius - speed, Math.tan(Math.min(1.4, alpha)) * Math.abs(speed));
    const loadF = Math.max(0.4, Math.min(1.4, w.load / 4500));
    const rough = ROUGH[w.surface];
    if (rough === undefined) { if (w.surface !== SURF.PUDDLE) { out.loose += Math.min(1, norm); continue; } }
    const puddle = w.surface === SURF.PUDDLE ? 1 : 0;
    // squeal: from just below the peak, strongest at and a little past it, fading into a slide
    const bell = smooth(0.72, 1.12, norm) * (norm < 2.6 ? 1 : Math.max(0.4, 1 - (norm - 2.6) / 4));
    out.s[k] = bell * Math.min(1, vs / 1.4) * loadF * (1 - 0.85 * puddle);
    // sliding hiss: well past the peak, a locked or spinning tyre
    let h = smooth(1.6, 4.2, norm) * Math.min(1, vs / 4) * loadF;
    if (w.locked) h = Math.max(h, Math.min(1, Math.abs(speed) / 10) * loadF);
    out.h[k] = h * (1 - 0.4 * puddle);
    out.v[k] = vs;
    out.r[k] = rough ?? 0.5;
  }
  return out;
}

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

export interface AudioMix { engine: number; tyres: number; impacts: number; sirens: number; radio: number }

export class GameAudio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private engine: AudioWorkletNode | null = null;
  private engine2: AudioWorkletNode | null = null;
  private tyres: AudioWorkletNode | null = null;
  private tyres2: AudioWorkletNode | null = null; // the nearest other car's tyres
  private tyres2Gain!: GainNode;
  private tyres2Pan!: StereoPannerNode;
  private ti: TyreInputs = { s: [0, 0, 0, 0], v: [0, 0, 0, 0], h: [0, 0, 0, 0], r: [0.5, 0.5, 0.5, 0.5], loose: 0 };
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
  mix: AudioMix = { engine: 1, tyres: 1, impacts: 1, sirens: 1, radio: 0.8 };
  private bus = {} as Record<keyof AudioMix, GainNode>;
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
      // mix buses (Settings > Audio)
      for (const k of Object.keys(this.mix) as (keyof AudioMix)[]) { const g = ctx.createGain(); g.gain.value = this.mix[k]; g.connect(this.master); this.bus[k] = g; }
      // white noise buffer
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; ++i) d[i] = Math.random() * 2 - 1;
      const loop = (filterType: BiquadFilterType, f: number, q: number) => {
        const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
        const fl = ctx.createBiquadFilter(); fl.type = filterType; fl.frequency.value = f; fl.Q.value = q;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(fl).connect(g).connect(this.bus.tyres); src.start();
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
        o1.connect(f); o2.connect(f); f.connect(g).connect(this.bus.sirens);
        o1.start(); o2.start();
        this.siren = { o1, o2, g, f };
        const s1 = ctx.createOscillator(); s1.type = 'sawtooth';
        const g2 = ctx.createGain(); g2.gain.value = 0;
        const pan = ctx.createStereoPanner();
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
        s1.connect(lp).connect(g2).connect(pan).connect(this.bus.sirens); s1.start();
        this.siren2 = { o1: s1, g: g2, pan };
      }
      {
        const g = ctx.createGain(); g.gain.value = 0;
        for (const fq of [392, 494]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = fq; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800; o.connect(f).connect(g); o.start(); }
        g.connect(this.bus.sirens);
        this.horn = { g };
      }
      this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0.55; this.engineGain.connect(this.bus.engine);
      this.engine2Gain = ctx.createGain(); this.engine2Gain.gain.value = 0; this.engine2Gain.connect(this.bus.engine);
      try {
        await ctx.audioWorklet.addModule(this.base + 'engine-worklet.js');
        this.engine = new AudioWorkletNode(ctx, 'v8-engine', { outputChannelCount: [2] });
        this.engine.port.postMessage({ voice: HEMI });
        this.engine.connect(this.engineGain);
        this.engine2 = new AudioWorkletNode(ctx, 'v8-engine', { outputChannelCount: [2] });
        this.engine2.port.postMessage({ voice: SMALL });
        this.engine2.connect(this.engine2Gain);
        this.tyres = new AudioWorkletNode(ctx, 'tyre-squeal', { outputChannelCount: [2] });
        const tg = ctx.createGain(); tg.gain.value = 0.55;
        this.tyres.connect(tg).connect(this.bus.tyres);
        this.tyres2 = new AudioWorkletNode(ctx, 'tyre-squeal', { outputChannelCount: [2] });
        this.tyres2Gain = ctx.createGain(); this.tyres2Gain.gain.value = 0;
        this.tyres2Pan = ctx.createStereoPanner();
        this.tyres2.connect(this.tyres2Gain).connect(this.tyres2Pan).connect(this.bus.tyres);
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

  setMix(m: AudioMix) {
    this.mix = { ...m };
    if (!this.ctx) return;
    for (const k of Object.keys(m) as (keyof AudioMix)[]) this.bus[k]?.gain.setTargetAtTime(m[k], this.ctx.currentTime, 0.05);
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
    // tyres: per tyre, from the core's slip, load and surface (see tyreInputs)
    const spd = Math.hypot(p.v.x, p.v.z);
    const wet = Math.min(1, sim.weather.rain * 1.2);
    const feed = (node: AudioWorkletNode | null, veh: Vehicle | null, inside: number) => {
      if (!node) return 0;
      const ti = veh ? tyreInputs(veh, this.ti) : null;
      for (let k = 0; k < 4; ++k) {
        this.P(node, 's' + k, frozen || !ti ? 0 : ti.s[k]);
        this.P(node, 'h' + k, frozen || !ti ? 0 : ti.h[k]);
        this.P(node, 'v' + k, ti ? ti.v[k] : 0);
        this.P(node, 'r' + k, ti ? ti.r[k] : 0.5);
      }
      this.P(node, 'wet', wet);
      this.P(node, 'interior', inside);
      return ti ? ti.loose : 0;
    };
    const loose = feed(this.tyres, p, interior);
    if (near && nd < 70) {
      feed(this.tyres2, near, 0);
      const dx = near.p.x - p.p.x, dz = near.p.z - p.p.z, d = Math.max(1, Math.hypot(dx, dz));
      const fx = Math.cos(-p.heading()), fz = Math.sin(-p.heading());
      this.tyres2Gain?.gain.setTargetAtTime(0.5 / (1 + d / 14), t, 0.05);
      this.tyres2Pan?.pan.setTargetAtTime(Math.max(-1, Math.min(1, (dx * -fz + dz * fx) / d)), t, 0.05);
    } else { feed(this.tyres2, null, 0); this.tyres2Gain?.gain.setTargetAtTime(0, t, 0.1); }
    this.gravel.g.gain.setTargetAtTime(frozen ? 0 : Math.min(0.4, (0.25 + loose / 4) * (p.wheels.some((w) => w.contact && ROUGH[w.surface] === undefined && w.surface !== SURF.PUDDLE) ? 1 : 0) * spd * 0.03), t, 0.05);
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
    o.connect(g).connect(this.bus.engine); o.start(t); o.stop(t + 0.15);
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
      src.connect(fl).connect(g).connect(this.bus.impacts);
      src.start(t, Math.random()); src.stop(t + dur + 0.05);
    };
    if (e.kind === 'glass') {
      for (let i = 0; i < 7; ++i) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2500 + Math.random() * 5000;
        const g = ctx.createGain(); const t0 = t + Math.random() * 0.35;
        g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.08 * k, t0 + 0.002); g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.2);
        o.connect(g).connect(this.bus.impacts); o.start(t0); o.stop(t0 + 0.25);
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
      src.connect(fl).connect(g).connect(this.bus.radio); src.start(t); src.stop(t + 0.3);
      const beep = ctx.createOscillator(); beep.frequency.value = 1300; const bg = ctx.createGain();
      bg.gain.setValueAtTime(0, t + 0.24); bg.gain.linearRampToValueAtTime(0.05, t + 0.25); bg.gain.setValueAtTime(0.05, t + 0.33); bg.gain.linearRampToValueAtTime(0, t + 0.34);
      beep.connect(bg).connect(this.bus.radio); beep.start(t + 0.24); beep.stop(t + 0.4);
    }
    if (this.voice && typeof speechSynthesis !== 'undefined' && this.volume * this.mix.radio > 0.05) {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text.replace(/\*/g, ''));
        u.rate = 1.12; u.pitch = 0.85; u.volume = Math.min(1, this.volume * this.mix.radio * 0.9);
        setTimeout(() => speechSynthesis.speak(u), 350);
      } catch { /* no voice */ }
    }
  }
}
