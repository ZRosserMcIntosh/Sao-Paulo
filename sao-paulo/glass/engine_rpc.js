// Glass Lab · the fracture engine, in a worker where the browser allows it.
// The page keeps calling G.gls_*() and the helpers synchronously: each call
// goes through shared memory to the worker and waits for the answer (the
// worker answers between engine steps, so a call waits a few milliseconds at
// most). Between frames the worker steps the engine on by itself (G.go), so
// the physics has a core of its own and the page draws while it runs.
// Shared memory needs a cross-origin isolated page; without it the engine
// runs on the page as before, with the same physics.
import createGlassModule from './glass.mjs';
import { Writer, Reader, C, S } from './engine_codec.js';

// WebAssembly SIMD: the faster build where the browser has it. Both builds
// give bit-identical results (the engine's sums keep their order).
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
export const wasmFile = WebAssembly.validate(SIMD_PROBE) ? 'glass.wasm' : 'glass-scalar.wasm';

const REQ_BYTES = 8 << 20, RES_BYTES = 24 << 20;
// glass.mjs's helpers over the raw gls_* calls.
const HELPERS = new Set(['text', 'load', 'catalog', 'state', 'plies', 'impactors', 'report', 'events', 'cracks', 'fragmentShapes',
  'sprays', 'crushes', 'fragmentMap', 'fragmentPoses', 'fragmentSheets', 'field', 'stressStrength', 'dropState', 'dropFragments']);

// The worker's fragmentShapes (glass.mjs's layout): [{index, ply, chip, thickness, outline, holes}].
function parseShapes(f) {
  const out = [];
  let k = 1;
  for (let i = 0, n = f[0]; i < n; ++i) {
    const index = f[k], ply = f[k + 1], chip = f[k + 2] > 0, thickness = f[k + 3], nv = f[k + 4];
    const outline = Array.from(f.subarray(k + 5, k + 5 + 2 * nv));
    k += 5 + 2 * nv;
    const holes = [];
    for (let h = 0, nh = f[k++]; h < nh; ++h) { const m = f[k++]; holes.push(Array.from(f.subarray(k, k + 2 * m))); k += 2 * m; }
    out.push({ index, ply, chip, thickness, outline, holes });
  }
  return out;
}

export async function createEngine({ worker = true } = {}) {
  const canShare = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true && typeof Atomics?.wait === 'function';
  if (worker && canShare && !new URLSearchParams(location.search).has('noworker')) {
    try { return await remoteEngine(); } catch (e) { console.warn('engine worker unavailable, running on the page:', e); }
  }
  const G = await createGlassModule(await (await fetch(wasmFile, { cache: 'no-cache' })).arrayBuffer());
  G.remote = false;
  return G;
}

async function remoteEngine() {
  const ctlBuf = new SharedArrayBuffer(C.SIZE * 4), statusBuf = new SharedArrayBuffer(S.SIZE * 8);
  const reqBuf = new SharedArrayBuffer(REQ_BYTES), resBuf = new SharedArrayBuffer(RES_BYTES);
  const ctl = new Int32Array(ctlBuf), st = new Float64Array(statusBuf);
  const wr = new Writer(reqBuf), rd = new Reader(resBuf);
  const w = new Worker(new URL('./engine_worker.js', import.meta.url), { type: 'module' });
  await new Promise((resolve, reject) => {
    w.onmessage = (e) => (e.data.ready ? resolve() : reject(new Error(e.data.error || 'engine worker failed')));
    w.onerror = (e) => reject(new Error(e.message || 'engine worker failed'));
    const slow = Math.min(32, Math.max(1, +new URLSearchParams(location.search).get('slowphys') || 1));
    w.postMessage({ ctl: ctlBuf, status: statusBuf, req: reqBuf, res: resBuf, wasm: new URL(wasmFile, location.href).href, slow });
  });
  let seq = Atomics.load(ctl, C.REQ);
  const call = (name, args) => {
    wr.reset().value(name);
    wr.value(args);
    seq = (seq + 1) | 0;
    Atomics.store(ctl, C.REQ, seq);
    Atomics.notify(ctl, C.REQ);
    // The page may not block in Atomics.wait: spin until the worker answers.
    while (Atomics.load(ctl, C.RES) !== seq) { /* waiting on the engine */ }
    const v = rd.reset().value();
    if (Atomics.load(ctl, C.OK) !== 1) throw new Error(v);
    return v;
  };
  const fns = new Map();
  const extra = {
    remote: true,
    // Steps the engine on toward engine time t, in the worker, until the next call.
    go: (t) => call('__go', [t]),
    // Before a frame's calls: ask the worker to stop between steps. Returns
    // whether it is in the middle of some (the frame then draws without
    // asking, and asks again next frame).
    hold() { Atomics.store(ctl, C.WANT, 1); return Atomics.load(ctl, C.BUSY) === 1; },
    stop: () => call('__stop', []),
    fragmentShapes: (from) => parseShapes(call('fragmentShapes', [from])),
    bench: (ms) => call('__bench', [ms]),
    timeNow: () => st[S.TIME],   // engine time without a call
    target: () => st[S.TARGET],
  };
  return new Proxy(extra, {
    get(t, name) {
      if (name in t) return t[name];
      // Only the engine's own calls (so `await` and the like see no `then`).
      if (typeof name !== 'string' || !(name.startsWith('gls_') || HELPERS.has(name))) return undefined;
      let f = fns.get(name);
      if (!f) { f = (...args) => call(name, args); fns.set(name, f); }
      return f;
    },
    set(t, name, v) { t[name] = v; return true; },
  });
}
