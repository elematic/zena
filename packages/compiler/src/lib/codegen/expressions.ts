import {
  NodeType,
  type ArrayLiteral,
  type AsExpression,
  type AssignmentExpression,
  type BinaryExpression,
  type BlockStatement,
  type BooleanLiteral,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Identifier,
  type IndexExpression,
  type MemberExpression,
  type MethodDefinition,
  type NewExpression,
  type NullLiteral,
  type NumberLiteral,
  type RecordLiteral,
  type StringLiteral,
  type TaggedTemplateExpression,
  type TemplateLiteral,
  type ThisExpression,
  type TupleLiteral,
  type TypeAnnotation,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {ExportDesc, GcOpcode, HeapType, Opcode, ValType} from '../wasm.js';
import {analyzeCaptures} from './captures.js';
import {
  decodeTypeIndex,
  getClassFromTypeIndex,
  getInterfaceFromTypeIndex,
  getTypeKey,
  mapType,
} from './classes.js';
import type {CodegenContext} from './context.js';
import {
  inferReturnTypeFromBlock,
  instantiateGenericFunction,
} from './functions.js';
import {generateBlockStatement} from './statements.js';
import type {ClassInfo} from './types.js';

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
    default:
      // TODO: Handle other expressions
      break;
  }
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

  const targetType = mapType(ctx, expr.typeAnnotation, ctx.currentTypeContext);

  let sourceType: number[] | undefined;
  try {
    sourceType = inferType(ctx, expr.expression);
  } catch (e) {
    // Ignore inference errors, just don't optimize
  }

  if (sourceType && typesAreEqual(sourceType, targetType)) {
    return;
  }

  // If target is a reference type (ref null ...)
  if (targetType.length > 1 && targetType[0] === ValType.ref_null) {
    // ref.cast_null
    body.push(0xfb, GcOpcode.ref_cast_null);
    // The rest of targetType is the LEB128 encoded type index
    body.push(...targetType.slice(1));
  }
}

