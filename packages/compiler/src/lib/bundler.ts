import {
  NodeType,
  type Identifier,
  type Program,
  type Statement,
  type VariableDeclaration,
  type ClassDeclaration,
  type Node,
  type ImportDeclaration,
  type InterfaceDeclaration,
} from './ast.js';
import type {Module} from './compiler.js';

export class Bundler {
  #modules: Module[];
  #entryPoint: Module;
  #modulePrefixes = new Map<string, string>();
  #globalSymbols = new Map<string, string>(); // key: "path:name", value: uniqueName

  constructor(modules: Module[], entryPoint: Module) {
    this.#modules = modules;
    this.#entryPoint = entryPoint;
  }

  bundle(): Program {
    // 1. Assign prefixes
    let counter = 0;
    for (const module of this.#modules) {
      this.#modulePrefixes.set(module.path, `m${counter++}_`);
    }

    // 2. Collect global symbols (top-level declarations)
    for (const module of this.#modules) {
      this.#collectModuleSymbols(module);
    }

    // 3. Rewrite ASTs
    const newBody: Statement[] = [];
    for (const module of this.#modules) {
      const rewrittenStatements = this.#rewriteModule(module);
      newBody.push(...rewrittenStatements);
    }

    const wellKnownTypes: Program['wellKnownTypes'] = {};
    if (this.#globalSymbols.has('zena:array:Array')) {
      wellKnownTypes.Array = this.#globalSymbols.get('zena:array:Array');
    }
    if (this.#globalSymbols.has('zena:string:String')) {
      wellKnownTypes.String = this.#globalSymbols.get('zena:string:String');
    }
    // ByteArray is usually internal or in zena:string?
    // Let's check where ByteArray is defined.
    // It seems it is built-in type in CodegenContext, but maybe exposed via stdlib?
    // In map_test.ts mock host: 'export final class String { bytes: ByteArray; length: i32; }'
    // So ByteArray is used as a type name.
    // But is it a class?
    // In classes.ts: if (annotation.name === 'ByteArray') ...
    // It seems ByteArray is a special type name that maps to WASM array<i8>.
    // It might not be a class in stdlib.
    
    return {
      type: NodeType.Program,
      body: newBody,
      wellKnownTypes,
    };
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
        stmt.type === NodeType.DeclareFunction
      ) {
        name = (stmt as any).name.name;
      }

      if (name) {
        const uniqueName = prefix + name;
        const key = `${module.path}:${name}`;
        this.#globalSymbols.set(key, uniqueName);

        // Handle exports
        if ('exported' in stmt && (stmt as any).exported) {
          if (isEntry) {
            (stmt as any).exportName = name;
          } else {
            (stmt as any).exported = false;
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
      if (stmt.type === NodeType.ImportDeclaration) continue; // Skip imports in output

      // Deep clone statement to avoid side effects?
      // const clonedStmt = JSON.parse(JSON.stringify(stmt));
      // JSON clone breaks undefined/circular, but AST is a tree.
      // It's slow but safe for prototype.
      const clonedStmt = JSON.parse(JSON.stringify(stmt));

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
      importMap,
    ).visit(stmt);
  }
}

class ASTRewriter {
  module: Module;
  prefix: string;
  globalSymbols: Map<string, string>;
  importMap: Map<string, string>;
  scopeStack: Set<string>[] = [];

