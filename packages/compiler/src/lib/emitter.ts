import {ExportDesc, SectionId} from './wasm.js';

export class WasmModule {
  #types: number[][] = [];
  #imports: {module: string; name: string; kind: number; index: number}[] = [];
  #functions: number[] = [];
  #exports: {name: string; kind: number; index: number}[] = [];
  #globals: number[][] = [];
  #codes: number[][] = [];
  #datas: number[][] = [];
  #declaredFunctions: Set<number> = new Set();

  #importedFunctionCount = 0;
  #startFunctionIndex: number | undefined;

  public addType(params: number[][], results: number[][]): number {
    // Function type: 0x60 + vec(params) + vec(results)
    const buffer: number[] = [];
    buffer.push(0x60);

    this.#writeUnsignedLEB128(buffer, params.length);
    for (const param of params) {
      buffer.push(...param);
    }

    this.#writeUnsignedLEB128(buffer, results.length);
    for (const result of results) {
      buffer.push(...result);
    }

    // Simple deduplication could go here, but for now just push
    this.#types.push(buffer);
    const index = this.#types.length - 1;
    return index;
  }

  public addImport(
    module: string,
    name: string,
    kind: number,
    index: number,
  ): number {
    this.#imports.push({module, name, kind, index});
    if (kind === ExportDesc.Func) {
      return this.#importedFunctionCount++;
    }
    // TODO: Handle other import kinds for index calculation
    return -1;
  }

  public addStructType(
    fields: {type: number[]; mutable: boolean}[],
    superTypeIndex?: number,
  ): number {
    const buffer: number[] = [];
    // Always use sub to allow extensibility
    buffer.push(0x50); // sub
    if (superTypeIndex !== undefined) {
      this.#writeUnsignedLEB128(buffer, 1);
      this.#writeUnsignedLEB128(buffer, superTypeIndex);
    } else {
      this.#writeUnsignedLEB128(buffer, 0);
    }

    buffer.push(0x5f); // struct
    this.#writeUnsignedLEB128(buffer, fields.length);
    for (const field of fields) {
      buffer.push(...field.type);
      buffer.push(field.mutable ? 1 : 0);
    }
    this.#types.push(buffer);
    const index = this.#types.length - 1;
    return index;
  }

  public addArrayType(elementType: number[], mutable: boolean): number {
    // Array type: 0x5E + field_type
    // field_type: val_type + mutability
    const buffer: number[] = [];
    buffer.push(0x5e);
    buffer.push(...elementType);
    buffer.push(mutable ? 1 : 0);
    this.#types.push(buffer);
    return this.#types.length - 1;
  }

  public addFunction(typeIndex: number): number {
    this.#functions.push(typeIndex);
    this.#codes.push([]);
    const index = this.#importedFunctionCount + this.#functions.length - 1;
    return index;
  }

  public addCode(index: number, locals: number[][], body: number[]) {
    // Code entry: size (u32) + code
    // code: vec(locals) + expr
    // locals: vec(local)
    // local: n (u32) + type (valtype)

    const definedIndex = index - this.#importedFunctionCount;
    if (definedIndex < 0 || definedIndex >= this.#codes.length) {
      throw new Error(`Invalid function index for code: ${index}`);
    }

    const compressedLocals: {count: number; type: number[]}[] = [];
    if (locals.length > 0) {
      let currentType = locals[0];
      let count = 1;
      for (let i = 1; i < locals.length; i++) {
        if (this.#areTypesEqual(locals[i], currentType)) {
          count++;
        } else {
          compressedLocals.push({count, type: currentType});
          currentType = locals[i];
          count = 1;
        }
      }
      compressedLocals.push({count, type: currentType});
    }

    const codeBuffer: number[] = [];
    this.#writeUnsignedLEB128(codeBuffer, compressedLocals.length); // vec(locals) length
    for (const local of compressedLocals) {
      this.#writeUnsignedLEB128(codeBuffer, local.count);
      codeBuffer.push(...local.type);
    }

    codeBuffer.push(...body);
    // codeBuffer.push(0x0b); // end - Removed to avoid double end

    this.#codes[definedIndex] = codeBuffer;
  }

  public addData(bytes: Uint8Array): number {
    // Passive data segment: 0x01 + vec(bytes)
    const buffer: number[] = [];
    buffer.push(0x01); // Passive
    this.#writeUnsignedLEB128(buffer, bytes.length);
    for (const byte of bytes) {
      buffer.push(byte);
    }
    this.#datas.push(buffer);
    return this.#datas.length - 1;
  }

  public addExport(name: string, kind: number, index: number) {
    this.#exports.push({name, kind, index});
  }

  public addGlobal(type: number[], mutable: boolean, init: number[]): number {
    const buffer: number[] = [];
    buffer.push(...type);
    buffer.push(mutable ? 1 : 0);
    buffer.push(...init);
    buffer.push(0x0b); // end
    this.#globals.push(buffer);
    return this.#globals.length - 1;
  }

  public declareFunction(index: number) {
    this.#declaredFunctions.add(index);
  }

