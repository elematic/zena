import {
  NodeType,
  type ClassDeclaration,
  type DeclareFunction,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MixinDeclaration,
  type Program,
  type TypeAliasDeclaration,
  type VariableDeclaration,
} from '../ast.js';
import {registerClass, registerInterface} from './classes.js';
import {CodegenContext} from './context.js';
import {registerDeclaredFunction, registerFunction} from './functions.js';
import {
  generateExpression,
  generateStringGetByteFunction,
  inferType,
} from './expressions.js';
import {HeapType, Opcode, ValType, ExportDesc} from '../wasm.js';
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

    // 1. Register Interfaces and Mixins (First pass)
    for (const statement of program.body) {
      if (statement.type === NodeType.InterfaceDeclaration) {
        registerInterface(this.#ctx, statement as InterfaceDeclaration);
      } else if (statement.type === NodeType.MixinDeclaration) {
        const mixinDecl = statement as MixinDeclaration;
        this.#ctx.mixins.set(mixinDecl.name.name, mixinDecl);
      } else if (statement.type === NodeType.TypeAliasDeclaration) {
        const aliasDecl = statement as TypeAliasDeclaration;
        this.#ctx.typeAliases.set(
          aliasDecl.name.name,
          aliasDecl.typeAnnotation,
        );
      }
    }

    // 2. Register Classes (Second pass)
    for (const statement of program.body) {
      if (statement.type === NodeType.ClassDeclaration) {
        if ((statement as ClassDeclaration).name.name === 'Array') {
          continue;
        }
        registerClass(this.#ctx, statement as ClassDeclaration);
      }
    }

    // 3. Register Functions and Variables (Third pass)
    for (const statement of program.body) {
      if (statement.type === NodeType.VariableDeclaration) {
        const varDecl = statement as VariableDeclaration;
        if (varDecl.pattern.type === NodeType.Identifier) {
          const name = varDecl.pattern.name;
          if (varDecl.init.type === NodeType.FunctionExpression) {
            registerFunction(
              this.#ctx,
              name,
              varDecl.init as FunctionExpression,
              varDecl.exported,
              (varDecl as any).exportName,
            );
          } else {
            // Global variable
            const type = inferType(this.#ctx, varDecl.init);
            let initBytes: number[] = [];

            // Default initialization
            // Note: Do NOT include the 0x0b end opcode here - addGlobal adds it
            if (type[0] === ValType.i32)
              initBytes = [0x41, 0x00]; // i32.const 0
            else if (type[0] === ValType.f32)
              initBytes = [0x43, 0x00, 0x00, 0x00, 0x00]; // f32.const 0
            else if (type[0] === ValType.ref_null || type[0] === ValType.ref) {
              initBytes = [Opcode.ref_null, HeapType.none];
            } else {
              // Default to i32 0 if unknown (e.g. boolean)
              initBytes = [0x41, 0x00];
            }

            const globalIndex = this.#ctx.module.addGlobal(
              type,
              true,
              initBytes,
            );
            this.#ctx.defineGlobal(name, globalIndex, type);
            globalInitializers.push({index: globalIndex, init: varDecl.init});

            if (varDecl.exported) {
              const exportName = (varDecl as any).exportName || name;
              this.#ctx.module.addExport(
                exportName,
                ExportDesc.Global,
                globalIndex,
              );
            }
          }
        }
      }
    }

    // Pass 2: Generate bodies
    // Execute deferred body generators
    for (const generator of this.#ctx.bodyGenerators) {
      generator();
    }

    // Generate pending helper functions (concat, strEq, etc.)
    // Use while/shift to handle any functions that add more pending functions
    while (this.#ctx.pendingHelperFunctions.length > 0) {
      const gen = this.#ctx.pendingHelperFunctions.shift()!;
      gen();
    }

    // Generate the $stringGetByte export for JS interop
    // This allows JavaScript to read bytes from Zena strings via the exported getter
    // Required for the V8-recommended pattern of reading WASM GC arrays from JS
    if (this.#ctx.stringTypeIndex >= 0) {
      generateStringGetByteFunction(this.#ctx);
      // Execute any newly added pending helper functions
      while (this.#ctx.pendingHelperFunctions.length > 0) {
        const gen = this.#ctx.pendingHelperFunctions.shift()!;
        gen();
      }
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
