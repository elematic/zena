import {
  NodeType,
  type ArrayLiteral,
  type AssignmentExpression,
  type BinaryExpression,
  type CallExpression,
  type ClassDeclaration,
  type Expression,
  type FunctionExpression,
  type IfStatement,
  type IndexExpression,
  type InterfaceDeclaration,
  type MemberExpression,
  type MethodDefinition,
  type NewExpression,
  type Program,
  type ReturnStatement,
  type Statement,
  type ThisExpression,
  type TypeAnnotation,
  type VariableDeclaration,
  type WhileStatement
} from './ast.js';
import {DiagnosticBag, DiagnosticCode, type Diagnostic} from './diagnostics.js';
import {
  TypeKind,
  Types,
  type ArrayType,
  type ClassType,
  type FunctionType,
  type InterfaceType,
  type NumberType,
  type Type,
  type TypeParameterType,
} from './types.js';

interface SymbolInfo {
  type: Type;
  kind: 'let' | 'var';
}

export class TypeChecker {
  #scopes: Map<string, SymbolInfo>[] = [];
  #diagnostics = new DiagnosticBag();
  #currentFunctionReturnType: Type | null = null;
  #currentClass: ClassType | null = null;

  #program: Program;

  constructor(program: Program) {
    this.#program = program;
  }

  public check(): Diagnostic[] {
    this.#diagnostics.clear();
    this.#scopes = [new Map()]; // Global scope

    for (const statement of this.#program.body) {
      this.#checkStatement(statement);
    }

    return [...this.#diagnostics.diagnostics];
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
      this.#diagnostics.reportError(
        `Variable '${name}' is already declared in this scope.`,
        DiagnosticCode.DuplicateDeclaration,
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
      case NodeType.InterfaceDeclaration:
        this.#checkInterfaceDeclaration(stmt as InterfaceDeclaration);
        break;
    }
  }

