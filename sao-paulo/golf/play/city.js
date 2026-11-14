// São Paulo World · Golf: the city around the course. The ground is the
// world's 50 m SRTM grid (flying/terrain_sp_city.avt.gz, the one the flight
// test bed flies over) with the São Paulo World map mosaic draped where it
// covers; the buildings are the flight test bed's (flying/buildings.js: every
// OpenStreetMap building near the course, the skyline beyond it), none drawn
// on the course itself.
//
// Placement: the course frame (x east, z south) has its origin at site east
// E0, north N0, so a site point (E, N) is at scene x = E - E0, z = N0 - N.
import * as THREE from 'three';
import { buildCity } from '../../flying/buildings.js';

const MX0 = -6750, MX1 = 5250, MY0 = -8750, MY1 = 15250;  // the mosaic's extent (site frame), as flying/app.js

async function fetchAvt(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ': ' + r.status);
  let b = new Uint8Array(await r.arrayBuffer());
  if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'AVT1') throw new Error('not an AVT1 grid');
  const nx = v.getInt32(4, true), ny = v.getInt32(8, true);
  const e0 = v.getFloat64(12, true), n0 = v.getFloat64(20, true), sp = v.getFloat64(28, true), sc = v.getFloat64(36, true);
  const h = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) h[k] = v.getInt16(44 + 2 * k, true) * sc;
  return (e, n) => {
    const fx = Math.min(Math.max((e - e0) / sp, 0), nx - 1.0001), fy = Math.min(Math.max((n - n0) / sp, 0), ny - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, w = fy - j, k = j * nx + i;
    return (h[k] * (1 - u) + h[k + 1] * u) * (1 - w) + (h[k + nx] * (1 - u) + h[k + nx + 1] * u) * w;
  };
}

export async function buildSurroundings({ info, renderer, mobile, courseHeight }) {
  const group = new THREE.Group();
  group.name = 'city';
  const [E0, N0] = info.site;
  const [bx0, bz0, bx1, bz1] = info.bounds;
  let groundAt;
  try {
    groundAt = await fetchAvt('../../flying/terrain_sp_city.avt.gz');
  } catch (e) {
    console.warn('city terrain', e);
    return { group, update() {} };
  }
  // The ground: rings of a grid around the course, finer near it.
  const material = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  const mapBox = new THREE.Vector4(MX0 - E0, N0 - MY1, MX1 - E0, N0 - MY0);  // scene x0, z0, x1, z1
  material.onBeforeCompile = (sh) => {
    sh.uniforms.mapBox = { value: mapBox };
    sh.uniforms.outCol = { value: new THREE.Color('#6f7a5c') };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vXZ;\nuniform vec4 mapBox;\nuniform vec3 outCol;')
      .replace('#include <map_fragment>', '#include <map_fragment>\nif ( vXZ.x < mapBox.x || vXZ.x > mapBox.z || vXZ.y < mapBox.y || vXZ.y > mapBox.w ) diffuseColor.rgb = outCol;');
  };
  new THREE.TextureLoader().load(mobile ? '../../img/mosaic_world_sm.jpg' : '../../img/mosaic_world.jpg', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    material.map = t;
    material.needsUpdate = true;
  });
  const ring = (half, step, holeHalf) => {
    const n = Math.round((2 * half) / step) + 1;
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
    const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
    for (let r = 0, k = 0; r < n; r++) for (let c = 0; c < n; c++, k++) {
      const x = cx - half + c * step, z = cz - half + r * step;
      const E = x + E0, N = N0 - z;
      let y = groundAt(E, N);
      // Under the course the course's own ground is drawn: sink this one out of sight.
      if (x > bx0 + 1 && x < bx1 - 1 && z > bz0 + 1 && z < bz1 - 1) y = courseHeight(x, z) - 4;
      pos.set([x, y - 0.15, z], 3 * k);
      uv.set([(E - MX0) / (MX1 - MX0), (N - MY0) / (MY1 - MY0)], 2 * k);
    }
    const idx = [];
    for (let r = 0; r + 1 < n; r++) for (let c = 0; c + 1 < n; c++) {
      const x = cx - half + (c + 0.5) * step, z = cz - half + (r + 0.5) * step;
      if (holeHalf && Math.abs(x - cx) < holeHalf && Math.abs(z - cz) < holeHalf) continue;
      const a = r * n + c, b = a + 1, e = a + n, f = e + 1;
      idx.push(a, e, b, b, e, f);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, material);
    m.receiveShadow = false;
    return m;
  };
  group.add(ring(mobile ? 2500 : 3500, 50, 0));
  group.add(ring(14000, 250, mobile ? 2400 : 3400));
  // The buildings, placed in the course frame; none on the course.
  const city = buildCity({ base: '../../flying/buildings/', groundAt, mobile, maxAniso: renderer.capabilities.getMaxAnisotropy(),
    options: { detail: mobile ? 1500 : 2500, skyline: Infinity, shadows: 0 }, clear: [bx0 - 15, bz0 - 15, bx1 + 15, bz1 + 15] });
  city.group.position.set(-E0, 0, N0);
  group.add(city.group);
  return {
    group,
    groundAt: (x, z) => groundAt(x + E0, N0 - z),
    update(camera, viewDistance) {
      city.update(camera.position.x + E0, N0 - camera.position.z, Math.max(0, camera.position.y - 730), viewDistance);
    },
  };
}
