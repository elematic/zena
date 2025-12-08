import {
  NodeType,
  type Identifier,
  type Program,
  type Statement,
  type VariableDeclaration,
  type ClassDeclaration,
  type Node,
  type ImportDeclaration,
  type ExportAllDeclaration,
  type MethodDefinition,
  type FieldDefinition,
  type AccessorDeclaration,
  type MemberExpression,
  type MethodSignature,
  type Parameter,
  type MatchCase,
  type Pattern,
} from './ast.js';
import type {Module} from './compiler.js';

export class Bundler {
  #modules: Module[];
  #entryPoint: Module;
  #modulePrefixes = new Map<string, string>();

  /**
   * Maps a fully qualified symbol name (e.g. "path/to/module.zena:ClassName")
   * to its unique bundled name (e.g. "m1_ClassName").
   *
   * Key format: `${modulePath}:${symbolName}`
   * Value: The unique identifier used in the bundled output.
   */
  #globalSymbols = new Map<string, string>();

  /**
   * Maps prelude export names (e.g. "console", "Box") to their unique bundled name.
   */
  #preludeSymbols = new Map<string, string>();

  constructor(modules: Module[], entryPoint: Module) {
    this.#modules = modules;
    this.#entryPoint = entryPoint;
  }

  bundle(): Program {
    this.#sortModules();

    // 1. Assign prefixes
    let counter = 0;
    for (const module of this.#modules) {
      this.#modulePrefixes.set(module.path, `m${counter++}_`);
    }

    // 2. Collect global symbols (top-level declarations)
    for (const module of this.#modules) {
      this.#collectModuleSymbols(module);
    }

    // 3. Collect prelude symbols
    for (const module of this.#modules) {
      if (module.path.startsWith('zena:')) {
        for (const [key] of module.exports) {
          // key is like "value:console" or "type:Box"
          const name = key.split(':')[1];
          const globalKey = `${module.path}:${name}`;
          if (this.#globalSymbols.has(globalKey)) {
            const bundledName = this.#globalSymbols.get(globalKey)!;
            if (!this.#preludeSymbols.has(name)) {
              this.#preludeSymbols.set(name, bundledName);
            }
          }
        }
      }
    }

    // 4. Rewrite ASTs
    const newBody: Statement[] = [];
    for (const module of this.#modules) {
      const rewrittenStatements = this.#rewriteModule(module);
      newBody.push(...rewrittenStatements);
    }

    const wellKnownTypes: Program['wellKnownTypes'] = {};

    if (this.#globalSymbols.has('zena:array:FixedArray')) {
      const name = this.#globalSymbols.get('zena:array:FixedArray')!;
      const decl = newBody.find(
        (stmt): stmt is ClassDeclaration =>
          stmt.type === NodeType.ClassDeclaration && stmt.name.name === name,
      );
      if (decl) wellKnownTypes.FixedArray = decl;
    }

    if (!wellKnownTypes.FixedArray && !this.#entryPoint.isStdlib) {
      throw new Error(
        'Missing well-known type: FixedArray. The standard library module "zena:array" is required for user modules.',
      );
    }

    if (this.#globalSymbols.has('zena:string:String')) {
      const name = this.#globalSymbols.get('zena:string:String')!;
      const decl = newBody.find(
        (stmt): stmt is ClassDeclaration =>
          stmt.type === NodeType.ClassDeclaration && stmt.name.name === name,
      );
      if (decl) wellKnownTypes.String = decl;
    }

    if (!wellKnownTypes.String && !this.#entryPoint.isStdlib) {
      throw new Error(
        'Missing well-known type: String. The standard library module "zena:string" is required for user modules.',
      );
    }

    if (this.#globalSymbols.has('zena:box:Box')) {
      const name = this.#globalSymbols.get('zena:box:Box')!;
      const decl = newBody.find(
        (stmt): stmt is ClassDeclaration =>
          stmt.type === NodeType.ClassDeclaration && stmt.name.name === name,
      );
      if (decl) wellKnownTypes.Box = decl;
    }

    const symbolMap = new Map<string, string>();
    for (const [key, value] of this.#globalSymbols) {
      const name = key.split(':').pop()!;
      symbolMap.set(name, value);
    }

    return {
      type: NodeType.Program,
      body: newBody,
      wellKnownTypes,
      symbolMap,
    };
  }

