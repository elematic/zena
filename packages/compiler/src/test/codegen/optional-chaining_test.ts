import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Optional Chaining and Nullish Coalescing', () => {
  suite('Nullish Coalescing (??)', () => {
    test('returns left when not null', async () => {
      const source = `
        class Box {
          value: i32 = 0;
          new(v: i32) { this.value = v; }
        }
        export let test = () => {
          let b: Box | null = new Box(42);
          let result = b ?? new Box(0);
          return result.value;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 42);
    });

    test('returns right when left is null', async () => {
      const source = `
        class Box {
          value: i32 = 0;
          new(v: i32) { this.value = v; }
        }
        export let test = () => {
          let b: Box | null = null;
          let result = b ?? new Box(99);
          return result.value;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 99);
    });

    test('short-circuits - does not evaluate right when left is not null', async () => {
      const source = `
        var sideEffect = 0;
        
        class Box {
          value: i32 = 0;
          new(v: i32) { this.value = v; }
        }
        
        let makeBox = () => {
          sideEffect = 100;
          return new Box(0);
        };
        
        export let test = () => {
          let b: Box | null = new Box(42);
          let result = b ?? makeBox();
          return sideEffect;
        };
      `;
      // sideEffect should remain 0 because makeBox() is not called
      assert.strictEqual(await compileAndRun(source, 'test'), 0);
    });

    test('does not short-circuit when left is null', async () => {
      const source = `
        var sideEffect = 0;
        
        class Box {
          value: i32 = 0;
          new(v: i32) { this.value = v; }
        }
        
        let makeBox = () => {
          sideEffect = 100;
          return new Box(77);
        };
        
        export let test = () => {
          let b: Box | null = null;
          let result = b ?? makeBox();
          return sideEffect;
        };
      `;
      // sideEffect should be 100 because makeBox() is called
      assert.strictEqual(await compileAndRun(source, 'test'), 100);
    });
  });

  suite('Optional Member Access (?.)', () => {
    test('returns field value when object is not null', async () => {
      const source = `
        class Point {
          x: i32 = 0;
          y: i32 = 0;
          new(x: i32, y: i32) { this.x = x; this.y = y; }
        }
        export let test = () => {
          let p: Point | null = new Point(10, 20);
          return p?.x ?? 0;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 10);
    });

    test('returns null when object is null', async () => {
      const source = `
        class Point {
          x: i32 = 0;
          y: i32 = 0;
          new(x: i32, y: i32) { this.x = x; this.y = y; }
        }
        export let test = () => {
          let p: Point | null = null;
          let result = p?.x;
          if (result == null) { return 1; }
          return 0;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 1);
    });

    test('short-circuits - does not access field when object is null', async () => {
      const source = `
        class Inner {
          value: i32 = 0;
          new(v: i32) { this.value = v; }
        }
        
        class Container {
          inner: Inner | null = null;
          new(i: Inner) { this.inner = i; }
        }
        
        export let test = () => {
          let c: Container | null = null;
          // If this doesn't short-circuit, accessing c.inner would trap
          let result = c?.inner;
          if (result == null) { return 1; }
          return 0;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 1);
    });
  });

  suite('Optional Index Access (?[)', () => {
    test('returns element when array is not null', async () => {
      const source = `
        export let test = () => {
          let arr: FixedArray<i32> | null = [10, 20, 30];
          return arr?[1] ?? 0;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 20);
    });

    test('returns null when array is null', async () => {
      const source = `
        class Box {
          value: i32 = 0;
          new(v: i32) { this.value = v; }
        }
        export let test = () => {
          let arr: FixedArray<Box> | null = null;
          let result = arr?[0];
          if (result == null) { return 1; }
          return 0;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 1);
    });
  });

  suite('Optional Call (?()', () => {
    test('calls function when not null', async () => {
      const source = `
        export let test = () => {
          let fn: (() => i32) | null = () => 42;
          return fn?() ?? 0;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 42);
    });

    test('returns null when function is null', async () => {
      const source = `
        class Box {
          value: i32 = 0;
          new(v: i32) { this.value = v; }
        }
        export let test = () => {
          let fn: (() => Box) | null = null;
          let result = fn?();
          if (result == null) { return 1; }
          return 0;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 1);
    });

    test('calls function with arguments', async () => {
      const source = `
        export let test = () => {
          let fn: ((a: i32, b: i32) => i32) | null = (a: i32, b: i32) => a + b;
          return fn?(10, 20) ?? 0;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 30);
    });
  });

  suite('Chained Optional Access', () => {
    test('chain member access with ??', async () => {
      const source = `
        class Point {
          x: i32 = 0;
          new(x: i32) { this.x = x; }
        }
        export let test = () => {
          let p: Point | null = new Point(42);
          return p?.x ?? -1;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), 42);
    });

    test('chain returns default when null', async () => {
      const source = `
        class Point {
          x: i32 = 0;
          new(x: i32) { this.x = x; }
        }
        export let test = () => {
          let p: Point | null = null;
          return p?.x ?? -1;
        };
      `;
      assert.strictEqual(await compileAndRun(source, 'test'), -1);
    });
  });
});