export function inferType(ctx: CodegenContext, expr: Expression): number[] {
  switch (expr.type) {
    case NodeType.StringLiteral:
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
      ];
    // case NodeType.NumberLiteral removed (duplicate)
    case NodeType.BooleanLiteral:
      return [ValType.i32];
    case NodeType.AsExpression: {
      const asExpr = expr as AsExpression;
      return mapType(ctx, asExpr.typeAnnotation, ctx.currentTypeContext);
    }
    case NodeType.AssignmentExpression: {
      const assignExpr = expr as AssignmentExpression;
      return inferType(ctx, assignExpr.value);
    }
    case NodeType.Identifier: {
      const name = (expr as Identifier).name;
      const local = ctx.getLocal(name);
      if (local) return local.type;
      const global = ctx.getGlobal(name);
      if (global) return global.type;
      throw new Error(`Unknown identifier: ${name}`);
    }
    case NodeType.MemberExpression: {
      const memberExpr = expr as MemberExpression;
      const objectType = inferType(ctx, memberExpr.object);

      // Handle array/string length
      if (memberExpr.property.name === 'length') {
        const isString = isStringType(ctx, objectType);
        const isArray = Array.from(ctx.arrayTypes.values()).includes(
          objectType[1],
        );
        if (isString || isArray) return [ValType.i32];
      }

      const structTypeIndex = getHeapTypeIndex(ctx, objectType);
      if (structTypeIndex === -1) return [ValType.i32];

      const fieldName = memberExpr.property.name;

      let foundClass: ClassInfo | undefined;
      for (const info of ctx.classes.values()) {
        if (info.structTypeIndex === structTypeIndex) {
          foundClass = info;
          break;
        }
      }

      if (!foundClass) {
        // Check Record
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
            const typeStr = s.substring(colonIndex + 1);
            return {name, typeStr};
          });
          const field = fields.find((f) => f.name === fieldName);
          if (field) {
            return field.typeStr.split(',').map(Number);
          }
        }
        return [ValType.i32];
      }

      let lookupName = fieldName;
      if (fieldName.startsWith('#')) {
        if (ctx.currentClass) {
          lookupName = `${ctx.currentClass.name}::${fieldName}`;
        }
      }

      const fieldInfo = foundClass.fields.get(lookupName);
      if (fieldInfo) {
        return fieldInfo.type;
      }
      // If it's a method, we might return a function reference or something?
      // For now, let's assume it's a field access.
      return [ValType.i32];
    }
    case NodeType.BinaryExpression: {
      const binExpr = expr as BinaryExpression;
      if (binExpr.operator === '+') {
        const leftType = inferType(ctx, binExpr.left);
        const rightType = inferType(ctx, binExpr.right);
        if (isStringType(ctx, leftType) && isStringType(ctx, rightType)) {
          return [ValType.ref_null, ctx.stringTypeIndex];
        }
      }
      return [ValType.i32];
    }
    case NodeType.NewExpression: {
      const newExpr = expr as NewExpression;
      let className = newExpr.callee.name;
      if (!ctx.classes.has(className) && !ctx.genericClasses.has(className)) {
        throw new Error(
          `Class ${className} not found in inferType(NewExpression). Available: ${Array.from(ctx.classes.keys()).join(', ')}`,
        );
      }
      let typeArguments = newExpr.typeArguments;

      if (
        (!typeArguments || typeArguments.length === 0) &&
        ctx.genericClasses.has(className)
      ) {
        const classDecl = ctx.genericClasses.get(className)!;
        const ctor = classDecl.body.find(
          (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
        ) as MethodDefinition | undefined;
        if (ctor) {
          typeArguments = inferTypeArgs(
            ctx,
            classDecl.typeParameters!,
            ctor.params,
            newExpr.arguments,
          );
        }
      }

      if (typeArguments && typeArguments.length > 0) {
        const annotation: TypeAnnotation = {
          type: NodeType.TypeAnnotation,
          name: className,
          typeArguments: typeArguments,
        };
        return mapType(ctx, annotation, ctx.currentTypeContext);
      }
      const classInfo = ctx.classes.get(className);
      if (classInfo) {
        return [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
        ];
      }
      throw new Error(
        `Class ${className} not found in inferType(NewExpression) after checks. Available: ${Array.from(ctx.classes.keys()).join(', ')}`,
      );
      return [ValType.i32];
    }
    case NodeType.CallExpression: {
      const callExpr = expr as CallExpression;
      if (callExpr.callee.type === NodeType.MemberExpression) {
        const memberExpr = callExpr.callee as MemberExpression;
        const objectType = inferType(ctx, memberExpr.object);
        const structTypeIndex = getHeapTypeIndex(ctx, objectType);
        if (structTypeIndex === -1) return [ValType.i32];

        let foundClass: ClassInfo | undefined;
        for (const info of ctx.classes.values()) {
          if (info.structTypeIndex === structTypeIndex) {
            foundClass = info;
            break;
          }
        }
        if (!foundClass) return [ValType.i32];

        const methodName = memberExpr.property.name;
        const methodInfo = foundClass.methods.get(methodName);
        if (methodInfo) {
          return methodInfo.returnType;
        }
      } else if (callExpr.callee.type === NodeType.Identifier) {
        const name = (callExpr.callee as Identifier).name;
        if (ctx.genericFunctions.has(name)) {
          const funcDecl = ctx.genericFunctions.get(name)!;
          let typeArguments = callExpr.typeArguments;

          if (!typeArguments || typeArguments.length === 0) {
            typeArguments = inferTypeArgs(
              ctx,
              funcDecl.typeParameters!,
              funcDecl.params,
              callExpr.arguments,
            );
          }

          if (typeArguments && typeArguments.length > 0) {
            const typeContext = new Map<string, TypeAnnotation>();
            for (let i = 0; i < funcDecl.typeParameters!.length; i++) {
              typeContext.set(
                funcDecl.typeParameters![i].name,
                typeArguments[i],
              );
            }
            if (funcDecl.returnType) {
              return mapType(ctx, funcDecl.returnType, typeContext);
            }
          }
        } else if (ctx.functionReturnTypes.has(name)) {
          return ctx.functionReturnTypes.get(name)!;
        }
      } else if (callExpr.callee.type === NodeType.SuperExpression) {
        return [];
      }
      return [ValType.i32];
    }
    case NodeType.FunctionExpression: {
      const func = expr as FunctionExpression;

      // Handle generics
      const typeContext = new Map(ctx.currentTypeContext);
      if (func.typeParameters) {
        for (const param of func.typeParameters) {
          typeContext.set(param.name, {
            type: NodeType.TypeAnnotation,
            name: 'anyref',
          } as any);
        }
      }

      // Temporarily override context
      const oldTypeContext = ctx.currentTypeContext;
      ctx.currentTypeContext = typeContext;

      const paramTypes = func.params.map((p) => mapType(ctx, p.typeAnnotation));
      let returnType: number[];
      if (func.returnType) {
        returnType = mapType(ctx, func.returnType);
      } else {
        if (func.body.type !== NodeType.BlockStatement) {
          returnType = [ValType.i32];
        } else {
          // Setup temporary scope for inference
          ctx.pushScope();
          const oldNextLocalIndex = ctx.nextLocalIndex;
          ctx.nextLocalIndex = 0;

          func.params.forEach((p, i) => {
            ctx.defineLocal(p.name.name, ctx.nextLocalIndex++, paramTypes[i]);
          });

          returnType = inferReturnTypeFromBlock(
            ctx,
            func.body as BlockStatement,
          );

          ctx.popScope();
          ctx.nextLocalIndex = oldNextLocalIndex;
        }
      }

      // Restore context
      ctx.currentTypeContext = oldTypeContext;

      const closureTypeIndex = ctx.getClosureTypeIndex(paramTypes, returnType);
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(closureTypeIndex),
      ];
    }
    case NodeType.RecordLiteral: {
      const recordExpr = expr as RecordLiteral;
      const fields = recordExpr.properties.map((p) => ({
        name: p.name.name,
        type: inferType(ctx, p.value),
      }));
      const typeIndex = ctx.getRecordTypeIndex(fields);
      return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
    }
    case NodeType.TupleLiteral: {
      const tupleExpr = expr as TupleLiteral;
      const types = tupleExpr.elements.map((e) => inferType(ctx, e));
      const typeIndex = ctx.getTupleTypeIndex(types);
      return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
    }
    case NodeType.IndexExpression: {
      const indexExpr = expr as IndexExpression;
      const objectType = inferType(ctx, indexExpr.object);
      const structTypeIndex = getHeapTypeIndex(ctx, objectType);

      // Check Tuple
      let tupleKey: string | undefined;
      for (const [key, index] of ctx.tupleTypes) {
        if (index === structTypeIndex) {
          tupleKey = key;
          break;
        }
      }

      if (tupleKey) {
        if (indexExpr.index.type === NodeType.NumberLiteral) {
          const index = (indexExpr.index as NumberLiteral).value;
          const types = tupleKey.split(';');
          if (index >= 0 && index < types.length) {
            return types[index].split(',').map(Number);
          }
        }
        return [ValType.i32];
      }

      // Array fallback
      // Assuming array of i32 for now if we can't infer better
      // Or check arrayTypes
      let elementType: number[] = [ValType.i32];
      for (const [key, index] of ctx.arrayTypes) {
        if (index === objectType[1]) {
          // Assuming [ref_null, typeIndex]
          elementType = key.split(',').map(Number);
          break;
        }
      }
      return elementType;
    }
    case NodeType.NumberLiteral: {
      const numExpr = expr as NumberLiteral;
      if (Number.isInteger(numExpr.value)) {
        return [ValType.i32];
      } else {
        return [ValType.f32];
      }
    }
    case NodeType.ArrayLiteral: {
      // TODO: Infer array type correctly. Assuming i32 for now.
      const typeIndex = getArrayTypeIndex(ctx, [ValType.i32]);
      return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
    }
    case NodeType.StringLiteral:
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
      ];
    case NodeType.TemplateLiteral:
      // Untagged template literal produces a string
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
      ];
    case NodeType.TaggedTemplateExpression: {
      // Tagged template expression's type is the return type of the tag function
      // For now, assume it returns the string type (common case)
      // TODO: Actually infer from tag function return type
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
      ];
    }
    case NodeType.ThisExpression: {
      const local = ctx.getLocal('this');
      if (local) return local.type;
      return [ValType.i32];
    }
    case NodeType.SuperExpression: {
      if (!ctx.currentClass || !ctx.currentClass.superClass) {
        throw new Error('Super expression outside of class with superclass');
      }
      const superClassInfo = ctx.classes.get(ctx.currentClass.superClass)!;
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(superClassInfo.structTypeIndex),
      ];
    }
    case NodeType.NullLiteral:
      return [ValType.ref_null, HeapType.none];
    default:
      return [ValType.i32];
  }
}

