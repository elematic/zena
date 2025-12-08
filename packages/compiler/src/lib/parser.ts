import {
  NodeType,
  type AccessorDeclaration,
  type AccessorSignature,
  type BindingProperty,
  type BlockStatement,
  type CallExpression,
  type ClassDeclaration,
  type ComputedPropertyName,
  type Decorator,
  type DeclareFunction,
  type Expression,
  type ExportAllDeclaration,
  type FieldDefinition,
  type ForStatement,
  type FunctionExpression,
  type Identifier,
  type IfExpression,
  type IfStatement,
  type ImportDeclaration,
  type ImportSpecifier,
  type IndexExpression,
  type InterfaceDeclaration,
  type IsExpression,
  type LiteralTypeAnnotation,
  type MatchCase,
  type MatchExpression,
  type MemberExpression,
  type MethodDefinition,
  type MethodSignature,
  type MixinDeclaration,
  type NamedTypeAnnotation,
  type Parameter,
  type Pattern,
  type Program,
  type PropertyAssignment,
  type PropertySignature,
  type RecordLiteral,
  type RecordPattern,
  type RecordTypeAnnotation,
  type ReturnStatement,
  type SourceLocation,
  type SpreadElement,
  type Statement,
  type StringLiteral,
  type TaggedTemplateExpression,
  type TemplateElement,
  type TemplateLiteral,
  type TupleLiteral,
  type TuplePattern,
  type TupleTypeAnnotation,
  type TypeAnnotation,
  type TypeParameter,
  type TypeAliasDeclaration,
  type VariableDeclaration,
  type WhileStatement,
} from './ast.js';
import {TokenType, tokenize, type Token} from './lexer.js';

export class Parser {
  #tokens: Token[];
  #current = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  public parse(): Program {
    const body: Statement[] = [];

