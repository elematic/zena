import {
  NodeType,
  type ClassDeclaration,
  type FunctionTypeAnnotation,
  type InterfaceDeclaration,
  type LiteralTypeAnnotation,
  type MethodDefinition,
  type MixinDeclaration,
  type RecordTypeAnnotation,
  type TupleTypeAnnotation,
  type TypeAnnotation,
  type Identifier,
  type ComputedPropertyName,
} from '../ast.js';
import {
  Decorators,
  TypeKind,
  Types,
  TypeNames,
  type Type,
  type ClassType,
  type NumberType,
  type InterfaceType,
  type ArrayType,
  type RecordType,
  type TupleType,
  type FunctionType,
  type UnionType,
  type TypeParameterType,
  type TypeAliasType,
  type SymbolType,
  type LiteralType,
} from '../types.js';
import {getGetterName, getSetterName} from '../names.js';
import {WasmModule} from '../emitter.js';
import {DiagnosticCode} from '../diagnostics.js';

/**
 * Extracts the name from a TypeAnnotation.
 * Assumes the annotation is a NamedTypeAnnotation (type === NodeType.TypeAnnotation).
 */
const getTypeAnnotationName = (annotation: TypeAnnotation): string => {
  if (annotation.type === NodeType.TypeAnnotation) {
    return annotation.name;
  }
  throw new Error(`Expected NamedTypeAnnotation, got ${annotation.type}`);
};

export function getMemberName(name: Identifier | ComputedPropertyName): string {
  if (name.type === NodeType.Identifier) {
    return name.name;
  }
  const symbolType = name.expression.inferredType as SymbolType;
  if (
    symbolType &&
    symbolType.kind === TypeKind.Symbol &&
    symbolType.uniqueId
  ) {
    return symbolType.uniqueId;
  }
  throw new Error(`Could not resolve member name for ${name.type}`);
}

import {ExportDesc, GcOpcode, HeapType, Opcode, ValType} from '../wasm.js';
import type {CodegenContext} from './context.js';
import {
  generateExpression,
  getHeapTypeIndex,
  boxPrimitive,
  unboxPrimitive,
  isInterfaceSubtype,
} from './expressions.js';
import {
  generateBlockStatement,
  generateFunctionStatement,
} from './statements.js';
import type {ClassInfo, InterfaceInfo} from './types.js';

/**
 * Pre-registers an interface by reserving type indices for the fat pointer struct
 * and vtable struct. This must be called before classes are registered so that
 * interface types are available for class implements clauses.
 *
 * The actual method types are populated later by defineInterfaceMethods, after
 * all classes have been pre-registered.
 */
export function preRegisterInterface(
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
        preRegisterInterface(ctx, parentDecl);
        parentInfo = ctx.interfaces.get(parentName);
      }
    }
  }

  // Reserve vtable struct type with no fields initially
  // This will be updated in defineInterfaceMethods
  const vtableTypeIndex = ctx.module.addStructType(
    [],
    parentInfo?.vtableTypeIndex,
  );

  // Create interface struct type (fat pointer)
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

  // Register with empty methods/fields - will be populated by defineInterfaceMethods
  ctx.interfaces.set(decl.name.name, {
    structTypeIndex,
    vtableTypeIndex,
    methods: new Map(),
    fields: new Map(),
    parent: parentName,
  });

  // Register type → struct index for identity-based lookups
  if (decl.inferredType && decl.inferredType.kind === TypeKind.Interface) {
    ctx.setInterfaceStructIndex(
      decl.inferredType as InterfaceType,
      structTypeIndex,
    );
  }
}

/**
 * Defines the method and field types for an interface.
 * This must be called after all classes have been pre-registered so that
 * mapType can resolve class types correctly.
 */
