import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Pattern Matching', () => {
  test('should match identifier pattern (wildcard)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 10;
        return match (x) {
          case _: 1
        };
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should match identifier pattern (binding)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 10;
        return match (x) {
          case y: y + 1
        };
      };
    `);
    assert.strictEqual(result, 11);
  });

  test('should match number literal pattern', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 10;
        return match (x) {
          case 10: 1
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should match number literal pattern (no match)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 5;
        return match (x) {
          case 10: 1
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('should match class pattern', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }
      class B { y: i32; #new(y: i32) { this.y = y; } }

      export let main = (): i32 => {
        let obj: A | B = new A(10);
        return match (obj) {
          case A { x as v }: v
          case B { y as v }: v + 100
          case _: -1
        };
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('should match class pattern (second case)', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }
      class B { y: i32; #new(y: i32) { this.y = y; } }

      export let main = (): i32 => {
        let obj: A | B = new B(20);
        return match (obj) {
          case A { x as v }: v
          case B { y as v }: v + 100
          case _: -1
        };
      };
    `);
    assert.strictEqual(result, 120);
  });

  test('should match class pattern with wildcard', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }

      export let main = (): i32 => {
        let obj = new A(10);
        return match (obj) {
          case A { x: _ }: 1
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should match record pattern', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let r = { a: 10, b: 20 };
        return match (r) {
          case { a: 10, b as y }: y
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 20);
  });

  test('should match record pattern (nested)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let r = { a: { x: 10 }, b: 20 };
        return match (r) {
          case { a: { x: 10 }, b as y }: y
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 20);
  });

  test('should match tuple pattern', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let t = [10, 20];
        return match (t) {
          case [10, y]: y
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 20);
  });

  test('should match tuple pattern (nested)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let t = [10, [20, 30]];
        return match (t) {
          case [10, [x, y]]: x + y
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 50);
  });

  test('should match as pattern', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 10;
        return match (x) {
          case 10 as y: y
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('should match as pattern with record', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let r = { a: 10 };
        return match (r) {
          case { a: 10 } as y: y.a
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('should match class pattern with as renaming', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }

      export let main = (): i32 => {
        let obj = new A(10);
        return match (obj) {
          case A { x: _ } as a: a.x
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('should match class pattern with as renaming (nested)', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }
      class B { a: A; #new(a: A) { this.a = a; } }

      export let main = (): i32 => {
        let obj = new B(new A(10));
        return match (obj) {
          case B { a: A { x: _ } as inner }: inner.x
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 10);
  });

  test.skip('should match array pattern (element check)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let a = #[10, 20];
        return match (a) {
          case [10, 30]: 0 // Should not match if elements are checked
          case [10, 20]: 1 // Should match
          case _: -1
        };
      };
    `);
    assert.strictEqual(result, 1);
  });
});
