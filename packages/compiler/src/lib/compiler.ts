import {NodeType, type Program, type ImportDeclaration} from './ast.js';
import {Parser} from './parser.js';
import {prelude} from './prelude.js';
import type {SymbolInfo} from './checker/context.js';
import {TypeChecker} from './checker/index.js';
import type {Diagnostic} from './diagnostics.js';
import {Bundler} from './bundler.js';

export interface CompilerHost {
  resolve(specifier: string, referrer: string): string;
  load(path: string): string;
}

export interface CompilerOptions {
  /** Paths that should be treated as stdlib (enabling intrinsics) */
  stdlibPaths?: string[];
}

export interface Module {
  path: string;
  isStdlib: boolean;
  source: string;
  ast: Program;
  imports: Map<string, string>; // specifier -> resolvedPath
  exports: Map<string, SymbolInfo>; // exported name -> symbol info
  diagnostics: Diagnostic[];
}

export class Compiler {
  #host: CompilerHost;
  #options: CompilerOptions;
  #modules = new Map<string, Module>();
  #preludeModules: Module[] = [];
  #preludeLoaded = false;

  constructor(host: CompilerHost, options: CompilerOptions = {}) {
    this.#host = host;
    this.#options = options;
  }

  public getModule(path: string): Module | undefined {
    return this.#modules.get(path);
  }

  public get preludeModules(): Module[] {
    return this.#preludeModules;
  }

  public compile(entryPoint: string): Module[] {
    this.#loadModule(entryPoint);
    this.#checkModules();
    return Array.from(this.#modules.values());
  }

  public bundle(entryPoint: string): Program {
    const modules = this.compile(entryPoint);
    const entryModule = this.#modules.get(entryPoint)!;
    const bundler = new Bundler(modules, entryModule);
    return bundler.bundle();
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
        this.#loadModule(resolved, true);
        const mod = this.#modules.get(resolved);
        if (mod) {
          this.#preludeModules.push(mod);
        }
      }
    }
  }

  #loadModule(path: string, isStdlib = false): Module {
    if (this.#modules.has(path)) {
      return this.#modules.get(path)!;
    }

    if (path.startsWith('zena:')) {
      isStdlib = true;
    }

    // Check if path is in stdlibPaths option
    if (this.#options.stdlibPaths?.includes(path)) {
      isStdlib = true;
    }

    const source = this.#host.load(path);
    const parser = new Parser(source);
    const ast = parser.parse();

    const module: Module = {
      path,
      isStdlib,
      source,
      ast,
      imports: new Map(),
      exports: new Map(),
      diagnostics: [],
    };

    this.#modules.set(path, module);

    this.#analyzeImports(module);

    return module;
  }

  #analyzeImports(module: Module) {
    for (const stmt of module.ast.body) {
      if (
        stmt.type === NodeType.ImportDeclaration ||
        stmt.type === NodeType.ExportAllDeclaration
      ) {
        const specifier = stmt.moduleSpecifier.value;
        const resolvedPath = this.#host.resolve(specifier, module.path);

        const isImportStdlib =
          specifier.startsWith('zena:') ||
          (module.isStdlib && specifier.startsWith('.'));

        module.imports.set(specifier, resolvedPath);

        // Recursively load imported module
        this.#loadModule(resolvedPath, isImportStdlib);
      }
    }
  }

  #checkModules() {
    this.#loadPrelude();

    const checked = new Set<string>();
    const checking = new Set<string>();

    const checkModule = (module: Module) => {
      if (checked.has(module.path) || checking.has(module.path)) return;

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

      const checker = new TypeChecker(module.ast, this, module);
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
