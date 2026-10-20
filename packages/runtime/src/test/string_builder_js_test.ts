/**
 * `StringBuilder` and byte decoding on the js target, where a `String` is a
 * JavaScript string.
 *
 * The byte targets cover the builder in packages/stdlib/tests. This covers
 * the js implementation (`core/string-builder-js.zena`), which holds host
 * strings and never looks at bytes, so text above U+00FF survives a round
 * trip through it (issue #427).
 *
 * Text above U+00FF is passed in from JavaScript rather than written as a
 * literal: these sources are compiled by lsp.wasm, a js-target build of the
 * compiler, whose tokenizer reads a literal's code units one byte each.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate} from '../index.js';
import {compile} from './compile-zena.js';

const exportsOf = async (source: string) => {
  const res = await instantiate(
    compile(
      `import {StringBuilder, join, dedent} from 'zena:core';\n${source}`,
      'js',
    ),
  );
  const instance = res instanceof WebAssembly.Instance ? res : res.instance;
  return instance.exports as Record<string, Function>;
};

suite('Runtime - StringBuilder on the js target', () => {
  test('appends text above Latin-1 unchanged', async () => {
    const exports = await exportsOf(`
      export let roundTrip = (a: String, b: String, c: String): String => {
        let sb = new StringBuilder();
        sb.append(a);
        sb.append(' ');
        sb.append(b);
        sb.append(' ');
        sb.append(c);
        return sb.toString();
      };
      export let appendArg = (a: String, b: String): String => {
        let sb = new StringBuilder();
        sb.append(a).append(b);
        return sb.toString();
      };
      export let lengthOf = (a: String, b: String): i32 => {
        let sb = new StringBuilder();
        sb.append(a).append(b);
        return sb.length;
      };
    `);
    assert.equal(exports.roundTrip('é', '日本', '😀'), 'é 日本 😀');
    assert.equal(exports.appendArg('Ω', '→ 𝄞'), 'Ω→ 𝄞');
    // Code units, which is what a js String's length counts.
    assert.equal(exports.lengthOf('日本', '😀'), 4);
  });

  test('appendSlice takes code-unit offsets', async () => {
    const exports = await exportsOf(`
      export let slice = (s: String, start: i32, end: i32): String => {
        let sb = new StringBuilder();
        sb.append('[');
        sb.appendSlice(s, start, end);
        sb.append(']');
        return sb.toString();
      };
    `);
    assert.equal(exports.slice('añb日本c', 1, 5), '[ñb日本]');
    assert.equal(exports.slice('abc', 2, 2), '[]');
  });

  test('appends bytes and numbers', async () => {
    const exports = await exportsOf(`
      export let mixed = (): String => {
        let sb = new StringBuilder();
        sb.appendByte(0x3C);
        sb.appendByte2(0x5C, 0x6E);
        sb.appendI32(-42);
        sb.appendByte(0x20);
        sb.appendU32(7 as u32);
        sb.appendByte(0x20);
        sb.appendI64(-9000000000 as i64);
        sb.appendByte(0x20);
        sb.appendU64(18000000000 as u64);
        sb.appendByte(0x20);
        sb.appendF64(1.5);
        sb.append('é');
        return sb.toString();
      };
    `);
    assert.equal(exports.mixed(), '<\\n-42 7 -9000000000 18000000000 1.5é');
  });

  test('clear, length and reuse', async () => {
    const exports = await exportsOf(`
      export let cleared = (): String => {
        let sb = new StringBuilder();
        sb.append('abc');
        sb.clear();
        if (sb.length != 0) { return 'not empty'; }
        sb.append('ok');
        return sb.toString();
      };
      export let empty = (): String => new StringBuilder().toString();
      export let fromString = (s: String): String =>
        StringBuilder.fromString(s).append('!').toString();
    `);
    assert.equal(exports.cleared(), 'ok');
    assert.equal(exports.empty(), '');
    assert.equal(exports.fromString('Grüße'), 'Grüße!');
  });

  test('join keeps non-Latin-1 text', async () => {
    const exports = await exportsOf(`
      export let joined = (a: String, b: String, c: String, sep: String): String => {
        let parts = new Array<String>();
        parts.push(a);
        parts.push(b);
        parts.push(c);
        return join(parts, sep);
      };
    `);
    assert.equal(exports.joined('一', '二', '三', '、'), '一、二、三');
  });

  test('dedent keeps non-Latin-1 text', async () => {
    const exports = await exportsOf(`
      export let text = (name: String, line: String): String => dedent\`
        Grüße, \${name}!
          \${line}
      \`;
    `);
    assert.equal(exports.text('Zoë', '日本 😀'), 'Grüße, Zoë!\n  日本 😀');
  });

  test('String.fromBytes decodes WTF-8', async () => {
    const exports = await exportsOf(`
      export let decoded = (): String => {
        // "é日😀" in UTF-8, then a lone continuation byte and a truncated
        // sequence, each of which decodes as U+FFFD.
        let bytes: FixedArray<u8> = [
          0xC3 as u8, 0xA9 as u8,
          0xE6 as u8, 0x97 as u8, 0xA5 as u8,
          0xF0 as u8, 0x9F as u8, 0x98 as u8, 0x80 as u8,
          0x80 as u8,
          0x41 as u8,
          0xE6 as u8, 0x97 as u8,
        ];
        return String.fromBytes(bytes);
      };
      export let surrogate = (): String => {
        // WTF-8 carries a lone surrogate as its generalized UTF-8 form.
        let bytes: FixedArray<u8> = [0xED as u8, 0xA0 as u8, 0xBD as u8];
        return String.fromBytes(bytes);
      };
    `);
    assert.equal(exports.decoded(), 'é日😀�A��');
    assert.equal(exports.surrogate(), '\uD83D');
  });
});
