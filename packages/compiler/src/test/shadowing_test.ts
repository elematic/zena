import {describe, it} from 'node:test';
import assert from 'node:assert';
import {Compiler, type CompilerHost} from '../lib/compiler.js';

class MockHost implements CompilerHost {
  files = new Map<string, string>();

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) {
      return specifier;
    }
    if (specifier.startsWith('./')) {
      return specifier.substring(2);
    }
    return specifier;
  }

  load(path: string): string {
    if (this.files.has(path)) {
      return this.files.get(path)!;
    }
    if (path.startsWith('zena:')) {
      if (path === 'zena:string')
        return 'export final class String { bytes: ByteArray; length: i32; }';
      if (path === 'zena:array')
        return 'export final class FixedArray<T> { length: i32; }';
      if (path === 'zena:console')
        return 'export class Console {} export let console = new Console();';
      return '';
    }
    throw new Error(`File not found: ${path}`);
  }
}

describe('Shadowing Tests', () => {
  it('User defined String class should not be treated as built-in String', () => {
    const host = new MockHost();
    // Use a zena: prefix to avoid prelude injection
    const entryPoint = 'zena:custom';
    host.files.set(
      entryPoint,
      `
      export class String {
        val: i32;
        #new(v: i32) { this.val = v; }
      }

      let s = new String(123);
      // This should be a compile error because user String doesn't have index operator
      // But if the compiler checks name === 'String', it might allow it.
      let x = s[0]; 
    `,
    );

    const compiler = new Compiler(host);
    const modules = compiler.compile(entryPoint);
    const main = modules.find((m) => m.path === entryPoint);

    // We expect an error here because our String is not indexable.
    // If diagnostics is empty, it means the compiler incorrectly allowed it.
    if (main?.diagnostics.length === 0) {
      assert.fail(
        'Expected diagnostics, but got none. Compiler incorrectly allowed indexing on user String class.',
      );
    }
  });
});
