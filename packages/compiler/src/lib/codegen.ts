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
  type ArrayLiteral,
  type IndexExpression,
  type StringLiteral,
  type TypeAnnotation,
} from './ast.js';
import {WasmModule} from './emitter.js';
import {ValType, Opcode, ExportDesc, GcOpcode} from './wasm.js';

interface ClassInfo {
  structTypeIndex: number;
  fields: Map<string, {index: number; type: number}>;
  methods: Map<string, number>; // name -> funcIndex
}

interface LocalInfo {
  index: number;
  type: number[];
}

export class CodeGenerator {
  #module: WasmModule;
  #program: Program;
  #scopes: Map<string, LocalInfo>[] = [];
  #extraLocals: number[][] = [];
  #nextLocalIndex = 0;
  #functions = new Map<string, number>();
  #classes = new Map<string, ClassInfo>();
  #currentClass: ClassInfo | null = null;
  #arrayTypes = new Map<string, number>(); // elementTypeString -> typeIndex
  #stringTypeIndex = -1;
  #stringLiterals = new Map<string, number>(); // content -> dataIndex
  #pendingHelperFunctions: (() => void)[] = [];
  #concatFunctionIndex = -1;
  #strEqFunctionIndex = -1;

  constructor(program: Program) {
    this.#program = program;
    this.#module = new WasmModule();
    // Define string type: array<i8> (mutable for construction)
    this.#stringTypeIndex = this.#module.addArrayType([ValType.i8], true);
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
          // TODO: Map type annotation to WASM type
          this.#scopes[0].set(param.name.name, {
            index: this.#nextLocalIndex++,
            type: [ValType.i32],
          });
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

    // Generate pending helper functions
    for (const generator of this.#pendingHelperFunctions) {
      generator();
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
    const params = func.params.map((p) => this.#mapType(p.typeAnnotation));
    const results = func.returnType
      ? [this.#mapType(func.returnType)]
      : [[ValType.i32]];

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
        return this.#scopes[i].get(name)!.index;
      }
    }
    throw new Error(`Unknown identifier: ${name}`);
  }

  #resolveLocalInfo(name: string): LocalInfo {
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

    const type = this.#inferType(decl.init);
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
      case NodeType.ArrayLiteral:
        this.#generateArrayLiteral(expr as ArrayLiteral, body);
        break;
      case NodeType.IndexExpression:
        this.#generateIndexExpression(expr as IndexExpression, body);
        break;
      case NodeType.StringLiteral:
        this.#generateStringLiteral(expr as StringLiteral, body);
        break;
      // TODO: Handle other expressions
    }
  }

  #getArrayTypeIndex(elementType: number[]): number {
    const key = elementType.join(',');
    if (this.#arrayTypes.has(key)) {
      return this.#arrayTypes.get(key)!;
    }
    const index = this.#module.addArrayType(elementType, true);
    this.#arrayTypes.set(key, index);
    return index;
  }

  #generateArrayLiteral(expr: ArrayLiteral, body: number[]) {
    if (expr.elements.length === 0) {
      const typeIndex = this.#getArrayTypeIndex([ValType.i32]);
      body.push(0xfb, GcOpcode.array_new_fixed);
      body.push(...WasmModule.encodeSignedLEB128(typeIndex));
      body.push(...WasmModule.encodeSignedLEB128(0));
      return;
    }

    // TODO: Infer type correctly. Assuming i32 for now.
    const elementType = [ValType.i32];
    const typeIndex = this.#getArrayTypeIndex(elementType);

    for (const element of expr.elements) {
      this.#generateExpression(element, body);
    }

    body.push(0xfb, GcOpcode.array_new_fixed);
    body.push(...WasmModule.encodeSignedLEB128(typeIndex));
    body.push(...WasmModule.encodeSignedLEB128(expr.elements.length));
  }

  #generateIndexExpression(expr: IndexExpression, body: number[]) {
    let arrayTypeIndex = -1;
    if (expr.object.type === NodeType.Identifier) {
      const localInfo = this.#resolveLocalInfo(
        (expr.object as Identifier).name,
      );
      if (
        localInfo.type.length > 1 &&
        (localInfo.type[0] === ValType.ref_null ||
          localInfo.type[0] === ValType.ref)
      ) {
        arrayTypeIndex = localInfo.type[1];
      }
    }

    if (arrayTypeIndex === -1) {
      arrayTypeIndex = this.#getArrayTypeIndex([ValType.i32]);
    }

    this.#generateExpression(expr.object, body);
    this.#generateExpression(expr.index, body);

    if (arrayTypeIndex === this.#stringTypeIndex) {
      body.push(0xfb, GcOpcode.array_get_u);
    } else {
      body.push(0xfb, GcOpcode.array_get);
    }
    body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));
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
    const objectType = this.#inferType(expr.object);

    // Handle array/string length
    if (expr.property.name === 'length') {
      const isString = this.#isStringType(objectType);
      const isArray = Array.from(this.#arrayTypes.values()).includes(
        objectType[1],
      );

      if (isString || isArray) {
        this.#generateExpression(expr.object, body);
        body.push(0xfb, GcOpcode.array_len);
        return;
      }
    }

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
    if (expr.left.type === NodeType.IndexExpression) {
      const indexExpr = expr.left as IndexExpression;
      let arrayTypeIndex = -1;
      if (indexExpr.object.type === NodeType.Identifier) {
        const localInfo = this.#resolveLocalInfo(
          (indexExpr.object as Identifier).name,
        );
        if (localInfo.type.length > 1) {
          arrayTypeIndex = localInfo.type[1];
        }
      }
      if (arrayTypeIndex === -1) {
        arrayTypeIndex = this.#getArrayTypeIndex([ValType.i32]);
      }

      this.#generateExpression(indexExpr.object, body);
      this.#generateExpression(indexExpr.index, body);
      this.#generateExpression(expr.value, body);

      const tempLocal = this.#declareLocal('$$temp_array_set', [ValType.i32]);

      body.push(Opcode.local_tee);
      body.push(...WasmModule.encodeSignedLEB128(tempLocal));

      body.push(0xfb, GcOpcode.array_set);
      body.push(...WasmModule.encodeSignedLEB128(arrayTypeIndex));

      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempLocal));
      return;
    }

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

  #mapType(annotation?: TypeAnnotation): number[] {
    if (!annotation) return [ValType.i32];
    if (annotation.name === 'i32') return [ValType.i32];
    if (annotation.name === 'string') {
      return [ValType.ref_null, this.#stringTypeIndex];
    }
    const classInfo = this.#classes.get(annotation.name);
    if (classInfo) {
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
      ];
    }
    return [ValType.i32];
  }

  #inferType(expr: Expression): number[] {
    switch (expr.type) {
      case NodeType.StringLiteral:
        return [ValType.ref_null, this.#stringTypeIndex];
      case NodeType.NumberLiteral:
        return [ValType.i32];
      case NodeType.Identifier: {
        const info = this.#resolveLocalInfo((expr as Identifier).name);
        return info.type;
      }
      case NodeType.BinaryExpression: {
        const binExpr = expr as BinaryExpression;
        if (binExpr.operator === '+') {
          const leftType = this.#inferType(binExpr.left);
          const rightType = this.#inferType(binExpr.right);
          if (this.#isStringType(leftType) && this.#isStringType(rightType)) {
            return [ValType.ref_null, this.#stringTypeIndex];
          }
        }
        return [ValType.i32];
      }
      case NodeType.NewExpression: {
        const className = (expr as NewExpression).callee.name;
        const classInfo = this.#classes.get(className);
        if (classInfo) {
          return [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          ];
        }
        return [ValType.i32];
      }
      case NodeType.ArrayLiteral: {
        // TODO: Infer array type correctly. Assuming i32 for now.
        const typeIndex = this.#getArrayTypeIndex([ValType.i32]);
        return [ValType.ref_null, ...WasmModule.encodeSignedLEB128(typeIndex)];
      }
      default:
        return [ValType.i32];
    }
  }

  #isStringType(type: number[]): boolean {
    return (
      type.length > 1 &&
      (type[0] === ValType.ref_null || type[0] === ValType.ref) &&
      type[1] === this.#stringTypeIndex
    );
  }

  #generateBinaryExpression(expr: BinaryExpression, body: number[]) {
    const leftType = this.#inferType(expr.left);
    const rightType = this.#inferType(expr.right);

    this.#generateExpression(expr.left, body);
    this.#generateExpression(expr.right, body);

    if (this.#isStringType(leftType) && this.#isStringType(rightType)) {
      if (expr.operator === '+') {
        this.#generateStringConcat(body);
        return;
      } else if (expr.operator === '==') {
        this.#generateStringEq(body);
        return;
      } else if (expr.operator === '!=') {
        this.#generateStringEq(body);
        body.push(Opcode.i32_eqz); // Invert result
        return;
      }
    }

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
      this.#scopes[0].set(p.name.name, {
        index,
        type: this.#mapType(p.typeAnnotation),
      });
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
    this.#scopes[this.#scopes.length - 1].set(name, {index, type});
    this.#extraLocals.push(type);
    return index;
  }

  #generateStringLiteral(expr: StringLiteral, body: number[]) {
    let dataIndex: number;
    if (this.#stringLiterals.has(expr.value)) {
      dataIndex = this.#stringLiterals.get(expr.value)!;
    } else {
      const bytes = new TextEncoder().encode(expr.value);
      dataIndex = this.#module.addData(bytes);
      this.#stringLiterals.set(expr.value, dataIndex);
    }

    const length = new TextEncoder().encode(expr.value).length;

    // Push offset (0)
    body.push(Opcode.i32_const);
    body.push(...WasmModule.encodeSignedLEB128(0));

    // Push length
    body.push(Opcode.i32_const);
    body.push(...WasmModule.encodeSignedLEB128(length));

    // array.new_data $stringType $dataIndex
    body.push(0xfb, GcOpcode.array_new_data);
    body.push(...WasmModule.encodeSignedLEB128(this.#stringTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(dataIndex));
  }

  #generateStringEq(body: number[]) {
    if (this.#strEqFunctionIndex === -1) {
      this.#strEqFunctionIndex = this.#generateStrEqFunction();
    }
    body.push(Opcode.call);
    body.push(...WasmModule.encodeSignedLEB128(this.#strEqFunctionIndex));
  }

  #generateStringConcat(body: number[]) {
    if (this.#concatFunctionIndex === -1) {
      this.#concatFunctionIndex = this.#generateConcatFunction();
    }
    body.push(Opcode.call);
    body.push(...WasmModule.encodeSignedLEB128(this.#concatFunctionIndex));
  }

  #generateConcatFunction(): number {
    const stringType = [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(this.#stringTypeIndex),
    ];
    const typeIndex = this.#module.addType(
      [stringType, stringType],
      [stringType],
    );

    const funcIndex = this.#module.addFunction(typeIndex);

    this.#pendingHelperFunctions.push(() => {
      const locals: number[][] = [
        [ValType.i32], // len1 (local 0)
        [ValType.i32], // len2 (local 1)
        [ValType.i32], // newLen (local 2)
        [ValType.ref_null, this.#stringTypeIndex], // newStr (local 3)
      ];
      const body: number[] = [];

      // Params: s1 (local 0 in params -> local 0 relative to frame? No, params are locals 0 and 1)
      // Locals start after params.
      // Params: s1 (0), s2 (1)
      // Locals: len1 (2), len2 (3), newLen (4), newStr (5)

      // len1 = array.len(s1)
      body.push(Opcode.local_get, 0);
      body.push(0xfb, GcOpcode.array_len);
      body.push(Opcode.local_set, 2);

      // len2 = array.len(s2)
      body.push(Opcode.local_get, 1);
      body.push(0xfb, GcOpcode.array_len);
      body.push(Opcode.local_set, 3);

      // newLen = len1 + len2
      body.push(Opcode.local_get, 2);
      body.push(Opcode.local_get, 3);
      body.push(Opcode.i32_add);
      body.push(Opcode.local_set, 4);

      // newStr = array.new_default(newLen)
      body.push(Opcode.local_get, 4);
      body.push(0xfb, GcOpcode.array_new_default);
      body.push(...WasmModule.encodeSignedLEB128(this.#stringTypeIndex));
      body.push(Opcode.local_set, 5);

      // array.copy(dest=newStr, destOffset=0, src=s1, srcOffset=0, len=len1)
      body.push(Opcode.local_get, 5); // dest
      body.push(Opcode.i32_const, 0); // destOffset
      body.push(Opcode.local_get, 0); // src
      body.push(Opcode.i32_const, 0); // srcOffset
      body.push(Opcode.local_get, 2); // len
      body.push(0xfb, GcOpcode.array_copy);
      body.push(...WasmModule.encodeSignedLEB128(this.#stringTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(this.#stringTypeIndex));

      // array.copy(dest=newStr, destOffset=len1, src=s2, srcOffset=0, len=len2)
      body.push(Opcode.local_get, 5); // dest
      body.push(Opcode.local_get, 2); // destOffset
      body.push(Opcode.local_get, 1); // src
      body.push(Opcode.i32_const, 0); // srcOffset
      body.push(Opcode.local_get, 3); // len
      body.push(0xfb, GcOpcode.array_copy);
      body.push(...WasmModule.encodeSignedLEB128(this.#stringTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(this.#stringTypeIndex));

      // return newStr
      body.push(Opcode.local_get, 5);
      body.push(Opcode.end);

      this.#module.addCode(locals, body);
    });

    return funcIndex;
  }

  #generateStrEqFunction(): number {
    const stringType = [
      ValType.ref_null,
      ...WasmModule.encodeSignedLEB128(this.#stringTypeIndex),
    ];
    const typeIndex = this.#module.addType(
      [stringType, stringType],
      [[ValType.i32]],
    );

    const funcIndex = this.#module.addFunction(typeIndex);

    this.#pendingHelperFunctions.push(() => {
      const locals: number[][] = [
        [ValType.i32], // len1 (local 0)
        [ValType.i32], // len2 (local 1)
        [ValType.i32], // i (local 2)
      ];
      const body: number[] = [];

      // Params: s1 (0), s2 (1)
      // Locals: len1 (2), len2 (3), i (4)

      // len1 = array.len(s1)
      body.push(Opcode.local_get, 0);
      body.push(0xfb, GcOpcode.array_len);
      body.push(Opcode.local_set, 2);

      // len2 = array.len(s2)
      body.push(Opcode.local_get, 1);
      body.push(0xfb, GcOpcode.array_len);
      body.push(Opcode.local_set, 3);

      // if len1 != len2 return 0
      body.push(Opcode.local_get, 2);
      body.push(Opcode.local_get, 3);
      body.push(Opcode.i32_ne);
      body.push(Opcode.if, ValType.void);
      body.push(Opcode.i32_const, 0);
      body.push(Opcode.return);
      body.push(Opcode.end);

      // loop i from 0 to len1
      body.push(Opcode.i32_const, 0);
      body.push(Opcode.local_set, 4); // i = 0

      body.push(Opcode.block, ValType.void);
      body.push(Opcode.loop, ValType.void);

      // if i == len1 break
      body.push(Opcode.local_get, 4);
      body.push(Opcode.local_get, 2);
      body.push(Opcode.i32_ge_u);
      body.push(Opcode.br_if, 1); // break to block

      // if s1[i] != s2[i] return 0
      body.push(Opcode.local_get, 0);
      body.push(Opcode.local_get, 4);
      body.push(0xfb, GcOpcode.array_get_u);
      body.push(...WasmModule.encodeSignedLEB128(this.#stringTypeIndex));

      body.push(Opcode.local_get, 1);
      body.push(Opcode.local_get, 4);
      body.push(0xfb, GcOpcode.array_get_u);
      body.push(...WasmModule.encodeSignedLEB128(this.#stringTypeIndex));

      body.push(Opcode.i32_ne);
      body.push(Opcode.if, ValType.void);
      body.push(Opcode.i32_const, 0);
      body.push(Opcode.return);
      body.push(Opcode.end);

      // i++
      body.push(Opcode.local_get, 4);
      body.push(Opcode.i32_const, 1);
      body.push(Opcode.i32_add);
      body.push(Opcode.local_set, 4);

      body.push(Opcode.br, 0); // continue loop
      body.push(Opcode.end); // end loop
      body.push(Opcode.end); // end block

      // return 1
      body.push(Opcode.i32_const, 1);
      body.push(Opcode.end);

      this.#module.addCode(locals, body);
    });

    return funcIndex;
  }
}
