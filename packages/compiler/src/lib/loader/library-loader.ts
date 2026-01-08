/**
 * LibraryLoader - Manages library resolution, loading, and caching for the Zena compiler.
 *
 * In Zena, individual .zena files are called "libraries" (not "modules") to avoid
 * confusion with WASM modules. WASM modules are separate compilation units, while
 * Zena libraries are source files that get bundled together.
 *
 * The LibraryLoader uses a `CompilerHost` for actual file system access. The host
 * abstraction (not the loader) is what enables different environments:
 * - File system loading (Node.js)
 * - Virtual file systems (testing, in-browser)
 * - Network loading (future)
 *
 * ## Design Notes
 *
 * ### Library Identity
 *
 * Each library is uniquely identified by its canonical path (e.g., "zena:string",
 * "/path/to/file.zena"). The loader guarantees that:
 * 1. The same specifier from the same referrer always resolves to the same path
 * 2. Loading the same path always returns the same LibraryRecord
 *
 * This enables identity-based type checking where types from the same library
 * source are compared by identity, not by name.
 *
 * ### Relationship to Bundler
 *
 * Currently, the Bundler renames all symbols to avoid collisions (e.g.,
 * `Array` → `m3_Array`). After Round 2 refactoring, the LibraryLoader will
 * maintain library identity without renaming, and the checker will use
 * library-qualified names internally.
 *
 * @see docs/design/compiler-refactoring.md
 */

import type {Program} from '../ast.js';
import type {Diagnostic} from '../diagnostics.js';
import {Parser} from '../parser.js';
import type {CompilerHost} from '../compiler.js';

/**
 * A loaded library with its parsed AST and metadata.
 *
 * LibraryRecords are cached by the loader - requesting the same path twice
 * returns the same LibraryRecord instance.
 */
export interface LibraryRecord {
  /** Canonical path identifying this library (e.g., "zena:string", "/abs/path.zena") */
  readonly path: string;

  /** Whether this library is part of the standard library */
  readonly isStdlib: boolean;

  /** The original source code */
  readonly source: string;

  /** Parsed AST */
  readonly ast: Program;

  /**
   * Resolved import mappings.
   * Key: import specifier as written in source (e.g., "./utils", "zena:string")
   * Value: canonical resolved path
   */
  readonly imports: ReadonlyMap<string, string>;

  /** Diagnostics from parsing (not type-checking) */
  readonly parseDiagnostics: readonly Diagnostic[];
}

/**
 * Result of topologically sorting libraries by their dependencies.
 */
export interface LibraryGraph {
  /** Libraries in topological order (dependencies before dependents) */
  readonly libraries: readonly LibraryRecord[];

  /** True if a cycle was detected (libraries still returned, but order is best-effort) */
  readonly hasCycle: boolean;

  /** Libraries involved in cycles, if any */
  readonly cycleLibraries: readonly LibraryRecord[];
}

/**
 * Options for the library loader.
 */
export interface LibraryLoaderOptions {
  /** Paths that should be treated as stdlib */
  stdlibPaths?: string[];
}

/**
 * Loads, parses, and caches Zena libraries.
 *
 * The LibraryLoader is responsible for:
 * - Loading library source code (via CompilerHost)
 * - Parsing source into ASTs
 * - Caching loaded libraries by path (ensuring identity)
 * - Recursively loading dependencies
 *
 * Use `computeLibraryGraph()` to get libraries in topological order.
 */
export class LibraryLoader {
  readonly #host: CompilerHost;
  readonly #cache = new Map<string, LibraryRecord>();
  readonly #stdlibPaths: Set<string>;

  constructor(host: CompilerHost, options: LibraryLoaderOptions = {}) {
    this.#host = host;
    this.#stdlibPaths = new Set(options.stdlibPaths ?? []);
  }

  /** Resolve an import specifier to a canonical library path. */
  resolve(specifier: string, referrer: string): string {
    return this.#host.resolve(specifier, referrer);
  }

  /**
   * Load a library by its canonical path.
   *
   * If the library has already been loaded, returns the cached LibraryRecord.
   * Otherwise, loads the source, parses it, and caches the result.
   */
  load(path: string): LibraryRecord {
    const existing = this.#cache.get(path);
    if (existing) {
      return existing;
    }

    const isStdlib = path.startsWith('zena:') || this.#stdlibPaths.has(path);

    const source = this.#host.load(path);
    const parser = new Parser(source);
    const ast = parser.parse();

    const imports = new Map<string, string>();

    // Create record first (with empty imports) and add to cache
    // This prevents infinite recursion on circular imports
    const record: LibraryRecord = {
      path,
      isStdlib,
      source,
      ast,
      imports,
      parseDiagnostics: [],
    };

    this.#cache.set(path, record);

    // Now analyze and load imports (record is already in cache)
    for (const stmt of ast.body) {
      if (
        stmt.type === 'ImportDeclaration' ||
        stmt.type === 'ExportAllDeclaration'
      ) {
        const specifier = (stmt as any).moduleSpecifier.value;
        const resolvedPath = this.resolve(specifier, path);
        imports.set(specifier, resolvedPath);

        // Recursively load dependencies (safe - we're already in cache)
        this.load(resolvedPath);
      }
    }

    return record;
  }

  /** Check if a library has already been loaded. */
  has(path: string): boolean {
    return this.#cache.has(path);
  }

  /** Get a previously loaded library without triggering a load. */
  get(path: string): LibraryRecord | undefined {
    return this.#cache.get(path);
  }

  /** Get all loaded libraries. */
  libraries(): IterableIterator<LibraryRecord> {
    return this.#cache.values();
  }

  /**
   * Compute the topological order of libraries starting from an entry point.
   */
  computeGraph(entryLibrary: LibraryRecord): LibraryGraph {
    const visited = new Set<string>();
    const stack = new Set<string>();
    const sorted: LibraryRecord[] = [];
    const cycleLibraries: LibraryRecord[] = [];
    let hasCycle = false;

    const visit = (lib: LibraryRecord): void => {
      if (visited.has(lib.path)) return;

      if (stack.has(lib.path)) {
        // Cycle detected
        hasCycle = true;
        cycleLibraries.push(lib);
        return;
      }

      stack.add(lib.path);

      // Visit dependencies first
      for (const importPath of lib.imports.values()) {
        const imported = this.get(importPath);
        if (imported) {
          visit(imported);
        }
      }

      stack.delete(lib.path);
      visited.add(lib.path);
      sorted.push(lib);
    };

    visit(entryLibrary);

    return {
      libraries: sorted,
      hasCycle,
      cycleLibraries,
    };
  }
}
