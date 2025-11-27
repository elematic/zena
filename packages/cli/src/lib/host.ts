import {type CompilerHost, stdlib} from '@zena-lang/compiler';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';

export class NodeCompilerHost implements CompilerHost {
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
      if (name in stdlib) {
        return (stdlib as any)[name];
      }
      throw new Error(`Standard library module not found: ${path}`);
    }

    if (!existsSync(path)) {
      throw new Error(`File not found: ${path}`);
    }
    return readFileSync(path, 'utf-8');
  }
}
