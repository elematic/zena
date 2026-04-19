import {
  NodeType,
  type ArrayLiteral,
  type AsExpression,
  type AsPattern,
  type AssignmentExpression,
  type BinaryExpression,
  type BlockStatement,
  type BooleanLiteral,
  type CallExpression,
  type CatchClause,
  type ClassPattern,
  type Declaration,
  type EnumDeclaration,
  type Expression,
  type FunctionExpression,
  type Identifier,
  type IfExpression,
  type IndexExpression,
  type IsExpression,
  type LogicalPattern,
  type MapLiteral,
  type MatchExpression,
  type MemberExpression,
  type NewExpression,
  type NullLiteral,
  type NumberLiteral,
  type Pattern,
  type PipelineExpression,
  type PipePlaceholder,
  type RangeExpression,
  type RecordLiteral,
  type RecordPattern,
  type StringLiteral,
  type SuperExpression,
  type TaggedTemplateExpression,
  type TemplateLiteral,
  type ThisExpression,
  type ThrowExpression,
  type TryExpression,
  type TupleLiteral,
  type TuplePattern,
  type UnaryExpression,
  type InlineTupleLiteral,
  type VariableDeclaration,
} from '../ast.js';
import {
  createBinding,
  type FieldBinding,
  type GetterBinding,
  type MethodBinding,
  type RecordFieldBinding,
} from '../bindings.js';
import {DiagnosticCode} from '../diagnostics.js';
import {getGetterName, getSetterName} from '../names.js';
import {
  TypeKind,
  Types,
  TypeNames,
  type ArrayType,
  type ClassType,
  type InterfaceType,
  type FunctionType,
  type LiteralType,
  type NumberType,
  type RecordType,
  type SymbolType,
  type TupleType,
  type Type,
  type TypeAliasType,
  type TypeParameterType,
  type InlineTupleType,
  type UnionType,
} from '../types.js';
import type {CheckerContext} from './context.js';

const LENGTH_PROPERTY = 'length';

/**
 * Extracts a compile-time known numeric value from an expression.
 *
 * This supports:
 * - Number literals (e.g., `0`, `42`)
 * - Identifiers with literal numeric types (e.g., booleans have literal types)
 * - Identifiers declared with `let` initialized with a number literal
 * - Identifiers narrowed to literal numeric types
 *
 * @param ctx - The checker context (optional for backward compatibility)
 * @param expr - The expression to evaluate
 * @returns The numeric value if compile-time known, null otherwise
 */
export const getCompileTimeNumericValue = (
  ctx: CheckerContext | null,
  expr: Expression,
): number | null => {
  // Direct number literal
  if (expr.type === NodeType.NumberLiteral) {
    return Number((expr as NumberLiteral).raw);
  }

  // Identifier - check if it has a compile-time known numeric value
  if (expr.type === NodeType.Identifier && ctx) {
    const name = (expr as Identifier).name;

    // Check narrowed type first (narrowing takes precedence)
    const narrowedType = ctx.getNarrowedType(name);
    if (narrowedType?.kind === TypeKind.Literal) {
      const literalType = narrowedType as LiteralType;
      if (typeof literalType.value === 'number') {
        return literalType.value;
      }
    }

    // Check declared type (for types that preserve literal types, like booleans)
    const symbolInfo = ctx.resolveValueInfo(name);
    if (symbolInfo?.type.kind === TypeKind.Literal) {
      const literalType = symbolInfo.type as LiteralType;
      if (typeof literalType.value === 'number') {
        return literalType.value;
      }
    }

    // Check if this is a `let` variable initialized with a number literal
    // (Number literals don't have literal types, so we need to check the declaration)
    if (symbolInfo?.kind === 'let' && symbolInfo.declaration) {
      const decl = symbolInfo.declaration;
      if (
        decl.type === NodeType.VariableDeclaration &&
        (decl as VariableDeclaration).init.type === NodeType.NumberLiteral
      ) {
        return Number(
          ((decl as VariableDeclaration).init as NumberLiteral).raw,
        );
      }
    }
  }

  return null;
};

/**
 * Converts an expression to a path string for narrowing lookups.
 * For example:
 * - `obj.field.subfield` becomes "obj.field.subfield"
 * - `tuple[0]` becomes "tuple[0]"
 * Returns null if the expression cannot be represented as a path.
 *
 * @param expr - The expression to convert
 * @param ctx - Optional checker context for resolving compile-time known indices
 */
const getExpressionPath = (
  expr: Expression,
  ctx?: CheckerContext,
): string | null => {
  if (expr.type === NodeType.Identifier) {
    return (expr as Identifier).name;
  }
  if (expr.type === NodeType.MemberExpression) {
    const member = expr as MemberExpression;
    const objectPath = getExpressionPath(member.object, ctx);
    if (objectPath === null) return null;
    return `${objectPath}.${member.property.name}`;
  }
  // Handle tuple index expressions like t[0] or t[i] where i is compile-time known
  if (expr.type === NodeType.IndexExpression) {
    const indexExpr = expr as IndexExpression;
    const index = getCompileTimeNumericValue(ctx ?? null, indexExpr.index);
    if (index === null) return null;
    const objectPath = getExpressionPath(indexExpr.object, ctx);
    if (objectPath === null) return null;
    return `${objectPath}[${index}]`;
  }
  return null;
};

import {
  instantiateGenericClass,
  instantiateGenericFunction,
  isBooleanType,
  resolveTypeAnnotation,
  typeToString,
  isAssignableTo,
  substituteType,
  validateType,
  validateNoInlineTuple,
  isNullableType,
  getNonNullableType,
  makeNullable,
} from './types.js';
import {
  checkPattern,
  checkStatement,
  extractNarrowingFromCondition,
  extractInverseNarrowingFromCondition,
  extractAllInverseNarrowingsFromCondition,
  extractAllNarrowingsFromCondition,
  predeclareFunction,
} from './statements.js';

/**
 * Resolves a member (field or method) type from a class, handling generic type substitution.
 * When the class is an instantiated generic (e.g., Node<i32>), the member types are defined
 * in terms of type parameters (e.g., T) and need to be substituted with the actual type arguments.
 */
function resolveMemberType(
  classType: ClassType | InterfaceType,
  memberType: Type,
  ctx: CheckerContext,
): Type {
  // If the class doesn't have type arguments, no substitution needed
  if (!classType.typeArguments || classType.typeArguments.length === 0) {
    return memberType;
  }

  // Get the type parameters from genericSource or the class itself
  const source = (classType as ClassType).genericSource || classType;
  const typeParameters = source.typeParameters;

  if (!typeParameters || typeParameters.length === 0) {
    return memberType;
  }

  // Create a typeMap from type parameter names to type arguments
  const typeMap = new Map<string, Type>();
  typeParameters.forEach((param: TypeParameterType, index: number) => {
    if (index < classType.typeArguments!.length) {
      typeMap.set(param.name, classType.typeArguments![index]);
    }
  });

  // Substitute type parameters in the member type
  return substituteType(memberType, typeMap, ctx);
}

export function checkExpression(
  ctx: CheckerContext,
  expr: Expression,
  expectedType?: Type,
): Type {
  const type = checkExpressionInternal(ctx, expr, expectedType);
  expr.inferredType = type;
  return type;
}

