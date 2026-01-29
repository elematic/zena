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
  type RecordLiteral,
  type RecordPattern,
  type StringLiteral,
  type TaggedTemplateExpression,
  type TemplateLiteral,
  type ThisExpression,
  type ThrowExpression,
  type TryExpression,
  type TupleLiteral,
  type TuplePattern,
  type UnaryExpression,
} from '../ast.js';
import {CompilerError, DiagnosticCode} from '../diagnostics.js';
import {getGetterName, getSetterName} from '../names.js';
import {WasmModule} from '../emitter.js';
import {
  Decorators,
  TypeKind,
  Types,
  type ClassType,
  type FunctionType,
  type InterfaceType,
  type NumberType,
  type RecordType,
  type Type,
  type UnionType,
} from '../types.js';
import {
  CatchKind,
  ExportDesc,
  GcOpcode,
  HeapType,
  Opcode,
  ValType,
} from '../wasm.js';
import {analyzeCaptures} from './captures.js';

const BOX_VALUE_FIELD = 'value';
const HASH_CODE_METHOD = 'hashCode';

import {
  decodeTypeIndex,
  getSpecializedName,
  instantiateClass,
  mapCheckerTypeToWasmType,
} from './classes.js';
import type {CodegenContext} from './context.js';
import {
  instantiateGenericFunction,
  instantiateGenericMethod,
} from './functions.js';
import {
  generateBlockStatement,
  generateFunctionStatement,
} from './statements.js';
import type {ClassInfo, InterfaceInfo} from './types.js';
import {
  resolveImport,
  type ClassBinding,
  type FieldBinding,
  type GetterBinding,
  type MethodBinding,
  type RecordFieldBinding,
  type ResolvedBinding,
} from '../bindings.js';

/**
 * Generates WASM instructions for an expression.
 * Appends the instructions to the `body` array.
 * The generated code leaves the result of the expression on the stack.
 */
export function generateExpression(
  ctx: CodegenContext,
  expression: Expression,
  body: number[],
) {
  switch (expression.type) {
    case NodeType.BinaryExpression:
      generateBinaryExpression(ctx, expression as BinaryExpression, body);
      break;
    case NodeType.AssignmentExpression:
      generateAssignmentExpression(
        ctx,
        expression as AssignmentExpression,
        body,
      );
      break;
    case NodeType.CallExpression:
      generateCallExpression(ctx, expression as CallExpression, body);
      break;
    case NodeType.NumberLiteral:
      generateNumberLiteral(ctx, expression as NumberLiteral, body);
      break;
    case NodeType.BooleanLiteral:
      generateBooleanLiteral(ctx, expression as BooleanLiteral, body);
      break;
    case NodeType.Identifier:
      generateIdentifier(ctx, expression as Identifier, body);
      break;
    case NodeType.NewExpression:
      generateNewExpression(ctx, expression as NewExpression, body);
      break;
    case NodeType.MemberExpression:
      generateMemberExpression(ctx, expression as MemberExpression, body);
      break;
    case NodeType.ThisExpression:
      generateThisExpression(ctx, expression as ThisExpression, body);
      break;
    case NodeType.SuperExpression:
      // SuperExpression is just 'this' at runtime
      body.push(Opcode.local_get, 0);
      break;
    case NodeType.ArrayLiteral:
      generateArrayLiteral(ctx, expression as ArrayLiteral, body);
      break;
    case NodeType.IndexExpression:
      generateIndexExpression(ctx, expression as IndexExpression, body);
      break;
    case NodeType.StringLiteral:
      generateStringLiteral(ctx, expression as StringLiteral, body);
      break;
    case NodeType.NullLiteral:
      generateNullLiteral(ctx, expression as NullLiteral, body);
      break;
    case NodeType.RecordLiteral:
      generateRecordLiteral(ctx, expression as RecordLiteral, body);
      break;
    case NodeType.TupleLiteral:
      generateTupleLiteral(ctx, expression as TupleLiteral, body);
      break;
    case NodeType.AsExpression:
      generateAsExpression(ctx, expression as AsExpression, body);
      break;
    case NodeType.IsExpression:
      generateIsExpression(ctx, expression as IsExpression, body);
      break;
    case NodeType.FunctionExpression:
      generateFunctionExpression(ctx, expression as FunctionExpression, body);
      break;
    case NodeType.TemplateLiteral:
      generateTemplateLiteral(ctx, expression as TemplateLiteral, body);
      break;
    case NodeType.TaggedTemplateExpression:
      generateTaggedTemplateExpression(
        ctx,
        expression as TaggedTemplateExpression,
        body,
      );
      break;
    case NodeType.ThrowExpression:
      generateThrowExpression(ctx, expression as ThrowExpression, body);
      break;
    case NodeType.TryExpression:
      generateTryExpression(ctx, expression as TryExpression, body);
      break;
    case NodeType.UnaryExpression:
      generateUnaryExpression(ctx, expression as UnaryExpression, body);
      break;
    case NodeType.MatchExpression:
      generateMatchExpression(ctx, expression as MatchExpression, body);
      break;
    case NodeType.IfExpression:
      generateIfExpression(ctx, expression as IfExpression, body);
      break;
    default:
      // TODO: Handle other expressions
      break;
  }
}

function generateThrowExpression(
  ctx: CodegenContext,
  expr: ThrowExpression,
  body: number[],
) {
  // Generate the exception payload (e.g., Error object)
  generateExpression(ctx, expr.argument, body);
  // Store payload in the global variable
  body.push(Opcode.global_set);
  body.push(
    ...WasmModule.encodeUnsignedLEB128(ctx.exceptionPayloadGlobalIndex),
  );
  // Throw the exception (tag has no params, payload is in global)
  body.push(Opcode.throw);
  body.push(...WasmModule.encodeSignedLEB128(ctx.exceptionTagIndex));
}

/**
 * Generate code for try/catch/finally expressions.
 *
 * WASM try_table structure:
 * We use a simplified approach with locals to handle the control flow complexity.
 * The exception payload is stored in a global variable (set by throw, read by catch).
 *
 * For: try { tryBody } catch (e) { catchBody }
 *
 * We generate:
 *   block $done
 *     block $catch
 *       try_table (catch tagIdx $catch)
 *         tryBody -> $result
 *       end
 *       br $done  ; success
 *     end
 *     ; caught: payload is in global, nothing on stack
 *     ; read payload from global if needed
 *     catchBody -> $result
 *   end
 */
function generateTryExpression(
  ctx: CodegenContext,
  expr: TryExpression,
  body: number[],
) {
  // Get result type from inferred type
  let resultType: number[] = [];
  if (expr.inferredType) {
    resultType = mapCheckerTypeToWasmType(ctx, expr.inferredType);
  }

  // Allocate local for the result if we have a non-void result
  let resultLocal: number | null = null;
  if (resultType.length > 0) {
    resultLocal = ctx.declareLocal(
      `$$try_result_${ctx.nextLocalIndex}`,
      resultType,
    );
  }

  if (expr.handler) {
    // Simple try/catch structure
    // block $done
    //   block $catch  ; catch target (void - tag has no params)
    //     try_table (catch tag $catch)
    //       try body
    //     end
    //     br $done
    //   end
    //   ; exception caught - payload is in global, read it if needed
    //   ; handle it and produce result
    // end

    // Outer block (void - we use locals for result)
    body.push(Opcode.block);
    body.push(ValType.void);

    // Catch target block (void - tag has no params so nothing pushed)
    body.push(Opcode.block);
    body.push(ValType.void);

    // try_table (void) with catch
    body.push(Opcode.try_table);
    body.push(ValType.void);

    // 1 catch clause
    body.push(0x01);
    body.push(CatchKind.catch);
    body.push(...WasmModule.encodeUnsignedLEB128(ctx.exceptionTagIndex));
    body.push(...WasmModule.encodeUnsignedLEB128(0)); // branch to immediately enclosing block ($catch)

    // Generate try body
    ctx.pushScope();
    generateBlockExpressionCode(ctx, expr.body, body);
    // Store result in local
    if (resultLocal !== null) {
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeUnsignedLEB128(resultLocal));
    }
    ctx.popScope();

    body.push(Opcode.end); // end try_table

    // If we have finally, run it now (success path)
    if (expr.finalizer) {
      ctx.pushScope();
      generateBlockExpressionCode(ctx, expr.finalizer, body);
      ctx.popScope();
      // Drop finally result
      body.push(Opcode.drop);
    }

    // Success - branch past catch block to done
    body.push(Opcode.br);
    body.push(...WasmModule.encodeUnsignedLEB128(1)); // skip $catch block

    body.push(Opcode.end); // end catch target block

    // Exception was caught - payload is in global, read it if handler has param
    ctx.pushScope();
    if (expr.handler.param) {
      // Find the Error class type using well-known type
      let errorTypeIndex = -1;
      const errorDecl = ctx.wellKnownTypes.Error;
      if (
        errorDecl?.inferredType &&
        errorDecl.inferredType.kind === TypeKind.Class
      ) {
        const errorClassInfo = ctx.getClassInfo(
          errorDecl.inferredType as ClassType,
        );
        if (errorClassInfo) {
          errorTypeIndex = errorClassInfo.structTypeIndex;
        }
      }

      // Declare local with Error struct type if found, otherwise eqref
      const paramType =
        errorTypeIndex >= 0
          ? [ValType.ref_null, ...WasmModule.encodeSignedLEB128(errorTypeIndex)]
          : [ValType.eqref];
      const paramLocal = ctx.declareLocal(
        expr.handler.param.name,
        paramType,
        expr.handler.param,
      );

      // Read payload from global
      body.push(Opcode.global_get);
      body.push(
        ...WasmModule.encodeUnsignedLEB128(ctx.exceptionPayloadGlobalIndex),
      );

      // Cast from eqref to Error struct type if we found it
      if (errorTypeIndex >= 0) {
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...WasmModule.encodeSignedLEB128(errorTypeIndex));
      }

      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeUnsignedLEB128(paramLocal));
    }
    // No else - if no param, we don't need the payload

    // Generate catch body
    generateBlockExpressionCode(ctx, expr.handler.body, body);
    // Store result in local
    if (resultLocal !== null) {
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeUnsignedLEB128(resultLocal));
    }
    ctx.popScope();

    // If we have finally, run it (catch path)
    if (expr.finalizer) {
      ctx.pushScope();
      generateBlockExpressionCode(ctx, expr.finalizer, body);
      ctx.popScope();
      // Drop finally result
      body.push(Opcode.drop);
    }

    body.push(Opcode.end); // end outer done block

    // Load result
    if (resultLocal !== null) {
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeUnsignedLEB128(resultLocal));
    }
  } else {
    // Only finally, no catch handler
    // We need to catch, run finally, then rethrow
    // Exception payload is in global, we save it to local for rethrowing

    // Local for exception payload
    const exnLocal = ctx.declareLocal(`$$try_exn_${ctx.nextLocalIndex}`, [
      ValType.eqref,
    ]);
    const caughtLocal = ctx.declareLocal(`$$try_caught_${ctx.nextLocalIndex}`, [
      ValType.i32,
    ]);

    // Initialize caught flag to 0
    body.push(Opcode.i32_const);
    body.push(0);
    body.push(Opcode.local_set);
    body.push(...WasmModule.encodeUnsignedLEB128(caughtLocal));

    // Outer block
    body.push(Opcode.block);
    body.push(ValType.void);

    // Catch target block (void - tag has no params)
    body.push(Opcode.block);
    body.push(ValType.void);

    // try_table with catch
    body.push(Opcode.try_table);
    body.push(ValType.void);

    body.push(0x01);
    body.push(CatchKind.catch);
    body.push(...WasmModule.encodeUnsignedLEB128(ctx.exceptionTagIndex));
    body.push(...WasmModule.encodeUnsignedLEB128(0));

    // Generate try body
    ctx.pushScope();
    generateBlockExpressionCode(ctx, expr.body, body);
    if (resultLocal !== null) {
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeUnsignedLEB128(resultLocal));
    }
    ctx.popScope();

    body.push(Opcode.end); // end try_table

    // Success path - branch to done
    body.push(Opcode.br);
    body.push(...WasmModule.encodeUnsignedLEB128(1));

    body.push(Opcode.end); // end catch target

    // Exception caught - read payload from global and save to local
    body.push(Opcode.global_get);
    body.push(
      ...WasmModule.encodeUnsignedLEB128(ctx.exceptionPayloadGlobalIndex),
    );
    body.push(Opcode.local_set);
    body.push(...WasmModule.encodeUnsignedLEB128(exnLocal));
    body.push(Opcode.i32_const);
    body.push(1);
    body.push(Opcode.local_set);
    body.push(...WasmModule.encodeUnsignedLEB128(caughtLocal));

    body.push(Opcode.end); // end outer block

    // Run finally (both paths end up here)
    ctx.pushScope();
    generateBlockExpressionCode(ctx, expr.finalizer!, body);
    ctx.popScope();
    // Drop finally result
    body.push(Opcode.drop);

    // If we caught an exception, rethrow it
    // First restore the payload to global, then throw
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeUnsignedLEB128(caughtLocal));
    body.push(Opcode.if);
    body.push(ValType.void);
    // Store payload back to global before rethrowing
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeUnsignedLEB128(exnLocal));
    body.push(Opcode.global_set);
    body.push(
      ...WasmModule.encodeUnsignedLEB128(ctx.exceptionPayloadGlobalIndex),
    );
    body.push(Opcode.throw);
    body.push(...WasmModule.encodeSignedLEB128(ctx.exceptionTagIndex));
    body.push(Opcode.end);

    // Load result
    if (resultLocal !== null) {
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeUnsignedLEB128(resultLocal));
    }
  }
}

function generateUnaryExpression(
  ctx: CodegenContext,
  expr: UnaryExpression,
  body: number[],
) {
  if (expr.operator === '!') {
    generateExpression(ctx, expr.argument, body);
    // Boolean is i32 (0 or 1). !x is equivalent to x == 0.
    body.push(Opcode.i32_eqz);
    return;
  }

  if (expr.operator === '-') {
    const type = inferType(ctx, expr.argument);
    if (type.length === 1 && type[0] === ValType.f32) {
      generateExpression(ctx, expr.argument, body);
      body.push(Opcode.f32_neg);
    } else {
      // Assume i32
      body.push(Opcode.i32_const, 0);
      generateExpression(ctx, expr.argument, body);
      body.push(Opcode.i32_sub);
    }
    return;
  }

  throw new Error(`Unsupported unary operator: ${expr.operator}`);
}

function generateNullLiteral(
  ctx: CodegenContext,
  expr: NullLiteral,
  body: number[],
) {
  body.push(Opcode.ref_null);
  body.push(HeapType.none);
}

function generateAsExpression(
  ctx: CodegenContext,
  expr: AsExpression,
  body: number[],
) {
  generateExpression(ctx, expr.expression, body);

  // Use checker types for semantic operations (lookups, type identity).
  // WASM types are computed lazily, only when needed for opcode emission.
  let sourceCheckerType = expr.expression.inferredType;
  let targetCheckerType = expr.inferredType!;

  // Substitute type parameters if we're in a generic context
  if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
    if (targetCheckerType) {
      targetCheckerType = ctx.checkerContext.substituteTypeParams(
        targetCheckerType,
        ctx.currentTypeArguments,
      );
    }
    if (sourceCheckerType) {
      sourceCheckerType = ctx.checkerContext.substituteTypeParams(
        sourceCheckerType,
        ctx.currentTypeArguments,
      );
    }
  }

  // Compute WASM types for opcode emission
  if (!targetCheckerType) {
    throw new Error(`AsExpression missing checker type for target`);
  }
  const targetWasmType = mapCheckerTypeToWasmType(ctx, targetCheckerType);

  let sourceWasmType: number[] | undefined;
  if (sourceCheckerType) {
    try {
      sourceWasmType = mapCheckerTypeToWasmType(ctx, sourceCheckerType);
    } catch {
      // Ignore inference errors, just don't optimize
    }
  }

  // No-op cast: same WASM representation
  if (sourceWasmType && typesAreEqual(sourceWasmType, targetWasmType)) {
    return;
  }

  // Primitive conversions (need WASM types for opcode selection)
  if (
    sourceWasmType &&
    sourceWasmType.length === 1 &&
    targetWasmType.length === 1
  ) {
    const src = sourceWasmType[0];
    const tgt = targetWasmType[0];

    if (src === ValType.i32 && tgt === ValType.i64) {
      body.push(Opcode.i64_extend_i32_s);
      return;
    }
    if (src === ValType.i64 && tgt === ValType.i32) {
      body.push(Opcode.i32_wrap_i64);
      return;
    }
    if (src === ValType.f32 && tgt === ValType.f64) {
      body.push(Opcode.f64_promote_f32);
      return;
    }
    if (src === ValType.f64 && tgt === ValType.f32) {
      body.push(Opcode.f32_demote_f64);
      return;
    }
    // i32 -> f32
    if (src === ValType.i32 && tgt === ValType.f32) {
      body.push(Opcode.f32_convert_i32_s);
      return;
    }
    // i32 -> f64
    if (src === ValType.i32 && tgt === ValType.f64) {
      body.push(Opcode.f64_convert_i32_s);
      return;
    }
    // i64 -> f32
    if (src === ValType.i64 && tgt === ValType.f32) {
      body.push(Opcode.f32_convert_i64_s);
      return;
    }
    // i64 -> f64
    if (src === ValType.i64 && tgt === ValType.f64) {
      body.push(Opcode.f64_convert_i64_s);
      return;
    }
    // f32 -> i32
    if (src === ValType.f32 && tgt === ValType.i32) {
      body.push(Opcode.i32_trunc_f32_s);
      return;
    }
    // f64 -> i32
    if (src === ValType.f64 && tgt === ValType.i32) {
      body.push(Opcode.i32_trunc_f64_s);
      return;
    }
    // f32 -> i64
    if (src === ValType.f32 && tgt === ValType.i64) {
      body.push(Opcode.i64_trunc_f32_s);
      return;
    }
    // f64 -> i64
    if (src === ValType.f64 && tgt === ValType.i64) {
      body.push(Opcode.i64_trunc_f64_s);
      return;
    }
  }

  // Interface Boxing - use checker types for all lookups
  if (targetCheckerType?.kind === TypeKind.Interface) {
    const interfaceInfo = ctx.getInterfaceInfo(
      targetCheckerType as InterfaceType,
    );
    if (!interfaceInfo) {
      throw new Error(
        `Interface not registered: ${(targetCheckerType as InterfaceType).name}`,
      );
    }

    let classInfo: ClassInfo | undefined;

    // Primary: look up ClassInfo via checker type identity
    if (sourceCheckerType) {
      if (sourceCheckerType.kind === TypeKind.Class) {
        // Ensure we use the interned version of the classType for identity-based lookup
        let classType = sourceCheckerType as ClassType;
        if (
          classType.genericSource &&
          classType.typeArguments &&
          classType.typeArguments.length > 0
        ) {
          const interned = ctx.checkerContext.getInternedClass(
            classType.genericSource,
            classType.typeArguments,
          );
          if (interned) {
            classType = interned;
          }
        }
        classInfo = ctx.getClassInfo(classType);
        // If identity lookup fails, trigger instantiation and retry
        if (
          !classInfo &&
          classType.typeArguments &&
          classType.typeArguments.length > 0
        ) {
          mapCheckerTypeToWasmType(ctx, classType);
          classInfo = ctx.getClassInfo(classType);
        }
      }

      // Extension class lookup by onType (checker type identity)
      if (!classInfo) {
        const extensions = ctx.getExtensionClassesByOnType(sourceCheckerType);
        if (extensions && extensions.length > 0) {
          classInfo = extensions[0];
        }
      }

      // On-demand FixedArray instantiation for raw array types
      if (!classInfo && sourceCheckerType.kind === TypeKind.Array) {
        const arrType = sourceCheckerType as import('../types.js').ArrayType;
        if (arrType.elementType.kind !== TypeKind.TypeParameter) {
          classInfo = resolveFixedArrayClass(ctx, sourceCheckerType);
        }
      }
    }

    if (classInfo && classInfo.implements) {
      // Identity-based lookup: the map is now keyed by InterfaceType
      const targetInterface = targetCheckerType as InterfaceType;
      let impl = classInfo.implements.get(targetInterface);

      // If direct lookup fails, try to find by interface subtype
      if (!impl) {
        for (const [implInterface, implInfo] of classInfo.implements) {
          if (ctx.checkerContext.isInterfaceAssignableTo(implInterface, targetInterface)) {
            impl = implInfo;
            break;
          }
        }
      }

      if (impl) {
        // Box it!
        // Stack has instance (from generateExpression above)

        // 2. VTable
        body.push(
          Opcode.global_get,
          ...WasmModule.encodeSignedLEB128(impl.vtableGlobalIndex),
        );

        // 3. Struct New
        body.push(0xfb, GcOpcode.struct_new);
        body.push(
          ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
        );
        return;
      }
    }
  }

  // Unboxing: Any -> Primitive
  if (
    targetWasmType.length === 1 &&
    (targetWasmType[0] === ValType.i32 ||
      targetWasmType[0] === ValType.i64 ||
      targetWasmType[0] === ValType.f32 ||
      targetWasmType[0] === ValType.f64) &&
    sourceWasmType &&
    sourceWasmType.length === 1 &&
    sourceWasmType[0] === ValType.anyref
  ) {
    unboxPrimitive(ctx, targetWasmType, body);
    return;
  }

  // If target is a reference type (ref null ...)
  if (targetWasmType.length > 1 && targetWasmType[0] === ValType.ref_null) {
    // ref.cast_null
    body.push(0xfb, GcOpcode.ref_cast_null);
    // The rest of targetWasmType is the LEB128 encoded type index
    body.push(...targetWasmType.slice(1));
  }
}

function generateIsExpression(
  ctx: CodegenContext,
  expr: IsExpression,
  body: number[],
) {
  const sourceType = inferType(ctx, expr.expression);
  // Require checker-based type resolution
  const targetCheckerType = expr.typeAnnotation.inferredType;
  if (!targetCheckerType) {
    throw new Error(`IsExpression missing checker type for target`);
  }
  const targetType = mapCheckerTypeToWasmType(ctx, targetCheckerType);

  // Handle primitive source types
  if (
    sourceType.length === 1 &&
    sourceType[0] !== ValType.anyref &&
    sourceType[0] !== ValType.eqref &&
    sourceType[0] !== ValType.ref &&
    sourceType[0] !== ValType.ref_null
  ) {
    // Evaluate expression for side effects
    generateExpression(ctx, expr.expression, body);
    body.push(Opcode.drop);

    // Check if types match
    if (typesAreEqual(sourceType, targetType)) {
      body.push(Opcode.i32_const, 1);
    } else if (targetType.length === 1 && targetType[0] === ValType.anyref) {
      // Primitive is assignable to any (via boxing), so 'is any' is true?
      // But 'is' usually checks exact type or subtype.
      // '10 is any' -> true.
      body.push(Opcode.i32_const, 1);
    } else {
      body.push(Opcode.i32_const, 0);
    }
    return;
  }

  generateExpression(ctx, expr.expression, body);

  // If target is a reference type (ref null ...)
  if (targetType.length > 1 && targetType[0] === ValType.ref_null) {
    const typeIndex = decodeTypeIndex(targetType);
    body.push(0xfb, GcOpcode.ref_test);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
  } else if (targetType.length > 1 && targetType[0] === ValType.ref) {
    const typeIndex = decodeTypeIndex(targetType);
    body.push(0xfb, GcOpcode.ref_test);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
  } else if (targetType.length === 1) {
    // Primitive type check (e.g. x is i32)
    // We check if it is an instance of Box<T>
    const checkerType = wasmTypeToCheckerType(targetType);
    const boxClass = getBoxClassInfo(ctx, checkerType);

    body.push(0xfb, GcOpcode.ref_test_null);
    body.push(...WasmModule.encodeSignedLEB128(boxClass.structTypeIndex));
  } else {
    throw new Error(`Unsupported type for 'is' check: ${targetType}`);
  }
}

/**
 * Get or create Box<T> ClassInfo for the given primitive type.
 * Uses the checker's type interning for proper identity-based lookups.
 */
function getBoxClassInfo(ctx: CodegenContext, primitiveType: Type): ClassInfo {
  const boxDecl = ctx.wellKnownTypes.Box;
  if (!boxDecl) throw new Error('Box class not found');

  // Get the checker's Box<T> generic class type
  const boxGenericType = boxDecl.inferredType as ClassType;
  if (!boxGenericType || boxGenericType.kind !== TypeKind.Class) {
    throw new Error('Box class missing inferredType');
  }

  // Use checker to instantiate Box<T> with proper interning
  const boxClassType = ctx.checkerContext.instantiateClass(boxGenericType, [
    primitiveType,
  ]);

  // Check if already instantiated in codegen
  let classInfo = ctx.getClassInfo(boxClassType);
  if (classInfo) {
    return classInfo;
  }

  // Need to instantiate - compute name from checker types
  const specializedName = getSpecializedName(
    boxDecl.name.name,
    boxClassType.typeArguments ?? [],
    ctx,
  );

  instantiateClass(
    ctx,
    boxDecl,
    specializedName,
    boxClassType, // Pass checker type directly - it contains all type info
  );

  // Use identity-based lookup to get the instantiated class
  return ctx.getClassInfo(boxClassType)!;
}

export function unboxPrimitive(
  ctx: CodegenContext,
  targetType: number[],
  body: number[],
) {
  // Stack: [anyref]

  // Convert WASM type to checker Type for identity-based lookup
  const checkerType = wasmTypeToCheckerType(targetType);
  const boxClass = getBoxClassInfo(ctx, checkerType);

  // Cast to Box<T>
  body.push(0xfb, GcOpcode.ref_cast_null);
  body.push(...WasmModule.encodeSignedLEB128(boxClass.structTypeIndex));

  // Get value
  const valueField = boxClass.fields.get(BOX_VALUE_FIELD);
  if (!valueField) throw new Error("Box class missing 'value' field");

  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(boxClass.structTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(valueField.index));
}

export function boxPrimitive(
  ctx: CodegenContext,
  sourceType: number[],
  body: number[],
) {
  // Stack: [primitive]

  // Convert WASM type to checker Type for identity-based lookup
  const checkerType = wasmTypeToCheckerType(sourceType);
  const boxClass = getBoxClassInfo(ctx, checkerType);

  // Use a local to save value.
  const tempVal = ctx.declareLocal('$$box_val', sourceType);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(tempVal));

  // Push vtable
  if (boxClass.vtableGlobalIndex !== undefined) {
    body.push(Opcode.global_get);
    body.push(...WasmModule.encodeSignedLEB128(boxClass.vtableGlobalIndex));
  } else {
    body.push(Opcode.ref_null, HeapType.none);
  }

  // Push value
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempVal));

  // struct.new
  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(boxClass.structTypeIndex));
}

/**
 * Convert a WASM primitive type to the corresponding checker Type.
 */
function wasmTypeToCheckerType(type: number[]): Type {
  if (type.length === 1) {
    if (type[0] === ValType.i32) return Types.I32;
    if (type[0] === ValType.i64) return Types.I64;
    if (type[0] === ValType.f32) return Types.F32;
    if (type[0] === ValType.f64) return Types.F64;
  }
  throw new Error(`Unsupported type for boxing: ${type}`);
}

export function inferType(ctx: CodegenContext, expr: Expression): number[] {
  // 1. Check CodegenContext for 'this' and Identifiers.
  // The CodegenContext reflects the *actual* storage types in the generated WASM,
  // which may differ from the Checker's inferred types in specific scenarios:
  // - Mixins: The AST for a mixin method has 'this' typed as the Mixin, but when
  //   compiled into a class, 'this' must be the Class type.
  // - Generics/Specialization: The context may have specialized types.
  // - Casts: We may have shadowed a variable with a downcasted version in the context.
  if (expr.type === NodeType.ThisExpression) {
    const local = ctx.getLocal('this');
    if (local) return local.type;
  }

  if (expr.type === NodeType.Identifier) {
    const ident = expr as Identifier;
    const local = ctx.getLocal(ident.name);
    if (local) {
      return local.type;
    }
    const global = ctx.getGlobal(ident.name);
    if (global) return global.type;
  }

  // Handle synthesized super() calls which are not visited by the checker
  if (expr.type === NodeType.CallExpression) {
    const callExpr = expr as CallExpression;
    if (callExpr.callee.type === NodeType.SuperExpression) {
      return []; // void
    }
  }

  // 2. Fallback to Checker's inferred type.
  // For most expressions, the static type inferred by the checker is correct.
  if (expr.inferredType) {
    let resolvedType = expr.inferredType;
    // When inside a generic context, the AST's inferredType may contain
    // unsubstituted type parameters. Resolve them to concrete types.
    if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
      resolvedType = ctx.checkerContext.substituteTypeParams(
        resolvedType,
        ctx.currentTypeArguments,
      );
    }
    return mapCheckerTypeToWasmType(ctx, resolvedType);
  }

  throw new Error(
    `Type inference failed: Node ${expr.type} has no inferred type.`,
  );
}

export function getHeapTypeIndex(ctx: CodegenContext, type: number[]): number {
  if (type.length < 2) return -1;
  if (type[0] !== ValType.ref && type[0] !== ValType.ref_null) return -1;
  return decodeTypeIndex(type);
}

function isStringType(ctx: CodegenContext, type: number[]): boolean {
  if (
    type.length < 2 ||
    (type[0] !== ValType.ref_null && type[0] !== ValType.ref)
  ) {
    return false;
  }
  const index = getHeapTypeIndex(ctx, type);
  return index === ctx.stringTypeIndex; // stringTypeIndex is now byteArrayTypeIndex
}

function getArrayTypeIndex(ctx: CodegenContext, elementType: number[]): number {
  return ctx.getArrayTypeIndex(elementType);
}

/**
 * Instantiate an extension class using the checker's ClassType.
 * This uses the checker-provided type information to create the ClassInfo,
 * avoiding the need for codegen to figure out the mapping (e.g., ArrayType -> FixedArray<T>).
 */
