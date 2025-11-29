import {
  NodeType,
  type AccessorDeclaration,
  type BindingProperty,
  type BlockStatement,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type DeclareFunction,
  type Expression,
  type FieldDefinition,
  type ForStatement,
  type FunctionExpression,
  type Identifier,
  type IfStatement,
  type ImportDeclaration,
  type ImportSpecifier,
  type IndexExpression,
  type InterfaceDeclaration,
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
    if (this.#match(TokenType.Import) || this.#match(TokenType.From)) {
      throw new Error('Imports must appear at the top of the file.');
    }
    if (this.#match(TokenType.At)) {
      return this.#parseDecoratedStatement();
    }
    if (this.#match(TokenType.Declare)) {
      return this.#parseDeclareFunction();
    }
    if (this.#match(TokenType.Export)) {
      if (this.#match(TokenType.Final)) {
        if (this.#match(TokenType.Extension)) {
          this.#consume(TokenType.Class, "Expected 'class' after 'extension'.");
          return this.#parseClassDeclaration(true, true, false, true);
        }
        this.#consume(TokenType.Class, "Expected 'class' after 'final'.");
        return this.#parseClassDeclaration(true, true);
      }
      if (this.#match(TokenType.Abstract)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'abstract'.");
        return this.#parseClassDeclaration(true, false, true);
      }
      if (this.#match(TokenType.Extension)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'extension'.");
        return this.#parseClassDeclaration(true, false, false, true);
      }
      if (this.#match(TokenType.Class)) {
        return this.#parseClassDeclaration(true);
      }
      if (this.#match(TokenType.Interface)) {
        return this.#parseInterfaceDeclaration(true);
      }
      if (this.#match(TokenType.Mixin)) {
        return this.#parseMixinDeclaration(true);
      }
      if (this.#match(TokenType.Type) || this.#match(TokenType.Distinct)) {
        return this.#parseTypeAliasDeclaration(true);
      }
      if (this.#match(TokenType.Declare)) {
        return this.#parseDeclareFunction(undefined, undefined, true);
      }
      return this.#parseVariableDeclaration(true);
    }
    if (this.#match(TokenType.Let) || this.#match(TokenType.Var)) {
      return this.#parseVariableDeclaration(false);
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
      this.#consume(TokenType.Class, "Expected 'class' after 'final'.");
      return this.#parseClassDeclaration(false, true);
    }
    if (this.#match(TokenType.Abstract)) {
      this.#consume(TokenType.Class, "Expected 'class' after 'abstract'.");
      return this.#parseClassDeclaration(false, false, true);
    }
    if (this.#match(TokenType.Extension)) {
      this.#consume(TokenType.Class, "Expected 'class' after 'extension'.");
      return this.#parseClassDeclaration(false, false, false, true);
    }
    if (this.#match(TokenType.Class)) {
      return this.#parseClassDeclaration(false);
    }
    if (this.#match(TokenType.Interface)) {
      return this.#parseInterfaceDeclaration(false);
    }
    if (this.#match(TokenType.Mixin)) {
      return this.#parseMixinDeclaration(false);
    }
    if (this.#match(TokenType.Type) || this.#match(TokenType.Distinct)) {
      return this.#parseTypeAliasDeclaration(false);
    }
    if (this.#match(TokenType.LBrace)) {
      return this.#parseBlockStatement();
    }
    return this.#parseExpressionStatement();
  }

  #parseTypeAliasDeclaration(exported: boolean): TypeAliasDeclaration {
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
    return {
      type: NodeType.TypeAliasDeclaration,
      name,
      typeParameters,
      typeAnnotation,
      exported,
      isDistinct,
    };
  }

  #parseVariableDeclaration(
    exported: boolean,
    consumeSemi: boolean = true,
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
      loc: this.#locFromRange(kindToken, endToken),
    };
  }

  #parsePattern(): Pattern {
    if (this.#match(TokenType.LBrace)) {
      return this.#parseRecordPattern();
    }
    if (this.#match(TokenType.LBracket)) {
      return this.#parseTuplePattern();
    }
    return this.#parseIdentifier();
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
    const expression = this.#parseExpression();
    this.#consume(TokenType.Semi, "Expected ';' after expression.");
    return {
      type: NodeType.ExpressionStatement,
      expression,
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

      // Case 2: (param: type ...
      // If we see ( identifier :, it must be an arrow function parameter list
      if (
        this.#peek(1).type === TokenType.Identifier &&
        this.#peek(2).type === TokenType.Colon
      ) {
        return this.#parseArrowFunctionDefinition();
      }
    }

    return this.#parseEquality();
  }

  #parseArrowFunctionDefinition(): FunctionExpression {
    const typeParameters = this.#parseTypeParameters();
    this.#consume(TokenType.LParen, "Expected '('");
    const params: Parameter[] = [];
    if (!this.#check(TokenType.RParen)) {
      do {
        const name = this.#parseIdentifier();
        this.#consume(TokenType.Colon, "Expected ':' for type annotation");
        const typeAnnotation = this.#parseTypeAnnotation();
        params.push({
          type: NodeType.Parameter,
          name,
          typeAnnotation,
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
    };
  }

  #parseEquality(): Expression {
    let left = this.#parseComparison();

    while (this.#match(TokenType.EqualsEquals, TokenType.BangEquals)) {
      const operator = this.#previous().value;
      const right = this.#parseComparison();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
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
      };
    }

    return left;
  }

  #parseAs(): Expression {
    let left = this.#parseTerm();

    while (this.#match(TokenType.As)) {
      const typeAnnotation = this.#parseTypeAnnotation();
      left = {
        type: NodeType.AsExpression,
        expression: left,
        typeAnnotation,
      };
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
      };
    }

    return left;
  }

  #parseFactor(): Expression {
    let left = this.#parseCall();

    while (this.#match(TokenType.Star, TokenType.Slash)) {
      const operator = this.#previous().value;
      const right = this.#parseCall();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
      };
    }

    return left;
  }

  #parseCall(): Expression {
    if (this.#match(TokenType.New)) {
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

      let expr: Expression = {
        type: NodeType.NewExpression,
        callee,
        typeArguments,
        arguments: args,
      };

      while (true) {
        if (this.#match(TokenType.Dot)) {
          let property: Identifier;
          if (this.#match(TokenType.Hash)) {
            const id = this.#parseIdentifier();
            property = {type: NodeType.Identifier, name: '#' + id.name};
          } else {
            property = this.#parseIdentifier();
          }
          expr = {
            type: NodeType.MemberExpression,
            object: expr,
            property,
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
          property = {type: NodeType.Identifier, name: '#' + id.name};
        } else {
          property = this.#parseIdentifier();
        }
        expr = {
          type: NodeType.MemberExpression,
          object: expr,
          property,
        };
      } else if (this.#match(TokenType.LBracket)) {
        const index = this.#parseExpression();
        this.#consume(TokenType.RBracket, "Expected ']' after index.");
        expr = {
          type: NodeType.IndexExpression,
          object: expr,
          index,
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

    return {
      type: NodeType.CallExpression,
      callee,
      typeArguments,
      arguments: args,
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
        value: parseFloat(token.value),
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
    if (this.#match(TokenType.Identifier)) {
      const token = this.#previous();
      return {
        type: NodeType.Identifier,
        name: token.value,
        loc: this.#locFromToken(token),
      };
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

  #isTemplateStart(): boolean {
    const type = this.#peek().type;
    return (
      type === TokenType.NoSubstitutionTemplate ||
      type === TokenType.TemplateHead
    );
  }

  #parseTemplateLiteral(): TemplateLiteral {
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
      });
      return {
        type: NodeType.TemplateLiteral,
        quasis,
        expressions,
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
        });
        continue;
      }

      throw new Error(
        `Expected template middle or tail, got ${this.#peek().type}`,
      );
    }

    return {
      type: NodeType.TemplateLiteral,
      quasis,
      expressions,
    };
  }

  #parseIdentifier(): Identifier {
    if (this.#match(TokenType.Identifier)) {
      const token = this.#previous();
      return {
        type: NodeType.Identifier,
        name: token.value,
        loc: this.#locFromToken(token),
      };
    }
    throw new Error(`Expected identifier, got ${this.#peek().type}`);
  }

  #parseReturnStatement(): ReturnStatement {
    let argument: Expression | undefined;
    if (!this.#check(TokenType.Semi)) {
      argument = this.#parseExpression();
    }
    this.#consume(TokenType.Semi, "Expected ';' after return value.");
    return {
      type: NodeType.ReturnStatement,
      argument,
    };
  }

  #parseIfStatement(): IfStatement {
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
    };
  }

  #parseWhileStatement(): WhileStatement {
    this.#consume(TokenType.LParen, "Expected '(' after 'while'.");
    const test = this.#parseExpression();
    this.#consume(TokenType.RParen, "Expected ')' after while condition.");

    const body = this.#parseStatement();

    return {
      type: NodeType.WhileStatement,
      test,
      body,
    };
  }

  #parseForStatement(): ForStatement {
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
    };
  }

  #parseClassDeclaration(
    exported: boolean,
    isFinal: boolean = false,
    isAbstract: boolean = false,
    isExtension: boolean = false,
  ): ClassDeclaration {
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
    };
  }

  #parseMixinDeclaration(exported: boolean): MixinDeclaration {
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

    return {
      type: NodeType.MixinDeclaration,
      name,
      typeParameters,
      on,
      mixins: mixins.length > 0 ? mixins : undefined,
      body,
      exported,
    };
  }

  #parseClassMember():
    | FieldDefinition
    | MethodDefinition
    | AccessorDeclaration {
    const decorators: Decorator[] = [];
    while (this.#match(TokenType.At)) {
      decorators.push(this.#parseDecorator());
    }

    let isDeclare = false;
    if (this.#match(TokenType.Declare)) {
      isDeclare = true;
    }

    let isStatic = false;
    if (this.#match(TokenType.Static)) {
      isStatic = true;
    }

    let isFinal = false;
    if (this.#match(TokenType.Final)) {
      isFinal = true;
    }

    let isAbstract = false;
    if (this.#match(TokenType.Abstract)) {
      isAbstract = true;
    }

    let name: Identifier;
    if (this.#match(TokenType.Operator)) {
      this.#consume(TokenType.LBracket, "Expected '[' after 'operator'.");
      this.#consume(TokenType.RBracket, "Expected ']' after '['.");
      if (this.#match(TokenType.Equals)) {
        name = {type: NodeType.Identifier, name: '[]='};
      } else {
        name = {type: NodeType.Identifier, name: '[]'};
      }
    } else if (this.#match(TokenType.Hash)) {
      if (this.#match(TokenType.New)) {
        name = {type: NodeType.Identifier, name: '#new'};
      } else {
        const id = this.#parseIdentifier();
        name = {type: NodeType.Identifier, name: '#' + id.name};
      }
    } else {
      name = this.#parseIdentifier();
    }

    // Method: name(params) { ... }
    if (this.#match(TokenType.LParen)) {
      const params: Parameter[] = [];
      if (!this.#check(TokenType.RParen)) {
        do {
          const paramName = this.#parseIdentifier();
          this.#consume(TokenType.Colon, "Expected ':' for type annotation");
          const typeAnnotation = this.#parseTypeAnnotation();
          params.push({
            type: NodeType.Parameter,
            name: paramName,
            typeAnnotation,
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
        params,
        returnType,
        body,
        isFinal,
        isAbstract,
        isStatic,
        isDeclare,
        decorators,
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
    };
  }

  #parseAccessorDeclaration(
    name: Identifier,
    typeAnnotation: TypeAnnotation,
    isFinal: boolean,
    isStatic: boolean,
    decorators: Decorator[],
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
    };
  }

  #parseInterfaceDeclaration(exported: boolean): InterfaceDeclaration {
    const name = this.#parseIdentifier();
    const typeParameters = this.#parseTypeParameters();

    const extendsList: TypeAnnotation[] = [];
    if (this.#match(TokenType.Extends)) {
      do {
        extendsList.push(this.#parseTypeAnnotation());
      } while (this.#match(TokenType.Comma));
    }

    this.#consume(TokenType.LBrace, "Expected '{' before interface body.");

    const body: (FieldDefinition | MethodSignature)[] = [];
    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      body.push(this.#parseInterfaceMember());
    }

    this.#consume(TokenType.RBrace, "Expected '}' after interface body.");

    return {
      type: NodeType.InterfaceDeclaration,
      name,
      typeParameters,
      extends: extendsList.length > 0 ? extendsList : undefined,
      body,
      exported,
    };
  }

  #parseInterfaceMember(): FieldDefinition | MethodSignature {
    const name = this.#parseIdentifier();

    // Method: name(params): ReturnType;
    if (this.#match(TokenType.LParen)) {
      const params: Parameter[] = [];
      if (!this.#check(TokenType.RParen)) {
        do {
          const paramName = this.#parseIdentifier();
          this.#consume(TokenType.Colon, "Expected ':' for type annotation");
          const typeAnnotation = this.#parseTypeAnnotation();
          params.push({
            type: NodeType.Parameter,
            name: paramName,
            typeAnnotation,
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
        params,
        returnType,
      };
    }

    // Field: name: Type;
    this.#consume(TokenType.Colon, "Expected ':' after field name.");
    const typeAnnotation = this.#parseTypeAnnotation();
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
        const name = this.#parseIdentifier().name;
        let defaultValue: TypeAnnotation | undefined;
        if (this.#match(TokenType.Equals)) {
          defaultValue = this.#parseTypeAnnotation();
        }
        params.push({
          type: NodeType.TypeParameter,
          name,
          default: defaultValue,
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
      };
    } else if (this.#match(TokenType.LBrace)) {
      left = this.#parseRecordTypeAnnotation();
    } else if (this.#match(TokenType.LBracket)) {
      left = this.#parseTupleTypeAnnotation();
    } else {
      left = this.#parseNamedTypeAnnotation();
    }

    if (this.#match(TokenType.Pipe)) {
      const types: TypeAnnotation[] = [left];
      do {
        if (this.#match(TokenType.LBrace)) {
          types.push(this.#parseRecordTypeAnnotation());
        } else if (this.#match(TokenType.LBracket)) {
          types.push(this.#parseTupleTypeAnnotation());
        } else {
          types.push(this.#parseNamedTypeAnnotation());
        }
      } while (this.#match(TokenType.Pipe));

      return {
        type: NodeType.UnionTypeAnnotation,
        types,
      };
    }

    return left;
  }

  #parseRecordTypeAnnotation(): RecordTypeAnnotation {
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
        });
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBrace, "Expected '}'");
    return {
      type: NodeType.RecordTypeAnnotation,
      properties,
    };
  }

  #parseTupleTypeAnnotation(): TupleTypeAnnotation {
    const elementTypes: TypeAnnotation[] = [];
    if (!this.#check(TokenType.RBracket)) {
      do {
        elementTypes.push(this.#parseTypeAnnotation());
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RBracket, "Expected ']'");
    return {
      type: NodeType.TupleTypeAnnotation,
      elementTypes,
    };
  }

  #parseRecordLiteral(): RecordLiteral {
    const properties: PropertyAssignment[] = [];
    if (!this.#check(TokenType.RBrace)) {
      do {
        const name = this.#parseIdentifier();
        this.#consume(TokenType.Colon, "Expected ':'");
        const value = this.#parseExpression();
        properties.push({
          type: NodeType.PropertyAssignment,
          name,
          value,
        });
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

  #parseNamedTypeAnnotation(): NamedTypeAnnotation {
    let name: string;
    if (this.#match(TokenType.Null)) {
      name = 'null';
    } else {
      name = this.#parseIdentifier().name;
    }
    const typeArguments = this.#parseTypeArguments();
    return {
      type: NodeType.TypeAnnotation,
      name,
      typeArguments,
    };
  }
  #parseBlockStatement(): BlockStatement {
    const body: Statement[] = [];
    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      body.push(this.#parseStatement());
    }
    this.#consume(TokenType.RBrace, "Expected '}' after block.");
    return {
      type: NodeType.BlockStatement,
      body,
    };
  }

  #parseDecoratedStatement(): Statement {
    // We only support @external for now
    const decoratorName = this.#parseIdentifier().name;
    if (decoratorName !== 'external') {
      throw new Error(`Unknown decorator: @${decoratorName}`);
    }

    this.#consume(TokenType.LParen, "Expected '(' after @external");
    const moduleName = this.#consume(
      TokenType.String,
      'Expected module name string',
    ).value;
    this.#consume(TokenType.Comma, "Expected ',' after module name");
    const externalName = this.#consume(
      TokenType.String,
      'Expected external name string',
    ).value;
    this.#consume(TokenType.RParen, "Expected ')' after decorator arguments");

    if (this.#match(TokenType.Declare)) {
      return this.#parseDeclareFunction(moduleName, externalName);
    }

    throw new Error('Expected declare statement after decorator');
  }

  #parseDeclareFunction(
    externalModule?: string,
    externalName?: string,
    exported = false,
  ): DeclareFunction {
    this.#consume(TokenType.Function, "Expected 'function' after 'declare'");
    const name = this.#parseIdentifier();

    this.#consume(TokenType.LParen, "Expected '(' after function name");
    const params: Parameter[] = [];
    if (!this.#check(TokenType.RParen)) {
      do {
        const paramName = this.#parseIdentifier();
        this.#consume(TokenType.Colon, "Expected ':' for type annotation");
        const typeAnnotation = this.#parseTypeAnnotation();
        params.push({
          type: NodeType.Parameter,
          name: paramName,
          typeAnnotation,
        });
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RParen, "Expected ')' after parameters");

    this.#consume(TokenType.Colon, "Expected ':' for return type");
    const returnType = this.#parseTypeAnnotation();

    this.#consume(TokenType.Semi, "Expected ';' after function declaration");

    return {
      type: NodeType.DeclareFunction,
      name,
      params,
      returnType,
      externalModule,
      externalName,
      exported,
    };
  }

  #parseImportDeclaration(): ImportDeclaration {
    if (this.#match(TokenType.Import)) {
      const imports = this.#parseImportSpecifiers();
      this.#consume(TokenType.From, "Expected 'from'.");
      const moduleSpecifier = this.#parseStringLiteral();
      this.#consume(TokenType.Semi, "Expected ';'.");
      return {
        type: NodeType.ImportDeclaration,
        moduleSpecifier,
        imports,
      };
    }

    if (this.#match(TokenType.From)) {
      const moduleSpecifier = this.#parseStringLiteral();
      this.#consume(TokenType.Import, "Expected 'import'.");
      const imports = this.#parseImportSpecifiers();
      this.#consume(TokenType.Semi, "Expected ';'.");
      return {
        type: NodeType.ImportDeclaration,
        moduleSpecifier,
        imports,
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
}
