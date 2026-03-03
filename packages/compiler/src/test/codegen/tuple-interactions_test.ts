import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

/**
 * Tests for interactions between regular (boxed) tuples and inline tuples,
 * now that they share the `(...)` literal syntax.
 *
 * The key distinction:
 * - `inline (T1, T2)` → WASM multi-value return (stack-based, no allocation)
 * - `(T1, T2)` → WASM GC struct (heap-allocated)
 *
 * The parser produces the same AST node (TupleLiteral / TuplePattern).
 * The checker decides inline vs boxed based on context (return type).
 */
suite('codegen: tuple interactions (boxed vs inline)', () => {
  suite('scenario 1: storing tuples in variables', () => {
    test('inline fn stores boxed tuple in var, returns var (uncaught by checker)', async () => {
      // BUG: When a function declares `inline (i32, i32)` return, but the tuple
      // is first stored in a variable, the variable holds a boxed tuple.
      // Returning a boxed tuple from an inline function should produce a type
      // error, but the checker currently doesn't catch it. The boxed TupleType
      // passes isAssignableTo for InlineTupleType because both have compatible
      // element types. This results in invalid WASM at instantiation time.
      // TODO: Fix isAssignableTo to reject Tuple -> InlineTuple assignment.
      await assert.rejects(
        () =>
          compileAndRun(`
          let pair = (): inline (i32, i32) => {
            let t = (1, 2);
            return t;
          };
          export let main = (): i32 => {
            let (a, b) = pair();
            return a + b;
          };
        `),
        // Currently fails at WASM level, not at checker level
        (err: any) => err instanceof Error,
      );
    });

    test('boxed fn stores tuple in var and returns it', async () => {
      const result = await compileAndRun(`
        let pair = (): (i32, i32) => {
          let t = (1, 2);
          return t;
        };
        export let main = (): i32 => {
          let p = pair();
          return p[0] + p[1];
        };
      `);
      assert.strictEqual(result, 3);
    });
  });

  suite('scenario 1b: returning another function call', () => {
    test('boxed fn returns tuple literal (parse ambiguity resolved)', async () => {
      // Previously, `(): (i32, i32) => (1, 2)` failed because the parser
      // greedily consumed `(i32, i32) =>` as a function type.
      // Now, unnamed params `(i32, i32)` are always a tuple type.
      const result = await compileAndRun(`
        let boxed = (): (i32, i32) => (1, 2);
        export let main = (): i32 => {
          let p = boxed();
          return p[0] + p[1];
        };
      `);
      assert.strictEqual(result, 3);
    });

    test('boxed fn returns call to another fn (parse ambiguity resolved)', async () => {
      // Previously, `(): (i32, i32) => inner()` failed because the parser saw
      // `(i32, i32) => inner` as a function type. Now it correctly parses
      // (i32, i32) as a boxed tuple return type.
      const result = await compileAndRun(`
        let make = (): (i32, i32) => (10, 20);
        let wrap = (): (i32, i32) => make();
        export let main = (): i32 => {
          let p = wrap();
          return p[0] + p[1];
        };
      `);
      assert.strictEqual(result, 30);
    });

    test('inline fn returns call to boxed fn (cross-assignment bug)', async () => {
      // Parse now works, but returning a boxed tuple from an inline function
      // is a type mismatch (boxed struct vs multi-value). The checker doesn't
      // catch this yet (bug #1), so it fails at WASM level.
      // TODO: Fix checker to reject Tuple -> InlineTuple assignment.
      await assert.rejects(
        () =>
          compileAndRun(`
          let boxed = (): (i32, i32) => (1, 2);
          let inl = (): inline (i32, i32) => boxed();
          export let main = (): i32 => {
            let (a, b) = inl();
            return a + b;
          };
        `),
        (err: any) => err instanceof Error,
      );
    });

    test('boxed fn returns call to inline fn (cross-assignment bug)', async () => {
      // Parse now works, but returning an inline tuple (multi-value) from a
      // boxed function (expects struct ref) is a type mismatch. The checker
      // doesn't catch this yet (bug #1), so it fails at WASM level.
      // TODO: Fix checker to reject InlineTuple -> Tuple assignment.
      await assert.rejects(
        () =>
          compileAndRun(`
          let inner = (): inline (i32, i32) => ((1, 2));
          let outer = (): (i32, i32) => inner();
          export let main = (): i32 => {
            let p = outer();
            return p[0] + p[1];
          };
        `),
        (err: any) => err instanceof Error,
      );
    });
  });

  suite('scenario 2: union of boxed and inline tuples', () => {
    test('union of inline and boxed tuple is rejected', async () => {
      // A union like `inline (i32, i32) | (i32, i32)` mixes representations.
      await assert.rejects(
        () =>
          compileAndRun(`
          let mixed = (flag: boolean): inline (i32, i32) | (i32, i32) => {
            if (flag) {
              return (1, 2);
            } else {
              return (3, 4);
            }
          };
          export let main = (): i32 => 0;
        `),
        (err: any) => {
          // Should fail at parse, check, or codegen
          assert.ok(err instanceof Error);
          return true;
        },
      );
    });

    test('union of inline tuples works', async () => {
      // Union of inline tuples (discriminated) is supported.
      const result = await compileAndRun(`
        let check = (n: i32): inline (true, i32) | inline (false, i32) => {
          if (n > 0) {
            return (true, n);
          } else {
            return (false, 0 - n);
          }
        };
        export let main = (): i32 => {
          let (positive, value) = check(5);
          return value;
        };
      `);
      assert.strictEqual(result, 5);
    });
  });

  suite('scenario 3: conditional returns', () => {
    test('both branches return inline tuple literal', async () => {
      const result = await compileAndRun(`
        let pick = (flag: boolean): inline (i32, i32) => {
          if (flag) {
            return (10, 20);
          } else {
            return (30, 40);
          }
        };
        export let main = (): i32 => {
          let (a, b) = pick(true);
          return a + b;
        };
      `);
      assert.strictEqual(result, 30);
    });

    test('ternary returning inline tuples (expression body)', async () => {
      // BUG: if-expression with inline tuple returns generates invalid WASM.
      // The codegen doesn't properly handle TupleLiteral inside if-expression
      // branches when the function returns inline tuple.
      // TODO: Fix codegen for if-expressions returning inline tuples.
      await assert.rejects(
        () =>
          compileAndRun(`
          let pick = (flag: boolean): inline (i32, i32) =>
            if (flag) { ((10, 20)) } else { ((30, 40)) };
          export let main = (): i32 => {
            let (a, b) = pick(false);
            return a + b;
          };
        `),
        // Fails at WASM instantiation — invalid type form
        (err: any) => err instanceof Error,
      );
    });

    test('conditional returning boxed tuple literal', async () => {
      const result = await compileAndRun(`
        let pick = (flag: boolean): (i32, i32) => {
          if (flag) {
            return (10, 20);
          } else {
            return (30, 40);
          }
        };
        export let main = (): i32 => {
          let p = pick(true);
          return p[0] + p[1];
        };
      `);
      assert.strictEqual(result, 30);
    });
  });

  suite('scenario 4: chaining inline-returning functions', () => {
    test('inline fn returns call to another inline fn', async () => {
      const result = await compileAndRun(`
        let inner = (): inline (i32, i32) => ((10, 20));
        let outer = (): inline (i32, i32) => inner();
        export let main = (): i32 => {
          let (a, b) = outer();
          return a + b;
        };
      `);
      assert.strictEqual(result, 30);
    });

    test('chaining three inline functions', async () => {
      const result = await compileAndRun(`
        let f1 = (): inline (i32, i32) => ((1, 2));
        let f2 = (): inline (i32, i32) => f1();
        let f3 = (): inline (i32, i32) => f2();
        export let main = (): i32 => {
          let (a, b) = f3();
          return a + b;
        };
      `);
      assert.strictEqual(result, 3);
    });

    test('inline fn destructures then re-packs', async () => {
      const result = await compileAndRun(`
        let inner = (): inline (i32, i32) => ((10, 20));
        let outer = (): inline (i32, i32) => {
          let (a, b) = inner();
          return (b, a);
        };
        export let main = (): i32 => {
          let (x, y) = outer();
          return x * 10 + y;
        };
      `);
      // outer swaps: (20, 10), so x=20, y=10 -> 210
      assert.strictEqual(result, 210);
    });
  });

  suite('boxed tuple basics (shared syntax)', () => {
    test('boxed tuple stored and accessed by index', async () => {
      const result = await compileAndRun(`
        export let main = (): i32 => {
          let t = (10, 20, 30);
          return t[0] + t[1] + t[2];
        };
      `);
      assert.strictEqual(result, 60);
    });

    test('boxed tuple passed as parameter', async () => {
      const result = await compileAndRun(`
        let sum = (t: (i32, i32)): i32 => t[0] + t[1];
        export let main = (): i32 => {
          return sum((3, 7));
        };
      `);
      assert.strictEqual(result, 10);
    });

    test('boxed fn can return tuple via type alias', async () => {
      // Type alias still works (and was the old workaround for parse ambiguity).
      const result = await compileAndRun(`
        type Pair = (i32, i32);
        let pair = (a: i32, b: i32): Pair => (a, b);
        export let main = (): i32 => {
          let p = pair(5, 8);
          return p[0] + p[1];
        };
      `);
      assert.strictEqual(result, 13);
    });

    test('boxed fn returns tuple directly (no type alias needed)', async () => {
      // With named function type params, (i32, i32) is unambiguously a tuple type
      const result = await compileAndRun(`
        let pair = (a: i32, b: i32): (i32, i32) => (a, b);
        export let main = (): i32 => {
          let p = pair(5, 8);
          return p[0] + p[1];
        };
      `);
      assert.strictEqual(result, 13);
    });

    test('function type with named params works', async () => {
      // Function types now require named parameters: (name: Type) => ReturnType
      const result = await compileAndRun(`
        let apply = (f: (x: i32) => i32, v: i32): i32 => f(v);
        let double = (x: i32): i32 => x * 2;
        export let main = (): i32 => apply(double, 21);
      `);
      assert.strictEqual(result, 42);
    });

    test('boxed tuple destructured with let', async () => {
      const result = await compileAndRun(`
        export let main = (): i32 => {
          let t = (100, 200);
          let (a, b) = t;
          return a + b;
        };
      `);
      assert.strictEqual(result, 300);
    });
  });
});
