// The I-GSP interstate test loop: a closed, divided, six-lane highway. One smooth centreline
// (the middle of the grass median) carries everything: elevation, superelevation in the curves,
// the lanes of both carriageways, and a fast nearest-point query used by AI, terrain and props.
// Coordinates are three.js world space (Y up); s is arc length along the loop (m), d the signed
// lateral offset (m), positive to the right of the direction of increasing s.
import { clamp, smoothstep } from '../math';

// Cross-section, |d| from the median centreline.
export const XS = {
  median: 7.5, // grass median half width (V ditch)
  innerShoulder: 8.5, // inner paved shoulder ends, lane 0 begins
  laneWidth: 3.66,
  lanes: 3,
  get lanesEnd() { return this.innerShoulder + this.lanes * this.laneWidth; }, // 19.48
  outerShoulder: 22.5,
  verge: 25,
} as const;

export function laneCenterOffset(lane: number): number {
  return XS.innerShoulder + (lane + 0.5) * XS.laneWidth;
}

const CONTROL: [number, number][] = [
  [-700, 300], [-250, 385], [250, 340], [650, 250], [860, 60], [840, -240], [620, -430], [170, -455],
  [-280, -390], [-640, -430], [-890, -270], [-920, 40],
];

export interface TrackSample {
  x: number; z: number; y: number; // centreline position (median centre at its own height)
  tx: number; tz: number; // unit tangent (direction of +s)
  rx: number; rz: number; // unit right normal (direction of +d)
  k: number; // signed curvature, + = turning left
  bank: number; // superelevation, rise per metre toward the outside of the curve (signed with k)
}

export class Track {
  readonly step = 2; // m between samples
  readonly samples: TrackSample[] = [];
  readonly length: number;
  readonly overpassS: number;
  readonly padS: number;
  readonly insideSign: number; // the side (sign of d) the loop's interior is on
  private grid = new Map<number, number[]>();
  private readonly cell = 40;

  constructor(readonly seed: number) {
    const dense = catmullRomClosed(CONTROL, 64);
    // resample by arc length, then smooth for gentle, highway-like curvature
    let pts = resampleClosed(dense, this.step);
    for (let it = 0; it < 60; ++it) pts = smoothClosed(pts, 0.5);
    pts = resampleClosed(pts, this.step);
    const n = pts.length;
    this.length = n * this.step;
    // orientation: signed area (shoelace in x, z)
    let area = 0;
    for (let i = 0; i < n; ++i) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    for (let i = 0; i < n; ++i) {
      const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
      let tx = q[0] - p[0], tz = q[1] - p[1];
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      // right of travel in Y-up space: tangent x up = (tx, 0, tz) x (0, 1, 0) = (-tz, 0, tx)
      const rx = -tz, rz = tx;
      // signed curvature from the turn of the tangent (left = +)
      const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
      const cross = ax * bz - az * bx, dot = ax * bx + az * bz;
      // turning toward -right (left) when the tangent rotates toward (tz, -tx): sign by cross in (x, z) with Y up
      const ang = Math.atan2(cross, dot);
      const k = -ang / this.step; // x-z cross > 0 is a right turn when Y is up
      this.samples.push({ x: c[0], z: c[1], y: 0, tx, tz, rx, rz, k, bank: 0 });
    }
    // smooth curvature, then superelevation and elevation
    const ks = this.samples.map((s) => s.k);
    for (let it = 0; it < 30; ++it) for (let i = 0; i < n; ++i) ks[i] = 0.25 * ks[(i - 1 + n) % n] + 0.5 * ks[i] + 0.25 * ks[(i + 1) % n];
    for (let i = 0; i < n; ++i) {
      const s = this.samples[i];
      s.k = ks[i];
      s.bank = clamp(s.k * 22, -0.065, 0.065);
      const u = (i * this.step) / this.length;
      s.y = 4.5 * Math.sin(2 * Math.PI * 2 * u + 0.4) + 2.2 * Math.sin(2 * Math.PI * 5 * u + 1.9) + 1.0 * Math.sin(2 * Math.PI * 9 * u + 0.2) + 3;
    }
    // interior side: toward the centroid
    let cx = 0, cz = 0;
    for (const s of this.samples) { cx += s.x; cz += s.z; }
    cx /= n; cz /= n;
    let side = 0;
    for (let i = 0; i < n; i += 50) { const s = this.samples[i]; side += (cx - s.x) * s.rx + (cz - s.z) * s.rz; }
    this.insideSign = side >= 0 ? 1 : -1;
    void area;
    // feature placement: the straightest stretches
    this.overpassS = this.straightest(0.12, 0.38);
    this.padS = this.straightest(0.55, 0.8);
    // flatten the elevation around the overpass and the pad (smooth blend)
    this.flattenAround(this.overpassS, 220);
    this.flattenAround(this.padS, 420);
    for (let i = 0; i < n; ++i) {
      const s = this.samples[i];
      const key = this.key(Math.floor(s.x / this.cell), Math.floor(s.z / this.cell));
      let b = this.grid.get(key);
      if (!b) this.grid.set(key, (b = []));
      b.push(i);
    }
  }

