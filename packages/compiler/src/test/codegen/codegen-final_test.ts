import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun, wrapAsModule} from './utils.js';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {CodeGenerator} from '../../lib/codegen/index.js';

suite('CodeGenerator - Final Modifier', () => {
  test('should compile and run final class', async () => {
    const input = `
      final class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        
        final distanceSquared(): i32 {
          return this.x * this.x + this.y * this.y;
        }
      }

      export let main = (): i32 => {
        let p = new Point(3, 4);
        return p.distanceSquared();
      };
    `;
    const output = await compileAndRun(input, 'main');
    assert.strictEqual(output, 25);
  });

  test('should compile and run final method in non-final class', async () => {
    const input = `
      class Base {
        final getValue(): i32 {
          return 42;
        }
        
        getOther(): i32 {
          return 10;
        }
      }
      
      class Derived extends Base {
        getOther(): i32 {
          return 20;
        }
      }

      export let main = (): i32 => {
        let b = new Base();
        let d = new Derived();
        
        // Should use static dispatch for getValue
        return b.getValue() + d.getValue() + d.getOther();
      };
    `;
    // 42 + 42 + 20 = 104
    const output = await compileAndRun(input, 'main');
    assert.strictEqual(output, 104);
  });

  test('should compile and run final accessor', async () => {
    const input = `
      class Container {
        value: i32;
        #new(v: i32) {
          this.value = v;
        }
        
        final val: i32 {
          get {
            return this.value;
          }
          set(v) {
            this.value = v;
          }
        }
      }

      export let main = (): i32 => {
        let c = new Container(10);
        c.val = 20;
        return c.val;
      };
    `;
    const output = await compileAndRun(input, 'main');
    assert.strictEqual(output, 20);
  });

  test('final method uses static dispatch (no call_ref)', async () => {
    // This test verifies that final methods use static dispatch (call)
    // instead of dynamic dispatch (call_ref via vtable)

    const countCallRef = (bytesArr: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < bytesArr.length; i++) {
        if (bytesArr[i] === 0x14) count++; // call_ref opcode
      }
      return count;
    };

    // Version with final method
    const source1 = `
      class Widget {
        final getValue(): i32 { return 42; }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.getValue();
      };
    `;
    const parser1 = new Parser(source1);
    const ast1 = parser1.parse();
    const checker1 = TypeChecker.forProgram(ast1);
    checker1.check();
    const codegen1 = new CodeGenerator(
      wrapAsModule(ast1, source1),
      undefined,
      checker1.semanticContext,
    );
    const bytesFinal = codegen1.generate();

    // Version with non-final method
    const source2 = `
      class Widget {
        getValue(): i32 { return 42; }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.getValue();
      };
    `;
    const parser2 = new Parser(source2);
    const ast2 = parser2.parse();
    const checker2 = TypeChecker.forProgram(ast2);
    checker2.check();
    const codegen2 = new CodeGenerator(
      wrapAsModule(ast2, source2),
      undefined,
      checker2.semanticContext,
    );
    const bytesNonFinal = codegen2.generate();

    const finalCallRefs = countCallRef(new Uint8Array(bytesFinal));
    const nonFinalCallRefs = countCallRef(new Uint8Array(bytesNonFinal));

    // Non-final method should use MORE call_ref than final method
    assert.ok(
      nonFinalCallRefs > finalCallRefs,
      `Expected more call_ref with non-final method (${nonFinalCallRefs}) than final (${finalCallRefs})`,
    );
  });

  test('final class methods use static dispatch (no call_ref)', async () => {
    // This test verifies that methods on final classes use static dispatch
    // because the class cannot be subclassed

    const countCallRef = (bytesArr: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < bytesArr.length; i++) {
        if (bytesArr[i] === 0x14) count++; // call_ref opcode
      }
      return count;
    };

    // Version with final class
    const source1 = `
      final class Widget {
        getValue(): i32 { return 42; }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.getValue();
      };
    `;
    const parser1 = new Parser(source1);
    const ast1 = parser1.parse();
    const checker1 = TypeChecker.forProgram(ast1);
    checker1.check();
    const codegen1 = new CodeGenerator(
      wrapAsModule(ast1, source1),
      undefined,
      checker1.semanticContext,
    );
    const bytesFinalClass = codegen1.generate();

    // Version with non-final class
    const source2 = `
      class Widget {
        getValue(): i32 { return 42; }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.getValue();
      };
    `;
    const parser2 = new Parser(source2);
    const ast2 = parser2.parse();
    const checker2 = TypeChecker.forProgram(ast2);
    checker2.check();
    const codegen2 = new CodeGenerator(
      wrapAsModule(ast2, source2),
      undefined,
      checker2.semanticContext,
    );
    const bytesNonFinalClass = codegen2.generate();

    const finalClassCallRefs = countCallRef(new Uint8Array(bytesFinalClass));
    const nonFinalClassCallRefs = countCallRef(
      new Uint8Array(bytesNonFinalClass),
    );

    // Non-final class should use MORE call_ref than final class
    assert.ok(
      nonFinalClassCallRefs > finalClassCallRefs,
      `Expected more call_ref with non-final class (${nonFinalClassCallRefs}) than final class (${finalClassCallRefs})`,
    );
  });

  test('final accessor getter uses static dispatch', async () => {
    const countCallRef = (bytesArr: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < bytesArr.length; i++) {
        if (bytesArr[i] === 0x14) count++;
      }
      return count;
    };

    // Version with final accessor
    const source1 = `
      class Widget {
        #value: i32 = 42;
        final val: i32 {
          get { return this.#value; }
        }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.val;
      };
    `;
    const parser1 = new Parser(source1);
    const ast1 = parser1.parse();
    const checker1 = TypeChecker.forProgram(ast1);
    checker1.check();
    const codegen1 = new CodeGenerator(
      wrapAsModule(ast1, source1),
      undefined,
      checker1.semanticContext,
    );
    const bytesFinal = codegen1.generate();

    // Version with non-final accessor
    const source2 = `
      class Widget {
        #value: i32 = 42;
        val: i32 {
          get { return this.#value; }
        }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.val;
      };
    `;
    const parser2 = new Parser(source2);
    const ast2 = parser2.parse();
    const checker2 = TypeChecker.forProgram(ast2);
    checker2.check();
    const codegen2 = new CodeGenerator(
      wrapAsModule(ast2, source2),
      undefined,
      checker2.semanticContext,
    );
    const bytesNonFinal = codegen2.generate();

    const finalCallRefs = countCallRef(new Uint8Array(bytesFinal));
    const nonFinalCallRefs = countCallRef(new Uint8Array(bytesNonFinal));

    assert.ok(
      nonFinalCallRefs > finalCallRefs,
      `Expected more call_ref with non-final accessor (${nonFinalCallRefs}) than final (${finalCallRefs})`,
    );
  });

  test('final accessor setter uses static dispatch', async () => {
    const countCallRef = (bytesArr: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < bytesArr.length; i++) {
        if (bytesArr[i] === 0x14) count++;
      }
      return count;
    };

    // Version with final accessor
    const source1 = `
      class Widget {
        #value: i32 = 0;
        final val: i32 {
          get { return this.#value; }
          set(v) { this.#value = v; }
        }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        w.val = 42;
        return w.val;
      };
    `;
    const parser1 = new Parser(source1);
    const ast1 = parser1.parse();
    const checker1 = TypeChecker.forProgram(ast1);
    checker1.check();
    const codegen1 = new CodeGenerator(
      wrapAsModule(ast1, source1),
      undefined,
      checker1.semanticContext,
    );
    const bytesFinal = codegen1.generate();

    // Version with non-final accessor
    const source2 = `
      class Widget {
        #value: i32 = 0;
        val: i32 {
          get { return this.#value; }
          set(v) { this.#value = v; }
        }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        w.val = 42;
        return w.val;
      };
    `;
    const parser2 = new Parser(source2);
    const ast2 = parser2.parse();
    const checker2 = TypeChecker.forProgram(ast2);
    checker2.check();
    const codegen2 = new CodeGenerator(
      wrapAsModule(ast2, source2),
      undefined,
      checker2.semanticContext,
    );
    const bytesNonFinal = codegen2.generate();

    const finalCallRefs = countCallRef(new Uint8Array(bytesFinal));
    const nonFinalCallRefs = countCallRef(new Uint8Array(bytesNonFinal));

    assert.ok(
      nonFinalCallRefs > finalCallRefs,
      `Expected more call_ref with non-final accessor setter (${nonFinalCallRefs}) than final (${finalCallRefs})`,
    );
  });

  test('final field getter uses static dispatch', async () => {
    const countCallRef = (bytesArr: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < bytesArr.length; i++) {
        if (bytesArr[i] === 0x14) count++;
      }
      return count;
    };

    // Version with final field
    const source1 = `
      class Widget {
        final value: i32 = 42;
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.value;
      };
    `;
    const parser1 = new Parser(source1);
    const ast1 = parser1.parse();
    const checker1 = TypeChecker.forProgram(ast1);
    checker1.check();
    const codegen1 = new CodeGenerator(
      wrapAsModule(ast1, source1),
      undefined,
      checker1.semanticContext,
    );
    const bytesFinal = codegen1.generate();

    // Version with non-final field
    const source2 = `
      class Widget {
        value: i32 = 42;
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.value;
      };
    `;
    const parser2 = new Parser(source2);
    const ast2 = parser2.parse();
    const checker2 = TypeChecker.forProgram(ast2);
    checker2.check();
    const codegen2 = new CodeGenerator(
      wrapAsModule(ast2, source2),
      undefined,
      checker2.semanticContext,
    );
    const bytesNonFinal = codegen2.generate();

    const finalCallRefs = countCallRef(new Uint8Array(bytesFinal));
    const nonFinalCallRefs = countCallRef(new Uint8Array(bytesNonFinal));

    assert.ok(
      nonFinalCallRefs > finalCallRefs,
      `Expected more call_ref with non-final field (${nonFinalCallRefs}) than final (${finalCallRefs})`,
    );
  });
});
