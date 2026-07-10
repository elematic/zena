#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {writeFileSync, existsSync, mkdirSync, statSync} from 'node:fs';
import {dirname, join, relative, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';
import {availableParallelism, cpus} from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const testsDir = join(pkgDir, 'tests');
const outDir = join(testsDir, 'out-self-hosted');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');

console.log('Building WASI tests with self-hosted compiler...');

// Find all test files
const assertTests = await glob(join(testsDir, 'assert/*_test.zena'));
const testTests = await glob(join(testsDir, 'test/*_test.zena'));
const byteBufferTests = await glob(join(testsDir, 'byte-buffer/*_test.zena'));
const mathTests = await glob(join(testsDir, 'math/*_test.zena'));
const fixedArrayTests = await glob(join(testsDir, 'fixed_array/*_test.zena'));
const arrayTests = await glob(join(testsDir, 'array/*_test.zena'));
const stringTests = await glob(join(testsDir, 'string/*_test.zena'));
const stringBuilderTests = await glob(join(testsDir, 'string-builder/*_test.zena'));
const stringConvertTests = await glob(join(testsDir, 'string-convert/*_test.zena'));
const templateStringsArrayTests = await glob(join(testsDir, 'template_strings_array/*_test.zena'));
const jsonTests = await glob(join(testsDir, 'json/*_test.zena'));
const jsonBuilderTests = await glob(join(testsDir, 'json-builder/*_test.zena'));
const orderedMapTests = await glob(join(testsDir, 'ordered-map/*_test.zena'));
const setTests = await glob(join(testsDir, 'set/*_test.zena'));
const allTestFiles = [
  ...assertTests,
  ...testTests,
  ...byteBufferTests,
  ...mathTests,
  ...fixedArrayTests,
  ...arrayTests,
  ...stringTests,
  ...stringBuilderTests,
  ...stringConvertTests,
  ...templateStringsArrayTests,
  ...jsonTests,
  ...jsonBuilderTests,
  ...orderedMapTests,
  ...setTests,
];

const filesToCompile = [];
const cliWasm = join(
  repoRoot,
  'packages',
  'zena-compiler',
  'zena',
  'out',
  'cli.wasm',
);

// Get compiler modification times for cache invalidation
let compilerMtime = 0;
if (existsSync(zenaCli)) {
  compilerMtime = Math.max(compilerMtime, statSync(zenaCli).mtimeMs);
}
if (existsSync(cliWasm)) {
  compilerMtime = Math.max(compilerMtime, statSync(cliWasm).mtimeMs);
}

for (const testFile of allTestFiles) {
  const relPath = relative(testsDir, testFile);
  const baseName = basename(testFile, '.zena');
  const runnerFile = join(dirname(testFile), `${baseName}.__runner__.zena`);

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

  const wasmFile = join(outDir, relPath.replace(/\.zena$/, '.wasm'));

  // Check if rebuild needed
  let needsBuild = true;
  if (existsSync(wasmFile)) {
    const srcStat = statSync(testFile);
    const outStat = statSync(wasmFile);
    if (
      srcStat.mtimeMs <= outStat.mtimeMs &&
      compilerMtime <= outStat.mtimeMs
    ) {
      needsBuild = false;
    }
  }

  if (needsBuild) {
    filesToCompile.push({
      testFile,
      runnerFile,
      wasmFile,
      relPath,
    });
  }
}

if (filesToCompile.length === 0) {
  console.log('All tests up to date.');
  process.exit(0);
}

// Ensure output directories exist
for (const item of filesToCompile) {
  const wasmDir = dirname(item.wasmFile);
  if (!existsSync(wasmDir)) {
    mkdirSync(wasmDir, {recursive: true});
  }
}

const pLimit = availableParallelism ? availableParallelism() : cpus().length;
console.log(
  `Compiling ${filesToCompile.length} tests using ${pLimit} parallel workers...`,
);

let fileIndex = 0;
let activeCount = 0;
let failedCompile = false;
let compileErrorMsg = '';

await new Promise((resolve, reject) => {
  const checkDone = () => {
    if (fileIndex >= filesToCompile.length && activeCount === 0) {
      if (failedCompile) {
        reject(new Error(compileErrorMsg));
      } else {
        resolve();
      }
    }
  };

  const startNext = () => {
    if (failedCompile) return;
    if (fileIndex >= filesToCompile.length) {
      checkDone();
      return;
    }

    const {runnerFile, wasmFile, relPath} = filesToCompile[fileIndex++];
    activeCount++;

    const child = spawn(zenaCli, ['build', runnerFile, '-o', wasmFile], {
      cwd: pkgDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      activeCount--;
      if (code !== 0) {
        failedCompile = true;
        compileErrorMsg = `Compilation failed for ${relPath}:\n${stderr}`;
        reject(new Error(compileErrorMsg));
        return;
      }
      console.log(`✓ ${relPath}`);
      startNext();
    });
  };

  const initialWorkers = Math.min(pLimit, filesToCompile.length);
  for (let i = 0; i < initialWorkers; i++) {
    startNext();
  }
});

console.log('Build completed successfully.');
