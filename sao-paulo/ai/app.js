import {World, CONFIG} from "./sim.js";
"use strict";
const $ = id => document.getElementById(id);
const cv = $("cv"), ctx = cv.getContext("2d"), small = matchMedia("(max-width: 760px)").matches;
let W = null, sections = [], cur = null, playing = true, speed = 1, scen = "traffic", overlay = {perc: false, route: true, lanes: false, sig: false, state: false};
let cam = {x: 0, y: 0, k: 1}, dpr = 1, vw = 0, vh = 0, staticCanvas = null, staticKey = "", gpsPts = [], gps = null, sel = null, visible = true, lastT = 0, acc = 0, panicType = "explosion", lang = "en";
const DATA = "data/";

// ---------- copy for players ----------
const SCEN_TEXT = {
  traffic: {h: "Everyday traffic", p: [
    "Every car reads the same lane map the game uses: which way each lane goes, how many lanes there are, which turns are allowed from which lane, and where the signals and PARE signs are.",
    "Drivers keep a safe gap to the car ahead and slow smoothly. At junctions they follow the signal, stop fully at PARE signs, give way on roundabouts and, at unmarked crossings, yield to the car on the right, like the Brazilian traffic code says.",
    "Each driver has a personality: calm, normal, aggressive (shorter gaps, goes on amber, changes lanes more) or distracted (slow to react when the light turns green).",
    "Motorcycles ride the corredor between lanes when traffic is slow and filter to the front at red lights. Now and then one goes down while lane-splitting; it clears in a few seconds.",
    "Pedestrians walk the sidewalks, wait for the walk signal at crosswalks (a few cross on red when the road is clear), wait at bus stops and board buses. In normal traffic, drivers always brake for people."]},
  pursuit: {h: "Pursuit", p: [
    "A pursuing party (unmarked dark cars with white and amber strobes and an air horn) chases the orange target car. They plan their route on the same lane map as everyone else, but they are allowed to ignore signals and bus lanes.",
    "The chaser follows the target. The interceptor works out where the target is likely to go a few streets ahead and heads there instead. Turn the heat up and you get boxing-in, a roadblock on the predicted route and, at the top level only, a spike strip.",
    "Traffic ahead of the pursuing party pulls over to the right and slows, which also gets in the target's way.",
    "If the pursuing party loses sight of the target for too long, it searches the last place it was seen, then gives up and rejoins normal traffic."]},
  panic: {h: "Panic", p: [
    "Tap anywhere on the map to set off an event: an explosion, shots fired or a car fire. Each one is heard within a different radius (shown with “perception” on).",
    "People inside that radius run away from it. Anyone who sees someone running nearby may start running too, so panic spreads through a crowd, then fades as people calm down and walk back to the sidewalk.",
    "Drivers react too. Some stop and wait, some speed away and run red lights, and the most panicked turn around and drive the wrong way or go up onto the sidewalk to get around stopped traffic.",
    "Only in this kind of chaos can a car knock someone down. It's shown as a fall, then the person gets up and limps away."]},
  gps: {h: "GPS", p: [
    "Tap a start point, then a destination. The route is worked out on the lane map, so it never goes the wrong way down a one-way street and only makes turns that are legal from each lane.",
    "Before each turn it tells you which lanes to be in (the highlighted lanes), the same way the game's prompts will, in Portuguese and English.",
    "A white car then drives the route so you can watch the lane changes happen before each turn. In the game the route is drawn on the road in front of you and recalculates if you miss a turn."]},
};

