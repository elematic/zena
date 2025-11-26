import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../lib/parser.js';
import {TypeChecker} from '../lib/checker.js';

suite('TypeChecker - Classes', () => {
  test('should check valid class declaration', () => {
    const input = `
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        distance(): i32 {
          return 0;
        }
      }
      let p = new Point(1, 2);
      let x = p.x;
      p.distance();
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should detect duplicate fields', () => {
    const input = `
      class Point {
        x: i32;
        x: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Duplicate field 'x'/);
  });

  test('should detect type mismatch in field assignment', () => {
    const input = `
      class Point {
        x: i32;
        #new() {
          this.x = "hello";
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch in assignment/);
  });

  test('should detect invalid constructor arguments', () => {
    const input = `
      class Point {
        #new(x: i32) {}
      }
      let p = new Point(1, 2);
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Expected 1 arguments, got 2/);
  });

  test('should detect invalid member access', () => {
    const input = `
      class Point {
        x: i32;
      }
      let p = new Point();
      let y = p.y;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Property 'y' does not exist/);
  });

  test('should detect this usage outside class', () => {
    const input = `
      let x = this.x;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /'this' can only be used inside a class/);
  });
});
