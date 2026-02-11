import {type CompilerHost, type Target} from '@zena-lang/compiler';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export class NodeCompilerHost implements CompilerHost {
  #stdlibPath: string;
  #virtualFiles: Map<string, string> = new Map();
  #target: Target;

  constructor(target: Target = 'host') {
    this.#target = target;
    this.#stdlibPath = this.#findStdlibPath();
  }

  /**
   * Register a virtual file that exists only in memory.
   * This is used for generated wrapper files.
   */
  registerVirtualFile(path: string, content: string): void {
    this.#virtualFiles.set(path, content);
  }

  #findStdlibPath(): string {
    const pkgPath = fileURLToPath(import.meta.resolve('@zena-lang/stdlib'));
    return join(dirname(pkgPath), 'zena');
  }

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) {
      // zena:console is a virtual module that maps to the appropriate implementation
      // based on the target. The actual files are console-host.zena and console-wasi.zena.
      if (specifier === 'zena:console') {
        return this.#target === 'wasi'
          ? 'zena:console-wasi'
          : 'zena:console-host';
      }
      return specifier;
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
      const name = path.substring(5); // remove 'zena:'

      const filePath = join(this.#stdlibPath, `${name}.zena`);
      if (!existsSync(filePath)) {
        throw new Error(
          `Standard library module not found: ${path} at ${filePath}`,
        );
      }
      return readFileSync(filePath, 'utf-8');
    }

    if (!existsSync(path)) {
      throw new Error(`File not found: ${path}`);
    }
    return readFileSync(path, 'utf-8');
  }
}
