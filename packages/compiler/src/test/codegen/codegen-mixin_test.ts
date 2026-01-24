import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {wrapAsModule} from './utils.js';

async function compileAndRun(
  input: string,
  entryPoint: string = 'main',
): Promise<number> {
  const parser = new Parser(input);
  const ast = parser.parse();

  const checker = TypeChecker.forProgram(ast);
  const diagnostics = checker.check();
  if (diagnostics.length > 0) {
    throw new Error(
      'Type check failed:\n' + diagnostics.map((d) => d.message).join('\n'),
    );
  }

  const codegen = new CodeGenerator(wrapAsModule(ast, input));
  const bytes = codegen.generate();
  const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer);
  const exports = result.instance.exports as any;
  return exports[entryPoint]();
}

suite('CodeGenerator - Mixins', () => {
  test('should compile and run basic mixin application', async () => {
    const source = `
      mixin M {
        x: i32 = 10;
        getX(): i32 { return this.x; }
      }
      class C with M {}
      
      export let main = (): i32 => {
        let c = new C();
        return c.getX();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 10);
  });

  test('should compile and run mixin accessing base members', async () => {
    const source = `
      class Base {
        baseVal: i32 = 5;
      }
      mixin M on Base {
        getBaseVal(): i32 { return this.baseVal; }
      }
      class C extends Base with M {}
      
      export let main = (): i32 => {
        let c = new C();
        return c.getBaseVal();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 5);
  });

  test('should compile and run mixin composition', async () => {
    const source = `
      mixin A { a: i32 = 1; }
      mixin B { b: i32 = 2; }
      
      class C with A, B {
        sum(): i32 { return this.a + this.b; }
      }
      
      export let main = (): i32 => {
        let c = new C();
        return c.sum();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 3);
  });

  test('should compile and run mixin overriding base method', async () => {
    const source = `
      class Base {
        val(): i32 { return 1; }
      }
      mixin M on Base {
        val(): i32 { return 2; }
      }
      class C extends Base with M {}
      
      export let main = (): i32 => {
        let c = new C();
        return c.val();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 2);
  });

  test('should compile and run mixin with private fields', async () => {
    const source = `
      mixin M {
        #secret: i32 = 42;
        getSecret(): i32 { return this.#secret; }
      }
      class C with M {}
      
      export let main = (): i32 => {
        let c = new C();
        return c.getSecret();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 42);
  });

  test('should compile and run mixin with accessors', async () => {
    const source = `
      mixin M {
        #val: i32 = 0;
        val: i32 {
          get { return this.#val; }
          set(v) { this.#val = v; }
        }
      }
      class C with M {}
      
      export let main = (): i32 => {
        let c = new C();
        c.val = 100;
        return c.val;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 100);
  });
});
