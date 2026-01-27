import {
  NodeType,
  type BlockStatement,
  type ForStatement,
  type IfStatement,
  type Pattern,
  type RecordPattern,
  type ReturnStatement,
  type Statement,
  type TuplePattern,
  type VariableDeclaration,
  type WhileStatement,
  type TypeAnnotation,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {GcOpcode, Opcode, ValType, HeapType} from '../wasm.js';
import {
  decodeTypeIndex,
  getClassFromTypeIndex,
  mapType,
  mapCheckerTypeToWasmType,
} from './classes.js';
import type {CodegenContext} from './context.js';
import {
  generateExpression,
  inferType,
  generateAdaptedArgument,
  isAdaptable,
  boxPrimitive,
} from './expressions.js';

export function generateStatement(
  ctx: CodegenContext,
  statement: Statement,
  body: number[],
) {
  switch (statement.type) {
    case NodeType.VariableDeclaration:
      generateLocalVariableDeclaration(
        ctx,
        statement as VariableDeclaration,
        body,
      );
      break;
    case NodeType.ExpressionStatement:
      // Top level expressions not really supported in WASM module structure directly without a start function or similar
      // For now, ignore or throw?
      break;
    case NodeType.BlockStatement:
      // Not supported at top level yet
      break;
  }
}

export function generateBlockStatement(
  ctx: CodegenContext,
  block: BlockStatement,
  body: number[],
) {
  ctx.pushScope();
  for (const stmt of block.body) {
    generateFunctionStatement(ctx, stmt, body);
  }
  ctx.popScope();
}

export function generateFunctionStatement(
  ctx: CodegenContext,
  stmt: Statement,
  body: number[],
) {
  switch (stmt.type) {
    case NodeType.ReturnStatement:
      generateReturnStatement(ctx, stmt as ReturnStatement, body);
      break;
    case NodeType.ExpressionStatement: {
      const expr = (stmt as any).expression;
      generateExpression(ctx, expr, body);
      const type = inferType(ctx, expr);
      if (type.length > 0) {
        body.push(Opcode.drop);
      }
      break;
    }
    case NodeType.VariableDeclaration:
      generateLocalVariableDeclaration(ctx, stmt as VariableDeclaration, body);
      break;
    case NodeType.BlockStatement:
      generateBlockStatement(ctx, stmt as BlockStatement, body);
      break;
    case NodeType.IfStatement:
      generateIfStatement(ctx, stmt as IfStatement, body);
      break;
    case NodeType.WhileStatement:
      generateWhileStatement(ctx, stmt as WhileStatement, body);
      break;
    case NodeType.ForStatement:
      generateForStatement(ctx, stmt as ForStatement, body);
      break;
  }
}

export function generateIfStatement(
  ctx: CodegenContext,
  stmt: IfStatement,
  body: number[],
) {
  generateExpression(ctx, stmt.test, body);
  body.push(Opcode.if);
  body.push(ValType.void);
  generateFunctionStatement(ctx, stmt.consequent, body);
  if (stmt.alternate) {
    body.push(Opcode.else);
    generateFunctionStatement(ctx, stmt.alternate, body);
  }
  body.push(Opcode.end);
}

export function generateWhileStatement(
  ctx: CodegenContext,
  stmt: WhileStatement,
  body: number[],
) {
  // block $break
  //   loop $continue
  //     condition
  //     i32.eqz
  //     br_if $break
  //     body
  //     br $continue
  //   end
  // end

  body.push(Opcode.block);
  body.push(ValType.void);
  body.push(Opcode.loop);
  body.push(ValType.void);

  generateExpression(ctx, stmt.test, body);
  body.push(Opcode.i32_eqz); // Invert condition
  body.push(Opcode.br_if);
  body.push(...WasmModule.encodeSignedLEB128(1)); // Break to block (depth 1)

  generateFunctionStatement(ctx, stmt.body, body);

  body.push(Opcode.br);
  body.push(...WasmModule.encodeSignedLEB128(0)); // Continue to loop (depth 0)

  body.push(Opcode.end); // End loop
  body.push(Opcode.end); // End block
}

export function generateForStatement(
  ctx: CodegenContext,
  stmt: ForStatement,
  body: number[],
) {
  // For loop: for (init; test; update) body
  // Equivalent to:
  //   {
  //     init;
  //     while (test) {
  //       body;
  //       update;
  //     }
  //   }
  //
  // WASM structure:
  //   init
  //   block $break
  //     loop $continue
  //       test
  //       i32.eqz
  //       br_if $break
  //       body
  //       update
  //       br $continue
  //     end
  //   end

  ctx.pushScope();

  // Generate init
  if (stmt.init) {
    if (stmt.init.type === NodeType.VariableDeclaration) {
      generateLocalVariableDeclaration(
        ctx,
        stmt.init as VariableDeclaration,
        body,
      );
    } else {
      generateExpression(ctx, stmt.init, body);
      const initType = inferType(ctx, stmt.init);
      if (initType.length > 0) {
        body.push(Opcode.drop);
      }
    }
  }

  body.push(Opcode.block);
  body.push(ValType.void);
  body.push(Opcode.loop);
  body.push(ValType.void);

  // Generate test
  if (stmt.test) {
    generateExpression(ctx, stmt.test, body);
    body.push(Opcode.i32_eqz); // Invert condition
    body.push(Opcode.br_if);
    body.push(...WasmModule.encodeSignedLEB128(1)); // Break to block (depth 1)
  }

  // Generate body
  generateFunctionStatement(ctx, stmt.body, body);

  // Generate update
  if (stmt.update) {
    generateExpression(ctx, stmt.update, body);
    const updateType = inferType(ctx, stmt.update);
    if (updateType.length > 0) {
      body.push(Opcode.drop);
    }
  }

  body.push(Opcode.br);
  body.push(...WasmModule.encodeSignedLEB128(0)); // Continue to loop (depth 0)

  body.push(Opcode.end); // End loop
  body.push(Opcode.end); // End block

  ctx.popScope();
}

export function generateLocalVariableDeclaration(
  ctx: CodegenContext,
  decl: VariableDeclaration,
  body: number[],
) {
  let exprType: number[] = [];
  let adapted = false;

  // Resolve type alias if necessary
  let typeAnnotation = decl.typeAnnotation;
  if (
    typeAnnotation &&
    typeAnnotation.type === NodeType.TypeAnnotation &&
    ctx.typeAliases.has(typeAnnotation.name)
  ) {
    typeAnnotation = resolveType(ctx, typeAnnotation);
  }

  // Check for Union Adaptation
  if (typeAnnotation && typeAnnotation.type === NodeType.UnionTypeAnnotation) {
    // Infer actual type of initializer
    let actualType: number[] = [];
    try {
      actualType = inferType(ctx, decl.init);
    } catch (e) {
      // Ignore inference errors
    }

    if (actualType.length > 0) {
      // Try to find a member type that requires adaptation
      for (const member of typeAnnotation.types) {
        // Prefer checker-based type resolution when available
        const memberWasmType = member.inferredType
          ? mapCheckerTypeToWasmType(ctx, member.inferredType)
          : mapType(ctx, member, ctx.currentTypeContext);
        if (isAdaptable(ctx, actualType, memberWasmType)) {
          generateAdaptedArgument(ctx, decl.init, memberWasmType, body);
          adapted = true;
          exprType = memberWasmType;
          break;
        }
      }
    }
  }

  if (!adapted) {
    generateExpression(ctx, decl.init, body);
    exprType = inferType(ctx, decl.init);
  }

  let type: number[];
  if (decl.typeAnnotation) {
    // Prefer checker's inferredType (identity-based) when available
    // If we're inside a generic context, resolve type parameters using the
    // current type param map (which may include both class and method params)
    let resolvedType = decl.inferredType;
    if (resolvedType && ctx.currentTypeParamMap.size > 0) {
      resolvedType = ctx.checkerContext.substituteTypeParams(
        resolvedType,
        ctx.currentTypeParamMap,
      );
    }
    if (!resolvedType) {
      throw new Error(`Variable declaration missing checker type`);
    }
    type = mapCheckerTypeToWasmType(ctx, resolvedType);

    // Union boxing (i32 -> anyref)
    const isAnyRef =
      (type.length === 1 && type[0] === ValType.anyref) ||
      (type.length === 2 &&
        type[0] === ValType.ref_null &&
        type[1] === HeapType.any);

    if (
      isAnyRef &&
      exprType.length === 1 &&
      (exprType[0] === ValType.i32 ||
        exprType[0] === ValType.i64 ||
        exprType[0] === ValType.f32 ||
        exprType[0] === ValType.f64)
    ) {
      boxPrimitive(ctx, exprType, body);
    }

    // Check for interface boxing
    if (
      decl.typeAnnotation.type === NodeType.TypeAnnotation &&
      ctx.interfaces.has(decl.typeAnnotation.name)
    ) {
      const initType = inferType(ctx, decl.init);
      const typeIndex = decodeTypeIndex(initType);
      const classInfo = getClassFromTypeIndex(ctx, typeIndex);

      if (classInfo && classInfo.implements) {
        const baseName = decl.typeAnnotation.name;
        const interfaceInfo = ctx.interfaces.get(baseName)!;

        // First try exact name match
        let implInfo = classInfo.implements.get(baseName);

        // If not found, try to find by generic interface match
        // e.g., looking for "Box" should match "Box<i32>"
        if (!implInfo) {
          for (const [name, info] of classInfo.implements) {
            // Check if name is a specialization of baseName
            if (name.startsWith(baseName + '<')) {
              implInfo = info;
              break;
            }
          }
        }

        if (!implInfo) {
          // Search for subtype
          for (const [name, info] of classInfo.implements) {
            let currentName: string | undefined = name;
            // Extract base name from specialized name for comparison
            const implBaseName = currentName.includes('<')
              ? currentName.split('<')[0]
              : currentName;
            while (currentName) {
              const checkName = currentName.includes('<')
                ? currentName.split('<')[0]
                : currentName;
              if (checkName === baseName) {
                implInfo = info;
                break;
              }
              const currentInfo = ctx.interfaces.get(implBaseName);
              currentName = currentInfo?.parent;
            }
            if (implInfo) break;
          }
        }

        if (implInfo) {
          body.push(
            Opcode.global_get,
            ...WasmModule.encodeSignedLEB128(implInfo.vtableGlobalIndex),
          );
          body.push(
            0xfb,
            GcOpcode.struct_new,
            ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
          );
        } else {
          // Fallback or error?
          // If we are here, it means we think it implements the interface but we can't find the vtable.
          // This might happen if the type checker passed it but we missed something in codegen.
          // For now, let it fall through and likely trap or fail validation.
        }
      }
    }
  } else {
    type = inferType(ctx, decl.init);
    if (decl.pattern.type === NodeType.Identifier) {
    }
  }

  if (decl.pattern.type === NodeType.Identifier) {
    const index = ctx.declareLocal(decl.pattern.name, type, decl);
    body.push(Opcode.local_set);
    body.push(...WasmModule.encodeSignedLEB128(index));
  } else {
    generatePatternBinding(ctx, decl.pattern, type, body);
  }
}

function generatePatternBinding(
  ctx: CodegenContext,
  pattern: Pattern,
  valueType: number[],
  body: number[],
) {
  if (pattern.type === NodeType.Identifier) {
    const index = ctx.declareLocal(pattern.name, valueType, pattern);
    body.push(Opcode.local_set);
    body.push(...WasmModule.encodeSignedLEB128(index));
    return;
  }

  if (pattern.type === NodeType.AssignmentPattern) {
    // Ignore default value for now, assume value is present
    generatePatternBinding(ctx, pattern.left, valueType, body);
    return;
  }

  // Complex pattern: store value in temp local
  const tempIndex = ctx.declareLocal('$$temp_destructure', valueType);
  body.push(Opcode.local_set);
  body.push(...WasmModule.encodeSignedLEB128(tempIndex));

  if (pattern.type === NodeType.RecordPattern) {
    generateRecordPattern(ctx, pattern, valueType, tempIndex, body);
  } else if (pattern.type === NodeType.TuplePattern) {
    generateTuplePattern(ctx, pattern, valueType, tempIndex, body);
  }
}

function generateRecordPattern(
  ctx: CodegenContext,
  pattern: RecordPattern,
  valueType: number[],
  tempIndex: number,
  body: number[],
) {
  const typeIndex = decodeTypeIndex(valueType);
  // Find field indices
  // We need to find the key in recordTypes that maps to typeIndex
  let recordKey: string | undefined;
  for (const [key, index] of ctx.recordTypes) {
    if (index === typeIndex) {
      recordKey = key;
      break;
    }
  }

  if (!recordKey) {
    // Maybe it's a class?
    const classInfo = getClassFromTypeIndex(ctx, typeIndex);
    if (classInfo) {
      for (const prop of pattern.properties) {
        const fieldName = prop.name.name;
        const fieldInfo = classInfo.fields.get(fieldName);
        if (!fieldInfo) {
          throw new Error(
            `Field ${fieldName} not found in class ${classInfo.name}`,
          );
        }

        // Load temp
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(tempIndex));

        // Get field
        body.push(0xfb, GcOpcode.struct_get);
        body.push(...WasmModule.encodeSignedLEB128(typeIndex));
        body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

        // Recurse
        const fieldType = fieldInfo.type;
        generatePatternBinding(ctx, prop.value, fieldType, body);
      }
      return;
    }
    throw new Error(`Could not find record type for index ${typeIndex}`);
  }

  // Parse key: "x:127;y:127"
  const fields = recordKey.split(';').map((s) => {
    const [name, typeStr] = s.split(':');
    const type = typeStr.split(',').map(Number);
    return {name, type};
  });

  for (const prop of pattern.properties) {
    const fieldName = prop.name.name;
    const fieldIndex = fields.findIndex((f) => f.name === fieldName);
    if (fieldIndex === -1) {
      throw new Error(`Field ${fieldName} not found in record ${recordKey}`);
    }

    const fieldWasmType = fields[fieldIndex].type;

    // Load temp
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(tempIndex));

    // Get field
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
    body.push(...WasmModule.encodeSignedLEB128(fieldIndex));

    // Recurse
    generatePatternBinding(ctx, prop.value, fieldWasmType, body);
  }
}

