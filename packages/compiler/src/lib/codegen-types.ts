export interface ClassInfo {
  structTypeIndex: number;
  fields: Map<string, {index: number; type: number[]}>;
  methods: Map<string, {index: number; returnType: number[]}>; // name -> {funcIndex, returnType}
  vtable?: string[];
  vtableTypeIndex?: number;
  vtableGlobalIndex?: number;
}

export interface LocalInfo {
  index: number;
  type: number[];
}
