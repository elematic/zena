/**
 * Number-to-string conversion on the js target: `core/number-format-js.zena`
 * imports it from `zena:host:number`, which `numberImports` provides.
 *
 * The output must be the text the byte targets print. These cases cover
 * where JavaScript's own conversions differ: negative zero, f32 shortest
 * digits, and `f64ToPrecision`, which rounds a tie to even.
 * `packages/stdlib/dev/fp-host-difftest.js` compares the two over a large
 * corpus.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate, numberImports} from '../index.js';
import {compile} from './compile-zena.js';

suite('Runtime - number formatting on the js target', () => {
  test('formatting is imported from zena:host:number', async () => {
    const wasm = compile(
      `
      import {f32ToString, f64ToPrecision} from 'zena:core';
      export let showI32 = (x: i32): String => i32ToString(x);
      export let showU32 = (x: i32): String => \`\${x as u32}\`;
      export let showI64 = (x: i64): String => i64ToString(x);
      export let showU64 = (x: i64): String => \`\${x as u64}\`;
      export let showF32 = (x: f32): String => f32ToString(x);
      export let showF64 = (x: f64): String => f64ToString(x);
      export let prec = (x: f64, n: i32): String => f64ToPrecision(x, n);
      export let tmpl = (x: f64, n: i32): String => \`\${x}/\${n}\`;
    `,
      'js',
    );
    const module = new (WebAssembly.Module as any)(wasm, {
      builtins: ['js-string'],
      importedStringConstants: '_',
    }) as WebAssembly.Module;
    const imported = WebAssembly.Module.imports(module)
      .filter((i) => i.module === 'zena:host:number')
      .map((i) => i.name)
      .sort();
    assert.deepEqual(imported, [
      'f32ToString',
      'f64ToPrecision',
      'f64ToString',
      'i32ToString',
      'i64ToString',
      'u32ToString',
      'u64ToString',
    ]);

    const res = await instantiate(wasm);
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const e = instance.exports as Record<string, Function>;
    assert.equal(e.showI32(-2147483648), '-2147483648');
    assert.equal(e.showU32(-1), '4294967295');
    assert.equal(e.showI64(-9223372036854775808n), '-9223372036854775808');
    assert.equal(e.showU64(-1n), '18446744073709551615');
    assert.equal(e.showF32(Math.fround(0.1)), '0.1');
    assert.equal(e.showF64(-0), '-0');
    assert.equal(e.prec(2.5, 1), '2');
    assert.equal(e.tmpl(1e21, 7), '1e+21/7');
  });

  test('f64ToString matches JavaScript except for negative zero', () => {
    const {f64ToString} = numberImports;
    assert.equal(f64ToString(0.1 + 0.2), '0.30000000000000004');
    assert.equal(f64ToString(1e21), '1e+21');
    assert.equal(f64ToString(123456789012345680000), '123456789012345680000');
    assert.equal(f64ToString(1e-7), '1e-7');
    assert.equal(f64ToString(0.000001), '0.000001');
    assert.equal(f64ToString(-0), '-0');
    assert.equal(f64ToString(0), '0');
    assert.equal(f64ToString(NaN), 'NaN');
    assert.equal(f64ToString(-Infinity), '-Infinity');
  });

  test('f32ToString prints the shortest digits for the f32', () => {
    const {f32ToString} = numberImports;
    assert.equal(f32ToString(Math.fround(0.1)), '0.1');
    assert.equal(f32ToString(Math.fround(1 / 3)), '0.33333334');
    assert.equal(f32ToString(Math.fround(16777217)), '16777216');
    assert.equal(
      f32ToString(Math.fround(3.4028234663852886e38)),
      '3.4028235e+38',
    );
    // The smallest subnormal and the smallest normal.
    assert.equal(f32ToString(2 ** -149), '1e-45');
    assert.equal(f32ToString(2 ** -126), '1.1754944e-38');
    // Two shortest candidates, 440878.62 and 440878.63, are equally near
    // 440878.625; the tie goes to the even one.
    assert.equal(f32ToString(440878.625), '440878.62');
    assert.equal(f32ToString(-0), '-0');
  });

  test('f64ToPrecision rounds a tie to even and keeps trailing zeros', () => {
    const {f64ToPrecision} = numberImports;
    assert.equal(f64ToPrecision(2.5, 1), '2');
    assert.equal(f64ToPrecision(3.5, 1), '4');
    assert.equal(f64ToPrecision(0.125, 2), '0.12');
    assert.equal(f64ToPrecision(0.99999, 3), '1.00');
    assert.equal(f64ToPrecision(10.6, 2), '11');
    assert.equal(f64ToPrecision(123456, 2), '120000');
    assert.equal(f64ToPrecision(1.3027815448893015e119, 4), '1.303e+119');
    assert.equal(f64ToPrecision(1.5e-7, 3), '1.50e-7');
    assert.equal(f64ToPrecision(Math.PI, 0), '3');
    assert.equal(f64ToPrecision(Math.PI, 40), '3.1415926535897931');
    assert.equal(f64ToPrecision(-0, 3), '-0');
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
