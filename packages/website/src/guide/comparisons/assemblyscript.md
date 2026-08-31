---
title: 'AssemblyScript'
description: 'AssemblyScript — Zena documentation.'
status: Draft
statusType: warning
---

One of the first questions people ask, when they hear that Zena is similar to
TypeScript but compiles to WebAssembly is "How is it different from
AssemblyScript?"

## Similarities

Because both languages start from TypeScript, compile ahead-of-time, and target
WebAssembly, there are a lot of similarities:

- Both take advantage of the full compliment of Wasm primitive types
- Both avoid the dynamic, mutable parts of JavaScript
- Both use classical inheritance over prototypes.
- Both limit unions of primitives and references, including `null`, and require
  that optional parameters have defaults.
- Both monomorphizze generics.
- Both remove `undefined` in favor of one null type and value

These are natural design decisions that fall out of supporting Wasm without the
overhead of overly dynamic property lookup and dispatch or boxing primitives.

## Differences

### TypeScript compatibility

The most important difference between AssemblyScript and Zena is that Zena is
not trying to be TypeScript compatible at all, so we can change syntax and
semantics in major and fundamental ways, with both removals and additions.

This includes small things, like `this` only being available in classes, `var`
being block scoped and `let` being immutable, to large departures like classical
inheritance, no switch statement or ternary operator, and the additions like
patern matching, sealed classes, and resources.

See [Zena compared to TypeScript](../typescript/) for more information on how
Zena differs from TypeScript.

### Garbage collection

AssemblyScript is garbage collected, but ships its own garbage collector rather
than using Wasm GC.

The bundled garbage collector is extra code included in every Wasm module, which
should have an impact on size and speed, but we don't yet have benchmarks that
measure the tradeoff between this and Zena's approach which has to declare Wasm
GC types.

There are a few critical limitation with bundled garbage collectors:

- The GC and its tuning is fixed. The GC variant is chosen with compile flags,
  not runtime flags. GC improvements are only available with a re-compile of the
  module with a new version of the language toolchain.
- The GC is single-threaded. Host GC's like V8's Orinoco are multi-threaded,
  running many of their phases without pausing the main thread.
- There's a tradeoff between GC sophistication and module size. Better
  collectors may require larger modules.
- They do not interoperate with host GC's used for other heaps, like JavaScript.
  Wasm GC allows for cross-heap managed references to and from JS and DOM
  objects.

It is of course possible for AssemblyScript to change to use Wasm GC, and there
is a [open GitHub
issue](https://github.com/AssemblyScript/assemblyscript/issues/2808) for it.

### WASI and the WASI component model

AssemblyScript has an official stance against both WASI and the WASI component
model, as stated on their [Standards
objections](https://www.assemblyscript.org/standards-objections.html) page.

Zena is building first-class support for WASI and the component model and
designing the language to play well with both with features like first-class WIT
support and the ability to import and emit components, Strings that support
multiple encodings and encoding safe operations, affine resource ownership to
help manage WIT resources.

No standard or standards process is perfect, but WASI is an important part of
the WebAssembly ecosystem, and Zena aims to support it as best as possible.

## Base language features

AssemblyScript currently lacks support for a lot of core JavaScript/TypeScript
language features:

- Async functions [#376](https://github.com/AssemblyScript/assemblyscript/issues/376)
- Generators [#351](https://github.com/AssemblyScript/assemblyscript/issues/351)
- Closures [#798](https://github.com/AssemblyScript/assemblyscript/issues/798)
- Exceptions [#302](https://github.com/AssemblyScript/assemblyscript/issues/302)
- Private class fields [#2896](https://github.com/AssemblyScript/assemblyscript/issues/2896)
- Destructuring [#1473](https://github.com/AssemblyScript/assemblyscript/issues/1473)
- Logical assignment operators [#1338](https://github.com/AssemblyScript/assemblyscript/issues/1338)
- String enums [#560](https://github.com/AssemblyScript/assemblyscript/issues/560)
- Iterators and for/of and for/in loops [#166](https://github.com/AssemblyScript/assemblyscript/issues/166)
- Tagged template literals ([relevant comment](https://github.com/AssemblyScript/assemblyscript/issues/466#issuecomment-808591159))

To be fair in comparison, Zena has the benefit of relying heavily on AI for
development. AssemblyScript is maintained by a small team, but so is Zena, and
AssemblyScript could increase its velocity in the future and fix these issues.
