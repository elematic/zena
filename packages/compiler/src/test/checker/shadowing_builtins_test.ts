import {describe, it} from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Compiler} from '../../lib/compiler.js';
import {DiagnosticSeverity, type Diagnostic} from '../../lib/diagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdlibPath = path.resolve(__dirname, '../../../stdlib/zena');
console.log('stdlibPath:', stdlibPath);

class MockHost {
  files = new Map<string, string>();

  resolve(specifier: string, referrer: string) {
    return specifier;
  }

  load(specifier: string) {
    if (this.files.has(specifier)) {
      return this.files.get(specifier)!;
    }
    if (specifier.startsWith('zena:')) {
      const name = specifier.substring(5);
      const filePath = path.join(stdlibPath, `${name}.zena`);
      return fs.readFileSync(filePath, 'utf-8');
    }
    throw new Error(`File not found: ${specifier}`);
  }
}

describe('Built-in Shadowing Tests', () => {
  it('should allow shadowing i32 with string', () => {
    const host = new MockHost();
    host.files.set(
      'main.zena',
      `
      type i32 = string;
      
      export let main = () => {
        // If i32 is shadowed, this should be valid
        let s: i32 = "hello";
        
        // And this should be invalid (assigning number to string)
        let n: i32 = 123;
      };
    `,
    );

    const compiler = new Compiler(host);
    const modules = compiler.compile('main.zena');
    const main = modules.find((m) => m.path === 'main.zena')!;

    const errors = main.diagnostics.filter(
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
    const host = new MockHost();
    host.files.set(
      'main.zena',
      `
      type void = i32;
      
      export let main = (): void => {
        return 123;
      };
    `,
    );

    const compiler = new Compiler(host);
    const modules = compiler.compile('main.zena');
    const main = modules.find((m) => m.path === 'main.zena')!;

    const errors = main.diagnostics.filter(
      (d: Diagnostic) => d.severity === DiagnosticSeverity.Error,
    );
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e: Diagnostic) => e.message).join(', ')}`,
    );
  });

  it('should allow shadowing String', () => {
    const host = new MockHost();
    host.files.set(
      'main.zena',
      `
      type String = i32;
      
      export let main = () => {
        // Should be valid because String is now i32
        let s: String = 123;
        
        // Should be invalid because String is i32, not a string literal
        let t: String = "hello";
      };
    `,
    );

    const compiler = new Compiler(host);
    const modules = compiler.compile('main.zena');
    const main = modules.find((m) => m.path === 'main.zena')!;

    const errors = main.diagnostics.filter(
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
    const host = new MockHost();
    host.files.set(
      'main.zena',
      `
      type FixedArray = i32;
      
      export let main = () => {
        // Should be valid because FixedArray is now i32
        let a: FixedArray = 123;
      };
    `,
    );

    const compiler = new Compiler(host);
    const modules = compiler.compile('main.zena');
    const main = modules.find((m) => m.path === 'main.zena')!;

    const errors = main.diagnostics.filter(
      (d: Diagnostic) => d.severity === DiagnosticSeverity.Error,
    );
    assert.strictEqual(
      errors.length,
      0,
      `Expected no errors, got: ${errors.map((e: Diagnostic) => e.message).join(', ')}`,
    );
  });
});
