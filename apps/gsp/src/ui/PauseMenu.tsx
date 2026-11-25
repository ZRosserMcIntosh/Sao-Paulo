'use client';
// Pause: actions on the left, Settings / Controls on the right.
import { useState } from 'react';
import type { Simulation } from '../sim/Simulation';
import { SettingsPanel } from './Settings';
import { ControlsSheet } from './Controls';

export function PauseMenu({ sim, onResume, onMenu, onLab }: { sim: Simulation; onResume: () => void; onMenu: () => void; onLab: () => void }) {
  const [tab, setTab] = useState<'settings' | 'controls'>('settings');
  const btn = 'w-full rounded-lg px-3 py-2 text-left hover:bg-white/15';
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/55 p-3 backdrop-blur-[2px]">
      <div className="flex max-h-[92vh] w-[min(980px,96vw)] flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-950/95 shadow-2xl sm:flex-row">
        <aside className="flex shrink-0 flex-col gap-1 border-b border-white/10 p-4 sm:w-56 sm:border-b-0 sm:border-r">
          <div className="font-display text-2xl text-gsp-orange">PAUSED</div>
          <div className="mb-3 text-xs italic text-white/55">The suspect is also paused. Out of courtesy.</div>
          <button className={`${btn} bg-gsp-orange font-semibold text-black hover:brightness-110`} onClick={onResume}>▶ Resume <span className="float-right text-xs opacity-60">Esc</span></button>
          <div className="mt-3 text-[10px] font-bold uppercase tracking-wider text-white/40">This run</div>
          <button className={btn} onClick={() => { sim.restart(); onResume(); }}>↻ Restart, same seed <span className="float-right text-xs text-white/40">R</span></button>
          <button className={btn} onClick={() => { sim.paused = false; onResume(); sim.startReplay(); }}>⏪ Replay last crash <span className="float-right text-xs text-white/40">F</span></button>
          <button className={btn} onClick={() => sim.stepRequests++}>⏭ One physics step <span className="float-right text-xs text-white/40">N</span></button>
          <div className="mt-3 text-[10px] font-bold uppercase tracking-wider text-white/40">Tools</div>
          <button className={btn} onClick={onLab}>🔬 Physics lab <span className="float-right text-xs text-white/40">Tab</span></button>
          <div className="mt-auto pt-3">
            <button className={`${btn} text-white/70`} onClick={onMenu}>☰ Scenario menu</button>
          </div>
        </aside>
        <section className="flex min-h-0 flex-1 flex-col">
          <nav className="flex gap-1 border-b border-white/10 px-4 pt-3" role="tablist">
            {(['settings', 'controls'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`-mb-px rounded-t-lg px-4 py-2 text-sm capitalize ${tab === t ? 'border border-b-0 border-white/15 bg-slate-900 text-white' : 'text-white/60 hover:text-white'}`}>{t}</button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === 'settings' ? <SettingsPanel sim={sim} /> : <ControlsSheet compact />}
          </div>
        </section>
      </div>
    </div>
  );
}
