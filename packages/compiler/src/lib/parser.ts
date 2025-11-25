import {
  NodeType,
  type AssignmentExpression,
  type BlockStatement,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Identifier,
  type IfStatement,
  type WhileStatement,
  type Parameter,
  type Program,
  type ReturnStatement,
  type Statement,
  type TypeAnnotation,
  type VariableDeclaration,
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
    while (!this.#isAtEnd()) {
      body.push(this.#parseStatement());
    }
    return {
      type: NodeType.Program,
      body,
    };
  }

  #parseStatement(): Statement {
    if (this.#match(TokenType.Export)) {
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
    if (this.#match(TokenType.LBrace)) {
      return this.#parseBlockStatement();
    }
    return this.#parseExpressionStatement();
  }

  #parseVariableDeclaration(exported: boolean): VariableDeclaration {
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

    const identifier = this.#parseIdentifier();
    this.#consume(TokenType.Equals, "Expected '=' after variable name.");
    const init = this.#parseExpression();
    this.#consume(TokenType.Semi, "Expected ';' after variable declaration.");

    return {
      type: NodeType.VariableDeclaration,
      kind,
      identifier,
      init,
      exported,
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
      if (expr.type === NodeType.Identifier) {
        return {
          type: NodeType.AssignmentExpression,
          name: expr as Identifier,
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

    if (this.#check(TokenType.LParen)) {
      // Lookahead to distinguish between parenthesized expression and arrow function

      // Case 1: () => ...
      if (
        this.#peek(1).type === TokenType.RParen &&
        this.#peek(2).type === TokenType.Arrow
      ) {
        return this.#parseArrowFunctionDefinition();
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
    this.#consume(TokenType.LParen, "Expected '('");
    const params: Parameter[] = [];
    if (!this.#check(TokenType.RParen)) {
      do {
        const name = this.#parseIdentifier();
        this.#consume(TokenType.Colon, "Expected ':' for type annotation");
        const typeName = this.#parseIdentifier();
        params.push({
          type: NodeType.Parameter,
          name,
          typeAnnotation: {type: NodeType.TypeAnnotation, name: typeName.name},
        });
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(TokenType.RParen, "Expected ')'");

    // Optional return type
    let returnType: TypeAnnotation | undefined;
    if (this.#match(TokenType.Colon)) {
      const typeName = this.#parseIdentifier();
      returnType = {type: NodeType.TypeAnnotation, name: typeName.name};
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
    let left = this.#parseTerm();

    while (
      this.#match(
        TokenType.Less,
        TokenType.LessEquals,
        TokenType.Greater,
        TokenType.GreaterEquals,
      )
    ) {
      const operator = this.#previous().value;
      const right = this.#parseTerm();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
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
    let expr = this.#parsePrimary();

    while (true) {
      if (this.#match(TokenType.LParen)) {
        expr = this.#finishCall(expr);
      } else {
        break;
      }
    }

    return expr;
  }

  #finishCall(callee: Expression): CallExpression {
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
      arguments: args,
    };
  }

  #parsePrimary(): Expression {
    if (this.#match(TokenType.Number)) {
      return {type: NodeType.NumberLiteral, value: this.#previous().value};
    }
    if (this.#match(TokenType.String)) {
      return {type: NodeType.StringLiteral, value: this.#previous().value};
    }
    if (this.#match(TokenType.True)) {
      return {type: NodeType.BooleanLiteral, value: true};
    }
    if (this.#match(TokenType.False)) {
      return {type: NodeType.BooleanLiteral, value: false};
    }
    if (this.#match(TokenType.Identifier)) {
      return {type: NodeType.Identifier, name: this.#previous().value};
    }
    if (this.#match(TokenType.LParen)) {
      const expr = this.#parseExpression();
      this.#consume(TokenType.RParen, "Expected ')' after expression.");
      return expr;
    }

    throw new Error(
      `Unexpected token: ${this.#peek().type} at line ${this.#peek().line}`,
    );
  }

  #parseIdentifier(): Identifier {
    if (this.#match(TokenType.Identifier)) {
      return {type: NodeType.Identifier, name: this.#previous().value};
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
}
