import {
  NodeType,
  type BlockStatement,
  type BooleanLiteral,
  type ForInStatement,
  type ForStatement,
  type Identifier,
  type IfStatement,
  type LetPatternCondition,
  type Pattern,
  type RecordPattern,
  type ReturnStatement,
  type Statement,
  type TuplePattern,
  type UnboxedTuplePattern,
  type VariableDeclaration,
  type WhileStatement,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {
  TypeKind,
  type ClassType,
  type InterfaceType,
  type SymbolType,
  type Type,
  type TypeAliasType,
  type UnboxedTupleType,
  type UnionType,
} from '../types.js';
import {GcOpcode, Opcode, ValType, HeapType} from '../wasm.js';
import {
  decodeTypeIndex,
  getSymbolMemberName,
  mapCheckerTypeToWasmType,
} from './classes.js';
import type {CodegenContext} from './context.js';
import type {ClassInfo} from './types.js';
import {
  generateExpression,
  inferType,
  generateAdaptedArgument,
  isAdaptable,
  boxPrimitive,
  unboxPrimitive,
  resolveFixedArrayClass,
  ensureClassInstantiated,
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
    case NodeType.BreakStatement:
      generateBreakStatement(ctx, body);
      break;
    case NodeType.ContinueStatement:
      generateContinueStatement(ctx, body);
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
    case NodeType.ForInStatement:
      generateForInStatement(ctx, stmt as ForInStatement, body);
      break;
  }
}

export function generateIfStatement(
  ctx: CodegenContext,
  stmt: IfStatement,
  body: number[],
) {
  if (stmt.test.type === NodeType.LetPatternCondition) {
    generateIfLetStatement(
      ctx,
      stmt.test,
      stmt.consequent,
      stmt.alternate,
      body,
    );
    return;
  }

  generateExpression(ctx, stmt.test, body);
  body.push(Opcode.if);
  body.push(ValType.void);
  ctx.enterBlockStructure();
  generateFunctionStatement(ctx, stmt.consequent, body);
  if (stmt.alternate) {
    body.push(Opcode.else);
    generateFunctionStatement(ctx, stmt.alternate, body);
  }
  ctx.exitBlockStructure();
  body.push(Opcode.end);
}

export function generateBreakStatement(ctx: CodegenContext, body: number[]) {
  const depth = ctx.getBreakDepth();
  if (depth === undefined) {
    throw new Error('Break statement outside of loop');
  }
  body.push(Opcode.br);
  body.push(...WasmModule.encodeSignedLEB128(depth));
}

export function generateContinueStatement(ctx: CodegenContext, body: number[]) {
  const depth = ctx.getContinueDepth();
  if (depth === undefined) {
    throw new Error('Continue statement outside of loop');
  }
  body.push(Opcode.br);
  body.push(...WasmModule.encodeSignedLEB128(depth));
}

export function generateWhileStatement(
  ctx: CodegenContext,
  stmt: WhileStatement,
  body: number[],
) {
  if (stmt.test.type === NodeType.LetPatternCondition) {
    generateWhileLetStatement(ctx, stmt.test, stmt.body, body);
    return;
  }

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

  ctx.enterLoop();
  generateFunctionStatement(ctx, stmt.body, body);
  ctx.exitLoop();

  body.push(Opcode.br);
  body.push(...WasmModule.encodeSignedLEB128(0)); // Continue to loop (depth 0)

  body.push(Opcode.end); // End loop
  body.push(Opcode.end); // End block
}

/**
 * Generate code for `if (let pattern = expr) { consequent } else { alternate }`
 *
 * For unboxed tuple patterns like `if (let (true, value) = getResult())`:
 * 1. Evaluate the expression (pushes values onto stack)
 * 2. Store values in temp locals
 * 3. Check if pattern matches (e.g., first value == true)
 * 4. If matches: bind remaining values and execute consequent
 * 5. If doesn't match: execute alternate
 */
