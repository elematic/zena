import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {strict as assert} from 'node:assert';
import {instantiate, createStringReader} from '@zena-lang/runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');

test('external function import and call from Node.js', async () => {
  const zenaFile = join(pkgDir, 'test-files', 'external-functions.zena');
  const wasmFile = join(pkgDir, 'test', 'external-functions.wasm');

  execSync(`mkdir -p "${dirname(wasmFile)}"`);

  execSync(
    `"${join(repoRoot, 'target', 'release', 'zena-cli')}" build "${zenaFile}" -o "${wasmFile}"`,
    {stdio: 'pipe', cwd: repoRoot},
  );

  const wasmBits = readFileSync(wasmFile);

  // Provide the imported function here
  let callCount = 0;
  const importObject = {
    env: {
      getStackTrace: () => null,
      captureStackTrace: () => null,
      formatStackTrace: () => null,
      getAnswer: (n: number) => {
        callCount++;
        return n * 2;
      },
    },
    wasi_snapshot_preview1: {
      fd_write: (
        fd: number,
        iovs: number,
        iovs_len: number,
        nwritten: number,
      ) => 0,
    },
  };

  const wasmModule = await WebAssembly.instantiate(wasmBits, importObject);

  const main = wasmModule.instance.exports.main as Function;
  const result = main();

  assert.equal(result, 84);
  assert.equal(callCount, 1);
});

test('console.log and return string in Node.js (target host)', async () => {
  const zenaFile = join(pkgDir, 'test-files', 'console-log-and-return.zena');
  const wasmHostFile = join(pkgDir, 'test', 'console-log-and-return-host.wasm');
  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
  const compilerWasm = join(pkgDir, 'zena', 'out', 'cli.wasm');

  const zenaFileRel = relative(repoRoot, zenaFile);
  const wasmHostFileRel = relative(repoRoot, wasmHostFile);

  execSync(`mkdir -p "${dirname(wasmHostFile)}"`);

  // Compile for target "host" using zena-cli run on cli.wasm
  execSync(
    `"${zenaCli}" run --dir "." --dir "packages/stdlib/zena::/stdlib" "${compilerWasm}" -- build "${zenaFileRel}" -o "${wasmHostFileRel}" -t host`,
    {stdio: 'pipe', cwd: repoRoot},
  );

  const hostBits = readFileSync(wasmHostFile);

  // Intercept console.log to capture logged messages from @zena-lang/runtime
  const originalLog = console.log;
  let loggedMsg = '';
  console.log = (msg: any) => {
    loggedMsg = String(msg);
  };

  try {
    const wasmModule = await instantiate(hostBits);
    const wasmInstance =
      wasmModule instanceof WebAssembly.Instance
        ? wasmModule
        : wasmModule.instance;
    const main = wasmInstance.exports.main as Function;
    const retRef = main();

    // Read string return value using the runtime's createStringReader and $stringGetLength export
    const getLength = wasmInstance.exports.$stringGetLength as (
      str: unknown,
    ) => number;
    const readString = createStringReader(wasmInstance.exports);
    const retVal = readString(retRef, getLength(retRef));

    assert.equal(loggedMsg, 'hello from integration test');
    assert.equal(retVal, 'success');
  } finally {
    console.log = originalLog;
  }
});

test('console.log and return string in zena-cli (target zena-cli)', async () => {
  const zenaFile = join(pkgDir, 'test-files', 'console-log-and-return.zena');
  const wasmCliFile = join(pkgDir, 'test', 'console-log-and-return-cli.wasm');
  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');

  const zenaFileRel = relative(repoRoot, zenaFile);
  const wasmCliFileRel = relative(repoRoot, wasmCliFile);

  execSync(`mkdir -p "${dirname(wasmCliFile)}"`);

  // Compile for target "zena-cli" using zena-cli build
  execSync(`"${zenaCli}" build "${zenaFileRel}" -o "${wasmCliFileRel}"`, {
    stdio: 'pipe',
    cwd: repoRoot,
  });

  // Verify target "zena-cli" using zena-cli run
  const cliOutput = execSync(`"${zenaCli}" run "${wasmCliFileRel}"`, {
    encoding: 'utf-8',
    cwd: repoRoot,
  }).trim();

  // The output should be "hello from integration test\nAnyRef(...)"
  // The first line is stdout print, and the second line is the CLI formatted return value representation.
  const lines = cliOutput.split('\n');
  assert.equal(lines[0], 'hello from integration test');
  assert.ok(lines[1].includes('AnyRef') || lines[1].includes('anyref'));
});
