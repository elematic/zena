import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Method Overloading', () => {
  test('should resolve overloaded methods by parameter type', async () => {
    const source = `
      class Printer {
        print(val: i32): i32 {
          return val * 2;
        }
        
        print(val: f32): i32 {
          return 100;
        }
      }
      
      export let main = (): i32 => {
        let p = new Printer();
        let a = p.print(21);      // Should call i32 version -> 42
        let b = p.print(3.14);    // Should call f32 version -> 100
        return a + b;             // 142
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 142);
  });

  test('should resolve overloaded methods by parameter count', async () => {
    const source = `
      class Calculator {
        add(a: i32): i32 {
          return a;
        }
        
        add(a: i32, b: i32): i32 {
          return a + b;
        }
      }
      
      export let main = (): i32 => {
        let c = new Calculator();
        let a = c.add(10);        // Should call 1-param version -> 10
        let b = c.add(10, 20);    // Should call 2-param version -> 30
        return a + b;             // 40
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 40);
  });

  test('should resolve overloaded methods with class parameter', async () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
      
      class Formatter {
        format(val: i32): i32 {
          return val;
        }
        
        format(val: Point): i32 {
          return val.x + val.y;
        }
      }
      
      export let main = (): i32 => {
        let f = new Formatter();
        let a = f.format(10);                    // i32 version -> 10
        let b = f.format(new Point(20, 30));     // Point version -> 50
        return a + b;                            // 60
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 60);
  });

  test('should support overloaded methods in inheritance', async () => {
    const source = `
      class Base {
        process(val: i32): i32 {
          return val;
        }
        
        process(val: f32): i32 {
          return 100;
        }
      }
      
      class Child extends Base {
        // Override only the i32 version
        process(val: i32): i32 {
          return val * 3;
        }
      }
      
      export let main = (): i32 => {
        let c = new Child();
        let a = c.process(10);      // Overridden i32 version -> 30
        let b = c.process(3.14);    // Inherited f32 version -> 100
        return a + b;               // 130
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 130);
  });

  test('should support virtual dispatch with overloaded methods', async () => {
    const source = `
      class Base {
        calc(val: i32): i32 {
          return val;
        }
      }
      
      class Child extends Base {
        calc(val: i32): i32 {
          return val * 2;
        }
      }
      
      let dispatch = (b: Base): i32 => {
        return b.calc(10);
      };
      
      export let main = (): i32 => {
        let base = new Base();
        let child = new Child();
        let a = dispatch(base);    // Should use Base.calc -> 10
        let b = dispatch(child);   // Should use Child.calc (virtual dispatch) -> 20
        return a + b;              // 30
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 30);
  });

  test('should support overloaded operators', async () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        
        operator [](index: i32): i32 {
          if (index == 0) return this.x;
          return this.y;
        }
        
        operator [](name: string): i32 {
          if (name == 'x') return this.x;
          return this.y;
        }
      }
      
      export let main = (): i32 => {
        let p = new Point(10, 20);
        let a = p[0];        // i32 index -> 10
        let b = p['y'];      // string index -> 20
        return a + b;        // 30
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 30);
  });
});