function generateIfLetStatement(
  ctx: CodegenContext,
  letPattern: LetPatternCondition,
  consequent: Statement,
  alternate: Statement | undefined,
  body: number[],
) {
  const initType = letPattern.init.inferredType;
  const pattern = letPattern.pattern;

  // For now, only support unboxed tuple patterns
  if (pattern.type !== NodeType.UnboxedTuplePattern) {
    throw new Error(
      `if (let ...) only supports unboxed tuple patterns, got ${pattern.type}`,
    );
  }

  const tuplePattern = pattern as UnboxedTuplePattern;
  const elementTypes = getUnboxedTupleElementTypes(initType);

  if (elementTypes === null) {
    throw new Error(
      `if (let ...) expected unboxed tuple type, got ${initType?.kind}`,
    );
  }

  // Generate expression - pushes values onto stack
  generateExpression(ctx, letPattern.init, body);

  // Store all values in temp locals (in reverse order since stack is LIFO)
  const tempLocals: number[] = [];
  for (let i = tuplePattern.elements.length - 1; i >= 0; i--) {
    const elemType = elementTypes[i];
    const wasmType = mapCheckerTypeToWasmType(ctx, elemType);
    const tempLocal = ctx.declareLocal(`$$let_temp_${i}`, wasmType);
    tempLocals.unshift(tempLocal); // prepend to maintain order
    body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(tempLocal));
  }

  // Generate pattern check condition
  generateLetPatternCheck(ctx, tuplePattern, tempLocals, elementTypes, body);

  // if (pattern matches)
  body.push(Opcode.if);
  body.push(ValType.void);
  ctx.enterBlockStructure();

  // Bind pattern variables and execute consequent
  ctx.pushScope();
  generateLetPatternBindings(ctx, tuplePattern, tempLocals, elementTypes, body);
  generateFunctionStatement(ctx, consequent, body);
  ctx.popScope();

  if (alternate) {
    body.push(Opcode.else);
    generateFunctionStatement(ctx, alternate, body);
  }

  ctx.exitBlockStructure();
  body.push(Opcode.end);
}

/**
 * Generate code for `while (let pattern = expr) { body }`
 *
 * Similar to if-let but with loop structure:
 *   block $break
 *     loop $continue
 *       eval expr -> store in temps
 *       check pattern
 *       br_if 1 (to break) if not matched
 *       bind variables
 *       body
 *       br 0 (continue)
 *     end
 *   end
 */
function generateWhileLetStatement(
  ctx: CodegenContext,
  letPattern: LetPatternCondition,
  loopBody: Statement,
  body: number[],
) {
  const initType = letPattern.init.inferredType;
  const pattern = letPattern.pattern;

  if (pattern.type !== NodeType.UnboxedTuplePattern) {
    throw new Error(
      `while (let ...) only supports unboxed tuple patterns, got ${pattern.type}`,
    );
  }

  const tuplePattern = pattern as UnboxedTuplePattern;
  const elementTypes = getUnboxedTupleElementTypes(initType);

  if (elementTypes === null) {
    throw new Error(
      `while (let ...) expected unboxed tuple type, got ${initType?.kind}`,
    );
  }

  // Pre-declare temp locals outside the loop (they're reused each iteration)
  const tempLocals: number[] = [];
  for (let i = 0; i < tuplePattern.elements.length; i++) {
    const elemType = elementTypes[i];
    const wasmType = mapCheckerTypeToWasmType(ctx, elemType);
    const tempLocal = ctx.declareLocal(`$$while_let_temp_${i}`, wasmType);
    tempLocals.push(tempLocal);
  }

  // block $break
  body.push(Opcode.block);
  body.push(ValType.void);

  // loop $continue
  body.push(Opcode.loop);
  body.push(ValType.void);

  // Evaluate expression - pushes values onto stack
  generateExpression(ctx, letPattern.init, body);

  // Store all values in temp locals (in reverse order since stack is LIFO)
  for (let i = tuplePattern.elements.length - 1; i >= 0; i--) {
    body.push(
      Opcode.local_set,
      ...WasmModule.encodeSignedLEB128(tempLocals[i]),
    );
  }

  // Check pattern
  generateLetPatternCheck(ctx, tuplePattern, tempLocals, elementTypes, body);

  // If not matched (condition is false), break out
  body.push(Opcode.i32_eqz);
  body.push(Opcode.br_if);
  body.push(...WasmModule.encodeSignedLEB128(1)); // break to outer block (depth 1)

  // Pattern matched - bind variables and execute body
  ctx.enterLoop();
  ctx.pushScope();
  generateLetPatternBindings(ctx, tuplePattern, tempLocals, elementTypes, body);
  generateFunctionStatement(ctx, loopBody, body);
  ctx.popScope();
  ctx.exitLoop();

  // Continue to next iteration
  body.push(Opcode.br);
  body.push(...WasmModule.encodeSignedLEB128(0)); // continue to loop (depth 0)

  body.push(Opcode.end); // end loop
  body.push(Opcode.end); // end block
}

