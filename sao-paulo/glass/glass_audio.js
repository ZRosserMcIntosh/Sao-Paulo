// Glass sound: synthesized in the browser (no recordings) and driven by what
// the fracture engine reports: impacts, cracks as they run, a pane crazing,
// shards and dice landing. Each kind of glass has its own voice: annealed
// rings bright and long, tempered bursts into a fizz and rains dice,
// laminates crunch dully, armour thumps. In bullet time everything drops in
// pitch and stretches, the room grows, a drone comes in, and time audibly
// winds down and back up. Cinematic rather than measured.

const TAU = Math.PI * 2;
function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- Synthesis into buffers ----------
function normalize(d, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < d.length; ++i) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; ++i) d[i] *= peak / m;
  return d;
}
function onePoleHP(d, sr, fc) {
  const a = Math.exp(-TAU * fc / sr);
  let y = 0, x1 = 0;
  for (let i = 0; i < d.length; ++i) { const x = d[i]; y = a * (y + x - x1); x1 = x; d[i] = y; }
  return d;
}
function onePoleLP(d, sr, fc) {
  const a = Math.exp(-TAU * fc / sr);
  let y = 0;
  for (let i = 0; i < d.length; ++i) { y = (1 - a) * d[i] + a * y; d[i] = y; }
  return d;
}
function bandpass(d, sr, f0, q) {
  const w = TAU * f0 / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; ++i) {
    const x = d[i], y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; d[i] = y;
  }
  return d;
}
// A struck glass plate: inharmonic plate modes, each decaying on its own.
function plateTone(sr, r, f0, ring, partials = 6) {
  const ratios = [1, 2.32, 4.25, 6.63, 9.38, 13.1, 17.2];
  const dur = 0.05 + 1.6 * ring;
  const d = new Float32Array(Math.ceil(dur * sr));
  for (let k = 0; k < partials; ++k) {
    const f = f0 * ratios[k] * (1 + 0.03 * (r() - 0.5));
    if (f > sr * 0.45) break;
    const tau = ring * (0.35 + 0.4 * r()) / (1 + 0.45 * k), a = (0.6 + 0.4 * r()) / (1 + 0.5 * k), ph = TAU * r();
    for (let i = 0; i < d.length; ++i) { const t = i / sr; d[i] += a * Math.exp(-t / tau) * Math.sin(TAU * f * t + ph); }
  }
  for (let i = 0; i < Math.min(d.length, sr * 0.002); ++i) d[i] += (r() * 2 - 1) * (1 - i / (sr * 0.002)) * 0.8;
  return normalize(d);
}
function snapSound(sr, r) {
  const d = new Float32Array(Math.ceil(0.06 * sr)), f = 4500 + 3500 * r();
  for (let i = 0; i < d.length; ++i) { const t = i / sr; d[i] = (r() * 2 - 1) * Math.exp(-t / 0.004) + 0.5 * Math.exp(-t / 0.02) * Math.sin(TAU * f * t); }
  return normalize(onePoleHP(d, sr, 1200));
}
function grainSound(sr, r) {
  const d = new Float32Array(Math.ceil(0.035 * sr)), f = 3500 + 7000 * r();
  for (let i = 0; i < d.length; ++i) { const t = i / sr; d[i] = Math.exp(-t / (0.004 + 0.008 * r() * 0)) * Math.sin(TAU * f * t) + (i < sr * 0.0006 ? (r() * 2 - 1) : 0); }
  return normalize(d, 0.7);
}
// The dicing front crossing a tempered pane: thousands of tiny fractures in a
// few hundred microseconds, then the dice settling against each other.
function fizzSound(sr, r) {
  const dur = 0.9, d = new Float32Array(Math.ceil(dur * sr));
  for (let k = 0; k < 4000; ++k) {
    const t0 = -Math.log(1 - r() * 0.999) * 0.11, i0 = Math.floor(t0 * sr);
    if (i0 >= d.length) continue;
    const f = 3000 + 9000 * r(), a = Math.exp(-t0 / 0.25) * (0.3 + r()), len = Math.floor(sr * (0.002 + 0.006 * r()));
    for (let i = 0; i < len && i0 + i < d.length; ++i) d[i0 + i] += a * Math.exp(-i / (len * 0.3)) * Math.sin(TAU * f * i / sr);
  }
  return normalize(onePoleHP(d, sr, 900));
}
function crunchSound(sr, r) {
  const d = new Float32Array(Math.ceil(0.32 * sr));
  let g = 0;
  for (let i = 0; i < d.length; ++i) {
    if (r() < 0.004) g = 0.3 + r();
    g *= 0.996;
    d[i] = (r() * 2 - 1) * g * Math.exp(-i / sr / 0.1);
  }
  return normalize(bandpass(d, sr, 1400 + 600 * r(), 0.8));
}
function thudSound(sr, r, f0 = 80) {
  const d = new Float32Array(Math.ceil(0.5 * sr));
  let ph = 0;
  for (let i = 0; i < d.length; ++i) {
    const t = i / sr, f = f0 * (0.65 + 0.35 * Math.exp(-t / 0.05));
    ph += TAU * f / sr;
    d[i] = Math.exp(-t / 0.12) * Math.sin(ph) + (t < 0.01 ? (r() * 2 - 1) * (1 - t / 0.01) * 0.6 : 0);
  }
  return normalize(onePoleLP(d, sr, 900));
}
function boomSound(sr, r) {
  const d = new Float32Array(Math.ceil(2.6 * sr));
  let ph = 0, n = 0;
  for (let i = 0; i < d.length; ++i) {
    const t = i / sr, f = 24 + 38 * Math.exp(-t / 0.35);
    ph += TAU * f / sr;
    n = 0.995 * n + 0.005 * (r() * 2 - 1);
    d[i] = (Math.sin(ph) + 6 * n) * Math.exp(-t / 0.7) * Math.min(1, t / 0.004);
  }
  return normalize(d);
}
// A supersonic bullet's crack: an N-wave a fraction of a millisecond long.
function nWaveSound(sr, r) {
  const d = new Float32Array(Math.ceil(0.18 * sr)), n = Math.max(4, Math.floor(0.0006 * sr));
  for (let i = 0; i < n; ++i) d[i] = 1 - 2 * i / n;
  for (let i = n; i < d.length; ++i) { const t = (i - n) / sr; d[i] += (r() * 2 - 1) * 0.25 * Math.exp(-t / 0.03); }
  return normalize(d);
}
function whineSound(sr, r) {
  const d = new Float32Array(Math.ceil(0.7 * sr));
  let ph = 0;
  for (let i = 0; i < d.length; ++i) {
    const t = i / sr, f = (1100 + 2000 * Math.exp(-t / 0.25)) * (1 + 0.02 * Math.sin(TAU * 31 * t));
    ph += TAU * f / sr;
    d[i] = Math.sin(ph) * Math.exp(-t / 0.22) * Math.min(1, t / 0.01);
  }
  return normalize(d, 0.6);
}
function noiseBuffer(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate), d = b.getChannelData(0), r = rng(9);
  for (let i = 0; i < d.length; ++i) d[i] = r() * 2 - 1;
  return b;
}
function hallImpulse(ctx, seconds) {
  const sr = ctx.sampleRate, n = Math.ceil(seconds * sr), b = ctx.createBuffer(2, n, sr), r = rng(5);
  for (let c = 0; c < 2; ++c) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; ++i) { const t = i / sr; d[i] = (r() * 2 - 1) * Math.pow(1 - i / n, 2.2) * (t < 0.012 ? 0.3 : 1); }
    onePoleLP(d, sr, 6000);
  }
  return b;
}

