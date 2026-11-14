// São Paulo World · Golf: the game.
//
// The Golf Dynamics core (github.com/ZRosserMcIntosh/golf, MIT) runs in a
// worker (engine_worker.js): it builds the course, plays every shot
// (club-ball impact, flight, bounce, roll, the hole), applies the Rules,
// keeps the score and plans the computer golfers' shots. This page draws the
// course and the city around it, takes the swing, and animates each shot
// along the path the core computed.
import * as THREE from 'three';
import { buildCourseScene, skyDome } from './scene.js';
import { buildSurroundings } from './city.js';
import { encodeRound, decodeRound, joinRoom, newId } from './net.js';
import { makeGolfer, placeGolfer } from './golfer.js';

const $ = (id) => document.getElementById(id);
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 560;
const params = new URLSearchParams(location.search);
// Live rooms need a relay (golf repository, tools/relay). Configure the site's
// with window.GOLF_RELAY, or ?relay=wss://... ; ?relay=local plays between tabs.
const RELAY = params.get('relay') || window.GOLF_RELAY || '';
const LITE = params.has('lite');  // no city, no shadows (slow GPUs, tests)
const COLORS = ['#ffd36b', '#8fd8ff', '#ff8c7a', '#9cf08a', '#d9a5ff', '#ffffff', '#ffb35c', '#7ff0e0'];
const YD = 0.9144, MPH = 0.44704;
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');

// ---- The engine -----------------------------------------------------------------
const worker = new Worker(new URL('./engine_worker.js', import.meta.url), { type: 'module' });
let rpcSeq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const p = pending.get(id);
  pending.delete(id);
  if (p) ok ? p.res(result) : p.rej(new Error(error));
};
const rpc = (cmd, arg) => new Promise((res, rej) => { const id = ++rpcSeq; pending.set(id, { res, rej }); worker.postMessage({ id, cmd, arg }); });

// ---- Renderer, scene, lights -------------------------------------------------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = !MOBILE && !LITE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#c9dbe8', 1500, MOBILE ? 9000 : 14000);
scene.add(skyDome());
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 32000);
scene.add(new THREE.HemisphereLight('#cfe4ff', '#4b5a33', 0.9));
const sun = new THREE.DirectionalLight('#fff6e4', 2.1);
sun.position.set(-300, 600, 250);
sun.castShadow = !MOBILE && !LITE;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -70; sun.shadow.camera.right = 70; sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
sun.shadow.camera.near = 10; sun.shadow.camera.far = 1500;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---- Sounds (synthesised, no files) ------------------------------------------------
let actx = null;
function sound(kind, amount = 1) {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime, g = actx.createGain();
    g.connect(actx.destination);
    const noise = (dur, freq, q, vol) => {
      const n = actx.createBufferSource(), b = actx.createBuffer(1, Math.ceil(actx.sampleRate * dur), actx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      n.buffer = b;
      const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const gg = actx.createGain(); gg.gain.value = vol;
      n.connect(f).connect(gg).connect(g); n.start(t);
    };
    if (kind === 'hit') { noise(0.09, 2600 + 900 * amount, 1.2, 1.1 * amount); noise(0.04, 6000, 2, 0.5 * amount); }
    else if (kind === 'putt') noise(0.05, 1800, 3, 0.5 * amount);
    else if (kind === 'cup') { for (let k = 0; k < 3; k++) { const o = actx.createOscillator(), gg = actx.createGain(); o.frequency.value = 900 + 300 * k; gg.gain.setValueAtTime(0.18, t + k * 0.06); gg.gain.exponentialRampToValueAtTime(0.001, t + k * 0.06 + 0.12); o.connect(gg).connect(g); o.start(t + k * 0.06); o.stop(t + k * 0.06 + 0.15); } }
    else if (kind === 'splash') noise(0.5, 700, 0.6, 0.8);
    else if (kind === 'tree') noise(0.25, 1200, 0.8, 0.6);
    else if (kind === 'thud') noise(0.06, 300, 1, 0.5 * amount);
  } catch { /* no audio */ }
}

