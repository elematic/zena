import {
  CONSTRUCTOR_NAME,
  NodeType,
  type AccessorDeclaration,
  type AccessorSignature,
  type ArrayLiteral,
  type BindingProperty,
  type BlockStatement,
  type BreakStatement,
  type CallExpression,
  type CaseClassParam,
  type CatchClause,
  type ClassDeclaration,
  type ContinueStatement,
  type Decorator,
  type DeclareFunction,
  type EnumDeclaration,
  type EnumMember,
  type Expression,
  type ExportAllDeclaration,
  type ExportFromDeclaration,
  type FieldDefinition,
  type FieldInitializer,
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
  type MapEntry,
  type MapLiteral,
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
  type SealedVariant,
  type SourceLocation,
  type SpreadElement,
  type Statement,
  type StringLiteral,
  type SuperInitializer,
  type SymbolDeclaration,
  type SymbolPropertyName,
  type TaggedTemplateExpression,
  type TemplateElement,
  type TemplateLiteral,
  type TryExpression,
  type TuplePattern,
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
  /**
   * Whether class fields are mutable by default.
   * - false (default): fields are immutable unless marked with `var`
   * - true: fields are mutable (legacy behavior for migration)
   */
  mutableFields?: boolean;
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
            false,
            startToken,
          );
        }
        this.#consume(TokenType.Class, "Expected 'class' after 'final'.");
        return this.#parseClassDeclaration(
          true,
          true,
          false,
          false,
          false,
          startToken,
        );
      }
      if (this.#match(TokenType.Sealed)) {
        const isAbstract = this.#match(TokenType.Abstract);
        this.#consume(TokenType.Class, "Expected 'class' after 'sealed'.");
        return this.#parseClassDeclaration(
          true,
          false,
          isAbstract,
          false,
          true,
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
          false,
          startToken,
        );
      }
      if (this.#match(TokenType.Class)) {
        return this.#parseClassDeclaration(
          true,
          false,
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
      if (this.#check(TokenType.LBrace)) {
        return this.#parseExportFromDeclaration(startToken);
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
          false,
          startToken,
        );
      }
      this.#current--;
    }
    if (this.#match(TokenType.Sealed)) {
      // Disambiguate `sealed class` vs `sealed + 1`
      if (this.#check(TokenType.Class) || this.#check(TokenType.Abstract)) {
        const isAbstract = this.#match(TokenType.Abstract);
        this.#consume(TokenType.Class, "Expected 'class' after 'sealed'.");
        return this.#parseClassDeclaration(
          false,
          false,
          isAbstract,
          false,
          true,
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
          false,
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
        const t = this.#peek();
        throw new Error(
          `${this.#path}:${t.line}: Expected 'let' or 'var' after 'export'. Got ${t.type}`,
        );
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
    } else if (this.#match(TokenType.LParen)) {
      pattern = this.#parseTupleOrInlineTuplePattern();
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

  /**
   * Parse a record destructuring in parameter position.
   * Supports combined syntax: {x: i32, y: i32} (type inline with name)
   * and shorthand syntax: {x, y} (contextual typing or separate annotation).
   * Returns both a RecordPattern and optionally a RecordTypeAnnotation.
   */
  #parseRecordParamPattern(): {
    pattern: RecordPattern;
    typeAnnotation?: RecordTypeAnnotation;
  } {
    const startToken = this.#previous(); // LBrace already consumed
    const bindingProps: BindingProperty[] = [];
    const typeSigs: PropertySignature[] = [];
    let hasTypeAnnotations = false;

    if (!this.#check(TokenType.RBrace)) {
      do {
        if (this.#check(TokenType.RBrace)) break;
        const propName = this.#parseIdentifier();
        let value: Pattern = propName;
        let propType: TypeAnnotation | undefined;

        if (this.#match(TokenType.As)) {
          value = this.#parseIdentifier();
        }

        if (this.#match(TokenType.Colon)) {
          propType = this.#parseTypeAnnotation();
          hasTypeAnnotations = true;
        }

        if (this.#match(TokenType.Equals)) {
          const defaultValue = this.#parseExpression();
          value = {
            type: NodeType.AssignmentPattern,
            left: value,
            right: defaultValue,
          };
        }

        bindingProps.push({
          type: NodeType.BindingProperty,
          name: propName,
          value,
        });

        if (propType) {
          typeSigs.push({
            type: NodeType.PropertySignature,
            name: propName,
            typeAnnotation: propType,
            loc: this.#loc(propName, propType),
          });
        }
      } while (this.#match(TokenType.Comma));
    }
    this.#consume(
      TokenType.RBrace,
      "Expected '}' after record parameter pattern.",
    );
    const endToken = this.#previous();
    const pattern: RecordPattern = {
      type: NodeType.RecordPattern,
      properties: bindingProps,
    };
    let typeAnnotation: RecordTypeAnnotation | undefined;
    if (hasTypeAnnotations) {
      typeAnnotation = {
        type: NodeType.RecordTypeAnnotation,
        properties: typeSigs,
        loc: this.#loc(startToken, endToken),
      };
    }
    return {pattern, typeAnnotation};
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
      } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RBrace));
    }
    this.#consume(TokenType.RBrace, "Expected '}' after record pattern.");
    return {
      type: NodeType.RecordPattern,
      properties,
    };
  }

  /**
   * Parse a tuple pattern: (a, b) or (a, b, c)
   * Single element (a) is treated as grouping, not a tuple.
   * Produces TuplePattern for boxed tuples; the checker will convert
   * to InlineTuplePattern when the value type is an inline tuple.
   */
  #parseTupleOrInlineTuplePattern(): Pattern {
    const startToken = this.#previous(); // LParen was already consumed
    const elements: (Pattern | null)[] = [];

    if (!this.#check(TokenType.RParen)) {
      do {
        // Trailing comma: stop before closing paren
        if (this.#check(TokenType.RParen)) break;
        // Support skipping: (a, , c) => [a, null, c]
        if (this.#check(TokenType.Comma)) {
          elements.push(null);
        } else {
          elements.push(this.#parsePattern());
        }
      } while (this.#match(TokenType.Comma));
    }

    this.#consume(TokenType.RParen, "Expected ')' after pattern.");

    // Single element is just grouping: (x) -> x
    if (elements.length === 1) {
      return elements[0]!;
    }

    // Empty or 2+ elements is a tuple pattern
    if (elements.length === 0) {
      throw new Error('Empty tuple pattern is not allowed');
    }

    return {
      type: NodeType.TuplePattern,
      elements,
      loc: this.#loc(startToken, this.#previous()),
    };
  }

  #isBlockEndedExpression(expression: Expression): boolean {
    if (expression.type === NodeType.MatchExpression) return true;
    if (expression.type === NodeType.TryExpression) return true;
    if (expression.type === NodeType.IfExpression) {
      const ifExpr = expression as IfExpression;
      if (!ifExpr.alternate) return true;
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

    const compoundOp = this.#matchCompoundAssignment();
    if (compoundOp) {
      const value = this.#parseAssignment();
      if (
        expr.type === NodeType.Identifier ||
        expr.type === NodeType.MemberExpression ||
        expr.type === NodeType.IndexExpression
      ) {
        return {
          type: NodeType.AssignmentExpression,
          left: expr as Identifier | MemberExpression | IndexExpression,
          operator: compoundOp,
          value,
          loc: this.#loc(expr, value),
        };
      }
      throw new Error('Invalid assignment target.');
    }

    return expr;
  }

  #matchCompoundAssignment(): '+' | '-' | '*' | '/' | '%' | null {
    if (this.#match(TokenType.PlusEquals)) return '+';
    if (this.#match(TokenType.MinusEquals)) return '-';
    if (this.#match(TokenType.StarEquals)) return '*';
    if (this.#match(TokenType.SlashEquals)) return '/';
    if (this.#match(TokenType.PercentEquals)) return '%';
    return null;
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

      // Case 2b: ({...}) => ... — destructured record parameter
      // Must disambiguate from parenthesized record literal: ({x: 1, y: 2})
      // After the matching }, check for : (type annotation), , (next param),
      // = (default value), or ) followed by => or : (return type)
      if (this.#peek(1).type === TokenType.LBrace) {
        const braceClose = this.#findMatchingBraceOffset(1);
        if (braceClose > 0) {
          const afterBrace = this.#peek(braceClose + 1).type;
          if (
            afterBrace === TokenType.Colon ||
            afterBrace === TokenType.Comma ||
            afterBrace === TokenType.Equals
          ) {
            return this.#parseArrowFunctionDefinition();
          }
          if (afterBrace === TokenType.RParen) {
            const afterParen = this.#peek(braceClose + 2).type;
            if (
              afterParen === TokenType.Arrow ||
              afterParen === TokenType.Colon
            ) {
              return this.#parseArrowFunctionDefinition();
            }
          }
        }
      }

      // Case 2c: (( ... ) — destructured tuple parameter
      // Disambiguate from nested parenthesized expression by checking for
      // pattern-like structure: (( ident , ... ): type OR ((ident, ...)) =>
      if (this.#peek(1).type === TokenType.LParen) {
        // Look for a tuple pattern: ((a, b): ...) or ((a, b)) => ...
        // A tuple pattern has identifier, comma inside inner parens
        if (
          this.#isIdentifier(this.#peek(2).type) &&
          this.#peek(3).type === TokenType.Comma
        ) {
          // Find the matching ) for the inner parens, then check for : or , or ) =>
          const innerCloseOffset = this.#findMatchingParenOffset(1);
          if (innerCloseOffset > 0) {
            const afterInner = this.#peek(innerCloseOffset + 1).type;
            if (
              afterInner === TokenType.Colon ||
              afterInner === TokenType.Comma ||
              afterInner === TokenType.Equals
            ) {
              return this.#parseArrowFunctionDefinition();
            }
            if (afterInner === TokenType.RParen) {
              const afterOuter = this.#peek(innerCloseOffset + 2).type;
              if (
                afterOuter === TokenType.Arrow ||
                afterOuter === TokenType.Colon
              ) {
                return this.#parseArrowFunctionDefinition();
              }
            }
          }
        }
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
      let destructIndex = 0;
      do {
        // Check for destructured parameter: { ... } or ( ... )
        let pattern: RecordPattern | TuplePattern | undefined;
        let combinedTypeAnnotation: RecordTypeAnnotation | undefined;
        let name: Identifier;

        if (this.#check(TokenType.LBrace)) {
          this.#advance(); // consume '{'
          const combined = this.#parseRecordParamPattern();
          pattern = combined.pattern;
          combinedTypeAnnotation = combined.typeAnnotation;
          name = {
            type: NodeType.Identifier,
            name: `$$destruct_${destructIndex++}`,
            loc: pattern.loc,
          };
        } else if (this.#check(TokenType.LParen)) {
          this.#advance(); // consume '('
          const tuplePattern = this.#parseTupleOrInlineTuplePattern();
          if (tuplePattern.type !== NodeType.TuplePattern) {
            throw new Error(
              'Expected tuple destructuring pattern with at least 2 elements.',
            );
          }
          pattern = tuplePattern as TuplePattern;
          name = {
            type: NodeType.Identifier,
            name: `$$destruct_${destructIndex++}`,
            loc: pattern.loc,
          };
        } else {
          name = this.#parseIdentifier();
        }

        let optional = false;
        if (this.#match(TokenType.Question)) {
          optional = true;
          seenOptional = true;
        }

        // Type annotation: explicit `:Type` after pattern, or combined from record param
        let typeAnnotation: TypeAnnotation | undefined;
        if (this.#match(TokenType.Colon)) {
          typeAnnotation = this.#parseTypeAnnotation();
        } else if (combinedTypeAnnotation) {
          typeAnnotation = combinedTypeAnnotation;
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
          pattern,
          typeAnnotation,
          optional,
          initializer,
        });
      } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RParen));
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

    while (
      this.#match(TokenType.PipePipe) ||
      this.#match(TokenType.QuestionQuestion)
    ) {
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
        } while (
          this.#match(TokenType.Comma) &&
          !this.#check(TokenType.RParen)
        );
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
              const hashToken = this.#previous();
              const id = this.#parseIdentifier();
              property = {
                type: NodeType.Identifier,
                name: '#' + id.name,
                loc: this.#loc(hashToken, id),
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
        } else if (this.#match(TokenType.QuestionDot)) {
          // Optional member access: expr?.property
          let property: Identifier;
          if (this.#match(TokenType.Hash)) {
            const hashToken = this.#previous();
            const id = this.#parseIdentifier();
            property = {
              type: NodeType.Identifier,
              name: '#' + id.name,
              loc: this.#loc(hashToken, id),
            };
          } else {
            property = this.#parseIdentifier();
          }
          expr = {
            type: NodeType.MemberExpression,
            object: expr,
            property,
            optional: true,
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
        } else if (this.#match(TokenType.QuestionLBracket)) {
          // Optional index access: expr?[index]
          const index = this.#parseExpression();
          this.#consume(TokenType.RBracket, "Expected ']' after index.");
          const endToken = this.#previous();
          expr = {
            type: NodeType.IndexExpression,
            object: expr,
            index,
            optional: true,
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
      } else if (this.#match(TokenType.QuestionLParen)) {
        // Optional call: expr?()
        expr = this.#finishCall(expr, undefined, true);
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
            const hashToken = this.#previous();
            const id = this.#parseIdentifier();
            property = {
              type: NodeType.Identifier,
              name: '#' + id.name,
              loc: this.#loc(hashToken, id),
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
      } else if (this.#match(TokenType.QuestionDot)) {
        // Optional member access: expr?.property
        let property: Identifier;
        if (this.#match(TokenType.Hash)) {
          const hashToken = this.#previous();
          const id = this.#parseIdentifier();
          property = {
            type: NodeType.Identifier,
            name: '#' + id.name,
            loc: this.#loc(hashToken, id),
          };
        } else {
          property = this.#parseIdentifier();
        }
        expr = {
          type: NodeType.MemberExpression,
          object: expr,
          property,
          optional: true,
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
      } else if (this.#match(TokenType.QuestionLBracket)) {
        // Optional index access: expr?[index]
        const index = this.#parseExpression();
        this.#consume(TokenType.RBracket, "Expected ']' after index.");
        const endToken = this.#previous();
        expr = {
          type: NodeType.IndexExpression,
          object: expr,
          index,
          optional: true,
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
    optional?: boolean,
  ): CallExpression {
    const args: Expression[] = [];
    if (!this.#check(TokenType.RParen)) {
      do {
        args.push(this.#parseExpression());
      } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RParen));
    }
    this.#consume(TokenType.RParen, "Expected ')' after arguments.");
    const endToken = this.#previous();

    return {
      type: NodeType.CallExpression,
      callee,
      optional,
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
    if (this.#match(TokenType.LBracket)) {
      return this.#parseArrayLiteral(this.#previous());
    }
    if (this.#match(TokenType.Number)) {
      const token = this.#previous();
      return {
        type: NodeType.NumberLiteral,
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
      return this.#parseRecordOrMapLiteral();
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

  #parseArrayLiteral(startToken: Token): ArrayLiteral {
    const elements: Expression[] = [];
    while (!this.#check(TokenType.RBracket) && !this.#isAtEnd()) {
      elements.push(this.#parseExpression());
      if (!this.#check(TokenType.RBracket)) {
        this.#consume(TokenType.Comma, "Expected ',' after array element.");
      }
    }
    this.#consume(TokenType.RBracket, "Expected ']' after array elements.");
    const endToken = this.#previous();
    return {
      type: NodeType.ArrayLiteral,
      elements,
      loc: this.#locFromRange(startToken, endToken),
    };
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

    // Check for let-pattern condition: if (let pattern = expr)
    const test = this.#match(TokenType.Let)
      ? this.#parseLetPatternCondition()
      : this.#parseExpression();

    this.#consume(TokenType.RParen, "Expected ')' after if condition.");

    let consequent: Expression | BlockStatement;
    if (this.#match(TokenType.LBrace)) {
      consequent = this.#parseBlockAsExpression();
    } else {
      consequent = this.#parseExpression();
    }

    let alternate: Expression | BlockStatement | null = null;
    if (this.#match(TokenType.Else)) {
      if (this.#match(TokenType.LBrace)) {
        alternate = this.#parseBlockAsExpression();
      } else if (this.#check(TokenType.If)) {
        // else if
        this.#advance();
        alternate = this.#parseIfExpression();
      } else {
        alternate = this.#parseExpression();
      }
    }

    return {
      type: NodeType.IfExpression,
      test,
      consequent,
      alternate,
      loc: this.#loc(startToken, alternate ?? consequent),
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
      // Block-ended expressions (if, match, try with block body) don't require semicolons
      if (!this.#isBlockEndedExpression(expr)) {
        this.#consume(TokenType.Semi, "Expected ';' after expression.");
      } else if (this.#check(TokenType.Semi)) {
        this.#advance();
      }
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
    isSealed: boolean = false,
    startToken?: Token,
  ): ClassDeclaration {
    const actualStartToken = startToken || this.#previous();
    const name = this.#parseIdentifier();
    const typeParameters = this.#parseTypeParameters();

    // Case class parameters: class Point(x: f64, y: f64)
    let caseParams: CaseClassParam[] | undefined;
    if (!isExtension && this.#match(TokenType.LParen)) {
      caseParams = [];
      if (!this.#check(TokenType.RParen)) {
        do {
          const paramStart = this.#peek();
          let mutability: 'let' | 'var' | undefined;
          if (this.#match(TokenType.Var)) {
            mutability = 'var';
          } else if (this.#match(TokenType.Let)) {
            mutability = 'let';
          }
          const paramName = this.#parseIdentifier();
          const optional = this.#match(TokenType.Question);
          this.#consume(
            TokenType.Colon,
            "Expected ':' after case class parameter name.",
          );
          const typeAnnotation = this.#parseTypeAnnotation();
          caseParams.push({
            type: NodeType.CaseClassParam,
            name: paramName,
            typeAnnotation,
            mutability,
            optional: optional || undefined,
            loc: this.#loc(paramStart, this.#previous()),
          });
        } while (
          this.#match(TokenType.Comma) &&
          !this.#check(TokenType.RParen)
        );
      }
      this.#consume(
        TokenType.RParen,
        "Expected ')' after case class parameters.",
      );
    }

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

    // Body is optional for case classes
    const body: (FieldDefinition | MethodDefinition | AccessorDeclaration)[] =
      [];
    const sealedVariants: SealedVariant[] = [];
    if (this.#match(TokenType.LBrace)) {
      while (!this.#check(TokenType.RBrace) && !this.#isAtEnd()) {
        // Parse `case` declarations inside sealed class bodies
        if (isSealed && this.#check(TokenType.Case)) {
          this.#parseSealedVariants(sealedVariants);
        } else {
          body.push(this.#parseClassMember());
        }
      }
      this.#consume(TokenType.RBrace, "Expected '}' after class body.");
    } else if (!caseParams) {
      this.#consume(TokenType.LBrace, "Expected '{' before class body.");
    }
    const endToken = this.#previous();

    return {
      type: NodeType.ClassDeclaration,
      name,
      typeParameters,
      caseParams,
      superClass,
      mixins: mixins.length > 0 ? mixins : undefined,
      implements: implementsList.length > 0 ? implementsList : undefined,
      body,
      exported,
      isFinal,
      isAbstract,
      isExtension,
      isSealed,
      sealedVariants: sealedVariants.length > 0 ? sealedVariants : undefined,
      onType,
      loc: this.#loc(actualStartToken, endToken),
    };
  }

  /**
   * Parse sealed variant declarations: `case A, B, C(x: i32)`
   * Each `case` keyword introduces one or more comma-separated variants.
   */
  #parseSealedVariants(variants: SealedVariant[]): void {
    this.#consume(TokenType.Case, "Expected 'case' for sealed variant.");
    do {
      const variantStart = this.#peek();
      const variantName = this.#parseIdentifier();
      let params: CaseClassParam[] | undefined;
      if (this.#match(TokenType.LParen)) {
        params = [];
        if (!this.#check(TokenType.RParen)) {
          do {
            const paramStart = this.#peek();
            let mutability: 'let' | 'var' | undefined;
            if (this.#match(TokenType.Var)) {
              mutability = 'var';
            } else if (this.#match(TokenType.Let)) {
              mutability = 'let';
            }
            const paramName = this.#parseIdentifier();
            const optional = this.#match(TokenType.Question);
            this.#consume(
              TokenType.Colon,
              "Expected ':' after sealed variant parameter name.",
            );
            const typeAnnotation = this.#parseTypeAnnotation();
            params.push({
              type: NodeType.CaseClassParam,
              name: paramName,
              typeAnnotation,
              mutability,
              optional: optional || undefined,
              loc: this.#loc(paramStart, this.#previous()),
            });
          } while (
            this.#match(TokenType.Comma) &&
            !this.#check(TokenType.RParen)
          );
        }
        this.#consume(
          TokenType.RParen,
          "Expected ')' after sealed variant parameters.",
        );
      }
      variants.push({
        type: NodeType.SealedVariant,
        name: variantName,
        params,
        loc: this.#loc(variantStart, this.#previous()),
      });
    } while (this.#match(TokenType.Comma));
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

    // Parse field mutability: bare or `let` (immutable) or `var` (mutable)
    // Syntax: `let name: Type`, `var name: Type`, `var(#setter) name: Type`
    let mutability: 'let' | 'var' | undefined;
    let setterName: Identifier | SymbolPropertyName | undefined;

    // Helper: check if `:` after let/var starts a symbol property name
    // `var :sym: Type` → Var, Colon, Ident, Colon → symbol field
    // `var: Type` → Var, Colon, Ident, Semi/Equals → field named 'var'
    const isSymbolFieldAfterKeyword = (offset: number) =>
      this.#peek(offset).type === TokenType.Colon &&
      this.#peek(offset + 1).type === TokenType.Identifier &&
      (this.#peek(offset + 2).type === TokenType.Colon ||
        this.#peek(offset + 2).type === TokenType.Dot);

    if (this.#check(TokenType.Let)) {
      // Disambiguate: `let name: Type` vs field named `let`
      // `let` followed by `:` or `(` or `<` means `let` is a name
      // Exception: `let :sym: Type` is a symbol field with let mutability
      if (
        (this.#peek(1).type !== TokenType.Colon ||
          isSymbolFieldAfterKeyword(1)) &&
        this.#peek(1).type !== TokenType.LParen &&
        this.#peek(1).type !== TokenType.Less
      ) {
        this.#advance();
        mutability = 'let';
      }
    } else if (this.#check(TokenType.Var)) {
      // Disambiguate: `var name: Type` or `var(#setter) name: Type` vs field named `var`
      // `var` followed by `:` or `<` means `var` is a name
      // Exception: `var :sym: Type` is a symbol field with var mutability
      // `var` followed by `(` could be setter syntax OR method named `var`
      // We check: `var(` followed by `#` or `:` is setter syntax
      const nextType = this.#peek(1).type;
      const isSetterSyntax =
        nextType === TokenType.LParen &&
        (this.#peek(2).type === TokenType.Hash ||
          this.#peek(2).type === TokenType.Colon ||
          (this.#peek(2).type === TokenType.Identifier &&
            this.#peek(2).value === 'set'));

      if (
        (nextType !== TokenType.Colon || isSymbolFieldAfterKeyword(1)) &&
        nextType !== TokenType.Less &&
        (nextType !== TokenType.LParen || isSetterSyntax)
      ) {
        this.#advance();
        mutability = 'var';

        // Check for var(setterName) syntax: var(#name) or var(set: #name)
        if (this.#match(TokenType.LParen)) {
          // Check for explicit `set:` prefix (optional)
          if (
            this.#check(TokenType.Identifier) &&
            this.#peek().value === 'set' &&
            this.#peek(1).type === TokenType.Colon
          ) {
            this.#advance(); // consume 'set'
            this.#advance(); // consume ':'
          }

          // Parse the setter name: #name or :Symbol.name
          if (this.#match(TokenType.Hash)) {
            const hashToken = this.#previous();
            const id = this.#parseIdentifier();
            setterName = {
              type: NodeType.Identifier,
              name: '#' + id.name,
              loc: this.#loc(hashToken, id),
            };
          } else if (this.#match(TokenType.Colon)) {
            // Symbol setter: var(:Sym.name) field
            const start = this.#previous();
            let symbolExpr: Expression = this.#parseIdentifier();
            while (this.#match(TokenType.Dot)) {
              const prop = this.#parseIdentifier();
              symbolExpr = {
                type: NodeType.MemberExpression,
                object: symbolExpr,
                property: prop,
              };
            }
            setterName = {
              type: NodeType.SymbolPropertyName,
              symbol: symbolExpr,
              loc: this.#loc(start, this.#previous()),
            };
          } else {
            // Public name as setter (e.g., var(name) name - unusual but valid)
            setterName = this.#parseIdentifier();
          }

          this.#consume(
            TokenType.RParen,
            "Expected ')' after setter name in var(...)",
          );
        }
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
        isAbstract: false,
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
      if (this.#isIdentifier(this.#peek().type) || this.#check(TokenType.New)) {
        const hashToken = this.#previous();
        const token = this.#advance();
        name = {
          type: NodeType.Identifier,
          name: '#' + token.value,
          loc: this.#locFromRange(hashToken, token),
        };
      } else {
        const token = this.#peek();
        throw new Error(
          `Expected identifier after '#' at ${this.#path}:${token.line}:${token.column}`,
        );
      }
    } else if (this.#match(TokenType.New)) {
      const token = this.#previous();
      name = {
        type: NodeType.Identifier,
        name: isStatic ? 'new' : CONSTRUCTOR_NAME,
        loc: this.#locFromToken(token),
      };
    } else if (this.#match(TokenType.Var) || this.#match(TokenType.Let)) {
      // Handle `var` or `let` as field names (when they appear without being a
      // mutability modifier - i.e., when followed by `:` like `var: i32`)
      const token = this.#previous();
      name = {
        type: NodeType.Identifier,
        name: token.value,
        loc: this.#locFromToken(token),
      };
    } else {
      name = this.#parseIdentifier();
    }

    const typeParameters = this.#parseTypeParameters();

    const isConstructorName =
      name.type === NodeType.Identifier && name.name === CONSTRUCTOR_NAME;

    // Method: name(params) { ... }
    if (this.#match(TokenType.LParen)) {
      const params: Parameter[] = [];
      if (!this.#check(TokenType.RParen)) {
        let seenOptional = false;
        let destructIndex = 0;
        do {
          // Check for `this.field` constructor parameter
          let isThisParam = false;
          if (
            isConstructorName &&
            this.#check(TokenType.This) &&
            this.#checkAhead(TokenType.Dot, 1)
          ) {
            this.#advance(); // consume 'this'
            this.#advance(); // consume '.'
            isThisParam = true;
          }

          // Check for destructured parameter: { ... } or ( ... )
          let pattern: RecordPattern | TuplePattern | undefined;
          let paramName: Identifier;

          if (!isThisParam && this.#check(TokenType.LBrace)) {
            this.#advance(); // consume '{'
            pattern = this.#parseRecordPattern();
            paramName = {
              type: NodeType.Identifier,
              name: `$$destruct_${destructIndex++}`,
              loc: pattern.loc,
            };
          } else if (!isThisParam && this.#check(TokenType.LParen)) {
            this.#advance(); // consume '('
            const tuplePattern = this.#parseTupleOrInlineTuplePattern();
            if (tuplePattern.type !== NodeType.TuplePattern) {
              throw new Error(
                'Expected tuple destructuring pattern with at least 2 elements.',
              );
            }
            pattern = tuplePattern as TuplePattern;
            paramName = {
              type: NodeType.Identifier,
              name: `$$destruct_${destructIndex++}`,
              loc: pattern.loc,
            };
          } else {
            paramName = this.#parseIdentifier();
          }

          let optional = false;
          if (this.#match(TokenType.Question)) {
            optional = true;
            seenOptional = true;
          }

          let typeAnnotation: TypeAnnotation | undefined;
          if (pattern) {
            this.#consume(
              TokenType.Colon,
              'Destructured parameters require a type annotation.',
            );
            typeAnnotation = this.#parseTypeAnnotation();
          } else if (!isThisParam) {
            this.#consume(TokenType.Colon, "Expected ':' for type annotation");
            typeAnnotation = this.#parseTypeAnnotation();
          } else if (this.#match(TokenType.Colon)) {
            // this.field params can have an optional explicit type annotation
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
            name: paramName,
            pattern,
            typeAnnotation,
            optional,
            initializer,
            isThisParam: isThisParam || undefined,
            loc: this.#loc(
              paramName,
              initializer || typeAnnotation || paramName,
            ),
          });
        } while (
          this.#match(TokenType.Comma) &&
          !this.#check(TokenType.RParen)
        );
      }
      this.#consume(TokenType.RParen, "Expected ')' after parameters.");

      // Parse initializer list for constructors: new(...) : field = expr, super(args) { }
      // Also supports private fields: new(...) : #field = expr { }
      // super(args) must be the last entry if present
      let initializerList: FieldInitializer[] | undefined;
      let superInitializer: SuperInitializer | undefined;
      const isConstructor = isConstructorName;

      // Check if we have an initializer list
      // Valid starts: `: field =`, `: #field =`, or `: super(`
      const hasInitializerList =
        isConstructor &&
        this.#check(TokenType.Colon) &&
        // Public field: `: field = expr` (field can be a contextual keyword like `type`)
        ((this.#isIdentifierAhead(1) &&
          this.#checkAhead(TokenType.Equals, 2)) ||
          // Private field: `: #field = expr`
          (this.#checkAhead(TokenType.Hash, 1) &&
            this.#isIdentifierAhead(2) &&
            this.#checkAhead(TokenType.Equals, 3)) ||
          // Super call: `: super(`
          (this.#checkAhead(TokenType.Super, 1) &&
            this.#checkAhead(TokenType.LParen, 2)));

      if (hasInitializerList) {
        this.#advance(); // consume ':'
        initializerList = [];

        // Parse field initializers until we hit super() or end
        while (
          !this.#check(TokenType.LBrace) &&
          !this.#check(TokenType.Super)
        ) {
          // Handle private fields (#fieldName)
          let isPrivate = false;
          let hashToken: Token | undefined;
          if (this.#check(TokenType.Hash)) {
            isPrivate = true;
            hashToken = this.#advance();
          }
          const fieldNameId = this.#parseIdentifier();
          const fieldName = isPrivate
            ? `#${fieldNameId.name}`
            : fieldNameId.name;
          const field: Identifier = {
            type: NodeType.Identifier,
            name: fieldName,
            loc: hashToken
              ? this.#loc(hashToken, fieldNameId)
              : fieldNameId.loc,
          };
          this.#consume(
            TokenType.Equals,
            "Expected '=' after field name in initializer list.",
          );
          const value = this.#parseExpression();
          initializerList.push({
            type: NodeType.FieldInitializer,
            field,
            value,
            loc: hashToken
              ? this.#loc(hashToken, value)
              : this.#loc(fieldNameId, value),
          });

          // If no comma, we're done with field initializers
          if (!this.#match(TokenType.Comma)) {
            break;
          }
        }

        // Parse super call if present (must be last)
        if (this.#check(TokenType.Super)) {
          const superToken = this.#advance();
          this.#consume(TokenType.LParen, "Expected '(' after 'super'.");
          const args: Expression[] = [];
          if (!this.#check(TokenType.RParen)) {
            do {
              args.push(this.#parseExpression());
            } while (
              this.#match(TokenType.Comma) &&
              !this.#check(TokenType.RParen)
            );
          }
          const rparen = this.#consume(
            TokenType.RParen,
            "Expected ')' after super arguments.",
          );
          superInitializer = {
            type: NodeType.SuperInitializer,
            arguments: args,
            loc: this.#loc(superToken, rparen),
          };
        }
      }

      // Synthesize FieldInitializer entries for this.field parameters
      const hasThisParams = params.some((p) => p.isThisParam);
      if (isConstructor && hasThisParams) {
        if (!initializerList) {
          initializerList = [];
        }
        // Prepend this.field assignments before any explicit initializer list entries
        const thisInits: FieldInitializer[] = [];
        for (const param of params) {
          if (!param.isThisParam) continue;
          thisInits.push({
            type: NodeType.FieldInitializer,
            field: {
              type: NodeType.Identifier,
              name: param.name.name,
              loc: param.name.loc,
            },
            value: {
              type: NodeType.Identifier,
              name: param.name.name,
              loc: param.name.loc,
            },
            loc: param.loc,
          });
        }
        initializerList = [...thisInits, ...initializerList];
      }

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
      } else if (isConstructor && this.#match(TokenType.Semi)) {
        body = {
          type: NodeType.BlockStatement,
          body: [],
          loc: this.#locFromToken(this.#previous()),
        };
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
        initializerList,
        superInitializer,
        isFinal,
        isAbstract,
        isStatic,
        isDeclare,
        decorators,
        loc: this.#loc(startToken, body || this.#previous()),
      };
    }

    if (isAbstract) {
      // Abstract fields: no storage, no initializer. Subclasses must provide
      // a concrete field (or case parameter) with the same name.
      // Syntax: `abstract loc: i32;` (read-only) or `abstract var loc: i32;` (writable)
      if (typeParameters) {
        throw new Error('Fields cannot have type parameters.');
      }
      if (setterName) {
        throw new Error('Abstract fields cannot have setter names.');
      }
      const isOptional = this.#match(TokenType.Question);
      this.#consume(TokenType.Colon, "Expected ':' after abstract field name.");
      const typeAnnotation = this.#parseTypeAnnotation();
      this.#consume(
        TokenType.Semi,
        "Expected ';' after abstract field declaration.",
      );

      return {
        type: NodeType.FieldDefinition,
        name,
        typeAnnotation,
        value: undefined,
        isFinal: false,
        isAbstract: true,
        isStatic: false,
        isDeclare: false,
        isOptional: isOptional || undefined,
        mutability,
        decorators,
        loc: this.#loc(startToken, this.#previous()),
      } as FieldDefinition;
    }

    if (typeParameters) {
      throw new Error('Fields cannot have type parameters.');
    }

    // Validate mutability and setter combinations
    if (setterName && mutability !== 'var') {
      throw new Error(
        'Setter name can only be specified with var fields: var(#name) field: Type',
      );
    }

    // Field: name: Type; or name?: Type; or name: Type = value; or name = value;
    const isOptional = this.#match(TokenType.Question);
    let typeAnnotation: TypeAnnotation | undefined;
    if (this.#match(TokenType.Colon)) {
      typeAnnotation = this.#parseTypeAnnotation();
    }

    if (typeAnnotation && this.#match(TokenType.LBrace)) {
      if (mutability || setterName) {
        throw new Error(
          'Field mutability (let/var) cannot be combined with accessor blocks.',
        );
      }
      if (isOptional) {
        throw new Error('Optional fields cannot have accessor blocks.');
      }
      return this.#parseAccessorDeclaration(
        name,
        typeAnnotation,
        isFinal,
        isStatic,
        decorators,
        startToken,
      );
    }

    if (isOptional && !typeAnnotation) {
      throw new Error(
        "Optional fields must have a type annotation: 'name?: Type'.",
      );
    }

    let value: Expression | undefined;
    if (this.#match(TokenType.Equals)) {
      value = this.#parseExpression();
    }

    if (!typeAnnotation && !value) {
      throw new Error(
        "Expected ':' for type annotation or '=' for initializer after field name.",
      );
    }

    this.#consume(TokenType.Semi, "Expected ';' after field declaration.");

    return {
      type: NodeType.FieldDefinition,
      name,
      typeAnnotation,
      value,
      isFinal,
      isAbstract: false,
      isStatic,
      isDeclare,
      isOptional: isOptional || undefined,
      decorators,
      mutability,
      setterName,
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

    // Check for `var` modifier on interface fields
    let mutableField = false;
    if (this.#check(TokenType.Var)) {
      mutableField = true;
      this.#advance();
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
      if (mutableField) {
        throw new Error("'var' modifier is not allowed on methods.");
      }
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
        } while (
          this.#match(TokenType.Comma) &&
          !this.#check(TokenType.RParen)
        );
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

    // Field: name: Type; or name?: Type;
    const isOptional = this.#match(TokenType.Question);
    this.#consume(TokenType.Colon, "Expected ':' after field name.");
    const typeAnnotation = this.#parseTypeAnnotation();

    if (this.#match(TokenType.LBrace)) {
      if (mutableField) {
        throw new Error(
          "'var' modifier is not allowed on accessor signatures.",
        );
      }
      if (isOptional) {
        throw new Error('Optional fields cannot have accessor blocks.');
      }
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
      mutability: mutableField ? ('var' as const) : undefined,
      isOptional: isOptional || undefined,
      isFinal: false,
      isAbstract: false,
      isStatic: false,
      isDeclare: false,
      decorators: [],
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
      } while (this.#match(TokenType.Comma) && !this.#checkGreater());
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
      } while (this.#match(TokenType.Comma) && !this.#checkGreater());
      this.#consumeGreater("Expected '>' after type arguments.");
      return args;
    }
    return undefined;
  }

  /**
  /**
   * Parse an inline type annotation: inline (T1, T2)
   * The 'inline' keyword has already been consumed.
   * Produces an InlineTupleTypeAnnotation.
   */
  #parseInlineTypeAnnotation(startToken: Token): TypeAnnotation {
    this.#consume(TokenType.LParen, "Expected '(' after 'inline'");
    const elementTypes: TypeAnnotation[] = [];
    if (!this.#check(TokenType.RParen)) {
      do {
        elementTypes.push(this.#parseTypeAnnotation());
      } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RParen));
    }
    this.#consume(TokenType.RParen, "Expected ')' after inline tuple types");
    const endToken = this.#previous();

    if (elementTypes.length < 2) {
      throw new Error('Inline tuple type must have at least 2 elements');
    }

    return {
      type: NodeType.InlineTupleTypeAnnotation,
      elementTypes,
      loc: this.#loc(startToken, endToken),
    };
  }

  /**
   * Parse a parenthesized type, which could be:
   * - Function type: (T1, T2) => R
   * - Grouping: (T)
   */
  #parseParenthesizedType(startToken: Token): TypeAnnotation {
    const params: TypeAnnotation[] = [];
    const paramNames: string[] = [];
    let hasNamedParams = false;
    if (!this.#check(TokenType.RParen)) {
      do {
        // Check for "Identifier :" (named parameter)
        if (
          this.#check(TokenType.Identifier) &&
          this.#peek(1).type === TokenType.Colon
        ) {
          paramNames.push(this.#advance().value); // consume identifier
          this.#advance(); // consume colon
          hasNamedParams = true;
        } else {
          paramNames.push('');
        }
        params.push(this.#parseTypeAnnotation());
      } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RParen));
    }
    this.#consume(TokenType.RParen, "Expected ')'");
    // Function type: requires named parameters (a: i32, b: i32) => R
    // or empty parameters () => R.
    // Unnamed (T1, T2) is always a tuple type, never a function type.
    // This eliminates the ambiguity between tuple return types and function types:
    //   (): (i32, i32) => expr   -- return type is tuple (i32, i32), body is expr
    //   (): (a: i32, b: i32) => i32 => expr  -- return type is function type
    const isFunctionType =
      this.#check(TokenType.Arrow) && (params.length === 0 || hasNamedParams);
    if (isFunctionType) {
      this.#advance(); // consume '=>'
      const returnType = this.#parseTypeAnnotation();
      return {
        type: NodeType.FunctionTypeAnnotation,
        paramNames: paramNames.length > 0 ? paramNames : [],
        params,
        returnType,
        loc: this.#loc(startToken, returnType),
      };
    } else if (params.length >= 2) {
      // (T1, T2) without named params — this is a boxed tuple type
      const endToken = this.#previous();
      return {
        type: NodeType.TupleTypeAnnotation,
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
    if (this.#match(TokenType.Inline)) {
      left = this.#parseInlineTypeAnnotation(startToken);
    } else if (this.#match(TokenType.LParen)) {
      left = this.#parseParenthesizedType(startToken);
    } else if (this.#match(TokenType.LBrace)) {
      left = this.#parseRecordTypeAnnotation(this.#previous());
    } else {
      left = this.#parsePrimaryTypeAnnotation();
    }

    if (this.#match(TokenType.Pipe)) {
      const types: TypeAnnotation[] = [left];
      do {
        if (this.#match(TokenType.Inline)) {
          types.push(this.#parseInlineTypeAnnotation(this.#previous()));
        } else if (this.#match(TokenType.LParen)) {
          types.push(this.#parseParenthesizedType(this.#previous()));
        } else if (this.#match(TokenType.LBrace)) {
          types.push(this.#parseRecordTypeAnnotation(this.#previous()));
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

  /**
   * Parse a brace-delimited literal, which could be:
   * - Record literal: {x: 1, y: 2} or {x, y} (shorthand)
   * - Map literal: {key => value, ...}
   *
   * Disambiguation:
   * - Empty `{}` → empty record
   * - `...` → record with spread
   * - `expr =>` → map literal
   * - `ident :` → record property
   * - `ident ,` or `ident }` → shorthand record property
   */
  #parseRecordOrMapLiteral(): RecordLiteral | MapLiteral {
    const startToken = this.#previous(); // LBrace was already consumed

    // Empty: {}
    if (this.#check(TokenType.RBrace)) {
      this.#advance();
      return {
        type: NodeType.RecordLiteral,
        properties: [],
        loc: this.#loc(startToken, this.#previous()),
      };
    }

    // Spread element: definitely a record
    if (this.#check(TokenType.DotDotDot)) {
      return this.#parseRecordLiteralContinue(startToken, []);
    }

    // Parse the first expression to determine the type
    const firstExpr = this.#parseExpression();

    // Check for map literal: expr =>
    if (this.#match(TokenType.Arrow)) {
      const firstValue = this.#parseExpression();
      const firstEntry: MapEntry = {
        type: NodeType.MapEntry,
        key: firstExpr,
        value: firstValue,
        loc: this.#loc(firstExpr, firstValue),
      };
      return this.#parseMapLiteralContinue(startToken, firstEntry);
    }

    // It's a record literal - convert first expression to property
    // First expression must be an identifier (for records)
    if (firstExpr.type !== NodeType.Identifier) {
      throw new Error(
        `Expected identifier for record property, got ${firstExpr.type} at line ${this.#peek().line}`,
      );
    }

    const name = firstExpr;
    let value: Expression;

    if (this.#match(TokenType.Colon)) {
      // Full property: {x: expr}
      value = this.#parseExpression();
    } else {
      // Shorthand: {x}
      value = name;
    }

    const firstProperty: PropertyAssignment = {
      type: NodeType.PropertyAssignment,
      name,
      value,
    };

    return this.#parseRecordLiteralContinue(startToken, [firstProperty]);
  }

  /**
   * Continue parsing a map literal after the first entry.
   */
  #parseMapLiteralContinue(
    startToken: Token,
    firstEntry: MapEntry,
  ): MapLiteral {
    const entries: MapEntry[] = [firstEntry];

    while (this.#match(TokenType.Comma)) {
      // Allow trailing comma
      if (this.#check(TokenType.RBrace)) break;

      const key = this.#parseExpression();
      this.#consume(TokenType.Arrow, "Expected '=>' in map literal");
      const value = this.#parseExpression();
      entries.push({
        type: NodeType.MapEntry,
        key,
        value,
        loc: this.#loc(key, value),
      });
    }

    this.#consume(TokenType.RBrace, "Expected '}' after map literal");
    const endToken = this.#previous();

    return {
      type: NodeType.MapLiteral,
      entries,
      loc: this.#loc(startToken, endToken),
    };
  }

  /**
   * Continue parsing a record literal after initial properties.
   */
  #parseRecordLiteralContinue(
    startToken: Token,
    initialProperties: (PropertyAssignment | SpreadElement)[],
  ): RecordLiteral {
    const properties = [...initialProperties];

    // If we have initial properties, check for comma before continuing
    if (properties.length > 0) {
      if (!this.#match(TokenType.Comma)) {
        // No more properties
        this.#consume(TokenType.RBrace, "Expected '}'");
        return {
          type: NodeType.RecordLiteral,
          properties,
          loc: this.#loc(startToken, this.#previous()),
        };
      }
      // Allow trailing comma
      if (this.#check(TokenType.RBrace)) {
        this.#advance();
        return {
          type: NodeType.RecordLiteral,
          properties,
          loc: this.#loc(startToken, this.#previous()),
        };
      }
    }

    // Parse remaining properties
    do {
      if (this.#match(TokenType.DotDotDot)) {
        const spreadStart = this.#previous();
        const argument = this.#parseExpression();
        properties.push({
          type: NodeType.SpreadElement,
          argument,
          loc: this.#loc(spreadStart, argument),
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
    } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RBrace));

    this.#consume(TokenType.RBrace, "Expected '}'");
    return {
      type: NodeType.RecordLiteral,
      properties,
      loc: this.#loc(startToken, this.#previous()),
    };
  }

  /**
   * Parse a parenthesized expression, which could be:
   * - Grouping: (expr) -> returns the inner expression
   * - Tuple literal: (expr1, expr2) -> TupleLiteral (boxed)
   */
  #parseParenthesizedExpression(): Expression {
    const startToken = this.#previous(); // LParen was already consumed
    const elements: Expression[] = [];

    if (!this.#check(TokenType.RParen)) {
      do {
        elements.push(this.#parseExpression());
      } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RParen));
    }

    this.#consume(TokenType.RParen, "Expected ')' after expression.");

    // Single element is just grouping: (x) -> x
    if (elements.length === 1) {
      return elements[0];
    }

    // Empty parens is not allowed
    if (elements.length === 0) {
      throw new Error('Empty tuple expression is not allowed');
    }

    // 2+ elements is a tuple literal
    return {
      type: NodeType.TupleLiteral,
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
      } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RParen));
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

  #parseExportFromDeclaration(startToken: Token): ExportFromDeclaration {
    const specifiers = this.#parseImportSpecifiers();
    this.#consume(TokenType.From, "Expected 'from' after export specifiers.");
    const moduleSpecifier = this.#parseStringLiteral();
    this.#consume(
      TokenType.Semi,
      "Expected ';' after export-from declaration.",
    );
    const endToken = this.#previous();
    return {
      type: NodeType.ExportFromDeclaration,
      specifiers,
      moduleSpecifier,
      loc: this.#loc(startToken, endToken),
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
      } while (this.#match(TokenType.Comma) && !this.#check(TokenType.RBrace));
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
        } while (
          this.#match(TokenType.Comma) &&
          !this.#check(TokenType.RParen)
        );
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

  #checkAhead(type: TokenType, distance: number): boolean {
    const index = this.#current + distance;
    if (index >= this.#tokens.length) return false;
    return this.#tokens[index].type === type;
  }

  #isIdentifierAhead(distance: number): boolean {
    const index = this.#current + distance;
    if (index >= this.#tokens.length) return false;
    return this.#isIdentifier(this.#tokens[index].type);
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

  #findMatchingBraceOffset(startOffset: number): number {
    let depth = 1;
    let offset = startOffset + 1;
    while (depth > 0) {
      const token = this.#peek(offset);
      if (token.type === TokenType.EOF) return -1;
      if (token.type === TokenType.LBrace) depth++;
      if (token.type === TokenType.RBrace) depth--;
      offset++;
    }
    return offset - 1; // offset of the RBrace
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
      `${this.#path}:${this.#peek().line}: ${message} Got ${this.#peek().type}`,
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

  #checkGreater(): boolean {
    return (
      this.#check(TokenType.Greater) ||
      this.#check(TokenType.GreaterGreater) ||
      this.#check(TokenType.GreaterGreaterGreater)
    );
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
      `${this.#path}:${this.#peek().line}: ${message} Got ${this.#peek().type}`,
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
