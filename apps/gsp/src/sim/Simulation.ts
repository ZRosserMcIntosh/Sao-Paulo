// The simulation: one fixed 120 Hz step for everything (AI, the vehicle core, Street Dynamics,
// Rapier, damage, game rules, replay), driven by real time with an accumulator. Rendering
// interpolates between the last two steps. Independent of React.
import RAPIER from '@dimforge/rapier3d-compat';
import { GspEngine } from './engines/gsp';
import { StreetEngine } from './engines/street';
import { GlassClient } from './engines/glass';
import { initRapier, PhysicsWorld, type StaticInfo } from './physics/world';
import { Track, XS, laneCenterOffset } from './world/track';
import { buildFeatures, buildGround, SURF, type Features, type Ground } from './world/terrain';
import { buildLayout, type Layout } from './world/layout';
import { Vehicle, type Role } from './vehicle/Vehicle';
import { cloneClass, TRAFFIC_KINDS, TRAFFIC_PAINTS, type VehicleKind } from './vehicle/catalog';
import type { HandlingScales } from './vehicle/params';
import type { DamageEvent, PartId, WindowId } from './vehicle/damage';
import { AiDriver, PERSONALITIES } from './ai/driver';
import { Props, type Prop } from './props';
import { GameState } from './game';
import { ReplayBuffer, type ReplayEvent } from './replay';
import { Input, type Action } from './input';
import { scenarioById, type ScenarioDef, type ScenarioId, type Weather } from './scenarios';
import { defaultLabConfig, vehicleParams, type LabConfig } from './config';
import { clamp, qinvrot, qrot, Rng, wrapAngle, type V3 } from './math';

export const DT = 1 / 120;
export const WORLD_SEED = 1337;

export interface ImpactEvent { x: number; y: number; z: number; strength: number; kind: 'car' | 'metal' | 'concrete' | 'prop' | 'sign' | 'glass' | 'scrape'; t: number; involvesPlayer: boolean }

export type CameraMode = 'chase' | 'close' | 'hood' | 'driver' | 'free' | 'cinematic';
export const CAMERA_MODES: CameraMode[] = ['chase', 'close', 'hood', 'driver', 'free', 'cinematic'];

export interface ReplayState { active: boolean; event: ReplayEvent | null; t: number; t0: number; t1: number; speed: number; angle: number }

export interface Telemetry {
  stepMs: number; aiMs: number; rapierMs: number; coreMs: number; steps: number; fps: number;
  contacts: { t: number; a: string; b: string; impulse: number; dv: number }[];
}

type Listener<T> = (e: T) => void;

export class Simulation {
  gsp!: GspEngine;
  street: StreetEngine | null = null;
  glass!: GlassClient;
  phys!: PhysicsWorld;
  track!: Track;
  ground!: Ground;
  features!: Features;
  layout!: Layout;
  props!: Props;
  vehicles: Vehicle[] = [];
  player: Vehicle | null = null;
  ais = new Map<number, AiDriver>();
  colliderToVehicle = new Map<number, Vehicle>();
  game = new GameState();
  replay = new ReplayBuffer();
  input = new Input();
  cfg: LabConfig = defaultLabConfig();
  scenario!: ScenarioDef;
  seed = 1;
  rng = new Rng(1);
  time = 0;
  steps = 0;
  acc = 0;
  alpha = 0;
  paused = false;
  slowmo = false;
  slowmoScale = 0.25;
  stepRequests = 0;
  weather: Weather = scenarioById('A').weather;
  camera: CameraMode = 'chase';
  cameraShake = true;
  replayState: ReplayState = { active: false, event: null, t: 0, t0: 0, t1: 0, speed: 0.35, angle: 0 };
  telemetry: Telemetry = { stepMs: 0, aiMs: 0, rapierMs: 0, coreMs: 0, steps: 0, fps: 60, contacts: [] };
  showTelemetry = false;
  impacts: ImpactEvent[] = [];
  version = 0; // bumps when the set of vehicles / props changes (render rebuild)
  private impactListeners = new Set<Listener<ImpactEvent>>();
  private actionListeners = new Set<Listener<Action>>();
  private pitWatch: { target: Vehicle; until: number; heading0: number }[] = [];
  private railCooldown = new Map<number, number>();
  private signCells = new Map<number, number[]>();
  private airTime = new Map<number, number>();
  private driftTime = 0;
  private wrongWay = 0;
  private aiPhase = 0;
  private baseBase = '';

  static async create(base: string, onProgress: (p: number, msg: string) => void): Promise<Simulation> {
    const s = new Simulation();
    s.baseBase = base;
    onProgress(0.05, 'Starting Rapier');
    await initRapier();
    onProgress(0.15, 'Loading OpenRoad Dynamics');
    s.gsp = await GspEngine.load(base + 'gsp.wasm');
    onProgress(0.3, 'Surveying the interstate');
    await tick();
    s.track = new Track(WORLD_SEED);
    s.features = buildFeatures(s.track);
    onProgress(0.4, 'Grading red clay');
    await tick();
    s.ground = buildGround(s.track, s.features, WORLD_SEED);
    onProgress(0.62, 'Planting loblolly pines');
    await tick();
    s.layout = buildLayout(s.track, s.ground, s.features, WORLD_SEED);
    s.gsp.uploadGround(s.ground.nx, s.ground.nz, s.ground.minX, s.ground.minZ, s.ground.cell, s.ground.heights, s.ground.classes);
    const op = s.features.overpass;
    s.gsp.addDeck(op.x, op.z, s.features.deckY, op.halfSpan, op.halfWidth + 0.4, Math.atan2(-op.uz, op.ux), SURF.DECK);
    onProgress(0.72, 'Installing guardrails (taxpayer-funded)');
    await tick();
    s.phys = new PhysicsWorld(RAPIER);
    s.phys.buildStatic(s.track, s.ground, s.features, s.layout);
    s.props = new Props(s.phys);
    onProgress(0.82, 'Bolting up breakaway signs');
    try {
      s.street = await StreetEngine.load(base, WORLD_SEED);
      s.street.addSigns(s.layout.signs);
      for (let i = 0; i < s.layout.signs.length; ++i) {
        const sg = s.layout.signs[i];
        const key = cellKey(Math.floor(sg.x / 40), Math.floor(sg.z / 40));
        const b = s.signCells.get(key) ?? [];
        b.push(i);
        s.signCells.set(key, b);
      }
    } catch (e) {
      console.warn('Street Dynamics unavailable, signs are static', e);
      s.street = null;
    }
    s.glass = new GlassClient(base + 'gsp-glass-worker.js');
    onProgress(0.9, 'Briefing the troopers');
    s.applyConfig(s.cfg, true);
    s.input.attach();
    return s;
  }

