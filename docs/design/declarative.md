# Declarative Syntax and Configuration

## Overview

Zena should provide a unified declarative model for use cases like UI authoring, package manifests, build configurations, document templates, and data transfer.

Declarative use cases span multiple container formats and levels of declarativeness:

- **Embedded expressions**: UI descriptions embedded in imperative source code (e.g. JSX, SwiftUI).
- **Standalone files**: Pure data files for configuration and manifests (e.g. JSON, YAML, HCL).
- **Hybrid templates**: Markup or prose outer shells containing embedded expressions (e.g. HTML templates, MDX).

Existing declarative formats like JSON and YAML lack abstraction and programmability. Conversely, traditional template engines (like Mustache, Nunjucks, or Jinja) invent bespoke, limited mini-programming languages. These ad-hoc template languages are often brittle, weakly typed, slow to evaluate, and lack robust tooling.

This document describes a unified model for all of these use cases. By reusing Zena's full, strongly-typed programming language inside templates and declarative blocks, Zena eliminates bespoke template languages and pre-compiles templates directly to fast WebAssembly code.

---

## Declarative Spectrum

The relationship between logic and declarative data exists along a continuous spectrum with four primary stops:

```
                            The Declarative Spectrum
                                       │
     ┌──────────────────┬──────────────┴──────────────┬──────────────────┐
     ▼                  ▼                             ▼                  ▼
1. Pure Declarative  2. Declarative Shell      3. Zena Logic with      4. Plain Zena
   (.zconf)          with Embedded Logic       Embedded Declarative    (.zena)
   No logic.         (.zhtml, .zmd)            (.zena with html <tag>) Pure imperative
   Data graphs,      Markup/prose shell with   Imperative code with    logic and state.
   manifests.        embedded expressions.     visual editing hooks.
```

### Pure Declarative (`.zconf`)

All declarative, no logic. Represents pure data graphs such as package declarations (`package.zconf`), workspace build manifests (`build.zconf`), and choreography protocols (`workflow.zconf`).

- Zero `let`/`var`/`export` boilerplate.
- Statically parseable without code execution.
- Strongly typed against Zena schema classes.

### Declarative Shell with Embedded Logic (`.zhtml`, `.zsvg`, `.ztpl`, `.zmd`)

Declarative markup or prose on the outside, with embedded Zena expressions and control flow on the inside.

- Contextual text scanning between tags.
- `${ expr }` interpolation matching string template syntax.
- `${ for ... }` and `${ if ... }` control-flow mapping to node sequences.

### Zena Logic with Embedded Declarative (`.zena` with `@ui Box { ... }` / `html <tag>`)

Imperative Zena source code containing node literals (plain or `@`-tagged) or JSX-like markup sugar.

- Transition between imperative logic and declarative trees without leaving Zena's type system.
- Validated by the Zena type checker.
- Enables visual editing of embedded declarative blocks while preserving human logic code.

### Plain Zena (`.zena`)

All logic, no declarative structures. Standard functions, classes, and algorithms.

---

## Prior Art

Existing declarative formats and embedded DSLs present specific trade-offs:

| Format / System         | Outer Structure                          | Key Strengths                                          | Main Drawbacks                                                             | Zena Borrowing                                                                   |
| :---------------------- | :--------------------------------------- | :----------------------------------------------------- | :------------------------------------------------------------------------- | :------------------------------------------------------------------------------- |
| **JSON / YAML**         | Key-value maps & lists                   | Universal parsing, simple data model                   | No comments, no schemas in syntax, verbose array syntax                    | Pure data tree model                                                             |
| **HCL (Terraform)**     | Typed block statements                   | Clean block structure, no top-level boilerplate        | Separate DSL from host language                                            | Block statement syntax (`Type Name { ... }`)                                     |
| **KDL**                 | Node statements                          | Positional args, named properties, and nested children | Non-standard ecosystem                                                     | Positional args + properties + children model                                    |
| **Protobuf TextFormat** | Message blocks                           | Strongly-typed message trees                           | Rigid schema rules, limited control flow                                   | Implicit child node appending                                                    |
| **JSX / HTML**          | Markup elements                          | Familiar syntax, visual hierarchy                      | Capitalization heuristic (`<div />` vs `<Card />`), required string quotes | Markup sugar desugaring to node trees, explicit component sigil (`<@Component>`) |
| **Nunjucks / Jinja**    | Outer text shell + embedded control flow | Effective for documents and templates                  | Bespoke ad-hoc mini-languages, weak typing                                 | Inverted template file mode (`.zhtml`, `.zmd`)                                   |

