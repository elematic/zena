import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Match Exhaustiveness', () => {
  function check(input: string) {
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
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
      let x: boolean = true;
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

  test('should pass for exhaustive enum match', () => {
    const input = `
      enum Color { Red, Green, Blue }
      let c: Color = Color.Red;
      match (c) {
        case Color.Red: "red"
        case Color.Green: "green"
        case Color.Blue: "blue"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 0);
  });

  test('should report error for non-exhaustive enum match', () => {
    const input = `
      enum Color { Red, Green, Blue }
      let c: Color = Color.Red;
      match (c) {
        case Color.Red: "red"
        case Color.Green: "green"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Non-exhaustive match/);
  });

  test('should pass for exhaustive enum match with custom values', () => {
    const input = `
      enum Status { Pending = 10, Active = 20, Complete = 30 }
      let s: Status = Status.Pending;
      match (s) {
        case Status.Pending: "pending"
        case Status.Active: "active"
        case Status.Complete: "complete"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 0);
  });

  test('should pass for enum match with wildcard', () => {
    const input = `
      enum Color { Red, Green, Blue }
      let c: Color = Color.Red;
      match (c) {
        case Color.Red: "red"
        case _: "other"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 0);
  });

  test('should report unreachable case after exhaustive enum cases', () => {
    const input = `
      enum Color { Red, Green, Blue }
      let c: Color = Color.Red;
      match (c) {
        case Color.Red: "red"
        case Color.Green: "green"
        case Color.Blue: "blue"
        case _: "unreachable"
      };
    `;
    const errors = check(input);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Unreachable case/);
  });

  test(
    'should pass for exhaustive enum in tuple',
    {skip: 'TODO: subtractType does not yet handle TuplePattern'},
    () => {
      const input = `
      enum Color { Red, Green }
      let t: [Color, i32] = [Color.Red, 1];
      match (t) {
        case [Color.Red, _]: "red"
        case [Color.Green, _]: "green"
      };
    `;
      const errors = check(input);
      assert.strictEqual(errors.length, 0);
    },
  );

  test(
    'should report error for non-exhaustive enum in tuple',
    {skip: 'TODO: subtractType does not yet handle TuplePattern'},
    () => {
      const input = `
      enum Color { Red, Green, Blue }
      let t: [Color, i32] = [Color.Red, 1];
      match (t) {
        case [Color.Red, _]: "red"
        case [Color.Green, _]: "green"
      };
    `;
      const errors = check(input);
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /Non-exhaustive match/);
    },
  );

  test(
    'should pass for exhaustive enum in record',
    {
      skip: 'TODO: Record exhaustiveness requires tracking partial field coverage',
    },
    () => {
      const input = `
      enum Status { Pending, Done }
      let r: {status: Status, value: i32} = {status: Status.Pending, value: 1};
      match (r) {
        case {status: Status.Pending}: "pending"
        case {status: Status.Done}: "done"
      };
    `;
      const errors = check(input);
      assert.strictEqual(errors.length, 0);
    },
  );

  test(
    'should report error for non-exhaustive enum in record',
    {
      skip: 'TODO: Record exhaustiveness requires tracking partial field coverage',
    },
    () => {
      const input = `
      enum Status { Pending, Active, Done }
      let r: {status: Status, value: i32} = {status: Status.Pending, value: 1};
      match (r) {
        case {status: Status.Pending}: "pending"
        case {status: Status.Done}: "done"
      };
    `;
      const errors = check(input);
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /Non-exhaustive match/);
    },
  );
});
