/**
 * `zena:url`'s percent-encoding and form-urlencoded codec on the js target
 * (issue #438), checked against JavaScript's own `URLSearchParams` and
 * `encodeURIComponent`.
 *
 * Percent-encoding works on UTF-8 bytes. On the js target a `String` is
 * UTF-16, so the codec reads `str.utf8` and builds the decoded string from
 * UTF-8, where it used to read each code unit's low byte.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate} from '../index.js';
import {compile} from './compile-zena.js';

const source = `
  import { URLSearchParams, percentEncode, percentDecode, EncodeSet } from 'zena:url';
  export let encode = (s: String): String => percentEncode(s, EncodeSet.Component);
  export let decode = (s: String): String => percentDecode(s);
  export let get = (query: String, name: String): String =>
    new URLSearchParams(query).get(name) ?? '!';
  export let serialize = (name: String, value: String): String => {
    let params = new URLSearchParams('');
    params.set(name, value);
    return params.toString();
  };
`;

suite('Runtime - zena:url percent-encoding on the js target', () => {
  test('encodes and decodes text above U+007F as UTF-8', async () => {
    const res = await instantiate(compile(source, 'js'));
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const e = instance.exports as Record<string, Function>;

    for (const text of ['café 日本', 'Ω→😀', 'a b&c=d', '']) {
      assert.equal(e.encode(text), encodeURIComponent(text), text);
      assert.equal(e.decode(encodeURIComponent(text)), text, text);
    }
    // Text that is not percent-encoded passes through.
    assert.equal(e.decode('é%20日'), 'é 日');
    // Bytes that are not UTF-8 decode as U+FFFD, as URLSearchParams does.
    assert.equal(e.decode('%FF'), '�');

    const query = 'q=caf%C3%A9&n=1&%E6%97%A5=%F0%9F%98%80';
    const js = new URLSearchParams(query);
    assert.equal(e.get(query, 'q'), js.get('q'));
    assert.equal(e.get(query, '日'), js.get('日'));
    // U+0126's low byte is 0x26, which is '&'; it must not split a pair.
    assert.equal(e.get('aĦb=1', 'aĦb'), '1');
    assert.equal(e.get('x=Ľ', 'x'), 'Ľ');

    const params = new URLSearchParams();
    params.set('q', 'café 日本');
    assert.equal(e.serialize('q', 'café 日本'), params.toString());
  });
});