/**
 * Generate code for `for (let pattern in iterable) body`
 *
 * Desugars to:
 *   let $$iter = iterable.:Iterable.iterator();
 *   while (let (true, elem) = $$iter.next()) {
 *     let pattern = elem;
 *     body
 *   }
 *
 * For simplicity, we currently only support identifier patterns.
 * The iterator type must be an interface (Iterator<T>).
 */
function generateForInStatement(
  ctx: CodegenContext,
  stmt: ForInStatement,
  body: number[],
) {
  const iterableType = stmt.iterable.inferredType;
  const iteratorType = stmt.iteratorType as InterfaceType | undefined;
  const elementType = stmt.elementType;
  const iteratorSymbol = stmt.iteratorSymbol;

  if (!iterableType || !iteratorType || !elementType || !iteratorSymbol) {
    throw new Error('for-in statement missing type information from checker');
  }

  // For now, only support identifier patterns
  if (stmt.pattern.type !== NodeType.Identifier) {
    throw new Error(
      `for-in currently only supports identifier patterns, got ${stmt.pattern.type}`,
    );
  }

  const varName = (stmt.pattern as Identifier).name;

  // 1. Generate iterable expression and call .:Iterable.iterator()
  generateExpression(ctx, stmt.iterable, body);
  generateIteratorMethodCall(ctx, iterableType, iteratorSymbol, body);

  // 2. Store iterator in temp local
  const iteratorWasmType = getInterfaceWasmType(ctx, iteratorType);
  const iterLocal = ctx.declareLocal('$$for_in_iter', iteratorWasmType);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(iterLocal));

  // 3. Pre-declare temp locals for next() return values
  // next() returns (true, T) | (false, never), which is (i32, T) in WASM
  const boolTemp = ctx.declareLocal('$$for_in_hasMore', [ValType.i32]);
  const elemWasmType = mapCheckerTypeToWasmType(ctx, elementType);
  const elemTemp = ctx.declareLocal('$$for_in_elem', elemWasmType);

  // 4. Generate loop structure
  // block $break
  body.push(Opcode.block);
  body.push(ValType.void);

  // loop $continue
  body.push(Opcode.loop);
  body.push(ValType.void);

  // Call iter.next() - pushes (i32, T) onto stack
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(iterLocal));
  generateIteratorNextCall(ctx, iteratorType, elemWasmType, body);

  // Store values in temp locals (reverse order - elem first, then bool)
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(elemTemp));
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(boolTemp));

  // Check if hasMore is false, break if so
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(boolTemp));
  body.push(Opcode.i32_eqz);
  body.push(Opcode.br_if);
  body.push(...WasmModule.encodeSignedLEB128(1)); // break to outer block

  // Bind pattern variable
  ctx.enterLoop();
  ctx.pushScope();

  // Declare and initialize the loop variable
  const varLocal = ctx.declareLocal(varName, elemWasmType);
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(elemTemp));
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(varLocal));

  // Generate loop body
  generateFunctionStatement(ctx, stmt.body, body);

  ctx.popScope();
  ctx.exitLoop();

  // Continue to next iteration
  body.push(Opcode.br);
  body.push(...WasmModule.encodeSignedLEB128(0)); // continue to loop

  body.push(Opcode.end); // end loop
  body.push(Opcode.end); // end block
}

