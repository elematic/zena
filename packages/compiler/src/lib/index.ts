export const version = '0.0.1';
export * from './lexer.js';
export * from './ast.js';
export * from './parser.js';
export * from './types.js';
export * from './bindings.js';
export * from './checker/index.js';
export * from './wasm.js';
export * from './emitter.js';
export * from './diagnostics.js';
export * from './codegen/index.js';
export * from './compiler.js';
export * from './loader/index.js';
export * from './visitor.js';
export * from './analysis/index.js';

import {Compiler, type CompilerHost} from './compiler.js';
import {CodeGenerator} from './codegen/index.js';
import {
  arrayModule,
  sequenceModule,
  immutableArrayModule,
  fixedArrayModule,
  growableArrayModule,
  stringModule,
  consoleModule,
  mapModule,
  boxModule,
  errorModule,
  templateStringsArrayModule,
  assertModule,
  testModule,
  rangeModule,
  regexModule,
  mathModule,
  iteratorModule,
  arrayIteratorModule,
  memoryModule,
} from './stdlib.js';

class InMemoryHost implements CompilerHost {
  files: Map<string, string>;

  constructor(files: Map<string, string>) {
    this.files = files;
  }

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) return specifier;
    return specifier;
  }

  load(path: string): string {
    if (this.files.has(path)) return this.files.get(path)!;
    throw new Error(`File not found: ${path}`);
  }
}

export function compile(source: string): Uint8Array {
  // console.log('Compiling source:', fullSource);
  const host = new InMemoryHost(
    new Map([
      ['main.zena', source],
      ['zena:array', arrayModule],
      ['zena:sequence', sequenceModule],
      ['zena:immutable-array', immutableArrayModule],
      ['zena:fixed-array', fixedArrayModule],
      ['zena:growable-array', growableArrayModule],
      ['zena:string', stringModule],
      ['zena:console', consoleModule],
      ['zena:map', mapModule],
      ['zena:box', boxModule],
      ['zena:error', errorModule],
      ['zena:template-strings-array', templateStringsArrayModule],
      ['zena:assert', assertModule],
      ['zena:test', testModule],
      ['zena:range', rangeModule],
      ['zena:regex', regexModule],
      ['zena:math', mathModule],
      ['zena:iterator', iteratorModule],
      ['zena:array-iterator', arrayIteratorModule],
      ['zena:memory', memoryModule],
    ]),
  );

  const compiler = new Compiler(host);

  // compile() runs type checking on all modules
  const modules = compiler.compile('main.zena');

  // Check for errors from any module
  const errors = modules.flatMap((m) => m.diagnostics ?? []);
  if (errors.length > 0) {
    const errorMessage = errors
      .map(
        (e) =>
          `${e.message} at line ${e.location?.line}, column ${e.location?.column}`,
      )
      .join('\n');
    throw new Error(errorMessage);
  }

  // Pass modules, entry point path, semantic context, and checker context to codegen
  const codegen = new CodeGenerator(
    modules,
    'main.zena',
    compiler.semanticContext,
    compiler.checkerContext,
  );
  return codegen.generate();
}

/**
 * Compile Zena source code with the standard library included.
 * This prepends the console stdlib to the user source before compilation.
 *
 * @param source - The Zena source code to compile
 * @returns The compiled WASM binary
 */
export function compileWithStdlib(source: string): Uint8Array {
  return compile(source);
}
