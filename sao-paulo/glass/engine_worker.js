// Glass Lab · the fracture engine in a worker. The page calls it
// synchronously through shared memory (engine_rpc.js); between calls the
// worker steps the engine on toward the time the page last asked for, so the
// physics runs on its own core while the page draws.
import createGlassModule from './glass.mjs';
import { Writer, Reader, C, S } from './engine_codec.js';

onmessage = async (e) => {
  const { ctl: ctlBuf, status: statusBuf, req: reqBuf, res: resBuf, wasm, slow = 1 } = e.data;
  const ctl = new Int32Array(ctlBuf), st = new Float64Array(statusBuf);
  const rd = new Reader(reqBuf), wr = new Writer(resBuf);
  let G;
  try {
    G = await createGlassModule(await (await fetch(wasm, { cache: 'no-cache' })).arrayBuffer());
  } catch (err) {
    postMessage({ error: String(err && err.message || err) });
    return;
  }
  // Calls only the worker knows: a benchmark run here (a call costs as much
  // as a short engine step), and the time to step on toward.
  let target = 0;
  const local = {
    __bench(ms) {
      G.gls_bench(2);
      const t0 = performance.now();
      let n = 0;
      while (performance.now() - t0 < ms && n < 400) { G.gls_bench(2); n += 2; }
      return (performance.now() - t0) / Math.max(1, n);
    },
    __go(t) { target = t; Atomics.store(ctl, C.WANT, 0); st[S.TARGET] = t; return G.gls_time(); },
    __stop() { target = 0; st[S.TARGET] = 0; return G.gls_time(); },
    // New piece shapes as the engine lays them out (one Float32Array, parsed
    // on the page): thousands of small outlines cost far less this way.
    fragmentShapes(from) {
      const p = G.gls_fragment_shapes(from), mem = G.memory;
      const f = new Float32Array(mem.buffer, p, (mem.buffer.byteLength - p) >> 2);
      let k = 1;
      for (let i = 0, n = f[0]; i < n; ++i) {
        k += 5 + 2 * f[k + 4];
        for (let h = 0, nh = f[k++]; h < nh; ++h) k += 1 + 2 * f[k];
      }
      return f.slice(0, k);
    },
  };
  // Calls that change which pane is stepped, or step it themselves, end the
  // stepping on its own: the page asks for it again (G.go) when it wants it.
  const CANCEL = new Set(['gls_select', 'gls_new_pane', 'gls_new_pane_sized', 'gls_free_pane', 'gls_advance', 'gls_set_floor', 'load']);
  postMessage({ ready: true });
  let seen = Atomics.load(ctl, C.REQ), msPerStep = 0.05;
  for (;;) {
    const req = Atomics.load(ctl, C.REQ);
    if (req !== seen) {
      seen = req;
      rd.reset(); wr.reset();
      try {
        const name = rd.value(), args = rd.value();
        const fn = local[name] || G[name];
        if (typeof fn !== 'function') throw new Error('no engine call ' + name);
        if (CANCEL.has(name)) { target = 0; st[S.TARGET] = 0; }
        wr.value(fn.apply(G, args));
        Atomics.store(ctl, C.OK, 1);
      } catch (err) {
        wr.reset().value(String(err && err.message || err));
        Atomics.store(ctl, C.OK, 0);
      }
      st[S.TIME] = G.gls_time();
      Atomics.store(ctl, C.RES, req);
      Atomics.notify(ctl, C.RES);
      continue;
    }
    if (Atomics.load(ctl, C.WANT) === 0 && target > G.gls_time()) {
      // A few milliseconds of steps at a time, so a call never waits long.
      Atomics.store(ctl, C.BUSY, 1);
      const steps = Math.max(1, Math.min(200000, Math.floor(3 / Math.max(msPerStep, 1e-5))));
      const t0 = performance.now();
      const n = G.gls_advance(target, steps);
      // Testing only (?slowphys=k): stand in for a CPU k times slower.
      if (slow > 1) { const until = t0 + slow * (performance.now() - t0); while (performance.now() < until) { /* slow CPU */ } }
      const el = performance.now() - t0;
      if (n > 0) msPerStep = 0.8 * msPerStep + 0.2 * (el / n);
      st[S.TIME] = G.gls_time();
      st[S.MS_PER_STEP] = msPerStep;
      Atomics.store(ctl, C.BUSY, 0);
      continue;
    }
    Atomics.wait(ctl, C.REQ, seen, 100);
  }
};
