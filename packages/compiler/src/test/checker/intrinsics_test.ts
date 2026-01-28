import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(input: string, path = 'zena:test') {
  const isStdlib = path.startsWith('zena:');
  const parser = new Parser(input, {path, isStdlib});
  const module = parser.parse();

  const checker = TypeChecker.forModule(module);
  const diagnostics = checker.check();
  return {
    errors: diagnostics.filter((d) => d.severity === 1),
  };
}

suite('TypeChecker - Intrinsics', () => {
  test('should resolve __array_len intrinsic in zena: module', () => {
    const input = `
      let test = (a: array<i32>) => {
        let l = __array_len(a);
      };
    `;
    const diagnostics = check(input, 'zena:array');
    assert.strictEqual(diagnostics.errors.length, 0);
  });

  test('should NOT resolve __array_len intrinsic in user module', () => {
    const input = `
      let test = (a: array<i32>) => {
        let l = __array_len(a);
      };
    `;
    const diagnostics = check(input, 'user/app.zena');
    assert.ok(diagnostics.errors.length >= 1);
    assert.strictEqual(
      diagnostics.errors[0].code,
      DiagnosticCode.SymbolNotFound,
    );
    assert.match(diagnostics.errors[0].message, /__array_len/);
  });

  test('should resolve __array_get intrinsic', () => {
    const input = `
      let test = (a: array<i32>) => {
        let x: i32 = __array_get(a, 0);
      };
    `;
    const diagnostics = check(input);
    assert.strictEqual(diagnostics.errors.length, 0);
  });

  test('should resolve __array_set intrinsic', () => {
    const input = `
      let test = (a: array<i32>) => {
        __array_set(a, 0, 10);
      };
    `;
    const diagnostics = check(input);
    assert.strictEqual(diagnostics.errors.length, 0);
  });

  test('should check types for intrinsics', () => {
    const input = `
      let test = (a: array<i32>) => {
        let l: string = __array_len(a); // Error: i32 vs string
      };
    `;
    const diagnostics = check(input);
    assert.strictEqual(diagnostics.errors.length, 1);
  });

  test('should resolve __array_new intrinsic', () => {
    const input = `
      let test = () => {
        let a: array<i32> = __array_new(10, 0);
      };
    `;
    const diagnostics = check(input);
    assert.strictEqual(diagnostics.errors.length, 0);
  });
});
