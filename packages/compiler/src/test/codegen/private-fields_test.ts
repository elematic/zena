import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {TypeChecker} from '../../lib/checker/index.js';

async function compileAndRun(input: string): Promise<number> {
  const parser = new Parser(input);
  const ast = parser.parse();
  const checker = new TypeChecker(ast);
  checker.check();
  const codegen = new CodeGenerator(ast);
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
});
