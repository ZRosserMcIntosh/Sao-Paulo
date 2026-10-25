// MineFuck in the browser: the game loop, input, vehicles and HUD (a port of Game.java).
import { Atlas } from './atlas.js';
import * as Blk from './blocks.js';
import { B } from './blocks.js';
import { World, SaoPaulo } from './world.js';
import { Renderer } from './renderer.js';
import { Player } from './player.js';
import { Particles, Sound, Glass } from './effects.js';
import { Car, Plane, CARS, Controls, RHO } from './vehicles.js';
import { m4 } from './math.js';

const $ = (id) => document.getElementById(id);
const BASE = new URL('./', import.meta.url);
const STEP = 1 / 60, MAX_VEHICLES = 8;

class Game {
  constructor() {
    this.canvas = $('view');
    this.atlas = new Atlas();
    Blk.computeColors(this.atlas);
    this.r = new Renderer(this.canvas, this.atlas);
    this.sp = new SaoPaulo();
    this.keys = new Set(); this.pressed = new Set();
    this.mouse = { dx: 0, dy: 0, left: false, right: false, rightHeld: false };
    this.cam = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 70 };
    this.vehicles = []; this.riding = null; this.cockpit = false; this.orbitYaw = 0; this.orbitPitch = 0; this.nextCar = 0;
    this.rocks = []; this.toasts = []; this.time = 0; this.selected = 0; this.paused = true; this.spawned = false;
    this.showHelp = true; this.debug = false; this.runway = null; this.controls = new Controls();
    this.sound = new Sound();
    this.particles = new Particles();
  }

  async start() {
    const bars = [0, 0];
    await this.sp.load(BASE, (i, f) => { bars[i] = f; $('loadbar').style.width = ((bars[0] * 0.25 + bars[1] * 0.75) * 100).toFixed(0) + '%'; });
    this.world = new World(this.sp);
    this.world.onUnload = (c) => this.r.dispose(c);
    this.glass = new Glass(this.world, this.particles, this.sound);
    const s = this.sp.spawn;
    this.player = new Player(s.x, s.y, s.z);
    this.player.setLook(s.yaw, 8);
    this.buildHotbar();
    this.bindInput();
    $('loadmsg').textContent = 'Building Avenida Paulista…';
    this.toast('Bem-vindo a São Paulo! You\'re on Avenida Paulista, facing MASP.', 6, '#ffe070');
    this.toast('C: spawn a car · O: take off from Paulista · T: throw a rock · ?: controls', 8);
    let last = performance.now(), acc = 0, frames = 0, fpsT = 0;
    const frame = (now) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now; acc += dt; fpsT += dt; frames++;
      if (fpsT > 0.5) { this.fps = frames / fpsT; frames = 0; fpsT = 0; }
      this.frameInput();
      while (acc >= STEP) { this.update(STEP); acc -= STEP; }
      this.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ input

  bindInput() {
    const cv = this.canvas;
    const block = new Set(['Space', 'Tab', 'Slash', 'Backquote', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    addEventListener('keydown', (e) => {
      if (block.has(e.code) || (document.pointerLockElement && !e.metaKey)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    const play = () => {
      if (!this.spawnedReady) return;
      this.sound.start();
      cv.requestPointerLock?.();
    };
    cv.addEventListener('click', play);
    $('start').addEventListener('click', play);
    document.addEventListener('pointerlockchange', () => {
      this.paused = document.pointerLockElement !== cv;
      $('pause').hidden = !this.paused || !this.spawnedReady;
    });
    addEventListener('mousemove', (e) => { if (!this.paused) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; } });
    cv.addEventListener('mousedown', (e) => {
      if (this.paused) return;
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightHeld = true; }
    });
    addEventListener('mouseup', (e) => { if (e.button === 2) this.mouse.rightHeld = false; });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => {
      if (this.paused || this.riding) return;
      this.selected = (this.selected + (e.deltaY > 0 ? 1 : -1) + 9) % 9;
      this.updateHotbar();
    }, { passive: true });
  }
  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  frameInput() {
    const m = this.mouse;
    if (this.hit('Slash')) { this.showHelp = !this.showHelp; $('help').hidden = !this.showHelp; }
    if (this.hit('Backquote')) this.debug = !this.debug;
    if (this.hit('KeyV')) this.cockpit = !this.cockpit;
    if (!this.paused && this.player) {
      if (!this.riding) {
        this.player.look(m.dx, m.dy);
        this.onFoot();
      } else {
        this.orbitYaw -= m.dx * 0.15;
        this.orbitPitch = Math.max(-60, Math.min(60, this.orbitPitch - m.dy * 0.15));
        this.inVehicle();
      }
    }
    m.dx = m.dy = 0; m.left = m.right = false;
    this.pressed.clear();
  }

  onFoot() {
    for (let i = 1; i <= 9; i++) if (this.hit('Digit' + i)) { this.selected = i - 1; this.updateHotbar(); }
    const t = this.target, p = this.player;
    if (this.mouse.left && t) {
      if (Blk.isGlass(t.block)) this.glass.smash(t.x, t.y, t.z, ...p.dir);
      else if (t.block !== B.BEDROCK) { this.world.setBlock(t.x, t.y, t.z, B.AIR); this.particles.debris(t.x, t.y, t.z, t.block, 0, 1, 0, 5); }
    }
    if (this.mouse.right && t) p.place(this.world, t, Blk.HOTBAR[this.selected]);
    if (this.hit('KeyF')) { const v = this.nearest(7); if (v) this.enter(v); }
    if (this.hit('KeyC')) this.spawnCar(CARS[this.nextCar++ % CARS.length]);
    if (this.hit('KeyP')) this.spawnPlane(this.down('ShiftLeft') || this.down('ShiftRight') || p.y > 120);
    if (this.hit('KeyO')) this.paulistaRunway();
    if (this.hit('KeyT')) this.throwRock();
  }

  inVehicle() {
    const v = this.riding;
    if (this.hit('KeyF')) { this.exit(false); return; }
    if (v instanceof Car) {
      if (this.hit('KeyH')) this.sound.play('horn', 0.8);
      if (this.hit('KeyB')) v.toggleSeatbelt();
      if (this.hit('KeyR')) v.rightSideUp();
    } else {
      if (this.hit('KeyG')) v.cycleFlaps();
      if (this.hit('KeyR')) {
        const p = v.pos;
        this.vehicles.splice(this.vehicles.indexOf(v), 1);
        this.player.teleport(p[0], p[1] + 2, p[2]);
        this.riding = null;
        this.spawnPlane(true);
      }
    }
  }

  readControls() {
    const c = this.controls, d = (k) => (this.down(k) ? 1 : 0);
    const w = d('KeyW') || d('ArrowUp'), s = d('KeyS') || d('ArrowDown'), a = d('KeyA') || d('ArrowLeft'), dd = d('KeyD') || d('ArrowRight');
    Object.assign(c, { throttle: 0, brake: 0, steer: 0, handbrake: false, pitch: 0, roll: 0, yaw: 0 });
    if (this.riding instanceof Car) {
      c.throttle = w; c.brake = s; c.steer = dd - a; c.handbrake = this.down('Space');
    } else if (this.riding) {
      c.pitch = s - w; c.roll = dd - a; c.yaw = d('KeyE') - d('KeyQ');
      c.throttle = (d('ShiftLeft') || d('ShiftRight')) - d('KeyZ');
      c.brake = d('Space');
    }
  }

  // ------------------------------------------------------------------ vehicles

  addVehicle(v) {
    v.attach(this.world, this.particles, this.sound, this.glass);
    this.vehicles.push(v);
    while (this.vehicles.length > MAX_VEHICLES) {
      const old = this.vehicles.shift();
      if (old === this.riding) { this.vehicles.push(old); break; }
    }
  }
  placeAhead(v, dist, h) {
    const p = this.player, yr = p.yaw * Math.PI / 180;
    const x = p.x - Math.sin(yr) * dist, z = p.z - Math.cos(yr) * dist;
    const top = this.world.surfaceBelow(Math.floor(x), Math.floor(z), Math.floor(p.y) + 6);
    v.place(x, (top < 0 ? p.y : top + 1) + h, z, p.yaw);
  }
  spawnCar(spec) {
    const c = new Car(spec);
    this.placeAhead(c, 6, 0.9);
    this.addVehicle(c);
    this.toast(`${spec.name} parked in front of you. F to get in.`, 4);
    return c;
  }
  spawnPlane(air) {
    const pl = new Plane(), p = this.player;
    if (air) {
      const yr = p.yaw * Math.PI / 180;
      pl.place(p.x, Math.max(p.y + 120, 200), p.z, p.yaw);
      pl.vel = [-Math.sin(yr) * 52, 0, -Math.cos(yr) * 52];
      pl.throttle = 0.75;
      this.addVehicle(pl);
      this.enter(pl);
      const agl = Math.round((pl.pos[1] - p.y) * 3.28084 / 50) * 50;
      this.toast(`Tupi T-180, ${agl.toLocaleString()} ft over São Paulo. W/S pitch, A/D roll, Q/E rudder, Shift/Z throttle.`, 6, '#9ad0ff');
    } else {
      this.placeAhead(pl, 14, 1.3);
      this.addVehicle(pl);
      this.toast('Tupi T-180 on the avenue. F to board; Shift for full power, S to pull up at 55 kt.', 6, '#9ad0ff');
    }
    return pl;
  }
  /** The plane lined up on Paulista's south-west carriageway, the avenue cleared ahead. */
  paulistaRunway() {
    const rw = this.sp.runway;
    const top = this.world.surfaceBelow(Math.floor(rw.x), Math.floor(rw.z), Math.floor(this.sp.spawn.y) + 4);
    this.closeAvenue(rw.x, rw.z, rw.yaw, top + 1);
    this.runway = { x: rw.x, z: rw.z, yaw: rw.yaw, gy: top + 1, until: this.time + 40 };
    const pl = new Plane();
    pl.place(rw.x, top + 1 + 1.3, rw.z, rw.yaw);
    pl.throttle = 0.1;
    this.addVehicle(pl);
    this.enter(pl);
    this.toast('Domingo na Paulista: the avenue is closed to cars, so the Prefeitura cleared it for you.', 6, '#ffe070');
    this.toast('Cleared for take-off. Shift to full power, S to rotate at 55 kt. Then climb: those are 100 m towers.', 7, '#9ad0ff');
  }
  closeAvenue(x0, z0, yaw, gy) {
    const hr = yaw * Math.PI / 180, fx = -Math.sin(hr), fz = -Math.cos(hr), rx = Math.cos(hr), rz = -Math.sin(hr);
    const furniture = new Set([B.STEEL, B.POLE, B.LAMP, B.SIGN_BLUE, B.FENCE, B.BIN_ORANGE, B.ORELHAO_BLUE, B.ORELHAO_YELLOW, B.LEAVES, B.WOOD, B.PLANKS]);
    const done = new Set();
    for (let d = -10; d <= 500; d += 0.5) for (let l = -7.5; l <= 7.5; l += 0.5) {
      const bx = Math.floor(x0 + fx * d + rx * l), bz = Math.floor(z0 + fz * d + rz * l), k = bx * 100000 + bz;
      if (done.has(k)) continue;
      done.add(k);
      for (let y = gy; y < gy + 12; y++) if (furniture.has(this.world.getBlock(bx, y, bz))) this.world.setBlock(bx, y, bz, B.AIR);
    }
  }
  nearest(within) {
    let best = null, bd = within * within;
    const p = this.player;
    for (const v of this.vehicles) {
      const d = (v.pos[0] - p.x) ** 2 + (v.pos[1] - p.y - 1) ** 2 + (v.pos[2] - p.z) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  enter(v) {
    this.riding = v; this.orbitYaw = this.orbitPitch = 0;
    if (v instanceof Car) {
      this.toast(`${v.name}: W/S drive, A/D steer, Space handbrake, H horn, B seatbelt, V view`, 5);
      if (v.s.kind === 's600') this.toast('4.2 tonnes of armour. Buildings are more of a suggestion.', 5, '#ffe070');
    }
  }
  exit(ejected) {
    const v = this.riding;
    this.riding = null;
    if (ejected) return;
    const p = v.pos, r = v.right(), ex = p[0] - r[0] * 2.2, ez = p[2] - r[2] * 2.2;
    const top = this.world.surfaceBelow(Math.floor(ex), Math.floor(ez), Math.floor(p[1]) + 3);
    if (v instanceof Plane && !v.onGround && !v.crashed) {
      this.player.teleport(p[0], p[1] - 2, p[2]);
      this.player.launch(...v.vel);
      this.toast('You bailed out. There is no parachute. There was never a parachute.', 5, '#ff8080');
    } else {
      this.player.teleport(ex, top < 0 ? p[1] : top + 1, ez);
      if (v instanceof Plane) v.throttle = 0;
    }
    const f = v.forward();
    this.player.setLook(Math.atan2(-f[0], -f[2]) * 180 / Math.PI, 0);
  }
  eject(car, before) {
    this.exit(true);
    const seat = car.toWorld([0, 1.0, -car.s.L / 2 - 0.6]);
    this.player.teleport(...seat);
    this.player.launch(before[0] * 0.9, Math.max(3, before[1] + 4), before[2] * 0.9);
    for (let i = 0; i < 40; i++) {
      const s = 0.05 + Math.random() * 0.06;
      this.particles.add(...seat, before[0] * 0.7 + (Math.random() - 0.5) * 5, Math.random() * 4, before[2] * 0.7 + (Math.random() - 0.5) * 5, s, s, s, 0.6, 0.75, 0.8, 0.7, 5, 0.3, 1);
    }
    this.sound.play('tempered', 1);
    this.toast(`EJECTED at ${(Math.hypot(...before) * 3.6).toFixed(0)} km/h. Seatbelts exist (B).`, 5, '#ff5050');
  }

  // ------------------------------------------------------------------ rocks

  throwRock() {
    const p = this.player, d = p.dir, sp = 24;
    this.rocks.push({ x: p.x + d[0] * 0.5, y: p.eyeY + d[1] * 0.5 - 0.1, z: p.z + d[2] * 0.5, vx: d[0] * sp + p.vx, vy: d[1] * sp + 1.5, vz: d[2] * sp + p.vz, life: 8 });
  }
  updateRocks(dt) {
    const m = 0.4, k = 0.5 * RHO * 0.47 * Math.PI * 0.0025 / m;
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const r = this.rocks[i];
      r.life -= dt;
      const sp = Math.hypot(r.vx, r.vy, r.vz);
      r.vx -= k * sp * r.vx * dt; r.vy -= (k * sp * r.vy + 9.81) * dt; r.vz -= k * sp * r.vz * dt;
      const hit = sp > 1e-6 ? this.world.raycast(r.x, r.y, r.z, r.vx / sp, r.vy / sp, r.vz / sp, sp * dt) : null;
      if (hit) {
        const e = 0.5 * m * sp * sp;
        if (Blk.isGlass(hit.block)) {
          const abs = this.glass.impact(hit.x, hit.y, hit.z, e, r.vx, r.vy, r.vz);
          if (abs >= 0) { const f = Math.sqrt(Math.max(0.05, 1 - abs / e)); r.vx *= f; r.vy *= f; r.vz *= f; continue; }
        }
        if (hit.face <= 1) r.vy = -r.vy * 0.3; else if (hit.face <= 3) r.vz = -r.vz * 0.3; else r.vx = -r.vx * 0.3;
        r.vx *= 0.5; r.vy *= 0.5; r.vz *= 0.5;
        if (sp < 2) r.life = Math.min(r.life, 1.5);
        if (sp > 6) this.sound.play('pop', Math.min(0.6, sp / 30));
        continue;
      }
      r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
      if (r.life <= 0) this.rocks.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ simulation

  update(dt) {
    const p = this.player;
    if (this.paused && this.spawned) return;
    this.time += dt;
    if (!this.riding) {
      let mx = 0, mz = 0;
      if (!this.paused) {
        mz = (this.down('KeyW') || this.down('ArrowUp') ? 1 : 0) - (this.down('KeyS') || this.down('ArrowDown') ? 1 : 0);
        mx = (this.down('KeyD') || this.down('ArrowRight') ? 1 : 0) - (this.down('KeyA') || this.down('ArrowLeft') ? 1 : 0);
      }
      p.input(mx, mz, this.down('Space'), false, this.down('ShiftLeft') || this.down('ShiftRight'));
      const wasFlying = p.flying, impact = p.update(dt, this.world);
      if (wasFlying && impact > 0) {
        this.toast(impact > 18 ? `SPLAT (${(impact * 3.6).toFixed(0)} km/h). The calçada portuguesa is unforgiving.` : 'You tumble to a stop. Nothing broken. Probably.', 4, '#ff8080');
        this.sound.play('thud', 0.8);
      }
    }
    this.readControls();
    const parkedCar = new Controls(), parkedPlane = new Controls();
    parkedCar.handbrake = true; parkedPlane.brake = 1;
    for (const v of [...this.vehicles]) {
      if (!this.world.isLoaded(Math.floor(v.pos[0]), Math.floor(v.pos[2]))) continue;
      const before = v.vel.slice();
      v.update(dt, v === this.riding ? this.controls : v instanceof Car ? parkedCar : parkedPlane);
      const msg = v.takeMessage();
      if (msg) this.toast(msg, 5, '#ffe070');
      if (v instanceof Car) {
        v.emitSmoke();
        const hit = v.takeImpact();
        if (v === this.riding && hit > 9 && !v.seatbelt) this.eject(v, before);
      }
    }
    if (this.riding) p.teleport(...this.riding.pos);
    if (this.runway && Math.round(this.time * 60) % 30 === 0) {
      this.closeAvenue(this.runway.x, this.runway.z, this.runway.yaw, this.runway.gy);
      if (this.time > this.runway.until) this.runway = null;
    }
    this.updateRocks(dt);
    this.particles.update(dt, this.world);
    this.glass.update();
    this.updateSound();
    this.toasts = this.toasts.filter((t) => t.until > this.time);
  }

  updateSound() {
    const v = this.riding, p = this.player;
    if (v instanceof Car) this.sound.set(v.engineHz(), 0.25 + v.thrShown * 0.45, Math.min(0.3, v.speed() / 120), false);
    else if (v instanceof Plane && !v.crashed) {
      const rpm = 900 + 1800 * v.throttle + v.airspeedKt() * 3;
      this.sound.set(rpm / 60 * 2, 0.35 + v.throttle * 0.4, Math.min(0.45, v.speed() / 110), v.stallWarning());
    } else this.sound.set(0, 0, p.flying ? Math.min(0.5, Math.abs(p.vy) / 40) : 0, false);
  }

  toast(text, seconds, color = '#fff') {
    this.toasts.push({ text, until: this.time + seconds, color });
    if (this.toasts.length > 5) this.toasts.shift();
  }

  // ------------------------------------------------------------------ rendering

  render() {
    const p = this.player, cam = this.cam;
    if (this.riding) {
      if (!this.mouse.rightHeld) { this.orbitYaw *= 0.97; this.orbitPitch *= 0.97; }
      this.riding.camera(cam, this.cockpit, this.orbitYaw, this.orbitPitch);
      cam.fov = 70 + Math.min(15, this.riding.speed() * 0.25);
      this.target = null;
    } else {
      Object.assign(cam, { x: p.x, y: p.eyeY, z: p.z, yaw: p.yaw, pitch: p.pitch, roll: 0, fov: 70 });
      this.target = p.target(this.world);
    }
    // world generation and meshing share a per-frame time budget (more while loading)
    const cx = this.riding ? this.riding.pos[0] : p.x, cz = this.riding ? this.riding.pos[2] : p.z;
    this.world.renderDistance = this.riding instanceof Plane || p.y > 140 ? 16 : 10;
    this.world.update(cx, cz, this.spawned ? 3 : 25);
    this.r.meshBudgetMs = this.spawned ? 6 : 40;
    this.r.remesh(this.world, cam);
    const ease = this.world.renderDistance * 16;
    this.r.viewDist += (ease - this.r.viewDist) * 0.02;
    this.r.render(this.world, cam, this.target, (r) => this.drawEntities(r));
    if (!this.spawned) {
      // ready once the 5x5 chunks around the spawn are meshed and the player is standing
      const ccx = Math.floor(p.x / 16), ccz = Math.floor(p.z / 16);
      let ready = p.onGround;
      for (let dx = -2; dx <= 2 && ready; dx++) for (let dz = -2; dz <= 2 && ready; dz++) {
        const c = this.world.chunk(ccx + dx, ccz + dz);
        ready = !!(c && c.mesh);
      }
      if (ready) {
        this.spawned = true; this.spawnedReady = true;
        $('loading').hidden = true;
        $('pause').hidden = !this.paused;
      }
    }
    this.drawHud();
  }

  drawEntities(r) {
    for (const v of this.vehicles) v.render(r, v === this.riding && this.cockpit);
    for (const k of this.rocks) r.drawBox(m4.mul(m4.translation(k.x, k.y, k.z), m4.scaling(0.14, 0.14, 0.14)), 0.5, 0.5, 0.52, 1);
    this.particles.render(r, this.cam, 160);
  }

  buildHotbar() {
    const hb = $('hotbar');
    hb.innerHTML = '';
    Blk.HOTBAR.forEach((b, i) => {
      const d = document.createElement('div');
      d.className = 'slot';
      d.innerHTML = `<img alt="" src="${this.atlas.tileURL(Blk.texture(b, 2))}"><span>${i + 1}</span>`;
      hb.appendChild(d);
    });
    this.updateHotbar();
  }
  updateHotbar() {
    [...$('hotbar').children].forEach((d, i) => d.classList.toggle('sel', i === this.selected));
    $('blockname').textContent = Blk.name(Blk.HOTBAR[this.selected]);
  }

  drawHud() {
    const p = this.player, cam = this.cam, sp = this.sp;
    const px = Math.floor(cam.x), pz = Math.floor(cam.z);
    $('place').textContent = sp.inMasp(px, pz) ? 'São Paulo · Avenida Paulista · MASP' : sp.inRing(px, pz) ? 'São Paulo · ' + bairro(px, pz) : 'Serra (procedural wilderness)';
    $('shards').textContent = this.glass.shards ? `Glass shards: ${this.glass.shards.toLocaleString()}` : '';
    $('crosshair').hidden = !!this.riding && !this.cockpit;
    $('hotbarwrap').hidden = !!this.riding;
    const near = !this.riding && this.nearest(7);
    $('prompt').textContent = near ? `F: get in the ${near.name}` : '';
    const hudEl = $('vehicle');
    if (this.riding) {
      if (!this.hudT || this.time - this.hudT > 0.1) { hudEl.innerHTML = this.riding.hud(); this.hudT = this.time; }
      hudEl.hidden = false;
    } else hudEl.hidden = true;
    $('stall').hidden = !(this.riding instanceof Plane && this.riding.stallWarning());
    const tl = $('toasts'), html = this.toasts.map((t) => `<div style="color:${t.color};opacity:${Math.min(1, (t.until - this.time) / 0.6)}">${esc(t.text)}</div>`).join('');
    if (tl.innerHTML !== html) tl.innerHTML = html;
    $('debug').hidden = !this.debug;
    if (this.debug) {
      $('debug').textContent = `${(this.fps || 0).toFixed(0)} fps · xyz ${cam.x.toFixed(1)} ${cam.y.toFixed(1)} ${cam.z.toFixed(1)} · yaw ${cam.yaw.toFixed(0)} pitch ${cam.pitch.toFixed(0)}\n` +
        `chunks ${this.world.chunks.size} loaded, ${this.r.drawn} drawn · particles ${this.particles.list.length} · vehicles ${this.vehicles.length}`;
    }
  }
}

function esc(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/** A rough neighbourhood name: MASP at the origin, Paulista running NW-SE, north is -z. */
function bairro(x, z) {
  const across = (x - z + 40) / Math.SQRT2, along = (x + z) / Math.SQRT2;
  if (Math.abs(across) < 60) return along < -600 ? 'Avenida Paulista (Consolação)' : along > 600 ? 'Avenida Paulista (Paraíso)' : 'Avenida Paulista';
  if (across > 0) return along < -300 ? 'Consolação' : along > 400 ? 'Bixiga' : 'Bela Vista';
  return along < -300 ? 'Cerqueira César' : along > 400 ? 'Paraíso' : 'Jardim Paulista';
}

const game = new Game();
window.game = game; // for the console and automated checks
game.start().catch((e) => {
  console.error(e);
  $('loadmsg').textContent = 'Could not start: ' + e.message;
});
