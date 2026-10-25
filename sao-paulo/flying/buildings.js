// São Paulo World · flight test bed: the city's buildings, extruded from
// OpenStreetMap footprints and heights (via the Overture Maps buildings
// theme; data © OpenStreetMap contributors, ODbL). Built by
// tools/osm_buildings in the Aviation-Dynamics repository into 1 km tiles
// (buildings/b_<i>_<j>.bin, in the site frame) and a skyline overview of the
// buildings 35 m and taller (buildings/tall.bin).
//
// Around the aircraft every building is drawn; beyond it, the overview. Each
// tile is one mesh (walls and roofs), its vertices relative to the tile so
// 32-bit positions keep their centimetres. Bases sit on the same ground the
// map is draped on (groundAt).
import * as THREE from 'three';

const TS = 1000;  // m, tile size (as the tiler's)
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

// The facades, one window bay (3 m wide, one 3.2 m floor) each, repeated over
// the walls: [0] a house's (one small window in a plastered wall), [1] a
// block's (a window per bay), [2] a tower's curtain wall (glass between
// mullions and spandrels).
function facadeTextures(maxAniso) {
  const draw = (paint) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    paint(g);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
    return t;
  };
  return [
    draw((g) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#6f777f'; g.fillRect(20, 22, 24, 22);  // a small window
      g.fillStyle = '#e4e2dc'; g.fillRect(18, 44, 28, 3);   // its sill
      g.fillStyle = '#eceae6'; g.fillRect(0, 0, 64, 3);     // a band under the floor above
    }),
    draw((g) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#7d858d'; g.fillRect(8, 16, 48, 34);   // the window
      g.fillStyle = '#5c646c'; g.fillRect(8, 16, 48, 4);    // its shadowed head
      g.fillStyle = '#d9d9d6'; g.fillRect(6, 50, 52, 3);    // the sill
    }),
    draw((g) => {
      g.fillStyle = '#c9ced3'; g.fillRect(0, 0, 64, 64);    // spandrel and mullions
      const grd = g.createLinearGradient(0, 8, 0, 56);
      grd.addColorStop(0, '#56677a'); grd.addColorStop(1, '#7f93a6');  // sky in the glass
      g.fillStyle = grd; g.fillRect(3, 8, 58, 48);
      g.fillStyle = '#9fb0bf'; g.fillRect(31, 8, 2, 48);     // a mullion
    }),
  ];
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

