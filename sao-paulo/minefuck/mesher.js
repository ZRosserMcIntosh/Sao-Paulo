// Chunk meshing, a port of ChunkMeshBuilder.java: faces only where a block meets a transparent
// one, per-vertex ambient occlusion, and separate opaque/cutout and translucent parts.
// Vertex: x, y, z, u, v, light (6 floats).
import { CS, CH } from './world.js';
import { LAYERS, OPAQUE, TRANSLUCENT, texture, isEmissive } from './blocks.js';
import { u0, v0, GRID, SIZE } from './atlas.js';

const P = CS + 2;
const CORNERS = [
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
];
const NORMALS = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [-1, 0, 0], [1, 0, 0]];
const SHADE = [1.0, 0.5, 0.8, 0.8, 0.65, 0.65];
const AO = [0.45, 0.65, 0.83, 1.0];
const INSET = 0.02 / SIZE, SPAN = 1 / GRID - 2 * INSET;

class Floats {
  constructor(n) { this.a = new Float32Array(n); this.n = 0; }
  push6(a, b, c, d, e, f) {
    if (this.n + 6 > this.a.length) { const g = new Float32Array(this.a.length * 2); g.set(this.a); this.a = g; }
    const A = this.a; let n = this.n;
    A[n++] = a; A[n++] = b; A[n++] = c; A[n++] = d; A[n++] = e; A[n++] = f;
    this.n = n;
  }
  array() { return this.a.subarray(0, this.n); }
}

/** Builds a chunk's mesh, or returns null if a neighbour isn't loaded yet. */
export function buildMesh(world, chunk) {
  const nb = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const c = dx === 0 && dz === 0 ? chunk : world.chunk(chunk.cx + dx, chunk.cz + dz);
    if (!c) return null;
    nb.push(c);
  }
  const top = Math.min(CH, Math.max(...nb.map((c) => c.top)) + 1);
  const H = top + 1;
  const pad = new Uint8Array(P * P * H);
  for (let px = 0; px < P; px++) for (let pz = 0; pz < P; pz++) {
    const lx = px - 1, lz = pz - 1;
    const ix = lx < 0 ? 0 : lx >= CS ? 2 : 1, iz = lz < 0 ? 0 : lz >= CS ? 2 : 1;
    const src = nb[ix * 3 + iz], sx = (lx + CS) % CS, sz = (lz + CS) % CS;
    const o = (sx * CS + sz) * CH;
    pad.set(src.blocks.subarray(o, o + Math.min(H, CH)), (px * P + pz) * H);
  }
  const opaque = new Floats(1 << 15), trans = new Floats(1 << 10);
  const wx = chunk.cx * CS, wz = chunk.cz * CS;
  const occ = (px, y, pz) => y >= 0 && y < H && px >= 0 && px < P && pz >= 0 && pz < P && LAYERS[pad[(px * P + pz) * H + y]] === OPAQUE;
  const light = [0, 0, 0, 0];
  for (let x = 0; x < CS; x++) for (let z = 0; z < CS; z++) {
    const base = ((x + 1) * P + (z + 1)) * H;
    for (let y = 0; y < top; y++) {
      const b = pad[base + y];
      if (!b) continue;
      const lay = LAYERS[b];
      for (let f = 0; f < 6; f++) {
        const n = NORMALS[f], ny = y + n[1];
        const nbk = ny < 0 || ny >= H ? 0 : pad[((x + 1 + n[0]) * P + (z + 1 + n[2])) * H + ny];
        if (nbk && (LAYERS[nbk] === OPAQUE || nbk === b)) continue;
        const out = lay === TRANSLUCENT ? trans : opaque;
        const tile = texture(b, f), tu = u0(tile) + INSET, tv = v0(tile) + INSET;
        const axis = n[0] ? 0 : n[1] ? 1 : 2, t1 = axis === 0 ? 1 : 0, t2 = axis === 2 ? 1 : 2;
        const emissive = isEmissive(b);
        for (let i = 0; i < 4; i++) {
          const cc = CORNERS[f][i];
          const p0 = [x + 1 + n[0], y + n[1], z + 1 + n[2]];
          const o1 = cc[t1] ? 1 : -1, o2 = cc[t2] ? 1 : -1;
          const s1 = p0.slice(), s2 = p0.slice(), cn = p0.slice();
          s1[t1] += o1; s2[t2] += o2; cn[t1] += o1; cn[t2] += o2;
          const a = occ(s1[0], s1[1], s1[2]), bb = occ(s2[0], s2[1], s2[2]), d = occ(cn[0], cn[1], cn[2]);
          const ao = a && bb ? 0 : 3 - (a + bb + d);
          light[i] = emissive ? 2 : SHADE[f] * AO[ao];
        }
        const order = light[0] + light[2] >= light[1] + light[3] ? [0, 1, 2, 0, 2, 3] : [1, 2, 3, 1, 3, 0];
        for (const i of order) {
          const cc = CORNERS[f][i];
          let u, v;
          switch (f) {
            case 0: u = cc[0]; v = cc[2]; break;
            case 1: u = cc[0]; v = 1 - cc[2]; break;
            case 2: u = cc[0]; v = 1 - cc[1]; break;
            case 3: u = 1 - cc[0]; v = 1 - cc[1]; break;
            case 4: u = cc[2]; v = 1 - cc[1]; break;
            default: u = 1 - cc[2]; v = 1 - cc[1];
          }
          out.push6(wx + x + cc[0], y + cc[1], wz + z + cc[2], tu + u * SPAN, tv + v * SPAN, light[i]);
        }
      }
    }
  }
  return { opaque: opaque.array(), translucent: trans.array() };
}