  constructor(
    module: Module,
    prefix: string,
    globalSymbols: Map<string, string>,
    importMap: Map<string, string>,
  ) {
    this.module = module;
    this.prefix = prefix;
    this.globalSymbols = globalSymbols;
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
        if (func.params) {
          func.params.forEach((p: any) => {
            this.addToScope(p.name.name);
            if (p.typeAnnotation) this.visit(p.typeAnnotation);
          });
        }
        if (func.returnType) this.visit(func.returnType);
        if (func.body) {
          // FunctionExpression has body (BlockStatement)
          // BlockStatement will enter another scope?
          // Usually function body IS the scope.
          // Let's handle body manually to avoid double scope.
          if (func.body.type === NodeType.BlockStatement) {
            func.body.body.forEach((s: any) => this.visit(s));
          } else {
            this.visit(func.body);
          }
        }
        this.exitScope();
        break;
      case NodeType.ClassDeclaration:
        const cls = node as ClassDeclaration;
        if (this.scopeStack.length === 1) {
          cls.name.name = this.prefix + cls.name.name;
        }

        if (cls.superClass) this.visitIdentifier(cls.superClass);
        if (cls.mixins) cls.mixins.forEach((m) => this.visitIdentifier(m));
        if (cls.implements) cls.implements.forEach((i) => this.visit(i));
        if (cls.typeParameters)
          cls.typeParameters.forEach((t) => this.visit(t));

        // We need to visit members but NOT rename member names (properties).
        // But we need to visit values (initializers, method bodies).
        cls.body.forEach((member) => {
          if (member.type === NodeType.FieldDefinition) {
            if (member.value) this.visit(member.value);
            if (member.typeAnnotation) this.visit(member.typeAnnotation);
          } else if (member.type === NodeType.MethodDefinition) {
            this.enterScope();
            member.params.forEach((p) => {
              this.addToScope(p.name.name);
              if (p.typeAnnotation) this.visit(p.typeAnnotation);
            });
            if (member.returnType) this.visit(member.returnType);
            if (member.body) {
              member.body.body.forEach((s) => this.visit(s));
            }
            this.exitScope();
          } else if (member.type === NodeType.AccessorDeclaration) {
            if (member.typeAnnotation) this.visit(member.typeAnnotation);
            if (member.getter) {
              this.enterScope();
              member.getter.body.forEach((s) => this.visit(s));
              this.exitScope();
            }
            if (member.setter) {
              this.enterScope();
              this.addToScope(member.setter.param.name);
              member.setter.body.body.forEach((s) => this.visit(s));
              this.exitScope();
            }
          }
        });
        break;

      case NodeType.InterfaceDeclaration: {
        const iface = node as InterfaceDeclaration;
        if (this.scopeStack.length === 1) {
          iface.name.name = this.prefix + iface.name.name;
        }
        if (iface.typeParameters)
          iface.typeParameters.forEach((t: any) => this.visit(t));
        if (iface.extends) iface.extends.forEach((e: any) => this.visit(e));

        iface.body.forEach((member: any) => {
          if (member.type === NodeType.MethodSignature) {
            this.enterScope();
            member.params.forEach((p: any) => {
              this.addToScope(p.name.name);
              if (p.typeAnnotation) this.visit(p.typeAnnotation);
            });
            if (member.returnType) this.visit(member.returnType);
            this.exitScope();
          } else if (member.type === NodeType.FieldDefinition) {
            if (member.typeAnnotation) this.visit(member.typeAnnotation);
          }
        });
        break;
      }

      case NodeType.TypeAnnotation: {
        const typeAnn = node as any;
        const name = typeAnn.name;
        if (!this.isLocal(name)) {
          if (this.importMap.has(name)) {
            typeAnn.name = this.importMap.get(name)!;
          } else {
            const key = `${this.module.path}:${name}`;
            if (this.globalSymbols.has(key)) {
              typeAnn.name = this.globalSymbols.get(key)!;
            }
          }
        }
        if (typeAnn.typeArguments) {
          typeAnn.typeArguments.forEach((t: any) => this.visit(t));
        }
        break;
      }

      case NodeType.UnionTypeAnnotation: {
        const union = node as any;
        if (union.types) {
          union.types.forEach((t: any) => this.visit(t));
        }
        break;
      }

      case NodeType.MixinDeclaration: {
        const mixin = node as any;
        if (this.scopeStack.length === 1) {
          mixin.name.name = this.prefix + mixin.name.name;
        }
        if (mixin.typeParameters)
          mixin.typeParameters.forEach((t: any) => this.visit(t));
        if (mixin.on) this.visitIdentifier(mixin.on);
        if (mixin.mixins)
          mixin.mixins.forEach((m: any) => this.visitIdentifier(m));

        mixin.body.forEach((member: any) => {
          if (member.type === NodeType.FieldDefinition) {
            if (member.value) this.visit(member.value);
            if (member.typeAnnotation) this.visit(member.typeAnnotation);
          } else if (member.type === NodeType.MethodDefinition) {
            this.enterScope();
            member.params.forEach((p: any) => {
              this.addToScope(p.name.name);
              if (p.typeAnnotation) this.visit(p.typeAnnotation);
            });
            if (member.returnType) this.visit(member.returnType);
            if (member.body) {
              member.body.body.forEach((s: any) => this.visit(s));
            }
            this.exitScope();
          } else if (member.type === NodeType.AccessorDeclaration) {
            if (member.typeAnnotation) this.visit(member.typeAnnotation);
            if (member.getter) {
              this.enterScope();
              member.getter.body.forEach((s: any) => this.visit(s));
              this.exitScope();
            }
            if (member.setter) {
              this.enterScope();
              this.addToScope(member.setter.param.name);
              member.setter.body.body.forEach((s: any) => this.visit(s));
              this.exitScope();
            }
          }
        });
        break;
      }

      // ... handle other nodes recursively
      default:
        // Generic traversal for other properties
        Object.keys(node).forEach((key) => {
          const val = (node as any)[key];
          if (Array.isArray(val)) {
            val.forEach((v) => {
              if (v && typeof v === 'object' && v.type) this.visit(v);
            });
          } else if (val && typeof val === 'object' && val.type) {
            this.visit(val);
          }
        });
    }
  }

