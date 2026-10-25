// Particles, glass fracture and synthesized sound: ports of effects/Particles.java,
// GlassDynamics.java and Sound.java (WebAudio instead of Java Sound).
import { B, isSolid, glassKind, ANNEALED, TEMPERED, COLOR } from './blocks.js';
import { m4 } from './math.js';

// ------------------------------------------------------------------ particles

export class Particles {
  constructor(cap = 5000) {
    this.cap = cap;
    this.list = [];
  }
  add(x, y, z, vx, vy, vz, sx, sy, sz, r, g, b, a, life, drag, grav) {
    const p = { x, y, z, vx, vy, vz, sx, sy, sz, r, g, b, a, drag, grav };
    const ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5, l = Math.hypot(ax, ay, az) || 1;
    p.ax = ax / l; p.ay = ay / l; p.az = az / l;
    p.angle = Math.random() * 6.28; p.spin = (Math.random() - 0.5) * 30;
    p.life = p.max = life * (0.7 + Math.random() * 0.6);
    if (this.list.length >= this.cap) this.list[Math.floor(Math.random() * this.cap)] = p;
    else this.list.push(p);
  }
  debris(bx, by, bz, block, vx, vy, vz, n) {
    const c = COLOR[block] || [1, 0, 1];
    for (let k = 0; k < n; k++) {
      const s = 0.12 + Math.random() * 0.25;
      this.add(bx + Math.random(), by + Math.random(), bz + Math.random(),
        vx * (0.4 + Math.random() * 0.6) + (Math.random() - 0.5) * 4, vy * 0.5 + Math.random() * 5,
        vz * (0.4 + Math.random() * 0.6) + (Math.random() - 0.5) * 4, s, s, s, c[0] * 0.95, c[1] * 0.95, c[2] * 0.95, 1, 5, 0.3, 1);
    }
  }
  smoke(x, y, z, vx, vz, grey) {
    const s = 0.5 + Math.random() * 0.6;
    this.add(x, y, z, vx * 0.2 + Math.random() - 0.5, 0.6 + Math.random(), vz * 0.2 + Math.random() - 0.5, s, s, s, grey, grey, grey, 0.35, 1.6, 1.2, -0.05);
  }
  update(dt, world) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      p.life -= dt;
      if (p.life <= 0) { L[i] = L[L.length - 1]; L.pop(); continue; }
      p.vy -= 9.81 * p.grav * dt;
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k; p.vy *= k; p.vz *= k;
      let nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      if (p.grav > 0 && isSolid(world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz)))) {
        if (Math.floor(ny) !== Math.floor(p.y)) { p.vy = -p.vy * 0.25; p.vx *= 0.6; p.vz *= 0.6; p.spin *= 0.5; ny = p.y; }
        else {
          if (Math.floor(nx) !== Math.floor(p.x)) { p.vx = -p.vx * 0.3; nx = p.x; }
          if (Math.floor(nz) !== Math.floor(p.z)) { p.vz = -p.vz * 0.3; nz = p.z; }
        }
      }
      p.x = nx; p.y = ny; p.z = nz;
      p.angle += p.spin * dt;
    }
  }
  render(r, cam, maxDist) {
    const md2 = maxDist * maxDist;
    for (const p of this.list) {
      const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
      if (dx * dx + dy * dy + dz * dz > md2) continue;
      const fade = Math.min(1, p.life / Math.min(1, p.max));
      let a = p.a * fade;
      if (a > 0.99) a = 1; else if (p.a >= 1) a = Math.min(0.98, a);
      const m = m4.mul(m4.mul(m4.translation(p.x, p.y, p.z), m4.axisAngle(p.ax, p.ay, p.az, p.angle)), m4.scaling(p.sx, p.sy, p.sz));
      r.drawBox(m, p.r, p.g, p.b, a);
    }
  }
}

// ------------------------------------------------------------------ sound

