import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import {strictEqual} from 'node:assert';

suite('let-pattern conditions', () => {
  suite('if (let pattern = expr)', () => {
    test('basic tuple destructuring - true case', async () => {
      const result = await compileAndRun(`
        let getResult = (): inline (boolean, i32) => (true, 42);
        
        export let main = (): i32 => {
          if (let (true, value) = getResult()) {
            return value;
          }
          return 0;
        };
      `);
      strictEqual(result, 42);
    });

    test('basic tuple destructuring - false case', async () => {
      const result = await compileAndRun(`
        let getResult = (): inline (boolean, i32) => (false, 0);
        
        export let main = (): i32 => {
          if (let (true, value) = getResult()) {
            return value;
          }
          return -1;
        };
      `);
      strictEqual(result, -1);
    });

    test('with else branch', async () => {
      const result = await compileAndRun(`
        let maybeGet = (flag: boolean): inline (boolean, i32) => {
          if (flag) {
            return (true, 100);
          }
          return (false, 0);
        };
        
        export let main = (): i32 => {
          if (let (true, v) = maybeGet(false)) {
            return v;
          } else {
            return -1;
          }
        };
      `);
      strictEqual(result, -1);
    });

    test('variable scoping - not visible outside if', async () => {
      // The bound variable should only be visible inside the if body
      const result = await compileAndRun(`
        let getResult = (): inline (boolean, i32) => (true, 42);
        
        export let main = (): i32 => {
          var result = 0;
          if (let (true, value) = getResult()) {
            result = value;
          }
          // 'value' is not visible here
          return result;
        };
      `);
      strictEqual(result, 42);
    });
  });

  suite('while (let pattern = expr)', () => {
    test('iterate until false', async () => {
      const result = await compileAndRun(`
        class Counter {
          value: i32;
          #new() {
            this.value = 0;
          }
          
          next(): inline (boolean, i32) {
            this.value = this.value + 1;
            if (this.value <= 3) {
              return (true, this.value);
            }
            return (false, 0);
          }
        }
        
        export let main = (): i32 => {
          let counter = new Counter();
          var sum = 0;
          while (let (true, v) = counter.next()) {
            sum = sum + v;
          }
          return sum;  // 1 + 2 + 3 = 6
        };
      `);
      strictEqual(result, 6);
    });

    test('variable only in scope inside loop body', async () => {
      const result = await compileAndRun(`
        class Counter {
          value: i32;
          #new() {
            this.value = 0;
          }
          
          next(): inline (boolean, i32) {
            this.value = this.value + 1;
            if (this.value <= 2) {
              return (true, this.value * 10);
            }
            return (false, 0);
          }
        }
        
        export let main = (): i32 => {
          let counter = new Counter();
          var last = 0;
          while (let (true, v) = counter.next()) {
            last = v;
          }
          // v is not visible here, but last captured it
          return last;  // 20 (last value was 2*10)
        };
      `);
      strictEqual(result, 20);
    });
  });

  suite('with union of tuples', () => {
    test('if let with discriminated union', async () => {
      const result = await compileAndRun(`
        let maybeValue = (flag: boolean): inline (true, i32) | inline (false, never) => {
          if (flag) {
            return (true, 999);
          }
          return (false, _);
        };
        
        export let main = (): i32 => {
          if (let (true, v) = maybeValue(true)) {
            return v;
          }
          return 0;
        };
      `);
      strictEqual(result, 999);
    });

    test('while let with discriminated union iterator', async () => {
      const result = await compileAndRun(`
        class Iterator {
          index: i32;
          #new() {
            this.index = 0;
          }
          
          next(): inline (true, i32) | inline (false, never) {
            this.index = this.index + 1;
            if (this.index <= 3) {
              return (true, this.index);
            }
            return (false, _);
          }
        }
        
        export let main = (): i32 => {
          let iter = new Iterator();
          var sum = 0;
          while (let (true, v) = iter.next()) {
            sum = sum + v;
          }
          return sum;  // 1 + 2 + 3 = 6
        };
      `);
      strictEqual(result, 6);
    });
  });
});
