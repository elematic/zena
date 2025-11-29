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
});