function instantiateExtensionClassFromCheckerType(
  ctx: CodegenContext,
  classType: ClassType,
): ClassInfo | undefined {
  // Get the generic class declaration using identity-based lookup
  const genericSource = classType.genericSource ?? classType;
  const genericDecl = ctx.getGenericDeclaration(genericSource);
  if (!genericDecl || !genericDecl.isExtension) {
    return undefined;
  }

  // Get specialized name from checker types
  const specializedName = getSpecializedName(
    genericDecl.name.name,
    classType.typeArguments ?? [],
    ctx,
  );

  // Instantiate the class with the checker's ClassType directly
  instantiateClass(
    ctx,
    genericDecl,
    specializedName,
    classType, // Pass the checker's ClassType - it contains all type info
  );

  // Use identity-based lookup to get the instantiated class
  return ctx.getClassInfo(classType);
}

function resolveFixedArrayClass(
  ctx: CodegenContext,
  checkerType: Type | undefined,
): ClassInfo | undefined {
  if (checkerType && checkerType.kind === TypeKind.Array) {
    const fixedArrayDecl = ctx.wellKnownTypes.FixedArray;
    if (!fixedArrayDecl) {
      // FixedArray must be registered in wellKnownTypes during stdlib loading
      return undefined;
    }

    if (fixedArrayDecl) {
      const arrayType = checkerType as import('../types.js').ArrayType;
      const elementType = arrayType.elementType;
      if (elementType) {
        // Get the checker's FixedArray<T> generic class type
        const fixedArrayGenericType = fixedArrayDecl.inferredType as ClassType;
        if (
          fixedArrayGenericType &&
          fixedArrayGenericType.kind === TypeKind.Class
        ) {
          // Use checker to instantiate FixedArray<T> with proper interning
          const fixedArrayClassType = ctx.checkerContext.instantiateClass(
            fixedArrayGenericType,
            [elementType],
          );

          // Check if already instantiated in codegen
          let classInfo = ctx.getClassInfo(fixedArrayClassType);
          if (classInfo) {
            return classInfo;
          }

          // Need to instantiate - compute name from checker types
          const specializedName = getSpecializedName(
            fixedArrayDecl.name.name,
            fixedArrayClassType.typeArguments ?? [],
            ctx,
          );

          instantiateClass(
            ctx,
            fixedArrayDecl,
            specializedName,
            fixedArrayClassType, // Pass checker type directly - it contains all type info
          );

          // Use identity-based lookup to get the instantiated class
          return ctx.getClassInfo(fixedArrayClassType);
        }
      }
    }
  }
  return undefined;
}

function generateArrayLiteral(
  ctx: CodegenContext,
  expr: ArrayLiteral,
  body: number[],
) {
  let typeIndex: number;

  if (expr.inferredType) {
    const wasmType = mapCheckerTypeToWasmType(ctx, expr.inferredType);
    typeIndex = decodeTypeIndex(wasmType);
  } else {
    // Fallback / Default to i32
    const elementType = [ValType.i32];
    typeIndex = getArrayTypeIndex(ctx, elementType);
  }

  if (expr.elements.length === 0) {
    body.push(0xfb, GcOpcode.array_new_fixed);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
    body.push(...WasmModule.encodeSignedLEB128(0));
    return;
  }

  for (const element of expr.elements) {
    generateExpression(ctx, element, body);
  }

  body.push(0xfb, GcOpcode.array_new_fixed);
  body.push(...WasmModule.encodeSignedLEB128(typeIndex));
  body.push(...WasmModule.encodeSignedLEB128(expr.elements.length));
}

function generateIndexExpression(
  ctx: CodegenContext,
  expr: IndexExpression,
  body: number[],
) {
  const objectType = inferType(ctx, expr.object);
  const structTypeIndex = getHeapTypeIndex(ctx, objectType);

  if (structTypeIndex !== -1) {
    let foundClass: ClassInfo | undefined;

    // Use identity-based lookup via checker type
    if (
      expr.object.inferredType &&
      expr.object.inferredType.kind === TypeKind.Class
    ) {
      let classType = expr.object.inferredType as ClassType;
      // When inside a generic context (e.g., generating Map<K,V>.set),
      // the AST's inferredType may be the unsubstituted FixedArray<Entry<K,V>>.
      // Substitute type parameters to get the concrete type (FixedArray<Entry<string,Box<i32>>>).
      if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
        classType = ctx.checkerContext.substituteTypeParams(
          classType,
          ctx.currentTypeArguments,
        ) as ClassType;
      }
      // Ensure we use the interned version for identity-based lookup
      if (
        classType.genericSource &&
        classType.typeArguments &&
        classType.typeArguments.length > 0
      ) {
        const interned = ctx.checkerContext.getInternedClass(
          classType.genericSource,
          classType.typeArguments,
        );
        if (interned) {
          classType = interned;
        }
      }
      foundClass = ctx.getClassInfo(classType);

      // If identity lookup failed, instantiate via mapCheckerTypeToWasmType and retry
      if (
        !foundClass &&
        classType.typeArguments &&
        classType.typeArguments.length > 0
      ) {
        mapCheckerTypeToWasmType(ctx, classType);
        foundClass = ctx.getClassInfo(classType);
      }
    }

    // Check for extension classes (e.g., FixedArray on array<T>) using O(1) lookup
    if (!foundClass && expr.object.inferredType) {
      const extensions = ctx.getExtensionClassesByOnType(
        expr.object.inferredType,
      );
      if (extensions && extensions.length > 0) {
        foundClass = extensions[0];
      }
    }

    // If still not found and this is a concrete array type, try to instantiate FixedArray
    // This ensures FixedArray<T> is created on-demand for array literals
    // We must NOT do this for abstract types (TypeParameter) - those are handled during
    // instantiation when the type parameter gets substituted with a concrete type
    if (!foundClass && expr.object.inferredType) {
      let objType = expr.object.inferredType;
      // Substitute type parameters to get concrete array element type
      if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
        objType = ctx.checkerContext.substituteTypeParams(
          objType,
          ctx.currentTypeArguments,
        );
      }
      if (objType.kind === TypeKind.Array) {
        const arrType = objType as import('../types.js').ArrayType;
        // Only instantiate if element type is concrete (not a type parameter)
        if (arrType.elementType.kind !== TypeKind.TypeParameter) {
          foundClass = resolveFixedArrayClass(ctx, objType);
        }
      }
    }

    if (foundClass) {
      const methodInfo = foundClass.methods.get('[]');
      if (methodInfo) {
        if (
          (methodInfo.intrinsic === 'array.get' ||
            methodInfo.intrinsic === 'array.get_u') &&
          foundClass.isExtension &&
          foundClass.onType
        ) {
          // Decode array type index from onType
          let arrayTypeIndex = 0;
          let shift = 0;
          for (let i = 1; i < foundClass.onType.length; i++) {
            const byte = foundClass.onType[i];
            arrayTypeIndex |= (byte & 0x7f) << shift;
            shift += 7;
            if ((byte & 0x80) === 0) break;
          }

          generateExpression(ctx, expr.object, body);
          generateExpression(ctx, expr.index, body);
          body.push(
            0xfb,
            methodInfo.intrinsic === 'array.get_u'
              ? GcOpcode.array_get_u
              : GcOpcode.array_get,
          );
          body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));
          return;
        }

        if (methodInfo.index === -1) {
          throw new Error(
            `Calling invalid getter index -1 for ${foundClass.name}.[] intrinsic=${methodInfo.intrinsic}`,
          );
        }

        generateExpression(ctx, expr.object, body);
        generateExpression(ctx, expr.index, body);
        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
        return;
      }
    }

    if (!foundClass) {
      // Identity-based lookup for interface
      let interfaceInfo: InterfaceInfo | undefined;
      if (
        expr.object.inferredType &&
        expr.object.inferredType.kind === TypeKind.Interface
      ) {
        interfaceInfo = ctx.getInterfaceInfo(
          expr.object.inferredType as InterfaceType,
        );
        if (!interfaceInfo) {
          throw new Error(
            `Interface not registered: ${(expr.object.inferredType as InterfaceType).name}`,
          );
        }
      }

      if (interfaceInfo) {
        const methodInfo = interfaceInfo.methods.get('[]');
        if (methodInfo) {
          // Generate interface call
          // Stack: [InterfaceStruct]
          generateExpression(ctx, expr.object, body);

          // Store in temp local
          const tempLocal = ctx.declareLocal(
            '$$interface_temp_get',
            objectType,
          );
          body.push(
            Opcode.local_tee,
            ...WasmModule.encodeSignedLEB128(tempLocal),
          );

          // Load VTable
          body.push(
            0xfb,
            GcOpcode.struct_get,
            ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
            ...WasmModule.encodeSignedLEB128(1),
          );

          // Load Function Pointer
          body.push(
            0xfb,
            GcOpcode.struct_get,
            ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
            ...WasmModule.encodeSignedLEB128(methodInfo.index),
          );

          // Cast to specific function type
          body.push(
            0xfb,
            GcOpcode.ref_cast_null,
            ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
          );

          // Store function ref in temp local
          const funcRefType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
          ];
          const funcRefLocal = ctx.declareLocal(
            '$$interface_func_get',
            funcRefType,
          );
          body.push(
            Opcode.local_set,
            ...WasmModule.encodeSignedLEB128(funcRefLocal),
          );

          // Load Instance (this)
          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(tempLocal),
          );
          body.push(
            0xfb,
            GcOpcode.struct_get,
            ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
            ...WasmModule.encodeSignedLEB128(0),
          );

          // Evaluate index
          generateExpression(ctx, expr.index, body);

          // Load function ref
          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(funcRefLocal),
          );

          // Call Ref
          body.push(
            Opcode.call_ref,
            ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
          );

          // Unbox if needed
          const expectedType = inferType(ctx, expr);
          if (
            methodInfo.returnType.length === 1 &&
            methodInfo.returnType[0] === ValType.anyref
          ) {
            if (
              expectedType.length === 1 &&
              (expectedType[0] === ValType.i32 ||
                expectedType[0] === ValType.i64 ||
                expectedType[0] === ValType.f32 ||
                expectedType[0] === ValType.f64)
            ) {
              unboxPrimitive(ctx, expectedType, body);
            } else if (
              expectedType.length > 1 &&
              (expectedType[0] === ValType.ref ||
                expectedType[0] === ValType.ref_null)
            ) {
              body.push(0xfb, GcOpcode.ref_cast_null);
              body.push(...expectedType.slice(1));
            }
          }

          return;
        }
      }
    }

    // Check if it's a Tuple
    let tupleKey: string | undefined;
    for (const [key, index] of ctx.tupleTypes) {
      if (index === structTypeIndex) {
        tupleKey = key;
        break;
      }
    }

    if (tupleKey) {
      if (expr.index.type !== NodeType.NumberLiteral) {
        throw new Error('Tuple index must be a constant number');
      }
      const index = (expr.index as NumberLiteral).value;

      const types = tupleKey.split(';');
      if (index < 0 || index >= types.length) {
        throw new Error(`Tuple index out of bounds: ${index}`);
      }

      generateExpression(ctx, expr.object, body);
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(index));
      return;
    }
  }

  let arrayTypeIndex = -1;
  if (expr.object.type === NodeType.Identifier) {
    const localInfo = ctx.getLocal((expr.object as Identifier).name);
    if (
      localInfo &&
      localInfo.type.length > 1 &&
      (localInfo.type[0] === ValType.ref_null ||
        localInfo.type[0] === ValType.ref)
    ) {
      arrayTypeIndex = localInfo.type[1];
    }
  }

  if (arrayTypeIndex === -1) {
    // Try to infer from objectType if it's an array
    if (
      objectType.length > 1 &&
      (objectType[0] === ValType.ref || objectType[0] === ValType.ref_null)
    ) {
      // Check if it is a known array type
      // This is tricky because array types are just indices.
      // But we can assume if it's not a class struct, it might be an array.
      // However, we default to i32 array if we can't find it.
      // Let's just use the type index from objectType if available.
      arrayTypeIndex = decodeTypeIndex(objectType);
    } else {
      throw new Error('Could not determine array type for index expression');
    }
  }
  if (arrayTypeIndex !== -1 && arrayTypeIndex !== ctx.byteArrayTypeIndex) {
    const intrinsic = findArrayIntrinsic(ctx, '[]');
    if (intrinsic) {
      generateIntrinsic(ctx, intrinsic, expr.object, [expr.index], body);

      const elementType = ctx.module.getArrayElementType(arrayTypeIndex);
      if (elementType.length === 1 && elementType[0] === ValType.anyref) {
        const expectedType = inferType(ctx, expr);
        if (
          expectedType.length > 1 &&
          (expectedType[0] === ValType.ref ||
            expectedType[0] === ValType.ref_null)
        ) {
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(...expectedType.slice(1));
        }
      }
      return;
    }
  }

  generateExpression(ctx, expr.object, body);

  if (arrayTypeIndex === ctx.byteArrayTypeIndex) {
    generateExpression(ctx, expr.index, body);
    body.push(0xfb, GcOpcode.array_get_u);
    body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));
  } else {
    // Should be handled by intrinsic above, but if not found (e.g. bootstrapping issues), fallback
    // Or maybe we should throw?
    // For now, let's throw if not handled, to ensure we are using intrinsics.
    throw new Error('Array index access requires intrinsic operator []');
  }
}

function generateNewExpression(
  ctx: CodegenContext,
  expr: NewExpression,
  body: number[],
) {
  const className = expr.callee.name;
  let classInfo: ClassInfo | undefined;

  // Try identity-based lookup first using the checker's interned ClassType
  if (expr.inferredType && expr.inferredType.kind === TypeKind.Class) {
    let classType = expr.inferredType as ClassType;
    // When inside a generic context (e.g., generating Array<SuiteResult>.from),
    // the AST's inferredType may be the unsubstituted Array<T>.
    // Substitute type parameters to get the concrete type (Array<SuiteResult>).
    if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
      classType = ctx.checkerContext.substituteTypeParams(
        classType,
        ctx.currentTypeArguments,
      ) as ClassType;
    }
    classInfo = ctx.getClassInfo(classType);

    // If identity lookup failed, instantiate via mapCheckerTypeToWasmType
    if (!classInfo) {
      mapCheckerTypeToWasmType(ctx, classType);
      classInfo = ctx.getClassInfo(classType);
    }
  }

  // No fallback - require inferredType for class resolution
  if (!classInfo) {
    throw new Error(
      `Class ${className} not found - missing inferredType on NewExpression`,
    );
  }

  if (classInfo.isExtension && classInfo.onType) {
    // Extension class instantiation
    const ctor = classInfo.methods.get('#new');
    if (ctor) {
      for (const arg of expr.arguments) {
        generateExpression(ctx, arg, body);
      }
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(ctor.index));
      return;
    }

    // Fallback for array extensions without explicit constructor (e.g. new IntArray(10))
    // This should probably be deprecated in favor of explicit constructors or intrinsics
    const typeIndex = decodeTypeIndex(classInfo.onType);

    if (expr.arguments.length !== 1) {
      throw new Error(
        `Extension class instantiation expects 1 argument (length)`,
      );
    }

    generateExpression(ctx, expr.arguments[0], body);
    body.push(0xfb, GcOpcode.array_new_default);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
    return;
  }

  // Allocate struct with default values
  body.push(0xfb, GcOpcode.struct_new_default);
  body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));

  // Store ref in temp local to return it later and pass to constructor
  const type = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
  ];
  const tempLocal = ctx.declareLocal('$$temp_new', type);
  body.push(Opcode.local_tee);
  body.push(...WasmModule.encodeSignedLEB128(tempLocal));

  // Initialize vtable
  if (classInfo.vtableGlobalIndex !== undefined) {
    body.push(Opcode.global_get);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.vtableGlobalIndex));
    body.push(0xfb, GcOpcode.struct_set);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(0)); // vtable is always at index 0

    // Restore object for constructor
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(tempLocal));
  }

  // Get constructor parameter types for adaptation
  const ctorInfo = classInfo.methods.get('#new');
  let ctorParams: number[][] | undefined;
  if (ctorInfo !== undefined) {
    ctorParams = ctx.module.getFunctionTypeParams(ctorInfo.typeIndex);
    // params[0] is 'this'
  }

  // Prepare args for constructor: [this, args...]
  for (let i = 0; i < expr.arguments.length; i++) {
    const arg = expr.arguments[i];
    if (ctorParams && i + 1 < ctorParams.length) {
      // Adapt argument to expected type (skip 'this' at index 0)
      generateAdaptedArgument(ctx, arg, ctorParams[i + 1], body);
    } else {
      generateExpression(ctx, arg, body);
    }
  }

  // Call constructor
  if (ctorInfo !== undefined) {
    body.push(Opcode.call);
    if (ctorInfo.index === -1)
      throw new Error(`Calling invalid constructor index -1 for ${className}`);
    body.push(...WasmModule.encodeSignedLEB128(ctorInfo.index));
  }

  // Return the instance
  body.push(Opcode.local_get);
  body.push(...WasmModule.encodeSignedLEB128(tempLocal));
}

function generateMemberExpression(
  ctx: CodegenContext,
  expr: MemberExpression,
  body: number[],
) {
  // Try to use the resolved binding from the checker for O(1) lookup
  const binding = ctx.semanticContext.getResolvedBinding(expr);

  if (binding) {
    const memberBinding = binding as
      | FieldBinding
      | GetterBinding
      | MethodBinding
      | RecordFieldBinding;
    if (
      memberBinding.kind === 'field' ||
      memberBinding.kind === 'getter' ||
      memberBinding.kind === 'method' ||
      memberBinding.kind === 'record-field'
    ) {
      if (generateMemberFromBinding(ctx, memberBinding, expr.object, body)) {
        return;
      }
      // If binding-based codegen returns false, fall back to AST-based codegen below.
      // This happens for:
      // - Method access (handled at call site, not as a value)
      // - Static field access like `ClassName.field` (uses globals, not struct.get)
    }
  }

  // Check for static member access using the object's binding
  // If the object identifier resolves to a ClassBinding, this is static access
  if (expr.object.type === NodeType.Identifier) {
    const objectBinding = ctx.semanticContext.getResolvedBinding(
      expr.object as Identifier,
    );
    const resolvedObjectBinding = objectBinding
      ? resolveImport(objectBinding)
      : undefined;

    // Only treat as static if it's a class binding AND not a local variable shadowing it
    if (
      resolvedObjectBinding?.kind === 'class' &&
      !ctx.getLocal((expr.object as Identifier).name)
    ) {
      const classBinding = resolvedObjectBinding as ClassBinding;
      const className = classBinding.declaration.name.name;

      const fieldName = expr.property.name;
      const mangledName = `${className}_${fieldName}`;
      const global = ctx.getGlobal(mangledName);
      if (global) {
        body.push(Opcode.global_get);
        body.push(...WasmModule.encodeSignedLEB128(global.index));
        return;
      }
    }
  }

  const objectType = inferType(ctx, expr.object);

  // Handle array/string length
  if (expr.property.name === 'length') {
    const isString = isStringType(ctx, objectType);

    if (isString) {
      generateExpression(ctx, expr.object, body);
      body.push(0xfb, GcOpcode.array_len);
      return;
    }

    const isArray = Array.from(ctx.arrayTypes.values()).includes(objectType[1]);

    if (isArray) {
      const intrinsic = findArrayIntrinsic(ctx, 'length');
      if (intrinsic) {
        generateIntrinsic(ctx, intrinsic, expr.object, [], body);
        return;
      }
      throw new Error('Array length access requires intrinsic');
    }
  }

  // If we reach here, the binding-based codegen didn't handle this member access.
  // This is an error - all member access should go through bindings.
  const fieldName = expr.property.name;
  const bindingInfo = binding
    ? `binding kind=${(binding as any).kind}`
    : 'no binding';
  throw new Error(
    `Member access for '${fieldName}' not handled by bindings. ${bindingInfo}. ` +
      `This may indicate a missing binding in the checker.`,
  );
}

function generateThisExpression(
  ctx: CodegenContext,
  expr: ThisExpression,
  body: number[],
) {
  let local;
  for (let i = ctx.scopes.length - 1; i >= 0; i--) {
    if (ctx.scopes[i].has('this')) {
      local = ctx.scopes[i].get('this');
      break;
    }
  }
  if (local) {
    // Found 'this' in scope
  } else {
    // Not found in scope, assume it's the implicit 'this' local
  }
  body.push(Opcode.local_get);
  body.push(...WasmModule.encodeSignedLEB128(ctx.thisLocalIndex));
}

