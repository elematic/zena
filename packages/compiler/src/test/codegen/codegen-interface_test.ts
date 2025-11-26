import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compile} from '../../lib/index.js';

suite('CodeGenerator - Interfaces', () => {
  test('should compile and run interface method call', async () => {
    const source = `
      interface Runnable {
        run(): i32;
      }
      
      class Task implements Runnable {
        value: i32 = 10;
        run(): i32 {
          return this.value + 1;
        }
      }
      
      export let main = (): i32 => {
        let t = new Task();
        let r: Runnable = t;
        return r.run();
      };
    `;

    const wasm = compile(source);
    const result = await WebAssembly.instantiate(wasm, {});
    const instance = (result as any).instance || result;
    const main = instance.exports.main as () => number;

    assert.strictEqual(main(), 11);
  });

  test('should support multiple implementations', async () => {
    const source = `
      interface Calculator {
        calc(x: i32): i32;
      }
      
      class Double implements Calculator {
        calc(x: i32): i32 { return x * 2; }
      }
      
      class Square implements Calculator {
        calc(x: i32): i32 { return x * x; }
      }
      
      export let main = (): i32 => {
        let d = new Double();
        let s = new Square();
        
        let c1: Calculator = d;
        let c2: Calculator = s;
        
        return c1.calc(10) + c2.calc(10);
      };
    `;

    const wasm = compile(source);
    const result = await WebAssembly.instantiate(wasm, {});
    const instance = (result as any).instance || result;
    const main = instance.exports.main as () => number;

    assert.strictEqual(main(), 20 + 100);
  });

  test('should support interface with multiple methods', async () => {
    const source = `
      interface Point {
        getX(): i32;
        getY(): i32;
      }
      
      class Point2D implements Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        getX(): i32 { return this.x; }
        getY(): i32 { return this.y; }
      }
      
      export let main = (): i32 => {
        let p = new Point2D(10, 20);
        let i: Point = p;
        return i.getX() + i.getY();
      };
    `;
    const wasm = compile(source);
    const result = await WebAssembly.instantiate(wasm, {});
    const instance = (result as any).instance || result;
    const main = instance.exports.main as () => number;

    assert.strictEqual(main(), 30);
  });
});
