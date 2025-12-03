import assert from 'node:assert';
import {suite, test} from 'node:test';
import {tokenize, TokenType, type Token} from '../../lib/lexer.js';

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

suite('Lexer Identifiers', () => {
  test('should tokenize identifiers with underscores', () => {
    const input = 'let _x = 1; let x_y = 2;';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      TokenType.Let,
      [TokenType.Identifier, '_x'],
      TokenType.Equals,
      [TokenType.Number, '1'],
      TokenType.Semi,
      TokenType.Let,
      [TokenType.Identifier, 'x_y'],
      TokenType.Equals,
      [TokenType.Number, '2'],
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });

  test('should tokenize identifiers with dollar signs', () => {
    const input = 'let $x = 1; let x$y = 2; let $ = 3;';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      TokenType.Let,
      [TokenType.Identifier, '$x'],
      TokenType.Equals,
      [TokenType.Number, '1'],
      TokenType.Semi,
      TokenType.Let,
      [TokenType.Identifier, 'x$y'],
      TokenType.Equals,
      [TokenType.Number, '2'],
      TokenType.Semi,
      TokenType.Let,
      [TokenType.Identifier, '$'],
      TokenType.Equals,
      [TokenType.Number, '3'],
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });
});
