import {strict as assert} from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen - Field Initialization', () => {
  test('should initialize fields in order', async () => {
    const source = `
      class A {
        x: i32 = 10;
        y: i32 = this.x * 2;
        
        getX(): i32 { return this.x; }
        getY(): i32 { return this.y; }
      }
      
      export let run = (): i32 => {
        let a = new A();
        return a.y;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.equal(result, 20);
  });

  test('should initialize derived fields after base fields', async () => {
    const source = `
      class Base {
        baseVal: i32 = 100;
      }
      class Derived extends Base {
        derivedVal: i32 = this.baseVal + 50;
      }
      
      export let run = (): i32 => {
        let d = new Derived();
        return d.derivedVal;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.equal(result, 150);
  });

  test('should execute side effects in field initializers in order', async () => {
    // Since we don't have a global log or easy side-effect tracking without more infra,
    // we can use a chain of dependencies to prove order.
    // x = 1
    // y = x + 1 (must be 2)
    // z = y + 1 (must be 3)
    const source = `
      class A {
        x: i32 = 1;
        y: i32 = this.x + 1;
        z: i32 = this.y + 1;
      }
      
      export let run = (): i32 => {
        let a = new A();
        if (a.x != 1) return 100;
        if (a.y != 2) return 200;
        if (a.z != 3) return 300;
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.equal(result, 0);
  });

  test('should demonstrate initialization hazard (virtual call from super constructor)', async () => {
    // This test confirms the current behavior where virtual calls from super
    // constructors execute BEFORE subclass field initializers. Base constructor
    // calls setup() -> Derived.setup() -> accesses this.x. At this point,
    // Derived.x has NOT been initialized yet (it defaults to 0 for i32).
    //
    // We capture the value of x during setup() by storing it in a boxed field
    // (Box<i32>). The field is declared nullable WITHOUT an inline initializer
    // so that the value set by setup() persists - if we used `= null`, that
    // inline initializer would run AFTER setup() and overwrite our captured value.
    const source = `
      class Box<T> {
        value: T;
        new(value: T) : value = value {}
      }
      
      class Base {
        new() {
          this.setup();
        }
        setup(): void {}
      }
      
      class Derived extends Base {
        x: i32 = 100;
        var capturedX: Box<i32> | null;  // No initializer - defaults to null, then setup() sets it

        setup(): void {
          // Hazard: this.x is not initialized yet!
          // In WASM, uninitialized i32 fields are 0.
          this.capturedX = new Box(this.x);
        }
      }
      
      export let run = (): i32 => {
        let d = new Derived();
        // capturedX.value should be 0 because x was 0 when setup() ran
        let box = d.capturedX;
        if (box !== null) {
          return box.value;
        }
        return 999;
      };
    `;
    const result = await compileAndRun(source, 'run');
    // x was 0 during setup() - demonstrates the initialization hazard
    assert.equal(result, 0);
  });
});
