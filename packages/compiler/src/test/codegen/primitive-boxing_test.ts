import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('primitive boxing to any', () => {
  test('boolean is distinct from i32 when boxed', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let z: any = true;
        if (z is boolean) return 1;
        return 0;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('i32 is check works correctly', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = 42;
        if (x is i32) return 1;
        return 0;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('i32 is not confused with boolean', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = 42;
        if (x is boolean) return 1;
        return 0;
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('unbox any to i32', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = 42;
        let n = x as i32;
        return n;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('unbox any to i32 after is check (type narrowing)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x: any = 42;
        
        if (x is i32) {
          let n = x as i32;
          return n + 8;
        }
        return 0;
      };
    `);
    assert.strictEqual(result, 50);
  });
});
