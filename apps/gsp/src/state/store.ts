// UI state (Zustand). The simulation itself lives outside React (src/sim); this store holds what
// the interface shows and the settings the player chooses. HUD numbers are pushed ~10 times a second.
import { create } from 'zustand';
import type { ScenarioId } from '../sim/scenarios';
import type { Toast, Counters } from '../sim/game';
import type { CameraMode } from '../sim/Simulation';

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';
export type Phase = 'loading' | 'menu' | 'playing';

export interface Hud {
  speed: number; rpm: number; redline: number; gear: number; throttle: number; brake: number;
  emergency: boolean; siren: boolean; camera: CameraMode; slowmo: boolean; paused: boolean; replay: boolean;
  pursuit: { active: boolean; concluded: boolean; time: number; suspects: { name: string; dist: number; speed: number; mode: string; damage: number }[] };
  counters: Counters;
  damage: number; health: number; preset: number; surface: string; upright: number;
  pad: boolean; fps: number;
}

interface State {
  phase: Phase;
  progress: number;
  message: string;
  scenario: ScenarioId;
  seed: number;
  quality: QualityName;
  volume: number;
  muted: boolean;
  voice: boolean;
  labOpen: boolean;
  helpOpen: boolean;
  hud: Hud | null;
  toasts: Toast[];
  version: number;
  set: (p: Partial<State>) => void;
  pushToast: (t: Toast) => void;
}

function initialQuality(): QualityName {
  try {
    const q = localStorage.getItem('gsp.quality') as QualityName | null;
    if (q && ['low', 'medium', 'high', 'ultra'].includes(q)) return q;
  } catch { /* storage unavailable */ }
  return 'high';
}

export const useGame = create<State>((set) => ({
  phase: 'loading',
  progress: 0,
  message: 'Warming up the boiled peanuts…',
  scenario: 'A',
  seed: 1,
  quality: typeof window === 'undefined' ? 'high' : initialQuality(),
  volume: 0.7,
  muted: false,
  voice: true,
  labOpen: false,
  helpOpen: false,
  hud: null,
  toasts: [],
  version: 0,
  set: (p) => set(p),
  pushToast: (t) => set((s) => ({ toasts: [...s.toasts.slice(-5), t] })),
}));
