// São Paulo World · flight test bed: the buildings' worker (buildings.js).
// Off the main thread: fetch and inflate a tile, decode its AVB1 block, and
// build its walls and roofs into flat typed arrays, which go back to the page
// (transferred, not copied) to become a BufferGeometry there. The ground under
// each building comes from the flight core, which lives on the main thread:
// the worker asks for it (two points a building) between decoding and
// building.
//
// Messages in:  { t: 'tile', id, url, i, j } · { t: 'tall', id, url } ·
//               { t: 'heights', id, g: Float32Array } · { t: 'cancel', id }
// Messages out: { t: 'need', id, pts: Float64Array (x, y: centroid then first
//               corner, per building, site frame), bytes?, hMax, n } ·
//               { t: 'geo', id, geo } · { t: 'block', id, bi, bj, geo, tiles } ·
//               { t: 'done', id } · { t: 'fail', id, err }
import earcut from './earcut.js';

const TS = 1000;     // m, tile size (as the tiler's)
const TB = 4;        // tiles a side in a skyline block
// Building kinds (tiler): 0 unknown, 1 house, 2 apartments, 3 commercial, 4 industrial,
// 5 church, 6 school/hospital, 7 transport, 8 roof (canopy), 9 garage.
const TINTS = [
  [0.86, 0.84, 0.80], [0.88, 0.80, 0.70], [0.90, 0.89, 0.86], [0.74, 0.80, 0.86], [0.70, 0.71, 0.72],
  [0.93, 0.90, 0.80], [0.88, 0.86, 0.80], [0.78, 0.78, 0.76], [0.66, 0.67, 0.68], [0.72, 0.72, 0.70],
];
const LOW = [[0.90, 0.84, 0.74], [0.86, 0.72, 0.62], [0.93, 0.90, 0.82], [0.80, 0.82, 0.78], [0.88, 0.78, 0.66], [0.94, 0.92, 0.88]];
const MID = [[0.92, 0.91, 0.88], [0.88, 0.86, 0.80], [0.80, 0.80, 0.78], [0.86, 0.80, 0.72], [0.94, 0.93, 0.90]];
const HIGH = [[0.84, 0.85, 0.86], [0.92, 0.92, 0.90], [0.72, 0.78, 0.84], [0.80, 0.80, 0.80], [0.88, 0.86, 0.82]];
// Roofs. Flat: concrete slabs, tar, white membranes, fibre-cement and metal
// sheet. Pitched: São Paulo's clay tiles (telhas), new to weathered.
const FLAT = [[0.60, 0.60, 0.58], [0.48, 0.48, 0.47], [0.70, 0.69, 0.66], [0.38, 0.37, 0.36], [0.56, 0.58, 0.60], [0.80, 0.80, 0.78]];
const METAL = [[0.74, 0.76, 0.78], [0.66, 0.68, 0.70], [0.60, 0.52, 0.46]];
const TILE = [[0.70, 0.36, 0.24], [0.64, 0.32, 0.23], [0.76, 0.44, 0.30], [0.56, 0.36, 0.29], [0.68, 0.40, 0.30]];

