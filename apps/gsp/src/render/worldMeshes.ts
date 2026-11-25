// Static world geometry built once from the same track, ground and layout the physics uses.
import * as THREE from 'three';
import type { Simulation } from '../sim/Simulation';
import { XS } from '../sim/world/track';
import { SURF } from '../sim/world/terrain';
import { asphaltTexture, billboardFace, concreteTexture, detailTexture, guideSign, padMarkings, padTexture, shoulderTexture } from './textures';
import { mergeGeometries } from './carModel';

export interface Quality { terrainCell: number; trees: number; shadows: number; pixelRatio: number; post: boolean; rain: number; reflections: boolean; name: string }
export const QUALITY: Record<string, Quality> = {
  low: { name: 'low', terrainCell: 8, trees: 0.35, shadows: 1024, pixelRatio: 0.75, post: false, rain: 1500, reflections: false },
  medium: { name: 'medium', terrainCell: 6, trees: 0.65, shadows: 2048, pixelRatio: 1, post: false, rain: 3000, reflections: true },
  high: { name: 'high', terrainCell: 4, trees: 1, shadows: 2048, pixelRatio: 1.5, post: true, rain: 5000, reflections: true },
  ultra: { name: 'ultra', terrainCell: 3, trees: 1, shadows: 4096, pixelRatio: 2, post: true, rain: 8000, reflections: true },
};

const PAVED = new Set<number>([SURF.ASPHALT, SURF.SHOULDER, SURF.CONCRETE, SURF.PAD, SURF.COUNTY, SURF.DECK]);

export function buildTerrain(sim: Simulation, q: Quality): THREE.Mesh {
  const g = sim.ground;
  const step = q.terrainCell;
  const nx = Math.floor(((g.nx - 1) * g.cell) / step) + 1, nz = Math.floor(((g.nz - 1) * g.cell) / step) + 1;
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  const c = new THREE.Color();
  const grass = [new THREE.Color('#5b7330'), new THREE.Color('#6f8536'), new THREE.Color('#7d8a3c'), new THREE.Color('#4f6a2c')];
  const clay = [new THREE.Color('#a2492a'), new THREE.Color('#b65a33'), new THREE.Color('#8f3f24')];
  const gravel = new THREE.Color('#8b8378'), paved = new THREE.Color('#3b3b3d'), ditch = new THREE.Color('#4d6a2a');
  for (let j = 0; j < nz; ++j) for (let i = 0; i < nx; ++i) {
    const x = g.minX + i * step, z = g.minZ + j * step;
    const k = j * nx + i;
    let y = g.heightAt(x, z);
    // sample the class around the vertex (worst case: paved lowers the render mesh under the roads)
    let cls = g.classAt(x, z), anyPaved = PAVED.has(cls);
    for (const [dx, dz] of [[-step / 2, 0], [step / 2, 0], [0, -step / 2], [0, step / 2]]) if (PAVED.has(g.classAt(x + dx, z + dz))) anyPaved = true;
    if (anyPaved) y -= 0.35;
    pos[3 * k] = x; pos[3 * k + 1] = y; pos[3 * k + 2] = z;
    const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
    if (cls === SURF.CLAY) c.copy(clay[Math.floor(h * 3)]);
    else if (cls === SURF.GRAVEL) c.copy(gravel).lerp(grass[1], 0.3);
    else if (PAVED.has(cls)) c.copy(paved);
    else if (cls === SURF.DITCH) c.copy(ditch);
    else {
      c.copy(grass[Math.floor(h * 4)]);
      // dry patches and pine straw
      const n = Math.sin(x * 0.03) * Math.cos(z * 0.027) + Math.sin(x * 0.11 + z * 0.07) * 0.3;
      if (n > 0.7) c.lerp(new THREE.Color('#8f7a45'), 0.45);
    }
    col[3 * k] = c.r; col[3 * k + 1] = c.g; col[3 * k + 2] = c.b;
    uv[2 * k] = x / 6; uv[2 * k + 1] = z / 6;
  }
  const idx: number[] = [];
  for (let j = 0; j + 1 < nz; ++j) for (let i = 0; i + 1 < nx; ++i) {
    const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const tex = detailTexture();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, map: tex });
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  return m;
}

