import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen: Immutable Fields', () => {
  test('let field with initializer list', async () => {
    const source = `
      class Point {
        let x: i32;
        let y: i32;

        #new(x: i32, y: i32) : x = x, y = y { }

        sum(): i32 {
          return this.x + this.y;
        }
      }

      export let main = (): i32 => {
        let p = new Point(10, 20);
        return p.sum();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 30);
  });

  test('let field with computed initializer', async () => {
    const source = `
      class Rectangle {
        let width: i32;
        let height: i32;
        let area: i32;

        #new(w: i32, h: i32) : width = w, height = h, area = w * h { }

        getArea(): i32 {
          return this.area;
        }
      }

      export let main = (): i32 => {
        let r = new Rectangle(5, 7);
        return r.getArea();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 35);
  });

  test('mixed let and var fields', async () => {
    const source = `
      class Counter {
        let id: i32;
        var count: i32 = 0;

        #new(id: i32) : id = id { }

        increment(): void {
          this.count = this.count + 1;
        }

        get(): i32 {
          return this.id * 1000 + this.count;
        }
      }

      export let main = (): i32 => {
        let c = new Counter(7);
        c.increment();
        c.increment();
        return c.get();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 7002);
  });

  test('let field with inline default', async () => {
    const source = `
      class Config {
        let version: i32 = 1;
        let enabled: boolean = true;

        #new() { }

        check(): i32 {
          if (this.enabled) {
            return this.version;
          }
          return 0;
        }
      }

      export let main = (): i32 => {
        let c = new Config();
        return c.check();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 1);
  });

  test('mutable field can be modified', async () => {
    const source = `
      class Box {
        value: i32 = 0;
        
        set(v: i32): void {
          this.value = v;
        }
      }
      
      export let main = (): i32 => {
        let b = new Box();
        b.set(42);
        return b.value;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 42);
  });
});
