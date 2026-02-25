import {suite, test} from 'node:test';
import {strictEqual} from 'node:assert';
import {compileAndRun} from './utils.js';

suite('mutually recursive functions', () => {
  test('basic mutual recursion - even/odd', async () => {
    // Classic isEven/isOdd mutual recursion pattern
    const result = await compileAndRun(`
      let isEven = (n: i32): i32 => {
        if (n == 0) {
          return 1;
        }
        return isOdd(n - 1);
      };

      let isOdd = (n: i32): i32 => {
        if (n == 0) {
          return 0;
        }
        return isEven(n - 1);
      };

      export let main = (): i32 => {
        return isEven(10);
      };
    `);
    strictEqual(result, 1);
  });

  test('mutual recursion with three functions', async () => {
    const result = await compileAndRun(`
      let a = (x: i32): i32 => {
        if (x <= 0) { return 0; }
        return b(x - 1);
      };

      let b = (x: i32): i32 => {
        if (x <= 0) { return 0; }
        return c(x - 1);
      };

      let c = (x: i32): i32 => {
        if (x <= 0) { return 0; }
        return a(x - 1) + 1;
      };

      export let main = (): i32 => a(10);
    `);
    // a(10) -> b(9) -> c(8) -> a(7)+1 -> b(6)+1 -> c(5)+1 -> a(4)+2 -> b(3)+2 -> c(2)+2 -> a(1)+3 -> b(0)+3 = 3
    strictEqual(result, 3);
  });

  test('mutual recursion in nested scope', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let ping = (n: i32): i32 => {
          if (n <= 0) { return 0; }
          return pong(n - 1);
        };

        let pong = (n: i32): i32 => {
          if (n <= 0) { return 100; }
          return ping(n - 1);
        };

        return ping(5);
      };
    `);
    // ping(5) -> pong(4) -> ping(3) -> pong(2) -> ping(1) -> pong(0) = 100
    strictEqual(result, 100);
  });
});
