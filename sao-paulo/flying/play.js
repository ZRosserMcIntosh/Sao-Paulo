// São Paulo World · flying game: the game layer.
// A front door (the welcome screen), Casual flying (playlaw.js flies the real
// controls; this file feeds it the player's stick and looks after the gear,
// flaps and speed), challenges with scores (challenges.js) and the landing
// score shown after any touchdown in every mode. The simulator underneath is
// untouched: app.js calls in at the hooks marked "Play:", and with the mode
// on 'sim' every hook here steps aside.
//
// For other modules (multiplayer, replays): the object initPlay() returns
// (app.js keeps it as `play`, and it is window.spwPlay) has
//   startChallenge(id, { seed, intro })   start a challenge (intro: show its card first)
//   on(fn)                                fn({ type: 'start' | 'finish' | 'quit', id, seed, result }) for every challenge
//   setFriends(open, label)               what the welcome screen's "Fly with friends" card does (absent: shown as "soon")
//   casual, mode, current()               what is going on now
// and the same events leave as window 'spw:challenge' CustomEvents.
import { makeLaw, casualLimits, LAW_ASSIST } from './playlaw.js';
import { CHALLENGES, SIGHTS, AIRCRAFT, MISS_PENALTY, challengeById } from './challenges.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap180 = (d) => ((d + 540) % 360) - 180;

// Every word a player reads, in one place (plain words: no pilot's jargon in Casual).
const T = {
  game: 'Fly São Paulo',
  title: 'Fly <em>São Paulo</em>',
  sub: 'The whole city from the air. No lessons needed.',
  justFly: 'Just fly', justFlySub: 'Straight into the air over the city.',
  challenges: 'Challenges', challengesSub: 'Rings, landings and races, with stars.',
  friends: 'Fly with friends', friendsSub: 'Share a link and fly together.', soon: 'soon',
  sim: 'Full simulator', simSub: 'Real instruments and procedures, eight aircraft.',
  plane: 'Plane', siteLink: 'Part of <a href="/sao-paulo/">São Paulo World</a>',
  home: 'Home', camera: 'View', sound: 'Sound', again: 'Try again', back: 'Back', start: 'Start', resume: 'Keep flying', next: 'Next', share: 'Share', copied: 'Link copied',
  faster: 'Faster', slower: 'Slower', speeds: ['Slow', 'Cruise', 'Fast'],
  landForMe: 'Land for me', cancelLanding: 'I’ll fly', takeOff: 'Take off', flyAgain: 'Back in the air',
  kmh: 'km/h', mph: 'mph', m: 'm', ft: 'ft', speed: 'SPEED', height: 'HEIGHT',
  pullUp: 'Pull up!', tooSlow: 'Too slow', paused: 'Paused',
  tipSteerKeys: 'Arrow keys steer: left and right turn, up climbs, down descends. Or drag with the mouse.',
  tipSteerTouch: 'Drag anywhere to steer: left and right turn, up climbs, down descends.',
  tipHands: 'Let go and it flies itself, straight and level.',
  tipRing: 'Fly through the ring ahead. The yellow arrow points to it.',
  tipFlare: 'For the last few metres, hold up: it touches down softly.',
  sight: (n, k, of) => `${n} — ${k} of ${of} sights`,
  sightsDone: 'Every sight in the city! Starting over.',
  goalSight: 'Next sight', goalRing: (i, n) => `Ring ${i} of ${n}`, goalRunway: (id) => `Runway ${id}`, goalLane: 'In the lane',
  ringMiss: 'Missed a ring', landing: (name) => `Landing at ${name}`, landingFar: (name, km) => `Landing at ${name}: ${km} km to go`, noRunway: 'No runway near enough to land on.',
  landed: 'Down and stopped. Nice.', takingOff: 'Taking off', youFly: 'You have it: steer away.', engineOut: 'The engine has stopped: glide to the runway.',
  crash: 'Oops!', crashBuilding: 'You hit a building.', crashGround: 'You flew into the ground.', crashLanding: 'That landing was too hard for the plane.',
  crashBreak: 'Too fast, too tight: the plane came apart.', crashDamage: 'The plane is too damaged to fly.',
  best: 'Best', newBest: 'New best!', noBest: 'Not flown yet', time: 'Time', missed: (n) => `${n} missed ring${n > 1 ? 's' : ''}: +${n * MISS_PENALTY} s`,
  inLane: (p) => `${p} % of the avenue inside the lane`, leftLane: 'You left the avenue.',
  kinds: { rings: 'Rings', landing: 'Landing', lowpass: 'Low pass' },
  how: {
    rings: 'Fly through every ring, in order, as fast as you can. A missed ring costs time.',
    landing: 'Keep it on the runway’s line, and hold up for the last few metres to touch down softly.',
    glide: 'No engine, one try: steer for the runway, push down if you are too high, and hold up for the last few metres.',
    lowpass: 'Stay between the two rows of lights, just above the rooftops, all the way along.',
  },
  shareText: (name, res) => `${res} on “${name}” in Fly São Paulo. Can you beat it?`,
  landingScore: 'Landing', grades: { S: 'Perfect', A: 'Great', B: 'Good', C: 'Rough', D: 'Scary' },
  parts: { sink: 'Touchdown', line: 'Centre', spot: 'Spot', speed: 'Speed', bounce: 'Bounces' },
  sinkText: (v, u) => [`soft as butter (${v} ${u})`, `smooth (${v} ${u})`, `firm (${v} ${u})`, `hard (${v} ${u})`, `a real thump (${v} ${u})`],
  lineText: (m) => [`on the line (${m} m off)`, `close to the line (${m} m off)`, `off to one side (${m} m)`, `near the edge (${m} m off)`, 'off the runway'],
  spotText: ['right in the landing zone', 'a little early', 'a little long', 'before the runway', 'far down the runway', 'not on a runway', 'beside the runway'],
  speedText: (d) => [`right speed (${d > 0 ? '+' : ''}${d} kt)`, `a bit fast (+${d} kt)`, `fast (+${d} kt)`, `slow (${d} kt)`],
  bounceText: (n) => (n ? `${n} bounce${n > 1 ? 's' : ''}` : 'no bounce'),
};

// ---- The landing score (pure: scripts test it) ----
// td: { fpm (sink at the first touchdown), off (m from the centreline), along (m past the landing threshold),
//   length (m of runway from the threshold), halfWidth (m), kias, vref (kt), bounces, runway: false when not on one }.
// Each part scores 0..100 with a line of plain words; the grade weighs the touchdown most.
const lerp = (x, a, b, u, v) => u + (v - u) * clamp((x - a) / (b - a), 0, 1);
export function scoreLanding(td, { metric = false } = {}) {
  const fpm = Math.abs(td.fpm), sinkV = metric ? (fpm * 0.00508).toFixed(1) : Math.round(fpm), sinkU = metric ? 'm/s' : 'ft/min';
  const sinkK = fpm <= 120 ? 0 : fpm <= 240 ? 1 : fpm <= 400 ? 2 : fpm <= 600 ? 3 : 4;
  const sink = fpm <= 120 ? 100 : fpm <= 240 ? lerp(fpm, 120, 240, 100, 82) : fpm <= 400 ? lerp(fpm, 240, 400, 82, 45) : fpm <= 600 ? lerp(fpm, 400, 600, 45, 20) : lerp(fpm, 600, 1000, 20, 0);
  const parts = [{ key: 'sink', score: sink, text: T.sinkText(sinkV, sinkU)[sinkK] }];
  if (td.runway === false) {
    parts.push({ key: 'line', score: 0, text: T.lineText(0)[4] }, { key: 'spot', score: 0, text: T.spotText[5] });
  } else {
    const off = Math.abs(td.off), hw = td.halfWidth || 22, offM = off < 10 ? off.toFixed(1) : Math.round(off);
    const lineK = off <= 2 ? 0 : off <= 5 ? 1 : off <= 0.6 * hw ? 2 : off <= hw ? 3 : 4;
    const line = off <= 2 ? 100 : off <= 5 ? lerp(off, 2, 5, 100, 85) : off <= hw ? lerp(off, 5, hw, 85, 35) : 0;
    parts.push({ key: 'line', score: line, text: T.lineText(offM)[lineK] });
    // The landing zone: from 100 m to a third of the runway (at most 600 m) past the threshold.
    const a = td.along, z1 = Math.min(600, td.length / 3), half = td.length / 2;
    const spotK = a < 0 ? 3 : a < 100 ? 1 : a <= z1 ? 0 : a <= half ? 2 : 4;
    const spot = a < 0 ? 0 : a < 100 ? lerp(a, 0, 100, 60, 100) : a <= z1 ? 100 : a <= half ? lerp(a, z1, half, 100, 55) : lerp(a, half, td.length, 55, 0);
    parts.push(off > hw ? { key: 'spot', score: 0, text: T.spotText[6] } : { key: 'spot', score: spot, text: T.spotText[spotK] });
  }
  const d = Math.round(td.kias - td.vref);
  // (A flare spends speed: well under the approach speed is as it should be; only close to the stall is slow.)
  const speedK = d < -22 ? 3 : d <= 6 ? 0 : d <= 15 ? 1 : 2;
  const speed = d < -22 ? lerp(d, -35, -22, 40, 85) : d <= 6 ? 100 : lerp(d, 6, 30, 100, 20);
  parts.push({ key: 'speed', score: speed, text: T.speedText(d)[speedK] });
  const n = td.bounces || 0;
  parts.push({ key: 'bounce', score: n === 0 ? 100 : n === 1 ? 60 : 25, text: T.bounceText(n) });
  const W = { sink: 0.35, line: 0.2, spot: 0.2, speed: 0.1, bounce: 0.15 };
  let score = parts.reduce((t, p) => t + W[p.key] * p.score, 0);
  // One bad part holds the grade down: a thump on the centreline is not a great landing.
  score = Math.min(score, Math.min(...parts.map((p) => p.score)) + 25);
  const grade = score >= 93 ? 'S' : score >= 84 ? 'A' : score >= 68 ? 'B' : score >= 48 ? 'C' : 'D';
  return { score: Math.round(score), grade, word: T.grades[grade], stars: grade === 'S' || grade === 'A' ? 3 : grade === 'B' ? 2 : 1, parts };
}
// Stars for a time (lower is better) or a share (higher is better) against [3-star, 2-star].
export const starsFor = (v, [s3, s2], higher = false) => (higher ? (v >= s3 ? 3 : v >= s2 ? 2 : 1) : (v <= s3 ? 3 : v <= s2 ? 2 : 1));
export const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

