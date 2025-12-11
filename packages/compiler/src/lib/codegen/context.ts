import {
  NodeType,
  type ClassDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MethodDefinition,
  type MixinDeclaration,
  type Node,
  type Program,
  type TaggedTemplateExpression,
  type TypeAnnotation,
} from '../ast.js';
import {
  DiagnosticBag,
  DiagnosticCode,
  type DiagnosticLocation,
} from '../diagnostics.js';
import {WasmModule} from '../emitter.js';
import {ValType} from '../wasm.js';
import type {ClassInfo, InterfaceInfo, LocalInfo} from './types.js';

export class CodegenContext {
  public module: WasmModule;
  public program: Program;
  public diagnostics = new DiagnosticBag();

  /** File name used for diagnostic locations */
  public fileName = '<anonymous>';

  // Symbol tables
  public scopes: Map<string, LocalInfo>[] = [];
  public extraLocals: number[][] = [];
  public nextLocalIndex = 0;
  public functions = new Map<string, number>();
  public functionOverloads = new Map<
    string,
    {index: number; params: number[][]}[]
  >();
  public classes = new Map<string, ClassInfo>();
  public mixins = new Map<string, MixinDeclaration>();
  public interfaces = new Map<string, InterfaceInfo>();
  public typeAliases = new Map<string, TypeAnnotation>();

  // Exception handling
  public exceptionTagIndex = -1;

  // Current state
  public currentClass: ClassInfo | null = null;
  public currentTypeContext: Map<string, TypeAnnotation> | undefined;
  public currentReturnType: number[] | undefined;
  public thisLocalIndex = 0;

  // Type management
  public fixedArrayTypes = new Map<string, number>(); // elementTypeString -> typeIndex
  public stringTypeIndex = -1;
  public byteArrayTypeIndex = -1;
  public stringLiterals = new Map<string, number>(); // content -> dataIndex

  // Deferred generation
  public pendingHelperFunctions: (() => void)[] = [];
  public concatFunctionIndex = -1;
  public strEqFunctionIndex = -1;
  public stringHashFunctionIndex = -1;
  public byteArrayGetFunctionIndex = -1; // Exported helper for JS to read ByteArray
  public stringGetByteFunctionIndex = -1; // Exported helper for JS to read String bytes
  public genericClasses = new Map<string, ClassDeclaration>();
  public genericInterfaces = new Map<string, InterfaceDeclaration>();
  public genericFunctions = new Map<string, FunctionExpression>();
  public genericMethods = new Map<string, MethodDefinition>();
  public instantiatedInterfaces = new Map<string, InterfaceDeclaration>();
  public functionReturnTypes = new Map<string, number[]>();
  public pendingMethodGenerations: (() => void)[] = [];
  public bodyGenerators: (() => void)[] = [];
  public syntheticClasses: ClassDeclaration[] = [];
  public isGeneratingBodies = false;

  // Global variables
  public globals = new Map<string, {index: number; type: number[]}>();
  public globalIntrinsics = new Map<string, string>();

  // Well-known types (renamed)
  public wellKnownTypes: {
    FixedArray?: ClassDeclaration;
    String?: ClassDeclaration;
    Box?: ClassDeclaration;
    TemplateStringsArray?: ClassDeclaration;
  } = {};

  // Records and Tuples
  public recordTypes = new Map<string, number>(); // canonicalKey -> typeIndex
  public tupleTypes = new Map<string, number>(); // canonicalKey -> typeIndex
  public closureTypes = new Map<string, number>(); // signature -> structTypeIndex
  public closureStructs = new Map<number, {funcTypeIndex: number}>(); // structTypeIndex -> info

  // Template Literals
  public templateLiteralGlobals = new Map<TaggedTemplateExpression, number>();

  constructor(program: Program) {
    this.program = program;
    if (program.wellKnownTypes) {
      this.wellKnownTypes = program.wellKnownTypes;
    }
    this.module = new WasmModule();
    // Define backing array type: array<i8> (mutable for construction)
    this.byteArrayTypeIndex = this.module.addArrayType([ValType.i8], true);

    // Pre-initialize String struct type so that declared functions can use string params.
    // The String class definition in the prelude will reuse this type index.
    // String is now an extension class on ByteArray, so it shares the same type index.
    this.stringTypeIndex = this.byteArrayTypeIndex;
  }

  public pushScope() {
    this.scopes.push(new Map());
  }

  public popScope() {
    this.scopes.pop();
  }

  public defineLocal(name: string, index: number, type: number[]) {
    this.scopes[this.scopes.length - 1].set(name, {index, type});
  }

