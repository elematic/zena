import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

suite('OR Operators', () => {
  test('bitwise OR (|)', async () => {
    const source = `
      export let bitwiseOr = (a: i32, b: i32) => a | b;
    `;
    const {bitwiseOr} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseOr(5, 3), 7); // 101 | 011 = 111 (7)
    assert.strictEqual(bitwiseOr(12, 10), 14); // 1100 | 1010 = 1110 (14)
    assert.strictEqual(bitwiseOr(0, 10), 10);
    assert.strictEqual(bitwiseOr(0, 0), 0);
  });

  test('logical OR (||)', async () => {
    const source = `
      export let logicalOr = (a: boolean, b: boolean) => a || b;
    `;
    const {logicalOr} = await compileAndInstantiate(source);

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

    const {testShortCircuit} = await compileAndInstantiate(source);

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
    const {precedence} = await compileAndInstantiate(source);

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
    const {mix} = await compileAndInstantiate(source);

    assert.strictEqual(mix(0, 0, 0), 0); // 0 != 0 -> false || false -> false
    assert.strictEqual(mix(1, 0, 0), 1); // 1 != 0 -> true || false -> true
  });
});
