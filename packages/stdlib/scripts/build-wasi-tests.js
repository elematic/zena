#!/usr/bin/env node
/**
 * Build WASI tests for stdlib.
 *
 * These are tests that require wasmtime (have @requires: wasmtime directive).
 * Currently hardcoded to fs/, hello_test.zena, memory_test.zena.
 */

import {execSync} from 'node:child_process';
import {existsSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const testsDir = join(pkgDir, 'tests');
const outDir = join(testsDir, 'out');
const cliPath = join(pkgDir, '..', 'cli', 'lib', 'cli.js');

// Files/patterns that need wasmtime (--target wasi)
const wasiPatterns = [
  'fs/*_test.zena',
  'memory_test.zena',
  'fixed_array/*_test.zena',
  'array/*_test.zena',
];

console.log('Building WASI tests...');
console.log('');

let built = 0;
let skipped = 0;
let failed = 0;

for (const pattern of wasiPatterns) {
  const fullPattern = join(testsDir, pattern);
  const files = await glob(fullPattern);

  for (const zenaFile of files) {
    const baseName = basename(zenaFile, '.zena');
    const runnerFile = join(dirname(zenaFile), `${baseName}.__runner__.zena`);

    // Write wrapper runner file
    const wrapperContent = `import {runAndReport} from 'zena:test';
import {console} from 'zena:console';
import {tests} from './${baseName}.zena';

export let main = (): i32 => {
  return runAndReport(tests, (s: String) => {
    console.log(s);
  });
};
`;
    writeFileSync(runnerFile, wrapperContent, 'utf-8');

    const relPath = relative(testsDir, runnerFile);
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

    // Compile with wasi target and debug info for better stack traces
    try {
      execSync(
        `node "${cliPath}" build "${runnerFile}" --target wasi -g -o "${wasmFile}"`,
        {
          stdio: 'pipe',
          cwd: pkgDir,
        },
      );
      console.log(`✓ ${relPath}`);
      built++;
    } catch (e) {
      console.error(`✗ ${relPath}`);
      if (e.stderr) {
        console.error(`  ${e.stderr.toString().trim()}`);
      }
      failed++;
    }
  }
}

console.log('');
console.log(`Built: ${built}, Skipped: ${skipped}, Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
