// São Paulo World · flight test bed: the drawn ground, in chunks of
// decreasing resolution around the camera (a quadtree), on the flight core's
// own ground (groundAt), with the São Paulo World map photo draped over the
// map area and plain ground colour beyond it.
//
// The core's terrain is a 200 m SRTM grid (nodes at multiples of 200 m in the
// site frame) with the airfields flattened into it. Near the camera the
// ground is drawn at 50, 100 and 200 m, every vertex on the core's ground
// (the 200 m nodes among them), so what is drawn is what the aircraft hits.
// Each cell is split along the diagonal that keeps it above the core's
// (bilinear) ground. Farther out the cells are coarser than the core's grid:
// there each vertex takes the highest of the core's samples in the cells it
// is a corner of, rather than the one under it, so every cell stands on or
// above the ground it covers and a hill or a ridge is never shaved off
// (measured: nowhere more than ~0.6 m under the core's ground, and within a
// metre of it inside the first few kilometres); in the distance it stands
// somewhat proud of it (tens of metres on steep slopes), where that does not show.
// Chunks of different resolution meet with skirts (a strip hanging down from
// each edge) so no crack shows between them.
import * as THREE from 'three';

const N = 32;            // cells a chunk side
const STEP0 = 50;        // m, the finest cells
const LEVELS = 6;        // 50, 100, 200 m (on the core's samples), 400 to 1600 m (the highest of them)
const RES = 200;         // m, the core's terrain grid
const SPLIT = [0, 0.4, 1, 1.6, 1, 1];  // a chunk of level l splits when the camera is nearer than SPLIT[l] of its side (50 m cells only close by, the core's own 200 m out to ~20 km)

const stepOf = (l) => STEP0 << l;
const sizeOf = (l) => N * stepOf(l);
const rectDist = (x, y, x0, y0, s) => Math.hypot(Math.max(x0 - x, 0, x - x0 - s), Math.max(y0 - y, 0, y - y0 - s));

