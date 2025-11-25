import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../lib/parser.js';
import {TypeChecker} from '../lib/checker.js';

suite('TypeChecker', () => {
  test('should check variable declaration', () => {
    const input = 'let x = 1;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should detect undefined variables', () => {
    const input = 'let x = y;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Variable 'y' not found/);
  });

  test('should check binary expression types', () => {
    const input = 'let x = 1 + 2;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should detect type mismatch in binary expression', () => {
    // Assuming we had a boolean type literal or something to produce a mismatch easily.
    // Since we only have numbers and strings literals implemented in parser/lexer fully for now...
    // Let's try adding a string to a number if we support string literals.
    // Lexer supports strings. Parser supports strings.

    const input = "let x = 1 + 'hello';";
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Type mismatch/);
  });

  test('should check arrow function', () => {
    const input = 'let add = (a: i32, b: i32) => a + b;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should detect shadowing or redeclaration', () => {
    const input = 'let x = 1; let x = 2;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /already declared/);
  });

  test('should detect type mismatch between i32 and f32', () => {
    const input = 'let add = (a: i32, b: f32) => a + b;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Type mismatch/);
  });

  test('should check arrow function with block body and return', () => {
    const input = 'let add = (a: i32, b: i32): i32 => { return a + b; };';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should detect return type mismatch in block body', () => {
    const input = "let add = (a: i32, b: i32): i32 => { return 'hello'; };";
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Type mismatch/);
  });
});
