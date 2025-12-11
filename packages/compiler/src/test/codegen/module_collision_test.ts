import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

suite('CodeGenerator - Module Collision', () => {
  test('should support global variables with same name in different modules', async () => {
    const modules = {
      'module_a': `
        export var counter = 0;
        export let increment = (): i32 => {
          counter = counter + 1;
          return counter;
        };
        export let get = (): i32 => counter;
      `,
      'module_b': `
        export var counter = 100;
        export let increment = (): i32 => {
          counter = counter + 1;
          return counter;
        };
        export let get = (): i32 => counter;
      `,
      'main': `
        import { increment as incA, get as getA } from "module_a";
        import { increment as incB, get as getB } from "module_b";

        export let test = (): void => {
          // Initial state
          if (getA() != 0) throw new Error("1");
          if (getB() != 100) throw new Error("2");

          // Modify A
          incA();
          if (getA() != 1) throw new Error("3");
          if (getB() != 100) throw new Error("4"); // B should be unchanged

          // Modify B
          incB();
          if (getA() != 1) throw new Error("5"); // A should be unchanged
          if (getB() != 101) throw new Error("6");
        };
      `
    };

    const exports = await compileAndInstantiate(modules, { path: 'main' });
    exports.test();
  });
});
