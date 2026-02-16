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

// Phase 5 optimization tests: Direct access on record literals bypasses vtable dispatch
suite('Records - direct access optimization (Phase 5)', () => {
  test('direct field access on literal - single field', async () => {
    // Accessing a field directly on a literal uses struct.get, not vtable dispatch
    // Note: Record literal at start of expression needs parens to disambiguate from block
    const result = await compileAndRun(`
      export let main = (): i32 => ({x: 42}).x;
    `);
    assert.strictEqual(result, 42);
  });

  test('direct field access on literal - multiple fields', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => ({a: 10, b: 20, c: 30}).b;
    `);
    assert.strictEqual(result, 20);
  });

  test('direct field access on literal - return expression', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        return {x: 1, y: 2, z: 3}.z;
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('direct field access on literal - in binary expression', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => ({x: 10}).x + ({y: 20}).y;
    `);
    assert.strictEqual(result, 30);
  });

  test('direct field access on nested literal', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => ({inner: {value: 99}}).inner.value;
    `);
    assert.strictEqual(result, 99);
  });

  test('direct field access - complex expression still works', async () => {
    // This test verifies that non-literal access still works through dispatch
    const result = await compileAndRun(`
      let identity = (r: {x: i32}): {x: i32} => r;
      export let main = (): i32 => identity({x: 50}).x;
    `);
    assert.strictEqual(result, 50);
  });
});

suite('Records - concrete type tracking optimization', () => {
  test('direct access through immutable binding to literal', async () => {
    // let p = {x: 1}; p.x should use direct access
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let point = {x: 42, y: 10};
        return point.x + point.y;
      };
    `);
    assert.strictEqual(result, 52);
  });

  test('direct access through function return', async () => {
    // let p = getPoint(); p.x should use direct access when return type is exact
    const result = await compileAndRun(`
      let getPoint = (): {x: i32, y: i32} => ({x: 100, y: 200});
      export let main = (): i32 => {
        let point = getPoint();
        return point.x + point.y;
      };
    `);
    assert.strictEqual(result, 300);
  });

  test('direct access through inferred function return', async () => {
    // Without explicit return type annotation, type is inferred
    const result = await compileAndRun(`
      let getPoint = () => ({x: 5, y: 7});
      export let main = (): i32 => {
        let point = getPoint();
        return point.x * point.y;
      };
    `);
    assert.strictEqual(result, 35);
  });

  test('no optimization for mutable binding', async () => {
    // var p = {x: 1}; p.x must use dispatch since p could be reassigned
    const result = await compileAndRun(`
      export let main = (): i32 => {
        var point = {x: 10, y: 20};
        point = {x: 30, y: 40};
        return point.x;
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('chained binding optimization', async () => {
    // let a = {x: 1}; let b = a; b.x should work (a is exact type)
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let a = {value: 99};
        let b = a;
        return b.value;
      };
    `);
    assert.strictEqual(result, 99);
  });

  test('width subtyping still works with function params', async () => {
    // When width subtyping is in play, dispatch must be used
    const result = await compileAndRun(`
      let getX = (p: {x: i32}): i32 => p.x;
      export let main = (): i32 => {
        let wider = {x: 5, y: 10, z: 15};
        return getX(wider);
      };
    `);
    assert.strictEqual(result, 5);
  });

  test('interning enables optimization across different field orders', async () => {
    // {x, y} and {y, x} have same interned type, so optimization applies
    const result = await compileAndRun(`
      let getOrigin = () => ({x: 0, y: 0});
      let getPoint = () => ({y: 100, x: 50});
      let a = true;
      export let main = (): i32 => {
        let point: {x: i32, y: i32} = if (a) { getOrigin() } else { getPoint() };
        return point.x + point.y;
      };
    `);
    // Should get origin (0, 0) since a = true
    assert.strictEqual(result, 0);
  });

  test('interning enables optimization with type annotation', async () => {
    // Type annotation {x: i32, y: i32} matches literal {y: 1, x: 1} after interning
    const result = await compileAndRun(`
      let getPoint = (): {x: i32, y: i32} => ({y: 7, x: 3});
      export let main = (): i32 => {
        let point = getPoint();
        return point.x * point.y;
      };
    `);
    assert.strictEqual(result, 21);
  });

  test('interning works without explicit type annotation on if expression', async () => {
    // Both branches return same interned type, so optimization works
    const result = await compileAndRun(`
      let getOrigin = () => ({x: 0, y: 0});
      let getPoint = () => ({y: 100, x: 50});
      let a = false;
      export let main = (): i32 => {
        let point = if (a) { getOrigin() } else { getPoint() };
        return point.x + point.y;
      };
    `);
    // Should get point (50, 100) since a = false
    assert.strictEqual(result, 150);
  });

  test.skip('function param with optional property uses dispatch (not optimized)', async () => {
    // KNOWN BUG: Optional properties in record params cause WASM type mismatch
    // See BUGS.md for details
    // Parameter type {foo: i32, bar?: i32} differs from call site {foo: i32}
    // Must use dispatch because param could receive wider types
    const result = await compileAndRun(`
      let go = (opts: {foo: i32, bar?: i32}): i32 => opts.foo;
      export let main = (): i32 => go({foo: 42});
    `);
    assert.strictEqual(result, 42);
  });

  test('function param exact match could be optimized in future', async () => {
    // Even though call site type matches param type exactly,
    // we currently don't optimize params (would need inlining or monomorphization)
    const result = await compileAndRun(`
      let go = (opts: {foo: i32}): i32 => opts.foo;
      export let main = (): i32 => go({foo: 99});
    `);
    assert.strictEqual(result, 99);
  });
});
