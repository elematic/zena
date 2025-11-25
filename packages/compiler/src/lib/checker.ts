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
  type ClassDeclaration,
  type NewExpression,
  type MemberExpression,
  type ThisExpression,
  type FieldDefinition,
  type MethodDefinition,
} from './ast.js';
import {
  TypeKind,
  Types,
  type Type,
  type FunctionType,
  type ClassType,
} from './types.js';

interface SymbolInfo {
  type: Type;
  kind: 'let' | 'var';
}

export class TypeChecker {
  #scopes: Map<string, SymbolInfo>[] = [];
  #errors: string[] = [];
  #currentFunctionReturnType: Type | null = null;
  #currentClass: ClassType | null = null;

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
      case NodeType.ClassDeclaration:
        this.#checkClassDeclaration(stmt as ClassDeclaration);
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
      case NodeType.NewExpression:
        return this.#checkNewExpression(expr as NewExpression);
      case NodeType.MemberExpression:
        return this.#checkMemberExpression(expr as MemberExpression);
      case NodeType.ThisExpression:
        return this.#checkThisExpression(expr as ThisExpression);
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
    if (expr.left.type === NodeType.Identifier) {
      const varName = expr.left.name;
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
    } else if (expr.left.type === NodeType.MemberExpression) {
      const memberExpr = expr.left as MemberExpression;
      const objectType = this.#checkExpression(memberExpr.object);

      if (objectType.kind !== TypeKind.Class) {
        if (objectType.kind !== Types.Unknown.kind) {
          this.#errors.push(
            `Property assignment on non-class type '${this.#typeToString(objectType)}'.`,
          );
        }
        return Types.Unknown;
      }

      const classType = objectType as ClassType;
      const memberName = memberExpr.property.name;