function splitTypeArgs(str: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '<') depth++;
    else if (char === '>') depth--;
    else if (char === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function getTypeNameFromWasm(
  ctx: CodegenContext,
  type: number[],
): string | undefined {
  if (type.length === 1 && type[0] === ValType.i32) return 'i32';
  if (type.length === 1 && type[0] === ValType.f32) return 'f32';
  if (
    type.length > 1 &&
    (type[0] === ValType.ref_null || type[0] === ValType.ref)
  ) {
    const typeIndex = decodeTypeIndex(type);
    if (typeIndex === ctx.stringTypeIndex) return 'string';
    const classInfo = getClassFromTypeIndex(ctx, typeIndex);
    if (classInfo) return classInfo.name;
  }
  return undefined;
}

export function inferTypeArgs(
  ctx: CodegenContext,
  typeParams: any[], // TypeParameter[]
  params: any[], // Parameter[]
  args: Expression[],
): TypeAnnotation[] {
  const inferred = new Map<string, TypeAnnotation>();

  for (let i = 0; i < Math.min(params.length, args.length); i++) {
    const paramType = params[i].typeAnnotation;
    const argType = inferType(ctx, args[i]);

    // Simple inference: if param is T, and arg is Type, then T = Type
    if (
      paramType.type === NodeType.TypeAnnotation &&
      !paramType.typeArguments &&
      typeParams.some((tp) => tp.name === paramType.name)
    ) {
      const typeName = getTypeNameFromWasm(ctx, argType) || 'i32';
      inferred.set(paramType.name, {
        type: NodeType.TypeAnnotation,
        name: typeName,
      } as TypeAnnotation);
    }

    // Generic class inference: Array<T> vs Array<i32>
    if (
      paramType.type === NodeType.TypeAnnotation &&
      paramType.typeArguments &&
      paramType.typeArguments.length > 0 &&
      argType.length > 1 &&
      (argType[0] === ValType.ref_null || argType[0] === ValType.ref)
    ) {
      const typeIndex = decodeTypeIndex(argType);
      const classInfo = getClassFromTypeIndex(ctx, typeIndex);

      if (classInfo && classInfo.name.startsWith(paramType.name + '<')) {
        const typeArgsStr = classInfo.name.substring(
          paramType.name.length + 1,
          classInfo.name.length - 1,
        );
        const typeArgs = splitTypeArgs(typeArgsStr);

        if (typeArgs.length === paramType.typeArguments.length) {
          for (let j = 0; j < typeArgs.length; j++) {
            const paramTypeArg = paramType.typeArguments[j];
            const argTypeStr = typeArgs[j];

            if (
              paramTypeArg.type === NodeType.TypeAnnotation &&
              !paramTypeArg.typeArguments &&
              typeParams.some((tp) => tp.name === paramTypeArg.name)
            ) {
              inferred.set(paramTypeArg.name, {
                type: NodeType.TypeAnnotation,
                name: argTypeStr,
              } as TypeAnnotation);
            }
          }
        }
      }

      // Array inference: Array<T> vs WASM Array
      let arrayElementType: number[] | undefined;
      for (const [key, index] of ctx.arrayTypes) {
        if (index === typeIndex) {
          arrayElementType = key.split(',').map(Number);
          break;
        }
      }

      const isArray = ctx.isArrayType(paramType.name);

      if (arrayElementType && isArray) {
        if (paramType.typeArguments.length === 1) {
          const paramTypeArg = paramType.typeArguments[0];
          if (
            paramTypeArg.type === NodeType.TypeAnnotation &&
            !paramTypeArg.typeArguments &&
            typeParams.some((tp) => tp.name === paramTypeArg.name)
          ) {
            const typeName =
              getTypeNameFromWasm(ctx, arrayElementType) || 'i32';
            inferred.set(paramTypeArg.name, {
              type: NodeType.TypeAnnotation,
              name: typeName,
            } as TypeAnnotation);
          }
        }
      }
    }

    // Function type inference: (T) => U vs Closure
    if (
      paramType.type === NodeType.FunctionTypeAnnotation &&
      (argType[0] === ValType.ref_null || argType[0] === ValType.ref)
    ) {
      const typeIndex = decodeTypeIndex(argType);

      let signature: string | undefined;
      for (const [key, index] of ctx.closureTypes) {
        if (index === typeIndex) {
          signature = key;
          break;
        }
      }

      if (signature) {
        const parts = signature.split('=>');
        if (parts.length === 2) {
          const returnTypeStr = parts[1];
          if (returnTypeStr) {
            const returnType = returnTypeStr.split(',').map(Number);

            const retParam = paramType.returnType;
            if (
              retParam.type === NodeType.TypeAnnotation &&
              !retParam.typeArguments &&
              typeParams.some((tp) => tp.name === retParam.name)
            ) {
              const typeName = getTypeNameFromWasm(ctx, returnType) || 'i32';
              inferred.set(retParam.name, {
                type: NodeType.TypeAnnotation,
                name: typeName,
              } as TypeAnnotation);
            }
          }
        }
      }
    }
  }

  return typeParams.map((tp) => {
    if (inferred.has(tp.name)) return inferred.get(tp.name)!;
    if (tp.default) return tp.default;
    throw new Error(`Cannot infer type argument for ${tp.name}`);
  });
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
  return index === ctx.stringTypeIndex;
}

function getArrayTypeIndex(ctx: CodegenContext, elementType: number[]): number {
  const key = elementType.join(',');
  if (ctx.arrayTypes.has(key)) {
    return ctx.arrayTypes.get(key)!;
  }
  const index = ctx.module.addArrayType(elementType, true);
  ctx.arrayTypes.set(key, index);
  return index;
}

function generateArrayLiteral(
  ctx: CodegenContext,
  expr: ArrayLiteral,
  body: number[],
) {
  if (expr.elements.length === 0) {
    const typeIndex = getArrayTypeIndex(ctx, [ValType.i32]);
    body.push(0xfb, GcOpcode.array_new_fixed);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
    body.push(...WasmModule.encodeSignedLEB128(0));
    return;
  }

  // TODO: Infer type correctly. Assuming i32 for now.
  const elementType = [ValType.i32];
  const typeIndex = getArrayTypeIndex(ctx, elementType);

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
    for (const info of ctx.classes.values()) {
      if (info.structTypeIndex === structTypeIndex) {
        foundClass = info;
        break;
      }
    }

    if (foundClass) {
      const methodInfo = foundClass.methods.get('[]');
      if (methodInfo) {
        generateExpression(ctx, expr.object, body);
        generateExpression(ctx, expr.index, body);
        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
        return;
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
      arrayTypeIndex = objectType[1];
    } else {
      arrayTypeIndex = getArrayTypeIndex(ctx, [ValType.i32]);
    }
  }

  generateExpression(ctx, expr.object, body);

  if (arrayTypeIndex === ctx.stringTypeIndex) {
    // It's a string struct. Get the bytes array.
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(1)); // bytes field

    generateExpression(ctx, expr.index, body);

    body.push(0xfb, GcOpcode.array_get_u);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));
  } else if (arrayTypeIndex === ctx.byteArrayTypeIndex) {
    generateExpression(ctx, expr.index, body);
    body.push(0xfb, GcOpcode.array_get_u);
    body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));
  } else {
    generateExpression(ctx, expr.index, body);
    body.push(0xfb, GcOpcode.array_get);
    body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));
  }
}

