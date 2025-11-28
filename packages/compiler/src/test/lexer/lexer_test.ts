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

  test('should tokenize while loop', () => {
    const input = 'while (true) { }';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      TokenType.While,
      TokenType.LParen,
      TokenType.True,
      TokenType.RParen,
      TokenType.LBrace,
      TokenType.RBrace,
      TokenType.EOF,
    ]);
  });

  test('should tokenize assignment', () => {
    const input = 'x = 1;';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      [TokenType.Identifier, 'x'],
      TokenType.Equals,
      [TokenType.Number, '1'],
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });

  test('should tokenize function call', () => {
    const input = 'add(1, 2);';
    const tokens = tokenize(input);

    assertTokens(tokens, [
      [TokenType.Identifier, 'add'],
      TokenType.LParen,
      [TokenType.Number, '1'],
      TokenType.Comma,
      [TokenType.Number, '2'],
      TokenType.RParen,
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });

  test('should tokenize nested braces', () => {
    const input = '{ { } }';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      TokenType.LBrace,
      TokenType.LBrace,
      TokenType.RBrace,
      TokenType.RBrace,
      TokenType.EOF,
    ]);
  });

  test('should skip single-line comments', () => {
    const input = 'let x = 1; // comment\nlet y = 2;';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      TokenType.Let,
      [TokenType.Identifier, 'x'],
      TokenType.Equals,
      [TokenType.Number, '1'],
      TokenType.Semi,
      TokenType.Let,
      [TokenType.Identifier, 'y'],
      TokenType.Equals,
      [TokenType.Number, '2'],
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });

  test('should skip multi-line comments on single line', () => {
    const input = 'let x /* comment */ = 1;';
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

  test('should skip multi-line comments spanning multiple lines', () => {
    const input = `let x = 1;
/* this is
   a multi-line
   comment */
let y = 2;`;
    const tokens = tokenize(input);
    assertTokens(tokens, [
      TokenType.Let,
      [TokenType.Identifier, 'x'],
      TokenType.Equals,
      [TokenType.Number, '1'],
      TokenType.Semi,
      TokenType.Let,
      [TokenType.Identifier, 'y'],
      TokenType.Equals,
      [TokenType.Number, '2'],
      TokenType.Semi,
      TokenType.EOF,
    ]);
  });

  test('should skip multi-line comments with stars inside', () => {
    const input = 'let x /* * ** *** */ = 1;';
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

  test('should handle unclosed multi-line comment at end of file', () => {
    const input = 'let x = 1; /* unclosed';
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

  test('should handle multi-line comment ending with star at EOF', () => {
    const input = 'let x = 1; /*comment*';
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

  test('should tokenize slash at end of input', () => {
    const input = '1 /';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.Number, '1'],
      TokenType.Slash,
      TokenType.EOF,
    ]);
  });

  test('should tokenize string with newline escape', () => {
    const input = `"hello\\nworld"`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, 'hello\nworld'], TokenType.EOF]);
  });

  test('should tokenize string with tab escape', () => {
    const input = `"hello\\tworld"`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, 'hello\tworld'], TokenType.EOF]);
  });

  test('should tokenize string with carriage return escape', () => {
    const input = `"hello\\rworld"`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, 'hello\rworld'], TokenType.EOF]);
  });

  test('should tokenize string with backslash escape', () => {
    const input = `"hello\\\\world"`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, 'hello\\world'], TokenType.EOF]);
  });

  test('should tokenize string with escaped double quote', () => {
    const input = `"hello\\"world"`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, 'hello"world'], TokenType.EOF]);
  });

  test('should tokenize string with escaped single quote', () => {
    const input = `'hello\\'world'`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, "hello'world"], TokenType.EOF]);
  });

  test('should tokenize string with multiple escapes', () => {
    const input = `"line1\\nline2\\ttab"`;
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.String, 'line1\nline2\ttab'],
      TokenType.EOF,
    ]);
  });

  test('should keep unknown escape sequence as is', () => {
    const input = `"hello\\xworld"`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, 'hello\\xworld'], TokenType.EOF]);
  });

  test('should handle escaped quote inside single-quoted string', () => {
    const input = `'it\\'s'`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, "it's"], TokenType.EOF]);
  });

  test('should handle trailing backslash at end of source', () => {
    // Tests edge case: source ends mid-escape sequence
    // The input is: "test\ (6 chars: double-quote, t, e, s, t, backslash)
    const input = `"test\\`;
    const tokens = tokenize(input);
    assertTokens(tokens, [[TokenType.String, 'test'], TokenType.EOF]);
  });

  test('should tokenize simple template literal', () => {
    const input = '`hello world`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.NoSubstitutionTemplate, 'hello world'],
      TokenType.EOF,
    ]);
  });

  test('should tokenize template literal with escape sequences', () => {
    const input = '`hello\\nworld`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.NoSubstitutionTemplate, 'hello\nworld'],
      TokenType.EOF,
    ]);
    // Check raw value
    assert.strictEqual(tokens[0].rawValue, 'hello\\nworld');
  });

  test('should tokenize template literal with escaped backtick', () => {
    const input = '`hello\\`world`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.NoSubstitutionTemplate, 'hello`world'],
      TokenType.EOF,
    ]);
  });

  test('should tokenize template literal with escaped dollar sign', () => {
    const input = '`price is \\$100`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.NoSubstitutionTemplate, 'price is $100'],
      TokenType.EOF,
    ]);
  });

  test('should tokenize template literal with single substitution', () => {
    const input = '`hello ${name}`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.TemplateHead, 'hello '],
      [TokenType.Identifier, 'name'],
      [TokenType.TemplateTail, ''],
      TokenType.EOF,
    ]);
  });

  test('should tokenize template literal with multiple substitutions', () => {
    const input = '`${a} + ${b} = ${c}`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.TemplateHead, ''],
      [TokenType.Identifier, 'a'],
      [TokenType.TemplateMiddle, ' + '],
      [TokenType.Identifier, 'b'],
      [TokenType.TemplateMiddle, ' = '],
      [TokenType.Identifier, 'c'],
      [TokenType.TemplateTail, ''],
      TokenType.EOF,
    ]);
  });

  test('should tokenize template literal with expression', () => {
    const input = '`result is ${a + b}`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.TemplateHead, 'result is '],
      [TokenType.Identifier, 'a'],
      TokenType.Plus,
      [TokenType.Identifier, 'b'],
      [TokenType.TemplateTail, ''],
      TokenType.EOF,
    ]);
  });

  test('should tokenize template literal with nested braces in expression', () => {
    const input = '`value is ${obj.x}`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.TemplateHead, 'value is '],
      [TokenType.Identifier, 'obj'],
      TokenType.Dot,
      [TokenType.Identifier, 'x'],
      [TokenType.TemplateTail, ''],
      TokenType.EOF,
    ]);
  });

  test('should tokenize template literal with object literal in expression', () => {
    const input = '`value is ${{ x: 1 }}`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.TemplateHead, 'value is '],
      TokenType.LBrace,
      [TokenType.Identifier, 'x'],
      TokenType.Colon,
      [TokenType.Number, '1'],
      TokenType.RBrace,
      [TokenType.TemplateTail, ''],
      TokenType.EOF,
    ]);
  });

  test('should tokenize tagged template literal', () => {
    const input = 'html`<div>${name}</div>`';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.Identifier, 'html'],
      [TokenType.TemplateHead, '<div>'],
      [TokenType.Identifier, 'name'],
      [TokenType.TemplateTail, '</div>'],
      TokenType.EOF,
    ]);
  });

  test('should preserve raw and cooked values differently', () => {
    const input = '`line1\\nline2`';
    const tokens = tokenize(input);
    assert.strictEqual(tokens[0].value, 'line1\nline2'); // cooked
    assert.strictEqual(tokens[0].rawValue, 'line1\\nline2'); // raw
  });

  test('should tokenize empty template literal', () => {
    const input = '``';
    const tokens = tokenize(input);
    assertTokens(tokens, [
      [TokenType.NoSubstitutionTemplate, ''],
      TokenType.EOF,
    ]);
  });
});
