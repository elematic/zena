import {type CompilerHost, type Target} from '@zena-lang/compiler';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {
  resolveStdlibModule,
  loadStdlibModule,
  isInternalModule,
} from '@zena-lang/stdlib';

export interface PackageConfigEntry {
  root: string;
  exports?: Record<string, {virtual?: Record<string, string>}>;
  internal?: string[];
}

export interface PackageMap {
  packages: Record<string, string | PackageConfigEntry>;
}

export class NodeCompilerHost implements CompilerHost {
  #virtualFiles: Map<string, string> = new Map();
  #target: Target;
  #packageMap: Map<string, string>;

  constructor(
    target: Target = 'host',
    packageMap?: PackageMap,
    packageMapDir?: string,
  ) {
    this.#target = target;
    this.#packageMap = new Map();
    if (packageMap) {
      const base = packageMapDir ?? process.cwd();
      for (const [name, value] of Object.entries(packageMap.packages)) {
        const dir = typeof value === 'string' ? value : value.root;
        this.#packageMap.set(name, resolve(base, dir));
      }
    }
  }

  /**
   * Register a virtual file that exists only in memory.
   * This is used for generated wrapper files.
   */
  registerVirtualFile(path: string, content: string): void {
    this.#virtualFiles.set(path, content);
  }

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const dir = dirname(referrer);
      return resolve(dir, specifier);
    }

    // package:path format — split on first colon
    const colonIndex = specifier.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(
        `Cannot resolve specifier: ${specifier} (expected package:path format)`,
      );
    }

    const packageName = specifier.substring(0, colonIndex);
    const subpath = specifier.substring(colonIndex + 1) || null;

    // stdlib — 'zena' is a reserved package name
    if (packageName === 'zena') {
      const name = subpath!;
      if (isInternalModule(name)) {
        if (!referrer.startsWith('zena:')) {
          throw new Error(`Cannot import internal module: ${specifier}`);
        }
        return specifier;
      }
      const resolved = resolveStdlibModule(name, this.#target);
      if (!resolved) {
        throw new Error(`Unknown stdlib module: ${specifier}`);
      }
      return `zena:${resolved}`;
    }

    // User package — resolve via package map
    const packageDir = this.#packageMap.get(packageName);
    if (packageDir) {
      const file = subpath ? `${subpath}.zena` : 'index.zena';
      return resolve(packageDir, file);
    }

    throw new Error(
      `Cannot resolve specifier: ${specifier} (unknown package '${packageName}')`,
    );
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

  /**
   * Load a package map from a zena-packages.json file.
   * Returns undefined if the file doesn't exist.
   */
  static loadPackageMap(
    filePath: string,
  ): {map: PackageMap; dir: string} | undefined {
    if (!existsSync(filePath)) return undefined;
    const content = readFileSync(filePath, 'utf-8');
    const map = JSON.parse(content) as PackageMap;
    return {map, dir: dirname(filePath)};
  }
}
