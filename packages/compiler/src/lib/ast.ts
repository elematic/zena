import type {ClassType, FunctionType, SymbolType, Type} from './types.js';
import type {Diagnostic} from './diagnostics.js';

/**
 * Declaration types that can be associated with a symbol.
 * This enables tracking what AST node a name refers to.
 */
export type Declaration =
  | Parameter
  | VariableDeclaration
  | Identifier
  | FunctionExpression
  | DeclareFunction
  | ClassDeclaration
  | InterfaceDeclaration
  | MixinDeclaration
  | TypeAliasDeclaration
  | TypeParameter
  | EnumDeclaration
  | SymbolDeclaration;

/**
 * Information about a symbol in a scope.
 */
export interface SymbolInfo {
  type: Type;
  kind: 'let' | 'var' | 'type';
  /** The AST node that declares this symbol. */
  declaration?: Declaration;
  /** The module path where this symbol is declared. */
  modulePath?: string;
}

export const NodeType = {
  Module: 'Module',
  VariableDeclaration: 'VariableDeclaration',
  ExpressionStatement: 'ExpressionStatement',
  BinaryExpression: 'BinaryExpression',
  AssignmentExpression: 'AssignmentExpression',
  NumberLiteral: 'NumberLiteral',
  StringLiteral: 'StringLiteral',
  BooleanLiteral: 'BooleanLiteral',
  NullLiteral: 'NullLiteral',
  Identifier: 'Identifier',
  FunctionExpression: 'FunctionExpression',
  CallExpression: 'CallExpression',
  BlockStatement: 'BlockStatement',
  ReturnStatement: 'ReturnStatement',
  BreakStatement: 'BreakStatement',
  ContinueStatement: 'ContinueStatement',
  IfStatement: 'IfStatement',
  WhileStatement: 'WhileStatement',
  ForStatement: 'ForStatement',
  ForInStatement: 'ForInStatement',
  Parameter: 'Parameter',
  TypeAnnotation: 'TypeAnnotation',
  ClassDeclaration: 'ClassDeclaration',
  FieldDefinition: 'FieldDefinition',
  MethodDefinition: 'MethodDefinition',
  NewExpression: 'NewExpression',
  MemberExpression: 'MemberExpression',
  ThisExpression: 'ThisExpression',
  ArrayLiteral: 'ArrayLiteral',
  RecordLiteral: 'RecordLiteral',
  PropertyAssignment: 'PropertyAssignment',
  TupleLiteral: 'TupleLiteral',
  UnboxedTupleLiteral: 'UnboxedTupleLiteral',
  IndexExpression: 'IndexExpression',
  TypeParameter: 'TypeParameter',
  InterfaceDeclaration: 'InterfaceDeclaration',
  MethodSignature: 'MethodSignature',
  UnionTypeAnnotation: 'UnionTypeAnnotation',
  AccessorDeclaration: 'AccessorDeclaration',
  SuperExpression: 'SuperExpression',
  MixinDeclaration: 'MixinDeclaration',
  DeclareFunction: 'DeclareFunction',
  ImportDeclaration: 'ImportDeclaration',
  ImportSpecifier: 'ImportSpecifier',
  RecordTypeAnnotation: 'RecordTypeAnnotation',
  PropertySignature: 'PropertySignature',
  TupleTypeAnnotation: 'TupleTypeAnnotation',
  UnboxedTupleTypeAnnotation: 'UnboxedTupleTypeAnnotation',
  RecordPattern: 'RecordPattern',
  TuplePattern: 'TuplePattern',
  UnboxedTuplePattern: 'UnboxedTuplePattern',
  BindingProperty: 'BindingProperty',
  AssignmentPattern: 'AssignmentPattern',
  AsPattern: 'AsPattern',
  FunctionTypeAnnotation: 'FunctionTypeAnnotation',
  TemplateLiteral: 'TemplateLiteral',
  TaggedTemplateExpression: 'TaggedTemplateExpression',
  TemplateElement: 'TemplateElement',
  TypeAliasDeclaration: 'TypeAliasDeclaration',
  AsExpression: 'AsExpression',
  IsExpression: 'IsExpression',
  Decorator: 'Decorator',
  UnaryExpression: 'UnaryExpression',
  ThrowExpression: 'ThrowExpression',
  TryExpression: 'TryExpression',
  CatchClause: 'CatchClause',
  MatchExpression: 'MatchExpression',
  MatchCase: 'MatchCase',
  ClassPattern: 'ClassPattern',
  LogicalPattern: 'LogicalPattern',
  IfExpression: 'IfExpression',
  AccessorSignature: 'AccessorSignature',
  LiteralTypeAnnotation: 'LiteralTypeAnnotation',
  ThisTypeAnnotation: 'ThisTypeAnnotation',
  SpreadElement: 'SpreadElement',
  ExportAllDeclaration: 'ExportAllDeclaration',
  SymbolPropertyName: 'SymbolPropertyName',
  EnumDeclaration: 'EnumDeclaration',
  EnumMember: 'EnumMember',
  RangeExpression: 'RangeExpression',
  LetPatternCondition: 'LetPatternCondition',
  SymbolDeclaration: 'SymbolDeclaration',
  PipelineExpression: 'PipelineExpression',
  PipePlaceholder: 'PipePlaceholder',
  FieldInitializer: 'FieldInitializer',
} as const;

