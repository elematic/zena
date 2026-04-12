#!/usr/bin/env node
/**
 * Build all zena-compiler tests for wasmtime.
 *
 * Test files export `tests` (a Suite). This script generates a wrapper module
 * per test file that imports the suite, runs it with `runAndReport`, and
 * returns the failure count — then compiles the wrapper to WASM.
 */

import {execSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const zenaDir = join(pkgDir, 'zena');
const outDir = join(zenaDir, 'out');
const cliPath = join(pkgDir, '..', 'cli', 'lib', 'cli.js');
const repoRoot = join(pkgDir, '..', '..');

// Generate a wrapper module that imports a test suite and runs it
const generateWrapper = (testFileName: string): string => `\
import { tests } from './${testFileName}';
import { runAndReport } from 'zena:test';
import { console } from 'zena:console';

export let main = (): i32 => runAndReport(tests, (s: String): void => { console.log(s); });
`;

// Build all test files
const testPattern = 'test/*_test.zena';

console.log('Building zena-compiler tests...');
console.log('');

let built = 0;
let failed = 0;

const fullPattern = join(zenaDir, testPattern);
const files = await glob(fullPattern);

for (const zenaFile of files) {
  const relPath = relative(zenaDir, zenaFile);
  const testFileName = basename(zenaFile);
  const wasmFile = join(outDir, relPath.replace(/\.zena$/, '.wasm'));

  // Ensure output directory exists
  const wasmDir = dirname(wasmFile);
  if (!existsSync(wasmDir)) {
    mkdirSync(wasmDir, {recursive: true});
  }

  // Generate wrapper in the same directory as the test file
  const wrapperPath = zenaFile.replace(/\.zena$/, '.__runner__.zena');
  writeFileSync(wrapperPath, generateWrapper(testFileName));

  // Compile wrapper (which imports the actual test) with wasi target
  // Use --stack-size=4096 to handle large programs (like checker.zena at ~4000 LOC)
  try {
    execSync(
      `node --stack-size=4096 "${cliPath}" build "${wrapperPath}" --target wasi -g -o "${wasmFile}"`,
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
console.log(`Built: ${built}, Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
