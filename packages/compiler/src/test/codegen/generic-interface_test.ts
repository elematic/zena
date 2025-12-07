import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Generic Interfaces', () => {
  test('generic class implements generic interface', async () => {
    const source = `
      interface Box<T> {
        getValue(): T;
      }

      class Container<T> implements Box<T> {
        value: T;
        #new(value: T) { this.value = value; }
        getValue(): T { return this.value; }
      }

      export let main = () => {
        var c = new Container(42);
        var b: Box<i32> = c;
        return b.getValue();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('generic class implements generic interface with different type parameter names', async () => {
    const source = `
      interface Mapper<In, Out> {
        map(input: In): Out;
      }

      class Stringifier<T> implements Mapper<T, string> {
        map(input: T): string {
          return "value"; // Simplified for test
        }
      }

      export let main = () => {
        var s = new Stringifier<i32>();
        var m: Mapper<i32, string> = s;
        // We can't easily test string return yet without more stdlib, 
        // so just checking it compiles and runs without crashing is good.
        // Let's return length or something if we can, or just 1.
        m.map(123);
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('non-generic class implements generic interface', async () => {
    const source = `
      interface Provider<T> {
        get(): T;
      }

      class IntProvider implements Provider<i32> {
        get(): i32 { return 100; }
      }

      export let main = () => {
        var p = new IntProvider();
        var i: Provider<i32> = p;
        return i.get();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 100);
  });

  test('generic method call', async () => {
    const source = `
      export interface Sequence<T> {
        length: i32 { get; }
        operator [](index: i32): T;
        map<U>(f: (item: T, index: i32, seq: Sequence<T>) => U): Sequence<U>;
      }

      export class MyArray<T> implements Sequence<T> {
        #items: Array<T>;

        length: i32 {
          get {
            return this.#items.length;
          }
        }

        #new() {
          this.#items = new Array<T>();
        }

        map<U>(f: (item: T, index: i32, array: Sequence<T>) => U): Sequence<U> {
          let len = this.#items.length;
          let result = new MyArray<U>();
          var i = 0;
          while (i < len) {
            result.push(f(this[i], i, this));
            i = i + 1;
          }
          return result;
        }

        push(value: T): void {
          this.#items.push(value);
        }

        operator [](index: i32) :T {
          return this.#items[index];
        }

        operator []=(index: i32, value: T): void {
          this.#items[index] = value;
        }
      }

      export let main = () => {
        let arr = new MyArray<i32>();
        arr.push(1);
        arr.push(2);
        arr.push(3);
        
        let mapped = arr.map<boolean>((item: i32, index: i32, seq: Sequence<i32>): boolean => {
          return item % 2 == 0;
        });
        return mapped[1];
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