  #areTypesEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  public toBytes(): Uint8Array {
    const buffer: number[] = [];

    // Magic & Version
    buffer.push(0x00, 0x61, 0x73, 0x6d);
    buffer.push(0x01, 0x00, 0x00, 0x00);

    // Type Section
    if (this.#types.length > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#types.length);
      for (const type of this.#types) {
        sectionBuffer.push(...type);
      }
      this.#writeSection(buffer, SectionId.Type, sectionBuffer);
    }

    // Import Section
    if (this.#imports.length > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#imports.length);
      for (const imp of this.#imports) {
        this.#writeString(sectionBuffer, imp.module);
        this.#writeString(sectionBuffer, imp.name);
        sectionBuffer.push(imp.kind);
        this.#writeUnsignedLEB128(sectionBuffer, imp.index);
      }
      this.#writeSection(buffer, SectionId.Import, sectionBuffer);
    }

    // Function Section
    if (this.#functions.length > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#functions.length);
      for (const typeIndex of this.#functions) {
        this.#writeUnsignedLEB128(sectionBuffer, typeIndex);
      }
      this.#writeSection(buffer, SectionId.Function, sectionBuffer);
    }

    // Global Section
    if (this.#globals.length > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#globals.length);
      for (const global of this.#globals) {
        sectionBuffer.push(...global);
      }
      this.#writeSection(buffer, SectionId.Global, sectionBuffer);
    }

    // Export Section
    if (this.#exports.length > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#exports.length);
      for (const exp of this.#exports) {
        this.#writeString(sectionBuffer, exp.name);
        sectionBuffer.push(exp.kind);
        this.#writeUnsignedLEB128(sectionBuffer, exp.index);
      }
      this.#writeSection(buffer, SectionId.Export, sectionBuffer);
    }

    // Start Section
    if (this.#startFunctionIndex !== undefined) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#startFunctionIndex);
      this.#writeSection(buffer, SectionId.Start, sectionBuffer);
    }

    // Element Section (Declarative)
    if (this.#declaredFunctions.size > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, 1); // 1 segment

      // Segment 0: Declarative, func indices
      // Flags: 3 (declarative, elemkind 0x00)
      this.#writeUnsignedLEB128(sectionBuffer, 3);
      this.#writeUnsignedLEB128(sectionBuffer, 0); // elemkind: func

      const indices = Array.from(this.#declaredFunctions).sort((a, b) => a - b);
      this.#writeUnsignedLEB128(sectionBuffer, indices.length);
      for (const index of indices) {
        this.#writeUnsignedLEB128(sectionBuffer, index);
      }

      this.#writeSection(buffer, SectionId.Element, sectionBuffer);
    }

    // DataCount Section
    if (this.#datas.length > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#datas.length);
      this.#writeSection(buffer, SectionId.DataCount, sectionBuffer);
    }

    // Code Section
    if (this.#codes.length > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#codes.length);
      for (const code of this.#codes) {
        const entryBuffer: number[] = [];
        entryBuffer.push(...code);

        this.#writeUnsignedLEB128(sectionBuffer, entryBuffer.length);
        sectionBuffer.push(...entryBuffer);
      }
      this.#writeSection(buffer, SectionId.Code, sectionBuffer);
    }

    // Data Section
    if (this.#datas.length > 0) {
      const sectionBuffer: number[] = [];
      this.#writeUnsignedLEB128(sectionBuffer, this.#datas.length);
      for (const data of this.#datas) {
        sectionBuffer.push(...data);
      }
      this.#writeSection(buffer, SectionId.Data, sectionBuffer);
    }

    return new Uint8Array(buffer);
  }

