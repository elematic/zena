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
  Parameter: 'Parameter',
  TypeAnnotation: 'TypeAnnotation',
  ClassDeclaration: 'ClassDeclaration',
  FieldDefinition: 'FieldDefinition',
  MethodDefinition: 'MethodDefinition',
  NewExpression: 'NewExpression',
  MemberExpression: 'MemberExpression',
  ThisExpression: 'ThisExpression',
  ArrayLiteral: 'ArrayLiteral',
  IndexExpression: 'IndexExpression',
  TypeParameter: 'TypeParameter',
  InterfaceDeclaration: 'InterfaceDeclaration',
  MethodSignature: 'MethodSignature',
  UnionTypeAnnotation: 'UnionTypeAnnotation',
  AccessorDeclaration: 'AccessorDeclaration',
  SuperExpression: 'SuperExpression',
  MixinDeclaration: 'MixinDeclaration',
} as const;

export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export interface Node {
  type: NodeType;
}

export interface Program extends Node {
  type: typeof NodeType.Program;
  body: Statement[];
}

export type Statement =
  | VariableDeclaration
  | ExpressionStatement
  | BlockStatement
  | ReturnStatement
  | IfStatement
  | WhileStatement
  | ClassDeclaration
  | InterfaceDeclaration
  | MixinDeclaration;

export interface VariableDeclaration extends Node {
  type: typeof NodeType.VariableDeclaration;
  kind: 'let' | 'var';
  identifier: Identifier;
  typeAnnotation?: TypeAnnotation;
  init: Expression;
  exported: boolean;
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

export interface IndexExpression extends Node {
  type: typeof NodeType.IndexExpression;
  object: Expression;
  index: Expression;
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
  | IndexExpression
  | SuperExpression;

export interface BinaryExpression extends Node {
  type: typeof NodeType.BinaryExpression;
  operator: string;
  left: Expression;
  right: Expression;
}

export interface AssignmentExpression extends Node {
  type: typeof NodeType.AssignmentExpression;
  left: Identifier | MemberExpression | IndexExpression;
  value: Expression;
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
  isFinal: boolean;
  isAbstract: boolean;
}

export interface MixinDeclaration extends Node {
  type: typeof NodeType.MixinDeclaration;
  name: Identifier;
  typeParameters?: TypeParameter[];
  on?: Identifier;
  mixins?: Identifier[];
  body: (FieldDefinition | MethodDefinition | AccessorDeclaration)[];
  exported: boolean;
}

export interface AccessorDeclaration extends Node {
  type: typeof NodeType.AccessorDeclaration;
  name: Identifier;
  typeAnnotation: TypeAnnotation;
  getter?: BlockStatement;
  setter?: {
    param: Identifier;
    body: BlockStatement;
  };
  isFinal: boolean;
}

export interface InterfaceDeclaration extends Node {
  type: typeof NodeType.InterfaceDeclaration;
  name: Identifier;
  typeParameters?: TypeParameter[];
  body: (FieldDefinition | MethodSignature)[];
  exported: boolean;
}

export interface MethodSignature extends Node {
  type: typeof NodeType.MethodSignature;
  name: Identifier;
  params: Parameter[];
  returnType?: TypeAnnotation;
}

export interface FieldDefinition extends Node {
  type: typeof NodeType.FieldDefinition;
  name: Identifier;
  typeAnnotation: TypeAnnotation;
  value?: Expression;
  isFinal: boolean;
}

export interface MethodDefinition extends Node {
  type: typeof NodeType.MethodDefinition;
  name: Identifier;
  params: Parameter[];
  returnType?: TypeAnnotation;
  body?: BlockStatement;
  isFinal: boolean;
  isAbstract: boolean;
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

export interface Parameter extends Node {
  type: typeof NodeType.Parameter;
  name: Identifier;
  typeAnnotation: TypeAnnotation;
}

export interface TypeParameter extends Node {
  type: typeof NodeType.TypeParameter;
  name: string;
  default?: TypeAnnotation;
}

export type TypeAnnotation = NamedTypeAnnotation | UnionTypeAnnotation;

export interface NamedTypeAnnotation extends Node {
  type: typeof NodeType.TypeAnnotation;
  name: string;
  typeArguments?: TypeAnnotation[];
}

export interface UnionTypeAnnotation extends Node {
  type: typeof NodeType.UnionTypeAnnotation;
  types: TypeAnnotation[];
}

export interface SuperExpression extends Node {
  type: typeof NodeType.SuperExpression;
}
