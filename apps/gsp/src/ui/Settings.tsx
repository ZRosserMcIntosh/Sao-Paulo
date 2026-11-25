'use client';
// Settings, grouped: Graphics, Audio, Driving, Camera. The same panel in the main menu and the
// pause menu. Player settings persist (localStorage); driving settings go to the lab config.
import { useState } from 'react';
import type { Simulation, CameraMode } from '../sim/Simulation';
import { useGame, type QualityName } from '../state/store';

type Group = 'graphics' | 'audio' | 'driving' | 'camera';
const GROUPS: { id: Group; label: string; icon: string }[] = [
  { id: 'graphics', label: 'Graphics', icon: '🖥️' },
  { id: 'audio', label: 'Audio', icon: '🔊' },
  { id: 'driving', label: 'Driving', icon: '🚓' },
  { id: 'camera', label: 'Camera', icon: '🎥' },
];
const QUALITY: { id: QualityName; label: string; sub: string }[] = [
  { id: 'low', label: 'Low', sub: 'Coarse terrain, few trees, no post-processing. Laptops.' },
  { id: 'medium', label: 'Medium', sub: 'More trees, 2K shadows, no bloom.' },
  { id: 'high', label: 'High', sub: 'Full forest, bloom on the light bar, SMAA.' },
  { id: 'ultra', label: 'Ultra', sub: 'Finest terrain, 4K shadows, full pixel ratio.' },
];
const CAMERAS: { id: CameraMode; label: string }[] = [
  { id: 'chase', label: 'Chase' }, { id: 'close', label: 'Close chase' }, { id: 'hood', label: 'Hood' },
  { id: 'driver', label: 'Driver' }, { id: 'free', label: 'Free orbit' }, { id: 'cinematic', label: 'Trackside' },
];
const PRESETS = [
  { name: 'Fun', sub: 'Full ABS, traction and stability control, steering help' },
  { name: 'Sport', sub: 'ABS, sport traction control, a little countersteer help' },
  { name: 'Simulation', sub: 'No aids. The car is all yours' },
  { name: 'Drift', sub: 'Drift assist holds the angle you steer for' },
];

