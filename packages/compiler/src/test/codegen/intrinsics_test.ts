import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Codegen - Intrinsics', () => {
  test('__array_new and __array_len', async () => {
    const input = `
      export let main = (): i32 => {
        let a = __array_new(10, 0);
        return __array_len(a);
      };
    `;
    // Must run in zena: module to access intrinsics
    const result = await compileAndRun(input, {path: 'zena:test'});
    assert.strictEqual(result, 10);
  });

  test('__array_get and __array_set', async () => {
    const input = `
      export let main = (): i32 => {
        let a = __array_new(10, 0);
        __array_set(a, 5, 42);
        return __array_get(a, 5);
      };
    `;
    const result = await compileAndRun(input, {path: 'zena:test'});
    assert.strictEqual(result, 42);
  });

  test('extension method using intrinsic', async () => {
    const input = `
      extension class Array on FixedArray<i32> {
          @intrinsic("array.len")
          declare size(): i32;
      }
      
      export let main = (): i32 => {
          let a = __array_new(5, 0);
          return a.size();
      };
    `;
    const result = await compileAndRun(input, {path: 'zena:test'});
    assert.strictEqual(result, 5);
  });
});