// A ribbon along the interstate between offsets d0..d1 (signed), with UVs in metres.
function ribbon(sim: Simulation, d0: number, d1: number, lift: number, s0 = 0, s1?: number, step = 2, across = 1): THREE.BufferGeometry {
  const tr = sim.track;
  const end = s1 ?? tr.length;
  const n = Math.ceil((end - s0) / step);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const smp = tr.sampleAt(0);
  const cols = across + 1;
  for (let k = 0; k <= n; ++k) {
    const s = s0 + Math.min(k * step, end - s0);
    tr.sampleInto(s, smp);
    for (let a = 0; a <= across; ++a) {
      const d = d0 + ((d1 - d0) * a) / across;
      pos.push(smp.x + smp.rx * d, tr.heightAt(s, d, smp) + lift, smp.z + smp.rz * d);
      uv.push(d / 4, s / 4);
    }
    if (k < n) for (let a = 0; a < across; ++a) {
      const i0 = k * cols + a, i1 = i0 + 1, j0 = i0 + cols, j1 = j0 + 1;
      // +s, +d (right) -> face up when ordered (i0, j0, i1)
      if (d1 > d0) idx.push(i0, i1, j0, i1, j1, j0); else idx.push(i0, j0, i1, i1, j0, j1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // ensure normals point up
  const nor = g.getAttribute('normal').array as Float32Array;
  if (nor[1] < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  return g;
}

export function buildRoads(sim: Simulation): THREE.Group {
  const grp = new THREE.Group();
  const asphalt = new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.88, metalness: 0, color: '#ffffff' });
  const shoulder = new THREE.MeshStandardMaterial({ map: shoulderTexture(), roughness: 0.92, color: '#ffffff' });
  const concrete = new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.85, color: '#ffffff' });
  const lanes = mergeGeometries([ribbon(sim, XS.innerShoulder, XS.lanesEnd, 0.03, 0, undefined, 2, 3), ribbon(sim, -XS.innerShoulder, -XS.lanesEnd, 0.03, 0, undefined, 2, 3)]);
  const shoulders = mergeGeometries([
    ribbon(sim, XS.median, XS.innerShoulder, 0.028), ribbon(sim, -XS.median, -XS.innerShoulder, 0.028),
    ribbon(sim, XS.lanesEnd, XS.outerShoulder, 0.028, 0, undefined, 2, 2), ribbon(sim, -XS.lanesEnd, -XS.outerShoulder, 0.028, 0, undefined, 2, 2),
  ]);
  const tr = sim.track;
  const urban = ribbon(sim, -XS.median, XS.median, 0.026, tr.overpassS - 450, tr.overpassS + 450, 2, 2);
  for (const [g, m] of [[lanes, asphalt], [shoulders, shoulder], [urban, concrete]] as const) {
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    grp.add(mesh);
  }
  // markings: yellow left edge, white right edge, dashed lane lines (10 ft dash, 30 ft gap)
  const white = new THREE.MeshStandardMaterial({ color: '#f2f2ea', roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
  const yellow = new THREE.MeshStandardMaterial({ color: '#f2c218', roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
  const wl: THREE.BufferGeometry[] = [], yl: THREE.BufferGeometry[] = [];
  for (const sg of [1, -1]) {
    yl.push(ribbon(sim, sg * (XS.innerShoulder + 0.02), sg * (XS.innerShoulder + 0.17), 0.045, 0, undefined, 3));
    wl.push(ribbon(sim, sg * (XS.lanesEnd - 0.17), sg * (XS.lanesEnd - 0.02), 0.045, 0, undefined, 3));
    for (const lane of [1, 2]) {
      const d = XS.innerShoulder + lane * XS.laneWidth;
      for (let s = 0; s < tr.length - 3; s += 12.2) wl.push(ribbon(sim, sg * (d - 0.075), sg * (d + 0.075), 0.045, s, s + 3.05, 3.05));
    }
  }
  grp.add(new THREE.Mesh(mergeGeometries(wl), white), new THREE.Mesh(mergeGeometries(yl), yellow));
  for (const c of grp.children) (c as THREE.Mesh).receiveShadow = true;
  return grp;
}

export function buildCountyRoadAndPad(sim: Simulation): THREE.Group {
  const grp = new THREE.Group();
  const f = sim.features, g = sim.ground, op = f.overpass;
  // county road strip (both ramps), heights from the ground
  const strip = (u0: number, u1: number, v0: number, v1: number, lift: number) => {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const n = Math.ceil(Math.abs(u1 - u0) / 2);
    for (let k = 0; k <= n; ++k) {
      const u = u0 + ((u1 - u0) * k) / n;
      for (const v of [v0, v1]) {
        const x = op.x + op.ux * u + op.vx * v, z = op.z + op.uz * u + op.vz * v;
        const yy = Math.abs(u) < op.halfSpan ? f.deckY : g.heightAt(x - op.vx * v * 0.05, z - op.vz * v * 0.05);
        pos.push(x, yy + lift, z);
        uv.push(v / 4, u / 4);
      }
      if (k < n) { const a = 2 * k; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const nor = geo.getAttribute('normal').array as Float32Array;
    if (nor[1] < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } geo.setIndex(idx); geo.computeVertexNormals(); }
    return geo;
  };
  const asphalt = new THREE.MeshStandardMaterial({ map: shoulderTexture(), roughness: 0.9 });
  const roads = mergeGeometries([strip(op.halfSpan, f.countyEnd, -op.halfWidth, op.halfWidth, 0.04), strip(-op.halfSpan, -f.countyEnd, -op.halfWidth, op.halfWidth, 0.04), strip(-op.halfSpan, op.halfSpan, -op.halfWidth, op.halfWidth, 0.03)]);
  const rm = new THREE.Mesh(roads, asphalt);
  rm.receiveShadow = true;
  grp.add(rm);
  const yellow = new THREE.MeshStandardMaterial({ color: '#f2c218', roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
  const lines = mergeGeometries([strip(op.halfSpan, f.countyEnd, -0.12, 0.12, 0.055), strip(-op.halfSpan, -f.countyEnd, -0.12, 0.12, 0.055), strip(-op.halfSpan, op.halfSpan, -0.12, 0.12, 0.045)]);
  grp.add(new THREE.Mesh(lines, yellow));

  // the test pad: a flat slab with markings
  const pd = f.pad;
  const W = pd.a1 - pd.a0, H = pd.b1 - pd.b0;
  const padGeo = new THREE.PlaneGeometry(W, H, 1, 1);
  padGeo.rotateX(-Math.PI / 2);
  const padMat = new THREE.MeshStandardMaterial({ map: padTexture(), roughness: 0.85 });
  padMat.map = padMat.map!.clone(); padMat.map.repeat.set(W / 8, H / 8); padMat.map.needsUpdate = true;
  const pad = new THREE.Mesh(padGeo, padMat);
  const cx = (pd.a0 + pd.a1) / 2, cb = (pd.b0 + pd.b1) / 2;
  pad.position.set(pd.x + pd.ax * cx + pd.bx * cb, pd.y + 0.02, pd.z + pd.az * cx + pd.bz * cb);
  // local x along a, local -z along b: yaw so that +x = a
  pad.rotation.y = Math.atan2(-pd.az, pd.ax);
  pad.receiveShadow = true;
  // the plane's local +z (after rotateX) is world -b or +b depending on handedness: check and flip
  const test = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), pad.rotation.y);
  const flip = test.x * pd.bx + test.z * pd.bz < 0;
  grp.add(pad);
  const mk = new THREE.Mesh(padGeo.clone(), new THREE.MeshStandardMaterial({ map: padMarkings(), transparent: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }));
  mk.position.copy(pad.position); mk.position.y += 0.01; mk.rotation.copy(pad.rotation);
  if (!flip) mk.scale.z = -1;
  grp.add(mk);
  // apron to the interstate
  {
    const tr = sim.track;
    const pos: number[] = [], idx: number[] = [], uvs: number[] = [];
    const n = 40;
    for (let k = 0; k <= n; ++k) {
      const a = -68 + (136 * k) / n;
      for (const b of [XS.outerShoulder - 0.2, pd.b0 + 0.5]) {
        const x = pd.x + pd.ax * a + pd.bx * b, z = pd.z + pd.az * a + pd.bz * b;
        pos.push(x, g.heightAt(x, z) + 0.035, z); uvs.push(a / 4, b / 4);
      }
      if (k < n) { const i = 2 * k; idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const nor = geo.getAttribute('normal').array as Float32Array;
    if (nor[1] < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } geo.setIndex(idx); geo.computeVertexNormals(); }
    const m = new THREE.Mesh(geo, padMat.clone());
    (m.material as THREE.MeshStandardMaterial).map = padTexture();
    m.receiveShadow = true;
    grp.add(m);
    void tr;
  }
  return grp;
}

export function buildOverpass(sim: Simulation): THREE.Group {
  const grp = new THREE.Group();
  const f = sim.features, op = f.overpass;
  const concrete = new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.82, color: '#e4dfd4' });
  const yaw = Math.atan2(-op.uz, op.ux);
  const put = (m: THREE.Mesh, x: number, y: number, z: number) => { m.position.set(x, y, z); m.rotation.y = yaw; m.castShadow = true; m.receiveShadow = true; grp.add(m); return m; };
  const deckThick = 1.3;
  put(new THREE.Mesh(new THREE.BoxGeometry(op.halfSpan * 2 + 0.4, deckThick, op.halfWidth * 2 + 1.2), concrete), op.x, f.deckY - deckThick / 2 - 0.01, op.z);
  // girders under the deck
  for (const v of [-4, -1.4, 1.4, 4]) put(new THREE.Mesh(new THREE.BoxGeometry(op.halfSpan * 2, 0.9, 0.5), concrete), op.x + op.vx * v, f.deckY - deckThick - 0.45, op.z + op.vz * v);
  // parapets
  for (const s of [1, -1]) put(new THREE.Mesh(new THREE.BoxGeometry(op.halfSpan * 2 + 0.4, 1.1, 0.4), concrete), op.x + op.vx * s * (op.halfWidth + 0.35), f.deckY + 0.55, op.z + op.vz * s * (op.halfWidth + 0.35));
  // centre piers and cap beam (in the median)
  for (const s of [-1, 1]) {
    const h = f.deckY - deckThick - 0.9 - op.y + 0.4;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.65, h, 20), concrete);
    p.position.set(op.x + op.vx * s * 3.2, op.y - 0.4 + h / 2, op.z + op.vz * s * 3.2);
    p.castShadow = true; p.receiveShadow = true;
    grp.add(p);
  }
  put(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 9.5), concrete), op.x, f.deckY - deckThick - 1.3, op.z);
  // abutments
  for (const us of [1, -1]) {
    const hy = (f.deckY - op.y) + 2;
    put(new THREE.Mesh(new THREE.BoxGeometry(2.0, hy, op.halfWidth * 2 + 12), concrete), op.x + op.ux * us * (op.halfSpan + 0.6), op.y + hy / 2 - 1.5, op.z + op.uz * us * (op.halfSpan + 0.6));
  }
  // overhead guide signs facing each carriageway's traffic
  const signMat = new THREE.MeshStandardMaterial({ map: guideSign(), roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0.05, emissiveMap: guideSign() });
  for (const s of [1, -1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(8, 3.1), signMat);
    // on the parapet facing traffic on the carriageway whose travel direction is s * tangent
    const side = s; // right carriageway (d > 0) travels +s: its sign is on the -v face, centred over d = +14
    const d = side * 14;
    m.position.set(op.x + op.ux * d - op.vx * side * (op.halfWidth + 0.62), f.deckY + 1.1, op.z + op.uz * d - op.vz * side * (op.halfWidth + 0.62));
    m.rotation.y = Math.atan2(op.vx * side, op.vz * side) + Math.PI;
    grp.add(m);
    const back = new THREE.Mesh(new THREE.BoxGeometry(8.1, 3.2, 0.08), new THREE.MeshStandardMaterial({ color: '#888', metalness: 0.8, roughness: 0.4 }));
    back.position.copy(m.position).addScaledVector(new THREE.Vector3(op.vx * side, 0, op.vz * side), 0.06);
    back.rotation.copy(m.rotation);
    grp.add(back);
  }
  return grp;
}

