/* Pre-deploy check: bump the service-worker cache and prove the shell is whole.
 *
 *     node predeploy.mjs
 *
 * Two things have to be true on every deploy, and both are easy to forget
 * because forgetting them looks like nothing happening:
 *
 *   1. CACHE in sw.js must change. The worker is cache-first, so a phone that
 *      already installed the app keeps serving the OLD version forever if the
 *      name stays the same. This bit us immediately after the first deploy:
 *      the server had 201 cars, the phone showed 148.
 *
 *   2. Every module under js/ must be listed in SHELL. These are ES modules
 *      loaded by static import — offline, a missing entry does not degrade,
 *      it stops the app booting. And `cache.addAll` is atomic, so one bad
 *      path means NOTHING gets cached at all.
 *
 * Exits non-zero if the shell is incomplete, so it can gate a deploy.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(APP, 'sw.js');

const src = await readFile(SW, 'utf8');

// ---- 1. Is every module in the shell? ------------------------------------
const modules = (await readdir(path.join(APP, 'js'))).filter((f) => f.endsWith('.js'));
const missing = modules.filter((m) => !src.includes(`./js/${m}`));

if (missing.length) {
  console.error('MISSING from SHELL in sw.js:');
  for (const m of missing) console.error(`  ./js/${m}`);
  console.error('\nAdd them, or the app will fail to start offline.');
  process.exit(1);
}
console.log(`shell ok — all ${modules.length} modules listed`);

// ---- 2. Bump the cache name ----------------------------------------------
const match = /const CACHE = 'wattsleft-v(\d+)';/.exec(src);
if (!match) {
  console.error("could not find the CACHE line in sw.js — has it been renamed?");
  process.exit(1);
}

const next = Number(match[1]) + 1;
await writeFile(SW, src.replace(match[0], `const CACHE = 'wattsleft-v${next}';`));
console.log(`cache bumped v${match[1]} -> v${next}`);
console.log('\nready to commit and push.');
