// Procedural vehicles. The body is lofted from cross-sections along the car (a profile line, a
// plan-view width and a section shape), the greenhouse is a second loft whose faces are sorted
// into painted roof and pillars, black trim and separate glass panes (so windows can break one by
// one). Bumper covers, mirrors, the light bar and the push bar are separate parts that can fall
// off. Built in the car's ground frame (+X forward, +Y up, +Z right, y = 0 on the road), then
// offset so the model's origin is the physics body's origin (the centre of mass).
import * as THREE from 'three';
import type { VehicleLook } from '../sim/vehicle/catalog';
import type { PartId, WindowId } from '../sim/vehicle/damage';
import { policeLivery, roofNumber } from './textures';

interface Profile {
  L: number; W: number; H: number; gc: number;
  xf: number; xr: number; tireR: number; tireW: number; trackF: number; trackR: number;
  noseY: number; hoodY: number; beltF: number; beltR: number; deckY: number; tailY: number;
  sillY: number; chinY: number; tailBottomY: number;
  wsX: number; rfX: number; rrX: number; rwX: number; roofY: number; tumble: number;
  bX: number; cX: number; frontRound: number; rearRound: number; style: VehicleLook['style'];
}

function profileFor(look: VehicleLook, wheelbase: number, frontWeight: number, tireR: number, trackF: number, trackR: number): Profile {
  const L = look.length, W = look.width, H = look.height, gc = look.groundClearance;
  // axles: the CoM sits wheelbase * (1 - frontWeight) behind the front axle; the body is
  // positioned so the overhangs look right
  const xf = L / 2 - (look.style === 'pickup' ? 0.95 : look.style === 'hatch' ? 0.82 : 0.95);
  const xr = xf - wheelbase;
  void frontWeight;
  const base = { L, W, H, gc, xf, xr, tireR, tireW: tireR > 0.38 ? 0.29 : 0.25, trackF, trackR, style: look.style };
  switch (look.style) {
    case 'pickup':
      return { ...base, noseY: 1.08, hoodY: 1.22, beltF: 1.26, beltR: 1.3, deckY: 1.28, tailY: 1.24, sillY: gc + 0.12, chinY: gc + 0.1, tailBottomY: gc + 0.28,
        wsX: L / 2 - 1.75, rfX: L / 2 - 2.35, rrX: L / 2 - 3.3, rwX: L / 2 - 3.4, roofY: H, tumble: 0.14, bX: L / 2 - 2.75, cX: L / 2 - 3.28, frontRound: 0.25, rearRound: 0.12 };
    case 'suv':
      return { ...base, noseY: 0.9, hoodY: 1.08, beltF: 1.12, beltR: 1.18, deckY: 1.18, tailY: 1.12, sillY: gc + 0.1, chinY: gc + 0.12, tailBottomY: gc + 0.3,
        wsX: L / 2 - 1.42, rfX: L / 2 - 2.05, rrX: -L / 2 + 0.38, rwX: -L / 2 + 0.12, roofY: H, tumble: 0.16, bX: L / 2 - 2.55, cX: -L / 2 + 0.55, frontRound: 0.4, rearRound: 0.2 };
    case 'van':
      return { ...base, noseY: 0.92, hoodY: 1.02, beltF: 1.05, beltR: 1.1, deckY: 1.12, tailY: 1.08, sillY: gc + 0.1, chinY: gc + 0.1, tailBottomY: gc + 0.28,
        wsX: L / 2 - 1.05, rfX: L / 2 - 1.95, rrX: -L / 2 + 0.3, rwX: -L / 2 + 0.1, roofY: H, tumble: 0.14, bX: L / 2 - 2.35, cX: -L / 2 + 0.5, frontRound: 0.45, rearRound: 0.18 };
    case 'hatch':
      return { ...base, noseY: 0.72, hoodY: 0.92, beltF: 0.95, beltR: 1.0, deckY: 0.98, tailY: 0.98, sillY: gc + 0.1, chinY: gc + 0.1, tailBottomY: gc + 0.28,
        wsX: L / 2 - 1.1, rfX: L / 2 - 1.85, rrX: -L / 2 + 0.55, rwX: -L / 2 + 0.18, roofY: H, tumble: 0.17, bX: L / 2 - 2.25, cX: -L / 2 + 0.78, frontRound: 0.42, rearRound: 0.2 };
    default: // sedan (the interceptor is a sedan with a long hood and a short deck)
      return { ...base, noseY: 0.74, hoodY: 0.97, beltF: 0.99, beltR: 1.05, deckY: 1.04, tailY: 1.0, sillY: gc + 0.1, chinY: gc + 0.08, tailBottomY: gc + 0.3,
        wsX: L / 2 - 1.75, rfX: L / 2 - 2.55, rrX: L / 2 - 3.5, rwX: L / 2 - 4.05, roofY: H, tumble: 0.21, bX: L / 2 - 2.9, cX: L / 2 - 3.45, frontRound: 0.42, rearRound: 0.3 };
  }
}

// smooth piecewise interpolation through (x, y) points sorted by x (monotone cubic)
function curve(pts: [number, number][]) {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  return (x: number) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[p.length - 1][0]) return p[p.length - 1][1];
    let i = 0;
    while (p[i + 1][0] < x) ++i;
    const [x0, y0] = p[i], [x1, y1] = p[i + 1];
    const t = (x - x0) / (x1 - x0), s = t * t * (3 - 2 * t);
    return y0 + (y1 - y0) * s;
  };
}

type Mat = 'paint' | 'paint2' | 'trim' | 'chrome' | 'glass' | 'black' | 'tonneau';

