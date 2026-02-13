/**
 * Test for WASM validation bug with exception handling in multi-module scenarios.
 *
 * Bug: When compiling modules that import stdlib modules (like Map, Array),
 * the generated WASM fails validation with:
 *   "call[0] expected type (ref null X), found local.get of type eqref"
 *
 * This happens because exception handling code generates eqref for caught
 * exceptions, but some call sites expect a more specific reference type.
 *
 * See BUGS.md for details.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun, compileAndInstantiate} from './utils.js';

suite('Codegen: Exception handling with multi-module imports', () => {
  // This test passes - simple try/catch works
  test('simple try/catch works', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = try {
          throw new Error("oops");
          1
        } catch (e) {
          42
        };
        return x;
      };
    `);
    assert.strictEqual(result, 42);
  });

  // This test passes - try/catch with Error.message works
  test('try/catch accessing error message works', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = try {
          throw new Error("test");
          0
        } catch (e) {
          if (e.message == "test") { 42 } else { 0 }
        };
        return x;
      };
    `);
    assert.strictEqual(result, 42);
  });

  // This test should trigger the bug - imports Map which has internal try/catch
  // Map.get returns (value, found) tuple - destructure properly
  test('module importing Map compiles and instantiates', async () => {
    const exports = await compileAndInstantiate(`
      import {Map} from 'zena:map';
      
      export let main = (): i32 => {
        let m = new Map<i32, i32>();
        m.set(1, 100);
        let (value, found) = m.get(1);
        return if (found) { value } else { 0 };
      };
    `);
    assert.ok(exports, 'compileAndInstantiate returned undefined');
    assert.ok(typeof exports.main === 'function', 'main export missing');
    const result = (exports as {main: () => number}).main();
    assert.strictEqual(result, 100);
  });

  // This test should also trigger the bug - imports Array
  test('module importing growable Array compiles and instantiates', async () => {
    const exports = await compileAndInstantiate(`
      import {Array} from 'zena:growable-array';
      
      export let main = (): i32 => {
        let arr = new Array<i32>();
        arr.push(42);
        return arr[0];
      };
    `);
    assert.ok(exports, 'compileAndInstantiate returned undefined');
    assert.ok(typeof exports.main === 'function', 'main export missing');
    const result = (exports as {main: () => number}).main();
    assert.strictEqual(result, 42);
  });

  // Test module with class that has initializer (simpler than Error subclass)
  test('module with class and try/catch', async () => {
    const exports = await compileAndInstantiate(`
      class Counter {
        value: i32 = 0;
        
        increment(): i32 {
          this.value = this.value + 1;
          return this.value;
        }
      }
      
      export let main = (): i32 => {
        let result = try {
          let c = new Counter();
          c.increment();
          c.increment()
        } catch (e) {
          -1
        };
        return result;
      };
    `);
    assert.ok(exports, 'compileAndInstantiate returned undefined');
    assert.ok(typeof exports.main === 'function', 'main export missing');
    const result = (exports as {main: () => number}).main();
    assert.strictEqual(result, 2);
  });

  // Test that combines imports + try/catch in the same module
  // Map.get returns (value, found) - handle properly
  test('module with Map import and local try/catch', async () => {
    const exports = await compileAndInstantiate(`
      import {Map} from 'zena:map';
      
      let safeLookup = (m: Map<i32, i32>, key: i32): i32 => {
        return try {
          let (value, found) = m.get(key);
          if (found) { value } else { -1 }
        } catch (e) {
          -1
        };
      };
      
      export let main = (): i32 => {
        let m = new Map<i32, i32>();
        m.set(5, 500);
        return safeLookup(m, 5);
      };
    `);
    assert.ok(exports, 'compileAndInstantiate returned undefined');
    assert.ok(typeof exports.main === 'function', 'main export missing');
    const result = (exports as {main: () => number}).main();
    assert.strictEqual(result, 500);
  });
});
