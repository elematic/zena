import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Error Messages', () => {
  test('local classes should report class not found error', async () => {
    // Local classes (classes defined inside functions) are not registered
    // in the codegen class registry. This is a known limitation.
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
        // Local classes aren't supported and produce a "Class not found" error
        assert.match(
          err.message,
          /Class Local not found/,
          'Should report class not found for local class',
        );
        return true;
      },
    );
  });

  test('local class in union should report error', async () => {
    // When a local class appears in a union, we first try to check if it's
    // a reference type, but since it's not in ctx.classes, the isReferenceType
    // check fails and we fall through to the "unsupported union" error.
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
        // The error could be either "Unbound type parameter" or "Unsupported union"
        // depending on the code path
        const isExpectedError =
          err.message.includes('Unbound type parameter') ||
          err.message.includes('Unsupported union type');
        assert.ok(
          isExpectedError,
          `Expected unbound type or unsupported union error, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
