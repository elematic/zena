import {
  NodeType,
  type AccessorDeclaration,
  type ClassDeclaration,
  type IfStatement,
  type InterfaceDeclaration,
  type MethodDefinition,
  type ReturnStatement,
  type Statement,
  type VariableDeclaration,
  type WhileStatement,
} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  TypeKind,
  Types,
  type ClassType,
  type FunctionType,
  type InterfaceType,
  type Type,
  type TypeParameterType,
} from '../types.js';
import type {CheckerContext} from './context.js';
import {checkExpression} from './expressions.js';
import {isAssignableTo, resolveTypeAnnotation, typeToString} from './types.js';

export function checkStatement(ctx: CheckerContext, stmt: Statement) {
  switch (stmt.type) {
    case NodeType.VariableDeclaration:
      checkVariableDeclaration(ctx, stmt as VariableDeclaration);
      break;
    case NodeType.ExpressionStatement:
      checkExpression(ctx, stmt.expression);
      break;
    case NodeType.BlockStatement:
      ctx.enterScope();
      for (const s of stmt.body) {
        checkStatement(ctx, s);
      }
      ctx.exitScope();
      break;
    case NodeType.ReturnStatement:
      checkReturnStatement(ctx, stmt as ReturnStatement);
      break;
    case NodeType.IfStatement:
      checkIfStatement(ctx, stmt as IfStatement);
      break;
    case NodeType.WhileStatement:
      checkWhileStatement(ctx, stmt as WhileStatement);
      break;
    case NodeType.ClassDeclaration:
      checkClassDeclaration(ctx, stmt as ClassDeclaration);
      break;
    case NodeType.InterfaceDeclaration:
      checkInterfaceDeclaration(ctx, stmt as InterfaceDeclaration);
      break;
  }
}

