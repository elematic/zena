#!/usr/bin/env node
/**
 * Run zena-compiler tests using wasmtime.
 *
 * Each .wasm file exports main() which runs the test suite via runAndReport,
 * printing results to stdout. The return value (last line) is the failure count.
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
const DIM = '\x1b[2m';
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

let passed = 0;
let failed = 0;
let totalTests = 0;

// Extract test count from runAndReport summary line
const parseSummary = (report: string): number => {
  // Matches "✓ N of M test(s) passed" or "✗ X failed, Y passed of M test(s)"
  const match = report.match(/of (\d+) test/);
  return match ? parseInt(match[1], 10) : 0;
};

for (const wasmFile of wasmFiles.sort()) {
  const relPath = relative(outDir, wasmFile);

  // Run from repo root with access to tests/language/ directory
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
      `${repoRoot}::/`, // Map repo root to / so tests/language/ is accessible at /tests/language/
      '--dir',
      '/tmp::/tmp',
      '--invoke',
      'main',
      wasmFile,
    ],
    {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: repoRoot,
    },
  );

  const output = result.stdout?.trim() ?? '';
  // wasmtime --invoke prints the return value as the last line
  const lines = output.split('\n');
  const returnValue = lines.pop()?.trim();
  // Everything before the return value is the test report
  const report = lines
    .map((line) => {
      // Unescape explicit color strings returned by Zena tests
      return line.replace(/\\x1b/g, '\x1B').replace(/\\n/g, '\n');
    })
    .join('\n');
  const testCount = parseSummary(report);
  totalTests += testCount;

  if (result.status === 0 && returnValue === '0') {
    // Show a compact summary for passing suites
    const displayName = relPath.replace(/\.wasm$/, '');
    console.log(
      `${GREEN}✔${NC} ${displayName} ${DIM}(${testCount} tests)${NC}`,
    );
    passed++;
  } else {
    // Show the full report from runAndReport on failure
    if (report) {
      console.log(report);
    }
    if (result.stderr) {
      console.error(result.stderr.trim());
    }
    failed++;
  }
}

console.log('');
console.log('─'.repeat(50));
if (failed === 0) {
  console.log(`${GREEN}All tests passed (${totalTests} total)${NC}`);
} else {
  console.log(
    `${RED}${failed} suite(s) failed (${totalTests} total tests)${NC}`,
  );
  process.exit(1);
}
