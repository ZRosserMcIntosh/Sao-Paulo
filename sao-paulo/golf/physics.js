// Golf ball aerodynamics: the models behind every number on the page.
//
// Units are SI unless noted. The ball is a regulation golf ball:
// D = 42.67 mm, m = 45.93 g. Air at sea level, 15 °C.
//
// 1. Drag coefficient Cd(Re, S)
//    A subcritical sphere curve (laminar separation) blended into a
//    post-crisis curve with a logistic in log10(Re). For the smooth sphere the
//    crisis sits at Re ~ 3.3e5 (Achenbach 1972); for the dimpled ball at
//    Re ~ 5e4 (Bearman & Harvey 1976; Choi, Jeon & Choi 2006). Spin adds drag
//    linearly in the spin parameter S = omega r / V (Smits & Smith 1994).
// 2. Lift coefficient Cl(S): power law Cl = 0.54 S^0.4 for the dimpled ball
//    (Smits & Smith 1994 style fit). The smooth ball is ESTIMATED at half of
//    that (real smooth spheres can even show negative, "inverse" Magnus lift
//    near their drag crisis: Kim et al. 2014).
// 3. Separation angle: 82 deg (laminar) to 113 deg (dimple-tripped turbulent)
//    or 120 deg (smooth sphere, supercritical), weighted by the same logistic.
//    Backspin moves the top separation back and the bottom forward
//    (ESTIMATED shift, saturating with S).
// 4. Surface pressure Cp(theta): attached sin^2 shape to a pressure minimum,
//    recovery, then a constant base pressure after separation; shaped after
//    Achenbach's (1972) sphere measurements, tuned so the pressure-drag
//    integral lands close to the Cd above.
// 5. Trajectory: 2-D point mass with gravity, drag and Magnus lift (RK4),
//    spin decaying exponentially (ESTIMATED time constant).
// 6. The wind tunnel flow (class Tunnel): a 2-D discrete-vortex model of the
//    cross-section: uniform stream + doublet (the ball) + bound circulation
//    from Cl, with vortex blobs shed from the imposed separation points and
//    their images in the circle (Milne-Thomson). This is the classic
//    "prescribed separation" discrete-vortex method (e.g. Clements 1973).

export const D = 0.04267, R = D / 2, NU = 1.5e-5, RHO = 1.225, MASS = 0.04593, G = 9.81;
export const AREA = Math.PI * R * R;
export const RPM = (2 * Math.PI) / 60;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const logistic = (x) => 1 / (1 + Math.exp(-x));
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export const reynolds = (V) => (V * D) / NU;
export const spinParam = (rpm, V) => (rpm * RPM * R) / Math.max(V, 0.1);

