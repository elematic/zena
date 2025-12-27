import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('interface closure contravariance', () => {
  test('closure expecting interface receives implementing class', async () => {
    const source = `
      interface Readable { read(): i32; }

      class Buffer implements Readable {
        value: i32;
        #new(v: i32) { this.value = v; }
        read(): i32 { return this.value; }

        apply(f: (r: Readable) => i32): i32 { return f(this); }
      }

      export let run = (): i32 => {
        let buf = new Buffer(42);
        let result = buf.apply((r: Readable) => r.read());
        return result;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 42);
  });

  test('closure expecting generic interface receives implementing class', async () => {
    const source = `
      interface Readable<T> { read(): T; }
      
      class Buffer implements Readable<i32> {
        value: i32;
        #new(v: i32) { this.value = v; }
        read(): i32 { return this.value; }

        apply(f: (r: Readable<i32>) => i32): i32 { return f(this); }
      }

      export let run = (): i32 => {
        let buf = new Buffer(42);
        let result = buf.apply((r: Readable<i32>) => r.read());
        return result;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 42);
  });

  test('generic closure expecting generic interface receives implementing class', async () => {
    const source = `
      interface Readable<T> { read(): T; }
      
      class Buffer<T> implements Readable<T> {
        value: T;
        #new(v: T) { this.value = v; }
        read(): T { return this.value; }

        apply(f: (r: Readable<T>) => T): T { return f(this); }
      }

      export let run = (): i32 => {
        let buf = new Buffer(42);
        let result = buf.apply((r: Readable<i32>) => r.read());
        return result;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 42);
  });

  test('higher-order function with interface callback parameter', async () => {
    const source = `
      interface HasLength { length: i32; }

      class MyArray implements HasLength {
        length: i32;
        #new(len: i32) { this.length = len; }
        process(f: (item: i32, arr: HasLength) => i32): i32 { return f(10, this); }
      }

      export let run = (): i32 => {
        let arr = new MyArray(5);
        let result = arr.process((x: i32, a: HasLength) => x + a.length);
        return result;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 15);
  });

  test('callback with contravariant interface parameter - direct', async () => {
    const source = `
      interface Counter { count(): i32; }

      class SimpleCounter implements Counter {
        value: i32;
        #new(v: i32) { this.value = v; }
        count(): i32 { return this.value; }

        withCounter(f: (c: Counter) => i32): i32 { return f(this); }
      }

      export let run = (): i32 => {
        let counter = new SimpleCounter(100);
        return counter.withCounter((c: Counter) => c.count());
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });

  test('generic class with interface callback - exact match', async () => {
    // Similar to FixedArray.map but using the same type (no interface widening)
    const source = `
      interface Seq<T> {
        get(i: i32): T;
      }

      class Arr<T> implements Seq<T> {
        #items: array<T>;
        #new(v: T) { this.#items = #[v]; }
        get(i: i32): T { return this.#items[i]; }

        process(f: (item: T, arr: Arr<T>) => T): T {
          return f(this.get(0), this);
        }
      }

      export let run = (): i32 => {
        let arr = new Arr<i32>(42);
        return arr.process((x: i32, a: Arr<i32>) => x + a.get(0));
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 84);
  });

  test('generic class with interface callback - interface widening', async () => {
    // This is the pattern that fails on template-strings-2
    // Callback expects Seq<T> but receives Arr<T> (which implements Seq<T>)
    const source = `
      interface Seq<T> {
        get(i: i32): T;
      }

      class Arr<T> implements Seq<T> {
        #items: array<T>;
        #new(v: T) { this.#items = #[v]; }
        get(i: i32): T { return this.#items[i]; }

        process(f: (item: T, seq: Seq<T>) => T): T {
          return f(this.get(0), this);
        }
      }

      export let run = (): i32 => {
        let arr = new Arr<i32>(42);
        return arr.process((x: i32, s: Seq<i32>) => x + s.get(0));
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 84);
  });
});
