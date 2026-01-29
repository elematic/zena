/**
 * Returns the internal name for the getter of a property.
 */
export function getGetterName(propertyName: string): string {
  return `get#${propertyName}`;
}

/**
 * Returns the internal name for the setter of a property.
 */
export function getSetterName(propertyName: string): string {
  return `set#${propertyName}`;
}

/**
 * Returns true if the given name is an internal getter name.
 */
export function isGetterName(name: string): boolean {
  return name.startsWith('get#');
}

/**
 * Returns true if the given name is an internal setter name.
 */
export function isSetterName(name: string): boolean {
  return name.startsWith('set#');
}

/**
 * Extracts the property name from an internal accessor name.
 * Assumes the name is a valid getter or setter name.
 */
export function getPropertyNameFromAccessor(accessorName: string): string {
  return accessorName.slice(4);
}

import type {FunctionType, Type} from './types.js';

/**
 * Generates a signature key for a function type based on its parameter types.
 * Used to create unique keys for overloaded methods.
 * E.g., (i32, f32) -> "$i32$f32"
 */
export function getSignatureKey(funcType: FunctionType): string {
  if (funcType.parameters.length === 0) {
    return '$void';
  }
  return '$' + funcType.parameters.map((p) => getTypeKey(p)).join('$');
}

/**
 * Generates a short key for a type. Used in signature mangling.
 */
function getTypeKey(type: Type): string {
  switch (type.kind) {
    case 'Number':
      return (type as any).name; // i32, f32, etc.
    case 'Boolean':
      return 'bool';
    case 'ByteArray':
      return 'string';
    case 'Null':
      return 'null';
    case 'Void':
      return 'void';
    case 'Class':
      return (type as any).name;
    case 'Interface':
      return (type as any).name;
    case 'Array':
      return `arr_${getTypeKey((type as any).elementType)}`;
    case 'Record':
      return 'rec';
    case 'Tuple':
      return `tup${(type as any).elementTypes.length}`;
    case 'Union':
      return 'union';
    case 'TypeParameter':
      return (type as any).name;
    default:
      return 'unknown';
  }
}

/**
 * Gets the mangled method name for an overloaded method.
 * If the method has overloads, appends a signature key.
 * E.g., "print" with signature (i32) -> "print$i32"
 */
export function getMangledMethodName(
  baseName: string,
  funcType: FunctionType,
  hasOverloads: boolean,
): string {
  if (!hasOverloads) {
    return baseName;
  }
  return baseName + getSignatureKey(funcType);
}

/**
 * Gets the base method name from a potentially mangled name.
 * E.g., "print$i32" -> "print"
 */
export function getBaseMethodName(mangledName: string): string {
  const dollarIndex = mangledName.indexOf('$');
  if (dollarIndex === -1) {
    return mangledName;
  }
  return mangledName.slice(0, dollarIndex);
}
