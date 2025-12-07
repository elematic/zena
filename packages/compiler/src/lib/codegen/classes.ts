import {
  NodeType,
  type ClassDeclaration,
  type FunctionTypeAnnotation,
  type InterfaceDeclaration,
  type MethodDefinition,
  type MixinDeclaration,
  type RecordTypeAnnotation,
  type TupleTypeAnnotation,
  type TypeAnnotation,
} from '../ast.js';
import {
  TypeKind,
  type Type,
  type ClassType,
  type NumberType,
  type InterfaceType,
  type FixedArrayType,
  type RecordType,
  type TupleType,
  type FunctionType,
  type TypeParameterType,
  type TypeAliasType,
} from '../types.js';
import {WasmModule} from '../emitter.js';
import {ExportDesc, GcOpcode, HeapType, Opcode, ValType} from '../wasm.js';
import type {CodegenContext} from './context.js';
import {
  generateExpression,
  getHeapTypeIndex,
  boxPrimitive,
  unboxPrimitive,
} from './expressions.js';
import {
  generateBlockStatement,
  generateFunctionStatement,
} from './statements.js';
import type {ClassInfo, InterfaceInfo} from './types.js';

export function registerInterface(
  ctx: CodegenContext,
  decl: InterfaceDeclaration,
) {
  if (ctx.interfaces.has(decl.name.name)) return;

  let parentInfo: InterfaceInfo | undefined;

  if (decl.extends && decl.extends.length > 0) {
    // Support single inheritance for now
    const ext = decl.extends[0];
    if (ext.type === NodeType.TypeAnnotation) {
      const parentName = ext.name;

      // Find parent decl
      const parentDecl = ctx.program.body.find(
        (s) =>
          s.type === NodeType.InterfaceDeclaration &&
          (s as InterfaceDeclaration).name.name === parentName,
      ) as InterfaceDeclaration | undefined;

      if (parentDecl) {
        registerInterface(ctx, parentDecl);
        parentInfo = ctx.interfaces.get(parentName);
      } else {
        // Parent decl not found
      }
    }
  }

  // 1. Create VTable Struct Type
  // (struct (field (ref (func (param any) ...))) ...)
  const vtableFields: {type: number[]; mutable: boolean}[] = [];
  const methodIndices = new Map<
    string,
    {index: number; typeIndex: number; returnType: number[]}
  >();
  const fieldIndices = new Map<
    string,
    {index: number; typeIndex: number; type: number[]}
  >();

  let methodIndex = 0;

  // If parent, copy indices and fields
  if (parentInfo) {
    const parentFields = new Array(
      parentInfo.methods.size + parentInfo.fields.size,
    );

    // Copy methods
    for (const [name, info] of parentInfo.methods) {
      methodIndices.set(name, info);
      methodIndex = Math.max(methodIndex, info.index + 1);
      parentFields[info.index] = {
        type: [ValType.ref, ...WasmModule.encodeSignedLEB128(info.typeIndex)],
        mutable: false,
      };
    }
    // Copy fields
    for (const [name, info] of parentInfo.fields) {
      fieldIndices.set(name, info);
      methodIndex = Math.max(methodIndex, info.index + 1);
      parentFields[info.index] = {
        type: [ValType.ref, ...WasmModule.encodeSignedLEB128(info.typeIndex)],
        mutable: false,
      };
    }

    vtableFields.push(...parentFields);
  }

  // Create type context for generics (erase to anyref)
  const context = new Map<string, TypeAnnotation>();
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      context.set(param.name, {
        type: NodeType.TypeAnnotation,
        name: 'anyref',
      });
    }
  }

  for (const member of decl.body) {
    if (member.type === NodeType.MethodSignature) {
      if (member.typeParameters && member.typeParameters.length > 0) {
        continue;
      }
      // Function type: (param any, ...params) -> result
      const params: number[][] = [[ValType.ref_null, ValType.anyref]]; // 'this' is (ref null any)
      for (const param of member.params) {
        params.push(mapType(ctx, param.typeAnnotation, context));
      }
      const results: number[][] = [];
      let returnType: number[] = [];
      if (member.returnType) {
        const mapped = mapType(ctx, member.returnType, context);
        if (mapped.length > 0) {
          results.push(mapped);
          returnType = mapped;
        }
      }

      const funcTypeIndex = ctx.module.addType(params, results);

      // Field in VTable: (ref funcType)
      vtableFields.push({
        type: [ValType.ref, ...WasmModule.encodeSignedLEB128(funcTypeIndex)],
        mutable: false, // VTables are immutable
      });

      methodIndices.set(member.name.name, {
        index: methodIndex++,
        typeIndex: funcTypeIndex,
        returnType,
      });
    } else if (member.type === NodeType.FieldDefinition) {
      // Field getter: (param any) -> Type
      const params: number[][] = [[ValType.ref_null, ValType.anyref]];
      const results: number[][] = [];
      let fieldType: number[] = [];
      const mapped = mapType(ctx, member.typeAnnotation, context);
      if (mapped.length > 0) {
        results.push(mapped);
        fieldType = mapped;
      }

      const funcTypeIndex = ctx.module.addType(params, results);

      // Field in VTable: (ref funcType)
      vtableFields.push({
        type: [ValType.ref, ...WasmModule.encodeSignedLEB128(funcTypeIndex)],
        mutable: false,
      });

      fieldIndices.set(member.name.name, {
        index: methodIndex++,
        typeIndex: funcTypeIndex,
        type: fieldType,
      });
    } else if (member.type === NodeType.AccessorSignature) {
      const propName = member.name.name;
      const propType = mapType(ctx, member.typeAnnotation, context);

      if (member.hasGetter) {
        const methodName = `get_${propName}`;

        // Function type: (param any) -> result
        const params: number[][] = [[ValType.ref_null, ValType.anyref]];
        const results: number[][] = [];
        if (propType.length > 0) {
          results.push(propType);
        }

        const funcTypeIndex = ctx.module.addType(params, results);

        // Field in VTable: (ref funcType)
        vtableFields.push({
          type: [ValType.ref, ...WasmModule.encodeSignedLEB128(funcTypeIndex)],
          mutable: false,
        });

        methodIndices.set(methodName, {
          index: methodIndex++,
          typeIndex: funcTypeIndex,
          returnType: propType,
        });
      }

      if (member.hasSetter) {
        const methodName = `set_${propName}`;

        // Function type: (param any, value) -> void
        const params: number[][] = [
          [ValType.ref_null, ValType.anyref],
          propType,
        ];
        const results: number[][] = [];

        const funcTypeIndex = ctx.module.addType(params, results);

        // Field in VTable: (ref funcType)
        vtableFields.push({
          type: [ValType.ref, ...WasmModule.encodeSignedLEB128(funcTypeIndex)],
          mutable: false,
        });

        methodIndices.set(methodName, {
          index: methodIndex++,
          typeIndex: funcTypeIndex,
          returnType: [],
        });
      }
    }
  }

  const vtableTypeIndex = ctx.module.addStructType(
    vtableFields,
    parentInfo?.vtableTypeIndex,
  );

  // 2. Create Interface Struct Type (Fat Pointer)
  // (struct (field (ref null any)) (field (ref vtable)))
  const interfaceFields = [
    {type: [ValType.ref_null, ValType.anyref], mutable: true}, // instance
    {
      type: [ValType.ref, ...WasmModule.encodeSignedLEB128(vtableTypeIndex)],
      mutable: true,
    }, // vtable
  ];
  const structTypeIndex = ctx.module.addStructType(interfaceFields);

  let parentName: string | undefined;
  if (parentInfo) {
    const ext = decl.extends![0];
    if (ext.type === NodeType.TypeAnnotation) {
      parentName = ext.name;
    }
  }

  ctx.interfaces.set(decl.name.name, {
    structTypeIndex,
    vtableTypeIndex,
    methods: methodIndices,
    fields: fieldIndices,
    parent: parentName,
  });
}

export function generateTrampoline(
  ctx: CodegenContext,
  classInfo: ClassInfo,
  methodName: string,
  typeIndex: number,
): number {
  const trampolineIndex = ctx.module.addFunction(typeIndex);

  // Save context state
  const prevScopes = ctx.scopes;
  const prevExtraLocals = ctx.extraLocals;
  const prevNextLocalIndex = ctx.nextLocalIndex;

  // Initialize new function context
  ctx.scopes = [new Map()];
  ctx.extraLocals = [];
  ctx.nextLocalIndex = 0;

  const body: number[] = [];

  // Register parameters
  const params = ctx.module.getFunctionTypeParams(typeIndex);
  // Param 0 is 'this' (anyref)
  ctx.defineLocal('this', 0, params[0]);
  ctx.nextLocalIndex++;

  for (let i = 1; i < params.length; i++) {
    ctx.defineLocal(`arg${i}`, i, params[i]);
    ctx.nextLocalIndex++;
  }

  const classMethod = classInfo.methods.get(methodName);
  if (!classMethod) {
    throw new Error(
      `Method ${methodName} not found in class ${classInfo.name} for trampoline generation`,
    );
  }

  let targetTypeIndex = classInfo.structTypeIndex;
  if (classInfo.isExtension && classInfo.onType) {
    targetTypeIndex = decodeTypeIndex(classInfo.onType);
  }

  // Cast 'this' to class type
  const castedThisLocal = ctx.declareLocal('castedThis', [
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(targetTypeIndex),
  ]);

  // local.set $castedThis (ref.cast $Task (local.get 0))
  body.push(Opcode.local_get, 0);
  body.push(
    0xfb,
    GcOpcode.ref_cast_null,
    ...WasmModule.encodeSignedLEB128(targetTypeIndex),
  );
  body.push(
    Opcode.local_set,
    ...WasmModule.encodeSignedLEB128(castedThisLocal),
  );

  // Call class method
  body.push(
    Opcode.local_get,
    ...WasmModule.encodeSignedLEB128(castedThisLocal),
  );

  const interfaceParams = ctx.module.getFunctionTypeParams(typeIndex);
  const interfaceResults = ctx.module.getFunctionTypeResults(typeIndex);

  for (let i = 1; i < classMethod.paramTypes.length; i++) {
    const paramIndex = i;
    const interfaceParamType = interfaceParams[i];
    const classParamType = classMethod.paramTypes[i];

    // Load argument
    body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(paramIndex));

    // Adapt if needed (unbox)
    if (
      interfaceParamType.length === 1 &&
      interfaceParamType[0] === ValType.anyref &&
      classParamType.length === 1 &&
      (classParamType[0] === ValType.i32 ||
        classParamType[0] === ValType.i64 ||
        classParamType[0] === ValType.f32 ||
        classParamType[0] === ValType.f64)
    ) {
      unboxPrimitive(ctx, classParamType, body);
    }
  }

  body.push(Opcode.call, ...WasmModule.encodeSignedLEB128(classMethod.index));

  // Handle return type adaptation (boxing)
  const classReturnType = classMethod.returnType;

  if (
    interfaceResults.length > 0 &&
    classReturnType.length > 0 &&
    interfaceResults[0].length === 1 &&
    interfaceResults[0][0] === ValType.anyref &&
    classReturnType.length === 1 &&
    (classReturnType[0] === ValType.i32 ||
      classReturnType[0] === ValType.i64 ||
      classReturnType[0] === ValType.f32 ||
      classReturnType[0] === ValType.f64)
  ) {
    boxPrimitive(ctx, classReturnType, body);
  }

  body.push(Opcode.end);

  ctx.module.addCode(trampolineIndex, ctx.extraLocals, body);

  // Restore context state
  ctx.scopes = prevScopes;
  ctx.extraLocals = prevExtraLocals;
  ctx.nextLocalIndex = prevNextLocalIndex;

  return trampolineIndex;
}

