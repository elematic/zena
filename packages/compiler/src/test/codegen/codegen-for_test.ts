import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

suite('CodeGenerator - For Loops', () => {
  test('should compile and run basic for loop', async () => {
    const input = `
      export let sum = (n: i32) => {
        var s = 0;
        for (var i = 0; i < n; i = i + 1) {
          s = s + i;
        }
        return s;
      };
    `;
    const {sum} = (await compileAndInstantiate(input)) as {
      sum: (n: number) => number;
    };
    assert.strictEqual(sum(5), 10); // 0+1+2+3+4 = 10
    assert.strictEqual(sum(0), 0);
    assert.strictEqual(sum(1), 0);
    assert.strictEqual(sum(10), 45); // 0+1+2+3+4+5+6+7+8+9 = 45
  });

  test('should compile and run for loop without init', async () => {
    const input = `
      export let countUp = (n: i32) => {
        var i = 0;
        for (; i < n; i = i + 1) {
          // empty body
        }
        return i;
      };
    `;
    const {countUp} = (await compileAndInstantiate(input)) as {
      countUp: (n: number) => number;
    };
    assert.strictEqual(countUp(5), 5);
    assert.strictEqual(countUp(0), 0);
  });

  test('should compile and run for loop without test (infinite loop with break)', async () => {
    // This test uses early return to break out of infinite loop
    const input = `
      export let countTo = (n: i32) => {
        var s = 0;
        for (var i = 0; ; i = i + 1) {
          if (i >= n) {
            return s;
          }
          s = s + i;
        }
        return s;
      };
    `;
    const {countTo} = (await compileAndInstantiate(input)) as {
      countTo: (n: number) => number;
    };
    assert.strictEqual(countTo(5), 10);
    assert.strictEqual(countTo(0), 0);
  });

  test('should compile and run for loop without update', async () => {
    const input = `
      export let sumWithIncrementInBody = (n: i32) => {
        var s = 0;
        for (var i = 0; i < n;) {
          s = s + i;
          i = i + 1;
        }
        return s;
      };
    `;
    const {sumWithIncrementInBody} = (await compileAndInstantiate(input)) as {
      sumWithIncrementInBody: (n: number) => number;
    };
    assert.strictEqual(sumWithIncrementInBody(5), 10);
    assert.strictEqual(sumWithIncrementInBody(0), 0);
  });

  test('should compile and run nested for loops', async () => {
    const input = `
      export let nestedSum = (n: i32) => {
        var s = 0;
        for (var i = 0; i < n; i = i + 1) {
          for (var j = 0; j < n; j = j + 1) {
            s = s + 1;
          }
        }
        return s;
      };
    `;
    const {nestedSum} = (await compileAndInstantiate(input)) as {
      nestedSum: (n: number) => number;
    };
    assert.strictEqual(nestedSum(3), 9); // 3*3 = 9
    assert.strictEqual(nestedSum(5), 25); // 5*5 = 25
    assert.strictEqual(nestedSum(0), 0);
  });

  test('should compile and run for loop with expression init', async () => {
    const input = `
      export let startFrom = (start: i32, end: i32) => {
        var i = 0;
        var s = 0;
        for (i = start; i < end; i = i + 1) {
          s = s + i;
        }
        return s;
      };
    `;
    const {startFrom} = (await compileAndInstantiate(input)) as {
      startFrom: (start: number, end: number) => number;
    };
    assert.strictEqual(startFrom(0, 5), 10); // 0+1+2+3+4 = 10
    assert.strictEqual(startFrom(3, 6), 12); // 3+4+5 = 12
    assert.strictEqual(startFrom(5, 5), 0);
  });

  test('should compile and run factorial using for loop', async () => {
    const input = `
      export let factorial = (n: i32) => {
        var result = 1;
        for (var i = 2; i <= n; i = i + 1) {
          result = result * i;
        }
        return result;
      };
    `;
    const {factorial} = (await compileAndInstantiate(input)) as {
      factorial: (n: number) => number;
    };
    assert.strictEqual(factorial(0), 1);
    assert.strictEqual(factorial(1), 1);
    assert.strictEqual(factorial(5), 120); // 1*2*3*4*5 = 120
    assert.strictEqual(factorial(6), 720);
  });

  test('should compile and run fibonacci using for loop', async () => {
    const input = `
      export let fib = (n: i32) => {
        if (n < 2) {
          return n;
        }
        var a = 0;
        var b = 1;
        for (var i = 2; i <= n; i = i + 1) {
          var temp = a + b;
          a = b;
          b = temp;
        }
        return b;
      };
    `;
    const {fib} = (await compileAndInstantiate(input)) as {
      fib: (n: number) => number;
    };
    assert.strictEqual(fib(0), 0);
    assert.strictEqual(fib(1), 1);
    assert.strictEqual(fib(2), 1);
    assert.strictEqual(fib(5), 5);
    assert.strictEqual(fib(10), 55);
  });
});
