import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import * as assert from 'node:assert';

suite('CodeGenerator - Any Type', () => {
  test('should assign primitive to any and unbox', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = 42;
        let y = x as i32;
        return y;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('should assign object to any and cast back', async () => {
    const result = await compileAndRun(`
      class Foo {
        val: i32;
        #new(val: i32) { this.val = val; }
      }
      export let main = (): i32 => {
        let f = new Foo(123);
        let x: any = f;
        let f2 = x as Foo;
        return f2.val;
      };
    `);
    assert.strictEqual(result, 123);
  });

  test('should return any from function', async () => {
    const result = await compileAndRun(`
      let getAny = (val: i32): any => {
        return val;
      };
      export let main = (): i32 => {
        let x = getAny(100);
        return x as i32;
      };
    `);
    assert.strictEqual(result, 100);
  });

  test('should pass any as argument', async () => {
    const result = await compileAndRun(`
      let identity = (val: any): any => {
        return val;
      };
      export let main = (): i32 => {
        let x = identity(55);
        return x as i32;
      };
    `);
    assert.strictEqual(result, 55);
  });

  test('should handle boolean boxing', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = true;
        let y = x as boolean;
        if (y) { return 1; } else { return 0; }
      };
    `);
    assert.strictEqual(result, 1);
  });
});
