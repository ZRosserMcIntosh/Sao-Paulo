// Headless run of the simulation (no rendering): loads every engine, runs each scenario for a
// while with a scripted player, and prints what happened. Usage: node tests/headless.mjs [seconds]
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const out = path.join(app, 'node_modules/.cache/gsp-headless.mjs');
await build({ entryPoints: [path.join(app, 'src/sim/Simulation.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning', external: ['@dimforge/rapier3d-compat'] });
const engines = path.join(app, 'public/engines/');
globalThis.fetch = async (u) => {
  const p = String(u).startsWith('file:') ? fileURLToPath(u) : String(u);
  const b = await readFile(p);
  return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), json: async () => JSON.parse(b.toString()), text: async () => b.toString() };
};
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
const { Simulation } = await import(pathToFileURL(out).href + '?' + Date.now());
const t0 = performance.now();
const sim = await Simulation.create(engines, (p, m) => process.stdout.write(`  [${(p * 100) | 0}%] ${m}\n`));
console.log(`loaded in ${((performance.now() - t0) / 1000).toFixed(2)} s; track ${sim.track.length.toFixed(0)} m; ground ${sim.ground.nx}x${sim.ground.nz}; trees ${sim.layout.trees.length}; signs ${sim.layout.signs.length}; rails ${sim.layout.rails.length}; props ${sim.layout.props.length}`);
const secs = Number(process.argv[2] ?? 20);
const only = process.argv[3];
for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) {
  if (only && !only.includes(id)) continue;
  sim.load(id, 1);
  const p = sim.player;
  const t1 = performance.now();
  let maxSpeed = 0;
  const n = Math.round(secs * 120);
  sim.input.update = () => {};
  for (let k = 0; k < n; ++k) {
    // scripted player: full throttle, gentle weave
    sim.input.throttle = 1; sim.input.brake = 0; sim.input.steer = 0.15 * Math.sin(k / 240); sim.input.handbrake = 0;
    sim.step();
    maxSpeed = Math.max(maxSpeed, p.speed);
  }
  const ms = (performance.now() - t1) / n;
  const sus = sim.vehicles.filter((v) => v.role === 'suspect');
  console.log(`${id} ${sim.scenario.title}: ${sim.vehicles.length} cars, ${ms.toFixed(2)} ms/step (core ${sim.telemetry.coreMs.toFixed(2)}, rapier ${sim.telemetry.rapierMs.toFixed(2)}, ai ${sim.telemetry.aiMs.toFixed(2)}); player ${(p.speed * 3.6).toFixed(0)} km/h (max ${(maxSpeed * 3.6).toFixed(0)}), gear ${p.gear}, upright ${p.upright.toFixed(2)}, y ${p.p.y.toFixed(2)}, d ${p.trackD.toFixed(1)}; faults ${sim.vehicles.reduce((a, v) => a + v.faultCount, 0)}`);
  for (const s of sus) console.log(`   suspect ${s.label}: ${(s.speed * 3.6).toFixed(0)} km/h, d ${s.trackD.toFixed(1)}, mode ${sim.ais.get(s.id)?.mode}, upright ${s.upright.toFixed(2)}, dist to player ${Math.hypot(s.p.x - p.p.x, s.p.z - p.p.z).toFixed(0)} m`);
  const tr = sim.vehicles.filter((v) => v.role === 'traffic' || v.role === 'police');
  if (tr.length) console.log(`   others: speeds ${tr.map((v) => (v.speed * 3.6).toFixed(0)).join(' ')}; |d| ${tr.map((v) => Math.abs(v.trackD).toFixed(0)).join(' ')}; upright ${tr.map((v) => v.upright.toFixed(1)).join(' ')}`);
  const c = sim.game.counters;
  console.log(`   counters: property $${c.propertyDamage}, patrol $${c.patrolRepair}, cones ${c.conesLost}, forms ${c.forms}, contacts ${sim.telemetry.contacts.length}; last toasts: ${sim.game.toasts.map((t) => t.text.slice(0, 50)).slice(-2).join(' | ')}`);
}
process.exit(0);
