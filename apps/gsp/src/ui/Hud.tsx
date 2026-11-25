'use client';
import { useGame } from '../state/store';
import type { Simulation } from '../sim/Simulation';
import { MPH } from '../sim/math';

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const CAM: Record<string, string> = { chase: 'Chase', close: 'Close chase', hood: 'Hood', driver: 'Driver', free: 'Free orbit (drag)', cinematic: 'Trackside' };
const PRESETS = ['FUN', 'SPORT', 'SIM', 'DRIFT'];

export function HudView({ sim }: { sim: Simulation }) {
  const hud = useGame((s) => s.hud);
  const scenario = useGame((s) => s.scenario);
  const units = useGame((s) => s.settings.units);
  const hints = useGame((s) => s.settings.hints);
  if (!hud) return null;
  const kmh = units === 'kmh';
  const spd = hud.speed * (kmh ? 3.6 : MPH);
  const sp = (ms: number) => Math.round(ms * (kmh ? 3.6 : MPH));
  const rpmFrac = Math.min(1, hud.rpm / hud.redline);
  const c = hud.counters;
  return (
    <div className="pointer-events-none absolute inset-0 text-white">
      {/* pursuit status */}
      <div className="absolute left-3 top-3 w-72 rounded-lg bg-black/45 p-3 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div className="font-display text-sm tracking-wide text-gsp-orange">GSP-71 · {scenarioName(scenario)}</div>
          <div className="text-[10px] text-white/60">{PRESETS[hud.preset]}</div>
        </div>
        {hud.pursuit.active ? (
          <>
            <div className="mt-1 flex items-baseline justify-between">
              <span className={`text-xs font-semibold ${hud.pursuit.concluded ? 'text-emerald-300' : 'text-red-300'}`}>{hud.pursuit.concluded ? 'PURSUIT CONCLUDED' : 'PURSUIT IN PROGRESS'}</span>
              <span className="tabular text-lg font-bold">{clock(hud.pursuit.time)}</span>
            </div>
            {hud.pursuit.suspects.map((s, i) => (
              <div key={i} className="mt-1 flex justify-between text-xs text-white/85">
                <span>{s.name} <span className="text-white/50">({s.mode})</span></span>
                <span className="tabular">{Math.round(s.dist)} m · {sp(s.speed)} {kmh ? 'km/h' : 'mph'}</span>
              </div>
            ))}
          </>
        ) : (
          <div className="mt-1 text-xs text-white/70">Free drive. Nobody to chase but your own dreams.</div>
        )}
      </div>
      {/* the bill */}
      <div className="absolute right-3 top-3 w-64 rounded-lg bg-black/45 p-3 text-xs backdrop-blur-sm">
        <div className="mb-1 font-display text-[11px] tracking-wider text-gsp-silver">THE DAMAGE REPORT</div>
        <Row k="Property damage" v={money(c.propertyDamage)} hot={c.propertyDamage > 100000} />
        <Row k="Patrol vehicle repairs" v={money(c.patrolRepair)} hot={c.patrolRepair > 15000} />
        <Row k="Traffic cones lost" v={String(c.conesLost)} />
        <Row k="Pursuit duration" v={clock(c.pursuitTime)} />
        <Row k="Suspects apprehended" v={String(c.apprehensions)} />
        <Row k="Administrative burden" v={`${c.forms} forms · ${c.pages} pp`} />
        {c.pits > 0 && <Row k="PIT maneuvers" v={String(c.pits)} />}
        {c.signsDown > 0 && <Row k="Signs relocated" v={String(c.signsDown)} />}
      </div>
      {/* status chips */}
      <div className="absolute left-1/2 top-3 flex -translate-x-1/2 gap-2">
        {hud.replay && <Chip c="bg-amber-500/80">▶ REPLAY · F to exit · C changes nothing, it's a replay</Chip>}
        {hud.slowmo && !hud.replay && <Chip c="bg-sky-500/70">SLOW MOTION</Chip>}
        {hud.paused && <Chip c="bg-white/30">PAUSED · N steps</Chip>}
        {hud.upright < 0.3 && !hud.replay && <Chip c="bg-red-600/70">On your roof. Press Y to call a tow (or R to restart)</Chip>}
      </div>
      {/* speedo */}
      <div className="absolute bottom-4 right-24 w-60 rounded-xl bg-black/50 p-3 backdrop-blur-sm">
        <div className="flex items-end justify-between">
          <div>
            <div className="tabular font-display text-5xl leading-none">{Math.round(spd)}</div>
            <div className="text-[10px] uppercase tracking-widest text-white/60">{kmh ? 'km/h' : 'mph'}</div>
          </div>
          <div className="text-right">
            <div className="font-display text-3xl leading-none text-gsp-orange">{hud.gear === -1 ? 'R' : hud.gear === 0 ? 'N' : hud.gear}</div>
            <div className="text-[10px] text-white/60">{Math.round(hud.rpm)} rpm</div>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-white/10">
          <div className="h-full" style={{ width: `${rpmFrac * 100}%`, background: rpmFrac > 0.9 ? '#ef4444' : rpmFrac > 0.75 ? '#f59e0b' : '#f08a1c' }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] text-white/70">
          <span className={hud.emergency ? 'text-sky-300' : ''}>LIGHTS {hud.emergency ? 'ON' : 'OFF'}</span>
          <span className={hud.siren ? 'text-red-300' : ''}>SIREN {hud.siren ? 'ON' : 'OFF'}</span>
          <span>{hud.surface}</span>
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-white/10" title="Vehicle condition">
          <div className="h-full bg-emerald-400" style={{ width: `${hud.health * 100}%` }} />
        </div>
      </div>
      {/* hints: the essentials only; F1 has the full sheet */}
      {hints && (
        <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-1.5 text-[11px] text-white/80">
          {[['F1', 'Controls'], ['Esc', 'Pause & settings'], ['Tab', 'Lab'], ['C', CAM[hud.camera]], ['F', 'Replay']].map(([k, v]) => (
            <span key={k} className="rounded-md bg-black/45 px-2 py-1"><kbd className="mr-1 rounded bg-white/15 px-1 font-mono text-[10px]">{k}</kbd>{v}</span>
          ))}
          {hud.pad && <span className="rounded-md bg-emerald-600/50 px-2 py-1">🎮 Gamepad</span>}
          <span className="rounded-md bg-black/30 px-2 py-1 text-white/45">{Math.round(hud.fps)} fps · {sim.vehicles.length} cars</span>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, hot }: { k: string; v: string; hot?: boolean }) {
  return (
    <div className="flex justify-between py-[1px]">
      <span className="text-white/70">{k}</span>
      <span className={`tabular font-semibold ${hot ? 'text-red-300' : ''}`}>{v}</span>
    </div>
  );
}
function Chip({ c, children }: { c: string; children: React.ReactNode }) {
  return <div className={`rounded-full px-3 py-1 text-xs font-semibold text-white shadow ${c}`}>{children}</div>;
}
function scenarioName(id: string) {
  return { A: 'Free Drive', B: 'Highway Pursuit', C: 'Uncooperative Suspect', D: 'Heavy Vehicle', E: 'Rainy Day', F: 'Absolute Mayhem' }[id] ?? id;
}
