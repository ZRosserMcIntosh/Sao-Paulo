// Golf Ball Aerodynamics: the slow-motion wind tunnel, charts and flight.
// All physics lives in physics.js; this file drives it and draws it.
import * as P from './physics.js';

const $ = (s) => document.querySelector(s);
const DEG = 180 / Math.PI;
const SLOWS = [250, 500, 1000, 2000, 5000, 10000];
const MPH = 2.2369363, YD = 1.0936133;
const COL = { smooth: '#8fd8ff', dimpled: '#ffd36b' };
const NAME = { smooth: 'Smooth ball', dimpled: 'Dimpled ball' };
const MONO = '"JetBrains Mono",ui-monospace,Menlo,monospace';
const DISP = '"Big Shoulders Display","Arial Narrow",Impact,sans-serif';

// Launch presets: TrackMan PGA Tour averages (ball speed m/s, spin rpm,
// launch deg). The club delivery that produces them is solved from the
// impact model (physics.js), so the club you see is consistent with the ball.
const PRESETS = {
  driver: { club: 'driver', V: 74.7, rpm: 2686, ang: 10.9 },
  iron: { club: 'iron7', V: 53.6, rpm: 7097, ang: 16.3 },
  wedge: { club: 'wedge', V: 45.6, rpm: 9304, ang: 24.2 },
  knuckle: { club: 'driver', V: 74.7, rpm: 0, ang: 10.9 },
};
const state = {
  mode: 'dimpled', V: 74.7, rpm: 2686, ang: 10.9, slow: 3, paused: false, club: 'driver',
  layers: { smoke: true, tracers: true, skin: true, inset: true, forces: true, labels: true },
  inspect: { th: 100, side: 1 },
};

// The shot: the club approaches, strikes, the ball leaves the face, then the
// air flows. shot.t is real time from first contact (negative before it).
// The approach always lasts about PRE_SCREEN seconds on screen, whatever the
// slow motion, so the club covers V x PRE_SCREEN / slow before contact.
const PRE_SCREEN = 1.0;
const shot = { imp: null, t: 0, T0: 0 };
function solveShot() { shot.imp = P.solveImpact(P.CLUBS[state.club], state.V, state.ang, state.rpm); }
// Fraction of the final ball speed reached t seconds after first contact.
function flowFraction(t) { return t <= 0 || !shot.imp ? (shot.imp ? 0 : 1) : P.impulseFraction(shot.imp, t); }
// Integral of that fraction over [a, b] (seconds): flow distance / final speed.
function flowIntegral(a, b) {
  if (!shot.imp) return b - a;
  if (b <= 0) return 0;
  a = Math.max(a, 0);
  const tau = shot.imp.tau;
  let sum = 0;
  if (a < tau) {
    const e = Math.min(b, tau), n = 24, hh = (e - a) / n;
    for (let i = 0; i < n; ++i) sum += flowFraction(a + (i + 0.5) * hh) * hh;
    a = e;
  }
  return sum + Math.max(0, b - a);
}

// ---------------------------------------------------------------- colour
function turbo(t) {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  const c = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));
  return [c(r), c(g), c(b)];
}
const NB = 28;
const TURBO = Array.from({ length: NB }, (_, i) => turbo(0.06 + 0.92 * (i / (NB - 1))));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const tcol = (t, a = 1) => rgba(turbo(t), a);
const spBucket = (s) => { const t = s / 1.8; return t <= 0 ? 0 : t >= 1 ? NB - 1 : (t * (NB - 1)) | 0; };

// ---------------------------------------------------------------- formatting
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
function sci(x, d = 2) {
  const e = Math.floor(Math.log10(x)), m = x / 10 ** e;
  return `${m.toFixed(d)}×10${String(e).split('').map((c) => SUP[c]).join('')}`;
}
const f2 = (x) => x.toFixed(2), f3 = (x) => x.toFixed(3);

// ---------------------------------------------------------------- derived physics
function derive(kind) {
  const V = state.V, Re = P.reynolds(V), S = P.spinParam(state.rpm, V);
  const sep = P.separation(kind, Re, S);
  const Cd = P.cd(kind, Re, S), Cl = P.cl(kind, S), q = 0.5 * P.RHO * V * V * P.AREA;
  return { kind, V, Re, S, sep, Cd, Cd0: P.cd0(kind, Re), Cl, drag: q * Cd, lift: q * Cl, weight: P.MASS * P.G, wake: P.wakeWidthD(sep) };
}

// Boundary-layer profiles, u/Ue as a function of y/delta.
function pohl(eta, lam) {
  if (eta >= 1) return 1;
  if (eta <= 0) return 0;
  return 2 * eta - 2 * eta ** 3 + eta ** 4 + (lam / 6) * eta * (1 - eta) ** 3;
}
const pow7 = (eta, n = 7) => (eta >= 1 ? 1 : eta <= 0 ? 0 : Math.pow(eta, 1 / n));

// ---------------------------------------------------------------- ball textures
function ballTexture(kind, Rpx) {
  const s = Math.ceil(Rpx * 2 + 4), c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d'), m = s / 2;
  g.translate(m, m);
  g.fillStyle = '#f4f6f9';
  g.beginPath(); g.arc(0, 0, Rpx, 0, 2 * Math.PI); g.fill();
  if (kind === 'dimpled') {
    const N = 340, ga = Math.PI * (3 - Math.sqrt(5)), alpha = Math.sqrt((4 * Math.PI) / N) * 0.47;
    for (let i = 0; i < N; ++i) {
      const z = 1 - (2 * (i + 0.5)) / N, rr = Math.sqrt(1 - z * z), th = ga * i;
      const x = Math.cos(th) * rr, y = Math.sin(th) * rr;
      // Spin axis is the view axis, so the visible face is a hemisphere in x-z.
      if (y <= 0.02) continue;
      const px = x * Rpx, py = z * Rpx, ang = Math.atan2(py, px);
      const rt = alpha * Rpx, rn = alpha * Rpx * y;
      g.save(); g.translate(px, py); g.rotate(ang);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, rt);
      gr.addColorStop(0, 'rgba(120,132,150,.10)'); gr.addColorStop(0.75, 'rgba(110,122,140,.30)'); gr.addColorStop(1, 'rgba(255,255,255,.0)');
      g.fillStyle = gr; g.scale(rn / rt, 1);
      g.beginPath(); g.arc(0, 0, rt, 0, 2 * Math.PI); g.fill();
      g.restore();
    }
  } else {
    // A printed alignment line so the spin is visible.
    g.strokeStyle = 'rgba(20,40,80,.55)'; g.lineWidth = Math.max(1.5, Rpx * 0.035);
    g.beginPath(); g.moveTo(-Rpx * 0.97, -Rpx * 0.08); g.lineTo(Rpx * 0.97, -Rpx * 0.08); g.stroke();
    g.fillStyle = 'rgba(200,40,40,.6)';
    g.beginPath(); g.arc(Rpx * 0.45, Rpx * 0.38, Rpx * 0.06, 0, 2 * Math.PI); g.fill();
  }
  return c;
}