  /**
   * Topologically sorts modules based on their import dependencies.
   * This ensures that a module is processed (and its symbols declared)
   * only after all its dependencies have been processed.
   * This is critical for the Type Checker, which expects symbols to be
   * declared before they are used in the bundled output.
   */
  #sortModules() {
    const visited = new Set<string>();
    const sorted: Module[] = [];
    const moduleMap = new Map(this.#modules.map((m) => [m.path, m]));

    const visit = (module: Module, stack: Set<string>) => {
      if (visited.has(module.path)) return;
      if (stack.has(module.path)) return; // Cycle detected, ignore

      stack.add(module.path);

      // Visit dependencies
      for (const importedPath of module.imports.values()) {
        const importedModule = moduleMap.get(importedPath);
        if (importedModule) {
          visit(importedModule, stack);
        }
      }

      stack.delete(module.path);
      visited.add(module.path);
      sorted.push(module);
    };

    // First pass: Visit standard library modules (zena:*)
    // This ensures they appear before user code in the bundle,
    // which is required because user code implicitly depends on them (prelude).
    for (const module of this.#modules) {
      if (module.path.startsWith('zena:')) {
        visit(module, new Set());
      }
    }

    // Second pass: Visit remaining modules
    for (const module of this.#modules) {
      visit(module, new Set());
    }

    this.#modules = sorted;
  }

  #collectModuleSymbols(module: Module) {
    const prefix = this.#modulePrefixes.get(module.path)!;
    const isEntry = module === this.#entryPoint;

    for (const stmt of module.ast.body) {
      let name: string | undefined;
      if (stmt.type === NodeType.VariableDeclaration) {
        if (stmt.pattern.type === NodeType.Identifier) {
          name = stmt.pattern.name;
        } else {
          throw new Error(
            'Destructuring not implemented in Bundler symbol collection',
          );
        }
      } else if (
        stmt.type === NodeType.ClassDeclaration ||
        stmt.type === NodeType.InterfaceDeclaration ||
        stmt.type === NodeType.MixinDeclaration ||
        stmt.type === NodeType.DeclareFunction ||
        stmt.type === NodeType.TypeAliasDeclaration ||
        stmt.type === NodeType.EnumDeclaration
      ) {
        name = (stmt as any).name.name;
      }

      if (name) {
        const uniqueName = prefix + name;
        const key = `${module.path}:${name}`;
        this.#globalSymbols.set(key, uniqueName);

        // Rename the type object if it exists AND it's a type declaration
        if (
          stmt.type === NodeType.ClassDeclaration ||
          stmt.type === NodeType.InterfaceDeclaration ||
          stmt.type === NodeType.MixinDeclaration ||
          stmt.type === NodeType.TypeAliasDeclaration
        ) {
          const cls = stmt as any;
          let typeObj = cls.inferredType;
          if (!typeObj && cls.name && cls.name.inferredType) {
            typeObj = cls.name.inferredType;
          }

          if (typeObj?.name) {
            typeObj.name = uniqueName;
          }
        }

        // Handle exports
        if ('exported' in stmt && (stmt as any).exported) {
          if (isEntry) {
            (stmt as any).exportName = name;
          } else {
            (stmt as any).exported = false;
          }
        }
      } else if (stmt.type === NodeType.ExportAllDeclaration) {
        const decl = stmt as ExportAllDeclaration;
        const specifier = decl.moduleSpecifier.value;
        const resolvedPath = module.imports.get(specifier);
        if (resolvedPath) {
          // Since modules are sorted topologically, the imported module
          // should have already been processed and its symbols collected.
          const prefix = `${resolvedPath}:`;
          for (const [key, uniqueName] of this.#globalSymbols) {
            if (key.startsWith(prefix)) {
              const name = key.slice(prefix.length);
              // Register alias for re-export
              this.#globalSymbols.set(`${module.path}:${name}`, uniqueName);
            }
          }
        }
      }
    }
  }

  #rewriteModule(module: Module): Statement[] {
    const statements: Statement[] = [];

    // Build import map for this module: localName -> uniqueName
    const importMap = new Map<string, string>();
    for (const stmt of module.ast.body) {
      if (stmt.type === NodeType.ImportDeclaration) {
        const decl = stmt as ImportDeclaration;
        const specifier = decl.moduleSpecifier.value;
        const resolvedPath = module.imports.get(specifier);
        if (resolvedPath) {
          for (const imp of decl.imports) {
            const importedName = imp.imported.name;
            const localName = imp.local.name;
            const key = `${resolvedPath}:${importedName}`;
            const uniqueName = this.#globalSymbols.get(key);
            if (uniqueName) {
              importMap.set(localName, uniqueName);
            }
          }
        }
      }
    }

    // We need a proper visitor that tracks scope.
    // For simplicity, let's assume we clone the AST nodes to avoid mutating the original module AST
    // (though for now mutating might be acceptable if we don't reuse modules).

    // Let's iterate top-level statements and rewrite them.
    for (const stmt of module.ast.body) {
      if (
        stmt.type === NodeType.ImportDeclaration ||
        stmt.type === NodeType.ExportAllDeclaration
      )
        continue; // Skip imports/exports in output

      // Deep clone statement to avoid side effects?
      // We MUST use a custom clone function because JSON.stringify destroys
      // the 'inferredType' objects (which contain Maps and circular references).
      const clonedStmt = cloneAST(stmt);

      this.#rewriteStatement(clonedStmt, module, importMap, new Set());
      statements.push(clonedStmt);
    }

    return statements;
  }

  #rewriteStatement(
    stmt: Statement,
    module: Module,
    importMap: Map<string, string>,
    localScope: Set<string>,
  ) {
    // Handle declarations that introduce locals
    if (stmt.type === NodeType.VariableDeclaration) {
      // If this is top-level, we rename the identifier definition
      // But we are inside #rewriteModule loop, so these ARE top-level.
      // Wait, #rewriteStatement is recursive.
      // If we are at top level (how do we know?), we rename to unique name.
      // If we are in a block, we add to localScope.
    }

    // This recursive rewriter needs to be smarter.
    // Let's implement a visitor pattern.

    new ASTRewriter(
      module,
      this.#modulePrefixes.get(module.path)!,
      this.#globalSymbols,
      this.#preludeSymbols,
      importMap,
    ).visit(stmt);
  }
}

