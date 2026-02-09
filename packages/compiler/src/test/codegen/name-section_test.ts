import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Compiler} from '../../lib/compiler.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {createHost} from './utils.js';

suite('name section', () => {
  const compileWithOptions = (
    source: string,
    options: {debug?: boolean} = {},
  ): Uint8Array => {
    const host = createHost(source);
    const compiler = new Compiler(host);
    const modules = compiler.compile('/main.zena');

    const diagnostics = modules.flatMap((m) => m.diagnostics ?? []);
    if (diagnostics.length > 0) {
      throw new Error(diagnostics.map((d) => d.message).join('\n'));
    }

    const codegen = new CodeGenerator(
      modules,
      '/main.zena',
      compiler.semanticContext,
      compiler.checkerContext,
      options,
    );
    return codegen.generate();
  };

  test('does not include name section by default', () => {
    const bytes = compileWithOptions(`
      export let add = (a: i32, b: i32) => a + b;
    `);

    // Look for "name" custom section
    // Custom sections have ID 0, then the name as a string
    // "name" = 0x04 0x6e 0x61 0x6d 0x65 (length-prefixed)
    const nameMarker = [0x04, 0x6e, 0x61, 0x6d, 0x65]; // 4, 'n', 'a', 'm', 'e'

    let found = false;
    for (let i = 0; i < bytes.length - nameMarker.length; i++) {
      if (bytes[i] === 0x00) {
        // Custom section ID
        // Check if the next bytes contain "name"
        let match = true;
        // Skip the section size (LEB128), look for the name
        for (let j = 0; j < 10 && i + 1 + j < bytes.length - 4; j++) {
          if (bytes[i + 1 + j] === 0x04) {
            // Length prefix for "name"
            match = true;
            for (let k = 0; k < 4; k++) {
              if (bytes[i + 2 + j + k] !== nameMarker[k + 1]) {
                match = false;
                break;
              }
            }
            if (match) {
              found = true;
              break;
            }
          }
        }
      }
      if (found) break;
    }

    assert.strictEqual(found, false, 'Name section should not be present');
  });

  test('includes name section when debug=true', () => {
    const bytes = compileWithOptions(
      `
      export let add = (a: i32, b: i32) => a + b;
    `,
      {debug: true},
    );

    // Look for "name" custom section
    // Simple search for the "name" string preceded by its length (4)
    let found = false;

    for (let i = 0; i < bytes.length - 5; i++) {
      if (
        bytes[i] === 0x04 && // length prefix
        bytes[i + 1] === 0x6e && // 'n'
        bytes[i + 2] === 0x61 && // 'a'
        bytes[i + 3] === 0x6d && // 'm'
        bytes[i + 4] === 0x65 // 'e'
      ) {
        found = true;
        break;
      }
    }

    assert.strictEqual(found, true, 'Name section should be present');
  });

  test('name section contains function names', () => {
    const bytes = compileWithOptions(
      `
      export let myFunction = (x: i32) => x * 2;
    `,
      {debug: true},
    );

    // Look for "myFunction" in the binary
    const funcName = 'myFunction';
    const funcNameBytes = new TextEncoder().encode(funcName);

    let found = false;
    for (let i = 0; i < bytes.length - funcNameBytes.length; i++) {
      let match = true;
      for (let j = 0; j < funcNameBytes.length; j++) {
        if (bytes[i + j] !== funcNameBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        found = true;
        break;
      }
    }

    assert.strictEqual(
      found,
      true,
      'Function name "myFunction" should be in the binary',
    );
  });

  test('debug build is larger than release build', () => {
    const source = `
      export let add = (a: i32, b: i32) => a + b;
      export let sub = (a: i32, b: i32) => a - b;
      export let mul = (a: i32, b: i32) => a * b;
    `;

    const releaseBytes = compileWithOptions(source, {debug: false});
    const debugBytes = compileWithOptions(source, {debug: true});

    assert.ok(
      debugBytes.length > releaseBytes.length,
      `Debug build (${debugBytes.length} bytes) should be larger than release build (${releaseBytes.length} bytes)`,
    );
  });

  test('exception stack trace contains function names in debug build', async () => {
    // Use array index out of bounds to trigger a WASM trap (not a throw)
    // WASM traps produce RuntimeError with stack traces that use the name section
    const source = `
      export let innerFunction = (arr: array<i32>) => {
        return arr[999999];  // Out of bounds - triggers trap
      };
      
      export let outerFunction = (arr: array<i32>) => innerFunction(arr);
      
      export let main = () => {
        let arr = #[1, 2, 3];
        outerFunction(arr);
      };
    `;

    // Compile with debug info
    const debugBytes = compileWithOptions(source, {debug: true});

    // Instantiate and call main, catching the trap
    const imports = {
      console: {
        log_i32: () => {},
        log_f32: () => {},
        log_string: () => {},
        error_string: () => {},
        warn_string: () => {},
        info_string: () => {},
        debug_string: () => {},
      },
    };

    const result = await WebAssembly.instantiate(debugBytes, imports);
    const exports = (result as any).instance.exports;

    try {
      exports.main();
      assert.fail('Expected trap to be thrown');
    } catch (e: any) {
      // Traps produce RuntimeError, not WebAssembly.Exception
      assert.ok(
        e instanceof WebAssembly.RuntimeError || e instanceof Error,
        `Expected RuntimeError or Error, got ${e?.constructor?.name}`,
      );

      // The stack trace should contain function names from the name section
      const stack = e.stack ?? '';

      console.log('stack\n', stack);

      // With debug build, we expect to see named functions in the stack trace
      const hasInnerFunction = stack.includes('innerFunction');
      const hasOuterFunction = stack.includes('outerFunction');
      const hasMain = stack.includes('main');

      // At least one of our function names should appear in the stack trace
      assert.ok(
        hasInnerFunction || hasOuterFunction || hasMain,
        `Debug build stack trace should contain function names. Got:\n${stack}`,
      );
    }
  });

  test('exception stack trace lacks function names in release build', async () => {
    // Use array index out of bounds to trigger a WASM trap
    const source = `
      export let innerFunction = (arr: array<i32>) => {
        return arr[999999];  // Out of bounds - triggers trap
      };
      
      export let outerFunction = (arr: array<i32>) => innerFunction(arr);
      
      export let main = () => {
        let arr = #[1, 2, 3];
        outerFunction(arr);
      };
    `;

    // Compile without debug info
    const releaseBytes = compileWithOptions(source, {debug: false});

    const imports = {
      console: {
        log_i32: () => {},
        log_f32: () => {},
        log_string: () => {},
        error_string: () => {},
        warn_string: () => {},
        info_string: () => {},
        debug_string: () => {},
      },
    };

    const result = await WebAssembly.instantiate(releaseBytes, imports);
    const exports = (result as any).instance.exports;

    try {
      exports.main();
      assert.fail('Expected trap to be thrown');
    } catch (e: any) {
      assert.ok(
        e instanceof WebAssembly.RuntimeError || e instanceof Error,
        `Expected RuntimeError or Error, got ${e?.constructor?.name}`,
      );

      const stack = e.stack ?? '';

      // In release build, our custom function names should NOT appear
      // (only generic wasm references like $func0 or index-based names)
      const hasInnerFunction = stack.includes('innerFunction');
      const hasOuterFunction = stack.includes('outerFunction');

      // These specific names should not appear in release build
      assert.ok(
        !hasInnerFunction && !hasOuterFunction,
        `Release build stack trace should not contain our function names. Got:\n${stack}`,
      );
    }
  });
});
