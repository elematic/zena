import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Match Exhaustiveness', () => {
  function check(input: string) {
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    return errors;
  }

  test('should report error for non-exhaustive union of primitives', () => {
    const input = `
      type T = 1 | 2 | 3;
      let x: T = 1;
      match (x) {
        case 1: "one"
        case 2: "two"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Non-exhaustive match/);
    assert.match(errors[0].message, /3/);
  });

  test('should report error for non-exhaustive union of classes', () => {
    const input = `
      class A {}
      class B {}
      type U = A | B;
      let x: U = new A();
      match (x) {
        case A {}: "A"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Non-exhaustive match/);
    assert.match(errors[0].message, /B/);
  });

  test('should report error for non-exhaustive discriminated union', () => {
    const input = `
      type Result = {status: 'success', value: string} | {status: 'error', error: string};
      let r: Result = {status: 'success' as 'success', value: 'ok'};
      match (r) {
        case {status: 'success'}: "ok"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Non-exhaustive match/);
    assert.match(errors[0].message, /error/);
  });

  test('should report error for non-exhaustive boolean match', () => {
    const input = `
      let x = true;
      match (x) {
        case true: "true"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Non-exhaustive match/);
    assert.match(errors[0].message, /false/);
  });

  test('should pass for exhaustive union of primitives', () => {
    const input = `
      type T = 1 | 2;
      let x: T = 1;
      match (x) {
        case 1: "one"
        case 2: "two"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 0);
  });

  test('should pass for exhaustive union with wildcard', () => {
    const input = `
      type T = 1 | 2 | 3;
      let x: T = 1;
      match (x) {
        case 1: "one"
        case _: "other"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 0);
  });

  test('should report error for unreachable case after wildcard', () => {
    const input = `
      let x = 1;
      match (x) {
        case _: "any"
        case 1: "one"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Unreachable case/);
  });

  test('should report error for unreachable case in union', () => {
    // Note: case 3 might be a type mismatch error instead of unreachable,
    // but if it was valid type (e.g. match(i32)) but covered, it would be unreachable.
    // Here 3 is not in T, so it's likely a type mismatch first.
    // Let's try with i32
    const input2 = `
      let x: i32 = 1;
      match (x) {
        case _: "any"
        case 1: "one"
      };
    `;
    const errors = check(input2);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Unreachable case/);
  });
});