// ---------- The engine ----------
export class GlassAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.slow = 1;           // pitch / stretch factor from the playback speed
    this.scale = 1;
    this.voices = 0;
    this.pending = [];       // [engine time, count, pan] of dice due to land
    this.lastWarp = -10;
    this.crackBudget = 8;
    this.frameDt = 1 / 60;
  }
  // Call from a user gesture (browsers start audio only then).
  start() {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      this.build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  setEnabled(on) {
    this.enabled = on;
    if (on) this.start();
    else if (this.ctx) this.ctx.suspend();
  }
  get live() { return this.enabled && this.ctx && this.ctx.state === 'running'; }
  build() {
    const c = this.ctx, sr = c.sampleRate, r = rng(2024);
    const buf = (d) => { const b = c.createBuffer(1, d.length, sr); b.getChannelData(0).set(d); return b; };
    this.bank = {
      tink: Array.from({ length: 10 }, () => buf(plateTone(sr, r, 1700 + 2200 * r(), 0.28 + 0.35 * r()))),
      clink: Array.from({ length: 8 }, () => buf(plateTone(sr, r, 700 + 1400 * r(), 0.35 + 0.4 * r(), 5))),
      bell: Array.from({ length: 4 }, () => buf(plateTone(sr, r, 260 + 220 * r(), 1.1, 7))),
      snap: Array.from({ length: 8 }, () => buf(snapSound(sr, r))),
      grain: Array.from({ length: 16 }, () => buf(grainSound(sr, r))),
      fizz: Array.from({ length: 3 }, () => buf(fizzSound(sr, r))),
      crunch: Array.from({ length: 5 }, () => buf(crunchSound(sr, r))),
      thud: [buf(thudSound(sr, r, 70)), buf(thudSound(sr, r, 95)), buf(thudSound(sr, r, 130))],
      boom: [buf(boomSound(sr, r))],
      nwave: [buf(nWaveSound(sr, r))],
      whine: [buf(whineSound(sr, r)), buf(whineSound(sr, r))],
    };
    this.noise = noiseBuffer(c, 3);
    // Buses: dry and a hall, into a gentle compressor; a tone filter that closes in slow motion.
    this.master = c.createGain(); this.master.gain.value = 0.7;
    this.limit = c.createDynamicsCompressor();
    this.limit.threshold.value = -4; this.limit.knee.value = 0; this.limit.ratio.value = 20; this.limit.attack.value = 0.001; this.limit.release.value = 0.08;
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -16; this.comp.ratio.value = 5; this.comp.attack.value = 0.002; this.comp.release.value = 0.2;
    this.tone = c.createBiquadFilter(); this.tone.type = 'lowpass'; this.tone.frequency.value = 18000;
    this.dry = c.createGain();
    this.hall = c.createConvolver(); this.hall.buffer = hallImpulse(c, 3.2);
    this.wet = c.createGain(); this.wet.gain.value = 0.22;
    this.dry.connect(this.tone);
    this.wet.connect(this.hall).connect(this.tone);
    // Last, a soft clip: sharp transients (a bullet's crack) can outrun the limiter.
    this.clip = c.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; ++i) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6); }
    this.clip.curve = curve;
    this.clip.oversample = '2x';
    this.tone.connect(this.comp).connect(this.master).connect(this.limit).connect(this.clip).connect(c.destination);
    // The slow-motion bed: a low drone and air, faded in by speed.
    this.bed = c.createGain(); this.bed.gain.value = 0;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
    for (const f of [41.2, 41.7, 61.9]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(); }
    const air = c.createBufferSource(); air.buffer = this.noise; air.loop = true;
    const airF = c.createBiquadFilter(); airF.type = 'bandpass'; airF.frequency.value = 500; airF.Q.value = 0.6;
    const airG = c.createGain(); airG.gain.value = 0.25;
    air.connect(airF).connect(airG).connect(this.bed);
    air.start();
    lp.connect(this.bed);
    this.bed.connect(this.dry); this.bed.connect(this.wet);
  }
  // One sound: a buffer at a playback rate (pitch and length move together),
  // panned, into the dry bus and the hall.
  play(kind, { gain = 1, rate = 1, pan = 0, delay = 0, send = 0.3, lowpass = 0, important = false } = {}) {
    if (!this.live) return;
    if (this.voices > 90 && !important) return;
    const c = this.ctx, list = this.bank[kind];
    const b = list[Math.floor(Math.random() * list.length)];
    const s = c.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = clamp(rate * this.slow, 0.05, 4);
    let node = s;
    if (lowpass > 0) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; node.connect(f); node = f; }
    const g = c.createGain(); g.gain.value = gain;
    node.connect(g);
    let out = g;
    if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); out = p; }
    out.connect(this.dry);
    const sg = c.createGain(); sg.gain.value = send + 0.6 * (1 - this.slow); out.connect(sg).connect(this.wet);
    ++this.voices;
    s.onended = () => { --this.voices; };
    s.start(c.currentTime + delay);
  }
  // A short burst of filtered noise (wind of a falling sheet, a pile settling).
  rush({ gain = 0.3, from = 2000, to = 300, dur = 0.8, pan = 0, delay = 0 } = {}) {
    if (!this.live) return;
    const c = this.ctx, t = c.currentTime + delay, s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(from * this.slow, t); f.frequency.exponentialRampToValueAtTime(Math.max(40, to * this.slow), t + dur / this.slow);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.08 * dur / this.slow);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur / this.slow);
    const p = c.createStereoPanner ? c.createStereoPanner() : null;
    s.connect(f).connect(g);
    if (p) { p.pan.value = clamp(pan, -1, 1); g.connect(p); p.connect(this.dry); p.connect(this.wet); } else { g.connect(this.dry); }
    s.start(t, Math.random() * 2);
    s.stop(t + dur / this.slow + 0.1);
  }

  // Every frame: the playback speed, slow-motion transitions, dice due to land.
  frame(tEng, scale, dtReal) {
    this.frameDt = clamp(dtReal, 1 / 240, 0.1);
    this.crackBudget = 8;   // crack snaps per frame, all plies together
    if (!this.live) { this.pending.length = 0; return; }
    const prev = this.scale;
    this.scale = scale;
    // Pitch: real time is natural; a tenth of real time about an octave down; deep slow motion two.
    const target = clamp(Math.pow(scale, 0.2), 0.25, 1);
    this.slow += (target - this.slow) * Math.min(1, dtReal * 4);
    const c = this.ctx, now = c.currentTime;
    this.tone.frequency.setTargetAtTime(19000 * Math.pow(this.slow, 1.3) + 500, now, 0.1);
    this.wet.gain.setTargetAtTime(0.22 + 0.5 * (1 - this.slow), now, 0.2);
    this.bed.gain.setTargetAtTime(scale < 0.08 ? 0.07 * clamp(1 - scale / 0.08, 0, 1) + 0.03 : 0, now, 0.4);
    // Time winding down, and back up.
    if (prev > 0.15 && scale < 0.04 && now - this.lastWarp > 1.2) {
      this.lastWarp = now;
      this.rush({ gain: 0.35, from: 2600, to: 120, dur: 1.1 });
      this.play('boom', { gain: 0.35, rate: 1.4, send: 0.6, important: true });
    } else if (prev < 0.04 && scale > 0.15 && now - this.lastWarp > 1.2) {
      this.lastWarp = now;
      this.rush({ gain: 0.25, from: 150, to: 2400, dur: 0.6 });
    }
    // Dice landing this frame: a rain of tiny clicks and the hiss of the pile.
    if (this.pending.length) {
      let n = 0, panSum = 0, k = 0;
      for (const e of this.pending) if (e[0] <= tEng) { n += e[1]; panSum += e[2] * e[1]; } else this.pending[k++] = e;
      this.pending.length = k;
      if (n > 0) {
        const pan = panSum / n, grains = Math.min(28, Math.ceil(2 * Math.sqrt(n)));
        for (let i = 0; i < grains; ++i)
          this.play('grain', { gain: 0.25 + 0.3 * Math.random(), rate: 0.7 + 0.7 * Math.random(), pan: pan + 0.4 * (Math.random() - 0.5), delay: Math.random() * this.frameDt, send: 0.15 });
        if (n > 20) this.rush({ gain: Math.min(0.22, 0.03 * Math.log(n)), from: 5000, to: 2500, dur: 0.35, pan });
      }
    }
  }

  // An object meets the glass. profile: { bright, ring, damp, heavy } of the glazing.
  impact(def, speed, energy, profile, pan) {
    if (!this.live) return;
    const loud = clamp(0.18 * Math.log10(1 + energy * 10), 0.12, 1);
    if (def.kind === 'projectile') {
      // The bullet's own crack, then the strike.
      if (speed > 340) this.play('nwave', { gain: 0.5 * loud, pan, important: true, send: 0.25 });
      if (profile.heavy > 0) {
        this.play('crunch', { gain: 0.9 * loud, rate: 0.8, pan, delay: 0.004 });
        this.play('thud', { gain: 0.8 * loud, rate: 0.8, pan, delay: 0.004 });
        if (this.slow < 0.7) this.play('boom', { gain: 0.5 * loud, pan, send: 0.5 });
      } else {
        this.play('snap', { gain: loud, rate: profile.bright, pan, delay: 0.003, important: true });
        this.play(profile.damp ? 'crunch' : 'tink', { gain: 0.6 * loud, rate: profile.bright, pan, delay: 0.004, lowpass: profile.damp ? 3000 : 0 });
      }
      return;
    }
    // A blow: the object's thud and the pane's knock.
    const thud = def.mass > 2 ? 0 : def.mass > 0.2 ? 1 : 2;
    this.play('thud', { gain: (def.kind === 'soft' ? 1 : 0.7) * loud, pan, important: true, rate: def.id === 'hail_50' ? 1.6 : 1 });
    if (def.kind === 'soft') { this.play('crunch', { gain: 0.25 * loud, rate: 0.5, pan, lowpass: 900 }); return; }
    this.play(profile.damp || profile.heavy ? 'thud' : 'tink', {
      gain: 0.5 * loud, pan, rate: profile.bright * (thud === 2 ? 1.2 : 1), lowpass: profile.damp ? 2500 : 0, delay: 0.002 });
    if (!profile.damp && !profile.heavy && energy > 30) this.play('bell', { gain: 0.25 * loud, pan, rate: profile.bright, send: 0.5 });
  }
  ricochet(pan) { this.play('whine', { gain: 0.5, pan, important: true, send: 0.4 }); }

  // New crack segments of one ply this frame (7 floats each, the last the kind).
  cracks(segs, profile, panOf) {
    if (!this.live || !segs.length || this.crackBudget <= 0) return;
    const n = segs.length / 7;
    let radial = 0, ring = 0, dicing = 0, cone = 0, x = 0, y = 0;
    for (let i = 0; i < segs.length; i += 7) {
      const k = segs[i + 6];
      if (k === 3) ++dicing; else if (k === 1) ++ring; else if (k === 5) ++cone; else ++radial;
      x += segs[i]; y += segs[i + 1];
    }
    const pan = panOf(x / n, y / n), dt = this.frameDt;
    // Running cracks: sharp snaps (brighter on monolithic glass, muffled in a laminate).
    const snaps = Math.min(this.crackBudget, radial ? Math.ceil(1.5 * Math.log2(1 + radial)) : 0);
    this.crackBudget -= snaps;
    for (let i = 0; i < snaps; ++i)
      this.play('snap', { gain: profile.damp ? 0.25 : 0.45, rate: profile.bright * (0.8 + 0.5 * Math.random()), pan: pan + 0.3 * (Math.random() - 0.5),
        delay: Math.random() * dt, lowpass: profile.damp ? 2600 : 0 });
    if (radial && !profile.damp && Math.random() < 0.5)
      this.play('tink', { gain: 0.3, rate: profile.bright * (0.8 + 0.6 * Math.random()), pan, delay: Math.random() * dt });
    // Rings round the impact: lower, groaning cracks.
    const rings = Math.min(5, ring);
    for (let i = 0; i < rings; ++i)
      this.play(profile.damp ? 'crunch' : 'snap', { gain: 0.35, rate: 0.5 * profile.bright, pan, delay: Math.random() * dt, lowpass: 4000 });
    if (cone) this.play('crunch', { gain: 0.3, rate: 1.2, pan });
    // The dicing front: a crackling hiss, densest when it starts.
    if (dicing) {
      const g = Math.min(10, Math.ceil(Math.log2(1 + dicing)));
      for (let i = 0; i < g; ++i) this.play('grain', { gain: 0.3, rate: 0.6 + 0.8 * Math.random(), pan: pan + 0.6 * (Math.random() - 0.5), delay: Math.random() * dt, send: 0.2 });
    }
  }

  // A ply has just come apart. Tempered: the pane bursts; other glass breaks.
  shatter(profile, dicing, pan) {
    if (!this.live) return;
    if (dicing) {
      this.play('fizz', { gain: 1, pan, important: true, send: 0.4 });
      this.play('snap', { gain: 0.9, rate: 0.7, pan, important: true });
      this.play('boom', { gain: this.slow < 0.8 ? 0.7 : 0.35, rate: 1.2, pan, important: true, send: 0.5 });
    } else if (!profile.damp) {
      this.play('snap', { gain: 0.9, rate: 0.8 * profile.bright, pan, important: true });
      this.play('bell', { gain: 0.45, rate: profile.bright, pan, send: 0.5 });
      if (this.slow < 0.8) this.play('boom', { gain: 0.4, rate: 1.4, pan, send: 0.6 });
    }
  }
  // A piece of glass lands; size in metres, speed in m/s.
  landing(size, speed, profile, pan) {
    if (!this.live) return;
    // Chips a few millimetres across only tinkle.
    const g = clamp(0.15 + 0.15 * Math.log2(1 + speed) + 2 * size, 0.1, 0.9) * clamp(size / 0.012, 0.25, 1);
    const rate = clamp(0.06 / Math.max(size, 0.01), 0.45, 2.2) * profile.bright;
    this.play(size > 0.12 ? 'bell' : 'clink', { gain: g, rate, pan, send: 0.35 });
    if (size > 0.08) this.play('snap', { gain: 0.6 * g, rate: 0.7, pan, delay: 0.005 });
  }
  // Dice a spray will land around engine time t.
  dice(t, count, pan) { if (this.live) this.pending.push([t, count, pan]); }
}

// What a glazing sounds like, from its layup.
export function glassProfile(glazing) {
  const plies = glazing.plies || [];
  const glass = plies.filter((p) => p.kind === 'glass');
  const laminated = plies.some((p) => p.kind !== 'glass');
  const thick = plies.reduce((s, p) => s + (p.thickness || 0), 0);
  const tempered = glass.some((p) => /temper/i.test(p.treatment || ''));
  if (thick > 0.02) return { bright: 0.55, ring: 0.15, damp: 1, heavy: 1 };
  if (laminated) return { bright: 0.75, ring: 0.25, damp: 1, heavy: 0 };
  return { bright: tempered ? 1.15 : 1, ring: tempered ? 0.7 : 1, damp: 0, heavy: 0 };
}
