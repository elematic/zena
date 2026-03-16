import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Super Initializer Codegen', () => {
  test('super() in initializer list for derived class', async () => {
    const result = await compileAndRun(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        y: i32;
        new(a: i32, b: i32) : y = b, super(a) {
        }
      }
      export let main = (): i32 => {
        let d = new Derived(10, 20);
        return d.x + d.y;
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('super() only in initializer list (no local fields)', async () => {
    const result = await compileAndRun(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        new(x: i32) : super(x) {
        }
      }
      export let main = (): i32 => {
        let d = new Derived(42);
        return d.x;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('super() with default field values', async () => {
    const result = await compileAndRun(`
      class Base {
        x: i32 = 5;
        new() {}
      }
      class Derived extends Base {
        y: i32;
        z: i32 = 100;
        new(y: i32) : y = y, super() {
        }
      }
      export let main = (): i32 => {
        let d = new Derived(10);
        return d.x + d.y + d.z;
      };
    `);
    // x=5 (from Base default), y=10 (from init list), z=100 (from default)
    assert.strictEqual(result, 115);
  });

  test('super() in initializer list with body code', async () => {
    const result = await compileAndRun(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        y: i32;
        new(a: i32, b: i32) : y = b, super(a) {
          // Body executes after super() and field init
          this.y = this.y + this.x;
        }
      }
      export let main = (): i32 => {
        let d = new Derived(10, 20);
        return d.y;  // Should be 20 + 10 = 30
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('private field in initializer list with super()', async () => {
    const result = await compileAndRun(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        #secret: i32;
        new(a: i32, s: i32) : #secret = s, super(a) {
        }
        getSecret(): i32 {
          return this.#secret;
        }
      }
      export let main = (): i32 => {
        let d = new Derived(10, 99);
        return d.x + d.getSecret();
      };
    `);
    assert.strictEqual(result, 109);
  });

  test('extension class with super() in initializer list', async () => {
    const result = await compileAndRun(`
      extension class MyInt on i32 {
        new(value: i32) : super(value) {
        }
        doubled(): i32 {
          return this * 2;
        }
      }
      export let main = (): i32 => {
        let m = new MyInt(21);
        return m.doubled();
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('super() no args with superclass that has no constructor', async () => {
    const result = await compileAndRun(`
      class Base {
        x: i32 = 10;
      }
      class Derived extends Base {
        y: i32;
        new(y: i32) : y = y, super() {
        }
      }
      export let main = (): i32 => {
        let d = new Derived(5);
        return d.x + d.y;
      };
    `);
    assert.strictEqual(result, 15);
  });

  test('multi-level inheritance with super() in init list', async () => {
    const result = await compileAndRun(`
      class A {
        x: i32;
        new(x: i32) : x = x {}
      }
      class B extends A {
        y: i32;
        new(x: i32, y: i32) : y = y, super(x) {
        }
      }
      class C extends B {
        z: i32;
        new(x: i32, y: i32, z: i32) : z = z, super(x, y) {
        }
      }
      export let main = (): i32 => {
        let c = new C(1, 2, 3);
        return c.x + c.y + c.z;
      };
    `);
    assert.strictEqual(result, 6);
  });
});
