import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from '../../lib/index.js';
import {instantiate} from '@zena-lang/runtime';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

suite('Standard Library - Console', () => {
  test('should print i32 using console.log', async () => {
    const stdlibPath = path.join(__dirname, '../../stdlib/console.zena');
    const stdlibSource = fs.readFileSync(stdlibPath, 'utf-8');

    const userSource = `
      export let main = () => {
        log(123);
      };
    `;

    // Simple concatenation for now until we have modules
    const source = stdlibSource + userSource;
    const wasm = compile(source);

    let output: any[] = [];
    const imports = {
      console: {
        log: (val: any) => output.push(val),
      },
    };

    const result = await instantiate(wasm, imports);
    const instance = 'instance' in result ? result.instance : result;
    const {main} = instance.exports as {main: () => void};
    main();

    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0], 123);
  });

  test('should print f32 using console.logF32', async () => {
    const stdlibPath = path.join(__dirname, '../../stdlib/console.zena');
    const stdlibSource = fs.readFileSync(stdlibPath, 'utf-8');

    const userSource = `
      export let main = () => {
        logF32(123.456);
      };
    `;

    const source = stdlibSource + userSource;
    const wasm = compile(source);

    let output: any[] = [];
    const imports = {
      console: {
        log: (val: any) => output.push(val),
      },
    };

    const result = await instantiate(wasm, imports);
    const instance = 'instance' in result ? result.instance : result;
    const {main} = instance.exports as {main: () => void};
    main();

    assert.strictEqual(output.length, 1);
    // Float precision might vary slightly, but exact match should work for this literal
    assert.ok(Math.abs(output[0] - 123.456) < 0.001);
  });
});
