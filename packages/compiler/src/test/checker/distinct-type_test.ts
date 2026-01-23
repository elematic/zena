import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Distinct Types', () => {
  test('should allow distinct type alias', () => {
    const input = `
      distinct type ID = string;
      let x: ID = 'hello' as ID;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should prevent assignment of underlying type to distinct type', () => {
    const input = `
      distinct type ID = string;
      let x: ID = 'hello';
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch: expected ID, got String/);
  });

  test('should prevent assignment of distinct type to underlying type', () => {
    const input = `
      distinct type ID = string;
      let id: ID = 'hello' as ID;
      let s: string = id;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch: expected String, got ID/);
  });

  test('should allow assignment between same distinct types', () => {
    const input = `
      distinct type ID = string;
      let a: ID = 'a' as ID;
      let b: ID = a;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should prevent assignment between different distinct types', () => {
    const input = `
      distinct type ID1 = string;
      distinct type ID2 = string;
      let a: ID1 = 'a' as ID1;
      let b: ID2 = a;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch: expected ID2, got ID1/);
  });

  test('should support generic distinct types', () => {
    const input = `
      distinct type Box<T> = T;
      let a: Box<i32> = 1 as Box<i32>;
      let b: Box<i32> = a;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should prevent assignment between different generic instantiations of distinct type', () => {
    const input = `
      distinct type Box<T> = T;
      let a: Box<i32> = 1 as Box<i32>;
      let b: Box<f32> = a;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    // Error message might be confusing because we print name only?
    // "Type 'Box' is not assignable to type 'Box'"
    // We should improve typeToString for distinct types.
  });
});
