import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import {strictEqual} from 'node:assert';

suite('tuple unions', () => {
  suite('basic returns', () => {
    test('return (true, value) from union type', async () => {
      const result = await compileAndRun(`
        let getResult = (): inline (true, i32) | inline (false, _) => {
          return (true, 42);
        };
        export let main = (): i32 => {
          if (let (true, value) = getResult()) {
            return value;
          }
          return 0;
        };
      `);
      strictEqual(result, 42);
    });

    test('return (false, _) from union type', async () => {
      const result = await compileAndRun(`
        let getResult = (): inline (true, i32) | inline (false, _) => {
          return (false, _);
        };
        export let main = (): i32 => {
          let (hasMore, _) = getResult();
          if (hasMore) {
            return 1;
          }
          return 0;
        };
      `);
      strictEqual(result, 0);
    });

    test('conditional return from union type', async () => {
      const result = await compileAndRun(`
        let maybeGet = (flag: boolean): inline (true, i32) | inline (false, _) => {
          if (flag) {
            return (true, 99);
          }
          return (false, _);
        };
        export let main = (): i32 => {
          if (let (true, v1) = maybeGet(true)) {
            if (let (false, _) = maybeGet(false)) {
              return v1;
            }
          }
          return 0;
        };
      `);
      strictEqual(result, 99);
    });
  });

  suite('type narrowing', () => {
    test('value type narrows in if-let pattern', async () => {
      // `if (let (true, value) = ...)` narrows value to i32 in the success branch.
      const result = await compileAndRun(`
        let getResult = (): inline (true, i32) | inline (false, _) => {
          return (true, 42);
        };
        export let main = (): i32 => {
          if (let (true, value) = getResult()) {
            return value;
          }
          return 0;
        };
      `);
      strictEqual(result, 42);
    });

    test('if-let else branch when false tuple returned', async () => {
      const result = await compileAndRun(`
        let getResult = (flag: boolean): inline (true, i32) | inline (false, _) => {
          if (flag) {
            return (true, 100);
          }
          return (false, _);
        };
        export let main = (): i32 => {
          if (let (true, value) = getResult(false)) {
            return value;
          }
          return -1;
        };
      `);
      strictEqual(result, -1);
    });
  });

  suite('with reference types', () => {
    test('class instance in tuple union', async () => {
      // For now, we test that the tuple union compiles and runs correctly
      // Type narrowing of the second element based on the first element's
      // boolean value is a future feature
      const result = await compileAndRun(`
        class Box {
          value: i32;
          new(v: i32) : value = v {}
        }
        
        let maybeBox = (flag: boolean): inline (true, Box) | inline (false, _) => {
          if (flag) {
            return (true, new Box(123));
          }
          return (false, _);
        };
        
        export let main = (): i32 => {
          let (ok, box) = maybeBox(true);
          if (ok) {
            // box is Box | never here - cast to Box to access .value
            // (Type narrowing based on ok is a future feature)
            let b = box as Box;
            if (b !== null) {
              return b.value;
            }
          }
          return 0;
        };
      `);
      strictEqual(result, 123);
    });
  });

  suite('generic functions', () => {
    test('generic tuple union return', async () => {
      // For now, we test that the tuple union compiles and runs correctly
      // Type narrowing of the second element based on the first element's
      // boolean value is a future feature
      const result = await compileAndRun(`
        let maybe = <T>(flag: boolean, value: T): inline (true, T) | inline (false, _) => {
          if (flag) {
            return (true, value);
          }
          return (false, _);
        };
        
        export let main = (): i32 => {
          let (ok, v) = maybe(true, 777);
          if (ok) {
            // v is i32 | never here - cast to i32 to return
            // (Type narrowing based on ok is a future feature)
            return v as i32;
          }
          return 0;
        };
      `);
      strictEqual(result, 777);
    });
  });
});