---

## Evaluated Strategies

### Comptime Generators and Build-System Expressivity

Treat configuration files as standard Zena scripts executed at compile time.

- **Pros**: Full language power (`for` loops, helper functions).
- **Cons**: Poor static tool support—tools must run a WebAssembly engine to inspect structure.

When programmatically building pure configuration files (Stop 1 on the spectrum), build systems like Bazel or Wireit require **The Static Graph Guarantee**:

> **The Static Graph Guarantee**: The evaluated output of a configuration file (such as a package manifest or build target graph) is a static, serializable data graph (DAG).

Build systems need to query target dependencies across all package configs as pure data graphs without executing arbitrary runtime side-effects at query time.

### Overlay Protocol

Separate human-written code (`.zena`) from machine-generated layout state (`.zlayout`).

- **Pros**: Allows visual editors to modify coordinates without altering logic.
- **Cons**: Requires stable IDs for nodes.

### Type-Safe Builders

Functions accepting builder callbacks with implicit receivers (`c.transfer(...)`).

- **Pros**: Idiomatic language syntax, strong autocomplete.
- **Cons**: Imperative at the source level; difficult for static visual tools to round-trip.

### Pure Data Literals

Restrict declarative files to record literals (`export let config = { ... }`).

- **Pros**: 100% statically parseable.
- **Cons**: Array bracket noise, mandatory commas, `export let` boilerplate.

---

## Proposed Solution

Zena adopts a unified **Node Literal** syntax (typed node-block grammar) across standalone configuration, eager object construction, staged templates, markup sugar, and template files.

```
                           Unified Syntax Model
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
       ▼                             ▼                             ▼
.zconf Config Files           In-Code Expressions           Template Files
(package.zconf, build.zconf)  (Box { ... }, @ui Box { ... }) (.zhtml, .zsvg, .zmd)
```

### Typed Node-Block Grammar

Node literals (`Type [arg] { ... }`) and standalone `.zconf` files share one syntax:

1. **Typed Constructors**: A node begins with a type identifier naming a Zena class, record alias, or schema type.
2. **Positional Argument**: An optional positional argument carries leaf content (`Text 'Hello' { style: titleStyle }`).
3. **Named Properties**: `key: value` entries initialize fields and default through presence-optional records ([record-presence.md](./record-presence.md)).
4. **Implicit Child Appending**: Nested node entries inside `{ ... }` append to the parent node's children without array brackets.

Property-only construction (`Point { x: 1.0, y: 2.0 }`) and child-bearing trees (`Box { style: cardStyle, Text 'Hello' }`) are the same syntax. Whether a type accepts children is checked by the type checker. Because Zena parenthesizes `if (...)`, `while (...)`, `for (...)`, and `match (...)` conditions, `Type { ... }` in expression position is unambiguous.

Untagged node literals evaluate eagerly in ordinary Zena code and construct their objects directly. `.zconf` files use the same syntax restricted to constant data, so build tools can parse them without running code.

`new` does not appear in a node literal, because the type name is the constructor. In ordinary call position the recommendation is to make `new` optional while keeping the keyword available as a reading cue.

### Tagged Node Literals (`@tag Type { ... }`) and Bindings (`$(...)`)

Prefixing a construct with `@Name` in Zena re-interprets already-valid syntax at compile time ([decorators.md](./decorators.md), [syntax-overhaul.md](./syntax-overhaul.md)): `@signal var count` on a field, `@mat[...]` on an array literal, `@Complex{re: 1.0, im: 2.0}` on a record literal, `@transaction { ... }` on a block, and `@ui Box { ... }` on a node literal. `@` never changes how the parser parses what follows it.

Applying a template tag such as `@ui` to a node literal gives each call site a single cached **template** (its fixed node structure, cached once in a Wasm global so all instances share one template identity) while preserving ordinary Zena evaluation for properties:

