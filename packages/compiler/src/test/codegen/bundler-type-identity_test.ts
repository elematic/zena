/**
 * Tests for type identity after bundling.
 *
 * These tests verify that type lookups work correctly when:
 * 1. Multiple modules define classes with similar names (suffix collision)
 * 2. Multiple modules define classes with the same name
 * 3. Generic classes reference other types internally
 *
 * ## Analysis of Suffix-Based Lookups
 *
 * The current implementation uses suffix-based name matching in mapType() as a
 * fallback when the type name is not found directly in ctx.classes. The code:
 *
 * ```ts
 * for (const [name, classInfo] of ctx.classes) {
 *   if (name.endsWith('_' + typeName)) {
 *     return classInfo;  // Returns FIRST match
 *   }
 * }
 * ```
 *
 * **Finding: This fallback appears to be dead code in practice.**
 *
 * The bundler correctly updates all TypeAnnotation nodes with their bundled
 * names (e.g., `m0_Data`), so the direct `ctx.classes.has(typeName)` lookup
 * always succeeds before the suffix fallback is reached.
 *
 * However, the suffix-based approach is still problematic because:
 * 1. It couples codegen to bundler naming conventions
 * 2. It's fragile if any future code path introduces unbundled type names
 * 3. It returns the FIRST match, which is non-deterministic w.r.t. Map insertion order
 *
 * After Round 2 refactoring, these lookups should use identity-based lookups
 * through the checker's type system instead of string manipulation.
 *
 * See docs/design/compiler-refactoring.md for details.
 */
