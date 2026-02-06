import {NodeType, type TypeAnnotation} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  TypeKind,
  Types,
  TypeNames,
  type ArrayType,
  type ClassType,
  type FunctionType,
  type InterfaceType,
  type LiteralType,
  type MixinType,
  type NumberType,
  type RecordType,
  type ThisType,
  type TupleType,
  type Type,
  type TypeAliasType,
  type TypeParameterType,
  type UnboxedTupleType,
  type UnionType,
} from '../types.js';
import type {CheckerContext} from './context.js';

/**
 * Returns the primitive base type for union validation.
 * Returns a string identifier if the type is a primitive, null otherwise.
 * Used to check that all primitives in a union share the same base type.
 */
function getPrimitiveBase(type: Type): string | null {
  if (type.kind === TypeKind.Number) {
    // For NumberType, use the specific numeric name (i32, f64, etc.)
    return (type as NumberType).name;
  }
  if (type.kind === TypeKind.Boolean) {
    return 'boolean';
  }
  if (type.kind === TypeKind.Literal) {
    const lit = type as LiteralType;
    if (typeof lit.value === 'boolean') {
      return 'boolean';
    }
    // TODO: Handle numeric literal types when implemented
  }
  if (type.kind === TypeKind.TypeAlias) {
    return getPrimitiveBase((type as TypeAliasType).target);
  }
  if (type.kind === TypeKind.Class && (type as ClassType).isExtension) {
    return getPrimitiveBase((type as ClassType).onType!);
  }
  return null;
}

/**
 * Checks if a type is a boolean type (either TypeKind.Boolean or a boolean literal type).
 * This is used to validate boolean conditions in if/while/for statements.
 */
export function isBooleanType(type: Type): boolean {
  if (type.kind === TypeKind.Boolean) return true;
  if (type.kind === TypeKind.Literal) {
    const lit = type as LiteralType;
    return typeof lit.value === 'boolean';
  }
  // Handle union of boolean literal types (true | false)
  if (type.kind === TypeKind.Union) {
    const union = type as UnionType;
    return union.types.every((member) => isBooleanType(member));
  }
  return false;
}

/**
 * Widens a literal type to its base type.
 * For example, LiteralType{value: true} -> Types.Boolean
 * This is used for mutable variables (var) to allow reassignment.
 */
export function widenLiteralType(type: Type, ctx: CheckerContext): Type {
  if (type.kind !== TypeKind.Literal) return type;

  const lit = type as LiteralType;
  if (typeof lit.value === 'boolean') {
    return Types.Boolean;
  } else if (typeof lit.value === 'number') {
    return Types.I32; // Default to i32 for number literals
  } else if (typeof lit.value === 'string') {
    // String literals widen to the stdlib String type
    return ctx.getWellKnownType(Types.String.name) || Types.String;
  }
  return type;
}

/**
 * Substitutes type parameters in a type with concrete types from a map.
 * This is used during generic instantiation to replace T with i32, etc.
 * Also handles substitution of `this` type using the special key '$this'.
 *
 * @param type The type to substitute parameters in.
 * @param typeMap A map from type parameter names to concrete types.
 * @param ctx Checker context for type interning.
 * @returns The substituted type.
 */
