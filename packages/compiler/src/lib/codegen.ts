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
  type MethodDefinition,
  type Parameter,
  type TypeParameter,
  type InterfaceDeclaration,
} from './ast.js';
import {WasmModule} from './emitter.js';
import {ValType, Opcode, ExportDesc, GcOpcode} from './wasm.js';
import type {ClassInfo, LocalInfo, InterfaceInfo} from './codegen-types.js';

export class CodeGenerator {
  #module: WasmModule;
  #program: Program;
  #scopes: Map<string, LocalInfo>[] = [];
  #extraLocals: number[][] = [];
  #nextLocalIndex = 0;
  #functions = new Map<string, number>();
  #classes = new Map<string, ClassInfo>();
  #interfaces = new Map<string, InterfaceInfo>();
  #currentClass: ClassInfo | null = null;
  #arrayTypes = new Map<string, number>(); // elementTypeString -> typeIndex
  #stringTypeIndex = -1;
  #stringLiterals = new Map<string, number>(); // content -> dataIndex
  #pendingHelperFunctions: (() => void)[] = [];
  #concatFunctionIndex = -1;
  #strEqFunctionIndex = -1;
  #genericClasses = new Map<string, ClassDeclaration>();
  #genericFunctions = new Map<string, FunctionExpression>();
  #functionReturnTypes = new Map<string, number[]>();
  #pendingMethodGenerations: (() => void)[] = [];
  #bodyGenerators: (() => void)[] = [];
  #currentTypeContext: Map<string, TypeAnnotation> | undefined;
  #thisLocalIndex = 0;

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

    const members = [...decl.body];
    const hasConstructor = members.some(
      (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
    );
    if (!hasConstructor) {
      members.push({
        type: NodeType.MethodDefinition,
        name: {type: NodeType.Identifier, name: '#new'},
        params: [],
        body: {type: NodeType.BlockStatement, body: []},
      } as MethodDefinition);
    }

    for (const member of members) {
      if (member.type === NodeType.MethodDefinition) {
        const methodName = member.name.name;
        const methodInfo = classInfo.methods.get(methodName)!;
        const body = this.#generateMethodBodyCode(member, new Map(), decl);
        this.#module.addCode(methodInfo.index, this.#extraLocals, body);
      }
    }
    this.#currentClass = null;
  }

  public generate(): Uint8Array {
    // Pass 1: Register classes and functions
    for (const statement of this.#program.body) {
      if (statement.type === NodeType.ClassDeclaration) {
        this.#registerClass(statement as ClassDeclaration);
      } else if (statement.type === NodeType.InterfaceDeclaration) {
        this.#registerInterface(statement as InterfaceDeclaration);
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

    // Generate bodies and pending functions
    while (
      this.#bodyGenerators.length > 0 ||
      this.#pendingHelperFunctions.length > 0 ||
      this.#pendingMethodGenerations.length > 0
    ) {
      if (this.#bodyGenerators.length > 0) {
        const generator = this.#bodyGenerators.shift()!;
        generator();
      } else if (this.#pendingHelperFunctions.length > 0) {
        const generator = this.#pendingHelperFunctions.shift()!;
        generator();
      } else if (this.#pendingMethodGenerations.length > 0) {
        const generator = this.#pendingMethodGenerations.shift()!;
        generator();
      }
    }

    return this.#module.toBytes();
  }

  #registerInterface(decl: InterfaceDeclaration) {
    // 1. Create VTable Struct Type
    // (struct (field (ref (func (param any) ...))) ...)
    const vtableFields: {type: number[]; mutable: boolean}[] = [];
    const methodIndices = new Map<string, {index: number; typeIndex: number}>();

    let methodIndex = 0;
    for (const member of decl.body) {
      if (member.type === NodeType.MethodSignature) {
        // Function type: (param any, ...params) -> result
        const params: number[][] = [[ValType.ref_null, ValType.anyref]]; // 'this' is (ref null any)
        for (const param of member.params) {
          params.push(this.#mapType(param.typeAnnotation));
        }
        const results: number[][] = [];
        if (member.returnType) {
          const mapped = this.#mapType(member.returnType);
          if (mapped.length > 0) results.push(mapped);
        }

        const funcTypeIndex = this.#module.addType(params, results);

        // Field in VTable: (ref funcType)
        vtableFields.push({
          type: [ValType.ref, ...WasmModule.encodeSignedLEB128(funcTypeIndex)],
          mutable: false, // VTables are immutable
        });

        methodIndices.set(member.name.name, {
          index: methodIndex++,
          typeIndex: funcTypeIndex,
        });
      }
    }

    const vtableTypeIndex = this.#module.addStructType(vtableFields);

    // 2. Create Interface Struct Type (Fat Pointer)
    // (struct (field (ref null any)) (field (ref vtable)))
    const interfaceFields = [
      {type: [ValType.ref_null, ValType.anyref], mutable: true}, // instance
      {
        type: [ValType.ref, ...WasmModule.encodeSignedLEB128(vtableTypeIndex)],
        mutable: true,
      }, // vtable
    ];
    const structTypeIndex = this.#module.addStructType(interfaceFields);

    this.#interfaces.set(decl.name.name, {
      structTypeIndex,
      vtableTypeIndex,
      methods: methodIndices,
    });
  }