export type NodeType = (typeof NodeType)[keyof typeof NodeType];

/**
 * Source location information for an AST node.
 * Contains both position (line/column) and range (start/end indices).
 */
export interface SourceLocation {
  /** 1-based line number */
  line: number;
  /** 1-based column number */
  column: number;
  /** 0-based start index in the source string (inclusive) */
  start: number;
  /** 0-based end index in the source string (exclusive) */
  end: number;
}

export interface Node {
  type: NodeType;
  /** Source location information for this node */
  loc?: SourceLocation;
  /** The type inferred for this node by the checker */
  inferredType?: Type;
  /** The type arguments inferred for this node (if it's a generic call/instantiation) */
  inferredTypeArguments?: Type[];
}

/**
 * A Program represents a complete compilation unit.
 * It contains all modules and tracks the entry point.
 */
export interface Program {
  /** All modules in the program, keyed by path */
  modules: Map<string, Module>;
  /** The entry point module path */
  entryPoint: string;
  /** Modules from the prelude (auto-imported) */
  preludeModules: Module[];
}

/**
 * A Module represents a single source file.
 * Contains both the AST and compilation metadata.
 */
export interface Module extends Node {
  type: typeof NodeType.Module;
  /** Statements in this module */
  body: Statement[];

  /** Canonical path identifying this module (e.g., "zena:string", "/abs/path.zena") */
  readonly path: string;
  /** Whether this module is part of the standard library */
  readonly isStdlib: boolean;
  /** The original source code */
  readonly source: string;
  /** Resolved import mappings: specifier -> resolvedPath */
  readonly imports: Map<string, string>;
  /** Exported symbols (populated by checker) */
  readonly exports: Map<string, SymbolInfo>;
  /** Type-checking diagnostics (initialized to [], populated by checker) */
  diagnostics: Diagnostic[];
  /**
   * Whether class fields are mutable by default in this module.
   * - false (default): fields are immutable unless marked with `var`
   * - true: fields are mutable (legacy behavior for migration)
   */
  readonly mutableFields?: boolean;
}

export type Statement =
  | VariableDeclaration
  | ExpressionStatement
  | BlockStatement
  | ReturnStatement
  | BreakStatement
  | ContinueStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | ForInStatement
  | ClassDeclaration
  | InterfaceDeclaration
  | MixinDeclaration
  | DeclareFunction
  | ImportDeclaration
  | ExportAllDeclaration
  | TypeAliasDeclaration
  | EnumDeclaration
  | SymbolDeclaration;

export interface ImportSpecifier extends Node {
  type: typeof NodeType.ImportSpecifier;
  imported: Identifier;
  local: Identifier;
}

export interface ImportDeclaration extends Node {
  type: typeof NodeType.ImportDeclaration;
  moduleSpecifier: StringLiteral;
  imports: ImportSpecifier[];
}

export interface ExportAllDeclaration extends Node {
  type: typeof NodeType.ExportAllDeclaration;
  moduleSpecifier: StringLiteral;
}

