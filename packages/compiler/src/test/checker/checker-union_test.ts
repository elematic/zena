import {suite, test} from 'node:test';
import assert from 'node:assert';
import {DiagnosticCode} from '../../lib/diagnostics.js';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

function check(source: string) {
  const parser = new Parser(source);
  const module = parser.parse();
  const checker = TypeChecker.forModule(module);
  return checker.check();
}

suite('Checker: Union Types', () => {
  test('should support union type annotation', () => {
    const diagnostics = check(`
      class A {}
      class B {}
      let x: A | B = new A();
      let y: A | B = new B();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support null in union', () => {
    const diagnostics = check(`
      let x: string | null = "hello";
      let y: string | null = null;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if type is not in union', () => {
    const diagnostics = check(`
      class A {}
      class B {}
      let x: A | B = "hello";
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should support union in function parameters', () => {
    const diagnostics = check(`
      class A {}
      class B {}
      let f = (x: A | B) => {};
      f(new A());
      f(new B());
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if argument is not in union', () => {
    const diagnostics = check(`
      class A {}
      class B {}
      let f = (x: A | B) => {};
      f("hello");
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should support union in class fields', () => {
    const diagnostics = check(`
      class A {}
      class Box {
        value: A | string;
      }
      let b = new Box();
      b.value = new A();
      b.value = "hello";
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if field assignment is not in union', () => {
    const diagnostics = check(`
      class A {}
      class Box {
        value: A | string;
      }
      let b = new Box();
      b.value = true;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should support union return type', () => {
    const diagnostics = check(`
      class A {}
      let f = (x: boolean): A | string => {
        if (x) {
          return new A();
        } else {
          return "hello";
        }
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if return value is not in union', () => {
    const diagnostics = check(`
      class A {}
      let f = (): A | string => {
        return true;
      };
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should filter never from union', () => {
    const diagnostics = check(`
      class Error {}
      // if-expression returns i32 | never, which should simplify to i32
      let x: i32 = if (true) { 1 } else { throw new Error() };
      
      let y: i32 = x; // Should succeed
    `);
    assert.strictEqual(diagnostics.length, 0);
  });
});
