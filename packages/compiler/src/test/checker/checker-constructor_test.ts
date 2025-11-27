import {strict as assert} from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';
import {Parser} from '../../lib/parser.js';

suite('Checker - Constructor Rules', () => {
  test('should require super() call in derived class constructor', () => {
    const source = `
      class A {}
      class B extends A {
        #new() {
          // Missing super()
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = new TypeChecker(program);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.equal(diagnostics[0].code, DiagnosticCode.UnknownError);
    assert.match(diagnostics[0].message, /must call 'super\(\)'/);
  });

  test('should allow derived classes with no constructor', () => {
    const source = `
      class A {}
      class B extends A {}
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = new TypeChecker(program);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should allow super() call in derived class constructor', () => {
    const source = `
      class A {}
      class B extends A {
        #new() {
          super();
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = new TypeChecker(program);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should disallow this access before super()', () => {
    const source = `
      class A {}
      class B extends A {
        x: i32;
        #new() {
          this.x = 1; // Error
          super();
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = new TypeChecker(program);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.equal(diagnostics[0].code, DiagnosticCode.UnknownError);
    assert.match(
      diagnostics[0].message,
      /cannot be accessed before 'super\(\)'/,
    );
  });

  test('should allow this access after super()', () => {
    const source = `
      class A {}
      class B extends A {
        x: i32;
        #new() {
          super();
          this.x = 1; // OK
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = new TypeChecker(program);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should allow statements before super() if they do not use this', () => {
    const source = `
      class A {}
      class B extends A {
        #new() {
          let x = 1;
          super();
        }
      }
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = new TypeChecker(program);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });
});
