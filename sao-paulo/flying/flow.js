// São Paulo World · flight test bed: airflow, as the physics sees it.
//
// Every frame the flight core reports each lifting strip's lift coefficient,
// angle of attack, stall angle and local dynamic pressure (avd_flow). Each
// strip becomes a horseshoe vortex of circulation Gamma = 0.5 V c cl
// (Kutta-Joukowski), so the induced field below is the one implied by the
// lift the simulation is actually producing: downwash behind the wing, upwash
// ahead of it, and the tip vortices that roll up off the wingtips. The
// fuselage is a Rankine body (a source at the nose, a sink at the tail); the
// propeller slipstream and jet exhausts come from the core's momentum-theory
// values. Particles stream through that field in slow motion, coloured by the
// pressure coefficient Cp = 1 - (V / V_inf)^2; the strips themselves glow by
// how close each is to its stall angle.
//
// Structural frame (x forward, y right, z down) inside; rendered in body FLU.
import * as THREE from 'three';

const STRIDE = 16;

// Turbo colormap (Google, polynomial approximation), t in [0, 1].
function turbo(t, out) {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  out[0] = Math.min(1, Math.max(0, r)); out[1] = Math.min(1, Math.max(0, g)); out[2] = Math.min(1, Math.max(0, b));
  return out;
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.3, 'rgba(255,255,255,.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function buildFlow({ mobile }) {
  const group = new THREE.Group();
  group.visible = false;
  const NP = mobile ? 450 : 1100, TR = mobile ? 14 : 24;
  const p = new Float32Array(NP * 3);           // particle positions (structural frame)
  const heat = new Float32Array(NP);            // exhaust temperature marker 0..1
  const age = new Float32Array(NP).fill(1e9);
  const trail = new Float32Array(NP * TR * 3);  // ring buffer of positions
  const trailC = new Float32Array(NP * TR * 3); // colour at each trail point
  let head = 0;

  // Trails: one line segment per consecutive trail pair, additive, fading.
  const segPos = new Float32Array(NP * (TR - 1) * 6), segCol = new Float32Array(NP * (TR - 1) * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(segPos, 3).setUsage(THREE.DynamicDrawUsage));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(segCol, 3).setUsage(THREE.DynamicDrawUsage));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  lines.frustumCulled = false;
  group.add(lines);
  const headPos = new Float32Array(NP * 3), headCol = new Float32Array(NP * 3);
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3).setUsage(THREE.DynamicDrawUsage));
  ptGeo.setAttribute('color', new THREE.BufferAttribute(headCol, 3).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(ptGeo, new THREE.PointsMaterial({ size: 0.35, map: glowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  points.frustumCulled = false;
  group.add(points);

  // Strip heat map (rebuilt when the aircraft changes).
  let stripMesh = null, stripCount = -1, stripKey = '';
  const stripMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });

  // Vortex segments for this frame.
  const MAXS = 64 * 3;
  const sA = new Float64Array(MAXS * 3), sB = new Float64Array(MAXS * 3), sG = new Float64Array(MAXS), sR = new Float64Array(MAXS);
  let nSeg = 0;
  const U = [0, 0, 0];
  let Umag = 0;
  let fuse = null, engines = [];
  const col = [0, 0, 0];

  // Velocity of the air relative to the aircraft at (x, y, z), structural frame.
  const out = [0, 0, 0];
  function velocity(x, y, z) {
    let vx = U[0], vy = U[1], vz = U[2];
    for (let k = 0; k < nSeg; ++k) {
      const k3 = k * 3;
      const r1x = x - sA[k3], r1y = y - sA[k3 + 1], r1z = z - sA[k3 + 2];
      const r2x = x - sB[k3], r2y = y - sB[k3 + 1], r2z = z - sB[k3 + 2];
      const r0x = sB[k3] - sA[k3], r0y = sB[k3 + 1] - sA[k3 + 1], r0z = sB[k3 + 2] - sA[k3 + 2];
      const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
      const r1n = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z), r2n = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
      if (r1n < 1e-6 || r2n < 1e-6) continue;
      const r0sq = r0x * r0x + r0y * r0y + r0z * r0z;
      const den = cx * cx + cy * cy + cz * cz + sR[k] * r0sq;
      const f = sG[k] / (4 * Math.PI) * ((r0x * r1x + r0y * r1y + r0z * r1z) / r1n - (r0x * r2x + r0y * r2y + r0z * r2z) / r2n) / den;
      vx += f * cx; vy += f * cy; vz += f * cz;
    }
    if (fuse) {
      // Rankine body: source just aft of the nose, sink just ahead of the tail.
      for (const [sx, q] of [[fuse.src, fuse.Q], [fuse.snk, -fuse.Q]]) {
        const dx = x - sx, dy = y, dz = z - fuse.z;
        const r2 = dx * dx + dy * dy + dz * dz + fuse.core;
        const f = q / (4 * Math.PI * r2 * Math.sqrt(r2));
        vx += f * dx; vy += f * dy; vz += f * dz;
      }
    }
    let hot = 0;
    for (const e of engines) {
      // Behind the disc / nozzle: axial jet with momentum-theory increment, spreading and decaying.
      const dx = x - e.x, dy = y - e.y, dz = z - e.z;
      const along = -(dx * e.ax + dy * e.ay + dz * e.az);  // distance downstream
      if (along < -0.2) continue;
      const rx = dx + along * e.ax, ry = dy + along * e.ay, rz = dz + along * e.az;
      const rr = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const R = e.r * (e.jet ? 1 + 0.08 * along / e.r : 0.82 + 0.18 * Math.exp(-along / e.r));
      if (rr > R * 1.3) continue;
      const decay = e.jet ? (e.r / R) ** 2 : Math.exp(-along / (40 * e.r));
      const prof = Math.max(0, 1 - (rr / (R * 1.3)) ** 4);
      const dv = e.inc * decay * prof;
      vx -= dv * e.ax; vy -= dv * e.ay; vz -= dv * e.az;
      if (!e.jet && rr > 1e-3) {
        // Slipstream swirl (sense from the rotation, which the core's slipstream carries).
        const sw = 0.25 * dv * (rr / R);
        const tx = (e.ay * rz - e.az * ry) / rr, ty = (e.az * rx - e.ax * rz) / rr, tz = (e.ax * ry - e.ay * rx) / rr;
        vx += sw * tx; vy += sw * ty; vz += sw * tz;
      }
      if (e.jet) hot = Math.max(hot, prof * decay);
    }
    out[0] = vx; out[1] = vy; out[2] = vz;
    return hot;
  }

  let L = 8, span = 11, centre = [0, 0, 0];
  const tip = [0, 5, 0, 0.5];  // right wingtip trailing point (x, |y|, z) and vortex core radius
  function respawn(i, scatter) {
    // Seeds on a plane upstream of the aircraft, dense near the wing plane.
    // A third near the wing plane, a sixth just inboard of each tip (to show
    // the tip vortex roll up), the rest in the volume around the aircraft.
    const u = Math.random();
    if (!scatter && u > 0.88) {
      // Released just behind a wingtip, around the vortex core: they spiral.
      const side = Math.random() < 0.5 ? -1 : 1, a = Math.random() * 2 * Math.PI, r = tip[3] * (0.6 + Math.random() * 2.5);
      p[i * 3] = tip[0]; p[i * 3 + 1] = side * tip[1] + Math.cos(a) * r; p[i * 3 + 2] = tip[2] + Math.sin(a) * r;
      heat[i] = 0; age[i] = 0;
      for (let k = 0; k < TR; ++k) { const o = (i * TR + k) * 3; trail[o] = p[i * 3]; trail[o + 1] = p[i * 3 + 1]; trail[o + 2] = p[i * 3 + 2]; trailC[o] = trailC[o + 1] = trailC[o + 2] = 0; }
      return;
    }
    let yy, zz;
    if (u < 0.34) { yy = (Math.random() * 2 - 1) * span * 0.55; zz = centre[2] + (Math.random() * 2 - 1) * span * 0.04; }
    else if (u < 0.5) { yy = (Math.random() < 0.5 ? -1 : 1) * span * (0.42 + Math.random() * 0.12); zz = centre[2] + (Math.random() * 2 - 1) * span * 0.05; }
    else { yy = (Math.random() * 2 - 1) * span * 0.62; zz = (Math.random() * 2 - 1) * span * 0.3; }
    // After a reset, scatter along the whole stream so there is no launch wave.
    const back = scatter ? 0.6 * L - Math.random() * 1.85 * L : 0.55 * L + Math.random() * 0.15 * L;
    const ux = U[0] / Umag, uy = U[1] / Umag, uz = U[2] / Umag;
    p[i * 3] = centre[0] - ux * back; p[i * 3 + 1] = yy - uy * back; p[i * 3 + 2] = zz - uz * back;
    heat[i] = 0; age[i] = 0;
    for (let k = 0; k < TR; ++k) { const o = (i * TR + k) * 3; trail[o] = p[i * 3]; trail[o + 1] = p[i * 3 + 1]; trail[o + 2] = p[i * 3 + 2]; trailC[o] = trailC[o + 1] = trailC[o + 2] = 0; }
  }

  function buildStrips(f, n) {
    if (stripMesh) { group.remove(stripMesh); stripMesh.geometry.dispose(); }
    const V = 12;  // two quads a strip: upper and lower surface
    const pos = new Float32Array(n * V * 3), colr = new Float32Array(n * V * 3);
    for (let i = 0; i < n; ++i) {
      const o = 16 + i * STRIDE;
      const P = [f[o], f[o + 1], f[o + 2]], S = [f[o + 3], f[o + 4], f[o + 5]], N = [f[o + 6], f[o + 7], f[o + 8]];
      const c = f[o + 9], b = f[o + 10] / Math.max(c, 1e-3);
      // Chord axis = cross(span, normal) up to sign: forward is +x.
      let C = [S[1] * N[2] - S[2] * N[1], S[2] * N[0] - S[0] * N[2], S[0] * N[1] - S[1] * N[0]];
      if (C[0] < 0) C = C.map((v) => -v);
      const t = 0.075 * c + 0.015;  // just outside the section's thickness
      let k = 0;
      for (const side of [1, -1]) {
        const corner = (s, ch) => [0, 1, 2].map((j) => P[j] + S[j] * s * b * 0.5 + C[j] * ch * c + N[j] * side * t * (1 - Math.abs(ch + 0.25) * 0.8));
        const q = [corner(-1, 0.22), corner(1, 0.22), corner(1, -0.72), corner(-1, -0.72)];
        for (const v of [q[0], q[1], q[2], q[0], q[2], q[3]]) { pos[(i * V + k) * 3] = v[0]; pos[(i * V + k) * 3 + 1] = -v[1]; pos[(i * V + k) * 3 + 2] = -v[2]; ++k; }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colr, 3).setUsage(THREE.DynamicDrawUsage));
    stripMesh = new THREE.Mesh(g, stripMat);
    stripMesh.frustumCulled = false; stripMesh.renderOrder = 2;
    group.add(stripMesh);
    stripCount = n;
  }

  let clockT = 0;
  // f: avd_flow(); prof: { fuse: {xNose, xTail, R, z} } in the structural frame; dt: frame seconds.
  function update(f, dt, prof, opts = {}) {
    clockT += dt;
    const n = f[0] | 0;
    const tas = f[2], alpha = f[3], beta = f[4], rho = Math.max(f[5], 0.05);
    const key = `${prof.id}:${n}`;
    if (key !== stripKey) { stripKey = key; buildStrips(f, n); for (let i = 0; i < NP; ++i) age[i] = 1e9; }
    // Strip glow: angle of attack as a fraction of the strip's stall angle.
    const sc = stripMesh.geometry.attributes.color;
    let stalled = 0;
    for (let i = 0; i < n; ++i) {
      const o = 16 + i * STRIDE;
      const a = f[o + 12], sa = f[o + 14], q = f[o + 13];
      let r = q > 1 ? a / Math.max(sa, 0.02) : 0;
      if (r > 1) { ++stalled; const pulse = 0.5 + 0.5 * Math.sin(clockT * 12); col[0] = 1; col[1] = 0.1 * pulse; col[2] = 0.9 * pulse + 0.1; }
      else turbo(0.5 + 0.5 * r, col);
      for (let k = 0; k < 12; ++k) sc.array.set(col, (i * 12 + k) * 3);
    }
    sc.needsUpdate = true;
    stripMesh.visible = opts.strips !== false;

    if (tas < 6) { lines.visible = points.visible = false; return { stalled }; }
    lines.visible = points.visible = true;
    // Free stream relative to the aircraft (structural frame): minus the body velocity through the air.
    const ca = Math.cos(alpha), cb = Math.cos(beta);
    U[0] = -tas * ca * cb; U[1] = -tas * Math.sin(beta); U[2] = -tas * Math.sin(alpha) * cb;
    Umag = tas;
    const ux = U[0] / tas, uy = U[1] / tas, uz = U[2] / tas;
    // Horseshoe vortices from the strips' lift.
    nSeg = 0;
    tip[1] = 0;
    const far = 4 * L;
    for (let i = 0; i < n; ++i) {
      const o = 16 + i * STRIDE;
      const q = f[o + 13], cl = f[o + 11], c = f[o + 9], b = f[o + 10] / Math.max(c, 1e-3);
      if (q < 1 || Math.abs(cl) < 1e-4) continue;
      const V = Math.sqrt(2 * q / rho), G = 0.5 * V * c * cl;
      let lx = f[o + 3], ly = f[o + 4], lz = f[o + 5];
      const nx = f[o + 6], ny = f[o + 7], nz = f[o + 8];
      // Bound-vortex sense: lift = rho U x Gamma along the strip's normal for cl > 0.
      const kx = uy * lz - uz * ly, ky = uz * lx - ux * lz, kz = ux * ly - uy * lx;
      if (kx * nx + ky * ny + kz * nz < 0) { lx = -lx; ly = -ly; lz = -lz; }
      const P1 = [f[o] - lx * b / 2, f[o + 1] - ly * b / 2, f[o + 2] - lz * b / 2];
      const P2 = [f[o] + lx * b / 2, f[o + 1] + ly * b / 2, f[o + 2] + lz * b / 2];
      const rc = Math.max(0.22 * c, 0.15), rc2 = rc * rc;
      if (f[o + 15] === 0 && Math.abs(P2[1]) > tip[1] * 0.999) { tip[0] = P2[0] - 0.75 * c; tip[1] = Math.abs(P2[1]); tip[2] = P2[2]; tip[3] = rc; }
      if (f[o + 15] === 0 && Math.abs(P1[1]) > tip[1] * 0.999) { tip[0] = P1[0] - 0.75 * c; tip[1] = Math.abs(P1[1]); tip[2] = P1[2]; tip[3] = rc; }
      const seg = (a, bb, g, r2) => { const k = nSeg * 3; sA[k] = a[0]; sA[k + 1] = a[1]; sA[k + 2] = a[2]; sB[k] = bb[0]; sB[k + 1] = bb[1]; sB[k + 2] = bb[2]; sG[nSeg] = g; sR[nSeg] = r2; ++nSeg; };
      seg([P1[0] + ux * far, P1[1] + uy * far, P1[2] + uz * far], P1, G, rc2);
      seg(P1, P2, G, rc2 * 1.5);
      seg(P2, [P2[0] + ux * far, P2[1] + uy * far, P2[2] + uz * far], G, rc2);
      if (nSeg >= MAXS - 3) break;
    }
    // Fuselage and engines.
    const fu = prof.fuse;
    L = fu.xNose - fu.xTail; span = prof.span; centre = [(fu.xNose + fu.xTail) / 2, 0, fu.z];
    const Q = tas * Math.PI * fu.R * fu.R;
    fuse = { src: fu.xNose - fu.R * 0.5, snk: fu.xTail + fu.R * 0.5, z: fu.z, Q, core: (fu.R * 0.3) ** 2 };
    engines = [];
    const e0 = 16 + 64 * STRIDE;
    for (let k = 0; k < (f[1] | 0); ++k) {
      const o = e0 + k * 10;
      if (f[o + 7] <= 0.1) continue;
      engines.push({ x: f[o], y: f[o + 1], z: f[o + 2], ax: f[o + 3], ay: f[o + 4], az: f[o + 5], r: f[o + 6], inc: f[o + 7], jet: f[o + 9] > 0.5 });
    }
    // Slow motion: about half an aircraft length per second on screen.
    const ts = Math.min(1, (opts.speed || 1) * 0.55 * L / tas);
    const steps = 2, h = dt * ts / steps;
    head = (head + 1) % TR;
    const inv = 1 / (tas * tas);
    for (let i = 0; i < NP; ++i) {
      const i3 = i * 3;
      if (age[i] > 60) respawn(i, age[i] > 1e8);
      let hot = 0;
      for (let st = 0; st < steps; ++st) {
        hot = Math.max(hot, velocity(p[i3], p[i3 + 1], p[i3 + 2]));
        p[i3] += out[0] * h; p[i3 + 1] += out[1] * h; p[i3 + 2] += out[2] * h;
      }
      age[i] += dt;
      heat[i] = Math.max(hot, heat[i] * Math.exp(-dt * ts * 3));
      const v2 = out[0] * out[0] + out[1] * out[1] + out[2] * out[2];
      const cp = 1 - v2 * inv;
      turbo(0.5 + cp * 3.3, col);  // Cp -0.15 .. +0.15 across the map
      if (heat[i] > 0.02) {
        const hh = Math.min(1, heat[i]);
        col[0] = col[0] * (1 - hh) + 1.0 * hh; col[1] = col[1] * (1 - hh) + 0.55 * hh; col[2] = col[2] * (1 - hh) + 0.15 * hh;
      }
      const o = (i * TR + head) * 3;
      trail[o] = p[i3]; trail[o + 1] = p[i3 + 1]; trail[o + 2] = p[i3 + 2];
      trailC[o] = col[0]; trailC[o + 1] = col[1]; trailC[o + 2] = col[2];
      // Downstream and gone, or wandered off: recycle.
      const dxc = p[i3] - centre[0], dyc = p[i3 + 1], dzc = p[i3 + 2] - centre[2];
      const down = dxc * ux + dyc * uy + dzc * uz;
      if (down > 1.3 * L || Math.abs(dyc) > span * 1.0 || Math.abs(dzc) > span * 0.6) age[i] = 100;
      headPos[i3] = p[i3]; headPos[i3 + 1] = -p[i3 + 1]; headPos[i3 + 2] = -p[i3 + 2];
      headCol[i3] = col[0] * 0.6; headCol[i3 + 1] = col[1] * 0.6; headCol[i3 + 2] = col[2] * 0.6;
    }
    // Trail segments, newest brightest.
    let w = 0;
    for (let i = 0; i < NP; ++i) {
      for (let k = 0; k < TR - 1; ++k) {
        const a = (head - k + TR) % TR, b = (head - k - 1 + TR) % TR;
        const oa = (i * TR + a) * 3, ob = (i * TR + b) * 3;
        const fa = 0.42 * (1 - k / (TR - 1)), fb = 0.42 * (1 - (k + 1) / (TR - 1));
        segPos[w] = trail[oa]; segPos[w + 1] = -trail[oa + 1]; segPos[w + 2] = -trail[oa + 2];
        segPos[w + 3] = trail[ob]; segPos[w + 4] = -trail[ob + 1]; segPos[w + 5] = -trail[ob + 2];
        segCol[w] = trailC[oa] * fa; segCol[w + 1] = trailC[oa + 1] * fa; segCol[w + 2] = trailC[oa + 2] * fa;
        segCol[w + 3] = trailC[ob] * fb; segCol[w + 4] = trailC[ob + 1] * fb; segCol[w + 5] = trailC[ob + 2] * fb;
        w += 6;
      }
    }
    lineGeo.attributes.position.needsUpdate = true; lineGeo.attributes.color.needsUpdate = true;
    ptGeo.attributes.position.needsUpdate = true; ptGeo.attributes.color.needsUpdate = true;
    points.material.size = Math.max(0.12, L * 0.022);
    return { stalled };
  }
  function reset() { for (let i = 0; i < NP; ++i) age[i] = 1e9; }
  return { group, update, reset };
}
