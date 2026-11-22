// São Paulo World · flying together: the link between the players of a room.
//
// One small interface, two ways to carry it:
//  - 'local': a BroadcastChannel between tabs and pages of one browser
//    (development, tests, and flying against yourself);
//  - 'supabase': Supabase Realtime Broadcast + Presence on a public channel
//    named after the room, through the official client (vendor/, pinned),
//    with only the project's URL and publishable key. Nothing is stored.
//
// link = openLink({ relay, room, peer, meta })
//   link.send(event, data)        to everyone else in the room (dropped while not connected)
//   link.setMeta(meta)            what the others see of this player (name, aircraft; the host: the room's settings)
//   link.close()
//   link.onmessage(event, data)   from anyone else: UNTRUSTED, validate before use
//   link.onpeers(Map id → meta)   everyone in the room now, this player included: UNTRUSTED metas
//   link.onstatus(status, detail) 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed'
//   link.onclash()                another tab is in the room under this player's id (a duplicated tab)

const VENDOR = './vendor/supabase-realtime-js-2.119.2.esm.min.mjs';

export function openLink({ relay, room, peer, meta }) {
  const link = { kind: relay.kind, room, peer, peers: new Map(), status: 'connecting', onmessage() {}, onpeers() {}, onstatus() {}, onclash() {}, send() {}, setMeta() {}, close() {}, impair: null };
  const status = (s, detail) => { if (link.status === 'closed') return; link.status = s; link.onstatus(s, detail); };
  if (relay.kind === 'local') openLocal(link, meta, status);
  else openSupabase(link, relay, meta, status);
  return link;
}

// ---- Tabs of one browser -----------------------------------------------------------
function openLocal(link, meta, status) {
  const ch = new BroadcastChannel('spw-fly-room-' + link.room), seen = new Map();
  let closed = false, deliverAt = 0;
  const hello = (want) => ch.postMessage({ k: 'hello', id: link.peer, meta, want });
  const peersChanged = () => link.onpeers(link.peers);
  const deliver = (m) => { if (!closed) link.onmessage(m.ev, m.d); };
  ch.onmessage = (e) => {
    const m = e.data;
    if (closed || !m || typeof m !== 'object') return;
    // (A channel never hears itself: this id from elsewhere is another tab using it.)
    if (m.id === link.peer) { if (m.k === 'hello') link.onclash(); return; }
    if (m.k === 'hello') {
      const had = link.peers.get(m.id);
      seen.set(m.id, Date.now());
      if (!had || JSON.stringify(had) !== JSON.stringify(m.meta)) { link.peers.set(m.id, m.meta); peersChanged(); }
      if (m.want) hello(false);
    } else if (m.k === 'bye') {
      seen.delete(m.id);
      if (link.peers.delete(m.id)) peersChanged();
    } else if (m.k === 'm') {
      seen.set(m.id, Date.now());
      // Tests: a slow, uneven or lossy network (link.impair = { lag, jitter, loss }), in order as a socket delivers.
      const im = link.impair;
      if (!im) { deliver(m); return; }
      if (Math.random() < (im.loss || 0)) return;
      deliverAt = Math.max(deliverAt, performance.now() + (im.lag || 0) + Math.random() * (im.jitter || 0));
      setTimeout(deliver, deliverAt - performance.now(), m);
    }
  };
  // Still here, every 2 s; a tab that went without saying so is dropped after 7.
  const beat = setInterval(() => {
    hello(false);
    let gone = false;
    for (const [id, t] of seen) if (Date.now() - t > 7000) { seen.delete(id); gone = link.peers.delete(id) || gone; }
    if (gone) peersChanged();
  }, 2000);
  const bye = () => { try { ch.postMessage({ k: 'bye', id: link.peer }); } catch { /* closed */ } };
  addEventListener('pagehide', bye);
  link.send = (ev, d) => { if (!closed) ch.postMessage({ k: 'm', id: link.peer, ev, d }); };
  link.setMeta = (m) => { meta = m; link.peers.set(link.peer, meta); if (!closed) { hello(false); peersChanged(); } };
  link.close = () => { if (closed) return; bye(); closed = true; clearInterval(beat); removeEventListener('pagehide', bye); ch.close(); status('closed'); link.status = 'closed'; };
  link.peers.set(link.peer, meta);
  setTimeout(() => { if (closed) return; hello(true); status('open'); peersChanged(); }, 0);
}

// ---- Supabase Realtime ---------------------------------------------------------------
// As supabase-js sets its Realtime client up for a visitor who is not signed
// in: the key as the `apikey` parameter and as the access token. The client
// reconnects by itself (1, 2, 5, then every 10 s) and rejoins the channel;
// presence is tracked again after every join.
function openSupabase(link, relay, meta, status) {
  let closed = false, client = null, ch = null, joined = false, everOpen = false, fails = 0;
  const peersNow = () => {
    const st = ch.presenceState(), peers = new Map();
    for (const id of Object.keys(st)) { const metas = st[id]; if (Array.isArray(metas) && metas.length) peers.set(id, metas[metas.length - 1]); }
    // Two presences under this player's key: another tab has the same id; the later one changes its own.
    const mine = st[link.peer];
    if (Array.isArray(mine) && mine.length > 1 && mine.some((m) => m && m.since < meta.since)) { link.onclash(); return; }
    // This player shows at once, whatever the server has said so far.
    if (!peers.has(link.peer)) peers.set(link.peer, meta);
    link.peers = peers;
    link.onpeers(peers);
  };
  const track = () => { if (joined) ch.track(meta).catch(() => {}); };
  link.send = (ev, d) => { if (joined && ch.state === 'joined') ch.send({ type: 'broadcast', event: ev, payload: { d } }).catch(() => {}); };
  link.setMeta = (m) => { meta = m; track(); };
  link.close = () => {
    if (closed) return;
    closed = true; joined = false;
    status('closed'); link.status = 'closed';
    if (client) { try { client.removeChannel(ch).catch(() => {}).then(() => client.disconnect()); } catch { /* gone */ } }
  };
  link.peers.set(link.peer, meta);
  import(VENDOR).then(({ RealtimeClient }) => {
    if (closed) return;
    const end = relay.url.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/realtime/v1';
    client = new RealtimeClient(end, { params: { apikey: relay.key }, accessToken: async () => relay.key });
    ch = client.channel('fly-' + link.room, { config: { broadcast: { self: false, ack: false }, presence: { key: link.peer } } });
    ch.on('broadcast', { event: 's' }, (m) => { if (!closed && m && m.payload) link.onmessage('s', m.payload.d); });
    ch.on('presence', { event: 'sync' }, () => { if (!closed) peersNow(); });
    ch.subscribe((s, err) => {
      if (closed) return;
      if (s === 'SUBSCRIBED') { joined = true; everOpen = true; fails = 0; track(); status('open'); peersNow(); return; }
      joined = false;
      // The server said why (the project's limits: too many connections, joins or messages).
      const why = String(err?.message || '');
      if (!everOpen && ++fails >= 3) status('failed', why);
      else status('reconnecting', why);
    });
    // The socket itself: gone (the client is already reconnecting), or never opened.
    client.socketAdapter.onClose(() => { if (closed) return; joined = false; if (!everOpen && ++fails >= 3) status('failed', ''); else status('reconnecting', ''); });
    client.socketAdapter.onError(() => { /* onClose follows */ });
  }).catch((e) => status('failed', String(e?.message || e)));
}
