/**
 * Test operator [] overloading with different parameter types
 */

import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen - Operator [] Overloading', () => {
  test('should support operator [] with i32 and BoundedRange types', async () => {
    // Test Container class with overloaded operator[]
    const result = await compileAndRun(
      `
      import { BoundedRange } from 'zena:range';
      
      class Container {
        #data: FixedArray<i32>;
        
        #new() {
          this.#data = #[10, 20, 30, 40, 50];
        }
        
        operator [](index: i32): i32 {
          return this.#data[index];
        }
        
        operator [](r: BoundedRange): FixedArray<i32> {
          return this.#data.slice(r.start, r.end);
        }
      }
      
      export let test = () => {
        let c = new Container();
        // Test i32 index access
        let val = c[2];
        // Test BoundedRange access
        let slice = c[1..4];
        // Return both results combined
        return val * 100 + slice.length;
      };
    `,
      'test',
    );

    // c[2] = 30 (third element)
    // c[1..4].length = 3 (elements at indices 1, 2, 3)
    // Result = 30 * 100 + 3 = 3003
    assert.strictEqual(result, 3003);
  });

  test('should support FixedArray with BoundedRange index (array literal)', async () => {
    const result = await compileAndRun(
      `
      export let test = () => {
        let arr = #[10, 20, 30, 40, 50];
        let slice = arr[1..4];
        return slice.length;
      };
    `,
      'test',
    );

    assert.strictEqual(result, 3);
  });

  test('should support FixedArray with BoundedRange index (explicit type)', async () => {
    const result = await compileAndRun(
      `
      export let test = () => {
        let arr = new FixedArray<i32>(5, 0);
        arr[0] = 10;
        arr[1] = 20;
        arr[2] = 30;
        arr[3] = 40;
        arr[4] = 50;
        let slice = arr[1..4];
        return slice.length;
      };
    `,
      'test',
    );

    assert.strictEqual(result, 3);
  });
});