// ---------------------------------------------------------------- one tunnel lane
const DE = 0.075;      // smoke emission interval (non-dimensional time): fine streaklines
// Unresolved small-scale turbulence: a smooth, divergence-free 'curl noise'
// field (illustrative), switched on near the wake vortices and in the
// turbulent boundary layer.
const NZ = [[5.3, 3.1, 2.9, 0.3], [-3.7, 6.2, -3.4, 1.9], [7.9, -4.6, 4.1, 4.2], [-6.1, -7.3, -2.2, 2.7]];
function noise(x, y, t, o) {
  let u = 0, v = 0;
  for (let i = 0; i < 4; ++i) { const z = NZ[i], c = Math.cos(z[0] * x + z[1] * y + z[2] * t + z[3]); u += z[1] * c; v -= z[0] * c; }
  o[0] = u; o[1] = v;
}
class Lane {
  constructor(kind) {
    this.kind = kind;
    this.tun = new P.Tunnel(kind, 300);
    this.tun.rng = kind === 'smooth' ? 7 : 11;
    this.d = derive(kind);
    this.spinAng = 0;
    this.eacc = 0;
    this.tex = null; this.texR = 0;
    this.ins = { parts: [], eddies: [], off: 0, t: 0 };
    this.ready = false;
  }
  sync() {
    this.d = derive(this.kind);
    this.tun.setState({ top: this.d.sep.top, bot: this.d.sep.bot, gammaC: -this.d.Cl, turb: this.d.sep.chi > 0.5 });
  }
  preroll() {
    this.sync();
    this.tun.n = 0;
    for (let i = 0; i < 230; ++i) this.tun.step(0.065);
    this.ready = true;
  }
  layout(x, y, w, h, q, narrow) {
    this.rect = { x, y, w, h };
    this.narrow = narrow;
    const R = Math.max(22, Math.min(h * 0.17, w * (narrow ? 0.108 : 0.082)));
    this.R = R; this.cx = x + w * (narrow ? 0.3 : 0.27); this.cy = y + h * 0.5;
    this.xl = (x - this.cx) / R; this.xr = (x + w - this.cx) / R; this.yh = h / 2 / R;
    this.tun.xmax = this.xr + 0.8; this.tun.ymax = this.yh + 1.5;
    if (!this.ready) { if (shot.imp) { this.sync(); this.tun.n = 0; this.ready = true; } else this.preroll(); }
    // Smoke rake: dense through the ball's frontal band, sparser outside.
    const dense = 0.13 / q, sparse = 0.36 / Math.sqrt(q), ys = [];
    for (let yy = dense * 0.5; yy < this.yh - 0.1; yy += Math.abs(yy) < 1.7 ? dense : sparse) ys.push(yy);
    this.ys = [...ys.map((v) => -v).reverse(), ...ys];
    // Emitter start points: the rake, plus smoke ports on the ball's front
    // face (as in dye-injection experiments) that feed the boundary layer.
    this.ex = this.ys.map(() => this.xl + 0.12); this.ey = this.ys.slice();
    for (const th of [25, 50]) for (const side of [1, -1]) {
      const phi = side > 0 ? Math.PI - th / DEG : th / DEG - Math.PI, rr = 1.035;
      this.ex.push(rr * Math.cos(phi)); this.ey.push(rr * Math.sin(phi));
    }
    this.E = this.ex.length;
    this.C = Math.ceil((this.xr - this.xl + 1) / DE / 0.75) + 4;
    const n = this.E * this.C;
    this.sx = new Float32Array(n); this.sy = new Float32Array(n); this.sa = new Float32Array(n); this.ss = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.head = 0;
    this.xe = this.xl + 0.12;
    // Tracers
    this.NT = Math.round(Math.min(450, (w * h) / 1300) * q);
    this.TL = 9;
    this.tx = new Float32Array(this.NT * this.TL); this.ty = new Float32Array(this.NT * this.TL);
    this.ts = new Float32Array(this.NT); this.tage = new Float32Array(this.NT);
    this.thead = 0;
    for (let i = 0; i < this.NT; ++i) this.respawnTracer(i, true);
    if (shot.imp && shot.t < 0) this.prefillStill(); else this.prefill();
    if (this.texR !== Math.round(R)) { this.texS = window.devicePixelRatio > 1 ? 2 : 1; this.tex = ballTexture(this.kind, R * this.texS); this.texR = Math.round(R); }
  }
  respawnTracer(i, scatter) {
    let x, y;
    for (let tries = 0; tries < 20; ++tries) {
      x = scatter ? this.xl + Math.random() * (this.xr - this.xl) : this.xl + Math.random() * 0.3;
      y = (Math.random() * 2 - 1) * this.yh;
      if (x * x + y * y > 1.1) break;
    }
    for (let k = 0; k < this.TL; ++k) { this.tx[i * this.TL + k] = x; this.ty[i * this.TL + k] = y; }
    this.tage[i] = 0;
  }
  // Before the impact the air is still: the smoke hangs in straight lines
  // (none inside the ball). The ball's start sets it moving.
  prefillStill() {
    const C = this.C;
    this.alive.fill(0);
    this.head = 0;
    for (let e = 0; e < this.E; ++e) {
      if (this.ex[e] * this.ex[e] + this.ey[e] * this.ey[e] < 1.2) continue;  // ports on the ball: no smoke yet
      let x = this.ex[e];
      const y = this.ey[e];
      for (let k = 0; k < C; ++k) {
        const idx = e * C + ((C - 1 - k + C) % C);
        if (x > this.xr + 0.3) break;
        if (x * x + y * y > 1.0816) { this.sx[idx] = x; this.sy[idx] = y; this.sa[idx] = k * DE; this.alive[idx] = 1; this.ss[idx] = 0; }
        x += DE;
      }
    }
    for (let i = 0; i < this.NT; ++i) this.ts[i] = 0;
  }
  // Fill the smoke lines along the current instantaneous streamlines, so the
  // tunnel opens with smoke already flowing.
  prefill() {
    const o = [0, 0, 0], tun = this.tun, C = this.C;
    tun.images();
    this.alive.fill(0);
    this.head = 0;
    for (let e = 0; e < this.E; ++e) {
      let x = this.ex[e], y = this.ey[e];
      for (let k = 0; k < C; ++k) {
        const idx = e * C + ((C - 1 - k + C) % C);
        if (x > this.xr + 0.3 || Math.abs(y) > this.yh + 0.5) break;
        this.sx[idx] = x; this.sy[idx] = y; this.sa[idx] = k * DE; this.alive[idx] = 1;
        for (let s = 0; s < 2; ++s) {
          tun.vel(x, y, o);
          x += o[0] * DE * 0.5; y += o[1] * DE * 0.5;
          const r2 = x * x + y * y;
          if (r2 < 1.0016) { const f = 1.02 / Math.sqrt(r2); x *= f; y *= f; }
        }
        this.ss[idx] = Math.hypot(o[0], o[1]);
      }
    }
  }
  // Velocity seen by a smoke particle: the model field, slowed inside the
  // (visually thickened) boundary layer where the flow is still attached.
  pvel(px, py, o) {
    this.tun.velW(px, py, o);
    const r2 = px * px + py * py, d = this.d;
    const turbBL = d.sep.chi > 0.5;
    const dv = turbBL ? 0.17 : 0.11;
    if (r2 < (1 + dv) * (1 + dv)) {
      const th = 180 - Math.abs(Math.atan2(py, px)) * DEG;
      const ts = py >= 0 ? d.sep.top : d.sep.bot;
      if (th < ts) {
        const eta = (Math.sqrt(r2) - 1) / dv;
        const f = turbBL && th > 12 ? Math.max(0.05, pow7(eta)) : Math.max(0.03, pohl(eta, 7 - 19 * (th / ts)));
        o[0] *= f; o[1] *= f;
        o[3] = turbBL ? 1 : 0;       // flag: near-wall turbulence
        return;
      }
    }
    o[3] = 0;
  }
  step(h) {
    const tun = this.tun;
    tun.step(h);
    const o = [0, 0, 0, 0];
    // Emit
    this.eacc += h;
    while (this.eacc >= DE) {
      this.eacc -= DE;
      for (let e = 0; e < this.E; ++e) {
        const idx = e * this.C + this.head;
        this.sx[idx] = this.ex[e]; this.sy[idx] = this.ey[e]; this.sa[idx] = 0; this.alive[idx] = 1; this.ss[idx] = 1;
      }
      this.head = (this.head + 1) % this.C;
    }
    const nzA = 0.016, tt = tun.t, nz = [0, 0];
    const xmax = this.xr + 0.3, ymax = this.yh + 0.5, n = this.E * this.C;
    const SX = this.sx, SY = this.sy;
    for (let i = 0; i < n; ++i) {
      if (!this.alive[i]) continue;
      let x = SX[i], y = SY[i];
      // Midpoint (RK2) step: second-order streaklines, crisp through the
      // strong gradients at the shoulders and around the wake vortices.
      this.pvel(x, y, o);
      const xm = x + 0.5 * h * o[0], ym = y + 0.5 * h * o[1];
      this.pvel(xm, ym, o);
      let u = o[0], v = o[1];
      const wgt = (o[2] < 1.2 ? Math.exp(-o[2] / 0.3) : 0) + (o[3] ? 0.35 : 0);
      if (wgt > 0.02) { noise(xm, ym, tt, nz); u += nzA * wgt * nz[0]; v += nzA * wgt * nz[1]; }
      x += u * h;
      y += v * h;
      const r2 = x * x + y * y;
      if (r2 < 1.0016) { const f = 1.02 / Math.sqrt(r2); x *= f; y *= f; }
      SX[i] = x; SY[i] = y; this.ss[i] = Math.hypot(u, v); this.sa[i] += h;
      if (x > xmax || x < this.xl - 0.5 || y > ymax || y < -ymax) this.alive[i] = 0;
    }
    // Tracers
    const TL = this.TL;
    this.thead = (this.thead + 1) % TL;
    const hd = this.thead, pv = (hd - 1 + TL) % TL;
    for (let i = 0; i < this.NT; ++i) {
      let x = this.tx[i * TL + pv], y = this.ty[i * TL + pv];
      this.pvel(x, y, o);
      this.pvel(x + 0.5 * h * o[0], y + 0.5 * h * o[1], o);
      const wgt = (o[2] < 1.2 ? Math.exp(-o[2] / 0.3) : 0) + (o[3] ? 0.35 : 0);
      if (wgt > 0.02) { noise(x, y, tt, nz); o[0] += nzA * wgt * nz[0]; o[1] += nzA * wgt * nz[1]; }
      x += o[0] * h;
      y += o[1] * h;
      const r2 = x * x + y * y;
      if (r2 < 1.0016) { const f = 1.02 / Math.sqrt(r2); x *= f; y *= f; }
      this.tx[i * TL + hd] = x; this.ty[i * TL + hd] = y; this.ts[i] = Math.hypot(o[0], o[1]);
      this.tage[i] += h;
      if (x > xmax || Math.abs(y) > ymax || this.tage[i] > 40) this.respawnTracer(i, false);
    }
  }
}

// ---------------------------------------------------------------- canvas setup
const cv = $('#tv'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
const lanes = { smooth: new Lane('smooth'), dimpled: new Lane('dimpled') };
let quality = 1;
function visible() { return state.mode === 'split' ? [lanes.smooth, lanes.dimpled] : [lanes[state.mode]]; }

function layout() {
  // Phones get a taller tunnel in split view, so each lane keeps room.
  const want = state.mode === 'split' && window.innerWidth < 640 ? 'min(780px, 94svh)' : '';
  if (cv.style.height !== want) cv.style.height = want;
  const r = cv.getBoundingClientRect();
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = r.width; H = r.height;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  const narrow = W < 640;
  const base = (narrow ? 0.6 : 1) * quality;
  const vis = visible();
  if (vis.length === 1) vis[0].layout(0, 0, W, H, base, narrow);
  else { vis[0].layout(0, 0, W, H / 2, base * 0.75, narrow); vis[1].layout(0, H / 2, W, H / 2, base * 0.75, narrow); }
}

// ---------------------------------------------------------------- drawing
function arrow(x0, y0, x1, y1, col, lw, label, labelSide) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  if (L < 3) return;
  const ux = dx / L, uy = dy / L, hs = Math.min(11, 4 + L * 0.25);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = lw + 3;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * hs * 0.8, y1 - uy * hs * 0.8); ctx.stroke();
  ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.shadowColor = col; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * hs * 0.8, y1 - uy * hs * 0.8); ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - ux * hs - uy * hs * 0.55, y1 - uy * hs + ux * hs * 0.55); ctx.lineTo(x1 - ux * hs + uy * hs * 0.55, y1 - uy * hs - ux * hs * 0.55); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  if (label) {
    ctx.font = `600 11px ${MONO}`;
    ctx.textBaseline = 'middle';
    const [lx, ly, al] = labelSide;
    ctx.textAlign = al;
    ctx.fillStyle = 'rgba(4,7,12,.7)';
    const tw = ctx.measureText(label).width;
    const bx = al === 'left' ? lx - 4 : al === 'right' ? lx - tw - 4 : lx - tw / 2 - 4;
    ctx.fillRect(bx, ly - 9, tw + 8, 18);
    ctx.fillStyle = col; ctx.fillText(label, lx, ly);
  }
  ctx.restore();
}

