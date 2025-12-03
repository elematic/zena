import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Advanced Operators', () => {
  test('should support generic operator []', async () => {
    const input = `
      class Container<T> {
        item: T;
        #new(item: T) {
          this.item = item;
        }
        operator [](index: i32): T {
          return this.item;
        }
      }
      export let main = (): i32 => {
        let c = new Container<i32>(42);
        return c[0];
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 42);
  });

  test('should support generic operator []=', async () => {
    const input = `
      class Container<T> {
        item: T;
        #new(item: T) {
          this.item = item;
        }
        operator []=(index: i32, value: T): void {
          this.item = value;
        }
        get(): T { return this.item; }
      }
      export let main = (): i32 => {
        let c = new Container<i32>(0);
        c[0] = 42;
        return c.get();
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 42);
  });

  test('should support inheritance of operators', async () => {
    const input = `
      class Base {
        operator [](index: i32): i32 {
          return 10;
        }
      }
      class Derived extends Base {
      }
      export let main = (): i32 => {
        let d = new Derived();
        return d[0];
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 10);
  });

  test('should support overriding operators', async () => {
    const input = `
      class Base {
        operator [](index: i32): i32 {
          return 10;
        }
      }
      class Derived extends Base {
        operator [](index: i32): i32 {
          return 20;
        }
      }
      export let main = (): i32 => {
        let d = new Derived();
        return d[0];
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 20);
  });
});
