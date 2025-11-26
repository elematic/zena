import {suite, test} from 'node:test';
import assert from 'node:assert';
import {DiagnosticCode} from '../../lib/diagnostics.js';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

function check(source: string) {
  const parser = new Parser(source);
  const program = parser.parse();
  const checker = new TypeChecker(program);
  return checker.check();
}

suite('Checker: Union Types', () => {
  test('should support union type annotation', () => {
    const diagnostics = check(`
      let x: i32 | boolean = 10;
      let y: i32 | boolean = true;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support null in union', () => {
    const diagnostics = check(`
      let x: i32 | null = 10;
      let y: i32 | null = null;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if type is not in union', () => {
    const diagnostics = check(`
      let x: i32 | boolean = "hello";
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should support union in function parameters', () => {
    const diagnostics = check(`
      let f = (x: i32 | boolean) => {};
      f(10);
      f(true);
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if argument is not in union', () => {
    const diagnostics = check(`
      let f = (x: i32 | boolean) => {};
      f("hello");
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should support union in class fields', () => {
    const diagnostics = check(`
      class Box {
        value: i32 | string;
      }
      let b = new Box();
      b.value = 10;
      b.value = "hello";
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if field assignment is not in union', () => {
    const diagnostics = check(`
      class Box {
        value: i32 | string;
      }
      let b = new Box();
      b.value = true;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should support union return type', () => {
    const diagnostics = check(`
      let f = (x: boolean): i32 | string => {
        if (x) {
          return 10;
        } else {
          return "hello";
        }
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if return value is not in union', () => {
    const diagnostics = check(`
      let f = (): i32 | string => {
        return true;
      };
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });
});