/**
 * Generate code to call .:Iterable.iterator() on an iterable.
 * Expects the iterable object to already be on the stack.
 * Pushes the Iterator interface (fat pointer) onto the stack.
 *
 * Uses the same static vs dynamic dispatch logic as regular method calls:
 * - Static dispatch for final classes, final methods, or extension classes
 * - Dynamic dispatch (vtable) otherwise
 */
function generateIteratorMethodCall(
  ctx: CodegenContext,
  iterableType: Type,
  iteratorSymbol: SymbolType,
  body: number[],
) {
  let classInfo: ClassInfo | undefined;

  // Handle class types directly
  if (iterableType.kind === TypeKind.Class) {
    const classType = iterableType as ClassType;
    // Try direct lookup first, then ensure instantiated if not found
    classInfo = ctx.getClassInfo(classType);
    if (!classInfo) {
      classInfo = ensureClassInstantiated(ctx, classType);
    }
    if (!classInfo) {
      throw new Error(`Class info not found for ${classType.name}`);
    }
  }
  // Handle array types via FixedArray extension class
  else if (iterableType.kind === TypeKind.Array) {
    classInfo = resolveFixedArrayClass(ctx, iterableType);
    if (!classInfo) {
      throw new Error(
        `Failed to resolve FixedArray extension class for array type`,
      );
    }
  }
  // Handle interface types (e.g., Sequence<T>, Iterable<T>)
  else if (iterableType.kind === TypeKind.Interface) {
    const interfaceType = iterableType as InterfaceType;
    generateInterfaceIteratorCall(ctx, interfaceType, iteratorSymbol, body);
    return;
  }
  // Unsupported type
  else {
    throw new Error(
      `for-in iterable must be a class, interface, or array type, got ${iterableType.kind}`,
    );
  }

  // Look up the symbol-keyed 'iterator' method
  const methodName = getSymbolMemberName(iteratorSymbol);
  const methodInfo = classInfo.methods.get(methodName);
  if (!methodInfo) {
    throw new Error(`Method '${methodName}' not found in ${classInfo.name}`);
  }

  // Determine static vs dynamic dispatch (same logic as regular method calls)
  const useStaticDispatch =
    classInfo.isFinal || methodInfo.isFinal || classInfo.isExtension;

  if (useStaticDispatch) {
    // Static dispatch - direct call
    body.push(Opcode.call, ...WasmModule.encodeSignedLEB128(methodInfo.index));
  } else {
    // Dynamic dispatch via vtable
    if (!classInfo.vtable || classInfo.vtableTypeIndex === undefined) {
      throw new Error(`VTable not found for ${classInfo.name}`);
    }

    // Stack has object. Store in temp for vtable access.
    const objectWasmType = [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
    ];
    const tempThis = ctx.declareLocal('$$iter_this', objectWasmType);
    body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempThis));

    // Load VTable (field 0)
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(0));

    // Cast vtable to correct type
    body.push(0xfb, GcOpcode.ref_cast_null);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.vtableTypeIndex));

    // Get function from vtable
    const vtableIndex = classInfo.vtable.indexOf(methodName);
    if (vtableIndex < 0) {
      throw new Error(
        `Method '${methodName}' not found in vtable for ${classInfo.name}`,
      );
    }
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.vtableTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(vtableIndex));

    // Cast to function type
    body.push(0xfb, GcOpcode.ref_cast_null);
    body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

    // Store function ref
    const funcRefType = [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
    ];
    const funcRefLocal = ctx.declareLocal('$$iter_method', funcRefType);
    body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(funcRefLocal));

    // Load 'this' and function ref, then call
    body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempThis));
    body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRefLocal));
    body.push(
      Opcode.call_ref,
      ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
    );
  }
}

/**
 * Generate code to call .:Iterable.iterator() on an interface type.
 * Expects the interface fat pointer on the stack.
 * Pushes the Iterator interface (fat pointer) onto the stack.
 */
