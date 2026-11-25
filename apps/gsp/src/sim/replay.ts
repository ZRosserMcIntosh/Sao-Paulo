// Rolling replay buffer: every car's and prop's transform (and the wheels) at 60 Hz for the last
// 24 s, plus gameplay events (collisions, PITs, glass). F replays the most recent event in slow
// motion from other camera angles; the live simulation is frozen meanwhile and resumes after.

export interface ReplayEvent { t: number; kind: 'collision' | 'pit' | 'glass' | 'rollover' | 'sign'; x: number; y: number; z: number; severity: number; ids: number[] }

const RATE = 60;
const SECONDS = 24;
const CAP = RATE * SECONDS;
const CAR_STRIDE = 7 + 4 * 3 + 2; // pose, wheels (y, steer, spin), brake light, lights flags
const PROP_STRIDE = 7;

export class ReplayBuffer {
  times = new Float64Array(CAP);
  cars = new Map<number, Float32Array>();
  props = new Map<number, Float32Array>();
  events: ReplayEvent[] = [];
  head = 0; // next write slot
  count = 0;
  private acc = 0;

  reset() { this.head = 0; this.count = 0; this.cars.clear(); this.props.clear(); this.events = []; this.acc = 0; }

  // call every sim step; records at RATE
  shouldRecord(dt: number) {
    this.acc += dt;
    if (this.acc < 1 / RATE - 1e-6) return false;
    this.acc -= 1 / RATE;
    if (this.acc > 1 / RATE) this.acc = 0;
    return true;
  }
  begin(t: number) { this.times[this.head] = t; return this.head; }
  end() { this.head = (this.head + 1) % CAP; this.count = Math.min(CAP, this.count + 1); }

  car(id: number) { let a = this.cars.get(id); if (!a) this.cars.set(id, (a = new Float32Array(CAP * CAR_STRIDE).fill(NaN))); return a; }
  prop(id: number) { let a = this.props.get(id); if (!a) this.props.set(id, (a = new Float32Array(CAP * PROP_STRIDE).fill(NaN))); return a; }
  static carStride = CAR_STRIDE;
  static propStride = PROP_STRIDE;

  event(e: ReplayEvent) {
    // merge with a recent nearby event of the same kind
    const last = this.events[this.events.length - 1];
    if (last && e.t - last.t < 0.6 && Math.hypot(e.x - last.x, e.z - last.z) < 8) { last.severity = Math.max(last.severity, e.severity); return; }
    this.events.push(e);
    if (this.events.length > 60) this.events.shift();
  }
  oldest() { return this.count ? this.times[(this.head - this.count + CAP) % CAP] : 0; }
  newest() { return this.count ? this.times[(this.head - 1 + CAP) % CAP] : 0; }
  // most notable event in the last 20 s (latest among the strongest)
  pick(now: number): ReplayEvent | null {
    const recent = this.events.filter((e) => e.t > Math.max(this.oldest() + 3, now - 20));
    if (!recent.length) return null;
    let best = recent[recent.length - 1];
    for (const e of recent) if (e.severity > best.severity * 1.8) best = e;
    return best;
  }
  // slot index and blend for a time
  locate(t: number): { i0: number; i1: number; a: number } | null {
    if (!this.count) return null;
    let lo = 0, hi = this.count - 1;
    const at = (k: number) => this.times[(this.head - this.count + k + CAP) % CAP];
    if (t <= at(0)) return { i0: (this.head - this.count + CAP) % CAP, i1: (this.head - this.count + CAP) % CAP, a: 0 };
    if (t >= at(hi)) { const s = (this.head - 1 + CAP) % CAP; return { i0: s, i1: s, a: 0 }; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (at(m) <= t) lo = m; else hi = m; }
    const t0 = at(lo), t1 = at(hi);
    return { i0: (this.head - this.count + lo + CAP) % CAP, i1: (this.head - this.count + hi + CAP) % CAP, a: t1 > t0 ? (t - t0) / (t1 - t0) : 0 };
  }
}