export function SettingsPanel({ sim }: { sim: Simulation }) {
  const [group, setGroup] = useState<Group>('graphics');
  return (
    <div className="flex min-h-[340px] flex-col gap-3 sm:flex-row">
      <nav className="flex shrink-0 gap-1 sm:w-36 sm:flex-col" aria-label="Settings">
        {GROUPS.map((g) => (
          <button key={g.id} onClick={() => setGroup(g.id)} aria-pressed={group === g.id}
            className={`rounded-lg px-3 py-2 text-left text-sm ${group === g.id ? 'bg-gsp-blue text-white' : 'text-white/70 hover:bg-white/10'}`}>
            <span className="mr-2">{g.icon}</span>{g.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 text-sm">
        {group === 'graphics' && <Graphics />}
        {group === 'audio' && <Audio />}
        {group === 'driving' && <Driving sim={sim} />}
        {group === 'camera' && <Camera sim={sim} />}
      </div>
    </div>
  );
}

function Graphics() {
  const s = useGame((x) => x.settings), set = useGame((x) => x.setSettings);
  return (
    <Section title="Quality preset" note="Applies immediately. Terrain detail, trees, shadow resolution, pixel ratio, rain density and post-processing.">
      <div className="grid gap-2 sm:grid-cols-2">
        {QUALITY.map((q) => (
          <button key={q.id} onClick={() => set({ quality: q.id })} aria-pressed={s.quality === q.id}
            className={`rounded-lg border p-2 text-left ${s.quality === q.id ? 'border-gsp-orange bg-gsp-blue/60' : 'border-white/15 hover:border-white/40'}`}>
            <div className="font-semibold">{q.label}</div>
            <div className="text-xs text-white/60">{q.sub}</div>
          </button>
        ))}
      </div>
      <Toggle label="Show control hints on screen" on={s.hints} set={(v) => set({ hints: v })} />
      <div className="mt-2 text-xs text-white/50">Photo mode hides the interface: press U while driving.</div>
    </Section>
  );
}

function Audio() {
  const s = useGame((x) => x.settings), set = useGame((x) => x.setSettings);
  const mix = (k: keyof typeof s.mix, label: string, sub: string) => (
    <Slider label={label} sub={sub} v={s.mix[k]} on={(v) => set({ mix: { ...s.mix, [k]: v } })} />
  );
  return (
    <>
      <Section title="Master">
        <Slider label="Volume" v={s.volume} on={(v) => set({ volume: v })} />
        <Toggle label="Mute everything" on={s.muted} set={(v) => set({ muted: v })} />
      </Section>
      <Section title="Mix">
        {mix('engine', 'Engine', 'Your V8 and the nearest other car')}
        {mix('tyres', 'Tyres and road', 'Squeal, sliding hiss, gravel, wind')}
        {mix('impacts', 'Impacts', 'Crashes, glass, signs, cones')}
        {mix('sirens', 'Sirens and horn', 'Yours and the troopers’')}
        {mix('radio', 'Dispatch radio', 'Squelch and the dispatcher')}
      </Section>
      <Section title="Dispatch">
        <Toggle label="Read dispatch calls aloud (browser speech)" on={s.voice} set={(v) => set({ voice: v })} />
      </Section>
    </>
  );
}

function Driving({ sim }: { sim: Simulation }) {
  const s = useGame((x) => x.settings), set = useGame((x) => x.setSettings);
  const [cfg, setCfg] = useState(() => sim.cfg);
  const apply = (c: typeof cfg) => { setCfg(c); sim.applyConfig(structuredClone(c), false); };
  return (
    <>
      <Section title="Assists" note="Same physics in every preset: only the electronic aids change.">
        <div className="grid gap-2 sm:grid-cols-2">
          {PRESETS.map((p, i) => (
            <button key={p.name} onClick={() => apply({ ...cfg, preset: i })} aria-pressed={cfg.preset === i}
              className={`rounded-lg border p-2 text-left ${cfg.preset === i ? 'border-gsp-orange bg-gsp-blue/60' : 'border-white/15 hover:border-white/40'}`}>
              <div className="font-semibold">{p.name}</div>
              <div className="text-xs text-white/60">{p.sub}</div>
            </button>
          ))}
        </div>
        <Toggle label="Arcade assistance (PIT help, stability, grip bonus; tune it in the Lab)" on={cfg.arcade.enabled} set={(v) => apply({ ...cfg, arcade: { ...cfg.arcade, enabled: v } })} />
      </Section>
      <Section title="Steering">
        <Slider label="Steering sensitivity" sub="How fast the keyboard steers, and the gamepad curve" v={cfg.steeringSensitivity} min={0.3} max={2.5} step={0.05} on={(v) => apply({ ...cfg, steeringSensitivity: v })} />
      </Section>
      <Section title="Units">
        <div className="flex gap-2">
          {(['mph', 'kmh'] as const).map((u) => (
            <button key={u} onClick={() => set({ units: u })} aria-pressed={s.units === u} className={`rounded-lg px-3 py-1.5 ${s.units === u ? 'bg-gsp-orange text-black' : 'bg-white/10 hover:bg-white/20'}`}>{u === 'mph' ? 'mph' : 'km/h'}</button>
          ))}
        </div>
      </Section>
    </>
  );
}

function Camera({ sim }: { sim: Simulation }) {
  const s = useGame((x) => x.settings), set = useGame((x) => x.setSettings);
  return (
    <>
      <Section title="Default camera" note="C cycles through them while you drive.">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CAMERAS.map((c) => (
            <button key={c.id} onClick={() => { set({ camera: c.id }); sim.camera = c.id; }} aria-pressed={s.camera === c.id}
              className={`rounded-lg px-3 py-2 ${s.camera === c.id ? 'bg-gsp-orange text-black' : 'bg-white/10 hover:bg-white/20'}`}>{c.label}</button>
          ))}
        </div>
      </Section>
      <Section title="Effects">
        <Toggle label="Camera shake on impacts" on={s.shake} set={(v) => { set({ shake: v }); sim.cameraShake = v; }} />
      </Section>
    </>
  );
}

export function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gsp-silver/80">{title}</h3>
      {note && <p className="mb-2 text-xs text-white/50">{note}</p>}
      {children}
    </section>
  );
}
export function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="mt-2 flex cursor-pointer items-center gap-2 text-white/85">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="h-4 w-4 accent-[#f08a1c]" /> {label}
    </label>
  );
}
function Slider({ label, sub, v, on, min = 0, max = 1, step = 0.05 }: { label: string; sub?: string; v: number; on: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <label className="block py-1">
      <div className="flex justify-between"><span>{label}{sub && <span className="ml-2 text-xs text-white/45">{sub}</span>}</span><span className="tabular text-white/70">{max === 1 ? `${Math.round(v * 100)}%` : v.toFixed(2)}</span></div>
      <input type="range" className="w-full" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} />
    </label>
  );
}