    while (this.#check(TokenType.Import) || this.#check(TokenType.From)) {
      if (
        this.#check(TokenType.From) &&
        this.#peek(1).type !== TokenType.String
      ) {
        break;
      }
      body.push(this.#parseImportDeclaration());
    }

    while (!this.#isAtEnd()) {
      body.push(this.#parseStatement());
    }
    return {
      type: NodeType.Program,
      body,
      wellKnownTypes: {},
    };
  }

  #parseStatement(): Statement {
    const startToken = this.#peek();

    if (this.#check(TokenType.Import)) {
      throw new Error('Imports must appear at the top of the file.');
    }
    if (this.#check(TokenType.From)) {
      // Disambiguate `from "module" import ...` vs `from + 1`
      if (this.#peek(1).type === TokenType.String) {
        throw new Error('Imports must appear at the top of the file.');
      }
    }
    if (this.#check(TokenType.At)) {
      return this.#parseDecoratedStatement();
    }
    if (this.#match(TokenType.Declare)) {
      // Disambiguate `declare function` vs `declare + 1`
      if (this.#check(TokenType.Function)) {
        return this.#parseDeclareFunction(
          undefined,
          undefined,
          false,
          startToken,
        );
      }
      // Backtrack if not a declare function
      this.#current--;
    }
    if (this.#match(TokenType.Export)) {
      if (this.#match(TokenType.Star)) {
        this.#consume(TokenType.From, "Expected 'from' after '*'.");
        const sourceToken = this.#peek();
        if (sourceToken.type !== TokenType.String) {
          throw new Error("Expected string literal after 'from'.");
        }
        const moduleSpecifier = this.#parseExpression() as StringLiteral; // Reuse parseExpression or parseStringLiteral if available?
        // parseExpression parses string literal as StringLiteral node.
        this.#consume(TokenType.Semi, "Expected ';' after export declaration.");
        const endToken = this.#previous();
        return {
          type: NodeType.ExportAllDeclaration,
          moduleSpecifier,
          loc: this.#loc(startToken, endToken),
        } as ExportAllDeclaration;
      }
      if (this.#match(TokenType.Final)) {
        if (this.#match(TokenType.Extension)) {
          this.#consume(TokenType.Class, "Expected 'class' after 'extension'.");
          return this.#parseClassDeclaration(
            true,
            true,
            false,
            true,
            startToken,
          );
        }
        this.#consume(TokenType.Class, "Expected 'class' after 'final'.");
        return this.#parseClassDeclaration(
          true,
          true,
          false,
          false,
          startToken,
        );
      }
      if (this.#match(TokenType.Abstract)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'abstract'.");
        return this.#parseClassDeclaration(
          true,
          false,
          true,
          false,
          startToken,
        );
      }
      if (this.#match(TokenType.Extension)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'extension'.");
        return this.#parseClassDeclaration(
          true,
          false,
          false,
          true,
          startToken,
        );
      }
      if (this.#match(TokenType.Class)) {
        return this.#parseClassDeclaration(
          true,
          false,
          false,
          false,
          startToken,
        );
      }
      if (this.#match(TokenType.Interface)) {
        return this.#parseInterfaceDeclaration(true, startToken);
      }
      if (this.#match(TokenType.Mixin)) {
        return this.#parseMixinDeclaration(true, startToken);
      }
      if (this.#match(TokenType.Type) || this.#match(TokenType.Distinct)) {
        return this.#parseTypeAliasDeclaration(true, startToken);
      }
      if (this.#match(TokenType.Declare)) {
        return this.#parseDeclareFunction(
          undefined,
          undefined,
          true,
          startToken,
        );
      }
      return this.#parseVariableDeclaration(true, true, startToken);
    }
    if (this.#match(TokenType.Let) || this.#match(TokenType.Var)) {
      return this.#parseVariableDeclaration(false, true, startToken);
    }
    if (this.#match(TokenType.Return)) {
      return this.#parseReturnStatement();
    }
    if (this.#match(TokenType.If)) {
      return this.#parseIfStatement();
    }
    if (this.#match(TokenType.While)) {
      return this.#parseWhileStatement();
    }
    if (this.#match(TokenType.For)) {
      return this.#parseForStatement();
    }
    if (this.#match(TokenType.Final)) {
      // Disambiguate `final class` vs `final + 1`
      if (this.#check(TokenType.Class)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'final'.");
        return this.#parseClassDeclaration(
          false,
          true,
          false,
          false,
          startToken,
        );
      }
      this.#current--;
    }
    if (this.#match(TokenType.Abstract)) {
      // Disambiguate `abstract class` vs `abstract + 1`
      if (this.#check(TokenType.Class)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'abstract'.");
        return this.#parseClassDeclaration(
          false,
          false,
          true,
          false,
          startToken,
        );
      }
      this.#current--;
    }
    if (this.#match(TokenType.Extension)) {
      // Disambiguate `extension class` vs `extension + 1`
      if (this.#check(TokenType.Class)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'extension'.");
        return this.#parseClassDeclaration(
          false,
          false,
          false,
          true,
          startToken,
        );
      }
      this.#current--;
    }
    if (this.#match(TokenType.Class)) {
      return this.#parseClassDeclaration(
        false,
        false,
        false,
        false,
        startToken,
      );
    }
    if (this.#match(TokenType.Interface)) {
      return this.#parseInterfaceDeclaration(false, startToken);
    }
    if (this.#match(TokenType.Mixin)) {
      // Disambiguate `mixin Name` vs `mixin + 1`
      // Mixin declaration must be followed by identifier
      if (this.#isIdentifier(this.#peek().type)) {
        return this.#parseMixinDeclaration(false, startToken);
      }
      this.#current--;
    }
    if (this.#match(TokenType.Type)) {
      // Disambiguate `type Name =` vs `type + 1`
      // Type alias must be followed by identifier
      if (this.#isIdentifier(this.#peek().type)) {
        return this.#parseTypeAliasDeclaration(false, startToken);
      }
      this.#current--;
    }
    if (this.#match(TokenType.Distinct)) {
      // Disambiguate `distinct type` vs `distinct + 1`
      if (this.#check(TokenType.Type)) {
        return this.#parseTypeAliasDeclaration(false, startToken);
      }
      this.#current--;
    }
    if (this.#match(TokenType.LBrace)) {
      return this.#parseBlockStatement();
    }
    return this.#parseExpressionStatement();
  }

  #parseTypeAliasDeclaration(
    exported: boolean,
    startToken?: Token,
  ): TypeAliasDeclaration {
    const actualStartToken = startToken || this.#previous();
    let isDistinct = false;
    if (
      this.#check(TokenType.Distinct) ||
      this.#previous().type === TokenType.Distinct
    ) {
      if (this.#check(TokenType.Distinct)) this.#advance();
      this.#consume(TokenType.Type, "Expected 'type' after 'distinct'.");
      isDistinct = true;
    } else {
      // Already consumed 'type' in #parseStatement
    }

    const name = this.#parseIdentifier();
    const typeParameters = this.#parseTypeParameters();
    this.#consume(TokenType.Equals, "Expected '=' after type alias name.");
    const typeAnnotation = this.#parseTypeAnnotation();
    this.#consume(TokenType.Semi, "Expected ';' after type alias declaration.");
    const endToken = this.#previous();
    return {
      type: NodeType.TypeAliasDeclaration,
      name,
      typeParameters,
      typeAnnotation,
      exported,
      isDistinct,
      loc: this.#loc(actualStartToken, endToken),
    };
  }

  #parseVariableDeclaration(
    exported: boolean,
    consumeSemi: boolean = true,
    startToken?: Token,
  ): VariableDeclaration {
    let kindToken: Token;
    if (exported) {
      if (this.#match(TokenType.Let) || this.#match(TokenType.Var)) {
        kindToken = this.#previous();
      } else {
        throw new Error("Expected 'let' or 'var' after 'export'.");
      }
    } else {
      kindToken = this.#previous();
    }

    const actualStartToken = startToken || kindToken;

    const kind = kindToken.type === TokenType.Let ? 'let' : 'var';

    const pattern = this.#parsePattern();

    let typeAnnotation: TypeAnnotation | undefined;
    if (this.#match(TokenType.Colon)) {
      typeAnnotation = this.#parseTypeAnnotation();
    }

    this.#consume(TokenType.Equals, "Expected '=' after variable name.");
    const init = this.#parseExpression();
    if (consumeSemi) {
      this.#consume(TokenType.Semi, "Expected ';' after variable declaration.");
    }
    const endToken = this.#previous();

    return {
      type: NodeType.VariableDeclaration,
      kind,
      pattern,
      typeAnnotation,
      init,
      exported,
      loc: this.#loc(actualStartToken, endToken),
    };
  }

  #parsePattern(): Pattern {
    return this.#parseLogicalOrPattern();
  }

  #parseLogicalOrPattern(): Pattern {
    let left = this.#parseLogicalAndPattern();
    while (this.#match(TokenType.Pipe)) {
      const right = this.#parseLogicalAndPattern();
      left = {
        type: NodeType.LogicalPattern,
        operator: '||',
        left,
        right,
        loc: this.#loc(left, right),
      };
    }
    return left;
  }

  #parseLogicalAndPattern(): Pattern {
    let left = this.#parseAsPattern();
    while (this.#match(TokenType.Ampersand)) {
      const right = this.#parseAsPattern();
      left = {
        type: NodeType.LogicalPattern,
        operator: '&&',
        left,
        right,
        loc: this.#loc(left, right),
      };
    }
    return left;
  }

  #parseAsPattern(): Pattern {
    const pattern = this.#parsePrimaryPattern();
    if (this.#match(TokenType.As)) {
      const name = this.#parseIdentifier();
      return {
        type: NodeType.AsPattern,
        pattern,
        name,
        loc: this.#loc(pattern, name),
      };
    }
    return pattern;
  }

  #parsePrimaryPattern(): Pattern {
    let pattern: Pattern;
    if (this.#match(TokenType.Number)) {
      const token = this.#previous();
      pattern = {
        type: NodeType.NumberLiteral,
        value: Number(token.value),
        raw: token.value,
        loc: this.#locFromToken(token),
      };
    } else if (this.#match(TokenType.String)) {
      const token = this.#previous();
      pattern = {
        type: NodeType.StringLiteral,
        value: token.value,
        loc: this.#locFromToken(token),
      };
    } else if (this.#match(TokenType.True)) {
      const token = this.#previous();
      pattern = {
        type: NodeType.BooleanLiteral,
        value: true,
        loc: this.#locFromToken(token),
      };
    } else if (this.#match(TokenType.False)) {
      const token = this.#previous();
      pattern = {
        type: NodeType.BooleanLiteral,
        value: false,
        loc: this.#locFromToken(token),
      };
    } else if (this.#match(TokenType.Null)) {
      const token = this.#previous();
      pattern = {type: NodeType.NullLiteral, loc: this.#locFromToken(token)};
    } else if (this.#match(TokenType.LBrace)) {
      pattern = this.#parseRecordPattern();
    } else if (this.#match(TokenType.LBracket)) {
      pattern = this.#parseTuplePattern();
    } else if (this.#match(TokenType.LParen)) {
      pattern = this.#parsePattern();
      this.#consume(TokenType.RParen, "Expected ')' after pattern.");
    } else if (this.#isIdentifier(this.#peek().type)) {
      const identifier = this.#parseIdentifier();

      if (this.#match(TokenType.LBrace)) {
        const recordPattern = this.#parseRecordPattern();
        pattern = {
          type: NodeType.ClassPattern,
          name: identifier,
          properties: recordPattern.properties,
          loc: this.#loc(identifier, recordPattern),
        };
      } else {
        pattern = identifier;
      }
    } else {
      throw new Error(`Expected pattern, got ${this.#peek().type}`);
    }

    return pattern;
  }

  #convertIdentifierToClassPattern(pattern: Pattern): Pattern {
    if (pattern.type === NodeType.Identifier) {
      if (pattern.name === '_') return pattern;
      return {
        type: NodeType.ClassPattern,
        name: pattern,
        properties: [],
        loc: pattern.loc,
      };
    }
    if (pattern.type === NodeType.AsPattern) {
      return {
        ...pattern,
        pattern: this.#convertIdentifierToClassPattern(pattern.pattern),
      };
    }
    return pattern;
  }

  #parseRecordPattern(): RecordPattern {
    const properties: BindingProperty[] = [];
    if (!this.#check(TokenType.RBrace)) {
      do {
        const name = this.#parseIdentifier();
        let value: Pattern = name;

        if (this.#match(TokenType.As)) {
          value = this.#parseIdentifier();
        } else if (this.#match(TokenType.Colon)) {
          value = this.#parsePattern();
          value = this.#convertIdentifierToClassPattern(value);
        }

        if (this.#match(TokenType.Equals)) {
          const defaultValue = this.#parseExpression();
          value = {
            type: NodeType.AssignmentPattern,
            left: value,
            right: defaultValue,
          };
        }

        properties.push({
          type: NodeType.BindingProperty,
          name,
          value,
        });
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBrace, "Expected '}' after record pattern.");
    return {
      type: NodeType.RecordPattern,
      properties,
    };
  }

  #parseTuplePattern(): TuplePattern {
    const elements: (Pattern | null)[] = [];
    if (!this.#check(TokenType.RBracket)) {
      do {
        if (this.#check(TokenType.Comma) || this.#check(TokenType.RBracket)) {
          // Empty element (skipping)
          elements.push(null);
        } else {
          let pattern = this.#parsePattern();
          if (this.#match(TokenType.Equals)) {
            const defaultValue = this.#parseExpression();
            pattern = {
              type: NodeType.AssignmentPattern,
              left: pattern,
              right: defaultValue,
            };
          }
          elements.push(pattern);
        }
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBracket, "Expected ']' after tuple pattern.");
    return {
      type: NodeType.TuplePattern,
      elements,
    };
  }

  #parseExpressionStatement(): Statement {
    const startToken = this.#peek();
    const expression = this.#parseExpression();
    this.#consume(TokenType.Semi, "Expected ';' after expression.");
    const endToken = this.#previous();
    return {
      type: NodeType.ExpressionStatement,
      expression,
      loc: this.#loc(startToken, endToken),
    };
  }

  #parseExpression(): Expression {
    return this.#parseAssignment();
  }

  #parseAssignment(): Expression {
    const expr = this.#parseArrowFunction();

    if (this.#match(TokenType.Equals)) {
      const value = this.#parseAssignment();
      if (
        expr.type === NodeType.Identifier ||
        expr.type === NodeType.MemberExpression ||
        expr.type === NodeType.IndexExpression
      ) {
        return {
          type: NodeType.AssignmentExpression,
          left: expr as Identifier | MemberExpression | IndexExpression,
          value,
          loc: this.#loc(expr, value),
        };
      }
      throw new Error('Invalid assignment target.');
    }

    return expr;
  }

  #parseArrowFunction(): Expression {
    // We only support parenthesized parameter lists for arrow functions:
    // () => ...
    // (a: i32) => ...
    // (a: i32, b: i32) => ...
    // <T>(a: T) => ...

    if (this.#check(TokenType.Less)) {
      return this.#parseArrowFunctionDefinition();
    }

    if (this.#check(TokenType.LParen)) {
      // Lookahead to distinguish between parenthesized expression and arrow function

      // Case 1: () => ... or (): Type => ...
      if (this.#peek(1).type === TokenType.RParen) {
        if (
          this.#peek(2).type === TokenType.Arrow ||
          this.#peek(2).type === TokenType.Colon
        ) {
          return this.#parseArrowFunctionDefinition();
        }
      }

      // Case 2: (param: type ... or (param?: type ...
      // If we see ( identifier :, it must be an arrow function parameter list
      if (
        this.#isIdentifier(this.#peek(1).type) &&
        (this.#peek(2).type === TokenType.Colon ||
          (this.#peek(2).type === TokenType.Question &&
            this.#peek(3).type === TokenType.Colon))
      ) {
        return this.#parseArrowFunctionDefinition();
      }
    }

    return this.#parseLogicalOr();
  }

  #parseArrowFunctionDefinition(): FunctionExpression {
    const startToken = this.#peek();
    const typeParameters = this.#parseTypeParameters();
    this.#consume(TokenType.LParen, "Expected '('");
    const params: Parameter[] = [];
    if (!this.#check(TokenType.RParen)) {
      let seenOptional = false;
      do {
        const name = this.#parseIdentifier();
        let optional = false;
        if (this.#match(TokenType.Question)) {
          optional = true;
          seenOptional = true;
        }

        this.#consume(TokenType.Colon, "Expected ':' for type annotation");
        const typeAnnotation = this.#parseTypeAnnotation();

        let initializer: Expression | undefined;
        if (this.#match(TokenType.Equals)) {
          initializer = this.#parseExpression();
          optional = true;
          seenOptional = true;
        }

        if (!optional && seenOptional) {
          throw new Error(
            'Required parameter cannot follow an optional parameter.',
          );
        }

        params.push({
          type: NodeType.Parameter,
          name,
          typeAnnotation,
          optional,
          initializer,
        });
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RParen, "Expected ')'");

    // Optional return type
    let returnType: TypeAnnotation | undefined;
    if (this.#match(TokenType.Colon)) {
      returnType = this.#parseTypeAnnotation();
    }

    this.#consume(TokenType.Arrow, "Expected '=>'");

    let body: Expression | BlockStatement;
    if (this.#match(TokenType.LBrace)) {
      body = this.#parseBlockStatement();
    } else {
      body = this.#parseExpression();
    }

    return {
      type: NodeType.FunctionExpression,
      typeParameters,
      params,
      returnType,
      body,
      loc: this.#loc(startToken, body),
    };
  }

  #parseLogicalOr(): Expression {
    let left = this.#parseLogicalAnd();

    while (this.#match(TokenType.PipePipe)) {
      const operator = this.#previous().value;
      const right = this.#parseLogicalAnd();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseLogicalAnd(): Expression {
    let left = this.#parseBitwiseOr();

    while (this.#match(TokenType.AmpersandAmpersand)) {
      const operator = this.#previous().value;
      const right = this.#parseBitwiseOr();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseBitwiseOr(): Expression {
    let left = this.#parseBitwiseXor();

    while (this.#match(TokenType.Pipe)) {
      const operator = this.#previous().value;
      const right = this.#parseBitwiseXor();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseBitwiseXor(): Expression {
    let left = this.#parseBitwiseAnd();

    while (this.#match(TokenType.Caret)) {
      const operator = this.#previous().value;
      const right = this.#parseBitwiseAnd();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseBitwiseAnd(): Expression {
    let left = this.#parseEquality();

    while (this.#match(TokenType.Ampersand)) {
      const operator = this.#previous().value;
      const right = this.#parseEquality();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseEquality(): Expression {
    let left = this.#parseComparison();

    while (
      this.#match(
        TokenType.EqualsEquals,
        TokenType.BangEquals,
        TokenType.EqualsEqualsEquals,
        TokenType.BangEqualsEquals,
      )
    ) {
      const operator = this.#previous().value;
      const right = this.#parseComparison();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseComparison(): Expression {
    let left = this.#parseAs();

    while (
      this.#match(
        TokenType.Less,
        TokenType.LessEquals,
        TokenType.Greater,
        TokenType.GreaterEquals,
      )
    ) {
      const operator = this.#previous().value;
      const right = this.#parseAs();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseAs(): Expression {
    let left = this.#parseTerm();

    while (this.#match(TokenType.As) || this.#match(TokenType.Is)) {
      const operator = this.#previous().type;
      const typeAnnotation = this.#parseTypeAnnotation();
      if (operator === TokenType.As) {
        left = {
          type: NodeType.AsExpression,
          expression: left,
          typeAnnotation,
          loc: this.#loc(left, typeAnnotation),
        } as unknown as Expression; // Cast to Expression to avoid circular type issues if any, or just let it infer
      } else {
        left = {
          type: NodeType.IsExpression,
          expression: left,
          typeAnnotation,
          loc: this.#loc(left, typeAnnotation),
        } as IsExpression;
      }
    }

    return left;
  }

  #parseTerm(): Expression {
    let left = this.#parseFactor();

    while (this.#match(TokenType.Plus, TokenType.Minus)) {
      const operator = this.#previous().value;
      const right = this.#parseFactor();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseFactor(): Expression {
    let left = this.#parseUnary();

    while (this.#match(TokenType.Star, TokenType.Slash, TokenType.Percent)) {
      const operator = this.#previous().value;
      const right = this.#parseUnary();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
  }

  #parseUnary(): Expression {
    if (this.#match(TokenType.Bang, TokenType.Minus)) {
      const operator = this.#previous().value;
      const startToken = this.#previous();
      const argument = this.#parseUnary();
      return {
        type: NodeType.UnaryExpression,
        operator,
        argument,
        prefix: true,
        loc: this.#loc(startToken, argument),
      };
    }

    if (this.#check(TokenType.Throw)) {
      const next = this.#peek(1).type;
      if (
        next !== TokenType.RParen &&
        next !== TokenType.RBrace &&
        next !== TokenType.RBracket &&
        next !== TokenType.Comma &&
        next !== TokenType.Semi &&
        next !== TokenType.EOF &&
        next !== TokenType.Dot
      ) {
        this.#advance();
        const startToken = this.#previous();
        const argument = this.#parseExpression();
        return {
          type: NodeType.ThrowExpression,
          argument,
          loc: this.#loc(startToken, argument),
        };
      }
    }

    return this.#parseCall();
  }

  #parseCall(): Expression {
    if (this.#match(TokenType.New)) {
      const startToken = this.#previous();
      const callee = this.#parseIdentifier();
      const typeArguments = this.#parseTypeArguments();
      this.#consume(TokenType.LParen, "Expected '(' after class name.");
      const args: Expression[] = [];
      if (!this.#check(TokenType.RParen)) {
        do {
          args.push(this.#parseExpression());
        } while (this.#match(TokenType.Comma));
      }
      this.#consume(TokenType.RParen, "Expected ')' after arguments.");
      const endToken = this.#previous();

      let expr: Expression = {
        type: NodeType.NewExpression,
        callee,
        typeArguments,
        arguments: args,
        loc: this.#loc(startToken, endToken),
      };

      while (true) {
        if (this.#match(TokenType.Dot)) {
          let property: Identifier;
          if (this.#match(TokenType.Hash)) {
            const id = this.#parseIdentifier();
            property = {
              type: NodeType.Identifier,
              name: '#' + id.name,
              loc: id.loc,
            };
          } else if (this.#match(TokenType.New)) {
            const token = this.#previous();
            property = {
              type: NodeType.Identifier,
              name: 'new',
              loc: this.#locFromToken(token),
            };
          } else {
            property = this.#parseIdentifier();
          }
          expr = {
            type: NodeType.MemberExpression,
            object: expr,
            property,
            loc: this.#loc(expr, property),
          };
        } else {
          break;
        }
      }
      return expr;
    }

    let expr = this.#parsePrimary();

    while (true) {
      if (this.#match(TokenType.LParen)) {
        expr = this.#finishCall(expr);
      } else if (this.#match(TokenType.Dot)) {
        let property: Identifier;
        if (this.#match(TokenType.Hash)) {
          const id = this.#parseIdentifier();
          property = {
            type: NodeType.Identifier,
            name: '#' + id.name,
            loc: id.loc,
          };
        } else if (this.#match(TokenType.New)) {
          const token = this.#previous();
          property = {
            type: NodeType.Identifier,
            name: 'new',
            loc: this.#locFromToken(token),
          };
        } else {
          property = this.#parseIdentifier();
        }
        expr = {
          type: NodeType.MemberExpression,
          object: expr,
          property,
          loc: this.#loc(expr, property),
        };
      } else if (this.#match(TokenType.LBracket)) {
        const index = this.#parseExpression();
        this.#consume(TokenType.RBracket, "Expected ']' after index.");
        const endToken = this.#previous();
        expr = {
          type: NodeType.IndexExpression,
          object: expr,
          index,
          loc: this.#loc(expr, endToken),
        };
      } else if (this.#check(TokenType.Less) && this.#isGenericCall()) {
        const typeArguments = this.#parseTypeArguments();
        this.#consume(TokenType.LParen, "Expected '(' after type arguments.");
        expr = this.#finishCall(expr, typeArguments);
      } else if (this.#isTemplateStart()) {
        // Tagged template expression: tag`template`
        const quasi = this.#parseTemplateLiteral();
        expr = {
          type: NodeType.TaggedTemplateExpression,
          tag: expr,
          quasi,
          loc: this.#loc(expr, quasi),
        } as TaggedTemplateExpression;
      } else {
        break;
      }
    }

    return expr;
  }

  #isGenericCall(): boolean {
    let depth = 0;
    let i = 0;
    if (this.#peek(i).type !== TokenType.Less) return false;
    i++;
    depth++;

    while (depth > 0 && this.#peek(i).type !== TokenType.EOF) {
      const type = this.#peek(i).type;
      if (type === TokenType.Less) {
        depth++;
      } else if (type === TokenType.Greater) {
        depth--;
      } else if (type === TokenType.GreaterEquals) {
        // Treat >= as > followed by =? No, just assume it's not part of valid type args for now
        // or if it closes the generic?
        // In `List<T>=`, >= is GreaterEquals.
        // But we are looking for `> (`.
        // If we encounter GreaterEquals, it's likely a comparison, so not a generic call.
        return false;
      } else if (
        type === TokenType.Semi ||
        type === TokenType.LBrace ||
        type === TokenType.RBrace ||
        type === TokenType.RParen
      ) {
        // Optimization: these tokens shouldn't appear in type args (except nested generics)
        // If we see them at top level of scan, abort.
        // But we might be inside `Map<K, V>`.
        // Just rely on depth.
      }
      i++;
    }

    if (depth === 0 && this.#peek(i).type === TokenType.LParen) {
      return true;
    }
    return false;
  }

  #finishCall(
    callee: Expression,
    typeArguments?: TypeAnnotation[],
  ): CallExpression {
    const args: Expression[] = [];
    if (!this.#check(TokenType.RParen)) {
      do {
        args.push(this.#parseExpression());
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RParen, "Expected ')' after arguments.");
    const endToken = this.#previous();

    return {
      type: NodeType.CallExpression,
      callee,
      typeArguments,
      arguments: args,
      loc: this.#loc(callee, endToken),
    };
  }

  #parsePrimary(): Expression {
    if (this.#match(TokenType.Super)) {
      const token = this.#previous();
      return {type: NodeType.SuperExpression, loc: this.#locFromToken(token)};
    }
    if (this.#match(TokenType.This)) {
      const token = this.#previous();
      return {type: NodeType.ThisExpression, loc: this.#locFromToken(token)};
    }
    if (
      this.#check(TokenType.Match) &&
      this.#peek(1).type === TokenType.LParen
    ) {
      this.#advance();
      return this.#parseMatchExpression();
    }
    if (this.#match(TokenType.If)) {
      return this.#parseIfExpression();
    }
    if (this.#match(TokenType.Hash)) {
      const startToken = this.#previous();
      if (this.#match(TokenType.LBracket)) {
        const elements: Expression[] = [];
        if (!this.#check(TokenType.RBracket)) {
          do {
            elements.push(this.#parseExpression());
          } while (this.#match(TokenType.Comma));
        }
        this.#consume(TokenType.RBracket, "Expected ']' after array elements.");
        const endToken = this.#previous();
        return {
          type: NodeType.ArrayLiteral,
          elements,
          loc: this.#locFromRange(startToken, endToken),
        };
      }
      throw new Error("Expected '[' after '#'.");
    }
    if (this.#match(TokenType.Number)) {
      const token = this.#previous();
      return {
        type: NodeType.NumberLiteral,
        value: Number(token.value),
        raw: token.value,
        loc: this.#locFromToken(token),
      };
    }
    if (this.#match(TokenType.String)) {
      const token = this.#previous();
      return {
        type: NodeType.StringLiteral,
        value: token.value,
        loc: this.#locFromToken(token),
      };
    }
    if (this.#match(TokenType.True)) {
      const token = this.#previous();
      return {
        type: NodeType.BooleanLiteral,
        value: true,
        loc: this.#locFromToken(token),
      };
    }
    if (this.#match(TokenType.False)) {
      const token = this.#previous();
      return {
        type: NodeType.BooleanLiteral,
        value: false,
        loc: this.#locFromToken(token),
      };
    }
    if (this.#match(TokenType.Null)) {
      const token = this.#previous();
      return {type: NodeType.NullLiteral, loc: this.#locFromToken(token)};
    }
    if (this.#isIdentifier(this.#peek().type)) {
      return this.#parseIdentifier();
    }
    if (this.#match(TokenType.LBrace)) {
      return this.#parseRecordLiteral();
    }
    if (this.#match(TokenType.LBracket)) {
      return this.#parseTupleLiteral();
    }
    if (this.#match(TokenType.LParen)) {
      const expr = this.#parseExpression();
      this.#consume(TokenType.RParen, "Expected ')' after expression.");
      return expr;
    }
    // Template literals (untagged)
    if (this.#isTemplateStart()) {
      return this.#parseTemplateLiteral();
    }

    throw new Error(
      `Unexpected token: ${this.#peek().type} at line ${this.#peek().line}`,
    );
  }

  #parseMatchExpression(): MatchExpression {
    const startToken = this.#previous();
    this.#consume(TokenType.LParen, "Expected '(' after 'match'.");
    const discriminant = this.#parseExpression();
    this.#consume(TokenType.RParen, "Expected ')' after match discriminant.");
    this.#consume(TokenType.LBrace, "Expected '{' before match cases.");

    const cases: MatchCase[] = [];
    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      cases.push(this.#parseMatchCase());
    }
    this.#consume(TokenType.RBrace, "Expected '}' after match cases.");
    const endToken = this.#previous();

    return {
      type: NodeType.MatchExpression,
      discriminant,
      cases,
      loc: this.#loc(startToken, endToken),
    };
  }

  #parseMatchCase(): MatchCase {
    this.#consume(TokenType.Case, "Expected 'case'.");
    const startToken = this.#previous();
    const pattern = this.#parseMatchPattern();

    let guard: Expression | undefined;
    if (this.#match(TokenType.If)) {
      guard = this.#parseExpression();
    }

    this.#consume(TokenType.Colon, "Expected ':' after case pattern.");

    let body: Expression | BlockStatement;
    if (this.#match(TokenType.LBrace)) {
      body = this.#parseBlockAsExpression();
    } else {
      body = this.#parseExpression();
    }

    return {
      type: NodeType.MatchCase,
      pattern,
      guard,
      body,
      loc: this.#loc(startToken, body),
    };
  }

  #parseMatchPattern(): Pattern {
    return this.#parsePattern();
  }

  #parseIfExpression(): IfExpression {
    const startToken = this.#previous();
    this.#consume(TokenType.LParen, "Expected '(' after 'if'.");
    const test = this.#parseExpression();
    this.#consume(TokenType.RParen, "Expected ')' after if condition.");

    let consequent: Expression | BlockStatement;
    if (this.#match(TokenType.LBrace)) {
      consequent = this.#parseBlockAsExpression();
    } else {
      consequent = this.#parseExpression();
    }

    this.#consume(
      TokenType.Else,
      "Expected 'else' after consequent in if expression.",
    );

    let alternate: Expression | BlockStatement;
    if (this.#match(TokenType.LBrace)) {
      alternate = this.#parseBlockAsExpression();
    } else if (this.#check(TokenType.If)) {
      // else if
      this.#advance();
      alternate = this.#parseIfExpression();
    } else {
      alternate = this.#parseExpression();
    }

    return {
      type: NodeType.IfExpression,
      test,
      consequent,
      alternate,
      loc: this.#loc(startToken, alternate),
    };
  }

  /**
   * Parse a block where the last item can be an expression (without semicolon).
   * Used for if expressions, match case bodies, etc.
   */
  #parseBlockAsExpression(): BlockStatement {
    const startToken = this.#previous();
    const body: Statement[] = [];

    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      // Check for keywords that definitely start statements
      if (
        this.#check(TokenType.Let) ||
        this.#check(TokenType.Var) ||
        this.#check(TokenType.Return) ||
        this.#check(TokenType.While) ||
        this.#check(TokenType.For) ||
        this.#check(TokenType.Class) ||
        this.#check(TokenType.Interface) ||
        this.#check(TokenType.Mixin)
      ) {
        body.push(this.#parseStatement());
        continue;
      }

      // If we're at a semicolon, parse the statement
      if (this.#check(TokenType.Semi)) {
        body.push(this.#parseStatement());
        continue;
      }

      // Try to parse as expression
      const expr = this.#parseExpression();

      // If next token is '}', this is the trailing expression (no semicolon needed)
      if (this.#check(TokenType.RBrace)) {
        body.push({
          type: NodeType.ExpressionStatement,
          expression: expr,
          loc: expr.loc,
        });
        break;
      }

      // Otherwise, we expect a semicolon (it's a regular expression statement)
      this.#consume(TokenType.Semi, "Expected ';' after expression.");
      body.push({
        type: NodeType.ExpressionStatement,
        expression: expr,
        loc: expr.loc,
      });
    }

    this.#consume(TokenType.RBrace, "Expected '}' after block.");
    const endToken = this.#previous();
    return {
      type: NodeType.BlockStatement,
      body,
      loc: this.#loc(startToken, endToken),
    };
  }

  #isTemplateStart(): boolean {
    const type = this.#peek().type;
    return (
      type === TokenType.NoSubstitutionTemplate ||
      type === TokenType.TemplateHead
    );
  }

  #parseTemplateLiteral(): TemplateLiteral {
    const startToken = this.#peek();
    const quasis: TemplateElement[] = [];
    const expressions: Expression[] = [];

    if (this.#match(TokenType.NoSubstitutionTemplate)) {
      const token = this.#previous();
      quasis.push({
        type: NodeType.TemplateElement,
        value: {
          cooked: token.value,
          raw: token.rawValue ?? token.value,
        },
        tail: true,
        loc: this.#locFromToken(token),
      });
      return {
        type: NodeType.TemplateLiteral,
        quasis,
        expressions,
        loc: this.#locFromToken(token),
      };
    }

    // Must be a TemplateHead (template with interpolation like `prefix ${)
    this.#consume(
      TokenType.TemplateHead,
      'Expected template literal with interpolation (starting with backtick and containing ${)',
    );
    const headToken = this.#previous();
    quasis.push({
      type: NodeType.TemplateElement,
      value: {
        cooked: headToken.value,
        raw: headToken.rawValue ?? headToken.value,
      },
      tail: false,
      loc: this.#locFromToken(headToken),
    });

    // Parse expressions and middle parts
    while (!this.#isAtEnd()) {
      // Parse the expression inside ${}
      expressions.push(this.#parseExpression());

      // After expression, we should see TemplateMiddle or TemplateTail
      if (this.#match(TokenType.TemplateTail)) {
        const tailToken = this.#previous();
        quasis.push({
          type: NodeType.TemplateElement,
          value: {
            cooked: tailToken.value,
            raw: tailToken.rawValue ?? tailToken.value,
          },
          tail: true,
          loc: this.#locFromToken(tailToken),
        });
        break;
      }

      if (this.#match(TokenType.TemplateMiddle)) {
        const middleToken = this.#previous();
        quasis.push({
          type: NodeType.TemplateElement,
          value: {
            cooked: middleToken.value,
            raw: middleToken.rawValue ?? middleToken.value,
          },
          tail: false,
          loc: this.#locFromToken(middleToken),
        });
        continue;
      }

      throw new Error(
        `Expected template middle or tail, got ${this.#peek().type}`,
      );
    }

    const endToken = this.#previous();

    return {
      type: NodeType.TemplateLiteral,
      quasis,
      expressions,
      loc: this.#loc(startToken, endToken),
    };
  }

  #isIdentifier(type: TokenType): boolean {
    return (
      type === TokenType.Identifier ||
      type === TokenType.From ||
      type === TokenType.Type ||
      type === TokenType.As ||
      type === TokenType.Is ||
      type === TokenType.On ||
      type === TokenType.Abstract ||
      type === TokenType.Declare ||
      type === TokenType.Mixin ||
      type === TokenType.Operator ||
      type === TokenType.Static ||
      type === TokenType.Extension ||
      type === TokenType.Distinct ||
      type === TokenType.Final ||
      type === TokenType.Extends ||
      type === TokenType.Implements ||
      type === TokenType.With ||
      type === TokenType.Case ||
      type === TokenType.Match ||
      type === TokenType.Throw
    );
  }

  #parseIdentifier(): Identifier {
    if (this.#isIdentifier(this.#peek().type)) {
      const token = this.#advance();
      return {
        type: NodeType.Identifier,
        name: token.value,
        loc: this.#locFromToken(token),
      };
    }
    throw new Error(`Expected identifier, got ${this.#peek().type}`);
  }

  #parseReturnStatement(): ReturnStatement {
    const startToken = this.#previous();
    let argument: Expression | undefined;
    if (!this.#check(TokenType.Semi)) {
      argument = this.#parseExpression();
    }
    this.#consume(TokenType.Semi, "Expected ';' after return value.");
    const endToken = this.#previous();
    return {
      type: NodeType.ReturnStatement,
      argument,
      loc: this.#loc(startToken, endToken),
    };
  }

  #parseIfStatement(): IfStatement {
    const startToken = this.#previous();
    this.#consume(TokenType.LParen, "Expected '(' after 'if'.");
    const test = this.#parseExpression();
    this.#consume(TokenType.RParen, "Expected ')' after if condition.");

    const consequent = this.#parseStatement();
    let alternate: Statement | undefined;

    if (this.#match(TokenType.Else)) {
      alternate = this.#parseStatement();
    }

    return {
      type: NodeType.IfStatement,
      test,
      consequent,
      alternate,
      loc: this.#loc(startToken, alternate || consequent),
    };
  }

  #parseWhileStatement(): WhileStatement {
    const startToken = this.#previous();
    this.#consume(TokenType.LParen, "Expected '(' after 'while'.");
    const test = this.#parseExpression();
    this.#consume(TokenType.RParen, "Expected ')' after while condition.");

    const body = this.#parseStatement();

    return {
      type: NodeType.WhileStatement,
      test,
      body,
      loc: this.#loc(startToken, body),
    };
  }

  #parseForStatement(): ForStatement {
    const startToken = this.#previous();
    this.#consume(TokenType.LParen, "Expected '(' after 'for'.");

    // Parse init (optional variable declaration or expression)
    let init: VariableDeclaration | Expression | undefined;
    if (!this.#check(TokenType.Semi)) {
      if (this.#match(TokenType.Let) || this.#match(TokenType.Var)) {
        // Variable declaration - don't consume the semicolon
        init = this.#parseVariableDeclaration(false, false);
        this.#consume(TokenType.Semi, "Expected ';' after for initializer.");
      } else {
        init = this.#parseExpression();
        this.#consume(TokenType.Semi, "Expected ';' after for initializer.");
      }
    } else {
      this.#consume(TokenType.Semi, "Expected ';' in for statement.");
    }

    // Parse test (optional)
    let test: Expression | undefined;
    if (!this.#check(TokenType.Semi)) {
      test = this.#parseExpression();
    }
    this.#consume(TokenType.Semi, "Expected ';' after for condition.");

    // Parse update (optional)
    let update: Expression | undefined;
    if (!this.#check(TokenType.RParen)) {
      update = this.#parseExpression();
    }
    this.#consume(TokenType.RParen, "Expected ')' after for clauses.");

    const body = this.#parseStatement();

    return {
      type: NodeType.ForStatement,
      init,
      test,
      update,
      body,
      loc: this.#loc(startToken, body),
    };
  }

  #parseClassDeclaration(
    exported: boolean,
    isFinal: boolean = false,
    isAbstract: boolean = false,
    isExtension: boolean = false,
    startToken?: Token,
  ): ClassDeclaration {
    const actualStartToken = startToken || this.#previous();
    const name = this.#parseIdentifier();
    const typeParameters = this.#parseTypeParameters();

    let onType: TypeAnnotation | undefined;
    if (isExtension) {
      this.#consume(
        TokenType.On,
        "Expected 'on' in extension class declaration.",
      );
      onType = this.#parseTypeAnnotation();
    }

    let superClass: Identifier | undefined;
    if (this.#match(TokenType.Extends)) {
      if (isExtension) {
        throw new Error('Extension classes cannot extend other classes.');
      }
      superClass = this.#parseIdentifier();
    }

    const mixins: Identifier[] = [];
    if (this.#match(TokenType.With)) {
      do {
        mixins.push(this.#parseIdentifier());
      } while (this.#match(TokenType.Comma));
    }

    const implementsList: TypeAnnotation[] = [];
    if (this.#match(TokenType.Implements)) {
      do {
        implementsList.push(this.#parseTypeAnnotation());
      } while (this.#match(TokenType.Comma));
    }

    this.#consume(TokenType.LBrace, "Expected '{' before class body.");

    const body: (FieldDefinition | MethodDefinition | AccessorDeclaration)[] =
      [];
    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      body.push(this.#parseClassMember());
    }

    this.#consume(TokenType.RBrace, "Expected '}' after class body.");
    const endToken = this.#previous();

    return {
      type: NodeType.ClassDeclaration,
      name,
      typeParameters,
      superClass,
      mixins: mixins.length > 0 ? mixins : undefined,
      implements: implementsList.length > 0 ? implementsList : undefined,
      body,
      exported,
      isFinal,
      isAbstract,
      isExtension,
      onType,
      loc: this.#loc(actualStartToken, endToken),
    };
  }

  #parseMixinDeclaration(
    exported: boolean,
    startToken?: Token,
  ): MixinDeclaration {
    const actualStartToken = startToken || this.#previous();
    const name = this.#parseIdentifier();
    const typeParameters = this.#parseTypeParameters();

    let on: Identifier | undefined;
    if (this.#match(TokenType.On)) {
      on = this.#parseIdentifier();
    }

    const mixins: Identifier[] = [];
    if (this.#match(TokenType.With)) {
      do {
        mixins.push(this.#parseIdentifier());
      } while (this.#match(TokenType.Comma));
    }

    this.#consume(TokenType.LBrace, "Expected '{' before mixin body.");

    const body: (FieldDefinition | MethodDefinition | AccessorDeclaration)[] =
      [];
    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      body.push(this.#parseClassMember());
    }

    this.#consume(TokenType.RBrace, "Expected '}' after mixin body.");
    const endToken = this.#previous();

    return {
      type: NodeType.MixinDeclaration,
      name,
      typeParameters,
      on,
      mixins: mixins.length > 0 ? mixins : undefined,
      body,
      exported,
      loc: this.#loc(actualStartToken, endToken),
    };
  }

  #parseClassMember():
    | FieldDefinition
    | MethodDefinition
    | AccessorDeclaration {
    const startToken = this.#peek();
    const decorators: Decorator[] = [];
    while (this.#check(TokenType.At)) {
      decorators.push(this.#parseDecorator());
    }

    let isDeclare = false;
    if (this.#check(TokenType.Declare)) {
      // Disambiguate `declare name` vs `declare` as name
      // If declare is followed by identifier, it's a modifier.
      // But wait, `declare` can be a field name too.
      // `declare: i32;`
      // If it's a modifier, it should be followed by `static`, `final`, `abstract`, or name.
      // If it's a name, it's followed by `(` or `:`.
      // But `declare` is optional.
      // If we have `declare x: i32`, is it `declare` modifier on `x`? Yes.
      // If we have `declare: i32`, is it field named `declare`? Yes.
      // So if next token is `:` or `(`, `declare` is the name.
      if (
        this.#peek(1).type !== TokenType.Colon &&
        this.#peek(1).type !== TokenType.LParen &&
        this.#peek(1).type !== TokenType.Less
      ) {
        this.#advance();
        isDeclare = true;
      }
    }

    let isStatic = false;
    if (this.#check(TokenType.Static)) {
      if (
        this.#peek(1).type !== TokenType.Colon &&
        this.#peek(1).type !== TokenType.LParen &&
        this.#peek(1).type !== TokenType.Less
      ) {
        this.#advance();
        isStatic = true;
      }
    }

    let isFinal = false;
    if (this.#check(TokenType.Final)) {
      if (
        this.#peek(1).type !== TokenType.Colon &&
        this.#peek(1).type !== TokenType.LParen &&
        this.#peek(1).type !== TokenType.Less
      ) {
        this.#advance();
        isFinal = true;
      }
    }

    let isAbstract = false;
    if (this.#check(TokenType.Abstract)) {
      if (
        this.#peek(1).type !== TokenType.Colon &&
        this.#peek(1).type !== TokenType.LParen &&
        this.#peek(1).type !== TokenType.Less
      ) {
        this.#advance();
        isAbstract = true;
      }
    }

    if (isStatic && this.#match(TokenType.Symbol)) {
      const name = this.#parseIdentifier();
      this.#consume(TokenType.Semi, "Expected ';' after symbol declaration.");
      return {
        type: NodeType.FieldDefinition,
        name,
        typeAnnotation: {
          type: NodeType.TypeAnnotation,
          name: 'symbol',
          loc: name.loc,
        },
        isFinal: true,
        isStatic: true,
        isDeclare,
        decorators,
        loc: this.#loc(startToken, this.#previous()),
      };
    }

    let name: Identifier | ComputedPropertyName;
    if (this.#match(TokenType.LBracket)) {
      const start = this.#previous();
      const expression = this.#parseExpression();
      this.#consume(
        TokenType.RBracket,
        "Expected ']' after computed property name.",
      );
      const end = this.#previous();
      name = {
        type: NodeType.ComputedPropertyName,
        expression,
        loc: this.#loc(start, end),
      };
    } else if (this.#match(TokenType.Operator)) {
      // Disambiguate `operator []` vs `operator: i32`
      if (
        this.#check(TokenType.Colon) ||
        this.#check(TokenType.LParen) ||
        this.#check(TokenType.Less)
      ) {
        // It's a field/method named 'operator'
        const token = this.#previous();
        name = {
          type: NodeType.Identifier,
          name: token.value,
          loc: this.#locFromToken(token),
        };
      } else {
        if (this.#match(TokenType.EqualsEquals)) {
          name = {type: NodeType.Identifier, name: '=='};
        } else {
          this.#consume(TokenType.LBracket, "Expected '[' after 'operator'.");
          this.#consume(TokenType.RBracket, "Expected ']' after '['.");
          if (this.#match(TokenType.Equals)) {
            name = {type: NodeType.Identifier, name: '[]='};
          } else {
            name = {type: NodeType.Identifier, name: '[]'};
          }
        }
      }
    } else if (this.#match(TokenType.Hash)) {
      if (this.#match(TokenType.New)) {
        name = {type: NodeType.Identifier, name: '#new'};
      } else {
        const id = this.#parseIdentifier();
        name = {type: NodeType.Identifier, name: '#' + id.name};
      }
    } else if (this.#match(TokenType.New)) {
      const token = this.#previous();
      name = {
        type: NodeType.Identifier,
        name: 'new',
        loc: this.#locFromToken(token),
      };
    } else {
      name = this.#parseIdentifier();
      if (name.name === 'constructor') {
        name.name = '#new';
      }
    }

    const typeParameters = this.#parseTypeParameters();

    // Method: name(params) { ... }
    if (this.#match(TokenType.LParen)) {
      const params: Parameter[] = [];
      if (!this.#check(TokenType.RParen)) {
        let seenOptional = false;
        do {
          const paramName = this.#parseIdentifier();
          let optional = false;
          if (this.#match(TokenType.Question)) {
            optional = true;
            seenOptional = true;
          }

          this.#consume(TokenType.Colon, "Expected ':' for type annotation");
          const typeAnnotation = this.#parseTypeAnnotation();

          let initializer: Expression | undefined;
          if (this.#match(TokenType.Equals)) {
            initializer = this.#parseExpression();
            optional = true;
            seenOptional = true;
          }

          if (!optional && seenOptional) {
            throw new Error(
              'Required parameter cannot follow an optional parameter.',
            );
          }

          params.push({
            type: NodeType.Parameter,
            name: paramName,
            typeAnnotation,
            optional,
            initializer,
            loc: this.#loc(paramName, initializer || typeAnnotation),
          });
        } while (this.#match(TokenType.Comma));
      }
      this.#consume(TokenType.RParen, "Expected ')' after parameters.");

      let returnType: TypeAnnotation | undefined;
      if (this.#match(TokenType.Colon)) {
        returnType = this.#parseTypeAnnotation();
      }

      let body: BlockStatement | undefined;
      if (isAbstract || isDeclare) {
        this.#consume(
          TokenType.Semi,
          `Expected ';' after ${isAbstract ? 'abstract' : 'declared'} method signature.`,
        );
      } else {
        this.#consume(TokenType.LBrace, "Expected '{' before method body.");
        body = this.#parseBlockStatement();
      }

      return {
        type: NodeType.MethodDefinition,
        name,
        typeParameters,
        params,
        returnType,
        body,
        isFinal,
        isAbstract,
        isStatic,
        isDeclare,
        decorators,
        loc: this.#loc(startToken, body || this.#previous()),
      };
    }

    if (isAbstract) {
      // Abstract fields? Not supported yet, or maybe they are just fields without init?
      // For now, let's assume abstract is only for methods.
      // Or maybe abstract fields are allowed?
      // "Virtual Fields: Implement Uniform Access Principle (treat public fields as virtual properties with default accessors)."
      // If we have abstract fields, they would be abstract accessors.
      // For now, let's error if abstract is used on field.
      throw new Error('Abstract fields are not supported yet.');
    }

    if (typeParameters) {
      throw new Error('Fields cannot have type parameters.');
    }

    // Field: name: Type; or name: Type = value;
    this.#consume(TokenType.Colon, "Expected ':' after field name.");
    const typeAnnotation = this.#parseTypeAnnotation();

    if (this.#match(TokenType.LBrace)) {
      return this.#parseAccessorDeclaration(
        name,
        typeAnnotation,
        isFinal,
        isStatic,
        decorators,
        startToken,
      );
    }

    let value: Expression | undefined;
    if (this.#match(TokenType.Equals)) {
      value = this.#parseExpression();
    }

    this.#consume(TokenType.Semi, "Expected ';' after field declaration.");

    return {
      type: NodeType.FieldDefinition,
      name,
      typeAnnotation,
      value,
      isFinal,
      isStatic,
      isDeclare,
      decorators,
      loc: this.#loc(startToken, this.#previous()),
    };
  }

  #parseAccessorDeclaration(
    name: Identifier | ComputedPropertyName,
    typeAnnotation: TypeAnnotation,
    isFinal: boolean,
    isStatic: boolean,
    decorators: Decorator[],
    startToken: Token,
  ): AccessorDeclaration {
    let getter: BlockStatement | undefined;
    let setter: {param: Identifier; body: BlockStatement} | undefined;

    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      if (this.#match(TokenType.Identifier)) {
        const keyword = this.#previous().value;
        if (keyword === 'get') {
          if (getter) throw new Error('Duplicate getter');
          this.#consume(TokenType.LBrace, "Expected '{' after get");
          getter = this.#parseBlockStatement();
        } else if (keyword === 'set') {
          if (setter) throw new Error('Duplicate setter');
          this.#consume(TokenType.LParen, "Expected '(' after set");
          const param = this.#parseIdentifier();
          this.#consume(TokenType.RParen, "Expected ')' after set parameter");
          this.#consume(TokenType.LBrace, "Expected '{' after set");
          const body = this.#parseBlockStatement();
          setter = {param, body};
        } else {
          throw new Error("Expected 'get' or 'set' in accessor block");
        }
      } else {
        throw new Error("Expected 'get' or 'set'");
      }
    }
    this.#consume(TokenType.RBrace, "Expected '}' after accessor body");

    if (!getter && !setter) {
      throw new Error('Accessor must have at least a getter or a setter');
    }

    return {
      type: NodeType.AccessorDeclaration,
      name,
      typeAnnotation,
      getter,
      setter,
      isFinal,
      isStatic,
      decorators,
      loc: this.#loc(startToken, this.#previous()),
    };
  }

  #parseInterfaceDeclaration(
    exported: boolean,
    startToken?: Token,
  ): InterfaceDeclaration {
    const actualStartToken = startToken || this.#previous();
    const name = this.#parseIdentifier();
    const typeParameters = this.#parseTypeParameters();

    const extendsList: TypeAnnotation[] = [];
    if (this.#match(TokenType.Extends)) {
      do {
        extendsList.push(this.#parseTypeAnnotation());
      } while (this.#match(TokenType.Comma));
    }

    this.#consume(TokenType.LBrace, "Expected '{' before interface body.");

    const body: (FieldDefinition | MethodSignature | AccessorSignature)[] = [];
    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      body.push(this.#parseInterfaceMember());
    }

    this.#consume(TokenType.RBrace, "Expected '}' after interface body.");
    const endToken = this.#previous();

    return {
      type: NodeType.InterfaceDeclaration,
      name,
      typeParameters,
      extends: extendsList.length > 0 ? extendsList : undefined,
      body,
      exported,
      loc: this.#loc(actualStartToken, endToken),
    };
  }

  #parseInterfaceMember():
    | FieldDefinition
    | MethodSignature
    | AccessorSignature {
    let name: Identifier;
    if (this.#match(TokenType.Operator)) {
      // Disambiguate `operator []` vs `operator: i32`
      if (
        this.#check(TokenType.Colon) ||
        this.#check(TokenType.LParen) ||
        this.#check(TokenType.Less)
      ) {
        const token = this.#previous();
        name = {
          type: NodeType.Identifier,
          name: token.value,
          loc: this.#locFromToken(token),
        };
      } else {
        if (this.#match(TokenType.EqualsEquals)) {
          name = {type: NodeType.Identifier, name: '=='};
        } else {
          this.#consume(TokenType.LBracket, "Expected '[' after 'operator'.");
          this.#consume(TokenType.RBracket, "Expected ']' after '['.");
          if (this.#match(TokenType.Equals)) {
            name = {type: NodeType.Identifier, name: '[]='};
          } else {
            name = {type: NodeType.Identifier, name: '[]'};
          }
        }
      }
    } else {
      name = this.#parseIdentifier();
    }
    const typeParameters = this.#parseTypeParameters();

    // Method: name(params): ReturnType;
    if (this.#match(TokenType.LParen)) {
      const params: Parameter[] = [];
      if (!this.#check(TokenType.RParen)) {
        let seenOptional = false;
        do {
          const paramName = this.#parseIdentifier();
          let optional = false;
          if (this.#match(TokenType.Question)) {
            optional = true;
            seenOptional = true;
          }

          this.#consume(TokenType.Colon, "Expected ':' for type annotation");
          const typeAnnotation = this.#parseTypeAnnotation();

          // Interfaces usually don't have default values, but optional parameters are allowed.
          // Should we allow defaults in interfaces?
          // TS allows optional `?` but not defaults `=`.
          // Zena: "Also add defaults, which marks a parameter as optional."
          // If I allow defaults in interface, it's just metadata for the implementer?
          // Or does it mean the caller can omit it?
          // If the caller omits it, what value is passed?
          // If the interface defines the default, the caller can use it.
          // So yes, allow defaults in interfaces.

          let initializer: Expression | undefined;
          if (this.#match(TokenType.Equals)) {
            initializer = this.#parseExpression();
            optional = true;
            seenOptional = true;
          }

          if (!optional && seenOptional) {
            throw new Error(
              'Required parameter cannot follow an optional parameter.',
            );
          }

          params.push({
            type: NodeType.Parameter,
            name: paramName,
            typeAnnotation,
            optional,
            initializer,
          });
        } while (this.#match(TokenType.Comma));
      }
      this.#consume(TokenType.RParen, "Expected ')' after parameters.");

      let returnType: TypeAnnotation | undefined;
      if (this.#match(TokenType.Colon)) {
        returnType = this.#parseTypeAnnotation();
      }

      this.#consume(TokenType.Semi, "Expected ';' after method signature.");

      return {
        type: NodeType.MethodSignature,
        name,
        typeParameters,
        params,
        returnType,
      };
    }

    if (typeParameters) {
      throw new Error('Fields cannot have type parameters.');
    }

    // Field: name: Type;
    this.#consume(TokenType.Colon, "Expected ':' after field name.");
    const typeAnnotation = this.#parseTypeAnnotation();

    if (this.#match(TokenType.LBrace)) {
      let hasGetter = false;
      let hasSetter = false;

      while (!this.#match(TokenType.RBrace)) {
        const id = this.#parseIdentifier();
        if (id.name === 'get') {
          hasGetter = true;
        } else if (id.name === 'set') {
          hasSetter = true;
        } else {
          throw new Error(
            `Expected 'get' or 'set' in accessor signature, got '${id.name}'`,
          );
        }
        this.#consume(TokenType.Semi, "Expected ';' after accessor specifier.");
      }

      return {
        type: NodeType.AccessorSignature,
        name,
        typeAnnotation,
        hasGetter,
        hasSetter,
      };
    }

    this.#consume(TokenType.Semi, "Expected ';' after field declaration.");

    return {
      type: NodeType.FieldDefinition,
      name,
      typeAnnotation,
      isFinal: false, // Interfaces don't support final fields yet
      isStatic: false,
    };
  }

  #parseTypeParameters(): TypeParameter[] | undefined {
    if (this.#match(TokenType.Less)) {
      const params: TypeParameter[] = [];
      do {
        const id = this.#parseIdentifier();
        const name = id.name;
        let constraint: TypeAnnotation | undefined;
        if (this.#match(TokenType.Extends)) {
          constraint = this.#parseTypeAnnotation();
        }
        let defaultValue: TypeAnnotation | undefined;
        if (this.#match(TokenType.Equals)) {
          defaultValue = this.#parseTypeAnnotation();
        }
        params.push({
          type: NodeType.TypeParameter,
          name,
          constraint,
          default: defaultValue,
          loc: this.#loc(id, defaultValue || constraint || id),
        });
      } while (this.#match(TokenType.Comma));
      this.#consume(TokenType.Greater, "Expected '>' after type parameters.");
      return params;
    }
    return undefined;
  }

  #parseTypeArguments(): TypeAnnotation[] | undefined {
    if (this.#match(TokenType.Less)) {
      const args: TypeAnnotation[] = [];
      do {
        args.push(this.#parseTypeAnnotation());
      } while (this.#match(TokenType.Comma));
      this.#consume(TokenType.Greater, "Expected '>' after type arguments.");
      return args;
    }
    return undefined;
  }

  #parseTypeAnnotation(): TypeAnnotation {
    const startToken = this.#peek();
    let left: TypeAnnotation;
    if (this.#match(TokenType.LParen)) {
      const params: TypeAnnotation[] = [];
      if (!this.#check(TokenType.RParen)) {
        do {
          // Check for "Identifier :" (named parameter)
          if (
            this.#check(TokenType.Identifier) &&
            this.#peek(1).type === TokenType.Colon
          ) {
            this.#advance(); // consume identifier
            this.#advance(); // consume colon
          }
          params.push(this.#parseTypeAnnotation());
        } while (this.#match(TokenType.Comma));
      }
      this.#consume(TokenType.RParen, "Expected ')'");
      this.#consume(TokenType.Arrow, "Expected '=>'");
      const returnType = this.#parseTypeAnnotation();
      left = {
        type: NodeType.FunctionTypeAnnotation,
        params,
        returnType,
        loc: this.#loc(startToken, returnType),
      };
    } else if (this.#match(TokenType.LBrace)) {
      left = this.#parseRecordTypeAnnotation(this.#previous());
    } else if (this.#match(TokenType.LBracket)) {
      left = this.#parseTupleTypeAnnotation(this.#previous());
    } else {
      left = this.#parsePrimaryTypeAnnotation();
    }

    if (this.#match(TokenType.Pipe)) {
      const types: TypeAnnotation[] = [left];
      do {
        if (this.#match(TokenType.LBrace)) {
          types.push(this.#parseRecordTypeAnnotation(this.#previous()));
        } else if (this.#match(TokenType.LBracket)) {
          types.push(this.#parseTupleTypeAnnotation(this.#previous()));
        } else {
          types.push(this.#parsePrimaryTypeAnnotation());
        }
      } while (this.#match(TokenType.Pipe));

      const lastType = types[types.length - 1];
      return {
        type: NodeType.UnionTypeAnnotation,
        types,
        loc: this.#loc(left, lastType),
      };
    }

    return left;
  }

  #parseRecordTypeAnnotation(startToken: Token): RecordTypeAnnotation {
    const properties: PropertySignature[] = [];
    if (!this.#check(TokenType.RBrace)) {
      do {
        const name = this.#parseIdentifier();
        this.#consume(TokenType.Colon, "Expected ':'");
        const typeAnnotation = this.#parseTypeAnnotation();
        properties.push({
          type: NodeType.PropertySignature,
          name,
          typeAnnotation,
          loc: this.#loc(name, typeAnnotation),
        });
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBrace, "Expected '}'");
    const endToken = this.#previous();
    return {
      type: NodeType.RecordTypeAnnotation,
      properties,
      loc: this.#loc(startToken, endToken),
    };
  }

  #parseTupleTypeAnnotation(startToken: Token): TupleTypeAnnotation {
    const elementTypes: TypeAnnotation[] = [];
    if (!this.#check(TokenType.RBracket)) {
      do {
        elementTypes.push(this.#parseTypeAnnotation());
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBracket, "Expected ']'");
    const endToken = this.#previous();
    return {
      type: NodeType.TupleTypeAnnotation,
      elementTypes,
      loc: this.#loc(startToken, endToken),
    };
  }

  #parseRecordLiteral(): RecordLiteral {
    const properties: (PropertyAssignment | SpreadElement)[] = [];
    if (!this.#check(TokenType.RBrace)) {
      do {
        if (this.#match(TokenType.DotDotDot)) {
          const startToken = this.#previous();
          const argument = this.#parseExpression();
          properties.push({
            type: NodeType.SpreadElement,
            argument,
            loc: this.#loc(startToken, argument),
          });
        } else {
          const name = this.#parseIdentifier();
          let value: Expression;
          if (this.#match(TokenType.Colon)) {
            value = this.#parseExpression();
          } else {
            value = name;
          }
          properties.push({
            type: NodeType.PropertyAssignment,
            name,
            value,
          });
        }
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBrace, "Expected '}'");
    return {
      type: NodeType.RecordLiteral,
      properties,
    };
  }

  #parseTupleLiteral(): TupleLiteral {
    const elements: Expression[] = [];
    if (!this.#check(TokenType.RBracket)) {
      do {
        elements.push(this.#parseExpression());
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBracket, "Expected ']'");
    return {
      type: NodeType.TupleLiteral,
      elements,
    };
  }

  #parsePrimaryTypeAnnotation(): TypeAnnotation {
    const startToken = this.#peek();

    // Check for literal types
    if (this.#match(TokenType.String)) {
      const token = this.#previous();
      return {
        type: NodeType.LiteralTypeAnnotation,
        value: token.value,
        loc: this.#loc(startToken, token),
      } as LiteralTypeAnnotation;
    }

    if (this.#match(TokenType.Number)) {
      const token = this.#previous();
      return {
        type: NodeType.LiteralTypeAnnotation,
        value: Number(token.value),
        loc: this.#loc(startToken, token),
      } as LiteralTypeAnnotation;
    }

    if (this.#match(TokenType.True)) {
      const token = this.#previous();
      return {
        type: NodeType.LiteralTypeAnnotation,
        value: true,
        loc: this.#loc(startToken, token),
      } as LiteralTypeAnnotation;
    }

    if (this.#match(TokenType.False)) {
      const token = this.#previous();
      return {
        type: NodeType.LiteralTypeAnnotation,
        value: false,
        loc: this.#loc(startToken, token),
      } as LiteralTypeAnnotation;
    }

    // Otherwise parse as named type
    return this.#parseNamedTypeAnnotation();
  }

  #parseNamedTypeAnnotation(): NamedTypeAnnotation {
    let startToken: Token;
    let name: string;
    if (this.#match(TokenType.Null)) {
      startToken = this.#previous();
      name = 'null';
    } else {
      startToken = this.#peek();
      name = this.#parseIdentifier().name;
    }
    const typeArguments = this.#parseTypeArguments();
    return {
      type: NodeType.TypeAnnotation,
      name,
      typeArguments,
      loc: this.#loc(startToken, this.#previous()),
    };
  }
  #parseBlockStatement(): BlockStatement {
    const startToken = this.#previous();
    const body: Statement[] = [];
    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      body.push(this.#parseStatement());
    }
    this.#consume(TokenType.RBrace, "Expected '}' after block.");
    const endToken = this.#previous();
    return {
      type: NodeType.BlockStatement,
      body,
      loc: this.#loc(startToken, endToken),
    };
  }

  #parseDecoratedStatement(): Statement {
    const startToken = this.#peek();
    const decorators: Decorator[] = [];

    while (this.#check(TokenType.At)) {
      decorators.push(this.#parseDecorator());
    }

    let exported = false;
    if (this.#match(TokenType.Export)) {
      exported = true;
    }

    if (this.#match(TokenType.Declare)) {
      let externalModule: string | undefined;
      let externalName: string | undefined;

      for (const d of decorators) {
        if (d.name === 'external') {
          if (d.args.length !== 2)
            throw new Error('@external expects 2 arguments');
          externalModule = d.args[0].value;
          externalName = d.args[1].value;
        } else if (d.name === 'intrinsic') {
          if (d.args.length !== 1)
            throw new Error('@intrinsic expects 1 argument');
        } else {
          throw new Error(`Unknown decorator: @${d.name}`);
        }
      }

      const decl = this.#parseDeclareFunction(
        externalModule,
        externalName,
        exported,
        startToken,
      );
      decl.decorators = decorators;
      return decl;
    }

    throw new Error('Expected declare statement after decorator');
  }

  #parseDeclareFunction(
    externalModule?: string,
    externalName?: string,
    exported = false,
    startToken?: Token,
  ): DeclareFunction {
    const actualStartToken = startToken || this.#previous();
    this.#consume(TokenType.Function, "Expected 'function' after 'declare'");
    const name = this.#parseIdentifier();
    const typeParameters = this.#parseTypeParameters();

    this.#consume(TokenType.LParen, "Expected '(' after function name");
    const params: Parameter[] = [];
    if (!this.#check(TokenType.RParen)) {
      let seenOptional = false;
      do {
        const paramName = this.#parseIdentifier();
        let optional = false;
        if (this.#match(TokenType.Question)) {
          optional = true;
          seenOptional = true;
        }

        this.#consume(TokenType.Colon, "Expected ':' for type annotation");
        const typeAnnotation = this.#parseTypeAnnotation();

        // Declare functions (external) might have optional parameters.
        // But defaults? Defaults in `declare` usually don't make sense unless we inline them.
        // But for consistency, let's allow them.

        let initializer: Expression | undefined;
        if (this.#match(TokenType.Equals)) {
          initializer = this.#parseExpression();
          optional = true;
          seenOptional = true;
        }

        if (!optional && seenOptional) {
          throw new Error(
            'Required parameter cannot follow an optional parameter.',
          );
        }

        params.push({
          type: NodeType.Parameter,
          name: paramName,
          typeAnnotation,
          optional,
          initializer,
        });
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RParen, "Expected ')' after parameters");

    this.#consume(TokenType.Colon, "Expected ':' for return type");
    const returnType = this.#parseTypeAnnotation();

    this.#consume(TokenType.Semi, "Expected ';' after function declaration");
    const endToken = this.#previous();

    return {
      type: NodeType.DeclareFunction,
      name,
      typeParameters,
      params,
      returnType,
      externalModule,
      externalName,
      exported,
      loc: this.#loc(actualStartToken, endToken),
    };
  }

  #parseImportDeclaration(): ImportDeclaration {
    const startToken = this.#peek();
    if (this.#match(TokenType.Import)) {
      const imports = this.#parseImportSpecifiers();
      this.#consume(TokenType.From, "Expected 'from'.");
      const moduleSpecifier = this.#parseStringLiteral();
      this.#consume(TokenType.Semi, "Expected ';'.");
      const endToken = this.#previous();
      return {
        type: NodeType.ImportDeclaration,
        moduleSpecifier,
        imports,
        loc: this.#loc(startToken, endToken),
      };
    }

    if (this.#match(TokenType.From)) {
      const moduleSpecifier = this.#parseStringLiteral();
      this.#consume(TokenType.Import, "Expected 'import'.");
      const imports = this.#parseImportSpecifiers();
      this.#consume(TokenType.Semi, "Expected ';'.");
      const endToken = this.#previous();
      return {
        type: NodeType.ImportDeclaration,
        moduleSpecifier,
        imports,
        loc: this.#loc(startToken, endToken),
      };
    }

    throw new Error('Expected import declaration.');
  }

  #parseImportSpecifiers(): ImportSpecifier[] {
    this.#consume(TokenType.LBrace, "Expected '{'.");
    const imports: ImportSpecifier[] = [];
    if (!this.#check(TokenType.RBrace)) {
      do {
        const imported = this.#parseIdentifier();
        let local = imported;
        if (this.#match(TokenType.As)) {
          local = this.#parseIdentifier();
        }
        imports.push({
          type: NodeType.ImportSpecifier,
          imported,
          local,
          loc: this.#loc(imported, local),
        });
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBrace, "Expected '}'.");
    return imports;
  }

  #parseStringLiteral(): StringLiteral {
    const token = this.#consume(TokenType.String, 'Expected string literal.');
    return {
      type: NodeType.StringLiteral,
      value: token.value,
    };
  }

  #parseDecorator(): Decorator {
    const startToken = this.#consume(TokenType.At, "Expected '@'");
    const name = this.#parseIdentifier().name;
    const args: StringLiteral[] = [];
    if (this.#match(TokenType.LParen)) {
      if (!this.#check(TokenType.RParen)) {
        do {
          const arg = this.#parseExpression();
          if (arg.type !== NodeType.StringLiteral) {
            throw new Error('Decorator arguments must be string literals');
          }
          args.push(arg as StringLiteral);
        } while (this.#match(TokenType.Comma));
      }
      this.#consume(TokenType.RParen, "Expected ')' after decorator arguments");
    }
    return {
      type: NodeType.Decorator,
      name,
      args,
      loc: this.#loc(startToken, this.#previous()),
    };
  }

  // Helper methods
  #match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.#check(type)) {
        this.#advance();
        return true;
      }
    }
    return false;
  }

  #check(type: TokenType): boolean {
    if (this.#isAtEnd()) return false;
    return this.#peek().type === type;
  }

  #advance(): Token {
    if (!this.#isAtEnd()) this.#current++;
    return this.#previous();
  }

  #isAtEnd(): boolean {
    return this.#peek().type === TokenType.EOF;
  }

  #peek(distance = 0): Token {
    const index = this.#current + distance;
    if (index >= this.#tokens.length) {
      return this.#tokens[this.#tokens.length - 1];
    }
    return this.#tokens[index];
  }

  #previous(): Token {
    return this.#tokens[this.#current - 1];
  }

  #consume(type: TokenType, message: string): Token {
    if (this.#check(type)) return this.#advance();
    throw new Error(
      message + ` Got ${this.#peek().type} at line ${this.#peek().line}`,
    );
  }

  /**
   * Create a SourceLocation from a single token.
   */
  #locFromToken(token: Token): SourceLocation {
    return {
      line: token.line,
      column: token.column,
      start: token.start,
      end: token.end,
    };
  }

  /**
   * Create a SourceLocation spanning from a start token to the previous token
   * (useful for nodes that have already consumed their end token).
   */
  #locFromRange(startToken: Token, endToken: Token): SourceLocation {
    return {
      line: startToken.line,
      column: startToken.column,
      start: startToken.start,
      end: endToken.end,
    };
  }

  /**
   * Create a SourceLocation spanning from a start token/node to an end token/node.
   */
  #loc(
    start: Token | {loc?: SourceLocation},
    end: Token | {loc?: SourceLocation},
  ): SourceLocation | undefined {
    let startLoc: SourceLocation | undefined;
    if ('loc' in start) {
      startLoc = start.loc;
    } else {
      const token = start as Token;
      startLoc = {
        line: token.line,
        column: token.column,
        start: token.start,
        end: token.end,
      };
    }

    let endLoc: SourceLocation | undefined;
    if ('loc' in end) {
      endLoc = end.loc;
    } else {
      const token = end as Token;
      endLoc = {
        line: token.line,
        column: token.column,
        start: token.start,
        end: token.end,
      };
    }

    if (!startLoc || !endLoc) return undefined;

    return {
      line: startLoc.line,
      column: startLoc.column,
      start: startLoc.start,
      end: endLoc.end,
    };
  }
}
