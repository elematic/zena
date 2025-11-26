import {suite, test} from 'node:test';
import {compile} from '../../lib/index.js';
import assert from 'node:assert';

suite('CodeGenerator - Union Types', () => {
  test('should compile and run union variable with i32', async () => {
    const wasm = compile(`
      export let main = (): i32 => {
        let x: i32 | null = 10;
        return 1;
      };
    `);
    const result = (await WebAssembly.instantiate(wasm, {})) as any;
    const instance = result.instance;
    const main = instance.exports.main as Function;
    assert.strictEqual(main(), 1);
  });

  test('should compile and run union variable with null', async () => {
    const wasm = compile(`
      export let main = (): i32 => {
        let x: i32 | null = null;
        return 1;
      };
    `);
    const result = (await WebAssembly.instantiate(wasm, {})) as any;
    const instance = result.instance;
    const main = instance.exports.main as Function;
    assert.strictEqual(main(), 1);
  });
});