  // ------------------------------------------------------------------ scenarios
  load(id: ScenarioId, seed?: number) {
    this.scenario = scenarioById(id);
    this.seed = seed ?? this.seed;
    this.rng = new Rng(this.seed * 7919 + id.charCodeAt(0));
    // clear
    for (const v of this.vehicles) v.destroy();
    this.vehicles = [];
    this.ais.clear();
    this.colliderToVehicle.clear();
    this.player = null;
    this.props.clear();
    this.glass.clear();
    this.street?.repairAll();
    for (const seg of this.phys.railSegments) { seg.hits = 0; seg.offset = 0; seg.tilt = 0; }
    this.replay.reset();
    this.game.reset(true);
    this.pitWatch = [];
    this.impacts = [];
    this.time = 0; this.steps = 0; this.acc = 0;
    this.replayState.active = false;
    this.weather = { ...this.scenario.weather };
    this.gsp.setWeather(this.weather.rain, this.weather.puddles);
    this.street?.setWetness(this.weather.rain);
    // props
    for (const p of this.layout.props) this.props.spawnSpot(p);
    const sc = this.scenario, tr = this.track, rng = this.rng;
    const scales = this.scales();
    if (sc.start === 'pad') {
      const pd = this.features.pad;
      const a = -140, b = 120;
      const x = pd.x + pd.ax * a + pd.bx * b, z = pd.z + pd.az * a + pd.bz * b;
      this.player = this.spawn('interceptor', 'player', x, z, Math.atan2(-pd.az, pd.ax), 0, pd.y + 1);
    } else {
      // the player on the right-hand carriageway (+s), lane 1, rolling
      const s0 = tr.wrap(tr.overpassS + 1400 + rng.range(-200, 200));
      const pos = tr.point(s0, laneCenterOffset(1));
      this.player = this.spawn('interceptor', 'player', pos.x, pos.z, tr.headingAt(s0, 1), sc.playerSpeed, pos.y + 1);
      this.player.emergency = sc.lightsOn;
      this.player.siren = sc.lightsOn;
      // suspects ahead
      for (const sp of sc.suspects) {
        const s = s0 + sp.ahead;
        const p = tr.point(s, laneCenterOffset(sp.lane));
        const v = this.spawn(sp.kind, 'suspect', p.x, p.z, tr.headingAt(s, 1), sp.speed, p.y + 1, sp.paint);
        const per = PERSONALITIES[sp.personality];
        v.label = per.name;
        const ai = new AiDriver(v, tr, per, rng.fork(v.id), 'flee', 1, sp.lane);
        this.ais.set(v.id, ai);
      }
      // responding police behind
      for (let k = 0; k < sc.police; ++k) {
        const s = s0 - 120 - k * 70;
        const lane = k % 3;
        const p = tr.point(s, laneCenterOffset(lane));
        const v = this.spawn('interceptor', 'police', p.x, p.z, tr.headingAt(s, 1), 36, p.y + 1);
        v.emergency = true; v.siren = true; v.label = `Unit ${[12, 44, 9][k % 3]}`;
        const ai = new AiDriver(v, tr, { ...PERSONALITIES.officer, aggression: 0.55 + 0.15 * k }, rng.fork(v.id), 'pursue', 1, lane);
        this.ais.set(v.id, ai);
      }
      // traffic, both carriageways, concentrated around the start
      for (let k = 0; k < sc.traffic; ++k) {
        const dir: 1 | -1 = rng.chance(0.62) ? 1 : -1;
        const s = s0 + (dir > 0 ? rng.range(150, 1600) : rng.range(-700, 900)) + k * 3;
        const lane = rng.int(0, 2);
        const kind = rng.pick(TRAFFIC_KINDS);
        const p = tr.point(s, dir * laneCenterOffset(lane));
        if (this.vehicles.some((o) => Math.hypot(o.p.x - p.x, o.p.z - p.z) < 14)) continue;
        const per = rng.pick([PERSONALITIES.commuter, PERSONALITIES.commuter, PERSONALITIES.trucker, PERSONALITIES.slowpoke]);
        const v = this.spawn(kind, 'traffic', p.x, p.z, tr.headingAt(s, dir), 28 * per.speedFactor, p.y + 1, rng.pick(TRAFFIC_PAINTS), 1);
        v.label = per.name;
        this.ais.set(v.id, new AiDriver(v, tr, per, rng.fork(v.id), 'cruise', dir, lane));
      }
      for (const v of this.vehicles) {
        const n = tr.nearest(v.p.x, v.p.z);
        v.trackS = n.s; v.trackD = n.d;
      }
      const sus = this.vehicles.filter((v) => v.role === 'suspect');
      let rr = 0;
      for (const ai of this.ais.values()) if (ai.mode === 'pursue') ai.target = sus.length ? sus[rr++ % sus.length] : null;
      if (sus.length) {
        const first = sus[0], per = this.ais.get(first.id)!.p;
        this.game.startPursuit(0, `${colorName(first.paint)} ${first.cls.look.name}`, per.name, per.blurb, rng);
      }
    }
    if (this.player) {
      const n = tr.nearest(this.player.p.x, this.player.p.z);
      this.player.trackS = n.s; this.player.trackD = n.d;
    }
    this.applyConfig(this.cfg, false);
    this.version++;
    if (!this.game.achieved.has('welcome')) this.game.achieve('welcome', 0);
  }