// One tile's buildings as one geometry in three groups, by facade: 0 houses'
// (and every roof, on a plain white texel of that texture: one draw call
// fewer), 1 blocks', 2 curtain walls. x east, y up, z = -north, relative to
// the tile's SW corner (ox, oy) in the site frame.
function tileGeometry(list, ox, oy, groundAt) {
  const pos = [], nor = [], uv = [], col = [], walls = [[], [], []], roofIdx = walls[0];
  const RU = 0.03, RV = 0.2;  // a white texel of the house facade (constant: sampled crisp at any distance)
  let v = 0;
  // A wall quad from (x1, y1) to (x2, y2), zb to zt, outward to the right of
  // the edge; facade texture u from `run`; darker toward the ground.
  const quad = (x1, y1, x2, y2, zb, zt, g, run, c, into) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ne = (y2 - y1) / len, nn = -(x2 - x1) / len;
    const u0 = run / 3, u1 = (run + len) / 3, vb = (zb - g) / 3.2, vt = (zt - g) / 3.2;
    const kb = 0.72 + 0.28 * Math.min(1, (zb - g) / 30), kt = 0.72 + 0.28 * Math.min(1, (zt - g) / 30);
    pos.push(x1, zb, -y1, x2, zb, -y2, x2, zt, -y2, x1, zt, -y1);
    for (let k = 0; k < 4; ++k) { nor.push(ne, 0, -nn); const f = k < 2 ? kb : kt; col.push(c[0] * f, c[1] * f, c[2] * f); }
    uv.push(u0, vb, u1, vb, u1, vt, u0, vt);
    into.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
    return len;
  };
  // A roof triangle, its normal from its corners (made to face up).
  const tri = (a, b, c, color) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (ny < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); nor.push(nx / l, ny / l, nz / l); col.push(color[0], color[1], color[2]); uv.push(RU, RV); }
    roofIdx.push(v, v + 1, v + 2);
    v += 3;
  };
  for (const b of list) {
    const outer = b.rings[0], m = outer.length / 2;
    if (m < 3) continue;
    // The base: the ground under the footprint's first corner and centroid, sunk
    // a little so a slope leaves no gap under the walls.
    let cx = 0, cy = 0;
    for (let i = 0; i < m; ++i) { cx += outer[2 * i]; cy += outer[2 * i + 1]; }
    cx /= m; cy /= m;
    const g = Math.min(groundAt(ox + cx, oy + cy), groundAt(ox + outer[0], oy + outer[1])) - 0.6;
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
      const [p0, p1, p2, p3] = rect;
      const lx = p1[0] - p0[0], ly = p1[1] - p0[1], L = Math.hypot(lx, ly), ux = lx / L, uy = ly / L;
      const W = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), hl = Math.max(0, (L - W) / 2);
      const mx = (p0[0] + p2[0]) / 2, my = (p0[1] + p2[1]) / 2;
      const A = [mx - ux * hl, zt, -(my - uy * hl)], B = [mx + ux * hl, zt, -(my + uy * hl)];
      const P = rect.map((p) => [p[0], eave, -p[1]]);
      const rc = pick(TILE, hash(outer[0] + 1, outer[1]));
      tri(P[0], P[1], B, rc); tri(P[0], B, A, rc);
      tri(P[1], P[2], B, rc);
      tri(P[2], P[3], A, rc); tri(P[2], A, B, rc);
      tri(P[3], P[0], A, rc);
      continue;
    }
    // Flat roof: the outline less its courtyards. Its colour: metal sheet on
    // sheds, warehouses and big low roofs, else concrete, tar or membrane.
    const big = Math.abs(area(outer));
    const rp = b.kind === 4 || b.kind === 9 || b.kind === 8 || (b.h < 14 && big > 1500) ? METAL : FLAT;
    const rc0 = pick(rp, hash(outer[1] + 3, outer[0])), rf = 0.92 + 0.12 * hsh;
    const rc = [rc0[0] * rf, rc0[1] * rf, rc0[2] * rf];
    const contour = [], holes = [];
    for (let i = 0; i < m; ++i) contour.push(new THREE.Vector2(outer[2 * i], outer[2 * i + 1]));
    for (let ri = 1; ri < b.rings.length; ++ri) {
      const xy = b.rings[ri], hv = [];
      for (let i = 0; i < xy.length / 2; ++i) hv.push(new THREE.Vector2(xy[2 * i], xy[2 * i + 1]));
      if (hv.length >= 3) holes.push(hv);
    }
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { continue; }
    const all = contour.concat(...holes), base = v;
    for (const p of all) {
      pos.push(p.x, zt, -p.y); nor.push(0, 1, 0); col.push(rc[0], rc[1], rc[2]); uv.push(RU, RV);
      ++v;
    }
    // triangulateShape returns faces as indices into contour + holes; wind them to face up.
    for (const [a, bb, c] of tris) roofIdx.push(base + a, base + c, base + bb);
    // A block's rooftop: the stair and lift machine room with the water tank
    // over it (the caixa d'água on almost every São Paulo building), at the
    // footprint's centre when that is inside it.
    if (b.h >= 18 && !glass && big > 150 && inside(outer, cx, cy)) {
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
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const idx = walls[0].concat(walls[1], walls[2]);
  geo.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  let at = 0;
  for (let k = 0; k < 3; ++k) { geo.addGroup(at, walls[k].length, k); at += walls[k].length; }
  geo.computeBoundingSphere();
  return geo;
}