function generateNewExpression(
  ctx: CodegenContext,
  expr: NewExpression,
  body: number[],
) {
  let className = expr.callee.name;
  let typeArguments = expr.typeArguments;

  if (
    (!typeArguments || typeArguments.length === 0) &&
    ctx.genericClasses.has(className)
  ) {
    const classDecl = ctx.genericClasses.get(className)!;
    const ctor = classDecl.body.find(
      (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
    ) as MethodDefinition | undefined;
    if (ctor) {
      typeArguments = inferTypeArgs(
        ctx,
        classDecl.typeParameters!,
        ctor.params,
        expr.arguments,
      );
    } else {
      throw new Error(
        `Cannot infer type arguments for ${className}: no constructor found.`,
      );
    }
  }

  if (typeArguments && typeArguments.length > 0) {
    // Check for partial type arguments and fill with defaults
    if (ctx.genericClasses.has(className)) {
      const classDecl = ctx.genericClasses.get(className)!;
      if (
        classDecl.typeParameters &&
        typeArguments.length < classDecl.typeParameters.length
      ) {
        const newArgs = [...typeArguments];
        for (
          let i = typeArguments.length;
          i < classDecl.typeParameters.length;
          i++
        ) {
          const param = classDecl.typeParameters[i];
          if (param.default) {
            newArgs.push(param.default);
          } else {
            throw new Error(`Missing type argument for ${param.name}`);
          }
        }
        typeArguments = newArgs;
      }
    }

    const annotation: TypeAnnotation = {
      type: NodeType.TypeAnnotation,
      name: className,
      typeArguments: typeArguments,
    };
    // Ensure the class is instantiated
    mapType(ctx, annotation, ctx.currentTypeContext);
    // Get the specialized name
    className = getTypeKey(ctx, annotation, ctx.currentTypeContext);
  }

  if (className.startsWith('Array<')) {
    const annotation: TypeAnnotation = {
      type: NodeType.TypeAnnotation,
      name: 'Array',
      typeArguments: typeArguments,
    };
    const type = mapType(ctx, annotation, ctx.currentTypeContext);
    const typeIndex = decodeTypeIndex(type);

    if (expr.arguments.length !== 1) {
      throw new Error('Array constructor expects 1 argument (length)');
    }
    generateExpression(ctx, expr.arguments[0], body);

    body.push(0xfb, GcOpcode.array_new_default);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
    return;
  }

  const classInfo = ctx.classes.get(className);
  if (!classInfo) throw new Error(`Class ${className} not found`);

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

  // Prepare args for constructor: [this, args...]
  for (const arg of expr.arguments) {
    generateExpression(ctx, arg, body);
  }

  // Call constructor
  const ctorInfo = classInfo.methods.get('#new');
  if (ctorInfo !== undefined) {
    body.push(Opcode.call);
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
  const objectType = inferType(ctx, expr.object);

  // Handle array/string length
  if (expr.property.name === 'length') {
    const isString = isStringType(ctx, objectType);
    const isArray = Array.from(ctx.arrayTypes.values()).includes(objectType[1]);

    if (isString) {
      generateExpression(ctx, expr.object, body);
      // struct.get $stringType 2 (length)
      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(2));
      return;
    }

    if (isArray) {
      generateExpression(ctx, expr.object, body);
      body.push(0xfb, GcOpcode.array_len);
      return;
    }
  }

  generateExpression(ctx, expr.object, body);

  const fieldName = expr.property.name;

  const structTypeIndex = getHeapTypeIndex(ctx, objectType);
  if (structTypeIndex === -1) {
    throw new Error(`Invalid object type for field access: ${fieldName}`);
  }

  let foundClass: ClassInfo | undefined;
  for (const info of ctx.classes.values()) {
    if (info.structTypeIndex === structTypeIndex) {
      foundClass = info;
      break;
    }
  }

  if (!foundClass) {
    // Check if it's a Record
    let recordKey: string | undefined;
    for (const [key, index] of ctx.recordTypes) {
      if (index === structTypeIndex) {
        recordKey = key;
        break;
      }
    }

    if (recordKey) {
      // Parse key to find field index
      // Key format: "name:type;name:type;..." (sorted by name)
      const fields = recordKey.split(';').map((s) => {
        // Split by first colon only
        const colonIndex = s.indexOf(':');
        const name = s.substring(0, colonIndex);
        return {name};
      });

      const fieldIndex = fields.findIndex((f) => f.name === fieldName);
      if (fieldIndex === -1) {
        throw new Error(`Field ${fieldName} not found in record`);
      }

      body.push(0xfb, GcOpcode.struct_get);
      body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(fieldIndex));
      return;
    }

    // Check if it's an interface
    const interfaceInfo = getInterfaceFromTypeIndex(ctx, structTypeIndex);
    if (interfaceInfo) {
      // Handle interface field access
      const fieldInfo = interfaceInfo.fields.get(fieldName);
      if (!fieldInfo) {
        throw new Error(`Field ${fieldName} not found in interface`);
      }

      // Stack: [InterfaceStruct]
      // We need to call the getter from the VTable.

      // 1. Store interface struct in temp local to access fields
      const tempLocal = ctx.declareLocal('$$interface_temp', objectType);
      body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempLocal));

      // 2. Load VTable
      body.push(
        0xfb,
        GcOpcode.struct_get,
        ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
        ...WasmModule.encodeSignedLEB128(1), // vtable is at index 1
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
        ...WasmModule.encodeSignedLEB128(fieldInfo.typeIndex),
      );

      // Store funcRef in temp local
      const funcRefType = [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(fieldInfo.typeIndex),
      ];
      const funcRefLocal = ctx.declareLocal('$$interface_getter', funcRefType);
      body.push(
        Opcode.local_set,
        ...WasmModule.encodeSignedLEB128(funcRefLocal),
      );

      // 5. Load Instance from Interface Struct
      body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempLocal));
      body.push(
        0xfb,
        GcOpcode.struct_get,
        ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
        ...WasmModule.encodeSignedLEB128(0), // instance is at index 0
      );

      // Load funcRef
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(funcRefLocal),
      );

      // 6. Call Getter
      body.push(
        Opcode.call_ref,
        ...WasmModule.encodeSignedLEB128(fieldInfo.typeIndex),
      );

      return;
    }

    throw new Error(
      `Class or Interface not found for object type ${structTypeIndex}`,
    );
  }

  let lookupName = fieldName;
  if (fieldName.startsWith('#')) {
    if (!ctx.currentClass) {
      throw new Error('Private field access outside class');
    }
    lookupName = `${ctx.currentClass.name}::${fieldName}`;
  }

  // Check for virtual property access (public fields or accessors)
  if (!fieldName.startsWith('#')) {
    const getterName = `get_${fieldName}`;
    const methodInfo = foundClass.methods.get(getterName);
    if (methodInfo) {
      // Call getter
      // Stack: [this]

      // Check if we can use static dispatch (final class or final method)
      const useStaticDispatch = foundClass.isFinal || methodInfo.isFinal;

      if (useStaticDispatch) {
        // Static dispatch - direct call
        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
      } else {
        // Dynamic dispatch via vtable

        // 1. Duplicate 'this' for vtable lookup
        const tempThis = ctx.declareLocal('$$temp_this', objectType);
        body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempThis));

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
        const vtableIndex = foundClass.vtable.indexOf(getterName);
        if (vtableIndex === -1) {
          throw new Error(`Method ${getterName} not found in vtable`);
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

        // 5. Call function
        // Stack: [this, func_ref]
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempThis));
        body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(funcRef));
        body.push(
          Opcode.call_ref,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        );
      }
      return;
    }
  }

  const fieldInfo = foundClass.fields.get(lookupName);
  if (!fieldInfo) {
    throw new Error(`Field ${lookupName} not found in class`);
  }

  body.push(0xfb, GcOpcode.struct_get);
  body.push(...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
}

