import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('class method multi-value returns', () => {
  suite('hole literal (_) in class methods', () => {
    test('_ generates correct type for reference type element', async () => {
      // This test verifies that ctx.currentCheckerReturnType is properly set
      // for class methods, which is needed to generate the correct zero-value
      // for `_` hole literals in inline tuple returns.
      //
      // Previously, `_` would generate i32 0 instead of ref.null because
      // currentCheckerReturnType was only set for top-level functions.
      const source = `
        class Wrapper {
          #value: i32;
          #new(v: i32) { this.#value = v; }
          getValue(): i32 { return this.#value; }
        }

        class Producer {
          #wrapper: Wrapper;
          #done: boolean;

          #new(v: i32) {
            this.#wrapper = new Wrapper(v);
            this.#done = false;
          }

          // Returns union of tuples with reference type element
          next(): inline (true, Wrapper) | inline (false, never) {
            if (this.#done) {
              // The _ here must generate ref.null, not i32 0
              return (false, _);
            }
            this.#done = true;
            return (true, this.#wrapper);
          }
        }

        export let test = (): i32 => {
          let producer = new Producer(42);
          let (hasValue, value) = producer.next();
          if (hasValue) {
            return (value as Wrapper).getValue();
          }
          return 0;
        };
      `;

      const exports = await compileAndInstantiate(source);
      const result = (exports.test as Function)();
      assert.strictEqual(result, 42);
    });

    test('_ generates correct type for primitive element', async () => {
      // Verify _ works correctly for primitive types too
      const source = `
        class Counter {
          #count: i32;
          #max: i32;

          #new(max: i32) {
            this.#count = 0;
            this.#max = max;
          }

          next(): inline (true, i32) | inline (false, never) {
            if (this.#count >= this.#max) {
              return (false, _);
            }
            let current = this.#count;
            this.#count = this.#count + 1;
            return (true, current);
          }
        }

        export let test = (): i32 => {
          let counter = new Counter(3);
          var sum = 0;
          while (let (true, n) = counter.next()) {
            sum = sum + n;
          }
          return sum;  // 0 + 1 + 2 = 3
        };
      `;

      const exports = await compileAndInstantiate(source);
      const result = (exports.test as Function)();
      assert.strictEqual(result, 3);
    });

    test('_ generates correct type for Box<i32> element', async () => {
      // Verify _ works with generic class types (using stdlib Box)
      const source = `
        class OptionalBox {
          #hasValue: boolean;
          #box: Box<i32>;

          #new(value: i32) {
            this.#hasValue = true;
            this.#box = new Box(value);
          }

          static empty(): OptionalBox {
            let opt = new OptionalBox(0);
            opt.#hasValue = false;
            return opt;
          }

          unwrap(): inline (true, Box<i32>) | inline (false, never) {
            if (this.#hasValue) {
              return (true, this.#box);
            }
            return (false, _);
          }
        }

        export let testSome = (): i32 => {
          let opt = new OptionalBox(42);
          let (hasValue, box) = opt.unwrap();
          if (hasValue) {
            return (box as Box<i32>).value;
          }
          return -1;
        };

        export let testNone = (): i32 => {
          let opt = OptionalBox.empty();
          let (hasValue, _) = opt.unwrap();
          if (hasValue) {
            return 1;
          }
          return 0;
        };
      `;

      const exports = await compileAndInstantiate(source);
      assert.strictEqual((exports.testSome as Function)(), 42);
      assert.strictEqual((exports.testNone as Function)(), 0);
    });
  });

  suite('multi-value return type registration', () => {
    test('class method with plain inline tuple return', async () => {
      const source = `
        class Point {
          #x: i32;
          #y: i32;

          #new(x: i32, y: i32) {
            this.#x = x;
            this.#y = y;
          }

          getCoords(): inline (i32, i32) {
            return (this.#x, this.#y);
          }
        }

        export let test = (): i32 => {
          let p = new Point(3, 4);
          let (x, y) = p.getCoords();
          return x + y;
        };
      `;

      const exports = await compileAndInstantiate(source);
      const result = (exports.test as Function)();
      assert.strictEqual(result, 7);
    });

    test('class method with union of tuples return', async () => {
      // Use multiplication instead of division to avoid f32 issues
      const source = `
        class Calculator {
          safeMul(a: i32, b: i32, limit: i32): inline (true, i32) | inline (false, never) {
            let result = a * b;
            if (result > limit) {
              return (false, _);
            }
            return (true, result);
          }
        }

        export let testSuccess = (): i32 => {
          let c = new Calculator();
          let (ok, result) = c.safeMul(3, 4, 100);
          if (ok) {
            return result;
          }
          return -1;
        };

        export let testFailure = (): i32 => {
          let c = new Calculator();
          let (ok, _) = c.safeMul(10, 20, 100);
          if (ok) {
            return 1;
          }
          return 0;
        };
      `;

      const exports = await compileAndInstantiate(source);
      assert.strictEqual((exports.testSuccess as Function)(), 12);
      assert.strictEqual((exports.testFailure as Function)(), 0);
    });
  });
});
