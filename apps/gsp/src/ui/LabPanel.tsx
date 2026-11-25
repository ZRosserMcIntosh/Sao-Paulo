'use client';
// The physics laboratory: live telemetry, handling sliders, the full vehicle definition, the
// surfaces, simulation controls (pause, single step, slow motion) and JSON export / import.
import { useEffect, useRef, useState } from 'react';
import type { Simulation } from '../sim/Simulation';
import { STATE } from '../sim/engines/gsp';
import { exportConfig, importConfig, vehicleParams, type LabConfig } from '../sim/config';
import { PARAM_FIELDS, type VehicleParams } from '../sim/vehicle/params';
import { CATALOG, type VehicleKind } from '../sim/vehicle/catalog';
import { SURFACE_NAMES } from '../sim/world/terrain';
import { MPH } from '../sim/math';

type Tab = 'telemetry' | 'handling' | 'vehicle' | 'surfaces' | 'config';

export function LabPanel({ sim, onClose }: { sim: Simulation; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('telemetry');
  const [cfg, setCfg] = useState<LabConfig>(() => structuredClone(sim.cfg));
  const apply = (c: LabConfig) => { setCfg(c); sim.applyConfig(structuredClone(c), false); };
  return (
    <div className="pointer-events-auto absolute right-3 top-44 bottom-16 flex w-[400px] max-w-[94vw] flex-col rounded-xl border border-white/15 bg-slate-950/85 text-xs shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="font-display text-sm text-gsp-orange">PHYSICS LAB</div>
        <SimControls sim={sim} />
        <button className="rounded px-2 text-white/60 hover:bg-white/10" onClick={onClose}>✕</button>
      </div>
      <div className="flex gap-1 border-b border-white/10 px-2 py-1">
        {(['telemetry', 'handling', 'vehicle', 'surfaces', 'config'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded px-2 py-1 capitalize ${tab === t ? 'bg-gsp-blue text-white' : 'text-white/60 hover:bg-white/10'}`}>{t}</button>
        ))}
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto p-3">
        {tab === 'telemetry' && <Telemetry sim={sim} />}
        {tab === 'handling' && <Handling cfg={cfg} apply={apply} />}
        {tab === 'vehicle' && <VehicleEditor sim={sim} cfg={cfg} apply={apply} />}
        {tab === 'surfaces' && <Surfaces cfg={cfg} apply={apply} />}
        {tab === 'config' && <ConfigIO cfg={cfg} apply={apply} />}
      </div>
    </div>
  );
}

function SimControls({ sim }: { sim: Simulation }) {
  const [, force] = useState(0);
  useEffect(() => { const iv = setInterval(() => force((x) => x + 1), 300); return () => clearInterval(iv); }, []);
  const b = 'rounded px-2 py-0.5 hover:bg-white/15';
  return (
    <div className="flex items-center gap-1 text-[11px]">
      <button className={`${b} ${sim.paused ? 'bg-amber-500/40' : 'bg-white/10'}`} onClick={() => (sim.paused = !sim.paused)}>{sim.paused ? '▶ Run' : '❚❚ Pause'}</button>
      <button className={`${b} bg-white/10`} onClick={() => { sim.paused = true; sim.stepRequests++; }} title="One 1/120 s step">Step</button>
      <button className={`${b} ${sim.slowmo ? 'bg-sky-500/40' : 'bg-white/10'}`} onClick={() => (sim.slowmo = !sim.slowmo)}>Slow</button>
      <select className="rounded bg-white/10 px-1 py-0.5" value={sim.slowmoScale} onChange={(e) => (sim.slowmoScale = Number(e.target.value))}>
        {[0.05, 0.1, 0.25, 0.5].map((v) => <option key={v} value={v} className="bg-slate-900">{v}×</option>)}
      </select>
    </div>
  );
}

function Telemetry({ sim }: { sim: Simulation }) {
  const [, tick] = useState(0);
  useEffect(() => { const iv = setInterval(() => tick((x) => x + 1), 100); return () => clearInterval(iv); }, []);
  const p = sim.player;
  if (!p) return null;
  const H = sim.gsp.heap(), o = sim.gsp.stateOffset(p.handle);
  const T = sim.telemetry;
  const g = 9.80665;
  const ang = { yaw: p.yawRate * 57.3, roll: 0, pitch: 0 };
  const lw = p.toLocal({ x: p.p.x + p.w.x, y: p.p.y + p.w.y, z: p.p.z + p.w.z });
  ang.roll = lw.x * 57.3; ang.pitch = lw.z * 57.3;
  const names = ['FL', 'FR', 'RL', 'RR'];
  return (
    <div className="space-y-3">
      <Section title="Motion">
        <KV k="Speed" v={`${(Math.abs(p.speed) * MPH).toFixed(1)} mph · ${(Math.abs(p.speed) * 3.6).toFixed(1)} km/h`} />
        <KV k="Engine" v={`${Math.round(p.rpm)} rpm · gear ${p.gear === -1 ? 'R' : p.gear} · ${Math.round(H[o + STATE.engineTorque])} N·m`} />
        <KV k="Accel (long / lat / vert)" v={`${(p.accel.x / g).toFixed(2)} / ${(p.accel.z / g).toFixed(2)} / ${(p.accel.y / g).toFixed(2)} g`} />
        <KV k="Angular vel. (yaw / roll / pitch)" v={`${ang.yaw.toFixed(1)} / ${ang.roll.toFixed(1)} / ${ang.pitch.toFixed(1)} °/s`} />
        <KV k="Sideslip" v={`${(p.sideslip * 57.3).toFixed(1)}°`} />
        <KV k="Inputs (steer / thr / brk / hb)" v={`${p.controls.steer.toFixed(2)} / ${p.controls.throttle.toFixed(2)} / ${p.controls.brake.toFixed(2)} / ${p.controls.handbrake.toFixed(0)}`} />
        <KV k="Assists (TCS cut / ESC / drift)" v={`${H[o + STATE.tcsCut].toFixed(2)} / ${H[o + STATE.escError].toFixed(2)} / ${H[o + STATE.driftActive] > 0 ? 'on' : 'off'}`} />
        <KV k="Upright · body on ground" v={`${p.upright.toFixed(2)} · ${H[o + STATE.hullContacts]} pts, ${Math.round(H[o + STATE.hullForce])} N`} />
      </Section>
      <Section title="Wheels">
        <table className="w-full text-[10.5px] tabular">
          <thead className="text-white/50"><tr><th className="text-left">#</th><th>slip κ</th><th>slip α°</th><th>load N</th><th>susp %</th><th>grip</th><th className="text-right">surface</th></tr></thead>
          <tbody>
            {p.wheels.map((w, i) => (
              <tr key={i} className={w.contact ? '' : 'text-white/40'}>
                <td>{names[i]}</td>
                <td className="text-center">{w.slipRatio.toFixed(2)}</td>
                <td className="text-center">{(w.slipAngle * 57.3).toFixed(1)}</td>
                <td className="text-center">{Math.round(w.load)}</td>
                <td className="text-center"><Bar v={w.compression} /></td>
                <td className="text-center"><Bar v={Math.min(1, w.slip)} hot /></td>
                <td className="text-right">{SURFACE_NAMES[w.surface] ?? w.surface}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Contacts (Rapier impulses)">
        {T.contacts.length === 0 && <div className="text-white/40">No hits yet. The guardrails are nervous.</div>}
        {T.contacts.slice(0, 8).map((c, i) => (
          <div key={i} className="flex justify-between tabular"><span className="truncate text-white/70">{c.t.toFixed(1)} s · {c.a} ↔ {c.b}</span><span>{Math.round(c.impulse)} N·s · Δv {c.dv.toFixed(1)} m/s</span></div>
        ))}
      </Section>
      <Section title="Damage">
        <KV k="Zones (F / R / L / R / roof, Δv sum)" v={`${p.damage.zones.front.toFixed(1)} / ${p.damage.zones.rear.toFixed(1)} / ${p.damage.zones.left.toFixed(1)} / ${p.damage.zones.right.toFixed(1)} / ${p.damage.zones.roof.toFixed(1)}`} />
        <KV k="Condition · power · steering pull" v={`${Math.round(p.damage.health * 100)} % · ${Math.round(p.damage.power * 100)} % · ${p.damage.pull.toFixed(3)}`} />
        <KV k="Detached" v={[...p.damage.detached].join(', ') || 'nothing (yet)'} />
        <KV k="Repair estimate" v={`$${p.damage.repairCost.toLocaleString('en-US')}`} />
      </Section>
      <Section title="Performance">
        <KV k="Physics step (1/120 s)" v={`${T.stepMs.toFixed(2)} ms (core ${T.coreMs.toFixed(2)}, Rapier ${T.rapierMs.toFixed(2)}, AI ${T.aiMs.toFixed(2)})`} />
        <KV k="Render" v={`${T.fps.toFixed(0)} fps`} />
        <KV k="Host sync error" v={`${(H[o + STATE.syncPos] * 1000).toFixed(2)} mm · ${(H[o + STATE.syncAng] * 57.3).toFixed(3)}°`} />
        <KV k="Vehicles · props · steps" v={`${sim.vehicles.length} · ${sim.props.list.length} · ${T.steps}`} />
      </Section>
    </div>
  );
}

function Handling({ cfg, apply }: { cfg: LabConfig; apply: (c: LabConfig) => void }) {
  const set = (p: Partial<LabConfig>) => apply({ ...cfg, ...p });
  const arc = (p: Partial<LabConfig['arcade']>) => apply({ ...cfg, arcade: { ...cfg.arcade, ...p } });
  return (
    <div className="space-y-3">
      <Section title="Driving preset (the core's assists; same physics)">
        <div className="grid grid-cols-4 gap-1">
          {['FUN', 'SPORT', 'SIM', 'DRIFT'].map((n, i) => (
            <button key={n} onClick={() => set({ preset: i })} className={`rounded py-1 ${cfg.preset === i ? 'bg-gsp-orange text-black' : 'bg-white/10 hover:bg-white/20'}`}>{n}</button>
          ))}
        </div>
        <Slider label="Drift assist" v={cfg.driftAssist} min={0} max={1} step={0.05} on={(v) => set({ driftAssist: v })} />
      </Section>
      <Section title="Physics (all vehicles)">
        <Slider label="Tyre grip ×" v={cfg.gripScale} min={0.4} max={1.8} step={0.01} on={(v) => set({ gripScale: v })} />
        <Slider label="Suspension stiffness ×" v={cfg.suspensionScale} min={0.4} max={2.5} step={0.01} on={(v) => set({ suspensionScale: v })} />
        <Slider label="Steering lock ×" v={cfg.steeringLockScale} min={0.6} max={1.5} step={0.01} on={(v) => set({ steeringLockScale: v })} />
        <Slider label="Collision restitution" v={cfg.restitution} min={0} max={0.8} step={0.01} on={(v) => set({ restitution: v })} />
        <Slider label="Surface friction ×" v={cfg.surfaceFriction} min={0.3} max={1.6} step={0.01} on={(v) => set({ surfaceFriction: v })} />
        <Slider label="Core substeps per 1/120 s" v={cfg.substeps} min={1} max={8} step={1} on={(v) => set({ substeps: v })} />
      </Section>
      <Section title="Input">
        <Slider label="Steering sensitivity" v={cfg.steeringSensitivity} min={0.3} max={2.5} step={0.05} on={(v) => set({ steeringSensitivity: v })} />
      </Section>
      <Section title="Arcade assistance (separate from the rigid-body simulation)">
        <label className="mb-1 flex items-center gap-2"><input type="checkbox" checked={cfg.arcade.enabled} onChange={(e) => arc({ enabled: e.target.checked })} /> Enabled</label>
        <Slider label="PIT assist (extra yaw on rear-quarter hits)" v={cfg.arcade.pitAssist} min={0} max={1} step={0.05} on={(v) => arc({ pitAssist: v })} />
        <Slider label="Stability (player yaw damping)" v={cfg.arcade.stability} min={0} max={1} step={0.05} on={(v) => arc({ stability: v })} />
        <Slider label="Arcade downforce (player)" v={cfg.arcade.downforce} min={0} max={1} step={0.05} on={(v) => arc({ downforce: v })} />
        <Slider label="AI trooper PIT eagerness" v={cfg.arcade.aiPolice} min={0} max={1} step={0.05} on={(v) => arc({ aiPolice: v })} />
        <div className="mt-1 text-[10.5px] text-white/50">With everything here at 0 the cars are the physics core alone: tyres, suspension, drivetrain, rigid-body contacts.</div>
      </Section>
    </div>
  );
}

function VehicleEditor({ sim, cfg, apply }: { sim: Simulation; cfg: LabConfig; apply: (c: LabConfig) => void }) {
  const [kind, setKind] = useState<VehicleKind>(sim.player?.cls.kind ?? 'interceptor');
  const p = vehicleParams(cfg, kind);
  const setP = (patch: Partial<VehicleParams>) => apply({ ...cfg, vehicles: { ...cfg.vehicles, [kind]: { ...p, ...patch } } });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as VehicleKind)} className="flex-1 rounded bg-white/10 px-2 py-1">
          {Object.values(CATALOG).map((c) => <option key={c.kind} value={c.kind} className="bg-slate-900">{c.look.name} ({c.kind})</option>)}
        </select>
        <button className="rounded bg-white/10 px-2 py-1 hover:bg-white/20" onClick={() => { const v = { ...cfg.vehicles }; delete v[kind]; apply({ ...cfg, vehicles: v }); }}>Stock</button>
      </div>
      <div className="text-[10.5px] text-white/50">The definition the core builds this car from. Changes rebuild every car of this kind in place, keeping its motion.</div>
      <div className="grid grid-cols-2 gap-x-3">
        {PARAM_FIELDS.map(([key, label, min, max, step, unit]) => (
          <Slider key={key} label={`${label}${unit ? ` (${unit})` : ''}`} v={p[key] as number} min={min} max={max} step={step} on={(v) => setP({ [key]: v } as Partial<VehicleParams>)} compact />
        ))}
      </div>
      <Section title="Drivetrain">
        <div className="flex flex-wrap gap-2">
          <select value={p.drive} onChange={(e) => setP({ drive: Number(e.target.value) as 0 | 1 | 2 })} className="rounded bg-white/10 px-1 py-0.5">{['RWD', 'FWD', 'AWD'].map((n, i) => <option key={n} value={i} className="bg-slate-900">{n}</option>)}</select>
          <select value={p.differential} onChange={(e) => setP({ differential: Number(e.target.value) as 0 | 1 | 2 })} className="rounded bg-white/10 px-1 py-0.5">{['Open diff', 'Locked diff', 'Clutch LSD'].map((n, i) => <option key={n} value={i} className="bg-slate-900">{n}</option>)}</select>
        </div>
        <div className="mt-1 text-white/60">Gears: {p.gears.join(' · ')} · final {p.finalDrive.toFixed(2)}</div>
        <div className="text-white/60">Torque: {p.torqueCurve.map(([r, t]) => `${r}:${t}`).join(' ')}</div>
      </Section>
    </div>
  );
}

function Surfaces({ cfg, apply }: { cfg: LabConfig; apply: (c: LabConfig) => void }) {
  return (
    <div className="space-y-2">
      <div className="text-[10.5px] text-white/50">Grip relative to dry asphalt, the share of grip lost when wet, and looseness (gravel and soil). The global surface friction slider multiplies these.</div>
      {Object.entries(cfg.surfaces).map(([k, s]) => (
        <div key={k} className="rounded bg-white/5 p-2">
          <div className="mb-1 font-semibold">{SURFACE_NAMES[Number(k)]}</div>
          <div className="grid grid-cols-3 gap-2">
            <Slider label="Grip" v={s.friction} min={0.1} max={1.5} step={0.01} on={(v) => apply({ ...cfg, surfaces: { ...cfg.surfaces, [k]: { ...s, friction: v } } })} compact />
            <Slider label="Wet loss" v={s.wetLoss} min={0} max={0.9} step={0.01} on={(v) => apply({ ...cfg, surfaces: { ...cfg.surfaces, [k]: { ...s, wetLoss: v } } })} compact />
            <Slider label="Loose" v={s.looseness} min={0} max={1} step={0.01} on={(v) => apply({ ...cfg, surfaces: { ...cfg.surfaces, [k]: { ...s, looseness: v } } })} compact />
          </div>
        </div>
      ))}
    </div>
  );
}

function ConfigIO({ cfg, apply }: { cfg: LabConfig; apply: (c: LabConfig) => void }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const doImport = (t: string) => { try { apply(importConfig(t)); setMsg('Imported. The car has been rebuilt.'); } catch (e) { setMsg('Not imported: ' + (e as Error).message); } };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className="rounded bg-gsp-orange px-3 py-1 font-semibold text-black" onClick={() => {
          const blob = new Blob([exportConfig(cfg)], { type: 'application/json' });
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'gsp-lab-config.json'; a.click(); URL.revokeObjectURL(a.href);
        }}>Export JSON</button>
        <button className="rounded bg-white/10 px-3 py-1 hover:bg-white/20" onClick={() => { navigator.clipboard?.writeText(exportConfig(cfg)); setMsg('Copied to the clipboard.'); }}>Copy</button>
        <button className="rounded bg-white/10 px-3 py-1 hover:bg-white/20" onClick={() => file.current?.click()}>Import file…</button>
        <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) doImport(await f.text()); }} />
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="…or paste a configuration here" className="h-40 w-full rounded bg-black/40 p-2 font-mono text-[10.5px]" />
      <button className="rounded bg-white/10 px-3 py-1 hover:bg-white/20" onClick={() => doImport(text)}>Import pasted JSON</button>
      {msg && <div className="text-white/70">{msg}</div>}
      <pre className="max-h-64 overflow-auto rounded bg-black/40 p-2 text-[10px] text-white/60">{exportConfig(cfg).slice(0, 1400)}…</pre>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><div className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-gsp-silver/80">{title}</div>{children}</div>;
}
function KV({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-2 py-[1px]"><span className="text-white/60">{k}</span><span className="tabular text-right">{v}</span></div>;
}
function Bar({ v, hot }: { v: number; hot?: boolean }) {
  return <div className="mx-auto h-1.5 w-12 overflow-hidden rounded bg-white/10"><div className={`h-full ${hot && v > 0.9 ? 'bg-red-400' : 'bg-sky-400'}`} style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} /></div>;
}
function Slider({ label, v, min, max, step, on, compact }: { label: string; v: number; min: number; max: number; step: number; on: (v: number) => void; compact?: boolean }) {
  return (
    <label className={`block ${compact ? 'py-0.5' : 'py-1'}`}>
      <div className="flex justify-between"><span className="truncate text-white/70">{label}</span><span className="tabular">{Number.isInteger(step) ? v : v.toFixed(step < 0.01 ? 3 : 2)}</span></div>
      <input type="range" className="w-full" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} />
    </label>
  );
}
