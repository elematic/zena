#!/usr/bin/env node
/**
 * Run zena-formatter tests using wasmtime.
 */

import {execSync, spawnSync} from 'node:child_process';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const outDir = join(pkgDir, 'zena', 'out');
const repoRoot = join(pkgDir, '..', '..');

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
  console.error('Run `npm run build` first.');
  process.exit(1);
}

console.log('');
console.log('Running zena-formatter tests...');
console.log('');

let passed = 0;
let failed = 0;

for (const wasmFile of wasmFiles.sort()) {
  const relPath = relative(outDir, wasmFile);
  const displayName = relPath.replace(/\.wasm$/, '');
  const paddedName = displayName.padEnd(50);

  process.stdout.write(`  ${paddedName} `);

  // Run from repo root with access to tests/language/ directory
  const result = spawnSync(
    'wasmtime',
    [
      'run',
      '-W',
      'gc=y',
      '-W',
      'function-references=y',
      '-W',
      'exceptions=y',
      '--dir',
      repoRoot,
      '--invoke',
      'main',
      wasmFile,
    ],
    {
      stdio: 'pipe',
      cwd: repoRoot,
      timeout: 30000,
    },
  );

  if (result.status === 0) {
    // --invoke prints the i32 return value as the last line of stdout
    // 0 = all tests passed, >0 = number of failed tests
    const stdout = result.stdout?.toString().trim() ?? '';
    const lines = stdout.split('\n');
    const lastLine = lines[lines.length - 1]?.trim() ?? '';
    const returnValue = parseInt(lastLine, 10);
    if (returnValue === 0 || isNaN(returnValue)) {
      console.log(`${GREEN}PASS${NC}`);
      passed++;
    } else {
      console.log(`${RED}FAIL${NC} (${returnValue} test(s) failed)`);
      failed++;
      // Print any test output (lines before the return value)
      for (const line of lines.slice(0, -1)) {
        if (line.trim()) {
          console.log(`    ${line}`);
        }
      }
    }
  } else {
    console.log(`${RED}FAIL${NC}`);
    failed++;
    const stderr = result.stderr?.toString().trim();
    if (stderr) {
      for (const line of stderr.split('\n')) {
        console.error(`    ${line}`);
      }
    }
    const stdout = result.stdout?.toString().trim();
    if (stdout) {
      for (const line of stdout.split('\n')) {
        console.log(`    ${line}`);
      }
    }
  }
}

console.log('');
console.log(
  `Results: ${passed} passed, ${failed} failed, ${passed + failed} total`,
);

if (failed > 0) {
  process.exit(1);
}
