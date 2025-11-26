import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker.js';

import type {Diagnostic} from '../../lib/diagnostics.js';

suite('TypeChecker - Arrays', () => {
  function check(source: string): Diagnostic[] {
    const parser = new Parser(source);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    return checker.check();
  }

  test('should check valid array literal', () => {
    const errors = check(`
      let arr = #[1, 2, 3];
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('should detect mixed types in array literal', () => {
    const errors = check(`
      let arr = #[1, "hello"];
    `);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Array elements must be of the same type/);
  });

  test('should check valid index access', () => {
    const errors = check(`
      let arr = #[1, 2, 3];
      let x = arr[0];
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('should detect invalid index type', () => {
    const errors = check(`
      let arr = #[1, 2, 3];
      let x = arr["0"];
    `);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Array index must be i32/);
  });

  test('should detect index access on non-array', () => {
    const errors = check(`
      let x = 10;
      let y = x[0];
    `);
    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Index expression only supported on arrays/,
    );
  });

  test('should allow operation with array element of correct type', () => {
    const errors = check(`
      let arr = #[1, 2, 3];
      let sum = 10 + arr[0];
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('should detect type mismatch with array element', () => {
    const errors = check(`
      let arr = #["a", "b"];
      let sum = 10 + arr[0];
    `);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });
});
