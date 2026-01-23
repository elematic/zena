import assert from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';

suite('TypeChecker: Function Types', () => {
  test('checks variable with function type', () => {
    const input = 'let f: (a: i32) => i32 = (x: i32) => x;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 0);
  });

  test('detects parameter type mismatch', () => {
    const input = 'let f: (a: i32) => i32 = (x: boolean) => 1;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });

  test('detects return type mismatch', () => {
    // (x: i32) => boolean is not assignable to (a: i32) => i32
    const input = 'let f: (a: i32) => i32 = (x: i32) => true;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });

  test('infers return type', () => {
    const input = 'let f: (a: i32) => i32 = (x: i32) => x + 1;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 0);
  });
});
