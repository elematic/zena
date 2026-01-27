import {
  NodeType,
  type BlockStatement,
  type DeclareFunction,
  type Expression,
  type FunctionExpression,
  type MethodDefinition,
  type Pattern,
  type ReturnStatement,
  type TypeAnnotation,
  type VariableDeclaration,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {Decorators, type FunctionType, type Type} from '../types.js';
import {ExportDesc, Opcode, ValType} from '../wasm.js';
import {
  decodeTypeIndex,
  getClassFromTypeIndex,
  getTypeKey,
  mapCheckerTypeToWasmType,
  mapType,
  resolveAnnotation,
} from './classes.js';
import type {CodegenContext} from './context.js';
import {generateExpression, inferType} from './expressions.js';
import {generateBlockStatement} from './statements.js';
import type {ClassInfo} from './types.js';

export function inferReturnTypeFromBlock(
  ctx: CodegenContext,
  block: BlockStatement,
): number[] {
  for (const stmt of block.body) {
    if (stmt.type === NodeType.VariableDeclaration) {
      const decl = stmt as VariableDeclaration;
      // Prefer checker's inferredType (identity-based) over AST annotation
      const type = decl.inferredType
        ? mapCheckerTypeToWasmType(ctx, decl.inferredType)
        : decl.typeAnnotation
          ? mapType(ctx, decl.typeAnnotation)
          : inferType(ctx, decl.init);

      if (decl.pattern.type === NodeType.Identifier) {
        ctx.defineParam(decl.pattern.name, type);
      } else {
        definePatternLocals(ctx, decl.pattern, type);
      }
    } else if (stmt.type === NodeType.ReturnStatement) {
      const ret = stmt as ReturnStatement;
      if (ret.argument) {
        return inferType(ctx, ret.argument);
      }
      return [];
    }
  }
  return [];
}

function definePatternLocals(
  ctx: CodegenContext,
  pattern: Pattern,
  type: number[],
) {
  if (pattern.type === NodeType.Identifier) {
    ctx.defineParam(pattern.name, type);
    return;
  }

  if (pattern.type === NodeType.AssignmentPattern) {
    definePatternLocals(ctx, pattern.left, type);
    return;
  }

  const typeIndex = decodeTypeIndex(type);

  if (pattern.type === NodeType.RecordPattern) {
    // Find record key
    let recordKey: string | undefined;
    for (const [key, index] of ctx.recordTypes) {
      if (index === typeIndex) {
        recordKey = key;
        break;
      }
    }

    if (!recordKey) {
      // Class?
      const classInfo = getClassFromTypeIndex(ctx, typeIndex);
      if (classInfo) {
        for (const prop of pattern.properties) {
          const fieldInfo = classInfo.fields.get(prop.name.name);
          if (fieldInfo) {
            definePatternLocals(ctx, prop.value, fieldInfo.type);
          }
        }
        return;
      }
      return; // Unknown type, can't define locals
    }

    // Record
    const fields = recordKey.split(';').map((s) => {
      const [name, typeStr] = s.split(':');
      const type = typeStr.split(',').map(Number);
      return {name, type};
    });

    for (const prop of pattern.properties) {
      const fieldIndex = fields.findIndex((f) => f.name === prop.name.name);
      if (fieldIndex !== -1) {
        definePatternLocals(ctx, prop.value, fields[fieldIndex].type);
      }
    }
  } else if (pattern.type === NodeType.TuplePattern) {
    // Tuple
    let tupleKey: string | undefined;
    for (const [key, index] of ctx.tupleTypes) {
      if (index === typeIndex) {
        tupleKey = key;
        break;
      }
    }

    if (!tupleKey) return;

    const types = tupleKey.split(';').map((t) => t.split(',').map(Number));
    for (let i = 0; i < pattern.elements.length; i++) {
      const elem = pattern.elements[i];
      if (!elem) continue;
      if (i < types.length) {
        definePatternLocals(ctx, elem, types[i]);
      }
    }
  }
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

  let mappedReturn: number[];
  if (checkerFuncType) {
    mappedReturn = mapCheckerTypeToWasmType(ctx, checkerFuncType.returnType);
  } else if (func.returnType) {
    mappedReturn = mapCheckerTypeToWasmType(ctx, func.returnType.inferredType!);
  } else {
    // Setup temporary scope for inference
    const savedContext = ctx.saveFunctionContext();
    ctx.pushFunctionScope();

    for (let i = 0; i < func.params.length; i++) {
      const param = func.params[i];
      ctx.defineParam(param.name.name, params[i], param);
    }

    if (func.body.type !== NodeType.BlockStatement) {
      mappedReturn = inferType(ctx, func.body as Expression);
    } else {
      mappedReturn = inferReturnTypeFromBlock(ctx, func.body as BlockStatement);
    }

    ctx.restoreFunctionContext(savedContext);
  }

  const results = mappedReturn.length > 0 ? [mappedReturn] : [];

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
  ctx.functionReturnTypes.set(name, mappedReturn);

  // Register by declaration for identity-based lookup (new name resolution)
  ctx.registerFunctionByDecl(func, funcIndex);

  // Capture current module for body generation
  const capturedModule = ctx.currentModule;
  ctx.bodyGenerators.push(() => {
    // Restore the module context for import resolution during body generation
    const savedModule = ctx.currentModule;
    ctx.currentModule = capturedModule;
    const body = generateFunctionBody(ctx, name, func, undefined, mappedReturn);
    ctx.module.addCode(funcIndex, ctx.extraLocals, body);
    ctx.currentModule = savedModule;
  });
}

export function generateFunctionBody(
  ctx: CodegenContext,
  name: string,
  func: FunctionExpression,
  typeContext?: Map<string, TypeAnnotation>,
  returnType?: number[],
): number[] {
  const oldContext = ctx.currentTypeContext;
  const oldReturnType = ctx.currentReturnType;
  ctx.currentTypeContext = typeContext;
  ctx.currentReturnType = returnType;

  ctx.pushFunctionScope();

  func.params.forEach((p) => {
    ctx.defineParam(
      p.name.name,
      mapType(ctx, p.typeAnnotation, typeContext),
      p,
    );
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

  ctx.currentTypeContext = oldContext;
  ctx.currentReturnType = oldReturnType;
  return body;
}

export function instantiateGenericFunction(
  ctx: CodegenContext,
  name: string,
  typeArgs: TypeAnnotation[],
): number {
  const funcDecl = ctx.genericFunctions.get(name);
  if (!funcDecl) throw new Error(`Generic function ${name} not found`);

  const key = `${name}<${typeArgs
    .map((t) => getTypeKey(resolveAnnotation(t, ctx.currentTypeContext)))
    .join(',')}>`;

  // Check if already instantiated
  if (ctx.functions.has(key)) {
    return ctx.functions.get(key)!;
  }

  const typeContext = new Map<string, TypeAnnotation>();
  if (funcDecl.typeParameters) {
    if (funcDecl.typeParameters.length !== typeArgs.length) {
      throw new Error(
        `Expected ${funcDecl.typeParameters.length} type arguments, got ${typeArgs.length}`,
      );
    }
    for (let i = 0; i < funcDecl.typeParameters.length; i++) {
      typeContext.set(funcDecl.typeParameters[i].name, typeArgs[i]);
    }
  }

  const params = funcDecl.params.map((p) =>
    mapType(ctx, p.typeAnnotation, typeContext),
  );
  const mappedReturn = funcDecl.returnType
    ? mapType(ctx, funcDecl.returnType, typeContext)
    : (() => {
        throw new Error(
          `Generic function ${name} missing return type annotation`,
        );
      })();
  const results = mappedReturn.length > 0 ? [mappedReturn] : [];

  const typeIndex = ctx.module.addType(params, results);
  const funcIndex = ctx.module.addFunction(typeIndex);

  ctx.functions.set(key, funcIndex);

  ctx.bodyGenerators.push(() => {
    const body = generateFunctionBody(
      ctx,
      key,
      funcDecl,
      typeContext,
      mappedReturn,
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
    const results = returnType.length > 0 ? [returnType] : [];

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
  typeArgs: TypeAnnotation[],
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

  const specializedKey = `${methodName}<${typeArgs
    .map((t) => getTypeKey(resolveAnnotation(t, ctx.currentTypeContext)))
    .join(',')}>`;

  // Check if already instantiated in the class
  if (classInfo.methods.has(specializedKey)) {
    return classInfo.methods.get(specializedKey)!;
  }

  const typeContext = new Map<string, TypeAnnotation>();

  // Add class type parameters
  if (classInfo.typeArguments) {
    for (const [name, type] of classInfo.typeArguments) {
      typeContext.set(name, type);
    }
  }

  // Add method type parameters
  if (methodDecl.typeParameters) {
    if (methodDecl.typeParameters.length !== typeArgs.length) {
      throw new Error(
        `Expected ${methodDecl.typeParameters.length} type arguments, got ${typeArgs.length}`,
      );
    }
    for (let i = 0; i < methodDecl.typeParameters.length; i++) {
      typeContext.set(methodDecl.typeParameters[i].name, typeArgs[i]);
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
    params.push(mapType(ctx, param.typeAnnotation, typeContext));
  }

  let results: number[][] = [];
  if (methodDecl.returnType) {
    const mapped = mapType(ctx, methodDecl.returnType, typeContext);
    if (mapped.length > 0) results = [mapped];
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
      typeContext,
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
  typeContext: Map<string, TypeAnnotation>,
  returnType?: number[],
): number[] {
  const oldContext = ctx.currentTypeContext;
  const oldReturnType = ctx.currentReturnType;

  // Push type param context for checker-based resolution
  // This enables substituteTypeParams to resolve method type parameters
  // (e.g., U in map<U>) in addition to class type parameters
  if (typeContext.size > 0 && ctx.checkerContext) {
    const typeMap = new Map<string, Type>();
    for (const [name, annotation] of typeContext) {
      if (annotation.inferredType) {
        typeMap.set(name, annotation.inferredType);
      } else {
      }
    }
    ctx.pushTypeParamContext(typeMap);
  }
  ctx.currentTypeContext = typeContext;
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
    ctx.defineParam(
      p.name.name,
      mapType(ctx, p.typeAnnotation, typeContext),
      p,
    );
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
  if (typeContext.size > 0 && ctx.checkerContext) {
    ctx.popTypeParamContext();
  }

  ctx.currentTypeContext = oldContext;
  ctx.currentReturnType = oldReturnType;
  return body;
}
