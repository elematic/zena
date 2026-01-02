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