function drawLaneBackground(L) {
  const { x, y, w, h } = L.rect;
  const g = ctx.createRadialGradient(L.cx, L.cy, L.R * 0.5, L.cx, L.cy, Math.max(w, h) * 0.8);
  g.addColorStop(0, '#0d1626'); g.addColorStop(0.55, '#070c16'); g.addColorStop(1, '#03050a');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  // Test-section floor and ceiling glow
  const e = ctx.createLinearGradient(0, y, 0, y + h);
  e.addColorStop(0, 'rgba(70,110,180,.10)'); e.addColorStop(0.06, 'rgba(70,110,180,0)'); e.addColorStop(0.94, 'rgba(70,110,180,0)'); e.addColorStop(1, 'rgba(70,110,180,.10)');
  ctx.fillStyle = e; ctx.fillRect(x, y, w, h);
  // Grid: one ball diameter.
  ctx.strokeStyle = 'rgba(140,170,220,.05)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = Math.ceil(L.xl / 2); k <= L.xr / 2; ++k) { const X = Math.round(L.cx + k * 2 * L.R) + 0.5; ctx.moveTo(X, y); ctx.lineTo(X, y + h); }
  for (let k = Math.ceil(-L.yh / 2); k <= L.yh / 2; ++k) { const Y = Math.round(L.cy - k * 2 * L.R) + 0.5; ctx.moveTo(x, Y); ctx.lineTo(x + w, Y); }
  ctx.stroke();
  // Ruler: x/D from the ball centre.
  if (state.layers.labels) {
    ctx.font = `500 10px ${MONO}`; ctx.fillStyle = 'rgba(147,160,178,.55)'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let k = 1; k <= L.xr / 2 - 0.3; ++k) ctx.fillText(`${k} D`, L.cx + k * 2 * L.R, y + h - 6);
  }
  // Smoke rake
  ctx.fillStyle = 'rgba(160,180,210,.25)';
  ctx.fillRect(L.cx + L.xe * L.R - 3, y + 8, 2, h - 16);
}

function drawSmoke(L) {
  const C = L.C, E = L.E, R = L.R, cx = L.cx, cy = L.cy;
  const paths = new Array(NB * 3);
  for (let i = 0; i < paths.length; ++i) paths[i] = null;
  const maxGap2 = 0.26 * 0.26;
  for (let e = 0; e < E; ++e) {
    let prev = -1;
    for (let k = 0; k < C; ++k) {
      const idx = e * C + ((L.head - 1 - k + 2 * C) % C);
      if (!L.alive[idx]) { prev = -1; continue; }
      if (prev >= 0) {
        const dx = L.sx[idx] - L.sx[prev], dy = L.sy[idx] - L.sy[prev];
        if (dx * dx + dy * dy < maxGap2) {
          const a = L.sa[idx], ab = a < 4 ? 0 : a < 9 ? 1 : 2;
          const b = spBucket(0.5 * (L.ss[idx] + L.ss[prev]));
          const pi = ab * NB + b;
          const p = paths[pi] || (paths[pi] = new Path2D());
          p.moveTo(cx + L.sx[prev] * R, cy - L.sy[prev] * R);
          p.lineTo(cx + L.sx[idx] * R, cy - L.sy[idx] * R);
        }
      }
      prev = idx;
    }
  }
  const s = Math.max(0.8, R / 90);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const AL = [0.85, 0.55, 0.3];
  for (let pass = glow ? 0 : 1; pass < 2; ++pass) {
    ctx.lineWidth = pass === 0 ? 3.2 * s : 0.85 * s;
    for (let ab = 0; ab < 3; ++ab) for (let b = 0; b < NB; ++b) {
      const p = paths[ab * NB + b];
      if (!p) continue;
      ctx.strokeStyle = rgba(TURBO[b], AL[ab] * (pass === 0 ? 0.12 : 0.8));
      ctx.stroke(p);
    }
  }
  ctx.restore();
}

let glowSprite = null;
function drawVortices(L) {
  if (!glowSprite) {
    glowSprite = document.createElement('canvas'); glowSprite.width = glowSprite.height = 64;
    const g = glowSprite.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(120,160,255,.8)'); gr.addColorStop(0.35, 'rgba(90,120,240,.28)'); gr.addColorStop(1, 'rgba(90,120,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  }
  const t = L.tun;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < t.n; ++k) {
    const a = Math.min(1, Math.abs(t.g[k]) * 260);
    if (a < 0.05) continue;
    const s = L.R * (0.35 + Math.sqrt(t.c2[k]) * 1.6);
    ctx.globalAlpha = a * 0.085;
    ctx.drawImage(glowSprite, L.cx + t.x[k] * L.R - s, L.cy - t.y[k] * L.R - s, 2 * s, 2 * s);
  }
  ctx.restore();
}

function drawTracers(L) {
  const TL = L.TL, R = L.R, cx = L.cx, cy = L.cy, hd = L.thead;
  const paths = new Array(NB).fill(null), heads = new Array(NB).fill(null);
  for (let i = 0; i < L.NT; ++i) {
    const b = spBucket(L.ts[i]);
    const p = paths[b] || (paths[b] = new Path2D());
    let k = hd, X = cx + L.tx[i * TL + k] * R, Y = cy - L.ty[i * TL + k] * R;
    const hp = heads[b] || (heads[b] = new Path2D());
    hp.rect(X - 1, Y - 1, 2, 2);
    p.moveTo(X, Y);
    for (let s = 1; s < TL - 1; ++s) {
      k = (hd - s + TL) % TL;
      const X2 = cx + L.tx[i * TL + k] * R, Y2 = cy - L.ty[i * TL + k] * R;
      if (Math.abs(X2 - X) > R * 1.2 || Math.abs(Y2 - Y) > R * 1.2) break;
      p.lineTo(X2, Y2); X = X2; Y = Y2;
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 1;
  for (let b = 0; b < NB; ++b) {
    if (paths[b]) { ctx.strokeStyle = rgba(TURBO[b], 0.35); ctx.stroke(paths[b]); }
    if (heads[b]) { ctx.fillStyle = rgba(TURBO[b], 0.9); ctx.fill(heads[b]); }
  }
  ctx.restore();
}

function surfPt(L, th, side, rr = 1) {
  const phi = side > 0 ? Math.PI - th / DEG : th / DEG - Math.PI;
  return [L.cx + Math.cos(phi) * L.R * rr, L.cy - Math.sin(phi) * L.R * rr, phi];
}

function drawSkin(L) {
  const d = L.d, sep = d.sep, n = 144, w = Math.max(4, L.R * 0.085), rr = L.R + w / 2 + 1.5;
  ctx.save();
  ctx.lineWidth = w;
  for (let i = 0; i < n; ++i) {
    const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1.08) / n) * 2 * Math.PI, am = (a0 + a1) / 2;
    // Canvas angle (y down) -> model polar angle: phi = -a.
    const phi = -am, sy = Math.sin(phi);
    const side = sy >= 0 ? 1 : -1;
    let ph = Math.atan2(Math.sin(phi), Math.cos(phi));
    const th = 180 - Math.abs(ph) * DEG;
    const cp = P.surfaceCp(L.kind, sep.chi, side > 0 ? sep.top : sep.bot, sep.base, th, side, d.S);
    ctx.strokeStyle = tcol((cp + 1.2) / 2.2, 0.95);
    ctx.beginPath(); ctx.arc(L.cx, L.cy, rr, a0, a1); ctx.stroke();
  }
  ctx.restore();
}

function drawBall(L) {
  const R = L.R, cx = L.cx, cy = L.cy;
  ctx.save();
  // Soft halo
  const halo = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.6);
  halo.addColorStop(0, 'rgba(140,190,255,.10)'); halo.addColorStop(1, 'rgba(140,190,255,0)');
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.6, 0, 2 * Math.PI); ctx.fill();
  ctx.translate(cx, cy);
  // In contact the ball flattens against the face: an ellipse with the same
  // area, its face side on the face plane.
  const imp = shot.imp, dl = imp && shot.t > 0 && shot.t < imp.tau ? P.deflection(imp, shot.t) : 0;
  if (dl > 0) {
    const d = (imp.loft * Math.PI) / 180, nT = toTunnel([Math.cos(d), Math.sin(d)]);
    const ang = Math.atan2(-nT[1], nT[0]), a = 1 - dl / (2 * P.R), sh = (dl / 2 / P.R) * R;
    ctx.translate(Math.cos(ang) * sh, Math.sin(ang) * sh);
    ctx.rotate(ang); ctx.scale(a, 1 / a); ctx.rotate(-ang);
  }
  ctx.save();
  ctx.rotate(L.spinAng);
  const t = L.tex, sz = t.width / L.texS;
  ctx.drawImage(t, -sz / 2, -sz / 2, sz, sz);
  ctx.restore();
  // Lighting: key from upper left, limb darkening, cool rim from the tunnel.
  let g = ctx.createRadialGradient(-R * 0.38, -R * 0.42, R * 0.05, 0, 0, R * 1.02);
  g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(0.35, 'rgba(255,255,255,0)'); g.addColorStop(0.8, 'rgba(20,30,50,.25)'); g.addColorStop(1, 'rgba(10,15,30,.7)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = 'rgba(150,200,255,.35)'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(0, 0, R - 0.6, 0, 2 * Math.PI); ctx.stroke();
  ctx.restore();
}

function label(text, x, y, align, col = '#e7ecf2', font = `600 11px ${MONO}`) {
  ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(3,6,11,.65)';
  const tw = ctx.measureText(text).width;
  const bx = align === 'left' ? x - 3 : align === 'right' ? x - tw - 3 : x - tw / 2 - 3;
  ctx.fillRect(bx, y - 8, tw + 6, 16);
  ctx.fillStyle = col; ctx.fillText(text, x, y);
}

function drawSeparation(L) {
  const sep = L.d.sep, R = L.R;
  for (const side of [1, -1]) {
    const th = side > 0 ? sep.top : sep.bot;
    const [X, Y, phi] = surfPt(L, th, side, 1.0);
    // Shear layer leaves along the downstream surface tangent.
    const tx = side > 0 ? Math.sin(phi) : -Math.sin(phi), ty = side > 0 ? -Math.cos(phi) : Math.cos(phi);
    ctx.save();
    ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + tx * R * 0.75, Y - ty * R * 0.75); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowColor = '#fff'; ctx.shadowBlur = 10; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(X, Y, Math.max(3, R * 0.045), 0, 2 * Math.PI); ctx.fill();
    ctx.restore();
    if (state.layers.labels) {
      const [lx, ly] = surfPt(L, th, side, 1.5);
      label(`${th.toFixed(0)}°`, lx, ly, 'center');
    }
  }
  if (state.layers.labels) {
    const [sx, sy] = surfPt(L, 0, 1, 1.32);
    label('0°', sx, sy, 'center', 'rgba(231,236,242,.75)', `500 10px ${MONO}`);
  }
}

function drawWakeBracket(L) {
  const sep = L.d.sep, R = L.R;
  const ht = P.wakeHalf(sep.top), hb = P.wakeHalf(sep.bot);
  const X = L.cx + 2 * R, y0 = L.cy - ht * R, y1 = L.cy + hb * R;
  if (X > L.rect.x + L.rect.w - 30) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X, y0); ctx.lineTo(X, y1);
  ctx.moveTo(X - 5, y0); ctx.lineTo(X + 5, y0); ctx.moveTo(X - 5, y1); ctx.lineTo(X + 5, y1); ctx.stroke();
  ctx.restore();
  if (state.layers.labels) label(`wake ≈ ${f2(L.d.wake)} D`, X + 8, y0 - 10, 'left', 'rgba(231,236,242,.85)', `500 10px ${MONO}`);
}

