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
export * from './compiler.js';

import {Compiler, type CompilerHost} from './compiler.js';
import {CodeGenerator} from './codegen/index.js';
import {TypeChecker} from './checker/index.js';
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
    ]),
  );

  const compiler = new Compiler(host);
  const program = compiler.bundle('main.zena');

  const checker = new TypeChecker(program, compiler, {
    path: 'main.zena',
    isStdlib: true,
    exports: new Map(),
    source: '',
    ast: program,
    imports: new Map(),
    diagnostics: [],
  });
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
