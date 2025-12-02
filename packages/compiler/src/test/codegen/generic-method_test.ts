import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

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

    await compileAndInstantiate(source);
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

    const imports = {
      env: {
        assert: (condition: number) => {
          if (!condition) throw new Error('Assertion failed');
        },
      },
    };
    await compileAndInstantiate(source, {imports});
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

    const imports = {
      env: {
        assert: (condition: number) => {
          if (!condition) throw new Error('Assertion failed');
        },
      },
    };
    await compileAndInstantiate(source, {imports});
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

    const imports = {
      env: {
        assert: (condition: number) => {
          if (!condition) throw new Error('Assertion failed');
        },
      },
    };
    await compileAndInstantiate(source, {imports});
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

    const imports = {
      env: {
        assert: (condition: number) => {
          if (!condition) throw new Error('Assertion failed');
        },
      },
    };
    await compileAndInstantiate(source, {imports});
  });
});
