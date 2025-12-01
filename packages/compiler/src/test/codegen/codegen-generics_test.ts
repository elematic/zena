import {suite, test} from 'node:test';
import {compile} from '../../lib/index.js';
// import assert from 'node:assert';

suite('Codegen: Generics', () => {
  test('should compile generic class instantiation', async () => {
    const wasm = compile(
      `
      import { log } from 'zena:console';
      
      class Box<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      let b = new Box(10);
      log(b.getValue());
    `,
    );

    await WebAssembly.instantiate(wasm, {
      env: {
        print: (val: number) => console.log(val),
      },
      console: {
        log_i32: (val: number) => console.log(val),
        log_f32: (val: number) => console.log(val),
        log_string: (ptr: number, len: number) =>
          console.log(`[String ptr=${ptr} len=${len}]`),
        error_string: (ptr: number, len: number) =>
          console.error(`[String ptr=${ptr} len=${len}]`),
        warn_string: (ptr: number, len: number) =>
          console.warn(`[String ptr=${ptr} len=${len}]`),
        info_string: (ptr: number, len: number) =>
          console.info(`[String ptr=${ptr} len=${len}]`),
        debug_string: (ptr: number, len: number) =>
          console.debug(`[String ptr=${ptr} len=${len}]`),
      },
    });

    // assert.strictEqual(module.instance.exports.main(), 10);
  });
});
