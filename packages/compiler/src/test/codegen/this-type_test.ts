import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - This Type', () => {
  test('this type in class method parameter', async () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        
        equals(other: this): boolean {
          return this.x == other.x && this.y == other.y;
        }
      }
      
      export let main = () => {
        let p1 = new Point(3, 4);
        let p2 = new Point(3, 4);
        let p3 = new Point(5, 6);
        if (p1.equals(p2) && !p1.equals(p3)) {
          return 1;
        }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('this type in class method return type for fluent API', async () => {
    const source = `
      class Builder {
        value: i32 = 0;
        
        setValue(v: i32): this {
          this.value = v;
          return this;
        }
        
        add(v: i32): this {
          this.value = this.value + v;
          return this;
        }
      }
      
      export let main = () => {
        let b = new Builder();
        let b2 = b.setValue(10).add(5).add(3);
        return b2.value;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 18);
  });

  test('this type in interface callback parameter', async () => {
    // This tests that `this` type works in callback parameters within interfaces.
    // The interface erases `this` to anyref, but the class uses the specific type.
    // The trampoline must adapt between these closure types.
    const source = `
      interface Processor {
        process(f: (self: this) => i32): i32;
      }
      
      class MyProcessor implements Processor {
        value: i32;
        
        #new(value: i32) {
          this.value = value;
        }
        
        process(f: (self: MyProcessor) => i32): i32 {
          return f(this);
        }
      }
      
      export let main = () => {
        let p = new MyProcessor(42);
        return p.process((self: MyProcessor) => self.value);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('this type in generic class', async () => {
    const source = `
      class Container<T> {
        value: T;
        
        #new(value: T) {
          this.value = value;
        }
        
        withValue(newValue: T): this {
          this.value = newValue;
          return this;
        }
        
        getValue(): T {
          return this.value;
        }
      }
      
      export let main = () => {
        let c = new Container<i32>(10);
        let c2 = c.withValue(42);
        return c2.getValue();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('this type in interface with Comparable pattern', async () => {
    const source = `
      interface Comparable {
        compareTo(other: this): i32;
      }
      
      class Number implements Comparable {
        value: i32;
        
        #new(value: i32) {
          this.value = value;
        }
        
        compareTo(other: Number): i32 {
          if (this.value < other.value) {
            return 0 - 1;
          }
          if (this.value > other.value) {
            return 1;
          }
          return 0;
        }
      }
      
      export let main = () => {
        let a = new Number(5);
        let b = new Number(10);
        let c = new Number(5);
        
        // a < b: -1, a == c: 0, b > a: 1
        let r1 = a.compareTo(b);  // -1
        let r2 = a.compareTo(c);  // 0
        let r3 = b.compareTo(a);  // 1
        
        return r1 + r2 + r3; // -1 + 0 + 1 = 0
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 0);
  });
});
