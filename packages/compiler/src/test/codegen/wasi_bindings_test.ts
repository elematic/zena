import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';
import {createWasiImports} from '../wasi_test_utils.js';

suite('CodeGenerator - WASI Bindings', () => {
  test('should compile and run WASI with Zena bindings', async () => {
    const input = `
      // Low-level WASI bindings
      @external("wasi:cli/stdout", "get-stdout")
      declare function __get_stdout(): i32;

      @external("wasi:io/streams", "[method]output-stream.blocking-write-and-flush")
      declare function __blocking_write_and_flush(handle: i32, ptr: i32, len: i32): void;

      @intrinsic("i32.store8")
      declare function store8(ptr: i32, value: i32): void;

      // Simple Allocator
      var heap_ptr = 0;
      let alloc = (size: i32): i32 => {
        let ptr = heap_ptr;
        heap_ptr = heap_ptr + size;
        return ptr;
      };

      let free = (ptr: i32, size: i32): void => {
        if (ptr + size == heap_ptr) {
          heap_ptr = ptr;
        }
      };

      // High-level OutputStream class
      class OutputStream {
        #handle: i32;

        #new(handle: i32) {
          this.#handle = handle;
        }

        static getStdout(): OutputStream {
          return new OutputStream(__get_stdout());
        }

        write(s: string): void {
          let len = s.length;
          let ptr = alloc(len);
          
          for (var i = 0; i < len; i = i + 1) {
            let b = s.getByteAt(i);
            store8(ptr + i, b);
          }
          
          __blocking_write_and_flush(this.#handle, ptr, len);
          free(ptr, len);
        }
      }

      export let main = (): void => {
        let stdout = OutputStream.getStdout();
        stdout.write("Hello from Zena!");
      };
    `;

    const {imports, setMemory, output} = createWasiImports();

    const exports = await compileAndInstantiate(input, {
      imports,
    });

    setMemory(exports.memory);
    exports.main();

    assert.strictEqual(output.join(''), 'Hello from Zena!');
  });
});
