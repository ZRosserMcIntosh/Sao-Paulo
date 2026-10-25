// The block world: chunk storage and loading, the São Paulo data (SaoPauloWorld.java) and the
// procedural terrain beyond it (WorldGenerator.java), and voxel raycasting.
import { B, isSolid } from './blocks.js';

export const CS = 16, CH = 256;
const RING = { ROAD: 0, CENTRE: 1, SIDEWALK: 2, BUILDING: 3, TREE: 4, LAWN: 5, CICLOVIA: 6, PAVED: 7, CLAY: 8, PARK: 9, KERB: 10 };
const FACADES = [B.FACADE_WHITE, B.FACADE_GRAY, B.STUCCO_CREAM, B.BRICK, B.FACADE_DARK, B.STUCCO_PEACH, B.STUCCO_OCHRE, B.CONCRETE];

async function gunzip(url, progress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ': ' + r.status);
  const total = +r.headers.get('content-length') || 0;
  let got = 0;
  const counted = r.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) { got += chunk.length; progress?.(total ? got / total : 0); ctl.enqueue(chunk); },
  }));
  return new Uint8Array(await new Response(counted.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/** São Paulo around MASP: the voxelized tile plus the column-map ring around it. */
export class SaoPaulo {
  async load(base, progress) {
    const [m, r] = await Promise.all([
      gunzip(new URL('worlds/masp.mfw', base), (f) => progress?.(0, f)),
      gunzip(new URL('worlds/ring.mfr', base), (f) => progress?.(1, f)),
    ]);
    let dv = new DataView(m.buffer);
    if (dv.getUint32(0, true) !== 0x3157464d) throw new Error('bad masp.mfw');
    this.mx0 = dv.getInt32(4, true); this.mz0 = dv.getInt32(8, true);
    this.mnx = dv.getInt32(12, true); this.mnz = dv.getInt32(16, true);
    this.spawn = { x: dv.getFloat32(24, true), y: dv.getFloat32(28, true), z: dv.getFloat32(32, true), yaw: dv.getFloat32(36, true) };
    this.runway = { x: dv.getFloat32(40, true), z: dv.getFloat32(44, true), yaw: dv.getFloat32(48, true) };
    // run-length columns: keep offsets into the buffer
    this.masp = m;
    this.cols = new Uint32Array(this.mnx * this.mnz);
    let p = 64;
    for (let i = 0; i < this.cols.length; i++) {
      this.cols[i] = p;
      p += 2 + (m[p] | (m[p + 1] << 8)) * 2;
    }
    dv = new DataView(r.buffer);
    if (dv.getUint32(0, true) !== 0x3152464d) throw new Error('bad ring.mfr');
    this.rx0 = dv.getInt32(4, true); this.rz0 = dv.getInt32(8, true);
    this.rnx = dv.getInt32(12, true); this.rnz = dv.getInt32(16, true);
    this.ring = r.subarray(24);
    this.loaded = true;
  }
  inMasp(x, z) { return this.loaded && x >= this.mx0 && x < this.mx0 + this.mnx && z >= this.mz0 && z < this.mz0 + this.mnz; }
  inRing(x, z) { return this.loaded && x >= this.rx0 && x < this.rx0 + this.rnx && z >= this.rz0 && z < this.rz0 + this.rnz; }
  distanceOutside(x, z) {
    const dx = Math.max(0, this.rx0 - x, x - (this.rx0 + this.rnx - 1));
    const dz = Math.max(0, this.rz0 - z, z - (this.rz0 + this.rnz - 1));
    return Math.hypot(dx, dz);
  }
  edgeGround(x, z) {
    const cx = Math.max(this.rx0, Math.min(this.rx0 + this.rnx - 1, x));
    const cz = Math.max(this.rz0, Math.min(this.rz0 + this.rnz - 1, z));
    return this.ring[((cx - this.rx0) * this.rnz + (cz - this.rz0)) * 3];
  }
  /** Fills column (x, z) into col (cleared first). Only for inMasp || inRing. */
  fillColumn(x, z, col) {
    col.fill(0);
    if (this.inMasp(x, z)) {
      const m = this.masp;
      let p = this.cols[(x - this.mx0) * this.mnz + (z - this.mz0)];
      const runs = m[p] | (m[p + 1] << 8);
      p += 2;
      let y = 0;
      for (let i = 0; i < runs; i++, p += 2) {
        const b = m[p], n = m[p + 1];
        if (b) col.fill(b, y, Math.min(CH, y + n));
        y += n;
      }
      return;
    }
    this.fillRing(x, z, col);
  }
  ri(x, z) { return ((x - this.rx0) * this.rnz + (z - this.rz0)) * 3; }
  roofY(x, z) {
    if (!this.inRing(x, z) || this.inMasp(x, z)) return -1;
    const i = this.ri(x, z), c = this.ring[i + 1] & 15;
    if (c !== RING.BUILDING && c !== RING.CLAY) return -1;
    return this.ring[i] + this.ring[i + 2];
  }
  fillRing(x, z, col) {
    const i = this.ri(x, z), g = this.ring[i], c = this.ring[i + 1] & 15, style = this.ring[i + 1] >> 4, h = this.ring[i + 2];
    let top;
    switch (c) {
      case RING.ROAD: top = B.ASPHALT; break;
      case RING.CENTRE: top = Math.floor((x + z) / 3) % 2 === 0 ? B.PAINT_YELLOW : B.ASPHALT; break;
      case RING.SIDEWALK: top = style % 3 === 0 ? B.PORTUGUESE : B.SIDEWALK; break;
      case RING.KERB: top = B.CURB; break;
      case RING.CICLOVIA: top = B.CICLOVIA; break;
      case RING.LAWN: case RING.TREE: top = B.GRASS; break;
      case RING.PARK: top = B.PARK_FLOOR; break;
      case RING.PAVED: top = hash(Math.floor(x / 6), Math.floor(z / 6), 3) % 3 === 0 ? B.PAVER : B.SIDEWALK; break;
      default: top = B.SIDEWALK;
    }
    col[0] = B.BEDROCK;
    const soft = top === B.GRASS || top === B.PARK_FLOOR;
    for (let y = 1; y <= g; y++) col[y] = y === g ? top : y > g - 4 ? (soft ? B.DIRT : B.GRAVEL) : B.STONE;
    if (c === RING.TREE && h > 0) {
      const base = g + 3 + hash(Math.floor(x / 3), Math.floor(z / 3), 4) % 2, crown = g + h;
      const trunk = hash(x, z, 5) % 11 === 0;
      for (let y = g + 1; y <= crown && y < CH; y++) {
        if (trunk && y < crown) col[y] = B.WOOD;
        else if (y >= base && hash(x, z, y) % 7 !== 0) col[y] = B.LEAVES;
      }
      return;
    }
    if ((c === RING.BUILDING || c === RING.CLAY) && h > 0) {
      const roof = Math.min(CH - 1, g + h);
      const wallX = this.roofY(x - 1, z) < roof || this.roofY(x + 1, z) < roof;
      const wallZ = this.roofY(x, z - 1) < roof || this.roofY(x, z + 1) < roof;
      const facade = c === RING.CLAY ? B.STUCCO_CREAM : FACADES[style & 7];
      const curtain = facade === B.FACADE_DARK || ((style & 8) !== 0 && h > 30);
      const along = wallX ? z : x;
      const am = (n) => ((along % n) + n) % n;
      for (let y = g + 1; y <= roof; y++) {
        const f = y - g - 1;
        if (y === roof) col[y] = c === RING.CLAY ? B.CLAY_ROOF : B.ROOF;
        else if (wallX || wallZ) {
          const row = f % 3;
          let win;
          if (f < 3) win = row !== 0 && am(4) !== 0;
          else if (curtain) win = row !== 0 || am(5) !== 0;
          else win = row === 1 && am(3) !== 0;
          col[y] = win ? B.WINDOW : facade;
        } else if (f % 3 === 0 && f > 0) col[y] = B.FLOOR;
      }
    }
  }
}

function hash(x, z, s) {
  let n = Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ Math.imul(s, 83492791);
  n ^= n >>> 13;
  n = Math.imul(n, 0x5bd1e995);
  return (n ^ (n >>> 15)) & 0x7fffffff;
}

// ------------------------------------------------------------------ procedural terrain

class Perlin {
  constructor(seed) {
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 4294967296;
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    this.p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.p[i] = p[i & 255];
  }
  noise(x, y) {
    const P = this.p, X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = P[X] + Y, B2 = P[X + 1] + Y;
    return lerp(v, lerp(u, grad(P[P[A]], x, y), grad(P[P[B2]], x - 1, y)),
      lerp(u, grad(P[P[A + 1]], x, y - 1), grad(P[P[B2 + 1]], x - 1, y - 1)));
  }
  octave(x, y, oct, pers) {
    let t = 0, f = 1, a = 1, m = 0;
    for (let i = 0; i < oct; i++) { t += this.noise(x * f, y * f) * a; m += a; a *= pers; f *= 2; }
    return t / m;
  }
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t, a, b) => a + t * (b - a);
function grad(hh, x, y) {
  const h = hh & 15, u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : 0;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

const SEA_LEVEL = 62, CITY_BLEND = 220;

export class Generator {
  constructor(seed, sp) {
    this.sp = sp;
    this.height = new Perlin(seed); this.detail = new Perlin(seed + 1); this.biome = new Perlin(seed + 3);
    this.seed = seed;
  }
  generate(chunk) {
    const col = new Uint8Array(CH), sp = this.sp, wx0 = chunk.cx * CS, wz0 = chunk.cz * CS;
    for (let x = 0; x < CS; x++) for (let z = 0; z < CS; z++) {
      const wx = wx0 + x, wz = wz0 + z;
      if (sp.inMasp(wx, wz) || sp.inRing(wx, wz)) sp.fillColumn(wx, wz, col);
      else this.wild(wx, wz, col);
      chunk.blocks.set(col, (x * CS + z) * CH);
    }
    this.trees(chunk);
    chunk.updateTop();
  }
  wild(wx, wz, col) {
    col.fill(0);
    const biome = this.biome.octave(wx * 0.005, wz * 0.005, 3, 0.5);
    const base = this.height.octave(wx * 0.01, wz * 0.01, 6, 0.5), det = this.detail.octave(wx * 0.05, wz * 0.05, 4, 0.5);
    let height = Math.floor(64 + base * (20 + biome * 15) + det * 4);
    const dist = this.sp.loaded ? this.sp.distanceOutside(wx, wz) : Infinity;
    const sea = dist < CITY_BLEND * 2 ? 0 : SEA_LEVEL;
    if (dist < CITY_BLEND) {
      let t = dist / CITY_BLEND; t = t * t * (3 - 2 * t);
      height = Math.round(this.sp.edgeGround(wx, wz) * (1 - t) + height * t);
    }
    height = Math.max(1, Math.min(height, CH - 2));
    const desert = biome > 0.4, snowy = biome < -0.4 && height > 75;
    const surf = desert ? B.SAND : snowy ? B.SNOW : height <= sea + 1 ? B.SAND : B.GRASS;
    const sub = desert ? B.SAND : B.DIRT;
    col[0] = B.BEDROCK;
    for (let y = 1; y < CH; y++) {
      if (y < height - 4) col[y] = B.STONE;
      else if (y < height) col[y] = sub;
      else if (y === height) col[y] = surf;
      else if (y <= sea) col[y] = B.WATER;
      else break;
    }
  }
  trees(chunk) {
    let s = (Math.imul(chunk.cx, 341873128) ^ Math.imul(chunk.cz, 132897987) ^ this.seed) >>> 0;
    const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 4294967296;
    const n = 3 + Math.floor(rnd() * 4);
    for (let t = 0; t < n; t++) {
      const tx = 2 + Math.floor(rnd() * 12), tz = 2 + Math.floor(rnd() * 12);
      const wx = chunk.cx * CS + tx, wz = chunk.cz * CS + tz;
      if (this.sp.inRing(wx, wz) || this.sp.inMasp(wx, wz)) continue;
      let gy = -1;
      for (let y = CH - 1; y > 1; y--) { const b = chunk.get(tx, y, tz); if (b === B.GRASS) { gy = y; break; } if (b) break; }
      if (gy < 0) continue;
      const top = gy + 4 + Math.floor(rnd() * 3);
      for (let y = gy + 1; y <= top; y++) chunk.set(tx, y, tz, B.WOOD);
      for (let ly = top - 2; ly <= top + 1; ly++) {
        const r = ly === top + 1 ? 1 : 2;
        for (let lx = -r; lx <= r; lx++) for (let lz = -r; lz <= r; lz++) {
          if (lx === 0 && lz === 0 && ly <= top) continue;
          if (Math.abs(lx) === r && Math.abs(lz) === r && rnd() < 0.5) continue;
          const px = tx + lx, pz = tz + lz;
          if (px >= 0 && px < CS && pz >= 0 && pz < CS && !chunk.get(px, ly, pz)) chunk.set(px, ly, pz, B.LEAVES);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ chunks and the world

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx; this.cz = cz;
    this.blocks = new Uint8Array(CS * CS * CH);
    this.top = 0;          // highest non-air y + 1, bounds the meshing loop
    this.mod = 1;          // bumps on every change; the mesh remembers what it was built from
    this.meshedMod = 0;
    this.mesh = null;
  }
  get(x, y, z) { return this.blocks[(x * CS + z) * CH + y]; }
  set(x, y, z, b) {
    this.blocks[(x * CS + z) * CH + y] = b;
    if (b && y + 1 > this.top) this.top = y + 1;
    this.mod++;
  }
  updateTop() {
    let t = 0;
    for (let i = 0; i < CS * CS; i++) {
      const base = i * CH;
      for (let y = CH - 1; y > t; y--) if (this.blocks[base + y]) { t = y; break; }
    }
    this.top = t + 1;
  }
  get dirty() { return this.mod !== this.meshedMod; }
}

export class World {
  constructor(sp, seed = 42) {
    this.sp = sp;
    this.gen = new Generator(seed, sp);
    this.chunks = new Map();
    this.renderDistance = 10;
  }
  key(cx, cz) { return cx * 65536 + cz; }
  chunk(cx, cz) { return this.chunks.get(this.key(cx, cz)); }
  getBlock(x, y, z) {
    if (y < 0 || y >= CH) return B.AIR;
    const c = this.chunks.get(this.key(Math.floor(x / CS), Math.floor(z / CS)));
    if (!c) return B.AIR;
    return c.blocks[(((x % CS) + CS) % CS * CS + ((z % CS) + CS) % CS) * CH + y];
  }
  isLoaded(x, z) { return this.chunks.has(this.key(Math.floor(x / CS), Math.floor(z / CS))); }
  setBlock(x, y, z, b) {
    if (y < 0 || y >= CH) return;
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS), c = this.chunk(cx, cz);
    if (!c) return;
    const lx = ((x % CS) + CS) % CS, lz = ((z % CS) + CS) % CS;
    c.set(lx, y, lz, b);
    if (lx === 0) this.touch(cx - 1, cz);
    if (lx === CS - 1) this.touch(cx + 1, cz);
    if (lz === 0) this.touch(cx, cz - 1);
    if (lz === CS - 1) this.touch(cx, cz + 1);
  }
  touch(cx, cz) { const c = this.chunk(cx, cz); if (c) c.mod++; }
  surfaceBelow(x, z, fromY) {
    for (let y = Math.min(fromY, CH - 1); y >= 0; y--) if (isSolid(this.getBlock(x, y, z))) return y;
    return -1;
  }
  /** Generates the nearest missing chunks within budget (ms) and drops far ones. */
  update(px, pz, budgetMs) {
    const ccx = Math.floor(px / CS), ccz = Math.floor(pz / CS), load = this.renderDistance + 2;
    const t0 = performance.now();
    if (!this.order || this.order.r !== load) {
      this.order = [];
      for (let dx = -load; dx <= load; dx++) for (let dz = -load; dz <= load; dz++) {
        if (dx * dx + dz * dz <= load * load) this.order.push([dx, dz, dx * dx + dz * dz]);
      }
      this.order.sort((a, b) => a[2] - b[2]);
      this.order.r = load;
    }
    for (const [dx, dz] of this.order) {
      const cx = ccx + dx, cz = ccz + dz, k = this.key(cx, cz);
      if (this.chunks.has(k)) continue;
      const c = new Chunk(cx, cz);
      this.gen.generate(c);
      this.chunks.set(k, c);
      this.touch(cx - 1, cz); this.touch(cx + 1, cz); this.touch(cx, cz - 1); this.touch(cx, cz + 1);
      if (performance.now() - t0 > budgetMs) break;
    }
    const far = (load + 2) * (load + 2);
    for (const [k, c] of this.chunks) {
      const dx = c.cx - ccx, dz = c.cz - ccz;
      if (dx * dx + dz * dz > far) { this.onUnload?.(c); this.chunks.delete(k); }
    }
  }
  /** Exact voxel traversal: {x, y, z, face, px, py, pz} of the first non-air, non-water block. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity, tdz = dz ? Math.abs(1 / dz) : Infinity;
    let tx = dx ? (dx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
    let ty = dy ? (dy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
    let tz = dz ? (dz > 0 ? z + 1 - oz : oz - z) * tdz : Infinity;
    let px = x, py = y, pz = z, face = 0, t = 0, first = true;
    while (t <= maxDist) {
      const b = this.getBlock(x, y, z);
      if (!first && b !== B.AIR && b !== B.WATER) return { x, y, z, face, px, py, pz, block: b };
      first = false;
      px = x; py = y; pz = z;
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; face = sx > 0 ? 4 : 5; }
      else if (ty < tz) { y += sy; t = ty; ty += tdy; face = sy > 0 ? 1 : 0; }
      else { z += sz; t = tz; tz += tdz; face = sz > 0 ? 2 : 3; }
    }
    return null;
  }
}
