'use client';
import { useState } from 'react';
import { SCENARIOS, type ScenarioId } from '../sim/scenarios';
import { useGame, type QualityName } from '../state/store';

export function Menu({ onStart }: { onStart: (id: ScenarioId, seed: number) => void }) {
  const cur = useGame((s) => s.scenario);
  const seed0 = useGame((s) => s.seed);
  const quality = useGame((s) => s.quality);
  const volume = useGame((s) => s.volume);
  const voice = useGame((s) => s.voice);
  const set = useGame((s) => s.set);
  const [sel, setSel] = useState<ScenarioId>(cur);
  const [seed, setSeed] = useState(seed0);
  const sc = SCENARIOS.find((s) => s.id === sel)!;
  return (
    <div className="absolute inset-0 overflow-y-auto bg-gradient-to-b from-black/70 via-black/40 to-black/80 p-4 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="font-display text-3xl text-gsp-orange sm:text-5xl">GEORGIA STATE PURSUIT</div>
            <div className="text-xs uppercase tracking-[0.3em] text-gsp-silver">Vehicle physics demonstrator · Peach State Patrol (fictional)</div>
          </div>
          <div className="text-right text-[11px] text-white/50">OpenRoad Dynamics · Rapier · Glass Dynamics · Street Dynamics</div>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SCENARIOS.map((s) => (
            <button key={s.id} onClick={() => setSel(s.id)} onDoubleClick={() => onStart(s.id, seed)}
              className={`rounded-xl border p-4 text-left transition ${sel === s.id ? 'border-gsp-orange bg-gsp-blue/70' : 'border-white/15 bg-black/45 hover:border-white/40'}`}>
              <div className="flex items-baseline gap-2"><span className="font-display text-2xl text-gsp-orange">{s.id}</span><span className="font-semibold">{s.title}</span></div>
              <div className="mt-1 text-sm italic text-white/80">{s.tagline}</div>
            </button>
          ))}
        </div>
        <div className="mt-5 rounded-xl border border-white/15 bg-black/55 p-4">
          <div className="font-semibold">Scenario {sc.id} — {sc.title}</div>
          <p className="mt-1 max-w-3xl text-sm text-white/80">{sc.description}</p>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">Seed
              <input type="number" value={seed} min={1} onChange={(e) => setSeed(Math.max(1, Number(e.target.value) | 0))} className="w-24 rounded bg-white/10 px-2 py-1" />
              <button className="rounded bg-white/10 px-2 py-1 hover:bg-white/20" onClick={() => setSeed(1 + Math.floor(Math.random() * 99999))}>🎲</button>
            </label>
            <label className="flex items-center gap-2">Graphics
              <select value={quality} onChange={(e) => { const q = e.target.value as QualityName; set({ quality: q }); try { localStorage.setItem('gsp.quality', q); } catch { /* */ } }} className="rounded bg-white/10 px-2 py-1">
                {['low', 'medium', 'high', 'ultra'].map((q) => <option key={q} value={q} className="bg-slate-900">{q}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2">Volume <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => set({ volume: Number(e.target.value) })} /></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={voice} onChange={(e) => set({ voice: e.target.checked })} /> Dispatch voice</label>
            <button onClick={() => onStart(sel, seed)} className="ml-auto rounded-lg bg-gsp-orange px-6 py-2 font-display text-lg text-black shadow-lg hover:brightness-110">ROLL OUT ▸</button>
          </div>
        </div>
        <div className="mt-5 grid gap-3 text-xs text-white/70 sm:grid-cols-2">
          <div className="rounded-xl bg-black/40 p-4 leading-relaxed">
            <div className="mb-1 font-semibold text-white">Controls</div>
            W / ↑ accelerate · S / ↓ brake, hold to reverse · A / D steer · Space handbrake<br />
            L emergency lights · H siren · G horn · C camera · R restart · T slow motion · F replay the last crash<br />
            Tab engineering lab (telemetry, sliders, JSON) · Esc pause · N single step while paused · Y tow (back on the road)<br />
            Gamepad: analog steering, RT throttle, LT brake, X handbrake, Y camera, B lights, LB siren, Start pause.
          </div>
          <div className="rounded-xl bg-black/40 p-4 leading-relaxed">
            <div className="mb-1 font-semibold text-white">How it works</div>
            Every car (yours, the suspect's, the troopers', the traffic's) runs on the same OpenRoad Dynamics vehicle core: Pacejka tyres, unsprung wheels, a real drivetrain and automatic gearbox. Rapier hosts the chassis and every contact. Spins, PITs and rollovers come out of the physics. The arcade aids are labelled, optional, and live in the lab.
            <div className="mt-2 text-white/40">Entertainment only. Not police training. No pedestrians, no injuries: just paperwork.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