function generateCallExpression(
  ctx: CodegenContext,
  expr: CallExpression,
  body: number[],
) {
  if ((expr.callee as any).type === NodeType.SuperExpression) {
    if (ctx.currentClass && ctx.currentClass.isExtension) {
      // Extension class super call: super(array_instance)
      // Evaluate argument (should be 1 argument)
      if (expr.arguments.length !== 1) {
        throw new Error(
          'Extension class super call must have exactly 1 argument',
        );
      }
      generateExpression(ctx, expr.arguments[0], body);
      // Set 'this' local
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeSignedLEB128(ctx.thisLocalIndex));
      return;
    }

    if (ctx.currentClass && ctx.currentClass.superClass) {
      // Normal class super call - identity-based lookup
      if (!ctx.currentClass.superClassType) {
        throw new Error(
          `superClassType not set for ${ctx.currentClass.name} (superClass: ${ctx.currentClass.superClass})`,
        );
      }
      const superClassInfo = ctx.getClassInfo(ctx.currentClass.superClassType);
      if (!superClassInfo) {
        throw new Error(
          `Super class not found for ${ctx.currentClass.name} via identity lookup (superClass: ${ctx.currentClass.superClass})`,
        );
      }
      const ctorInfo = superClassInfo.methods.get('#new');
      if (!ctorInfo) {
        // Implicit super call to no-arg constructor?
        // If explicit super() is called but no constructor exists, it's an error unless implicit one exists.
        // But here we assume it exists if super() is called.
        throw new Error(
          `Super constructor not found for ${ctx.currentClass.name}`,
        );
      }
      // Load 'this'
      body.push(Opcode.local_get, 0);
      // Args
      for (const arg of expr.arguments) {
        generateExpression(ctx, arg, body);
      }
      // Call super constructor
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(ctorInfo.index));
      return;
    }
    return;
  }

  if (expr.callee.type === NodeType.Identifier) {
  }

  if (expr.callee.type === NodeType.MemberExpression) {
    const memberExpr = expr.callee as MemberExpression;
    const methodName = memberExpr.property.name;

    if (memberExpr.object.type === NodeType.SuperExpression) {
      // Super method call (Static Dispatch)
      if (!ctx.currentClass || !ctx.currentClass.superClass) {
        throw new Error('Super call outside of class with superclass');
      }
      // Identity-based lookup (no fallback)
      if (!ctx.currentClass.superClassType) {
        throw new Error(
          `superClassType not set for ${ctx.currentClass.name} (superClass: ${ctx.currentClass.superClass})`,
        );
      }
      const superClassInfo = ctx.getClassInfo(ctx.currentClass.superClassType);
      if (!superClassInfo) {
        throw new Error(
          `Super class not found for ${ctx.currentClass.name} via identity lookup`,
        );
      }
      const methodInfo = superClassInfo.methods.get(methodName);
      if (!methodInfo) {
        throw new Error(`Method ${methodName} not found in superclass`);
      }

      // Load 'this'
      body.push(Opcode.local_get, 0);

      // Args
      for (const arg of expr.arguments) {
        generateExpression(ctx, arg, body);
      }

      // Static Call
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
      return;
    }

    // Check for static method call using the object's binding
    // If the object identifier resolves to a ClassBinding (and is not shadowed by a local),
    // this is a static method call like `ClassName.method()`
    if (memberExpr.object.type === NodeType.Identifier) {
      const objectBinding = ctx.semanticContext.getResolvedBinding(
        memberExpr.object as Identifier,
      );
      const resolvedObjectBinding = objectBinding
        ? resolveImport(objectBinding)
        : undefined;

      // Only treat as static if it's a class binding AND not a local variable shadowing it
      if (
        resolvedObjectBinding?.kind === 'class' &&
        !ctx.getLocal((memberExpr.object as Identifier).name)
      ) {
        const classBinding = resolvedObjectBinding as ClassBinding;
        const classType = classBinding.type;
        const className = classBinding.declaration.name.name;

        // Use identity-based lookup for ClassInfo (no fallback)
        const classInfo = ctx.getClassInfo(classType);
        if (!classInfo) {
          throw new Error(
            `Static method call: class ${className} not found via identity lookup`,
          );
        }

        const methodInfo = classInfo.methods.get(methodName);
        if (methodInfo) {
          // Static method call
          for (const arg of expr.arguments) {
            generateExpression(ctx, arg, body);
          }
          body.push(Opcode.call);
          body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
          return;
        }
      }
    }

    const objectType = inferType(ctx, memberExpr.object);

    // Check if interface - identity-based lookup
    let interfaceInfo: InterfaceInfo | undefined;
    if (
      memberExpr.object.inferredType &&
      memberExpr.object.inferredType.kind === TypeKind.Interface
    ) {
      interfaceInfo = ctx.getInterfaceInfo(
        memberExpr.object.inferredType as InterfaceType,
      );
      if (!interfaceInfo) {
        throw new Error(
          `Interface not registered: ${(memberExpr.object.inferredType as InterfaceType).name}`,
        );
      }
    }

    if (interfaceInfo) {
      const methodInfo = interfaceInfo.methods.get(methodName);
      if (!methodInfo)
        throw new Error(`Method ${methodName} not found in interface`);

      // Evaluate object -> Stack: [InterfaceStruct]
      generateExpression(ctx, memberExpr.object, body);

      // Store in temp local
      const tempLocal = ctx.declareLocal('$$interface_temp', objectType);
      body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempLocal));

      // Load VTable
      body.push(
        0xfb,
        GcOpcode.struct_get,
        ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
        ...WasmModule.encodeSignedLEB128(1),
      );

      // Load Function Pointer
      body.push(
        0xfb,
        GcOpcode.struct_get,
        ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
        ...WasmModule.encodeSignedLEB128(methodInfo.index),
      );

      // Cast to specific function type
      body.push(
        0xfb,
        GcOpcode.ref_cast_null,
        ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
      );

      // Store function ref in temp local
      const funcRefType = [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
      ];
      const funcRefLocal = ctx.declareLocal('$$interface_func', funcRefType);
      body.push(
        Opcode.local_set,
        ...WasmModule.encodeSignedLEB128(funcRefLocal),
      );

      // Load Instance (this)
      body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempLocal));
      body.push(
        0xfb,
        GcOpcode.struct_get,
        ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
        ...WasmModule.encodeSignedLEB128(0),
      );

      // Args
      const params = ctx.module.getFunctionTypeParams(methodInfo.typeIndex);
      // params[0] is 'this' (interface instance)

      for (let i = 0; i < expr.arguments.length; i++) {
        const arg = expr.arguments[i];
        const expectedType = params[i + 1];
        generateAdaptedArgument(ctx, arg, expectedType, body);
      }

      // Load function ref
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(funcRefLocal),
      );

      // Call Ref
      body.push(
        Opcode.call_ref,
        ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
      );

      // Handle return value adaptation (unbox)
      if (expr.inferredType) {
        const expectedType = mapCheckerTypeToWasmType(ctx, expr.inferredType);
        const actualType = methodInfo.returnType;

        if (actualType.length === 1 && actualType[0] === ValType.anyref) {
          if (
            expectedType.length === 1 &&
            (expectedType[0] === ValType.i32 ||
              expectedType[0] === ValType.i64 ||
              expectedType[0] === ValType.f32 ||
              expectedType[0] === ValType.f64)
          ) {
            unboxPrimitive(ctx, expectedType, body);
          } else if (
            expectedType.length > 1 &&
            (expectedType[0] === ValType.ref ||
              expectedType[0] === ValType.ref_null)
          ) {
            body.push(0xfb, GcOpcode.ref_cast_null);
            body.push(...expectedType.slice(1));
          }
        }
      }
      return;
    }

    const structTypeIndex = getHeapTypeIndex(ctx, objectType);

    let foundClass: ClassInfo | undefined;

    // Try to get the class from the method binding (most reliable for extension classes)
    // The binding's classType is the instantiated type (e.g., FixedArray<i32>) not generic
    const calleeBinding = ctx.semanticContext.getResolvedBinding(memberExpr);
    if (calleeBinding && calleeBinding.kind === 'method') {
      const methodBinding = calleeBinding as MethodBinding;
      if (methodBinding.classType.kind === TypeKind.Class) {
        let bindingClassType = methodBinding.classType;
        // When inside a generic context (e.g., generating Array<SuiteResult>.from),
        // the binding's classType may be the unsubstituted Array<T>.
        // Substitute type parameters to get the concrete type.
        if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
          bindingClassType = ctx.checkerContext.substituteTypeParams(
            bindingClassType,
            ctx.currentTypeArguments,
          ) as ClassType;
        }
        foundClass = ctx.getClassInfo(bindingClassType);
        // If not found and this is an extension class, instantiate it now
        if (!foundClass && bindingClassType.isExtension) {
          foundClass = instantiateExtensionClassFromCheckerType(
            ctx,
            bindingClassType,
          );
        }
      }
    }

    // Use identity-based lookup via object's checker type
    if (
      !foundClass &&
      memberExpr.object.inferredType &&
      memberExpr.object.inferredType.kind === TypeKind.Class
    ) {
      let classType = memberExpr.object.inferredType as ClassType;
      // When inside a generic context (e.g., generating Array<SuiteResult>.from),
      // the AST's inferredType may still be the unsubstituted Array<T>.
      // Substitute type parameters to get the concrete type (Array<SuiteResult>).
      if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
        classType = ctx.checkerContext.substituteTypeParams(
          classType,
          ctx.currentTypeArguments,
        ) as ClassType;
      }
      // Ensure we use the interned version for identity-based lookup
      if (
        classType.genericSource &&
        classType.typeArguments &&
        classType.typeArguments.length > 0
      ) {
        const interned = ctx.checkerContext.getInternedClass(
          classType.genericSource,
          classType.typeArguments,
        );
        if (interned) {
          classType = interned;
        }
      }
      foundClass = ctx.getClassInfo(classType);

      // If identity lookup failed, instantiate via mapCheckerTypeToWasmType and retry
      if (
        !foundClass &&
        classType.typeArguments &&
        classType.typeArguments.length > 0
      ) {
        mapCheckerTypeToWasmType(ctx, classType);
        foundClass = ctx.getClassInfo(classType);
      }
    }

    // Check for extension classes using O(1) lookup via checker type
    if (!foundClass && memberExpr.object.inferredType) {
      let lookupType = memberExpr.object.inferredType;
      // Substitute type parameters if we're in a generic context
      if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
        lookupType = ctx.checkerContext.substituteTypeParams(
          lookupType,
          ctx.currentTypeArguments,
        );
      }
      const extensions = ctx.getExtensionClassesByOnType(lookupType);
      if (extensions && extensions.length > 0) {
        foundClass = extensions[0];
      }
    }

    // Look up extension class by WASM valtype (handles primitive types like i32)
    if (!foundClass && objectType.length === 1) {
      const extensions = ctx.getExtensionClassesByWasmValType(objectType[0]);
      if (extensions && extensions.length > 0) {
        foundClass = extensions[0];
      }
    }

    if (!foundClass) {
      // Special handling for FixedArray: treat array<T> as FixedArray<T>
      let arrayType = expr.callee.object.inferredType;
      // Substitute type parameters to get concrete array element type
      if (
        arrayType &&
        ctx.currentTypeArguments.size > 0 &&
        ctx.checkerContext
      ) {
        arrayType = ctx.checkerContext.substituteTypeParams(
          arrayType,
          ctx.currentTypeArguments,
        );
      }
      foundClass = resolveFixedArrayClass(ctx, arrayType);
    }

    if (!foundClass) {
      throw new Error(
        `Class not found for object type ${structTypeIndex} (full type: ${objectType})`,
      );
    }

    let methodInfo = foundClass.methods.get(methodName);

    if (methodInfo === undefined) {
      // Check if it's a generic method call
      const originalClassName = foundClass.originalName || foundClass.name;
      let genericKey = `${originalClassName}.${methodName}`;

      if (!ctx.genericMethods.has(genericKey) && foundClass.originalName) {
        genericKey = `${foundClass.name}.${methodName}`;
      }

      if (ctx.genericMethods.has(genericKey)) {
        // Use inferredTypeArguments (Type[]) directly if available
        const checkerTypeArgs = expr.inferredTypeArguments;

        if (checkerTypeArgs && checkerTypeArgs.length > 0) {
          methodInfo = instantiateGenericMethod(
            ctx,
            foundClass,
            methodName,
            checkerTypeArgs,
          );
        }
      }
    }

    // If method not found, check if it's a field with function type
    if (methodInfo === undefined) {
      const fieldInfo = foundClass.fields.get(methodName);
      if (fieldInfo) {
        // This is a field with function type - generate field access and call_ref
        // Get the function type index from the field type
        const fieldType = fieldInfo.type;

        // Check if field type is a function reference
        if (
          fieldType.length >= 2 &&
          (fieldType[0] === ValType.ref || fieldType[0] === ValType.ref_null)
        ) {
          const fieldTypeIndex = decodeTypeIndex(fieldType);

          // Check if this is a closure type
          const closureInfo = ctx.closureStructs.get(fieldTypeIndex);

          if (closureInfo) {
            // Field is a closure - need to call it properly

            // Get object (this)
            generateExpression(ctx, memberExpr.object, body);

            // Downcast if needed (for anyref case)
            const isAnyRef =
              objectType.length === 1 && objectType[0] === ValType.anyref;
            if (isAnyRef) {
              body.push(0xfb, GcOpcode.ref_cast_null);
              body.push(
                ...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex),
              );
            }

            // Get field (closure struct reference)
            body.push(0xfb, GcOpcode.struct_get);
            body.push(
              ...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex),
            );
            body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

            // Store closure in temp local
            const closureLocal = ctx.declareLocal('$$field_closure', fieldType);
            body.push(
              Opcode.local_set,
              ...WasmModule.encodeSignedLEB128(closureLocal),
            );

            // Load context (field 1 of closure struct)
            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(closureLocal),
            );
            body.push(0xfb, GcOpcode.struct_get);
            body.push(...WasmModule.encodeSignedLEB128(fieldTypeIndex));
            body.push(...WasmModule.encodeSignedLEB128(1)); // context field

            // Generate arguments
            const params = ctx.module.getFunctionTypeParams(
              closureInfo.funcTypeIndex,
            );
            // params[0] is context
            for (let i = 0; i < expr.arguments.length; i++) {
              const arg = expr.arguments[i];
              const expectedType = params[i + 1];
              generateAdaptedArgument(ctx, arg, expectedType, body);
            }

            // Load function pointer (field 0 of closure struct)
            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(closureLocal),
            );
            body.push(0xfb, GcOpcode.struct_get);
            body.push(...WasmModule.encodeSignedLEB128(fieldTypeIndex));
            body.push(...WasmModule.encodeSignedLEB128(0)); // function field

            // Call function
            body.push(Opcode.call_ref);
            body.push(
              ...WasmModule.encodeSignedLEB128(closureInfo.funcTypeIndex),
            );
            return;
          } else {
            // Direct function reference (not a closure)
            // Get object (this)
            generateExpression(ctx, memberExpr.object, body);

            // Downcast if needed (for anyref case)
            const isAnyRef =
              objectType.length === 1 && objectType[0] === ValType.anyref;
            if (isAnyRef) {
              body.push(0xfb, GcOpcode.ref_cast_null);
              body.push(
                ...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex),
              );
            }

            // Get field (function reference)
            body.push(0xfb, GcOpcode.struct_get);
            body.push(
              ...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex),
            );
            body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

            // Store func ref in temp local
            const funcRefLocal = ctx.declareLocal('$$field_func', fieldType);
            body.push(
              Opcode.local_set,
              ...WasmModule.encodeSignedLEB128(funcRefLocal),
            );

            // Generate arguments
            for (const arg of expr.arguments) {
              generateExpression(ctx, arg, body);
            }

            // Load func ref and call
            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(funcRefLocal),
            );
            body.push(Opcode.call_ref);
            body.push(...WasmModule.encodeSignedLEB128(fieldTypeIndex));
            return;
          }
        }
      }
      throw new Error(`Method ${methodName} not found in class`);
    }

    if (methodInfo.intrinsic) {
      generateIntrinsic(
        ctx,
        methodInfo.intrinsic,
        memberExpr.object,
        expr.arguments,
        body,
      );
      return;
    }

    if (foundClass.isExtension) {
      generateExpression(ctx, memberExpr.object, body);

      const funcTypeIndex = ctx.module.getFunctionTypeIndex(methodInfo.index);
      const params = ctx.module.getFunctionTypeParams(funcTypeIndex);
      // params[0] is 'this' (the extension object)

      for (let i = 0; i < expr.arguments.length; i++) {
        const arg = expr.arguments[i];
        const expectedType = params[i + 1];
        generateAdaptedArgument(ctx, arg, expectedType, body);
      }

      body.push(
        Opcode.call,
        ...WasmModule.encodeSignedLEB128(methodInfo.index),
      );
      return;
    }

    const vtableIndex = foundClass.vtable
      ? foundClass.vtable.indexOf(methodName)
      : -1;

    if (
      vtableIndex !== -1 &&
      foundClass.vtableTypeIndex !== undefined &&
      !methodInfo.isFinal &&
      !foundClass.isFinal
    ) {
      // Dynamic Dispatch
      generateExpression(ctx, memberExpr.object, body);

      // Save object to temp
      const tempObj = ctx.declareLocal('$$temp_dispatch_obj', objectType);
      body.push(Opcode.local_tee);
      body.push(...WasmModule.encodeSignedLEB128(tempObj));

      // Get vtable (field 0)
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(0));

      // Cast vtable
      body.push(0xfb, GcOpcode.ref_cast_null);
      body.push(...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex));

      // Get function from vtable
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(vtableIndex));

      // Cast function to specific type
      body.push(0xfb, GcOpcode.ref_cast_null);
      body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

      // Save function to temp
      const funcType = [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
      ];
      const tempFunc = ctx.declareLocal('$$temp_dispatch_func', funcType);
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeSignedLEB128(tempFunc));

      // Restore object (this)
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempObj));

      // Generate arguments
      const params = ctx.module.getFunctionTypeParams(methodInfo.typeIndex);
      // params[0] is 'this'

      for (let i = 0; i < expr.arguments.length; i++) {
        const arg = expr.arguments[i];
        const expectedType = params[i + 1];
        generateAdaptedArgument(ctx, arg, expectedType, body);
      }

      // Get function
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempFunc));

      // Call ref
      body.push(Opcode.call_ref);
      body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));
    } else {
      generateExpression(ctx, memberExpr.object, body);

      const funcTypeIndex = ctx.module.getFunctionTypeIndex(methodInfo.index);
      const params = ctx.module.getFunctionTypeParams(funcTypeIndex);
      // params[0] is 'this'

      for (let i = 0; i < expr.arguments.length; i++) {
        const arg = expr.arguments[i];
        const expectedType = params[i + 1];
        generateAdaptedArgument(ctx, arg, expectedType, body);
      }

      body.push(Opcode.call);
      if (methodInfo.index === -1) {
        throw new Error(
          `Calling invalid function index -1 for method ${(expr.callee as MemberExpression).property.name}`,
        );
      }
      body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
    }
  } else if (expr.callee.type === NodeType.SuperExpression) {
    // Super constructor call
    if (ctx.currentClass && ctx.currentClass.isExtension) {
      // Extension class super call: super(value) -> this = value
      if (expr.arguments.length !== 1) {
        throw new Error('Extension super call expects 1 argument');
      }
      generateExpression(ctx, expr.arguments[0], body);
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeSignedLEB128(ctx.thisLocalIndex));
      return;
    }

    if (!ctx.currentClass || !ctx.currentClass.superClass) {
      throw new Error(
        'Super constructor call outside of class with superclass',
      );
    }
    // Identity-based lookup (no fallback)
    if (!ctx.currentClass.superClassType) {
      throw new Error(
        `superClassType not set for ${ctx.currentClass.name} (superClass: ${ctx.currentClass.superClass})`,
      );
    }
    const superClassInfo = ctx.getClassInfo(ctx.currentClass.superClassType);
    if (!superClassInfo) {
      throw new Error(
        `Super class not found for ${ctx.currentClass.name} via identity lookup`,
      );
    }
    const methodInfo = superClassInfo.methods.get('#new');
    if (!methodInfo) {
      throw new Error(`Constructor not found in superclass`);
    }

    // Load 'this'
    body.push(Opcode.local_get, 0);

    // Args
    for (const arg of expr.arguments) {
      generateExpression(ctx, arg, body);
    }

    // Static Call
    body.push(Opcode.call);
    if (methodInfo.index === -1)
      throw new Error(`Calling invalid super constructor index -1`);
    body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
    return;
  } else {
    // Check if it's a direct call to a global function
    let isDirectCall = false;
    if (expr.callee.type === NodeType.Identifier) {
      const name = (expr.callee as Identifier).name;

      if (name.startsWith('__array_') || name === 'unreachable') {
        generateGlobalIntrinsic(ctx, name, expr, body);
        return;
      }

      if (ctx.globalIntrinsics.has(name)) {
        let intrinsicName = ctx.globalIntrinsics.get(name)!;

        if (expr.resolvedFunctionType && ctx.functionOverloads.has(name)) {
          const overloads = ctx.functionOverloads.get(name)!;
          const match = overloads.find(
            (o) => o.type === expr.resolvedFunctionType,
          );
          if (match && match.intrinsic) {
            intrinsicName = match.intrinsic;
          }
        }

        generateGlobalIntrinsic(ctx, intrinsicName, expr, body);
        return;
      }

      // Check if this is a direct call to a global function using binding
      const calleeBinding = ctx.semanticContext.getResolvedBinding(
        expr.callee as Identifier,
      );
      const resolvedCalleeBinding = calleeBinding
        ? resolveImport(calleeBinding)
        : undefined;

      // Check by binding, generic functions, overloads, or registered functions
      const isFunctionBinding =
        resolvedCalleeBinding?.kind === 'function' ||
        ctx.genericFunctions.has(name) ||
        ctx.functionOverloads.has(name) ||
        ctx.functions.has(name);

      if (!ctx.getLocal(name) && isFunctionBinding) {
        isDirectCall = true;
      }
    }

    if (isDirectCall) {
      const name = (expr.callee as Identifier).name;
      let targetFuncIndex = -1;

      if (ctx.genericFunctions.has(name)) {
        // Use inferredTypeArguments (Type[]) directly if available
        let checkerTypeArgs = expr.inferredTypeArguments;

        if (!checkerTypeArgs || checkerTypeArgs.length === 0) {
          throw new Error(`Missing inferred type arguments for ${name}`);
        }

        targetFuncIndex = instantiateGenericFunction(
          ctx,
          name,
          checkerTypeArgs,
        );
      } else if (ctx.functionOverloads.has(name)) {
        const overloads = ctx.functionOverloads.get(name)!;
        const argTypes = expr.arguments.map((arg) => inferType(ctx, arg));

        let bestMatch:
          | {index: number; params: number[][]; intrinsic?: string}
          | undefined;

        for (const overload of overloads) {
          if (overload.params.length !== argTypes.length) continue;

          let match = true;
          for (let i = 0; i < argTypes.length; i++) {
            const paramType = overload.params[i];
            const argType = argTypes[i];

            if (paramType.length !== argType.length) {
              match = false;
              break;
            }
            for (let j = 0; j < paramType.length; j++) {
              if (paramType[j] !== argType[j]) {
                match = false;
                break;
              }
            }
            if (!match) break;
          }

          if (match) {
            bestMatch = overload;
            break;
          }
        }

        if (bestMatch) {
          if (bestMatch.intrinsic) {
            generateGlobalIntrinsic(ctx, bestMatch.intrinsic, expr, body);
            return;
          }
          targetFuncIndex = bestMatch.index;
        }
      } else {
        // Simple function call - try binding-based lookup first
        const calleeBinding = ctx.semanticContext.getResolvedBinding(
          expr.callee as Identifier,
        );
        if (calleeBinding) {
          const resolved = resolveImport(calleeBinding);
          if (resolved.kind === 'function') {
            const index = ctx.getFunctionIndexByDecl(resolved.declaration);
            if (index !== undefined) {
              targetFuncIndex = index;
            }
          }
        }
        // Fall back to name-based lookup if binding lookup failed
        if (targetFuncIndex === -1 && ctx.functions.has(name)) {
          targetFuncIndex = ctx.functions.get(name)!;
        }
      }

      if (targetFuncIndex !== -1) {
        const typeIndex = ctx.module.getFunctionTypeIndex(targetFuncIndex);
        const params = ctx.module.getFunctionTypeParams(typeIndex);

        for (let i = 0; i < expr.arguments.length; i++) {
          generateAdaptedArgument(ctx, expr.arguments[i], params[i], body);
        }

        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(targetFuncIndex));
      } else {
        throw new Error(`Function '${name}' not found.`);
      }
    } else {
      generateIndirectCall(ctx, expr, body);
    }
  }
}

function generateAssignmentExpression(
  ctx: CodegenContext,
  expr: AssignmentExpression,
  body: number[],
) {
  if (expr.left.type === NodeType.IndexExpression) {
    const indexExpr = expr.left as IndexExpression;

    const objectType = inferType(ctx, indexExpr.object);
    const structTypeIndex = getHeapTypeIndex(ctx, objectType);

    if (structTypeIndex !== -1) {
      let foundClass: ClassInfo | undefined;

      // Use identity-based lookup via checker type
      if (
        indexExpr.object.inferredType &&
        indexExpr.object.inferredType.kind === TypeKind.Class
      ) {
        let classType = indexExpr.object.inferredType as ClassType;
        // Substitute type parameters when in a generic context
        if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
          classType = ctx.checkerContext.substituteTypeParams(
            classType,
            ctx.currentTypeArguments,
          ) as ClassType;
        }
        // Ensure we use the interned version for identity-based lookup
        if (
          classType.genericSource &&
          classType.typeArguments &&
          classType.typeArguments.length > 0
        ) {
          const interned = ctx.checkerContext.getInternedClass(
            classType.genericSource,
            classType.typeArguments,
          );
          if (interned) {
            classType = interned;
          }
        }
        foundClass = ctx.getClassInfo(classType);

        // If identity lookup failed, instantiate via mapCheckerTypeToWasmType and retry
        if (
          !foundClass &&
          classType.typeArguments &&
          classType.typeArguments.length > 0
        ) {
          mapCheckerTypeToWasmType(ctx, classType);
          foundClass = ctx.getClassInfo(classType);
        }
      }

      // Check for extension classes on non-class types (e.g., raw array<T>)
      if (!foundClass && indexExpr.object.inferredType) {
        // Substitute type parameters when in a generic context
        let lookupType = indexExpr.object.inferredType;
        if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
          lookupType = ctx.checkerContext.substituteTypeParams(
            lookupType,
            ctx.currentTypeArguments,
          );
        }
        const extensions = ctx.getExtensionClassesByOnType(lookupType);
        if (extensions && extensions.length > 0) {
          foundClass = extensions[0];
        }
      }

      // On-demand FixedArray instantiation for raw array types
      if (!foundClass && indexExpr.object.inferredType) {
        let objType = indexExpr.object.inferredType;
        if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
          objType = ctx.checkerContext.substituteTypeParams(
            objType,
            ctx.currentTypeArguments,
          );
        }
        if (objType.kind === TypeKind.Array) {
          const arrType = objType as import('../types.js').ArrayType;
          if (arrType.elementType.kind !== TypeKind.TypeParameter) {
            foundClass = resolveFixedArrayClass(ctx, objType);
          }
        }
      }

      if (foundClass) {
        const methodInfo = foundClass.methods.get('[]=');
        if (methodInfo) {
          if (
            methodInfo.intrinsic === 'array.set' &&
            foundClass.isExtension &&
            foundClass.onType
          ) {
            // Use the actual object type (already resolved via inferType with substitution)
            // instead of foundClass.onType, which may be a generic template type
            const arrayTypeIndex = decodeTypeIndex(objectType);

            generateExpression(ctx, indexExpr.object, body);
            generateExpression(ctx, indexExpr.index, body);
            generateExpression(ctx, expr.value, body);

            const valueType = inferType(ctx, expr.value);
            const tempVal = ctx.declareLocal('$$temp_assign_val', valueType);

            body.push(Opcode.local_tee);
            body.push(...WasmModule.encodeSignedLEB128(tempVal));

            body.push(0xfb, GcOpcode.array_set);
            body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));

            body.push(Opcode.local_get);
            body.push(...WasmModule.encodeSignedLEB128(tempVal));
            return;
          }

          generateExpression(ctx, indexExpr.object, body);
          generateExpression(ctx, indexExpr.index, body);
          generateExpression(ctx, expr.value, body);

          const valueType = inferType(ctx, expr.value);
          const tempVal = ctx.declareLocal('$$temp_assign_val', valueType);

          body.push(Opcode.local_tee);
          body.push(...WasmModule.encodeSignedLEB128(tempVal));

          body.push(Opcode.call);
          body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));

          body.push(Opcode.local_get);
          body.push(...WasmModule.encodeSignedLEB128(tempVal));
          return;
        }
      } else {
        // Identity-based lookup for interface
        let interfaceInfo: InterfaceInfo | undefined;
        if (
          indexExpr.object.inferredType &&
          indexExpr.object.inferredType.kind === TypeKind.Interface
        ) {
          interfaceInfo = ctx.getInterfaceInfo(
            indexExpr.object.inferredType as InterfaceType,
          );
          if (!interfaceInfo) {
            throw new Error(
              `Interface not registered: ${(indexExpr.object.inferredType as InterfaceType).name}`,
            );
          }
        }

        if (interfaceInfo) {
          const methodInfo = interfaceInfo.methods.get('[]=');
          if (methodInfo) {
            // Generate interface call
            // Stack: [InterfaceStruct]
            generateExpression(ctx, indexExpr.object, body);

            // Store in temp local
            const tempLocal = ctx.declareLocal(
              '$$interface_temp_set',
              objectType,
            );
            body.push(
              Opcode.local_tee,
              ...WasmModule.encodeSignedLEB128(tempLocal),
            );

            // Load VTable
            body.push(
              0xfb,
              GcOpcode.struct_get,
              ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
              ...WasmModule.encodeSignedLEB128(1),
            );

            // Load Function Pointer
            body.push(
              0xfb,
              GcOpcode.struct_get,
              ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
              ...WasmModule.encodeSignedLEB128(methodInfo.index),
            );

            // Cast to specific function type
            body.push(
              0xfb,
              GcOpcode.ref_cast_null,
              ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
            );

            // Store function ref in temp local
            const funcRefType = [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
            ];
            const funcRefLocal = ctx.declareLocal(
              '$$interface_func_set',
              funcRefType,
            );
            body.push(
              Opcode.local_set,
              ...WasmModule.encodeSignedLEB128(funcRefLocal),
            );

            // Load Instance (this)
            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(tempLocal),
            );
            body.push(
              0xfb,
              GcOpcode.struct_get,
              ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
              ...WasmModule.encodeSignedLEB128(0),
            );

            // Evaluate index
            generateExpression(ctx, indexExpr.index, body);

            const paramTypes = ctx.module.getFunctionTypeParams(
              methodInfo.typeIndex,
            );

            // Box index if needed
            if (paramTypes.length > 1) {
              const indexType = inferType(ctx, indexExpr.index);
              const expectedIndexType = paramTypes[1];
              if (
                expectedIndexType.length === 1 &&
                expectedIndexType[0] === ValType.anyref
              ) {
                if (
                  indexType.length === 1 &&
                  (indexType[0] === ValType.i32 ||
                    indexType[0] === ValType.i64 ||
                    indexType[0] === ValType.f32 ||
                    indexType[0] === ValType.f64)
                ) {
                  boxPrimitive(ctx, indexType, body);
                }
              }
            }

            // Evaluate value
            generateExpression(ctx, expr.value, body);

            const valueType = inferType(ctx, expr.value);
            const tempVal = ctx.declareLocal('$$temp_assign_val', valueType);
            body.push(
              Opcode.local_tee,
              ...WasmModule.encodeSignedLEB128(tempVal),
            );

            // Box value if needed
            if (paramTypes.length > 2) {
              const expectedValueType = paramTypes[2];
              if (
                expectedValueType.length === 1 &&
                expectedValueType[0] === ValType.anyref
              ) {
                if (
                  valueType.length === 1 &&
                  (valueType[0] === ValType.i32 ||
                    valueType[0] === ValType.i64 ||
                    valueType[0] === ValType.f32 ||
                    valueType[0] === ValType.f64)
                ) {
                  boxPrimitive(ctx, valueType, body);
                }
              }
            }

            // Load function ref
            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(funcRefLocal),
            );

            // Call Ref
            body.push(
              Opcode.call_ref,
              ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
            );

            // Return value
            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(tempVal),
            );
            return;
          }
        }
      }
    }

    let arrayTypeIndex = -1;
    if (indexExpr.object.type === NodeType.Identifier) {
      const localInfo = ctx.getLocal((indexExpr.object as Identifier).name);
      if (localInfo && localInfo.type.length > 1) {
        arrayTypeIndex = localInfo.type[1];
      }
    }
    if (arrayTypeIndex === -1) {
      if (
        objectType.length > 1 &&
        (objectType[0] === ValType.ref || objectType[0] === ValType.ref_null)
      ) {
        arrayTypeIndex = decodeTypeIndex(objectType);
      } else {
        arrayTypeIndex = getArrayTypeIndex(ctx, [ValType.i32]);
      }
    }

    if (arrayTypeIndex !== -1) {
      let isArray = false;
      try {
        ctx.module.getArrayElementType(arrayTypeIndex);
        isArray = true;
      } catch (e) {
        isArray = false;
      }

      if (isArray) {
        const intrinsic = findArrayIntrinsic(ctx, '[]=');
        if (intrinsic === 'array.set') {
          generateExpression(ctx, indexExpr.object, body);
          generateExpression(ctx, indexExpr.index, body);
          generateExpression(ctx, expr.value, body);

          const valueType = inferType(ctx, expr.value);
          const tempLocal = ctx.declareLocal('$$temp_array_set', valueType);

          body.push(Opcode.local_tee);
          body.push(...WasmModule.encodeSignedLEB128(tempLocal));

          body.push(0xfb, GcOpcode.array_set);
          body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));

          body.push(Opcode.local_get);
          body.push(...WasmModule.encodeSignedLEB128(tempLocal));
          return;
        }
      }
    }

    // Fallback for now, or throw error?
    // If we strictly require intrinsic, we should throw or do nothing.
    throw new Error('Array index assignment requires intrinsic operator []=');
  }

  if (expr.left.type === NodeType.MemberExpression) {
    const memberExpr = expr.left as MemberExpression;
    const fieldName = memberExpr.property.name;

    const objectType = inferType(ctx, memberExpr.object);
    const structTypeIndex = getHeapTypeIndex(ctx, objectType);

    // Identity-based lookup using checker type
    let foundClass: ClassInfo | undefined;
    if (
      memberExpr.object.inferredType &&
      memberExpr.object.inferredType.kind === TypeKind.Class
    ) {
      let classType = memberExpr.object.inferredType as ClassType;

      // Substitute type parameters in the classType when inside a generic context
      if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
        classType = ctx.checkerContext.substituteTypeParams(
          classType,
          ctx.currentTypeArguments,
        ) as ClassType;
      }

      // Intern the classType to ensure we use the canonical object
      if (
        classType.genericSource &&
        classType.typeArguments &&
        classType.typeArguments.length > 0
      ) {
        const interned = ctx.checkerContext.getInternedClass(
          classType.genericSource,
          classType.typeArguments,
        );
        if (interned) {
          classType = interned;
        }
      }

      foundClass = ctx.getClassInfo(classType);

      // If not found, trigger instantiation then trust the cache
      if (!foundClass && classType.typeArguments?.length) {
        mapCheckerTypeToWasmType(ctx, classType);
        foundClass = ctx.getClassInfo(classType);
      }

      // Verify the struct type index matches - if not, there's an interning issue
      if (
        foundClass &&
        structTypeIndex !== -1 &&
        foundClass.structTypeIndex !== structTypeIndex
      ) {
        // Identity lookup gave wrong ClassInfo - use struct index lookup instead
        foundClass = ctx.getClassInfoByStructIndexDirect(structTypeIndex);
      }
    }

    // Fallback to struct index lookup if identity-based lookup failed
    if (!foundClass && structTypeIndex !== -1) {
      foundClass = ctx.getClassInfoByStructIndexDirect(structTypeIndex);
    }

    if (!foundClass) {
      // Identity-based lookup for interface
      let interfaceInfo: InterfaceInfo | undefined;
      if (
        memberExpr.object.inferredType &&
        memberExpr.object.inferredType.kind === TypeKind.Interface
      ) {
        interfaceInfo = ctx.getInterfaceInfo(
          memberExpr.object.inferredType as InterfaceType,
        );
        if (!interfaceInfo) {
          throw new Error(
            `Interface not registered: ${(memberExpr.object.inferredType as InterfaceType).name}`,
          );
        }
      }

      if (interfaceInfo) {
        const setterName = getSetterName(fieldName);
        const methodInfo = interfaceInfo.methods.get(setterName);
        if (!methodInfo) {
          throw new Error(`Setter for ${fieldName} not found in interface`);
        }

        // Evaluate object -> Stack: [InterfaceStruct]
        generateExpression(ctx, memberExpr.object, body);

        // Store in temp local
        const tempLocal = ctx.declareLocal('$$interface_temp', objectType);
        body.push(
          Opcode.local_tee,
          ...WasmModule.encodeSignedLEB128(tempLocal),
        );

        // Load VTable
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
          ...WasmModule.encodeSignedLEB128(1),
        );

        // Load Function Pointer
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
          ...WasmModule.encodeSignedLEB128(methodInfo.index),
        );

        // Cast to specific function type
        body.push(
          0xfb,
          GcOpcode.ref_cast_null,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        );

        // Store function ref in temp local
        const funcRefType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        ];
        const funcRefLocal = ctx.declareLocal('$$interface_func', funcRefType);
        body.push(
          Opcode.local_set,
          ...WasmModule.encodeSignedLEB128(funcRefLocal),
        );

        // Load Instance (this)
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(tempLocal),
        );
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
          ...WasmModule.encodeSignedLEB128(0),
        );

        // Evaluate value
        generateExpression(ctx, expr.value, body);

        const valueType = inferType(ctx, expr.value);
        const tempVal = ctx.declareLocal('$$temp_assign_val', valueType);
        body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempVal));

        // Check for boxing
        const paramTypes = ctx.module.getFunctionTypeParams(
          methodInfo.typeIndex,
        );
        // param 0 is this, param 1 is value
        if (paramTypes.length > 1) {
          const expectedType = paramTypes[1];
          if (expectedType.length === 1 && expectedType[0] === ValType.anyref) {
            if (
              valueType.length === 1 &&
              (valueType[0] === ValType.i32 ||
                valueType[0] === ValType.i64 ||
                valueType[0] === ValType.f32 ||
                valueType[0] === ValType.f64)
            ) {
              boxPrimitive(ctx, valueType, body);
            }
          }
        }

        // Load function ref
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(funcRefLocal),
        );

        // Call Ref
        body.push(
          Opcode.call_ref,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        );

        // Return value
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempVal));
        return;
      }

      throw new Error(`Class not found for field assignment to '${fieldName}'`);
    }

    let lookupName = fieldName;
    if (fieldName.startsWith('#')) {
      if (!ctx.currentClass) {
        throw new Error('Private field assignment outside class');
      }
      lookupName = `${ctx.currentClass.name}::${fieldName}`;
    }

    // Check for virtual property assignment (public fields or accessors)
    if (!fieldName.startsWith('#')) {
      const setterName = getSetterName(fieldName);
      const methodInfo = foundClass.methods.get(setterName);
      if (methodInfo) {
        // Check if we can use static dispatch (final class, final method, or extension)
        const useStaticDispatch =
          foundClass.isFinal || methodInfo.isFinal || foundClass.isExtension;

        if (useStaticDispatch) {
          // Static dispatch - direct call
          generateExpression(ctx, memberExpr.object, body);
          generateExpression(ctx, expr.value, body);
          const valueType = inferType(ctx, expr.value);
          const tempVal = ctx.declareLocal('$$temp_val', valueType);
          body.push(
            Opcode.local_tee,
            ...WasmModule.encodeSignedLEB128(tempVal),
          );
          body.push(
            Opcode.call,
            ...WasmModule.encodeSignedLEB128(methodInfo.index),
          );
          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(tempVal),
          );
          return;
        }

        // Dynamic dispatch via vtable
        generateExpression(ctx, memberExpr.object, body);
        const tempObj = ctx.declareLocal('$$temp_obj', objectType);
        body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(tempObj));

        generateExpression(ctx, expr.value, body);
        // Infer type of value to declare temp local correctly
        const valueType = inferType(ctx, expr.value);
        const tempVal = ctx.declareLocal('$$temp_val', valueType);
        body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(tempVal));

        // Call setter
        // 1. Load 'this' for vtable lookup
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempObj));

        // 2. Load VTable
        if (!foundClass.vtable || foundClass.vtableTypeIndex === undefined) {
          throw new Error(`Class ${foundClass.name} has no vtable`);
        }
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex),
          ...WasmModule.encodeSignedLEB128(
            foundClass.fields.get('__vtable')!.index,
          ),
        );

        // Cast VTable to correct type
        body.push(
          0xfb,
          GcOpcode.ref_cast_null,
          ...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex),
        );

        // 3. Load Function Pointer from VTable
        const vtableIndex = foundClass.vtable.indexOf(setterName);
        if (vtableIndex === -1) {
          throw new Error(`Method ${setterName} not found in vtable`);
        }

        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex),
          ...WasmModule.encodeSignedLEB128(vtableIndex),
        );

        // 4. Cast to specific function type
        body.push(
          0xfb,
          GcOpcode.ref_cast_null,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        );

        // Store func_ref
        const funcRefType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        ];
        const funcRef = ctx.declareLocal('$$func_ref', funcRefType);
        body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(funcRef));

        // 5. Args: this, value
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempObj));
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempVal));
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRef));

        // 6. Call function
        body.push(
          Opcode.call_ref,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        );

        // 7. Return value
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempVal));
        return;
      }
    }

    const fieldInfo = foundClass.fields.get(lookupName);
    if (!fieldInfo) {
      throw new Error(`Field ${lookupName} not found`);
    }

    generateExpression(ctx, memberExpr.object, body);
    generateExpression(ctx, expr.value, body);

    const valueType = inferType(ctx, expr.value);
    if (
      ((fieldInfo.type.length > 1 &&
        fieldInfo.type[0] === ValType.ref_null &&
        fieldInfo.type[1] === ValType.anyref) ||
        (fieldInfo.type.length === 1 &&
          fieldInfo.type[0] === ValType.anyref)) &&
      valueType.length === 1 &&
      (valueType[0] === ValType.i32 ||
        valueType[0] === ValType.i64 ||
        valueType[0] === ValType.f32 ||
        valueType[0] === ValType.f64)
    ) {
      boxPrimitive(ctx, valueType, body);
    }

    const tempVal = ctx.declareLocal('$$temp_field_set', fieldInfo.type);
    body.push(Opcode.local_tee);
    body.push(...WasmModule.encodeSignedLEB128(tempVal));

    body.push(0xfb, GcOpcode.struct_set);
    body.push(...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(tempVal));
  } else if (expr.left.type === NodeType.Identifier) {
    const local = ctx.getLocal(expr.left.name);

    if (local) {
      const index = local.index;

      if (local.isBoxed && local.unboxedType) {
        // For boxed mutable captures, we need to write through the box
        // Generate the value first and save it
        generateExpression(ctx, expr.value, body);
        // Stack: [value]

        const valueType = inferType(ctx, expr.value);
        const tempVal = ctx.declareLocal('$$temp_boxed_assign', valueType);
        body.push(Opcode.local_tee);
        body.push(...WasmModule.encodeSignedLEB128(tempVal));
        // Stack: [value]

        // Load the box
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(index));
        // Stack: [value, box]

        // Swap: we need [box, value] for struct.set
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(tempVal));
        // Stack: [value, box, value]

        // Write the value into the box
        const boxClass = getBoxClassInfo(
          ctx,
          wasmTypeToCheckerType(local.unboxedType),
        );
        const valueField = boxClass.fields.get(BOX_VALUE_FIELD);
        if (!valueField) throw new Error("Box class missing 'value' field");

        body.push(0xfb, GcOpcode.struct_set);
        body.push(...WasmModule.encodeSignedLEB128(boxClass.structTypeIndex));
        body.push(...WasmModule.encodeSignedLEB128(valueField.index));
        // Stack: [value] (from the original local.tee)
      } else {
        // Normal local assignment
        generateExpression(ctx, expr.value, body);

        const valueType = inferType(ctx, expr.value);
        if (
          ((local.type.length > 1 &&
            local.type[0] === ValType.ref_null &&
            local.type[1] === ValType.anyref) ||
            (local.type.length === 1 && local.type[0] === ValType.anyref)) &&
          valueType.length === 1 &&
          (valueType[0] === ValType.i32 ||
            valueType[0] === ValType.i64 ||
            valueType[0] === ValType.f32 ||
            valueType[0] === ValType.f64)
        ) {
          boxPrimitive(ctx, valueType, body);
        }

        // Assignment is an expression that evaluates to the assigned value.
        // So we use local.tee to set the local and keep the value on the stack.
        body.push(Opcode.local_tee);
        body.push(...WasmModule.encodeSignedLEB128(index));
      }
    } else {
      // Use binding-based lookup for global assignment
      const binding = ctx.semanticContext.getResolvedBinding(expr.left);
      if (!binding) {
        throw new Error(`Unknown identifier: ${expr.left.name}`);
      }
      const resolved = resolveImport(binding);
      if (resolved.kind !== 'global') {
        throw new Error(`Cannot assign to ${resolved.kind}: ${expr.left.name}`);
      }
      const globalIndex = ctx.getGlobalIndexByDecl(resolved.declaration);
      if (globalIndex === undefined) {
        throw new Error(`Global not registered: ${expr.left.name}`);
      }
      // Get WASM type from the binding's semantic type
      const globalWasmType = mapCheckerTypeToWasmType(ctx, resolved.type);

      const valueType = inferType(ctx, expr.value);
      if (
        ((globalWasmType.length > 1 &&
          globalWasmType[0] === ValType.ref_null &&
          globalWasmType[1] === ValType.anyref) ||
          (globalWasmType.length === 1 &&
            globalWasmType[0] === ValType.anyref)) &&
        valueType.length === 1 &&
        (valueType[0] === ValType.i32 ||
          valueType[0] === ValType.i64 ||
          valueType[0] === ValType.f32 ||
          valueType[0] === ValType.f64)
      ) {
        boxPrimitive(ctx, valueType, body);
      }

      const temp = ctx.declareLocal('$$temp_global_assign', valueType);
      body.push(Opcode.local_tee);
      body.push(...WasmModule.encodeSignedLEB128(temp));
      body.push(Opcode.global_set);
      body.push(...WasmModule.encodeSignedLEB128(globalIndex));
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(temp));
    }
  } else {
    throw new Error('Invalid assignment target');
  }
}

