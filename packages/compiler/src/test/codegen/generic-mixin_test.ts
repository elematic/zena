import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Generic Mixins', () => {
  test('should compile and run simplest generic mixin', async () => {
    const source = `
      mixin Container<T> {
        item: T;
      }

      class Holder with Container<i32> {}

      export let test = (): i32 => {
        let h = new Holder();
        return 42;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 42);
  });

  test('should compile and run generic mixin with i32 type argument', async () => {
    const source = `
      class Base {
        value: i32 = 10;
      }

      mixin Container<T> on Base {
        item: T;
        getValue(): i32 {
          return this.value * 2;
        }
      }

      class Holder extends Base with Container<i32> {}

      export let test = (): i32 => {
        let h = new Holder();
        return h.getValue();
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 20);
  });

  test('should compile and run generic mixin with multiple type parameters', async () => {
    const source = `
      class Base {}

      mixin Pair<T, U> {
        first: T;
        second: U;
      }

      class IntStringPair with Pair<i32, i64> {}

      export let test = (): i32 => {
        let p = new IntStringPair();
        return 42;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 42);
  });

  test('should compile and run generic mixin accessing its generic field', async () => {
    const source = `
      mixin Box<T> {
        value: T;
        getValue(): T {
          return this.value;
        }
      }

      class I32Box with Box<i32> {}

      export let test = (): i32 => {
        let b = new I32Box();
        b.value = 99;
        return b.getValue();
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 99);
  });
});