function generateThisExpression(
  ctx: CodegenContext,
  expr: ThisExpression,
  body: number[],
) {
  body.push(Opcode.local_get);
  body.push(...WasmModule.encodeSignedLEB128(ctx.thisLocalIndex));
}

function generateCallExpression(
  ctx: CodegenContext,
  expr: CallExpression,
  body: number[],
) {
  if (expr.callee.type === NodeType.MemberExpression) {
    const memberExpr = expr.callee as MemberExpression;
    const methodName = memberExpr.property.name;

    if (memberExpr.object.type === NodeType.SuperExpression) {
      // Super method call (Static Dispatch)
      if (!ctx.currentClass || !ctx.currentClass.superClass) {
        throw new Error('Super call outside of class with superclass');
      }
      const superClassInfo = ctx.classes.get(ctx.currentClass.superClass)!;
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

    const objectType = inferType(ctx, memberExpr.object);
    const typeIndex = decodeTypeIndex(objectType);

    // Check if interface
    const interfaceInfo = getInterfaceFromTypeIndex(ctx, typeIndex);
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
      for (const arg of expr.arguments) {
        generateExpression(ctx, arg, body);
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
      return;
    }

    const structTypeIndex = getHeapTypeIndex(ctx, objectType);

    if (structTypeIndex === -1) {
      throw new Error(`Invalid object type for method call: ${methodName}`);
    }

    let foundClass: ClassInfo | undefined;
    for (const info of ctx.classes.values()) {
      if (info.structTypeIndex === structTypeIndex) {
        foundClass = info;
        break;
      }
    }

    if (!foundClass) {
      throw new Error(`Class not found for object type ${structTypeIndex}`);
    }

    const methodInfo = foundClass.methods.get(methodName);
    if (methodInfo === undefined) {
      throw new Error(`Method ${methodName} not found in class`);
    }

    const vtableIndex = foundClass.vtable
      ? foundClass.vtable.indexOf(methodName)
      : -1;

    if (
      vtableIndex !== -1 &&
      foundClass.vtableTypeIndex !== undefined &&
      !methodInfo.isFinal
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
      for (const arg of expr.arguments) {
        generateExpression(ctx, arg, body);
      }

      // Get function
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempFunc));

      // Call ref
      body.push(Opcode.call_ref);
      body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));
    } else {
      generateExpression(ctx, memberExpr.object, body);

      for (const arg of expr.arguments) {
        generateExpression(ctx, arg, body);
      }

      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
    }
  } else if (expr.callee.type === NodeType.SuperExpression) {
    // Super constructor call
    if (!ctx.currentClass || !ctx.currentClass.superClass) {
      throw new Error(
        'Super constructor call outside of class with superclass',
      );
    }
    const superClassInfo = ctx.classes.get(ctx.currentClass.superClass)!;
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
    body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
    return;
  } else {
    // Check if it's a direct call to a global function
    let isDirectCall = false;
    if (expr.callee.type === NodeType.Identifier) {
      const name = (expr.callee as Identifier).name;
      if (
        !ctx.getLocal(name) &&
        (ctx.functions.has(name) ||
          ctx.genericFunctions.has(name) ||
          ctx.functionOverloads.has(name))
      ) {
        isDirectCall = true;
      }
    }

    if (isDirectCall) {
      // 1. Generate arguments
      for (const arg of expr.arguments) {
        generateExpression(ctx, arg, body);
      }

      // 2. Resolve function
      const name = (expr.callee as Identifier).name;

      if (ctx.genericFunctions.has(name)) {
        let typeArguments = expr.typeArguments;

        if (!typeArguments || typeArguments.length === 0) {
          const funcDecl = ctx.genericFunctions.get(name)!;
          typeArguments = inferTypeArgs(
            ctx,
            funcDecl.typeParameters!,
            funcDecl.params,
            expr.arguments,
          );
        } else {
          // Check for partial type arguments
          const funcDecl = ctx.genericFunctions.get(name)!;
          if (
            funcDecl.typeParameters &&
            typeArguments.length < funcDecl.typeParameters.length
          ) {
            const newArgs = [...typeArguments];
            for (
              let i = typeArguments.length;
              i < funcDecl.typeParameters.length;
              i++
            ) {
              const param = funcDecl.typeParameters[i];
              if (param.default) {
                newArgs.push(param.default);
              } else {
                throw new Error(`Missing type argument for ${param.name}`);
              }
            }
            typeArguments = newArgs;
          }
        }

        const funcIndex = instantiateGenericFunction(ctx, name, typeArguments!);
        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(funcIndex));
        return;
      }

      if (ctx.functionOverloads.has(name)) {
        const overloads = ctx.functionOverloads.get(name)!;
        const argTypes = expr.arguments.map((arg) => inferType(ctx, arg));

        let bestMatchIndex = -1;

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
            bestMatchIndex = overload.index;
            break;
          }
        }

        if (bestMatchIndex !== -1) {
          body.push(Opcode.call);
          body.push(...WasmModule.encodeSignedLEB128(bestMatchIndex));
          return;
        }
      }

      const funcIndex = ctx.functions.get(name);
      if (funcIndex !== undefined) {
        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(funcIndex));
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
      for (const info of ctx.classes.values()) {
        if (info.structTypeIndex === structTypeIndex) {
          foundClass = info;
          break;
        }
      }

      if (foundClass) {
        const methodInfo = foundClass.methods.get('[]=');
        if (methodInfo) {
          generateExpression(ctx, indexExpr.object, body);
          generateExpression(ctx, indexExpr.index, body);
          generateExpression(ctx, expr.value, body);

          // We need to return the value, so tee it before calling setter?
          // But setter returns void usually.
          // Assignment expression evaluates to the value.
          // So:
          // 1. Evaluate object
          // 2. Evaluate index
          // 3. Evaluate value
          // 4. Tee value to temp local
          // 5. Call []= (object, index, value)
          // 6. Get temp local

          // Wait, stack order for call: object, index, value.
          // If we tee value, it stays on stack.
          // Stack: [object, index, value]
          // Tee value: [object, index, value] (local set value)
          // Call: consumes [object, index, value]
          // Push local: [val]

          const valueType = inferType(ctx, expr.value);
          const tempVal = ctx.declareLocal('$$temp_assign_val', valueType);

          // We need to be careful with stack order.
          // generateExpression pushes to stack.

          // Actually, we can't easily tee the 3rd argument without shuffling.
          // Better to evaluate value to local first?
          // But evaluation order matters (side effects).
          // Standard order: object, index, value.

          // So:
          // generate object -> [obj]
          // generate index -> [obj, idx]
          // generate value -> [obj, idx, val]
          // local.tee temp -> [obj, idx, val]
          // call []= -> [] (assuming void return)
          // local.get temp -> [val]

          body.push(Opcode.local_tee);
          body.push(...WasmModule.encodeSignedLEB128(tempVal));

          body.push(Opcode.call);
          body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));

          body.push(Opcode.local_get);
          body.push(...WasmModule.encodeSignedLEB128(tempVal));
          return;
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
        arrayTypeIndex = objectType[1];
      } else {
        arrayTypeIndex = getArrayTypeIndex(ctx, [ValType.i32]);
      }
    }

    generateExpression(ctx, indexExpr.object, body);
    generateExpression(ctx, indexExpr.index, body);
    generateExpression(ctx, expr.value, body);

    const tempLocal = ctx.declareLocal('$$temp_array_set', [ValType.i32]);

    body.push(Opcode.local_tee);
    body.push(...WasmModule.encodeSignedLEB128(tempLocal));

    body.push(0xfb, GcOpcode.array_set);
    body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));

    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(tempLocal));
    return;
  }

  if (expr.left.type === NodeType.MemberExpression) {
    const memberExpr = expr.left as MemberExpression;
    const fieldName = memberExpr.property.name;

    const objectType = inferType(ctx, memberExpr.object);
    const structTypeIndex = getHeapTypeIndex(ctx, objectType);
    if (structTypeIndex === -1) {
      throw new Error(`Invalid object type for field assignment: ${fieldName}`);
    }

    let foundClass: ClassInfo | undefined;
    for (const info of ctx.classes.values()) {
      if (info.structTypeIndex === structTypeIndex) {
        foundClass = info;
        break;
      }
    }

    if (!foundClass) {
      throw new Error(`Class not found for object type ${structTypeIndex}`);
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
      const setterName = `set_${fieldName}`;
      const methodInfo = foundClass.methods.get(setterName);
      if (methodInfo) {
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

    const tempVal = ctx.declareLocal('$$temp_field_set', fieldInfo.type);
    body.push(Opcode.local_tee);
    body.push(...WasmModule.encodeSignedLEB128(tempVal));

    body.push(0xfb, GcOpcode.struct_set);
    body.push(...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(tempVal));
  } else if (expr.left.type === NodeType.Identifier) {
    generateExpression(ctx, expr.value, body);
    const local = ctx.getLocal(expr.left.name);
    if (!local) throw new Error(`Unknown identifier: ${expr.left.name}`);
    const index = local.index;
    // Assignment is an expression that evaluates to the assigned value.
    // So we use local.tee to set the local and keep the value on the stack.
    body.push(Opcode.local_tee);
    body.push(...WasmModule.encodeSignedLEB128(index));
  } else {
    throw new Error('Invalid assignment target');
  }
}

function generateBinaryExpression(
  ctx: CodegenContext,
  expr: BinaryExpression,
  body: number[],
) {
  const leftType = inferType(ctx, expr.left);
  const rightType = inferType(ctx, expr.right);

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
      body.push(Opcode.i32_div_s);
      break;
    case '==':
      body.push(Opcode.i32_eq);
      break;
    case '!=':
      body.push(Opcode.i32_ne);
      break;
    case '<':
      body.push(Opcode.i32_lt_s);
      break;
    case '<=':
      body.push(Opcode.i32_le_s);
      break;
    case '>':
      body.push(Opcode.i32_gt_s);
      break;
    case '>=':
      body.push(Opcode.i32_ge_s);
      break;
  }
}

