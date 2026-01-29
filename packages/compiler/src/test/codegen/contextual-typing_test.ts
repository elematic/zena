import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen: Contextual Typing', () => {
  test('infer closure parameter types from function argument', async () => {
    const result = await compileAndRun(`
      let apply = (fn: (x: i32) => i32, value: i32) => fn(value);
      export let main = () => apply((x) => x * 2, 5);
    `);
    assert.strictEqual(result, 10);
  });

  test('infer closure parameter types in map call', async () => {
    // Use map's return value instead of mutable capture (which is a known limitation)
    const result = await compileAndRun(`
      let nums = #[1, 2, 3];
      export let main = () => {
        let doubled = nums.map((n) => n * 2);
        return doubled[0] + doubled[1] + doubled[2];
      };
    `);
    assert.strictEqual(result, 12); // 2 + 4 + 6
  });

  test('infer multiple closure parameters', async () => {
    const result = await compileAndRun(`
      let fold = (fn: (acc: i32, x: i32) => i32, init: i32, a: i32, b: i32) => fn(fn(init, a), b);
      export let main = () => fold((acc, x) => acc + x, 0, 3, 4);
    `);
    assert.strictEqual(result, 7);
  });

  test('explicit types override contextual typing', async () => {
    const result = await compileAndRun(`
      let apply = (fn: (x: i32) => i32, value: i32) => fn(value);
      export let main = () => apply((x: i32) => x + 1, 10);
    `);
    assert.strictEqual(result, 11);
  });

  test('infer closure parameter types with generic callee', async () => {
    // Use map's return value instead of mutable capture
    const result = await compileAndRun(`
      let arr = #[1, 2, 3, 4];
      export let main = () => {
        let doubled = arr.map((x) => x * 2);
        return doubled[0] + doubled[1] + doubled[2] + doubled[3];
      };
    `);
    assert.strictEqual(result, 20); // 2 + 4 + 6 + 8
  });
});