class ASTRewriter {
  module: Module;
  prefix: string;
  globalSymbols: Map<string, string>;
  preludeSymbols: Map<string, string>;
  importMap: Map<string, string>;
  scopeStack: Set<string>[] = [];

  constructor(
    module: Module,
    prefix: string,
    globalSymbols: Map<string, string>,
    preludeSymbols: Map<string, string>,
    importMap: Map<string, string>,
  ) {
    this.module = module;
    this.prefix = prefix;
    this.globalSymbols = globalSymbols;
    this.preludeSymbols = preludeSymbols;
    this.importMap = importMap;
    this.scopeStack.push(new Set()); // Top-level scope (but we don't add top-level decls here, we rename them)
  }

  visit(node: Node) {
    if (!node) return;

    switch (node.type) {
      case NodeType.VariableDeclaration:
        this.visitVariableDeclaration(node as VariableDeclaration);
        break;
      case NodeType.Identifier:
        this.visitIdentifier(node as Identifier);
        break;
      case NodeType.Parameter:
        this.visitParameter(node as Parameter);
        break;
      case NodeType.BlockStatement:
        this.enterScope();
        (node as any).body.forEach((s: any) => this.visit(s));
        this.exitScope();
        break;
      case NodeType.FunctionExpression:
      case NodeType.DeclareFunction: // DeclareFunction usually doesn't have body, but params introduce scope
        if (
          node.type === NodeType.DeclareFunction &&
          this.scopeStack.length === 1
        ) {
          (node as any).name.name = this.prefix + (node as any).name.name;
        }
        this.enterScope();
        // Visit params
        const func = node as any;
        if (func.typeParameters) {
          func.typeParameters.forEach((t: any) => this.visit(t));
        }
        func.params.forEach((p: any) => this.visit(p));
        if (func.returnType) this.visit(func.returnType);
        if (func.body) {
          if (Array.isArray(func.body)) {
            func.body.forEach((s: any) => this.visit(s));
          } else {
            this.visit(func.body);
          }
        }
        this.exitScope();
        break;
      case NodeType.TypeAnnotation: {
        const typeNode = node as any;
        const typeName = typeNode.name;
        // Check imports
        if (this.importMap.has(typeName)) {
          typeNode.name = this.importMap.get(typeName)!;
        } else {
          // Check global symbols of this module
          const key = `${this.module.path}:${typeName}`;
          if (this.globalSymbols.has(key)) {
            typeNode.name = this.globalSymbols.get(key)!;
          } else if (this.preludeSymbols.has(typeName)) {
            typeNode.name = this.preludeSymbols.get(typeName)!;
          }
        }
        // Visit type arguments
        if (typeNode.typeArguments) {
          typeNode.typeArguments.forEach((t: any) => this.visit(t));
        }
        break;
      }
      case NodeType.ClassDeclaration:
        // Rename class
        if (this.scopeStack.length === 1) {
          (node as any).name.name = this.prefix + (node as any).name.name;
        }
        this.enterScope();
        // Visit super class
        if ((node as any).superClass) {
          this.visit((node as any).superClass);
        }
        // Visit implements
        if ((node as any).implements) {
          (node as any).implements.forEach((i: any) => this.visit(i));
        }
        // Visit mixins
        if ((node as any).mixins) {
          (node as any).mixins.forEach((m: any) => this.visit(m));
        }
        // Visit members
        (node as any).body.forEach((m: any) => this.visit(m));
        this.exitScope();
        break;
      case NodeType.MixinDeclaration:
        // Rename mixin
        if (this.scopeStack.length === 1) {
          (node as any).name.name = this.prefix + (node as any).name.name;
        }
        this.enterScope();
        // Visit on type
        if ((node as any).on) {
          this.visit((node as any).on);
        }
        // Visit mixins
        if ((node as any).mixins) {
          (node as any).mixins.forEach((m: any) => this.visit(m));
        }
        // Visit members
        (node as any).body.forEach((m: any) => this.visit(m));
        this.exitScope();
        break;
      case NodeType.InterfaceDeclaration:
        // Rename interface
        if (this.scopeStack.length === 1) {
          (node as any).name.name = this.prefix + (node as any).name.name;
        }
        this.enterScope();
        // Visit extends
        if ((node as any).extends) {
          (node as any).extends.forEach((e: any) => this.visit(e));
        }
        // Visit members
        (node as any).body.forEach((m: any) => this.visit(m));
        this.exitScope();
        break;
      case NodeType.MethodDefinition:
        this.visitMethodDefinition(node as MethodDefinition);
        break;
      case NodeType.FieldDefinition:
        this.visitFieldDefinition(node as FieldDefinition);
        break;
      case NodeType.AccessorDeclaration:
        this.visitAccessorDeclaration(node as AccessorDeclaration);
        break;
      case NodeType.MemberExpression:
        this.visitMemberExpression(node as MemberExpression);
        break;
      case NodeType.MethodSignature:
        this.visitMethodSignature(node as MethodSignature);
        break;
      case NodeType.MatchCase:
        this.visitMatchCase(node as MatchCase);
        break;
      // ... handle other nodes
      default:
        // Generic traversal
        for (const key in node) {
          const val = (node as any)[key];
          if (Array.isArray(val)) {
            val.forEach((v: any) => {
              if (v && typeof v === 'object' && 'type' in v) {
                this.visit(v);
              }
            });
          } else if (val && typeof val === 'object' && 'type' in val) {
            this.visit(val);
          }
        }
    }
  }