export interface DeclareFunction extends Node {
  type: typeof NodeType.DeclareFunction;
  name: Identifier;
  typeParameters?: TypeParameter[];
  params: Parameter[];
  returnType: TypeAnnotation;
  externalModule?: string;
  externalName?: string;
  exported?: boolean;
  decorators?: Decorator[];
}

export interface TypeAliasDeclaration extends Node {
  type: typeof NodeType.TypeAliasDeclaration;
  name: Identifier;
  typeParameters?: TypeParameter[];
  typeAnnotation: TypeAnnotation;
  exported: boolean;
  isDistinct: boolean;
  /** Inferred type, populated by the checker. */
  inferredType?: Type;
}

/**
 * A symbol declaration: `symbol name;` or `export symbol name;`
 * Symbols are compile-time unique identifiers for methods/fields.
 */
export interface SymbolDeclaration extends Node {
  type: typeof NodeType.SymbolDeclaration;
  name: Identifier;
  exported: boolean;
  /** The SymbolType, populated by the checker. */
  inferredType?: Type;
}

export interface VariableDeclaration extends Node {
  type: typeof NodeType.VariableDeclaration;
  kind: 'let' | 'var';
  pattern: Pattern;
  typeAnnotation?: TypeAnnotation;
  init: Expression;
  exported: boolean;
  exportName?: string;
}

export interface ExpressionStatement extends Node {
  type: typeof NodeType.ExpressionStatement;
  expression: Expression;
}

export interface BlockStatement extends Node {
  type: typeof NodeType.BlockStatement;
  body: Statement[];
}

export interface ArrayLiteral extends Node {
  type: typeof NodeType.ArrayLiteral;
  elements: Expression[];
}

export interface PropertyAssignment extends Node {
  type: typeof NodeType.PropertyAssignment;
  name: Identifier;
  value: Expression;
}

export interface SpreadElement extends Node {
  type: typeof NodeType.SpreadElement;
  argument: Expression;
}

export interface RecordLiteral extends Node {
  type: typeof NodeType.RecordLiteral;
  properties: (PropertyAssignment | SpreadElement)[];
}

export interface TupleLiteral extends Node {
  type: typeof NodeType.TupleLiteral;
  elements: Expression[];
}

/**
 * Unboxed tuple literal for multi-value returns: (expr1, expr2, ...)
 * Unlike boxed tuples [a, b], these exist only on the WASM stack.
 */
export interface UnboxedTupleLiteral extends Node {
  type: typeof NodeType.UnboxedTupleLiteral;
  elements: Expression[];
}

export interface IndexExpression extends Node {
  type: typeof NodeType.IndexExpression;
  object: Expression;
  index: Expression;
  /** Set by checker when operator[] method is resolved (for class types) */
  resolvedOperatorMethod?: FunctionType;
  /** Set by checker for extension class operator[] (e.g., FixedArray on array types) */
  extensionClassType?: ClassType;
}

export interface RecordPattern extends Node {
  type: typeof NodeType.RecordPattern;
  properties: BindingProperty[];
}

export interface BindingProperty extends Node {
  type: typeof NodeType.BindingProperty;
  name: Identifier;
  value: Pattern;
}

export interface TuplePattern extends Node {
  type: typeof NodeType.TuplePattern;
  elements: (Pattern | null)[];
}

export interface UnboxedTuplePattern extends Node {
  type: typeof NodeType.UnboxedTuplePattern;
  elements: Pattern[];
}

export interface AssignmentPattern extends Node {
  type: typeof NodeType.AssignmentPattern;
  left: Pattern;
  right: Expression;
}

export type Pattern =
  | Identifier
  | RecordPattern
  | TuplePattern
  | UnboxedTuplePattern
  | AssignmentPattern
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NullLiteral
  | ClassPattern
  | AsPattern
  | LogicalPattern
  | MemberExpression;

export interface LogicalPattern extends Node {
  type: typeof NodeType.LogicalPattern;
  operator: '||' | '&&';
  left: Pattern;
  right: Pattern;
}

export interface AsPattern extends Node {
  type: typeof NodeType.AsPattern;
  pattern: Pattern;
  name: Identifier;
}