  public getLocal(name: string): LocalInfo | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) {
        return this.scopes[i].get(name);
      }
    }
    return undefined;
  }

  public declareLocal(name: string, type: number[] = [ValType.i32]): number {
    const index = this.nextLocalIndex++;
    this.scopes[this.scopes.length - 1].set(name, {index, type});
    this.extraLocals.push(type);
    return index;
  }

  public getFixedArrayTypeIndex(elementType: number[]): number {
    const key = elementType.join(',');
    if (this.fixedArrayTypes.has(key)) {
      return this.fixedArrayTypes.get(key)!;
    }
    const index = this.module.addArrayType(elementType, true);
    this.fixedArrayTypes.set(key, index);
    return index;
  }

  public defineGlobal(name: string, index: number, type: number[]) {
    this.globals.set(name, {index, type});
  }

  public getGlobal(name: string): {index: number; type: number[]} | undefined {
    return this.globals.get(name);
  }

  public getRecordTypeIndex(fields: {name: string; type: number[]}[]): number {
    // Sort fields by name to canonicalize
    const sortedFields = [...fields].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const key = sortedFields
      .map((f) => `${f.name}:${f.type.join(',')}`)
      .join(';');

    if (this.recordTypes.has(key)) {
      return this.recordTypes.get(key)!;
    }

    // Create struct type
    // (struct (field $name type) ...)
    const structFields = sortedFields.map((f) => ({
      type: f.type,
      mutable: false, // Shallowly immutable
    }));

    const index = this.module.addStructType(structFields);
    this.recordTypes.set(key, index);
    return index;
  }

  public getTupleTypeIndex(types: number[][]): number {
    const key = types.map((t) => t.join(',')).join(';');

    if (this.tupleTypes.has(key)) {
      return this.tupleTypes.get(key)!;
    }

    // Create struct type
    // (struct (field type) ...)
    const structFields = types.map((t) => ({
      type: t,
      mutable: false, // Shallowly immutable
    }));

    const index = this.module.addStructType(structFields);
    this.tupleTypes.set(key, index);
    return index;
  }

  public getClosureTypeIndex(
    paramTypes: number[][],
    returnType: number[],
  ): number {
    const key = `(${paramTypes.map((t) => t.join(',')).join(',')})=>${returnType.join(',')}`;

    if (this.closureTypes.has(key)) {
      return this.closureTypes.get(key)!;
    }

    // 1. Define the implementation signature type: (ctx: eqref, ...params) -> returnType
    // We don't need to store this type index globally, just use it for the field.
    // Actually, we need to add it to the module types.
    const implParams = [[ValType.eqref], ...paramTypes];
    const implResults = returnType.length > 0 ? [returnType] : [];
    const implTypeIndex = this.module.addType(implParams, implResults);

    // 2. Define the closure struct type: (struct (field $func (ref $impl)) (field $ctx (ref eq)))
    const structFields = [
      {
        type: [ValType.ref, ...WasmModule.encodeSignedLEB128(implTypeIndex)],
        mutable: false,
      }, // func
      {type: [ValType.eqref], mutable: false}, // ctx
    ];

    const index = this.module.addStructType(structFields);
    this.closureTypes.set(key, index);
    this.closureStructs.set(index, {funcTypeIndex: implTypeIndex});
    return index;
  }

  public isFixedArrayType(type: TypeAnnotation): boolean {
    if (type.type !== NodeType.TypeAnnotation) return false;
    return (
      !!this.wellKnownTypes.FixedArray &&
      (type as any).name === this.wellKnownTypes.FixedArray.name.name
    );
  }

  public isStringType(type: TypeAnnotation): boolean {
    if (type.type !== NodeType.TypeAnnotation) return false;
    return (
      !!this.wellKnownTypes.String &&
      (type as any).name === this.wellKnownTypes.String.name.name
    );
  }

  /**
   * Create a DiagnosticLocation from an AST node's source location.
   */
  public locationFromNode(node: Node): DiagnosticLocation | undefined {
    if (!node.loc) return undefined;
    return {
      file: this.fileName,
      start: node.loc.start,
      length: node.loc.end - node.loc.start,
      line: node.loc.line,
      column: node.loc.column,
    };
  }

  /**
   * Report an error diagnostic, optionally with location from an AST node.
   */
  public reportError(message: string, code: DiagnosticCode, node?: Node): void {
    this.diagnostics.reportError(
      message,
      code,
      node ? this.locationFromNode(node) : undefined,
    );
  }

  /**
   * Report an internal compiler error. This should be used for unexpected
   * states that indicate a bug in the compiler.
   */
  public reportInternalError(message: string, node?: Node): void {
    this.reportError(
      `Internal Compiler Error: ${message}`,
      DiagnosticCode.InternalCompilerError,
      node,
    );
  }
}
