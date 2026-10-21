/**
 * `String` search on the js target, where `indexOf` and `replaceAll` are
 * calls to the `zena:host:string` imports (`stringImports`), and
 * `contains`, `split` and `replace` are built on `indexOf`.
 *
 * Indices are UTF-16 code units, as a js `String`'s `length` is. Text
 * above U+00FF is passed in from JavaScript: a literal in these sources
 * would hit issue #431.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate} from '../index.js';
import {compile} from './compile-zena.js';

const exportsOf = async (source: string) => {
  const wasm = compile(source, 'js');
  const res = await instantiate(wasm);
  const instance = res instanceof WebAssembly.Instance ? res : res.instance;
  return {wasm, exports: instance.exports as Record<string, Function>};
};

const searchSource = `
  export let indexOf = (s: String, needle: String, from: i32): i32 =>
    s.indexOf(needle, from);
  export let contains = (s: String, needle: String): boolean =>
    s.contains(needle);
  export let replace = (s: String, needle: String, with: String): String =>
    s.replace(needle, with);
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
`;

suite('Runtime - String search on the js target', () => {
  test('indexOf and replaceAll are imported from zena:host:string', async () => {
    const {wasm} = await exportsOf(searchSource);
    const module = new (WebAssembly.Module as any)(wasm, {
      builtins: ['js-string'],
      importedStringConstants: '_',
    }) as WebAssembly.Module;
    const imported = WebAssembly.Module.imports(module)
      .filter((i) => i.module === 'zena:host:string')
      .map((i) => i.name)
      .sort();
    assert.deepEqual(imported, ['indexOf', 'replaceAll']);
  });

  test('indexOf clamps fromIndex and finds an empty needle', async () => {
    const {exports: e} = await exportsOf(searchSource);
    assert.equal(e.indexOf('abcabc', 'c', 0), 2);
    assert.equal(e.indexOf('abcabc', 'c', 3), 5);
    assert.equal(e.indexOf('abcabc', 'c', -9), 2);
    assert.equal(e.indexOf('abcabc', 'c', 9), -1);
    assert.equal(e.indexOf('abc', 'bcd', 0), -1);
    assert.equal(e.indexOf('abc', '', 5), 3);
    assert.equal(e.indexOf('abc', '', -2), 0);
    assert.equal(e.indexOf('', '', 0), 0);
    // Code units: the emoji is two of them.
    assert.equal(e.indexOf('😀日本', '日', 0), 2);
    assert.equal(e.contains('Grüße 日本', '日本'), 1);
    assert.equal(e.contains('Grüße', 'zz'), 0);
  });

  test('split keeps empty parts and splits on code units', async () => {
    const {exports: e} = await exportsOf(searchSource);
    assert.equal(e.split(',a,,b,', ','), '<><a><><b><>');
    assert.equal(e.split('abc', ''), '<a><b><c>');
    assert.equal(e.split('', ''), '');
    assert.equal(e.split('', ','), '<>');
    assert.equal(e.split('ab', 'abc'), '<ab>');
    assert.equal(e.split('一、二、三', '、'), '<一><二><三>');
  });

  test('replace and replaceAll insert the replacement as written', async () => {
    const {exports: e} = await exportsOf(searchSource);
    assert.equal(e.replace('a.b.c', '.', '-'), 'a-b.c');
    assert.equal(e.replace('abc', 'x', '-'), 'abc');
    assert.equal(e.replaceAll('a.b.c', '.', '-'), 'a-b-c');
    assert.equal(e.replaceAll('aaa', 'aa', 'b'), 'ba');
    // JavaScript's replaceAll would expand these.
    assert.equal(e.replaceAll('a.b', '.', '$&$$'), 'a$&$$b');
    assert.equal(e.replaceAll('a.b', '.', "$'$`$1"), "a$'$`$1b");
    // An empty needle matches at every position, both ends included, as in
    // JavaScript.
    assert.equal(e.replaceAll('abc', '', '-'), '-a-b-c-');
    assert.equal(e.replaceAll('', '', '-'), '-');
    assert.equal(e.replaceAll('abc', '', '$'), '$a$b$c$');
    assert.equal(e.replaceAll('日本 日本', '日本', 'Japan'), 'Japan Japan');
  });
});