function generateBinaryExpression(
  ctx: CodegenContext,
  expr: BinaryExpression,
  body: number[],
) {
  if (expr.operator === '&&') {
    // Short-circuiting Logical AND
    // left && right
    // if (left) { return right } else { return false }

    generateExpression(ctx, expr.left, body);
    // Stack: [left]

    body.push(Opcode.if);
    body.push(ValType.i32); // Result type: i32 (boolean)

    // Then block (left was true)
    generateExpression(ctx, expr.right, body);
    // Stack: [right]

    body.push(Opcode.else);

    // Else block (left was false)
    body.push(Opcode.i32_const, 0); // false

    body.push(Opcode.end);
    return;
  }

  if (expr.operator === '||') {
    // Short-circuiting Logical OR
    // left || right
    // if (left) { return true } else { return right }

    generateExpression(ctx, expr.left, body);
    // Stack: [left]

    body.push(Opcode.if);
    body.push(ValType.i32); // Result type: i32 (boolean)

    // Then block (left was true)
    body.push(Opcode.i32_const, 1); // true

    body.push(Opcode.else);

    // Else block (left was false)
    generateExpression(ctx, expr.right, body);
    // Stack: [right]

    body.push(Opcode.end);
    return;
  }

  // Optimization for null checks
  if (
    expr.operator === '==' ||
    expr.operator === '!=' ||
    expr.operator === '===' ||
    expr.operator === '!=='
  ) {
    if (expr.right.type === NodeType.NullLiteral) {
      generateExpression(ctx, expr.left, body);
      body.push(Opcode.ref_is_null);
      if (expr.operator === '!=' || expr.operator === '!==') {
        body.push(Opcode.i32_eqz);
      }
      return;
    }
    if (expr.left.type === NodeType.NullLiteral) {
      generateExpression(ctx, expr.right, body);
      body.push(Opcode.ref_is_null);
      if (expr.operator === '!=' || expr.operator === '!==') {
        body.push(Opcode.i32_eqz);
      }
      return;
    }
  }

  const leftType = inferType(ctx, expr.left);
  const rightType = inferType(ctx, expr.right);

  const isF32 = (t: number[]) => t.length === 1 && t[0] === ValType.f32;
  const isI32 = (t: number[]) => t.length === 1 && t[0] === ValType.i32;
  const isI64 = (t: number[]) => t.length === 1 && t[0] === ValType.i64;
  const isF64 = (t: number[]) => t.length === 1 && t[0] === ValType.f64;

  const isNumeric = (t: number[]) =>
    isI32(t) || isI64(t) || isF32(t) || isF64(t);

  if (isNumeric(leftType) && isNumeric(rightType)) {
    let targetType: number = ValType.i32;

    // Determine target type based on promotion rules
    if (expr.operator === '/') {
      if (
        isF64(leftType) ||
        isF64(rightType) ||
        isI64(leftType) ||
        isI64(rightType)
      ) {
        targetType = ValType.f64;
      } else {
        targetType = ValType.f32;
      }
    } else {
      if (isF64(leftType) || isF64(rightType)) {
        targetType = ValType.f64;
      } else if (isF32(leftType) || isF32(rightType)) {
        if (isI64(leftType) || isI64(rightType)) {
          targetType = ValType.f64;
        } else {
          targetType = ValType.f32;
        }
      } else if (isI64(leftType) || isI64(rightType)) {
        targetType = ValType.i64;
      } else {
        targetType = ValType.i32;
      }
    }

    const emitConversion = (
      source: number[],
      target: number,
      sourceZenaType: any,
    ) => {
      if (source[0] === target) return;

      const isU32 =
        sourceZenaType &&
        sourceZenaType.kind === TypeKind.Number &&
        (sourceZenaType as NumberType).name === Types.U32.name;

      if (source[0] === ValType.i32) {
        if (target === ValType.i64)
          body.push(isU32 ? Opcode.i64_extend_i32_u : Opcode.i64_extend_i32_s);
        else if (target === ValType.f32)
          body.push(
            isU32 ? Opcode.f32_convert_i32_u : Opcode.f32_convert_i32_s,
          );
        else if (target === ValType.f64)
          body.push(
            isU32 ? Opcode.f64_convert_i32_u : Opcode.f64_convert_i32_s,
          );
      } else if (source[0] === ValType.i64) {
        if (target === ValType.f32) body.push(Opcode.f32_convert_i64_s);
        else if (target === ValType.f64) body.push(Opcode.f64_convert_i64_s);
      } else if (source[0] === ValType.f32) {
        if (target === ValType.f64) body.push(Opcode.f64_promote_f32);
      }
    };

    generateExpression(ctx, expr.left, body);
    emitConversion(leftType, targetType, expr.left.inferredType);
    generateExpression(ctx, expr.right, body);
    emitConversion(rightType, targetType, expr.right.inferredType);

    const isU32Type = (t: any) =>
      t &&
      t.kind === TypeKind.Number &&
      (t as NumberType).name === Types.U32.name;
    const useUnsigned =
      isU32Type(expr.left.inferredType) || isU32Type(expr.right.inferredType);

    switch (targetType) {
      case ValType.i32:
        switch (expr.operator) {
          case '+':
            body.push(Opcode.i32_add);
            break;
          case '-':
            body.push(Opcode.i32_sub);
            break;
          case '*':
            body.push(Opcode.i32_mul);
            break;
          case '/':
            // Division is always float, so this case is unreachable for /
            // But if we ever support integer division, we'd use div_u/div_s
            body.push(useUnsigned ? Opcode.i32_div_u : Opcode.i32_div_s);
            break;
          case '%':
            body.push(useUnsigned ? Opcode.i32_rem_u : Opcode.i32_rem_s);
            break;
          case '&':
            body.push(Opcode.i32_and);
            break;
          case '|':
            body.push(Opcode.i32_or);
            break;
          case '^':
            body.push(Opcode.i32_xor);
            break;
          case '==':
          case '===':
            body.push(Opcode.i32_eq);
            break;
          case '!=':
          case '!==':
            body.push(Opcode.i32_ne);
            break;
          case '<':
            body.push(useUnsigned ? Opcode.i32_lt_u : Opcode.i32_lt_s);
            break;
          case '<=':
            body.push(useUnsigned ? Opcode.i32_le_u : Opcode.i32_le_s);
            break;
          case '>':
            body.push(useUnsigned ? Opcode.i32_gt_u : Opcode.i32_gt_s);
            break;
          case '>=':
            body.push(useUnsigned ? Opcode.i32_ge_u : Opcode.i32_ge_s);
            break;
          default:
            throw new Error(`Unsupported operator for i32: ${expr.operator}`);
        }
        break;
      case ValType.i64:
        switch (expr.operator) {
          case '+':
            body.push(Opcode.i64_add);
            break;
          case '-':
            body.push(Opcode.i64_sub);
            break;
          case '*':
            body.push(Opcode.i64_mul);
            break;
          case '/':
            body.push(Opcode.i64_div_s);
            break; // Should not happen
          case '%':
            body.push(Opcode.i64_rem_s);
            break;
          case '&':
            body.push(Opcode.i64_and);
            break;
          case '|':
            body.push(Opcode.i64_or);
            break;
          case '^':
            body.push(Opcode.i64_xor);
            break;
          case '==':
          case '===':
            body.push(Opcode.i64_eq);
            break;
          case '!=':
          case '!==':
            body.push(Opcode.i64_ne);
            break;
          case '<':
            body.push(Opcode.i64_lt_s);
            break;
          case '<=':
            body.push(Opcode.i64_le_s);
            break;
          case '>':
            body.push(Opcode.i64_gt_s);
            break;
          case '>=':
            body.push(Opcode.i64_ge_s);
            break;
          default:
            throw new Error(`Unsupported operator for i64: ${expr.operator}`);
        }
        break;
      case ValType.f32:
        switch (expr.operator) {
          case '+':
            body.push(Opcode.f32_add);
            break;
          case '-':
            body.push(Opcode.f32_sub);
            break;
          case '*':
            body.push(Opcode.f32_mul);
            break;
          case '/':
            body.push(Opcode.f32_div);
            break;
          case '==':
          case '===':
            body.push(Opcode.f32_eq);
            break;
          case '!=':
          case '!==':
            body.push(Opcode.f32_ne);
            break;
          case '<':
            body.push(Opcode.f32_lt);
            break;
          case '<=':
            body.push(Opcode.f32_le);
            break;
          case '>':
            body.push(Opcode.f32_gt);
            break;
          case '>=':
            body.push(Opcode.f32_ge);
            break;
          default:
            throw new Error(`Unsupported operator for f32: ${expr.operator}`);
        }
        break;
      case ValType.f64:
        switch (expr.operator) {
          case '+':
            body.push(Opcode.f64_add);
            break;
          case '-':
            body.push(Opcode.f64_sub);
            break;
          case '*':
            body.push(Opcode.f64_mul);
            break;
          case '/':
            body.push(Opcode.f64_div);
            break;
          case '==':
          case '===':
            body.push(Opcode.f64_eq);
            break;
          case '!=':
          case '!==':
            body.push(Opcode.f64_ne);
            break;
          case '<':
            body.push(Opcode.f64_lt);
            break;
          case '<=':
            body.push(Opcode.f64_le);
            break;
          case '>':
            body.push(Opcode.f64_gt);
            break;
          case '>=':
            body.push(Opcode.f64_ge);
            break;
          default:
            throw new Error(`Unsupported operator for f64: ${expr.operator}`);
        }
        break;
    }
    return;
  }

  generateExpression(ctx, expr.left, body);
  generateExpression(ctx, expr.right, body);

  if (isStringType(ctx, leftType) && isStringType(ctx, rightType)) {
    if (expr.operator === '+') {
      generateStringConcat(ctx, body);
      return;
    } else if (expr.operator === '==') {
      generateStringEq(ctx, body);
      return;
    } else if (expr.operator === '!=') {
      generateStringEq(ctx, body);
      body.push(Opcode.i32_eqz); // Invert result
      return;
    }
  }

  // Check for reference equality
  const isRefType = (t: number[]) =>
    t.length > 0 &&
    (t[0] === ValType.ref ||
      t[0] === ValType.ref_null ||
      t[0] === ValType.anyref ||
      t[0] === ValType.eqref ||
      t[0] === ValType.externref ||
      t[0] === ValType.funcref);

  if (isRefType(leftType) && isRefType(rightType)) {
    if (expr.operator === '===') {
      body.push(Opcode.ref_eq);
      return;
    } else if (expr.operator === '!==') {
      body.push(Opcode.ref_eq);
      body.push(Opcode.i32_eqz);
      return;
    }

    if (expr.operator === '==' || expr.operator === '!=') {
      const structTypeIndex = getHeapTypeIndex(ctx, leftType);
      let foundClass: ClassInfo | undefined;

      // Primary: look up ClassInfo via checker type identity
      if (expr.left.inferredType) {
        let checkerType = expr.left.inferredType;
        // Substitute type parameters when in a generic context
        if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
          checkerType = ctx.checkerContext.substituteTypeParams(
            checkerType,
            ctx.currentTypeArguments,
          );
        }

        if (checkerType.kind === TypeKind.Class) {
          foundClass = ctx.getClassInfo(checkerType as ClassType);

          // If identity lookup failed, instantiate via mapCheckerTypeToWasmType
          if (!foundClass) {
            mapCheckerTypeToWasmType(ctx, checkerType);
            foundClass = ctx.getClassInfo(checkerType as ClassType);
          }
        }

        // Extension class lookup by onType (checker type identity)
        if (!foundClass) {
          const extensions = ctx.getExtensionClassesByOnType(checkerType);
          if (extensions && extensions.length > 0) {
            foundClass = extensions[0];
          }
        }
      }

      // Fallback: look up by struct index
      if (!foundClass && structTypeIndex !== -1) {
        foundClass = ctx.getClassInfoByStructIndexDirect(structTypeIndex);
      }

      let hasOperator = false;
      if (foundClass) {
        const methodInfo = foundClass.methods.get('==');
        if (methodInfo) {
          hasOperator = true;
          if (foundClass.isFinal || methodInfo.isFinal) {
            body.push(
              Opcode.call,
              ...WasmModule.encodeSignedLEB128(methodInfo.index),
            );
          } else {
            // Dynamic dispatch
            const tempRight = ctx.declareLocal('$$eq_right', rightType);
            body.push(
              Opcode.local_set,
              ...WasmModule.encodeSignedLEB128(tempRight),
            );

            const tempLeft = ctx.declareLocal('$$eq_left', leftType);
            body.push(
              Opcode.local_tee,
              ...WasmModule.encodeSignedLEB128(tempLeft),
            );

            body.push(0xfb, GcOpcode.struct_get);
            body.push(
              ...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex),
            );
            body.push(
              ...WasmModule.encodeSignedLEB128(
                foundClass.fields.get('__vtable')!.index,
              ),
            );

            body.push(0xfb, GcOpcode.ref_cast_null);
            body.push(
              ...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex!),
            );

            const vtableIndex = foundClass.vtable!.indexOf('==');
            body.push(0xfb, GcOpcode.struct_get);
            body.push(
              ...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex!),
            );
            body.push(...WasmModule.encodeSignedLEB128(vtableIndex));

            body.push(0xfb, GcOpcode.ref_cast_null);
            body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

            const funcType = [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
            ];
            const tempFunc = ctx.declareLocal('$$eq_func', funcType);
            body.push(
              Opcode.local_set,
              ...WasmModule.encodeSignedLEB128(tempFunc),
            );

            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(tempLeft),
            );
            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(tempRight),
            );

            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(tempFunc),
            );
            body.push(
              Opcode.call_ref,
              ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
            );
          }
        }
      }

      if (!hasOperator) {
        body.push(Opcode.ref_eq);
      }

      if (expr.operator === '!=') {
        body.push(Opcode.i32_eqz);
      }
      return;
    }
  }

  // Check if operating on unsigned integers (u32)
  // The WASM type is still i32, but we need to use unsigned instructions
  const isU32 = (e: Expression): boolean => {
    if (e.inferredType && e.inferredType.kind === TypeKind.Number) {
      return (e.inferredType as NumberType).name === Types.U32.name;
    }
    return false;
  };
  const useUnsigned = isU32(expr.left) || isU32(expr.right);

  switch (expr.operator) {
    case '+':
      body.push(Opcode.i32_add);
      break;
    case '-':
      body.push(Opcode.i32_sub);
      break;
    case '*':
      body.push(Opcode.i32_mul);
      break;
    case '/':
      body.push(useUnsigned ? Opcode.i32_div_u : Opcode.i32_div_s);
      break;
    case '%':
      body.push(useUnsigned ? Opcode.i32_rem_u : Opcode.i32_rem_s);
      break;
    case '&':
      body.push(Opcode.i32_and);
      break;
    case '|':
      body.push(Opcode.i32_or);
      break;
    case '^':
      body.push(Opcode.i32_xor);
      break;
    case '==':
    case '===':
      body.push(Opcode.i32_eq);
      break;
    case '!=':
    case '!==':
      body.push(Opcode.i32_ne);
      break;
    case '<':
      body.push(useUnsigned ? Opcode.i32_lt_u : Opcode.i32_lt_s);
      break;
    case '<=':
      body.push(useUnsigned ? Opcode.i32_le_u : Opcode.i32_le_s);
      break;
    case '>':
      body.push(useUnsigned ? Opcode.i32_gt_u : Opcode.i32_gt_s);
      break;
    case '>=':
      body.push(useUnsigned ? Opcode.i32_ge_u : Opcode.i32_ge_s);
      break;
  }
}

function generateNumberLiteral(
  ctx: CodegenContext,
  expr: NumberLiteral,
  body: number[],
) {
  let isFloat = !Number.isInteger(expr.value);
  let isF64 = false;
  let isI64 = false;

  if (expr.inferredType && expr.inferredType.kind === TypeKind.Number) {
    const name = (expr.inferredType as NumberType).name;
    if (name === Types.F32.name) {
      isFloat = true;
    } else if (name === Types.F64.name) {
      isFloat = true;
      isF64 = true;
    } else if (name === Types.I64.name) {
      isI64 = true;
      isFloat = false;
    } else if (name === Types.I32.name) {
      isFloat = false;
    }
  }

  if (isFloat) {
    if (isF64) {
      body.push(Opcode.f64_const);
      body.push(...WasmModule.encodeF64(expr.value));
    } else {
      body.push(Opcode.f32_const);
      body.push(...WasmModule.encodeF32(expr.value));
    }
  } else {
    if (isI64) {
      body.push(Opcode.i64_const);
      body.push(...WasmModule.encodeSignedLEB128(BigInt(expr.value)));
    } else {
      body.push(Opcode.i32_const);
      body.push(...WasmModule.encodeSignedLEB128(expr.value));
    }
  }
}

function generateBooleanLiteral(
  ctx: CodegenContext,
  expr: BooleanLiteral,
  body: number[],
) {
  body.push(Opcode.i32_const);
  body.push(...WasmModule.encodeSignedLEB128(expr.value ? 1 : 0));
}

function generateIdentifier(
  ctx: CodegenContext,
  expr: Identifier,
  body: number[],
) {
  // Use resolved binding from the checker
  const binding = ctx.semanticContext.getResolvedBinding(expr);
  if (binding) {
    if (generateFromBinding(ctx, binding, body, expr.name)) {
      return;
    }
  }

  // No binding found - this is an error
  const message = `Unknown identifier: ${expr.name}`;
  ctx.reportError(message, DiagnosticCode.UnknownVariable, expr);
  throw new CompilerError(message);
}

/**
 * Generate code from a resolved binding using name-based lookup.
 * We use name-based lookup because declaration-based lookup can have stale
 * entries when the same AST is processed multiple times (e.g., generic method
 * instantiation). Name-based lookup within a single function scope is reliable.
 * Returns true if code was generated, false otherwise.
 */
function generateFromBinding(
  ctx: CodegenContext,
  binding: ResolvedBinding,
  body: number[],
  name: string,
): boolean {
  switch (binding.kind) {
    case 'local': {
      // Use name-based lookup - more reliable for generic method instantiation
      const local = ctx.getLocal(name);
      if (local) {
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(local.index));

        // If this is a boxed mutable capture, unbox it
        if (local.isBoxed && local.unboxedType) {
          const boxClass = getBoxClassInfo(
            ctx,
            wasmTypeToCheckerType(local.unboxedType),
          );
          const valueField = boxClass.fields.get(BOX_VALUE_FIELD);
          if (!valueField)
            throw new Error("Box class missing 'value' field");

          body.push(0xfb, GcOpcode.struct_get);
          body.push(...WasmModule.encodeSignedLEB128(boxClass.structTypeIndex));
          body.push(...WasmModule.encodeSignedLEB128(valueField.index));
        }

        return true;
      }
      return false;
    }
    case 'global': {
      // Try declaration-based lookup first for globals
      const index = ctx.getGlobalIndexByDecl(binding.declaration);
      if (index !== undefined) {
        body.push(Opcode.global_get);
        body.push(...WasmModule.encodeSignedLEB128(index));
        return true;
      }
      // Fall back to name-based lookup
      const global = ctx.getGlobal(name);
      if (global) {
        body.push(Opcode.global_get);
        body.push(...WasmModule.encodeSignedLEB128(global.index));
        return true;
      }
      return false;
    }
    case 'function': {
      // For function bindings that are being used as values (not called),
      // we need to create a function reference. This is typically handled
      // by generateFunctionExpression, so this case may not occur often.
      // Fall back to name-based for now.
      return false;
    }
    case 'class':
    case 'interface':
    case 'mixin':
    case 'type-alias':
    case 'type-parameter':
    case 'import': {
      // These binding kinds don't generate simple local/global gets.
      // They need special handling (constructors, type lookups, etc.)
      return false;
    }
    case 'field':
    case 'getter':
    case 'method':
    case 'record-field': {
      // Member bindings are handled by generateMemberFromBinding
      return false;
    }
    default:
      return false;
  }
}

/**
 * Generate code from a resolved member binding (field, getter, method, record-field).
 * Uses the binding's classType for O(1) identity-based class lookup.
 * Returns true if code was generated, false otherwise.
 */
function generateMemberFromBinding(
  ctx: CodegenContext,
  binding: FieldBinding | GetterBinding | MethodBinding | RecordFieldBinding,
  objectExpr: Expression,
  body: number[],
): boolean {
  switch (binding.kind) {
    case 'field':
      return generateFieldFromBinding(ctx, binding, objectExpr, body);
    case 'getter':
      return generateGetterFromBinding(ctx, binding, objectExpr, body);
    case 'method':
      // Method access without call - just stores type info, actual codegen
      // happens at call site. Return false to fall through.
      return false;
    case 'record-field':
      return generateRecordFieldFromBinding(ctx, binding, objectExpr, body);
    default:
      return false;
  }
}

/**
 * Generate code for a field access using the resolved FieldBinding.
 */