1. **Outside `$(...)` — block evaluation time (one-shot):** Ordinary Zena expressions (`this.#title`, `titleStyle(this.#accent)`, `onPress: () => ...`, or a mutable `var`) evaluate once when the node literal runs, with no `const` restriction. Expressions that are provably constant (literals, enums, and immutable module-level `let`s of immutable types) fold directly into the cached template as a mount-time optimization. All other expressions become one-shot bindings sent on mount with zero thunks and zero `Effect`s, sharing the same call-site template.
2. **Inside `$(...)` — deferred / reactive bindings:** Each `$(expr)` marks an expression that can be re-evaluated later (in `@ui`, wrapped in a thunk `() => expr` so reactive updates track signal reads; in child position, also used for dynamic child expressions such as conditionals, lists, and directives).

`$(expr)` is parsed as a standard splice/binding expression everywhere (shared with `@q { ... }` in [macros.md](./macros.md)). The type checker permits `$(...)` only inside a staged `@` construct such as `@ui` or `@q`, in the same way `await` is permitted only inside `async` functions and `old(...)` only inside `ensures` clauses. Using `$(...)` in an untagged node literal or nominal record constructor (`Point { x: $(1.0) }`) is a type error, because untagged expressions already evaluate eagerly.

### Control Flow and Directives

Node literals have no built-in `if`, `match`, or `for` statements. All control flow lives inside `$(...)` as ordinary Zena expressions:

```zena
@ui Box {
  style: cardStyle,

  Text 'Items'

  $(if (this.#items.length == 0) {
    @ui Text { 'Nothing here' }
  } else {
    repeat(this.#items, (item) => item.id, (item) =>
      @ui Row { Text item.name }
    )
  })
}
```

Keeping control flow inside `$(...)` has three consequences:

- Every Zena expression (`if`, `match`, `.map()`, helper method calls, and user-defined directives such as `cache(...)` and `repeat(...)`) works in child position and composes freely.
- Nested templates carry an explicit `@ui` tag rather than inheriting one from an enclosing block, so extracting a branch into a helper method preserves its meaning and return type.
- `.zconf` files and `@ui` templates share the exact same node grammar, differing only in whether runtime expressions and `$(...)` bindings are permitted.

See [zenafx-widget-authoring.md](./zenafx-widget-authoring.md) for how ZenaFX uses `@ui`, one-shot vs. reactive `$(...)` bindings, and guest directives (`cache`, `repeat`).

### Markup Sugar and Component Sigil

Markup syntax (`<div class="card">...</div>`) desugars 1:1 into the Node-Block AST.

React/JSX distinguishes HTML tags from component symbols using capitalization (`<div>` vs `<Card>`). This breaks Web Components (`<user-card>`) and binds syntax to identifier casing.

Zena uses an explicit **Sigil (`@`)** for component references:

- **Element Tags**: `<div>`, `<span>`, `<user-card>` (standard element strings).
- **Component Symbols**: `<@UserCard>`, `<@Button>` (references to Zena functions or classes).

### Template Files and Lexer Modes

Template files (`.ztpl`, `.zhtml`, `.zsvg`, `.zmd`) invert the container model: the outer shell is markup or text, while the inner layer contains Zena expressions.

In markup mode (`html <tag>` or `.zhtml` files):

- Character sequences between `>` and `<` or `${` scan as raw unquoted text tokens.
- `${ expression }` pauses text scanning to evaluate standard Zena expressions.
- `<child>` opens a child tag; `</div>` closes a tag and resumes the outer context.

### Control Flow in Markup Mode

Control flow blocks inside `${ ... }` (`${ for }`, `${ if }`, `${ match }`) evaluate as expressions yielding node sequences:

1. **`${ for (item in items) { body } }` $\rightarrow$ `items.map(...)`**:
   A `for` loop inside an interpolation maps over a collection and returns an array of body nodes.
2. **`${ if (condition) { body } else { alt } }` $\rightarrow$ Ternary**:
   An `if` statement inside an interpolation maps to a conditional ternary expression.
3. **Array Flattening**:
   Arrays returned by `${ for ... }` or `${ if ... }` automatically flatten into the parent node's children list. `null` values are discarded.

---

## Code Examples

### Package Manifest (`package.zconf`)