      if (!classType.fields.has(memberName)) {
        this.#errors.push(
          `Field '${memberName}' does not exist on type '${classType.name}'.`,
        );
        return Types.Unknown;
      }

      const fieldType = classType.fields.get(memberName)!;
      const valueType = this.#checkExpression(expr.value);

      if (
        valueType.kind !== fieldType.kind &&
        valueType.kind !== Types.Unknown.kind
      ) {
        this.#errors.push(
          `Type mismatch in assignment: expected ${this.#typeToString(fieldType)}, got ${this.#typeToString(valueType)}`,
        );
      }

      return valueType;
    }
    return Types.Unknown;
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
    if (type.kind === TypeKind.Class) {
      return (type as ClassType).name;
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

  #checkClassDeclaration(decl: ClassDeclaration) {
    const className = decl.name.name;
    const fields = new Map<string, Type>();
    const methods = new Map<string, FunctionType>();
    let constructorType: FunctionType | undefined;

    // 1. First pass: Collect members to build the ClassType
    for (const member of decl.body) {
      if (member.type === NodeType.FieldDefinition) {
        const fieldType = this.#resolveType(member.typeAnnotation.name);
        if (fields.has(member.name.name)) {
          this.#errors.push(
            `Duplicate field '${member.name.name}' in class '${className}'.`,
          );
        }
        fields.set(member.name.name, fieldType);
      } else if (member.type === NodeType.MethodDefinition) {
        const paramTypes = member.params.map((p) =>
          this.#resolveType(p.typeAnnotation.name),
        );
        const returnType = member.returnType
          ? this.#resolveType(member.returnType.name)
          : Types.Void;

        const methodType: FunctionType = {
          kind: TypeKind.Function,
          parameters: paramTypes,
          returnType,
        };

        if (member.name.name === '#new') {
          if (constructorType) {
            this.#errors.push(`Duplicate constructor in class '${className}'.`);
          }
          constructorType = methodType;
        } else {
          if (methods.has(member.name.name)) {
            this.#errors.push(
              `Duplicate method '${member.name.name}' in class '${className}'.`,
            );
          }
          methods.set(member.name.name, methodType);
        }
      }
    }

    const classType: ClassType = {
      kind: TypeKind.Class,
      name: className,
      fields,
      methods,
      constructorType,
    };

    this.#declare(className, classType);

    // 2. Second pass: Check method bodies
    const previousClass = this.#currentClass;
    this.#currentClass = classType;

    for (const member of decl.body) {
      if (member.type === NodeType.MethodDefinition) {
        this.#checkMethodDefinition(member);
      } else if (member.type === NodeType.FieldDefinition) {
        if (member.value) {
          const valueType = this.#checkExpression(member.value);
          const fieldType = fields.get(member.name.name)!;
          if (
            valueType.kind !== fieldType.kind &&
            valueType.kind !== Types.Unknown.kind
          ) {
            this.#errors.push(
              `Type mismatch for field '${member.name.name}': expected ${this.#typeToString(fieldType)}, got ${this.#typeToString(valueType)}`,
            );
          }
        }
      }
    }

    this.#currentClass = previousClass;
  }

  #checkMethodDefinition(method: MethodDefinition) {
    this.#enterScope();

    // Declare parameters
    for (const param of method.params) {
      const type = this.#resolveType(param.typeAnnotation.name);
      this.#declare(param.name.name, type, 'let');
    }

    const returnType = method.returnType
      ? this.#resolveType(method.returnType.name)
      : Types.Void;
    const previousReturnType = this.#currentFunctionReturnType;
    this.#currentFunctionReturnType = returnType;

    // Check body
    for (const stmt of method.body.body) {
      this.#checkStatement(stmt);
    }

    this.#currentFunctionReturnType = previousReturnType;
    this.#exitScope();
  }

  #resolveType(name: string): Type {
    switch (name) {
      case 'i32':
        return Types.I32;
      case 'f32':
        return Types.F32;
      case 'boolean':
        return Types.Boolean;
      case 'string':
        return Types.String;
      case 'void':
        return Types.Void;
      default: {
        // Check if it's a class type
        const type = this.#resolve(name);
        if (type) return type;
        this.#errors.push(`Unknown type '${name}'.`);
        return Types.Unknown;
      }
    }
  }

  #checkNewExpression(expr: NewExpression): Type {
    const className = expr.callee.name;
    const type = this.#resolve(className);

    if (!type || type.kind !== TypeKind.Class) {
      this.#errors.push(`'${className}' is not a class.`);
      return Types.Unknown;
    }

    const classType = type as ClassType;
    const constructor = classType.constructorType;

    if (!constructor) {
      if (expr.arguments.length > 0) {
        this.#errors.push(
          `Class '${className}' has no constructor but arguments were provided.`,
        );
      }
      return classType;
    }

    // Check arguments against constructor parameters
    if (expr.arguments.length !== constructor.parameters.length) {
      this.#errors.push(
        `Expected ${constructor.parameters.length} arguments, got ${expr.arguments.length}`,
      );
    }

    for (
      let i = 0;
      i < Math.min(expr.arguments.length, constructor.parameters.length);
      i++
    ) {
      const argType = this.#checkExpression(expr.arguments[i]);
      const paramType = constructor.parameters[i];

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

    return classType;
  }

  #checkMemberExpression(expr: MemberExpression): Type {
    const objectType = this.#checkExpression(expr.object);

    if (objectType.kind !== TypeKind.Class) {
      if (objectType.kind !== Types.Unknown.kind) {
        this.#errors.push(
          `Property access on non-class type '${this.#typeToString(objectType)}'.`,
        );
      }
      return Types.Unknown;
    }

    const classType = objectType as ClassType;
    const memberName = expr.property.name;

    // Check fields
    if (classType.fields.has(memberName)) {
      return classType.fields.get(memberName)!;
    }

    // Check methods
    if (classType.methods.has(memberName)) {
      return classType.methods.get(memberName)!;
    }

    this.#errors.push(
      `Property '${memberName}' does not exist on type '${classType.name}'.`,
    );
    return Types.Unknown;
  }

  #checkThisExpression(expr: ThisExpression): Type {
    if (!this.#currentClass) {
      this.#errors.push(`'this' can only be used inside a class.`);
      return Types.Unknown;
    }
    return this.#currentClass;
  }
}
