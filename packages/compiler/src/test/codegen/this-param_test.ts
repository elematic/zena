import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('this.field constructor parameters', () => {
  test('simple this.field parameter', async () => {
    const result = await compileAndRun(`
      class Foo {
        bar: i32;
        new(this.bar);
      }

      export let main = () => {
        let f = new Foo(42);
        return f.bar;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('multiple this.field parameters', async () => {
    const result = await compileAndRun(`
      class Point {
        let x: i32;
        let y: i32;
        new(this.x, this.y);
      }

      export let main = () => {
        let p = new Point(3, 7);
        return p.x + p.y;
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('mixed this.field and regular parameters', async () => {
    const result = await compileAndRun(`
      class Rect {
        width: i32;
        height: i32;
        new(this.width, this.height, scale: i32) : width = width * scale, height = height * scale {}
      }

      export let main = () => {
        let r = new Rect(3, 4, 2);
        return r.width + r.height;
      };
    `);
    assert.strictEqual(result, 14);
  });

  test('this.field with body', async () => {
    const result = await compileAndRun(`
      class Counter {
        var count: i32;
        var doubled: i32 = 0;
        new(this.count) {
          this.doubled = this.count * 2;
        }
      }

      export let main = () => {
        let c = new Counter(5);
        return c.doubled;
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('this.field with inheritance', async () => {
    const result = await compileAndRun(`
      class Base {
        var x: i32;
        new(x: i32) : x = x {}
      }

      class Derived extends Base {
        y: i32;
        new(this.y, x: i32) : super(x) {}
      }

      export let main = () => {
        let d = new Derived(20, 10);
        return d.x + d.y;
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('this.field with default field values', async () => {
    const result = await compileAndRun(`
      class Config {
        name: i32;
        var debug: i32 = 0;
        new(this.name);
      }

      export let main = () => {
        let c = new Config(99);
        return c.name + c.debug;
      };
    `);
    assert.strictEqual(result, 99);
  });
});