export type Expression =
  | BinaryExpression
  | AssignmentExpression
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NullLiteral
  | Identifier
  | FunctionExpression
  | CallExpression
  | NewExpression
  | MemberExpression
  | ThisExpression
  | ArrayLiteral
  | RecordLiteral
  | TupleLiteral
  | UnboxedTupleLiteral
  | IndexExpression
  | SuperExpression
  | TemplateLiteral
  | TaggedTemplateExpression
  | AsExpression
  | IsExpression
  | UnaryExpression
  | ThrowExpression
  | TryExpression
  | MatchExpression
  | IfExpression
  | RangeExpression
  | PipelineExpression
  | PipePlaceholder;

export interface MatchExpression extends Node {
  type: typeof NodeType.MatchExpression;
  discriminant: Expression;
  cases: MatchCase[];
}

export interface MatchCase extends Node {
  type: typeof NodeType.MatchCase;
  pattern:
    | Pattern
    | ClassPattern
    | NumberLiteral
    | StringLiteral
    | BooleanLiteral
    | NullLiteral;
  guard?: Expression;
  body: Expression | BlockStatement;
}

export interface ClassPattern extends Node {
  type: typeof NodeType.ClassPattern;
  name: Identifier;
  properties: BindingProperty[];
}

/**
 * If expression - like Rust, if/else can be used as an expression.
 * Both consequent and alternate evaluate to the last expression in their block.
 * If used as an expression, the alternate is required.
 */
export interface IfExpression extends Node {
  type: typeof NodeType.IfExpression;
  test: Expression;
  consequent: Expression | BlockStatement;
  alternate: Expression | BlockStatement;
}

export interface BinaryExpression extends Node {
  type: typeof NodeType.BinaryExpression;
  operator: string;
  left: Expression;
  right: Expression;
  /** Set by checker when an operator method (e.g., `operator +`) is resolved on the left operand's type */
  resolvedOperatorMethod?: FunctionType;
}

export interface AssignmentExpression extends Node {
  type: typeof NodeType.AssignmentExpression;
  left: Expression | Pattern;
  value: Expression;
}

export interface AsExpression extends Node {
  type: typeof NodeType.AsExpression;
  expression: Expression;
  typeAnnotation: TypeAnnotation;
}

export interface IsExpression extends Node {
  type: typeof NodeType.IsExpression;
  expression: Expression;
  typeAnnotation: TypeAnnotation;
}

export interface UnaryExpression extends Node {
  type: typeof NodeType.UnaryExpression;
  operator: string;
  argument: Expression;
  prefix: boolean;
}

export interface RangeExpression extends Node {
  type: typeof NodeType.RangeExpression;
  start: Expression | null;
  end: Expression | null;
}

/**
 * Pipeline expression: left |> right
 * The left expression is evaluated and made available to the right side via $.
 */
export interface PipelineExpression extends Node {
  type: typeof NodeType.PipelineExpression;
  left: Expression;
  right: Expression;
}

/**
 * Pipeline placeholder ($) - refers to the piped value in a pipeline expression.
 * Only valid within the right-hand side of a pipeline expression.
 */
export interface PipePlaceholder extends Node {
  type: typeof NodeType.PipePlaceholder;
}

export interface ThrowExpression extends Node {
  type: typeof NodeType.ThrowExpression;
  argument: Expression;
}

/**
 * Try/catch expression - like Rust, try/catch can be used as an expression.
 * The type is the union of the try body and catch body types.
 */
export interface TryExpression extends Node {
  type: typeof NodeType.TryExpression;
  body: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
}

export interface CatchClause extends Node {
  type: typeof NodeType.CatchClause;
  param: Identifier | null;
  body: BlockStatement;
}

export interface NumberLiteral extends Node {
  type: typeof NodeType.NumberLiteral;
  value: number;
  raw?: string;
}

export interface StringLiteral extends Node {
  type: typeof NodeType.StringLiteral;
  value: string;
}

export interface BooleanLiteral extends Node {
  type: typeof NodeType.BooleanLiteral;
  value: boolean;
}

export interface NullLiteral extends Node {
  type: typeof NodeType.NullLiteral;
}

