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
  For: 'For',
  Break: 'Break',
  Continue: 'Continue',
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
  Declare: 'Declare',
  Function: 'Function',
  From: 'From',
  Type: 'Type',
  Distinct: 'Distinct',
  As: 'As',
  Is: 'Is',
  Extension: 'Extension',
  Static: 'Static',
  Throw: 'Throw',
  Try: 'Try',
  Catch: 'Catch',
  Finally: 'Finally',
  Match: 'Match',
  Case: 'Case',
  Symbol: 'Symbol',
  Enum: 'Enum',

  // Identifiers & Literals
  Identifier: 'Identifier',
  Number: 'Number',
  String: 'String',
  // Template literals
  NoSubstitutionTemplate: 'NoSubstitutionTemplate',
  TemplateHead: 'TemplateHead',
  TemplateMiddle: 'TemplateMiddle',
  TemplateTail: 'TemplateTail',

  // Operators
  Equals: 'Equals',
  EqualsEquals: 'EqualsEquals',
  EqualsEqualsEquals: 'EqualsEqualsEquals',
  Bang: 'Bang',
  BangEquals: 'BangEquals',
  BangEqualsEquals: 'BangEqualsEquals',
  Less: 'Less',
  LessEquals: 'LessEquals',
  LessLess: 'LessLess',
  Greater: 'Greater',
  GreaterEquals: 'GreaterEquals',
  GreaterGreater: 'GreaterGreater',
  GreaterGreaterGreater: 'GreaterGreaterGreater',
  Arrow: 'Arrow',
  Plus: 'Plus',
  Minus: 'Minus',
  Star: 'Star',
  Slash: 'Slash',
  Percent: 'Percent',
  Pipe: 'Pipe',
  PipePipe: 'PipePipe',
  Ampersand: 'Ampersand',
  AmpersandAmpersand: 'AmpersandAmpersand',
  Caret: 'Caret',
  Question: 'Question',

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
  DotDot: 'DotDot',
  DotDotDot: 'DotDotDot',
  Hash: 'Hash',
  At: 'At',

  EOF: 'EOF',
  Unknown: 'Unknown',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export interface Token {
  type: TokenType;
  value: string;
  /** Raw string value for template literals (before escape processing) */
  rawValue?: string;
  line: number;
  column: number;
  /** Start index in the source string (0-based, inclusive) */
  start: number;
  /** End index in the source string (0-based, exclusive) */
  end: number;
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
  for: TokenType.For,
  break: TokenType.Break,
  continue: TokenType.Continue,
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
  declare: TokenType.Declare,
  function: TokenType.Function,
  from: TokenType.From,
  type: TokenType.Type,
  distinct: TokenType.Distinct,
  as: TokenType.As,
  is: TokenType.Is,
  extension: TokenType.Extension,
  static: TokenType.Static,
  throw: TokenType.Throw,
  try: TokenType.Try,
  catch: TokenType.Catch,
  finally: TokenType.Finally,
  match: TokenType.Match,
  case: TokenType.Case,
  symbol: TokenType.Symbol,
  enum: TokenType.Enum,
});

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let current = 0;
  let line = 1;
  let column = 1;
  // Track nesting: when we see ${ we push brace count, when count reaches 0 we pop
  const templateStack: number[] = [];

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
  const peekNext = () => source[current + 1];

  // Process escape sequence and return the cooked character(s)
  const processEscape = (): string => {
    if (current >= source.length) return '';
    const escaped = advance();
    switch (escaped) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '\\':
        return '\\';
      case '`':
        return '`';
      case '$':
        return '$';
      case '0':
        return '\0';
      default:
        // Unknown escape - keep as is
        return '\\' + escaped;
    }
  };

  // Scan a template literal part (after ` or })
  // Returns the token type and cooked/raw values
  const scanTemplatePart = (
    isMiddleOrTail: boolean,
  ): {type: TokenType; cooked: string; raw: string} => {
    let cooked = '';
    let raw = '';

    while (current < source.length) {
      const char = peek();

      if (char === '`') {
        advance(); // consume closing backtick
        return {
          type: isMiddleOrTail
            ? TokenType.TemplateTail
            : TokenType.NoSubstitutionTemplate,
          cooked,
          raw,
        };
      }

      if (char === '$' && peekNext() === '{') {
        advance(); // consume $
        advance(); // consume {
        templateStack.push(1); // start tracking braces
        return {
          type: isMiddleOrTail
            ? TokenType.TemplateMiddle
            : TokenType.TemplateHead,
          cooked,
          raw,
        };
      }

      if (char === '\\') {
        raw += advance(); // add backslash to raw
        if (current < source.length) {
          raw += peek(); // add next char to raw before processing
          cooked += processEscape();
        }
      } else {
        const c = advance();
        cooked += c;
        raw += c;
      }
    }

    // Reached end of source without closing - treat as complete
    return {
      type: isMiddleOrTail
        ? TokenType.TemplateTail
        : TokenType.NoSubstitutionTemplate,
      cooked,
      raw,
    };
  };

  while (current < source.length) {
    const startIndex = current;
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

      if (char === '0' && (peekNext() === 'x' || peekNext() === 'X')) {
        value += advance(); // Consume '0'
        value += advance(); // Consume 'x' or 'X'

        while (current < source.length && /[0-9a-fA-F]/.test(peek())) {
          value += advance();
        }
      } else {
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
      }

      tokens.push({
        type: TokenType.Number,
        value,
        line,
        column: startColumn,
        start: startIndex,
        end: current,
      });
      continue;
    }

    // Identifiers & Keywords
    if (/[a-zA-Z_$]/.test(char)) {
      let value = '';
      while (current < source.length && /[a-zA-Z0-9_$]/.test(peek())) {
        value += advance();
      }
      const type = KEYWORDS[value] || TokenType.Identifier;
      tokens.push({
        type,
        value,
        line,
        column: startColumn,
        start: startIndex,
        end: current,
      });
      continue;
    }

    // Strings (single or double quote)
    if (char === "'" || char === '"') {
      const quote = advance(); // Skip opening quote
      let value = '';
      while (current < source.length && peek() !== quote) {
        if (peek() === '\\') {
          advance(); // Skip backslash
          if (current >= source.length) break;
          const escaped = advance();
          switch (escaped) {
            case 'n':
              value += '\n';
              break;
            case 'r':
              value += '\r';
              break;
            case 't':
              value += '\t';
              break;
            case '\\':
              value += '\\';
              break;
            case "'":
              value += "'";
              break;
            case '"':
              value += '"';
              break;
            default:
              // Unknown escape sequence - keep backslash and character
              value += '\\' + escaped;
          }
        } else {
          value += advance();
        }
      }
      if (current < source.length) advance(); // Skip closing quote
      tokens.push({
        type: TokenType.String,
        value,
        line,
        column: startColumn,
        start: startIndex,
        end: current,
      });
      continue;
    }

    // Template literals (backtick)
    if (char === '`') {
      advance(); // Skip opening backtick
      const template = scanTemplatePart(false);
      tokens.push({
        type: template.type,
        value: template.cooked,
        rawValue: template.raw,
        line,
        column: startColumn,
        start: startIndex,
        end: current,
      });
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
            start: startIndex,
            end: current,
          });
        } else if (peek() === '=') {
          advance();
          if (peek() === '=') {
            advance();
            tokens.push({
              type: TokenType.EqualsEqualsEquals,
              value: '===',
              line,
              column: startColumn,
              start: startIndex,
              end: current,
            });
          } else {
            tokens.push({
              type: TokenType.EqualsEquals,
              value: '==',
              line,
              column: startColumn,
              start: startIndex,
              end: current,
            });
          }
        } else {
          tokens.push({
            type: TokenType.Equals,
            value: '=',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        }
        break;
      case '!':
        if (peek() === '=') {
          advance();
          if (peek() === '=') {
            advance();
            tokens.push({
              type: TokenType.BangEqualsEquals,
              value: '!==',
              line,
              column: startColumn,
              start: startIndex,
              end: current,
            });
          } else {
            tokens.push({
              type: TokenType.BangEquals,
              value: '!=',
              line,
              column: startColumn,
              start: startIndex,
              end: current,
            });
          }
        } else {
          tokens.push({
            type: TokenType.Bang,
            value: '!',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
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
            start: startIndex,
            end: current,
          });
        } else if (peek() === '<') {
          advance();
          tokens.push({
            type: TokenType.LessLess,
            value: '<<',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        } else {
          tokens.push({
            type: TokenType.Less,
            value: '<',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
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
            start: startIndex,
            end: current,
          });
        } else if (peek() === '>') {
          advance();
          if (peek() === '>') {
            advance();
            tokens.push({
              type: TokenType.GreaterGreaterGreater,
              value: '>>>',
              line,
              column: startColumn,
              start: startIndex,
              end: current,
            });
          } else {
            tokens.push({
              type: TokenType.GreaterGreater,
              value: '>>',
              line,
              column: startColumn,
              start: startIndex,
              end: current,
            });
          }
        } else {
          tokens.push({
            type: TokenType.Greater,
            value: '>',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        }
        break;
      case '+':
        tokens.push({
          type: TokenType.Plus,
          value: '+',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '-':
        tokens.push({
          type: TokenType.Minus,
          value: '-',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '*':
        tokens.push({
          type: TokenType.Star,
          value: '*',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '/':
        if (peek() === '/') {
          // Single-line comment
          while (current < source.length && peek() !== '\n') {
            advance();
          }
        } else if (peek() === '*') {
          // Multi-line comment
          advance(); // consume '*'
          while (current < source.length) {
            if (
              peek() === '*' &&
              current + 1 < source.length &&
              source[current + 1] === '/'
            ) {
              advance(); // consume '*'
              advance(); // consume '/'
              break;
            }
            advance();
          }
        } else {
          tokens.push({
            type: TokenType.Slash,
            value: '/',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        }
        break;
      case '%':
        tokens.push({
          type: TokenType.Percent,
          value: '%',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '|':
        if (peek() === '|') {
          advance();
          tokens.push({
            type: TokenType.PipePipe,
            value: '||',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        } else {
          tokens.push({
            type: TokenType.Pipe,
            value: '|',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        }
        break;
      case '&':
        if (peek() === '&') {
          advance();
          tokens.push({
            type: TokenType.AmpersandAmpersand,
            value: '&&',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        } else {
          tokens.push({
            type: TokenType.Ampersand,
            value: '&',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        }
        break;
      case '^':
        tokens.push({
          type: TokenType.Caret,
          value: '^',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '?':
        tokens.push({
          type: TokenType.Question,
          value: '?',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '(':
        tokens.push({
          type: TokenType.LParen,
          value: '(',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case ')':
        tokens.push({
          type: TokenType.RParen,
          value: ')',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '{':
        // Track brace depth when inside template expression
        if (templateStack.length > 0) {
          templateStack[templateStack.length - 1]++;
        }
        tokens.push({
          type: TokenType.LBrace,
          value: '{',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '}':
        // Check if this closes a template expression
        if (
          templateStack.length > 0 &&
          templateStack[templateStack.length - 1] === 1
        ) {
          // Pop the template stack and continue scanning template
          templateStack.pop();
          // Capture position for the template part (after the closing brace)
          const templatePartLine = line;
          const templatePartColumn = column;
          const templatePartStart = startIndex;
          const template = scanTemplatePart(true);
          tokens.push({
            type: template.type,
            value: template.cooked,
            rawValue: template.raw,
            line: templatePartLine,
            column: templatePartColumn,
            start: templatePartStart,
            end: current,
          });
        } else {
          // Normal brace handling
          if (templateStack.length > 0) {
            templateStack[templateStack.length - 1]--;
          }
          tokens.push({
            type: TokenType.RBrace,
            value: '}',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        }
        break;
      case '[':
        tokens.push({
          type: TokenType.LBracket,
          value: '[',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case ']':
        tokens.push({
          type: TokenType.RBracket,
          value: ']',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case ':':
        tokens.push({
          type: TokenType.Colon,
          value: ':',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case ';':
        tokens.push({
          type: TokenType.Semi,
          value: ';',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case ',':
        tokens.push({
          type: TokenType.Comma,
          value: ',',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '.':
        if (peek() === '.' && peekNext() === '.') {
          advance();
          advance();
          tokens.push({
            type: TokenType.DotDotDot,
            value: '...',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        } else if (peek() === '.') {
          advance();
          tokens.push({
            type: TokenType.DotDot,
            value: '..',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        } else {
          tokens.push({
            type: TokenType.Dot,
            value: '.',
            line,
            column: startColumn,
            start: startIndex,
            end: current,
          });
        }
        break;
      case '#':
        tokens.push({
          type: TokenType.Hash,
          value: '#',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      case '@':
        tokens.push({
          type: TokenType.At,
          value: '@',
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
        break;
      default:
        tokens.push({
          type: TokenType.Unknown,
          value: c,
          line,
          column: startColumn,
          start: startIndex,
          end: current,
        });
    }
  }

  tokens.push({
    type: TokenType.EOF,
    value: '',
    line,
    column,
    start: current,
    end: current,
  });
  return tokens;
}
