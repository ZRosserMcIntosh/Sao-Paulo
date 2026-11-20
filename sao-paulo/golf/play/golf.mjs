// Golf Dynamics — loader for the wasi-sdk build (web/build_wasi.sh).
// SPDX-License-Identifier: MIT
//
// const G = await createGolfModule(bytes?)
//   G.loadCourse(json)         -> course info (holes, rasters' sizes, surfaces)
//   G.heights() / G.surfaces() -> the course rasters (copies)
//   G.trees()                  -> Float32Array, 9 per tree
//   G.newMatch(config)         -> state
//   G.loadMatch(saved)         -> state (replays the saved shots)
//   G.play(swing)              -> { record, shot, state, ... } and G.path()
//   G.plan()                   -> the computer's suggestion for the player to play
//   G.preview(swing)           -> the shot without scatter (aim line), G.path()
//   G.state(), G.save(), G.pickUp(), G.clubs(golferId), G.heightAt(x, z)
// The core does no I/O in the browser, so the WASI imports are minimal stubs.
export default async function createGolfModule(wasmBytes) {
  let bytes = wasmBytes;
  if (!bytes) {
    const url = new URL('./golf.wasm', import.meta.url);
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
    proc_exit: (c) => { throw new Error('golf.wasm exited with code ' + c); },
    fd_write: (fd, iovs, n, nwritten) => {
      const v = new DataView(memory.buffer); let s = '', total = 0;
      for (let i = 0; i < n; ++i) { const p = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true); s += new TextDecoder().decode(new Uint8Array(memory.buffer, p, l)); total += l; }
      v.setUint32(nwritten, total, true); if (s.trim()) (fd === 2 ? console.warn : console.log)(s.trimEnd()); return 0;
    },
    environ_sizes_get: (c, s) => { const v = new DataView(memory.buffer); v.setUint32(c, 0, true); v.setUint32(s, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (id, prec, out) => { new DataView(memory.buffer).setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    // Every random draw comes from the match seed; nothing should ask for entropy.
    random_get: () => ENOSYS,
  }, { get: (t, k) => t[k] ?? (() => ENOSYS) });
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
  const ex = instance.exports;
  memory = ex.memory;
  ex._initialize?.();
  const enc = new TextEncoder(), dec = new TextDecoder();
  const G = { exports: ex, abi: ex.gd_abi_version() };
  const result = () => JSON.parse(dec.decode(new Uint8Array(memory.buffer, ex.gd_result(), ex.gd_result_length())));
  // Call f(ptr, len) with `text` copied into the module; return the parsed result.
  const call = (f, text) => {
    const b = enc.encode(typeof text === 'string' ? text : JSON.stringify(text));
    const p = ex.gd_alloc(b.length + 1);
    new Uint8Array(memory.buffer, p, b.length).set(b);
    const r = f(p, b.length);
    ex.gd_free(p);
    const out = result();
    if (r < 0) throw new Error(out.error || 'golf.wasm call failed');
    return out;
  };
  const simple = (f) => { const r = f(); const out = result(); if (r < 0) throw new Error(out.error || 'golf.wasm call failed'); return out; };
  G.loadCourse = (json) => (G.course = call(ex.gd_course_load, json));
  G.heights = () => new Float32Array(memory.buffer, ex.gd_height_ptr(), G.course.height.nx * G.course.height.nz).slice();
  G.surfaces = () => new Uint8Array(memory.buffer, ex.gd_surface_ptr(), G.course.surface.nx * G.course.surface.nz).slice();
  G.trees = () => new Float32Array(memory.buffer, ex.gd_trees_ptr(), ex.gd_trees_count() * 9).slice();
  G.heightAt = (x, z) => ex.gd_height(x, z);
  G.surfaceAt = (x, z) => ex.gd_surface_at(x, z);
  G.inBounds = (x, z) => ex.gd_in_bounds(x, z) === 1;
  G.setStimp = (ft) => ex.gd_set_stimp(ft);
  G.newMatch = (cfg) => call(ex.gd_match_new, cfg);
  G.loadMatch = (saved) => call(ex.gd_match_load, saved);
  G.state = () => simple(ex.gd_match_state);
  G.save = () => simple(ex.gd_match_save);
  G.play = (swing) => call(ex.gd_match_play, swing);
  G.plan = () => simple(ex.gd_match_plan);
  G.preview = (swing) => call(ex.gd_match_preview, swing);
  G.pickUp = () => simple(ex.gd_match_pickup);
  G.clubs = (golfer = 'scratch') => call(ex.gd_clubs, golfer);
  G.launchPreview = (mph, vla, hla, rpm, axis, heading) => {
    const r = ex.gd_launch_preview(mph, vla, hla, rpm, axis, heading); const out = result();
    if (r < 0) throw new Error(out.error); return out;
  };
  // The last shot's path: Float32Array of [t, x, y, z, phase] per point (a copy).
  G.path = () => new Float32Array(memory.buffer, ex.gd_path_ptr(), ex.gd_path_count() * 5).slice();
  return G;
}
