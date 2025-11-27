import {NodeType, type Program, type ImportDeclaration} from './ast.js';
import {Parser} from './parser.js';
import {prelude} from './prelude.js';

export interface CompilerHost {
  resolve(specifier: string, referrer: string): string;
  load(path: string): string;
}

export interface Module {
  path: string;
  source: string;
  ast: Program;
  imports: Map<string, string>; // specifier -> resolvedPath
  exports: Set<string>; // exported names
}

export class Compiler {
  #host: CompilerHost;
  #modules = new Map<string, Module>();

  constructor(host: CompilerHost) {
    this.#host = host;
  }

  public compile(entryPoint: string): Module[] {
    this.#loadModule(entryPoint);
    return Array.from(this.#modules.values());
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
      exports: new Set(),
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
}
