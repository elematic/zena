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
  resolveStdlibModule,
  loadStdlibModule,
  isInternalModule,
  type Target,
} from '@zena-lang/stdlib';

class InMemoryHost implements CompilerHost {
  #files: Map<string, string>;
  #target: Target;

  constructor(files: Map<string, string>, target: Target = 'host') {
    this.#files = files;
    this.#target = target;
  }

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) {
      const name = specifier.substring(5);
      // Internal modules can only be imported from other stdlib modules
      if (isInternalModule(name)) {
        if (!referrer.startsWith('zena:')) {
          throw new Error(`Cannot import internal module: ${specifier}`);
        }
        return specifier; // Allow as-is for stdlib-to-stdlib imports
      }
      const resolved = resolveStdlibModule(name, this.#target);
      if (!resolved) {
        throw new Error(`Unknown stdlib module: ${specifier}`);
      }
      return `zena:${resolved}`;
    }
    return specifier;
  }

  load(path: string): string {
    if (this.#files.has(path)) return this.#files.get(path)!;
    if (path.startsWith('zena:')) {
      const name = path.substring(5);
      // Internal modules can be loaded (they're allowed after resolution from stdlib)
      if (isInternalModule(name)) {
        return loadStdlibModule(name);
      }
      const resolved = resolveStdlibModule(name, this.#target);
      if (!resolved) {
        throw new Error(`Stdlib module not found or not importable: ${name}`);
      }
      return loadStdlibModule(resolved);
    }
    throw new Error(`File not found: ${path}`);
  }
}

export function compile(source: string, target: Target = 'host'): Uint8Array {
  const host = new InMemoryHost(new Map([['main.zena', source]]), target);

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
