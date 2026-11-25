// Game-side damage. The physics (contacts, spins, rollovers) is all rigid-body + tyre model; this
// layer turns the contact impulses Rapier reports into visual damage stages, detachable parts,
// broken lights and glass, smoke, a little mechanical degradation, and a repair bill.
// Body frame (three.js): +X forward, +Y up, +Z right.
import type { Rng } from '../math';

export type Zone = 'front' | 'rear' | 'left' | 'right' | 'roof';
export type PartId = 'bumperF' | 'bumperR' | 'mirrorL' | 'mirrorR' | 'lightbar' | 'pushbar' | 'hubcap0' | 'hubcap1' | 'hubcap2' | 'hubcap3' | 'tailgate' | 'antenna';
export type WindowId = 'windscreen' | 'rear' | 'sideL' | 'sideR';

export interface Dent { x: number; y: number; z: number; nx: number; ny: number; nz: number; depth: number; radius: number }

export type DamageEvent =
  | { type: 'detach'; part: PartId }
  | { type: 'glass'; window: WindowId; x: number; y: number; z: number; speed: number }
  | { type: 'light'; which: 'headL' | 'headR' | 'tailL' | 'tailR' | 'bar' }
  | { type: 'stage'; zone: Zone; stage: number };

export class DamageState {
  zones: Record<Zone, number> = { front: 0, rear: 0, left: 0, right: 0, roof: 0 };
  stages: Record<Zone, number> = { front: 0, rear: 0, left: 0, right: 0, roof: 0 };
  lights = { headL: true, headR: true, tailL: true, tailR: true, bar: true };
  detached = new Set<PartId>();
  hanging = new Set<PartId>(); // loose, about to go
  windows: Record<WindowId, number> = { windscreen: 0, rear: 0, sideL: 0, sideR: 0 }; // 0 intact, 1 cracked, 2 gone
  dents: Dent[] = [];
  scratches = 0;
  smoke = 0;
  repairCost = 0;
  version = 0;

  constructor(readonly halfLength: number, readonly halfWidth: number, readonly height: number, readonly costPerDv: number, readonly police: boolean) {}

  get total() { return this.zones.front + this.zones.rear + this.zones.left + this.zones.right + this.zones.roof; }
  get health() { return Math.max(0.15, 1 - this.total / 70); }
  // engine output multiplier (a pushed-in radiator, a bent intake)
  get power() { return this.zones.front > 9 ? Math.max(0.45, 1 - (this.zones.front - 9) / 30) : 1; }
  // steering pull from bent front suspension (+ = pulls left)
  get pull() { return Math.max(-0.07, Math.min(0.07, (this.zones.right - this.zones.left) * 0.0025 * (this.zones.front > 3 ? 1.6 : 1))); }
  get worst() { return Math.max(...Object.values(this.stages)); }