function checkIfStatement(ctx: CheckerContext, stmt: IfStatement) {
  const testType = checkExpression(ctx, stmt.test);
  if (
    testType.kind !== TypeKind.Boolean &&
    testType.kind !== TypeKind.Unknown
  ) {
    ctx.diagnostics.reportError(
      `Expected boolean condition in if statement, got ${typeToString(testType)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  checkStatement(ctx, stmt.consequent);
  if (stmt.alternate) {
    checkStatement(ctx, stmt.alternate);
  }
}

function checkWhileStatement(ctx: CheckerContext, stmt: WhileStatement) {
  const testType = checkExpression(ctx, stmt.test);
  if (
    testType.kind !== TypeKind.Boolean &&
    testType.kind !== TypeKind.Unknown
  ) {
    ctx.diagnostics.reportError(
      `Expected boolean condition in while statement, got ${typeToString(testType)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  checkStatement(ctx, stmt.body);
}

function checkReturnStatement(ctx: CheckerContext, stmt: ReturnStatement) {
  if (!ctx.currentFunctionReturnType) {
    ctx.diagnostics.reportError(
      'Return statement outside of function.',
      DiagnosticCode.ReturnOutsideFunction,
    );
    return;
  }

  const argType = stmt.argument
    ? checkExpression(ctx, stmt.argument)
    : Types.Void;

  if (ctx.currentFunctionReturnType.kind !== Types.Unknown.kind) {
    // If we know the expected return type, check against it
    if (!isAssignableTo(argType, ctx.currentFunctionReturnType)) {
      ctx.diagnostics.reportError(
        `Type mismatch: expected return type ${typeToString(ctx.currentFunctionReturnType)}, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }
  }
}

function checkVariableDeclaration(
  ctx: CheckerContext,
  decl: VariableDeclaration,
) {
  let type = checkExpression(ctx, decl.init);

  if (decl.typeAnnotation) {
    const explicitType = resolveTypeAnnotation(ctx, decl.typeAnnotation);
    if (!isAssignableTo(type, explicitType)) {
      ctx.diagnostics.reportError(
        `Type mismatch: expected ${typeToString(explicitType)}, got ${typeToString(type)}`,
        DiagnosticCode.TypeMismatch,
      );
    }
    type = explicitType;
  }

  ctx.declare(decl.identifier.name, type, decl.kind);
}

function checkClassDeclaration(ctx: CheckerContext, decl: ClassDeclaration) {
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
    const type = ctx.resolve(decl.superClass.name);
    if (!type) {
      ctx.diagnostics.reportError(
        `Unknown superclass '${decl.superClass.name}'.`,
        DiagnosticCode.SymbolNotFound,
      );
    } else if (type.kind !== TypeKind.Class) {
      ctx.diagnostics.reportError(
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
      if (!name.startsWith('#')) {
        classType.fields.set(name, type);
      }
    }
    // Inherit methods
    for (const [name, type] of superType.methods) {
      classType.methods.set(name, type);
    }
  }

  ctx.declare(className, classType);

  ctx.enterScope();
  for (const tp of typeParameters) {
    ctx.declare(tp.name, tp, 'let');
  }

  // Resolve default type parameters
  if (decl.typeParameters) {
    for (let i = 0; i < decl.typeParameters.length; i++) {
      const param = decl.typeParameters[i];
      if (param.default) {
        typeParameters[i].defaultType = resolveTypeAnnotation(
          ctx,
          param.default,
        );
      }
    }
  }

  // 1. First pass: Collect members to build the ClassType
  for (const member of decl.body) {
    if (member.type === NodeType.FieldDefinition) {
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);
      if (classType.fields.has(member.name.name)) {
        // Check if it's a redeclaration of an inherited field
        if (superType && superType.fields.has(member.name.name)) {
          // For now, allow shadowing if types match? Or disallow?
          // Let's disallow field shadowing for simplicity and safety.
          ctx.diagnostics.reportError(
            `Cannot redeclare field '${member.name.name}' in subclass '${className}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        } else {
          ctx.diagnostics.reportError(
            `Duplicate field '${member.name.name}' in class '${className}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        }
      }
      classType.fields.set(member.name.name, fieldType);
    } else if (member.type === NodeType.AccessorDeclaration) {
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);
      if (classType.fields.has(member.name.name)) {
        if (superType && superType.fields.has(member.name.name)) {
          ctx.diagnostics.reportError(
            `Cannot redeclare field '${member.name.name}' in subclass '${className}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        } else {
          ctx.diagnostics.reportError(
            `Duplicate field '${member.name.name}' in class '${className}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        }
      }
      classType.fields.set(member.name.name, fieldType);
    } else if (member.type === NodeType.MethodDefinition) {
      const paramTypes = member.params.map((p) =>
        resolveTypeAnnotation(ctx, p.typeAnnotation),
      );
      const returnType = member.returnType
        ? resolveTypeAnnotation(ctx, member.returnType)
        : Types.Void;

      const methodType: FunctionType = {
        kind: TypeKind.Function,
        parameters: paramTypes,
        returnType,
      };

      if (member.name.name === '#new') {
        if (classType.constructorType) {
          ctx.diagnostics.reportError(
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
            if (typeToString(methodType) !== typeToString(superMethod)) {
              ctx.diagnostics.reportError(
                `Method '${member.name.name}' in '${className}' incorrectly overrides method in '${superType.name}'.`,
                DiagnosticCode.TypeMismatch,
              );
            }
          } else {
            ctx.diagnostics.reportError(
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
      const type = resolveTypeAnnotation(ctx, impl);
      if (type.kind !== TypeKind.Interface) {
        const name =
          impl.type === NodeType.TypeAnnotation ? impl.name : '<union>';
        ctx.diagnostics.reportError(
          `Type '${name}' is not an interface.`,
          DiagnosticCode.TypeMismatch,
        );
        continue;
      }
      const interfaceType = type as InterfaceType;
      classType.implements.push(interfaceType);

      // Check fields
      for (const [name, type] of interfaceType.fields) {
        if (!classType.fields.has(name)) {
          ctx.diagnostics.reportError(
            `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Property '${name}' is missing.`,
            DiagnosticCode.PropertyNotFound,
          );
        } else {
          const fieldType = classType.fields.get(name)!;
          if (typeToString(fieldType) !== typeToString(type)) {
            ctx.diagnostics.reportError(
              `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Property '${name}' is type '${typeToString(fieldType)}' but expected '${typeToString(type)}'.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }
      }

      // Check methods
      for (const [name, type] of interfaceType.methods) {
        if (!classType.methods.has(name)) {
          ctx.diagnostics.reportError(
            `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Method '${name}' is missing.`,
            DiagnosticCode.PropertyNotFound,
          );
        } else {
          const methodType = classType.methods.get(name)!;
          if (typeToString(methodType) !== typeToString(type)) {
            ctx.diagnostics.reportError(
              `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Method '${name}' is type '${typeToString(methodType)}' but expected '${typeToString(type)}'.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }
      }
    }
  }

  // 2. Second pass: Check method bodies
  const previousClass = ctx.currentClass;
  ctx.currentClass = classType;

  for (const member of decl.body) {
    if (member.type === NodeType.MethodDefinition) {
      checkMethodDefinition(ctx, member);
    } else if (member.type === NodeType.FieldDefinition) {
      if (member.value) {
        const valueType = checkExpression(ctx, member.value);
        const fieldType = classType.fields.get(member.name.name)!;
        if (
          valueType.kind !== fieldType.kind &&
          valueType.kind !== Types.Unknown.kind
        ) {
          if (typeToString(valueType) !== typeToString(fieldType)) {
            ctx.diagnostics.reportError(
              `Type mismatch for field '${member.name.name}': expected ${typeToString(fieldType)}, got ${typeToString(valueType)}`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }
      }
    } else if (member.type === NodeType.AccessorDeclaration) {
      checkAccessorDeclaration(ctx, member);
    }
  }

  ctx.currentClass = previousClass;
  ctx.exitScope();
}

function checkInterfaceDeclaration(
  ctx: CheckerContext,
  decl: InterfaceDeclaration,
) {
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
  ctx.declare(interfaceName, interfaceType);

  // Enter scope for type parameters
  ctx.enterScope();
  if (interfaceType.typeParameters) {
    for (const param of interfaceType.typeParameters) {
      ctx.declare(param.name, param);
    }
  }

  for (const member of decl.body) {
    if (member.type === NodeType.MethodSignature) {
      const paramTypes: Type[] = [];
      for (const param of member.params) {
        const type = resolveTypeAnnotation(ctx, param.typeAnnotation);
        paramTypes.push(type);
      }

      let returnType: Type = Types.Void;
      if (member.returnType) {
        returnType = resolveTypeAnnotation(ctx, member.returnType);
      }

      const methodType: FunctionType = {
        kind: TypeKind.Function,
        parameters: paramTypes,
        returnType,
      };

      if (interfaceType.methods.has(member.name.name)) {
        ctx.diagnostics.reportError(
          `Duplicate method '${member.name.name}' in interface '${interfaceName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      } else {
        interfaceType.methods.set(member.name.name, methodType);
      }
    } else if (member.type === NodeType.FieldDefinition) {
      const type = resolveTypeAnnotation(ctx, member.typeAnnotation);
      if (interfaceType.fields.has(member.name.name)) {
        ctx.diagnostics.reportError(
          `Duplicate field '${member.name.name}' in interface '${interfaceName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      } else {
        interfaceType.fields.set(member.name.name, type);
      }
    }
  }

  ctx.exitScope();
}

function checkMethodDefinition(ctx: CheckerContext, method: MethodDefinition) {
  ctx.enterScope();

  // Declare parameters
  for (const param of method.params) {
    const type = resolveTypeAnnotation(ctx, param.typeAnnotation);
    ctx.declare(param.name.name, type, 'let');
  }

  const returnType = method.returnType
    ? resolveTypeAnnotation(ctx, method.returnType)
    : Types.Void;
  const previousReturnType = ctx.currentFunctionReturnType;
  ctx.currentFunctionReturnType = returnType;

  // Check body
  for (const stmt of method.body.body) {
    checkStatement(ctx, stmt);
  }

  ctx.currentFunctionReturnType = previousReturnType;
  ctx.exitScope();
}

function checkAccessorDeclaration(
  ctx: CheckerContext,
  decl: AccessorDeclaration,
) {
  const propertyType = resolveTypeAnnotation(ctx, decl.typeAnnotation);

  // Check getter
  if (decl.getter) {
    ctx.enterScope();
    const previousReturnType = ctx.currentFunctionReturnType;
    ctx.currentFunctionReturnType = propertyType;

    for (const stmt of decl.getter.body) {
      checkStatement(ctx, stmt);
    }

    ctx.currentFunctionReturnType = previousReturnType;
    ctx.exitScope();
  }

  // Check setter
  if (decl.setter) {
    ctx.enterScope();
    const previousReturnType = ctx.currentFunctionReturnType;
    ctx.currentFunctionReturnType = Types.Void;

    // Declare parameter
    ctx.declare(decl.setter.param.name, propertyType, 'let');

    for (const stmt of decl.setter.body.body) {
      checkStatement(ctx, stmt);
    }

    ctx.currentFunctionReturnType = previousReturnType;
    ctx.exitScope();
  }
}
