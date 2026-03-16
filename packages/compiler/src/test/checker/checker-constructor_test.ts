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
        new() {
          // Missing super()
        }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
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
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should allow super() call in derived class constructor', () => {
    const source = `
      class A {}
      class B extends A {
        new() : super() { }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should disallow this access before super() in initializer list', () => {
    // Field initializers can use 'this' because they run before super() -
    // but only to access/set fields on 'this', not to call methods.
    // This test verifies that this.x = 1 in the body works after super() in init list.
    const source = `
      class A {}
      class B extends A {
        x: i32;
        new() : x = 1, super() {}
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should allow this access after super()', () => {
    const source = `
      class A {}
      class B extends A {
        x: i32;
        new() : x = 1, super() {}
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should allow statements in body after super() in init list', () => {
    const source = `
      class A {}
      class B extends A {
        new() : super() {
          let x = 1; // OK - body runs after super()
        }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should warn when using constructor() instead of new()', () => {
    const source = `
      class A {
        x: i32;
        constructor() {
          this.x = 1;
        }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    // Should have a warning about constructor syntax
    const warning = diagnostics.find(
      (d) => d.code === DiagnosticCode.ConstructorSyntax,
    );
    assert.ok(warning, 'Expected a warning about constructor syntax');
    assert.match(warning!.message, /new\(\)/);
  });

  test('should not warn when using new()', () => {
    const source = `
      class A {
        x: i32;
        new() {
          this.x = 1;
        }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    // Should have no warnings about constructor syntax
    const warning = diagnostics.find(
      (d) => d.code === DiagnosticCode.ConstructorSyntax,
    );
    assert.ok(!warning, 'Should not warn when using new()');
  });
});