  visitVariableDeclaration(node: VariableDeclaration) {
    // If we are at top level (scopeStack.length === 1), rename definition
    if (node.pattern.type === NodeType.Identifier) {
      if (this.scopeStack.length === 1) {
        const oldName = node.pattern.name;
        const newName = this.prefix + oldName;
        node.pattern.name = newName;
        // Don't add to scope, because we renamed it.
      } else {
        // Local variable
        this.addToScope(node.pattern.name);
      }
    } else {
      throw new Error('Destructuring not implemented in Bundler');
    }

    if (node.typeAnnotation) {
      this.visit(node.typeAnnotation);
    }

    // Visit init
    this.visit(node.init);
  }

  visitParameter(node: Parameter) {
    // 1. Add to scope
    this.addToScope(node.name.name);

    // 2. Visit type annotation
    if (node.typeAnnotation) {
      this.visit(node.typeAnnotation);
    }

    // 3. Do NOT visit node.name as an Identifier expression
  }

  visitIdentifier(node: Identifier) {
    // This is a usage (or definition, but definitions usually handled by parent)
    // Wait, visitVariableDeclaration handles definition.
    // But what about `x = 1` (Assignment)? `x` is Identifier.

    const name = node.name;

    // 1. Check local scope
    if (this.isLocal(name)) {
      return; // It's local, don't rename
    }

    // 2. Check imports
    if (this.importMap.has(name)) {
      node.name = this.importMap.get(name)!;
      return;
    }

    // 3. Check top-level declarations of THIS module
    // We need to know if `name` is a top-level symbol of this module.
    // We can check globalSymbols.
    const key = `${this.module.path}:${name}`;
    if (this.globalSymbols.has(key)) {
      node.name = this.globalSymbols.get(key)!;
      return;
    }

    // 4. Check prelude symbols
    if (this.preludeSymbols.has(name)) {
      node.name = this.preludeSymbols.get(name)!;
    }
  }

