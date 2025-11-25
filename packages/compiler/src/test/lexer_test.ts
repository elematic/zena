import assert from 'node:assert';
import {suite, test} from 'node:test';
import {tokenize, TokenType, type Token} from '../lib/lexer.js';

type ExpectedToken = TokenType | [TokenType, string];

function assertTokens(tokens: Token[], expected: ExpectedToken[]) {
  assert.strictEqual(
    tokens.length,
    expected.length,
    `Expected ${expected.length} tokens, but got ${tokens.length}`,
  );

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const token = tokens[i];
    if (Array.isArray(exp)) {
      const [type, value] = exp;
      assert.strictEqual(
        token.type,
        type,
        `Token at index ${i}: Expected type ${type}, got ${token.type}`,
      );
      assert.strictEqual(
        token.value,
        value,
        `Token at index ${i}: Expected value '${value}', got '${token.value}'`,
      );
    } else {
      assert.strictEqual(
        token.type,
        exp,
        `Token at index ${i}: Expected type ${exp}, got ${token.type}`,
      );
    }
  }
}

suite('Lexer', () => {
  test('should tokenize variables', () => {
    const input = 'let x = 1;';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      TokenType.Let,
      [TokenType.Identifier, 'x'],
      TokenType.Equals,
      [TokenType.Number, '1'],
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });

  test('should tokenize arrow functions', () => {
    const input = 'let add = (a: i32, b: i32) => a + b;';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      TokenType.Let,
      [TokenType.Identifier, 'add'],
      TokenType.Equals,
      TokenType.LParen,
      [TokenType.Identifier, 'a'],
      TokenType.Colon,
      [TokenType.Identifier, 'i32'],
      TokenType.Comma,
      [TokenType.Identifier, 'b'],
      TokenType.Colon,
      [TokenType.Identifier, 'i32'],
      TokenType.RParen,
      TokenType.Arrow,
      [TokenType.Identifier, 'a'],
      TokenType.Plus,
      [TokenType.Identifier, 'b'],
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });
});