// ---------- loading ----------
async function loadIndex() {
  sections = await (await fetch(DATA + "sections.json")).json();
  $("secs").innerHTML = sections.map(s => `<button class="chip" data-k="${s.key}" aria-pressed="false"><b>${s.title}</b><small>${s.bairro}</small></button>`).join("");
  $("secs").onclick = e => { const b = e.target.closest("button"); if (b) loadSection(b.dataset.k); };
  const k = new URLSearchParams(location.search).get("s");
  await loadSection(sections.find(s => s.key === k) ? k : sections[0].key);
}
async function loadSection(k) {
  const d = await (await fetch(DATA + k + ".json")).json();
  cur = sections.find(s => s.key === k);
  [...$("secs").children].forEach(b => b.setAttribute("aria-pressed", b.dataset.k === k));
  const t = W ? W.t : (Number($("tod").value) || 8) * 3600, dens = W ? W.density : 1;
  W = new World(d); W.small = small; W.t = t; W.density = dens;
  if (small) { CONFIG.maxVehicles = 45; CONFIG.maxPeds = 80; }
  // warm up so the section is already busy
  for (let i = 0; i < 30 * 25; i++) W.step(1 / 30);
  W.vehicles.forEach(v => v.alpha = 1); W.peds.forEach(p => p.alpha = 1);
  $("secname").textContent = d.title; $("secsub").textContent = `${d.bairro} · ${d.sub} · tile ${d.tile}`;
  fit(); staticKey = ""; gpsPts = []; gps = null; sel = null; renderGps();
  setScenario(scen, true);
}
function setScenario(s, quiet) {
  scen = s; W.scenario = s;
  [...$("scens").children].forEach(b => b.setAttribute("aria-pressed", b.dataset.s === s));
  W.clearScripted(); gpsPts = []; gps = null; W.gps = null; renderGps(); W.calmAll();
  $("panicbar").hidden = s !== "panic"; $("heatbar").hidden = s !== "pursuit"; $("gpsbar").hidden = s !== "gps";
  if (s === "pursuit") { W.heat = Number($("heat").value); W.startPursuit(); overlay.route = true; }
  if (s === "gps") { overlay.lanes = true; }
  syncOverlayButtons();
  const T = SCEN_TEXT[s]; $("explain").innerHTML = `<h3>${T.h}</h3>` + T.p.map(x => `<p>${x}</p>`).join("");
  $("hint").textContent = {traffic: "Tap a car, bike or person to see what it's thinking.", pursuit: "Raise the heat to see interceptors, a roadblock and spikes.", panic: "Tap the map to set off the event.", gps: "Tap a start point, then a destination."}[s];
}

// ---------- camera ----------
function resize() {
  const r = cv.getBoundingClientRect(); dpr = Math.min(2, devicePixelRatio || 1);
  vw = r.width; vh = r.height; cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr); staticKey = "";
}
function fit() { if (!W) return; cam.x = 0; cam.y = 0; cam.k = Math.min(vw, vh) / (2 * W.half) * (vw < 600 ? 1.7 : 1.02); staticKey = ""; }
const toS = (x, y) => [(x - cam.x) * cam.k + vw / 2, -(y - cam.y) * cam.k + vh / 2];
const toW = (sx, sy) => [(sx - vw / 2) / cam.k + cam.x, -(sy - vh / 2) / cam.k + cam.y];

