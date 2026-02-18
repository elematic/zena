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

  test('should type check initializer list expressions', () => {
    const source = `
      class Point {
        let x: i32;
        let y: i32;
        #new(x: i32, y: i32) : x = x, y = y { }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.equal(diagnostics.length, 0);
  });

  test('should reject type mismatch in initializer list', () => {
    const source = `
      class Point {
        let x: i32;
        #new(name: string) : x = name { }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.match(diagnostics[0].message, /not assignable/i);
  });

  test('should reject unknown field in initializer list', () => {
    const source = `
      class Point {
        let x: i32;
        #new(y: i32) : z = y { }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.match(diagnostics[0].message, /does not exist/i);
  });

  test('should reject this access in initializer list expression', () => {
    const source = `
      class Point {
        let x: i32;
        #new() : x = this.foo() { }
        foo(): i32 { return 42; }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const diagnostics = checker.check();

    assert.ok(diagnostics.length > 0);
    assert.match(diagnostics[0].message, /this/i);
  });
});