class MeshBuilder {
  pos: number[] = []; nor: number[] = []; uv: number[] = [];
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ua?: number[], ub?: number[], uc?: number[], ud?: number[]) {
    // a-b-c-d counter-clockwise seen from outside
    this.tri(a, b, c, ua, ub, uc);
    this.tri(a, c, d, ua, uc, ud);
  }
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ua?: number[], ub?: number[], uc?: number[]) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.uv.push(...(ua ?? [0, 0]), ...(ub ?? [0, 0]), ...(uc ?? [0, 0]));
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    smoothNormals(g);
    return g;
  }
  get empty() { return this.pos.length === 0; }
}

export interface CarMaterials { paint: THREE.MeshPhysicalMaterial; paint2: THREE.MeshPhysicalMaterial; livery: THREE.MeshPhysicalMaterial | null; trim: THREE.MeshStandardMaterial; chrome: THREE.MeshStandardMaterial; glass: THREE.MeshPhysicalMaterial; black: THREE.MeshStandardMaterial; tonneau: THREE.MeshStandardMaterial; tire: THREE.MeshStandardMaterial; rim: THREE.MeshStandardMaterial; head: THREE.MeshStandardMaterial; tail: THREE.MeshStandardMaterial; reverse: THREE.MeshStandardMaterial; lensRed: THREE.MeshStandardMaterial; lensBlue: THREE.MeshStandardMaterial; lensWhite: THREE.MeshStandardMaterial; amber: THREE.MeshStandardMaterial }

export interface CarModel {
  root: THREE.Group;
  bodyMeshes: THREE.Mesh[];
  original: Map<THREE.BufferGeometry, Float32Array>;
  wheels: { pivot: THREE.Group; spin: THREE.Group; hubcap: THREE.Object3D | null }[];
  windows: Partial<Record<WindowId | 'sideRL' | 'sideRR', THREE.Mesh>>;
  parts: Partial<Record<PartId, THREE.Object3D>>;
  heads: THREE.Mesh[]; // [L, R]
  tails: THREE.Mesh[]; // [L, R]
  reverse: THREE.Mesh[];
  bar: { mesh: THREE.Mesh; color: 'red' | 'blue' | 'white'; phase: number }[];
  barLights: THREE.PointLight[];
  mats: CarMaterials;
  profile: Profile;
  offsetY: number; // model ground level in the body frame (= -CoM height)
  dentVersion: number;
}

export function makeMaterials(look: VehicleLook, paint: string): CarMaterials {
  const police = look.police;
  const mk = (c: string, metal = 0.55, rough = 0.32) => new THREE.MeshPhysicalMaterial({ color: c, metalness: metal, roughness: rough, clearcoat: 1, clearcoatRoughness: 0.06 });
  const livery = police ? new THREE.MeshPhysicalMaterial({ color: '#ffffff', map: policeLivery('71'), metalness: 0.5, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 }) : null;
  const e = (c: string, emissive: string, i: number) => new THREE.MeshStandardMaterial({ color: c, emissive, emissiveIntensity: i, roughness: 0.25, metalness: 0.1 });
  return {
    paint: mk(paint),
    paint2: mk(look.paint2 ?? paint, 0.6, 0.28),
    livery,
    trim: new THREE.MeshStandardMaterial({ color: '#0d0e10', roughness: 0.55, metalness: 0.2 }),
    chrome: new THREE.MeshStandardMaterial({ color: '#d6d8dc', roughness: 0.15, metalness: 1 }),
    glass: new THREE.MeshPhysicalMaterial({ color: police ? '#06090c' : '#121a22', metalness: 0.35, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: police ? 0.92 : 0.82, envMapIntensity: 1.4 }),
    black: new THREE.MeshStandardMaterial({ color: '#141518', roughness: 0.7, metalness: 0.05 }),
    tonneau: new THREE.MeshStandardMaterial({ color: '#1c1d1f', roughness: 0.85 }),
    tire: new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.92, metalness: 0 }),
    rim: new THREE.MeshStandardMaterial({ color: look.wheel, roughness: police ? 0.45 : 0.22, metalness: police ? 0.6 : 0.95 }),
    head: e('#f4f6ff', '#fff6e0', 2.2),
    tail: e('#5a0606', '#ff1a12', 0.7),
    reverse: e('#dddddd', '#ffffff', 0),
    lensRed: e('#3a0505', '#ff1010', 0),
    lensBlue: e('#05103a', '#1a4dff', 0),
    lensWhite: e('#cccccc', '#ffffff', 0),
    amber: e('#6a3a00', '#ff9a10', 0.4),
  };
}

