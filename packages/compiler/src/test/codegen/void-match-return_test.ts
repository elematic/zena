/**
 * Tests for void match expressions in function return position.
 *
 * Bug #2: When a match expression where all arms use explicit `return` was
 * the last statement of a function body, no value was left on the stack for
 * the function's implicit return. This caused WASM validation errors:
 * "expected (ref null $type) but nothing on stack"
 *
 * The fix adds `unreachable` after generating a void-typed expression
 * statement in the return position of a function body.
 */
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('Void Match in Return Position', () => {
  test('should handle match where all arms return explicitly', async () => {
    // This test reproduces the bug in checker.zena:checkNewExpression
    // The match at the end of the function has void type because all
    // arms use explicit return statements
    const result = await compileAndRun(`
      class Result {
        value: i32;
        new(value: i32) : value = value {}
      }

      let processValue = (x: i32): Result => {
        match (x) {
          case 0: { return new Result(100); }
          case 1: { return new Result(200); }
          case _: { return new Result(x * 10); }
        }
      };

      export let main = (): i32 => {
        let r = processValue(5);
        return r.value;
      };
    `);
    assert.strictEqual(result, 50);
  });

  test('should handle match with mixed return and expression arms', async () => {
    // Only some arms return explicitly
    const result = await compileAndRun(`
      let compute = (x: i32): i32 => {
        if (x < 0) {
          if (x == -1) { return 999; }
          return -1;
        }
        return x * 2;
      };

      export let main = (): i32 => {
        return compute(5) + compute(-1);
      };
    `);
    // compute(5) = 10, compute(-1) = 999
    assert.strictEqual(result, 1009);
  });

  test('should handle nested match with all returns', async () => {
    const result = await compileAndRun(`
      sealed class Option {
        case Some(value: i32)
        case None()
      }

      let unwrapOr = (opt: Option, default_: i32): i32 => {
        match (opt) {
          case Some as s: {
            return s.value;
          }
          case None: {
            return default_;
          }
        }
      };

      export let main = (): i32 => {
        let a = unwrapOr(new Some(42), 0);
        let b = unwrapOr(new None(), 100);
        return a + b;
      };
    `);
    assert.strictEqual(result, 142);
  });

  test('should handle void match as last statement in complex function', async () => {
    // Complex function where match is at the end after other statements
    const result = await compileAndRun(`
      var globalCounter = 0;

      sealed class Command {
        case Increment(amount: i32)
        case Decrement(amount: i32)
        case Reset()
      }

      let execute = (cmd: Command): i32 => {
        let oldValue = globalCounter;

        match (cmd) {
          case Increment as inc: {
            globalCounter = globalCounter + inc.amount;
            return globalCounter;
          }
          case Decrement as dec: {
            globalCounter = globalCounter - dec.amount;
            return globalCounter;
          }
          case Reset: {
            globalCounter = 0;
            return 0;
          }
        }
      };

      export let main = (): i32 => {
        execute(new Increment(10));
        execute(new Increment(5));
        let result = execute(new Decrement(3));
        return result;
      };
    `);
    // 0 + 10 + 5 - 3 = 12
    assert.strictEqual(result, 12);
  });

  test('should handle multiple void matches in sequence', async () => {
    const result = await compileAndRun(`
      let classify = (x: i32): String => {
        // First match - all arms return
        match (x < 0) {
          case true: { return "negative"; }
          case false: {}
        }

        // Second match at end - all arms return
        match (x) {
          case 0: { return "zero"; }
          case _: { return "positive"; }
        }
      };

      export let main = (): i32 => {
        let a = classify(-5);
        let b = classify(0);
        let c = classify(10);

        return if (a == "negative" && b == "zero" && c == "positive") 1 else 0;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should handle void match with class pattern returns', async () => {
    // Combination of AsPattern narrowing and void match
    const result = await compileAndRun(`
      sealed class Expr {
        case Const(value: i32)
        case Add(left: Expr, right: Expr)
        case Mul(left: Expr, right: Expr)
      }

      let eval_ = (e: Expr): i32 => {
        match (e) {
          case Const as c: {
            return c.value;
          }
          case Add as a: {
            return eval_(a.left) + eval_(a.right);
          }
          case Mul as m: {
            return eval_(m.left) * eval_(m.right);
          }
        }
      };

      export let main = (): i32 => {
        // (2 + 3) * 4 = 20
        let expr = new Mul(
          new Add(new Const(2), new Const(3)),
          new Const(4)
        );
        return eval_(expr);
      };
    `);
    assert.strictEqual(result, 20);
  });
});
