/**
 * String and template literals above U+00FF, compiled by lsp.wasm, which is
 * the compiler built for the js target (issue #431).
 *
 * There the source is a JavaScript string, and the tokenizer used to copy a
 * literal one byte at a time, keeping only the low byte of each UTF-16 code
 * unit: `'日本'` compiled to `"å,"`.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate} from '../index.js';
import {compile} from './compile-zena.js';

suite('Runtime - literals compiled by the js-target compiler', () => {
  test('string and template literals keep every character', async () => {
    const res = await instantiate(
      compile(
        `
        import { TemplateStringsArray } from 'zena:core';
        let rawOf = (strings: TemplateStringsArray, values: FixedArray<anyref>): String =>
          strings.raw[0];
        export let latin1 = (): String => 'é';
        export let cjk = (): String => '日本';
        export let emoji = (): String => "😀 ok";
        export let escaped = (): String => '日\\t本\\n';
        export let template = (n: i32): String => \`日本 \${n} 😀\`;
        export let raw = (): String => rawOf\`Grüße\\n日本\`;
        export let length = (): i32 => '日本😀'.length;
      `,
        'js',
      ),
    );
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const e = instance.exports as Record<string, Function>;
    assert.equal(e.latin1(), 'é');
    assert.equal(e.cjk(), '日本');
    assert.equal(e.emoji(), '😀 ok');
    assert.equal(e.escaped(), '日\t本\n');
    assert.equal(e.template(7), '日本 7 😀');
    assert.equal(e.raw(), 'Grüße\\n日本');
    assert.equal(e.length(), 4);
  });
});
