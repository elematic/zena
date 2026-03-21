import {suite, test} from 'node:test';
import assert from 'node:assert';
import {checkSource, compileAndRun} from '../codegen/utils.js';
import {DiagnosticSeverity} from '../../lib/diagnostics.js';

suite('Checker: refutable patterns in let/var declarations', () => {
  suite('inline tuple destructuring with literal patterns', () => {
    test('rejects boolean literal in let inline tuple pattern', async () => {
      const source = `
        let next = (): inline (boolean, i32) => ((true, 42));
        export let main = (): i32 => {
          let (true, value) = next();
          return value;
        };
      `;
      const diagnostics = checkSource(source);
      const errors = diagnostics.filter(
        (d) => d.severity === DiagnosticSeverity.Error,
      );
      assert.ok(
        errors.length > 0,
        'Should report an error for refutable pattern',
      );
      assert.ok(
        errors.some((d) => /refutable|literal/i.test(d.message)),
        `Expected error about refutable/literal pattern, got: ${errors.map((d) => d.message).join(', ')}`,
      );
    });

    test('rejects false literal in let inline tuple pattern', async () => {
      const source = `
        let next = (): inline (boolean, i32) => ((false, 0));
        export let main = (): i32 => {
          let (false, value) = next();
          return value;
        };
      `;
      const diagnostics = checkSource(source);
      const errors = diagnostics.filter(
        (d) => d.severity === DiagnosticSeverity.Error,
      );
      assert.ok(
        errors.length > 0,
        'Should report an error for refutable pattern',
      );
    });

    test('rejects literal in var inline tuple pattern', async () => {
      const source = `
        let next = (): inline (boolean, i32) => ((true, 42));
        export let main = (): i32 => {
          var (true, value) = next();
          return value;
        };
      `;
      const diagnostics = checkSource(source);
      const errors = diagnostics.filter(
        (d) => d.severity === DiagnosticSeverity.Error,
      );
      assert.ok(
        errors.length > 0,
        'Should report an error for refutable pattern',
      );
    });

    test('rejects literal in union of inline tuple pattern', async () => {
      const source = `
        let maybeNext = (flag: boolean): inline (boolean, i32) => {
          if (flag) {
            return (true, 42);
          } else {
            return (false, 0);
          }
        };
        export let main = (): i32 => {
          let (true, value) = maybeNext(true);
          return value;
        };
      `;
      const diagnostics = checkSource(source);
      const errors = diagnostics.filter(
        (d) => d.severity === DiagnosticSeverity.Error,
      );
      assert.ok(
        errors.length > 0,
        'Should report an error for refutable pattern',
      );
    });

    test('allows identifier-only patterns in let inline tuple', async () => {
      const source = `
        let next = (): inline (boolean, i32) => ((true, 42));
        export let main = (): i32 => {
          let (flag, value) = next();
          if (flag) { return value; }
          return 0;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });

    test('allows wildcard in let inline tuple', async () => {
      const source = `
        let next = (): inline (boolean, i32) => ((true, 42));
        export let main = (): i32 => {
          let (_, value) = next();
          return value;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });

    test('literal patterns still work in if-let', async () => {
      const source = `
        let maybeNext = (flag: boolean): inline (boolean, i32) => {
          if (flag) {
            return (true, 42);
          } else {
            return (false, 0);
          }
        };
        export let main = (): i32 => {
          if (let (true, value) = maybeNext(true)) {
            return value;
          }
          return -1;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });

    test('literal patterns still work in while-let', async () => {
      const source = `
        var count = 0;
        let counter = (): inline (boolean, i32) => {
          count = count + 1;
          if (count <= 3) {
            return (true, count);
          } else {
            return (false, 0);
          }
        };
        export let main = (): i32 => {
          var sum = 0;
          while (let (true, value) = counter()) {
            sum = sum + value;
          }
          return sum;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 6); // 1 + 2 + 3
    });
  });

  suite('discriminated union of inline tuples', () => {
    test('let binding filters never from discriminated union element types', async () => {
      // next(): (true, i32) | (false, never)
      // In let destructuring, `value` gets type `i32` (never is filtered)
      const source = `
        let next = (flag: boolean): inline (true, i32) | inline (false, never) => {
          if (flag) return (true, 42);
          return (false, _);
        };
        export let main = (): i32 => {
          let (_, value) = next(true);
          return value;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });

    test('i32 | never value rejected by arithmetic operator', async () => {
      // value has type i32 | never — cannot use with + without casting
      const source = `
        let next = (flag: boolean): inline (true, i32) | inline (false, never) => {
          if (flag) return (true, 10);
          return (false, _);
        };
        export let main = (): i32 => {
          let (_, value) = next(true);
          return value + 1;
        };
      `;
      const diagnostics = checkSource(source);
      const errors = diagnostics.filter(
        (d) => d.severity === DiagnosticSeverity.Error,
      );
      assert.ok(errors.length > 0, 'Should reject i32 | never in arithmetic');
      assert.ok(
        errors.some((d) => /cannot apply operator/i.test(d.message)),
        `Expected operator error, got: ${errors.map((d) => d.message).join(', ')}`,
      );
    });

    test('let binding with class iterator returning discriminated union', async () => {
      const source = `
        class Counter {
          count: i32;
          max: i32;

          new(max: i32) : count = 0, max = max {}

          next(): inline (true, i32) | inline (false, never) {
            if (this.count < this.max) {
              let current = this.count;
              this.count = this.count + 1;
              return (true, current);
            }
            return (false, _);
          }
        }

        export let main = (): i32 => {
          let counter = new Counter(5);
          let (_, first) = counter.next();
          return first;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 0);
    });

    test('i32 | never value rejected even when false variant taken', async () => {
      // Same as above — the type is i32 | never regardless of runtime value
      const source = `
        let next = (flag: boolean): inline (true, i32) | inline (false, never) => {
          if (flag) return (true, 10);
          return (false, _);
        };
        export let main = (): i32 => {
          let (_, value) = next(false);
          return value + 1;
        };
      `;
      const diagnostics = checkSource(source);
      const errors = diagnostics.filter(
        (d) => d.severity === DiagnosticSeverity.Error,
      );
      assert.ok(errors.length > 0, 'Should reject i32 | never in arithmetic');
    });

    test('String | never value rejected for property access', async () => {
      // value has type String | never — property access is rejected
      const source = `
        let next = (flag: boolean): inline (true, String) | inline (false, never) => {
          if (flag) return (true, 'hello');
          return (false, _);
        };
        export let main = (): i32 => {
          let (_, value) = next(false);
          return value.length;
        };
      `;
      const diagnostics = checkSource(source);
      const errors = diagnostics.filter(
        (d) => d.severity === DiagnosticSeverity.Error,
      );
      assert.ok(
        errors.length > 0,
        'Should reject String | never for property access',
      );
      assert.ok(
        errors.some((d) => /non-class type/i.test(d.message)),
        `Expected property access error, got: ${errors.map((d) => d.message).join(', ')}`,
      );
    });

    test('i32 | never value usable with as cast', async () => {
      // Explicit cast is the escape hatch for using never-union values
      const source = `
        let next = (flag: boolean): inline (true, i32) | inline (false, never) => {
          if (flag) return (true, 10);
          return (false, _);
        };
        export let main = (): i32 => {
          let (ok, value) = next(true);
          if (ok) {
            return (value as i32) + 1;
          }
          return 0;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 11);
    });

    test('allows non-discriminated union of inline tuples (no never)', async () => {
      // Both variants have real types at every position — this is fine
      const source = `
        let pick = (flag: boolean): inline (boolean, i32) => {
          if (flag) {
            return (true, 42);
          } else {
            return (false, 0);
          }
        };
        export let main = (): i32 => {
          let (found, value) = pick(true);
          if (found) { return value; }
          return 0;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });

    test('discriminated unions still work in if-let', async () => {
      const source = `
        let next = (flag: boolean): inline (true, i32) | inline (false, never) => {
          if (flag) return (true, 42);
          return (false, _);
        };
        export let main = (): i32 => {
          if (let (true, value) = next(true)) {
            return value;
          }
          return -1;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 42);
    });

    test('discriminated unions still work in while-let', async () => {
      const source = `
        class Counter {
          count: i32;
          new() : count = 0 {}
          next(): inline (true, i32) | inline (false, never) {
            if (this.count < 3) {
              let c = this.count;
              this.count = this.count + 1;
              return (true, c);
            }
            return (false, _);
          }
        }
        export let main = (): i32 => {
          let counter = new Counter();
          var sum = 0;
          while (let (true, value) = counter.next()) {
            sum = sum + value;
          }
          return sum;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 3); // 0 + 1 + 2
    });
  });
});
