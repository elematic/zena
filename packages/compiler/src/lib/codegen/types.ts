import type {TypeAnnotation} from '../ast.js';
import type {ClassType} from '../types.js';

export interface ClassInfo {
  name: string;
  originalName?: string;
  typeArguments?: Map<string, TypeAnnotation>;
  structTypeIndex: number;
  brandTypeIndex?: number;
  superClass?: string;
  /**
   * The checker's ClassType for the superclass, if available.
   * Enables identity-based lookup of superclass ClassInfo.
   */
  superClassType?: ClassType;
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
  /**
   * For extension classes: the WASM type bytes representing the underlying type.
   * This is computed from `onTypeAnnotation` using the type context.
   * For generic extension classes, this may need to be recomputed at each use site
   * because different contexts produce different WASM array type indices.
   *
   * TODO(refactoring): Migrate to computing from `onTypeAnnotation` on demand.
   * See docs/design/compiler-refactoring.md "Future: Migrate from onType to onTypeAnnotation".
   */
  onType?: number[];
  /**
   * For extension classes: the Zena TypeAnnotation from the declaration.
   * e.g., for `extension class FixedArray<T> on array<T>`, this is `array<T>`.
   * Used to recompute `onType` with the correct type context at each use site.
   */
  onTypeAnnotation?: TypeAnnotation;
  /**
   * Guard to prevent duplicate struct definition.
   * Set to true after defineClassStruct completes.
   */
  structDefined?: boolean;
}

export interface InterfaceInfo {
  name: string;
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
