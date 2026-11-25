'use client';
// Main menu: Play (scenarios), Settings, Controls, About.
import { useState } from 'react';
import { SCENARIOS, type ScenarioId } from '../sim/scenarios';
import type { Simulation } from '../sim/Simulation';
import { useGame } from '../state/store';
import { SettingsPanel } from './Settings';
import { ControlsSheet } from './Controls';

type Tab = 'play' | 'settings' | 'controls' | 'about';
const TABS: { id: Tab; label: string }[] = [
  { id: 'play', label: 'Play' }, { id: 'settings', label: 'Settings' }, { id: 'controls', label: 'Controls' }, { id: 'about', label: 'About' },
];
const KIND: Record<ScenarioId, string> = { A: 'Practice', B: 'Pursuit', C: 'Pursuit', D: 'Pursuit', E: 'Conditions', F: 'Chaos' };

export function Menu({ sim, onStart }: { sim: Simulation; onStart: (id: ScenarioId, seed: number) => void }) {
  const cur = useGame((s) => s.scenario);
  const seed0 = useGame((s) => s.seed);
  const [tab, setTab] = useState<Tab>('play');
  const [sel, setSel] = useState<ScenarioId>(cur);
  const [seed, setSeed] = useState(seed0);
  const sc = SCENARIOS.find((s) => s.id === sel)!;
  return (
    <div className="absolute inset-0 overflow-y-auto bg-gradient-to-b from-black/75 via-black/45 to-black/85 p-4 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="font-display text-3xl text-gsp-orange sm:text-5xl">GEORGIA STATE PURSUIT</div>
            <div className="text-xs uppercase tracking-[0.3em] text-gsp-silver">Vehicle physics demonstrator · Peach State Patrol (fictional)</div>
          </div>
          <nav className="flex gap-1 rounded-xl bg-black/40 p-1" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === t.id ? 'bg-gsp-orange text-black' : 'text-white/75 hover:bg-white/10'}`}>{t.label}</button>
            ))}
          </nav>
        </header>

        {tab === 'play' && (
          <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_340px]">
            <div className="grid gap-3 sm:grid-cols-2">
              {SCENARIOS.map((s) => (
                <button key={s.id} onClick={() => setSel(s.id)} onDoubleClick={() => onStart(s.id, seed)}
                  className={`rounded-xl border p-4 text-left transition ${sel === s.id ? 'border-gsp-orange bg-gsp-blue/70' : 'border-white/15 bg-black/45 hover:border-white/40'}`}>
                  <div className="flex items-baseline justify-between">
                    <span className="flex items-baseline gap-2"><span className="font-display text-2xl text-gsp-orange">{s.id}</span><span className="font-semibold">{s.title}</span></span>
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/60">{KIND[s.id]}</span>
                  </div>
                  <div className="mt-1 text-sm italic text-white/80">{s.tagline}</div>
                </button>
              ))}
            </div>
            <aside className="rounded-xl border border-white/15 bg-black/55 p-4">
              <div className="text-xs uppercase tracking-wider text-white/50">Scenario {sc.id} · {KIND[sc.id]}</div>
              <div className="mt-1 text-lg font-semibold">{sc.title}</div>
              <p className="mt-2 text-sm text-white/80">{sc.description}</p>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-white/70">
                <dt>Suspects</dt><dd>{sc.suspects.length || '—'}</dd>
                <dt>Traffic</dt><dd>{sc.traffic || 'none'}</dd>
                <dt>Troopers</dt><dd>{sc.police || 'just you'}</dd>
                <dt>Weather</dt><dd>{sc.weather.rain > 0 ? 'Rain' : 'Sunny'}</dd>
              </dl>
              <label className="mt-4 flex items-center gap-2 text-sm">Seed
                <input type="number" value={seed} min={1} onChange={(e) => setSeed(Math.max(1, Number(e.target.value) | 0))} className="w-24 rounded bg-white/10 px-2 py-1" />
                <button className="rounded bg-white/10 px-2 py-1 hover:bg-white/20" title="Random seed" onClick={() => setSeed(1 + Math.floor(Math.random() * 99999))}>🎲</button>
              </label>
              <button onClick={() => onStart(sel, seed)} className="mt-4 w-full rounded-lg bg-gsp-orange py-2.5 font-display text-lg text-black shadow-lg hover:brightness-110">ROLL OUT ▸</button>
              <div className="mt-2 text-center text-[11px] text-white/45">Double-click a scenario to start it</div>
            </aside>
          </div>
        )}

        {tab === 'settings' && <Panel><SettingsPanel sim={sim} /></Panel>}
        {tab === 'controls' && <Panel><ControlsSheet /></Panel>}
        {tab === 'about' && (
          <Panel>
            <div className="grid gap-4 text-sm text-white/80 sm:grid-cols-2">
              <div>
                <h3 className="mb-1 font-semibold text-white">How it works</h3>
                Every car (yours, the suspects’, the troopers’, the traffic’s) runs on the same OpenRoad Dynamics vehicle core: Pacejka tyres, unsprung wheels, a real drivetrain and automatic gearbox. Rapier hosts the chassis and every contact, so spins, PITs and rollovers come out of the physics. Car windows break with Glass Dynamics; the road signs are Street Dynamics breakaway posts.
              </div>
              <div>
                <h3 className="mb-1 font-semibold text-white">Fine print</h3>
                A fictional agency on a fictional interstate. Entertainment only, not police training. No pedestrians, no injuries: just paperwork. The arcade aids are labelled and optional; the Physics lab (Tab) shows and tunes everything.
              </div>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 rounded-xl border border-white/15 bg-black/60 p-4 sm:p-6">{children}</div>;
}