export function buildBarriersAndRails(sim: Simulation): { group: THREE.Group; rails: THREE.InstancedMesh; posts: THREE.InstancedMesh; update: () => void } {
  const grp = new THREE.Group();
  const L = sim.layout;
  const concrete = new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.8, color: '#d9d4c8' });
  // jersey barrier: extrude the profile along the run
  const prof: [number, number][] = [[-0.3, 0], [-0.3, 0.08], [-0.2, 0.33], [-0.08, 0.9], [0.08, 0.9], [0.2, 0.33], [0.3, 0.08], [0.3, 0]];
  const geos: THREE.BufferGeometry[] = [];
  for (const run of L.rails) {
    if (run.kind !== 'barrier') continue;
    const pos: number[] = [], idx: number[] = [];
    const m = prof.length;
    run.pts.forEach((p, k) => {
      const a = run.pts[Math.max(0, k - 1)], b = run.pts[Math.min(run.pts.length - 1, k + 1)];
      let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const rx = -tz, rz = tx;
      for (const [d, y] of prof) pos.push(p.x + rx * d, p.y + y - 0.05, p.z + rz * d);
      if (k + 1 < run.pts.length) for (let j = 0; j + 1 < m; ++j) { const i0 = k * m + j, i1 = i0 + 1, j0 = i0 + m, j1 = j0 + 1; idx.push(i0, j0, i1, i1, j0, j1); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    geos.push(g);
  }
  for (const g of geos) { const mesh = new THREE.Mesh(g, concrete); mesh.castShadow = true; mesh.receiveShadow = true; mesh.material.side = THREE.DoubleSide; grp.add(mesh); }
  // guardrail W-beam segments (instanced, dented per segment) and posts
  const segs = sim.phys.railSegments.filter((s) => L.rails[s.run].kind === 'guardrail');
  const beamGeo = new THREE.BoxGeometry(1, 0.32, 0.08);
  // corrugate: push the middle row of vertices
  const beamMat = new THREE.MeshStandardMaterial({ color: '#b9bec4', metalness: 0.85, roughness: 0.38 });
  const rails = new THREE.InstancedMesh(beamGeo, beamMat, Math.max(1, segs.length));
  const postGeo = new THREE.BoxGeometry(0.15, 1.0, 0.15);
  const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: '#8c9096', metalness: 0.7, roughness: 0.5 }), Math.max(1, segs.length * 2));
  rails.castShadow = true; posts.castShadow = true; rails.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const update = () => {
    segs.forEach((sg, i) => {
      const run = L.rails[sg.run];
      // push back away from the road (the side the run is on), tilt a little
      const side = run.side || 1;
      const nx = Math.sin(sg.yaw) * side, nz = Math.cos(sg.yaw) * side; // normal in x-z for a segment along (cos yaw, -sin yaw)
      p.set(sg.x + nx * sg.offset, sg.y + 0.62 - sg.tilt * 0.3, sg.z + nz * sg.offset);
      e.set(sg.tilt * side * 0.6, sg.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      s.set(sg.len + 0.08, 1, 1);
      m.compose(p, q, s);
      rails.setMatrixAt(i, m);
      for (const k of [0, 1]) {
        const off = (k - 0.5) * sg.len * 0.5;
        p.set(sg.x + Math.cos(sg.yaw) * off + nx * (0.12 + sg.offset * 0.6), sg.y + 0.4, sg.z - Math.sin(sg.yaw) * off + nz * (0.12 + sg.offset * 0.6));
        e.set(sg.tilt * side * 0.8, sg.yaw, 0, 'YXZ'); q.setFromEuler(e); s.set(1, 1, 1);
        m.compose(p, q, s);
        posts.setMatrixAt(2 * i + k, m);
      }
    });
    rails.instanceMatrix.needsUpdate = true;
    posts.instanceMatrix.needsUpdate = true;
  };
  update();
  grp.add(rails, posts);
  return { group: grp, rails, posts, update };
}