function generateFieldFromBinding(
  ctx: CodegenContext,
  binding: FieldBinding,
  objectExpr: Expression,
  body: number[],
): boolean {
  let {classType, fieldName} = binding;

  // Substitute type parameters in the classType when inside a generic context.
  // This is needed for field access like `entry.key` where `entry: Entry<K, V>`
  // and K, V need to be substituted with actual type arguments.
  if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
    classType = ctx.checkerContext.substituteTypeParams(
      classType,
      ctx.currentTypeArguments,
    ) as ClassType;
  }

  // Handle interface field access
  if (classType.kind === TypeKind.Interface) {
    return generateInterfaceFieldAccess(
      ctx,
      classType as InterfaceType,
      fieldName,
      binding.type,
      objectExpr,
      body,
    );
  }

  // Handle well-known intrinsics for extension classes before looking up ClassInfo.
  // This is needed because generic extension classes like FixedArray<T> may not have
  // their ClassInfo registered (they skip registerClassMethods due to being generic).
  // For these well-known cases, we can generate the intrinsic directly.
  if (classType.isExtension && classType.name === 'FixedArray') {
    if (fieldName === 'length') {
      // FixedArray.length -> array.len intrinsic
      generateExpression(ctx, objectExpr, body);
      body.push(0xfb, GcOpcode.array_len);
      return true;
    }
  }

  // Handle mixin's synthetic `This` type.
  // When a mixin method accesses `this.field`, the binding's classType is the mixin's
  // synthetic `This` type (e.g., `M_This`). This ClassType exists only in the checker;
  // it doesn't have a corresponding ClassInfo in codegen. Use ctx.currentClass instead
  // since we're generating code inside the concrete class that has the mixin applied.
  if (
    classType.isSyntheticMixinThis &&
    ctx.currentClass &&
    objectExpr.type === NodeType.ThisExpression
  ) {
    // For `this.x` in a mixin method, use the concrete class's field
    // For private fields, the binding's fieldName is like 'M_This::#val' (mixin's synthetic name)
    // but the ClassInfo stores it as 'C::#val' (concrete class name). Extract the private part
    // and rebuild with the concrete class name.
    let actualFieldName = fieldName;
    let fieldInfo = ctx.currentClass.fields.get(actualFieldName);

    // Try with mangled private field name - strip mixin prefix and use concrete class name
    if (!fieldInfo && fieldName.includes('::#')) {
      // fieldName is like 'M_This::#val', extract '::#val' and prepend concrete class name
      const privatePart = fieldName.slice(fieldName.indexOf('::#'));
      actualFieldName = `${ctx.currentClass.name}${privatePart}`;
      fieldInfo = ctx.currentClass.fields.get(actualFieldName);
    }

    // Also try the simple private field case (just '#val')
    if (!fieldInfo && fieldName.startsWith('#')) {
      actualFieldName = `${ctx.currentClass.name}::${fieldName}`;
      fieldInfo = ctx.currentClass.fields.get(actualFieldName);
    }

    if (fieldInfo) {
      // Handle intrinsic fields
      if (fieldInfo.intrinsic) {
        generateIntrinsic(ctx, fieldInfo.intrinsic, objectExpr, [], body);
        return true;
      }

      // Generate the object expression
      generateExpression(ctx, objectExpr, body);

      // Emit struct.get
      body.push(0xfb, GcOpcode.struct_get);
      body.push(
        ...WasmModule.encodeSignedLEB128(ctx.currentClass.structTypeIndex),
      );
      body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
      return true;
    }
    // Fall back to existing logic - mixin synthetic This without field info
    return false;
  }

  // If the binding's classType has unresolved type parameters (e.g., FixedArray<T>),
  // let the existing mapCheckerTypeToWasmType and extension class lookup handle it.
  // For private fields, use ctx.currentClass directly - we're inside the class
  // that owns this private field, so we know exactly which ClassInfo to use.
  // The binding stores the checker's class name, but codegen uses bundled names.
  if (fieldName.includes('::#') && ctx.currentClass) {
    const classInfo = ctx.currentClass;
    // Extract the private part (e.g., "::#length") and rebuild with bundled name
    const privatePart = fieldName.slice(fieldName.indexOf('::#'));
    const lookupName = `${classInfo.name}${privatePart}`;

    const fieldInfo = classInfo.fields.get(lookupName);
    if (!fieldInfo) {
      throw new Error(
        `Private field ${lookupName} not found in class ${classInfo.name}`,
      );
    }

    // Handle intrinsic fields
    if (fieldInfo.intrinsic) {
      generateIntrinsic(ctx, fieldInfo.intrinsic, objectExpr, [], body);
      return true;
    }

    // Generate the object expression
    generateExpression(ctx, objectExpr, body);

    // Cast if needed (e.g., from anyref)
    const objectType = inferType(ctx, objectExpr);
    const isAnyRef =
      objectType.length === 1 && objectType[0] === ValType.anyref;
    if (isAnyRef) {
      body.push(0xfb, GcOpcode.ref_cast_null);
      body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
    }

    // Emit struct.get
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
    return true;
  }

  // Ensure we use the interned version of the classType for identity-based lookup.
  // This is critical because bindings may have a classType that's structurally equal
  // but not the same object as the one registered during instantiation.
  if (
    classType.genericSource &&
    classType.typeArguments &&
    classType.typeArguments.length > 0
  ) {
    const interned = ctx.checkerContext.getInternedClass(
      classType.genericSource,
      classType.typeArguments,
    );
    if (interned) {
      classType = interned;
    }
  }

  // Look up the class info using O(1) identity-based lookup
  let classInfo = ctx.getClassInfo(classType);

  // If identity lookup fails (e.g., generic instantiation not yet done), instantiate it
  if (
    !classInfo &&
    classType.typeArguments &&
    classType.typeArguments.length > 0
  ) {
    // mapCheckerTypeToWasmType will instantiate and register the class.
    // Since we already interned the classType above, the registered ClassInfo
    // will use the same object, so we can retry identity lookup.
    mapCheckerTypeToWasmType(ctx, classType);
    classInfo = ctx.getClassInfo(classType);
  }

  // For generic extension classes that weren't found through normal lookups,
  // try to create a ClassInfo on-the-fly. This is needed because generic extension classes
  // (like FixedArray<T>) skip registerClassMethods and may not have been registered yet.
  if (!classInfo && classType.isExtension) {
    const genericSource = classType.genericSource ?? classType;
    const genericDecl = ctx.getGenericDeclaration(genericSource);
    if (genericDecl && genericDecl.isExtension && genericDecl.onType) {
      const onType = mapCheckerTypeToWasmType(ctx, classType.onType!);

      // Create a dummy struct type for extensions
      const structTypeIndex = ctx.module.addStructType([]);

      classInfo = {
        name: genericDecl.name.name,
        structTypeIndex,
        fields: new Map(),
        methods: new Map(),
        isExtension: true,
        onType,
        onTypeAnnotation: genericDecl.onType,
      };

      // Register it so we don't recreate it next time
      ctx.setClassInfoByStructIndex(structTypeIndex, classInfo);
      if (classType) {
        ctx.registerClassInfo(classType, classInfo);
      }
    }
  }

  if (!classInfo) {
    // This is an error - we should have found the class info.
    // Common causes:
    // - Generic extension class without registered ClassInfo (handled above for known intrinsics)
    // - Interface field access (should have returned false above)
    return false;
  }

  // For public fields, codegen creates implicit getters that go through vtable dispatch.
  // Check if there's a getter method for this field.
  if (!fieldName.startsWith('#')) {
    const getterName = getGetterName(fieldName);
    const methodInfo = classInfo.methods.get(getterName);
    if (methodInfo) {
      // Use getter with appropriate dispatch
      // Determine static vs dynamic dispatch: final class, final method (field), or extension
      const useStaticDispatch =
        classInfo.isFinal || methodInfo.isFinal || classInfo.isExtension;

      if (methodInfo.intrinsic) {
        generateIntrinsic(ctx, methodInfo.intrinsic, objectExpr, [], body);
        return true;
      }

      if (useStaticDispatch) {
        // Static dispatch - direct call
        generateExpression(ctx, objectExpr, body);
        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
        return true;
      } else {
        // Dynamic dispatch via vtable
        const objectType = inferType(ctx, objectExpr);
        generateExpression(ctx, objectExpr, body);

        // Cast if object is anyref
        const isAnyRef =
          objectType.length === 1 && objectType[0] === ValType.anyref;
        if (isAnyRef) {
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          );
        }

        // Use the struct type for the temp local
        const tempThisType = isAnyRef
          ? [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
            ]
          : objectType;
        const tempThis = ctx.declareLocal('$$temp_this', tempThisType);
        body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempThis));

        // Load VTable
        if (!classInfo.vtable || classInfo.vtableTypeIndex === undefined) {
          throw new Error(`Class ${classInfo.name} has no vtable`);
        }

        body.push(0xfb, GcOpcode.struct_get);
        body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
        body.push(
          ...WasmModule.encodeSignedLEB128(
            classInfo.fields.get('__vtable')!.index,
          ),
        );

        // Cast VTable to correct type
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...WasmModule.encodeSignedLEB128(classInfo.vtableTypeIndex));

        // Load function pointer from VTable
        const vtableIndex = classInfo.vtable.indexOf(getterName);
        if (vtableIndex === -1) {
          throw new Error(`Getter ${getterName} not found in vtable`);
        }

        body.push(0xfb, GcOpcode.struct_get);
        body.push(...WasmModule.encodeSignedLEB128(classInfo.vtableTypeIndex));
        body.push(...WasmModule.encodeSignedLEB128(vtableIndex));

        // Cast to specific function type
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

        // Store func_ref
        const funcRefType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        ];
        const funcRef = ctx.declareLocal('$$func_ref', funcRefType);
        body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(funcRef));

        // Call function: [this, func_ref]
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempThis));
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRef));
        body.push(
          Opcode.call_ref,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        );
        return true;
      }
    }
  }

  // Look up the field by name (for private fields or fields without getters)
  const fieldInfo = classInfo.fields.get(fieldName);
  if (!fieldInfo) {
    return false;
  }

  // Handle intrinsic fields
  if (fieldInfo.intrinsic) {
    generateIntrinsic(ctx, fieldInfo.intrinsic, objectExpr, [], body);
    return true;
  }

  // Generate the object expression
  generateExpression(ctx, objectExpr, body);

  // Cast if needed (e.g., from anyref)
  const objectType = inferType(ctx, objectExpr);
  const isAnyRef = objectType.length === 1 && objectType[0] === ValType.anyref;
  if (isAnyRef) {
    body.push(0xfb, GcOpcode.ref_cast_null);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
  }

  // Emit struct.get
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
  return true;
}

/**
 * Generate code for interface field access via vtable dispatch.
 * Interface fields are accessed via getters in the vtable.
 */
function generateInterfaceFieldAccess(
  ctx: CodegenContext,
  interfaceType: InterfaceType,
  fieldName: string,
  expectedType: Type,
  objectExpr: Expression,
  body: number[],
): boolean {
  // Look up InterfaceInfo using identity-based lookup (no name-based fallback)
  const interfaceInfo = ctx.getInterfaceInfo(interfaceType);
  if (!interfaceInfo) {
    throw new Error(
      `Interface not registered via identity lookup: ${interfaceType.name}`,
    );
  }

  return generateInterfaceFieldAccessWithInfo(
    ctx,
    interfaceInfo,
    fieldName,
    expectedType,
    objectExpr,
    body,
  );
}

/**
 * Generate interface field access code given the InterfaceInfo.
 */
function generateInterfaceFieldAccessWithInfo(
  ctx: CodegenContext,
  interfaceInfo: InterfaceInfo,
  fieldName: string,
  expectedType: Type,
  objectExpr: Expression,
  body: number[],
): boolean {
  // Look up field or getter in the interface
  let fieldInfo = interfaceInfo.fields.get(fieldName);
  let targetTypeIndex = -1;

  if (fieldInfo) {
    targetTypeIndex = fieldInfo.typeIndex;
  } else {
    // Check for getter
    const getterName = getGetterName(fieldName);
    const methodInfo = interfaceInfo.methods.get(getterName);
    if (methodInfo) {
      fieldInfo = {
        index: methodInfo.index,
        typeIndex: methodInfo.typeIndex,
        type: methodInfo.returnType,
      };
      targetTypeIndex = methodInfo.typeIndex;
    }
  }

  if (!fieldInfo) {
    throw new Error(`Field ${fieldName} not found in interface`);
  }

  // Generate the object expression
  generateExpression(ctx, objectExpr, body);

  // Get the object type for the temp local
  const objectType = inferType(ctx, objectExpr);

  // 1. Store interface struct in temp local to access fields
  const tempLocal = ctx.declareLocal('$$interface_temp', objectType);
  body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempLocal));

  // 2. Load VTable (at index 1 in interface struct)
  body.push(
    0xfb,
    GcOpcode.struct_get,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
    ...WasmModule.encodeSignedLEB128(1),
  );

  // 3. Load Function Pointer from VTable
  body.push(
    0xfb,
    GcOpcode.struct_get,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
    ...WasmModule.encodeSignedLEB128(fieldInfo.index),
  );

  // 4. Cast to specific function type
  body.push(
    0xfb,
    GcOpcode.ref_cast_null,
    ...WasmModule.encodeSignedLEB128(targetTypeIndex),
  );

  // Store funcRef in temp local
  const funcRefType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(targetTypeIndex),
  ];
  const funcRefLocal = ctx.declareLocal('$$interface_getter', funcRefType);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(funcRefLocal));

  // 5. Load Instance from Interface Struct (at index 0)
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempLocal));
  body.push(
    0xfb,
    GcOpcode.struct_get,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
    ...WasmModule.encodeSignedLEB128(0),
  );

  // Load funcRef
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRefLocal));

  // 6. Call Getter via call_ref
  body.push(Opcode.call_ref, ...WasmModule.encodeSignedLEB128(targetTypeIndex));

  // 7. Handle return value adaptation (unbox if needed)
  const actualType = fieldInfo.type;
  if (actualType.length === 1 && actualType[0] === ValType.anyref) {
    const wasmExpectedType = mapCheckerTypeToWasmType(ctx, expectedType);
    if (
      wasmExpectedType.length === 1 &&
      (wasmExpectedType[0] === ValType.i32 ||
        wasmExpectedType[0] === ValType.i64 ||
        wasmExpectedType[0] === ValType.f32 ||
        wasmExpectedType[0] === ValType.f64)
    ) {
      unboxPrimitive(ctx, wasmExpectedType, body);
    } else if (
      wasmExpectedType.length > 1 &&
      (wasmExpectedType[0] === ValType.ref ||
        wasmExpectedType[0] === ValType.ref_null)
    ) {
      body.push(0xfb, GcOpcode.ref_cast_null);
      body.push(...wasmExpectedType.slice(1));
    }
  }

  return true;
}

/**
 * Generate code for interface getter access via vtable dispatch.
 * Interface getters are accessed via the method vtable.
 */
function generateInterfaceGetterAccess(
  ctx: CodegenContext,
  interfaceType: InterfaceType,
  methodName: string,
  expectedType: Type,
  objectExpr: Expression,
  body: number[],
): boolean {
  // Look up InterfaceInfo using identity-based lookup (no name-based fallback)
  const interfaceInfo = ctx.getInterfaceInfo(interfaceType);
  if (!interfaceInfo) {
    throw new Error(
      `Interface not registered via identity lookup: ${interfaceType.name}`,
    );
  }

  // Look up the getter method in the interface
  const methodInfo = interfaceInfo.methods.get(methodName);
  if (!methodInfo) {
    throw new Error(
      `Getter ${methodName} not found in interface ${interfaceType.name}`,
    );
  }

  // Generate the object expression
  generateExpression(ctx, objectExpr, body);

  // Get the object type for the temp local
  const objectType = inferType(ctx, objectExpr);

  // 1. Store interface struct in temp local to access fields
  const tempLocal = ctx.declareLocal('$$interface_temp', objectType);
  body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempLocal));

  // 2. Load VTable (at index 1 in interface struct)
  body.push(
    0xfb,
    GcOpcode.struct_get,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
    ...WasmModule.encodeSignedLEB128(1),
  );

  // 3. Load Function Pointer from VTable
  body.push(
    0xfb,
    GcOpcode.struct_get,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
    ...WasmModule.encodeSignedLEB128(methodInfo.index),
  );

  // 4. Cast to specific function type
  body.push(
    0xfb,
    GcOpcode.ref_cast_null,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  );

  // Store funcRef in temp local
  const funcRefType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  ];
  const funcRefLocal = ctx.declareLocal('$$interface_getter', funcRefType);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(funcRefLocal));

  // 5. Load Instance from Interface Struct (at index 0)
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempLocal));
  body.push(
    0xfb,
    GcOpcode.struct_get,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
    ...WasmModule.encodeSignedLEB128(0),
  );

  // Load funcRef
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRefLocal));

  // 6. Call Getter via call_ref
  body.push(
    Opcode.call_ref,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  );

  // 7. Handle return value adaptation (unbox if needed)
  const actualType = methodInfo.returnType;
  if (actualType.length === 1 && actualType[0] === ValType.anyref) {
    const wasmExpectedType = mapCheckerTypeToWasmType(ctx, expectedType);
    if (
      wasmExpectedType.length === 1 &&
      (wasmExpectedType[0] === ValType.i32 ||
        wasmExpectedType[0] === ValType.i64 ||
        wasmExpectedType[0] === ValType.f32 ||
        wasmExpectedType[0] === ValType.f64)
    ) {
      unboxPrimitive(ctx, wasmExpectedType, body);
    } else if (
      wasmExpectedType.length > 1 &&
      (wasmExpectedType[0] === ValType.ref ||
        wasmExpectedType[0] === ValType.ref_null)
    ) {
      body.push(0xfb, GcOpcode.ref_cast_null);
      body.push(...wasmExpectedType.slice(1));
    }
  }

  return true;
}

/**
 * Generate dynamic dispatch code for a getter via vtable.
 */
function generateGetterDynamicDispatch(
  ctx: CodegenContext,
  classInfo: ClassInfo,
  methodName: string,
  methodInfo: {index: number; typeIndex: number},
  objectExpr: Expression,
  body: number[],
): void {
  const objectType = inferType(ctx, objectExpr);
  generateExpression(ctx, objectExpr, body);

  // Cast if object is anyref
  const isAnyRef = objectType.length === 1 && objectType[0] === ValType.anyref;
  if (isAnyRef) {
    body.push(0xfb, GcOpcode.ref_cast_null);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
  }

  // Use the struct type for the temp local
  const tempThisType = isAnyRef
    ? [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
      ]
    : objectType;
  const tempThis = ctx.declareLocal('$$temp_this', tempThisType);
  body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempThis));

  // Load VTable
  if (!classInfo.vtable || classInfo.vtableTypeIndex === undefined) {
    throw new Error(`Class ${classInfo.name} has no vtable`);
  }

  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
  body.push(
    ...WasmModule.encodeSignedLEB128(classInfo.fields.get('__vtable')!.index),
  );

  // Cast VTable to correct type
  body.push(0xfb, GcOpcode.ref_cast_null);
  body.push(...WasmModule.encodeSignedLEB128(classInfo.vtableTypeIndex));

  // Load function pointer from VTable
  const vtableIndex = classInfo.vtable.indexOf(methodName);
  if (vtableIndex === -1) {
    throw new Error(`Method ${methodName} not found in vtable`);
  }

  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(classInfo.vtableTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(vtableIndex));

  // Cast to specific function type
  body.push(0xfb, GcOpcode.ref_cast_null);
  body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

  // Store func_ref
  const funcRefType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  ];
  const funcRef = ctx.declareLocal('$$func_ref', funcRefType);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(funcRef));

  // Call function: [this, func_ref]
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempThis));
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRef));
  body.push(
    Opcode.call_ref,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  );
}

/**
 * Generate code for a getter access using the resolved GetterBinding.
 */
function generateGetterFromBinding(
  ctx: CodegenContext,
  binding: GetterBinding,
  objectExpr: Expression,
  body: number[],
): boolean {
  let {classType, methodName, isStaticDispatch} = binding;

  // Substitute type parameters in the classType when inside a generic context.
  // This is needed for getter access like `items.length` where `items: Array<T>`
  // and T needs to be substituted with actual type arguments.
  if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
    classType = ctx.checkerContext.substituteTypeParams(
      classType,
      ctx.currentTypeArguments,
    ) as ClassType;
  }

  // Handle interface getter access
  if (classType.kind === TypeKind.Interface) {
    return generateInterfaceGetterAccess(
      ctx,
      classType as InterfaceType,
      methodName,
      binding.type,
      objectExpr,
      body,
    );
  }

  // For getter access on `this` inside the class being defined, use ctx.currentClass
  // This handles cases where the binding's classType was created inside a generic class
  // and doesn't match any registered instantiation.
  if (
    ctx.currentClass &&
    objectExpr.type === NodeType.ThisExpression &&
    ctx.currentClass.methods.has(methodName)
  ) {
    const methodInfo = ctx.currentClass.methods.get(methodName)!;
    // Handle intrinsic getters
    if (methodInfo.intrinsic) {
      generateIntrinsic(ctx, methodInfo.intrinsic, objectExpr, [], body);
      return true;
    }

    if (isStaticDispatch) {
      generateExpression(ctx, objectExpr, body);
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
    } else {
      // Dynamic dispatch - use ctx.currentClass for vtable info
      generateGetterDynamicDispatch(
        ctx,
        ctx.currentClass,
        methodName,
        methodInfo,
        objectExpr,
        body,
      );
    }
    return true;
  }

  // Look up the class info using O(1) identity-based lookup

  // Ensure we use the interned version of the classType for identity-based lookup.
  // This is critical because bindings may have a classType that's structurally equal
  // but not the same object as the one registered during instantiation.
  if (
    classType.genericSource &&
    classType.typeArguments &&
    classType.typeArguments.length > 0
  ) {
    const interned = ctx.checkerContext.getInternedClass(
      classType.genericSource,
      classType.typeArguments,
    );
    if (interned) {
      classType = interned;
    }
  }

  let classInfo = ctx.getClassInfo(classType);

  // If identity lookup fails (e.g., generic instantiation not yet done), instantiate it
  if (
    !classInfo &&
    classType.typeArguments &&
    classType.typeArguments.length > 0
  ) {
    // mapCheckerTypeToWasmType will instantiate and register the class.
    // Since we already interned the classType above, the registered ClassInfo
    // will use the same object, so we can retry identity lookup.
    mapCheckerTypeToWasmType(ctx, classType);
    classInfo = ctx.getClassInfo(classType);
  }

  if (!classInfo) {
    return false;
  }

  // Look up the getter method
  const methodInfo = classInfo.methods.get(methodName);
  if (!methodInfo) {
    return false;
  }

  // Handle intrinsic getters
  if (methodInfo.intrinsic) {
    generateIntrinsic(ctx, methodInfo.intrinsic, objectExpr, [], body);
    return true;
  }

  if (isStaticDispatch) {
    // Static dispatch - direct call
    generateExpression(ctx, objectExpr, body);
    body.push(Opcode.call);
    body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
  } else {
    // Dynamic dispatch via vtable
    generateGetterDynamicDispatch(
      ctx,
      classInfo,
      methodName,
      methodInfo,
      objectExpr,
      body,
    );
  }
  return true;
}

/**
 * Generate code for a record field access using the resolved RecordFieldBinding.
 */
function generateRecordFieldFromBinding(
  ctx: CodegenContext,
  binding: RecordFieldBinding,
  objectExpr: Expression,
  body: number[],
): boolean {
  const {recordType, fieldName} = binding;

  // Get the struct type index for this record type
  const objectType = inferType(ctx, objectExpr);
  const structTypeIndex = getHeapTypeIndex(ctx, objectType);

  if (structTypeIndex === -1) {
    return false;
  }

  // Check if this is an enum access - enums have special handling
  if (ctx.enums.has(structTypeIndex)) {
    const enumInfo = ctx.enums.get(structTypeIndex)!;
    if (enumInfo.members.has(fieldName)) {
      const fieldIndex = enumInfo.members.get(fieldName)!;

      // Push the enum instance (struct) onto the stack
      generateExpression(ctx, objectExpr, body);

      // Emit struct.get
      body.push(
        Opcode.gc_prefix,
        GcOpcode.struct_get,
        ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ...WasmModule.encodeSignedLEB128(fieldIndex),
      );
      return true;
    }
    // Field not found in enum - fall back
    return false;
  }

  // Regular record field access
  // Find field index by iterating through record properties (sorted by name)
  const properties = Array.from(recordType.properties.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const fieldIndex = properties.findIndex(([name]) => name === fieldName);
  if (fieldIndex === -1) {
    return false;
  }

  generateExpression(ctx, objectExpr, body);
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(fieldIndex));
  return true;
}

function generateStringLiteral(
  ctx: CodegenContext,
  expr: StringLiteral,
  body: number[],
) {
  let dataIndex: number;
  if (ctx.stringLiterals.has(expr.value)) {
    dataIndex = ctx.stringLiterals.get(expr.value)!;
  } else {
    const bytes = new TextEncoder().encode(expr.value);
    dataIndex = ctx.module.addData(bytes);
    ctx.stringLiterals.set(expr.value, dataIndex);
  }

  // array.new_data $byteArrayType $dataIndex
  // Stack: [offset, length] -> [ref]
  body.push(Opcode.i32_const, 0); // offset
  body.push(
    Opcode.i32_const,
    ...WasmModule.encodeSignedLEB128(expr.value.length),
  ); // length

  body.push(0xfb, GcOpcode.array_new_data);
  body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(dataIndex));
}

function generateStringEq(ctx: CodegenContext, body: number[]) {
  if (ctx.strEqFunctionIndex === -1) {
    ctx.strEqFunctionIndex = generateStrEqFunction(ctx);
  }
  body.push(Opcode.call);
  body.push(...WasmModule.encodeSignedLEB128(ctx.strEqFunctionIndex));
}

function generateStringConcat(ctx: CodegenContext, body: number[]) {
  if (ctx.concatFunctionIndex === -1) {
    ctx.concatFunctionIndex = generateConcatFunction(ctx);
  }
  body.push(Opcode.call);
  body.push(...WasmModule.encodeSignedLEB128(ctx.concatFunctionIndex));
}

function generateConcatFunction(ctx: CodegenContext): number {
  const stringType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
  ];
  const typeIndex = ctx.module.addType([stringType, stringType], [stringType]);

  const funcIndex = ctx.module.addFunction(typeIndex);

  ctx.pendingHelperFunctions.push(() => {
    const locals: number[][] = [
      [ValType.i32], // len1 (local 0)
      [ValType.i32], // len2 (local 1)
      [ValType.i32], // newLen (local 2)
      [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex),
      ], // newBytes (local 3)
    ];
    const body: number[] = [];

    // Params: s1 (0), s2 (1)
    // Locals: len1 (2), len2 (3), newLen (4), newBytes (5)

    // len1 = s1.length
    body.push(Opcode.local_get, 0);
    body.push(0xfb, GcOpcode.array_len);
    body.push(Opcode.local_set, 2);

    // len2 = s2.length
    body.push(Opcode.local_get, 1);
    body.push(0xfb, GcOpcode.array_len);
    body.push(Opcode.local_set, 3);

    // newLen = len1 + len2
    body.push(Opcode.local_get, 2);
    body.push(Opcode.local_get, 3);
    body.push(Opcode.i32_add);
    body.push(Opcode.local_set, 4);

    // newBytes = array.new_default(newLen)
    body.push(Opcode.local_get, 4);
    body.push(0xfb, GcOpcode.array_new_default);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));
    body.push(Opcode.local_set, 5);

    // array.copy(dest=newBytes, destOffset=0, src=s1, srcOffset=0, len=len1)
    body.push(Opcode.local_get, 5); // dest
    body.push(Opcode.i32_const, 0); // destOffset

    // src = s1
    body.push(Opcode.local_get, 0);

    body.push(Opcode.i32_const, 0); // srcOffset
    body.push(Opcode.local_get, 2); // len
    body.push(0xfb, GcOpcode.array_copy);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // array.copy(dest=newBytes, destOffset=len1, src=s2, srcOffset=0, len=len2)
    body.push(Opcode.local_get, 5); // dest
    body.push(Opcode.local_get, 2); // destOffset

    // src = s2
    body.push(Opcode.local_get, 1);

    body.push(Opcode.i32_const, 0); // srcOffset
    body.push(Opcode.local_get, 3); // len
    body.push(0xfb, GcOpcode.array_copy);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // return newBytes
    body.push(Opcode.local_get, 5);

    body.push(Opcode.end);

    ctx.module.addCode(funcIndex, locals, body);
  });

  return funcIndex;
}

function generateStrEqFunction(ctx: CodegenContext): number {
  const stringType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
  ];
  const typeIndex = ctx.module.addType(
    [stringType, stringType],
    [[ValType.i32]],
  );

  const funcIndex = ctx.module.addFunction(typeIndex);

  ctx.pendingHelperFunctions.push(() => {
    const locals: number[][] = [
      [ValType.i32], // len1 (local 0)
      [ValType.i32], // len2 (local 1)
      [ValType.i32], // i (local 2)
    ];
    const body: number[] = [];

    // Params: s1 (0), s2 (1)
    // Locals: len1 (2), len2 (3), i (4)

    // len1 = s1.length
    body.push(Opcode.local_get, 0);
    body.push(0xfb, GcOpcode.array_len);
    body.push(Opcode.local_set, 2);

    // len2 = s2.length
    body.push(Opcode.local_get, 1);
    body.push(0xfb, GcOpcode.array_len);
    body.push(Opcode.local_set, 3);

    // if len1 != len2 return 0
    body.push(Opcode.local_get, 2);
    body.push(Opcode.local_get, 3);
    body.push(Opcode.i32_ne);
    body.push(Opcode.if, ValType.void);
    body.push(Opcode.i32_const, 0);
    body.push(Opcode.return);
    body.push(Opcode.end);

    // loop i from 0 to len1
    body.push(Opcode.i32_const, 0);
    body.push(Opcode.local_set, 4); // i = 0

    body.push(Opcode.block, ValType.void);
    body.push(Opcode.loop, ValType.void);

    // if i == len1 break
    body.push(Opcode.local_get, 4);
    body.push(Opcode.local_get, 2);
    body.push(Opcode.i32_ge_u);
    body.push(Opcode.br_if, 1); // break to block

    // if s1[i] != s2[i] return 0

    // s1
    body.push(Opcode.local_get, 0);

    body.push(Opcode.local_get, 4); // i
    body.push(0xfb, GcOpcode.array_get_u);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // s2
    body.push(Opcode.local_get, 1);

    body.push(Opcode.local_get, 4); // i
    body.push(0xfb, GcOpcode.array_get_u);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    body.push(Opcode.i32_ne);
    body.push(Opcode.if, ValType.void);
    body.push(Opcode.i32_const, 0);
    body.push(Opcode.return);
    body.push(Opcode.end);

    // i++
    body.push(Opcode.local_get, 4);
    body.push(Opcode.i32_const, 1);
    body.push(Opcode.i32_add);
    body.push(Opcode.local_set, 4);

    body.push(Opcode.br, 0); // continue loop
    body.push(Opcode.end); // end loop
    body.push(Opcode.end); // end block

    // return 1
    body.push(Opcode.i32_const, 1);
    body.push(Opcode.end);

    ctx.module.addCode(funcIndex, locals, body);
  });

  return funcIndex;
}

/**
 * Generates a helper function to get a byte from a string by index.
 * This function takes a string as externref (for efficient JS interop)
 * and returns the byte at the given index as i32.
 *
 * Generated WASM:
 * (func $stringGetByte (export "$stringGetByte") (param externref i32) (result i32)
 *   local.get 0
 *   any.convert_extern
 *   ref.cast $String
 *   struct.get $String 1  ;; bytes field
 *   local.get 1
 *   array.get_u $ByteArray)
 */
export function generateStringGetByteFunction(ctx: CodegenContext): number {
  // Type: (externref, i32) -> i32
  const typeIndex = ctx.module.addType(
    [[ValType.externref], [ValType.i32]],
    [[ValType.i32]],
  );

  const funcIndex = ctx.module.addFunction(typeIndex);

  // Export the function as "$stringGetByte"
  ctx.module.addExport('$stringGetByte', ExportDesc.Func, funcIndex);

  ctx.pendingHelperFunctions.push(() => {
    const locals: number[][] = [];
    const body: number[] = [];

    // local.get 0 (externref param)
    body.push(Opcode.local_get, 0);

    // any.convert_extern (externref -> anyref)
    body.push(0xfb, GcOpcode.any_convert_extern);

    // ref.cast $ByteArray (String is ByteArray)
    body.push(0xfb, GcOpcode.ref_cast);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // local.get 1 (index param)
    body.push(Opcode.local_get, 1);

    // array.get_u $ByteArray
    body.push(0xfb, GcOpcode.array_get_u);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    body.push(Opcode.end);

    ctx.module.addCode(funcIndex, locals, body);
  });

  return funcIndex;
}

