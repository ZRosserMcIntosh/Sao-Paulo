'use client';
// The app: loads the engines and the world, then shows the scenario menu, the game and its
// overlays. Owns the Simulation and the audio (outside React state).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Simulation } from '../sim/Simulation';
import { GameAudio } from '../sim/audio';
import { useGame, type Hud } from '../state/store';
import { GameScene } from '../render/Scene';
import { LOADING_LINES } from '../sim/game';
import { SCENARIOS, type ScenarioId } from '../sim/scenarios';
import { SURFACE_NAMES } from '../sim/world/terrain';
import { HudView } from './Hud';
import { LabPanel } from './LabPanel';
import { Menu } from './Menu';
import { Toasts } from './Toasts';
import { PauseMenu } from './PauseMenu';

const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? '') + '/engines/';

export default function Game() {
  const phase = useGame((s) => s.phase);
  const progress = useGame((s) => s.progress);
  const message = useGame((s) => s.message);
  const quality = useGame((s) => s.quality);
  const set = useGame((s) => s.set);
  const simRef = useRef<Simulation | null>(null);
  const audioRef = useRef<GameAudio | null>(null);
  const [line, setLine] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [labOpen, setLabOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [photo, setPhoto] = useState(() => typeof location !== 'undefined' && new URLSearchParams(location.search).get('ui') === '0');
  const fps = useRef({ frames: 0, t: 0, value: 60 });

  useEffect(() => {
    let alive = true;
    const iv = setInterval(() => setLine((l) => (l + 1) % LOADING_LINES.length), 2200);
    Simulation.create(BASE, (p, m) => set({ progress: p, message: m }))
      .then((sim) => {
        if (!alive) { sim.dispose(); return; }
        simRef.current = sim;
        (window as unknown as { gsp: Simulation }).gsp = sim; // for the curious (and for tests)
        audioRef.current = new GameAudio(BASE);
        sim.game.onToast = (t) => useGame.getState().pushToast(t);
        sim.game.onRadio = (text) => audioRef.current?.radio(text);
        sim.onAction((a) => {
          if (a === 'telemetry') setLabOpen(sim.showTelemetry);
          if (a === 'pause') setPaused(sim.paused);
          if (a === 'menu') set({ phase: 'menu' });
          if (a === 'photo') setPhoto((x) => !x);
        });
        // optional deep link: ?scenario=C&seed=7
        const qs = new URLSearchParams(location.search);
        const sc = qs.get('scenario')?.toUpperCase() as ScenarioId | undefined;
        if (sc && SCENARIOS.some((s) => s.id === sc)) {
          const seed = Number(qs.get('seed')) || 1;
          sim.load(sc, seed);
          set({ phase: 'playing', progress: 1, scenario: sc, seed });
        } else {
          sim.load('A', 1);
          set({ phase: 'menu', progress: 1 });
        }
      })
      .catch((e) => { console.error(e); setError(String(e?.message ?? e)); });
    return () => { alive = false; clearInterval(iv); simRef.current?.dispose(); audioRef.current?.stop(); };
  }, [set]);

  // HUD snapshot, ~10 Hz
  useEffect(() => {
    const iv = setInterval(() => {
      const sim = simRef.current;
      if (!sim || useGame.getState().phase !== 'playing') return;
      useGame.getState().set({ hud: snapshot(sim, fps.current.value) });
      setPaused(sim.paused);
    }, 100);
    return () => clearInterval(iv);
  }, []);

  const start = useCallback(async (id: ScenarioId, seed: number) => {
    const sim = simRef.current;
    if (!sim) return;
    sim.paused = false;
    sim.load(id, seed);
    set({ phase: 'playing', scenario: id, seed });
    const a = audioRef.current;
    if (a) { await a.start(sim); const s = useGame.getState(); a.setVolume(s.volume, s.muted); a.voice = s.voice; }
  }, [set]);

  const onFrame = useCallback((dt: number) => {
    const sim = simRef.current;
    if (!sim) return;
    audioRef.current?.update(sim, dt);
    const f = fps.current;
    f.frames++; f.t += dt;
    if (f.t > 0.5) { f.value = f.frames / f.t; f.frames = 0; f.t = 0; sim.telemetry.fps = f.value; }
  }, []);

  // keep audio settings in sync
  useEffect(() => useGame.subscribe((s) => { const a = audioRef.current; if (a) { a.setVolume(s.volume, s.muted); a.voice = s.voice; } }), []);
  // the menu disables the driving keys
  useEffect(() => { const sim = simRef.current; if (sim) sim.input.enabled = phase === 'playing'; }, [phase]);

  if (error) {
    return (
      <div className="fixed inset-0 grid place-items-center p-6">
        <div className="max-w-lg rounded-xl border border-red-400/40 bg-red-950/40 p-6">
          <h1 className="font-display text-xl text-red-300">The engines would not start</h1>
          <p className="mt-2 text-sm text-white/80">{error}</p>
          <p className="mt-3 text-sm text-white/60">This needs WebGL 2 and WebAssembly (any recent Chrome, Edge, Firefox or Safari on a desktop).</p>
        </div>
      </div>
    );
  }
  const sim = simRef.current;
  return (
    <div className="fixed inset-0 select-none">
      {sim && (phase === 'playing' || phase === 'menu') && <GameScene sim={sim} quality={quality} onFrame={onFrame} />}
      {phase === 'loading' && <Loading progress={progress} message={message} line={LOADING_LINES[line]} />}
      {sim && phase === 'menu' && <Menu onStart={start} />}
      {sim && phase === 'playing' && !photo && (
        <>
          <HudView sim={sim} />
          <Toasts />
          {labOpen && <LabPanel sim={sim} onClose={() => { sim.showTelemetry = false; setLabOpen(false); }} />}
          {paused && !sim.replayState.active && <PauseMenu sim={sim} onResume={() => { sim.paused = false; setPaused(false); }} onMenu={() => { sim.paused = false; setPaused(false); set({ phase: 'menu' }); }} />}
          <button className="absolute right-3 bottom-3 rounded bg-black/40 px-2 py-1 text-[11px] text-white/70 hover:bg-black/60" onClick={() => { sim.showTelemetry = !sim.showTelemetry; setLabOpen(sim.showTelemetry); }}>Lab (Tab)</button>
        </>
      )}
    </div>
  );
}

function Loading({ progress, message, line }: { progress: number; message: string; line: string }) {
  return (
    <div className="fixed inset-0 grid place-items-center bg-[radial-gradient(ellipse_at_top,#1f3a6b,#0b0f16_70%)]">
      <div className="w-[min(560px,90vw)] text-center">
        <div className="font-display text-4xl tracking-tight text-gsp-orange drop-shadow">GEORGIA STATE PURSUIT</div>
        <div className="mt-1 text-sm uppercase tracking-[0.3em] text-gsp-silver/80">Vehicle Physics Demonstrator</div>
        <div className="mt-8 h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-gradient-to-r from-gsp-orange to-amber-300 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="mt-3 text-xs text-white/50">{message}</div>
        <div className="mt-8 min-h-12 text-lg italic text-white/85">“{line}”</div>
      </div>
    </div>
  );
}

function snapshot(sim: Simulation, fps: number): Hud {
  const p = sim.player!;
  const g = sim.game;
  const sus = sim.vehicles.filter((v) => v.role === 'suspect').map((s) => ({
    name: s.label, dist: Math.hypot(s.p.x - p.p.x, s.p.z - p.p.z), speed: Math.abs(s.speed), mode: sim.ais.get(s.id)?.mode ?? '?', damage: s.damage.total,
  }));
  const w = p.wheels[2] ?? p.wheels[0];
  return {
    speed: Math.abs(p.speed), rpm: p.rpm, redline: p.cls.params.redlineRpm, gear: p.gear, throttle: p.controls.throttle, brake: p.controls.brake,
    emergency: p.emergency, siren: p.siren, camera: sim.camera, slowmo: sim.slowmo, paused: sim.paused, replay: sim.replayState.active,
    pursuit: { active: g.pursuit.active, concluded: g.pursuit.concluded, time: g.counters.pursuitTime, suspects: sus },
    counters: { ...g.counters }, damage: p.damage.total, health: p.damage.health, preset: sim.cfg.preset,
    surface: SURFACE_NAMES[w?.surface ?? 0] ?? '—', upright: p.upright, pad: sim.input.padConnected, fps,
  };
}