// { group, update(east, north, heightAgl), clearPhysics(), resyncPhysics(), ready, stats }. `groundAt(e, n)`: m MSL.
// `physics` ({ add(i, j, bytes), drop(i, j) }): the tiles within ~1.5 km of the
// aircraft are handed to the flight core, whose walls and roofs become solid.
export function buildCity({ base = './buildings/', groundAt, mobile = false, maxAniso = 4, physics = null }) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const mats = facadeTextures(maxAniso).map((map) => new THREE.MeshLambertMaterial({ vertexColors: true, map }));
  const tall = new Map();     // "i,j" -> overview mesh
  const detail = new Map();   // "i,j" -> { mesh } | 'loading' | 'failed'
  const solid = new Set();     // "i,j" tiles in the flight core
  let index = null, queue = [];
  const stats = { tiles: 0, buildings: 0, triangles: 0, solid: 0 };
  const key = (i, j) => `${i},${j}`;
  const place = (geo, i, j) => {
    const mesh = new THREE.Mesh(geo, mats);
    mesh.position.set(i * TS, 0, -j * TS);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const ready = fetch(base + 'index.json').then((r) => r.json()).then(async (ix) => {
    index = ix;
    // The skyline: every tall building, grouped by tile.
    const buf = await (await fetch(base + 'tall.bin')).arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x54425641) throw new Error('not an AVBT file');  // "AVBT"
    const n = dv.getUint32(4, true);
    let off = 8 + 8 * n;
    for (let k = 0; k < n; ++k) {
      const i = dv.getInt16(8 + 8 * k, true), j = dv.getInt16(10 + 8 * k, true), len = dv.getUint32(12 + 8 * k, true);
      const { list } = decode(buf, off);
      off += len;
      const m = place(tileGeometry(list, i * TS, j * TS, groundAt), i, j);
      if (detail.get(key(i, j))?.mesh) m.visible = false;
      tall.set(key(i, j), m);
    }
  }).catch((e) => { console.warn('buildings', e); });

  async function load(i, j) {
    const k = key(i, j);
    detail.set(k, 'loading');
    try {
      const buf = await (await fetch(`${base}b_${i}_${j}.bin`)).arrayBuffer();
      const { list } = decode(buf);
      queue.push({ i, j, list, buf });
    } catch (e) {
      detail.set(k, 'failed');
    }
  }
  // Build at most one tile a frame (a dense tile is a few thousand buildings).
  function buildOne() {
    const job = queue.shift();
    if (!job) return;
    const k = key(job.i, job.j);
    if (detail.get(k) !== 'loading') return;  // dropped while it loaded
    const geo = tileGeometry(job.list, job.i * TS, job.j * TS, groundAt);
    detail.set(k, { mesh: place(geo, job.i, job.j), n: job.list.length, tris: geo.index.count / 3, buf: job.buf });
    const t = tall.get(k);
    if (t) t.visible = false;
  }

  // Keep the tiles within `radius` of (east, north) loaded; drop those past it.
  function update(east, north, agl = 0) {
    if (!index) return;
    buildOne();
    const radius = (mobile ? 2200 : 3500) + Math.min(agl, 3000) * (mobile ? 0.4 : 0.6);
    const ci = Math.floor(east / TS), cj = Math.floor(north / TS), r = Math.ceil(radius / TS);
    const want = [];
    for (let j = cj - r; j <= cj + r; ++j) for (let i = ci - r; i <= ci + r; ++i) {
      const d = Math.hypot((i + 0.5) * TS - east, (j + 0.5) * TS - north);
      if (d <= radius && index.tiles[key(i, j)] && !detail.has(key(i, j))) want.push([d, i, j]);
    }
    want.sort((a, b) => a[0] - b[0]);
    let inflight = 0;
    for (const v of detail.values()) if (v === 'loading') ++inflight;
    for (const [, i, j] of want) { if (inflight >= 3) break; load(i, j); ++inflight; }
    for (const [k, v] of detail) {
      const [i, j] = k.split(',').map(Number);
      const d = Math.hypot((i + 0.5) * TS - east, (j + 0.5) * TS - north);
      // The flight core: the tiles within 1.5 km (of the tile's edge, roughly), dropped past 2.5 km.
      if (physics && v && v.mesh) {
        if (d <= 1500 + 0.71 * TS && !solid.has(k)) { physics.add(i, j, v.buf); solid.add(k); }
        else if (d > 2500 + 0.71 * TS && solid.has(k)) { physics.drop(i, j); solid.delete(k); }
      }
      if (d <= radius + 1500) continue;
      if (solid.has(k)) { physics.drop(i, j); solid.delete(k); }
      if (v && v.mesh) { group.remove(v.mesh); v.mesh.geometry.dispose(); }
      detail.delete(k);
      const t = tall.get(k);
      if (t) t.visible = true;
    }
    let tiles = 0, b = 0, tri = 0;
    for (const v of detail.values()) if (v && v.mesh) { ++tiles; b += v.n; tri += v.tris; }
    Object.assign(stats, { tiles, buildings: b, triangles: tri, solid: solid.size });
  }
  // Buildings off: none of them solid (they come back with the next update).
  function clearPhysics() {
    for (const k of solid) { const [i, j] = k.split(',').map(Number); physics.drop(i, j); }
    solid.clear();
  }
  // The flight core was rebuilt (another aircraft loaded): it has no buildings; the next update hands them over again.
  function resyncPhysics() { solid.clear(); }
  return { group, update, clearPhysics, resyncPhysics, ready, stats };
}
