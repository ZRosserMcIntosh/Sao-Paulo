// Ballistic Dynamics — loader for the wasi-sdk build (web/build_wasi.sh).
// SPDX-License-Identifier: MIT
// `const B = await createBallisticModule(bytes?)` then B.bd_*() and helpers.
// The core does no I/O in the browser, so the WASI imports are minimal stubs.
export default async function createBallisticModule(wasmBytes) {
  let bytes = wasmBytes;
  if (!bytes) {
    const url = new URL('./ballistic.wasm', import.meta.url);
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
    proc_exit: (c) => { throw new Error('ballistic.wasm exited with code ' + c); },
    fd_write: (fd, iovs, n, nwritten) => {
      const v = new DataView(memory.buffer); let s = '', total = 0;
      for (let i = 0; i < n; ++i) { const p = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true); s += new TextDecoder().decode(new Uint8Array(memory.buffer, p, l)); total += l; }
      v.setUint32(nwritten, total, true); if (s.trim()) (fd === 2 ? console.warn : console.log)(s.trimEnd()); return 0;
    },
    environ_sizes_get: (c, s) => { const v = new DataView(memory.buffer); v.setUint32(c, 0, true); v.setUint32(s, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (id, prec, out) => { new DataView(memory.buffer).setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    // The engine draws its own seeded numbers (ADR 0004); nothing should ask for entropy.
    random_get: () => ENOSYS,
  }, { get: (t, k) => t[k] ?? (() => ENOSYS) });
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
  const ex = instance.exports;
  memory = ex.memory;
  ex._initialize?.();
  const B = { ...Object.fromEntries(Object.entries(ex).filter(([k]) => k.startsWith('bd_'))) };
  const enc = new TextEncoder(), dec = new TextDecoder();
  B.text = (ptr) => {
    const p = ptr ?? ex.bd_text(0), u = new Uint8Array(memory.buffer, p);
    let n = 0; while (u[n]) ++n;
    return dec.decode(new Uint8Array(memory.buffer, p, n));
  };
  // Loads a JSON library document; returns the error strings (empty when fine).
  B.load = (json) => {
    const b = enc.encode(json);
    new Uint8Array(memory.buffer, ex.bd_text(b.length + 1), b.length).set(b);
    ex.bd_load(b.length);
    const n = ex.bd_resolve();
    const errors = [];
    for (let i = 0; i < n; ++i) errors.push(B.text(ex.bd_error_text(i)));
    return errors;
  };
  B.catalog = () => JSON.parse(B.text(ex.bd_catalog()));
  // {pressure, temperature, density, speedOfSound, relativeHumidity, densityAltitude, wind: [e, n, u]}
  B.air = (x, y, z, t = 0) => {
    const a = new Float64Array(memory.buffer, ex.bd_air(x, y, z, t), 9);
    return { pressure: a[0], temperature: a[1], density: a[2], speedOfSound: a[3], relativeHumidity: a[4],
      densityAltitude: a[5], wind: [a[6], a[7], a[8]] };
  };
  // [maths hash, trajectory hash]
  B.determinism = () => B.text(ex.bd_determinism()).split(' ');
  // Wind layers along the line of fire: [{fromRange, speed, fromBearing, gust}], rad and m/s.
  B.wind = (azimuth, layers) => {
    const v = new Float64Array(memory.buffer, ex.bd_text(layers.length * 32 + 1), layers.length * 4);
    layers.forEach((l, i) => v.set([l.fromRange ?? 0, l.speed ?? 0, l.fromBearing ?? 0, l.gust ?? 0], 4 * i));
    ex.bd_wind(azimuth, layers.length);
  };
  B.round = () => {
    const a = new Float64Array(memory.buffer, ex.bd_round(), 16);
    return { time: a[0], position: [a[1], a[2], a[3]], velocity: [a[4], a[5], a[6]], stopped: a[7] !== 0,
      spin: a[8], roll: a[9], stability: a[10], tumbling: a[11] !== 0, jump: a[12], minStability: a[13],
      transonicStart: a[14], subsonicTime: a[15] };
  };
  B.noseAt = (t) => Array.from(new Float64Array(memory.buffer, ex.bd_nose_at(t), 3));
  // Bullet time: the round at any engine time it has already flown, smooth between steps.
  B.stateAt = (t) => {
    const a = new Float64Array(memory.buffer, ex.bd_state_at(t), 9);
    return { time: a[0], position: [a[1], a[2], a[3]], velocity: [a[4], a[5], a[6]], spin: a[7], roll: a[8] };
  };
  // [{range, drop, windage, time, speed, energy, mach, stability}] (SI)
  B.table = (cartridge, zeroRange, sightHeight, maxRange, step, azimuth = 0) =>
    JSON.parse(B.text(ex.bd_table(cartridge, zeroRange, sightHeight, maxRange, step, azimuth)))
      .map(([range, drop, windage, time, speed, energy, mach, stability]) =>
        ({ range, drop, windage, time, speed, energy, mach, stability }));
  return B;
}
