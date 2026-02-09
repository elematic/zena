#!/usr/bin/env node
/**
 * Run WASI tests using wasmtime.
 */

import {execSync, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const outDir = join(pkgDir, 'tests', 'out');

// Colors
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

// Check wasmtime is available
try {
  execSync('which wasmtime', {stdio: 'pipe'});
} catch {
  console.error(`${RED}Error: wasmtime not found${NC}`);
  console.error('Install wasmtime or run: nix develop');
  process.exit(1);
}

// Find all .wasm files
const pattern = join(outDir, '**/*.wasm');
const wasmFiles = await glob(pattern);

if (wasmFiles.length === 0) {
  console.error(`${YELLOW}No .wasm files found${NC}`);
  console.error('Run `npm run build:wasi-tests` first.');
  process.exit(1);
}

console.log('');
console.log('Running wasmtime tests...');
console.log('');

let passed = 0;
let failed = 0;

for (const wasmFile of wasmFiles.sort()) {
  const relPath = relative(outDir, wasmFile);
  const testDir = dirname(wasmFile);
  const displayName = relPath.replace(/\.wasm$/, '');
  const paddedName = displayName.padEnd(50);

  process.stdout.write(`  ${paddedName} `);

  const result = spawnSync(
    'wasmtime',
    [
      'run',
      '-W',
      'gc=y',
      '-W',
      'exceptions=y',
      '-W',
      'function-references=y',
      '--dir',
      `${testDir}::/`,
      '--dir',
      '/tmp::/tmp',
      '--invoke',
      'main',
      wasmFile,
    ],
    {
      encoding: 'utf-8',
      timeout: 30000,
    },
  );

  const output = result.stdout?.trim() || '';
  const returnValue = output.split('\n').pop()?.trim();

  if (result.status === 0 && returnValue === '0') {
    console.log(`${GREEN}PASS${NC}`);
    passed++;
  } else {
    console.log(`${RED}FAIL${NC}`);
    if (result.stderr) {
      console.log(`    ${result.stderr.trim().split('\n').join('\n    ')}`);
    }
    if (returnValue && returnValue !== '0') {
      console.log(`    ${returnValue} test(s) failed`);
    }
    failed++;
  }
}

console.log('');
console.log('─'.repeat(50));
if (failed === 0) {
  console.log(`${GREEN}✓ ${passed} test(s) passed${NC}`);
} else {
  console.log(`${RED}✗ ${failed} failed${NC}, ${GREEN}${passed} passed${NC}`);
}

process.exit(failed > 0 ? 1 : 0);