  #writeSection(buffer: number[], id: number, content: number[]) {
    buffer.push(id);
    this.#writeUnsignedLEB128(buffer, content.length);
    buffer.push(...content);
  }

  #writeString(buffer: number[], str: string) {
    const bytes = new TextEncoder().encode(str);
    this.#writeUnsignedLEB128(buffer, bytes.length);
    bytes.forEach((b) => buffer.push(b));
  }

  #writeUnsignedLEB128(buffer: number[], value: number) {
    value |= 0;
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) {
        byte |= 0x80;
      }
      buffer.push(byte);
    } while (value !== 0);
  }

  public static encodeUnsignedLEB128(value: number): number[] {
    const buffer: number[] = [];
    value |= 0;
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) {
        byte |= 0x80;
      }
      buffer.push(byte);
    } while (value !== 0);
    return buffer;
  }

  public static encodeSignedLEB128(value: number): number[] {
    const buffer: number[] = [];
    value |= 0;
    while (true) {
      let byte = value & 0x7f;
      value >>= 7;
      if (
        (value === 0 && (byte & 0x40) === 0) ||
        (value === -1 && (byte & 0x40) !== 0)
      ) {
        buffer.push(byte);
        break;
      } else {
        buffer.push(byte | 0x80);
      }
    }
    return buffer;
  }

  public static encodeF32(value: number): number[] {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, true); // Little endian
    return Array.from(new Uint8Array(buffer));
  }

  public setStart(functionIndex: number) {
    this.#startFunctionIndex = functionIndex;
  }

  public getType(index: number): number[] {
    return this.#types[index];
  }

  public getFunctionTypeArity(typeIndex: number): number {
    const typeBytes = this.#types[typeIndex];
    if (!typeBytes || typeBytes[0] !== 0x60) {
      throw new Error(`Type ${typeIndex} is not a function type`);
    }

    let offset = 1;
    // Read params count (LEB128)
    let paramCount = 0;
    let shift = 0;
    while (true) {
      const byte = typeBytes[offset++];
      paramCount |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return paramCount;
  }

  public getFunctionTypeParams(typeIndex: number): number[][] {
    const typeBytes = this.#types[typeIndex];
    if (!typeBytes || typeBytes[0] !== 0x60) {
      throw new Error(`Type ${typeIndex} is not a function type`);
    }

    let offset = 1;
    // Read params count (LEB128)
    let paramCount = 0;
    let shift = 0;
    while (true) {
      const byte = typeBytes[offset++];
      paramCount |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }

    const params: number[][] = [];
    for (let i = 0; i < paramCount; i++) {
      // Read param type
      // This is tricky because types can be multi-byte (e.g. ref null <index>).
      // We need a proper type parser.
      // For now, let's assume we can read it.
      // But wait, we don't have a type parser here.
      // However, we wrote the types, so we know the format.
      // But reading back is hard without a full parser.
      // Alternative: Store structured types in WasmModule?
      // Or just store the params separately?
      // WasmModule.#types is number[][].
      // Maybe I should just store the structured info when I add the type?
      // But I can't change the class structure easily without breaking things?
      // Actually I can.
    }
    // Fallback: Return empty array and fail?
    // Or implement a simple parser for the types we support.
    // ValType is simple (1 byte).
    // Ref types are 0x6B/0x6C + heaptype.
    // Heap types are simple or LEB128 index.

    // Let's try to parse.
    const readType = (): number[] => {
      const start = offset;
      const opcode = typeBytes[offset++];
      if (
        opcode === 0x6b || // ref
        opcode === 0x6c || // ref_null
        opcode === 0x63 || // ref_eq
        opcode === 0x64 // ref_i31
      ) {
        // Read heap type
        // Heap type can be abstract (negative/high bit set) or index (positive)
        // But in binary format, it's LEB128.
        let val = 0;
        let s = 0;
        while (true) {
          const b = typeBytes[offset++];
          val |= (b & 0x7f) << s;
          if ((b & 0x80) === 0) break;
          s += 7;
        }
        // We just need to advance offset.
      }
      // Primitive types are 1 byte.
      return typeBytes.slice(start, offset);
    };

    for (let i = 0; i < paramCount; i++) {
      params.push(readType());
    }
    return params;
  }

  public getFunctionTypeIndex(funcIndex: number): number {
    const definedIndex = funcIndex - this.#importedFunctionCount;
    if (definedIndex < 0) {
      // Imported function
      // We need to find the import.
      // This is slow, but okay for now.
      let count = 0;
      for (const imp of this.#imports) {
        if (imp.kind === ExportDesc.Func) {
          if (count === funcIndex) {
            // We don't store the type index for imports directly in #imports?
            // Wait, addImport takes index. Is that the type index?
            return imp.index;
          }
          count++;
        }
      }
      throw new Error(`Imported function ${funcIndex} not found`);
    }
    return this.#functions[definedIndex];
  }

  public getStructFieldType(typeIndex: number, fieldIndex: number): number[] {
    const typeBytes = this.#types[typeIndex];
    let offset = 0;

    // Handle 'sub' (0x50) prefix if present
    if (typeBytes[offset] === 0x50) {
      offset++;
      // Read supertype list length
      let count = 0;
      let shift = 0;
      while (true) {
        const b = typeBytes[offset++];
        count |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      // Skip supertypes (each is a type index)
      for (let i = 0; i < count; i++) {
        while (true) {
          const b = typeBytes[offset++];
          if ((b & 0x80) === 0) break;
        }
      }
    }

    if (typeBytes[offset] !== 0x5f) {
      // struct
      throw new Error(`Type ${typeIndex} is not a struct type`);
    }
    offset++;

    // Read field count
    let fieldCount = 0;
    let shift = 0;
    while (true) {
      const b = typeBytes[offset++];
      fieldCount |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }

    if (fieldIndex >= fieldCount) {
      throw new Error(
        `Field index ${fieldIndex} out of bounds for struct type ${typeIndex}`,
      );
    }

    const readType = (): number[] => {
      const start = offset;
      const opcode = typeBytes[offset++];
      if (opcode === 0x63 || opcode === 0x64) {
        // ref null, ref
        // Read heap type (LEB128)
        while (true) {
          const b = typeBytes[offset++];
          if ((b & 0x80) === 0) break;
        }
      }
      return typeBytes.slice(start, offset);
    };

    for (let i = 0; i < fieldIndex; i++) {
      readType();
      offset++; // Skip mutability byte
    }

    return readType();
  }
}
