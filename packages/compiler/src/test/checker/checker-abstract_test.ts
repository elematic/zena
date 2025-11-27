import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('Checker - Abstract Classes', () => {
  test('should check valid abstract class', () => {
    const input = `
      abstract class Shape {
        abstract area(): i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should detect abstract method in concrete class', () => {
    const input = `
      class Shape {
        abstract area(): i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 2);
    assert.match(
      errors[0].message,
      /Abstract method 'area' can only appear within an abstract class/,
    );
    assert.match(
      errors[1].message,
      /Non-abstract class 'Shape' does not implement abstract method 'area'/,
    );
  });

  test('should detect missing implementation in concrete subclass', () => {
    const input = `
      abstract class Shape {
        abstract area(): i32;
      }
      class Square extends Shape {
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Non-abstract class 'Square' does not implement abstract method 'area'/,
    );
  });

  test('should prevent instantiation of abstract class', () => {
    const input = `
      abstract class Shape {
      }
      let s = new Shape();
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Cannot instantiate abstract class 'Shape'/,
    );
  });

  test('should allow abstract subclass to not implement abstract method', () => {
    const input = `
      abstract class Shape {
        abstract area(): i32;
      }
      abstract class Polygon extends Shape {
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should check valid implementation in concrete subclass', () => {
    const input = `
      abstract class Shape {
        abstract area(): i32;
      }
      class Square extends Shape {
        side: i32 = 10;
        area(): i32 {
          return this.side * this.side;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });
});