  visitVariableDeclaration(decl: VariableDeclaration) {
    // If we are at top level (scopeStack.length === 1), rename definition
    if (decl.pattern.type === NodeType.Identifier) {
      if (this.scopeStack.length === 1) {
        const oldName = decl.pattern.name;
        const newName = this.prefix + oldName;
        decl.pattern.name = newName;
        // Don't add to scope, because we renamed it.
      } else {
        // Local variable
        this.addToScope(decl.pattern.name);
      }
    } else {
      throw new Error('Destructuring not implemented in Bundler');
    }

    if (decl.typeAnnotation) {
      this.visit(decl.typeAnnotation);
    }

    // Visit init
    this.visit(decl.init);
  }

  visitIdentifier(id: Identifier) {
    // This is a usage (or definition, but definitions usually handled by parent)
    // Wait, visitVariableDeclaration handles definition.
    // But what about `x = 1` (Assignment)? `x` is Identifier.

    const name = id.name;

    // 1. Check local scope
    if (this.isLocal(name)) {
      return; // It's local, don't rename
    }

    // 2. Check imports
    if (this.importMap.has(name)) {
      id.name = this.importMap.get(name)!;
      return;
    }

    // 3. Check top-level declarations of THIS module
    // We need to know if `name` is a top-level symbol of this module.
    // We can check globalSymbols.
    const key = `${this.module.path}:${name}`;
    if (this.globalSymbols.has(key)) {
      id.name = this.globalSymbols.get(key)!;
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
    // Check all scopes except the first one (which is top-level, and we renamed those)
    // Wait, if we renamed top-level, then `name` won't match?
    // If I defined `let x = 1` at top level, it became `m1_x`.
    // If I use `x` later, `visitIdentifier` sees `x`.
    // `isLocal` checks scopes.
    // Top-level scope in `scopeStack` is empty/unused for decls.

    for (let i = this.scopeStack.length - 1; i > 0; i--) {
      if (this.scopeStack[i].has(name)) return true;
    }
    return false;
  }
}