// A tile file: gzipped at rest (inflated here), or already inflated by the server.
async function fetchTile(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const buf = await r.arrayBuffer();
  const b = new Uint8Array(buf, 0, 2);
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

// Decode an AVB1 block: [{ h, mh, kind, rings: [Float32Array of x, y pairs (m from the tile's SW corner)] }].
function decode(buf, off = 0) {
  const dv = new DataView(buf, off);
  if (dv.getUint32(0, true) !== 0x31425641) throw new Error('not an AVB1 block');  // "AVB1"
  const n = dv.getUint32(4, true), out = new Array(n);
  let p = 8;
  for (let k = 0; k < n; ++k) {
    const h = dv.getUint16(p, true) / 10, mh = dv.getUint16(p + 2, true) / 10, kind = dv.getUint8(p + 4), nr = dv.getUint8(p + 5);
    p += 6;
    const rings = [];
    for (let r = 0; r < nr; ++r) {
      const m = dv.getUint16(p, true); p += 2;
      const xy = new Float32Array(2 * m);
      for (let q = 0; q < 2 * m; ++q) { xy[q] = dv.getInt16(p, true) / 10; p += 2; }
      rings.push(xy);
    }
    out[k] = { h, mh, kind, rings };
  }
  return { list: out, bytes: p };
}

// Where the ground is wanted, per building: its centroid and its first corner (site frame).
function groundPoints(list, ox, oy, pts, at) {
  let hMax = 0;
  for (const b of list) {
    const o = b.rings[0], m = o.length / 2;
    let cx = 0, cy = 0;
    for (let i = 0; i < m; ++i) { cx += o[2 * i]; cy += o[2 * i + 1]; }
    if (m) { cx /= m; cy /= m; }
    pts[at++] = ox + cx; pts[at++] = oy + cy; pts[at++] = ox + (o[0] || 0); pts[at++] = oy + (o[1] || 0);
    hMax = Math.max(hMax, b.h);
  }
  return hMax;
}

// Signed area of a ring (x, y pairs): > 0 counter-clockwise.
function area(xy) {
  let a = 0;
  for (let i = 0, n = xy.length / 2; i < n; ++i) { const j = (i + 1) % n; a += xy[2 * i] * xy[2 * j + 1] - xy[2 * j] * xy[2 * i + 1]; }
  return a / 2;
}
// A hash in [0, 1) from a building's first corner (stable across reloads).
const hash = (x, y) => Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
const pick = (pal, h) => pal[Math.floor(h * 7919) % pal.length];

// Is the ring (4 corners) close to a rectangle a house could be? Its corners
// rotated so the first edge is the long one, else null.
function houseRect(xy) {
  if (xy.length !== 8) return null;
  const p = [0, 1, 2, 3].map((i) => [xy[2 * i], xy[2 * i + 1]]);
  for (let i = 0; i < 4; ++i) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
    if (Math.abs(cos) > 0.2) return null;  // not within ~12 deg of square
  }
  const l0 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), l1 = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]);
  const a = l0 * l1;
  if (a < 25 || a > 450 || Math.min(l0, l1) < 3.5 || Math.min(l0, l1) > 16) return null;
  return l0 >= l1 ? p : [p[1], p[2], p[3], p[0]];
}
// Is (x, y) inside the ring?
function inside(xy, x, y) {
  let c = false;
  for (let i = 0, n = xy.length / 2, j = n - 1; i < n; j = i++) {
    const xi = xy[2 * i], yi = xy[2 * i + 1], xj = xy[2 * j], yj = xy[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// A ring with the corners that bend it by less than `tol` m dropped (for the
// skyline, seen from kilometres away), the flattest first, never below four
// and never the first (it picks the building's colours).
function simplify(xy, tol) {
  const x = Array.from(xy.filter((_, i) => i % 2 === 0)), y = Array.from(xy.filter((_, i) => i % 2 === 1));
  const dev = (i) => {
    const n = x.length, a = (i + n - 1) % n, c = (i + 1) % n, dx = x[c] - x[a], dy = y[c] - y[a], l = Math.hypot(dx, dy);
    return l > 1e-6 ? Math.abs((x[i] - x[a]) * dy - (y[i] - y[a]) * dx) / l : Math.hypot(x[i] - x[a], y[i] - y[a]);
  };
  while (x.length > 4) {
    let best = -1, bd = tol;
    for (let i = 1; i < x.length; ++i) { const d = dev(i); if (d < bd) { bd = d; best = i; } }
    if (best < 0) break;
    x.splice(best, 1); y.splice(best, 1);
  }
  const out = new Float32Array(2 * x.length);
  for (let i = 0; i < x.length; ++i) { out[2 * i] = x[i]; out[2 * i + 1] = y[i]; }
  return out;
}

// Growable typed arrays.
class Grow {
  constructor(T, n) { this.T = T; this.a = new T(n); this.n = 0; }
  room(k) { if (this.n + k > this.a.length) { const b = new this.T(Math.max(2 * this.a.length, this.n + k)); b.set(this.a.subarray(0, this.n)); this.a = b; } }
  done() { return this.a.slice(0, this.n); }
}

// Vertices: position (float), normal (int8, normalized), uv (float), colour (uint8, normalized).
class Builder {
  constructor(nv) {
    this.pos = new Grow(Float32Array, 3 * nv); this.nor = new Grow(Int8Array, 3 * nv);
    this.uv = new Grow(Float32Array, 2 * nv); this.col = new Grow(Uint8Array, 3 * nv);
    this.v = 0; this.tris = 0;
    this.min = [Infinity, Infinity, Infinity]; this.max = [-Infinity, -Infinity, -Infinity];
  }
  vert(x, y, z, nx, ny, nz, u, w, r, g, b) {
    const P = this.pos, N = this.nor, U = this.uv, C = this.col;
    P.room(3); N.room(3); U.room(2); C.room(3);
    P.a[P.n++] = x; P.a[P.n++] = y; P.a[P.n++] = z;
    N.a[N.n++] = Math.round(nx * 127); N.a[N.n++] = Math.round(ny * 127); N.a[N.n++] = Math.round(nz * 127);
    U.a[U.n++] = u; U.a[U.n++] = w;
    C.a[C.n++] = Math.round(Math.min(1, r) * 255); C.a[C.n++] = Math.round(Math.min(1, g) * 255); C.a[C.n++] = Math.round(Math.min(1, b) * 255);
    if (x < this.min[0]) this.min[0] = x; if (x > this.max[0]) this.max[0] = x;
    if (y < this.min[1]) this.min[1] = y; if (y > this.max[1]) this.max[1] = y;
    if (z < this.min[2]) this.min[2] = z; if (z > this.max[2]) this.max[2] = z;
    return this.v++;
  }
  // The arrays (and their buffers, to transfer), the index groups concatenated.
  finish(groups) {
    let total = 0;
    for (const g of groups) total += g.n;
    const index = this.v > 65535 ? new Uint32Array(total) : new Uint16Array(total);
    let at = 0;
    const counts = groups.map((g) => { index.set(g.a.subarray(0, g.n), at); at += g.n; return g.n; });
    const c = this.min.map((m, k) => (m + this.max[k]) / 2);
    const r = Math.hypot(this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]) / 2;
    const geo = { pos: this.pos.done(), nor: this.nor.done(), uv: this.uv.done(), col: this.col.done(), index, counts, sphere: this.v ? [c[0], c[1], c[2], r] : [0, 0, 0, 0] };
    return [geo, [geo.pos.buffer, geo.nor.buffer, geo.uv.buffer, geo.col.buffer, index.buffer]];
  }
}

// One tile's buildings into the builder, in three index groups by facade: 0
// houses' (and every roof, on a plain white texel of that texture: one draw
// call fewer), 1 blocks', 2 curtain walls. x east, y up, z = -north, relative
// to the tile's SW corner shifted by (dx, dy). `ground[k]`: the base of building k (m).
// `far`: for the skyline, its outlines simplified to a metre and no rooftop machine rooms.
function addTile(B, list, ground, dx, dy, far = false) {
  const walls = [new Grow(Uint32Array, 4096), new Grow(Uint32Array, 1024), new Grow(Uint32Array, 256)], roofIdx = walls[0];
  const RU = 0.03, RV = 0.2;  // a white texel of the house facade (constant: sampled crisp at any distance)
  // A wall quad from (x1, y1) to (x2, y2), zb to zt, outward to the right of
  // the edge; facade texture u from `run`; darker toward the ground.
  const quad = (x1, y1, x2, y2, zb, zt, g, run, c, into) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ne = (y2 - y1) / len, nn = -(x2 - x1) / len;
    const u0 = run / 3, u1 = (run + len) / 3, vb = (zb - g) / 3.2, vt = (zt - g) / 3.2;
    const kb = 0.72 + 0.28 * Math.min(1, (zb - g) / 30), kt = 0.72 + 0.28 * Math.min(1, (zt - g) / 30);
    const v = B.vert(x1 + dx, zb, -(y1 + dy), ne, 0, -nn, u0, vb, c[0] * kb, c[1] * kb, c[2] * kb);
    B.vert(x2 + dx, zb, -(y2 + dy), ne, 0, -nn, u1, vb, c[0] * kb, c[1] * kb, c[2] * kb);
    B.vert(x2 + dx, zt, -(y2 + dy), ne, 0, -nn, u1, vt, c[0] * kt, c[1] * kt, c[2] * kt);
    B.vert(x1 + dx, zt, -(y1 + dy), ne, 0, -nn, u0, vt, c[0] * kt, c[1] * kt, c[2] * kt);
    into.room(6);
    const a = into.a;
    a[into.n++] = v; a[into.n++] = v + 1; a[into.n++] = v + 2; a[into.n++] = v; a[into.n++] = v + 2; a[into.n++] = v + 3;
    return len;
  };
  // A roof triangle (corners [x, y, z] in scene axes, tile-relative), its normal from its corners (made to face up).
  const tri = (a, b, c, color) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (ny < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    roofIdx.room(3);
    for (const p of [a, b, c]) roofIdx.a[roofIdx.n++] = B.vert(p[0] + dx, p[1], p[2] - dy, nx / l, ny / l, nz / l, RU, RV, color[0], color[1], color[2]);
  };
  for (let k = 0; k < list.length; ++k) {
    let b = list[k];
    if (far && b.rings[0].length > 10) b = { ...b, rings: [simplify(b.rings[0], 1), ...b.rings.slice(1)] };
    const outer = b.rings[0], m = outer.length / 2;
    if (m < 3) continue;
    let cx = 0, cy = 0;
    for (let i = 0; i < m; ++i) { cx += outer[2 * i]; cy += outer[2 * i + 1]; }
    cx /= m; cy /= m;
    // The base: the ground under the footprint's first corner and centroid
    // (the lower), sunk a little so a slope leaves no gap under the walls.
    const g = ground[k];
    const zb = g + (b.mh > 0 ? b.mh + 0.6 : 0), zt = g + 0.6 + b.h;
    // The walls' tint: the kind's (or, unknown, by height: São Paulo's plastered
    // houses, white and cream blocks, grey and glass towers), varied per building.
    const hsh = hash(outer[0], outer[1]);
    const pal = b.kind ? null : b.h < 10 ? LOW : b.h < 45 ? MID : HIGH;
    const t = pal ? pick(pal, hsh) : TINTS[b.kind], f = 0.9 + 0.16 * hsh, warm = (hsh - 0.5) * 0.04;
    const wc = [Math.min(1, t[0] * f + warm), Math.min(1, t[1] * f), Math.min(1, t[2] * f - warm)];
    // Which facade: a house's below 10 m; glass on about half the towers of 50 m
    // and more (and on commercial blocks of 30 m); a block's otherwise.
    const glass = b.h >= 50 ? hsh < 0.5 : b.kind === 3 && b.h >= 30;
    const fac = b.h < 10 ? 0 : glass ? 2 : 1;
    const wcol = glass ? [0.86 + 0.1 * hsh, 0.9 + 0.08 * hsh, 0.98] : wc;
    // A clay-tile hipped roof on most house-sized rectangles (one in four keeps
    // the flat concrete slab, the laje); its ridge at the building's height.
    const rect = b.rings.length === 1 && b.h <= 10 && (b.kind === 0 || b.kind === 1) && hash(outer[1], outer[0]) < 0.75 ? houseRect(outer) : null;
    const rise = rect ? Math.min(2.4, 0.5 * Math.hypot(rect[2][0] - rect[1][0], rect[2][1] - rect[1][1]) * 0.4) : 0;
    const eave = zt - rise;
    // Walls: every ring's edges, outward (an outline counter-clockwise, a courtyard clockwise).
    for (let ri = 0; ri < b.rings.length; ++ri) {
      const xy = b.rings[ri], n = xy.length / 2;
      if (n < 3) continue;
      const ccw = area(xy) > 0, outward = ri === 0 ? ccw : !ccw;
      let run = 0;
      for (let i = 0; i < n; ++i) {
        const j = (i + 1) % n;
        let x1 = xy[2 * i], y1 = xy[2 * i + 1], x2 = xy[2 * j], y2 = xy[2 * j + 1];
        if (!outward) [x1, y1, x2, y2] = [x2, y2, x1, y1];
        if (Math.hypot(x2 - x1, y2 - y1) < 0.05) continue;
        run += quad(x1, y1, x2, y2, zb, eave, g, run, wcol, walls[fac]);
      }
    }
    if (rect) {
      // Hipped: two trapezoids down the long sides, two triangles at the ends.
      const [p0, p1, p2] = rect;
      const lx = p1[0] - p0[0], ly = p1[1] - p0[1], L = Math.hypot(lx, ly), ux = lx / L, uy = ly / L;
      const W = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), hl = Math.max(0, (L - W) / 2);
      const mx = (p0[0] + p2[0]) / 2, my = (p0[1] + p2[1]) / 2;
      const A = [mx - ux * hl, zt, -(my - uy * hl)], Bq = [mx + ux * hl, zt, -(my + uy * hl)];
      const P = rect.map((p) => [p[0], eave, -p[1]]);
      const rc = pick(TILE, hash(outer[0] + 1, outer[1]));
      tri(P[0], P[1], Bq, rc); tri(P[0], Bq, A, rc);
      tri(P[1], P[2], Bq, rc);
      tri(P[2], P[3], A, rc); tri(P[2], A, Bq, rc);
      tri(P[3], P[0], A, rc);
      continue;
    }
    // Flat roof: the outline less its courtyards. Its colour: metal sheet on
    // sheds, warehouses and big low roofs, else concrete, tar or membrane.
    const big = Math.abs(area(outer));
    const rp = b.kind === 4 || b.kind === 9 || b.kind === 8 || (b.h < 14 && big > 1500) ? METAL : FLAT;
    const rc0 = pick(rp, hash(outer[1] + 3, outer[0])), rf = 0.92 + 0.12 * hsh;
    const rc = [rc0[0] * rf, rc0[1] * rf, rc0[2] * rf];
    // Earcut on the flat coordinates: the outline, then each courtyard of 3 corners or more.
    let flat = outer, holes = null;
    if (b.rings.length > 1) {
      let len = outer.length;
      for (let ri = 1; ri < b.rings.length; ++ri) if (b.rings[ri].length >= 6) len += b.rings[ri].length;
      flat = new Float32Array(len); flat.set(outer); holes = [];
      let at = outer.length;
      for (let ri = 1; ri < b.rings.length; ++ri) {
        const xy = b.rings[ri];
        if (xy.length < 6) continue;
        holes.push(at / 2); flat.set(xy, at); at += xy.length;
      }
    }
    const tris = earcut(flat, holes, 2);
    if (!tris.length) continue;
    const base = B.v;
    for (let i = 0; i < flat.length; i += 2) B.vert(flat[i] + dx, zt, -(flat[i + 1] + dy), 0, 1, 0, RU, RV, rc[0], rc[1], rc[2]);
    // Wound to face up (counter-clockwise seen from above in east/north).
    roofIdx.room(tris.length);
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], bb = tris[i + 1], c = tris[i + 2];
      const cr = (flat[2 * bb] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * bb + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
      const r = roofIdx.a;
      if (cr >= 0) { r[roofIdx.n++] = base + a; r[roofIdx.n++] = base + bb; r[roofIdx.n++] = base + c; }
      else { r[roofIdx.n++] = base + a; r[roofIdx.n++] = base + c; r[roofIdx.n++] = base + bb; }
    }
    // A block's rooftop: the stair and lift machine room with the water tank
    // over it (the caixa d'água on almost every São Paulo building), at the
    // footprint's centre when that is inside it.
    if (!far && b.h >= 18 && !glass && big > 150 && inside(outer, cx, cy)) {
      const s = Math.min(9, 0.28 * Math.sqrt(big)) / 2, hb = 2.6 + 1.4 * hsh;
      const ang = Math.atan2(outer[3] - outer[1], outer[2] - outer[0]), ca = Math.cos(ang), sa = Math.sin(ang);
      const c4 = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([a, bb]) => [cx + a * ca - bb * sa, cy + a * sa + bb * ca]);
      const bc = [wc[0] * 0.95, wc[1] * 0.95, wc[2] * 0.95];
      if (area(c4.flat()) < 0) c4.reverse();
      for (let i = 0; i < 4; ++i) { const p = c4[i], q = c4[(i + 1) % 4]; quad(p[0], p[1], q[0], q[1], zt, zt + hb, zt - 30, 0, bc, walls[1]); }
      const top = c4.map((p) => [p[0], zt + hb, -p[1]]);
      tri(top[0], top[1], top[2], rc); tri(top[0], top[2], top[3], rc);
    }
  }
  return walls;
}

