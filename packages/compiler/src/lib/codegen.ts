import {
  NodeType,
  type Program,
  type Statement,
  type Expression,
  type VariableDeclaration,
  type FunctionExpression,
  type BinaryExpression,
  type Identifier,
  type NumberLiteral,
} from './ast.js';
import {WasmModule} from './emitter.js';
import {ValType, Opcode, ExportDesc} from './wasm.js';

export class CodeGenerator {
  #module: WasmModule;
  #program: Program;
  #locals: Map<string, number> = new Map();

  constructor(program: Program) {
    this.#program = program;
    this.#module = new WasmModule();
  }

  public generate(): Uint8Array {
    for (const statement of this.#program.body) {
      this.#generateStatement(statement);
    }
    return this.#module.toBytes();
  }

  #generateStatement(stmt: Statement) {
    switch (stmt.type) {
      case NodeType.VariableDeclaration:
        this.#generateVariableDeclaration(stmt);
        break;
      case NodeType.ExpressionStatement:
        // Top level expressions not really supported in WASM module structure directly without a start function or similar
        // For now, ignore or throw?
        break;
      case NodeType.BlockStatement:
        // Not supported at top level yet
        break;
    }
  }

  #generateVariableDeclaration(decl: VariableDeclaration) {
    if (decl.init.type === NodeType.FunctionExpression) {
      this.#generateFunction(decl.identifier.name, decl.init, decl.exported);
    }
    // TODO: Handle global variables
  }

  #generateFunction(name: string, func: FunctionExpression, exported: boolean) {
    // 1. Build Type
    // TODO: Map Rhea types to WASM types. For now assume i32.
    const params = func.params.map(() => ValType.i32);
    const results = [ValType.i32]; // TODO: Infer or read return type

    const typeIndex = this.#module.addType(params, results);
    const funcIndex = this.#module.addFunction(typeIndex);

    if (exported) {
      this.#module.addExport(name, ExportDesc.Func, funcIndex);
    }

    // 2. Build Body
    this.#locals.clear();
    func.params.forEach((p, i) => this.#locals.set(p.name.name, i));

    const body: number[] = [];
    this.#generateExpression(func.body as Expression, body);
    body.push(Opcode.end);

    this.#module.addCode([], body); // No extra locals for now
  }

  #generateExpression(expr: Expression, body: number[]) {
    switch (expr.type) {
      case NodeType.BinaryExpression:
        this.#generateBinaryExpression(expr, body);
        break;
      case NodeType.NumberLiteral:
        this.#generateNumberLiteral(expr, body);
        break;
      case NodeType.Identifier:
        this.#generateIdentifier(expr, body);
        break;
      // TODO: Handle other expressions
    }
  }

  #generateBinaryExpression(expr: BinaryExpression, body: number[]) {
    this.#generateExpression(expr.left, body);
    this.#generateExpression(expr.right, body);

    switch (expr.operator) {
      case '+':
        body.push(Opcode.i32_add);
        break;
      case '-':
        body.push(Opcode.i32_sub);
        break;
      case '*':
        body.push(Opcode.i32_mul);
        break;
      case '/':
        body.push(Opcode.i32_div_s);
        break;
      // TODO: Other operators
    }
  }

  #generateNumberLiteral(expr: NumberLiteral, body: number[]) {
    body.push(Opcode.i32_const);
    body.push(...WasmModule.encodeSignedLEB128(parseInt(expr.value, 10)));
  }

  #generateIdentifier(expr: Identifier, body: number[]) {
    const index = this.#locals.get(expr.name);
    if (index === undefined) {
      throw new Error(`Unknown identifier: ${expr.name}`);
    }
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(index));
  }
}
