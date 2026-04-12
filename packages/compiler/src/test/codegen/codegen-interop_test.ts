import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate, compileAndRun} from './utils.js';

suite('CodeGenerator - Interop', () => {
  test('should call declared external function', async () => {
    const source = `
      @external("env", "log")
      declare function log(val: i32): void;

      export let main = (): void => {
        log(42);
      };
    `;

    let loggedValue: number | null = null;
    const imports = {
      env: {
        log: (val: number) => {
          loggedValue = val;
        },
      },
    };

    await compileAndRun(source, {imports});

    assert.strictEqual(loggedValue, 42);
  });

  test('should call decorated external function', async () => {
    const source = `
      @external("custom_env", "print")
      declare function log(val: i32): void;

      export let main = (): void => {
        log(100);
      };
    `;

    let loggedValue: number | null = null;
    const imports = {
      custom_env: {
        print: (val: number) => {
          loggedValue = val;
        },
      },
    };

    await compileAndRun(source, {imports});

    assert.strictEqual(loggedValue, 100);
  });

  test('should handle external function returning reference type', async () => {
    // When a JS function returns a GC struct ref (e.g. a class instance),
    // the WASM boundary sees externref. The compiler must generate a wrapper
    // that internalizes externref -> anyref -> ref.cast to the concrete type.
    // Without the wrapper, WASM instantiation fails with a type mismatch
    // because the import signature expects a GC ref but JS returns externref.
    const source = `
      class Box {
        value: i32;
        new(v: i32) : value = v;
      }

      @external("env", "identity")
      declare function identity(b: Box): Box;

      export let main = (): i32 => {
        let b = new Box(42);
        let b2 = identity(b);
        return b2.value;
      };
    `;

    const imports = {
      env: {
        identity: (b: unknown) => b,
      },
    };

    const exports = await compileAndInstantiate(source, {imports});
    const result = (exports as any).main();

    assert.strictEqual(result, 42);
  });
});
