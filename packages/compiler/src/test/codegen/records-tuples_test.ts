import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from '../../lib/index.js';

suite('CodeGenerator - Records and Tuples', () => {
  test('should compile and run record literal and access', async () => {
    const source = `
      export let main = (): i32 => {
        let p = { x: 10, y: 20 };
        return p.x + p.y;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 30);
  });

  test('should compile and run tuple literal and access', async () => {
    const source = `
      export let main = (): i32 => {
        let t = [10, 20];
        return t[0] + t[1];
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 30);
  });

  test('should handle nested records', async () => {
    const source = `
      export let main = (): i32 => {
        let r = { a: { b: 10 } };
        return r.a.b;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 10);
  });

  test('should handle mixed records and tuples', async () => {
    const source = `
      export let main = (): i32 => {
        let x = { a: [10, 20] };
        return x.a[1];
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 20);
  });

  test('should canonicalize record types (binary size check)', async () => {
    // Program 1: Two distinct record shapes (different field names)
    // This should generate TWO struct types in the WASM binary.
    const sourceDistinct = `
      export let main = (): void => {
        let p1 = { a: 10, b: 20 };
        let p2 = { c: 30, d: 40 };
      };
    `;
    const wasmDistinct = compile(sourceDistinct);

    // Program 2: Two identical record shapes (same field names, different order)
    // This should generate ONE struct type in the WASM binary due to canonicalization.
    const sourceShared = `
      export let main = (): void => {
        let p1 = { a: 10, b: 20 };
        let p2 = { b: 40, a: 30 };
      };
    `;
    const wasmShared = compile(sourceShared);

    // The shared version should be smaller because it has fewer type definitions.
    assert.ok(
      wasmShared.length < wasmDistinct.length,
      `Expected shared types binary (${wasmShared.length}) to be smaller than distinct types binary (${wasmDistinct.length})`,
    );
  });
});
