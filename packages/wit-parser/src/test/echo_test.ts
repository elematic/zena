/**
 * Test for the echo module - verifies string interop between TypeScript and Zena.
 *
 * This test:
 * 1. Compiles the echo.zena module
 * 2. Provides input string via imports (getLength/getByte)
 * 3. Calls echo/process/countLines
 * 4. Reads the output via exports (getOutputLength/getOutputByte)
 *
 * Run with: npm run test:interop -w @zena-lang/wit-parser
 */

import {suite, test} from 'node:test';
import assert from 'node:assert';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileZenaFile} from '../scripts/compile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to echo module
const echoPath = join(__dirname, '../zena/echo.zena');

/**
 * Compile the echo module with the self-hosted compiler.
 */
const compileEcho = (): Uint8Array => {
  return compileZenaFile(echoPath);
};

/**
 * Instantiate WASM bytes with input string and return the instance.
 */
const instantiateWasm = async (
  bytes: Uint8Array,
  inputString: string,
): Promise<WebAssembly.Instance> => {
  const inputBytes = new TextEncoder().encode(inputString);

  const imports = {
    env: {
      getStackTrace: () => null,
      captureStackTrace: () => null,
      formatStackTrace: () => null,
    },
    input: {
      getLength: () => inputBytes.length,
      getByte: (index: number) => inputBytes[index] ?? 0,
    },
    // Console imports required by prelude
    console: {
      log_i32: () => {},
      log_f32: () => {},
      log_string: () => {},
      error_string: () => {},
      warn_string: () => {},
      info_string: () => {},
      debug_string: () => {},
    },
  };

  const result = await WebAssembly.instantiate(
    bytes as BufferSource,
    imports as WebAssembly.Imports,
  );
  // When instantiating from bytes, we get WebAssemblyInstantiatedSource
  return (result as unknown as {instance: WebAssembly.Instance}).instance;
};

/**
 * Read a string from WASM exports.
 */
const readString = (exports: WebAssembly.Exports): string => {
  const getOutputLength = exports.getOutputLength as () => number;
  const getOutputByte = exports.getOutputByte as (index: number) => number;

  const length = getOutputLength();
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = getOutputByte(i) & 0xff;
  }
  return new TextDecoder().decode(bytes);
};

suite('Echo Module - String Interop', () => {
  let wasmBytes: Uint8Array;

  test('compiles successfully', async () => {
    wasmBytes = compileEcho();
    assert.ok(wasmBytes.length > 0, 'Should produce WASM bytes');
    console.log(`Compiled echo module: ${wasmBytes.length} bytes`);
  });

  test('instantiates successfully', async () => {
    if (!wasmBytes) {
      wasmBytes = compileEcho();
    }

    const instance = await instantiateWasm(wasmBytes, '');
    assert.ok(instance, 'Should instantiate');
    assert.ok(instance.exports.echo, 'Should export echo');
    assert.ok(instance.exports.process, 'Should export process');
    assert.ok(instance.exports.countLines, 'Should export countLines');
    assert.ok(
      instance.exports.getOutputLength,
      'Should export getOutputLength',
    );
    assert.ok(instance.exports.getOutputByte, 'Should export getOutputByte');
  });

  test('echo returns input unchanged', async () => {
    if (!wasmBytes) {
      wasmBytes = compileEcho();
    }

    const input = 'Hello, World!';
    const instance = await instantiateWasm(wasmBytes, input);

    (instance.exports.echo as () => void)();
    const output = readString(instance.exports);

    assert.strictEqual(output, input, 'Should echo input unchanged');
  });

  test('countLines counts newlines correctly', async () => {
    if (!wasmBytes) {
      wasmBytes = compileEcho();
    }

    const input = 'line1\nline2\nline3';
    const instance = await instantiateWasm(wasmBytes, input);

    const lines = (instance.exports.countLines as () => number)();

    assert.strictEqual(lines, 3, 'Should count 3 lines');
  });

  test('process returns length info', async () => {
    if (!wasmBytes) {
      wasmBytes = compileEcho();
    }

    const input = 'This is a test string';
    const instance = await instantiateWasm(wasmBytes, input);

    (instance.exports.process as () => void)();
    const output = readString(instance.exports);

    // Should be like "length=21"
    assert.ok(
      output.startsWith('length='),
      `Should start with "length=", got: ${output}`,
    );
    assert.ok(
      output.includes('21'),
      `Should include length 21, got: ${output}`,
    );
  });

  test('handles WIT-like input', async () => {
    if (!wasmBytes) {
      wasmBytes = compileEcho();
    }

    const witSource = `package example:my-package;

interface my-interface {
  record my-record {
    field1: string,
    field2: u32,
  }

  my-func: func(input: string) -> my-record;
}
`;

    const instance = await instantiateWasm(wasmBytes, witSource);

    const lines = (instance.exports.countLines as () => number)();
    assert.ok(lines > 5, `Should count multiple lines (got ${lines})`);

    (instance.exports.echo as () => void)();
    const echoed = readString(instance.exports);
    assert.strictEqual(echoed, witSource, 'Should echo WIT source unchanged');
  });
});