function generateInterfaceIteratorCall(
  ctx: CodegenContext,
  interfaceType: InterfaceType,
  iteratorSymbol: SymbolType,
  body: number[],
) {
  // Find the Iterable interface in the type hierarchy
  const iterableInterface = findIterableInInterfaceChain(interfaceType);
  if (!iterableInterface) {
    throw new Error(
      `Interface ${interfaceType.name} does not extend Iterable`,
    );
  }

  // Get interface info - may need to use the original interface type, not Iterable
  const interfaceInfo = ctx.getInterfaceInfo(interfaceType);
  if (!interfaceInfo) {
    throw new Error(`Interface info not found for ${interfaceType.name}`);
  }

  // Look up the symbol method by name
  const methodName = getSymbolMemberName(iteratorSymbol);
  const methodInfo = interfaceInfo.methods.get(methodName);
  if (!methodInfo) {
    throw new Error(
      `Method '${methodName}' not found in interface ${interfaceType.name}`,
    );
  }

  // Store fat pointer in temp
  const fatPtrType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
  ];
  const tempLocal = ctx.declareLocal('$$iterable_temp', fatPtrType);
  body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempLocal));

  // Get vtable from fat pointer (field 1)
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(1)); // vtable field

  // Cast vtable
  body.push(0xfb, GcOpcode.ref_cast_null);
  body.push(...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex));

  // Get function from vtable
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));

  // Cast function to specific type
  body.push(0xfb, GcOpcode.ref_cast_null);
  body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

  // Store function ref
  const funcRefType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  ];
  const funcRefLocal = ctx.declareLocal('$$iterable_func', funcRefType);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(funcRefLocal));

  // Load instance (this) from fat pointer (field 0)
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempLocal));
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(0)); // instance field

  // Load function ref and call
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRefLocal));
  body.push(
    Opcode.call_ref,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  );
}

/**
 * Walk the interface extends chain to find Iterable.
 */
function findIterableInInterfaceChain(
  interfaceType: InterfaceType,
): InterfaceType | undefined {
  const name = interfaceType.genericSource?.name ?? interfaceType.name;
  if (name === 'Iterable') {
    return interfaceType;
  }

  if (interfaceType.extends) {
    for (const ext of interfaceType.extends) {
      const found = findIterableInInterfaceChain(ext);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * Generate code to call .next() on an Iterator interface.
 * Expects the iterator (fat pointer) to already be on the stack.
 * Pushes (i32, T) onto the stack (the unboxed tuple return).
 *
 * TODO: This duplicates interface dispatch logic from generateCallExpression.
 * Consider extracting a shared helper for interface method dispatch so that
 * optimizations (like static dispatch when concrete type is known) apply
 * consistently across all interface calls.
 */
function generateIteratorNextCall(
  ctx: CodegenContext,
  iteratorType: InterfaceType,
  elemWasmType: number[],
  body: number[],
) {
  // Get the interface info for Iterator<T>
  const interfaceInfo = ctx.getInterfaceInfo(iteratorType);
  if (!interfaceInfo) {
    throw new Error(`Interface info not found for ${iteratorType.name}`);
  }

  // Look up the 'next' method
  const methodInfo = interfaceInfo.methods.get('next');
  if (!methodInfo) {
    throw new Error(`Method 'next' not found in ${iteratorType.name}`);
  }

  // Store interface fat pointer in temp
  const fatPtrType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
  ];
  const tempLocal = ctx.declareLocal('$$iter_temp', fatPtrType);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(tempLocal));

  // Get vtable from fat pointer (field 1)
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempLocal));
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(1)); // vtable field

  // Cast vtable
  body.push(0xfb, GcOpcode.ref_cast_null);
  body.push(...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex));

  // Get function from vtable (methodInfo.index is the vtable index)
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));

  // Cast function to specific type
  body.push(0xfb, GcOpcode.ref_cast_null);
  body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

  // Store function ref in temp
  const funcRefType = [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  ];
  const funcRefLocal = ctx.declareLocal('$$iter_func', funcRefType);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(funcRefLocal));

  // Load instance (this) from fat pointer (field 0)
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempLocal));
  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(0)); // instance field

  // Load function ref and call
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRefLocal));
  body.push(
    Opcode.call_ref,
    ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
  );

  // The call returns (i32, anyref) since interface methods box return values.
  // We need to unbox the second value to the concrete element type.
  // First store the anyref, then unbox it.
  const anyrefTemp = ctx.declareLocal('$$iter_anyref', [ValType.anyref]);
  body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(anyrefTemp));
  // Now stack has just i32 (hasMore)
  // We need to return (i32, T) so push i32, then unboxed T

  // Unbox the element if needed
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(anyrefTemp));

  // Check if we need to unbox (primitive types need unboxing)
  if (
    elemWasmType.length === 1 &&
    (elemWasmType[0] === ValType.i32 ||
      elemWasmType[0] === ValType.i64 ||
      elemWasmType[0] === ValType.f32 ||
      elemWasmType[0] === ValType.f64)
  ) {
    unboxPrimitive(ctx, elemWasmType, body);
  } else if (
    elemWasmType[0] === ValType.ref_null ||
    elemWasmType[0] === ValType.ref
  ) {
    // Reference type - cast from anyref to the concrete type
    // elemWasmType is [ref_null/ref, typeIndex...]
    const typeIndex = decodeTypeIndex(elemWasmType);
    body.push(0xfb, GcOpcode.ref_cast_null);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
  }
  // else: already anyref, nothing to do
}

