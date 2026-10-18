// São Paulo World · flight test bed: airflow, as the physics sees it.
//
// Every frame the flight core reports each lifting strip's lift coefficient,
// angle of attack, stall angle and local dynamic pressure (avd_flow), and its
// wake (avd_wake): the bound vortex of every strip's lift (Kutta-Joukowski)
// and every vortex the surfaces have shed into the air since, rolling up into
// the tip-vortex pair, sinking and decaying where it was shed. So the induced
// field below is the one implied by the lift the simulation is producing, and
// by its history: downwash behind the wing, upwash ahead of it, the tip
// vortices, and the starting vortex left behind when the lift changes. (Without
// the wake, each strip falls back to a steady horseshoe vortex.) The
// fuselage is a Rankine body (a source at the nose, a sink at the tail); the
// extended gear legs and deployed spoiler panels (avd_bodies) are bluff
// bodies, each leaving a wake whose momentum deficit carries exactly its drag
// (a Gaussian deficit spreading downstream) and shedding a Karman street at a
// Strouhal number of 0.2; the
// propeller slipstream and jet exhausts come from the core's momentum-theory
// values. The atmosphere's own motion comes on top: the core samples its wind
// field (turbulence, thermals, shear, microbursts) on a grid around the
// aircraft (avd_wind_grid), and the lines bend with those eddies.
//
// That field is drawn as streamlines, the way CFD shows it: rakes of lines
// released upstream (densest along the wing plane, around the wingtips and
// into the engines) traced through the field to well behind the aircraft.
// Undisturbed air stays grey; where the aircraft changes the flow the lines
// take the local speed (turbo: slow blue to fast red), exhaust glows orange,
// and a faint pulse travels along every line in the flow direction. The
// strips themselves glow by how close each is to its stall angle, and wool
// tufts on them lie down with the surface flow, flutter near the stall and
// stand up or point forward where the flow has separated.
//
// Structural frame (x forward, y right, z down) inside; rendered in body FLU.
import * as THREE from 'three';

const STRIDE = 18;

// Turbo colormap (Google, polynomial approximation), t in [0, 1].
function turbo(t, out) {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  out[0] = Math.min(1, Math.max(0, r)); out[1] = Math.min(1, Math.max(0, g)); out[2] = Math.min(1, Math.max(0, b));
  return out;
}

