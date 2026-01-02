import {suite, test} from 'node:test';
import {compileAndRun, compileAndInstantiate} from './utils.js';
import assert from 'node:assert';

suite('Codegen: Try/Catch', () => {
  test('try/catch catches exception', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          throw new Error("oops");
          1
        } catch (e) {
          42
        };
        return result;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('try/catch returns try value when no exception', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          100
        } catch (e) {
          0
        };
        return result;
      };
    `);
    assert.strictEqual(result, 100);
  });

  test('try/catch with computation in try block', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          let x = 10;
          let y = 20;
          x + y
        } catch (e) {
          0
        };
        return result;
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('try/catch as statement (void)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        var sideEffect = 0;
        try {
          sideEffect = 1;
          throw new Error("oops");
          sideEffect = 2;
        } catch (e) {
          sideEffect = 3;
        };
        return sideEffect;
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('re-throw from catch', async () => {
    await assert.rejects(async () => {
      await compileAndRun(`
        export let main = () => {
          try {
            throw new Error("original");
          } catch (e) {
            throw e;
          };
        };
      `);
    });
  });

  test('throw new error from catch', async () => {
    await assert.rejects(async () => {
      await compileAndRun(`
        class OtherError extends Error {}
        export let main = () => {
          try {
            throw new Error("original");
          } catch (e) {
            throw new OtherError("new");
          };
        };
      `);
    });
  });

  test('try/catch with computation in catch block', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          throw new Error("fail");
          0
        } catch (e) {
          let x = 5;
          let y = 7;
          x * y
        };
        return result;
      };
    `);
    assert.strictEqual(result, 35);
  });

  test('try/catch without catch parameter', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          throw new Error("ignored");
          1
        } catch {
          99
        };
        return result;
      };
    `);
    assert.strictEqual(result, 99);
  });

  test('try/catch expression used in assignment', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = try {
          throw new Error("error");
          0
        } catch (e) {
          123
        };
        return x;
      };
    `);
    assert.strictEqual(result, 123);
  });

  test('nested try/catch', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          let inner = try {
            throw new Error("inner error");
            1
          } catch (e) {
            10
          };
          inner + 5
        } catch (e) {
          0
        };
        return result;
      };
    `);
    assert.strictEqual(result, 15);
  });

  test('try/catch with outer exception', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          let inner = try {
            5
          } catch (e) {
            0
          };
          throw new Error("outer error");
          inner
        } catch (e) {
          77
        };
        return result;
      };
    `);
    assert.strictEqual(result, 77);
  });

  test('try/finally runs finally on success', async () => {
    const result = await compileAndRun(`
      var sideEffect: i32 = 0;

      export let main = (): i32 => {
        let result = try {
          50
        } finally {
          sideEffect = 1;
        };
        return sideEffect * 100 + result;
      };
    `);
    // sideEffect = 1, result = 50, so 1*100 + 50 = 150
    assert.strictEqual(result, 150);
  });

  test('try/catch/finally runs all blocks on exception', async () => {
    const result = await compileAndRun(`
      var sideEffect: i32 = 0;

      export let main = (): i32 => {
        let result = try {
          throw new Error("fail");
          0
        } catch (e) {
          sideEffect = sideEffect + 10;
          25
        } finally {
          sideEffect = sideEffect + 100;
        };
        return sideEffect + result;
      };
    `);
    // sideEffect = 10 + 100 = 110, result = 25, so 110 + 25 = 135
    assert.strictEqual(result, 135);
  });

  test('try/catch/finally runs finally on success', async () => {
    const result = await compileAndRun(`
      var sideEffect: i32 = 0;

      export let main = (): i32 => {
        let result = try {
          30
        } catch (e) {
          0
        } finally {
          sideEffect = 5;
        };
        return sideEffect * 10 + result;
      };
    `);
    // sideEffect = 5, result = 30, so 5*10 + 30 = 80
    assert.strictEqual(result, 80);
  });

  test('try/catch with string result type', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          "success"
        } catch (e) {
          "failure"
        };
        return if (result == "success") { 1 } else { 0 };
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('try/catch exception changes string result', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let result = try {
          throw new Error("boom");
          "success"
        } catch (e) {
          "failure"
        };
        return if (result == "failure") { 1 } else { 0 };
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('try/catch in function call', async () => {
    const result = await compileAndRun(`
      let double = (x: i32): i32 => x * 2;

      export let main = (): i32 => {
        return double(try {
          throw new Error("err");
          10
        } catch (e) {
          21
        });
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('try/catch propagates exception without catch', async () => {
    // This tests that finally runs even when exception propagates
    const exports = await compileAndInstantiate(`
      var finallyRan: i32 = 0;

      let thrower = (): void => {
        throw new Error("propagated");
      };

      export let main = (): i32 => {
        return try {
          thrower();
          0
        } finally {
          finallyRan = 1;
        };
      };

      export let getFinallyRan = (): i32 => finallyRan;
    `);

    // The main function should throw
    let threw = false;
    try {
      exports.main();
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true);
    // But finally should have run
    assert.strictEqual(exports.getFinallyRan(), 1);
  });
});
