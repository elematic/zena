import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Prelude Initialization Order', () => {
  test('console is available in global initializer callbacks', async () => {
    // This test verifies that prelude modules (like console) are initialized
    // before user code runs. The bug was that when user code uses a prelude
    // symbol in an immediately-executed callback during global initialization
    // (like `let tests = suite(...)` which runs its callback during registration),
    // the prelude global hadn't been initialized yet, causing a null reference.
    //
    // The fix ensures prelude modules are added to the module list before
    // user modules, so their globals are initialized first in the WASM
    // start function.
    //
    // Note: Top-level expression statements aren't executed in Zena's codegen,
    // only global variable initializers run. So we test via a variable initializer
    // that calls a function with an immediate callback.

    // Create a function that takes a callback and runs it immediately,
    // then returns a value to use in a variable initializer
    const result = await compileAndRun(`
      // Function that runs a callback immediately and returns the result
      let withCallback = (callback: () => i32) => callback();
      
      // Use console.log inside the callback - this is the pattern that
      // caused the bug: the callback runs during global variable initialization,
      // but console wasn't initialized yet because prelude modules came after
      // user modules in the module ordering.
      let value = withCallback(() => {
        console.log("test");
        return 42;
      });
      
      export let main = () => value;
    `);

    assert.strictEqual(
      result,
      42,
      'callback using console.log should have run and returned 42',
    );
  });

  test('prelude symbols work in nested global initializer callbacks', async () => {
    // Tests that prelude symbols work even in deeply nested callbacks
    // during global initialization
    const result = await compileAndRun(`
      let outer = (f: () => i32) => f();
      let inner = (f: () => i32) => f();
      
      let value = outer(() => inner(() => {
        console.log("deeply nested");
        return 100;
      }));
      
      export let main = () => value;
    `);

    assert.strictEqual(result, 100, 'nested callbacks should have executed');
  });
});