  private straightest(u0: number, u1: number): number {
    const n = this.samples.length;
    let best = Infinity, bi = 0;
    const win = 120;
    for (let i = Math.floor(u0 * n); i < Math.floor(u1 * n); ++i) {
      let m = 0;
      for (let k = -win; k <= win; k += 4) m = Math.max(m, Math.abs(this.samples[(i + k + n) % n].k));
      if (m < best) { best = m; bi = i; }
    }
    return bi * this.step;
  }
  private flattenAround(s0: number, half: number) {
    const n = this.samples.length;
    const y0 = this.sampleAt(s0).y;
    for (let i = 0; i < n; ++i) {
      const ds = Math.abs(this.wrapDelta(i * this.step - s0));
      const w = 1 - smoothstep(half * 0.45, half, ds);
      const s = this.samples[i];
      s.y = s.y * (1 - w) + y0 * w;
      s.bank *= 1 - w;
    }
  }

  // The paved, barrier-divided section through the overpass interchange.
  isUrban(s: number) { return Math.abs(this.wrapDelta(s - this.overpassS)) < 450; }

  private key(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }
  wrap(s: number) { return ((s % this.length) + this.length) % this.length; }
  wrapDelta(ds: number) { const L = this.length; ds = ((ds % L) + L) % L; return ds > L / 2 ? ds - L : ds; }

  // interpolated sample at arc length s (allocates; use sampleInto in hot paths)
  sampleAt(s: number): TrackSample {
    const o = { x: 0, z: 0, y: 0, tx: 0, tz: 0, rx: 0, rz: 0, k: 0, bank: 0 };
    return this.sampleInto(s, o);
  }
  sampleInto(s: number, o: TrackSample): TrackSample {
    const n = this.samples.length;
    const f = this.wrap(s) / this.step;
    const i = Math.floor(f) % n, j = (i + 1) % n, t = f - Math.floor(f);
    const a = this.samples[i], b = this.samples[j];
    o.x = a.x + (b.x - a.x) * t; o.z = a.z + (b.z - a.z) * t; o.y = a.y + (b.y - a.y) * t;
    let tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t;
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    o.tx = tx; o.tz = tz; o.rx = -tz; o.rz = tx;
    o.k = a.k + (b.k - a.k) * t; o.bank = a.bank + (b.bank - a.bank) * t;
    return o;
  }

  // Road surface height at (s, d): median ditch, crowned or banked carriageways, verges.
  heightAt(s: number, d: number, smp?: TrackSample): number {
    const c = smp ?? this.sampleAt(s);
    const ad = Math.abs(d);
    if (ad <= XS.median) return this.isUrban(s) ? c.y : c.y - 0.85 * (1 - (ad / XS.median) ** 2);
    const e = c.bank;
    const crown = 0.018 * (1 - Math.min(1, Math.abs(e) / 0.03));
    // h = y + slope * (outward distance from the median edge); banking raises the outside of the curve
    const out = ad - XS.median;
    const slope = d > 0 ? e - crown : -e - crown; // turning left (e > 0) the right carriageway is the outside and rises
    const hPave = c.y + slope * Math.min(out, XS.outerShoulder - XS.median);
    if (ad <= XS.outerShoulder) return hPave;
    // verge: falls away 4 %
    return hPave - 0.04 * Math.min(ad - XS.outerShoulder, XS.verge - XS.outerShoulder);
  }

