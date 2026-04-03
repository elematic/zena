import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Compound Assignment Operators', () => {
  test('+= with i32', async () => {
    const source = `
      export let test = (): i32 => {
        var x: i32 = 10;
        x += 5;
        return x;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 15);
  });

  test('-= with i32', async () => {
    const source = `
      export let test = (): i32 => {
        var x: i32 = 10;
        x -= 3;
        return x;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 7);
  });

  test('*= with i32', async () => {
    const source = `
      export let test = (): i32 => {
        var x: i32 = 6;
        x *= 7;
        return x;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 42);
  });

  test('%= with i32', async () => {
    const source = `
      export let test = (): i32 => {
        var x: i32 = 10;
        x %= 3;
        return x;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 1);
  });

  test('+= in a loop', async () => {
    const source = `
      export let test = (): i32 => {
        var sum: i32 = 0;
        for (var i = 1; i <= 10; i += 1) {
          sum += i;
        }
        return sum;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 55);
  });

  test('multiple compound assignments', async () => {
    const source = `
      export let test = (): i32 => {
        var x: i32 = 100;
        x += 10;
        x -= 20;
        x *= 2;
        x %= 7;
        return x;
      };
    `;
    // 100 + 10 = 110
    // 110 - 20 = 90
    // 90 * 2 = 180
    // 180 % 7 = 5
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 5);
  });

  test('+= with class field', async () => {
    const source = `
      class Counter {
        var count: i32 = 0;
        new() {}
        increment(n: i32): void {
          this.count += n;
        }
      }
      export let test = (): i32 => {
        let c = new Counter();
        c.increment(5);
        c.increment(3);
        return c.count;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 8);
  });

  test('+= with array index', async () => {
    const source = `
      export let test = (): i32 => {
        let arr = [1, 2, 3];
        arr[0] += 10;
        arr[1] += 20;
        return arr[0] + arr[1] + arr[2];
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 36); // 11 + 22 + 3
  });
});
