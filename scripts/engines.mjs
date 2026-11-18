#!/usr/bin/env node
// São Paulo World — which engine build each page runs.
//
//   node scripts/engines.mjs          check every file against sao-paulo/engines.json
//   node scripts/engines.mjs --update rewrite the sha256 fields from the files on disk
//
// engines.json says, per page, which repository and commit its WebAssembly
// was built from, and the sha256 of each shipped file. A file replaced
// without updating the manifest fails the check. "verified" means the commit
// was rebuilt and matched the shipped file byte for byte (date in the entry).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'sao-paulo');
const manifestPath = join(root, 'engines.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const update = process.argv.includes('--update');
const sha = (f) => createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
let bad = 0;
for (const e of manifest.engines) {
  let changed = 0;
  for (const f of Object.keys(e.files)) {
    const h = sha(f);
    if (update) e.files[f] = h;
    else if (h !== e.files[f]) {
      bad++, changed++;
      console.error(`CHANGED  ${f}: shipped file no longer matches ${e.repo}@${e.commit}; rebuild or update engines.json`);
    }
  }
  if (!update) console.info(`${changed ? '!!' : 'ok'}  ${e.page.padEnd(12)} ${e.repo}@${e.commit.slice(0, 12)}  ${e.verified ? 'verified ' + e.verified : 'UNVERIFIED'}`);
}
if (update) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
process.exit(bad ? 1 : 0);
