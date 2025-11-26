import {SectionId, ValType, ExportDesc} from './wasm.js';

export class WasmModule {
  #types: number[][] = [];
  #functions: number[] = [];
  #exports: {name: string; kind: number; index: number}[] = [];
  #globals: number[][] = [];
  #codes: number[][] = [];
  #datas: number[][] = [];

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

  public addStructType(
    fields: {type: number[]; mutable: boolean}[],
    superTypeIndex?: number,
  ): number {
    // Struct type: 0x5F + vec(field_type)
    // Wrapped in sub: 0x50 + vec(supertype) + struct_type
    const buffer: number[] = [];
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
    return this.#types.length - 1;
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
    this.#codes.push([]); // Reserve slot
    return this.#functions.length - 1;
  }

  public addCode(index: number, locals: number[][], body: number[]) {
    // Code entry: size (u32) + code
    // code: vec(locals) + expr
    // locals: vec(local)
    // local: n (u32) + type (valtype)

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

    this.#codes[index] = codeBuffer;
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

  #writeVector(buffer: number[], data: number[]) {
    this.#writeUnsignedLEB128(buffer, data.length);
    buffer.push(...data);
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
}