// Subcritical sphere drag vs log10(Re): the standard sphere drag curve
// (Achenbach 1972, Wieselsberger data) between 3e3 and the crisis.
const SUB = [[3.5, 0.39], [4.0, 0.405], [4.5, 0.42], [5.0, 0.465], [5.3, 0.48], [5.6, 0.48], [7.0, 0.48]];
function interp(tab, x) {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; ++i) {
    if (x <= tab[i][0]) {
      const [x0, y0] = tab[i - 1], [x1, y1] = tab[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return tab[tab.length - 1][1];
}

export const CRISIS = { smooth: 3.3e5, dimpled: 5.0e4 };

// Fraction of the way through the drag crisis: 0 laminar separation, 1 turbulent.
export function regime(kind, Re) {
  const lr = Math.log10(Math.max(Re, 1));
  return kind === 'smooth' ? logistic((lr - Math.log10(CRISIS.smooth)) / 0.035) : logistic((lr - Math.log10(CRISIS.dimpled)) / 0.06);
}

export function cd0(kind, Re) {
  const lr = Math.log10(Math.max(Re, 1)), chi = regime(kind, Re);
  const sub = interp(SUB, lr) + (kind === 'dimpled' ? 0.015 : 0);
  const post = kind === 'smooth'
    ? 0.07 + 0.13 * clamp((lr - 5.57) / 0.9, 0, 1)           // supercritical smooth sphere: min ~0.07, rising to ~0.2
    : 0.235 + 0.04 * clamp((lr - 4.8) / 1.2, 0, 1);          // golf ball: ~0.24, rising slightly with Re
  return sub * (1 - chi) + post * chi;
}

export const S_FIT_MAX = 0.3;    // upper end of the S range the lift fits were made over
export function cd(kind, Re, S) { return cd0(kind, Re) + 0.18 * clamp(S, 0, 0.4); }
export function cl(kind, S) {
  const s = clamp(S, 0, 0.4);
  const c = s <= 0 ? 0 : 0.54 * Math.pow(s, 0.4);
  return kind === 'smooth' ? 0.5 * c : c;
}

export function separation(kind, Re, S) {
  const chi = regime(kind, Re);
  const lam = 82, turb = kind === 'smooth' ? 120 : 113;
  const base = lam + (turb - lam) * chi;
  const dmax = kind === 'smooth' ? 10 : 20;                  // ESTIMATE
  const shift = dmax * Math.tanh(Math.max(0, S) / 0.15);
  return { base, top: base + shift, bot: base - shift, chi, shift };
}

// Wake half-height (in ball radii) 1 D behind the centre, from the separation
// point and the direction the shear layer leaves the surface. ESTIMATE.
export function wakeHalf(thDeg) {
  const t = (thDeg * Math.PI) / 180;
  return Math.max(0.25, Math.sin(t) + 0.4 * (2 + Math.cos(t)) * (Math.cos(t) / Math.sin(t)));
}
export function wakeWidthD(sep) { return (wakeHalf(sep.top) + wakeHalf(sep.bot)) / 2; } // (h_top + h_bot) radii = /2 diameters

// Surface pressure coefficient at angle th (deg, from the front stagnation
// point, along one side). side: +1 top, -1 bottom.
export function surfaceCp(kind, chi, sepDeg, baseSep, th, side, S) {
  const thm = (72 + 18 * chi) * (sepDeg / baseSep);
  const k = 1.45 + (kind === 'smooth' ? 0.75 : 0.55) * chi; // 1 - Cp_min
  const kk = k * (1 + side * 0.9 * clamp(S, 0, 0.4));      // spin: faster over the top (ESTIMATE)
  const cpb = -0.38 + (kind === 'smooth' ? 0.28 : 0.18) * chi;
  const cpmin = 1 - kk;
  if (th <= thm) { const s = Math.sin((Math.PI / 2) * th / thm); return 1 - kk * s * s; }
  if (th <= sepDeg) return cpmin + (cpb - cpmin) * smooth01((th - thm) / Math.max(1, sepDeg - thm));
  return cpb;
}

// Pressure-drag coefficient implied by the Cp model, integrated over the sphere.
export function cdFromCp(kind, Re, S = 0) {
  const sep = separation(kind, Re, S);
  let sum = 0;
  const n = 360;
  for (let i = 0; i < n; ++i) {
    const th = ((i + 0.5) / n) * 180, t = (th * Math.PI) / 180;
    const cp = 0.5 * (surfaceCp(kind, sep.chi, sep.top, sep.base, th, 1, S) + surfaceCp(kind, sep.chi, sep.bot, sep.base, th, -1, S));
    sum += cp * Math.sin(t) * Math.cos(t) * (Math.PI / n);
  }
  return 2 * sum;
}

// Laminar / turbulent boundary-layer thickness at angle th (deg) on the
// sphere, ESTIMATES from flat-plate correlations with the potential-flow edge
// speed 1.5 V sin(theta). Returns metres.
export function blThickness(V, thDeg, turbulent) {
  const t = Math.max((thDeg * Math.PI) / 180, 0.05);
  const x = R * t, Ue = Math.max(1.5 * V * Math.sin(t), 1.5 * V * 0.05);
  const Rex = (Ue * x) / NU;
  return turbulent ? (0.37 * x) / Math.pow(Rex, 0.2) : (5.0 * x) / Math.sqrt(Rex);
}

// Flight: launch speed V0 (m/s), angle (deg), backspin (rpm).
export const SPIN_TAU = 25; // s, spin decay time constant (ESTIMATE, ~4 %/s)
export function fly(kind, V0, angDeg, rpm, opt = {}) {
  const a = (angDeg * Math.PI) / 180, k = (0.5 * RHO * AREA) / MASS;
  let s = [0, 0, V0 * Math.cos(a), V0 * Math.sin(a), rpm * RPM];
  const dt = opt.dt || 0.004;
  const pts = [[0, 0, 0]];
  const f = (st) => {
    const vx = st[2], vy = st[3], V = Math.hypot(vx, vy) || 1e-6;
    const Re = reynolds(V), S = (st[4] * R) / V;
    const Cd = cd(kind, Re, S), Cl = cl(kind, S);
    const q = k * V * V;
    const ux = vx / V, uy = vy / V;
    return [vx, vy, q * (-Cd * ux - Cl * uy), q * (-Cd * uy + Cl * ux) - G, -st[4] / SPIN_TAU];
  };
  let t = 0, apex = 0;
  for (let it = 0; it < 20000; ++it) {
    const k1 = f(s), s2 = s.map((v, i) => v + 0.5 * dt * k1[i]);
    const k2 = f(s2), s3 = s.map((v, i) => v + 0.5 * dt * k2[i]);
    const k3 = f(s3), s4 = s.map((v, i) => v + dt * k3[i]);
    const k4 = f(s4);
    const n = s.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    t += dt;
    if (n[1] < 0) {
      const fr = s[1] / (s[1] - n[1]);
      const xl = s[0] + fr * (n[0] - s[0]), tl = t - dt + fr * dt;
      const vx = s[2] + fr * (n[2] - s[2]), vy = s[3] + fr * (n[3] - s[3]);
      pts.push([xl, 0, tl]);
      return { carry: xl, apex, time: tl, pts, landAngle: (Math.atan2(-vy, vx) * 180) / Math.PI, landSpeed: Math.hypot(vx, vy) };
    }
    s = n;
    apex = Math.max(apex, s[1]);
    if (it % 5 === 0) pts.push([s[0], s[1], t]);
  }
  return { carry: s[0], apex, time: t, pts, landAngle: 0, landSpeed: 0 };
}

// ---------------------------------------------------------------------------
// Wind tunnel cross-section: discrete-vortex model with prescribed separation.
// Non-dimensional: ball radius 1, free stream 1 along +x, centre at origin.
// Front stagnation point at polar angle pi. Circulation counter-clockwise +.
const TWO_PI = 2 * Math.PI;
export class Tunnel {
  constructor(kind, cap = 360) {
    this.kind = kind; this.cap = cap;
    this.x = new Float64Array(cap); this.y = new Float64Array(cap); this.g = new Float64Array(cap);
    this.age = new Float64Array(cap); this.c2 = new Float64Array(cap);
    this.ix = new Float64Array(cap); this.iy = new Float64Array(cap);
    this.n = 0; this.gc = 0; this.top = 82; this.bot = 82; this.turb = 0; this.t = 0;
    this.xmax = 10; this.ymax = 6;
    this.kx = new Float64Array(cap); this.ky = new Float64Array(cap);
    this.rng = 1;
  }
  setState({ top, bot, gammaC, turb, xmax, ymax }) {
    this.top = top; this.bot = bot; this.gc = gammaC; this.turb = turb;
    if (xmax) this.xmax = xmax; if (ymax) this.ymax = ymax;
  }
  rand() { // deterministic LCG so runs are repeatable
    this.rng = (this.rng * 1664525 + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }
  images() {
    for (let k = 0; k < this.n; ++k) {
      const r2 = this.x[k] * this.x[k] + this.y[k] * this.y[k];
      this.ix[k] = this.x[k] / r2; this.iy[k] = this.y[k] / r2;
    }
  }
  // Velocity at (px, py); writes out[0], out[1]. Assumes images() is current.
  vel(px, py, out) {
    let r2 = px * px + py * py;
    if (r2 < 1e-4) r2 = 1e-4;
    const r4 = r2 * r2;
    let u = 1 - (px * px - py * py) / r4, v = (-2 * px * py) / r4;
    const gc = this.gc / (TWO_PI * r2);
    u -= gc * py; v += gc * px;
    const n = this.n, X = this.x, Y = this.y, Gm = this.g, C = this.c2, IX = this.ix, IY = this.iy;
    for (let k = 0; k < n; ++k) {
      let dx = px - X[k], dy = py - Y[k];
      let q = Gm[k] / (dx * dx + dy * dy + C[k]);
      u -= q * dy; v += q * dx;
      dx = px - IX[k]; dy = py - IY[k];
      q = Gm[k] / (dx * dx + dy * dy + C[k]);
      u += q * dy; v -= q * dx;
    }
    out[0] = u; out[1] = v;
  }
  // As vel(), plus out[2] = squared distance to the nearest wake vortex.
  velW(px, py, out) {
    let r2 = px * px + py * py;
    if (r2 < 1e-4) r2 = 1e-4;
    const r4 = r2 * r2;
    let u = 1 - (px * px - py * py) / r4, v = (-2 * px * py) / r4;
    const gc = this.gc / (TWO_PI * r2);
    u -= gc * py; v += gc * px;
    const n = this.n, X = this.x, Y = this.y, Gm = this.g, C = this.c2, IX = this.ix, IY = this.iy;
    let dm = 1e9;
    for (let k = 0; k < n; ++k) {
      let dx = px - X[k], dy = py - Y[k];
      let d2 = dx * dx + dy * dy;
      if (d2 < dm) dm = d2;
      let q = Gm[k] / (d2 + C[k]);
      u -= q * dy; v += q * dx;
      dx = px - IX[k]; dy = py - IY[k];
      q = Gm[k] / (dx * dx + dy * dy + C[k]);
      u += q * dy; v -= q * dx;
    }
    out[0] = u; out[1] = v; out[2] = dm;
  }
  shedFrom(side, dt, out) {
    const th = ((side > 0 ? this.top : this.bot) * Math.PI) / 180;
    const phi = side > 0 ? Math.PI - th : th - Math.PI;
    const rs = 1.06;
    this.vel(rs * Math.cos(phi), rs * Math.sin(phi), out);
    // Downstream tangent along the surface.
    const tx = side > 0 ? Math.sin(phi) : -Math.sin(phi), ty = side > 0 ? -Math.cos(phi) : Math.cos(phi);
    const us = out[0] * tx + out[1] * ty;
    if (us <= 0.05 || this.n >= this.cap) return;
    // Vorticity flux out of the boundary layer: dGamma/dt = 1/2 Ue^2, with the
    // customary reduction (~0.6) for the inviscid model's over-production.
    const dG = 0.6 * 0.5 * us * us * dt;
    const k = this.n++;
    const rr = 1.12 + 0.03 * this.rand(), ph = phi - side * (0.03 + 0.02 * this.rand());
    this.x[k] = rr * Math.cos(ph) + 0.5 * us * dt * tx; this.y[k] = rr * Math.sin(ph) + 0.5 * us * dt * ty;
    this.g[k] = (-side * dG) / TWO_PI;  // stored as Gamma / 2pi
    this.age[k] = 0; this.c2[k] = 0.12 * 0.12;
  }
  step(dt) {
    const out = [0, 0];
    this.images();
    this.shedFrom(1, dt, out);
    this.shedFrom(-1, dt, out);
    this.images();
    const n = this.n;
    // Midpoint (RK2) advection of the vortices.
    const x0 = Float64Array.from(this.x.subarray(0, n)), y0 = Float64Array.from(this.y.subarray(0, n));
    for (let k = 0; k < n; ++k) { this.vel(this.x[k], this.y[k], out); this.kx[k] = out[0]; this.ky[k] = out[1]; }
    for (let k = 0; k < n; ++k) { this.x[k] = x0[k] + 0.5 * dt * this.kx[k]; this.y[k] = y0[k] + 0.5 * dt * this.ky[k]; }
    this.images();
    for (let k = 0; k < n; ++k) { this.vel(this.x[k], this.y[k], out); this.kx[k] = out[0]; this.ky[k] = out[1]; }
    // Random walk = diffusion (turbulent eddy viscosity, a modelling choice).
    const sig = Math.sqrt(2 * dt * (this.turb ? 0.0016 : 0.0011));
    const decay = Math.exp(-dt / 14);
    for (let k = 0; k < n; ++k) {
      const g1 = this.rand() || 1e-9, g2 = this.rand();
      const m = Math.sqrt(-2 * Math.log(g1)) * sig;
      this.x[k] = x0[k] + dt * this.kx[k] + m * Math.cos(TWO_PI * g2);
      this.y[k] = y0[k] + dt * this.ky[k] + m * Math.sin(TWO_PI * g2);
      this.age[k] += dt; this.g[k] *= decay;
      this.c2[k] = 0.0144 + 0.012 * this.age[k];
    }
    // Remove vortices that left the test section or hit the ball.
    let w = 0;
    for (let k = 0; k < n; ++k) {
      const r2 = this.x[k] * this.x[k] + this.y[k] * this.y[k];
      if (this.x[k] > this.xmax || Math.abs(this.y[k]) > this.ymax || r2 < 1.0 || this.x[k] < -3) continue;
      if (r2 < 1.03 * 1.03) { const s = 1.03 / Math.sqrt(r2); this.x[k] *= s; this.y[k] *= s; }
      if (w !== k) { this.x[w] = this.x[k]; this.y[w] = this.y[k]; this.g[w] = this.g[k]; this.age[w] = this.age[k]; this.c2[w] = this.c2[k]; }
      ++w;
    }
    this.n = w;
    this.images();
    this.t += dt;
  }
}
