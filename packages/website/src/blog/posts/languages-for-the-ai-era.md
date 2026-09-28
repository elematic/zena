---
title: 'Designing a Programming Language for the AI Era'
description: 'What makes a programming language effective when AI agents write, test, and review code, and why being optimized for WebAssembly is being optimized for AI.'
date: 2026-09-29T18:00:00Z
author: justinfagnani
tags:
  - design
hero:
  image: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=1600&q=80'
  alt: 'Abstract matrix code stream representing software compilation and execution'
  credit: 'Photo by Markus Spiske on Unsplash'
---

Software engineering is rapidly adapting to an era where coding agents write,
edit, test, and review large parts of our codebases, in some cases the vast
majority of it. There are lots of opinions, experiments, and new tools up and
down the software development stack from version control, IDEs, agent
coordinators, sandboxes and VMs, debugging, and of course: programming
languages.

The questions around programming languages are some of the most fundamental
about developer tools in the agentic era. I see a lot of very important, and
very unsettled topics, like:

- What current languages are best for AI code generation?
- What would a programming language built for AI look like?
- Do programming languages even matter? Will future coding agents directly write
  machine code?
- Have LLMs frozen the top programming languages in place because they dominate
  existing training sets?
- Relatedly, do LLMs need to be trained on a large corpus of a language to be
  good at generating it, or do their "universal translator" capabilities make up
  for smaller training sets?
- Do coding agents make it easier to launch a new language by helping build out
  its ecosystem?
- Do ecosystems even matter, or will every project generate every library it
  needs, skipping dependencies and package managers completely?
- What is the role of humans in the developer loop, and how do we make humans
  more effective in it?
- What does "ergonomics" mean for AIs versus humans?

These questions are circling around the whole software industry. A few writings
on the topic that have crossed my screens recently include:

