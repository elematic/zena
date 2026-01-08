/**
 * Tests for LibraryLoader class.
 */
import {suite, test} from 'node:test';
import {strict as assert} from 'node:assert';
import {LibraryLoader} from '../../lib/loader/index.js';
import type {CompilerHost} from '../../lib/compiler.js';

/**
 * Create a mock CompilerHost from a map of path -> source.
 */
const createMockHost = (sources: Record<string, string>): CompilerHost => ({
  resolve(specifier: string, referrer: string): string {
    // Simple resolution: relative paths resolve relative to referrer
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const base = referrer.replace(/\/[^/]*$/, '');
      let resolved = `${base}/${specifier.replace(/^\.\//, '')}`.replace(
        /\/+/g,
        '/',
      );
      // Add .zena extension if not present
      if (!resolved.endsWith('.zena')) {
        resolved += '.zena';
      }
      return resolved;
    }
    // Absolute specifiers (like zena:*) resolve to themselves
    return specifier;
  },

  load(path: string): string {
    const source = sources[path];
    if (source === undefined) {
      throw new Error(`Library not found: ${path}`);
    }
    return source;
  },
});

suite('LibraryLoader', () => {
  suite('LibraryLoader', () => {
    test('loads a simple library', () => {
      const host = createMockHost({
        '/main.zena': 'let x = 1;',
      });

      const loader = new LibraryLoader(host);
      const lib = loader.load('/main.zena');

      assert.equal(lib.path, '/main.zena');
      assert.equal(lib.source, 'let x = 1;');
      assert.equal(lib.isStdlib, false);
      assert.equal(lib.imports.size, 0);
    });

    test('caches loaded libraries', () => {
      const host = createMockHost({
        '/main.zena': 'let x = 1;',
      });

      const loader = new LibraryLoader(host);
      const lib1 = loader.load('/main.zena');
      const lib2 = loader.load('/main.zena');

      // Same object reference - library identity
      assert.strictEqual(lib1, lib2);
    });

    test('resolves imports and loads dependencies', () => {
      const host = createMockHost({
        '/main.zena': `
          import { foo } from "./utils";
          let x = foo();
        `,
        '/utils.zena': `
          export let foo = () => 1;
        `,
      });

      const loader = new LibraryLoader(host);
      const main = loader.load('/main.zena');

      assert.equal(main.imports.size, 1);
      assert.equal(main.imports.get('./utils'), '/utils.zena');

      // Dependency should be loaded
      assert.ok(loader.has('/utils.zena'));

      const utils = loader.get('/utils.zena');
      assert.ok(utils);
      assert.equal(utils.path, '/utils.zena');
    });

    test('marks zena: libraries as stdlib', () => {
      const host = createMockHost({
        'zena:string': 'export class String {}',
      });

      const loader = new LibraryLoader(host);
      const lib = loader.load('zena:string');

      assert.equal(lib.isStdlib, true);
    });

    test('marks custom stdlib paths as stdlib', () => {
      const host = createMockHost({
        '/my-stdlib/core.zena': 'let x = 1;',
      });

      const loader = new LibraryLoader(host, {
        stdlibPaths: ['/my-stdlib/core.zena'],
      });

      const lib = loader.load('/my-stdlib/core.zena');
      assert.equal(lib.isStdlib, true);
    });

    test('iterates all loaded libraries', () => {
      const host = createMockHost({
        '/a.zena': 'import { b } from "./b";',
        '/b.zena': 'export let b = 1;',
      });

      const loader = new LibraryLoader(host);
      loader.load('/a.zena');

      const paths = Array.from(loader.libraries()).map(
        (lib: {path: string}) => lib.path,
      );
      assert.deepEqual(paths.sort(), ['/a.zena', '/b.zena']);
    });
  });

  suite('computeGraph', () => {
    test('returns single library for no dependencies', () => {
      const host = createMockHost({
        '/main.zena': 'let x = 1;',
      });

      const loader = new LibraryLoader(host);
      const main = loader.load('/main.zena');
      const graph = loader.computeGraph(main);

      assert.equal(graph.libraries.length, 1);
      assert.equal(graph.libraries[0].path, '/main.zena');
      assert.equal(graph.hasCycle, false);
    });

    test('orders dependencies before dependents', () => {
      const host = createMockHost({
        '/main.zena': 'import { utils } from "./utils";',
        '/utils.zena': 'import { core } from "./core";',
        '/core.zena': 'export let core = 1;',
      });

      const loader = new LibraryLoader(host);
      const main = loader.load('/main.zena');
      const graph = loader.computeGraph(main);

      const paths = graph.libraries.map((lib: {path: string}) => lib.path);
      assert.deepEqual(paths, ['/core.zena', '/utils.zena', '/main.zena']);
      assert.equal(graph.hasCycle, false);
    });

    test('detects cycles', () => {
      const host = createMockHost({
        '/a.zena': 'import { b } from "./b";',
        '/b.zena': 'import { a } from "./a";',
      });

      const loader = new LibraryLoader(host);
      const a = loader.load('/a.zena');
      const graph = loader.computeGraph(a);

      assert.equal(graph.hasCycle, true);
      assert.ok(graph.cycleLibraries.length > 0);
    });

    test('handles diamond dependencies', () => {
      // Diamond: main -> [a, b] -> c
      const host = createMockHost({
        '/main.zena': `
          import { a } from "./a";
          import { b } from "./b";
        `,
        '/a.zena': 'import { c } from "./c";',
        '/b.zena': 'import { c } from "./c";',
        '/c.zena': 'export let c = 1;',
      });

      const loader = new LibraryLoader(host);
      const main = loader.load('/main.zena');
      const graph = loader.computeGraph(main);

      // c should appear exactly once and before a, b, main
      const paths = graph.libraries.map((lib: {path: string}) => lib.path);
      assert.equal(graph.hasCycle, false);
      assert.equal(paths.filter((p: string) => p === '/c.zena').length, 1);
      assert.ok(paths.indexOf('/c.zena') < paths.indexOf('/a.zena'));
      assert.ok(paths.indexOf('/c.zena') < paths.indexOf('/b.zena'));
      assert.ok(paths.indexOf('/a.zena') < paths.indexOf('/main.zena'));
      assert.ok(paths.indexOf('/b.zena') < paths.indexOf('/main.zena'));
    });
  });

  suite('Library Identity', () => {
    test('same library path returns same LibraryRecord', () => {
      const host = createMockHost({
        '/shared.zena': 'export class Shared {}',
        '/a.zena': 'import { Shared } from "./shared";',
        '/b.zena': 'import { Shared } from "./shared";',
      });

      const loader = new LibraryLoader(host);
      loader.load('/a.zena');
      loader.load('/b.zena');

      // The shared library loaded from both a and b should be identical
      const fromA = loader.get('/shared.zena');
      const fromB = loader.get('/shared.zena');

      assert.strictEqual(fromA, fromB);
    });

    test('libraries can be compared by path for identity', () => {
      const host = createMockHost({
        '/lib.zena': 'export class Foo {}',
      });

      const loader = new LibraryLoader(host);
      const lib1 = loader.load('/lib.zena');
      const lib2 = loader.get('/lib.zena')!;

      // Identity by reference
      assert.strictEqual(lib1, lib2);

      // Identity by path
      assert.equal(lib1.path, lib2.path);
    });
  });
});
