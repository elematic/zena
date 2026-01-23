import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

function parse(input: string) {
  return new Parser(input).parse();
}

suite('Checker (Generic Methods)', () => {
  test('should check generic method in class', () => {
    const input = `
      class Test {
        method<T>(arg: T): T {
          return arg;
        }
      }
      let t = new Test();
      let x = t.method<i32>(10);
    `;
    const program = parse(input);
    const checker = TypeChecker.forProgram(program);
    const diagnostics = checker.check();

    assert.strictEqual(diagnostics.length, 0);
  });

  test('should check generic method in mixin', () => {
    const input = `
      mixin TestMixin {
        method<T>(arg: T): T {
          return arg;
        }
      }
      class Test with TestMixin {}
      let t = new Test();
      let x = t.method<i32>(10);
    `;
    const program = parse(input);
    const checker = TypeChecker.forProgram(program);
    const diagnostics = checker.check();

    assert.strictEqual(diagnostics.length, 0);
  });
});
