import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('static fields', () => {
  test('simple static field read only', async () => {
    const source = `
      class Counter {
        static value: i32 = 42;
      }

      export let main = (): i32 => {
        return Counter.value;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('static field read from static method', async () => {
    const source = `
      class Counter {
        static value: i32 = 42;
        
        static get(): i32 {
          return Counter.value;
        }
      }

      export let main = (): i32 => {
        return Counter.get();
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('static field write from static method', async () => {
    const source = `
      class Counter {
        static value: i32 = 10;
        
        static get(): i32 {
          return Counter.value;
        }
        
        static set(v: i32): void {
          Counter.value = v;
        }
      }

      export let main = (): i32 => {
        let before = Counter.get();
        Counter.set(42);
        let after = Counter.get();
        return before * 1000 + after;
      };
    `;
    // before = 10, after = 42, result = 10042
    const result = await compileAndRun(source);
    assert.strictEqual(result, 10042);
  });
});
