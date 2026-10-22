// Glass Dynamics — loader for the wasi-sdk build (web/build_wasi.sh).
// SPDX-License-Identifier: MIT
// `const G = await createGlassModule(bytes?)` then G.gls_*() and helpers. The
// core does no I/O in the browser, so the WASI imports are minimal stubs.
export default async function createGlassModule(wasmBytes) {
  let bytes = wasmBytes;
  if (!bytes) {
    const url = new URL('./glass.wasm', import.meta.url);
    if (typeof process !== 'undefined' && process.versions?.node && url.protocol === 'file:') {
      const { readFile } = await import('node:fs/promises');
      bytes = await readFile(url);
    } else {
      bytes = await (await fetch(url)).arrayBuffer();
    }
  }
  let memory = null;
  const ENOSYS = 52;
  const wasi = new Proxy({
    proc_exit: (c) => { throw new Error('glass.wasm exited with code ' + c); },
    fd_write: (fd, iovs, n, nwritten) => {
      const v = new DataView(memory.buffer); let s = '', total = 0;
      for (let i = 0; i < n; ++i) { const p = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true); s += new TextDecoder().decode(new Uint8Array(memory.buffer, p, l)); total += l; }
      v.setUint32(nwritten, total, true); if (s.trim()) (fd === 2 ? console.warn : console.log)(s.trimEnd()); return 0;
    },
    environ_sizes_get: (c, s) => { const v = new DataView(memory.buffer); v.setUint32(c, 0, true); v.setUint32(s, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (id, prec, out) => { new DataView(memory.buffer).setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    random_get: (p, n) => { crypto.getRandomValues(new Uint8Array(memory.buffer, p, n)); return 0; },
  }, { get: (t, k) => t[k] ?? (() => ENOSYS) });
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
  const ex = instance.exports;
  memory = ex.memory;
  ex._initialize?.();
  const G = { ...Object.fromEntries(Object.entries(ex).filter(([k]) => k.startsWith('gls_'))) };
  G.memory = memory;  // the module's memory (its buffer changes when it grows)
  const enc = new TextEncoder(), dec = new TextDecoder();
  G.text = (len) => dec.decode(new Uint8Array(memory.buffer, ex.gls_text(0), len ?? ex.gls_text_length()));
  // Loads a JSON library document; returns the error strings (empty when fine).
  G.load = (json) => {
    const b = enc.encode(json);
    new Uint8Array(memory.buffer, ex.gls_text(b.length + 1), b.length).set(b);
    let n = ex.gls_load(b.length);
    n = ex.gls_resolve();
    const errors = [];
    for (let i = 0; i < n; ++i) errors.push(G.text(ex.gls_error_text(i)));
    return errors;
  };
  G.catalog = () => JSON.parse(G.text(ex.gls_catalog()));
  G.state = () => new Float64Array(memory.buffer, ex.gls_state(), 32).slice();
  G.plies = (n) => new Float64Array(memory.buffer, ex.gls_plies(), 12 * n).slice();
  G.impactors = (n) => new Float64Array(memory.buffer, ex.gls_impactors(), 20 * n).slice();
  G.report = (k) => { const v = Array.from(new Float64Array(memory.buffer, ex.gls_report(k), 16)); return { v, outcome: G.text() }; };
  G.events = (from) => { const t = G.text(ex.gls_events(from)); return t ? t.split('\n').filter(Boolean) : []; };
  // Views below point into the module's memory: copy what you keep.
  // New crack segments of glass ply g since `from`: Float32Array of 7 per segment.
  G.cracks = (g, from) => {
    const p = ex.gls_cracks(g, from), n = new Float32Array(memory.buffer, p, 1)[0];
    return new Float32Array(memory.buffer, p + 4, n * 7);
  };
  // New fragment shapes since record `from`: [{index, ply, chip, thickness, outline: [x, y, ...], holes: [[x, y, ...]]}].
  G.fragmentShapes = (from) => {
    const p = ex.gls_fragment_shapes(from), n = new Float32Array(memory.buffer, p, 1)[0];
    const out = []; let k = 1; const f = new Float32Array(memory.buffer, p, (memory.buffer.byteLength - p) >> 2);
    for (let i = 0; i < n; ++i) {
      const index = f[k], ply = f[k + 1], chip = f[k + 2] > 0, thickness = f[k + 3], nv = f[k + 4];
      const outline = Array.from(f.subarray(k + 5, k + 5 + 2 * nv));
      k += 5 + 2 * nv;
      const holes = [];
      for (let h = 0, nh = f[k++]; h < nh; ++h) { const m = f[k++]; holes.push(Array.from(f.subarray(k, k + 2 * m))); k += 2 * m; }
      out.push({ index, ply, chip, thickness, outline, holes });
    }
    return out;
  };
  // Dice sprays since `from`: Float32Array of 15 per spray.
  G.sprays = (from) => {
    const p = ex.gls_sprays(from), n = new Float32Array(memory.buffer, p, 1)[0];
    return new Float32Array(memory.buffer, p + 4, n * 15);
  };
  // Crushed discs since `from`: Float32Array of 6 per disc.
  G.crushes = (from) => {
    const p = ex.gls_crushes(from), n = new Float32Array(memory.buffer, p, 1)[0];
    return new Float32Array(memory.buffer, p + 4, n * 6);
  };
  // Which piece each crack-grid cell of glazing ply `ply` belongs to: { nx, ny, label: Int32Array } (copy).
  G.fragmentMap = (ply) => {
    const p = ex.gls_fragment_map(ply), h = new Int32Array(memory.buffer, p, 2);
    return { nx: h[0], ny: h[1], label: new Int32Array(memory.buffer, p + 8, h[0] * h[1]).slice() };
  };
  G.fragmentPoses = (n) => new Float32Array(memory.buffer, ex.gls_fragment_poses(), 12 * n);
  G.field = (g, nx, ny) => new Float32Array(memory.buffer, ex.gls_field(g, nx, ny), 3 * nx * ny);
  G.stressStrength = () => new Float64Array(memory.buffer, ex.gls_stress_strength(), 3).slice();
  G.dropState = () => new Float64Array(memory.buffer, ex.gls_drop_state(), 16).slice();
  G.dropFragments = (from) => {
    const p = ex.gls_drop_fragments(from), n = new Float32Array(memory.buffer, p, 1)[0];
    return new Float32Array(memory.buffer, p + 4, 9 * n).slice();
  };
  return G;
}
