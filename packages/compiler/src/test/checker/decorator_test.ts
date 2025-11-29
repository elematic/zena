import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import type {Module} from '../../lib/compiler.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(input: string, path = 'zena:test') {
  const parser = new Parser(input);
  const program = parser.parse();

  const module: Module = {
    path,
    isStdlib: path.startsWith('zena:'),
    source: input,
    ast: program,
    imports: new Map(),
    exports: new Map(),
    diagnostics: [],
  };

  const checker = new TypeChecker(program, undefined, module);
  const diagnostics = checker.check();
  return {
    errors: diagnostics.filter((d) => d.severity === 1),
  };
}

suite('TypeChecker - Decorators', () => {
  test('should allow @intrinsic in zena: module', () => {
    const input = `
      extension class Array on FixedArray<i32> {
        @intrinsic("array.len")
        length(): i32 {
          return 0;
        }
      }
    `;
    const diagnostics = check(input, 'zena:array');
    assert.strictEqual(diagnostics.errors.length, 0);
  });

  test('should disallow @intrinsic in user module', () => {
    const input = `
      extension class Array on FixedArray<i32> {
        @intrinsic("array.len")
        length(): i32 {
          return 0;
        }
      }
    `;
    const diagnostics = check(input, 'user/app.zena');
    assert.ok(diagnostics.errors.length >= 1);
    assert.strictEqual(
      diagnostics.errors[0].code,
      DiagnosticCode.DecoratorNotAllowed,
    );
  });

  test('should validate intrinsic name', () => {
    const input = `
      extension class Array on FixedArray<i32> {
        @intrinsic("invalid.name")
        length(): i32 {
          return 0;
        }
      }
    `;
    const diagnostics = check(input, 'zena:array');
    assert.ok(diagnostics.errors.length >= 1);
    assert.strictEqual(
      diagnostics.errors[0].code,
      DiagnosticCode.UnknownIntrinsic,
    );
  });
});