  restart() { this.load(this.scenario.id, this.seed); }

  private spawn(kind: VehicleKind, role: Role, x: number, z: number, yaw: number, speed: number, yHint: number, paint?: string, fidelity = 0) {
    const cls = cloneClass(kind);
    cls.params = vehicleParams(this.cfg, kind);
    const v = new Vehicle(this.gsp, this.phys, cls, role, x, z, yaw, speed, yHint, fidelity, this.scales(), paint ?? cls.look.paint);
    this.vehicles.push(v);
    for (const c of v.colliders) this.colliderToVehicle.set(c.handle, v);
    this.configureAssists(v);
    return v;
  }

  scales(): HandlingScales {
    return { grip: this.cfg.gripScale, suspension: this.cfg.suspensionScale, steeringLock: this.cfg.steeringLockScale };
  }

  private configureAssists(v: Vehicle) {
    const g = this.gsp, h = v.handle;
    if (v.role === 'player') {
      const p = this.cfg.preset;
      g.setPreset(h, p);
      if (p === 2) g.setAids(h, false, 0, 0, true); // SIMULATION aids off, automatic gearbox
      const P = [
        [1, 1.4, 2.5, 4, 0.1, 0.6], [1, 1.2, 4, 6, 0.14, 0.25], [0, 1, 0, 0, 0.14, 0], [1, 1.2, 5, 8, 0.14, 0],
      ][p];
      const drift = p === 3 ? Math.max(0.6, this.cfg.driftAssist) : this.cfg.driftAssist;
      g.setSteering(h, P[0], P[1], P[2], P[3], P[4], P[5], drift);
    } else {
      // AI: direct steering (they compute the road-wheel angle), ABS and a little TCS like any modern car
      g.setPreset(h, 1);
      g.setAids(h, true, v.role === 'traffic' ? 2 : 1, v.role === 'traffic' ? 2 : 0, true);
      g.setSteering(h, 0, 1, 0, 0, 0.14, 0, 0);
    }
  }

  // ------------------------------------------------------------------ lab
  applyConfig(cfg: LabConfig, initial: boolean) {
    const prev = this.cfg;
    this.cfg = cfg;
    for (const [k, s] of Object.entries(cfg.surfaces)) this.gsp.setSurface(Number(k), { ...s, friction: s.friction * cfg.surfaceFriction });
    if (initial || prev.restitution !== cfg.restitution) { this.phys.setRestitution(cfg.restitution); for (const v of this.vehicles) v.setRestitution(cfg.restitution); }
    this.input.sensitivity = cfg.steeringSensitivity;
    if (!initial) {
      for (const v of this.vehicles) {
        const p = vehicleParams(cfg, v.cls.kind);
        v.applyParams(p, this.scales());
        this.configureAssists(v);
      }
    }
  }

  onImpact(f: Listener<ImpactEvent>) { this.impactListeners.add(f); return () => { this.impactListeners.delete(f); }; }
  onAction(f: Listener<Action>) { this.actionListeners.add(f); return () => { this.actionListeners.delete(f); }; }
  private emitImpact(e: ImpactEvent) {
    this.impacts.push(e);
    if (this.impacts.length > 50) this.impacts.shift();
    for (const f of this.impactListeners) f(e);
  }

  // ------------------------------------------------------------------ frame
  frame(realDt: number) {
    realDt = Math.min(realDt, 0.1);
    this.input.update(realDt);
    for (const a of this.input.actions()) this.handleAction(a);
    if (this.replayState.active) {
      const r = this.replayState;
      r.t += realDt * r.speed;
      r.angle += realDt;
      if (r.t >= r.t1) { r.t = r.t0; }
      return;
    }
    if (this.paused) {
      while (this.stepRequests > 0) { this.step(); this.stepRequests--; }
      return;
    }
    const scale = this.slowmo ? this.slowmoScale : 1;
    this.acc += realDt * scale;
    let n = 0;
    while (this.acc >= DT && n < 10) { this.step(); this.acc -= DT; ++n; }
    if (n >= 10) this.acc = 0;
    this.alpha = clamp(this.acc / DT, 0, 1);
  }

  handleAction(a: Action) {
    for (const f of this.actionListeners) f(a);
    const p = this.player;
    switch (a) {
      case 'lights': if (p) { p.emergency = !p.emergency; if (!p.emergency) p.siren = false; } break;
      case 'siren': if (p) { p.siren = !p.siren; if (p.siren) p.emergency = true; } break;
      case 'camera': this.camera = CAMERA_MODES[(CAMERA_MODES.indexOf(this.camera) + 1) % CAMERA_MODES.length]; break;
      case 'reset': if (this.replayState.active) this.stopReplay(); this.restart(); break;
      case 'slowmo': this.slowmo = !this.slowmo; break;
      case 'replay': if (this.replayState.active) this.stopReplay(); else this.startReplay(); break;
      case 'telemetry': this.showTelemetry = !this.showTelemetry; break;
      case 'pause': if (this.replayState.active) this.stopReplay(); else this.paused = !this.paused; break;
      case 'step': if (this.paused) this.stepRequests++; break;
      case 'tow': if (!this.replayState.active) this.recoverPlayer(); break;
      default: break;
    }
  }