// Jobs waiting for their ground heights: id -> { kind, ... }.
const jobs = new Map();
const fail = (id, e) => { jobs.delete(id); postMessage({ t: 'fail', id, err: String(e && e.message || e) }); };

async function tileJob({ id, url, i, j }) {
  try {
    const buf = await fetchTile(url);
    if (!jobs.has(id)) return;  // cancelled while it loaded
    const { list } = decode(buf);
    const pts = new Float64Array(4 * list.length);
    const hMax = groundPoints(list, i * TS, j * TS, pts, 0);
    jobs.set(id, { kind: 'tile', list });
    // The raw block goes back too: the flight core takes it as it is.
    postMessage({ t: 'need', id, pts, n: list.length, hMax, bytes: buf }, [pts.buffer, buf]);
  } catch (e) { fail(id, e); }
}

async function tallJob({ id, url }) {
  try {
    const buf = await fetchTile(url);
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x54425641) throw new Error('not an AVBT file');  // "AVBT"
    const n = dv.getUint32(4, true);
    let off = 8 + 8 * n, total = 0;
    const tiles = [];
    for (let k = 0; k < n; ++k) {
      const i = dv.getInt16(8 + 8 * k, true), j = dv.getInt16(10 + 8 * k, true), len = dv.getUint32(12 + 8 * k, true);
      const { list } = decode(buf, off);
      off += len;
      tiles.push({ i, j, list, at: total });
      total += list.length;
    }
    const pts = new Float64Array(4 * total);
    for (const t of tiles) groundPoints(t.list, t.i * TS, t.j * TS, pts, 4 * t.at);
    jobs.set(id, { kind: 'tall', tiles });
    postMessage({ t: 'need', id, pts, n: total, hMax: 0 }, [pts.buffer]);
  } catch (e) { fail(id, e); }
}