- José Valim's essay, [Evolving programming languages in the AI
  era](https://dashbit.co/blog/evolving-ai-era), on how tooling, guarantees, and
  community collaboration shift when agents write code.
- An argument for [Why Go is an Ideal Language for AI-Assisted Software
  Engineering](https://developers.googleblog.com/why-go-is-an-ideal-language-for-ai-assisted-software-engineering/),
  from Google's Go team.
- Community debates on AI-optimized [languages without syntactic
  sugar](https://www.reddit.com/r/ProgrammingLanguages/comments/1ldo2x2/programming_language_optimized_for_ai_code/),
- Unmesh Joshi's analyzsis of how [DSLs and domain
  abstractions](https://martinfowler.com/articles/llm-and-dsls.html) constrain LLM
  code generation.

These posts always have me critically comparing Zena to their theses, because
Zena was designed from its inception to be a great language for WebAssembly GC,
humans, _and_ for AI - I actually think these goals mostly overlap, and that
Zena is a great language for AI-driven development.

<figure class="blog-post-figure">
  <img src="/images/blog/zena-ai-venn-diagram.svg" alt="Venn diagram showing Zena at the intersection of Humans, AI, WebAssembly, and Compilers" class="blog-post-image blog-post-diagram" loading="lazy" style="max-width: 600px; width: 100%; border: none; background: transparent;" />
  <figcaption class="blog-post-caption">
    Zena at the intersection of humans, AI, compilers, and WebAssembly GC. This
    intersection probably deserves it's own blog post.
  </figcaption>
</figure>

So let's dive into these questions, look at what properties I think makes a
programming language effective for both human engineers and coding agents, and
explain why optimizing for WebAssembly is optimizing for AI.

## Programming languages are still necessary

A recurring question is whether high-level programming languages will remain
necessary. If models can generate logic from natural language specifications,
will agents simply bypass compilers and emit assembly, WebAssembly text format
(WAT), or machine code directly?

I don't think so. Low-level instructions lack domain abstractions, consume vast
numbers of output tokens, and bloat context windows. More importantly, software
development is iterative: code must be read back into context to be edited,
debugged, and reviewed. Reading flat assembly or unstructured byte sequences
back into a prompt strains model attention and makes reasoning about system state
far more difficult.

Human understanding and auditing also remain essential. Software does not run in
a vacuum. Humans still need to inspect architecture, verify intent, audit
security boundaries, collaborate on changes, and take responsibility for the
systems. High-level languages remain the most effective medium for expressing,
sharing, and reasoning about computational logic.

## The role of humans and the meaning of ergonomics

While Zena is designed to be an exceptional language for AI, it is fundamentally
a **humanist project**.

Zena is designed as the ideal language for me, personally, built on the belief
that humans will continue to play an active, meaningful role in software
development: reviewing changes, reading codebases, designing APIs, evaluating
trade-offs, and even coding by hand. An AI-first language that is unpleasant or
impenetrable for a human makes it too difficult for humans to be involved when
and where they need to.

What does **ergonomics** mean for an AI compared to a human? The core is largely
identical for both: clarity, predictability, and familiarity reduce cognitive
load for humans and attention dilution for models. Where humans and AIs diverge
is in scale, endurance, and tolerance for strictness. Humans often find strict
compiler ceremony annoying (or at least less fun), leading to the popularity of
dynamic languages with loose types and implicit coercions. Coding agents do not
experience annoyance; they handle strict, pedantic type checkers and explicit
annotations just fine.

This informs my design philosophy: **provide human-friendly syntax and
ergonomics, but lean strict and pedantic on compiler checks.** The strictness
protects the codebase, while the ergonomics ensure the code remains a pleasure
for humans to read and maintain.

## The code round-trip problem

Until recently, code was written by a human, reviewed by another human, and read
by even more humans. Today, code cycles through AI repeatedly: an agent writes
code in one session, and subsequent sessions read and modify it. Just like with
humans, the code that AI writes becomes the context that AI reads.

In a permissive language where static errors are deferred to runtime, sloppy
patterns compound. Conversely, when a language enforces strict types, explicit
invariants, and clean idioms, that structure compounds: every module committed
acts as high-signal context for future agent interactions, priming the model to
generate more disciplined, reliable code.

The primary objective is to shift the burden of correctness from the LLM and
human eyes to automated tooling. Humans do not review high volumes of
AI-generated code reliably; attention fatigues, and subtle bugs pass through
unnoticed. The compiler must act as a deterministic filter so that human review
can focus on architecture, critical functions, tests, and pre- and
post-conditions.

## Context and cognitive load

Discussions of language design for LLMs often focus on token efficiency. One
view holds that languages should minimize token counts to lower inference costs.
Another argues that as inference costs fall and context windows grow, token
counts don't matter.

Without being an AI researcher myself, I intuitively fall in the middle: raw
token price is only one part of the picture. LLMs suffer from degraded recall
and instruction-following as critical information is pushed further back in the
context. More importantly, an LLM spreads its attention across system
instructions, conversation history, tool calls, retrieved documentation,
codebase context, and its internal reasoning trace.

Repetitive boilerplate consumes attention capacity that is otherwise available
for problem solving. Code that requires thirty lines of ceremony to express an
operation that conceptually takes two lines leaves less attention available for
reasoning about the problem at hand, architecture, and edge cases. In my
experience, model understandability aligns with human understandability: a
language with clear, regular semantics and concise and high-level syntax
preserves capacity for the actual problem at hand.

## Has language evolution ended?

A common concern in language design discussions today is that LLMs have frozen
the current top programming languages in place. If models are trained
predominantly on Python, TypeScript, Rust, and C++, won't any new language
suffer from poor model performance? Will Rust and TypeScript be the only
languages left?

I personally don't believe language evolution has ended.

First, current leaders each carry historical baggage and friction:

- **TypeScript** offers familiar ergonomics and rapid web development, but it is
  intentionally unsound. Features like `any`, non-sound type assertions, and
  permissive structural subtyping mean that subtle bugs and hallucinations pass
  the compiler and surface only at runtime.
- **Rust** provides memory safety and sound type checking, but its borrow
  checker introduces friction for models; its compilation times are notoriously
  slow, stalling agent iteration loops; and it's harder for many humans to read
  and review. Rust is not a simple looking language.

I think there is a lot of room for new languages that combine the ergonomics of
TypeScript with the soundness of Rust (plus many awesome ideas from Swift, Dart,
and Kotlin, and friends).

Second, modern LLMs act as **universal translators**. They do not need millions
of pre-existing examples of a specific language if that language's syntax and
semantics map cleanly onto concepts the model already understands.

Zena leans heavily on universal translator abilities through deliberate
familiarity with popular, mainstream languages. The goal is to be able to fairly
accurately describe Zena with a super compact paragraph:

_TypeScript syntax, Wasm GC aligned types, Dart constructors, Swift strings and
`let`/`var` mutability, Trio-style async cancellation, and Scala/Rust-style
sealed classes and pattern matching._

Because these patterns are already thoroughly represented in training data,
agents transfer-learn Zena's syntax immediately even without being in the
training set. And of course, this kind of familiarity is good for human learners
too!

## Preventing invalid states with high-level syntax

A common hypothesis suggests that because models do not suffer from fatigue,
programming languages for AI should discard syntactic sugar and adopt minimal,
simplistic grammars.

But this doesn't actually simplify software; it just shifts complexity from the
compiler into user code. When a language lacks expressiveness, the programmer or
agent must replace missing abstractions with repetitive boilerplate and manual
branching.

Take patterns matching and ADTs. In Zena, they allows us to express valid state
spaces directly:

```zena
sealed class ParseResult {
  case Ok(doc: Document)
  case Empty
  case Error(message: String, line: i32)
}

let outcome = match (parseDocument(input)) {
  case Ok {doc}: process(doc)
  case Empty: fallbackDocument
  case Error {message, line}: logAndAbort(message, line)
};
```

Because the compiler checks exhaustiveness at compile time, an agent cannot
accidentally skip a variant without the compiler raising an error. If an agent
later adds a case, every match against it must be updated.

As Unmesh Joshi observed in his analysis of domain-specific languages and LLMs,
expressive abstractions construct a harness that guides the model. Restricting
valid operations to domain concepts leaves the model far less room to output
invalid states. Strict, high-level constructs let us do that in many cases in
a general programming langauge.

This isn't anything new—ADT and pattern matching proponents have made this
argument for decades. Zena is just treading well-worn ground here, pulling
useful, well-designed features from other languages. It helps agents just as
much as it helps humans.

## Reasoning from syntax and declarations

Beyond control flow, an effective language for AI prioritizes local reasoning:
what can be deduced directly from the current file and explicit definitions.

### Reasoning from syntax: explicit identifiers

In many languages, resolving where an identifier originates requires ambient
knowledge beyond the current file. In Go, every file in a directory implicitly
shares package scope without any import statements; in Java and Rust, wildcard
imports (`import foo.*`, `use foo::*`) pull external symbols into scope
anonymously. In either case, an identifier may be declared in an external file
with no indication of where it came from, forcing an agent into broad multi-file
searches that consume tool calls and context window space.

Zena adopts JavaScript-style explicit module imports (`import { Map } from
'zena:collections'`) and explicit `this.` for member access. Every external
identifier is named at the top of the file, and `this.` unambiguously resolves
field access from local bindings. Both agents and human reviewers know
immediately where every symbol originates.

### Reasoning from types: object shapes are declared

In dynamic languages like JavaScript or Python, properties can be attached,
modified, or deleted at any time, forcing agents to trace all possible execution
paths.

In Zena, object shapes are fixed and declared statically. Fields cannot be added
or deleted dynamically: what is declared is what exists at runtime. Classes
cannot be monkey-patched, `eval` is prohibited, and there are no proxy property
interceptors where reading a property can trigger hidden side effects. When an
agent reads a type definition, that definition completely describes the object's
layout and behavior.

## Garbage collection for simpler programs

At this point, it's definitely debatable whether garbage collection or
Rust-style borrow checking is the better memory management solution for AI
coding agents.

The main argument for borrow checking is usually in comparison to manual memory
management, where Rust is clearly better because it gives us memory safety. But
garbage collection also gives us memory safety and is a perfectly valid way to
do it.

What's interesting to me is that GC is still much easier than Rust-style lifetime
annotations to read, reason about, and especially write. Garbage collection
requires less syntax, fewer annotations, and fewer rules to follow, leaving more
attention available for application logic. For the vast majority of software on
the application and server spectrum, modern garbage collection is more than fast
enough; for the minority of systems requiring zero-cost manual control, Rust
exists.

Rust's borrow checker is also notoriously slow, and Zena is aiming for ultra-fast
compilation to speed up the agent coding loop.

Interestingly, Zena _does_ include a borrow checker! It's not for memory
management, but for non-GC managed resources like file handles, sockets,
structured concurrency, and other external resources from the WASI Component
Model. But Zena's borrow checker is strictly lexical, uses standard generic
wrapper types (`Own<T>`, `Borrow<T>`), and is much easier to reason about.

## Fast Iteration Loops in Agentic Workflows

Coding agents do not write software in a single pass; they operate in tight
feedback loops:

```
Generate Code → Compile → Inspect Diagnostics → Fix Errors → Run Tests
```

In this loop, compiler latency directly limits agent throughput. When an agent
must wait twenty seconds for an optimizing C++ or Rust compiler to evaluate a
small edit, the iteration cycle stalls.

Fast ahead-of-time compilation allows an agent to attempt an implementation,
receive immediate feedback, and self-correct within milliseconds. Zena's
compiler is architected for rapid single-pass type checking and intermediate
representation generation (ZIR), with incremental compilation ensuring
persistent compiler tools remain fast even on large projects.

## WebAssembly as an AI optimization

Sandboxing is often discussed as an operational detail for executing code in
production. In an agentic development environment, sandboxing is central to both
the developer loop and the software architectures that AI enables.

During development, agents generate and execute arbitrary code. If an agent
executes scripts with ambient operating system access, a mistaken shell command
or flawed file manipulation can alter host files or leak credentials. Running
generated code inside a sandbox protects the host system.

Beyond the agent loop, AI changes how end users interact with software.
Applications increasingly allow users to generate custom workflows, automations,
and plugins on demand. These generated extensions run at varying levels of trust
and cannot be allowed unrestricted network or filesystem access.

Traditional isolation mechanisms rely on operating system virtualization: Docker
containers or microVMs (such as Firecracker). While secure, these mechanisms
carry initialization latencies measured in hundreds of milliseconds and memory
overhead measured in tens of megabytes per instance.

WebAssembly provides capability-based isolation with negligible overhead:
microsecond startup, kilobyte memory footprints, zero ambient authority (no
access to filesystem, clock, or network unless explicitly granted via WASI), and
universal portability across browsers, edge nodes, and servers. Because
fine-grained, secure sandboxing is required for both iterative agent development
and runtime application architectures, **being optimized for WebAssembly is
being optimized for AI**.

## Actionable Diagnostics and Structured Tooling

When a human developer encounters a compiler error, they read the message and
consult documentation. For a coding agent, the compiler's diagnostic becomes its
immediate input prompt for the next turn.

Really clear, actionable error messages are essential for agents to self-correct
quickly. A diagnostic should explain _why_ something is an error rather than
just stating that it failed—for example, explaining that an assignment failed
because a variable was declared immutable with `let`, and suggesting changing it
to `var` if mutation was intended. When error messages provide actionable
context, agents can resolve issues in a single iteration step rather than
guessing or hallucinating speculative fixes.

Tooling interfaces also need to adapt. Traditional Language Server Protocol
(LSP) features are built around text editor concepts: cursor positions, line and
character offsets, and active window buffers. This is an awkward interface for
agents, which navigate code programmatically rather than by simulating
keystrokes. Exposing compiler capabilities through structured CLI commands and
tool-calling APIs (like MCP) returning structured JSON—allowing agents to query
symbol definitions, find references, or inspect type hierarchies directly—lets
agents explore and manipulate codebases far more reliably.

## Composition over Monolithic Generation

A capability of large language models is their ability to generate extensive
amounts of code from natural language descriptions. This can lead to the
assumption that software ecosystems will dissolve: if an agent can generate a
custom router, parser, or utility on demand, third-party libraries might seem
unnecessary.

But generating every component from scratch creates long-term hazards: subtle
edge-case omissions, security vulnerabilities, and other tech debt debt.
Software engineering continues to require composition over generation: agents
should reuse high-quality, vetted libraries whenever available to conserve
context tokens and ensure correctness.

Zena achieves ecosystem composition through the **WebAssembly Component Model**.
Zena can compile to standard WASI components and directly import WIT files, so
libraries can be composed with components written in Rust, C, Go, or Python
without custom FFI glue code or shared runtime dependencies. And when a needed
library does not yet exist, then an agent can generate or port a working
implementation on the fly.

### The Language Creation Flywheel

A final implication of AI assistance is the speed with which new language
ecosystems can develop. Historically, establishing a new programming language
required decades of human effort to write parsers, optimizing backends,
formatters, language servers, documentation, and standard libraries.

With AI assistance, this timeline compresses dramatically. Zena itself is proof:
a self-hosted compiler, runtime, language server, and documentation site were
built and bootstrapped in months, with human architectural direction and review.
Far from ossifying the programming language landscape around legacy
technologies, AI makes it feasible to design, iterate, and deploy modern,
domain-optimized languages built specifically for emerging platforms like
WebAssembly.

## Summary

The rise of AI coding agents does not make programming language design obsolete;
it elevates the importance of sound design choices. When software generation
accelerates, the quality of our programming languages matter *more*, even as the
bottleneck shifts to verification, sandboxing, and long-term maintainability.

A programming language suited for this era provides:

- **Expressive, high-level abstractions** that constrain the state space and
  minimize cognitive overhead for both models and human reviewers.
- **Sound, strict typing** with explicit null safety and no unchecked escapes.
- **Fast compilation** that enables responsive agent self-correction loops.
- **Structured programmatic tooling** that exposes compiler semantics directly
  to agents.
- **Fine-grained, capability-based sandboxing** to execute generated code safely
  during development and inside end-user applications.

By targeting WebAssembly GC and building on sound static principles, Zena aims
to provide an ideal environment designed specifically for this next era of
software development.
