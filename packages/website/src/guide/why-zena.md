---
title: 'Why Zena?'
description: 'What Zena is for: WebAssembly GC, the web, AI-assisted development, and a language design free to change its mind.'
---

Zena's goal is to be a great TypeScript-like language for WebAssembly, for both
human developers and AI-assisted coding.

This goal implies a number of things that we haven't found together in a single
language:

- **Zena looks a lot like TypeScript**

  Zena's syntax is very similar to TypeScript's. It is good syntax that a lot of
  people genuinely like, and it is familiar to a huge number of developers and
  to AI models.

- **Zena takes major departures from TypeScript and JavaScript**

  To be a great language for WebAssembly — to produce fast and small binaries —
  Zena is compiled ahead-of-time and is very static, removing all the dynamism of
  JavaScript. There is no `eval`, no dynamic code loading, no runtime
  metaprogramming or introspection, and no mutating a class after it is
  declared. Zena has a static, strict, and sound type system because types must
  be correct for the output to be correct.

  To be a great language in general, Zena addresses a lot of the well-known
  problems with JavaScript, besides those that complicate compilation.

- **Zena steals from other languages**

  Zena's goal of being a great language includes improvements in performance,
  ergonomics, consistency, and safety. To help, Zena takes a lot of the best
  features from other modern adjacent OOP + functional languages like Rust,
  Swift, Dart, Go, and Kotlin.

- **Zena is designed specifically for WebAssembly**

  Zena highly prioritizes compilation to efficient Wasm GC. Its core semantics —
  primitives, variable access, fixed arrays, field access, function calls, and
  subclass subtyping — map directly to Wasm GC with zero runtime overhead and no
  embedded runtime. Ergonomic features layered on top, like polymorphism, are
  designed to be as straightforward as possible, to be optimizable by advanced
  runtimes like V8, and to be as optimizable as possible by the Zena compiler.

- **Zena is meant to be used on the web**

  Being TypeScript-like isn't just about syntax, it's also about target use
  cases, and JavaScript's and TypeScript's main use case is for web pages. On
  the web, code size is critically important, so Zena prioritizes compiling
  to small binaries. Wasm GC is an important part of that and also for JS and
  DOM integration, since it allows GC-visible references across the Wasm / JS
  boundary.

- **Zena is designed to be fast**

  JavaScript and TypeScript are also obviously extremely popular for server apps
  and JS tooling, though a lot of work is happening to migrate tools to Rust and
  Go for performance reasons — even the TypeScript compiler itself has moved to
  Go.

  Zena targets these use cases too, attempting to avoid the pitfall that
  JavaScript and TypeScript are in by designing the language and compiler for
  the best performance possible. We want Zena to be the language that the
  TypeScript compiler would have been ported to if it had existed.

- **Zena is designed to work with AI workflows**

  Zena is born into the age of AI-generated code, and can't ignore that in its
  design. Zena's core principles and each design decision are made with AI
  workflows in mind. Familiarity, correctness, safety, rich integrated tooling,
  and sandboxing are all important qualities for working with code inside tight,
  automatic, and potentially untrusted agentic loops.

There is one more reason for Zena, less about the language than about the moment
it is being built in. It's unknown whether the rise of AI-generated code makes
new languages more viable or less. Does it matter more that a language is well
represented in the training corpus, or that LLMs are good universal translators?
Can a new language be reliably taught to an LLM in a single context window? Can
automated tooling correct a model when it gets things wrong? And does inertia
matter more than the head start a new language gets from AI assisting in its own
development? Zena is a direct test of these open questions.

## The Wasm GC gap

WebAssembly GC gives Wasm modules access to the host's garbage collector, plus
native struct, array, and reference types. It arrived in every major browser in
2023, and it changes what a Wasm module can cost.

Almost every language that compiles to WebAssembly today was designed for a
different machine first, and each pays for that somewhere — in speed, in binary
size, or in how much of the language survives the trip.

