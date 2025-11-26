export interface ClassInfo {
  name: string;
  structTypeIndex: number;
  superClass?: string;
  fields: Map<string, {index: number; type: number[]}>;
  methods: Map<
    string,
    {
      index: number;
      returnType: number[];
      typeIndex: number;
      paramTypes: number[][];
      isFinal?: boolean;
    }
  >; // name -> {funcIndex, returnType, typeIndex, paramTypes, isFinal}
  vtable?: string[];
  vtableTypeIndex?: number;
  vtableGlobalIndex?: number;
  implements?: Map<string, {vtableGlobalIndex: number}>; // interfaceName -> info
}

export interface InterfaceInfo {
  structTypeIndex: number;
  vtableTypeIndex: number;
  methods: Map<string, {index: number; typeIndex: number}>; // name -> {vtableIndex, typeIndex}
}

export interface LocalInfo {
  index: number;
  type: number[];
}
