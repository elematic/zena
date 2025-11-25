import {
  NodeType,
  type Expression,
  type FunctionExpression,
  type Identifier,
  type Parameter,
  type Program,
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
    if (
      this.#match(TokenType.Let) ||
      this.#match(TokenType.Const) ||
      this.#match(TokenType.Var)
    ) {
      return this.#parseVariableDeclaration();
    }
    return this.#parseExpressionStatement();
  }

  #parseVariableDeclaration(): VariableDeclaration {
    const keyword = this.#previous();
    const kind =
      keyword.type === TokenType.Let
        ? 'let'
        : keyword.type === TokenType.Const
          ? 'const'
          : 'var';

    const identifier = this.#parseIdentifier();
    this.#consume(TokenType.Equals, "Expected '=' after variable name.");
    const init = this.#parseExpression();
    this.#consume(TokenType.Semi, "Expected ';' after variable declaration.");

    return {
      type: NodeType.VariableDeclaration,
      kind,
      identifier,
      init,
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
    return this.#parseArrowFunction();
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

    return this.#parseBinaryExpression();
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

    const body = this.#parseExpression(); // For now only expression bodies

    return {
      type: NodeType.FunctionExpression,
      params,
      returnType,
      body,
    };
  }

  #parseBinaryExpression(): Expression {
    let left = this.#parsePrimary();

    while (
      this.#match(
        TokenType.Plus,
        TokenType.Minus,
        TokenType.Star,
        TokenType.Slash,
      )
    ) {
      const operator = this.#previous().value;
      const right = this.#parsePrimary();
      left = {
        type: NodeType.BinaryExpression,
        left,
        operator,
        right,
      };
    }

    return left;
  }

  #parsePrimary(): Expression {
    if (this.#match(TokenType.Number)) {
      return {type: NodeType.NumberLiteral, value: this.#previous().value};
    }
    if (this.#match(TokenType.String)) {
      return {type: NodeType.StringLiteral, value: this.#previous().value};
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
