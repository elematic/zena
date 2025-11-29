import {NodeType, type TypeAnnotation} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  TypeKind,
  Types,
  type ArrayType,
  type ClassType,
  type FunctionType,
  type InterfaceType,
  type NumberType,
  type RecordType,
  type TupleType,
  type Type,
  type TypeAliasType,
  type TypeParameterType,
  type UnionType,
} from '../types.js';
import type {CheckerContext} from './context.js';

export function substituteType(type: Type, typeMap: Map<string, Type>): Type {
  if (type.kind === TypeKind.TypeParameter) {
    return typeMap.get((type as TypeParameterType).name) || type;
  }
  if (type.kind === TypeKind.Array) {
    return {
      ...type,
      elementType: substituteType((type as ArrayType).elementType, typeMap),
    } as ArrayType;
  }
  if (type.kind === TypeKind.Class) {
    const ct = type as ClassType;
    if (ct.typeArguments) {
      return {
        ...ct,
        typeArguments: ct.typeArguments.map((t) => substituteType(t, typeMap)),
      } as ClassType;
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
  if (annotation.type === NodeType.UnionTypeAnnotation) {
    const types = annotation.types.map((t) => resolveTypeAnnotation(ctx, t));
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
    case 'f32':
      return Types.F32;
    case 'boolean':
      return Types.Boolean;
    case 'anyref':
      return Types.AnyRef;
    case 'string': {
      const stringType = ctx.resolve('String');
      return stringType || Types.String;
    }
    case 'ByteArray':
      return Types.ByteArray;
    case 'Array': {
      if (annotation.typeArguments && annotation.typeArguments.length === 1) {
        const elementType = resolveTypeAnnotation(
          ctx,
          annotation.typeArguments[0],
        );
        return {
          kind: TypeKind.Array,
          elementType,
        } as ArrayType;
      }
      // If used without type arguments, it might be a raw Array or we should error.
      // For now let's fall through to resolve it as a class (which we will skip in codegen)
      // or maybe we should error if generic arguments are missing.
      break;
    }
    case 'void':
      return Types.Void;
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
    if (type.kind !== TypeKind.Class) {
      ctx.diagnostics.reportError(
        `Type '${name}' is not generic.`,
        DiagnosticCode.GenericTypeArgumentMismatch,
      );
      return type;
    }
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
    return instantiateGenericClass(classType, typeArguments);
  }

  return type;
}

export function instantiateGenericClass(
  genericClass: ClassType,
  typeArguments: Type[],
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

  return {
    ...genericClass,
    typeArguments,
    fields: newFields,
    methods: newMethods,
    constructorType: genericClass.constructorType
      ? substituteFunction(genericClass.constructorType)
      : undefined,
  };
}

export function instantiateGenericFunction(
  genericFunc: FunctionType,
  typeArguments: Type[],
): FunctionType {
  const typeMap = new Map<string, Type>();
  genericFunc.typeParameters!.forEach((param, index) => {
    typeMap.set(param.name, typeArguments[index]);
  });

  const substitute = (type: Type) => substituteType(type, typeMap);

  return {
    ...genericFunc,
    typeParameters: undefined,
    parameters: genericFunc.parameters.map(substitute),
    returnType: substitute(genericFunc.returnType),
  };
}

export function typeToString(type: Type): string {
  switch (type.kind) {
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
    case TypeKind.Array:
      return `Array<${typeToString((type as ArrayType).elementType)}>`;
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

export function isAssignableTo(source: Type, target: Type): boolean {
  if (source === target) return true;
  if (source.kind === TypeKind.Unknown || target.kind === TypeKind.Unknown) {
    return true;
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
        return isAssignableTo((source as TypeAliasType).target, target);
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
      return (target as UnionType).types.some((t) => isAssignableTo(source, t));
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
        isAssignableTo(srcAlias.target, tgtAlias.target)
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

  if (target.kind === TypeKind.Union) {
    return (target as UnionType).types.some((t) => isAssignableTo(source, t));
  }

  if (source.kind === TypeKind.Union) {
    return (source as UnionType).types.every((t) => isAssignableTo(t, target));
  }

  if (source.kind === TypeKind.Null) {
    return target.kind === TypeKind.Null;
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
      if (current.implements.some((impl) => isAssignableTo(impl, target))) {
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
      return srcInterface.extends.some((ext) => isAssignableTo(ext, target));
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
      if (!isAssignableTo(sourceType, targetType)) return false;
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
          if (isAssignableTo(fieldType, targetType)) {
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

  return typeToString(source) === typeToString(target);
}
