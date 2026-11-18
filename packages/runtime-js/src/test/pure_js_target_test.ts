/**
 * Pure `--target js` execution: instantiating with empty `{}` imports and
 * `builtins: ['js-string']` + `importedStringConstants: '_'`, without any
 * `@zena-lang/runtime` imports.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from './compile-zena.js';

const COMPILE_OPTIONS = {
  builtins: ['js-string'],
  importedStringConstants: '_',
};

const instantiatePureJs = async (source: string) => {
  const bytes = await compile(source, 'js');
  const module = new (WebAssembly.Module as any)(
    bytes,
    COMPILE_OPTIONS,
  ) as WebAssembly.Module;
  const instance = new WebAssembly.Instance(module, {});
  const raw = instance.exports as Record<string, Function>;
  const wrap = (arg: unknown) =>
    typeof arg === 'string' && raw.$stringCreate ? raw.$stringCreate(arg) : arg;
  const unwrap = (res: unknown) =>
    res !== null && typeof res === 'object' && raw.$stringGetHandle
      ? raw.$stringGetHandle(res)
      : res;
  const exports: Record<string, Function> = {};
  for (const [name, fn] of Object.entries(raw)) {
    if (typeof fn === 'function' && !name.startsWith('$')) {
      exports[name] = (...args: unknown[]) => unwrap(fn(...args.map(wrap)));
    }
  }
  return {
    module,
    rawExports: raw,
    exports,
  };
};

suite('Runtime - pure --target js (zero runtime imports)', () => {
  test('imports only wasm:js-string and string constants, even with String, URL, Error, and console', async () => {
    const {module, exports: e} = await instantiatePureJs(`
      import { URL } from 'zena:url';

      export let run = (input: String): String => {
        console.log('ignored by no-op console');
        try {
          throw new Error('boom');
        } catch (err) {
          let u = URL.parse(input) as URL;
          return \`\${err.message.toUpperCase()}:\${u.hostname}:\${123}\`;
        }
      };
    `);

    const modules = new Set(
      WebAssembly.Module.imports(module).map((imp) => imp.module),
    );
    for (const mod of modules) {
      assert.ok(
        mod === 'wasm:js-string' || mod === '_',
        `unexpected host import module on --target js: ${mod}`,
      );
    }

    assert.equal(
      e.run('https://example.com:8080/path'),
      'BOOM:example.com:123',
    );
  });

  test('pure-Wasm WTF-16 string search, split, and literal replaceAll', async () => {
    const {exports: e} = await instantiatePureJs(`
      export let indexOf = (s: String, needle: String): i32 => {
        if (let (true, at) = s.indexOf(needle)) { return at as i32; }
        return -1;
      };
      export let indexOfFromEnd = (s: String, needle: String): i32 => {
        if (let (true, at) = s.indexOf(needle, s.endIndex)) { return at as i32; }
        return -1;
      };
      export let replaceAll = (s: String, needle: String, with: String): String =>
        s.replaceAll(needle, with);
      export let split = (s: String, sep: String): String => {
        var out = '';
        let parts = s.split(sep);
        for (var i = 0; i < parts.length; i += 1) {
          out = out + '<' + parts[i] + '>';
        }
        return out;
      };
    `);

    assert.equal(e.indexOf('abcabc', 'c'), 2);
    assert.equal(e.indexOf('😀日本', '日'), 2);
    assert.equal(e.indexOfFromEnd('abc', ''), 3);
    assert.equal(e.indexOf('', ''), 0);
    assert.equal(e.split(',a,,b,', ','), '<><a><><b><>');
    assert.equal(e.split('abc', ''), '<a><b><c>');
    assert.equal(e.replaceAll('a.b.c', '.', '-'), 'a-b-c');
    assert.equal(e.replaceAll('ab', '', '-'), '-a-b-');
    assert.equal(e.replaceAll('', '', 'x'), 'x');
    assert.equal(e.replaceAll('a.b', '.', '$&$$'), 'a$&$$b');
  });

  test('pure-Wasm Unicode case mapping including special expansions and final sigma', async () => {
    const {exports: e} = await instantiatePureJs(`
      export let lower = (s: String): String => s.toLowerCase();
      export let upper = (s: String): String => s.toUpperCase();
    `);

    assert.equal(e.lower('Hello, WORLD!'), 'hello, world!');
    assert.equal(e.lower('ÀB'), 'àb');
    assert.equal(e.upper('Straße'), 'STRASSE');
    assert.equal(e.lower('ΑΘΗΝΑΣ'), 'αθηνας');
    assert.equal(e.lower('ΣΟΣ'), 'σος');
    assert.equal(e.lower('İ'), 'i\u0307');
    assert.equal(e.upper('😀a😀'), '😀A😀');
  });

  test('pure-Zena number formatting and parsing without zena:host:number', async () => {
    const {exports: e} = await instantiatePureJs(`
      export let fmt = (i: i32, f: f64): String => \`\${i}/\${f}\`;
      export let parse = (s: String): f64 => parseF64(s);
    `);

    assert.equal(e.fmt(-42, 3.25), '-42/3.25');
    assert.equal(e.parse('3.14159'), 3.14159);
    assert.ok(Number.isNaN(e.parse('not-a-number')));
  });

  test('host-only modules require zena-js and fail to resolve on plain js', async () => {
    for (const mod of ['zena:js', 'zena:fetch', 'zena:time', 'zena:random']) {
      await assert.rejects(
        () => compile(`import '${mod}'; export let main = (): i32 => 0;`, 'js'),
        new RegExp(mod),
      );
    }
  });
});
