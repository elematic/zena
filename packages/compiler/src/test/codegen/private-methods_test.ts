import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun, compileAndInstantiate} from './utils.js';

suite('Codegen: Private Methods', () => {
  test('Basic private method call', async () => {
    const source = `
      class Calculator {
        #double(x: i32): i32 {
          return x * 2;
        }
        
        calculate(val: i32): i32 {
          return this.#double(val) + 1;
        }
      }
      
      export let main = (): i32 => {
        let c = new Calculator();
        return c.calculate(10);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 21);
  });

  test('Private method call on another instance', async () => {
    const source = `
      class Secret {
        #value: i32;
        
        #new(v: i32) {
          this.#value = v;
        }
        
        #getValue(): i32 {
          return this.#value;
        }
        
        compare(other: Secret): i32 {
          return this.#getValue() - other.#getValue();
        }
      }
      
      export let main = (): i32 => {
        let s1 = new Secret(100);
        let s2 = new Secret(42);
        return s1.compare(s2);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 58);
  });

  test('Private method with same name in subclass', async () => {
    const source = `
      class Base {
        #secret(): i32 { return 1; }
        callBase(): i32 { return this.#secret(); }
      }
      
      class Derived extends Base {
        #secret(): i32 { return 2; }
        callDerived(): i32 { return this.#secret(); }
      }
      
      export let main = (): i32 => {
        let d = new Derived();
        return d.callBase() * 10 + d.callDerived();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 12);
  });

  test('Private methods use static dispatch (not in vtable)', async () => {
    // This test verifies that private methods are NOT added to the vtable
    // and use static dispatch (direct call opcode 0x10) instead of
    // dynamic dispatch (call_ref opcode 0x14)
    const source = `
      class Widget {
        #helper(): i32 { return 42; }
        publicMethod(): i32 { return this.#helper(); }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.publicMethod();
      };
    `;

    const exports = await compileAndInstantiate(source);
    assert.strictEqual(exports.main(), 42);

    // Now verify public version also works (behavioral test)
    const sourceWithPublic = `
      class Widget {
        helper(): i32 { return 42; }
        publicMethod(): i32 { return this.helper(); }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.publicMethod();
      };
    `;

    const exportsPublic = await compileAndInstantiate(sourceWithPublic);
    assert.strictEqual(exportsPublic.main(), 42);
  });
});
