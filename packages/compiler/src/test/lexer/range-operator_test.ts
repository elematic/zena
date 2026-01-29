import assert from 'node:assert';
import {suite, test} from 'node:test';
import {tokenize, TokenType} from '../../lib/lexer.js';

suite('Lexer - Range operator', () => {
  test('should tokenize .. as DotDot', () => {
    const input = '1..10';
    const tokens = tokenize(input);

    assert.strictEqual(tokens.length, 4); // Number, DotDot, Number, EOF
    assert.strictEqual(tokens[0].type, TokenType.Number);
    assert.strictEqual(tokens[0].value, '1');
    assert.strictEqual(tokens[1].type, TokenType.DotDot);
    assert.strictEqual(tokens[1].value, '..');
    assert.strictEqual(tokens[2].type, TokenType.Number);
    assert.strictEqual(tokens[2].value, '10');
    assert.strictEqual(tokens[3].type, TokenType.EOF);
  });

  test('should tokenize ... as DotDotDot (spread)', () => {
    const input = 'a...b';
    const tokens = tokenize(input);

    assert.strictEqual(tokens.length, 4); // Identifier, DotDotDot, Identifier, EOF
    assert.strictEqual(tokens[0].type, TokenType.Identifier);
    assert.strictEqual(tokens[1].type, TokenType.DotDotDot);
    assert.strictEqual(tokens[1].value, '...');
    assert.strictEqual(tokens[2].type, TokenType.Identifier);
  });

  test('should tokenize prefix range ..b', () => {
    const input = '..10';
    const tokens = tokenize(input);

    assert.strictEqual(tokens.length, 3); // DotDot, Number, EOF
    assert.strictEqual(tokens[0].type, TokenType.DotDot);
    assert.strictEqual(tokens[0].value, '..');
    assert.strictEqual(tokens[1].type, TokenType.Number);
    assert.strictEqual(tokens[1].value, '10');
  });

  test('should tokenize postfix range a..', () => {
    const input = '5..';
    const tokens = tokenize(input);

    assert.strictEqual(tokens.length, 3); // Number, DotDot, EOF
    assert.strictEqual(tokens[0].type, TokenType.Number);
    assert.strictEqual(tokens[1].type, TokenType.DotDot);
    assert.strictEqual(tokens[1].value, '..');
  });

  test('should tokenize full range ..', () => {
    const input = '..';
    const tokens = tokenize(input);

    assert.strictEqual(tokens.length, 2); // DotDot, EOF
    assert.strictEqual(tokens[0].type, TokenType.DotDot);
    assert.strictEqual(tokens[0].value, '..');
  });

  test('should not confuse .. and ... in sequence', () => {
    const input = '1....3';
    const tokens = tokenize(input);

    // 1, .., ., ., 3
    assert.strictEqual(tokens.length, 6); // Number, DotDot, Dot, Dot, Number, EOF
    assert.strictEqual(tokens[0].type, TokenType.Number);
    assert.strictEqual(tokens[1].type, TokenType.DotDot);
    assert.strictEqual(tokens[2].type, TokenType.Dot);
    assert.strictEqual(tokens[3].type, TokenType.Dot);
    assert.strictEqual(tokens[4].type, TokenType.Number);
  });
});
