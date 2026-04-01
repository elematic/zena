# Parser-in-Zena: Feature Priority & Requirements

Purpose

- Describe the minimal and desirable language and library features needed to implement a Zena parser written in Zena itself.
- Assume host I/O is provided via `declare`/`@external` — the parser will get input bytes/strings and emit output via host calls.

Summary of findings from the current codebase

- The compiler implementation (TypeScript sources in `packages/compiler/src`) and `docs/language-reference.md` show the project already relies on the following features (checked = implemented/available):
  - [x] Classes (including `new()` constructors, initializer lists, and `#` private fields)
  - [x] Interfaces (including symbol-keyed methods)
  - [x] Generics (classes, functions, constraints, inference, defaults)
  - [x] Mixins
  - [x] Records (`{...}`) with optional fields and width subtyping
  - [x] Tuples (`(...)`) — boxed and inline (multi-return)
  - [x] Mutable Arrays (literal `[...]`) and operations (`push`, `pop`, `map`, `length`)
  - [x] Mutable Maps (literal `{"key" => value}`) — `Map` interface with `HashMap` and `OrderedMap` implementations
  - [x] Mutable Sets (`Set<T>`) with `add`, `has`, `delete`, `clear`
  - [x] Strings and `ByteArray`
  - [x] Arrow functions (with contextual typing for closure parameters)
  - [x] Modules: `import` / `export`
  - [x] Host interop: `declare` + `@external`
  - [x] Destructuring (records, tuples, classes, inline tuples)
  - [x] Control flow: `if` / `while` / `for` / `for-in` / `match`
  - [x] Enums (integer-backed and string-backed, with match support)
  - [x] Pipeline operator (`|>` with `$` placeholder)
  - [x] Exception handling (`throw`, `try`/`catch`/`finally`)
  - [x] Symbols (for protocol methods like `:iterator`)
  - [x] Type narrowing (null checks, `is` checks, pattern-based, immutable paths)

- Stdlib presence: `stdlib` contains 32 public modules including `array.zena`, `string.zena`, `console-interface.zena`, `json.zena`, `regex.zena`, `math.zena`, `option.zena`, `byte-buffer.zena`, `cli.zena`, `fs.zena`, `memory.zena`, `test.zena`, and more.

Goals for a bootstrap parser (what we want the parser to be able to do ASAP)

- [ ] Tokenize Zena source: comments, identifiers, keywords, punctuation, string literals, numeric literals (decimal and hex), and operators.
- [ ] Build a simple AST representation (nodes + lists of children) and emit it (e.g. serialize to JSON or call host API to hand AST to the compiler runtime).

Minimal language features to prioritize (implement these first)

1. Lexical support

