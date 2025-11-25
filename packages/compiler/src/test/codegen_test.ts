import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../lib/parser.js';
import {CodeGenerator} from '../lib/codegen.js';

async function compile(input: string) {
  const parser = new Parser(input);
  const ast = parser.parse();
  const codegen = new CodeGenerator(ast);
  const bytes = codegen.generate();
  const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer);
  return result.instance.exports;
}

suite('CodeGenerator', () => {
  test('should compile and run a simple add function', async () => {
    const input = 'export let add = (a: i32, b: i32) => a + b;';
    const {add} = (await compile(input)) as {
      add: (a: number, b: number) => number;
    };

    assert.strictEqual(add(10, 20), 30);
    assert.strictEqual(add(-5, 5), 0);
  });

  test('should compile and run a nested math expression', async () => {
    const input = 'export let calc = (a: i32, b: i32) => (a + b) * 2;';
    const {calc} = (await compile(input)) as {
      calc: (a: number, b: number) => number;
    };

    assert.strictEqual(calc(2, 3), 10); // (2 + 3) * 2 = 10
  });

  test('should compile and run a function with block body and return', async () => {
    const input = 'export let add = (a: i32, b: i32) => { return a + b; };';
    const {add} = (await compile(input)) as {
      add: (a: number, b: number) => number;
    };

    assert.strictEqual(add(10, 20), 30);
  });

  test('should compile and run a function with local variables', async () => {
    const input =
      'export let addOne = (a: i32) => { let x = 1; return a + x; };';
    const {addOne} = (await compile(input)) as {addOne: (a: number) => number};

    assert.strictEqual(addOne(10), 11);
  });

  test('should compile and run if statement', async () => {
    const input = `
      export let check = (a: i32) => {
        if (a > 10) {
          return 1;
        } else {
          return 0;
        }
        return 0;
      };
    `;
    const {check} = (await compile(input)) as {check: (a: number) => number};

    assert.strictEqual(check(11), 1);
    assert.strictEqual(check(10), 0);
    assert.strictEqual(check(5), 0);
  });

  test('should compile and run if statement without else', async () => {
    const input = `
      export let abs = (a: i32) => {
        if (a < 0) {
          return 0 - a;
        }
        return a;
      };
    `;
    const {abs} = (await compile(input)) as {abs: (a: number) => number};

    assert.strictEqual(abs(-10), 10);
    assert.strictEqual(abs(10), 10);
    assert.strictEqual(abs(-5), 5);
    assert.strictEqual(abs(0), 0);
  });

  test('should compile and run boolean literals', async () => {
    const input = `
      export let getTrue = () => {
        return true;
      };
      export let getFalse = () => {
        return false;
      };
    `;
    const {getTrue, getFalse} = (await compile(input)) as {
      getTrue: () => number;
      getFalse: () => number;
    };

    assert.strictEqual(getTrue(), 1);
    assert.strictEqual(getFalse(), 0);
  });

  test('should compile and run while loop with assignment', async () => {
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
  });
});
