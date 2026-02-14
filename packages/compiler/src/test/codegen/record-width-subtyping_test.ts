import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';

const check = (source: string) => {
  const parser = new Parser(source);
  const module = parser.parse();
  const checker = TypeChecker.forModule(module);
  return checker.check();
};

// NOTE: This test file reflects the CURRENT implementation (exact types).
// The design has been updated to allow width subtyping (records-as-interfaces).
// See docs/design/records-and-tuples.md for the new design.
// TODO: Update these tests when width subtyping is implemented.

suite('Records - current behavior (exact types)', () => {
  test('record exact shape - basic access', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let point = {x: 1, y: 2};
        return point.x + point.y;
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('record exact shape - with matching annotation', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let point: {x: i32, y: i32} = {x: 1, y: 2};
        return point.x + point.y;
      };
    `);
    assert.strictEqual(result, 3);
  });

  // CURRENT: Width subtyping is REJECTED (exact types)
  // FUTURE: Width subtyping will be ALLOWED (records-as-interfaces)

  test('currently rejects width subtyping - assign larger to smaller', () => {
    const diagnostics = check(`
      export let main = (): i32 => {
        let point: {x: i32, y: i32} = {x: 1, y: 2, z: 3};
        return point.x + point.y;
      };
    `);
    // TODO: Change to assert.strictEqual(diagnostics.length, 0) when width subtyping is implemented
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });

  test('currently rejects width subtyping - function parameter', () => {
    const diagnostics = check(`
      let sumXY = (p: {x: i32, y: i32}): i32 => p.x + p.y;
      export let main = (): i32 => {
        let point = {x: 5, y: 7, z: 100};
        return sumXY(point);
      };
    `);
    // TODO: Change to assert.strictEqual(diagnostics.length, 0) when width subtyping is implemented
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch|not assignable/i);
  });

  test('currently rejects width subtyping - reassignment', () => {
    const diagnostics = check(`
      export let main = (): i32 => {
        var point: {x: i32, y: i32} = {x: 1, y: 2};
        point = {x: 10, y: 20, z: 30};
        return point.x + point.y;
      };
    `);
    // TODO: Change to assert.strictEqual(diagnostics.length, 0) when width subtyping is implemented
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });
});
