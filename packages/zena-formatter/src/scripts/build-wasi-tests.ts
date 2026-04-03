#!/usr/bin/env node
/**
 * Build all zena-formatter tests for wasmtime.
 */

import {execSync} from 'node:child_process';
import {existsSync, mkdirSync, statSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const zenaDir = join(pkgDir, 'zena');
const outDir = join(zenaDir, 'out');
const cliPath = join(pkgDir, '..', 'cli', 'lib', 'cli.js');
const repoRoot = join(pkgDir, '..', '..');

// Build all test files
const testPattern = 'test/*_test.zena';

console.log('Building zena-formatter tests...');
console.log('');

let built = 0;
let skipped = 0;
let failed = 0;

const fullPattern = join(zenaDir, testPattern);
const files = await glob(fullPattern);

for (const zenaFile of files) {
  const relPath = relative(zenaDir, zenaFile);
  const wasmFile = join(outDir, relPath.replace(/\.zena$/, '.wasm'));

  // Check if rebuild needed
  if (existsSync(wasmFile)) {
    const srcStat = statSync(zenaFile);
    const outStat = statSync(wasmFile);
    if (srcStat.mtimeMs <= outStat.mtimeMs) {
      skipped++;
      continue;
    }
  }

  // Ensure output directory exists
  const wasmDir = dirname(wasmFile);
  if (!existsSync(wasmDir)) {
    mkdirSync(wasmDir, {recursive: true});
  }

  // Compile with wasi target and debug info
  try {
    execSync(
      `node "${cliPath}" build "${zenaFile}" --target wasi -g -o "${wasmFile}"`,
      {
        stdio: 'pipe',
        cwd: repoRoot,
      },
    );
    console.log(`  ✓ ${relPath}`);
    built++;
  } catch (e: unknown) {
    console.error(`  ✗ ${relPath}`);
    if (e instanceof Error && 'stderr' in e) {
      const stderr = (e as {stderr: Buffer | string}).stderr;
      console.error(`    ${stderr.toString().trim()}`);
    }
    failed++;
  }
}

console.log('');
console.log(`Built: ${built}, Skipped: ${skipped}, Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
