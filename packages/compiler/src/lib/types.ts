/**
 * Compilation target for code generation.
 * - 'host': Custom console imports for @zena-lang/runtime (Node.js, browser)
 * - 'wasi': WASI Preview 1 imports for wasmtime and other WASI runtimes
 */
export type Target = 'host' | 'wasi';

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
  UnboxedTuple: 'UnboxedTuple',
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
  /** Human-readable name for debugging/diagnostics. Not used for identity. */
  debugName?: string;
  /** Unique ID for codegen. Assigned at symbol declaration time. */
  id: number;
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
  /** Names of optional properties. A property is required if not in this set. */
  optionalProperties?: Set<string>;
}

export interface TupleType extends Type {
  kind: typeof TypeKind.Tuple;
  elementTypes: Type[];
}

/**
 * Unboxed tuple type for multi-value returns.
 * Unlike boxed tuples [T1, T2], unboxed tuples (T1, T2) exist only on the WASM stack
 * and compile to WASM multi-value returns. They are not first-class values.
 */
export interface UnboxedTupleType extends Type {
  kind: typeof TypeKind.UnboxedTuple;
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
  typeArguments?: Type[]; // Concrete types when this is an instantiated generic function
  genericSource?: FunctionType; // For instantiated generics, points to the template
  parameters: Type[];
  parameterNames?: string[]; // Parameter names, parallel to parameters[]
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
  statics?: Map<string, Type>;
  symbolFields?: Map<SymbolType, Type>;
  symbolMethods?: Map<SymbolType, FunctionType>;
  /** For instantiated generics, points to the original generic type definition. */
  genericSource?: InterfaceType;
}

export interface MixinType extends Type {
  kind: typeof TypeKind.Mixin;
  name: string;
  typeParameters?: TypeParameterType[];
  typeArguments?: Type[];
  onType?: ClassType;
  fields: Map<string, Type>;
  methods: Map<string, FunctionType>;
  symbolFields?: Map<SymbolType, Type>;
  symbolMethods?: Map<SymbolType, FunctionType>;
  genericSource?: MixinType;
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
  symbolFields?: Map<SymbolType, Type>;
  symbolMethods?: Map<SymbolType, FunctionType>;
  constructorType?: FunctionType;
  vtable: string[]; // Ordered list of method names
  isFinal?: boolean;
  isAbstract?: boolean;
  isExtension?: boolean;
  isMixinIntermediate?: boolean; // True for synthetic intermediate mixin classes
  isSyntheticMixinThis?: boolean; // True for the synthetic `This` type inside mixin bodies
  onType?: Type;
  genericSource?: ClassType;
  /**
   * Set of mutable field names. Fields not in this set are immutable.
   * Immutable fields can only be assigned in the constructor.
   */
  mutableFields?: Set<string>;
  /**
   * For fields with private setters (var(#name) syntax), maps the public
   * field name to its setter name (private name or symbol).
   */
  fieldSetterNames?: Map<string, string>;
}

const I32 = {kind: TypeKind.Number, name: 'i32'} as NumberType;
const U32 = {kind: TypeKind.Number, name: 'u32'} as NumberType;
const I64 = {kind: TypeKind.Number, name: 'i64'} as NumberType;
const U64 = {kind: TypeKind.Number, name: 'u64'} as NumberType;
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
  isFinal: true,
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
  U64: U64,
  F32: F32,
  F64: F64,
  AnyRef: {kind: TypeKind.AnyRef} as Type,
  Any: {kind: TypeKind.Any} as Type,
  Never: {kind: TypeKind.Never} as Type,
  /** Base symbol type used for 'symbol' type annotations. ID -1 means "any symbol". */
  Symbol: {kind: TypeKind.Symbol, id: -1} as SymbolType,
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
  U64: 'u64',
  ByteArray: 'ByteArray',
} as const;

// ============================================================
// Semantic Analysis Results
// These types describe backend-independent analysis results that
// both WASM binary and WAT text backends can use.
// ============================================================
