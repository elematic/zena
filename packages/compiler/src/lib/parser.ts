import {
  NodeType,
  type AccessorDeclaration,
  type BlockStatement,
  type CallExpression,
  type ClassDeclaration,
  type Expression,
  type FieldDefinition,
  type FunctionExpression,
  type Identifier,
  type IfStatement,
  type IndexExpression,
  type InterfaceDeclaration,
  type MemberExpression,
  type MethodDefinition,
  type MethodSignature,
  type MixinDeclaration,
  type NamedTypeAnnotation,
  type Parameter,
  type Program,
  type ReturnStatement,
  type Statement,
  type TypeAnnotation,
  type TypeParameter,
  type UnionTypeAnnotation,
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
      if (this.#match(TokenType.Final)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'final'.");
        return this.#parseClassDeclaration(true, true);
      }
      if (this.#match(TokenType.Abstract)) {
        this.#consume(TokenType.Class, "Expected 'class' after 'abstract'.");
        return this.#parseClassDeclaration(true, false, true);
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
    if (this.#match(TokenType.Final)) {
      this.#consume(TokenType.Class, "Expected 'class' after 'final'.");
      return this.#parseClassDeclaration(false, true);
    }
    if (this.#match(TokenType.Abstract)) {
      this.#consume(TokenType.Class, "Expected 'class' after 'abstract'.");
      return this.#parseClassDeclaration(false, false, true);
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

    let typeAnnotation: TypeAnnotation | undefined;
    if (this.#match(TokenType.Colon)) {
      typeAnnotation = this.#parseTypeAnnotation();
    }

    this.#consume(TokenType.Equals, "Expected '=' after variable name.");
    const init = this.#parseExpression();
    this.#consume(TokenType.Semi, "Expected ';' after variable declaration.");

    return {
      type: NodeType.VariableDeclaration,
      kind,
      identifier,
      typeAnnotation,
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
      return {type: NodeType.SuperExpression};
    }
    if (this.#match(TokenType.This)) {
      return {type: NodeType.ThisExpression};
    }
    if (this.#match(TokenType.Hash)) {
      if (this.#match(TokenType.LBracket)) {
        const elements: Expression[] = [];
        if (!this.#check(TokenType.RBracket)) {
          do {
            elements.push(this.#parseExpression());
          } while (this.#match(TokenType.Comma));
        }
        this.#consume(TokenType.RBracket, "Expected ']' after array elements.");
        return {type: NodeType.ArrayLiteral, elements};
      }
      throw new Error("Expected '[' after '#'.");
    }
    if (this.#match(TokenType.Number)) {
      const token = this.#previous();
      return {
        type: NodeType.NumberLiteral,
        value: parseFloat(token.value),
        raw: token.value,
      };
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
    if (this.#match(TokenType.Null)) {
      return {type: NodeType.NullLiteral};
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

  #parseClassDeclaration(
    exported: boolean,
    isFinal: boolean = false,
    isAbstract: boolean = false,
  ): ClassDeclaration {
    const name = this.#parseIdentifier();
    const typeParameters = this.#parseTypeParameters();

    let superClass: Identifier | undefined;
    if (this.#match(TokenType.Extends)) {
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
      if (isAbstract) {
        this.#consume(
          TokenType.Semi,
          "Expected ';' after abstract method signature.",
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
      return this.#parseAccessorDeclaration(name, typeAnnotation, isFinal);
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
    };
  }

  #parseAccessorDeclaration(
    name: Identifier,
    typeAnnotation: TypeAnnotation,
    isFinal: boolean,
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
    const left = this.#parseNamedTypeAnnotation();

    if (this.#match(TokenType.Pipe)) {
      const types: TypeAnnotation[] = [left];
      do {
        types.push(this.#parseNamedTypeAnnotation());
      } while (this.#match(TokenType.Pipe));

      return {
        type: NodeType.UnionTypeAnnotation,
        types,
      };
    }

    return left;
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
