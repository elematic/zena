import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';

suite('Stdlib: FixedArray Integration', () => {
  test('can call FixedArray methods on raw array<T> created via __array_new', async () => {
    const source = `
      import { FixedArray } from 'zena:array';
      
      export let run = (): i32 => {
        // Create a raw array<i32> using the intrinsic
        let arr = __array_new(3, 0);
        arr[0] = 1;
        arr[1] = 2;
        arr[2] = 3;
        
        // Call reverse() which is defined on FixedArray extension
        // This should work without casting if array<T> is treated as FixedArray
        let reversed = arr.reverse();
        
        if (reversed.length != 3) return 0;
        if (reversed[0] != 3) return 1;
        if (reversed[1] != 2) return 2;
        if (reversed[2] != 1) return 3;
        
        return 100;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });

  test('tuples are not arrays and do not have FixedArray methods', async () => {
    const source = `
      import { FixedArray } from 'zena:array';
      
      export let run = (): void => {
        let t = [1, 2, 3];
        // This should fail to compile because tuples don't have reverse()
        t.reverse();
      };
    `;

    try {
      await compileAndRun(source, 'run');
      assert.fail('Should have failed to compile');
    } catch (e: any) {
      // Expected error: Property access on non-class type '[i32, i32, i32]'
      assert.match(e.message, /Property access on non-class type/);
    }
  });

  test('can access property on raw array<T> via generic extension class with cast', async () => {
    const source = `
      extension class ArrayExt<T> on array<T> {
        first: T {
          get { return this[0]; }
        }
      }
      
      export let run = (): i32 => {
        let arr = __array_new(3, 0);
        arr[0] = 42;
        // Cast to ArrayExt to use its methods
        let ext = arr as ArrayExt<i32>;
        return ext.first;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 42);
  });
});
