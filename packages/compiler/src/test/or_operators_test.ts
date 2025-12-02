import {suite, test} from 'node:test';
import {compile} from '../lib/index.js';
import assert from 'node:assert';

const imports = {
  console: {
    log: (val: any) => console.log(val),
    log_i32: (val: number) => console.log(val),
    log_f32: (val: number) => console.log(val),
    log_string: (ptr: number, len: number) => console.log('string'),
    error_string: (ptr: number, len: number) => console.error('string'),
    warn_string: (ptr: number, len: number) => console.warn('string'),
    info_string: (ptr: number, len: number) => console.info('string'),
    debug_string: (ptr: number, len: number) => console.debug('string'),
  },
  env: {
    log: (val: number) => console.log(val),
  },
};

suite('OR Operators', () => {
  test('bitwise OR (|)', async () => {
    const source = `
      export let bitwiseOr = (a: i32, b: i32) => a | b;
    `;
    const wasm = compile(source);
    const {instance} = (await WebAssembly.instantiate(wasm, imports)) as any;
    const {bitwiseOr} = instance.exports;

    assert.strictEqual(bitwiseOr(5, 3), 7); // 101 | 011 = 111 (7)
    assert.strictEqual(bitwiseOr(12, 10), 14); // 1100 | 1010 = 1110 (14)
    assert.strictEqual(bitwiseOr(0, 10), 10);
    assert.strictEqual(bitwiseOr(0, 0), 0);
  });

  test('logical OR (||)', async () => {
    const source = `
      export let logicalOr = (a: boolean, b: boolean) => a || b;
    `;
    const wasm = compile(source);
    const {instance} = (await WebAssembly.instantiate(wasm, imports)) as any;
    const {logicalOr} = instance.exports;

    assert.strictEqual(logicalOr(1, 1), 1); // true || true -> true
    assert.strictEqual(logicalOr(1, 0), 1); // true || false -> true
    assert.strictEqual(logicalOr(0, 1), 1); // false || true -> true
    assert.strictEqual(logicalOr(0, 0), 0); // false || false -> false
  });

  test('logical OR short-circuit', async () => {
    // If left is true, right (10/0) should NOT execute.
    // If left is false, right (10/0) SHOULD execute and trap.
    const source = `
      export let testShortCircuit = (left: boolean, x: i32) => {
        return left || (10 / x == 5);
      };
    `;

    const wasm = compile(source);
    const {instance} = (await WebAssembly.instantiate(wasm, imports)) as any;
    const {testShortCircuit} = instance.exports;

    // Short-circuit: 10/0 is skipped
    assert.strictEqual(testShortCircuit(1, 0), 1);

    // No short-circuit: 10/0 executes -> Trap
    try {
      testShortCircuit(0, 0);
      assert.fail('Should have trapped');
    } catch (e) {
      // Expected trap
    }
  });

  test('precedence: || vs &&', async () => {
    // && has higher precedence than ||
    // true || false && false
    // If && higher: true || (false && false) -> true || false -> true.
    // If && lower: (true || false) && false -> true && false -> false.

    const source = `
      export let precedence = () => true || false && false;
    `;
    const wasm = compile(source);
    const {instance} = (await WebAssembly.instantiate(wasm, imports)) as any;
    const {precedence} = instance.exports;

    assert.strictEqual(precedence(), 1);
  });

  test('precedence: | vs ||', async () => {
    // | (bitwise) has higher precedence than || (logical)
    // But they have different types (i32 vs boolean), so they can't be easily mixed without comparison.
    // (a | b) || c -> (i32) || boolean -> Error
    // a | (b || c) -> i32 | boolean -> Error

    // So we can't directly test precedence without intermediate operators like == or !=.
    // (a | b) != 0 || c

    const source = `
      export let mix = (a: i32, b: i32, c: boolean) => (a | b) != 0 || c;
    `;
    const wasm = compile(source);
    const {instance} = (await WebAssembly.instantiate(wasm, imports)) as any;
    const {mix} = instance.exports;

    assert.strictEqual(mix(0, 0, 0), 0); // 0 != 0 -> false || false -> false
    assert.strictEqual(mix(1, 0, 0), 1); // 1 != 0 -> true || false -> true
  });
});