  enterScope() {
    this.scopeStack.push(new Set());
  }

  exitScope() {
    this.scopeStack.pop();
  }

  addToScope(name: string) {
    this.scopeStack[this.scopeStack.length - 1].add(name);
  }

  isLocal(name: string): boolean {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].has(name)) return true;
    }
    return false;
  }

  visitMethodDefinition(node: MethodDefinition) {
    // Do NOT visit node.name (it's a property name)
    this.enterScope();
    node.params.forEach((p) => this.visit(p));
    if (node.returnType) this.visit(node.returnType);
    if (node.body) this.visit(node.body);
    if (node.decorators) node.decorators.forEach((d) => this.visit(d));
    this.exitScope();
  }

  visitFieldDefinition(node: FieldDefinition) {
    // Do NOT visit node.name
    if (node.typeAnnotation) this.visit(node.typeAnnotation);
    if (node.value) this.visit(node.value);
    if (node.decorators) node.decorators.forEach((d) => this.visit(d));
  }

  visitAccessorDeclaration(node: AccessorDeclaration) {
    // Do NOT visit node.name
    if (node.typeAnnotation) this.visit(node.typeAnnotation);
    if (node.getter) {
      this.enterScope();
      node.getter.body.forEach((s) => this.visit(s));
      this.exitScope();
    }
    if (node.setter) {
      this.enterScope();
      this.visit(node.setter.param);
      node.setter.body.body.forEach((s) => this.visit(s));
      this.exitScope();
    }
  }

  visitMemberExpression(node: MemberExpression) {
    this.visit(node.object);
    // Do NOT visit node.property as it is a property name, not a variable reference
  }

  visitMethodSignature(node: MethodSignature) {
    // Do NOT visit node.name
    this.enterScope();
    node.params.forEach((p) => this.visit(p));
    if (node.returnType) this.visit(node.returnType);
    this.exitScope();
  }

  visitMatchCase(node: MatchCase) {
    this.enterScope();
    this.visitPattern(node.pattern);
    if (node.guard) this.visit(node.guard);
    this.visit(node.body);
    this.exitScope();
  }

  visitPattern(node: Pattern) {
    switch (node.type) {
      case NodeType.Identifier:
        if (node.name !== '_') {
          this.addToScope(node.name);
        }
        break;
      case NodeType.AsPattern:
        this.addToScope(node.name.name);
        this.visitPattern(node.pattern);
        break;
      case NodeType.ClassPattern:
        // Visit class name (it refers to a class, so it should be renamed)
        this.visit(node.name);
        // Visit properties
        node.properties.forEach((p) => {
          // p.name is property name, DO NOT VISIT
          this.visitPattern(p.value as Pattern);
        });
        break;
      case NodeType.RecordPattern:
        node.properties.forEach((p) => {
          // p.name is property name, DO NOT VISIT
          this.visitPattern(p.value);
        });
        break;
      case NodeType.TuplePattern:
        node.elements.forEach((e) => {
          if (e) this.visitPattern(e);
        });
        break;
      case NodeType.LogicalPattern:
        this.visitPattern(node.left);
        this.visitPattern(node.right);
        break;
      // Literals don't bind variables
    }
  }
}

function cloneAST<T extends Node>(node: T): T {
  if (!node) return node;
  if (Array.isArray(node)) {
    return (node as any[]).map((n) => cloneAST(n)) as any;
  }
  if (typeof node !== 'object') return node;

  // Shallow copy
  const clone = {...node} as T;

  // Recursively clone children
  for (const key in clone) {
    if (
      key === 'inferredType' ||
      key === 'inferredTypeArguments' ||
      key === 'loc'
    ) {
      // Preserve these references
      continue;
    }
    const value = (clone as any)[key];
    if (Array.isArray(value)) {
      (clone as any)[key] = value.map((v: any) => {
        if (v && typeof v === 'object' && 'type' in v) {
          return cloneAST(v);
        }
        return v;
      });
    } else if (value && typeof value === 'object' && 'type' in value) {
      (clone as any)[key] = cloneAST(value);
    }
  }
  return clone;
}
