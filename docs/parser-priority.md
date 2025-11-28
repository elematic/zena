# Parser-in-Zena: Feature Priority & Requirements

Purpose

- Describe the minimal and desirable language and library features needed to implement a Zena parser written in Zena itself.
- Assume host I/O is provided via `declare`/`@external` — the parser will get input bytes/strings and emit output via host calls.

Summary of findings from the current codebase

- The compiler implementation (TypeScript sources in `packages/compiler/src`) and `docs/language-reference.md` show the project already relies on the following features (checked = implemented/available):
  - [x] Classes (including `#new` constructors and `#` private fields)
  - [x] Interfaces
  - [x] Generics
  - [x] Mixins
  - [x] Records (`{...}`) and Tuples (`[...]`)
  - [x] Mutable Arrays (literal `#[ ... ]`) and operations
  - [x] Mutable Maps (literal `#{ ... }`) and operations
  - [x] Strings and `ByteArray`
  - [x] Arrow functions
  - [x] Modules: `import` / `export`
  - [x] Host interop: `declare` + `@external`
  - [x] Destructuring (records, tuples, classes)
  - [x] Control flow: `if` / `while` / `for`

- Stdlib presence: `stdlib` contains `array.zena`, `string.zena`, and `console.zena` indicating collection and string helpers exist.

Goals for a bootstrap parser (what we want the parser to be able to do ASAP)

- [ ] Tokenize Zena source: comments, identifiers, keywords, punctuation, string literals, numeric literals (decimal and hex), and operators.
- [ ] Build a simple AST representation (nodes + lists of children) and emit it (e.g. serialize to JSON or call host API to hand AST to the compiler runtime).

Minimal language features to prioritize (implement these first)

1. Lexical support
  - [x] Single-line `//` comments (already supported by the language spec)
  - [x] Multi-line `/* ... */` comments (already supported by the language spec)
  - [ ] String literal escapes: `\\`, `\n`, `\r`, `\t`, `\"`, `\'`
  - [ ] Hex/unicode escapes in strings: `\xHH`, `\uHHHH` (at least implement `\xHH`)
  - [x] Numeric literals (decimal integers)
  - [ ] Hex numeric literals: `0x...` (recommended for lexer support)

2. Primitive & core types
  - [x] `string` and `ByteArray` or equivalent
  - [x] `i32` for counters and token kinds

3. Mutable growable lists and maps
  - [x] Growable list / mutable array with `push`, indexing, `length` (required for token lists and AST child lists)
  - [x] Mutable map/dictionary with `get`/`set`/`has`/`delete` (string-keyed maps)

4. Records / tuples (immutable) and simple constructors
  - [x] Record `{ x: 1 }` and tuple `[1, 2]` syntax (useful for concise AST nodes)

5. Functions, modules and simple exports
  - [x] Arrow functions, `export`, modular code organization

6. Control flow and pattern utilities
  - [x] `if`, `while`, `for`, `return`

Reasoning about the minimal set

- [x] A lexer + recursive-descent parser can be implemented using only: strings, integer arithmetic, mutable arrays, maps, records/tuples and functions. Classes, generics, and interfaces make implementing an idiomatic AST nicer, but are not strictly required for a first-pass parser.

Desirable (next-phase) language features to add soon

- [ ] ADT / Tagged Union support (sum types) — makes AST node definitions ergonomic and type-safe. Can be emulated with `{ kind: string, payload: ... }` if necessary.
- [ ] Enum syntax — helpful for token kinds and AST discriminants.
- [ ] Pattern matching (`match`) — improves AST transformations; can be deferred.
- [ ] Regular expression literals — optional; useful for lexer convenience but not required.
- [ ] Richer numeric literal support (binary `0b`, octal `0o`, underscores) and additional escape sequences.

Library/runtime notes (what to ensure exists before writing the parser in Zena)

- [x] `String` helpers: indexing (charAt/read byte), substring, length, codePoint iteration (stdlib includes `string.zena`).
- [x] `ByteArray` or mutable buffer if efficient byte-level scanning is required.
- [x] `List` (growable) and `Map<string, T>` implementations (stdlib includes `array.zena`).
- [ ] A `JSON` encoder or simple serializer for AST nodes (useful for bootstrapping and testing).

Recommended development priority (order)

- [ ] 1. Implement minimal runtime helpers: string indexing + growable array + simple map (if any are missing or incomplete).
- [ ] 2. Implement the lexer in Zena with tests for tokens, escapes, and numeric literals.
- [ ] 3. Implement a small AST representation as records / lists and a JSON serializer.
- [ ] 4. Implement a recursive-descent parser for expressions and statements and test against `examples/*.zena` files.
- [ ] 5. Add enums/ADT sugar and refactor AST to use them if desired for stronger typing.

Minimal parser acceptance criteria

- Lexer tests:
  - [ ] All token kinds (identifiers, keywords, numbers, strings, punctuation).
  - [ ] Correct handling of `//` and `/* */` comments.
  - [ ] Correct processing of escape sequences in strings.
- Parser tests:
  - [ ] Variable and function declarations.
  - [ ] `if/while/for` statements.
  - [ ] Arrow function syntax and call expressions.
  - [ ] Module-level `export` and `declare` statements.

Notes and trade-offs

- [x] If you need to move faster, write the lexer first and have it emit a simple token stream that is consumed by a minimal parser written in the host (TypeScript). This lets you iterate on runtime/data-structure design while the Zena runtime matures.
- [x] Classes, generics, and full inheritance can be added later; they are helpful for code organization and type safety but are not blockers for an initial Zena-based parser.

Appendix: Quick checklist for writing the parser in Zena now

- [ ] Ensure `string` indexing and substring is available.
- [x] Provide `List` (growable array) with `push` and `length`.
- [x] Provide `Map<string, T>` get/set/has APIs (or ensure `#{ ... }` works as expected in your runtime).
- [ ] Implement string escape decoding (`\\`, `\n`, `\t`, `\xHH`, `\uHHHH`).
- [ ] Implement `0x` hex integer parsing.

If you want, I can now:

- [ ] Generate a lightweight parser skeleton in TypeScript to translate into Zena, or
- [ ] Start a Zena runtime/stdlib sketch (small `list`, `map`, `string` helpers) and a lexer implementation in Zena source.

---
Generated on: 2025-11-28
