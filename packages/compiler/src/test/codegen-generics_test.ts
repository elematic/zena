import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../lib/parser.js';
import {CodeGenerator} from '../lib/codegen.js';

async function compile(input: string) {
  const parser = new Parser(input);
  const ast = parser.parse();
  let codegen = new CodeGenerator(ast);
  let bytes = codegen.generate();
  const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer);
  return result.instance.exports;
}

suite('CodeGenerator - Generics', () => {
  test('should compile and run a generic Box class with i32', async () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      export let test = (): i32 => {
        let b = new Box<i32>(42);
        return b.getValue();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 42);
  });

  test('should compile and run a generic Box class with f32', async () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      export let test = (): f32 => {
        let b = new Box<f32>(3.14);
        return b.getValue();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(Math.fround(test()), Math.fround(3.14));
  });

  test('should support recursive generic types', async () => {
    const input = `
      class Container<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      export let test = (): i32 => {
        let c = new Container<Container<i32>>(new Container<i32>(123));
        return c.getValue().getValue();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 123);
  });

  test('should support generic class with class type argument', async () => {
    const input = `
      class Foo {
        val: i32;
        #new(v: i32) {
          this.val = v;
        }
        getVal(): i32 {
          return this.val;
        }
      }

      class Container<T> {
        item: T;
        #new(i: T) {
          this.item = i;
        }
        getItem(): T {
          return this.item;
        }
      }
      
      export let test = (): i32 => {
        let f = new Foo(100);
        let c = new Container<Foo>(f);
        return c.getItem().getVal();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 100);
  });
});
