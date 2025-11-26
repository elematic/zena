import type {TypeAnnotation} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  TypeKind,
  Types,
  type ClassType,
  type Type,
  type TypeParameterType,
  type ArrayType,
  type FunctionType,
  type NumberType,
} from '../types.js';
import type {CheckerContext} from './context.js';

export function resolveTypeAnnotation(
  ctx: CheckerContext,
  annotation: TypeAnnotation,
): Type {
  const name = annotation.name;
  switch (name) {
    case 'i32':
      return Types.I32;
    case 'f32':
      return Types.F32;
    case 'boolean':
      return Types.Boolean;
    case 'string':
      return Types.String;
    case 'void':
      return Types.Void;
  }

  const type = ctx.resolve(name);
  if (!type) {
    ctx.diagnostics.reportError(
      `Unknown type '${name}'.`,
      DiagnosticCode.SymbolNotFound,
    );
    return Types.Unknown;
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

  const substitute = (type: Type): Type => {
    if (type.kind === TypeKind.TypeParameter) {
      return typeMap.get((type as TypeParameterType).name) || type;
    }
    if (type.kind === TypeKind.Array) {
      return {
        ...type,
        elementType: substitute((type as ArrayType).elementType),
      } as ArrayType;
    }
    if (type.kind === TypeKind.Class) {
      const ct = type as ClassType;
      if (ct.typeArguments) {
        return {
          ...ct,
          typeArguments: ct.typeArguments.map(substitute),
        } as ClassType;
      }
    }
    return type;
  };

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

export function typeToString(type: Type): string {
  switch (type.kind) {
    case TypeKind.Number:
      return (type as NumberType).name;
    case TypeKind.String:
      return 'string';
    case TypeKind.Boolean:
      return 'boolean';
    case TypeKind.Void:
      return 'void';
    case TypeKind.TypeParameter:
      return (type as TypeParameterType).name;
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
    case TypeKind.Array:
      return `[${typeToString((type as ArrayType).elementType)}]`;
    default:
      return type.kind;
  }
}
