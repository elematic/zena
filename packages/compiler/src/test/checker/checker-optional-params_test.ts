import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(source: string) {
  const parser = new Parser(source);
  const program = parser.parse();
  const checker = new TypeChecker(program);
  return checker.check();
}

suite('Checker - Optional Parameters', () => {
  test('should allow optional parameter without default', () => {
    const diagnostics = check(`
      let f = (x?: i32) => {};
      f(10);
      f();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should infer optional parameter type as union with null', () => {
    const diagnostics = check(`
      let f = (x?: i32) => {
        let y: i32 | null = x; // Should be assignable
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should allow passing null to optional parameter', () => {
    const diagnostics = check(`
      let f = (x?: i32) => {};
      f(null);
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if passing wrong type to optional parameter', () => {
    const diagnostics = check(`
      let f = (x?: i32) => {};
      f("hello");
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should support optional parameters in methods', () => {
    const diagnostics = check(`
      class C {
        m(x?: i32) {}
      }
      let c = new C();
      c.m(10);
      c.m();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support optional parameters in constructors', () => {
    const diagnostics = check(`
      class C {
        x: i32 | null;
        #new(x?: i32) {
          this.x = x;
        }
      }
      let c1 = new C(10);
      let c2 = new C();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support optional parameters in interfaces', () => {
    const diagnostics = check(`
      interface I {
        m(x?: i32): void;
      }
      class C implements I {
        m(x?: i32) {}
      }
      let i: I = new C();
      i.m(10);
      i.m();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support optional parameters in mixins', () => {
    const diagnostics = check(`
      mixin M {
        m(x?: i32) {}
      }
      class C with M {}
      let c = new C();
      c.m(10);
      c.m();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support optional parameters in declare function', () => {
    const diagnostics = check(`
      @external("env", "f")
      declare function f(x?: i32): void;
      f(10);
      f();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });
});
