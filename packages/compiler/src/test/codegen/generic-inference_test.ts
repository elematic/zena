import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('Generic Type Inference', () => {
  suite('Constructor inference', () => {
    test('infer type from constructor argument', async () => {
      const exports = await compileAndInstantiate(`
        class Box<T> {
          value: T;
          #new(value: T) {
            this.value = value;
          }
          getValue(): T {
            return this.value;
          }
        }
        
        export let test = (): i32 => {
          // Should infer Box<i32> from the argument 42
          let b = new Box(42);
          return b.getValue();
        };
      `);

      assert.strictEqual(exports.test(), 42);
    });

    test('infer type from multiple constructor arguments', async () => {
      const exports = await compileAndInstantiate(`
        class Pair<T, U> {
          first: T;
          second: U;
          #new(first: T, second: U) {
            this.first = first;
            this.second = second;
          }
        }
        
        export let test = (): i32 => {
          // Should infer Pair<i32, i64>
          let p = new Pair(10, 20 as i64);
          return p.first;
        };
      `);

      assert.strictEqual(exports.test(), 10);
    });

    test('nested generic constructor inference', async () => {
      const exports = await compileAndInstantiate(`
        class Box<T> {
          value: T;
          #new(value: T) {
            this.value = value;
          }
          getValue(): T {
            return this.value;
          }
        }
        
        class Container<T> {
          box: Box<T>;
          #new(value: T) {
            // Inner Box should infer T from context
            this.box = new Box(value);
          }
          get(): T {
            return this.box.getValue();
          }
        }
        
        export let test = (): i32 => {
          // Container<i32> inferred, and Box<i32> inside
          let c = new Container(99);
          return c.get();
        };
      `);

      assert.strictEqual(exports.test(), 99);
    });
  });

  suite('Function inference', () => {
    test('infer type from function argument', async () => {
      const exports = await compileAndInstantiate(`
        let identity = <T>(x: T): T => x;
        
        export let test = (): i32 => {
          // Should infer identity<i32>
          return identity(42);
        };
      `);

      assert.strictEqual(exports.test(), 42);
    });

    test('infer multiple type parameters', async () => {
      const exports = await compileAndInstantiate(`
        let pair = <T, U>(a: T, b: U): T => a;
        
        export let test = (): i32 => {
          // Should infer pair<i32, i64>
          return pair(10, 20 as i64);
        };
      `);

      assert.strictEqual(exports.test(), 10);
    });

    test.skip('infer from array argument', async () => {
      // TODO: Array type inference doesn't work yet because array<T> 
      // produces an ArrayType with TypeParameterType elementType,
      // but inference needs to unwrap this
      const exports = await compileAndInstantiate(`
        let first = <T>(arr: array<T>): T => arr[0];
        
        export let test = (): i32 => {
          let arr = [1, 2, 3];
          // Should infer first<i32>
          return first(arr);
        };
      `);

      assert.strictEqual(exports.test(), 1);
    });

    test('infer from closure return type', async () => {
      const exports = await compileAndInstantiate(`
        let apply = <T, U>(x: T, f: (a: T) => U): U => f(x);
        
        export let test = (): i32 => {
          // Should infer apply<i32, i32>
          // T inferred from 10, U inferred from closure return
          return apply(10, (n: i32): i32 => n * 2);
        };
      `);

      assert.strictEqual(exports.test(), 20);
    });
  });

  suite('Method inference', () => {
    test('infer type from method argument', async () => {
      const exports = await compileAndInstantiate(`
        class Helper {
          identity<T>(x: T): T {
            return x;
          }
        }
        
        export let test = (): i32 => {
          let h = new Helper();
          // Should infer identity<i32>
          return h.identity(42);
        };
      `);

      assert.strictEqual(exports.test(), 42);
    });

    test('infer method type on generic class', async () => {
      const exports = await compileAndInstantiate(`
        class Box<T> {
          value: T;
          #new(value: T) {
            this.value = value;
          }
          
          // Method with its own type parameter
          map<U>(f: (a: T) => U): U {
            return f(this.value);
          }
        }
        
        export let test = (): i32 => {
          let b = new Box(10);
          // Should infer map<i32> from the closure return type
          return b.map((x: i32): i32 => x * 2);
        };
      `);

      assert.strictEqual(exports.test(), 20);
    });
  });

  suite('Mixed scenarios', () => {
    test('chain multiple generic calls without type arguments', async () => {
      const exports = await compileAndInstantiate(`
        let identity = <T>(x: T): T => x;
        let double = (x: i32): i32 => x * 2;
        
        export let test = (): i32 => {
          // Chain: identity infers <i32>, double takes i32
          return double(identity(21));
        };
      `);

      assert.strictEqual(exports.test(), 42);
    });

    test('explicit and inferred type arguments can be mixed', async () => {
      const exports = await compileAndInstantiate(`
        class Box<T> {
          value: T;
          #new(value: T) {
            this.value = value;
          }
        }
        
        let identity = <T>(x: T): T => x;
        
        export let test = (): i32 => {
          // Explicit on constructor
          let b1 = new Box<i32>(10);
          // Inferred on function
          let v = identity(b1.value);
          return v;
        };
      `);

      assert.strictEqual(exports.test(), 10);
    });
  });
});
