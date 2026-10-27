#!/usr/bin/env node
/**
 * Stages a Linux x86_64 `zena-run` into deploy/, beside pds.wasm, for the
 * image's build context. The resolving and patching are the website's
 * (`packages/website/lib/stage-docker.js`): `ZENA_LINUX_RUNNER`, else the
 * repository's own build on Linux x86_64, else a cross-compile, with a
 * Nix store interpreter rewritten to the one Debian has.
 */

import {chmod, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  prepareLinuxRunner,
  resolveLinuxRunner,
} from '../../website/lib/stage-docker.js';

const deployDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(deployDir, '../../..');

const sourcePath = resolveLinuxRunner({repoRoot});
const prepared = prepareLinuxRunner(await readFile(sourcePath), {sourcePath});
const destPath = resolve(deployDir, 'zena-run');
await writeFile(destPath, prepared, {mode: 0o755});
await chmod(destPath, 0o755);
console.log(`[pds] staged the Linux x86_64 runner from ${sourcePath}`);
