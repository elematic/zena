import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('function type casting from union', () => {
  test('cast function from union and call', async () => {
    const source = `
      let call_fn = (f: string | (x: i32) => i32, x: i32): i32 => {
        if (f is string) {
          return 0;
        } else {
          return (f as (x: i32) => i32)(x);  // explicit cast + call
        }
      };

      export let main = (): i32 => {
        let fn = (x: i32): i32 => x + 1;
        return call_fn(fn, 5);  // Should return 6
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 6);
  });

  test('narrowing should work in else branch after is check', async () => {
    const source = `
      let call_fn = (f: string | (x: i32) => i32, x: i32): i32 => {
        if (f is string) {
          return 0;
        } else {
          // f should be narrowed to (x: i32) => i32 here
          return f(x);
        }
      };

      export let main = (): i32 => {
        let fn = (x: i32): i32 => x + 1;
        return call_fn(fn, 5);  // Should return 6
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 6);
  });

  test('narrowing with string branch executed', async () => {
    const source = `
      let call_fn = (f: string | (x: i32) => i32, x: i32): i32 => {
        if (f is string) {
          return 42;
        } else {
          return f(x);
        }
      };

      export let main = (): i32 => {
        return call_fn("hello", 5);  // Should return 42
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('function with multiple parameters', async () => {
    const source = `
      let call_fn = (f: string | (a: i32, b: i32) => i32): i32 => {
        if (f is string) {
          return 0;
        } else {
          return f(10, 20);
        }
      };

      export let main = (): i32 => {
        let fn = (a: i32, b: i32): i32 => a + b;
        return call_fn(fn);  // Should return 30
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 30);
  });

  test('function with no parameters', async () => {
    const source = `
      let call_fn = (f: string | () => i32): i32 => {
        if (f is string) {
          return 0;
        } else {
          return f();
        }
      };

      export let main = (): i32 => {
        let fn = (): i32 => 99;
        return call_fn(fn);  // Should return 99
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 99);
  });

  test('closure with captured variables', async () => {
    const source = `
      let call_fn = (f: string | (x: i32) => i32, x: i32): i32 => {
        if (f is string) {
          return 0;
        } else {
          return f(x);
        }
      };

      export let main = (): i32 => {
        let offset = 100;
        let fn = (x: i32): i32 => x + offset;
        return call_fn(fn, 5);  // Should return 105
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 105);
  });

  test('union of two different function types', async () => {
    // Test that we can correctly cast between two different function types in a union
    const source = `
      type AddFn = (x: i32, y: i32) => i32;
      type MulFn = (x: i32, y: i32) => i32;

      let call_fn = (f: AddFn | MulFn, x: i32, y: i32): i32 => {
        // Here f could be either function type - since they have same signature,
        // the call should work regardless
        return f(x, y);
      };

      export let main = (): i32 => {
        let add: AddFn = (x: i32, y: i32): i32 => x + y;
        let mul: MulFn = (x: i32, y: i32): i32 => x * y;
        return call_fn(add, 3, 4) + call_fn(mul, 3, 4);  // 7 + 12 = 19
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 19);
  });
});
