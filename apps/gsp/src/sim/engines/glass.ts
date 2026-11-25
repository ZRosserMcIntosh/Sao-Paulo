// Client for the Glass Dynamics worker (public/engines/gsp-glass-worker.js). A broken window is
// a GlassBreak: where the pane was in the world when it broke, and what the glass engine made of
// it (flying pieces for tempered glass, crack lines for the laminated windscreen).
import type { V3 } from '../math';

export interface GlassPieces { kind: 'pieces'; shapes: { index: number; thickness: number; outline: number[] }[]; frames: Float32Array[]; fps: number; ms: number }
export interface GlassCracks { kind: 'cracks'; segs: Float32Array; ms: number }

export interface GlassBreak {
  id: number;
  vehicleId: number;
  window: string;
  W: number; H: number;
  // pane frame at the moment of the break: origin (lower front corner), along (pane x), up (pane y), through (pane z)
  origin: V3; along: V3; up: V3; through: V3;
  t: number;
  result: GlassPieces | GlassCracks | null;
  error?: string;
}

export class GlassClient {
  private worker: Worker | null = null;
  private failed = false;
  private nextId = 1;
  breaks: GlassBreak[] = [];
  onResult?: (b: GlassBreak) => void;
  mobile = false;

  constructor(private readonly url: string) {}

  private ensure() {
    if (this.worker || this.failed) return !!this.worker;
    try {
      this.worker = new Worker(this.url, { type: 'module' });
      this.worker.onmessage = (e) => {
        const b = this.breaks.find((x) => x.id === e.data.id);
        if (!b) return;
        if (e.data.error) { b.error = e.data.error; console.warn('glass engine:', e.data.error); return; }
        b.result = e.data;
        this.onResult?.(b);
      };
      this.worker.onerror = (e) => { console.warn('glass worker failed', e.message); this.failed = true; this.worker = null; };
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  // hit (hx, hy) in pane coordinates (m from the lower front corner), floor: pane bottom above the road
  request(b: Omit<GlassBreak, 'id' | 't' | 'result'>, hx: number, hy: number, speed: number, floor: number, seed: number) {
    if (!this.ensure()) return null;
    const br: GlassBreak = { ...b, id: this.nextId++, t: 0, result: null };
    this.breaks.push(br);
    if (this.breaks.length > 10) this.breaks.splice(0, this.breaks.length - 10);
    const windscreen = b.window === 'windscreen';
    this.worker!.postMessage({
      id: br.id,
      glazing: windscreen ? 'windscreen' : 'car_side_tempered',
      impactor: windscreen ? 'headform' : 'stone',
      tier: this.mobile ? 0 : 1,
      seed,
      W: b.W, H: b.H, floor,
      x: Math.max(0.08, Math.min(b.W - 0.08, hx)), y: Math.max(0.08, Math.min(b.H - 0.08, hy)),
      speed: windscreen ? Math.max(6, Math.min(14, speed * 1.4)) : Math.max(6, Math.min(16, speed * 2)),
      mass: windscreen ? 4.5 : 0.5,
      radius: windscreen ? 0.08 : 0.03,
      T: 2.2,
      maxPts: 6,
      maxPieces: this.mobile ? 160 : 420,
    });
    return br;
  }

  clear() { this.breaks = []; }
}
