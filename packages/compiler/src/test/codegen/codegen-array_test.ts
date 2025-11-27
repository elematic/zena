import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from '../../lib/index.js';

suite('CodeGenerator - Arrays', () => {
  test('should compile and run array literal and index access', async () => {
    const source = `
      export let main = (): i32 => {
        let arr = #[10, 20, 30];
        return arr[1];
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 20);
  });

  test('should compile and run array assignment', async () => {
    const source = `
      export let main = (): i32 => {
        let arr = #[10, 20, 30];
        arr[1] = 50;
        return arr[1];
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 50);
  });

  test('should trap on out-of-bounds access', async () => {
    const source = `
      export let main = (): i32 => {
        let arr = #[10, 20, 30];
        return arr[5];
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    assert.throws(() => {
      (module.instance.exports.main as Function)();
    }, /out of bounds/);
  });

  test('should support explicit Array type', async () => {
    const source = `
      export let main = (): i32 => {
        let arr: Array<i32> = #[10, 20, 30];
        return arr.length;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 3);
  });
});
