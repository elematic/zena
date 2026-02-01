/**
 * Integration test for FixedArray slice functionality
 */

import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun, compileModules} from './utils.js';

suite('Codegen - FixedArray slice', () => {
  test('should verify fixed-array module compiles', async () => {
    // First verify that the stdlib compiles correctly
    const source = `
      import { FixedArray } from 'zena:array';
      export let test = () => {
        let arr = new FixedArray<i32>(5, 0);
        return arr.length;
      };
    `;
    const modules = compileModules(source);
    // Check fixed-array module specifically
    const fixedArrayMod = modules.find((m) => m.path === 'zena:fixed-array');
    if (
      fixedArrayMod &&
      fixedArrayMod.diagnostics &&
      fixedArrayMod.diagnostics.length > 0
    ) {
      console.log(
        'Fixed-array module errors:',
        fixedArrayMod.diagnostics
          .map((d) => `${d.message} at line ${d.location?.line}`)
          .join('\n'),
      );
    }
    const allDiagnostics = modules.flatMap((m) => m.diagnostics ?? []);
    assert.strictEqual(
      allDiagnostics.length,
      0,
      `Expected no errors but got: ${allDiagnostics.map((d) => `${d.message} (${d.location?.line}:${d.location?.column})`).join(', ')}`,
    );
  });

  test('should slice with start and end', async () => {
    const source = `
      export let testSlice = () => {
        let arr = #[10, 20, 30, 40, 50];
        let sliced = arr.slice(1, 4);
        return sliced.length;
      };
    `;

    const result = await compileAndRun(source, 'testSlice');
    assert.strictEqual(result, 3);
  });

  test('should slice with BoundedRange', async () => {
    const source = `
      export let testBoundedRange = () => {
        let arr = #[10, 20, 30, 40, 50];
        let sliced = arr[1..4];
        return sliced.length;
      };
    `;

    const result = await compileAndRun(source, 'testBoundedRange');
    assert.strictEqual(result, 3);
  });

  test('should return correct element via BoundedRange slice', async () => {
    const source = `
      export let testBoundedRangeElement = () => {
        let arr = #[10, 20, 30, 40, 50];
        let sliced = arr[1..4];
        return sliced[0];
      };
    `;

    const result = await compileAndRun(source, 'testBoundedRangeElement');
    assert.strictEqual(result, 20);
  });

  test('should slice with FromRange', async () => {
    const source = `
      export let testFromRange = () => {
        let arr = #[10, 20, 30, 40, 50];
        let sliced = arr[2..];
        return sliced.length;
      };
    `;

    const result = await compileAndRun(source, 'testFromRange');
    assert.strictEqual(result, 3);
  });

  test('should slice with ToRange', async () => {
    const source = `
      export let testToRange = () => {
        let arr = #[10, 20, 30, 40, 50];
        let sliced = arr[..3];
        return sliced.length;
      };
    `;

    const result = await compileAndRun(source, 'testToRange');
    assert.strictEqual(result, 3);
  });

  test('should clone with FullRange', async () => {
    const source = `
      export let testFullRange = () => {
        let arr = #[10, 20, 30];
        let copy = arr[..];
        return copy.length;
      };
    `;

    const result = await compileAndRun(source, 'testFullRange');
    assert.strictEqual(result, 3);
  });
});