const NPX = 1.1; // force arrow scale: px per newton = NPX * R
function drawForces(L) {
  const d = L.d, R = L.R, k = NPX * R, cx = L.cx, cy = L.cy;
  const lab = state.layers.labels;
  const o = R + 3, sep = d.sep;
  const liftL = d.lift * k < 0.6 * R && sep.top > 90, wL = sep.bot > 90;
  arrow(cx + o, cy, cx + o + d.drag * k, cy, '#ff6b5a', 3, lab ? `drag ${f2(d.drag)} N` : '', [cx + o + d.drag * k + 8, cy, 'left']);
  if (d.lift > 0.004) arrow(cx, cy - o, cx, cy - o - d.lift * k, '#45d68f', 3, lab ? `lift ${f2(d.lift)} N` : '', liftL ? [cx - 9, cy - o - d.lift * k + 4, 'right'] : [cx + Math.max(9, R * 0.5), cy - o - d.lift * k + 4, 'left']);
  arrow(cx, cy + o, cx, cy + o + d.weight * k, '#c2cad6', 2.4, lab ? `weight ${f2(d.weight)} N` : '', wL ? [cx - 9, cy + o + d.weight * k + 8, 'right'] : [cx + Math.max(9, R * 0.5), cy + o + d.weight * k + 6, 'left']);
}

function drawHud(L, split) {
  const d = L.d, { x, y, w, h } = L.rect;
  const narrow = L.narrow;
  const fs = narrow ? 10 : 12, lh = fs + 5;
  const regimeTxt = narrow ? (d.sep.chi > 0.5 ? 'turbulent BL' : 'laminar BL') : d.sep.chi > 0.5 ? (L.kind === 'dimpled' ? 'turbulent BL (tripped by dimples)' : 'turbulent BL (post-crisis)') : 'laminar BL · early separation';
  const lines = narrow && split
    ? [`Cd ${f3(d.Cd)} · Cl ${f3(d.Cl)} · sep ${d.sep.top.toFixed(0)}°/${d.sep.bot.toFixed(0)}°`]
    : narrow
    ? [`Re ${sci(d.Re)} · Cd ${f3(d.Cd)} · Cl ${f3(d.Cl)}`, `sep ${d.sep.top.toFixed(0)}° top · ${d.sep.bot.toFixed(0)}° bottom`]
    : split
    ? [`Re ${sci(d.Re)}   Cd ${f3(d.Cd)}   Cl ${f3(d.Cl)}`, `separation ${d.sep.top.toFixed(0)}° top · ${d.sep.bot.toFixed(0)}° bottom`]
    : [`Re ${sci(d.Re)}   Cd ${f3(d.Cd)}   Cl ${f3(d.Cl)}`, `separation ${d.sep.top.toFixed(0)}° top · ${d.sep.bot.toFixed(0)}° bottom`, `wake ≈ ${f2(d.wake)} D · L/W ${f2(d.lift / d.weight)}`];
  const bottom = false;
  const x0 = x + 14;
  let y0 = bottom ? y + h - 18 - lines.length * lh - 22 : y + 16;
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = `900 ${narrow ? 18 : 24}px ${DISP}`;
  ctx.fillStyle = COL[L.kind];
  ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 6;
  ctx.fillText(NAME[L.kind].toUpperCase(), x0, y0);
  const tw = ctx.measureText(NAME[L.kind].toUpperCase()).width;
  ctx.font = `600 ${narrow ? 9 : 11}px ${MONO}`; ctx.fillStyle = 'rgba(147,160,178,.95)';
  ctx.fillText(regimeTxt.toUpperCase(), x0 + tw + 10, y0 + (narrow ? 5 : 8));
  y0 += narrow ? 22 : 30;
  ctx.font = `500 ${fs}px ${MONO}`; ctx.fillStyle = '#e7ecf2';
  for (const s of lines) { ctx.fillText(s, x0, y0); y0 += lh; }
  ctx.restore();
}

// ---------------------------------------------------------------- boundary-layer close-up
function insetGeom(L, split) {
  const { x, y, w, h } = L.rect;
  let r = L.narrow ? Math.min(w * 0.2, h * (split ? 0.3 : 0.2)) : Math.min(h * (split ? 0.3 : 0.24), w * 0.14, split ? 118 : 140);
  r = Math.max(46, r);
  return { r, cx: x + w - r - 14, cy: y + r + (L.narrow && !split ? 14 : 14) };
}

function blState(L) {
  const d = L.d, th = state.inspect.th, side = state.inspect.side;
  const ts = side > 0 ? d.sep.top : d.sep.bot;
  const turb = d.sep.chi > 0.5 && th > 12;
  const attached = th < ts;
  const dL = P.blThickness(d.V, th, false) * 1000, dT = P.blThickness(d.V, th, true) * 1000;
  const lam = Math.max(-12, Math.min(7, 7 - 19 * (th / ts)));
  const nT = 7 - 3 * Math.pow(Math.min(1, th / ts), 4);
  const past = Math.max(0, th - ts);
  const hb = (turb ? dT : dL) * (0.35 + past / 25);
  const hview = 1.45 * Math.max(dL, dT, hb * 1.6);
  return { th, side, ts, turb, attached, dL, dT, lam, nT, hb, hview, delta: turb ? dT : dL };
}
function profU(b, y, regime = null) {
  const turb = regime === null ? b.turb : regime === 'turb';
  if (regime === null && !b.attached) {
    // Separated: reversed flow under a lifted shear layer.
    const hb = b.hb;
    const back = y < hb ? -0.22 * Math.sin((Math.PI * y) / hb) : 0;
    return back + 0.5 * (1 + Math.tanh((y - 1.15 * hb) / (0.28 * hb)));
  }
  return turb ? pow7(y / b.dT, regime === null ? b.nT : 7) : pohl(y / b.dL, regime === null ? b.lam : 0);
}

function updateInset(L, dt) {
  const ins = L.ins, b = blState(L), d = L.d;
  ins.b = b;
  const span = 8;                       // mm across the circle
  const vis = span * 0.5 * (0.6 + 0.4 * d.V / 70); // mm/s on screen for Ue
  ins.vis = vis; ins.span = span;
  const Ue = 1.5 * d.V * Math.max(0.15, Math.sin(b.th / DEG));
  ins.slow = (vis / 1000) / Ue;
  const uw = (state.rpm * P.RPM * P.R) / Ue;            // wall speed / edge speed
  ins.off = (ins.off + b.side * uw * vis * dt + 1000 * span) % span;
  ins.t += dt;
  const NPp = 70;
  while (ins.parts.length < NPp) ins.parts.push({ x: Math.random() * span, y: Math.random() * b.hview });
  // Eddies
  const dimpled = L.kind === 'dimpled';
  const rate = !b.attached ? 1.6 : b.turb ? 5 : 0;
  if (Math.random() < rate * dt) {
    let ex, ey, rad;
    if (!b.attached) { ex = -0.3; ey = 1.15 * b.hb; rad = 0.45 * b.hb; }
    else {
      ey = b.dT * (0.15 + Math.random() * 0.6); rad = b.dT * (0.12 + Math.random() * 0.14);
      ex = dimpled ? ((Math.floor(Math.random() * 3) * 4.2 + ins.off + 1.8) % span) : Math.random() * span * 0.3;
      if (dimpled) ey = b.dT * (0.06 + Math.random() * 0.3);
    }
    ins.eddies.push({ x: ex, y: ey, rad, str: 0.6 + Math.random() * 0.6, life: 0, max: 2 + Math.random() * 2 });
  }
  for (const e of ins.eddies) {
    e.life += dt;
    e.x += profU(b, e.y) * vis * 0.85 * dt * (!b.attached ? 0.6 : 1);
    if (b.attached && b.turb) e.y += (Math.random() - 0.4) * b.dT * 0.15 * dt;
    if (!b.attached) e.rad += b.hb * 0.05 * dt;
  }
  ins.eddies = ins.eddies.filter((e) => e.life < e.max && e.x < span + 1 && (b.attached ? b.turb : true));
  for (const p of ins.parts) {
    let u = profU(b, Math.max(0, p.y)) * vis, v = 0;
    for (const e of ins.eddies) {
      const dx = p.x - e.x, dy = p.y - e.y, dd = Math.sqrt(dx * dx * 0.08 + dy * dy) + 1e-6;
      if (dd > e.rad * 2.2) continue;
      const fall = Math.exp(-(dd * dd) / (e.rad * e.rad)) * Math.min(1, e.life * 2) * Math.min(1, (e.max - e.life) * 2);
      const vt = e.str * vis * 0.5 * fall;
      u += (vt * dy) / dd; v -= (vt * dx) / dd * (b.hview / span) * 3;
    }
    if (b.turb || !b.attached) {
      // Turbulent fluctuations: about 10 % of Ue across the layer (illustrative).
      const fy = Math.max(0, 1 - p.y / (b.attached ? b.dT : 2 * b.hb));
      v += (Math.random() - 0.5) * vis * 0.35 * (b.hview / span) * 3 * fy;
      u *= 1 + (Math.random() - 0.5) * 0.3 * fy;
    }
    p.x += u * dt; p.y += v * dt;
    if (p.y < 0.01) p.y = 0.01;
    if (p.y > b.hview) p.y = b.hview;
    if (p.x > span) { p.x -= span; p.y = Math.random() * b.hview; }
    if (p.x < 0) { p.x += span; p.y = Math.random() * b.hview * 0.6; }
    p.u = u / vis;
  }
}

