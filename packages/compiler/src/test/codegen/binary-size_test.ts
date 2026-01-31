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
 * Compile source with optional DCE and verify it produces valid WASM.
 * Returns the binary size in bytes.
 */
const compileAndValidate = async (
  source: string,
  dce = false,
): Promise<number> => {
  const bytes = compileToWasm(source, '/main.zena', {dce});

  // Validate the WASM is structurally correct
  await WebAssembly.compile(bytes.buffer as ArrayBuffer);

  return bytes.length;
};

suite('Binary Size', () => {
  suite('Minimal Programs', () => {
    test('export main only - no stdlib', async () => {
      const source = `export let main = () => 42;`;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      assert.ok(sizeNoDce > 0, 'Should produce non-empty WASM');
      assert.ok(sizeWithDce > 0, 'Should produce non-empty WASM with DCE');

      // With DCE, size should be smaller or equal
      assert.ok(
        sizeWithDce <= sizeNoDce,
        `DCE should not increase size (${sizeWithDce} > ${sizeNoDce})`,
      );
    });

    test('export constant value', async () => {
      const source = `export let answer = 42;`;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      assert.ok(sizeNoDce > 0, 'Should produce non-empty WASM');
      assert.ok(sizeWithDce > 0, 'Should produce non-empty WASM with DCE');
    });
  });

  suite('String Usage', () => {
    test('export string literal', async () => {
      const source = `export let main = () => "hello";`;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      assert.ok(sizeNoDce > 0, 'Should produce non-empty WASM');
      assert.ok(sizeWithDce > 0, 'Should produce non-empty WASM with DCE');
    });

    test('string with length access', async () => {
      const source = `export let main = () => "hello".length;`;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      assert.ok(sizeNoDce > 0, 'Should produce non-empty WASM');
      assert.ok(sizeWithDce > 0, 'Should produce non-empty WASM with DCE');
    });
  });

  suite('Unused Declarations', () => {
    test('unused function is eliminated with DCE', async () => {
      const withUnused = `
        let unused = () => 999;
        export let main = () => 42;
      `;
      const withoutUnused = `
        export let main = () => 42;
      `;

      // Without DCE
      const sizeWithNoDce = await compileAndValidate(withUnused, false);
      const sizeWithoutNoDce = await compileAndValidate(withoutUnused, false);

      // With DCE
      const sizeWithDce = await compileAndValidate(withUnused, true);
      const sizeWithoutDce = await compileAndValidate(withoutUnused, true);

      console.log(`  Without DCE - with unused: ${sizeWithNoDce} bytes`);
      console.log(`  Without DCE - without unused: ${sizeWithoutNoDce} bytes`);
      console.log(`  With DCE - with unused: ${sizeWithDce} bytes`);
      console.log(`  With DCE - without unused: ${sizeWithoutDce} bytes`);

      // Without DCE, unused function adds size
      assert.ok(
        sizeWithNoDce > sizeWithoutNoDce,
        'Without DCE, unused function should add size',
      );

      // With DCE, unused function should be eliminated - sizes should be equal
      assert.strictEqual(
        sizeWithDce,
        sizeWithoutDce,
        `With DCE, unused function should be eliminated (${sizeWithDce} != ${sizeWithoutDce})`,
      );
    });

    test('unused class is eliminated with DCE', async () => {
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

      // Without DCE
      const sizeWithNoDce = await compileAndValidate(withUnused, false);
      const sizeWithoutNoDce = await compileAndValidate(withoutUnused, false);

      // With DCE
      const sizeWithDce = await compileAndValidate(withUnused, true);
      const sizeWithoutDce = await compileAndValidate(withoutUnused, true);

      console.log(`  Without DCE - with unused: ${sizeWithNoDce} bytes`);
      console.log(`  Without DCE - without unused: ${sizeWithoutNoDce} bytes`);
      console.log(`  With DCE - with unused: ${sizeWithDce} bytes`);
      console.log(`  With DCE - without unused: ${sizeWithoutDce} bytes`);

      // Without DCE, unused class adds significant size
      assert.ok(
        sizeWithNoDce > sizeWithoutNoDce,
        'Without DCE, unused class should add size',
      );

      // With DCE, unused class should be eliminated - sizes should be equal
      assert.strictEqual(
        sizeWithDce,
        sizeWithoutDce,
        `With DCE, unused class should be eliminated (${sizeWithDce} != ${sizeWithoutDce})`,
      );
    });
  });

  suite('Transitive Usage', () => {
    test('transitively used function is kept with DCE', async () => {
      const source = `
        let helper = () => 1;
        let used = () => helper();
        export let main = () => used();
      `;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      // With DCE, transitive dependencies should still be included
      // Size will be much smaller because stdlib is eliminated, but program should work
      assert.ok(
        sizeWithDce < sizeNoDce,
        'DCE should reduce size by eliminating stdlib',
      );

      // Verify the program works correctly with DCE
      const bytes = compileToWasm(source, '/main.zena', {dce: true});
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

      const minimalSize = await compileAndValidate(minimal, true);
      const stringSize = await compileAndValidate(withString, true);

      console.log(`  Minimal (DCE): ${minimalSize} bytes`);
      console.log(`  With string (DCE): ${stringSize} bytes`);
      console.log(`  Difference: ${stringSize - minimalSize} bytes`);

      // String usage should add size (String class, data, helpers)
      assert.ok(
        stringSize > minimalSize,
        'String usage should require more code than minimal program',
      );
    });
  });
});
