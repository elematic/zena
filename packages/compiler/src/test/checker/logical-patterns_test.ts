import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Logical Patterns', () => {
  test('should allow valid OR pattern with consistent bindings', () => {
    const input = `
      let x = match (10) {
        case (10 as a) | (20 as a): a
        case _: 0
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should fail when OR pattern has disjoint bindings (left has extra)', () => {
    const input = `
      let x = match (10) {
        case (10 as a) | 20: 0
        case _: 0
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Variable 'a' is bound in the left branch/);
  });

  test('should fail when OR pattern has disjoint bindings (right has extra)', () => {
    const input = `
      let x = match (10) {
        case 10 | (20 as a): 0
        case _: 0
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Variable 'a' is bound in the right branch/,
    );
  });

  test('should fail when OR pattern has different variables', () => {
    const input = `
      let x = match (10) {
        case (10 as a) | (20 as b): 0
        case _: 0
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    // Should report two errors: 'a' missing in right, 'b' missing in left
    assert.strictEqual(errors.length, 2);
    assert.match(errors[0].message, /Variable 'a' is bound in the left branch/);
    assert.match(
      errors[1].message,
      /Variable 'b' is bound in the right branch/,
    );
  });

  test('should allow valid AND pattern with cumulative bindings', () => {
    const input = `
      class Point { x: i32; y: i32; #new(x: i32, y: i32) { this.x = x; this.y = y; } }
      let p = new Point(1, 2);
      let r = match (p) {
        case Point { x } & Point { y }: x + y
        case _: 0
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should fail when OR pattern has disjoint bindings in record patterns', () => {
    const input = `
      type Rec = {x: i32, y: i32};
      let r: Rec = {x: 1, y: 2};
      let res = match (r) {
        case {x} | {y}: 0
        case _: 0
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 2);
    assert.match(errors[0].message, /Variable 'x' is bound in the left branch/);
    assert.match(
      errors[1].message,
      /Variable 'y' is bound in the right branch/,
    );
  });
});
