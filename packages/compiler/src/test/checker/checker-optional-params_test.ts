import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(source: string) {
  const parser = new Parser(source);
  const program = parser.parse();
  const checker = TypeChecker.forProgram(program);
  return checker.check();
}

suite('Checker - Optional Parameters', () => {
  test('should allow optional parameter without default', () => {
    const diagnostics = check(`
      let f = (x?: string) => {};
      f("hello");
      f();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should infer optional parameter type as union with null', () => {
    const diagnostics = check(`
      let f = (x?: string) => {
        let y: string | null = x; // Should be assignable
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should allow passing null to optional parameter', () => {
    const diagnostics = check(`
      let f = (x?: string) => {};
      f(null);
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if passing wrong type to optional parameter', () => {
    const diagnostics = check(`
      let f = (x?: string) => {};
      f(123);
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should support optional parameters in methods', () => {
    const diagnostics = check(`
      class C {
        m(x?: string) {}
      }
      let c = new C();
      c.m("hello");
      c.m();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support optional parameters in constructors', () => {
    const diagnostics = check(`
      class C {
        x: string | null;
        #new(x?: string) {
          this.x = x;
        }
      }
      let c1 = new C("hello");
      let c2 = new C();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support optional parameters in interfaces', () => {
    const diagnostics = check(`
      interface I {
        m(x?: string): void;
      }
      class C implements I {
        m(x?: string) {}
      }
      let i: I = new C();
      i.m("hello");
      i.m();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support optional parameters in mixins', () => {
    const diagnostics = check(`
      mixin M {
        m(x?: string) {}
      }
      class C with M {}
      let c = new C();
      c.m("hello");
      c.m();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should support optional parameters in declare function', () => {
    const diagnostics = check(`
      @external("env", "f")
      declare function f(x?: string): void;
      f("hello");
      f();
    `);
    assert.strictEqual(diagnostics.length, 0);
  });
});
