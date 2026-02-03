import {suite, test} from 'node:test';
import assert from 'node:assert';
import {tokenize, TokenType} from '../../lib/lexer.js';

suite('Shift Operators Lexer', () => {
  test('tokenizes left shift <<', () => {
    const tokens = tokenize('a << b');

    assert.strictEqual(tokens.length, 4); // a, <<, b, EOF
    assert.strictEqual(tokens[0].type, TokenType.Identifier);
    assert.strictEqual(tokens[0].value, 'a');
    assert.strictEqual(tokens[1].type, TokenType.LessLess);
    assert.strictEqual(tokens[1].value, '<<');
    assert.strictEqual(tokens[2].type, TokenType.Identifier);
    assert.strictEqual(tokens[2].value, 'b');
  });

  test('tokenizes right shift >>', () => {
    const tokens = tokenize('a >> b');

    assert.strictEqual(tokens.length, 4); // a, >>, b, EOF
    assert.strictEqual(tokens[0].type, TokenType.Identifier);
    assert.strictEqual(tokens[0].value, 'a');
    assert.strictEqual(tokens[1].type, TokenType.GreaterGreater);
    assert.strictEqual(tokens[1].value, '>>');
    assert.strictEqual(tokens[2].type, TokenType.Identifier);
    assert.strictEqual(tokens[2].value, 'b');
  });

  test('tokenizes unsigned right shift >>>', () => {
    const tokens = tokenize('a >>> b');

    assert.strictEqual(tokens.length, 4); // a, >>>, b, EOF
    assert.strictEqual(tokens[0].type, TokenType.Identifier);
    assert.strictEqual(tokens[0].value, 'a');
    assert.strictEqual(tokens[1].type, TokenType.GreaterGreaterGreater);
    assert.strictEqual(tokens[1].value, '>>>');
    assert.strictEqual(tokens[2].type, TokenType.Identifier);
    assert.strictEqual(tokens[2].value, 'b');
  });

  test('distinguishes << from < <=', () => {
    const tokens = tokenize('a < b <= c << d');

    assert.strictEqual(tokens[1].type, TokenType.Less);
    assert.strictEqual(tokens[1].value, '<');
    assert.strictEqual(tokens[3].type, TokenType.LessEquals);
    assert.strictEqual(tokens[3].value, '<=');
    assert.strictEqual(tokens[5].type, TokenType.LessLess);
    assert.strictEqual(tokens[5].value, '<<');
  });

  test('distinguishes >> and >>> from > >=', () => {
    const tokens = tokenize('a > b >= c >> d >>> e');

    assert.strictEqual(tokens[1].type, TokenType.Greater);
    assert.strictEqual(tokens[1].value, '>');
    assert.strictEqual(tokens[3].type, TokenType.GreaterEquals);
    assert.strictEqual(tokens[3].value, '>=');
    assert.strictEqual(tokens[5].type, TokenType.GreaterGreater);
    assert.strictEqual(tokens[5].value, '>>');
    assert.strictEqual(tokens[7].type, TokenType.GreaterGreaterGreater);
    assert.strictEqual(tokens[7].value, '>>>');
  });
});