- **Rust and C++** produce excellent Wasm, but linear-memory Wasm: each module
  ships an allocator, manages its own heap, and interoperates with the host by
  copying bytes across a boundary. Rust is the best of these, which is why it is
  so common in the Wasm ecosystem, at the price of a borrow checker some
  developers would rather not fight and compile times that are famously slow.
  C and C++ are also only memory-safe from the outside: the sandbox protects the
  host from the module, and nothing protects the module's heap from itself.
- **Java, Kotlin, Dart, and Scala** target Wasm GC, but carry decades of
  semantics designed for their own VMs — boxed primitives in generics, class
  hierarchies rooted in `Object`, reflection, dynamic class loading. Their
  compilers do impressive work to hide this, and it still shows up in binary
  size and in what optimizes well.
- **Dynamic languages** either give up semantics that Wasm cannot express —
  dynamic code loading is the usual casualty — or compile their whole runtime to
  Wasm and load the program as data. Often both. The result is slow to start,
  large to download, and only partly compatible with the ecosystem it came from.
  Ahead-of-time compilers for JavaScript and TypeScript narrow this, but the
  trade does not disappear.
- **TypeScript-like languages** (AssemblyScript) get the syntax right but bring
  a garbage collector along, and their type systems inherit TypeScript's
  deliberate unsoundness.

Each is a good language reaching a new target. Zena starts from the target and
works backwards.

## Nothing in your module but your code

Zena's compiler is allowed to assume Wasm GC, and every part of the output gets
smaller and faster for it:

- **No runtime.** No allocator, no collector, no scheduler. A hello-world module
  is a few hundred bytes of your code plus a handful of string helpers.
- **Monomorphized generics.** `Array<i32>` is an array of Wasm `i32`s. There is
  no boxing, no type erasure, and no cast on every read.
- **Direct type mapping.** Classes are Wasm GC structs. Fields are struct
  fields. There is no header word, no vtable pointer where one isn't needed.
- **Aggressive dead-code elimination.** Unused code _and types_ are dropped, so
  depending on a large library costs only what you use.
- **Devirtualization.** When the compiler can prove a receiver's type, a virtual
  call becomes a direct `call`.

The trade-off is honest: monomorphization duplicates code. That is the right
trade when it buys unboxed generics and direct calls.

## Compilation fast enough to stay in the loop

Zena is designed so the compiler can be fast, not only its output. Parsing, IR
lowering, and scope resolution are all embarrassingly parallel, because of two
rules the language holds to.

**Nothing is ever implicitly in scope.** Every name is declared in a library or
imported into it — there are no globals, not even `console`. Resolving a name
never requires searching an ambient namespace.

**Types act only where they're named.** A type affects an expression only if
that type is named there — in a declaration, an annotation, a cast. Importing a
library cannot change what a class means, and no declaration in another library
can attach behaviour to a type you already have. There is nothing like
multimethods, and nothing like an extension method that arrives with an import.

Together these mean checking a library depends only on its declared
dependencies. Checking parallelizes across libraries, and results cache: if a
dependency didn't change, its check doesn't run again. The target is Zig-like —
fast from cold, faster incrementally.

This is a real constraint on the language, not just a compiler tactic. It rules
out some genuinely convenient features. It buys a compiler that keeps up with
you.

## Correctness

Zena tries to make as many mistakes as possible into compile errors.

- **Garbage collection** is the friendly route to memory safety — no ownership
  discipline to learn, and on Wasm GC, no collector to ship.
- **Static types won.** TypeScript settled the question of whether mainstream
  developers want them.
- **Soundness** is what makes types worth trusting. If a Zena program
  type-checks, the types are right at runtime. There is no unchecked downcast, no
  place where the compiler quietly takes your word for it, and no `any` to opt
  out with.
- **Non-nullable references** remove a whole category of failure, and
  constructors cannot finish with a field unset.
- **Exhaustive `match`** means adding a case to a sealed hierarchy fails to
  compile everywhere that needs attention.
- **Distinct types** keep a user ID from being an order ID, and a customer name
  from being a file path.

