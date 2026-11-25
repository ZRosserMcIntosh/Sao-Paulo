// The proving ground's ground: one heightfield with a surface class per cell. The same arrays
// go to the vehicle core (wheel contact, gsp_ground_alloc), to Rapier (props, debris) and to the
// renderer (terrain mesh), so what the tyres feel is what you see.
import { clamp, fbm, lerp, smoothstep } from '../math';
import { Track, XS } from './track';

export const SURF = {
  ASPHALT: 0, CONCRETE: 1, SHOULDER: 2, GRASS: 3, CLAY: 4, GRAVEL: 5, PAD: 6, DECK: 7, COUNTY: 8, DITCH: 9, PUDDLE: 15,
} as const;
export const SURFACE_NAMES: Record<number, string> = {
  0: 'Asphalt', 1: 'Concrete', 2: 'Shoulder', 3: 'Grass', 4: 'Red clay', 5: 'Gravel', 6: 'Test pad', 7: 'Bridge deck', 8: 'County road', 9: 'Median ditch', 15: 'Puddle',
};

export interface SurfaceDef { friction: number; rolling: number; roughness: number; looseness: number; texAmp: number; texWave: number; wetLoss: number; paved: boolean }

// Defaults; the lab's "surface friction" slider scales `friction` of every class.
export const SURFACES: Record<number, SurfaceDef> = {
  [SURF.ASPHALT]: { friction: 1.0, rolling: 1, roughness: 0, looseness: 0, texAmp: 0, texWave: 0.15, wetLoss: 0.3, paved: true },
  [SURF.CONCRETE]: { friction: 0.97, rolling: 1, roughness: 0, looseness: 0, texAmp: 0, texWave: 0.15, wetLoss: 0.32, paved: true },
  [SURF.SHOULDER]: { friction: 0.94, rolling: 1.2, roughness: 0.2, looseness: 0.05, texAmp: 0.002, texWave: 0.25, wetLoss: 0.35, paved: true },
  [SURF.GRASS]: { friction: 0.62, rolling: 4, roughness: 0.5, looseness: 0.45, texAmp: 0.008, texWave: 0.6, wetLoss: 0.35, paved: false },
  [SURF.CLAY]: { friction: 0.58, rolling: 5.5, roughness: 0.6, looseness: 0.75, texAmp: 0.01, texWave: 0.5, wetLoss: 0.55, paved: false },
  [SURF.GRAVEL]: { friction: 0.7, rolling: 3, roughness: 0.6, looseness: 0.9, texAmp: 0.006, texWave: 0.2, wetLoss: 0.15, paved: false },
  [SURF.PAD]: { friction: 1.03, rolling: 1, roughness: 0, looseness: 0, texAmp: 0, texWave: 0.15, wetLoss: 0.28, paved: true },
  [SURF.DECK]: { friction: 0.97, rolling: 1, roughness: 0.1, looseness: 0, texAmp: 0.001, texWave: 0.3, wetLoss: 0.32, paved: true },
  [SURF.COUNTY]: { friction: 0.95, rolling: 1.1, roughness: 0.2, looseness: 0, texAmp: 0.002, texWave: 0.4, wetLoss: 0.34, paved: true },
  [SURF.DITCH]: { friction: 0.52, rolling: 5, roughness: 0.5, looseness: 0.55, texAmp: 0.008, texWave: 0.6, wetLoss: 0.4, paved: false },
};

export interface Ground {
  nx: number; nz: number; minX: number; minZ: number; cell: number;
  heights: Float32Array; classes: Uint8Array;
  near: Float32Array; // |d| to the interstate centreline per cell (Infinity when far)
  heightAt(x: number, z: number): number;
  classAt(x: number, z: number): number;
}

export interface Features {
  deckY: number; // overpass deck top
  overpass: { x: number; z: number; y: number; ux: number; uz: number; vx: number; vz: number; halfSpan: number; halfWidth: number };
  pad: { x: number; z: number; y: number; ax: number; az: number; bx: number; bz: number; a0: number; a1: number; b0: number; b1: number };
  countyEnd: number; // |u| where the county road ends
}

const RAMP = 150; // county-road ramp length (m)
const ABUT = 31; // abutment |u|
const COUNTY_HALF = 5.5;
const PAD = { a0: -170, a1: 170, b0: 32, b1: 255 };