export interface Identifier extends Node {
  type: typeof NodeType.Identifier;
  name: string;
}

export interface ClassDeclaration extends Node {
  type: typeof NodeType.ClassDeclaration;
  name: Identifier;
  typeParameters?: TypeParameter[];
  superClass?: TypeAnnotation;
  mixins?: TypeAnnotation[];
  implements?: TypeAnnotation[];
  body: (FieldDefinition | MethodDefinition | AccessorDeclaration)[];
  exported: boolean;
  exportName?: string;
  isFinal: boolean;
  isAbstract: boolean;
  isExtension: boolean;
  onType?: TypeAnnotation;
}

export interface MixinDeclaration extends Node {
  type: typeof NodeType.MixinDeclaration;
  name: Identifier;
  typeParameters?: TypeParameter[];
  on?: Identifier;
  mixins?: TypeAnnotation[];
  body: (FieldDefinition | MethodDefinition | AccessorDeclaration)[];
  exported: boolean;
  exportName?: string;
}

export interface SymbolPropertyName extends Node {
  type: typeof NodeType.SymbolPropertyName;
  /** The expression referencing the symbol (identifier or member expression) */
  symbol: Expression;
}

export interface AccessorDeclaration extends Node {
  type: typeof NodeType.AccessorDeclaration;
  name: Identifier | SymbolPropertyName;
  typeAnnotation: TypeAnnotation;
  getter?: BlockStatement;
  setter?: {param: Identifier; body: BlockStatement};
  isFinal: boolean;
  isStatic: boolean;
  decorators?: Decorator[];
}

export interface InterfaceDeclaration extends Node {
  type: typeof NodeType.InterfaceDeclaration;
  name: Identifier;
  typeParameters?: TypeParameter[];
  extends?: TypeAnnotation[];
  body: (
    | FieldDefinition
    | MethodSignature
    | AccessorSignature
    | SymbolDeclaration
  )[];
  exported: boolean;
  exportName?: string;
}

export interface AccessorSignature extends Node {
  type: typeof NodeType.AccessorSignature;
  name: Identifier | SymbolPropertyName;
  typeAnnotation: TypeAnnotation;
  hasGetter: boolean;
  hasSetter: boolean;
}

export interface MethodSignature extends Node {
  type: typeof NodeType.MethodSignature;
  name: Identifier | SymbolPropertyName;
  typeParameters?: TypeParameter[];
  params: Parameter[];
  returnType?: TypeAnnotation;
}

export interface FieldDefinition extends Node {
  type: typeof NodeType.FieldDefinition;
  name: Identifier | SymbolPropertyName;
  typeAnnotation: TypeAnnotation;
  value?: Expression;
  isFinal: boolean;
  isStatic: boolean;
  isDeclare?: boolean;
  decorators?: Decorator[];
  /**
   * Field mutability:
   * - 'let' or undefined: Immutable field (only assignable in constructor)
   * - 'var': Mutable field with public setter
   */
  mutability?: 'let' | 'var';
  /**
   * For `var(#name) field` syntax, specifies the private setter name.
   * When present, the field has a public getter but the setter uses this name.
   * Can be a private name (#name) or symbol (:Sym.name).
   */
  setterName?: Identifier | SymbolPropertyName;
}

export interface Decorator extends Node {
  type: typeof NodeType.Decorator;
  name: string;
  args: StringLiteral[];
}

export interface MethodDefinition extends Node {
  type: typeof NodeType.MethodDefinition;
  name: Identifier | SymbolPropertyName;
  typeParameters?: TypeParameter[];
  params: Parameter[];
  returnType?: TypeAnnotation;
  body?: BlockStatement;
  isFinal: boolean;
  isAbstract: boolean;
  isStatic: boolean;
  isDeclare: boolean;
  decorators?: Decorator[];
  /**
   * Dart-style initializer list for constructors.
   * Syntax: `#new(x: i32) : fieldA = x, fieldB = x + 1 { }`
   * Expressions cannot reference `this`, only params and earlier initializers.
   */
  initializerList?: FieldInitializer[];
}

/**
 * A field initialization in a constructor's initializer list.
 * Example: `fieldName = expression`
 */
