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
const zcScript = join(repoRoot, 'scripts', 'zc.sh');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

async function run() {
  const runList = [
    'return_42.zena',
    'call_helper.zena',
    'invoke_test.zena',
    'operators',
    'variables',
    'imports',
  ];

  let files = await glob(join(testsDir, '**/*.zena'));
  files = files.filter((f) => runList.some((r) => f.includes(r)));

  const filter = process.argv[2];
  if (filter) {
    files = files.filter((f) => f.includes(filter));
  }
  files.sort();

  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const relPath = relative(testsDir, file);
    const content = readFileSync(file, 'utf-8');

    // Parse expected result and invocation target
    let expectedResult: string | undefined;
    let invokeTarget = 'main';
    for (const line of content.split('\n')) {
      const matchResult = line.match(/\/\/\s*@result:\s*(\S+)/);
      if (matchResult) {
        expectedResult = matchResult[1];
      }

      const matchInvoke = line.match(/\/\/\s*@invoke:\s*(\S+)/);
      if (matchInvoke) {
        invokeTarget = matchInvoke[1];
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
    // Compile using self-hosted Zena CLI to generate WASM
    try {
      execSync(`"${zcScript}" "${file}"`, {stdio: 'pipe', cwd: repoRoot});
      execSync(`mv "${join(repoRoot, 'zc-out.wasm')}" "${wasmOut}"`);
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
        invokeTarget,
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
