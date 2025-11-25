import {
  NodeType,
  type Program,
  type Statement,
  type Expression,
  type VariableDeclaration,
  type BinaryExpression,
  type FunctionExpression,
} from './ast.js';
import {TypeKind, Types, type Type, type FunctionType} from './types.js';

interface SymbolInfo {
  type: Type;
  kind: 'let' | 'var';
}

export class TypeChecker {
  #scopes: Map<string, SymbolInfo>[] = [];
  #errors: string[] = [];

  #program: Program;

  constructor(program: Program) {
    this.#program = program;
  }

  public check(): string[] {
    this.#errors = [];
    this.#scopes = [new Map()]; // Global scope

    for (const statement of this.#program.body) {
      this.#checkStatement(statement);
    }

    return this.#errors;
  }

  #enterScope() {
    this.#scopes.push(new Map());
  }

  #exitScope() {
    this.#scopes.pop();
  }

  #declare(name: string, type: Type, kind: 'let' | 'var' = 'let') {
    const scope = this.#scopes[this.#scopes.length - 1];
    if (scope.has(name)) {
      this.#errors.push(
        `Variable '${name}' is already declared in this scope.`,
      );
    }
    scope.set(name, {type, kind});
  }

  #resolve(name: string): Type | undefined {
    for (let i = this.#scopes.length - 1; i >= 0; i--) {
      if (this.#scopes[i].has(name)) {
        return this.#scopes[i].get(name)!.type;
      }
    }
    return undefined;
  }

  #checkStatement(stmt: Statement) {
    switch (stmt.type) {
      case NodeType.VariableDeclaration:
        this.#checkVariableDeclaration(stmt);
        break;
      case NodeType.ExpressionStatement:
        this.#checkExpression(stmt.expression);
        break;
      case NodeType.BlockStatement:
        this.#enterScope();
        for (const s of stmt.body) {
          this.#checkStatement(s);
        }
        this.#exitScope();
        break;
    }
  }

  #checkVariableDeclaration(decl: VariableDeclaration) {
    const initType = this.#checkExpression(decl.init);
    this.#declare(decl.identifier.name, initType, decl.kind);
  }

  #checkExpression(expr: Expression): Type {
    switch (expr.type) {
      case NodeType.NumberLiteral:
        return Types.I32; // Default to i32 for now
      case NodeType.StringLiteral:
        return Types.String;
      case NodeType.Identifier: {
        const type = this.#resolve(expr.name);
        if (!type) {
          this.#errors.push(`Variable '${expr.name}' not found.`);
          return Types.Unknown;
        }
        return type;
      }
      // TODO: Implement AssignmentExpression check
      // When checking assignment, verify that the variable is not 'let' (immutable).
      // const symbol = this.#resolveSymbol(expr.left.name);
      // if (symbol.kind === 'let') error("Cannot reassign immutable variable");
      
      case NodeType.BinaryExpression:
        return this.#checkBinaryExpression(expr);
      case NodeType.FunctionExpression:
        return this.#checkFunctionExpression(expr);
      case NodeType.CallExpression:
        // TODO: Implement call expression checking
        return Types.Unknown;
      default:
        return Types.Unknown;
    }
  }

  #checkBinaryExpression(expr: BinaryExpression): Type {
    const left = this.#checkExpression(expr.left);
    const right = this.#checkExpression(expr.right);

    if (left === right) {
      return left;
    }

    if (left.kind === TypeKind.Number && right.kind === TypeKind.Number) {
      if ((left as any).name === (right as any).name) {
        return left;
      }
    }

    this.#errors.push(
      `Type mismatch: cannot apply operator '${expr.operator}' to ${this.#typeToString(left)} and ${this.#typeToString(right)}`,
    );
    return Types.Unknown;
  }

  #typeToString(type: Type): string {
    if (type.kind === TypeKind.Number) {
      return (type as any).name;
    }
    return type.kind;
  }

  #checkFunctionExpression(expr: FunctionExpression): Type {
    this.#enterScope();
    const paramTypes: Type[] = [];

    for (const param of expr.params) {
      // Resolve type annotation
      const typeName = param.typeAnnotation.name;
      let type: Type = Types.Unknown;
      if (typeName === 'i32') type = Types.I32;
      else if (typeName === 'f32') type = Types.F32;
      // ... other types

      this.#declare(param.name.name, type);
      paramTypes.push(type);
    }

    // Currently parser only supports expression body
    const bodyType = this.#checkExpression(expr.body as Expression);

    // Check return type if annotated
    if (expr.returnType) {
      const returnTypeName = expr.returnType.name;
      let expectedType: Type = Types.Unknown;
      if (returnTypeName === 'i32') expectedType = Types.I32;
      else if (returnTypeName === 'f32') expectedType = Types.F32;

      if (
        expectedType.kind !== Types.Unknown.kind &&
        bodyType.kind !== expectedType.kind
      ) {
        this.#errors.push(
          `Type mismatch: expected return type ${expectedType.kind}, got ${bodyType.kind}`,
        );
      }
    }

    this.#exitScope();

    return {
      kind: TypeKind.Function,
      parameters: paramTypes,
      returnType: bodyType,
    } as FunctionType;
  }
}
