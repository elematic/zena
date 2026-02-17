import {type CompilerHost, type Target} from '@zena-lang/compiler';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {
  resolveStdlibModule,
  loadStdlibModule,
  isInternalModule,
} from '@zena-lang/stdlib';

export class NodeCompilerHost implements CompilerHost {
  #virtualFiles: Map<string, string> = new Map();
  #target: Target;

  constructor(target: Target = 'host') {
    this.#target = target;
  }

  /**
   * Register a virtual file that exists only in memory.
   * This is used for generated wrapper files.
   */
  registerVirtualFile(path: string, content: string): void {
    this.#virtualFiles.set(path, content);
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

    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      // referrer is absolute path
      const dir = dirname(referrer);
      const path = resolve(dir, specifier);
      return path;
    }

    throw new Error(`Cannot resolve specifier: ${specifier}`);
  }

  load(path: string): string {
    // Check virtual files first
    if (this.#virtualFiles.has(path)) {
      return this.#virtualFiles.get(path)!;
    }

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

    if (!existsSync(path)) {
      throw new Error(`File not found: ${path}`);
    }
    return readFileSync(path, 'utf-8');
  }
}
