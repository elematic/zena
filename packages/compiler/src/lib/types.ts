export const TypeKind = {
  Number: 'Number',
  Boolean: 'Boolean',
  Null: 'Null',
  Void: 'Void',
  Function: 'Function',
  Class: 'Class',
  Interface: 'Interface',
  Array: 'Array',
  Union: 'Union',
  TypeParameter: 'TypeParameter',
  Unknown: 'Unknown',
} as const;

export type TypeKind = (typeof TypeKind)[keyof typeof TypeKind];

export interface Type {
  kind: TypeKind;
}

export interface UnionType extends Type {
  kind: typeof TypeKind.Union;
  types: Type[];
}

export interface TypeParameterType extends Type {
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
  typeParameters?: TypeParameterType[];
  parameters: Type[];
  returnType: Type;
}

export interface InterfaceType extends Type {
  kind: typeof TypeKind.Interface;
  name: string;
  typeParameters?: TypeParameterType[];
  typeArguments?: Type[];
  fields: Map<string, Type>;
  methods: Map<string, FunctionType>;
}

export interface ClassType extends Type {
  kind: typeof TypeKind.Class;
  name: string;
  typeParameters?: TypeParameterType[];
  typeArguments?: Type[];
  superType?: ClassType;
  implements: InterfaceType[];
  fields: Map<string, Type>;
  methods: Map<string, FunctionType>;
  constructorType?: FunctionType;
  vtable: string[]; // Ordered list of method names
}

const I32 = {kind: TypeKind.Number, name: 'i32'} as NumberType;

export const StringClass: ClassType = {
  kind: TypeKind.Class,
  name: 'String',
  fields: new Map([['length', I32]]),
  methods: new Map(),
  implements: [],
  vtable: [],
};

export const Types = {
  Void: {kind: TypeKind.Void} as Type,
  Null: {kind: TypeKind.Null} as Type,
  String: StringClass,
  Boolean: {kind: TypeKind.Boolean} as Type,
  Unknown: {kind: TypeKind.Unknown} as Type,
  I32: I32,
  F32: {kind: TypeKind.Number, name: 'f32'} as NumberType,
} as const;
