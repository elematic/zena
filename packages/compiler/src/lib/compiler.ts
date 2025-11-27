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

export interface Module {
  path: string;
  source: string;
  ast: Program;
  imports: Map<string, string>; // specifier -> resolvedPath
  exports: Map<string, SymbolInfo>; // exported name -> symbol info
  diagnostics: Diagnostic[];
}

export class Compiler {
  #host: CompilerHost;
  #modules = new Map<string, Module>();

  constructor(host: CompilerHost) {
    this.#host = host;
  }

  public getModule(path: string): Module | undefined {
    return this.#modules.get(path);
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

  #loadModule(path: string): Module {
    if (this.#modules.has(path)) {
      return this.#modules.get(path)!;
    }

    const source = this.#host.load(path);
    const parser = new Parser(source);
    const ast = parser.parse();

    const module: Module = {
      path,
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
      if (stmt.type === NodeType.ImportDeclaration) {
        const specifier = stmt.moduleSpecifier.value;
        const resolvedPath = this.#host.resolve(specifier, module.path);
        module.imports.set(specifier, resolvedPath);

        // Recursively load imported module
        this.#loadModule(resolvedPath);
      }
    }
  }

  #checkModules() {
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

      const checker = new TypeChecker(module.ast, this, module);
      module.diagnostics = checker.check();

      checking.delete(module.path);
      checked.add(module.path);
    };

    for (const module of this.#modules.values()) {
      checkModule(module);
    }
  }
}