function drawInset(L, split) {
  const { r, cx, cy } = insetGeom(L, split);
  const ins = L.ins, b = ins.b;
  if (!b) return;
  const span = ins.span, yW = cy + 0.22 * r, hTop = 1.1 * r;
  const X = (xmm) => cx - r + (xmm / span) * 2 * r;
  const Y = (ymm) => yW - (ymm / b.hview) * hTop;
  const dimpled = L.kind === 'dimpled';
  const depth = 0.25, dw = 3.6, pitch = 4.2;
  // Leader from the inspected point.
  const [px, py] = surfPt(L, b.th, b.side, 1.0);
  ctx.save();
  const ang = Math.atan2(py - cy, px - cx);
  ctx.strokeStyle = 'rgba(255,211,107,.6)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(px, py, 5, 0, 2 * Math.PI); ctx.stroke();
  // Circle body
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = '#050a12'; ctx.fill();
  ctx.save();
  ctx.clip();
  const bg = ctx.createLinearGradient(0, cy - r, 0, yW);
  bg.addColorStop(0, '#0a1424'); bg.addColorStop(1, '#0c1830');
  ctx.fillStyle = bg; ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  // Wall profile (with dimples)
  const wallY = (xmm) => {
    if (!dimpled) return 0;
    let xx = (((xmm - ins.off) % pitch) + pitch) % pitch - pitch / 2;
    const hw = dw / 2;
    return Math.abs(xx) < hw ? -depth * (1 - (xx / hw) ** 2) : 0;
  };
  // delta line
  if (b.attached) {
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 5]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - r, Y(b.delta)); ctx.lineTo(cx + r, Y(b.delta)); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `600 10px ${MONO}`; ctx.fillStyle = 'rgba(231,236,242,.7)'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('δ', cx + r * 0.72, Y(b.delta) - 2);
  }
  // Particles (streaks)
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const p of ins.parts) {
    const u = p.u || 0, x0 = X(p.x), y0 = Y(p.y);
    const len = Math.max(1.5, Math.abs(u) * r * 0.16) * Math.sign(u || 1);
    ctx.strokeStyle = tcol(0.15 + 0.75 * Math.min(1, Math.max(0, u)), 0.85);
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x0 - len, y0); ctx.lineTo(x0, y0); ctx.stroke();
  }
  // Eddies
  for (const e of ins.eddies) {
    const a = Math.min(1, e.life * 2) * Math.min(1, (e.max - e.life) * 2);
    const ex = X(e.x), ey = Y(e.y), rx = (e.rad / span) * 2 * r * 3.2, ry = (e.rad / b.hview) * hTop;
    ctx.strokeStyle = `rgba(190,230,255,${0.5 * a})`; ctx.lineWidth = 1.3;
    const rot = ins.t * e.str * 5;
    for (let k = 0; k < 2; ++k) {
      ctx.beginPath(); ctx.ellipse(ex, ey, rx * (0.55 + 0.35 * k), ry * (0.55 + 0.35 * k), 0, rot + k * Math.PI, rot + k * Math.PI + 2.2); ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  // Trapped eddies in the dimples
  if (dimpled) {
    for (let k = -1; k < 3; ++k) {
      const xc = ins.off + k * pitch;
      if (xc < -pitch / 2 || xc > span + pitch / 2) continue;
      const ex = X(xc), ey = Y(-depth * 0.48), rx = (dw * 0.3 / span) * 2 * r, ry = Math.max(3, (depth * 0.36 / b.hview) * hTop);
      ctx.strokeStyle = 'rgba(120,200,255,.75)'; ctx.lineWidth = 1.4;
      const rot = ins.t * 4;
      ctx.beginPath(); ctx.ellipse(ex, ey, rx, ry, 0, rot, rot + 4.2); ctx.stroke();
      for (let j = 0; j < 3; ++j) {
        const a = rot + 4.2 + j * 2.1;
        ctx.fillStyle = tcol(0.25, 1);
        ctx.beginPath(); ctx.arc(ex + Math.cos(a) * rx, ey + Math.sin(a) * ry, 1.8, 0, 2 * Math.PI); ctx.fill();
      }
    }
  }
  // Wall
  ctx.beginPath(); ctx.moveTo(cx - r, cy + r);
  for (let i = 0; i <= 80; ++i) { const xm = (i / 80) * span; ctx.lineTo(X(xm), Y(wallY(xm))); }
  ctx.lineTo(cx + r, cy + r); ctx.closePath();
  const wg = ctx.createLinearGradient(0, yW, 0, cy + r);
  wg.addColorStop(0, '#27313f'); wg.addColorStop(1, '#141a23');
  ctx.fillStyle = wg; ctx.fill();
  ctx.strokeStyle = 'rgba(230,236,245,.85)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= 80; ++i) { const xm = (i / 80) * span; i ? ctx.lineTo(X(xm), Y(wallY(xm))) : ctx.moveTo(X(xm), Y(wallY(xm))); }
  ctx.stroke();
  // Velocity profile
  const xs = cx - 0.5 * r, sc = 0.95 * r;
  const other = b.turb ? 'lam' : 'turb';
  ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(200,210,225,.55)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i <= 40; ++i) { const ym = (i / 40) * b.hview; const u = profU(b, ym, other); i ? ctx.lineTo(xs + u * sc, Y(ym)) : ctx.moveTo(xs + u * sc, Y(ym)); }
  ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(xs, Y(0)); ctx.lineTo(xs, Y(b.hview)); ctx.stroke();
  for (let i = 1; i <= 9; ++i) {
    const ym = (i / 9.5) * b.hview, u = profU(b, ym);
    const x1 = xs + u * sc, yy = Y(ym);
    ctx.strokeStyle = tcol(0.15 + 0.75 * Math.max(0, u), 0.9); ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(xs, yy); ctx.lineTo(x1, yy); ctx.stroke();
    if (Math.abs(u) * sc > 6) { const sg = Math.sign(u); ctx.beginPath(); ctx.moveTo(x1, yy); ctx.lineTo(x1 - sg * 5, yy - 3); ctx.lineTo(x1 - sg * 5, yy + 3); ctx.fill(); }
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.shadowColor = '#fff'; ctx.shadowBlur = 6;
  ctx.beginPath();
  for (let i = 0; i <= 50; ++i) { const ym = (i / 50) * b.hview; const u = profU(b, ym); i ? ctx.lineTo(xs + u * sc, Y(ym)) : ctx.moveTo(xs + u * sc, Y(ym)); }
  ctx.stroke(); ctx.shadowBlur = 0;
  // Scale bar (vertical)
  const nice = [0.1, 0.2, 0.5, 1, 2].find((v) => (v / b.hview) * hTop > r * 0.22) || 2;
  const sx = cx + r * 0.62, sb = (nice / b.hview) * hTop;
  ctx.strokeStyle = 'rgba(231,236,242,.75)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(sx, Y(0) - 3); ctx.lineTo(sx, Y(0) - 3 - sb); ctx.moveTo(sx - 3, Y(0) - 3); ctx.lineTo(sx + 3, Y(0) - 3); ctx.moveTo(sx - 3, Y(0) - 3 - sb); ctx.lineTo(sx + 3, Y(0) - 3 - sb); ctx.stroke();
  ctx.font = `500 ${r < 80 ? 8 : 9}px ${MONO}`; ctx.fillStyle = 'rgba(231,236,242,.8)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(`${nice} mm`, sx + 5, Y(0) - 3 - sb / 2);
  // Captions in the wall band
  const big = r >= 80;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = `700 ${big ? 11 : 9}px ${MONO}`;
  const st = !b.attached ? 'SEPARATED · REVERSED FLOW' : b.turb ? 'TURBULENT · ATTACHED' : 'LAMINAR · ATTACHED';
  ctx.fillStyle = !b.attached ? '#ff8a7a' : b.turb ? '#ffd36b' : '#8fd8ff';
  ctx.fillText(st, cx, yW + (dimpled ? 0.2 * r : 0.08 * r));
  ctx.font = `500 ${big ? 10 : 8}px ${MONO}`; ctx.fillStyle = 'rgba(231,236,242,.85)';
  const l2 = `θ ${b.th.toFixed(0)}° ${b.side > 0 ? 'top' : 'bottom'} · sep ${b.ts.toFixed(0)}°`;
  ctx.fillText(l2, cx, yW + (dimpled ? 0.2 * r : 0.08 * r) + (big ? 15 : 11));
  if (r >= 125) {
    const l3 = b.attached ? `δ ${(b.delta).toFixed(2)} mm · dashed: ${b.turb ? `laminar ${b.dL.toFixed(2)}` : `turb. ${b.dT.toFixed(2)}`}` : `dashed: ${b.turb ? 'laminar' : 'turbulent'} profile`;
    ctx.fillText(l3, cx, yW + (dimpled ? 0.2 * r : 0.08 * r) + 29);
  }
  ctx.restore();
  // Ring
  ctx.strokeStyle = 'rgba(255,211,107,.85)'; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(255,211,107,.6)'; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke(); ctx.shadowBlur = 0;
  // Title
  if (state.layers.labels) {
    const mag = (hTop / b.hview) / (L.R / (P.R * 1000));
    ctx.font = `600 ${big ? 10 : 9}px ${MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,211,107,.9)';
    const tx = cx - r * 0.72, ty = cy - r * 0.98;
    if (big) {
      ctx.fillText('BOUNDARY LAYER', tx - 8, ty);
      ctx.fillStyle = 'rgba(147,160,178,.95)';
      ctx.fillText(`height ×${Math.round(mag)} · 1/${Math.round(1 / ins.slow / 1000)}k×`, tx - 8, ty + 13);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- frame
let last = performance.now(), physT = 0, limited = false, stepMs = 8, lowered = 0, frameMs = 16, glow = true;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const vis = visible();
  for (const L of vis) L.sync();
  if (!state.paused) {
    // Real time advanced this frame, and the distance the air moved past the
    // ball in radii (non-dimensional time): zero before contact, ramping up
    // with the impulse during it.
    let realDt = dt / SLOWS[state.slow];
    let fi = flowIntegral(shot.t, shot.t + realDt);
    let adv = (fi * state.V) / P.R;
    const maxAdv = 0.26;
    limited = adv > maxAdv * 0.999;
    if (limited) { realDt *= maxAdv / adv; fi *= maxAdv / adv; adv = maxAdv; }
    const n = adv > 0 ? Math.max(1, Math.ceil(adv / 0.045)) : 0, h = n ? adv / n : 0;
    const t0 = performance.now();
    for (const L of vis) {
      for (let i = 0; i < n; ++i) L.step(h);
      L.spinAng += state.rpm * P.RPM * fi;
      if (inFlight()) updateInset(L, dt);
    }
    stepMs = stepMs * 0.95 + (performance.now() - t0) * 0.05;
    shot.t += realDt;
    physT = shot.t;
    // Adapt the particle budget to the device, at most twice.
    frameMs = frameMs * 0.95 + dt * 1000 * 0.05;
    if ((stepMs > 18 || frameMs > 36) && lowered < 2 && now > 5000) { lowered++; quality *= 0.7; glow = false; layout(); stepMs = 8; frameMs = 16; }
  } else {
    for (const L of vis) if (!L.ins.b && inFlight()) updateInset(L, 0);
  }
  draw(vis);
  drawTrajectory(now);
  requestAnimationFrame(frame);
}
const inFlight = () => !shot.imp || shot.t >= shot.imp.tau;

function draw(vis) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const split = vis.length > 1, flying = inFlight();
  for (const L of vis) {
    ctx.save();
    ctx.beginPath(); ctx.rect(L.rect.x, L.rect.y, L.rect.w, L.rect.h); ctx.clip();
    drawLaneBackground(L);
    if (state.layers.smoke) { drawVortices(L); drawSmoke(L); }
    if (state.layers.tracers) drawTracers(L);
    drawGround(L);
    if (flying) drawWakeBracket(L);
    if (flying && state.layers.skin) drawSkin(L);
    drawBall(L);
    drawClub(L);
    if (flying) drawSeparation(L);
    if (flying && state.layers.forces) drawForces(L);
    drawHud(L, split);
    const sinceRelease = shot.imp ? (shot.t - shot.imp.tau) * SLOWS[state.slow] : 1e9;
    if (shot.imp && sinceRelease < 3) drawImpactPanel(L, split);
    else if (state.layers.inset) drawInset(L, split);
    if (state.paused) { ctx.font = `900 20px ${DISP}`; ctx.fillStyle = 'rgba(255,211,107,.9)'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('PAUSED', L.rect.x + L.rect.w - 14, L.rect.y + L.rect.h - 20); }
    ctx.restore();
  }
  if (split) { ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(0, H / 2 - 0.5, W, 1); }
  $('#clock').textContent = `${state.paused ? 'paused' : `1/${SLOWS[state.slow]}×`}${limited ? ' (display-limited)' : ''} · t = ${fmtT(physT)} · ${phaseText()}`;
}
function fmtT(t) {
  const a = Math.abs(t);
  return a < 0.01 ? `${(t * 1000).toFixed(3)} ms` : `${(t * 1000).toFixed(1)} ms`;
}
function phaseText() {
  const imp = shot.imp;
  if (!imp) return 'flow';
  if (shot.t < 0) return 'club approaching';
  if (shot.t < imp.tc) return 'contact · compressing';
  if (shot.t < imp.tau) return 'contact · restoring';
  return 'ball in flight';
}

// ---------------------------------------------------------------- the club, the tee and the impact
// World frame: x toward the target, y up, origin at the ball centre. The
// tunnel shows the ball's own frame with the flight path along -x, so the
// world is mirrored and turned by the launch angle.
function toTunnel(v) {
  const L = (shot.imp.launch * Math.PI) / 180, c = Math.cos(L), s = Math.sin(L), x = -v[0], y = v[1];
  return [c * x - s * y, s * x + c * y];
}
const toCanvas = (L, v) => { const k = L.R / P.R, q = toTunnel(v); return [L.cx + q[0] * k, L.cy - q[1] * k]; };
// Ball displacement along its flight path since first contact (m).
const ballTravel = () => (shot.imp ? Math.hypot(...shot.imp.ball) * flowIntegral(0, Math.max(0, shot.t)) : 0);

// Head outlines in face coordinates (a along the face normal, b up the
// face), metres, origin at the contact point. Sole at b = -(h + CG height).
const HEADS = {
  wood(cl) {
    const s = -(cl.h + 0.025), top = s + cl.face, bc = (s + top) / 2, roll = 0.3;
    const face = []; for (let i = 0; i <= 8; ++i) { const b = s + (i / 8) * (top - s); face.push([-((b - bc) ** 2) / (2 * roll), b]); }
    return { body: [...face, [-0.03, top + 0.004], [-0.07, top - 0.006], [-0.103, s + 0.032], [-0.113, s + 0.013], [-0.096, s + 0.002], [-0.02, s - 0.001]],
             face, hosel: [-0.012, top - 0.002], sole: s, grooves: [] };
  },
  iron(cl) {
    const s = -(cl.h + 0.018), top = s + cl.face;
    const grooves = []; for (let b = s + 0.006; b < top - 0.006; b += 0.0036) grooves.push(b);
    return { body: [[0, s], [0, top], [-0.006, top + 0.001], [-0.008, top - 0.012], [-0.011, s + 0.024], [-0.019, s + 0.014], [-0.023, s + 0.004], [-0.019, s - 0.001]],
             face: [[0, s], [0, top]], hosel: [-0.004, top], sole: s, grooves };
  },
};

// Club position relative to the ball: the contact point on the face, the
// face normal and up-the-face directions, and the head's rotation since release.
function clubPose() {
  const imp = shot.imp, cl = P.CLUBS[state.club], d = (imp.loft * Math.PI) / 180;
  const n = [Math.cos(d), Math.sin(d)], tt = [-Math.sin(d), Math.cos(d)];
  const t = shot.t;
  let pos = [-P.R * n[0], -P.R * n[1]], rot = 0;
  if (t < 0) { pos[0] += imp.club0[0] * t; pos[1] += imp.club0[1] * t; }
  else if (t < imp.tau) { const dl = P.deflection(imp, t); pos[0] += n[0] * dl; pos[1] += n[1] * dl; }
  else {
    const dt = t - imp.tau;
    pos[0] += (imp.club1[0] - imp.ball[0]) * dt; pos[1] += (imp.club1[1] - imp.ball[1]) * dt;
    rot = imp.dOmega * dt;
  }
  // Rotation about the head's CG (b behind the face, h below the contact).
  const cg = [pos[0] - cl.b * n[0] - cl.h * tt[0], pos[1] - cl.b * n[1] - cl.h * tt[1]];
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const at = (a, b) => {
    const x = pos[0] + a * n[0] + b * tt[0] - cg[0], y = pos[1] + a * n[1] + b * tt[1] - cg[1];
    return [cg[0] + cr * x - sr * y, cg[1] + sr * x + cr * y];
  };
  return { at, cl, n, tt, rot };
}

function drawClub(L) {
  if (!shot.imp) return;
  // Once the ball has gone the club drifts slowly out of the ball's frame;
  // fade it after a couple of seconds on screen so the wake stays readable.
  const after = (shot.t - shot.imp.tau) * SLOWS[state.slow];
  const alpha = after < 2 ? 1 : Math.max(0, 1 - (after - 2) / 1.5);
  if (alpha <= 0) return;
  const { at, cl, rot } = clubPose();
  const g = HEADS[cl.kind](cl);
  const pts = g.body.map(([a, b]) => toCanvas(L, at(a, b)));
  ctx.save();
  ctx.globalAlpha = alpha;
  // Shaft: from the hosel, straight up in the world (with the head's rotation).
  const hz = at(g.hosel[0], g.hosel[1]);
  const lean = cl.kind === 'iron' ? 0.07 : 0.0, up = [Math.sin(lean) , Math.cos(lean)];
  const ur = [up[0] * Math.cos(rot) - up[1] * Math.sin(rot), up[0] * Math.sin(rot) + up[1] * Math.cos(rot)];
  const [sx0, sy0] = toCanvas(L, hz), [sx1, sy1] = toCanvas(L, [hz[0] + ur[0] * 1.2, hz[1] + ur[1] * 1.2]);
  const k = L.R / P.R;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(10,14,22,.8)'; ctx.lineWidth = Math.max(3, 0.0105 * k);
  ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();
  ctx.strokeStyle = cl.kind === 'iron' ? '#c3ccd8' : '#2c3440'; ctx.lineWidth = Math.max(2, 0.0085 * k);
  ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();
  // Head
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  const [ax, ay] = pts[0], [bx, by] = pts[Math.floor(pts.length / 2)];
  const gr = ctx.createLinearGradient(ax, ay, bx, by);
  if (cl.kind === 'iron') { gr.addColorStop(0, '#e9eef4'); gr.addColorStop(0.5, '#9aa6b5'); gr.addColorStop(1, '#5b6676'); }
  else { gr.addColorStop(0, '#3a4350'); gr.addColorStop(0.4, '#1b2029'); gr.addColorStop(1, '#0c0f14'); }
  ctx.fillStyle = gr; ctx.fill();
  ctx.strokeStyle = 'rgba(220,230,245,.55)'; ctx.lineWidth = 1; ctx.stroke();
  // Face
  ctx.strokeStyle = cl.kind === 'iron' ? '#f4f7fb' : '#b9c3d0'; ctx.lineWidth = Math.max(2, 0.0018 * k);
  ctx.beginPath();
  g.face.forEach(([a, b], i) => { const [x, y] = toCanvas(L, at(a, b)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  // Grooves
  ctx.strokeStyle = 'rgba(40,50,64,.9)'; ctx.lineWidth = 1;
  for (const b of g.grooves) { const [x0, y0] = toCanvas(L, at(0, b)), [x1, y1] = toCanvas(L, at(-0.0012, b)); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
  ctx.restore();
}

// Ground (and the tee for the driver), left behind as the ball flies.
function drawGround(L) {
  if (!shot.imp) return;
  const cl = P.CLUBS[state.club], wood = cl.kind === 'wood';
  const gy = -P.R - (wood ? 0.020 : 0.004);
  const s = ballTravel(), u = shot.imp.ball, um = Math.hypot(u[0], u[1]);
  const off = [(-u[0] / um) * s, (-u[1] / um) * s];
  const p = (x, y) => toCanvas(L, [x + off[0], y + off[1]]);
  const span = 4;
  const [ax, ay] = p(-span, gy), [bx, by] = p(span, gy), [cx2, cy2] = p(span, gy - 1), [dx, dy] = p(-span, gy - 1);
  ctx.save();
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx2, cy2); ctx.lineTo(dx, dy); ctx.closePath();
  ctx.fillStyle = 'rgba(30,70,40,.35)'; ctx.fill();
  ctx.strokeStyle = 'rgba(110,200,130,.55)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  if (wood) {
    // Tee: cup under the ball, peg into the ground.
    const t0 = p(0, -P.R + 0.002), t1 = p(0, gy - 0.03), l = p(-0.004, -P.R + 0.002), r = p(0.004, -P.R + 0.002);
    ctx.strokeStyle = 'rgba(240,240,230,.85)'; ctx.lineWidth = Math.max(2, (0.0025 * L.R) / P.R);
    ctx.beginPath(); ctx.moveTo(t0[0], t0[1]); ctx.lineTo(t1[0], t1[1]); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(t0[0], t0[1] + 3); ctx.lineTo(r[0], r[1]); ctx.stroke();
  }
  ctx.restore();
}

function drawImpactPanel(L, split) {
  const imp = shot.imp, cl = P.CLUBS[state.club];
  const narrow = L.narrow, fs = narrow ? 9.5 : 11, lh = fs + 5;
  const mph = (v) => (v * MPH).toFixed(0);
  const off = Math.abs(imp.speed - state.V) > 0.02 * state.V || Math.abs(imp.launch - state.ang) > 0.5 || Math.abs(imp.rpm - state.rpm) > 150;
  const t = shot.t, dl = t > 0 && t < imp.tau ? P.deflection(imp, t) * 1000 : 0;
  const lines = [
    [`${cl.name.toUpperCase()} · club ${mph(imp.V)} mph (${imp.V.toFixed(1)} m/s)`, '#ffd36b'],
    [`attack ${imp.attack.toFixed(1)}° · dynamic loft ${imp.loft.toFixed(1)}° · spin loft ${imp.spinLoft.toFixed(1)}°`, '#e7ecf2'],
    [`contact ${(imp.tau * 1000).toFixed(2)} ms · compression ${t > 0 && t < imp.tau ? dl.toFixed(1) : '0.0'} / ${(imp.dmax * 1000).toFixed(1)} mm`, '#e7ecf2'],
    [`ball ${mph(imp.speed)} mph · smash ${imp.smash.toFixed(2)} · launch ${imp.launch.toFixed(1)}° · ${imp.rpm.toFixed(0)} rpm`, '#8fd8ff'],
  ];
  if (off) lines.push(['closest this club can deliver to the sliders', '#f0b43a']);
  if (narrow && split) lines.splice(1, 2);
  const w = Math.min(L.rect.w - 28, narrow ? 330 : 470), h = 12 + lines.length * lh;
  const x0 = L.rect.x + 14, y0 = L.rect.y + L.rect.h - h - 14;
  ctx.save();
  ctx.fillStyle = 'rgba(4,7,12,.72)'; ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = 'rgba(255,211,107,.45)'; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
  ctx.font = `500 ${fs}px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  lines.forEach(([txt, col], i) => { ctx.fillStyle = col; ctx.fillText(txt, x0 + 8, y0 + 7 + i * lh, w - 16); });
  ctx.restore();
}

// ---------------------------------------------------------------- charts
function setupCanvas(c) {
  const r = c.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return [g, r.width, r.height];
}
function glowLine(g, pts, col, lw, dash) {
  g.save();
  if (dash) g.setLineDash(dash);
  g.strokeStyle = col; g.lineWidth = lw; g.lineJoin = 'round'; g.shadowColor = col; g.shadowBlur = 8;
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  g.restore();
}

function drawCd() {
  const [g, w, h] = setupCanvas($('#cdc'));
  const L = 44, Rr = 12, T = 28, B = 30;
  const x0 = 4, x1 = 6.3, y1 = 0.6;
  const X = (lr) => L + ((lr - x0) / (x1 - x0)) * (w - L - Rr), Y = (c) => T + (1 - c / y1) * (h - T - B);
  g.font = `500 10px ${MONO}`;
  // golf band 30-80 m/s
  const b0 = Math.log10(P.reynolds(30)), b1 = Math.log10(P.reynolds(80));
  g.fillStyle = 'rgba(255,211,107,.07)'; g.fillRect(X(b0), T, X(b1) - X(b0), h - T - B);
  g.fillStyle = 'rgba(255,211,107,.6)'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('golf shots', (X(b0) + X(b1)) / 2, T + 10);
  // grid
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.fillStyle = 'rgba(147,160,178,.9)';
  for (let e = 4; e <= 6; ++e) for (const m of [1, 2, 5]) {
    const lr = e + Math.log10(m); if (lr > x1) continue;
    g.beginPath(); g.moveTo(X(lr), T); g.lineTo(X(lr), h - B); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText(m === 1 ? `10${SUP[e]}` : `${m}`, X(lr), h - B + 6);
  }
  for (let c = 0; c <= 0.6001; c += 0.1) {
    g.beginPath(); g.moveTo(L, Y(c)); g.lineTo(w - Rr, Y(c)); g.stroke();
    g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(c.toFixed(1), L - 6, Y(c));
  }
  // top axis: speed of a golf ball
  g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillStyle = 'rgba(147,160,178,.7)';
  for (const v of [5, 10, 20, 50, 100, 200]) { const lr = Math.log10(P.reynolds(v)); if (lr < x0 || lr > x1) continue; g.fillText(`${v}`, X(lr), T - 4); g.fillRect(X(lr) - 0.5, T - 3, 1, 3); }
  g.textAlign = 'left'; g.fillText('m/s', L, T - 16);
  g.textAlign = 'right'; g.textBaseline = 'top'; g.fillStyle = 'rgba(147,160,178,.9)'; g.fillText('Re = VD/ν', w - Rr, h - 13);
  g.save(); g.translate(12, (T + h - B) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('Cd', 0, 0); g.restore();
  // curves
  for (const k of ['smooth', 'dimpled']) {
    const pts = [];
    for (let i = 0; i <= 260; ++i) { const lr = x0 + ((x1 - x0) * i) / 260; pts.push([X(lr), Y(P.cd0(k, 10 ** lr))]); }
    if (k === 'dimpled') {
      const cut = pts.findIndex(([x]) => x > X(Math.log10(4e5)));
      glowLine(g, pts.slice(0, cut + 1), COL[k], 2.2);
      glowLine(g, pts.slice(cut), COL[k], 1.6, [4, 4]);
    } else glowLine(g, pts, COL[k], 2.2);
  }
  // annotations
  g.font = `500 10px ${MONO}`; g.textBaseline = 'middle';
  g.fillStyle = COL.dimpled; g.textAlign = 'left'; g.fillText('golf ball', X(4.75) + 6, Y(0.19));
  g.fillStyle = COL.smooth; g.textAlign = 'left'; g.fillText('smooth sphere', X(4.05), Y(0.47));
  g.fillStyle = 'rgba(231,236,242,.75)'; g.textAlign = 'left'; g.fillText('drag crisis', X(5.62) + 6, Y(0.04));
  // current
  const lr = Math.log10(state.lastRe || P.reynolds(state.V));
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.setLineDash([2, 3]);
  g.beginPath(); g.moveTo(X(lr), T); g.lineTo(X(lr), h - B); g.stroke(); g.setLineDash([]);
  for (const k of ['smooth', 'dimpled']) {
    const d = derive(k);
    g.fillStyle = COL[k]; g.shadowColor = COL[k]; g.shadowBlur = 10;
    g.beginPath(); g.arc(X(lr), Y(d.Cd0), 4.5, 0, 2 * Math.PI); g.fill(); g.shadowBlur = 0;
    if (d.S > 0.005) { g.strokeStyle = COL[k]; g.lineWidth = 1.5; g.beginPath(); g.arc(X(lr), Y(d.Cd), 5, 0, 2 * Math.PI); g.stroke(); }
  }
  g.fillStyle = '#e7ecf2'; g.textAlign = lr > 5.6 ? 'right' : 'left'; g.textBaseline = 'top'; g.font = `600 10px ${MONO}`;
  g.fillText(`Re ${sci(10 ** lr)}`, X(lr) + (lr > 5.6 ? -6 : 6), T + 30);
}

function drawCl() {
  const [g, w, h] = setupCanvas($('#clc'));
  const L = 40, Rr = 10, T = 14, B = 30, x1 = 0.45, y1 = 0.4;
  const X = (s) => L + (s / x1) * (w - L - Rr), Y = (c) => T + (1 - c / y1) * (h - T - B);
  g.fillStyle = 'rgba(240,180,58,.08)'; g.fillRect(X(P.S_FIT_MAX), T, X(x1) - X(P.S_FIT_MAX), h - T - B);
  g.font = `500 10px ${MONO}`; g.strokeStyle = 'rgba(255,255,255,.07)'; g.fillStyle = 'rgba(147,160,178,.9)'; g.lineWidth = 1;
  for (let s = 0; s <= 0.4001; s += 0.1) { g.beginPath(); g.moveTo(X(s), T); g.lineTo(X(s), h - B); g.stroke(); g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(s.toFixed(1), X(s), h - B + 6); }
  for (let c = 0; c <= 0.4001; c += 0.1) { g.beginPath(); g.moveTo(L, Y(c)); g.lineTo(w - Rr, Y(c)); g.stroke(); g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(c.toFixed(1), L - 6, Y(c)); }
  g.textAlign = 'right'; g.textBaseline = 'top'; g.fillText('S = ωr/V', w - Rr, h - 13);
  g.save(); g.translate(11, (T + h - B) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('Cl', 0, 0); g.restore();
  for (const k of ['dimpled', 'smooth']) {
    const pts = [];
    for (let i = 0; i <= 120; ++i) { const s = (x1 * i) / 120; pts.push([X(s), Y(P.cl(k, s))]); }
    glowLine(g, pts, COL[k], 2, k === 'smooth' ? [5, 4] : null);
  }
  const S = P.spinParam(state.rpm, state.V);
  const sx = X(Math.min(S, x1));
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(sx, T); g.lineTo(sx, h - B); g.stroke(); g.setLineDash([]);
  for (const k of ['smooth', 'dimpled']) { g.fillStyle = COL[k]; g.shadowColor = COL[k]; g.shadowBlur = 10; g.beginPath(); g.arc(sx, Y(P.cl(k, S)), 4.5, 0, 2 * Math.PI); g.fill(); g.shadowBlur = 0; }
  g.fillStyle = S > P.S_FIT_MAX ? '#f0b43a' : '#e7ecf2'; g.font = `600 10px ${MONO}`; g.textAlign = S > 0.25 ? 'right' : 'left'; g.textBaseline = 'top';
  g.fillText(`S ${S.toFixed(3)}`, sx + (S > 0.25 ? -6 : 6), T + 4);
}

let flights = null, trajStart = performance.now();
function computeFlights() {
  flights = { smooth: P.fly('smooth', state.V, state.ang, state.rpm), dimpled: P.fly('dimpled', state.V, state.ang, state.rpm) };
  trajStart = performance.now();
  const st = $('#stats');
  const fd = flights.dimpled, fs = flights.smooth;
  st.innerHTML = ['smooth', 'dimpled'].map((k) => {
    const f = flights[k];
    return `<div class="stat ${k[0]}"><div class="k">${NAME[k]}</div><div class="big">${f.carry.toFixed(0)}<small>m</small> ${(f.carry * YD).toFixed(0)}<small>yd</small></div>
      <div class="read"><span>apex</span><b>${f.apex.toFixed(1)} m</b><span>flight time</span><b>${f.time.toFixed(2)} s</b><span>landing angle</span><b>${f.landAngle.toFixed(0)}°</b></div></div>`;
  }).join('') + `<p class="note" style="grid-column:1/-1;margin:0">Carry, no roll. Dimples take the same launch <b style="color:var(--ink)">${(fd.carry / Math.max(1, fs.carry)).toFixed(2)}×</b> as far (${(fd.carry - fs.carry).toFixed(0)} m further).</p>`;
}
function drawTrajectory(now) {
  if (!flights) return;
  const c = $('#trc');
  const [g, w, h] = setupCanvas(c);
  const L = 44, Rr = 14, T = 16, B = 34;
  const maxX = Math.max(60, Math.ceil((Math.max(flights.smooth.carry, flights.dimpled.carry) * 1.08) / 25) * 25);
  const maxY = Math.max(10, Math.ceil((Math.max(flights.smooth.apex, flights.dimpled.apex) * 1.3) / 5) * 5);
  const X = (x) => L + (x / maxX) * (w - L - Rr), Y = (y) => T + (1 - y / maxY) * (h - T - B);
  // sky gradient + ground
  const sg = g.createLinearGradient(0, T, 0, h - B);
  sg.addColorStop(0, 'rgba(30,60,110,.18)'); sg.addColorStop(1, 'rgba(30,60,110,0)');
  g.fillStyle = sg; g.fillRect(L, T, w - L - Rr, h - T - B);
  g.fillStyle = 'rgba(54,196,131,.25)'; g.fillRect(L, h - B, w - L - Rr, 2);
  g.font = `500 10px ${MONO}`; g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.fillStyle = 'rgba(147,160,178,.9)';
  const stepX = maxX > 200 ? 50 : 25;
  for (let x = 0; x <= maxX; x += stepX) { g.beginPath(); g.moveTo(X(x), T); g.lineTo(X(x), h - B); g.stroke(); g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(`${x}`, X(x), h - B + 6); }
  const stepY = maxY > 40 ? 10 : 5;
  for (let y = 0; y <= maxY; y += stepY) { g.beginPath(); g.moveTo(L, Y(y)); g.lineTo(w - Rr, Y(y)); g.stroke(); g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(`${y}`, L - 6, Y(y)); }
  g.textAlign = 'right'; g.textBaseline = 'top'; g.fillText('distance, m (height not to scale)', w - Rr, h - 14);
  g.save(); g.translate(12, (T + h - B) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('height, m', 0, 0); g.restore();
  const tAnim = ((now - trajStart) / 1000) % (Math.max(flights.smooth.time, flights.dimpled.time) + 1.8);
  for (const k of ['smooth', 'dimpled']) {
    const f = flights[k];
    glowLine(g, f.pts.map(([x, y]) => [X(x), Y(y)]), COL[k], 2);
    // apex
    let ai = 0; f.pts.forEach((p, i) => { if (p[1] > f.pts[ai][1]) ai = i; });
    const [axp, ayp] = f.pts[ai];
    g.fillStyle = COL[k]; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.font = `500 10px ${MONO}`;
    g.fillText(`${f.apex.toFixed(0)} m`, X(axp), Y(ayp) - 6);
    // landing
    g.beginPath(); g.arc(X(f.carry), Y(0), 3, 0, 2 * Math.PI); g.fill();
    g.font = `700 11px ${MONO}`; g.textBaseline = 'bottom'; g.textAlign = f.carry > maxX * 0.85 ? 'right' : 'center';
    g.fillText(w < 520 ? `${f.carry.toFixed(0)} m` : `${f.carry.toFixed(0)} m · ${(f.carry * YD).toFixed(0)} yd`, X(f.carry), Y(0) - 8 - (k === 'smooth' ? 16 : 0));
    // flying ball
    const t = Math.min(tAnim, f.time);
    let j = f.pts.findIndex((p) => p[2] >= t); if (j < 1) j = t <= 0 ? 0 : f.pts.length - 1;
    const p0 = f.pts[Math.max(0, j - 1)], p1 = f.pts[j];
    const fr = p1[2] > p0[2] ? (t - p0[2]) / (p1[2] - p0[2]) : 1;
    const bx = X(p0[0] + (p1[0] - p0[0]) * fr), by = Y(p0[1] + (p1[1] - p0[1]) * fr);
    g.fillStyle = '#fff'; g.shadowColor = COL[k]; g.shadowBlur = 12;
    g.beginPath(); g.arc(bx, by, 4, 0, 2 * Math.PI); g.fill(); g.shadowBlur = 0;
  }
}

// ---------------------------------------------------------------- UI
function updateReadouts() {
  const V = state.V, Re = P.reynolds(V), S = P.spinParam(state.rpm, V);
  state.lastRe = Re;
  $('#oV').textContent = `${V.toFixed(1)} m/s`;
  $('#sV').textContent = `${(V * MPH).toFixed(0)} mph · Re ${sci(Re)}${V < 30 || V > 80 ? ' · outside golf range' : ''}`;
  $('#oW').textContent = `${state.rpm} rpm`;
  const sw = $('#sW');
  sw.textContent = `S = ωr/V = ${S.toFixed(3)}${S > P.S_FIT_MAX ? ' · beyond fitted range' : ''}`;
  sw.classList.toggle('warn', S > P.S_FIT_MAX);
  $('#oA').textContent = `${state.ang.toFixed(1)}°`;
  $('#oS').textContent = `1/${SLOWS[state.slow]}×`;
  $('#sS').textContent = `1 s on screen = ${(1000 / SLOWS[state.slow]).toFixed(1)} ms of real flow`;
  $('#lgV1').textContent = `1.8 (${(1.8 * V).toFixed(0)} m/s)`;
  const ds = derive('smooth'), dd = derive('dimpled');
  computeFlights();
  const row = (k, a, b) => `<tr><td>${k}</td><td class="s">${a}</td><td class="d">${b}</td></tr>`;
  $('#cmp').innerHTML = [
    row('Cd', f3(ds.Cd), f3(dd.Cd)),
    row('Cl', f3(ds.Cl), f3(dd.Cl)),
    row('Separation', `${ds.sep.top.toFixed(0)}° / ${ds.sep.bot.toFixed(0)}°`, `${dd.sep.top.toFixed(0)}° / ${dd.sep.bot.toFixed(0)}°`),
    row('Wake width', `${f2(ds.wake)} D`, `${f2(dd.wake)} D`),
    row('Drag', `${f2(ds.drag)} N`, `${f2(dd.drag)} N`),
    row('Lift', `${f2(ds.lift)} N`, `${f2(dd.lift)} N`),
    row('Lift / weight', f2(ds.lift / ds.weight), f2(dd.lift / dd.weight)),
    row('Carry', `${flights.smooth.carry.toFixed(0)} m`, `${flights.dimpled.carry.toFixed(0)} m`),
  ].join('') + `<tr><td colspan="3" style="text-align:left;color:var(--mute);font-size:10.5px;padding-top:6px">Separation: top / bottom, degrees from the front stagnation point.</td></tr>`;
  drawCd(); drawCl();
}

function setMode(m) {
  if (state.mode === m) return;
  state.mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  layout();
}
function setRange(id, v) { const el = $(id); el.value = v; el.dispatchEvent(new Event('input')); }
$('#iV').addEventListener('input', (e) => { state.V = +e.target.value; updateReadouts(); });
$('#iW').addEventListener('input', (e) => { state.rpm = +e.target.value; updateReadouts(); });
$('#iA').addEventListener('input', (e) => { state.ang = +e.target.value; updateReadouts(); });
$('#iS').addEventListener('input', (e) => { state.slow = +e.target.value; updateReadouts(); });
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function togglePause() { state.paused = !state.paused; $('#bPause').setAttribute('aria-pressed', String(state.paused)); $('#bPause').textContent = state.paused ? 'Play' : 'Pause'; }
$('#bPause').addEventListener('click', togglePause);
// Restart the shot: the club approaches for ~1 s on screen, strikes, and the
// air starts to flow as the ball leaves the face (an impulsively started
// sphere: the wake grows from nothing).
function startShot() {
  solveShot();
  shot.T0 = PRE_SCREEN / SLOWS[state.slow];
  shot.t = -shot.T0;
  physT = shot.t;
  for (const L of Object.values(lanes)) { L.ready = false; L.ins.eddies = []; L.ins.b = null; L.spinAng = 0; }
  layout();
}
$('#bReset').addEventListener('click', startShot);
function applyPreset(k) {
  const p = PRESETS[k];
  $('#iV').value = p.V; $('#iW').value = p.rpm; $('#iA').value = p.ang;
  state.V = p.V; state.rpm = p.rpm; state.ang = p.ang; state.club = p.club;
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === k)));
  updateReadouts();
  startShot();
}
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
function toggleLayer(k) {
  state.layers[k] = !state.layers[k];
  const b = document.querySelector(`[data-layer="${k}"]`); b.setAttribute('aria-pressed', String(state.layers[k]));
  $('#lgSkin').style.opacity = state.layers.skin ? 1 : 0.35;
}
document.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => toggleLayer(b.dataset.layer)));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const inRange = e.target && e.target.tagName === 'INPUT';
  const k = e.key;
  const keyLayer = { s: 'smoke', t: 'tracers', p: 'pressure', b: 'inset', f: 'forces', l: 'labels' };
  if (k === '1') setMode('smooth');
  else if (k === '2') setMode('dimpled');
  else if (k === '3') setMode('split');
  else if (k === ' ' && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePause(); }
  else if (k === 'r' || k === 'R') startShot();
  else if (k === '[') setRange('#iS', Math.max(0, state.slow - 1));
  else if (k === ']') setRange('#iS', Math.min(5, state.slow + 1));
  else if (!inRange && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); setRange('#iV', Math.max(10, Math.min(120, Math.round(state.V + (k === 'ArrowRight' ? 2 : -2))))); }
  else if (!inRange && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); setRange('#iW', Math.max(0, Math.min(8000, state.rpm + (k === 'ArrowUp' ? 250 : -250)))); }
  else if (keyLayer[k.toLowerCase()]) toggleLayer(k.toLowerCase() === 'p' ? 'skin' : keyLayer[k.toLowerCase()]);
});

