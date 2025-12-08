import {NodeType, type TypeAnnotation} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  TypeKind,
  Types,
  type FixedArrayType,
  type ClassType,
  type FunctionType,
  type InterfaceType,
  type LiteralType,
  type NumberType,
  type RecordType,
  type TupleType,
  type Type,
  type TypeAliasType,
  type TypeParameterType,
  type UnionType,
} from '../types.js';
import type {CheckerContext} from './context.js';

function isPrimitive(type: Type): boolean {
  // Literal types are NOT considered primitives for union validation
  // because they are singleton types that can be discriminated at runtime
  if (type.kind === TypeKind.Number || type.kind === TypeKind.Boolean) {
    return true;
  }
  if (type.kind === TypeKind.TypeAlias) {
    return isPrimitive((type as TypeAliasType).target);
  }
  if (type.kind === TypeKind.Class && (type as ClassType).isExtension) {
    return isPrimitive((type as ClassType).onType!);
  }
  return false;
}

export function substituteType(type: Type, typeMap: Map<string, Type>): Type {
  if (type.kind === TypeKind.TypeParameter) {
    return typeMap.get((type as TypeParameterType).name) || type;
  }
  if (type.kind === TypeKind.FixedArray) {
    return {
      ...type,
      elementType: substituteType(
        (type as FixedArrayType).elementType,
        typeMap,
      ),
    } as FixedArrayType;
  }
  if (type.kind === TypeKind.Class) {
    const ct = type as ClassType;
    if (ct.typeArguments) {
      const newTypeArguments = ct.typeArguments.map((t) =>
        substituteType(t, typeMap),
      );

      const newFields = new Map<string, Type>();
      for (const [name, type] of ct.fields) {
        newFields.set(name, substituteType(type, typeMap));
      }

      const newMethods = new Map<string, FunctionType>();
      for (const [name, fn] of ct.methods) {
        newMethods.set(name, substituteType(fn, typeMap) as FunctionType);
      }

      const newConstructor = ct.constructorType
        ? (substituteType(ct.constructorType, typeMap) as FunctionType)
        : undefined;
      const newOnType = ct.onType
        ? substituteType(ct.onType, typeMap)
        : undefined;
      const newSuperType = ct.superType
        ? (substituteType(ct.superType, typeMap) as ClassType)
        : undefined;

      return {
        ...ct,
        typeArguments: newTypeArguments,
        fields: newFields,
        methods: newMethods,
        constructorType: newConstructor,
        onType: newOnType,
        superType: newSuperType,
      } as ClassType;
    }
  }
  if (type.kind === TypeKind.Interface) {
    const it = type as InterfaceType;
    if (it.typeArguments) {
      const newTypeArguments = it.typeArguments.map((t) =>
        substituteType(t, typeMap),
      );

      const newFields = new Map<string, Type>();
      for (const [name, type] of it.fields) {
        newFields.set(name, substituteType(type, typeMap));
      }

      const newMethods = new Map<string, FunctionType>();
      for (const [name, fn] of it.methods) {
        newMethods.set(name, substituteType(fn, typeMap) as FunctionType);
      }

      const newExtends = it.extends
        ? it.extends.map((ext) => substituteType(ext, typeMap) as InterfaceType)
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
  if (type.kind === TypeKind.Function) {
    const ft = type as FunctionType;
    return {
      ...ft,
      parameters: ft.parameters.map((t) => substituteType(t, typeMap)),
      returnType: substituteType(ft.returnType, typeMap),
    } as FunctionType;
  }
  if (type.kind === TypeKind.Union) {
    const ut = type as UnionType;
    return {
      ...ut,
      types: ut.types.map((t) => substituteType(t, typeMap)),
    } as UnionType;
  }
  if (type.kind === TypeKind.Record) {
    const rt = type as RecordType;
    const newProperties = new Map<string, Type>();
    for (const [key, value] of rt.properties) {
      newProperties.set(key, substituteType(value, typeMap));
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
      elementTypes: tt.elementTypes.map((t) => substituteType(t, typeMap)),
    } as TupleType;
  }
  return type;
}

export function resolveTypeAnnotation(
  ctx: CheckerContext,
  annotation: TypeAnnotation,
): Type {
  if (annotation.type === NodeType.LiteralTypeAnnotation) {
    return {
      kind: TypeKind.Literal,
      value: annotation.value,
    } as LiteralType;
  }

  if (annotation.type === NodeType.UnionTypeAnnotation) {
    const types = annotation.types.map((t) => resolveTypeAnnotation(ctx, t));
    for (const t of types) {
      if (isPrimitive(t)) {
        ctx.diagnostics.reportError(
          `Union types cannot contain primitive types like '${typeToString(t)}'. Use 'Box<T>' or a reference type.`,
          DiagnosticCode.TypeMismatch,
        );
      }
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
  switch (name) {
    case 'i32':
      return Types.I32;
    case 'u32':
      return Types.U32;
    case 'f32':
      return Types.F32;
    case 'boolean':
      return Types.Boolean;
    case 'anyref':
      return Types.AnyRef;
    case 'any':
      return Types.Any;
    case 'string': {
      const stringType = ctx.resolve('String');
      if (stringType) return stringType;

      const wellKnown = ctx.getWellKnownType('String');
      return wellKnown || Types.String;
    }
    case 'ByteArray':
      return Types.ByteArray;
    case 'array':
    case 'FixedArray': {
      if (annotation.typeArguments && annotation.typeArguments.length === 1) {
        const elementType = resolveTypeAnnotation(
          ctx,
          annotation.typeArguments[0],
        );
        return {
          kind: TypeKind.FixedArray,
          elementType,
        } as FixedArrayType;
      }
      // If used without type arguments, it might be a raw Array or we should error.
      // For now let's fall through to resolve it as a class (which we will skip in codegen)
      // or maybe we should error if generic arguments are missing.
      break;
    }
    case 'void':
      return Types.Void;
    case 'never':
      return Types.Never;
    case 'null':
      return Types.Null;
  }

  const type = ctx.resolve(name);
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
      const substituted = substituteType(alias.target, typeMap);
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

  if (annotation.typeArguments && annotation.typeArguments.length > 0) {
    if (type.kind === TypeKind.Class) {
      const classType = type as ClassType;
      if (!classType.typeParameters || classType.typeParameters.length === 0) {
        ctx.diagnostics.reportError(
          `Type '${name}' is not generic.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }
      if (classType.typeParameters.length !== annotation.typeArguments.length) {
        ctx.diagnostics.reportError(
          `Expected ${classType.typeParameters.length} type arguments, got ${annotation.typeArguments.length}.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }

      const typeArguments = annotation.typeArguments.map((arg) =>
        resolveTypeAnnotation(ctx, arg),
      );
      return instantiateGenericClass(classType, typeArguments, ctx);
    } else if (type.kind === TypeKind.Interface) {
      const interfaceType = type as InterfaceType;
      if (
        !interfaceType.typeParameters ||
        interfaceType.typeParameters.length === 0
      ) {
        ctx.diagnostics.reportError(
          `Type '${name}' is not generic.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }
      if (
        interfaceType.typeParameters.length !== annotation.typeArguments.length
      ) {
        ctx.diagnostics.reportError(
          `Expected ${interfaceType.typeParameters.length} type arguments, got ${annotation.typeArguments.length}.`,
          DiagnosticCode.GenericTypeArgumentMismatch,
        );
        return type;
      }

      const typeArguments = annotation.typeArguments.map((arg) =>
        resolveTypeAnnotation(ctx, arg),
      );
      return instantiateGenericInterface(interfaceType, typeArguments, ctx);
    } else {
      ctx.diagnostics.reportError(
        `Type '${name}' is not generic.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
      );
      return type;
    }
  }

  return type;
}

export function validateType(type: Type, ctx: CheckerContext) {
  if (type.kind === TypeKind.Union) {
    const ut = type as UnionType;
    for (const t of ut.types) {
      if (isPrimitive(t)) {
        ctx.diagnostics.reportError(
          `Union types cannot contain primitive types like '${typeToString(t)}'. Use 'Box<T>' or a reference type.`,
          DiagnosticCode.TypeMismatch,
        );
      }
      validateType(t, ctx);
    }
  } else if (type.kind === TypeKind.FixedArray) {
    validateType((type as FixedArrayType).elementType, ctx);
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

export function instantiateGenericClass(
  genericClass: ClassType,
  typeArguments: Type[],
  ctx?: CheckerContext,
): ClassType {
  const typeMap = new Map<string, Type>();
  genericClass.typeParameters!.forEach((param, index) => {
    typeMap.set(param.name, typeArguments[index]);
  });

  const substitute = (type: Type) => substituteType(type, typeMap);

  const substituteFunction = (fn: FunctionType): FunctionType => {
    return {
      ...fn,
      parameters: fn.parameters.map(substitute),
      returnType: substitute(fn.returnType),
    };
  };

  const newFields = new Map<string, Type>();
  for (const [name, type] of genericClass.fields) {
    newFields.set(name, substitute(type));
  }

  const newMethods = new Map<string, FunctionType>();
  for (const [name, fn] of genericClass.methods) {
    newMethods.set(name, substituteFunction(fn));
  }

  const newImplements = genericClass.implements.map(
    (impl) => substituteType(impl, typeMap) as InterfaceType,
  );

  const newClass = {
    ...genericClass,
    typeArguments,
    fields: newFields,
    methods: newMethods,
    implements: newImplements,
    constructorType: genericClass.constructorType
      ? substituteFunction(genericClass.constructorType)
      : undefined,
    onType: genericClass.onType ? substitute(genericClass.onType) : undefined,
  };

  if (ctx) {
    for (const type of newFields.values()) validateType(type, ctx);
    for (const method of newMethods.values()) {
      for (const p of method.parameters) validateType(p, ctx);
      validateType(method.returnType, ctx);
    }
    if (newClass.constructorType) {
      for (const p of newClass.constructorType.parameters) validateType(p, ctx);
    }
  }

  return newClass;
}

export function instantiateGenericInterface(
  genericInterface: InterfaceType,
  typeArguments: Type[],
  ctx?: CheckerContext,
): InterfaceType {
  const typeMap = new Map<string, Type>();
  genericInterface.typeParameters!.forEach((param, index) => {
    typeMap.set(param.name, typeArguments[index]);
  });

  const substitute = (type: Type) => substituteType(type, typeMap);

  const substituteFunction = (fn: FunctionType): FunctionType => {
    return {
      ...fn,
      parameters: fn.parameters.map(substitute),
      returnType: substitute(fn.returnType),
    };
  };

  const newFields = new Map<string, Type>();
  for (const [name, type] of genericInterface.fields) {
    newFields.set(name, substitute(type));
  }

  const newMethods = new Map<string, FunctionType>();
  for (const [name, fn] of genericInterface.methods) {
    newMethods.set(name, substituteFunction(fn));
  }

  const newExtends = genericInterface.extends
    ? genericInterface.extends.map(
        (ext) => substituteType(ext, typeMap) as InterfaceType,
      )
    : undefined;

  const newInterface = {
    ...genericInterface,
    typeArguments,
    fields: newFields,
    methods: newMethods,
    extends: newExtends,
  };

  if (ctx) {
    for (const type of newFields.values()) validateType(type, ctx);
    for (const method of newMethods.values()) {
      for (const p of method.parameters) validateType(p, ctx);
      validateType(method.returnType, ctx);
    }
  }

  return newInterface;
}

export function instantiateGenericFunction(
  genericFunc: FunctionType,
  typeArguments: Type[],
  ctx?: CheckerContext,
): FunctionType {
  const typeMap = new Map<string, Type>();
  genericFunc.typeParameters!.forEach((param, index) => {
    typeMap.set(param.name, typeArguments[index]);
  });

  const substitute = (type: Type) => substituteType(type, typeMap);

  const newFunc = {
    ...genericFunc,
    typeParameters: undefined,
    parameters: genericFunc.parameters.map(substitute),
    returnType: substitute(genericFunc.returnType),
  };

  if (ctx) {
    newFunc.parameters.forEach((p) => validateType(p, ctx));
    validateType(newFunc.returnType, ctx);
  }

  return newFunc;
}

export function typeToString(type: Type): string {
  switch (type.kind) {
    case TypeKind.Never:
      return 'never';
    case TypeKind.Number:
      return (type as NumberType).name;
    case TypeKind.Boolean:
      return 'boolean';
    case TypeKind.ByteArray:
      return 'ByteArray';
    case TypeKind.Void:
      return 'void';
    case TypeKind.Null:
      return 'null';
    case TypeKind.Any:
      return 'any';
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
    case TypeKind.FixedArray:
      return `FixedArray<${typeToString((type as FixedArrayType).elementType)}>`;
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
      const stringType = ctx.resolve('String');
      if (stringType && target === stringType) return true;
      if (target.kind === TypeKind.Class && (target as ClassType).name === 'String') return true;
    } else if (typeof lit.value === 'number') {
      // Number literals are assignable to i32 (default for integer literals)
      // TODO: Support more flexible literal-to-numeric-type assignment based on value range
      if (target.kind === TypeKind.Number) {
        return (target as NumberType).name === 'i32';
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
      case TypeKind.FixedArray:
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
      case TypeKind.FixedArray:
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
    let current: ClassType | undefined = source as ClassType;
    while (current) {
      if (typeToString(current) === typeToString(target)) return true;
      current = current.superType;
    }
    return false;
  }

  if (source.kind === TypeKind.Class && target.kind === TypeKind.Interface) {
    let current: ClassType | undefined = source as ClassType;
    while (current) {
      if (
        current.implements.some((impl) => isAssignableTo(ctx, impl, target))
      ) {
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
    if (typeToString(source) === typeToString(target)) return true;
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
  if (source.kind === TypeKind.FixedArray && target.kind === TypeKind.Class) {
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
            // Check if extension applies to source
            if (isAssignableTo(ctx, source, classType.onType)) {
              // Check if extension implements target interface
              if (
                classType.implements.some((impl) =>
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
