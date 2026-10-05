#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [sourceArgument, revisionArgument, ...extra] = process.argv.slice(2);
if (!sourceArgument || !revisionArgument || extra.length || !/^[0-9a-f]{40}$/i.test(revisionArgument) || /[\r\n\0]/.test(sourceArgument) || sourceArgument.includes('://')) {
  console.error('Usage: npm run sync:byos -- /path/to/byos <full-40-character-commit-sha>');
  process.exitCode = 1;
} else {
  let temporary;
  try {
    const source = await realpath(sourceArgument);
    const revision = revisionArgument.toLowerCase();
    const commit = execFileSync('git', ['-C', source, 'rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (commit !== revision) throw Error('Revision is not an exact commit.');
    // Execute the exporter from the same immutable revision as the selected sources.
    const exporter = execFileSync('git', ['-C', source, 'show', `${revision}:scripts/vendor.mjs`], { stdio: ['ignore', 'pipe', 'pipe'] });
    temporary = await mkdtemp(join(tmpdir(), 'jev-byos-sync-'));
    const script = join(temporary, 'vendor.mjs');
    await writeFile(script, exporter, { mode: 0o600 });
    execFileSync(process.execPath, [script, '--source', source, '--ref', revision, '--out', join(root, 'vendor'), '--mode', 'packages', '--packages', 'chatgpt-local', '--name-prefix', 'byos-', '--revision', join(root, 'vendor', 'BYOS_REVISION'), '--engine', 'omit'], { cwd: root, stdio: 'inherit' });
    const recorded = await readFile(join(root, 'vendor', 'BYOS_REVISION'), 'utf8');
    if (!recorded.includes(revision)) throw Error('Exporter did not record the requested revision.');
    console.log('BYOS synced. Run npm install, npm run verify, and npm run demo; review and commit vendor files and package-lock.json.');
  } catch {
    console.error('BYOS sync failed. Use a local BYOS Git checkout containing the exact commit and its scripts/vendor.mjs exporter.');
    process.exitCode = 1;
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