  // Nearest centreline point: s and signed d. Searches the sample buckets around (x, z).
  nearest(x: number, z: number, hintS?: number): { s: number; d: number } {
    if (hintS !== undefined) {
      // local refinement from a hint (fast path for vehicles)
      let best = Infinity, bs = hintS, bd = 0;
      for (let k = -6; k <= 6; ++k) {
        const s = this.wrap(hintS + k * this.step * 2);
        const r = this.project(x, z, s);
        if (r.dist < best) { best = r.dist; bs = r.s; bd = r.d; }
      }
      if (best < 60) return { s: bs, d: bd };
    }
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    let best = Infinity, bi = -1;
    for (let r = 1; r <= 40 && bi < 0; r *= 2) {
      for (let i = ci - r; i <= ci + r; ++i)
        for (let j = cj - r; j <= cj + r; ++j) {
          const b = this.grid.get(this.key(i, j));
          if (!b) continue;
          for (const k of b) {
            const sm = this.samples[k];
            const dd = (sm.x - x) ** 2 + (sm.z - z) ** 2;
            if (dd < best) { best = dd; bi = k; }
          }
        }
    }
    if (bi < 0) return { s: 0, d: 1e6 };
    const r = this.project(x, z, bi * this.step);
    return { s: r.s, d: r.d };
  }
  private project(x: number, z: number, s: number) {
    const n = this.samples.length;
    const i = Math.round(this.wrap(s) / this.step) % n;
    let best = { s: i * this.step, d: 0, dist: Infinity };
    for (const k of [-1, 0]) {
      const a = this.samples[(i + k + n) % n], b = this.samples[(i + k + 1) % n];
      const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
      let t = ((x - a.x) * ex + (z - a.z) * ez) / l2;
      t = clamp(t, 0, 1);
      const px = a.x + ex * t, pz = a.z + ez * t;
      const dist = Math.hypot(x - px, z - pz);
      if (dist < best.dist) {
        const rx = a.rx + (b.rx - a.rx) * t, rz = a.rz + (b.rz - a.rz) * t;
        best = { s: this.wrap(((i + k + n) % n + t) * this.step), d: (x - px) * rx + (z - pz) * rz, dist };
      }
    }
    return best;
  }

  // World position of (s, d) on the road surface.
  point(s: number, d: number, out = { x: 0, y: 0, z: 0 }) {
    const c = this.sampleAt(s);
    out.x = c.x + c.rx * d; out.z = c.z + c.rz * d; out.y = this.heightAt(s, d, c);
    return out;
  }
  // Heading (three yaw about +Y) of travel along +s (dir = 1) or -s (dir = -1) at s.
  headingAt(s: number, dir: 1 | -1): number {
    const c = this.sampleAt(s);
    const fx = c.tx * dir, fz = c.tz * dir;
    // three yaw: forward (cos y, 0, -sin y)
    return Math.atan2(-fz, fx);
  }
}

function catmullRomClosed(p: [number, number][], seg: number): [number, number][] {
  const out: [number, number][] = [];
  const n = p.length;
  for (let i = 0; i < n; ++i) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    for (let k = 0; k < seg; ++k) {
      const t = k / seg, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}
function resampleClosed(p: [number, number][], step: number): [number, number][] {
  const n = p.length;
  const cum = [0];
  for (let i = 0; i < n; ++i) { const a = p[i], b = p[(i + 1) % n]; cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L = cum[n];
  const m = Math.round(L / step);
  const ds = L / m;
  const out: [number, number][] = [];
  let j = 0;
  for (let k = 0; k < m; ++k) {
    const s = k * ds;
    while (cum[j + 1] < s) ++j;
    const t = (s - cum[j]) / (cum[j + 1] - cum[j]);
    const a = p[j % n], b = p[(j + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
function smoothClosed(p: [number, number][], w: number): [number, number][] {
  const n = p.length;
  return p.map((c, i) => {
    const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
    return [c[0] * (1 - w) + 0.5 * w * (a[0] + b[0]), c[1] * (1 - w) + 0.5 * w * (a[1] + b[1])] as [number, number];
  });
}