// ---------- static layer (roads, markings, names) ----------
function poly(c, pts) { c.beginPath(); pts.forEach((p, i) => { const [x, y] = toS(p[0], p[1]); i ? c.lineTo(x, y) : c.moveTo(x, y); }); }
function offset(pts, off) { const out = []; for (let i = 0; i < pts.length; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; out.push([pts[i][0] - dy / L * off, pts[i][1] + dx / L * off]); } return out; }
function drawStatic() {
  const key = [cam.x, cam.y, cam.k, vw, vh, W.d.key, night()].join();
  if (key === staticKey) return; staticKey = key;
  if (!staticCanvas) staticCanvas = document.createElement("canvas");
  staticCanvas.width = cv.width; staticCanvas.height = cv.height;
  const c = staticCanvas.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = night(), d = W.d, k = cam.k;
  c.fillStyle = n ? "#070b11" : "#151d28"; c.fillRect(0, 0, vw, vh);
  // blocks hint: faint grid
  c.strokeStyle = n ? "rgba(255,255,255,.025)" : "rgba(255,255,255,.035)"; c.lineWidth = 1;
  for (let g = -400; g <= 400; g += 50) { let [a, b] = toS(g, -400), [e, f] = toS(g, 400); c.beginPath(); c.moveTo(a, b); c.lineTo(e, f); c.stroke(); [a, b] = toS(-400, g); [e, f] = toS(400, g); c.beginPath(); c.moveTo(a, b); c.lineTo(e, f); c.stroke(); }
  c.lineCap = "round"; c.lineJoin = "round";
  // sidewalks then asphalt
  for (const e of d.edges) if (!/motorway|trunk/.test(e.c)) { poly(c, e.pts); c.strokeStyle = n ? "#262d38" : "#3a4555"; c.lineWidth = (e.w + 7.5) * k; c.stroke(); }
  for (const e of d.edges) { poly(c, e.pts); c.strokeStyle = e.br ? "#3a3f48" : n ? "#1b2029" : "#252c37"; c.lineWidth = Math.max(e.w * k, 1.5); c.stroke(); }
  for (const C of W.conns) { poly(c, C.pts); c.strokeStyle = n ? "#1b2029" : "#252c37"; c.lineWidth = Math.max(C.from.w * k, 1.2); c.stroke(); }
  // bus lanes (faixa exclusiva) tinted red, parking strips darker
  for (const L of W.lanes) if (L.l.t === "b") { poly(c, L.pts); c.strokeStyle = "rgba(196,58,44,.42)"; c.lineWidth = L.w * k * 0.95; c.stroke(); }
  for (const L of W.lanes) if (L.l.t === "p") { poly(c, L.pts); c.strokeStyle = "rgba(0,0,0,.18)"; c.lineWidth = L.w * k * 0.9; c.stroke(); }
  if (k > 1.1) {
    // lane separators: dashed white between same-direction lanes, double yellow between directions
    c.setLineDash([3 * k, 4.5 * k]); c.strokeStyle = "rgba(235,240,245,.55)"; c.lineWidth = Math.max(0.15 * k, 0.7);
    for (const L of W.lanes) if (L.l.r >= 0 && L.l.t !== "p") { poly(c, offset(L.pts, -L.w / 2)); c.stroke(); }
    c.setLineDash([]);
    for (const e of d.edges) if (!e.ow && e.w > 6) { poly(c, e.pts); c.strokeStyle = "rgba(240,190,60,.7)"; c.lineWidth = Math.max(0.3 * k, 0.8); c.stroke(); }
    // stop lines
    c.strokeStyle = "rgba(240,244,248,.85)"; c.lineWidth = Math.max(0.4 * k, 1);
    for (const s of d.stops) { poly(c, s.pts); c.stroke(); }
    // crosswalks (zebra)
    for (const X of d.cross) {
      const e = d.edges[X.e]; let best = null;
      for (let i = 1; i < e.pts.length; i++) { const a = e.pts[i - 1], b = e.pts[i], dd = Math.hypot((a[0] + b[0]) / 2 - X.x, (a[1] + b[1]) / 2 - X.y); if (!best || dd < best[0]) best = [dd, Math.atan2(b[1] - a[1], b[0] - a[0])]; }
      const h = best[1], len = e.w, [sx, sy] = toS(X.x, X.y);
      c.save(); c.translate(sx, sy); c.rotate(-h); c.fillStyle = "rgba(240,244,248,.75)";
      for (let t = -len / 2 + 0.3; t < len / 2; t += 1.0) c.fillRect(-1.6 * k, -(t + 0.5) * k, 3.2 * k, 0.5 * k);
      c.restore();
    }
    // lane arrows at lane ends
    c.fillStyle = "rgba(240,244,248,.6)";
    for (const L of W.lanes) if (L.l.t !== "p" && L.len > 25 && L.l.tu.length) { const q = posA(L, L.len - 7); arrow(c, q, L.l.tu, k); }
  } else {
    for (const e of d.edges) if (!e.ow && e.w > 6) { poly(c, e.pts); c.strokeStyle = "rgba(240,190,60,.35)"; c.lineWidth = 0.8; c.stroke(); }
  }
  // parked cars
  for (const p of W.parked) car(c, p.x, p.y, p.h, 4.3, 1.8, p.c, 1);
  // bus stops
  for (const b of W.busStops) { const [x, y] = toS(b.x, b.y), r = Math.max(2.4 * k, 6); c.fillStyle = "#1d57c2"; c.strokeStyle = "#fff"; c.lineWidth = 1.2; c.beginPath(); c.roundRect(x - r, y - r, 2 * r, 2 * r, 2); c.fill(); c.stroke(); c.fillStyle = "#fff"; c.font = `800 ${Math.round(r * 1.2)}px "Public Sans",sans-serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("B", x, y + 0.5); }
  // street name plates (São Paulo blue)
  c.font = `700 ${clampN(3.2 * k, 9, vw < 600 ? 10 : 13)}px "Public Sans",sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
  const placed = [];
  for (const L of [...W.labels].sort((a, b) => b.len - a.len)) {
    const [x, y] = toS(L.x, L.y); if (x < -50 || y < -20 || x > vw + 50 || y > vh + 20) continue;
    const t = abbrev(L.text), w = c.measureText(t).width + 10, hgt = clampN(3.2 * k, 9, vw < 600 ? 10 : 13) + 6;
    let a = -L.h; if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI;
    if (placed.some(p => Math.hypot(p[0] - x, p[1] - y) < 60)) continue; placed.push([x, y]);
    c.save(); c.translate(x, y); c.rotate(a); c.fillStyle = "#1d57c2"; c.strokeStyle = "#fff"; c.lineWidth = 1.2;
    c.beginPath(); c.roundRect(-w / 2, -hgt / 2, w, hgt, 3); c.fill(); c.stroke(); c.fillStyle = "#fff"; c.fillText(t, 0, 0.5); c.restore();
  }
}
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function abbrev(t) { return t.replace(/^Avenida /, "Av. ").replace(/^Rua /, "R. ").replace(/^Alameda /, "Al. ").replace(/^Travessa /, "Tv. ").replace(/^Praça /, "Pça. ").replace(/^Viaduto /, "Vd. ").replace(/^Ponte /, "Pte. ").toUpperCase(); }
function posA(p, s) { s = Math.max(0, Math.min(p.len, s)); let i = 1; while (i < p.cum.length - 1 && p.cum[i] < s) i++; const a = p.pts[i - 1], b = p.pts[i], t = (s - p.cum[i - 1]) / ((p.cum[i] - p.cum[i - 1]) || 1); return {x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, h: Math.atan2(b[1] - a[1], b[0] - a[0])}; }
function arrow(c, q, turns, k) {
  const [x, y] = toS(q.x, q.y); c.save(); c.translate(x, y); c.rotate(-q.h); const s = k * 0.55;
  c.beginPath(); c.moveTo(-3 * s, 0); c.lineTo(1.5 * s, 0); c.lineWidth = Math.max(0.5 * s, 0.8); c.strokeStyle = c.fillStyle; c.stroke();
  for (const t of turns) {
    const ang = t === "left" ? Math.PI / 2 : t === "right" ? -Math.PI / 2 : t === "uturn" ? null : 0; if (ang === null) continue;
    c.save(); c.translate(1.5 * s, 0); c.rotate(-ang); c.beginPath(); c.moveTo(ang ? 0 : 0, 0); c.lineTo(ang ? 2.2 * s : 0.01, 0); c.stroke();
    c.beginPath(); c.moveTo(3.2 * s, 0); c.lineTo(1.8 * s, -1.1 * s); c.lineTo(1.8 * s, 1.1 * s); c.fill(); c.restore();
  }
  c.restore();
}
function car(c, wx, wy, h, len, wid, col, alpha, min = 3) {
  const [x, y] = toS(wx, wy), k = cam.k, L = Math.max(len * k, min * len / 4.5), Wd = Math.max(wid * k, min * 0.42 * wid / 1.85);
  c.save(); c.globalAlpha = alpha; c.translate(x, y); c.rotate(-h); c.fillStyle = col; c.beginPath(); c.roundRect(-L / 2, -Wd / 2, L, Wd, Math.min(Wd / 3, 2.5)); c.fill();
  if (L > 7) { c.fillStyle = "rgba(10,20,30,.55)"; c.fillRect(L * 0.08, -Wd / 2 + Wd * 0.14, L * 0.18, Wd * 0.72); }
  c.restore();
}

// ---------- frame ----------
function night() { const h = (W.t / 3600) % 24; return h < 6 || h >= 19; }
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0); drawStatic(); ctx.drawImage(staticCanvas, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = cam.k, n = night();
  // signal heads
  for (const L of W.lanes) if (L.sig && L.l.t !== "p") {
    const st = W.sigState(L), q = posA(L, L.len), [x, y] = toS(q.x, q.y), r = Math.max(0.9 * k, 2.6);
    ctx.fillStyle = st === "g" ? "#36c483" : st === "y" ? "#f0b43a" : "#ef5d4f"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    if (overlay.sig) { ctx.strokeStyle = ctx.fillStyle; ctx.globalAlpha = 0.35; ctx.lineWidth = L.w * k * 0.8; poly(ctx, L.pts.slice(-2)); ctx.stroke(); ctx.globalAlpha = 1; }
  }
  if (overlay.sig) for (const s of W.sigs) { // phase clock
    const [x, y] = toS(s.node.x, s.node.y), tt = ((W.t + s.o) % s.cy + s.cy) % s.cy, r = Math.max(4 * k, 9);
    ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    ctx.strokeStyle = "#ffd36b"; ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + tt / s.cy * Math.PI * 2); ctx.stroke();
  }
  // GPS route + lane choice
  if (gps && !gps.fail) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (overlay.lanes) for (const a of gps.lanesAdvice) for (const L of a.all) { const ok = a.lanes.includes(L); poly(ctx, L.pts.slice(-3)); ctx.strokeStyle = ok ? "rgba(54,196,131,.55)" : "rgba(239,93,79,.28)"; ctx.lineWidth = L.w * k * 0.8; ctx.stroke(); }
    ctx.strokeStyle = "rgba(29,87,194,.9)"; ctx.lineWidth = Math.max(1.6 * k, 4);
    for (const p of gps.paths) { poly(ctx, p.pts); ctx.stroke(); }
    gps.steps.forEach((s, i) => { const [x, y] = toS(s.x, s.y); ctx.fillStyle = i === 0 ? "#36c483" : i === gps.steps.length - 1 ? "#ec4a3c" : "#fff"; ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill(); ctx.fillStyle = "#0a1830"; ctx.font = "800 10px 'Public Sans',sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(i === 0 ? "A" : i === gps.steps.length - 1 ? "B" : i, x, y + 0.5); });
  }
  for (const p of gpsPts) { const [x, y] = toS(p[0], p[1]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke(); }
  // routes of pursuing parties
  if (overlay.route && W.pursuers) for (const u of W.pursuers) if (!u.dead && u.route) { ctx.strokeStyle = u.role === "chaser" ? "rgba(255,211,107,.7)" : "rgba(159,214,255,.7)"; ctx.setLineDash([6, 5]); ctx.lineWidth = 2; for (const p of u.route) { poly(ctx, p.pts); ctx.stroke(); } ctx.setLineDash([]); }
  if (overlay.route && sel && sel.path && !sel.dead) { const ps = [sel.path]; if (sel.nextC) ps.push(sel.nextC, sel.nextC.to); ctx.strokeStyle = "rgba(255,211,107,.8)"; ctx.lineWidth = 2.5; ctx.setLineDash([5, 4]); for (const p of ps) { poly(ctx, p.pts); ctx.stroke(); } ctx.setLineDash([]); }
  if (W.block) { car(ctx, W.block.x, W.block.y, W.block.h + Math.PI / 2, 4.9, 2, "#1b2028", 1, 9); strobe(W.block.x, W.block.y, 1); }
  if (W.spike) { const [x, y] = toS(W.spike.x, W.spike.y); ctx.save(); ctx.translate(x, y); ctx.rotate(-W.spike.h + Math.PI / 2); ctx.fillStyle = "#c0c6cf"; ctx.fillRect(-3.5 * k, -0.3 * k, 7 * k, 0.6 * k); ctx.restore(); }
  // events: perception radius + effects
  for (const e of W.events) {
    const [x, y] = toS(e.x, e.y), age = W.simT - e.t0;
    if (e.type === "horn") { if (overlay.perc) { ctx.strokeStyle = "rgba(255,211,107,.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, e.r * k * Math.min(1, age * 2), 0, 7); ctx.stroke(); } continue; }
    if (overlay.perc || age < 1.2) { ctx.strokeStyle = e.type === "crash" ? "rgba(240,180,58,.5)" : "rgba(239,93,79,.55)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(x, y, e.r * k * Math.min(1, age * 1.6), 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    if (e.type === "explosion" && age < 1.5) { const g = ctx.createRadialGradient(x, y, 0, x, y, 30 * k * (0.3 + age)); g.addColorStop(0, `rgba(255,230,160,${1 - age / 1.5})`); g.addColorStop(1, "rgba(255,90,40,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 30 * k * (0.3 + age), 0, 7); ctx.fill(); }
    if (e.type === "shots" && (age % 0.9) < 0.15) { ctx.fillStyle = "#ffd36b"; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
  }
  // vehicles
  for (const v of W.vehicles) {
    if (v.x === undefined) continue;
    if (v.kind === "wreck") { car(ctx, v.x, v.y, v.h, v.len, v.wid, "#2a2a2a", v.alpha); if (v.state === "burning") fire(v.x, v.y, v.alpha); continue; }
    const col = overlay.state && (v.kind === "car" || v.kind === "moto") ? v.P.col : v.col;
    if (n && v.alpha > 0.5) { const [x, y] = toS(v.x, v.y); const g = ctx.createRadialGradient(x + Math.cos(-v.h) * 9 * k, y + Math.sin(-v.h) * 9 * k, 0, x + Math.cos(-v.h) * 9 * k, y + Math.sin(-v.h) * 9 * k, 10 * k); g.addColorStop(0, "rgba(255,240,200,.22)"); g.addColorStop(1, "rgba(255,240,200,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x + Math.cos(-v.h) * 9 * k, y + Math.sin(-v.h) * 9 * k, 10 * k, 0, 7); ctx.fill(); }
    car(ctx, v.x, v.y, v.h, v.len, v.wid, col, v.alpha, v.kind === "pursuer" || v.kind === "target" || v.kind === "gps" ? 6 : 3.5);
    if (v.kind === "moto") { const [x, y] = toS(v.x, v.y); ctx.fillStyle = "#1d2735"; ctx.beginPath(); ctx.arc(x, y, Math.max(0.35 * k, 1.3), 0, 7); ctx.fill(); }
    if (v.kind === "pursuer" || v.unit && W.simT % 1 < 0.5 && v.state !== "giving up") strobe(v.x, v.y, v.alpha);
    if (v.kind === "target" || v.kind === "pursuer" || v.kind === "gps") { const [x, y] = toS(v.x, v.y); ctx.strokeStyle = v.kind === "target" ? "#ff5a3c" : v.kind === "gps" ? "#fff" : "#9fd6ff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, Math.max(4 * k, 9), 0, 7); ctx.stroke(); }
    if (v === sel) { const [x, y] = toS(v.x, v.y); ctx.strokeStyle = "#ffd36b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, Math.max(4 * k, 11), 0, 7); ctx.stroke(); }
    if (overlay.state && (k > 3 || v.kind === "pursuer" || v.kind === "target") && v.state !== "cruising") label(v.x, v.y, v.state, v.state.startsWith("fleeing") ? "#ef5d4f" : "#e7ecf2");
    if (overlay.perc && v.kind === "pursuer") { const [x, y] = toS(v.x, v.y); ctx.strokeStyle = "rgba(159,214,255,.3)"; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.arc(x, y, CONFIG.pursuitLoseDist * k, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
  }
  // pedestrians
  const pr = Math.max(0.42 * k, 1.8);
  for (const p of W.peds) {
    const [x, y] = toS(p.x, p.y); ctx.globalAlpha = p.alpha;
    ctx.fillStyle = p.state === "fleeing" ? "#ef5d4f" : p.state === "knocked down" ? "#f0b43a" : p.shirt;
    if (p.state === "knocked down") { ctx.save(); ctx.translate(x, y); ctx.rotate(-(p.h || 0)); ctx.fillRect(-pr * 1.4, -pr * 0.6, pr * 2.8, pr * 1.2); ctx.restore(); }
    else { ctx.beginPath(); ctx.arc(x, y, pr, 0, 7); ctx.fill(); if (k > 2.2) { ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(x, y, pr * 0.5, 0, 7); ctx.fill(); } }
    if (overlay.perc && p.state === "fleeing") { ctx.strokeStyle = "rgba(239,93,79,.25)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, CONFIG.panicSpreadRadius * k, 0, 7); ctx.stroke(); }
    if (overlay.state && k > 2.4 && p.state !== "walking") label(p.x, p.y, p.state, p.state === "fleeing" ? "#ef5d4f" : "#cfd8e3");
    if (p === sel) { ctx.strokeStyle = "#ffd36b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, pr + 6, 0, 7); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  if (n) { ctx.fillStyle = "rgba(4,8,20,.25)"; ctx.fillRect(0, 0, vw, vh); }
}
function strobe(wx, wy, a) { const [x, y] = toS(wx, wy), on = (W.simT * 6 | 0) % 2; ctx.globalAlpha = a; ctx.fillStyle = on ? "#ffffff" : "#ffb02e"; ctx.beginPath(); ctx.arc(x + (on ? -3 : 3), y, Math.max(0.8 * cam.k, 2.5), 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
function fire(wx, wy, a) { const [x, y] = toS(wx, wy), r = Math.max(4 * cam.k, 9) * (0.8 + 0.2 * Math.sin(W.simT * 17)); const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(255,220,120,${a})`); g.addColorStop(0.5, `rgba(255,110,30,${0.7 * a})`); g.addColorStop(1, "rgba(255,60,20,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
function label(wx, wy, t, col) { const [x, y] = toS(wx, wy); ctx.font = "600 10px 'Public Sans',sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; const w = ctx.measureText(t).width; ctx.fillStyle = "rgba(10,17,28,.8)"; ctx.fillRect(x + 8, y - 13, w + 8, 14); ctx.fillStyle = col; ctx.fillText(t, x + 12, y - 6); }

// ---------- loop ----------
function loop(ts) {
  requestAnimationFrame(loop);
  if (!W || !visible) { lastT = ts; return; }
  const dt = Math.min(0.1, (ts - lastT) / 1000 || 0); lastT = ts;
  if (playing) { acc += dt * speed; let n = 0; while (acc > 1 / 30 && n++ < 8) { W.step(1 / 30); acc -= 1 / 30; } if (n >= 8) acc = 0; }
  draw(); hud();
}
let hudT = 0;
function hud() {
  if (performance.now() - hudT < 250) return; hudT = performance.now();
  const h = (W.t / 3600) % 24; $("clock").textContent = `${String(h | 0).padStart(2, "0")}:${String((h % 1) * 60 | 0).padStart(2, "0")}`;
  const cars = W.vehicles.filter(v => v.kind === "car").length, motos = W.vehicles.filter(v => v.kind === "moto").length, buses = W.vehicles.filter(v => v.kind === "bus").length;
  $("stats").innerHTML = `<span><b>${cars}</b> cars</span><span><b>${motos}</b> motorcycles</span><span><b>${buses}</b> buses</span><span><b>${W.peds.length}</b> people</span><span><b>${W.counters.yields}</b> times drivers stopped for people</span><span><b>${W.counters.crashes}</b> bike falls</span>`;
  $("feed").innerHTML = W.feed.length ? W.feed.slice(0, 4).map(f => `<li>${f.msg}</li>`).join("") : `<li class="mute">Nothing unusual yet.</li>`;
  if (sel) {
    if (sel.dead || !W.vehicles.includes(sel) && !W.peds.includes(sel)) { sel = null; $("agent").hidden = true; return; }
    const isV = !!sel.kind, kind = isV ? {car: "Car", moto: "Motorcycle", bus: "Bus", pursuer: "Pursuing party", target: "Target car", gps: "GPS car", wreck: "Burning car"}[sel.kind] : "Pedestrian";
    const street = isV && sel.path ? W.name((sel.path.e || sel.path.to.e).n) : "";
    $("agent").hidden = false;
    $("agent").innerHTML = `<div class="eyebrow">${kind}${isV && sel.pers ? " · " + sel.pers + " driver" : ""}</div><b>${sel.state}</b><div class="mute">${isV ? Math.round(sel.v * 3.6) + " km/h" : ""}${street ? " · " + street : ""}${isV && sel.path && sel.path.kind === "L" && sel.path.sig ? " · light: " + ({g: "green", y: "amber", r: "red"})[W.sigState(sel.path)] : ""}</div><div class="mute">${why(sel)}</div>`;
  } else $("agent").hidden = true;
}
function why(a) {
  const s = a.state;
  if (/red light/.test(s)) return "The signal for its lane is red; it stops at the stop line.";
  if (/filtering/.test(s)) return "Motorcycles ride up the gap between lanes and wait in front of the cars.";
  if (/corredor/.test(s)) return "Traffic is slow, so the bike rides the gap between the lanes, a bit faster than the cars.";
  if (/PARE/.test(s)) return "Minor road with a PARE sign: full stop, then go when it's clear.";
  if (/right/.test(s) && /yield/.test(s)) return "Unmarked crossing: the car coming from the right goes first (CTB art. 29).";
  if (/priority|junction|gap/.test(s)) return "Its path through the junction crosses someone else's, so it waits.";
  if (/pedestrian/.test(s)) return "Someone is crossing in front of it. Drivers always stop for people.";
  if (/pulling over/.test(s)) return "A pursuing party is coming up behind, so it moves right and slows down.";
  if (/following/.test(s)) return "Keeping a safe gap to the vehicle ahead.";
  if (/changing lanes/.test(s)) return "The lane next to it was moving faster and there was a gap.";
  if (/bus/.test(s)) return "Buses stop at their stops; people waiting get on.";
  if (/fleeing/.test(s)) return "It noticed the event and is getting away from it.";
  if (/crossing on red/.test(s)) return "No cars coming, so this person crosses on red. Some people do.";
  if (/waiting at the crossing/.test(s)) return "Waiting for the walk signal, or for a gap at an unmarked crossing.";
  if (/jaywalking/.test(s)) return "Crossing mid-block because the road looked clear. Drivers still stop for them.";
  if (/chasing|intercept|boxing|search|giving up/.test(s)) return "Planning its route on the lane map toward where the target is, or will be.";
  return "Driving the lane at a speed set by the limit and its personality.";
}

// ---------- GPS panel ----------
function renderGps() {
  const el = $("gpslist"); if (!el) return;
  if (!gps) { el.innerHTML = `<li class="mute">${gpsPts.length ? "Now tap the destination." : "Tap a start point on the map."}</li>`; return; }
  if (gps.fail) { el.innerHTML = `<li class="mute">No legal route between those points inside this section (one-way streets lead out of it). Try two points along the same direction of traffic.</li>`; return; }
  el.innerHTML = gps.steps.map((s, i) => `<li><span class="m">${i ? s.m + " m" : ""}</span><div><b>${lang === "pt" ? s.pt : s.en}</b><small>${lang === "pt" ? s.en : s.pt}</small></div></li>`).join("").replace(/ km m/g, " km");
}

// ---------- input ----------
let drag = null, pinch = null; const ptrs = new Map();
cv.addEventListener("pointerdown", e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.offsetX, e.offsetY]); if (ptrs.size === 1) drag = {x: e.offsetX, y: e.offsetY, cx: cam.x, cy: cam.y, moved: false}; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = {d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: cam.k}; } });
cv.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; cam.k = clampN(pinch.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d, minK(), 14); if (drag) drag.moved = true; return; }
  if (drag) { const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y; if (Math.hypot(dx, dy) > 6) drag.moved = true; if (drag.moved) { cam.x = drag.cx - dx / cam.k; cam.y = drag.cy + dy / cam.k; clampCam(); } }
});
const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (ptrs.size === 0 && drag) { if (!drag.moved) tap(e.offsetX, e.offsetY); drag = null; } };
cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", e => { ptrs.delete(e.pointerId); drag = null; pinch = null; });
cv.addEventListener("wheel", e => { e.preventDefault(); const [wx, wy] = toW(e.offsetX, e.offsetY); cam.k = clampN(cam.k * Math.exp(-e.deltaY * 0.0015), minK(), 14); const [nx, ny] = toW(e.offsetX, e.offsetY); cam.x += wx - nx; cam.y += wy - ny; clampCam(); }, {passive: false});
const minK = () => Math.min(vw, vh) / (2 * W.half) * 0.8;
function clampCam() { const H = W.half; cam.x = clampN(cam.x, -H, H); cam.y = clampN(cam.y, -H, H); }
function tap(sx, sy) {
  const [x, y] = toW(sx, sy);
  if (scen === "panic") { W.emit(panicType, x, y); return; }
  if (scen === "gps") {
    if (gpsPts.length >= 2) { gpsPts = []; gps = null; W.clearScripted(); }
    gpsPts.push([x, y]);
    if (gpsPts.length === 2) {
      gps = W.planGps(gpsPts[0], gpsPts[1]) || {fail: true}; W.gps = gps;
      if (!gps.fail) { gpsPts = []; const g = W.spawnVehicle("car", gps.A.L, {kind: "gps", s: Math.max(0.1, gps.A.s), col: "#ffffff", scripted: true, route: gps.paths, followRoute: true, pers: "normal"}); if (g) { g.alpha = 1; g.state = "following the GPS route"; W.gpsCar = g; } }
    }
    renderGps(); return;
  }
  // pick an agent
  let best = null, bd = Math.max(14 / cam.k, 4);
  for (const v of W.vehicles) { const d = Math.hypot(v.x - x, v.y - y); if (d < bd) { bd = d; best = v; } }
  for (const p of W.peds) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd * 0.8) { bd = d; best = p; } }
  sel = best; hudT = 0;
}

// ---------- controls ----------
$("scens").onclick = e => { const b = e.target.closest("button"); if (b) setScenario(b.dataset.s); };
$("play").onclick = () => { playing = !playing; $("play").textContent = playing ? "Pause" : "Play"; $("play").setAttribute("aria-pressed", !playing); };
$("speed").oninput = () => { speed = [0.25, 0.5, 1, 2, 4][$("speed").value]; $("speedv").textContent = speed + "×"; };
$("tod").oninput = () => { W.t = Math.floor(W.t / 86400) * 86400 + Number($("tod").value) * 3600; staticKey = ""; };
$("dens").oninput = () => { W.density = Number($("dens").value) / 100; $("densv").textContent = $("dens").value + "%"; };
$("heat").oninput = () => { W.heat = Number($("heat").value); $("heatv").textContent = $("heat").value; $("heatd").textContent = ["", "One unit follows.", "Ramming allowed.", "An interceptor heads for where the target is going.", "Boxing in and a roadblock on the predicted route.", "Everything, plus a spike strip ahead of the roadblock."][W.heat]; W.applyHeat(); };
$("panicbar").onclick = e => { const b = e.target.closest("button"); if (!b) return; panicType = b.dataset.p; [...$("panicbar").querySelectorAll("button")].forEach(x => x.setAttribute("aria-pressed", x === b)); };
$("lang").onclick = () => { lang = lang === "en" ? "pt" : "en"; $("lang").textContent = lang === "en" ? "Português" : "English"; renderGps(); };
$("ovl").onclick = e => { const b = e.target.closest("button"); if (!b) return; overlay[b.dataset.o] = !overlay[b.dataset.o]; syncOverlayButtons(); };
function syncOverlayButtons() { [...$("ovl").children].forEach(b => b.setAttribute("aria-pressed", !!overlay[b.dataset.o])); }
$("zin").onclick = () => { cam.k = clampN(cam.k * 1.4, minK(), 14); }; $("zout").onclick = () => { cam.k = clampN(cam.k / 1.4, minK(), 14); }; $("zfit").onclick = fit;
new ResizeObserver(() => { resize(); if (W && !drag) fit(); }).observe(cv);
new IntersectionObserver(es => es.forEach(e => visible = e.isIntersecting && !document.hidden)).observe(cv);
document.addEventListener("visibilitychange", () => visible = !document.hidden);
resize(); loadIndex().then(() => requestAnimationFrame(loop)).catch(err => { $("explain").innerHTML = "<p>Couldn't load the street data: " + err.message + "</p>"; });