function generateTuplePattern(
  ctx: CodegenContext,
  pattern: TuplePattern,
  valueType: number[],
  tempIndex: number,
  body: number[],
) {
  const typeIndex = decodeTypeIndex(valueType);
  // Find tuple key
  let tupleKey: string | undefined;
  for (const [key, index] of ctx.tupleTypes) {
    if (index === typeIndex) {
      tupleKey = key;
      break;
    }
  }

  if (!tupleKey) {
    // Maybe it's an Array?
    // Arrays are (ref $ArrayType).
    // We need to check if typeIndex corresponds to an Array type.
    // For now, assume Tuple.
    throw new Error(`Could not find tuple type for index ${typeIndex}`);
  }

  // Parse key: "127;127"
  const types = tupleKey.split(';').map((t) => t.split(',').map(Number));

  for (let i = 0; i < pattern.elements.length; i++) {
    const elemPattern = pattern.elements[i];
    if (!elemPattern) continue; // Skipped

    if (i >= types.length) {
      throw new Error(
        `Tuple pattern index ${i} out of bounds for type ${tupleKey}`,
      );
    }

    const fieldWasmType = types[i];

    // Load temp
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(tempIndex));

    // Get field
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
    body.push(...WasmModule.encodeSignedLEB128(i));

    // Recurse
    generatePatternBinding(ctx, elemPattern, fieldWasmType, body);
  }
}

export function generateReturnStatement(
  ctx: CodegenContext,
  stmt: ReturnStatement,
  body: number[],
) {
  if (stmt.argument) {
    if (ctx.currentReturnType) {
      generateAdaptedArgument(ctx, stmt.argument, ctx.currentReturnType, body);
    } else {
      generateExpression(ctx, stmt.argument, body);
    }
  }
  // We don't strictly need 'return' opcode if it's the last statement,
  // but for now let's not optimize and assume implicit return at end of function
  // or explicit return.
  // If we are in a block, we might need 'return'.
  // Let's use 'return' opcode for explicit return statements.
  body.push(Opcode.return);
}

function resolveType(
  ctx: CodegenContext,
  type: TypeAnnotation,
): TypeAnnotation {
  if (type.type === NodeType.TypeAnnotation && ctx.typeAliases.has(type.name)) {
    return resolveType(ctx, ctx.typeAliases.get(type.name)!);
  }
  return type;
}