const ICON = {
  plane: '<svg viewBox="0 0 24 24"><path d="M2.5 13.5l19-6.5-6 13.5-3-6-4.5 4z"/><path d="M12.5 14.5l9-7.5"/></svg>',
  rings: '<svg viewBox="0 0 24 24"><ellipse cx="8" cy="12" rx="4" ry="8"/><ellipse cx="16.5" cy="12" rx="3" ry="6"/></svg>',
  friends: '<svg viewBox="0 0 24 24"><circle cx="8.5" cy="8" r="3"/><circle cx="17" cy="9.5" r="2.4"/><path d="M2.5 19c.6-3.4 3-5 6-5s5.400 1.600 6 5M15.500 14.200c3-.2 5 1.400 5.800 4.300"/></svg>',
  gauge: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 12l4.500-4.500M12 5v1.500M5 12h1.500M17.500 12H19"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3.500 11.500L12 4l8.500 7.500M6 10v9.500h12V10"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z"/><circle cx="12" cy="12" r="2.600"/></svg>',
  soundOn: '<svg class="on" viewBox="0 0 24 24"><path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500zM15.500 9a4 4 0 010 6M18 6.500a7.500 7.500 0 010 11"/></svg>',
  soundOff: '<svg class="off" viewBox="0 0 24 24"><path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500zM16 9.500l5 5M21 9.500l-5 5"/></svg>',
  again: '<svg viewBox="0 0 24 24"><path d="M4.500 12a7.500 7.500 0 107.500-7.500c-2.400 0-4.400 1-6 2.700M5 3.500v4h4"/></svg>',
  land: '<svg viewBox="0 0 24 24"><path d="M3 20.500h18M3.500 9.500l3 5 13.500 1.500c.8-1.200-.4-2.300-2-2.700l-4.500-1.200-4-6.600-2 .3 1.800 5.200-3.800-.9-1.300-1.800z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M3 20.500h18M4 14.500l3.500 1.200L20 10.500c-.200-1.400-1.700-1.900-3.200-1.500l-4.300 1.600-6.300-3.800-1.700.9 4.200 4.300-3.500 1.300-2-.9z"/></svg>',
};

