import {
  NodeType,
  type ClassDeclaration,
  type DeclareFunction,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MixinDeclaration,
  type Program,
  type VariableDeclaration,
} from '../ast.js';
import {registerClass, registerInterface} from './classes.js';
import {CodegenContext} from './context.js';
import {registerDeclaredFunction, registerFunction} from './functions.js';
import {generateExpression, inferType} from './expressions.js';
import {HeapType, Opcode, ValType, SectionId} from '../wasm.js';
import {WasmModule} from '../emitter.js';

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

    const globalInitializers: {index: number; init: any}[] = [];

    // Pass 0: Register imports (DeclareFunction)
    // Imports must be registered before defined functions to ensure correct index space.
    for (const statement of program.body) {
      if (statement.type === NodeType.DeclareFunction) {
        registerDeclaredFunction(this.#ctx, statement as DeclareFunction);
      }
    }

    // 1. Register all classes and interfaces (First pass)
    for (const statement of program.body) {
      // console.log('Statement type:', statement.type);
      if (statement.type === NodeType.ClassDeclaration) {
        // console.log('Registering class:', (statement as any).name.name);
        if ((statement as ClassDeclaration).name.name === 'Array') {
          continue;
        }
        registerClass(this.#ctx, statement as ClassDeclaration);
      } else if (statement.type === NodeType.MixinDeclaration) {
        const mixinDecl = statement as MixinDeclaration;
        this.#ctx.mixins.set(mixinDecl.name.name, mixinDecl);
      } else if (statement.type === NodeType.InterfaceDeclaration) {
        registerInterface(this.#ctx, statement as InterfaceDeclaration);
      } else if (statement.type === NodeType.DeclareFunction) {
        // Already handled in Pass 0
        continue;
      } else if (statement.type === NodeType.VariableDeclaration) {
        const varDecl = statement as VariableDeclaration;
        if (varDecl.init.type === NodeType.FunctionExpression) {
          registerFunction(
            this.#ctx,
            varDecl.identifier.name,
            varDecl.init as FunctionExpression,
            varDecl.exported,
          );
        } else {
          // Global variable
          const type = inferType(this.#ctx, varDecl.init);
          let initBytes: number[] = [];

          // Default initialization
          if (type[0] === ValType.i32)
            initBytes = [0x41, 0x00, 0x0b]; // i32.const 0
          else if (type[0] === ValType.f32)
            initBytes = [0x43, 0x00, 0x00, 0x00, 0x00, 0x0b]; // f32.const 0
          else if (type[0] === ValType.ref_null || type[0] === ValType.ref) {
            initBytes = [Opcode.ref_null, HeapType.none, 0x0b];
          } else {
            // Default to i32 0 if unknown (e.g. boolean)
            initBytes = [0x41, 0x00, 0x0b];
          }

          const globalIndex = this.#ctx.module.addGlobal(type, true, initBytes);
          this.#ctx.defineGlobal(varDecl.identifier.name, globalIndex, type);
          globalInitializers.push({index: globalIndex, init: varDecl.init});
        }
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

    // Generate start function
    if (globalInitializers.length > 0) {
      const typeIndex = this.#ctx.module.addType([], []);
      const funcIndex = this.#ctx.module.addFunction(typeIndex);

      const body: number[] = [];
      this.#ctx.pushScope(); // Global scope?
      this.#ctx.nextLocalIndex = 0;
      this.#ctx.extraLocals = [];

      for (const {index, init} of globalInitializers) {
        generateExpression(this.#ctx, init, body);
        body.push(Opcode.global_set);
        body.push(...WasmModule.encodeSignedLEB128(index));
      }
      body.push(Opcode.end);

      this.#ctx.module.addCode(funcIndex, this.#ctx.extraLocals, body);
      this.#ctx.module.setStart(funcIndex);
      this.#ctx.popScope();
    }

    return this.#ctx.module.toBytes();
  }
}
