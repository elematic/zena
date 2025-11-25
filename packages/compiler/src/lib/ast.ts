export const NodeType = {
  Program: 'Program',
  VariableDeclaration: 'VariableDeclaration',
  ExpressionStatement: 'ExpressionStatement',
  BinaryExpression: 'BinaryExpression',
  AssignmentExpression: 'AssignmentExpression',
  NumberLiteral: 'NumberLiteral',
  StringLiteral: 'StringLiteral',
  BooleanLiteral: 'BooleanLiteral',
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
  | ClassDeclaration;

export interface VariableDeclaration extends Node {
  type: typeof NodeType.VariableDeclaration;
  kind: 'let' | 'var';
  identifier: Identifier;
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
  | Identifier
  | FunctionExpression
  | CallExpression
  | NewExpression
  | MemberExpression
  | ThisExpression
  | ArrayLiteral
  | IndexExpression;

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
}

export interface StringLiteral extends Node {
  type: typeof NodeType.StringLiteral;
  value: string;
}

export interface BooleanLiteral extends Node {
  type: typeof NodeType.BooleanLiteral;
  value: boolean;
}

export interface Identifier extends Node {
  type: typeof NodeType.Identifier;
  name: string;
}

export interface ClassDeclaration extends Node {
  type: typeof NodeType.ClassDeclaration;
  name: Identifier;
  typeParameters?: Identifier[];
  body: (FieldDefinition | MethodDefinition)[];
}

export interface FieldDefinition extends Node {
  type: typeof NodeType.FieldDefinition;
  name: Identifier;
  typeAnnotation: TypeAnnotation;
  value?: Expression;
}

export interface MethodDefinition extends Node {
  type: typeof NodeType.MethodDefinition;
  name: Identifier;
  params: Parameter[];
  returnType?: TypeAnnotation;
  body: BlockStatement;
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
  typeParameters?: Identifier[];
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

export interface TypeAnnotation extends Node {
  type: typeof NodeType.TypeAnnotation;
  name: string;
  typeArguments?: TypeAnnotation[];
}
