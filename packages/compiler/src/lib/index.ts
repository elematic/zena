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
import {prelude} from './prelude.js';
import {NodeType, type Program} from './ast.js';

export function compile(source: string): Uint8Array {
  // Parse prelude
  const preludeParser = new Parser(prelude);
  const preludeAst = preludeParser.parse();

  // Parse user code
  const parser = new Parser(source);
  const ast = parser.parse();

  // Merge ASTs
  const program: Program = {
    type: NodeType.Program,
    body: [...preludeAst.body, ...ast.body],
  };

  const checker = new TypeChecker(program);
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

  const codegen = new CodeGenerator(program);
  return codegen.generate();
}
