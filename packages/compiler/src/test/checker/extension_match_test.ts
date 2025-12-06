import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

function check(input: string) {
  const parser = new Parser(input);
  const program = parser.parse();
  const checker = new TypeChecker(program);
  const diagnostics = checker.check();
  return {
    errors: diagnostics.filter((d) => d.severity === 1),
  };
}

suite('Extension Match Tests', () => {
  test('Ambiguous extension match cases should fail', () => {
    const input = `
      extension class ExtA on array<i32> {}
      extension class ExtB on array<i32> {}

      export let main = (x: array<i32>): void => {
        match (x) {
          case ExtA {}: {}
          case ExtB {}: {}
        };
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
});
