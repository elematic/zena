export const prelude = `
// Zena Standard Library Prelude

// Primitive types are implicitly defined: i32, f32, boolean, string, void, null

// ByteArray is exposed as a built-in type for now.

export final class String {
  bytes: ByteArray;
  length: i32;
}

export final class Array<T> {
  length: i32;
}
`;
