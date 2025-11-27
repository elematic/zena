import {
  NodeType,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type MethodDefinition,
  type MixinDeclaration,
  type TypeAnnotation,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {ExportDesc, GcOpcode, HeapType, Opcode, ValType} from '../wasm.js';
import type {CodegenContext} from './context.js';
import {generateExpression, getHeapTypeIndex} from './expressions.js';
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
  const methodIndices = new Map<string, {index: number; typeIndex: number}>();
  const fieldIndices = new Map<string, {index: number; typeIndex: number}>();

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

  for (const member of decl.body) {
    if (member.type === NodeType.MethodSignature) {
      // Function type: (param any, ...params) -> result
      const params: number[][] = [[ValType.ref_null, ValType.anyref]]; // 'this' is (ref null any)
      for (const param of member.params) {
        params.push(mapType(ctx, param.typeAnnotation));
      }
      const results: number[][] = [];
      if (member.returnType) {
        const mapped = mapType(ctx, member.returnType);
        if (mapped.length > 0) results.push(mapped);
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
      });
    } else if (member.type === NodeType.FieldDefinition) {
      // Field getter: (param any) -> Type
      const params: number[][] = [[ValType.ref_null, ValType.anyref]];
      const results: number[][] = [];
      const mapped = mapType(ctx, member.typeAnnotation);
      if (mapped.length > 0) results.push(mapped);

      const funcTypeIndex = ctx.module.addType(params, results);

      // Field in VTable: (ref funcType)
      vtableFields.push({
        type: [ValType.ref, ...WasmModule.encodeSignedLEB128(funcTypeIndex)],
        mutable: false,
      });

      fieldIndices.set(member.name.name, {
        index: methodIndex++,
        typeIndex: funcTypeIndex,
      });
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
  const classMethod = classInfo.methods.get(methodName)!;
  const trampolineIndex = ctx.module.addFunction(typeIndex);

  const body: number[] = [];

  // Locals:
  // 0..N: Params (Param 0 is 'any', 1..N are args)
  // N+1: Casted 'this'

  const paramCount = classMethod.paramTypes.length;
  const castedThisLocal = paramCount;
  const locals = [
    [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
    ],
  ];

  // local.set $castedThis (ref.cast $Task (local.get 0))
  body.push(Opcode.local_get, 0);
  body.push(
    0xfb,
    GcOpcode.ref_cast_null,
    ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
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
  for (let i = 1; i < classMethod.paramTypes.length; i++) {
    body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(i));
  }
  body.push(Opcode.call, ...WasmModule.encodeSignedLEB128(classMethod.index));
  body.push(Opcode.end);

  ctx.module.addCode(trampolineIndex, locals, body);
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

  // Param 0: this (anyref)
  // Cast to class type
  const castedThisLocal = 1;
  locals.push([
    ValType.ref_null,
    ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
  ]);

  // Cast
  body.push(Opcode.local_get, 0);
  body.push(
    0xfb,
    GcOpcode.ref_cast_null,
    ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
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
      ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
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

export function registerClass(ctx: CodegenContext, decl: ClassDeclaration) {
  // console.log(`Registering class ${decl.name.name}`);
  if (decl.typeParameters && decl.typeParameters.length > 0) {
    ctx.genericClasses.set(decl.name.name, decl);
    return;
  }

  const fields = new Map<string, {index: number; type: number[]}>();
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

    // Inherit methods and vtable
    if (currentSuperClassInfo.vtable) {
      vtable.push(...currentSuperClassInfo.vtable);
    }
    for (const [name, info] of currentSuperClassInfo.methods) {
      methods.set(name, info);
    }
  } else {
    // Root class: Add vtable field
    fields.set('__vtable', {index: fieldIndex++, type: [ValType.eqref]});
    fieldTypes.push({type: [ValType.eqref], mutable: true});
  }

  for (const member of decl.body) {
    if (member.type === NodeType.FieldDefinition) {
      const wasmType = mapType(ctx, member.typeAnnotation);
      const fieldName = manglePrivateName(decl.name.name, member.name.name);

      if (!fields.has(fieldName)) {
        fields.set(fieldName, {index: fieldIndex++, type: wasmType});
        fieldTypes.push({type: wasmType, mutable: true});
      }
    }
  }

  // Special handling for String class: reuse pre-allocated type index
  // The String type is created early in CodegenContext to allow declared
  // functions with string parameters to work correctly.
  let structTypeIndex: number;
  if (decl.name.name === 'String' && ctx.stringTypeIndex >= 0) {
    // Reuse the pre-allocated String type index
    structTypeIndex = ctx.stringTypeIndex;
  } else {
    structTypeIndex = ctx.module.addStructType(fieldTypes, superTypeIndex);
    if (decl.name.name === 'String') {
      ctx.stringTypeIndex = structTypeIndex;
    }
  }

  const classInfo: ClassInfo = {
    name: decl.name.name,
    structTypeIndex,
    superClass: currentSuperClassInfo?.name,
    fields,
    methods,
    vtable,
    isFinal: decl.isFinal,
  };
  ctx.classes.set(decl.name.name, classInfo);

  // Register methods
  const members = [...decl.body];
  const hasConstructor = members.some(
    (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
  );
  if (!hasConstructor) {
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
    } as MethodDefinition);
  }

  for (const member of members) {
    if (member.type === NodeType.MethodDefinition) {
      const methodName = member.name.name;

      if (methodName !== '#new' && !vtable.includes(methodName)) {
        vtable.push(methodName);
      }

      let thisType = [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(structTypeIndex),
      ];

      if (currentSuperClassInfo) {
        if (
          methodName !== '#new' &&
          currentSuperClassInfo.methods.has(methodName)
        ) {
          thisType =
            currentSuperClassInfo.methods.get(methodName)!.paramTypes[0];
        }
      }

      const params = [thisType];
      for (const param of member.params) {
        params.push(mapType(ctx, param.typeAnnotation));
      }

      let results: number[][] = [];
      if (methodName === '#new') {
        results = [];
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

      const funcIndex = ctx.module.addFunction(typeIndex!);

      const returnType = results.length > 0 ? results[0] : [];
      methods.set(methodName, {
        index: funcIndex,
        returnType,
        typeIndex: typeIndex!,
        paramTypes: params,
        isFinal: member.isFinal,
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

        let thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

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

        let thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

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
      // Register implicit accessors for public fields
      if (!member.name.name.startsWith('#')) {
        const propName = member.name.name;
        const propType = mapType(ctx, member.typeAnnotation);

        // Getter
        const getterName = `get_${propName}`;
        if (!vtable.includes(getterName)) {
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

        const funcIndex = ctx.module.addFunction(typeIndex!);

        methods.set(getterName, {
          index: funcIndex,
          returnType: results[0],
          typeIndex: typeIndex!,
          paramTypes: params,
          isFinal: member.isFinal,
        });

        // Setter (if mutable)
        if (!member.isFinal) {
          const setterName = `set_${propName}`;
          if (!vtable.includes(setterName)) {
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

          const setterFuncIndex = ctx.module.addFunction(setterTypeIndex!);

          methods.set(setterName, {
            index: setterFuncIndex,
            returnType: [],
            typeIndex: setterTypeIndex!,
            paramTypes: setterParams,
            isFinal: member.isFinal,
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
    vtable.map(() => ({type: [ValType.funcref], mutable: false})),
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

  if (decl.exported) {
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
) {
  const className = specializedName || decl.name.name;
  const classInfo = ctx.classes.get(className)!;
  ctx.currentClass = classInfo;

  const members = [...decl.body];
  const hasConstructor = members.some(
    (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
  );
  if (!hasConstructor) {
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
    } as MethodDefinition);
  }

  for (const member of members) {
    if (member.type === NodeType.MethodDefinition) {
      const methodInfo = classInfo.methods.get(member.name.name)!;
      const body: number[] = [];

      ctx.pushScope();
      ctx.nextLocalIndex = 0;
      ctx.extraLocals = [];
      ctx.thisLocalIndex = 0;

      // Params
      // 0: this
      ctx.defineLocal('this', ctx.nextLocalIndex++, methodInfo.paramTypes[0]);

      for (let i = 0; i < member.params.length; i++) {
        const param = member.params[i];
        ctx.defineLocal(
          param.name.name,
          ctx.nextLocalIndex++,
          methodInfo.paramTypes[i + 1],
        );
      }

      // Downcast 'this' if needed (e.g. overriding a method from a superclass)
      const thisTypeIndex = getHeapTypeIndex(ctx, methodInfo.paramTypes[0]);
      if (thisTypeIndex !== -1 && thisTypeIndex !== classInfo.structTypeIndex) {
        const realThisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
        ];
        const realThisLocal = ctx.nextLocalIndex++;
        ctx.extraLocals.push(realThisType);

        body.push(Opcode.local_get, 0);
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
        body.push(Opcode.local_set, realThisLocal);

        ctx.defineLocal('this', realThisLocal, realThisType);
        ctx.thisLocalIndex = realThisLocal;
      }

      if (member.isAbstract) {
        body.push(Opcode.unreachable);
        body.push(Opcode.end);
        ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
        ctx.popScope();
        continue;
      }

      if (member.name.name === '#new') {
        const hasSuperClass = !!classInfo.superClass;

        if (!hasSuperClass) {
          for (const m of decl.body) {
            if (m.type === NodeType.FieldDefinition && m.value) {
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
      } else {
        if (member.body && member.body.type === NodeType.BlockStatement) {
          generateBlockStatement(ctx, member.body, body);
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
        if (
          thisTypeIndex !== -1 &&
          thisTypeIndex !== classInfo.structTypeIndex
        ) {
          const realThisType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          ];
          const realThisLocal = ctx.nextLocalIndex++;
          ctx.extraLocals.push(realThisType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          );
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
        if (
          thisTypeIndex !== -1 &&
          thisTypeIndex !== classInfo.structTypeIndex
        ) {
          const realThisType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          ];
          const realThisLocal = ctx.nextLocalIndex++;
          ctx.extraLocals.push(realThisType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          );
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
  ctx.currentClass = null;
}

export function mapType(
  ctx: CodegenContext,
  annotation?: TypeAnnotation,
  typeContext?: Map<string, TypeAnnotation>,
): number[] {
  if (!annotation) return [ValType.i32];

  if (annotation.type === NodeType.UnionTypeAnnotation) {
    // TODO: Proper union type mapping
    return [ValType.ref_null, HeapType.any];
  }

  // Check type context first
  if (typeContext && typeContext.has(annotation.name)) {
    return mapType(ctx, typeContext.get(annotation.name)!, typeContext);
  }

  if (ctx.interfaces.has(annotation.name)) {
    const info = ctx.interfaces.get(annotation.name)!;
    return [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(info.structTypeIndex),
    ];
  }

  if (annotation.name === 'i32') return [ValType.i32];
  if (annotation.name === 'f32') return [ValType.f32];
  if (annotation.name === 'boolean') return [ValType.i32];
  if (annotation.name === 'string') {
    return [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
    ];
  }
  if (annotation.name === 'ByteArray') {
    return [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex),
    ];
  }
  if (annotation.name === 'Array') {
    if (annotation.typeArguments && annotation.typeArguments.length === 1) {
      const elementType = mapType(
        ctx,
        annotation.typeArguments[0],
        typeContext,
      );
      const arrayTypeIndex = ctx.getArrayTypeIndex(elementType);
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(arrayTypeIndex),
      ];
    }
  }
  if (annotation.name === 'void') return [];

  // Handle generics
  if (annotation.typeArguments && annotation.typeArguments.length > 0) {
    const typeArgKeys = annotation.typeArguments.map((arg) =>
      getTypeKey(ctx, arg, typeContext),
    );
    const specializedName = `${annotation.name}<${typeArgKeys.join(',')}>`;

    if (!ctx.classes.has(specializedName)) {
      const decl = ctx.genericClasses.get(annotation.name);
      if (!decl) throw new Error(`Generic class ${annotation.name} not found`);
      instantiateClass(
        ctx,
        decl,
        specializedName,
        annotation.typeArguments,
        typeContext,
      );
    }

    const info = ctx.classes.get(specializedName)!;
    return [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(info.structTypeIndex),
    ];
  }

  const classInfo = ctx.classes.get(annotation.name);
  if (classInfo) {
    return [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
    ];
  }
  console.log(
    `Class ${annotation.name} not found in ctx.classes. Available: ${Array.from(ctx.classes.keys()).join(', ')}`,
  );

  return [ValType.i32];
}

export function getTypeKey(
  ctx: CodegenContext,
  annotation: TypeAnnotation,
  typeContext?: Map<string, TypeAnnotation>,
): string {
  if (annotation.type === NodeType.UnionTypeAnnotation) {
    return annotation.types
      .map((t) => getTypeKey(ctx, t, typeContext))
      .join('|');
  }

  if (typeContext && typeContext.has(annotation.name)) {
    return getTypeKey(ctx, typeContext.get(annotation.name)!, typeContext);
  }

  if (annotation.typeArguments && annotation.typeArguments.length > 0) {
    const args = annotation.typeArguments
      .map((a) => getTypeKey(ctx, a, typeContext))
      .join(',');
    return `${annotation.name}<${args}>`;
  }
  return annotation.name;
}

function resolveAnnotation(
  annotation: TypeAnnotation,
  context?: Map<string, TypeAnnotation>,
): TypeAnnotation {
  if (annotation.type === NodeType.UnionTypeAnnotation) {
    return {
      type: NodeType.UnionTypeAnnotation,
      types: annotation.types.map((t) => resolveAnnotation(t, context)),
    };
  }

  if (context && context.has(annotation.name)) {
    return resolveAnnotation(context.get(annotation.name)!, context);
  }
  return annotation;
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

  const structTypeIndex = ctx.module.addStructType(fieldTypes);
  const methods = new Map<
    string,
    {
      index: number;
      returnType: number[];
      typeIndex: number;
      paramTypes: number[][];
      isFinal?: boolean;
    }
  >();
  const vtable: string[] = [];

  const classInfo: ClassInfo = {
    name: specializedName,
    structTypeIndex,
    superClass: decl.superClass?.name,
    fields,
    methods,
    vtable, // TODO: Populate vtable for generics
  };
  ctx.classes.set(specializedName, classInfo);

  // Register methods
  const members = [...decl.body];
  const hasConstructor = members.some(
    (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
  );
  if (!hasConstructor) {
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
    } as MethodDefinition);
  }

  for (const member of members) {
    if (member.type === NodeType.MethodDefinition) {
      const methodName = member.name.name;
      if (methodName !== '#new') vtable.push(methodName);

      const params = [
        [ValType.ref_null, ...WasmModule.encodeSignedLEB128(structTypeIndex)],
      ];
      for (const param of member.params) {
        params.push(mapType(ctx, param.typeAnnotation, context));
      }

      let results: number[][] = [];
      if (methodName === '#new') {
        results = [];
      } else if (member.returnType) {
        const mapped = mapType(ctx, member.returnType, context);
        if (mapped.length > 0) results = [mapped];
      } else {
        results = [];
      }

      const typeIndex = ctx.module.addType(params, results);
      const funcIndex = ctx.module.addFunction(typeIndex);

      const returnType = results.length > 0 ? results[0] : [];
      methods.set(methodName, {
        index: funcIndex,
        returnType,
        typeIndex,
        paramTypes: params,
      });
    }
  }

  // Add implicit accessors to methods map
  for (const member of decl.body) {
    if (
      member.type === NodeType.FieldDefinition &&
      !member.name.name.startsWith('#')
    ) {
      const propName = member.name.name;
      const getterName = `get_${propName}`;
      const setterName = `set_${propName}`;

      // Getter
      vtable.push(getterName);
      const getterParams = [
        [ValType.ref_null, ...WasmModule.encodeSignedLEB128(structTypeIndex)],
      ];
      const fieldType = mapType(ctx, member.typeAnnotation, context);
      const getterResults = [fieldType];
      const getterTypeIndex = ctx.module.addType(getterParams, getterResults);
      const getterFuncIndex = ctx.module.addFunction(getterTypeIndex);

      methods.set(getterName, {
        index: getterFuncIndex,
        returnType: fieldType,
        typeIndex: getterTypeIndex,
        paramTypes: getterParams,
      });

      // Setter
      if (!member.isFinal) {
        vtable.push(setterName);
        const setterParams = [
          [ValType.ref_null, ...WasmModule.encodeSignedLEB128(structTypeIndex)],
          fieldType,
        ];
        const setterResults: number[][] = [];
        const setterTypeIndex = ctx.module.addType(setterParams, setterResults);
        const setterFuncIndex = ctx.module.addFunction(setterTypeIndex);

        methods.set(setterName, {
          index: setterFuncIndex,
          returnType: [],
          typeIndex: setterTypeIndex,
          paramTypes: setterParams,
        });
      }
    }
  }

  // Create VTable Struct Type
  const vtableTypeIndex = ctx.module.addStructType(
    vtable.map(() => ({type: [ValType.funcref], mutable: false})),
  );
  classInfo.vtableTypeIndex = vtableTypeIndex;

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
  classInfo.vtableGlobalIndex = vtableGlobalIndex;

  ctx.bodyGenerators.push(() => {
    const oldContext = ctx.currentTypeContext;
    ctx.currentTypeContext = context;
    generateClassMethods(ctx, decl, specializedName);
    ctx.currentTypeContext = oldContext;
  });
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
    // Inherit methods and vtable
    if (baseClassInfo.vtable) {
      vtable.push(...baseClassInfo.vtable);
    }
    for (const [name, info] of baseClassInfo.methods) {
      methods.set(name, info);
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

  // Register mixin methods (similar to registerClass logic)
  // We use a synthesized ClassDeclaration to reuse logic if possible,
  // but we need to register methods in the map first before generation.

  // We can reuse the logic from registerClass by extracting it, but for now let's duplicate/adapt
  // the registration part.

  // Synthesize a ClassDeclaration for registration
  const decl: ClassDeclaration = {
    type: NodeType.ClassDeclaration,
    name: {type: NodeType.Identifier, name: intermediateName},
    superClass: baseClassInfo
      ? {type: NodeType.Identifier, name: baseClassInfo.name}
      : undefined,
    body: mixinDecl.body as any,
    exported: false,
    isFinal: false,
    isAbstract: false,
  };

  // Register methods
  const members = [...decl.body];
  const hasConstructor = members.some(
    (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
  );
  if (!hasConstructor) {
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
    } as MethodDefinition);
  }

  for (const member of members) {
    if (member.type === NodeType.MethodDefinition) {
      const methodName = member.name.name;

      if (methodName !== '#new' && !vtable.includes(methodName)) {
        vtable.push(methodName);
      }

      let thisType = [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(structTypeIndex),
      ];

      if (decl.superClass) {
        const superClassInfo = ctx.classes.get(decl.superClass.name)!;
        if (methodName !== '#new' && superClassInfo.methods.has(methodName)) {
          thisType = superClassInfo.methods.get(methodName)!.paramTypes[0];
        }
      }

      const params = [thisType];
      for (const param of member.params) {
        params.push(mapType(ctx, param.typeAnnotation));
      }

      let results: number[][] = [];
      if (methodName === '#new') {
        results = [];
      } else if (member.returnType) {
        const mapped = mapType(ctx, member.returnType);
        if (mapped.length > 0) results = [mapped];
      } else {
        results = [];
      }

      let typeIndex: number;
      let isOverride = false;
      if (decl.superClass) {
        const superClassInfo = ctx.classes.get(decl.superClass.name)!;
        if (methodName !== '#new' && superClassInfo.methods.has(methodName)) {
          typeIndex = superClassInfo.methods.get(methodName)!.typeIndex;
          isOverride = true;
        }
      }

      if (!isOverride) {
        typeIndex = ctx.module.addType(params, results);
      }

      const funcIndex = ctx.module.addFunction(typeIndex!);

      const returnType = results.length > 0 ? results[0] : [];
      methods.set(methodName, {
        index: funcIndex,
        returnType,
        typeIndex: typeIndex!,
        paramTypes: params,
        isFinal: member.isFinal,
      });
    } else if (member.type === NodeType.AccessorDeclaration) {
      // ... Accessor logic similar to registerClass ...
      // For brevity, assuming mixins use methods mostly, but we should support accessors.
      // Copying accessor logic from registerClass:
      const propName = member.name.name;
      const propType = mapType(ctx, member.typeAnnotation);

      // Getter
      if (member.getter) {
        const methodName = `get_${propName}`;
        if (!vtable.includes(methodName)) {
          vtable.push(methodName);
        }

        let thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

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

        let thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

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
      // Implicit accessors
      if (!member.name.name.startsWith('#')) {
        const propName = member.name.name;
        const propType = mapType(ctx, member.typeAnnotation);

        // Getter
        const getterName = `get_${propName}`;
        if (!vtable.includes(getterName)) {
          vtable.push(getterName);
        }

        let thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

        if (decl.superClass) {
          const superClassInfo = ctx.classes.get(decl.superClass.name)!;
          if (superClassInfo.methods.has(getterName)) {
            thisType = superClassInfo.methods.get(getterName)!.paramTypes[0];
          }
        }

        const params = [thisType];
        const results = [propType];

        let typeIndex: number;
        let isOverride = false;
        if (decl.superClass) {
          const superClassInfo = ctx.classes.get(decl.superClass.name)!;
          if (superClassInfo.methods.has(getterName)) {
            typeIndex = superClassInfo.methods.get(getterName)!.typeIndex;
            isOverride = true;
          }
        }

        if (!isOverride) {
          typeIndex = ctx.module.addType(params, results);
        }

        const funcIndex = ctx.module.addFunction(typeIndex!);

        methods.set(getterName, {
          index: funcIndex,
          returnType: results[0],
          typeIndex: typeIndex!,
          paramTypes: params,
          isFinal: member.isFinal,
        });

        // Setter (if mutable)
        if (!member.isFinal) {
          const setterName = `set_${propName}`;
          if (!vtable.includes(setterName)) {
            vtable.push(setterName);
          }

          const setterParams = [thisType, propType];
          const setterResults: number[][] = [];

          let setterTypeIndex: number;
          let isSetterOverride = false;
          if (decl.superClass) {
            const superClassInfo = ctx.classes.get(decl.superClass.name)!;
            if (superClassInfo.methods.has(setterName)) {
              setterTypeIndex =
                superClassInfo.methods.get(setterName)!.typeIndex;
              isSetterOverride = true;
            }
          }

          if (!isSetterOverride) {
            setterTypeIndex = ctx.module.addType(setterParams, setterResults);
          }

          const setterFuncIndex = ctx.module.addFunction(setterTypeIndex!);

          methods.set(setterName, {
            index: setterFuncIndex,
            returnType: [],
            typeIndex: setterTypeIndex!,
            paramTypes: setterParams,
            isFinal: member.isFinal,
          });
        }
      }
    }
  }

  // Create VTable Struct Type
  let vtableSuperTypeIndex: number | undefined;
  if (baseClassInfo) {
    vtableSuperTypeIndex = baseClassInfo.vtableTypeIndex;
  }

  const vtableTypeIndex = ctx.module.addStructType(
    vtable.map(() => ({type: [ValType.funcref], mutable: false})),
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

  ctx.bodyGenerators.push(() => {
    generateMixinMethods(ctx, mixinDecl, classInfo);
  });

  return classInfo;
}

function generateMixinMethods(
  ctx: CodegenContext,
  mixinDecl: MixinDeclaration,
  classInfo: ClassInfo,
) {
  const decl: ClassDeclaration = {
    type: NodeType.ClassDeclaration,
    name: {type: NodeType.Identifier, name: classInfo.name},
    superClass: classInfo.superClass
      ? {type: NodeType.Identifier, name: classInfo.superClass}
      : undefined,
    body: mixinDecl.body as any,
    exported: false,
    isFinal: false,
    isAbstract: false,
  };

  generateClassMethods(ctx, decl, classInfo.name);
}
