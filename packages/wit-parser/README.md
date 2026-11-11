# wit-parser

A WebAssembly Interface Types (WIT) parser, semantic resolver, `.wit.json`
serializer, and component type encoder for Zena.

## Installation

```bash
zena pkg add zena-lang:wit-parser
```

## Example

```zena
import { parse } from 'zena-lang:wit-parser';
import { AstItemTag } from 'zena-lang:wit-parser/parser';

let source = `
package example:greeter@1.0.0;

interface greet {
  record greeting { text: string, formal: bool }
  hello: func(name: string) -> greeting;
}

interface farewell {
  use greet.{greeting};
  goodbye: func(name: string) -> greeting;
}

world greeter {
  export greet;
  export farewell;
}
`;

// Parses syntax and resolves names and cross-interface `use` references.
// Throws `ParseError` or `ResolveError` if the document is invalid.
let doc = parse(source);

var interfaces = 0;
var worlds = 0;
for (let item in doc.items) {
  if (item.tag == AstItemTag.Interface) {
    interfaces += 1;
  } else if (item.tag == AstItemTag.World) {
    worlds += 1;
  }
}
```

## Libraries

### `zena-lang:wit-parser`

The primary entry point for parsing, resolving, and serializing WIT source text.

| Function                     | Description                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `parse(source)`              | Parses and resolves `source` into a validated `Ast`. Throws `ParseError` or `ResolveError`.         |
| `parseSyntax(source)`        | Parses `source` without resolving names, for single-file syntax tooling such as formatters.         |
| `resolve(ast)`               | Resolves names and validates an `Ast` in place.                                                     |
| `toJson(ast, packageOrder?)` | Serializes a resolved `Ast` to the `.wit.json` format emitted by `wasm-tools component wit --json`. |

`zena-lang:wit-parser` also re-exports `Ast`, `ParseError`, and `ResolveError`. Both
error types carry a `Span` with byte offsets into the source text.

### `zena-lang:wit-parser/parser`

The AST node declarations (`Ast`, `AstItem`, `AstItemTag`, `InterfaceDef`,
`WorldDef`, `TypeDef`, `Type`, `NamedFunc`, `ResourceFunc`, `Use`, `Include`,
`Docs`, `Attribute`, `PackageName`, `NestedPackage`, and related types) and
`Parser`.

### `zena-lang:wit-parser/document`

Utilities for assembling multi-file WIT directories into a single source
document while tracking file boundaries for error reporting:

- `WitFile(name, source)` and `joinWitDocument(files)`: concatenates `.wit`
  files in canonical name order and records where each file starts.
- `WitDocument.locate(offset)`: maps a byte offset back to a `WitLocation`
  (`file`, 1-based `line`, 1-based `column`).
- `witDiagnostic(doc, error)`: formats a `LexError`, `ParseError`, or
  `ResolveError` with its filename, line, column, source line, and caret
  underline.
- `findInterface(ast, namespace, interfacePath)`: looks up an interface (`pkg/iface`)
  in a parsed document.

### `zena-lang:wit-parser/component-encoder`

Encodes a resolved WIT world into WebAssembly Component Model binary type and
import sections:

- `encodeTypesOnlyComponent(ast, worldName)`: encodes the named world as a
  standalone types-only component binary.
- `ComponentTypeEncoder`: emits component type, alias, import, and export
  sections and canonical ABI metadata (`WitFuncMeta`, `WitFlatMeta`).
- `expandedWorldItems(ast, world)` and `worldNames(ast)`: expands world
  `include`s and transitive `use` dependencies.

### `zena-lang:wit-parser/lexer` and `zena-lang:wit-parser/token`

Low-level tokenization: `Lexer`, `LexError`, `Token`, `TokenType`, and `Span`.

### `zena-lang:wit-parser/resolver`

Semantic validation and name resolution: `Resolver` and `ResolveError`.
