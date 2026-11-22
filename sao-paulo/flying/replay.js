// São Paulo World · flying: your own flight recorded, and flown again as a ghost.
//
// The flight is kept in the same compact states the players of a room send
// each other (netstate.js), sampled the same way: often while manoeuvring,
// seldom when straight. A recording begins at every restart. The ghost is
// that recording played back through the same drawing as another player
// (net.js): fly beside it, or "Fly to" it. A clip, the last minute or so,
// travels as a link (deflated in the #fragment, which never reaches the web
// server) or as a small file.
//
// Not here (left out for now): a replay view with a scrub bar and its own cameras.
import { F, packRows, unpackRows, decodeState, cleanName, qAdvance, qAngle, turnTime } from './netstate.js';

const STR = {
  title: 'Your ghost',
  intro: 'Fly the same start again beside your own recorded flight, or send it to a friend.',
  fly: 'Fly with your ghost',
  flyTheirs: (name) => `Fly with ${name}'s flight`,
  none: 'Fly for a few seconds first.',
  stop: 'Stop the ghost',
  share: 'Copy a link to my last minute',
  copied: (kb) => `Link copied (${kb} kB).`,
  save: 'Save',
  open: 'Open…',
  ghostOf: (name) => `${name}'s ghost`,
  mine: 'Your ghost',
  loaded: (name, sec) => `${name} sent a flight (${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}). Open "Fly together" to fly with it.`,
  bad: 'That flight could not be read.',
  started: 'Your ghost is flying. Stay with it!',
};
const REC = { minGap: 250, maxGap: 1000, posErr: 1, angErr: 3, maxRows: 2400, clipSec: 60, clipChars: 7000 };
const DEG = Math.PI / 180;

// ---- A clip as text: 'z' + base64url(deflate(bytes)) or 'j' + base64url(bytes) -----------------
const b64url = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; };
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
// [1, colour, name length, name…] then the rows (netstate packRows).
export async function encodeClip({ rows, name, color }) {
  const nm = new TextEncoder().encode(cleanName(name)).subarray(0, 64), body = packRows(rows);
  const raw = new Uint8Array(3 + nm.length + body.length);
  raw.set([1, color & 7, nm.length]); raw.set(nm, 3); raw.set(body, 3 + nm.length);
  if (typeof CompressionStream === 'undefined') return 'j' + b64url(raw);
  return 'z' + b64url(await pipe(raw, new CompressionStream('deflate-raw')));
}
// A link or file from anyone: every part checked; null if it is not a clip.
export async function decodeClip(text) {
  try {
    if (typeof text !== 'string' || text.length < 8 || text.length > 200000 || !/^[zj][A-Za-z0-9_-]+$/.test(text)) return null;
    let raw = unb64url(text.slice(1));
    if (text[0] === 'z') raw = await pipe(raw, new DecompressionStream('deflate-raw'));
    if (raw.length > 1e6 || raw[0] !== 1 || raw.length < 3 + raw[2]) return null;
    const name = cleanName(new TextDecoder().decode(raw.subarray(3, 3 + raw[2])));
    const rows = unpackRows(raw, 1e12, 3 + raw[2]);
    if (!rows || rows.length < 2) return null;
    // Only well-formed states, in time order, at most a quarter of an hour.
    const good = [];
    for (const r of rows) { const st = decodeState(r); if (st && (!good.length || (r[1] > good[good.length - 1][1] && r[1] - good[0][1] < 900000))) good.push(r); }
    return good.length < 2 ? null : { rows: good, name, color: raw[1] & 7, seconds: (good[good.length - 1][1] - good[0][1]) / 1000 };
  } catch { return null; }
}

