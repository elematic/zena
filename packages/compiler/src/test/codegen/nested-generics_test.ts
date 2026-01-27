/**
 * Tests for nested generic contexts.
 *
 * These tests validate that type resolution works correctly when we have:
 * - Generic methods inside generic classes
 * - Generic classes extending other generic classes
 * - Multiple levels of type parameter substitution
 *
 * This file serves as both a test suite and documentation of what works.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Codegen: Nested Generics', () => {
  suite('Generic method in generic class', () => {
    test('method uses both class and method type parameters', async () => {
      // Box<T> has method map<U> that uses both T and U
      const source = `
        class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }

          // Method type parameter U, class type parameter T
          map<U>(f: (v: T) => U): U {
            return f(this.value);
          }
        }

        export let main = (): i32 => {
          let box = new Box<i32>(10);
          // Call map<boolean> - T=i32, U=boolean
          let result = box.map<i32>((x: i32) => x * 2);
          return result;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 20);
    });

    test('local variable with method type parameter U', async () => {
      // This tests that local variables typed with method type parameter work
      const source = `
        class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }

          transform<U>(f: (v: T) => U): U {
            // Local variable with method type parameter U
            let transformed: U = f(this.value);
            return transformed;
          }
        }

        export let main = (): i32 => {
          let box = new Box<i32>(5);
          return box.transform<i32>((x: i32) => x * 3);
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 15);
    });

    test('method returns class type parameter', async () => {
      const source = `
        class Container<T> {
          value: T;
          #new(v: T) { this.value = v; }

          // Generic method that returns class type parameter
          getOrElse<U>(fallback: U): T {
            return this.value;
          }
        }

        export let main = (): i32 => {
          let c = new Container<i32>(42);
          // T=i32, U=boolean (unused in result)
          return c.getOrElse<boolean>(true);
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });

    test('local variable with class type parameter in generic method', async () => {
      // This tests that local variable type resolution works in nested contexts
      const source = `
        class Wrapper<T> {
          inner: T;
          #new(v: T) { this.inner = v; }

          process<U>(transformer: (v: T) => U): U {
            // Local variable with class type parameter T
            let local: T = this.inner;
            return transformer(local);
          }
        }

        export let main = (): i32 => {
          let w = new Wrapper<i32>(5);
          return w.process<i32>((x: i32) => x + 10);
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 15);
    });

    test('nested generic type using both parameters', async () => {
      const source = `
        class Pair<A, B> {
          first: A;
          second: B;
          #new(a: A, b: B) { this.first = a; this.second = b; }
        }

        class Container<T> {
          value: T;
          #new(v: T) { this.value = v; }

          // Returns Pair<T, U> - uses both class and method type params
          pairWith<U>(other: U): Pair<T, U> {
            return new Pair<T, U>(this.value, other);
          }
        }

        export let main = (): i32 => {
          let c = new Container<i32>(10);
          let pair = c.pairWith<i32>(20);
          return pair.first + pair.second;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 30);
    });
  });

  suite('Generic class extending generic class', () => {
    test('derived class uses parent type parameter', async () => {
      const source = `
        class Base<T> {
          value: T;
          #new(v: T) { this.value = v; }
          get(): T { return this.value; }
        }

        class Derived<T> extends Base<T> {
          extra: i32;
          #new(v: T, e: i32) {
            super(v);
            this.extra = e;
          }
          getExtra(): i32 { return this.extra; }
        }

        export let main = (): i32 => {
          let d = new Derived<i32>(10, 5);
          return d.get() + d.getExtra();
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 15);
    });

    test('derived class instantiates parent with concrete type', async () => {
      const source = `
        class Base<T> {
          value: T;
          #new(v: T) { this.value = v; }
          get(): T { return this.value; }
        }

        // Derived is generic over U but instantiates Base with i32
        class Derived<U> extends Base<i32> {
          tag: U;
          #new(v: i32, t: U) {
            super(v);
            this.tag = t;
          }
        }

        export let main = (): i32 => {
          let d = new Derived<boolean>(42, true);
          return d.get();
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });

    test('three-level inheritance with generics', async () => {
      const source = `
        class A<T> {
          a: T;
          #new(v: T) { this.a = v; }
        }

        class B<T> extends A<T> {
          b: i32;
          #new(v: T, x: i32) {
            super(v);
            this.b = x;
          }
        }

        class C<T> extends B<T> {
          c: i32;
          #new(v: T, x: i32, y: i32) {
            super(v, x);
            this.c = y;
          }
        }

        export let main = (): i32 => {
          let obj = new C<i32>(1, 2, 3);
          return obj.a + obj.b + obj.c;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 6);
    });
  });

  suite('Multiple instantiations of same generic', () => {
    test('same generic class with different type args', async () => {
      const source = `
        class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }
          get(): T { return this.value; }
        }

        export let main = (): i32 => {
          let intBox = new Box<i32>(10);
          let boolBox = new Box<boolean>(true);
          
          // Verify both work independently
          var sum = intBox.get();
          if (boolBox.get()) {
            sum = sum + 1;
          }
          return sum;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 11);
    });

    test('generic method called with different type args', async () => {
      const source = `
        class Util {
          #new() {}
          
          identity<T>(x: T): T {
            return x;
          }
        }

        export let main = (): i32 => {
          let u = new Util();
          let a = u.identity<i32>(10);
          let b = u.identity<i32>(20);
          let c = u.identity<boolean>(true);
          
          var result = a + b;
          if (c) {
            result = result + 1;
          }
          return result;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 31);
    });
  });

  suite('Type parameter in field type', () => {
    test('field with generic class type', async () => {
      const source = `
        class Inner<T> {
          value: T;
          #new(v: T) { this.value = v; }
        }

        class Outer<T> {
          inner: Inner<T>;
          #new(v: T) {
            this.inner = new Inner<T>(v);
          }
        }

        export let main = (): i32 => {
          let o = new Outer<i32>(42);
          return o.inner.value;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });
  });
});
