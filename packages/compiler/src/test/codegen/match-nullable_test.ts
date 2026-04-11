import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Match on Nullable Types', () => {
  test('match on X | null with class pattern (non-null)', async () => {
    const result = await compileAndRun(`
      class Box { value: i32; new(this.value); }

      let unwrap = (x: Box | null): i32 => match (x) {
        case Box {value}: value
        case _: -1
      };

      export let main = (): i32 => unwrap(new Box(42));
    `);
    assert.strictEqual(result, 42);
  });

  test('match on X | null with class pattern (null)', async () => {
    const result = await compileAndRun(`
      class Box { value: i32; new(this.value); }

      let unwrap = (x: Box | null): i32 => match (x) {
        case Box {value}: value
        case _: -1
      };

      export let main = (): i32 => unwrap(null);
    `);
    assert.strictEqual(result, -1);
  });

  test('match on sealed class | null with variant patterns (non-null)', async () => {
    const result = await compileAndRun(`
      sealed class Shape {
        case Circle(radius: i32)
        case Rect(w: i32, h: i32)
      }

      let describe = (s: Shape | null): i32 => match (s) {
        case Circle {}: 1
        case Rect {}: 2
        case _: 0
      };

      export let main = (): i32 => describe(new Circle(3));
    `);
    assert.strictEqual(result, 1);
  });

  test('match on sealed class | null with variant patterns (null)', async () => {
    const result = await compileAndRun(`
      sealed class Shape {
        case Circle(radius: i32)
        case Rect(w: i32, h: i32)
      }

      let describe = (s: Shape | null): i32 => match (s) {
        case Circle {}: 1
        case Rect {}: 2
        case _: 0
      };

      export let main = (): i32 => describe(null);
    `);
    assert.strictEqual(result, 0);
  });

  test('match on sealed class | null with as pattern (non-null)', async () => {
    const result = await compileAndRun(`
      sealed class Shape {
        case Circle(radius: i32)
        case Rect(w: i32, h: i32)
      }

      let area = (s: Shape | null): i32 => match (s) {
        case Circle as c: c.radius
        case Rect as r: r.w * r.h
        case _: 0
      };

      export let main = (): i32 => area(new Rect(3, 4));
    `);
    assert.strictEqual(result, 12);
  });

  test('match on X | Y | null with class patterns (first)', async () => {
    const result = await compileAndRun(`
      class A { x: i32; new(this.x); }
      class B { y: i32; new(this.y); }

      let process = (obj: A | B | null): i32 => match (obj) {
        case A {x}: x
        case B {y}: y + 100
        case _: -1
      };

      export let main = (): i32 => process(new A(7));
    `);
    assert.strictEqual(result, 7);
  });

  test('match on X | Y | null with class patterns (second)', async () => {
    const result = await compileAndRun(`
      class A { x: i32; new(this.x); }
      class B { y: i32; new(this.y); }

      let process = (obj: A | B | null): i32 => match (obj) {
        case A {x}: x
        case B {y}: y + 100
        case _: -1
      };

      export let main = (): i32 => process(new B(20));
    `);
    assert.strictEqual(result, 120);
  });

  test('match on X | Y | null with class patterns (null)', async () => {
    const result = await compileAndRun(`
      class A { x: i32; new(this.x); }
      class B { y: i32; new(this.y); }

      let process = (obj: A | B | null): i32 => match (obj) {
        case A {x}: x
        case B {y}: y + 100
        case _: -1
      };

      export let main = (): i32 => process(null);
    `);
    assert.strictEqual(result, -1);
  });

  test('match on sealed unit variants | null', async () => {
    const result = await compileAndRun(`
      sealed class Color {
        case Red
        case Green
        case Blue
      }

      let toInt = (c: Color | null): i32 => match (c) {
        case Red: 1
        case Green: 2
        case Blue: 3
        case _: 0
      };

      export let main = (): i32 => toInt(new Red()) + toInt(null);
    `);
    assert.strictEqual(result, 1);
  });
});