function generateFieldGetterTrampoline(
  ctx: CodegenContext,
  classInfo: ClassInfo,
  fieldName: string,
  typeIndex: number,
): number {
  const trampolineIndex = ctx.module.addFunction(typeIndex);
  const locals: number[][] = [];
  const body: number[] = [];

  let targetTypeIndex = classInfo.structTypeIndex;
  if (classInfo.isExtension && classInfo.onType) {
    targetTypeIndex = decodeTypeIndex(classInfo.onType);
  }

  // Param 0: this (anyref)
  // Cast to class type
  const castedThisLocal = 1;
  locals.push([
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(targetTypeIndex),
  ]);

  // Cast
  body.push(Opcode.local_get, 0);
  body.push(
    0xfb,
    GcOpcode.ref_cast_null,
    ...WasmModule.encodeSignedLEB128(targetTypeIndex),
  );
  body.push(
    Opcode.local_set,
    ...WasmModule.encodeSignedLEB128(castedThisLocal),
  );

  // Check if it's a field or a getter in the class
  const fieldInfo = classInfo.fields.get(fieldName);
  if (fieldInfo) {
    // It's a field
    body.push(
      Opcode.local_get,
      ...WasmModule.encodeSignedLEB128(castedThisLocal),
    );
    body.push(
      0xfb,
      GcOpcode.struct_get,
      ...WasmModule.encodeSignedLEB128(targetTypeIndex),
      ...WasmModule.encodeSignedLEB128(fieldInfo.index),
    );
  } else {
    // Check for getter
    const getterName = `get_${fieldName}`;
    const methodInfo = classInfo.methods.get(getterName);
    if (methodInfo) {
      // Call getter
      body.push(
        Opcode.local_get,
        ...WasmModule.encodeSignedLEB128(castedThisLocal),
      );
      body.push(
        Opcode.call,
        ...WasmModule.encodeSignedLEB128(methodInfo.index),
      );
    } else {
      throw new Error(
        `Class ${classInfo.name} does not implement field '${fieldName}' required by interface`,
      );
    }
  }

  body.push(Opcode.end);
  ctx.module.addCode(trampolineIndex, locals, body);
  return trampolineIndex;
}

export function generateInterfaceVTable(
  ctx: CodegenContext,
  classInfo: ClassInfo,
  decl: ClassDeclaration,
) {
  if (!decl.implements) return;

  if (!classInfo.implements) classInfo.implements = new Map();

  for (const impl of decl.implements) {
    if (impl.type !== NodeType.TypeAnnotation) {
      throw new Error('Interfaces cannot be union types');
    }
    const interfaceName = impl.name;
    const interfaceInfo = ctx.interfaces.get(interfaceName)!;

    const vtableSize = interfaceInfo.methods.size + interfaceInfo.fields.size;
    const vtableEntries: number[] = new Array(vtableSize);

    for (const [methodName, methodInfo] of interfaceInfo.methods) {
      const trampolineIndex = generateTrampoline(
        ctx,
        classInfo,
        methodName,
        methodInfo.typeIndex,
      );
      vtableEntries[methodInfo.index] = trampolineIndex;
    }

    for (const [fieldName, fieldInfo] of interfaceInfo.fields) {
      const trampolineIndex = generateFieldGetterTrampoline(
        ctx,
        classInfo,
        fieldName,
        fieldInfo.typeIndex,
      );
      vtableEntries[fieldInfo.index] = trampolineIndex;
    }

    const initExpr: number[] = [];
    for (const funcIndex of vtableEntries) {
      initExpr.push(
        Opcode.ref_func,
        ...WasmModule.encodeSignedLEB128(funcIndex),
      );
    }
    initExpr.push(
      0xfb,
      GcOpcode.struct_new,
      ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
    );

    const globalIndex = ctx.module.addGlobal(
      [
        ValType.ref,
        ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
      ],
      false,
      initExpr,
    );

    classInfo.implements.set(interfaceName, {vtableGlobalIndex: globalIndex});
  }
}

export function getClassFromTypeIndex(
  ctx: CodegenContext,
  typeIndex: number,
): ClassInfo | undefined {
  for (const info of ctx.classes.values()) {
    if (info.structTypeIndex === typeIndex) {
      return info;
    }
    // Check extensions
    if (info.isExtension && info.onType) {
      const onTypeIndex = decodeTypeIndex(info.onType);
      if (onTypeIndex === typeIndex) {
        return info;
      }
    }
  }
  return undefined;
}

export function getInterfaceFromTypeIndex(
  ctx: CodegenContext,
  index: number,
): InterfaceInfo | undefined {
  for (const info of ctx.interfaces.values()) {
    if (info.structTypeIndex === index) return info;
  }
  return undefined;
}

