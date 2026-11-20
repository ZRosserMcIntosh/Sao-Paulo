// São Paulo World · AI logic demo. Plain JS, no server. Data: ./data/<section>.json cut from the game's lane graph.
// Terms follow the AI design plan (claude/sp-ai-systems-plan.md): pursuing parties, fleeing parties, perception, GPS.
"use strict";

// ---------- one tunable config (mirrors the planned AIConfig) ----------
export const CONFIG = {
  maxVehicles: 70, maxPeds: 130,             // desktop caps (phones get ~60 %)
  motoShare: 0.24, busShare: 0.06,
  motoCrashPerHour: 4,                         // background moto falls per hour of sim time
  motoDownSeconds: 8,                          // a fallen bike clears quickly
  pedContactInChaos: true,                     // only fleeing / pursuit vehicles can knock pedestrians down
  knockdownSeconds: 3, limpSpeed: 0.7,
  jaywalkPerMin: 0.25, redCrossChance: 0.12,   // per pedestrian
  panicSpreadRadius: 11, panicSpreadPerSec: 0.9, calmAfter: [7, 12],
  recklessShare: 0.35,                         // fleeing drivers who break rules (wrong way, sidewalk)
  pursuitLoseDist: 150, giveUpSeconds: 9,
};
const PERS = {
  calm:       {T: 1.8, a: 1.2, b: 2.0, v0: 0.9,  acc: 5.0, col: "#7fb8ff"},
  normal:     {T: 1.4, a: 1.6, b: 2.5, v0: 1.0,  acc: 4.0, col: "#cfd8e3"},
  aggressive: {T: 0.9, a: 2.6, b: 3.2, v0: 1.18, acc: 2.6, col: "#ff8a5c"},
  distracted: {T: 1.6, a: 1.4, b: 2.4, v0: 0.95, acc: 4.4, col: "#c99bff", delay: 1.6},
};
const TURN_EN = {left: "turn left", right: "turn right", slight_left: "bear left", slight_right: "bear right", uturn: "make a U-turn", through: "continue"};
const TURN_PT = {left: "vire à esquerda", right: "vire à direita", slight_left: "mantenha-se à esquerda", slight_right: "mantenha-se à direita", uturn: "faça o retorno", through: "siga em frente"};
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const hyp = Math.hypot;

// ---------- geometry ----------
function mkPath(pts, extra) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return Object.assign({pts, cum, len: Math.max(cum[cum.length - 1], 0.1), agents: []}, extra);
}
function posAt(p, s) {
  const {pts, cum} = p; s = clamp(s, 0, p.len);
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / seg;
  return {x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, h: Math.atan2(b[1] - a[1], b[0] - a[0])};
}
function nearestOn(p, x, y) {
  let best = {d: 1e9, s: 0};
  for (let i = 1; i < p.pts.length; i++) {
    const a = p.pts[i - 1], b = p.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / L2, 0, 1), qx = a[0] + dx * t, qy = a[1] + dy * t, d = hyp(x - qx, y - qy);
    if (d < best.d) best = {d, s: p.cum[i - 1] + t * Math.sqrt(L2), x: qx, y: qy};
  }
  return best;
}
function cutPath(p, a, b) { // sub-polyline between arc lengths a..b
  const out = [[posAt(p, a).x, posAt(p, a).y]];
  for (let i = 1; i < p.pts.length - 1; i++) if (p.cum[i] > a && p.cum[i] < b) out.push(p.pts[i]);
  const e = posAt(p, b); out.push([e.x, e.y]); return out;
}
function offsetPts(pts, off) { // + = left of travel
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const L = hyp(dx, dy) || 1; dx /= L; dy /= L;
    out.push([pts[i][0] - dy * off, pts[i][1] + dx * off]);
  }
  return out;
}
function segX(a, b, c, d) {
  const r = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]); if (Math.abs(r) < 1e-9) return false;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / r, u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / r;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}
function polyX(p, q) { for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) if (segX(p[i - 1], p[i], q[j - 1], q[j])) return true; return false; }
const bearingName = (h, pt) => { // h = math angle (0 = east)
  const deg = ((90 - h * 180 / Math.PI) % 360 + 360) % 360, k = Math.round(deg / 45) % 8;
  return (pt ? ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"] : ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"])[k];
};

