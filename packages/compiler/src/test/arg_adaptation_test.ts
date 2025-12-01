import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {compile} from '../lib/index.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

suite('Argument Adaptation', () => {
  test('should adapt function arguments with fewer parameters', async () => {
    const filePath = join(process.cwd(), 'test-files/arg-adaptation.zena');
    const code = await readFile(filePath, 'utf-8');

    const wasm = await compile(code);
    assert.ok(wasm, 'Compilation failed');

    const result = (await WebAssembly.instantiate(wasm, {
      console: {
        log: (val: any) => console.log(val),
        log_i32: (val: number) => console.log(val),
        log_f32: (val: number) => console.log(val),
        log_string: (ptr: number, len: number) => console.log('string'),
        error_string: (ptr: number, len: number) => console.error('string'),
        warn_string: (ptr: number, len: number) => console.warn('string'),
        info_string: (ptr: number, len: number) => console.info('string'),
        debug_string: (ptr: number, len: number) => console.debug('string'),
      },
      env: {
        log: (val: number) => console.log(val),
      },
    })) as any;

    const main = result.instance.exports['main'] as CallableFunction;
    // Should run without error
    main();
  });

  test('should adapt function arguments when assigning to union type', async () => {
    const filePath = join(process.cwd(), 'test-files/union-adaptation.zena');
    const code = await readFile(filePath, 'utf-8');

    const wasm = await compile(code);
    assert.ok(wasm, 'Compilation failed');

    const result = (await WebAssembly.instantiate(wasm, {
      console: {
        log: (val: any) => console.log(val),
        log_i32: (val: number) => console.log(val),
        log_f32: (val: number) => console.log(val),
        log_string: (ptr: number, len: number) => console.log('string'),
        error_string: (ptr: number, len: number) => console.error('string'),
        warn_string: (ptr: number, len: number) => console.warn('string'),
        info_string: (ptr: number, len: number) => console.info('string'),
        debug_string: (ptr: number, len: number) => console.debug('string'),
      },
      env: {
        log: (val: number) => console.log(val),
      },
    })) as any;

    const main = result.instance.exports['main'] as CallableFunction;
    const ret = main();
    assert.strictEqual(ret, 10);
  });
});
