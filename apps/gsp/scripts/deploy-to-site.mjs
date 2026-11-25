// Copies the static export (out/) to the site's gsp/ folder, served at zrossermcintosh.com/gsp/.
// Run after `next build` (npm run deploy does both). Files are overwritten in place; Next's
// hashed chunk names change between builds, so delete stale gsp/_next chunks by hand (git shows them).
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(app, 'out');
const site = path.resolve(app, '../..');
const dest = path.join(site, 'gsp');
if (!existsSync(path.join(out, 'index.html'))) throw new Error('no build in ' + out + ' (run next build first)');
if (path.basename(dest) !== 'gsp' || !existsSync(path.join(site, 'vercel.json'))) throw new Error('refusing to write outside the site repo: ' + dest);
cpSync(out, dest, { recursive: true, force: true });
console.log('deployed', path.relative(process.cwd(), out), '->', path.relative(process.cwd(), dest));
