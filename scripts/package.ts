/**
 * Build a Chrome Web Store / GitHub release zip from dist/.
 *
 * Run: bun scripts/package.ts   (or: bun run package)
 *
 * Always rebuilds first (`bun run build`) so the zip can never be stale,
 * then zips the CONTENTS of dist/ (manifest.json at the zip root — Chrome
 * rejects archives with a wrapping directory) to
 * nonecap-extension-v{manifest version}.zip at the repo root.
 *
 * Uses the `zip` binary (preinstalled on macOS and on Linux CI images;
 * `apt-get install zip` where missing).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

function run(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && cmd === 'zip') {
    console.error('[package] zip binary not found — install zip (default on macOS; apt-get install zip on Linux)');
    process.exit(1);
  }
  if (res.error || res.status !== 0) {
    console.error(`[package] command failed (${res.status ?? res.error?.message}): ${cmd} ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

console.log('[package] building extension (bun run build)…');
run('bun', ['run', 'build'], ROOT);

const manifestPath = path.join(DIST, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('[package] dist/manifest.json missing after build — aborting');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
  console.error('[package] dist/manifest.json has no version — aborting');
  process.exit(1);
}

const zipName = `nonecap-extension-v${manifest.version}.zip`;
const zipPath = path.join(ROOT, zipName);

// `zip` updates existing archives in place — remove any stale zip first so
// deleted dist files cannot linger in the new archive.
rmSync(zipPath, { force: true });

// cwd=dist + relative paths ⇒ manifest.json sits at the zip root.
console.log(`[package] zipping dist/ → ${zipName}`);
run('zip', ['-r', '-X', zipPath, '.'], DIST);

console.log(`[package] done: ${zipPath}`);
