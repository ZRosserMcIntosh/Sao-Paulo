// Drives the interceptor on the test pad (launch, locked-wheel stop, handbrake drift, pull away)
// with every aid off, records each tyre's squeal inputs from the vehicle core 120 times a second,
// and renders them through the tyre synth (engine-worklet.js) to a WAV.
// Usage: node tests/tyre-audio.mjs [out.wav]
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(app, 'node_modules/.cache/gsp-tyre.mjs');
await build({ stdin: { contents: "export * from './src/sim/Simulation'; export { tyreInputs } from './src/sim/audio';", resolveDir: app, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning', external: ['@dimforge/rapier3d-compat'] });
globalThis.fetch = async (u) => { const b = await readFile(String(u)); return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), json: async () => JSON.parse(b.toString()), text: async () => b.toString() }; };
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
const { Simulation, tyreInputs } = await import(pathToFileURL(out).href);
// the site's copy of the worklet (a classic script: CommonJS outside this package)
const { TyreSquealSynth } = createRequire(import.meta.url)(path.resolve(app, '../../sao-paulo/driving/audio/engine-worklet.js'));
const sim = await Simulation.create(path.join(app, 'public/engines/'), () => {});
sim.load('A', 1);
sim.applyConfig({ ...sim.cfg, preset: 2, arcade: { ...sim.cfg.arcade, enabled: false } }, false);
sim.input.update = () => {};
const p = sim.player, I = sim.input;
const script = (t) => {
  if (t < 4.5) return [0, 1, 0, 0];          // launch (wheelspin, no TCS)
  if (t < 7.5) return [0, 0, 1, 0];          // stamp on the brakes, no ABS: locked
  if (t < 9) return [0, 1, 0, 0];            // back on it
  if (t < 9.6) return [0.9, 0.6, 0, 1];      // turn in with the handbrake
  if (t < 13) return [0.5 * Math.sin(t * 1.3) - 0.3, 0.85, 0, 0]; // hold a drift
  if (t < 15) return [0, 0, 1, 0];           // stop
  if (t < 19) return [0, 1, 0.5, 0];         // pull away against the brakes
  return [0, 0, 1, 0];
};
const T = 20, frames = [];
const ti = { s: [0, 0, 0, 0], v: [0, 0, 0, 0], h: [0, 0, 0, 0], r: [0.5, 0.5, 0.5, 0.5], loose: 0 };
for (let k = 0; k < T * 120; ++k) {
  const [st, th, br, hb] = script(sim.time);
  I.steer = st; I.throttle = th; I.brake = br; I.handbrake = hb;
  sim.step();
  tyreInputs(p, ti);
  frames.push({ s: [...ti.s], v: [...ti.v], h: [...ti.h], r: [...ti.r], speed: p.speed, slip: p.sideslip });
  if (k % 120 === 0) console.log(`t=${sim.time.toFixed(0)} ${(p.speed * 3.6).toFixed(0)} km/h sideslip ${(p.sideslip * 57.3).toFixed(0)}° s=${ti.s.map((x) => x.toFixed(2))} v=${ti.v.map((x) => x.toFixed(1))} h=${ti.h.map((x) => x.toFixed(2))}`);
}
const sr = 48000, block = 128, n = T * sr, L = new Float32Array(n), R = new Float32Array(n);
const syn = new TyreSquealSynth(sr), l = new Float32Array(block), r = new Float32Array(block);
for (let i = 0; i < n; i += block) {
  const f = frames[Math.min(frames.length - 1, Math.floor((i / sr) * 120))];
  syn.render(l, r, block, { ...f, wet: 0, interior: 0 });
  L.set(l.subarray(0, Math.min(block, n - i)), i); R.set(r.subarray(0, Math.min(block, n - i)), i);
}
const b = Buffer.alloc(44 + n * 4);
b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
for (let i = 0; i < n; ++i) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 30000), 44 + 4 * i); b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 30000), 46 + 4 * i); }
const file = process.argv[2] ?? path.join(app, 'node_modules/.cache/tyres-from-physics.wav');
await writeFile(file, b);
console.log('wrote', file);
process.exit(0);
