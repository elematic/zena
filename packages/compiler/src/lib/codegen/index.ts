import {
  NodeType,
  type ClassDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MixinDeclaration,
  type Program,
} from '../ast.js';
import {registerClass, registerInterface} from './classes.js';
import {CodegenContext} from './context.js';
import {registerFunction} from './functions.js';

/**
 * The CodeGenerator class is responsible for traversing the AST and generating
 * WebAssembly (WASM) binary code.
 *
 * It manages:
 * - The WASM module structure (types, functions, exports, etc.)
 * - Symbol tables for variables and functions.
 * - Class and Interface layouts (structs and vtables).
 * - String and Array memory management.
 *
 * The generation process is typically:
 * 1. Register all classes and interfaces (to handle forward references).
 * 2. Generate method bodies and function bodies.
 * 3. Emit the final WASM binary.
 */
export class CodeGenerator {
  #ctx: CodegenContext;

  constructor(program: Program) {
    this.#ctx = new CodegenContext(program);
  }

  /**
   * Main entry point for code generation.
   * @returns The generated WASM binary as a Uint8Array.
   */
  public generate(): Uint8Array {
    const {program} = this.#ctx;

    // 1. Register all classes and interfaces (First pass)
    for (const statement of program.body) {
      // console.log('Statement type:', statement.type);
      if (statement.type === NodeType.ClassDeclaration) {
        // console.log('Registering class:', (statement as any).name.name);
        registerClass(this.#ctx, statement as ClassDeclaration);
      } else if (statement.type === NodeType.MixinDeclaration) {
        const mixinDecl = statement as MixinDeclaration;
        this.#ctx.mixins.set(mixinDecl.name.name, mixinDecl);
      } else if (statement.type === NodeType.InterfaceDeclaration) {
        registerInterface(this.#ctx, statement as InterfaceDeclaration);
      } else if (
        statement.type === NodeType.VariableDeclaration &&
        statement.init.type === NodeType.FunctionExpression
      ) {
        registerFunction(
          this.#ctx,
          statement.identifier.name,
          statement.init as FunctionExpression,
          statement.exported,
        );
      }
    }

    // Pass 2: Generate bodies
    // Execute deferred body generators
    for (const generator of this.#ctx.bodyGenerators) {
      generator();
    }

    // Generate pending helper functions (concat, strEq)
    // Note: These might add more pending functions, so we iterate until empty?
    // But currently they don't add more.
    for (const generator of this.#ctx.pendingHelperFunctions) {
      generator();
    }

    return this.#ctx.module.toBytes();
  }
}