Contracts — pre- and post-conditions — and numeric unit types are next, so that
adding meters to feet is a compile error rather than a post-mortem.

Soundness also pays for itself in the output. The compiler can trust the types,
which is what makes unboxed generics and devirtualization safe.

## Familiar to humans and to agents

Zena is deliberately unoriginal about syntax. It borrows what already works:

- **TypeScript** — type annotation syntax, arrow functions, structural records,
  ES-style modules
- **Dart** — constructors with `this.` parameters and initializer lists, mixins
- **Scala** — sealed hierarchies, case classes, expression orientation
- **Swift** — immutability by default, `let`/`var`, no `++`/`--`
- **Rust** — exhaustive matching, ranges, distinct types
- **Go** — a small language you can hold in your head; one obvious way to do
  things

Where these disagree, Zena picks the option that is easier to reason about, not
the one that is shortest to type. It also corrects a few things the mainstream
got wrong, on purpose: `let` means immutable, conditions take `boolean` rather
than anything truthy, numeric conversions are explicit, and references are
non-nullable unless the type says otherwise.

Familiarity serves two readers now. People transfer what they already know. And
models write usable Zena from a short description of the language, because most
of it is a language they have seen a great deal of — which matters, since Zena
is being built almost entirely by generative AI under human review.

That is also why the corrections are worth their cost. Generated code needs
review, and review is expensive and unreliable when done only by people. Every
mistake the type system can catch is one a reviewer doesn't have to. The goal is
to check as much as possible with computers rather than with attention.

## Why WebAssembly at all

- **Sandboxing.** Wasm is the cheapest credible way to run untrusted code. That
  matters generally, and it matters a great deal for agentic loops, where code
  is generated and run continuously and fast compiles keep the loop tight.
- **The web.** Wasm's promise on the web is undercut by download size — a
  multi-megabyte module is not shipping on a landing page. Small binaries are
  what make Wasm usable there at all, and Wasm GC is what makes real DOM interop
  possible, since objects can be shared with the host instead of copied.
- **Strings.** Hosts disagree about string encoding; the web is famously WTF-16,
  while WASI is WTF-8. Zena's `String` hides the encoding, so the same code
  compiles for either host and interoperates without paying to re-encode at the
  boundary.

## No users is a superpower

Zena has no users, and right now that is an asset.

Languages used to cost so much to build that early mistakes were frozen in long
before anyone could afford to revisit them — the design was fixed by the price
of changing it. Building with AI changes that price. A working toolchain, zero
users, and the ability to make a sweeping change in an afternoon means Zena can
still fix its design instead of living with it.

That window closes the moment anyone depends on this. Until then, coherence
wins over compatibility.

## Where Zena fits

The properties above — small binaries, fast compiles, host GC, no ambient
capabilities — point at a particular set of problems.

**General web programming.** Wasm GC means Zena objects are host objects, so
interop with JavaScript and the DOM is a reference across the boundary rather
than a serialize-and-copy. That makes real DOM APIs written in Zena possible,
instead of a wrapper over a wrapper. And on the web, download size is a feature:
a module that takes a second to arrive has already lost to the JavaScript it was
supposed to replace.

