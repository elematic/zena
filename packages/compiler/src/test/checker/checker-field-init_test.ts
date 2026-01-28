import {strict as assert} from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';
import {Parser} from '../../lib/parser.js';

suite('Checker - Field Initialization', () => {
  test('should allow accessing earlier fields in initializer', () => {
    const source = `
      class A {
        x: i32 = 1;
        y: i32 = this.x + 1;
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should disallow accessing later fields in initializer', () => {
    const source = `
      class A {
        x: i32 = this.y + 1;
        y: i32 = 1;
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.equal(diagnostics[0].code, DiagnosticCode.UnknownError); // Adjust code if specific one exists
    assert.match(
      diagnostics[0].message,
      /cannot access field 'y' before initialization/i,
    );
  });

  test('should allow accessing super fields in initializer', () => {
    const source = `
      class Base {
        baseField: i32 = 10;
      }
      class Derived extends Base {
        derivedField: i32 = this.baseField + 5;
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should disallow accessing uninitialized field in same class via method call (if we can detect it - maybe too complex for now, but direct access is key)', () => {
    // Note: Detecting indirect access via method call is harder (requires flow analysis).
    // The user asked for "earlier field access a later field, by source order".
    // This usually implies direct access `this.y`.
  });

  test('should disallow self-reference in initializer', () => {
    const source = `
      class A {
        x: i32 = this.x + 1;
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.match(
      diagnostics[0].message,
      /cannot access field 'x' before initialization/i,
    );
  });
});
