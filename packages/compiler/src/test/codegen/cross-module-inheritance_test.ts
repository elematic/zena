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
          x: i32;
          #new(x: i32) {
            this.x = x;
          }
        }
      `,
      '/main.zena': `
        import {Base} from '/base.zena';
        
        class Derived extends Base {
          y: i32;
          #new(x: i32, y: i32) {
            super(x);
            this.y = y;
          }
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
          value: i32;
          #new(v: i32) {
            this.value = v;
          }
        }
      `,
      '/main.zena': `
        import {Base} from '/base.zena';
        
        class Child extends Base {
          extra: i32;
          #new(v: i32, e: i32) {
            super(v);
            this.extra = e;
          }
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
          #new(a: i32) { this.a = a; }
        }
      `,
      '/b.zena': `
        import {A} from '/a.zena';
        export class B extends A {
          b: i32;
          #new(a: i32, b: i32) {
            super(a);
            this.b = b;
          }
        }
      `,
      '/main.zena': `
        import {B} from '/b.zena';
        
        class C extends B {
          c: i32;
          #new(a: i32, b: i32, c: i32) {
            super(a, b);
            this.c = c;
          }
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
          #value: i32;
          #new(v: i32) {
            this.#value = v;
          }
          value: i32 {
            get { return this.#value; }
          }
        }
      `,
      '/main.zena': `
        import {Base} from '/base.zena';
        
        class Derived extends Base {
          #extra: i32;
          #new(v: i32, e: i32) {
            super(v);
            this.#extra = e;
          }
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
          name: string;
          #new(name: string) {
            this.name = name;
          }
          speak(): string {
            return "...";
          }
        }
      `,
      '/main.zena': `
        import {Animal} from '/base.zena';
        
        class Dog extends Animal {
          #new(name: string) {
            super(name);
          }
          speak(): string {
            return "woof";
          }
        }
        
        let getSound = (a: Animal): string => {
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
        #new(message: string, code: i32) {
          super(message);
          this.code = code;
        }
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
        #new(message: string, code: i32) {
          super(message);
          this.#code = code;
        }
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
