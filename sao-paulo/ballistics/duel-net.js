// São Paulo World · Ballistics Range · the duel's link between two browsers.
//
// The engine flies a round the same, bit for bit, on every machine
// (ADR 0004 in Ballistic Dynamics), so a duel never sends a trajectory: each
// side sends only what its shooter did (the rifle, the aim, the instant of
// the shot) and both browsers fly the same round to the same impact.
//
// Two ways to connect:
//  - 'rtc': a direct WebRTC data channel between the two browsers. No game
//    server: the challenger's link carries the connection offer; the friend's
//    browser answers with a reply link they send back; opening that reply
//    link (any tab of the challenger's browser) hands the answer to the duel
//    tab through a BroadcastChannel. STUN only (no TURN relay): two players
//    both behind strict carrier NATs may not connect.
//  - 'local': two tabs of one browser through a BroadcastChannel (testing,
//    or a duel against yourself).
//
//  - 'meet': a Railgun Meet hostless voice channel `duel-<id>` (LiveKit). One
//    link, no reply: both players join the channel; the shots go on its data
//    topic `rg.duel.v1`, and you can talk. LiveKit's servers relay it, so it
//    connects through any network. Needs meet.railgun.chat to answer this
//    site's join (its MEET_CROSS_ORIGIN_VOICE); until then the challenge
//    falls back to 'rtc' by itself.
//
// Messages are small JSON objects; `send` drops them until the link is open.

const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const GATHER_MS = 2500;  // wait this long at most for the network candidates

// base64url of deflate-raw(JSON): a connection offer is ~0.5 kB as a link.
async function pack(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let out = bytes, tag = 'j';
  if (typeof CompressionStream !== 'undefined') {
    out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    tag = 'z';
  }
  let s = '';
  for (const b of out) s += String.fromCharCode(b);
  return tag + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function unpack(code) {
  const tag = code[0], b64 = code.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  let bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (tag === 'z') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(bytes));
}

function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
  });
}

export const newDuelId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

class Link {
  constructor() { this.open = false; this.onopen = null; this.onmessage = null; this.onclose = null; this.kind = ''; }
  _opened() { if (this.open) return; this.open = true; this.onopen?.(); }
  _closed() { if (!this.open) return; this.open = false; this.onclose?.(); }
  _recv(text) { try { const m = JSON.parse(text); if (m && typeof m === 'object') this.onmessage?.(m); } catch { /* not ours */ } }
}

class RtcLink extends Link {
  constructor() {
    super();
    this.kind = 'rtc';
    this.pc = new RTCPeerConnection({ iceServers: STUN });
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') this._closed();
    });
  }
  _wire(dc) {
    this.dc = dc;
    dc.onopen = () => this._opened();
    dc.onclose = () => this._closed();
    dc.onmessage = (e) => this._recv(e.data);
    if (dc.readyState === 'open') this._opened();
  }
  send(m) { if (this.open && this.dc?.readyState === 'open') this.dc.send(JSON.stringify(m)); }
  close() { try { this.pc.close(); } catch { /* closed */ } this._closed(); }
}

// The challenger: an offer to put in the duel link, then the friend's answer.
export async function hostRtc(id) {
  const link = new RtcLink();
  link._wire(link.pc.createDataChannel('rg.duel.v1', { ordered: true }));
  await link.pc.setLocalDescription(await link.pc.createOffer());
  await gathered(link.pc);
  link.offer = await pack({ t: link.pc.localDescription.type, s: link.pc.localDescription.sdp });
  // The reply link, opened in another tab of this browser, posts the answer here.
  link.bc = new BroadcastChannel('spw-duel-' + id);
  link.accept = async (answerCode) => {
    if (link.pc.signalingState !== 'have-local-offer') return false;
    const a = await unpack(answerCode);
    await link.pc.setRemoteDescription({ type: a.t, sdp: a.s });
    return true;
  };
  link.bc.onmessage = async (e) => {
    if (e.data?.answer && (await link.accept(e.data.answer).catch(() => false))) link.bc.postMessage({ ack: true });
  };
  return link;
}

