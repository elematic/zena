import {
  NodeType,
  type BlockStatement,
  type DeclareFunction,
  type Expression,
  type FunctionExpression,
  type ReturnStatement,
  type TypeAnnotation,
  type VariableDeclaration,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {ExportDesc, Opcode, ValType} from '../wasm.js';
import {getTypeKey, mapType} from './classes.js';
import type {CodegenContext} from './context.js';
import {generateExpression, inferType} from './expressions.js';
import {generateBlockStatement} from './statements.js';

function inferReturnTypeFromBlock(
  ctx: CodegenContext,
  block: BlockStatement,
): number[] {
  for (const stmt of block.body) {
    if (stmt.type === NodeType.VariableDeclaration) {
      const decl = stmt as VariableDeclaration;
      if (decl.pattern.type === NodeType.Identifier) {
        const type = decl.typeAnnotation
          ? mapType(ctx, decl.typeAnnotation)
          : inferType(ctx, decl.init);
        ctx.defineLocal(decl.pattern.name, ctx.nextLocalIndex++, type);
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

  const params = func.params.map((p) => mapType(ctx, p.typeAnnotation));

  let mappedReturn: number[];
  if (func.returnType) {
    mappedReturn = mapType(ctx, func.returnType);
  } else {
    // Setup temporary scope for inference
    ctx.pushScope();
    const oldNextLocalIndex = ctx.nextLocalIndex;
    ctx.nextLocalIndex = 0;

    for (let i = 0; i < func.params.length; i++) {
      const param = func.params[i];
      ctx.defineLocal(param.name.name, ctx.nextLocalIndex++, params[i]);
    }

    if (func.body.type !== NodeType.BlockStatement) {
      mappedReturn = inferType(ctx, func.body as Expression);
    } else {
      mappedReturn = inferReturnTypeFromBlock(ctx, func.body as BlockStatement);
    }

    ctx.popScope();
    ctx.nextLocalIndex = oldNextLocalIndex;
  }

  const results = mappedReturn.length > 0 ? [mappedReturn] : [];

  const typeIndex = ctx.module.addType(params, results);
  const funcIndex = ctx.module.addFunction(typeIndex);

  if (exported) {
    ctx.module.addExport(exportName || name, ExportDesc.Func, funcIndex);
  }

  ctx.functions.set(name, funcIndex);
  ctx.functionReturnTypes.set(name, mappedReturn);
  ctx.bodyGenerators.push(() => {
    const body = generateFunctionBody(ctx, name, func);
    ctx.module.addCode(funcIndex, ctx.extraLocals, body);
  });
}

export function generateFunctionBody(
  ctx: CodegenContext,
  name: string,
  func: FunctionExpression,
  typeContext?: Map<string, TypeAnnotation>,
): number[] {
  const oldContext = ctx.currentTypeContext;
  ctx.currentTypeContext = typeContext;

  ctx.scopes = [new Map()];
  ctx.extraLocals = [];
  ctx.nextLocalIndex = 0;

  func.params.forEach((p) => {
    const index = ctx.nextLocalIndex++;
    ctx.scopes[0].set(p.name.name, {
      index,
      type: mapType(ctx, p.typeAnnotation, typeContext),
    });
  });

  const body: number[] = [];
  if (func.body.type === NodeType.BlockStatement) {
    generateBlockStatement(ctx, func.body as BlockStatement, body);
  } else {
    generateExpression(ctx, func.body as Expression, body);
  }
  body.push(Opcode.end);

  ctx.currentTypeContext = oldContext;
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
    .map((t) => getTypeKey(ctx, t, ctx.currentTypeContext))
    .join(',')}>`;

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
    : [ValType.i32];
  const results = mappedReturn.length > 0 ? [mappedReturn] : [];

  const typeIndex = ctx.module.addType(params, results);
  const funcIndex = ctx.module.addFunction(typeIndex);

  ctx.functions.set(key, funcIndex);

  ctx.bodyGenerators.push(() => {
    const body = generateFunctionBody(ctx, key, funcDecl, typeContext);
    ctx.module.addCode(funcIndex, ctx.extraLocals, body);
  });

  return funcIndex;
}

export function registerDeclaredFunction(
  ctx: CodegenContext,
  decl: DeclareFunction,
) {
  const params = decl.params.map((p) => mapType(ctx, p.typeAnnotation));
  const returnType = mapType(ctx, decl.returnType);
  const results = returnType.length > 0 ? [returnType] : [];

  const typeIndex = ctx.module.addType(params, results);

  const moduleName = decl.externalModule || 'env';
  const functionName = decl.externalName || decl.name.name;

  const funcIndex = ctx.module.addImport(
    moduleName,
    functionName,
    ExportDesc.Func,
    typeIndex,
  );

  if (decl.exported) {
    const exportName = (decl as any).exportName || decl.name.name;
    ctx.module.addExport(exportName, ExportDesc.Func, funcIndex);
  }

  // Register as primary function if not exists (for backward compat / simple cases)
  if (!ctx.functions.has(decl.name.name)) {
    ctx.functions.set(decl.name.name, funcIndex);
    ctx.functionReturnTypes.set(decl.name.name, returnType);
  }

  // Register in overload list
  if (!ctx.functionOverloads.has(decl.name.name)) {
    ctx.functionOverloads.set(decl.name.name, []);
  }
  ctx.functionOverloads.get(decl.name.name)!.push({
    index: funcIndex,
    params: params,
  });
}
