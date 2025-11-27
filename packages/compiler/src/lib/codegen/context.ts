import {
  type Program,
  type ClassDeclaration,
  type FunctionExpression,
  type MixinDeclaration,
  type TypeAnnotation,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {ExportDesc, ValType} from '../wasm.js';
import type {ClassInfo, InterfaceInfo, LocalInfo} from './types.js';

export class CodegenContext {
  public module: WasmModule;
  public program: Program;

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

  // Current state
  public currentClass: ClassInfo | null = null;
  public currentTypeContext: Map<string, TypeAnnotation> | undefined;
  public thisLocalIndex = 0;

  // Type management
  public arrayTypes = new Map<string, number>(); // elementTypeString -> typeIndex
  public stringTypeIndex = -1;
  public byteArrayTypeIndex = -1;
  public stringLiterals = new Map<string, number>(); // content -> dataIndex

  // Deferred generation
  public pendingHelperFunctions: (() => void)[] = [];
  public concatFunctionIndex = -1;
  public strEqFunctionIndex = -1;
  public byteArrayGetFunctionIndex = -1; // Exported helper for JS to read ByteArray
  public stringGetByteFunctionIndex = -1; // Exported helper for JS to read String bytes
  public genericClasses = new Map<string, ClassDeclaration>();
  public genericFunctions = new Map<string, FunctionExpression>();
  public functionReturnTypes = new Map<string, number[]>();
  public pendingMethodGenerations: (() => void)[] = [];
  public bodyGenerators: (() => void)[] = [];

  // Global variables
  public globals = new Map<string, {index: number; type: number[]}>();

  constructor(program: Program) {
    this.program = program;
    this.module = new WasmModule();
    // Define backing array type: array<i8> (mutable for construction)
    this.byteArrayTypeIndex = this.module.addArrayType([ValType.i8], true);

    // Pre-initialize String struct type so that declared functions can use string params.
    // The String class definition in the prelude will reuse this type index.
    // String struct layout (must match registerClass for String):
    // - __vtable: eqref (root class vtable field)
    // - bytes: ByteArray (ref to byteArrayTypeIndex)
    // - length: i32
    this.stringTypeIndex = this.module.addStructType([
      {type: [ValType.eqref], mutable: true}, // __vtable
      {
        type: [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(this.byteArrayTypeIndex),
        ],
        mutable: true,
      }, // bytes: ByteArray
      {type: [ValType.i32], mutable: true}, // length: i32
    ]);
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

  public getArrayTypeIndex(elementType: number[]): number {
    const key = elementType.join(',');
    if (this.arrayTypes.has(key)) {
      return this.arrayTypes.get(key)!;
    }
    const index = this.module.addArrayType(elementType, true);
    this.arrayTypes.set(key, index);
    return index;
  }

  public defineGlobal(name: string, index: number, type: number[]) {
    this.globals.set(name, {index, type});
  }

  public getGlobal(name: string): {index: number; type: number[]} | undefined {
    return this.globals.get(name);
  }
}
