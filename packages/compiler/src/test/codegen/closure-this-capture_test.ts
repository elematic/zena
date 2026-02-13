import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('Codegen: Closure this capture', () => {
  test('closure capturing this calls method correctly', async () => {
    const result = await compileAndRun(`
      class Counter {
        value: i32 = 0;

        increment() {
          this.value = this.value + 1;
        }

        getValue(): i32 {
          return this.value;
        }
      }

      export let main = () => {
        let c = new Counter();
        c.increment();
        c.increment();
        return c.getValue();
      };
    `);
    assert.strictEqual(result, 2);
  });

  test('closure capturing this passed as callback', async () => {
    const result = await compileAndRun(`
      class Parser {
        count: i32 = 0;

        parse(): i32 {
          this.count = this.count + 10;
          return this.count;
        }
      }

      let runCallback = (cb: () => i32) => cb();

      export let main = () => {
        let p = new Parser();
        // Create a closure that captures 'p' and calls a method on it
        let callback = () => p.parse();
        return runCallback(callback);
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('closure capturing this with private method', async () => {
    const result = await compileAndRun(`
      class Helper {
        state: i32 = 5;

        #double() {
          this.state = this.state * 2;
        }

        makeDoubler(): () => i32 {
          // Returns a closure that captures 'this' and calls private method
          return () => {
            this.#double();
            return this.state;
          };
        }
      }

      export let main = () => {
        let h = new Helper();
        let doubler = h.makeDoubler();
        doubler();  // 5 * 2 = 10
        return doubler();  // 10 * 2 = 20
      };
    `);
    assert.strictEqual(result, 20);
  });

  test('nested closure capturing this', async () => {
    const result = await compileAndRun(`
      class Outer {
        value: i32 = 3;

        createNested(): () => i32 {
          // Outer closure captures this, inner returns value
          return () => this.value * this.value;
        }
      }

      export let main = () => {
        let o = new Outer();
        let inner = o.createNested();
        return inner();  // 3 * 3 = 9
      };
    `);
    assert.strictEqual(result, 9);
  });

  test('closure capturing this in generic class', async () => {
    const result = await compileAndRun(`
      class Box<T> {
        item: T;

        #new(item: T) {
          this.item = item;
        }

        makeGetter(): () => T {
          return () => this.item;
        }
      }

      export let main = () => {
        let box = new Box<i32>(42);
        let getter = box.makeGetter();
        return getter();
      };
    `);
    assert.strictEqual(result, 42);
  });
});
