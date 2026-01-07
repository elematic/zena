import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('Generic function as value', () => {
  test('generic function instantiation should work', async () => {
    // This tests that generic functions are properly instantiated when called
    // The generic function should be monomorphized at the call site
    const exports = await compileAndInstantiate(`
      let identity = <T>(x: T): T => x;
      
      export let test = (): i32 => {
        // Call the generic function with an i32 argument
        // This should instantiate identity<i32>
        return identity(42);
      };
    `);

    const result = exports.test();
    assert.strictEqual(result, 42);
  });

  test('generic function with multiple instantiations', async () => {
    // This tests that the same generic function can be instantiated with different types
    const exports = await compileAndInstantiate(`
      let identity = <T>(x: T): T => x;
      
      export let testI32 = (): i32 => identity(42);
      export let testI64 = (): i64 => identity(42 as i64);
    `);

    assert.strictEqual(exports.testI32(), 42);
    assert.strictEqual(exports.testI64(), 42n);
  });
});
