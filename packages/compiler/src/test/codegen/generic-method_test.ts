import {suite, test} from 'node:test';
import {compile} from '../../lib/index.js';

suite('Codegen: Generic Methods', () => {
  test('Generic method on class', async () => {
    const source = `
      class Box {
        value: i32;
        #new(v: i32) { this.value = v; }
        
        identity<T>(x: T): T {
          return x;
        }

        getValue<T>(x: T): i32 {
            return this.value;
        }
      }

      let b = new Box(42);
      b.identity<Box>(b);
    `;

    const wasm = compile(source);
    const imports = {
      console: {
        log_i32: () => {},
        log_f32: () => {},
        log_string: () => {},
        error_string: () => {},
        warn_string: () => {},
        info_string: () => {},
        debug_string: () => {},
      },
    };
    await WebAssembly.instantiate(wasm, imports);
  });

  test('Generic method execution', async () => {
    const source = `
      @external("env", "assert")
      declare function assert(condition: boolean): void;

      class Calculator {
        add<T>(a: i32, b: i32): i32 {
           return a + b;
        }
        
        generic<T>(a: T): T {
            return a;
        }
      }

      let c = new Calculator();
      assert((c.add<string>(1, 2)) == 3);
      assert((c.generic<i32>(123)) == 123);
     `;

    const wasm = compile(source);
    const imports = {
      env: {
        assert: (condition: number) => {
          if (!condition) throw new Error('Assertion failed');
        },
      },
      console: {
        log_i32: () => {},
        log_f32: () => {},
        log_string: () => {},
        error_string: () => {},
        warn_string: () => {},
        info_string: () => {},
        debug_string: () => {},
      },
    };
    await WebAssembly.instantiate(wasm, imports);
  });

  test('Generic method on mixin', async () => {
    const source = `
        @external("env", "assert")
        declare function assert(condition: boolean): void;

        mixin Logger {
            log<T>(msg: T): T {
                return msg;
            }
        }

        class App with Logger {}

        let app = new App();
        assert((app.log<i32>(42)) == 42);
      `;

    const wasm = compile(source);
    const imports = {
      env: {
        assert: (condition: number) => {
          if (!condition) throw new Error('Assertion failed');
        },
      },
      console: {
        log_i32: () => {},
        log_f32: () => {},
        log_string: () => {},
        error_string: () => {},
        warn_string: () => {},
        info_string: () => {},
        debug_string: () => {},
      },
    };
    await WebAssembly.instantiate(wasm, imports);
  });

  test('Generic method inheritance', async () => {
    const source = `
        @external("env", "assert")
        declare function assert(condition: boolean): void;

        class Base {
            identity<T>(x: T): T {
                return x;
            }
        }

        class Derived extends Base {}

        let d = new Derived();
        assert((d.identity<i32>(100)) == 100);
      `;

    const wasm = compile(source);
    const imports = {
      env: {
        assert: (condition: number) => {
          if (!condition) throw new Error('Assertion failed');
        },
      },
      console: {
        log_i32: () => {},
        log_f32: () => {},
        log_string: () => {},
        error_string: () => {},
        warn_string: () => {},
        info_string: () => {},
        debug_string: () => {},
      },
    };
    await WebAssembly.instantiate(wasm, imports);
  });

  test('Generic method on generic class', async () => {
    const source = `
        @external("env", "assert")
        declare function assert(condition: boolean): void;

        class Box<T> {
            value: T;
            #new(v: T) { this.value = v; }
            map<U>(f: (v: T) => U): U {
                return f(this.value);
            }
        }

        let box = new Box<i32>(10);
        assert(box.map<boolean>((x: i32) => x == 10));
      `;

    const wasm = compile(source);
    const imports = {
      env: {
        assert: (condition: number) => {
          if (!condition) throw new Error('Assertion failed');
        },
      },
      console: {
        log_i32: () => {},
        log_f32: () => {},
        log_string: () => {},
        error_string: () => {},
        warn_string: () => {},
        info_string: () => {},
        debug_string: () => {},
      },
    };
    await WebAssembly.instantiate(wasm, imports);
  });
});
