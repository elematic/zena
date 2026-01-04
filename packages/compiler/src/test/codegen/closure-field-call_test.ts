import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('closure field call', () => {
  test('call function-typed field on class', async () => {
    // Bug: calling this.fn(args) where fn is a field with function type
    // was incorrectly treated as a method call and threw "Method fn not found"
    const result = await compileAndRun(`
      class Handler {
        fn: (x: i32) => i32;
        
        #new(fn: (x: i32) => i32) {
          this.fn = fn;
        }
        
        invoke(x: i32): i32 {
          return this.fn(x);
        }
      }
      
      export let main = (): i32 => {
        let double = (x: i32): i32 => x * 2;
        let h = new Handler(double);
        return h.invoke(21);
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('call function-typed field with multiple arguments', async () => {
    const result = await compileAndRun(`
      class Calculator {
        operation: (a: i32, b: i32) => i32;
        
        #new(op: (a: i32, b: i32) => i32) {
          this.operation = op;
        }
        
        compute(a: i32, b: i32): i32 {
          return this.operation(a, b);
        }
      }
      
      export let main = (): i32 => {
        let add = (a: i32, b: i32): i32 => a + b;
        let calc = new Calculator(add);
        return calc.compute(20, 22);
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('call function-typed field that captures variables', async () => {
    const result = await compileAndRun(`
      class Incrementer {
        fn: () => i32;
        
        #new(fn: () => i32) {
          this.fn = fn;
        }
        
        call(): i32 {
          return this.fn();
        }
      }
      
      export let main = (): i32 => {
        let base = 40;
        let getVal = (): i32 => base + 2;
        let inc = new Incrementer(getVal);
        return inc.call();
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('call function-typed field returning void', async () => {
    const result = await compileAndRun(`
      class Effect {
        action: (x: i32) => void;
        result: i32;
        
        #new(action: (x: i32) => void) {
          this.action = action;
          this.result = 0;
        }
        
        run(x: i32): void {
          this.action(x);
        }
      }
      
      var globalResult: i32 = 0;
      
      export let main = (): i32 => {
        let setResult = (x: i32): void => { globalResult = x; };
        let effect = new Effect(setResult);
        effect.run(42);
        return globalResult;
      };
    `);
    assert.strictEqual(result, 42);
  });
});
