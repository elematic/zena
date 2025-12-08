export const TypeKind = {
  Number: 'Number',
  Boolean: 'Boolean',
  ByteArray: 'ByteArray',
  Null: 'Null',
  Void: 'Void',
  Function: 'Function',
  Class: 'Class',
  Interface: 'Interface',
  Mixin: 'Mixin',
  FixedArray: 'FixedArray',
  Record: 'Record',
  Tuple: 'Tuple',
  Union: 'Union',
  TypeParameter: 'TypeParameter',
  TypeAlias: 'TypeAlias',
  AnyRef: 'AnyRef',
  Any: 'Any',
  Unknown: 'Unknown',
  Never: 'Never',
  Literal: 'Literal',
} as const;

export type TypeKind = (typeof TypeKind)[keyof typeof TypeKind];

export interface Type {
  kind: TypeKind;
  _debugId?: number;
}

export interface UnionType extends Type {
  kind: typeof TypeKind.Union;
  types: Type[];
}

export interface TypeParameterType extends Type {
  kind: typeof TypeKind.TypeParameter;
  name: string;
  defaultType?: Type;
}

export interface TypeAliasType extends Type {
  kind: typeof TypeKind.TypeAlias;
  name: string;
  typeParameters?: TypeParameterType[];
  target: Type;
  isDistinct: boolean;
}

export interface FixedArrayType extends Type {
  kind: typeof TypeKind.FixedArray;
  elementType: Type;
}

export interface RecordType extends Type {
  kind: typeof TypeKind.Record;
  properties: Map<string, Type>;
}

export interface TupleType extends Type {
  kind: typeof TypeKind.Tuple;
  elementTypes: Type[];
}

export interface LiteralType extends Type {
  kind: typeof TypeKind.Literal;
  value: string | number | boolean;
}

export interface ByteArrayType extends Type {
  kind: typeof TypeKind.ByteArray;
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
  isFinal?: boolean;
  isAbstract?: boolean;
  overloads?: FunctionType[];
  optionalParameters?: boolean[];
  parameterInitializers?: any[]; // Expression[]
}

export interface InterfaceType extends Type {
  kind: typeof TypeKind.Interface;
  name: string;
  typeParameters?: TypeParameterType[];
  typeArguments?: Type[];
  extends?: InterfaceType[];
  fields: Map<string, Type>;
  methods: Map<string, FunctionType>;
}

export interface MixinType extends Type {
  kind: typeof TypeKind.Mixin;
  name: string;
  typeParameters?: TypeParameterType[];
  onType?: ClassType;
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
  isFinal?: boolean;
  isAbstract?: boolean;
  isExtension?: boolean;
  onType?: Type;
}

const I32 = {kind: TypeKind.Number, name: 'i32'} as NumberType;
const U32 = {kind: TypeKind.Number, name: 'u32'} as NumberType;

export const StringClass: ClassType = {
  kind: TypeKind.Class,
  name: 'String',
  fields: new Map(),
  methods: new Map(),
  implements: [],
  vtable: [],
  isExtension: true,
  onType: {kind: TypeKind.ByteArray} as Type,
};

export const Types = {
  Void: {kind: TypeKind.Void} as Type,
  Null: {kind: TypeKind.Null} as Type,
  String: StringClass,
  ByteArray: {kind: TypeKind.ByteArray} as Type,
  Boolean: {kind: TypeKind.Boolean} as Type,
  Unknown: {kind: TypeKind.Unknown} as Type,
  I32: I32,
  U32: U32,
  F32: {kind: TypeKind.Number, name: 'f32'} as NumberType,
  AnyRef: {kind: TypeKind.AnyRef} as Type,
  Any: {kind: TypeKind.Any} as Type,
  Never: {kind: TypeKind.Never} as Type,
} as const;
