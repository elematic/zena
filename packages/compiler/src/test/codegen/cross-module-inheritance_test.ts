/**
 * Tests for cross-module class inheritance.
 *
 * These tests verify that the compiler processes modules in topological order
 * (dependencies before dependents), which is required for cross-module class
 * inheritance to work correctly.
 *
 * Before the fix (commit that added topological ordering in compiler.ts),
 * these tests would fail with errors like:
 * - "Class X has vtable but no __vtable field"
 * - Classes not inheriting fields from superclasses in other modules
 */
import {suite, test} from 'node:test';
import {strict as assert} from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('Cross-module class inheritance', () => {
  test('inherits public fields from class in another module', async () => {
    const exports = await compileAndInstantiate({
      '/base.zena': `
        export class Base {
          var x: i32;
          new(x: i32) : x = x {}
        }
      `,
      '/main.zena': `
        import {Base} from '/base.zena';
        
        class Derived extends Base {
          y: i32;
          new(x: i32, y: i32) : y = y, super(x) { }
        }
        
        export let main = (): i32 => {
          let d = new Derived(10, 20);
          return d.x + d.y;
        };
      `,
    });
    assert.strictEqual((exports as any).main(), 30);
  });

  test('inherits vtable from class in another module', async () => {
    // This test specifically checks vtable inheritance across modules.
    // Public fields generate vtable entries for their accessors.
    const exports = await compileAndInstantiate({
      '/base.zena': `
        export class Base {
          var value: i32;
          new(v: i32) : value = v {}
        }
      `,
      '/main.zena': `
        import {Base} from '/base.zena';
        
        class Child extends Base {
          extra: i32;
          new(v: i32, e: i32) : extra = e, super(v) { }
        }
        
        export let main = (): i32 => {
          let c = new Child(5, 3);
          // Access inherited field (uses vtable dispatch)
          let v = c.value;
          // Set inherited field (uses vtable dispatch)
          c.value = v + 1;
          return c.value + c.extra;
        };
      `,
    });
    assert.strictEqual((exports as any).main(), 9); // (5+1) + 3 = 9
  });

  test('three-level inheritance across modules', async () => {
    const exports = await compileAndInstantiate({
      '/a.zena': `
        export class A {
          a: i32;
          new(a: i32) : a = a {}
        }
      `,
      '/b.zena': `
        import {A} from '/a.zena';
        export class B extends A {
          b: i32;
          new(a: i32, b: i32) : b = b, super(a) { }
        }
      `,
      '/main.zena': `
        import {B} from '/b.zena';
        
        class C extends B {
          c: i32;
          new(a: i32, b: i32, c: i32) : c = c, super(a, b) { }
        }
        
        export let main = (): i32 => {
          let obj = new C(1, 2, 3);
          return obj.a + obj.b + obj.c;
        };
      `,
    });
    assert.strictEqual((exports as any).main(), 6);
  });

  test('inherits private fields with getters from class in another module', async () => {
    const exports = await compileAndInstantiate({
      '/base.zena': `
        export class Base {
          var #value: i32;
          new(v: i32) : #value = v {}
          value: i32 {
            get { return this.#value; }
          }
        }
      `,
      '/main.zena': `
        import {Base} from '/base.zena';
        
        class Derived extends Base {
          #extra: i32;
          new(v: i32, e: i32) : #extra = e, super(v) { }
          extra: i32 {
            get { return this.#extra; }
          }
        }
        
        export let main = (): i32 => {
          let d = new Derived(10, 5);
          return d.value + d.extra;
        };
      `,
    });
    assert.strictEqual((exports as any).main(), 15);
  });

  test('polymorphic dispatch with cross-module base class', async () => {
    const exports = await compileAndInstantiate({
      '/base.zena': `
        export class Animal {
          name: String;
          new(name: String) : name = name {}
          speak(): String {
            return "...";
          }
        }
      `,
      '/main.zena': `
        import {Animal} from '/base.zena';
        
        class Dog extends Animal {
          new(name: String) : super(name) { }
          speak(): String {
            return "woof";
          }
        }
        
        let getSound = (a: Animal): String => {
          return a.speak();
        };
        
        export let main = (): i32 => {
          let dog = new Dog("Rex");
          let sound = getSound(dog);
          if (sound == "woof") return 1;
          return 0;
        };
      `,
    });
    assert.strictEqual((exports as any).main(), 1);
  });

  test('stdlib Error inheritance works', async () => {
    // This is a real-world case that was broken before the fix
    const exports = await compileAndInstantiate(`
      import {Error} from 'zena:error';
      
      class CustomError extends Error {
        code: i32;
        new(message: String, code: i32) : code = code, super(message) { }
      }
      
      export let main = (): i32 => {
        let e = new CustomError("test", 42);
        return e.code;
      };
    `);
    assert.strictEqual((exports as any).main(), 42);
  });

  test('stdlib Error inheritance with private fields', async () => {
    const exports = await compileAndInstantiate(`
      import {Error} from 'zena:error';
      
      class CustomError extends Error {
        #code: i32;
        new(message: String, code: i32) : #code = code, super(message) { }
        code: i32 {
          get { return this.#code; }
        }
      }
      
      export let main = (): i32 => {
        let e = new CustomError("test", 42);
        return e.code;
      };
    `);
    assert.strictEqual((exports as any).main(), 42);
  });
});
