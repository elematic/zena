import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import {strictEqual} from 'node:assert';

suite('tuple unions', () => {
  suite('basic returns', () => {
    test('return (true, value) from union type', async () => {
      const result = await compileAndRun(`
        let getResult = (): inline (true, i32) | inline (false, never) => {
          return (true, 42);
        };
        export let main = (): i32 => {
          let (_, value) = getResult();
          return value;
        };
      `);
      strictEqual(result, 42);
    });

    test('return (false, _) from union type', async () => {
      const result = await compileAndRun(`
        let getResult = (): inline (true, i32) | inline (false, never) => {
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
        let maybeGet = (flag: boolean): inline (true, i32) | inline (false, never) => {
          if (flag) {
            return (true, 99);
          }
          return (false, _);
        };
        export let main = (): i32 => {
          let (ok1, v1) = maybeGet(true);
          let (ok2, _) = maybeGet(false);
          if (ok1) {
            if (!ok2) {
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
    test('value type narrows after boolean check', async () => {
      // After checking hasMore is true, value should narrow from T | never to T
      const result = await compileAndRun(`
        let getResult = (): inline (true, i32) | inline (false, never) => {
          return (true, 42);
        };
        export let main = (): i32 => {
          let (hasMore, value) = getResult();
          // value is: i32 | never
          // After this check, value should be: i32
          if (hasMore) {
            return value;
          }
          return 0;
        };
      `);
      strictEqual(result, 42);
    });

    test('value not usable in else branch', async () => {
      // This test verifies the type system (value is 'never' in else branch)
      // We can't actually use value in else branch, but we can return 0
      const result = await compileAndRun(`
        let getResult = (flag: boolean): inline (true, i32) | inline (false, never) => {
          if (flag) {
            return (true, 100);
          }
          return (false, _);
        };
        export let main = (): i32 => {
          let (hasMore, value) = getResult(false);
          if (hasMore) {
            return value;
          }
          // value is 'never' here - cannot be used
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
          #new(v: i32) {
            this.value = v;
          }
        }
        
        let maybeBox = (flag: boolean): inline (true, Box) | inline (false, never) => {
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
        let maybe = <T>(flag: boolean, value: T): inline (true, T) | inline (false, never) => {
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
