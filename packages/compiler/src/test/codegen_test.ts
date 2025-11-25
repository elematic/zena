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
});
