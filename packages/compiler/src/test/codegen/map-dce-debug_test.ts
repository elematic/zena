/**
 * Debug test for Map DCE issue.
 *
 * The error is: function index #127 is out of bounds
 * This happens when compiling Map<String,i32>.[]=
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileToWasm} from './utils.js';
import {writeFileSync} from 'node:fs';

suite('Map DCE Debug', () => {
  test('FixedArray read with DCE', async () => {
    const source = `
      import {FixedArray} from 'zena:fixed-array';
      export let main = () => {
        let arr = new FixedArray<i32>(10, 0);
        return arr[0];
      };
    `;
    const bytes = compileToWasm(source, '/main.zena', {dce: true});
    writeFileSync('/tmp/test-dce.wasm', bytes);

    await WebAssembly.compile(bytes.buffer as ArrayBuffer);
    console.log(`FixedArray read with DCE: ${bytes.length} bytes`);
    assert.ok(bytes.length > 0);
  });

  test('FixedArray write with DCE', async () => {
    const source = `
      import {FixedArray} from 'zena:fixed-array';
      export let main = () => {
        let arr = new FixedArray<i32>(10, 0);
        arr[0] = 42;
        return 0;
      };
    `;
    const bytes = compileToWasm(source, '/main.zena', {dce: true});
    await WebAssembly.compile(bytes.buffer as ArrayBuffer);
    console.log(`FixedArray write with DCE: ${bytes.length} bytes`);
    assert.ok(bytes.length > 0);
  });

  test('FixedArray read+write with DCE', async () => {
    const source = `
      import {FixedArray} from 'zena:fixed-array';
      export let main = () => {
        let arr = new FixedArray<i32>(10, 0);
        arr[0] = 42;
        return arr[0];
      };
    `;
    const bytes = compileToWasm(source, '/main.zena', {dce: true});
    await WebAssembly.compile(bytes.buffer as ArrayBuffer);
    console.log(`FixedArray read+write with DCE: ${bytes.length} bytes`);
    assert.ok(bytes.length > 0);
  });

  test.only('empty Map with DCE', async () => {
    const source = `
      import {HashMap} from 'zena:map';
      export let main = () => {
        let m = new HashMap<string, i32>();
        return 42;
      };
    `;
    // Generate both for comparison
    const bytesNoDCE = compileToWasm(source, '/main.zena', {dce: false});
    writeFileSync('/tmp/map-no-dce.wasm', bytesNoDCE);
    console.log('Generated no-DCE version');

    const bytes = compileToWasm(source, '/main.zena', {dce: true});
    writeFileSync('/tmp/map-dce.wasm', bytes);
    console.log('Generated DCE version');

    await WebAssembly.compile(bytes.buffer as ArrayBuffer);
    console.log(`Empty Map with DCE: ${bytes.length} bytes`);
    assert.ok(bytes.length > 0);
  });

  test('map literal with DCE', async () => {
    const source = `
      import {HashMap} from 'zena:map';
      export let main = () => {
        let m = {"a" => 1};
        return 42;
      };
    `;
    const bytes = compileToWasm(source, '/main.zena', {dce: true});
    await WebAssembly.compile(bytes.buffer as ArrayBuffer);
    console.log(`Map literal with DCE: ${bytes.length} bytes`);
    assert.ok(bytes.length > 0);
  });
});
