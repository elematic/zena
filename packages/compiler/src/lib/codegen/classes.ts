import {
  NodeType,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type MethodDefinition,
  type MixinDeclaration,
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
  type MixinType,
} from '../types.js';
import {getGetterName, getSetterName} from '../names.js';
import {WasmModule} from '../emitter.js';

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
  isInterfaceSubtypeByType,
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
      const parentDecl = ctx.findInterfaceDeclaration(parentName);

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

  // Get the checker's parent InterfaceType for identity-based lookups
  let parentType: InterfaceType | undefined;
  if (decl.inferredType && decl.inferredType.kind === TypeKind.Interface) {
    const interfaceType = decl.inferredType as InterfaceType;
    if (interfaceType.extends && interfaceType.extends.length > 0) {
      parentType = interfaceType.extends[0];
    }
  }

  // Register with empty methods/fields - will be populated by defineInterfaceMethods
  const interfaceInfo: InterfaceInfo = {
    name: decl.name.name,
    structTypeIndex,
    vtableTypeIndex,
    methods: new Map(),
    fields: new Map(),
    parentType,
  };
  ctx.interfaces.set(decl.name.name, interfaceInfo);

  // Register type → struct index for identity-based lookups
  if (decl.inferredType && decl.inferredType.kind === TypeKind.Interface) {
    const interfaceType = decl.inferredType as InterfaceType;
    // Store the checker type for identity-based lookups in ClassInfo.implements
    interfaceInfo.checkerType = interfaceType;
    ctx.setInterfaceStructIndex(interfaceType, structTypeIndex);
    // Also register the bundled name for typeToTypeAnnotation lookups
    ctx.setInterfaceBundledName(interfaceType, decl.name.name);
    // Register InterfaceInfo for identity-based lookup (also registers by struct index)
    ctx.registerInterfaceInfoByType(interfaceType, interfaceInfo);
  } else {
    // Still register by struct index for O(1) lookup even without checker type
    ctx.setInterfaceInfoByStructIndex(structTypeIndex, interfaceInfo);
  }
}

