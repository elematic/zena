import assert from 'node:assert';
import {suite, test} from 'node:test';
import {WasmModule} from '../lib/emitter.js';
import {ValType, Opcode, ExportDesc} from '../lib/wasm.js';

suite('WasmEmitter', () => {
  test('should emit a valid empty module', async () => {
    const module = new WasmModule();
    const bytes = module.toBytes();

    // Magic (00 61 73 6d) + Version (01 00 00 00)
    assert.deepStrictEqual(
      Array.from(bytes),
      [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    );

    const result = await WebAssembly.instantiate(bytes);
    // @ts-ignore
    assert.ok(result.instance);
  });

  test('should emit a module with an exported add function', async () => {
    const module = new WasmModule();

    // (param i32 i32) (result i32)
    const typeIndex = module.addType(
      [[ValType.i32], [ValType.i32]],
      [[ValType.i32]],
    );

    const funcIndex = module.addFunction(typeIndex);

    module.addExport('add', ExportDesc.Func, funcIndex);

    // local.get 0
    // local.get 1
    // i32.add
    // end
    module.addCode(
      funcIndex,
      [],
      [Opcode.local_get, 0, Opcode.local_get, 1, Opcode.i32_add, Opcode.end],
    );

    const bytes = module.toBytes();
    const result = await WebAssembly.instantiate(bytes);

    // @ts-ignore
    const add = result.instance.exports['add'] as (
      a: number,
      b: number,
    ) => number;
    assert.strictEqual(add(10, 20), 30);
  });
});