export function initPlay(ctx) {
  const { THREE, A, store, MOBILE, input, ui, look, canvas, groundAt, RW } = ctx;
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
  const body = document.body;

  // ---- State ----
  // mode: 'sim' (the simulator as it always was) or 'casual'. phase: what the co-pilot is doing in Casual.
  let mode = 'sim';
  let phase = 'fly';           // attract | fly | approach | rollout | takeoff | climbout | autoland | landed
  let act = { kind: 'free' };  // the activity: free | rings | lowpass | landing (+ its challenge `def` and progress)
  let screen = null;           // the overlay showing: home | list | intro | result | crash | pause | null
  let kind = 'piston', L = casualLimits('piston', 50), speed = 1, toDet = 0, landDet = 0;
  const law = makeLaw();
  const stick = { x: 0, y: 0, kx: 0, ky: 0, px: 0, py: 0, id: null, x0: 0, y0: 0, used: 0 };
  const keys = new Set();
  const tips = store.get('play:tips', {});
  const best = store.get('play:best', {});
  let seen = new Set(store.get('play:sights', []));
  let plane = AIRCRAFT[store.get('play:plane', 'c172')] ? store.get('play:plane', 'c172') : 'c172';
  let wantSound = store.get('play:sound', true);
  const listeners = [];
  let friends = null;
  const now = () => performance.now() / 1000;
  const casualFlying = () => mode === 'casual' && !screen;
  const P = () => ctx.profile();

  // ---- DOM ----
  const btn = (id, cls, html, title = '') => `<button id="${id}" class="${cls}" title="${title}">${html}</button>`;
  const top = el(`<div id="pTop">
    ${btn('pHomeB', '', `${ICON.home}<span>${T.home}</span>`, `${T.home} (Esc)`)}
    ${btn('pCamB', '', `${ICON.eye}<span>${T.camera}</span>`, `${T.camera} (C)`)}
    <button id="pSndB" aria-pressed="false" title="${T.sound} (M)">${ICON.soundOn}${ICON.soundOff}</button>
    ${btn('pAgainB', '', ICON.again, `${T.again} (R)`)}</div>`);
  document.querySelector('.top').appendChild(top);
  // The simulator's own bar gets one more button: the way back to the front door.
  const simHome = el(`<button id="bHome" title="${T.game}: the welcome screen">${T.home}</button>`);
  document.querySelector('.top .row').prepend(simHome);
  const hud = el(`<div id="pHud">
    <div id="pGoal" hidden><b></b><span></span><small></small></div>
    <div id="pNums"><div><span id="pV">0</span><i id="pVU">${T.kmh}</i><small>${T.speed}</small></div><div><span id="pH">0</span><i id="pHU">${T.m}</i><small>${T.height}</small></div></div>
    <div id="pAct">
      <button id="pMain" class="pBtn go" hidden></button>
      <div id="pSpd"><button id="pSlow" class="pBtn" title="${T.slower} (Z)" aria-label="${T.slower}">−</button>
        <div class="lvl"><div class="pips"><i></i><i></i><i></i></div><span id="pLvl"></span></div>
        <button id="pFast" class="pBtn" title="${T.faster} (X)" aria-label="${T.faster}">+</button></div>
    </div>
    <div id="pAlert" hidden></div><div id="pNote"></div>
    <div id="pTip" hidden><span></span><button aria-label="OK">✕</button></div>
  </div>`);
  const mark = el('<div id="pMark"><i></i><svg viewBox="-13 -17 26 34"><path d="M0-16L12 14 0 7-12 14z"/></svg><b></b></div>');
  const stickEl = el('<div id="pStick"><i></i></div>');
  const over = el('<div id="pOver" class="pOver" hidden></div>');
  const landEl = el('<div id="pLand" hidden></div>');
  body.append(hud, mark, stickEl, over, landEl);
  const q = (sel) => document.querySelector(sel);
  const goalEl = q('#pGoal'), alertEl = q('#pAlert'), noteEl = q('#pNote'), tipEl = q('#pTip'), mainB = q('#pMain');
  let noteT = 0;
  function note(text, sec = 2.5) { noteEl.textContent = text; noteEl.classList.add('on'); noteT = sec; }
  let tipKey = null;
  function tip(key, text) {
    if (tips[key] || tipKey === key) return;
    tipKey = key; tipEl.firstElementChild.textContent = text; tipEl.hidden = false;
  }
  function tipDone(key) {
    if (key && tipKey !== key) return;
    if (tipKey) { tips[tipKey] = 1; store.set('play:tips', tips); }
    tipKey = null; tipEl.hidden = true;
  }
  tipEl.lastElementChild.addEventListener('click', () => tipDone());

  // ---- The player's stick: keys, a drag anywhere (mouse or thumb), a gamepad ----
  const KEYS = { ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd' };
  const REACH = MOBILE ? 62 : 110;  // px of drag for full deflection
  function placeStick(on) {
    stickEl.classList.toggle('on', on);
    if (on) stickEl.style.transform = `translate(${stick.x0}px,${stick.y0}px)`;
    stickEl.firstElementChild.style.transform = on ? `translate(${stick.px * 44}px,${-stick.py * 44}px)` : '';
  }
  addEventListener('pointerdown', (e) => {
    if (mode !== 'casual' || e.target !== canvas) return;
    e.stopPropagation();  // in Casual a drag steers: the simulator's look-around never sees it
    if (screen || stick.id !== null) return;
    stick.id = e.pointerId; stick.x0 = e.clientX; stick.y0 = e.clientY; stick.px = stick.py = 0; stick.used = now();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* gone already */ }
    placeStick(true);
  }, true);
  addEventListener('pointermove', (e) => {
    if (e.pointerId !== stick.id) return;
    e.stopPropagation();
    let x = (e.clientX - stick.x0) / REACH, y = -(e.clientY - stick.y0) / REACH;
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    stick.px = x; stick.py = y;
    placeStick(true);
  }, true);
  const dragEnd = (e) => { if (e.pointerId !== stick.id) return; stick.id = null; stick.px = stick.py = 0; placeStick(false); };
  addEventListener('pointerup', dragEnd, true); addEventListener('pointercancel', dragEnd, true);
  const padWas = [];
  function readStick(h) {
    const k = (n) => keys.has(n);
    const tx = (k('r') ? 1 : 0) - (k('l') ? 1 : 0), ty = (k('u') ? 1 : 0) - (k('d') ? 1 : 0);
    const ease = (v, t) => (v < t ? Math.min(v + (t ? 3.2 : 5) * h, t) : Math.max(v - (t ? 3.2 : 5) * h, t));
    stick.kx = ease(stick.kx, tx); stick.ky = ease(stick.ky, ty);
    let x = stick.kx + stick.px, y = stick.ky + stick.py;
    const gp = [...(navigator.getGamepads?.() || [])].find((p) => p && p.mapping === 'standard');
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.1 ? 0 : v);
      x += dz(gp.axes[0] || 0); y -= dz(gp.axes[1] || 0);
      const edge = (i) => { const on = (gp.buttons[i]?.value || 0) > 0.5, was = padWas[i]; padWas[i] = on; return on && !was; };
      if (edge(7) || edge(12)) setSpeed(speed + 1);
      if (edge(6) || edge(13)) setSpeed(speed - 1);
      if (edge(0)) mainAction();
      if (edge(3)) again();
      if (edge(8)) cam();
      if (edge(9)) pause();
    }
    stick.x = clamp(x, -1, 1); stick.y = clamp(y, -1, 1);
    if (Math.abs(stick.x) > 0.15 || Math.abs(stick.y) > 0.15) stick.used = now();
  }
  addEventListener('keydown', (e) => {
    if (mode !== 'casual' || e.target.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopPropagation();  // Casual has its own few keys; the simulator's stay with the simulator
    if (screen) {
      if (e.code === 'Enter' || (e.code === 'Space' && !e.target.closest?.('button'))) { over.querySelector('[data-primary]')?.click(); e.preventDefault(); }
      else if (e.code === 'Escape') over.querySelector('[data-back]')?.click();
      else if (e.code === 'KeyR' && (screen === 'result' || screen === 'crash')) again();
      return;
    }
    if (KEYS[e.code]) { keys.add(KEYS[e.code]); e.preventDefault(); }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyX': case 'Equal': case 'NumpadAdd': setSpeed(speed + 1); break;
      case 'KeyZ': case 'Minus': case 'NumpadSubtract': setSpeed(speed - 1); break;
      case 'KeyR': again(); break;
      case 'KeyC': cam(); break;
      case 'KeyM': sound(!ui.sound); break;
      case 'KeyL': case 'KeyT': case 'Enter': mainAction(); break;
      case 'Space': case 'KeyP': pause(); e.preventDefault(); break;
      case 'Escape': case 'KeyH': home(); break;
      default:
    }
  }, true);
  addEventListener('keyup', (e) => { if (KEYS[e.code]) keys.delete(KEYS[e.code]); }, true);
  addEventListener('blur', () => keys.clear());

  // ---- Spawns ----
  // Casual flies in fair weather, whatever the simulator's Weather menu holds (a challenge may ask for wind).
  function fairWeather(wind = null) {
    A.avd_set_weather((wind ? wind[0] : 0) * 0.5144, wind ? wind[1] : 0, 0, 0, 0.6);
    A.setRain?.(0); A.avd_set_cloud(0, 0, 0); A.avd_set_wind_detail(0, 0, 1500); A.avd_set_runway_water(0); A.avd_set_wind_hazard(0);
    A.setFront?.({ kind: 'none', etaMin: 10 });
  }
  function afterSpawn(ph, throttle) {
    A.avd_set_assist(LAW_ASSIST); A.avd_set_level_hold(0);
    A.tawsConfig?.({ cls: 0 });  // no cockpit call-outs in Casual; its own "Pull up!" instead
    ui.vis = 0;
    const p = P(), j = A.jet();
    kind = p.turboprop ? 'turboprop' : p.jet ? 'jet' : 'piston';
    // The clean stall speed, from the core at this weight (a spawn with flaps out: the landing one, scaled).
    const vs = A.state()[26] < 1 ? j[32] : j[34] * 1.18;
    L = casualLimits(kind, vs, j[25]);
    const det = (A.cockpit().find((x) => x.id === 'flaps.lever')?.positions || ['0']).map((t) => parseFloat(t));
    landDet = det.length - 1;
    toDet = kind === 'piston' ? Math.min(1, landDet) : det.reduce((b, d, k) => (Math.abs(d - j[49]) < Math.abs(det[b] - j[49]) ? k : b), 0);
    law.reset(throttle ?? A.avd_trim_throttle());
    phase = ph; cfgT = 0; flapT = -9; air = { since: now(), sim: A.state()[42] };
    landing = null; crash = null; landEl.hidden = true; alertEl.hidden = true;
    input.mixture = 1; input.starter = 0;
    if (ui.paused) ui.paused = false;
    keys.clear(); stick.kx = stick.ky = 0;
    refreshButtons();
  }
  // In the air at (e, n), h metres above the ground there, on a heading, at a speed.
  function spawnAir(e, n, h, hdg, kt, { wind = null, ph = 'fly', flap = 0 } = {}) {
    ctx.spawn({ name: T.game, sub: '', trim: true, go: () => { fairWeather(wind); A.avd_reset_air(e, n, Math.max(40, groundAt(e, n) + h - RW[2]), hdg, kt, flap); } });
    afterSpawn(ph);
  }
  const SPEEDS = { piston: 100, turboprop: 180, jet: 220 };
  // How high the aircraft's datum sits with its wheels on the ground (m): what "height" reads when landed.
  const GAP = {};
  const groundGap = () => GAP[P().id] ?? (GAP[P().id] = kind === 'piston' ? 1.3 : 1.6);
  // A free flight: over the city toward the centre, the sights ahead.
  function spawnFree(ph = 'fly') {
    const p = P(), k = p.turboprop ? 'turboprop' : p.jet ? 'jet' : 'piston';
    speed = 1;
    if (k === 'piston') spawnAir(-900, -3600, 260, 28, 100, { ph });
    else spawnAir(-2600, -7400, k === 'jet' ? 520 : 420, 28, SPEEDS[k], { ph });
  }

  // ---- The co-pilot: Casual's control, each physics sub-step ----
  let cfgT = 0, flapT = -9, air = { since: 0, sim: 0 }, rwy = null, toHdg = 0, vR = 55, simT = 0;
  // The runway under (or ahead of) the aircraft: the end it faces, with its landing threshold.
  function runwayNear(e, n, hdg, reach = 600) {
    let bestR = null;
    for (const ap of ctx.region()) for (const r of ap.ends) {
      if (Math.abs(wrap180(r.heading - hdg)) > 60) continue;
      const dx = e - r.east, dy = n - r.north, sh = Math.sin(r.heading * DEG), ch = Math.cos(r.heading * DEG);
      const along = dx * sh + dy * ch, off = dx * ch - dy * sh;
      if (along < -reach || along > r.length + reach || Math.abs(off) > Math.max(120, reach / 3)) continue;
      if (!bestR || Math.abs(off) < Math.abs(bestR.off)) bestR = { r, ap, along, off, elevation: ap.elevation };
    }
    return bestR;
  }
  // "Land for me", first part: the co-pilot flies to the runway's final approach (round by a base leg on the
  // aircraft's own side when it starts abeam or beyond), level at the height the 3 degree path has there, slowing
  // down with a notch of flap. Lined up and on the path, the core's autoland takes it to a stop on the runway.
  // (Asked from anywhere else, the autoland would fly its whole instrument procedure: twenty minutes in the 172.)
  function toFinal(s, j) {
    const g = act.land, r = g.r, sh = Math.sin(r.heading * DEG), ch = Math.cos(r.heading * DEG);
    const tx = r.east + sh * r.displaced, ty = r.north + ch * r.displaced, dx = s[0] - tx, dy = s[1] - ty;
    const out = -(dx * sh + dy * ch), lat = dx * ch - dy * sh;  // metres before the threshold; metres right of the centreline
    const v = L.speeds[0] * 0.5144 * 1.06, R = v * v / (9.81 * Math.tan(0.8 * L.bank * DEG));
    if (!g.side) g.side = lat >= 0 ? 1 : -1;
    const path = (d) => g.elev + 15.24 + d * Math.tan(3 * DEG), zT = path(g.Df + 400), wOut = g.Df + 3 * R + 800;
    let track;
    if (g.leg === 0) {
      const we = tx - sh * wOut + ch * g.side * 2.2 * R, wn = ty - ch * wOut - sh * g.side * 2.2 * R, d = Math.hypot(we - s[0], wn - s[1]);
      track = Math.atan2(we - s[0], wn - s[1]) / DEG;
      if (d < Math.max(350, 1.2 * R) || (out > wOut && Math.abs(lat) < 2.2 * R + 300)) g.leg = 1;
    }
    if (g.leg === 1) {
      // Toward a point on the centreline a turn's length ahead: 50 degrees across from afar, easing onto it.
      const vNow = s[11] * 0.5144, look = 1.2 * vNow * vNow / (9.81 * Math.tan(0.9 * L.bank * DEG));
      track = r.heading - clamp(Math.atan2(lat, look) / DEG, -50, 50);
      if (out < g.Df * 0.45) { g.leg = 0; g.side = lat >= 0 ? 1 : -1; }  // through the final without catching it: round again
    }
    g.out = out;
    // Level until the path comes down to it, then down the path: whenever the centreline is caught, the height is right.
    const want = g.leg === 1 && Math.abs(lat) < 400 ? Math.min(zT, path(out)) : zT, alt = s[53] * 0.3048;
    // On the centreline, on the heading, on the path: hand over.
    if (g.leg === 1 && Math.abs(lat) < 120 && Math.abs(wrap180(s[9] - r.heading)) < 14 && out < 18000 && Math.abs(alt - path(out)) < 35) {
      ctx.setAutoland(true);
      if (ctx.autoland()) { phase = 'autoland'; refreshButtons(); }
    }
    const dz = want - s[2], near = Math.abs(dz) < 15 && want === zT;
    return { x: clamp(wrap180(track - s[61]) / 20, -1, 1), y: near ? 0 : clamp(dz / 40, -1, 1), alt: near ? zT : null, vT: g.leg ? Math.round(1.4 * j[32] + 5) : L.speeds[1] };
  }
  const offFrom = (r, e, n) => (e - r.east) * Math.cos(r.heading * DEG) - (n - r.north) * Math.sin(r.heading * DEG);
  function configure(s, j, agl) {
    const p = P();
    let gear, flap;
    if (phase === 'fly' || phase === 'attract') { const low = speed === 0 && agl < 200 && phase === 'fly' && act.kind === 'free'; gear = low ? 1 : 0; flap = low ? landDet : 0; }
    else if (phase === 'climbout') { gear = agl > 15 ? 0 : 1; flap = agl > 60 ? 0 : toDet; }
    else if (phase === 'takeoff') { gear = 1; flap = toDet; }
    else if (phase === 'tofinal') { gear = 0; flap = act.land.leg ? toDet : 0; }
    else return;  // an approach as it was set up; the autoland sets its own
    if (p.jet && ctx.controlPos('gear.lever') !== gear && !(gear === 0 && s[28])) ctx.setControl('gear.lever', gear);
    const cur = ctx.controlPos('flaps.lever');
    // A notch at a time: in while slowing down, out only with the speed for the next notch in hand.
    if (cur !== flap && simT - flapT > 2.5 && (flap > cur ? s[10] < L.speeds[1] - 5 : s[10] > 1.22 * j[32] || s[28])) { ctx.setControl('flaps.lever', cur + Math.sign(flap - cur)); flapT = simT; }
    if (p.jet && !p.turboprop && !s[28]) {
      // Too fast with the power off: the speedbrakes help it slow down.
      const sb = ctx.controlPos('speedbrake.lever'), fast = s[10] - target(s, j);
      if (!sb && fast > 25 && law.throttle < 0.03) ctx.setControl('speedbrake.lever', 1);
      else if (sb && fast < 10) ctx.setControl('speedbrake.lever', 0);
    }
  }
  // The speed to hold: the chosen one; with the flaps out, the landing speed for where they are.
  const target = (s, j) => (s[26] > 1 && phase === 'fly' ? Math.round(1.3 * j[32] + 5) : L.speeds[speed]);
  function control(h) {
    const s = A.state(), j = A.jet(), agl = s[14] * 0.3048, gnd = s[28] > 0.5;
    simT = s[42];
    readStick(h);
    air.off = gnd ? 0 : (air.off || 0) + h;  // seconds off the ground (a wheel skip is not flight)
    let o = null;
    const { x, y } = stick;
    if (phase === 'attract') o = law.fly(s, h, { x: 0.33, y: 0, vT: L.speeds[1], L });
    else if (phase === 'fly') {
      if (gnd) { rwy = runwayNear(s[0], s[1], s[9]); toHdg = rwy ? rwy.r.heading : s[9]; phase = 'rollout'; refreshButtons(); }
      else o = law.fly(s, h, { x, y, vT: target(s, j), L, floor: s[26] > 1 ? 1.13 * j[32] : L.floor });
    } else if (phase === 'tofinal') {
      if (gnd) { phase = 'rollout'; rwy = runwayNear(s[0], s[1], s[9]); toHdg = rwy ? rwy.r.heading : s[9]; refreshButtons(); }
      else {
        const g = toFinal(s, j);
        if (g.alt !== null) law.st.alt = g.alt;
        o = law.fly(s, h, { x: g.x, y: g.y, vT: g.vT, L, floor: s[26] > 1 ? 1.13 * j[32] : L.floor });
      }
    } else if (phase === 'approach') {
      if (gnd) { phase = 'rollout'; refreshButtons(); }
      else {
        const dead = act.def?.engine === false, r = rwy.r;
        // Hands off, the co-pilot keeps the 3 degree path to the aiming point (as an approach is flown: high, a little
        // steeper; low, a little flatter); the stick moves the path from there. A glide has no such choice.
        const toAim = (act.aim[0] - s[0]) * Math.sin(r.heading * DEG) + (act.aim[1] - s[1]) * Math.cos(r.heading * DEG);
        const high = s[2] - act.gear - (act.aim[2] + Math.max(0, toAim) * Math.tan(3 * DEG));
        const path0 = dead || toAim < 150 ? -3 : clamp(-3 - 0.12 * high, -5.5, -0.8);
        // Stick up in the last metres is the flare: the co-pilot rounds the path out as the wheels come down (the sink
        // falling with the height, about 0.3 m/s left at the ground), power off, and the speed floor steps aside:
        // the flare is speed spent on a soft touchdown. No stick, no flare: it arrives as it was descending.
        const hW = Math.max(0, s[2] - act.gear - act.aim[2]), flare = y > 0.15 && hW < 14;
        let p0 = path0, yy = y;
        if (flare) {
          const base = dead ? -7 : path0, round = Math.max(base, -Math.atan((hW / (kind === 'piston' ? 2 : 3.2) + 0.3) / Math.max(s[12] * 0.5144, 10)) / DEG);
          p0 = base + clamp(y / 0.6, 0, 1) * (round - base); yy = 0;
        }
        const cut = flare || agl < (kind === 'piston' ? 4 : 7);
        o = law.fly(s, h, { x, y: yy, vT: act.vApp, L, path0: p0, overGround: true, bank: 22, up: 3.5,
          floor: (flare || (!dead && agl < 15) ? 1.03 : dead ? 1.4 : 1.1) * j[32], thrust: !dead && !cut });
      }
    } else if (phase === 'takeoff') {
      if (air.off > 0.5 && agl > groundGap() + 2.5) { phase = 'climbout'; law.st.hdg = toHdg; note(T.youFly); refreshButtons(); }
      else o = law.takeoff(s, h, { hdg: toHdg, vR, off: rwy ? offFrom(rwy.r, s[0], s[1]) : 0, nose: kind === 'piston' ? 9 : 11 });
    } else if (phase === 'climbout') {
      if (gnd) { phase = 'takeoff'; refreshButtons(); }
      else {
        // Up on the climb path until the player takes the height too, or it is well clear of the ground.
        const own = Math.abs(y) > 0.3;
        o = law.fly(s, h, { x, y: own ? y : 0, vT: L.speeds[1], L, path0: own ? null : (kind === 'piston' ? 5 : 8), floor: 1.13 * j[32] });
        if (own || agl > (kind === 'piston' ? 50 : 110)) phase = 'fly';
      }
    }
    if (phase === 'rollout') {
      if (air.off > 0.6) phase = act.kind === 'landing' ? 'approach' : 'fly';  // a bounce: flying again
      else {
        o = law.rollout(s, h, { hdg: toHdg, off: rwy ? offFrom(rwy.r, s[0], s[1]) : 0, x, brakeBelow: kind === 'piston' ? 200 : 110 });
        if (s[12] < 1.5) { phase = 'landed'; refreshButtons(); }
      }
    }
    if (o) {
      input.pitch = o.pitch; input.roll = o.roll; input.yaw = o.yaw; input.brake = o.brake; input.trimRate = o.trim;
      input.throttle = o.throttle; input.levers = null;
    } else {
      // Landed and waiting, or the autoland flying: hands off (its throttle shown as the core has it).
      input.pitch = input.roll = input.yaw = input.trimRate = 0;
      input.brake = phase === 'landed' ? 1 : 0;
      input.throttle = phase === 'autoland' ? clamp(s[24], 0, 1) : 0; input.levers = null;
      law.throttle = input.throttle;
    }
    cfgT += h;
    if (cfgT > 0.5) { cfgT = 0; configure(s, j, agl); }
  }
  // Play: called by app.js in place of its own readInputs while in Casual. The law runs at 30 Hz or
  // faster in simulated time whatever the frame rate: a long frame is flown in sub-steps here, the
  // last one left to the frame (api.subDt is what it then advances by).
  function inputs(dt) {
    if (mode !== 'casual') { api.subDt = undefined; return false; }
    const n = Math.max(1, Math.ceil(dt / 0.034)), h = dt / n;
    for (let k = 0; k < n; ++k) {
      control(h);
      if (k < n - 1) { A.avd_set_input(input.pitch, input.roll, input.yaw, input.throttle, input.mixture, input.brake, input.brake, input.trimRate, 0); A.avd_advance(h); }
    }
    api.subDt = h;
    return true;
  }

  // ---- Rings and lane lights: two instanced meshes, unlit, so they read by day and at night ----
  const RMAX = 32, DMAX = 160;
  const ringMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.07, 10, 48), new THREE.MeshBasicMaterial({ fog: false, toneMapped: false }), RMAX);
  const dotMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ fog: false, toneMapped: false }), DMAX);
  for (const m of [ringMesh, dotMesh]) { m.count = 0; m.frustumCulled = false; m.renderOrder = 2; ctx.scene.add(m); }
  const COL = { next: new THREE.Color('#ffd23c'), later: new THREE.Color('#38c8f5'), far: new THREE.Color('#2b86b8'), low: new THREE.Color('#ff9a3c'), high: new THREE.Color('#58d6ff') };
  const M4 = new THREE.Matrix4(), Q4 = new THREE.Quaternion(), V3 = new THREE.Vector3(), S3 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), C4 = new THREE.Color();
  let rings = [];  // { label, e, n, z, r, hdg, done }
  // A ring's centre: `h` above the ground under it, lifted if the ground round it would touch the rim.
  function ringAt(label, e, n, h, r, hdg = 0) {
    let g = groundAt(e, n);
    for (let a = 0; a < 8; ++a) g = Math.max(g, groundAt(e + r * Math.cos(a * Math.PI / 4), n + r * Math.sin(a * Math.PI / 4)));
    return { label, e, n, z: Math.max(groundAt(e, n) + h, g + r + 15), r, hdg, done: false };
  }
  function drawRings(pulse = 1) {
    let k = 0;
    const next = rings.findIndex((r) => !r.done), target = act.kind === 'free' ? act.target : next;
    rings.forEach((r, i) => {
      if (r.done || k >= RMAX) return;
      const s = r.r * (i === target ? pulse : 1);
      Q4.setFromAxisAngle(UP, Math.PI - r.hdg * DEG);
      M4.compose(V3.set(r.e, r.z, -r.n), Q4, S3.set(s, s, s));
      ringMesh.setMatrixAt(k, M4);
      ringMesh.setColorAt(k, i === target ? C4.copy(COL.next).multiplyScalar(0.82 + 0.18 * pulse) : act.kind === 'free' || i === next + 1 ? COL.later : COL.far);
      ++k;
    });
    ringMesh.count = k; ringMesh.instanceMatrix.needsUpdate = true;
    if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
  }
  function setRings(list) { rings = list; drawRings(); }
  function setDots(list) {  // [[e, n, z, colour, size]]
    list.slice(0, DMAX).forEach(([e, n, z, c, sz], k) => { M4.compose(V3.set(e, z, -n), Q4.identity(), S3.set(sz, sz, sz)); dotMesh.setMatrixAt(k, M4); dotMesh.setColorAt(k, c); });
    dotMesh.count = Math.min(list.length, DMAX); dotMesh.instanceMatrix.needsUpdate = true;
    if (dotMesh.instanceColor) dotMesh.instanceColor.needsUpdate = true;
  }

  // ---- Activities ----
  const emit = (type, extra = {}) => {
    const ev = { type, id: act.def?.id || null, seed: act.seed ?? null, ...extra };
    for (const fn of listeners) try { fn(ev); } catch (e) { console.error(e); }
    dispatchEvent(new CustomEvent('spw:challenge', { detail: ev }));
  };
  // A free flight: a ring over every sight not yet seen; the nearest is the goal.
  function startFree(ph = 'fly', respawn = true) {
    if (act.def && !act.over) emit('quit');
    act = { kind: 'free', target: -1 };
    body.classList.remove('p-task');
    if (respawn) spawnFree(ph); else { phase = ph; refreshButtons(); }
    sightRings();
  }
  function sightRings() {
    const big = kind !== 'piston';
    if (seen.size >= SIGHTS.length) { seen = new Set(); store.set('play:sights', []); }
    setRings(SIGHTS.map(([label, e, n, h]) => ({ ...ringAt(label, e, n, big ? h + 170 : h, big ? 130 : 48), done: seen.has(label) })));
    setDots([]);
    nextSight();
  }
  function nextSight(skip = false) {
    const s = ctx.state(), was = act.target;
    let bestI = -1, bestD = Infinity;
    rings.forEach((r, i) => { const d = Math.hypot(r.e - s[0], r.n - s[1]); if (!r.done && d < bestD && !(skip && i === was)) { bestD = d; bestI = i; } });
    act.target = bestI;
  }
  async function startChallenge(id, { seed = null, intro = false } = {}) {
    const def = challengeById(id);
    if (!def) return false;
    if (act.def && !act.over) emit('quit');
    if (mode !== 'casual') enterCasual();
    closeScreen();
    if (P().id !== def.aircraft) await ctx.selectAircraft(def.aircraft);
    act = { kind: def.kind, def, seed, i: 0, missed: 0, t0: 0, started: false, over: false };
    body.classList.add('p-task');  // (a challenge shows its own goals: the landmark labels step aside)
    speed = 1;
    const here = ctx.region().flatMap((ap) => ap.ends.map((r) => ({ r, ap }))).find(({ r }) => Math.hypot(r.east - RW[0], r.north - RW[1]) < 2);
    if (def.kind === 'rings') {
      const st = def.start;
      spawnAir(st.e, st.n, st.h, st.hdg, st.kt);
      const pts = [[st.e, st.n], ...def.rings.map((r) => [r[1], r[2]])];
      // Each ring faces along the course through it: from the one before toward the one after.
      setRings(def.rings.map(([label, e, n, h], i) => {
        const a = pts[i], b = pts[Math.min(i + 2, pts.length - 1)];
        return ringAt(label, e, n, h, def.r, (Math.atan2(b[0] - a[0], b[1] - a[1]) / DEG + 360) % 360);
      }));
      setDots([]);
      speed = st.kt >= L.speeds[2] - 20 ? 2 : 1;
    } else if (def.kind === 'lowpass') {
      const st = def.start;
      spawnAir(st.e, st.n, st.h, st.hdg, st.kt);
      const [a, b] = [def.a, def.b], len = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      Object.assign(act, { len, u, inside: 0, flown: 0, in: false, state: '' });
      const dots = [];
      for (let d = 0; d <= len + 1; d += len / Math.round(len / 130)) for (const side of [-1, 1]) {
        const e = a[0] + u[0] * d + side * u[1] * def.w, n = a[1] + u[1] * d - side * u[0] * def.w, g = groundAt(a[0] + u[0] * d, a[1] + u[1] * d);
        dots.push([e, n, g + def.band[0], COL.low, 5], [e, n, g + def.band[1], COL.high, 5]);
      }
      setRings([]); setDots(dots);
    } else {
      // A landing: on (or near) the 3 degree path to the runway in use.
      const f = def.final, r = here.r, sh = Math.sin(r.heading * DEG), ch = Math.cos(r.heading * DEG);
      const wind = def.wind ? [def.wind[0], (r.heading + def.wind[1] + 360) % 360] : null;
      const thr = [r.east + sh * r.displaced, r.north + ch * r.displaced];
      if (f.side || f.high || def.engine === false) {
        const D = f.km * 1000, e = thr[0] - sh * D + ch * (f.side || 0), n = thr[1] - ch * D - sh * (f.side || 0);
        const z = here.ap.elevation + (D + 300) * Math.tan(3 * DEG) + (f.high || 0);
        const aim = [thr[0] + sh * 150, thr[1] + ch * 150];
        ctx.spawn({ name: def.name, sub: '', trim: true, go: () => { fairWeather(wind); A.avd_reset_air(e, n, z - RW[2], (Math.atan2(aim[0] - e, aim[1] - n) / DEG + 360) % 360, f.kt || 70, 1); } });
      } else ctx.spawn({ name: def.name, sub: '', trim: true, go: () => { fairWeather(wind); A.avd_reset_final(f.km * 1000, f.kt || 0); } });
      afterSpawn('approach');
      act.vApp = A.state()[10];
      rwy = { r, ap: here.ap }; toHdg = r.heading;
      act.aim = [thr[0] + sh * 300, thr[1] + ch * 300, here.ap.elevation];
      act.rwName = ctx.AP.runway;
      act.gear = groundGap();
      if (def.engine === false) ctx.setControl('engine1.ignition', 0);
      setRings([]); setDots([]);
    }
    refreshButtons();
    emit('start');
    if (intro) showIntro(def); else begin();
    return true;
  }
  function begin() {
    act.started = true; act.t0 = A.state()[42]; prev = null;
    if (act.def?.engine === false) note(T.engineOut, 4);
  }
  function finish(result) {
    act.over = true;
    const id = act.def.id, old = best[id], better = !old || (result.higher ? result.value > old.value : result.value < old.value);
    if (better) { best[id] = { value: result.value, stars: result.stars, text: result.text }; store.set('play:best', best); }
    result.newBest = better && !!old;
    if (phase === 'fly' || phase === 'climbout') phase = 'attract';
    emit('finish', { result: { value: result.value, stars: result.stars, text: result.text } });
    showResult(result);
  }
  let prev = null;  // the aircraft's position a frame ago (rings are crossed between the two)
  const prevBuf = [0, 0, 0];
  function playRings(s) {
    const r = rings[act.i];
    if (!r || !prev) return;
    const nx = Math.sin(r.hdg * DEG), ny = Math.cos(r.hdg * DEG);
    const d0 = (prev[0] - r.e) * nx + (prev[1] - r.n) * ny, d1 = (s[0] - r.e) * nx + (s[1] - r.n) * ny;
    if (d0 === d1 || (d0 < 0) === (d1 < 0)) return;
    const f = d0 / (d0 - d1), miss = Math.hypot(prev[0] + f * (s[0] - prev[0]) - r.e, prev[1] + f * (s[1] - prev[1]) - r.n, prev[2] + f * (s[2] - prev[2]) - r.z);
    if (miss <= r.r * 1.05) { r.done = true; ++act.i; blip(true); tipDone('ring'); }
    else if (miss < 5 * r.r && d0 < 0) { r.done = true; ++act.i; ++act.missed; note(T.ringMiss, 1.5); blip(false); }
    else return;
    drawRings();
    if (act.i >= rings.length) {
      const t = s[42] - act.t0 + act.missed * MISS_PENALTY;
      finish({ value: +t.toFixed(1), text: fmtTime(t), stars: starsFor(t, act.def.stars), lines: act.missed ? [T.missed(act.missed)] : [] });
    }
  }
  function playLane(s) {
    const d = act.def, along = (s[0] - d.a[0]) * act.u[0] + (s[1] - d.a[1]) * act.u[1], lat = (s[0] - d.a[0]) * act.u[1] - (s[1] - d.a[1]) * act.u[0];
    const h = s[2] - groundAt(s[0], s[1]);
    const inLane = Math.abs(lat) <= d.w && h >= d.band[0] && h <= d.band[1];
    act.state = Math.abs(lat) > d.w ? (lat > 0 ? '← left' : 'right →') : h < d.band[0] ? '↑ higher' : h > d.band[1] ? '↓ lower' : '';
    if (prev && along > 0 && act.last !== undefined) { const step = clamp(along, 0, act.len) - clamp(act.last, 0, act.len); if (step > 0) { act.flown += step; if (inLane) act.inside += step; } }
    act.last = along;
    const done = along >= act.len, lost = Math.abs(lat) > 1500 || along < -2500;
    if (done || lost) {
      const pct = Math.round(100 * act.inside / act.len);
      finish({ value: pct, higher: true, text: `${pct} %`, stars: starsFor(pct, d.stars, true), lines: [lost ? T.leftLane : T.inLane(pct)] });
    }
  }
  function playFree(s) {
    for (let i = 0; i < rings.length; ++i) {
      const r = rings[i];
      if (r.done || Math.hypot(r.e - s[0], r.n - s[1], r.z - s[2]) > r.r) continue;
      r.done = true; seen.add(r.label); store.set('play:sights', [...seen]);
      blip(true); tipDone('ring');
      note(seen.size >= SIGHTS.length ? T.sightsDone : T.sight(r.label, seen.size, SIGHTS.length), 3.5);
      if (seen.size >= SIGHTS.length) sightRings(); else { nextSight(); drawRings(); }
    }
  }
  // A short tone for a ring (two for a miss), with the sound on.
  function blip(good) {
    const a = ctx.audio?.();
    if (!ui.sound || !a) return;
    try {
      const t = a.currentTime, g = a.createGain(), o = a.createOscillator();
      o.type = 'sine'; o.connect(g); g.connect(a.destination);
      o.frequency.setValueAtTime(good ? 880 : 300, t); if (good) o.frequency.setValueAtTime(1320, t + 0.09);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16 * ui.vol / 100 + 0.0001, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t); o.stop(t + 0.32);
    } catch { /* no audio */ }
  }

  // ---- The landing score: after any touchdown, in every mode ----
  let landing = null, lastSim = 0, crash = null, crashWhy = '', landT = 0;
  // Play: every event line from the core passes here first (app.js handleEvents).
  function event(e) {
    const s = A.state();
    if (e.startsWith('Lift-off')) { if (!landing || landing.done) air.sim = s[42]; }
    else if (e.startsWith('Touchdown')) {
      const fpm = Math.abs(+(e.match(/(-?\d+) fpm/)?.[1] || 0));
      if (landing && !landing.done) { landing.bounces++; landing.fpm = Math.max(landing.fpm, fpm); landing.last = s[42]; }
      else if (s[42] - air.sim > 4) {  // a flight ended here, not a skip on the take-off roll
        const j = A.jet(), near = runwayNear(s[0], s[1], s[61], 300);
        landing = { fpm, kias: s[10], vref: 1.3 * j[34], gs0: s[12], bounces: 0, last: s[42], done: false,
          runway: !!near && near.along > -200, off: near ? near.off : 0, along: near ? near.along - near.r.displaced : 0,
          length: near ? near.r.length - near.r.displaced : 0, halfWidth: near ? near.r.width / 2 : 0 };
      }
    } else if (/^(PROPELLER STRIKE|Airframe ground contact|Building strike|STRUCTURAL FAILURE)/.test(e)) crashWhy = e;
  }
  function trackLanding(s) {
    if (s[42] < lastSim - 0.5) { landing = null; air.sim = s[42]; }  // a restart
    lastSim = s[42];
    if (!landing || landing.done) return;
    if (ui.crashed) { landing = null; return; }
    if (!s[28] || s[42] - landing.last < 3) return;  // three seconds on the wheels: no more bounces to count
    landing.done = true;
    const res = scoreLanding(landing, { metric: mode === 'casual' });
    if (mode === 'casual' && act.kind === 'landing' && !act.over) { act.result = res; return; }
    showLanding(res);
  }
  const partsHtml = (parts) => `<div class="pParts">${parts.map((p) => `<div><span>${T.parts[p.key]}</span><span><i style="--v:${Math.round(p.score)}%;--c:${p.score >= 80 ? 'var(--good)' : p.score >= 50 ? 'var(--warn)' : 'var(--bad)'}"></i><b>${p.text}</b></span></div>`).join('')}</div>`
    .replace(/<span><i /g, '<span style="display:grid;gap:3px"><i ');
  function showLanding(res) {
    landEl.innerHTML = `<header><span>${T.landingScore} · ${res.word}</span><b>${res.grade}</b></header><ul>${res.parts.map((p) =>
      `<li class="${p.score >= 80 ? 'ok' : p.score >= 50 ? 'so' : 'bad'}"><span>${T.parts[p.key]}</span><b>${p.text}</b></li>`).join('')}</ul>`;
    landEl.hidden = false; landT = 10;
  }
  landEl.addEventListener('click', () => { landEl.hidden = true; });

  // ---- Buttons ----
  // Where the core's autoland does not bring the type down in one piece, "Land for me" is not offered: the 737
  // (from the simulator's own Final start too, it touches down at 400 ft/min and strikes both nacelles).
  const NO_AUTOLAND = new Set(['b738']);
  function refreshButtons() {
    const flying = phase === 'fly' || phase === 'climbout';
    const main = phase === 'autoland' || phase === 'tofinal' ? T.cancelLanding : phase === 'landed' ? `${ICON.up}${T.takeOff}`
      : act.kind === 'free' && flying && !NO_AUTOLAND.has(P().id) ? `${ICON.land}${T.landForMe}` : '';
    mainB.hidden = !main;
    if (main) mainB.innerHTML = main + (MOBILE ? '' : ' <kbd>L</kbd>');
    q('#pSpd').style.display = flying || phase === 'attract' ? '' : 'none';
    q('#pSpd').querySelectorAll('.pips i').forEach((p, i) => p.classList.toggle('on', i <= speed));
    q('#pLvl').textContent = T.speeds[speed];
    q('#pSndB').setAttribute('aria-pressed', String(!!ui.sound));
  }
  function setSpeed(n) {
    n = clamp(n, 0, 2);
    if (n === speed) return;
    speed = n; refreshButtons();
  }
  function sound(on) {
    if (!!ui.sound !== on) ctx.toggleSound();
    wantSound = on; store.set('play:sound', on); refreshButtons();
  }
  function cam() { do ctx.cycleCam(); while (ui.cam > 1); }
  function again() {
    closeScreen();
    if (act.def) startChallenge(act.def.id, { seed: act.seed }); else startFree('fly', true);
  }
  // "Land for me": the nearest of the region's airports, the runway end whose final is the shortest way round.
  function landForMe() {
    const s = ctx.state(), names = ctx.dests(), Df = kind === 'piston' ? 2800 : 8000;
    // An airliner's approach speed wants a long runway (Congonhas is too short for the autoland to stop it): Guarulhos.
    const need = 1.3 * A.jet()[34] > 128 ? 2300 : 0;
    let pick = null;
    ctx.region().slice(0, ctx.regionN).forEach((ap, i) => ap.ends.forEach((r, k) => {
      const sh = Math.sin(r.heading * DEG), ch = Math.cos(r.heading * DEG), fx = r.east - sh * (Df + 600), fy = r.north - ch * (Df + 600);
      // The way to its final, a turn back counted double.
      const d = Math.hypot(fx - s[0], fy - s[1]) + Math.hypot(r.east - s[0], r.north - s[1]) + 2 * Math.max(0, (s[0] - fx) * sh + (s[1] - fy) * ch);
      if (r.length - r.displaced >= need && Math.hypot(r.east - s[0], r.north - s[1]) < 60000 && (!pick || d < pick.d)) pick = { d, r, k, i, elev: ap.elevation };
    }));
    if (!pick) { note(T.noRunway, 3); return; }
    ctx.destination(names[pick.i].icao, pick.k);
    act.land = { r: pick.r, elev: pick.elev, Df, side: 0, leg: 0, out: 0 };
    act.field = { name: names[pick.i].name, i: pick.i };
    phase = 'tofinal'; cfgT = 1;
    note(T.landing(act.field.name), 3); refreshButtons();
  }
  function takeOff() {
    let s = A.state();
    // Enough runway ahead for this aircraft? If not (stopped far down it, or not on one), from the head of the home runway.
    const need = kind === 'piston' ? 550 : kind === 'turboprop' ? 1200 : 1.3 * A.jet()[34] > 128 ? 1750 : 1500;
    rwy = runwayNear(s[0], s[1], s[9], 100);
    if (!rwy || rwy.r.length - rwy.along < need) {
      ctx.spawn({ name: T.takeOff, sub: '', thr: 0.1, go: () => { fairWeather(); A.avd_reset(1); } });
      afterSpawn('landed', 0.1);
      s = A.state(); rwy = runwayNear(s[0], s[1], s[9], 100);
    }
    const j = A.jet();
    toHdg = rwy ? rwy.r.heading : s[9];
    vR = kind === 'piston' ? 55 : kind === 'turboprop' ? Math.round(1.1 * j[33]) : Math.round(1.2 * j[33]) - 6;
    ctx.setControl('brakes.parking', 0);
    if (ctx.controlPos('speedbrake.lever')) ctx.setControl('speedbrake.lever', 0);
    law.reset(0.1); phase = 'takeoff'; cfgT = 1; flapT = -9; speed = 1;
    note(T.takingOff, 2.5); refreshButtons();
  }
  function mainAction() {
    if (!casualFlying() || mainB.hidden) return;
    if (phase === 'tofinal') { phase = 'fly'; law.st.hdg = null; law.st.alt = null; refreshButtons(); }
    else if (phase === 'autoland') { ctx.setAutoland(false); phase = 'fly'; law.reset(clamp(A.state()[24], 0, 1)); refreshButtons(); }
    else if (phase === 'landed') takeOff();
    else landForMe();
  }
  mainB.addEventListener('click', (e) => { mainAction(); e.currentTarget.blur(); });
  q('#pFast').addEventListener('click', (e) => { setSpeed(speed + 1); e.currentTarget.blur(); });
  q('#pSlow').addEventListener('click', (e) => { setSpeed(speed - 1); e.currentTarget.blur(); });
  q('#pHomeB').addEventListener('click', (e) => { home(); e.currentTarget.blur(); });
  q('#pCamB').addEventListener('click', (e) => { cam(); e.currentTarget.blur(); });
  q('#pSndB').addEventListener('click', (e) => { sound(!ui.sound); e.currentTarget.blur(); });
  q('#pAgainB').addEventListener('click', (e) => { again(); e.currentTarget.blur(); });
  simHome.addEventListener('click', (e) => { home(); e.currentTarget.blur(); });
  goalEl.addEventListener('click', () => { if (act.kind === 'free' && phase === 'fly') { nextSight(true); drawRings(); } });

  // ---- Screens ----
  function openScreen(name, html, cls = '') {
    over.className = `pOver ${cls}`; over.innerHTML = html; over.hidden = false; over.scrollTop = 0;
    screen = name; body.classList.add('p-over'); body.classList.toggle('p-front', name === 'home' || name === 'list');
    stick.id = null; stick.px = stick.py = 0; placeStick(false); keys.clear();
    for (const b of over.querySelectorAll('button')) b.addEventListener('click', () => b.blur());
  }
  function closeScreen() { over.hidden = true; over.innerHTML = ''; screen = null; body.classList.remove('p-over', 'p-front'); }
  const starsHtml = (n, cls = '') => `<div class="pStars ${cls}" aria-label="${n} of 3 stars">${'<b>★</b>'.repeat(n)}${'★'.repeat(3 - n)}</div>`;
  const bestLine = (id) => (best[id] ? `${T.best}: ${best[id].text}` : T.noBest);
  let simPaused = false, homeFrom = null;
  // The front door. From the simulator it freezes the flight behind it; from Casual the co-pilot circles.
  function home() {
    homeFrom = mode === 'sim' ? 'sim' : store.get('play:mode', null) ? 'casual' : null;
    if (mode === 'sim') { if (!screen) { simPaused = ui.paused; ui.paused = true; } }
    else {
      if (act.def && !act.over) { emit('quit'); act.over = true; }
      if (ui.paused) ui.paused = false;
      if (phase === 'fly' || phase === 'climbout' || phase === 'approach') phase = 'attract';
    }
    const fr = friends || (typeof window.spwFriends === 'function' ? { open: window.spwFriends } : null);
    const cur = P().id, planes = Object.keys(AIRCRAFT).includes(cur) ? Object.keys(AIRCRAFT) : [...Object.keys(AIRCRAFT), cur];
    openScreen('home', `<div class="pWrap">
      <h1 class="pTitle">${T.title}</h1><p class="pSub">${T.sub}</p>
      <div class="pCards">
        <button class="pCardB main" data-go="fly" data-primary ${homeFrom === 'casual' ? 'data-back' : ''}>${ICON.plane}<b>${T.justFly}</b><span>${T.justFlySub}</span></button>
        <button class="pCardB" data-go="list">${ICON.rings}<b>${T.challenges}</b><span>${T.challengesSub}</span></button>
        <button class="pCardB" data-go="friends" ${fr ? '' : 'disabled'}>${ICON.friends}<b>${fr?.label || T.friends}${fr ? '' : `<i class="soon">${T.soon}</i>`}</b><span>${T.friendsSub}</span></button>
        <button class="pCardB" data-go="sim" ${homeFrom === 'sim' ? 'data-back' : ''}>${ICON.gauge}<b>${T.sim}</b><span>${T.simSub}</span></button>
      </div>
      <div class="pRow" role="group" aria-label="${T.plane}"><span>${T.plane}</span>${planes.map((id) => `<button class="pSeg" data-plane="${id}" aria-pressed="${id === cur}" title="${ctx.PROFILES[id].name}">${AIRCRAFT[id]?.label || ctx.PROFILES[id].name}</button>`).join('')}</div>
      <p class="pFoot">${T.siteLink}</p></div>`);
    over.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go, fr)));
    over.querySelectorAll('[data-plane]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.plane === P().id) return;
      plane = b.dataset.plane; store.set('play:plane', plane);
      over.querySelectorAll('[data-plane]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      await ctx.selectAircraft(plane);
      if (mode === 'casual') { startFree('attract', true); label(); }
    }));
  }
  function go(what, fr) {
    if (what === 'fly') {
      const stay = mode === 'casual' && act.kind === 'free' && !ui.crashed && (phase === 'attract' || phase === 'autoland' || phase === 'tofinal' || phase === 'landed');
      if (mode !== 'casual') enterCasual();
      store.set('play:mode', 'casual');
      closeScreen();
      if (stay) { if (phase === 'attract') phase = 'fly'; law.st.hdg = null; law.st.alt = null; refreshButtons(); } else startFree('fly', true);
      if (wantSound) sound(true);
    } else if (what === 'list') list();
    else if (what === 'friends') { if (fr) fr.open({ play: api }); }
    else if (what === 'sim') {
      store.set('play:mode', 'sim');
      closeScreen();
      if (mode === 'sim') ui.paused = simPaused; else enterSim();
    }
  }
  function list() {
    openScreen('list', `<div class="pList"><header><h2>${T.challenges}</h2><button class="pBtn" data-back>${T.back}</button></header>
      <div class="pGrid">${CHALLENGES.map((c) => `<button class="pCh" data-id="${c.id}"><i class="kind" style="font-style:normal">${T.kinds[c.kind]}</i><b>${c.name}</b><span>${c.blurb}</span>
        <small><span>${AIRCRAFT[c.aircraft]?.label || ''} · ${bestLine(c.id)}</span>${starsHtml(best[c.id]?.stars || 0, 'sm')}</small></button>`).join('')}</div></div>`);
    over.querySelector('[data-back]').addEventListener('click', home);
    over.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => { store.set('play:mode', 'casual'); startChallenge(b.dataset.id, { intro: true }); }));
  }
  function showIntro(def) {
    ui.paused = true;
    const how = def.kind === 'landing' && def.engine === false ? T.how.glide : T.how[def.kind];
    openScreen('intro', `<div class="pBox"><i class="tag" style="font-style:normal">${T.kinds[def.kind]}</i><h2>${def.name}</h2><p>${def.blurb}</p><p class="how">${how}</p>
      <p class="how">${AIRCRAFT[def.aircraft]?.label || ''} · ${bestLine(def.id)}</p>
      <div class="pBtns"><button class="pBtn go" data-primary>${T.start}</button><button class="pBtn" data-back>${T.back}</button></div></div>`, 'clear');
    over.querySelector('[data-primary]').addEventListener('click', () => { closeScreen(); ui.paused = false; if (wantSound) sound(true); begin(); });
    over.querySelector('[data-back]').addEventListener('click', () => { emit('quit'); act.over = true; list(); });
  }
  function showResult(res) {
    const def = act.def, k = CHALLENGES.indexOf(def), nxt = CHALLENGES[(k + 1) % CHALLENGES.length];
    const sum = `${'★'.repeat(res.stars)}${'☆'.repeat(3 - res.stars)} ${res.word ? `${res.word} (${res.text})` : res.text}`;
    openScreen('result', `<div class="pBox"><h2>${def.name}</h2>${starsHtml(res.stars)}
      <div class="big">${res.text}</div>${res.word ? `<p><b>${res.word}</b></p>` : ''}
      ${(res.lines || []).map((l) => `<p>${l}</p>`).join('')}${res.parts ? partsHtml(res.parts) : ''}
      <i class="tag" style="font-style:normal" ${res.newBest ? '' : 'hidden'}>${T.newBest}</i><p class="how">${bestLine(def.id)}</p>
      <div class="pBtns"><button class="pBtn go" data-primary>${ICON.again}${T.again}</button><button class="pBtn" data-next>${T.next}: ${nxt.name}</button>
        <button class="pBtn" data-share>${T.share}</button><button class="pBtn" data-back>${T.challenges}</button></div></div>`, 'clear');
    over.querySelector('[data-primary]').addEventListener('click', again);
    over.querySelector('[data-next]').addEventListener('click', () => startChallenge(nxt.id, { intro: true }));
    over.querySelector('[data-back]').addEventListener('click', list);
    over.querySelector('[data-share]').addEventListener('click', async (e) => { const b = e.currentTarget, r = await share(def, sum); if (r === 'copied') { b.textContent = T.copied; setTimeout(() => { b.textContent = T.share; }, 2500); } });
  }
  function showCrash() {
    const s = ctx.state(), near = runwayNear(s[0], s[1], s[9], 400);
    const why = /^Building/.test(crashWhy) ? T.crashBuilding : /^STRUCTURAL/.test(crashWhy) ? T.crashBreak
      : !crashWhy ? T.crashDamage : (act.kind === 'landing' || phase === 'rollout' || phase === 'approach') && near ? T.crashLanding : T.crashGround;
    if (act.def && !act.over) { act.over = true; emit('finish', { result: { value: 0, stars: 0, text: 'crash' } }); }
    openScreen('crash', `<div class="pBox"><h2>${T.crash}</h2><p>${why}</p>
      <div class="pBtns"><button class="pBtn go" data-primary>${ICON.again}${T.again} ${MOBILE ? '' : '<kbd>R</kbd>'}</button><button class="pBtn" data-back>${T.home}</button></div></div>`, 'clear');
    over.querySelector('[data-primary]').addEventListener('click', again);
    over.querySelector('[data-back]').addEventListener('click', () => { startFree('attract', true); home(); });
  }
  function pause() {
    if (!casualFlying() || ui.crashed) return;
    ui.paused = true;
    openScreen('pause', `<div class="pBox"><h2>${T.paused}</h2>
      <div class="pBtns"><button class="pBtn go" data-primary data-back>${T.resume}</button><button class="pBtn" data-again>${ICON.again}${T.again}</button><button class="pBtn" data-home>${T.home}</button></div></div>`, 'dim');
    over.querySelector('[data-primary]').addEventListener('click', () => { closeScreen(); ui.paused = false; });
    over.querySelector('[data-again]').addEventListener('click', again);
    over.querySelector('[data-home]').addEventListener('click', () => { ui.paused = false; home(); });
  }
  // A short text and a link that opens this challenge: the share sheet on a phone, the clipboard elsewhere.
  async function share(def, summary) {
    const url = new URL(location.href);
    url.search = ''; url.hash = ''; url.searchParams.set('c', def.id);
    if (act.seed !== null && act.seed !== undefined) url.searchParams.set('s', act.seed);
    const text = T.shareText(def.name, summary);
    api.lastShare = { text, url: String(url) };
    if (navigator.share && MOBILE) {
      try { await navigator.share({ title: T.game, text, url: String(url) }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return ''; }
    }
    try { await navigator.clipboard.writeText(`${text} ${url}`); return 'copied'; } catch { /* no clipboard: the old way */ }
    const ta = el('<textarea style="position:fixed;opacity:0"></textarea>');
    ta.value = `${text} ${url}`; body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* blocked */ }
    ta.remove();
    return ok ? 'copied' : '';
  }

  // ---- Modes ----
  function label() {
    const sub = document.getElementById('plateSub');
    if (mode === 'casual') { sub.textContent = T.game; document.title = `${T.game} · São Paulo World`; }
    else { sub.textContent = `Flight simulator · ${P().name}`; document.title = `Flight Simulator · ${P().name}`; }
  }
  function enterCasual() {
    mode = 'casual'; body.classList.add('casual');
    ui.instr = false;  // the instrument strip is not drawn at all in Casual (its saved setting is the simulator's)
    ctx.flowOff();     // nor the airflow view's wind tunnel
    if (ui.cam > 1) cam();
    label();
  }
  // Back to the simulator, as the player left it: its weather, assists, alerts and destination; on the runway.
  function enterSim() {
    if (act.def && !act.over) emit('quit');
    if (ctx.autoland()) ctx.setAutoland(false);
    mode = 'sim'; body.classList.remove('casual', 'p-task');
    act = { kind: 'free', target: -1 }; setRings([]); setDots([]);
    mark.classList.remove('on'); landEl.hidden = true; tipEl.hidden = true; tipKey = null;
    look.held = false; ui.paused = false; api.subDt = undefined;
    ui.instr = store.get('instr', true);
    A.avd_set_level_hold(ui.level ? 1 : 0);
    ctx.simRestore();
    ctx.restart(0);
    label();
  }

  // ---- Each frame ----
  const hudEls = { v: q('#pV'), h: q('#pH'), vu: q('#pVU'), hu: q('#pHU') };
  let hudT = 0, tipT = 0;
  const km = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
  function drawHud(s, dt) {
    const agl = s[14] * 0.3048, gnd = s[28] > 0.5, mph = ui.units === 'mph';
    hudT += dt;
    // Where the goal is.
    let goal = null;
    if (act.kind === 'free' && phase !== 'autoland' && phase !== 'tofinal' && phase !== 'landed' && phase !== 'rollout') { const r = rings[act.target]; if (r) goal = [r.e, r.n, r.z]; }
    else if (act.kind === 'rings' && rings[act.i]) goal = [rings[act.i].e, rings[act.i].n, rings[act.i].z];
    else if (act.kind === 'lowpass' && !act.over) { const d = act.def, p = (act.last || 0) < 0 ? d.a : d.b; goal = [p[0], p[1], groundAt(p[0], p[1]) + (d.band[0] + d.band[1]) / 2]; }
    else if (act.kind === 'landing' && phase === 'approach') goal = act.aim;
    if (goal && !ui.crashed) {
      V3.set(goal[0], goal[2], -goal[1]).project(ctx.camera);
      let x = V3.x, y = V3.y;
      const behind = V3.z > 1;
      if (behind) { x = -x; y = -y; }
      const onScreen = !behind && Math.abs(x) < 0.9 && y < 0.72 && y > -0.86;
      if (!onScreen) { const m = Math.max(Math.abs(x) / 0.9, y > 0 ? y / 0.72 : -y / 0.86, 1e-3); x /= m; y /= m; }
      const px = (x + 1) / 2 * innerWidth, py = (1 - y) / 2 * innerHeight;
      mark.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px)`;
      mark.classList.toggle('edge', !onScreen);
      if (!onScreen) { mark.style.setProperty('--rot', `${Math.atan2(x * innerWidth, y * innerHeight) / DEG}deg`); mark.style.setProperty('--tx', x > 0.5 ? '-24px' : '24px'); mark.style.setProperty('--ts', x > 0.5 ? '-100%' : '0'); }
      mark.classList.add('on');
      if (hudT > 0.1) mark.lastElementChild.textContent = km(Math.hypot(goal[0] - s[0], goal[1] - s[1]));
    } else mark.classList.remove('on');
    if (hudT < 0.1) return;
    hudT = 0;
    hudEls.v.textContent = Math.round(s[10] * (mph ? 1.150779 : 1.852)); hudEls.vu.textContent = mph ? T.mph : T.kmh;
    hudEls.h.textContent = gnd ? 0 : Math.round(agl * (mph ? 3.28084 : 1) / (agl > 300 ? 10 : 1)) * (agl > 300 ? 10 : 1); hudEls.hu.textContent = mph ? T.ft : T.m;
    // The goal, in words.
    let g = null;
    if ((phase === 'autoland' || phase === 'tofinal') && act.field) g = ['', T.landing(act.field.name), km(Math.hypot(act.land.r.east - s[0], act.land.r.north - s[1]))];
    else if (act.kind === 'free' && rings[act.target] && phase !== 'landed' && phase !== 'rollout') g = ['', rings[act.target].label, `${seen.size} / ${SIGHTS.length}`];
    else if (act.kind === 'rings' && !act.over) g = [fmtTime(Math.max(0, s[42] - act.t0) + act.missed * MISS_PENALTY), T.goalRing(Math.min(act.i + 1, rings.length), rings.length), rings[act.i]?.label || ''];
    else if (act.kind === 'lowpass' && !act.over) g = [`${Math.round(100 * act.inside / act.len)} %`, T.goalLane, act.last > 0 ? act.state : ''];
    else if (act.kind === 'landing' && phase === 'approach') g = ['', T.goalRunway(act.rwName), km(Math.hypot(act.aim[0] - s[0], act.aim[1] - s[1]))];
    goalEl.hidden = !g;
    if (g) { goalEl.children[0].textContent = g[0]; goalEl.children[0].hidden = !g[0]; goalEl.children[1].textContent = g[1]; goalEl.children[2].textContent = g[2]; }
    // The one warning Casual has: the ground coming up fast.
    const vs = law.out.vs || 0, pull = phase === 'fly' && !gnd && vs < -2.5 && agl < 260 && agl / -vs < 5 && !ui.crashed;
    alertEl.hidden = !pull; if (pull) alertEl.textContent = T.pullUp;
  }
  function hints(s, dt) {
    if (phase === 'fly' && act.kind !== 'landing') {
      tipT += dt;
      if (!tips.steer) { if (tipT > 1.2) tip('steer', MOBILE ? T.tipSteerTouch : T.tipSteerKeys); if (tipKey === 'steer' && now() - stick.used < 0.3 && (stick.steered = (stick.steered || 0) + dt) > 1.5) { tipDone('steer'); tipT = 0; } }
      else if (!tips.hands) { if (tipT > 1 && now() - stick.used > 0.4) tip('hands', T.tipHands); if (tipKey === 'hands' && tipT > 7) { tipDone('hands'); tipT = 0; } }
      else if (!tips.ring && (act.kind === 'rings' || act.kind === 'free')) { const r = act.kind === 'free' ? rings[act.target] : rings[act.i]; if (r && tipT > 1.5 && Math.hypot(r.e - s[0], r.n - s[1]) < 2500) tip('ring', T.tipRing); }
    } else if (phase === 'approach' && !tips.flare && s[14] * 0.3048 < 35) tip('flare', T.tipFlare);
    if (tipKey === 'flare' && s[28]) tipDone('flare');
  }
  let pulseT = 0;
  // Play: called by app.js every frame after the state is read, in every mode.
  function update(dt) {
    const s = ctx.state();
    trackLanding(s);
    if (noteT > 0 && (noteT -= dt) <= 0) noteEl.classList.remove('on');
    if (landT > 0 && (landT -= dt) <= 0) landEl.hidden = true;
    if (mode !== 'casual') return;
    if (ui.crashed && !crash) crash = { t: now() };
    if (crash && !crash.shown && now() - crash.t > 0.8) { crash.shown = true; showCrash(); }
    // Behind the welcome screen the view drifts round the aircraft.
    const drift = screen === 'home' || screen === 'list';
    look.held = drift;
    if (drift) { look.yaw += dt * 0.07; look.pitch += (0.12 - look.pitch) * Math.min(1, dt); }
    if (phase === 'autoland') {
      if (!ctx.autoland()) { phase = s[28] ? 'landed' : 'fly'; law.reset(clamp(s[24], 0, 1)); refreshButtons(); }
      else if (ctx.autolandStatus().phase === 4) { ctx.setAutoland(false); phase = 'landed'; note(T.landed, 3); refreshButtons(); }
    }
    if (!screen && !ui.paused && !ui.crashed) {
      if (act.kind === 'free') playFree(s);
      else if (act.started && !act.over) {
        if (act.kind === 'rings') playRings(s);
        else if (act.kind === 'lowpass') playLane(s);
        else if (act.result && (phase === 'landed' || !landing || s[42] - landing.last > 7)) {
          const r = act.result;
          finish({ value: r.score, higher: true, text: r.grade, word: r.word, stars: r.stars, parts: r.parts });
        }
      }
      hints(s, dt);
    }
    prevBuf[0] = s[0]; prevBuf[1] = s[1]; prevBuf[2] = s[2]; prev = prevBuf;
    // The goal ring breathes; a sight's ring turns to face the aircraft.
    pulseT += dt;
    if (rings.length && !ui.paused) {
      if (act.kind === 'free' && rings[act.target]) { const r = rings[act.target]; r.hdg = Math.atan2(r.e - s[0], r.n - s[1]) / DEG; }
      drawRings(1 + 0.05 * Math.sin(pulseT * 5));
    }
    drawHud(s, dt);
  }
  // Play: Casual has no engineering messages; app.js's toasts stay with the simulator.
  const hush = () => mode === 'casual';

  const api = {
    inputs, update, event, hush, label, subDt: undefined, lastShare: null,
    get casual() { return mode === 'casual'; }, get mode() { return mode; },
    startChallenge, home, challenges: CHALLENGES,
    on(fn) { listeners.push(fn); },
    setFriends(open, text) { friends = open ? { open, label: text } : null; if (screen === 'home') home(); },
    current: () => ({ mode, kind: act.kind, id: act.def?.id || null, seed: act.seed ?? null, phase, screen }),
    // For scripts and checks.
    debug: { law, stick, keys, best, get act() { return act; }, get rings() { return rings; }, get L() { return L; }, get phase() { return phase; }, set phase(v) { phase = v; refreshButtons(); },
      get landing() { return landing; }, get speed() { return speed; }, setSpeed, mainAction, again, pause, startFree, takeOff, scoreLanding },
  };
  window.spwPlay = api;

  // ---- Start-up ----
  // A link to a challenge opens it; a returning player is back where they were; a first visit meets the welcome screen.
  const stored = store.get('play:mode', null), params = new URLSearchParams(location.search), link = challengeById(params.get('c'));
  if (link) { enterCasual(); startChallenge(link.id, { seed: params.get('s'), intro: true }); }
  else if (stored === 'sim' && !params.has('home')) label();
  else if (stored === 'casual' && !params.has('home')) { enterCasual(); startFree('fly', true); }
  else { enterCasual(); startFree('attract', true); home(); }
  return api;
}