export function decodeTypeIndex(type: number[]): number {
  if (type.length < 2) return -1;
  let typeIndex = 0;
  let shift = 0;
  for (let i = 1; i < type.length; i++) {
    const byte = type[i];
    typeIndex |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return typeIndex;
}

export function registerClassStruct(
  ctx: CodegenContext,
  decl: ClassDeclaration,
) {
  if (decl.typeParameters && decl.typeParameters.length > 0) {
    ctx.genericClasses.set(decl.name.name, decl);
    return;
  }

  // Handle extension classes (e.g. FixedArray extends array<T>)
  if (decl.isExtension && decl.onType) {
    const onType = mapType(ctx, decl.onType);
    // console.log(
    //   `registerClassStruct: Extension ${decl.name.name} onType=${onType.join(',')}`,
    // );

    // Create a dummy struct type for extensions so that we have a valid type index
    // This is needed because some parts of the compiler might try to reference the class type
    const structTypeIndex = ctx.module.addStructType([]);

    ctx.classes.set(decl.name.name, {
      name: decl.name.name,
      structTypeIndex,
      fields: new Map(),
      methods: new Map(),
      isExtension: true,
      onType,
    });
    return;
  }

  const fields = new Map<
    string,
    {index: number; type: number[]; intrinsic?: string}
  >();
  const fieldTypes: {type: number[]; mutable: boolean}[] = [];
  let fieldIndex = 0;

  let superTypeIndex: number | undefined;
  const methods = new Map<
    string,
    {
      index: number;
      returnType: number[];
      typeIndex: number;
      paramTypes: number[][];
      isFinal?: boolean;
      intrinsic?: string;
    }
  >();
  const vtable: string[] = [];

  let currentSuperClassInfo: ClassInfo | undefined;
  if (decl.superClass) {
    currentSuperClassInfo = ctx.classes.get(decl.superClass.name);
    if (!currentSuperClassInfo) {
      throw new Error(`Unknown superclass ${decl.superClass.name}`);
    }
  }

  if (decl.mixins && decl.mixins.length > 0) {
    for (const mixinId of decl.mixins) {
      const mixinDecl = ctx.mixins.get(mixinId.name);
      if (!mixinDecl) {
        throw new Error(`Unknown mixin ${mixinId.name}`);
      }
      currentSuperClassInfo = applyMixin(ctx, currentSuperClassInfo, mixinDecl);
    }
  }

  if (currentSuperClassInfo) {
    superTypeIndex = currentSuperClassInfo.structTypeIndex;

    // Inherit fields
    const sortedSuperFields = Array.from(
      currentSuperClassInfo.fields.entries(),
    ).sort((a, b) => a[1].index - b[1].index);

    for (const [name, info] of sortedSuperFields) {
      fields.set(name, {index: fieldIndex++, type: info.type});
      fieldTypes.push({type: info.type, mutable: true});
    }
  } else {
    // Root class: Add vtable field
    fields.set('__vtable', {index: fieldIndex++, type: [ValType.eqref]});
    fieldTypes.push({type: [ValType.eqref], mutable: true});
  }

  // Add unique brand field to ensure nominal typing
  const brandId = ctx.classes.size + 1;
  const brandTypeIndex = generateBrandType(ctx, brandId);
  const brandFieldName = `__brand_${decl.name.name}`;
  fields.set(brandFieldName, {
    index: fieldIndex++,
    type: [ValType.ref_null, ...WasmModule.encodeSignedLEB128(brandTypeIndex)],
  });
  fieldTypes.push({
    type: [ValType.ref_null, ...WasmModule.encodeSignedLEB128(brandTypeIndex)],
    mutable: true,
  });

  for (const member of decl.body) {
    if (member.type === NodeType.FieldDefinition) {
      const wasmType = mapType(ctx, member.typeAnnotation);
      const fieldName = manglePrivateName(decl.name.name, member.name.name);

      if (!fields.has(fieldName)) {
        let intrinsic: string | undefined;
        if (member.decorators) {
          const intrinsicDecorator = member.decorators.find(
            (d) => d.name === 'intrinsic',
          );
          if (intrinsicDecorator && intrinsicDecorator.args.length === 1) {
            intrinsic = intrinsicDecorator.args[0].value;
          }
        }

        fields.set(fieldName, {index: fieldIndex++, type: wasmType, intrinsic});
        fieldTypes.push({type: wasmType, mutable: true});
      }
    }
  }

  // Special handling for String class: reuse pre-allocated type index
  // The String type is created early in CodegenContext to allow declared
  // functions with string parameters to work correctly.
  let structTypeIndex: number;
  const isStringClass =
    !!ctx.wellKnownTypes.String &&
    decl.name.name === ctx.wellKnownTypes.String.name.name;

  if (isStringClass && ctx.stringTypeIndex >= 0) {
    // Reuse the pre-allocated String type index
    structTypeIndex = ctx.stringTypeIndex;
  } else {
    structTypeIndex = ctx.module.addStructType(fieldTypes, superTypeIndex);
    if (isStringClass) {
      ctx.stringTypeIndex = structTypeIndex;
    }
  }

  let onType: number[] | undefined;
  if (decl.isExtension && decl.onType) {
    onType = mapType(ctx, decl.onType);
  }

  const classInfo: ClassInfo = {
    name: decl.name.name,
    structTypeIndex,
    superClass: currentSuperClassInfo?.name,
    fields,
    methods,
    vtable,
    isFinal: decl.isFinal,
    isExtension: decl.isExtension,
    onType,
  };
  ctx.classes.set(decl.name.name, classInfo);
}

export function registerClassMethods(
  ctx: CodegenContext,
  decl: ClassDeclaration,
) {
  if (decl.typeParameters && decl.typeParameters.length > 0) {
    return;
  }

  const classInfo = ctx.classes.get(decl.name.name);
  if (!classInfo) throw new Error(`Class ${decl.name.name} not found`);

  // Ensure vtable exists if we are going to use it
  if (!classInfo.vtable) {
    classInfo.vtable = [];
  }
  const vtable = classInfo.vtable;
  const methods = classInfo.methods;
  const structTypeIndex = classInfo.structTypeIndex;

  let currentSuperClassInfo: ClassInfo | undefined;
  if (classInfo.superClass) {
    currentSuperClassInfo = ctx.classes.get(classInfo.superClass);
  } else if (decl.superClass) {
    currentSuperClassInfo = ctx.classes.get(decl.superClass.name);
  }

  // Inherit methods and vtable from superclass
  if (currentSuperClassInfo) {
    if (currentSuperClassInfo.vtable) {
      vtable.push(...currentSuperClassInfo.vtable);
    }
    for (const [name, info] of currentSuperClassInfo.methods) {
      methods.set(name, info);
    }
  }

  // Register methods
  const members = [...decl.body];
  // ... (rest of the function)

  const hasConstructor = members.some(
    (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
  );
  if (!hasConstructor && !classInfo.isExtension) {
    const bodyStmts: any[] = [];
    if (currentSuperClassInfo) {
      bodyStmts.push({
        type: NodeType.ExpressionStatement,
        expression: {
          type: NodeType.CallExpression,
          callee: {type: NodeType.SuperExpression},
          arguments: [],
        },
      });
    }
    members.push({
      type: NodeType.MethodDefinition,
      name: {type: NodeType.Identifier, name: '#new'},
      params: [],
      body: {type: NodeType.BlockStatement, body: bodyStmts},
      isFinal: false,
      isAbstract: false,
      isStatic: false,
      isDeclare: false,
    } as MethodDefinition);
  }

  for (const member of members) {
    if (member.type === NodeType.MethodDefinition) {
      if (member.typeParameters && member.typeParameters.length > 0) {
        // Store generic method definition for later instantiation
        const key = `${decl.name.name}.${member.name.name}`;
        ctx.genericMethods.set(key, member);
        continue; // Skip generating code for generic method definition
      }

      const methodName = member.name.name;

      let intrinsic: string | undefined;
      if (member.decorators) {
        const intrinsicDecorator = member.decorators.find(
          (d) => d.name === 'intrinsic',
        );
        if (intrinsicDecorator && intrinsicDecorator.args.length === 1) {
          intrinsic = intrinsicDecorator.args[0].value;
        }
      }

      if (
        methodName !== '#new' &&
        !methodName.startsWith('#') &&
        !intrinsic &&
        !vtable.includes(methodName) &&
        !member.isStatic
      ) {
        vtable.push(methodName);
      }

      let thisType: number[];
      if (classInfo.isExtension && classInfo.onType) {
        thisType = classInfo.onType;
      } else {
        thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];
      }

      if (currentSuperClassInfo) {
        if (
          methodName !== '#new' &&
          currentSuperClassInfo.methods.has(methodName)
        ) {
          thisType =
            currentSuperClassInfo.methods.get(methodName)!.paramTypes[0];
        }
      }

      const params: number[][] = [];
      if (
        !member.isStatic &&
        !(classInfo.isExtension && methodName === '#new')
      ) {
        params.push(thisType);
      }
      for (const param of member.params) {
        const mapped = mapType(ctx, param.typeAnnotation);
        params.push(mapped);
      }

      let results: number[][] = [];
      if (methodName === '#new') {
        if (classInfo.isExtension && classInfo.onType) {
          results = [classInfo.onType];
        } else if (member.isStatic && member.returnType) {
          const mapped = mapType(ctx, member.returnType);
          if (mapped.length > 0) results = [mapped];
        } else {
          results = [];
        }
      } else if (member.returnType) {
        const mapped = mapType(ctx, member.returnType);
        if (mapped.length > 0) results = [mapped];
      } else {
        results = [];
      }

      let typeIndex: number;
      let isOverride = false;
      if (currentSuperClassInfo) {
        if (
          methodName !== '#new' &&
          currentSuperClassInfo.methods.has(methodName)
        ) {
          typeIndex = currentSuperClassInfo.methods.get(methodName)!.typeIndex;
          isOverride = true;
        }
      }

      if (!isOverride) {
        typeIndex = ctx.module.addType(params, results);
      }

      let funcIndex = -1;
      if (!intrinsic && !member.isDeclare) {
        funcIndex = ctx.module.addFunction(typeIndex!);
      }

      const returnType = results.length > 0 ? results[0] : [];
      methods.set(methodName, {
        index: funcIndex,
        returnType,
        typeIndex: typeIndex!,
        paramTypes: params,
        isFinal: member.isFinal,
        intrinsic,
      });
    } else if (member.type === NodeType.AccessorDeclaration) {
      const propName = member.name.name;
      const propType = mapType(ctx, member.typeAnnotation);

      // Getter
      if (member.getter) {
        const methodName = `get_${propName}`;
        if (!vtable.includes(methodName)) {
          vtable.push(methodName);
        }

        let thisType: number[];
        if (classInfo.isExtension && classInfo.onType) {
          thisType = classInfo.onType;
        } else {
          thisType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(structTypeIndex),
          ];
        }

        if (currentSuperClassInfo) {
          if (currentSuperClassInfo.methods.has(methodName)) {
            thisType =
              currentSuperClassInfo.methods.get(methodName)!.paramTypes[0];
          }
        }

        const params = [thisType];
        const results = propType.length > 0 ? [propType] : [];

        let typeIndex: number;
        let isOverride = false;
        if (currentSuperClassInfo) {
          if (currentSuperClassInfo.methods.has(methodName)) {
            typeIndex =
              currentSuperClassInfo.methods.get(methodName)!.typeIndex;
            isOverride = true;
          }
        }

        if (!isOverride) {
          typeIndex = ctx.module.addType(params, results);
        }

        const funcIndex = ctx.module.addFunction(typeIndex!);

        methods.set(methodName, {
          index: funcIndex,
          returnType: propType,
          typeIndex: typeIndex!,
          paramTypes: params,
          isFinal: member.isFinal,
        });
      }

      // Setter
      if (member.setter) {
        const methodName = `set_${propName}`;
        if (!vtable.includes(methodName)) {
          vtable.push(methodName);
        }

        let thisType: number[];
        if (classInfo.isExtension && classInfo.onType) {
          thisType = classInfo.onType;
        } else {
          thisType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(structTypeIndex),
          ];
        }

        if (currentSuperClassInfo) {
          if (currentSuperClassInfo.methods.has(methodName)) {
            thisType =
              currentSuperClassInfo.methods.get(methodName)!.paramTypes[0];
          }
        }

        const params = [thisType, propType];
        const results: number[][] = [];

        let typeIndex: number;
        let isOverride = false;
        if (currentSuperClassInfo) {
          if (currentSuperClassInfo.methods.has(methodName)) {
            typeIndex =
              currentSuperClassInfo.methods.get(methodName)!.typeIndex;
            isOverride = true;
          }
        }

        if (!isOverride) {
          typeIndex = ctx.module.addType(params, results);
        }

        const funcIndex = ctx.module.addFunction(typeIndex!);

        methods.set(methodName, {
          index: funcIndex,
          returnType: [],
          typeIndex: typeIndex!,
          paramTypes: params,
          isFinal: member.isFinal,
        });
      }
    } else if (member.type === NodeType.FieldDefinition) {
      if (member.isStatic) continue;
      // Register implicit accessors for public fields
      if (!member.name.name.startsWith('#')) {
        let intrinsic: string | undefined;
        if (member.decorators) {
          const intrinsicDecorator = member.decorators.find(
            (d) => d.name === 'intrinsic',
          );
          if (intrinsicDecorator && intrinsicDecorator.args.length === 1) {
            intrinsic = intrinsicDecorator.args[0].value;
          }
        }

        const propName = member.name.name;
        const propType = mapType(ctx, member.typeAnnotation);

        // Getter
        const getterName = `get_${propName}`;
        if (!intrinsic && !vtable.includes(getterName)) {
          vtable.push(getterName);
        }

        let thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

        if (currentSuperClassInfo) {
          if (currentSuperClassInfo.methods.has(getterName)) {
            thisType =
              currentSuperClassInfo.methods.get(getterName)!.paramTypes[0];
          }
        }

        const params = [thisType];
        const results = [propType];

        let typeIndex: number;
        let isOverride = false;
        if (currentSuperClassInfo) {
          if (currentSuperClassInfo.methods.has(getterName)) {
            typeIndex =
              currentSuperClassInfo.methods.get(getterName)!.typeIndex;
            isOverride = true;
          }
        }

        if (!isOverride) {
          typeIndex = ctx.module.addType(params, results);
        }

        let funcIndex = -1;
        if (!intrinsic && !member.isDeclare) {
          funcIndex = ctx.module.addFunction(typeIndex!);
        }

        methods.set(getterName, {
          index: funcIndex,
          returnType: results[0],
          typeIndex: typeIndex!,
          paramTypes: params,
          isFinal: member.isFinal,
          intrinsic,
        });

        // Setter (if mutable)
        if (!member.isFinal) {
          const setterName = `set_${propName}`;
          if (!intrinsic && !vtable.includes(setterName)) {
            vtable.push(setterName);
          }

          const setterParams = [thisType, propType];
          const setterResults: number[][] = [];

          let setterTypeIndex: number;
          let isSetterOverride = false;
          if (currentSuperClassInfo) {
            if (currentSuperClassInfo.methods.has(setterName)) {
              setterTypeIndex =
                currentSuperClassInfo.methods.get(setterName)!.typeIndex;
              isSetterOverride = true;
            }
          }

          if (!isSetterOverride) {
            setterTypeIndex = ctx.module.addType(setterParams, setterResults);
          }

          let setterFuncIndex = -1;
          if (!intrinsic && !member.isDeclare) {
            setterFuncIndex = ctx.module.addFunction(setterTypeIndex!);
          }

          methods.set(setterName, {
            index: setterFuncIndex,
            returnType: [],
            typeIndex: setterTypeIndex!,
            paramTypes: setterParams,
            isFinal: member.isFinal,
            intrinsic,
          });
        }
      }
    }
  }
  // Create VTable Struct Type
  let vtableSuperTypeIndex: number | undefined;
  if (currentSuperClassInfo) {
    vtableSuperTypeIndex = currentSuperClassInfo.vtableTypeIndex;
  }

  const vtableTypeIndex = ctx.module.addStructType(
    vtable.map(() => ({type: [HeapType.func], mutable: false})),
    vtableSuperTypeIndex,
  );

  // Create VTable Global
  const vtableInit: number[] = [];
  for (const methodName of vtable) {
    const methodInfo = methods.get(methodName);
    if (!methodInfo) throw new Error(`Method ${methodName} not found`);
    vtableInit.push(Opcode.ref_func);
    vtableInit.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
  }
  vtableInit.push(0xfb, GcOpcode.struct_new);
  vtableInit.push(...WasmModule.encodeSignedLEB128(vtableTypeIndex));

  const vtableGlobalIndex = ctx.module.addGlobal(
    [ValType.ref, ...WasmModule.encodeSignedLEB128(vtableTypeIndex)],
    false,
    vtableInit,
  );

  classInfo.vtableTypeIndex = vtableTypeIndex;
  classInfo.vtableGlobalIndex = vtableGlobalIndex;

  generateInterfaceVTable(ctx, classInfo, decl);

  if (decl.exported && !decl.isExtension) {
    const ctorInfo = methods.get('#new')!;

    // Wrapper signature: params -> (ref null struct)
    const params = ctorInfo.paramTypes.slice(1); // Skip 'this'
    const results = [
      [ValType.ref_null, ...WasmModule.encodeSignedLEB128(structTypeIndex)],
    ];

    const wrapperTypeIndex = ctx.module.addType(params, results);
    const wrapperFuncIndex = ctx.module.addFunction(wrapperTypeIndex);

    const exportName = decl.exportName || decl.name.name;
    ctx.module.addExport(exportName, ExportDesc.Func, wrapperFuncIndex);

    ctx.bodyGenerators.push(() => {
      const body: number[] = [];

      ctx.pushScope();
      ctx.nextLocalIndex = params.length; // Params are locals 0..N-1
      ctx.extraLocals = [];

      // 1. Allocate
      body.push(0xfb, GcOpcode.struct_new_default);
      body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));

      // 2. Store in temp
      const tempLocal = ctx.declareLocal('$$export_new', results[0]);
      body.push(Opcode.local_tee);
      body.push(...WasmModule.encodeSignedLEB128(tempLocal));

      // 3. Init VTable (if needed)
      if (classInfo.vtableGlobalIndex !== undefined) {
        body.push(Opcode.global_get);
        body.push(
          ...WasmModule.encodeSignedLEB128(classInfo.vtableGlobalIndex),
        );
        body.push(0xfb, GcOpcode.struct_set);
        body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
        body.push(...WasmModule.encodeSignedLEB128(0));

        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(tempLocal));
      }

      // 4. Load args
      for (let i = 0; i < params.length; i++) {
        body.push(Opcode.local_get, i);
      }

      // 5. Call constructor
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(ctorInfo.index));

      // 6. Return
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempLocal));

      body.push(Opcode.end);

      ctx.module.addCode(wrapperFuncIndex, ctx.extraLocals, body);
      ctx.popScope();
    });
  }

  const declForGen = {
    ...decl,
    superClass: currentSuperClassInfo
      ? {type: NodeType.Identifier, name: currentSuperClassInfo.name}
      : decl.superClass,
  } as ClassDeclaration;

  ctx.bodyGenerators.push(() => {
    generateClassMethods(ctx, declForGen);
  });
}

