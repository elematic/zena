import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('AnyRef Checker', () => {
  test('should allow assigning reference types to anyref', () => {
    const input = `
      let s: string = "hello";
      let a: anyref = s;
      let b: anyref = null;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should not allow assigning i32 to anyref', () => {
    const input = `
      let a: anyref = 123;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });

  test('should not allow assigning f32 to anyref', () => {
    const input = `
      let f: f32 = 1.0;
      let a: anyref = f;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });

  test('should not allow assigning boolean to anyref', () => {
    const input = `
      let b: boolean = true;
      let a: anyref = b;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });
});