  // One contact: point and the impulse direction INTO the car, body frame; dv = impulse / mass (m/s).
  impact(px: number, py: number, pz: number, nx: number, ny: number, nz: number, dv: number, rng: Rng, out: DamageEvent[]) {
    if (dv < 0.4) return;
    const fx = px / this.halfLength, fz = pz / this.halfWidth;
    let zone: Zone;
    if (py > this.height * 0.62 && ny < -0.35) zone = 'roof';
    else if (Math.abs(fx) > Math.abs(fz) * 1.15) zone = fx > 0 ? 'front' : 'rear';
    else zone = fz > 0 ? 'right' : 'left';
    this.zones[zone] += dv;
    this.scratches = Math.min(1, this.scratches + dv * 0.05);
    this.repairCost += Math.round(dv * this.costPerDv * (0.8 + 0.4 * rng.next()));
    // dent the body where it was hit
    if (dv > 1.2) {
      // a hit near an earlier dent deepens it (up to a limit) instead of stacking a new one
      const near = this.dents.find((d) => Math.hypot(d.x - px, d.y - py, d.z - pz) < 0.45);
      const depth = Math.min(0.12, dv * 0.011), radius = Math.min(0.9, 0.3 + dv * 0.04);
      if (near) { near.depth = Math.min(0.2, near.depth + depth * 0.35); near.radius = Math.min(1.0, Math.max(near.radius, radius)); }
      else if (this.dents.length < 32) this.dents.push({ x: px, y: py, z: pz, nx, ny, nz, depth, radius });
    }
    const stage = this.zones[zone] > 9 ? 3 : this.zones[zone] > 4.2 ? 2 : this.zones[zone] > 1.4 ? 1 : 0;
    if (stage > this.stages[zone]) { this.stages[zone] = stage; out.push({ type: 'stage', zone, stage }); }
    const right = pz > 0;
    // lights
    if (zone === 'front' && (dv > 3 || stage >= 2)) {
      const w = right ? 'headR' : 'headL';
      if (this.lights[w]) { this.lights[w] = false; out.push({ type: 'light', which: w }); }
      if (dv > 6 && this.lights[right ? 'headL' : 'headR']) { const o = right ? 'headL' : 'headR'; this.lights[o] = false; out.push({ type: 'light', which: o }); }
    }
    if (zone === 'rear' && (dv > 2.5 || stage >= 2)) {
      const w = right ? 'tailR' : 'tailL';
      if (this.lights[w]) { this.lights[w] = false; out.push({ type: 'light', which: w }); }
    }
    // parts
    const loosen = (p: PartId, hangAt: number, dropAt: number) => {
      if (this.detached.has(p)) return;
      const v = this.zones[zone];
      if (v > dropAt || (dv > dropAt * 0.75 && rng.chance(0.5))) { this.detached.add(p); this.hanging.delete(p); out.push({ type: 'detach', part: p }); }
      else if (v > hangAt) this.hanging.add(p);
    };
    if (zone === 'front') { loosen('bumperF', 3.5, 8.5); if (this.police && this.zones.front > 12) loosen('pushbar', 10, 14); }
    if (zone === 'rear') { loosen('bumperR', 3.5, 8.5); loosen('tailgate', 6, 11); }
    if (zone === 'left' && dv > 1.5) { loosen('mirrorL', 1.2, 2.8); if (dv > 3 && rng.chance(0.4)) loosen(rng.chance(0.5) ? 'hubcap0' : 'hubcap2', 0, 2); }
    if (zone === 'right' && dv > 1.5) { loosen('mirrorR', 1.2, 2.8); if (dv > 3 && rng.chance(0.4)) loosen(rng.chance(0.5) ? 'hubcap1' : 'hubcap3', 0, 2); }
    if (zone === 'roof') {
      if (this.police && this.lights.bar && this.zones.roof > 2.5) { this.lights.bar = false; out.push({ type: 'light', which: 'bar' }); }
      loosen(this.police ? 'lightbar' : 'antenna', 2, 4.5);
    }
    // glass: tempered side glass shatters, the laminated windscreen cracks and stays
    const glass = (w: WindowId, thr: number) => {
      if (this.windows[w] >= (w === 'windscreen' ? 1 : 2)) return;
      if (dv > thr || this.zones[zone] > thr * 1.6) {
        this.windows[w] = w === 'windscreen' ? 1 : 2;
        out.push({ type: 'glass', window: w, x: px, y: py, z: pz, speed: dv });
      }
    };
    if (zone === 'left') glass('sideL', 4.5);
    if (zone === 'right') glass('sideR', 4.5);
    if (zone === 'rear') glass('rear', 7);
    if (zone === 'front' && dv > 7) glass('windscreen', 7);
    if (zone === 'roof') { glass('windscreen', 2.5); glass(rng.chance(0.5) ? 'sideL' : 'sideR', 3); }
    this.smoke = Math.max(this.smoke, this.zones.front > 7 ? Math.min(1, (this.zones.front - 7) / 10) : 0);
    this.version++;
  }

  repair() {
    for (const z of Object.keys(this.zones) as Zone[]) { this.zones[z] = 0; this.stages[z] = 0; }
    this.lights = { headL: true, headR: true, tailL: true, tailR: true, bar: true };
    this.detached.clear();
    this.hanging.clear();
    this.windows = { windscreen: 0, rear: 0, sideL: 0, sideR: 0 };
    this.dents = [];
    this.scratches = 0;
    this.smoke = 0;
    this.version++;
  }
}