/**
 * Get the WASM type for an interface (fat pointer struct reference).
 */
function getInterfaceWasmType(
  ctx: CodegenContext,
  interfaceType: InterfaceType,
): number[] {
  const interfaceInfo = ctx.getInterfaceInfo(interfaceType);
  if (!interfaceInfo) {
    throw new Error(`Interface info not found for ${interfaceType.name}`);
  }
  return [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
  ];
}

/**
 * Generate code to check if an unboxed tuple pattern matches.
 * Pushes i32 (1 = match, 0 = no match) onto the stack.
 *
 * For pattern `(true, value)`:
 * - Check if first element equals `true`
 * - Identifier patterns always match (wildcard)
 */
function generateLetPatternCheck(
  ctx: CodegenContext,
  pattern: UnboxedTuplePattern,
  tempLocals: number[],
  elementTypes: Type[],
  body: number[],
) {
  // Start with true (1), AND with each element check
  body.push(Opcode.i32_const, 1);

  for (let i = 0; i < pattern.elements.length; i++) {
    const elemPattern = pattern.elements[i];

    // Identifier patterns (including wildcards) always match
    if (elemPattern.type === NodeType.Identifier) {
      continue;
    }

    // Boolean literal pattern
    if (elemPattern.type === NodeType.BooleanLiteral) {
      const boolLit = elemPattern as BooleanLiteral;
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(tempLocals[i]),
      );
      body.push(Opcode.i32_const, boolLit.value ? 1 : 0);
      body.push(Opcode.i32_eq);
      body.push(Opcode.i32_and);
      continue;
    }

    // TODO: Support other pattern types (number literals, nested patterns, etc.)
    throw new Error(
      `Unsupported pattern type in let-pattern condition: ${elemPattern.type}`,
    );
  }
}

/**
 * Generate code to bind variables from an unboxed tuple pattern.
 * Called after pattern check succeeds - copies temp locals to named locals.
 */
