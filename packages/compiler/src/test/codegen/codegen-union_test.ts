import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Union Types', () => {
  test('should compile and run union variable with Box<i32>', async () => {
    const source = `
      import { Box } from 'zena:box';
      export let main = (): i32 => {
        let x: Box<i32> | null = new Box(10);
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile and run union variable with null', async () => {
    const source = `
      import { Box } from 'zena:box';
      export let main = (): i32 => {
        let x: Box<i32> | null = null;
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
