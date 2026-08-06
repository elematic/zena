import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from './compile-zena.js';
import {instantiate, createStringReader} from '../index.js';

async function compileAndInstantiate(source: string) {
  const wasm = compile(source);
  const result = await instantiate(wasm);
  const instance = 'instance' in result ? result.instance : result;
  return instance.exports;
}

suite('JS Runtime Lazy Stack Trace', () => {
  test('captures and formats stack trace successfully', async () => {
    const source = `
      import { String } from 'zena:string';

      @external("env", "captureStackTrace")
      declare function __captureStackTrace(): anyref;

      @external("env", "formatStackTrace")
      declare function __formatStackTrace(stack: anyref): String | null;

      export let testCaptureAndFormat = (): String | null => {
        let stack = __captureStackTrace();
        return __formatStackTrace(stack);
      };
    `;

    const exports = await compileAndInstantiate(source);
    const testCaptureAndFormat = exports.testCaptureAndFormat as () => unknown;
    const readString = createStringReader(exports);
    const getLength = exports.$stringGetLength as (s: unknown) => number;

    const strRef = testCaptureAndFormat();
    assert.ok(strRef, 'Expected a non-null string reference');

    const len = getLength(strRef);
    const stackTrace = readString(strRef, len);

    // Node.js V8 backtrace format will contain the test file name/path
    assert.ok(stackTrace.length > 0, 'Stack trace should not be empty');
    assert.ok(
      stackTrace.includes('stack_trace_test'),
      'Stack trace should contain test file name',
    );
  });

  test('fails loudly if formatStackTrace is passed invalid object', async () => {
    const source = `
      import { String } from 'zena:string';

      @external("env", "formatStackTrace")
      declare function __formatStackTrace(stack: anyref): String | null;

      export let testFormatInvalid = (): String | null => {
        let val: anyref = new Box<i32>(123);
        return __formatStackTrace(val);
      };
    `;

    const exports = await compileAndInstantiate(source);
    const testFormatInvalid = exports.testFormatInvalid as () => unknown;

    assert.throws(() => {
      testFormatInvalid();
    }, /formatStackTrace: expected Error instance/);
  });
});