function generateNumberLiteral(
  ctx: CodegenContext,
  expr: NumberLiteral,
  body: number[],
) {
  if (Number.isInteger(expr.value)) {
    body.push(Opcode.i32_const);
    body.push(...WasmModule.encodeSignedLEB128(expr.value));
  } else {
    body.push(Opcode.f32_const);
    body.push(...WasmModule.encodeF32(expr.value));
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
  const local = ctx.getLocal(expr.name);
  if (local) {
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(local.index));
    return;
  }
  const global = ctx.getGlobal(expr.name);
  if (global) {
    body.push(Opcode.global_get);
    body.push(...WasmModule.encodeSignedLEB128(global.index));
    return;
  }
  throw new Error(`Unknown identifier: ${expr.name}`);
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

  // Push vtable (null for now)
  body.push(Opcode.ref_null, HeapType.eq);

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

  // struct.new $stringType
  // Stack: [arrayRef] -> [arrayRef, length] -> [stringRef]
  body.push(
    Opcode.i32_const,
    ...WasmModule.encodeSignedLEB128(expr.value.length),
  );

  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
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
      [ValType.ref_null, ctx.byteArrayTypeIndex], // newBytes (local 3)
    ];
    const body: number[] = [];

    // Params: s1 (0), s2 (1)
    // Locals: len1 (2), len2 (3), newLen (4), newBytes (5)

    // len1 = s1.length
    body.push(Opcode.local_get, 0);
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(2)); // length
    body.push(Opcode.local_set, 2);

    // len2 = s2.length
    body.push(Opcode.local_get, 1);
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(2)); // length
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

    // array.copy(dest=newBytes, destOffset=0, src=s1.bytes, srcOffset=0, len=len1)
    body.push(Opcode.local_get, 5); // dest
    body.push(Opcode.i32_const, 0); // destOffset

    // src = s1.bytes
    body.push(Opcode.local_get, 0);
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(1)); // bytes

    body.push(Opcode.i32_const, 0); // srcOffset
    body.push(Opcode.local_get, 2); // len
    body.push(0xfb, GcOpcode.array_copy);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // array.copy(dest=newBytes, destOffset=len1, src=s2.bytes, srcOffset=0, len=len2)
    body.push(Opcode.local_get, 5); // dest
    body.push(Opcode.local_get, 2); // destOffset

    // src = s2.bytes
    body.push(Opcode.local_get, 1);
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(1)); // bytes

    body.push(Opcode.i32_const, 0); // srcOffset
    body.push(Opcode.local_get, 3); // len
    body.push(0xfb, GcOpcode.array_copy);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // return new String(newBytes, newLen)
    body.push(Opcode.ref_null, HeapType.eq); // vtable
    body.push(Opcode.local_get, 5);
    body.push(Opcode.ref_as_non_null);
    body.push(Opcode.local_get, 4);
    body.push(0xfb, GcOpcode.struct_new);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));

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
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(2)); // length
    body.push(Opcode.local_set, 2);

    // len2 = s2.length
    body.push(Opcode.local_get, 1);
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(2)); // length
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

    // if s1.bytes[i] != s2.bytes[i] return 0

    // s1.bytes
    body.push(Opcode.local_get, 0);
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(1)); // bytes

    body.push(Opcode.local_get, 4); // i
    body.push(0xfb, GcOpcode.array_get_u);
    body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

    // s2.bytes
    body.push(Opcode.local_get, 1);
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(1)); // bytes

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

    // ref.cast $String
    body.push(0xfb, GcOpcode.ref_cast);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));

    // struct.get $String 1 (bytes field)
    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(1)); // bytes field index

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