  startReplay() {
    const e = this.replay.pick(this.time);
    const now = this.replay.newest();
    const t0 = e ? Math.max(this.replay.oldest(), e.t - 2.5) : Math.max(this.replay.oldest(), now - 6);
    const t1 = e ? Math.min(now, e.t + 3.5) : now;
    if (t1 - t0 < 0.5) return false;
    this.replayState = { active: true, event: e, t: t0, t0, t1, speed: 0.35, angle: 0 };
    return true;
  }
  stopReplay() { this.replayState.active = false; }

  recoverPlayer() {
    const p = this.player;
    if (!p) return;
    const n = this.track.nearest(p.p.x, p.p.z, p.trackS);
    if (Math.abs(n.d) < 40) {
      const dir: 1 | -1 = n.d >= 0 ? 1 : -1;
      const lane = clamp(Math.round((Math.abs(n.d) - XS.innerShoulder) / XS.laneWidth - 0.5), 0, 2);
      const pt = this.track.point(n.s, dir * laneCenterOffset(lane));
      p.respawn(pt.x, pt.y + 1, pt.z, this.track.headingAt(n.s, dir), 0);
    } else {
      p.respawn(p.p.x, p.p.y + 1, p.p.z, p.heading(), 0);
    }
  }

  // ------------------------------------------------------------------ step
  step() {
    const t0 = performance.now();
    const dt = DT;
    this.time += dt;
    this.steps++;
    const tr = this.track;

    // road coordinates (every 4 steps, cheap with a hint)
    if (this.steps % 4 === 0) for (const v of this.vehicles) { const n = tr.nearest(v.p.x, v.p.z, v.trackS); v.trackS = n.s; v.trackD = n.d; }

    // AI at 60 Hz
    const ta = performance.now();
    if ((this.aiPhase = (this.aiPhase + 1) % 2) === 0) {
      const ctx = { vehicles: this.vehicles, time: this.time, dt: dt * 2, pitAid: this.cfg.arcade.enabled ? this.cfg.arcade.aiPolice : 0, sirensNear: (v: Vehicle, r: number) => this.sirensNear(v, r) };
      for (const ai of this.ais.values()) ai.update(ctx);
    }
    const aiMs = performance.now() - ta;

    // player
    const p = this.player;
    if (p) {
      const c = p.controls, inp = this.input;
      c.steer = inp.steer; c.throttle = inp.throttle; c.brake = inp.brake; c.handbrake = inp.handbrake;
    }

    // the vehicle core, per car, then forces to Rapier
    const tc = performance.now();
    const arc = this.cfg.arcade, sub = this.cfg.substeps;
    for (const v of this.vehicles) {
      if (v === p && arc.enabled && (arc.stability > 0 || arc.downforce > 0)) {
        v.prePhysics(dt, sub, (F, T) => this.arcadePlayer(v, F, T));
      } else v.prePhysics(dt, sub);
    }
    const coreMs = performance.now() - tc;

    // signs (Street Dynamics): cars near a sign are handed to it as boxes
    if (this.street) this.stepSigns(dt);

    // Rapier
    const tp = performance.now();
    this.phys.world.step(this.phys.events);
    const rapierMs = performance.now() - tp;
    this.processContacts(dt);

    for (const v of this.vehicles) v.postPhysics(dt);
    this.props.post();

    this.rules(dt);
    this.record();
    const ms = performance.now() - t0;
    const T = this.telemetry;
    T.stepMs = T.stepMs * 0.95 + ms * 0.05;
    T.aiMs = T.aiMs * 0.95 + aiMs * 0.05;
    T.coreMs = T.coreMs * 0.95 + coreMs * 0.05;
    T.rapierMs = T.rapierMs * 0.95 + rapierMs * 0.05;
    T.steps = this.steps;
  }

  // Arcade assistance on the player only (labelled as such in the lab): yaw damping toward the
  // steering's intent and a speed-squared down force. Added to the core's force, never replacing it.
  private arcadePlayer(v: Vehicle, F: V3, T: V3) {
    const a = this.cfg.arcade;
    const up = qrot(v.q, { x: 0, y: 1, z: 0 });
    if (v.upright > 0.7 && !v.airborne) {
      const sp = Math.abs(v.speed);
      if (a.downforce > 0) {
        const f = a.downforce * 0.45 * sp * sp * 1.0; // N (0.45 kg/m at full)
        F.x -= up.x * f; F.y -= up.y * f; F.z -= up.z * f;
      }
      if (a.stability > 0 && sp > 4 && v.controls.handbrake < 0.5) {
        // intended yaw rate from the steering (kinematic bicycle), damp the excess
        const L = v.cls.params.wheelbase;
        const want = (-v.controls.steer * v.cls.params.steeringLock * 0.85 * v.speed) / L; // three yaw (+Y) is left
        const err = v.yawRate - want;
        const Izz = v.info.inertia[2];
        const tau = -clamp(err, -1.2, 1.2) * Izz * 2.2 * a.stability;
        T.x += up.x * tau; T.y += up.y * tau; T.z += up.z * tau;
      }
    }
  }

  private sirensNear(v: Vehicle, r: number) {
    for (const o of this.vehicles) if (o.siren && o !== v && Math.hypot(o.p.x - v.p.x, o.p.z - v.p.z) < r) return true;
    return false;
  }

