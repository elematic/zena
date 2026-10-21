/**
 * `createImports`: the import object `instantiate` builds, for a caller
 * that instantiates the module itself and binds the imports with
 * `attach` afterwards.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from './compile-zena.js';
import {
  compileOptions,
  createImports,
  createStringReader,
  instantiate,
} from '../index.js';

const source = `
  import { String } from 'zena:core';

  @external("env", "captureStackTrace")
  declare function __captureStackTrace(): anyref;

  @external("env", "formatStackTrace")
  declare function __formatStackTrace(stack: anyref): String | null;

  export let stack = (): String | null => __formatStackTrace(__captureStackTrace());
  export let shout = (s: String): String => s.toUpperCase();
`;

const bytes = (): Uint8Array<ArrayBuffer> =>
  compile(source) as Uint8Array<ArrayBuffer>;

suite('createImports', () => {
  test('a plain WebAssembly.instantiate with the imports, bound by attach', async () => {
    const zena = createImports();
    const {instance} = await WebAssembly.instantiate(
      bytes(),
      {...zena.imports, extra: {}},
      compileOptions,
    );
    zena.attach(instance.exports);
    const exports = instance.exports;
    const read = createStringReader(exports);
    const create = exports.$stringCreate as (s: string) => unknown;

    // `formatStackTrace` writes a Zena string through the exports, so
    // it needs the binding `attach` made.
    const stack = (exports.stack as () => unknown)();
    assert.ok(stack, 'a stack trace');
    assert.match(read(stack), /at /);

    // `zena:host:string` is in the import object too.
    const shouted = (exports.shout as (s: unknown) => unknown)(create('abc'));
    assert.equal(read(shouted), 'ABC');
  });

  test('instantiate builds the same imports', async () => {
    const zena = createImports();
    const result = await instantiate(bytes());
    const instance = 'instance' in result ? result.instance : result;
    const modules = new Set(
      WebAssembly.Module.imports(
        'module' in result
          ? result.module
          : new WebAssembly.Module(bytes(), compileOptions),
      ).map((i) => i.module),
    );
    for (const name of modules) {
      assert.ok(name in zena.imports, `createImports has ${name}`);
    }
    const read = createStringReader(instance.exports);
    assert.match(read((instance.exports.stack as () => unknown)()), /at /);
  });
});
