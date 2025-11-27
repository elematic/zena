import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';

async function compile(input: string) {
  const parser = new Parser(input);
  const ast = parser.parse();
  const codegen = new CodeGenerator(ast);
  const bytes = codegen.generate();
  const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer);
  return result.instance.exports;
}

suite('CodeGenerator - While Loops', () => {
  test('should compile and run basic while loop', async () => {
    const input = `
      export let sum = (n: i32) => {
        var i = 0;
        var s = 0;
        while (i < n) {
          i = i + 1;
          s = s + i;
        }
        return s;
      };
    `;
    const {sum} = (await compile(input)) as {sum: (n: number) => number};
    assert.strictEqual(sum(5), 15); // 1+2+3+4+5 = 15
    assert.strictEqual(sum(0), 0);
    assert.strictEqual(sum(1), 1);
    assert.strictEqual(sum(10), 55); // 1+2+3+4+5+6+7+8+9+10 = 55
  });

  test('should compile and run while loop with counter', async () => {
    const input = `
      export let countTo = (n: i32) => {
        var i = 0;
        while (i < n) {
          i = i + 1;
        }
        return i;
      };
    `;
    const {countTo} = (await compile(input)) as {countTo: (n: number) => number};
    assert.strictEqual(countTo(5), 5);
    assert.strictEqual(countTo(0), 0);
    assert.strictEqual(countTo(100), 100);
  });

  test('should compile and run while loop with early return', async () => {
    const input = `
      export let findFirstMultipleOf3 = (start: i32, limit: i32) => {
        var i = start;
        while (i < limit) {
          if (i > 0) {
            var mod = i - (i / 3) * 3;
            if (mod == 0) {
              return i;
            }
          }
          i = i + 1;
        }
        return 0 - 1;
      };
    `;
    const {findFirstMultipleOf3} = (await compile(input)) as {
      findFirstMultipleOf3: (start: number, limit: number) => number;
    };
    assert.strictEqual(findFirstMultipleOf3(1, 10), 3);
    assert.strictEqual(findFirstMultipleOf3(4, 10), 6);
    assert.strictEqual(findFirstMultipleOf3(7, 10), 9);
    assert.strictEqual(findFirstMultipleOf3(10, 12), -1);
  });

  test('should compile and run nested while loops', async () => {
    const input = `
      export let nestedCount = (outer: i32, inner: i32) => {
        var total = 0;
        var i = 0;
        while (i < outer) {
          var j = 0;
          while (j < inner) {
            total = total + 1;
            j = j + 1;
          }
          i = i + 1;
        }
        return total;
      };
    `;
    const {nestedCount} = (await compile(input)) as {
      nestedCount: (outer: number, inner: number) => number;
    };
    assert.strictEqual(nestedCount(3, 4), 12); // 3*4 = 12
    assert.strictEqual(nestedCount(5, 5), 25); // 5*5 = 25
    assert.strictEqual(nestedCount(0, 10), 0);
    assert.strictEqual(nestedCount(10, 0), 0);
  });

  test('should compile and run factorial using while loop', async () => {
    const input = `
      export let factorial = (n: i32) => {
        var result = 1;
        var i = 2;
        while (i <= n) {
          result = result * i;
          i = i + 1;
        }
        return result;
      };
    `;
    const {factorial} = (await compile(input)) as {
      factorial: (n: number) => number;
    };
    assert.strictEqual(factorial(0), 1);
    assert.strictEqual(factorial(1), 1);
    assert.strictEqual(factorial(5), 120); // 1*2*3*4*5 = 120
    assert.strictEqual(factorial(6), 720);
  });

  test('should compile and run fibonacci using while loop', async () => {
    const input = `
      export let fib = (n: i32) => {
        if (n < 2) {
          return n;
        }
        var a = 0;
        var b = 1;
        var i = 2;
        while (i <= n) {
          var temp = a + b;
          a = b;
          b = temp;
          i = i + 1;
        }
        return b;
      };
    `;
    const {fib} = (await compile(input)) as {fib: (n: number) => number};
    assert.strictEqual(fib(0), 0);
    assert.strictEqual(fib(1), 1);
    assert.strictEqual(fib(2), 1);
    assert.strictEqual(fib(5), 5);
    assert.strictEqual(fib(10), 55);
  });

  test('should compile and run while loop with boolean condition', async () => {
    const input = `
      export let countWhileTrue = () => {
        var count = 0;
        var running = true;
        while (running) {
          count = count + 1;
          if (count >= 10) {
            running = false;
          }
        }
        return count;
      };
    `;
    const {countWhileTrue} = (await compile(input)) as {
      countWhileTrue: () => number;
    };
    assert.strictEqual(countWhileTrue(), 10);
  });

  test('should compile and run power function using while loop', async () => {
    const input = `
      export let power = (base: i32, exp: i32) => {
        var result = 1;
        var i = 0;
        while (i < exp) {
          result = result * base;
          i = i + 1;
        }
        return result;
      };
    `;
    const {power} = (await compile(input)) as {
      power: (base: number, exp: number) => number;
    };
    assert.strictEqual(power(2, 0), 1);
    assert.strictEqual(power(2, 1), 2);
    assert.strictEqual(power(2, 10), 1024);
    assert.strictEqual(power(3, 4), 81);
    assert.strictEqual(power(5, 3), 125);
  });
});
