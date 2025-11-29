import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Overloading', () => {
  test('should resolve overloaded functions to different external functions', async () => {
    const source = `
      @external("env", "print_i32")
      declare function print(val: i32): void;

      @external("env", "print_f32")
      declare function print(val: f32): void;

      export let main = (): void => {
        print(42);
        print(3.14);
      };
    `;

    const logs: string[] = [];
    const imports = {
      env: {
        print_i32: (val: number) => {
          logs.push(`i32: ${val}`);
        },
        print_f32: (val: number) => {
          // Float precision might be tricky, but 3.14 should be close enough
          logs.push(`f32: ${val.toFixed(2)}`);
        },
      },
    };

    await compileAndRun(source, {imports});

    assert.deepStrictEqual(logs, ['i32: 42', 'f32: 3.14']);
  });

  test('should resolve overloaded functions with different parameter counts', async () => {
    const source = `
      @external("env", "print_1")
      declare function print(a: i32): void;

      @external("env", "print_2")
      declare function print(a: i32, b: i32): void;

      export let main = (): void => {
        print(1);
        print(1, 2);
      };
    `;

    const logs: string[] = [];
    const imports = {
      env: {
        print_1: (a: number) => {
          logs.push(`1: ${a}`);
        },
        print_2: (a: number, b: number) => {
          logs.push(`2: ${a}, ${b}`);
        },
      },
    };

    await compileAndRun(source, {imports});

    assert.deepStrictEqual(logs, ['1: 1', '2: 1, 2']);
  });
});
