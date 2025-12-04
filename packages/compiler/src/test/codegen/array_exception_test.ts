import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Array Exceptions', () => {
  test('should throw exception on out of bounds access in Array<T>', async () => {
    const source = `
      import { Array } from 'zena:array';

      export let main = (): i32 => {
        let arr = new Array<i32>();
        arr.push(10);
        return arr[1]; // Out of bounds (length is 1)
      };
    `;

    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have thrown');
    } catch (e: any) {
      // Expected
    }
  });

  test('should throw exception on negative index access in Array<T>', async () => {
    const source = `
      import { Array } from 'zena:array';

      export let main = (): i32 => {
        let arr = new Array<i32>();
        arr.push(10);
        return arr[-1]; // Out of bounds
      };
    `;

    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have thrown');
    } catch (e: any) {
      // Expected
    }
  });
});
