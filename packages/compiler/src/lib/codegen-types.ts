export interface ClassInfo {
  structTypeIndex: number;
  fields: Map<string, {index: number; type: number[]}>;
  methods: Map<
    string,
    {
      index: number;
      returnType: number[];
      typeIndex: number;
      paramTypes: number[][];
    }
  >; // name -> {funcIndex, returnType, typeIndex, paramTypes}
  vtable?: string[];
  vtableTypeIndex?: number;
  vtableGlobalIndex?: number;
}

export interface LocalInfo {
  index: number;
  type: number[];
}
