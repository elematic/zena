export const version = '0.0.1';
export * from './lexer.js';
export * from './ast.js';
export * from './parser.js';
export * from './types.js';
export * from './checker/index.js';
export * from './wasm.js';
export * from './emitter.js';
export * from './diagnostics.js';
export * from './codegen/index.js';

import {Parser} from './parser.js';
import {CodeGenerator} from './codegen/index.js';
import {TypeChecker} from './checker/index.js';

export function compile(source: string): Uint8Array {
  const parser = new Parser(source);
  const ast = parser.parse();

  const checker = new TypeChecker(ast);
  const errors = checker.check();
  if (errors.length > 0) {
    const errorMessage = errors
      .map(
        (e) =>
          `${e.message} at line ${e.location?.line}, column ${e.location?.column}`,
      )
      .join('\n');
    throw new Error(errorMessage);
  }

  const codegen = new CodeGenerator(ast);
  return codegen.generate();
}