// Click / drag on the ball's edge picks the boundary-layer station.
let picking = false;
function pick(e) {
  const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  for (const L of visible()) {
    if (py < L.rect.y || py > L.rect.y + L.rect.h) continue;
    const dx = (px - L.cx) / L.R, dy = -(py - L.cy) / L.R, d = Math.hypot(dx, dy);
    if (!picking && (d < 0.5 || d > 2.2)) return false;
    const phi = Math.atan2(dy, dx);
    state.inspect.side = dy >= 0 ? 1 : -1;
    state.inspect.th = Math.max(4, Math.min(176, 180 - Math.abs(phi) * DEG));
    if (!state.layers.inset) toggleLayer('inset');
    return true;
  }
  return false;
}
cv.addEventListener('pointerdown', (e) => { if (pick(e)) { picking = true; cv.setPointerCapture(e.pointerId); e.preventDefault(); } });
cv.addEventListener('pointermove', (e) => { if (picking) pick(e); });
cv.addEventListener('pointerup', () => { picking = false; });
cv.addEventListener('pointercancel', () => { picking = false; });

let rsT = 0;
new ResizeObserver(() => { clearTimeout(rsT); rsT = setTimeout(() => { layout(); drawCd(); drawCl(); }, 60); }).observe(cv);
window.addEventListener('resize', () => { drawCd(); drawCl(); });

updateReadouts();
startShot();
if (document.fonts) document.fonts.ready.then(() => { drawCd(); drawCl(); });
requestAnimationFrame((t) => { last = t; frame(t); });
