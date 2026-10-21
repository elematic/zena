/**
 * ASCII case mapping on the js target (issue #434).
 *
 * `asciiLowerCase` and `asciiUpperCase` change only the ASCII letters, as
 * on the byte targets, and so never change a string's length.
 * `toLowerCase` and `toUpperCase` are the Unicode mappings, the host's own.
 * Text above U+00FF is passed in from JavaScript: a literal in these sources
 * would hit issue #431.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate} from '../index.js';
import {compile} from './compile-zena.js';

const exportsOf = async (source: string) => {
  const res = await instantiate(compile(source, 'js'));
  const instance = res instanceof WebAssembly.Instance ? res : res.instance;
  return instance.exports as Record<string, Function>;
};

suite('Runtime - String case mapping on the js target', () => {
  test('asciiLowerCase and asciiUpperCase leave everything else alone', async () => {
    const e = await exportsOf(`
      export let lower = (s: String): String => s.asciiLowerCase();
      export let upper = (s: String): String => s.asciiUpperCase();
      export let same = (s: String): boolean => s.asciiLowerCase() === s;
    `);
    assert.equal(e.lower('ÀB'), 'Àb');
    assert.equal(e.upper('àb'), 'àB');
    assert.equal(e.upper('Straße'), 'STRAßE');
    assert.equal(e.lower('İX'), 'İx');
    assert.equal(e.lower('ǅA'), 'ǅa');
    assert.equal(e.lower('Hello, WORLD 123'), 'hello, world 123');
    assert.equal(e.upper('Hello, world 123'), 'HELLO, WORLD 123');
    assert.equal(e.lower('ABC'), 'abc');
    assert.equal(e.upper('😀a😀'), '😀A😀');
    assert.equal(e.lower(''), '');
    // Nothing to change: the same string comes back.
    assert.equal(e.same('already lower, 日本'), 1);
  });

  test('toLowerCase and toUpperCase are the Unicode mappings', async () => {
    const e = await exportsOf(`
      export let lower = (s: String): String => s.toLowerCase();
      export let upper = (s: String): String => s.toUpperCase();
    `);
    assert.equal(e.lower('ÀB'), 'àb');
    assert.equal(e.upper('Straße'), 'STRASSE');
  });
});
