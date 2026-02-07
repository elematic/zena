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
  type Expression,
  type FunctionExpression,
  type Identifier,
  type IfExpression,
  type IndexExpression,
  type IsExpression,
  type LogicalPattern,
  type MatchExpression,
  type MemberExpression,
  type NewExpression,
  type NullLiteral,
  type NumberLiteral,
  type Pattern,
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
  type UnboxedTupleLiteral,
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
  type TypeParameterType,
  type UnboxedTupleType,
  type UnionType,
} from '../types.js';
import type {CheckerContext} from './context.js';

const LENGTH_PROPERTY = 'length';

import {
  instantiateGenericClass,
  instantiateGenericFunction,
  isBooleanType,
  resolveTypeAnnotation,
  typeToString,
  isAssignableTo,
  substituteType,
  validateType,
  validateNoUnboxedTuple,
} from './types.js';
import {checkStatement} from './statements.js';

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
      const lit = expr as any; // Cast to access raw if needed, or update AST type definition
      if (lit.raw && lit.raw.includes('.')) {
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
    case NodeType.TupleLiteral:
      return checkTupleLiteral(ctx, expr as TupleLiteral);
    case NodeType.UnboxedTupleLiteral:
      return checkUnboxedTupleLiteral(ctx, expr as UnboxedTupleLiteral);
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
  const testType = checkExpression(ctx, expr.test);
  if (!isBooleanType(testType) && testType.kind !== TypeKind.Unknown) {
    ctx.diagnostics.reportError(
      `Expected boolean condition in if expression, got ${typeToString(testType)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  const consequentType = checkIfBranch(ctx, expr.consequent);
  const alternateType = checkIfBranch(ctx, expr.alternate);

  // If both branches have the same type, return that type.
  // Otherwise, create a union type.
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
        ctx.declare(pattern.name, discriminantType, 'let', pattern);
      }
      break;
    }
    case NodeType.AsPattern: {
      const asPattern = pattern as AsPattern;
      ctx.declare(asPattern.name.name, discriminantType, 'let', asPattern.name);
      checkMatchPattern(ctx, asPattern.pattern, discriminantType);
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
        );
        return;
      }

      const classType = type as ClassType;

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
          );
          continue;
        }

        let propType: Type = Types.Unknown;
        if (classType.fields.has(propName)) {
          propType = classType.fields.get(propName)!;
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
            propType = classType.fields.get(propName)!;
          } else if (classType.methods.has(propName)) {
            // Assuming getter for now, or method reference?
            // For destructuring, we usually mean property access.
            // If it's a method, it's a function type.
            propType = classType.methods.get(propName)!;
          }

          if (!propType) {
            ctx.diagnostics.reportError(
              `Property '${propName}' does not exist on type '${typeToString(discriminantType)}'.`,
              DiagnosticCode.PropertyNotFound,
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
          );
        }
      }
      break;
    }
    case NodeType.UnboxedTuplePattern:
    case NodeType.TuplePattern: {
      const tuplePattern = pattern as TuplePattern;

      // Handle direct tuple types
      if (
        discriminantType.kind === TypeKind.Tuple ||
        discriminantType.kind === TypeKind.UnboxedTuple
      ) {
        const tupleType = discriminantType as TupleType;
        if (tuplePattern.elements.length > tupleType.elementTypes.length) {
          ctx.diagnostics.reportError(
            `Tuple pattern has ${tuplePattern.elements.length} elements but type has ${tupleType.elementTypes.length}.`,
            DiagnosticCode.TypeMismatch,
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
          (t) => t.kind === TypeKind.Tuple || t.kind === TypeKind.UnboxedTuple,
        ) as TupleType[];

        if (tupleMembers.length === 0) {
          ctx.diagnostics.reportError(
            `Cannot destructure non-tuple type '${typeToString(discriminantType)}'.`,
            DiagnosticCode.TypeMismatch,
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
            );
          }
        }

        for (const [key] of rightVars) {
          if (!leftVars.has(key)) {
            const name = key.includes(':') ? key.split(':')[1] : key;
            ctx.diagnostics.reportError(
              `Variable '${name}' is bound in the right branch of the OR pattern but not the left.`,
              DiagnosticCode.TypeMismatch,
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
        value: (pattern as NumberLiteral).value,
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

  // Deduplicate
  const uniqueTypes: Type[] = [];
  const seen = new Set<string>();
  for (const t of typesToProcess) {
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
      );
    }
    return Types.Boolean;
  } else if (expr.operator === '-') {
    if (argType.kind !== TypeKind.Number) {
      ctx.diagnostics.reportError(
        `Operator '-' requires numeric operand, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
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
  const errorType = ctx.resolveType('Error');
  if (errorType) {
    if (!isAssignableTo(ctx, argType, errorType)) {
      ctx.diagnostics.reportError(
        `Thrown value must be an instance of Error, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
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
    const errorType = ctx.resolveType('Error') ?? Types.Unknown;
    ctx.declare(clause.param.name, errorType, 'let', clause.param);
  }

  const bodyType = checkBlockExpressionType(ctx, clause.body);

  ctx.exitScope();
  return bodyType;
}

function checkAsExpression(ctx: CheckerContext, expr: AsExpression): Type {
  checkExpression(ctx, expr.expression);
  // We trust the user knows what they are doing with 'as' for now,
  // or we could add checks later (e.g. no casting string to int).
  // For distinct types, this is the primary way to "wrap" a value.
  return resolveTypeAnnotation(ctx, expr.typeAnnotation);
}

function checkIsExpression(ctx: CheckerContext, expr: IsExpression): Type {
  checkExpression(ctx, expr.expression);
  resolveTypeAnnotation(ctx, expr.typeAnnotation);
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
        (expr as NumberLiteral).value === literalType.value
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
        if (!isAssignableTo(ctx, argType, ctx.currentClass.onType)) {
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

      if (!isAssignableTo(ctx, argType, paramType)) {
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
        if (!isAssignableTo(ctx, argTypes[i], funcMember.parameters[i])) {
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
      } else if (!isAssignableTo(ctx, funcMember.returnType, returnType)) {
        // If not assignable one way, try the other (simple union check)
        if (isAssignableTo(ctx, returnType, funcMember.returnType)) {
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
      );
    } else {
      // Fill in missing arguments with default values
      if (funcType.parameterInitializers) {
        for (
          let i = expr.arguments.length;
          i < funcType.parameters.length;
          i++
        ) {
          const initializer = funcType.parameterInitializers[i];
          if (initializer) {
            // We reuse the initializer AST node.
            // This is safe for codegen as long as we don't mutate it.
            // However, we should probably clone it if we were doing transformations that mutate.
            // For now, just push it.
            expr.arguments.push(initializer);
            // Check the new argument to get its type and update argTypes
            const argType = checkExpression(ctx, initializer);
            argTypes.push(argType);
            // We also need to check it? It was checked at definition.
            // But we need to ensure it's valid in the call context?
            // Default values are usually evaluated in the function's context (if they refer to other params)
            // or constant.
            // If they are constant, it's fine.
            // If they refer to other params, we can't just push the AST node if it uses identifiers that are not in scope.
            // But wait, if the default value is `x + 1` where `x` is a param,
            // and we push it to the call site arguments, `x` is NOT in scope at the call site!
            // This "Caller supplies default" strategy ONLY works for constant defaults or defaults that only use globals.
            // If the default uses other parameters, we CANNOT just push the AST.
            // We would need to evaluate it.
            // But Zena is compiled.
            // So if we have `function foo(x: i32, y: i32 = x + 1)`,
            // and we call `foo(1)`, we want `foo(1, 1 + 1)`.
            // But `x` is not defined at call site.
            // We would need to replace `x` with the *value* of the first argument.
            // This requires AST substitution.
            // For now, let's assume defaults are constants or don't refer to other params.
            // If they do, this implementation is buggy.
            // But for `initialCapacity: i32 = 10`, it works.
          } else {
            // Optional but no default? Inject null.
            const nullLiteral: Expression = {
              type: NodeType.NullLiteral,
            };
            expr.arguments.push(nullLiteral);
            argTypes.push(Types.Null);
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
      );
    }

    const valueType = checkExpression(ctx, expr.value);
    if (!isAssignableTo(ctx, valueType, symbol.type)) {
      ctx.diagnostics.reportError(
        `Type mismatch in assignment: expected ${typeToString(symbol.type)}, got ${typeToString(valueType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }

    return valueType;
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
        );
      }
      return Types.Unknown;
    }

    const classType = objectType as ClassType | InterfaceType;
    const memberName = memberExpr.property.name;

    if (classType.fields.has(memberName)) {
      const fieldType = classType.fields.get(memberName)!;
      const valueType = checkExpression(ctx, expr.value);

      if (!isAssignableTo(ctx, valueType, fieldType)) {
        ctx.diagnostics.reportError(
          `Type mismatch in assignment: expected ${typeToString(fieldType)}, got ${typeToString(valueType)}`,
          DiagnosticCode.TypeMismatch,
        );
      }

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
      });

      return valueType;
    }

    // Check setters
    const setterName = getSetterName(memberName);
    if (classType.methods.has(setterName)) {
      const setter = classType.methods.get(setterName)!;
      const valueType = checkExpression(ctx, expr.value);

      // Record binding for DCE tracking
      // Setters use dynamic dispatch unless the class is final
      const isFinalClass =
        classType.kind === TypeKind.Class &&
        (classType as ClassType).isFinal === true;
      ctx.semanticContext.setResolvedBinding(memberExpr, {
        kind: 'setter',
        classType: classType as ClassType | InterfaceType,
        methodName: setterName,
        isStaticDispatch: isFinalClass,
      });

      // Setter param type
      const paramType = setter.parameters[0];
      if (!isAssignableTo(ctx, valueType, paramType)) {
        ctx.diagnostics.reportError(
          `Type mismatch in assignment: expected ${typeToString(paramType)}, got ${typeToString(valueType)}`,
          DiagnosticCode.TypeMismatch,
        );
      }
      return valueType;
    }

    // Check if it is a read-only property (getter only)
    const getterName = getGetterName(memberName);
    if (classType.methods.has(getterName)) {
      ctx.diagnostics.reportError(
        `Cannot assign to read-only property '${memberName}'.`,
        DiagnosticCode.InvalidAssignment,
      );
      return Types.Unknown;
    }

    ctx.diagnostics.reportError(
      `Field '${memberName}' does not exist on type '${classType.name}'.`,
      DiagnosticCode.PropertyNotFound,
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
          );
        } else {
          if (!isAssignableTo(ctx, indexType, resolvedSetter.parameters[0])) {
            ctx.diagnostics.reportError(
              `Type mismatch in index: expected ${typeToString(resolvedSetter.parameters[0])}, got ${typeToString(indexType)}`,
              DiagnosticCode.TypeMismatch,
            );
          }

          const valueType = checkExpression(ctx, expr.value);
          if (!isAssignableTo(ctx, valueType, resolvedSetter.parameters[1])) {
            ctx.diagnostics.reportError(
              `Type mismatch in assignment: expected ${typeToString(resolvedSetter.parameters[1])}, got ${typeToString(valueType)}`,
              DiagnosticCode.TypeMismatch,
            );
          }

          // Annotate the index expression with the value type (result of the assignment expression)
          indexExpr.inferredType = valueType;
          return valueType;
        }
        return Types.Unknown;
      }

      // Check if it is a read-only indexer (getter only)
      const getter = classType.methods.get('[]');
      if (getter) {
        ctx.diagnostics.reportError(
          `Cannot assign to read-only indexer.`,
          DiagnosticCode.InvalidAssignment,
        );
        return Types.Unknown;
      }
    }

    // Check the index expression (this will annotate the object and index)
    const elementType = checkIndexExpression(ctx, indexExpr);

    // Check if value is assignable to element type
    const valueType = checkExpression(ctx, expr.value);
    if (!isAssignableTo(ctx, valueType, elementType)) {
      ctx.diagnostics.reportError(
        `Type mismatch in assignment: expected ${typeToString(elementType)}, got ${typeToString(valueType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }

    return valueType;
  }
  return Types.Unknown;
}

/**
 * Checks a binary expression (e.g., a + b, a == b).
 * Handles arithmetic type promotion (i32 -> f32 -> f64) and operator overloading.
 */
function checkBinaryExpression(
  ctx: CheckerContext,
  expr: BinaryExpression,
): Type {
  const left = checkExpression(ctx, expr.left);
  const right = checkExpression(ctx, expr.right);

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
        );
        return Types.Unknown;
      }

      if (!isAssignableTo(ctx, right, resolvedMethod.parameters[0])) {
        ctx.diagnostics.reportError(
          `Type mismatch in operator ${expr.operator}: expected ${typeToString(resolvedMethod.parameters[0])}, got ${typeToString(right)}`,
          DiagnosticCode.TypeMismatch,
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
      resultType = Types.Boolean;
    } else if (expr.operator === '===' || expr.operator === '!==') {
      // Allow comparing boolean literal types with each other
      if (isBooleanType(left) && isBooleanType(right)) {
        typesMatch = true;
      } else {
        typesMatch =
          isAssignableTo(ctx, left, right) || isAssignableTo(ctx, right, left);
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
  const optionalParameters: boolean[] = [];
  const parameterInitializers: any[] = [];

  for (let i = 0; i < expr.params.length; i++) {
    const param = expr.params[i];

    // Resolve type: use annotation if present, otherwise infer from contextual type
    let type: Type;
    if (param.typeAnnotation) {
      type = resolveTypeAnnotation(ctx, param.typeAnnotation);
      // Unboxed tuples cannot appear in parameter types
      validateNoUnboxedTuple(type, ctx, 'parameter types');
    } else if (expectedFuncType && i < expectedFuncType.parameters.length) {
      // Contextual typing: infer parameter type from expected function type
      type = expectedFuncType.parameters[i];
    } else {
      // No annotation and no contextual type - error
      ctx.diagnostics.reportError(
        `Parameter '${param.name.name}' has no type annotation and cannot be inferred from context.`,
        DiagnosticCode.TypeMismatch,
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

    ctx.declare(param.name.name, type, 'let', param);
    paramTypes.push(type);
    optionalParameters.push(param.optional);
    parameterInitializers.push(param.initializer);

    if (param.initializer) {
      const initType = checkExpression(ctx, param.initializer);
      if (!isAssignableTo(ctx, initType, type)) {
        ctx.diagnostics.reportError(
          `Type mismatch: default value ${typeToString(initType)} is not assignable to ${typeToString(type)}`,
          DiagnosticCode.TypeMismatch,
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

    if (
      expectedReturnType.kind !== Types.Unknown.kind &&
      !isAssignableTo(ctx, bodyType, expectedReturnType)
    ) {
      ctx.diagnostics.reportError(
        `Type mismatch: expected return type ${typeToString(expectedReturnType)}, got ${typeToString(bodyType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }
  }

  ctx.inferredReturnTypes = previousInferredReturns;
  ctx.currentFunctionReturnType = previousReturnType;
  ctx.exitScope();

  return {
    kind: TypeKind.Function,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    parameters: paramTypes,
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
      }
    }
  }

  for (
    let i = 0;
    i < Math.min(expr.arguments.length, constructor.parameters.length);
    i++
  ) {
    const argType = checkExpression(ctx, expr.arguments[i]);
    const paramType = constructor.parameters[i];

    if (!isAssignableTo(ctx, argType, paramType)) {
      ctx.diagnostics.reportError(
        `Type mismatch in argument ${i + 1}: expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
      );
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

        return resolvedMethod;
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

        return resolvedType;
      }
    }

    if (expr.property.name === LENGTH_PROPERTY) {
      // Fallback for intrinsic array.length (should have been caught above)
      return Types.I32;
    }
  }

  if (objectType.kind === TypeKind.Record) {
    const recordType = objectType as RecordType;
    const memberName = expr.property.name;
    if (recordType.properties.has(memberName)) {
      const fieldType = recordType.properties.get(memberName)!;

      // Store record field binding
      const binding: RecordFieldBinding = {
        kind: 'record-field',
        recordType,
        fieldName: memberName,
        type: fieldType,
      };
      ctx.semanticContext.setResolvedBinding(expr, binding);

      return fieldType;
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
      );
      return Types.Unknown;
    }

    if (!isAssignableTo(ctx, objectType, ctx.currentClass)) {
      ctx.diagnostics.reportError(
        `Type '${typeToString(objectType)}' does not have private member '${memberName}' from class '${ctx.currentClass.name}'.`,
        DiagnosticCode.TypeMismatch,
      );
      return Types.Unknown;
    }

    if (ctx.currentClass.fields.has(memberName)) {
      const fieldType = ctx.currentClass.fields.get(memberName)!;

      // Store private field binding (use mangled name for codegen)
      const binding: FieldBinding = {
        kind: 'field',
        classType: ctx.currentClass,
        fieldName: `${ctx.currentClass.name}::${memberName}`,
        type: fieldType,
      };
      ctx.semanticContext.setResolvedBinding(expr, binding);

      return fieldType;
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

    return methodType;
  }

  // Check fields
  if (classType.fields.has(memberName)) {
    const fieldType = classType.fields.get(memberName)!;
    const resolvedType = resolveMemberType(classType, fieldType, ctx);

    // Store field binding
    const binding: FieldBinding = {
      kind: 'field',
      classType,
      fieldName: memberName,
      type: resolvedType,
    };
    ctx.semanticContext.setResolvedBinding(expr, binding);

    return resolvedType;
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

    return resolvedType;
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

    // Store getter binding
    // Static dispatch is possible if: class is final/extension, or getter is final
    const binding: GetterBinding = {
      kind: 'getter',
      classType,
      methodName: getterName,
      isStaticDispatch:
        canUseStaticDispatch(classType) || getterType.isFinal === true,
      type: resolvedGetter.returnType,
    };
    ctx.semanticContext.setResolvedBinding(expr, binding);

    return resolvedGetter.returnType;
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

  // ctx.currentClass already has typeArguments = typeParameters for generic classes
  // (set by enterClass), so we can just return it directly.
  return ctx.currentClass;
}

function checkArrayLiteral(ctx: CheckerContext, expr: ArrayLiteral): Type {
  if (expr.elements.length === 0) {
    // Empty array literal, infer as Array<Unknown> or similar?
    // For now, let's assume Array<i32> if empty, or maybe we need a bottom type.
    // Better: Array<any> (if we had any).
    // Let's return Array<Unknown> and hope it gets refined or cast.
    return ctx.getOrCreateArrayType(Types.Unknown);
  }

  const elementTypes = expr.elements.map((e) => checkExpression(ctx, e));
  // Check if all element types are compatible.
  // For simplicity, take the first type and check if others are assignable to it.
  // A better approach would be finding the common supertype.
  const firstType = elementTypes[0];
  for (let i = 1; i < elementTypes.length; i++) {
    if (!isAssignableTo(ctx, elementTypes[i], firstType)) {
      ctx.diagnostics.reportError(
        `Array element type mismatch. Expected '${typeToString(firstType)}', got '${typeToString(elementTypes[i])}'.`,
        DiagnosticCode.TypeMismatch,
      );
    }
  }

  return ctx.getOrCreateArrayType(firstType);
}

function checkRecordLiteral(ctx: CheckerContext, expr: RecordLiteral): Type {
  const properties = new Map<string, Type>();
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
        );
        continue;
      }
      if (spreadType.kind === TypeKind.Record) {
        for (const [key, type] of (spreadType as RecordType).properties) {
          properties.set(key, type);
        }
      } else {
        // Class
        for (const [key, type] of (spreadType as ClassType).fields) {
          if (!key.startsWith('#')) {
            properties.set(key, type);
          }
        }
      }
    } else {
      const type = checkExpression(ctx, prop.value);
      properties.set(prop.name.name, type);
    }
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

/**
 * Check an unboxed tuple literal expression like ((1, 2)).
 * This is only valid in return position (expression body or return statement).
 * Returns an UnboxedTupleType.
 */
function checkUnboxedTupleLiteral(
  ctx: CheckerContext,
  expr: UnboxedTupleLiteral,
): Type {
  const elementTypes = expr.elements.map((e) => checkExpression(ctx, e));
  const resultType: UnboxedTupleType = {
    kind: TypeKind.UnboxedTuple,
    elementTypes,
  };
  expr.inferredType = resultType;
  return resultType;
}

function checkIndexExpression(
  ctx: CheckerContext,
  expr: IndexExpression,
): Type {
  const objectType = checkExpression(ctx, expr.object);
  const indexType = checkExpression(ctx, expr.index);

  // Handle symbol-keyed member access: obj[symbol]
  if (indexType.kind === TypeKind.Symbol) {
    const symbolType = indexType as SymbolType;
    expr.resolvedSymbol = symbolType;

    if (
      objectType.kind === TypeKind.Class ||
      objectType.kind === TypeKind.Interface
    ) {
      const classType = objectType as ClassType | InterfaceType;

      // Check symbolFields first
      if (classType.symbolFields?.has(symbolType)) {
        const fieldType = classType.symbolFields.get(symbolType)!;
        return resolveMemberType(classType, fieldType, ctx);
      }

      // Check symbolMethods
      if (classType.symbolMethods?.has(symbolType)) {
        const methodType = classType.symbolMethods.get(symbolType)!;
        return resolveMemberType(classType, methodType, ctx);
      }

      ctx.diagnostics.reportError(
        `Symbol '${symbolType.debugName ?? '<symbol>'}' does not exist on type '${objectType.kind === TypeKind.Class ? (objectType as ClassType).name : (objectType as InterfaceType).name}'.`,
        DiagnosticCode.PropertyNotFound,
      );
      return Types.Unknown;
    }

    ctx.diagnostics.reportError(
      `Symbol-keyed access is only supported on classes and interfaces.`,
      DiagnosticCode.TypeMismatch,
    );
    return Types.Unknown;
  }

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
        );
      } else {
        if (!isAssignableTo(ctx, indexType, selectedOverload.parameters[0])) {
          ctx.diagnostics.reportError(
            `Type mismatch in index: expected ${typeToString(selectedOverload.parameters[0])}, got ${typeToString(indexType)}`,
            DiagnosticCode.TypeMismatch,
          );
        }
      }
      // Store the resolved operator method for codegen
      expr.resolvedOperatorMethod = selectedOverload;
      return selectedOverload.returnType;
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
            return resolvedCandidate.returnType;
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
    );
  }

  const isString =
    objectType === Types.String ||
    objectType === ctx.getWellKnownType(Types.String.name);

  if (objectType.kind !== TypeKind.Array && !isString) {
    ctx.diagnostics.reportError(
      `Index expression only supported on arrays, strings, or types with [] operator, got ${typeToString(objectType)}`,
      DiagnosticCode.NotIndexable,
    );
    return Types.Unknown;
  }

  if (isString) {
    ctx.diagnostics.reportError(
      `Strings cannot be indexed directly. Use .getByteAt() or convert to array.`,
      DiagnosticCode.NotIndexable,
    );
    return Types.Unknown;
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
  const stringType = ctx.getWellKnownType(Types.String.name);
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
      const type = ctx.resolveType(classPattern.name.name);
      if (type && type.kind === TypeKind.Class) {
        return type as ClassType;
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
  // Handle Variable Pattern (matches everything)
  if (pattern.type === NodeType.Identifier) {
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
      const patVal = (pattern as any).value;
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
    const className = classPattern.name.name;
    const patType = ctx.resolveType(className);

    if (type.kind === TypeKind.Class) {
      if (patType && isAssignableTo(ctx, type, patType)) {
        // Pattern class covers the type.
        // Check properties.
        if (classPattern.properties.length === 0) return Types.Never;

        // If properties are present, we assume it's partial unless we prove otherwise.
        // For now, assume if there are properties, it's NOT exhaustive for the class.
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
      );
    }
  }

  if (expr.end) {
    const endType = checkExpression(ctx, expr.end);
    if (!isAssignableTo(ctx, endType, Types.I32)) {
      ctx.diagnostics.reportError(
        `Range end must be i32, got ${typeToString(endType)}`,
        DiagnosticCode.TypeMismatch,
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
  const rangeType = ctx.resolveType(rangeTypeName);
  if (!rangeType) {
    ctx.diagnostics.reportError(
      `Range type '${rangeTypeName}' not found. Import from 'zena:range'.`,
      DiagnosticCode.TypeNotFound,
    );
    return Types.Unknown;
  }

  return rangeType;
}
