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

  // A core module with only the import the program declares: the
  // freestanding target. The default target is a component now, which
  // Node cannot instantiate as a plain module.
  execSync(
    `"${join(repoRoot, 'target', 'release', 'zena-cli')}" build "${zenaFile}" --target freestanding -o "${wasmFile}"`,
    {stdio: 'pipe', cwd: repoRoot},
  );

  const wasmBits = readFileSync(wasmFile);

  // Provide the imported function here
  let callCount = 0;
  const importObject = {
    env: {
      getAnswer: (n: number) => {
        callCount++;
        return n * 2;
      },
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

    // With target host (alias for js), strings are native JS strings - no reader needed!
    assert.equal(typeof retRef, 'string');
    assert.equal(retRef, 'success');
    assert.equal(loggedMsg, 'hello from integration test');
  } finally {
    console.log = originalLog;
  }
});

test('console.log and return string in Node.js (target js)', async () => {
  const zenaFile = join(pkgDir, 'test-files', 'console-log-and-return.zena');
  const wasmJsFile = join(pkgDir, 'test', 'console-log-and-return-js.wasm');
  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
  const compilerWasm = join(pkgDir, 'zena', 'out', 'cli.wasm');

  const zenaFileRel = relative(repoRoot, zenaFile);
  const wasmJsFileRel = relative(repoRoot, wasmJsFile);

  execSync(`mkdir -p "${dirname(wasmJsFile)}"`);

  // Compile for target "js" using zena-cli run on cli.wasm
  execSync(
    `"${zenaCli}" run --dir "." --dir "packages/stdlib/zena::/stdlib" "${compilerWasm}" -- build "${zenaFileRel}" -o "${wasmJsFileRel}" -t js`,
    {stdio: 'pipe', cwd: repoRoot},
  );

  const jsBits = readFileSync(wasmJsFile);

  // Intercept console.log to capture logged messages from @zena-lang/runtime
  const originalLog = console.log;
  let loggedMsg = '';
  console.log = (msg: any) => {
    loggedMsg = String(msg);
  };

  try {
    const wasmModule = await instantiate(jsBits);
    const wasmInstance =
      wasmModule instanceof WebAssembly.Instance
        ? wasmModule
        : wasmModule.instance;
    const main = wasmInstance.exports.main as Function;
    const retVal = main();

    // With target js, strings are native JS strings - no reader needed!
    assert.equal(typeof retVal, 'string');
    assert.equal(retVal, 'success');
    assert.equal(loggedMsg, 'hello from integration test');
  } finally {
    console.log = originalLog;
  }
});

// WebAssembly ESM integration compiles every module with this
// `importedStringConstants` name.
const esmStringConstants = 'wasm:js/string-constants';

test('string literals from the --imported-string-constants module (zc, target js)', async () => {
  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
  const compilerWasm = join(pkgDir, 'zena', 'out', 'cli.wasm');
  const zenaFileRel = relative(
    repoRoot,
    join(pkgDir, 'test-files', 'console-log-and-return.zena'),
  );
  const wasmFile = join(pkgDir, 'test', 'console-log-and-return-esm-zc.wasm');

  execSync(`mkdir -p "${dirname(wasmFile)}"`);
  execSync(
    `"${zenaCli}" run --dir "." --dir "packages/stdlib/zena::/stdlib" "${compilerWasm}" -- build "${zenaFileRel}" -o "${relative(repoRoot, wasmFile)}" -t js --imported-string-constants ${esmStringConstants}`,
    {stdio: 'pipe', cwd: repoRoot},
  );

  const module = new (WebAssembly.Module as any)(readFileSync(wasmFile), {
    builtins: ['js-string'],
    importedStringConstants: esmStringConstants,
  }) as WebAssembly.Module;
  let loggedMsg = '';
  const instance = new WebAssembly.Instance(module, {
    console: {
      log_string: (s: string) => {
        loggedMsg = s;
      },
    },
  });
  const {main, $stringGetHandle} = instance.exports as Record<string, Function>;
  assert.equal($stringGetHandle(main()), 'success');
  assert.equal(loggedMsg, 'hello from integration test');
});

