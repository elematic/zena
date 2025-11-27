import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from '../../lib/index.js';

suite('CodeGenerator - Interop', () => {
  test('should call declared external function', async () => {
    const source = `
      declare function log(val: i32): void;

      export let main = (): void => {
        log(42);
      };
    `;

    const wasm = compile(source);

    let loggedValue: number | null = null;
    const imports = {
      env: {
        log: (val: number) => {
          loggedValue = val;
        },
      },
    };

    const module: any = await WebAssembly.instantiate(wasm, imports);
    const {main} = module.instance.exports as {main: () => void};
    main();

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

    const wasm = compile(source);

    let loggedValue: number | null = null;
    const imports = {
      custom_env: {
        print: (val: number) => {
          loggedValue = val;
        },
      },
    };

    const module: any = await WebAssembly.instantiate(wasm, imports);
    const {main} = module.instance.exports as {main: () => void};
    main();

    assert.strictEqual(loggedValue, 100);
  });
});