function generateRecordLiteral(
  ctx: CodegenContext,
  expr: RecordLiteral,
  body: number[],
) {
  // 1. Infer types of all fields
  const fields = expr.properties.map((p) => ({
    name: p.name.name,
    type: inferType(ctx, p.value),
    value: p.value,
  }));

  // 2. Get struct type index
  const typeIndex = ctx.getRecordTypeIndex(
    fields.map((f) => ({name: f.name, type: f.type})),
  );

  // 3. Sort fields to match struct layout
  fields.sort((a, b) => a.name.localeCompare(b.name));

  // 4. Generate values in order
  for (const field of fields) {
    generateExpression(ctx, field.value, body);
  }

  // 5. struct.new
  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(typeIndex));
}

function generateTupleLiteral(
  ctx: CodegenContext,
  expr: TupleLiteral,
  body: number[],
) {
  // 1. Infer types of all elements
  const types = expr.elements.map((e) => inferType(ctx, e));

  // 2. Get struct type index
  const typeIndex = ctx.getTupleTypeIndex(types);

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
  const captures = analyzeCaptures(expr);
  const captureList: {name: string; type: number[]}[] = [];

  for (const name of Array.from(captures).sort()) {
    const local = ctx.getLocal(name);
    if (local) {
      captureList.push({name, type: local.type});
    }
    // Globals don't need to be captured
  }

  // 2. Create Context Struct Type
  let contextStructTypeIndex = -1;
  if (captureList.length > 0) {
    const fields = captureList.map((c) => ({
      type: c.type,
      mutable: false, // Capture by value (immutable context)
    }));
    contextStructTypeIndex = ctx.module.addStructType(fields);
  }

  // 3. Determine Signature
  const typeContext = new Map(ctx.currentTypeContext);
  if (expr.typeParameters) {
    for (const param of expr.typeParameters) {
      typeContext.set(param.name, {
        type: NodeType.TypeAnnotation,
        name: 'anyref',
      } as any);
    }
  }

  // Temporarily override context for signature determination
  const oldTypeContext = ctx.currentTypeContext;
  ctx.currentTypeContext = typeContext;

  const paramTypes = expr.params.map((p) => mapType(ctx, p.typeAnnotation));
  let returnType: number[];
  if (expr.returnType) {
    returnType = mapType(ctx, expr.returnType);
  } else {
    // Simple inference: if body is expression, infer type.
    // If block, assume void for now or implement block inference.
    if (expr.body.type !== NodeType.BlockStatement) {
      // We can't easily infer here without generating the body.
      // But we need the signature BEFORE generating the body.
      // This is a circular dependency if we rely on inference.
      // For now, default to i32 if not specified? Or error?
      // Let's assume i32 for expression bodies if not annotated, to match simple lambdas.
      returnType = [ValType.i32];
    } else {
      // Setup temporary scope for inference
      ctx.pushScope();
      const oldNextLocalIndex = ctx.nextLocalIndex;
      ctx.nextLocalIndex = 0;

      expr.params.forEach((p, i) => {
        ctx.defineLocal(p.name.name, ctx.nextLocalIndex++, paramTypes[i]);
      });

      returnType = inferReturnTypeFromBlock(ctx, expr.body as BlockStatement);

      ctx.popScope();
      ctx.nextLocalIndex = oldNextLocalIndex;
    }
  }

  ctx.currentTypeContext = oldTypeContext;

  //  // 4. Generate Implementation Function
  const implParams = [[ValType.eqref], ...paramTypes];
  const implResults = returnType.length > 0 ? [returnType] : [];
  const implTypeIndex = ctx.module.addType(implParams, implResults);
  const implFuncIndex = ctx.module.addFunction(implTypeIndex);
  ctx.module.declareFunction(implFuncIndex);

  ctx.bodyGenerators.push(() => {
    const oldTypeContext = ctx.currentTypeContext;
    ctx.currentTypeContext = typeContext;

    const funcBody: number[] = [];

    // Setup Scope
    ctx.scopes = [new Map()];
    ctx.extraLocals = [];
    ctx.nextLocalIndex = 0;

    // Param 0: Context (eqref)
    const ctxLocalIndex = ctx.nextLocalIndex++;
    ctx.defineLocal('$$ctx', ctxLocalIndex, [ValType.eqref]);

    // Params 1..N: Arguments
    expr.params.forEach((p, i) => {
      ctx.defineLocal(p.name.name, ctx.nextLocalIndex++, paramTypes[i]);
    });

    // Unpack Context
    if (captureList.length > 0) {
      // Cast context
      const typedCtxLocal = ctx.nextLocalIndex++;
      ctx.extraLocals.push([
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
        // We define a new local for the captured variable
        // and initialize it from the struct.
        const localIndex = ctx.nextLocalIndex++;
        ctx.defineLocal(c.name, localIndex, c.type);
        ctx.extraLocals.push(c.type);

        funcBody.push(Opcode.local_get, typedCtxLocal);
        funcBody.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(contextStructTypeIndex),
          ...WasmModule.encodeSignedLEB128(i),
        );
        funcBody.push(Opcode.local_set, localIndex);
      });
    }

    // Generate Body
    if (expr.body.type === NodeType.BlockStatement) {
      generateBlockStatement(ctx, expr.body as BlockStatement, funcBody);
    } else {
      generateExpression(ctx, expr.body as Expression, funcBody);
    }
    funcBody.push(Opcode.end);

    ctx.module.addCode(implFuncIndex, ctx.extraLocals, funcBody);

    ctx.currentTypeContext = oldTypeContext;
  });

  // 5. Instantiate Closure
  // Stack: [FuncRef, Context] -> StructNew

  // Push Func Ref
  body.push(Opcode.ref_func);
  body.push(...WasmModule.encodeSignedLEB128(implFuncIndex));

  // Push Context
  if (captureList.length > 0) {
    // Push captured values
    for (const c of captureList) {
      const local = ctx.getLocal(c.name);
      if (!local) throw new Error(`Captured variable ${c.name} not found`);
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(local.index));
    }
    // Create Context Struct
    body.push(0xfb, GcOpcode.struct_new);
    body.push(...WasmModule.encodeSignedLEB128(contextStructTypeIndex));
  } else {
    // Null context
    body.push(Opcode.ref_null, HeapType.eq);
  }

  // Create Closure Struct
  // We need the Closure Struct Type Index
  const closureTypeIndex = ctx.getClosureTypeIndex(paramTypes, returnType);

  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(closureTypeIndex));
}

