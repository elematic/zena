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
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
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
        _value: i32 = 0;
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
        _value: i32 = 0;
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
});