```zena
Package "@zena-lang/http" {
  version: "1.2.0",
  description: "Asynchronous HTTP client and server library for Zena",
  license: "MIT",
  authors: ["Justin Fagnani"],
}

Dependencies {
  Package "@zena-lang/async" { version: "^0.4.0" }
  Package "@zena-lang/url"   { version: "^1.0.0" }

  Dev {
    Package "@zena-lang/test" { version: "^0.2.0" }
  }
}

Exports {
  Module "http" {
    virtual: { host: "src/host.zena", wasi: "src/wasi.zena" }
  }

  Module "headers" {
    path: "src/headers.zena"
  }

  Module "client"
  Module "server"
}
```

### Build System Configuration (`build.zconf`)

```zena
Workspace {
  members: [
    "packages/compiler",
    "packages/stdlib",
    "packages/cli",
    "packages/runtime-js",
  ]
}

Target "build" {
  description: "Compile Zena source to WebAssembly GC module",

  inputs: [
    "src/**/*.zena",
    "package.zconf",
  ],

  outputs: [
    "dist/main.wasm",
  ],

  deps: [
    "//packages/stdlib:build",
  ],

  Command {
    run: "zena build src/main.zena -o dist/main.wasm --target component",
  }
}

Target "test" {
  description: "Run test suite",

  inputs: [
    "test/**/*.zena",
    "dist/main.wasm",
  ],

  deps: [
    ":build",
  ],

  Command {
    run: "zena test test/suite.zena",
  }
}
```

### Choreography Protocol (`payment_flow.zconf`)

```zena
import { Role, Interaction, Choice } from "zena:session";
import { OrderDetails, Quote, Payment, Receipt, CancelNotice } from "./types";

Role Buyer
Role Seller
Role Gateway

Interaction {
  from: Buyer,
  to: Seller,
  data: OrderDetails
}

Interaction {
  from: Seller,
  to: Buyer,
  data: Quote
}

Choice Buyer {
  condition: (q: Quote) => q.price <= 100,

  then: {
    Interaction { from: Buyer, to: Gateway, data: Payment }
    Interaction { from: Gateway, to: Seller, data: Receipt }
  },

  else: {
    Interaction { from: Buyer, to: Seller, data: CancelNotice }
  }
}
```

### UI Component (`renderCard` in `.zena`)

```zena
export let renderCard = (user: User) => html <div class="user-card">
  <h2>User Profile</h2>
  <p>Role: ${user.role}</p>

  <@UserBadge role=${user.role} />
  <button onClick={() => handleConnect(user.id)}>Connect with User</button>
</div>;
```

### Templated Markdown (`release_notes.zmd`)

```markdown
import { Callout, Badge } from "./components";

# Release Notes: ${ version } <@Badge type="success">v${ version }</@Badge>

Published on ${ releaseDate } by **${ author }\*\*.

<@Callout type="warning">
This release includes breaking changes to the session channel API.
</@Callout>

### Major Features

${ for (feature in features) {

- **${ feature.title }**: ${ feature.description }
  } }

${ if (features.length == 0) {
_No major features listed for this patch release._
} }
```

---

## Summary and Roadmap

1. **Implement Node Literals and Tagged Node Literals**:
   - Support unified `Type [arg] { props..., children... }` literals for nominal construction, eager builders, and standalone `.zconf` files.
   - Support `@tag Type { ... }` call-site template caching, one-shot block-eval bindings (with constant folding), and `$(...)` deferred/reactive bindings.
   - Support `.ztpl`, `.zhtml`, `.zsvg`, and `.zmd` template files.
2. **Standardize `${ ... }` Interpolation in markup mode**:
   - Lower `${ for (x in xs) { ... } }` to `xs.map(...)`.
   - Lower `${ if (cond) { ... } }` to conditional expressions.
   - Automatically flatten array outputs into child node streams.
3. **Adopt Component Sigil (`<@Component>`)**:
   - Disambiguate element strings from symbol references explicitly in markup mode.
4. **Map Node Types to Schema Classes**:
   - Validate node declarations against Zena class definitions at compile time.
5. **Implement Overlay Protocol (`.zlayout`)**:
   - Store visual coordinates in separate patch files to support visual tooling.
