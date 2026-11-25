'use client';
import { useEffect, useState } from 'react';
import { useGame } from '../state/store';

const STYLE: Record<string, string> = {
  achievement: 'border-gsp-orange/70 bg-gradient-to-r from-[#3b2410]/90 to-black/70',
  radio: 'border-sky-400/50 bg-gradient-to-r from-[#0e2340]/90 to-black/70',
  dispatch: 'border-emerald-400/60 bg-gradient-to-r from-[#0f3324]/90 to-black/70',
  info: 'border-white/30 bg-black/70',
  bill: 'border-red-400/50 bg-black/70',
};
const ICON: Record<string, string> = { achievement: '🏆', radio: '📻', dispatch: '🚓', info: 'ℹ️', bill: '🧾' };

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  const [now, setNow] = useState(() => Date.now());
  const [born] = useState(() => new Map<number, number>());
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(iv); }, []);
  for (const t of toasts) if (!born.has(t.id)) born.set(t.id, Date.now());
  const visible = toasts.filter((t) => now - (born.get(t.id) ?? now) < (t.kind === 'radio' ? 9000 : 6500)).slice(-4);
  return (
    <div className="pointer-events-none absolute left-1/2 top-14 flex w-[min(620px,92vw)] -translate-x-1/2 flex-col items-center gap-2">
      {visible.map((t) => (
        <div key={t.id} className={`w-full rounded-lg border px-4 py-2 text-sm shadow-lg backdrop-blur ${STYLE[t.kind] ?? STYLE.info}`} style={{ animation: 'fadein .25s ease-out' }}>
          <div className="text-[10px] font-bold uppercase tracking-widest text-white/60">{ICON[t.kind]} {t.title}</div>
          <div className={t.kind === 'achievement' ? 'font-display text-base text-amber-200' : 'text-white/90'}>{t.text}</div>
        </div>
      ))}
      <style>{'@keyframes fadein { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }'}</style>
    </div>
  );
}
