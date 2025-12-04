import type {Type} from './types.js';

export const NodeType = {
  Program: 'Program',
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
  IfStatement: 'IfStatement',
  WhileStatement: 'WhileStatement',
  ForStatement: 'ForStatement',
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
  RecordPattern: 'RecordPattern',
  TuplePattern: 'TuplePattern',
  BindingProperty: 'BindingProperty',
  AssignmentPattern: 'AssignmentPattern',
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
  MatchExpression: 'MatchExpression',
  MatchCase: 'MatchCase',
  ClassPattern: 'ClassPattern',
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

export interface Program extends Node {
  type: typeof NodeType.Program;
  body: Statement[];
  wellKnownTypes: {
    FixedArray?: ClassDeclaration;
    String?: ClassDeclaration;
    ByteArray?: ClassDeclaration;
    Box?: ClassDeclaration;
  };
  symbolMap?: Map<string, string>;
}

export type Statement =
  | VariableDeclaration
  | ExpressionStatement
  | BlockStatement
  | ReturnStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | ClassDeclaration
  | InterfaceDeclaration
  | MixinDeclaration
  | DeclareFunction
  | ImportDeclaration
  | TypeAliasDeclaration;

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

export interface RecordLiteral extends Node {
  type: typeof NodeType.RecordLiteral;
  properties: PropertyAssignment[];
}

export interface TupleLiteral extends Node {
  type: typeof NodeType.TupleLiteral;
  elements: Expression[];
}

export interface IndexExpression extends Node {
  type: typeof NodeType.IndexExpression;
  object: Expression;
  index: Expression;
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

export interface AssignmentPattern extends Node {
  type: typeof NodeType.AssignmentPattern;
  left: Pattern;
  right: Expression;
}

export type Pattern =
  | Identifier
  | RecordPattern
  | TuplePattern
  | AssignmentPattern;

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
  | IndexExpression
  | SuperExpression
  | TemplateLiteral
  | TaggedTemplateExpression
  | AsExpression
  | IsExpression
  | UnaryExpression
  | ThrowExpression
  | MatchExpression;

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
  body: Expression;
}

export interface ClassPattern extends Node {
  type: typeof NodeType.ClassPattern;
  name: Identifier;
  properties: BindingProperty[];
}

export interface BinaryExpression extends Node {
  type: typeof NodeType.BinaryExpression;
  operator: string;
  left: Expression;
  right: Expression;
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

export interface ThrowExpression extends Node {
  type: typeof NodeType.ThrowExpression;
  argument: Expression;
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
  superClass?: Identifier;
  mixins?: Identifier[];
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
  mixins?: Identifier[];
  body: (FieldDefinition | MethodDefinition | AccessorDeclaration)[];
  exported: boolean;
  exportName?: string;
}

export interface AccessorDeclaration extends Node {
  type: typeof NodeType.AccessorDeclaration;
  name: Identifier;
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
  body: (FieldDefinition | MethodSignature)[];
  exported: boolean;
  exportName?: string;
}

export interface MethodSignature extends Node {
  type: typeof NodeType.MethodSignature;
  name: Identifier;
  typeParameters?: TypeParameter[];
  params: Parameter[];
  returnType?: TypeAnnotation;
}

export interface FieldDefinition extends Node {
  type: typeof NodeType.FieldDefinition;
  name: Identifier;
  typeAnnotation: TypeAnnotation;
  value?: Expression;
  isFinal: boolean;
  isStatic: boolean;
  isDeclare?: boolean;
  decorators?: Decorator[];
}

export interface Decorator extends Node {
  type: typeof NodeType.Decorator;
  name: string;
  args: StringLiteral[];
}

export interface MethodDefinition extends Node {
  type: typeof NodeType.MethodDefinition;
  name: Identifier;
  typeParameters?: TypeParameter[];
  params: Parameter[];
  returnType?: TypeAnnotation;
  body?: BlockStatement;
  isFinal: boolean;
  isAbstract: boolean;
  isStatic: boolean;
  isDeclare: boolean;
  decorators?: Decorator[];
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
}

export interface ReturnStatement extends Node {
  type: typeof NodeType.ReturnStatement;
  argument?: Expression;
}

export interface IfStatement extends Node {
  type: typeof NodeType.IfStatement;
  test: Expression;
  consequent: Statement;
  alternate?: Statement;
}

export interface WhileStatement extends Node {
  type: typeof NodeType.WhileStatement;
  test: Expression;
  body: Statement;
}

export interface ForStatement extends Node {
  type: typeof NodeType.ForStatement;
  init?: VariableDeclaration | Expression;
  test?: Expression;
  update?: Expression;
  body: Statement;
}

export interface Parameter extends Node {
  type: typeof NodeType.Parameter;
  name: Identifier;
  typeAnnotation: TypeAnnotation;
  optional: boolean;
  initializer?: Expression;
}

export interface TypeParameter extends Node {
  type: typeof NodeType.TypeParameter;
  name: string;
  default?: TypeAnnotation;
}

export type TypeAnnotation =
  | NamedTypeAnnotation
  | UnionTypeAnnotation
  | RecordTypeAnnotation
  | TupleTypeAnnotation
  | FunctionTypeAnnotation;

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

export interface UnionTypeAnnotation extends Node {
  type: typeof NodeType.UnionTypeAnnotation;
  types: TypeAnnotation[];
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
