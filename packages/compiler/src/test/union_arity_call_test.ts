import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {compile} from '../lib/index.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

suite('Union Arity Call', () => {
  test('should succeed when calling a union with arguments supported by all members (via adaptation)', async () => {
    const filePath = join(process.cwd(), 'test-files/union-arity-call.zena');
    const code = await readFile(filePath, 'utf-8');

    const wasm = await compile(code);
    assert.ok(wasm, 'Compilation failed');

    const result = (await WebAssembly.instantiate(wasm, {
      console: {
        log: (val: any) => console.log(val),
        log_i32: (val: number) => console.log(val),
        log_f32: (val: number) => console.log(val),
        log_string: (val: any) => console.log(val),
        error: (val: any) => console.error(val),
        error_string: (val: any) => console.error(val),
        warn: (val: any) => console.warn(val),
        warn_string: (val: any) => console.warn(val),
        info: (val: any) => console.info(val),
        info_string: (val: any) => console.info(val),
        debug: (val: any) => console.debug(val),
        debug_string: (val: any) => console.debug(val),
      },
      env: {
        log: (val: any) => console.log(val),
      },
    })) as any;

    const main = result.instance.exports['main'] as CallableFunction;
    const ret = main();
    assert.strictEqual(ret, 10);
  });
});
