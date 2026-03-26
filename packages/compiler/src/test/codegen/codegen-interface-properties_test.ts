import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Interface Properties', () => {
  test('should access interface property implemented as field', async () => {
    const input = `
      interface Point {
        x: i32;
        y: i32;
      }
      
      class PointImpl implements Point {
        var x: i32;
        var y: i32;
        new(x: i32, y: i32) : x = x, y = y {}
      }
      
      export let main = (): i32 => {
        let p = new PointImpl(10, 20);
        let i: Point = p;
        return i.x + i.y;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 30);
  });

  test('should access interface property implemented as getter', async () => {
    const input = `
      interface Point {
        x: i32 { get; }
      }
      
      class PointImpl implements Point {
        x: i32 {
          get { return 42; }
        }
      }
      
      export let main = (): i32 => {
        let p = new PointImpl();
        let i: Point = p;
        return i.x;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 42);
  });

  test('should access interface accessor implemented as accessor', async () => {
    const input = `
      interface Container {
        value: i32 { get; set; }
      }
      
      class Box implements Container {
        var _value: i32 = 0;
        value: i32 {
          get { return this._value; }
          set(v) { this._value = v; }
        }
      }
      
      export let main = (): i32 => {
        let b = new Box();
        let c: Container = b;
        c.value = 42;
        return c.value;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 42);
  });

  test('should access interface getter only', async () => {
    const input = `
      interface ReadOnly {
        value: i32 { get; }
      }
      
      class Box implements ReadOnly {
        value: i32 {
          get { return 100; }
        }
      }
      
      export let main = (): i32 => {
        let b = new Box();
        let r: ReadOnly = b;
        return r.value;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 100);
  });

  test('should access interface setter only', async () => {
    const input = `
      interface WriteOnly {
        value: i32 { set; }
      }
      
      class Box implements WriteOnly {
        var _value: i32 = 0;
        value: i32 {
          set(v) { this._value = v; }
        }
        getVal(): i32 { return this._value; }
      }
      
      export let main = (): i32 => {
        let b = new Box();
        let w: WriteOnly = b;
        w.value = 50;
        return b.getVal();
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 50);
  });

  test('should read immutable interface field', async () => {
    const input = `
      interface Readable {
        x: i32;
      }

      class Impl implements Readable {
        x: i32;
        new(x: i32) : x = x {}
      }

      export let main = (): i32 => {
        let obj = new Impl(42);
        let r: Readable = obj;
        return r.x;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 42);
  });

  test('should read and write var interface field', async () => {
    const input = `
      interface Mutable {
        var x: i32;
      }

      class Impl implements Mutable {
        var x: i32 = 0;
      }

      export let main = (): i32 => {
        let obj = new Impl();
        let m: Mutable = obj;
        m.x = 99;
        return m.x;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 99);
  });

  test('var class field satisfies immutable interface field', async () => {
    const input = `
      interface Readable {
        x: i32;
      }

      class Impl implements Readable {
        var x: i32 = 0;
      }

      export let main = (): i32 => {
        let obj = new Impl();
        obj.x = 77;
        let r: Readable = obj;
        return r.x;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 77);
  });
});
