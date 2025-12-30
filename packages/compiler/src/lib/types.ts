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
  Array: 'Array',
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
  Symbol: 'Symbol',
  This: 'This',
} as const;

export type TypeKind = (typeof TypeKind)[keyof typeof TypeKind];

export interface Type {
  kind: TypeKind;
  _debugId?: number;
}

export interface SymbolType extends Type {
  kind: typeof TypeKind.Symbol;
  uniqueId?: string;
}

/**
 * Represents the `this` type in class/interface definitions.
 * This is a placeholder type that gets resolved to the actual implementing type.
 */
export interface ThisType extends Type {
  kind: typeof TypeKind.This;
}

export interface UnionType extends Type {
  kind: typeof TypeKind.Union;
  types: Type[];
}

export interface TypeParameterType extends Type {
  kind: typeof TypeKind.TypeParameter;
  name: string;
  constraint?: Type;
  defaultType?: Type;
}

export interface TypeAliasType extends Type {
  kind: typeof TypeKind.TypeAlias;
  name: string;
  typeParameters?: TypeParameterType[];
  target: Type;
  isDistinct: boolean;
}

export interface ArrayType extends Type {
  kind: typeof TypeKind.Array;
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
  symbolFields?: Map<string, Type>;
  symbolMethods?: Map<string, FunctionType>;
}

export interface MixinType extends Type {
  kind: typeof TypeKind.Mixin;
  name: string;
  typeParameters?: TypeParameterType[];
  typeArguments?: Type[];
  onType?: ClassType;
  fields: Map<string, Type>;
  methods: Map<string, FunctionType>;
  symbolFields?: Map<string, Type>;
  symbolMethods?: Map<string, FunctionType>;
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
  statics: Map<string, Type>;
  symbolFields?: Map<string, Type>;
  symbolMethods?: Map<string, FunctionType>;
  constructorType?: FunctionType;
  vtable: string[]; // Ordered list of method names
  isFinal?: boolean;
  isAbstract?: boolean;
  isExtension?: boolean;
  isMixinIntermediate?: boolean; // True for synthetic intermediate mixin classes
  onType?: Type;
  genericSource?: ClassType;
}

const I32 = {kind: TypeKind.Number, name: 'i32'} as NumberType;
const U32 = {kind: TypeKind.Number, name: 'u32'} as NumberType;
const I64 = {kind: TypeKind.Number, name: 'i64'} as NumberType;
const F32 = {kind: TypeKind.Number, name: 'f32'} as NumberType;
const F64 = {kind: TypeKind.Number, name: 'f64'} as NumberType;

export const StringClass: ClassType = {
  kind: TypeKind.Class,
  name: 'String',
  fields: new Map(),
  methods: new Map(),
  statics: new Map(),
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
  I64: I64,
  F32: F32,
  F64: F64,
  AnyRef: {kind: TypeKind.AnyRef} as Type,
  Any: {kind: TypeKind.Any} as Type,
  Never: {kind: TypeKind.Never} as Type,
  Symbol: {kind: TypeKind.Symbol} as SymbolType,
  Array: {
    kind: TypeKind.Array,
    elementType: {kind: TypeKind.Unknown} as Type,
  } as ArrayType,
} as const;

export const Decorators = {
  Intrinsic: 'intrinsic',
  External: 'external',
} as const;

export const TypeNames = {
  Void: 'void',
  Never: 'never',
  Null: 'null',
  Boolean: 'boolean',
  String: 'string',
  Any: 'any',
  AnyRef: 'anyref',
  EqRef: 'eqref',
  Struct: 'struct',
  Array: 'array',
  FixedArray: 'FixedArray',
  TemplateStringsArray: 'TemplateStringsArray',
  I32: 'i32',
  I64: 'i64',
  F32: 'f32',
  F64: 'f64',
  U32: 'u32',
  ByteArray: 'ByteArray',
} as const;
