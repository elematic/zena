import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from '../lib/index.js';

suite('CodeGenerator - Strings', () => {
  test('should compile and run string literal', async () => {
    const source = `
      export let main = (): i32 => {
        let s = "hello";
        return 0;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 0);
  });

  test('should concatenate two string literals', async () => {
    const source = `
      export let main = (): string => {
        let s1 = 'Hello, ';
        let s2 = 'World!';
        let s3 = s1 + s2;
        return s3;
      };
    `;
    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm);
    const {main} = module.instance.exports as {main: () => any};
    assert.ok(main());
  });

  test('should concatenate string variables', async () => {
    const source = `
      export let main = (): string => {
        let s1 = 'foo';
        let s2 = 'bar';
        return s1 + s2;
      };
    `;
    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm);
    const {main} = module.instance.exports as {main: () => any};
    assert.ok(main());
  });

  test('should compare strings for equality', async () => {
    const source = `
      export let main = (): i32 => {
        let s1 = 'hello';
        let s2 = 'hello';
        let s3 = 'world';
        if (s1 == s2) {
          if (s1 != s3) {
            return 1;
          }
        }
        return 0;
      };
    `;
    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm);
    const {main} = module.instance.exports as {main: () => number};
    assert.strictEqual(main(), 1);
  });

  test('should compare string literal with concatenated string', async () => {
    const source = `
      export let main = (): boolean => {
        let s1 = 'hello world';
        let s2 = 'hello ' + 'world';
        return s1 == s2;
      };
    `;
    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm);
    const {main} = module.instance.exports as {main: () => number};
    assert.strictEqual(main(), 1);
  });

  test('should decode string using TextDecoder', async () => {
    const source = `
      export let getLength = (s: string): i32 => s.length;
      export let getChar = (s: string, i: i32): i32 => s[i];
      export let main = (): string => "Hello TextDecoder";
    `;
    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm);
    const {main, getLength, getChar} = module.instance.exports as any;

    const strRef = main();
    const len = getLength(strRef);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = getChar(strRef, i);
    }
    const decoded = new TextDecoder().decode(bytes);
    assert.strictEqual(decoded, 'Hello TextDecoder');
  });
});