export function buildFlow({ mobile }) {
  const group = new THREE.Group();
  group.visible = false;
  // Streamlines: NL lines of up to NPT points, drawn as one LineSegments.
  const NL = mobile ? 150 : 340, NPT = mobile ? 90 : 150;
  const lp = new Float32Array(NL * NPT * 3);   // points (structural frame)
  const lc = new Float32Array(NL * NPT * 3);   // base colour at each point
  const ln = new Uint16Array(NL);              // points in each line
  const lt = new Float32Array(NL * NPT);       // time of flight to each point (s)
  const lphase = new Float32Array(NL).map(() => Math.random());
  const segPos = new Float32Array(NL * (NPT - 1) * 6), segCol = new Float32Array(NL * (NPT - 1) * 8);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(segPos, 3).setUsage(THREE.DynamicDrawUsage));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(segCol, 4).setUsage(THREE.DynamicDrawUsage));
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  lines.renderOrder = 3;
  group.add(lines);
  let refresh = 0;      // next line to re-trace (round robin)
  let traced = 0;       // lines traced since the last reset

  // Strip heat map (rebuilt when the aircraft changes).
  let stripMesh = null, stripCount = -1, stripKey = '';
  const stripMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  // Tufts: two a strip (35 % and 75 % chord) on the lifting side, drawn as
  // short lines in the body frame.
  const MAXT = 64 * 2;
  const tuftPos = new Float32Array(MAXT * 6), tuftCol = new Float32Array(MAXT * 6);
  const tuftGeo = new THREE.BufferGeometry();
  tuftGeo.setAttribute('position', new THREE.BufferAttribute(tuftPos, 3).setUsage(THREE.DynamicDrawUsage));
  tuftGeo.setAttribute('color', new THREE.BufferAttribute(tuftCol, 3).setUsage(THREE.DynamicDrawUsage));
  const tufts = new THREE.LineSegments(tuftGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
  tufts.frustumCulled = false;
  tufts.renderOrder = 3;
  group.add(tufts);

  // Vortex segments for this frame.
  const MAXS = 900;
  const sA = new Float64Array(MAXS * 3), sB = new Float64Array(MAXS * 3), sG = new Float64Array(MAXS), sR = new Float64Array(MAXS);
  let nSeg = 0;
  const U = [0, 0, 0];
  let Umag = 0;
  let fuse = null, engines = [];
  // Bluff bodies (gear legs, spoiler panels): position, unit axis across the
  // flow, lateral unit (across both), diameter, half length, drag per length.
  const MAXB = 32;
  const bP = new Float64Array(MAXB * 3), bA = new Float64Array(MAXB * 3), bN = new Float64Array(MAXB * 3);
  const bD = new Float64Array(MAXB), bH = new Float64Array(MAXB), bC = new Float64Array(MAXB), bK = new Uint8Array(MAXB);
  let nBody = 0;
  const col = [0, 0, 0];

  // The wind around the aircraft minus the wind at the CG (body axes), on a
  // grid of GN points over +-GH metres about the CG (structural frame).
  const GN = mobile ? [8, 6, 4] : [12, 10, 6];
  const GH = [0, 0, 0], GC = [0, 0, 0];
  let grid = null, gridAge = 1e9;
  function windDelta(x, y, z) {
    if (!grid) return false;
    const [nx, ny, nz] = GN;
    const fx = (x - GC[0] + GH[0]) / (2 * GH[0]) * (nx - 1), fy = (y - GC[1] + GH[1]) / (2 * GH[1]) * (ny - 1), fz = (z - GC[2] + GH[2]) / (2 * GH[2]) * (nz - 1);
    if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return false;
    const i = Math.min(nx - 2, fx | 0), j = Math.min(ny - 2, fy | 0), k = Math.min(nz - 2, fz | 0);
    const u = fx - i, v = fy - j, w = fz - k;
    wd[0] = wd[1] = wd[2] = 0;
    for (let c = 0; c < 8; ++c) {
      const di = c & 1, dj = (c >> 1) & 1, dk = c >> 2;
      const wt = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dk ? w : 1 - w);
      const o = 3 * ((i + di) + nx * ((j + dj) + ny * (k + dk)));
      wd[0] += wt * grid[o]; wd[1] += wt * grid[o + 1]; wd[2] += wt * grid[o + 2];
    }
    return true;
  }
  const wd = [0, 0, 0];

  // Velocity of the air relative to the aircraft at (x, y, z), structural
  // frame: the free stream at the CG, minus the aircraft's own rotation
  // (omega x r about the CG), plus the induced and atmospheric fields.
  const out = [0, 0, 0], still = [0, 0, 0];
  const W = [0, 0, 0], CG = [0, 0, 0];
  function velocity(x, y, z) {
    const rx = x - CG[0], ry = y - CG[1], rz = z - CG[2];
    let vx = U[0] - (W[1] * rz - W[2] * ry), vy = U[1] - (W[2] * rx - W[0] * rz), vz = U[2] - (W[0] * ry - W[1] * rx);
    if (windDelta(x, y, z)) { vx += wd[0]; vy += wd[1]; vz += wd[2]; }
    // The undisturbed air here (free stream, the aircraft's rotation, the
    // atmosphere's own motion): what is left is the aircraft's doing.
    still[0] = vx; still[1] = vy; still[2] = vz;
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
    for (let b = 0; b < nBody; ++b) {
      // Wake of a bluff body: the momentum deficit that carries its drag,
      // q CdA = rho U int(u) dA, as a 2-D Gaussian across the body's length
      // (half width s = d/2 (1 + 0.4 sqrt(x/d))), and a Karman street: the
      // lateral velocity of vortices shed alternately at St = 0.2, convecting
      // at 0.85 U. Upstream of the body, nothing (the blockage is local).
      const b3 = b * 3, d = bD[b];
      const px = x - bP[b3], py = y - bP[b3 + 1], pz = z - bP[b3 + 2];
      const xd = (px * U[0] + py * U[1] + pz * U[2]) / Umag;  // downstream distance
      if (xd < -0.3 * d || xd > 80 * d) continue;
      const xs = Math.max(xd, 0);
      const sg = 0.5 * d * (1 + 0.4 * Math.sqrt(xs / d));
      const s = px * bA[b3] + py * bA[b3 + 1] + pz * bA[b3 + 2];
      const eta = px * bN[b3] + py * bN[b3 + 1] + pz * bN[b3 + 2];
      const over = Math.max(0, Math.abs(s) - bH[b]);
      const g = Math.exp(-(eta * eta + over * over) / (2 * sg * sg));
      if (g < 1e-3) continue;
      const ramp = Math.min(1, (xd + 0.3 * d) / (0.6 * d));
      const umax = Math.min(0.8, bC[b] / (2 * Math.sqrt(2 * Math.PI) * sg)) * Umag;
      const du = umax * g * ramp;
      vx -= du * U[0] / Umag; vy -= du * U[1] / Umag; vz -= du * U[2] / Umag;
      // Karman: a travelling wave of lateral velocity, strongest a body width
      // either side of the centreline and fading over ~40 diameters.
      const k = 2 * Math.PI * 0.2 / (0.85 * d);
      const fade = Math.exp(-xs / (40 * d)) * Math.min(1, xs / d);
      const vl = 0.35 * umax * fade * g * Math.sin(k * (xs - 0.85 * Umag * flowT) + b * 1.3);
      vx += vl * bN[b3]; vy += vl * bN[b3 + 1]; vz += vl * bN[b3 + 2];
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
  let gnd = null;  // the ground plane in the structural frame: n . p >= d above it
  const va = new THREE.Vector3(), vb = new THREE.Vector3();
  const tip = [0, 5, 0, 0.5];  // right wingtip trailing point (x, |y|, z) and vortex core radius
  const wing = [0, 0];         // main wing plane: x of the quarter chord, z
  // Seed of line i (structural frame) and whether it is traced from that point
  // only downstream (wingtip lines start at the tip). Lines are allocated to
  // rakes by index so each rake keeps its share as the field changes.
  const seed = [0, 0, 0];
  const R1 = (i, k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
  function seedLine(i) {
    const ux = U[0] / Umag, uy = U[1] / Umag, uz = U[2] / Umag;
    const up = 0.75 * L;
    const upstream = (x, y, z) => { seed[0] = x - ux * up; seed[1] = y - uy * up; seed[2] = z - uz * up; return false; };
    const f = i / NL, j = R1(i, 1), m = R1(i, 2);
    const nEng = engines.length;
    if (f < 0.36) {
      // Wing-plane rake: four sheets just above and below the wing, across the span.
      const sheet = i % 4, zz = wing[1] + [-0.07, -0.025, 0.025, 0.07][sheet] * span;
      return upstream(wing[0] + 0.15 * L, (j * 2 - 1) * span * 0.56, zz);
    }
    if (f < 0.5) {
      // Wingtips: released around each tip's trailing edge, so they wind into the vortex.
      const side = i % 2 ? 1 : -1, a = j * 2 * Math.PI, r = tip[3] * (0.4 + 3.2 * m);
      seed[0] = tip[0]; seed[1] = side * tip[1] + Math.cos(a) * r; seed[2] = tip[2] + Math.sin(a) * r;
      return true;
    }
    if (f < 0.6 && nEng) {
      // Into the engines: a ring inside each disc or inlet.
      const e = engines[i % nEng], a = j * 2 * Math.PI, r = e.r * (0.15 + 0.75 * Math.sqrt(m));
      // Two axes across the disc.
      let px = -e.az, py = 0, pz = e.ax; const pn = Math.hypot(px, pz) || 1; px /= pn; pz /= pn;
      const qx = e.ay * pz - e.az * py, qy = e.az * px - e.ax * pz, qz = e.ax * py - e.ay * px;
      const fx = e.x + (px * Math.cos(a) + qx * Math.sin(a)) * r, fy = e.y + (py * Math.cos(a) + qy * Math.sin(a)) * r, fz = e.z + (pz * Math.cos(a) + qz * Math.sin(a)) * r;
      seed[0] = fx + e.ax * e.r * 2.5; seed[1] = fy + e.ay * e.r * 2.5; seed[2] = fz + e.az * e.r * 2.5;
      return false;
    }
    if (f < 0.7 && nBody) {
      // Onto the bodies: across each leg or panel, just upstream.
      const b = i % nBody, b3 = b * 3, t = (j * 2 - 1) * (bH[b] + 0.5 * bD[b]), l = (m * 2 - 1) * 1.6 * bD[b], back = 1.5 * bD[b];
      for (let c = 0; c < 3; ++c) seed[c] = bP[b3 + c] + bA[b3 + c] * t + bN[b3 + c] * l - U[c] / Umag * back;
      return false;
    }
    if (f < 0.76) {
      // Around the nose: the fuselage parting the air.
      const a = j * 2 * Math.PI, r = (fuse ? Math.sqrt(fuse.Q / (Math.PI * Umag)) : 1) * (1.05 + 1.2 * m);
      return upstream(centre[0] + 0.5 * L, Math.cos(a) * r, centre[2] + Math.sin(a) * r);
    }
    // The volume around the aircraft (context: mostly undisturbed, grey).
    return upstream(wing[0] + 0.15 * L, (j * 2 - 1) * span * 0.78, centre[2] + (m * 2 - 1) * span * 0.32);
  }

  // Trace line i through the field: midpoint steps of fixed length along the
  // local flow direction, from the seed until it is well behind the aircraft.
  function traceLine(i) {
    const fromTip = seedLine(i);
    const ds = (fromTip ? 1.3 : 2.1) * L / NPT;
    const ux = U[0] / Umag, uy = U[1] / Umag, uz = U[2] / Umag;
    let x = seed[0], y = seed[1], z = seed[2], k = 0, tof = 0;
    const base = i * NPT * 3;
    for (; k < NPT; ++k) {
      const hot = velocity(x, y, z);
      const vx = out[0], vy = out[1], vz = out[2];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      // Colour: grey where the aircraft leaves the air alone, and where it
      // does not, the speed it gives the air (the free stream plus what it
      // induces: gusts move the lines but do not colour them).
      const dx = vx - still[0], dy = vy - still[1], dz = vz - still[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) / Umag;
      const w = Math.min(1, Math.max(0, (dist - 0.006) / 0.045));
      const ix = U[0] + dx, iy = U[1] + dy, iz = U[2] + dz;
      turbo(0.5 + (Math.sqrt(ix * ix + iy * iy + iz * iz) / Umag - 1) * 3.2, col);
      const g = grey;
      let r = g + (col[0] - g) * w, gg = g + (col[1] - g) * w, b = g + (col[2] - g) * w;
      if (hot > 0.02) { const h = Math.min(1, hot * 1.5); r += (1.0 - r) * h; gg += (0.55 - gg) * h; b += (0.15 - b) * h; }
      const o = base + k * 3;
      lp[o] = x; lp[o + 1] = y; lp[o + 2] = z;
      lc[o] = r; lc[o + 1] = gg; lc[o + 2] = b;
      lt[i * NPT + k] = tof;
      tof += ds / sp;  // time the air takes over the next step
      // Midpoint step along the unit flow direction.
      const mx = x + vx / sp * ds * 0.5, my = y + vy / sp * ds * 0.5, mz = z + vz / sp * ds * 0.5;
      velocity(mx, my, mz);
      const s2 = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]) || 1;
      x += out[0] / s2 * ds; y += out[1] / s2 * ds; z += out[2] / s2 * ds;
      const dxc = x - centre[0], dyc = y, dzc = z - centre[2];
      if (dxc * ux + dyc * uy + dzc * uz > 1.2 * L || Math.abs(dyc) > span || Math.abs(dzc) > 0.6 * span) { ++k; break; }
      if (gnd && x * gnd[0] + y * gnd[1] + z * gnd[2] < gnd[3]) { ++k; break; }  // into the ground
    }
    ln[i] = k;
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

  let clockT = 0, flowT = 0, grey = 0.55;
  // f: avd_flow(); prof: { fuse: {xNose, xTail, R, z} } in the structural frame; dt: frame seconds.
  function update(f, dt, prof, opts = {}) {
    clockT += dt;
    const n = f[0] | 0;
    const tas = f[2], alpha = f[3], beta = f[4], rho = Math.max(f[5], 0.05);
    const key = `${prof.id}:${n}`;
    if (key !== stripKey) { stripKey = key; buildStrips(f, n); reset(); }
    grey = opts.light ? 0.42 : 0.55;
    lineMat.blending = THREE.NormalBlending;
    // Strip glow: angle of attack as a fraction of the strip's stall angle.
    const sc = stripMesh.geometry.attributes.color;
    let stalled = 0;
    for (let i = 0; i < n; ++i) {
      const o = 16 + i * STRIDE;
      const a = f[o + 12], sa = f[o + 14], q = f[o + 13];
      const r = a / Math.max(sa, 0.02);
      if (q <= 1) { col[0] = 0.13; col[1] = 0.15; col[2] = 0.18; }  // no airflow over it: unlit
      else if (r > 1) { ++stalled; const pulse = 0.5 + 0.5 * Math.sin(clockT * 12); col[0] = 1; col[1] = 0.1 * pulse; col[2] = 0.9 * pulse + 0.1; }
      else turbo(0.5 + 0.5 * r, col);
      for (let k = 0; k < 12; ++k) sc.array.set(col, (i * 12 + k) * 3);
    }
    sc.needsUpdate = true;
    stripMesh.visible = opts.strips !== false;

    if (tas < 6) { lines.visible = false; tufts.visible = false; return { stalled }; }
    lines.visible = opts.lines !== false;
    tufts.visible = true;
    // Free stream relative to the aircraft (structural frame): minus the body velocity through the air.
    const ca = Math.cos(alpha), cb = Math.cos(beta);
    U[0] = -tas * ca * cb; U[1] = -tas * Math.sin(beta); U[2] = -tas * Math.sin(alpha) * cb;
    Umag = tas;
    const ux = U[0] / tas, uy = U[1] / tas, uz = U[2] / tas;
    W[0] = f[10]; W[1] = f[11]; W[2] = f[12];
    CG[0] = f[6]; CG[1] = f[7]; CG[2] = f[8];
    // Fuselage and engines; sizes for the rakes.
    const fu = prof.fuse;
    L = fu.xNose - fu.xTail; span = prof.span; centre = [(fu.xNose + fu.xTail) / 2, 0, fu.z];
    // The main wing's plane and tips (rake seeds).
    tip[1] = 0;
    let wx = 0, wz = 0, wn = 0;
    for (let i = 0; i < n; ++i) {
      const o = 16 + i * STRIDE;
      if (f[o + 15] !== 0) continue;
      const c = f[o + 9], b = f[o + 10] / Math.max(c, 1e-3);
      wx += f[o] * b; wz += f[o + 2] * b; wn += b;
      for (const k of [-1, 1]) {
        const y = f[o + 1] + k * f[o + 4] * b / 2;
        if (Math.abs(y) > tip[1] * 0.999) {
          tip[0] = f[o] + k * f[o + 3] * b / 2 - 0.75 * c; tip[1] = Math.abs(y); tip[2] = f[o + 2] + k * f[o + 5] * b / 2;
          tip[3] = Math.max(0.22 * c, 0.15);
        }
      }
    }
    nSeg = 0;
    const seg = (ax, ay, az, bx, by, bz, g, r2) => {
      const k = nSeg * 3;
      sA[k] = ax; sA[k + 1] = ay; sA[k + 2] = az; sB[k] = bx; sB[k + 1] = by; sB[k + 2] = bz; sG[nSeg] = g; sR[nSeg] = r2; ++nSeg;
    };
    const wk = opts.wake;
    if (wk && wk.n > 0 && opts.inv) {
      // The core's wake, from the world (ENU) into the structural frame:
      // three (e, u, -n), the aircraft's inverse world matrix to body FLU,
      // then (x, -y, -z). The segments that matter for lines this close.
      const sg = wk.seg, inv = opts.inv, tiny = 0.02 * wk.gmax, lim2 = (3 * Math.max(span, L)) ** 2;
      for (let k = 0; k < wk.n && nSeg < MAXS; ++k) {
        const o = k * 9, g = sg[o + 6];
        if (Math.abs(g) < tiny) continue;
        va.set(sg[o], sg[o + 2], -sg[o + 1]).applyMatrix4(inv);
        vb.set(sg[o + 3], sg[o + 5], -sg[o + 4]).applyMatrix4(inv);
        const dA = (va.x - centre[0]) ** 2 + va.y ** 2 + (va.z + centre[2]) ** 2;
        const dB = (vb.x - centre[0]) ** 2 + vb.y ** 2 + (vb.z + centre[2]) ** 2;
        if (dA > lim2 && dB > lim2) continue;
        const rc = Math.max(sg[o + 7], 0.08);
        seg(va.x, -va.y, -va.z, vb.x, -vb.y, -vb.z, g, rc * rc);
      }
    } else {
      // Steady horseshoes from the strips' lift.
      const far = 4 * L;
      for (let i = 0; i < n && nSeg < MAXS - 3; ++i) {
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
        seg(P1[0] + ux * far, P1[1] + uy * far, P1[2] + uz * far, P1[0], P1[1], P1[2], G, rc2);
        seg(P1[0], P1[1], P1[2], P2[0], P2[1], P2[2], G, rc2 * 1.5);
        seg(P2[0], P2[1], P2[2], P2[0] + ux * far, P2[1] + uy * far, P2[2] + uz * far, G, rc2);
      }
    }
    if (wn > 0) { wing[0] = wx / wn; wing[1] = wz / wn; }
    gnd = opts.ground || null;
    // The atmosphere around the aircraft, refreshed about ten times a second.
    gridAge += dt;
    if (opts.windGrid && gridAge > 0.1) {
      gridAge = 0;
      GC[0] = f[6]; GC[1] = f[7]; GC[2] = f[8];
      GH[0] = 1.4 * L; GH[1] = span; GH[2] = 0.6 * span;
      // The streamlines show the air around the aircraft averaged over about
      // half a second (and over the grid spacing, in the core): the large
      // eddies bend them coherently; every gust is in the smoke view.
      const fresh = opts.windGrid(GH[0], GH[1], GH[2], GN[0], GN[1], GN[2]);
      if (!grid || grid.length !== fresh.length) grid = Float32Array.from(fresh);
      else for (let k = 0; k < grid.length; ++k) grid[k] += (fresh[k] - grid[k]) * 0.18;
    }
    const Q = tas * Math.PI * fu.R * fu.R;
    fuse = { src: fu.xNose - fu.R * 0.5, snk: fu.xTail + fu.R * 0.5, z: fu.z, Q, core: (fu.R * 0.3) ** 2 };
    engines = [];
    const e0 = 16 + 64 * STRIDE;
    for (let k = 0; k < (f[1] | 0); ++k) {
      const o = e0 + k * 10;
      if (f[o + 7] <= 0.1) continue;
      engines.push({ x: f[o], y: f[o + 1], z: f[o + 2], ax: f[o + 3], ay: f[o + 4], az: f[o + 5], r: f[o + 6], inc: f[o + 7], jet: f[o + 9] > 0.5 });
    }
    // Bluff bodies (structural frame): the axis made square to the flow, the
    // lateral direction across both.
    nBody = 0;
    const bd = opts.bodies;
    if (bd) {
      for (let k = 0; k < bd.n && nBody < MAXB; ++k) {
        const o = k * 10, b3 = nBody * 3;
        let ax = bd.b[o + 3], ay = bd.b[o + 4], az = bd.b[o + 5];
        const ad = ax * ux + ay * uy + az * uz;
        ax -= ad * ux; ay -= ad * uy; az -= ad * uz;
        const am = Math.hypot(ax, ay, az);
        if (am < 0.2 || bd.b[o + 8] <= 0) continue;
        ax /= am; ay /= am; az /= am;
        const len = Math.max(bd.b[o + 7], 0.05) * am;
        bP[b3] = bd.b[o]; bP[b3 + 1] = bd.b[o + 1]; bP[b3 + 2] = bd.b[o + 2];
        bA[b3] = ax; bA[b3 + 1] = ay; bA[b3 + 2] = az;
        bN[b3] = uy * az - uz * ay; bN[b3 + 1] = uz * ax - ux * az; bN[b3 + 2] = ux * ay - uy * ax;
        bD[nBody] = Math.max(bd.b[o + 6], 0.05); bH[nBody] = 0.5 * len; bC[nBody] = bd.b[o + 8] / len; bK[nBody] = bd.b[o + 9];
        ++nBody;
      }
    }
    updateTufts(f, n, opts.light);
    if (!lines.visible) return { stalled };
    // Re-trace a share of the lines each frame (a third at a time right after
    // a reset); the field changes smoothly, so a full refresh every ~20 frames (a third of a second)
    // keeps the picture current at a fraction of the cost.
    const per = Math.ceil(NL / (traced < NL ? 3 : 20));
    for (let c = 0; c < per; ++c) { traceLine(refresh); refresh = (refresh + 1) % NL; }
    traced += per;
    // Draw: segments between consecutive points; the ends fade in and out, and
    // a pulse travels along each line at the (slowed) speed of the flow.
    // Pulsed smoke: the pulses ride with the air (phase = time of flight), so
    // they bunch up at the stagnation point and race over the upper surface.
    // Slow motion: about half an aircraft length per second on screen.
    flowT += dt * Math.min(1, (opts.speed || 1) * 0.55 * L / tas);
    const period = 0.45 * L / tas, opacity = opts.light ? 0.85 : 0.7;
    let w = 0, cw = 0;
    for (let i = 0; i < NL; ++i) {
      const n = ln[i], base = i * NPT * 3;
      for (let k = 0; k < NPT - 1; ++k) {
        if (k < n - 1) {
          const oa = base + k * 3, ob = oa + 3;
          for (const [o, kk] of [[oa, k], [ob, k + 1]]) {
            segPos[w++] = lp[o]; segPos[w++] = -lp[o + 1]; segPos[w++] = -lp[o + 2];
            const pulse = 0.5 + 0.5 * Math.cos(2 * Math.PI * ((lt[i * NPT + kk] - flowT) / period + lphase[i]));
            const dn = (lp[o] - centre[0]) * ux + lp[o + 1] * uy + (lp[o + 2] - centre[2]) * uz;
            const fade = Math.min(1, kk / 8, (n - 1 - kk) / 12, Math.max(0, (1.2 * L - dn) / (0.6 * L)));
            const bright = 0.78 + 0.32 * pulse * pulse;
            segCol[cw++] = Math.min(1, lc[o] * bright); segCol[cw++] = Math.min(1, lc[o + 1] * bright); segCol[cw++] = Math.min(1, lc[o + 2] * bright);
            segCol[cw++] = opacity * fade;
          }
        } else {
          for (let q = 0; q < 6; ++q) segPos[w++] = 0;
          for (let q = 0; q < 8; ++q) segCol[cw++] = 0;
        }
      }
    }
    lineGeo.attributes.position.needsUpdate = true; lineGeo.attributes.color.needsUpdate = true;
    return { stalled };
  }
  // Tufts: along the local surface flow (the field just above the strip,
  // its component in the surface); fluttering from 85 % of the stall angle,
  // reversed and thrashing where the strip is stalled.
  const td = [0, 0, 0];
  function updateTufts(f, n, light) {
    let t = 0;
    const base = light ? [0.1, 0.1, 0.12] : [0.95, 0.95, 0.9];
    for (let i = 0; i < n && t < MAXT; ++i) {
      const o = 16 + i * STRIDE;
      const Sx = f[o + 3], Sy = f[o + 4], Sz = f[o + 5], Nx = f[o + 6], Ny = f[o + 7], Nz = f[o + 8];
      const c = f[o + 9], q = f[o + 13];
      let Cx = Sy * Nz - Sz * Ny, Cy = Sz * Nx - Sx * Nz, Cz = Sx * Ny - Sy * Nx;
      if (Cx < 0) { Cx = -Cx; Cy = -Cy; Cz = -Cz; }
      const r = f[o + 12] / Math.max(f[o + 14], 0.02), att = f[o + 16];
      for (const at of [0.1, 0.5]) {  // aft of the quarter chord: 35 % and 75 % chord
        const k = 2 * i + (at > 0.3 ? 1 : 0);
        const h = 0.05 * c + 0.02;
        const x = f[o] - Cx * at * c + Nx * h, y = f[o + 1] - Cy * at * c + Ny * h, z = f[o + 2] - Cz * at * c + Nz * h;
        velocity(x, y, z);
        let dx = out[0], dy = out[1], dz = out[2];
        if (q <= 1) { dx = -Cx; dy = -Cy; dz = -Cz; }
        const dn = dx * Nx + dy * Ny + dz * Nz;
        dx -= dn * Nx; dy -= dn * Ny; dz -= dn * Nz;
        const m = Math.hypot(dx, dy, dz) || 1;
        dx /= m; dy /= m; dz /= m;
        let len = Math.max(0.12 * c, 0.1), lift = 0;
        // Near the stall, or behind a raised spoiler (the core's attached
        // fraction: separated flow over the panel's span).
        const flutter = q > 1 ? Math.min(1, Math.max(0, (r - 0.85) / 0.15, (0.9 - att) / 0.3)) : 0;
        let ang = flutter * 0.55 * Math.sin(clockT * (17 + (k % 5)) + k * 1.7);
        const sep = q > 1 && (r > 1 || att < 0.55);
        if (sep) { ang = Math.PI * (0.62 + 0.38 * Math.sin(clockT * (9 + (k % 7)) + k)) * (k % 2 ? 1 : -1); len *= 0.85; lift = 0.45 * (0.5 + 0.5 * Math.sin(clockT * 13 + k)); }
        // Rotate about the surface normal: d cos + (N x d) sin.
        const ca = Math.cos(ang), sa = Math.sin(ang);
        td[0] = dx * ca + (Ny * dz - Nz * dy) * sa; td[1] = dy * ca + (Nz * dx - Nx * dz) * sa; td[2] = dz * ca + (Nx * dy - Ny * dx) * sa;
        const ex = x + (td[0] + Nx * lift) * len, ey = y + (td[1] + Ny * lift) * len, ez = z + (td[2] + Nz * lift) * len;
        const w6 = t * 6;
        tuftPos[w6] = x; tuftPos[w6 + 1] = -y; tuftPos[w6 + 2] = -z;
        tuftPos[w6 + 3] = ex; tuftPos[w6 + 4] = -ey; tuftPos[w6 + 5] = -ez;
        const cr = sep ? [1, 0.18, 0.12] : flutter > 0 ? [1, 0.75, 0.2] : base;
        tuftCol.set(cr, w6); tuftCol.set(cr, w6 + 3);
        ++t;
      }
    }
    tuftPos.fill(0, t * 6);
    tuftGeo.setDrawRange(0, t * 2);
    tuftGeo.attributes.position.needsUpdate = true; tuftGeo.attributes.color.needsUpdate = true;
  }
  function reset() { traced = 0; ln.fill(0); grid = null; gridAge = 1e9; }
  // The field at a point (structural frame): [air velocity, undisturbed air].
  const probe = (x, y, z) => { velocity(x, y, z); return [...out, ...still]; };
  return { group, update, reset, probe };
}