/**
 * Generates a helper function to get the length of a string.
 * This function takes a string as externref (for efficient JS interop)
 * and returns the length as i32.
 *
 * Generated WASM:
 * (func $stringGetLength (export "$stringGetLength") (param externref) (result i32)
 *   local.get 0
 *   any.convert_extern
 *   ref.cast $ByteArray
 *   array.len)
 */
export function generateStringGetLengthFunction(ctx: CodegenContext): number {
  // Type: (externref) -> i32
  const typeIndex = ctx.module.addType([[ValType.externref]], [[ValType.i32]]);

  const funcIndex = ctx.module.addFunction(typeIndex);

  // Export the function as "$stringGetLength"
  ctx.module.addExport('$stringGetLength', ExportDesc.Func, funcIndex);

  ctx.pendingHelperFunctions.push(() => {
    const locals: number[][] = [];
    const body: number[] = [];

    // local.get 0 (externref param)
    body.push(Opcode.local_get, 0);

    // any.convert_extern
    body.push(0xfb, GcOpcode.any_convert_extern);

    // ref.cast $ByteArray
    body.push(0xfb, GcOpcode.ref_cast);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // array.len
    body.push(0xfb, GcOpcode.array_len);

    body.push(Opcode.end);

    ctx.module.addCode(funcIndex, locals, body);
  });

  return funcIndex;
}

function generateRecordLiteral(
  ctx: CodegenContext,
  expr: RecordLiteral,
  body: number[],
) {
  let typeIndex: number;
  if (expr.inferredType) {
    const wasmType = mapCheckerTypeToWasmType(ctx, expr.inferredType);
    typeIndex = decodeTypeIndex(wasmType);
  } else {
    throw new Error('Record literal must have inferred type');
  }

  // 1. Evaluate spread expressions and store in locals
  const spreadLocals = new Map<any, {index: number; typeIndex: number}>();

  for (const prop of expr.properties) {
    if (prop.type === NodeType.SpreadElement) {
      generateExpression(ctx, prop.argument, body);
      const spreadType = inferType(ctx, prop.argument);
      const spreadTypeIndex = decodeTypeIndex(spreadType);

      // Allocate temp local
      const localIndex = ctx.declareLocal(
        `$$spread_${ctx.nextLocalIndex}`,
        spreadType,
      );
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeSignedLEB128(localIndex));

      spreadLocals.set(prop, {index: localIndex, typeIndex: spreadTypeIndex});
    }
  }

  // 2. Get target fields from inferred type
  if (!expr.inferredType || expr.inferredType.kind !== TypeKind.Record) {
    throw new Error('Invalid record type');
  }

  const recordType = expr.inferredType as RecordType;
  // Sort keys to match canonical order
  const targetKeys = Array.from(recordType.properties.keys()).sort();

  // 3. Generate values for each target field
  for (const key of targetKeys) {
    // Find the source for this key
    // Iterate properties in reverse
    let found = false;
    for (let i = expr.properties.length - 1; i >= 0; i--) {
      const prop = expr.properties[i];
      if (prop.type === NodeType.PropertyAssignment) {
        if (prop.name.name === key) {
          generateExpression(ctx, prop.value, body);
          found = true;
          break;
        }
      } else if (prop.type === NodeType.SpreadElement) {
        // Check if spread type has this key
        const spreadType = prop.argument.inferredType;

        if (spreadType && spreadType.kind === TypeKind.Record) {
          const recordType = spreadType as RecordType;
          if (recordType.properties.has(key)) {
            // Found it in spread
            const spreadInfo = spreadLocals.get(prop)!;

            // Calculate field index in spread type
            // Spread type fields are also sorted alphabetically
            const spreadKeys = Array.from(recordType.properties.keys()).sort();
            const fieldIndex = spreadKeys.indexOf(key);

            if (fieldIndex !== -1) {
              body.push(Opcode.local_get);
              body.push(...WasmModule.encodeSignedLEB128(spreadInfo.index));

              body.push(0xfb, GcOpcode.struct_get);
              body.push(...WasmModule.encodeSignedLEB128(spreadInfo.typeIndex));
              body.push(...WasmModule.encodeSignedLEB128(fieldIndex));

              found = true;
              break;
            }
          }
        } else if (spreadType && spreadType.kind === TypeKind.Class) {
          const classType = spreadType as ClassType;
          if (classType.fields.has(key) && !key.startsWith('#')) {
            const spreadInfo = spreadLocals.get(prop)!;
            // Use identity-based lookup (O(1) via WeakMap), fall back to struct index lookup
            let classInfo = ctx.getClassInfo(classType);
            if (!classInfo) {
              classInfo = ctx.getClassInfo(classType);
            }
            if (!classInfo) {
              throw new Error(`Class info not found for ${classType.name}`);
            }

            const fieldInfo = classInfo.fields.get(key);
            if (!fieldInfo) {
              throw new Error(
                `Field info not found for ${key} in ${classType.name}`,
              );
            }

            body.push(Opcode.local_get);
            body.push(...WasmModule.encodeSignedLEB128(spreadInfo.index));

            body.push(0xfb, GcOpcode.struct_get);
            body.push(...WasmModule.encodeSignedLEB128(spreadInfo.typeIndex));
            body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

            found = true;
            break;
          }
        }
      }
    }

    if (!found) {
      throw new Error(`Missing value for field '${key}' in record literal`);
    }
  }

  // 4. struct.new
  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(typeIndex));
}

function generateTupleLiteral(
  ctx: CodegenContext,
  expr: TupleLiteral,
  body: number[],
) {
  let typeIndex: number;
  if (expr.inferredType) {
    const wasmType = mapCheckerTypeToWasmType(ctx, expr.inferredType);
    typeIndex = decodeTypeIndex(wasmType);
  } else {
    // 1. Infer types of all elements
    const types = expr.elements.map((e) => inferType(ctx, e));

    // 2. Get struct type index
    typeIndex = ctx.getTupleTypeIndex(types);
  }

  // 3. Generate values in order
  for (const element of expr.elements) {
    generateExpression(ctx, element, body);
  }

  // 4. struct.new
  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(typeIndex));
}

function generateFunctionExpression(
  ctx: CodegenContext,
  expr: FunctionExpression,
  body: number[],
) {
  // 1. Analyze captures
  const {captures, mutableCaptures} = analyzeCaptures(expr);
  
  // 2. Box mutable captures that aren't already boxed
  // We need to do this BEFORE building the captureList so that subsequent
  // code sees the boxed variables
  for (const name of mutableCaptures) {
    const local = ctx.getLocal(name);
    if (local && !local.isBoxed) {
      // Box this variable in the enclosing scope
      const checkerType = wasmTypeToCheckerType(local.type);
      const boxClass = getBoxClassInfo(ctx, checkerType);
      const boxedType = [
        ValType.ref,
        ...WasmModule.encodeSignedLEB128(boxClass.structTypeIndex),
      ];
      
      // Create a new box with the current value
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(local.index));
      boxPrimitive(ctx, local.type, body);
      
      // Create a new local for the box and update the scope
      const newBoxLocal = ctx.declareLocal(
        `$$boxed_${name}`,
        boxedType,
        undefined,
        true,
        local.type,
      );
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeSignedLEB128(newBoxLocal));
      
      // Update the original variable's local info to point to the box
      // We do this by updating the scope entry
      const scope = ctx.scopes[ctx.scopes.length - 1];
      scope.set(name, {
        index: newBoxLocal,
        type: boxedType,
        isBoxed: true,
        unboxedType: local.type,
      });
    }
  }
  
  const captureList: {
    name: string;
    type: number[];
    mutable: boolean;
    boxedType?: number[];
    unboxedType?: number[];
  }[] = [];

  for (const name of Array.from(captures).sort()) {
    const local = ctx.getLocal(name);
    if (local) {
      const isMutable = mutableCaptures.has(name);
      if (isMutable) {
        // Check if this variable is already boxed (from an outer closure)
        if (local.isBoxed && local.unboxedType) {
          // Already boxed, just capture the box as-is
          // Preserve the original unboxed type from the outer scope
          captureList.push({
            name,
            type: local.type, // This is already a box type
            mutable: true,
            boxedType: local.type,
            unboxedType: local.unboxedType, // Preserve the primitive type
          });
        } else {
          // Not yet boxed, need to box it
          const checkerType = wasmTypeToCheckerType(local.type);
          const boxClass = getBoxClassInfo(ctx, checkerType);
          const boxedType = [
            ValType.ref,
            ...WasmModule.encodeSignedLEB128(boxClass.structTypeIndex),
          ];
          captureList.push({
            name,
            type: local.type, // The primitive type
            mutable: true,
            boxedType,
            unboxedType: local.type, // Store the primitive type
          });
        }
      } else {
        captureList.push({name, type: local.type, mutable: false});
      }
    }
    // Globals don't need to be captured
  }

  // 2. Create Context Struct Type
  let contextStructTypeIndex = -1;
  if (captureList.length > 0) {
    const fields = captureList.map((c) => ({
      type: c.mutable ? c.boxedType! : c.type,
      mutable: false, // Context fields are always immutable (boxes handle mutability)
    }));
    contextStructTypeIndex = ctx.module.addStructType(fields);
  }

  // 3. Determine Signature
  //
  // Note: For closures inside generic contexts, the currentTypeArguments map is
  // already set by the enclosing method/function body generation. Generic
  // closures (<T>(...) => ...) would need their own type param handling, but
  // are not currently supported.
  let paramTypes: number[][];
  let returnType: number[];

  // Use checker's inferredType (identity-based)
  if (!expr.inferredType || expr.inferredType.kind !== TypeKind.Function) {
    throw new Error('Function expression missing inferredType');
  }
  const funcType = expr.inferredType as FunctionType;
  paramTypes = funcType.parameters.map((t) => mapCheckerTypeToWasmType(ctx, t));
  returnType = mapCheckerTypeToWasmType(ctx, funcType.returnType);

  // 4. Get or create closure type (this must happen BEFORE creating the impl function
  // to ensure type indices match)
  const closureTypeIndex = ctx.getClosureTypeIndex(paramTypes, returnType);
  const closureInfo = ctx.closureStructs.get(closureTypeIndex)!;
  const implTypeIndex = closureInfo.funcTypeIndex;

  // 5. Generate Implementation Function using the type from the closure struct
  const implFuncIndex = ctx.module.addFunction(implTypeIndex);

  ctx.module.declareFunction(implFuncIndex);

  // Capture the current type arguments map for deferred body generation This
  // ensures the closure body has access to the enclosing generic context's type
  // params
  const capturedTypeArguments = new Map(ctx.currentTypeArguments);

  ctx.bodyGenerators.push(() => {
    const funcBody: number[] = [];

    // Setup Scope
    ctx.pushFunctionScope();

    // Push the captured type param map for this closure's body
    if (capturedTypeArguments.size > 0) {
      ctx.pushTypeArgumentsContext(capturedTypeArguments);
    }

    // Param 0: Context (eqref)
    const ctxLocalIndex = ctx.defineParam('$$ctx', [ValType.eqref]);

    // Params 1..N: Arguments
    expr.params.forEach((p, i) => {
      ctx.defineParam(p.name.name, paramTypes[i], p);
    });

    // Unpack Context
    if (captureList.length > 0) {
      // Cast context
      const typedCtxLocal = ctx.declareLocal('$$typedCtx', [
        ValType.ref,
        ...WasmModule.encodeSignedLEB128(contextStructTypeIndex),
      ]);

      funcBody.push(Opcode.local_get, ctxLocalIndex);
      funcBody.push(
        0xfb,
        GcOpcode.ref_cast,
        ...WasmModule.encodeSignedLEB128(contextStructTypeIndex),
      );
      funcBody.push(Opcode.local_set, typedCtxLocal);

      // Define captured variables as locals
      captureList.forEach((c, i) => {
        if (c.mutable) {
          // For mutable captures, store the box itself as a local and mark it as boxed
          const localIndex = ctx.declareLocal(
            c.name,
            c.boxedType!,
            undefined,
            true,
            c.unboxedType!, // Use the preserved primitive type
          );

          funcBody.push(Opcode.local_get, typedCtxLocal);
          funcBody.push(
            0xfb,
            GcOpcode.struct_get,
            ...WasmModule.encodeSignedLEB128(contextStructTypeIndex),
            ...WasmModule.encodeSignedLEB128(i),
          );
          funcBody.push(Opcode.local_set, localIndex);
        } else {
          // For immutable captures, extract the value directly
          const localIndex = ctx.declareLocal(c.name, c.type);

          funcBody.push(Opcode.local_get, typedCtxLocal);
          funcBody.push(
            0xfb,
            GcOpcode.struct_get,
            ...WasmModule.encodeSignedLEB128(contextStructTypeIndex),
            ...WasmModule.encodeSignedLEB128(i),
          );
          funcBody.push(Opcode.local_set, localIndex);
        }
      });
    }

    // Generate Body
    if (expr.body.type === NodeType.BlockStatement) {
      generateBlockStatement(ctx, expr.body as BlockStatement, funcBody);
    } else {
      generateExpression(ctx, expr.body as Expression, funcBody);

      // Check if cast is needed
      if (returnType.length > 0) {
        const actualType = inferType(ctx, expr.body as Expression);
        if (!typesAreEqual(actualType, returnType)) {
          // Cast
          if (
            returnType.length > 1 &&
            (returnType[0] === ValType.ref ||
              returnType[0] === ValType.ref_null)
          ) {
            funcBody.push(0xfb, GcOpcode.ref_cast_null);
            funcBody.push(...returnType.slice(1));
          }
        }
      }
    }
    funcBody.push(Opcode.end);

    ctx.module.addCode(implFuncIndex, ctx.extraLocals, funcBody);

    // Pop the type param context if we pushed one
    if (capturedTypeArguments.size > 0) {
      ctx.popTypeParamContext();
    }
  });

  // 5. Instantiate Closure
  // Stack: [FuncRef, Context] -> StructNew

  // Push Func Ref
  body.push(Opcode.ref_func);
  body.push(...WasmModule.encodeSignedLEB128(implFuncIndex));

  // Push Context
  if (captureList.length > 0) {
    // Push captured values (boxing mutable ones)
    for (const c of captureList) {
      const local = ctx.getLocal(c.name);
      if (!local) throw new Error(`Captured variable ${c.name} not found`);

      if (c.mutable) {
        // Load the variable
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(local.index));

        // Box it if not already boxed
        if (!local.isBoxed) {
          boxPrimitive(ctx, c.type, body);
        }
        // If already boxed, the local.get above loaded the box directly
      } else {
        // For immutable captures, just get the value
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(local.index));
      }
    }
    // Create Context Struct
    body.push(0xfb, GcOpcode.struct_new);
    body.push(...WasmModule.encodeSignedLEB128(contextStructTypeIndex));
  } else {
    // Null context
    body.push(Opcode.ref_null, HeapType.eq);
  }

  // Create Closure Struct
  // closureTypeIndex was obtained earlier (before creating the impl function)
  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(closureTypeIndex));
}

function generateIntrinsic(
  ctx: CodegenContext,
  intrinsic: string,
  object: Expression,
  args: Expression[],
  body: number[],
) {
  switch (intrinsic) {
    case 'array.len':
      generateExpression(ctx, object, body);
      body.push(0xfb, GcOpcode.array_len);
      break;
    case 'array.get': {
      generateExpression(ctx, object, body);
      generateExpression(ctx, args[0], body);
      const objectType = inferType(ctx, object);
      const typeIndex = decodeTypeIndex(objectType);
      body.push(
        0xfb,
        GcOpcode.array_get,
        ...WasmModule.encodeSignedLEB128(typeIndex),
      );
      break;
    }
    case 'array.get_u': {
      generateExpression(ctx, object, body);
      generateExpression(ctx, args[0], body);
      const objectType = inferType(ctx, object);
      const typeIndex = decodeTypeIndex(objectType);
      body.push(
        0xfb,
        GcOpcode.array_get_u,
        ...WasmModule.encodeSignedLEB128(typeIndex),
      );
      break;
    }
    case 'array.set': {
      generateExpression(ctx, object, body);
      generateExpression(ctx, args[0], body);
      generateExpression(ctx, args[1], body);
      const objectType = inferType(ctx, object);
      const typeIndex = decodeTypeIndex(objectType);
      body.push(
        0xfb,
        GcOpcode.array_set,
        ...WasmModule.encodeSignedLEB128(typeIndex),
      );
      break;
    }
    default:
      throw new Error(`Unsupported intrinsic: ${intrinsic}`);
  }
}

function generateGlobalIntrinsic(
  ctx: CodegenContext,
  name: string,
  expr: CallExpression,
  body: number[],
) {
  const args = expr.arguments;
  switch (name) {
    case 'i32.store': {
      generateExpression(ctx, args[0], body); // ptr
      generateExpression(ctx, args[1], body); // value
      body.push(Opcode.i32_store, 0, 0); // align=0, offset=0
      break;
    }
    case 'i32.store8': {
      generateExpression(ctx, args[0], body); // ptr
      generateExpression(ctx, args[1], body); // value
      body.push(Opcode.i32_store8, 0, 0); // align=0, offset=0
      break;
    }
    case 'eq': {
      const left = args[0];
      const right = args[1];
      const leftType = inferType(ctx, left);
      const rightType = inferType(ctx, right);

      const isI32 = (t: number[]) => t.length === 1 && t[0] === ValType.i32;
      const isF32 = (t: number[]) => t.length === 1 && t[0] === ValType.f32;

      generateExpression(ctx, left, body);
      generateExpression(ctx, right, body);

      if (isI32(leftType) && isI32(rightType)) {
        body.push(Opcode.i32_eq);
      } else if (isF32(leftType) && isF32(rightType)) {
        body.push(Opcode.f32_eq);
      } else if (isStringType(ctx, leftType) && isStringType(ctx, rightType)) {
        generateStringEq(ctx, body);
      } else {
        // Check for operator ==
        const structTypeIndex = getHeapTypeIndex(ctx, leftType);
        let foundClass: ClassInfo | undefined;

        // Primary: look up ClassInfo via checker type identity
        if (left.inferredType) {
          let checkerType = left.inferredType;
          // Substitute type parameters when in a generic context
          if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
            checkerType = ctx.checkerContext.substituteTypeParams(
              checkerType,
              ctx.currentTypeArguments,
            );
          }

          if (checkerType.kind === TypeKind.Class) {
            foundClass = ctx.getClassInfo(checkerType as ClassType);

            // If identity lookup failed, instantiate via mapCheckerTypeToWasmType
            if (!foundClass) {
              mapCheckerTypeToWasmType(ctx, checkerType);
              foundClass = ctx.getClassInfo(checkerType as ClassType);
            }
          }

          // Extension class lookup by onType (checker type identity)
          if (!foundClass) {
            const extensions = ctx.getExtensionClassesByOnType(checkerType);
            if (extensions && extensions.length > 0) {
              foundClass = extensions[0];
            }
          }
        }

        // Fallback: look up by struct index
        if (!foundClass && structTypeIndex !== -1) {
          foundClass = ctx.getClassInfoByStructIndexDirect(structTypeIndex);
        }

        let hasOperator = false;
        if (foundClass) {
          const methodInfo = foundClass.methods.get('==');
          if (methodInfo) {
            hasOperator = true;
            // Call method
            // Stack: [left, right]

            if (foundClass.isFinal || methodInfo.isFinal) {
              body.push(
                Opcode.call,
                ...WasmModule.encodeSignedLEB128(methodInfo.index),
              );
            } else {
              // Dynamic dispatch
              // We need to do the vtable dance.
              // Stack: [left, right]

              // Store right
              const tempRight = ctx.declareLocal('$$eq_right', rightType);
              body.push(
                Opcode.local_set,
                ...WasmModule.encodeSignedLEB128(tempRight),
              );

              // Store left (and keep on stack for vtable lookup)
              const tempLeft = ctx.declareLocal('$$eq_left', leftType);
              body.push(
                Opcode.local_tee,
                ...WasmModule.encodeSignedLEB128(tempLeft),
              );

              // Get vtable
              body.push(0xfb, GcOpcode.struct_get);
              body.push(
                ...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex),
              );
              body.push(
                ...WasmModule.encodeSignedLEB128(
                  foundClass.fields.get('__vtable')!.index,
                ),
              );

              // Cast vtable
              body.push(0xfb, GcOpcode.ref_cast_null);
              body.push(
                ...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex!),
              );

              // Get function
              const vtableIndex = foundClass.vtable!.indexOf('==');
              body.push(0xfb, GcOpcode.struct_get);
              body.push(
                ...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex!),
              );
              body.push(...WasmModule.encodeSignedLEB128(vtableIndex));

              // Cast function
              body.push(0xfb, GcOpcode.ref_cast_null);
              body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

              // Store function
              const funcType = [
                ValType.ref_null,
                ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
              ];
              const tempFunc = ctx.declareLocal('$$eq_func', funcType);
              body.push(
                Opcode.local_set,
                ...WasmModule.encodeSignedLEB128(tempFunc),
              );

              // Restore args
              body.push(
                Opcode.local_get,
                ...WasmModule.encodeSignedLEB128(tempLeft),
              );
              body.push(
                Opcode.local_get,
                ...WasmModule.encodeSignedLEB128(tempRight),
              );

              // Call
              body.push(
                Opcode.local_get,
                ...WasmModule.encodeSignedLEB128(tempFunc),
              );
              body.push(
                Opcode.call_ref,
                ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
              );
            }
          }
        }

        if (!hasOperator) {
          body.push(Opcode.ref_eq);
        }
      }
      break;
    }
    case '__array_len':
      generateExpression(ctx, args[0], body);
      body.push(0xfb, GcOpcode.array_len);
      break;
    case '__array_get': {
      generateExpression(ctx, args[0], body); // array

      generateExpression(ctx, args[1], body); // index
      const arrayType = inferType(ctx, args[0]);
      const typeIndex = decodeTypeIndex(arrayType);
      body.push(
        0xfb,
        GcOpcode.array_get,
        ...WasmModule.encodeSignedLEB128(typeIndex),
      );
      break;
    }
    case '__array_set': {
      generateExpression(ctx, args[0], body); // array
      generateExpression(ctx, args[1], body); // index
      generateExpression(ctx, args[2], body); // value
      const arrayType = inferType(ctx, args[0]);
      const typeIndex = decodeTypeIndex(arrayType);
      body.push(
        0xfb,
        GcOpcode.array_set,
        ...WasmModule.encodeSignedLEB128(typeIndex),
      );
      break;
    }
    case '__array_new': {
      // __array_new(size, default_value)
      const size = args[0];
      const defaultValue = args[1];

      const elemType = inferType(ctx, defaultValue);
      const arrayTypeIndex = getArrayTypeIndex(ctx, elemType);

      // array.new $type value size
      generateExpression(ctx, defaultValue, body);
      generateExpression(ctx, size, body);

      body.push(
        0xfb,
        GcOpcode.array_new,
        ...WasmModule.encodeSignedLEB128(arrayTypeIndex),
      );
      break;
    }
    case '__array_new_empty': {
      // __array_new_empty(size)
      const size = args[0];

      if (!expr.inferredType) {
        throw new Error('__array_new_empty requires inferred type');
      }

      // Substitute type parameters if we're in a generic context
      let resolvedType = expr.inferredType;
      if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
        resolvedType = ctx.checkerContext.substituteTypeParams(
          resolvedType,
          ctx.currentTypeArguments,
        );
      }

      const wasmType = mapCheckerTypeToWasmType(ctx, resolvedType);
      const arrayTypeIndex = decodeTypeIndex(wasmType);

      // array.new_default $type size
      generateExpression(ctx, size, body);

      body.push(
        0xfb,
        GcOpcode.array_new_default,
        ...WasmModule.encodeSignedLEB128(arrayTypeIndex),
      );
      break;
    }
    case 'hash': {
      const arg = args[0];
      generateHash(ctx, arg, body);
      break;
    }
    case 'unreachable': {
      body.push(Opcode.unreachable);
      break;
    }
    default: {
      // Handle math intrinsics (e.g. i32.clz, f64.abs)
      const opcodeName = name.replace('.', '_');
      if (opcodeName in Opcode) {
        for (const arg of args) {
          generateExpression(ctx, arg, body);
        }
        body.push((Opcode as any)[opcodeName]);
        return;
      }
      throw new Error(`Unsupported global intrinsic: ${name}`);
    }
  }
}

function generateHash(ctx: CodegenContext, expr: Expression, body: number[]) {
  const type = inferType(ctx, expr);

  // Primitives
  if (type.length === 1) {
    if (type[0] === ValType.i32) {
      generateExpression(ctx, expr, body);
      return;
    }
    // Boolean is i32
  }

  // String
  if (isStringType(ctx, type)) {
    generateExpression(ctx, expr, body);
    generateStringHash(ctx, body);
    return;
  }

  // Structs (Classes)
  const structTypeIndex = getHeapTypeIndex(ctx, type);
  if (structTypeIndex !== -1) {
    // TODO: Support Records and Tuples (structural hashing)

    let classInfo: ClassInfo | undefined;

    // Primary: look up ClassInfo via checker type identity
    if (expr.inferredType) {
      let checkerType = expr.inferredType;
      // Substitute type parameters when in a generic context
      if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
        checkerType = ctx.checkerContext.substituteTypeParams(
          checkerType,
          ctx.currentTypeArguments,
        );
      }

      if (checkerType.kind === TypeKind.Class) {
        classInfo = ctx.getClassInfo(checkerType as ClassType);

        // If identity lookup failed, instantiate via mapCheckerTypeToWasmType
        if (!classInfo) {
          mapCheckerTypeToWasmType(ctx, checkerType);
          classInfo = ctx.getClassInfo(checkerType as ClassType);
        }
      }

      // Extension class lookup by onType (checker type identity)
      if (!classInfo) {
        const extensions = ctx.getExtensionClassesByOnType(checkerType);
        if (extensions && extensions.length > 0) {
          classInfo = extensions[0];
        }
      }
    }

    // Fallback: look up by struct index
    if (!classInfo) {
      classInfo = ctx.getClassInfoByStructIndexDirect(structTypeIndex);
    }

    if (classInfo) {
      const methodInfo = classInfo.methods.get(HASH_CODE_METHOD);
      if (methodInfo) {
        generateExpression(ctx, expr, body);

        // Call hashCode
        if (classInfo.isFinal || methodInfo.isFinal) {
          body.push(
            Opcode.call,
            ...WasmModule.encodeSignedLEB128(methodInfo.index),
          );
        } else {
          // Dynamic dispatch
          // Stack: [this]

          // 1. Tee 'this' for vtable lookup
          const tempThis = ctx.declareLocal('$$temp_hash_this', type);
          body.push(
            Opcode.local_tee,
            ...WasmModule.encodeSignedLEB128(tempThis),
          );

          // 2. Load VTable
          body.push(
            0xfb,
            GcOpcode.struct_get,
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
            ...WasmModule.encodeSignedLEB128(
              classInfo.fields.get('__vtable')!.index,
            ),
          );

          // Cast VTable
          body.push(
            0xfb,
            GcOpcode.ref_cast_null,
            ...WasmModule.encodeSignedLEB128(classInfo.vtableTypeIndex!),
          );

          // 3. Load Function Pointer
          const vtableIndex = classInfo.vtable!.indexOf('hashCode');
          body.push(
            0xfb,
            GcOpcode.struct_get,
            ...WasmModule.encodeSignedLEB128(classInfo.vtableTypeIndex!),
            ...WasmModule.encodeSignedLEB128(vtableIndex),
          );

          // 4. Cast Function
          body.push(
            0xfb,
            GcOpcode.ref_cast_null,
            ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
          );

          // Store funcRef in temp local
          const funcRefType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
          ];
          const tempFuncRef = ctx.declareLocal('$$temp_hash_func', funcRefType);
          body.push(
            Opcode.local_set,
            ...WasmModule.encodeSignedLEB128(tempFuncRef),
          );

          // 5. Prepare Stack for Call: [this, funcRef]
          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(tempThis),
          );
          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(tempFuncRef),
          );

          // 6. Call
          body.push(
            Opcode.call_ref,
            ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
          );
        }
        return;
      }
    }
  }

  // Fallback: evaluate and drop, return 0
  generateExpression(ctx, expr, body);
  body.push(Opcode.drop);
  body.push(Opcode.i32_const, 0);
}

function generateStringHash(ctx: CodegenContext, body: number[]) {
  if (ctx.stringHashFunctionIndex === -1) {
    ctx.stringHashFunctionIndex = generateStringHashFunction(ctx);
  }
  body.push(Opcode.call);
  body.push(...WasmModule.encodeSignedLEB128(ctx.stringHashFunctionIndex));
}