  private stepSigns(dt: number) {
    const st = this.street!;
    const bodies = [];
    for (const v of this.vehicles) {
      const key = cellKey(Math.floor(v.p.x / 40), Math.floor(v.p.z / 40));
      let near = false;
      for (let di = -1; di <= 1 && !near; ++di) for (let dj = -1; dj <= 1 && !near; ++dj) {
        const b = this.signCells.get(key + di * 100000 + dj);
        if (b) near = true;
      }
      if (!near) continue;
      const L = v.cls.look, b = v.info;
      const cx = (b.front + b.rear) / 2, cy = (b.floor + b.floor + L.height - L.groundClearance) / 2;
      const c = v.toWorld({ x: cx, y: cy, z: 0 });
      bodies.push({ id: v.id, c, q: v.q, half: [(b.front - b.rear) / 2, (L.height - L.groundClearance) / 2, L.width / 2] as [number, number, number], v: v.v, w: v.w });
    }
    st.setBodies(bodies);
    st.step(dt);
    for (const b of bodies) {
      const J = st.impulse(b.id);
      if (J.x || J.y || J.z) { const v = this.vehicles.find((x) => x.id === b.id); v?.body.applyImpulse(J, true); }
    }
    for (const e of st.events()) {
      if (e.name === 'POST_DOWN' || e.name === 'POST_BROKEN' || e.name === 'BASE_RELEASED') {
        const at = { x: e.at[0], y: e.at[2], z: -e.at[1] };
        this.game.counters.signsDown++;
        this.game.property(850, 'sign', this.time);
        this.game.achieve('gdot', this.time);
        this.emitImpact({ ...at, strength: 0.5, kind: 'sign', t: this.time, involvesPlayer: true });
        this.replay.event({ t: this.time, kind: 'sign', ...at, severity: 2, ids: [] });
      }
    }
  }

  private processContacts(dt: number) {
    const w = this.phys.world;
    const seen = new Set<string>();
    this.phys.events.drainContactForceEvents((e) => {
      const h1 = e.collider1(), h2 = e.collider2();
      const key = h1 < h2 ? `${h1}:${h2}` : `${h2}:${h1}`;
      if (seen.has(key)) return;
      seen.add(key);
      const J = e.totalForceMagnitude() * dt; // N s over this step
      const v1 = this.colliderToVehicle.get(h1), v2 = this.colliderToVehicle.get(h2);
      const p1 = this.props.colliderToProp.get(h1), p2 = this.props.colliderToProp.get(h2);
      if (!v1 && !v2) {
        if ((p1 || p2) && J > 30) this.propHit((p1 ?? p2)!, null, J);
        return;
      }
      const c1 = w.getCollider(h1), c2 = w.getCollider(h2);
      let point: V3 | null = null, normal: V3 = { x: 0, y: 1, z: 0 };
      w.contactPair(c1, c2, (m, flipped) => {
        if (point || m.numSolverContacts() === 0) return;
        const sp = m.solverContactPoint(0);
        if (!sp) return;
        point = { x: sp.x, y: sp.y, z: sp.z };
        const n = m.normal();
        normal = flipped ? { x: -n.x, y: -n.y, z: -n.z } : { x: n.x, y: n.y, z: n.z };
      });
      if (!point) {
        const a = (v1 ?? v2)!;
        point = { ...a.p };
      }
      const pt = point as V3;
      if (v1 && v2) this.carCar(v1, v2, pt, normal, J);
      else {
        const v = (v1 ?? v2)!;
        const into = v1 ? { x: -normal.x, y: -normal.y, z: -normal.z } : normal; // impulse direction on v
        const other = v1 ? h2 : h1;
        const st = this.phys.staticInfo.get(other);
        const prop = p1 ?? p2;
        if (prop) { this.propHit(prop, v, J); return; }
        this.carStatic(v, st, pt, into, J);
      }
    });
  }

  private damageCar(v: Vehicle, pt: V3, into: V3, J: number, other: string) {
    const dv = J / v.info.mass;
    if (dv < 0.25) return dv;
    const lp = v.toLocal(pt), ln = qinvrot(v.q, into);
    const ev: DamageEvent[] = [];
    v.damage.impact(lp.x, lp.y, lp.z, ln.x, ln.y, ln.z, dv, this.rng, ev);
    // a car can only be billed up to a total loss
    const cost = Math.max(0, Math.min(Math.round(dv * v.cls.repairCostPerDv), Math.round(v.cls.value * 1.15) - v.billed));
    v.billed += cost;
    if (cost === 0 && v.billed > 0 && !v.totaled && v.role !== 'player') v.totaled = v.billed >= v.cls.value;
    if (v.role === 'player' || v.role === 'police') this.game.patrol(cost, this.time);
    else this.game.property(cost, v.role, this.time);
    this.handleDamageEvents(v, ev, pt);
    if (dv > 0.6) {
      const T = this.telemetry.contacts;
      T.unshift({ t: this.time, a: v.label || v.role, b: other, impulse: J, dv });
      if (T.length > 12) T.pop();
    }
    if (dv > 1.5) v.lastImpact = this.time;
    return dv;
  }