export function buildCar(look: VehicleLook, paint: string, wheels: { x: number; z: number; radius: number }[], cgHeight: number, wheelbase: number, frontWeight: number): CarModel {
  const trackF = wheels.length > 1 ? Math.abs(wheels[1].z - wheels[0].z) : look.width - 0.3;
  const trackR = wheels.length > 3 ? Math.abs(wheels[3].z - wheels[2].z) : trackF;
  const tireR = wheels[0]?.radius ?? 0.34;
  const P = profileFor(look, wheelbase, frontWeight, tireR, trackF, trackR);
  // match the drawn axles to the physics wheels (body frame x)
  if (wheels.length >= 4) { P.xf = wheels[0].x; P.xr = wheels[2].x; }
  const mats = makeMaterials(look, paint);
  const root = new THREE.Group();
  const model = new THREE.Group();
  model.position.y = -cgHeight;
  root.add(model);
  const bodyMeshes: THREE.Mesh[] = [];
  const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = model, dentable = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    if (dentable) bodyMeshes.push(mesh);
    return mesh;
  };

  const { L, W } = P;
  const hw = W / 2;
  // ---------- lower body ----------
  const topY = curve([
    [L / 2, P.noseY], [L / 2 - 0.18, P.noseY + 0.05], [L / 2 - 0.6, P.noseY + (P.hoodY - P.noseY) * 0.55], [P.wsX, P.hoodY],
    [P.wsX - 0.3, P.beltF], [P.rwX + 0.2, P.beltR], [P.rwX, P.deckY], [-L / 2 + 0.25, P.tailY + 0.02], [-L / 2, P.tailY],
  ]);
  const archR = tireR + 0.06;
  const botY = (x: number) => {
    let y = x > L / 2 - 0.5 ? P.chinY + (x - (L / 2 - 0.5)) * 0.22 : x < -L / 2 + 0.55 ? P.sillY + (-L / 2 + 0.55 - x) * 0.35 : P.sillY;
    for (const ax of [P.xf, P.xr]) {
      const dx = x - ax;
      if (Math.abs(dx) < archR) y = Math.max(y, tireR + Math.sqrt(archR * archR - dx * dx) - 0.02);
    }
    return y;
  };
  const halfW = (x: number) => {
    const f = L / 2 - P.frontRound, r = -L / 2 + P.rearRound;
    let w = hw;
    // superelliptic plan-view corners: the nose and tail wrap round instead of ending in a slab
    if (x > f) { const t = Math.min(1, (x - f) / P.frontRound); w = hw * (0.66 + 0.34 * Math.pow(Math.max(0, 1 - Math.pow(t, 2.6)), 1 / 2.6)); }
    if (x < r) { const t = Math.min(1, (r - x) / P.rearRound); w = hw * (0.7 + 0.3 * Math.pow(Math.max(0, 1 - Math.pow(t, 2.6)), 1 / 2.6)); }
    return w;
  };
  // the last few centimetres of the body curl in top and bottom (no flat end slab)
  const endCurl = (x: number) => {
    const df = L / 2 - x, dr = x + L / 2;
    const e = Math.min(df, dr);
    return e < 0.09 ? (1 - e / 0.09) ** 2 : 0;
  };
  // section (right half), from bottom centre around to top centre; returns [z, y][]
  const section = (w: number, yb: number, yt: number, crown: number, bulge: number, rb: number, rt: number): [number, number][] => {
    const pts: [number, number][] = [];
    const h = Math.max(0.02, yt - yb);
    rb = Math.min(rb, h * 0.3); rt = Math.min(rt, h * 0.45);
    pts.push([0, yb], [w * 0.55, yb]);
    for (let k = 0; k <= 3; ++k) { const a = -Math.PI / 2 + (k / 3) * (Math.PI / 2); pts.push([w - rb + Math.cos(a) * rb - 0.03, yb + rb + Math.sin(a) * rb]); }
    for (let k = 1; k <= 4; ++k) { const t = k / 5, y = yb + rb + (yt - rt - yb - rb) * t; pts.push([w + bulge * Math.sin(Math.PI * t) - 0.012 * (1 - t), y]); }
    for (let k = 0; k <= 4; ++k) { const a = (k / 4) * (Math.PI / 2); pts.push([w - rt + Math.cos(a) * rt, yt - rt + Math.sin(a) * rt]); }
    pts.push([w * 0.5, yt + crown * 0.75], [0, yt + crown]);
    return pts;
  };
  const ringToVec = (x: number, s: [number, number][]) => {
    const right = s.map(([z, y]) => new THREE.Vector3(x, y, z));
    const left = [...s].reverse().map(([z, y]) => new THREE.Vector3(x, y, -z));
    return [...left.slice(0, -1), ...right]; // from top centre (left side down), bottom, up the right side
  };
  const stations: number[] = [];
  // denser near the ends, where the shape changes fastest
  for (let k = 0; k <= 80; ++k) { const u = k / 80, e = 0.5 - 0.5 * Math.cos(Math.PI * u); stations.push(-L / 2 + (0.35 * u + 0.65 * e) * L); }
  mats.black.side = THREE.DoubleSide;
  const lower = { paint: new MeshBuilder(), black: new MeshBuilder(), tonneau: new MeshBuilder() };
  const rings: THREE.Vector3[][] = stations.map((x) => {
    const c = endCurl(x), yb = botY(x), yt = topY(x), h = yt - yb;
    return ringToVec(x, section(halfW(x) * (1 - 0.12 * c), yb + h * 0.16 * c, yt - h * 0.12 * c, x > P.wsX ? 0.03 : 0.012, x > P.xf + 0.4 || x < P.xr - 0.5 ? 0.01 : 0.022, 0.05, x > P.wsX ? 0.16 : 0.1));
  });
  const isPolice = look.police;
  for (let i = 0; i + 1 < rings.length; ++i) {
    const a = rings[i], b = rings[i + 1];
    for (let j = 0; j + 1 < a.length; ++j) {
      const p0 = a[j], p1 = a[j + 1], q0 = b[j], q1 = b[j + 1];
      const cx = (p0.x + q1.x) / 2, cy = (p0.y + p1.y + q0.y + q1.y) / 4, cz = (p0.z + p1.z + q0.z + q1.z) / 4;
      // outward normal estimate
      const n = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(q0, p0), new THREE.Vector3().subVectors(p1, p0)).normalize();
      const side = Math.abs(n.z) > 0.55;
      const yb = botY(cx), yt = topY(cx);
      const vloc = Math.min(1, Math.max(0, (cy - yb) / Math.max(0.05, yt - yb)));
      const lowerTrim = cy < P.sillY + 0.13 || (cx > L / 2 - 0.12 && cy < P.noseY - 0.18) || (cx < -L / 2 + 0.1 && cy < P.tailBottomY + 0.12);
      let target = lower.paint;
      if (lowerTrim) target = lower.black;
      if (P.style === 'pickup' && !side && n.y > 0.6 && cx < P.rwX - 0.05 && cx > -L / 2 + 0.08 && Math.abs(cz) < hw - 0.08) target = lower.tonneau;
      const uvOf = (v: THREE.Vector3) => {
        if (!side) return [0.02, 0.4];
        const vl = Math.min(1, Math.max(0, (v.y - botY(v.x)) / Math.max(0.05, topY(v.x) - botY(v.x))));
        return v.z > 0 ? [(v.x + L / 2) / L, 0.5 * vl] : [(L / 2 - v.x) / L, 0.5 + 0.5 * vl];
      };
      void vloc;
      // orientation: (p0, q0, q1, p1) faces outward with rings ordered top-left -> bottom -> top-right
      target.quad(p0, q0, q1, p1, uvOf(p0), uvOf(q0), uvOf(q1), uvOf(p1));
    }
  }
  // end caps
  const cap = (ring: THREE.Vector3[], front: boolean, mb: MeshBuilder) => {
    const c = new THREE.Vector3();
    ring.forEach((p) => c.add(p));
    c.multiplyScalar(1 / ring.length);
    for (let j = 0; j + 1 < ring.length; ++j) front ? mb.tri(c, ring[j + 1], ring[j]) : mb.tri(c, ring[j], ring[j + 1]);
  };
  cap(rings[0], false, lower.paint);
  cap(rings[rings.length - 1], true, lower.paint);
  const lowerMesh = add(lower.paint.geometry(), isPolice && mats.livery ? mats.livery : mats.paint);
  add(lower.black.geometry(), mats.trim);
  if (!lower.tonneau.empty) add(lower.tonneau.geometry(), mats.tonneau);
  void lowerMesh;

  // ---------- greenhouse ----------
  const roofTop = P.roofY;
  const gTop = curve([
    [P.wsX, P.beltF + 0.01], [(P.wsX + P.rfX) / 2, (P.beltF + roofTop) / 2 + 0.06], [P.rfX, roofTop - 0.015], [(P.rfX + P.rrX) / 2, roofTop],
    [P.rrX, roofTop - 0.02], [(P.rrX + P.rwX) / 2, (roofTop + P.deckY) / 2 + 0.05], [P.rwX, P.deckY + 0.01],
  ]);
  const aPillarX = (y: number) => P.wsX + (P.rfX - P.wsX) * Math.min(1, Math.max(0, (y - P.beltF) / (roofTop - P.beltF)));
  const cPillarX = (y: number) => P.rwX + (P.rrX - P.rwX) * Math.min(1, Math.max(0, (y - P.beltR) / (roofTop - P.beltR)));
  const gh: Record<string, MeshBuilder> = {};
  const B = (k: string) => (gh[k] ??= new MeshBuilder());
  const gStations: number[] = [];
  for (let k = 0; k <= 46; ++k) gStations.push(P.rwX + (k / 46) * (P.wsX - P.rwX));
  const gSection = (x: number): [number, number][] => {
    const yb = topY(x) - 0.01, yt = Math.max(yb + 0.005, gTop(x));
    const wb = halfW(x) - 0.075, wr = wb - P.tumble;
    const rt = Math.min(0.12, (yt - yb) * 0.4);
    const pts: [number, number][] = [[wb, yb]];
    for (let k = 1; k <= 5; ++k) { const t = k / 5; pts.push([wb + (wr - wb) * t, yb + (yt - rt - yb) * t]); }
    for (let k = 1; k <= 4; ++k) { const a = (k / 4) * (Math.PI / 2); pts.push([wr - rt + Math.cos(a) * rt, yt - rt + Math.sin(a) * rt]); }
    pts.push([(wr - rt) * 0.5, yt + 0.02], [0, yt + 0.025]);
    return pts;
  };
  const gRings = gStations.map((x) => {
    const s = gSection(x);
    const right = s.map(([z, y]) => new THREE.Vector3(x, y, z));
    const left = [...s].reverse().map(([z, y]) => new THREE.Vector3(x, y, -z));
    return [...left.slice(0, -1), ...right];
  });
  const hasLong = P.style === 'suv' || P.style === 'van' || P.style === 'hatch';
  for (let i = 0; i + 1 < gRings.length; ++i) {
    const a = gRings[i], b = gRings[i + 1];
    for (let j = 0; j + 1 < a.length; ++j) {
      const p0 = a[j], p1 = a[j + 1], q0 = b[j], q1 = b[j + 1];
      const cx = (p0.x + p1.x + q0.x + q1.x) / 4, cy = (p0.y + p1.y + q0.y + q1.y) / 4, cz = (p0.z + p1.z + q0.z + q1.z) / 4;
      const n = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(q0, p0), new THREE.Vector3().subVectors(p1, p0)).normalize();
      const right = cz > 0;
      let k: string;
      const top = n.y > 0.8;
      const sideFace = Math.abs(n.z) > 0.5;
      if (cx > P.rfX - 0.02 && !sideFace && n.x > 0.15) {
        k = Math.abs(cz) > hw - P.tumble - 0.16 ? 'trim' : 'windscreen';
      } else if (cx < P.rrX + 0.02 && !sideFace && n.x < -0.1) {
        k = Math.abs(cz) > hw - P.tumble - (hasLong ? 0.14 : 0.2) ? 'roofpaint' : 'rear';
      } else if (top) {
        k = 'roofpaint';
      } else if (sideFace) {
        const glassTop = gTop(cx) - 0.07;
        if (cy > glassTop) k = 'roofpaint';
        else if (cx > aPillarX(cy) - 0.07) k = 'trim';
        else if (cx < (hasLong ? P.cX : cPillarX(cy) + 0.12)) k = 'roofpaint';
        else if (Math.abs(cx - P.bX) < 0.06) k = 'trim';
        else if (cx > P.bX) k = right ? 'sideR' : 'sideL';
        else k = right ? 'sideRR' : 'sideRL';
      } else k = 'roofpaint';
      B(k).quad(p0, q0, q1, p1);
    }
  }
  const windows: CarModel['windows'] = {};
  const roofMat = isPolice ? mats.paint2 : mats.paint;
  for (const [k, mb] of Object.entries(gh)) {
    if (mb.empty) continue;
    const m = k === 'roofpaint' ? roofMat : k === 'trim' ? mats.trim : mats.glass;
    const mesh = add(mb.geometry(), m);
    if (k === 'windscreen') windows.windscreen = mesh;
    else if (k === 'rear') windows.rear = mesh;
    else if (k === 'sideL') windows.sideL = mesh;
    else if (k === 'sideR') windows.sideR = mesh;
    else if (k === 'sideRL') windows.sideRL = mesh;
    else if (k === 'sideRR') windows.sideRR = mesh;
    if (m === mats.glass) mesh.renderOrder = 2;
  }

  // ---------- lights ----------
  const heads: THREE.Mesh[] = [], tails: THREE.Mesh[] = [], reverse: THREE.Mesh[] = [];
  const front = L / 2, rear = -L / 2;
  for (const s of [-1, 1]) {
    // headlight: a swept lens on the front corner
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.1, P.style === 'pickup' ? 0.2 : 0.11, P.style === 'pickup' ? 0.32 : 0.42), mats.head.clone());
    hl.position.set(front - 0.1, P.noseY - 0.04, s * (hw - 0.27));
    hl.rotation.y = s * -0.32;
    model.add(hl);
    heads.push(hl);
    // turn signal / DRL strip
    const drl = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.025, 0.36), mats.amber);
    drl.position.set(front - 0.07, P.noseY - 0.12, s * (hw - 0.3));
    drl.rotation.y = s * -0.32;
    model.add(drl);
    // tail light: on the rear face, under the curl of the deck
    const racetrack = isPolice || look.name.includes('Thunderbolt');
    const capHalf = hw * 0.7 * 0.86;
    const ty = P.tailY - 0.17;
    const tl = new THREE.Mesh(roundedBox(0.05, racetrack ? 0.075 : 0.15, racetrack ? capHalf - 0.04 : 0.3, 0.02), mats.tail.clone());
    tl.position.set(rear - 0.004, ty, racetrack ? s * (capHalf - 0.04) / 2 : s * (capHalf - 0.2));
    model.add(tl);
    tails.push(tl);
    const rv = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.045, 0.1), mats.reverse.clone());
    rv.position.set(rear - 0.002, ty - 0.11, s * (capHalf - 0.25));
    model.add(rv);
    reverse.push(rv);
  }
  // a lip spoiler on the deck of the sedans
  if (P.style === 'sedan') {
    const sp = new THREE.Mesh(roundedBox(0.12, 0.035, W - 0.5, 0.015), isPolice ? mats.paint : mats.paint);
    sp.position.set(-L / 2 + 0.16, P.tailY + 0.035, 0);
    sp.rotation.z = 0.12;
    model.add(sp);
    bodyMeshes.push(sp);
  }
  // grille
  {
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.06, P.style === 'pickup' ? 0.36 : 0.16, P.style === 'pickup' ? W * 0.55 : W * 0.42), mats.trim);
    g.position.set(front - 0.04, P.noseY - (P.style === 'pickup' ? 0.18 : 0.1), 0);
    model.add(g);
    // slats (the "crosshair" is a lawyer's problem; these are horizontal)
    for (let k = 0; k < 3; ++k) {
      const sl = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, (P.style === 'pickup' ? W * 0.55 : W * 0.42) - 0.04), mats.chrome);
      sl.position.set(front - 0.005, P.noseY - 0.06 - k * 0.04 - (P.style === 'pickup' ? 0.08 : 0), 0);
      model.add(sl);
    }
  }

  // ---------- detachable parts ----------
  const parts: CarModel['parts'] = {};
  const partGroup = (id: PartId, cx: number, cy: number, cz: number) => {
    const g = new THREE.Group();
    g.position.set(cx, cy + cgHeight, cz); // given in body frame; model is offset by -cg
    model.add(g);
    parts[id] = g;
    return g;
  };
  const gcb = look.groundClearance - cgHeight; // ground level in the body frame + gc
  {
    // front bumper cover: body colour with a black lower lip
    const g = partGroup('bumperF', L / 2 - 0.12, gcb + 0.32, 0);
    const m1 = new THREE.Mesh(roundedBox(0.26, 0.24, W - 0.12, 0.08), mats.paint);
    m1.position.set(0.0, 0.04, 0);
    const m2 = new THREE.Mesh(roundedBox(0.24, 0.08, W - 0.28, 0.03), mats.trim);
    m2.position.set(0.02, -0.12, 0);
    g.add(m1, m2);
    // fog lights
    for (const s of [-1, 1]) { const f = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 16), mats.lensWhite); f.rotation.z = Math.PI / 2; f.position.set(0.12, -0.03, s * (hw - 0.3)); g.add(f); }
    m1.castShadow = true;
    bodyMeshes.push(m1);
  }
  {
    const g = partGroup('bumperR', -L / 2 + 0.12, gcb + 0.35, 0);
    const m1 = new THREE.Mesh(roundedBox(0.26, 0.24, W - 0.1, 0.08), mats.paint);
    const m2 = new THREE.Mesh(roundedBox(0.2, 0.07, W - 0.5, 0.03), mats.trim);
    m2.position.set(-0.04, -0.13, 0);
    // dual exhaust
    for (const s of [-1, 1]) { const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 16, 1, true), mats.chrome); ex.rotation.z = Math.PI / 2; ex.position.set(-0.1, -0.15, s * (hw - 0.38)); g.add(ex); }
    g.add(m1, m2);
    bodyMeshes.push(m1);
  }
  for (const s of [-1, 1] as const) {
    const id: PartId = s < 0 ? 'mirrorL' : 'mirrorR';
    const mx = P.wsX - 0.12;
    const g = partGroup(id, mx, topY(mx) + 0.09 - cgHeight, s * (hw + 0.1));
    const housing = new THREE.Mesh(roundedBox(0.16, 0.12, 0.2, 0.04), isPolice ? mats.trim : mats.paint);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.12), mats.trim);
    arm.position.set(0.02, -0.04, -s * 0.11);
    g.add(housing, arm);
  }
  if (isPolice) {
    // push bar
    const g = partGroup('pushbar', L / 2 + 0.12, gcb + 0.45, 0);
    const tube = (x: number, y: number, z: number, len: number, axis: 'x' | 'y' | 'z') => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 10), mats.trim);
      if (axis === 'z') m.rotation.x = Math.PI / 2;
      if (axis === 'x') m.rotation.z = Math.PI / 2;
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
    };
    for (const s of [-1, 1]) { tube(0, 0, s * 0.42, 0.62, 'y'); tube(-0.12, -0.25, s * 0.42, 0.25, 'x'); }
    tube(0, 0.25, 0, 0.9, 'z'); tube(0, -0.05, 0, 0.9, 'z'); tube(0, -0.25, 0, 0.84, 'z');
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.12), mats.black);
    for (const s of [-1, 1]) { const p = pad.clone(); p.position.set(0.03, 0, s * 0.42); g.add(p); }
    // push-bar lights
    for (const s of [-1, 1]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.14), s < 0 ? mats.lensRed : mats.lensBlue); l.position.set(0.035, 0.12, s * 0.2); g.add(l); }
  }
  // light bar (police) or antenna
  const bar: CarModel['bar'] = [];
  const barLights: THREE.PointLight[] = [];
  const roofX = (P.rfX + P.rrX) / 2 + 0.15;
  if (isPolice) {
    const g = partGroup('lightbar', roofX, gcb - look.groundClearance + roofTop + 0.07, 0);
    const base = new THREE.Mesh(roundedBox(0.3, 0.07, 1.3, 0.03), mats.trim);
    base.position.y = -0.03;
    g.add(base);
    const n = 8;
    for (let k = 0; k < n; ++k) {
      const z = -0.6 + (k + 0.5) * (1.2 / n);
      const color: 'red' | 'blue' | 'white' = k < n / 2 ? 'red' : 'blue';
      const lens = new THREE.Mesh(roundedBox(0.26, 0.07, 1.2 / n - 0.012, 0.02), (color === 'red' ? mats.lensRed : mats.lensBlue).clone());
      lens.position.set(0, 0.035, z);
      g.add(lens);
      bar.push({ mesh: lens, color, phase: k });
    }
    for (const s of [-1, 1]) {
      const tk = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.1), mats.lensWhite.clone());
      tk.position.set(0.15, 0.035, s * 0.12);
      g.add(tk);
      bar.push({ mesh: tk, color: 'white', phase: s });
    }
    // roof number
    const rn = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshStandardMaterial({ map: roofNumber('71'), roughness: 0.4, transparent: true, opacity: 0.95, polygonOffset: true, polygonOffsetFactor: -2 }));
    rn.rotation.x = -Math.PI / 2; rn.rotation.z = Math.PI / 2;
    rn.position.set(roofX - 0.55, roofTop + 0.031 - cgHeight + cgHeight, 0);
    model.add(rn);
    // rear deck and grille lights
    for (const s of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.26), (s < 0 ? mats.lensRed : mats.lensBlue).clone());
      d.position.set(P.rwX + 0.25, P.deckY + 0.11, s * 0.4);
      model.add(d);
      bar.push({ mesh: d, color: s < 0 ? 'red' : 'blue', phase: 3 + s });
    }
    // spotlight on the A pillar
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 12), mats.chrome);
    sp.rotation.z = Math.PI / 2;
    sp.position.set(P.wsX - 0.15, P.beltF + 0.18, -hw + 0.02);
    model.add(sp);
    // antennas
    for (const z of [-0.25, 0.3]) { const a = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.006, 0.45, 6), mats.trim); a.position.set(P.rrX + 0.1, roofTop + 0.22, z); model.add(a); }
  } else {
    const g = partGroup('antenna', -L / 2 * 0.4, gcb - look.groundClearance + roofTop + 0.1, 0.3);
    const a = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.007, 0.36, 6), mats.trim);
    g.add(a);
  }
  if (P.style === 'pickup') {
    const g = partGroup('tailgate', -L / 2 + 0.06, gcb + 0.75, 0);
    const tg = new THREE.Mesh(roundedBox(0.08, 0.5, W - 0.16, 0.02), mats.paint);
    g.add(tg);
    bodyMeshes.push(tg);
  }

  // ---------- wheels ----------
  const wheelsOut: CarModel['wheels'] = [];
  for (let k = 0; k < 4; ++k) {
    const w = wheels[k] ?? { x: k < 2 ? P.xf : P.xr, z: (k % 2 ? 1 : -1) * trackF / 2, radius: tireR };
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    pivot.add(spin);
    root.add(pivot);
    const side = w.z > 0 ? 1 : -1;
    const tire = new THREE.Mesh(tireGeometry(w.radius, P.tireW), mats.tire);
    tire.castShadow = true;
    spin.add(tire);
    const rim = new THREE.Mesh(rimGeometry(w.radius * 0.66, P.tireW * 0.9, isPolice), mats.rim);
    rim.rotation.x = side > 0 ? 0 : Math.PI;
    spin.add(rim);
    let hubcap: THREE.Object3D | null = null;
    if (!isPolice) {
      hubcap = new THREE.Mesh(new THREE.CylinderGeometry(w.radius * 0.6, w.radius * 0.62, 0.02, 20), mats.chrome);
      hubcap.rotation.x = Math.PI / 2;
      hubcap.position.z = side * (P.tireW / 2 + 0.005);
      spin.add(hubcap);
      parts[`hubcap${k}` as PartId] = hubcap;
    } else {
      // brake caliper (does not spin)
      const cal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.06), new THREE.MeshStandardMaterial({ color: '#8a1010', roughness: 0.5 }));
      cal.position.set(-w.radius * 0.35, w.radius * 0.25, side * 0.04);
      pivot.add(cal);
    }
    wheelsOut.push({ pivot, spin, hubcap });
  }
  // dark wheel wells
  for (const ax of [P.xf, P.xr]) for (const s of [-1, 1]) {
    const well = new THREE.Mesh(new THREE.CylinderGeometry(archR - 0.02, archR - 0.02, 0.36, 18, 1, true, Math.PI / 2, Math.PI), mats.black);
    well.rotation.x = Math.PI / 2;
    well.position.set(ax, tireR, s * (hw - 0.2));
    model.add(well);
  }
  // underbody shadow catcher / floor
  const floor = new THREE.Mesh(new THREE.BoxGeometry(L - 0.4, 0.04, W - 0.3), mats.black);
  floor.position.y = P.sillY + 0.02;
  model.add(floor);

  // a simple cabin (seen from the driver camera): dash, binnacle, wheel, seats, console, laptop
  if (isPolice) {
    const cab = new THREE.Group();
    const dashX = P.wsX - 0.25, beltY = P.beltF;
    const dark = new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.8 });
    const dash = new THREE.Mesh(roundedBox(0.55, 0.22, W - 0.32, 0.06), dark);
    dash.position.set(dashX, beltY - 0.06, 0);
    const binnacle = new THREE.Mesh(roundedBox(0.2, 0.12, 0.42, 0.04), dark);
    binnacle.position.set(dashX - 0.18, beltY + 0.06, -0.38);
    const gauges = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.09), new THREE.MeshStandardMaterial({ color: '#0a1a2a', emissive: '#3aa0ff', emissiveIntensity: 0.6 }));
    gauges.rotation.y = -Math.PI / 2; gauges.position.set(dashX - 0.285, beltY + 0.06, -0.38);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 10, 28), dark);
    wheel.rotation.y = Math.PI / 2; wheel.rotation.x = 0.35; wheel.position.set(dashX - 0.42, beltY - 0.02, -0.38);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 12), dark);
    hub.rotation.z = Math.PI / 2; hub.position.copy(wheel.position);
    const console1 = new THREE.Mesh(roundedBox(0.7, 0.25, 0.22, 0.04), dark);
    console1.position.set(dashX - 0.6, beltY - 0.35, 0);
    const laptop = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, 0.3), new THREE.MeshStandardMaterial({ color: '#111', emissive: '#4a7dbf', emissiveIntensity: 0.35 }));
    laptop.position.set(dashX - 0.55, beltY + 0.0, 0.1); laptop.rotation.z = -0.3;
    for (const z of [-0.38, 0.38]) {
      const seat = new THREE.Mesh(roundedBox(0.45, 0.6, 0.48, 0.08), new THREE.MeshStandardMaterial({ color: '#202124', roughness: 0.95 }));
      seat.position.set(dashX - 1.25, beltY - 0.15, z); seat.rotation.z = 0.2;
      cab.add(seat);
    }
    cab.add(dash, binnacle, gauges, wheel, hub, console1, laptop);
    model.add(cab);
  }
  mats.glass.side = THREE.DoubleSide;

  const original = new Map<THREE.BufferGeometry, Float32Array>();
  for (const m of bodyMeshes) original.set(m.geometry, (m.geometry.getAttribute('position').array as Float32Array).slice());
  return { root, bodyMeshes, original, wheels: wheelsOut, windows, parts, heads, tails, reverse, bar, barLights, mats, profile: P, offsetY: -cgHeight, dentVersion: -1 };
}

