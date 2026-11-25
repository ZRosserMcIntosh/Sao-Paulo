'use client';
// Every control, grouped by what it is for. Shown in the main menu, the pause menu and on F1 / ?.
const GROUPS: { title: string; keys: [string, string][] }[] = [
  { title: 'Driving', keys: [['W / ↑', 'Accelerate'], ['S / ↓', 'Brake (hold at a stop to reverse)'], ['A / D  ← →', 'Steer'], ['Space', 'Handbrake']] },
  { title: 'Patrol car', keys: [['L', 'Emergency lights'], ['H', 'Siren'], ['G', 'Horn'], ['Y', 'Tow (back on the road)']] },
  { title: 'Camera and replay', keys: [['C', 'Next camera'], ['Drag / wheel', 'Orbit and zoom (free camera)'], ['F', 'Replay the last crash'], ['U', 'Photo mode (hide the interface)']] },
  { title: 'Simulation', keys: [['Esc / P', 'Pause'], ['N', 'One physics step (paused)'], ['T', 'Slow motion'], ['R', 'Restart (same seed)'], ['Tab', 'Physics lab'], ['F1 / ?', 'This sheet']] },
];
const PAD: [string, string][] = [['Left stick', 'Steer (analog)'], ['RT / LT', 'Throttle / brake'], ['X or RB', 'Handbrake'], ['Y', 'Camera'], ['B', 'Lights'], ['LB', 'Siren'], ['D-pad ↑', 'Replay'], ['D-pad ↓', 'Slow motion'], ['Start', 'Pause'], ['Back', 'Restart']];

export function ControlsSheet({ compact }: { compact?: boolean }) {
  return (
    <div className={`grid gap-4 ${compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
      {GROUPS.map((g) => <Group key={g.title} title={g.title} keys={g.keys} />)}
      <Group title="Gamepad" keys={PAD} />
    </div>
  );
}

function Group({ title, keys }: { title: string; keys: [string, string][] }) {
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gsp-silver/80">{title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {keys.map(([k, v]) => (
            <tr key={k} className="border-b border-white/5">
              <td className="whitespace-nowrap py-1 pr-3"><kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-white">{k}</kbd></td>
              <td className="py-1 text-white/75">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Full-screen sheet over the game (F1 / ?)
export function ControlsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="max-h-[90vh] w-[min(920px,96vw)] overflow-y-auto rounded-2xl border border-white/15 bg-slate-950/95 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="font-display text-xl text-gsp-orange">CONTROLS</div>
          <button className="rounded px-2 text-white/60 hover:bg-white/10" onClick={onClose}>✕ <span className="text-xs">(F1)</span></button>
        </div>
        <ControlsSheet />
      </div>
    </div>
  );
}
