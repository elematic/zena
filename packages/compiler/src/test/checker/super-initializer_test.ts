import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {checkSource} from '../codegen/utils.js';
import {DiagnosticSeverity} from '../../lib/diagnostics.js';

suite('Super Initializer in Constructor', () => {
  test('valid super() in derived class initializer list', () => {
    const errors = checkSource(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        y: i32;
        new(a: i32, b: i32) : y = b, super(a) {}
      }
      export let main = (): i32 => {
        let d = new Derived(1, 2);
        return d.x + d.y;
      };
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('super() with no arguments in derived class', () => {
    const errors = checkSource(`
      class Base {
        new() {}
      }
      class Derived extends Base {
        x: i32;
        new(x: i32) : x = x, super() {
        }
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('super() only in initializer list (no field initializers)', () => {
    const errors = checkSource(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        new(x: i32) : super(x) {}
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('error: super() in base class (no superclass)', () => {
    const errors = checkSource(`
      class Base {
        x: i32;
        new(x: i32) : x = x, super() {
        }
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.ok(
      errors.some((e) => e.message.includes('does not have a superclass')),
      `Expected error about no superclass, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('error: super() with wrong number of arguments', () => {
    const errors = checkSource(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        new() : super() {}
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.ok(
      errors.some((e) => e.message.includes('Expected 1 arguments, got 0')),
      `Expected argument count error, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('error: super() with wrong argument type', () => {
    const errors = checkSource(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        new() : super('hello') {}
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.ok(
      errors.some(
        (e) =>
          e.message.includes('Type mismatch') ||
          e.message.includes('not assignable'),
      ),
      `Expected type mismatch error, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('super() initializes this (allows field access after super)', () => {
    // After super() in initializer list, `this` is initialized
    // This is checked by checking no errors when accessing fields in body
    const errors = checkSource(`
      class Base {
        x: i32;
        new(x: i32) : x = x {}
      }
      class Derived extends Base {
        y: i32;
        new(a: i32, b: i32) : y = b, super(a) {
          // After super(), we can access this.x and this.y
          let sum = this.x + this.y;
        }
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('super() with superclass that has no constructor', () => {
    const errors = checkSource(`
      class Base {
        x: i32 = 10;
      }
      class Derived extends Base {
        y: i32;
        new(y: i32) : y = y, super() {
        }
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('error: super() with args when superclass has no constructor', () => {
    const errors = checkSource(`
      class Base {
        x: i32 = 10;
      }
      class Derived extends Base {
        new() : super(42) {
        }
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.ok(
      errors.some((e) =>
        e.message.includes('has no constructor but arguments were provided'),
      ),
      `Expected error about no constructor, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('extension class with super() in initializer list', () => {
    const errors = checkSource(`
      extension class MyInt on i32 {
        new(value: i32) : super(value) {
        }
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('error: extension class super() with wrong type', () => {
    const errors = checkSource(`
      extension class MyInt on i32 {
        new(value: string) : super(value) {
        }
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.ok(
      errors.some((e) => e.message.includes('Type mismatch')),
      `Expected type mismatch error, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });

  test('error: extension class super() with multiple args', () => {
    const errors = checkSource(`
      extension class MyInt on i32 {
        new(a: i32, b: i32) : super(a, b) {
        }
      }
      export let main = (): i32 => 0;
    `).filter((d) => d.severity === DiagnosticSeverity.Error);
    assert.ok(
      errors.some((e) => e.message.includes('exactly one argument')),
      `Expected error about exactly one argument, got: ${errors.map((e) => e.message).join(', ')}`,
    );
  });
});
