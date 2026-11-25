// Small math helpers shared by the simulation (no three.js dependency, so the sim can run headless).

export type V3 = { x: number; y: number; z: number };
export type Q4 = { x: number; y: number; z: number; w: number };

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const vlen = (v: V3) => Math.hypot(v.x, v.y, v.z);
export const vsub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vadd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vscale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vdot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

// Rotate v by unit quaternion q.
export function qrot(q: Q4, v: V3): V3 {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}
export const qconj = (q: Q4): Q4 => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export const qinvrot = (q: Q4, v: V3) => qrot(qconj(q), v);
export function qFromYaw(yaw: number): Q4 {
  // rotation about +Y (three.js up)
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
export function qslerp(a: Q4, b: Q4, t: number, out: Q4): Q4 {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0 = 1 - t, k1 = t;
  if (cos < 0.9995) {
    const s = Math.sqrt(1 - cos * cos), ang = Math.atan2(s, cos);
    k0 = Math.sin((1 - t) * ang) / s;
    k1 = Math.sin(t * ang) / s;
  }
  out.x = a.x * k0 + bx * k1; out.y = a.y * k0 + by * k1; out.z = a.z * k0 + bz * k1; out.w = a.w * k0 + bw * k1;
  const l = Math.hypot(out.x, out.y, out.z, out.w) || 1;
  out.x /= l; out.y /= l; out.z /= l; out.w /= l;
  return out;
}

// Deterministic RNG (mulberry32). Every scenario draws from one seeded stream.
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  chance(p: number) { return this.next() < p; }
  fork(salt: number) { return new Rng((this.next() * 4294967296) ^ salt); }
}

// Hash-based value noise (deterministic, seedable) for terrain.
export function hash2(i: number, j: number, seed: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function valueNoise(x: number, y: number, seed: number): number {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}
export function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let s = 0, a = 1, f = 1, n = 0;
  for (let o = 0; o < octaves; ++o) { s += a * valueNoise(x * f, y * f, seed + o * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}

export const KMH = 3.6;
export const MPH = 2.236936;