  #checkIfStatement(stmt: IfStatement) {
    const testType = this.#checkExpression(stmt.test);
    if (
      testType.kind !== TypeKind.Boolean &&
      testType.kind !== TypeKind.Unknown
    ) {
      this.#diagnostics.reportError(
        `Expected boolean condition in if statement, got ${this.#typeToString(testType)}`,
        DiagnosticCode.TypeMismatch,
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
      this.#diagnostics.reportError(
        `Expected boolean condition in while statement, got ${this.#typeToString(testType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }

    this.#checkStatement(stmt.body);
  }

  #checkReturnStatement(stmt: ReturnStatement) {
    if (!this.#currentFunctionReturnType) {
      this.#diagnostics.reportError(
        'Return statement outside of function.',
        DiagnosticCode.ReturnOutsideFunction,
      );
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
          this.#diagnostics.reportError(
            `Type mismatch: expected return type ${this.#typeToString(this.#currentFunctionReturnType)}, got ${this.#typeToString(argType)}`,
            DiagnosticCode.TypeMismatch,
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
          this.#diagnostics.reportError(
            `Variable '${expr.name}' not found.`,
            DiagnosticCode.SymbolNotFound,
          );
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
      case NodeType.ArrayLiteral:
        return this.#checkArrayLiteral(expr as ArrayLiteral);
      case NodeType.IndexExpression:
        return this.#checkIndexExpression(expr as IndexExpression);
      default:
        return Types.Unknown;
    }
  }

  #checkCallExpression(expr: CallExpression): Type {
    const calleeType = this.#checkExpression(expr.callee);

    if (calleeType.kind !== TypeKind.Function) {
      this.#diagnostics.reportError(
        `Type mismatch: expected function, got ${this.#typeToString(calleeType)}`,
        DiagnosticCode.TypeMismatch,
      );
      return Types.Unknown;
    }

    const funcType = calleeType as FunctionType;

    if (expr.arguments.length !== funcType.parameters.length) {
      this.#diagnostics.reportError(
        `Expected ${funcType.parameters.length} arguments, got ${expr.arguments.length}`,
        DiagnosticCode.ArgumentCountMismatch,
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
          this.#diagnostics.reportError(
            `Type mismatch in argument ${i + 1}: expected ${this.#typeToString(paramType)}, got ${this.#typeToString(argType)}`,
            DiagnosticCode.TypeMismatch,
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
        this.#diagnostics.reportError(
          `Variable '${varName}' is not defined.`,
          DiagnosticCode.SymbolNotFound,
        );
        return Types.Unknown;
      }

      if (symbol.kind !== 'var') {
        this.#diagnostics.reportError(
          `Cannot assign to immutable variable '${varName}'.`,
          DiagnosticCode.InvalidAssignment,
        );
      }

      const valueType = this.#checkExpression(expr.value);
      if (
        symbol.type.kind !== valueType.kind &&
        symbol.type.kind !== Types.Unknown.kind
      ) {
        if (this.#typeToString(symbol.type) !== this.#typeToString(valueType)) {
          this.#diagnostics.reportError(
            `Type mismatch in assignment: expected ${this.#typeToString(symbol.type)}, got ${this.#typeToString(valueType)}`,
            DiagnosticCode.TypeMismatch,
          );
        }
      }

      return valueType;
    } else if (expr.left.type === NodeType.MemberExpression) {
      const memberExpr = expr.left as MemberExpression;
      const objectType = this.#checkExpression(memberExpr.object);

      if (objectType.kind !== TypeKind.Class) {
        if (objectType.kind !== Types.Unknown.kind) {
          this.#diagnostics.reportError(
            `Property assignment on non-class type '${this.#typeToString(objectType)}'.`,
            DiagnosticCode.TypeMismatch,
          );
        }
        return Types.Unknown;
      }

      const classType = objectType as ClassType;
      const memberName = memberExpr.property.name;

      if (!classType.fields.has(memberName)) {
        this.#diagnostics.reportError(
          `Field '${memberName}' does not exist on type '${classType.name}'.`,
          DiagnosticCode.PropertyNotFound,
        );
        return Types.Unknown;
      }

      const fieldType = classType.fields.get(memberName)!;
      const valueType = this.#checkExpression(expr.value);

      if (
        valueType.kind !== fieldType.kind &&
        valueType.kind !== Types.Unknown.kind
      ) {
        this.#diagnostics.reportError(
          `Type mismatch in assignment: expected ${this.#typeToString(fieldType)}, got ${this.#typeToString(valueType)}`,
          DiagnosticCode.TypeMismatch,
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
      this.#diagnostics.reportError(
        `Type mismatch: cannot apply operator '${expr.operator}' to ${this.#typeToString(left)} and ${this.#typeToString(right)}`,
        DiagnosticCode.TypeMismatch,
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
    switch (type.kind) {
      case TypeKind.Number:
        return (type as NumberType).name;
      case TypeKind.String:
        return 'string';
      case TypeKind.Boolean:
        return 'boolean';
      case TypeKind.Void:
        return 'void';
      case TypeKind.TypeParameter:
        return (type as TypeParameterType).name;
      case TypeKind.Function: {
        const fn = type as FunctionType;
        const params = fn.parameters
          .map((p) => this.#typeToString(p))
          .join(', ');
        return `(${params}) => ${this.#typeToString(fn.returnType)}`;
      }
      case TypeKind.Class: {
        const ct = type as ClassType;
        if (ct.typeArguments && ct.typeArguments.length > 0) {
          return `${ct.name}<${ct.typeArguments.map((t) => this.#typeToString(t)).join(', ')}>`;
        }
        return ct.name;
      }
      case TypeKind.Array:
        return `[${this.#typeToString((type as ArrayType).elementType)}]`;
      default:
        return type.kind;
    }
  }

  #checkFunctionExpression(expr: FunctionExpression): Type {
    this.#enterScope();

    const typeParameters: TypeParameterType[] = [];
    if (expr.typeParameters) {
      for (const param of expr.typeParameters) {
        const tp: TypeParameterType = {
          kind: TypeKind.TypeParameter,
          name: param.name,
        };
        typeParameters.push(tp);
        this.#declare(param.name, tp, 'let');
      }
    }

    const paramTypes: Type[] = [];

    for (const param of expr.params) {
      // Resolve type annotation
      const type = this.#resolveTypeAnnotation(param.typeAnnotation);
      this.#declare(param.name.name, type);
      paramTypes.push(type);
    }

    // Check return type if annotated
    let expectedType: Type = Types.Unknown;
    if (expr.returnType) {
      expectedType = this.#resolveTypeAnnotation(expr.returnType);
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
          this.#diagnostics.reportError(
            `Type mismatch: expected return type ${this.#typeToString(expectedType)}, got ${this.#typeToString(bodyType)}`,
            DiagnosticCode.TypeMismatch,
          );
        }
      }
    }

    this.#currentFunctionReturnType = previousReturnType;
    this.#exitScope();

    return {
      kind: TypeKind.Function,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      parameters: paramTypes,
      returnType: bodyType,
    } as FunctionType;
  }

  #checkClassDeclaration(decl: ClassDeclaration) {
    const className = decl.name.name;

    const typeParameters: TypeParameterType[] = [];
    if (decl.typeParameters) {
      for (const param of decl.typeParameters) {
        typeParameters.push({
          kind: TypeKind.TypeParameter,
          name: param.name,
        });
      }
    }

    let superType: ClassType | undefined;
    if (decl.superClass) {
      const type = this.#resolve(decl.superClass.name);
      if (!type) {
        this.#diagnostics.reportError(
          `Unknown superclass '${decl.superClass.name}'.`,
          DiagnosticCode.SymbolNotFound,
        );
      } else if (type.kind !== TypeKind.Class) {
        this.#diagnostics.reportError(
          `Superclass '${decl.superClass.name}' must be a class.`,
          DiagnosticCode.TypeMismatch,
        );
      } else {
        superType = type as ClassType;
      }
    }

    const classType: ClassType = {
      kind: TypeKind.Class,
      name: className,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      superType,
      implements: [],
      fields: new Map(),
      methods: new Map(),
      constructorType: undefined,
      vtable: superType ? [...superType.vtable] : [],
    };

    if (superType) {
      // Inherit fields
      for (const [name, type] of superType.fields) {
        classType.fields.set(name, type);
      }
      // Inherit methods
      for (const [name, type] of superType.methods) {
        classType.methods.set(name, type);
      }
    }

    this.#declare(className, classType);

    this.#enterScope();
    for (const tp of typeParameters) {
      this.#declare(tp.name, tp, 'let');
    }

    // 1. First pass: Collect members to build the ClassType
    for (const member of decl.body) {
      if (member.type === NodeType.FieldDefinition) {
        const fieldType = this.#resolveTypeAnnotation(member.typeAnnotation);
        if (classType.fields.has(member.name.name)) {
          // Check if it's a redeclaration of an inherited field
          if (superType && superType.fields.has(member.name.name)) {
            // For now, allow shadowing if types match? Or disallow?
            // Let's disallow field shadowing for simplicity and safety.
            this.#diagnostics.reportError(
              `Cannot redeclare field '${member.name.name}' in subclass '${className}'.`,
              DiagnosticCode.DuplicateDeclaration,
            );
          } else {
            this.#diagnostics.reportError(
              `Duplicate field '${member.name.name}' in class '${className}'.`,
              DiagnosticCode.DuplicateDeclaration,
            );
          }
        }
        classType.fields.set(member.name.name, fieldType);
      } else if (member.type === NodeType.MethodDefinition) {
        const paramTypes = member.params.map((p) =>
          this.#resolveTypeAnnotation(p.typeAnnotation),
        );
        const returnType = member.returnType
          ? this.#resolveTypeAnnotation(member.returnType)
          : Types.Void;

        const methodType: FunctionType = {
          kind: TypeKind.Function,
          parameters: paramTypes,
          returnType,
        };

        if (member.name.name === '#new') {
          if (classType.constructorType) {
            this.#diagnostics.reportError(
              `Duplicate constructor in class '${className}'.`,
              DiagnosticCode.DuplicateDeclaration,
            );
          }
          classType.constructorType = methodType;
        } else {
          if (!classType.methods.has(member.name.name)) {
            classType.vtable.push(member.name.name);
          }

          if (classType.methods.has(member.name.name)) {
            // Check for override
            if (superType && superType.methods.has(member.name.name)) {
              // Validate override
              const superMethod = superType.methods.get(member.name.name)!;
              // TODO: Check signature compatibility (covariant return, contravariant params)
              // For now, require exact match
              if (
                this.#typeToString(methodType) !==
                this.#typeToString(superMethod)
              ) {
                this.#diagnostics.reportError(
                  `Method '${member.name.name}' in '${className}' incorrectly overrides method in '${superType.name}'.`,
                  DiagnosticCode.TypeMismatch,
                );
              }
            } else {
              this.#diagnostics.reportError(
                `Duplicate method '${member.name.name}' in class '${className}'.`,
                DiagnosticCode.DuplicateDeclaration,
              );
            }
          }
          classType.methods.set(member.name.name, methodType);
        }
      }
    }

    // Check interface implementation
    if (decl.implements) {
      for (const impl of decl.implements) {
        const type = this.#resolveTypeAnnotation(impl);
        if (type.kind !== TypeKind.Interface) {
          this.#diagnostics.reportError(
            `Type '${impl.name}' is not an interface.`,
            DiagnosticCode.TypeMismatch,
          );
          continue;
        }
        const interfaceType = type as InterfaceType;
        classType.implements.push(interfaceType);

        // Check fields
        for (const [name, type] of interfaceType.fields) {
          if (!classType.fields.has(name)) {
            this.#diagnostics.reportError(
              `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Property '${name}' is missing.`,
              DiagnosticCode.PropertyNotFound,
            );
          } else {
            const fieldType = classType.fields.get(name)!;
            if (this.#typeToString(fieldType) !== this.#typeToString(type)) {
              this.#diagnostics.reportError(
                `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Property '${name}' is type '${this.#typeToString(fieldType)}' but expected '${this.#typeToString(type)}'.`,
                DiagnosticCode.TypeMismatch,
              );
            }
          }
        }

        // Check methods
        for (const [name, type] of interfaceType.methods) {
          if (!classType.methods.has(name)) {
            this.#diagnostics.reportError(
              `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Method '${name}' is missing.`,
              DiagnosticCode.PropertyNotFound,
            );
          } else {
            const methodType = classType.methods.get(name)!;
            if (this.#typeToString(methodType) !== this.#typeToString(type)) {
              this.#diagnostics.reportError(
                `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Method '${name}' is type '${this.#typeToString(methodType)}' but expected '${this.#typeToString(type)}'.`,
                DiagnosticCode.TypeMismatch,
              );
            }
          }
        }
      }
    }

    // 2. Second pass: Check method bodies
    const previousClass = this.#currentClass;
    this.#currentClass = classType;

    for (const member of decl.body) {
      if (member.type === NodeType.MethodDefinition) {
        this.#checkMethodDefinition(member);
      } else if (member.type === NodeType.FieldDefinition) {
        if (member.value) {
          const valueType = this.#checkExpression(member.value);
          const fieldType = classType.fields.get(member.name.name)!;
          if (
            valueType.kind !== fieldType.kind &&
            valueType.kind !== Types.Unknown.kind
          ) {
            if (
              this.#typeToString(valueType) !== this.#typeToString(fieldType)
            ) {
              this.#diagnostics.reportError(
                `Type mismatch for field '${member.name.name}': expected ${this.#typeToString(fieldType)}, got ${this.#typeToString(valueType)}`,
                DiagnosticCode.TypeMismatch,
              );
            }
          }
        }
      }
    }

    this.#currentClass = previousClass;
    this.#exitScope();
  }

  #checkInterfaceDeclaration(decl: InterfaceDeclaration) {
    const interfaceName = decl.name.name;

    const typeParameters: TypeParameterType[] = [];
    if (decl.typeParameters) {
      for (const param of decl.typeParameters) {
        typeParameters.push({
          kind: TypeKind.TypeParameter,
          name: param.name,
        });
      }
    }

    const interfaceType: InterfaceType = {
      kind: TypeKind.Interface,
      name: interfaceName,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      fields: new Map(),
      methods: new Map(),
    };

    // Register interface in current scope
    this.#declare(interfaceName, interfaceType);

    // Enter scope for type parameters
    this.#enterScope();
    if (interfaceType.typeParameters) {
      for (const param of interfaceType.typeParameters) {
        this.#declare(param.name, param);
      }
    }

    for (const member of decl.body) {
      if (member.type === NodeType.MethodSignature) {
        const paramTypes: Type[] = [];
        for (const param of member.params) {
          const type = this.#resolveTypeAnnotation(param.typeAnnotation);
          paramTypes.push(type);
        }

        let returnType: Type = Types.Void;
        if (member.returnType) {
          returnType = this.#resolveTypeAnnotation(member.returnType);
        }

        const methodType: FunctionType = {
          kind: TypeKind.Function,
          parameters: paramTypes,
          returnType,
        };

        if (interfaceType.methods.has(member.name.name)) {
          this.#diagnostics.reportError(
            `Duplicate method '${member.name.name}' in interface '${interfaceName}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        } else {
          interfaceType.methods.set(member.name.name, methodType);
        }
      } else if (member.type === NodeType.FieldDefinition) {
        const type = this.#resolveTypeAnnotation(member.typeAnnotation);
        if (interfaceType.fields.has(member.name.name)) {
          this.#diagnostics.reportError(
            `Duplicate field '${member.name.name}' in interface '${interfaceName}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        } else {
          interfaceType.fields.set(member.name.name, type);
        }
      }
    }

    this.#exitScope();
  }

  #checkMethodDefinition(method: MethodDefinition) {
    this.#enterScope();

    // Declare parameters
    for (const param of method.params) {
      const type = this.#resolveTypeAnnotation(param.typeAnnotation);
      this.#declare(param.name.name, type, 'let');
    }

    const returnType = method.returnType
      ? this.#resolveTypeAnnotation(method.returnType)
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

  #resolveTypeAnnotation(annotation: TypeAnnotation): Type {
    const name = annotation.name;
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
    }

    const type = this.#resolve(name);
    if (!type) {
      this.#diagnostics.reportError(
        `Unknown type '${name}'.`,
        DiagnosticCode.SymbolNotFound,
      );
      return Types.Unknown;
    }

    if (annotation.typeArguments && annotation.typeArguments.length > 0) {
      if (type.kind !== TypeKind.Class) {
        this.#diagnostics.reportError(
          `Type '${name}' is not generic.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }
      const classType = type as ClassType;
      if (!classType.typeParameters || classType.typeParameters.length === 0) {
        this.#diagnostics.reportError(
          `Type '${name}' is not generic.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }
      if (classType.typeParameters.length !== annotation.typeArguments.length) {
        this.#diagnostics.reportError(
          `Expected ${classType.typeParameters.length} type arguments, got ${annotation.typeArguments.length}.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }

      const typeArguments = annotation.typeArguments.map((arg) =>
        this.#resolveTypeAnnotation(arg),
      );
      return this.#instantiateGenericClass(classType, typeArguments);
    }

    return type;
  }

  #instantiateGenericClass(
    genericClass: ClassType,
    typeArguments: Type[],
  ): ClassType {
    const typeMap = new Map<string, Type>();
    genericClass.typeParameters!.forEach((param, index) => {
      typeMap.set(param.name, typeArguments[index]);
    });

    const substitute = (type: Type): Type => {
      if (type.kind === TypeKind.TypeParameter) {
        return typeMap.get((type as TypeParameterType).name) || type;
      }
      if (type.kind === TypeKind.Array) {
        return {
          ...type,
          elementType: substitute((type as ArrayType).elementType),
        } as ArrayType;
      }
      if (type.kind === TypeKind.Class) {
        const ct = type as ClassType;
        if (ct.typeArguments) {
          return {
            ...ct,
            typeArguments: ct.typeArguments.map(substitute),
          } as ClassType;
        }
      }
      return type;
    };

    const substituteFunction = (fn: FunctionType): FunctionType => {
      return {
        ...fn,
        parameters: fn.parameters.map(substitute),
        returnType: substitute(fn.returnType),
      };
    };

    const newFields = new Map<string, Type>();
    for (const [name, type] of genericClass.fields) {
      newFields.set(name, substitute(type));
    }

    const newMethods = new Map<string, FunctionType>();
    for (const [name, fn] of genericClass.methods) {
      newMethods.set(name, substituteFunction(fn));
    }

    return {
      ...genericClass,
      typeArguments,
      fields: newFields,
      methods: newMethods,
      constructorType: genericClass.constructorType
        ? substituteFunction(genericClass.constructorType)
        : undefined,
    };
  }

  #checkNewExpression(expr: NewExpression): Type {
    const className = expr.callee.name;
    const type = this.#resolve(className);

    if (!type || type.kind !== TypeKind.Class) {
      this.#diagnostics.reportError(
        `'${className}' is not a class.`,
        DiagnosticCode.SymbolNotFound,
      );
      return Types.Unknown;
    }

    let classType = type as ClassType;

    if (expr.typeArguments && expr.typeArguments.length > 0) {
      if (!classType.typeParameters || classType.typeParameters.length === 0) {
        this.#diagnostics.reportError(
          `Type '${className}' is not generic.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
      } else if (
        classType.typeParameters.length !== expr.typeArguments.length
      ) {
        this.#diagnostics.reportError(
          `Expected ${classType.typeParameters.length} type arguments, got ${expr.typeArguments.length}.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
      } else {
        const typeArguments = expr.typeArguments.map((arg) =>
          this.#resolveTypeAnnotation(arg),
        );
        classType = this.#instantiateGenericClass(classType, typeArguments);
      }
    } else if (
      classType.typeParameters &&
      classType.typeParameters.length > 0
    ) {
      this.#diagnostics.reportError(
        `Generic type '${className}' requires type arguments.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
      );
    }

    const constructor = classType.constructorType;

    if (!constructor) {
      if (expr.arguments.length > 0) {
        this.#diagnostics.reportError(
          `Class '${className}' has no constructor but arguments were provided.`,
          DiagnosticCode.ArgumentCountMismatch,
        );
      }
      return classType;
    }

    // Check arguments against constructor parameters
    if (expr.arguments.length !== constructor.parameters.length) {
      this.#diagnostics.reportError(
        `Expected ${constructor.parameters.length} arguments, got ${expr.arguments.length}`,
        DiagnosticCode.ArgumentCountMismatch,
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
          this.#diagnostics.reportError(
            `Type mismatch in argument ${i + 1}: expected ${this.#typeToString(paramType)}, got ${this.#typeToString(argType)}`,
            DiagnosticCode.TypeMismatch,
          );
        }
      }
    }

    return classType;
  }

  #checkMemberExpression(expr: MemberExpression): Type {
    const objectType = this.#checkExpression(expr.object);

    if (
      objectType.kind === TypeKind.Array ||
      objectType.kind === TypeKind.String
    ) {
      if (expr.property.name === 'length') {
        return Types.I32;
      }
    }

    if (objectType.kind !== TypeKind.Class) {
      if (objectType.kind !== Types.Unknown.kind) {
        this.#diagnostics.reportError(
          `Property access on non-class type '${this.#typeToString(objectType)}'.`,
          DiagnosticCode.TypeMismatch,
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

    this.#diagnostics.reportError(
      `Property '${memberName}' does not exist on type '${classType.name}'.`,
      DiagnosticCode.PropertyNotFound,
    );
    return Types.Unknown;
  }

  #checkThisExpression(expr: ThisExpression): Type {
    if (!this.#currentClass) {
      this.#diagnostics.reportError(
        `'this' can only be used inside a class.`,
        DiagnosticCode.UnknownError,
      );
      return Types.Unknown;
    }
    return this.#currentClass;
  }

  #checkArrayLiteral(expr: ArrayLiteral): Type {
    if (expr.elements.length === 0) {
      return {kind: TypeKind.Array, elementType: Types.Unknown} as ArrayType;
    }

    const firstType = this.#checkExpression(expr.elements[0]);
    for (let i = 1; i < expr.elements.length; i++) {
      const type = this.#checkExpression(expr.elements[i]);
      if (this.#typeToString(type) !== this.#typeToString(firstType)) {
        this.#diagnostics.reportError(
          `Array elements must be of the same type. Expected ${this.#typeToString(firstType)}, got ${this.#typeToString(type)}`,
          DiagnosticCode.TypeMismatch,
        );
      }
    }
    return {kind: TypeKind.Array, elementType: firstType} as ArrayType;
  }

  #checkIndexExpression(expr: IndexExpression): Type {
    const objectType = this.#checkExpression(expr.object);
    const indexType = this.#checkExpression(expr.index);

    if (
      indexType.kind !== TypeKind.Number ||
      (indexType as NumberType).name !== 'i32'
    ) {
      this.#diagnostics.reportError(
        `Array index must be i32, got ${this.#typeToString(indexType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }

    if (
      objectType.kind !== TypeKind.Array &&
      objectType.kind !== TypeKind.String
    ) {
      this.#diagnostics.reportError(
        `Index expression only supported on arrays or strings, got ${this.#typeToString(objectType)}`,
        DiagnosticCode.NotIndexable,
      );
      return Types.Unknown;
    }

    if (objectType.kind === TypeKind.String) {
      return Types.I32;
    }

    return (objectType as ArrayType).elementType;
  }
}
