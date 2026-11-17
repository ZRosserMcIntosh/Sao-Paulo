// São Paulo World · Golf: the course in three.js, drawn from the same rasters
// the Golf Dynamics core plays on (heights at 1 m, surfaces at 0.5 m), so the
// ball rolls on exactly the ground that is drawn.
//
// Frame: x east, y up, z south (the core's course frame). The city around the
// course (city.js) is placed in the same frame.
import * as THREE from 'three';

// Catmull-Rom bicubic, as the core's HeightGrid::sample.
export function heightSampler(info, heights) {
  const { nx, nz, x0, z0, cell } = info.height;
  const at = (i, j) => heights[Math.min(Math.max(j, 0), nz - 1) * nx + Math.min(Math.max(i, 0), nx - 1)];
  const w = (t) => { const t2 = t * t, t3 = t2 * t; return [0.5 * (-t3 + 2 * t2 - t), 0.5 * (3 * t3 - 5 * t2 + 2), 0.5 * (-3 * t3 + 4 * t2 + t), 0.5 * (t3 - t2)]; };
  return (x, z) => {
    const fx = Math.min(Math.max((x - x0) / cell, 0), nx - 1.000001), fz = Math.min(Math.max((z - z0) / cell, 0), nz - 1.000001);
    const i = Math.floor(fx), j = Math.floor(fz), wx = w(fx - i), wz = w(fz - j);
    let v = 0;
    for (let b = 0; b < 4; b++) { let row = 0; for (let a = 0; a < 4; a++) row += wx[a] * at(i - 1 + a, j - 1 + b); v += wz[b] * row; }
    return v;
  };
}

// Deterministic hash noise for texture variation.
function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const s = xf * xf * (3 - 2 * xf), t = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * s + (c - a) * t + (a - b - c + d) * s * t;
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// The surface texture: the surface raster painted with mowing stripes along each
// hole, mottled rough, raked sand.
function surfaceTexture(info, surfaces, scale, maxAniso) {
  const { nx, nz, x0, z0, cell } = info.surface;
  const W = Math.ceil(nx / scale), H = Math.ceil(nz / scale);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const img = g.createImageData(W, H);
  const pal = info.surfaces.map((s) => hex(s.color));
  const ids = Object.fromEntries(info.surfaces.map((s, i) => [s.id, i]));
  // Mowing direction per hole: each segment of its line.
  const segs = [];
  info.holes.forEach((h) => { for (let k = 1; k < h.line.length; k++) segs.push([h.line[k - 1], h.line[k]]); });
  const stripeAt = (x, z) => {
    let best = Infinity, coord = 0;
    for (const [a, b] of segs) {
      const vx = b[0] - a[0], vz = b[1] - a[1], L = Math.hypot(vx, vz);
      const t = Math.min(Math.max(((x - a[0]) * vx + (z - a[1]) * vz) / (L * L), 0), 1);
      const d = Math.hypot(x - a[0] - t * vx, z - a[1] - t * vz);
      if (d < best) { best = d; coord = (x - a[0]) * (-vz / L) + (z - a[1]) * (vx / L); }
    }
    return coord;
  };
  const d = img.data;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const si = Math.min(Math.floor(i * scale), nx - 1), sj = Math.min(Math.floor(j * scale), nz - 1);
      const s = surfaces[sj * nx + si];
      const x = x0 + (si + 0.5) * cell, z = z0 + (sj + 0.5) * cell;
      let [r, gg, b] = pal[s] || [80, 120, 60];
      let f = 1;
      const n1 = vnoise(x / 6, z / 6), n2 = vnoise(x / 1.3, z / 1.3);
      if (s === ids.fairway || s === ids.tee) {
        f *= (Math.floor(stripeAt(x, z) / 7) & 1) ? 1.07 : 0.95;
        f *= 0.97 + 0.06 * n1;
      } else if (s === ids.green) {
        f *= (Math.floor(stripeAt(x, z) / 3.5) & 1) ? 1.04 : 0.97;
        f *= 0.98 + 0.04 * n2;
      } else if (s === ids.fringe) {
        f *= 0.97 + 0.05 * n2;
      } else if (s === ids.rough || s === ids.deep_rough) {
        f *= 0.85 + 0.25 * n1 + 0.08 * n2;
      } else if (s === ids.native) {
        f *= 0.8 + 0.35 * n1 + 0.1 * n2;
        gg *= 0.95 + 0.1 * vnoise(x / 20, z / 20);
      } else if (s === ids.bunker) {
        f *= 0.93 + 0.07 * n2 + 0.03 * Math.sin((x + z) * 2.2);
      } else if (s === ids.water) {
        f *= 0.95 + 0.06 * n1;
      } else if (s === ids.path) {
        f *= 0.95 + 0.08 * n2;
      }
      const k = (j * W + i) * 4;
      d[k] = Math.min(255, r * f); d[k + 1] = Math.min(255, gg * f); d[k + 2] = Math.min(255, b * f); d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function terrainChunk(H, info, xa, za, xb, zb, step, mat) {
  const cols = Math.round((xb - xa) / step) + 1, rows = Math.round((zb - za) / step) + 1;
  const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2);
  const [bx0, bz0, bx1, bz1] = info.bounds;
  const sw = info.surface.nx * info.surface.cell, sh = info.surface.nz * info.surface.cell;
  for (let r = 0, k = 0; r < rows; r++) for (let c = 0; c < cols; c++, k++) {
    const x = xa + c * step, z = za + r * step;
    pos[3 * k] = x; pos[3 * k + 1] = H(x, z); pos[3 * k + 2] = z;
    uv[2 * k] = (x - info.surface.x0) / sw; uv[2 * k + 1] = 1 - (z - info.surface.z0) / sh;
  }
  const idx = [];
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    const a = r * cols + c, b = a + 1, e = a + cols, f = e + 1;
    idx.push(a, e, b, b, e, f);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  void bx0; void bz0; void bx1; void bz1;
  return m;
}