function generateLetPatternBindings(
  ctx: CodegenContext,
  pattern: UnboxedTuplePattern,
  tempLocals: number[],
  elementTypes: Type[],
  body: number[],
) {
  for (let i = 0; i < pattern.elements.length; i++) {
    const elemPattern = pattern.elements[i];

    if (elemPattern.type === NodeType.Identifier) {
      const id = elemPattern as Identifier;
      // Skip wildcards
      if (id.name === '_') continue;

      const wasmType = mapCheckerTypeToWasmType(ctx, elementTypes[i]);
      const localIndex = ctx.declareLocal(id.name, wasmType, elemPattern);

      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(tempLocals[i]),
      );
      body.push(Opcode.local_set, ...WasmModule.encodeSignedLEB128(localIndex));
      continue;
    }

    // Literal patterns don't bind variables
    if (
      elemPattern.type === NodeType.BooleanLiteral ||
      elemPattern.type === NodeType.NumberLiteral ||
      elemPattern.type === NodeType.StringLiteral
    ) {
      continue;
    }

    // TODO: Nested patterns
    throw new Error(`Unsupported binding pattern type: ${elemPattern.type}`);
  }
}

export function generateForStatement(
  ctx: CodegenContext,
  stmt: ForStatement,
  body: number[],
) {
  // For loop: for (init; test; update) body
  //
  // For loops need special handling for continue - continue should skip
  // to the update, not back to the test. We use a nested block structure:
  //
  // WASM structure:
  //   init
  //   block $break
  //     loop $loop_start
  //       test
  //       i32.eqz
  //       br_if $break
  //       block $continue_target   ; continue jumps here (exits to update)
  //         body
  //       end
  //       update
  //       br $loop_start
  //     end
  //   end
  //
  // From inside body:
  //   - break: br 2 (exits $break)
  //   - continue: br 0 (exits $continue_target, falls through to update)

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

  body.push(Opcode.block); // $break
  body.push(ValType.void);
  body.push(Opcode.loop); // $loop_start
  body.push(ValType.void);

  // Generate test
  if (stmt.test) {
    generateExpression(ctx, stmt.test, body);
    body.push(Opcode.i32_eqz); // Invert condition
    body.push(Opcode.br_if);
    body.push(...WasmModule.encodeSignedLEB128(1)); // Break to $break (depth 1)
  }

  body.push(Opcode.block); // $continue_target
  body.push(ValType.void);

  // Generate body with for-loop specific depths:
  // From inside body: break=2 (to $break), continue=0 (to $continue_target)
  ctx.enterForLoop();
  generateFunctionStatement(ctx, stmt.body, body);
  ctx.exitLoop();

  body.push(Opcode.end); // End $continue_target

  // Generate update
  if (stmt.update) {
    generateExpression(ctx, stmt.update, body);
    const updateType = inferType(ctx, stmt.update);
    if (updateType.length > 0) {
      body.push(Opcode.drop);
    }
  }

  body.push(Opcode.br);
  body.push(...WasmModule.encodeSignedLEB128(0)); // Jump to $loop_start (depth 0)

  body.push(Opcode.end); // End $loop_start
  body.push(Opcode.end); // End $break

  ctx.popScope();
}

