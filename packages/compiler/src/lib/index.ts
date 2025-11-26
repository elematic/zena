export const version = '0.0.1';
export * from './lexer.js';
export * from './ast.js';
export * from './parser.js';
export * from './types.js';
export * from './checker.js';
export * from './wasm.js';
export * from './emitter.js';
export * from './diagnostics.js';
export * from './codegen/index.js';

import {Parser} from './parser.js';
import {CodeGenerator} from './codegen/index.js';
import {TypeChecker} from './checker.js';

export function compile(source: string): Uint8Array {
  const parser = new Parser(source);
  const ast = parser.parse();

  const checker = new TypeChecker(ast);
  const errors = checker.check();
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  const codegen = new CodeGenerator(ast);
  return codegen.generate();
}
