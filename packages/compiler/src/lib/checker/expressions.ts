import {
  NodeType,
  type ArrayLiteral,
  type AsExpression,
  type AssignmentExpression,
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type IndexExpression,
  type MemberExpression,
  type NewExpression,
  type RecordLiteral,
  type SuperExpression,
  type TaggedTemplateExpression,
  type TemplateLiteral,
  type ThisExpression,
  type TupleLiteral,
} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  TypeKind,
  Types,
  type FixedArrayType,
  type ClassType,
  type InterfaceType,
  type FunctionType,
  type NumberType,
  type RecordType,
  type TupleType,
  type Type,
  type TypeParameterType,
  type UnionType,
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
  const type = checkExpressionInternal(ctx, expr);
  expr.inferredType = type;
  return type;
}

function checkExpressionInternal(ctx: CheckerContext, expr: Expression): Type {
  switch (expr.type) {
    case NodeType.NumberLiteral: {
      const lit = expr as any; // Cast to access raw if needed, or update AST type definition
      if (lit.raw && lit.raw.includes('.')) {
        return Types.F32;
      }
      return Types.I32;
    }
    case NodeType.StringLiteral: {
      const stringType = ctx.getWellKnownType('String');
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
    case NodeType.RecordLiteral:
      return checkRecordLiteral(ctx, expr as RecordLiteral);
    case NodeType.TupleLiteral:
      return checkTupleLiteral(ctx, expr as TupleLiteral);
    case NodeType.IndexExpression:
      return checkIndexExpression(ctx, expr as IndexExpression);
    case NodeType.TemplateLiteral:
      return checkTemplateLiteral(ctx, expr as TemplateLiteral);
    case NodeType.TaggedTemplateExpression:
      return checkTaggedTemplateExpression(
        ctx,
        expr as TaggedTemplateExpression,
      );
    case NodeType.AsExpression:
      return checkAsExpression(ctx, expr as AsExpression);
    default:
      return Types.Unknown;
  }
}

function checkAsExpression(ctx: CheckerContext, expr: AsExpression): Type {
  checkExpression(ctx, expr.expression);
  // We trust the user knows what they are doing with 'as' for now,
  // or we could add checks later (e.g. no casting string to int).
  // For distinct types, this is the primary way to "wrap" a value.
  return resolveTypeAnnotation(ctx, expr.typeAnnotation);
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
    if (ctx.currentClass.isExtension) {
      if (!ctx.currentClass.onType) {
        return Types.Unknown;
      }

      if (expr.arguments.length !== 1) {
        ctx.diagnostics.reportError(
          `Extension class constructor must call 'super' with exactly one argument.`,
          DiagnosticCode.ArgumentCountMismatch,
        );
      } else {
        const argType = checkExpression(ctx, expr.arguments[0]);
        if (!isAssignableTo(argType, ctx.currentClass.onType)) {
          ctx.diagnostics.reportError(
            `Type mismatch in super call: expected ${typeToString(ctx.currentClass.onType)}, got ${typeToString(argType)}`,
            DiagnosticCode.TypeMismatch,
          );
        }
      }

      ctx.isThisInitialized = true;
      return Types.Void;
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

  // Always check arguments to ensure they have inferred types attached
  const argTypes = expr.arguments.map((arg) => checkExpression(ctx, arg));

  if (calleeType.kind === TypeKind.Union) {
    const unionType = calleeType as UnionType;
    // Check if all members are callable with the given arguments
    // We construct a synthetic target function type based on the arguments
    // Actually, we just need to check if each member is adaptable/assignable to a call with these args.

    // For now, we require all members to be functions.
    const allFunctions = unionType.types.every(
      (t) => t.kind === TypeKind.Function,
    );
    if (!allFunctions) {
      ctx.diagnostics.reportError(
        `Cannot call union type ${typeToString(calleeType)}: not all members are functions.`,
        DiagnosticCode.TypeMismatch,
      );
      return Types.Unknown;
    }

    // Check compatibility for each member
    let returnType: Type | null = null;

    for (const member of unionType.types) {
      const funcMember = member as FunctionType;

      // Check argument count (allowing for adaptation: member can have fewer args)
      if (funcMember.parameters.length > argTypes.length) {
        ctx.diagnostics.reportError(
          `Union member ${typeToString(member)} requires ${funcMember.parameters.length} arguments, but only ${argTypes.length} were provided.`,
          DiagnosticCode.ArgumentCountMismatch,
        );
        return Types.Unknown;
      }

      // Check argument types
      for (let i = 0; i < funcMember.parameters.length; i++) {
        if (!isAssignableTo(argTypes[i], funcMember.parameters[i])) {
          ctx.diagnostics.reportError(
            `Argument ${i + 1} of type ${typeToString(argTypes[i])} is not assignable to parameter of type ${typeToString(funcMember.parameters[i])} in union member ${typeToString(member)}.`,
            DiagnosticCode.TypeMismatch,
          );
          return Types.Unknown;
        }
      }

      // Unify return types
      if (returnType === null) {
        returnType = funcMember.returnType;
      } else if (!isAssignableTo(funcMember.returnType, returnType)) {
        // If not assignable one way, try the other (simple union check)
        if (isAssignableTo(returnType, funcMember.returnType)) {
          returnType = funcMember.returnType;
        } else {
          // TODO: Create a union of return types? For now, error.
          ctx.diagnostics.reportError(
            `Incompatible return types in union call: ${typeToString(returnType)} vs ${typeToString(funcMember.returnType)}.`,
            DiagnosticCode.TypeMismatch,
          );
          return Types.Unknown;
        }
      }
    }

    return returnType || Types.Void;
  }

  if (calleeType.kind !== TypeKind.Function) {
    ctx.diagnostics.reportError(
      `Type mismatch: expected function, got ${typeToString(calleeType)}`,
      DiagnosticCode.TypeMismatch,
    );
    return Types.Unknown;
  }

  let funcType = calleeType as FunctionType;

  // Overload resolution
  if (funcType.overloads && funcType.overloads.length > 0) {
    const candidates = [funcType, ...funcType.overloads];
    let bestMatch: FunctionType | null = null;

    for (const candidate of candidates) {
      if (candidate.parameters.length !== argTypes.length) continue;

      let match = true;
      // TODO: Handle generic overloads
      for (let i = 0; i < argTypes.length; i++) {
        if (!isAssignableTo(argTypes[i], candidate.parameters[i])) {
          match = false;
          break;
        }
      }

      if (match) {
        bestMatch = candidate;
        break;
      }
    }

    if (bestMatch) {
      funcType = bestMatch;
    }
  }

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
      expr.inferredTypeArguments = typeArguments;
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
      // Store inferred type arguments in AST for Codegen
      expr.inferredTypeArguments = inferred;
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
      paramType.kind === TypeKind.FixedArray &&
      argType.kind === TypeKind.FixedArray
    ) {
      infer(
        (paramType as FixedArrayType).elementType,
        (argType as FixedArrayType).elementType,
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
    } else if (
      paramType.kind === TypeKind.Function &&
      argType.kind === TypeKind.Function
    ) {
      const pt = paramType as FunctionType;
      const at = argType as FunctionType;
      for (
        let i = 0;
        i < Math.min(pt.parameters.length, at.parameters.length);
        i++
      ) {
        infer(pt.parameters[i], at.parameters[i]);
      }
      infer(pt.returnType, at.returnType);
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
  } else if (expr.left.type === NodeType.IndexExpression) {
    const indexExpr = expr.left as IndexExpression;

    // Check for operator []= on classes/interfaces
    const objectType = checkExpression(ctx, indexExpr.object);
    if (
      objectType.kind === TypeKind.Class ||
      objectType.kind === TypeKind.Interface
    ) {
      const classType = objectType as ClassType | InterfaceType;
      const setter = classType.methods.get('[]=');
      if (setter) {
        const indexType = checkExpression(ctx, indexExpr.index);

        if (setter.parameters.length !== 2) {
          ctx.diagnostics.reportError(
            `Operator []= must take exactly two arguments (index and value).`,
            DiagnosticCode.ArgumentCountMismatch,
          );
        } else {
          if (!isAssignableTo(indexType, setter.parameters[0])) {
            ctx.diagnostics.reportError(
              `Type mismatch in index: expected ${typeToString(setter.parameters[0])}, got ${typeToString(indexType)}`,
              DiagnosticCode.TypeMismatch,
            );
          }

          const valueType = checkExpression(ctx, expr.value);
          if (!isAssignableTo(valueType, setter.parameters[1])) {
            ctx.diagnostics.reportError(
              `Type mismatch in assignment: expected ${typeToString(setter.parameters[1])}, got ${typeToString(valueType)}`,
              DiagnosticCode.TypeMismatch,
            );
          }

          // Annotate the index expression with the value type (result of the assignment expression)
          indexExpr.inferredType = valueType;
          return valueType;
        }
        return Types.Unknown;
      }
    }

    // Check the index expression (this will annotate the object and index)
    const elementType = checkIndexExpression(ctx, indexExpr);

    // Check if value is assignable to element type
    const valueType = checkExpression(ctx, expr.value);
    if (!isAssignableTo(valueType, elementType)) {
      ctx.diagnostics.reportError(
        `Type mismatch in assignment: expected ${typeToString(elementType)}, got ${typeToString(valueType)}`,
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
  if (expr.operator === '==' || expr.operator === '!=') {
    typesMatch = isAssignableTo(left, right) || isAssignableTo(right, left);
  } else if (left === right) {
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
      expr.inferredTypeArguments = typeArguments;
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
      expr.inferredTypeArguments = inferred;
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

  if (objectType.kind === TypeKind.FixedArray) {
    // Check for extension methods
    // TODO: Support multiple extensions or lookup by type, not just name 'Array'
    const arrayType = ctx.getWellKnownType('FixedArray');
    if (arrayType && arrayType.kind === TypeKind.Class) {
      const classType = arrayType as ClassType;
      if (classType.methods.has(expr.property.name)) {
        return classType.methods.get(expr.property.name)!;
      }
    }

    if (expr.property.name === 'length') {
      return Types.I32;
    }
  }

  if (objectType.kind === TypeKind.Record) {
    const recordType = objectType as RecordType;
    const memberName = expr.property.name;
    if (recordType.properties.has(memberName)) {
      return recordType.properties.get(memberName)!;
    }
    ctx.diagnostics.reportError(
      `Property '${memberName}' does not exist on type '${typeToString(objectType)}'.`,
      DiagnosticCode.PropertyNotFound,
    );
    return Types.Unknown;
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
  if (ctx.currentClass.isExtension && ctx.currentClass.onType) {
    return ctx.currentClass.onType;
  }
  return ctx.currentClass;
}

function checkArrayLiteral(ctx: CheckerContext, expr: ArrayLiteral): Type {
  if (expr.elements.length === 0) {
    // Empty array literal, infer as Array<Unknown> or similar?
    // For now, let's assume Array<i32> if empty, or maybe we need a bottom type.
    // Better: Array<any> (if we had any).
    // Let's return Array<Unknown> and hope it gets refined or cast.
    return {
      kind: TypeKind.FixedArray,
      elementType: Types.Unknown,
    } as FixedArrayType;
  }

  const elementTypes = expr.elements.map((e) => checkExpression(ctx, e));
  // Check if all element types are compatible.
  // For simplicity, take the first type and check if others are assignable to it.
  // A better approach would be finding the common supertype.
  const firstType = elementTypes[0];
  for (let i = 1; i < elementTypes.length; i++) {
    if (!isAssignableTo(elementTypes[i], firstType)) {
      ctx.diagnostics.reportError(
        `Array element type mismatch. Expected '${typeToString(firstType)}', got '${typeToString(elementTypes[i])}'.`,
        DiagnosticCode.TypeMismatch,
      );
    }
  }

  return {
    kind: TypeKind.FixedArray,
    elementType: firstType,
  } as FixedArrayType;
}

function checkRecordLiteral(ctx: CheckerContext, expr: RecordLiteral): Type {
  const properties = new Map<string, Type>();
  for (const prop of expr.properties) {
    const type = checkExpression(ctx, prop.value);
    properties.set(prop.name.name, type);
  }
  return {
    kind: TypeKind.Record,
    properties,
  } as RecordType;
}

function checkTupleLiteral(ctx: CheckerContext, expr: TupleLiteral): Type {
  const elementTypes = expr.elements.map((e) => checkExpression(ctx, e));
  return {
    kind: TypeKind.Tuple,
    elementTypes,
  } as TupleType;
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

  if (objectType.kind === TypeKind.Tuple) {
    const tupleType = objectType as TupleType;
    if (expr.index.type !== NodeType.NumberLiteral) {
      ctx.diagnostics.reportError(
        `Tuple index must be a number literal.`,
        DiagnosticCode.TypeMismatch,
      );
      return Types.Unknown;
    }
    const index = (expr.index as any).value;
    if (index < 0 || index >= tupleType.elementTypes.length) {
      ctx.diagnostics.reportError(
        `Tuple index out of bounds: ${index}`,
        DiagnosticCode.IndexOutOfBounds,
      );
      return Types.Unknown;
    }
    return tupleType.elementTypes[index];
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
    objectType === ctx.getWellKnownType('String');

  if (objectType.kind !== TypeKind.FixedArray && !isString) {
    ctx.diagnostics.reportError(
      `Index expression only supported on arrays, strings, or types with [] operator, got ${typeToString(objectType)}`,
      DiagnosticCode.NotIndexable,
    );
    return Types.Unknown;
  }

  if (isString) {
    return Types.I32;
  }

  return (objectType as FixedArrayType).elementType;
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

/**
 * Check an untagged template literal like `hello ${name}`.
 * The type is always String since the expressions are concatenated.
 */
function checkTemplateLiteral(
  ctx: CheckerContext,
  expr: TemplateLiteral,
): Type {
  // Check all embedded expressions
  for (const subExpr of expr.expressions) {
    checkExpression(ctx, subExpr);
    // Note: In the future we might want to verify expressions are convertible to string
    // For now, we just type-check them.
  }

  // The result of an untagged template literal is always a String
  const stringType = ctx.getWellKnownType('String');
  return stringType || Types.String;
}

/**
 * Check a tagged template expression like html`<div>${name}</div>`.
 * The tag must be a function that accepts:
 *   - strings: TemplateStringsArray (an array with cooked strings and a raw property)
 *   - values: Array<T> of interpolated values
 */
function checkTaggedTemplateExpression(
  ctx: CheckerContext,
  expr: TaggedTemplateExpression,
): Type {
  // Check all embedded expressions in the template
  const valueTypes: Type[] = [];
  for (const subExpr of expr.quasi.expressions) {
    valueTypes.push(checkExpression(ctx, subExpr));
  }

  // Check the tag expression
  const tagType = checkExpression(ctx, expr.tag);

  if (tagType.kind !== TypeKind.Function) {
    ctx.diagnostics.reportError(
      `Tagged template tag must be a function, got ${typeToString(tagType)}`,
      DiagnosticCode.TypeMismatch,
    );
    return Types.Unknown;
  }

  const funcType = tagType as FunctionType;

  // A tag function should accept:
  // 1. First parameter: TemplateStringsArray (array of strings with raw property)
  // 2. Second parameter: Array of values (or rest parameter in JS, but we use array)
  //
  // For now, we do a lenient check: tag function should have at least 2 parameters
  // and return something.

  if (funcType.parameters.length < 2) {
    ctx.diagnostics.reportError(
      `Tagged template tag function must accept at least 2 parameters (strings and values)`,
      DiagnosticCode.ArgumentCountMismatch,
    );
    return Types.Unknown;
  }

  // Return the function's return type
  return funcType.returnType;
}
