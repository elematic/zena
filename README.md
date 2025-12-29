# Zena Programming Language

Zena is a new programming language targeting WebAssembly (WASM) and WASM-GC. It
is designed to be the **best way to write WASM**: offering a familiar, ergonomic
syntax similar to TypeScript, but with the performance and predictability of a
statically-typed, ahead-of-time (AOT) compiled language.

## Vision & Goals

Zena aims to be an extremely nice and familiar way to write high-performance
WASM. It balances familiar functional and OOP syntax with a strict orientation
around efficient WASM output.

- **WASM-First & High Performance**: The primary backend is WASM-GC. We aim for
  **no-cost to low-cost abstractions**.
  - **Numeric types** align directly with with WASM numerics, with the addition
    of unsigned types to statically select WASM's unsigned arithmetic
    operations.
  - **Generics** are fully monomorphized (like C++ templates or Rust), meaning
    `List<i32>` stores raw integers with zero boxing overhead.
  - **Arrays and Record** map directly to WASM GC arrays and structs.
  - **Classes** map to WASM GC structs with vtables.
  - **Polymorphism** uses vtables where necessary (inheritance, interfaces), but
    we prefer static dispatch when possible. Private and final class members are
    guareteed to use static dispatch.
- **Familiar yet AOT**: While Zena looks like TypeScript, it is entirely
  designed for **ahead-of-time (AOT) compilation**. It breaks away from
  JavaScript's dynamic semantics to allow for efficient compilation and small
  binary sizes.
- **Modern Inspiration**: Zena aims to take inspiration and the best features
  from **TypeScript, Dart, C#, Kotlin, and Swift**.
- **Sound Type System**: Zena is strongly typed with a sound type system. It
  does not perform implicit type coercion (e.g., `1 + "1"` is a type error).
- **Correctness & Safety**: Zena is designed to make invalid states
  unrepresentable.
  - **Immutable by Default**: Data structures and bindings are immutable unless
    explicitly opted-out, reducing classes of bugs related to shared mutable
    state.
  - **Nominal Typing**: Enforces strict semantic boundaries between types,
    preventing accidental structural compatibility.
  - **Advanced Safety Features**: Future plans include **Exhaustiveness
    Checking** for pattern matching and **Units of Measure** to enforce unit
    correctness at compile time (e.g., preventing `Meters + Seconds`).

## Zena and Generative AI

Zena so far is implemented almost entirely by generative AI (Gemini 3 for now).
I must be honest about this, even if it might be controversial if anyone ever
cares about this project. Zena started as, and still is, an experiment. A kind
of "what would happen if we asked AI to build a new programming language?" kind
of challenge.

Why do this though? Will anyone use this language? What's the point? Here are
some of my thoughts and motivations at the moment:

- **Breaking the barrier to entry**: I've had ideas for a programming language
  for a long time, but I never had the time or deep expertise to pull it off. I
  worked on the Dart team (mostly on tools, not the VM) and have written parsers
  before (like for Polymer expressions), but building a full compiler and
  ecosystem is a massive investment. Without AI, my only hope of building this
  would have been winning the lottery.
- **Gemini 3 & greenfield development**: I was trying Gemini 3 and noticed how
  far it could get with basic instructions, so I wondered how far it could go on
  a greenfield project. It turns out, quite far! I'm already blown away by how
  well it's working.
- **The bootstraping paradox**: People worry that LLMs will discourage new
  languages because models only know languages in their training sets. That's a
  real concern, but there might be an opposite effect too: AI might make it
  drastically cheaper to build the language and the _ecosystem_—IDEs, docs,
  examples, and tools—needed to launch a language and get it into the next
  generation of training cycles.
- **Ethical use of AI in open source?**: There are definite ethical and moral
  questions around generative AI, but using it to create public goods like open
  source software feels like one of the least exploitive ways to use the
  technology.