// The friend: answer the offer from the link; the reply code goes back to the challenger.
export async function joinRtc(offerCode) {
  const link = new RtcLink();
  link.pc.ondatachannel = (e) => link._wire(e.channel);
  const o = await unpack(offerCode);
  await link.pc.setRemoteDescription({ type: o.t, sdp: o.s });
  await link.pc.setLocalDescription(await link.pc.createAnswer());
  await gathered(link.pc);
  link.answer = await pack({ t: link.pc.localDescription.type, s: link.pc.localDescription.sdp });
  return link;
}

// The reply link opened in the challenger's browser: hand the answer to the
// duel tab. Resolves true when that tab took it.
export function deliverAnswer(id, answerCode, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const bc = new BroadcastChannel('spw-duel-' + id);
    const done = (ok) => { clearTimeout(t); clearInterval(again); bc.close(); resolve(ok); };
    bc.onmessage = (e) => { if (e.data?.ack) done(true); };
    const post = () => bc.postMessage({ answer: answerCode });
    const again = setInterval(post, 500);
    const t = setTimeout(() => done(false), timeoutMs);
    post();
  });
}

// Two tabs of one browser.
export function localLink(id, seat) {
  const link = new Link();
  link.kind = 'local';
  const bc = new BroadcastChannel('spw-duel-local-' + id);
  bc.onmessage = (e) => {
    if (e.data?.from === seat) return;
    if (e.data?.hi && !link.open) { bc.postMessage({ from: seat, hi: true }); link._opened(); return; }
    if (e.data?.m) link._recv(e.data.m);
  };
  link.send = (m) => { if (link.open) bc.postMessage({ from: seat, m: JSON.stringify(m) }); };
  link.close = () => { bc.close(); link._closed(); };
  bc.postMessage({ from: seat, hi: true });
  return link;
}

export { pack, unpack };

// Railgun Meet: a voice channel for two. The other player is the remote
// participant named for the other seat (anyone else who wanders into the
// channel, from Meet itself, is ignored).
const MEET = 'https://meet.railgun.chat';
const TOPIC = 'rg.duel.v1';
export async function meetLink(id, seat, timeoutMs = 6000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  let j;
  try {
    const res = await fetch(`${MEET}/api/rooms/duel-${id}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ displayName: 'duel:' + seat, voice: true, audio: true, video: false }),
    });
    j = await res.json().catch(() => ({}));
    if (!res.ok || !j.livekitUrl || !j.token) throw new Error(j.error || 'HTTP ' + res.status);
  } finally { clearTimeout(t); }
  const { Room, RoomEvent, ConnectionState, Track } = await import('./vendor/livekit-client-2.22.1.esm.min.mjs');
  const room = new Room();
  const link = new Link();
  link.kind = 'meet';
  link.room = room;
  const other = 'duel:' + (seat === 'A' ? 'B' : 'A');
  let peer = null;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const pick = () => {
    if (peer) return;
    for (const p of room.remoteParticipants.values()) if (p.name === other) { peer = p.identity; link._opened(); return; }
  };
  room.on(RoomEvent.ParticipantConnected, pick);
  room.on(RoomEvent.ParticipantDisconnected, (p) => { if (p.identity === peer) { peer = null; link._closed(); } });
  room.on(RoomEvent.DataReceived, (payload, p, _kind, topic) => { if (topic === TOPIC && p?.identity === peer) link._recv(dec.decode(payload)); });
  room.on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
    if (track.kind !== Track.Kind.Audio || p?.identity !== peer) return;
    const el = track.attach();
    el.dataset.duel = '1';
    document.body.appendChild(el);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => { for (const el of track.detach()) el.remove(); });
  room.on(RoomEvent.Disconnected, () => link._closed());
  await room.connect(j.livekitUrl, j.token);
  pick();
  // Nothing is sent before the room is Connected (Meet's send rule, §0 of
  // its wire protocols: livekit-client 2.22 poisons a send made earlier).
  link.send = (m) => {
    if (!link.open || room.state !== ConnectionState.Connected) return;
    room.localParticipant.publishData(enc.encode(JSON.stringify(m)), { reliable: true, topic: TOPIC }).catch(() => {});
  };
  link.mic = (on) => room.localParticipant.setMicrophoneEnabled(on);
  link.startAudio = () => room.startAudio().catch(() => {});
  link.close = () => { room.disconnect(); link._closed(); };
  return link;
}
