import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Mixed Arithmetic Codegen', () => {
  test('should add i32 and f32', async () => {
    const source = `
      export let main = () => {
        return 1 + 2.5;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 3.5);
  });

  test('should multiply i32 and f32', async () => {
    const source = `
      export let main = () => {
        return 2 * 2.5;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 5.0);
  });

  test('should multiply f32 and i32', async () => {
    const source = `
      export let main = () => {
        return 2.5 * 2;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 5.0);
  });

  test('should compare i32 and f32', async () => {
    const source = `
      export let main = () => {
        if (1 < 2.5) {
          return 1;
        } else {
          return 0;
        }
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should handle complex expression', async () => {
    const source = `
      export let main = () => {
        return (1 + 2) * 2.5;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 7.5);
  });
});