// ---------- world: built from one section file ----------
export class World {
  constructor(d) {
    this.d = d; this.half = d.half; this.t = 7 * 3600; this.simT = 0; this.events = []; this.feed = [];
    this.vehicles = []; this.peds = []; this.nextId = 1; this.scenario = "traffic"; this.density = 1;
    this.counters = {crashes: 0, yields: 0, knock: 0};
    this.build();
  }
  name(i) { return i >= 0 ? this.d.names[i] : ""; }
  build() {
    const d = this.d, H = this.half;
    this.lanes = d.lanes.map((l, i) => mkPath(l.pts, {kind: "L", i, l, e: d.edges[l.e], w: l.w, v: (d.edges[l.e].sp || 40) / 3.6, inC: [], outC: l.nx.slice()}));
    this.conns = d.conns.map((c, i) => mkPath(c.pts, {kind: "C", i, c, from: this.lanes[c.f], to: this.lanes[c.t], v: Math.min(this.lanes[c.f].v, c.tu === "through" ? 99 : c.tu.startsWith("slight") ? 11 : 6.5), conf: [], occ: null}));
    this.conns.forEach(c => c.from.l && c.to.inC.push(c.i));
    // signals: phase lookup per (edge,dir)
    this.sigs = d.signals.map(s => ({...s, node: d.nodes[s.n]}));
    this.lanes.forEach(L => {
      L.sig = null; L.ctl = "none";
      const n = d.nodes[L.l.to]; if (!n) return;
      const ap = n.ap.find(a => a[0] === L.l.e && a[1] === L.l.d); L.ctl = ap ? ap[2] : n.c;
      if (n.c === "roundabout" && L.ctl === "none" && !d.edges[L.l.e].rb) L.ctl = "give_way";
      const sg = this.sigs.find(s => s.n === L.l.to);
      if (sg) { const ph = sg.ph.findIndex(p => p.ap.some(a => a[0] === L.l.e && a[1] === L.l.d)); if (ph >= 0) { L.sig = sg; L.ph = ph; L.ctl = "signal"; } }
    });
    // connector conflicts at the same node (crossing paths or merging into the same lane)
    const byNode = {};
    this.conns.forEach(c => (byNode[c.c.n] ||= []).push(c));
    Object.values(byNode).forEach(cs => {
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j]; if (a.from === b.from) continue;
        if (a.to === b.to || polyX(a.pts, b.pts)) { a.conf.push(b); b.conf.push(a); }
      }
    });
    // boundary entries / exits and "useful" lanes that can still reach the edge of the section
    const atEdge = p => Math.abs(p[0]) > H - 25 || Math.abs(p[1]) > H - 25;
    this.drive = this.lanes.filter(L => L.l.t !== "p");
    // lanes cut off by the section box (or the tile edge) are where traffic enters and leaves
    this.entries = this.drive.filter(L => !L.inC.length && (atEdge(L.pts[0]) || L.len > 60));
    this.innerEntries = this.drive.filter(L => !L.inC.length && !this.entries.includes(L));
    const good = new Set(this.drive.filter(L => !L.outC.length && (atEdge(L.pts[L.pts.length - 1]) || L.len > 60)));
    let grew = true;
    while (grew) { grew = false; for (const L of this.drive) if (!good.has(L) && L.outC.some(ci => good.has(this.conns[ci].to))) { good.add(L); grew = true; } }
    this.good = good;
    // sidewalk network derived from the road edges (the game will use peds_<tid>.json; not generated yet)
    this.walks = [];
    d.edges.forEach((e, ei) => {
      if (/motorway|trunk/.test(e.c) || e.br) return;
      const trimAt = p => { let r = 0; for (const n of d.nodes) if (hyp(n.x - p[0], n.y - p[1]) < 4) r = Math.max(r, n.r + 2.5); return r; };
      const a = trimAt(e.pts[0]), b = trimAt(e.pts[e.pts.length - 1]);
      for (const side of [1, -1]) {
        const full = mkPath(offsetPts(e.pts, side * (e.w / 2 + 1.8)));
        if (full.len - a - b < 6) continue;
        this.walks.push(mkPath(cutPath(full, a, full.len - b), {ei, side, links: [[], []], cross: []}));
      }
    });
    const ends = []; this.walks.forEach((w, wi) => { ends.push([w, 0, w.pts[0]]); ends.push([w, 1, w.pts[w.pts.length - 1]]); });
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      const A = ends[i], B = ends[j]; if (A[0] === B[0]) continue;
      if (hyp(A[2][0] - B[2][0], A[2][1] - B[2][1]) < 13) { A[0].links[A[1]].push([B[0], B[1]]); B[0].links[B[1]].push([A[0], A[1]]); }
    }
    this.cross = d.cross.map(c => {
      const sides = this.walks.filter(w => w.ei === c.e), e = d.edges[c.e];
      if (sides.length < 2) return null;
      const a = nearestOn(sides[0], c.x, c.y), b = nearestOn(sides[1], c.x, c.y);
      if (a.d > 6 || b.d > 6) return null;
      // signalised if a signal head nearby controls this street
      let sig = null;
      for (const s of this.sigs) if (hyp(s.node.x - c.x, s.node.y - c.y) < 38 && s.ph.some(p => p.ap.some(q => q[0] === c.e))) { sig = s; break; }
      const X = {c, e, ei: c.e, A: [sides[0], a.s, a.x, a.y], B: [sides[1], b.s, b.x, b.y], sig, x: c.x, y: c.y};
      sides[0].cross.push([a.s, X, 0]); sides[1].cross.push([b.s, X, 1]);
      return X;
    }).filter(Boolean);
    this.busStops = d.bus.map(b => ({...b, lane: this.lanes[b.l], waiting: []})).filter(b => b.lane);
    this.parked = [];
    d.parking.forEach(p => { const L = this.lanes[p.l]; if (!L) return; for (let s = p.a + 3; s < Math.min(p.b, L.len) - 3; s += rnd(5.6, 9)) if (Math.random() < 0.7) this.parked.push({...posAt(L, s), c: pick(["#5d6878", "#7b8794", "#444e5c", "#8a6f5a", "#566f8a"])}); });
    // labels: longest piece of each street
    const best = {};
    d.edges.forEach(e => { if (e.n < 0) return; const p = mkPath(e.pts); if (!best[e.n] || p.len > best[e.n].len) best[e.n] = p; });
    this.labels = Object.entries(best).filter(([, p]) => p.len > 45).map(([n, p]) => ({text: this.d.names[n], len: p.len, ...posAt(p, p.len / 2)}));
    this.walkLen = this.walks.reduce((a, w) => a + w.len, 0);
  }

  // ---------- signals ----------
  sigState(L) { // 'g' | 'y' | 'r'
    if (!L.sig) return "g";
    const s = L.sig, tt = ((this.t + s.o) % s.cy + s.cy) % s.cy; let acc = 0;
    for (let i = 0; i < s.ph.length; i++) {
      const p = s.ph[i], end = acc + p.g + p.y + p.ar;
      if (tt < end) { if (i !== L.ph) return "r"; return tt < acc + p.g ? "g" : tt < acc + p.g + p.y ? "y" : "r"; }
      acc = end;
    }
    return "r";
  }
  edgeGreen(ei) { // any approach of this street green at its signal → pedestrians crossing it wait
    for (const L of this.drive) if (L.l.e === ei && L.sig && this.sigState(L) !== "r") return true;
    return false;
  }

  // ---------- spawning ----------
  todFactor() { const h = (this.t / 3600) % 24; return 0.25 + 0.75 * Math.max(Math.exp(-((h - 8.5) ** 2) / 5), Math.exp(-((h - 18.5) ** 2) / 6), h > 10 && h < 17 ? 0.7 : 0, h > 21 || h < 5 ? 0.1 : 0.35); }
  targets() {
    const f = this.todFactor() * this.density, base = {paulista: [60, 130], marginal: [70, 10], jardins: [38, 70], europa: [34, 30], novejulho: [62, 100]}[this.d.key] || [50, 70];
    return {v: Math.round(Math.min(CONFIG.maxVehicles, base[0] * f) * (this.small ? 0.6 : 1)), p: Math.round(Math.min(CONFIG.maxPeds, base[1] * f) * (this.small ? 0.6 : 1))};
  }
  spawnVehicle(kind, at, opts = {}) {
    let lanes = this.entries.filter(L => (kind === "bus") === (L.l.t === "b") || (kind === "bus" && L.l.t === "g"));
    if (kind !== "bus") lanes = lanes.filter(L => L.l.t === "g");
    if (!lanes.length) lanes = this.entries.filter(L => L.l.t === "g");
    const L = at || pick(lanes); if (!L) return null;
    const s0 = opts.s || 0; if (L.agents.some(a => Math.abs(a.s - s0) < 12)) return null;
    const pers = opts.pers || (kind === "moto" ? pick(["normal", "aggressive", "aggressive"]) : pick(["calm", "normal", "normal", "normal", "aggressive", "distracted"]));
    const v = {id: this.nextId++, kind, pers, P: PERS[pers], path: L, s: opts.s || 0, v: L.v * 0.8, lat: 0, latT: 0, alpha: 0, state: "cruising",
      len: kind === "bus" ? 12 : kind === "moto" ? 2.1 : 4.5, wid: kind === "bus" ? 2.6 : kind === "moto" ? 0.8 : 1.85,
      col: kind === "bus" ? "#e2b23c" : kind === "moto" ? "#d7dee8" : pick(["#c8ced6", "#9aa5b4", "#e8eaee", "#2c3440", "#6f2d2d", "#2e4a6b", "#3b3b3b", "#b9b2a3"]),
      nextC: null, route: null, wait: 0, dwell: 0, lastBus: -1, ...opts};
    if (v.s) { const p = L; v.s = Math.min(v.s, p.len - 1); }
    L.agents.push(v); this.vehicles.push(v); return v;
  }
  spawnPed(near) {
    let w, s;
    if (near) { w = near[0]; s = near[1]; }
    else { let r = Math.random() * this.walkLen; for (w of this.walks) { if (r < w.len) break; r -= w.len; } s = rnd(0, w.len); }
    if (!w) return;
    const p = {id: this.nextId++, w, s, dir: Math.random() < 0.5 ? 1 : -1, v: rnd(1.05, 1.55), state: "walking", alpha: 0, x: 0, y: 0, jay: 0,
      col: pick(["#f0c9a0", "#b98a64", "#7c5a3e", "#e8d2b8", "#5a4030"]), shirt: pick(["#d24b3c", "#3c7bd2", "#e7e2d6", "#2f3b48", "#3fa36b", "#e0a73a", "#8c5ac8"])};
    Object.assign(p, posAt(w, s)); this.peds.push(p); return p;
  }
  populate() {
    const T = this.targets();
    let nv = this.vehicles.filter(v => v.kind !== "pursuer" && v.kind !== "target" && !v.scripted).length;
    for (let k = 0; k < 3 && nv < T.v; k++) {
      const r = Math.random(), kind = r < CONFIG.busShare ? "bus" : r < CONFIG.busShare + CONFIG.motoShare * (this.d.key === "marginal" ? 1.3 : 1) ? "moto" : "car";
      if (this.spawnVehicle(kind)) nv++;
    }
    if (this.innerEntries.length && Math.random() < 0.004) this.spawnVehicle("car", pick(this.innerEntries));
    let np = this.peds.length;
    for (let k = 0; k < 3 && np < T.p && this.walks.length; k++, np++) this.spawnPed();
    // people waiting at bus stops
    const waitingNow = this.busStops.reduce((a, b) => a + b.waiting.length, 0);
    for (const b of this.busStops) if (b.waiting.length < 2 && waitingNow < 10 && Math.random() < 0.002 * T.p / 40) {
      const w = this.walks.map(w => [w, nearestOn(w, b.x, b.y)]).sort((a, c) => a[1].d - c[1].d)[0];
      if (w && w[1].d < 8) { const p = this.spawnPed([w[0], w[1].s]); if (p) { p.state = "waiting for the bus"; p.bus = b; b.waiting.push(p); } }
    }
  }

  // ---------- events and perception ----------
  emit(type, x, y, extra = {}) {
    const R = {explosion: 150, shots: 115, fire: 70, crash: 35, horn: 14}[type] || 40;
    const ev = {type, x, y, r: R, t0: this.simT, life: type === "fire" ? 30 : type === "shots" ? 4 : type === "crash" ? 8 : 2.5, ...extra};
    this.events.push(ev);
    if (type === "horn") return ev;
    if (type === "crash") { this.say(`Motorcycle down while lane-splitting. Nearby drivers slow, people stop to look.`); }
    else this.say({explosion: "Explosion. Everyone inside 150 m hears it: pedestrians scatter, drivers flee.", shots: "Shots fired. Hearing radius 115 m: people run away from the sound.", fire: "Car fire. People nearby back away; drivers avoid the street."}[type]);
    if (type === "fire") this.vehicles.push({id: this.nextId++, kind: "wreck", x, y, h: rnd(0, 6.3), alpha: 1, len: 4.5, wid: 1.9, col: "#2a2a2a", state: "burning", path: null, until: this.simT + 30});
    for (const p of this.peds) {
      const d = hyp(p.x - x, p.y - y);
      if (type === "crash") { if (d < R && p.state === "walking" && Math.random() < 0.5) { p.state = "watching"; p.timer = rnd(3, 6); p.look = [x, y]; } continue; }
      if (d < R) this.panicPed(p, x, y, 1 - d / R);
    }
    for (const v of this.vehicles) {
      if (!v.path || v.kind === "pursuer") continue;
      const d = hyp(v.x - x, v.y - y);
      if (type === "crash") { if (d < R) v.slowUntil = this.simT + 4; continue; }
      if (d < R * 0.85) this.panicVehicle(v, x, y);
    }
    return ev;
  }
  panicPed(p, x, y, k) {
    if (p.state === "knocked down") return;
    if (p.bus) { p.bus.waiting = p.bus.waiting.filter(q => q !== p); p.bus = null; }
    const a = Math.atan2(p.y - y, p.x - x) + rnd(-0.5, 0.5);
    p.state = "fleeing"; p.fx = Math.cos(a); p.fy = Math.sin(a); p.fv = rnd(3.2, 4.6); p.timer = rnd(...CONFIG.calmAfter) * (0.6 + 0.4 * k); p.src = [x, y];
  }
  panicVehicle(v, x, y) {
    if (v.state.startsWith("fleeing")) return;
    const ahead = Math.cos(Math.atan2(y - v.y, x - v.x) - v.h) > 0.2, reckless = Math.random() < CONFIG.recklessShare;
    v.fleeUntil = this.simT + rnd(10, 16); v.src = [x, y];
    if (ahead && reckless && v.kind !== "bus") { v.state = "fleeing: wrong way"; v.rev = true; v.v = 0; this.say("A panicking driver turns around and goes the wrong way to get out."); }
    else if (ahead && !reckless) { v.state = "fleeing: stopped, waiting"; v.hold = true; }
    else { v.state = reckless ? "fleeing: running reds" : "fleeing: speeding away"; v.flee = reckless ? 2 : 1; }
  }
  calmAll() {
    this.events = [];
    for (const v of this.vehicles) { if (v.rev) v.dead = true; v.flee = 0; v.fleeUntil = 0; v.hold = false; v.side = false; if (v.state && v.state.startsWith("fleeing")) v.state = "cruising"; }
    for (const p of this.peds) if (p.state === "fleeing" || p.state === "knocked down") { p.state = "calming down"; p.home = this.walkNear(p.x, p.y); }
  }
  say(msg) { if (!msg) return; this.feed.unshift({t: this.simT, msg}); this.feed.length = Math.min(this.feed.length, 6); }

  // ---------- routing (one graph for GPS, pursuing and fleeing parties) ----------
  // nodes = lanes + connectors; lane changes are edges between neighbour lanes
  route(fromPath, fromS, toPath, toS, opt = {}) {
    const bus = opt.bus, ignoreBus = opt.civil !== false;
    const ok = L => L.l ? (L.l.t === "g" || (L.l.t === "b" && (bus || opt.pursuer))) : true;
    const cost = p => p.len / (opt.pursuer ? Math.max(p.v, 12) : p.v);
    const dist = new Map(), prev = new Map(), Q = [];
    const push = (p, c, from, how) => { if (c < (dist.get(p) ?? 1e9)) { dist.set(p, c); prev.set(p, [from, how]); Q.push([c, p]); } };
    if (fromPath === toPath && toS >= fromS) return {paths: [fromPath], cost: (toS - fromS) / fromPath.v};
    push(fromPath, -fromS / fromPath.v, null);
    let best = null, bestC = 1e9;
    while (Q.length) {
      let bi = 0; for (let i = 1; i < Q.length; i++) if (Q[i][0] < Q[bi][0]) bi = i;
      const [c, p] = Q.splice(bi, 1)[0]; if (c > (dist.get(p) ?? 1e9) || c > bestC) continue;
      if (p === toPath && p !== fromPath) { const tc = c + toS / p.v; if (tc < bestC) { bestC = tc; best = p; } continue; }
      const out = c + cost(p);
      if (p.kind === "L") {
        for (const ci of p.outC) { const C = this.conns[ci]; if (ok(C.to)) push(C, out + (C.c.tu === "uturn" ? 120 : C.c.tu === "through" ? 0 : 3), p, "turn"); }
        for (const n of [p.l.l, p.l.r]) if (n >= 0 && ok(this.lanes[n])) push(this.lanes[n], c + 4, p, n === p.l.l ? "left" : "right");
      } else push(p.to, out, p, "enter");
    }
    if (!best) return null;
    const paths = []; let p = best; while (p) { paths.unshift(p); p = prev.get(p)?.[0]; }
    // collapse lane changes onto the path list, keeping the change marks
    return {paths, cost: bestC};
  }
  nearestLane(x, y, filt = L => L.l.t === "g") {
    let best = null;
    for (const L of this.drive) { if (!filt(L)) continue; const n = nearestOn(L, x, y); if (!best || n.d < best.d) best = {L, ...n}; }
    return best;
  }

  // ---------- vehicles ----------
  chooseNext(v) {
    const L = v.path; if (v.route) { const i = v.route.indexOf(L); const n = v.route[i + 1]; if (n && n.kind === "C") return n; }
    let cs = L.outC.map(ci => this.conns[ci]).filter(C => (v.kind === "bus" ? C.to.l.t !== "p" : C.to.l.t === "g" || (C.to.l.t === "b" && v.flee)));
    if (!cs.length) return null;
    const w = C => (this.good.has(C.to) ? 1 : 0.05) * (C.c.tu === "through" ? 3 : C.c.tu === "uturn" ? 0.05 : 1) * (v.kind === "bus" && C.to.l.t === "b" ? 6 : 1);
    let tot = cs.reduce((a, C) => a + w(C), 0), r = Math.random() * tot;
    for (const C of cs) { r -= w(C); if (r <= 0) return C; }
    return cs[0];
  }
  leaderOf(v) { // nearest vehicle ahead along the planned path, gap in metres
    const chase = v.kind === "pursuer" || v.kind === "target";
    const consider = u => {
      if (u === v) return false;
      if (chase && (u.pullOver || u.v < 0.5 && u.kind !== "target" && u.kind !== "pursuer" && Math.random() < 0.5)) return false;
      if (v.side && Math.abs(u.lat) < 1) return false;
      if (v.kind === "moto" && v.lat > 0.5 && u.kind === "car" && u.v < 12) return false; // corridor: ride past cars
      if (v.kind !== "moto" && u.kind === "moto" && Math.abs(u.lat) > 0.6) return false;
      return true;
    };
    let best = null, gap = 1e9, ds = 1e9;
    for (const u of v.path.agents) if (u.s > v.s && u.s - v.s < ds && consider(u)) { ds = u.s - v.s; best = u; }
    if (best) return [best, ds - (best.len + v.len) / 2];
    let d = v.path.len - v.s, p = v.nextC || (v.path.kind === "C" ? v.path.to : null);
    for (let hop = 0; p && hop < 3 && d < 80; hop++) {
      for (const u of p.agents) if ((!best || u.s < ds) && consider(u)) { best = u; ds = u.s; }
      if (best) return [best, d + ds - (best.len + v.len) / 2];
      d += p.len; p = p.kind === "C" ? p.to : null;
    }
    return [null, 1e9];
  }
  pedAhead(v) { // pedestrians in the vehicle's way within 26 m (cars always yield in normal traffic)
    let gap = 1e9, p = v.path, s = v.s, d = 0;
    for (let k = 0; k < 13; k++) {
      if (s > p.len) { const n = p.kind === "L" ? v.nextC : p.to; if (!n) break; s -= p.len; p = n; }
      const q = posAt(p, s), h = q.h, ox = q.x + Math.cos(h + 1.57) * v.lat, oy = q.y + Math.sin(h + 1.57) * v.lat;
      for (const ped of this.pedGrid(ox, oy)) if (ped.state !== "knocked down" && hyp(ped.x - ox, ped.y - oy) < v.wid / 2 + 0.9) { gap = Math.min(gap, d); break; }
      if (gap < 1e9) break;
      s += 2; d += 2;
    }
    return gap;
  }
  pedGrid(x, y) { const gx = Math.floor(x / 8), gy = Math.floor(y / 8), out = []; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const a = this.grid.get((gx + i) + "," + (gy + j)); if (a) out.push(...a); } return out; }
  mustYield(v, C) { // right-of-way arbiter at a node
    const L = v.path, myRank = L.ctl === "stop" ? 3 : L.ctl === "give_way" || L.ctl === "roundabout" ? 2 : L.ctl === "priority_right" ? 1 : 0;
    for (const K of C.conf) {
      if (K.occ && K.occ !== v && K.occ.path === K) return "a vehicle already in the junction";
      for (const u of K.from.agents) {
        if (u === v || u.nextC !== K || K.from.len - u.s > 16 || u.v < 0.5 && u.wait < 0.1) continue;
        const R = K.from.ctl === "stop" ? 3 : K.from.ctl === "give_way" || K.from.ctl === "roundabout" ? 2 : K.from.ctl === "priority_right" ? 1 : 0;
        if (L.sig && this.sigState(L) === "g" && K.from.sig && this.sigState(K.from) !== "g") continue;
        if (R < myRank) return "giving way to traffic with priority";
        if (R === myRank && R === 1) { // yield to the vehicle on the right (CTB art. 29)
          const a = posAt(L, L.len), b = posAt(K.from, K.from.len), cr = Math.cos(a.h) * (b.y - a.y) - Math.sin(a.h) * (b.x - a.x);
          if (cr < 0) return "yielding to the car on the right";
        }
        if (R === myRank && C.c.tu === "left" && K.c.tu !== "left" && R === 0) return "turning left: waiting for a gap";
      }
    }
    return null;
  }
  stepVehicle(v, dt) {
    if (v.kind === "wreck") { v.alpha = this.simT > v.until ? Math.max(0, v.alpha - dt) : 1; return; }
    if (v.state === "down") { v.down -= dt; if (v.down < 0) v.alpha -= dt; v.s += v.v * dt; v.v = Math.max(0, v.v - 6 * dt); this.place(v); return; }
    v.alpha = Math.min(1, v.alpha + dt * 1.5);
    if (v.path.kind === "L" && !v.path.outC.length) v.alpha = Math.min(v.alpha, (v.path.len - v.s) / 12);
    if (v.fleeUntil && this.simT > v.fleeUntil) { v.fleeUntil = 0; v.flee = 0; v.hold = false; v.state = "calming down"; v.calmUntil = this.simT + 4; }
    if (v.calmUntil && this.simT > v.calmUntil) { v.calmUntil = 0; v.state = "cruising"; }
    if (v.rev) { // wrong-way escape: drive back along the lane
      v.v = Math.min(v.v + 3 * dt, 8); v.s -= v.v * dt; v.latT = -0.6;
      if (v.s < 0) { v.alpha -= dt * 2; if (v.alpha <= 0) v.dead = true; }
      this.place(v, true); this.hitPeds(v); return;
    }
    const L = v.path, P = v.P;
    if (L.kind === "L" && !v.nextC && L.outC.length) { v.nextC = this.chooseNext(v); }
    // desired speed
    let v0 = (L.kind === "C" ? L.v : L.v) * P.v0;
    if (v.kind === "moto") v0 *= 1.15;
    if (v.flee) v0 *= 1.35; if (v.kind === "pursuer") v0 = Math.max(v0, L.v * 1.55); if (v.kind === "target") v0 = Math.max(v0, L.v * 1.45);
    if (v.slowUntil > this.simT) v0 *= 0.45;
    if (v.pullOver) { v0 = Math.min(v0, 2.2); }
    if (v.hold) v0 = 0;
    let gap = 1e9, dv = 0, why = null;
    const [lead, lg] = this.leaderOf(v);
    if (lead) { gap = lg; dv = v.v - (lead.rev ? 0 : lead.v); }
    // bus dwell at stops
    if (v.kind === "bus" && L.kind === "L") for (const b of this.busStops) if (b.lane === L && b.s > v.s - 1 && b.s - v.s < gap && v.lastBus !== b) { if (b.s - v.s < 1.5 && v.v < 0.8) { v.dwell = rnd(8, 14); v.lastBus = b; b.waiting.forEach(p => { p.state = "boarding"; p.board = v; }); b.waiting = []; this.say("Bus pulls into the stop; people waiting get on."); } else { gap = b.s - v.s + 2.2; dv = v.v; why = "stopping for the bus stop"; } }
    if (v.dwell > 0) { v.dwell -= dt; v0 = 0; why = "at the bus stop"; if (v.dwell <= 0 && Math.random() < 0.6) this.spawnPed(this.walkNear(v.x, v.y)); }
    // junction control at the end of the lane
    if (L.kind === "L" && v.nextC && v.flee !== 2 && v.kind !== "pursuer" && v.kind !== "target") {
      const dEnd = L.len - v.s - v.len / 2 - (v.kind === "moto" && v.lat > 0.3 ? -1.5 : 0.5);
      let stop = false;
      const st = this.sigState(L);
      if (st === "r") { stop = true; why = v.kind === "moto" && v.lat > 0.3 ? "filtering to the front at the red light" : "stopped at the red light"; }
      else if (st === "y" && dEnd > v.v * v.v / (2 * 4) && P !== PERS.aggressive) { stop = true; why = "stopping for amber"; }
      if (!stop && dEnd < 18) {
        if (L.ctl === "stop" && !v.stopped) { stop = true; why = "full stop at the PARE sign"; if (v.v < 0.4 && dEnd < 2.5) v.stopped = true; }
        else { const y = (v.wait > P.acc + 4) ? null : this.mustYield(v, v.nextC); if (y) { stop = true; why = y; if (dEnd < 4 && v.v < 0.5) v.wait += dt; } }
      }
      if (stop && dEnd + 1.8 < gap) { gap = Math.max(dEnd + 1.8, 0.01); dv = v.v; }
    }
    // pedestrians: hard yield for normal traffic
    const pg = this.pedAhead(v), chaos = v.flee || v.kind === "pursuer" || v.kind === "target";
    if (pg < gap && (!chaos || !CONFIG.pedContactInChaos || Math.random() < 0.85)) { gap = pg - 1.0; dv = v.v; why = "yielding to a pedestrian"; if (!chaos && pg < 3) { v.v = Math.min(v.v, 1); } }
    // IDM
    const s0 = v.kind === "moto" ? 1.0 : 2.0, T = v.flee ? 0.6 : P.T, a = P.a * (v.flee ? 1.6 : 1), b = P.b;
    const sStar = s0 + Math.max(0, v.v * T + v.v * dv / (2 * Math.sqrt(a * b)));
    let acc = a * (1 - Math.pow(v.v / Math.max(v0, 0.1), 4) - (gap < 1e8 ? (sStar / Math.max(gap, 0.1)) ** 2 : 0));
    if (P.delay && lead && lead.v > 1 && v.v < 0.3) { v.react = (v.react || 0) + dt; if (v.react < P.delay) acc = Math.min(acc, 0); } else v.react = 0;
    acc = clamp(acc, chaos ? -6 : -9, a);
    v.v = Math.max(0, v.v + acc * dt);
    if (v0 === 0 && v.hold) v.v = Math.max(0, v.v - 6 * dt);
    if (gap < 0.3 && !chaos) v.v = 0;
    // state label
    if (!v.state.startsWith("fleeing") && v.state !== "calming down" && v.kind !== "pursuer" && v.kind !== "target")
      v.state = v.pullOver ? "pulling over for the pursuing party" : why ? why : v.kind === "moto" && v.lat > 0.3 ? "lane-splitting (corredor)" : lead && gap < 25 && v.v < v0 * 0.6 ? "following" : v.lc ? "changing lanes" : "cruising";
    if (why && /pedestrian/.test(why) && v.v < 0.5 && !v._y) { this.counters.yields++; v._y = 1; } else if (!why) v._y = 0;
    // lane change (MOBIL-lite) and moto corridor
    this.laneLogic(v, lead, gap, v0, dt);
    // advance
    v.s += v.v * dt;
    while (v.s >= v.path.len) {
      const p = v.path; v.s -= p.len;
      let n = p.kind === "L" ? v.nextC : p.to;
      if (p.kind === "C" && p.occ === v) p.occ = null;
      if (!n) { v.dead = true; break; }
      if (n.kind === "C") n.occ = v;
      p.agents.splice(p.agents.indexOf(v), 1); n.agents.push(v); v.path = n; v.nextC = null; v.wait = 0; v.stopped = false;
    }
    if (!v.dead) { this.place(v); if (chaos) this.hitPeds(v); }
  }
  laneLogic(v, lead, gap, v0, dt) {
    const L = v.path;
    v.lat += (v.latT - v.lat) * Math.min(1, dt * 2.2);
    if (v.lc) { v.lc -= dt; if (v.lc <= 0) v.lc = 0; }
    if (L.kind !== "L") { v.latT = v.kind === "moto" && v.latT > 0 ? v.latT : 0; return; }
    if (v.pullOver) { v.latT = -L.w * 0.45; return; }
    if (v.flee === 2 && lead && gap < 14 && lead.v < 1.5 && v.kind === "car" && !v.side) { v.side = true; v.latT = -(L.w / 2 + 2.6); v.state = "fleeing: onto the sidewalk"; this.say("A panicking driver mounts the sidewalk to get around stopped traffic."); return; }
    if (v.side) { if (!v.flee) { v.side = false; v.latT = 0; } return; }
    if (v.kind !== "moto") v.latT = 0;
    if (v.kind === "moto") { // ride the gap between this lane and its left neighbour when traffic is slow
      const corr = L.l.l >= 0 && this.lanes[L.l.l].l.t === "g";
      const slow = L.agents.some(u => u !== v && u.kind === "car" && u.s > v.s && u.s - v.s < 40 && u.v < 11);
      v.latT = corr && slow ? L.w / 2 : 0;
      v.splitting = corr && slow && v.lat > 0.4;
      return;
    }
    if (v.lc || L.len - v.s < 25 || v.s < 5 || v.route && v.kind !== "pursuer") return;
    // stuck behind something slow → look left/right
    if (lead && gap < 30 && lead.v < v0 * 0.55 && Math.random() < dt * (v.P === PERS.aggressive ? 1.2 : 0.35)) {
      for (const ni of [L.l.l, L.l.r]) {
        if (ni < 0) continue; const N = this.lanes[ni]; if (N.l.t !== "g" && !(v.kind === "bus" && N.l.t === "b")) continue;
        const ns = clamp(v.s / L.len * N.len, 0, N.len - 1);
        const clear = N.agents.every(u => u.kind === "moto" || Math.abs(u.s - ns) > (u.s > ns ? 10 : 8 + v.v * 0.8));
        if (!clear) continue;
        const left = ni === L.l.l; L.agents.splice(L.agents.indexOf(v), 1); N.agents.push(v);
        v.path = N; v.s = ns; v.nextC = null; v.lat = left ? -L.w : L.w; v.latT = 0; v.lc = 2.2; v.state = "changing lanes";
        break;
      }
    }
  }
  crashMoto(v) {
    v.state = "down"; v.down = CONFIG.motoDownSeconds; v.spin = rnd(-2, 2); this.counters.crashes++;
    this.emit("crash", v.x, v.y);
  }
  place(v, rev) {
    const q = posAt(v.path, v.s), n = q.h + Math.PI / 2;
    v.x = q.x + Math.cos(n) * v.lat; v.y = q.y + Math.sin(n) * v.lat; v.h = rev ? q.h + Math.PI : q.h + (v.spin ? v.spin * (CONFIG.motoDownSeconds - v.down) : 0);
    if (v.lc) v.h += (v.lat > 0 ? -1 : 1) * 0.12 * Math.min(1, Math.abs(v.lat));
  }
  hitPeds(v) {
    if (!CONFIG.pedContactInChaos || v.v < 2) return;
    for (const p of this.pedGrid(v.x, v.y)) if (p.state !== "knocked down" && hyp(p.x - v.x, p.y - v.y) < v.wid / 2 + 0.6) {
      p.state = "knocked down"; p.timer = CONFIG.knockdownSeconds; p.kx = Math.cos(v.h) * 1.4; p.ky = Math.sin(v.h) * 1.4; this.counters.knock++;
      this.say("In the chaos a pedestrian is knocked down. No injuries shown: they get up and limp off.");
    }
  }
  walkNear(x, y) { let best = null; for (const w of this.walks) { const n = nearestOn(w, x, y); if (!best || n.d < best[2]) best = [w, n.s, n.d]; } return best; }

  // ---------- pedestrians ----------
  stepPed(p, dt) {
    p.alpha = Math.min(1, p.alpha + dt * 1.5);
    const S = p.state;
    if (S === "fleeing") {
      p.x += p.fx * p.fv * dt; p.y += p.fy * p.fv * dt; p.timer -= dt; p.h = Math.atan2(p.fy, p.fx);
      if (p.timer < 0) { p.state = "calming down"; p.home = this.walkNear(p.x, p.y); }
      // panic spreads to people who see someone running
      for (const q of this.pedGrid(p.x, p.y)) if (q.state === "walking" || q.state === "waiting" || q.state === "watching" || q.state === "waiting for the bus")
        if (hyp(q.x - p.x, q.y - p.y) < CONFIG.panicSpreadRadius && Math.random() < CONFIG.panicSpreadPerSec * dt) this.panicPed(q, p.src[0], p.src[1], 0.5);
      return this.offMap(p);
    }
    if (S === "calming down" || S === "limping off") {
      const h = p.home; if (!h) { p.dead = true; return; }
      const t = posAt(h[0], h[1]), dx = t.x - p.x, dy = t.y - p.y, d = hyp(dx, dy), sp = S === "limping off" ? CONFIG.limpSpeed : 1.0;
      if (d < 0.5) { p.state = "walking"; p.w = h[0]; p.s = h[1]; return; }
      p.x += dx / d * sp * dt; p.y += dy / d * sp * dt; p.h = Math.atan2(dy, dx); return;
    }
    if (S === "knocked down") { p.timer -= dt; p.x += p.kx * dt; p.y += p.ky * dt; p.kx *= 0.9; p.ky *= 0.9; if (p.timer < 0) { p.state = "limping off"; p.home = this.walkNear(p.x, p.y); } return; }
    if (S === "watching") { p.timer -= dt; p.h = Math.atan2(p.look[1] - p.y, p.look[0] - p.x); if (p.timer < 0) p.state = "walking"; return; }
    if (S === "waiting for the bus") return;
    if (S === "boarding") { const b = p.board; if (!b || b.dead) { p.dead = true; return; } const dx = b.x - p.x, dy = b.y - p.y, d = hyp(dx, dy); if (d < 1.2) p.dead = true; else { p.x += dx / d * 1.4 * dt; p.y += dy / d * 1.4 * dt; } return; }
    if (S === "crossing" || S === "crossing on red" || S === "jaywalking") {
      const [tx, ty] = p.to, dx = tx - p.x, dy = ty - p.y, d = hyp(dx, dy), sp = p.v * (S === "walking" ? 1 : 1.25);
      // even mid-crossing, a car bearing down makes them hurry
      if (d < 0.4) { p.state = "walking"; p.w = p.toW; p.s = p.toS; p.dir = Math.random() < 0.5 ? 1 : -1; return; }
      p.x += dx / d * sp * dt; p.y += dy / d * sp * dt; p.h = Math.atan2(dy, dx); return;
    }
    if (S === "waiting at the crossing") {
      const X = p.X; p.timer += dt;
      const red = X.sig && this.edgeGreen(X.ei), carNear = this.carNear(X.x, X.y, 22);
      if (!red && !carNear) return this.startCross(p, X, "crossing");
      if (red && !carNear && p.timer > 4 && Math.random() < CONFIG.redCrossChance * dt) return this.startCross(p, X, "crossing on red");
      return;
    }
    // walking along a sidewalk
    const w = p.w; p.s += p.dir * p.v * dt;
    const q = posAt(w, p.s); p.x = q.x; p.y = q.y; p.h = q.h + (p.dir < 0 ? Math.PI : 0);
    for (const [cs, X, side] of w.cross) if (Math.abs(cs - p.s) < 0.5 && p.lastX !== X && Math.random() < 0.45) {
      p.lastX = X; p.X = X; p.side = side; p.state = "waiting at the crossing"; p.timer = 0; return;
    }
    if (Math.random() < CONFIG.jaywalkPerMin / 60 * dt * (this.d.key === "novejulho" ? 2 : 1)) {
      const other = this.walks.find(o => o.ei === w.ei && o !== w); if (other && !this.carNear(p.x, p.y, 30)) { const n = nearestOn(other, p.x, p.y); p.to = [n.x, n.y]; p.toW = other; p.toS = n.s; p.state = "jaywalking"; return; }
    }
    if (p.s < 0 || p.s > w.len) {
      const end = p.s < 0 ? 0 : 1, links = w.links[end];
      if (links.length && Math.random() < 0.9) { const [w2, e2] = pick(links); p.w = w2; p.s = e2 ? w2.len : 0; p.dir = e2 ? -1 : 1; }
      else { p.dir *= -1; p.s = clamp(p.s, 0, w.len); }
    }
    return this.offMap(p);
  }
  startCross(p, X, st) { const T = p.side ? X.A : X.B; p.to = [T[2], T[3]]; p.toW = T[0]; p.toS = T[1]; p.state = st; }
  carNear(x, y, r) { for (const v of this.vehicles) if (v.path && v.v > 1 && hyp(v.x - x, v.y - y) < r) return true; return false; }
  offMap(p) { const M = this.half + 15; if (Math.abs(p.x) > M || Math.abs(p.y) > M) { p.alpha -= 0.05; if (p.alpha <= 0) p.dead = true; } }

  // ---------- pursuit ----------
  startPursuit() {
    this.clearScripted(); this.heat = this.heat || 2;
    const ents = this.entries.filter(L => L.l.t === "g" && this.good.has(L)); if (!ents.length) return;
    const tL = pick(ents);
    this.target = this.spawnVehicle("car", tL, {kind: "target", pers: "aggressive", col: "#ff5a3c", scripted: true, s: 25, alpha: 1});
    if (!this.target) return;
    this.target.state = "fleeing the pursuing party"; this.target.flee = 2;
    this.pursuers = [];
    this.addPursuer("chaser", tL, 2);
    this.lastSeen = null; this.say("A pursuing party picks up the target car. Heat level " + this.heat + ".");
    this.applyHeat();
  }
  addPursuer(role, L, s) {
    L = L || pick(this.entries.filter(E => E.l.t === "g")); if (!L) return;
    const u = this.spawnVehicle("car", L, {kind: "pursuer", pers: "aggressive", col: "#1b2028", scripted: true, s: s || 1, alpha: 0, role, state: role === "chaser" ? "chasing" : role});
    if (u) { u.len = 4.9; u.wid = 2.0; u.followRoute = true; this.pursuers.push(u); }
    return u;
  }
  applyHeat() {
    if (!this.target) return;
    const want = {1: 1, 2: 1, 3: 2, 4: 3, 5: 3}[this.heat];
    while (this.pursuers.filter(p => !p.dead).length < want) this.addPursuer(this.pursuers.length === 1 ? "interceptor" : "boxing in");
    this.roadblock = this.heat >= 4; this.spikes = this.heat >= 5;
  }
  stepPursuit(dt) {
    const T = this.target; if (!T) return;
    if (T.dead) { this.say(this.lost ? "The target got away: the pursuing party gives up and rejoins traffic." : "The target left the area. A new chase starts."); this.pursuers.forEach(p => { p.kind = "car"; p.scripted = false; p.state = "returning to traffic"; p.route = null; p.col = "#1b2028"; p.unit = true; }); this.target = null; this.lost = false; setTimeout(() => this.scenario === "pursuit" && this.startPursuit(), 2500); return; }
    // the target keeps a planned path a few hops ahead (this is what interceptors predict)
    if (!T.plan || !T.plan.includes(T.path)) { T.plan = [T.path]; let p = T.path; for (let k = 0; k < 6; k++) { const n = p.kind === "L" ? (k ? this.chooseNext({path: p, kind: "car"}) : T.nextC || this.chooseNext(T)) : p.to; if (!n) break; T.plan.push(n); p = n; } T.route = T.plan; }
    this.replan = (this.replan || 0) - dt;
    const seen = this.pursuers.some(p => !p.dead && hyp(p.x - T.x, p.y - T.y) < CONFIG.pursuitLoseDist);
    if (seen) { this.lastSeen = [T.path, T.s, this.simT]; this.lost = false; }
    else if (this.lastSeen && this.simT - this.lastSeen[2] > CONFIG.giveUpSeconds) { this.lost = true; }
    if (this.replan < 0) {
      this.replan = 0.8;
      for (const u of this.pursuers) {
        if (u.dead || u.path.kind !== "L" && u.route) continue;
        let goal = seen ? [T.path, T.s] : this.lastSeen;
        u.state = seen ? (u.role === "chaser" ? "chasing" : u.role) : "searching last known position";
        if (u.role !== "chaser" && seen && T.plan.length > 3) { const g = T.plan.slice(2).find(p => p.kind === "L"); if (g) goal = [g, g.len * 0.6]; u.state = u.role === "interceptor" ? "intercepting ahead" : "boxing in"; }
        const st = u.path.kind === "L" ? u.path : u.path.to;
        const r = goal && this.route(st, u.path.kind === "L" ? u.s : 0, goal[0].kind === "L" ? goal[0] : goal[0].to, goal[1] || 0, {pursuer: true});
        if (r) { u.route = r.paths; u.goal = goal; } else u.route = null;
        if (this.lost) u.state = "giving up";
      }
      if (this.lost) { this.pursuers.forEach(p => { p.kind = "car"; p.scripted = false; p.route = null; p.unit = true; p.state = "giving up"; }); this.target.kind = "car"; this.target.flee = 0; this.target.state = "escaped"; this.target.scripted = false; this.target = null; this.say("Out of sight too long: the pursuing party loses the target and gives up."); setTimeout(() => this.scenario === "pursuit" && this.startPursuit(), 3500); return; }
    }
    for (const u of this.pursuers) {
      if (u.dead || !u.route) continue;
      // ramming / contact
      if (this.heat >= 2 && hyp(u.x - T.x, u.y - T.y) < 5.5 && u.v > T.v) { T.v *= 0.7; if (!T._rammed || this.simT - T._rammed > 4) { T._rammed = this.simT; this.say("Ramming: the chaser bumps the target to slow it down."); } }
      // siren-equivalent: horn bursts and strobes clear the way ahead
      if (Math.random() < dt * 0.5) this.emit("horn", u.x, u.y, {by: "pursuer"});
    }
    // roadblock at heat 4+, spike strip at heat 5
    if (this.roadblock && !this.block) {
      const g = T.plan && T.plan.slice(3).find(p => p.kind === "L" && p.len > 40);
      if (g) { const q = posAt(g, g.len * 0.55); this.block = {L: g, s: g.len * 0.55, x: q.x, y: q.y, h: q.h, until: this.simT + 25}; this.say("Roadblock set up where the target is predicted to go."); }
    }
    if (this.block && this.simT > this.block.until) this.block = null;
    if (this.spikes && !this.spike && this.block) { this.spike = {...this.block, s: Math.max(0, this.block.s - 18)}; Object.assign(this.spike, posAt(this.block.L, this.spike.s)); }
    if (this.spike && T.path === this.spike.L && Math.abs(T.s - this.spike.s) < 2 && !T.flat) { T.flat = true; this.say("Spike strip: the target's tyres are gone, it slows right down."); }
    if (T.flat) T.v = Math.min(T.v, 5);
    if (!this.block) this.spike = null;
  }
  followRoute(u) { // lane changes in a route happen by moving across to the neighbour lane
    if (!u.route || u.path.kind !== "L") return;
    const i = u.route.indexOf(u.path), n = u.route[i + 1];
    if (n && n.kind === "L" && n.l.e === u.path.l.e && n !== u.path) {
      if (u.kind !== "pursuer" && (u.s < 6 || n.agents.some(w => Math.abs(w.s - u.s) < 8))) return;
      const ns = clamp(u.s / u.path.len * n.len, 0, n.len - 1), left = n.i === u.path.l.l;
      u.path.agents.splice(u.path.agents.indexOf(u), 1); n.agents.push(u); u.lat = left ? -u.path.w : u.path.w; u.latT = 0; u.path = n; u.s = ns; u.nextC = null; u.lc = 1.4;
      if (u.kind === "gps") u.state = "changing lanes for the next turn";
    } else if (n && n.kind === "C") u.nextC = n;
  }
  clearScripted() {
    for (const v of this.vehicles) if (v.kind === "target" || v.kind === "pursuer" || v.kind === "gps" || v.unit) { v.dead = true; }
    this.target = null; this.pursuers = []; this.block = null; this.spike = null;
  }

  // ---------- main step ----------
  step(dt) {
    this.simT += dt; this.t += dt;
    // pedestrian grid
    this.grid = new Map();
    for (const p of this.peds) { const k = Math.floor(p.x / 8) + "," + Math.floor(p.y / 8); let a = this.grid.get(k); if (!a) this.grid.set(k, a = []); a.push(p); }
    // pursuing parties: traffic ahead pulls over
    for (const v of this.vehicles) {
      v.pullOver = false;
      if (!v.path || v.kind !== "car" && v.kind !== "bus" && v.kind !== "moto" || v.flee || v.unit) continue;
      for (const u of this.pursuers || []) if (!u.dead && u.kind === "pursuer") { const d = hyp(u.x - v.x, u.y - v.y), behind = Math.cos(Math.atan2(v.y - u.y, v.x - u.x) - u.h); if (d < 45 && behind > 0.5) v.pullOver = true; }
      // roadblock acts as a stopped obstacle
      if (this.block && v.path === this.block.L && this.block.s - v.s > 0 && this.block.s - v.s < 30) v.slowUntil = this.simT + 0.5;
    }
    if (this.block) { const T = this.target; if (T && T.path === this.block.L && this.block.s - T.s > 0 && this.block.s - T.s < 9) T.v = Math.min(T.v, 2); }
    for (const v of this.vehicles) this.stepVehicle(v, dt);
    const split = this.vehicles.filter(v => v.splitting && v.state !== "down");
    if (split.length && Math.random() < CONFIG.motoCrashPerHour / 3600 * dt * (this.crashBoost || 1)) this.crashMoto(pick(split));
    for (const u of this.vehicles) if (u.followRoute && !u.dead) this.followRoute(u);
    for (const p of this.peds) this.stepPed(p, dt);
    if (this.scenario === "pursuit") this.stepPursuit(dt);
    if (this.gpsCar && !this.gpsCar.dead && this.gpsCar.path === this.gps?.paths.at(-1) && this.gpsCar.s >= this.gps.toS) { this.gpsCar.dead = true; this.say("Arrived at your destination."); }
    this.vehicles = this.vehicles.filter(v => { if (v.dead || v.alpha < 0) { if (v.path) { const i = v.path.agents.indexOf(v); if (i >= 0) v.path.agents.splice(i, 1); if (v.path.occ === v) v.path.occ = null; } if (v === this.gpsCar) this.gpsCar = null; return false; } return true; });
    this.peds = this.peds.filter(p => !p.dead);
    this.events = this.events.filter(e => this.simT - e.t0 < e.life);
    this.populate();
  }

  // ---------- GPS ----------
  nearLanes(x, y, k) {
    return this.drive.filter(L => L.l.t === "g" && (L.inC.length || L.outC.length)).map(L => ({L, ...nearestOn(L, x, y)})).sort((a, b) => a.d - b.d).slice(0, k);
  }
  planGps(a, b) {
    const As = this.nearLanes(a[0], a[1], 8), Bs = this.nearLanes(b[0], b[1], 8);
    if (!As.length || !Bs.length || As[0].d > 45 || Bs[0].d > 45) return null;
    let r = null, A, B;
    outer: for (const a1 of As) for (const b1 of Bs) { if (a1.d > As[0].d + 25 || b1.d > Bs[0].d + 25) continue; r = this.route(a1.L, a1.s, b1.L, b1.s, {civil: true}); if (r) { A = a1; B = b1; break outer; } }
    if (!r) return {fail: true};
    const paths = r.paths, steps = [];
    const nm = L => this.name(L.e.n) || "unnamed road";
    const p0 = posAt(A.L, A.s);
    steps.push({at: 0, en: `Head ${bearingName(p0.h)} on ${nm(A.L)}`, pt: `Siga pela ${nm(A.L)}, sentido ${bearingName(p0.h, true)}`, x: p0.x, y: p0.y});
    let dist = -A.s, lanesAdvice = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i], n = paths[i + 1];
      if (p.kind === "L" && n && n.kind === "L" && n.l.e === p.l.e) { // lane change
        const left = n.i === p.l.l, q = posAt(p, p.len * 0.5), last = steps[steps.length - 1];
        if (last.lc && last.left === left) { last.k++; last.en = `Move ${last.k} lanes ${left ? "left" : "right"}`; last.pt = `Passe ${last.k} faixas para a ${left ? "esquerda" : "direita"}`; continue; }
        steps.push({at: dist + p.len * 0.5, en: `Move into the ${left ? "left" : "right"} lane`, pt: `Mude para a faixa da ${left ? "esquerda" : "direita"}`, x: q.x, y: q.y, lc: true, left, k: 1});
        continue;
      }
      if (p.kind === "C") {
        const tu = p.c.tu, to = p.to, from = p.from, sameName = to.e.n === from.e.n;
        // lane choice: every lane of this approach that can make the same move
        const sib = this.drive.filter(L => L.l.e === from.l.e && L.l.d === from.l.d && L.l.t === "g");
        const okL = sib.filter(L => L.outC.some(ci => this.conns[ci].c.tu === tu && this.conns[ci].to.l.e === to.l.e));
        lanesAdvice.push({lanes: okL, all: sib});
        const toRb = to.e.rb, fromRb = from.e.rb, unnamed = to.e.n < 0;
        if (toRb && !fromRb) { const q = posAt(p, 0); steps.push({at: dist, en: "Enter the roundabout and give way to traffic already on it", pt: "Entre na rotatória dando preferência a quem já está nela", x: q.x, y: q.y, tu}); }
        else if (fromRb && !toRb) { const q = posAt(p, 0); steps.push({at: dist, en: `Exit the roundabout onto ${nm(to)}`, pt: `Saia da rotatória na ${nm(to)}`, x: q.x, y: q.y, tu}); }
        else if (!toRb && !unnamed && (tu !== "through" || !sameName)) {
          const q = posAt(p, 0), k = okL.length, n2 = sib.length;
          let laneEn = "", lanePt = "";
          if (n2 > 1 && k && k < n2) { const leftSide = okL.every(L => L.l.i < n2 / 2) ; laneEn = ` (use the ${k === 1 ? "" : k + " "}${leftSide ? "left" : "right"} lane${k > 1 ? "s" : ""})`; lanePt = ` (use ${k === 1 ? "a faixa" : "as " + k + " faixas"} da ${leftSide ? "esquerda" : "direita"})`; }
          const cap = x => x[0].toUpperCase() + x.slice(1);
          const en = tu === "through" ? `Continue onto ${nm(to)}` : sameName ? `${cap(TURN_EN[tu])} to stay on ${nm(to)}` : `${cap(TURN_EN[tu])} onto ${nm(to)}`;
          const pt = tu === "through" ? `Continue na ${nm(to)}` : sameName ? `${cap(TURN_PT[tu])} para continuar na ${nm(to)}` : `${cap(TURN_PT[tu])} na ${nm(to)}`;
          steps.push({at: dist, en: en + laneEn, pt: pt + lanePt, x: q.x, y: q.y, tu});
        }
      }
      dist += p.len;
    }
    const pe = posAt(B.L, B.s);
    steps.push({at: dist - (B.L.len - B.s), en: "Arrive at your destination", pt: "Você chegou ao destino", x: pe.x, y: pe.y});
    // distances between prompts, the way the game will say them
    for (let i = 1; i < steps.length; i++) { const m = Math.max(0, steps[i].at - steps[i - 1].at); steps[i].m = m < 1000 ? Math.round(m / 10) * 10 : (m / 1000).toFixed(1) + " km"; }
    return {paths, steps, A, B, toS: B.s, lanesAdvice, len: Math.round(dist - (B.L.len - B.s))};
  }
}
