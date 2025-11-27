import {type CompilerHost} from '@zena-lang/compiler';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

export class NodeCompilerHost implements CompilerHost {
  #stdlibPath: string;

  constructor() {
    this.#stdlibPath = this.#findStdlibPath();
  }

  #findStdlibPath(): string {
    try {
      // Try to resolve the compiler package
      const pkgPath = require.resolve('@zena-lang/compiler/package.json');
      return join(dirname(pkgPath), 'stdlib');
    } catch {
      // Fallback: assume we are in the monorepo
      const currentDir = dirname(fileURLToPath(import.meta.url));
      // packages/cli/lib/host.js -> ../../compiler/stdlib
      return resolve(currentDir, '../../compiler/stdlib');
    }
  }

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) {
      const name = specifier.substring(5); // remove 'zena:'
      return join(this.#stdlibPath, `${name}.zena`);
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
    if (!existsSync(path)) {
      throw new Error(`File not found: ${path}`);
    }
    return readFileSync(path, 'utf-8');
  }
}
