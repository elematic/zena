/**
 * Binary size tests for DCE (Dead Code Elimination).
 *
 * These tests measure the size of compiled WASM binaries to verify that
 * unused code is eliminated. When DCE is disabled, the tests verify that
 * programs compile correctly; when enabled, they verify size constraints.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileToWasm} from './utils.js';

/**
 * Options for binary size compilation.
 * Will be extended to support DCE toggle.
 */
export interface BinarySizeOptions {
  /** Enable dead code elimination (default: false until implemented) */
  dce?: boolean;
}

/**
 * Compile source and return the binary size in bytes.
 */
export const getBinarySize = (
  source: string,
  _options: BinarySizeOptions = {},
): number => {
  // TODO: Pass DCE option to compiler once implemented
  const bytes = compileToWasm(source);
  return bytes.length;
};

/**
 * Compile source and verify it produces valid WASM that can be instantiated.
 */
const compileAndValidate = async (source: string): Promise<number> => {
  const bytes = compileToWasm(source);

  // Validate the WASM is structurally correct
  await WebAssembly.compile(bytes.buffer as ArrayBuffer);

  return bytes.length;
};

suite('Binary Size', () => {
  suite('Minimal Programs', () => {
    test('export main only - no stdlib', async () => {
      const source = `export let main = () => 42;`;

      const size = await compileAndValidate(source);

      // Log size for visibility during development
      console.log(`  Minimal program size: ${size} bytes`);

      // This is a baseline measurement. With DCE enabled, this should be
      // very small (< 100 bytes). Without DCE, stdlib may be included.
      // For now, just verify it compiles.
      assert.ok(size > 0, 'Should produce non-empty WASM');

      // TODO: When DCE is implemented, add constraint:
      // assert.ok(size < 100, `Minimal program should be < 100 bytes, got ${size}`);
    });

    test('export constant value', async () => {
      const source = `export let answer = 42;`;

      const size = await compileAndValidate(source);
      console.log(`  Constant export size: ${size} bytes`);

      assert.ok(size > 0, 'Should produce non-empty WASM');
    });
  });

  suite('String Usage', () => {
    test('export string literal', async () => {
      const source = `export let main = () => "hello";`;

      const size = await compileAndValidate(source);
      console.log(`  String literal size: ${size} bytes`);

      // String usage requires:
      // - String class (minimal)
      // - $stringGetByte export (for runtime)
      // - String data in memory
      assert.ok(size > 0, 'Should produce non-empty WASM');

      // TODO: When DCE is implemented, verify this is reasonably small
      // but larger than the minimal program
    });

    test('string with length access', async () => {
      const source = `export let main = () => "hello".length;`;

      const size = await compileAndValidate(source);
      console.log(`  String.length size: ${size} bytes`);

      assert.ok(size > 0, 'Should produce non-empty WASM');
    });
  });

  suite('Unused Declarations', () => {
    test('unused function should not increase size with DCE', async () => {
      const withUnused = `
        let unused = () => 999;
        export let main = () => 42;
      `;
      const withoutUnused = `
        export let main = () => 42;
      `;

      const sizeWith = await compileAndValidate(withUnused);
      const sizeWithout = await compileAndValidate(withoutUnused);

      console.log(`  With unused function: ${sizeWith} bytes`);
      console.log(`  Without unused function: ${sizeWithout} bytes`);

      // TODO: With DCE enabled, these should be equal (or very close)
      // assert.ok(
      //   Math.abs(sizeWith - sizeWithout) < 10,
      //   'Unused function should be eliminated'
      // );
    });

    test('unused class should not increase size with DCE', async () => {
      const withUnused = `
        class Unused {
          x: i32;
          #new() { this.x = 0; }
        }
        export let main = () => 42;
      `;
      const withoutUnused = `
        export let main = () => 42;
      `;

      const sizeWith = await compileAndValidate(withUnused);
      const sizeWithout = await compileAndValidate(withoutUnused);

      console.log(`  With unused class: ${sizeWith} bytes`);
      console.log(`  Without unused class: ${sizeWithout} bytes`);

      // TODO: With DCE enabled, these should be equal (or very close)
    });
  });

  suite('Transitive Usage', () => {
    test('transitively used function is kept', async () => {
      const source = `
        let helper = () => 1;
        let used = () => helper();
        export let main = () => used();
      `;

      const size = await compileAndValidate(source);
      console.log(`  Transitive usage size: ${size} bytes`);

      // Verify the program works correctly
      const bytes = compileToWasm(source);
      const result = await WebAssembly.instantiate(
        bytes.buffer as ArrayBuffer,
        {
          console: {
            log_i32: () => {},
            log_f32: () => {},
            log_string: () => {},
            error_string: () => {},
            warn_string: () => {},
            info_string: () => {},
            debug_string: () => {},
          },
        },
      );
      const exports = result.instance.exports as {main: () => number};
      assert.strictEqual(
        exports.main(),
        1,
        'Should return 1 from helper chain',
      );
    });
  });

  suite('Size Comparisons', () => {
    test('string usage adds size compared to minimal', async () => {
      const minimal = `export let main = () => 42;`;
      const withString = `export let main = () => "hello";`;

      const minimalSize = await compileAndValidate(minimal);
      const stringSize = await compileAndValidate(withString);

      console.log(`  Minimal: ${minimalSize} bytes`);
      console.log(`  With string: ${stringSize} bytes`);
      console.log(`  Difference: ${stringSize - minimalSize} bytes`);

      // String usage should add size (String class, data, helpers)
      // This test documents the overhead of string support
      assert.ok(
        stringSize > minimalSize,
        'String usage should require more code than minimal program',
      );
    });
  });
});
