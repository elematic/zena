import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('for-in loops', () => {
  test('basic for-in over array', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        let arr = #[10, 20, 30];
        var sum = 0;
        for (let x in arr) {
          sum = sum + x;
        }
        return sum;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 60);
  });

  test('for-in with empty array', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        let arr = #[1, 2, 3];
        let empty = arr.slice(0, 0);
        var count = 0;
        for (let x in empty) {
          count = count + 1;
        }
        return count;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 0);
  });

  test('for-in with single element', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        let arr = #[42];
        var result = 0;
        for (let x in arr) {
          result = x;
        }
        return result;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 42);
  });

  test('for-in with break', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        let arr = #[1, 2, 3, 4, 5];
        var sum = 0;
        for (let x in arr) {
          if (x > 3) {
            break;
          }
          sum = sum + x;
        }
        return sum;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 6); // 1 + 2 + 3
  });

  test('for-in with continue', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        let arr = #[1, 2, 3, 4, 5];
        var sum = 0;
        for (let x in arr) {
          if (x == 3) {
            continue;
          }
          sum = sum + x;
        }
        return sum;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 12); // 1 + 2 + 4 + 5
  });

  test('nested for-in loops', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        let outer = #[1, 2];
        let inner = #[10, 20];
        var sum = 0;
        for (let x in outer) {
          for (let y in inner) {
            sum = sum + x * y;
          }
        }
        return sum;
      };
    `,
      'run',
    );
    // (1*10 + 1*20) + (2*10 + 2*20) = 30 + 60 = 90
    assert.strictEqual(result, 90);
  });

  test('for-in with string array', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        let arr = #['hello', 'world'];
        var totalLen = 0;
        for (let s in arr) {
          totalLen = totalLen + s.length;
        }
        return totalLen;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 10); // 5 + 5
  });

  test('for-in with custom Iterable class', async () => {
    // Test that custom classes implementing Iterable work
    const result = await compileAndRun(
      `
      import { Iterator, Iterable } from 'zena:iterator';

      final class CounterIterator implements Iterator<i32> {
        #current: i32;
        #max: i32;
        
        #new(max: i32) {
          this.#current = 0;
          this.#max = max;
        }
        
        next(): (true, i32) | (false, never) {
          if (this.#current < this.#max) {
            let val = this.#current;
            this.#current = this.#current + 1;
            return (true, val);
          }
          return (false, _);
        }
      }

      final class Counter implements Iterable<i32> {
        #max: i32;
        
        #new(max: i32) {
          this.#max = max;
        }
        
        :Iterable.iterator(): Iterator<i32> {
          return new CounterIterator(this.#max);
        }
      }

      export let run = (): i32 => {
        let counter = new Counter(5);
        var sum = 0;
        for (let n in counter) {
          sum = sum + n;
        }
        return sum;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 10); // 0 + 1 + 2 + 3 + 4
  });

  test('for-in with polymorphic iterable (dynamic dispatch)', async () => {
    // Test that dynamic dispatch works when iterating over a base class variable
    // holding a derived class instance
    const result = await compileAndRun(
      `
      import { Iterator, Iterable } from 'zena:iterator';

      final class RangeIterator implements Iterator<i32> {
        #current: i32;
        #end: i32;
        
        #new(start: i32, end: i32) {
          this.#current = start;
          this.#end = end;
        }
        
        next(): (true, i32) | (false, never) {
          if (this.#current < this.#end) {
            let val = this.#current;
            this.#current = this.#current + 1;
            return (true, val);
          }
          return (false, _);
        }
      }

      // Non-final base class
      class BaseIterable implements Iterable<i32> {
        :Iterable.iterator(): Iterator<i32> {
          return new RangeIterator(0, 3);  // yields 0, 1, 2
        }
      }

      class DerivedIterable extends BaseIterable {
        :Iterable.iterator(): Iterator<i32> {
          return new RangeIterator(10, 13);  // yields 10, 11, 12
        }
      }

      export let run = (): i32 => {
        // Static type is BaseIterable, runtime type is DerivedIterable
        let iterable: BaseIterable = new DerivedIterable();
        var sum = 0;
        for (let n in iterable) {
          sum = sum + n;
        }
        return sum;
      };
    `,
      'run',
    );
    // Should call DerivedIterable.iterator() via dynamic dispatch
    assert.strictEqual(result, 33); // 10 + 11 + 12
  });
});