export function generateClassMethods(
  ctx: CodegenContext,
  decl: ClassDeclaration,
  specializedName?: string,
  typeContext?: Map<string, TypeAnnotation>,
) {
  if (typeContext) {
    ctx.currentTypeContext = typeContext;
  }

  const className = specializedName || decl.name.name;
  const classInfo = ctx.classes.get(className)!;
  ctx.currentClass = classInfo;

  const members = [...decl.body];
  const hasConstructor = members.some(
    (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
  );
  if (!hasConstructor && !classInfo.isExtension) {
    const bodyStmts: any[] = [];
    if (decl.superClass) {
      bodyStmts.push({
        type: NodeType.ExpressionStatement,
        expression: {
          type: NodeType.CallExpression,
          callee: {type: NodeType.SuperExpression},
          arguments: [],
        },
      });
    }
    members.push({
      type: NodeType.MethodDefinition,
      name: {type: NodeType.Identifier, name: '#new'},
      params: [],
      body: {type: NodeType.BlockStatement, body: bodyStmts},
      isFinal: false,
      isAbstract: false,
      isStatic: false,
      isDeclare: false,
    } as MethodDefinition);
  }

  for (const member of members) {
    if (member.type === NodeType.MethodDefinition) {
      if (member.typeParameters && member.typeParameters.length > 0) {
        continue;
      }
      const methodName =
        member.name.name === 'constructor' ? '#new' : member.name.name;
      const methodInfo = classInfo.methods.get(methodName)!;
      const body: number[] = [];

      ctx.pushScope();
      ctx.nextLocalIndex = 0;
      ctx.extraLocals = [];
      ctx.thisLocalIndex = 0;

      // Params
      // 0: this
      if (
        !member.isStatic &&
        !(classInfo.isExtension && methodName === '#new')
      ) {
        ctx.defineLocal('this', ctx.nextLocalIndex++, methodInfo.paramTypes[0]);
      }

      for (let i = 0; i < member.params.length; i++) {
        const param = member.params[i];
        mapType(ctx, param.typeAnnotation!);
        // For extension constructors, params start at 0 (since no implicit this param)
        const paramTypeIndex =
          member.isStatic || (classInfo.isExtension && methodName === '#new')
            ? i
            : i + 1;
        ctx.defineLocal(
          param.name.name,
          ctx.nextLocalIndex++,
          methodInfo.paramTypes[paramTypeIndex],
        );
      }

      if (classInfo.isExtension && methodName === '#new') {
        // Extension constructor: 'this' is a local variable, not a param
        const thisLocalIndex = ctx.nextLocalIndex++;
        ctx.defineLocal('this', thisLocalIndex, classInfo.onType!);
        ctx.thisLocalIndex = thisLocalIndex;
        ctx.extraLocals.push(classInfo.onType!);
      }

      // Downcast 'this' if needed (e.g. overriding a method from a superclass)
      if (!member.isStatic) {
        const thisTypeIndex = getHeapTypeIndex(ctx, methodInfo.paramTypes[0]);
        let targetTypeIndex = classInfo.structTypeIndex;
        if (classInfo.isExtension && classInfo.onType) {
          targetTypeIndex = decodeTypeIndex(classInfo.onType);
        }

        if (thisTypeIndex !== -1 && thisTypeIndex !== targetTypeIndex) {
          const realThisType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(targetTypeIndex),
          ];
          const realThisLocal = ctx.nextLocalIndex++;
          ctx.extraLocals.push(realThisType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(...WasmModule.encodeSignedLEB128(targetTypeIndex));
          body.push(Opcode.local_set, realThisLocal);

          ctx.defineLocal('this', realThisLocal, realThisType);
          ctx.thisLocalIndex = realThisLocal;
        }
      }

      if (member.isAbstract) {
        body.push(Opcode.unreachable);
        body.push(Opcode.end);
        ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
        ctx.popScope();
        continue;
      }

      if (methodInfo.intrinsic) {
        ctx.popScope();
        continue;
      }

      if (member.isDeclare) {
        ctx.popScope();
        continue;
      }

      if (methodName === '#new') {
        const hasSuperClass = !!classInfo.superClass;

        if (!hasSuperClass) {
          for (const m of decl.body) {
            if (m.type === NodeType.FieldDefinition && m.value) {
              if (m.isStatic) continue;
              const fieldName = manglePrivateName(decl.name.name, m.name.name);
              const fieldInfo = classInfo.fields.get(fieldName)!;
              body.push(Opcode.local_get, 0);
              generateExpression(ctx, m.value, body);
              body.push(0xfb, GcOpcode.struct_set);
              body.push(
                ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
              );
              body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
            }
          }
        }

        if (member.body && member.body.type === NodeType.BlockStatement) {
          if (hasSuperClass) {
            for (const stmt of member.body.body) {
              generateFunctionStatement(ctx, stmt, body);

              if (
                stmt.type === NodeType.ExpressionStatement &&
                stmt.expression.type === NodeType.CallExpression &&
                (stmt.expression as any).callee.type ===
                  NodeType.SuperExpression
              ) {
                for (const m of decl.body) {
                  if (m.type === NodeType.FieldDefinition && m.value) {
                    if (m.isStatic) continue;
                    const fieldName = manglePrivateName(
                      decl.name.name,
                      m.name.name,
                    );
                    const fieldInfo = classInfo.fields.get(fieldName)!;
                    body.push(Opcode.local_get, 0);
                    generateExpression(ctx, m.value, body);
                    body.push(0xfb, GcOpcode.struct_set);
                    body.push(
                      ...WasmModule.encodeSignedLEB128(
                        classInfo.structTypeIndex,
                      ),
                    );
                    body.push(
                      ...WasmModule.encodeSignedLEB128(fieldInfo.index),
                    );
                  }
                }
              }
            }
          } else {
            generateBlockStatement(ctx, member.body, body);
          }
        }

        if (classInfo.isExtension) {
          // Return 'this'
          body.push(Opcode.local_get);
          body.push(...WasmModule.encodeSignedLEB128(ctx.thisLocalIndex));
        }
      } else {
        if (member.body && member.body.type === NodeType.BlockStatement) {
          generateBlockStatement(ctx, member.body, body);
          if (methodInfo.returnType && methodInfo.returnType.length > 0) {
            body.push(Opcode.unreachable);
          }
        }
      }
      body.push(Opcode.end);

      ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
      ctx.popScope();
    } else if (member.type === NodeType.AccessorDeclaration) {
      const propName = member.name.name;

      // Getter
      if (member.getter) {
        const methodName = `get_${propName}`;
        const methodInfo = classInfo.methods.get(methodName)!;
        const body: number[] = [];

        ctx.pushScope();
        ctx.nextLocalIndex = 0;
        ctx.extraLocals = [];
        ctx.thisLocalIndex = 0;

        // Params
        // 0: this
        ctx.defineLocal('this', ctx.nextLocalIndex++, methodInfo.paramTypes[0]);

        // Downcast 'this' if needed
        const thisTypeIndex = getHeapTypeIndex(ctx, methodInfo.paramTypes[0]);
        let targetTypeIndex = classInfo.structTypeIndex;
        if (classInfo.isExtension && classInfo.onType) {
          targetTypeIndex = decodeTypeIndex(classInfo.onType);
        }

        if (thisTypeIndex !== -1 && thisTypeIndex !== targetTypeIndex) {
          const realThisType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(targetTypeIndex),
          ];
          const realThisLocal = ctx.nextLocalIndex++;
          ctx.extraLocals.push(realThisType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(...WasmModule.encodeSignedLEB128(targetTypeIndex));
          body.push(Opcode.local_set, realThisLocal);

          ctx.defineLocal('this', realThisLocal, realThisType);
          ctx.thisLocalIndex = realThisLocal;
        }

        generateBlockStatement(ctx, member.getter, body);
        body.push(Opcode.end);

        ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
        ctx.popScope();
      }

      // Setter
      if (member.setter) {
        const methodName = `set_${propName}`;
        const methodInfo = classInfo.methods.get(methodName)!;
        const body: number[] = [];

        ctx.pushScope();
        ctx.nextLocalIndex = 0;
        ctx.extraLocals = [];
        ctx.thisLocalIndex = 0;

        // Params
        // 0: this
        ctx.defineLocal('this', ctx.nextLocalIndex++, methodInfo.paramTypes[0]);
        // 1: value
        ctx.defineLocal(
          member.setter.param.name,
          ctx.nextLocalIndex++,
          methodInfo.paramTypes[1],
        );

        // Downcast 'this' if needed
        const thisTypeIndex = getHeapTypeIndex(ctx, methodInfo.paramTypes[0]);
        let targetTypeIndex = classInfo.structTypeIndex;
        if (classInfo.isExtension && classInfo.onType) {
          targetTypeIndex = decodeTypeIndex(classInfo.onType);
        }

        if (thisTypeIndex !== -1 && thisTypeIndex !== targetTypeIndex) {
          const realThisType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(targetTypeIndex),
          ];
          const realThisLocal = ctx.nextLocalIndex++;
          ctx.extraLocals.push(realThisType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(...WasmModule.encodeSignedLEB128(targetTypeIndex));
          body.push(Opcode.local_set, realThisLocal);

          ctx.defineLocal('this', realThisLocal, realThisType);
          ctx.thisLocalIndex = realThisLocal;
        }

        generateBlockStatement(ctx, member.setter.body, body);
        body.push(Opcode.end);

        ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
        ctx.popScope();
      }
    } else if (member.type === NodeType.FieldDefinition) {
      if (member.isDeclare) continue;
      if (member.isStatic) continue;
      if (
        member.decorators &&
        member.decorators.some((d) => d.name === 'intrinsic')
      )
        continue;

      if (!member.name.name.startsWith('#')) {
        const propName = member.name.name;
        const fieldName = manglePrivateName(className, propName);
        const fieldInfo = classInfo.fields.get(fieldName);
        if (!fieldInfo) {
          console.error(
            `Field ${fieldName} not found in class ${decl.name.name}`,
          );
          console.error(
            'Available fields:',
            Array.from(classInfo.fields.keys()),
          );
          throw new Error(`Field ${fieldName} not found`);
        }

        // Getter
        const getterName = `get_${propName}`;
        const getterInfo = classInfo.methods.get(getterName)!;
        const getterBody: number[] = [];

        // this.field
        getterBody.push(Opcode.local_get, 0); // this
        getterBody.push(0xfb, GcOpcode.struct_get);
        getterBody.push(
          ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
        );
        getterBody.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
        getterBody.push(Opcode.end);

        ctx.module.addCode(getterInfo.index, [], getterBody);

        // Setter
        if (!member.isFinal) {
          const setterName = `set_${propName}`;
          const setterInfo = classInfo.methods.get(setterName)!;
          const setterBody: number[] = [];

          // this.field = val
          setterBody.push(Opcode.local_get, 0); // this
          setterBody.push(Opcode.local_get, 1); // val
          setterBody.push(0xfb, GcOpcode.struct_set);
          setterBody.push(
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          );
          setterBody.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
          setterBody.push(Opcode.end);

          ctx.module.addCode(setterInfo.index, [], setterBody);
        }
      }
    }
  }
}

export function resolveAnnotation(
  type: TypeAnnotation,
  context?: Map<string, TypeAnnotation>,
): TypeAnnotation {
  if (
    type.type === NodeType.TypeAnnotation &&
    context &&
    context.has(type.name)
  ) {
    return resolveAnnotation(context.get(type.name)!, context);
  }

  if (type.type === NodeType.TypeAnnotation && type.typeArguments) {
    return {
      ...type,
      typeArguments: type.typeArguments.map((arg) =>
        resolveAnnotation(arg, context),
      ),
    };
  }

  if (type.type === NodeType.RecordTypeAnnotation) {
    return {
      ...type,
      properties: type.properties.map((p) => ({
        ...p,
        typeAnnotation: resolveAnnotation(p.typeAnnotation, context),
      })),
    };
  }

  if (type.type === NodeType.TupleTypeAnnotation) {
    return {
      ...type,
      elementTypes: type.elementTypes.map((t) => resolveAnnotation(t, context)),
    };
  }

  if (type.type === NodeType.FunctionTypeAnnotation) {
    return {
      ...type,
      params: type.params.map((p) => resolveAnnotation(p, context)),
      returnType: resolveAnnotation(type.returnType, context),
    };
  }

  if (type.type === NodeType.UnionTypeAnnotation) {
    return {
      ...type,
      types: type.types.map((t) => resolveAnnotation(t, context)),
    };
  }

  return type;
}

export function getTypeKey(type: TypeAnnotation): string {
  if (type.type === NodeType.TypeAnnotation) {
    let key = type.name;
    if (type.typeArguments && type.typeArguments.length > 0) {
      key += `<${type.typeArguments.map(getTypeKey).join(',')}>`;
    }
    return key;
  } else if (type.type === NodeType.RecordTypeAnnotation) {
    const props = type.properties
      .map((p) => `${p.name.name}:${getTypeKey(p.typeAnnotation)}`)
      .sort()
      .join(',');
    return `{${props}}`;
  } else if (type.type === NodeType.TupleTypeAnnotation) {
    const elements = type.elementTypes.map(getTypeKey).join(',');
    return `[${elements}]`;
  } else if (type.type === NodeType.FunctionTypeAnnotation) {
    const params = type.params.map(getTypeKey).join(',');
    const ret = type.returnType ? getTypeKey(type.returnType) : 'void';
    return `(${params})=>${ret}`;
  }
  return 'unknown';
}

export function getSpecializedName(
  name: string,
  args: TypeAnnotation[],
  ctx: CodegenContext,
  context?: Map<string, TypeAnnotation>,
): string {
  const argNames = args.map((arg) => {
    const resolved = resolveAnnotation(arg, context);
    return getTypeKey(resolved);
  });
  return `${name}<${argNames.join(',')}>`;
}

function getFixedArrayTypeIndex(
  ctx: CodegenContext,
  elementType: number[],
): number {
  const key = elementType.join(',');
  if (ctx.fixedArrayTypes.has(key)) {
    const cached = ctx.fixedArrayTypes.get(key)!;
    return cached;
  }
  const index = ctx.module.addArrayType(elementType, true);
  ctx.fixedArrayTypes.set(key, index);
  return index;
}

export function mapType(
  ctx: CodegenContext,
  type: TypeAnnotation,
  context?: Map<string, TypeAnnotation>,
): number[] {
  const typeContext = context || ctx.currentTypeContext;
  if (!type) return [ValType.i32];

  if (
    type.type === NodeType.TypeAnnotation &&
    (type.name === 'FixedArray' || type.name === 'm1_FixedArray')
  ) {
    // console.log(`Mapping FixedArray: ${JSON.stringify(type)}`);
  }

  // Resolve generic type parameters
  if (
    type.type === NodeType.TypeAnnotation &&
    typeContext &&
    typeContext.has(type.name)
  ) {
    return mapType(ctx, typeContext.get(type.name)!, typeContext);
  }

  // Check type aliases
  if (type.type === NodeType.TypeAnnotation && ctx.typeAliases.has(type.name)) {
    return mapType(ctx, ctx.typeAliases.get(type.name)!, context);
  }

  if (type.type === NodeType.TypeAnnotation) {
    switch (type.name) {
      case 'i32':
        return [ValType.i32];
      case 'i64':
        return [ValType.i64];
      case 'f32':
        return [ValType.f32];
      case 'f64':
        return [ValType.f64];
      case 'boolean':
        return [ValType.i32];
      case 'string': {
        if (ctx.stringTypeIndex !== -1) {
          return [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
          ];
        }
        if (ctx.wellKnownTypes.String) {
          const typeName = ctx.wellKnownTypes.String.name.name;
          if (ctx.classes.has(typeName)) {
            const classInfo = ctx.classes.get(typeName)!;
            return [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
            ];
          }
        }
        return [ValType.i32];
      }
      case 'void':
        return [];
      case 'anyref':
        return [ValType.anyref];
      case 'any':
        return [ValType.anyref];
      case 'eqref':
        return [ValType.eqref];
      case 'struct':
        return [ValType.ref_null, HeapType.struct];
      case 'array':
        if (type.typeArguments && type.typeArguments.length === 1) {
          const elementType = mapType(ctx, type.typeArguments[0], context);
          const typeIndex = getFixedArrayTypeIndex(ctx, elementType);
          return [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(typeIndex),
          ];
        }
        return [ValType.ref_null, HeapType.array];
      default: {
        // Class or Interface
        // Check for well-known types first (renamed by bundler)
        let typeName = type.name;
        if (typeName === 'String' && ctx.wellKnownTypes.String) {
          typeName = ctx.wellKnownTypes.String.name.name;
        }

        if (typeName === 'ByteArray') {
          return [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex),
          ];
        }

        // Check if it's a generic class instantiation
        if (type.typeArguments && type.typeArguments.length > 0) {
          // Instantiate generic class
          // We need to find the generic class declaration
          // Check genericClasses
          let genericDecl = ctx.genericClasses.get(typeName);

          // If not found, check if it's a well-known type that was renamed
          if (!genericDecl) {
            if (
              ctx.wellKnownTypes.FixedArray &&
              (typeName === 'FixedArray' ||
                typeName === ctx.wellKnownTypes.FixedArray.name.name)
            ) {
              genericDecl = ctx.wellKnownTypes.FixedArray;
            }
          }

          if (genericDecl) {
            const specializedName = getSpecializedName(
              typeName,
              type.typeArguments,
              ctx,
              context,
            );
            if (!ctx.classes.has(specializedName)) {
              instantiateClass(
                ctx,
                genericDecl,
                specializedName,
                type.typeArguments,
                context,
              );
            }
            const classInfo = ctx.classes.get(specializedName)!;
            if (classInfo.isExtension && classInfo.onType) {
              return classInfo.onType;
            }
            return [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
            ];
          }
        }

        if (ctx.classes.has(typeName)) {
          const classInfo = ctx.classes.get(typeName)!;
          if (classInfo.isExtension && classInfo.onType) {
            return classInfo.onType;
          }
          return [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          ];
        }
        if (ctx.interfaces.has(typeName)) {
          const interfaceInfo = ctx.interfaces.get(typeName)!;
          return [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
          ];
        }

        return [ValType.i32];
      }
    }
  } else if (type.type === NodeType.RecordTypeAnnotation) {
    const recordType = type as RecordTypeAnnotation;
    const fields = recordType.properties.map((p) => ({
      name: p.name.name,
      type: mapType(ctx, p.typeAnnotation, context),
    }));
    const typeIndex = ctx.getRecordTypeIndex(fields);
    return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
  } else if (type.type === NodeType.TupleTypeAnnotation) {
    const tupleType = type as TupleTypeAnnotation;
    const types = tupleType.elementTypes.map((t) => mapType(ctx, t, context));
    const typeIndex = ctx.getTupleTypeIndex(types);
    return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
  } else if (type.type === NodeType.FunctionTypeAnnotation) {
    const funcType = type as FunctionTypeAnnotation;
    const paramTypes = funcType.params.map((p: TypeAnnotation) =>
      mapType(ctx, p, context),
    );
    const returnType = funcType.returnType
      ? mapType(ctx, funcType.returnType, context)
      : [];

    const closureTypeIndex = ctx.getClosureTypeIndex(paramTypes, returnType);
    return [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(closureTypeIndex),
    ];
  } else if (type.type === NodeType.UnionTypeAnnotation) {
    return [ValType.anyref];
  }

  return [ValType.i32];
}

