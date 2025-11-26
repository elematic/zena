import {
  NodeType,
  type ArrayLiteral,
  type AssignmentExpression,
  type BinaryExpression,
  type BooleanLiteral,
  type CallExpression,
  type Expression,
  type Identifier,
  type IndexExpression,
  type MemberExpression,
  type MethodDefinition,
  type NewExpression,
  type NullLiteral,
  type NumberLiteral,
  type StringLiteral,
  type ThisExpression,
  type TypeAnnotation,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {GcOpcode, HeapType, Opcode, ValType} from '../wasm.js';
import {
  decodeTypeIndex,
  getClassFromTypeIndex,
  getInterfaceFromTypeIndex,
  getTypeKey,
  mapType,
} from './classes.js';
import type {CodegenContext} from './context.js';
import {instantiateGenericFunction} from './functions.js';
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

export function inferType(ctx: CodegenContext, expr: Expression): number[] {
  switch (expr.type) {
    case NodeType.AssignmentExpression: {
      const assignExpr = expr as AssignmentExpression;
      return inferType(ctx, assignExpr.value);
    }
    case NodeType.Identifier: {
      const name = (expr as Identifier).name;
      const local = ctx.getLocal(name);
      if (local) return local.type;
      // TODO: Check globals
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

      let foundClass: ClassInfo | undefined;
      for (const info of ctx.classes.values()) {
        if (info.structTypeIndex === structTypeIndex) {
          foundClass = info;
          break;
        }
      }

      if (!foundClass) return [ValType.i32];

      const fieldName = memberExpr.property.name;
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
      // Map WASM type back to TypeAnnotation if possible
      // This is tricky because we only have WASM types here.
      // We need a way to map WASM type back to a name or structure.
      // For now, let's assume we can only infer basic types or classes we know.

      let typeName = 'i32';
      if (argType.length === 1 && argType[0] === ValType.i32) typeName = 'i32';
      else if (argType.length === 1 && argType[0] === ValType.f32)
        typeName = 'f32';
      else if (argType.length > 1 && argType[0] === ValType.ref_null) {
        const typeIndex = decodeTypeIndex(argType);
        if (typeIndex === ctx.stringTypeIndex) typeName = 'string';
        else {
          const classInfo = getClassFromTypeIndex(ctx, typeIndex);
          if (classInfo) {
            // Find class name
            for (const [name, info] of ctx.classes.entries()) {
              if (info === classInfo) {
                typeName = name;
                break;
              }
            }
          }
        }
      }

      inferred.set(paramType.name, {
        type: NodeType.TypeAnnotation,
        name: typeName,
      } as TypeAnnotation);
    }
  }

  return typeParams.map((tp) => {
    if (inferred.has(tp.name)) return inferred.get(tp.name)!;
    if (tp.default) return tp.default;
    throw new Error(`Cannot infer type argument for ${tp.name}`);
  });
}

function getHeapTypeIndex(ctx: CodegenContext, type: number[]): number {
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
    arrayTypeIndex = getArrayTypeIndex(ctx, [ValType.i32]);
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
    throw new Error(`Class not found for object type ${structTypeIndex}`);
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
      // We need to call the method via vtable dispatch (virtual by default)

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
        ...WasmModule.encodeUnsignedLEB128(methodInfo.typeIndex),
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
    // 1. Generate arguments
    for (const arg of expr.arguments) {
      generateExpression(ctx, arg, body);
    }

    // 2. Resolve function
    if (expr.callee.type === NodeType.Identifier) {
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

      const funcIndex = ctx.functions.get(name);
      if (funcIndex !== undefined) {
        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(funcIndex));
      } else {
        throw new Error(`Function '${name}' not found.`);
      }
    } else {
      throw new Error('Indirect calls not supported yet.');
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
    let arrayTypeIndex = -1;
    if (indexExpr.object.type === NodeType.Identifier) {
      const localInfo = ctx.getLocal((indexExpr.object as Identifier).name);
      if (localInfo && localInfo.type.length > 1) {
        arrayTypeIndex = localInfo.type[1];
      }
    }
    if (arrayTypeIndex === -1) {
      arrayTypeIndex = getArrayTypeIndex(ctx, [ValType.i32]);
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
  if (!local) throw new Error(`Unknown identifier: ${expr.name}`);
  body.push(Opcode.local_get);
  body.push(...WasmModule.encodeSignedLEB128(local.index));
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