export interface FieldInitializer extends Node {
  type: typeof NodeType.FieldInitializer;
  /** The field being initialized */
  field: Identifier;
  /** The value expression (can reference params and earlier fields) */
  value: Expression;
}

export interface NewExpression extends Node {
  type: typeof NodeType.NewExpression;
  callee: Identifier;
  typeArguments?: TypeAnnotation[];
  arguments: Expression[];
}

export interface MemberExpression extends Node {
  type: typeof NodeType.MemberExpression;
  object: Expression;
  property: Identifier;
  /** True if this is symbol member access (obj.:symbol) */
  isSymbolAccess?: boolean;
  /** For symbol access, the full symbol path expression (e.g., Iterable.iterator as MemberExpression) */
  symbolPath?: Expression;
  /** Set by checker for symbol access - the resolved symbol type for identity-based lookup */
  resolvedSymbol?: SymbolType;
}

export interface ThisExpression extends Node {
  type: typeof NodeType.ThisExpression;
}

export interface FunctionExpression extends Node {
  type: typeof NodeType.FunctionExpression;
  typeParameters?: TypeParameter[];
  params: Parameter[];
  returnType?: TypeAnnotation;
  body: Expression | BlockStatement;
}

export interface CallExpression extends Node {
  type: typeof NodeType.CallExpression;
  callee: Expression;
  typeArguments?: TypeAnnotation[];
  arguments: Expression[];
  resolvedFunctionType?: Type;
  /**
   * Number of arguments explicitly provided by the caller.
   * Arguments at indices >= originalArgCount are defaults pushed by the checker.
   * Used by codegen to set up proper `this` context for default expressions.
   */
  originalArgCount?: number;
  /**
   * The class type that owns the method being called (for method calls).
   * Used by codegen to resolve `this` references in default expressions.
   */
  defaultArgsOwner?: Type;
  /**
   * Parameter names for ALL arguments (including defaults).
   * Used by codegen to create local bindings for earlier parameters when
   * generating default expressions that reference them.
   * Example: for `slice(start: i32 = 0, end: i32 = this.length - start)`,
   * this array would be ['start', 'end'] so that when generating `end`'s
   * default, we can bind `start` to its value.
   */
  defaultArgParamNames?: string[];
}

export interface ReturnStatement extends Node {
  type: typeof NodeType.ReturnStatement;
  argument?: Expression;
}

export interface BreakStatement extends Node {
  type: typeof NodeType.BreakStatement;
}

export interface ContinueStatement extends Node {
  type: typeof NodeType.ContinueStatement;
}

/**
 * A let-pattern condition for use in if/while statements.
 * Syntax: `let pattern = expr`
 *
 * The pattern must match the expression for the condition to be true.
 * For tuple patterns with literal elements, this enables discriminated union matching:
 *   if (let (true, value) = iter.next()) { ... }
 */
export interface LetPatternCondition extends Node {
  type: typeof NodeType.LetPatternCondition;
  pattern: Pattern;
  init: Expression;
}

export interface IfStatement extends Node {
  type: typeof NodeType.IfStatement;
  test: Expression | LetPatternCondition;
  consequent: Statement;
  alternate?: Statement;
}

export interface WhileStatement extends Node {
  type: typeof NodeType.WhileStatement;
  test: Expression | LetPatternCondition;
  body: Statement;
}

export interface ForStatement extends Node {
  type: typeof NodeType.ForStatement;
  init?: VariableDeclaration | Expression;
  test?: Expression;
  update?: Expression;
  body: Statement;
}

/**
 * For-in loop: `for (let pattern in iterable) body`
 * The iterable expression must implement Iterable<T>.
 */
export interface ForInStatement extends Node {
  type: typeof NodeType.ForInStatement;
  /** The pattern to bind each element to (identifier or destructuring) */
  pattern: Pattern;
  /** The iterable expression (must implement Iterable<T>) */
  iterable: Expression;
  body: Statement;
  /** Inferred element type, populated by the checker */
  elementType?: Type;

  /**
   * The Iterator<T> type returned by .:Iterator.iterator(), populated by the
   * checker
   */
  iteratorType?: Type;
  /** The symbol type for Iterable.iterator, populated by the checker */
  iteratorSymbol?: SymbolType;
}

