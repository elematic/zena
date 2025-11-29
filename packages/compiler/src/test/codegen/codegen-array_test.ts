import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Arrays', () => {
  test('should compile and run array literal and index access', async () => {
    const source = `
      export let main = (): i32 => {
        let arr = #[10, 20, 30];
        return arr[1];
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 20);
  });

  test('should compile and run array assignment', async () => {
    const source = `
      export let main = (): i32 => {
        let arr = #[10, 20, 30];
        arr[1] = 50;
        return arr[1];
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 50);
  });

  test('should trap on out-of-bounds access', async () => {
    const source = `
      export let main = (): i32 => {
        let arr = #[10, 20, 30];
        return arr[5];
      };
    `;

    await assert.rejects(async () => {
      await compileAndRun(source);
    }, /out of bounds/);
  });

  test('should support explicit Array type', async () => {
    const source = `
      export let main = (): i32 => {
        let arr: FixedArray<i32> = #[10, 20, 30];
        return arr.length;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 3);
  });
});
