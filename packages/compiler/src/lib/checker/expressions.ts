import {
  NodeType,
  type ArrayLiteral,
  type AssignmentExpression,
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type IndexExpression,
  type MemberExpression,
  type NewExpression,
  type SuperExpression,
  type ThisExpression,
} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  TypeKind,
  Types,
  type ArrayType,
  type ClassType,
  type InterfaceType,
  type FunctionType,
  type NumberType,
  type Type,
  type TypeParameterType,
} from '../types.js';
import type {CheckerContext} from './context.js';
import {
  instantiateGenericClass,
  instantiateGenericFunction,
  resolveTypeAnnotation,
  typeToString,
  isAssignableTo,
} from './types.js';
import {checkStatement} from './statements.js';

export function checkExpression(ctx: CheckerContext, expr: Expression): Type {
  switch (expr.type) {
    case NodeType.NumberLiteral: {
      const lit = expr as any; // Cast to access raw if needed, or update AST type definition
      if (lit.raw && lit.raw.includes('.')) {
        return Types.F32;
      }
      return Types.I32;
    }
    case NodeType.StringLiteral: {
      const stringType = ctx.resolve('String');
      return stringType || Types.String;
    }
    case NodeType.BooleanLiteral:
      return Types.Boolean;
    case NodeType.NullLiteral:
      return Types.Null;
    case NodeType.Identifier: {
      const type = ctx.resolve(expr.name);
      if (!type) {
        ctx.diagnostics.reportError(
          `Variable '${expr.name}' not found.`,
          DiagnosticCode.SymbolNotFound,
        );
        return Types.Unknown;
      }
      return type;
    }
    case NodeType.AssignmentExpression:
      return checkAssignmentExpression(ctx, expr as AssignmentExpression);
    case NodeType.BinaryExpression:
      return checkBinaryExpression(ctx, expr as BinaryExpression);
    case NodeType.FunctionExpression:
      return checkFunctionExpression(ctx, expr as FunctionExpression);
    case NodeType.CallExpression:
      return checkCallExpression(ctx, expr as CallExpression);
    case NodeType.NewExpression:
      return checkNewExpression(ctx, expr as NewExpression);
    case NodeType.MemberExpression:
      return checkMemberExpression(ctx, expr as MemberExpression);
    case NodeType.ThisExpression:
      return checkThisExpression(ctx, expr as ThisExpression);
    case NodeType.SuperExpression:
      return checkSuperExpression(ctx, expr as SuperExpression);
    case NodeType.ArrayLiteral:
      return checkArrayLiteral(ctx, expr as ArrayLiteral);
    case NodeType.IndexExpression:
      return checkIndexExpression(ctx, expr as IndexExpression);
    default:
      return Types.Unknown;
  }
}