function generateIndirectCall(
  ctx: CodegenContext,
  expr: CallExpression,
  body: number[],
) {
  // 1. Evaluate Callee
  generateExpression(ctx, expr.callee, body);

  // Stack: [ClosureRef]
  const calleeType = inferType(ctx, expr.callee);
  const closureStructIndex = decodeTypeIndex(calleeType);

  if (!ctx.closureStructs.has(closureStructIndex)) {
    throw new Error(`Type ${closureStructIndex} is not a closure`);
  }
  const {funcTypeIndex} = ctx.closureStructs.get(closureStructIndex)!;

  const tempClosure = ctx.declareLocal('$$temp_closure', calleeType);
  body.push(Opcode.local_tee, ...WasmModule.encodeSignedLEB128(tempClosure));

  // 2. Push Context (Field 1)
  body.push(
    0xfb,
    GcOpcode.struct_get,
    ...WasmModule.encodeSignedLEB128(closureStructIndex),
    ...WasmModule.encodeSignedLEB128(1), // Field 1 is ctx
  );

  // 3. Evaluate Arguments
  for (const arg of expr.arguments) {
    generateExpression(ctx, arg, body);
  }

  // 4. Push Func Ref (Field 0)
  body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(tempClosure));
  body.push(
    0xfb,
    GcOpcode.struct_get,
    ...WasmModule.encodeSignedLEB128(closureStructIndex),
    ...WasmModule.encodeSignedLEB128(0), // Field 0 is func
  );

  // 5. Call Ref
  body.push(Opcode.call_ref, ...WasmModule.encodeSignedLEB128(funcTypeIndex));
}

/**
 * Generate code for an untagged template literal.
 * This concatenates all the string parts and interpolated values into a single string.
 */
function generateTemplateLiteral(
  ctx: CodegenContext,
  expr: TemplateLiteral,
  body: number[],
) {
  // Special case: no expressions, just return the string
  if (expr.expressions.length === 0) {
    // Generate a simple string literal
    const value = expr.quasis[0].value.cooked;
    generateStringLiteralValue(ctx, value, body);
    return;
  }

  // Build the string by concatenating parts and expressions
  // Start with the first quasi
  generateStringLiteralValue(ctx, expr.quasis[0].value.cooked, body);

  for (let i = 0; i < expr.expressions.length; i++) {
    // Generate the expression
    // For now, we assume expressions produce strings or can be converted to strings
    // TODO: Implement proper toString conversion for non-string expressions
    const subExpr = expr.expressions[i];

    // Generate the expression (we assume it's a string or needs string concatenation)
    // Proper type coercion to string should be implemented when we have a toString method
    generateExpression(ctx, subExpr, body);

    // Concatenate with previous result
    generateStringConcat(ctx, body);

    // Concatenate with the next quasi (if non-empty)
    const nextQuasi = expr.quasis[i + 1].value.cooked;
    if (nextQuasi.length > 0) {
      generateStringLiteralValue(ctx, nextQuasi, body);
      generateStringConcat(ctx, body);
    }
  }
}

/**
 * Helper to generate a string literal from a raw value.
 * Used by template literals to generate individual string parts.
 */
function generateStringLiteralValue(
  ctx: CodegenContext,
  value: string,
  body: number[],
) {
  // Empty string optimization
  if (value.length === 0) {
    generateEmptyString(ctx, body);
    return;
  }

  let dataIndex: number;
  if (ctx.stringLiterals.has(value)) {
    dataIndex = ctx.stringLiterals.get(value)!;
  } else {
    const bytes = new TextEncoder().encode(value);
    dataIndex = ctx.module.addData(bytes);
    ctx.stringLiterals.set(value, dataIndex);
  }

  // Push vtable (null for now)
  body.push(Opcode.ref_null, HeapType.eq);

  // array.new_data $byteArrayType $dataIndex
  body.push(Opcode.i32_const, 0); // offset
  body.push(Opcode.i32_const, ...WasmModule.encodeSignedLEB128(value.length));

  body.push(0xfb, GcOpcode.array_new_data);
  body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(dataIndex));

  // struct.new $stringType
  body.push(Opcode.i32_const, ...WasmModule.encodeSignedLEB128(value.length));

  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
}

/**
 * Generate an empty string.
 */
function generateEmptyString(ctx: CodegenContext, body: number[]) {
  // Push vtable (null for now)
  body.push(Opcode.ref_null, HeapType.eq);

  // Create empty byte array
  body.push(Opcode.i32_const, 0); // length 0
  body.push(0xfb, GcOpcode.array_new_default);
  body.push(...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex));

  // struct.new $stringType with length 0
  body.push(Opcode.i32_const, 0);

  body.push(0xfb, GcOpcode.struct_new);
  body.push(...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex));
}

/**
 * Generate code for a tagged template expression.
 * This creates the strings array and values array, then calls the tag function.
 */
function generateTaggedTemplateExpression(
  ctx: CodegenContext,
  expr: TaggedTemplateExpression,
  body: number[],
) {
  // For tagged templates, we need to:
  // 1. Generate the tag function reference
  // 2. Create a TemplateStringsArray (an array of strings with a 'raw' property)
  // 3. Create an array of interpolated values
  // 4. Call the tag function with these arguments

  // For now, implement a simpler version that:
  // - Gets the tag function (for simple identifier tags)
  // - Creates an array of cooked strings
  // - Creates an array of values
  // - Calls the tag function

  const quasis = expr.quasi.quasis;
  const expressions = expr.quasi.expressions;

  // Get or create the array type for strings
  const stringArrayTypeIndex = getArrayTypeIndex(ctx, [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
  ]);

  // Generate the strings array
  // Push each string element
  for (const quasi of quasis) {
    generateStringLiteralValue(ctx, quasi.value.cooked, body);
  }

  // array.new_fixed with the number of strings
  body.push(0xfb, GcOpcode.array_new_fixed);
  body.push(...WasmModule.encodeSignedLEB128(stringArrayTypeIndex));
  body.push(...WasmModule.encodeSignedLEB128(quasis.length));

  // Generate the values array
  if (expressions.length > 0) {
    // Infer the value type from the first expression
    // For now, assume all values are the same type
    const firstExprType = inferType(ctx, expressions[0]);
    const valuesArrayTypeIndex = getArrayTypeIndex(ctx, firstExprType);

    // Push each value element
    for (const subExpr of expressions) {
      generateExpression(ctx, subExpr, body);
    }

    // array.new_fixed with the number of values
    body.push(0xfb, GcOpcode.array_new_fixed);
    body.push(...WasmModule.encodeSignedLEB128(valuesArrayTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(expressions.length));
  } else {
    // Create an empty array of i32 (dummy values array)
    const emptyArrayTypeIndex = getArrayTypeIndex(ctx, [ValType.i32]);
    body.push(Opcode.i32_const, 0);
    body.push(0xfb, GcOpcode.array_new_default);
    body.push(...WasmModule.encodeSignedLEB128(emptyArrayTypeIndex));
  }

  // Now call the tag function with (strings, values) already on the stack
  // Handle simple identifier tags as direct function calls
  if (expr.tag.type === NodeType.Identifier) {
    const tagName = (expr.tag as Identifier).name;
    const funcIndex = ctx.functions.get(tagName);
    if (funcIndex !== undefined) {
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(funcIndex));
      return;
    }
  }

  // For complex tag expressions (member expressions, closures, etc.),
  // we need a more sophisticated calling convention
  // TODO: Implement proper closure/method call support for tag expressions
  throw new Error(
    'Complex tag expressions in tagged templates are not yet supported. Use a simple identifier as the tag.',
  );
}

function typesAreEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
