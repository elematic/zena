import {describe, it} from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Compiler, type CompilerHost} from '../../lib/compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdlibPath = path.resolve(__dirname, '../../../stdlib/zena');

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

  load(specifier: string): string {
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