export function generateLocalVariableDeclaration(
  ctx: CodegenContext,
  decl: VariableDeclaration,
  body: number[],
) {
  // Special handling for unboxed tuple patterns: let (a, b) = expr
  // The expr returns multiple values on the stack, we pop them in reverse order
  if (decl.pattern.type === NodeType.UnboxedTuplePattern) {
    generateUnboxedTuplePatternBinding(ctx, decl, body);
    return;
  }

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
      // Pass the semantic type from the initializer expression to preserve
      // type identity (e.g., boolean vs i32) for proper Box<T> selection
      boxPrimitive(ctx, exprType, body, decl.init.inferredType);
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

/**
 * Generate binding for unboxed tuple pattern: let (a, b) = expr
 *
 * Unlike boxed tuples where values are in a struct, unboxed tuples
 * have their values directly on the WASM stack. We need to:
 * 1. Generate the expression (pushes N values onto stack)
 * 2. Pop values in REVERSE order to locals (WASM stack is LIFO)
 *
 * Supports unions of unboxed tuples (e.g., (true, T) | (false, never)):
 * At runtime, the union is erased - we just have the WASM values on the stack.
 */
function generateUnboxedTuplePatternBinding(
  ctx: CodegenContext,
  decl: VariableDeclaration,
  body: number[],
) {
  const pattern = decl.pattern as UnboxedTuplePattern;
  const initType = decl.init.inferredType;

  // Extract element types from unboxed tuple or union of unboxed tuples
  const elementTypes = getUnboxedTupleElementTypes(initType);

  if (elementTypes === null) {
    throw new Error(
      `Expected UnboxedTupleType for unboxed tuple pattern, got ${initType?.kind}`,
    );
  }

  if (pattern.elements.length !== elementTypes.length) {
    throw new Error(
      `Unboxed tuple pattern has ${pattern.elements.length} elements but type has ${elementTypes.length}`,
    );
  }

  // 1. Generate the expression - this pushes all values onto the stack
  generateExpression(ctx, decl.init, body);

  // 2. Pop values in REVERSE order (WASM stack is LIFO)
  // For `let (a, b) = expr`, expr pushes [a_value, b_value] onto stack
  // Stack state: ... a_value b_value (top)
  // We need to pop b first, then a
  for (let i = pattern.elements.length - 1; i >= 0; i--) {
    const elemPattern = pattern.elements[i];
    const elemType = elementTypes[i];
    const wasmType = mapCheckerTypeToWasmType(ctx, elemType);

    if (elemPattern.type === NodeType.Identifier) {
      const index = ctx.declareLocal(elemPattern.name, wasmType, elemPattern);
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeSignedLEB128(index));
    } else {
      // For nested patterns, store in temp and recurse
      const tempIndex = ctx.declareLocal('$$temp_unboxed', wasmType);
      body.push(Opcode.local_set);
      body.push(...WasmModule.encodeSignedLEB128(tempIndex));
      // TODO: Generate nested pattern binding from temp local
      throw new Error('Nested patterns in unboxed tuple not yet supported');
    }
  }
}

/**
 * Extract element types from an unboxed tuple type or union of unboxed tuples.
 * For unions, uses the first variant's element types (they must all have the same
 * WASM representation, just different static types).
 * Returns null if the type is not an unboxed tuple or union of unboxed tuples.
 */
function getUnboxedTupleElementTypes(type: Type | undefined): Type[] | null {
  if (!type) return null;

  if (type.kind === TypeKind.UnboxedTuple) {
    return (type as UnboxedTupleType).elementTypes;
  }

  if (type.kind === TypeKind.Union) {
    const unionType = type as UnionType;
    // Find the first unboxed tuple in the union
    for (const t of unionType.types) {
      if (t.kind === TypeKind.UnboxedTuple) {
        return (t as UnboxedTupleType).elementTypes;
      }
    }
  }

  return null;
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

  // Check if this is a fat pointer type (record dispatch type)
  const recordInfo = ctx.getRecordInfoForFatPtrType(typeIndex);
  if (recordInfo) {
    // Fat pointer record - use vtable dispatch for field access
    for (const prop of pattern.properties) {
      const fieldName = prop.name.name;
      const fieldInfo = recordInfo.fields.get(fieldName);
      if (!fieldInfo) {
        throw new Error(
          `Field ${fieldName} not found in record type ${recordInfo.key}`,
        );
      }

      // Get instance (field 0 of fat pointer)
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempIndex));
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(typeIndex));
      body.push(0); // instance field

      // Get vtable (field 1 of fat pointer)
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempIndex));
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(typeIndex));
      body.push(1); // vtable field

      // Get getter function from vtable
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(recordInfo.vtableTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

      // Call the getter function
      body.push(Opcode.call_ref);
      body.push(...WasmModule.encodeSignedLEB128(fieldInfo.typeIndex));

      // Recurse for nested patterns
      generatePatternBinding(ctx, prop.value, fieldInfo.type, body);
    }
    return;
  }

  // Legacy: Find field indices from concrete struct types
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
    // For unboxed tuple returns, just generate the expression directly
    // (it pushes multiple values onto the stack)
    if (stmt.argument.type === NodeType.UnboxedTupleLiteral) {
      generateExpression(ctx, stmt.argument, body);
    } else if (ctx.currentReturnType) {
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
