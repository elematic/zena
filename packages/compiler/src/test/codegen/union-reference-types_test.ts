import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Union Reference Types', () => {
  test('array union with string should compile', async () => {
    const source = `
      export let main = (): i32 => {
        let x: array<i32> | string = #[1, 2, 3];
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('tuple union with class should compile', async () => {
    const source = `
      class Box { value: i32; #new(v: i32) { this.value = v; } }

      export let main = (): i32 => {
        let x: [i32, string] | Box = [1, 'hello'];
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('record union with class should compile', async () => {
    const source = `
      class Point { x: i32; y: i32; #new(x: i32, y: i32) { this.x = x; this.y = y; } }

      export let main = (): i32 => {
        let x: { a: i32, b: string } | Point = { a: 1, b: 'hello' };
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('ByteArray union with string should compile', async () => {
    const source = `
      export let main = (): i32 => {
        let x: ByteArray | string = 'hello';
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
