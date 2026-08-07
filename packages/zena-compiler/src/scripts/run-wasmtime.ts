#!/usr/bin/env node
/**
 * Run a zena-compiler test program under zena-cli.
 *
 * Every test program built by `build-wasi-tests.js` exports `main()`,
 * prints its own report, and returns the number of failures; zena-cli
 * prints that return value as the last line of stdout.
 *
 * With no argument, runs all of the unit suites. With one, runs just
 * that program — an optional second argument is passed through to it as
 * a filter (the portable-execution runner uses this; the others ignore
 * it).
 *
 * The test programs are repo tooling, not sandboxed guests: they get the
 * whole repo as a preopen and the spawn capability, which the portable
 * execution runner needs to run each language test in its own process.
 */

import {spawnSync} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const outDir = join(pkgDir, 'zena', 'out');
const repoRoot = join(pkgDir, '..', '..');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

// On macOS with Nix, tool binaries land in HOST_PATH rather than PATH.
if (process.env.HOST_PATH) {
  process.env.PATH = `${process.env.HOST_PATH}:${process.env.PATH ?? ''}`;
}

const [target, filter] = process.argv.slice(2);

// The portable runners are whole programs of their own and are invoked
// by name; a bare run means "the unit suites".
const wasmFiles = target
  ? [resolve(target)]
  : (await glob(join(outDir, 'test-self', '**/*.wasm')))
      .filter((f) => !/portable_[^/]*\.wasm$/.test(f))
      .sort();

if (wasmFiles.length === 0) {
  console.error(`${YELLOW}No .wasm files found${NC}`);
  console.error('Run `npm run build` first.');
  process.exit(1);
}

// Workers a runner may keep in flight. Bounded well below the CPU count
// by default: each worker is a wasmtime process with its own GC heap,
// and oversubscribing them OOMs small machines.
const envParallelism = Number.parseInt(process.env.ZENA_TEST_PARALLELISM ?? '', 10);
const parallelism =
  Number.isFinite(envParallelism) && envParallelism > 0
    ? envParallelism
    : Math.max(1, Math.min(availableParallelism(), 8));

/** Extract the test count from a `runAndReport` summary line. */
const parseSummary = (report: string): number => {
  // Matches "✓ N of M test(s) passed" or "✗ X failed, Y passed of M test(s)"
  const match = report.match(/of (\d+) test/);
  return match ? Number.parseInt(match[1], 10) : 0;
};

console.log('');

let passed = 0;
let failed = 0;
let totalTests = 0;

for (const wasmFile of wasmFiles) {
  const relPath = relative(outDir, wasmFile);

  const result = spawnSync(
    zenaCli,
    [
      '--debug',
      'run',
      // Map the repo root to / so tests/language/ is reachable at the
      // same relative path a runner would use from the repo root.
      '--dir',
      `${repoRoot}::/`,
      '--dir',
      '/tmp::/tmp',
      '--allow-spawn',
      '--invoke',
      'main',
      wasmFile,
      zenaCli,
      String(parallelism),
      ...(filter ? [filter] : []),
    ],
    // Generous: on a cold compile cache the execution runner compiles
    // every language test before it can run it.
    {encoding: 'utf-8', timeout: 3_600_000, cwd: repoRoot},
  );

  const output = result.stdout?.trim() ?? '';

  // zena-cli prints main()'s return value as the last line; everything
  // before it is the program's own report.
  const lines = output.split('\n');
  const returnValue = lines.pop()?.trim();
  const report = lines
    // Unescape the color strings Zena tests emit as literal text.
    .map((line) => line.replace(/\\x1b/g, '\x1b').replace(/\\n/g, '\n'))
    .join('\n');
  totalTests += parseSummary(report);

  if (result.status === 0 && returnValue === '0') {
    const displayName = relPath.replace(/\.wasm$/, '');
    console.log(
      `${GREEN}✔${NC} ${displayName} ${DIM}(${parseSummary(report)} tests)${NC}`,
    );
    // Surface anything the suite printed beyond its own pass summary.
    if (report.trim() && !report.match(/^✓ \d+ of \d+ test\(s\) passed$/)) {
      console.log(report);
    }
    passed++;
  } else {
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
  console.log(`${RED}${failed} suite(s) failed (${totalTests} total tests)${NC}`);
  process.exit(1);
}
