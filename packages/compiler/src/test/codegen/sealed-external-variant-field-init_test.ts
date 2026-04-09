/**
 * Tests for external sealed class variants with inline field initializers.
 *
 * Bug fix: Classes that extend a sealed class (which has no constructor)
 * with colon-initializer constructor syntax need their inline field
 * initializers to be generated even when there's no explicit super() call.
 *
 * Example pattern from self-hosted compiler:
 *   sealed class Type { case ClassType, ... }
 *   class ClassType extends Type {
 *     fields = new HashMap<String, Type>();  // inline initializer
 *     new(id: i32) : id = id;  // no super() since sealed base has no ctor
 *   }
 */
import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('External Sealed Variant Field Initializers', () => {
  test('should initialize inline fields in external variant without super()', async () => {
    // This mirrors the ClassType pattern from types.zena
    const result = await compileAndRun(`
      sealed class Type {
        case I32Type
        case ClassType
      }

      class ClassType extends Type {
        id: i32;
        count: i32 = 42;  // inline initializer - this was the bug
        new(id: i32) : id = id;
      }

      export let main = (): i32 => {
        let ct = new ClassType(1);
        return ct.count;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('should initialize multiple inline fields in external variant', async () => {
    const result = await compileAndRun(`
      sealed class Base {
        case Leaf
        case Node
      }

      class Node extends Base {
        id: i32;
        left: i32 = 10;
        right: i32 = 20;
        new(id: i32) : id = id;
      }

      export let main = (): i32 => {
        let n = new Node(1);
        return n.left + n.right;
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('should initialize reference type inline fields in external variant', async () => {
    const result = await compileAndRun(`
      class Box {
        value: i32;
        new(value: i32) : value = value;
      }

      sealed class Container {
        case Empty
        case Holding
      }

      class Holding extends Container {
        id: i32;
        box: Box = new Box(99);  // reference type inline initializer
        new(id: i32) : id = id;
      }

      export let main = (): i32 => {
        let h = new Holding(1);
        return h.box.value;
      };
    `);
    assert.strictEqual(result, 99);
  });

  test('should initialize array type inline fields in external variant', async () => {
    const result = await compileAndRun(`
      sealed class Collection {
        case Empty
        case Items
      }

      class Items extends Collection {
        id: i32;
        data: FixedArray<i32> = [1, 2, 3];  // array inline initializer
        new(id: i32) : id = id;
      }

      export let main = (): i32 => {
        let items = new Items(1);
        return items.data[0] + items.data[1] + items.data[2];
      };
    `);
    assert.strictEqual(result, 6);
  });

  test('should work with constructor body after colon initializer', async () => {
    // Inline field initializers should run BEFORE the constructor body
    const result = await compileAndRun(`
      sealed class Type {
        case Primitive
        case Complex
      }

      class Complex extends Type {
        var id: i32;
        baseValue: i32 = 100;
        new(initId: i32) : id = initId {
          this.id = this.id * 2;
        }
      }

      export let main = (): i32 => {
        let c = new Complex(5);
        return c.id + c.baseValue;  // should be 10 + 100 = 110
      };
    `);
    assert.strictEqual(result, 110);
  });

  test('should initialize fields correctly with both colon init and inline init', async () => {
    // Mix of colon-initializer fields and inline-initializer fields
    const result = await compileAndRun(`
      sealed class Parent {
        case Child
      }

      class Child extends Parent {
        a: i32;  // colon-initialized
        b: i32 = 20;  // inline-initialized
        c: i32;  // colon-initialized
        d: i32 = 40;  // inline-initialized
        new(a: i32, c: i32) : a = a, c = c;
      }

      export let main = (): i32 => {
        let child = new Child(10, 30);
        return child.a + child.b + child.c + child.d;  // 10 + 20 + 30 + 40 = 100
      };
    `);
    assert.strictEqual(result, 100);
  });
});
