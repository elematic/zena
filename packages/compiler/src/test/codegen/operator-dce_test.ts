/**
 * Test that operator methods are properly tracked by usage analysis (DCE).
 * These tests verify that operator methods called via syntax forms (obj[i], obj == other)
 * are marked as used and not eliminated as dead code.
 */

import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Operator Method DCE', () => {
  test('operator [] is kept when used via index syntax', async () => {
    const source = `
      class Box {
        operator [](index: i32): i32 {
          return index * 10;
        }
        
        // This method should be eliminated as unused
        unusedMethod(): i32 {
          return 999;
        }
      }
      
      export let main = (): i32 => {
        let b = new Box();
        return b[4]; // Should call operator [] and return 40
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 40, 'operator [] should work correctly');
  });

  test('operator []= is kept when used via index assignment syntax', async () => {
    const source = `
      class Box {
        #value: i32;
        
        #new() {
          this.#value = 0;
        }
        
        operator []=(index: i32, value: i32): void {
          this.#value = value + index;
        }
        
        getValue(): i32 {
          return this.#value;
        }
        
        // This method should be eliminated as unused
        unusedMethod(): i32 {
          return 999;
        }
      }
      
      export let main = (): i32 => {
        let b = new Box();
        b[5] = 10; // Should call operator []= and set value to 15
        return b.getValue();
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 15, 'operator []= should work correctly');
  });

  test('operator == is kept when used via equality syntax', async () => {
    const source = `
      class Point {
        x: i32;
        
        #new(x: i32) {
          this.x = x;
        }
        
        operator ==(other: Point): boolean {
          return this.x == other.x;
        }
        
        // This method should be eliminated as unused
        unusedMethod(): i32 {
          return 999;
        }
      }
      
      export let main = (): i32 => {
        let p1 = new Point(5);
        let p2 = new Point(5);
        let p3 = new Point(10);
        
        // Should use operator ==
        if (p1 == p2) {
          if (p1 == p3) {
            return 2;
          }
          return 1;
        }
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1, 'operator == should work correctly');
  });

  test('operator != uses operator == method', async () => {
    const source = `
      class Point {
        x: i32;
        
        #new(x: i32) {
          this.x = x;
        }
        
        operator ==(other: Point): boolean {
          return this.x == other.x;
        }
      }
      
      export let main = (): i32 => {
        let p1 = new Point(5);
        let p2 = new Point(10);
        
        // != should use operator == and negate the result
        if (p1 != p2) {
          return 1;
        }
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1, 'operator != should use operator ==');
  });

  test('overloaded operator [] methods are all kept when used', async () => {
    const source = `
      import {BoundedRange} from 'zena:range';
      
      class Container {
        #data: FixedArray<i32>;
        
        #new() {
          this.#data = #[10, 20, 30, 40, 50];
        }
        
        operator [](index: i32): i32 {
          return this.#data[index];
        }
        
        operator [](r: BoundedRange): i32 {
          // Return sum of slice
          let slice = this.#data.slice(r.start, r.end);
          let sum = 0;
          for (let i = 0; i < slice.length; i = i + 1) {
            sum = sum + slice[i];
          }
          return sum;
        }
        
        // This method should be eliminated as unused
        unusedMethod(): i32 {
          return 999;
        }
      }
      
      export let main = (): i32 => {
        let c = new Container();
        let val = c[2]; // Uses i32 overload -> 30
        let sum = c[1..4]; // Uses BoundedRange overload -> 20+30+40 = 90
        return val + sum; // 30 + 90 = 120
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 120, 'Both operator [] overloads should work');
  });

  test('operator methods on base class are kept when called through subclass', async () => {
    const source = `
      class Base {
        operator [](index: i32): i32 {
          return index + 100;
        }
      }
      
      class Derived extends Base {
        // Inherits operator [] from Base
        
        // This method should be eliminated as unused
        unusedMethod(): i32 {
          return 999;
        }
      }
      
      export let main = (): i32 => {
        let d = new Derived();
        return d[5]; // Should call Base's operator [] and return 105
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 105, 'Inherited operator [] should work');
  });

  test('overridden operator methods are kept when used polymorphically', async () => {
    const source = `
      class Base {
        operator ==(other: Base): boolean {
          return true; // Base always equals
        }
      }
      
      class Derived extends Base {
        value: i32;
        
        #new(v: i32) {
          super();
          this.value = v;
        }
        
        operator ==(other: Base): boolean {
          // Override to check value
          if (other is Derived) {
            return this.value == (other as Derived).value;
          }
          return false;
        }
      }
      
      export let main = (): i32 => {
        let d1: Base = new Derived(5);
        let d2: Base = new Derived(5);
        let d3: Base = new Derived(10);
        
        // Should use Derived's operator == via polymorphism
        if (d1 == d2) {
          if (d1 == d3) {
            return 2;
          }
          return 1;
        }
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1, 'Overridden operator == should work polymorphically');
  });
});