  private carCar(a: Vehicle, b: Vehicle, pt: V3, n: V3, J: number) {
    // impulse on b is +n, on a is -n
    const dva = this.damageCar(a, pt, { x: -n.x, y: -n.y, z: -n.z }, J, b.label || b.role);
    const dvb = this.damageCar(b, pt, n, J, a.label || a.role);
    const dv = Math.max(dva, dvb);
    const involves = a === this.player || b === this.player;
    if (dv > 0.5) this.emitImpact({ ...pt, strength: clamp(dv / 6, 0.05, 1), kind: 'car', t: this.time, involvesPlayer: involves });
    if (dv > 1.2) this.replay.event({ t: this.time, kind: 'collision', ...pt, severity: dv, ids: [a.id, b.id] });
    // PIT: a pursuer's push on a suspect's rear quarter
    for (const [att, tgt, dir] of [[a, b, 1], [b, a, -1]] as [Vehicle, Vehicle, number][]) {
      if ((att.role !== 'player' && att.role !== 'police') || tgt.role !== 'suspect') continue;
      const lp = tgt.toLocal(pt);
      const half = tgt.cls.look.length / 2;
      if (lp.x > -half * 0.15) continue; // not the rear half
      if (!this.pitWatch.some((w) => w.target === tgt)) this.pitWatch.push({ target: tgt, until: this.time + 2.5, heading0: tgt.heading() });
      // arcade PIT assist: amplify the yaw component of the contact's own angular impulse
      const pa = this.cfg.arcade;
      if (pa.enabled && pa.pitAssist > 0 && J > 200) {
        const r = { x: pt.x - tgt.p.x, y: pt.y - tgt.p.y, z: pt.z - tgt.p.z };
        const Jv = { x: n.x * J * dir, y: n.y * J * dir, z: n.z * J * dir }; // impulse on tgt
        const Ly = r.z * Jv.x - r.x * Jv.z; // (r x J).y
        tgt.body.applyTorqueImpulse({ x: 0, y: Ly * pa.pitAssist * 1.4, z: 0 }, true);
      }
    }
  }

  private carStatic(v: Vehicle, st: StaticInfo | undefined, pt: V3, into: V3, J: number) {
    const dv = this.damageCar(v, pt, into, J, st?.kind ?? 'scenery');
    if (dv < 0.3) return;
    const kind = st?.kind;
    const metal = kind === 'guardrail' || kind === 'pole' || kind === 'rail' || kind === 'billboard';
    this.emitImpact({ ...pt, strength: clamp(dv / 6, 0.05, 1), kind: metal ? 'metal' : 'concrete', t: this.time, involvesPlayer: v === this.player });
    if (dv > 1.5) this.replay.event({ t: this.time, kind: 'collision', ...pt, severity: dv, ids: [v.id] });
    if (kind === 'guardrail' && st?.segment !== undefined) {
      const seg = this.phys.railSegments[st.segment];
      if (seg && dv > 0.8 && this.time - (this.railCooldown.get(st.segment) ?? -9) > 1.5) {
        this.railCooldown.set(st.segment, this.time);
        seg.hits++;
        seg.offset = Math.min(0.45, seg.offset + dv * 0.04);
        seg.tilt = Math.min(0.5, seg.tilt + dv * 0.03);
        this.game.counters.guardrailHits++;
        this.game.property(Math.round(1200 + dv * 900), 'guardrail', this.time);
        this.game.achieve('guardrail', this.time);
        this.version++;
      }
    } else if (kind === 'barrier' && dv > 1) this.game.property(Math.round(400 + dv * 300), 'barrier', this.time);
    else if ((kind === 'pier' || kind === 'abutment' || kind === 'deck') && dv > 2) { this.game.property(Math.round(5000 + dv * 2500), 'bridge', this.time); this.game.achieve('overpass', this.time); }
    else if ((kind === 'pole' || kind === 'billboard') && dv > 1) this.game.property(Math.round(900 + dv * 400), kind, this.time);
  }

  private propHit(prop: Prop, v: Vehicle | null, J: number) {
    if (!prop.knocked && prop.kind !== 'debris' && this.time > 0.5) {
      const t = prop.body.translation();
      const moved = Math.hypot(t.x - prop.home.x, t.z - prop.home.z);
      if (moved > 0.5 || (v && J > 80)) {
        prop.knocked = true;
        if (prop.kind === 'cone') { this.game.counters.conesLost++; this.game.property(38, 'cone', this.time); if (this.game.counters.conesLost >= 10) this.game.achieve('cones', this.time); }
        else this.game.property(prop.kind === 'drum' ? 95 : 160, prop.kind, this.time);
      }
    }
    if (v && J > 60) this.emitImpact({ ...prop.p, strength: clamp(J / 2500, 0.05, 0.6), kind: 'prop', t: this.time, involvesPlayer: v === this.player });
  }

  private handleDamageEvents(v: Vehicle, ev: DamageEvent[], pt: V3) {
    for (const e of ev) {
      if (e.type === 'detach') this.detach(v, e.part);
      else if (e.type === 'glass') this.breakGlass(v, e.window, e.x, e.y, e.z, e.speed);
      else if (e.type === 'light') this.emitImpact({ ...pt, strength: 0.2, kind: 'glass', t: this.time, involvesPlayer: v === this.player });
    }
  }

  // Where a detachable part sits on the body (three body frame) and its size.
  partGeometry(v: Vehicle, part: PartId): { c: V3; half: [number, number, number]; mass: number } {
    const L = v.cls.look, hl = L.length / 2, hw = L.width / 2, gc = L.groundClearance - v.cls.params.cgHeight;
    switch (part) {
      case 'bumperF': return { c: { x: hl - 0.12, y: gc + 0.32, z: 0 }, half: [0.14, 0.17, hw - 0.05], mass: 9 };
      case 'bumperR': return { c: { x: -hl + 0.12, y: gc + 0.35, z: 0 }, half: [0.14, 0.16, hw - 0.05], mass: 8 };
      case 'pushbar': return { c: { x: hl + 0.12, y: gc + 0.45, z: 0 }, half: [0.12, 0.3, 0.6], mass: 18 };
      case 'mirrorL': return { c: { x: hl * 0.32, y: gc + 0.95, z: -hw - 0.1 }, half: [0.1, 0.07, 0.11], mass: 1.2 };
      case 'mirrorR': return { c: { x: hl * 0.32, y: gc + 0.95, z: hw + 0.1 }, half: [0.1, 0.07, 0.11], mass: 1.2 };
      case 'lightbar': return { c: { x: -0.1, y: gc + L.height - L.groundClearance + 0.07, z: 0 }, half: [0.17, 0.06, 0.62], mass: 11 };
      case 'antenna': return { c: { x: -hl * 0.4, y: gc + L.height - L.groundClearance + 0.1, z: 0.3 }, half: [0.02, 0.18, 0.02], mass: 0.3 };
      case 'tailgate': return { c: { x: -hl + 0.06, y: gc + 0.75, z: 0 }, half: [0.05, 0.28, hw - 0.1], mass: 22 };
      default: {
        const k = Number(part.slice(-1));
        const w = v.wheels[k];
        return { c: { x: w?.x ?? 0, y: w?.y ?? 0, z: (w?.z ?? 0) + Math.sign(w?.z ?? 1) * 0.15 }, half: [0.2, 0.2, 0.02], mass: 0.8 };
      }
    }
  }

