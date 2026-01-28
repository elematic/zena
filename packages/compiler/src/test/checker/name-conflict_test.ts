import assert from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

suite('TypeChecker - Name Conflicts', () => {
  test('should detect conflict between field and method with same name', () => {
    const input = `
      class Foo {
        x: i32;
        x(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.ok(errors.length > 0);
    assert.strictEqual(errors[0].code, DiagnosticCode.DuplicateDeclaration);
  });

  test('should NOT detect conflict between field and manual getter (field first)', () => {
    const input = `
      class Foo {
        x: i32;
        get_x(): i32 { return 0; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(
      errors.length,
      0,
      'Should NOT report error for get_x vs x',
    );
  });

  test('should NOT detect conflict between field and manual getter (method first)', () => {
    const input = `
      class Foo {
        get_x(): i32 { return 0; }
        x: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(
      errors.length,
      0,
      'Should NOT report error for get_x vs x',
    );
  });

  test('should NOT detect conflict between accessor and manual getter', () => {
    const input = `
      class Foo {
        get_x(): i32 { return 0; }
        x: i32 { get { return 0; } }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(
      errors.length,
      0,
      'Should NOT report error for get_x vs x accessor',
    );
  });

  test('should NOT detect conflict between interface field and method', () => {
    const input = `
      interface Foo {
        x: i32;
        get_x(): void;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(
      errors.length,
      0,
      'Should NOT report error for interface get_x vs x',
    );
  });

  test('should NOT detect conflict between interface method and field', () => {
    const input = `
      interface Foo {
        get_x(): void;
        x: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(
      errors.length,
      0,
      'Should NOT report error for interface get_x vs x',
    );
  });
});