export function substituteType(
  type: Type,
  typeMap: Map<string, Type>,
  ctx: CheckerContext,
): Type {
  if (type.kind === TypeKind.TypeParameter) {
    return typeMap.get((type as TypeParameterType).name) || type;
  }
  // Handle `this` type substitution
  if (type.kind === TypeKind.This) {
    return typeMap.get('$this') || type;
  }
  if (type.kind === TypeKind.Array) {
    const newElementType = substituteType(
      (type as ArrayType).elementType,
      typeMap,
      ctx,
    );
    // Return original if element type unchanged (avoid creating new instance)
    if (newElementType === (type as ArrayType).elementType) {
      return type;
    }
    return ctx.getOrCreateArrayType(newElementType);
  }
  if (type.kind === TypeKind.Class) {
    const ct = type as ClassType;
    if (ct.typeArguments) {
      const newTypeArguments = ct.typeArguments.map((t) =>
        substituteType(t, typeMap, ctx),
      );

      // Check if the substitution is a no-op (all typeArguments unchanged)
      const isNoOp = newTypeArguments.every(
        (newArg, i) => newArg === ct.typeArguments![i],
      );
      if (isNoOp) {
        return ct;
      }

      // For self-referential types, we need to avoid infinite recursion.
      // We do this by NOT recursively substituting fields/methods here.
      // Instead, we just update the typeArguments and keep a reference to the generic source.
      // The field types will be resolved on-demand using resolveMemberType in expressions.ts.
      //
      // This is safe because:
      // 1. Field/method types are defined in terms of the class's type parameters
      // 2. When accessing a field/method, resolveMemberType substitutes using typeArguments
      // 3. This breaks the infinite recursion that would occur if we tried to fully
      //    substitute all fields here (e.g., Node<T> with field child: Node<T>)

      const source = ct.genericSource || ct;

      // Check if all typeArguments are TypeParameterTypes matching the source's typeParameters
      // (identity substitution). In that case, return with typeArguments set.
      if (
        source.typeParameters &&
        newTypeArguments.length === source.typeParameters.length &&
        newTypeArguments.every(
          (arg, i) =>
            arg.kind === TypeKind.TypeParameter &&
            (arg as TypeParameterType).name === source.typeParameters![i].name,
        )
      ) {
        return {
          ...source,
          typeArguments: newTypeArguments,
          // Set genericSource for identity-based lookups in codegen.
          // Without this, the new object won't be recognized as the same type.
          genericSource:
            source.genericSource ||
            (source.typeParameters ? source : undefined),
        } as ClassType;
      }

      // Check interning cache first - return cached instance if available
      const cached = ctx.getInternedClass(source, newTypeArguments);
      if (cached) {
        return cached;
      }

      // Substitute the implements list so interface assignability checks work correctly.
      // This is safe because interfaces don't have self-referential fields.
      const newImplements = source.implements.map(
        (impl) => substituteType(impl, typeMap, ctx) as InterfaceType,
      );

      // Substitute onType for extension classes so identity-based lookups work.
      // We need a separate typeMap that maps the CLASS's type parameters to the
      // newTypeArguments, not the outer context's typeMap.
      // For example, if FixedArray<T> has onType=array<T>, and we're creating
      // FixedArray<Entry<String,Box<i32>>>, we need T -> Entry<String,Box<i32>>.
      let newOnType: Type | undefined;
      let newSuperType: ClassType | undefined;

      // Build inner type map for this class's type parameters
      const innerTypeMap = new Map<string, Type>();
      if (source.typeParameters) {
        source.typeParameters.forEach((param, index) => {
          if (index < newTypeArguments.length) {
            innerTypeMap.set(param.name, newTypeArguments[index]);
          }
        });
      }

      if (source.onType) {
        newOnType =
          innerTypeMap.size > 0
            ? substituteType(source.onType, innerTypeMap, ctx)
            : source.onType;
      }

      // Substitute superType so that Derived<i32> extends Base<i32>, not Base<T>
      if (source.superType) {
        newSuperType =
          innerTypeMap.size > 0
            ? (substituteType(source.superType, innerTypeMap, ctx) as ClassType)
            : source.superType;
      }

      // Return a ClassType with substituted typeArguments but shared fields/methods from source.
      // The genericSource allows resolveMemberType to properly substitute field types on access.
      // Explicitly copy isExtension and onType to ensure extension class metadata is preserved.
      const newClass = {
        ...source,
        typeArguments: newTypeArguments,
        implements: newImplements,
        isExtension: source.isExtension,
        onType: newOnType,
        superType: newSuperType,
        genericSource:
          source.genericSource || (source.typeParameters ? source : undefined),
      } as ClassType;

      // Store in interning cache
      ctx.internClass(source, newTypeArguments, newClass);

      return newClass;
    }
  }
  if (type.kind === TypeKind.Interface) {
    const it = type as InterfaceType;
    if (it.typeArguments) {
      const newTypeArguments = it.typeArguments.map((t) =>
        substituteType(t, typeMap, ctx),
      );

      const newFields = new Map<string, Type>();
      for (const [name, type] of it.fields) {
        newFields.set(name, substituteType(type, typeMap, ctx));
      }

      const newMethods = new Map<string, FunctionType>();
      for (const [name, fn] of it.methods) {
        newMethods.set(name, substituteType(fn, typeMap, ctx) as FunctionType);
      }

      const newExtends = it.extends
        ? it.extends.map(
            (ext) => substituteType(ext, typeMap, ctx) as InterfaceType,
          )
        : undefined;

      return {
        ...it,
        typeArguments: newTypeArguments,
        fields: newFields,
        methods: newMethods,
        extends: newExtends,
      } as InterfaceType;
    }
  }
  if (type.kind === TypeKind.Mixin) {
    const mt = type as MixinType;
    if (mt.typeArguments) {
      const newTypeArguments = mt.typeArguments.map((t) =>
        substituteType(t, typeMap, ctx),
      );

      const newFields = new Map<string, Type>();
      for (const [name, type] of mt.fields) {
        newFields.set(name, substituteType(type, typeMap, ctx));
      }

      const newMethods = new Map<string, FunctionType>();
      for (const [name, fn] of mt.methods) {
        newMethods.set(name, substituteType(fn, typeMap, ctx) as FunctionType);
      }

      const newOnType = mt.onType
        ? (substituteType(mt.onType, typeMap, ctx) as ClassType)
        : undefined;

      return {
        ...mt,
        typeArguments: newTypeArguments,
        fields: newFields,
        methods: newMethods,
        onType: newOnType,
      } as MixinType;
    }
  }
  if (type.kind === TypeKind.Function) {
    const ft = type as FunctionType;
    return {
      ...ft,
      parameters: ft.parameters.map((t) => substituteType(t, typeMap, ctx)),
      returnType: substituteType(ft.returnType, typeMap, ctx),
    } as FunctionType;
  }
  if (type.kind === TypeKind.Union) {
    const ut = type as UnionType;
    return {
      ...ut,
      types: ut.types.map((t) => substituteType(t, typeMap, ctx)),
    } as UnionType;
  }
  if (type.kind === TypeKind.Record) {
    const rt = type as RecordType;
    const newProperties = new Map<string, Type>();
    for (const [key, value] of rt.properties) {
      newProperties.set(key, substituteType(value, typeMap, ctx));
    }
    return {
      ...rt,
      properties: newProperties,
    } as RecordType;
  }
  if (type.kind === TypeKind.Tuple) {
    const tt = type as TupleType;
    return {
      ...tt,
      elementTypes: tt.elementTypes.map((t) => substituteType(t, typeMap, ctx)),
    } as TupleType;
  }
  if (type.kind === TypeKind.UnboxedTuple) {
    const ut = type as UnboxedTupleType;
    return {
      ...ut,
      elementTypes: ut.elementTypes.map((t) => substituteType(t, typeMap, ctx)),
    } as UnboxedTupleType;
  }
  return type;
}

/**
 * Resolves a type annotation from the AST into a semantic Type.
 * Handles primitive types, class references, unions, function types, etc.
 * Also attaches the resolved type to the annotation as `inferredType` for
 * use in codegen (enables identity-based lookups to avoid name collisions).
 *
 * @param ctx The checker context.
 * @param annotation The AST type annotation.
 * @returns The resolved semantic Type.
 */
export function resolveTypeAnnotation(
  ctx: CheckerContext,
  annotation: TypeAnnotation,
): Type {
  const result = resolveTypeAnnotationInternal(ctx, annotation);
  // Attach the resolved type to the annotation for use in codegen.
  // This enables identity-based lookups without re-resolving names.
  annotation.inferredType = result;
  return result;
}

