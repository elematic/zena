import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Dynamic Dispatch', () => {
  test('should support dynamic dispatch for overridden methods', async () => {
    const input = `
      class Animal {
        speak(): i32 {
          return 1;
        }
      }
      class Dog extends Animal {
        speak(): i32 {
          return 2;
        }
      }
      export let main = (): i32 => {
        let a: Animal = new Dog();
        return a.speak();
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 2);
  });

  test('should support dynamic dispatch for inherited methods', async () => {
    const input = `
      class Animal {
        speak(): i32 {
          return 1;
        }
      }
      class Dog extends Animal {
      }
      export let main = (): i32 => {
        let a: Animal = new Dog();
        return a.speak();
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 1);
  });
});
