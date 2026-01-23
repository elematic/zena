import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - For Loops', () => {
  test('should check valid for loop', () => {
    const input = `
      let main = () => {
        for (var i = 0; i < 10; i = i + 1) {
          i;
        }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should detect non-boolean condition in for loop', () => {
    const input = `
      let main = () => {
        for (var i = 0; i; i = i + 1) {
          i;
        }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Expected boolean condition in for statement/,
    );
  });

  test('should scope loop variable to for block', () => {
    const input = `
      let main = () => {
        for (var i = 0; i < 10; i = i + 1) {
          i;
        }
        i;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Variable 'i' not found/);
  });

  test('should allow empty for loop parts', () => {
    const input = `
      let main = () => {
        var i = 0;
        for (; i < 10; i = i + 1) {
          i;
        }
        return i;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should check nested for loops', () => {
    const input = `
      let main = () => {
        for (var i = 0; i < 10; i = i + 1) {
          for (var j = 0; j < 10; j = j + 1) {
            i;
            j;
          }
        }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should check for loop with expression init', () => {
    const input = `
      let main = () => {
        var i = 0;
        for (i = 5; i < 10; i = i + 1) {
          i;
        }
        return i;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });
});
