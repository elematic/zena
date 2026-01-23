import {strict as assert} from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';
import {Parser} from '../../lib/parser.js';

suite('Checker - Super', () => {
  test('should allow super call in constructor', () => {
    const source = `
      class A {
        #new(x: i32) {}
      }
      class B extends A {
        #new(x: i32) {
          super(x);
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = TypeChecker.forProgram(program);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should detect super call outside constructor', () => {
    const source = `
      class A {}
      class B extends A {
        foo() {
          super();
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = TypeChecker.forProgram(program);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.equal(diagnostics[0].code, DiagnosticCode.UnknownError); // 'super' call can only be used inside a class constructor
  });

  test('should detect super call with wrong arguments', () => {
    const source = `
      class A {
        #new(x: i32) {}
      }
      class B extends A {
        #new() {
          super();
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = TypeChecker.forProgram(program);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.equal(diagnostics[0].code, DiagnosticCode.ArgumentCountMismatch);
  });

  test('should allow super method call', () => {
    const source = `
      class A {
        foo(): i32 { return 1; }
      }
      class B extends A {
        bar(): i32 {
          return super.foo();
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = TypeChecker.forProgram(program);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should allow super field access', () => {
    const source = `
      class A {
        x: i32;
      }
      class B extends A {
        getX(): i32 {
          return super.x;
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = TypeChecker.forProgram(program);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });
});
