---
title: 'Comments'
description: 'Line comments, block comments, and doc comments in Zena.'
---

Zena supports three styles of comments: single-line comments (`//`), multi-line
block comments (`/* */`), and documentation comments (`/** */`).

## Line comments (//)

Single-line comments begin with `//` and extend to the end of the physical line:

```zena
// Calculate the bounding box dimensions
let width = right - left;
let height = bottom - top; // Trailing comment
```

Line comments can appear on their own lines or at the end of a line of code. They are
ignored by the compiler and are never treated as documentation comments, even when
written with three slashes (`///`).

## Block comments (/\* \*/)

Block comments begin with `/*` and end with `*/`. They can span multiple lines:

```zena
/*
 * Configuration defaults applied when
 * no custom options are provided.
 */
let defaultTimeout = 5000;
```

Block comments can also appear inline within expressions or parameter lists:

```zena
let total = calculateTotal(
  basePrice,
  /* discountPercent = */ 15,
  /* taxRate = */ 0.08
);
```

### No comment nesting

Block comments cannot be nested. The first `*/` encountered terminates the comment:

```zena
/* Outer comment
  /* Inner comment */
  let x = 1; // Syntax error: outside of comment
*/
```

## Doc comments

Doc comments are block comments that begin with `/**` and end with `*/`. They are
associated as leading comments with the declaration immediately following them:

```zena
/**
 * Represents a two-dimensional geometric vector.
 */
class Vector2D {
  x: f64;
  y: f64;
  new(this.x, this.y);
}
```

Doc comments are extracted by the Zena documentation tool (`zenadoc`) to produce
API documentation and are displayed in hover tooltips by the Zena language server.

### Doc comment attachment

A doc comment attaches to any declaration it immediately precedes, including:

- Top-level declarations (`function`, `class`, `interface`, `mixin`, `enum`, `type`)
- Class and interface members (methods, fields, accessors, constructors, operators)
- Enum members
- Sealed class variants
- Case class parameters
- Record type fields

Line comments (`//` or `///`) are never treated as doc comments. If a declaration
is preceded only by line comments, it is considered undocumented by tooling.

When multiple `/** ... */` comments appear consecutively before a declaration,
tooling joins them into a single documentation comment in source order:

```zena
/** First paragraph of documentation. */
/** Second paragraph of documentation. */
function process(): void {}
```

### Markdown formatting

The body of a doc comment is parsed as Markdown after stripping the leading `*`
prefix and one following space from each line:

- **Paragraphs**: Separated by blank lines (`*`).
- **Lists**: Bulleted (`-`, `*`) and numbered lists are supported.
- **Code spans and blocks**: Inline code with backticks (`` `value` ``) and fenced code
  blocks (` ```zena ... ``` `) are supported.
- **Indentation**: Indentation following the star prefix is preserved, allowing
  nested lists, blockquotes, and indented code blocks.

### Summary and description

Doc comment prose is split into two parts:

1. **Summary**: The first paragraph of the doc comment, up to the first blank line
   or block tag. It is displayed on one line in module index listings, search results,
   and brief hover popups.
2. **Description**: The full markdown body preceding the first block tag.

```zena
/**
 * Computes the Euclidean distance to another point.
 *
 * Uses the Pythagorean theorem across both axes. The result is always
 * non-negative and finite for non-infinite coordinates.
 */
distanceTo(other: Point): f64 { ... }
```

In this example, `"Computes the Euclidean distance to another point."` is the summary,
and the entire text is the description.

### Supported doc tags

Block tags provide structured metadata about parameters, return values, errors, and
examples. A block tag begins with `@` at the start of a line (outside fenced code
blocks):

| Tag                                              | Syntax                            | Description                                                                                         |
| :----------------------------------------------- | :-------------------------------- | :-------------------------------------------------------------------------------------------------- |
| `@param`                                         | `@param <name> <description>`     | Describes a parameter. The first word names the parameter (`subject`), followed by its description. |
| `@typeParam`                                     | `@typeParam <Name> <description>` | Describes a generic type parameter. The first word names the type parameter (`subject`).            |
| `@returns`                                       | `@returns <description>`          | Describes the return value. (`@return` is also accepted).                                           |
| `@throws`                                        | `@throws <Type> <description>`    | Documents an exception condition. The first word names the exception type (`subject`).              |
| `@example`                                       | `@example <title>?`               | Marks an example. Can be followed by explanatory text and fenced code blocks.                       |
| `@deprecated`                                    | `@deprecated <message>?`          | Marks the declaration deprecated with an optional migration explanation.                            |
| `@see`                                           | `@see <target>`                   | References a related declaration (`ClassName.member`), module ID (`zena:collections`), or URL.      |
| `@since`                                         | `@since <version>`                | Documents the library or package version in which the declaration was introduced.                   |
| `@see` <span class="badge info">Planned</span>   | `@see <target>`                   | References a related declaration (`ClassName.member`), module ID (`zena:collections`), or URL.      |
| `@since` <span class="badge info">Planned</span> | `@since <version>`                | Documents the library or package version in which the declaration was introduced.                   |

### Tag parsing rules

- **Subject tags**: `@param`, `@typeParam`, and `@throws` take a subject. The first
  whitespace-delimited word immediately after the tag names the subject; all
  subsequent text forms the description.
- **Multi-line descriptions**: A tag's description continues across subsequent lines
  until the next tag line or the closing `*/`.
- **Fenced code in tags**: A tag such as `@example` can contain multi-line fenced code
  blocks (` ```zena ... ``` `). Any `@` characters inside fenced code blocks do not
  open new tags.
- **Email addresses**: An `@` symbol inside a sentence (such as `contact@example.com`)
  does not open a tag because it is not at the start of the line.
- **Unrecognized tags**: Any tag beginning with `@` that is not in the standard list
  (such as `@internal` or `@experimental`) is preserved verbatim in the AST and
  documentation model for custom linters or documentation tools to consume.

### Complete example

The following example demonstrates a documented generic class and method:

````zena
/**
 * An ordered, key-value mapping backed by a hash table.
 *
 * Iteration order matches insertion order. Keys must implement
 * the `Hashable` interface.
 *
 * @typeParam K The key type, which must implement `Hashable`.
 * @typeParam V The value type stored for each key.
 * @see zena:collections#Set
 * @since 1.0.0
 */
export class HashMap<K, V> {
  /**
   * Retrieves the value associated with the specified key.
   *
   * If the key is not present, this method returns the provided default value
   * or throws a `KeyNotFoundError` if no default was specified.
   *
   * @param key The key to look up in the map.
   * @param fallback An optional default value to return if the key is missing.
   * @returns The value associated with `key`, or `fallback` if absent.
   * @throws KeyNotFoundError Thrown when `key` is absent and no fallback is given.
   * @example
   * ```zena
   * let map = new Map<String, i32>();
   * map.set('apples', 5);
   * let count = map.get('apples', 0); // 5
   * ```
   */
  get(key: K, fallback: V? = null): V {
    // Implementation
  }
}
````
