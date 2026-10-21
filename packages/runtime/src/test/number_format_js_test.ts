/**
 * Number conversion on the js target: `core/number-format-js.zena` and
 * `core/number-parse-js.zena` call JavaScript's own `String`, `toPrecision`
 * and `parseFloat` through `zena:host:number` (`numberImports`), and make
 * up the differences from Zena's results themselves.
 *
 * The results must be the ones the byte targets give. These cases cover
 * where JavaScript's own conversions differ: negative zero, u32 and u64,
 * and f32, which JavaScript cannot print.
 * `packages/stdlib/dev/fp-host-difftest.js` compares the two over a large
 * corpus.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate, numberImports} from '../index.js';
import {compile} from './compile-zena.js';

const formatSource = `
  import {f32ToString, f64ToPrecision} from 'zena:core';
  export let showI32 = (x: i32): String => i32ToString(x);
  export let showU32 = (x: i32): String => \`\${x as u32}\`;
  export let showI64 = (x: i64): String => i64ToString(x);
  export let showU64 = (x: i64): String => \`\${x as u64}\`;
  export let showF32 = (x: f32): String => f32ToString(x);
  export let showF64 = (x: f64): String => f64ToString(x);
  export let prec = (x: f64, n: i32): String => f64ToPrecision(x, n);
  export let tmpl = (x: f64, n: i32): String => \`\${x}/\${n}\`;
`;

let formatModule: Uint8Array | undefined;
const formatExports = async () => {
  formatModule ??= compile(formatSource, 'js');
  const res = await instantiate(formatModule);
  const instance = res instanceof WebAssembly.Instance ? res : res.instance;
  return instance.exports as Record<string, Function>;
};

suite('Runtime - number conversion on the js target', () => {
  test("the imports are JavaScript's own", async () => {
    await formatExports();
    const module = new (WebAssembly.Module as any)(formatModule, {
      builtins: ['js-string'],
      importedStringConstants: '_',
    }) as WebAssembly.Module;
    const imported = new Set(
      WebAssembly.Module.imports(module)
        .filter((i) => i.module === 'zena:host:number')
        .map((i) => i.name),
    );
    assert.deepEqual([...imported].sort(), [
      'String',
      'parseFloat',
      'toPrecision',
    ]);
    assert.equal(numberImports.String, String);
    assert.equal(numberImports.parseFloat, parseFloat);
  });

  test('integers, including u32 and u64 past the signed range', async () => {
    const e = await formatExports();
    assert.equal(e.showI32(-2147483648), '-2147483648');
    assert.equal(e.showU32(-1), '4294967295');
    assert.equal(e.showI64(-9223372036854775808n), '-9223372036854775808');
    assert.equal(e.showU64(-1n), '18446744073709551615');
    assert.equal(e.showU64(-9223372036854775808n), '9223372036854775808');
    assert.equal(e.showU64(12345n), '12345');
    assert.equal(e.tmpl(1e21, 7), '1e+21/7');
  });

  test("f64ToString is JavaScript's, with negative zero kept", async () => {
    const e = await formatExports();
    for (const v of [
      0.1 + 0.2,
      1e21,
      123456789012345680000,
      1e-7,
      0.000001,
      0,
      NaN,
      -Infinity,
    ]) {
      assert.equal(e.showF64(v), String(v));
    }
    assert.equal(e.showF64(-0), '-0');
  });

  test('f32ToString prints the shortest digits for the f32', async () => {
    const e = await formatExports();
    assert.equal(e.showF32(Math.fround(0.1)), '0.1');
    assert.equal(e.showF32(Math.fround(1 / 3)), '0.33333334');
    assert.equal(e.showF32(Math.fround(16777217)), '16777216');
    assert.equal(
      e.showF32(Math.fround(3.4028234663852886e38)),
      '3.4028235e+38',
    );
    assert.equal(e.showF32(2 ** -149), '1e-45');
    // A tie between two shortest candidates goes away from zero.
    assert.equal(e.showF32(440878.625), '440878.63');
    // One of the three powers of two where js prints a digit more.
    assert.equal(e.showF32(2 ** 87), '1.54742505e+26');
    assert.equal(e.showF32(-0), '-0');
  });

  test('f64ToPrecision is toPrecision, with the digits clamped', async () => {
    const e = await formatExports();
    for (const [v, n] of [
      [2.5, 1],
      [0.125, 2],
      [0.99999, 3],
      [10.6, 2],
      [123456, 2],
      [1.3027815448893015e119, 4],
      [1.5e-7, 3],
      [0, 3],
      [-0, 3],
      [NaN, 2],
    ]) {
      assert.equal(e.prec(v, n), v.toPrecision(n), `${v}.toPrecision(${n})`);
    }
    assert.equal(e.prec(Math.PI, 0), Math.PI.toPrecision(1));
    assert.equal(e.prec(Math.PI, 40), Math.PI.toPrecision(17));
  });

  let parseModule: Uint8Array | undefined;
  const parseExports = async () => {
    parseModule ??= compile(
      `export let parse = (s: String): f64 => parseF64(s);`,
      'js',
    );
    const res = await instantiate(parseModule);
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    return instance.exports.parse as (s: string) => number;
  };

  test('parseF64 imports only the host parseFloat', async () => {
    await parseExports();
    const module = new (WebAssembly.Module as any)(parseModule, {
      builtins: ['js-string'],
      importedStringConstants: '_',
    }) as WebAssembly.Module;
    assert.deepEqual(
      WebAssembly.Module.imports(module)
        .filter((i) => i.module === 'zena:host:number')
        .map((i) => i.name),
      ['parseFloat'],
    );
    assert.equal(numberImports.parseFloat, parseFloat);
  });

  test('parseF64 reads what parseFloat reads, and hex at the start', async () => {
    const parseF64 = await parseExports();
    const same = [
      '12abc',
      '1e5x',
      '1.5.5',
      '1_000',
      '',
      '-',
      '.',
      'abc',
      'NaN',
      'Infinity',
      '-Infinityx',
      'infinity',
      '- 1',
      '1e',
      '1e+',
      '.5',
      '5.',
      '-0',
      '2.4703282292062328e-324',
      '9007199254740993',
      '-8719713712855776767.983584839753951',
      '1e99999999999',
    ];
    for (const text of same) {
      assert.ok(
        Object.is(parseF64(text), parseFloat(text)),
        `parseF64(${JSON.stringify(text)})`,
      );
    }
    // Leading whitespace, which parseFloat skips, is no number.
    for (const text of [' 1', '\t\n-2', '\u00a0\u3000\ufeff3', ' 0x10']) {
      assert.ok(
        Number.isNaN(parseF64(text)),
        `parseF64(${JSON.stringify(text)})`,
      );
    }
    // Hex at the very start is Zena's own: an integer, accumulated a digit
    // at a time.
    assert.equal(parseF64('0x1F'), 31);
    assert.equal(parseF64('-0x10'), -16);
    assert.equal(parseF64('0x1g'), 1);
    assert.ok(Object.is(parseF64('-0x'), 0));
  });
});
