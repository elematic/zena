import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';
import {createWasiImports} from '../wasi_test_utils.js';

suite('CodeGenerator - WASI', () => {
  test('should compile and run WASI Hello World', async () => {
    const input = `
      @external("wasi:cli/stdout", "get-stdout")
      declare function get_stdout(): i32;

      @external("wasi:io/streams", "[method]output-stream.blocking-write-and-flush")
      declare function blocking_write_and_flush(handle: i32, ptr: i32, len: i32): void;

      @intrinsic("i32.store8")
      declare function store8(ptr: i32, value: i32): void;

      export let main = (): void => {
        // Write "Hello" to memory at offset 0
        store8(0, 72);  // H
        store8(1, 101); // e
        store8(2, 108); // l
        store8(3, 108); // l
        store8(4, 111); // o
        
        let stdout = get_stdout();
        blocking_write_and_flush(stdout, 0, 5);
      };
    `;
    const {imports, setMemory, output} = createWasiImports();
    const exports = await compileAndInstantiate(input, {imports});
    const {main, memory} = exports as any;

    setMemory(memory);
    main();

    assert.strictEqual(output.join(''), 'Hello');
  });
});
