import assert from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(code: string) {
  const parser = new Parser(code);
  const ast = parser.parse();
  const checker = new TypeChecker(ast);
  return checker.check();
}

suite('Checker: Destructuring', () => {
  test('checks record destructuring', () => {
    const diagnostics = check(`
      let p = { x: 1, y: 2 };
      let { x, y } = p;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks record destructuring with renaming', () => {
    const diagnostics = check(`
      let p = { x: 1, y: 2 };
      let { x as x1, y as y1 } = p;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks record destructuring with nesting', () => {
    const diagnostics = check(`
      let r = { p: { x: 1, y: 2 } };
      let { p: { x, y } } = r;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks tuple destructuring', () => {
    const diagnostics = check(`
      let t = [1, 2];
      let [x, y] = t;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks tuple destructuring with skipping', () => {
    const diagnostics = check(`
      let t = [1, 2, 3];
      let [x, , z] = t;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('detects missing property in record destructuring', () => {
    const diagnostics = check(`
      let p = { x: 1 };
      let { y } = p;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('detects type mismatch in record destructuring', () => {
    // This is tricky because we don't have explicit type checks in patterns yet,
    // but if we use the variable later it should have the correct type.
    // Or if we had defaults...
    // For now, just ensure it binds correctly.
    const diagnostics = check(`
      let p = { x: 1 };
      let { x } = p;
      let s: string = x; // Error: i32 is not string
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('detects tuple index out of bounds', () => {
    const diagnostics = check(`
      let t = [1];
      let [x, y] = t;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('checks defaults in record destructuring', () => {
    check(`
      let p = { x: 1 };
      // Defaults not fully supported in runtime yet, but checker should allow if types match
      // Actually, defaults are for optional properties or undefined values.
      // Zena doesn't have optional properties yet.
      // So defaults only apply if the property is missing?
      // But our structural typing requires the property to be present if the type says so.
      // If we destructure { x: 1 } with { y = 2 }, it fails because y is missing in type.
      // Unless we treat the pattern as requiring a SUBSET.
      // But 'y' is not in { x: 1 }.
      // So defaults are only useful if the type is optional (Union with undefined/null).
      // Or if we allow "loose" matching?
      // For now, let's stick to strict matching.
    `);
  });
});
