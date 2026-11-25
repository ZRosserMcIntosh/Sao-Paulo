// UI state (Zustand). The simulation itself lives outside React (src/sim); this store holds what
// the interface shows and the settings the player chooses. HUD numbers are pushed ~10 times a second.
import { create } from 'zustand';
import type { ScenarioId } from '../sim/scenarios';
import type { Toast, Counters } from '../sim/game';
import type { CameraMode } from '../sim/Simulation';
import type { AudioMix } from '../sim/audio';

// Player settings (Settings in the main and pause menus), kept in localStorage.
export interface Settings {
  quality: QualityName;
  volume: number;
  muted: boolean;
  voice: boolean;
  mix: AudioMix;
  units: 'mph' | 'kmh';
  camera: CameraMode;
  shake: boolean;
  hints: boolean;
}
const DEFAULTS: Settings = {
  quality: 'high', volume: 0.7, muted: false, voice: true,
  mix: { engine: 1, tyres: 1, impacts: 1, sirens: 1, radio: 0.8 },
  units: 'mph', camera: 'chase', shake: true, hints: true,
};
function loadSettings(): Settings {
  try {
    const j = JSON.parse(localStorage.getItem('gsp.settings') ?? '{}');
    const q = localStorage.getItem('gsp.quality');
    return { ...DEFAULTS, ...j, mix: { ...DEFAULTS.mix, ...(j.mix ?? {}) }, ...(q && !j.quality ? { quality: q } : {}) };
  } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s: Settings) {
  try { localStorage.setItem('gsp.settings', JSON.stringify(s)); localStorage.setItem('gsp.quality', s.quality); } catch { /* storage unavailable */ }
}

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
  settings: Settings;
  labOpen: boolean;
  helpOpen: boolean;
  hud: Hud | null;
  toasts: Toast[];
  version: number;
  set: (p: Partial<State>) => void;
  setSettings: (p: Partial<Settings>) => void;
  pushToast: (t: Toast) => void;
}


const initial = typeof window === 'undefined' ? { ...DEFAULTS } : loadSettings();

export const useGame = create<State>((set) => ({
  phase: 'loading',
  progress: 0,
  message: 'Warming up the boiled peanuts…',
  scenario: 'A',
  seed: 1,
  quality: initial.quality,
  volume: initial.volume,
  muted: initial.muted,
  voice: initial.voice,
  settings: initial,
  labOpen: false,
  helpOpen: false,
  hud: null,
  toasts: [],
  version: 0,
  set: (p) => set(p),
  // settings mirror the top-level quality/volume/muted/voice the rest of the app reads
  setSettings: (p) => set((st) => {
    const settings = { ...st.settings, ...p, mix: { ...st.settings.mix, ...(p.mix ?? {}) } };
    saveSettings(settings);
    return { settings, quality: settings.quality, volume: settings.volume, muted: settings.muted, voice: settings.voice };
  }),
  pushToast: (t) => set((s) => ({ toasts: [...s.toasts.slice(-5), t] })),
}));
