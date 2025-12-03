import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Type Aliases', () => {
  test('should support basic type aliases', () => {
    const input = `
      type ID = string;
      let x: ID = 'hello';
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should support generic type aliases', () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) { this.value = v; }
      }
      type StringBox = Box<string>;
      let b: StringBox = new Box('hello');
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should support generic type aliases with parameters', () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) { this.value = v; }
      }
      type MyBox<T> = Box<T>;
      let b: MyBox<i32> = new Box(123);
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should support record type aliases', () => {
    const input = `
      type Point = { x: i32, y: i32 };
      let p: Point = { x: 1, y: 2 };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should support union type aliases', () => {
    const input = `
      class A {}
      class B {}
      type ID = A | B;
      let x: ID = new A();
      let y: ID = new B();
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should error on missing type arguments for generic alias', () => {
    const input = `
      type Box<T> = { value: T };
      let x: Box = { value: 1 };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /requires 1 type arguments/);
  });
});
