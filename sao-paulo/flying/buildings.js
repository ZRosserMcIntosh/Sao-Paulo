// São Paulo World · flight test bed: the city's buildings, extruded from
// OpenStreetMap footprints and heights (via the Overture Maps buildings
// theme; data © OpenStreetMap contributors, ODbL), and where OSM has none the
// Google Open Buildings and Microsoft ML Buildings footprints (Overture,
// ODbL), their heights estimated. Built by tools/osm_buildings in the
// Aviation-Dynamics repository into 1 km tiles (buildings/b_<i>_<j>.bin.gz,
// in the site frame) and a skyline overview of the buildings 35 m and taller
// (buildings/tall.bin.gz).
//
// Around the aircraft every building is drawn; beyond it, the skyline. Each
// tile is one mesh (walls and roofs), its vertices relative to the tile so
// 32-bit positions keep their centimetres; the skyline is drawn in blocks of
// 4 x 4 tiles (a few dozen draw calls, not hundreds), a tile left out of its
// block while it is drawn in full. Bases sit on the same ground the flight
// core flies over (groundAt).
//
// The work is spread so no frame stalls: fetching, inflating, decoding and
// building the meshes run in a worker (buildings_worker.js); the page only
// looks up the ground under each building (a cheap call into the core, in
// slices of at most ~1.5 ms a frame), turns at most one finished tile into a
// mesh a frame, and hands at most one tile a frame to the flight core.
import * as THREE from 'three';

const TS = 1000;   // m, tile size (as the tiler's)
const TB = 4;      // tiles a side in a skyline block (as the worker's)
const HBUDGET = 1.5;  // ms a frame for the ground under new buildings

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

// Once on the GPU, a mesh's arrays are not needed in the page any more.
function dropArray() { this.array = null; }
// A worker's arrays as a geometry: three groups by facade.
function makeGeometry(g, keepIndex) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3).onUpload(dropArray));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.nor, 3, true).onUpload(dropArray));
  geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2).onUpload(dropArray));
  geo.setAttribute('color', new THREE.BufferAttribute(g.col, 3, true).onUpload(dropArray));
  const index = new THREE.BufferAttribute(g.index, 1);
  geo.setIndex(keepIndex ? index : index.onUpload(dropArray));
  let at = 0;
  for (let k = 0; k < 3; ++k) { geo.addGroup(at, g.counts[k], k); at += g.counts[k]; }
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(g.sphere[0], g.sphere[1], g.sphere[2]), g.sphere[3]);
  return geo;
}
// Distance from (x, y) to a square of side s at (x0, y0).
const rectDist = (x, y, x0, y0, s) => Math.hypot(Math.max(x0 - x, 0, x - x0 - s), Math.max(y0 - y, 0, y - y0 - s));