/** Everything you hear, synthesized: glass, crashes, the horn, engine, wind, stall horn. */
export class Sound {
  constructor() { this.ctx = null; }
  /** Browsers only allow audio after a click: call from the first user gesture. */
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0.6; this.master.connect(ctx.destination);
    const rate = ctx.sampleRate;
    const buf = (sec, fn) => {
      const b = ctx.createBuffer(1, Math.floor(rate * sec), rate), d = b.getChannelData(0);
      fn(d, rate);
      return b;
    };
    const glass = (sec, pings, seed) => buf(sec, (d, R) => {
      let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < d.length; i++) d[i] = (rnd() - 0.5) * 1.6 * Math.exp(-i / R / 0.012);
      for (let k = 0; k < pings; k++) {
        const t0 = Math.pow(rnd(), 1.6) * sec * 0.7, f = 2400 + rnd() * 5200, tau = 0.03 + rnd() * 0.12, amp = 0.15 + rnd() * 0.3;
        for (let i = Math.floor(t0 * R); i < d.length; i++) {
          const t = (i - t0 * R) / R, e = Math.exp(-t / tau);
          if (e < 0.002) break;
          d[i] += Math.sin(2 * Math.PI * f * t) * amp * e + (rnd() - 0.5) * amp * 0.6 * Math.exp(-t / 0.004);
        }
      }
    });
    this.clips = {
      glassSmall: glass(0.45, 6, 7), glassBig: glass(1.1, 18, 11),
      tempered: buf(1.6, (d, R) => {
        let lp = 0;
        for (let i = 0; i < d.length; i++) {
          const t = i / R, pop = (Math.random() - 0.5) * 2 * Math.exp(-t / 0.006);
          const rain = (Math.random() - 0.5) * (Math.random() < 0.08 ? 1.2 : 0.25) * Math.exp(-t / 0.5) * Math.min(1, t * 20);
          lp += (rain - lp) * 0.6;
          d[i] = pop + (rain - lp) * 0.9;
        }
      }),
      crash: buf(1.2, (d, R) => { let lp = 0; for (let i = 0; i < d.length; i++) { const t = i / R; lp += (Math.random() - 0.5 - lp) * 0.08; d[i] = lp * 3 * Math.exp(-t / 0.36) + Math.sin(2 * Math.PI * 55 * t) * 0.6 * Math.exp(-t / 0.12); } }),
      thud: buf(0.35, (d, R) => { let lp = 0; for (let i = 0; i < d.length; i++) { const t = i / R; lp += (Math.random() - 0.5 - lp) * 0.08; d[i] = lp * 3 * Math.exp(-t / 0.1) + Math.sin(2 * Math.PI * 55 * t) * 0.6 * Math.exp(-t / 0.12); } }),
      horn: buf(0.75, (d, R) => { for (let i = 0; i < d.length; i++) { const t = i / R; if (t < 0.28 || (t > 0.38 && t < 0.72)) d[i] = (Math.sign(Math.sin(2 * Math.PI * 410 * t)) + Math.sign(Math.sin(2 * Math.PI * 515 * t))) * 0.14; } }),
      pop: buf(0.08, (d, R) => { for (let i = 0; i < d.length; i++) { const t = i / R; d[i] = Math.sin(2 * Math.PI * 900 * t * (1 - t * 4)) * Math.exp(-t / 0.02) * 0.5; } }),
    };
    // engine: a sawtooth through a low-pass, pitch set every frame
    this.engine = ctx.createOscillator(); this.engine.type = 'sawtooth';
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 900;
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
    this.engine.connect(lpf).connect(this.engineGain).connect(this.master);
    this.engine.start();
    // wind: looped noise through a band-pass
    const noise = buf(2, (d) => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; });
    const wn = ctx.createBufferSource(); wn.buffer = noise; wn.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    wn.connect(bp).connect(this.windGain).connect(this.master); wn.start();
    this.stall = ctx.createOscillator(); this.stall.frequency.value = 1600;
    this.stallGain = ctx.createGain(); this.stallGain.gain.value = 0;
    this.stall.connect(this.stallGain).connect(this.master); this.stall.start();
  }
  play(name, vol = 1) {
    if (!this.ctx || !this.clips) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.clips[name];
    const g = this.ctx.createGain(); g.gain.value = vol;
    s.connect(g).connect(this.master); s.start();
  }
  set(engineHz, engineVol, wind, stall) {
    if (!this.ctx || !this.engine) return;
    const t = this.ctx.currentTime;
    this.engine.frequency.setTargetAtTime(Math.max(20, engineHz), t, 0.05);
    this.engineGain.gain.setTargetAtTime(engineVol * 0.18, t, 0.05);
    this.windGain.gain.setTargetAtTime(wind * 0.6, t, 0.1);
    this.stallGain.gain.setTargetAtTime(stall ? 0.08 : 0, t, 0.03);
  }
}

// ------------------------------------------------------------------ glass

const WEIBULL_M = 7, ANNEALED_J = 25, TEMPERED_J = 110, MAX_PANE = 600;

/**
 * Glass breaks after the Glass Dynamics lab, reduced to blocks: Weibull-random strength;
 * annealed glass cracks locally and falls in big shards; tempered panes dice entirely, one
 * block ring per tick.
 */
