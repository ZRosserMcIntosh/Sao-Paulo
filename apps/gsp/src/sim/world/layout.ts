// Where things stand: guardrails, the median barrier, signs, billboards, cones and drums, trees.
// Pure data from the track, the ground and a seed (deterministic); physics and rendering both
// build from it.
import { Rng, clamp } from '../math';
import { Track, XS, laneCenterOffset } from './track';
import type { Features, Ground } from './terrain';
import { SURF } from './terrain';

export interface RailRun { kind: 'guardrail' | 'barrier'; pts: { x: number; y: number; z: number }[]; side: number }
export interface SignSpot { type: string; x: number; z: number; y: number; heading: number; legend: string; style: SignStyle }
export type SignStyle = 'speed' | 'warning' | 'guide' | 'info' | 'welcome' | 'marker';
export interface Billboard { x: number; z: number; y: number; heading: number; text: string; sub: string; color: string }
export interface PropSpot { kind: 'cone' | 'drum' | 'barricade'; x: number; z: number; y: number; heading: number }
export interface Tree { x: number; y: number; z: number; h: number; r: number; tint: number; kind: 0 | 1 }

export interface Layout {
  rails: RailRun[];
  signs: SignSpot[];
  billboards: Billboard[];
  props: PropSpot[];
  trees: Tree[];
  lights: { x: number; y: number; z: number; heading: number }[];
}

