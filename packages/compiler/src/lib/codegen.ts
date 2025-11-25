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
  type BooleanLiteral,
  type BlockStatement,
  type ReturnStatement,
  type IfStatement,
} from './ast.js';
import {WasmModule} from './emitter.js';
import {ValType, Opcode, ExportDesc} from './wasm.js';

export class CodeGenerator {
  #module: WasmModule;
  #program: Program;
  #scopes: Map<string, number>[] = [];
  #extraLocals: number[] = [];
  #nextLocalIndex = 0;

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
    this.#scopes = [new Map()];
    this.#extraLocals = [];
    this.#nextLocalIndex = 0;

    func.params.forEach((p) => {
      const index = this.#nextLocalIndex++;
      this.#scopes[0].set(p.name.name, index);
    });

    const body: number[] = [];
    if (func.body.type === NodeType.BlockStatement) {
      this.#generateBlockStatement(func.body, body);
    } else {
      this.#generateExpression(func.body as Expression, body);
    }
    body.push(Opcode.end);

    this.#module.addCode(this.#extraLocals, body);
  }

  #enterScope() {
    this.#scopes.push(new Map());
  }

  #exitScope() {
    this.#scopes.pop();
  }

  #declareLocal(name: string): number {
    const index = this.#nextLocalIndex++;
    this.#scopes[this.#scopes.length - 1].set(name, index);
    this.#extraLocals.push(ValType.i32); // Assume i32 for now
    return index;
  }

  #resolveLocal(name: string): number {
    for (let i = this.#scopes.length - 1; i >= 0; i--) {
      if (this.#scopes[i].has(name)) {
        return this.#scopes[i].get(name)!;
      }
    }
    throw new Error(`Unknown identifier: ${name}`);
  }

  #generateBlockStatement(block: BlockStatement, body: number[]) {
    this.#enterScope();
    for (const stmt of block.body) {
      this.#generateFunctionStatement(stmt, body);
    }
    this.#exitScope();
  }

  #generateFunctionStatement(stmt: Statement, body: number[]) {
    switch (stmt.type) {
      case NodeType.ReturnStatement:
        this.#generateReturnStatement(stmt as ReturnStatement, body);
        break;
      case NodeType.ExpressionStatement:
        this.#generateExpression(stmt.expression, body);
        // If expression returns a value but statement shouldn't, we might need to drop it?
        // For now, assume expression statements are void or we don't care about stack pollution yet (bad assumption for WASM)
        // TODO: Drop value if expression has a return value
        break;
      case NodeType.VariableDeclaration:
        this.#generateLocalVariableDeclaration(
          stmt as VariableDeclaration,
          body,
        );
        break;
      case NodeType.BlockStatement:
        this.#generateBlockStatement(stmt, body);
        break;
      case NodeType.IfStatement:
        this.#generateIfStatement(stmt as IfStatement, body);
        break;
    }
  }

  #generateIfStatement(stmt: IfStatement, body: number[]) {
    this.#generateExpression(stmt.test, body);
    body.push(Opcode.if);
    body.push(0x40); // block type: void

    this.#generateFunctionStatement(stmt.consequent, body);

    if (stmt.alternate) {
      body.push(Opcode.else);
      this.#generateFunctionStatement(stmt.alternate, body);
    }

    body.push(Opcode.end);
  }

  #generateLocalVariableDeclaration(decl: VariableDeclaration, body: number[]) {
    this.#generateExpression(decl.init, body);
    const index = this.#declareLocal(decl.identifier.name);
    body.push(Opcode.local_set);
    body.push(...WasmModule.encodeSignedLEB128(index));
  }

  #generateReturnStatement(stmt: ReturnStatement, body: number[]) {
    if (stmt.argument) {
      this.#generateExpression(stmt.argument, body);
    }
    // We don't strictly need 'return' opcode if it's the last statement,
    // but for now let's not optimize and assume implicit return at end of function
    // or explicit return.
    // If we are in a block, we might need 'return'.
    // Let's use 'return' opcode for explicit return statements.
    body.push(Opcode.return);
  }

  #generateExpression(expr: Expression, body: number[]) {
    switch (expr.type) {
      case NodeType.BinaryExpression:
        this.#generateBinaryExpression(expr, body);
        break;
      case NodeType.NumberLiteral:
        this.#generateNumberLiteral(expr, body);
        break;
      case NodeType.BooleanLiteral:
        this.#generateBooleanLiteral(expr as BooleanLiteral, body);
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
      case '==':
        body.push(Opcode.i32_eq);
        break;
      case '!=':
        body.push(Opcode.i32_ne);
        break;
      case '<':
        body.push(Opcode.i32_lt_s);
        break;
      case '<=':
        body.push(Opcode.i32_le_s);
        break;
      case '>':
        body.push(Opcode.i32_gt_s);
        break;
      case '>=':
        body.push(Opcode.i32_ge_s);
        break;
    }
  }

  #generateNumberLiteral(expr: NumberLiteral, body: number[]) {
    body.push(Opcode.i32_const);
    body.push(...WasmModule.encodeSignedLEB128(parseInt(expr.value, 10)));
  }

  #generateBooleanLiteral(expr: BooleanLiteral, body: number[]) {
    body.push(Opcode.i32_const);
    body.push(...WasmModule.encodeSignedLEB128(expr.value ? 1 : 0));
  }

  #generateIdentifier(expr: Identifier, body: number[]) {
    const index = this.#resolveLocal(expr.name);
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(index));
  }
}
