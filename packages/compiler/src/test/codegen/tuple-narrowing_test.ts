import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('tuple narrowing', () => {
  // Note: Checker supports narrowing for both boxed and unboxed tuples,
  // but codegen currently only supports unboxed tuples in if-let/while-let.
  // The narrowing logic works on TypeKind.Tuple and TypeKind.UnboxedTuple equally.

  test('while (let (true, elem) = ...) narrows elem from T | never to T', async () => {
    // Pattern (true, elem) against (true, i32) | (false, never) should narrow
    // elem to i32, not i32 | never. This is verified by using elem where
    // only i32 is accepted (arithmetic).
    const result = await compileAndRun(
      `
      class Counter {
        count: i32;
        
        #new() {
          this.count = 0;
        }
        
        next(): (true, i32) | (false, never) {
          if (this.count < 3) {
            let current = this.count;
            this.count = this.count + 1;
            return (true, current);
          }
          return (false, _);
        }
      }

      export let run = (): i32 => {
        let counter = new Counter();
        var sum = 0;
        while (let (true, elem) = counter.next()) {
          // elem should be narrowed to i32, not i32 | never
          // This arithmetic would fail type-checking if elem were a union
          sum = sum + elem * 2;
        }
        return sum; // 0*2 + 1*2 + 2*2 = 6
      };
    `,
      'run',
    );
    assert.strictEqual(result, 6);
  });

  test('if-let tuple pattern narrows second element', async () => {
    const result = await compileAndRun(
      `
      let getResult = (flag: boolean): (true, i32) | (false, never) => {
        if (flag) return (true, 42);
        return (false, _);
      };

      export let run = (): i32 => {
        // Use if-let to extract the value with narrowing
        // Calling function directly in condition to avoid codegen issue with locals
        if (let (true, value) = getResult(true)) {
          return value + 1;
        }
        return 0;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 43);
  });

  test('if (let (true, value) = ...) narrows value', async () => {
    const result = await compileAndRun(
      `
      let maybeValue = (flag: boolean): (true, i32) | (false, never) => {
        if (flag) return (true, 100);
        return (false, _);
      };

      export let run = (): i32 => {
        if (let (true, value) = maybeValue(true)) {
          return value * 2; // value should be i32, not i32 | never
        }
        return 0;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 200);
  });

  test('pattern with multiple literal positions', async () => {
    // Test narrowing with literals in multiple positions
    const result = await compileAndRun(
      `
      let data = (): (true, true, i32) | (true, false, never) | (false, never, never) => {
        return (true, true, 42);
      };

      export let run = (): i32 => {
        // Pattern (true, true, value) narrows to just (true, true, i32)
        // So value is i32, not i32 | never
        if (let (true, true, value) = data()) {
          return value;
        }
        return 0;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 42);
  });

  test('narrowing preserves non-never types', async () => {
    // When narrowing doesn't completely eliminate, union of remaining types is used
    const result = await compileAndRun(
      `
      let getNumber = (x: i32): (true, i32) | (true, i32) => {
        if (x > 0) return (true, x);
        return (true, 0);
      };

      export let run = (): i32 => {
        // Both variants have first element true, so narrowing keeps both
        // Second element is i32 | i32 = i32
        if (let (true, value) = getNumber(5)) {
          return value;
        }
        return 0;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 5);
  });

  test('boolean literal narrowing with false', async () => {
    const result = await compileAndRun(
      `
      let errorOrValue = (): (false, i32) | (true, never) => {
        return (false, 99);
      };

      export let run = (): i32 => {
        // Pattern (false, err) should narrow to just (false, i32)
        if (let (false, err) = errorOrValue()) {
          return err; // err should be i32, not i32 | never
        }
        return 0;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 99);
  });

  test('for-in loop works correctly', async () => {
    // For-in uses element type from Iterable<T>, not tuple narrowing directly
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
});