  #generateTrampoline(
    classInfo: ClassInfo,
    methodName: string,
    typeIndex: number,
  ): number {
    const classMethod = classInfo.methods.get(methodName)!;
    const trampolineIndex = this.#module.addFunction(typeIndex);

    const body: number[] = [];

    // Locals:
    // 0..N: Params (Param 0 is 'any', 1..N are args)
    // N+1: Casted 'this'

    const paramCount = classMethod.paramTypes.length;
    const castedThisLocal = paramCount;
    const locals = [
      [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
      ],
    ];

    // local.set $castedThis (ref.cast $Task (local.get 0))
    body.push(Opcode.local_get, 0);
    body.push(
      0xfb,
      GcOpcode.ref_cast_null,
      ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
    );
    body.push(
      Opcode.local_set,
      ...WasmModule.encodeSignedLEB128(castedThisLocal),
    );

    // Call class method
    body.push(
      Opcode.local_get,
      ...WasmModule.encodeSignedLEB128(castedThisLocal),
    );
    for (let i = 1; i < classMethod.paramTypes.length; i++) {
      body.push(Opcode.local_get, ...WasmModule.encodeSignedLEB128(i));
    }
    body.push(Opcode.call, ...WasmModule.encodeSignedLEB128(classMethod.index));
    body.push(Opcode.end);

    this.#module.addCode(trampolineIndex, locals, body);
    return trampolineIndex;
  }

  #generateInterfaceVTable(classInfo: ClassInfo, decl: ClassDeclaration) {
    if (!decl.implements) return;

    if (!classInfo.implements) classInfo.implements = new Map();

    for (const impl of decl.implements) {
      const interfaceName = impl.name;
      const interfaceInfo = this.#interfaces.get(interfaceName)!;

      const vtableEntries: number[] = [];

      for (const [methodName, methodInfo] of interfaceInfo.methods) {
        const trampolineIndex = this.#generateTrampoline(
          classInfo,
          methodName,
          methodInfo.typeIndex,
        );
        vtableEntries.push(trampolineIndex);
      }

      const initExpr: number[] = [];
      for (const funcIndex of vtableEntries) {
        initExpr.push(
          Opcode.ref_func,
          ...WasmModule.encodeSignedLEB128(funcIndex),
        );
      }
      initExpr.push(
        0xfb,
        GcOpcode.struct_new,
        ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
      );

      const globalIndex = this.#module.addGlobal(
        [
          ValType.ref,
          ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
        ],
        false,
        initExpr,
      );

      classInfo.implements.set(interfaceName, {vtableGlobalIndex: globalIndex});
    }
  }

  #getClassFromTypeIndex(index: number): ClassInfo | undefined {
    for (const info of this.#classes.values()) {
      if (info.structTypeIndex === index) return info;
    }
    return undefined;
  }

  #getInterfaceFromTypeIndex(index: number): InterfaceInfo | undefined {
    for (const info of this.#interfaces.values()) {
      if (info.structTypeIndex === index) return info;
    }
    return undefined;
  }

  #decodeTypeIndex(type: number[]): number {
    if (type.length < 2) return -1;
    let typeIndex = 0;
    let shift = 0;
    for (let i = 1; i < type.length; i++) {
      const byte = type[i];
      typeIndex |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return typeIndex;
  }

  #registerClass(decl: ClassDeclaration) {
    if (decl.typeParameters && decl.typeParameters.length > 0) {
      this.#genericClasses.set(decl.name.name, decl);
      return;
    }

    const fields = new Map<string, {index: number; type: number[]}>();
    const fieldTypes: {type: number[]; mutable: boolean}[] = [];
    let fieldIndex = 0;

    let superTypeIndex: number | undefined;
    const methods = new Map<
      string,
      {
        index: number;
        returnType: number[];
        typeIndex: number;
        paramTypes: number[][];
      }
    >();
    const vtable: string[] = [];

    if (decl.superClass) {
      const superClassInfo = this.#classes.get(decl.superClass.name);
      if (!superClassInfo) {
        throw new Error(`Unknown superclass ${decl.superClass.name}`);
      }
      superTypeIndex = superClassInfo.structTypeIndex;

      // Inherit fields
      const sortedSuperFields = Array.from(
        superClassInfo.fields.entries(),
      ).sort((a, b) => a[1].index - b[1].index);

      for (const [name, info] of sortedSuperFields) {
        fields.set(name, {index: fieldIndex++, type: info.type});
        fieldTypes.push({type: info.type, mutable: true});
      }

      // Inherit methods and vtable
      if (superClassInfo.vtable) {
        vtable.push(...superClassInfo.vtable);
      }
      for (const [name, info] of superClassInfo.methods) {
        methods.set(name, info);
      }
    } else {
      // Root class: Add vtable field
      fields.set('__vtable', {index: fieldIndex++, type: [ValType.eqref]});
      fieldTypes.push({type: [ValType.eqref], mutable: true});
    }

    for (const member of decl.body) {
      if (member.type === NodeType.FieldDefinition) {
        const wasmType = [ValType.i32];
        if (!fields.has(member.name.name)) {
          fields.set(member.name.name, {index: fieldIndex++, type: wasmType});
          fieldTypes.push({type: wasmType, mutable: true});
        }
      }
    }

    const structTypeIndex = this.#module.addStructType(
      fieldTypes,
      superTypeIndex,
    );

    // Register methods
    const members = [...decl.body];
    const hasConstructor = members.some(
      (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
    );
    if (!hasConstructor) {
      members.push({
        type: NodeType.MethodDefinition,
        name: {type: NodeType.Identifier, name: '#new'},
        params: [],
        body: {type: NodeType.BlockStatement, body: []},
      } as MethodDefinition);
    }

    for (const member of members) {
      if (member.type === NodeType.MethodDefinition) {
        const methodName = member.name.name;

        if (methodName !== '#new' && !vtable.includes(methodName)) {
          vtable.push(methodName);
        }

        let thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

        if (decl.superClass) {
          const superClassInfo = this.#classes.get(decl.superClass.name)!;
          if (methodName !== '#new' && superClassInfo.methods.has(methodName)) {
            thisType = superClassInfo.methods.get(methodName)!.paramTypes[0];
          }
        }

        const params = [thisType];
        for (const param of member.params) {
          params.push([ValType.i32]);
        }

        let results = [[ValType.i32]];
        if (methodName === '#new') {
          results = [];
        }

        let typeIndex: number;
        let isOverride = false;
        if (decl.superClass) {
          const superClassInfo = this.#classes.get(decl.superClass.name)!;
          if (methodName !== '#new' && superClassInfo.methods.has(methodName)) {
            typeIndex = superClassInfo.methods.get(methodName)!.typeIndex;
            isOverride = true;
          }
        }

        if (!isOverride) {
          typeIndex = this.#module.addType(params, results);
        }

        const funcIndex = this.#module.addFunction(typeIndex!);

        const returnType = results.length > 0 ? results[0] : [];
        methods.set(methodName, {
          index: funcIndex,
          returnType,
          typeIndex: typeIndex!,
          paramTypes: params,
        });
      }
    }
    // Create VTable Struct Type
    let vtableSuperTypeIndex: number | undefined;
    if (decl.superClass) {
      const superClassInfo = this.#classes.get(decl.superClass.name)!;
      vtableSuperTypeIndex = superClassInfo.vtableTypeIndex;
    }

    const vtableTypeIndex = this.#module.addStructType(
      vtable.map(() => ({type: [ValType.funcref], mutable: false})),
      vtableSuperTypeIndex,
    );

    // Create VTable Global
    const vtableInit: number[] = [];
    for (const methodName of vtable) {
      const methodInfo = methods.get(methodName);
      if (!methodInfo) throw new Error(`Method ${methodName} not found`);
      vtableInit.push(Opcode.ref_func);
      vtableInit.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
    }
    vtableInit.push(0xfb, GcOpcode.struct_new);
    vtableInit.push(...WasmModule.encodeSignedLEB128(vtableTypeIndex));

    const vtableGlobalIndex = this.#module.addGlobal(
      [ValType.ref, ...WasmModule.encodeSignedLEB128(vtableTypeIndex)],
      false,
      vtableInit,
    );

    const classInfo: ClassInfo = {
      structTypeIndex,
      fields,
      methods,
      vtable,
      vtableTypeIndex,
      vtableGlobalIndex,
    };
    this.#classes.set(decl.name.name, classInfo);

    this.#generateInterfaceVTable(classInfo, decl);

    this.#bodyGenerators.push(() => {
      this.#generateClassMethods(decl);
    });
  }

  #registerFunction(name: string, func: FunctionExpression, exported: boolean) {
    if (func.typeParameters && func.typeParameters.length > 0) {
      this.#genericFunctions.set(name, func);
      return;
    }

    const params = func.params.map((p) => this.#mapType(p.typeAnnotation));
    const mappedReturn = func.returnType
      ? this.#mapType(func.returnType)
      : [ValType.i32];
    const results = mappedReturn.length > 0 ? [mappedReturn] : [];

    const typeIndex = this.#module.addType(params, results);
    const funcIndex = this.#module.addFunction(typeIndex);

    if (exported) {
      this.#module.addExport(name, ExportDesc.Func, funcIndex);
    }

    this.#functions.set(name, funcIndex);
    this.#functionReturnTypes.set(name, mappedReturn);
    this.#bodyGenerators.push(() => {
      const body = this.#generateFunctionBody(name, func);
      this.#module.addCode(funcIndex, this.#extraLocals, body);
    });
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

    let type: number[];
    if (decl.typeAnnotation) {
      type = this.#mapType(decl.typeAnnotation, this.#currentTypeContext);

      // Check for interface boxing
      if (this.#interfaces.has(decl.typeAnnotation.name)) {
        const initType = this.#inferType(decl.init);
        const typeIndex = this.#decodeTypeIndex(initType);
        const classInfo = this.#getClassFromTypeIndex(typeIndex);

        if (
          classInfo &&
          classInfo.implements &&
          classInfo.implements.has(decl.typeAnnotation.name)
        ) {
          const interfaceName = decl.typeAnnotation.name;
          const interfaceInfo = this.#interfaces.get(interfaceName)!;
          const implInfo = classInfo.implements.get(interfaceName)!;

          body.push(
            Opcode.global_get,
            ...WasmModule.encodeSignedLEB128(implInfo.vtableGlobalIndex),
          );
          body.push(
            0xfb,
            GcOpcode.struct_new,
            ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
          );
        }
      }
    } else {
      type = this.#inferType(decl.init);
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
    let className = expr.callee.name;
    let typeArguments = expr.typeArguments;

    if (
      (!typeArguments || typeArguments.length === 0) &&
      this.#genericClasses.has(className)
    ) {
      const classDecl = this.#genericClasses.get(className)!;
      const ctor = classDecl.body.find(
        (m) => m.type === NodeType.MethodDefinition && m.name.name === '#new',
      ) as MethodDefinition | undefined;
      if (ctor) {
        typeArguments = this.#inferTypeArgs(
          classDecl.typeParameters!,
          ctor.params,
          expr.arguments,
        );
      } else {
        throw new Error(
          `Cannot infer type arguments for ${className}: no constructor found.`,
        );
      }
    }

    if (typeArguments && typeArguments.length > 0) {
      // Check for partial type arguments and fill with defaults
      if (this.#genericClasses.has(className)) {
        const classDecl = this.#genericClasses.get(className)!;
        if (
          classDecl.typeParameters &&
          typeArguments.length < classDecl.typeParameters.length
        ) {
          const newArgs = [...typeArguments];
          for (
            let i = typeArguments.length;
            i < classDecl.typeParameters.length;
            i++
          ) {
            const param = classDecl.typeParameters[i];
            if (param.default) {
              newArgs.push(param.default);
            } else {
              throw new Error(`Missing type argument for ${param.name}`);
            }
          }
          typeArguments = newArgs;
        }
      }

      const annotation: TypeAnnotation = {
        type: NodeType.TypeAnnotation,
        name: className,
        typeArguments: typeArguments,
      };
      // Ensure the class is instantiated
      this.#mapType(annotation, this.#currentTypeContext);
      // Get the specialized name
      className = this.#getTypeKey(annotation, this.#currentTypeContext);
    }

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

    // Initialize vtable
    if (classInfo.vtableGlobalIndex !== undefined) {
      body.push(Opcode.global_get);
      body.push(...WasmModule.encodeSignedLEB128(classInfo.vtableGlobalIndex));
      body.push(0xfb, GcOpcode.struct_set);
      body.push(...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex));
      body.push(...WasmModule.encodeSignedLEB128(0)); // vtable is always at index 0

      // Restore object for constructor
      body.push(Opcode.local_get);
      body.push(...WasmModule.encodeSignedLEB128(tempLocal));
    }

    // Prepare args for constructor: [this, args...]
    for (const arg of expr.arguments) {
      this.#generateExpression(arg, body);
    }

    // Call constructor
    const ctorInfo = classInfo.methods.get('#new');
    if (ctorInfo !== undefined) {
      body.push(Opcode.call);
      body.push(...WasmModule.encodeSignedLEB128(ctorInfo.index));
    }

    // Return the instance
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

    const structTypeIndex = this.#getHeapTypeIndex(objectType);
    if (structTypeIndex === -1) {
      throw new Error(`Invalid object type for field access: ${fieldName}`);
    }

    let foundClass: ClassInfo | undefined;
    for (const info of this.#classes.values()) {
      if (info.structTypeIndex === structTypeIndex) {
        foundClass = info;
        break;
      }
    }

    if (!foundClass) {
      throw new Error(`Class not found for object type ${structTypeIndex}`);
    }

    const fieldInfo = foundClass.fields.get(fieldName);
    if (!fieldInfo) {
      throw new Error(`Field ${fieldName} not found in class`);
    }

    body.push(0xfb, GcOpcode.struct_get);
    body.push(...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex));
    body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
  }

  #generateThisExpression(expr: ThisExpression, body: number[]) {
    body.push(Opcode.local_get);
    body.push(...WasmModule.encodeSignedLEB128(this.#thisLocalIndex));
  }

  #generateCallExpression(expr: CallExpression, body: number[]) {
    if (expr.callee.type === NodeType.MemberExpression) {
      const memberExpr = expr.callee as MemberExpression;
      const methodName = memberExpr.property.name;

      const objectType = this.#inferType(memberExpr.object);
      const typeIndex = this.#decodeTypeIndex(objectType);

      // Check if interface
      const interfaceInfo = this.#getInterfaceFromTypeIndex(typeIndex);
      if (interfaceInfo) {
        const methodInfo = interfaceInfo.methods.get(methodName);
        if (!methodInfo)
          throw new Error(`Method ${methodName} not found in interface`);

        // Evaluate object -> Stack: [InterfaceStruct]
        this.#generateExpression(memberExpr.object, body);

        // Store in temp local
        const tempLocal = this.#declareLocal('$$interface_temp', objectType);
        body.push(
          Opcode.local_tee,
          ...WasmModule.encodeSignedLEB128(tempLocal),
        );

        // Load VTable
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
          ...WasmModule.encodeSignedLEB128(1),
        );

        // Load Function Pointer
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(interfaceInfo.vtableTypeIndex),
          ...WasmModule.encodeSignedLEB128(methodInfo.index),
        );

        // Cast to specific function type
        if (methodInfo.typeIndex > 10) {
          // throw new Error(`Type index too high: ${methodInfo.typeIndex}`);
        }
        // Try ref.cast_null (0x17) instead of ref.cast (0x16)
        body.push(
          0xfb,
          GcOpcode.ref_cast_null,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        );

        // Store function ref in temp local
        const funcRefType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        ];
        const funcRefLocal = this.#declareLocal(
          '$$interface_func',
          funcRefType,
        );
        body.push(
          Opcode.local_set,
          ...WasmModule.encodeSignedLEB128(funcRefLocal),
        );

        // Load Instance (this)
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(tempLocal),
        );
        body.push(
          0xfb,
          GcOpcode.struct_get,
          ...WasmModule.encodeSignedLEB128(interfaceInfo.structTypeIndex),
          ...WasmModule.encodeSignedLEB128(0),
        );

        // Args
        for (const arg of expr.arguments) {
          this.#generateExpression(arg, body);
        }

        // Load function ref
        body.push(
          Opcode.local_get,
          ...WasmModule.encodeSignedLEB128(funcRefLocal),
        );

        // Call Ref
        body.push(
          Opcode.call_ref,
          ...WasmModule.encodeUnsignedLEB128(methodInfo.typeIndex),
        );
        return;
      }

      const structTypeIndex = this.#getHeapTypeIndex(objectType);

      if (structTypeIndex === -1) {
        throw new Error(`Invalid object type for method call: ${methodName}`);
      }

      let foundClass: ClassInfo | undefined;
      for (const info of this.#classes.values()) {
        if (info.structTypeIndex === structTypeIndex) {
          foundClass = info;
          break;
        }
      }

      if (!foundClass) {
        throw new Error(`Class not found for object type ${structTypeIndex}`);
      }

      const methodInfo = foundClass.methods.get(methodName);
      if (methodInfo === undefined) {
        throw new Error(`Method ${methodName} not found in class`);
      }

      const vtableIndex = foundClass.vtable
        ? foundClass.vtable.indexOf(methodName)
        : -1;

      if (vtableIndex !== -1 && foundClass.vtableTypeIndex !== undefined) {
        // Dynamic Dispatch
        this.#generateExpression(memberExpr.object, body);

        // Save object to temp
        const tempObj = this.#declareLocal('$$temp_dispatch_obj', objectType);
        body.push(Opcode.local_tee);
        body.push(...WasmModule.encodeSignedLEB128(tempObj));

        // Get vtable (field 0)
        body.push(0xfb, GcOpcode.struct_get);
        body.push(...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex));
        body.push(...WasmModule.encodeSignedLEB128(0));

        // Cast vtable
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex));

        // Get function from vtable
        body.push(0xfb, GcOpcode.struct_get);
        body.push(...WasmModule.encodeSignedLEB128(foundClass.vtableTypeIndex));
        body.push(...WasmModule.encodeSignedLEB128(vtableIndex));

        // Cast function to specific type
        body.push(0xfb, GcOpcode.ref_cast_null);
        body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));

        // Save function to temp
        const funcType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(methodInfo.typeIndex),
        ];
        const tempFunc = this.#declareLocal('$$temp_dispatch_func', funcType);
        body.push(Opcode.local_set);
        body.push(...WasmModule.encodeSignedLEB128(tempFunc));

        // Restore object (this)
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(tempObj));

        // Generate arguments
        for (const arg of expr.arguments) {
          this.#generateExpression(arg, body);
        }

        // Get function
        body.push(Opcode.local_get);
        body.push(...WasmModule.encodeSignedLEB128(tempFunc));

        // Call ref
        body.push(Opcode.call_ref);
        body.push(...WasmModule.encodeSignedLEB128(methodInfo.typeIndex));
      } else {
        this.#generateExpression(memberExpr.object, body);

        for (const arg of expr.arguments) {
          this.#generateExpression(arg, body);
        }

        body.push(Opcode.call);
        body.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
      }
    } else {
      // 1. Generate arguments
      for (const arg of expr.arguments) {
        this.#generateExpression(arg, body);
      }

      // 2. Resolve function
      if (expr.callee.type === NodeType.Identifier) {
        const name = (expr.callee as Identifier).name;

        if (this.#genericFunctions.has(name)) {
          let typeArguments = expr.typeArguments;

          if (!typeArguments || typeArguments.length === 0) {
            const funcDecl = this.#genericFunctions.get(name)!;
            typeArguments = this.#inferTypeArgs(
              funcDecl.typeParameters!,
              funcDecl.params,
              expr.arguments,
            );
          } else {
            // Check for partial type arguments
            const funcDecl = this.#genericFunctions.get(name)!;
            if (
              funcDecl.typeParameters &&
              typeArguments.length < funcDecl.typeParameters.length
            ) {
              const newArgs = [...typeArguments];
              for (
                let i = typeArguments.length;
                i < funcDecl.typeParameters.length;
                i++
              ) {
                const param = funcDecl.typeParameters[i];
                if (param.default) {
                  newArgs.push(param.default);
                } else {
                  throw new Error(`Missing type argument for ${param.name}`);
                }
              }
              typeArguments = newArgs;
            }
          }

          const funcIndex = this.#instantiateGenericFunction(
            name,
            typeArguments!,
          );
          body.push(Opcode.call);
          body.push(...WasmModule.encodeSignedLEB128(funcIndex));
          return;
        }

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

      const objectType = this.#inferType(memberExpr.object);
      const structTypeIndex = this.#getHeapTypeIndex(objectType);
      if (structTypeIndex === -1) {
        throw new Error(
          `Invalid object type for field assignment: ${fieldName}`,
        );
      }

      let foundClass: ClassInfo | undefined;
      for (const info of this.#classes.values()) {
        if (info.structTypeIndex === structTypeIndex) {
          foundClass = info;
          break;
        }
      }

      if (!foundClass) {
        throw new Error(`Class not found for object type ${structTypeIndex}`);
      }

      const fieldInfo = foundClass.fields.get(fieldName);
      if (!fieldInfo) throw new Error(`Field ${fieldName} not found`);

      this.#generateExpression(memberExpr.object, body);
      this.#generateExpression(expr.value, body);

      // Assignment is an expression that evaluates to the assigned value.
      // So we use local.tee to set the local and keep the value on the stack.
      // But struct.set consumes the value.
      // So we need to duplicate the value.
      // Stack: [object, value]
      // We want: [object, value] -> struct.set -> [value]
      // But struct.set consumes both.
      // So we need: [object, value, value] -> struct.set -> [value] NO.
      // struct.set takes [ref, value].
      // We want the result of assignment to be 'value'.

      // Strategy:
      // 1. Evaluate object -> [ref]
      // 2. Evaluate value -> [ref, value]
      // 3. Store value in temp -> [ref, value] (local.tee temp)
      // 4. struct.set -> []
      // 5. local.get temp -> [value]

      const tempVal = this.#declareLocal('$$temp_field_set', fieldInfo.type);
      body.push(Opcode.local_tee);
      body.push(...WasmModule.encodeSignedLEB128(tempVal));

      body.push(0xfb, GcOpcode.struct_set);
      body.push(...WasmModule.encodeSignedLEB128(foundClass.structTypeIndex));
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

  #mapType(
    annotation?: TypeAnnotation,
    typeContext?: Map<string, TypeAnnotation>,
  ): number[] {
    if (!annotation) return [ValType.i32];

    // Check type context first
    if (typeContext && typeContext.has(annotation.name)) {
      return this.#mapType(typeContext.get(annotation.name)!, typeContext);
    }

    if (this.#interfaces.has(annotation.name)) {
      const info = this.#interfaces.get(annotation.name)!;
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(info.structTypeIndex),
      ];
    }

    if (annotation.name === 'i32') return [ValType.i32];
    if (annotation.name === 'f32') return [ValType.f32];
    if (annotation.name === 'boolean') return [ValType.i32];
    if (annotation.name === 'string') {
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(this.#stringTypeIndex),
      ];
    }
    if (annotation.name === 'void') return [];

    // Handle generics
    if (annotation.typeArguments && annotation.typeArguments.length > 0) {
      const typeArgKeys = annotation.typeArguments.map((arg) =>
        this.#getTypeKey(arg, typeContext),
      );
      const specializedName = `${annotation.name}<${typeArgKeys.join(',')}>`;

      if (!this.#classes.has(specializedName)) {
        const decl = this.#genericClasses.get(annotation.name);
        if (!decl)
          throw new Error(`Generic class ${annotation.name} not found`);
        this.#instantiateClass(
          decl,
          specializedName,
          annotation.typeArguments,
          typeContext,
        );
      }

      const info = this.#classes.get(specializedName)!;
      return [
        ValType.ref_null,
        ...WasmModule.encodeSignedLEB128(info.structTypeIndex),
      ];
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

  #getTypeKey(
    annotation: TypeAnnotation,
    typeContext?: Map<string, TypeAnnotation>,
  ): string {
    if (typeContext && typeContext.has(annotation.name)) {
      return this.#getTypeKey(typeContext.get(annotation.name)!, typeContext);
    }

    if (annotation.typeArguments && annotation.typeArguments.length > 0) {
      const args = annotation.typeArguments.map((a) =>
        this.#getTypeKey(a, typeContext),
      );
      return `${annotation.name}<${args.join(',')}>`;
    }
    return annotation.name;
  }

  #inferType(expr: Expression): number[] {
    switch (expr.type) {
      case NodeType.StringLiteral:
        return [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(this.#stringTypeIndex),
        ];
      case NodeType.NumberLiteral:
        return [ValType.i32];
      case NodeType.Identifier: {
        const info = this.#resolveLocalInfo((expr as Identifier).name);
        return info.type;
      }
      case NodeType.ThisExpression: {
        if (!this.#currentClass) {
          throw new Error("'this' used outside of class");
        }
        return [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(this.#currentClass.structTypeIndex),
        ];
      }
      case NodeType.MemberExpression: {
        const memberExpr = expr as MemberExpression;
        const objectType = this.#inferType(memberExpr.object);
        const structTypeIndex = this.#getHeapTypeIndex(objectType);
        if (structTypeIndex === -1) {
          return [ValType.i32];
        }

        let foundClass: ClassInfo | undefined;
        for (const info of this.#classes.values()) {
          if (info.structTypeIndex === structTypeIndex) {
            foundClass = info;
            break;
          }
        }

        if (!foundClass) return [ValType.i32];

        const fieldName = memberExpr.property.name;
        const field = foundClass.fields.get(fieldName);
        if (field) {
          return field.type;
        }
        // Method?
        // If it's a method, we might return a function reference or something?
        // For now, let's assume it's a field access.
        return [ValType.i32];
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
        const newExpr = expr as NewExpression;
        let className = newExpr.callee.name;
        let typeArguments = newExpr.typeArguments;

        if (
          (!typeArguments || typeArguments.length === 0) &&
          this.#genericClasses.has(className)
        ) {
          const classDecl = this.#genericClasses.get(className)!;
          const ctor = classDecl.body.find(
            (m) =>
              m.type === NodeType.MethodDefinition && m.name.name === '#new',
          ) as MethodDefinition | undefined;
          if (ctor) {
            typeArguments = this.#inferTypeArgs(
              classDecl.typeParameters!,
              ctor.params,
              newExpr.arguments,
            );
          }
        }

        if (typeArguments && typeArguments.length > 0) {
          const annotation: TypeAnnotation = {
            type: NodeType.TypeAnnotation,
            name: className,
            typeArguments: typeArguments,
          };
          return this.#mapType(annotation, this.#currentTypeContext);
        }
        const classInfo = this.#classes.get(className);
        if (classInfo) {
          return [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(classInfo.structTypeIndex),
          ];
        }
        return [ValType.i32];
      }
      case NodeType.CallExpression: {
        const callExpr = expr as CallExpression;
        if (callExpr.callee.type === NodeType.MemberExpression) {
          const memberExpr = callExpr.callee as MemberExpression;
          const objectType = this.#inferType(memberExpr.object);
          const structTypeIndex = this.#getHeapTypeIndex(objectType);
          if (structTypeIndex === -1) return [ValType.i32];

          let foundClass: ClassInfo | undefined;
          for (const info of this.#classes.values()) {
            if (info.structTypeIndex === structTypeIndex) {
              foundClass = info;
              break;
            }
          }
          if (!foundClass) return [ValType.i32];

          const methodName = memberExpr.property.name;
          const methodInfo = foundClass.methods.get(methodName);
          if (methodInfo) {
            return methodInfo.returnType;
          }
        } else if (callExpr.callee.type === NodeType.Identifier) {
          const name = (callExpr.callee as Identifier).name;
          if (this.#genericFunctions.has(name)) {
            const funcDecl = this.#genericFunctions.get(name)!;
            let typeArguments = callExpr.typeArguments;

            if (!typeArguments || typeArguments.length === 0) {
              typeArguments = this.#inferTypeArgs(
                funcDecl.typeParameters!,
                funcDecl.params,
                callExpr.arguments,
              );
            }

            if (typeArguments && typeArguments.length > 0) {
              const typeContext = new Map<string, TypeAnnotation>();
              for (let i = 0; i < funcDecl.typeParameters!.length; i++) {
                typeContext.set(
                  funcDecl.typeParameters![i].name,
                  typeArguments[i],
                );
              }
              if (funcDecl.returnType) {
                return this.#mapType(funcDecl.returnType, typeContext);
              }
            }
          } else if (this.#functionReturnTypes.has(name)) {
            return this.#functionReturnTypes.get(name)!;
          }
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
    if (
      type.length < 2 ||
      (type[0] !== ValType.ref_null && type[0] !== ValType.ref)
    ) {
      return false;
    }
    const index = this.#getHeapTypeIndex(type);
    return index === this.#stringTypeIndex;
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
    if (Number.isInteger(expr.value)) {
      body.push(Opcode.i32_const);
      body.push(...WasmModule.encodeSignedLEB128(expr.value));
    } else {
      body.push(Opcode.f32_const);
      body.push(...WasmModule.encodeF32(expr.value));
    }
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

  #generateFunctionBody(
    name: string,
    func: FunctionExpression,
    typeContext?: Map<string, TypeAnnotation>,
  ) {
    // Function is already registered in Pass 1
    // We just need to generate the code now.

    const oldContext = this.#currentTypeContext;
    this.#currentTypeContext = typeContext;

    this.#scopes = [new Map()];
    this.#extraLocals = [];
    this.#nextLocalIndex = 0;

    func.params.forEach((p) => {
      const index = this.#nextLocalIndex++;
      this.#scopes[0].set(p.name.name, {
        index,
        type: this.#mapType(p.typeAnnotation, typeContext),
      });
    });

    const body: number[] = [];
    if (func.body.type === NodeType.BlockStatement) {
      this.#generateBlockStatement(func.body, body);
    } else {
      this.#generateExpression(func.body as Expression, body);
    }
    body.push(Opcode.end);

    // Prepend locals
    // We need to construct the full code buffer including locals
    // But addCode takes locals separately.
    // So we return body, and addCode handles locals.
    // But wait, #generateMethodBody calls addCode.
    // So this helper should return body, and #generateMethodBody calls addCode with #extraLocals.

    return body;
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

      this.#module.addCode(funcIndex, locals, body);
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

      this.#module.addCode(funcIndex, locals, body);
    });

    return funcIndex;
  }

  #instantiateClass(
    decl: ClassDeclaration,
    specializedName: string,
    typeArguments: TypeAnnotation[],
    parentContext?: Map<string, TypeAnnotation>,
  ) {
    const context = new Map<string, TypeAnnotation>();
    if (decl.typeParameters) {
      decl.typeParameters.forEach((param, index) => {
        const arg = typeArguments[index];
        context.set(param.name, this.#resolveAnnotation(arg, parentContext));
      });
    }

    const fields = new Map<string, {index: number; type: number[]}>();
    const fieldTypes: {type: number[]; mutable: boolean}[] = [];

    let fieldIndex = 0;
    // Add vtable field
    fields.set('__vtable', {index: fieldIndex++, type: [ValType.eqref]});
    fieldTypes.push({type: [ValType.eqref], mutable: true});

    for (const member of decl.body) {
      if (member.type === NodeType.FieldDefinition) {
        const wasmType = this.#mapType(member.typeAnnotation, context);
        fields.set(member.name.name, {index: fieldIndex++, type: wasmType});
        fieldTypes.push({type: wasmType, mutable: true});
      }
    }

    const structTypeIndex = this.#module.addStructType(fieldTypes);
    const methods = new Map<
      string,
      {
        index: number;
        returnType: number[];
        typeIndex: number;
        paramTypes: number[][];
      }
    >();
    const vtable: string[] = [];

    const classInfo: ClassInfo = {
      structTypeIndex,
      fields,
      methods,
    };
    this.#classes.set(specializedName, classInfo);

    for (const member of decl.body) {
      if (member.type === NodeType.MethodDefinition) {
        const methodName = member.name.name;

        if (methodName !== '#new' && !vtable.includes(methodName)) {
          vtable.push(methodName);
        }

        const thisType = [
          ValType.ref_null,
          ...WasmModule.encodeSignedLEB128(structTypeIndex),
        ];

        const params = [thisType];
        for (const param of member.params) {
          params.push(this.#mapType(param.typeAnnotation, context));
        }

        let resultTypes: number[][] = [[ValType.i32]];
        if (methodName === '#new') {
          resultTypes = [];
        } else if (member.returnType) {
          const mapped = this.#mapType(member.returnType, context);
          if (mapped.length === 0) resultTypes = [];
          else resultTypes = [mapped];
        }

        const typeIndex = this.#module.addType(params, resultTypes);
        const funcIndex = this.#module.addFunction(typeIndex);

        const returnType = resultTypes.length > 0 ? resultTypes[0] : [];
        methods.set(methodName, {
          index: funcIndex,
          returnType,
          typeIndex,
          paramTypes: params,
        });

        this.#pendingMethodGenerations.push(() => {
          this.#generateMethodBody(member, classInfo, context, decl);
        });
      }
    }

    // Create VTable Struct Type
    const vtableTypeIndex = this.#module.addStructType(
      vtable.map(() => ({type: [ValType.funcref], mutable: false})),
    );

    // Create VTable Global
    const vtableInit: number[] = [];
    for (const methodName of vtable) {
      const methodInfo = methods.get(methodName);
      if (!methodInfo) throw new Error(`Method ${methodName} not found`);
      vtableInit.push(Opcode.ref_func);
      vtableInit.push(...WasmModule.encodeSignedLEB128(methodInfo.index));
    }
    vtableInit.push(0xfb, GcOpcode.struct_new);
    vtableInit.push(...WasmModule.encodeSignedLEB128(vtableTypeIndex));

    const vtableGlobalIndex = this.#module.addGlobal(
      [ValType.ref, ...WasmModule.encodeSignedLEB128(vtableTypeIndex)],
      false,
      vtableInit,
    );

    classInfo.vtable = vtable;
    classInfo.vtableTypeIndex = vtableTypeIndex;
    classInfo.vtableGlobalIndex = vtableGlobalIndex;
  }

  #resolveAnnotation(
    annotation: TypeAnnotation,
    context?: Map<string, TypeAnnotation>,
  ): TypeAnnotation {
    if (!context) return annotation;

    if (context.has(annotation.name)) {
      return context.get(annotation.name)!;
    }

    if (annotation.typeArguments) {
      return {
        ...annotation,
        typeArguments: annotation.typeArguments.map((a) =>
          this.#resolveAnnotation(a, context),
        ),
      };
    }

    return annotation;
  }

  #generateMethodBody(
    method: MethodDefinition,
    classInfo: ClassInfo,
    typeContext: Map<string, TypeAnnotation>,
    classDecl: ClassDeclaration,
  ) {
    const methodInfo = classInfo.methods.get(method.name.name)!;

    const prevClass = this.#currentClass;
    const prevContext = this.#currentTypeContext;

    this.#currentClass = classInfo;
    this.#currentTypeContext = typeContext;

    const body = this.#generateMethodBodyCode(method, typeContext, classDecl);
    this.#module.addCode(methodInfo.index, this.#extraLocals, body);

    this.#currentClass = prevClass;
    this.#currentTypeContext = prevContext;
  }

  #generateMethodBodyCode(
    method: MethodDefinition,
    typeContext: Map<string, TypeAnnotation>,
    classDecl: ClassDeclaration,
  ): number[] {
    const body: number[] = [];
    this.#scopes = [new Map()];
    this.#extraLocals = [];
    this.#nextLocalIndex = 0;

    // 'this' is local 0
    this.#nextLocalIndex++;
    this.#thisLocalIndex = 0;

    // Check if we need to cast 'this'
    if (this.#currentClass) {
      const methodInfo = this.#currentClass.methods.get(method.name.name);
      if (methodInfo) {
        const thisType = methodInfo.paramTypes[0];
        // Decode LEB128 index
        let index = 0;
        let shift = 0;
        let i = 1; // Skip ref_null
        while (i < thisType.length) {
          const byte = thisType[i];
          index |= (byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) break;
          shift += 7;
          i++;
        }

        if (index !== this.#currentClass.structTypeIndex) {
          // Cast needed
          const castedType = [
            ValType.ref_null,
            ...WasmModule.encodeSignedLEB128(
              this.#currentClass.structTypeIndex,
            ),
          ];
          const newLocal = this.#declareLocal('$$this_casted', castedType);

          body.push(Opcode.local_get, 0);
          body.push(0xfb, GcOpcode.ref_cast_null);
          body.push(
            ...WasmModule.encodeSignedLEB128(
              this.#currentClass.structTypeIndex,
            ),
          );
          body.push(Opcode.local_set);
          body.push(...WasmModule.encodeSignedLEB128(newLocal));

          this.#thisLocalIndex = newLocal;
        }
      }
    }

    // Initialize fields if constructor
    if (method.name.name === '#new') {
      for (const member of classDecl.body) {
        if (member.type === NodeType.FieldDefinition && member.value) {
          // Generate assignment: this.field = value
          // Load this
          body.push(Opcode.local_get);
          body.push(...WasmModule.encodeSignedLEB128(this.#thisLocalIndex));

          // Generate value
          this.#generateExpression(member.value, body);

          // Set field
          const fieldInfo = this.#currentClass!.fields.get(member.name.name)!;
          body.push(0xfb, GcOpcode.struct_set);
          body.push(
            ...WasmModule.encodeSignedLEB128(
              this.#currentClass!.structTypeIndex,
            ),
          );
          body.push(...WasmModule.encodeSignedLEB128(fieldInfo.index));
        }
      }
    }

    // Params
    for (const param of method.params) {
      this.#scopes[0].set(param.name.name, {
        index: this.#nextLocalIndex++,
        type: this.#mapType(param.typeAnnotation, typeContext),
      });
    }

    // Generate statements
    for (const stmt of method.body.body) {
      this.#generateFunctionStatement(stmt, body);
    }

    // Implicit return 0 if i32 return and no return stmt?
    let returnType: number[] = [ValType.i32];
    if (method.name.name === '#new') {
      returnType = [];
    } else if (method.returnType) {
      returnType = this.#mapType(method.returnType, typeContext);
    }
    if (returnType.length > 0 && returnType[0] === ValType.i32) {
      // Check if last instruction is return or end of block that returns?
      // For now, just push 0. If it's unreachable, WASM validator might complain or optimize.
      // But if we have explicit return, this is unreachable code.
      // Let's assume we need it for now.
      body.push(Opcode.i32_const, 0);
    }
    body.push(Opcode.end);

    // Prepend locals
    // We need to construct the full code buffer including locals
    // But addCode takes locals separately.
    // So we return body, and addCode handles locals.
    // But wait, #generateMethodBody calls addCode.
    // So this helper should return body, and #generateMethodBody calls addCode with #extraLocals.

    return body;
  }

  #instantiateGenericFunction(
    name: string,
    typeArgs: TypeAnnotation[],
  ): number {
    const funcDecl = this.#genericFunctions.get(name);
    if (!funcDecl) throw new Error(`Generic function ${name} not found`);

    const key = `${name}<${typeArgs
      .map((t) => this.#getTypeKey(t, this.#currentTypeContext))
      .join(',')}>`;

    if (this.#functions.has(key)) {
      return this.#functions.get(key)!;
    }

    const typeContext = new Map<string, TypeAnnotation>();
    if (funcDecl.typeParameters) {
      if (funcDecl.typeParameters.length !== typeArgs.length) {
        throw new Error(
          `Expected ${funcDecl.typeParameters.length} type arguments, got ${typeArgs.length}`,
        );
      }
      for (let i = 0; i < funcDecl.typeParameters.length; i++) {
        typeContext.set(funcDecl.typeParameters[i].name, typeArgs[i]);
      }
    }

    const params = funcDecl.params.map((p) =>
      this.#mapType(p.typeAnnotation, typeContext),
    );
    const mappedReturn = funcDecl.returnType
      ? this.#mapType(funcDecl.returnType, typeContext)
      : [ValType.i32];
    const results = mappedReturn.length > 0 ? [mappedReturn] : [];

    const typeIndex = this.#module.addType(params, results);
    const funcIndex = this.#module.addFunction(typeIndex);

    this.#functions.set(key, funcIndex);

    this.#bodyGenerators.push(() => {
      const body = this.#generateFunctionBody(key, funcDecl, typeContext);
      this.#module.addCode(funcIndex, this.#extraLocals, body);
    });

    return funcIndex;
  }

  #getHeapTypeIndex(type: number[]): number {
    if (
      type.length < 2 ||
      (type[0] !== ValType.ref_null && type[0] !== ValType.ref)
    ) {
      return -1;
    }
    // Decode LEB128 starting at index 1
    let result = 0;
    let shift = 0;
    let i = 1;
    while (true) {
      if (i >= type.length) break;
      const byte = type[i];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      i++;
    }
    return result;
  }

  #inferTypeArgs(
    typeParameters: TypeParameter[],
    params: Parameter[],
    args: Expression[],
  ): TypeAnnotation[] {
    const inferred = new Map<string, TypeAnnotation>();
    const typeParamsSet = new Set(typeParameters.map((p) => p.name));

    for (let i = 0; i < Math.min(params.length, args.length); i++) {
      const paramType = params[i].typeAnnotation;
      const argType = this.#inferType(args[i]);
      const argAnnotation = this.#typeToAnnotation(argType);
      if (argAnnotation) {
        this.#unify(paramType, argAnnotation, inferred, typeParamsSet);
      }
    }

    const result: TypeAnnotation[] = [];
    for (const param of typeParameters) {
      if (!inferred.has(param.name)) {
        if (param.default) {
          result.push(param.default);
        } else {
          throw new Error(`Could not infer type for ${param.name}`);
        }
      } else {
        result.push(inferred.get(param.name)!);
      }
    }
    return result;
  }

  #unify(
    param: TypeAnnotation,
    arg: TypeAnnotation,
    inferred: Map<string, TypeAnnotation>,
    typeParams: Set<string>,
  ) {
    if (typeParams.has(param.name)) {
      // It's a type variable we need to infer
      if (inferred.has(param.name)) {
        // Check for conflict? For now, ignore.
      } else {
        inferred.set(param.name, arg);
      }
    } else if (
      param.name === arg.name &&
      param.typeArguments &&
      arg.typeArguments &&
      param.typeArguments.length === arg.typeArguments.length
    ) {
      // Recurse
      for (let i = 0; i < param.typeArguments.length; i++) {
        this.#unify(
          param.typeArguments[i],
          arg.typeArguments[i],
          inferred,
          typeParams,
        );
      }
    }
  }

  #typeToAnnotation(type: number[]): TypeAnnotation | null {
    if (type.length === 1) {
      if (type[0] === ValType.i32)
        return {type: NodeType.TypeAnnotation, name: 'i32'};
      if (type[0] === ValType.f32)
        return {type: NodeType.TypeAnnotation, name: 'f32'};
    }
    if (type[0] === ValType.ref_null && type.length > 1) {
      // Decode LEB128
      let index = 0;
      let shift = 0;
      let i = 1;
      while (i < type.length) {
        const byte = type[i];
        index |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        i++;
      }

      // Check if it's string
      if (index === this.#stringTypeIndex) {
        return {type: NodeType.TypeAnnotation, name: 'string'};
      }

      // Check classes
      for (const [name, info] of this.#classes) {
        if (info.structTypeIndex === index) {
          // If name is "Box<i32>", parse it
          if (name.includes('<')) {
            const match = name.match(/^(.+)<(.+)>$/);
            if (match) {
              const className = match[1];
              const argsStr = match[2];
              // TODO: Better parsing for nested generics
              const args = argsStr.split(',').map(
                (s) =>
                  ({
                    type: NodeType.TypeAnnotation,
                    name: s.trim(),
                  }) as TypeAnnotation,
              );
              return {
                type: NodeType.TypeAnnotation,
                name: className,
                typeArguments: args,
              };
            }
          }
          return {type: NodeType.TypeAnnotation, name: name};
        }
      }
    }
    return null;
  }
}
