/**
 * Stages a Linux x86_64 `zena-run` binary into `packages/website/zena-run`
 * so `docker build` and `gcloud builds submit` can include it in the
 * `packages/website` build context.
 *
 * Resolution order:
 * 1. `ZENA_LINUX_RUNNER` environment variable (if set)
 * 2. On Linux x86_64: `../../target/release/zena-run`
 * 3. On macOS / non-Linux-x86_64: automatically runs
 *    `cargo zigbuild --release --target x86_64-unknown-linux-gnu -p zena-run`
 *    and uses `../../target/x86_64-unknown-linux-gnu/release/zena-run`
 */

import {chmod, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareLinuxRunner, resolveLinuxRunner} from '../lib/stage-docker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');
const repoRoot = resolve(pkgDir, '../..');

const sourcePath = resolveLinuxRunner({repoRoot});
const raw = await readFile(sourcePath);
const prepared = prepareLinuxRunner(raw, {sourcePath});
const destPath = resolve(pkgDir, 'zena-run');
await writeFile(destPath, prepared, {mode: 0o755});
await chmod(destPath, 0o755);
console.log(`[zena] staged Linux x86_64 runner from ${sourcePath}`);