- [x] Single-line `//` comments (already supported by the language spec)
- [x] Multi-line `/* ... */` comments (already supported by the language spec)
- [x] String literal escapes: `\\`, `\n`, `\r`, `\t`, `\"`, `\'`, `` \` ``, `\$`, `\0`
- [ ] Hex/unicode escapes in strings: `\xHH`, `\uHHHH` (not yet supported in the lexer)
- [x] Numeric literals (decimal integers and floating-point)
- [x] Hex numeric literals: `0x...` (implemented in the lexer)

2. Primitive & core types

- [x] `string` and `ByteArray` or equivalent
- [x] `i32` for counters and token kinds
- [x] `i64`, `f32`, `f64` for additional numeric types
- [x] `boolean` with literal types (`true`, `false`)

3. Mutable growable lists and maps

- [x] Growable list / mutable array with `push`, `pop`, indexing, `length` (required for token lists and AST child lists)
- [x] Mutable map/dictionary with `get`/`set`/`has`/`delete` (string-keyed maps) — `Map` interface with `HashMap` and `OrderedMap` implementations
- [x] Mutable `Set<T>` with `add`, `has`, `delete`, `clear`

4. Records / tuples (immutable) and simple constructors

- [x] Record `{ x: 1 }` syntax with optional fields and width subtyping
- [x] Tuple `(1, 2)` syntax (boxed, immutable)
- [x] Inline tuple `inline (T1, T2)` for multi-return values (zero-allocation)

5. Functions, modules and simple exports

- [x] Arrow functions, `export`, modular code organization
- [x] Contextual typing for closure parameters (e.g., `arr.map((x) => x * 2)`)

6. Control flow and pattern utilities

- [x] `if`, `while`, `for`, `for-in`, `return`, `break`, `continue`
- [x] `match` expressions with exhaustiveness checking
- [x] `if (let pattern = expr)` and `while (let pattern = expr)` conditions
- [x] Pipeline operator `|>` with `$` placeholder

Reasoning about the minimal set

- [x] A lexer + recursive-descent parser can be implemented using only: strings, integer arithmetic, mutable arrays, maps, records/tuples and functions. Classes, generics, and interfaces make implementing an idiomatic AST nicer, but are not strictly required for a first-pass parser.

Already-available features useful for parser implementation

These features were previously listed as "desirable / next-phase" but are now implemented:

- [x] Enum syntax — useful for token kinds and AST discriminants. Integer-backed and string-backed enums are supported, including match patterns on enum members.
- [x] Pattern matching (`match`) — full support with literal, identifier, wildcard, class, record, tuple, logical (`|`, `&`), guard, and `as` patterns. Exhaustiveness checking is enforced.
- [x] `for-in` loops — iterate over any `Iterable<T>` (e.g., `for (let entry in map) { ... }`).
- [x] `Option<T>` type — `Some<T> | None` for safe nullable handling (available in `zena:option` prelude).
- [x] JSON module (`zena:json`) — `JsonValue`, `JsonObject`, `JsonArray` with source location tracking. Useful for AST serialization.
- [x] StringBuilder (`zena:string-builder`) — efficient string concatenation for output generation.
- [x] ByteBuffer (`zena:byte-buffer`) — growable binary buffer, useful for binary output.
- [x] Regex module (`zena:regex`) — Thompson NFA engine with character classes, quantifiers, groups, and anchors (no backreferences by design).
- [x] Math module (`zena:math`) — `abs`, `ceil`, `floor`, `sqrt`, `min`, `max`, `clz`, `ctz`, integer constants.
- [x] Error hierarchy — `Error`, `LookupError`, `IndexOutOfBoundsError`, `KeyNotFoundError`.
- [x] Test framework (`zena:test`) — `TestContext`, `Suite`, `TestResult` for writing parser tests in Zena.
- [x] CLI module (`zena:cli`) — `getArguments()`, `getEnvironment()`, `exit()` for command-line tools.
- [x] Filesystem module (`zena:fs`) — WASI P1-based file I/O for reading source files.

Remaining desirable features (not yet implemented)

- [ ] ADT / Tagged Union support (sum types) — would make AST node definitions more ergonomic and type-safe. Can be emulated with classes + `match` or `{ kind: String, payload: ... }` records.
- [ ] Regular expression _literals_ — the regex engine exists in the stdlib but there's no literal syntax (use `Regex.compile("pattern")` instead).
- [ ] Richer numeric literal support (binary `0b`, octal `0o`, underscores in numeric literals).
- [ ] Hex/unicode escape sequences in string literals (`\xHH`, `\uHHHH`).

Library/runtime notes (what to ensure exists before writing the parser in Zena)

- [x] `String` helpers: indexing (`getByteAt`), substring (`sliceBytes`), `length`, `fromByteArray`, `fromParts` (stdlib `string.zena`).
- [x] `ByteArray` or mutable buffer for efficient byte-level scanning (stdlib `byte-array.zena`).
- [x] `ByteBuffer` for growable binary data construction (stdlib `byte-buffer.zena`).
- [x] `StringBuilder` for efficient string concatenation (stdlib `string-builder.zena`).
- [x] Growable `Array<T>` with `push`, `pop`, indexing, `length` (stdlib `growable-array.zena`).
- [x] `Map<K, V>` (interface) with `HashMap` / `OrderedMap` implementations, `get`/`set`/`has`/`delete` (stdlib `map.zena`).
- [x] `Set<T>` with `add`/`has`/`delete`/`clear` (stdlib `set.zena`).
- [x] JSON encoder/parser for AST serialization (stdlib `json.zena`).
- [x] Test framework for parser tests (stdlib `test.zena`).
- [x] `StringReader` for safe UTF-8 parsing (stdlib `string-reader.zena`).

Recommended development priority (order)

- [x] 1. ~~Implement minimal runtime helpers~~ — string indexing, growable array, and map are all available in the stdlib.
- [ ] 2. Implement the lexer in Zena with tests for tokens, escapes, and numeric literals.
- [ ] 3. Implement a small AST representation (classes or records) and a JSON serializer (using `zena:json`).
- [ ] 4. Implement a recursive-descent parser for expressions and statements and test against `examples/*.zena` files.
- [ ] 5. ~~Add enums/ADT sugar~~ — enums are already available. Consider ADT/tagged unions for stronger AST typing if desired.

Minimal parser acceptance criteria

- Lexer tests:
  - [ ] All token kinds (identifiers, keywords, numbers, strings, punctuation).
  - [ ] Correct handling of `//` and `/* */` comments.
  - [ ] Correct processing of escape sequences in strings.
- Parser tests:
  - [ ] Variable and function declarations.
  - [ ] `if/while/for/for-in` statements.
  - [ ] Arrow function syntax and call expressions.
  - [ ] Module-level `export` and `declare` statements.
  - [ ] Class and enum declarations.
  - [ ] Match expressions.

Notes and trade-offs

- [x] If you need to move faster, write the lexer first and have it emit a simple token stream that is consumed by a minimal parser written in the host (TypeScript). This lets you iterate on runtime/data-structure design while the Zena runtime matures.
- [x] Classes, generics, and full inheritance can be added later; they are helpful for code organization and type safety but are not blockers for an initial Zena-based parser.

Appendix: Quick checklist for writing the parser in Zena now

- [x] Ensure `string` indexing and substring is available (`getByteAt`, `sliceBytes`).
- [x] Provide `Array<T>` (growable) with `push`, `pop`, and `length`.
- [x] Provide `Map<K, V>` get/set/has APIs (`HashMap` and `OrderedMap` implementations, literal syntax `{"key" => value}`).
- [x] Provide `Set<T>` with `add`/`has`/`delete`.
- [x] Provide `StringBuilder` for efficient string concatenation.
- [x] Provide `JSON` module for AST serialization (`zena:json`).
- [x] Provide test framework (`zena:test`).
- [x] `0x` hex integer parsing (implemented in lexer).
- [x] Basic string escape decoding (`\\`, `\n`, `\r`, `\t`, `\"`, `\'`, `` \` ``, `\$`, `\0`).
- [ ] Implement hex/unicode string escape decoding (`\xHH`, `\uHHHH`).

Syntax changes since initial document

- **Constructor syntax**: Changed from `#new()` to `new()`.
- **Array literal syntax**: Changed from `#[...]` to `[...]` (`FixedArray` inline literals).
- **Tuple literal syntax**: Changed from `[...]` to `(...)` (boxed tuples).
- **Map literal syntax**: Changed from `#{ key: value }` to `{"key" => value}` (uses `=>` separator).
- **Inline tuples**: New `inline (T1, T2)` syntax for zero-allocation multi-return values.
- **Field mutability**: `let` (immutable) vs `var` (mutable) for class fields.
- **Initializer lists**: `new(x: i32) : field = x, super(...) { }` syntax.
- **Pipeline operator**: `data |> transform($) |> validate($)`.
- **Range operator**: `1..10`, `..5`, `5..`, `..` for ranges.
- **Symbols**: `static symbol iterator;` and `obj.:symbol()` for protocol methods.
- **Contextual typing**: Numeric literals infer type from context; closure parameters inferred from expected function type.

---

Updated on: 2026-03-23
