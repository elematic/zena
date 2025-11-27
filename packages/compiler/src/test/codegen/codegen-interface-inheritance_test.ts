import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Interface Inheritance', () => {
  test('should support interface inheritance', async () => {
    const input = `
      interface A {
        methodA(): i32;
      }
      
      interface B extends A {
        methodB(): i32;
      }
      
      class C implements B {
        methodA(): i32 { return 1; }
        methodB(): i32 { return 2; }
      }
      
      export let main = (): i32 => {
        let c = new C();
        let b: B = c;
        let a: A = c; // Should be assignable?
        return b.methodA() + b.methodB();
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 3);
  });
});
