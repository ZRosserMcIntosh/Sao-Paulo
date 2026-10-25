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

// One window bay (3 m wide, one 3.2 m floor) as a texture: the walls repeat it.
function facadeTexture(maxAniso) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#7d858d'; g.fillRect(8, 16, 48, 34);   // the window
  g.fillStyle = '#5c646c'; g.fillRect(8, 16, 48, 4);    // its shadowed head
  g.fillStyle = '#d9d9d6'; g.fillRect(6, 50, 52, 3);    // the sill
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
  return t;
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

// One tile's buildings as one geometry: walls (group 0) and roofs (group 1).
// x east, y up, z = -north, relative to the tile's SW corner (ox, oy) in the site frame.
function tileGeometry(list, ox, oy, groundAt) {
  const pos = [], nor = [], uv = [], col = [], wallIdx = [], roofIdx = [];
  let v = 0;
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
    // The tint: the kind's (or, unknown, by height: São Paulo's plastered houses,
    // white and cream blocks, grey and glass towers), varied per building (a
    // hash of its first corner).
    const hsh = Math.abs(Math.sin(outer[0] * 12.9898 + outer[1] * 78.233)) * 43758.5453 % 1;
    const pal = b.kind ? null : b.h < 10 ? LOW : b.h < 45 ? MID : HIGH;
    const t = pal ? pal[Math.floor(hsh * 7919) % pal.length] : TINTS[b.kind], f = 0.9 + 0.16 * hsh, warm = (hsh - 0.5) * 0.04;
    const r = Math.min(1, t[0] * f + warm), gc = Math.min(1, t[1] * f), bl = Math.min(1, t[2] * f - warm);
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
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 0.05) continue;
        // Outward normal of a counter-clockwise edge: (dy, -dx) / len (east, north).
        const ne = (y2 - y1) / len, nn = -(x2 - x1) / len;
        const u0 = run / 3, u1 = (run + len) / 3, vb = (zb - g) / 3.2, vt = (zt - g) / 3.2;
        run += len;
        pos.push(x1, zb, -y1, x2, zb, -y2, x2, zt, -y2, x1, zt, -y1);
        for (let k = 0; k < 4; ++k) { nor.push(ne, 0, -nn); col.push(r, gc, bl); }
        uv.push(u0, vb, u1, vb, u1, vt, u0, vt);
        wallIdx.push(v, v + 1, v + 2, v, v + 2, v + 3);
        v += 4;
      }
    }
    // Roof: the outline less its courtyards, flat at the top.
    const contour = [], holes = [];
    for (let i = 0; i < m; ++i) contour.push(new THREE.Vector2(outer[2 * i], outer[2 * i + 1]));
    for (let ri = 1; ri < b.rings.length; ++ri) {
      const xy = b.rings[ri], hv = [];
      for (let i = 0; i < xy.length / 2; ++i) hv.push(new THREE.Vector2(xy[2 * i], xy[2 * i + 1]));
      if (hv.length >= 3) holes.push(hv);
    }
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { continue; }
    const all = contour.concat(...holes), base = v, rf = 0.9;
    for (const p of all) {
      pos.push(p.x, zt, -p.y); nor.push(0, 1, 0); col.push(r * rf, gc * rf, bl * rf); uv.push(0, 0);
      ++v;
    }
    // triangulateShape returns faces as indices into contour + holes; wind them to face up.
    for (const [a, bb, c] of tris) roofIdx.push(base + a, base + c, base + bb);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const idx = wallIdx.concat(roofIdx);
  geo.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.addGroup(0, wallIdx.length, 0);
  geo.addGroup(wallIdx.length, roofIdx.length, 1);
  geo.computeBoundingSphere();
  return geo;
}

// { group, update(east, north, heightAgl), clearPhysics(), resyncPhysics(), ready, stats }. `groundAt(e, n)`: m MSL.
// `physics` ({ add(i, j, bytes), drop(i, j) }): the tiles within ~1.5 km of the
// aircraft are handed to the flight core, whose walls and roofs become solid.
export function buildCity({ base = './buildings/', groundAt, mobile = false, maxAniso = 4, physics = null }) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const wall = new THREE.MeshLambertMaterial({ vertexColors: true, map: facadeTexture(maxAniso) });
  const roof = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mats = [wall, roof];
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
