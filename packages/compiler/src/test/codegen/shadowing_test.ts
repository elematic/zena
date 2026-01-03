import {describe, it} from 'node:test';
import assert from 'node:assert';
import {compileModules} from './utils.js';

describe('Shadowing Tests', () => {
  it('User defined String class should not be treated as built-in String', () => {
    // Use a zena: prefix to avoid prelude injection
    const entryPoint = 'zena:custom';
    const modules = compileModules(
      {
        [entryPoint]: `
      export class String {
        val: i32;
        #new(v: i32) { this.val = v; }
      }

      let s = new String(123);
      // This should be a compile error because user String doesn't have index operator
      // But if the compiler checks name === 'String', it might allow it.
      let x = s[0]; 
    `,
      },
      entryPoint,
    );
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