export function naturalTerrain(x: number, z: number, seed: number): number {
  return 3 + 6.5 * fbm(x / 430, z / 430, seed, 3) + 1.6 * fbm(x / 95, z / 95, seed + 101, 3);
}

export function buildFeatures(track: Track): Features {
  const o = track.sampleAt(track.overpassS);
  const deckY = o.y + 7.4;
  const p = track.sampleAt(track.padS);
  const sgn = track.insideSign;
  const padY = track.heightAt(track.padS, sgn * XS.outerShoulder);
  return {
    deckY,
    overpass: { x: o.x, z: o.z, y: o.y, ux: o.rx, uz: o.rz, vx: o.tx, vz: o.tz, halfSpan: ABUT + 0.5, halfWidth: COUNTY_HALF },
    pad: { x: p.x, z: p.z, y: padY, ax: p.tx, az: p.tz, bx: p.rx * sgn, bz: p.rz * sgn, ...PAD },
    countyEnd: 620,
  };
}

export function buildGround(track: Track, f: Features, seed: number, cell = 1.5): Ground {
  // bounds
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of track.samples) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z); }
  const margin = 320;
  minX = Math.floor((minX - margin) / cell) * cell; minZ = Math.floor((minZ - margin) / cell) * cell;
  maxX += margin; maxZ += margin;
  const nx = Math.ceil((maxX - minX) / cell) + 1, nz = Math.ceil((maxZ - minZ) / cell) + 1;
  const N = nx * nz;
  const heights = new Float32Array(N), classes = new Uint8Array(N);
  const near = new Float32Array(N).fill(Infinity);
  const sArr = new Float32Array(N), dArr = new Float32Array(N);

  // 1. distance stamping from the centreline (s, signed d per cell within R)
  const R = 75;
  const smp = track.samples, n = smp.length;
  for (let i = 0; i < n; ++i) {
    const a = smp[i], b = smp[(i + 1) % n];
    const x0 = Math.min(a.x, b.x) - R, x1 = Math.max(a.x, b.x) + R, z0 = Math.min(a.z, b.z) - R, z1 = Math.max(a.z, b.z) + R;
    const i0 = Math.max(0, Math.floor((x0 - minX) / cell)), i1 = Math.min(nx - 1, Math.ceil((x1 - minX) / cell));
    const j0 = Math.max(0, Math.floor((z0 - minZ) / cell)), j1 = Math.min(nz - 1, Math.ceil((z1 - minZ) / cell));
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
    for (let j = j0; j <= j1; ++j) {
      const z = minZ + j * cell;
      for (let ii = i0; ii <= i1; ++ii) {
        const x = minX + ii * cell;
        let t = ((x - a.x) * ex + (z - a.z) * ez) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = a.x + ex * t, pz = a.z + ez * t;
        const dist = Math.hypot(x - px, z - pz);
        const k = j * nx + ii;
        if (dist < near[k]) {
          near[k] = dist;
          sArr[k] = (i + t) * track.step;
          const rx = a.rx + (b.rx - a.rx) * t, rz = a.rz + (b.rz - a.rz) * t;
          dArr[k] = (x - px) * rx + (z - pz) * rz;
        }
      }
    }
  }

  // 2. heights and classes
  const op = f.overpass, pd = f.pad;
  const opT = naturalTerrain(op.x + op.ux * (ABUT + RAMP), op.z + op.uz * (ABUT + RAMP), seed);
  const opT2 = naturalTerrain(op.x - op.ux * (ABUT + RAMP), op.z - op.uz * (ABUT + RAMP), seed);
  const tmp = track.sampleAt(0);
  for (let j = 0; j < nz; ++j) {
    const z = minZ + j * cell;
    for (let i = 0; i < nx; ++i) {
      const x = minX + i * cell, k = j * nx + i;
      const T = naturalTerrain(x, z, seed);
      let H = T;
      // natural ground: grass with red clay showing through
      const clayNoise = fbm(x / 60, z / 60, seed + 7, 3);
      let C: number = clayNoise > 0.42 ? SURF.CLAY : SURF.GRASS;
      // interstate corridor
      const dist = near[k];
      if (dist < Infinity) {
        const s = sArr[k], d = dArr[k], ad = Math.abs(d);
        track.sampleInto(s, tmp);
        if (ad <= XS.verge) {
          H = track.heightAt(s, d, tmp);
          if (ad <= XS.median) C = track.isUrban(s) ? SURF.CONCRETE : SURF.DITCH;
          else if (ad <= XS.innerShoulder) C = SURF.SHOULDER;
          else if (ad <= XS.lanesEnd) C = SURF.ASPHALT;
          else if (ad <= XS.outerShoulder) C = SURF.SHOULDER;
          else C = SURF.GRAVEL;
        } else {
          const hE = track.heightAt(s, Math.sign(d) * XS.verge, tmp);
          const r = ad - XS.verge;
          const reach = r * 0.45;
          H = hE + clamp(T - hE, -reach, reach);
          if (T - hE > reach * 0.98 && H - hE > 0.6) C = SURF.CLAY; // cut face: Georgia red clay
          else if (r < 6) C = SURF.GRASS;
        }
      }
      // county road + its ramps over the interstate (never under the deck: that is the interstate)
      {
        const rx = x - op.x, rz = z - op.z;
        const u = rx * op.ux + rz * op.uz, v = rx * op.vx + rz * op.vz;
        const au = Math.abs(u), av = Math.abs(v);
        if (au >= ABUT && au <= f.countyEnd + 20 && av < COUNTY_HALF + 40) {
          const tEnd = u > 0 ? opT : opT2;
          let Hc: number;
          if (au <= ABUT + RAMP) Hc = lerp(f.deckY, tEnd, smoothstep(0, 1, (au - ABUT) / RAMP));
          else Hc = lerp(tEnd, naturalTerrain(op.x + op.ux * u, op.z + op.uz * u, seed), smoothstep(0, 60, au - ABUT - RAMP));
          if (av <= COUNTY_HALF && au <= f.countyEnd) { H = Hc; C = SURF.COUNTY; }
          else {
            const r = av - COUNTY_HALF;
            const He = Hc + clamp(H - Hc, -r * 0.55, r * 0.55);
            if (Hc > H) { H = He; C = r < 2 ? SURF.GRAVEL : SURF.GRASS; }
            else if (r < 3) { H = He; }
          }
        }
      }
      // test pad and its apron (at grade with the inside shoulder)
      {
        const rx = x - pd.x, rz = z - pd.z;
        const a = rx * pd.ax + rz * pd.az, b = rx * pd.bx + rz * pd.bz;
        const inA = a >= pd.a0 && a <= pd.a1, inB = b >= pd.b0 && b <= pd.b1;
        if (inA && inB) { H = pd.y; C = SURF.PAD; }
        else if (b > XS.outerShoulder && b < pd.b0 && Math.abs(a) < 70) {
          const sH = track.heightAt(track.padS + a, track.insideSign * XS.outerShoulder);
          H = lerp(sH, pd.y, (b - XS.outerShoulder) / (pd.b0 - XS.outerShoulder)); C = SURF.PAD;
        } else {
          // blend the surroundings down to the pad level
          const da = Math.max(pd.a0 - a, 0, a - pd.a1), db = Math.max(pd.b0 - b, 0, b - pd.b1);
          const r = Math.hypot(da, db);
          if (r < 40 && b > XS.verge + 2) { const reach = r * 0.4; H = pd.y + clamp(H - pd.y, -reach, reach); if (r < 3) C = SURF.GRAVEL; }
        }
      }
      heights[k] = H;
      classes[k] = C;
      near[k] = dist < Infinity ? Math.abs(dArr[k]) : Infinity;
    }
  }

  const g: Ground = {
    nx, nz, minX, minZ, cell, heights, classes, near,
    heightAt(x: number, z: number) {
      const fx = (x - minX) / cell, fz = (z - minZ) / cell;
      const i = clamp(Math.floor(fx), 0, nx - 2), j = clamp(Math.floor(fz), 0, nz - 2);
      const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
      const k = j * nx + i;
      return lerp(lerp(heights[k], heights[k + 1], tx), lerp(heights[k + nx], heights[k + nx + 1], tx), tz);
    },
    classAt(x: number, z: number) {
      const i = clamp(Math.round((x - minX) / cell), 0, nx - 1), j = clamp(Math.round((z - minZ) / cell), 0, nz - 1);
      return classes[j * nx + i];
    },
  };
  return g;
}