**Edge computing.** [Cloudflare Workers](https://workers.cloudflare.com/),
[Fastly Compute](https://www.fastly.com/products/compute), and
[Fermyon Spin](https://www.fermyon.com/spin) (acquired by Akamai in 2025) all
run Wasm in production, alongside [wasmCloud](https://wasmcloud.com/) and
Shopify Functions. Edge billing and cold-start behaviour reward exactly what
Zena optimizes for: a small module that boots in microseconds and brings no
runtime with it.

::: tip Wasm GC at the edge
Wasm GC is very new on these platforms. Wasmtime — which Fastly, Fermyon, and
Shopify build on — [shipped complete Wasm GC in 27.0](https://bytecodealliance.org/articles/wasmtime-27.0)
and only enabled it by default in **47**. Cloudflare Workers runs V8, which has
had Wasm GC since Chrome 119. The substrate is arriving; check your platform
before assuming a Zena module will run there today.
:::

**Agentic coding loops.** Code written and run continuously by a model wants a
familiar syntax, as much automated checking as possible, compiles fast enough
not to stall the loop, and a sandbox so a bad generation can't do damage. Zena
is built for all four. This is the use case most shaped by the way Zena is being
built — see [Working with AI agents](/guide/ai-agents/).

**Plug-in systems.** Sandboxing JavaScript properly is genuinely hard: a Worker
still has network I/O and no DOM, and embedding an interpreter like QuickJS
costs you size and speed. Wasm starts with no capabilities at all, so a host can
hand a plug-in exactly the interface it should have and nothing more. The
missing piece has been a language plug-in authors are willing to learn — not
everyone wants to pick up Rust to write an extension.

**Server-rendered web apps.** Components written once in Zena can run in the
browser and on the server, with the server side shipped as a Wasm module that
embeds in Rust, Go, Java, Python, or Node. Server-side rendering stops requiring
that your server be written in the same language as your front end.

**Large codebases.** The compiler is designed for scale rather than retrofitted
to it: parallel and incremental compilation, cacheable intermediate artifacts,
and the scoping rules that make both possible.

**WASI component orchestration.** <span class="badge warning">In progress</span>
First-class WIT and component support means gluing components together in a real
language with types, control flow, and tests — the Bytecode Alliance's
[`wac`](https://github.com/bytecodealliance/wac) is a declarative composition
format; Zena could be the imperative one.

**Programs as data.** Some systems store and move programs the way they store
and move records: a policy in a database, a filter in a proxy, a custom query
function, a sampler shipped with an inference request, a micro-app living in a
user's repository and handed to whoever wants to run it. eBPF made the pattern
familiar in the kernel; Wasm is the userspace version, and the component model
gives it an interface story.

What kills this pattern is size. If every stored program drags a JavaScript or
Python runtime behind it, a forty-line function becomes a multi-megabyte
artifact, and the whole idea stops being worth it — you cannot keep thousands of
those in a table, or ship one to a client on request. Wasm GC removes the
biggest line item by letting the host's collector do the work, and Zena is built
to take advantage of that rather than to work around it.

The sandboxing side matters just as much, because the party running the program
usually didn't write it. A concrete example: vLLM lets callers supply
[custom logits processors](https://docs.vllm.ai/en/latest/features/custom_logitsprocs/)
to control sampling, and the current defence against arbitrary code execution is
`--logits-processor-pattern`, a **regex allowlist of module names**. That is a
configuration knob standing in for isolation. A Wasm module with no capabilities
by default is the shape that problem actually wants.

::: warning Mostly a fit, not yet a practice
Wasm-based samplers, and executable records in an
[AT Protocol](https://atproto.com/) PDS, are not things anyone ships today —
they're places the constraints line up. [Envoy's proxy-wasm](https://github.com/proxy-wasm/spec)
filters and Shopify Functions are the closest existing examples of the pattern
in production.
:::

**A portable core shared across languages.** Really a WebAssembly selling point
rather than a Zena one — Zena is just a pleasant language to write the core in.
Validation rules, pricing logic, a parser, a policy engine: write it once and run
the same binary in your Go service, your Python data pipeline, your Node API,
and the browser, with no per-language FFI to maintain and no reimplementation
drifting out of sync. This generalizes the SSR case above.

## Next

- [Getting started](/guide/getting-started/)
- [What is Zena?](/guide/what-is-zena/) — comparison to other languages
- [The performance model](/guide/performance/) — what each construct costs

<!--
## Scratch

  To be clear, there is tension in the goals of maximum performance being
  familiar and TypeScript-like. Zena has closures, virtual dispatch,
  polymorphism, calling function with more arguments, and structural typing for
  records. These do have runtime overhead in Wasm, but the cost is taken on
  consciously and designed to be agressively optimized away by the Zena
  compiler.
-->
