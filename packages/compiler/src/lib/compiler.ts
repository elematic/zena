import {
  NodeType,
  type Module,
  type Program,
  type ImportDeclaration,
} from './ast.js';
import {Parser} from './parser.js';
import {prelude} from './prelude.js';
import {CheckerContext} from './checker/context.js';
import {TypeChecker} from './checker/index.js';
import {LibraryLoader, type LibraryRecord} from './loader/index.js';
import type {Target} from './types.js';

export interface CompilerHost {
  resolve(specifier: string, referrer: string): string;
  load(path: string): string;
}

export interface CompilerOptions {
  /** Paths that should be treated as stdlib (enabling intrinsics) */
  stdlibPaths?: string[];
  /** Compilation target: 'host' (default) or 'wasi' */
  target?: Target;
}

export class Compiler {
  #host: CompilerHost;
  #loader: LibraryLoader;
  #modules = new Map<string, Module>();
  #preludeModules: Module[] = [];
  #preludeLoaded = false;
  #entryPoint?: string;

  /**
   * Tracks which modules have been type-checked.
   * Persists across multiple compile() calls to avoid double type-checking.
   */
  #checkedModules = new Set<string>();

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

  /**
   * Get the semantic context populated during type checking.
   * This contains resolved bindings that can be used by codegen.
   */
  public get semanticContext() {
    return this.#checkerContext.semanticContext;
  }

  /**
   * Get the checker context for type operations.
   * This provides access to type interning and instantiation utilities
   * needed by codegen for identity-based type lookups.
   */
  public get checkerContext() {
    return this.#checkerContext;
  }

  public compile(entryPoint: string): Module[] {
    this.#entryPoint = entryPoint;

    // Load entry point and all dependencies via LibraryLoader
    this.#loader.load(entryPoint);

    // Populate Module metadata from LibraryRecords
    for (const lib of this.#loader.libraries()) {
      if (!this.#modules.has(lib.path)) {
        this.#modules.set(lib.path, this.#getModule(lib));
      }
    }

    this.#checkModules();
    return Array.from(this.#modules.values());
  }

  /**
   * Get the compiled program with all modules and entry point.
   * Must be called after compile().
   */
  public getProgram(): Program {
    if (!this.#entryPoint) {
      throw new Error('Must call compile() before getProgram()');
    }
    return {
      modules: this.#modules,
      entryPoint: this.#entryPoint,
      preludeModules: this.#preludeModules,
    };
  }

  /**
   * Get the Module from a LibraryRecord.
   * The Module already has all metadata set by the parser.
   */
  #getModule(lib: LibraryRecord): Module {
    return lib.ast;
  }

  #loadPrelude() {
    if (this.#preludeLoaded) return;
    this.#preludeLoaded = true;

    const parser = new Parser(prelude, {path: 'zena:prelude', isStdlib: true});
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
            this.#modules.set(lib.path, this.#getModule(lib));
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

    const checking = new Set<string>();

    const checkModule = (module: Module) => {
      if (
        this.#checkedModules.has(module.path!) ||
        checking.has(module.path!)
      ) {
        return;
      }

      checking.add(module.path!);

      // Check dependencies first
      for (const importPath of module.imports!.values()) {
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
      if (!module.isStdlib && !module.path!.startsWith('zena:')) {
        this.#injectPreludeImports(module, checker.usedPreludeSymbols);
      }

      checking.delete(module.path!);
      this.#checkedModules.add(module.path!);
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
      module.imports!.set(modulePath, modulePath);

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

    module.body.unshift(...newImports);
  }
}
