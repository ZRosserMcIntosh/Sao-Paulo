'use client';
import type { Simulation } from '../sim/Simulation';
import { useGame } from '../state/store';

export function PauseMenu({ sim, onResume, onMenu }: { sim: Simulation; onResume: () => void; onMenu: () => void }) {
  const volume = useGame((s) => s.volume);
  const muted = useGame((s) => s.muted);
  const set = useGame((s) => s.set);
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/50 backdrop-blur-[2px]">
      <div className="w-80 rounded-2xl border border-white/15 bg-slate-950/90 p-5 text-center shadow-2xl">
        <div className="font-display text-2xl text-gsp-orange">PAUSED</div>
        <div className="mt-1 text-xs italic text-white/60">The suspect is also paused. Out of courtesy.</div>
        <div className="mt-4 flex flex-col gap-2">
          <button className="rounded-lg bg-gsp-orange py-2 font-semibold text-black" onClick={onResume}>Resume</button>
          <button className="rounded-lg bg-white/10 py-2 hover:bg-white/20" onClick={() => { sim.restart(); onResume(); }}>Restart (same seed)</button>
          <button className="rounded-lg bg-white/10 py-2 hover:bg-white/20" onClick={() => { sim.stepRequests++; }}>Single step (N)</button>
          <button className="rounded-lg bg-white/10 py-2 hover:bg-white/20" onClick={onMenu}>Scenario menu</button>
        </div>
        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-white/70">
          Volume <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => set({ volume: Number(e.target.value) })} />
          <label className="flex items-center gap-1"><input type="checkbox" checked={muted} onChange={(e) => set({ muted: e.target.checked })} /> mute</label>
        </div>
      </div>
    </div>
  );
}
