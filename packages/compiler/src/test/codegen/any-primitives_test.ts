import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('any with primitives', () => {
  test('is check distinguishes boxed primitive types', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = 42;
        let y: any = 3.14;
        let z: any = true;
        let s: any = "hello";
        
        var result = 0;
        if (x is i32) result = result + 1;
        if (y is f32) result = result + 10;
        if (z is boolean) result = result + 100;
        if (s is String) result = result + 1000;
        
        return result;  // Should be 1111
      };
    `);
    assert.strictEqual(result, 1111);
  });

  test('is check does not confuse i32 with f32', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = 42;
        
        if (x is f32) return 1;      // Should be false
        if (x is boolean) return 2;  // Should be false
        if (x is i32) return 0;      // Should be true
        return 3;
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('can extract value after is check', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = 42;
        
        if (x is i32) {
          let n = x as i32;  // auto-unbox
          return n + 8;      // 50
        }
        return 0;
      };
    `);
    assert.strictEqual(result, 50);
  });
});