import {suite, test} from 'node:test';
import {strict as assert} from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('Bundler Type Identity', () => {
  /**
   * Test that suffix-based lookup doesn't incorrectly match.
   *
   * If we have classes `Array` and `MyArray`, a suffix-based lookup for
   * `Array` using `name.endsWith('_Array')` could incorrectly match
   * `m1_MyArray` instead of `m2_Array`.
   *
   * This test creates two modules:
   * - module_a: defines `MyArray` class
   * - module_b: defines `Array` class (not the stdlib one)
   *
   * The main module uses both. If suffix matching is wrong, it might
   * use the wrong struct type.
   */
  test('suffix collision: Array vs MyArray', async () => {
    const modules = {
      module_a: `
        export class MyArray {
          value: i32;
          #new(v: i32) { this.value = v; }
          get(): i32 { return this.value; }
        }
      `,
      module_b: `
        export class Array {
          items: i32;
          #new(n: i32) { this.items = n; }
          length(): i32 { return this.items; }
        }
      `,
      main: `
        import { MyArray } from "module_a";
        import { Array } from "module_b";

        export let testMyArray = (): i32 => {
          let ma = new MyArray(42);
          return ma.get();
        };

        export let testArray = (): i32 => {
          let arr = new Array(10);
          return arr.length();
        };

        export let testBoth = (): i32 => {
          let ma = new MyArray(100);
          let arr = new Array(5);
          return ma.get() + arr.length();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.testMyArray(), 42);
    assert.equal(exports.testArray(), 10);
    assert.equal(exports.testBoth(), 105);
  });

  /**
   * Test same-name classes in different modules with distinct methods.
   *
   * Two modules define a class with the EXACT same name `Data`. After bundling,
   * they become `m0_Data` and `m1_Data`. If suffix lookup is triggered with
   * just `Data`, it matches both via `endsWith('_Data')`, and the wrong one
   * might be returned.
   *
   * This test uses distinct methods on each class to detect if the wrong
   * type is used - calling a non-existent method would cause a runtime error.
   */
  test('same-name classes with distinct methods', async () => {
    const modules = {
      data_a: `
        export class Data {
          value: i32;
          #new(v: i32) { this.value = v; }
          fromA(): i32 { return 1; }
        }
      `,
      data_b: `
        export class Data {
          value: i32;
          #new(v: i32) { this.value = v; }
          fromB(): i32 { return 2; }
        }
      `,
      main: `
        import { Data as DataA } from "data_a";
        import { Data as DataB } from "data_b";

        export let testA = (): i32 => {
          let a = new DataA(10);
          return a.fromA();
        };

        export let testB = (): i32 => {
          let b = new DataB(20);
          return b.fromB();
        };

        export let testBoth = (): i32 => {
          let a = new DataA(10);
          let b = new DataB(20);
          return a.fromA() + b.fromB();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.testA(), 1);
    assert.equal(exports.testB(), 2);
    assert.equal(exports.testBoth(), 3);
  });

  /**
   * Test generic class with same-name type arguments from different modules.
   *
   * This is the key test for suffix matching vulnerability:
   * - Module data_a: `Data` with `fromA()` method
   * - Module data_b: `Data` with `fromB()` method
   * - Module container: generic `Container<T>`
   * - Main: uses `Container<DataA>` and `Container<DataB>`
   *
   * When Container<DataA> is instantiated, the type parameter T is resolved
   * to the DataA type. If suffix lookup is triggered during instantiation
   * and incorrectly matches the wrong `Data` class, calling the wrong
   * method would fail.
   */
  test('generic with same-name types from different modules', async () => {
    const modules = {
      data_a: `
        export class Data {
          n: i32;
          #new(n: i32) { this.n = n; }
          fromA(): i32 { return this.n + 100; }
        }
      `,
      data_b: `
        export class Data {
          n: i32;
          #new(n: i32) { this.n = n; }
          fromB(): i32 { return this.n + 200; }
        }
      `,
      container: `
        export class Container<T> {
          item: T;
          #new(item: T) { this.item = item; }
          getItem(): T { return this.item; }
        }
      `,
      main: `
        import { Data as DataA } from "data_a";
        import { Data as DataB } from "data_b";
        import { Container } from "container";

        export let testContainerA = (): i32 => {
          let a = new DataA(1);
          let c = new Container<DataA>(a);
          let item = c.getItem();
          return item.fromA();
        };

        export let testContainerB = (): i32 => {
          let b = new DataB(2);
          let c = new Container<DataB>(b);
          let item = c.getItem();
          return item.fromB();
        };

        export let testBothContainers = (): i32 => {
          let a = new DataA(1);
          let b = new DataB(2);
          let ca = new Container<DataA>(a);
          let cb = new Container<DataB>(b);
          let itemA = ca.getItem();
          let itemB = cb.getItem();
          // If suffix matching is broken, this would fail:
          // itemA might be DataB (missing fromA) or
          // itemB might be DataA (missing fromB)
          return itemA.fromA() + itemB.fromB();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.testContainerA(), 101); // 1 + 100
    assert.equal(exports.testContainerB(), 202); // 2 + 200
    assert.equal(exports.testBothContainers(), 303); // 101 + 202
  });

  /**
   * Test generic class instantiation across modules.
   *
   * A generic class `Container<T>` in one module is used with a type
   * from another module. The type annotations inside Container<T> need
   * to resolve correctly after bundling.
   */
  test('generic class with cross-module type', async () => {
    const modules = {
      data: `
        export class Data {
          value: i32;
          #new(v: i32) { this.value = v; }
          get(): i32 { return this.value; }
        }
      `,
      container: `
        export class Container<T> {
          item: T;
          #new(item: T) { this.item = item; }
          getItem(): T { return this.item; }
        }
      `,
      main: `
        import { Data } from "data";
        import { Container } from "container";

        export let test = (): i32 => {
          let d = new Data(99);
          let c = new Container<Data>(d);
          let retrieved = c.getItem();
          return retrieved.get();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.test(), 99);
  });

  /**
   * Test that field types resolve correctly across module boundaries.
   *
   * A class in module A has a field of type defined in module B.
   * After bundling, the field type annotation should resolve correctly.
   */
  test('field type from another module', async () => {
    const modules = {
      types: `
        export class Point {
          x: i32;
          y: i32;
          #new(x: i32, y: i32) {
            this.x = x;
            this.y = y;
          }
        }
      `,
      shapes: `
        import { Point } from "types";

        export class Rectangle {
          topLeft: Point;
          bottomRight: Point;

          #new(tl: Point, br: Point) {
            this.topLeft = tl;
            this.bottomRight = br;
          }

          width(): i32 { return this.bottomRight.x - this.topLeft.x; }
          height(): i32 { return this.bottomRight.y - this.topLeft.y; }
          area(): i32 { return this.width() * this.height(); }
        }
      `,
      main: `
        import { Point } from "types";
        import { Rectangle } from "shapes";

        export let test = (): i32 => {
          let tl = new Point(0, 0);
          let br = new Point(10, 5);
          let rect = new Rectangle(tl, br);
          return rect.area();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.test(), 50);
  });

  /**
   * Test interface implementation across modules.
   *
   * An interface in one module is implemented by a class in another.
   * Type annotations for the interface should resolve correctly.
   */
  test('interface from another module', async () => {
    const modules = {
      interfaces: `
        export interface Identifiable {
          id(): i32;
        }
      `,
      impl: `
        import { Identifiable } from "interfaces";

        export class Entity implements Identifiable {
          _id: i32;
          #new(id: i32) { this._id = id; }
          id(): i32 { return this._id; }
        }
      `,
      main: `
        import { Identifiable } from "interfaces";
        import { Entity } from "impl";

        let getId = (obj: Identifiable): i32 => obj.id();

        export let test = (): i32 => {
          let e = new Entity(42);
          return getId(e);
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.test(), 42);
  });

  /**
   * TODO: Test that demonstrates a known limitation with suffix matching.
   *
   * This test is marked as todo because it requires a scenario where
   * suffix matching actually breaks. Currently, the bundler updates
   * most type annotations correctly, so suffix matching works as a
   * fallback. After Round 2, this should be converted to a regular test.
   *
   * The suffix lookup returns the FIRST match found when iterating
   * ctx.classes (a Map). If two classes from different modules have
   * the same name:
   * - `m0_Data` (from module a)
   * - `m1_Data` (from module b)
   *
   * A suffix lookup for `Data` using `endsWith('_Data')` would match
   * the first one encountered in the Map iteration order. Map iteration
   * order is insertion order, so this is deterministic but fragile -
   * it depends on module processing order.
   *
   * The fix is to use identity-based lookups where the checker type object
   * is used directly as a key, not its string name.
   */
  test.todo('suffix matching collision when bundler misses type annotation');

  /**
   * Test two generic classes with the same name from different modules.
   *
   * This tests a scenario that SHOULD trigger suffix matching issues:
   * - Module box_a: `Box<T>` bundled as `m0_Box`
   * - Module box_b: `Box<T>` bundled as `m1_Box`
   *
   * Each Box has a different method to distinguish them.
   * If suffix matching for `Box` returns the wrong one, calling
   * the wrong method would fail at runtime.
   */
  test('two generic classes with same name', async () => {
    const modules = {
      box_a: `
        export class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }
          unwrapA(): T { return this.value; }
        }
      `,
      box_b: `
        export class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }
          unwrapB(): T { return this.value; }
        }
      `,
      main: `
        import { Box as BoxA } from "box_a";
        import { Box as BoxB } from "box_b";

        export let testBoxA = (): i32 => {
          let b = new BoxA<i32>(100);
          return b.unwrapA();
        };

        export let testBoxB = (): i32 => {
          let b = new BoxB<i32>(200);
          return b.unwrapB();
        };

        export let testBoth = (): i32 => {
          let a = new BoxA<i32>(10);
          let b = new BoxB<i32>(20);
          // If suffix matching returns wrong Box, this fails:
          // - unwrapA() doesn't exist on BoxB
          // - unwrapB() doesn't exist on BoxA
          return a.unwrapA() + b.unwrapB();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.testBoxA(), 100);
    assert.equal(exports.testBoxB(), 200);
    assert.equal(exports.testBoth(), 30);
  });

  /**
   * Test user-defined class with same name as stdlib class.
   *
   * This tests a scenario that could trigger suffix matching issues:
   * - stdlib has `FixedArray<T>` bundled as `m0_FixedArray`
   * - user module defines `FixedArray` (not generic) bundled as `m1_FixedArray`
   *
   * Type lookups must correctly distinguish these.
   */
  test('user class shadowing stdlib class name', async () => {
    const modules = {
      custom: `
        // A class with same name as stdlib FixedArray (but not generic)
        export class FixedArray {
          len: i32;
          #new(len: i32) { this.len = len; }
          getLength(): i32 { return this.len; }
        }
      `,
      main: `
        import { FixedArray as StdlibArray } from "zena:fixed-array";
        import { FixedArray as CustomArray } from "custom";

        export let testStdlib = (): i32 => {
          // FixedArray(length, defaultValue)
          let arr = new StdlibArray<i32>(5, 0);
          return arr.length;
        };

        export let testCustom = (): i32 => {
          let arr = new CustomArray(10);
          return arr.getLength();
        };

        export let testBoth = (): i32 => {
          let stdlib = new StdlibArray<i32>(3, 0);
          let custom = new CustomArray(7);
          return stdlib.length + custom.getLength();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.testStdlib(), 5);
    assert.equal(exports.testCustom(), 10);
    assert.equal(exports.testBoth(), 10); // 3 + 7
  });

  /**
   * Test that demonstrates suffix matching vulnerability.
   *
   * This test creates a scenario where two classes have names that would
   * collide under suffix matching:
   * - Module 1: `Item` -> bundled as `m0_Item`
   * - Module 2: `MenuItem` -> bundled as `m1_MenuItem`
   *
   * A suffix-based lookup for `Item` using `endsWith('_Item')` would match
   * BOTH `m0_Item` and `m1_MenuItem`. The current implementation iterates
   * through all classes and returns the first match, which may be wrong
   * depending on iteration order.
   *
   * This test verifies that both types are correctly distinguished.
   */
  test('suffix matching vulnerability: Item vs MenuItem', async () => {
    const modules = {
      item: `
        export class Item {
          price: i32;
          #new(p: i32) { this.price = p; }
          getPrice(): i32 { return this.price; }
        }
      `,
      menu: `
        export class MenuItem {
          name: i32;
          #new(n: i32) { this.name = n; }
          getName(): i32 { return this.name; }
        }
      `,
      main: `
        import { Item } from "item";
        import { MenuItem } from "menu";

        export let testItem = (): i32 => {
          let i = new Item(100);
          return i.getPrice();
        };

        export let testMenuItem = (): i32 => {
          let m = new MenuItem(42);
          return m.getName();
        };

        // If suffix matching is broken, this might fail because
        // Item and MenuItem get confused
        export let testBoth = (): i32 => {
          let item = new Item(10);
          let menu = new MenuItem(20);
          return item.getPrice() + menu.getName();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.testItem(), 100);
    assert.equal(exports.testMenuItem(), 42);
    assert.equal(exports.testBoth(), 30);
  });

  /**
   * Test nested generics across modules.
   *
   * Container<Box<Data>> where each type is from a different module.
   */
  test('nested generics across modules', async () => {
    const modules = {
      data: `
        export class Data {
          n: i32;
          #new(n: i32) { this.n = n; }
          get(): i32 { return this.n; }
        }
      `,
      box: `
        export class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }
          unwrap(): T { return this.value; }
        }
      `,
      container: `
        export class Container<T> {
          item: T;
          #new(item: T) { this.item = item; }
          getItem(): T { return this.item; }
        }
      `,
      main: `
        import { Data } from "data";
        import { Box } from "box";
        import { Container } from "container";

        export let test = (): i32 => {
          let d = new Data(77);
          let b = new Box<Data>(d);
          let c = new Container<Box<Data>>(b);

          // Unwrap: Container -> Box -> Data -> i32
          let box = c.getItem();
          let data = box.unwrap();
          return data.get();
        };
      `,
    };

    const exports = await compileAndInstantiate(modules, {path: 'main'});
    assert.equal(exports.test(), 77);
  });

  /**
   * Post-Round-2 verification: suffix lookup code can be removed.
   *
   * After implementing identity-based lookups via checker types (Round 2),
   * this test should verify that removing the suffix-based fallback code
   * doesn't break anything.
   *
   * The suffix matching code in mapType() at these locations can be deleted:
   * - Line ~2426: type alias suffix lookup
   * - Line ~2539: generic class suffix lookup
   * - Line ~2588: class suffix lookup
   * - Line ~2610: interface suffix lookup
   *
   * To verify: Remove the suffix matching code and run the full test suite.
   * If all tests pass, the code was indeed dead and can be safely removed.
   */
  test.todo(
    'Round 2 verification: remove suffix-based lookups after identity-based implementation',
  );
});
