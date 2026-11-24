#!/usr/bin/env node
// São Paulo World · flying together: a stand-in for Supabase Realtime, for tests.
//
// It speaks just enough of the Phoenix channels protocol, version 2.0.0, as
// the official @supabase/realtime-js client uses it (flying/vendor/), for a
// "Fly together" room to run against it on this machine: join, heartbeat,
// broadcast (the client's binary user-broadcast frames, and the JSON form),
// presence (track, untrack, presence_state, presence_diff), leave.
// It is NOT the real server: no authorisation, no limits, no database.
// Dependency-free (node:http + a minimal RFC 6455 WebSocket).
//
//   node scripts/flying-mock-relay.mjs [port=8790] [--json]
//   then open  …/flying/?relay=ws://127.0.0.1:8790&room=test
//
// --json   deliver broadcasts as JSON text frames instead of binary ones
//          (the client must take both).
// For tests:  GET /_mock/stats     counts, and the busiest second (messages sent + delivered)
//             GET /_mock/drop      cut every socket (the clients must reconnect and rejoin)
//             GET /_mock/down?ms=  refuse connections for a while
//             GET /_mock/refuse?n= answer the next n joins with an error
import http from 'node:http';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const PORT = +(args.find((a) => /^\d+$/.test(a)) || 8790);
const AS_JSON = args.includes('--json');

const conns = new Set();
const topics = new Map();  // topic → Map(conn → { joinRef, config, key, presence: null | { phx_ref, ...meta } })
const stats = { connections: 0, joins: 0, leaves: 0, heartbeats: 0, tracks: 0, broadcastsIn: 0, broadcastsOut: 0, accessTokens: 0, binaryIn: 0, jsonIn: 0, drops: 0, refused: 0, peakPerSecond: 0, lastJoinPayload: null, lastUrl: '' };
let downUntil = 0, refuseJoins = 0, second = 0, inSecond = 0;
const count = (n = 1) => {
  const s = Math.floor(Date.now() / 1000);
  if (s !== second) { second = s; inSecond = 0; }
  inSecond += n;
  if (inSecond > stats.peakPerSecond) stats.peakPerSecond = inSecond;
};

// ---- WebSocket frames -----------------------------------------------------------
function frame(opcode, payload) {
  const n = payload.length, head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}
const sendText = (c, obj) => { if (!c.socket.destroyed) c.socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); };
const sendBin = (c, buf) => { if (!c.socket.destroyed) c.socket.write(frame(2, buf)); };
function onData(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80;
    let n = b[1] & 127, at = 2;
    if (n === 126) { if (b.length < 4) return; n = b.readUInt16BE(2); at = 4; } else if (n === 127) { if (b.length < 10) return; n = Number(b.readBigUInt64BE(2)); at = 10; }
    const need = at + (masked ? 4 : 0) + n;
    if (b.length < need) return;
    let data = b.subarray(at + (masked ? 4 : 0), need);
    if (masked) { const k = b.subarray(at, at + 4); data = Buffer.from(data); for (let i = 0; i < n; ++i) data[i] ^= k[i & 3]; }
    c.buf = b.subarray(need);
    if (op === 8) { c.socket.end(frame(8, Buffer.alloc(0))); return; }
    if (op === 9) { c.socket.write(frame(10, data)); continue; }
    if (op === 10) continue;
    if (op === 0) { c.part = Buffer.concat([c.part, data]); if (fin) { onMessage(c, c.partOp, c.part); c.part = Buffer.alloc(0); } continue; }
    if (!fin) { c.part = Buffer.from(data); c.partOp = op; continue; }
    onMessage(c, op, data);
  }
}

