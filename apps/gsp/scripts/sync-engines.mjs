// Copies the physics engines GSP runs on into public/engines (served at /gsp/engines/):
//  - gsp.wasm / gsp.mjs: OpenRoad Dynamics (Vehicle-Dynamics web/gsp_web.cpp), every car's tyres,
//    suspension, drivetrain and assists, hosted by Rapier (shipped in apps/gsp/engines/)
//  - glass.*: Glass Dynamics, the same build and library as the site's Glass Lab (sao-paulo/glass)
//  - street.*: Street Dynamics (Destruction-Dynamics), the Street Lab's signs and posts (sao-paulo/streetlab)
//  - gsp-glass-worker.js: runs Glass Dynamics on car windows off the main thread
//  - engine-worklet.js: the driving page's engine-sound AudioWorklet (sao-paulo/driving/audio)
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const site = path.resolve(app, '../../sao-paulo');
const out = path.join(app, 'public/engines');
mkdirSync(out, { recursive: true });
const files = [
  [path.join(app, 'engines/gsp.wasm'), 'gsp.wasm'],
  [path.join(app, 'engines/gsp.mjs'), 'gsp.mjs'],
  [path.join(site, 'glass/glass.mjs'), 'glass.mjs'],
  [path.join(site, 'glass/glass.wasm'), 'glass.wasm'],
  [path.join(site, 'glass/library.json'), 'glass_library.json'],
  [path.join(site, 'streetlab/street.mjs'), 'street.mjs'],
  [path.join(site, 'streetlab/street.wasm'), 'street.wasm'],
  [path.join(site, 'streetlab/street_library.json'), 'street_library.json'],
  [path.join(app, 'engines-src/gsp-glass-worker.js'), 'gsp-glass-worker.js'],
  [path.join(site, 'driving/audio/engine-worklet.js'), 'engine-worklet.js'],
];
for (const [src, name] of files) {
  if (!existsSync(src)) throw new Error('missing engine file ' + src);
  cpSync(src, path.join(out, name));
}
console.log('engines ->', path.relative(process.cwd(), out), files.map((f) => f[1]).join(', '));
