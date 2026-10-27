// São Paulo World · driving: the induced air field around the car (see carflow.js).
// No rendering here, so it runs in tests.
// SPDX-License-Identifier: MIT
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The induced field.
export class CarFlowField {
  constructor() {
    this.U = [-1, 0, 0]; this.V = 1; this.Uh = [-1, 0, 0];
    this.src = [];     // [x, y, z, Q] (Q > 0 source, < 0 sink), images included
    this.seg = [];     // [ax, ay, az, bx, by, bz, G, core]
    this.wake = null;
    this.t = 0;
  }

  // geo: { front, rear, hw, floor, roof, zg }; f: { rho, dfFront, dfRearFloor, wing, drag };
  // wing: { span, x, y, z } or null; axles: { xf, xr }; U: air velocity relative to the car (body).
  build(geo, f, wing, axles, U) {
    const V = Math.max(1, Math.hypot(U[0], U[1], U[2]));
    this.U = U; this.V = V; this.Uh = [U[0] / V, U[1] / V, U[2] / V];
    const zg = geo.zg, zMid = zg + 0.5 * (geo.roof - zg), Uh = this.Uh;
    // Body: three sources across the nose, three sinks across the tail, and their images.
    const area = 2 * geo.hw * (geo.roof - zg) * 0.82;
    const Q = V * area;
    const off = Math.sqrt(Q / (4 * Math.PI * V));   // a half-body's nose stands this far ahead of its source
    this.src = [];
    for (const yy of [-0.5 * geo.hw, 0, 0.5 * geo.hw]) {
      for (const [x, s] of [[geo.front - off, 1], [geo.rear + off, -1]]) {
        this.src.push([x, yy, zMid, (s * Q) / 3], [x, yy, 2 * zg - zMid, (s * Q) / 3]);
      }
    }
    // Horseshoes for downforce, legs trailing 40 m downstream, with mirror images.
    this.seg = [];
    const horseshoe = (x, z, span, D, core) => {
      if (!span || Math.abs(D) < 1) return;
      const G = D / (f.rho * V * span);
      const L = 40;
      const A = [x, -span / 2, z], B = [x, span / 2, z];
      const FA = [A[0] + Uh[0] * L, A[1] + Uh[1] * L, A[2]], FB = [B[0] + Uh[0] * L, B[1] + Uh[1] * L, B[2]];
      for (const [p, q, sg] of [[FA, A, 1], [A, B, 1], [B, FB, 1]]) {
        this.seg.push([...p, ...q, sg * G, core]);
        this.seg.push([p[0], p[1], 2 * zg - p[2], q[0], q[1], 2 * zg - q[2], -sg * G, core]);  // image
      }
    };
    const width = 2 * geo.hw * 0.8;
    horseshoe(axles.xf, geo.floor - 0.02, width, f.dfFront, 0.12);
    horseshoe(axles.xr, geo.floor - 0.02, width, f.dfRearFloor, 0.12);
    if (wing) horseshoe(wing.x, wing.z, wing.span, f.wing, 0.06);
    // Wake: a deficit that carries the drag, centred behind the tail.
    const sigma0 = 0.42 * geo.hw;
    this.wake = { x: geo.rear, z: zg + 0.42 * (geo.roof - zg), zImg: zg - 0.42 * (geo.roof - zg), sigma0, D: Math.max(0, f.drag), rho: f.rho, f: 0.2 * V / (2 * geo.hw) };
    this.zg = zg;
    this.geo = geo;
  }

  // Air velocity at p (body axes) into out.
  at(p, out) {
    let ux = this.U[0], uy = this.U[1], uz = this.U[2];
    for (const s of this.src) {
      const dx = p[0] - s[0], dy = p[1] - s[1], dz = p[2] - s[2];
      const r2 = dx * dx + dy * dy + dz * dz + 0.04;
      const k = s[3] / (4 * Math.PI * r2 * Math.sqrt(r2));
      ux += k * dx; uy += k * dy; uz += k * dz;
    }
    for (const g of this.seg) {
      // Biot-Savart, a straight segment a->b with a smoothed core
      const r1x = p[0] - g[0], r1y = p[1] - g[1], r1z = p[2] - g[2];
      const r2x = p[0] - g[3], r2y = p[1] - g[4], r2z = p[2] - g[5];
      const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
      const r0x = g[3] - g[0], r0y = g[4] - g[1], r0z = g[5] - g[2];
      const l0 = r0x * r0x + r0y * r0y + r0z * r0z;
      const c2 = cx * cx + cy * cy + cz * cz + g[7] * g[7] * l0;
      const r1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z) + 1e-9, r2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z) + 1e-9;
      const dot = r0x * (r1x / r1 - r2x / r2) + r0y * (r1y / r1 - r2y / r2) + r0z * (r1z / r1 - r2z / r2);
      const k = (g[6] / (4 * Math.PI)) * dot / c2;
      ux += k * cx; uy += k * cy; uz += k * cz;
    }
    const w = this.wake;
    if (w && w.D > 0) {
      const Uh = this.Uh;
      const s = (p[0] - w.x) * Uh[0] + p[1] * Uh[1];   // distance downstream of the tail
      if (s > -0.3) {
        const sd = Math.max(0, s);
        const sigma = w.sigma0 + 0.09 * sd;
        const lx = p[0] - (w.x + Uh[0] * sd), ly = p[1] - Uh[1] * sd;
        const lat2 = lx * lx + ly * ly;
        const g1 = Math.exp(-(lat2 + (p[2] - w.z) ** 2) / (2 * sigma * sigma)), g2 = Math.exp(-(lat2 + (p[2] - w.zImg) ** 2) / (2 * sigma * sigma));
        const A = Math.min(0.6 * this.V, w.D / (w.rho * this.V * 2 * Math.PI * sigma * sigma)) * smooth(-0.3, 0.4, s);
        const def = A * (g1 + g2);
        ux -= Uh[0] * def; uy -= Uh[1] * def;
        // the vortex street: the wake sways across at the shedding frequency
        const sway = 0.35 * A * g1 * Math.sin(2 * Math.PI * w.f * this.t - 2 * Math.PI * w.f * sd / this.V);
        ux += -Uh[1] * sway; uy += Uh[0] * sway;
      }
    }
    out[0] = ux; out[1] = uy; out[2] = uz;
    return out;
  }
}

