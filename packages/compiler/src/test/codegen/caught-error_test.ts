import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('caught error handling', () => {
  // The catch parameter is typed as Error in Zena, but WASM exceptions
  // are caught as eqref. The codegen casts to the Error struct type at
  // the catch site so the parameter has the correct type for all uses.

  test('pass caught error to constructor', async () => {
    const result = await compileAndRun(`
      import { Error } from 'zena:error';
      
      class Result {
        value: i32;
        error: Error | null;
        
        #new(value: i32, error: Error | null) {
          this.value = value;
          this.error = error;
        }
        
        hasError(): boolean {
          return this.error != null;
        }
      }
      
      export let main = (): i32 => {
        let result = try {
          throw new Error('test error');
          new Result(0, null)
        } catch (e) {
          new Result(42, e)
        };
        
        if (result.hasError()) {
          return result.value;
        }
        return 0;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('pass caught error to method', async () => {
    const result = await compileAndRun(`
      import { Error } from 'zena:error';
      
      class ErrorHandler {
        lastError: Error | null;
        
        #new() {
          this.lastError = null;
        }
        
        setError(e: Error | null): void {
          this.lastError = e;
        }
        
        getCode(): i32 {
          if (this.lastError != null) {
            return 42;
          }
          return 0;
        }
      }
      
      export let main = (): i32 => {
        let handler = new ErrorHandler();
        try {
          throw new Error('test');
        } catch (e) {
          handler.setError(e);
        };
        return handler.getCode();
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('assign caught error to variable', async () => {
    const result = await compileAndRun(`
      import { Error } from 'zena:error';
      
      export let main = (): i32 => {
        var savedError: Error | null = null;
        
        try {
          throw new Error('saved');
        } catch (e) {
          savedError = e;
        };
        
        if (savedError != null) {
          return 42;
        }
        return 0;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('assign caught error to field', async () => {
    const result = await compileAndRun(`
      import { Error } from 'zena:error';
      
      class Container {
        error: Error | null;
        #new() {
          this.error = null;
        }
      }
      
      export let main = (): i32 => {
        let container = new Container();
        
        try {
          throw new Error('field test');
        } catch (e) {
          container.error = e;
        };
        
        if (container.error != null) {
          return 42;
        }
        return 0;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('return caught error from function', async () => {
    const result = await compileAndRun(`
      let catchError = (): i32 => {
        var result: Error | null = null;
        try {
          throw new Error('returned');
        } catch (e) {
          result = e;
        };
        if (result != null) {
          return 42;
        }
        return 0;
      };
      
      export let main = (): i32 => catchError();
    `);
    assert.strictEqual(result, 42);
  });
});