export function defineInterfaceMethods(
  ctx: CodegenContext,
  decl: InterfaceDeclaration,
) {
  const interfaceInfo = ctx.interfaces.get(decl.name.name);
  if (!interfaceInfo) {
    throw new Error(
      `Interface ${decl.name.name} was not pre-registered before defineInterfaceMethods`,
    );
  }

  // Skip if methods are already defined
  if (interfaceInfo.methods.size > 0 || interfaceInfo.fields.size > 0) {
    // Check if this is a parent interface that may need its methods defined first
    // by checking if any member exists in the declaration
    const hasMembers = decl.body.some(
      (m) =>
        m.type === NodeType.MethodSignature ||
        m.type === NodeType.FieldDefinition ||
        m.type === NodeType.AccessorSignature,
    );
    if (!hasMembers || interfaceInfo.methods.size > 0) {
      return;
    }
  }

  let parentInfo: InterfaceInfo | undefined;
  if (interfaceInfo.parent) {
    parentInfo = ctx.interfaces.get(interfaceInfo.parent);

    // Ensure parent methods are defined first
    if (parentInfo && parentInfo.methods.size === 0) {
      const parentDecl = ctx.program.body.find(
        (s) =>
          s.type === NodeType.InterfaceDeclaration &&
          (s as InterfaceDeclaration).name.name === interfaceInfo.parent,
      ) as InterfaceDeclaration | undefined;
      if (parentDecl) {
        defineInterfaceMethods(ctx, parentDecl);
        parentInfo = ctx.interfaces.get(interfaceInfo.parent);
      }
    }
  }

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
        name: TypeNames.AnyRef,
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

      methodIndices.set(getMemberName(member.name), {
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

      fieldIndices.set(getMemberName(member.name), {
        index: methodIndex++,
        typeIndex: funcTypeIndex,
        type: fieldType,
      });
    } else if (member.type === NodeType.AccessorSignature) {
      const propName = getMemberName(member.name);
      const propType = mapType(ctx, member.typeAnnotation, context);

      if (member.hasGetter) {
        const methodName = getGetterName(propName);

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
        const methodName = getSetterName(propName);

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

  // Update the vtable struct type with the actual fields
  // The vtable type was reserved in preRegisterInterface with no fields
  ctx.module.updateStructType(
    interfaceInfo.vtableTypeIndex,
    vtableFields,
    parentInfo?.vtableTypeIndex,
  );

  // Update the interface info with the method and field maps
  interfaceInfo.methods = methodIndices;
  interfaceInfo.fields = fieldIndices;
}

/**
 * @deprecated Use preRegisterInterface followed by defineInterfaceMethods instead.
 */
export function registerInterface(
  ctx: CodegenContext,
  decl: InterfaceDeclaration,
) {
  preRegisterInterface(ctx, decl);
  defineInterfaceMethods(ctx, decl);
}

export function generateTrampoline(
  ctx: CodegenContext,
  classInfo: ClassInfo,
  methodName: string,
  typeIndex: number,
): number {
  const trampolineIndex = ctx.module.addFunction(typeIndex);

  // Save context state for nested function generation
  const savedContext = ctx.saveFunctionContext();

  // Initialize new function context
  ctx.pushFunctionScope();

  const body: number[] = [];

  // Register parameters
  const params = ctx.module.getFunctionTypeParams(typeIndex);
  // Param 0 is 'this' (anyref)
  ctx.defineParam('this', params[0]);

  for (let i = 1; i < params.length; i++) {
    ctx.defineParam(`arg${i}`, params[i]);
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

    // Check if interface param is anyref (either as single byte or ref_null anyref)
    const isAnyRef =
      (interfaceParamType.length === 1 &&
        interfaceParamType[0] === ValType.anyref) ||
      (interfaceParamType.length === 2 &&
        interfaceParamType[0] === ValType.ref_null &&
        interfaceParamType[1] === ValType.anyref);

    // Adapt if needed (unbox/cast)
    if (isAnyRef) {
      if (
        classParamType.length === 1 &&
        (classParamType[0] === ValType.i32 ||
          classParamType[0] === ValType.i64 ||
          classParamType[0] === ValType.f32 ||
          classParamType[0] === ValType.f64)
      ) {
        unboxPrimitive(ctx, classParamType, body);
      } else if (
        classParamType.length > 1 &&
        (classParamType[0] === ValType.ref ||
          classParamType[0] === ValType.ref_null)
      ) {
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...classParamType.slice(1));
      }
    } else {
      // Check if both are closure types but with different type indices
      // This happens when the interface has `this` type in callback params
      const interfaceTypeIndex = decodeTypeIndex(interfaceParamType);
      const classTypeIndex = decodeTypeIndex(classParamType);

      if (
        interfaceTypeIndex !== -1 &&
        classTypeIndex !== -1 &&
        interfaceTypeIndex !== classTypeIndex
      ) {
        const interfaceClosure = ctx.closureStructs.get(interfaceTypeIndex);
        const classClosure = ctx.closureStructs.get(classTypeIndex);

        if (interfaceClosure && classClosure) {
          // Need to create a wrapper closure that adapts the callback
          // The interface callback has anyref param, class callback has specific type
          // Wrapper: takes specific type, casts to anyref (no-op upcast), calls interface callback

          const wrapperFuncIndex = ctx.module.addFunction(
            classClosure.funcTypeIndex,
          );
          ctx.module.declareFunction(wrapperFuncIndex);

          // Store the interface closure in a temp local for the wrapper
          const tempClosureLocal = ctx.declareLocal(
            '$$tramp_closure',
            interfaceParamType,
          );
          body.push(
            Opcode.local_set,
            ...WasmModule.encodeSignedLEB128(tempClosureLocal),
          );

          ctx.pendingHelperFunctions.push(() => {
            const wrapperBody: number[] = [];

            // Param 0: context (eqref) - will hold the interface closure
            // Param 1+: arguments with specific types

            // Get the interface closure from context
            wrapperBody.push(Opcode.local_get, 0);
            wrapperBody.push(
              0xfb,
              GcOpcode.ref_cast,
              ...WasmModule.encodeSignedLEB128(interfaceTypeIndex),
            );

            // Get interface closure's context
            wrapperBody.push(
              0xfb,
              GcOpcode.struct_get,
              ...WasmModule.encodeSignedLEB128(interfaceTypeIndex),
              ...WasmModule.encodeSignedLEB128(1),
            ); // context field

            // Get params from wrapper and pass to interface closure
            // Interface closure expects anyref params (or other erased types)
            const classFuncParams = ctx.module.getFunctionTypeParams(
              classClosure.funcTypeIndex,
            );

            for (let j = 1; j < classFuncParams.length; j++) {
              wrapperBody.push(Opcode.local_get, j);
              // No cast needed - subtyping allows specific type where anyref is expected
            }

            // Get interface closure's func ref
            wrapperBody.push(Opcode.local_get, 0);
            wrapperBody.push(
              0xfb,
              GcOpcode.ref_cast,
              ...WasmModule.encodeSignedLEB128(interfaceTypeIndex),
            );
            wrapperBody.push(
              0xfb,
              GcOpcode.struct_get,
              ...WasmModule.encodeSignedLEB128(interfaceTypeIndex),
              ...WasmModule.encodeSignedLEB128(0),
            ); // func field

            // Call the interface closure
            wrapperBody.push(
              Opcode.call_ref,
              ...WasmModule.encodeSignedLEB128(interfaceClosure.funcTypeIndex),
            );

            wrapperBody.push(Opcode.end);
            ctx.module.addCode(wrapperFuncIndex, [], wrapperBody);
          });

          // Create the wrapper closure struct
          // func ref to wrapper
          body.push(
            Opcode.ref_func,
            ...WasmModule.encodeSignedLEB128(wrapperFuncIndex),
          );
          // context = the interface closure
          body.push(
            Opcode.local_get,
            ...WasmModule.encodeSignedLEB128(tempClosureLocal),
          );
          // struct.new for class closure type
          body.push(
            0xfb,
            GcOpcode.struct_new,
            ...WasmModule.encodeSignedLEB128(classTypeIndex),
          );
        }
      }
    }
  }

  if (classMethod.intrinsic) {
    if (classMethod.intrinsic === 'array.len') {
      body.push(0xfb, GcOpcode.array_len);
    } else if (classMethod.intrinsic === 'array.get') {
      if (!classInfo.onType)
        throw new Error('array.get intrinsic requires onType');
      const typeIndex = decodeTypeIndex(classInfo.onType);
      body.push(
        0xfb,
        GcOpcode.array_get,
        ...WasmModule.encodeSignedLEB128(typeIndex),
      );
    } else if (classMethod.intrinsic === 'array.get_u') {
      if (!classInfo.onType)
        throw new Error('array.get_u intrinsic requires onType');
      const typeIndex = decodeTypeIndex(classInfo.onType);
      body.push(
        0xfb,
        GcOpcode.array_get_u,
        ...WasmModule.encodeSignedLEB128(typeIndex),
      );
    } else if (classMethod.intrinsic === 'array.set') {
      if (!classInfo.onType)
        throw new Error('array.set intrinsic requires onType');
      const typeIndex = decodeTypeIndex(classInfo.onType);
      body.push(
        0xfb,
        GcOpcode.array_set,
        ...WasmModule.encodeSignedLEB128(typeIndex),
      );
    } else {
      throw new Error(
        `Unsupported intrinsic in trampoline: ${classMethod.intrinsic}`,
      );
    }
  } else {
    body.push(Opcode.call, ...WasmModule.encodeSignedLEB128(classMethod.index));
  }

  // Handle return type adaptation (boxing)
  const classReturnType = classMethod.returnType;

  if (interfaceResults.length > 0 && classReturnType.length > 0) {
    // 1. Primitive Boxing
    if (
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
    // 2. Interface Boxing
    else {
      const interfaceTypeIndex = decodeTypeIndex(interfaceResults[0]);
      const classTypeIndex = decodeTypeIndex(classReturnType);

      if (
        interfaceTypeIndex !== -1 &&
        classTypeIndex !== -1 &&
        interfaceTypeIndex !== classTypeIndex
      ) {
        const interfaceInfo = getInterfaceFromTypeIndex(
          ctx,
          interfaceTypeIndex,
        );

        if (interfaceInfo) {
          let interfaceName: string | undefined;
          for (const [name, info] of ctx.interfaces) {
            if (info === interfaceInfo) {
              interfaceName = name;
              break;
            }
          }

          if (interfaceName) {
            const resultClassInfo = getClassFromTypeIndex(ctx, classTypeIndex);

            if (resultClassInfo && resultClassInfo.implements) {
              let impl = resultClassInfo.implements.get(interfaceName);

              if (!impl) {
                for (const [implName, implInfo] of resultClassInfo.implements) {
                  if (isInterfaceSubtype(ctx, implName, interfaceName)) {
                    impl = implInfo;
                    break;
                  }
                }
              }

              if (impl) {
                // Box it!
                body.push(
                  Opcode.global_get,
                  ...WasmModule.encodeSignedLEB128(impl.vtableGlobalIndex),
                );

                body.push(0xfb, GcOpcode.struct_new);
                body.push(
                  ...WasmModule.encodeSignedLEB128(
                    interfaceInfo.structTypeIndex,
                  ),
                );
              }
            }
          }
        }
      }
    }
  }

  body.push(Opcode.end);

  ctx.module.addCode(trampolineIndex, ctx.extraLocals, body);

  // Restore context state
  ctx.restoreFunctionContext(savedContext);

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
    const getterName = getGetterName(fieldName);
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

/**
 * Pre-registers a class by reserving a type index and adding minimal info to ctx.classes.
 * This must be called for all classes before calling defineClassStruct, to allow
 * self-referential and mutually-recursive class types to work.
 */
export function preRegisterClassStruct(
  ctx: CodegenContext,
  decl: ClassDeclaration,
) {
  if (decl.typeParameters && decl.typeParameters.length > 0) {
    ctx.genericClasses.set(decl.name.name, decl);
    // Register generic template's checker type for identity-based lookups
    if (decl.inferredType && decl.inferredType.kind === TypeKind.Class) {
      ctx.setGenericTemplate(decl.name.name, decl.inferredType as ClassType);
    }
    return;
  }

  // Handle extension classes (e.g. FixedArray extends array<T>)
  // These are handled entirely in preRegister since they don't need deferred definition
  if (decl.isExtension && decl.onType) {
    const onType = mapType(ctx, decl.onType);

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

    // Register type → struct index for identity-based lookups
    if (decl.inferredType && decl.inferredType.kind === TypeKind.Class) {
      ctx.setClassStructIndex(decl.inferredType as ClassType, structTypeIndex);
      // Register bundled name for identity-based lookups
      ctx.setClassBundledName(decl.inferredType as ClassType, decl.name.name);
    }

    // Check if this is the String class
    const isStringClass =
      !!ctx.wellKnownTypes.String &&
      decl.name.name === ctx.wellKnownTypes.String.name.name;

    if (isStringClass) {
      const typeIndex = getHeapTypeIndex(ctx, onType);
      if (typeIndex >= 0) {
        ctx.stringTypeIndex = typeIndex;
      }
    }

    return;
  }

  // Reserve type index for the struct
  const isStringClass =
    !!ctx.wellKnownTypes.String &&
    decl.name.name === ctx.wellKnownTypes.String.name.name;

  // If the superclass is generic, instantiate it first so it gets a lower type index
  if (decl.superClass) {
    const baseSuperName = getTypeAnnotationName(decl.superClass);
    const superTypeArgs =
      decl.superClass.type === NodeType.TypeAnnotation
        ? decl.superClass.typeArguments
        : undefined;

    if (superTypeArgs && superTypeArgs.length > 0) {
      // Superclass is generic - need to instantiate it first
      const specializedName = getSpecializedName(
        baseSuperName,
        superTypeArgs,
        ctx,
      );
      if (!ctx.classes.has(specializedName)) {
        const genericSuperDecl = ctx.genericClasses.get(baseSuperName);
        if (genericSuperDecl) {
          instantiateClass(
            ctx,
            genericSuperDecl,
            specializedName,
            superTypeArgs,
          );
        }
      }
    }
  }

  // If the class uses mixins, pre-register the intermediate mixin classes first
  // They must have lower type indices than this class since they'll be its supertype chain
  if (decl.mixins && decl.mixins.length > 0) {
    let currentSuperClassInfo: ClassInfo | undefined;
    if (decl.superClass) {
      const baseSuperName = getTypeAnnotationName(decl.superClass);
      const superTypeArgs =
        decl.superClass.type === NodeType.TypeAnnotation
          ? decl.superClass.typeArguments
          : undefined;

      let superClassName: string;
      if (superTypeArgs && superTypeArgs.length > 0) {
        superClassName = getSpecializedName(baseSuperName, superTypeArgs, ctx);
      } else {
        superClassName = baseSuperName;
      }
      currentSuperClassInfo = ctx.classes.get(superClassName);
    }

    for (const mixinAnnotation of decl.mixins) {
      if (mixinAnnotation.type !== NodeType.TypeAnnotation) {
        continue;
      }
      const mixinName = mixinAnnotation.name;
      const mixinDecl = ctx.mixins.get(mixinName);
      if (!mixinDecl) {
        continue;
      }
      // Pre-register the intermediate mixin class
      currentSuperClassInfo = preRegisterMixin(
        ctx,
        currentSuperClassInfo,
        mixinDecl,
      );
    }
  }

  // Generate brand type FIRST so it has a lower index than the struct
  // This avoids forward references in the type section (WASM requires types to only
  // reference types with lower indices, unless using rec groups)
  const brandId = ctx.classes.size + 1;
  const brandTypeIndex = generateBrandType(ctx, brandId);

  let structTypeIndex: number;
  if (isStringClass && ctx.stringTypeIndex >= 0) {
    // Reuse the pre-allocated String type index
    structTypeIndex = ctx.stringTypeIndex;
  } else {
    structTypeIndex = ctx.module.reserveType();
    if (isStringClass) {
      ctx.stringTypeIndex = structTypeIndex;
    }
  }

  // Add minimal info to ctx.classes so self-references work
  ctx.classes.set(decl.name.name, {
    name: decl.name.name,
    structTypeIndex,
    brandTypeIndex,
    fields: new Map(),
    methods: new Map(),
    vtable: [],
    isFinal: decl.isFinal,
    isExtension: decl.isExtension,
  });

  // Register type → struct index for identity-based lookups
  if (decl.inferredType && decl.inferredType.kind === TypeKind.Class) {
    ctx.setClassStructIndex(decl.inferredType as ClassType, structTypeIndex);
    // Register bundled name for identity-based lookups
    ctx.setClassBundledName(decl.inferredType as ClassType, decl.name.name);
  }
}

/**
 * Defines the struct type for a class that was pre-registered.
 * This processes all fields and creates the actual WASM struct type.
 */
export function defineClassStruct(ctx: CodegenContext, decl: ClassDeclaration) {
  if (decl.typeParameters && decl.typeParameters.length > 0) {
    // Generic classes are not defined here
    return;
  }

  // Extension classes are fully handled in preRegisterClassStruct
  if (decl.isExtension && decl.onType) {
    return;
  }

  const classInfo = ctx.classes.get(decl.name.name)!;
  const structTypeIndex = classInfo.structTypeIndex;

  const fields = new Map<
    string,
    {index: number; type: number[]; intrinsic?: string}
  >();
  const fieldTypes: {type: number[]; mutable: boolean}[] = [];
  let fieldIndex = 0;

  let superTypeIndex: number | undefined;

  let currentSuperClassInfo: ClassInfo | undefined;
  if (decl.superClass) {
    const baseSuperName = getTypeAnnotationName(decl.superClass);
    const superTypeArgs =
      decl.superClass.type === NodeType.TypeAnnotation
        ? decl.superClass.typeArguments
        : undefined;

    let superClassName: string;
    if (superTypeArgs && superTypeArgs.length > 0) {
      // Superclass is generic - need to get/instantiate the specialized version
      superClassName = getSpecializedName(baseSuperName, superTypeArgs, ctx);

      // Ensure the superclass is instantiated
      if (!ctx.classes.has(superClassName)) {
        const genericSuperDecl = ctx.genericClasses.get(baseSuperName);
        if (genericSuperDecl) {
          instantiateClass(
            ctx,
            genericSuperDecl,
            superClassName,
            superTypeArgs,
          );
        }
      }
    } else {
      superClassName = baseSuperName;
    }

    currentSuperClassInfo = ctx.classes.get(superClassName);
    if (!currentSuperClassInfo) {
      throw new Error(`Unknown superclass ${superClassName}`);
    }
  }

  if (decl.mixins && decl.mixins.length > 0) {
    for (const mixinAnnotation of decl.mixins) {
      if (mixinAnnotation.type !== NodeType.TypeAnnotation) {
        throw new Error('Mixin must be a named type');
      }
      const mixinName = mixinAnnotation.name;
      const mixinDecl = ctx.mixins.get(mixinName);
      if (!mixinDecl) {
        throw new Error(`Unknown mixin ${mixinName}`);
      }
      // TODO: Handle generic mixin instantiation in codegen
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

  // Use the brand type that was pre-generated in preRegisterClassStruct
  const brandTypeIndex = classInfo.brandTypeIndex!;
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
      const fieldName = manglePrivateName(
        decl.name.name,
        getMemberName(member.name),
      );

      if (!fields.has(fieldName)) {
        let intrinsic: string | undefined;
        if (member.decorators) {
          const intrinsicDecorator = member.decorators.find(
            (d) => d.name === Decorators.Intrinsic,
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

  // Define the struct type at the reserved index
  ctx.module.defineStructType(structTypeIndex, fieldTypes, superTypeIndex);

  let onType: number[] | undefined;
  if (decl.isExtension && decl.onType) {
    onType = mapType(ctx, decl.onType);
  }

  // Update classInfo with full data
  classInfo.superClass = currentSuperClassInfo?.name;
  classInfo.fields = fields;
  classInfo.onType = onType;
}

/**
 * @deprecated Use preRegisterClassStruct followed by defineClassStruct instead.
 */
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

    // Check if this is the String class
    const isStringClass =
      !!ctx.wellKnownTypes.String &&
      decl.name.name === ctx.wellKnownTypes.String.name.name;

    if (isStringClass) {
      const typeIndex = getHeapTypeIndex(ctx, onType);
      if (typeIndex >= 0) {
        ctx.stringTypeIndex = typeIndex;
      }
    }

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
    const superClassName = getTypeAnnotationName(decl.superClass);
    currentSuperClassInfo = ctx.classes.get(superClassName);
    if (!currentSuperClassInfo) {
      throw new Error(`Unknown superclass ${superClassName}`);
    }
  }

  if (decl.mixins && decl.mixins.length > 0) {
    for (const mixinAnnotation of decl.mixins) {
      if (mixinAnnotation.type !== NodeType.TypeAnnotation) {
        throw new Error('Mixin must be a named type');
      }
      const mixinName = mixinAnnotation.name;
      const mixinDecl = ctx.mixins.get(mixinName);
      if (!mixinDecl) {
        throw new Error(`Unknown mixin ${mixinName}`);
      }
      // TODO: Handle generic mixin instantiation in codegen
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
      const fieldName = manglePrivateName(
        decl.name.name,
        getMemberName(member.name),
      );

      if (!fields.has(fieldName)) {
        let intrinsic: string | undefined;
        if (member.decorators) {
          const intrinsicDecorator = member.decorators.find(
            (d) => d.name === Decorators.Intrinsic,
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

  // Set current class for `this` type resolution in method signatures
  const previousCurrentClass = ctx.currentClass;
  ctx.currentClass = classInfo;

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
    currentSuperClassInfo = ctx.classes.get(
      getTypeAnnotationName(decl.superClass),
    );
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
    (m) =>
      m.type === NodeType.MethodDefinition && getMemberName(m.name) === '#new',
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
        const key = `${decl.name.name}.${getMemberName(member.name)}`;
        ctx.genericMethods.set(key, member);
        continue; // Skip generating code for generic method definition
      }

      const methodName = getMemberName(member.name);

      let intrinsic: string | undefined;
      if (member.decorators) {
        const intrinsicDecorator = member.decorators.find(
          (d) => d.name === Decorators.Intrinsic,
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
      const propName = getMemberName(member.name);
      const propType = mapType(ctx, member.typeAnnotation);

      // Getter
      if (member.getter) {
        const methodName = getGetterName(propName);
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
        const methodName = getSetterName(propName);
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
      if (!getMemberName(member.name).startsWith('#')) {
        let intrinsic: string | undefined;
        if (member.decorators) {
          const intrinsicDecorator = member.decorators.find(
            (d) => d.name === Decorators.Intrinsic,
          );
          if (intrinsicDecorator && intrinsicDecorator.args.length === 1) {
            intrinsic = intrinsicDecorator.args[0].value;
          }
        }

        const propName = getMemberName(member.name);
        const propType = mapType(ctx, member.typeAnnotation);

        // Getter
        const getterName = getGetterName(propName);
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
          const setterName = getSetterName(propName);
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

      // Params are locals 0..N-1, so start nextLocalIndex after them
      ctx.pushFunctionScope(params.length);

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

  // Restore previous class context
  ctx.currentClass = previousCurrentClass;
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
    (m) =>
      m.type === NodeType.MethodDefinition && getMemberName(m.name) === '#new',
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
        getMemberName(member.name) === 'constructor'
          ? '#new'
          : getMemberName(member.name);
      const methodInfo = classInfo.methods.get(methodName)!;
      const body: number[] = [];

      ctx.pushFunctionScope();

      // Params
      // 0: this
      if (
        !member.isStatic &&
        !(classInfo.isExtension && methodName === '#new')
      ) {
        ctx.defineParam('this', methodInfo.paramTypes[0]);
      }

      for (let i = 0; i < member.params.length; i++) {
        const param = member.params[i];
        mapType(ctx, param.typeAnnotation!);
        // For extension constructors, params start at 0 (since no implicit this param)
        const paramTypeIndex =
          member.isStatic || (classInfo.isExtension && methodName === '#new')
            ? i
            : i + 1;
        const paramType = methodInfo.paramTypes[paramTypeIndex];
        ctx.defineParam(param.name.name, paramType);
      }
      if (classInfo.isExtension && methodName === '#new') {
        // Extension constructor: 'this' is a local variable, not a param
        const thisLocalIndex = ctx.declareLocal('this', classInfo.onType!);
        ctx.thisLocalIndex = thisLocalIndex;
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
          const realThisLocal = ctx.declareLocal('this', realThisType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(...WasmModule.encodeSignedLEB128(targetTypeIndex));
          body.push(Opcode.local_set, realThisLocal);

          ctx.thisLocalIndex = realThisLocal;
        }
      }

      if (member.isAbstract) {
        body.push(Opcode.unreachable);
        body.push(Opcode.end);
        ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
        continue;
      }

      if (methodInfo.intrinsic) {
        continue;
      }

      if (member.isDeclare) {
        continue;
      }

      if (methodName === '#new') {
        const hasSuperClass = !!classInfo.superClass;

        if (!hasSuperClass) {
          for (const m of decl.body) {
            if (m.type === NodeType.FieldDefinition && m.value) {
              if (m.isStatic) continue;
              const fieldName = manglePrivateName(
                decl.name.name,
                getMemberName(m.name),
              );
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
                      getMemberName(m.name),
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
    } else if (member.type === NodeType.AccessorDeclaration) {
      const propName = getMemberName(member.name);

      // Getter
      if (member.getter) {
        const methodName = getGetterName(propName);
        const methodInfo = classInfo.methods.get(methodName)!;
        const body: number[] = [];

        ctx.pushFunctionScope();

        // Params
        // 0: this
        ctx.defineParam('this', methodInfo.paramTypes[0]);

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
          const realThisLocal = ctx.declareLocal('this', realThisType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(...WasmModule.encodeSignedLEB128(targetTypeIndex));
          body.push(Opcode.local_set, realThisLocal);

          ctx.thisLocalIndex = realThisLocal;
        }

        generateBlockStatement(ctx, member.getter, body);
        body.push(Opcode.end);

        ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
      }

      // Setter
      if (member.setter) {
        const methodName = getSetterName(propName);
        const methodInfo = classInfo.methods.get(methodName)!;
        const body: number[] = [];

        ctx.pushFunctionScope();

        // Params
        // 0: this
        ctx.defineParam('this', methodInfo.paramTypes[0]);
        // 1: value
        ctx.defineParam(member.setter.param.name, methodInfo.paramTypes[1]);

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
          const realThisLocal = ctx.declareLocal('this', realThisType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(...WasmModule.encodeSignedLEB128(targetTypeIndex));
          body.push(Opcode.local_set, realThisLocal);

          ctx.thisLocalIndex = realThisLocal;
        }

        generateBlockStatement(ctx, member.setter.body, body);
        body.push(Opcode.end);

        ctx.module.addCode(methodInfo.index, ctx.extraLocals, body);
      }
    } else if (member.type === NodeType.FieldDefinition) {
      if (member.isDeclare) continue;
      if (member.isStatic) continue;
      if (
        member.decorators &&
        member.decorators.some((d) => d.name === 'intrinsic')
      )
        continue;

      if (!getMemberName(member.name).startsWith('#')) {
        const propName = getMemberName(member.name);
        const fieldName = manglePrivateName(className, propName);
        const fieldInfo = classInfo.fields.get(fieldName);
        if (!fieldInfo) {
          throw new Error(
            `Field ${fieldName} not found in class ${decl.name.name}`,
          );
        }

        // Getter
        const getterName = getGetterName(propName);
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
          const setterName = getSetterName(propName);
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
    const resolved = context.get(type.name)!;
    // Avoid infinite recursion if type parameter maps to itself
    if (
      resolved.type === NodeType.TypeAnnotation &&
      resolved.name === type.name
    ) {
      return type;
    }
    return resolveAnnotation(resolved, context);
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
    const ret = type.returnType ? getTypeKey(type.returnType) : TypeNames.Void;
    return `(${params})=>${ret}`;
  } else if (type.type === NodeType.UnionTypeAnnotation) {
    // Sort union members for consistent keys regardless of order
    const members = type.types.map(getTypeKey).sort().join('|');
    return `(${members})`;
  } else if (type.type === NodeType.LiteralTypeAnnotation) {
    // Include the literal value in the key
    const val = type.value;
    if (typeof val === 'string') {
      return `'${val}'`;
    } else if (typeof val === 'boolean') {
      return val ? 'true' : 'false';
    } else {
      return String(val);
    }
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

function getArrayTypeIndex(ctx: CodegenContext, elementType: number[]): number {
  return ctx.getArrayTypeIndex(elementType);
}

export function mapType(
  ctx: CodegenContext,
  type: TypeAnnotation,
  context?: Map<string, TypeAnnotation>,
): number[] {
  if (!type) {
    // TODO (justinfagnani): what is this check?
    return [ValType.i32];
  }
  return mapTypeInternal(ctx, type, context);
}

function mapTypeInternal(
  ctx: CodegenContext,
  type: TypeAnnotation,
  context?: Map<string, TypeAnnotation>,
): number[] {
  const typeContext = context || ctx.currentTypeContext;
  if (!type) return [ValType.i32];

  // Handle `this` type - resolve to current class type
  if (type.type === NodeType.ThisTypeAnnotation) {
    if (ctx.currentClass) {
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(ctx.currentClass.structTypeIndex),
      ];
    }
    // In interface context (no currentClass), use anyref since any class can implement
    return [ValType.ref_null, ValType.anyref];
  }

  // Resolve generic type parameters
  if (
    type.type === NodeType.TypeAnnotation &&
    typeContext &&
    typeContext.has(type.name)
  ) {
    const resolved = typeContext.get(type.name)!;
    // Avoid infinite recursion if type parameter maps to itself
    if (
      resolved.type === NodeType.TypeAnnotation &&
      resolved.name === type.name
    ) {
      // Type parameter maps to itself - treat as a reference type (i32 pointer)
      return [ValType.i32];
    }
    return mapTypeInternal(ctx, resolved, typeContext);
  }

  // Check type aliases
  if (type.type === NodeType.TypeAnnotation && ctx.typeAliases.has(type.name)) {
    return mapType(ctx, ctx.typeAliases.get(type.name)!, context);
  }

  // Try to find type alias by suffix (handles bundled names like m3_Color for Color)
  if (type.type === NodeType.TypeAnnotation) {
    for (const [aliasName, aliasType] of ctx.typeAliases) {
      if (aliasName.endsWith('_' + type.name)) {
        return mapType(ctx, aliasType, context);
      }
    }
  }

  if (type.type === NodeType.TypeAnnotation) {
    switch (type.name) {
      case Types.I32.name:
        return [ValType.i32];
      case Types.U32.name:
        return [ValType.i32]; // u32 maps to i32 in WASM
      case Types.I64.name:
        return [ValType.i64];
      case Types.F32.name:
        return [ValType.f32];
      case Types.F64.name:
        return [ValType.f64];
      case TypeNames.Boolean:
        return [ValType.i32];
      case TypeNames.String: {
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
        // Report error - String type should always be available
        ctx.reportError(
          `String type not found in code generation. This may indicate a missing stdlib import.`,
          DiagnosticCode.UnknownType,
        );
        return [ValType.i32];
      }
      case TypeNames.Void:
        return [];
      case TypeNames.Never:
        // `never` type represents computations that never return (e.g., throw).
        // In WASM, we can represent this as an empty result (like void) since
        // code after a never-returning expression is unreachable.
        return [];
      case TypeNames.Null:
        return [ValType.ref_null, HeapType.none];
      case TypeNames.AnyRef:
        return [ValType.anyref];
      case TypeNames.Any:
        return [ValType.anyref];
      case TypeNames.EqRef:
        return [ValType.eqref];
      case TypeNames.Struct:
        return [ValType.ref_null, HeapType.struct];
      case TypeNames.Array:
        if (type.typeArguments && type.typeArguments.length === 1) {
          const elementType = mapType(ctx, type.typeArguments[0], context);
          const typeIndex = getArrayTypeIndex(ctx, elementType);
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
        if (typeName === Types.String.name && ctx.wellKnownTypes.String) {
          typeName = ctx.wellKnownTypes.String.name.name;
        }

        if (typeName === TypeNames.ByteArray) {
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

          // Try to find by suffix (handles bundled names)
          if (!genericDecl) {
            for (const [name, decl] of ctx.genericClasses) {
              if (name.endsWith('_' + typeName)) {
                genericDecl = decl;
                break;
              }
            }
          }

          if (genericDecl) {
            // Use the actual registered name from the declaration, not the type annotation name
            const actualGenericName = genericDecl.name.name;
            const specializedName = getSpecializedName(
              actualGenericName,
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

        // Try to find class by suffix (handles bundled names like m3_Array for Array)
        for (const [name, classInfo] of ctx.classes) {
          if (name.endsWith('_' + typeName)) {
            if (classInfo.isExtension && classInfo.onType) {
              return classInfo.onType;
            }
            return [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
            ];
          }
        }

        if (ctx.interfaces.has(typeName)) {
          const interfaceInfo = ctx.interfaces.get(typeName)!;
          const res = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
          ];
          return res;
        }

        // Try to find interface by suffix (handles bundled names like m2_Sequence for Sequence)
        for (const [name, interfaceInfo] of ctx.interfaces) {
          if (name.endsWith('_' + typeName)) {
            return [
              ValType.ref_null,
              ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
            ];
          }
        }

        // Check if this is an unbound type parameter (should have been erased)
        // Type parameters should only appear in generic instantiation contexts
        if (!typeContext || !typeContext.has(typeName)) {
          // This is likely a type parameter from a generic function/class.
          // Type parameters should never appear in WASM types - they should either:
          // 1. Be substituted with concrete types (during instantiation), or
          // 2. Not be mapped at all (generic functions aren't generated)
          //
          // However, it might also be that the type lookup failed. Rather than reporting
          // an error, we'll map it to anyref, which is a safe fallback for reference types.
          // This allows the WASM compiler to catch real type errors.
          return [ValType.anyref];
        }

        // Report error for truly unknown types
        ctx.reportError(
          `Unknown type '${typeName}' in code generation. This should have been caught by the type checker.`,
          DiagnosticCode.UnknownType,
        );
        throw new Error(`Unknown type '${typeName}' in code generation`);
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
    // Check for T | null
    const nonNullTypes = type.types.filter(
      (t) => !(t.type === NodeType.TypeAnnotation && t.name === 'null'),
    );

    if (nonNullTypes.length === 1) {
      const innerType = mapType(ctx, nonNullTypes[0], context);
      const typeCode = innerType[0];

      // Check if it is a reference type
      if (
        typeCode === ValType.ref ||
        typeCode === ValType.ref_null ||
        typeCode === ValType.anyref ||
        typeCode === ValType.eqref ||
        typeCode === ValType.externref ||
        typeCode === ValType.funcref
      ) {
        if (typeCode === ValType.ref) {
          return [ValType.ref_null, ...innerType.slice(1)];
        }
        return innerType;
      }
    }

    // Check if this is a union of literals (e.g., enum values)
    // All literal types should map to the same WASM type
    if (
      nonNullTypes.length > 0 &&
      nonNullTypes.every((t) => t.type === NodeType.LiteralTypeAnnotation)
    ) {
      // For literal unions (like enum members), pick the first type
      // All literals should have the same backing type
      return mapType(ctx, nonNullTypes[0], context);
    }

    return [ValType.anyref];
  } else if (type.type === NodeType.LiteralTypeAnnotation) {
    // Literal types (number, string, boolean) map to their base types
    const litType = type as LiteralTypeAnnotation;
    if (typeof litType.value === 'number') {
      return [ValType.i32]; // Integer literals are i32
    } else if (typeof litType.value === 'string') {
      // String literals map to string type
      if (ctx.stringTypeIndex !== -1) {
        return [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
        ];
      }
      return [ValType.anyref]; // Fallback if string type not available
    } else if (typeof litType.value === 'boolean') {
      return [ValType.i32]; // Booleans are i32
    }
    return [ValType.i32];
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

  // Handle generic superclass instantiation
  let superClassName: string | undefined;
  if (decl.superClass) {
    const baseSuperName = getTypeAnnotationName(decl.superClass);
    const superTypeArgs =
      decl.superClass.type === NodeType.TypeAnnotation
        ? decl.superClass.typeArguments
        : undefined;

    if (superTypeArgs && superTypeArgs.length > 0) {
      // Superclass is generic - need to instantiate it with resolved type args
      superClassName = getSpecializedName(
        baseSuperName,
        superTypeArgs,
        ctx,
        context,
      );

      // Ensure superclass is instantiated
      if (!ctx.classes.has(superClassName)) {
        const genericSuperDecl = ctx.genericClasses.get(baseSuperName);
        if (genericSuperDecl) {
          const pendingCountBefore = ctx.pendingMethodGenerations.length;
          instantiateClass(
            ctx,
            genericSuperDecl,
            superClassName,
            superTypeArgs,
            context,
          );
          // Execute any pending method registrations from the superclass
          // so that methods and vtable are available for inheritance
          while (ctx.pendingMethodGenerations.length > pendingCountBefore) {
            const gen = ctx.pendingMethodGenerations[pendingCountBefore];
            ctx.pendingMethodGenerations.splice(pendingCountBefore, 1);
            gen();
          }
        }
      }
    } else {
      superClassName = baseSuperName;
    }
  }

  const fields = new Map<string, {index: number; type: number[]}>();
  const fieldTypes: {type: number[]; mutable: boolean}[] = [];

  let fieldIndex = 0;
  let structTypeIndex = -1;
  let superTypeIndex: number | undefined;
  let onType: number[] | undefined;

  // Reserve type index early to handle recursive references
  if (!decl.isExtension) {
    structTypeIndex = ctx.module.reserveType();

    // Register partial class info
    const partialClassInfo: ClassInfo = {
      name: specializedName,
      originalName: decl.name.name,
      typeArguments: context,
      structTypeIndex,
      superClass: superClassName,
      fields: new Map(), // Will be populated later
      methods: new Map(),
      vtable: [],
      isExtension: false,
    };
    ctx.classes.set(specializedName, partialClassInfo);
  }

  if (decl.isExtension && decl.onType) {
    onType = mapType(ctx, decl.onType, context);
  } else {
    // Check for superclass and inherit fields
    if (superClassName && ctx.classes.has(superClassName)) {
      const superClassInfo = ctx.classes.get(superClassName)!;
      superTypeIndex = superClassInfo.structTypeIndex;

      // Inherit fields from superclass
      const sortedSuperFields = Array.from(
        superClassInfo.fields.entries(),
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

    for (const member of decl.body) {
      if (member.type === NodeType.FieldDefinition) {
        const wasmType = mapType(ctx, member.typeAnnotation, context);
        const fieldName = manglePrivateName(
          specializedName,
          getMemberName(member.name),
        );
        fields.set(fieldName, {index: fieldIndex++, type: wasmType});
        fieldTypes.push({type: wasmType, mutable: true});
      }
    }

    ctx.module.defineStructType(structTypeIndex, fieldTypes, superTypeIndex);
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

  // Inherit methods from superclass
  if (superClassName && ctx.classes.has(superClassName)) {
    const superClassInfo = ctx.classes.get(superClassName)!;

    // Copy inherited methods
    for (const [methodName, methodInfo] of superClassInfo.methods.entries()) {
      methods.set(methodName, {...methodInfo});
    }

    // Copy inherited vtable entries
    if (superClassInfo.vtable) {
      vtable.push(...superClassInfo.vtable);
    }
  }

  let classInfo: ClassInfo;
  if (ctx.classes.has(specializedName)) {
    classInfo = ctx.classes.get(specializedName)!;
    classInfo.fields = fields;
    classInfo.methods = methods;
    classInfo.vtable = vtable;
    classInfo.onType = onType;
  } else {
    classInfo = {
      name: specializedName,
      originalName: decl.name.name,
      typeArguments: context,
      structTypeIndex,
      superClass: superClassName,
      fields,
      methods,
      vtable,
      isExtension: decl.isExtension,
      onType,
    };
    ctx.classes.set(specializedName, classInfo);
  }

  // Register generic specialization for identity-based lookups
  // Key format: "TemplateName|TypeArg1,TypeArg2"
  const argNames = typeArguments.map((arg) => {
    const resolved = resolveAnnotation(arg, parentContext);
    return getTypeKey(resolved);
  });
  const specializationKey = `${decl.name.name}|${argNames.join(',')}`;
  ctx.registerGenericSpecialization(specializationKey, classInfo);

  const registerMethods = () => {
    // Set current class for `this` type resolution in method signatures
    const previousCurrentClass = ctx.currentClass;
    ctx.currentClass = classInfo;

    // Register methods
    const members = [...decl.body];
    const hasConstructor = members.some(
      (m) =>
        m.type === NodeType.MethodDefinition &&
        getMemberName(m.name) === '#new',
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
          const key = `${specializedName}.${getMemberName(member.name)}`;
          ctx.genericMethods.set(key, member);
          continue;
        }

        const methodName =
          getMemberName(member.name) === 'constructor'
            ? '#new'
            : getMemberName(member.name);

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
        const propName = getMemberName(member.name);
        const propType = mapType(ctx, member.typeAnnotation, context);

        // Getter
        if (member.getter) {
          const methodName = getGetterName(propName);
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

          if (superClassName) {
            const superClassInfo = ctx.classes.get(superClassName)!;
            if (superClassInfo.methods.has(methodName)) {
              thisType = superClassInfo.methods.get(methodName)!.paramTypes[0];
            }
          }

          const params = [thisType];
          const results = propType.length > 0 ? [propType] : [];

          let typeIndex: number;
          let isOverride = false;
          if (superClassName) {
            const superClassInfo = ctx.classes.get(superClassName)!;
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
          const methodName = getSetterName(propName);
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

          if (superClassName) {
            const superClassInfo = ctx.classes.get(superClassName)!;
            if (superClassInfo.methods.has(methodName)) {
              thisType = superClassInfo.methods.get(methodName)!.paramTypes[0];
            }
          }

          const params = [thisType, propType];
          const results: number[][] = [];

          let typeIndex: number;
          let isOverride = false;
          if (superClassName) {
            const superClassInfo = ctx.classes.get(superClassName)!;
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
        if (!getMemberName(member.name).startsWith('#')) {
          let intrinsic: string | undefined;
          if (member.decorators) {
            const intrinsicDecorator = member.decorators.find(
              (d) => d.name === 'intrinsic',
            );
            if (intrinsicDecorator && intrinsicDecorator.args.length === 1) {
              intrinsic = intrinsicDecorator.args[0].value;
            }
          }

          const propName = getMemberName(member.name);
          const propType = mapType(ctx, member.typeAnnotation, context);

          // Register Getter
          const regGetterName = getGetterName(propName);
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

          if (superClassName) {
            const superClassInfo = ctx.classes.get(superClassName)!;
            if (superClassInfo.methods.has(regGetterName)) {
              thisType =
                superClassInfo.methods.get(regGetterName)!.paramTypes[0];
            }
          }

          const params = [thisType];
          const results = [propType];

          let typeIndex: number;
          let isOverride = false;
          if (superClassName) {
            const superClassInfo = ctx.classes.get(superClassName)!;
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
            const regSetterName = getSetterName(propName);
            if (!intrinsic && !vtable.includes(regSetterName)) {
              vtable.push(regSetterName);
            }

            const setterParams = [thisType, propType];
            const setterResults: number[][] = [];

            let setterTypeIndex: number;
            let isSetterOverride = false;
            if (superClassName) {
              const superClassInfo = ctx.classes.get(superClassName)!;
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

      // Restore context before early return
      ctx.currentClass = previousCurrentClass;
      return;
    }

    let vtableSuperTypeIndex: number | undefined;
    const baseClassInfo = superClassName
      ? ctx.classes.get(superClassName)
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

        // Params are locals 0..N-1, so start nextLocalIndex after them
        ctx.pushFunctionScope(params.length);

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

    // Restore context
    ctx.currentClass = previousCurrentClass;
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

/**
 * Pre-registers a mixin intermediate class. This reserves the type index so that
 * classes using this mixin can have it as their supertype.
 */
function preRegisterMixin(
  ctx: CodegenContext,
  baseClassInfo: ClassInfo | undefined,
  mixinDecl: MixinDeclaration,
): ClassInfo {
  const baseName = baseClassInfo ? baseClassInfo.name : 'Object';
  const intermediateName = `${baseName}_${mixinDecl.name.name}`;

  // If already registered, return the existing info
  if (ctx.classes.has(intermediateName)) {
    return ctx.classes.get(intermediateName)!;
  }

  // Reserve type index for this intermediate class
  const structTypeIndex = ctx.module.reserveType();

  // Create minimal ClassInfo so it can be referenced
  const classInfo: ClassInfo = {
    name: intermediateName,
    structTypeIndex,
    superClass: baseClassInfo?.name,
    fields: new Map(),
    methods: new Map(),
    vtable: [],
  };
  ctx.classes.set(intermediateName, classInfo);

  return classInfo;
}

function applyMixin(
  ctx: CodegenContext,
  baseClassInfo: ClassInfo | undefined,
  mixinDecl: MixinDeclaration,
): ClassInfo {
  const baseName = baseClassInfo ? baseClassInfo.name : 'Object';
  const intermediateName = `${baseName}_${mixinDecl.name.name}`;

  const existingInfo = ctx.classes.get(intermediateName);
  if (existingInfo && existingInfo.fields.size > 0) {
    // Already fully defined
    return existingInfo;
  }

  // Get or create the ClassInfo (might already be pre-registered)
  const classInfo = existingInfo || {
    name: intermediateName,
    structTypeIndex: ctx.module.reserveType(),
    superClass: baseClassInfo?.name,
    fields: new Map(),
    methods: new Map(),
    vtable: [],
  };

  if (!existingInfo) {
    ctx.classes.set(intermediateName, classInfo);
  }

  const structTypeIndex = classInfo.structTypeIndex;

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
      const fieldName = manglePrivateName(
        intermediateName,
        getMemberName(member.name),
      );

      if (!fields.has(fieldName)) {
        fields.set(fieldName, {index: fieldIndex++, type: wasmType});
        fieldTypes.push({type: wasmType, mutable: true});
      }
    }
  }

  // Define the struct type at the pre-reserved index
  ctx.module.defineStructType(structTypeIndex, fieldTypes, superTypeIndex);

  // Update the ClassInfo with the actual field info
  classInfo.fields = fields;
  classInfo.methods = methods;
  classInfo.vtable = vtable;

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
        name: TypeNames.Boolean,
      };
    case TypeKind.Void:
      return {
        type: NodeType.TypeAnnotation,
        name: TypeNames.Void,
      };
    case TypeKind.Never:
      return {
        type: NodeType.TypeAnnotation,
        name: TypeNames.Never,
      };
    case TypeKind.Class: {
      const classType = type as ClassType;
      // Follow genericSource chain to get canonical name (handles bundler renaming)
      let canonicalName = classType.name;
      let source = classType.genericSource;
      while (source) {
        canonicalName = source.name;
        source = source.genericSource;
      }
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
        name: canonicalName,
        typeArguments: args.length > 0 ? args : undefined,
      };
    }
    case TypeKind.Interface: {
      const ifaceType = type as InterfaceType;
      // Follow genericSource chain to get canonical name (handles bundler renaming)
      let canonicalName = ifaceType.name;
      let source = ifaceType.genericSource;
      while (source) {
        canonicalName = source.name;
        source = source.genericSource;
      }
      const args = ifaceType.typeArguments
        ? ifaceType.typeArguments.map((t) =>
            typeToTypeAnnotation(t, erasedTypeParams),
          )
        : [];
      return {
        type: NodeType.TypeAnnotation,
        name: canonicalName,
        typeArguments: args.length > 0 ? args : undefined,
      };
    }
    case TypeKind.Array: {
      const arrayType = type as ArrayType;
      return {
        type: NodeType.TypeAnnotation,
        name: TypeNames.Array,
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
        // For distinct type aliases (including enums), we need to map to the underlying type
        // in code generation, since WASM doesn't have nominal typing
        return typeToTypeAnnotation(aliasType.target, erasedTypeParams);
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
    case TypeKind.Null:
      return {
        type: NodeType.TypeAnnotation,
        name: 'null',
      };
    case TypeKind.Literal: {
      const literalType = type as LiteralType;
      return {
        type: NodeType.LiteralTypeAnnotation,
        value: literalType.value,
      };
    }
    case TypeKind.Union: {
      const unionType = type as UnionType;
      return {
        type: NodeType.UnionTypeAnnotation,
        types: unionType.types.map((t) =>
          typeToTypeAnnotation(t, erasedTypeParams),
        ),
      } as any;
    }
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
    if (name === Types.I32.name) return [ValType.i32];
    if (name === Types.I64.name) return [ValType.i64];
    if (name === Types.F32.name) return [ValType.f32];
    if (name === Types.F64.name) return [ValType.f64];
    return [ValType.i32];
  }
  if (type.kind === TypeKind.Boolean) return [ValType.i32];
  if (type.kind === TypeKind.Void) return [];
  if (type.kind === TypeKind.Never) return [];
  if (type.kind === TypeKind.Null) return [ValType.ref_null, HeapType.none];

  const annotation = typeToTypeAnnotation(type);
  const result = mapType(ctx, annotation, ctx.currentTypeContext);
  return result;
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
