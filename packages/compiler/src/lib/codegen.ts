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
  type WhileStatement,
  type AssignmentExpression,
  type CallExpression,
  type ClassDeclaration,
  type NewExpression,
  type MemberExpression,
  type ThisExpression,
} from './ast.js';
import {WasmModule} from './emitter.js';
import {ValType, Opcode, ExportDesc, GcOpcode} from './wasm.js';

interface ClassInfo {
  structTypeIndex: number;
  fields: Map<string, {index: number; type: number}>;
  methods: Map<string, number>; // name -> funcIndex
}

export class CodeGenerator {
  #module: WasmModule;
  #program: Program;
  #scopes: Map<string, number>[] = [];
  #extraLocals: number[][] = [];
  #nextLocalIndex = 0;
  #functions = new Map<string, number>();
  #classes = new Map<string, ClassInfo>();
  #currentClass: ClassInfo | null = null;

  constructor(program: Program) {
    this.#program = program;
    this.#module = new WasmModule();
  }
  // ...
  #generateClassMethods(decl: ClassDeclaration) {
    const classInfo = this.#classes.get(decl.name.name)!;
    this.#currentClass = classInfo;

    for (const member of decl.body) {
      if (member.type === NodeType.MethodDefinition) {
        const funcIndex = classInfo.methods.get(member.name.name)!;

        this.#scopes = [new Map()];
        this.#extraLocals = [];
        this.#nextLocalIndex = 0;

        // 'this' is local 0
        this.#nextLocalIndex++;

        // Params
        for (const param of member.params) {
          this.#scopes[0].set(param.name.name, this.#nextLocalIndex++);
        }

        const body: number[] = [];

        // Generate body statements
        for (const stmt of member.body.body) {
          this.#generateFunctionStatement(stmt, body);
        }

        // Implicit return 0 if not void (for now assuming i32 return)
        // TODO: Check if last statement is return
        body.push(Opcode.i32_const, 0, Opcode.end);

        this.#module.addCode(this.#extraLocals, body);
      }
    }
    this.#currentClass = null;
  }

  public generate(): Uint8Array {
    // Pass 1: Register classes and functions
    for (const statement of this.#program.body) {
      if (statement.type === NodeType.ClassDeclaration) {
        this.#registerClass(statement as ClassDeclaration);
      } else if (
        statement.type === NodeType.VariableDeclaration &&
        statement.init.type === NodeType.FunctionExpression
      ) {
        this.#registerFunction(
          statement.identifier.name,
          statement.init as FunctionExpression,
          statement.exported,
        );
      }
    }

    // Pass 2: Generate bodies
    for (const statement of this.#program.body) {
      this.#generateStatement(statement);
    }
    return this.#module.toBytes();
  }

  #registerClass(decl: ClassDeclaration) {
    const fields = new Map<string, {index: number; type: number}>();
    const fieldTypes: {type: number[]; mutable: boolean}[] = [];

    let fieldIndex = 0;
    for (const member of decl.body) {
      if (member.type === NodeType.FieldDefinition) {
        // TODO: Map AST type to WASM type properly. For now assume i32.
        const wasmType = ValType.i32;
        fields.set(member.name.name, {index: fieldIndex++, type: wasmType});
        fieldTypes.push({type: [wasmType], mutable: true}); // All fields mutable for now
      }
    }

    const structTypeIndex = this.#module.addStructType(fieldTypes);
    const classInfo: ClassInfo = {
      structTypeIndex,
      fields,
      methods: new Map(),
    };
    this.#classes.set(decl.name.name, classInfo);

    // Register methods
    for (const member of decl.body) {
      if (member.type === NodeType.MethodDefinition) {
        const methodName = member.name.name;

        // 'this' type: (ref null $structTypeIndex)
        const thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

        const params = [thisType];
        for (const param of member.params) {
          params.push([ValType.i32]); // Assume i32 for now
        }

        const results = [[ValType.i32]]; // Assume i32 return

        const typeIndex = this.#module.addType(params, results);
        const funcIndex = this.#module.addFunction(typeIndex);

        classInfo.methods.set(methodName, funcIndex);

        // Store method info for generation
        // We'll use a mangled name to store it in #functions map if we want to reuse logic,
        // but methods have 'this' param so we need special handling.
        // Let's just store it in a separate list to process in Pass 2.
      }
    }
  }

  #registerFunction(name: string, func: FunctionExpression, exported: boolean) {
    const params = func.params.map(() => [ValType.i32]);
    const results = [[ValType.i32]]; // TODO: Infer or read return type

    const typeIndex = this.#module.addType(params, results);
    const funcIndex = this.#module.addFunction(typeIndex);

    if (exported) {
      this.#module.addExport(name, ExportDesc.Func, funcIndex);
    }

    this.#functions.set(name, funcIndex);
  }

  #generateStatement(stmt: Statement) {
    switch (stmt.type) {
      case NodeType.ClassDeclaration:
        this.#generateClassMethods(stmt as ClassDeclaration);
        break;
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
        // Drop the result of the expression statement
        body.push(Opcode.drop);
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
      case NodeType.WhileStatement:
        this.#generateWhileStatement(stmt as WhileStatement, body);
        break;
    }
  }

  #generateIfStatement(stmt: IfStatement, body: number[]) {
    this.#generateExpression(stmt.test, body);
    body.push(Opcode.if);
    body.push(ValType.void);
    this.#generateFunctionStatement(stmt.consequent, body);
    if (stmt.alternate) {
      body.push(Opcode.else);
      this.#generateFunctionStatement(stmt.alternate, body);
    }
    body.push(Opcode.end);
  }

  #generateWhileStatement(stmt: WhileStatement, body: number[]) {
    // block $break
    //   loop $continue
    //     condition
    //     i32.eqz
    //     br_if $break
    //     body
    //     br $continue
    //   end
    // end

    body.push(Opcode.block);
    body.push(ValType.void);
    body.push(Opcode.loop);
    body.push(ValType.void);

    this.#generateExpression(stmt.test, body);
    body.push(Opcode.i32_eqz); // Invert condition
    body.push(Opcode.br_if);
    body.push(...WasmModule.encodeSignedLEB128(1)); // Break to block (depth 1)

    this.#generateFunctionStatement(stmt.body, body);

    body.push(Opcode.br);
    body.push(...WasmModule.encodeSignedLEB128(0)); // Continue to loop (depth 0)

    body.push(Opcode.end); // End loop
    body.push(Opcode.end); // End block
  }

  #generateLocalVariableDeclaration(decl: VariableDeclaration, body: number[]) {
    this.#generateExpression(decl.init, body);

    let type: number[] = [ValType.i32];
    if (decl.init.type === NodeType.NewExpression) {
      const className = (decl.init as NewExpression).callee.name;
      const classInfo = this.#classes.get(className);
      if (classInfo) {
        type = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
        ];
      }
    }

    const index = this.#declareLocal(decl.identifier.name, type);
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
      case NodeType.AssignmentExpression:
        this.#generateAssignmentExpression(expr as AssignmentExpression, body);
        break;
      case NodeType.CallExpression:
        this.#generateCallExpression(expr as CallExpression, body);
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
      case NodeType.NewExpression:
        this.#generateNewExpression(expr as NewExpression, body);
        break;
      case NodeType.MemberExpression:
        this.#generateMemberExpression(expr as MemberExpression, body);
        break;
      case NodeType.ThisExpression:
        this.#generateThisExpression(expr as ThisExpression, body);
        break;
      // TODO: Handle other expressions
    }
  }

  #generateNewExpression(expr: NewExpression, body: number[]) {
    const className = expr.callee.name;
    const classInfo = this.#classes.get(className);
    if (!classInfo) throw new Error(`Class ${className} not found`);

    // Allocate struct with default values
    body.push(0xfb, GcOpcode.struct_new_default);
    body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));

    // Store ref in temp local to return it later and pass to constructor
    const type = [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
    ];
    const tempLocal = this.#declareLocal('$$temp_new', type);
    body.push(Opcode.local_tee);
    body.push(...WasmModule.encodeSignedLEB128(tempLocal));

    // Prepare args for constructor: [this, args...]
    for (const arg of expr.arguments) {
      this.#generateExpression(arg, body);
    }

    // Call constructor
    const ctorIndex = classInfo.methods.get('#new');
    if (ctorIndex !== undefined) {
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(ctorIndex));
    }

    // Return the ref
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(tempLocal));
  }

  #generateMemberExpression(expr: MemberExpression, body: number[]) {
    this.#generateExpression(expr.object, body);

    const fieldName = expr.property.name;
    let foundClass: ClassInfo | undefined;
    let fieldInfo: {index: number; type: number} | undefined;

    for (const info of this.#classes.values()) {
      if (info.fields.has(fieldName)) {
        foundClass = info;
        fieldInfo = info.fields.get(fieldName);
        break;
      }
    }

    if (!foundClass || !fieldInfo) {
      throw new Error(`Field ${fieldName} not found in any class`);
    }

    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
  }

  #generateThisExpression(expr: ThisExpression, body: number[]) {
    body.push(Opcode.local_get);
    body.push(0);
  }

  #generateCallExpression(expr: CallExpression, body: number[]) {
    if (expr.callee.type === NodeType.MemberExpression) {
      const memberExpr = expr.callee as MemberExpression;
      const methodName = memberExpr.property.name;

      let foundClass: ClassInfo | undefined;
      let methodIndex: number | undefined;

      for (const info of this.#classes.values()) {
        if (info.methods.has(methodName)) {
          foundClass = info;
          methodIndex = info.methods.get(methodName);
          break;
        }
      }

      if (methodIndex === undefined) {
        throw new Error(`Method ${methodName} not found`);
      }

      this.#generateExpression(memberExpr.object, body);

      for (const arg of expr.arguments) {
        this.#generateExpression(arg, body);
      }

      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(methodIndex));
    } else {
      // 1. Generate arguments
      for (const arg of expr.arguments) {
        this.#generateExpression(arg, body);
      }

      // 2. Resolve function
      if (expr.callee.type === NodeType.Identifier) {
        const name = (expr.callee as Identifier).name;
        const funcIndex = this.#functions.get(name);
        if (funcIndex !== undefined) {
          body.push(Opcode.call);
          body.push(...WasmModule.encodeSignedLEB128(funcIndex));
        } else {
          throw new Error(`Function '${name}' not found.`);
        }
      } else {
        throw new Error('Indirect calls not supported yet.');
      }
    }
  }

  #generateAssignmentExpression(expr: AssignmentExpression, body: number[]) {
    if (expr.left.type === NodeType.MemberExpression) {
      const memberExpr = expr.left as MemberExpression;
      const fieldName = memberExpr.property.name;

      let foundClass: ClassInfo | undefined;
      let fieldInfo: {index: number; type: number} | undefined;

      for (const info of this.#classes.values()) {
        if (info.fields.has(fieldName)) {
          foundClass = info;
          fieldInfo = info.fields.get(fieldName);
          break;
        }
      }

      if (!fieldInfo) throw new Error(`Field ${fieldName} not found`);

      this.#generateExpression(memberExpr.object, body);
      this.#generateExpression(expr.value, body);

      const tempVal = this.#declareLocal('$$temp_assign', [fieldInfo.type]);
      body.push(Opcode.local_tee);
      body.push(...WasmModule.encodeSignedLEB128(tempVal));

      body.push(0xfb, GcOpcode.struct_set);
      body.push(...WasmModule.encodeSignedLEB128(foundClass!.structTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));

      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempVal));
    } else if (expr.left.type === NodeType.Identifier) {
      this.#generateExpression(expr.value, body);
      const index = this.#resolveLocal(expr.left.name);
      // Assignment is an expression that evaluates to the assigned value.
      // So we use local.tee to set the local and keep the value on the stack.
      body.push(Opcode.local_tee);
      body.push(...WasmModule.encodeSignedLEB128(index));
    } else {
      throw new Error('Invalid assignment target');
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

  #generateVariableDeclaration(decl: VariableDeclaration) {
    if (decl.init.type === NodeType.FunctionExpression) {
      this.#generateFunctionBody(
        decl.identifier.name,
        decl.init as FunctionExpression,
      );
    }
    // TODO: Handle global variables
  }

  #generateFunctionBody(name: string, func: FunctionExpression) {
    // Function is already registered in Pass 1
    // We just need to generate the code now.

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

  #declareLocal(name: string, type: number[] = [ValType.i32]): number {
    const index = this.#nextLocalIndex++;
    this.#scopes[this.#scopes.length - 1].set(name, index);
    this.#extraLocals.push(type);
    return index;
  }
}