export interface Parameter extends Node {
  type: typeof NodeType.Parameter;
  name: Identifier;
  typeAnnotation?: TypeAnnotation;
  optional: boolean;
  initializer?: Expression;
  /** Inferred type, populated by the checker. Used for contextual typing. */
  inferredType?: Type;
}

export interface TypeParameter extends Node {
  type: typeof NodeType.TypeParameter;
  name: string;
  constraint?: TypeAnnotation;
  default?: TypeAnnotation;
}

export type TypeAnnotation =
  | NamedTypeAnnotation
  | UnionTypeAnnotation
  | RecordTypeAnnotation
  | TupleTypeAnnotation
  | UnboxedTupleTypeAnnotation
  | FunctionTypeAnnotation
  | LiteralTypeAnnotation
  | ThisTypeAnnotation;

export interface FunctionTypeAnnotation extends Node {
  type: typeof NodeType.FunctionTypeAnnotation;
  params: TypeAnnotation[];
  returnType: TypeAnnotation;
}

export interface NamedTypeAnnotation extends Node {
  type: typeof NodeType.TypeAnnotation;
  name: string;
  typeArguments?: TypeAnnotation[];
}

export interface PropertySignature extends Node {
  type: typeof NodeType.PropertySignature;
  name: Identifier;
  optional?: boolean;
  typeAnnotation: TypeAnnotation;
}

export interface RecordTypeAnnotation extends Node {
  type: typeof NodeType.RecordTypeAnnotation;
  properties: PropertySignature[];
}

export interface TupleTypeAnnotation extends Node {
  type: typeof NodeType.TupleTypeAnnotation;
  elementTypes: TypeAnnotation[];
}

/**
 * Unboxed tuple type annotation for multi-value returns: (T1, T2, ...)
 * Unlike boxed tuple types [T1, T2], these compile to WASM multi-value returns.
 */
export interface UnboxedTupleTypeAnnotation extends Node {
  type: typeof NodeType.UnboxedTupleTypeAnnotation;
  elementTypes: TypeAnnotation[];
}

export interface UnionTypeAnnotation extends Node {
  type: typeof NodeType.UnionTypeAnnotation;
  types: TypeAnnotation[];
}

export interface LiteralTypeAnnotation extends Node {
  type: typeof NodeType.LiteralTypeAnnotation;
  value: string | number | boolean;
}

export interface ThisTypeAnnotation extends Node {
  type: typeof NodeType.ThisTypeAnnotation;
}

export interface SuperExpression extends Node {
  type: typeof NodeType.SuperExpression;
}

/**
 * Represents a single span in a template literal (the text between expressions).
 * Contains both "cooked" (escape-processed) and "raw" (original source) values.
 */
export interface TemplateElement extends Node {
  type: typeof NodeType.TemplateElement;
  value: {
    cooked: string;
    raw: string;
  };
  /** True if this is the last element (tail) */
  tail: boolean;
}

/**
 * Represents an untagged template literal like `hello ${name}`.
 * quasis contains the string parts, expressions contains the interpolated values.
 * quasis.length === expressions.length + 1
 */
export interface TemplateLiteral extends Node {
  type: typeof NodeType.TemplateLiteral;
  quasis: TemplateElement[];
  expressions: Expression[];
}

/**
 * Represents a tagged template literal like html`<div>${name}</div>`.
 * The tag is called with (strings: TemplateStringsArray, ...values: any[]).
 */
export interface TaggedTemplateExpression extends Node {
  type: typeof NodeType.TaggedTemplateExpression;
  tag: Expression;
  quasi: TemplateLiteral;
}

export interface EnumMember extends Node {
  type: typeof NodeType.EnumMember;
  name: Identifier;
  initializer?: Expression;
  /** The resolved constant value of the enum member (populated by checker) */
  resolvedValue?: number | string;
}

export interface EnumDeclaration extends Node {
  type: typeof NodeType.EnumDeclaration;
  name: Identifier;
  members: EnumMember[];
  exported: boolean;
  /** Inferred type, populated by the checker. */
  inferredType?: Type;
}
