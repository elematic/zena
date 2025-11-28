# Regular Expression Design

## Overview

Regular expressions (regex) provide pattern matching capabilities for string
processing. This document outlines the design for supporting regular expressions
in Zena.

## Goals

1.  **No Special Literals**: Avoid regex-specific literals (like `/pattern/`) to
    keep the parser simple and consistent.
2.  **Pay-to-Play**: The regex library should only be included in the output if
    it is actually used (Dead Code Elimination).
3.  **Standard API**: Provide a familiar API for regex operations.
4.  **Future Optimization**: Enable compile-time code generation for
    statically-known patterns.

## Syntax

### Basic Usage

Regular expressions are created via a constructor:

```typescript
import {Regex} from 'zena:regex';

const pattern = new Regex('ab+c');
const result = pattern.test('abbbc'); // true
```

### Tagged Template Literals (Future)

If/when tagged template literals are supported, a more ergonomic syntax becomes
available:

```typescript
import {regex} from 'zena:regex';

const pattern = regex`ab+c`;
```

**Benefits of template literals**:

-   Raw strings (no excess escaping, e.g., `\d` instead of `\\d`)
-   Composition with expressions (e.g., `` regex`user_${userId}` ``)
-   Potential for compile-time optimization of static patterns

## Implementation Strategy

### Runtime Library

The regex engine will be implemented as a standard library module (`zena:regex`).
Two approaches are considered:

#### Option 1: Pure Zena Implementation

Implement a regex engine entirely in Zena.

**Pros**:

-   No external dependencies
-   Full control over behavior and optimizations
-   Self-contained in the Zena ecosystem

**Cons**:

-   Significant implementation effort
-   Performance may lag behind mature engines
-   Requires implementing a full NFA/DFA engine

#### Option 2: External WASM Library

Bundle or link to an existing regex library compiled to WASM.

**Candidates**:

-   **RE2** (Google's regex library): Linear time guarantees, no backtracking
    -   re2-wasm (npm package): Note - this is a Node.js
      package, not directly usable
    -   Would need a pure WASM build of RE2
-   **Rust regex crate**: Well-optimized, could be compiled to WASM
-   **Custom minimal engine**: Thompson NFA for basic patterns

**Pros**:

-   Mature, battle-tested implementations
-   Better performance for complex patterns

**Cons**:

-   External dependency
-   Binary size impact
-   Integration complexity

### Recommended Approach

**Phase 1: Pure Zena Implementation**

Start with a pure Zena implementation using a Thompson NFA-based engine:

1.  Supports basic regex features (character classes, quantifiers, groups)
2.  Guarantees linear time complexity (no catastrophic backtracking)
3.  Enables full dead code elimination

**Phase 2: Compile-Time Optimization**

For statically-known patterns (string literals or template literals without
interpolation):

1.  Parse the pattern at compile time
2.  Generate specialized matching code
3.  Inline the state machine into the compiled WASM

**Phase 3: Advanced Features (Optional)**

If needed, add support for:

-   Backreferences (requires backtracking engine)
-   Look-ahead/look-behind assertions
-   Named capture groups

## Proposed API

### Regex Class

```typescript
export class Regex {
  // Constructor - compiles the pattern
  #new(pattern: string);

  // Test if the pattern matches anywhere in the input
  test(input: string): boolean;

  // Find the first match
  exec(input: string): Match | null;

  // Find all matches
  matchAll(input: string): Array<Match>;

  // Replace first match
  replace(input: string, replacement: string): string;

  // Replace all matches
  replaceAll(input: string, replacement: string): string;

  // Split string by pattern
  split(input: string): Array<string>;
}
```

### Match Class

```typescript
export class Match {
  // The matched substring
  value: string;

  // Start index in the input string
  index: i32;

  // Captured groups (if any)
  groups: Array<string>;
}
```

### Flags

Regex flags can be passed as an optional second argument or encoded in the
pattern:

```typescript
const caseInsensitive = new Regex('hello', 'i');
// OR
const caseInsensitive = new Regex('(?i)hello');
```

**Supported Flags**:

-   `i`: Case-insensitive matching
-   `m`: Multi-line mode (^ and $ match line boundaries)
-   `s`: Dot matches newline
-   `g`: Global matching (affects `replace`, `matchAll`)

## Unicode Support

Given Zena's UTF-8 string representation:

-   Patterns match against UTF-8 byte sequences by default
-   Character classes (`\w`, `\d`, `\s`) operate on ASCII by default
-   A `u` flag or Unicode mode can enable full Unicode support (future)

**Considerations**:

-   Matching grapheme clusters vs code points vs bytes
-   Unicode character properties (`\p{Letter}`)
-   Normalization requirements

## Module System Integration

The regex module follows the standard library conventions:

```typescript
// Explicit import - only includes regex if used
import {Regex} from 'zena:regex';
```

The `zena:` prefix indicates a standard library module, similar to Node.js's
`node:` prefix.

## Binary Size Considerations

Regex engines can be large. To minimize impact:

1.  **DCE**: Aggressive dead code elimination ensures unused features are not
    included
2.  **Lazy Loading**: Consider lazy initialization of the regex engine
3.  **Tiered Implementation**: Basic patterns use simpler code paths

**Estimated Size Impact**:

-   Minimal engine (literals, basic character classes): ~2-5 KB
-   Full NFA engine (all basic features): ~10-20 KB
-   With Unicode tables: +50-100 KB

## Security Considerations

### ReDoS Prevention

Regular Expression Denial of Service (ReDoS) occurs when patterns cause
exponential backtracking on certain inputs.

**Mitigation**:

-   Use Thompson NFA (linear time guarantee)
-   If backtracking is needed, implement timeouts or step limits
-   Consider static analysis of patterns for risky constructs

### Pattern Injection

If patterns are constructed from user input:

-   Provide an `escape()` function to sanitize strings
-   Document risks of dynamic pattern construction

## Comparison with Other Languages

| Feature                | JavaScript       | Rust             | Zena (Proposed)  |
| ---------------------- | ---------------- | ---------------- | ---------------- |
| Literal Syntax         | `/pattern/flags` | None             | None             |
| Constructor            | `new RegExp()`   | `Regex::new()`   | `new Regex()`    |
| Backtracking           | Yes              | No (by default)  | No (Phase 1)     |
| Unicode Support        | Yes (`u` flag)   | Yes              | Future           |
| Compile-Time Patterns  | No               | Yes (`regex!`)   | Future (Phase 2) |

## Future Considerations

-   **Compile-Time Validation**: Report pattern syntax errors at compile time
    for static patterns
-   **Code Generation**: Generate specialized matchers for static patterns
-   **JIT Compilation**: If Zena ever supports code generation at runtime
-   **PCRE Compatibility**: Support more advanced features for JS migration

## Implementation Plan

1.  **Phase 1**: Basic implementation
    -   Parser for regex patterns
    -   Thompson NFA construction
    -   Basic matching (`test`, `exec`)
    -   String operations (`replace`, `split`)

2.  **Phase 2**: Optimization
    -   Compile-time pattern parsing
    -   Specialized code generation for static patterns
    -   Performance benchmarking

3.  **Phase 3**: Advanced features
    -   Unicode support
    -   Named capture groups
    -   Additional assertions

## Open Questions

1.  **Engine Choice**: Should we prioritize simplicity (pure Zena) or
    performance (external library)?

2.  **Unicode**: What level of Unicode support is required initially?

3.  **Compatibility**: Should we aim for JavaScript regex compatibility or
    design a cleaner subset?

4.  **Syntax**: If tagged template literals are added, should `regex` be the
    standard tag name?
