# Portable Semantics Tests

This directory contains portable semantics (type checker) tests for Zena. These tests are `.zena` files with type-checking assertions, run by the self-hosted checker.

## Conventions

- Each `.zena` file tests ONE type-checking behavior (small, focused).
- Files are auto-detected as `// @mode: check` when under `semantics/`.
- File names are `kebab-case` with underscores for compound names.
- Directories group related constructs into suites.
- **Error tests** use `// @error: pattern` on the line that should produce an error.
- **Warning tests** use `// @warning: pattern` on the line that should produce a warning.
- **Positive tests** have no `// @error:` — they must produce zero errors.
- Error patterns are matched as **substrings** by the runner. Keep them simple.

### Placement Rules

- `destructuring/` is for **irrefutable binding forms** in declaration sites (`let`/`var` destructure, parameter destructure, for-in destructure).
- `control-flow/match/` is for **match-expression behavior** (exhaustiveness, guards, unreachable arms, match-specific narrowing).
- `patterns/` is for **reusable pattern-language semantics** that are not owned by one syntax site (class/literal/composite/as patterns, and refutability rules reused by `match`, `if-let`, `while-let`, and declarations).

## Test Format

### Error tests (checking that bad code is rejected)

```zena
// @mode: check
let x: i32 = "hello"; // @error: Type mismatch
```

### Positive tests (checking that valid code type-checks)

```zena
// @mode: check
let add = (a: i32, b: i32): i32 => a + b;
let result: i32 = add(1, 2);
```

### Type inference tests (`// @type:` directive)

```zena
// @mode: check
let x = 42;           // @type: i32
let y = 3.14;         // @type: f64
let z = true;         // @type: true
var w = true;          // @type: boolean
```

The runner:

1. Parses the source and runs the checker.
2. For each `// @type: <expected>` comment, finds the nearest preceding expression or variable declaration on that line.
3. Compares the inferred type's display string against `<expected>`.

## Porting & Testing Workflow

1. Create the `.zena` file in the appropriate `tests/language/semantics/` directory.
2. Run `npm test -w @zena-lang/zena-compiler` to verify it passes the checker.
3. If the checker fails, either fix the checker or mark the test as known-failing (skip list in `portable_test.zena`).