function checkCallExpression(ctx: CheckerContext, expr: CallExpression): Type {
  if (expr.callee.type === NodeType.SuperExpression) {
    if (!ctx.currentClass) {
      ctx.diagnostics.reportError(
        `'super' call can only be used inside a class constructor.`,
        DiagnosticCode.UnknownError,
      );
      return Types.Unknown;
    }
    if (ctx.currentMethod !== '#new') {
      ctx.diagnostics.reportError(
        `'super' call can only be used inside a class constructor.`,
        DiagnosticCode.UnknownError,
      );
      return Types.Unknown;
    }
    if (!ctx.currentClass.superType) {
      ctx.diagnostics.reportError(
        `Class '${ctx.currentClass.name}' does not have a superclass.`,
        DiagnosticCode.UnknownError,
      );
      return Types.Unknown;
    }

    const superClass = ctx.currentClass.superType;
    const constructor = superClass.constructorType;

    if (!constructor) {
      if (expr.arguments.length > 0) {
        ctx.diagnostics.reportError(
          `Superclass '${superClass.name}' has no constructor but arguments were provided.`,
          DiagnosticCode.ArgumentCountMismatch,
        );
      }
      ctx.isThisInitialized = true;
      return Types.Void;
    }

    if (expr.arguments.length !== constructor.parameters.length) {
      ctx.diagnostics.reportError(
        `Expected ${constructor.parameters.length} arguments, got ${expr.arguments.length}.`,
        DiagnosticCode.ArgumentCountMismatch,
      );
    }

    for (
      let i = 0;
      i < Math.min(expr.arguments.length, constructor.parameters.length);
      i++
    ) {
      const argType = checkExpression(ctx, expr.arguments[i]);
      const paramType = constructor.parameters[i];

      if (!isAssignableTo(argType, paramType)) {
        ctx.diagnostics.reportError(
          `Type mismatch in argument ${i + 1}: expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
          DiagnosticCode.TypeMismatch,
        );
      }
    }

    ctx.isThisInitialized = true;

    return Types.Void;
  }

  const calleeType = checkExpression(ctx, expr.callee);

  if (calleeType.kind !== TypeKind.Function) {
    ctx.diagnostics.reportError(
      `Type mismatch: expected function, got ${typeToString(calleeType)}`,
      DiagnosticCode.TypeMismatch,
    );
    return Types.Unknown;
  }

  let funcType = calleeType as FunctionType;
  const argTypes = expr.arguments.map((arg) => checkExpression(ctx, arg));

  if (funcType.typeParameters && funcType.typeParameters.length > 0) {
    let typeArguments: Type[] = [];

    if (expr.typeArguments && expr.typeArguments.length > 0) {
      if (expr.typeArguments.length !== funcType.typeParameters.length) {
        ctx.diagnostics.reportError(
          `Expected ${funcType.typeParameters.length} type arguments, got ${expr.typeArguments.length}`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return Types.Unknown;
      }
      typeArguments = expr.typeArguments.map((arg) =>
        resolveTypeAnnotation(ctx, arg),
      );
    } else {
      const inferred = inferTypeArguments(
        funcType.typeParameters,
        funcType.parameters,
        argTypes,
      );

      if (!inferred) {
        ctx.diagnostics.reportError(
          `Could not infer type arguments for generic function.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return Types.Unknown;
      }
      typeArguments = inferred;
    }

    funcType = instantiateGenericFunction(funcType, typeArguments);
  }

  if (expr.arguments.length !== funcType.parameters.length) {
    ctx.diagnostics.reportError(
      `Expected ${funcType.parameters.length} arguments, got ${expr.arguments.length}`,
      DiagnosticCode.ArgumentCountMismatch,
    );
  }

  for (
    let i = 0;
    i < Math.min(expr.arguments.length, funcType.parameters.length);
    i++
  ) {
    const argType = argTypes[i];
    const paramType = funcType.parameters[i];

    if (!isAssignableTo(argType, paramType)) {
      ctx.diagnostics.reportError(
        `Type mismatch in argument ${i + 1}: expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }
  }

  return funcType.returnType;
}

function inferTypeArguments(
  typeParameters: TypeParameterType[],
  paramTypes: Type[],
  argTypes: Type[],
): Type[] | null {
  const inferred = new Map<string, Type>();

  function infer(paramType: Type, argType: Type) {
    if (paramType.kind === TypeKind.TypeParameter) {
      const name = (paramType as TypeParameterType).name;
      if (typeParameters.some((tp) => tp.name === name)) {
        const existing = inferred.get(name);
        if (!existing) {
          inferred.set(name, argType);
        }
      }
    } else if (
      paramType.kind === TypeKind.Array &&
      argType.kind === TypeKind.Array
    ) {
      infer(
        (paramType as ArrayType).elementType,
        (argType as ArrayType).elementType,
      );
    } else if (
      paramType.kind === TypeKind.Class &&
      argType.kind === TypeKind.Class
    ) {
      const pt = paramType as ClassType;
      const at = argType as ClassType;
      if (pt.name === at.name && pt.typeArguments && at.typeArguments) {
        for (
          let i = 0;
          i < Math.min(pt.typeArguments.length, at.typeArguments.length);
          i++
        ) {
          infer(pt.typeArguments[i], at.typeArguments[i]);
        }
      }
    }
  }

  for (let i = 0; i < Math.min(paramTypes.length, argTypes.length); i++) {
    infer(paramTypes[i], argTypes[i]);
  }

  const result: Type[] = [];
  for (const tp of typeParameters) {
    let type = inferred.get(tp.name);
    if (!type) {
      if (tp.defaultType) {
        type = tp.defaultType;
      } else {
        return null;
      }
    }
    result.push(type);
  }
  return result;
}

function checkAssignmentExpression(
  ctx: CheckerContext,
  expr: AssignmentExpression,
): Type {
  if (expr.left.type === NodeType.Identifier) {
    const varName = expr.left.name;
    const symbol = ctx.resolveInfo(varName);

    if (!symbol) {
      ctx.diagnostics.reportError(
        `Variable '${varName}' is not defined.`,
        DiagnosticCode.SymbolNotFound,
      );
      return Types.Unknown;
    }

    if (symbol.kind !== 'var') {
      ctx.diagnostics.reportError(
        `Cannot assign to immutable variable '${varName}'.`,
        DiagnosticCode.InvalidAssignment,
      );
    }

    const valueType = checkExpression(ctx, expr.value);
    if (!isAssignableTo(valueType, symbol.type)) {
      ctx.diagnostics.reportError(
        `Type mismatch in assignment: expected ${typeToString(symbol.type)}, got ${typeToString(valueType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }

    return valueType;
  } else if (expr.left.type === NodeType.MemberExpression) {
    const memberExpr = expr.left as MemberExpression;
    const objectType = checkExpression(ctx, memberExpr.object);

    if (objectType.kind !== TypeKind.Class) {
      if (objectType.kind !== Types.Unknown.kind) {
        ctx.diagnostics.reportError(
          `Property assignment on non-class type '${typeToString(objectType)}'.`,
          DiagnosticCode.TypeMismatch,
        );
      }
      return Types.Unknown;
    }

    const classType = objectType as ClassType;
    const memberName = memberExpr.property.name;

    if (!classType.fields.has(memberName)) {
      ctx.diagnostics.reportError(
        `Field '${memberName}' does not exist on type '${classType.name}'.`,
        DiagnosticCode.PropertyNotFound,
      );
      return Types.Unknown;
    }

    const fieldType = classType.fields.get(memberName)!;
    const valueType = checkExpression(ctx, expr.value);

    if (!isAssignableTo(valueType, fieldType)) {
      ctx.diagnostics.reportError(
        `Type mismatch in assignment: expected ${typeToString(fieldType)}, got ${typeToString(valueType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }

    return valueType;
  }
  return Types.Unknown;
}

function checkBinaryExpression(
  ctx: CheckerContext,
  expr: BinaryExpression,
): Type {
  const left = checkExpression(ctx, expr.left);
  const right = checkExpression(ctx, expr.right);

  let typesMatch = false;
  if (left === right) {
    typesMatch = true;
  } else if (left.kind === TypeKind.Number && right.kind === TypeKind.Number) {
    if ((left as any).name === (right as any).name) {
      typesMatch = true;
    }
  }

  if (!typesMatch) {
    ctx.diagnostics.reportError(
      `Type mismatch: cannot apply operator '${expr.operator}' to ${typeToString(left)} and ${typeToString(right)}`,
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

function checkFunctionExpression(
  ctx: CheckerContext,
  expr: FunctionExpression,
): Type {
  ctx.enterScope();

  const typeParameters: TypeParameterType[] = [];
  if (expr.typeParameters) {
    for (const param of expr.typeParameters) {
      const tp: TypeParameterType = {
        kind: TypeKind.TypeParameter,
        name: param.name,
      };
      typeParameters.push(tp);
      ctx.declare(param.name, tp, 'let');
    }

    // Resolve defaults
    for (let i = 0; i < expr.typeParameters.length; i++) {
      const param = expr.typeParameters[i];
      if (param.default) {
        typeParameters[i].defaultType = resolveTypeAnnotation(
          ctx,
          param.default,
        );
      }
    }
  }

  const paramTypes: Type[] = [];

  for (const param of expr.params) {
    // Resolve type annotation
    const type = resolveTypeAnnotation(ctx, param.typeAnnotation);
    ctx.declare(param.name.name, type);
    paramTypes.push(type);
  }

  // Check return type if annotated
  let expectedType: Type = Types.Unknown;
  if (expr.returnType) {
    expectedType = resolveTypeAnnotation(ctx, expr.returnType);
  }

  const previousReturnType = ctx.currentFunctionReturnType;
  ctx.currentFunctionReturnType = expectedType;

  let bodyType: Type = Types.Unknown;
  if (expr.body.type === NodeType.BlockStatement) {
    checkStatement(ctx, expr.body);
    // TODO: How to determine body type of block?
    // For now, we rely on return statements checking against expectedType.
    // If expectedType is Unknown (inferred), we need to infer from returns.
    // That's complex. Let's assume for now block bodies MUST have explicit return type or be void.
    bodyType = expectedType;
  } else {
    bodyType = checkExpression(ctx, expr.body as Expression);

    if (
      expectedType.kind !== Types.Unknown.kind &&
      bodyType.kind !== expectedType.kind
    ) {
      if (typeToString(expectedType) !== typeToString(bodyType)) {
        ctx.diagnostics.reportError(
          `Type mismatch: expected return type ${typeToString(expectedType)}, got ${typeToString(bodyType)}`,
          DiagnosticCode.TypeMismatch,
        );
      }
    }
  }

  ctx.currentFunctionReturnType = previousReturnType;
  ctx.exitScope();

  return {
    kind: TypeKind.Function,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    parameters: paramTypes,
    returnType: bodyType,
  } as FunctionType;
}

function checkNewExpression(ctx: CheckerContext, expr: NewExpression): Type {
  const className = expr.callee.name;
  const type = ctx.resolve(className);

  if (!type || type.kind !== TypeKind.Class) {
    ctx.diagnostics.reportError(
      `'${className}' is not a class.`,
      DiagnosticCode.SymbolNotFound,
    );
    return Types.Unknown;
  }

  let classType = type as ClassType;

  if (classType.isAbstract) {
    ctx.diagnostics.reportError(
      `Cannot instantiate abstract class '${className}'.`,
      DiagnosticCode.CannotInstantiateAbstractClass,
    );
  }

  if (expr.typeArguments && expr.typeArguments.length > 0) {
    if (!classType.typeParameters || classType.typeParameters.length === 0) {
      ctx.diagnostics.reportError(
        `Type '${className}' is not generic.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
      );
    } else if (classType.typeParameters.length !== expr.typeArguments.length) {
      ctx.diagnostics.reportError(
        `Expected ${classType.typeParameters.length} type arguments, got ${expr.typeArguments.length}.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
      );
    } else {
      const typeArguments = expr.typeArguments.map((arg) =>
        resolveTypeAnnotation(ctx, arg),
      );
      classType = instantiateGenericClass(classType, typeArguments);
    }
  } else if (classType.typeParameters && classType.typeParameters.length > 0) {
    // Try inference
    const constructor = classType.constructorType;
    let inferred: Type[] | null = null;

    if (constructor) {
      const argTypes = expr.arguments.map((arg) => checkExpression(ctx, arg));
      inferred = inferTypeArguments(
        classType.typeParameters,
        constructor.parameters,
        argTypes,
      );
    } else {
      // No constructor, try defaults only
      inferred = inferTypeArguments(classType.typeParameters, [], []);
    }

    if (inferred) {
      classType = instantiateGenericClass(classType, inferred);
    } else {
      ctx.diagnostics.reportError(
        `Generic type '${className}' requires type arguments.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
      );
    }
  }

  const constructor = classType.constructorType;

  if (!constructor) {
    if (expr.arguments.length > 0) {
      ctx.diagnostics.reportError(
        `Class '${className}' has no constructor but arguments were provided.`,
        DiagnosticCode.ArgumentCountMismatch,
      );
    }
    return classType;
  }

  // Check arguments against constructor parameters
  if (expr.arguments.length !== constructor.parameters.length) {
    ctx.diagnostics.reportError(
      `Expected ${constructor.parameters.length} arguments, got ${expr.arguments.length}`,
      DiagnosticCode.ArgumentCountMismatch,
    );
  }

  for (
    let i = 0;
    i < Math.min(expr.arguments.length, constructor.parameters.length);
    i++
  ) {
    const argType = checkExpression(ctx, expr.arguments[i]);
    const paramType = constructor.parameters[i];

    if (
      argType.kind !== paramType.kind &&
      argType.kind !== Types.Unknown.kind
    ) {
      if (typeToString(argType) !== typeToString(paramType)) {
        ctx.diagnostics.reportError(
          `Type mismatch in argument ${i + 1}: expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
          DiagnosticCode.TypeMismatch,
        );
      }
    }
  }

  return classType;
}

function checkMemberExpression(
  ctx: CheckerContext,
  expr: MemberExpression,
): Type {
  const objectType = checkExpression(ctx, expr.object);

  if (
    ctx.isCheckingFieldInitializer &&
    expr.object.type === NodeType.ThisExpression
  ) {
    const memberName = expr.property.name;
    // Check if we are accessing a field that hasn't been initialized yet
    if (
      objectType.kind === TypeKind.Class &&
      (objectType as ClassType).fields.has(memberName)
    ) {
      if (!ctx.initializedFields.has(memberName)) {
        ctx.diagnostics.reportError(
          `Cannot access field '${memberName}' before initialization.`,
          DiagnosticCode.UnknownError,
        );
      }
    }
  }

  if (objectType.kind === TypeKind.Array) {
    if (expr.property.name === 'length') {
      return Types.I32;
    }
  }

  if (
    objectType.kind !== TypeKind.Class &&
    objectType.kind !== TypeKind.Interface
  ) {
    if (objectType.kind !== Types.Unknown.kind) {
      ctx.diagnostics.reportError(
        `Property access on non-class type '${typeToString(objectType)}'.`,
        DiagnosticCode.TypeMismatch,
      );
    }
    return Types.Unknown;
  }

  const classType = objectType as ClassType | InterfaceType;
  const memberName = expr.property.name;

  if (memberName.startsWith('#')) {
    if (!ctx.currentClass) {
      ctx.diagnostics.reportError(
        `Private field '${memberName}' can only be accessed within a class.`,
        DiagnosticCode.UnknownError,
      );
      return Types.Unknown;
    }

    if (!ctx.currentClass.fields.has(memberName)) {
      ctx.diagnostics.reportError(
        `Private field '${memberName}' is not defined in class '${ctx.currentClass.name}'.`,
        DiagnosticCode.PropertyNotFound,
      );
      return Types.Unknown;
    }

    if (!isAssignableTo(objectType, ctx.currentClass)) {
      ctx.diagnostics.reportError(
        `Type '${typeToString(objectType)}' does not have private field '${memberName}' from class '${ctx.currentClass.name}'.`,
        DiagnosticCode.TypeMismatch,
      );
      return Types.Unknown;
    }

    return ctx.currentClass.fields.get(memberName)!;
  }

  // Check fields
  if (classType.fields.has(memberName)) {
    return classType.fields.get(memberName)!;
  }

  // Check methods
  if (classType.methods.has(memberName)) {
    return classType.methods.get(memberName)!;
  }

  ctx.diagnostics.reportError(
    `Property '${memberName}' does not exist on type '${classType.name}'.`,
    DiagnosticCode.PropertyNotFound,
  );
  return Types.Unknown;
}

function checkThisExpression(ctx: CheckerContext, expr: ThisExpression): Type {
  if (!ctx.currentClass) {
    ctx.diagnostics.reportError(
      `'this' can only be used inside a class.`,
      DiagnosticCode.UnknownError,
    );
    return Types.Unknown;
  }
  if (!ctx.isThisInitialized) {
    ctx.diagnostics.reportError(
      `'this' cannot be accessed before 'super()' call in a derived class constructor.`,
      DiagnosticCode.UnknownError,
    );
  }
  return ctx.currentClass;
}

function checkArrayLiteral(ctx: CheckerContext, expr: ArrayLiteral): Type {
  if (expr.elements.length === 0) {
    return {kind: TypeKind.Array, elementType: Types.Unknown} as ArrayType;
  }

  const firstType = checkExpression(ctx, expr.elements[0]);
  for (let i = 1; i < expr.elements.length; i++) {
    const type = checkExpression(ctx, expr.elements[i]);
    if (typeToString(type) !== typeToString(firstType)) {
      ctx.diagnostics.reportError(
        `Array elements must be of the same type. Expected ${typeToString(firstType)}, got ${typeToString(type)}`,
        DiagnosticCode.TypeMismatch,
      );
    }
  }
  return {kind: TypeKind.Array, elementType: firstType} as ArrayType;
}

function checkIndexExpression(
  ctx: CheckerContext,
  expr: IndexExpression,
): Type {
  const objectType = checkExpression(ctx, expr.object);
  const indexType = checkExpression(ctx, expr.index);

  if (
    objectType.kind === TypeKind.Class ||
    objectType.kind === TypeKind.Interface
  ) {
    const classType = objectType as ClassType | InterfaceType;
    const method = classType.methods.get('[]');
    if (method) {
      if (method.parameters.length !== 1) {
        ctx.diagnostics.reportError(
          `Operator [] must take exactly one argument.`,
          DiagnosticCode.ArgumentCountMismatch,
        );
      } else {
        if (!isAssignableTo(indexType, method.parameters[0])) {
          ctx.diagnostics.reportError(
            `Type mismatch in index: expected ${typeToString(method.parameters[0])}, got ${typeToString(indexType)}`,
            DiagnosticCode.TypeMismatch,
          );
        }
      }
      return method.returnType;
    }
  }

  if (
    indexType.kind !== TypeKind.Number ||
    (indexType as NumberType).name !== 'i32'
  ) {
    ctx.diagnostics.reportError(
      `Array index must be i32, got ${typeToString(indexType)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  const isString =
    objectType === Types.String ||
    (objectType.kind === TypeKind.Class &&
      (objectType as ClassType).name === 'String');

  if (objectType.kind !== TypeKind.Array && !isString) {
    ctx.diagnostics.reportError(
      `Index expression only supported on arrays, strings, or types with [] operator, got ${typeToString(objectType)}`,
      DiagnosticCode.NotIndexable,
    );
    return Types.Unknown;
  }

  if (isString) {
    return Types.I32;
  }

  return (objectType as ArrayType).elementType;
}

function checkSuperExpression(
  ctx: CheckerContext,
  expr: SuperExpression,
): Type {
  if (!ctx.currentClass) {
    ctx.diagnostics.reportError(
      `'super' can only be used inside a class.`,
      DiagnosticCode.UnknownError,
    );
    return Types.Unknown;
  }

  if (!ctx.currentClass.superType) {
    ctx.diagnostics.reportError(
      `Class '${ctx.currentClass.name}' does not have a superclass.`,
      DiagnosticCode.UnknownError,
    );
    return Types.Unknown;
  }

  return ctx.currentClass.superType;
}
