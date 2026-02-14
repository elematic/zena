import {
  NodeType,
  type AccessorDeclaration,
  type AccessorSignature,
  type BindingProperty,
  type BlockStatement,
  type BreakStatement,
  type CallExpression,
  type CatchClause,
  type ClassDeclaration,
  type ContinueStatement,
  type Decorator,
  type DeclareFunction,
  type EnumDeclaration,
  type EnumMember,
  type Expression,
  type ExportAllDeclaration,
  type FieldDefinition,
  type ForInStatement,
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
  type LetPatternCondition,
  type LiteralTypeAnnotation,
  type MatchCase,
  type MatchExpression,
  type MemberExpression,
  type MethodDefinition,
  type MethodSignature,
  type MixinDeclaration,
  type Module,
  type NamedTypeAnnotation,
  type Parameter,
  type Pattern,
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
  type SymbolDeclaration,
  type SymbolPropertyName,
  type TaggedTemplateExpression,
  type TemplateElement,
  type TemplateLiteral,
  type TryExpression,
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
import {Decorators} from './types.js';

export interface ParserOptions {
  path?: string;
  isStdlib?: boolean;
}

export class Parser {
  #tokens: Token[];
  #current = 0;
  #source: string;
  #path: string;
  #isStdlib: boolean;

  constructor(source: string, options: ParserOptions = {}) {
    this.#source = source;
    this.#path = options.path ?? '<anonymous>';
    this.#isStdlib = options.isStdlib ?? false;
    this.#tokens = tokenize(source);
  }

  public parse(): Module {
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
      type: NodeType.Module,
      body,
      path: this.#path,
      isStdlib: this.#isStdlib,
      source: this.#source,
      imports: new Map(),
      exports: new Map(),
      diagnostics: [],
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
      if (this.#match(TokenType.Enum)) {
        return this.#parseEnumDeclaration(true, startToken);
      }
      if (this.#match(TokenType.Symbol)) {
        return this.#parseSymbolDeclaration(true, startToken);
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
    if (this.#match(TokenType.Break)) {
      return this.#parseBreakStatement();
    }
    if (this.#match(TokenType.Continue)) {
      return this.#parseContinueStatement();
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
    if (this.#match(TokenType.Enum)) {
      return this.#parseEnumDeclaration(false, startToken);
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
    if (this.#match(TokenType.Enum)) {
      return this.#parseEnumDeclaration(false, startToken);
    }
    if (this.#match(TokenType.Symbol)) {
      // Disambiguate `symbol name` vs `symbol + 1`
      if (this.#isIdentifier(this.#peek().type)) {
        return this.#parseSymbolDeclaration(false, startToken);
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
    // Before falling through to expression statement, check for common
    // variable declaration mistakes
    this.#checkForVariableDeclarationMistake();
    return this.#parseExpressionStatement();
  }

  /**
   * Detects common mistakes that look like variable declarations but use
   * incorrect keywords or misspellings. Provides helpful error messages.
   */
  #checkForVariableDeclarationMistake(): void {
    const current = this.#peek();
    if (current.type !== TokenType.Identifier) return;

    const name = current.value;
    const next = this.#peek(1);

    // Check if this looks like a variable declaration pattern:
    // `name identifier` or `name {` or `name [` or `name identifier =`
    const looksLikeVarDecl =
      this.#isIdentifier(next.type) ||
      next.type === TokenType.LBrace ||
      next.type === TokenType.LBracket;

    if (!looksLikeVarDecl) return;

    // Check for specific known mistakes
    if (name === 'const') {
      throw new Error(
        `'const' is not a keyword in Zena. Use 'let' for immutable bindings. ` +
          `(line ${current.line})`,
      );
    }

    // Check for misspellings of 'let'
    if (this.#isSimilarTo(name, 'let')) {
      throw new Error(
        `Unknown keyword '${name}'. Did you mean 'let'? (line ${current.line})`,
      );
    }

    // Check for misspellings of 'var'
    if (this.#isSimilarTo(name, 'var')) {
      throw new Error(
        `Unknown keyword '${name}'. Did you mean 'var'? (line ${current.line})`,
      );
    }

    // Check for wrong case of keywords (e.g., 'Let', 'Var', 'Symbol')
    const lowerName = name.toLowerCase();
    const keywordSuggestions: Record<string, string> = {
      let: 'let',
      var: 'var',
      class: 'class',
      interface: 'interface',
      type: 'type',
      enum: 'enum',
      mixin: 'mixin',
      symbol: 'symbol',
    };

    if (lowerName in keywordSuggestions && name !== lowerName) {
      throw new Error(
        `Keywords are case-sensitive. Did you mean '${keywordSuggestions[lowerName]}'? ` +
          `(line ${current.line})`,
      );
    }
  }

  /**
   * Checks if a string is similar to a target keyword (allowing for common typos).
   * Handles case differences, single character insertions, deletions, and substitutions.
   */
  #isSimilarTo(input: string, target: string): boolean {
    // Case-insensitive exact match is handled separately
    if (input.toLowerCase() === target) return false;

    // Check for edit distance of 1 (single character typo)
    return this.#editDistance(input.toLowerCase(), target) === 1;
  }

  /**
   * Computes the Levenshtein edit distance between two strings.
   */
  #editDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;

    // Early termination if difference is too large
    if (Math.abs(m - n) > 2) return Math.abs(m - n);

    const dp: number[][] = Array.from({length: m + 1}, () =>
      Array.from({length: n + 1}, () => 0),
    );

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }

    return dp[m][n];
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

  #parseEnumDeclaration(
    exported: boolean,
    startToken?: Token,
  ): EnumDeclaration {
    const actualStartToken = startToken || this.#previous();
    const name = this.#parseIdentifier();
    this.#consume(TokenType.LBrace, "Expected '{' after enum name.");
    const members: EnumMember[] = [];
    while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
      const memberName = this.#parseIdentifier();
      let initializer: Expression | undefined;
      if (this.#match(TokenType.Equals)) {
        initializer = this.#parseExpression();
      }

      // Calculate location for member
      // Start is memberName.loc.start
      // End is initializer.loc.end if exists, else memberName.loc.end
      // But we need indices for #loc if we use tokens, or we can construct SourceLocation manually.
      // this.#loc takes (start: Token | number, end: Token | number)

      // Since memberName is a Node, it has loc.
      // We can use the tokens we just consumed?
      // memberName was parsed by #parseIdentifier which consumes a token.
      // initializer was parsed by #parseExpression.

      // Let's just use the locs from the nodes.
      const start = memberName.loc!.start;
      const end = initializer ? initializer.loc!.end : memberName.loc!.end;

      // We need to reconstruct the full SourceLocation object or use a helper that takes indices.
      // Looking at existing code, #loc takes tokens or indices.
      // But here we have indices from the child nodes.

      // Let's assume we can just construct it.
      // Or better, let's track the start token of the member.
      // But #parseIdentifier consumes the token.

      // Let's look at how other nodes do it.
      // Usually they pass startToken.

      // For now, I'll just use a simplified loc construction or rely on the fact that I can get the previous token?
      // If I use `this.#previous()` after parsing identifier, that's the identifier token.

      // Let's try to be precise.
      // const memberStartToken = this.#peek(); // Before parsing identifier? No, we already parsed it.

      // Actually, #parseIdentifier returns a Node with loc.
      // I can just use that loc.

      const loc: SourceLocation = {
        start,
        end,
        line: memberName.loc!.line, // Approximate line
        column: memberName.loc!.column, // Approximate column
      };

      members.push({
        type: NodeType.EnumMember,
        name: memberName,
        initializer,
        loc,
      });

      if (!this.#check(TokenType.RBrace)) {
        this.#consume(TokenType.Comma, "Expected ',' after enum member.");
      }
    }
    this.#consume(TokenType.RBrace, "Expected '}' after enum body.");
    const endToken = this.#previous();
    return {
      type: NodeType.EnumDeclaration,
      name,
      members,
      exported,
      loc: this.#loc(actualStartToken, endToken),
    };
  }

  /**
   * Parse a symbol declaration: `symbol name;` or `export symbol name;`
   */
  #parseSymbolDeclaration(
    exported: boolean,
    startToken?: Token,
  ): SymbolDeclaration {
    const actualStartToken = startToken || this.#previous();
    const name = this.#parseIdentifier();
    this.#consume(TokenType.Semi, "Expected ';' after symbol declaration.");
    const endToken = this.#previous();
    return {
      type: NodeType.SymbolDeclaration,
      name,
      exported,
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
      pattern = this.#parseUnboxedTuplePattern();
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
      } else if (this.#check(TokenType.Dot)) {
        // Handle member expression patterns like EnumType.Member
        let expr: Identifier | MemberExpression = identifier;
        while (this.#match(TokenType.Dot)) {
          const property = this.#parseIdentifier();
          expr = {
            type: NodeType.MemberExpression,
            object: expr,
            property,
            loc: this.#loc(identifier, property),
          };
        }
        pattern = expr;
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

  /**
   * Parse an unboxed tuple pattern: (a, b) or (a, b, c)
   * Single element (a) is treated as grouping, not a tuple.
   */
  #parseUnboxedTuplePattern(): Pattern {
    const startToken = this.#previous(); // LParen was already consumed
    const elements: Pattern[] = [];

    if (!this.#check(TokenType.RParen)) {
      do {
        elements.push(this.#parsePattern());
      } while (this.#match(TokenType.Comma));
    }

    this.#consume(TokenType.RParen, "Expected ')' after pattern.");

    // Single element is just grouping: (x) -> x
    if (elements.length === 1) {
      return elements[0];
    }

    // Empty or 2+ elements is an unboxed tuple pattern
    if (elements.length === 0) {
      throw new Error('Empty unboxed tuple pattern is not allowed');
    }

    return {
      type: NodeType.UnboxedTuplePattern,
      elements,
      loc: this.#loc(startToken, this.#previous()),
    };
  }

  #isBlockEndedExpression(expression: Expression): boolean {
    if (expression.type === NodeType.MatchExpression) return true;
    if (expression.type === NodeType.TryExpression) return true;
    if (expression.type === NodeType.IfExpression) {
      const ifExpr = expression as IfExpression;
      if (ifExpr.alternate.type === NodeType.BlockStatement) return true;
      if (ifExpr.alternate.type === NodeType.IfExpression) {
        return this.#isBlockEndedExpression(ifExpr.alternate as Expression);
      }
      return false;
    }
    return false;
  }

  #parseExpressionStatement(): Statement {
    const startToken = this.#peek();
    const expression = this.#parseExpression();

    if (this.#isBlockEndedExpression(expression)) {
      if (this.#check(TokenType.Semi)) {
        this.#consume(TokenType.Semi, "Expected ';' after expression.");
      }
    } else {
      this.#consume(TokenType.Semi, "Expected ';' after expression.");
    }

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
    // (a) => ...  (contextual typing - no type annotation)
    // (a, b) => ...  (multiple params without types)
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

      // Case 3: (param) => ... or (param, ...) => ...
      // Contextual typing - parameter without type annotation
      if (this.#isIdentifier(this.#peek(1).type)) {
        const afterIdent = this.#peek(2).type;
        // (x) followed by => or : (return type)
        if (afterIdent === TokenType.RParen) {
          const afterParen = this.#peek(3).type;
          if (
            afterParen === TokenType.Arrow ||
            afterParen === TokenType.Colon
          ) {
            return this.#parseArrowFunctionDefinition();
          }
        }
        // (x, ...) - multiple parameters without type annotations
        // Must verify there's an arrow or colon after the closing paren
        if (afterIdent === TokenType.Comma) {
          const closeOffset = this.#findMatchingParenOffset(0);
          if (closeOffset > 0) {
            const afterClose = this.#peek(closeOffset + 1).type;
            if (
              afterClose === TokenType.Arrow ||
              afterClose === TokenType.Colon
            ) {
              return this.#parseArrowFunctionDefinition();
            }
          }
        }
      }
    }

    return this.#parsePipeline();
  }

  #parsePipeline(): Expression {
    let left = this.#parseLogicalOr();

    while (this.#match(TokenType.PipeGreater)) {
      const right = this.#parseLogicalOr();
      left = {
        type: NodeType.PipelineExpression,
        left,
        right,
        loc: this.#loc(left, right),
      };
    }

    return left;
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

        // Type annotation is optional - allows contextual typing
        let typeAnnotation: TypeAnnotation | undefined;
        if (this.#match(TokenType.Colon)) {
          typeAnnotation = this.#parseTypeAnnotation();
        }

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
    let left = this.#parseShift();

    while (
      this.#match(
        TokenType.Less,
        TokenType.LessEquals,
        TokenType.Greater,
        TokenType.GreaterEquals,
      )
    ) {
      const operator = this.#previous().value;
      const right = this.#parseShift();
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

  #parseShift(): Expression {
    let left = this.#parseRange();

    while (
      this.#match(
        TokenType.LessLess,
        TokenType.GreaterGreater,
        TokenType.GreaterGreaterGreater,
      )
    ) {
      const operator = this.#previous().value;
      const right = this.#parseRange();
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

  #parseRange(): Expression {
    const startToken = this.#peek();

    // Handle prefix range: ..end or ..
    if (this.#match(TokenType.DotDot)) {
      if (
        this.#check(TokenType.Comma) ||
        this.#check(TokenType.Semi) ||
        this.#check(TokenType.RParen) ||
        this.#check(TokenType.RBracket) ||
        this.#check(TokenType.RBrace)
      ) {
        // .. with no end -> FullRange
        return {
          type: NodeType.RangeExpression,
          start: null,
          end: null,
          loc: this.#loc(startToken, this.#previous()),
        };
      } else {
        // ..end -> ToRange
        const end = this.#parseAs();
        return {
          type: NodeType.RangeExpression,
          start: null,
          end,
          loc: this.#loc(startToken, end),
        };
      }
    }

    let left = this.#parseAs();

    // Handle postfix range: start.. or bounded range: start..end
    if (this.#match(TokenType.DotDot)) {
      if (
        this.#check(TokenType.Comma) ||
        this.#check(TokenType.Semi) ||
        this.#check(TokenType.RParen) ||
        this.#check(TokenType.RBracket) ||
        this.#check(TokenType.RBrace)
      ) {
        // start.. with no end -> FromRange
        return {
          type: NodeType.RangeExpression,
          start: left,
          end: null,
          loc: this.#loc(left, this.#previous()),
        };
      } else {
        // start..end -> BoundedRange
        const end = this.#parseAs();
        return {
          type: NodeType.RangeExpression,
          start: left,
          end,
          loc: this.#loc(left, end),
        };
      }
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
          // Check for symbol member access: obj.:symbol or obj.:Iface.symbol
          if (this.#match(TokenType.Colon)) {
            // Parse the symbol path (could be simple like :mySymbol or qualified like :Iterable.iterator)
            let symbolPath: Expression = this.#parseIdentifier();
            while (this.#match(TokenType.Dot)) {
              const prop = this.#parseIdentifier();
              symbolPath = {
                type: NodeType.MemberExpression,
                object: symbolPath,
                property: prop,
              };
            }
            // Get the final property name for property field (last identifier in the path)
            let property: Identifier;
            if (symbolPath.type === NodeType.Identifier) {
              property = symbolPath;
            } else {
              property = (symbolPath as MemberExpression).property;
            }
            expr = {
              type: NodeType.MemberExpression,
              object: expr,
              property,
              isSymbolAccess: true,
              symbolPath,
              loc: this.#loc(expr, property),
            };
          } else {
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
          }
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
        // Check for symbol member access: obj.:symbol or obj.:Iface.symbol
        if (this.#match(TokenType.Colon)) {
          // Parse the symbol path (could be simple like :mySymbol or qualified like :Iterable.iterator)
          let symbolPath: Expression = this.#parseIdentifier();
          while (this.#match(TokenType.Dot)) {
            const prop = this.#parseIdentifier();
            symbolPath = {
              type: NodeType.MemberExpression,
              object: symbolPath,
              property: prop,
            };
          }
          // Get the final property name for property field (last identifier in the path)
          let property: Identifier;
          if (symbolPath.type === NodeType.Identifier) {
            property = symbolPath;
          } else {
            property = (symbolPath as MemberExpression).property;
          }
          expr = {
            type: NodeType.MemberExpression,
            object: expr,
            property,
            isSymbolAccess: true,
            symbolPath,
            loc: this.#loc(expr, property),
          };
        } else {
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
        }
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
    if (this.#match(TokenType.Try)) {
      return this.#parseTryExpression();
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
    // Check for pipeline placeholder ($)
    if (this.#isIdentifier(this.#peek().type) && this.#peek().value === '$') {
      const token = this.#advance();
      return {type: NodeType.PipePlaceholder, loc: this.#locFromToken(token)};
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
      return this.#parseParenthesizedExpression();
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
   * Parse try/catch/finally expression.
   * Syntax: try { ... } catch (e) { ... } finally { ... }
   */
  #parseTryExpression(): TryExpression {
    const startToken = this.#previous();

    this.#consume(TokenType.LBrace, "Expected '{' after 'try'.");
    const body = this.#parseBlockAsExpression();

    let handler: CatchClause | null = null;
    let finalizer: BlockStatement | null = null;

    if (this.#match(TokenType.Catch)) {
      const catchToken = this.#previous();
      let param: Identifier | null = null;

      if (this.#match(TokenType.LParen)) {
        param = this.#parseIdentifier();
        this.#consume(TokenType.RParen, "Expected ')' after catch parameter.");
      }

      this.#consume(TokenType.LBrace, "Expected '{' after catch.");
      const catchBody = this.#parseBlockAsExpression();

      handler = {
        type: NodeType.CatchClause,
        param,
        body: catchBody,
        loc: this.#loc(catchToken, catchBody),
      };
    }

    if (this.#match(TokenType.Finally)) {
      this.#consume(TokenType.LBrace, "Expected '{' after 'finally'.");
      finalizer = this.#parseBlockAsExpression();
    }

    if (!handler && !finalizer) {
      throw new Error("Expected 'catch' or 'finally' after try block.");
    }

    const endLoc = finalizer ?? handler!.body;
    return {
      type: NodeType.TryExpression,
      body,
      handler,
      finalizer,
      loc: this.#loc(startToken, endLoc),
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
    const token = this.#peek();
    throw new Error(
      `Expected identifier, got ${token.type} at ${this.#path}:${token.line}:${token.column}`,
    );
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

    // Check for let-pattern condition: if (let pattern = expr)
    const test = this.#match(TokenType.Let)
      ? this.#parseLetPatternCondition()
      : this.#parseExpression();

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

    // Check for let-pattern condition: while (let pattern = expr)
    const test = this.#match(TokenType.Let)
      ? this.#parseLetPatternCondition()
      : this.#parseExpression();

    this.#consume(TokenType.RParen, "Expected ')' after while condition.");

    const body = this.#parseStatement();

    return {
      type: NodeType.WhileStatement,
      test,
      body,
      loc: this.#loc(startToken, body),
    };
  }

  /**
   * Parse a let-pattern condition: `let pattern = expr`
   * Used in if/while conditions for pattern matching.
   * The `let` keyword has already been consumed.
   */
  #parseLetPatternCondition(): LetPatternCondition {
    const startToken = this.#previous(); // 'let' token

    // Parse the pattern
    const pattern = this.#parsePattern();

    // Expect '=' followed by expression
    this.#consume(
      TokenType.Equals,
      "Expected '=' after pattern in let condition.",
    );

    const init = this.#parseExpression();

    return {
      type: NodeType.LetPatternCondition,
      pattern,
      init,
      loc: this.#loc(startToken, init),
    };
  }

  #parseForStatement(): ForStatement | ForInStatement {
    const startToken = this.#previous();
    this.#consume(TokenType.LParen, "Expected '(' after 'for'.");

    // Check for for-in: `for (let pattern in iterable)`
    if (this.#match(TokenType.Let)) {
      // Could be for-in or C-style for with let declaration
      // Parse as pattern first, then check for 'in'
      const pattern = this.#parsePattern();

      if (this.#match(TokenType.In)) {
        // It's a for-in loop
        return this.#parseForInStatement(startToken, pattern);
      }

      // It's a C-style for with let declaration
      // We've already parsed the pattern, need to convert to variable declaration
      // This handles `for (let x = 0; ...)`
      this.#consume(
        TokenType.Equals,
        "Expected '=' or 'in' after pattern in for statement.",
      );
      const init = this.#parseExpression();

      // Build a variable declaration from the pattern
      const varDecl: VariableDeclaration = this.#patternToVariableDeclaration(
        pattern,
        init,
        'let',
        startToken,
      );

      return this.#parseCStyleForStatement(startToken, varDecl);
    }

    if (this.#match(TokenType.Var)) {
      // C-style for with var declaration
      const varDecl = this.#parseVariableDeclaration(false, false);
      return this.#parseCStyleForStatement(startToken, varDecl);
    }

    // Parse init as expression (or empty)
    let initExpr: Expression | undefined;
    if (!this.#check(TokenType.Semi)) {
      initExpr = this.#parseExpression();
    }

    return this.#parseCStyleForStatement(startToken, initExpr);
  }

  /**
   * Parse the rest of a for-in statement after `for (let pattern in`
   */
  #parseForInStatement(startToken: Token, pattern: Pattern): ForInStatement {
    const iterable = this.#parseExpression();
    this.#consume(TokenType.RParen, "Expected ')' after for-in iterable.");

    const body = this.#parseStatement();

    return {
      type: NodeType.ForInStatement,
      pattern,
      iterable,
      body,
      loc: this.#loc(startToken, body),
    };
  }

  /**
   * Convert a pattern back to a variable declaration for C-style for loops.
   * This is needed when we speculatively parsed a pattern but found `=` instead of `in`.
   */
  #patternToVariableDeclaration(
    pattern: Pattern,
    init: Expression,
    kind: 'let' | 'var',
    startToken: Token,
  ): VariableDeclaration {
    // For now, only support identifier patterns in C-style for
    if (pattern.type === NodeType.Identifier) {
      return {
        type: NodeType.VariableDeclaration,
        kind,
        pattern,
        init,
        exported: false,
        loc: this.#loc(startToken, init),
      };
    }
    throw new Error(
      'Destructuring patterns not supported in C-style for loops',
    );
  }

  /**
   * Parse the rest of a C-style for statement after the init clause.
   */
  #parseCStyleForStatement(
    startToken: Token,
    init?: VariableDeclaration | Expression,
  ): ForStatement {
    this.#consume(TokenType.Semi, "Expected ';' after for initializer.");

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

  #parseBreakStatement(): BreakStatement {
    const startToken = this.#previous();
    this.#consume(TokenType.Semi, "Expected ';' after break.");
    const endToken = this.#previous();
    return {
      type: NodeType.BreakStatement,
      loc: this.#loc(startToken, endToken),
    };
  }

  #parseContinueStatement(): ContinueStatement {
    const startToken = this.#previous();
    this.#consume(TokenType.Semi, "Expected ';' after continue.");
    const endToken = this.#previous();
    return {
      type: NodeType.ContinueStatement,
      loc: this.#loc(startToken, endToken),
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

    let superClass: TypeAnnotation | undefined;
    if (this.#match(TokenType.Extends)) {
      if (isExtension) {
        throw new Error('Extension classes cannot extend other classes.');
      }
      superClass = this.#parseTypeAnnotation();
    }

    const mixins: TypeAnnotation[] = [];
    if (this.#match(TokenType.With)) {
      do {
        mixins.push(this.#parseTypeAnnotation());
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

    const mixins: TypeAnnotation[] = [];
    if (this.#match(TokenType.With)) {
      do {
        mixins.push(this.#parseTypeAnnotation());
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

    // Check for common mistake: using `var` or `let` for class fields
    if (this.#check(TokenType.Var) || this.#check(TokenType.Let)) {
      const keyword = this.#peek().value;
      throw new Error(
        `Class fields don't use '${keyword}'. ` +
          `Remove '${keyword}' to declare a field directly: \`name: Type\``,
      );
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

    let name: Identifier | SymbolPropertyName;
    // Symbol member: :symbolName or :Iface.symbolName for methods
    if (this.#match(TokenType.Colon)) {
      const start = this.#previous();
      // Parse a primary expression (identifier) and possibly member access
      let symbolExpr: Expression = this.#parseIdentifier();
      while (this.#match(TokenType.Dot)) {
        const prop = this.#parseIdentifier();
        symbolExpr = {
          type: NodeType.MemberExpression,
          object: symbolExpr,
          property: prop,
        };
      }
      name = {
        type: NodeType.SymbolPropertyName,
        symbol: symbolExpr,
        loc: this.#loc(start, this.#previous()),
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
        } else if (this.#match(TokenType.Plus)) {
          name = {type: NodeType.Identifier, name: '+'};
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
    name: Identifier | SymbolPropertyName,
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

    const body: (
      | FieldDefinition
      | MethodSignature
      | AccessorSignature
      | SymbolDeclaration
    )[] = [];
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
    | AccessorSignature
    | SymbolDeclaration {
    const startToken = this.#peek();

    // Handle static symbol declarations: static symbol iterator;
    // Only consume 'static' if followed by 'symbol' - otherwise 'static' is a field name
    if (
      this.#check(TokenType.Static) &&
      this.#peek(1).type === TokenType.Symbol
    ) {
      this.#advance(); // consume 'static'
      this.#advance(); // consume 'symbol'
      const name = this.#parseIdentifier();
      this.#consume(TokenType.Semi, "Expected ';' after symbol declaration.");
      return {
        type: NodeType.SymbolDeclaration,
        name,
        exported: false, // Interface symbols are always public
        loc: this.#loc(startToken, this.#previous()),
      };
    }

    let name: Identifier | SymbolPropertyName;
    // Symbol member: :symbolName or :Iface.symbolName for methods
    if (this.#match(TokenType.Colon)) {
      const start = this.#previous();
      // Parse a primary expression (identifier) and possibly member access
      let symbolExpr: Expression = this.#parseIdentifier();
      while (this.#match(TokenType.Dot)) {
        const prop = this.#parseIdentifier();
        symbolExpr = {
          type: NodeType.MemberExpression,
          object: symbolExpr,
          property: prop,
        };
      }
      name = {
        type: NodeType.SymbolPropertyName,
        symbol: symbolExpr,
        loc: this.#loc(start, this.#previous()),
      };
    } else if (this.#match(TokenType.Operator)) {
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
        } else if (this.#match(TokenType.Plus)) {
          name = {type: NodeType.Identifier, name: '+'};
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
      this.#consumeGreater("Expected '>' after type parameters.");
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
      this.#consumeGreater("Expected '>' after type arguments.");
      return args;
    }
    return undefined;
  }

  /**
   * Check if the token at offset can start a type annotation that is NOT ambiguous with an expression.
   * Used for look-ahead when disambiguating function types from unboxed tuples.
   *
   * Excludes literal tokens (Number, String, True, False) because they can also start expressions.
   * Also excludes LParen because (a, b) could be an unboxed tuple expression, not a type.
   * This means `(T1, T2) => 0` will be parsed as unboxed tuple + function body,
   * and `(T1, T2) => (a, b)` will be parsed as unboxed tuple + unboxed tuple expression body.
   *
   * @param offset Look-ahead offset (0 = current token, 1 = next token, etc.)
   */
  #canStartType(offset = 0): boolean {
    const t = this.#peek(offset).type;
    if (
      t === TokenType.Identifier ||
      t === TokenType.LBracket ||
      t === TokenType.This ||
      t === TokenType.Null
    ) {
      return true;
    }
    // LBrace could be a record type {x: T} or a block statement.
    // It's a type if the next token is an identifier (field name) or } (empty record).
    if (t === TokenType.LBrace) {
      const afterBrace = this.#peek(offset + 1).type;
      return (
        afterBrace === TokenType.Identifier || afterBrace === TokenType.RBrace
      );
    }
    return false;
  }

  /**
   * Parse a parenthesized type, which could be:
   * - Function type: (T1, T2) => R
   * - Unboxed tuple: (T1, T2)
   * - Grouping: (T)
   */
  #parseParenthesizedType(startToken: Token): TypeAnnotation {
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
    const endToken = this.#previous();
    // Check if this is a function type: (T1, T2) => R
    // We only consume '=>' if it's followed by something that looks like a type.
    // This distinguishes `(): (i32, i32) => 0` (unboxed tuple return, body `0`)
    // from `let f: (i32, i32) => i32` (function type).
    if (this.#check(TokenType.Arrow) && this.#canStartType(1)) {
      this.#advance(); // consume '=>'
      const returnType = this.#parseTypeAnnotation();
      return {
        type: NodeType.FunctionTypeAnnotation,
        params,
        returnType,
        loc: this.#loc(startToken, returnType),
      };
    } else if (params.length >= 2) {
      // Unboxed tuple type: (T1, T2)
      return {
        type: NodeType.UnboxedTupleTypeAnnotation,
        elementTypes: params,
        loc: this.#loc(startToken, endToken),
      };
    } else if (params.length === 1) {
      // Grouping parens: (T) just returns T
      return params[0];
    } else {
      // Empty parens () without => is an error
      throw new Error("Expected type annotation or '=>'");
    }
  }

  #parseTypeAnnotation(): TypeAnnotation {
    const startToken = this.#peek();
    let left: TypeAnnotation;
    if (this.#match(TokenType.LParen)) {
      left = this.#parseParenthesizedType(startToken);
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
        if (this.#match(TokenType.LParen)) {
          types.push(this.#parseParenthesizedType(this.#previous()));
        } else if (this.#match(TokenType.LBrace)) {
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
        // Support trailing comma
        if (this.#check(TokenType.RBrace)) break;
        const name = this.#parseIdentifier();
        const optional = this.#match(TokenType.Question);
        this.#consume(TokenType.Colon, "Expected ':'");
        const typeAnnotation = this.#parseTypeAnnotation();
        const prop: PropertySignature = {
          type: NodeType.PropertySignature,
          name,
          typeAnnotation,
          loc: this.#loc(name, typeAnnotation),
        };
        if (optional) prop.optional = true;
        properties.push(prop);
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

  /**
   * Parse a parenthesized expression, which could be:
   * - Grouping: (expr) -> returns the inner expression
   * - Unboxed tuple: (expr1, expr2) -> UnboxedTupleLiteral
   */
  #parseParenthesizedExpression(): Expression {
    const startToken = this.#previous(); // LParen was already consumed
    const elements: Expression[] = [];

    if (!this.#check(TokenType.RParen)) {
      do {
        elements.push(this.#parseExpression());
      } while (this.#match(TokenType.Comma));
    }

    this.#consume(TokenType.RParen, "Expected ')' after expression.");

    // Single element is just grouping: (x) -> x
    if (elements.length === 1) {
      return elements[0];
    }

    // Empty or 2+ elements is an unboxed tuple literal
    if (elements.length === 0) {
      throw new Error('Empty unboxed tuple expression is not allowed');
    }

    return {
      type: NodeType.UnboxedTupleLiteral,
      elements,
      loc: this.#loc(startToken, this.#previous()),
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

    // Check for `this` type
    if (this.#match(TokenType.This)) {
      const token = this.#previous();
      return {
        type: NodeType.ThisTypeAnnotation,
        loc: this.#loc(startToken, token),
      };
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
        if (d.name === Decorators.External) {
          if (d.args.length !== 2)
            throw new Error('@external expects 2 arguments');
          externalModule = d.args[0].value;
          externalName = d.args[1].value;
        } else if (d.name === Decorators.Intrinsic) {
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

  /**
   * Find the offset to the matching closing paren from a given start offset.
   * Returns the offset to the RParen token, or -1 if not found.
   * Assumes the token at startOffset is LParen.
   */
  #findMatchingParenOffset(startOffset: number): number {
    let depth = 1;
    let offset = startOffset + 1;
    while (depth > 0) {
      const token = this.#peek(offset);
      if (token.type === TokenType.EOF) return -1;
      if (token.type === TokenType.LParen) depth++;
      if (token.type === TokenType.RParen) depth--;
      offset++;
    }
    return offset - 1; // offset of the RParen
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
   * Helper to create a '>' token at a specific offset from a source token.
   */
  #createGreaterToken(source: Token, offset: number): Token {
    return {
      type: TokenType.Greater,
      value: '>',
      line: source.line,
      column: source.column + offset,
      start: source.start + offset,
      end: source.start + offset + 1,
    };
  }

  /**
   * Special version of consume for '>' that handles '>>' and '>>>' in type contexts.
   * When we expect '>' but encounter '>>' or '>>>', this consumes one '>' and
   * leaves the rest for subsequent parsing.
   */
  #consumeGreater(message: string): Token {
    const current = this.#peek();

    if (current.type === TokenType.Greater) {
      return this.#advance();
    } else if (current.type === TokenType.GreaterGreater) {
      // Replace '>>' with two '>' tokens
      const firstGreater = this.#createGreaterToken(current, 0);
      const secondGreater = this.#createGreaterToken(current, 1);
      this.#tokens[this.#current] = firstGreater;
      this.#tokens.splice(this.#current + 1, 0, secondGreater);
      return this.#advance();
    } else if (current.type === TokenType.GreaterGreaterGreater) {
      // Replace '>>>' with three '>' tokens
      const firstGreater = this.#createGreaterToken(current, 0);
      const secondGreater = this.#createGreaterToken(current, 1);
      const thirdGreater = this.#createGreaterToken(current, 2);
      this.#tokens[this.#current] = firstGreater;
      this.#tokens.splice(this.#current + 1, 0, secondGreater, thirdGreater);
      return this.#advance();
    }

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