function generateStringHashFunction(ctx: CodegenContext): number {
  const stringType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
  ];
  const typeIndex = ctx.module.addType([stringType], [[ValType.i32]]);

  const funcIndex = ctx.module.addFunction(typeIndex);

  ctx.pendingHelperFunctions.push(() => {
    const locals: number[][] = [
      [ValType.i32], // hash (local 0)
      [ValType.i32], // i (local 1)
      [ValType.i32], // len (local 2)
    ];
    const body: number[] = [];

    // Params: s (0)
    // Locals: hash (1), i (2), len (3)

    // hash = 2166136261 (FNV offset basis)
    body.push(
      Opcode.i32_const,
      ...WasmModule.encodeSignedLEB128(2166136261 | 0),
    );
    body.push(Opcode.local_set, 1);

    // len = s.length
    body.push(Opcode.local_get, 0);
    body.push(0xfb, GcOpcode.array_len);
    body.push(Opcode.local_set, 3);

    // i = 0
    body.push(Opcode.i32_const, 0);
    body.push(Opcode.local_set, 2);

    // loop
    body.push(Opcode.block, ValType.void);
    body.push(Opcode.loop, ValType.void);

    // if i >= len break
    body.push(Opcode.local_get, 2);
    body.push(Opcode.local_get, 3);
    body.push(Opcode.i32_ge_u);
    body.push(Opcode.br_if, 1);

    // byte = s[i]
    body.push(Opcode.local_get, 0);

    body.push(Opcode.local_get, 2); // i
    body.push(0xfb, GcOpcode.array_get_u);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // hash ^= byte
    body.push(Opcode.local_get, 1);
    body.push(Opcode.i32_xor);
    body.push(Opcode.local_set, 1);

    // hash *= 16777619 (FNV prime)
    body.push(Opcode.local_get, 1);
    body.push(Opcode.i32_const, ...WasmModule.encodeSignedLEB128(16777619));
    body.push(Opcode.i32_mul);
    body.push(Opcode.local_set, 1);

    // i++
    body.push(Opcode.local_get, 2);
    body.push(Opcode.i32_const, 1);
    body.push(Opcode.i32_add);
    body.push(Opcode.local_set, 2);

    body.push(Opcode.br, 0);
    body.push(Opcode.end); // end loop
    body.push(Opcode.end); // end block

    // return hash
    body.push(Opcode.local_get, 1);
    body.push(Opcode.end);

    ctx.module.addCode(funcIndex, locals, body);
  });

  return funcIndex;
}

function typesAreEqual(t1: number[], t2: number[]): boolean {
  if (t1.length !== t2.length) return false;
  for (let i = 0; i < t1.length; i++) {
    if (t1[i] !== t2[i]) return false;
  }
  return true;
}

function generateIndirectCall(
  ctx: CodegenContext,
  expr: CallExpression,
  body: number[],
) {
  const callee = expr.callee;
  const calleeCheckerType = expr.callee.inferredType;

  if (calleeCheckerType && calleeCheckerType.kind === TypeKind.Union) {
    // Union Call Dispatch
    generateExpression(ctx, callee, body);
    const calleeType = inferType(ctx, callee);
    const calleeLocal = ctx.declareLocal('$$union_callee', calleeType);
    body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(calleeLocal));

    const unionType = calleeCheckerType as UnionType;

    // Evaluate arguments to locals
    const argLocals: number[] = [];
    for (const arg of expr.arguments) {
      generateExpression(ctx, arg, body);
      const argType = inferType(ctx, arg);
      const local = ctx.declareLocal('$$union_arg', argType);
      body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(local));
      argLocals.push(local);
    }

    const resultLocal =
      expr.inferredType && expr.inferredType.kind !== TypeKind.Void
        ? ctx.declareLocal(
            '$$union_result',
            mapCheckerTypeToWasmType(ctx, expr.inferredType),
          )
        : -1;

    // Block to break out of once a match is found
    body.push(Opcode.block);
    body.push(0x40);

    for (const member of unionType.types) {
      if (member.kind !== TypeKind.Function) continue;
      const wasmType = mapCheckerTypeToWasmType(ctx, member);
      const typeIndex = decodeTypeIndex(wasmType);

      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(calleeLocal),
      );
      body.push(0xfb, GcOpcode.ref_test);
      body.push(...WasmModule.encodeSignedLEB128(typeIndex));

      body.push(Opcode.if);
      body.push(0x40);

      // Cast Callee (we need it multiple times, so maybe tee it? or just get it again)
      // Actually, we need to push arguments first (context, args...), then func ref.

      // 1. Get Context
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(calleeLocal),
      );
      body.push(0xfb, GcOpcode.ref_cast_null);
      body.push(...WasmModule.encodeSignedLEB128(typeIndex));
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(typeIndex));
      body.push(1); // Field 1: context

      // 2. Args
      const funcRefTypeIndex = ctx.module.getStructFieldType(typeIndex, 0);
      const funcTypeIndex = decodeTypeIndex(funcRefTypeIndex);
      const sigParams = ctx.module.getFunctionTypeParams(funcTypeIndex);
      // sigParams[0] is context

      // Push arguments matching the signature arity
      // We skip the first param (context) as it's already pushed
      const arity = sigParams.length - 1;

      for (let i = 0; i < arity; i++) {
        if (i < argLocals.length) {
          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(argLocals[i]),
          );
        } else {
          // Should not happen if checker did its job
          throw new Error(`Not enough arguments for union member call`);
        }
      }

      // 3. Get Func Ref
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(calleeLocal),
      );
      body.push(0xfb, GcOpcode.ref_cast_null);
      body.push(...WasmModule.encodeSignedLEB128(typeIndex));
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(typeIndex));
      body.push(0); // Field 0: func ref

      // Call
      body.push(Opcode.call_ref);
      body.push(...WasmModule.encodeSignedLEB128(funcTypeIndex));

      // Handle Result
      if (resultLocal !== -1) {
        body.push(
          Opcode.local_set,
          ...WasmModule.encodeSignedLEB128(resultLocal),
        );
      }

      body.push(Opcode.br, 1); // Break out of the 'block' (depth 1: if -> block)
      body.push(Opcode.end); // End of 'if'
    }

    body.push(Opcode.unreachable); // If no type matched
    body.push(Opcode.end); // End of block

    // Load result
    if (resultLocal !== -1) {
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(resultLocal),
      );
    }

    return;
  }

  generateExpression(ctx, callee, body);

  const closureType = inferType(ctx, callee);
  const closureTypeIndex = decodeTypeIndex(closureType);
  const closureInfo = ctx.closureStructs.get(closureTypeIndex);

  if (!closureInfo) {
    throw new Error('Indirect call on non-closure type');
  }

  // 1. Load closure struct (it's on stack)
  const closureLocal = ctx.declareLocal('$$closure', closureType);
  body.push(Opcode.local_set);
  body.push(...WasmModule.encodeSignedLEB128(closureLocal));

  // 2. Load Context
  body.push(Opcode.local_get);
  body.push(...WasmModule.encodeSignedLEB128(closureLocal));
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(closureTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(1)); // context field

  // 3. Generate Arguments
  const params = ctx.module.getFunctionTypeParams(closureInfo.funcTypeIndex);
  // params[0] is context

  for (let i = 0; i < expr.arguments.length; i++) {
    const arg = expr.arguments[i];
    const expectedType = params[i + 1];
    generateAdaptedArgument(ctx, arg, expectedType, body);
  }

  // 4. Load Function Reference
  body.push(Opcode.local_get);
  body.push(...WasmModule.encodeSignedLEB128(closureLocal));
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(closureTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(0)); // func field

  // 5. Call Ref
  body.push(Opcode.call_ref);
  body.push(...WasmModule.encodeSignedLEB128(closureInfo.funcTypeIndex));

  // Check if we need to cast the result (e.g. generic erasure)
  if (expr.inferredType) {
    const expectedType = mapCheckerTypeToWasmType(ctx, expr.inferredType);
    const actualType = getReturnTypeFromTypeIndex(
      ctx,
      closureInfo.funcTypeIndex,
    );

    if (actualType.length > 0 && !typesAreEqual(expectedType, actualType)) {
      // Cast needed
      if (
        expectedType.length > 1 &&
        (expectedType[0] === ValType.ref_null ||
          expectedType[0] === ValType.ref)
      ) {
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...expectedType.slice(1));
      }
    }
  }
}

function getReturnTypeFromTypeIndex(
  ctx: CodegenContext,
  typeIndex: number,
): number[] {
  const typeBytes = ctx.module.getType(typeIndex);
  if (!typeBytes || typeBytes[0] !== 0x60) return []; // Not a function type or reserved

  let offset = 1;

  // Helper to read unsigned LEB128
  const readULEB128 = () => {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = typeBytes[offset++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };

  // Helper to skip a value type
  const skipType = () => {
    const byte = typeBytes[offset++];
    if (
      byte === ValType.ref ||
      byte === ValType.ref_null ||
      byte === ValType.optref
    ) {
      // Skip heap type (LEB128)
      while (true) {
        const b = typeBytes[offset++];
        if ((b & 0x80) === 0) break;
      }
    }
  };

  // Skip params
  const numParams = readULEB128();
  for (let i = 0; i < numParams; i++) {
    skipType();
  }

  // Read results
  const numResults = readULEB128();
  if (numResults === 0) return [];

  // Read first result type
  const resultType: number[] = [];
  const byte = typeBytes[offset++];
  resultType.push(byte);

  if (
    byte === ValType.ref ||
    byte === ValType.ref_null ||
    byte === ValType.optref
  ) {
    // Read heap type
    while (true) {
      const b = typeBytes[offset++];
      resultType.push(b);
      if ((b & 0x80) === 0) break;
    }
  }

  return resultType;
}

function generateTemplateLiteral(
  ctx: CodegenContext,
  expr: TemplateLiteral,
  body: number[],
) {
  if (expr.quasis.length === 0) {
    generateStringLiteral(
      ctx,
      {type: NodeType.StringLiteral, value: ''} as StringLiteral,
      body,
    );
    return;
  }

  generateStringLiteral(
    ctx,
    {
      type: NodeType.StringLiteral,
      value: expr.quasis[0].value.raw,
    } as StringLiteral,
    body,
  );

  for (let i = 0; i < expr.expressions.length; i++) {
    const expression = expr.expressions[i];
    const quasi = expr.quasis[i + 1];

    generateExpression(ctx, expression, body);

    // Ensure expression is a string.
    // For now, we assume it is or rely on runtime/implicit behavior if any.
    // But since we don't have implicit conversion, this might fail at runtime or compile time if types mismatch.
    // Ideally we should check type and convert.
    // But for "adding back" support, we'll keep it simple.

    generateStringConcat(ctx, body);

    generateStringLiteral(
      ctx,
      {type: NodeType.StringLiteral, value: quasi.value.raw} as StringLiteral,
      body,
    );

    generateStringConcat(ctx, body);
  }
}

function generateTaggedTemplateExpression(
  ctx: CodegenContext,
  expr: TaggedTemplateExpression,
  body: number[],
) {
  // 1. Create TemplateStringsArray for the strings
  const tsaDecl = ctx.wellKnownTypes.TemplateStringsArray;
  if (!tsaDecl) {
    throw new Error('TemplateStringsArray not available - stdlib not loaded');
  }
  // Identity-based lookup using checker's type (no fallback)
  if (tsaDecl.inferredType?.kind !== TypeKind.Class) {
    throw new Error(
      `TemplateStringsArray declaration has unexpected inferredType kind: ${tsaDecl.inferredType?.kind}`,
    );
  }
  const tsaClassInfo = ctx.getClassInfo(tsaDecl.inferredType as ClassType);
  if (!tsaClassInfo) {
    throw new Error('TemplateStringsArray class not found via identity lookup');
  }

  const stringType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
  ];
  const stringsArrayTypeIndex = getArrayTypeIndex(ctx, stringType);

  // Each unique tagged template literal in the source gets its own module-level
  // global to cache the TemplateStringsArray instance. This matches JavaScript
  // semantics where the strings array is frozen and reused across invocations:
  //
  //   const results: TemplateStringsArray[] = [];
  //   const tag = (strings: TemplateStringsArray) => { results.push(strings); };
  //   for (let i = 0; i < 3; i++) tag`hello`;
  //   console.log(results[0] === results[1]); // true - same instance
  //
  // The global is initialized to null and lazily populated on first use.
  // Different tagged template expressions (e.g., tag`a` vs tag`b`) get separate
  // globals, but the same expression always returns the same TSA instance.
  //
  // TODO: Make TSA a compile-time constant global instead of lazily initialized.
  // WASM GC supports constant expressions for struct.new and array.new_fixed,
  // so this could be a true constant if string literals were also constants.
  // This optimization would extend to other immutable data: string literals,
  // immutable arrays with literal elements, records/tuples, and potentially
  // a broader "const expression" feature (like Dart's const constructors).
  // See: https://github.com/user/zena/issues/XXX (compile-time constants)
  let globalIndex: number;
  if (ctx.templateLiteralGlobals.has(expr)) {
    globalIndex = ctx.templateLiteralGlobals.get(expr)!;
  } else {
    const globalType = [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(tsaClassInfo.structTypeIndex),
    ];

    // Initialize with null - will be lazily populated on first call
    globalIndex = ctx.module.addGlobal(globalType, true, [
      Opcode.ref_null,
      HeapType.none,
    ]);
    ctx.templateLiteralGlobals.set(expr, globalIndex);
  }

  // Lazy initialization
  body.push(Opcode.global_get);
  body.push(...WasmModule.encodeSignedLEB128(globalIndex));
  body.push(Opcode.ref_is_null);
  body.push(Opcode.if);
  body.push(ValType.void);

  // Create TemplateStringsArray instance
  // Declare locals for arrays
  const cookedLocal = ctx.declareLocal('$$tsa_cooked', [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(stringsArrayTypeIndex),
  ]);
  const rawLocal = ctx.declareLocal('$$tsa_raw', [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(stringsArrayTypeIndex),
  ]);

  // 1. Create cooked strings array and save to local
  for (const quasi of expr.quasi.quasis) {
    generateStringLiteral(
      ctx,
      {
        type: NodeType.StringLiteral,
        value: quasi.value.cooked,
      } as StringLiteral,
      body,
    );
  }
  body.push(0xfb, GcOpcode.array_new_fixed);
  body.push(...WasmModule.encodeSignedLEB128(stringsArrayTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(expr.quasi.quasis.length));
  body.push(Opcode.local_set);
  body.push(...WasmModule.encodeSignedLEB128(cookedLocal));

  // 2. Create raw strings array and save to local
  for (const quasi of expr.quasi.quasis) {
    generateStringLiteral(
      ctx,
      {type: NodeType.StringLiteral, value: quasi.value.raw} as StringLiteral,
      body,
    );
  }
  body.push(0xfb, GcOpcode.array_new_fixed);
  body.push(...WasmModule.encodeSignedLEB128(stringsArrayTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(expr.quasi.quasis.length));
  body.push(Opcode.local_set);
  body.push(...WasmModule.encodeSignedLEB128(rawLocal));

  // 3. Create TemplateStringsArray struct with vtable and fields
  // TemplateStringsArray has: __vtable, __brand_*, #strings, #raw
  // Push vtable
  if (tsaClassInfo.vtableGlobalIndex !== undefined) {
    body.push(Opcode.global_get);
    body.push(...WasmModule.encodeSignedLEB128(tsaClassInfo.vtableGlobalIndex));
  } else {
    body.push(Opcode.ref_null, HeapType.none);
  }
  // Push brand (null)
  body.push(Opcode.ref_null, HeapType.none);
  // Push #strings (cooked)
  body.push(Opcode.local_get);
  body.push(...WasmModule.encodeSignedLEB128(cookedLocal));
  // Push #raw
  body.push(Opcode.local_get);
  body.push(...WasmModule.encodeSignedLEB128(rawLocal));
  // Create struct
  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(tsaClassInfo.structTypeIndex));

  // Set global
  body.push(Opcode.global_set);
  body.push(...WasmModule.encodeSignedLEB128(globalIndex));

  body.push(Opcode.end); // end if

  // Push TemplateStringsArray
  body.push(Opcode.global_get);
  body.push(...WasmModule.encodeSignedLEB128(globalIndex));

  // 2. Create values array
  let valueType: number[] = [ValType.i32];
  let expectedValuesArrayTypeIndex: number | undefined;

  // Try to determine expected type from tag function
  if (expr.tag.type === NodeType.Identifier) {
    const name = (expr.tag as Identifier).name;
    const tagBinding = ctx.semanticContext.getResolvedBinding(
      expr.tag as Identifier,
    );
    let funcIndex: number | undefined;
    if (tagBinding) {
      const resolved = resolveImport(tagBinding);
      if (resolved.kind === 'function') {
        funcIndex = ctx.getFunctionIndexByDecl(resolved.declaration);
      }
    }
    // Fall back to name-based lookup
    if (funcIndex === undefined && ctx.functions.has(name)) {
      funcIndex = ctx.functions.get(name);
    }
    if (funcIndex !== undefined) {
      const funcTypeIndex = ctx.module.getFunctionTypeIndex(funcIndex);
      const params = ctx.module.getFunctionTypeParams(funcTypeIndex);
      // params[0] is strings, params[1] is values
      if (params.length >= 2) {
        const valuesParamType = params[1];
        // Check if it is a reference type
        if (
          valuesParamType[0] === ValType.ref_null ||
          valuesParamType[0] === ValType.ref
        ) {
          // Extract heap type index
          // The type encoding is [ref_null, ...leb128(heapType)]
          // decodeTypeIndex expects [opcode, ...leb128(heapType)]
          const heapTypeIndex = decodeTypeIndex(valuesParamType);
          // console.log(`TaggedTemplate: expected values type index = ${heapTypeIndex}`);
          expectedValuesArrayTypeIndex = heapTypeIndex;
        }
      }
    }
  }

  if (
    expectedValuesArrayTypeIndex !== undefined &&
    expectedValuesArrayTypeIndex !== -1
  ) {
    // console.log(`TaggedTemplate: getting element type for ${expectedValuesArrayTypeIndex}`);
    valueType = ctx.module.getArrayElementType(expectedValuesArrayTypeIndex);
  } else if (expr.quasi.expressions.length > 0) {
    valueType = inferType(ctx, expr.quasi.expressions[0]);
    // TODO: Check if all expressions have compatible types.
  }

  const valuesArrayTypeIndex =
    expectedValuesArrayTypeIndex !== undefined
      ? expectedValuesArrayTypeIndex
      : getArrayTypeIndex(ctx, valueType);

  for (const arg of expr.quasi.expressions) {
    if (expectedValuesArrayTypeIndex !== undefined) {
      generateAdaptedArgument(ctx, arg, valueType, body);
    } else {
      generateExpression(ctx, arg, body);
    }
  }

  body.push(0xfb, GcOpcode.array_new_fixed);
  body.push(...WasmModule.encodeSignedLEB128(valuesArrayTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(expr.quasi.expressions.length));

  // 3. Call tag function
  if (expr.tag.type === NodeType.Identifier) {
    const name = (expr.tag as Identifier).name;

    // Check for local variable (closure/func ref)
    const local = ctx.getLocal(name);
    if (local) {
      const closureTypeIndex = decodeTypeIndex(local.type);
      const closureInfo = ctx.closureStructs.get(closureTypeIndex);

      if (closureInfo) {
        // Closure Call
        // Stack has [stringsArray, valuesArray]
        // We need [context, stringsArray, valuesArray, funcRef] -> call_ref

        // Save args to locals to reorder the stack for the closure call.
        // Each declareLocal allocates a fresh index, so multiple tagged
        // templates in the same function get separate locals (the name is just
        // for debugging).
        const valuesArrayLocal = ctx.declareLocal('$$values_array', [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(valuesArrayTypeIndex),
        ]);
        body.push(
          Opcode.local_set,
          ...WasmModule.encodeSignedLEB128(valuesArrayLocal),
        );

        // The stack has the TemplateStringsArray struct (not the raw string array)
        const tsaLocal = ctx.declareLocal('$$tsa', [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(tsaClassInfo.structTypeIndex),
        ]);
        body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(tsaLocal));

        // 1. Load Context
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(local.index),
        );
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(closureTypeIndex),
          ...WasmModule.encodeSignedLEB128(1), // context field
        );

        // 2. Push Args
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tsaLocal));
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(valuesArrayLocal),
        );

        // 3. Load Function Reference
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(local.index),
        );
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(closureTypeIndex),
          ...WasmModule.encodeSignedLEB128(0), // func field
        );

        // 4. Call Ref
        body.push(
          Opcode.call_ref,
          ...WasmModule.encodeSignedLEB128(closureInfo.funcTypeIndex),
        );
        return;
      }

      // Raw Function Reference (fallback)
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(local.index));

      const heapTypeIndex = decodeTypeIndex(local.type);
      body.push(Opcode.call_ref);
      body.push(...WasmModule.encodeSignedLEB128(heapTypeIndex));
      return;
    }

    // Check for global function using binding
    const tagBinding = ctx.semanticContext.getResolvedBinding(
      expr.tag as Identifier,
    );
    let funcIndex: number | undefined;
    if (tagBinding) {
      const resolved = resolveImport(tagBinding);
      if (resolved.kind === 'function') {
        funcIndex = ctx.getFunctionIndexByDecl(resolved.declaration);
      }
    }
    // Fall back to name-based lookup
    if (funcIndex === undefined) {
      const name = (expr.tag as Identifier).name;
      if (ctx.functions.has(name)) {
        funcIndex = ctx.functions.get(name);
      }
    }
    if (funcIndex !== undefined) {
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(funcIndex));
      return;
    }
  }

  throw new Error(
    'Tagged template expression only supports identifier tags for now',
  );
}

function findArrayIntrinsic(
  ctx: CodegenContext,
  memberName: string,
): string | undefined {
  if (!ctx.wellKnownTypes.FixedArray) return undefined;
  const decl = ctx.wellKnownTypes.FixedArray;

  for (const member of decl.body) {
    if (
      member.type === NodeType.FieldDefinition &&
      member.name.type === NodeType.Identifier &&
      member.name.name === memberName
    ) {
      if (member.decorators) {
        const d = member.decorators.find(
          (d) => d.name === Decorators.Intrinsic,
        );
        if (d && d.args.length === 1) return d.args[0].value;
      }
    }
    if (
      member.type === NodeType.MethodDefinition &&
      member.name.type === NodeType.Identifier &&
      member.name.name === memberName
    ) {
      if (member.decorators) {
        const d = member.decorators.find(
          (d) => d.name === Decorators.Intrinsic,
        );
        if (d && d.args.length === 1) return d.args[0].value;
      }
    }
  }
  return undefined;
}

export function generateAdaptedArgument(
  ctx: CodegenContext,
  arg: Expression,
  expectedType: number[],
  body: number[],
) {
  // 1. Infer actual type
  let actualType: number[];
  try {
    actualType = inferType(ctx, arg);
  } catch (e) {
    // If inference fails, fallback to normal generation
    generateExpression(ctx, arg, body);
    return;
  }

  // Auto-boxing: Primitive -> Any
  if (
    ((expectedType.length > 1 &&
      expectedType[0] === ValType.ref_null &&
      expectedType[1] === ValType.anyref) ||
      (expectedType.length === 1 && expectedType[0] === ValType.anyref)) &&
    actualType.length === 1 &&
    (actualType[0] === ValType.i32 ||
      actualType[0] === ValType.i64 ||
      actualType[0] === ValType.f32 ||
      actualType[0] === ValType.f64)
  ) {
    generateExpression(ctx, arg, body);
    boxPrimitive(ctx, actualType, body);
    return;
  }

  // Interface Boxing
  const expectedIndex = decodeTypeIndex(expectedType);
  let interfaceInfo: InterfaceInfo | undefined;

  if (expectedIndex !== -1) {
    // Use O(1) lookup by struct index
    interfaceInfo = ctx.getInterfaceInfoByStructIndex(expectedIndex);
  }

  if (interfaceInfo) {
    const actualIndex = decodeTypeIndex(actualType);
    let classInfo: ClassInfo | undefined;

    // Primary: look up ClassInfo via checker type identity
    if (arg.inferredType) {
      let checkerType = arg.inferredType;
      // Substitute type parameters when in a generic context
      if (ctx.currentTypeArguments.size > 0 && ctx.checkerContext) {
        checkerType = ctx.checkerContext.substituteTypeParams(
          checkerType,
          ctx.currentTypeArguments,
        );
      }

      if (checkerType.kind === TypeKind.Class) {
        classInfo = ctx.getClassInfo(checkerType as ClassType);

        // If identity lookup failed, instantiate via mapCheckerTypeToWasmType
        if (!classInfo) {
          mapCheckerTypeToWasmType(ctx, checkerType);
          classInfo = ctx.getClassInfo(checkerType as ClassType);
        }
      }

      // Extension class lookup by onType (checker type identity)
      if (!classInfo) {
        const extensions = ctx.getExtensionClassesByOnType(checkerType);
        if (extensions && extensions.length > 0) {
          classInfo = extensions[0];
        }
      }

      // On-demand FixedArray instantiation for raw array types
      if (!classInfo && checkerType.kind === TypeKind.Array) {
        const arrType = checkerType as import('../types.js').ArrayType;
        if (arrType.elementType.kind !== TypeKind.TypeParameter) {
          classInfo = resolveFixedArrayClass(ctx, checkerType);
        }
      }
    }

    // Fallback: look up by WASM struct index (for classes instantiated during codegen)
    if (!classInfo && actualIndex !== -1) {
      classInfo = ctx.getClassInfoByStructIndexDirect(actualIndex);
    }

    // Check extensions using WASM valtype (for primitives)
    if (!classInfo && actualType.length === 1) {
      const extensions = ctx.getExtensionClassesByWasmValType(actualType[0]);
      if (extensions && extensions.length > 0) {
        classInfo = extensions[0];
      }
    }

    if (classInfo && classInfo.implements && interfaceInfo.checkerType) {
      // Use identity-based lookup with InterfaceType
      const targetInterfaceType = interfaceInfo.checkerType;
      let impl = classInfo.implements.get(targetInterfaceType);

      // If not found, check if the class implements a subtype of the interface
      if (!impl) {
        for (const [implType, implInfo] of classInfo.implements) {
          if (ctx.checkerContext.isInterfaceAssignableTo(implType, targetInterfaceType)) {
            impl = implInfo;
            break;
          }
        }
      }

      if (impl) {
        // Box it!
        // 1. Instance
        generateExpression(ctx, arg, body);

        // 2. VTable
        body.push(
          Opcode.global_get,
          ...WasmModule.encodeSignedLEB128(impl.vtableGlobalIndex),
        );

        // 3. Struct New
        body.push(0xfb, GcOpcode.struct_new);
        body.push(
          ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
        );
        return;
      }
    }
  }

  // Eqref/Anyref -> Specific struct type cast
  // This is needed when the actual value is eqref/anyref (e.g., exception parameter)
  // but the expected type is a specific struct reference
  const isActualEqref =
    actualType.length === 1 && actualType[0] === ValType.eqref;
  const isActualAnyref =
    actualType.length === 1 && actualType[0] === ValType.anyref;
  const isExpectedStructRef =
    expectedType.length > 1 &&
    (expectedType[0] === ValType.ref || expectedType[0] === ValType.ref_null);

  if ((isActualEqref || isActualAnyref) && isExpectedStructRef) {
    generateExpression(ctx, arg, body);
    // Cast from eqref/anyref to specific struct type
    body.push(0xfb, GcOpcode.ref_cast_null);
    body.push(...expectedType.slice(1)); // type index
    return;
  }

  if (isAdaptable(ctx, actualType, expectedType)) {
    const expectedIndex = decodeTypeIndex(expectedType);
    const actualIndex = decodeTypeIndex(actualType);
    const expectedClosure = ctx.closureStructs.get(expectedIndex)!;
    const actualClosure = ctx.closureStructs.get(actualIndex)!;
    const actualArity =
      ctx.module.getFunctionTypeArity(actualClosure.funcTypeIndex) - 1;

    // Adaptation needed!

    // Generate the argument (the actual closure)
    generateExpression(ctx, arg, body);

    // Create Adapter
    // We need to create a new closure that wraps the actual closure.
    // The wrapper's context will be the actual closure.

    // Wrapper Function Signature: Same as expected function
    const wrapperFuncIndex = ctx.module.addFunction(
      expectedClosure.funcTypeIndex,
    );
    ctx.module.declareFunction(wrapperFuncIndex);

    ctx.pendingHelperFunctions.push(() => {
      const locals: number[][] = [];
      const funcBody: number[] = [];

      // Params: 0=Context(eqref), 1..N=Args

      // 1. Context for wrapped call
      funcBody.push(Opcode.local_get, 0);
      funcBody.push(
        0xfb,
        GcOpcode.ref_cast,
        ...WasmModule.encodeSignedLEB128(actualIndex),
      );
      funcBody.push(
        0xfb,
        GcOpcode.struct_get,
        ...WasmModule.encodeSignedLEB128(actualIndex),
        ...WasmModule.encodeSignedLEB128(1),
      ); // context field

      // 2. Args for wrapped call (subset of wrapper args)
      const expectedParams = ctx.module.getFunctionTypeParams(
        expectedClosure.funcTypeIndex,
      );
      const actualParams = ctx.module.getFunctionTypeParams(
        actualClosure.funcTypeIndex,
      );

      for (let i = 0; i < actualArity; i++) {
        funcBody.push(Opcode.local_get, i + 1);

        const sourceType = expectedParams[i + 1];
        const targetType = actualParams[i + 1];

        // Check if source is anyref and target is a specific struct type
        // This handles `this` type in callback parameters: interface uses anyref,
        // but the actual closure expects a specific class type
        const isSourceAnyRef =
          (sourceType.length === 1 && sourceType[0] === ValType.anyref) ||
          (sourceType.length === 2 &&
            sourceType[0] === ValType.ref_null &&
            sourceType[1] === ValType.anyref);
        const isTargetStruct =
          targetType.length > 1 &&
          (targetType[0] === ValType.ref || targetType[0] === ValType.ref_null);

        if (isSourceAnyRef && isTargetStruct) {
          // Cast from anyref to the specific struct type
          funcBody.push(0xfb, GcOpcode.ref_cast_null);
          funcBody.push(...targetType.slice(1)); // type index
        }
        // Interface Boxing
        else if (sourceType.length > 1 && targetType.length > 1) {
          const sourceTypeIndex = decodeTypeIndex(sourceType);
          const targetTypeIndex = decodeTypeIndex(targetType);

          if (
            sourceTypeIndex !== -1 &&
            targetTypeIndex !== -1 &&
            sourceTypeIndex !== targetTypeIndex
          ) {
            // Check if target is interface using O(1) lookup
            const interfaceInfo =
              ctx.getInterfaceInfoByStructIndex(targetTypeIndex);

            if (interfaceInfo) {
              // Check if source is class implementing interface using O(1) lookup
              let classInfo =
                ctx.getClassInfoByStructIndexDirect(sourceTypeIndex);

              // Check extensions using WASM type index
              if (!classInfo) {
                const extensions =
                  ctx.getExtensionClassesByWasmTypeIndex(sourceTypeIndex);
                if (extensions && extensions.length > 0) {
                  classInfo = extensions[0];
                }
              }

              if (
                classInfo &&
                classInfo.implements &&
                interfaceInfo.checkerType
              ) {
                // Use identity-based lookup with InterfaceType
                const targetInterfaceType = interfaceInfo.checkerType;
                let impl = classInfo.implements.get(targetInterfaceType);

                // If not found, check if the class implements a subtype
                if (!impl) {
                  for (const [implType, implInfo] of classInfo.implements) {
                    if (
                      ctx.checkerContext.isInterfaceAssignableTo(implType, targetInterfaceType)
                    ) {
                      impl = implInfo;
                      break;
                    }
                  }
                }

                if (impl) {
                  // Box it!
                  funcBody.push(
                    Opcode.global_get,
                    ...WasmModule.encodeSignedLEB128(impl.vtableGlobalIndex),
                  );
                  funcBody.push(0xfb, GcOpcode.struct_new);
                  funcBody.push(
                    ...WasmModule.encodeSignedLEB128(
                      interfaceInfo.structTypeIndex,
                    ),
                  );
                }
              }
            }
          }
        }
      }

      // 3. Func Ref for wrapped call
      funcBody.push(Opcode.local_get, 0);
      funcBody.push(
        0xfb,
        GcOpcode.ref_cast,
        ...WasmModule.encodeSignedLEB128(actualIndex),
      );
      funcBody.push(
        0xfb,
        GcOpcode.struct_get,
        ...WasmModule.encodeSignedLEB128(actualIndex),
        ...WasmModule.encodeSignedLEB128(0),
      ); // func field

      // 4. Call
      funcBody.push(
        Opcode.call_ref,
        ...WasmModule.encodeSignedLEB128(actualClosure.funcTypeIndex),
      );

      funcBody.push(Opcode.end);

      ctx.module.addCode(wrapperFuncIndex, locals, funcBody);
    });

    // Instantiate Wrapper Closure
    // Stack: [ActualClosure] (from generateExpression above)

    // Use a temp local to hold the actual closure while we push the func ref
    const tempLocal = ctx.declareLocal('$$temp_closure_adapter', actualType);
    body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(tempLocal));

    body.push(
      Opcode.ref_func,
      ...WasmModule.encodeSignedLEB128(wrapperFuncIndex),
    );
    body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempLocal));

    body.push(
      0xfb,
      GcOpcode.struct_new,
      ...WasmModule.encodeSignedLEB128(expectedIndex),
    );
    return;
  }

  generateExpression(ctx, arg, body);
}

