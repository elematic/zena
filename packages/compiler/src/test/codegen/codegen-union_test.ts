import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Union Types', () => {
  test('should compile and run union variable with i32', async () => {
    const source = `
      export let main = (): i32 => {
        let x: i32 | null = 10;
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile and run union variable with null', async () => {
    const source = `
      export let main = (): i32 => {
        let x: i32 | null = null;
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
