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
 */

import {execSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
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
import { console } from 'zena:console';

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
writeFileSync(wrapperPath, generateWrapper(unitTestFiles.map((f) => basename(f))));

const portableRunners = (await glob(join(testDir, 'portable_*.zena'))).sort();

/** Every program to compile, as [label, source, output]. */
const targets: Array<[string, string, string]> = [
  ['compiler unit tests', wrapperPath, join(outDir, '__all_tests__.wasm')],
  ...portableRunners.map(
    (src): [string, string, string] => [
      basename(src, '.zena').replace(/_/g, ' '),
      src,
      join(outDir, `${basename(src, '.zena')}.wasm`),
    ],
  ),
];

const env = {
  ...process.env,
  ZENA_COMPILER_WASM: 'packages/zena-compiler/zena/out/cli-self.wasm',
};

let failed = false;
for (const [label, src, dest] of targets) {
  console.log(`Building ${label}...`);
  try {
    execSync(`"${zenaCli}" build "${src}" -o "${dest}"`, {
      stdio: 'inherit', // Show compiler output so errors surface immediately.
      cwd: repoRoot,
      env,
    });
    console.log(`  ✓ ${label}`);
  } catch {
    console.error(`  ✗ ${label} failed to build`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