// Trees: one instanced trunk and one instanced crown per kind.
// Kinds: 0 sibipiruna, 1 ipê-amarelo, 2 ipê-roxo, 3 jerivá palm, 4 eucalyptus, 5 araucaria.
function buildTrees(trees, mobile) {
  const group = new THREE.Group();
  group.name = 'trees';
  const n = trees.length / 9;
  const crownCols = ['#2f5f2a', '#e7c42c', '#b660b8', '#3f6b2d', '#6f8a66', '#24452a'];
  const trunkGeo = new THREE.CylinderGeometry(0.75, 1, 1, 6, 1);
  trunkGeo.translate(0, 0.5, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1, mobile ? 0 : 1);
  const palmGeo = new THREE.ConeGeometry(1, 0.6, 7, 1, true);
  const trunkMat = new THREE.MeshLambertMaterial({ color: '#6b5440' });
  const counts = new Array(6).fill(0);
  for (let k = 0; k < n; k++) counts[trees[9 * k + 8] | 0]++;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
  trunks.castShadow = !mobile;
  const crowns = counts.map((c, kind) => {
    const mat = new THREE.MeshLambertMaterial({ color: crownCols[kind], flatShading: true });
    const m = new THREE.InstancedMesh(kind === 3 ? palmGeo : crownGeo, mat, Math.max(c, 1));
    m.count = 0;
    m.castShadow = !mobile;
    return m;
  });
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), C = new THREE.Color();
  for (let k = 0; k < n; k++) {
    const [x, y, z, tr, th, cy, crx, cry, kindF] = trees.subarray(9 * k, 9 * k + 9);
    const kind = kindF | 0;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(k, 7) * 6.283);
    P.set(x, y - 0.3, z); S.set(tr, kind === 3 ? cy : th + 0.3, tr);
    M.compose(P, q, S); trunks.setMatrixAt(k, M);
    const cm = crowns[kind];
    P.set(x, y + cy, z); S.set(crx, kind === 3 ? cry * 0.9 : cry, crx);
    if (kind === 3) P.y = y + cy + 0.2;
    M.compose(P, q, S);
    const i = cm.count++;
    cm.setMatrixAt(i, M);
    C.set(crownCols[kind]).offsetHSL(0, 0, (hash(k, 3) - 0.5) * 0.12);
    cm.setColorAt(i, C);
  }
  group.add(trunks, ...crowns);
  return group;
}

