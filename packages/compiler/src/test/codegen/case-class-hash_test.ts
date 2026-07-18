import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {compileAndRun} from './utils.js';

suite('Case class hashCode', () => {
  test('hashCode returns i32', async () => {
    const result = await compileAndRun(`
      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let a = new Point(1, 2);
        return a.hashCode();
      };
    `);
    assert.equal(typeof result, 'number');
  });

  test('equal instances have same hashCode', async () => {
    const result = await compileAndRun(`
      class Point(x: i32, y: i32)

      export let main = (): boolean => {
        let a = new Point(1, 2);
        let b = new Point(1, 2);
        return a.hashCode() == b.hashCode();
      };
    `);
    assert.equal(result, 1);
  });

  test('different instances have different hashCode', async () => {
    const result = await compileAndRun(`
      class Point(x: i32, y: i32)

      export let main = (): boolean => {
        let a = new Point(1, 2);
        let b = new Point(3, 4);
        return a.hashCode() != b.hashCode();
      };
    `);
    assert.equal(result, 1);
  });

  test('hashCode with single field', async () => {
    const result = await compileAndRun(`
      class Wrapper(value: i32)

      export let main = (): i32 => {
        let w = new Wrapper(42);
        return w.hashCode();
      };
    `);
    // Single field: hashCode should be the field value itself
    assert.equal(result, 42);
  });

  test('case class as HashMap key', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let map = new HashMap<Point, i32>();
        let p1 = new Point(1, 2);
        let p2 = new Point(3, 4);
        map[p1] = 10;
        map[p2] = 20;

        // Lookup by equal (but different) instance
        let lookup = new Point(1, 2);
        return map[lookup];
      };
    `);
    assert.equal(result, 10);
  });

  test('case class HashMap overwrite by equal key', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let map = new HashMap<Point, i32>();
        let p1 = new Point(1, 2);
        map[p1] = 10;
        map[new Point(1, 2)] = 99;
        return map[p1];
      };
    `);
    assert.equal(result, 99);
  });

  test('synthesized hashCode overriding a sealed base hashCode', async () => {
    // Regression: the synthesized leaf hashCode overrides a base-class
    // hashCode, so its vtable slot types 'this' as the base struct. The
    // synthesized body must read fields through the downcast 'this' local
    // or the module fails wasm validation.
    const result = await compileAndRun(`
      sealed class Ty implements Hashable {
        hashCode(): i32 {
          return -1;
        }

        case IntTy
        case PairTy(a: i32, b: i32)
      }

      export let main = (): boolean => {
        let t2: Ty = new PairTy(3, 4);
        let t3: Ty = new PairTy(3, 4);
        // The leaf's synthesized hashCode is structural.
        return t2.hashCode() == t3.hashCode() && t2.hashCode() == 3 * 31 + 4;
      };
    `);
    assert.equal(result, 1);
  });
});