function checkExpressionInternal(
  ctx: CheckerContext,
  expr: Expression,
  expectedType?: Type,
): Type {
  switch (expr.type) {
    case NodeType.NumberLiteral: {
      const lit = expr as NumberLiteral;
      const hasDecimal = lit.raw && lit.raw.includes('.');
      // If we have a contextual numeric type, use it (enables `x < 0` when x is i64)
      if (expectedType && expectedType.kind === TypeKind.Number) {
        // For decimal literals, only allow float types as context
        if (hasDecimal) {
          const name = (expectedType as NumberType).name;
          if (name === 'f32' || name === 'f64') {
            return expectedType;
          }
          // Decimal literal with integer context - use default f32
          return Types.F32;
        }
        // Integer literal can use any numeric context type
        return expectedType;
      }
      // No contextual type - use defaults
      if (hasDecimal) {
        return Types.F32;
      }
      return Types.I32;
    }
    case NodeType.StringLiteral: {
      // String literals always have the stdlib String type, even if a user
      // defines their own class named `String`. This ensures consistent
      // behavior for literals regardless of what's in scope.
      const stringType = ctx.getWellKnownType(Types.String.name);
      return stringType || Types.String;
    }
    case NodeType.BooleanLiteral: {
      const boolLit = expr as BooleanLiteral;
      return {kind: TypeKind.Literal, value: boolLit.value} as LiteralType;
    }
    case NodeType.NullLiteral:
      return Types.Null;
    case NodeType.Identifier: {
      // Special case: _ is a "hole" literal that has type `never`.
      // It can only be used to satisfy `never` in discriminated union returns.
      // Example: return (false, _);  // where return type is (true, T) | (false, never)
      if (expr.name === '_') {
        return Types.Never;
      }

      const symbolInfo = ctx.resolveValueInfo(expr.name);
      if (!symbolInfo) {
        ctx.diagnostics.reportError(
          `Variable '${expr.name}' not found.`,
          DiagnosticCode.SymbolNotFound,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }

      // Create and store the resolved binding for codegen
      const binding = createBinding(symbolInfo, {
        // Local if we're inside a function scope (scopes.length > 1 means we're past the global scope)
        isLocal: !symbolInfo.modulePath && ctx.scopes.length > 1,
      });
      if (binding) {
        ctx.semanticContext.setResolvedBinding(expr as Identifier, binding);
      }

      // Return the type, applying any narrowing
      const narrowedType = ctx.getNarrowedType(expr.name);
      return narrowedType ?? symbolInfo.type;
    }
    case NodeType.AssignmentExpression:
      return checkAssignmentExpression(ctx, expr as AssignmentExpression);
    case NodeType.BinaryExpression:
      return checkBinaryExpression(ctx, expr as BinaryExpression);
    case NodeType.FunctionExpression:
      return checkFunctionExpression(
        ctx,
        expr as FunctionExpression,
        expectedType,
      );
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
    case NodeType.MapLiteral:
      return checkMapLiteral(ctx, expr as MapLiteral);
    case NodeType.TupleLiteral:
      return checkTupleLiteral(ctx, expr as TupleLiteral);
    case NodeType.InlineTupleLiteral:
      return checkInlineTupleLiteral(ctx, expr as InlineTupleLiteral);
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
    case NodeType.IsExpression:
      return checkIsExpression(ctx, expr as IsExpression);
    case NodeType.UnaryExpression:
      return checkUnaryExpression(ctx, expr as UnaryExpression);
    case NodeType.ThrowExpression:
      return checkThrowExpression(ctx, expr as ThrowExpression);
    case NodeType.TryExpression:
      return checkTryExpression(ctx, expr as TryExpression);
    case NodeType.MatchExpression:
      return checkMatchExpression(ctx, expr as MatchExpression);
    case NodeType.IfExpression:
      return checkIfExpression(ctx, expr as IfExpression);
    case NodeType.RangeExpression:
      return checkRangeExpression(ctx, expr as RangeExpression);
    case NodeType.PipelineExpression:
      return checkPipelineExpression(ctx, expr as PipelineExpression);
    case NodeType.PipePlaceholder:
      return checkPipePlaceholder(ctx, expr as PipePlaceholder);
    default:
      return Types.Unknown;
  }
}

function checkMatchExpression(
  ctx: CheckerContext,
  expr: MatchExpression,
): Type {
  const discriminantType = checkExpression(ctx, expr.discriminant);
  const caseTypes: Type[] = [];
  const matchedTypes: Type[] = [];
  let remainingType = discriminantType;

  for (const c of expr.cases) {
    ctx.enterScope();
    checkMatchPattern(ctx, c.pattern, discriminantType);

    // Check for unreachable code
    if (remainingType.kind === TypeKind.Never) {
      ctx.diagnostics.reportError(
        `Unreachable case. The match is already exhaustive.`,
        DiagnosticCode.UnreachableCode,
        ctx.getLocation(expr.loc),
      );
    }

    const patternType = getPatternType(ctx, c.pattern);
    if (patternType) {
      for (const prev of matchedTypes) {
        const ext1 =
          patternType.kind === TypeKind.Class &&
          (patternType as ClassType).isExtension
            ? (patternType as ClassType)
            : null;
        const ext2 =
          prev.kind === TypeKind.Class && (prev as ClassType).isExtension
            ? (prev as ClassType)
            : null;

        if (ext1 && ext2 && ext1.onType && ext2.onType) {
          if (
            isAssignableTo(ctx, ext1.onType, ext2.onType) &&
            isAssignableTo(ctx, ext2.onType, ext1.onType)
          ) {
            ctx.diagnostics.reportError(
              `Ambiguous match case: '${typeToString(patternType)}' and '${typeToString(prev)}' extend the same underlying type and are indistinguishable at runtime.`,
              DiagnosticCode.TypeMismatch,
              ctx.getLocation(expr.loc),
            );
          }
        }
      }
      matchedTypes.push(patternType);
    }

    // Update remaining type
    // Only if there is no guard. If there is a guard, we can't assume the pattern covers the type.
    if (!c.guard) {
      remainingType = subtractType(ctx, remainingType, c.pattern);
    }

    if (c.guard) {
      const guardType = checkExpression(ctx, c.guard);
      if (guardType !== Types.Boolean) {
        ctx.diagnostics.reportError(
          `Match guard must be a boolean expression, got ${typeToString(guardType)}`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
      }
    }

    const bodyType = checkMatchCaseBody(ctx, c.body);
    caseTypes.push(bodyType);
    ctx.exitScope();
  }

  if (remainingType.kind !== TypeKind.Never) {
    ctx.diagnostics.reportError(
      `Non-exhaustive match. Remaining type: ${typeToString(remainingType)}`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
  }

  if (caseTypes.length === 0) return Types.Void;
  return createUnionType(caseTypes);
}

function checkMatchCaseBody(
  ctx: CheckerContext,
  body: Expression | BlockStatement,
): Type {
  if (body.type === NodeType.BlockStatement) {
    return checkBlockExpressionType(ctx, body as BlockStatement);
  }
  return checkExpression(ctx, body);
}

function checkIfExpression(ctx: CheckerContext, expr: IfExpression): Type {
  if (expr.test.type === NodeType.LetPatternCondition) {
    const initType = checkExpression(ctx, expr.test.init);

    ctx.enterScope();
    checkMatchPattern(ctx, expr.test.pattern, initType);
    const consequentType = checkIfBranch(ctx, expr.consequent);
    ctx.exitScope();

    if (!expr.alternate) {
      return Types.Void;
    }

    ctx.enterScope();
    const alternateType = checkIfBranch(ctx, expr.alternate);
    ctx.exitScope();

    return createUnionType([consequentType, alternateType]);
  }

  const testType = checkExpression(ctx, expr.test);
  if (!isBooleanType(testType) && testType.kind !== TypeKind.Unknown) {
    ctx.diagnostics.reportError(
      `Condition must be a boolean type, got '${typeToString(testType)}'.`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
  }

  // Extract narrowing information from the condition
  const narrowing = extractNarrowingFromCondition(ctx, expr.test);

  // Check the consequent branch with narrowing applied
  ctx.enterScope();
  if (narrowing) {
    ctx.narrowType(narrowing.variableName, narrowing.narrowedType);
  }
  const consequentType = checkIfBranch(ctx, expr.consequent);
  ctx.exitScope();

  // If there is no else branch, the if expression has type void
  if (!expr.alternate) {
    return Types.Void;
  }

  // Check the alternate branch with inverse narrowing applied
  const inverseNarrowing = extractInverseNarrowingFromCondition(ctx, expr.test);
  ctx.enterScope();
  if (inverseNarrowing) {
    ctx.narrowType(
      inverseNarrowing.variableName,
      inverseNarrowing.narrowedType,
    );
  }
  const alternateType = checkIfBranch(ctx, expr.alternate);
  ctx.exitScope();

  return createUnionType([consequentType, alternateType]);
}

function checkIfBranch(
  ctx: CheckerContext,
  branch: Expression | BlockStatement,
): Type {
  if (branch.type === NodeType.BlockStatement) {
    return checkBlockExpressionType(ctx, branch as BlockStatement);
  }
  return checkExpression(ctx, branch);
}

function checkBlockExpressionType(
  ctx: CheckerContext,
  block: BlockStatement,
): Type {
  ctx.enterScope();

  // Pre-declare functions for mutual recursion
  for (const stmt of block.body) {
    predeclareFunction(ctx, stmt);
  }

  // Check all statements in the block
  for (let i = 0; i < block.body.length - 1; i++) {
    checkStatement(ctx, block.body[i]);
  }

  // The type of the block is the type of the last expression
  let resultType: Type = Types.Void;
  if (block.body.length > 0) {
    const lastStmt = block.body[block.body.length - 1];
    if (lastStmt.type === NodeType.ExpressionStatement) {
      resultType = checkExpression(ctx, (lastStmt as any).expression);
    } else {
      // For return statements, the type is void since we exit the function
      checkStatement(ctx, lastStmt);
    }
  }

  ctx.exitScope();
  return resultType;
}

/**
 * Extract the class type from a type that may be a union (e.g., `Type | null`).
 * Returns the ClassType member if found, otherwise null.
 */
function extractClassType(type: Type): ClassType | null {
  if (type.kind === TypeKind.Class) {
    return type as ClassType;
  }
  if (type.kind === TypeKind.Union) {
    const ut = type as UnionType;
    for (const t of ut.types) {
      if (t.kind === TypeKind.Class) {
        return t as ClassType;
      }
    }
  }
  return null;
}

export function checkMatchPattern(
  ctx: CheckerContext,
  pattern:
    | Pattern
    | ClassPattern
    | NumberLiteral
    | StringLiteral
    | BooleanLiteral
    | NullLiteral,
  discriminantType: Type,
) {
  switch (pattern.type) {
    case NodeType.Identifier: {
      // Variable pattern: matches anything, binds variable
      // If name is '_', it's a wildcard (no binding)
      if (pattern.name !== '_') {
        // Check if identifier refers to a sealed variant (unit variant pattern)
        const resolvedType = ctx.resolveType(pattern.name);
        const discClass =
          resolvedType?.kind === TypeKind.Class
            ? extractClassType(discriminantType)
            : null;
        if (resolvedType && resolvedType.kind === TypeKind.Class && discClass) {
          const discSource = discClass.genericSource || discClass;
          if (
            discSource.isSealed &&
            discSource.sealedVariants?.some((v) => v === resolvedType)
          ) {
            // Treat as a class pattern for sealed variant.
            // For generic sealed classes, instantiate the variant type.
            let variantType = resolvedType as ClassType;
            if (
              variantType.typeParameters &&
              variantType.typeParameters.length > 0 &&
              discClass.typeArguments &&
              discSource.typeParameters
            ) {
              const typeMap = new Map<string, Type>();
              discSource.typeParameters.forEach((param, index) => {
                if (index < discClass.typeArguments!.length) {
                  typeMap.set(param.name, discClass.typeArguments![index]);
                }
              });
              const identityArgs = variantType.typeParameters.map(
                (p) =>
                  ({
                    kind: TypeKind.TypeParameter,
                    name: p.name,
                  }) as TypeParameterType,
              );
              const withIdentity = {
                ...variantType,
                typeArguments: identityArgs,
                genericSource: variantType,
              } as ClassType;
              variantType = ctx.substituteTypeParams(
                withIdentity,
                typeMap,
              ) as ClassType;
            }
            (pattern as any).inferredType = variantType;
            break;
          }
          // Non-sealed class match: set inferredType for narrowing in `as` patterns
          if (
            isAssignableTo(ctx, resolvedType, discriminantType) ||
            isAssignableTo(ctx, discriminantType, resolvedType)
          ) {
            (pattern as any).inferredType = resolvedType;
          }
        }
        ctx.declare(pattern.name, discriminantType, 'let', pattern);
      }
      break;
    }
    case NodeType.AsPattern: {
      const asPattern = pattern as AsPattern;
      checkMatchPattern(ctx, asPattern.pattern, discriminantType);
      // Use the narrowed type from the inner pattern if available
      const narrowedType =
        (asPattern.pattern as any).inferredType ?? discriminantType;
      ctx.declare(asPattern.name.name, narrowedType, 'let', asPattern.name);
      break;
    }
    case NodeType.NumberLiteral: {
      if (discriminantType.kind !== TypeKind.Number) {
        // Allow if discriminant is compatible (e.g. any/unknown/union including number)
        // For now, strict check?
        // "is" check works for any type.
        // But "case 10" implies equality check.
        // If discriminant is String, "case 10" is always false (or type error).
        // Let's allow it but maybe warn? Or strict error?
        // Zena is strongly typed.
        // If I match on string, case 10 is invalid.
        if (
          discriminantType !== Types.Unknown &&
          discriminantType.kind !== TypeKind.Union
        ) {
          ctx.diagnostics.reportError(
            `Type mismatch: cannot match number against ${typeToString(discriminantType)}`,
            DiagnosticCode.TypeMismatch,
            undefined /* TODO fix location */,
          );
        }
      }
      break;
    }
    case NodeType.StringLiteral: {
      const stringType =
        ctx.getWellKnownType(Types.String.name) || Types.String;
      if (
        !isAssignableTo(ctx, stringType, discriminantType) &&
        !isAssignableTo(ctx, discriminantType, stringType)
      ) {
        ctx.diagnostics.reportError(
          `Type mismatch: cannot match string against ${typeToString(discriminantType)}`,
          DiagnosticCode.TypeMismatch,
          undefined /* TODO fix location */,
        );
      }
      break;
    }
    case NodeType.BooleanLiteral: {
      // Boolean literal pattern can match boolean type or boolean literal types
      if (
        !isBooleanType(discriminantType) &&
        discriminantType.kind !== TypeKind.Unknown
      ) {
        ctx.diagnostics.reportError(
          `Type mismatch: cannot match boolean against ${typeToString(discriminantType)}`,
          DiagnosticCode.TypeMismatch,
          undefined /* TODO fix location */,
        );
      }
      break;
    }
    case NodeType.NullLiteral: {
      // Null matches nullable types
      break;
    }
    case NodeType.ClassPattern: {
      const classPattern = pattern as ClassPattern;
      const className = classPattern.name.name;
      const type = ctx.resolveType(className);

      if (!type || type.kind !== TypeKind.Class) {
        ctx.diagnostics.reportError(
          `'${className}' is not a class.`,
          DiagnosticCode.SymbolNotFound,
          undefined /* TODO fix location */,
        );
        return;
      }

      let classType = type as ClassType;

      // For generic sealed variant matching: if the pattern class is a generic
      // variant (e.g., Ok<T>) and the discriminant is an instantiated sealed class
      // (e.g., Result<i32>), instantiate the variant's type parameters.
      const extractedDiscClass = extractClassType(discriminantType);
      if (
        classType.typeParameters &&
        classType.typeParameters.length > 0 &&
        extractedDiscClass
      ) {
        const discClass = extractedDiscClass;
        const sealedSource = discClass.genericSource || discClass;
        if (
          sealedSource.isSealed &&
          sealedSource.sealedVariants &&
          discClass.typeArguments
        ) {
          // Check if pattern class is a variant of the discriminant's sealed type
          const isVariant = sealedSource.sealedVariants.some(
            (v) =>
              (v.genericSource || v) === (classType.genericSource || classType),
          );
          if (isVariant && sealedSource.typeParameters) {
            // Build type map from the sealed parent's type params to the discriminant's type args
            const typeMap = new Map<string, Type>();
            sealedSource.typeParameters.forEach((param, index) => {
              if (index < discClass.typeArguments!.length) {
                typeMap.set(param.name, discClass.typeArguments![index]);
              }
            });
            // classType is a generic template (has typeParameters but no typeArguments).
            // substituteType only processes classes with typeArguments, so we first
            // create an identity-instantiated version, then substitute.
            const identityArgs = classType.typeParameters.map(
              (p) =>
                ({
                  kind: TypeKind.TypeParameter,
                  name: p.name,
                }) as TypeParameterType,
            );
            const withIdentity = {
              ...classType,
              typeArguments: identityArgs,
              genericSource: classType,
            } as ClassType;
            classType = ctx.substituteTypeParams(
              withIdentity,
              typeMap,
            ) as ClassType;
          }
        }
      }

      // Store the resolved class type on the pattern for codegen
      classPattern.inferredType = classType;

      // Check compatibility
      if (
        !isAssignableTo(ctx, classType, discriminantType) &&
        !isAssignableTo(ctx, discriminantType, classType)
      ) {
        ctx.diagnostics.reportError(
          `Type mismatch: cannot match class '${className}' against ${typeToString(discriminantType)}`,
          DiagnosticCode.TypeMismatch,
          undefined /* TODO fix location */,
        );
      }

      // Destructure properties
      // We need to check if properties exist on classType and bind them
      for (const prop of classPattern.properties) {
        const propName = prop.name.name;
        if (
          !classType.fields.has(propName) &&
          !classType.methods.has(propName)
        ) {
          // Also check accessors (which are methods in Zena?)
          // Accessors are methods in ClassType?
          // "Implement Accessors (Parser, Checker, Codegen)"
          // Let's assume they are in fields or methods.
          // ClassType has fields and methods.
          ctx.diagnostics.reportError(
            `Property '${propName}' does not exist on type '${className}'.`,
            DiagnosticCode.PropertyNotFound,
            undefined /* TODO fix location */,
          );
          continue;
        }

        let propType: Type = Types.Unknown;
        if (classType.fields.has(propName)) {
          propType = resolveMemberType(
            classType,
            classType.fields.get(propName)!,
            ctx,
          );
        } else if (classType.methods.has(propName)) {
          // If it's a getter?
          // Methods map stores FunctionType.
          // If it's a getter, we want the return type.
          // But `methods` map in `ClassType` stores methods.
          // Accessors might be stored differently?
          // Let's check `ClassType` definition in `types.ts`.
          // I can't see `types.ts` right now.
          // But `checkMemberExpression` uses `classType.fields.get` and `classType.methods.get`.
          // If it's a getter, it might be in methods with a specific name?
          // Or maybe `fields` includes getters?
          // "Implement Property Access syntax (rewrite `obj.prop` to method calls)."
          // If `obj.prop` works, then `fields` or `methods` has it.
          // If it's a method, we can't destructure it as a value unless we call it?
          // Destructuring `let {x} = point` usually means `point.x`.
          // So if `point.x` is valid, destructuring is valid.
          // `checkMemberExpression` handles it.
          // So I should use similar logic to resolve property type.
          // For now, assume fields.
          propType = Types.Unknown; // Fallback
        }

        // Recursively check pattern
        checkMatchPattern(ctx, prop.value as any, propType);
      }
      break;
    }
    case NodeType.RecordPattern: {
      const recordPattern = pattern as RecordPattern;

      // If discriminant is a Record, Class, or Interface, check fields
      if (discriminantType.kind === TypeKind.Record) {
        const recordType = discriminantType as RecordType;
        for (const prop of recordPattern.properties) {
          const propName = prop.name.name;
          if (!recordType.properties.has(propName)) {
            ctx.diagnostics.reportError(
              `Property '${propName}' does not exist on type '${typeToString(discriminantType)}'.`,
              DiagnosticCode.PropertyNotFound,
              undefined /* TODO fix location */,
            );
            continue;
          }
          const propType = recordType.properties.get(propName)!;
          checkMatchPattern(ctx, prop.value, propType);
        }
      } else if (discriminantType.kind === TypeKind.Class) {
        const classType = discriminantType as ClassType;
        for (const prop of recordPattern.properties) {
          const propName = prop.name.name;
          // Check fields and methods (getters)
          let propType: Type | undefined;
          if (classType.fields.has(propName)) {
            propType = resolveMemberType(
              classType,
              classType.fields.get(propName)!,
              ctx,
            );
          } else if (classType.methods.has(propName)) {
            propType = resolveMemberType(
              classType,
              classType.methods.get(propName)!,
              ctx,
            );
          }

          if (!propType) {
            ctx.diagnostics.reportError(
              `Property '${propName}' does not exist on type '${typeToString(discriminantType)}'.`,
              DiagnosticCode.PropertyNotFound,
              undefined /* TODO fix location */,
            );
            continue;
          }
          checkMatchPattern(ctx, prop.value, propType);
        }
      } else if (discriminantType.kind === TypeKind.Union) {
        const unionType = discriminantType as UnionType;
        // Check if pattern matches any member of the union
        const matchingMembers = unionType.types.filter((t) => {
          if (t.kind === TypeKind.Record) {
            const rt = t as RecordType;
            return recordPattern.properties.every((p) =>
              rt.properties.has(p.name.name),
            );
          }
          // TODO: Handle classes in union too?
          return false;
        });

        if (matchingMembers.length === 0) {
          ctx.diagnostics.reportError(
            `Pattern does not match any type in the union '${typeToString(discriminantType)}'.`,
            DiagnosticCode.TypeMismatch,
            undefined /* TODO fix location */,
          );
        } else {
          // For each property, check against the union of property types from matching members
          for (const prop of recordPattern.properties) {
            const propTypes = matchingMembers.map(
              (t) => (t as RecordType).properties.get(prop.name.name)!,
            );
            const propType = createUnionType(propTypes);
            checkMatchPattern(ctx, prop.value, propType);
          }
        }
      } else {
        // Allow if unknown or any?
        if (discriminantType !== Types.Unknown) {
          ctx.diagnostics.reportError(
            `Cannot destructure non-object type '${typeToString(discriminantType)}'.`,
            DiagnosticCode.TypeMismatch,
            undefined /* TODO fix location */,
          );
        }
      }
      break;
    }
    case NodeType.InlineTuplePattern:
    case NodeType.TuplePattern: {
      const tuplePattern = pattern as TuplePattern;

      // Mutate TuplePattern → InlineTuplePattern when the value type is inline
      if (pattern.type === NodeType.TuplePattern) {
        const isInline =
          discriminantType.kind === TypeKind.InlineTuple ||
          (discriminantType.kind === TypeKind.Union &&
            (discriminantType as UnionType).types.some(
              (t) => t.kind === TypeKind.InlineTuple,
            ));
        if (isInline) {
          (pattern as any).type = NodeType.InlineTuplePattern;
        }
      }

      // Handle direct tuple types
      if (
        discriminantType.kind === TypeKind.Tuple ||
        discriminantType.kind === TypeKind.InlineTuple
      ) {
        const tupleType = discriminantType as TupleType;
        if (tuplePattern.elements.length > tupleType.elementTypes.length) {
          ctx.diagnostics.reportError(
            `Tuple pattern has ${tuplePattern.elements.length} elements but type has ${tupleType.elementTypes.length}.`,
            DiagnosticCode.TypeMismatch,
            undefined /* TODO fix location */,
          );
        }

        for (let i = 0; i < tuplePattern.elements.length; i++) {
          const elemPattern = tuplePattern.elements[i];
          if (elemPattern && i < tupleType.elementTypes.length) {
            checkMatchPattern(ctx, elemPattern, tupleType.elementTypes[i]);
          }
        }
      } else if (discriminantType.kind === TypeKind.Union) {
        // Handle union of tuples - for each position, compute union of element types
        const unionType = discriminantType as UnionType;
        let tupleMembers = unionType.types.filter(
          (t) => t.kind === TypeKind.Tuple || t.kind === TypeKind.InlineTuple,
        ) as TupleType[];

        if (tupleMembers.length === 0) {
          ctx.diagnostics.reportError(
            `Cannot destructure non-tuple type '${typeToString(discriminantType)}'.`,
            DiagnosticCode.TypeMismatch,
            undefined /* TODO fix location */,
          );
          break;
        }

        // Narrow tuple union based on literal patterns
        // If a pattern element is a literal (e.g., `true`), filter tuple members
        // to only those where that position's type is compatible with the literal.
        tupleMembers = narrowTupleUnionByLiteralPatterns(
          tupleMembers,
          tuplePattern.elements,
        );

        if (tupleMembers.length === 0) {
          // Pattern is unreachable (no tuple member matches the literal patterns)
          // This could be a warning, but for now we'll just skip binding
          break;
        }

        // Use the first tuple's element count as reference
        const elemCount = tupleMembers[0].elementTypes.length;
        if (tuplePattern.elements.length > elemCount) {
          ctx.diagnostics.reportError(
            `Tuple pattern has ${tuplePattern.elements.length} elements but type has ${elemCount}.`,
            DiagnosticCode.TypeMismatch,
            undefined /* TODO fix location */,
          );
        }

        // For each element position, compute the union of types at that position
        for (let i = 0; i < tuplePattern.elements.length; i++) {
          const elemPattern = tuplePattern.elements[i];
          if (elemPattern && i < elemCount) {
            // Collect types at position i from all tuple members
            const elemTypes = tupleMembers
              .filter((t) => i < t.elementTypes.length)
              .map((t) => t.elementTypes[i]);

            // Create union of element types (or single type if all same)
            const elemType =
              elemTypes.length === 1
                ? elemTypes[0]
                : createUnionType(elemTypes);
            checkMatchPattern(ctx, elemPattern, elemType);
          }
        }
      } else if (discriminantType.kind === TypeKind.Array) {
        // Array destructuring?
        const arrayType = discriminantType as ArrayType;
        for (const elemPattern of tuplePattern.elements) {
          if (elemPattern) {
            checkMatchPattern(ctx, elemPattern, arrayType.elementType);
          }
        }
      } else {
        if (discriminantType !== Types.Unknown) {
          ctx.diagnostics.reportError(
            `Cannot destructure non-tuple type '${typeToString(discriminantType)}'.`,
            DiagnosticCode.TypeMismatch,
            undefined /* TODO fix location */,
          );
        }
      }
      break;
    }
    case NodeType.LogicalPattern: {
      const logicalPattern = pattern as LogicalPattern;
      if (logicalPattern.operator === '&&') {
        checkMatchPattern(ctx, logicalPattern.left, discriminantType);
        checkMatchPattern(ctx, logicalPattern.right, discriminantType);
      } else {
        // OR Pattern
        ctx.enterScope();
        checkMatchPattern(ctx, logicalPattern.left, discriminantType);
        const leftScope = ctx.scopes[ctx.scopes.length - 1];
        const leftVars = new Map(leftScope);
        ctx.exitScope();

        ctx.enterScope();
        checkMatchPattern(ctx, logicalPattern.right, discriminantType);
        const rightScope = ctx.scopes[ctx.scopes.length - 1];
        const rightVars = new Map(rightScope);
        ctx.exitScope();

        // Verify variables
        for (const [key] of leftVars) {
          if (!rightVars.has(key)) {
            const name = key.includes(':') ? key.split(':')[1] : key;
            ctx.diagnostics.reportError(
              `Variable '${name}' is bound in the left branch of the OR pattern but not the right.`,
              DiagnosticCode.TypeMismatch,
              undefined /* TODO fix location */,
            );
          }
        }

        for (const [key] of rightVars) {
          if (!leftVars.has(key)) {
            const name = key.includes(':') ? key.split(':')[1] : key;
            ctx.diagnostics.reportError(
              `Variable '${name}' is bound in the right branch of the OR pattern but not the left.`,
              DiagnosticCode.TypeMismatch,
              undefined /* TODO fix location */,
            );
          }
        }

        // Declare merged variables
        for (const [key, leftInfo] of leftVars) {
          if (rightVars.has(key)) {
            const rightInfo = rightVars.get(key)!;
            const mergedType = createUnionType([leftInfo.type, rightInfo.type]);
            const name = key.includes(':') ? key.split(':')[1] : key;
            // Use the left declaration for the merged binding
            ctx.declare(name, mergedType, leftInfo.kind, leftInfo.declaration);
          }
        }
      }
      break;
    }
    case NodeType.MemberExpression: {
      // Enum member pattern: e.g., `case TokenType.Whitespace:`
      // Check that the member expression is valid and get its type
      const memberType = checkExpression(ctx, pattern as MemberExpression);

      // The pattern should be assignable to/from the discriminant
      if (
        !isAssignableTo(ctx, memberType, discriminantType) &&
        !isAssignableTo(ctx, discriminantType, memberType)
      ) {
        ctx.diagnostics.reportError(
          `Type mismatch: cannot match '${typeToString(memberType)}' against '${typeToString(discriminantType)}'.`,
          DiagnosticCode.TypeMismatch,
          undefined /* TODO fix location */,
        );
      }
      break;
    }
    default:
      // pattern.type satisfies never;
      break;
  }
}

/**
 * Narrows a union of tuple types based on literal patterns.
 *
 * When a pattern element is a literal (e.g., `true`, `42`, `"foo"`), we filter
 * the tuple members to only those where that position's type is compatible
 * with the literal value.
 *
 * For example, with pattern `(true, elem)` matching `(true, T) | (false, never)`:
 * - Position 0 is literal `true`
 * - Filter tuples: only `(true, T)` has first element compatible with `true`
 * - Result: `[(true, T)]`
 * - Position 1 then becomes just `T` instead of `T | never`
 */
function narrowTupleUnionByLiteralPatterns(
  tupleMembers: TupleType[],
  patternElements: (Pattern | null)[],
): TupleType[] {
  let filtered = tupleMembers;

  for (let i = 0; i < patternElements.length && filtered.length > 0; i++) {
    const pattern = patternElements[i];
    if (!pattern) continue;

    // Check if pattern at this position is a literal
    const literalType = getLiteralPatternType(pattern);
    if (!literalType) continue;

    // Filter tuple members to only those where position i is compatible with the literal
    filtered = filtered.filter((tuple) => {
      if (i >= tuple.elementTypes.length) return false;
      const elemType = tuple.elementTypes[i];
      return isTypeCompatibleWithLiteral(elemType, literalType);
    });
  }

  return filtered;
}

/**
 * Extracts a literal type from a pattern if the pattern is a literal pattern.
 * Returns null for non-literal patterns (identifiers, wildcards, etc.).
 */
function getLiteralPatternType(pattern: Pattern): LiteralType | null {
  switch (pattern.type) {
    case NodeType.BooleanLiteral:
      return {
        kind: TypeKind.Literal,
        value: (pattern as BooleanLiteral).value,
      } as LiteralType;
    case NodeType.NumberLiteral:
      return {
        kind: TypeKind.Literal,
        value: Number((pattern as NumberLiteral).raw),
      } as LiteralType;
    case NodeType.StringLiteral:
      return {
        kind: TypeKind.Literal,
        value: (pattern as StringLiteral).value,
      } as LiteralType;
    default:
      return null;
  }
}

/**
 * Checks if a type is compatible with a literal pattern.
 * - A literal type is compatible if it has the same value
 * - A non-literal type of the same base type is compatible (e.g., `boolean` matches `true`)
 * - never is never compatible (patterns can't match never)
 */
function isTypeCompatibleWithLiteral(
  type: Type,
  literal: LiteralType,
): boolean {
  // never is never compatible
  if (type.kind === TypeKind.Never) return false;

  // If the type is itself a literal, it must have the same value
  if (type.kind === TypeKind.Literal) {
    const typeLiteral = type as LiteralType;
    return typeLiteral.value === literal.value;
  }

  // Union type: any member must be compatible
  if (type.kind === TypeKind.Union) {
    return (type as UnionType).types.some((t) =>
      isTypeCompatibleWithLiteral(t, literal),
    );
  }

  // Non-literal type: check if the base type matches
  // e.g., `boolean` matches literal `true`, `i32` matches literal `42`
  const literalValueType = typeof literal.value;
  if (literalValueType === 'boolean') {
    return isBooleanType(type);
  }
  if (literalValueType === 'number') {
    return type.kind === TypeKind.Number;
  }
  if (literalValueType === 'string') {
    // String type is TypeKind.Class with name 'String'
    return (
      type.kind === TypeKind.Class && (type as ClassType).name === 'String'
    );
  }

  return false;
}

function createUnionType(types: Type[]): Type {
  if (types.length === 0) return Types.Void;
  if (types.length === 1) return types[0];

  const flatTypes: Type[] = [];
  for (const t of types) {
    if (t.kind === TypeKind.Union) {
      flatTypes.push(...(t as UnionType).types);
    } else {
      flatTypes.push(t);
    }
  }

  // Filter out Never types, unless all are Never
  // T | never => T
  const nonNeverTypes = flatTypes.filter((t) => t.kind !== TypeKind.Never);
  const typesToProcess = nonNeverTypes.length > 0 ? nonNeverTypes : flatTypes;

  // Collapse literal types into their base types when both are present
  // e.g., boolean | false => boolean, i32 | 5 => i32, String | "hello" => String
  const collapsedTypes: Type[] = [];
  let hasBoolean = false;
  let hasNumber = false;
  let hasString = false;

  // First pass: detect base types
  for (const t of typesToProcess) {
    if (t.kind === TypeKind.Boolean) hasBoolean = true;
    if (t.kind === TypeKind.Number) hasNumber = true;
    if (t.kind === TypeKind.Class && (t as ClassType).name === 'String')
      hasString = true;
  }

  // Second pass: filter out literals that are subsumed by base types
  for (const t of typesToProcess) {
    if (t.kind === TypeKind.Literal) {
      const lit = t as LiteralType;
      // Skip boolean literals if we have boolean base type
      if (typeof lit.value === 'boolean' && hasBoolean) continue;
      // Skip number literals if we have a number base type
      if (typeof lit.value === 'number' && hasNumber) continue;
      // Skip string literals if we have String class type
      if (typeof lit.value === 'string' && hasString) continue;
    }
    collapsedTypes.push(t);
  }

  // Deduplicate
  const uniqueTypes: Type[] = [];
  const seen = new Set<string>();
  for (const t of collapsedTypes) {
    const s = typeToString(t);
    if (!seen.has(s)) {
      seen.add(s);
      uniqueTypes.push(t);
    }
  }

  if (uniqueTypes.length === 1) return uniqueTypes[0];

  return {
    kind: TypeKind.Union,
    types: uniqueTypes,
  } as UnionType;
}

function checkUnaryExpression(
  ctx: CheckerContext,
  expr: UnaryExpression,
): Type {
  const argType = checkExpression(ctx, expr.argument);
  if (expr.operator === '!') {
    if (!isBooleanType(argType)) {
      ctx.diagnostics.reportError(
        `Operator '!' requires boolean operand, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }
    return Types.Boolean;
  } else if (expr.operator === '-') {
    if (argType.kind !== TypeKind.Number) {
      ctx.diagnostics.reportError(
        `Operator '-' requires numeric operand, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
      return Types.Unknown;
    }
    return argType;
  }
  return Types.Unknown;
}

function checkThrowExpression(
  ctx: CheckerContext,
  expr: ThrowExpression,
): Type {
  const argType = checkExpression(ctx, expr.argument);
  const errorType = ctx.resolveWellKnownType(TypeNames.Error);
  if (errorType) {
    if (!isAssignableTo(ctx, argType, errorType)) {
      ctx.diagnostics.reportError(
        `Thrown value must be an instance of Error, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }
  }
  return Types.Never;
}

function checkTryExpression(ctx: CheckerContext, expr: TryExpression): Type {
  // Check the try body
  const tryType = checkBlockExpressionType(ctx, expr.body);

  // Check the catch clause
  let catchType: Type | null = null;
  if (expr.handler) {
    catchType = checkCatchClause(ctx, expr.handler);
  }

  // Check the finally block (doesn't contribute to the expression type)
  if (expr.finalizer) {
    checkBlockExpressionType(ctx, expr.finalizer);
  }

  // The type of the try/catch expression is the union of:
  // - The try body type
  // - The catch body type (if present)
  // If no catch, it's just the try type (errors will propagate)
  if (catchType !== null) {
    return createUnionType([tryType, catchType]);
  }
  return tryType;
}

function checkCatchClause(ctx: CheckerContext, clause: CatchClause): Type {
  ctx.enterScope();

  // If there's a parameter, bind it to the Error type (or eqref for now)
  if (clause.param) {
    const errorType =
      ctx.resolveWellKnownType(TypeNames.Error) ?? Types.Unknown;
    ctx.declare(clause.param.name, errorType, 'let', clause.param);
  }

  const bodyType = checkBlockExpressionType(ctx, clause.body);

  ctx.exitScope();
  return bodyType;
}

/**
 * Checks if a type is a value primitive (i32, i64, f32, f64, boolean).
 * These types have stack-based WASM representation and cannot be cast to reference types.
 */
function isValuePrimitive(type: Type): boolean {
  if (type.kind === TypeKind.Number || type.kind === TypeKind.Boolean) {
    return true;
  }
  if (type.kind === TypeKind.Literal) {
    const lit = type as LiteralType;
    return typeof lit.value === 'number' || typeof lit.value === 'boolean';
  }
  return false;
}

/**
 * Checks if a type is a reference type (class, interface, array, string, etc.).
 * Reference types have heap-based WASM representation.
 * Extension classes on primitives are NOT considered reference types for this check.
 */
function isReferenceType(type: Type): boolean {
  switch (type.kind) {
    case TypeKind.Class: {
      // Extension classes on primitives (like `extension class Meters on i32`)
      // are NOT reference types - they are nominal wrappers around primitives
      const classType = type as ClassType;
      if (classType.isExtension && classType.onType) {
        return !isValuePrimitive(classType.onType);
      }
      return true;
    }
    case TypeKind.Interface:
    case TypeKind.Array:
    case TypeKind.Record:
    case TypeKind.Tuple:
    case TypeKind.Function:
    case TypeKind.Null:
    case TypeKind.AnyRef:
    case TypeKind.ByteArray:
      return true;
    case TypeKind.Literal:
      // String literals are reference types
      return typeof (type as LiteralType).value === 'string';
    default:
      return false;
  }
}

/**
 * Checks if a cast from source to target is valid.
 * Returns true if the cast should be allowed.
 */
function isValidCast(sourceType: Type, targetType: Type): boolean {
  // Primitive → Extension on same primitive: VALID (distinct type wrapping)
  if (
    isValuePrimitive(sourceType) &&
    targetType.kind === TypeKind.Class &&
    (targetType as ClassType).isExtension &&
    (targetType as ClassType).onType
  ) {
    const onType = (targetType as ClassType).onType!;
    // Allow cast if the onType matches the source primitive type
    // (or both are numeric types, allowing i32 -> Meters on i32)
    if (
      sourceType.kind === TypeKind.Number &&
      onType.kind === TypeKind.Number
    ) {
      return true;
    }
    if (
      sourceType.kind === TypeKind.Boolean &&
      onType.kind === TypeKind.Boolean
    ) {
      return true;
    }
  }

  // Primitive → Reference (not an extension on primitive): INVALID
  if (isValuePrimitive(sourceType) && isReferenceType(targetType)) {
    return false;
  }

  // All other casts are allowed (checked at runtime)
  return true;
}

function checkAsExpression(ctx: CheckerContext, expr: AsExpression): Type {
  const sourceType = checkExpression(ctx, expr.expression);
  const targetType = resolveTypeAnnotation(ctx, expr.typeAnnotation);

  // Reject union types as cast targets
  if (targetType.kind === TypeKind.Union) {
    ctx.diagnostics.reportError(
      `Cannot use union type '${typeToString(targetType)}' as cast target. Cast to each type separately.`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.typeAnnotation.loc),
    );
  }

  // Validate the cast is semantically valid
  if (!isValidCast(sourceType, targetType)) {
    ctx.diagnostics.reportError(
      `Cannot cast primitive type '${typeToString(sourceType)}' to reference type '${typeToString(targetType)}'. ` +
        `Use string concatenation or a conversion function instead.`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
  }

  return targetType;
}

function checkIsExpression(ctx: CheckerContext, expr: IsExpression): Type {
  checkExpression(ctx, expr.expression);
  const targetType = resolveTypeAnnotation(ctx, expr.typeAnnotation);

  // Reject union types as is-check targets
  if (targetType.kind === TypeKind.Union) {
    ctx.diagnostics.reportError(
      `Cannot use union type '${typeToString(targetType)}' with 'is'. Test each type separately.`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.typeAnnotation.loc),
    );
  }

  return Types.Boolean;
}

function checkExpressionAgainstLiteralType(
  expr: Expression,
  targetType: Type,
): boolean {
  // Check if the expression matches the target literal type
  if (targetType.kind === TypeKind.Literal) {
    const literalType = targetType as LiteralType;
    if (expr.type === NodeType.StringLiteral) {
      return (
        typeof literalType.value === 'string' &&
        (expr as StringLiteral).value === literalType.value
      );
    }
    if (expr.type === NodeType.NumberLiteral) {
      return (
        typeof literalType.value === 'number' &&
        Number((expr as NumberLiteral).raw) === literalType.value
      );
    }
    if (expr.type === NodeType.BooleanLiteral) {
      return (
        typeof literalType.value === 'boolean' &&
        (expr as BooleanLiteral).value === literalType.value
      );
    }
  } else if (targetType.kind === TypeKind.Union) {
    // Check if the expression matches any literal in the union
    const unionType = targetType as UnionType;
    return unionType.types.some((t) =>
      checkExpressionAgainstLiteralType(expr, t),
    );
  }
  return false;
}

function checkCallExpression(ctx: CheckerContext, expr: CallExpression): Type {
  if (expr.callee.type === NodeType.SuperExpression) {
    // super() must be called in the initializer list, not the constructor body
    ctx.diagnostics.reportError(
      `'super()' must be called in the constructor initializer list, not the body. Use: new(...) : super(...) { }`,
      DiagnosticCode.UnknownError,
      ctx.getLocation(expr.loc),
    );
    return Types.Void;
  }

  let calleeType = checkExpression(ctx, expr.callee);

  // Handle optional call: expr?()
  // If the callee is nullable, we extract the non-null type for the call
  // and make the result nullable. If non-nullable, optional call is a no-op.
  let shouldMakeNullable = false;
  if (expr.optional && isNullableType(calleeType)) {
    shouldMakeNullable = true;
    calleeType = getNonNullableType(calleeType, ctx);
  }

  // Helper to wrap result in nullable if needed
  const wrapResult = (type: Type): Type => {
    if (
      shouldMakeNullable &&
      type.kind !== TypeKind.Unknown &&
      type.kind !== TypeKind.Void
    ) {
      return makeNullable(type, ctx);
    }
    return type;
  };

  // Determine expected parameter types for contextual typing of closures
  // For non-generic functions, we know the parameter types immediately.
  // For generic functions with type parameters, we can still provide partial contextual types
  // that help infer closure parameter types from the parts that are already known.
  // E.g., for `map<U>(f: (item: T) => U)` where T=i32, we can tell that `item` should be i32
  // even before we know U.
  let expectedParamTypes: Type[] | undefined;
  if (calleeType.kind === TypeKind.Function) {
    // Use parameter types for contextual typing - even if the function is generic,
    // class type parameters (like T in FixedArray<T>) are already substituted
    expectedParamTypes = (calleeType as FunctionType).parameters;
  }

  // Check arguments with contextual types where available
  const argTypes = expr.arguments.map((arg, i) => {
    const expectedType = expectedParamTypes?.[i];
    return checkExpression(ctx, arg, expectedType);
  });

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
        ctx.getLocation(expr.loc),
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
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }

      // Check argument types
      for (let i = 0; i < funcMember.parameters.length; i++) {
        if (!isAssignableTo(ctx, argTypes[i], funcMember.parameters[i])) {
          ctx.diagnostics.reportError(
            `Argument ${i + 1} of type ${typeToString(argTypes[i])} is not assignable to parameter of type ${typeToString(funcMember.parameters[i])} in union member ${typeToString(member)}.`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(expr.loc),
          );
          return Types.Unknown;
        }
      }

      // Unify return types
      if (returnType === null) {
        returnType = funcMember.returnType;
      } else if (!isAssignableTo(ctx, funcMember.returnType, returnType)) {
        // If not assignable one way, try the other (simple union check)
        if (isAssignableTo(ctx, returnType, funcMember.returnType)) {
          returnType = funcMember.returnType;
        } else {
          // TODO: Create a union of return types? For now, error.
          ctx.diagnostics.reportError(
            `Incompatible return types in union call: ${typeToString(returnType)} vs ${typeToString(funcMember.returnType)}.`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(expr.loc),
          );
          return Types.Unknown;
        }
      }
    }

    return wrapResult(returnType || Types.Void);
  }

  if (calleeType.kind !== TypeKind.Function) {
    ctx.diagnostics.reportError(
      `Type mismatch: expected function, got ${typeToString(calleeType)}`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  let funcType = calleeType as FunctionType;

  // Placeholder types from forward-reference pre-declaration have no real
  // param/return types. We need to distinguish between:
  // 1. Recursive/mutually recursive calls → require return type annotation
  // 2. Pure forward references → eagerly check the function to infer its type
  if (funcType.isPlaceholder) {
    // Try to get the declaration of the callee
    let calleeDecl: VariableDeclaration | null = null;
    if (expr.callee.type === NodeType.Identifier) {
      const symbolInfo = ctx.resolveValueInfo((expr.callee as Identifier).name);
      if (
        symbolInfo?.declaration &&
        symbolInfo.declaration.type === NodeType.VariableDeclaration
      ) {
        calleeDecl = symbolInfo.declaration as VariableDeclaration;
      }
    }

    if (calleeDecl) {
      if (ctx.isFunctionResolving(calleeDecl)) {
        // Recursive call to a function that's being resolved
        // This requires a return type annotation - report at the function definition
        ctx.diagnostics.reportError(
          `Recursive function requires an explicit return type annotation`,
          DiagnosticCode.UnknownError,
          ctx.getLocation(calleeDecl.loc),
        );
        expr.inferredType = Types.Unknown;
        return Types.Unknown;
      } else {
        // Pure forward reference - eagerly check the function.
        // checkStatement will add it to the resolving set internally.
        checkStatement(ctx, calleeDecl);

        // After checking, the declaration should have its real type
        if (
          calleeDecl.inferredType &&
          calleeDecl.inferredType.kind === TypeKind.Function
        ) {
          funcType = calleeDecl.inferredType as FunctionType;
          // Also update the symbol info so future lookups get the real type
          if (expr.callee.type === NodeType.Identifier) {
            const symbolInfo = ctx.resolveValueInfo(
              (expr.callee as Identifier).name,
            );
            if (symbolInfo) {
              symbolInfo.type = funcType;
            }
          }
        } else {
          // Failed to infer, use placeholder return
          expr.inferredType = funcType.returnType;
          return funcType.returnType;
        }
      }
    } else {
      // Can't determine declaration, use placeholder return
      expr.inferredType = funcType.returnType;
      return funcType.returnType;
    }
  }

  // Overload resolution
  if (funcType.overloads && funcType.overloads.length > 0) {
    const candidates = [funcType, ...funcType.overloads];
    let bestMatch: FunctionType | null = null;

    for (const candidate of candidates) {
      if (candidate.parameters.length !== argTypes.length) continue;

      let match = true;
      // TODO: Handle generic overloads
      for (let i = 0; i < argTypes.length; i++) {
        if (!isAssignableTo(ctx, argTypes[i], candidate.parameters[i])) {
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
          ctx.getLocation(expr.loc),
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
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }
      typeArguments = inferred;
      // Store inferred type arguments in AST for Codegen
      expr.inferredTypeArguments = inferred;
    }

    // Constraint validation is done inside instantiateGenericFunction
    funcType = instantiateGenericFunction(funcType, typeArguments, ctx);

    // Re-check closure arguments with instantiated parameter types for contextual typing
    // This allows closures like `(x) => x * 2` to infer parameter types in generic calls
    for (let i = 0; i < expr.arguments.length; i++) {
      const arg = expr.arguments[i];
      if (arg.type === NodeType.FunctionExpression) {
        const funcExpr = arg as FunctionExpression;
        // Check if any parameter lacks a type annotation
        const needsContextualTyping = funcExpr.params.some(
          (p) => !p.typeAnnotation,
        );
        if (needsContextualTyping && i < funcType.parameters.length) {
          // Re-check with contextual type to infer parameter types
          const newType = checkExpression(ctx, arg, funcType.parameters[i]);
          argTypes[i] = newType;
        }
      }
    }
  }

  expr.resolvedFunctionType = funcType;

  if (expr.arguments.length !== funcType.parameters.length) {
    const minArity = funcType.optionalParameters
      ? funcType.optionalParameters.filter((o) => !o).length
      : funcType.parameters.length;

    if (
      expr.arguments.length < minArity ||
      expr.arguments.length > funcType.parameters.length
    ) {
      ctx.diagnostics.reportError(
        `Expected ${minArity}-${funcType.parameters.length} arguments, got ${expr.arguments.length}`,
        DiagnosticCode.ArgumentCountMismatch,
        ctx.getLocation(expr.loc),
      );
    } else {
      // Fill in missing arguments with default values
      if (funcType.parameterInitializers) {
        // Track original argument count so codegen knows which args are defaults
        const originalArgCount = expr.arguments.length;
        let hasDefaults = false;

        for (
          let i = expr.arguments.length;
          i < funcType.parameters.length;
          i++
        ) {
          const initializer = funcType.parameterInitializers[i];
          if (initializer) {
            // Push the initializer AST node. The initializer was already type-checked
            // when the function/method was defined (in the callee's scope where `this`
            // and other parameters are available). We don't re-check it here because
            // the call site doesn't have the same scope as the callee.
            //
            // Note: This "caller supplies default" strategy means the default expression
            // is inlined at the call site. For defaults that reference `this` or other
            // parameters, codegen must ensure the expression is evaluated in the correct
            // context (see generateCallExpression).
            expr.arguments.push(initializer);
            // Use the parameter type as the argument type (the initializer was checked
            // to be compatible during function definition)
            argTypes.push(funcType.parameters[i]);
            hasDefaults = true;
          } else {
            // Optional but no default? Inject null.
            const nullLiteral: Expression = {
              type: NodeType.NullLiteral,
            };
            expr.arguments.push(nullLiteral);
            argTypes.push(Types.Null);
          }
        }

        // Store metadata for codegen if we added any defaults
        if (hasDefaults) {
          expr.originalArgCount = originalArgCount;

          // Store parameter names so codegen can create bindings for earlier params
          // when generating defaults that reference them (e.g., `end = this.length - start`)
          if (funcType.parameterNames) {
            expr.defaultArgParamNames = funcType.parameterNames;
          }

          // For method calls, store the owner class for `this` context in defaults
          if (expr.callee.type === NodeType.MemberExpression) {
            const memberExpr = expr.callee as MemberExpression;
            const objectType = checkExpression(ctx, memberExpr.object);
            if (objectType.kind === TypeKind.Class) {
              expr.defaultArgsOwner = objectType;
            }
          }
        }
      }
    }
  }

  for (
    let i = 0;
    i < Math.min(expr.arguments.length, funcType.parameters.length);
    i++
  ) {
    const argType = argTypes[i];
    const paramType = funcType.parameters[i];
    const argExpr = expr.arguments[i];

    let compatible = isAssignableTo(ctx, argType, paramType);

    // Special handling for literal types
    if (!compatible) {
      compatible = checkExpressionAgainstLiteralType(argExpr, paramType);
    }

    if (!compatible) {
      ctx.diagnostics.reportError(
        `Type mismatch in argument ${i + 1}: expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(argExpr.loc),
      );
    }
  }

  return wrapResult(funcType.returnType);
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
        } else {
          // If we have conflicting literal types of the same base type, widen to the base type
          if (
            existing.kind === TypeKind.Literal &&
            argType.kind === TypeKind.Literal
          ) {
            const existingLit = existing as LiteralType;
            const argLit = argType as LiteralType;
            // If both are boolean literals but different values, widen to boolean
            if (
              typeof existingLit.value === 'boolean' &&
              typeof argLit.value === 'boolean'
            ) {
              if (existingLit.value !== argLit.value) {
                inferred.set(name, Types.Boolean);
              }
            }
            // Similarly for numbers (though less common)
            else if (
              typeof existingLit.value === 'number' &&
              typeof argLit.value === 'number'
            ) {
              if (existingLit.value !== argLit.value) {
                inferred.set(name, Types.I32);
              }
            }
          }
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

/**
 * Validates a nullish assignment (??=).
 * LHS must be nullable. RHS must be assignable to the non-null part of LHS.
 * The result type is the non-null part of the target type.
 */
function checkNullishAssignment(
  ctx: CheckerContext,
  expr: AssignmentExpression,
  targetType: Type,
  valueType: Type,
): Type {
  if (!isNullableType(targetType)) {
    ctx.diagnostics.reportError(
      `Left side of '??=' must be a nullable type, got '${typeToString(targetType)}'.`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
    return targetType;
  }
  const nonNullTarget = getNonNullableType(targetType, ctx);
  if (!isAssignableTo(ctx, valueType, nonNullTarget)) {
    ctx.diagnostics.reportError(
      `Type mismatch in '??=' assignment: expected '${typeToString(nonNullTarget)}', got '${typeToString(valueType)}'.`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
  }
  return nonNullTarget;
}

/**
 * Validates the binary operation inside a compound assignment (e.g., += -= *= /= %=).
 * Given the target type (LHS) and value type (RHS), checks that `targetType op valueType`
 * is valid and returns the result type of the binary operation.
 */
function checkCompoundOperator(
  ctx: CheckerContext,
  expr: AssignmentExpression,
  targetType: Type,
  valueType: Type,
): Type {
  const op = expr.operator!;

  // ??= is handled separately
  if (op === '??') {
    return checkNullishAssignment(ctx, expr, targetType, valueType);
  }

  // Check for operator overloading on class types
  if (op === '+' && targetType.kind === TypeKind.Class) {
    const classType = targetType as ClassType;
    const method = classType.methods.get(op);
    if (method) {
      const resolvedMethod = resolveMemberType(
        classType,
        method,
        ctx,
      ) as FunctionType;
      if (resolvedMethod.parameters.length !== 1) {
        ctx.diagnostics.reportError(
          `Operator ${op} must take exactly one argument.`,
          DiagnosticCode.ArgumentCountMismatch,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }
      if (!isAssignableTo(ctx, valueType, resolvedMethod.parameters[0])) {
        ctx.diagnostics.reportError(
          `Type mismatch in operator ${op}: expected ${typeToString(resolvedMethod.parameters[0])}, got ${typeToString(valueType)}`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
      }
      expr.resolvedOperatorMethod = resolvedMethod;
      return resolvedMethod.returnType;
    }
  }

  // Numeric type checking
  if (
    targetType.kind === TypeKind.Number &&
    valueType.kind === TypeKind.Number
  ) {
    const leftName = (targetType as NumberType).name;
    const rightName = (valueType as NumberType).name;

    const isI64 = (n: string) => n === Types.I64.name;
    const isU64 = (n: string) => n === Types.U64.name;
    const isF32 = (n: string) => n === Types.F32.name;
    const isF64 = (n: string) => n === Types.F64.name;

    if (op === '/') {
      // Division always produces float, which may not be assignable back to integer target
      let resultType: Type;
      if (
        isF64(leftName) ||
        isF64(rightName) ||
        isI64(leftName) ||
        isI64(rightName) ||
        isU64(leftName) ||
        isU64(rightName)
      ) {
        resultType = Types.F64;
      } else {
        resultType = Types.F32;
      }
      return resultType;
    }

    // For +, -, *, %: same logic as binary expression type promotion
    if (leftName === rightName) {
      return targetType;
    }
    if (isF64(leftName) || isF64(rightName)) return Types.F64;
    if (isF32(leftName) || isF32(rightName)) {
      if (
        isI64(leftName) ||
        isI64(rightName) ||
        isU64(leftName) ||
        isU64(rightName)
      )
        return Types.F64;
      return Types.F32;
    }
    if (isU64(leftName) || isU64(rightName)) return Types.U64;
    if (isI64(leftName) || isI64(rightName)) return Types.I64;
    // i32 + i32 or u32 + u32
    return targetType;
  }

  ctx.diagnostics.reportError(
    `Type mismatch: cannot apply operator '${op}' to ${typeToString(targetType)} and ${typeToString(valueType)}`,
    DiagnosticCode.TypeMismatch,
    ctx.getLocation(expr.loc),
  );
  return Types.Unknown;
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
        ctx.getLocation(expr.loc),
      );
      return Types.Unknown;
    }

    // Create and store the resolved binding for codegen
    const binding = createBinding(symbol, {
      // Local if we're inside a function scope (scopes.length > 1 means we're past the global scope)
      isLocal: !symbol.modulePath && ctx.scopes.length > 1,
    });
    if (binding) {
      ctx.semanticContext.setResolvedBinding(expr.left, binding);
    }

    if (symbol.kind !== 'var') {
      ctx.diagnostics.reportError(
        `Cannot assign to immutable variable '${varName}'.`,
        DiagnosticCode.InvalidAssignment,
        ctx.getLocation(expr.loc),
      );
    }

    const valueType = checkExpression(ctx, expr.value);
    const effectiveType = expr.operator
      ? checkCompoundOperator(ctx, expr, symbol.type, valueType)
      : valueType;
    if (!isAssignableTo(ctx, effectiveType, symbol.type)) {
      ctx.diagnostics.reportError(
        `Type mismatch in assignment: expected ${typeToString(symbol.type)}, got ${typeToString(effectiveType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }

    return effectiveType;
  } else if (expr.left.type === NodeType.MemberExpression) {
    const memberExpr = expr.left as MemberExpression;
    const objectType = checkExpression(ctx, memberExpr.object);

    if (
      objectType.kind !== TypeKind.Class &&
      objectType.kind !== TypeKind.Interface
    ) {
      if (objectType.kind !== Types.Unknown.kind) {
        ctx.diagnostics.reportError(
          `Property assignment on non-class type '${typeToString(objectType)}'.`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
      }
      return Types.Unknown;
    }

    const classType = objectType as ClassType | InterfaceType;

    // Handle symbol member assignment: obj.:symbol = value
    if (memberExpr.isSymbolAccess) {
      const symbolName = memberExpr.property.name;
      const symbolTypeValue = ctx.resolveValue(symbolName);

      if (!symbolTypeValue || symbolTypeValue.kind !== TypeKind.Symbol) {
        ctx.diagnostics.reportError(
          `'${symbolName}' is not defined or is not a symbol.`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }

      const symbolType = symbolTypeValue as SymbolType;
      memberExpr.resolvedSymbol = symbolType;

      // Check symbolFields
      if (classType.symbolFields?.has(symbolType)) {
        const fieldType = classType.symbolFields.get(symbolType)!;
        const resolvedFieldType = resolveMemberType(classType, fieldType, ctx);
        const valueType = checkExpression(ctx, expr.value);

        if (!isAssignableTo(ctx, valueType, resolvedFieldType)) {
          ctx.diagnostics.reportError(
            `Type mismatch in assignment: expected ${typeToString(resolvedFieldType)}, got ${typeToString(valueType)}`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(expr.loc),
          );
        }
        return valueType;
      }

      ctx.diagnostics.reportError(
        `Symbol '${symbolType.debugName ?? '<symbol>'}' does not exist on type '${classType.name}'.`,
        DiagnosticCode.PropertyNotFound,
        ctx.getLocation(expr.loc),
      );
      return Types.Unknown;
    }

    const memberName = memberExpr.property.name;

    if (classType.fields.has(memberName)) {
      const fieldType = classType.fields.get(memberName)!;
      // Annotate the member expression with its read type for compound assignment codegen
      memberExpr.inferredType = fieldType;
      const valueType = checkExpression(ctx, expr.value);
      const effectiveType = expr.operator
        ? checkCompoundOperator(ctx, expr, fieldType, valueType)
        : valueType;

      if (
        classType.kind === TypeKind.Class &&
        !(classType as ClassType).fieldMutability?.get(memberName)
      ) {
        // Accessor-backed fields with a setter are writable even without 'var'
        const setterName = getSetterName(memberName);
        if (!classType.methods.has(setterName)) {
          ctx.diagnostics.reportError(
            `Cannot assign to immutable field '${memberName}'.`,
            DiagnosticCode.InvalidAssignment,
            ctx.getLocation(expr.loc),
          );
        }
      }

      if (!isAssignableTo(ctx, effectiveType, fieldType)) {
        ctx.diagnostics.reportError(
          `Type mismatch in assignment: expected ${typeToString(fieldType)}, got ${typeToString(effectiveType)}`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
      }

      // Determine if this is static field access:
      // - Object is an Identifier that resolves to a class binding (e.g., ClassName.field)
      const isStaticAccess =
        memberExpr.object.type === NodeType.Identifier &&
        ctx.semanticContext.getResolvedBinding(memberExpr.object)?.kind ===
          'class';

      // Record setter binding for DCE tracking - public fields have implicit setters
      // that codegen uses for virtual dispatch
      const setterName = getSetterName(memberName);
      const isFinalClass =
        classType.kind === TypeKind.Class &&
        (classType as ClassType).isFinal === true;
      ctx.semanticContext.setResolvedBinding(memberExpr, {
        kind: 'setter',
        classType: classType as ClassType | InterfaceType,
        methodName: setterName,
        isStaticDispatch: isFinalClass,
        isStatic: isStaticAccess,
      });

      return effectiveType;
    }

    // Check setters
    const setterName2 = getSetterName(memberName);
    if (classType.methods.has(setterName2)) {
      const setter = classType.methods.get(setterName2)!;
      // Annotate with the property type for compound assignment codegen
      memberExpr.inferredType = setter.parameters[0];
      const valueType = checkExpression(ctx, expr.value);

      // Determine if this is static setter access:
      // - Object is an Identifier that resolves to a class binding (e.g., ClassName.field)
      const isStaticAccess =
        memberExpr.object.type === NodeType.Identifier &&
        ctx.semanticContext.getResolvedBinding(memberExpr.object)?.kind ===
          'class';

      // Record binding for DCE tracking
      // Setters use dynamic dispatch unless the class is final
      const isFinalClass =
        classType.kind === TypeKind.Class &&
        (classType as ClassType).isFinal === true;
      ctx.semanticContext.setResolvedBinding(memberExpr, {
        kind: 'setter',
        classType: classType as ClassType | InterfaceType,
        methodName: setterName2,
        isStaticDispatch: isFinalClass,
        isStatic: isStaticAccess,
      });

      // Setter param type
      const paramType = setter.parameters[0];
      const effectiveType2 = expr.operator
        ? checkCompoundOperator(ctx, expr, paramType, valueType)
        : valueType;
      if (!isAssignableTo(ctx, effectiveType2, paramType)) {
        ctx.diagnostics.reportError(
          `Type mismatch in assignment: expected ${typeToString(paramType)}, got ${typeToString(effectiveType2)}`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
      }
      return effectiveType2;
    }

    // Check if it is a read-only property (getter only)
    const getterName = getGetterName(memberName);
    if (classType.methods.has(getterName)) {
      ctx.diagnostics.reportError(
        `Cannot assign to read-only property '${memberName}'.`,
        DiagnosticCode.InvalidAssignment,
        ctx.getLocation(expr.loc),
      );
      return Types.Unknown;
    }

    ctx.diagnostics.reportError(
      `Field '${memberName}' does not exist on type '${classType.name}'.`,
      DiagnosticCode.PropertyNotFound,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
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
        // Resolve the method type with generic substitution for the class's type arguments
        const resolvedSetter = resolveMemberType(
          classType,
          setter,
          ctx,
        ) as FunctionType;
        const indexType = checkExpression(ctx, indexExpr.index);

        if (resolvedSetter.parameters.length !== 2) {
          ctx.diagnostics.reportError(
            `Operator []= must take exactly two arguments (index and value).`,
            DiagnosticCode.ArgumentCountMismatch,
            ctx.getLocation(expr.loc),
          );
        } else {
          if (!isAssignableTo(ctx, indexType, resolvedSetter.parameters[0])) {
            ctx.diagnostics.reportError(
              `Type mismatch in index: expected ${typeToString(resolvedSetter.parameters[0])}, got ${typeToString(indexType)}`,
              DiagnosticCode.TypeMismatch,
              ctx.getLocation(expr.loc),
            );
          }

          const valueType = checkExpression(ctx, expr.value);
          const effectiveType = expr.operator
            ? checkCompoundOperator(
                ctx,
                expr,
                resolvedSetter.parameters[1],
                valueType,
              )
            : valueType;
          if (
            !isAssignableTo(ctx, effectiveType, resolvedSetter.parameters[1])
          ) {
            ctx.diagnostics.reportError(
              `Type mismatch in assignment: expected ${typeToString(resolvedSetter.parameters[1])}, got ${typeToString(effectiveType)}`,
              DiagnosticCode.TypeMismatch,
              ctx.getLocation(expr.loc),
            );
          }

          // Annotate the index expression with the value type (result of the assignment expression)
          indexExpr.inferredType = effectiveType;
          return effectiveType;
        }
        return Types.Unknown;
      }

      // Check if it is a read-only indexer (getter only)
      const getter = classType.methods.get('[]');
      if (getter) {
        ctx.diagnostics.reportError(
          `Cannot assign to read-only indexer.`,
          DiagnosticCode.InvalidAssignment,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }
    }

    // Check the index expression (this will annotate the object and index)
    const elementType = checkIndexExpression(ctx, indexExpr);
    // Set inferredType for compound assignment codegen (the synthetic BinaryExpression
    // reads the left-hand side, which needs inferredType)
    indexExpr.inferredType = elementType;

    // Check if value is assignable to element type
    const valueType = checkExpression(ctx, expr.value);
    const effectiveType = expr.operator
      ? checkCompoundOperator(ctx, expr, elementType, valueType)
      : valueType;
    if (!isAssignableTo(ctx, effectiveType, elementType)) {
      ctx.diagnostics.reportError(
        `Type mismatch in assignment: expected ${typeToString(elementType)}, got ${typeToString(effectiveType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }

    return effectiveType;
  }
  return Types.Unknown;
}

/**
 * Checks a binary expression (e.g., a + b, a == b).
 * Handles arithmetic type promotion (i32 -> f32 -> f64) and operator overloading.
 *
 * Implements bidirectional contextual typing for numeric literals:
 * - If left is a literal and right is numeric: left gets right's type as context
 * - If right is a literal and left is numeric: right gets left's type as context
 */
function checkBinaryExpression(
  ctx: CheckerContext,
  expr: BinaryExpression,
): Type {
  let left: Type;
  let right: Type;

  const leftIsLiteral = expr.left.type === NodeType.NumberLiteral;
  const rightIsLiteral = expr.right.type === NodeType.NumberLiteral;

  // Special handling for && operator: apply narrowing from left to right
  if (expr.operator === '&&') {
    left = checkExpression(ctx, expr.left);
    // Extract all narrowings from left operand (handles chained && expressions)
    const narrowings = extractAllNarrowingsFromCondition(ctx, expr.left);
    if (narrowings.length > 0) {
      // Enter a temporary scope to apply all narrowings for the right operand only
      ctx.enterScope();
      for (const narrowing of narrowings) {
        ctx.narrowType(narrowing.variableName, narrowing.narrowedType);
      }
      right = checkExpression(ctx, expr.right);
      ctx.exitScope();
    } else {
      right = checkExpression(ctx, expr.right);
    }
  } else if (expr.operator === '||') {
    // Special handling for || operator: apply INVERSE narrowing from left to right
    // For `x == null || x.foo`, if the right side runs, we know x == null was false
    left = checkExpression(ctx, expr.left);
    const narrowings = extractAllInverseNarrowingsFromCondition(ctx, expr.left);
    if (narrowings.length > 0) {
      ctx.enterScope();
      for (const narrowing of narrowings) {
        ctx.narrowType(narrowing.variableName, narrowing.narrowedType);
      }
      right = checkExpression(ctx, expr.right);
      ctx.exitScope();
    } else {
      right = checkExpression(ctx, expr.right);
    }
  } else if (expr.operator === '??') {
    // Nullish coalescing operator: lhs ?? rhs
    // If lhs is null, returns rhs; otherwise returns lhs
    left = checkExpression(ctx, expr.left);
    right = checkExpression(ctx, expr.right);

    if (!isNullableType(left)) {
      // Left is not nullable, ?? is a no-op, result is left type
      // This could be a warning in the future
      return left;
    }

    // Result is non-null left type | right type
    const nonNullLeft = getNonNullableType(left, ctx);
    if (isAssignableTo(ctx, right, nonNullLeft)) {
      // Right is subtype of non-null left, result is non-null left
      return nonNullLeft;
    } else if (isAssignableTo(ctx, nonNullLeft, right)) {
      // Non-null left is subtype of right, result is right
      return right;
    } else {
      // Create union of non-null left and right
      return {
        kind: TypeKind.Union,
        types: [nonNullLeft, right],
      } as UnionType;
    }
  } else if (leftIsLiteral && !rightIsLiteral) {
    // Check right first to get context for left (e.g., `0 < x` where x is i64)
    right = checkExpression(ctx, expr.right);
    const contextualType = right.kind === TypeKind.Number ? right : undefined;
    left = checkExpression(ctx, expr.left, contextualType);
  } else {
    // Normal order: check left first, use as context for right
    left = checkExpression(ctx, expr.left);
    const contextualType = left.kind === TypeKind.Number ? left : undefined;
    right = checkExpression(ctx, expr.right, contextualType);
  }

  if (left.kind === TypeKind.Never || right.kind === TypeKind.Never) {
    return Types.Never;
  }

  // Check for operator overloading on class types (e.g., operator +, operator ==)
  if (
    (expr.operator === '+' || expr.operator === '==') &&
    left.kind === TypeKind.Class
  ) {
    const classType = left as ClassType;
    const method = classType.methods.get(expr.operator);
    if (method) {
      // Resolve the method type with generic substitution for the class's type arguments
      const resolvedMethod = resolveMemberType(
        classType,
        method,
        ctx,
      ) as FunctionType;

      // Check parameter types
      if (resolvedMethod.parameters.length !== 1) {
        ctx.diagnostics.reportError(
          `Operator ${expr.operator} must take exactly one argument.`,
          DiagnosticCode.ArgumentCountMismatch,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }

      if (!isAssignableTo(ctx, right, resolvedMethod.parameters[0])) {
        ctx.diagnostics.reportError(
          `Type mismatch in operator ${expr.operator}: expected ${typeToString(resolvedMethod.parameters[0])}, got ${typeToString(right)}`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }

      // Store the resolved operator method for codegen
      expr.resolvedOperatorMethod = resolvedMethod;
      return resolvedMethod.returnType;
    }
  }

  let typesMatch = false;
  let resultType = left;

  if (left.kind === TypeKind.Number && right.kind === TypeKind.Number) {
    const leftName = (left as NumberType).name;
    const rightName = (right as NumberType).name;

    const isU32 = (n: string) => n === Types.U32.name;
    const isI64 = (n: string) => n === Types.I64.name;
    const isU64 = (n: string) => n === Types.U64.name;
    const isF32 = (n: string) => n === Types.F32.name;
    const isF64 = (n: string) => n === Types.F64.name;

    let commonType: Type | null = null;

    // Division always produces float
    if (expr.operator === '/') {
      if (
        isF64(leftName) ||
        isF64(rightName) ||
        isI64(leftName) ||
        isI64(rightName) ||
        isU64(leftName) ||
        isU64(rightName)
      ) {
        commonType = Types.F64;
      } else {
        commonType = Types.F32;
      }
      // Result of division is the common float type
      resultType = commonType;
      typesMatch = true;
    } else {
      // Other operators
      if (leftName === rightName) {
        commonType = left;
      } else if (isF64(leftName) || isF64(rightName)) {
        commonType = Types.F64;
      } else if (isF32(leftName) || isF32(rightName)) {
        // If one is f32 and other is i64/u64, promote to f64 to preserve precision
        if (
          isI64(leftName) ||
          isI64(rightName) ||
          isU64(leftName) ||
          isU64(rightName)
        ) {
          commonType = Types.F64;
        } else {
          commonType = Types.F32;
        }
      } else if (isU64(leftName) || isU64(rightName)) {
        commonType = Types.U64;
      } else if (isI64(leftName) || isI64(rightName)) {
        commonType = Types.I64;
      } else {
        // Should be i32 + i32
        if (leftName === Types.I32.name && rightName === Types.I32.name) {
          commonType = Types.I32;
        } else if (isU32(leftName) && isU32(rightName)) {
          commonType = Types.U32;
        }
        // Mixed i32/u32 is not allowed implicitly
      }

      if (commonType) {
        typesMatch = true;
        if (['==', '!=', '<', '<=', '>', '>='].includes(expr.operator)) {
          resultType = Types.Boolean;
        } else {
          resultType = commonType;
        }
      }
    }
  }

  if (!typesMatch) {
    if (expr.operator === '==' || expr.operator === '!=') {
      // Allow comparing boolean literal types with each other
      if (isBooleanType(left) && isBooleanType(right)) {
        typesMatch = true;
      } else {
        typesMatch =
          isAssignableTo(ctx, left, right) || isAssignableTo(ctx, right, left);
      }
      // Allow reference equality between any class/interface types —
      // a single object can implement multiple interfaces, so unrelated
      // interface types may still refer to the same instance.
      if (!typesMatch) {
        const isRefKind = (t: Type) =>
          t.kind === TypeKind.Class || t.kind === TypeKind.Interface;
        if (isRefKind(left) && isRefKind(right)) {
          typesMatch = true;
        }
      }
      resultType = Types.Boolean;
    } else if (expr.operator === '===' || expr.operator === '!==') {
      // Allow comparing boolean literal types with each other
      if (isBooleanType(left) && isBooleanType(right)) {
        typesMatch = true;
      } else {
        typesMatch =
          isAssignableTo(ctx, left, right) || isAssignableTo(ctx, right, left);
      }
      // Allow reference equality between any class/interface types
      if (!typesMatch) {
        const isRefKind = (t: Type) =>
          t.kind === TypeKind.Class || t.kind === TypeKind.Interface;
        if (isRefKind(left) && isRefKind(right)) {
          typesMatch = true;
        }
      }
      resultType = Types.Boolean;
    } else if (expr.operator === '&&' || expr.operator === '||') {
      // Allow boolean literal types in logical operators
      if (isBooleanType(left) && isBooleanType(right)) {
        typesMatch = true;
        resultType = Types.Boolean;
      }
    } else if (left === right) {
      typesMatch = true;
    }
  }

  if (!typesMatch) {
    ctx.diagnostics.reportError(
      `Type mismatch: cannot apply operator '${expr.operator}' to ${typeToString(left)} and ${typeToString(right)}`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  // Helper to check if a type is an integer type (i32, u32, i64, u64)
  const isIntegerType = (type: Type): boolean =>
    type === Types.I32 ||
    type === Types.U32 ||
    type === Types.I64 ||
    type === Types.U64 ||
    (type.kind === TypeKind.Number &&
      [Types.I32.name, Types.U32.name, Types.I64.name, Types.U64.name].includes(
        (type as NumberType).name,
      ));

  switch (expr.operator) {
    case '==':
    case '!=':
    case '===':
    case '!==':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return Types.Boolean;
    case '+':
    case '-':
    case '*':
    case '/':
      return resultType;
    case '%':
    case '&':
    case '|':
    case '^': {
      // Bitwise and modulo operators require integer types
      if (!isIntegerType(left) || !isIntegerType(right)) {
        ctx.diagnostics.reportError(
          `Operator '${expr.operator}' cannot be applied to type '${typeToString(left)}' and '${typeToString(right)}'.`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }
      return resultType;
    }
    case '<<':
    case '>>':
    case '>>>': {
      // Shift operators require integer types
      // The result type is the type of the left operand
      if (!isIntegerType(left) || !isIntegerType(right)) {
        ctx.diagnostics.reportError(
          `Operator '${expr.operator}' cannot be applied to types '${typeToString(left)}' and '${typeToString(right)}'.`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }
      // Return the left operand's type (shift count doesn't affect result type)
      return left;
    }
    case '&&':
    case '||':
      if (!isBooleanType(left) || !isBooleanType(right)) {
        ctx.diagnostics.reportError(
          `Operator '${expr.operator}' requires boolean operands, got ${typeToString(left)} and ${typeToString(right)}.`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }
      return Types.Boolean;
    default:
      return Types.Unknown;
  }
}

function checkFunctionExpression(
  ctx: CheckerContext,
  expr: FunctionExpression,
  contextualType?: Type,
): Type {
  ctx.enterScope();

  // Extract expected parameter types from contextual type (if it's a function type)
  const expectedFuncType =
    contextualType?.kind === TypeKind.Function
      ? (contextualType as FunctionType)
      : undefined;

  const typeParameters: TypeParameterType[] = [];
  if (expr.typeParameters) {
    for (const param of expr.typeParameters) {
      const tp: TypeParameterType = {
        kind: TypeKind.TypeParameter,
        name: param.name,
      };
      typeParameters.push(tp);
      ctx.declare(param.name, tp, 'type');
    }

    // Resolve constraints and defaults
    for (let i = 0; i < expr.typeParameters.length; i++) {
      const param = expr.typeParameters[i];
      if (param.constraint) {
        typeParameters[i].constraint = resolveTypeAnnotation(
          ctx,
          param.constraint,
        );
      }
      if (param.default) {
        typeParameters[i].defaultType = resolveTypeAnnotation(
          ctx,
          param.default,
        );
      }
    }
  }

  const paramTypes: Type[] = [];
  const parameterNames: string[] = [];
  const optionalParameters: boolean[] = [];
  const parameterInitializers: any[] = [];

  for (let i = 0; i < expr.params.length; i++) {
    const param = expr.params[i];

    // Resolve type: use annotation if present, otherwise infer from contextual type
    let type: Type;
    if (param.typeAnnotation) {
      type = resolveTypeAnnotation(ctx, param.typeAnnotation);
      // Inline tuples cannot appear in parameter types
      validateNoInlineTuple(type, ctx, 'parameter types');
    } else if (expectedFuncType && i < expectedFuncType.parameters.length) {
      // Contextual typing: infer parameter type from expected function type
      type = expectedFuncType.parameters[i];
    } else {
      // No annotation and no contextual type - error
      ctx.diagnostics.reportError(
        `Parameter '${param.name.name}' has no type annotation and cannot be inferred from context.`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
      type = Types.Unknown;
    }

    if (param.optional && !param.initializer) {
      if (type.kind === TypeKind.Union) {
        type = {
          kind: TypeKind.Union,
          types: [...(type as UnionType).types, Types.Null],
        } as UnionType;
      } else {
        type = {
          kind: TypeKind.Union,
          types: [type, Types.Null],
        } as UnionType;
      }
      validateType(type, ctx);
    }

    // Store the inferred type on the parameter for codegen
    param.inferredType = type;

    // For destructured parameters, declare pattern bindings instead of synthetic name
    if (param.pattern) {
      checkPattern(ctx, param.pattern, type, 'let');
    } else {
      ctx.declare(param.name.name, type, 'let', param);
    }
    paramTypes.push(type);
    parameterNames.push(param.name.name);
    optionalParameters.push(param.optional);
    parameterInitializers.push(param.initializer);

    if (param.initializer) {
      const initType = checkExpression(ctx, param.initializer);
      if (!isAssignableTo(ctx, initType, type)) {
        ctx.diagnostics.reportError(
          `Type mismatch: default value ${typeToString(initType)} is not assignable to ${typeToString(type)}`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
      }
    }
  }

  // Check return type if annotated
  let expectedReturnType: Type = Types.Unknown;
  if (expr.returnType) {
    expectedReturnType = resolveTypeAnnotation(ctx, expr.returnType);
  }

  const previousReturnType = ctx.currentFunctionReturnType;
  ctx.currentFunctionReturnType = expectedReturnType;

  const previousInferredReturns = ctx.inferredReturnTypes;
  ctx.inferredReturnTypes = [];

  let bodyType: Type = Types.Unknown;
  if (expr.body.type === NodeType.BlockStatement) {
    checkStatement(ctx, expr.body);

    if (expectedReturnType.kind === Types.Unknown.kind) {
      if (ctx.inferredReturnTypes.length === 0) {
        bodyType = Types.Void;
      } else {
        // For now, take the first one. Ideally check LUB.
        bodyType = ctx.inferredReturnTypes[0];
      }
    } else {
      bodyType = expectedReturnType;
    }
  } else {
    bodyType = checkExpression(ctx, expr.body as Expression);

    if (expectedReturnType.kind !== Types.Unknown.kind) {
      if (!isAssignableTo(ctx, bodyType, expectedReturnType)) {
        ctx.diagnostics.reportError(
          `Type mismatch: expected return type ${typeToString(expectedReturnType)}, got ${typeToString(bodyType)}`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
      }
      // Use the declared return type, not the inferred body type.
      // This matches block-body behavior and ensures the FunctionType's
      // returnType reflects the annotation (e.g. Doc, not ArrayDoc).
      bodyType = expectedReturnType;
    }
  }

  ctx.inferredReturnTypes = previousInferredReturns;
  ctx.currentFunctionReturnType = previousReturnType;
  ctx.exitScope();

  return {
    kind: TypeKind.Function,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    parameters: paramTypes,
    parameterNames,
    returnType: bodyType,
    optionalParameters,
    parameterInitializers,
  } as FunctionType;
}

function checkNewExpression(ctx: CheckerContext, expr: NewExpression): Type {
  const className = expr.callee.name;
  const type = ctx.resolveType(className);

  if (!type || type.kind !== TypeKind.Class) {
    ctx.diagnostics.reportError(
      `'${className}' is not a class.`,
      DiagnosticCode.SymbolNotFound,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  let classType = type as ClassType;

  if (classType.isAbstract) {
    ctx.diagnostics.reportError(
      `Cannot instantiate abstract class '${className}'.`,
      DiagnosticCode.CannotInstantiateAbstractClass,
      ctx.getLocation(expr.loc),
    );
  }

  if (expr.typeArguments && expr.typeArguments.length > 0) {
    if (!classType.typeParameters || classType.typeParameters.length === 0) {
      ctx.diagnostics.reportError(
        `Type '${className}' is not generic.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
        ctx.getLocation(expr.loc),
      );
    } else if (classType.typeParameters.length !== expr.typeArguments.length) {
      ctx.diagnostics.reportError(
        `Expected ${classType.typeParameters.length} type arguments, got ${expr.typeArguments.length}.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
        ctx.getLocation(expr.loc),
      );
    } else {
      const typeArguments = expr.typeArguments.map((arg) =>
        resolveTypeAnnotation(ctx, arg),
      );
      // Constraint validation is done inside instantiateGenericClass
      classType = instantiateGenericClass(classType, typeArguments, ctx);
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
      // Constraint validation is done inside instantiateGenericClass
      classType = instantiateGenericClass(classType, inferred, ctx);
      expr.inferredTypeArguments = inferred;
    } else {
      ctx.diagnostics.reportError(
        `Generic type '${className}' requires type arguments.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
        ctx.getLocation(expr.loc),
      );
    }
  }

  const constructor = classType.constructorType;

  if (!constructor) {
    if (expr.arguments.length > 0) {
      ctx.diagnostics.reportError(
        `Class '${className}' has no constructor but arguments were provided.`,
        DiagnosticCode.ArgumentCountMismatch,
        ctx.getLocation(expr.loc),
      );
    }
    return classType;
  }

  // Track original argument count before expanding defaults
  const originalArgCount = expr.arguments.length;

  // Check arguments against constructor parameters
  if (expr.arguments.length !== constructor.parameters.length) {
    const minArity = constructor.optionalParameters
      ? constructor.optionalParameters.filter((o) => !o).length
      : constructor.parameters.length;

    if (
      expr.arguments.length < minArity ||
      expr.arguments.length > constructor.parameters.length
    ) {
      ctx.diagnostics.reportError(
        `Expected ${minArity}-${constructor.parameters.length} arguments, got ${expr.arguments.length}`,
        DiagnosticCode.ArgumentCountMismatch,
        ctx.getLocation(expr.loc),
      );
    } else {
      // Fill in missing arguments with default values
      if (constructor.parameterInitializers) {
        for (
          let i = expr.arguments.length;
          i < constructor.parameters.length;
          i++
        ) {
          const initializer = constructor.parameterInitializers[i];
          if (initializer) {
            expr.arguments.push(initializer);
          } else {
            // Optional but no default? Inject null.
            const nullLiteral: Expression = {
              type: NodeType.NullLiteral,
            };
            expr.arguments.push(nullLiteral);
          }
        }
      } else {
        // No initializers array — inject null for each missing optional param
        for (
          let i = expr.arguments.length;
          i < constructor.parameters.length;
          i++
        ) {
          const nullLiteral: Expression = {
            type: NodeType.NullLiteral,
          };
          expr.arguments.push(nullLiteral);
        }
      }
    }
  }

  // Only check originally-provided arguments, not expanded defaults.
  // Default value expressions were already type-checked when the constructor was defined.
  for (
    let i = 0;
    i < Math.min(originalArgCount, constructor.parameters.length);
    i++
  ) {
    const argType = checkExpression(ctx, expr.arguments[i]);
    const paramType = constructor.parameters[i];

    if (!isAssignableTo(ctx, argType, paramType)) {
      ctx.diagnostics.reportError(
        `Type mismatch in argument ${i + 1}: expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }
  }

  return classType;
}

/**
 * Check symbol member access: obj.:symbol
 * The property name is an identifier that must resolve to a symbol.
 */
function checkSymbolMemberAccess(
  ctx: CheckerContext,
  expr: MemberExpression,
  objectType: Type,
): Type {
  // The symbolPath contains either:
  // - A simple identifier (e.g., :mySymbol)
  // - A MemberExpression (e.g., :Iterable.iterator)
  const symbolPath = expr.symbolPath ?? expr.property;
  let symbolType: SymbolType | undefined;

  if (symbolPath.type === NodeType.Identifier) {
    // Simple symbol: :mySymbol
    const symbolName = symbolPath.name;
    const symbolTypeValue = ctx.resolveValue(symbolName);

    if (!symbolTypeValue || symbolTypeValue.kind !== TypeKind.Symbol) {
      ctx.diagnostics.reportError(
        `'${symbolName}' is not defined or is not a symbol.`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
      return Types.Unknown;
    }
    symbolType = symbolTypeValue as SymbolType;
  } else if (symbolPath.type === NodeType.MemberExpression) {
    // Qualified symbol: :Iterable.iterator
    const memberExpr = symbolPath as MemberExpression;
    if (memberExpr.object.type === NodeType.Identifier) {
      const objectName = (memberExpr.object as Identifier).name;
      const interfaceOrClassType = ctx.resolveType(objectName);

      if (
        interfaceOrClassType &&
        interfaceOrClassType.kind === TypeKind.Interface
      ) {
        const ifaceType = interfaceOrClassType as InterfaceType;
        const propertyName = memberExpr.property.name;

        if (ifaceType.statics && ifaceType.statics.has(propertyName)) {
          const staticType = ifaceType.statics.get(propertyName)!;
          if (staticType.kind === TypeKind.Symbol) {
            symbolType = staticType as SymbolType;
          }
        }
        if (!symbolType) {
          ctx.diagnostics.reportError(
            `Static symbol '${propertyName}' not found in interface '${objectName}'.`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(expr.loc),
          );
          return Types.Unknown;
        }
      } else if (
        interfaceOrClassType &&
        interfaceOrClassType.kind === TypeKind.Class
      ) {
        const classType = interfaceOrClassType as ClassType;
        const propertyName = memberExpr.property.name;

        if (classType.statics && classType.statics.has(propertyName)) {
          const staticType = classType.statics.get(propertyName)!;
          if (staticType.kind === TypeKind.Symbol) {
            symbolType = staticType as SymbolType;
          }
        }
        if (!symbolType) {
          ctx.diagnostics.reportError(
            `Static symbol '${propertyName}' not found in class '${objectName}'.`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(expr.loc),
          );
          return Types.Unknown;
        }
      } else {
        ctx.diagnostics.reportError(
          `'${objectName}' is not an interface or class.`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
        return Types.Unknown;
      }
    } else {
      ctx.diagnostics.reportError(
        `Invalid symbol path.`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
      return Types.Unknown;
    }
  } else {
    ctx.diagnostics.reportError(
      `Invalid symbol expression.`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  expr.resolvedSymbol = symbolType;

  // Determine the class/interface to check for symbol members
  let classType: ClassType | InterfaceType | undefined;

  if (
    objectType.kind === TypeKind.Class ||
    objectType.kind === TypeKind.Interface
  ) {
    classType = objectType as ClassType | InterfaceType;
  } else if (objectType.kind === TypeKind.Array) {
    // For arrays, look up extension methods from FixedArray
    const genericArrayType = ctx.getWellKnownType(TypeNames.FixedArray);
    if (genericArrayType && genericArrayType.kind === TypeKind.Class) {
      const genericClassType = genericArrayType as ClassType;
      const elementType = (objectType as ArrayType).elementType;

      // Instantiate FixedArray<T> with the actual element type
      if (
        genericClassType.typeParameters &&
        genericClassType.typeParameters.length > 0
      ) {
        classType = instantiateGenericClass(
          genericClassType,
          [elementType],
          ctx,
        );
      } else {
        classType = genericClassType;
      }
    }
  }

  if (!classType) {
    ctx.diagnostics.reportError(
      `Symbol member access is only supported on classes, interfaces, and arrays.`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  // Check symbolFields first
  if (classType.symbolFields?.has(symbolType)) {
    const fieldType = classType.symbolFields.get(symbolType)!;
    return resolveMemberType(classType, fieldType, ctx);
  }

  // Check symbolMethods
  if (classType.symbolMethods?.has(symbolType)) {
    const methodType = classType.symbolMethods.get(symbolType)!;
    // Store method binding for symbol method access
    const isExtension =
      classType.kind === TypeKind.Class &&
      !!(classType as ClassType).isExtension;
    const binding: MethodBinding = {
      kind: 'method',
      classType: classType as ClassType,
      methodName: symbolType.debugName ?? '<symbol>',
      isStaticDispatch: isExtension,
      type: methodType,
      isSymbol: true,
      symbolType,
    };
    ctx.semanticContext.setResolvedBinding(expr, binding);
    return resolveMemberType(classType, methodType, ctx);
  }

  ctx.diagnostics.reportError(
    `Symbol '${symbolType.debugName ?? '<symbol>'}' does not exist on type '${classType.name}'.`,
    DiagnosticCode.PropertyNotFound,
    ctx.getLocation(expr.loc),
  );
  return Types.Unknown;
}

function checkMemberExpression(
  ctx: CheckerContext,
  expr: MemberExpression,
): Type {
  let objectType = checkExpression(ctx, expr.object);

  // Handle optional chaining: obj?.property
  // If the object is nullable, we extract the non-null type for property lookup
  // and make the result nullable. If non-nullable, optional chaining is a no-op.
  let shouldMakeNullable = false;
  if (expr.optional && isNullableType(objectType)) {
    shouldMakeNullable = true;
    objectType = getNonNullableType(objectType, ctx);
  }

  // Helper to wrap result in nullable if needed
  const wrapResult = (type: Type): Type => {
    if (shouldMakeNullable && type.kind !== TypeKind.Unknown) {
      return makeNullable(type, ctx);
    }
    return type;
  };

  // Handle symbol member access: obj.:symbol
  if (expr.isSymbolAccess) {
    return wrapResult(checkSymbolMemberAccess(ctx, expr, objectType));
  }

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
          ctx.getLocation(expr.loc),
        );
      }
    }
  }

  if (objectType.kind === TypeKind.Array) {
    // Check for extension methods
    // TODO: Support multiple extensions or lookup by type, not just name 'Array'
    const genericArrayType = ctx.getWellKnownType(TypeNames.FixedArray);
    if (genericArrayType && genericArrayType.kind === TypeKind.Class) {
      const genericClassType = genericArrayType as ClassType;
      const elementType = (objectType as ArrayType).elementType;

      // Instantiate FixedArray<T> with the actual element type to get FixedArray<ElementType>.
      // This ensures the binding's classType is the concrete instantiation, not the generic.
      // Codegen uses the instantiated classType for O(1) identity-based lookup.
      let instantiatedClassType = genericClassType;
      if (
        genericClassType.typeParameters &&
        genericClassType.typeParameters.length > 0
      ) {
        instantiatedClassType = instantiateGenericClass(
          genericClassType,
          [elementType],
          ctx,
        );
      }

      if (genericClassType.methods.has(expr.property.name)) {
        // Get the resolved method from the instantiated class
        const resolvedMethod = instantiatedClassType.methods.get(
          expr.property.name,
        )!;

        // Store method binding for array extension methods with instantiated classType
        const binding: MethodBinding = {
          kind: 'method',
          classType: instantiatedClassType,
          methodName: expr.property.name,
          isStaticDispatch: true, // Extension classes always use static dispatch
          type: resolvedMethod,
        };
        ctx.semanticContext.setResolvedBinding(expr, binding);

        return wrapResult(resolvedMethod);
      }

      // Also check for fields (e.g., FixedArray.length)
      if (genericClassType.fields.has(expr.property.name)) {
        // Get the resolved field type from the instantiated class
        const resolvedType = instantiatedClassType.fields.get(
          expr.property.name,
        )!;

        // Store field binding for array extension fields with instantiated classType
        const binding: FieldBinding = {
          kind: 'field',
          classType: instantiatedClassType,
          fieldName: expr.property.name,
          type: resolvedType,
        };
        ctx.semanticContext.setResolvedBinding(expr, binding);

        return wrapResult(resolvedType);
      }
    }

    if (expr.property.name === LENGTH_PROPERTY) {
      // Fallback for intrinsic array.length (should have been caught above)
      return wrapResult(Types.I32);
    }
  }

  if (objectType.kind === TypeKind.Record) {
    const recordType = objectType as RecordType;
    const memberName = expr.property.name;
    if (recordType.properties.has(memberName)) {
      const fieldType = recordType.properties.get(memberName)!;

      // Check for narrowed type based on the full path (e.g., "r.field")
      const path = getExpressionPath(expr, ctx);
      const narrowedType = path ? ctx.getNarrowedType(path) : undefined;
      const finalType = narrowedType ?? fieldType;

      // Store record field binding
      const binding: RecordFieldBinding = {
        kind: 'record-field',
        recordType,
        fieldName: memberName,
        type: finalType,
      };
      ctx.semanticContext.setResolvedBinding(expr, binding);

      return wrapResult(finalType);
    }
    ctx.diagnostics.reportError(
      `Property '${memberName}' does not exist on type '${typeToString(objectType)}'.`,
      DiagnosticCode.PropertyNotFound,
      ctx.getLocation(expr.property.loc),
    );
    return Types.Unknown;
  }

  if (
    objectType.kind !== TypeKind.Class &&
    objectType.kind !== TypeKind.Interface
  ) {
    if (objectType.kind !== Types.Unknown.kind) {
      ctx.diagnostics.reportError(
        `Property access not supported on type '${typeToString(objectType)}'.`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }
    return Types.Unknown;
  }

  const classType = objectType as ClassType | InterfaceType;
  const memberName = expr.property.name;

  // Determine if we can use static dispatch
  const canUseStaticDispatch = (ct: ClassType | InterfaceType): boolean => {
    if (ct.kind === TypeKind.Interface) return false;
    const cls = ct as ClassType;
    return cls.isFinal === true || cls.isExtension === true;
  };

  if (memberName.startsWith('#')) {
    if (!ctx.currentClass) {
      ctx.diagnostics.reportError(
        `Private field '${memberName}' can only be accessed within a class.`,
        DiagnosticCode.UnknownError,
        ctx.getLocation(expr.property.loc),
      );
      return Types.Unknown;
    }

    if (
      !ctx.currentClass.fields.has(memberName) &&
      !ctx.currentClass.methods.has(memberName)
    ) {
      ctx.diagnostics.reportError(
        `Private member '${memberName}' is not defined in class '${ctx.currentClass.name}'.`,
        DiagnosticCode.PropertyNotFound,
        ctx.getLocation(expr.property.loc),
      );
      return Types.Unknown;
    }

    if (!isAssignableTo(ctx, objectType, ctx.currentClass)) {
      ctx.diagnostics.reportError(
        `Type '${typeToString(objectType)}' does not have private member '${memberName}' from class '${ctx.currentClass.name}'.`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.property.loc),
      );
      return Types.Unknown;
    }

    // Determine if this is static field access:
    // - Object is an Identifier that resolves to a class binding (e.g., ClassName.#field)
    // vs instance access:
    // - Object is ThisExpression (e.g., this.#field)
    const isStaticAccess =
      expr.object.type === NodeType.Identifier &&
      ctx.semanticContext.getResolvedBinding(expr.object)?.kind === 'class';

    if (ctx.currentClass.fields.has(memberName)) {
      const fieldType = ctx.currentClass.fields.get(memberName)!;

      // Store private field binding (use mangled name for codegen)
      const binding: FieldBinding = {
        kind: 'field',
        classType: ctx.currentClass,
        fieldName: `${ctx.currentClass.name}::${memberName}`,
        type: fieldType,
        isStatic: isStaticAccess,
      };
      ctx.semanticContext.setResolvedBinding(expr, binding);

      return wrapResult(fieldType);
    }

    const methodType = ctx.currentClass.methods.get(memberName)!;

    // Store private method binding
    const binding: MethodBinding = {
      kind: 'method',
      classType: ctx.currentClass,
      methodName: memberName,
      isStaticDispatch: true, // Private methods are always static dispatch
      type: methodType,
    };
    ctx.semanticContext.setResolvedBinding(expr, binding);

    return wrapResult(methodType);
  }

  // Check fields
  if (classType.fields.has(memberName)) {
    const fieldType = classType.fields.get(memberName)!;
    const resolvedType = resolveMemberType(classType, fieldType, ctx);

    // Check for narrowed type based on the full path (e.g., "obj.field")
    const path = getExpressionPath(expr, ctx);
    const narrowedType = path ? ctx.getNarrowedType(path) : undefined;
    const finalType = narrowedType ?? resolvedType;

    // Determine if this is static field access:
    // - Object is an Identifier that resolves to a class binding (e.g., ClassName.field)
    // vs instance access:
    // - Object is ThisExpression or other expression (e.g., this.field, instance.field)
    const isStaticAccess =
      expr.object.type === NodeType.Identifier &&
      ctx.semanticContext.getResolvedBinding(expr.object)?.kind === 'class';

    // Store field binding
    const binding: FieldBinding = {
      kind: 'field',
      classType,
      fieldName: memberName,
      type: finalType,
      isStatic: isStaticAccess,
    };
    ctx.semanticContext.setResolvedBinding(expr, binding);

    return wrapResult(finalType);
  }

  // Check methods
  if (classType.methods.has(memberName)) {
    const methodType = classType.methods.get(memberName)!;
    const resolvedType = resolveMemberType(
      classType,
      methodType,
      ctx,
    ) as FunctionType;

    // Store method binding
    // Static dispatch is possible if: class is final/extension, or method is final
    const binding: MethodBinding = {
      kind: 'method',
      classType,
      methodName: memberName,
      isStaticDispatch:
        canUseStaticDispatch(classType) || methodType.isFinal === true,
      type: resolvedType,
    };
    ctx.semanticContext.setResolvedBinding(expr, binding);

    return wrapResult(resolvedType);
  }

  // Check getters
  const getterName = getGetterName(memberName);
  if (classType.methods.has(getterName)) {
    const getterType = classType.methods.get(getterName)!;
    const resolvedGetter = resolveMemberType(
      classType,
      getterType,
      ctx,
    ) as FunctionType;

    // Determine if this is static getter access:
    // - Object is an Identifier that resolves to a class binding (e.g., ClassName.field)
    const isStaticAccess =
      expr.object.type === NodeType.Identifier &&
      ctx.semanticContext.getResolvedBinding(expr.object)?.kind === 'class';

    // Store getter binding
    // Static dispatch is possible if: class is final/extension, or getter is final
    const binding: GetterBinding = {
      kind: 'getter',
      classType,
      methodName: getterName,
      isStaticDispatch:
        canUseStaticDispatch(classType) || getterType.isFinal === true,
      type: resolvedGetter.returnType,
      isStatic: isStaticAccess,
    };
    ctx.semanticContext.setResolvedBinding(expr, binding);

    return wrapResult(resolvedGetter.returnType);
  }

  ctx.diagnostics.reportError(
    `Property '${memberName}' does not exist on type '${classType.name}'.`,
    DiagnosticCode.PropertyNotFound,
    ctx.getLocation(expr.property.loc),
  );
  return Types.Unknown;
}

function checkThisExpression(ctx: CheckerContext, expr: ThisExpression): Type {
  if (!ctx.currentClass) {
    ctx.diagnostics.reportError(
      `'this' can only be used inside a class.`,
      DiagnosticCode.UnknownError,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }
  if (!ctx.isThisInitialized) {
    ctx.diagnostics.reportError(
      `'this' cannot be accessed before 'super()' call in a derived class constructor.`,
      DiagnosticCode.UnknownError,
      ctx.getLocation(expr.loc),
    );
  }
  if (ctx.currentClass.isExtension && ctx.currentClass.onType) {
    return ctx.currentClass.onType;
  }

  // ctx.currentClass already has typeArguments = typeParameters for generic classes
  // (set by enterClass), so we can just return it directly.
  return ctx.currentClass;
}

function checkArrayLiteral(ctx: CheckerContext, expr: ArrayLiteral): Type {
  let elementType: Type;
  if (expr.elements.length === 0) {
    elementType = Types.Unknown;
  } else {
    const elementTypes = expr.elements.map((e) => checkExpression(ctx, e));
    // Check if all element types are compatible.
    // For simplicity, take the first type and check if others are assignable to it.
    // A better approach would be finding the common supertype.
    elementType = elementTypes[0];
    for (let i = 1; i < elementTypes.length; i++) {
      if (!isAssignableTo(ctx, elementTypes[i], elementType)) {
        ctx.diagnostics.reportError(
          `Array element type mismatch. Expected '${typeToString(elementType)}', got '${typeToString(elementTypes[i])}'.`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
      }
    }
  }

  // Array literals are typed as FixedArray<T> (not raw array<T>).
  // This enables normal Class→Interface assignability for Sequence, Iterable, etc.
  const genericFixedArray = ctx.getWellKnownType(TypeNames.FixedArray);
  if (genericFixedArray && genericFixedArray.kind === TypeKind.Class) {
    const genericClass = genericFixedArray as ClassType;
    if (genericClass.typeParameters && genericClass.typeParameters.length > 0) {
      return instantiateGenericClass(genericClass, [elementType], ctx);
    }
  }

  // Fallback for contexts without stdlib (e.g., minimal tests)
  return ctx.getOrCreateArrayType(elementType);
}

function checkRecordLiteral(ctx: CheckerContext, expr: RecordLiteral): Type {
  const properties = new Map<string, Type>();
  const optionalProperties = new Set<string>();
  // Track which properties have been seen as required (either from explicit
  // assignment or from spreading a record where the property is required)
  const requiredProperties = new Set<string>();

  for (const prop of expr.properties) {
    if (prop.type === NodeType.SpreadElement) {
      const spreadType = checkExpression(ctx, prop.argument);
      if (
        spreadType.kind !== TypeKind.Record &&
        spreadType.kind !== TypeKind.Class
      ) {
        ctx.diagnostics.reportError(
          `Spread argument must be a record or class, got ${typeToString(
            spreadType,
          )}`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(expr.loc),
        );
        continue;
      }
      if (spreadType.kind === TypeKind.Record) {
        const recordType = spreadType as RecordType;
        for (const [key, type] of recordType.properties) {
          properties.set(key, type);
          // Determine if this property is optional in the spread source
          const isOptionalInSource = recordType.optionalProperties?.has(key);
          if (isOptionalInSource) {
            // Only mark as optional if it hasn't been seen as required before
            if (!requiredProperties.has(key)) {
              optionalProperties.add(key);
            }
          } else {
            // Required in source - mark as required and remove from optional
            requiredProperties.add(key);
            optionalProperties.delete(key);
          }
        }
      } else {
        // Class - fields are always required
        for (const [key, type] of (spreadType as ClassType).fields) {
          if (!key.startsWith('#')) {
            properties.set(key, type);
            requiredProperties.add(key);
            optionalProperties.delete(key);
          }
        }
      }
    } else {
      const type = checkExpression(ctx, prop.value);
      properties.set(prop.name.name, type);
      // Explicitly setting a property makes it required (not optional)
      requiredProperties.add(prop.name.name);
      optionalProperties.delete(prop.name.name);
    }
  }
  return ctx.getOrCreateRecordType(
    properties,
    optionalProperties.size > 0 ? optionalProperties : undefined,
  );
}

/**
 * Type-checks a map literal: {key1 => value1, key2 => value2, ...}
 * Returns Map<K, V> where K and V are inferred from the entries.
 */
function checkMapLiteral(ctx: CheckerContext, expr: MapLiteral): Type {
  // Get the generic Map class from the stdlib
  const genericMapType = ctx.getWellKnownType(TypeNames.HashMap);
  if (!genericMapType || genericMapType.kind !== TypeKind.Class) {
    ctx.diagnostics.reportError(
      "HashMap type not found. Import from 'zena:map'.",
      DiagnosticCode.TypeNotFound,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  const mapClassType = genericMapType as ClassType;

  // Empty map literal - error, require explicit type annotation
  if (expr.entries.length === 0) {
    ctx.diagnostics.reportError(
      'Empty map literal requires type annotation. Use `new HashMap<K, V>()` instead.',
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  // Type-check all entries and collect key/value types
  const keyTypes: Type[] = [];
  const valueTypes: Type[] = [];

  for (const entry of expr.entries) {
    const keyType = checkExpression(ctx, entry.key);
    const valueType = checkExpression(ctx, entry.value);
    keyTypes.push(keyType);
    valueTypes.push(valueType);
  }

  // Unify key types - all keys must have the same type
  const firstKeyType = keyTypes[0];
  for (let i = 1; i < keyTypes.length; i++) {
    if (!isAssignableTo(ctx, keyTypes[i], firstKeyType)) {
      ctx.diagnostics.reportError(
        `Map key type mismatch: expected '${typeToString(firstKeyType)}', got '${typeToString(keyTypes[i])}'.`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }
  }

  // Unify value types - all values must have the same type
  const firstValueType = valueTypes[0];
  for (let i = 1; i < valueTypes.length; i++) {
    if (!isAssignableTo(ctx, valueTypes[i], firstValueType)) {
      ctx.diagnostics.reportError(
        `Map value type mismatch: expected '${typeToString(firstValueType)}', got '${typeToString(valueTypes[i])}'.`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }
  }

  // Instantiate Map<K, V> with the inferred types
  const instantiatedType = instantiateGenericClass(
    mapClassType,
    [firstKeyType, firstValueType],
    ctx,
  );

  // Store the inferred type on the expression for codegen
  expr.inferredType = instantiatedType;

  return instantiatedType;
}

function checkTupleLiteral(ctx: CheckerContext, expr: TupleLiteral): Type {
  const elementTypes = expr.elements.map((e) => checkExpression(ctx, e));

  // If we're in an inline return context, produce InlineTupleType so codegen
  // generates flat multi-value instead of a heap-allocated struct.
  const returnType = ctx.currentFunctionReturnType;
  if (returnType && returnType.kind === TypeKind.InlineTuple) {
    const resultType: InlineTupleType = {
      kind: TypeKind.InlineTuple,
      elementTypes,
    };
    expr.inferredType = resultType;
    return resultType;
  }
  // Also handle union-of-inline-tuples return type (e.g. (true, T) | (false, never))
  if (
    returnType &&
    returnType.kind === TypeKind.Union &&
    (returnType as UnionType).types.every(
      (t) => t.kind === TypeKind.InlineTuple,
    )
  ) {
    const resultType: InlineTupleType = {
      kind: TypeKind.InlineTuple,
      elementTypes,
    };
    expr.inferredType = resultType;
    return resultType;
  }

  return {
    kind: TypeKind.Tuple,
    elementTypes,
  } as TupleType;
}

/**
 * Check an inline tuple literal expression like ((1, 2)).
 * This is only valid in return position (expression body or return statement).
 * Returns an InlineTupleType.
 * @deprecated - TupleLiteral now handles both boxed and inline tuples.
 * Kept for backwards compatibility with any remaining InlineTupleLiteral AST nodes.
 */
function checkInlineTupleLiteral(
  ctx: CheckerContext,
  expr: InlineTupleLiteral,
): Type {
  const elementTypes = expr.elements.map((e) => checkExpression(ctx, e));
  const resultType: InlineTupleType = {
    kind: TypeKind.InlineTuple,
    elementTypes,
  };
  expr.inferredType = resultType;
  return resultType;
}

function checkIndexExpression(
  ctx: CheckerContext,
  expr: IndexExpression,
): Type {
  let objectType = checkExpression(ctx, expr.object);
  const indexType = checkExpression(ctx, expr.index);

  // Handle optional chaining: obj?[index]
  // If the object is nullable, we extract the non-null type for indexing
  // and make the result nullable. If non-nullable, optional chaining is a no-op.
  let shouldMakeNullable = false;
  if (expr.optional && isNullableType(objectType)) {
    shouldMakeNullable = true;
    objectType = getNonNullableType(objectType, ctx);
  }

  // Helper to wrap result in nullable if needed
  const wrapResult = (type: Type): Type => {
    if (shouldMakeNullable && type.kind !== TypeKind.Unknown) {
      return makeNullable(type, ctx);
    }
    return type;
  };

  if (
    objectType.kind === TypeKind.Class ||
    objectType.kind === TypeKind.Interface
  ) {
    const classType = objectType as ClassType | InterfaceType;
    const method = classType.methods.get('[]');
    if (method) {
      // Resolve the method type with generic substitution for the class's type arguments
      const resolvedMethod = resolveMemberType(
        classType,
        method,
        ctx,
      ) as FunctionType;

      // Handle overloaded operator[]
      let selectedOverload = resolvedMethod;
      if (resolvedMethod.overloads && resolvedMethod.overloads.length > 0) {
        const candidates = [resolvedMethod, ...resolvedMethod.overloads];
        let bestMatch: FunctionType | undefined;

        for (const candidate of candidates) {
          const resolvedCandidate = resolveMemberType(
            classType,
            candidate,
            ctx,
          ) as FunctionType;
          if (resolvedCandidate.parameters.length === 1) {
            if (
              isAssignableTo(ctx, indexType, resolvedCandidate.parameters[0])
            ) {
              bestMatch = resolvedCandidate;
              break;
            }
          }
        }

        if (bestMatch) {
          selectedOverload = bestMatch;
        }
      }

      if (selectedOverload.parameters.length !== 1) {
        ctx.diagnostics.reportError(
          `Operator [] must take exactly one argument.`,
          DiagnosticCode.ArgumentCountMismatch,
          ctx.getLocation(expr.loc),
        );
      } else {
        if (!isAssignableTo(ctx, indexType, selectedOverload.parameters[0])) {
          ctx.diagnostics.reportError(
            `Type mismatch in index: expected ${typeToString(selectedOverload.parameters[0])}, got ${typeToString(indexType)}`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(expr.loc),
          );
        }
      }
      // Store the resolved operator method for codegen
      expr.resolvedOperatorMethod = selectedOverload;
      return wrapResult(selectedOverload.returnType);
    }
  }

  if (objectType.kind === TypeKind.Tuple) {
    const tupleType = objectType as TupleType;
    const index = getCompileTimeNumericValue(ctx, expr.index);
    if (index === null) {
      ctx.diagnostics.reportError(
        `Tuple index must be a compile-time known value.`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
      return Types.Unknown;
    }
    if (index < 0 || index >= tupleType.elementTypes.length) {
      ctx.diagnostics.reportError(
        `Tuple index out of bounds: ${index}`,
        DiagnosticCode.IndexOutOfBounds,
        ctx.getLocation(expr.loc),
      );
      return Types.Unknown;
    }
    const elementType = tupleType.elementTypes[index];

    // Check for narrowed type based on the full path (e.g., "t[0]")
    const path = getExpressionPath(expr, ctx);
    const narrowedType = path ? ctx.getNarrowedType(path) : undefined;
    return wrapResult(narrowedType ?? elementType);
  }

  // Check for extension class operator[] on Array types (e.g., FixedArray<T>.operator[](Range))
  if (objectType.kind === TypeKind.Array) {
    const genericArrayType = ctx.getWellKnownType(TypeNames.FixedArray);
    if (genericArrayType && genericArrayType.kind === TypeKind.Class) {
      const genericClassType = genericArrayType as ClassType;
      const elementType = (objectType as ArrayType).elementType;

      // Instantiate FixedArray<T> with the actual element type
      let instantiatedClassType = genericClassType;
      if (
        genericClassType.typeParameters &&
        genericClassType.typeParameters.length > 0
      ) {
        instantiatedClassType = instantiateGenericClass(
          genericClassType,
          [elementType],
          ctx,
        );
      }

      // Look for operator[] with matching parameter type
      const method = genericClassType.methods.get('[]');
      if (method) {
        const resolvedMethod = resolveMemberType(
          instantiatedClassType,
          method,
          ctx,
        ) as FunctionType;

        // Handle overloaded operator[]
        const candidates = resolvedMethod.overloads
          ? [resolvedMethod, ...resolvedMethod.overloads]
          : [resolvedMethod];

        for (const candidate of candidates) {
          const resolvedCandidate = resolveMemberType(
            instantiatedClassType,
            candidate,
            ctx,
          ) as FunctionType;
          if (
            resolvedCandidate.parameters.length === 1 &&
            isAssignableTo(ctx, indexType, resolvedCandidate.parameters[0])
          ) {
            // Found a matching overload - store it for codegen
            expr.resolvedOperatorMethod = resolvedCandidate;
            // Store the extension class type for codegen to use
            expr.extensionClassType = instantiatedClassType;
            return wrapResult(resolvedCandidate.returnType);
          }
        }
      }
    }
  }

  if (
    indexType.kind !== TypeKind.Number ||
    (indexType as NumberType).name !== Types.I32.name
  ) {
    ctx.diagnostics.reportError(
      `Array index must be i32, got ${typeToString(indexType)}`,
      DiagnosticCode.TypeMismatch,
      ctx.getLocation(expr.loc),
    );
  }

  const isString =
    objectType === Types.String ||
    objectType === ctx.getWellKnownType(Types.String.name);

  if (objectType.kind !== TypeKind.Array && !isString) {
    ctx.diagnostics.reportError(
      `Index expression only supported on arrays, strings, or types with [] operator, got ${typeToString(objectType)}`,
      DiagnosticCode.NotIndexable,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  if (isString) {
    ctx.diagnostics.reportError(
      `Strings cannot be indexed directly. Use .getByteAt() or convert to array.`,
      DiagnosticCode.NotIndexable,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  return wrapResult((objectType as ArrayType).elementType);
}

function checkSuperExpression(
  ctx: CheckerContext,
  expr: SuperExpression,
): Type {
  if (!ctx.currentClass) {
    ctx.diagnostics.reportError(
      `'super' can only be used inside a class.`,
      DiagnosticCode.UnknownError,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  if (!ctx.currentClass.superType) {
    ctx.diagnostics.reportError(
      `Class '${ctx.currentClass.name}' does not have a superclass.`,
      DiagnosticCode.UnknownError,
      ctx.getLocation(expr.loc),
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
  // Check all embedded expressions and resolve any needed conversion functions
  const resolvedConversions: Declaration[] = [];

  for (const subExpr of expr.expressions) {
    const exprType = checkExpression(ctx, subExpr);

    // Resolve conversion function for primitive types
    const conversionName = getConversionFunctionName(exprType);
    if (conversionName) {
      const info = ctx.resolveValueInfo(conversionName);
      if (
        info?.declaration &&
        !resolvedConversions.includes(info.declaration)
      ) {
        resolvedConversions.push(info.declaration);
      }
    }
  }

  // Store resolved conversions on the AST for DCE
  if (resolvedConversions.length > 0) {
    expr.resolvedConversions = resolvedConversions;
  }

  // The result of an untagged template literal is always a String
  const stringType = ctx.getWellKnownType(Types.String.name);
  return stringType || Types.String;
}

/**
 * Get the name of the conversion function for a type, if it needs one.
 */
function getConversionFunctionName(type: Type): string | null {
  if (type.kind === TypeKind.Number) {
    const numType = type as NumberType;
    switch (numType.name) {
      case 'i32':
        return 'i32ToString';
      case 'u32':
        return 'u32ToString';
      case 'i64':
        return 'i64ToString';
      case 'u64':
        return 'u64ToString';
      case 'f32':
        return 'f32ToString';
      case 'f64':
        return 'f64ToString';
    }
  } else if (type.kind === TypeKind.Boolean) {
    return 'booleanToString';
  } else if (type.kind === TypeKind.Literal) {
    const literalType = type as LiteralType;
    if (typeof literalType.value === 'boolean') {
      return 'booleanToString';
    } else if (typeof literalType.value === 'number') {
      // Numeric literal defaults to i32
      return 'i32ToString';
    }
  }
  return null;
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
  // Resolve TemplateStringsArray type for DCE tracking
  const stringsArrayType = ctx.resolveWellKnownType(
    TypeNames.TemplateStringsArray,
  );
  if (stringsArrayType) {
    expr.resolvedStringsArrayType = stringsArrayType;
  }

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
      ctx.getLocation(expr.loc),
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
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  // Return the function's return type
  return funcType.returnType;
}

export function getPatternType(
  ctx: CheckerContext,
  pattern:
    | Pattern
    | ClassPattern
    | NumberLiteral
    | StringLiteral
    | BooleanLiteral
    | NullLiteral,
): Type | null {
  switch (pattern.type) {
    case NodeType.ClassPattern: {
      const classPattern = pattern as ClassPattern;
      if (
        classPattern.inferredType &&
        classPattern.inferredType.kind === TypeKind.Class
      ) {
        return classPattern.inferredType as ClassType;
      }
      return null;
    }
    default:
      return null;
  }
}

function subtractType(
  ctx: CheckerContext,
  type: Type,
  pattern:
    | Pattern
    | ClassPattern
    | NumberLiteral
    | StringLiteral
    | BooleanLiteral
    | NullLiteral,
): Type {
  if (type.kind === TypeKind.Union) {
    const ut = type as UnionType;
    const remainingMembers: Type[] = [];
    for (const t of ut.types) {
      const rem = subtractType(ctx, t, pattern);
      if (rem.kind !== TypeKind.Never) {
        remainingMembers.push(rem);
      }
    }
    if (remainingMembers.length === 0) return Types.Never;
    return createUnionType(remainingMembers);
  }

  // Handle Wildcard
  if (pattern.type === NodeType.Identifier && pattern.name === '_') {
    return Types.Never;
  }

  // Helper: subtract a pattern type from sealed variants, handling transitive
  // sealed hierarchies (sum of sums). If a variant is itself sealed and the
  // pattern covers one of its sub-variants, recursively subtract.
  // When discriminantType is provided and is an instantiated generic sealed class,
  // variants are instantiated before comparison (variants may be uninstantiated
  // due to the spread in substituteType).
  const subtractFromSealedVariants = (
    variants: ClassType[],
    patType: Type,
    discriminantType?: ClassType,
  ): ClassType[] | null => {
    // Build type map for instantiating generic variants
    let typeMap: Map<string, Type> | undefined;
    if (discriminantType) {
      const source = discriminantType.genericSource || discriminantType;
      if (source.typeParameters && discriminantType.typeArguments) {
        typeMap = new Map<string, Type>();
        source.typeParameters.forEach((param, index) => {
          if (index < discriminantType.typeArguments!.length) {
            typeMap!.set(param.name, discriminantType.typeArguments![index]);
          }
        });
      }
    }
    const remaining: ClassType[] = [];
    let changed = false;
    for (const v of variants) {
      let instantiatedV = v;
      if (
        typeMap &&
        v.typeParameters &&
        v.typeParameters.length > 0 &&
        !v.typeArguments
      ) {
        // v is a generic template — create identity-instantiated version first
        const identityArgs = v.typeParameters.map(
          (p) =>
            ({
              kind: TypeKind.TypeParameter,
              name: p.name,
            }) as TypeParameterType,
        );
        const withIdentity = {
          ...v,
          typeArguments: identityArgs,
          genericSource: v,
        } as ClassType;
        instantiatedV = ctx.substituteTypeParams(
          withIdentity,
          typeMap,
        ) as ClassType;
      } else if (typeMap) {
        instantiatedV = ctx.substituteTypeParams(v, typeMap) as ClassType;
      }
      if (isAssignableTo(ctx, instantiatedV, patType)) {
        // Pattern directly covers this variant
        changed = true;
        continue;
      }
      // If variant is itself sealed, check if pattern covers a sub-variant
      const vSource = instantiatedV.genericSource || instantiatedV;
      if (
        vSource.isSealed &&
        vSource.sealedVariants &&
        vSource.sealedVariants.length > 0
      ) {
        const subRemaining = subtractFromSealedVariants(
          vSource.sealedVariants,
          patType,
          instantiatedV,
        );
        if (subRemaining !== null) {
          changed = true;
          if (subRemaining.length > 0) {
            // Partially covered — keep variant with fewer sub-variants
            remaining.push({
              ...instantiatedV,
              sealedVariants: subRemaining,
            } as ClassType);
          }
          // else: fully covered — drop this variant
          continue;
        }
      }
      remaining.push(instantiatedV);
    }
    return changed ? remaining : null;
  };

  // Handle Variable Pattern (matches everything)
  // But check if this is a sealed variant pattern first
  if (pattern.type === NodeType.Identifier) {
    if ((pattern as any).inferredType) {
      // This is a sealed variant pattern - treat like a class pattern.
      // It only matches class instances, never null.
      const patType = (pattern as any).inferredType as Type;

      if (type.kind === TypeKind.Null) {
        return type;
      }

      if (patType && isAssignableTo(ctx, type, patType)) {
        return Types.Never;
      }

      if (type.kind === TypeKind.Class) {
        const classType = type as ClassType;
        const sealedSource = classType.genericSource || classType;
        if (sealedSource.isSealed && sealedSource.sealedVariants && patType) {
          const remaining = subtractFromSealedVariants(
            sealedSource.sealedVariants,
            patType,
            classType,
          );
          if (remaining !== null) {
            if (remaining.length === 0) return Types.Never;
            if (remaining.length === 1) return remaining[0];
            return createUnionType(remaining);
          }
        }
      }
      return type;
    }
    return Types.Never;
  }
  if (pattern.type === NodeType.AsPattern) {
    return subtractType(ctx, type, (pattern as AsPattern).pattern);
  }

  // Handle Literals
  if (
    pattern.type === NodeType.NumberLiteral ||
    pattern.type === NodeType.StringLiteral ||
    pattern.type === NodeType.BooleanLiteral
  ) {
    // If type is a LiteralType and matches, return Never.
    if (type.kind === TypeKind.Literal) {
      const litType = type as LiteralType;
      const patVal =
        pattern.type === NodeType.NumberLiteral
          ? Number((pattern as NumberLiteral).raw)
          : (pattern as any).value;
      if (litType.value === patVal) return Types.Never;
      return type;
    }
    // If type is Boolean and pattern is true/false
    if (
      type.kind === TypeKind.Boolean &&
      pattern.type === NodeType.BooleanLiteral
    ) {
      const val = (pattern as BooleanLiteral).value;
      return {kind: TypeKind.Literal, value: !val} as LiteralType; // The other boolean value
    }
    return type;
  }

  // Handle Classes
  if (pattern.type === NodeType.ClassPattern) {
    const classPattern = pattern as ClassPattern;
    const patType = classPattern.inferredType;

    if (type.kind === TypeKind.Class) {
      const classType = type as ClassType;

      if (patType && isAssignableTo(ctx, type, patType)) {
        // Pattern class covers the type.
        // Class pattern properties that are pure bindings (identifiers) always match.
        // Only nested refining patterns (literals, nested class/record patterns) may
        // cause a partial match.
        if (classPattern.properties.length === 0) return Types.Never;
        const allBindings = classPattern.properties.every(
          (p) => p.value.type === NodeType.Identifier,
        );
        if (allBindings) return Types.Never;
      }

      // Sealed class exhaustiveness: matching a variant subtracts it from the set.
      // sealedVariants is a definitional property — always read from the source type,
      // never from an instantiation (which may have been created before variants were populated).
      const sealedSource = classType.genericSource || classType;
      if (sealedSource.isSealed && sealedSource.sealedVariants && patType) {
        const remaining = subtractFromSealedVariants(
          sealedSource.sealedVariants,
          patType,
          classType,
        );
        if (remaining !== null) {
          if (remaining.length === 0) return Types.Never;
          if (remaining.length === 1) return remaining[0];
          return createUnionType(remaining);
        }
      }
    }
    return type;
  }

  // Handle Records
  if (pattern.type === NodeType.RecordPattern) {
    if (type.kind === TypeKind.Record) {
      const recordType = type as RecordType;
      let covers = true;
      for (const prop of (pattern as RecordPattern).properties) {
        const fieldType = recordType.properties.get(prop.name.name);
        if (!fieldType) {
          return type;
        }
        const rem = subtractType(ctx, fieldType, prop.value);
        if (rem.kind !== TypeKind.Never) {
          covers = false;
          break;
        }
      }
      if (covers) return Types.Never;
    }
    return type;
  }

  // Handle MemberExpression patterns (enum members like Color.Red)
  if (pattern.type === NodeType.MemberExpression) {
    const memberExpr = pattern as MemberExpression;

    // Check if this is an enum member access (e.g., Color.Red)
    if (memberExpr.object.type === NodeType.Identifier) {
      const enumName = (memberExpr.object as Identifier).name;
      const memberName = memberExpr.property.name;

      // Try to resolve the enum type
      const enumType = ctx.resolveType(enumName);
      if (
        enumType &&
        enumType.kind === TypeKind.TypeAlias &&
        (enumType as TypeAliasType).isDistinct
      ) {
        // Get the enum declaration to find the member value
        const symbolInfo = ctx.resolveValueInfo(enumName);
        if (
          symbolInfo?.declaration &&
          symbolInfo.declaration.type === NodeType.EnumDeclaration
        ) {
          const enumDecl = symbolInfo.declaration as EnumDeclaration;

          // Find the resolved value for this member
          let memberValue: number | string | undefined;
          for (const member of enumDecl.members) {
            if (member.name.name === memberName) {
              memberValue = member.resolvedValue;
              break;
            }
          }

          if (memberValue !== undefined) {
            // If the type is the same distinct enum type, check against its underlying union
            if (type.kind === TypeKind.TypeAlias) {
              const aliasType = type as TypeAliasType;
              if (aliasType.isDistinct && aliasType.name === enumName) {
                // Subtract the literal value from the underlying type
                const literalPattern = {
                  type: NodeType.NumberLiteral,
                  raw: String(memberValue),
                } as NumberLiteral;

                const remaining = subtractType(
                  ctx,
                  aliasType.target,
                  literalPattern,
                );

                if (remaining.kind === TypeKind.Never) {
                  return Types.Never;
                }

                // Re-wrap in the distinct type with the remaining union
                return {
                  kind: TypeKind.TypeAlias,
                  name: aliasType.name,
                  target: remaining,
                  isDistinct: true,
                } as TypeAliasType;
              }
            }
          }
        }
      }
    }
    return type;
  }

  return type;
}

function checkRangeExpression(
  ctx: CheckerContext,
  expr: RangeExpression,
): Type {
  // Check that start and end, if present, are i32
  if (expr.start) {
    const startType = checkExpression(ctx, expr.start);
    if (!isAssignableTo(ctx, startType, Types.I32)) {
      ctx.diagnostics.reportError(
        `Range start must be i32, got ${typeToString(startType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }
  }

  if (expr.end) {
    const endType = checkExpression(ctx, expr.end);
    if (!isAssignableTo(ctx, endType, Types.I32)) {
      ctx.diagnostics.reportError(
        `Range end must be i32, got ${typeToString(endType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(expr.loc),
      );
    }
  }

  // Determine which Range type to return based on start/end presence
  // BoundedRange: both start and end
  // FromRange: start only
  // ToRange: end only
  // FullRange: neither
  let rangeTypeName: string;
  if (expr.start && expr.end) {
    rangeTypeName = 'BoundedRange';
  } else if (expr.start) {
    rangeTypeName = 'FromRange';
  } else if (expr.end) {
    rangeTypeName = 'ToRange';
  } else {
    rangeTypeName = 'FullRange';
  }

  // Look up the Range type from the zena:range module
  const rangeType = ctx.getWellKnownType(rangeTypeName);
  if (!rangeType) {
    ctx.diagnostics.reportError(
      `Range type '${rangeTypeName}' not found. Import from 'zena:range'.`,
      DiagnosticCode.TypeNotFound,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  return rangeType;
}

/**
 * Checks a pipeline expression (e.g., a |> f($) |> g($)).
 * The left-hand side is evaluated and its type becomes available via $ on the right.
 */
function checkPipelineExpression(
  ctx: CheckerContext,
  expr: PipelineExpression,
): Type {
  // Check the left-hand side first
  const leftType = checkExpression(ctx, expr.left);

  // Push the piped value type onto the stack
  ctx.pushPipelineValue(leftType);

  // Check the right-hand side with the piped value available
  const resultType = checkExpression(ctx, expr.right);

  // Pop the piped value type
  ctx.popPipelineValue();

  return resultType;
}

/**
 * Checks a pipeline placeholder ($).
 * This is only valid inside a pipeline expression's right-hand side.
 */
function checkPipePlaceholder(
  ctx: CheckerContext,
  expr: PipePlaceholder,
): Type {
  const pipeType = ctx.getPipelineValueType();

  if (!pipeType) {
    ctx.diagnostics.reportError(
      `'$' can only be used inside a pipeline expression (|>).`,
      DiagnosticCode.SymbolNotFound,
      ctx.getLocation(expr.loc),
    );
    return Types.Unknown;
  }

  return pipeType;
}
