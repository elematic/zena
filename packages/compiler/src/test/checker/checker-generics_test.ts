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

  test('should check generic class with constraint', () => {
    const input = `
      class Base {}
      class Derived extends Base {}
      class Container<T extends Base> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
      }
      let c1 = new Container<Base>(new Base());
      let c2 = new Container<Derived>(new Derived());
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should detect constraint violation in generic instantiation', () => {
    const input = `
      class Base {}
      class Unrelated {}
      class Container<T extends Base> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
      }
      let c = new Container<Unrelated>(new Unrelated());
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /does not satisfy constraint.*for type parameter/,
    );
  });

  test('should check multiple constrained type parameters', () => {
    const input = `
      class Base<V> {
        v: V;
        #new(v: V) {
          this.v = v;
        }
      }
      class Container<T extends Base<V>, V> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
      }
      let c = new Container<Base<i32>, i32>(new Base<i32>(42));
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should check generic function with constraint', () => {
    const input = `
      class Base {}
      class Derived extends Base {}
      let fn = <T extends Base>(x: T): T => x;
      let result = fn<Derived>(new Derived());
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should detect constraint violation in generic function call', () => {
    const input = `
      class Base {}
      class Unrelated {}
      let fn = <T extends Base>(x: T): T => x;
      let result = fn<Unrelated>(new Unrelated());
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /does not satisfy constraint.*for type parameter/,
    );
  });
});