- **Controlling quality and reducing slop**: I haven't been a huge AI
  booster—I'm skeptical of a lot of the hype—but it's clearly useful for coding
  if you hold it right. I wanted to see if I could nudge an AI to build
  well-constructed, reliable software rather than unmaintainable cruft. I'm
  performing a lot of oversight: reviewing code and tests, "discussing" design
  ideas, and planning next steps. Is that enough?
- **Why Zena itself?**: I wanted a nice language for building WASM modules that
  uses modern features like WASM-GC out of the box. I didn't see another
  language I loved for this—even including Rust, Go, or AssemblyScript—so I
  decided to try building one.

## Feature Status

### Language Features

- [x] `let` and `var` variables for immutable and mutable variable bindings
- [x] Type annotations with non-nullable by default types
- [x] Basic types: `i32`, `f32`, `boolean`, `null`, `void`
- [x] String type and built-in class
- [x] Function declarations and calling
- [x] Operators: `+`, `-`, `*`, `/`, `==`, `!=`, `<`, `<=`, `>`, `>=`
- [x] Exports
- [x] Classes with inheritance, constructors, fields, and methods
- [x] Virtual public class members, including fields
- [x] Private fields
- [x] `final` classes and class members
- [x] Interfaces (with nominal typing)
- [x] Mixins, with composition support and constraints
- [x] Generics on function, classes, interfaces, and mixins, with constraints
      and defaults
- [x] Union types
- [x] Accessors
- [x] Mutable Arrays and array literals (`#[...]`)
- [x] Abstract classes and members
- [x] Index operator (`[]` and `[]=`) overloading
- [x] For loops
- [x] While loops
- [x] Modules and imports
- [x] Closures
- [x] Type aliases
- [x] Distinct types
- [x] Function types
- [x] String escapes
- [x] Static Symbols (Protocol Methods)
- [x] Tagged template literals
- [x] Record and tuple literal syntax (`{...}` and `[ ... ]`)
- [x] Console built-in
- [ ] Mutable Maps and map literals (`#{...}`)
- [ ] More primitive types
- [x] Blocks
- [ ] Do/while loops
- [x] Pattern matching (Basic, Logical, Guards)
- [x] Record spread syntax (`{ ...p }`)
- [x] Exceptions (`throw`)
- [x] `never` type
- [ ] For/of loops
- [ ] Iterators
- [ ] More operators: exponentiation
- [ ] Standard library
- [ ] Numeric unit types
- [ ] Extension methods
- [ ] Operator overloading
- [ ] `operator is` overloading
- [ ] `TypeId<T>` intrinsic
- [ ] Intersection types
- [ ] Mixin constructors
- [ ] Async functions
- [ ] Regexes
- [ ] Decorators
- [ ] JSX-like builder syntax
- [ ] Enums
- [ ] Workers

### Tools

- [x] Compiler implemented in TypeScript
- [x] CLI
- [x] Website
- [ ] Self-hosted compiler written in Zena
- [ ] VS Code extension
- [ ] Syntax highlighter plugins
- [ ] Online playground
- [ ] WIT generator
- [ ] WASI support in CLI
- [ ] Package manager

## Syntax Example

Here is a small example of what Zena looks like today:

```typescript
// A simple class representing a 2D point
class Point {
  x: i32;
  y: i32;

  // Constructor
  #new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }

  // Method to calculate distance squared
  distanceSquared(): i32 {
    return this.x * this.x + this.y * this.y;
  }
}

// Exported function callable from the host
export let main = (): i32 => {
  let p = new Point(3, 4);
  return p.distanceSquared(); // Returns 25
};
```

## Documentation

- [Language Reference](docs/language-reference.md): Detailed guide on syntax and
  semantics.

## Getting Started

This project is currently in the bootstrapping phase. The initial
compiler/parser is being written in TypeScript.

### Prerequisites

- Node.js
- npm

### Installation

(Instructions to be added)

## License

[MIT](LICENSE)
