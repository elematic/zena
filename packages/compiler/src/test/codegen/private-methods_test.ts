import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {CodeGenerator} from '../../lib/codegen/index.js';

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

    const parser = new Parser(source);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    checker.check();
    const codegen = new CodeGenerator(ast);
    const bytes = codegen.generate();

    // Verify the generated code works correctly
    const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer);
    const {main} = result.instance.exports as {main: () => number};
    assert.strictEqual(main(), 42);

    // Now compare with a version where #helper is public
    // Public method calls use call_ref (dynamic dispatch)
    // Private method calls use call (static dispatch)
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

    const parser2 = new Parser(sourceWithPublic);
    const ast2 = parser2.parse();
    const checker2 = TypeChecker.forProgram(ast2);
    checker2.check();
    const codegen2 = new CodeGenerator(ast2);
    const bytesPublic = codegen2.generate();

    // Count call_ref (0x14) in both versions
    const countCallRef = (bytesArr: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < bytesArr.length; i++) {
        if (bytesArr[i] === 0x14) count++;
      }
      return count;
    };

    const privateCallRefs = countCallRef(new Uint8Array(bytes));
    const publicCallRefs = countCallRef(new Uint8Array(bytesPublic));

    // The version with public helper() should have MORE call_ref instructions
    // than the version with private #helper() because public methods use
    // dynamic dispatch (call_ref) while private methods use static dispatch (call)
    assert.ok(
      publicCallRefs > privateCallRefs,
      `Expected more call_ref instructions with public method (${publicCallRefs}) than private (${privateCallRefs})`,
    );
  });
});
