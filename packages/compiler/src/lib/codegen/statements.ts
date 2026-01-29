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
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {
  TypeKind,
  type ClassType,
  type InterfaceType,
  type TypeAliasType,
  type UnionType,
} from '../types.js';
import {GcOpcode, Opcode, ValType, HeapType} from '../wasm.js';
import {decodeTypeIndex, mapCheckerTypeToWasmType} from './classes.js';
import type {CodegenContext} from './context.js';
import type {ClassInfo} from './types.js';
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

  // Resolve the declared type via the checker's inferredType
  // This handles type aliases correctly by using TypeAliasType.target
  let declaredType = decl.typeAnnotation?.inferredType;
  if (declaredType?.kind === TypeKind.TypeAlias) {
    declaredType = (declaredType as TypeAliasType).target;
  }

  // Check for Union Adaptation
  if (declaredType?.kind === TypeKind.Union) {
    const unionType = declaredType as UnionType;
    // Infer actual type of initializer
    let actualType: number[] = [];
    try {
      actualType = inferType(ctx, decl.init);
    } catch (e) {
      // Ignore inference errors
    }

    if (actualType.length > 0) {
      // Try to find a member type that requires adaptation
      for (const member of unionType.types) {
        const memberWasmType = mapCheckerTypeToWasmType(ctx, member);
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
    if (resolvedType && ctx.currentTypeArguments.size > 0) {
      resolvedType = ctx.checkerContext.substituteTypeParams(
        resolvedType,
        ctx.currentTypeArguments,
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
    if (resolvedType?.kind === TypeKind.Interface) {
      const targetInterfaceType = resolvedType as InterfaceType;
      const interfaceInfo = ctx.getInterfaceInfo(targetInterfaceType);

      if (interfaceInfo) {
        let classInfo: ClassInfo | undefined;

        if (decl.init.inferredType) {
          let checkerType = decl.init.inferredType;
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

        if (classInfo?.implements !== undefined) {
          // Identity-based lookup using the checker's InterfaceType
          let implInfo = classInfo.implements.get(targetInterfaceType);

          // If not found, try to find by interface subtype
          if (!implInfo) {
            for (const [implInterface, info] of classInfo.implements) {
              if (
                ctx.checkerContext.isInterfaceAssignableTo(
                  implInterface,
                  targetInterfaceType,
                )
              ) {
                implInfo = info;
                break;
              }
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
          }
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
    // Use struct index lookup since we don't have a checker type in pattern context
    const classInfo = ctx.getClassInfoByStructIndexDirect(typeIndex);
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
