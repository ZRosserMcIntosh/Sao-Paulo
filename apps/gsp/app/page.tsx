'use client';
import dynamic from 'next/dynamic';

// Everything runs in the browser: WebGL, WebAssembly engines, Web Audio.
const Game = dynamic(() => import('../src/ui/Game'), { ssr: false, loading: () => <div className="fixed inset-0 grid place-items-center text-white/60">Loading Georgia…</div> });

export default function Page() {
  return <Game />;
}
