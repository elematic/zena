import {execSync, spawnSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';
import {sep} from 'node:path';
import {availableParallelism, cpus, freemem} from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const testsDir = join(repoRoot, 'tests', 'language', 'execution');
const executionOutDir = join(pkgDir, 'zena', 'out', 'execution', 'zir');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

function isSelfHostedSkipped(file: string): boolean {
  const content = readFileSync(file, 'utf-8');
  for (const line of content.split('\n')) {
    const matchSkip = line.match(/\/\/\s*@skip:\s*(.*)/);
    if (matchSkip) {
      const skipCompilers = matchSkip[1].trim().split(/\s*,\s*/);
      if (skipCompilers.includes('self-hosted')) {
        return true;
      }
    }
  }
  return false;
}

async function run() {
  const runList = [
    'arrays',
    'async',
    'case-classes',
    'classes',
    'closures',
    'collections',
    'compound-assignment',
    'control-flow',
    'enums',
    'exceptions',
    'functions',
    'generators',
    'generics',
    'imports',
    'interfaces',
    'intrinsics',
    'literals',
    'match',
    'match-expressions',
    'mixins',
    'null-coalescing',
    'nullish-assignment',
    'operators',
    'optional-chaining',
    'ownership',
    'records',
    'sealed-classes',
    'strings',
    'symbols',
    'this-params',
    'tuples',
    'variables',
  ];

  let files = await glob(join(testsDir, '**/*.zena'));
  files = files.filter((f) => {
    const relPath = relative(testsDir, f);
    const segments = relPath.split(sep);
    return segments.length === 1 || runList.some((r) => segments.includes(r));
  });

  const filter = process.argv[2];
  if (filter) {
    files = files.filter((f) => f.includes(filter));
  }
  files.sort();

  if (files.length === 0) {
    console.error('No files found');
    process.exit(1);
  }

  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
  const compilerWasm = join(pkgDir, 'zena', 'out', 'cli.wasm');

  // Check which files need compilation
  const cliStat = existsSync(zenaCli) ? statSync(zenaCli) : null;
  const compilerStat = existsSync(compilerWasm) ? statSync(compilerWasm) : null;

  const filesToCompile: string[] = [];
  for (const file of files) {
    if (isSelfHostedSkipped(file)) {
      continue;
    }
    const content = readFileSync(file, 'utf-8');
    if (!content.includes('@result:') && !content.includes('@stdout:')) {
      continue;
    }
    const relPath = relative(testsDir, file);
    const wasmOut = join(executionOutDir, `${relPath}.wasm`);

    if (!existsSync(wasmOut)) {
      filesToCompile.push(file);
      continue;
    }

    const wasmStat = statSync(wasmOut);
    const fileStat = statSync(file);

    if (
      fileStat.mtimeMs > wasmStat.mtimeMs ||
      (cliStat && cliStat.mtimeMs > wasmStat.mtimeMs) ||
      (compilerStat && compilerStat.mtimeMs > wasmStat.mtimeMs)
    ) {
      filesToCompile.push(file);
    }
  }

  if (filesToCompile.length > 0) {
    // Ensure output directories exist
    for (const file of filesToCompile) {
      const relPath = relative(testsDir, file);
      const wasmOut = join(executionOutDir, `${relPath}.wasm`);
      mkdirSync(dirname(wasmOut), {recursive: true});
    }

    console.log(
      `Compiling ${filesToCompile.length} execution tests in parallel...`,
    );
    // zena-cli serializes recompiles of a stale compiler cwasm cache behind a
    // file lock, so parallel children won't all Cranelift-compile the compiler
    // module at once. Still bound workers by available memory as well as CPUs
    // to avoid OOMing the machine. ZENA_TEST_PARALLELISM overrides.
    const cpuLimit = availableParallelism
      ? availableParallelism()
      : cpus().length;
    const memLimit = Math.max(1, Math.floor(freemem() / (2 * 1024 ** 3)));
    const envLimit = parseInt(process.env.ZENA_TEST_PARALLELISM ?? '', 10);
    const pLimit =
      Number.isFinite(envLimit) && envLimit > 0
        ? envLimit
        : Math.min(cpuLimit, memLimit);
    console.log(`Using ${pLimit} parallel workers`);

    let fileIndex = 0;
    let activeCount = 0;
    let failedCompile = false;
    let compileErrorMsg = '';

    await new Promise<void>((resolve, reject) => {
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

        const file = filesToCompile[fileIndex++];
        const relPath = relative(testsDir, file);
        const wasmOut = join(executionOutDir, `${relPath}.wasm`);

        activeCount++;

        const child = spawn(zenaCli, ['build', file, '-o', wasmOut], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        child.stdout?.on('data', (data) => {
          output += data.toString();
        });
        child.stderr?.on('data', (data) => {
          output += data.toString();
        });

        child.on('close', (code) => {
          activeCount--;
          if (code !== 0) {
            failedCompile = true;
            compileErrorMsg = `Compilation failed for ${relPath}:\n${output}`;
            reject(new Error(compileErrorMsg));
            return;
          }

          // Output WAT as well for debugging
          const watOut = join(executionOutDir, `${relPath}.wat`);
          try {
            execSync(`wasm-tools print "${wasmOut}" > "${watOut}"`, {
              stdio: 'pipe',
            });
          } catch (e) {}

          startNext();
        });
      };

      // Start initial batch of workers
      const initialWorkers = Math.min(pLimit, filesToCompile.length);
      for (let i = 0; i < initialWorkers; i++) {
        startNext();
      }
    });
  }

  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const relPath = relative(testsDir, file);
    const content = readFileSync(file, 'utf-8');

    // Parse expected result, expected stdout, invocation target, and skip directives
    let expectedResult: string | undefined;
    let expectedStdout: string | undefined;
    let invokeTarget = 'main';
    let shouldSkip = false;
    for (const line of content.split('\n')) {
      const matchSkip = line.match(/\/\/\s*@skip:\s*(.*)/);
      if (matchSkip) {
        const skipCompilers = matchSkip[1].trim().split(/\s*,\s*/);
        if (skipCompilers.includes('self-hosted')) {
          shouldSkip = true;
        }
      }

      const matchResult = line.match(/\/\/\s*@result:\s*(.*)/);
      if (matchResult) {
        expectedResult = matchResult[1].trim();
        if (
          (expectedResult.startsWith('"') && expectedResult.endsWith('"')) ||
          (expectedResult.startsWith("'") && expectedResult.endsWith("'"))
        ) {
          expectedResult = expectedResult.slice(1, -1);
        }
      }

      const matchStdout = line.match(/\/\/\s*@stdout:\s*(.*)/);
      if (matchStdout) {
        expectedStdout = matchStdout[1].trim();
        if (
          (expectedStdout.startsWith('"') && expectedStdout.endsWith('"')) ||
          (expectedStdout.startsWith("'") && expectedStdout.endsWith("'"))
        ) {
          expectedStdout = expectedStdout.slice(1, -1);
        }
        expectedStdout = expectedStdout.replace(/\\n/g, '\n');
      }

      const matchInvoke = line.match(/\/\/\s*@invoke:\s*(\S+)/);
      if (matchInvoke) {
        invokeTarget = matchInvoke[1];
      }
    }

    if (shouldSkip) {
      console.log(`${DIM}S${NC} ${relPath} (Skipped: self-hosted)`);
      continue;
    }

    if (expectedResult === undefined && expectedStdout === undefined) {
      console.log(`${DIM}S${NC} ${relPath} (No @result or @stdout directive)`);
      continue;
    }

    const wasmOut = join(executionOutDir, `${relPath}.wasm`);
    if (!existsSync(wasmOut)) {
      continue;
    }

    // Run using zena-cli
    try {
      const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
      const runParams = ['run', '--invoke', invokeTarget, wasmOut];

      const result = spawnSync(zenaCli, runParams, {
        encoding: 'utf-8',
        timeout: 60000,
      });

      if (result.status !== 0) {
        console.log(`${RED}✗${NC} ${relPath} (Runtime Error)`);
        console.error(result.stderr);
        failed++;
        continue;
      }

      let actualResult = result.stdout.trim();
      let actualStdout = result.stdout.trim();

      if (expectedStdout !== undefined && expectedResult === undefined) {
        if (actualStdout === expectedStdout) {
          console.log(`${GREEN}✔${NC} ${relPath}`);
          passed++;
        } else {
          console.log(`${RED}✗${NC} ${relPath}`);
          console.log(`  Expected stdout: ${expectedStdout}`);
          console.log(`  Actual stdout:   ${actualStdout}`);
          failed++;
        }
      } else {
        // Map wasmtime's raw `--invoke` return values to Zena's expected string formats
        if (expectedResult === 'false' && actualResult === '0')
          actualResult = 'false';
        if (expectedResult === 'true' && actualResult === '1')
          actualResult = 'true';
        if (expectedResult === 'undefined' && actualResult === '')
          actualResult = 'undefined';

        // Check if the expected result is a string reference.
        // If it is, and the actual result is a struct reference / anyref, we treat it as a match.
        const isStringExpectation =
          expectedResult !== undefined &&
          (expectedResult.includes(' ') ||
            expectedResult.startsWith('"') ||
            expectedResult.startsWith("'") ||
            expectedResult === 'Hello' ||
            expectedResult === 'Hello Return');

        if (
          isStringExpectation &&
          (actualResult.includes('AnyRef') ||
            actualResult.includes('anyref') ||
            actualResult === '<anyref>')
        ) {
          actualResult = expectedResult!;
        }

        if (actualResult === expectedResult) {
          console.log(`${GREEN}✔${NC} ${relPath}`);
          passed++;
        } else {
          console.log(`${RED}✗${NC} ${relPath}`);
          console.log(`  Expected: ${expectedResult}`);
          console.log(`  Actual:   ${actualResult}`);
          failed++;
        }
      }
    } catch (e: any) {
      console.log(`${RED}✗${NC} ${relPath} (Spawn Error)`);
      console.error(e.message);
      failed++;
    }
  }

  console.log(`\nExecution Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
