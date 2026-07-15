#!/usr/bin/env node
import {execSync, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const outDir = join(pkgDir, 'tests', 'out-self-hosted');

// Colors
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

try {
  execSync('which wasmtime', {stdio: 'pipe'});
} catch {
  console.warn(`${YELLOW}Warning: wasmtime command-line utility not found, proceeding anyway${NC}`);
}

// Find all .wasm files
const pattern = join(outDir, '**/*.wasm');
const wasmFiles = await glob(pattern);

if (wasmFiles.length === 0) {
  console.error(`${YELLOW}No .wasm files found${NC}`);
  console.error('Run `npm run build:wasi-tests:self-hosted` first.');
  process.exit(1);
}

console.log('');
console.log('Running self-hosted wasmtime tests...');
console.log('');

let passed = 0;
let failed = 0;

for (const wasmFile of wasmFiles.sort()) {
  const relPath = relative(outDir, wasmFile);
  const testDir = dirname(wasmFile);
  const displayName = relPath.replace(/\.wasm$/, '');
  const paddedName = displayName.padEnd(50);

  process.stdout.write(`  ${paddedName} `);

  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
  const result = spawnSync(
    zenaCli,
    [
      'run',
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
    if (output) {
      console.log(`    Output:\n    ${output.split('\n').join('\n    ')}`);
    }
    if (returnValue && returnValue !== '0') {
      console.log(`    ${returnValue} test(s) failed`);
    } else if (result.status !== 0) {
      console.log(`    Process exited with status ${result.status}`);
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
