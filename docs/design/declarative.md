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

### Zena Logic with Embedded Declarative (`.zena` with `html <tag>` / `data { ... }`)

Imperative Zena source code containing embedded declarative block expressions or JSX-like markup sugar.
- Seamless transition between imperative logic and declarative trees.
- Validated by the Zena type checker.
- Enables visual editing of embedded declarative blocks while preserving human logic code.

### Plain Zena (`.zena`)

All logic, no declarative structures. Standard functions, classes, and algorithms.

---

## Prior Art

Existing declarative formats and embedded DSLs present specific trade-offs:

| Format / System | Outer Structure | Key Strengths | Main Drawbacks | Zena Borrowing |
| :--- | :--- | :--- | :--- | :--- |
| **JSON / YAML** | Key-value maps & lists | Universal parsing, simple data model | No comments, no schemas in syntax, verbose array syntax | Pure data tree model |
| **HCL (Terraform)** | Typed block statements | Clean block structure, no top-level boilerplate | Separate DSL from host language | Block statement syntax (`Type Name { ... }`) |
| **KDL** | Node statements | Positional args, named properties, and nested children | Non-standard ecosystem | Positional args + properties + children model |
| **Protobuf TextFormat** | Message blocks | Strongly-typed message trees | Rigid schema rules, limited control flow | Implicit child node appending |
| **JSX / HTML** | Markup elements | Familiar syntax, visual hierarchy | Capitalization heuristic (`<div />` vs `<Card />`), required string quotes | Markup sugar desugaring to node trees, explicit component sigil (`<@Component>`) |
| **Nunjucks / Jinja** | Outer text shell + embedded control flow | Effective for documents and templates | Bespoke ad-hoc mini-languages, weak typing | Inverted template file mode (`.zhtml`, `.zmd`) |

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

Zena adopts the **Typed Node-Block Grammar** as a core syntax feature, unifying standalone configuration, embedded expressions, markup sugar, and template files.

```
                           Unified Syntax Model
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
       ▼                             ▼                             ▼
.zconf Config Files           In-Code Expressions           Template Files
(package.zconf, build.zconf)  (data { ... }, html { ... })  (.zhtml, .zsvg, .zmd)
```

### Typed Node-Block Grammar

Declarative files (`.zconf`) and blocks (`data { ... }`) use a node-oriented statement syntax:

1. **Implicit Appending**: Sequential statements automatically append to the parent node's children list.
2. **Typed Constructors**: Statements begin with a type identifier mapping to a Zena class or schema type.
3. **Positional Arguments & Attributes**: `Type "name" { key: value }` supplies positional arguments and properties.
4. **Nested Children Blocks**: `{ ... }` blocks contain child node declarations without array bracket syntax.

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

### Control Flow Mapping

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
    "packages/zena-compiler",
    "packages/stdlib",
    "packages/zena-cli",
    "packages/runtime",
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
    run: "zena-cli build src/main.zena -o dist/main.wasm --target wasi",
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
    run: "zena-cli test test/suite.zena",
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

Published on ${ releaseDate } by **${ author }**.

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

1. **Implement Typed Node-Block Grammar**:
   - Support `.zconf` standalone files for manifests and choreographies.
   - Support `data { ... }` and `html { ... }` embedded expressions.
   - Support `.ztpl`, `.zhtml`, `.zsvg`, and `.zmd` template files.
2. **Standardize `${ ... }` Interpolation**:
   - Lower `${ for (x in xs) { ... } }` to `xs.map(...)`.
   - Lower `${ if (cond) { ... } }` to conditional ternary expressions.
   - Automatically flatten array outputs into child node streams.
3. **Adopt Component Sigil (`<@Component>`)**:
   - Disambiguate element strings from symbol references explicitly.
4. **Map Node Types to Schema Classes**:
   - Validate node declarations against Zena class definitions at compile time.
5. **Implement Overlay Protocol (`.zlayout`)**:
   - Store visual coordinates in separate patch files to support visual tooling.
