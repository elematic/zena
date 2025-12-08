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

  test('map', async () => {
    const source = `
      export let run = (): i32 => {
        let arr = new FixedArray<i32>(3, 0);
        arr[0] = 1;
        arr[1] = 2;
        arr[2] = 3;
        let mapped: FixedArray<i32> = arr.map<i32>((x: i32) => x * 2);
        
        if (mapped.length != 3) return 0;
        if (mapped[0] != 2) return 1;
        if (mapped[1] != 4) return 2;
        if (mapped[2] != 6) return 3;
        
        return 100;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });

  test('map with index', async () => {
    const source = `
      export let run = (): i32 => {
        let arr = new FixedArray<i32>(3, 0);
        // map to just the index
        let mapped = arr.map<i32>((x: i32, i: i32) => i);
        
        if (mapped[0] != 0) return 1;
        if (mapped[1] != 1) return 2;
        if (mapped[2] != 2) return 3;
        
        return 100;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });

  test('map with array argument', async () => {
    const source = `
      import { FixedArray, Sequence } from 'zena:array';

      export let run = (): i32 => {
        let arr = new FixedArray<i32>(1, 10);
        
        // Use the array argument to modify the array itself
        // We capture 'arr' instead of using 'a' because 'a' is read-only Sequence
        // and downcasting Sequence to MutableSequence is not supported for arrays at runtime
        arr.map<i32>((x: i32, i: i32, a: Sequence<i32>) => {
          arr[0] = 999;
          return x;
        });
        
        if (arr[0] != 999) return 1;
        
        return 100;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });
});
