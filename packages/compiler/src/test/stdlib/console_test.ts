import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from '../codegen/utils.js';

/**
 * Create test console imports that capture output.
 * Uses the V8-recommended pattern for reading WASM GC arrays from JS.
 */
function createCapturingConsoleImports(
  getExports: () => WebAssembly.Exports | undefined,
) {
  const output: {method: string; value: string | number}[] = [];

  const readString = (strRef: unknown, len: number): string => {
    const exports = getExports();
    if (!exports || !exports.$stringGetByte) {
      throw new Error('$stringGetByte export not found');
    }
    const getByte = exports.$stringGetByte as (
      str: unknown,
      index: number,
    ) => number;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = getByte(strRef, i) & 0xff;
    }
    return new TextDecoder().decode(bytes);
  };

  return {
    imports: {
      log_i32: (val: number) => output.push({method: 'log', value: val}),
      log_f32: (val: number) => output.push({method: 'log', value: val}),
      log_string: (strRef: unknown, len: number) =>
        output.push({method: 'log', value: readString(strRef, len)}),
      error_string: (strRef: unknown, len: number) =>
        output.push({method: 'error', value: readString(strRef, len)}),
      warn_string: (strRef: unknown, len: number) =>
        output.push({method: 'warn', value: readString(strRef, len)}),
      info_string: (strRef: unknown, len: number) =>
        output.push({method: 'info', value: readString(strRef, len)}),
      debug_string: (strRef: unknown, len: number) =>
        output.push({method: 'debug', value: readString(strRef, len)}),
    },
    getOutput: () => output,
    clear: () => {
      output.length = 0;
    },
  };
}

/**
 * Helper to compile and run Zena code with the console stdlib,
 * capturing console output for assertions.
 */
async function runWithConsole(userSource: string) {
  // Deferred exports reference for string reading
  let instanceExports: WebAssembly.Exports | undefined;
  const testConsole = createCapturingConsoleImports(() => instanceExports);

  const exports = await compileAndInstantiate(userSource, {
    imports: {
      console: testConsole.imports,
    },
  });
  instanceExports = exports;

  return {
    exports: exports as {main?: () => void; [key: string]: unknown},
    getOutput: testConsole.getOutput,
  };
}

suite('Standard Library - Console', () => {
  test('console.log() with string', async () => {
    const {exports, getOutput} = await runWithConsole(`
      export let main = () => {
        console.log("Hello, World!");
      };
    `);

    exports.main!();

    const output = getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0].method, 'log');
    assert.strictEqual(output[0].value, 'Hello, World!');
  });

  test('console.log() with string concatenation', async () => {
    const {exports, getOutput} = await runWithConsole(`
      export let main = () => {
        console.log("Hello, " + "World!");
      };
    `);

    exports.main!();

    const output = getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0].method, 'log');
    assert.strictEqual(output[0].value, 'Hello, World!');
  });

  test('console.error() with string', async () => {
    const {exports, getOutput} = await runWithConsole(`
      export let main = () => {
        console.error("An error occurred!");
      };
    `);

    exports.main!();

    const output = getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0].method, 'error');
    assert.strictEqual(output[0].value, 'An error occurred!');
  });

  test('console.warn() with string', async () => {
    const {exports, getOutput} = await runWithConsole(`
      export let main = () => {
        console.warn("Warning!");
      };
    `);

    exports.main!();

    const output = getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0].method, 'warn');
    assert.strictEqual(output[0].value, 'Warning!');
  });

  test('console.info() with string', async () => {
    const {exports, getOutput} = await runWithConsole(`
      export let main = () => {
        console.info("Info message");
      };
    `);

    exports.main!();

    const output = getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0].method, 'info');
    assert.strictEqual(output[0].value, 'Info message');
  });

  test('console.debug() with string', async () => {
    const {exports, getOutput} = await runWithConsole(`
      export let main = () => {
        console.debug("Debug info");
      };
    `);

    exports.main!();

    const output = getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0].method, 'debug');
    assert.strictEqual(output[0].value, 'Debug info');
  });

  test('multiple console.log() calls', async () => {
    const {exports, getOutput} = await runWithConsole(`
      export let main = () => {
        console.log("First");
        console.log("Second");
        console.log("Third");
      };
    `);

    exports.main!();

    const output = getOutput();
    assert.strictEqual(output.length, 3);
    assert.strictEqual(output[0].value, 'First');
    assert.strictEqual(output[1].value, 'Second');
    assert.strictEqual(output[2].value, 'Third');
  });

  test('mixed console methods', async () => {
    const {exports, getOutput} = await runWithConsole(`
      export let main = () => {
        console.log("Log message");
        console.error("Error message");
        console.warn("Warn message");
      };
    `);

    exports.main!();

    const output = getOutput();
    assert.strictEqual(output.length, 3);
    assert.strictEqual(output[0].method, 'log');
    assert.strictEqual(output[1].method, 'error');
    assert.strictEqual(output[2].method, 'warn');
  });
});
