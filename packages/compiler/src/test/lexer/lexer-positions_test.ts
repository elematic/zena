import assert from 'node:assert';
import {suite, test} from 'node:test';
import {tokenize, TokenType} from '../../lib/lexer.js';

suite('Lexer: Token Positions', () => {
  test('should track start and end for identifiers', () => {
    const input = 'hello';
    const tokens = tokenize(input);

    assert.strictEqual(tokens[0].type, TokenType.Identifier);
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 5);
  });

  test('should track start and end for numbers', () => {
    const input = '12345';
    const tokens = tokenize(input);

    assert.strictEqual(tokens[0].type, TokenType.Number);
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 5);
  });

  test('should track start and end for strings', () => {
    const input = '"hello"';
    const tokens = tokenize(input);

    assert.strictEqual(tokens[0].type, TokenType.String);
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 7);
  });

  test('should track positions correctly with whitespace', () => {
    const input = 'let x = 1;';
    const tokens = tokenize(input);

    // let
    assert.strictEqual(tokens[0].type, TokenType.Let);
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 3);

    // x
    assert.strictEqual(tokens[1].type, TokenType.Identifier);
    assert.strictEqual(tokens[1].start, 4);
    assert.strictEqual(tokens[1].end, 5);

    // =
    assert.strictEqual(tokens[2].type, TokenType.Equals);
    assert.strictEqual(tokens[2].start, 6);
    assert.strictEqual(tokens[2].end, 7);

    // 1
    assert.strictEqual(tokens[3].type, TokenType.Number);
    assert.strictEqual(tokens[3].start, 8);
    assert.strictEqual(tokens[3].end, 9);

    // ;
    assert.strictEqual(tokens[4].type, TokenType.Semi);
    assert.strictEqual(tokens[4].start, 9);
    assert.strictEqual(tokens[4].end, 10);

    // EOF
    assert.strictEqual(tokens[5].type, TokenType.EOF);
    assert.strictEqual(tokens[5].start, 10);
    assert.strictEqual(tokens[5].end, 10);
  });

  test('should track positions for multi-character operators', () => {
    const input = 'a => b';
    const tokens = tokenize(input);

    // a
    assert.strictEqual(tokens[0].type, TokenType.Identifier);
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 1);

    // =>
    assert.strictEqual(tokens[1].type, TokenType.Arrow);
    assert.strictEqual(tokens[1].start, 2);
    assert.strictEqual(tokens[1].end, 4);

    // b
    assert.strictEqual(tokens[2].type, TokenType.Identifier);
    assert.strictEqual(tokens[2].start, 5);
    assert.strictEqual(tokens[2].end, 6);
  });

  test('should track positions for comparison operators', () => {
    const input = 'a == b';
    const tokens = tokenize(input);

    // ==
    assert.strictEqual(tokens[1].type, TokenType.EqualsEquals);
    assert.strictEqual(tokens[1].start, 2);
    assert.strictEqual(tokens[1].end, 4);
  });

  test('should track positions for template literals', () => {
    const input = '`hello`';
    const tokens = tokenize(input);

    assert.strictEqual(tokens[0].type, TokenType.NoSubstitutionTemplate);
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 7);
  });

  test('should track positions across multiple lines', () => {
    const input = 'let\nx';
    const tokens = tokenize(input);

    // let
    assert.strictEqual(tokens[0].type, TokenType.Let);
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 3);
    assert.strictEqual(tokens[0].line, 1);
    assert.strictEqual(tokens[0].column, 1);

    // x (on line 2)
    assert.strictEqual(tokens[1].type, TokenType.Identifier);
    assert.strictEqual(tokens[1].start, 4);
    assert.strictEqual(tokens[1].end, 5);
    assert.strictEqual(tokens[1].line, 2);
    assert.strictEqual(tokens[1].column, 1);
  });

  test('should track positions for floating point numbers', () => {
    const input = '3.14';
    const tokens = tokenize(input);

    assert.strictEqual(tokens[0].type, TokenType.Number);
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 4);
  });

  test('should track positions after comments', () => {
    const input = '// comment\nx';
    const tokens = tokenize(input);

    // x (after comment)
    assert.strictEqual(tokens[0].type, TokenType.Identifier);
    assert.strictEqual(tokens[0].start, 11);
    assert.strictEqual(tokens[0].end, 12);
    assert.strictEqual(tokens[0].line, 2);
    assert.strictEqual(tokens[0].column, 1);
  });
});
