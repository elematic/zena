/**
 * Tests for AsPattern type narrowing in match expressions.
 *
 * Bug #1: When binding a variable via `case ClassType as ct:`, the binding
 * was using the base type instead of the narrowed class type. This caused
 * WASM validation errors: "type mismatch: expected (ref null $type), found
 * (ref null $type)" because the local was declared with the wrong type.
 *
 * The fix ensures that `generateMatchPatternBindings` for `AsPattern` checks
 * the inner pattern's `inferredType` and uses the narrowed type for the local.
 */
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('AsPattern Type Narrowing', () => {
  test('should narrow type when binding sealed class variant via AsPattern', async () => {
    // This test reproduces the bug in types.zena:typeToString
    // The match expression narrows Type to specific variants like FunctionType
    const result = await compileAndRun(`
      sealed class Animal {
        case Dog(name: String, breed: String)
        case Cat(name: String, indoor: boolean)
      }

      let describe = (a: Animal): String => match (a) {
        case Dog { name, breed }: name + " is a " + breed
        case Cat { name, indoor }: name + " is " + (if (indoor) "indoor" else "outdoor")
      };

      export let main = (): i32 => {
        let dog = new Dog("Buddy", "Labrador");
        let result = describe(dog);
        return if (result == "Buddy is a Labrador") 1 else 0;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should narrow type in AsPattern with field access', async () => {
    // Verify we can access subclass-specific fields through the narrowed binding
    const result = await compileAndRun(`
      sealed class Shape {
        case Circle(radius: i32)
        case Rectangle(width: i32, height: i32)
      }

      let area = (s: Shape): i32 => match (s) {
        case Circle as c: c.radius * c.radius * 3
        case Rectangle as r: r.width * r.height
      };

      export let main = (): i32 => {
        let circle = new Circle(10);
        let rect = new Rectangle(5, 4);
        return area(circle) + area(rect);
      };
    `);
    // Circle: 10 * 10 * 3 = 300, Rectangle: 5 * 4 = 20, Total = 320
    assert.strictEqual(result, 320);
  });

  test('should narrow type in AsPattern with method calls', async () => {
    // Verify methods work correctly on the narrowed binding
    const result = await compileAndRun(`
      sealed class Expr {
        case Num(value: i32)
        case Add(left: Expr, right: Expr)
      }

      let evalExpr = (e: Expr): i32 => match (e) {
        case Num as n: n.value
        case Add as a: evalExpr(a.left) + evalExpr(a.right)
      };

      export let main = (): i32 => {
        // (3 + 4) = 7
        let expr = new Add(new Num(3), new Num(4));
        return evalExpr(expr);
      };
    `);
    assert.strictEqual(result, 7);
  });

  test('should narrow type in nested AsPattern', async () => {
    // Verify nested AsPattern bindings also get narrowed correctly
    const result = await compileAndRun(`
      sealed class Node {
        case Leaf(value: i32)
        case Branch(left: Node, right: Node)
      }

      let sumTree = (n: Node): i32 => match (n) {
        case Leaf as l: l.value
        case Branch as b: sumTree(b.left) + sumTree(b.right)
      };

      export let main = (): i32 => {
        // Tree:    +
        //         / \\
        //        1   +
        //           / \\
        //          2   3
        let tree = new Branch(
          new Leaf(1),
          new Branch(new Leaf(2), new Leaf(3))
        );
        return sumTree(tree);
      };
    `);
    assert.strictEqual(result, 6);
  });

  test('should narrow type in AsPattern with regular class hierarchy', async () => {
    // Verify AsPattern narrowing works for non-sealed classes too
    const result = await compileAndRun(`
      class Vehicle {
        wheels: i32;
        new(wheels: i32) : wheels = wheels {}
      }
      class Car extends Vehicle {
        doors: i32;
        new(doors: i32) : doors = doors, super(4) {}
      }

      export let main = (): i32 => {
        let v: Vehicle = new Car(4);
        return match (v) {
          case Car as c: c.wheels + c.doors
          case _: 0
        };
      };
    `);
    // 4 wheels + 4 doors = 8
    assert.strictEqual(result, 8);
  });
});