export function instantiateClass(
  ctx: CodegenContext,
  decl: ClassDeclaration,
  specializedName: string,
  typeArguments: TypeAnnotation[],
  parentContext?: Map<string, TypeAnnotation>,
) {
  const context = new Map<string, TypeAnnotation>();
  if (decl.typeParameters) {
    decl.typeParameters.forEach((param, index) => {
      const arg = typeArguments[index];
      context.set(param.name, resolveAnnotation(arg, parentContext));
    });
  }

  const fields = new Map<string, {index: number; type: number[]}>();
  const fieldTypes: {type: number[]; mutable: boolean}[] = [];

  let fieldIndex = 0;
  let structTypeIndex = -1;
  let onType: number[] | undefined;

  if (decl.isExtension && decl.onType) {
    onType = mapType(ctx, decl.onType, context);
  } else {
    // Add vtable field
    fields.set('__vtable', {index: fieldIndex++, type: [ValType.eqref]});
    fieldTypes.push({type: [ValType.eqref], mutable: true});

    for (const member of decl.body) {
      if (member.type === NodeType.FieldDefinition) {
        const wasmType = mapType(ctx, member.typeAnnotation, context);
        const fieldName = manglePrivateName(specializedName, member.name.name);
        fields.set(fieldName, {index: fieldIndex++, type: wasmType});
        fieldTypes.push({type: wasmType, mutable: true});
      }
    }

    structTypeIndex = ctx.module.addStructType(fieldTypes);
  }

  const methods = new Map<
    string,
    {
      index: number;
      returnType: number[];
      typeIndex: number;
      paramTypes: number[][];
      isFinal?: boolean;
      intrinsic?: string;
    }
  >();
  const vtable: string[] = [];

  const classInfo: ClassInfo = {
    name: specializedName,
    originalName: decl.name.name,
    typeArguments: context,
    structTypeIndex,
    superClass: decl.superClass?.name,
    fields,
    methods,
    vtable,
    isExtension: decl.isExtension,
    onType,
  };
  ctx.classes.set(specializedName, classInfo);

  const registerMethods = () => {
    // Register methods
    const members = [...decl.body];
    const hasConstructor = members.some(
      (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
    );
    if (!hasConstructor && !decl.isExtension) {
      const bodyStmts: any[] = [];
      if (decl.superClass) {
        bodyStmts.push({
          type: NodeType.ExpressionStatement,
          expression: {
            type: NodeType.CallExpression,
            callee: {type: NodeType.SuperExpression},
            arguments: [],
          },
        });
      }
      members.push({
        type: NodeType.MethodDefinition,
        name: {type: NodeType.Identifier, name: '#new'},
        params: [],
        body: {type: NodeType.BlockStatement, body: bodyStmts},
        isFinal: false,
        isAbstract: false,
        isStatic: false,
        isDeclare: false,
      } as MethodDefinition);
    }

    for (const member of members) {
      if (member.type === NodeType.MethodDefinition) {
        if (member.typeParameters && member.typeParameters.length > 0) {
          const key = `${specializedName}.${member.name.name}`;
          ctx.genericMethods.set(key, member);
          continue;
        }

        const methodName =
          member.name.name === 'constructor' ? '#new' : member.name.name;

        let intrinsic: string | undefined;
        if (member.decorators) {
          const intrinsicDecorator = member.decorators.find(
            (d) => d.name === 'intrinsic',
          );
          if (intrinsicDecorator && intrinsicDecorator.args.length === 1) {
            intrinsic = intrinsicDecorator.args[0].value;
          }
        }

        if (methodName !== '#new' && !intrinsic) vtable.push(methodName);

        let thisType: number[];
        if (decl.isExtension && onType) {
          thisType = onType;
        } else {
          thisType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(structTypeIndex),
          ];
        }

        const params: number[][] = [];
        if (!member.isStatic && !(decl.isExtension && methodName === '#new')) {
          params.push(thisType);
        }
        for (const param of member.params) {
          const pType = mapType(ctx, param.typeAnnotation, context);
          params.push(pType);
        }

        let results: number[][] = [];
        if (methodName === '#new') {
          if (decl.isExtension && onType) {
            results = [onType];
          } else if (member.isStatic && member.returnType) {
            const mapped = mapType(ctx, member.returnType, context);
            if (mapped.length > 0) results = [mapped];
          } else {
            results = [];
          }
        } else if (member.returnType) {
          const mapped = mapType(ctx, member.returnType, context);
          if (mapped.length > 0) results = [mapped];
        } else {
          results = [];
        }

        const typeIndex = ctx.module.addType(params, results);

        let funcIndex = -1;
        if (!intrinsic) {
          funcIndex = ctx.module.addFunction(typeIndex);
        }

        const returnType = results.length > 0 ? results[0] : [];
        methods.set(methodName, {
          index: funcIndex,
          returnType,
          typeIndex,
          paramTypes: params,
          isFinal: member.isFinal,
          intrinsic,
        });
      } else if (member.type === NodeType.AccessorDeclaration) {
        const propName = member.name.name;
        const propType = mapType(ctx, member.typeAnnotation, context);

        // Getter
        if (member.getter) {
          const methodName = `get_${propName}`;
          if (!vtable.includes(methodName)) {
            vtable.push(methodName);
          }

          let thisType: number[];
          if (decl.isExtension && onType) {
            thisType = onType;
          } else {
            thisType = [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(structTypeIndex),
            ];
          }

          if (decl.superClass) {
            const superClassInfo = ctx.classes.get(decl.superClass.name)!;
            if (superClassInfo.methods.has(methodName)) {
              thisType = superClassInfo.methods.get(methodName)!.paramTypes[0];
            }
          }

          const params = [thisType];
          const results = propType.length > 0 ? [propType] : [];

          let typeIndex: number;
          let isOverride = false;
          if (decl.superClass) {
            const superClassInfo = ctx.classes.get(decl.superClass.name)!;
            if (superClassInfo.methods.has(methodName)) {
              typeIndex = superClassInfo.methods.get(methodName)!.typeIndex;
              isOverride = true;
            }
          }

          if (!isOverride) {
            typeIndex = ctx.module.addType(params, results);
          }

          const funcIndex = ctx.module.addFunction(typeIndex!);

          methods.set(methodName, {
            index: funcIndex,
            returnType: propType,
            typeIndex: typeIndex!,
            paramTypes: params,
            isFinal: member.isFinal,
          });
        }

        // Setter
        if (member.setter) {
          const methodName = `set_${propName}`;
          if (!vtable.includes(methodName)) {
            vtable.push(methodName);
          }

          let thisType: number[];
          if (decl.isExtension && onType) {
            thisType = onType;
          } else {
            thisType = [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(structTypeIndex),
            ];
          }

          if (decl.superClass) {
            const superClassInfo = ctx.classes.get(decl.superClass.name)!;
            if (superClassInfo.methods.has(methodName)) {
              thisType = superClassInfo.methods.get(methodName)!.paramTypes[0];
            }
          }

          const params = [thisType, propType];
          const results: number[][] = [];

          let typeIndex: number;
          let isOverride = false;
          if (decl.superClass) {
            const superClassInfo = ctx.classes.get(decl.superClass.name)!;
            if (superClassInfo.methods.has(methodName)) {
              typeIndex = superClassInfo.methods.get(methodName)!.typeIndex;
              isOverride = true;
            }
          }

          if (!isOverride) {
            typeIndex = ctx.module.addType(params, results);
          }

          const funcIndex = ctx.module.addFunction(typeIndex!);

          methods.set(methodName, {
            index: funcIndex,
            returnType: [],
            typeIndex: typeIndex!,
            paramTypes: params,
            isFinal: member.isFinal,
          });
        }
      } else if (member.type === NodeType.FieldDefinition) {
        if (member.isStatic) {
          continue;
        }
        // Implicit accessors
        if (!member.name.name.startsWith('#')) {
          let intrinsic: string | undefined;
          if (member.decorators) {
            const intrinsicDecorator = member.decorators.find(
              (d) => d.name === 'intrinsic',
            );
            if (intrinsicDecorator && intrinsicDecorator.args.length === 1) {
              intrinsic = intrinsicDecorator.args[0].value;
            }
          }

          const propName = member.name.name;
          const propType = mapType(ctx, member.typeAnnotation, context);

          // Register Getter
          const regGetterName = `get_${propName}`;
          if (!intrinsic && !vtable.includes(regGetterName)) {
            vtable.push(regGetterName);
          }

          let thisType: number[];
          if (decl.isExtension && onType) {
            thisType = onType;
          } else {
            thisType = [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(structTypeIndex),
            ];
          }

          if (decl.superClass) {
            const superClassInfo = ctx.classes.get(decl.superClass.name)!;
            if (superClassInfo.methods.has(regGetterName)) {
              thisType =
                superClassInfo.methods.get(regGetterName)!.paramTypes[0];
            }
          }

          const params = [thisType];
          const results = [propType];

          let typeIndex: number;
          let isOverride = false;
          if (decl.superClass) {
            const superClassInfo = ctx.classes.get(decl.superClass.name)!;
            if (superClassInfo.methods.has(regGetterName)) {
              typeIndex = superClassInfo.methods.get(regGetterName)!.typeIndex;
              isOverride = true;
            }
          }

          if (!isOverride) {
            typeIndex = ctx.module.addType(params, results);
          }

          const funcIndex = intrinsic ? -1 : ctx.module.addFunction(typeIndex!);

          methods.set(regGetterName, {
            index: funcIndex,
            returnType: results[0],
            typeIndex: typeIndex!,
            paramTypes: params,
            isFinal: member.isFinal,
            intrinsic,
          });

          // Register Setter (if mutable)
          if (!member.isFinal) {
            const regSetterName = `set_${propName}`;
            if (!intrinsic && !vtable.includes(regSetterName)) {
              vtable.push(regSetterName);
            }

            const setterParams = [thisType, propType];
            const setterResults: number[][] = [];

            let setterTypeIndex: number;
            let isSetterOverride = false;
            if (decl.superClass) {
              const superClassInfo = ctx.classes.get(decl.superClass.name)!;
              if (superClassInfo.methods.has(regSetterName)) {
                setterTypeIndex =
                  superClassInfo.methods.get(regSetterName)!.typeIndex;
                isSetterOverride = true;
              }
            }

            if (!isSetterOverride) {
              setterTypeIndex = ctx.module.addType(setterParams, setterResults);
            }

            const setterFuncIndex = intrinsic
              ? -1
              : ctx.module.addFunction(setterTypeIndex!);

            methods.set(regSetterName, {
              index: setterFuncIndex,
              returnType: [],
              typeIndex: setterTypeIndex!,
              paramTypes: setterParams,
              isFinal: member.isFinal,
              intrinsic,
            });
          }
        }
      }
    }

    // Create VTable Struct Type
    if (classInfo.isExtension) {
      const declForGen = {
        ...decl,
        name: {type: NodeType.Identifier, name: specializedName},
        superClass: undefined,
      } as ClassDeclaration;

      generateInterfaceVTable(ctx, classInfo, decl);

      ctx.bodyGenerators.push(() => {
        generateClassMethods(ctx, declForGen, specializedName, context);
      });
      return;
    }

    let vtableSuperTypeIndex: number | undefined;
    const baseClassInfo = decl.superClass
      ? ctx.classes.get(decl.superClass.name)
      : undefined;
    if (baseClassInfo) {
      vtableSuperTypeIndex = baseClassInfo.vtableTypeIndex;
    }

    const vtableTypeIndex = ctx.module.addStructType(
      vtable.map(() => ({type: [HeapType.func], mutable: false})),
      vtableSuperTypeIndex,
    );

    // Create VTable Global
    const vtableInit: number[] = [];
    for (const methodName of vtable) {
      const methodInfo = methods.get(methodName);
      if (!methodInfo) throw new Error(`Method ${methodName} not found`);
      vtableInit.push(Opcode.ref_func);
      vtableInit.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
    }
    vtableInit.push(0xfb, GcOpcode.struct_new);
    vtableInit.push(...WasmModule.encodeSignedLEB128(vtableTypeIndex));

    const vtableGlobalIndex = ctx.module.addGlobal(
      [ValType.ref, ...WasmModule.encodeSignedLEB128(vtableTypeIndex)],
      false,
      vtableInit,
    );

    classInfo.vtableTypeIndex = vtableTypeIndex;
    classInfo.vtableGlobalIndex = vtableGlobalIndex;

    generateInterfaceVTable(ctx, classInfo, decl);

    if (decl.exported && structTypeIndex !== -1) {
      const ctorInfo = methods.get('#new')!;

      // Wrapper signature: params -> (ref null struct)
      const params = ctorInfo.paramTypes.slice(1); // Skip 'this'
      const results = [
        [ValType.ref_null, ...WasmModule.encodeSignedLEB128(structTypeIndex)],
      ];

      const wrapperTypeIndex = ctx.module.addType(params, results);
      const wrapperFuncIndex = ctx.module.addFunction(wrapperTypeIndex);

      const exportName = specializedName;
      ctx.module.addExport(exportName, ExportDesc.Func, wrapperFuncIndex);

      ctx.bodyGenerators.push(() => {
        const body: number[] = [];

        ctx.pushScope();
        ctx.nextLocalIndex = params.length; // Params are locals 0..N-1
        ctx.extraLocals = [];

        // 1. Allocate
        body.push(0xfb, GcOpcode.struct_new_default);
        body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));

        // 2. Store in temp
        const tempLocal = ctx.declareLocal('$$export_new', results[0]);
        body.push(Opcode.local_tee);
        body.push(...WasmModule.encodeSignedLEB128(tempLocal));

        // 3. Init VTable (if needed)
        if (classInfo.vtableGlobalIndex !== undefined) {
          body.push(Opcode.global_get);
          body.push(
            ...WasmModule.encodeSignedLEB128(classInfo.vtableGlobalIndex),
          );
          body.push(0xfb, GcOpcode.struct_set);
          body.push(...WasmModule.encodeSignedLEB128(structTypeIndex));
          body.push(...WasmModule.encodeSignedLEB128(0));

          body.push(Opcode.local_get);
          body.push(...WasmModule.encodeSignedLEB128(tempLocal));
        }

        // 4. Load args
        for (let i = 0; i < params.length; i++) {
          body.push(Opcode.local_get, i);
        }

        // 5. Call constructor
        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(ctorInfo.index));

        // 6. Return
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(tempLocal));

        body.push(Opcode.end);

        ctx.module.addCode(wrapperFuncIndex, ctx.extraLocals, body);
        ctx.popScope();
      });
    }

    const declForGen = {
      ...decl,
      name: {...decl.name, name: specializedName},
      superClass: baseClassInfo
        ? {type: NodeType.Identifier, name: baseClassInfo.name}
        : decl.superClass,
    } as ClassDeclaration;

    ctx.bodyGenerators.push(() => {
      generateClassMethods(ctx, declForGen, specializedName, context);
    });
  };

  if (ctx.isGeneratingBodies) {
    registerMethods();
  } else {
    ctx.pendingMethodGenerations.push(registerMethods);
  }
}

