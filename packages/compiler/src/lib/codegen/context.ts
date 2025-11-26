import {
  type Program,
  type ClassDeclaration,
  type FunctionExpression,
  type TypeAnnotation,
} from '../ast.js';
import {WasmModule} from '../emitter.js';
import {ValType} from '../wasm.js';
import type {ClassInfo, InterfaceInfo, LocalInfo} from './types.js';

export class CodegenContext {
  public module: WasmModule;
  public program: Program;

  // Symbol tables
  public scopes: Map<string, LocalInfo>[] = [];
  public extraLocals: number[][] = [];
  public nextLocalIndex = 0;
  public functions = new Map<string, number>();
  public classes = new Map<string, ClassInfo>();
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
  public genericClasses = new Map<string, ClassDeclaration>();
  public genericFunctions = new Map<string, FunctionExpression>();
  public functionReturnTypes = new Map<string, number[]>();
  public pendingMethodGenerations: (() => void)[] = [];
  public bodyGenerators: (() => void)[] = [];

  constructor(program: Program) {
    this.program = program;
    this.module = new WasmModule();
    // Define backing array type: array<i8> (mutable for construction)
    this.byteArrayTypeIndex = this.module.addArrayType([ValType.i8], true);
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
}
