export const NodeType = {
  Program: 'Program',
  VariableDeclaration: 'VariableDeclaration',
  ExpressionStatement: 'ExpressionStatement',
  BinaryExpression: 'BinaryExpression',
  NumberLiteral: 'NumberLiteral',
  StringLiteral: 'StringLiteral',
  Identifier: 'Identifier',
  FunctionExpression: 'FunctionExpression',
  CallExpression: 'CallExpression',
  BlockStatement: 'BlockStatement',
  ReturnStatement: 'ReturnStatement',
  Parameter: 'Parameter',
  TypeAnnotation: 'TypeAnnotation',
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
  | ReturnStatement;

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

export type Expression =
  | BinaryExpression
  | NumberLiteral
  | StringLiteral
  | Identifier
  | FunctionExpression
  | CallExpression;

export interface BinaryExpression extends Node {
  type: typeof NodeType.BinaryExpression;
  left: Expression;
  operator: string;
  right: Expression;
}

export interface NumberLiteral extends Node {
  type: typeof NodeType.NumberLiteral;
  value: string;
}

export interface StringLiteral extends Node {
  type: typeof NodeType.StringLiteral;
  value: string;
}

export interface Identifier extends Node {
  type: typeof NodeType.Identifier;
  name: string;
}

export interface TypeAnnotation extends Node {
  type: typeof NodeType.TypeAnnotation;
  name: string;
}

export interface Parameter extends Node {
  type: typeof NodeType.Parameter;
  name: Identifier;
  typeAnnotation: TypeAnnotation;
}

export interface FunctionExpression extends Node {
  type: typeof NodeType.FunctionExpression;
  params: Parameter[];
  returnType?: TypeAnnotation;
  body: Expression | BlockStatement;
}

export interface CallExpression extends Node {
  type: typeof NodeType.CallExpression;
  callee: Expression;
  arguments: Expression[];
}

export interface ReturnStatement extends Node {
  type: typeof NodeType.ReturnStatement;
  argument?: Expression;
}