export function buildTrees(sim: Simulation, q: Quality): THREE.Group {
  const grp = new THREE.Group();
  const trees = sim.layout.trees.filter((_, i) => (i % 1000) / 1000 < q.trees);
  const pines = trees.filter((t) => t.kind === 0), oaks = trees.filter((t) => t.kind === 1);
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.22, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#5a4030', roughness: 0.95 });
  const crown = mergeGeometries([
    new THREE.ConeGeometry(0.42, 0.38, 7).translate(0, 0.66, 0),
    new THREE.ConeGeometry(0.36, 0.3, 7).translate(0, 0.8, 0),
    new THREE.ConeGeometry(0.26, 0.24, 7).translate(0, 0.93, 0),
    new THREE.IcosahedronGeometry(0.3, 0).translate(0.1, 0.62, 0.05),
  ]);
  const crownMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, vertexColors: false, flatShading: true });
  const oakCrown = new THREE.IcosahedronGeometry(0.5, 1).translate(0, 0.62, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const crowns = new THREE.InstancedMesh(crown, crownMat, Math.max(1, pines.length));
  const oakM = new THREE.InstancedMesh(oakCrown, crownMat, Math.max(1, oaks.length));
  const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
  trees.forEach((t, i) => {
    qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.tint * 6.28);
    p.set(t.x, t.y - 0.3, t.z);
    s.set(t.r * 0.35, t.h * (t.kind === 0 ? 0.72 : 0.45), t.r * 0.35);
    m.compose(p, qq, s);
    trunks.setMatrixAt(i, m);
  });
  pines.forEach((t, i) => {
    qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.tint * 6.28);
    p.set(t.x, t.y - 0.3, t.z);
    s.set(t.r * 2.2, t.h, t.r * 2.2);
    m.compose(p, qq, s);
    crowns.setMatrixAt(i, m);
    c.setHSL(0.27 + t.tint * 0.05, 0.38 + t.tint * 0.15, 0.17 + t.tint * 0.07);
    crowns.setColorAt(i, c);
  });
  oaks.forEach((t, i) => {
    p.set(t.x, t.y - 0.3, t.z);
    s.set(t.r * 2.4, t.h * 0.8, t.r * 2.4);
    m.compose(p, qq, s);
    oakM.setMatrixAt(i, m);
    c.setHSL(0.22 + t.tint * 0.06, 0.45, 0.22 + t.tint * 0.06);
    oakM.setColorAt(i, c);
  });
  for (const im of [trunks, crowns, oakM]) { im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; grp.add(im); }
  return grp;
}

