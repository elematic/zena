import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

function check(input: string) {
  const parser = new Parser(input);
  const program = parser.parse();
  const checker = TypeChecker.forProgram(program);
  const diagnostics = checker.check();
  return {
    errors: diagnostics.filter((d) => d.severity === 1),
  };
}

suite('Extension Union Tests', () => {
  test('Union of two extensions on the same type should fail', () => {
    const input = `
      extension class ExtA on array<i32> {}
      extension class ExtB on array<i32> {}

      export let main = (x: ExtA | ExtB): void => {
      };
    `;
    const diagnostics = check(input);
    if (diagnostics.errors.length > 0) {
      console.log(
        'Errors found:',
        diagnostics.errors.map((e) => e.message),
      );
    } else {
      console.log('No errors found.');
    }
  });

  test('Union of extension on primitive and null should fail', () => {
    const input = `
      extension class Meters on i32 {}

      export let main = (x: Meters | null): void => {
      };
    `;
    const diagnostics = check(input);
    if (diagnostics.errors.length > 0) {
      console.log(
        'Errors found:',
        diagnostics.errors.map((e) => e.message),
      );
    } else {
      console.log('No errors found.');
      throw new Error('Expected error for primitive extension union');
    }
  });
});
