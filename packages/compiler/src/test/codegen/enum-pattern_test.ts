import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import * as assert from 'node:assert';

suite('Codegen: Enum Member Pattern', () => {
  test('should match on enum members', async () => {
    const source = `
      enum Color {
        Red,
        Green,
        Blue
      }

      export let getColorName = (c: Color): i32 => {
        return match (c) {
          case Color.Red: 1
          case Color.Green: 2
          case Color.Blue: 3
        };
      };

      export let main = (): i32 => {
        if (getColorName(Color.Red) != 1) return 1;
        if (getColorName(Color.Green) != 2) return 2;
        if (getColorName(Color.Blue) != 3) return 3;
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });

  test('should match on enum with wildcard fallback', async () => {
    const source = `
      enum TokenType {
        Number,
        String,
        Identifier,
        Whitespace
      }

      export let isLiteral = (t: TokenType): boolean => {
        return match (t) {
          case TokenType.Number: true
          case TokenType.String: true
          case _: false
        };
      };

      export let main = (): i32 => {
        if (!isLiteral(TokenType.Number)) return 1;
        if (!isLiteral(TokenType.String)) return 2;
        if (isLiteral(TokenType.Identifier)) return 3;
        if (isLiteral(TokenType.Whitespace)) return 4;
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });

  test('should match on enum with custom values', async () => {
    const source = `
      enum Status {
        Ok = 200,
        NotFound = 404,
        ServerError = 500
      }

      export let getCategory = (s: Status): i32 => {
        return match (s) {
          case Status.Ok: 2
          case Status.NotFound: 4
          case Status.ServerError: 5
        };
      };

      export let main = (): i32 => {
        if (getCategory(Status.Ok) != 2) return 1;
        if (getCategory(Status.NotFound) != 4) return 2;
        if (getCategory(Status.ServerError) != 5) return 3;
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });

  test('should match on enum with guard', async () => {
    const source = `
      enum Operation {
        Add,
        Subtract,
        Multiply
      }

      export let compute = (op: Operation, a: i32, b: i32): i32 => {
        return match (op) {
          case Operation.Add: a + b
          case Operation.Subtract if a > b: a - b
          case Operation.Subtract: b - a
          case Operation.Multiply: a * b
        };
      };

      export let main = (): i32 => {
        if (compute(Operation.Add, 3, 4) != 7) return 1;
        if (compute(Operation.Subtract, 10, 3) != 7) return 2;
        if (compute(Operation.Subtract, 3, 10) != 7) return 3;
        if (compute(Operation.Multiply, 3, 4) != 12) return 4;
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });
});
