#!/usr/bin/env node
/**
 * Build the zena-compiler test program for wasmtime.
 *
 * One module holds everything: the unit suites (`zena/test/*_test.zena`,
 * each exporting a `tests` Suite) and the three portable-test runners,
 * bundled by a generated wrapper that dispatches on a subcommand.
 *
 * It used to be four programs. The runners import no compiler module
 * the unit suites do not already import — `parser`, `compiler`,
 * `library-loader`, `codegen/*` and the rest are all in both — so the
 * four builds were four copies of one compiler: 9.77MB of output and
 * 87.9s of compiling, against 4.3MB and about 45s for the single
 * module, and one process peaking near 4.6GB instead of three.
 *
 * The four test scripts still exist, each invoking this module with its
 * own subcommand, so each keeps its own Wireit inputs and its own
 * caching.
 *
 * Everything is compiled with the self-hosted compiler, so this script
 * only decides *what* to build; `run-wasmtime.js` runs the result.
 *
 * The build keeps its GC heap reserve: wasmtime's copying collector
 * grows the heap only when an allocation still does not fit after a
 * full collection, so starting at nothing leaves an allocation-heavy
 * program collecting most of the time.
 */

import {execFile} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
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

/**
 * One module holding every compiler test: the unit suites and the three
 * portable-test runners, selected by a subcommand.
 *
 * They are built together because the runners need no compiler module
 * the unit suites do not already import, so four programs that each
 * linked a whole compiler were four copies of the same thing. The
 * subcommand keeps them four Wireit scripts with their own inputs and
 * their own caching.
 *
 * `compile-slice` reaches the execution runner unchanged: it is how
 * that runner re-invokes this module for one slice of its compile
 * phase, and it reads the argument vector itself.
 */
const generateWrapper = (testFileNames: string[]): string => {
  const imports = testFileNames
    .map((file, i) => `import { tests as t${i} } from './${file}';`)
    .join('\n');
  const pushes = testFileNames
    .map((_, i) => `  root.suites.push(t${i});`)
    .join('\n');

  return `\
${imports}
import { getArguments } from 'zena:cli';
import { Suite, runAndReport } from 'zena:test';
import { runPortableSyntax } from './portable_syntax.zena';
import { runPortableSemantics } from './portable_semantics.zena';
import { runPortableExecution } from './portable_execution.zena';

let runUnitSuites = (): i32 => {
  let root = new Suite('Compiler Tests');
${pushes}

  return runAndReport(root, (s: String): void => { console.log(s); });
};

export let main = (): i32 => {
  let args = getArguments();
  let command = if (args.length > 1) { args[1] } else { 'unit' };
  if (command == 'syntax') {
    return runPortableSyntax();
  }
  if (command == 'semantics') {
    return runPortableSemantics();
  }
  if (command == 'compile-slice') {
    // The execution runner's own re-invocation, which reads the vector
    // from args[1] onwards: pass it through untouched.
    return runPortableExecution(args);
  }
  if (command == 'execution') {
    // Drop the subcommand so the runner sees the vector it always has:
    // args[1] is the zena-cli path, args[2] the worker count.
    let forwarded = new Array<String>(args.length);
    forwarded.push(args[0]);
    var i = 2;
    while (i < args.length) {
      forwarded.push(args[i]);
      i += 1;
    }
    return runPortableExecution(forwarded);
  }
  return runUnitSuites();
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

/**
 * One program, holding the unit suites and the portable runners. The
 * runners import no compiler module the unit suites do not already
 * import, so building them separately compiled the same compiler four
 * times over.
 */
const targets: Array<[string, string, string]> = [
  ['compiler tests', wrapperPath, join(outDir, '__all_tests__.wasm')],
];

const env = {
  ...process.env,
  // Stage A, like everything else in the repository: what these 2630 tests
  // exercise is the current implementation, and a test compiled by stage B
  // would exercise stage B instead of the output the bootstrap produced.
  // Building it with B also made the four suites wait 64s for B first. See
  // docs/design/bootstrapping.md, "Which stage to use".
  ZENA_COMPILER_WASM: 'packages/zena-compiler/zena/out/cli.wasm',
  // Wasmtime's copying collector grows the GC heap only when an
  // allocation still does not fit after a full collection, so a heap
  // that starts at nothing leaves an allocation-heavy program
  // collecting most of the time. These compiles ran without a reserve
  // and paid for it: `portable_execution` takes 48.2s at 0 and 32.0s
  // at 512MB, for 516MB more resident.
  ZENA_GC_RESERVE_MB: process.env['ZENA_GC_RESERVE_MB'] ?? '512',
};

const run = promisify(execFile);

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

const results: boolean[] = [];
for (const target of targets) {
  results.push(await build(target));
}
const failed = results.includes(false);

if (failed) {
  process.exit(1);
}
