// `zena:json` on the js target, where a `String` is UTF-16.
//
// Code points whose low byte matches a C0 control (`U+2014` -> `0x14`),
// a quote (`U+2022` -> `0x22`), a backslash (`U+015C` -> `0x5C`), a
// comment delimiter (`U+010A` -> `0x0A`, `U+012A`/`U+012F` -> `*` + `/`),
// or a `jsonGet` path separator (`U+012E` -> `0x2E`, `U+015B` -> `0x5B`)
// must be read as Unicode code points via `StringReader`, and `\u` escapes
// must decode via `StringBuilder.appendCodePoint`.
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate} from '../index.js';
import {compile} from './compile-zena.js';

const source = `
  import {
    JsonBuilder,
    JsonObject,
    JsonOptions,
    jsonGet,
    parseJson,
    stringify,
  } from 'zena:json';

  export let parseField = (json: String, key: String): String => {
    let obj = parseJson(json) as JsonObject;
    return obj[key] as String;
  };

  export let parseCommented = (json: String, key: String): String => {
    let opts: JsonOptions = {allowComments: true, trackLocations: false};
    let obj = parseJson(json, opts) as JsonObject;
    return obj[key] as String;
  };

  export let roundTrip = (key: String, val: String): String => {
    let obj = new JsonObject();
    obj[key] = val;
    return stringify(obj);
  };

  export let buildPair = (key: String, val: String): String =>
    new JsonBuilder()
      .beginObject()
        .key(key).string(val)
      .endObject()
      .toString();

  export let query = (json: String, path: String): String => {
    let v = jsonGet(parseJson(json), path);
    return if (v is String) v else '!';
  };

  export let locationColumn = (json: String, key: String): i32 => {
    let opts: JsonOptions = {allowComments: false, trackLocations: true};
    let obj = parseJson(json, opts) as JsonObject;
    let loc = obj.locationOf(key);
    return if (loc != null) loc.column else -1;
  };
`;

suite('Runtime - zena:json on the js target', () => {
  test('parses, stringifies, and queries text above U+007F', async () => {
    const res = await instantiate(await compile(source, 'js'));
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const e = instance.exports as Record<string, Function>;

    // Low bytes 0x14 (< 0x20), 0x22 ('"'), 0x5C ('\\'), plus non-BMP 😀.
    const tricky = 'em — dash • bullet Ŝ circumflex 😀';
    const doc = JSON.stringify({note: tricky});
    assert.equal(e.parseField(doc, 'note'), tricky);
    assert.equal(e.roundTrip('note', tricky), doc);
    assert.equal(e.buildPair('note', tricky), doc);

    // Mixed unescaped U+015C (low byte '\\') and real escape sequences,
    // including BMP, surrogate-pair, and unpaired-high + BMP \\u escapes.
    const escaped =
      '{"msg": "Ŝ\\ncaf\\u00e9 \\u2014 \\ud83d\\ude00 \\ud83d \\ud83d\\u0041"}';
    assert.equal(e.parseField(escaped, 'msg'), 'Ŝ\ncafé — 😀 \uFFFD \uFFFDA');

    // Comments containing U+010A (low byte '\\n') and U+012A/U+012F ('*/').
    const commented =
      '// line comment with Ċ keep skipping {"bad": 1}\n' +
      '/* block comment with Īį keep skipping */\n' +
      '{"ok": "yes — •"}';
    assert.equal(e.parseCommented(commented, 'ok'), 'yes — •');

    // jsonGet path segments containing U+012E (low byte '.'), U+015B ('['),
    // and non-BMP surrogate pairs.
    const nested = JSON.stringify({aĮb: {'cś😀d': 'found'}});
    assert.equal(e.query(nested, '.aĮb.cś😀d'), 'found');

    // Source locations count code points rather than UTF-16 code units.
    assert.equal(e.locationColumn('{"😀": 1}', '😀'), 7);

    // Real unescaped C0 control characters still fail to parse.
    assert.throws(() => e.parseField('{"bad": "a\nb"}', 'bad'));
    assert.throws(() => e.parseField('{"bad": "a\u0014b"}', 'bad'));
  });
});
