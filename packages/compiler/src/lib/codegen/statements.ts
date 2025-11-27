import {
  NodeType,
  type BlockStatement,
  type ClassDeclaration,
  type IfStatement,
  type ReturnStatement,
  type Statement,
  type VariableDeclaration,
  type WhileStatement,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {GcOpcode, Opcode, ValType, HeapType} from '../wasm.js';
import {decodeTypeIndex, getClassFromTypeIndex, mapType} from './classes.js';
import type {CodegenContext} from './context.js';
import {generateExpression, inferType} from './expressions.js';

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

export function generateLocalVariableDeclaration(
  ctx: CodegenContext,
  decl: VariableDeclaration,
  body: number[],
) {
  generateExpression(ctx, decl.init, body);
  const exprType = inferType(ctx, decl.init);

  // console.log(`Generating local ${decl.identifier.name}`);
  let type: number[];
  if (decl.typeAnnotation) {
    // console.log(`  Has type annotation: ${decl.typeAnnotation.type}`);
    type = mapType(ctx, decl.typeAnnotation, ctx.currentTypeContext);

    // Union boxing (i32 -> anyref)
    if (
      type.length === 2 &&
      type[0] === ValType.ref_null &&
      type[1] === HeapType.any &&
      exprType.length === 1 &&
      exprType[0] === ValType.i32
    ) {
      body.push(Opcode.gc_prefix, GcOpcode.ref_i31);
    }

    // Check for interface boxing
    if (
      decl.typeAnnotation.type === NodeType.TypeAnnotation &&
      ctx.interfaces.has(decl.typeAnnotation.name)
    ) {
      // console.log(`  Interface boxing for ${decl.typeAnnotation.name}`);
      const initType = inferType(ctx, decl.init);
      const typeIndex = decodeTypeIndex(initType);
      const classInfo = getClassFromTypeIndex(ctx, typeIndex);

      if (classInfo && classInfo.implements) {
        const interfaceName = decl.typeAnnotation.name;
        const interfaceInfo = ctx.interfaces.get(interfaceName)!;
        let implInfo = classInfo.implements.get(interfaceName);

        if (!implInfo) {
          // Search for subtype
          for (const [name, info] of classInfo.implements) {
            let currentName: string | undefined = name;
            while (currentName) {
              if (currentName === interfaceName) {
                implInfo = info;
                break;
              }
              const currentInfo = ctx.interfaces.get(currentName);
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
  }

  const index = ctx.declareLocal(decl.identifier.name, type);
  body.push(Opcode.local_set);
  body.push(...WasmModule.encodeSignedLEB128(index));
}

export function generateReturnStatement(
  ctx: CodegenContext,
  stmt: ReturnStatement,
  body: number[],
) {
  if (stmt.argument) {
    generateExpression(ctx, stmt.argument, body);
  }
  // We don't strictly need 'return' opcode if it's the last statement,
  // but for now let's not optimize and assume implicit return at end of function
  // or explicit return.
  // If we are in a block, we might need 'return'.
  // Let's use 'return' opcode for explicit return statements.
  body.push(Opcode.return);
}