export function mountReplay(net, ctx) {
  // ---- Recording ----
  let seg = null, kept = null;  // the flight since the last restart, and the one before
  const lastRec = { t: 0, p: [0, 0, 0], v: [0, 0, 0], q: [0, 0, 0, 1], w: [0, 0, 0], flags: -1, gear: 0, flap: 0, e1: 0 }, qPred = [0, 0, 0, 1];
  const seconds = (s) => (s && s.rows.length > 1 ? (s.rows[s.rows.length - 1][1] - s.rows[0][1]) / 1000 : 0);
  net.recordFrame = (now, own, rate, encode) => {
    const epoch = (own.flags >> F.epochShift) & F.epochMask;
    if (!seg || seg.epoch !== epoch) {
      if (seconds(seg) >= 8) kept = seg;
      seg = { rows: [], epoch, start: ctx.startIndex() };
      lastRec.flags = -1;
    }
    const since = now - lastRec.t;
    if (lastRec.flags !== -1 && since < REC.minGap) return;
    let take = lastRec.flags === -1 || since >= REC.maxGap || own.flags !== lastRec.flags || Math.abs(own.gear - lastRec.gear) > 0.08 || Math.abs(own.flap - lastRec.flap) > 1.5 || Math.abs(own.e1 - lastRec.e1) > Math.max(60, 0.08 * lastRec.e1);
    if (!take) {
      const dt = since / 1000;
      take = Math.hypot(lastRec.p[0] + lastRec.v[0] * dt - own.p[0], lastRec.p[1] + lastRec.v[1] * dt - own.p[1], lastRec.p[2] + lastRec.v[2] * dt - own.p[2]) > REC.posErr
        || qAngle(qAdvance(lastRec.q, lastRec.w, turnTime(dt), qPred), own.q) > REC.angErr * DEG;
    }
    // (Nothing to keep of a paused or crashed aircraft that is already on record.)
    if (!take || (rate === 0 && lastRec.flags === own.flags && since < 5000)) return;
    seg.rows.push(encode());
    if (seg.rows.length > REC.maxRows) seg.rows.shift();
    lastRec.t = now; lastRec.flags = own.flags; lastRec.gear = own.gear; lastRec.flap = own.flap; lastRec.e1 = own.e1;
    for (let i = 0; i < 3; ++i) { lastRec.p[i] = own.p[i]; lastRec.v[i] = own.v[i] * rate; lastRec.w[i] = own.w[i] * rate; }
    for (let i = 0; i < 4; ++i) lastRec.q[i] = own.q[i];
  };
  // The flight to replay: this one if there is enough of it, else the one before.
  const best = () => (seconds(seg) >= 8 ? seg : kept);

  // ---- The ghost ----
  let theirs = null;  // a clip that arrived by link or file: { rows, name, color, seconds }
  function flyMine() {
    const s = best();
    if (!s) { ctx.toast(STR.none, 2.5); return false; }
    const rows = s.rows.slice();
    // The same start again, the ghost beside (inside, at first) this aircraft.
    ctx.restart(s.start);
    net.playGhost(rows, { name: STR.mine, color: net.me.color });
    ctx.toast(STR.started, 3);
    // (A start that is no longer where the recording began: go to the ghost instead.)
    beside(300);
    return true;
  }
  // Once the ghost is drawn (a frame or two from now): beside it in the air, if it is farther than `far` metres.
  function beside(far) {
    let tries = 0;
    const go = () => { const g = net.ghost; if (!g) return; if (!g.has && ++tries < 40) { setTimeout(go, 50); return; } if (g.has && g.dist > far) net.flyTo(g.id); };
    setTimeout(go, 50);
  }
  function flyTheirs() {
    if (!theirs) return false;
    net.playGhost(theirs.rows, { name: STR.ghostOf(theirs.name), color: theirs.color });
    beside(0);
    return true;
  }
  // The last minute as a link: shortened until it is a reasonable length.
  async function clipLink() {
    const s = best();
    if (!s) return null;
    for (let sec = REC.clipSec; sec >= 10; sec *= 0.7) {
      const end = s.rows[s.rows.length - 1][1], rows = s.rows.filter((r) => r[1] >= end - sec * 1000);
      const code = await encodeClip({ rows, name: net.me.name, color: net.me.color });
      if (code.length <= REC.clipChars || sec * 0.7 < 10) return { code, url: `${location.origin}${location.pathname.replace(/index\.html$/, '')}#ghost=${code}`, rows: rows.length, seconds: (end - rows[0][1]) / 1000 };
    }
    return null;
  }
  async function load(text) {
    const clip = await decodeClip(String(text).trim().replace(/^.*#ghost=/, ''));
    if (!clip) { ctx.toast(STR.bad, 3); return false; }
    theirs = clip;
    ctx.toast(STR.loaded(clip.name, clip.seconds), 5);
    net.ui.refresh();
    return true;
  }

  // ---- Its buttons, in the Fly together panel ----
  net.panelExtra = (el) => {
    const kids = [el('h2', { text: STR.title, style: 'margin-top:14px' }), el('p', { text: STR.intro })];
    if (net.ghost) kids.push(el('button', { class: 'net-alt', id: 'ghostStop', text: STR.stop, onclick: () => net.stopGhost() }));
    if (theirs) kids.push(el('button', { class: 'net-go', id: 'ghostTheirs', text: STR.flyTheirs(theirs.name), onclick: () => { flyTheirs(); if (ctx.MOBILE) net.ui.close(); } }));
    const mine = el('button', { class: theirs ? 'net-alt' : 'net-go', id: 'ghostMine', text: STR.fly, onclick: () => { if (flyMine() && ctx.MOBILE) net.ui.close(); } });
    kids.push(mine);
    const share = el('button', { id: 'ghostShare', text: STR.share, onclick: async () => {
      const c = await clipLink();
      if (!c) { ctx.toast(STR.none, 2.5); return; }
      try { await navigator.clipboard.writeText(c.url); } catch { window.prompt(STR.share, c.url); }
      ctx.toast(STR.copied((c.url.length / 1000).toFixed(1)), 3);
    } });
    const save = el('button', { id: 'ghostSave', text: STR.save, onclick: async () => {
      const c = await clipLink();
      if (!c) { ctx.toast(STR.none, 2.5); return; }
      const a = el('a', { href: URL.createObjectURL(new Blob([c.code], { type: 'text/plain' })), download: 'flight.spwflight' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } });
    const file = el('input', { type: 'file', accept: '.spwflight,text/plain', hidden: '', onchange: async () => { const f = file.files[0]; if (f && f.size < 300000) await load(await f.text()); file.value = ''; } });
    kids.push(el('div', { class: 'net-foot', style: 'margin-top:6px;justify-content:flex-start' }, share, save, el('button', { id: 'ghostOpen', text: STR.open, onclick: () => file.click() }), file));
    return kids;
  };

  // A link with a flight in its fragment.
  if (location.hash.startsWith('#ghost=')) load(location.hash).then((ok) => { if (ok) net.ui.open(); });
  return { get seconds() { return seconds(best()); }, get rows() { return best()?.rows.length || 0; }, flyMine, flyTheirs, clipLink, load, get theirs() { return theirs; } };
}