export function buildBillboardsAndPoles(sim: Simulation): THREE.Group {
  const grp = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#7b7f85', metalness: 0.8, roughness: 0.45 });
  for (const b of sim.layout.billboards) {
    const g = new THREE.Group();
    g.position.set(b.x, b.y, b.z);
    g.rotation.y = b.heading - Math.PI / 2;
    for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 9, 10), metal); p.position.set(s * 3.5, 4.5 - 0.5, -0.3); p.castShadow = true; g.add(p); }
    const face = new THREE.Mesh(new THREE.PlaneGeometry(12, 4.5), new THREE.MeshStandardMaterial({ map: billboardFace(b.text, b.sub, b.color), roughness: 0.6 }));
    face.position.set(0, 9.5, 0);
    face.castShadow = true;
    g.add(face);
    const backing = new THREE.Mesh(new THREE.BoxGeometry(12.3, 4.8, 0.2), metal);
    backing.position.set(0, 9.5, -0.13);
    g.add(backing);
    const catwalk = new THREE.Mesh(new THREE.BoxGeometry(12, 0.08, 0.9), metal);
    catwalk.position.set(0, 7.1, 0.3);
    g.add(catwalk);
    grp.add(g);
  }
  // median light poles
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.2, 12, 8).translate(0, 6, 0);
  const armGeo = new THREE.BoxGeometry(5, 0.12, 0.12).translate(0, 11.8, 0);
  const lampGeo = new THREE.BoxGeometry(0.8, 0.18, 0.35);
  const lamps = new THREE.MeshStandardMaterial({ color: '#ddd', emissive: '#fff4d0', emissiveIntensity: 0.3 });
  for (const l of sim.layout.lights) {
    const g = new THREE.Group();
    g.position.set(l.x, l.y + 0.85, l.z);
    g.rotation.y = l.heading + Math.PI / 2;
    const pole = new THREE.Mesh(poleGeo, metal); pole.castShadow = true; g.add(pole);
    const arm = new THREE.Mesh(armGeo, metal); g.add(arm);
    for (const s of [-1, 1]) { const lamp = new THREE.Mesh(lampGeo, lamps); lamp.position.set(s * 2.5, 11.7, 0); g.add(lamp); }
    grp.add(g);
  }
  return grp;
}