function build(id, g) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  try {
    if (job.kind === 'tile') {
      const B = new Builder(16 * job.list.length + 64);
      const [geo, xfer] = B.finish(addTile(B, job.list, g, 0, 0));
      postMessage({ t: 'geo', id, geo }, xfer);
      return;
    }
    // The skyline, in blocks of TB x TB tiles: one geometry each, its index
    // laid out by facade group, then by tile, so the page can leave out a tile
    // (one shown in full detail) by rewriting the index alone.
    const blocks = new Map();
    for (const t of job.tiles) {
      const bk = `${Math.floor(t.i / TB)},${Math.floor(t.j / TB)}`;
      if (!blocks.has(bk)) blocks.set(bk, []);
      blocks.get(bk).push(t);
    }
    for (const [bk, ts] of blocks) {
      const [bi, bj] = bk.split(',').map(Number);
      let nb = 0;
      for (const t of ts) nb += t.list.length;
      const B = new Builder(24 * nb + 64);
      const per = ts.map((t) => addTile(B, t.list, g.subarray(t.at, t.at + t.list.length), (t.i - bi * TB) * TS, (t.j - bj * TB) * TS, true));
      // Group k: every tile's group-k triangles in turn. ranges: per tile [i, j, start0, count0, start1, count1, start2, count2].
      const groups = [0, 1, 2].map((k) => {
        const G = new Grow(Uint32Array, 1);
        for (const w of per) { G.room(w[k].n); G.a.set(w[k].a.subarray(0, w[k].n), G.n); G.n += w[k].n; }
        return G;
      });
      const ranges = new Int32Array(8 * ts.length), at = [0, 0, 0];
      ts.forEach((t, q) => {
        ranges[8 * q] = t.i; ranges[8 * q + 1] = t.j;
        for (let k = 0; k < 3; ++k) { ranges[8 * q + 2 + 2 * k] = at[k]; ranges[8 * q + 3 + 2 * k] = per[q][k].n; at[k] += per[q][k].n; }
      });
      const [geo, xfer] = B.finish(groups);
      postMessage({ t: 'block', id, bi, bj, geo, ranges, n: nb }, [...xfer, ranges.buffer]);
    }
    postMessage({ t: 'done', id });
  } catch (e) { fail(id, e); }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'tile') { jobs.set(m.id, { kind: 'loading' }); tileJob(m); }
  else if (m.t === 'tall') { jobs.set(m.id, { kind: 'loading' }); tallJob(m); }
  else if (m.t === 'heights') build(m.id, m.g);
  else if (m.t === 'cancel') jobs.delete(m.id);
};