  private detach(v: Vehicle, part: PartId) {
    const g = this.partGeometry(v, part);
    const wp = v.toWorld(g.c);
    // velocity of that point on the body plus a kick outward
    const r = { x: wp.x - v.p.x, y: wp.y - v.p.y, z: wp.z - v.p.z };
    const vel = { x: v.v.x + v.w.y * r.z - v.w.z * r.y, y: v.v.y + v.w.z * r.x - v.w.x * r.z + 1.5, z: v.v.z + v.w.x * r.y - v.w.y * r.x };
    const out = qrot(v.q, { x: Math.sign(g.c.x) * 0.5, y: 0.3, z: Math.sign(g.c.z) * 1.2 });
    vel.x += out.x * 2; vel.y += out.y * 2; vel.z += out.z * 2;
    const spin = { x: this.rng.range(-6, 6), y: this.rng.range(-6, 6), z: this.rng.range(-6, 6) };
    const color = part === 'lightbar' ? '#222' : part.startsWith('hubcap') ? '#c9ccd0' : part === 'pushbar' ? '#111' : v.paint;
    this.props.spawnDebris(part, wp, v.q, vel, spin, g.half, g.mass, color, this.time, v.id);
    this.version++;
  }

  // Window geometry on the body (three body frame) for the glass engine's pane.
  windowFrame(v: Vehicle, win: WindowId) {
    const L = v.cls.look, hl = L.length / 2, hw = L.width / 2;
    const base = L.groundClearance - v.cls.params.cgHeight; // ground level in the body frame
    const belt = base + L.height * 0.6, roof = base + L.height - 0.05;
    const H = Math.max(0.3, roof - belt - 0.06);
    if (win === 'windscreen') return { W: L.width * 0.78, H: H * 1.25, origin: { x: hl * 0.32, y: belt, z: -L.width * 0.39 }, along: { x: 0, y: 0, z: 1 }, up: { x: -0.6, y: 0.8, z: 0 }, through: { x: -0.8, y: -0.6, z: 0 } };
    if (win === 'rear') return { W: L.width * 0.72, H: H * 0.9, origin: { x: -hl * 0.45, y: belt, z: L.width * 0.36 }, along: { x: 0, y: 0, z: -1 }, up: { x: 0.55, y: 0.83, z: 0 }, through: { x: 0.83, y: -0.55, z: 0 } };
    const side = win === 'sideL' ? -1 : 1;
    return { W: L.length * 0.2, H, origin: { x: hl * 0.18, y: belt + 0.04, z: side * (hw - 0.05) }, along: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 0.97, z: -side * 0.22 }, through: { x: 0, y: 0, z: -side } };
  }

  private breakGlass(v: Vehicle, win: WindowId, lx: number, ly: number, lz: number, speed: number) {
    this.game.counters.windows++;
    this.game.achieve('glass', this.time);
    const f = this.windowFrame(v, win);
    const rot = (d: V3) => qrot(v.q, d);
    const origin = v.toWorld(f.origin);
    // hit point projected into the pane
    const d = { x: lx - f.origin.x, y: ly - f.origin.y, z: lz - f.origin.z };
    const hx = d.x * f.along.x + d.y * f.along.y + d.z * f.along.z;
    const hy = d.x * f.up.x + d.y * f.up.y + d.z * f.up.z;
    const floor = Math.max(0.3, origin.y - this.ground.heightAt(origin.x, origin.z));
    this.glass.request({ vehicleId: v.id, window: win, W: f.W, H: f.H, origin, along: rot(f.along), up: rot(f.up), through: rot(f.through) }, hx, hy, speed, floor, (this.rng.next() * 1e9) | 0);
    const wp = v.toWorld({ x: lx, y: ly, z: lz });
    this.emitImpact({ ...wp, strength: 0.7, kind: 'glass', t: this.time, involvesPlayer: v === this.player });
    this.replay.event({ t: this.time, kind: 'glass', ...wp, severity: 2.5, ids: [v.id] });
    this.version++;
  }

  // ------------------------------------------------------------------ rules
  private rules(dt: number) {
    const g = this.game, t = this.time, p = this.player;
    g.tick(dt, t, this.rng);
    // PIT confirmation: the suspect turned > 75 degrees within 2.5 s of the push
    this.pitWatch = this.pitWatch.filter((w) => {
      if (Math.abs(wrapAngle(w.target.heading() - w.heading0)) > 1.3) { g.pitDone(t, this.rng); this.replay.event({ t, kind: 'pit', ...w.target.p, severity: 8, ids: [w.target.id] }); return false; }
      return t < w.until;
    });
    for (const v of this.vehicles) {
      // rollovers
      if (v.upright < 0.2 && !this.airTime.has(-v.id)) { this.airTime.set(-v.id, 1); g.achieve('rollover', t); this.replay.event({ t, kind: 'rollover', ...v.p, severity: 9, ids: [v.id] }); if (v.role === 'suspect' || v.role === 'traffic') g.property(v.cls.value, 'total loss', t); }
      if (v.upright > 0.8) this.airTime.delete(-v.id);
      // fell out of the world, or a numerical fault: put it back
      if (v.p.y < this.ground.heightAt(v.p.x, v.p.z) - 15 || !Number.isFinite(v.p.y)) {
        const n = this.track.nearest(v.p.x, v.p.z, v.trackS);
        const pt = this.track.point(n.s, (n.d >= 0 ? 1 : -1) * laneCenterOffset(1));
        v.respawn(pt.x, pt.y + 1, pt.z, this.track.headingAt(n.s, n.d >= 0 ? 1 : -1), 0);
      }
    }
    if (p) {
      const air = p.airborne ? (this.airTime.get(p.id) ?? 0) + dt : 0;
      this.airTime.set(p.id, air);
      if (air > 1.0) g.achieve('airtime', t);
      this.driftTime = Math.abs(p.sideslip) > 0.5 && Math.abs(p.speed) > 15 ? this.driftTime + dt : 0;
      if (this.driftTime > 2) g.achieve('drift', t);
      const dir = p.trackD >= 0 ? 1 : -1;
      const along = wrapAngle(p.heading() - this.track.headingAt(p.trackS, dir as 1 | -1));
      this.wrongWay = Math.abs(p.trackD) > XS.median && Math.abs(p.trackD) < XS.outerShoulder && Math.abs(along) > 2.4 && p.speed > 15 ? this.wrongWay + dt : 0;
      if (this.wrongWay > 4) g.achieve('wrongway', t);
    }
    // apprehensions: a suspect stopped (or on its roof) for 3 s with a trooper close by is detained;
    // the pursuit ends when every suspect is
    const sus = this.vehicles.filter((v) => v.role === 'suspect');
    for (const s of sus) {
      const ai = this.ais.get(s.id);
      if (!ai) continue;
      if ((ai.mode === 'flee' || ai.mode === 'recover') && (s.damage.total > 42 || s.upright < 0.3)) { ai.mode = 'stopped'; s.totaled = true; }
      if (s.detained) continue;
      const stopped = Math.abs(s.speed) < 2 || s.upright < 0.3;
      const cop = this.vehicles.some((o) => (o.role === 'player' || o.role === 'police') && Math.hypot(o.p.x - s.p.x, o.p.z - s.p.z) < 35);
      s.stopTimer = stopped && cop ? s.stopTimer + dt : 0;
      if (s.stopTimer > 3) {
        s.detained = true;
        ai.mode = 'surrender';
        const rest = sus.filter((x) => !x.detained).length;
        const how = s.upright < 0.3 ? 'Came to rest on the roof. Suspect is fine; the paint job is not.' : s.totaled ? 'Vehicle disabled. Suspect detained without injury.' : 'Stopped and boxed in. Suspect detained without injury.';
        g.apprehend(s.label, how, t, rest === 0);
        if (rest === 0 && g.pursuit.active && !g.pursuit.concluded) g.conclude(t, sus.length > 1 ? `All ${sus.length} suspects detained. ${how}` : how, this.rng);
      }
    }
    // troopers go after the nearest suspect still running
    if (this.steps % 60 === 0) for (const ai of this.ais.values()) {
      if (ai.mode !== 'pursue') continue;
      const cur = ai.target;
      if (cur && !cur.detained && this.ais.get(cur.id)?.mode !== 'surrender') continue;
      let best: Vehicle | null = null, bd = Infinity;
      for (const s of sus) { if (s.detained) continue; const d = Math.hypot(s.p.x - ai.v.p.x, s.p.z - ai.v.p.z); if (d < bd) { bd = d; best = s; } }
      if (best) ai.target = best;
    }
  }

  private record() {
    const R = this.replay;
    if (!R.shouldRecord(DT)) return;
    const slot = R.begin(this.time);
    const cs = ReplayBuffer.carStride, ps = ReplayBuffer.propStride;
    for (const v of this.vehicles) {
      const a = R.car(v.id), o = slot * cs;
      a[o] = v.p.x; a[o + 1] = v.p.y; a[o + 2] = v.p.z; a[o + 3] = v.q.x; a[o + 4] = v.q.y; a[o + 5] = v.q.z; a[o + 6] = v.q.w;
      for (let k = 0; k < 4; ++k) { const w = v.wheels[k]; a[o + 7 + 3 * k] = w?.y ?? 0; a[o + 8 + 3 * k] = w?.steer ?? 0; a[o + 9 + 3 * k] = w?.spin ?? 0; }
      a[o + 19] = v.brakeLight;
      a[o + 20] = (v.emergency ? 1 : 0) + (v.reversing ? 2 : 0);
    }
    for (const p of this.props.list) {
      if (p.body.isSleeping() && !p.knocked) continue;
      const a = R.prop(p.id), o = slot * ps;
      a[o] = p.p.x; a[o + 1] = p.p.y; a[o + 2] = p.p.z; a[o + 3] = p.q.x; a[o + 4] = p.q.y; a[o + 5] = p.q.z; a[o + 6] = p.q.w;
    }
    R.end();
  }

  dispose() {
    this.input.detach();
    for (const v of this.vehicles) v.destroy();
  }
}

function cellKey(i: number, j: number) { return i * 100000 + j; }
function tick() { return new Promise((r) => setTimeout(r, 0)); }
function colorName(hex: string) {
  const names: Record<string, string> = { '#8a1d1d': 'red', '#e8e2c8': 'cream', '#e6e3da': 'white', '#5d6b74': 'grey', '#d8b21c': 'yellow', '#2f3b2c': 'green', '#2a6f9b': 'blue' };
  return names[hex] ?? 'beat-up';
}
