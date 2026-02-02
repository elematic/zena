import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - operator +', () => {
  test('should compile and run basic operator +', async () => {
    const input = `
      class Vector {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        operator +(other: Vector): Vector {
          return new Vector(this.x + other.x, this.y + other.y);
        }
      }
      export let main = (): i32 => {
        let v1 = new Vector(1, 2);
        let v2 = new Vector(3, 4);
        let v3 = v1 + v2;
        return v3.x + v3.y;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 10); // (1+3) + (2+4) = 4 + 6 = 10
  });

  test('should compile and run operator + with i32 return', async () => {
    const input = `
      class Counter {
        value: i32;
        #new(value: i32) {
          this.value = value;
        }
        operator +(other: Counter): i32 {
          return this.value + other.value;
        }
      }
      export let main = (): i32 => {
        let c1 = new Counter(10);
        let c2 = new Counter(20);
        return c1 + c2;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 30);
  });

  test('should compile and run chained operator +', async () => {
    const input = `
      class Number {
        value: i32;
        #new(value: i32) {
          this.value = value;
        }
        operator +(other: Number): Number {
          return new Number(this.value + other.value);
        }
      }
      export let main = (): i32 => {
        let a = new Number(1);
        let b = new Number(2);
        let c = new Number(3);
        let result = a + b + c;
        return result.value;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 6);
  });

  test('should compile and run operator + on final class', async () => {
    const input = `
      final class Box {
        value: i32;
        #new(value: i32) {
          this.value = value;
        }
        operator +(other: Box): Box {
          return new Box(this.value + other.value);
        }
      }
      export let main = (): i32 => {
        let b1 = new Box(5);
        let b2 = new Box(7);
        return (b1 + b2).value;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 12);
  });

  test('should compile and run string concatenation via operator +', async () => {
    const input = `
      export let main = (): i32 => {
        let s1 = "Hello";
        let s2 = " World";
        let s3 = s1 + s2;
        return s3.length;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 11);
  });

  test('should compile and run chained string concatenation', async () => {
    const input = `
      export let main = (): i32 => {
        let a = "a";
        let b = "b";
        let c = "c";
        let result = a + b + c;
        return result.length;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 3);
  });

  test('should compile and run String.fromParts', async () => {
    const input = `
      export let main = (): i32 => {
        let parts = #["Hello", " ", "World", "!"];
        let result = String.fromParts(parts);
        return result.length;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 12); // "Hello World!" = 12 chars
  });

  test('should compile and run String.fromParts with single element', async () => {
    const input = `
      export let main = (): i32 => {
        let parts = #["test"];
        let result = String.fromParts(parts);
        return result.length;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 4);
  });
});
