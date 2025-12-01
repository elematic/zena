import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Extension Class Instantiation', () => {
  test('should support static factory method', async () => {
    const input = `
      extension class Meters on i32 {
        static create(val: i32): Meters {
          return val as Meters;
        }
        
        getValue(): i32 {
            return this;
        }
      }
      export let main = (): i32 => {
        let m = Meters.create(10);
        return m.getValue();
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 10);
  });

  test('should support static "new" method', async () => {
    const input = `
      extension class Meters on i32 {
        static new(val: i32): Meters {
          return val as Meters;
        }
        
        getValue(): i32 {
            return this;
        }
      }
      export let main = (): i32 => {
        let m = Meters.new(10);
        return m.getValue();
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 10);
  });

  test('should support "new" operator with static #new', async () => {
    const input = `
      extension class Meters on i32 {
        static #new(val: i32): Meters {
          return val as Meters;
        }
        
        getValue(): i32 {
            return this;
        }
      }
      export let main = (): i32 => {
        let m = new Meters(10);
        return m.getValue();
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 10);
  });

  test('should support "new" operator with instance constructor and super call', async () => {
    const input = `
      extension class Meters on i32 {
        #new(val: i32) {
          super(val);
        }
        
        getValue(): i32 {
            return this;
        }
      }
      export let main = (): i32 => {
        let m = new Meters(42);
        return m.getValue();
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 42);
  });
});
