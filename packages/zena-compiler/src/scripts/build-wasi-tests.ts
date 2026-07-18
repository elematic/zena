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

const selfHosted = process.env.SELF_HOSTED === 'true';
const testSubdir = selfHosted ? 'test-self' : 'test';

// Generate a single monolithic test file
const generateWrapper = (testFileNames: string[]): string => {
  let imports = '';
  let pushes = '';
  testFileNames.forEach((file, index) => {
    imports += `import { tests as t${index} } from './${file}';\n`;
    pushes += `  root.suites.push(t${index});\n`;
  });

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

// Build all test files
const testPattern = 'test/*_test.zena';

console.log(
  `Building zena-compiler tests (${selfHosted ? 'self-hosted' : 'bootstrap'})...`,
);
console.log('');

const fullPattern = join(zenaDir, testPattern);
const files = await glob(fullPattern);
files.sort(); // Ensure stable output order

const testFileNames = files.map((f) => basename(f));
const wrapperFileName = '__all_tests__.zena';
const wrapperPath = join(zenaDir, 'test', wrapperFileName);
const wasmFile = join(outDir, testSubdir, '__all_tests__.wasm');

// Ensure output directory exists
const wasmDir = dirname(wasmFile);
if (!existsSync(wasmDir)) {
  mkdirSync(wasmDir, {recursive: true});
}

writeFileSync(wrapperPath, generateWrapper(testFileNames));

const compileCommand = (src: string, dest: string): string => {
  if (selfHosted) {
    const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
    return `"${zenaCli}" build "${src}" -o "${dest}"`;
  } else {
    return `node --stack-size=4096 "${cliPath}" build "${src}" --target wasi -g -l -o "${dest}" --warn-unnecessary-casts --warnings-as-errors`;
  }
};

const runEnv = {...process.env};
if (selfHosted) {
  runEnv.ZENA_COMPILER_WASM = 'packages/zena-compiler/zena/out/cli-self.wasm';
}

let failed = false;

try {
  execSync(compileCommand(wrapperPath, wasmFile), {
    stdio: 'inherit', // Show compiler output so we see errors immediately
    cwd: repoRoot,
    env: runEnv,
  });
  console.log(`  ✓ Combined tests built successfully`);
} catch (e: unknown) {
  console.error(`  ✗ Combined tests failed to build`);
  failed = true;
}

const syntaxSrc = join(zenaDir, 'test', 'portable_syntax.zena');
const syntaxWasm = join(outDir, testSubdir, 'portable_syntax.wasm');
try {
  console.log('Building portable syntax tests...');
  execSync(compileCommand(syntaxSrc, syntaxWasm), {
    stdio: 'inherit',
    cwd: repoRoot,
    env: runEnv,
  });
  console.log(`  ✓ Portable syntax tests built successfully`);
} catch (e: unknown) {
  console.error(`  ✗ Portable syntax tests failed to build`);
  failed = true;
}

const semanticsSrc = join(zenaDir, 'test', 'portable_semantics.zena');
const semanticsWasm = join(outDir, testSubdir, 'portable_semantics.wasm');
try {
  console.log('Building portable semantics tests...');
  execSync(compileCommand(semanticsSrc, semanticsWasm), {
    stdio: 'inherit',
    cwd: repoRoot,
    env: runEnv,
  });
  console.log(`  ✓ Portable semantics tests built successfully`);
} catch (e: unknown) {
  console.error(`  ✗ Portable semantics tests failed to build`);
  failed = true;
}

if (failed) {
  process.exit(1);
}