/**
 * Defines the method and field types for an interface.
 * This must be called after all classes have been pre-registered so that
 * class types can be resolved correctly.
 *
 * Uses checker-based type resolution: looks up method/field types from the
 * InterfaceType's methods/fields maps, erases type parameters to anyref,
 * and maps to WASM types via mapCheckerTypeToWasmType.
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
  if (interfaceInfo.parentType) {
    parentInfo = ctx.getInterfaceInfoByCheckerType(interfaceInfo.parentType);
  }

  // Ensure parent methods are defined first
  if (parentInfo && parentInfo.methods.size === 0) {
    const parentDecl = ctx.findInterfaceDeclarationByType(
      interfaceInfo.parentType!,
    );
    if (parentDecl) {
      defineInterfaceMethods(ctx, parentDecl);
      // Re-lookup after defining
      parentInfo = ctx.getInterfaceInfoByCheckerType(interfaceInfo.parentType!);
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

  // Get the checker's InterfaceType for type-based lookups
  if (!decl.inferredType || decl.inferredType.kind !== TypeKind.Interface) {
    throw new Error(`Interface ${decl.name.name} missing inferredType`);
  }
  const interfaceType = decl.inferredType as InterfaceType;

  // Build type map for type parameter erasure (T -> anyref)
  const typeMap = ctx.checkerContext.buildErasureTypeMap(interfaceType);

  // Helper to erase type parameters and map to WASM
  const eraseAndMap = (type: Type): number[] => {
    const erased = ctx.checkerContext.substituteTypeParams(type, typeMap);
    return mapCheckerTypeToWasmType(ctx, erased);
  };

  for (const member of decl.body) {
    if (member.type === NodeType.MethodSignature) {
      if (member.typeParameters && member.typeParameters.length > 0) {
        continue;
      }
      const memberName = getMemberName(member.name);
      const methodType = interfaceType.methods.get(memberName);
      if (!methodType) {
        throw new Error(
          `Method ${memberName} not found in interface ${decl.name.name}`,
        );
      }

      // Function type: (param any, ...params) -> result
      const params: number[][] = [[ValType.ref_null, ValType.anyref]]; // 'this' is (ref null any)
      for (const paramType of methodType.parameters) {
        params.push(eraseAndMap(paramType));
      }
      const results: number[][] = [];
      let returnType: number[] = [];
      if (
        methodType.returnType &&
        methodType.returnType.kind !== TypeKind.Void
      ) {
        const mapped = eraseAndMap(methodType.returnType);
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

      methodIndices.set(memberName, {
        index: methodIndex++,
        typeIndex: funcTypeIndex,
        returnType,
      });
    } else if (member.type === NodeType.FieldDefinition) {
      const memberName = getMemberName(member.name);
      const fieldCheckerType = interfaceType.fields.get(memberName);
      if (!fieldCheckerType) {
        throw new Error(
          `Field ${memberName} not found in interface ${decl.name.name}`,
        );
      }

      // Field getter: (param any) -> Type
      const params: number[][] = [[ValType.ref_null, ValType.anyref]];
      const results: number[][] = [];
      let fieldType: number[] = [];
      const mapped = eraseAndMap(fieldCheckerType);
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

      fieldIndices.set(memberName, {
        index: methodIndex++,
        typeIndex: funcTypeIndex,
        type: fieldType,
      });
    } else if (member.type === NodeType.AccessorSignature) {
      const propName = getMemberName(member.name);
      const propCheckerType = interfaceType.fields.get(propName);
      if (!propCheckerType) {
        throw new Error(
          `Accessor ${propName} not found in interface ${decl.name.name}`,
        );
      }
      const propType = eraseAndMap(propCheckerType);

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
          const resultClassInfo = getClassFromTypeIndex(ctx, classTypeIndex);

          if (resultClassInfo && resultClassInfo.implements) {
            let impl: {vtableGlobalIndex: number} | undefined;

            // Identity-based lookup using interfaceInfo.checkerType
            if (interfaceInfo.checkerType) {
              impl = resultClassInfo.implements.get(interfaceInfo.checkerType);

              // If not found, try to find by interface subtype
              if (!impl) {
                for (const [
                  implInterface,
                  implInfo,
                ] of resultClassInfo.implements) {
                  if (
                    isInterfaceSubtypeByType(
                      ctx,
                      implInterface,
                      interfaceInfo.checkerType,
                    )
                  ) {
                    impl = implInfo;
                    break;
                  }
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
                ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
              );
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
  typeContext?: Map<string, TypeAnnotation>,
) {
  if (!decl.implements) return;

  if (!classInfo.implements) classInfo.implements = new Map();

  // Get the checker's ClassType for identity-based interface lookups
  if (!decl.inferredType || decl.inferredType.kind !== TypeKind.Class) {
    throw new Error(
      `Class declaration ${decl.name.name} missing inferredType from checker`,
    );
  }
  const classType = decl.inferredType as ClassType;

  for (let i = 0; i < decl.implements.length; i++) {
    const impl = decl.implements[i];
    if (impl.type !== NodeType.TypeAnnotation) {
      throw new Error('Interfaces cannot be union types');
    }

    // Get the checker's InterfaceType for this implementation (identity-based key)
    // The checker's classType.implements is in the same order as decl.implements
    const checkerInterfaceType = classType.implements[i];

    // Look up interface info by base name (e.g., "Sequence"), since we don't
    // instantiate generic interfaces separately - they share structure.
    const baseName = impl.name;
    const interfaceInfo = ctx.interfaces.get(baseName);
    if (!interfaceInfo) {
      throw new Error(`Interface ${baseName} not found`);
    }

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

    // Store by InterfaceType identity - requires checker type
    if (!checkerInterfaceType) {
      throw new Error(
        `Missing checker InterfaceType for ${classInfo.name} implementing ${impl.name}. ` +
          `Ensure class declaration has inferredType set by the checker.`,
      );
    }
    classInfo.implements.set(checkerInterfaceType, {
      vtableGlobalIndex: globalIndex,
    });
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
      const templateType = decl.inferredType as ClassType;
      ctx.setGenericTemplate(decl.name.name, templateType);
      // Also register bundled name for the template itself
      ctx.setClassBundledName(templateType, decl.name.name);
      // Register declaration by type for identity-based lookup
      ctx.setGenericDeclByType(templateType, decl);
      // Also register by original name (from checker) for bundled AST lookups
      // This allows code using pre-bundled type names to find the generic class
      if (templateType.name !== decl.name.name) {
        ctx.genericClasses.set(templateType.name, decl);
      }
    }
    return;
  }

  // Handle extension classes (e.g. FixedArray extends array<T>)
  // These are handled entirely in preRegister since they don't need deferred definition
  if (decl.isExtension && decl.onType) {
    // Extension classes must have inferredType with onType set by the checker
    if (!decl.inferredType || decl.inferredType.kind !== TypeKind.Class) {
      throw new Error(`Extension class ${decl.name.name} missing inferredType`);
    }
    const classType = decl.inferredType as ClassType;
    if (!classType.onType) {
      throw new Error(
        `Extension class ${decl.name.name} missing onType in inferredType`,
      );
    }
    const onType = mapCheckerTypeToWasmType(ctx, classType.onType);

    // Create a dummy struct type for extensions so that we have a valid type index
    // This is needed because some parts of the compiler might try to reference the class type
    const structTypeIndex = ctx.module.addStructType([]);

    const classInfo: ClassInfo = {
      name: decl.name.name,
      structTypeIndex,
      fields: new Map(),
      methods: new Map(),
      isExtension: true,
      onType,
      onTypeAnnotation: decl.onType,
    };
    ctx.classes.set(decl.name.name, classInfo);
    // Also register by struct index to support lookup when names collide
    ctx.setClassInfoByStructIndex(structTypeIndex, classInfo);

    // Register type → struct index for identity-based lookups
    ctx.setClassStructIndex(classType, structTypeIndex);
    // Register bundled name for identity-based lookups
    ctx.setClassBundledName(classType, decl.name.name);
    // Register ClassInfo for O(1) lookup
    ctx.registerClassInfoByType(classType, classInfo);

    // Register extension class by its onType for O(1) lookup
    ctx.registerExtensionClass(classType.onType, classInfo);

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

  // Get the checker's ClassType for this class
  if (!decl.inferredType || decl.inferredType.kind !== TypeKind.Class) {
    throw new Error(
      `Class declaration ${decl.name.name} missing inferredType from checker`,
    );
  }
  const classType = decl.inferredType as ClassType;

  // If the superclass is generic, instantiate it first so it gets a lower type index
  if (decl.superClass && classType.superType) {
    const superTypeArgs = classType.superType.typeArguments;
    if (superTypeArgs && superTypeArgs.length > 0) {
      // Superclass is generic - need to instantiate it first
      const baseSuperName = getTypeAnnotationName(decl.superClass);
      const specializedName = getSpecializedNameFromCheckerTypes(
        baseSuperName,
        superTypeArgs,
        ctx,
      );
      if (!ctx.classes.has(specializedName)) {
        // Try identity-based lookup via checker's superType first
        let genericSuperDecl: ClassDeclaration | undefined;
        const superGenericSource =
          classType.superType.genericSource ?? classType.superType;
        genericSuperDecl = ctx.getGenericDeclByType(superGenericSource);
        if (genericSuperDecl) {
          // Pass the checker's superType directly - it contains all type info
          instantiateClass(
            ctx,
            genericSuperDecl,
            specializedName,
            classType.superType,
          );
        }
      }
    }
  }

  // If the class uses mixins, pre-register the intermediate mixin classes first
  // They must have lower type indices than this class since they'll be its supertype chain
  if (decl.mixins && decl.mixins.length > 0) {
    // Collect checker's mixin intermediate types for identity-based registration
    const mixinIntermediateTypes = collectMixinIntermediateTypes(classType);

    // Find the base superclass (before any mixin intermediates)
    // Walk back through the mixin intermediates to find the original superclass
    let baseSuperType: ClassType | undefined;
    if (mixinIntermediateTypes.length > 0) {
      // The first intermediate's superType is the original base class
      baseSuperType = mixinIntermediateTypes[0].superType;
    } else if (
      classType.superType &&
      !classType.superType.isMixinIntermediate
    ) {
      baseSuperType = classType.superType;
    }

    let currentSuperClassInfo: ClassInfo | undefined;

    // Use identity-based lookup via the base superclass type
    if (baseSuperType) {
      currentSuperClassInfo = ctx.getClassInfoByCheckerType(baseSuperType);
    }

    // Fall back to name-based lookup if identity lookup failed
    // (e.g., base class not yet registered)
    if (!currentSuperClassInfo && decl.superClass) {
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

    for (let i = 0; i < decl.mixins.length; i++) {
      const mixinAnnotation = decl.mixins[i];
      if (mixinAnnotation.type !== NodeType.TypeAnnotation) {
        continue;
      }
      const mixinName = mixinAnnotation.name;
      const mixinDecl = ctx.mixins.get(mixinName);
      if (!mixinDecl) {
        continue;
      }
      // Get the corresponding checker intermediate type
      const checkerIntermediateType = mixinIntermediateTypes[i];
      // Pre-register the intermediate mixin class with the checker type
      currentSuperClassInfo = preRegisterMixin(
        ctx,
        currentSuperClassInfo,
        mixinDecl,
        checkerIntermediateType,
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
  const classInfo: ClassInfo = {
    name: decl.name.name,
    structTypeIndex,
    brandTypeIndex,
    fields: new Map(),
    methods: new Map(),
    vtable: [],
    isFinal: decl.isFinal,
    isExtension: decl.isExtension,
  };
  ctx.classes.set(decl.name.name, classInfo);
  // Also register by struct index to support lookup when names collide
  ctx.setClassInfoByStructIndex(structTypeIndex, classInfo);

  // Register type → struct index for identity-based lookups
  if (decl.inferredType && decl.inferredType.kind === TypeKind.Class) {
    const classType = decl.inferredType as ClassType;
    ctx.setClassStructIndex(classType, structTypeIndex);
    // Register bundled name for identity-based lookups
    ctx.setClassBundledName(classType, decl.name.name);
    // Register ClassInfo for O(1) lookup
    ctx.registerClassInfoByType(classType, classInfo);
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

  // Identity-based lookup using checker's type
  if (!decl.inferredType || decl.inferredType.kind !== TypeKind.Class) {
    throw new Error(
      `Class ${decl.name.name} missing inferredType in defineClassStruct`,
    );
  }
  const classInfo = ctx.getClassInfoByCheckerType(
    decl.inferredType as ClassType,
  );
  if (!classInfo) {
    throw new Error(`Class ${decl.name.name} not found in defineClassStruct`);
  }

  // Guard against duplicate definition
  if (classInfo.structDefined) {
    return;
  }

  const structTypeIndex = classInfo.structTypeIndex;

  const fields = new Map<
    string,
    {index: number; type: number[]; intrinsic?: string}
  >();
  const fieldTypes: {type: number[]; mutable: boolean}[] = [];
  let fieldIndex = 0;

  let superTypeIndex: number | undefined;

  // We already asserted decl.inferredType is a ClassType above
  const classType = decl.inferredType as ClassType;

  let currentSuperClassInfo: ClassInfo | undefined;
  let superClassType: ClassType | undefined;

  if (decl.superClass) {
    // Try identity-based lookup first using checker's type
    if (classType.superType) {
      superClassType = classType.superType;
      currentSuperClassInfo = ctx.getClassInfoByCheckerType(superClassType);
    }

    // Fall back to name-based lookup if identity lookup failed.
    // This is needed for mixin intermediates which are registered by preRegisterMixin
    // before their checker types are available.
    if (!currentSuperClassInfo) {
      const baseSuperName = getTypeAnnotationName(decl.superClass);

      // Check if superclass is generic using checker's type info
      const superTypeArgs = superClassType?.typeArguments;
      let superClassName: string;
      if (superTypeArgs && superTypeArgs.length > 0) {
        // Superclass is generic - compute name from checker types
        superClassName = getSpecializedNameFromCheckerTypes(
          baseSuperName,
          superTypeArgs,
          ctx,
        );

        // Ensure the superclass is instantiated
        if (!ctx.classes.has(superClassName)) {
          // Try identity-based lookup via checker's superType
          let genericSuperDecl: ClassDeclaration | undefined;
          if (superClassType) {
            const superGenericSource =
              superClassType.genericSource ?? superClassType;
            genericSuperDecl = ctx.getGenericDeclByType(superGenericSource);
          }
          if (genericSuperDecl) {
            // Pass the checker's superType directly - it contains all type info
            instantiateClass(
              ctx,
              genericSuperDecl,
              superClassName,
              superClassType!,
            );
          }
        }
      } else {
        superClassName = baseSuperName;
      }

      currentSuperClassInfo = ctx.classes.get(superClassName);
    }

    if (!currentSuperClassInfo) {
      throw new Error(
        `Unknown superclass ${getTypeAnnotationName(decl.superClass)}`,
      );
    }
  }

  // Process mixins - create intermediate classes for each mixin application
  // Also register the checker's intermediate types with the ClassInfo for identity-based lookups
  if (decl.mixins && decl.mixins.length > 0) {
    // Collect checker's mixin intermediate types to pass to applyMixin
    const mixinIntermediateTypes = collectMixinIntermediateTypes(classType);

    // If we found the mixin intermediate via identity lookup above, we need to find
    // the base superclass (before any mixin intermediates) to start the mixin chain.
    // The checker's type already has mixin intermediates in the superType chain.
    if (mixinIntermediateTypes.length > 0) {
      // The first intermediate's superType is the original base class
      const baseSuperType = mixinIntermediateTypes[0].superType;
      if (baseSuperType) {
        // Try identity-based lookup for the base class
        const baseClassInfo = ctx.getClassInfoByCheckerType(baseSuperType);
        if (baseClassInfo) {
          currentSuperClassInfo = baseClassInfo;
        } else if (decl.superClass) {
          // Fall back to name-based lookup
          const baseSuperName = getTypeAnnotationName(decl.superClass);
          currentSuperClassInfo = ctx.classes.get(baseSuperName);
        }
      } else {
        // No superType means mixin is applied to root (Object)
        currentSuperClassInfo = undefined;
      }
    }

    for (let i = 0; i < decl.mixins.length; i++) {
      const mixinAnnotation = decl.mixins[i];
      if (mixinAnnotation.type !== NodeType.TypeAnnotation) {
        throw new Error('Mixin must be a named type');
      }
      const mixinName = mixinAnnotation.name;
      const mixinDecl = ctx.mixins.get(mixinName);
      if (!mixinDecl) {
        throw new Error(`Unknown mixin ${mixinName}`);
      }

      // Get the corresponding checker intermediate type (if available)
      const checkerIntermediateType = mixinIntermediateTypes[i];

      currentSuperClassInfo = applyMixin(
        ctx,
        currentSuperClassInfo,
        mixinDecl,
        checkerIntermediateType,
      );
    }

    // After processing mixins, update superClassType to point to the final
    // mixin intermediate (which is classType.superType from the checker)
    if (classType?.superType) {
      superClassType = classType.superType;
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
      const memberName = getMemberName(member.name);
      // Use the annotation's inferredType (set by the checker)
      if (!member.typeAnnotation.inferredType) {
        throw new Error(
          `Field ${memberName} in ${decl.name.name} missing inferredType`,
        );
      }
      const wasmType = mapCheckerTypeToWasmType(
        ctx,
        member.typeAnnotation.inferredType,
      );
      const fieldName = manglePrivateName(decl.name.name, memberName);

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
    // Extension classes must have onType set by the checker
    if (!classType?.onType) {
      throw new Error(
        `Extension class ${decl.name.name} missing onType in inferredType`,
      );
    }
    onType = mapCheckerTypeToWasmType(ctx, classType.onType);
  }

  // Update classInfo with full data
  classInfo.superClass = currentSuperClassInfo?.name;
  classInfo.superClassType = superClassType;
  classInfo.fields = fields;
  classInfo.onType = onType;
  classInfo.structDefined = true;

  // Register extension class by WASM type index for O(1) lookup
  if (classInfo.isExtension && classInfo.onType) {
    ctx.registerExtensionClassByWasmTypeIndex(classInfo);
  }
}

export function registerClassMethods(
  ctx: CodegenContext,
  decl: ClassDeclaration,
) {
  if (decl.typeParameters && decl.typeParameters.length > 0) {
    return;
  }

  // Require inferredType for identity-based lookup
  if (!decl.inferredType || decl.inferredType.kind !== TypeKind.Class) {
    throw new Error(
      `Class ${decl.name.name} missing inferredType in registerClassMethods`,
    );
  }
  const classType = decl.inferredType as ClassType;
  const classInfo = ctx.getClassInfoByCheckerType(classType);
  if (!classInfo) {
    throw new Error(
      `Class ${decl.name.name} not found in registerClassMethods`,
    );
  }

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
  // Identity-based lookup using checker's superType
  if (classInfo.superClassType) {
    currentSuperClassInfo = ctx.getClassInfoByCheckerType(
      classInfo.superClassType,
    );
  }
  // Note: No name-based fallback - superClassType should always be set when
  // a superclass exists (including mixin intermediates)

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
      // Use the annotation's inferredType (set by the checker)
      for (let i = 0; i < member.params.length; i++) {
        const param = member.params[i];
        if (!param.typeAnnotation.inferredType) {
          throw new Error(
            `Parameter ${i} of ${methodName} in ${decl.name.name} missing inferredType`,
          );
        }
        const mapped = mapCheckerTypeToWasmType(
          ctx,
          param.typeAnnotation.inferredType,
        );
        params.push(mapped);
      }

      let results: number[][] = [];
      if (methodName === '#new') {
        if (classInfo.isExtension && classInfo.onType) {
          results = [classInfo.onType];
        } else if (member.isStatic && member.returnType) {
          if (!member.returnType.inferredType) {
            throw new Error(
              `Return type of ${methodName} in ${decl.name.name} missing inferredType`,
            );
          }
          const mapped = mapCheckerTypeToWasmType(
            ctx,
            member.returnType.inferredType,
          );
          if (mapped.length > 0) results = [mapped];
        } else {
          results = [];
        }
      } else if (member.returnType) {
        if (!member.returnType.inferredType) {
          throw new Error(
            `Return type of ${methodName} in ${decl.name.name} missing inferredType`,
          );
        }
        const mapped = mapCheckerTypeToWasmType(
          ctx,
          member.returnType.inferredType,
        );
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
      // Use the annotation's inferredType (set by the checker)
      if (!member.typeAnnotation.inferredType) {
        throw new Error(
          `Accessor ${propName} in ${decl.name.name} missing inferredType`,
        );
      }
      const propType = mapCheckerTypeToWasmType(
        ctx,
        member.typeAnnotation.inferredType,
      );

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
        // Use the annotation's inferredType (set by the checker)
        if (!member.typeAnnotation.inferredType) {
          throw new Error(
            `Field ${propName} in ${decl.name.name} missing inferredType`,
          );
        }
        const propType = mapCheckerTypeToWasmType(
          ctx,
          member.typeAnnotation.inferredType,
        );

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

  if (ctx.shouldExport(decl) && !decl.isExtension) {
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

  // Pass the checker type for identity-based lookup (classType is already declared at function top)
  ctx.bodyGenerators.push(() => {
    generateClassMethods(ctx, declForGen, undefined, classType);
  });

  // Restore previous class context
  ctx.currentClass = previousCurrentClass;
}

export function generateClassMethods(
  ctx: CodegenContext,
  decl: ClassDeclaration,
  specializedName?: string,
  checkerType?: ClassType,
  /**
   * Pre-resolved type parameter map. If provided, this is used directly for
   * pushTypeParamContext instead of calling buildTypeMap(checkerType).
   * This is needed when checkerType.typeArguments contains TypeParameterTypes
   * that have already been resolved by the caller.
   */
  resolvedTypeParamMap?: Map<string, Type>,
) {
  const previousCheckerType = ctx.currentCheckerType;

  // Set checker type for resolving type parameters in method bodies
  if (checkerType) {
    ctx.currentCheckerType = checkerType;
  }

  // Push type param context for checker-based resolution
  // This enables substituteTypeParams to resolve class type parameters
  if (resolvedTypeParamMap) {
    // Use pre-resolved map from caller (handles nested generic instantiation)
    ctx.pushTypeParamContext(resolvedTypeParamMap);
  } else if (checkerType && ctx.checkerContext) {
    const typeMap = ctx.checkerContext.buildTypeMap(checkerType);
    ctx.pushTypeParamContext(typeMap);
  }

  // Identity-based lookup using checker's type
  // Prefer the explicitly passed checkerType, fall back to decl.inferredType
  const lookupType =
    checkerType ??
    (decl.inferredType?.kind === TypeKind.Class
      ? (decl.inferredType as ClassType)
      : undefined);
  let classInfo: ClassInfo | undefined;
  if (lookupType) {
    classInfo = ctx.getClassInfoByCheckerType(lookupType);
  }
  // Fall back to name-based lookup for generic instantiations created by codegen
  if (!classInfo) {
    const className = specializedName || decl.name.name;
    classInfo = ctx.classes.get(className);
  }
  if (!classInfo) {
    throw new Error(
      `Class ${specializedName || decl.name.name} not found in generateClassMethods`,
    );
  }
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
        // Parameter type comes from methodInfo (already resolved during registration)
        // For extension constructors, params start at 0 (since no implicit this param)
        const paramTypeIndex =
          member.isStatic || (classInfo.isExtension && methodName === '#new')
            ? i
            : i + 1;
        const paramType = methodInfo.paramTypes[paramTypeIndex];
        ctx.defineParam(param.name.name, paramType, param);
      }
      if (classInfo.isExtension && methodName === '#new') {
        // Extension constructor: 'this' is a local variable, not a param
        const thisLocalIndex = ctx.declareLocal('this', classInfo.onType!);
        ctx.thisLocalIndex = thisLocalIndex;
      }

      // Set return type for proper return statement adaptation (e.g., interface boxing)
      const oldReturnType = ctx.currentReturnType;
      ctx.currentReturnType = methodInfo.returnType;

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
        ctx.currentReturnType = oldReturnType;
        continue;
      }

      if (methodInfo.intrinsic) {
        ctx.currentReturnType = oldReturnType;
        continue;
      }

      if (member.isDeclare) {
        ctx.currentReturnType = oldReturnType;
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

      // Restore return type context
      ctx.currentReturnType = oldReturnType;

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
        // 1: value - pass the Identifier node for binding resolution
        ctx.defineParam(
          member.setter.param.name,
          methodInfo.paramTypes[1],
          member.setter.param,
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
        const fieldName = manglePrivateName(classInfo.name, propName);
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

  // Restore previous context
  if (resolvedTypeParamMap || (checkerType && ctx.checkerContext)) {
    ctx.popTypeParamContext();
  }
  ctx.currentCheckerType = previousCheckerType;
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

/**
 * Get a canonical string key for a checker Type, for use in specialization names.
 * This is the checker-type equivalent of getTypeKey(TypeAnnotation).
 *
 * Uses identity-based lookups for class/interface names to avoid collisions.
 */
export function getCheckerTypeKeyForSpecialization(
  type: Type,
  ctx: CodegenContext,
): string {
  switch (type.kind) {
    case TypeKind.Number:
      return (type as NumberType).name;
    case TypeKind.Boolean:
      return TypeNames.Boolean;
    case TypeKind.Void:
      return TypeNames.Void;
    case TypeKind.Null:
      return 'null';
    case TypeKind.Never:
      return 'never';
    case TypeKind.Any:
      return 'any';
    case TypeKind.AnyRef:
      return 'anyref';
    case TypeKind.ByteArray:
      return 'ByteArray';
    case TypeKind.TypeParameter:
      return (type as TypeParameterType).name;
    case TypeKind.Class: {
      const classType = type as ClassType;
      // Use bundled name via identity lookup if available
      let name = ctx.getClassBundledName(classType);
      if (!name) {
        // Fall back to genericSource chain
        name = classType.name;
        let source = classType.genericSource;
        while (source) {
          const sourceName = ctx.getClassBundledName(source);
          if (sourceName) {
            name = sourceName;
            break;
          }
          name = source.name;
          source = source.genericSource;
        }
      }
      if (classType.typeArguments && classType.typeArguments.length > 0) {
        const args = classType.typeArguments
          .map((a) => getCheckerTypeKeyForSpecialization(a, ctx))
          .join(',');
        return `${name}<${args}>`;
      }
      return name;
    }
    case TypeKind.Interface: {
      const interfaceType = type as InterfaceType;
      // Use bundled name via identity lookup if available
      let name = ctx.getInterfaceBundledName(interfaceType);
      if (!name) {
        // Fall back to genericSource chain
        name = interfaceType.name;
        let source = interfaceType.genericSource;
        while (source) {
          const sourceName = ctx.getInterfaceBundledName(source);
          if (sourceName) {
            name = sourceName;
            break;
          }
          name = source.name;
          source = source.genericSource;
        }
      }
      if (
        interfaceType.typeArguments &&
        interfaceType.typeArguments.length > 0
      ) {
        const args = interfaceType.typeArguments
          .map((a) => getCheckerTypeKeyForSpecialization(a, ctx))
          .join(',');
        return `${name}<${args}>`;
      }
      return name;
    }
    case TypeKind.Array: {
      const arrayType = type as ArrayType;
      const elementKey = getCheckerTypeKeyForSpecialization(
        arrayType.elementType,
        ctx,
      );
      return `array<${elementKey}>`;
    }
    case TypeKind.Record: {
      const recordType = type as RecordType;
      const props = Array.from(recordType.properties.entries())
        .map(
          ([name, propType]) =>
            `${name}:${getCheckerTypeKeyForSpecialization(propType, ctx)}`,
        )
        .sort()
        .join(',');
      return `{${props}}`;
    }
    case TypeKind.Tuple: {
      const tupleType = type as TupleType;
      const elements = tupleType.elementTypes
        .map((t) => getCheckerTypeKeyForSpecialization(t, ctx))
        .join(',');
      return `[${elements}]`;
    }
    case TypeKind.Function: {
      const funcType = type as FunctionType;
      const params = funcType.parameters
        .map((p) => getCheckerTypeKeyForSpecialization(p, ctx))
        .join(',');
      const ret = getCheckerTypeKeyForSpecialization(funcType.returnType, ctx);
      return `(${params})=>${ret}`;
    }
    case TypeKind.Union: {
      const unionType = type as UnionType;
      const members = unionType.types
        .map((t) => getCheckerTypeKeyForSpecialization(t, ctx))
        .sort()
        .join('|');
      return `(${members})`;
    }
    case TypeKind.Literal: {
      const litType = type as LiteralType;
      if (typeof litType.value === 'string') {
        return `'${litType.value}'`;
      } else if (typeof litType.value === 'boolean') {
        return litType.value ? 'true' : 'false';
      } else {
        return String(litType.value);
      }
    }
    case TypeKind.TypeAlias: {
      const aliasType = type as TypeAliasType;
      // For distinct types, preserve the alias name to keep them distinguishable
      // For regular type aliases, use the target type's key (they're transparent)
      if (aliasType.isDistinct) {
        return aliasType.name;
      }
      return getCheckerTypeKeyForSpecialization(aliasType.target, ctx);
    }
    case TypeKind.Symbol:
      return 'symbol';
    case TypeKind.Mixin: {
      const mixinType = type as MixinType;
      return mixinType.name;
    }
    default:
      return 'unknown';
  }
}

/**
 * Get a specialized name for a generic type instantiation using checker Types.
 * This is the checker-type equivalent of getSpecializedName(name, TypeAnnotation[]).
 *
 * @param baseName The base class/interface name (should be bundled name)
 * @param typeArgs The type arguments as checker Types
 * @param ctx CodegenContext for identity-based name lookups
 */
export function getSpecializedNameFromCheckerTypes(
  baseName: string,
  typeArgs: Type[],
  ctx: CodegenContext,
): string {
  const argKeys = typeArgs.map((arg) =>
    getCheckerTypeKeyForSpecialization(arg, ctx),
  );
  return `${baseName}<${argKeys.join(',')}>`;
}

/**
 * Check if a checker Type contains any unresolved type parameters.
 * Returns true if the type (or any nested type) is a TypeParameterType.
 *
 * Use this to determine if a type needs resolution through the type context
 * before computing specialized names.
 */
export function typeContainsTypeParameter(type: Type): boolean {
  switch (type.kind) {
    case TypeKind.TypeParameter:
      return true;
    case TypeKind.Class: {
      const classType = type as ClassType;
      return classType.typeArguments?.some(typeContainsTypeParameter) ?? false;
    }
    case TypeKind.Interface: {
      const ifaceType = type as InterfaceType;
      return ifaceType.typeArguments?.some(typeContainsTypeParameter) ?? false;
    }
    case TypeKind.Array:
      return typeContainsTypeParameter((type as ArrayType).elementType);
    case TypeKind.Record: {
      const recordType = type as RecordType;
      for (const propType of recordType.properties.values()) {
        if (typeContainsTypeParameter(propType)) return true;
      }
      return false;
    }
    case TypeKind.Tuple: {
      const tupleType = type as TupleType;
      return tupleType.elementTypes.some(typeContainsTypeParameter);
    }
    case TypeKind.Function: {
      const funcType = type as FunctionType;
      if (typeContainsTypeParameter(funcType.returnType)) return true;
      return funcType.parameters.some(typeContainsTypeParameter);
    }
    case TypeKind.Union: {
      const unionType = type as UnionType;
      return unionType.types.some(typeContainsTypeParameter);
    }
    case TypeKind.TypeAlias:
      return typeContainsTypeParameter((type as TypeAliasType).target);
    default:
      return false;
  }
}

export function getSpecializedName(
  name: string,
  args: TypeAnnotation[],
  ctx: CodegenContext,
  context?: Map<string, TypeAnnotation>,
): string {
  const argNames = args.map((arg) => {
    const resolved = resolveAnnotation(arg, context);
    // If the type annotation has a checker type (inferredType), use that for
    // identity-based naming to avoid collisions with same-named types from
    // different modules.
    // HOWEVER: if the inferredType contains unresolved type parameters, we need
    // to fall through to the context-based resolution, which will resolve names
    // like 'K' and 'V' to their concrete types via the context map.
    if (
      resolved.inferredType &&
      !typeContainsTypeParameter(resolved.inferredType)
    ) {
      return getCheckerTypeKeyForSpecialization(resolved.inferredType, ctx);
    }
    // Fallback for types containing type parameters (K, V, T, etc.)
    // The context map resolves these to their concrete types.
    return getTypeKeyWithContext(resolved, ctx);
  });
  return `${name}<${argNames.join(',')}>`;
}

/**
 * Get a canonical string key for a TypeAnnotation, using codegen context
 * to resolve class names to their bundled names (avoiding same-name collisions).
 * This is used as a fallback when inferredType contains type parameters.
 */
function getTypeKeyWithContext(
  type: TypeAnnotation,
  ctx: CodegenContext,
): string {
  if (type.type === NodeType.TypeAnnotation) {
    let key = type.name;

    if (type.typeArguments && type.typeArguments.length > 0) {
      key += `<${type.typeArguments.map((ta) => getTypeKeyWithContext(ta, ctx)).join(',')}>`;
    }
    return key;
  } else if (type.type === NodeType.RecordTypeAnnotation) {
    const props = type.properties
      .map(
        (p) => `${p.name.name}:${getTypeKeyWithContext(p.typeAnnotation, ctx)}`,
      )
      .sort()
      .join(',');
    return `{${props}}`;
  } else if (type.type === NodeType.TupleTypeAnnotation) {
    const elements = type.elementTypes
      .map((t) => getTypeKeyWithContext(t, ctx))
      .join(',');
    return `[${elements}]`;
  } else if (type.type === NodeType.FunctionTypeAnnotation) {
    const params = type.params
      .map((p) => getTypeKeyWithContext(p, ctx))
      .join(',');
    const ret = type.returnType
      ? getTypeKeyWithContext(type.returnType, ctx)
      : TypeNames.Void;
    return `(${params})=>${ret}`;
  } else if (type.type === NodeType.UnionTypeAnnotation) {
    // Sort union members for consistent keys regardless of order
    const members = type.types
      .map((t) => getTypeKeyWithContext(t, ctx))
      .sort()
      .join('|');
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

export function instantiateClass(
  ctx: CodegenContext,
  decl: ClassDeclaration,
  specializedName: string,
  /**
   * The checker's ClassType for this instantiation.
   * Enables identity-based lookup via getClassInfoByCheckerType().
   * With type interning, the same checker ClassType is shared across all uses of
   * identical instantiations (e.g., all Box<i32> references share one ClassType).
   *
   * For extension classes, checkerType enables ArrayType interning
   * (the checker's interned ArrayType is used for onType).
   *
   * The type arguments are derived from checkerType.typeArguments.
   */
  checkerType: ClassType,
) {
  // Guard against duplicate instantiation
  const existingInfo = ctx.classes.get(specializedName);
  if (existingInfo?.structDefined) {
    // Even if already instantiated, register the new checkerType for identity lookup.
    // This handles cases where the same logical class is accessed via different
    // ClassType objects (due to substituteType creating new objects without interning).
    ctx.registerClassInfoByType(checkerType, existingInfo);
    return;
  }

  // Build both annotation-based context (for backward compat) and checker-based type map
  // from the checker's type arguments
  const context = new Map<string, TypeAnnotation>();
  const typeParamMap = new Map<string, Type>();
  const checkerTypeArgs = checkerType.typeArguments ?? [];
  if (decl.typeParameters) {
    decl.typeParameters.forEach((param, index) => {
      let checkerArg = checkerTypeArgs[index];
      if (checkerArg) {
        // If the type argument is itself a type parameter, resolve it through
        // the current type param context. This handles cases like Entry<K, V>
        // being instantiated inside Map<string, Box<i32>> where K and V need
        // to be resolved to their concrete types.
        if (checkerArg.kind === TypeKind.TypeParameter) {
          const paramName = (checkerArg as TypeParameterType).name;
          const resolved = ctx.currentTypeParamMap.get(paramName);
          if (resolved) {
            checkerArg = resolved;
          }
        }
        // Build annotation-based context for backward compatibility
        const annotation = typeToTypeAnnotation(checkerArg, undefined, ctx);
        context.set(param.name, annotation);
        // Build checker-based type map for substituteTypeParams
        typeParamMap.set(param.name, checkerArg);
      }
    });
  }

  // Helper to resolve a type annotation's inferredType with type parameter substitution
  const resolveType = (annotation: TypeAnnotation): number[] => {
    if (!annotation.inferredType) {
      throw new Error(
        `Type annotation missing inferredType in instantiateClass for ${specializedName}`,
      );
    }
    if (typeContainsTypeParameter(annotation.inferredType)) {
      const substituted = ctx.checkerContext.substituteTypeParams(
        annotation.inferredType,
        typeParamMap,
      );
      return mapCheckerTypeToWasmType(ctx, substituted);
    }
    return mapCheckerTypeToWasmType(ctx, annotation.inferredType);
  };

  // Ensure all nested types within the checker's ClassType are instantiated.
  // This handles superclasses, implemented interfaces, mixins, onTypes, field types,
  // method parameters, and return types recursively.
  // Pass checkerType as rootClassType to skip self-recursion (this class is being instantiated now).
  if (checkerType) {
    ensureTypeInstantiated(ctx, checkerType, checkerType);
  }

  // Handle generic superclass instantiation
  let superClassName: string | undefined;
  // Don't use checkerType?.superType - use annotation-based lookup for superclasses
  // to avoid type mismatch issues between checker and codegen.
  const superClassType: ClassType | undefined = checkerType?.superType;

  if (decl.superClass) {
    // Try identity-based lookup first using checker's type
    if (superClassType) {
      const superClassInfo = ctx.getClassInfoByCheckerType(superClassType);
      if (superClassInfo) {
        superClassName = superClassInfo.name;
      }
    }

    // Fall back to name-based lookup if identity lookup failed.
    // This is needed for mixin intermediates which are registered by preRegisterMixin
    // before their checker types are available.
    if (!superClassName) {
      const baseSuperName = getTypeAnnotationName(decl.superClass);

      // Check if superclass is generic using checker's type info
      const superTypeArgs = superClassType?.typeArguments;
      if (superTypeArgs && superTypeArgs.length > 0) {
        // Superclass is generic - compute name from checker types
        superClassName = getSpecializedNameFromCheckerTypes(
          baseSuperName,
          superTypeArgs,
          ctx,
        );

        // Ensure superclass is instantiated
        if (!ctx.classes.has(superClassName)) {
          // Try identity-based lookup via checker's superType
          let genericSuperDecl: ClassDeclaration | undefined;
          if (superClassType) {
            const superGenericSource =
              superClassType.genericSource ?? superClassType;
            genericSuperDecl = ctx.getGenericDeclByType(superGenericSource);
          }
          if (genericSuperDecl) {
            const pendingCountBefore = ctx.pendingMethodGenerations.length;
            // Pass the checker's superType directly - it contains all type info
            instantiateClass(
              ctx,
              genericSuperDecl,
              superClassName,
              superClassType!,
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
    // Also register by struct index to support lookup when names collide
    ctx.setClassInfoByStructIndex(structTypeIndex, partialClassInfo);
  }

  if (decl.isExtension && decl.onType) {
    // Extension classes require proper onType mapping for WASM GC arrays.
    // Two paths:
    // 1. Identity-based (checkerType provided): Use checkerType.onType which has
    //    substituted type arguments and interned ArrayType for consistent WASM indices.
    // 2. Checker-type-based (no checkerType): Use the annotation's inferredType with
    //    type parameter substitution via resolveType.
    if (checkerType) {
      // When checkerType is provided, onType MUST be set (substituteType ensures this)
      if (!checkerType.onType) {
        throw new Error(
          `Extension class '${decl.name.name}' has checkerType but missing onType. ` +
            `This indicates a bug in type substitution.`,
        );
      }
      onType = mapCheckerTypeToWasmType(ctx, checkerType.onType);
    } else {
      // Use the annotation's inferredType with type parameter substitution
      onType = resolveType(decl.onType);
    }
  } else {
    // Check for superclass and inherit fields
    // Try identity-based lookup first
    let superClassInfo: ClassInfo | undefined;
    if (superClassType) {
      superClassInfo = ctx.getClassInfoByCheckerType(superClassType);
    }
    // Fall back to name-based lookup for mixin intermediates which are registered
    // by preRegisterMixin before their checker types are available.
    if (!superClassInfo && superClassName && ctx.classes.has(superClassName)) {
      superClassInfo = ctx.classes.get(superClassName);
    }

    if (superClassInfo) {
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
        const memberName = getMemberName(member.name);
        const wasmType = resolveType(member.typeAnnotation);
        const fieldName = manglePrivateName(specializedName, memberName);
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
  // Try identity-based lookup first
  let inheritFromSuperClass: ClassInfo | undefined;
  if (superClassType) {
    inheritFromSuperClass = ctx.getClassInfoByCheckerType(superClassType);
  }
  // Fall back to name-based lookup
  if (
    !inheritFromSuperClass &&
    superClassName &&
    ctx.classes.has(superClassName)
  ) {
    inheritFromSuperClass = ctx.classes.get(superClassName);
  }

  if (inheritFromSuperClass) {
    // Copy inherited methods
    for (const [
      methodName,
      methodInfo,
    ] of inheritFromSuperClass.methods.entries()) {
      methods.set(methodName, {...methodInfo});
    }

    // Copy inherited vtable entries
    if (inheritFromSuperClass.vtable) {
      vtable.push(...inheritFromSuperClass.vtable);
    }
  }

  let classInfo: ClassInfo;
  if (ctx.classes.has(specializedName)) {
    classInfo = ctx.classes.get(specializedName)!;
    classInfo.fields = fields;
    classInfo.methods = methods;
    classInfo.vtable = vtable;
    classInfo.onType = onType;
    classInfo.superClassType = superClassType;
    classInfo.typeParamMap = typeParamMap;
    if (decl.isExtension && decl.onType) {
      classInfo.onTypeAnnotation = decl.onType;
    }
  } else {
    classInfo = {
      name: specializedName,
      originalName: decl.name.name,
      typeArguments: context,
      typeParamMap,
      structTypeIndex,
      superClass: superClassName,
      superClassType,
      fields,
      methods,
      vtable,
      isExtension: decl.isExtension,
      onType,
      onTypeAnnotation: decl.isExtension ? decl.onType : undefined,
    };
    ctx.classes.set(specializedName, classInfo);
    // Also register by struct index to support lookup when names collide
    ctx.setClassInfoByStructIndex(structTypeIndex, classInfo);
  }

  // Register extension class by WASM type index for O(1) lookup
  if (classInfo.isExtension && classInfo.onType) {
    ctx.registerExtensionClassByWasmTypeIndex(classInfo);
  }

  // Register extension class by checker onType for identity-based lookup
  // This enables O(1) lookup via getExtensionClassesByOnType() when we have the
  // checker's interned ArrayType (or other onType)
  if (checkerType?.isExtension && checkerType.onType) {
    ctx.registerExtensionClass(checkerType.onType, classInfo);
  }

  // Register by checker type for identity-based lookup
  // This enables O(1) lookup via getClassInfoByCheckerType() when we have the
  // checker's interned ClassType (which is shared across all identical instantiations)
  if (checkerType) {
    ctx.registerClassInfoByType(checkerType, classInfo);
  }

  // Mark as fully defined to prevent duplicate instantiation
  classInfo.structDefined = true;

  const registerMethods = () => {
    // Set current class for `this` type resolution in method signatures
    const previousCurrentClass = ctx.currentClass;
    ctx.currentClass = classInfo;

    // Cache superclass info for method inheritance lookups
    // Try identity-based lookup first
    let baseClassInfo: ClassInfo | undefined;
    if (superClassType) {
      baseClassInfo = ctx.getClassInfoByCheckerType(superClassType);
    }
    // Fall back to name-based lookup
    if (!baseClassInfo && superClassName) {
      baseClassInfo = ctx.classes.get(superClassName);
    }

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
          params.push(resolveType(param.typeAnnotation));
        }

        let results: number[][] = [];
        if (methodName === '#new') {
          if (decl.isExtension && onType) {
            results = [onType];
          } else if (member.isStatic && member.returnType) {
            const mapped = resolveType(member.returnType);
            if (mapped.length > 0) results = [mapped];
          } else {
            results = [];
          }
        } else if (member.returnType) {
          const mapped = resolveType(member.returnType);
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
        const propType = resolveType(member.typeAnnotation);

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

          if (baseClassInfo?.methods.has(methodName)) {
            thisType = baseClassInfo.methods.get(methodName)!.paramTypes[0];
          }

          const params = [thisType];
          const results = propType.length > 0 ? [propType] : [];

          let typeIndex: number;
          let isOverride = false;
          if (baseClassInfo?.methods.has(methodName)) {
            typeIndex = baseClassInfo.methods.get(methodName)!.typeIndex;
            isOverride = true;
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

          if (baseClassInfo?.methods.has(methodName)) {
            thisType = baseClassInfo.methods.get(methodName)!.paramTypes[0];
          }

          const params = [thisType, propType];
          const results: number[][] = [];

          let typeIndex: number;
          let isOverride = false;
          if (baseClassInfo?.methods.has(methodName)) {
            typeIndex = baseClassInfo.methods.get(methodName)!.typeIndex;
            isOverride = true;
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
          const propType = resolveType(member.typeAnnotation);

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

          if (baseClassInfo?.methods.has(regGetterName)) {
            thisType = baseClassInfo.methods.get(regGetterName)!.paramTypes[0];
          }

          const params = [thisType];
          const results = [propType];

          let typeIndex: number;
          let isOverride = false;
          if (baseClassInfo?.methods.has(regGetterName)) {
            typeIndex = baseClassInfo.methods.get(regGetterName)!.typeIndex;
            isOverride = true;
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
            if (baseClassInfo?.methods.has(regSetterName)) {
              setterTypeIndex =
                baseClassInfo.methods.get(regSetterName)!.typeIndex;
              isSetterOverride = true;
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

      generateInterfaceVTable(ctx, classInfo, decl, context);

      ctx.bodyGenerators.push(() => {
        generateClassMethods(ctx, declForGen, specializedName, checkerType);
      });

      // Restore context before early return
      ctx.currentClass = previousCurrentClass;
      return;
    }

    let vtableSuperTypeIndex: number | undefined;
    // Use existing baseClassInfo from earlier in registerMethods
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

    generateInterfaceVTable(ctx, classInfo, decl, context);

    if (ctx.shouldExport(decl) && structTypeIndex !== -1) {
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
      generateClassMethods(
        ctx,
        declForGen,
        specializedName,
        checkerType,
        typeParamMap, // Pass pre-resolved type param map for nested generics
      );
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
 * Collects checker's mixin intermediate types from a class's superType chain.
 * Returns an array of intermediate types in mixin application order (first mixin first).
 */
function collectMixinIntermediateTypes(
  classType: ClassType | undefined,
): ClassType[] {
  if (!classType) return [];

  // Walk the superType chain and collect all mixin intermediate types
  const intermediates: ClassType[] = [];
  let current = classType.superType;

  while (current && current.isMixinIntermediate) {
    intermediates.push(current);
    current = current.superType;
  }

  // Reverse to get them in application order (first mixin applied first)
  return intermediates.reverse();
}

/**
 * Pre-registers a mixin intermediate class. This reserves the type index so that
 * classes using this mixin can have it as their supertype.
 * If checkerIntermediateType is provided, also registers for identity-based lookup.
 */
function preRegisterMixin(
  ctx: CodegenContext,
  baseClassInfo: ClassInfo | undefined,
  mixinDecl: MixinDeclaration,
  checkerIntermediateType?: ClassType,
): ClassInfo {
  const baseName = baseClassInfo ? baseClassInfo.name : 'Object';
  const intermediateName = `${baseName}_${mixinDecl.name.name}`;

  // If already registered, ensure identity-based lookup is also registered
  if (ctx.classes.has(intermediateName)) {
    const existingInfo = ctx.classes.get(intermediateName)!;
    if (checkerIntermediateType) {
      ctx.registerClassInfoByType(checkerIntermediateType, existingInfo);
      ctx.setClassBundledName(checkerIntermediateType, intermediateName);
      ctx.setClassStructIndex(
        checkerIntermediateType,
        existingInfo.structTypeIndex,
      );
    }
    return existingInfo;
  }

  // Reserve type index for this intermediate class
  const structTypeIndex = ctx.module.reserveType();

  // Create minimal ClassInfo so it can be referenced
  const classInfo: ClassInfo = {
    name: intermediateName,
    structTypeIndex,
    superClass: baseClassInfo?.name,
    superClassType: checkerIntermediateType?.superType,
    fields: new Map(),
    methods: new Map(),
    vtable: [],
  };
  ctx.classes.set(intermediateName, classInfo);
  // Also register by struct index to support lookup when names collide
  ctx.setClassInfoByStructIndex(structTypeIndex, classInfo);

  // Register for identity-based lookup if we have the checker type
  if (checkerIntermediateType) {
    ctx.registerClassInfoByType(checkerIntermediateType, classInfo);
    ctx.setClassBundledName(checkerIntermediateType, intermediateName);
    ctx.setClassStructIndex(checkerIntermediateType, structTypeIndex);
  }

  return classInfo;
}

function applyMixin(
  ctx: CodegenContext,
  baseClassInfo: ClassInfo | undefined,
  mixinDecl: MixinDeclaration,
  checkerIntermediateType?: ClassType,
): ClassInfo {
  const baseName = baseClassInfo ? baseClassInfo.name : 'Object';
  const intermediateName = `${baseName}_${mixinDecl.name.name}`;

  const existingInfo = ctx.classes.get(intermediateName);
  if (existingInfo && existingInfo.fields.size > 0) {
    // Already fully defined - but still register by identity if we have the checker type
    if (checkerIntermediateType) {
      ctx.registerClassInfoByType(checkerIntermediateType, existingInfo);
      ctx.setClassBundledName(checkerIntermediateType, intermediateName);
      ctx.setClassStructIndex(
        checkerIntermediateType,
        existingInfo.structTypeIndex,
      );
      // Also update superClassType if not already set
      if (!existingInfo.superClassType && checkerIntermediateType.superType) {
        existingInfo.superClassType = checkerIntermediateType.superType;
      }
    }
    return existingInfo;
  }

  // Get or create the ClassInfo (might already be pre-registered)
  const classInfo = existingInfo || {
    name: intermediateName,
    structTypeIndex: ctx.module.reserveType(),
    superClass: baseClassInfo?.name,
    superClassType: checkerIntermediateType?.superType,
    fields: new Map(),
    methods: new Map(),
    vtable: [],
  };

  // Update superClassType if we have the checker type but it's not set yet
  if (
    existingInfo &&
    !classInfo.superClassType &&
    checkerIntermediateType?.superType
  ) {
    classInfo.superClassType = checkerIntermediateType.superType;
  }

  if (!existingInfo) {
    ctx.classes.set(intermediateName, classInfo);
    // Also register by struct index to support lookup when names collide
    ctx.setClassInfoByStructIndex(classInfo.structTypeIndex, classInfo);
  }

  // Register by identity for O(1) lookup if we have the checker type
  if (checkerIntermediateType) {
    ctx.registerClassInfoByType(checkerIntermediateType, classInfo);
    ctx.setClassBundledName(checkerIntermediateType, intermediateName);
    ctx.setClassStructIndex(checkerIntermediateType, classInfo.structTypeIndex);
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
      // Use checker's inferredType for identity-based resolution
      const wasmType = mapCheckerTypeToWasmType(
        ctx,
        member.typeAnnotation.inferredType!,
      );
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
    // Set inferredType so identity-based lookups work for synthetic classes
    inferredType: checkerIntermediateType,
  } as unknown as ClassDeclaration;

  ctx.syntheticClasses.push(declForGen);

  return classInfo;
}

export function typeToTypeAnnotation(
  type: Type,
  erasedTypeParams: Set<string> | undefined,
  ctx: CodegenContext,
): TypeAnnotation {
  switch (type.kind) {
    case TypeKind.Number:
      return {
        type: NodeType.TypeAnnotation,
        name: (type as NumberType).name,
        inferredType: type,
      };
    case TypeKind.Boolean:
      return {
        type: NodeType.TypeAnnotation,
        name: TypeNames.Boolean,
        inferredType: type,
      };
    case TypeKind.Void:
      return {
        type: NodeType.TypeAnnotation,
        name: TypeNames.Void,
        inferredType: type,
      };
    case TypeKind.Never:
      return {
        type: NodeType.TypeAnnotation,
        name: TypeNames.Never,
        inferredType: type,
      };
    case TypeKind.Class: {
      const classType = type as ClassType;
      // Try identity-based lookup first
      let canonicalName = ctx.getClassBundledName(classType);
      if (!canonicalName) {
        // Fall back to genericSource chain for backward compatibility
        canonicalName = classType.name;
        let source = classType.genericSource;
        while (source) {
          const sourceName = ctx.getClassBundledName(source);
          if (sourceName) {
            canonicalName = sourceName;
            break;
          }
          canonicalName = source.name;
          source = source.genericSource;
        }
      }
      let args = classType.typeArguments
        ? classType.typeArguments.map((t) =>
            typeToTypeAnnotation(t, erasedTypeParams, ctx),
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
        // Preserve the checker type for identity-based lookups in getSpecializedName
        inferredType: type,
      };
    }
    case TypeKind.Interface: {
      const ifaceType = type as InterfaceType;
      // Try identity-based lookup first
      let canonicalName = ctx.getInterfaceBundledName(ifaceType);
      if (!canonicalName) {
        // Fall back to genericSource chain for backward compatibility
        canonicalName = ifaceType.name;
        let source = ifaceType.genericSource;
        while (source) {
          const sourceName = ctx.getInterfaceBundledName(source);
          if (sourceName) {
            canonicalName = sourceName;
            break;
          }
          canonicalName = source.name;
          source = source.genericSource;
        }
      }
      const args = ifaceType.typeArguments
        ? ifaceType.typeArguments.map((t) =>
            typeToTypeAnnotation(t, erasedTypeParams, ctx),
          )
        : [];
      return {
        type: NodeType.TypeAnnotation,
        name: canonicalName,
        typeArguments: args.length > 0 ? args : undefined,
        // Preserve the checker type for identity-based lookups in getSpecializedName
        inferredType: type,
      };
    }
    case TypeKind.Array: {
      const arrayType = type as ArrayType;
      return {
        type: NodeType.TypeAnnotation,
        name: TypeNames.Array,
        typeArguments: [
          typeToTypeAnnotation(arrayType.elementType, erasedTypeParams, ctx),
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
          typeAnnotation: typeToTypeAnnotation(propType, erasedTypeParams, ctx),
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
          typeToTypeAnnotation(t, erasedTypeParams, ctx),
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
          typeToTypeAnnotation(p, newErased, ctx),
        ),
        returnType: typeToTypeAnnotation(funcType.returnType, newErased, ctx),
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
        // For distinct type aliases, preserve the alias name and attach inferredType.
        // This ensures Box<Meters> and Box<Seconds> get different specialization names
        // even though both map to i32 at the WASM level.
        return {
          type: NodeType.TypeAnnotation,
          name: aliasType.name,
          inferredType: type,
        };
      }
      // For regular type aliases (transparent), use the target type
      return typeToTypeAnnotation(aliasType.target, erasedTypeParams, ctx);
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
        inferredType: type,
      };
    }
    case TypeKind.Union: {
      const unionType = type as UnionType;
      return {
        type: NodeType.UnionTypeAnnotation,
        types: unionType.types.map((t) =>
          typeToTypeAnnotation(t, erasedTypeParams, ctx),
        ),
        inferredType: type,
      } as any;
    }
    default:
      return {
        type: NodeType.TypeAnnotation,
        name: 'any',
        inferredType: type,
      };
  }
}

/**
 * Ensures that a checker Type and all its nested types are properly instantiated
 * in codegen. This triggers WASM type generation for all generic types within:
 * - ClassTypes (including superType, implements, onType)
 * - InterfaceTypes (including extends)
 * - Field types, method parameters, and return types
 * - ArrayTypes, FunctionTypes, RecordTypes, TupleTypes
 *
 * This function is idempotent - calling it multiple times with the same type
 * will not cause duplicate instantiation due to caching in mapCheckerTypeToWasmType.
 *
 * To prevent infinite recursion with recursive types (e.g., class Node<T> with field
 * child: Node<T>), this function uses a context-level visited set that persists
 * across the entire instantiation process.
 *
 * @param ctx The codegen context
 * @param type The checker Type to ensure is fully instantiated
 * @param rootClassType Optional - the class being instantiated (to skip self-recursion)
 */
export function ensureTypeInstantiated(
  ctx: CodegenContext,
  type: Type,
  rootClassType?: ClassType,
): void {
  // Use context-level visited set to handle recursion across nested instantiateClass calls
  if (ctx.typeInstantiationVisited.has(type)) return;
  ctx.typeInstantiationVisited.add(type);

  // Skip type parameters - they're not instantiable
  if (type.kind === TypeKind.TypeParameter) return;

  // Handle class types - these are the main ones that need instantiation
  if (type.kind === TypeKind.Class) {
    const classType = type as ClassType;

    // Skip if this is the root class we're currently instantiating (avoid infinite recursion)
    if (rootClassType && classType === rootClassType) return;

    // Trigger WASM type generation for this class (this may recursively call instantiateClass)
    mapCheckerTypeToWasmType(ctx, classType);

    // Recursively ensure nested types are instantiated
    // SuperType
    if (classType.superType) {
      ensureTypeInstantiated(ctx, classType.superType, rootClassType);
    }

    // Implemented interfaces
    for (const impl of classType.implements) {
      ensureTypeInstantiated(ctx, impl, rootClassType);
    }

    // onType for extension classes
    if (classType.onType) {
      ensureTypeInstantiated(ctx, classType.onType, rootClassType);
    }

    // Type arguments
    if (classType.typeArguments) {
      for (const arg of classType.typeArguments) {
        ensureTypeInstantiated(ctx, arg, rootClassType);
      }
    }

    // Field types - use resolved types from checker if available
    if (ctx.checkerContext) {
      const resolvedFields = ctx.checkerContext.resolveFieldTypes(classType);
      for (const fieldType of resolvedFields.values()) {
        ensureTypeInstantiated(ctx, fieldType, rootClassType);
      }
    } else {
      // Fall back to fields from the type itself
      for (const fieldType of classType.fields.values()) {
        ensureTypeInstantiated(ctx, fieldType, rootClassType);
      }
    }

    // Method signatures
    for (const method of classType.methods.values()) {
      ensureTypeInstantiated(ctx, method, rootClassType);
    }

    // Constructor type
    if (classType.constructorType) {
      ensureTypeInstantiated(ctx, classType.constructorType, rootClassType);
    }

    return;
  }

  // Handle interface types
  if (type.kind === TypeKind.Interface) {
    const interfaceType = type as InterfaceType;

    // Trigger WASM type generation
    mapCheckerTypeToWasmType(ctx, interfaceType);

    // Parent interfaces
    if (interfaceType.extends) {
      for (const ext of interfaceType.extends) {
        ensureTypeInstantiated(ctx, ext, rootClassType);
      }
    }

    // Type arguments
    if (interfaceType.typeArguments) {
      for (const arg of interfaceType.typeArguments) {
        ensureTypeInstantiated(ctx, arg, rootClassType);
      }
    }

    // Field types
    for (const fieldType of interfaceType.fields.values()) {
      ensureTypeInstantiated(ctx, fieldType, rootClassType);
    }

    // Method signatures
    for (const method of interfaceType.methods.values()) {
      ensureTypeInstantiated(ctx, method, rootClassType);
    }

    return;
  }

  // Handle mixin types
  if (type.kind === TypeKind.Mixin) {
    const mixinType = type as MixinType;

    // onType (the base class for the mixin)
    if (mixinType.onType) {
      ensureTypeInstantiated(ctx, mixinType.onType, rootClassType);
    }

    // Type arguments
    if (mixinType.typeArguments) {
      for (const arg of mixinType.typeArguments) {
        ensureTypeInstantiated(ctx, arg, rootClassType);
      }
    }

    // Field types
    for (const fieldType of mixinType.fields.values()) {
      ensureTypeInstantiated(ctx, fieldType, rootClassType);
    }

    // Method signatures
    for (const method of mixinType.methods.values()) {
      ensureTypeInstantiated(ctx, method, rootClassType);
    }

    return;
  }

  // Handle function types (closures)
  if (type.kind === TypeKind.Function) {
    const funcType = type as FunctionType;

    // Trigger WASM type generation for the closure struct
    mapCheckerTypeToWasmType(ctx, funcType);

    // Parameter types
    for (const param of funcType.parameters) {
      ensureTypeInstantiated(ctx, param, rootClassType);
    }

    // Return type
    ensureTypeInstantiated(ctx, funcType.returnType, rootClassType);

    return;
  }

  // Handle array types
  if (type.kind === TypeKind.Array) {
    const arrayType = type as ArrayType;

    // Trigger WASM type generation
    mapCheckerTypeToWasmType(ctx, arrayType);

    // Element type
    ensureTypeInstantiated(ctx, arrayType.elementType, rootClassType);

    return;
  }

  // Handle record types
  if (type.kind === TypeKind.Record) {
    const recordType = type as RecordType;

    // Trigger WASM type generation
    mapCheckerTypeToWasmType(ctx, recordType);

    // Property types
    for (const propType of recordType.properties.values()) {
      ensureTypeInstantiated(ctx, propType, rootClassType);
    }

    return;
  }

  // Handle tuple types
  if (type.kind === TypeKind.Tuple) {
    const tupleType = type as TupleType;

    // Trigger WASM type generation
    mapCheckerTypeToWasmType(ctx, tupleType);

    // Element types
    for (const elemType of tupleType.elementTypes) {
      ensureTypeInstantiated(ctx, elemType, rootClassType);
    }

    return;
  }

  // Handle union types
  if (type.kind === TypeKind.Union) {
    const unionType = type as UnionType;

    // Recursively ensure all union member types are instantiated
    for (const memberType of unionType.types) {
      ensureTypeInstantiated(ctx, memberType, rootClassType);
    }

    return;
  }

  // Handle type aliases
  if (type.kind === TypeKind.TypeAlias) {
    const aliasType = type as TypeAliasType;

    // Ensure the target type is instantiated
    ensureTypeInstantiated(ctx, aliasType.target, rootClassType);

    return;
  }

  // For primitive types (Number, Boolean, Void, etc.), just trigger WASM mapping
  // to ensure any associated type indices are created
  mapCheckerTypeToWasmType(ctx, type);
}

export function mapCheckerTypeToWasmType(
  ctx: CodegenContext,
  type: Type,
): number[] {
  // Resolve type parameters via currentTypeParamMap (contains Type values).
  if (type.kind === TypeKind.TypeParameter) {
    const typeParam = type as TypeParameterType;

    // Try checker-based resolution
    if (ctx.currentTypeParamMap.has(typeParam.name)) {
      const resolved = ctx.currentTypeParamMap.get(typeParam.name)!;
      // If resolved to a non-type-parameter, use it directly
      if (resolved.kind !== TypeKind.TypeParameter) {
        return mapCheckerTypeToWasmType(ctx, resolved);
      }
      // If resolved to a DIFFERENT type parameter that's also in the map, chain
      const resolvedParam = resolved as TypeParameterType;
      if (
        resolvedParam.name !== typeParam.name &&
        ctx.currentTypeParamMap.has(resolvedParam.name)
      ) {
        return mapCheckerTypeToWasmType(ctx, resolved);
      }
    }

    throw new Error(
      `Unresolved type parameter: ${typeParam.name}, currentTypeParamMap keys: [${Array.from(ctx.currentTypeParamMap.keys()).join(', ')}], currentClass: ${ctx.currentClass?.name}`,
    );
  }

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
  if (type.kind === TypeKind.Any || type.kind === TypeKind.AnyRef)
    return [ValType.anyref];
  if (type.kind === TypeKind.ByteArray) {
    return [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(ctx.byteArrayTypeIndex),
    ];
  }
  if (type.kind === TypeKind.Unknown) return [ValType.anyref];

  // Handle This type - resolve to current class if available
  if (type.kind === TypeKind.This) {
    if (ctx.currentClass) {
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(ctx.currentClass.structTypeIndex),
      ];
    }
    // In interface context (no currentClass), use anyref
    return [ValType.anyref];
  }

  // Handle ClassType directly using identity-based lookups
  if (type.kind === TypeKind.Class) {
    const classType = type as ClassType;
    let classInfo = resolveClassInfo(ctx, classType);
    if (classInfo) {
      // Extension classes (like FixedArray, String) return their onType
      if (classInfo.isExtension && classInfo.onType) {
        return classInfo.onType;
      }
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
      ];
    }

    // Identity lookup failed - trigger instantiation while we still have the checker type
    // This is the key integration point: convert checker type to TypeAnnotation for
    // instantiation, but pass the checker type for registration
    if (classType.typeArguments && classType.typeArguments.length > 0) {
      // Generic class - need to instantiate
      // Use identity-based lookup for the generic declaration
      const genericSource = classType.genericSource ?? classType;
      let genericDecl = ctx.getGenericDeclByType(genericSource);

      // Fallback: search by name (handles bundled names)
      if (!genericDecl) {
        const targetName = classType.name;
        for (const [name, decl] of ctx.genericClasses.entries()) {
          if (name === targetName || name.endsWith('_' + targetName)) {
            genericDecl = decl;
            break;
          }
        }
      }

      if (genericDecl) {
        // Use bundled name to avoid collisions with same-named classes from different modules
        const genericSource = classType.genericSource ?? classType;
        const bundledName =
          ctx.getClassBundledName(genericSource) ?? genericDecl.name.name;
        const specializedName = getSpecializedNameFromCheckerTypes(
          bundledName,
          classType.typeArguments,
          ctx,
        );
        if (!ctx.classes.has(specializedName)) {
          instantiateClass(
            ctx,
            genericDecl,
            specializedName,
            classType, // Pass checker type directly - it contains all type info
          );
        } else {
          // Class was previously instantiated via annotation path (without checker type).
          // Register our checker type so identity-based lookups work.
          const existingInfo = ctx.classes.get(specializedName)!;
          ctx.registerClassInfoByType(classType, existingInfo);
        }
        classInfo = ctx.classes.get(specializedName);
        if (classInfo) {
          if (classInfo.isExtension && classInfo.onType) {
            return classInfo.onType;
          }
          return [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          ];
        }
      }
    }
    // Fall through to annotation-based lookup if identity lookup fails
  }

  // Handle InterfaceType directly using identity-based lookups
  if (type.kind === TypeKind.Interface) {
    const interfaceType = type as InterfaceType;
    const structIndex = resolveInterfaceStructIndex(ctx, interfaceType);
    if (structIndex !== undefined) {
      return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(structIndex)];
    }
    // Fall back to name-based lookup - needed when interface is not yet
    // registered by identity (e.g., during method signature resolution)
    const interfaceInfo = ctx.interfaces.get(interfaceType.name);
    if (interfaceInfo) {
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
      ];
    }
    // Still not found - interface may not be registered yet; erase to anyref
    // This happens when an interface is used in a method signature before registration
    return [ValType.anyref];
  }

  // Handle Union types - use anyref for nullable reference types
  if (type.kind === TypeKind.Union) {
    const unionType = type as UnionType;
    // Check if it's a nullable reference type (T | null)
    const nonNullTypes = unionType.types.filter(
      (t) => t.kind !== TypeKind.Null,
    );
    if (nonNullTypes.length === 1) {
      // It's T | null - use the non-null type's mapping
      return mapCheckerTypeToWasmType(ctx, nonNullTypes[0]);
    }
    // Check if all types are literals (e.g., enum values) - use the base type
    if (
      nonNullTypes.length > 0 &&
      nonNullTypes.every((t) => t.kind === TypeKind.Literal)
    ) {
      // All literals should have the same base type, use the first one
      return mapCheckerTypeToWasmType(ctx, nonNullTypes[0]);
    }
    // For other unions (reference types), use anyref
    return [ValType.anyref];
  }

  // Handle Literal types - map to their base type
  if (type.kind === TypeKind.Literal) {
    const litType = type as LiteralType;
    if (typeof litType.value === 'number') {
      return [ValType.i32];
    } else if (typeof litType.value === 'string') {
      // String literals map to the String type
      if (ctx.stringTypeIndex === -1) {
        throw new Error('String type not initialized');
      }
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(ctx.stringTypeIndex),
      ];
    } else if (typeof litType.value === 'boolean') {
      return [ValType.i32];
    }
  }

  // Handle ArrayType directly (WASM GC array)
  if (type.kind === TypeKind.Array) {
    const arrayType = type as ArrayType;
    const elementWasmType = mapCheckerTypeToWasmType(
      ctx,
      arrayType.elementType,
    );
    const typeIndex = ctx.getArrayTypeIndex(elementWasmType);
    return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
  }

  // Handle RecordType directly
  if (type.kind === TypeKind.Record) {
    const recordType = type as RecordType;
    const fields: {name: string; type: number[]}[] = [];
    for (const [name, propType] of recordType.properties) {
      fields.push({name, type: mapCheckerTypeToWasmType(ctx, propType)});
    }
    const typeIndex = ctx.getRecordTypeIndex(fields);
    return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
  }

  // Handle TupleType directly
  if (type.kind === TypeKind.Tuple) {
    const tupleType = type as TupleType;
    const elementTypes = tupleType.elementTypes.map((el) =>
      mapCheckerTypeToWasmType(ctx, el),
    );
    const typeIndex = ctx.getTupleTypeIndex(elementTypes);
    return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
  }

  // Handle FunctionType directly (closure struct)
  if (type.kind === TypeKind.Function) {
    const funcType = type as FunctionType;
    const paramTypes = funcType.parameters.map((p) =>
      mapCheckerTypeToWasmType(ctx, p),
    );
    const returnType = mapCheckerTypeToWasmType(ctx, funcType.returnType);
    const typeIndex = ctx.getClosureTypeIndex(paramTypes, returnType);
    return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
  }

  // Handle TypeAlias - resolve to target type
  if (type.kind === TypeKind.TypeAlias) {
    const aliasType = type as TypeAliasType;
    return mapCheckerTypeToWasmType(ctx, aliasType.target);
  }

  // All type kinds should be handled above
  throw new Error(
    `mapCheckerTypeToWasmType: unhandled type kind ${type.kind} (${TypeKind[type.kind]})`,
  );
}

/**
 * Resolve the ClassInfo for a ClassType using identity-based lookups.
 * Handles both non-generic classes (via struct index map) and generic
 * instantiations (via specialization registry).
 *
 * For extension classes, computes the correct `onType` from the stored
 * `onTypeAnnotation` and the current type arguments.
 *
 * NOTE: This function returns undefined for generic types that need instantiation.
 * It only returns ClassInfo for:
 * 1. Non-generic classes (direct lookup)
 * 2. Generic specializations that have already been instantiated
 *
 * It does NOT return the template ClassInfo when given a specialized type -
 * that would give wrong methods. Caller must handle instantiation.
 */
function resolveClassInfo(
  ctx: CodegenContext,
  classType: ClassType,
): ClassInfo | undefined {
  // Try identity-based WeakMap lookup first (fastest path - O(1))
  // This finds classes that have been registered by their exact checker type
  const classInfo = ctx.getClassInfoByCheckerType(classType);
  if (classInfo) {
    // For extension classes, recompute onType if we have type arguments
    if (classInfo.isExtension && classInfo.onTypeAnnotation) {
      return resolveExtensionClassInfo(ctx, classInfo, classType);
    }
    return classInfo;
  }

  // If the type has type arguments but wasn't found, we need instantiation
  // Do NOT return the template - it has wrong methods
  if (classType.typeArguments && classType.typeArguments.length > 0) {
    return undefined;
  }

  // For non-generic types, try following genericSource chain
  // (This handles cases where a specialized type was created but the
  // template is registered - should be rare after type interning)
  let source = classType.genericSource;
  while (source) {
    const sourceInfo = ctx.getClassInfoByCheckerType(source);
    if (sourceInfo) {
      // Only return if this is NOT a generic template
      // (i.e., it doesn't have unresolved type parameters)
      if (
        !sourceInfo.typeArguments ||
        sourceInfo.typeArguments.size === 0 ||
        !classType.typeArguments ||
        classType.typeArguments.length === 0
      ) {
        if (sourceInfo.isExtension && sourceInfo.onTypeAnnotation) {
          return resolveExtensionClassInfo(ctx, sourceInfo, classType);
        }
        return sourceInfo;
      }
    }
    source = source.genericSource;
  }

  // WeakMap lookup failed - try struct index lookup as last resort (O(n))
  // This handles cases where the class was registered via struct index
  // but not yet registered in the WeakMap
  const structInfo = ctx.getClassInfoByType(classType);
  if (structInfo) {
    // For extension classes, recompute onType if we have type arguments
    if (structInfo.isExtension && structInfo.onTypeAnnotation) {
      return resolveExtensionClassInfo(ctx, structInfo, classType);
    }
    return structInfo;
  }

  // Identity lookup failed - caller will handle via mapCheckerTypeToWasmType,
  // which triggers instantiateClass() for generic classes.
  return undefined;
}

/**
 * Resolve an extension ClassInfo by computing the correct onType for the given type arguments.
 * Extension classes like FixedArray<T> need their onType (array<T>) computed fresh at each
 * use site because the WASM array type index depends on the element type.
 */
function resolveExtensionClassInfo(
  ctx: CodegenContext,
  classInfo: ClassInfo,
  classType: ClassType,
): ClassInfo {
  // If no type arguments, use the stored onType
  if (!classType.typeArguments || classType.typeArguments.length === 0) {
    return classInfo;
  }

  // Compute the correct onType directly from the checker's ClassType.
  // The checker always sets onType for extension classes with concrete type arguments.
  if (!classType.onType) {
    throw new Error(
      `Extension class ${classInfo.name} missing onType in checker type`,
    );
  }
  const onType = mapCheckerTypeToWasmType(ctx, classType.onType);

  // Return a modified ClassInfo with the correct onType
  // Note: We don't mutate the original classInfo to avoid affecting other use sites
  return {
    ...classInfo,
    onType,
  };
}

/**
 * Resolve the WASM struct index for an InterfaceType using identity-based lookups.
 */
function resolveInterfaceStructIndex(
  ctx: CodegenContext,
  interfaceType: InterfaceType,
): number | undefined {
  // Try direct identity lookup
  let structIndex = ctx.getInterfaceStructIndex(interfaceType);
  if (structIndex !== undefined) {
    return structIndex;
  }

  // Follow genericSource chain
  let source = interfaceType.genericSource;
  while (source) {
    structIndex = ctx.getInterfaceStructIndex(source);
    if (structIndex !== undefined) {
      return structIndex;
    }
    source = source.genericSource;
  }

  return undefined;
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
