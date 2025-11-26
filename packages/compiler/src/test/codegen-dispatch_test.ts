import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../lib/parser.js';
import {CodeGenerator} from '../lib/codegen/index.js';

suite('CodeGenerator - Dynamic Dispatch', () => {
  test('should support dynamic dispatch for overridden methods', async () => {
    const input = `
      class Animal {
        speak(): i32 {
          return 1;
        }
      }
      class Dog extends Animal {
        speak(): i32 {
          return 2;
        }
      }
      export let main = (): i32 => {
        let a: Animal = new Dog();
        return a.speak();
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const codegen = new CodeGenerator(ast);
    const wasmBuffer = codegen.generate();

    const result = await WebAssembly.instantiate(wasmBuffer);
    const {main} = (result as any).instance.exports;
    assert.strictEqual(main(), 2);
  });

  test('should support dynamic dispatch for inherited methods', async () => {
    const input = `
      class Animal {
        speak(): i32 {
          return 1;
        }
      }
      class Dog extends Animal {
      }
      export let main = (): i32 => {
        let a: Animal = new Dog();
        return a.speak();
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const codegen = new CodeGenerator(ast);
    const wasmBuffer = codegen.generate();

    const result = await WebAssembly.instantiate(wasmBuffer);
    const {main} = (result as any).instance.exports;
    assert.strictEqual(main(), 1);
  });
});
