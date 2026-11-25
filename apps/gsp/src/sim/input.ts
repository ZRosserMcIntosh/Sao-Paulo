// Keyboard and gamepad. Produces the player's analog intent and edge-triggered actions.
import { clamp } from './math';

export type Action = 'lights' | 'siren' | 'camera' | 'reset' | 'slowmo' | 'replay' | 'telemetry' | 'pause' | 'step' | 'horn' | 'menu' | 'tow' | 'photo';

export class Input {
  private keys = new Set<string>();
  private queue: Action[] = [];
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = 0;
  horn = false;
  padConnected = false;
  padName = '';
  sensitivity = 1;
  enabled = true;
  private padPrev: boolean[] = [];
  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const k = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(k)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(k);
    const map: Record<string, Action> = {
      KeyL: 'lights', KeyH: 'siren', KeyC: 'camera', KeyR: 'reset', KeyT: 'slowmo', KeyF: 'replay', Tab: 'telemetry', Escape: 'pause', KeyP: 'pause', KeyN: 'step', KeyY: 'tow', KeyU: 'photo',
    };
    const a = map[k];
    if (a) this.queue.push(a);
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private onBlur = () => this.keys.clear();

  attach() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }
  detach() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
  actions(): Action[] { const q = this.queue; this.queue = []; return q; }
  push(a: Action) { this.queue.push(a); }

  // Called once per rendered frame (real time dt).
  update(dt: number) {
    const k = this.keys;
    const left = k.has('KeyA') || k.has('ArrowLeft'), right = k.has('KeyD') || k.has('ArrowRight');
    const up = k.has('KeyW') || k.has('ArrowUp'), down = k.has('KeyS') || k.has('ArrowDown');
    let target = (right ? 1 : 0) - (left ? 1 : 0);
    let thr = up ? 1 : 0, brk = down ? 1 : 0, hb = k.has('Space') ? 1 : 0;
    this.horn = k.has('KeyG');
    // gamepad (standard mapping)
    let padSteer: number | null = null;
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads ?? []).find((p) => p && p.connected) ?? null;
    this.padConnected = !!pad;
    if (pad) {
      this.padName = pad.id;
      const ax = pad.axes[0] ?? 0;
      const dz = 0.08;
      const s = Math.abs(ax) < dz ? 0 : (ax - Math.sign(ax) * dz) / (1 - dz);
      if (Math.abs(s) > 0.001) padSteer = Math.sign(s) * Math.pow(Math.abs(s), 1.35 / this.sensitivity);
      const rt = pad.buttons[7]?.value ?? 0, lt = pad.buttons[6]?.value ?? 0;
      thr = Math.max(thr, rt);
      brk = Math.max(brk, lt);
      if (pad.buttons[2]?.pressed || pad.buttons[5]?.pressed) hb = 1;
      const edge = (i: number, a: Action) => {
        const now = !!pad.buttons[i]?.pressed;
        if (now && !this.padPrev[i]) this.queue.push(a);
        this.padPrev[i] = now;
      };
      edge(1, 'lights'); edge(3, 'camera'); edge(4, 'siren'); edge(9, 'pause'); edge(8, 'reset'); edge(12, 'replay'); edge(13, 'slowmo'); edge(14, 'telemetry');
    }
    if (padSteer !== null && target === 0) {
      this.steer = padSteer;
    } else {
      // keyboard: ramp toward the target, faster back to centre
      const rate = (target === 0 || Math.sign(target) !== Math.sign(this.steer) ? 6 : 2.6) * this.sensitivity;
      const d = target - this.steer;
      this.steer += clamp(d, -rate * dt, rate * dt);
    }
    if (!this.enabled) { thr = 0; brk = 0; hb = 0; target = 0; }
    this.throttle = thr;
    this.brake = brk;
    this.handbrake = hb;
  }
}
