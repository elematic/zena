/**
 * `zena:random` on the js target, where the generator is the host's
 * `crypto.getRandomValues` through the `zena:host:random` imports
 * (`randomImports`; stdlib `random/source-js.zena`).
 *
 * The stdlib's own tests (packages/stdlib/tests/random) check ranges and
 * lengths on the component targets. These check what the js source adds:
 * how it packs 32-bit words into bytes and a `u64`, which a substituted
 * `u32` import makes deterministic.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate, randomImports} from '../index.js';
import {compile} from './compile-zena.js';

const source = `
  import { randomBytes, randomU64, randomInt, randomF64 } from 'zena:random';

  export let bytes = (count: i32): String => {
    var out = '';
    for (let b in randomBytes(count)) {
      out = \`\${out}\${b as i32},\`;
    }
    return out;
  };
  export let u64 = (): String => \`\${randomU64()}\`;
  export let int = (bound: i32): i32 => randomInt(bound);
  export let f64 = (): f64 => randomF64();
`;

let wasm: Uint8Array | undefined;

/** An instance whose `u32` import returns `words` in turn, if given. */
const zena = async (words?: number[]) => {
  wasm ??= compile(source);
  let next = 0;
  const res = await instantiate(
    wasm,
    words === undefined
      ? {}
      : {'zena:host:random': {u32: () => words[next++ % words.length]}},
  );
  const instance = res instanceof WebAssembly.Instance ? res : res.instance;
  return instance.exports as Record<string, Function>;
};

suite('Runtime - zena:random on the js target', () => {
  test('the generator is zena:host:random u32', async () => {
    wasm ??= compile(source);
    const module = new (WebAssembly.Module as any)(wasm, {
      builtins: ['js-string'],
      importedStringConstants: '_',
    }) as WebAssembly.Module;
    const imported = WebAssembly.Module.imports(module)
      .filter((i) => i.module === 'zena:host:random')
      .map((i) => i.name);
    assert.deepEqual(imported, ['u32']);
    for (let i = 0; i < 100; i++) {
      const word = randomImports.u32();
      assert.ok(Number.isInteger(word) && word >= 0 && word < 2 ** 32);
    }
  });

  test('randomBytes packs each word low byte first', async () => {
    // Each call draws from the start of the sequence on its own instance.
    const bytes = async (count: number) =>
      (await zena([0x04030201, 0xf8f7f6f5])).bytes(count);
    assert.equal(await bytes(0), '');
    assert.equal(await bytes(3), '1,2,3,');
    assert.equal(await bytes(4), '1,2,3,4,');
    assert.equal(await bytes(6), '1,2,3,4,245,246,');
  });

  test('randomU64 puts the first word high', async () => {
    const e = await zena([0xaabbccdd, 0x11223344]);
    assert.equal(e.u64(), 0xaabbccdd11223344n.toString());
  });

  test('randomInt draws again below the threshold', async () => {
    // 2^64 mod 3 is 1, so a draw of 0 is rejected and 5 gives 5 % 3.
    const e = await zena([0, 0, 0, 5]);
    assert.equal(e.int(3), 2);
  });

  test('randomF64 spans [0, 1)', async () => {
    assert.equal((await zena([0])).f64(), 0);
    const top = (await zena([0xffffffff])).f64();
    assert.equal(top, 1 - 2 ** -53);
  });

  test('randomBytes and randomInt over crypto.getRandomValues', async () => {
    const e = await zena();
    assert.equal(e.bytes(37).split(',').length - 1, 37);
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const n = e.int(6);
      assert.ok(n >= 0 && n < 6, `randomInt(6) returned ${n}`);
      seen.add(n);
    }
    assert.equal(seen.size, 6);
  });
});
