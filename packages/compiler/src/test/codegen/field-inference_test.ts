import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Field type inference', () => {
  test('infer i32 from literal', async () => {
    const result = await compileAndRun(`
      class Foo {
        #x = 42;
        new() {}
        getX(): i32 { return this.#x; }
      }
      export let main = (): i32 => {
        let f = new Foo();
        return f.getX();
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('infer boolean from literal', async () => {
    const result = await compileAndRun(`
      class Foo {
        #flag = true;
        new() {}
        getFlag(): boolean { return this.#flag; }
      }
      export let main = (): i32 => {
        let f = new Foo();
        if (f.getFlag()) { return 1; }
        return 0;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('infer class type from new expression', async () => {
    const result = await compileAndRun(`
      class Inner {
        val: i32;
        new(v: i32) : val = v {}
      }
      class Outer {
        #inner = new Inner(99);
        new() {}
        getVal(): i32 { return this.#inner.val; }
      }
      export let main = (): i32 => {
        let o = new Outer();
        return o.getVal();
      };
    `);
    assert.strictEqual(result, 99);
  });

  test('infer var field type and allow mutation', async () => {
    const result = await compileAndRun(`
      class Counter {
        var #count = 0;
        new() {}
        inc(): void { this.#count = this.#count + 1; }
        getCount(): i32 { return this.#count; }
      }
      export let main = (): i32 => {
        let c = new Counter();
        c.inc();
        c.inc();
        c.inc();
        return c.getCount();
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('mixed inferred and annotated fields', async () => {
    const result = await compileAndRun(`
      class Mixed {
        #a: i32;
        #b = 10;
        new(a: i32) : #a = a {}
        sum(): i32 { return this.#a + this.#b; }
      }
      export let main = (): i32 => {
        let m = new Mixed(5);
        return m.sum();
      };
    `);
    assert.strictEqual(result, 15);
  });

  test('infer mixin field types from initializers', async () => {
    const result = await compileAndRun(`
      mixin Counted {
        var #count = 0;
        inc(): void { this.#count = this.#count + 1; }
        getCount(): i32 { return this.#count; }
      }
      class Widget with Counted {
        new() {}
      }
      export let main = (): i32 => {
        let w = new Widget();
        w.inc();
        w.inc();
        return w.getCount();
      };
    `);
    assert.strictEqual(result, 2);
  });
});
