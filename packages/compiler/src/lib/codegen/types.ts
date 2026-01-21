import type {TypeAnnotation} from '../ast.js';

export interface ClassInfo {
  name: string;
  originalName?: string;
  typeArguments?: Map<string, TypeAnnotation>;
  structTypeIndex: number;
  brandTypeIndex?: number;
  superClass?: string;
  fields: Map<string, {index: number; type: number[]; intrinsic?: string}>;
  methods: Map<
    string,
    {
      index: number;
      returnType: number[];
      typeIndex: number;
      paramTypes: number[][];
      isFinal?: boolean;
      intrinsic?: string;
    }
  >; // name -> {funcIndex, returnType, typeIndex, paramTypes, isFinal, intrinsic}
  vtable?: string[];
  vtableTypeIndex?: number;
  vtableGlobalIndex?: number;
  implements?: Map<string, {vtableGlobalIndex: number}>; // interfaceName -> info
  isFinal?: boolean;
  isExtension?: boolean;
  onType?: number[];
  /**
   * Guard to prevent duplicate struct definition.
   * Set to true after defineClassStruct completes.
   */
  structDefined?: boolean;
}

export interface InterfaceInfo {
  structTypeIndex: number;
  vtableTypeIndex: number;
  methods: Map<
    string,
    {index: number; typeIndex: number; returnType: number[]}
  >; // name -> {vtableIndex, typeIndex, returnType}
  fields: Map<string, {index: number; typeIndex: number; type: number[]}>; // name -> {vtableIndex, typeIndex, type}
  parent?: string;
}

export interface LocalInfo {
  index: number;
  type: number[];
}