export class Glass {
  constructor(world, particles, sound) {
    this.world = world; this.particles = particles; this.sound = sound;
    this.fronts = []; this.shards = 0; this.lastPane = 0;
  }
  /** Returns the energy absorbed if it broke, or -1 if it held. */
  impact(x, y, z, energy, dx, dy, dz) {
    const kind = glassKind(this.world.getBlock(x, y, z));
    if (!kind) return -1;
    const strength = (kind === TEMPERED ? TEMPERED_J : ANNEALED_J) * Math.pow(-Math.log(1 - Math.random()), 1 / WEIBULL_M);
    if (energy < strength) { if (energy > strength * 0.3) this.sound.play('pop', 0.4); return -1; }
    const l = Math.hypot(dx, dy, dz) || 1;
    if (kind === TEMPERED) this.dice(x, y, z, dx / l, dy / l, dz / l, energy);
    else this.annealed(x, y, z, dx / l, dy / l, dz / l, energy);
    return strength;
  }
  smash(x, y, z, dx, dy, dz) {
    const kind = glassKind(this.world.getBlock(x, y, z));
    if (kind === TEMPERED) this.dice(x, y, z, dx, dy, dz, 150);
    else if (kind === ANNEALED) this.annealed(x, y, z, dx, dy, dz, 60);
  }
  annealed(x, y, z, dx, dy, dz, energy) {
    this.breakAnnealed(x, y, z, dx, dy, dz, energy, true);
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    const axis = ax > ay ? (ax > az ? 0 : 2) : (ay > az ? 1 : 2);
    const dirs = axis === 0 ? [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] : axis === 1 ? [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] : [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    const reach = Math.sqrt(energy / ANNEALED_J) * 1.6;
    let broken = 1;
    for (const d of dirs) {
      if (Math.random() > 0.35 + Math.min(0.6, energy / 200)) continue;
      let cx = x, cy = y, cz = z;
      const len = Math.round(reach * (0.4 + Math.random()));
      for (let s = 0; s < len; s++) {
        cx += d[0]; cy += d[1]; cz += d[2];
        if (Math.random() < 0.25) { const sd = dirs[Math.floor(Math.random() * 4)]; if (sd[0] !== -d[0] || sd[1] !== -d[1] || sd[2] !== -d[2]) { cx += sd[0]; cy += sd[1]; cz += sd[2]; } }
        if (glassKind(this.world.getBlock(cx, cy, cz)) !== ANNEALED) break;
        this.breakAnnealed(cx, cy, cz, dx, dy, dz, energy * 0.3, false);
        broken++;
      }
    }
    this.sound.play(broken > 2 ? 'glassBig' : 'glassSmall', Math.min(1, 0.5 + broken * 0.1));
  }
  breakAnnealed(x, y, z, dx, dy, dz, energy, hit) {
    this.world.setBlock(x, y, z, B.AIR);
    const push = hit ? Math.min(8, Math.sqrt(energy) * 0.6) : 0.5, n = hit ? 7 + Math.floor(Math.random() * 5) : 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      this.particles.add(x + Math.random(), y + Math.random(), z + Math.random(),
        dx * push * Math.random() + Math.random() - 0.5, dy * push * Math.random(), dz * push * Math.random() + Math.random() - 0.5,
        0.15 + Math.random() * 0.35, 0.15 + Math.random() * 0.45, 0.025, 0.82, 0.93, 0.96, 0.55, 6, 0.4, 1);
    }
    this.shards += n;
  }
  dice(x, y, z, dx, dy, dz, energy) {
    const push = Math.min(10, 2 + Math.sqrt(energy) * 0.25);
    this.fronts.push({ ring: [[x, y, z]], seen: new Set([x + ',' + y + ',' + z]), ox: x + 0.5, oy: y + 0.5, oz: z + 0.5, px: dx * push, py: dy * push, pz: dz * push, broken: 0 });
    this.sound.play('tempered', 0.9);
  }
  /** Advances the crack fronts by one block ring. Once per tick. */
  update() {
    for (let i = this.fronts.length - 1; i >= 0; i--) {
      const f = this.fronts[i], next = [];
      for (const [x, y, z] of f.ring) {
        if (glassKind(this.world.getBlock(x, y, z)) !== TEMPERED) continue;
        this.diceBlock(f, x, y, z);
        for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const k = (x + a) + ',' + (y + b) + ',' + (z + c);
          if (f.seen.size >= MAX_PANE || f.seen.has(k)) continue;
          f.seen.add(k);
          if (glassKind(this.world.getBlock(x + a, y + b, z + c)) === TEMPERED) next.push([x + a, y + b, z + c]);
        }
      }
      f.ring = next;
      if (!next.length) { this.lastPane = f.broken; if (f.broken > 12) this.sound.play('tempered', 0.7); this.fronts.splice(i, 1); }
    }
  }
  diceBlock(f, x, y, z) {
    this.world.setBlock(x, y, z, B.AIR);
    f.broken++;
    const n = f.seen.size > 200 ? 4 : 10;
    for (let i = 0; i < n; i++) {
      const px = x + Math.random(), py = y + Math.random(), pz = z + Math.random();
      const ox = px - f.ox, oy = py - f.oy, oz = pz - f.oz, d = Math.hypot(ox, oy, oz) + 0.5, s = 0.06 + Math.random() * 0.07, k = 1.5 / d;
      this.particles.add(px, py, pz,
        f.px * (0.3 + Math.random()) / d + ox * k + (Math.random() - 0.5) * 1.5,
        f.py * (0.3 + Math.random()) / d + oy * k + Math.random() * 1.5,
        f.pz * (0.3 + Math.random()) / d + oz * k + (Math.random() - 0.5) * 1.5,
        s, s, s, 0.42, 0.58, 0.66, 0.8, 5, 0.35, 1);
    }
    this.shards += n;
  }
}
