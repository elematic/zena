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

// Records support width subtyping in the type system (records-as-interfaces).
// A record type {x: i32, y: i32} accepts any value with at least those fields.
// See docs/design/records-and-tuples.md for the design.
//
// Implementation status:
// - Phase 2 (Type Checker): ✅ DONE - width subtyping is allowed
// - Phase 4 (Codegen): TODO - needs dispatch mechanism for field access

suite('Records - width subtyping (type checker)', () => {
  test('record exact shape - basic access', () => {
    const diagnostics = check(`
      export let main = (): i32 => {
        let point = {x: 1, y: 2};
        return point.x + point.y;
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('record exact shape - with matching annotation', () => {
    const diagnostics = check(`
      export let main = (): i32 => {
        let point: {x: i32, y: i32} = {x: 1, y: 2};
        return point.x + point.y;
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('width subtyping - assign larger to smaller', () => {
    // Assigning a record with extra fields to a narrower type should work
    const diagnostics = check(`
      export let main = (): i32 => {
        let point: {x: i32, y: i32} = {x: 1, y: 2, z: 3};
        return point.x + point.y;
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('width subtyping - function parameter', () => {
    // Passing a record with extra fields to a function expecting fewer should work
    const diagnostics = check(`
      let sumXY = (p: {x: i32, y: i32}): i32 => p.x + p.y;
      export let main = (): i32 => {
        let point = {x: 5, y: 7, z: 100};
        return sumXY(point);
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('width subtyping - reassignment', () => {
    // Reassigning with extra fields should work
    const diagnostics = check(`
      export let main = (): i32 => {
        var point: {x: i32, y: i32} = {x: 1, y: 2};
        point = {x: 10, y: 20, z: 30};
        return point.x + point.y;
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('width subtyping - nested records', () => {
    // Width subtyping should work with nested records
    const diagnostics = check(`
      let getX = (r: {inner: {x: i32}}): i32 => r.inner.x;
      export let main = (): i32 => {
        let data = {inner: {x: 42, y: 99}, extra: true};
        return getX(data);
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  // Type safety tests - these should still be rejected
  test('rejects missing required field', () => {
    const diagnostics = check(`
      export let main = (): i32 => {
        let point: {x: i32, y: i32} = {x: 1};
        return point.x;
      };
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });

  test('rejects field type mismatch', () => {
    const diagnostics = check(`
      export let main = (): i32 => {
        let point: {x: i32, y: i32} = {x: 1, y: "hello"};
        return point.x;
      };
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });

  test('rejects assigning smaller to larger type', () => {
    // Cannot assign {x, y} to {x, y, z} - missing z field
    const diagnostics = check(`
      export let main = (): i32 => {
        let point: {x: i32, y: i32, z: i32} = {x: 1, y: 2};
        return point.x;
      };
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });
});

suite('Records - codegen (exact shapes only)', () => {
  // These tests verify codegen works for exact shapes (no width subtyping)
  // Width subtyping codegen requires Phase 4 (dispatch mechanism) - not yet implemented

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

  test('function with record param - exact shape', async () => {
    // When record shape matches exactly, codegen works
    const result = await compileAndRun(`
      let sumXY = (p: {x: i32, y: i32}): i32 => p.x + p.y;
      export let main = (): i32 => {
        let point = {x: 5, y: 7};
        return sumXY(point);
      };
    `);
    assert.strictEqual(result, 12);
  });

  test('record literal at call site - exact shape', async () => {
    const result = await compileAndRun(`
      let sumXY = (p: {x: i32, y: i32}): i32 => p.x + p.y;
      export let main = (): i32 => sumXY({x: 3, y: 4});
    `);
    assert.strictEqual(result, 7);
  });
});

suite('Records - width subtyping codegen', () => {
  // These tests verify width subtyping works at runtime via dispatch mechanism
  // Phase 4 implementation: fat pointers with vtables for record field access

  test('width subtyping - pass wider record to function', async () => {
    const result = await compileAndRun(`
      let getX = (p: {x: i32, y: i32}): i32 => p.x;
      export let main = (): i32 => getX({x: 5, y: 7, z: 100});
    `);
    assert.strictEqual(result, 5);
  });

  test('width subtyping - sum fields from wider record', async () => {
    const result = await compileAndRun(`
      let sumXY = (p: {x: i32, y: i32}): i32 => p.x + p.y;
      export let main = (): i32 => {
        let point = {x: 5, y: 7, z: 100};
        return sumXY(point);
      };
    `);
    assert.strictEqual(result, 12);
  });

  test('width subtyping - assign larger to smaller type', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let narrow: {x: i32, y: i32} = {x: 1, y: 2, z: 3};
        return narrow.x + narrow.y;
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('width subtyping - multiple extra fields', async () => {
    const result = await compileAndRun(`
      let getX = (p: {x: i32}): i32 => p.x;
      export let main = (): i32 => getX({x: 42, y: 1, z: 2, w: 3});
    `);
    assert.strictEqual(result, 42);
  });

  test('width subtyping - nested record widening', async () => {
    const result = await compileAndRun(`
      let getInnerX = (r: {inner: {x: i32}}): i32 => r.inner.x;
      export let main = (): i32 => {
        let data = {inner: {x: 42, y: 99}, extra: 1};
        return getInnerX(data);
      };
    `);
    assert.strictEqual(result, 42);
  });
});
