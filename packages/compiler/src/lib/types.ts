export const TypeKind = {
  Number: 'Number',
  String: 'String',
  Boolean: 'Boolean',
  Void: 'Void',
  Function: 'Function',
  Class: 'Class',
  Array: 'Array',
  TypeParameter: 'TypeParameter',
  Unknown: 'Unknown',
} as const;

export type TypeKind = (typeof TypeKind)[keyof typeof TypeKind];

export interface Type {
  kind: TypeKind;
}

export interface TypeParameter extends Type {
  kind: typeof TypeKind.TypeParameter;
  name: string;
}

export interface ArrayType extends Type {
  kind: typeof TypeKind.Array;
  elementType: Type;
}

export interface NumberType extends Type {
  kind: typeof TypeKind.Number;
  name: string; // 'i32', 'f32', etc.
}

export interface FunctionType extends Type {
  kind: typeof TypeKind.Function;
  typeParameters?: TypeParameter[];
  parameters: Type[];
  returnType: Type;
}

export interface ClassType extends Type {
  kind: typeof TypeKind.Class;
  name: string;
  typeParameters?: TypeParameter[];
  typeArguments?: Type[];
  fields: Map<string, Type>;
  methods: Map<string, FunctionType>;
  constructorType?: FunctionType;
}

export const Types = {
  Void: {kind: TypeKind.Void} as Type,
  String: {kind: TypeKind.String} as Type,
  Boolean: {kind: TypeKind.Boolean} as Type,
  Unknown: {kind: TypeKind.Unknown} as Type,
  I32: {kind: TypeKind.Number, name: 'i32'} as NumberType,
  F32: {kind: TypeKind.Number, name: 'f32'} as NumberType,
} as const;
