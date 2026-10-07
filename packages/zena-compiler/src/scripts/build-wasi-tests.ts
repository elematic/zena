#!/usr/bin/env node
/**
 * Build the zena-compiler test programs for wasmtime.
 *
 * Two kinds of program are produced:
 *
 * - The unit suites (`zena/test/*_test.zena`), which export a `tests`
 *   Suite. They are bundled into one generated wrapper module that
 *   imports every suite and runs them with `runAndReport`.
 * - The portable-test runners (`zena/test/portable_*.zena`), which are
 *   already whole programs with their own `main`, and are compiled as-is.
 *
 * Everything is compiled with the self-hosted compiler, so this script
 * only decides *what* to build; `run-wasmtime.js` runs the results.
 *
 * The programs are independent, so they build concurrently — but each
 * is a whole compile of the compiler and wants a GiB of GC heap and
 * several more of resident memory, so the width is bounded by memory
 * rather than by cores. Measured on this machine at
 * ZENA_GC_RESERVE_MB=512: `__all_tests__` 44.0s and 4609MB resident,
 * `portable_execution` 36.5s and 2669MB, `portable_semantics` 5.7s and
 * 1644MB, `portable_syntax` 1.7s and 1644MB. Two of the four dominate
 * and two are trivial, so running two at a time finishes within a few
 * seconds of running all four and peaks about 3GB lower.
 */

import {execFile} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {availableParallelism, totalmem} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const zenaDir = join(pkgDir, 'zena');
const testDir = join(zenaDir, 'test');
const outDir = join(zenaDir, 'out', 'test-self');
const repoRoot = join(pkgDir, '..', '..');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');

/** A module that imports every unit suite and runs them as one. */
const generateWrapper = (testFileNames: string[]): string => {
  const imports = testFileNames
    .map((file, i) => `import { tests as t${i} } from './${file}';`)
    .join('\n');
  const pushes = testFileNames
    .map((_, i) => `  root.suites.push(t${i});`)
    .join('\n');

  return `\
${imports}
import { Suite, runAndReport } from 'zena:test';

export let main = (): i32 => {
  let root = new Suite('Compiler Tests');
${pushes}

  return runAndReport(root, (s: String): void => { console.log(s); });
};
`;
};

mkdirSync(outDir, {recursive: true});

const unitTestFiles = (await glob(join(testDir, '*_test.zena'))).sort();
const wrapperPath = join(testDir, '__all_tests__.zena');
writeFileSync(
  wrapperPath,
  generateWrapper(unitTestFiles.map((f) => basename(f))),
);

const portableRunners = (await glob(join(testDir, 'portable_*.zena'))).sort();

/** Every program to compile, as [label, source, output]. */
const targets: Array<[string, string, string]> = [
  ['compiler unit tests', wrapperPath, join(outDir, '__all_tests__.wasm')],
  ...portableRunners.map((src): [string, string, string] => [
    basename(src, '.zena').replace(/_/g, ' '),
    src,
    join(outDir, `${basename(src, '.zena')}.wasm`),
  ]),
];

const env = {
  ...process.env,
  ZENA_COMPILER_WASM: 'packages/zena-compiler/zena/out/cli-self.wasm',
  // Wasmtime's copying collector grows the GC heap only when an
  // allocation still does not fit after a full collection, so a heap
  // that starts at nothing leaves an allocation-heavy program
  // collecting most of the time. These compiles ran without a reserve
  // and paid for it: `portable_execution` takes 48.2s at 0 and 32.0s
  // at 512MB, for 516MB more resident.
  ZENA_GC_RESERVE_MB: process.env['ZENA_GC_RESERVE_MB'] ?? '512',
};

const run = promisify(execFile);

/**
 * Memory the kernel thinks is available, in MiB. `os.freemem()` counts
 * only unused pages and reads far too low on a machine with a warm page
 * cache, which would serialize these builds for no reason.
 */
const availableMemoryMb = (): number => {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+) kB$/m);
    if (match !== null) {
      return Number(match[1]) / 1024;
    }
  } catch {
    // Not Linux, or /proc is not mounted.
  }
  return totalmem() / (1024 * 1024);
};

/**
 * How many of these to build at once. The largest peaks near 4.6GB
 * resident, so that is the budget one slot has to fit in: a 16GB CI
 * runner gets three, this machine gets all four, and a smaller one
 * degrades to building them one at a time rather than being killed
 * part way through.
 */
const PEAK_MB_PER_BUILD = 4600;
const concurrency = Math.max(
  1,
  Math.min(
    targets.length,
    availableParallelism(),
    Math.floor(availableMemoryMb() / PEAK_MB_PER_BUILD),
  ),
);

/** Builds one target, with its output held back until it finishes. */
const build = async ([label, src, dest]: [string, string, string]) => {
  // -g: keep the name section. A trapping test prints a wasmtime
  // backtrace, and `wasm-function[4764]` is not a diagnosis —
  // backtrace_test.zena asserts on the symbolized form. Test wasms
  // are throwaway, so the section costs nothing here.
  const started = Date.now();
  try {
    await run(zenaCli, ['-g', 'build', src, '-o', dest], {
      cwd: repoRoot,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    console.log(
      `  ✓ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
    return true;
  } catch (e) {
    const {stdout = '', stderr = ''} = e as {stdout?: string; stderr?: string};
    console.error(
      `  ✗ ${label} failed to build (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
    const output = `${stdout}${stderr}`.trim();
    if (output) {
      console.error(output);
    }
    return false;
  }
};

console.log(
  `Building ${targets.length} test programs, ${concurrency} at a time...`,
);
const queue = [...targets];
const results: boolean[] = [];
const worker = async (): Promise<void> => {
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    results.push(await build(next));
  }
};
await Promise.all(Array.from({length: concurrency}, () => worker()));
const failed = results.includes(false);

if (failed) {
  process.exit(1);
}
