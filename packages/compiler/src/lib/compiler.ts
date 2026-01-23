import {NodeType, type Program, type ImportDeclaration} from './ast.js';
import {Parser} from './parser.js';
import {prelude} from './prelude.js';
import {CheckerContext, type SymbolInfo} from './checker/context.js';
import {TypeChecker} from './checker/index.js';
import type {Diagnostic} from './diagnostics.js';
import {Bundler} from './bundler.js';
import {LibraryLoader, type LibraryRecord} from './loader/index.js';

export interface CompilerHost {
  resolve(specifier: string, referrer: string): string;
  load(path: string): string;
}

export interface CompilerOptions {
  /** Paths that should be treated as stdlib (enabling intrinsics) */
  stdlibPaths?: string[];
}

/**
 * A module with type-checking results.
 *
 * Extends LibraryRecord with checker-populated fields (exports, diagnostics).
 */
export interface Module {
  path: string;
  isStdlib: boolean;
  source: string;
  ast: Program;
  imports: Map<string, string>; // specifier -> resolvedPath
  exports: Map<string, SymbolInfo>; // exported name -> symbol info (populated by checker)
  diagnostics: Diagnostic[]; // type-checking diagnostics (populated by checker)
}

export class Compiler {
  #host: CompilerHost;
  #loader: LibraryLoader;
  #modules = new Map<string, Module>();
  #preludeModules: Module[] = [];
  #preludeLoaded = false;

  /**
   * Shared checker context for the entire compilation.
   * This ensures type interning is global across all modules,
   * enabling identity-based type comparisons.
   */
  #checkerContext: CheckerContext;

  constructor(host: CompilerHost, options: CompilerOptions = {}) {
    this.#host = host;
    this.#loader = new LibraryLoader(host, {stdlibPaths: options.stdlibPaths});
    this.#checkerContext = new CheckerContext(this);
  }

  public getModule(path: string): Module | undefined {
    return this.#modules.get(path);
  }

  public get preludeModules(): Module[] {
    return this.#preludeModules;
  }

  public compile(entryPoint: string): Module[] {
    // Load entry point and all dependencies via LibraryLoader
    this.#loader.load(entryPoint);

    // Convert all loaded libraries to Modules
    for (const lib of this.#loader.libraries()) {
      if (!this.#modules.has(lib.path)) {
        this.#modules.set(lib.path, this.#libraryToModule(lib));
      }
    }

    this.#checkModules();
    return Array.from(this.#modules.values());
  }

  public bundle(entryPoint: string): Program {
    const modules = this.compile(entryPoint);
    const entryModule = this.#modules.get(entryPoint)!;
    const bundler = new Bundler(modules, entryModule);
    return bundler.bundle();
  }

  /**
   * Convert a LibraryRecord to a Module by adding checker-specific fields.
   */
  #libraryToModule(lib: LibraryRecord): Module {
    return {
      path: lib.path,
      isStdlib: lib.isStdlib,
      source: lib.source,
      ast: lib.ast,
      imports: new Map(lib.imports), // Convert ReadonlyMap to mutable Map
      exports: new Map(),
      diagnostics: [],
    };
  }

  #loadPrelude() {
    if (this.#preludeLoaded) return;
    this.#preludeLoaded = true;

    const parser = new Parser(prelude);
    const ast = parser.parse();

    for (const stmt of ast.body) {
      if (stmt.type === NodeType.ImportDeclaration) {
        const specifier = stmt.moduleSpecifier.value;
        // We assume prelude imports are zena: modules
        const resolved = this.#host.resolve(specifier, 'prelude');

        // Load via LibraryLoader (this loads transitive dependencies too)
        this.#loader.load(resolved);

        // Convert ALL loaded libraries to Modules (including transitive dependencies)
        for (const lib of this.#loader.libraries()) {
          if (!this.#modules.has(lib.path)) {
            this.#modules.set(lib.path, this.#libraryToModule(lib));
          }
        }

        const mod = this.#modules.get(resolved);
        if (mod) {
          this.#preludeModules.push(mod);
        }
      }
    }
  }

  #checkModules() {
    this.#loadPrelude();

    const checked = new Set<string>();
    const checking = new Set<string>();

    const checkModule = (module: Module) => {
      if (checked.has(module.path) || checking.has(module.path)) {
        return;
      }

      checking.add(module.path);

      // Check dependencies first
      for (const importPath of module.imports.values()) {
        const imported = this.#modules.get(importPath);
        if (imported) {
          checkModule(imported);
        }
      }

      // Ensure prelude modules are checked
      // If the current module is a prelude module, we only check prelude modules
      // that appear BEFORE it in the prelude list. This prevents circular dependencies
      // and enforces a topological order for the standard library.
      let preludeLimit = this.#preludeModules.length;
      const preludeIndex = this.#preludeModules.findIndex(
        (pm) => pm.path === module.path,
      );

      if (preludeIndex !== -1) {
        preludeLimit = preludeIndex;
      }

      for (let i = 0; i < preludeLimit; i++) {
        checkModule(this.#preludeModules[i]);
      }

      // Use shared checker context - TypeChecker will call setCurrentLibrary
      const checker = new TypeChecker(this.#checkerContext, module);
      checker.preludeModules = this.#preludeModules;
      module.diagnostics = checker.check();

      // Inject used prelude imports
      if (!module.isStdlib && !module.path.startsWith('zena:')) {
        this.#injectPreludeImports(module, checker.usedPreludeSymbols);
      }

      checking.delete(module.path);
      checked.add(module.path);
    };

    for (const module of this.#modules.values()) {
      checkModule(module);
    }
  }

  #injectPreludeImports(
    module: Module,
    usedSymbols: Map<string, {modulePath: string; exportName: string}>,
  ) {
    // Group by module path
    const importsByModule = new Map<string, Set<string>>();
    for (const {modulePath, exportName} of usedSymbols.values()) {
      if (!importsByModule.has(modulePath)) {
        importsByModule.set(modulePath, new Set());
      }
      importsByModule.get(modulePath)!.add(exportName);
    }

    // Generate ImportDeclarations
    const newImports: ImportDeclaration[] = [];
    for (const [modulePath, names] of importsByModule) {
      // Update module.imports so Bundler can resolve these
      module.imports.set(modulePath, modulePath);

      newImports.push({
        type: NodeType.ImportDeclaration,
        imports: Array.from(names).map((name) => ({
          type: NodeType.ImportSpecifier,
          local: {type: NodeType.Identifier, name},
          imported: {type: NodeType.Identifier, name},
        })),
        moduleSpecifier: {type: NodeType.StringLiteral, value: modulePath},
      } as ImportDeclaration);
    }

    module.ast.body.unshift(...newImports);
  }
}