// ---- Phoenix channels, as Realtime uses them ---------------------------------------
const members = (topic) => topics.get(topic) || new Map();
const reply = (c, joinRef, ref, topic, status, response = {}) => sendText(c, [joinRef, ref, topic, 'phx_reply', { status, response }]);
function presenceState(topic) {
  const st = {};
  for (const m of members(topic).values()) if (m.presence) (st[m.key] ||= { metas: [] }).metas.push(m.presence);
  return st;
}
function presenceDiff(topic, joins, leaves) {
  for (const [c] of members(topic)) { sendText(c, [null, null, topic, 'presence_diff', { joins, leaves }]); count(); }
}
function leave(c, topic) {
  const m = members(topic).get(c);
  if (!m) return;
  members(topic).delete(c);
  if (!members(topic).size) topics.delete(topic);
  stats.leaves++;
  if (m.presence) presenceDiff(topic, {}, { [m.key]: { metas: [m.presence] } });
}
function fanOut(from, topic, event, deliver) {
  const self = members(topic).get(from)?.config?.broadcast?.self;
  stats.broadcastsIn++; count();
  for (const [c] of members(topic)) {
    if (c === from && !self) continue;
    deliver(c); stats.broadcastsOut++; count();
  }
}
function onMessage(c, op, data) {
  if (op === 2) {
    // A user broadcast push: [3, joinRef n, ref n, topic n, event n, metadata n, encoding] then those strings, then the payload.
    if (data[0] !== 3 || data.length < 7) return;
    stats.binaryIn++;
    const [, nj, nr, nt, ne, nm, enc] = data;
    let at = 7 + nj + nr;
    const topic = data.subarray(at, at += nt).toString(), event = data.subarray(at, at += ne).toString(), meta = data.subarray(at, at += nm), payload = data.subarray(at);
    if (!members(topic).has(c)) return;
    if (AS_JSON && enc === 1) {
      let p; try { p = JSON.parse(payload.toString()); } catch { return; }
      fanOut(c, topic, event, (to) => sendText(to, [null, null, topic, 'broadcast', { type: 'broadcast', event, payload: p }]));
    } else {
      // Delivered as a user broadcast: [4, topic n, event n, metadata n, encoding] …
      const out = Buffer.concat([Buffer.from([4, nt, ne, nm, enc]), Buffer.from(topic), Buffer.from(event), meta, payload]);
      fanOut(c, topic, event, (to) => sendBin(to, out));
    }
    return;
  }
  let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
  if (!Array.isArray(msg) || msg.length !== 5) return;
  stats.jsonIn++;
  const [joinRef, ref, topic, event, payload] = msg;
  if (topic === 'phoenix' && event === 'heartbeat') { stats.heartbeats++; reply(c, null, ref, 'phoenix', 'ok'); return; }
  if (event === 'phx_join') {
    stats.lastJoinPayload = payload;
    if (refuseJoins > 0) { refuseJoins--; stats.refused++; reply(c, joinRef, ref, topic, 'error', { reason: 'too_many_joins' }); return; }
    const cfg = payload?.config || {};
    members(topic).delete(c);
    if (!topics.has(topic)) topics.set(topic, new Map());
    topics.get(topic).set(c, { joinRef, config: cfg, key: cfg.presence?.key || crypto.randomUUID(), presence: null });
    stats.joins++;
    reply(c, joinRef, ref, topic, 'ok', { postgres_changes: [] });
    if (cfg.presence?.enabled) { sendText(c, [joinRef, null, topic, 'presence_state', presenceState(topic)]); count(); }
    return;
  }
  const m = members(topic).get(c);
  if (!m) { reply(c, joinRef, ref, topic, 'error', { reason: 'unmatched topic' }); return; }
  if (event === 'phx_leave') { leave(c, topic); reply(c, joinRef, ref, topic, 'ok'); sendText(c, [joinRef, joinRef, topic, 'phx_close', {}]); return; }
  if (event === 'access_token') { stats.accessTokens++; return; }
  if (event === 'presence' && payload?.type === 'presence') {
    count();
    const was = m.presence;
    if (payload.event === 'track') {
      stats.tracks++;
      m.presence = { phx_ref: crypto.randomBytes(6).toString('base64'), ...(was ? { phx_ref_prev: was.phx_ref } : {}), ...(payload.payload || {}) };
      presenceDiff(topic, { [m.key]: { metas: [m.presence] } }, was ? { [m.key]: { metas: [was] } } : {});
    } else if (payload.event === 'untrack' && was) {
      m.presence = null;
      presenceDiff(topic, {}, { [m.key]: { metas: [was] } });
    }
    reply(c, joinRef, ref, topic, 'ok');
    return;
  }
  if (event === 'broadcast' && payload?.type === 'broadcast') {
    fanOut(c, topic, payload.event, (to) => sendText(to, [null, null, topic, 'broadcast', payload]));
    if (m.config?.broadcast?.ack) reply(c, joinRef, ref, topic, 'ok');
  }
}

// ---- The server ------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/_mock/stats') {
    res.end(JSON.stringify({ ...stats, open: conns.size, topics: Object.fromEntries([...topics].map(([t, m]) => [t, { members: m.size, present: Object.keys(presenceState(t)) }])) }));
  } else if (u.pathname === '/_mock/drop') {
    stats.drops++;
    for (const c of [...conns]) c.socket.destroy();
    res.end('{"ok":true}');
  } else if (u.pathname === '/_mock/down') {
    downUntil = Date.now() + (+u.searchParams.get('ms') || 3000);
    res.end('{"ok":true}');
  } else if (u.pathname === '/_mock/refuse') {
    refuseJoins = +u.searchParams.get('n') || 1;
    res.end('{"ok":true}');
  } else if (u.pathname === '/_mock/reset') {
    for (const k of Object.keys(stats)) if (typeof stats[k] === 'number') stats[k] = 0;
    res.end('{"ok":true}');
  } else { res.statusCode = 404; res.end('{"error":"not found"}'); }
});
server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
  stats.lastUrl = req.url;
  if (Date.now() < downUntil) { socket.destroy(); return; }
  if (!u.pathname.endsWith('/websocket') || !key || !u.searchParams.get('apikey')) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), part: Buffer.alloc(0), partOp: 1 };
  conns.add(c); stats.connections++;
  socket.on('data', (d) => { try { onData(c, d); } catch (e) { console.error('mock relay:', e.message); socket.destroy(); } });
  const gone = () => { if (!conns.delete(c)) return; for (const t of [...topics.keys()]) leave(c, t); };
  socket.on('close', gone); socket.on('error', gone);
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock Realtime relay on ws://127.0.0.1:${PORT}/realtime/v1/websocket${AS_JSON ? ' (JSON broadcasts)' : ''}`));