function roundedBox(x: number, y: number, z: number, r: number) {
  // a box with bevelled edges (an extruded rounded rectangle in x-y, extruded along z)
  const s = new THREE.Shape();
  const w = x / 2, h = y / 2;
  r = Math.min(r, w * 0.9, h * 0.9);
  s.moveTo(-w + r, -h); s.lineTo(w - r, -h); s.quadraticCurveTo(w, -h, w, -h + r); s.lineTo(w, h - r); s.quadraticCurveTo(w, h, w - r, h);
  s.lineTo(-w + r, h); s.quadraticCurveTo(-w, h, -w, h - r); s.lineTo(-w, -h + r); s.quadraticCurveTo(-w, -h, -w + r, -h);
  const g = new THREE.ExtrudeGeometry(s, { depth: z - 2 * Math.min(r, z * 0.3), bevelEnabled: true, bevelThickness: Math.min(r, z * 0.3), bevelSize: 0, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -(z - 2 * Math.min(r, z * 0.3)) / 2);
  return g;
}

function tireGeometry(R: number, w: number) {
  // profile in (radius, axial) swept around the axle (z)
  const pts: THREE.Vector2[] = [];
  const r0 = R * 0.68, sh = 0.04;
  pts.push(new THREE.Vector2(r0, -w / 2));
  pts.push(new THREE.Vector2(R - sh, -w / 2));
  for (let k = 0; k <= 6; ++k) { const a = -Math.PI / 2 + (k / 6) * Math.PI; pts.push(new THREE.Vector2(R - sh + Math.cos(a) * sh, Math.sin(a) * (w / 2 - 0.0) * 0.98 + 0)); }
  pts.push(new THREE.Vector2(R - sh, w / 2));
  pts.push(new THREE.Vector2(r0, w / 2));
  const g = new THREE.LatheGeometry(pts, 40);
  g.rotateX(Math.PI / 2);
  return g;
}

function rimGeometry(R: number, w: number, steel: boolean) {
  const g: THREE.BufferGeometry[] = [];
  // dish
  const pts = [new THREE.Vector2(0.001, w * 0.15), new THREE.Vector2(R * 0.3, w * 0.18), new THREE.Vector2(R * 0.45, w * 0.32), new THREE.Vector2(R * 0.9, w * 0.38), new THREE.Vector2(R, w * 0.45), new THREE.Vector2(R * 1.02, w * 0.5), new THREE.Vector2(R * 1.02, -w * 0.4)];
  const dish = new THREE.LatheGeometry(pts, 32);
  dish.rotateX(Math.PI / 2);
  g.push(dish);
  // spokes / slots
  const n = steel ? 8 : 5;
  for (let k = 0; k < n; ++k) {
    const a = (k / n) * Math.PI * 2;
    const sp = new THREE.BoxGeometry(steel ? 0.03 : 0.06, R * 0.62, 0.035);
    sp.translate(0, R * 0.55, w * 0.42);
    sp.rotateZ(a);
    g.push(sp);
  }
  const hub = new THREE.CylinderGeometry(R * 0.2, R * 0.22, 0.05, 16);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, 0, w * 0.44);
  g.push(hub);
  return mergeGeometries(g);
}