test('string literals from the --imported-string-constants module (zena build, runtime)', async () => {
  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
  const zenaFileRel = relative(
    repoRoot,
    join(pkgDir, 'test-files', 'console-log-and-return.zena'),
  );
  const wasmFile = join(pkgDir, 'test', 'console-log-and-return-esm.wasm');

  execSync(`mkdir -p "${dirname(wasmFile)}"`);
  execSync(
    `"${zenaCli}" build "${zenaFileRel}" -t js --imported-string-constants ${esmStringConstants} -o "${relative(repoRoot, wasmFile)}"`,
    {stdio: 'pipe', cwd: repoRoot},
  );

  const originalLog = console.log;
  let loggedMsg = '';
  console.log = (msg: any) => {
    loggedMsg = String(msg);
  };

  try {
    const wasmModule = await instantiate(readFileSync(wasmFile), {
      importedStringConstants: esmStringConstants,
    });
    const wasmInstance =
      wasmModule instanceof WebAssembly.Instance
        ? wasmModule
        : wasmModule.instance;
    assert.equal((wasmInstance.exports.main as Function)(), 'success');
    assert.equal(loggedMsg, 'hello from integration test');
  } finally {
    console.log = originalLog;
  }
});

test('--imported-string-constants rejects an empty name and a target without string constants', () => {
  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
  const zenaFileRel = relative(
    repoRoot,
    join(pkgDir, 'test-files', 'console-log-and-return.zena'),
  );
  const wasmFileRel = relative(
    repoRoot,
    join(pkgDir, 'test', 'imported-string-constants-rejected.wasm'),
  );

  const stderrOf = (flags: string): string => {
    try {
      execSync(
        `"${zenaCli}" build "${zenaFileRel}" ${flags} -o "${wasmFileRel}"`,
        {
          stdio: 'pipe',
          cwd: repoRoot,
        },
      );
    } catch (err) {
      return String((err as {stderr: Buffer}).stderr);
    }
    assert.fail(`zena build ${flags} succeeded`);
  };

  assert.match(
    stderrOf('-t js --imported-string-constants ""'),
    /--imported-string-constants names a module, and the name is empty/,
  );
  assert.match(
    stderrOf(
      `-t freestanding --imported-string-constants ${esmStringConstants}`,
    ),
    /the target is 'freestanding', which imports none/,
  );
});

test('--compact-imports groups imports, and only on a core module', () => {
  const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
  const zenaFileRel = relative(
    repoRoot,
    join(pkgDir, 'test-files', 'console-log-and-return.zena'),
  );
  const build = (flags: string, name: string): Buffer => {
    const wasmFile = join(pkgDir, 'test', `${name}.wasm`);
    execSync(`mkdir -p "${dirname(wasmFile)}"`);
    execSync(
      `"${zenaCli}" build "${zenaFileRel}" ${flags} -o "${relative(repoRoot, wasmFile)}"`,
      {stdio: 'pipe', cwd: repoRoot},
    );
    return readFileSync(wasmFile);
  };

  // Nothing Node embeds reads the encoding yet, so this asserts only
  // that the string constants stopped repeating their module and type.
  const plain = build('-t js', 'compact-imports-plain');
  const compact = build('-t js --compact-imports', 'compact-imports');
  assert.ok(
    compact.length < plain.length,
    `${compact.length} bytes compact, ${plain.length} plain`,
  );

  assert.throws(
    () =>
      execSync(
        `"${zenaCli}" build "${zenaFileRel}" --compact-imports -o "${relative(repoRoot, join(pkgDir, 'test', 'compact-imports-rejected.wasm'))}"`,
        {stdio: 'pipe', cwd: repoRoot},
      ),
    (err: {stderr: Buffer}) =>
      /the target is 'zena-cli', which emits a component/.test(
        String(err.stderr),
      ),
  );
});

test('console.log and return a status in zena-cli (target zena-cli, a component)', async () => {
  const zenaFile = join(pkgDir, 'test-files', 'console-log-and-exit-code.zena');
  const wasmCliFile = join(
    pkgDir,
    'test',
    'console-log-and-exit-code-cli.wasm',
  );
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

  // The first line is what the program printed; the second is the
  // value its `main` returned, as `zena run` prints it. On this host
  // the entry is lifted async and the value arrives through a typed
  // `task.return`, which carries a flat scalar; a `main` returning a
  // String is refused at compile time until that return learns
  // strings.
  const lines = cliOutput.split('\n');
  assert.equal(lines[0], 'hello from integration test');
  assert.equal(lines[1], '7');
});
