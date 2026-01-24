import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {wrapAsModule} from './utils.js';

async function compileAndRun(input: string): Promise<number> {
  const parser = new Parser(input);
  const ast = parser.parse();
  const checker = TypeChecker.forProgram(ast);
  checker.check();
  const codegen = new CodeGenerator(wrapAsModule(ast, input));
  const bytes = codegen.generate();
  const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer);
  const {main} = result.instance.exports as {main: () => number};
  return main();
}

suite('Codegen: Private Fields', () => {
  test('Basic private field access', async () => {
    const source = `
      class Counter {
        #count: i32 = 0;
        
        increment() {
          this.#count = this.#count + 1;
        }
        
        get(): i32 {
          return this.#count;
        }
      }
      
      export let main = (): i32 => {
        let c = new Counter();
        c.increment();
        c.increment();
        return c.get();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 2);
  });

  test('Private field access on another instance', async () => {
    const source = `
      class Point {
        #x: i32;
        
        #new(x: i32) {
          this.#x = x;
        }
        
        add(other: Point): i32 {
          return this.#x + other.#x;
        }
      }
      
      export let main = () => {
      let p1 = new Point(10);
      let p2 = new Point(20);
      return p1.add(p2);
    };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 30);
  });

  test('Private field shadowing in inheritance', async () => {
    const source = `
      class A {
        #val: i32 = 10;
        getA(): i32 { return this.#val; }
      }
      
      class B extends A {
        #val: i32 = 20;
        getB(): i32 { return this.#val; }
      }
      
      export let main = (): i32 => {
        let b = new B();
        return b.getA() + b.getB();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 30);
  });

  test('Private fields use static dispatch (no getter in vtable)', async () => {
    // This test verifies that private fields are accessed directly via struct_get
    // and do NOT generate virtual getters/setters in the vtable.
    // Public fields generate get_fieldName/set_fieldName accessors in the vtable.
    // Private fields are accessed directly without vtable indirection.

    const source1 = `
      class Widget {
        #secret: i32 = 42;
        getValue(): i32 { return this.#secret; }
      }
      
      export let main = (): i32 => {
        let w = new Widget();
        return w.getValue();
      };
    `;
    const parser = new Parser(source1);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    checker.check();
    const codegen = new CodeGenerator(wrapAsModule(ast, source1));
    const bytesPrivate = codegen.generate();

    // Verify the generated code works correctly
    const result = await WebAssembly.instantiate(
      bytesPrivate.buffer as ArrayBuffer,
    );
    const {main} = result.instance.exports as {main: () => number};
    assert.strictEqual(main(), 42);

    // Now compare with a version where secret is public
    // Public fields generate virtual getters that use call_ref (dynamic dispatch)
    // Private fields use direct struct_get (static access)
    const source2 = `
      class Widget {
        secret: i32 = 42;
        getValue(): i32 { return this.secret; }
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
    const codegen2 = new CodeGenerator(wrapAsModule(ast2, source2));
    const bytesPublic = codegen2.generate();

    // Count call_ref (0x14) in both versions
    // Public field access goes through virtual getter (call_ref)
    // Private field access is direct (struct_get, no call_ref)
    const countCallRef = (bytesArr: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < bytesArr.length; i++) {
        if (bytesArr[i] === 0x14) count++;
      }
      return count;
    };

    const privateCallRefs = countCallRef(new Uint8Array(bytesPrivate));
    const publicCallRefs = countCallRef(new Uint8Array(bytesPublic));

    // The version with public field should have MORE call_ref instructions
    // because public field access goes through virtual getter
    assert.ok(
      publicCallRefs > privateCallRefs,
      `Expected more call_ref instructions with public field (${publicCallRefs}) than private (${privateCallRefs})`,
    );
  });
});
