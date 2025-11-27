import {describe, it} from 'node:test';
import assert from 'node:assert';
import {Compiler, type CompilerHost} from '../lib/compiler.js';

class MockHost implements CompilerHost {
  files = new Map<string, string>();

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) {
      return specifier;
    }
    // Simple relative resolution mock
    if (specifier.startsWith('./')) {
      return specifier.substring(2); // Remove ./
    }
    return specifier;
  }

  load(path: string): string {
    if (this.files.has(path)) {
      return this.files.get(path)!;
    }
    throw new Error(`File not found: ${path}`);
  }
}

describe('Compiler', () => {
  it('loads entry point and dependencies', () => {
    const host = new MockHost();
    host.files.set(
      'main.zena',
      `
      import { add } from './math.zena';
      let x = add(1, 2);
    `,
    );
    host.files.set(
      'math.zena',
      `
      export let add = (a: i32, b: i32) => a + b;
    `,
    );

    const compiler = new Compiler(host);
    const modules = compiler.compile('main.zena');

    assert.strictEqual(modules.length, 2);

    const main = modules.find((m) => m.path === 'main.zena');
    const math = modules.find((m) => m.path === 'math.zena');

    assert.ok(main);
    assert.ok(math);

    assert.strictEqual(main?.imports.get('./math.zena'), 'math.zena');
  });

  it('handles circular dependencies', () => {
    const host = new MockHost();
    host.files.set('a.zena', `import { b } from './b.zena';`);
    host.files.set('b.zena', `import { a } from './a.zena';`);

    const compiler = new Compiler(host);
    const modules = compiler.compile('a.zena');

    assert.strictEqual(modules.length, 2);
  });
});
