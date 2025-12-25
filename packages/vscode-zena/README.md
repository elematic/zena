# Zena Language Support for Visual Studio Code

This extension provides syntax highlighting for the Zena programming language.

## Features

- **Syntax Highlighting** for all Zena language constructs:
  - Keywords (`let`, `var`, `class`, `interface`, `mixin`, `enum`, `type`, `if`, `else`, `while`, `for`, `match`, `case`, etc.)
  - Primitive types (`i32`, `i64`, `u32`, `f32`, `f64`, `boolean`, `string`, `void`, `never`, `any`, `anyref`, `ByteArray`)
  - Built-in types (`Array`, `Map`, `Box`, `Error`, `FixedArray`, `GrowableArray`, `ImmutableArray`, `Sequence`, `Iterator`)
  - String literals (single/double quotes)
  - Template literals with interpolation (backticks with `${}`)
  - Numeric literals (integers, floats, hexadecimal)
  - Comments (line `//` and block `/* */`)
  - Decorators (`@external`, `@intrinsic`, etc.)
  - Operators and punctuation
  - Private fields (`#fieldName`)
  - Constructor (`#new`)
  - Type parameters (`<T>`, `<K, V>`)

## File Extensions

The extension is automatically activated for files with the `.zena` extension.

## Installation

### From VSIX

1. Download the `.vsix` file
2. Open VS Code
3. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
4. Run "Extensions: Install from VSIX..."
5. Select the downloaded file

### From Source

1. Clone this repository
2. Copy the `vscode-zena` folder to your VS Code extensions folder:
   - **Windows**: `%USERPROFILE%\.vscode\extensions`
   - **macOS**: `~/.vscode/extensions`
   - **Linux**: `~/.vscode/extensions`
3. Reload VS Code

## Language Overview

Zena is a statically typed language targeting WebAssembly (WASM-GC). It features TypeScript-like syntax with strict static typing.

### Example

```zena
// Import from host
@external("env", "log")
declare function log(val: string): void;

// Generic class
class Box<T> {
  value: T;

  #new(value: T) {
    this.value = value;
  }

  map<U>(fn: (val: T) => U): Box<U> {
    return new Box(fn(this.value));
  }
}

// Interface
interface Printable {
  toString(): string;
}

// Enum
enum Color {
  Red,
  Green,
  Blue
}

// Main function
export let main = () => {
  let greeting = `Hello, World!`;
  let numbers = #[1, 2, 3];
  let point = { x: 10, y: 20 };

  // Pattern matching
  let result = match (Color.Red) {
    case Color.Red: "red"
    case Color.Green: "green"
    case _: "other"
  };

  log(greeting);
};
```

## Contributing

Contributions are welcome! Please file issues and pull requests on the project repository.

## License

MIT
