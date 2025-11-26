import {
  NodeType,
  type AccessorDeclaration,
  type ClassDeclaration,
  type FieldDefinition,
  type InterfaceDeclaration,
  type MethodDefinition,
  type TypeAnnotation,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {GcOpcode, Opcode, ValType, HeapType} from '../wasm.js';
import type {CodegenContext} from './context.js';
import type {ClassInfo, InterfaceInfo} from './types.js';
import {generateBlockStatement} from './statements.js';
import {generateExpression} from './expressions.js';

export function registerInterface(
  ctx: CodegenContext,
  decl: InterfaceDeclaration,
) {
  // 1. Create VTable Struct Type
  // (struct (field (ref (func (param any) ...))) ...)
  const vtableFields: {type: number[]; mutable: boolean}[] = [];
  const methodIndices = new Map<string, {index: number; typeIndex: number}>();

  let methodIndex = 0;
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
    }
  }

  const vtableTypeIndex = ctx.module.addStructType(vtableFields);

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

  ctx.interfaces.set(decl.name.name, {
    structTypeIndex,
    vtableTypeIndex,
    methods: methodIndices,
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

    const vtableEntries: number[] = [];

    for (const [methodName, methodInfo] of interfaceInfo.methods) {
      const trampolineIndex = generateTrampoline(
        ctx,
        classInfo,
        methodName,
        methodInfo.typeIndex,
      );
      vtableEntries.push(trampolineIndex);
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
  index: number,
): ClassInfo | undefined {
  for (const info of ctx.classes.values()) {
    if (info.structTypeIndex === index) return info;
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
    }
  >();
  const vtable: string[] = [];

  if (decl.superClass) {
    const superClassInfo = ctx.classes.get(decl.superClass.name);
    if (!superClassInfo) {
      throw new Error(`Unknown superclass ${decl.superClass.name}`);
    }
    superTypeIndex = superClassInfo.structTypeIndex;

    // Inherit fields
    const sortedSuperFields = Array.from(superClassInfo.fields.entries()).sort(
      (a, b) => a[1].index - b[1].index,
    );

    for (const [name, info] of sortedSuperFields) {
      fields.set(name, {index: fieldIndex++, type: info.type});
      fieldTypes.push({type: info.type, mutable: true});
    }

    // Inherit methods and vtable
    if (superClassInfo.vtable) {
      vtable.push(...superClassInfo.vtable);
    }
    for (const [name, info] of superClassInfo.methods) {
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

  const structTypeIndex = ctx.module.addStructType(fieldTypes, superTypeIndex);

  if (decl.name.name === 'String') {
    ctx.stringTypeIndex = structTypeIndex;
  }

  const classInfo: ClassInfo = {
    name: decl.name.name,
    structTypeIndex,
    fields,
    methods,
    vtable,
  };
  ctx.classes.set(decl.name.name, classInfo);

  // Register methods
  const members = [...decl.body];
  const hasConstructor = members.some(
    (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
  );
  if (!hasConstructor) {
    members.push({
      type: NodeType.MethodDefinition,
      name: {type: NodeType.Identifier, name: '#new'},
      params: [],
      body: {type: NodeType.BlockStatement, body: []},
      isFinal: false,
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
        });
      }
    }
  }
  // Create VTable Struct Type
  let vtableSuperTypeIndex: number | undefined;
  if (decl.superClass) {
    const superClassInfo = ctx.classes.get(decl.superClass.name)!;
    vtableSuperTypeIndex = superClassInfo.vtableTypeIndex;
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

  ctx.bodyGenerators.push(() => {
    generateClassMethods(ctx, decl);
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
    members.push({
      type: NodeType.MethodDefinition,
      name: {type: NodeType.Identifier, name: '#new'},
      params: [],
      body: {type: NodeType.BlockStatement, body: []},
      isFinal: false,
    } as MethodDefinition);
  }

  for (const member of members) {
    if (member.type === NodeType.MethodDefinition) {
      const methodInfo = classInfo.methods.get(member.name.name)!;
      const body: number[] = [];

      ctx.pushScope();
      ctx.nextLocalIndex = 0;
      ctx.extraLocals = [];

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

      if (member.name.name === '#new') {
        if (decl.superClass) {
          const superClassInfo = ctx.classes.get(decl.superClass.name)!;
          const superCtor = superClassInfo.methods.get('#new');
          if (superCtor) {
            body.push(Opcode.local_get, 0);
            body.push(Opcode.call);
            body.push(...WasmModule.encodeSignedLEB128(superCtor.index));
          }
        }

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

      if (member.body.type === NodeType.BlockStatement) {
        generateBlockStatement(ctx, member.body, body);
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

        // Params
        // 0: this
        ctx.defineLocal('this', ctx.nextLocalIndex++, methodInfo.paramTypes[0]);

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

        // Params
        // 0: this
        ctx.defineLocal('this', ctx.nextLocalIndex++, methodInfo.paramTypes[0]);
        // 1: value
        ctx.defineLocal(
          member.setter.param.name,
          ctx.nextLocalIndex++,
          methodInfo.paramTypes[1],
        );

        generateBlockStatement(ctx, member.setter.body, body);
        body.push(Opcode.end);

        ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
        ctx.popScope();
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
    }
  >();
  const vtable: string[] = [];

  const classInfo: ClassInfo = {
    name: specializedName,
    structTypeIndex,
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
    members.push({
      type: NodeType.MethodDefinition,
      name: {type: NodeType.Identifier, name: '#new'},
      params: [],
      body: {type: NodeType.BlockStatement, body: []},
      isFinal: false,
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
