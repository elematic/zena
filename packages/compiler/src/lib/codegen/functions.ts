import {
  NodeType,
  type BlockStatement,
  type DeclareFunction,
  type Expression,
  type FunctionExpression,
  type MethodDefinition,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {
  Decorators,
  TypeKind,
  type FunctionType,
  type Type,
  type UnboxedTupleType,
} from '../types.js';
import {ExportDesc, Opcode, ValType} from '../wasm.js';
import {
  getTypeKeyForSpecialization,
  mapCheckerTypeToWasmType,
} from './classes.js';
import type {CodegenContext} from './context.js';
import {generateExpression} from './expressions.js';
import {generateBlockStatement} from './statements.js';
import type {ClassInfo} from './types.js';

/**
 * Maps a checker type to an array of WASM value types for use in function signatures.
 * For most types, returns a single-element array containing the mapped type.
 * For UnboxedTupleType, returns multiple elements (one per tuple element) to
 * support WASM multi-value returns.
 */
export function mapReturnTypeToWasmResults(
  ctx: CodegenContext,
  type: Type,
): number[][] {
  if (type.kind === TypeKind.Void || type.kind === TypeKind.Never) {
    return [];
  }
  if (type.kind === TypeKind.UnboxedTuple) {
    const tupleType = type as UnboxedTupleType;
    return tupleType.elementTypes.map((el) =>
      mapCheckerTypeToWasmType(ctx, el),
    );
  }
  // For all other types, wrap in an array
  const mapped = mapCheckerTypeToWasmType(ctx, type);
  return mapped.length > 0 ? [mapped] : [];
}
export function registerFunction(
  ctx: CodegenContext,
  name: string,
  func: FunctionExpression,
  exported: boolean,
  exportName?: string,
) {
  if (func.typeParameters && func.typeParameters.length > 0) {
    ctx.genericFunctions.set(name, func);
    return;
  }

  const checkerFuncType = func.inferredType as FunctionType;
  const params = func.params.map((p, i) => {
    const checkerParamType = checkerFuncType.parameters[i];
    return mapCheckerTypeToWasmType(ctx, checkerParamType);
  });

  const results = mapReturnTypeToWasmResults(ctx, checkerFuncType.returnType);
  // Flatten for legacy storage - used by generateFunctionBody
  const flattenedReturn = results.flat();

  const typeIndex = ctx.module.addType(params, results);
  const funcIndex = ctx.module.addFunction(typeIndex);

  if (exported) {
    ctx.module.addExport(exportName || name, ExportDesc.Func, funcIndex);
  }

  // Register with qualified name for multi-module support
  const qualifiedName = ctx.qualifyName(name);
  ctx.functions.set(qualifiedName, funcIndex);
  // Also register unqualified for backward compatibility with single-module tests
  ctx.functions.set(name, funcIndex);
  ctx.functionReturnTypes.set(name, flattenedReturn);

  // Register by declaration for identity-based lookup (new name resolution)
  ctx.registerFunctionByDecl(func, funcIndex);

  // Capture current module for body generation
  const capturedModule = ctx.currentModule;
  ctx.bodyGenerators.push(() => {
    // Restore the module context for import resolution during body generation
    const savedModule = ctx.currentModule;
    ctx.currentModule = capturedModule;
    const body = generateFunctionBody(
      ctx,
      name,
      func,
      undefined,
      flattenedReturn,
    );
    ctx.module.addCode(funcIndex, ctx.extraLocals, body);
    ctx.currentModule = savedModule;
  });
}

export function generateFunctionBody(
  ctx: CodegenContext,
  name: string,
  func: FunctionExpression,
  typeArguments?: Map<string, Type>,
  returnType?: number[],
): number[] {
  const oldReturnType = ctx.currentReturnType;
  ctx.currentReturnType = returnType;

  ctx.pushFunctionScope();

  // Push type param context for checker-based resolution
  if (typeArguments && typeArguments.size > 0) {
    ctx.pushTypeArgumentsContext(typeArguments);
  }

  func.params.forEach((p) => {
    // Use param.inferredType (from checker) which works for both explicit and contextual typing
    let paramType = p.inferredType ?? p.typeAnnotation?.inferredType;
    if (!paramType) {
      throw new Error(`Parameter ${p.name.name} missing inferredType`);
    }
    if (typeArguments && ctx.checkerContext) {
      paramType = ctx.checkerContext.substituteTypeParams(
        paramType,
        typeArguments,
      );
    }
    ctx.defineParam(p.name.name, mapCheckerTypeToWasmType(ctx, paramType), p);
  });

  const body: number[] = [];
  if (func.body.type === NodeType.BlockStatement) {
    generateBlockStatement(ctx, func.body as BlockStatement, body);
    if (returnType && returnType.length > 0) {
      body.push(Opcode.unreachable);
    }
  } else {
    generateExpression(ctx, func.body as Expression, body);
  }

  body.push(Opcode.end);

  // Pop type param context if we pushed one
  if (typeArguments && typeArguments.size > 0) {
    ctx.popTypeParamContext();
  }

  ctx.currentReturnType = oldReturnType;
  return body;
}

export function instantiateGenericFunction(
  ctx: CodegenContext,
  name: string,
  typeArgs: Type[],
): number {
  const funcDecl = ctx.genericFunctions.get(name);
  if (!funcDecl) throw new Error(`Generic function ${name} not found`);

  // Use checker-based type key for specialization
  const key = `${name}<${typeArgs
    .map((t) => getTypeKeyForSpecialization(t, ctx))
    .join(',')}>`;

  // Check if already instantiated
  if (ctx.functions.has(key)) {
    return ctx.functions.get(key)!;
  }

  // Build type map directly from Type[] (checker-based)
  const typeMap = new Map<string, Type>();
  if (funcDecl.typeParameters) {
    if (funcDecl.typeParameters.length !== typeArgs.length) {
      throw new Error(
        `Expected ${funcDecl.typeParameters.length} type arguments, got ${typeArgs.length}`,
      );
    }
    for (let i = 0; i < funcDecl.typeParameters.length; i++) {
      typeMap.set(funcDecl.typeParameters[i].name, typeArgs[i]);
    }
  }

  const params = funcDecl.params.map((p) => {
    let paramType = p.inferredType ?? p.typeAnnotation?.inferredType;
    if (!paramType) {
      throw new Error(`Parameter ${p.name.name} missing inferredType`);
    }
    if (ctx.checkerContext) {
      paramType = ctx.checkerContext.substituteTypeParams(paramType, typeMap);
    }
    return mapCheckerTypeToWasmType(ctx, paramType);
  });
  const substitutedReturnType = funcDecl.returnType
    ? (() => {
        let returnType = funcDecl.returnType!.inferredType!;
        if (ctx.checkerContext) {
          returnType = ctx.checkerContext.substituteTypeParams(
            returnType,
            typeMap,
          );
        }
        return returnType;
      })()
    : (() => {
        throw new Error(
          `Generic function ${name} missing return type annotation`,
        );
      })();
  const results = mapReturnTypeToWasmResults(ctx, substitutedReturnType);
  const flattenedReturn = results.flat();

  const typeIndex = ctx.module.addType(params, results);
  const funcIndex = ctx.module.addFunction(typeIndex);

  ctx.functions.set(key, funcIndex);

  ctx.bodyGenerators.push(() => {
    const body = generateFunctionBody(
      ctx,
      key,
      funcDecl,
      typeMap,
      flattenedReturn,
    );
    ctx.module.addCode(funcIndex, ctx.extraLocals, body);
  });

  return funcIndex;
}

export function registerDeclaredFunction(
  ctx: CodegenContext,
  decl: DeclareFunction,
  shouldExport: boolean = false,
) {
  // Check if this is an intrinsic (regardless of whether it's generic)
  let intrinsicName: string | undefined;
  if (decl.decorators) {
    const intrinsic = decl.decorators.find(
      (d) => d.name === Decorators.Intrinsic,
    );
    if (intrinsic && intrinsic.args.length === 1) {
      intrinsicName = intrinsic.args[0].value;
    }
  }

  // Generic declared functions (like intrinsics hash<T> and equals<T>)
  // are handled specially - they're instantiated inline at the call site
  if (decl.typeParameters && decl.typeParameters.length > 0) {
    // Register intrinsics so they can be recognized during call generation
    if (intrinsicName) {
      ctx.globalIntrinsics.set(decl.name.name, intrinsicName);
    }
    // Don't create WASM imports for generic functions - they're only used via intrinsics
    return;
  }

  // Try to get function type from checker for identity-based type lookup
  const checkerFuncType = decl.inferredType as FunctionType;
  const params = decl.params.map((p, i) => {
    const checkerParamType = checkerFuncType.parameters[i];
    return mapCheckerTypeToWasmType(ctx, checkerParamType);
  });
  const returnType = mapCheckerTypeToWasmType(ctx, checkerFuncType.returnType);

  let funcIndex = -1;

  if (!intrinsicName) {
    const results = mapReturnTypeToWasmResults(ctx, checkerFuncType.returnType);

    const typeIndex = ctx.module.addType(params, results);

    const moduleName = decl.externalModule || 'env';
    const functionName = decl.externalName || decl.name.name;

    funcIndex = ctx.module.addImport(
      moduleName,
      functionName,
      ExportDesc.Func,
      typeIndex,
    );

    if (shouldExport) {
      const exportName = (decl as any).exportName || decl.name.name;
      ctx.module.addExport(exportName, ExportDesc.Func, funcIndex);
    }
  } else {
    ctx.globalIntrinsics.set(decl.name.name, intrinsicName);
  }

  // Register as primary function if not exists (for backward compat / simple cases)
  if (!ctx.functions.has(decl.name.name)) {
    ctx.functions.set(decl.name.name, funcIndex);
    ctx.functionReturnTypes.set(decl.name.name, returnType);
  }

  // Register by declaration for identity-based lookup (new name resolution)
  // Only register if a function was actually created (not an intrinsic)
  if (funcIndex >= 0) {
    ctx.registerFunctionByDecl(decl, funcIndex);
  }

  // Register in overload list
  if (!ctx.functionOverloads.has(decl.name.name)) {
    ctx.functionOverloads.set(decl.name.name, []);
  }
  ctx.functionOverloads.get(decl.name.name)!.push({
    index: funcIndex,
    params: params,
    intrinsic: intrinsicName,
    type: decl.inferredType as FunctionType,
  });
}

export function instantiateGenericMethod(
  ctx: CodegenContext,
  classInfo: ClassInfo,
  methodName: string,
  typeArgs: Type[],
): {
  index: number;
  returnType: number[];
  typeIndex: number;
  paramTypes: number[][];
  isFinal?: boolean;
  intrinsic?: string;
} {
  const originalClassName = classInfo.originalName || classInfo.name;
  let key = `${originalClassName}.${methodName}`;
  let methodDecl = ctx.genericMethods.get(key);

  if (!methodDecl && classInfo.originalName) {
    key = `${classInfo.name}.${methodName}`;
    methodDecl = ctx.genericMethods.get(key);
  }

  if (!methodDecl) throw new Error(`Generic method ${key} not found`);

  // Use checker-based type key for specialization
  const specializedKey = `${methodName}<${typeArgs
    .map((t) => getTypeKeyForSpecialization(t, ctx))
    .join(',')}>`;

  // Check if already instantiated in the class
  if (classInfo.methods.has(specializedKey)) {
    return classInfo.methods.get(specializedKey)!;
  }

  // Build type map directly from Type[] (checker-based)
  const typeMap = new Map<string, Type>();

  // Add class type parameters from classInfo.typeArguments (checker-based)
  if (classInfo.typeArguments) {
    for (const [name, type] of classInfo.typeArguments) {
      typeMap.set(name, type);
    }
  }

  // Add method type parameters directly from Type[]
  if (methodDecl.typeParameters) {
    if (methodDecl.typeParameters.length !== typeArgs.length) {
      throw new Error(
        `Expected ${methodDecl.typeParameters.length} type arguments, got ${typeArgs.length}`,
      );
    }
    for (let i = 0; i < methodDecl.typeParameters.length; i++) {
      typeMap.set(methodDecl.typeParameters[i].name, typeArgs[i]);
    }
  }

  // Map types
  let thisType: number[];
  if (classInfo.isExtension && classInfo.onType) {
    thisType = classInfo.onType;
  } else {
    thisType = [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
    ];
  }

  const params: number[][] = [];
  if (!methodDecl.isStatic) {
    params.push(thisType);
  }

  for (const param of methodDecl.params) {
    let paramType = param.inferredType ?? param.typeAnnotation?.inferredType;
    if (!paramType) {
      throw new Error(`Parameter ${param.name.name} missing inferredType`);
    }
    if (ctx.checkerContext) {
      paramType = ctx.checkerContext.substituteTypeParams(paramType, typeMap);
    }
    params.push(mapCheckerTypeToWasmType(ctx, paramType));
  }

  let results: number[][] = [];
  if (methodDecl.returnType) {
    let returnType = methodDecl.returnType.inferredType!;
    if (ctx.checkerContext) {
      returnType = ctx.checkerContext.substituteTypeParams(returnType, typeMap);
    }
    results = mapReturnTypeToWasmResults(ctx, returnType);
  }

  const typeIndex = ctx.module.addType(params, results);
  const funcIndex = ctx.module.addFunction(typeIndex);

  const returnType = results.length > 0 ? results[0] : [];

  // Register in class methods so we don't re-instantiate
  const info = {
    index: funcIndex,
    returnType,
    typeIndex,
    paramTypes: params,
    isFinal: methodDecl.isFinal,
  };
  classInfo.methods.set(specializedKey, info);

  ctx.bodyGenerators.push(() => {
    const body = generateMethodBody(
      ctx,
      classInfo,
      methodDecl,
      typeMap,
      returnType,
    );
    ctx.module.addCode(funcIndex, ctx.extraLocals, body);
  });

  return info;
}

function generateMethodBody(
  ctx: CodegenContext,
  classInfo: ClassInfo,
  method: MethodDefinition,
  typeArguments: Map<string, Type>,
  returnType?: number[],
): number[] {
  const oldReturnType = ctx.currentReturnType;

  // Push type param context for checker-based resolution
  // This enables substituteTypeParams to resolve method type parameters
  // (e.g., U in map<U>) in addition to class type parameters
  if (typeArguments.size > 0) {
    ctx.pushTypeArgumentsContext(typeArguments);
  }
  ctx.currentReturnType = returnType;
  ctx.currentClass = classInfo;

  ctx.pushFunctionScope();

  // Params
  if (!method.isStatic) {
    let thisType: number[];
    if (classInfo.isExtension && classInfo.onType) {
      thisType = classInfo.onType;
    } else {
      thisType = [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
      ];
    }
    ctx.defineParam('this', thisType);
  }

  method.params.forEach((p) => {
    let paramType = p.inferredType ?? p.typeAnnotation?.inferredType;
    if (!paramType) {
      throw new Error(`Parameter ${p.name.name} missing inferredType`);
    }
    if (ctx.checkerContext) {
      paramType = ctx.checkerContext.substituteTypeParams(
        paramType,
        typeArguments,
      );
    }
    ctx.defineParam(p.name.name, mapCheckerTypeToWasmType(ctx, paramType), p);
  });

  const body: number[] = [];
  if (method.body && method.body.type === NodeType.BlockStatement) {
    generateBlockStatement(ctx, method.body as BlockStatement, body);
    if (returnType && returnType.length > 0) {
      body.push(Opcode.unreachable);
    }
  } else {
    // Should not happen for methods usually, but if expression body supported
    // generateExpression(ctx, method.body as Expression, body);
  }

  body.push(Opcode.end);

  // Pop type param context if we pushed one
  if (typeArguments.size > 0) {
    ctx.popTypeParamContext();
  }

  ctx.currentReturnType = oldReturnType;
  return body;
}
