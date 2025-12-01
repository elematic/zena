import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';

suite('Stdlib: FixedArray', () => {
  test('constructor with length (default values)', async () => {
    const source = `
      import { FixedArray } from 'zena:array';
      export let run = (): i32 => {
        let arr = new FixedArray<i32>(10, 0);
        return arr.length;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 10);
  });

  test('constructor with length and initial value', async () => {
    const source = `
      import { FixedArray } from 'zena:array';
      export let run = (): i32 => {
        let arr = new FixedArray<i32>(5, 42);
        return arr[0];
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 42);
  });
});
