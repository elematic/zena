import {type CompilerHost} from '@zena-lang/compiler';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export class NodeCompilerHost implements CompilerHost {
  #stdlibPath: string;

  constructor() {
    this.#stdlibPath = this.#findStdlibPath();
  }

  #findStdlibPath(): string {
    const pkgPath = fileURLToPath(import.meta.resolve('@zena-lang/stdlib'));
    return join(dirname(pkgPath), 'zena');
  }

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) {
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
