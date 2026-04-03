import {suite, test} from 'node:test';
import assert from 'node:assert';
import {tokenize, TokenType} from '../../lib/lexer.js';

suite('Compound Assignment Lexer', () => {
  test('tokenizes +=', () => {
    const tokens = tokenize('x += 1');
    assert.strictEqual(tokens[0].type, TokenType.Identifier);
    assert.strictEqual(tokens[1].type, TokenType.PlusEquals);
    assert.strictEqual(tokens[1].value, '+=');
    assert.strictEqual(tokens[2].type, TokenType.Number);
  });

  test('tokenizes -=', () => {
    const tokens = tokenize('x -= 1');
    assert.strictEqual(tokens[1].type, TokenType.MinusEquals);
    assert.strictEqual(tokens[1].value, '-=');
  });

  test('tokenizes *=', () => {
    const tokens = tokenize('x *= 2');
    assert.strictEqual(tokens[1].type, TokenType.StarEquals);
    assert.strictEqual(tokens[1].value, '*=');
  });

  test('tokenizes /=', () => {
    const tokens = tokenize('x /= 2');
    assert.strictEqual(tokens[1].type, TokenType.SlashEquals);
    assert.strictEqual(tokens[1].value, '/=');
  });

  test('tokenizes %=', () => {
    const tokens = tokenize('x %= 3');
    assert.strictEqual(tokens[1].type, TokenType.PercentEquals);
    assert.strictEqual(tokens[1].value, '%=');
  });

  test('distinguishes + from +=', () => {
    const tokens = tokenize('a + b += c');
    assert.strictEqual(tokens[1].type, TokenType.Plus);
    assert.strictEqual(tokens[1].value, '+');
    assert.strictEqual(tokens[3].type, TokenType.PlusEquals);
    assert.strictEqual(tokens[3].value, '+=');
  });

  test('distinguishes / from /= and //', () => {
    const tokens = tokenize('a / b');
    assert.strictEqual(tokens[1].type, TokenType.Slash);

    const tokens2 = tokenize('a /= b');
    assert.strictEqual(tokens2[1].type, TokenType.SlashEquals);

    // // is a comment, should not produce tokens
    const tokens3 = tokenize('a // comment');
    assert.strictEqual(tokens3.length, 2); // a, EOF
  });
});
