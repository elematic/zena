import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Error Messages', () => {
  test('local classes should be rejected by the checker', async () => {
    // Local classes (classes defined inside functions) are not supported.
    // The checker should reject them with a clear error message.
    const source = `
      export let main = (): i32 => {
        class Local { x: i32; #new() { this.x = 1; } }
        let obj: Local = new Local();
        return obj.x;
      };
    `;

    await assert.rejects(
      async () => compileAndRun(source),
      (err: Error) => {
        assert.match(
          err.message,
          /Local class declarations are not supported/,
          'Should reject local class declarations',
        );
        return true;
      },
    );
  });

  test('local class union should be rejected by the checker', async () => {
    // Multiple local classes should all be rejected individually.
    const source = `
      export let main = (): i32 => {
        class Local1 { x: i32; #new() { this.x = 1; } }
        class Local2 { y: i32; #new() { this.y = 2; } }
        let obj: Local1 | Local2 = new Local1();
        return 1;
      };
    `;

    await assert.rejects(
      async () => compileAndRun(source),
      (err: Error) => {
        assert.match(
          err.message,
          /Local class declarations are not supported/,
          'Should reject local class declarations',
        );
        return true;
      },
    );
  });
});
