import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Generics', () => {
  test('should check generic class declaration', () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
        get(): T {
          return this.value;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should check generic instantiation', () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
      }
      let b = new Box<i32>(10);
      let s = new Box<string>('hello');
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should detect type mismatch in generic instantiation', () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
      }
      let b = new Box<i32>('hello');
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });

  test('should check field access on generic instance', () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
      }
      let b = new Box<i32>(10);
      let x = b.value;
      b.value = 20;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should detect type mismatch on field access', () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
      }
      let b = new Box<i32>(10);
      b.value = 'hello';
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });

  test('should check generic function', () => {
    const input = `
      let id = <T>(x: T) => x;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should check nested generics', () => {
    const input = `
      class List<T> {
        item: T;
        #new(i: T) { this.item = i; }
      }
      class Container<T> {
        list: List<T>;
        #new(l: List<T>) { this.list = l; }
      }
      let l = new List<i32>(1);
      let c = new Container<i32>(l);
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });
});