// ---- State --------------------------------------------------------------------
let info = null, course = null, H = null, city = null, clubs = null;
const game = {
  mode: 'solo',           // solo | live | turns
  cfg: null,              // the engine configuration
  owners: [],             // per player: the peer that plays it (live), or null
  local: new Set(),       // players this device plays
  state: null,            // the engine's state
  busy: false,            // a shot is being computed or animated
  started: false,
  shots: [],              // inputs, in order (for turn links)
  // This tab's identity in a live room; kept across a reload so a dropped
  // player rejoins as themselves.
  room: null, host: null, me: (() => { try { let v = sessionStorage.getItem('golf.peer'); if (!v) { v = newId(6); sessionStorage.setItem('golf.peer', v); } return v; } catch { return newId(6); } })(), lobby: new Map(),
};
const ui = {
  club: 0, aim: 0, shape: 0, height: 0, view: 'address',
  meter: { phase: 'idle', t0: 0, power: 0, mark: 0 },
  previewPath: null, previewDirty: true, caddie: null, suggestPower: null,
};
const balls = [];       // per player: { mesh, label }
let anim = null;        // the shot being animated
const tracer = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 }));
tracer.frustumCulled = false;
scene.add(tracer);
const aimLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: '#8fd8ff', dashSize: 2, gapSize: 1.4, transparent: true, opacity: 0.9, depthTest: false }));
aimLine.frustumCulled = false;
aimLine.renderOrder = 5;
scene.add(aimLine);
const golferFig = makeGolfer();
golferFig.visible = false;
scene.add(golferFig);
const CLUB_LENGTH = { DR: 1.156, W3: 1.092, W5: 1.067, H4: 1.016, I4: 0.984, I5: 0.972, I6: 0.959, I7: 0.946, I8: 0.933, I9: 0.921, PW: 0.908, GW: 0.902, SW: 0.895, LW: 0.889, PT: 0.864 };
const landRing = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), new THREE.MeshBasicMaterial({ color: '#8fd8ff', transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
landRing.rotation.x = -Math.PI / 2;
landRing.renderOrder = 6;
landRing.visible = false;
scene.add(landRing);

// ---- Loading ------------------------------------------------------------------
const loadMsg = (s, p) => { $('loadMsg').textContent = s; if (p != null) $('loadBar').style.width = `${p}%`; };
async function load() {
  loadMsg('Building the course (heights, surfaces, trees)…', 15);
  const r = await rpc('init', { courseUrl: './varzea.json' });
  info = r.info;
  loadMsg('Drawing the course…', 60);
  await new Promise((res) => setTimeout(res, 30));
  course = buildCourseScene({ info, heights: r.heights, surfaces: r.surfaces, trees: r.trees, renderer, mobile: MOBILE });
  H = course.H;
  scene.add(course.group);
  loadMsg('Calling the caddie…', 85);
  clubs = await rpc('clubs', 'scratch');
  $('courseBlurb').textContent = info.description;
  $('menuTitle').textContent = info.name;
  const sel = $('optSingle');
  info.holes.forEach((h, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${h.number} · ${h.name} · par ${h.par} · ${Math.round(h.length / YD)} yd`; sel.appendChild(o); });
  loadMsg('Ready', 100);
  setTimeout(() => { $('loading').style.display = 'none'; }, 150);
  // The city comes in behind, while the menu is up.
  if (!LITE) buildSurroundings({ info, renderer, mobile: MOBILE, courseHeight: H }).then((c) => { city = c; scene.add(c.group); }).catch((e) => console.warn('city', e));
  overviewCamera(0);
  await enter();
}

// ---- Menu: players and options --------------------------------------------------------
const setup = { players: [{ name: localStorage.getItem('golf.name') || 'You', golfer: localStorage.getItem('golf.skill') || 'scratch', ai: false, local: true }] };
const SKILLS = [['tour', 'Tour pro'], ['scratch', 'Scratch'], ['mid', 'Mid handicap (14)'], ['high', 'High handicap (25)']];
const HCP = { tour: 0, scratch: 0, mid: 14, high: 25 };
const AI_NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabi'];
function renderPlayerRows() {
  const box = $('playerRows');
  box.innerHTML = '';
  setup.players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'prow';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = COLORS[i % COLORS.length];
    const name = document.createElement('input'); name.value = p.name; name.maxLength = 18; name.setAttribute('aria-label', `Player ${i + 1} name`);
    name.disabled = !!p.peer && p.peer !== game.me;
    name.oninput = () => { p.name = name.value || `Player ${i + 1}`; if (i === 0) localStorage.setItem('golf.name', p.name); if (game.mode === 'live') sendLobby(); };
    const skill = document.createElement('select'); skill.setAttribute('aria-label', `Player ${i + 1} skill`);
    for (const [v, t] of SKILLS) { const o = document.createElement('option'); o.value = v; o.textContent = t; skill.appendChild(o); }
    skill.value = p.golfer;
    skill.disabled = !!p.peer && p.peer !== game.me;
    skill.onchange = () => { p.golfer = skill.value; if (i === 0) localStorage.setItem('golf.skill', p.golfer); if (game.mode === 'live') sendLobby(); };
    const right = document.createElement('div'); right.className = 'row';
    const tag = document.createElement('span'); tag.className = 'small'; tag.textContent = p.ai ? 'computer' : p.peer && p.peer !== game.me ? 'invited' : 'here';
    right.appendChild(tag);
    if (i > 0 && (!p.peer || p.peer === game.me || game.isHost)) {
      const del = document.createElement('button'); del.textContent = '✕'; del.setAttribute('aria-label', `Remove ${p.name}`);
      del.onclick = () => { setup.players.splice(i, 1); renderPlayerRows(); if (game.mode === 'live') sendLobby(); };
      right.appendChild(del);
    }
    row.append(dot, name, skill, right);
    box.appendChild(row);
  });
}
$('addAi').onclick = () => {
  if (setup.players.length >= 8) return;
  const used = new Set(setup.players.map((p) => p.name));
  const name = AI_NAMES.find((n) => !used.has(n)) || `Golfer ${setup.players.length + 1}`;
  setup.players.push({ name, golfer: ['scratch', 'mid', 'tour', 'high'][setup.players.length % 4], ai: true, local: false });
  renderPlayerRows();
  if (game.mode === 'live') sendLobby();
};
$('addHuman').onclick = () => {
  if (setup.players.length >= 8) return;
  setup.players.push({ name: `Player ${setup.players.length + 1}`, golfer: 'mid', ai: false, local: true });
  renderPlayerRows();
  if (game.mode === 'live') sendLobby();
};
$('optHoles').onchange = () => { $('singleField').style.display = $('optHoles').value === 'single' ? '' : 'none'; };
for (const b of document.querySelectorAll('.mode')) b.onclick = () => setMode(b.dataset.mode);
function setMode(m) {
  game.mode = m;
  for (const b of document.querySelectorAll('.mode')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  $('liveBox').style.display = m === 'live' ? '' : 'none';
  $('addHuman').style.display = m === 'live' ? 'none' : '';
  if (m === 'live') openRoom();
  $('startBtn').textContent = m === 'turns' ? 'Tee off and pass it on' : 'Tee off';
  $('menuStatus').textContent = m === 'turns' ? 'Add everyone who is playing; after your shots you get a link for the next player.' : '';
}
function holesFromOptions() {
  const v = $('optHoles').value;
  if (v === 'single') return [Number($('optSingle').value)];
  const [a, b] = v.split('-').map(Number);
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
function configFromMenu(seed) {
  return {
    seed: String(seed),
    holes: holesFromOptions(),
    players: setup.players.map((p) => ({ name: p.name, golfer: p.golfer, ai: !!p.ai, tee: $('optTees').value, handicap: HCP[p.golfer] || 0 })),
    format: $('optFormat').value,
    wind: Number($('optWind').value),
    gusts: true,
    stimp: Number($('optStimp').value),
    difficulty: Number($('optDiff').value),
    max_over_par: 5,
    gimme: Number($('optDiff').value) < 1 ? 0.6 : 0,
  };
}

// ---- Starting, resuming -------------------------------------------------------------
async function enter() {
  // A turn link?
  const m = location.hash.match(/[#&]g=([^&]+)/);
  if (m) {
    try {
      const r = await decodeRound(m[1]);
      if (r && r.saved) { await startFromSaved(r); return; }
    } catch (e) { console.warn('turn link', e); $('menuStatus').textContent = 'That link could not be read; start a new round.'; }
  }
  if (params.get('room')) { setMode('live'); return; }
  renderPlayerRows();
}

async function startRound(cfg, { owners = null, local = null, saved = null } = {}) {
  game.cfg = cfg;
  game.owners = owners || cfg.players.map(() => null);
  game.local = local || new Set(cfg.players.map((p, i) => (p.ai ? -1 : i)).filter((i) => i >= 0));
  game.state = saved ? await rpc('loadMatch', saved) : await rpc('newMatch', cfg);
  game.shots = saved ? [...saved.shots] : [];
  game.started = true;
  game.busy = false;
  makeBalls();
  $('menu').classList.remove('open');
  $('resumeBtn').style.display = '';
  ui.club = -1;
  afterState(true);
}

async function startFromSaved(r) {
  game.mode = r.mode || 'turns';
  const cfg = r.saved.config;
  const humans = cfg.players.map((p, i) => [p, i]).filter(([p]) => !p.ai);
  // Who is this? Remembered per round; else ask.
  const key = 'golf.who.' + cfg.seed;
  const remembered = localStorage.getItem(key);
  const choose = (i) => { localStorage.setItem(key, String(i)); return startRound(cfg, { saved: r.saved, local: new Set([i]) }); };
  if (remembered != null && cfg.players[Number(remembered)]) return choose(Number(remembered));
  if (humans.length === 1) return choose(humans[0][1]);
  const list = $('whoList');
  list.innerHTML = '';
  for (const [p, i] of humans) {
    const b = document.createElement('button');
    b.className = 'mode';
    b.innerHTML = `<b style="color:${COLORS[i % COLORS.length]}"></b><span></span>`;
    b.querySelector('b').textContent = p.name;
    b.querySelector('span').textContent = SKILLS.find((s) => s[0] === p.golfer)?.[1] || '';
    b.onclick = () => { $('whoDlg').classList.remove('open'); choose(i); };
    list.appendChild(b);
  }
  $('menu').classList.remove('open');
  $('whoDlg').classList.add('open');
}

$('startBtn').onclick = async () => {
  if (!info) return;
  sound('putt', 0.01);  // unlock audio on the user's gesture
  const seed = crypto.getRandomValues(new Uint32Array(2));
  const cfg = configFromMenu(BigInt(seed[0]) * 4294967296n + BigInt(seed[1]));
  if (game.mode === 'live') {
    if (!game.room) return;
    const owners = setup.players.map((p) => (p.ai ? null : p.peer || game.me));
    game.room.send({ t: 'start', cfg, owners, host: game.me });
    await startRound(cfg, { owners, local: localSet(owners, cfg) });
    return;
  }
  if (game.mode === 'turns') {
    await startRound(cfg, { local: new Set([0]) });
    return;
  }
  await startRound(cfg);
};
$('resumeBtn').onclick = () => $('menu').classList.remove('open');
$('btnMenu').onclick = () => { $('menu').classList.add('open'); };
const localSet = (owners, cfg) => new Set(owners.map((o, i) => (!cfg.players[i].ai && o === game.me ? i : -1)).filter((i) => i >= 0));

// ---- Live rooms ----------------------------------------------------------------
function openRoom() {
  if (game.room) return;
  if (!RELAY) {
    $('liveNote').textContent = 'Live rooms need the site\'s relay server, which is not switched on yet. Use "Invite by link · turns" meanwhile (it needs no server).';
    $('inviteLink').value = '';
    return;
  }
  let room = params.get('room');
  game.isHost = !room;
  if (!room) room = newId(8);
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', room);
  if (params.get('relay')) u.searchParams.set('relay', RELAY);
  $('inviteLink').value = u.href;
  game.room = joinRoom({ relay: RELAY, room, peer: game.me });
  game.host = game.isHost ? game.me : null;
  if (game.isHost) {
    setup.players[0].peer = game.me;
    $('liveNote').textContent = 'Send this link to your friends. They appear below as they join; add computer golfers if you like, then tee off.';
  } else {
    $('liveNote').textContent = 'Joining the room… the host starts the round.';
    $('startBtn').disabled = true;
    setup.players = [];
  }
  game.room.onstatus = (s) => { $('menuStatus').textContent = s === 'open' ? `Room ${room}: connected` : 'Reconnecting…'; if (s === 'open') hello(); };
  game.room.onpeers = (peers) => {
    if (game.isHost) {
      // Players whose device left stay in the round (their shots wait); in the lobby they go.
      if (!game.started) { setup.players = setup.players.filter((p) => !p.peer || p.peer === game.me || peers.has(p.peer) || p.ai); renderPlayerRows(); sendLobby(); }
    }
    renderLobby(peers);
  };
  game.room.onmessage = (from, m) => onRoomMessage(from, m);
  renderPlayerRows();
}
function hello() {
  const me = { name: localStorage.getItem('golf.name') || 'Guest', golfer: localStorage.getItem('golf.skill') || 'mid' };
  game.room.send({ t: 'hello', ...me, started: game.started, shots: game.state?.shots ?? -1 });
}
function sendLobby() {
  if (!game.room || !game.isHost) return;
  game.room.send({ t: 'lobby', players: setup.players, host: game.me });
}
function renderLobby(peers) {
  const box = $('lobbyList');
  box.innerHTML = '';
  for (const p of setup.players) {
    const d = document.createElement('div'); d.className = 'pl';
    const online = p.ai || !p.peer || peers?.has?.(p.peer) || p.peer === game.me;
    d.innerHTML = `<span class="dot" style="background:${online ? 'var(--good)' : 'var(--bad)'}"></span><span></span><span class="s"></span>`;
    d.children[1].textContent = p.name;
    d.children[2].textContent = p.ai ? 'computer' : p.peer === game.me ? 'you' : 'joined';
    box.appendChild(d);
  }
}
async function onRoomMessage(from, m) {
  if (m.t === 'hello' && game.isHost) {
    if (game.started) {
      // Late or returning: send the round so far.
      const saved = await rpc('save');
      game.room.send({ t: 'sync', saved, owners: game.owners, host: game.me, cfg: game.cfg }, from);
      return;
    }
    if (!setup.players.some((p) => p.peer === from)) {
      if (setup.players.length >= 8) return;
      setup.players.push({ name: m.name || 'Guest', golfer: m.golfer || 'mid', ai: false, peer: from });
    }
    renderPlayerRows(); sendLobby(); renderLobby(game.room.peers);
  } else if (m.t === 'lobby' && !game.isHost) {
    game.host = m.host;
    setup.players = m.players;
    renderPlayerRows(); renderLobby(game.room.peers);
    $('menuStatus').textContent = 'In the room. Waiting for the host to tee off…';
  } else if (m.t === 'start' && !game.isHost) {
    game.host = m.host;
    await startRound(m.cfg, { owners: m.owners, local: localSet(m.owners, m.cfg) });
  } else if (m.t === 'sync' && !game.isHost) {
    game.host = m.host;
    if (!game.started || (game.state && game.state.shots < m.saved.shots.length))
      await startRound(m.cfg, { owners: m.owners, local: localSet(m.owners, m.cfg), saved: m.saved });
  } else if (m.t === 'shot') {
    remoteShots.set(m.n, m.swing);
    drainRemote();
  } else if (m.t === 'pickup') {
    remoteShots.set(m.n, { pickup: true });
    drainRemote();
  }
}
const remoteShots = new Map();
async function drainRemote() {
  while (!game.busy && game.state && remoteShots.has(game.state.shots + pickups)) {
    const n = game.state.shots + pickups;
    const s = remoteShots.get(n);
    remoteShots.delete(n);
    if (s.pickup) { pickups++; game.state = await rpc('pickUp'); afterState(); continue; }
    await playShot(s, false);
  }
}
let pickups = 0;

// ---- Turns ----------------------------------------------------------------------
const turnPlayer = () => (game.state ? game.state.turn : -1);
const isLocalTurn = () => game.local.has(turnPlayer());
const aiAuthority = () => game.mode !== 'live' || game.host === game.me;

function afterState(fresh = false) {
  const st = game.state;
  updateHud();
  renderPlayersStrip();
  placeBalls();
  if (st.finished) { showCard(true); return; }
  const t = st.turn, p = game.cfg.players[t];
  if (fresh || ui.lastTurn !== t || ui.lastShots !== st.shots) {
    ui.lastTurn = t; ui.lastShots = st.shots;
    ui.caddie = null; ui.suggestPower = null;
    resetAim();
    ui.view = 'address';
  }
  // Turn links: when the next shot belongs to someone on another device, pass the link.
  if (game.mode === 'turns' && !p.ai && !game.local.has(t)) { saveTurnLink(); showCard(false, true); }
  if (p.ai && aiAuthority() && !game.busy) setTimeout(() => playAi(), window.golf?.fast ? 10 : 500);
  setControls();
  ui.previewDirty = true;
}

async function playAi() {
  if (game.busy || !game.state || game.state.finished) return;
  const t = turnPlayer();
  if (!game.cfg.players[t].ai) return;
  showToast(`${game.cfg.players[t].name} is thinking…`, '', 900);
  const plan = await rpc('plan');
  await playShot(plan.input, true);
}

function setControls() {
  const mine = isLocalTurn() && !game.busy && game.started && !game.state.finished;
  $('bottom').style.opacity = mine ? '1' : '0.55';
  for (const b of $('bottom').querySelectorAll('button')) b.disabled = !mine;
  if (game.started && game.state.finished) $('meterLabel').textContent = 'Round complete · see the card';
  else if (!mine && game.started && !game.state.finished) {
    const p = game.cfg.players[turnPlayer()];
    $('meterLabel').textContent = p.ai ? `${p.name} to play` : `Waiting for ${p.name}…`;
  } else if (mine) {
    $('meterLabel').textContent = MOBILE ? 'Drag to aim · tap SWING' : 'Aim with ◀ ▶ or drag · Space to swing';
  }
}

// ---- Shots ----------------------------------------------------------------------
async function playShot(swing, broadcast) {
  game.busy = true;
  setControls();
  aimLine.visible = false; landRing.visible = false;
  const n = game.state.shots + pickups;
  if (broadcast && game.mode === 'live' && game.room) game.room.send({ t: 'shot', n, swing });
  const before = game.state;
  const r = await rpc('play', swing);
  game.shots.push(swing);
  await animateShot(r, before);
  game.state = r.state;
  game.busy = false;
  if (game.mode === 'turns') saveTurnLink();
  afterState();
  drainRemote();
}

function animateShot(r, before) {
  return new Promise((resolve) => {
    const p = r.record.player;
    const path = r.path;
    const n = path.length / 5;
    const isPutt = r.record.input.club === 'PT';
    // A shot swung on this device starts at impact; others are swung first.
    const pre = game.local.has(p) && !game.cfg.players[p].ai ? 0 : window.golf?.fast ? 0 : isPutt ? 0.9 : 1.15;
    const pos = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) pos.set([path[5 * k + 1], path[5 * k + 2], path[5 * k + 3]], 3 * k);
    tracer.geometry.dispose();
    tracer.geometry = new THREE.BufferGeometry();
    tracer.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tracer.geometry.setDrawRange(0, 0);
    tracer.material.color.set(COLORS[p % COLORS.length]);
    tracer.visible = !isPutt;
    const tEnd = path[5 * (n - 1)];
    anim = { r, path, n, t0: performance.now() / 1000, tEnd, p, resolve, events: r.shot.events.slice(), isPutt, before, done: false, speed: 1, clock: -pre, pre, launched: false };
    showResult(null);
  });
}

function finishAnim() {
  if (!anim || anim.done) return;
  anim.done = true;
  const { r, resolve, p } = anim;
  const rec = r.record;
  balls[p].mesh.position.set(rec.to[0], rec.to[1], rec.to[2]);
  tracer.geometry.setDrawRange(0, anim.n);
  showResult(r);
  // What happened, in words.
  const st = r.state.players[p];
  const holeNow = r.state.hole;
  const name = game.cfg.players[p].name;
  if (r.shot.outcome === 'holed' || rec.ruling.kind === 'holed') {
    const card = st.card[rec.hole];
    const par = info.holes[game.cfg.holes[rec.hole]].par;
    sound('cup');
    showToast(scoreName(card, par, rec.stroke === 1 && card === 1), `${name} · ${card} on a par ${par}`, 2600);
  } else if (rec.ruling.kind === 'penalty area') { sound('splash'); showToast('In the water', `${name} · ${rec.ruling.note}`, 2200); }
  else if (rec.ruling.kind === 'out of bounds' || rec.ruling.kind === 'lost') showToast('Out of bounds', `${name} · ${rec.ruling.note}`, 2200);
  else if (rec.ruling.note === 'conceded') showToast('Conceded', `${name} · good`, 1500);
  void holeNow;
  const wait = window.golf?.fast ? 50 : r.hole_complete ? 1600 : 700;
  setTimeout(() => { anim = null; tracer.visible = false; resolve(); }, wait);
}

function scoreName(strokes, par, ace) {
  if (ace) return 'Hole in one!';
  const d = strokes - par;
  return d <= -3 ? 'Albatross!' : d === -2 ? 'Eagle!' : d === -1 ? 'Birdie!' : d === 0 ? 'Par' : d === 1 ? 'Bogey' : d === 2 ? 'Double bogey' : `${d > 0 ? '+' : ''}${d}`;
}

// ---- Aim, clubs, preview ------------------------------------------------------------
function currentBall() {
  const st = game.state;
  if (!st || st.turn < 0) return null;
  return st.players[st.turn];
}
function pinPos() { return game.state?.pin || [0, 0, 0]; }
function onGreen() { const b = currentBall(); return b && (b.surface === 'green' || (b.surface === 'fringe' && dist2(b.pos, pinPos()) < 22)); }
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

function resetAim() {
  const b = currentBall();
  if (!b) return;
  const pin = pinPos();
  // Aim at the pin, or, out of reach, along the hole's line.
  const d = dist2(b.pos, pin);
  const hole = info.holes[game.cfg.holes[game.state.hole]];
  let tx = pin[0], tz = pin[2];
  const maxCarry = clubs.clubs[0].carry * (speedFactor() || 1);
  if (d > maxCarry * 1.05 && hole.line.length > 2) {
    // The dogleg point the ball has not passed yet.
    for (let k = 1; k < hole.line.length - 1; k++) {
      const q = hole.line[k];
      if (Math.hypot(q[0] - b.pos[0], q[1] - b.pos[2]) > 60 && dist2(b.pos, pin) > Math.hypot(q[0] - pin[0], q[1] - pin[2])) { tx = q[0]; tz = q[1]; break; }
    }
  }
  ui.aim = Math.atan2(tz - b.pos[2], tx - b.pos[0]);
  // Club: the putter on the green; else the shortest club that gets there.
  if (onGreen()) ui.club = clubs.clubs.findIndex((c) => c.putter);
  else {
    const want = Math.hypot(tx - b.pos[0], tz - b.pos[2]);
    const lieMul = b.surface === 'bunker' ? 0.85 : b.surface === 'rough' ? 0.95 : 1;
    let pick = -1;
    for (let i = clubs.clubs.length - 1; i >= 0; i--) {
      const c = clubs.clubs[i];
      if (c.putter || (c.code === 'DR' && !b.teed)) continue;
      if (c.carry * speedFactor() * lieMul >= want * 0.97) { pick = i; break; }
    }
    if (pick < 0) pick = b.teed ? 0 : 1;
    ui.club = pick;
  }
  updateClub();
}
function speedFactor() {
  const t = turnPlayer();
  const g = t >= 0 ? game.cfg.players[t].golfer : 'scratch';
  return { tour: 1 / 0.93, scratch: 1, mid: 0.83 / 0.93, high: 0.75 / 0.93 }[g] || 1;
}
function updateClub() {
  const c = clubs.clubs[ui.club];
  if (!c) return;
  $('clubName').textContent = c.name;
  if (c.putter) {
    const full = puttFullDistance();
    $('clubCarry').textContent = `full meter ≈ ${fmt(full, 1)} m`;
  } else $('clubCarry').textContent = `carry ${fmt(c.carry * speedFactor())} m · ${fmt(c.carry * speedFactor() / YD)} yd`;
  ui.previewDirty = true;
}
// Putts: the meter's full scale covers 1.4 x the distance to the hole (at least 3 m).
function puttFullDistance() { const b = currentBall(); return Math.max(3, 1.4 * (b ? dist2(b.pos, pinPos()) : 10)); }
function puttPower(distance) {
  // Roll on level ground: v0^2 = 2 a d with the Stimpmeter's deceleration
  // a = 1.83^2 / (2 d_stimp) (Holmes 1986; Penner 2002), ball speed = 1.59 x head speed.
  const stimp = info.surfaces.find((s) => s.id === 'green')?.stimp || 10.5;
  const a = (1.83 * 1.83) / (2 * stimp * 0.3048);
  return Math.sqrt(2 * a * distance) / 1.59 / 4.0;
}
function swingInput(power, accuracy = 0) {
  const c = clubs.clubs[ui.club];
  const putt = c.putter;
  const left = false;
  const shape = ui.shape * (left ? -1 : 1);
  const s = {
    club: c.code, aim: ui.aim, power,
    path: putt ? 0 : -shape * 3.5,           // draw: in-to-out (+), fade: out-to-in (-)
    face: putt ? accuracy * 2.2 : -shape * 1.2 + accuracy * 7,
    loft: putt ? 0 : ui.height * 4.5,
    attack: putt ? 0 : ui.height * 1.2,
    toe: putt ? 0 : -accuracy * 9,
    up: 0,
  };
  return s;
}
let previewBusy = false;
async function refreshPreview() {
  if (!ui.previewDirty || previewBusy || !isLocalTurn() || game.busy || !game.started || game.state.finished) return;
  ui.previewDirty = false;
  const diff = game.cfg.difficulty;
  if (diff > 1.1) { aimLine.visible = false; landRing.visible = false; return; }
  previewBusy = true;
  try {
    const c = clubs.clubs[ui.club];
    const power = c.putter ? puttPower(dist2(currentBall().pos, pinPos()) + 0.3) : (ui.suggestPower ?? 1);
    const r = await rpc('preview', { ...swingInput(power), exact: true });
    const path = r.path, n = path.length / 5;
    const pts = [];
    const step = Math.max(1, Math.floor(n / 160));
    for (let k = 0; k < n; k += step) pts.push(new THREE.Vector3(path[5 * k + 1], path[5 * k + 2] + 0.03, path[5 * k + 3]));
    pts.push(new THREE.Vector3(r.final[0], r.final[1] + 0.03, r.final[2]));
    aimLine.geometry.dispose();
    aimLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    aimLine.computeLineDistances();
    aimLine.material.dashSize = c.putter ? 0.25 : 2;
    aimLine.material.gapSize = c.putter ? 0.15 : 1.4;
    aimLine.visible = true;
    const land = c.putter ? r.final : (r.events.find((e) => e.kind === 'landing')?.pos || r.final);
    landRing.position.set(land[0], land[1] + 0.05, land[2]);
    const sc = c.putter ? 0.25 : Math.max(1, r.carry / 40);
    landRing.scale.set(sc, sc, sc);
    landRing.visible = true;
    $('lieInfo').innerHTML = lieText() + (c.putter ? '' : ` · <b>${fmt(r.carry)} m</b> carry, ${fmt(r.total)} m total`);
  } catch (e) { console.warn('preview', e); }
  previewBusy = false;
}
function lieText() {
  const b = currentBall();
  if (!b) return '';
  const s = info.surfaces.find((x) => x.id === b.surface);
  return `Lie: <b>${s ? s.name : b.surface}${b.plugged ? ' (plugged)' : ''}${b.teed ? ' (teed)' : ''}</b>`;
}

$('clubPrev').onclick = () => { if (!isLocalTurn()) return; ui.club = Math.max(0, ui.club - 1); updateClub(); };
$('clubNext').onclick = () => { if (!isLocalTurn()) return; ui.club = Math.min(clubs.clubs.length - 1, ui.club + 1); updateClub(); };
for (const [seg, key] of [['shapeSeg', 'shape'], ['heightSeg', 'height']]) {
  for (const b of $(seg).querySelectorAll('button')) b.onclick = () => {
    ui[key] = Number(b.dataset.v);
    for (const o of $(seg).querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
    ui.previewDirty = true;
  };
}
$('btnCaddie').onclick = async () => {
  if (!isLocalTurn() || game.busy) return;
  $('btnCaddie').disabled = true;
  try {
    const plan = await rpc('plan');
    const i = clubs.clubs.findIndex((c) => c.code === plan.input.club);
    if (i >= 0) ui.club = i;
    ui.aim = plan.input.aim;
    ui.suggestPower = clubs.clubs[ui.club].putter ? plan.input.power : plan.input.power;
    ui.caddie = plan;
    updateClub();
    const tip = plan.note ? `${clubs.clubs[ui.club].name}, ${plan.note}` : clubs.clubs[ui.club].name;
    showToast('Caddie', `${tip} · ${Math.round(plan.input.power * (clubs.clubs[ui.club].putter ? 100 / puttPower(puttFullDistance()) : 100))} % power`, 2200);
  } catch (e) { console.warn(e); }
  $('btnCaddie').disabled = false;
};
$('btnView').onclick = () => { ui.view = ui.view === 'address' ? 'look' : 'address'; };

// ---- The swing meter (three clicks: start, power, accuracy) -------------------------------
const meter = ui.meter;
const ZONE = () => (game.cfg?.difficulty < 1 ? 0.05 : game.cfg?.difficulty > 1.1 ? 0.022 : 0.032);
function meterPress() {
  if (!isLocalTurn() || game.busy || !game.started) return;
  const now = performance.now() / 1000;
  if (meter.phase === 'idle') { meter.phase = 'back'; meter.t0 = now; sound('putt', 0.05); }
  else if (meter.phase === 'back') { meter.power = Math.min(1.1, meter.mark); meter.phase = 'down'; meter.t0 = now; }
  else if (meter.phase === 'down') { meter.phase = 'idle'; swing(meter.mark); }
}
function meterTick() {
  const now = performance.now() / 1000;
  const c = clubs?.clubs[ui.club];
  if (meter.phase === 'back') {
    const T = c?.putter ? 1.6 : 1.05;
    meter.mark = (now - meter.t0) / T;
    if (meter.mark > 1.12) { meter.power = 1.1; meter.phase = 'down'; meter.t0 = now; }
  } else if (meter.phase === 'down') {
    const T = c?.putter ? 0.8 : 0.55;
    meter.mark = meter.power - ((now - meter.t0) / T) * (meter.power + 0.15);
    if (meter.mark < -0.15) { meter.phase = 'idle'; swing(-0.15); }
  }
  const w = $('meterWrap').clientWidth, x = (v) => `${((v + 0.15) / 1.27) * w}px`;
  $('meterZone').style.left = x(-ZONE()); $('meterZone').style.width = `${(2 * ZONE() / 1.27) * w}px`;
  $('meterFill').style.width = meter.phase === 'back' ? x(Math.max(0, meter.mark)) : meter.phase === 'down' ? x(meter.power) : '0px';
  $('meterPower').style.display = meter.phase === 'down' ? 'block' : 'none';
  $('meterPower').style.left = x(meter.power);
  $('meterMark').style.display = meter.phase === 'idle' ? 'none' : 'block';
  $('meterMark').style.left = x(meter.mark);
  const sp = ui.suggestPower;
  if (sp != null && c) {
    const frac = c.putter ? sp / puttPower(puttFullDistance()) : sp;
    $('meterSuggest').style.display = 'block'; $('meterSuggest').style.left = x(Math.min(1.1, frac));
  } else $('meterSuggest').style.display = 'none';
  if (meter.phase !== 'idle' && c) {
    const pct = meter.phase === 'back' ? meter.mark : meter.power;
    $('meterLabel').textContent = c.putter ? `${fmt(Math.max(0, pct) * puttFullDistance(), 1)} m on the flat` : `${Math.round(Math.max(0, pct) * 100)} %`;
  }
}
function swing(mark) {
  // Accuracy: the downswing marker against the impact zone. Inside the zone it
  // counts for nothing; outside, early pulls the face closed (a hook for a
  // right-hander), late leaves it open.
  const z = ZONE();
  const err = Math.abs(mark) <= z ? 0 : (mark > 0 ? -(mark - z) : -(mark + z)) / 0.12;
  const c = clubs.clubs[ui.club];
  const power = c.putter ? meter.power * puttPower(puttFullDistance()) : meter.power;
  if (power < 0.01) return;
  playShot(swingInput(power, Math.max(-1.2, Math.min(1.2, err))), true);
}
$('swingBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); meterPress(); });
$('meterWrap').addEventListener('pointerdown', (e) => { e.preventDefault(); meterPress(); });

// ---- Keyboard and dragging ------------------------------------------------------------
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ($('menu').classList.contains('open') || $('whoDlg').classList.contains('open')) return;
  if (e.key === 'Escape') { if ($('cardDlg').classList.contains('open')) $('cardDlg').classList.remove('open'); else $('menu').classList.add('open'); return; }
  if (e.key === 'c' || e.key === 'C') { $('cardDlg').classList.contains('open') ? $('cardDlg').classList.remove('open') : showCard(false); return; }
  if (anim && (e.key === ' ' || e.key === 'Enter')) { anim.speed = 6; e.preventDefault(); return; }
  if (!isLocalTurn() || game.busy) return;
  const fine = e.shiftKey ? 0.1 : clubs.clubs[ui.club]?.putter ? 0.25 : 0.6;
  if (e.key === 'ArrowLeft') { ui.aim -= fine * Math.PI / 180; ui.previewDirty = true; e.preventDefault(); }
  else if (e.key === 'ArrowRight') { ui.aim += fine * Math.PI / 180; ui.previewDirty = true; e.preventDefault(); }
  else if (e.key === 'ArrowUp') { $('clubPrev').onclick(); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { $('clubNext').onclick(); e.preventDefault(); }
  else if (e.key === ' ' || e.key === 'Enter') { if (!e.repeat) meterPress(); e.preventDefault(); }
  else if (e.key === 'v' || e.key === 'V') $('btnView').onclick();
  else if (e.key === 'q' || e.key === 'Q') $('btnCaddie').onclick();
});
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, aim: ui.aim, orbit: ui.orbit || 0 }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (anim || !isLocalTurn() || ui.view === 'look') { ui.orbit = drag.orbit + dx * 0.006; return; }
  const scale = clubs.clubs[ui.club]?.putter ? 0.0009 : 0.0022;
  ui.aim = drag.aim + dx * scale * (e.shiftKey ? 0.25 : 1);
  ui.previewDirty = true;
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => { ui.zoom = Math.min(3, Math.max(0.4, (ui.zoom || 1) * Math.exp(e.deltaY * 0.001))); }, { passive: true });

// ---- Balls and labels --------------------------------------------------------------------
const labelLayer = $('label-layer');
function makeBalls() {
  for (const b of balls) { scene.remove(b.mesh); b.label.remove(); }
  balls.length = 0;
  game.cfg.players.forEach((p, i) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.02134, 16, 12), new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#222' }));
    mesh.castShadow = true;
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.05, 20), new THREE.MeshBasicMaterial({ color: COLORS[i % COLORS.length], depthTest: false, transparent: true }));
    halo.rotation.x = -Math.PI / 2;
    halo.renderOrder = 7;
    mesh.add(halo);
    mesh.userData.halo = halo;
    scene.add(mesh);
    const label = document.createElement('div');
    label.className = 'blabel';
    label.style.color = COLORS[i % COLORS.length];
    label.textContent = p.name;
    labelLayer.appendChild(label);
    balls.push({ mesh, label });
  });
}
function placeBalls() {
  const st = game.state;
  st.players.forEach((p, i) => {
    const b = balls[i];
    if (!b) return;
    if (anim && anim.p === i && !anim.done) return;
    b.mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
    b.mesh.visible = !(p.done && st.players.length > 0 && p.strokes > 0 && p.pos[1] < H(p.pos[0], p.pos[2]) - 0.02);
  });
}
const tmpV = new THREE.Vector3();
function updateLabels() {
  const st = game.state;
  if (!st) return;
  balls.forEach((b, i) => {
    const p = st.players[i];
    const vis = b.mesh.visible && !p.done && game.started;
    tmpV.copy(b.mesh.position).project(camera);
    if (!vis || tmpV.z > 1 || Math.abs(tmpV.x) > 1.1 || Math.abs(tmpV.y) > 1.1 || (i === turnPlayer() && !anim && ui.view === 'address')) { b.label.style.display = 'none'; return; }
    b.label.style.display = 'block';
    b.label.style.left = `${(tmpV.x * 0.5 + 0.5) * innerWidth}px`;
    b.label.style.top = `${(-tmpV.y * 0.5 + 0.5) * innerHeight}px`;
    // Keep each ball findable: grow it with distance.
    const d = camera.position.distanceTo(b.mesh.position);
    b.mesh.scale.setScalar(Math.max(1, d / 18));
  });
}

// ---- HUD ---------------------------------------------------------------------------------
function updateHud() {
  const st = game.state;
  if (!st || st.finished) return;
  const hole = info.holes[game.cfg.holes[st.hole]];
  $('holeTitle').innerHTML = `Hole ${hole.number}<small>Par ${hole.par}</small>`;
  const tee = hole.tees.find((t) => t.name === game.cfg.players[0].tee) || hole.tees[1] || hole.tees[0];
  const len = Math.hypot(tee.pos[0] - hole.line.at(-1)[0], tee.pos[2] - hole.line.at(-1)[1]);
  $('holeSub').textContent = `${hole.name} · ${Math.round(hole.length / YD)} yd · SI ${hole.stroke_index} · ${st.hole + 1}/${st.holes}`;
  void len;
  const b = currentBall();
  if (b) {
    const d = dist2(b.pos, st.pin), dh = st.pin[1] - b.pos[1];
    $('pinDist').innerHTML = `${fmt(d, d < 30 ? 1 : 0)}<small>m</small>`;
    $('pinSub').textContent = `${fmt(d / YD)} yd · ${dh >= 0 ? '+' : ''}${fmt(dh, 1)} m · plays ${fmt(d + dh)} m`;
  }
  const ws = st.wind_speed || 0;
  $('windV').textContent = `${fmt(ws, 1)} m/s`;
  $('windD').textContent = ws < 0.5 ? 'calm' : `${fmt(ws * 3.6)} km/h at 10 m`;
  $('lieInfo').innerHTML = lieText();
}
function updateWindArrow() {
  if (!game.state) return;
  // Relative to where the camera looks.
  const camH = Math.atan2(camDir.z, camDir.x);
  const rel = (game.state.wind_toward || 0) - camH;
  $('windPath').setAttribute('transform', `rotate(${(rel * 180) / Math.PI + 90})`);
}
function renderPlayersStrip() {
  const st = game.state, box = $('players');
  box.innerHTML = '';
  st.players.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'pl' + (i === st.turn ? ' turn' : '');
    const toPar = p.to_par === 0 ? 'E' : (p.to_par > 0 ? '+' : '') + p.to_par;
    const score = game.cfg.format === 'stableford' ? `${p.stableford} pts` : toPar;
    d.innerHTML = `<span class="dot" style="background:${COLORS[i % COLORS.length]}"></span><span></span>${p.ai ? '<span class="ai">CPU</span>' : ''}<span class="s"></span>`;
    d.children[1].textContent = p.name;
    d.querySelector('.s').textContent = `${p.done ? '✓' : p.strokes ? `${p.strokes} · ` : ''}${score}`;
    box.appendChild(d);
  });
  if (game.cfg.format === 'match' && st.players.length === 2) {
    const s = st.match_status || 0;
    const d = document.createElement('div'); d.className = 'pl';
    d.textContent = s === 0 ? 'All square' : `${st.players[s > 0 ? 0 : 1].name} ${Math.abs(s)} up`;
    box.appendChild(d);
  }
}
let toastTimer = 0;
function showToast(big, small = '', ms = 1800) {
  const t = $('toast');
  t.innerHTML = '';
  t.append(big);
  if (small) { const s = document.createElement('small'); s.textContent = small; t.appendChild(s); }
  t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = '0'; }, ms);
}
function showResult(r) {
  const box = $('result');
  if (!r) { box.style.display = 'none'; return; }
  const rec = r.record, s = r.shot, L = rec.launch;
  const putt = rec.input.club === 'PT';
  const rows = putt
    ? [['Ball speed', `${fmt(L.speed, 2)} m/s`], ['Rolled', `${fmt(s.total, 2)} m`], ['To the hole', `${fmt(rec.pin_after, 2)} m`]]
    : [['Carry', `${fmt(s.carry)} m · ${fmt(s.carry / YD)} yd`], ['Total', `${fmt(s.total)} m`], ['Offline', `${fmt(Math.abs(s.total_offline), 1)} m ${s.total_offline >= 0 ? 'right' : 'left'}`],
       ['Ball speed', `${fmt(L.speed / MPH)} mph`], ['Launch', `${fmt(L.vla, 1)}° · ${fmt(L.hla, 1)}°`], ['Spin', `${fmt(L.spin)} rpm · axis ${fmt(L.axis, 1)}°`],
       ['Smash', fmt(L.smash, 2)], ['Height', `${fmt(s.apex, 1)} m`], ['Land angle', `${fmt(s.land_angle, 1)}°`]];
  rows.push(['Strokes gained', `${rec.strokes_gained >= 0 ? '+' : ''}${fmt(rec.strokes_gained, 2)}`]);
  box.innerHTML = `<h3></h3><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  box.querySelector('h3').textContent = `${game.cfg.players[rec.player].name} · ${clubs.clubs.find((c) => c.code === rec.input.club)?.name || rec.input.club}`;
  if (rec.ruling.note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = rec.ruling.note; box.appendChild(n); }
  box.style.display = 'block';
  clearTimeout(showResult.timer);
  showResult.timer = setTimeout(() => { box.style.display = 'none'; }, 6500);
}

// ---- Scorecard and turn links ------------------------------------------------------------
function showCard(final, share = false) {
  const st = game.state;
  if (!st) return;
  const hs = game.cfg.holes.map((h) => info.holes[h]);
  const cls = (g, par) => (g < 0 ? '' : g - par <= -2 ? 'sc-eagle' : g < par ? 'sc-under' : g > par ? 'sc-over' : '');
  let html = '<table class="card"><thead><tr><th>Hole</th>' + hs.map((h) => `<th>${h.number}</th>`).join('') + '<th>Tot</th><th>±</th>' + (game.cfg.format === 'stableford' ? '<th>Pts</th>' : '') + '</tr></thead><tbody>';
  html += '<tr><td>Par</td>' + hs.map((h) => `<td>${h.par}</td>`).join('') + `<td>${hs.reduce((a, h) => a + h.par, 0)}</td><td></td>${game.cfg.format === 'stableford' ? '<td></td>' : ''}</tr>`;
  st.players.forEach((p, i) => {
    html += `<tr><td style="color:${COLORS[i % COLORS.length]}">${escapeHtml(p.name)}</td>` + p.card.map((g, k) => `<td class="${cls(g, hs[k].par)}">${g < 0 ? '' : g}${p.received[k] ? '<sup>•</sup>' : ''}</td>`).join('');
    html += `<td>${p.gross}</td><td>${p.to_par === 0 ? 'E' : (p.to_par > 0 ? '+' : '') + p.to_par}</td>${game.cfg.format === 'stableford' ? `<td>${p.stableford}</td>` : ''}</tr>`;
  });
  html += '</tbody></table><p class="small">• a handicap stroke received on the hole (net scoring).</p>';
  if (final) {
    const order = st.players.map((p, i) => [p, i]).sort((a, b) => (game.cfg.format === 'stableford' ? b[0].stableford - a[0].stableford : a[0].gross - b[0].gross));
    const w = order[0][0].name;
    const tie = order.length > 1 && (game.cfg.format === 'stableford' ? order[1][0].stableford === order[0][0].stableford : order[1][0].gross === order[0][0].gross);
    const head = st.players.length === 1 ? `${order[0][0].gross} strokes, ${order[0][0].to_par === 0 ? 'level par' : (order[0][0].to_par > 0 ? '+' : '') + order[0][0].to_par}` : tie ? 'A tie' : w === 'You' ? 'You win' : `${w} wins`;
    html = `<p style="font:800 20px var(--display);text-transform:uppercase;color:var(--hot)">${escapeHtml(head)}</p>` + html;
  }
  $('cardTitle').textContent = final ? 'Final scores' : 'Scorecard';
  $('cardBody').innerHTML = html;
  $('againBtn').style.display = final ? '' : 'none';
  $('cardShare').style.display = share || (game.mode === 'turns' && final) ? '' : 'none';
  $('cardDlg').classList.add('open');
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
$('btnCard').onclick = () => showCard(false, game.mode === 'turns' && !isLocalTurn());
$('cardClose').onclick = () => $('cardDlg').classList.remove('open');
$('againBtn').onclick = () => { $('cardDlg').classList.remove('open'); game.started = false; location.hash = ''; $('menu').classList.add('open'); renderPlayerRows(); };
async function saveTurnLink() {
  const saved = await rpc('save');
  const code = await encodeRound({ v: 1, mode: 'turns', course: info.id, saved });
  const u = new URL(location.href);
  u.hash = 'g=' + code;
  history.replaceState(null, '', u.href);
  $('turnLink').value = u.href;
  const st = game.state;
  const next = st.finished ? null : game.cfg.players[st.turn];
  $('shareNote').textContent = next ? `It's ${next.name}'s shot. Send them this link; they play on from here and send it back.` : 'The round is over: send this link so everyone sees the final card.';
}
const copy = async (id) => { try { await navigator.clipboard.writeText($(id).value); showToast('Copied', 'link on the clipboard', 1100); } catch { $(id).select(); } };
const share = async (id, title) => { if (navigator.share) { try { await navigator.share({ title, url: $(id).value }); } catch { /* cancelled */ } } else copy(id); };
$('copyTurn').onclick = () => copy('turnLink');
$('shareTurn').onclick = () => share('turnLink', 'Your shot · Golf in São Paulo');
$('copyLink').onclick = () => copy('inviteLink');
$('shareLink').onclick = () => share('inviteLink', 'Play golf with me in São Paulo');

// ---- Cameras ------------------------------------------------------------------------------
const camDir = new THREE.Vector3(1, 0, 0);
const camGoal = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
const camLook = new THREE.Vector3();
function overviewCamera() {
  const h = info.holes[0];
  const t = h.tees[1].pos, g = h.green;
  camera.position.set(t[0] - 40, t[1] + 60, t[2] + 60);
  camLook.set(g.x, g.level, g.z);
  camera.lookAt(camLook);
}
function addressGoal() {
  const b = currentBall();
  if (!b) return;
  const c = clubs.clubs[ui.club];
  const d = new THREE.Vector3(Math.cos(ui.aim), 0, Math.sin(ui.aim));
  const zoom = ui.zoom || 1;
  const putt = c?.putter;
  if (ui.view === 'look') {
    // Looking down the hole, or over the green when putting.
    const pin = pinPos();
    if (putt) {
      const mid = new THREE.Vector3((b.pos[0] + pin[0]) / 2, (b.pos[1] + pin[1]) / 2, (b.pos[2] + pin[2]) / 2);
      const span = Math.max(4, dist2(b.pos, pin));
      const o = ui.orbit || 0;
      camGoal.pos.set(mid.x - d.x * span * 0.6 * Math.cos(o) + d.z * span * 0.6 * Math.sin(o), mid.y + span * 0.9 * zoom, mid.z - d.z * span * 0.6 * Math.cos(o) - d.x * span * 0.6 * Math.sin(o));
      camGoal.look.copy(mid);
    } else {
      const far = Math.min(dist2(b.pos, pin), (c?.carry || 150) * 1.1);
      const tgt = new THREE.Vector3(b.pos[0] + d.x * far, 0, b.pos[2] + d.z * far);
      tgt.y = H(tgt.x, tgt.z);
      camGoal.pos.set(tgt.x - d.x * 60 * zoom, tgt.y + 55 * zoom, tgt.z - d.z * 60 * zoom);
      camGoal.look.copy(tgt);
    }
    return;
  }
  // A tall, narrow screen needs the camera further back to see the golfer and the line.
  const narrow = camera.aspect < 1 ? 1.7 : 1;
  const back = (putt ? 2.2 : 4.2) * zoom * narrow, up = (putt ? 0.9 : 1.75) * (narrow > 1 ? 1.4 : 1);
  camGoal.pos.set(b.pos[0] - d.x * back, b.pos[1] + up * zoom, b.pos[2] - d.z * back);
  const ahead = putt ? Math.max(3, dist2(b.pos, pinPos()) * 0.8) : Math.min(140, (c?.carry || 120) * 0.6);
  camGoal.look.set(b.pos[0] + d.x * ahead, b.pos[1] + (putt ? -0.5 : 2), b.pos[2] + d.z * ahead);
  if (!putt) camGoal.look.y = Math.max(camGoal.look.y, H(camGoal.look.x, camGoal.look.z) + 3);
  // Portrait: tilt down so the course, not the sky, fills the tall frame.
  if (narrow > 1) camGoal.look.y -= putt ? 0.6 : 0.06 * ahead;
}
function updateCamera(dt) {
  if (!game.started) {
    // Idle: a slow orbit over the first hole.
    const t = performance.now() / 1000, g = info.holes[0].green;
    camera.position.set(g.x + Math.cos(t * 0.05) * 260, g.level + 90, g.z + Math.sin(t * 0.05) * 260);
    camera.lookAt(g.x, g.level, g.z);
    return;
  }
  if (anim) {
    const b = balls[anim.p].mesh.position;
    if (anim.isPutt) {
      const s = anim.r.record.from;
      const d = new THREE.Vector3(b.x - s[0], 0, b.z - s[2]);
      const L = d.length();
      if (L > 0.01) d.divideScalar(L); else d.set(Math.cos(anim.r.record.input.aim), 0, Math.sin(anim.r.record.input.aim));
      camGoal.pos.set(b.x - d.x * 2.5, b.y + 1.0, b.z - d.z * 2.5);
      camGoal.look.copy(b);
    } else {
      // Chase the ball; once it is coming down, watch from beside where it lands.
      const end = anim.path, n = anim.n;
      const lx = end[5 * (n - 1) + 1], lz = end[5 * (n - 1) + 3];
      const s = anim.r.record.from;
      const dir = new THREE.Vector3(lx - s[0], 0, lz - s[2]);
      const L = Math.max(dir.length(), 1);
      dir.divideScalar(L);
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      const t = anim.clock ?? 0;
      const ft = anim.r.shot.flight_time || 1;
      if (t < ft * 0.45 || L < 40) {
        camGoal.pos.set(b.x - dir.x * 9, Math.max(b.y + 3, H(b.x, b.z) + 2), b.z - dir.z * 9);
      } else {
        const lp = new THREE.Vector3(lx + side.x * 22 + dir.x * 12, 0, lz + side.z * 22 + dir.z * 12);
        lp.y = Math.max(H(lp.x, lp.z) + 6, end[5 * (n - 1) + 2] + 5);
        camGoal.pos.copy(lp);
      }
      camGoal.look.copy(b);
    }
  } else addressGoal();
  const k = 1 - Math.exp(-dt * (anim ? 4 : 5));
  camera.position.lerp(camGoal.pos, k);
  camLook.lerp(camGoal.look, k);
  // Never below the ground.
  const gy = H(camera.position.x, camera.position.z) + 0.3;
  if (camera.position.y < gy) camera.position.y = gy;
  camera.lookAt(camLook);
  camDir.subVectors(camLook, camera.position).normalize();
}

// ---- Shot animation -----------------------------------------------------------------------
function stepAnim(rawDt) {
  if (!anim || anim.done) return;
  // Real time (a slow frame does not slow the ball down), faster on request.
  anim.clock = (anim.clock ?? 0) + rawDt * (window.golf?.fast ? 25 : anim.speed);
  const t = anim.clock, { path, n } = anim;
  if (!anim.launched && t >= 0) {
    anim.launched = true;
    const L = anim.r.record.launch;
    sound(anim.isPutt ? 'putt' : 'hit', anim.isPutt ? 0.6 : Math.min(1, L.speed / 70));
  }
  if (t < 0) return;
  // Binary search the path for t.
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path[5 * m] <= t) lo = m; else hi = m; }
  const ta = path[5 * lo], tb = path[5 * hi], f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 1;
  const m = balls[anim.p].mesh;
  m.position.set(path[5 * lo + 1] + (path[5 * hi + 1] - path[5 * lo + 1]) * f, path[5 * lo + 2] + (path[5 * hi + 2] - path[5 * lo + 2]) * f, path[5 * lo + 3] + (path[5 * hi + 3] - path[5 * lo + 3]) * f);
  tracer.geometry.setDrawRange(0, lo + 1);
  while (anim.events.length && anim.events[0].t <= t) {
    const e = anim.events.shift();
    if (e.kind === 'landing' || e.kind === 'bounce') sound('thud', Math.min(1, e.speed / 25));
    else if (e.kind === 'tree' || e.kind === 'trunk') sound('tree');
    else if (e.kind === 'flagstick' || e.kind === 'rim') sound('putt', 0.4);
  }
  if (t >= anim.tEnd) finishAnim();
}

// ---- The golfer at the ball ----
function updateGolfer() {
  if (!game.started || game.state.finished) { golferFig.visible = false; return; }
  const u = golferFig.userData;
  let p, from, aim, club, phase = 0;
  if (anim) {
    p = anim.p; from = anim.r.record.from; aim = anim.r.record.input.aim; club = anim.r.record.input.club;
    const t = anim.clock ?? 0;
    if (t < 0) {
      // The swing before a shot from elsewhere: back in 70 %, down in the rest.
      const f = 1 + t / anim.pre;
      phase = f < 0.7 ? -f / 0.7 : -(1 - (f - 0.7) / 0.3);
      if (club === 'PT') phase *= 0.5;
    } else phase = Math.min(1, t / (club === 'PT' ? 0.5 : 0.45)) * (club === 'PT' ? 0.5 : 1);
  } else {
    p = turnPlayer();
    const b = currentBall();
    if (!b || p < 0 || ui.view === 'look') { golferFig.visible = false; return; }
    from = b.pos; aim = ui.aim; club = clubs.clubs[ui.club]?.code || 'I7';
    const m = ui.meter;
    if (isLocalTurn() && m.phase === 'back') phase = -Math.max(0, Math.min(1.1, m.mark));
    else if (isLocalTurn() && m.phase === 'down') phase = -Math.max(0, m.mark);
    if (club === 'PT') phase *= 0.5;
  }
  golferFig.visible = true;
  u.setColor(COLORS[p % COLORS.length]);
  u.setClub(CLUB_LENGTH[club] || 0.95, club === 'PT');
  placeGolfer(golferFig, from, aim, H, CLUB_LENGTH[club] || 0.95, !!game.cfg.players[p].left);
  u.setPose(phase);
}

// ---- The loop --------------------------------------------------------------------------------
let last = performance.now() / 1000;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000, rawDt = Math.min(0.5, now - last), dt = Math.min(0.05, rawDt);
  last = now;
  if (!info) { renderer.render(scene, camera); return; }
  stepAnim(rawDt);
  meterTick();
  updateCamera(dt);
  updateWindArrow();
  if (game.started && !game.state.finished) {
    const pin = game.state.pin;
    course.flag.position.set(pin[0], pin[1], pin[2]);
    course.flag.userData.wave(now, game.state.wind_toward || 0, game.state.wind_speed || 0);
    const b = currentBall();
    // The flagstick comes out for putts on the green.
    course.flag.userData.pole.visible = course.flag.userData.cloth.visible = !(b && b.surface === 'green' && !anim);
    refreshPreview();
    aimLine.visible &&= !anim && isLocalTurn() && ui.view === 'address' && !game.busy;
    landRing.visible &&= aimLine.visible;
  }
  updateGolfer();
  // The sun's shadow box follows the camera.
  sun.target.position.copy(camLook);
  sun.position.copy(camLook).add(new THREE.Vector3(-300, 600, 250));
  if (city) city.update(camera, scene.fog.far);
  updateLabels();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
load().catch((e) => { console.error(e); loadMsg('Could not start: ' + e.message, 100); });

// A turn link opened in a tab that already has the round: start over from it.
addEventListener('hashchange', () => { if (/[#&]g=/.test(location.hash)) location.reload(); });

// For tests and the console.
window.golf = { game, ui, rpc, get info() { return info; }, meterPress, swingInput, playShot };
