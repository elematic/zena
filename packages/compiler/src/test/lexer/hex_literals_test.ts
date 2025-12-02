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

suite('Lexer - Hex Literals', () => {
  test('should tokenize hex integer literals', () => {
    const input = '0x123 0XABC 0x0 0xFF';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      [TokenType.Number, '0x123'],
      [TokenType.Number, '0XABC'],
      [TokenType.Number, '0x0'],
      [TokenType.Number, '0xFF'],
      TokenType.EOF,
    ]);
  });

  test('should tokenize hex integer literals mixed with other tokens', () => {
    const input = 'let x = 0x1A;';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      TokenType.Let,
      [TokenType.Identifier, 'x'],
      TokenType.Equals,
      [TokenType.Number, '0x1A'],
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });
});
