import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from '@zena-lang/compiler';
import {
  createConsoleImports,
  createStringReader,
  createStringWriter,
} from '../index.js';

/**
 * Compile a minimal Zena program that uses strings, so the WASM module
 * exports $stringCreate, $stringSetByte, $stringGetByte, $stringGetLength.
 */
async function instantiateWithStringExports() {
  // A minimal program that uses strings to ensure string helpers are emitted
  const source = `
    export let identity = (s: String) => s;
  `;

  const wasm = compile(source);
  let instanceExports: WebAssembly.Exports | undefined;
  const consoleImports = createConsoleImports(() => instanceExports);
  const result = await WebAssembly.instantiate(wasm, {
    console: consoleImports,
  });
  const instance = (result as any).instance || result;
  instanceExports = instance.exports;
  return instanceExports!;
}

suite('createStringWriter / createStringReader round-trip', () => {
  test('round-trips ASCII string', async () => {
    const exports = await instantiateWithStringExports();
    const writeString = createStringWriter(exports);
    const readString = createStringReader(exports);
    const getLength = exports.$stringGetLength as (s: unknown) => number;

    const input = 'hello world';
    const strRef = writeString(input);
    const len = getLength(strRef);
    const output = readString(strRef, len);

    assert.strictEqual(output, input);
  });

  test('round-trips empty string', async () => {
    const exports = await instantiateWithStringExports();
    const writeString = createStringWriter(exports);
    const readString = createStringReader(exports);
    const getLength = exports.$stringGetLength as (s: unknown) => number;

    const strRef = writeString('');
    const len = getLength(strRef);
    const output = readString(strRef, len);

    assert.strictEqual(output, '');
    assert.strictEqual(len, 0);
  });

  test('round-trips multi-byte UTF-8 string', async () => {
    const exports = await instantiateWithStringExports();
    const writeString = createStringWriter(exports);
    const readString = createStringReader(exports);
    const getLength = exports.$stringGetLength as (s: unknown) => number;

    const input = 'café ñ 日本語';
    const strRef = writeString(input);
    const len = getLength(strRef);
    const output = readString(strRef, len);

    assert.strictEqual(output, input);
  });

  test('written string can be passed back into WASM', async () => {
    const exports = await instantiateWithStringExports();
    const writeString = createStringWriter(exports);
    const readString = createStringReader(exports);
    const getLength = exports.$stringGetLength as (s: unknown) => number;
    const identity = exports.identity as (s: unknown) => unknown;

    const input = 'round trip through wasm';
    const strRef = writeString(input);
    const returned = identity(strRef);
    const len = getLength(returned);
    const output = readString(returned, len);

    assert.strictEqual(output, input);
  });
});
