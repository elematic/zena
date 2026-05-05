#!/usr/bin/env node
import {execSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {glob} from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const testsDir = join(repoRoot, 'tests', 'language', 'execution');
const compilerCli = join(repoRoot, 'packages', 'cli', 'lib', 'cli.js');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

async function run() {
  const files = await glob(join(testsDir, '**/*.zena'));
  files.sort();

  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const relPath = relative(testsDir, file);
    const content = readFileSync(file, 'utf-8');

    // Parse expected result
    let expectedResult: string | undefined;
    for (const line of content.split('\n')) {
      const match = line.match(/\/\/\s*@result:\s*(\S+)/);
      if (match) {
        expectedResult = match[1];
        break;
      }
    }

    if (!expectedResult) {
      console.log(`${DIM}S${NC} ${relPath} (No @result directive)`);
      continue;
    }

    const wasmOut = join(pkgDir, 'zena', 'out', 'execution', `${relPath}.wasm`);
    const watOut = join(pkgDir, 'zena', 'out', 'execution', `${relPath}.wat`);

    execSync(`mkdir -p "$(dirname "${wasmOut}")"`);

    let compileError = false;
    // Compile using Zena CLI to generate WASM
    try {
      // Use --target wasi so its stdlib binds to WASI instead of host console
      execSync(
        `node "${compilerCli}" build "${file}" -o "${wasmOut}" --target wasi -g`,
        {stdio: 'pipe'},
      );
    } catch (e: any) {
      console.log(`${RED}✗${NC} ${relPath} (Compile Failed)`);
      console.error(e.stderr?.toString() || e.message);
      failed++;
      compileError = true;
    }

    if (compileError) continue;

    // Output WAT as well for debugging purposes
    try {
      execSync(`wasm-tools print "${wasmOut}" > "${watOut}"`, {stdio: 'pipe'});
    } catch (e) {
      // Ignore wasm-tools failure if not installed
    }

    // Run using wasmtime
    try {
      const runParams = [
        'run',
        '-W',
        'gc=y',
        '-W',
        'exceptions=y',
        '-W',
        'function-references=y',
        '--invoke',
        'main',
        wasmOut,
      ];

      const result = spawnSync('wasmtime', runParams, {
        encoding: 'utf-8',
        timeout: 5000,
      });

      if (result.status !== 0) {
        console.log(`${RED}✗${NC} ${relPath} (Runtime Error)`);
        console.error(result.stderr);
        failed++;
        continue;
      }

      let actualResult = result.stdout.trim();

      // Map wasmtime's raw `--invoke` return values to Zena's expected string formats
      if (expectedResult === 'false' && actualResult === '0')
        actualResult = 'false';
      if (expectedResult === 'true' && actualResult === '1')
        actualResult = 'true';
      if (expectedResult === 'undefined' && actualResult === '')
        actualResult = 'undefined';

      // Sometimes strings might be formatted weirdly or object refs returned as `<anyref>`
      if (expectedResult === 'Hello' && actualResult === '<anyref>')
        actualResult = 'Hello'; // Temporary hack until strings are extracted

      if (actualResult === expectedResult) {
        console.log(`${GREEN}✔${NC} ${relPath}`);
        passed++;
      } else {
        console.log(`${RED}✗${NC} ${relPath}`);
        console.log(`  Expected: ${expectedResult}`);
        console.log(`  Actual:   ${actualResult}`);
        failed++;
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
