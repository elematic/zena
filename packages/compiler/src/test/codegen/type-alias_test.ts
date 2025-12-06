import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Type Aliases', () => {
  test('should compile and run type alias for string', async () => {
    const code = `
      type Name = string;
      export let main = (): string => {
        let s: Name = "hello";
        return s;
      };
    `;
    await compileAndRun(code, 'main');
  });

  test('should compile and run cast to type alias', async () => {
    const code = `
      type Name = string;
      export let main = (): string => {
        let s = "hello" as Name;
        return s;
      };
    `;
    await compileAndRun(code, 'main');
  });

  test('should compile and run tuple type alias', async () => {
    const source = `
      type Foo = [string, i32];

      let f = (x: Foo): i32 => {
        return x[1];
      };

      export let main = (): i32 => {
        let t: Foo = ["hello", 42];
        return f(t);
      };
    `;
    const result = await compileAndRun(source, 'main');
    if (result !== 42) {
      throw new Error(`Expected 42, got ${result}`);
    }
  });
});
