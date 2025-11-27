export const TokenType = {
  // Keywords
  Let: 'Let',
  Var: 'Var',
  Class: 'Class',
  Import: 'Import',
  Export: 'Export',
  Return: 'Return',
  If: 'If',
  Else: 'Else',
  While: 'While',
  True: 'True',
  False: 'False',
  Null: 'Null',
  New: 'New',
  This: 'This',
  Extends: 'Extends',
  Interface: 'Interface',
  Implements: 'Implements',
  Final: 'Final',
  Super: 'Super',
  Mixin: 'Mixin',
  With: 'With',
  On: 'On',
  Abstract: 'Abstract',
  Operator: 'Operator',

  // Identifiers & Literals
  Identifier: 'Identifier',
  Number: 'Number',
  String: 'String',

  // Operators
  Equals: 'Equals',
  EqualsEquals: 'EqualsEquals',
  BangEquals: 'BangEquals',
  Less: 'Less',
  LessEquals: 'LessEquals',
  Greater: 'Greater',
  GreaterEquals: 'GreaterEquals',
  Arrow: 'Arrow',
  Plus: 'Plus',
  Minus: 'Minus',
  Star: 'Star',
  Slash: 'Slash',
  Pipe: 'Pipe',

  // Punctuation
  LParen: 'LParen',
  RParen: 'RParen',
  LBrace: 'LBrace',
  RBrace: 'RBrace',
  LBracket: 'LBracket',
  RBracket: 'RBracket',
  Colon: 'Colon',
  Semi: 'Semi',
  Comma: 'Comma',
  Dot: 'Dot',
  Hash: 'Hash',

  EOF: 'EOF',
  Unknown: 'Unknown',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

const KEYWORDS: Record<string, TokenType> = Object.assign(Object.create(null), {
  let: TokenType.Let,
  var: TokenType.Var,
  class: TokenType.Class,
  final: TokenType.Final,
  import: TokenType.Import,
  export: TokenType.Export,
  return: TokenType.Return,
  if: TokenType.If,
  else: TokenType.Else,
  while: TokenType.While,
  true: TokenType.True,
  false: TokenType.False,
  null: TokenType.Null,
  new: TokenType.New,
  this: TokenType.This,
  extends: TokenType.Extends,
  interface: TokenType.Interface,
  implements: TokenType.Implements,
  super: TokenType.Super,
  mixin: TokenType.Mixin,
  with: TokenType.With,
  on: TokenType.On,
  abstract: TokenType.Abstract,
  operator: TokenType.Operator,
});

export const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let current = 0;
  let line = 1;
  let column = 1;

  const advance = () => {
    const char = source[current];
    current++;
    if (char === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
    return char;
  };

  const peek = () => source[current];

  while (current < source.length) {
    const startColumn = column;
    const char = peek();

    // Whitespace
    if (/\s/.test(char)) {
      advance();
      continue;
    }

    // Numbers
    if (/[0-9]/.test(char)) {
      let value = '';
      while (current < source.length && /[0-9]/.test(peek())) {
        value += advance();
      }

      // Fractional part
      if (peek() === '.' && /[0-9]/.test(source[current + 1])) {
        value += advance(); // Consume '.'
        while (current < source.length && /[0-9]/.test(peek())) {
          value += advance();
        }
      }

      tokens.push({type: TokenType.Number, value, line, column: startColumn});
      continue;
    }

    // Identifiers & Keywords
    if (/[a-zA-Z_]/.test(char)) {
      let value = '';
      while (current < source.length && /[a-zA-Z0-9_]/.test(peek())) {
        value += advance();
      }
      const type = KEYWORDS[value] || TokenType.Identifier;
      tokens.push({type, value, line, column: startColumn});
      continue;
    }

    // Strings (simple single quote support)
    if (char === "'") {
      advance(); // Skip opening quote
      let value = '';
      while (current < source.length && peek() !== "'") {
        value += advance();
      }
      if (current < source.length) advance(); // Skip closing quote
      tokens.push({type: TokenType.String, value, line, column: startColumn});
      continue;
    }

    // Strings (double quote support)
    if (char === '"') {
      advance(); // Skip opening quote
      let value = '';
      while (current < source.length && peek() !== '"') {
        value += advance();
      }
      if (current < source.length) advance(); // Skip closing quote
      tokens.push({type: TokenType.String, value, line, column: startColumn});
      continue;
    }

    // Operators & Punctuation
    const c = advance();
    switch (c) {
      case '=':
        if (peek() === '>') {
          advance();
          tokens.push({
            type: TokenType.Arrow,
            value: '=>',
            line,
            column: startColumn,
          });
        } else if (peek() === '=') {
          advance();
          tokens.push({
            type: TokenType.EqualsEquals,
            value: '==',
            line,
            column: startColumn,
          });
        } else {
          tokens.push({
            type: TokenType.Equals,
            value: '=',
            line,
            column: startColumn,
          });
        }
        break;
      case '!':
        if (peek() === '=') {
          advance();
          tokens.push({
            type: TokenType.BangEquals,
            value: '!=',
            line,
            column: startColumn,
          });
        } else {
          tokens.push({
            type: TokenType.Unknown,
            value: '!',
            line,
            column: startColumn,
          });
        }
        break;
      case '<':
        if (peek() === '=') {
          advance();
          tokens.push({
            type: TokenType.LessEquals,
            value: '<=',
            line,
            column: startColumn,
          });
        } else {
          tokens.push({
            type: TokenType.Less,
            value: '<',
            line,
            column: startColumn,
          });
        }
        break;
      case '>':
        if (peek() === '=') {
          advance();
          tokens.push({
            type: TokenType.GreaterEquals,
            value: '>=',
            line,
            column: startColumn,
          });
        } else {
          tokens.push({
            type: TokenType.Greater,
            value: '>',
            line,
            column: startColumn,
          });
        }
        break;
      case '+':
        tokens.push({
          type: TokenType.Plus,
          value: '+',
          line,
          column: startColumn,
        });
        break;
      case '-':
        tokens.push({
          type: TokenType.Minus,
          value: '-',
          line,
          column: startColumn,
        });
        break;
      case '*':
        tokens.push({
          type: TokenType.Star,
          value: '*',
          line,
          column: startColumn,
        });
        break;
      case '/':
        if (peek() === '/') {
          // Single-line comment
          while (current < source.length && peek() !== '\n') {
            advance();
          }
        } else {
          tokens.push({
            type: TokenType.Slash,
            value: '/',
            line,
            column: startColumn,
          });
        }
        break;
      case '|':
        tokens.push({
          type: TokenType.Pipe,
          value: '|',
          line,
          column: startColumn,
        });
        break;
      case '(':
        tokens.push({
          type: TokenType.LParen,
          value: '(',
          line,
          column: startColumn,
        });
        break;
      case ')':
        tokens.push({
          type: TokenType.RParen,
          value: ')',
          line,
          column: startColumn,
        });
        break;
      case '{':
        tokens.push({
          type: TokenType.LBrace,
          value: '{',
          line,
          column: startColumn,
        });
        break;
      case '}':
        tokens.push({
          type: TokenType.RBrace,
          value: '}',
          line,
          column: startColumn,
        });
        break;
      case '[':
        tokens.push({
          type: TokenType.LBracket,
          value: '[',
          line,
          column: startColumn,
        });
        break;
      case ']':
        tokens.push({
          type: TokenType.RBracket,
          value: ']',
          line,
          column: startColumn,
        });
        break;
      case ':':
        tokens.push({
          type: TokenType.Colon,
          value: ':',
          line,
          column: startColumn,
        });
        break;
      case ';':
        tokens.push({
          type: TokenType.Semi,
          value: ';',
          line,
          column: startColumn,
        });
        break;
      case ',':
        tokens.push({
          type: TokenType.Comma,
          value: ',',
          line,
          column: startColumn,
        });
        break;
      case '.':
        tokens.push({
          type: TokenType.Dot,
          value: '.',
          line,
          column: startColumn,
        });
        break;
      case '#':
        tokens.push({
          type: TokenType.Hash,
          value: '#',
          line,
          column: startColumn,
        });
        break;
      default:
        tokens.push({
          type: TokenType.Unknown,
          value: c,
          line,
          column: startColumn,
        });
    }
  }

  tokens.push({type: TokenType.EOF, value: '', line, column});
  return tokens;
};
