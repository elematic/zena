import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('Debug generic interface', () => {
  test('generic method with interface return', async () => {
    // Minimal test: generic method returns interface, implementation returns concrete
    const source = `
      interface Box<T> {
        get(): T;
      }
      
      class MyBox<T> implements Box<T> {
        value: T;
        #new(value: T) { this.value = value; }
        get(): T { return this.value; }
      }
      
      class Factory {
        // Generic method that returns interface type
        make<U>(val: U): Box<U> {
          let b = new MyBox<U>(val);
          return b;  // Should box MyBox<U> to Box<U>
        }
      }
      
      export let main = (): i32 => {
        let f = new Factory();
        let box = f.make<i32>(42);
        return box.get();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('simple return interface boxing', async () => {
    // Simplified test: method returns interface type, but implementation returns concrete type
    const source = `
      interface Box<T> {
        get(): T;
      }
      
      class MyBox<T> implements Box<T> {
        value: T;
        #new(value: T) { this.value = value; }
        get(): T { return this.value; }
        
        // Method that returns Box<T> instead of MyBox<T>
        asBox(): Box<T> { return this; }
      }
      
      export let main = (): i32 => {
        let mb = new MyBox<i32>(42);
        let box = mb.asBox();  // Should box MyBox<i32> to Box<i32>
        return box.get();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test.only('generic method call', async () => {
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