// { group, update(east, north, heightAgl, view), setOptions({ detail, skyline, shadows }), clearPhysics(), resyncPhysics(), ready, stats }.
// `groundAt(e, n)`: m MSL. `physics` ({ add(i, j, bytes), drop(i, j) }): the
// tiles the aircraft could reach soon are handed to the flight core, whose
// walls and roofs become solid.
// Options: detail (m: every building within it, more with height), skyline
// (m: the tall buildings within it; Infinity all, 0 none), shadows (0 none,
// 1 the tiles near the aircraft receive its shadow, 2 every tile).
// `clear` ([x0, z0, x1, z1], world x and z): no building is drawn inside it (a
// page that puts something of its own there, as the golf course does).
export function buildCity({ base = './buildings/', groundAt, mobile = false, maxAniso = 4, physics = null, options = {}, clear = null }) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const mats = facadeTextures(maxAniso).map((map) => new THREE.MeshLambertMaterial({ vertexColors: true, map }));
  if (clear) {
    for (const m of mats) m.onBeforeCompile = (sh) => {
      sh.uniforms.clearBox = { value: new THREE.Vector4(...clear) };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vClearXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvClearXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vClearXZ;\nuniform vec4 clearBox;')
        .replace('void main() {', 'void main() {\nif ( vClearXZ.x > clearBox.x && vClearXZ.x < clearBox.z && vClearXZ.y > clearBox.y && vClearXZ.y < clearBox.w ) discard;');
    };
  }
  const opt = { detail: mobile ? 1500 : 2500, skyline: Infinity, shadows: 1, ...options };
  const root = new URL(base, location.href).href;
  const key = (i, j) => `${i},${j}`;
  const stats = { tiles: 0, loaded: 0, buildings: 0, triangles: 0, tallTriangles: 0, blocks: 0, solid: 0, queued: 0, ms: 0, msMax: 0 };

  // The workers: one on a phone, two where there are cores to spare.
  const inbox = [];
  const workers = [];
  const nw = mobile ? 1 : Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 2));
  try {
    for (let k = 0; k < nw; ++k) {
      const w = new Worker(new URL('./buildings_worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => inbox.push(e.data);
      w.onerror = (e) => console.warn('buildings worker', e.message || e);
      workers.push(w);
    }
  } catch (e) { console.warn('buildings: no worker', e); }
  let nextId = 1, rr = 0;
  const jobs = new Map();     // id -> the tile record (or the skyline's)
  const send = (w, m) => { w.postMessage(m); };

  const detail = new Map();   // "i,j" -> { i, j, id, w, state: 'loading' | 'building' | 'ready' | 'failed', mesh, n, tris, bytes, hMax }
  const blocks = new Map();   // "bi,bj" -> { mesh, full, ranges, gs, hidden: Set, tris }
  const solid = new Set();    // "i,j" tiles in the flight core
  const heights = [];         // ground lookups waiting: { id, w, pts, g, n, at, tall }
  const uploads = [];         // finished tiles waiting to become meshes: { rec, geo }
  const blockQ = [];          // finished skyline blocks: { bi, bj, geo, ranges, n }
  let index = null, tallJob = null;

  const ready = fetch(root + 'index.json').then((r) => r.json()).then((ix) => {
    index = ix;
    if (!workers.length) return;
    tallJob = { id: nextId++, w: workers[0], tall: true };
    jobs.set(tallJob.id, tallJob);
    send(tallJob.w, { t: 'tall', id: tallJob.id, url: root + 'tall.bin.gz' });
  }).catch((e) => { console.warn('buildings', e); });

  // A skyline block's index: every tile not drawn in full, group by group.
  function rebuildBlock(b) {
    const idx = b.mesh.geometry.index.array, r = b.ranges, geo = b.mesh.geometry;
    let at = 0;
    geo.clearGroups();
    for (let k = 0; k < 3; ++k) {
      const start = at;
      for (let q = 0; q < r.length; q += 8) {
        if (b.hidden.has(key(r[q], r[q + 1]))) continue;
        const s = b.gs[k] + r[q + 2 + 2 * k], c = r[q + 3 + 2 * k];
        idx.set(b.full.subarray(s, s + c), at);
        at += c;
      }
      geo.addGroup(start, at - start, k);
    }
    geo.index.needsUpdate = true;
    b.tris = at / 3;
    b.mesh.visible = b.inRange && at > 0;
  }
  const blockOf = (i, j) => blocks.get(key(Math.floor(i / TB), Math.floor(j / TB)));
  // A tile drawn in full (or no longer): out of (back into) its skyline block.
  function tallHide(i, j, hide) {
    const b = blockOf(i, j), k = key(i, j);
    if (!b || b.hidden.has(k) === hide) return;
    if (hide) b.hidden.add(k); else b.hidden.delete(k);
    rebuildBlock(b);
  }

  function handle(m) {
    const rec = jobs.get(m.id);
    if (!rec) return;  // dropped meanwhile
    if (m.t === 'need') {
      if (!rec.tall) { rec.bytes = m.bytes; rec.hMax = m.hMax; rec.n = m.n; rec.state = 'building'; }
      const h = { id: m.id, w: rec.w, pts: m.pts, g: new Float32Array(m.n), n: m.n, at: 0, tall: !!rec.tall };
      // Tiles before the skyline: they are what the aircraft is flying over.
      const before = rec.tall ? heights.length : heights.findIndex((x) => x.tall);
      heights.splice(before < 0 ? heights.length : before, 0, h);
    } else if (m.t === 'geo') {
      jobs.delete(m.id);
      uploads.push({ rec, geo: m.geo });
    } else if (m.t === 'block') {
      blockQ.push(m);
    } else if (m.t === 'done') {
      jobs.delete(m.id);
    } else if (m.t === 'fail') {
      jobs.delete(m.id);
      if (rec.tall) console.warn('buildings: skyline', m.err);
      else rec.state = 'failed';
    }
  }
  // The ground under the waiting buildings, for at most HBUDGET ms.
  function lookUpGround(t0) {
    while (heights.length && performance.now() - t0 < HBUDGET) {
      const h = heights[0], end = Math.min(h.n, h.at + 512), p = h.pts, g = h.g;
      for (let k = h.at; k < end; ++k) {
        const q = 4 * k;
        g[k] = Math.min(groundAt(p[q], p[q + 1]), groundAt(p[q + 2], p[q + 3])) - 0.6;
      }
      h.at = end;
      if (end < h.n) continue;
      heights.shift();
      if (jobs.has(h.id)) h.w.postMessage({ t: 'heights', id: h.id, g }, [g.buffer]);
    }
  }
  function place(geo, x, y) {
    const mesh = new THREE.Mesh(geo, mats);
    mesh.position.set(x, 0, -y);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    group.add(mesh);
    return mesh;
  }
  function load(i, j) {
    const w = workers[rr++ % workers.length];
    const rec = { i, j, id: nextId++, w, state: 'loading', mesh: null, n: 0, tris: 0, bytes: null, hMax: 0 };
    detail.set(key(i, j), rec);
    jobs.set(rec.id, rec);
    send(w, { t: 'tile', id: rec.id, url: `${root}b_${i}_${j}.bin.gz`, i, j });
  }
  function unload(k, rec) {
    if (solid.has(k)) { physics.drop(rec.i, rec.j); solid.delete(k); }
    if (jobs.has(rec.id)) { jobs.delete(rec.id); rec.w.postMessage({ t: 'cancel', id: rec.id }); }
    const hi = heights.findIndex((h) => h.id === rec.id);
    if (hi >= 0) heights.splice(hi, 1);
    const ui = uploads.findIndex((u) => u.rec === rec);
    if (ui >= 0) uploads.splice(ui, 1);
    if (rec.mesh) { group.remove(rec.mesh); rec.mesh.geometry.dispose(); rec.mesh = null; tallHide(rec.i, rec.j, false); }
    rec.bytes = null;
    detail.delete(k);
  }

  // The aircraft's ground track, to hand the flight core the tiles ahead.
  const track = { e: 0, n: 0, t: 0, ve: 0, vn: 0, ok: false };
  const msWin = [];
  // Keep the tiles within the detail radius of (east, north) drawn in full,
  // the skyline beyond (out to `view` m, where the haze hides everything);
  // the tiles near the aircraft (and ahead of it) solid.
  function update(east, north, agl = 0, view = Infinity) {
    const t0 = performance.now();
    if (!index) return;
    // Its velocity (m/s) from the last calls; a jump (a restart) resets it.
    const now = t0 / 1000;
    if (track.ok && now > track.t) {
      const dt = now - track.t, de = east - track.e, dn = north - track.n;
      if (Math.hypot(de, dn) > 2000 || dt > 1) { track.ve = track.vn = 0; }
      else { const a = Math.min(1, dt / 0.5); track.ve += (de / dt - track.ve) * a; track.vn += (dn / dt - track.vn) * a; }
    }
    Object.assign(track, { e: east, n: north, t: now, ok: true });

    for (let k = 0; k < inbox.length; ++k) handle(inbox[k]);
    inbox.length = 0;
    lookUpGround(t0);

    const radius = opt.detail + Math.min(agl, 3000) * 0.3;
    // Solid: within 700 m of the aircraft or of where it will be in 8 s, and
    // only while it is low enough to strike what is there.
    const ae = east + 8 * track.ve, an = north + 8 * track.vn;
    const low = agl < 900;  // m: above this no tile is solid (the tallest towers are under 200 m)
    const loadR = Math.max(radius, low ? 2000 : 0);

    // One finished tile a frame becomes a mesh (the nearest first).
    if (uploads.length) {
      let best = 0, bd = Infinity;
      for (let q = 0; q < uploads.length; ++q) { const r = uploads[q].rec, d = Math.hypot((r.i + 0.5) * TS - east, (r.j + 0.5) * TS - north); if (d < bd) { bd = d; best = q; } }
      const { rec, geo } = uploads.splice(best, 1)[0];
      rec.mesh = place(makeGeometry(geo, false), rec.i * TS, rec.j * TS);
      rec.mesh.visible = false;
      rec.tris = geo.index.length / 3;
      rec.state = 'ready';
    } else if (blockQ.length) {
      // Else one skyline block.
      const m = blockQ.shift();
      const geo = makeGeometry(m.geo, true);
      const b = { bi: m.bi, bj: m.bj, mesh: place(geo, m.bi * TB * TS, m.bj * TB * TS), full: m.geo.index.slice(), ranges: m.ranges,
        gs: [0, m.geo.counts[0], m.geo.counts[0] + m.geo.counts[1]], hidden: new Set(), tris: m.geo.index.length / 3, inRange: true, n: m.n };
      blocks.set(key(m.bi, m.bj), b);
      for (let q = 0; q < m.ranges.length; q += 8) { const r = detail.get(key(m.ranges[q], m.ranges[q + 1])); if (r && r.mesh && r.mesh.visible) b.hidden.add(key(m.ranges[q], m.ranges[q + 1])); }
      rebuildBlock(b);
    }

    // What to load: every tile within reach not yet asked for, the nearest first (a few at a time).
    const ci = Math.floor(east / TS), cj = Math.floor(north / TS), r = Math.ceil(loadR / TS);
    let inflight = 0;
    for (const v of detail.values()) if (v.state === 'loading') ++inflight;
    if (workers.length && inflight < 2 * workers.length) {
      const want = [];
      for (let j = cj - r; j <= cj + r; ++j) for (let i = ci - r; i <= ci + r; ++i) {
        const k = key(i, j);
        if (detail.has(k) || !index.tiles[k]) continue;
        const d = Math.hypot((i + 0.5) * TS - east, (j + 0.5) * TS - north);
        if (d <= radius || (low && Math.min(rectDist(east, north, i * TS, j * TS, TS), rectDist(ae, an, i * TS, j * TS, TS)) < 900)) want.push([d, i, j]);
      }
      want.sort((a, b) => a[0] - b[0]);
      for (const [, i, j] of want) { if (inflight >= 2 * workers.length) break; load(i, j); ++inflight; }
    }

    // Drawn, solid or dropped; at most one tile into the flight core and one out of it a frame.
    let add = null, addD = Infinity, drop = null, dropD = -1;
    let tiles = 0, nb = 0, tri = 0, loaded = 0;
    for (const [k, v] of detail) {
      const d = Math.hypot((v.i + 0.5) * TS - east, (v.j + 0.5) * TS - north);
      if (d > loadR + 700) { unload(k, v); continue; }  // (some way past it: no reload when turning back)
      ++loaded;
      if (v.mesh) {
        const show = v.mesh.visible ? d <= radius + 100 : d <= radius;
        if (show !== v.mesh.visible) { v.mesh.visible = show; tallHide(v.i, v.j, show); }
        if (show) {
          v.mesh.receiveShadow = opt.shadows === 2 || (opt.shadows === 1 && rectDist(east, north, v.i * TS, v.j * TS, TS) < 1200);
          ++tiles; nb += v.n; tri += v.tris;
        }
      }
      if (physics && v.bytes) {
        const dn = Math.min(rectDist(east, north, v.i * TS, v.j * TS, TS), rectDist(ae, an, v.i * TS, v.j * TS, TS));
        const reach = agl < v.hMax + 250;
        if (!solid.has(k)) { if (reach && dn < 700 && dn < addD) { add = v; addD = dn; } }
        else if ((dn > 2000 || agl > v.hMax + 500) && dn > dropD) { drop = v; dropD = dn; }
      }
    }
    if (add) { physics.add(add.i, add.j, add.bytes); solid.add(key(add.i, add.j)); }
    if (drop) { physics.drop(drop.i, drop.j); solid.delete(key(drop.i, drop.j)); }

    // The skyline: the blocks within its distance.
    let tallTri = 0, nblk = 0;
    for (const b of blocks.values()) {
      const inRange = rectDist(east, north, b.bi * TB * TS, b.bj * TB * TS, TB * TS) <= Math.min(opt.skyline, view);
      if (inRange !== b.inRange) { b.inRange = inRange; b.mesh.visible = inRange && b.tris > 0; }
      b.mesh.receiveShadow = opt.shadows === 2;
      if (b.mesh.visible) { tallTri += b.tris; ++nblk; }
    }
    const ms = performance.now() - t0;
    msWin.push(ms); if (msWin.length > 120) msWin.shift();
    Object.assign(stats, { tiles, loaded, buildings: nb, triangles: tri + tallTri, tallTriangles: tallTri, blocks: nblk, solid: solid.size,
      queued: heights.length + uploads.length + blockQ.length + inflight, ms, msMax: Math.max(...msWin) });
  }
  function setOptions(o) { Object.assign(opt, o); }
  // Buildings off: none of them solid (they come back with the next update).
  function clearPhysics() {
    for (const k of solid) { const [i, j] = k.split(',').map(Number); physics.drop(i, j); }
    solid.clear();
  }
  // The flight core was rebuilt (another aircraft loaded): it has no buildings; the next update hands them over again.
  function resyncPhysics() { solid.clear(); }
  return { group, update, setOptions, options: opt, clearPhysics, resyncPhysics, ready, stats };
}
