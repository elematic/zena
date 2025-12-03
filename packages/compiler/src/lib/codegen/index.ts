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
import {
  registerClassStruct,
  registerClassMethods,
  registerInterface,
} from './classes.js';
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
   * Set the file name used for diagnostic locations.
   */
  public setFileName(fileName: string) {
    this.#ctx.fileName = fileName;
  }

  /**
   * Get the diagnostics reported during code generation.
   */
  public get diagnostics() {
    return this.#ctx.diagnostics;
  }

  /**
   * Main entry point for code generation.
   * @returns The generated WASM binary as a Uint8Array.
   */
  public generate(): Uint8Array {
    const {program} = this.#ctx;

    const globalInitializers: {index: number; init: any}[] = [];

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

    // 2. Register Class Structs (Second pass)
    // This ensures types are available for imports and other declarations
    for (const statement of program.body) {
      if (statement.type === NodeType.ClassDeclaration) {
        registerClassStruct(this.#ctx, statement as ClassDeclaration);
      }
    }

    // 3. Register Imports (DeclareFunction)
    // Imports must be registered before defined functions to ensure correct index space.
    for (const statement of program.body) {
      if (statement.type === NodeType.DeclareFunction) {
        registerDeclaredFunction(this.#ctx, statement as DeclareFunction);
      }
    }

    // 4. Register Class Methods (Fourth pass)
    // Execute pending method registrations (e.g. from mixins created in Pass 2)
    let pendingIndex = 0;
    while (pendingIndex < this.#ctx.pendingMethodGenerations.length) {
      const generator = this.#ctx.pendingMethodGenerations[pendingIndex++];
      generator();
    }

    // Register methods for synthetic classes (mixins)
    for (const decl of this.#ctx.syntheticClasses) {
      registerClassMethods(this.#ctx, decl);
    }

    for (const statement of program.body) {
      if (statement.type === NodeType.ClassDeclaration) {
        registerClassMethods(this.#ctx, statement as ClassDeclaration);
      }
    }

    // 5. Register Functions and Variables (Fifth pass)
    for (const statement of program.body) {
      if (statement.type === NodeType.ClassDeclaration) {
        const classDecl = statement as ClassDeclaration;
        for (const member of classDecl.body) {
          if (
            member.type === NodeType.FieldDefinition &&
            member.isStatic &&
            member.value
          ) {
            const name = `${classDecl.name.name}_${member.name.name}`;
            const type = inferType(this.#ctx, member.value);
            let initBytes: number[] = [];

            // Default initialization
            if (type[0] === ValType.i32)
              initBytes = [0x41, 0x00]; // i32.const 0
            else if (type[0] === ValType.f32)
              initBytes = [0x43, 0x00, 0x00, 0x00, 0x00]; // f32.const 0
            else if (type[0] === ValType.ref_null || type[0] === ValType.ref) {
              initBytes = [Opcode.ref_null, HeapType.none];
            } else {
              initBytes = [0x41, 0x00];
            }

            const globalIndex = this.#ctx.module.addGlobal(
              type,
              true, // Static fields are mutable
              initBytes,
            );
            this.#ctx.defineGlobal(name, globalIndex, type);
            globalInitializers.push({index: globalIndex, init: member.value});
          }
        }
      } else if (statement.type === NodeType.VariableDeclaration) {
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



    // Execute any pending method registrations added during Pass 5 (e.g. from type inference)
    while (pendingIndex < this.#ctx.pendingMethodGenerations.length) {
      const generator = this.#ctx.pendingMethodGenerations[pendingIndex++];
      generator();
    }

    // Pass 2: Generate bodies
    this.#ctx.isGeneratingBodies = true;

    // Execute deferred body generators
    // Use while loop to handle generators added during generation (e.g. by late instantiation)
    let bodyIndex = 0;
    while (bodyIndex < this.#ctx.bodyGenerators.length) {
      const generator = this.#ctx.bodyGenerators[bodyIndex++];
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

    // Execute any body generators added during start function generation (e.g. generic instantiation)
    while (bodyIndex < this.#ctx.bodyGenerators.length) {
      const generator = this.#ctx.bodyGenerators[bodyIndex++];
      generator();
    }

    return this.#ctx.module.toBytes();
  }
}
