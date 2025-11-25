import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../lib/parser.js';
import {CodeGenerator} from '../lib/codegen.js';

suite('CodeGenerator', () => {
  test('should compile and run a simple add function', async () => {
    const input = 'export let add = (a: i32, b: i32) => a + b;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const codegen = new CodeGenerator(ast);
    const bytes = codegen.generate();

    const result = await WebAssembly.instantiate(bytes);
    // @ts-ignore
    const add = result.instance.exports.add as (a: number, b: number) => number;

    assert.strictEqual(add(10, 20), 30);
    assert.strictEqual(add(-5, 5), 0);
  });

  test('should compile and run a nested math expression', async () => {
    const input = 'export let calc = (a: i32, b: i32) => (a + b) * 2;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const codegen = new CodeGenerator(ast);
    const bytes = codegen.generate();

    const result = await WebAssembly.instantiate(bytes);
    // @ts-ignore
    const calc = result.instance.exports.calc as (
      a: number,
      b: number,
    ) => number;

    assert.strictEqual(calc(2, 3), 10); // (2 + 3) * 2 = 10
  });

  test('should compile and run a function with block body and return', async () => {
    const input = 'export let add = (a: i32, b: i32) => { return a + b; };';
    const parser = new Parser(input);
    const ast = parser.parse();

    const codegen = new CodeGenerator(ast);
    const bytes = codegen.generate();

    const result = await WebAssembly.instantiate(bytes);
    // @ts-ignore
    const add = result.instance.exports.add as (a: number, b: number) => number;

    assert.strictEqual(add(10, 20), 30);
  });

  test('should compile and run a function with local variables', async () => {
    const input =
      'export let addOne = (a: i32) => { let x = 1; return a + x; };';
    const parser = new Parser(input);
    const ast = parser.parse();

    const codegen = new CodeGenerator(ast);
    const bytes = codegen.generate();

    const result = await WebAssembly.instantiate(bytes);
    // @ts-ignore
    const addOne = result.instance.exports.addOne as (a: number) => number;

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
    const parser = new Parser(input);
    const ast = parser.parse();

    const codegen = new CodeGenerator(ast);
    const bytes = codegen.generate();

    const result = await WebAssembly.instantiate(bytes);
    // @ts-ignore
    const check = result.instance.exports.check as (a: number) => number;

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
    const parser = new Parser(input);
    const ast = parser.parse();

    const codegen = new CodeGenerator(ast);
    const bytes = codegen.generate();

    const result = await WebAssembly.instantiate(bytes);
    // @ts-ignore
    const abs = result.instance.exports.abs as (a: number) => number;

    assert.strictEqual(abs(-10), 10);
    assert.strictEqual(abs(10), 10);
    assert.strictEqual(abs(0), 0);
  });
});
