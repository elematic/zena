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

  test('reverse', async () => {
    const source = `
        export let run = (): i32 => {
          let arr = new FixedArray<i32>(3, 0);
          arr[0] = 1;
          arr[1] = 2;
          arr[2] = 3;
          let reversed = arr.reverse();
          
          if (reversed.length != 3) return 0;
          if (reversed[0] != 3) return 1;
          if (reversed[1] != 2) return 2;
          if (reversed[2] != 1) return 3;
          
          // Check original is unchanged
          if (arr[0] != 1) return 4;
          
          return 100;
        };
      `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });
});
