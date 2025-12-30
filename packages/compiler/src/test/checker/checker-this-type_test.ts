import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - This Type', () => {
  test('should resolve `this` type in class method parameter', () => {
    const input = `
      class Point {
        x: i32;
        y: i32;
        
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        
        equals(other: this): boolean {
          return this.x == other.x && this.y == other.y;
        }
      }
      
      export let main = () => {
        let p1 = new Point(1, 2);
        let p2 = new Point(1, 2);
        return p1.equals(p2);
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should resolve `this` type in class method return type', () => {
    const input = `
      class Builder {
        value: i32 = 0;
        
        setValue(v: i32): this {
          this.value = v;
          return this;
        }
      }
      
      export let main = () => {
        let b = new Builder();
        let b2 = b.setValue(42);
        return b2.value;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should keep `this` type as ThisType in interface', () => {
    const input = `
      interface Comparable {
        compareTo(other: this): i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should resolve `this` type to implementing class in interface method', () => {
    const input = `
      interface Comparable {
        compareTo(other: this): i32;
      }
      
      class MyInt implements Comparable {
        value: i32;
        
        #new(value: i32) {
          this.value = value;
        }
        
        compareTo(other: MyInt): i32 {
          return this.value - other.value;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should allow `this` in callback parameter in interface', () => {
    const input = `
      interface Sequence<T> {
        map<U>(f: (item: T, seq: this) => U): Sequence<U>;
      }
      
      class Array<T> implements Sequence<T> {
        map<U>(f: (item: T, seq: Array<T>) => U): Array<U> {
          return new Array<U>();
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should error on `this` type outside class or interface', () => {
    const input = `
      let f = (x: this) => x;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /'this' type is only valid inside a class or interface/,
    );
  });

  test('should resolve `this` in generic class', () => {
    const input = `
      class Container<T> {
        value: T;
        
        #new(value: T) {
          this.value = value;
        }
        
        // Self-referential method using this type
        combine(other: this): this {
          return this;
        }
      }
      
      export let main = () => {
        let c1 = new Container<i32>(1);
        let c2 = new Container<i32>(2);
        let c3 = c1.combine(c2);
        return c3.value;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });
});