export function buildLayout(track: Track, ground: Ground, f: Features, seed: number, treeDensity = 1): Layout {
  const rng = new Rng(seed ^ 0x5eed);
  const rails: RailRun[] = [];
  const L = track.length;
  const inPad = (s: number, side: number) => side === track.insideSign && Math.abs(track.wrapDelta(s - track.padS)) < 80;
  const nearOverpass = (s: number) => Math.abs(track.wrapDelta(s - track.overpassS)) < 140;

  // Guardrails on the outer verge: high fills, the outside of curves, around the overpass.
  for (const side of [1, -1]) {
    let run: RailRun | null = null;
    const d = side * (XS.outerShoulder + 0.9);
    for (let s = 0; s < L; s += 4) {
      const c = track.sampleAt(s);
      const edgeY = track.heightAt(s, side * XS.verge, c);
      const fx = c.x + c.rx * side * 40, fz = c.z + c.rz * side * 40;
      const fill = edgeY - ground.heightAt(fx, fz);
      const outside = Math.sign(c.k) === side && Math.abs(c.k) > 1 / 900; // left turn (k > 0): outside is the right (+1)
      const want = !inPad(s, side) && (fill > 2.2 || outside || nearOverpass(s) || Math.abs(fill) > 4.5);
      if (want) {
        if (!run) rails.push((run = { kind: 'guardrail', pts: [], side }));
        const x = c.x + c.rx * d, z = c.z + c.rz * d;
        run.pts.push({ x, z, y: track.heightAt(s, d, c) });
      } else run = null;
    }
  }
  // join the run that crosses s = 0
  // Median barrier through the interchange (urban section)
  {
    const pts = [];
    for (let s = track.overpassS - 448; s <= track.overpassS + 448; s += 4) {
      const c = track.sampleAt(s);
      pts.push({ x: c.x, z: c.z, y: c.y });
    }
    rails.push({ kind: 'barrier', pts, side: 0 });
  }
  // County road: guardrails along both edges of the ramps
  {
    const op = f.overpass;
    for (const sgn of [1, -1]) for (const vs of [1, -1]) {
      const pts = [];
      for (let u = 32; u <= 31 + 160; u += 4) {
        const x = op.x + op.ux * u * sgn + op.vx * vs * (op.halfWidth + 0.3), z = op.z + op.uz * u * sgn + op.vz * vs * (op.halfWidth + 0.3);
        pts.push({ x, z, y: ground.heightAt(x - op.vx * vs * 0.6, z - op.vz * vs * 0.6) });
      }
      rails.push({ kind: 'guardrail', pts, side: 0 });
    }
  }

  // Signs: breakaway posts (Street Dynamics) on the outer verge.
  const signs: SignSpot[] = [];
  const signAt = (s: number, side: number, type: string, legend: string, style: SignStyle, dOff = 0) => {
    const c = track.sampleAt(s);
    const d = side * (XS.outerShoulder + 2.0 + dOff);
    const x = c.x + c.rx * d, z = c.z + c.rz * d;
    // facing oncoming traffic: on the right carriageway (+1) traffic runs +s, so the sign faces -tangent
    const fx = -c.tx * side, fz = -c.tz * side;
    signs.push({ type, x, z, y: ground.heightAt(x, z), heading: Math.atan2(-fz, fx), legend, style });
  };
  const legends = ['SPEED LIMIT|70', 'SPEED LIMIT|70', 'TRUCKS|55', 'MINIMUM|40'];
  for (const side of [1, -1]) {
    for (let s = 300, k = 0; s < L - 100; s += 760, ++k) {
      if (inPad(s, side) || nearOverpass(s)) continue;
      signAt(s, side, 'gsp_speed', legends[k % legends.length], 'speed');
    }
    // curve warnings ahead of the sharper bends
    for (let s = 0; s < L; s += 40) {
      const ahead = side > 0 ? s + 260 : s - 260;
      const k = track.sampleAt(ahead).k;
      if (Math.abs(k) > 1 / 520 && Math.abs(track.sampleAt(s).k) < 1 / 1500 && !inPad(s, side)) {
        signAt(s, side, 'gsp_warning', (k > 0) === (side > 0) ? 'CURVE|LEFT' : 'CURVE|RIGHT', 'warning');
        s += 500;
      }
    }
    // mile markers
    for (let s = 100; s < L; s += 402) if (!inPad(s, side) && !nearOverpass(s)) signAt(s, side, 'gsp_marker', String(Math.round(s / 1609 * 10) / 10 + 237), 'marker', 1.2);
  }
  const quips = [
    'MOVE OVER|IT\'S THE LAW', 'EXIT 1337|BOILED PEANUTS', 'ALABAMA|NOT THIS WAY', 'BUCKLE UP|Y\'ALL',
    'FINES DOUBLE|WHEN WE\'RE BORED', 'EXIT 42|WAFFLE SHOP', 'PEACH PASS|LANE ENDS', 'DON\'T TEXT|AND DRIVE',
  ];
  for (let s = 650, k = 0; s < L - 200; s += 980, ++k) {
    const side = k % 2 ? -1 : 1;
    if (inPad(s, side) || nearOverpass(s)) continue;
    signAt(s, side, 'gsp_guide', quips[k % quips.length], k % 3 === 1 ? 'info' : 'guide', 0.6);
  }
  signAt(track.wrap(track.overpassS - 700), 1, 'gsp_welcome', 'WELCOME TO|GEORGIA', 'welcome', 1.2);

  // Billboards well off the road
  const billboards: Billboard[] = [];
  const bb = [
    ['RICK\'S BAIL BONDS', 'You run, we post. 24/7.', '#c0392b'],
    ['PEACH STATE INSURANCE', 'Adjusters on call. Sigh.', '#e67e22'],
    ['BOILED PEANUTS', 'Next exit · Cash only', '#8e6b3a'],
    ['DIAL 1-800-PIT-STOP', 'Body shop · Ask for Earl', '#2c3e50'],
    ['VIDALIA ONIONS', 'Sweet as your mama', '#27ae60'],
    ['GSP RECRUITING', 'Drive fast. Fill out forms.', '#1f3a7a'],
  ];
  for (let k = 0, s = 420; s < L; s += L / 6, ++k) {
    const side = k % 2 ? track.insideSign : -track.insideSign;
    if (inPad(s, side) || nearOverpass(s)) continue;
    const c = track.sampleAt(s);
    const d = side * 48;
    const x = c.x + c.rx * d, z = c.z + c.rz * d;
    // face the road, angled toward oncoming traffic on the near carriageway
    const fx = -c.rx * side - c.tx * side * 0.5, fz = -c.rz * side - c.tz * side * 0.5;
    billboards.push({ x, z, y: ground.heightAt(x, z), heading: Math.atan2(-fz, fx), text: bb[k % bb.length][0], sub: bb[k % bb.length][1], color: bb[k % bb.length][2] });
  }

  // Props: the pad's slalom and skid-pad cones, a work zone on the outer carriageway, barricades at
  // the county road's ends.
  const props: PropSpot[] = [];
  const pd = f.pad;
  const padPt = (a: number, b: number) => ({ x: pd.x + pd.ax * a + pd.bx * b, z: pd.z + pd.az * a + pd.bz * b });
  for (let k = 0; k < 10; ++k) { const p = padPt(-120 + k * 18, 70); props.push({ kind: 'cone', ...p, y: pd.y, heading: 0 }); }
  for (let k = 0; k < 16; ++k) {
    const a = (k / 16) * Math.PI * 2;
    const p = padPt(80 + Math.cos(a) * 30, 165 + Math.sin(a) * 30);
    props.push({ kind: 'cone', ...p, y: pd.y, heading: 0 });
  }
  for (let k = 0; k < 6; ++k) { const p = padPt(-60 + k * 2.2, 200); props.push({ kind: 'drum', ...p, y: pd.y, heading: 0 }); }
  // work zone: a lane-3 taper with drums and cones, on the carriageway opposite the pad
  {
    const side = -track.insideSign;
    const s0 = track.wrap(track.padS + 900 * side);
    for (let k = 0; k < 26; ++k) {
      const s = s0 + side * k * 9;
      const lane = clamp(laneCenterOffset(2) - 1.6 + Math.min(1, k / 8) * 1.6, 0, 30);
      const c = track.sampleAt(s);
      const d = side * (lane - 1.5);
      const x = c.x + c.rx * d, z = c.z + c.rz * d;
      props.push({ kind: k % 2 ? 'cone' : 'drum', x, z, y: track.heightAt(s, d, c), heading: 0 });
    }
  }
  {
    const op = f.overpass;
    for (const sgn of [1, -1]) for (let k = -2; k <= 2; ++k) {
      const u = f.countyEnd * sgn;
      const x = op.x + op.ux * u + op.vx * k * 2.2, z = op.z + op.uz * u + op.vz * k * 2.2;
      props.push({ kind: 'barricade', x, z, y: ground.heightAt(x, z), heading: Math.atan2(-op.vz, op.vx) });
    }
  }

  // Pines (loblolly), denser away from the road; a few hardwoods.
  const trees: Tree[] = [];
  const area = (ground.nx * ground.cell) * (ground.nz * ground.cell);
  const target = Math.floor((area / 900) * treeDensity);
  const op = f.overpass;
  let tries = 0;
  while (trees.length < target && tries < target * 6) {
    ++tries;
    const x = ground.minX + rng.next() * (ground.nx - 1) * ground.cell;
    const z = ground.minZ + rng.next() * (ground.nz - 1) * ground.cell;
    const i = Math.round((x - ground.minX) / ground.cell), j = Math.round((z - ground.minZ) / ground.cell);
    const k = j * ground.nx + i;
    const near = ground.near[k];
    if (near < 42) continue;
    const cls = ground.classes[k];
    if (cls === SURF.PAD || cls === SURF.COUNTY || cls === SURF.GRAVEL) continue;
    // keep the county road corridor and the pad surroundings clear
    const ru = (x - op.x) * op.ux + (z - op.z) * op.uz, rv = (x - op.x) * op.vx + (z - op.z) * op.vz;
    if (Math.abs(rv) < 18 && Math.abs(ru) < f.countyEnd + 30) continue;
    const pa = (x - pd.x) * pd.ax + (z - pd.z) * pd.az, pb = (x - pd.x) * pd.bx + (z - pd.z) * pd.bz;
    if (pa > pd.a0 - 25 && pa < pd.a1 + 25 && pb > 0 && pb < pd.b1 + 25) continue;
    // clumps: thin out by noise
    const clump = Math.sin(x * 0.011 + seed) * Math.cos(z * 0.013 - seed * 0.5);
    if (clump < -0.35 && rng.chance(0.75)) continue;
    if (near < 70 && rng.chance(0.5)) continue;
    const h = rng.range(13, 26);
    trees.push({ x, z, y: ground.heights[k], h, r: h * rng.range(0.16, 0.24), tint: rng.next(), kind: rng.chance(0.88) ? 0 : 1 });
  }

  // Light poles along the interchange
  const lights = [];
  for (let s = track.overpassS - 420; s <= track.overpassS + 420; s += 60) {
    if (Math.abs(s - track.overpassS) < 40) continue;
    const c = track.sampleAt(s);
    lights.push({ x: c.x, z: c.z, y: c.y, heading: Math.atan2(-c.tz, c.tx) });
  }
  return { rails, signs, billboards, props, trees, lights };
}
