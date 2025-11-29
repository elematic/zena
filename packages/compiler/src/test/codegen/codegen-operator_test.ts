import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';

suite('CodeGenerator - Operators', () => {
  test('should compile and run operator []', async () => {
    const input = `
      class Box {
        value: i32;
        #new(value: i32) {
          this.value = value;
        }
        operator [](index: i32): i32 {
          return this.value + index;
        }
      }
      export let main = (): i32 => {
        let b = new Box(10);
        return b[5];
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const codegen = new CodeGenerator(ast);
    const wasmBuffer = codegen.generate();

    const result = await WebAssembly.instantiate(wasmBuffer);
    const {main} = (result as any).instance.exports;
    assert.strictEqual(main(), 15);
  });

  test('should compile and run operator []=', async () => {
    const input = `
      class Box {
        value: i32;
        #new() {
          this.value = 0;
        }
        operator []=(index: i32, val: i32): void {
          this.value = index + val;
        }
        getValue(): i32 {
          return this.value;
        }
      }
      export let main = (): i32 => {
        let b = new Box();
        b[10] = 20;
        return b.getValue();
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const codegen = new CodeGenerator(ast);
    const wasmBuffer = codegen.generate();

    const result = await WebAssembly.instantiate(wasmBuffer);
    const {main} = (result as any).instance.exports;
    assert.strictEqual(main(), 30);
  });

  test('should compile and run array assignment', async () => {
    const input = `
      export final extension class FixedArray<T> on array<T> {
        @intrinsic('array.len')
        declare length: i32;
        @intrinsic('array.get')
        declare operator [](index: i32): T;
        @intrinsic('array.set')
        declare operator []=(index: i32, value: T): void;
      }
      export let main = (): i32 => {
        let arr = #[1, 2, 3];
        arr[1] = 42;
        return arr[1];
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    // Manually populate wellKnownTypes for the test
    const fixedArrayDecl = ast.body.find(
      (node) =>
        node.type === 'ClassDeclaration' && node.name.name === 'FixedArray',
    );
    if (fixedArrayDecl) {
      ast.wellKnownTypes.FixedArray = fixedArrayDecl as any;
    }

    const codegen = new CodeGenerator(ast);
    const wasmBuffer = codegen.generate();

    const result = await WebAssembly.instantiate(wasmBuffer);
    const {main} = (result as any).instance.exports;
    assert.strictEqual(main(), 42);
  });
});