function manglePrivateName(className: string, memberName: string): string {
  if (memberName.startsWith('#')) {
    return `${className}::${memberName}`;
  }
  return memberName;
}

function applyMixin(
  ctx: CodegenContext,
  baseClassInfo: ClassInfo | undefined,
  mixinDecl: MixinDeclaration,
): ClassInfo {
  const baseName = baseClassInfo ? baseClassInfo.name : 'Object';
  const intermediateName = `${baseName}_${mixinDecl.name.name}`;

  if (ctx.classes.has(intermediateName)) {
    return ctx.classes.get(intermediateName)!;
  }

  const fields = new Map<string, {index: number; type: number[]}>();
  const fieldTypes: {type: number[]; mutable: boolean}[] = [];
  let fieldIndex = 0;
  let superTypeIndex: number | undefined;
  const methods = new Map<string, any>();
  const vtable: string[] = [];

  if (baseClassInfo) {
    superTypeIndex = baseClassInfo.structTypeIndex;
    // Inherit fields
    const sortedSuperFields = Array.from(baseClassInfo.fields.entries()).sort(
      (a, b) => a[1].index - b[1].index,
    );
    for (const [name, info] of sortedSuperFields) {
      fields.set(name, {index: fieldIndex++, type: info.type});
      fieldTypes.push({type: info.type, mutable: true});
    }
  } else {
    // Root mixin application
    fields.set('__vtable', {index: fieldIndex++, type: [ValType.eqref]});
    fieldTypes.push({type: [ValType.eqref], mutable: true});
  }

  // Add mixin fields
  for (const member of mixinDecl.body) {
    if (member.type === NodeType.FieldDefinition) {
      const wasmType = mapType(ctx, member.typeAnnotation);
      const fieldName = manglePrivateName(intermediateName, member.name.name);

      if (!fields.has(fieldName)) {
        fields.set(fieldName, {index: fieldIndex++, type: wasmType});
        fieldTypes.push({type: wasmType, mutable: true});
      }
    }
  }

  const structTypeIndex = ctx.module.addStructType(fieldTypes, superTypeIndex);

  const classInfo: ClassInfo = {
    name: intermediateName,
    structTypeIndex,
    superClass: baseClassInfo?.name,
    fields,
    methods,
    vtable,
  };
  ctx.classes.set(intermediateName, classInfo);

  const declForGen = {
    ...mixinDecl,
    type: NodeType.ClassDeclaration,
    name: {type: NodeType.Identifier, name: intermediateName},
    superClass: baseClassInfo
      ? {type: NodeType.Identifier, name: baseClassInfo.name}
      : undefined,
    isAbstract: false,
  } as unknown as ClassDeclaration;

  ctx.syntheticClasses.push(declForGen);

  return classInfo;
}

