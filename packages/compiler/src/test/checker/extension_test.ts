import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(input: string) {
  const parser = new Parser(input);
  const program = parser.parse();
  const checker = new TypeChecker(program);
  const diagnostics = checker.check();
  return {
    errors: diagnostics.filter((d) => d.severity === 1),
  };
}

suite('TypeChecker - Extension Types', () => {
  test('should allow extension class on array', () => {
    const input = `
      extension class Array on FixedArray<i32> {
        static #new() {}
        length: i32 { get { return 0; } }
      }
    `;
    const diagnostics = check(input);
    if (diagnostics.errors.length > 0) {
      console.log(diagnostics.errors);
    }
    assert.strictEqual(diagnostics.errors.length, 0);
  });

  test('should disallow instance fields in extension class', () => {
    const input = `
      extension class Array on FixedArray<i32> {
        x: i32; // Error
      }
    `;
    const diagnostics = check(input);
    if (diagnostics.errors.length !== 1) {
      console.log(diagnostics.errors);
    }
    assert.strictEqual(diagnostics.errors.length, 1);
    assert.strictEqual(
      diagnostics.errors[0].code,
      DiagnosticCode.ExtensionClassField,
    );
  });

  test('should allow static fields in extension class', () => {
    const input = `
      extension class Array on FixedArray<i32> {
        static MAX_SIZE: i32 = 100;
      }
    `;
    const diagnostics = check(input);
    if (diagnostics.errors.length > 0) {
      console.log(diagnostics.errors);
    }
    assert.strictEqual(diagnostics.errors.length, 0);
  });

  test('should resolve "this" to underlying type', () => {
    const input = `
      extension class Array on FixedArray<i32> {
        test() {
          let a: FixedArray<i32> = this; // Should be valid
        }
      }
    `;
    const diagnostics = check(input);
    if (diagnostics.errors.length > 0) {
      console.log(diagnostics.errors);
    }
    assert.strictEqual(diagnostics.errors.length, 0);
  });
});