export function isAdaptable(
  ctx: CodegenContext,
  actualType: number[],
  expectedType: number[],
): boolean {
  const expectedIndex = decodeTypeIndex(expectedType);
  const actualIndex = decodeTypeIndex(actualType);

  if (expectedIndex === actualIndex) return false;

  const expectedClosure = ctx.closureStructs.get(expectedIndex);
  const actualClosure = ctx.closureStructs.get(actualIndex);

  if (expectedClosure && actualClosure) {
    return true;
  }
  return false;
}

function generateMatchExpression(
  ctx: CodegenContext,
  expr: MatchExpression,
  body: number[],
) {
  generateExpression(ctx, expr.discriminant, body);

  const discriminantType = inferType(ctx, expr.discriminant);
  const tempDiscriminant = ctx.declareLocal(
    '$$match_discriminant',
    discriminantType,
  );
  body.push(
    Opcode.local_set,
    ...WasmModule.encodeSignedLEB128(tempDiscriminant),
  );

  let resultType: number[] = [];
  if (expr.inferredType) {
    resultType = mapCheckerTypeToWasmType(ctx, expr.inferredType);
  }

  // Block for the entire match expression (exit when a case succeeds)
  const matchDoneBlockTypeIndex = ctx.module.addType([], [resultType]);
  body.push(Opcode.block);
  body.push(...WasmModule.encodeSignedLEB128(matchDoneBlockTypeIndex));

  for (let i = 0; i < expr.cases.length; i++) {
    const c = expr.cases[i];

    // Block for this case (exit if pattern fails or guard fails)
    body.push(Opcode.block, ValType.void);

    // 1. Check Pattern
    generateMatchPatternCheck(
      ctx,
      c.pattern,
      tempDiscriminant,
      discriminantType,
      body,
    );

    // If 0 (false), break to next case (end of this block)
    body.push(Opcode.i32_eqz);
    body.push(Opcode.br_if, 0);

    // 2. Bind Variables
    generateMatchPatternBindings(
      ctx,
      c.pattern,
      tempDiscriminant,
      discriminantType,
      body,
    );

    // 3. Check Guard (if exists)
    if (c.guard) {
      generateExpression(ctx, c.guard, body);
      // If 0 (false), break to next case
      body.push(Opcode.i32_eqz);
      body.push(Opcode.br_if, 0);
    }

    // 4. Execute Body
    generateMatchCaseBody(ctx, c.body, body);

    // 5. Break to match done
    // We are inside:
    // match_done (depth 1 relative to here)
    //   case_block (depth 0)
    // So br 1 breaks out of match_done.
    body.push(Opcode.br, 1);

    body.push(Opcode.end); // End case block
  }

  // If we get here, no case matched
  body.push(Opcode.unreachable);

  body.push(Opcode.end); // End match_done block
}

function generateMatchCaseBody(
  ctx: CodegenContext,
  body_node: Expression | BlockStatement,
  body: number[],
) {
  if (body_node.type === NodeType.BlockStatement) {
    generateBlockExpressionCode(ctx, body_node as BlockStatement, body);
  } else {
    generateExpression(ctx, body_node, body);
  }
}

function generateIfExpression(
  ctx: CodegenContext,
  expr: IfExpression,
  body: number[],
) {
  // Get result type from inferred type
  let resultType: number[] = [];
  if (expr.inferredType) {
    resultType = mapCheckerTypeToWasmType(ctx, expr.inferredType);
  }

  // Generate condition
  generateExpression(ctx, expr.test, body);

  // WASM if with result type
  // For void result, we use ValType.void directly.
  // For typed results, we create a block type (function signature with no params
  // and the result type as output) which WASM uses for typed control structures.
  body.push(Opcode.if);
  if (resultType.length === 0) {
    body.push(ValType.void);
  } else {
    const blockTypeIndex = ctx.module.addType([], [resultType]);
    body.push(...WasmModule.encodeSignedLEB128(blockTypeIndex));
  }

  // Generate consequent
  generateIfBranch(ctx, expr.consequent, body);

  // Generate else branch
  body.push(Opcode.else);
  generateIfBranch(ctx, expr.alternate, body);

  body.push(Opcode.end);
}

function generateIfBranch(
  ctx: CodegenContext,
  branch: Expression | BlockStatement,
  body: number[],
) {
  if (branch.type === NodeType.BlockStatement) {
    generateBlockExpressionCode(ctx, branch as BlockStatement, body);
  } else {
    generateExpression(ctx, branch, body);
  }
}

function generateBlockExpressionCode(
  ctx: CodegenContext,
  block: BlockStatement,
  body: number[],
) {
  ctx.pushScope();

  // Generate all statements except the last
  for (let i = 0; i < block.body.length - 1; i++) {
    generateFunctionStatement(ctx, block.body[i], body);
  }

  // The last statement should be an expression statement whose value is the block result
  if (block.body.length > 0) {
    const lastStmt = block.body[block.body.length - 1];
    if (lastStmt.type === NodeType.ExpressionStatement) {
      // Generate the expression value (don't drop it)
      generateExpression(ctx, (lastStmt as any).expression, body);
    } else {
      // For other statements (like return), just generate them
      generateFunctionStatement(ctx, lastStmt, body);
    }
  }

  ctx.popScope();
}

function generateMatchPatternCheck(
  ctx: CodegenContext,
  pattern: Pattern,
  discriminantLocal: number,
  discriminantType: number[],
  body: number[],
) {
  switch ((pattern as any).type) {
    case NodeType.Identifier:
      body.push(Opcode.i32_const, 1);
      break;

    case NodeType.AsPattern:
      generateMatchPatternCheck(
        ctx,
        (pattern as AsPattern).pattern,
        discriminantLocal,
        discriminantType,
        body,
      );
      break;

    case NodeType.LogicalPattern: {
      const logicalPattern = pattern as LogicalPattern;
      if (logicalPattern.operator === '||') {
        // left || right
        // Check left
        generateMatchPatternCheck(
          ctx,
          logicalPattern.left,
          discriminantLocal,
          discriminantType,
          body,
        );
        // Stack: [left_result]

        // If left is true, we are done (result is 1)
        body.push(Opcode.if, ValType.i32);
        body.push(Opcode.i32_const, 1);
        body.push(Opcode.else);

        // Check right
        generateMatchPatternCheck(
          ctx,
          logicalPattern.right,
          discriminantLocal,
          discriminantType,
          body,
        );

        body.push(Opcode.end);
      } else {
        // left && right
        // Check left
        generateMatchPatternCheck(
          ctx,
          logicalPattern.left,
          discriminantLocal,
          discriminantType,
          body,
        );
        // Stack: [left_result]

        // If left is true, check right
        body.push(Opcode.if, ValType.i32);

        generateMatchPatternCheck(
          ctx,
          logicalPattern.right,
          discriminantLocal,
          discriminantType,
          body,
        );

        body.push(Opcode.else);
        // Left failed, so result is 0
        body.push(Opcode.i32_const, 0);
        body.push(Opcode.end);
      }
      break;
    }

    case NodeType.NumberLiteral: {
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(discriminantLocal),
      );
      if (
        discriminantType.length === 1 &&
        discriminantType[0] === ValType.i32
      ) {
        body.push(
          Opcode.i32_const,
          ...WasmModule.encodeSignedLEB128((pattern as NumberLiteral).value),
        );
        body.push(Opcode.i32_eq);
      } else if (
        discriminantType.length === 1 &&
        discriminantType[0] === ValType.f32
      ) {
        body.push(
          Opcode.f32_const,
          ...WasmModule.encodeF32((pattern as NumberLiteral).value),
        );
        body.push(Opcode.f32_eq);
      } else {
        // TODO: Handle boxing/unboxing if needed
        body.push(Opcode.drop);
        body.push(Opcode.i32_const, 0);
      }
      break;
    }

    case NodeType.BooleanLiteral: {
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(discriminantLocal),
      );
      if (
        discriminantType.length === 1 &&
        discriminantType[0] === ValType.i32
      ) {
        body.push(
          Opcode.i32_const,
          ...WasmModule.encodeSignedLEB128(
            (pattern as BooleanLiteral).value ? 1 : 0,
          ),
        );
        body.push(Opcode.i32_eq);
      } else {
        body.push(Opcode.drop);
        body.push(Opcode.i32_const, 0);
      }
      break;
    }

    case NodeType.StringLiteral: {
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(discriminantLocal),
      );
      if (isStringType(ctx, discriminantType)) {
        generateStringLiteral(ctx, pattern as StringLiteral, body);
        generateStringEq(ctx, body);
      } else {
        body.push(Opcode.drop);
        body.push(Opcode.i32_const, 0);
      }
      break;
    }

    case NodeType.NullLiteral: {
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(discriminantLocal),
      );
      body.push(Opcode.ref_is_null);
      break;
    }

    case NodeType.ClassPattern: {
      const classPattern = pattern as ClassPattern;
      const className = classPattern.name.name;
      // Identity-based lookup using the pattern's inferred type (no fallback)
      if (classPattern.inferredType?.kind !== TypeKind.Class) {
        throw new Error(
          `ClassPattern for ${className} missing or invalid inferredType`,
        );
      }
      const classInfo = ctx.getClassInfo(
        classPattern.inferredType as ClassType,
      );
      if (!classInfo) {
        throw new Error(
          `Class ${className} not found via identity lookup in ClassPattern`,
        );
      }

      // 1. Check type
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(discriminantLocal),
      );
      body.push(0xfb, GcOpcode.ref_test_null);
      body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));

      // 2. Check properties
      if (classPattern.properties.length > 0) {
        // If type check passed, we need to check properties.
        // We use 'if' to short-circuit.
        // Stack: [is_instance]
        body.push(Opcode.if, ValType.i32);

        // Cast to class type
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(discriminantLocal),
        );
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));

        const castedType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
        ];
        const tempCasted = ctx.declareLocal(
          `$$match_check_cast_${className}`,
          castedType,
        );
        body.push(
          Opcode.local_set,
          ...WasmModule.encodeSignedLEB128(tempCasted),
        );

        // Generate checks for all properties
        // We combine them with AND.
        // Start with true.
        body.push(Opcode.i32_const, 1);

        for (const prop of classPattern.properties) {
          const fieldName = prop.name.name;
          const fieldInfo = classInfo.fields.get(fieldName);
          if (fieldInfo) {
            // Check if we need to check this property (if pattern is not wildcard)
            if (
              prop.value.type !== NodeType.Identifier ||
              (prop.value as Identifier).name !== '_'
            ) {
              body.push(
                Opcode.local_get,
                ...WasmModule.encodeSignedLEB128(tempCasted),
              );
              body.push(0xfb, GcOpcode.struct_get);
              body.push(
                ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
              );
              body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

              // Store field value in temp local to pass to recursive check
              const fieldType = fieldInfo.type;
              const tempField = ctx.declareLocal(
                `$$match_field_${fieldName}`,
                fieldType,
              );
              body.push(
                Opcode.local_set,
                ...WasmModule.encodeSignedLEB128(tempField),
              );

              generateMatchPatternCheck(
                ctx,
                prop.value as Pattern,
                tempField,
                fieldType,
                body,
              );

              body.push(Opcode.i32_and);
            }
          }
        }

        body.push(Opcode.else);
        body.push(Opcode.i32_const, 0);
        body.push(Opcode.end);
      }
      break;
    }

    case NodeType.RecordPattern: {
      const recordPattern = pattern as RecordPattern;
      const structTypeIndex = getHeapTypeIndex(ctx, discriminantType);

      if (structTypeIndex === -1) {
        // Should have been caught by checker
        body.push(Opcode.i32_const, 0);
        break;
      }

      // Check for null if nullable
      if (discriminantType[0] === ValType.ref_null) {
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(discriminantLocal),
        );
        body.push(Opcode.ref_is_null);
        body.push(Opcode.i32_eqz); // Invert: true if not null

        // If null, return 0. If not null, continue checks.
        body.push(Opcode.if, ValType.i32);
        body.push(Opcode.i32_const, 1);
      } else {
        // Not nullable, so implicitly true for the object existence
        body.push(Opcode.block, ValType.i32); // Dummy block to match structure
        body.push(Opcode.i32_const, 1); // Result of "not null" check
      }

      // Now check properties
      // We are inside an 'if' or 'block' that expects i32 result.
      // Current stack: [1] (from the check above)
      // We want to AND with property checks.

      // We need to find the record key to get field indices
      let recordKey: string | undefined;
      for (const [key, index] of ctx.recordTypes) {
        if (index === structTypeIndex) {
          recordKey = key;
          break;
        }
      }

      if (!recordKey) {
        // Fallback for classes used as records?
        // If discriminant is class, we can use class info.
        // Use struct index lookup since we don't have a checker type in pattern context
        const classInfo = ctx.getClassInfoByStructIndexDirect(structTypeIndex);
        if (classInfo) {
          for (const prop of recordPattern.properties) {
            const fieldName = prop.name.name;
            const fieldInfo = classInfo.fields.get(fieldName);
            if (fieldInfo) {
              if (
                prop.value.type !== NodeType.Identifier ||
                (prop.value as Identifier).name !== '_'
              ) {
                body.push(
                  Opcode.local_get,
                  ...WasmModule.encodeSignedLEB128(discriminantLocal),
                );
                body.push(0xfb, GcOpcode.struct_get);
                body.push(
                  ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
                );
                body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

                const fieldType = fieldInfo.type;
                const tempField = ctx.declareLocal(
                  `$$match_field_${fieldName}`,
                  fieldType,
                );
                body.push(
                  Opcode.local_set,
                  ...WasmModule.encodeSignedLEB128(tempField),
                );

                generateMatchPatternCheck(
                  ctx,
                  prop.value as Pattern,
                  tempField,
                  fieldType,
                  body,
                );
                body.push(Opcode.i32_and);
              }
            }
          }
        }
      } else {
        // It is a Record
        const fields = recordKey.split(';').map((s) => {
          const colonIndex = s.indexOf(':');
          const name = s.substring(0, colonIndex);
          // We need type too?
          return {name};
        });

        // We need types of fields to declare locals.
        // We can get them from the struct type definition in the module?
        // Or we can infer from the pattern? No, we need the actual struct field type.
        // ctx.module.getStructFieldType(structTypeIndex, fieldIndex)

        for (const prop of recordPattern.properties) {
          const fieldName = prop.name.name;
          const fieldIndex = fields.findIndex((f) => f.name === fieldName);

          if (fieldIndex !== -1) {
            if (
              prop.value.type !== NodeType.Identifier ||
              (prop.value as Identifier).name !== '_'
            ) {
              const fieldTypeBytes = ctx.module.getStructFieldType(
                structTypeIndex,
                fieldIndex,
              );
              const fieldType = decodeWasmType(fieldTypeBytes);

              body.push(
                Opcode.local_get,
                ...WasmModule.encodeSignedLEB128(discriminantLocal),
              );
              body.push(0xfb, GcOpcode.struct_get);
              body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
              body.push(...WasmModule.encodeSignedLEB128(fieldIndex));

              const tempField = ctx.declareLocal(
                `$$match_field_${fieldName}`,
                fieldType,
              );
              body.push(
                Opcode.local_set,
                ...WasmModule.encodeSignedLEB128(tempField),
              );

              generateMatchPatternCheck(
                ctx,
                prop.value as Pattern,
                tempField,
                fieldType,
                body,
              );
              body.push(Opcode.i32_and);
            }
          }
        }
      }

      if (discriminantType[0] === ValType.ref_null) {
        body.push(Opcode.else);
        body.push(Opcode.i32_const, 0);
        body.push(Opcode.end);
      } else {
        body.push(Opcode.end); // End dummy block
      }
      break;
    }

    case NodeType.TuplePattern: {
      const tuplePattern = pattern as TuplePattern;
      const structTypeIndex = getHeapTypeIndex(ctx, discriminantType);

      if (structTypeIndex === -1) {
        body.push(Opcode.i32_const, 0);
        break;
      }

      // Check for null
      if (discriminantType[0] === ValType.ref_null) {
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(discriminantLocal),
        );
        body.push(Opcode.ref_is_null);
        body.push(Opcode.i32_eqz);
        body.push(Opcode.if, ValType.i32);
        body.push(Opcode.i32_const, 1);
      } else {
        body.push(Opcode.block, ValType.i32);
        body.push(Opcode.i32_const, 1);
      }

      // Check elements
      // Is it a Tuple (Struct) or Array?
      let isTuple = false;
      for (const [_, index] of ctx.tupleTypes) {
        if (index === structTypeIndex) {
          isTuple = true;
          break;
        }
      }

      if (isTuple) {
        for (let i = 0; i < tuplePattern.elements.length; i++) {
          const elemPattern = tuplePattern.elements[i];
          if (
            elemPattern &&
            (elemPattern.type !== NodeType.Identifier ||
              (elemPattern as Identifier).name !== '_')
          ) {
            const fieldTypeBytes = ctx.module.getStructFieldType(
              structTypeIndex,
              i,
            );
            const fieldType = decodeWasmType(fieldTypeBytes);

            body.push(
              Opcode.local_get,
              ...WasmModule.encodeSignedLEB128(discriminantLocal),
            );
            body.push(0xfb, GcOpcode.struct_get);
            body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
            body.push(...WasmModule.encodeSignedLEB128(i));

            const tempElem = ctx.declareLocal(`$$match_elem_${i}`, fieldType);
            body.push(
              Opcode.local_set,
              ...WasmModule.encodeSignedLEB128(tempElem),
            );

            generateMatchPatternCheck(
              ctx,
              elemPattern,
              tempElem,
              fieldType,
              body,
            );
            body.push(Opcode.i32_and);
          }
        }
      } else {
        // Array
        // Check length first?
        // Tuple pattern [a, b] on array implies length check?
        // Usually yes for exact match, or prefix match?
        // Zena tuples are fixed length. Arrays are variable.
        // If matching array with [a, b], we probably expect length >= 2 or == 2.
        // Let's assume exact length for now to be safe.

        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(discriminantLocal),
        );
        body.push(0xfb, GcOpcode.array_len);
        body.push(
          Opcode.i32_const,
          ...WasmModule.encodeSignedLEB128(tuplePattern.elements.length),
        );
        body.push(Opcode.i32_eq);
        body.push(Opcode.i32_and);

        // Check elements
        // We need element type.
        // Array type definition: [ref_null, ...index]
        // We need to get the array type definition from the module to know element type.
        // But we can assume it's uniform.
        // We can get it from discriminantType?
        // discriminantType is [ref_null, arrayTypeIndex]

        // We need to know the element type to declare local.
        // ctx.module.getArrayElementType(arrayTypeIndex)
        // I don't have this helper.
        // But I can assume it's anyref or similar if I don't know.
        // Actually, I can use `inferType` on the pattern? No.

        // Let's skip array destructuring deep check for now if we can't easily get type.
        // Or assume i32 if unknown? No.
        // Wait, `discriminantType` has the array type index.
        // I can read the type from the module.
      }

      if (discriminantType[0] === ValType.ref_null) {
        body.push(Opcode.else);
        body.push(Opcode.i32_const, 0);
        body.push(Opcode.end);
      } else {
        body.push(Opcode.end);
      }
      break;
    }

    default:
      body.push(Opcode.i32_const, 0);
      break;
  }
}

function decodeWasmType(bytes: number[]): number[] {
  // Simple decoder for single value types
  // If it's a heap type, it might be multiple bytes (LEB128)
  // But getStructFieldType returns the raw bytes of the value type.
  // e.g. [0x7F] for i32.
  // [0x6B, ...leb128] for ref_null.
  return bytes;
}

function generateMatchPatternBindings(
  ctx: CodegenContext,
  pattern: Pattern,
  discriminantLocal: number,
  discriminantType: number[],
  body: number[],
) {
  if ((pattern as any).type === NodeType.AsPattern) {
    const asPattern = pattern as AsPattern;
    let localIndex: number;
    const existing = ctx.getLocal(asPattern.name.name);
    if (
      existing !== undefined &&
      typesAreEqual(existing.type, discriminantType)
    ) {
      localIndex = existing.index;
    } else {
      localIndex = ctx.declareLocal(asPattern.name.name, discriminantType);
    }

    body.push(
      Opcode.local_get,
      ...WasmModule.encodeSignedLEB128(discriminantLocal),
    );
    body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(localIndex));

    generateMatchPatternBindings(
      ctx,
      asPattern.pattern,
      discriminantLocal,
      discriminantType,
      body,
    );
  } else if (pattern.type === NodeType.LogicalPattern) {
    const logicalPattern = pattern as LogicalPattern;
    if (logicalPattern.operator === '||') {
      // We need to check which one matched to bind correctly.
      // Since we are here, we know at least one matched.

      generateMatchPatternCheck(
        ctx,
        logicalPattern.left,
        discriminantLocal,
        discriminantType,
        body,
      );

      body.push(Opcode.if, ValType.void);

      // Left matched
      generateMatchPatternBindings(
        ctx,
        logicalPattern.left,
        discriminantLocal,
        discriminantType,
        body,
      );

      body.push(Opcode.else);

      // Right matched
      generateMatchPatternBindings(
        ctx,
        logicalPattern.right,
        discriminantLocal,
        discriminantType,
        body,
      );

      body.push(Opcode.end);
    } else {
      // && - bind both
      generateMatchPatternBindings(
        ctx,
        logicalPattern.left,
        discriminantLocal,
        discriminantType,
        body,
      );
      generateMatchPatternBindings(
        ctx,
        logicalPattern.right,
        discriminantLocal,
        discriminantType,
        body,
      );
    }
  } else if (pattern.type === NodeType.Identifier) {
    if (pattern.name !== '_') {
      let localIndex: number;
      const existing = ctx.getLocal(pattern.name);
      if (
        existing !== undefined &&
        typesAreEqual(existing.type, discriminantType)
      ) {
        localIndex = existing.index;
      } else {
        localIndex = ctx.declareLocal(pattern.name, discriminantType);
      }

      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(discriminantLocal),
      );
      body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(localIndex));
    }
  } else if (pattern.type === NodeType.ClassPattern) {
    const classPattern = pattern as ClassPattern;
    const className = classPattern.name.name;
    // Identity-based lookup using the pattern's inferred type (no fallback)
    if (classPattern.inferredType?.kind !== TypeKind.Class) {
      throw new Error(
        `ClassPattern for ${className} missing or invalid inferredType`,
      );
    }
    const classInfo = ctx.getClassInfo(classPattern.inferredType as ClassType);
    if (!classInfo) {
      throw new Error(
        `Class ${className} not found via identity lookup in ClassPattern`,
      );
    }

    // Cast
    body.push(
      Opcode.local_get,
      ...WasmModule.encodeSignedLEB128(discriminantLocal),
    );
    body.push(0xfb, GcOpcode.ref_cast_null);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));

    const castedType = [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
    ];
    const tempCasted = ctx.declareLocal(
      `$$match_cast_${className}`,
      castedType,
    );
    body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(tempCasted));

    for (const prop of classPattern.properties) {
      const fieldName = prop.name.name;
      const fieldInfo = classInfo.fields.get(fieldName);
      if (fieldInfo) {
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(tempCasted),
        );
        body.push(0xfb, GcOpcode.struct_get);
        body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
        body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

        const fieldType = fieldInfo.type;

        // If the property value is a pattern, we need to bind it recursively.
        // We need a temp local for the field value to pass to recursive call.
        const tempField = ctx.declareLocal(
          `$$match_bind_field_${fieldName}`,
          fieldType,
        );
        body.push(
          Opcode.local_tee,
          ...WasmModule.encodeSignedLEB128(tempField),
        );

        // If it's just an identifier, we could optimize, but recursive call handles it.
        // But wait, generateMatchPatternBindings expects the value to be in a local?
        // Yes, `discriminantLocal`.

        // So we set it to tempField, then call recursive.
        // Note: local_tee leaves value on stack, but we need to consume it or drop it?
        // generateMatchPatternBindings does NOT consume stack. It expects value in local.
        // So we should use local_set.
        // Wait, I used local_tee above.
        // Correct: local_set.

        // Actually, I used local_tee then... wait.
        // body.push(Opcode.local_tee... tempField)
        // Then what?
        // I need to call generateMatchPatternBindings.
        // It doesn't consume stack.
        // So I should use local_set.

        // Correction:
        body.pop(); // remove local_tee opcode
        body.pop(); // remove local index
        body.push(
          Opcode.local_set,
          ...WasmModule.encodeSignedLEB128(tempField),
        );

        generateMatchPatternBindings(
          ctx,
          prop.value as Pattern,
          tempField,
          fieldType,
          body,
        );
      }
    }
  } else if (pattern.type === NodeType.RecordPattern) {
    const recordPattern = pattern as RecordPattern;
    const structTypeIndex = getHeapTypeIndex(ctx, discriminantType);

    // Similar logic to ClassPattern but for Records
    // We assume it's already castable/checked.

    let recordKey: string | undefined;
    for (const [key, index] of ctx.recordTypes) {
      if (index === structTypeIndex) {
        recordKey = key;
        break;
      }
    }

    if (recordKey) {
      const fields = recordKey.split(';').map((s) => {
        const colonIndex = s.indexOf(':');
        const name = s.substring(0, colonIndex);
        return {name};
      });

      for (const prop of recordPattern.properties) {
        const fieldName = prop.name.name;
        const fieldIndex = fields.findIndex((f) => f.name === fieldName);

        if (fieldIndex !== -1) {
          const fieldTypeBytes = ctx.module.getStructFieldType(
            structTypeIndex,
            fieldIndex,
          );
          const fieldType = decodeWasmType(fieldTypeBytes);

          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(discriminantLocal),
          );
          body.push(0xfb, GcOpcode.struct_get);
          body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
          body.push(...WasmModule.encodeSignedLEB128(fieldIndex));

          const tempField = ctx.declareLocal(
            `$$match_bind_field_${fieldName}`,
            fieldType,
          );
          body.push(
            Opcode.local_set,
            ...WasmModule.encodeSignedLEB128(tempField),
          );

          generateMatchPatternBindings(
            ctx,
            prop.value as Pattern,
            tempField,
            fieldType,
            body,
          );
        }
      }
    }
  } else if (pattern.type === NodeType.AsPattern) {
    const asPattern = pattern as AsPattern;
    let localIndex: number;
    const existing = ctx.getLocal(asPattern.name.name);
    if (existing && typesAreEqual(existing.type, discriminantType)) {
      localIndex = existing.index;
    } else {
      localIndex = ctx.declareLocal(asPattern.name.name, discriminantType);
    }

    body.push(
      Opcode.local_get,
      ...WasmModule.encodeSignedLEB128(discriminantLocal),
    );
    body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(localIndex));

    generateMatchPatternBindings(
      ctx,
      asPattern.pattern,
      discriminantLocal,
      discriminantType,
      body,
    );
  } else if (pattern.type === NodeType.TuplePattern) {
    const tuplePattern = pattern as TuplePattern;
    const structTypeIndex = getHeapTypeIndex(ctx, discriminantType);

    let isTuple = false;
    for (const [_, index] of ctx.tupleTypes) {
      if (index === structTypeIndex) {
        isTuple = true;
        break;
      }
    }

    if (isTuple) {
      for (let i = 0; i < tuplePattern.elements.length; i++) {
        const elemPattern = tuplePattern.elements[i];
        if (elemPattern) {
          const fieldTypeBytes = ctx.module.getStructFieldType(
            structTypeIndex,
            i,
          );
          const fieldType = decodeWasmType(fieldTypeBytes);

          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(discriminantLocal),
          );
          body.push(0xfb, GcOpcode.struct_get);
          body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
          body.push(...WasmModule.encodeSignedLEB128(i));

          const tempElem = ctx.declareLocal(
            `$$match_bind_elem_${i}`,
            fieldType,
          );
          body.push(
            Opcode.local_set,
            ...WasmModule.encodeSignedLEB128(tempElem),
          );

          generateMatchPatternBindings(
            ctx,
            elemPattern,
            tempElem,
            fieldType,
            body,
          );
        }
      }
    }
  }
}