export function typeToTypeAnnotation(
  type: Type,
  erasedTypeParams?: Set<string>,
): TypeAnnotation {
  switch (type.kind) {
    case TypeKind.Number:
      return {
        type: NodeType.TypeAnnotation,
        name: (type as NumberType).name,
      };
    case TypeKind.Boolean:
      return {
        type: NodeType.TypeAnnotation,
        name: 'boolean',
      };
    case TypeKind.Void:
      return {
        type: NodeType.TypeAnnotation,
        name: 'void',
      };
    case TypeKind.Class: {
      const classType = type as ClassType;
      let args = classType.typeArguments
        ? classType.typeArguments.map((t) =>
            typeToTypeAnnotation(t, erasedTypeParams),
          )
        : [];

      if (
        args.length === 0 &&
        classType.typeParameters &&
        classType.typeParameters.length > 0
      ) {
        args = classType.typeParameters.map((tp) => ({
          type: NodeType.TypeAnnotation,
          name: tp.name,
        }));
      }

      return {
        type: NodeType.TypeAnnotation,
        name: classType.name,
        typeArguments: args.length > 0 ? args : undefined,
      };
    }
    case TypeKind.Interface: {
      const ifaceType = type as InterfaceType;
      const args = ifaceType.typeArguments
        ? ifaceType.typeArguments.map((t) =>
            typeToTypeAnnotation(t, erasedTypeParams),
          )
        : [];
      return {
        type: NodeType.TypeAnnotation,
        name: ifaceType.name,
        typeArguments: args.length > 0 ? args : undefined,
      };
    }
    case TypeKind.FixedArray: {
      const arrayType = type as FixedArrayType;
      return {
        type: NodeType.TypeAnnotation,
        name: 'array',
        typeArguments: [
          typeToTypeAnnotation(arrayType.elementType, erasedTypeParams),
        ],
      };
    }
    case TypeKind.Record: {
      const recordType = type as RecordType;
      const properties: any[] = [];
      for (const [name, propType] of recordType.properties) {
        properties.push({
          type: NodeType.PropertySignature,
          name: {type: NodeType.Identifier, name},
          typeAnnotation: typeToTypeAnnotation(propType, erasedTypeParams),
        });
      }
      return {
        type: NodeType.RecordTypeAnnotation,
        properties,
      } as any;
    }
    case TypeKind.Tuple: {
      const tupleType = type as TupleType;
      return {
        type: NodeType.TupleTypeAnnotation,
        elementTypes: tupleType.elementTypes.map((t) =>
          typeToTypeAnnotation(t, erasedTypeParams),
        ),
      } as any;
    }
    case TypeKind.Function: {
      const funcType = type as FunctionType;
      const newErased = new Set(erasedTypeParams);
      if (funcType.typeParameters) {
        for (const p of funcType.typeParameters) {
          newErased.add(p.name);
        }
      }
      return {
        type: NodeType.FunctionTypeAnnotation,
        params: funcType.parameters.map((p) =>
          typeToTypeAnnotation(p, newErased),
        ),
        returnType: typeToTypeAnnotation(funcType.returnType, newErased),
      } as any;
    }
    case TypeKind.TypeParameter: {
      const name = (type as TypeParameterType).name;
      if (erasedTypeParams && erasedTypeParams.has(name)) {
        return {
          type: NodeType.TypeAnnotation,
          name: 'anyref',
        };
      }
      return {
        type: NodeType.TypeAnnotation,
        name: name,
      };
    }
    case TypeKind.TypeAlias: {
      const aliasType = type as TypeAliasType;
      if (aliasType.isDistinct) {
        return {
          type: NodeType.TypeAnnotation,
          name: aliasType.name,
        };
      }
      return typeToTypeAnnotation(aliasType.target, erasedTypeParams);
    }
    case TypeKind.ByteArray:
      return {
        type: NodeType.TypeAnnotation,
        name: 'ByteArray',
      };
    case TypeKind.AnyRef:
      return {
        type: NodeType.TypeAnnotation,
        name: 'anyref',
      };
    case TypeKind.Union:
      return {
        type: NodeType.TypeAnnotation,
        name: 'anyref',
      };
    default:
      return {
        type: NodeType.TypeAnnotation,
        name: 'any',
      };
  }
}

