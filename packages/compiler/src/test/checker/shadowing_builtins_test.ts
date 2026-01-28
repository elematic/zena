import {describe, it} from 'node:test';
import assert from 'node:assert';
import {compileModules} from '../codegen/utils.js';
import {DiagnosticSeverity, type Diagnostic} from '../../lib/diagnostics.js';

describe('Built-in Shadowing Tests', () => {
  it('should allow shadowing i32 with string', () => {
    const modules = compileModules(`
      type i32 = string;
      
      export let main = () => {
        // If i32 is shadowed, this should be valid
        let s: i32 = "hello";
        
        // And this should be invalid (assigning number to string)
        let n: i32 = 123;
      };
    `);
    const main = modules.find((m) => m.path === '/main.zena')!;

    const errors = main.diagnostics!.filter(
      (d: Diagnostic) => d.severity === DiagnosticSeverity.Error,
    );

    // We expect shadowing to work, so we expect error on line 9 (n: i32 = 123)
    // We do NOT expect error on line 6 (s: i32 = "hello")

    // Note: Location might be undefined in some test environments, so we rely on the message.
    const stringAssignError = errors.find(
      (e: Diagnostic) =>
        e.message.includes('Type mismatch') && e.message.includes('got String'),
    );
    const numberAssignError = errors.find(
      (e: Diagnostic) =>
        e.message.includes('Type mismatch') && e.message.includes('got i32'),
    );

    if (stringAssignError) {
      assert.fail(`Failed to shadow i32: ${stringAssignError.message}`);
    }

    assert.ok(
      numberAssignError,
      'Should have error assigning number to shadowed i32 (string)',
    );
  });

  it('should allow shadowing void', () => {
    const modules = compileModules(`
      type void = i32;
      
      export let main = (): void => {
        return 123;
      };
    `);
    const main = modules.find((m) => m.path === '/main.zena')!;

    const errors = main.diagnostics!.filter(
      (d: Diagnostic) => d.severity === DiagnosticSeverity.Error,
    );
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e: Diagnostic) => e.message).join(', ')}`,
    );
  });

  it('should allow shadowing String', () => {
    const modules = compileModules(`
      type String = i32;
      
      export let main = () => {
        // Should be valid because String is now i32
        let s: String = 123;
        
        // Should be invalid because String is i32, not a string literal
        let t: String = "hello";
      };
    `);
    const main = modules.find((m) => m.path === '/main.zena')!;

    const errors = main.diagnostics!.filter(
      (d: Diagnostic) => d.severity === DiagnosticSeverity.Error,
    );

    const stringAssignError = errors.find(
      (e: Diagnostic) =>
        e.message.includes('Type mismatch') && e.message.includes('got String'),
    );
    assert.ok(
      stringAssignError,
      'Should have error assigning string literal to shadowed String (i32)',
    );

    // Ensure no error for the valid assignment
    const numberAssignError = errors.find(
      (e: Diagnostic) =>
        e.message.includes('Type mismatch') && e.message.includes('got i32'),
    );
    if (numberAssignError) {
      assert.fail(`Failed to shadow String: ${numberAssignError.message}`);
    }
  });

  it('should allow shadowing FixedArray', () => {
    const modules = compileModules(`
      type FixedArray = i32;
      
      export let main = () => {
        // Should be valid because FixedArray is now i32
        let a: FixedArray = 123;
      };
    `);
    const main = modules.find((m) => m.path === '/main.zena')!;

    const errors = main.diagnostics!.filter(
      (d: Diagnostic) => d.severity === DiagnosticSeverity.Error,
    );
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e: Diagnostic) => e.message).join(', ')}`,
    );
  });
});