function resolveTypeAnnotationInternal(
  ctx: CheckerContext,
  annotation: TypeAnnotation,
): Type {
  if (annotation.type === NodeType.LiteralTypeAnnotation) {
    return {
      kind: TypeKind.Literal,
      value: annotation.value,
    } as LiteralType;
  }

  // Handle `this` type annotation
  if (annotation.type === NodeType.ThisTypeAnnotation) {
    // In a class context, resolve immediately to the class type
    if (ctx.currentClass) {
      return ctx.currentClass;
    }
    // In an interface context, keep as ThisType (resolved during implementation checking)
    if (ctx.currentInterface) {
      return {kind: TypeKind.This} as ThisType;
    }
    // Not in a class or interface
    ctx.diagnostics.reportError(
      `'this' type is only valid inside a class or interface.`,
      DiagnosticCode.TypeMismatch,
    );
    return Types.Unknown;
  }

  if (annotation.type === NodeType.UnionTypeAnnotation) {
    const types = annotation.types.map((t) => resolveTypeAnnotation(ctx, t));

    // Validate primitive/reference mixing in unions.
    // Rules:
    // 1. Primitives can union with primitives of the SAME base type (true | false, 1 | 2)
    // 2. Primitives CANNOT union with references (true | null, i32 | String)
    // 3. Primitives CANNOT union with primitives of DIFFERENT base types (i32 | f32, 1 | 1.0)
    const primitiveBases = new Set<string>();
    let hasPrimitive = false;
    let hasReference = false;

    for (const t of types) {
      const base = getPrimitiveBase(t);
      if (base !== null) {
        hasPrimitive = true;
        primitiveBases.add(base);
      } else {
        hasReference = true;
      }
    }

    if (hasPrimitive && hasReference) {
      ctx.diagnostics.reportError(
        `Union types cannot mix primitive types with reference types. Use 'Box<T>' to box primitives.`,
        DiagnosticCode.TypeMismatch,
      );
    } else if (primitiveBases.size > 1) {
      ctx.diagnostics.reportError(
        `Union types cannot mix primitives of different base types (e.g., i32 | f32). All primitives must share the same base type.`,
        DiagnosticCode.TypeMismatch,
      );
    }

    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const t1 = types[i];
        const t2 = types[j];

        const ext1 =
          t1.kind === TypeKind.Class && (t1 as ClassType).isExtension
            ? (t1 as ClassType)
            : null;
        const ext2 =
          t2.kind === TypeKind.Class && (t2 as ClassType).isExtension
            ? (t2 as ClassType)
            : null;

        if (ext1 && ext2 && ext1.onType && ext2.onType) {
          if (
            isAssignableTo(ctx, ext1.onType, ext2.onType) &&
            isAssignableTo(ctx, ext2.onType, ext1.onType)
          ) {
            ctx.diagnostics.reportError(
              `Union types cannot contain multiple extension types on the same underlying type: '${typeToString(t1)}' and '${typeToString(t2)}'.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }

        // Check for ambiguous distinct types
        const dist1 =
          t1.kind === TypeKind.TypeAlias && (t1 as TypeAliasType).isDistinct
            ? (t1 as TypeAliasType)
            : null;
        const dist2 =
          t2.kind === TypeKind.TypeAlias && (t2 as TypeAliasType).isDistinct
            ? (t2 as TypeAliasType)
            : null;

        if (dist1 && dist2) {
          // If they are different distinct types (by name) but have the same underlying type (recursively),
          // they are ambiguous in a union because they erase to the same thing.
          // Note: We only care if they are DIFFERENT distinct types.
          // If they are the same, it's just redundancy (which is fine or handled elsewhere).
          if (dist1.name !== dist2.name) {
            // Check if underlying types are compatible/same
            if (
              isAssignableTo(ctx, dist1.target, dist2.target) &&
              isAssignableTo(ctx, dist2.target, dist1.target)
            ) {
              ctx.diagnostics.reportError(
                `Union types cannot contain multiple distinct types that erase to the same underlying type: '${typeToString(t1)}' and '${typeToString(t2)}'.`,
                DiagnosticCode.TypeMismatch,
              );
            }
          }
        }
      }
    }

    return {
      kind: TypeKind.Union,
      types,
    } as UnionType;
  }

  if (annotation.type === NodeType.RecordTypeAnnotation) {
    const properties = new Map<string, Type>();
    for (const prop of annotation.properties) {
      properties.set(
        prop.name.name,
        resolveTypeAnnotation(ctx, prop.typeAnnotation),
      );
    }
    return {
      kind: TypeKind.Record,
      properties,
    } as RecordType;
  }

  if (annotation.type === NodeType.TupleTypeAnnotation) {
    const elementTypes = annotation.elementTypes.map((t) =>
      resolveTypeAnnotation(ctx, t),
    );
    return {
      kind: TypeKind.Tuple,
      elementTypes,
    } as TupleType;
  }

  if (annotation.type === NodeType.UnboxedTupleTypeAnnotation) {
    const elementTypes = annotation.elementTypes.map((t) =>
      resolveTypeAnnotation(ctx, t),
    );
    return {
      kind: TypeKind.UnboxedTuple,
      elementTypes,
    } as UnboxedTupleType;
  }

  if (annotation.type === NodeType.FunctionTypeAnnotation) {
    const parameters = annotation.params.map((p) =>
      resolveTypeAnnotation(ctx, p),
    );
    const returnType = resolveTypeAnnotation(ctx, annotation.returnType);
    return {
      kind: TypeKind.Function,
      parameters,
      returnType,
    } as FunctionType;
  }

  const name = annotation.name;

  // Resolve the type name in the current context.
  // ctx.resolveType() walks the scope stack from innermost to outermost,
  // so this respects lexical scoping and allows shadowing of types.
  // For example, a local 'type String = i32' will be found here,
  // shadowing the global 'String' class or built-in types.
  const type = ctx.resolveType(name);

  if (!type) {
    ctx.diagnostics.reportError(
      `Unknown type '${name}'.`,
      DiagnosticCode.SymbolNotFound,
    );
    return Types.Unknown;
  }

  if (type.kind === TypeKind.TypeAlias) {
    const alias = type as TypeAliasType;
    if (alias.typeParameters && alias.typeParameters.length > 0) {
      if (
        !annotation.typeArguments ||
        annotation.typeArguments.length !== alias.typeParameters.length
      ) {
        ctx.diagnostics.reportError(
          `Generic type alias '${name}' requires ${alias.typeParameters.length} type arguments.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return Types.Unknown;
      }
      const typeArguments = annotation.typeArguments.map((arg) =>
        resolveTypeAnnotation(ctx, arg),
      );
      const typeMap = new Map<string, Type>();
      alias.typeParameters.forEach(
        (param: TypeParameterType, index: number) => {
          typeMap.set(param.name, typeArguments[index]);
        },
      );
      const substituted = substituteType(alias.target, typeMap, ctx);
      if (alias.isDistinct) {
        // Return a new TypeAliasType that is distinct but has the substituted target
        // This is tricky because TypeAliasType definition assumes generic params are on the alias definition,
        // but here we have an instantiated alias.
        // For now, let's just return the alias type itself if it's not generic,
        // but for generic distinct types, we need to represent the instantiation.
        // Let's assume distinct types are opaque.
        // We need to return a type that preserves the "distinctness".
        // If we return `substituted`, we lose the distinctness.
        // If we return `alias`, we lose the type arguments.
        // We probably need `TypeAliasInstance` or similar if we want to support generic distinct types fully.
        // For now, let's just return the substituted target if it's generic, effectively ignoring distinct on generics?
        // No, that's bad.
        // Let's create a specialized TypeAliasType for the instance.
        return {
          kind: TypeKind.TypeAlias,
          name: alias.name,
          target: substituted,
          isDistinct: true,
        } as TypeAliasType;
      }
      return substituted;
    }
    if (annotation.typeArguments && annotation.typeArguments.length > 0) {
      ctx.diagnostics.reportError(
        `Type alias '${name}' is not generic.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
      );
    }
    if (alias.isDistinct) {
      return alias;
    }
    return alias.target;
  }

  if (type.kind === TypeKind.Array) {
    if (!annotation.typeArguments || annotation.typeArguments.length !== 1) {
      ctx.diagnostics.reportError(
        `Generic type '${name}' requires 1 type argument.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
      );
      return type;
    }
    const elementType = resolveTypeAnnotation(ctx, annotation.typeArguments[0]);
    return ctx.getOrCreateArrayType(elementType);
  }

  if (
    type.kind === TypeKind.Class ||
    type.kind === TypeKind.Interface ||
    type.kind === TypeKind.Mixin
  ) {
    const genericType = type as ClassType | InterfaceType | MixinType;
    const typeParameters = genericType.typeParameters || [];
    const typeArguments = annotation.typeArguments || [];

    if (typeParameters.length > 0) {
      if (typeArguments.length === 0) {
        ctx.diagnostics.reportError(
          `Generic type '${name}' requires ${typeParameters.length} type arguments.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }
      if (typeArguments.length !== typeParameters.length) {
        ctx.diagnostics.reportError(
          `Expected ${typeParameters.length} type arguments, got ${typeArguments.length}.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }

      const resolvedArgs = typeArguments.map((arg) =>
        resolveTypeAnnotation(ctx, arg),
      );

      // Unboxed tuples cannot appear as type arguments
      for (const arg of resolvedArgs) {
        validateNoUnboxedTuple(arg, ctx, 'type arguments');
      }

      if (type.kind === TypeKind.Class) {
        return instantiateGenericClass(type as ClassType, resolvedArgs, ctx);
      } else if (type.kind === TypeKind.Interface) {
        return instantiateGenericInterface(
          type as InterfaceType,
          resolvedArgs,
          ctx,
        );
      } else {
        return instantiateGenericMixin(type as MixinType, resolvedArgs, ctx);
      }
    } else {
      if (typeArguments.length > 0) {
        ctx.diagnostics.reportError(
          `Type '${name}' is not generic.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
      }
      return type;
    }
  }

  if (annotation.typeArguments && annotation.typeArguments.length > 0) {
    ctx.diagnostics.reportError(
      `Type '${name}' is not generic.`,
      DiagnosticCode.GenericTypeArgumentMismatch,
    );
    return type;
  }

  return type;
}

/**
 * Checks if a type contains an unboxed tuple type anywhere in its structure.
 * Used to validate that unboxed tuples only appear in return positions.
 */
export function containsUnboxedTuple(type: Type): boolean {
  switch (type.kind) {
    case TypeKind.UnboxedTuple:
      return true;
    case TypeKind.Union:
      return (type as UnionType).types.some(containsUnboxedTuple);
    case TypeKind.Array:
      return containsUnboxedTuple((type as ArrayType).elementType);
    case TypeKind.Tuple:
      return (type as TupleType).elementTypes.some(containsUnboxedTuple);
    case TypeKind.Record:
      // RecordType.properties is a Map<string, Type>
      for (const propType of (type as RecordType).properties.values()) {
        if (containsUnboxedTuple(propType)) return true;
      }
      return false;
    case TypeKind.Function:
      // Return type of nested function may contain unboxed tuple - that's valid
      // But parameters cannot
      return (type as FunctionType).parameters.some(containsUnboxedTuple);
    default:
      return false;
  }
}

/**
 * Validates that a type does not contain unboxed tuples.
 * Unboxed tuples are only allowed in function return types, not in:
 * - Variable types
 * - Field types
 * - Parameter types
 * - Generic type arguments
 */
export function validateNoUnboxedTuple(
  type: Type,
  ctx: CheckerContext,
  context: string,
) {
  if (containsUnboxedTuple(type)) {
    ctx.diagnostics.reportError(
      `Unboxed tuple types can only appear in function return types, not in ${context}.`,
      DiagnosticCode.TypeMismatch,
    );
  }
}

export function validateType(type: Type, ctx: CheckerContext) {
  if (type.kind === TypeKind.Union) {
    const ut = type as UnionType;

    // Same validation as in resolveTypeAnnotation
    const primitiveBases = new Set<string>();
    let hasPrimitive = false;
    let hasReference = false;

    for (const t of ut.types) {
      const base = getPrimitiveBase(t);
      if (base !== null) {
        hasPrimitive = true;
        primitiveBases.add(base);
      } else {
        hasReference = true;
      }
    }

    if (hasPrimitive && hasReference) {
      ctx.diagnostics.reportError(
        `Union types cannot mix primitive types with reference types. Use 'Box<T>' to box primitives.`,
        DiagnosticCode.TypeMismatch,
      );
    } else if (primitiveBases.size > 1) {
      ctx.diagnostics.reportError(
        `Union types cannot mix primitives of different base types (e.g., i32 | f32). All primitives must share the same base type.`,
        DiagnosticCode.TypeMismatch,
      );
    }

    for (const t of ut.types) {
      validateType(t, ctx);
    }
  } else if (type.kind === TypeKind.Array) {
    validateType((type as ArrayType).elementType, ctx);
  } else if (type.kind === TypeKind.Function) {
    const ft = type as FunctionType;
    ft.parameters.forEach((p) => validateType(p, ctx));
    validateType(ft.returnType, ctx);
  } else if (type.kind === TypeKind.Record) {
    (type as RecordType).properties.forEach((p) => validateType(p, ctx));
  } else if (type.kind === TypeKind.Tuple) {
    (type as TupleType).elementTypes.forEach((p) => validateType(p, ctx));
  }
}

function substituteFunctionType(
  fn: FunctionType,
  typeMap: Map<string, Type>,
  ctx: CheckerContext,
): FunctionType {
  return {
    ...fn,
    parameters: fn.parameters.map((p) => substituteType(p, typeMap, ctx)),
    returnType: substituteType(fn.returnType, typeMap, ctx),
  };
}

/**
 * Validates that type arguments satisfy their corresponding type parameter constraints.
 * Assumes that typeArguments.length === typeParameters.length (validated by caller).
 */
export function validateTypeArgumentConstraints(
  ctx: CheckerContext,
  typeParameters: TypeParameterType[],
  typeArguments: Type[],
): void {
  // Defensive check: ensure we have matching lengths
  if (typeArguments.length !== typeParameters.length) {
    return;
  }

  for (let i = 0; i < typeParameters.length; i++) {
    const param = typeParameters[i];
    const arg = typeArguments[i];

    if (param.constraint) {
      // Substitute type parameters in the constraint with actual type arguments
      const typeMap = new Map<string, Type>();
      for (let j = 0; j < typeParameters.length; j++) {
        typeMap.set(typeParameters[j].name, typeArguments[j]);
      }
      const substitutedConstraint = substituteType(
        param.constraint,
        typeMap,
        ctx,
      );

      // If the argument is itself a type parameter with a constraint,
      // check if its constraint satisfies the required constraint.
      // For example: class DogContainer<T extends Dog> extends Container<T>
      // Here T's constraint (Dog) must be assignable to Container's constraint (Animal)
      let effectiveArg = arg;
      if (arg.kind === TypeKind.TypeParameter) {
        const argParam = arg as TypeParameterType;
        if (argParam.constraint) {
          effectiveArg = argParam.constraint;
        }
      }

      // Check if the type argument (or its constraint) is assignable to the constraint
      if (!isAssignableTo(ctx, effectiveArg, substitutedConstraint)) {
        ctx.diagnostics.reportError(
          `Type '${typeToString(arg)}' does not satisfy constraint '${typeToString(substitutedConstraint)}' for type parameter '${param.name}'.`,
          DiagnosticCode.TypeMismatch,
        );
      }
    }
  }
}

export function instantiateGenericClass(
  genericClass: ClassType,
  typeArguments: Type[],
  ctx: CheckerContext,
): ClassType {
  // Validate type argument constraints
  if (genericClass.typeParameters) {
    validateTypeArgumentConstraints(
      ctx,
      genericClass.typeParameters,
      typeArguments,
    );
  }

  // Check if this is an identity substitution (e.g., ListNode<T> inside class ListNode<T>).
  // In this case, we can return the original class to avoid issues with incomplete fields
  // during class declaration processing, and to avoid infinite recursion for self-referential types.
  if (
    genericClass.typeParameters &&
    typeArguments.length === genericClass.typeParameters.length &&
    typeArguments.every(
      (arg, i) =>
        arg.kind === TypeKind.TypeParameter &&
        (arg as TypeParameterType).name ===
          genericClass.typeParameters![i].name,
    )
  ) {
    // Identity substitution - return a copy with genericSource set to preserve identity
    return {
      ...genericClass,
      typeArguments,
      genericSource: genericClass,
    };
  }

  // Check interning cache - return cached instance if available
  // This ensures identical generic instantiations share the same object
  const cached = ctx.getInternedClass(genericClass, typeArguments);
  if (cached) {
    return cached;
  }

  const typeMap = new Map<string, Type>();
  genericClass.typeParameters!.forEach((param, index) => {
    typeMap.set(param.name, typeArguments[index]);
  });

  const substitute = (type: Type) => substituteType(type, typeMap, ctx);

  const newFields = new Map<string, Type>();
  for (const [name, type] of genericClass.fields) {
    newFields.set(name, substitute(type));
  }

  const newMethods = new Map<string, FunctionType>();
  for (const [name, fn] of genericClass.methods) {
    newMethods.set(name, substituteFunctionType(fn, typeMap, ctx));
  }

  const newImplements = genericClass.implements.map(
    (impl) => substituteType(impl, typeMap, ctx) as InterfaceType,
  );

  // Substitute superType so that Derived<i32> extends Base<i32>, not Base<T>
  const newSuperType = genericClass.superType
    ? (substitute(genericClass.superType) as ClassType)
    : undefined;

  const newClass: ClassType = {
    ...genericClass,
    typeArguments,
    fields: newFields,
    methods: newMethods,
    implements: newImplements,
    constructorType: genericClass.constructorType
      ? substituteFunctionType(genericClass.constructorType, typeMap, ctx)
      : undefined,
    onType: genericClass.onType ? substitute(genericClass.onType) : undefined,
    superType: newSuperType,
    genericSource: genericClass,
  };

  // Store in interning cache before validation to handle recursive types
  ctx.internClass(genericClass, typeArguments, newClass);

  for (const type of newFields.values()) validateType(type, ctx);
  for (const method of newMethods.values()) {
    for (const p of method.parameters) validateType(p, ctx);
    validateType(method.returnType, ctx);
  }
  if (newClass.constructorType) {
    for (const p of newClass.constructorType.parameters) validateType(p, ctx);
  }

  return newClass;
}

export function instantiateGenericInterface(
  genericInterface: InterfaceType,
  typeArguments: Type[],
  ctx: CheckerContext,
): InterfaceType {
  // Validate type argument constraints
  if (genericInterface.typeParameters) {
    validateTypeArgumentConstraints(
      ctx,
      genericInterface.typeParameters,
      typeArguments,
    );
  }

  // Check interning cache - return cached instance if available
  const cached = ctx.getInternedInterface(genericInterface, typeArguments);
  if (cached) {
    return cached;
  }

  const typeMap = new Map<string, Type>();
  genericInterface.typeParameters!.forEach((param, index) => {
    typeMap.set(param.name, typeArguments[index]);
  });

  const substitute = (type: Type) => substituteType(type, typeMap, ctx);

  const newFields = new Map<string, Type>();
  for (const [name, type] of genericInterface.fields) {
    newFields.set(name, substitute(type));
  }

  const newMethods = new Map<string, FunctionType>();
  for (const [name, fn] of genericInterface.methods) {
    newMethods.set(name, substituteFunctionType(fn, typeMap, ctx));
  }

  const newExtends = genericInterface.extends
    ? genericInterface.extends.map(
        (ext) => substituteType(ext, typeMap, ctx) as InterfaceType,
      )
    : undefined;

  const newInterface: InterfaceType = {
    ...genericInterface,
    typeArguments,
    fields: newFields,
    methods: newMethods,
    extends: newExtends,
    genericSource: genericInterface,
  };

  // Store in interning cache before validation to handle recursive types
  ctx.internInterface(genericInterface, typeArguments, newInterface);

  for (const type of newFields.values()) validateType(type, ctx);
  for (const method of newMethods.values()) {
    for (const p of method.parameters) validateType(p, ctx);
    validateType(method.returnType, ctx);
  }

  return newInterface;
}

export function instantiateGenericMixin(
  genericMixin: MixinType,
  typeArguments: Type[],
  ctx: CheckerContext,
): MixinType {
  // Validate type argument constraints
  if (genericMixin.typeParameters) {
    validateTypeArgumentConstraints(
      ctx,
      genericMixin.typeParameters,
      typeArguments,
    );
  }

  // Check interning cache - return cached instance if available
  const cached = ctx.getInternedMixin(genericMixin, typeArguments);
  if (cached) {
    return cached;
  }

  const typeMap = new Map<string, Type>();
  genericMixin.typeParameters!.forEach((param, index) => {
    typeMap.set(param.name, typeArguments[index]);
  });

  const substitute = (type: Type) => substituteType(type, typeMap, ctx);

  const newFields = new Map<string, Type>();
  for (const [name, type] of genericMixin.fields) {
    newFields.set(name, substitute(type));
  }

  const newMethods = new Map<string, FunctionType>();
  for (const [name, fn] of genericMixin.methods) {
    newMethods.set(name, substituteFunctionType(fn, typeMap, ctx));
  }

  const newOnType = genericMixin.onType
    ? (substitute(genericMixin.onType) as ClassType)
    : undefined;

  const newMixin: MixinType = {
    ...genericMixin,
    typeArguments,
    fields: newFields,
    methods: newMethods,
    onType: newOnType,
    genericSource: genericMixin,
  };

  // Store in interning cache before validation to handle recursive types
  ctx.internMixin(genericMixin, typeArguments, newMixin);

  for (const type of newFields.values()) validateType(type, ctx);
  for (const method of newMethods.values()) {
    for (const p of method.parameters) validateType(p, ctx);
    validateType(method.returnType, ctx);
  }

  return newMixin;
}

export function instantiateGenericFunction(
  genericFunc: FunctionType,
  typeArguments: Type[],
  ctx: CheckerContext,
): FunctionType {
  // Check for cached interned version first
  const cached = ctx.getInternedFunction(genericFunc, typeArguments);
  if (cached) return cached;

  // Validate type argument constraints
  if (genericFunc.typeParameters) {
    validateTypeArgumentConstraints(
      ctx,
      genericFunc.typeParameters,
      typeArguments,
    );
  }

  const typeMap = new Map<string, Type>();
  genericFunc.typeParameters!.forEach((param, index) => {
    typeMap.set(param.name, typeArguments[index]);
  });

  const substitute = (type: Type) => substituteType(type, typeMap, ctx);

  const newFunc: FunctionType = {
    ...genericFunc,
    typeParameters: undefined,
    typeArguments, // Store the concrete type arguments
    genericSource: genericFunc, // Link back to the template
    parameters: genericFunc.parameters.map(substitute),
    returnType: substitute(genericFunc.returnType),
  };

  newFunc.parameters.forEach((p) => validateType(p, ctx));
  validateType(newFunc.returnType, ctx);

  // Intern the result for identity-based lookup
  ctx.internFunction(genericFunc, typeArguments, newFunc);

  return newFunc;
}

/**
 * Gets the canonical (original) type for a potentially instantiated generic.
 * For non-generic types, returns the type itself.
 * For generic instantiations, follows the genericSource chain to the root.
 */
export function getCanonicalType(type: ClassType): ClassType {
  let current = type;
  while (current.genericSource) {
    current = current.genericSource;
  }
  return current;
}

/**
 * Compares two ClassTypes for identity equality.
 * For generic instantiations, compares canonical sources and type arguments.
 * This avoids relying on mutable name strings.
 */
export function classTypesEqual(a: ClassType, b: ClassType): boolean {
  // Fast path: same object
  if (a === b) return true;

  // Get canonical types (follow genericSource chain)
  const canonA = getCanonicalType(a);
  const canonB = getCanonicalType(b);

  // Check if canonical types match (by identity or by name as fallback)
  // Name fallback is needed when types are recreated during bundled re-checking
  if (canonA !== canonB && canonA.name !== canonB.name) return false;

  // Same base type - now compare type arguments
  const argsA = a.typeArguments;
  const argsB = b.typeArguments;

  // Both non-generic (or same generic with no instantiation)
  if (!argsA && !argsB) return true;

  // One has args, one doesn't
  if (!argsA || !argsB) return false;

  // Different number of args
  if (argsA.length !== argsB.length) return false;

  // Compare each type argument recursively
  for (let i = 0; i < argsA.length; i++) {
    if (!typesEqual(argsA[i], argsB[i])) return false;
  }

  return true;
}

/**
 * Compares two Types for structural equality.
 * Used for comparing type arguments in generic instantiations.
 */
export function typesEqual(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case TypeKind.Class:
      return classTypesEqual(a as ClassType, b as ClassType);
    case TypeKind.Interface: {
      const ia = a as InterfaceType;
      const ib = b as InterfaceType;
      // Get canonical types (follow genericSource chain)
      let canonA: InterfaceType = ia;
      while (canonA.genericSource) canonA = canonA.genericSource;
      let canonB: InterfaceType = ib;
      while (canonB.genericSource) canonB = canonB.genericSource;

      // Check if canonical types match (by identity or by name as fallback)
      if (canonA !== canonB && canonA.name !== canonB.name) return false;

      // Same base type - compare type arguments
      if (!ia.typeArguments && !ib.typeArguments) return true;
      if (!ia.typeArguments || !ib.typeArguments) return false;
      if (ia.typeArguments.length !== ib.typeArguments.length) return false;
      return ia.typeArguments.every((arg, i) =>
        typesEqual(arg, ib.typeArguments![i]),
      );
    }
    case TypeKind.Array: {
      const aa = a as ArrayType;
      const ab = b as ArrayType;
      return typesEqual(aa.elementType, ab.elementType);
    }
    case TypeKind.Number:
      return (a as NumberType).name === (b as NumberType).name;
    case TypeKind.Literal:
      return (a as LiteralType).value === (b as LiteralType).value;
    case TypeKind.TypeParameter:
      return (a as TypeParameterType).name === (b as TypeParameterType).name;
    case TypeKind.Function: {
      const fa = a as FunctionType;
      const fb = b as FunctionType;
      if (fa.parameters.length !== fb.parameters.length) return false;
      if (!typesEqual(fa.returnType, fb.returnType)) return false;
      return fa.parameters.every((p, i) => typesEqual(p, fb.parameters[i]));
    }
    case TypeKind.Record: {
      const ra = a as RecordType;
      const rb = b as RecordType;
      if (ra.properties.size !== rb.properties.size) return false;
      for (const [key, typeA] of ra.properties) {
        const typeB = rb.properties.get(key);
        if (!typeB || !typesEqual(typeA, typeB)) return false;
      }
      return true;
    }
    case TypeKind.Tuple: {
      const ta = a as TupleType;
      const tb = b as TupleType;
      if (ta.elementTypes.length !== tb.elementTypes.length) return false;
      return ta.elementTypes.every((t, i) => typesEqual(t, tb.elementTypes[i]));
    }
    // Simple types that are singletons or compared by kind
    case TypeKind.Boolean:
    case TypeKind.Void:
    case TypeKind.Null:
    case TypeKind.Never:
    case TypeKind.Any:
    case TypeKind.AnyRef:
    case TypeKind.Unknown:
    case TypeKind.ByteArray:
    case TypeKind.This:
      return true;
    default:
      // Fall back to string comparison for unhandled cases
      return typeToString(a) === typeToString(b);
  }
}

export function typeToString(type: Type): string {
  switch (type.kind) {
    case TypeKind.Never:
      return TypeNames.Never;
    case TypeKind.Number:
      return (type as NumberType).name;
    case TypeKind.Boolean:
      return TypeNames.Boolean;
    case TypeKind.ByteArray:
      return TypeKind.ByteArray;
    case TypeKind.Void:
      return TypeNames.Void;
    case TypeKind.Null:
      return TypeNames.Null;
    case TypeKind.Any:
      return TypeNames.Any;
    case TypeKind.Literal: {
      const lit = type as LiteralType;
      if (typeof lit.value === 'string') {
        return `'${lit.value}'`;
      }
      return String(lit.value);
    }
    case TypeKind.Union:
      return (type as UnionType).types.map((t) => typeToString(t)).join(' | ');
    case TypeKind.TypeParameter:
      return (type as TypeParameterType).name;
    case TypeKind.TypeAlias: {
      const alias = type as TypeAliasType;
      // If it's a distinct alias, we print its name.
      // If it's a generic instance, we might want to print arguments, but we don't store them on the instance currently.
      // For now just print the name.
      return alias.name;
    }
    case TypeKind.Function: {
      const fn = type as FunctionType;
      const params = fn.parameters.map((p) => typeToString(p)).join(', ');
      return `(${params}) => ${typeToString(fn.returnType)}`;
    }
    case TypeKind.Class: {
      const ct = type as ClassType;
      if (ct.typeArguments && ct.typeArguments.length > 0) {
        return `${ct.name}<${ct.typeArguments.map((t) => typeToString(t)).join(', ')}>`;
      }
      return ct.name;
    }
    case TypeKind.Interface: {
      const it = type as InterfaceType;
      if (it.typeArguments && it.typeArguments.length > 0) {
        return `${it.name}<${it.typeArguments.map((t) => typeToString(t)).join(', ')}>`;
      }
      return it.name;
    }
    case TypeKind.Mixin: {
      const mt = type as MixinType;
      if (mt.typeArguments && mt.typeArguments.length > 0) {
        return `${mt.name}<${mt.typeArguments.map((t) => typeToString(t)).join(', ')}>`;
      }
      return mt.name;
    }
    case TypeKind.Array:
      return `array<${typeToString((type as ArrayType).elementType)}>`;
    case TypeKind.Record: {
      const rt = type as RecordType;
      const props = Array.from(rt.properties.entries())
        .map(([k, v]) => `${k}: ${typeToString(v)}`)
        .join(', ');
      return `{ ${props} }`;
    }
    case TypeKind.Tuple: {
      const tt = type as TupleType;
      const elems = tt.elementTypes.map((t) => typeToString(t)).join(', ');
      return `[${elems}]`;
    }
    case TypeKind.This:
      return 'this';
    default:
      return type.kind;
  }
}

export function isAssignableTo(
  ctx: CheckerContext,
  source: Type,
  target: Type,
): boolean {
  if (source === target) return true;
  if (source.kind === TypeKind.Never) return true;
  if (source.kind === TypeKind.Unknown || target.kind === TypeKind.Unknown) {
    return true;
  }

  if (target.kind === TypeKind.Any) return true;
  if (source.kind === TypeKind.Any) return false;

  // Literal type assignability
  if (source.kind === TypeKind.Literal && target.kind === TypeKind.Literal) {
    const srcLit = source as LiteralType;
    const tgtLit = target as LiteralType;
    return srcLit.value === tgtLit.value;
  }

  // Literal types are assignable to their base types
  if (source.kind === TypeKind.Literal) {
    const lit = source as LiteralType;
    if (typeof lit.value === 'string') {
      // String literals are assignable to string type
      const stringType = ctx.resolveType(Types.String.name);
      if (stringType && target === stringType) return true;
      if (
        target.kind === TypeKind.Class &&
        (target as ClassType).name === Types.String.name
      )
        return true;

      // console.log(`[DEBUG] isAssignableTo string literal. Target: ${typeToString(target)} (${target.kind}). StringType: ${stringType ? typeToString(stringType) : 'undefined'}`);
    } else if (typeof lit.value === 'number') {
      // Number literals are assignable to i32 (default for integer literals)
      // TODO: Support more flexible literal-to-numeric-type assignment based on value range
      if (target.kind === TypeKind.Number) {
        return (target as NumberType).name === Types.I32.name;
      }
    } else if (typeof lit.value === 'boolean') {
      // Boolean literals are assignable to boolean type
      if (target.kind === TypeKind.Boolean) return true;
    }
  }

  if (target.kind === TypeKind.AnyRef) {
    switch (source.kind) {
      case TypeKind.Class:
      case TypeKind.Interface:
      case TypeKind.Array:
      case TypeKind.Record:
      case TypeKind.Tuple:
      case TypeKind.Function:
      case TypeKind.Null:
      case TypeKind.ByteArray:
      case TypeKind.AnyRef:
        return true;
      case TypeKind.TypeAlias:
        return isAssignableTo(ctx, (source as TypeAliasType).target, target);
      default:
        return false;
    }
  }

  // Handle Distinct Types
  if (
    source.kind === TypeKind.TypeAlias &&
    (source as TypeAliasType).isDistinct
  ) {
    // Distinct types are only assignable to themselves (handled by source === target check above)
    // or if target is a union containing this type.
    // They are NOT assignable to their underlying type.
    if (target.kind === TypeKind.Union) {
      return (target as UnionType).types.some((t) =>
        isAssignableTo(ctx, source, t),
      );
    }
    // Check if target is the same distinct type (by name/identity)
    if (
      target.kind === TypeKind.TypeAlias &&
      (target as TypeAliasType).isDistinct
    ) {
      // For generic instances, we might have different objects but same "type".
      // Since we don't store type args on the instance yet, we rely on structural equality of the target?
      // Or just name?
      // If we have `type ID<T> = distinct T`, then `ID<i32>` and `ID<f32>` are different.
      // Our current implementation of `resolveTypeAnnotation` creates a new object for each instantiation.
      // So `source === target` might fail.
      // We need to check if they are instantiations of the same alias with compatible targets.
      const srcAlias = source as TypeAliasType;
      const tgtAlias = target as TypeAliasType;
      return (
        srcAlias.name === tgtAlias.name &&
        isAssignableTo(ctx, srcAlias.target, tgtAlias.target)
      );
    }
    return false;
  }

  if (
    target.kind === TypeKind.TypeAlias &&
    (target as TypeAliasType).isDistinct
  ) {
    // Nothing is assignable to a distinct type except itself (handled above).
    return false;
  }

  // Handle non-distinct Type Aliases (transparent)
  if (
    source.kind === TypeKind.TypeAlias &&
    !(source as TypeAliasType).isDistinct
  ) {
    return isAssignableTo(ctx, (source as TypeAliasType).target, target);
  }

  if (
    target.kind === TypeKind.TypeAlias &&
    !(target as TypeAliasType).isDistinct
  ) {
    return isAssignableTo(ctx, source, (target as TypeAliasType).target);
  }

  if (source.kind === TypeKind.Union) {
    return (source as UnionType).types.every((t) =>
      isAssignableTo(ctx, t, target),
    );
  }

  if (target.kind === TypeKind.Union) {
    return (target as UnionType).types.some((t) =>
      isAssignableTo(ctx, source, t),
    );
  }

  if (source.kind === TypeKind.Null) {
    switch (target.kind) {
      case TypeKind.Class:
      case TypeKind.Interface:
      case TypeKind.Array:
      case TypeKind.Record:
      case TypeKind.Tuple:
      case TypeKind.Function:
      case TypeKind.Null:
        return true;
      case TypeKind.TypeAlias:
        return isAssignableTo(ctx, source, (target as TypeAliasType).target);
      default:
        return false;
    }
  }

  if (source.kind === TypeKind.Class && target.kind === TypeKind.Class) {
    const sourceClass = source as ClassType;
    const targetClass = target as ClassType;

    let current: ClassType | undefined = sourceClass;
    while (current) {
      // Check if the classes match using identity-based comparison
      if (classTypesEqual(current, targetClass)) return true;

      current = current.superType;
    }
    return false;
  }

  if (source.kind === TypeKind.Class && target.kind === TypeKind.Interface) {
    let current: ClassType | undefined = source as ClassType;
    while (current) {
      let implementsList = current.implements;

      // If implements is empty but we have genericSource, try to re-instantiate implements
      if (
        implementsList.length === 0 &&
        current.genericSource &&
        current.genericSource.implements.length > 0 &&
        current.typeArguments
      ) {
        const typeMap = new Map<string, Type>();
        current.genericSource.typeParameters!.forEach((param, index) => {
          typeMap.set(param.name, current!.typeArguments![index]);
        });
        implementsList = current.genericSource.implements.map(
          (impl) => substituteType(impl, typeMap, ctx) as InterfaceType,
        );
      }

      if (implementsList.some((impl) => isAssignableTo(ctx, impl, target))) {
        return true;
      }
      current = current.superType;
    }
    return false;
  }

  if (
    source.kind === TypeKind.Interface &&
    target.kind === TypeKind.Interface
  ) {
    // Use typesEqual for identity-based comparison (handles type arguments)
    if (typesEqual(source, target)) return true;
    const srcInterface = source as InterfaceType;
    if (srcInterface.extends) {
      return srcInterface.extends.some((ext) =>
        isAssignableTo(ctx, ext, target),
      );
    }
    return false;
  }

  if (source.kind === TypeKind.Record && target.kind === TypeKind.Record) {
    const sourceRecord = source as RecordType;
    const targetRecord = target as RecordType;
    // Width subtyping: source must have all properties of target
    for (const [key, targetType] of targetRecord.properties) {
      const sourceType = sourceRecord.properties.get(key);
      if (!sourceType) return false;
      if (!isAssignableTo(ctx, sourceType, targetType)) return false;
    }
    return true;
  }

  if (source.kind === TypeKind.Tuple && target.kind === TypeKind.Tuple) {
    const sourceTuple = source as TupleType;
    const targetTuple = target as TupleType;
    if (sourceTuple.elementTypes.length !== targetTuple.elementTypes.length) {
      return false;
    }
    for (let i = 0; i < sourceTuple.elementTypes.length; i++) {
      if (
        !isAssignableTo(
          ctx,
          sourceTuple.elementTypes[i],
          targetTuple.elementTypes[i],
        )
      ) {
        return false;
      }
    }
    return true;
  }

  if (source.kind === TypeKind.Class && target.kind === TypeKind.Record) {
    const targetRecord = target as RecordType;
    // Check if class has all properties of record
    for (const [key, targetType] of targetRecord.properties) {
      let current: ClassType | undefined = source as ClassType;
      let found = false;
      while (current) {
        if (current.fields.has(key)) {
          const fieldType = current.fields.get(key)!;
          if (isAssignableTo(ctx, fieldType, targetType)) {
            found = true;
            break;
          }
        }
        // TODO: Check accessors/methods if records can match them (Records are data, so maybe only getters?)
        current = current.superType;
      }
      if (!found) return false;
    }
    return true;
  }

  // Extension Types: Extension is assignable to its underlying type
  if (source.kind === TypeKind.Class && (source as ClassType).isExtension) {
    const ext = source as ClassType;
    if (ext.onType && isAssignableTo(ctx, ext.onType, target)) {
      return true;
    }
  }

  // Allow assigning primitive FixedArray to Extension Class wrapping it
  if (source.kind === TypeKind.Array && target.kind === TypeKind.Class) {
    const targetClass = target as ClassType;
    if (targetClass.isExtension && targetClass.onType) {
      return isAssignableTo(ctx, source, targetClass.onType);
    }
  }

  // Check if source type has an extension that implements the target interface
  if (target.kind === TypeKind.Interface) {
    // Iterate all classes to find extensions
    // Classes are in the global scope (index 0)
    if (ctx.scopes.length > 0) {
      const globalScope = ctx.scopes[0];
      for (const info of globalScope.values()) {
        if (info.type.kind === TypeKind.Class) {
          const classType = info.type as ClassType;
          if (classType.isExtension && classType.onType) {
            let appliedClass = classType;

            // Handle generic extension inference for FixedArray
            if (
              classType.typeParameters &&
              classType.typeParameters.length > 0 &&
              source.kind === TypeKind.Array &&
              classType.onType.kind === TypeKind.Array
            ) {
              const sourceElem = (source as ArrayType).elementType;
              const onTypeElem = (classType.onType as ArrayType).elementType;

              if (onTypeElem.kind === TypeKind.TypeParameter) {
                const paramIndex = classType.typeParameters.findIndex(
                  (p) => p.name === (onTypeElem as TypeParameterType).name,
                );
                if (paramIndex !== -1) {
                  const typeArgs = new Array(
                    classType.typeParameters.length,
                  ).fill(Types.Unknown);
                  typeArgs[paramIndex] = sourceElem;
                  appliedClass = instantiateGenericClass(
                    classType,
                    typeArgs,
                    ctx,
                  );
                }
              }
            }

            // Check if extension applies to source
            if (isAssignableTo(ctx, source, appliedClass.onType!)) {
              // Check if extension implements target interface
              if (
                appliedClass.implements.some((impl) =>
                  isAssignableTo(ctx, impl, target),
                )
              ) {
                return true;
              }
            }
          }
        }
      }
    }
  }

  if (source.kind === TypeKind.Function && target.kind === TypeKind.Function) {
    return isAdaptable(ctx, source, target);
  }

  return typeToString(source) === typeToString(target);
}

export function isAdaptable(
  ctx: CheckerContext,
  source: Type,
  target: Type,
): boolean {
  if (source.kind === TypeKind.Function && target.kind === TypeKind.Function) {
    const sourceFunc = source as FunctionType;
    const targetFunc = target as FunctionType;

    // 1. Return type must be assignable (Covariant)
    if (!isAssignableTo(ctx, sourceFunc.returnType, targetFunc.returnType)) {
      return false;
    }

    // 2. Parameter count: Source must have <= Target parameters
    if (sourceFunc.parameters.length > targetFunc.parameters.length) {
      return false;
    }

    // 3. Parameter types: Source params must be assignable FROM Target params (Contravariant)
    for (let i = 0; i < sourceFunc.parameters.length; i++) {
      if (
        !isAssignableTo(ctx, targetFunc.parameters[i], sourceFunc.parameters[i])
      ) {
        return false;
      }
    }

    return true;
  }
  return false;
}
