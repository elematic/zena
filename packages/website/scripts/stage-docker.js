/**
 * Stages a Linux x86_64 `zena-run` binary into `packages/website/zena-run`
 * so `docker build` and `gcloud builds submit` can include it in the
 * `packages/website` build context.
 *
 * Checks (in order):
 * 1. `ZENA_LINUX_RUNNER` environment variable
 * 2. `../../target/x86_64-unknown-linux-gnu/release/zena-run` (cross-compiled)
 * 3. `../../target/release/zena-run` (native Linux build)
 *
 * Fails immediately if the binary is not a Linux x86_64 ELF executable (for
 * example, an un-cross-compiled macOS Mach-O binary).
 */

import {access, chmod, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareLinuxRunner} from '../lib/stage-docker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');
const repoRoot = resolve(pkgDir, '../..');

const candidates = [
  process.env.ZENA_LINUX_RUNNER,
  resolve(repoRoot, 'target/x86_64-unknown-linux-gnu/release/zena-run'),
  resolve(repoRoot, 'target/release/zena-run'),
].filter(Boolean);

const findRunner = async () => {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Could not find zena-run binary. Build it first with:\n  cargo build --release -p zena-run`,
  );
};

const sourcePath = await findRunner();
const raw = await readFile(sourcePath);
const prepared = prepareLinuxRunner(raw, {sourcePath});
const destPath = resolve(pkgDir, 'zena-run');
await writeFile(destPath, prepared, {mode: 0o755});
await chmod(destPath, 0o755);
console.log(`[zena] staged Linux x86_64 runner from ${sourcePath}`);
