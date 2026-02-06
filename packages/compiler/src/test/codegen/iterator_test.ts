import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('iterator', () => {
  test('Iterator and Iterable interfaces are accessible', async () => {
    const result = await compileAndRun(
      `
      import {Iterator, Iterable} from 'zena:iterator';
      
      // Just verify we can reference the types
      export let run = (): i32 => 42;
    `,
      'run',
    );
    assert.strictEqual(result, 42);
  });

  test('ArrayIterator iterates over array elements', async () => {
    const result = await compileAndRun(
      `
      import {Iterator} from 'zena:iterator';
      import {ArrayIterator} from 'zena:array-iterator';
      
      export let run = (): i32 => {
        let arr = #[10, 20, 30];
        let iter: Iterator<i32> = new ArrayIterator<i32>(arr);
        var sum = 0;
        while (let (true, item) = iter.next()) {
          sum = sum + item;
        }
        return sum;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 60);
  });

  test('empty array iteration', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        let arr = #[1, 2, 3];
        let empty = arr.slice(0, 0);  // Empty slice
        let iter = empty.iterator();
        var count = 0;
        while (let (true, _item) = iter.next()) {
          count = count + 1;
        }
        return count;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 0);
  });

  test('FixedArray implements Iterable', async () => {
    const result = await compileAndRun(
      `
      import {Iterator} from 'zena:iterator';
      
      export let run = (): i32 => {
        let arr = #[1, 2, 3, 4, 5];
        let iter = arr.iterator();
        var sum = 0;
        while (let (true, item) = iter.next()) {
          sum = sum + item;
        }
        return sum;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 15);
  });
});