// A flag on a pole, the cloth waving in the wind (vertex animation).
function makeFlag(color = '#f2c230') {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.0127, 0.0127, 2.13, 6), new THREE.MeshLambertMaterial({ color: '#f4f4f0' }));
  pole.position.y = 2.13 / 2;
  g.add(pole);
  const clothGeo = new THREE.PlaneGeometry(0.5, 0.34, 8, 2);
  clothGeo.translate(0.25, 0, 0);
  const cloth = new THREE.Mesh(clothGeo, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  cloth.position.y = 2.13 - 0.18;
  g.add(cloth);
  const base = clothGeo.attributes.position.array.slice();
  g.userData.wave = (t, windDir, windSpeed) => {
    cloth.rotation.y = -windDir;
    const p = clothGeo.attributes.position.array, amp = 0.02 + 0.012 * Math.min(windSpeed, 10);
    for (let k = 0; k < p.length; k += 3) {
      const u = base[k] / 0.5;
      p[k + 2] = Math.sin(t * (4 + windSpeed * 0.6) - u * 5) * amp * u;
    }
    clothGeo.attributes.position.needsUpdate = true;
  };
  // The hole: a dark disc a fraction above the green.
  const cup = new THREE.Mesh(new THREE.CircleGeometry(0.054, 24), new THREE.MeshBasicMaterial({ color: '#0b0d0b' }));
  cup.rotation.x = -Math.PI / 2;
  cup.position.y = 0.004;
  g.add(cup);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.054, 0.062, 24), new THREE.MeshBasicMaterial({ color: '#f4f4f0' }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.003;
  g.add(ring);
  g.userData.pole = pole;
  g.userData.cloth = cloth;
  return g;
}

function skyDome() {
  const geo = new THREE.SphereGeometry(30000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color('#3f7cc4') }, mid: { value: new THREE.Color('#9cc6ea') }, bottom: { value: new THREE.Color('#dfe9ee') } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, pow(clamp(h,0.,1.), 0.6)) : mix(mid, bottom, clamp(-h*6.,0.,1.)); gl_FragColor = vec4(c, 1.0); }',
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -1;
  m.frustumCulled = false;
  return m;
}

export function buildCourseScene({ info, heights, surfaces, trees, renderer, mobile }) {
  const group = new THREE.Group();
  const H = heightSampler(info, heights);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const tex = surfaceTexture(info, surfaces, mobile ? 2 : 1, maxAniso);
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const [bx0, bz0, bx1, bz1] = info.bounds;
  const step = mobile ? 4 : 2, chunk = 128;
  for (let za = bz0; za < bz1; za += chunk) for (let xa = bx0; xa < bx1; xa += chunk) {
    group.add(terrainChunk(H, info, xa, za, Math.min(xa + chunk, bx1), Math.min(za + chunk, bz1), step, mat));
  }
  // Fine patches over the greens, so the borrow a putt follows is what is drawn.
  const greenMat = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const h of info.holes) {
    const g = h.green, r = Math.max(g.rx, g.rz) + 6;
    const xa = Math.floor(g.x - r), za = Math.floor(g.z - r);
    group.add(terrainChunk(H, info, xa, za, xa + Math.ceil(2 * r), za + Math.ceil(2 * r), mobile ? 1 : 0.5, greenMat));
  }
  // Water surfaces over each lake.
  const waterMat = new THREE.MeshPhongMaterial({ color: '#2f6f8d', specular: '#cfe6f2', shininess: 80, transparent: true, opacity: 0.88 });
  for (const h of info.holes) for (const lake of h.lakes) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z, rx, rz] of lake.lobes) { const r = Math.max(rx, rz) + 3; x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); }
    const w = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), waterMat);
    w.rotation.x = -Math.PI / 2;
    w.position.set((x0 + x1) / 2, lake.level + 0.03, (z0 + z1) / 2);
    group.add(w);
  }
  group.add(buildTrees(trees, mobile));
  // Tee markers.
  const teeCols = { blue: '#2d6be0', white: '#f2f2f2', red: '#d93a2e' };
  for (const h of info.holes) for (const t of h.tees) {
    const m = new THREE.MeshLambertMaterial({ color: teeCols[t.name] || '#f2c230' });
    const s = new THREE.Vector3(Math.sin(t.heading), 0, -Math.cos(t.heading));  // across the tee
    const fwd = new THREE.Vector3(Math.cos(t.heading), 0, Math.sin(t.heading));
    for (const side of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), m);
      const x = t.pos[0] + s.x * side * 2.5 + fwd.x * 2.5, z = t.pos[2] + s.z * side * 2.5 + fwd.z * 2.5;
      b.position.set(x, H(x, z) + 0.08, z);
      group.add(b);
    }
  }
  const flag = makeFlag();
  group.add(flag);
  return { group, H, flag, texture: tex };
}

export { makeFlag, skyDome };
