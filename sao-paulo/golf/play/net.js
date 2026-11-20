// São Paulo World · Golf: multiplayer.
//
// A round is fully determined by its configuration and the inputs of its
// shots (the Golf Dynamics core is deterministic, and every browser runs the
// same WebAssembly), so the players only ever exchange those: never positions
// or scores.
//
// Two ways to play together:
// - Turns, by link: the whole round (configuration + shots) travels in the
//   link's #fragment, deflate-compressed. Play your shots, pass the link on.
//   No server at all; the fragment never reaches the web server either.
// - Live: everyone in a room at once, through a relay that forwards each
//   message to the others in the room (golf repository, tools/relay: a
//   dependency-free WebSocket relay; or `local` for tabs of one browser).

// ---- Link codec ---------------------------------------------------------------
const b64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export async function encodeRound(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'undefined') return 'j' + b64url(raw);
  return 'z' + b64url(await pipe(raw, new CompressionStream('deflate-raw')));
}
export async function decodeRound(s) {
  if (!s) return null;
  const kind = s[0], body = unb64url(s.slice(1));
  const raw = kind === 'z' ? await pipe(body, new DecompressionStream('deflate-raw')) : body;
  return JSON.parse(new TextDecoder().decode(raw));
}

// ---- Rooms --------------------------------------------------------------------
export function newId(n = 8) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(r, (v) => a[v % a.length]).join('');
}

// { send(data), close(), peers: Set, onmessage(from, data), onpeers(peers), onstatus(s) }
export function joinRoom({ relay, room, peer }) {
  const handlers = { onmessage: () => {}, onpeers: () => {}, onstatus: () => {} };
  const api = Object.assign(handlers, { peer, room, peers: new Set([peer]), send() {}, close() {} });
  if (relay === 'local') {
    // Tabs of one browser (development and tests).
    const ch = new BroadcastChannel('golf-room-' + room);
    const seen = new Map();
    const announce = () => ch.postMessage({ hello: peer });
    ch.onmessage = (e) => {
      const m = e.data;
      if (m.hello) { if (!api.peers.has(m.hello)) { api.peers.add(m.hello); api.onpeers(api.peers); announce(); } seen.set(m.hello, Date.now()); return; }
      if (m.bye) { api.peers.delete(m.bye); api.onpeers(api.peers); return; }
      if (m.to && m.to !== peer) return;
      api.onmessage(m.from, m.data);
    };
    api.send = (data, to) => ch.postMessage({ from: peer, to, data });
    api.close = () => { ch.postMessage({ bye: peer }); ch.close(); };
    addEventListener('pagehide', () => ch.postMessage({ bye: peer }));
    setTimeout(() => { announce(); api.onstatus('open'); }, 0);
    return api;
  }
  let ws = null, closed = false, backoff = 500, queue = [];
  const connect = () => {
    const u = new URL(relay);
    u.searchParams.set('room', room);
    u.searchParams.set('peer', peer);
    ws = new WebSocket(u.href);
    ws.onopen = () => { backoff = 500; api.onstatus('open'); for (const q of queue) ws.send(q); queue = []; };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'peers') { api.peers = new Set(m.peers); api.onpeers(api.peers); return; }
      if (m.to && m.to !== peer) return;
      api.onmessage(m.from, m.data);
    };
    ws.onclose = () => {
      if (closed) return;
      api.onstatus('reconnecting');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    ws.onerror = () => {};
  };
  connect();
  api.send = (data, to) => {
    const s = JSON.stringify({ from: peer, to, data });
    if (ws && ws.readyState === 1) ws.send(s); else queue.push(s);
  };
  api.close = () => { closed = true; try { ws.close(); } catch { /* closed */ } };
  return api;
}
