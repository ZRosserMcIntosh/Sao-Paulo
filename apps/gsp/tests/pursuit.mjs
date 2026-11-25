// Headless pursuit: the player's car is driven by an AI trooper; reports contacts, PITs, the end.
// Usage: node tests/pursuit.mjs [scenario] [seconds] [seed]
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(app, 'node_modules/.cache/gsp-pursuit.mjs');
await build({ stdin: { contents: "export * from './src/sim/Simulation'; export * from './src/sim/ai/driver';", resolveDir: app, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning', external: ['@dimforge/rapier3d-compat'] });
globalThis.fetch = async (u) => { const b = await readFile(String(u)); return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), json: async () => JSON.parse(b.toString()), text: async () => b.toString() }; };
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
const { Simulation, AiDriver, PERSONALITIES } = await import(pathToFileURL(out).href);
const sim = await Simulation.create(path.join(app, 'public/engines/'), () => {});
const id = process.argv[2] ?? 'B', secs = Number(process.argv[3] ?? 90), seed = Number(process.argv[4] ?? 1);
sim.load(id, seed);
const p = sim.player;
const sus = sim.vehicles.filter((v) => v.role === 'suspect');
const { Rng } = await import(pathToFileURL(out).href).then(() => ({ Rng: null }));
const ai = new AiDriver(p, sim.track, { ...PERSONALITIES.officer, aggression: 0.9 }, { next: Math.random, range: (a, b) => a + Math.random() * (b - a), int: (a, b) => a + Math.floor(Math.random() * (b - a + 1)), pick: (a) => a[Math.floor(Math.random() * a.length)], chance: (q) => Math.random() < q, fork() { return this; } }, 'pursue', 1, 1);
ai.target = sus[0];
sim.game.onToast = (t) => console.log(`  [${sim.time.toFixed(1)}s] ${t.kind}: ${t.text}`);
sim.input.update = () => {};
const n = Math.round(secs * 120);
for (let k = 0; k < n; ++k) {
  if (k % 2 === 0) { ai.target = sus.find((s) => sim.ais.get(s.id)?.mode === 'flee') ?? sus[0]; ai.update({ vehicles: sim.vehicles, time: sim.time, dt: 2 / 120, pitAid: 0.5, sirensNear: () => false }); }
  const c = p.controls;
  sim.input.steer = c.steer; sim.input.throttle = c.throttle; sim.input.brake = c.brake; sim.input.handbrake = 0;
  sim.step();
  if (k % (120 * 10) === 0) console.log(`t=${sim.time.toFixed(0)}s player ${(p.speed * 3.6).toFixed(0)} km/h d=${p.trackD.toFixed(1)}; ` + sus.map((s) => `${s.label} ${(s.speed * 3.6).toFixed(0)} km/h ${sim.ais.get(s.id).mode} dist ${Math.hypot(s.p.x - p.p.x, s.p.z - p.p.z).toFixed(0)} m dmg ${s.damage.total.toFixed(1)}`).join('; ') + `; ${sim.telemetry.stepMs.toFixed(2)} ms/step`);
  if (sim.game.pursuit.concluded && k % 120 === 0) { console.log('concluded at', sim.time.toFixed(1)); break; }
}
const c = sim.game.counters;
console.log('counters', JSON.stringify(c));
console.log('contacts', sim.telemetry.contacts.slice(0, 6).map((x) => `${x.a}<->${x.b} dv ${x.dv.toFixed(1)}`).join(' | '));
console.log('replay events', sim.replay.events.length, sim.replay.events.slice(-5).map((e) => `${e.kind}@${e.t.toFixed(1)} sev ${e.severity.toFixed(1)}`).join(', '));
process.exit(0);
