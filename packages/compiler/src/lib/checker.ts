import {
  NodeType,
  type Program,
  type Statement,
  type Expression,
  type VariableDeclaration,
  type BinaryExpression,
  type FunctionExpression,
  type ReturnStatement,
  type IfStatement,
  type WhileStatement,
  type AssignmentExpression,
  type CallExpression,
} from './ast.js';
import {TypeKind, Types, type Type, type FunctionType} from './types.js';

interface SymbolInfo {
  type: Type;
  kind: 'let' | 'var';
}

export class TypeChecker {
  #scopes: Map<string, SymbolInfo>[] = [];
  #errors: string[] = [];
  #currentFunctionReturnType: Type | null = null;

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

  #resolveInfo(name: string): SymbolInfo | undefined {
    for (let i = this.#scopes.length - 1; i >= 0; i--) {
      if (this.#scopes[i].has(name)) {
        return this.#scopes[i].get(name)!;
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
      case NodeType.ReturnStatement:
        this.#checkReturnStatement(stmt as ReturnStatement);
        break;
      case NodeType.IfStatement:
        this.#checkIfStatement(stmt as IfStatement);
        break;
      case NodeType.WhileStatement:
        this.#checkWhileStatement(stmt as WhileStatement);
        break;
    }
  }

  #checkIfStatement(stmt: IfStatement) {
    const testType = this.#checkExpression(stmt.test);
    if (
      testType.kind !== TypeKind.Boolean &&
      testType.kind !== TypeKind.Unknown
    ) {
      this.#errors.push(
        `Expected boolean condition in if statement, got ${this.#typeToString(testType)}`,
      );
    }

    this.#checkStatement(stmt.consequent);
    if (stmt.alternate) {
      this.#checkStatement(stmt.alternate);
    }
  }

  #checkWhileStatement(stmt: WhileStatement) {
    const testType = this.#checkExpression(stmt.test);
    if (
      testType.kind !== TypeKind.Boolean &&
      testType.kind !== TypeKind.Unknown
    ) {
      this.#errors.push(
        `Expected boolean condition in while statement, got ${this.#typeToString(testType)}`,
      );
    }

    this.#checkStatement(stmt.body);
  }

  #checkReturnStatement(stmt: ReturnStatement) {
    if (!this.#currentFunctionReturnType) {
      this.#errors.push('Return statement outside of function.');
      return;
    }

    const argType = stmt.argument
      ? this.#checkExpression(stmt.argument)
      : Types.Void;

    if (this.#currentFunctionReturnType.kind !== Types.Unknown.kind) {
      // If we know the expected return type, check against it
      // TODO: Better type equality check
      if (this.#currentFunctionReturnType.kind !== argType.kind) {
        // Allow i32/f32 mismatch check if we had better type equality
        if (
          this.#typeToString(this.#currentFunctionReturnType) !==
          this.#typeToString(argType)
        ) {
          this.#errors.push(
            `Type mismatch: expected return type ${this.#typeToString(this.#currentFunctionReturnType)}, got ${this.#typeToString(argType)}`,
          );
        }
      }
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
      case NodeType.BooleanLiteral:
        return Types.Boolean;
      case NodeType.Identifier: {
        const type = this.#resolve(expr.name);
        if (!type) {
          this.#errors.push(`Variable '${expr.name}' not found.`);
          return Types.Unknown;
        }
        return type;
      }
      case NodeType.AssignmentExpression:
        return this.#checkAssignmentExpression(expr as AssignmentExpression);
      case NodeType.BinaryExpression:
        return this.#checkBinaryExpression(expr);
      case NodeType.FunctionExpression:
        return this.#checkFunctionExpression(expr);
      case NodeType.CallExpression:
        return this.#checkCallExpression(expr as CallExpression);
      default:
        return Types.Unknown;
    }
  }

  #checkCallExpression(expr: CallExpression): Type {
    const calleeType = this.#checkExpression(expr.callee);

    if (calleeType.kind !== TypeKind.Function) {
      this.#errors.push(
        `Type mismatch: expected function, got ${this.#typeToString(calleeType)}`,
      );
      return Types.Unknown;
    }

    const funcType = calleeType as FunctionType;

    if (expr.arguments.length !== funcType.parameters.length) {
      this.#errors.push(
        `Expected ${funcType.parameters.length} arguments, got ${expr.arguments.length}`,
      );
    }

    for (
      let i = 0;
      i < Math.min(expr.arguments.length, funcType.parameters.length);
      i++
    ) {
      const argType = this.#checkExpression(expr.arguments[i]);
      const paramType = funcType.parameters[i];

      if (
        argType.kind !== paramType.kind &&
        argType.kind !== Types.Unknown.kind
      ) {
        if (this.#typeToString(argType) !== this.#typeToString(paramType)) {
          this.#errors.push(
            `Type mismatch in argument ${i + 1}: expected ${this.#typeToString(paramType)}, got ${this.#typeToString(argType)}`,
          );
        }
      }
    }

    return funcType.returnType;
  }

  #checkAssignmentExpression(expr: AssignmentExpression): Type {
    const varName = expr.name.name;
    const symbol = this.#resolveInfo(varName);

    if (!symbol) {
      this.#errors.push(`Variable '${varName}' is not defined.`);
      return Types.Unknown;
    }

    if (symbol.kind !== 'var') {
      this.#errors.push(`Cannot assign to immutable variable '${varName}'.`);
    }

    const valueType = this.#checkExpression(expr.value);
    if (
      symbol.type.kind !== valueType.kind &&
      symbol.type.kind !== Types.Unknown.kind
    ) {
      if (this.#typeToString(symbol.type) !== this.#typeToString(valueType)) {
        this.#errors.push(
          `Type mismatch in assignment: expected ${this.#typeToString(symbol.type)}, got ${this.#typeToString(valueType)}`,
        );
      }
    }

    return valueType;
  }

  #checkBinaryExpression(expr: BinaryExpression): Type {
    const left = this.#checkExpression(expr.left);
    const right = this.#checkExpression(expr.right);

    let typesMatch = false;
    if (left === right) {
      typesMatch = true;
    } else if (
      left.kind === TypeKind.Number &&
      right.kind === TypeKind.Number
    ) {
      if ((left as any).name === (right as any).name) {
        typesMatch = true;
      }
    }

    if (!typesMatch) {
      this.#errors.push(
        `Type mismatch: cannot apply operator '${expr.operator}' to ${this.#typeToString(left)} and ${this.#typeToString(right)}`,
      );
      return Types.Unknown;
    }

    switch (expr.operator) {
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        return Types.Boolean;
      case '+':
      case '-':
      case '*':
      case '/':
        return left;
      default:
        return Types.Unknown;
    }
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

    // Check return type if annotated
    let expectedType: Type = Types.Unknown;
    if (expr.returnType) {
      const returnTypeName = expr.returnType.name;
      if (returnTypeName === 'i32') expectedType = Types.I32;
      else if (returnTypeName === 'f32') expectedType = Types.F32;
      else if (returnTypeName === 'void') expectedType = Types.Void;
    }

    const previousReturnType = this.#currentFunctionReturnType;
    this.#currentFunctionReturnType = expectedType;

    let bodyType: Type = Types.Unknown;
    if (expr.body.type === NodeType.BlockStatement) {
      this.#checkStatement(expr.body);
      // TODO: How to determine body type of block?
      // For now, we rely on return statements checking against expectedType.
      // If expectedType is Unknown (inferred), we need to infer from returns.
      // That's complex. Let's assume for now block bodies MUST have explicit return type or be void.
      bodyType = expectedType;
    } else {
      bodyType = this.#checkExpression(expr.body as Expression);

      if (
        expectedType.kind !== Types.Unknown.kind &&
        bodyType.kind !== expectedType.kind
      ) {
        if (this.#typeToString(expectedType) !== this.#typeToString(bodyType)) {
          this.#errors.push(
            `Type mismatch: expected return type ${this.#typeToString(expectedType)}, got ${this.#typeToString(bodyType)}`,
          );
        }
      }
    }

    this.#currentFunctionReturnType = previousReturnType;
    this.#exitScope();

    return {
      kind: TypeKind.Function,
      parameters: paramTypes,
      returnType: bodyType,
    } as FunctionType;
  }
}
