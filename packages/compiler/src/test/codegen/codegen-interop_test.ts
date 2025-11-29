import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

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
});