export function mapCheckerTypeToWasmType(
  ctx: CodegenContext,
  type: Type,
): number[] {
  if (type.kind === TypeKind.Number) {
    const name = (type as NumberType).name;
    if (name === 'i32') return [ValType.i32];
    if (name === 'i64') return [ValType.i64];
    if (name === 'f32') return [ValType.f32];
    if (name === 'f64') return [ValType.f64];
    return [ValType.i32];
  }
  if (type.kind === TypeKind.Boolean) return [ValType.i32];
  if (type.kind === TypeKind.Void) return [];
  if (type.kind === TypeKind.Null) return [ValType.ref_null, HeapType.none];

  const annotation = typeToTypeAnnotation(type);
  return mapType(ctx, annotation, ctx.currentTypeContext);
}

function generateBrandType(ctx: CodegenContext, id: number): number {
  const fields: {type: number[]; mutable: boolean}[] = [];
  // Use a mix of i32 and f32 to create unique structures
  // We use the binary representation of id
  // 0 -> i32
  // 1 -> f32
  if (id === 0) {
    fields.push({type: [ValType.i32], mutable: false});
  } else {
    let n = id;
    while (n > 0) {
      if (n & 1) {
        fields.push({type: [ValType.f32], mutable: false});
      } else {
        fields.push({type: [ValType.i32], mutable: false});
      }
      n >>>= 1;
    }
  }
  return ctx.module.addStructType(fields);
}