// `bounds` [e0, n0, e1, n1]: the ground drawn (m, site frame). `map` [e0, n0, e1, n1]: the photo's extent.
export function buildGround({ groundAt, bounds, map, drop = 0.05 }) {
  const group = new THREE.Group();
  group.name = 'ground';
  const mapBox = new THREE.Vector4(map[0], -map[3], map[2], -map[1]);  // in scene x, z
  const outCol = new THREE.Color('#77796f');
  const material = new THREE.MeshLambertMaterial({ color: '#ffffff', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.mapBox = { value: mapBox };
    sh.uniforms.outCol = { value: outCol };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vGroundXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vGroundXZ;\nuniform vec4 mapBox;\nuniform vec3 outCol;')
      .replace('#include <map_fragment>', '#include <map_fragment>\nif ( vGroundXZ.x < mapBox.x || vGroundXZ.x > mapBox.z || vGroundXZ.y < mapBox.y || vGroundXZ.y > mapBox.w ) diffuseColor.rgb = outCol;');
  };
  const stats = { chunks: 0, triangles: 0, pending: 0, ms: 0 };
  let opt = { shadows: 1 };

  // The highest of the core's samples within +-s of each node of an s grid
  // (s = 400, 800, 1600 m: every cell the vertex is a corner of), built once
  // from the 200 m samples.
  let pyr = null;
  function buildPyramid() {
    const top = stepOf(LEVELS - 1), margin = 2 * top + RES;
    const gx0 = Math.floor((bounds[0] - margin) / top) * top, gy0 = Math.floor((bounds[1] - margin) / top) * top;
    const nx = Math.ceil((bounds[2] + margin - gx0) / top) * (top / RES) + 1, ny = Math.ceil((bounds[3] + margin - gy0) / top) * (top / RES) + 1;
    let g = new Float32Array(nx * ny);
    for (let b = 0, k = 0; b < ny; ++b) for (let a = 0; a < nx; ++a, ++k) g[k] = groundAt(gx0 + a * RES, gy0 + b * RES);
    // A 3-tap max along x then y on a grid of w x h, kept at every `take`-th node.
    const max3 = (src, w, h, take) => {
      const tmp = new Float32Array(w * h);
      for (let b = 0; b < h; ++b) for (let a = 0; a < w; ++a) { const k = b * w + a; tmp[k] = Math.max(src[k], a > 0 ? src[k - 1] : -Infinity, a < w - 1 ? src[k + 1] : -Infinity); }
      const w2 = Math.floor((w - 1) / take) + 1, h2 = Math.floor((h - 1) / take) + 1, out = new Float32Array(w2 * h2);
      for (let b = 0; b < h2; ++b) for (let a = 0; a < w2; ++a) {
        const k = b * take * w + a * take;
        out[b * w2 + a] = Math.max(tmp[k], b * take > 0 ? tmp[k - w] : -Infinity, b * take < h - 1 ? tmp[k + w] : -Infinity);
      }
      return [out, w2, h2];
    };
    // +-200 m at 200 m spacing, then each step doubles the window and the spacing.
    let [p, w, h] = max3(g, nx, ny, 1);
    g = null;
    pyr = { gx0, gy0, lv: {} };
    for (let s = 2 * RES; s <= top; s *= 2) {
      [p, w, h] = max3(p, w, h, 2);
      pyr.lv[s] = { p, w, h, s };
    }
  }
  // A grid level's value at (x, y), a node of it (clamped to the grid).
  const pyrAt = (L, x, y) => {
    const a = Math.min(L.w - 1, Math.max(0, Math.round((x - pyr.gx0) / L.s))), b = Math.min(L.h - 1, Math.max(0, Math.round((y - pyr.gy0) / L.s)));
    return L.p[b * L.w + a];
  };

  // One chunk: (N+1)^2 vertices, its normals from a ring of samples around it, skirts on its four edges.
  function buildChunk(l, ix, iy) {
    const s = stepOf(l), S = sizeOf(l), x0 = ix * S, y0 = iy * S, cx = x0 + S / 2, cy = y0 + S / 2;
    const L = s > RES ? pyr.lv[s] : null;
    const M = N + 3, hh = new Float32Array(M * M);  // heights with a one-cell margin
    for (let b = 0, k = 0; b < M; ++b) for (let a = 0; a < M; ++a, ++k) {
      const x = x0 + (a - 1) * s, y = y0 + (b - 1) * s;
      hh[k] = L ? pyrAt(L, x, y) : groundAt(x, y);
    }
    const nv = (N + 1) * (N + 1), ns = 4 * N;
    const pos = new Float32Array(3 * (nv + ns)), nor = new Float32Array(3 * (nv + ns)), uv = new Float32Array(2 * (nv + ns));
    const mw = map[2] - map[0], mh = map[3] - map[1];
    const vert = (k, a, b, dz) => {
      const x = x0 + a * s, y = y0 + b * s, c = (b + 1) * M + (a + 1);
      pos[3 * k] = x - cx; pos[3 * k + 1] = hh[c] - drop - dz; pos[3 * k + 2] = -(y - cy);
      const nx = -(hh[c + 1] - hh[c - 1]) / (2 * s), nz = (hh[c + M] - hh[c - M]) / (2 * s), l2 = Math.hypot(nx, 1, nz);
      nor[3 * k] = nx / l2; nor[3 * k + 1] = 1 / l2; nor[3 * k + 2] = nz / l2;
      uv[2 * k] = (x - map[0]) / mw; uv[2 * k + 1] = (y - map[1]) / mh;
    };
    for (let b = 0, k = 0; b <= N; ++b) for (let a = 0; a <= N; ++a, ++k) vert(k, a, b, 0);
    const idx = new Uint16Array(6 * N * N + 6 * 4 * N);
    let q = 0;
    // Each cell split along the diagonal that keeps it above the core's
    // (bilinear) ground: the one through the corners that sum higher.
    for (let b = 0; b < N; ++b) for (let a = 0; a < N; ++a) {
      const v = b * (N + 1) + a, e = v + 1, n = v + N + 1, ne = n + 1;
      if (pos[3 * v + 1] + pos[3 * ne + 1] >= pos[3 * e + 1] + pos[3 * n + 1]) { idx[q++] = v; idx[q++] = e; idx[q++] = ne; idx[q++] = v; idx[q++] = ne; idx[q++] = n; }
      else { idx[q++] = v; idx[q++] = e; idx[q++] = n; idx[q++] = e; idx[q++] = ne; idx[q++] = n; }
    }
    // Skirts: round the edge counter-clockwise seen from above, each edge vertex
    // copied lower; its quads face outward. Deep enough to cover the step
    // to a neighbour drawn at another resolution.
    const depth = 10 + 0.5 * s;
    const ring = [];
    for (let a = 0; a < N; ++a) ring.push([a, 0]);
    for (let b = 0; b < N; ++b) ring.push([N, b]);
    for (let a = N; a > 0; --a) ring.push([a, N]);
    for (let b = N; b > 0; --b) ring.push([0, b]);
    ring.forEach(([a, b], r) => vert(nv + r, a, b, depth));
    for (let r = 0; r < ring.length; ++r) {
      const r2 = (r + 1) % ring.length;
      const A = ring[r][1] * (N + 1) + ring[r][0], B = ring[r2][1] * (N + 1) + ring[r2][0], A2 = nv + r, B2 = nv + r2;
      idx[q++] = A; idx[q++] = A2; idx[q++] = B; idx[q++] = B; idx[q++] = A2; idx[q++] = B2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(cx, 0, -cy);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.userData.ground = true;
    return mesh;
  }

  const chunks = new Map();  // "generation:l,ix,iy" -> { l, ix, iy, x0, y0, S, mesh }
  let want = new Map();       // the leaves wanted now: key -> { l, ix, iy, x0, y0, S, d }
  let last = null, gen = 0;
  const trash = [];  // retired chunks' geometries, freed a few a frame
  const overlaps = (a, b) => a.x0 < b.x0 + b.S && b.x0 < a.x0 + a.S && a.y0 < b.y0 + b.S && b.y0 < a.y0 + a.S;
  function select(ce, cn, agl, view) {
    const out = new Map(), top = LEVELS - 1, S = sizeOf(top);
    const visit = (l, ix, iy) => {
      const s = sizeOf(l), x0 = ix * s, y0 = iy * s;
      if (x0 > bounds[2] || x0 + s < bounds[0] || y0 > bounds[3] || y0 + s < bounds[1]) return;
      const dh = rectDist(ce, cn, x0, y0, s);
      if (dh > view) return;
      const d = Math.hypot(dh, agl);
      if (l > 0 && d < SPLIT[l] * s) { for (let q = 0; q < 4; ++q) visit(l - 1, 2 * ix + (q & 1), 2 * iy + (q >> 1)); return; }
      out.set(`${gen}:${l},${ix},${iy}`, { l, ix, iy, x0, y0, S: s, d: dh });
    };
    for (let iy = Math.floor(bounds[1] / S); iy <= Math.floor(bounds[3] / S); ++iy)
      for (let ix = Math.floor(bounds[0] / S); ix <= Math.floor(bounds[2] / S); ++ix) visit(top, ix, iy);
    return out;
  }
  // Each frame: choose the chunks for the camera at (east, north), agl m above
  // the ground, seeing `view` m; build the missing ones (the nearest first)
  // for at most `budget` ms; swap them in once an area's chunks are all there.
  function update(ce, cn, agl, view, budget = 2, ae = ce, an = cn) {
    const t0 = performance.now();
    if (!pyr) buildPyramid();
    if (!last || Math.hypot(ce - last[0], cn - last[1]) > 100 || Math.abs(agl - last[2]) > 60 || Math.abs(view - last[3]) > 500) {
      want = select(ce, cn, agl, view);
      last = [ce, cn, agl, view];
    }
    const todo = [];
    for (const [k, w] of want) if (!chunks.has(k)) todo.push([w.d, k, w]);
    todo.sort((a, b) => a[0] - b[0]);
    let built = 0;
    for (const [, k, w] of todo) {
      if (built && performance.now() - t0 > budget) break;
      const mesh = buildChunk(w.l, w.ix, w.iy);
      mesh.visible = false;
      group.add(mesh);
      chunks.set(k, { ...w, mesh });
      ++built;
    }
    if (built || todo.length === 0) {
      // Retire a chunk no longer wanted once every wanted chunk over it is built;
      // show a wanted one once nothing it overlaps is still up.
      const old = [];
      for (const [k, c] of chunks) {
        if (want.has(k)) continue;
        let covered = true;
        for (const [k2, w] of want) if (overlaps(c, w) && !chunks.has(k2)) { covered = false; break; }
        if (covered) { group.remove(c.mesh); trash.push(c.mesh.geometry); chunks.delete(k); }
        else old.push(c);
      }
      for (const [k, c] of chunks) {
        if (!want.has(k)) { c.mesh.visible = true; continue; }
        c.mesh.visible = !old.some((o) => overlaps(o, c));
      }
    }
    for (let q = 0; q < 6 && trash.length; ++q) trash.pop().dispose();
    let tri = 0, n = 0;
    const levels = new Array(LEVELS).fill(0);
    for (const c of chunks.values()) {
      if (!c.mesh.visible) continue;
      ++n; tri += c.mesh.geometry.index.count / 3; ++levels[c.l];
      c.mesh.receiveShadow = opt.shadows === 2 || (opt.shadows === 1 && rectDist(ae, an, c.x0, c.y0, c.S) < 1500);
    }
    Object.assign(stats, { chunks: n, triangles: tri, levels, pending: todo.length - built, ms: performance.now() - t0 });
  }
  // The core's ground changed (a far destination joined it): everything
  // again, the chunks up now staying until their replacements are built.
  function rebuild() { ++gen; last = null; pyr = null; }
  // The drawn height at (east, north), for checks: the chunk shown there, by its triangles.
  function heightAt(e, n) {
    for (const c of chunks.values()) {
      if (!c.mesh.visible || e < c.x0 || e > c.x0 + c.S || n < c.y0 || n > c.y0 + c.S) continue;
      const s = stepOf(c.l), fa = (e - c.x0) / s, fb = (n - c.y0) / s, a = Math.min(N - 1, Math.floor(fa)), b = Math.min(N - 1, Math.floor(fb)), u = fa - a, w = fb - b;
      const p = c.mesh.geometry.attributes.position.array, H = (aa, bb) => p[3 * (bb * (N + 1) + aa) + 1];
      // The cell's diagonal as built: v-ne when those corners sum higher, else e-n.
      const h00 = H(a, b), h10 = H(a + 1, b), h01 = H(a, b + 1), h11 = H(a + 1, b + 1);
      const h = h00 + h11 >= h10 + h01
        ? (u >= w ? h00 + u * (h10 - h00) + w * (h11 - h10) : h00 + w * (h01 - h00) + u * (h11 - h01))
        : (u + w <= 1 ? h00 + u * (h10 - h00) + w * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - w) * (h10 - h11));
      return h + drop;
    }
    return NaN;
  }
  return { group, material, update, rebuild, heightAt, stats, setOptions: (o) => { opt = { ...opt, ...o }; } };
}