export function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // keeps indices when every input is indexed, else flattens; never spreads big arrays
  const allIndexed = list.every((g) => !!g.index);
  const prepared = list.map((g0) => {
    const g = allIndexed ? g0 : g0.index ? g0.toNonIndexed() : g0;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    return g;
  });
  let nv = 0, ni = 0;
  for (const g of prepared) { nv += g.getAttribute('position').count; if (allIndexed) ni += g.index!.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = allIndexed ? new Uint32Array(ni) : null;
  let ov = 0, oi = 0;
  for (const g of prepared) {
    const n = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, ov * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, ov * 3);
    const u = g.getAttribute('uv');
    if (u) uv.set(u.array as Float32Array, ov * 2);
    if (idx) { const src = g.index!.array; for (let i = 0; i < src.length; ++i) idx[oi + i] = src[i] + ov; oi += src.length; }
    ov += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (idx) out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// Push the body in where it was hit (body frame dents) - rebuilt from the original vertices.
export function applyDents(model: CarModel, dents: { x: number; y: number; z: number; nx: number; ny: number; nz: number; depth: number; radius: number }[]) {
  const off = model.offsetY;
  for (const m of model.bodyMeshes) {
    const g = m.geometry, orig = model.original.get(g);
    if (!orig) continue;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    a.set(orig);
    if (dents.length) {
      // mesh-local -> body frame: the mesh sits in `model` (offset by offY) or in a part group
      const mp = new THREE.Vector3();
      m.updateWorldMatrix(true, false);
      const toBody = new THREE.Matrix4();
      // compose up to the root (model.root is the body frame)
      let o: THREE.Object3D | null = m;
      const chain: THREE.Object3D[] = [];
      while (o && o !== model.root) { chain.push(o); o = o.parent; }
      for (let i = chain.length - 1; i >= 0; --i) { chain[i].updateMatrix(); toBody.multiply(chain[i].matrix); }
      const inv = new THREE.Matrix4().copy(toBody).invert();
      const dirToLocal = new THREE.Matrix3().setFromMatrix4(inv);
      for (const d of dents) {
        const dl = new THREE.Vector3(d.nx, d.ny, d.nz).applyMatrix3(dirToLocal).normalize();
        const cl = new THREE.Vector3(d.x, d.y, d.z).applyMatrix4(inv);
        const r2 = d.radius * d.radius;
        for (let i = 0; i < a.length; i += 3) {
          mp.set(a[i] - cl.x, a[i + 1] - cl.y, a[i + 2] - cl.z);
          const q = mp.lengthSq();
          if (q >= r2) continue;
          const f = 1 - Math.sqrt(q) / d.radius;
          const k = d.depth * f * f;
          a[i] += dl.x * k; a[i + 1] += dl.y * k; a[i + 2] += dl.z * k;
        }
      }
    }
    pos.needsUpdate = true;
    if (g.index) g.computeVertexNormals(); else smoothNormals(g);
  }
  void off;
}

// Smooth vertex normals for non-indexed geometry: face normals summed per position (UV seams
// do not crease the shading).
export function smoothNormals(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position').array as Float32Array;
  const n = pos.length / 3;
  let nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!nor || nor.count !== n) { nor = new THREE.BufferAttribute(new Float32Array(n * 3), 3); g.setAttribute('normal', nor); }
  const acc = new Map<string, [number, number, number]>();
  const key = (i: number) => `${Math.round(pos[3 * i] * 2000)},${Math.round(pos[3 * i + 1] * 2000)},${Math.round(pos[3 * i + 2] * 2000)}`;
  const fn: number[] = [];
  for (let t = 0; t < n; t += 3) {
    const ax = pos[3 * t], ay = pos[3 * t + 1], az = pos[3 * t + 2];
    const ux = pos[3 * t + 3] - ax, uy = pos[3 * t + 4] - ay, uz = pos[3 * t + 5] - az;
    const vx = pos[3 * t + 6] - ax, vy = pos[3 * t + 7] - ay, vz = pos[3 * t + 8] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    fn.push(cx, cy, cz);
    for (let k = 0; k < 3; ++k) {
      const kk = key(t + k);
      const a = acc.get(kk);
      if (a) { a[0] += cx; a[1] += cy; a[2] += cz; } else acc.set(kk, [cx, cy, cz]);
    }
  }
  const out = nor.array as Float32Array;
  for (let i = 0; i < n; ++i) {
    const a = acc.get(key(i))!;
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    out[3 * i] = a[0] / l; out[3 * i + 1] = a[1] / l; out[3 * i + 2] = a[2] / l;
  }
  nor.needsUpdate = true;
}
