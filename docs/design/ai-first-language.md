# AI-First Programming Language Design

This document explores what a programming language designed specifically for the era of generative AI should look like.

## The Thesis

The rise of AI coding assistants and autonomous coding agents fundamentally changes the trade-offs in programming language design. Traditional design balanced human productivity, expressiveness, and safety—often favoring convenience over correctness because humans found boilerplate tedious and verbose syntax annoying.

AI changes this calculus:

1. **AI generates large volumes of code** — often more than humans can carefully review
2. **AI makes mistakes** — sometimes subtle ones that humans miss
3. **Humans don't review AI code well** — eyes glaze over, trust is too high
4. **Humans can't review at scale** — the volume exceeds human capacity
5. **Autonomous agents need fast feedback** — to self-correct without human intervention

### Code Makes Round-Trips Through AI

**Code now cycles through AI repeatedly.** AI generates code today, which gets committed to a codebase, which becomes context for AI in future sessions. The code AI writes becomes the code AI reads.

This means messy code propagates—sloppy patterns become templates for future generations. Conversely, if the language enforces clean patterns, that cleanliness compounds. Every piece of generated code is potentially training data for future AI sessions.

### The Overarching Goal

**Make it easier for AI agents to write correct and reliable code.**

We achieve this by shifting responsibility for correctness from human review to automated tooling. The language and ecosystem should catch as many errors as possible through static analysis and runtime checks, leaving humans to focus on high-level design and intent verification.

Three complementary strategies:

1. **Automated Correctness** — Static types, contracts, testing, and linting catch bugs without human effort
2. **Limiting State Space** — Immutability, fixed shapes, and eliminating dynamic behavior reduce possible states, making code easier to reason about
3. **Consistency & Reviewability** — Canonical formatting, rich syntax, and comprehensive stdlib produce uniform code that's easy for both AI and humans to read, write, and review

## An AI-First Language Must Still Be Human-First

A critical constraint: **an AI-first language must also be a great language for humans.**

Humans still need to review generated code, debug and maintain it, understand intent, and collaborate alongside AI. This means the language must be easy to read (clear, consistent syntax), easy to reason about (predictable semantics), and easy to review (patterns that rule out entire bug classes at a glance).

Strict patterns like immutability aren't just for correctness—they're **force multipliers for human review**. When a reviewer sees an immutable data structure, they immediately know it won't be modified elsewhere, there are no race conditions, and the value at creation is the value everywhere. That's an entire category of bugs they don't need to think about.

**The goal is not to remove humans from the loop, but to make their time in the loop maximally effective.**

---

## Strategy 1: Automated Correctness

The first line of defense: **tools that catch bugs automatically**, without requiring human review or runtime execution.

### Static Typing

**Static typing is non-negotiable.** Dynamic languages trade compile-time safety for development speed, but AI doesn't benefit from that trade-off—it generates types as easily as code.

Benefits: errors appear at the source (not at some distant runtime location), agents get immediate feedback without running code, types serve as machine-readable documentation, and refactoring propagates through the type system.

```zena
let processUser = (id: i32, name: string, settings: UserSettings): Result<User> => {
  // Type system ensures correct usage throughout
};
```

### Sound Type System

Many languages trade soundness for convenience. TypeScript has intentional unsoundness (bivariant function parameters, `any`, type assertions) because humans found strict typing burdensome. **AI doesn't share this burden.** We can reclaim soundness.

**Non-nullable by default**: References cannot be null unless explicitly marked (`string` vs `string | null`), eliminating the "billion dollar mistake" at compile time.

**No implicit coercion**: Operations require matching types. No silent `"1" + 1 = "11"` surprises.

**Checked casts**: Downcasts are verified at runtime—if invalid, they trap rather than silently succeeding.

**Two-phase construction**: Classes must fully initialize all fields before `this` escapes, eliminating "partially constructed object" bugs.

**Declaration-site variance**: Generics are invariant by default, with explicit `in`/`out` modifiers. This prevents the array covariance footgun from Java and C#.

### Contracts and Invariants

Design-by-contract features make function requirements explicit and machine-checkable.

```zena
let withdraw = (account: Account, amount: i32): Account
  requires amount > 0
  requires account.balance >= amount
  ensures result.balance == account.balance - amount
=> { ... };
```

**Contracts can be gradual.** TypeScript developers already use lightweight contracts: type annotations (shape), non-nullable types (presence), exhaustive matches (coverage). Simple contracts feel natural; richer contracts are available for critical code.

**What can the compiler verify?** There's a spectrum from runtime-only (Eiffel—just inserts checks) to simple static analysis (null, exhaustiveness—decidable without extra annotations) to refinement types (SMT solver verifies predicates like `x > 0`) to full dependent types (requires proofs—far from TypeScript).

The practical sweet spot: runtime contracts as baseline, flow-sensitive null/exhaustiveness checking, optional refinement types where the compiler tries to verify and falls back to runtime. Even runtime-only contracts help AI agents—"precondition `b != 0` violated" is more actionable than a crash.

### Mandatory Linting

Checks that are historically optional lint rules should become compiler errors: unused variables and imports, unreachable code, unhandled promises/futures, implicit `any` types, non-exhaustive pattern matches, shadowed variables.

```zena
match (status) {
  case 'pending': handlePending()
  case 'complete': handleComplete()
  // Error: Non-exhaustive match. Missing: 'failed'
}
```

### Built-in Testing

When testing is a language feature, the compiler provides deeper integration—type-checked assertions, structured output for agents, coverage analysis.

**Property-based testing** is more natural for AI than example-based testing. "For all X, property P holds" is declarative and specification-like. The framework generates random inputs—including edge cases—and finds counterexamples.

```zena
property "reverse twice is identity" {
  forall (list: array<i32>) {
    assert(list.reverse().reverse() == list);
  }
}
```

**Mutation testing** provides stronger guarantees—automatically mutate code and verify tests fail. If a mutation survives, the tests don't verify that behavior.

**Fakes over mocks**: Mocks encode assumptions about *how* a dependency is called. Fakes—simplified real implementations—are easier to reason about. AI excels at generating fakes since implementing interfaces isn't tedious for it.

### Actionable Error Messages

AI agents need feedback to self-correct. Errors should be specific, contextual (expected vs. found), suggestive (possible fixes), and machine-parseable.

```
error[E0308]: type mismatch
  --> src/main.zena:15:12
   |
15 |   return user.name;
   |          ^^^^^^^^^ expected `i32`, found `string`
   |
   = help: did you mean `user.id`?
```

---

## Strategy 2: Limiting State Space

The second line of defense: **reduce the number of possible states** a program can be in. Fewer states means fewer bugs, simpler reasoning, and easier review.

### Immutability by Default

Mutable state causes race conditions, unexpected side effects, stale caches, order-dependent initialization.

```zena
let point = {x: 1, y: 2};        // Immutable record
// point.x = 3;                   // Error: records are immutable

let mutableArray = #[1, 2, 3];   // Mutable (explicit #[] syntax)
let immutableArray = [1, 2, 3];  // Immutable tuple
```

When reviewers see immutable data, they skip entire categories of questions: "Modified elsewhere? Race condition? Current state?" The answer is always: "It's the value at creation."

### Fixed Object Shapes

In JavaScript and Python, objects can have properties added or removed at any time. A reviewer can never be certain what properties exist just by looking at the class definition.

```javascript
// JavaScript - shape can change at any time
const user = { name: "Alice" };
user.email = "alice@example.com";  // Added
delete user.name;                   // Removed
// What properties does user have? Requires tracing all code paths.
```

In a sound language, objects have a fixed shape defined by their class. What you see in the definition is what exists—period.

### Eliminating Dynamic Behavior

Dynamic features feel productive but create hidden complexity:

**Monkey patching**: Modifying classes at runtime means reviewers can't assume a class behaves as defined.

**eval and dynamic execution**: Defeats static analysis, opens security vulnerabilities.

**Magic methods**: Python's `__getattr__`, Ruby's `method_missing`, JavaScript's `Proxy`—an innocent `obj.name` could execute arbitrary code.

**Implicit globals**: JavaScript (non-strict) creates globals on assignment to undeclared identifiers. A typo silently creates a new variable.

**`this` binding ambiguity**: JavaScript's `this` depends on how a function is called, not where it's defined.

An AI-first language should have predictable, statically-analyzable semantics. When a reviewer reads a class definition, they know its complete shape. When they see a property access, it's just a property access. No magic, no surprises.

### Explicit Over Implicit

AI benefits from explicit code—every token carries information, less hidden behavior, fewer surprises. However, **local type inference is valuable**: it reduces redundancy and eliminates mismatched explicit types.

```zena
// Good: Type inferred, no redundancy
let count = 0;
let users = #[user1, user2];  // Inferred as array<User>

// Good: Explicit at API boundaries
let processUser = (user: User): Result<void> => { ... };
```

**Explicit is better for**: function signatures (API contracts), visibility modifiers (default restrictive), mutability (`let` vs `var`), nullability (`T` vs `T | null`).

### Strong Encapsulation

Encapsulation creates **trust boundaries** that let reviewers safely ignore implementation details. Private by default—public APIs are explicit commitments.

```zena
class UserService {
  #cache: Map<i32, User>;        // Private - ignore during review
  #db: Database;                  // Private - implementation detail
  
  getUser(id: i32): User { ... }  // Public - this is the contract
}
```

---

## Strategy 3: Consistency & Reviewability

The third line of defense: **make code uniform across the ecosystem** so AI produces consistent output and humans can review efficiently.

### Canonical Formatting

**AI generates more consistent code when the target format is unambiguous.** A single, canonical style with no configuration (like `gofmt`) eliminates variation and enables clean round-tripping—code that goes through AI comes back in the same format.

### Rich, High-Level Syntax

One might assume AI would prefer minimal syntax—like Lisp. But **AI handles rich syntax well**, and high-level constructs are actually better for AI-generated code: token efficiency (more meaning per token), clearer intent, standardized patterns instead of ad-hoc implementations.

```zena
// Pattern matching - one way to write it, compiler enforces exhaustiveness
let describe = (shape: Shape): string => match (shape) {
  case Circle { radius }: `Circle with radius ${radius}`
  case Rectangle { width, height }: `Rectangle ${width}x${height}`
  case Point { x, y }: `Point at (${x}, ${y})`
};
```

Other valuable rich syntax: **destructuring**, **optional chaining** (`?.`), **null coalescing** (`??`), **string interpolation**, **for-of loops**, **async/await**. Each turns "convention" into "the only way."

### Familiar Syntax

A new language won't be in training data, but syntax can borrow heavily from popular languages—TypeScript (type annotations, arrow functions), Rust (pattern matching, `Result<T, E>`), Kotlin/Swift (null safety), Python (comprehensions). This enables transfer learning.

### Batteries-Included Standard Library

AI benefits from consistent, well-documented APIs that appear frequently in training data. A comprehensive stdlib means one way to do common tasks, consistent patterns, and quality documentation.

Essential areas: collections (List, Map, Set), IO, text processing (string, regex, JSON), HTTP, testing, async primitives, common utilities (math, time, crypto).

### Structured Documentation

Documentation should be structured for machine consumption: type-annotated examples, migration guides ("Coming from TypeScript"), error catalogs with explanations, and design rationale (helps AI understand intent).

---

## Practical Concerns

Beyond the three strategies, several practical considerations affect AI-first language design.

### Garbage Collection

Manual memory management and borrow checking add cognitive overhead—more code to generate, more ways to fail, harder to verify. **GC removes this entire problem class**, letting AI focus on business logic.

### Fast Compilation

In an agentic loop, compilation time directly impacts productivity. Targets: incremental compilation, parallel compilation, sub-second feedback for typical edits.

### Sandboxed Execution

AI-generated code should run in isolation. **WASM provides an ideal sandbox**: memory-safe, capability-based (no ambient authority), portable, fast startup. This enables safe execution of untrusted code and reproducible builds.

### Deterministic Builds

Reproducibility is essential: lockfiles for exact versions, no ambient state, content-addressed caching, hermetic builds (no network during build).

### Minimal Metaprogramming

Macros create invisible complexity—code doesn't mean what it looks like, errors occur in generated code. **Prefer built-in features over macros.** If needed, keep metaprogramming hygienic and limited.

### Limited Escape Hatches

Escape hatches (`any`, `unsafe`, `dynamic`) should be explicitly flagged, minimally scoped, and auditable.

---

## Additional Considerations

### Effect System

Track side effects in the type system:

```zena
let pureAdd = (a: i32, b: i32): i32 => a + b;           // Pure
let readFile = (path: string): IO<string> => { ... };   // Has IO effect
```

This enables compiler optimization (pure functions can be memoized), easier testing (pure functions need no mocking), and clearer reasoning (know what a function can do from its signature).

### Concurrency Model

Concurrency bugs are subtle. The language should provide high-level primitives (async/await, channels, actors), avoid shared mutable state (or require explicit synchronization), and enable deadlock prevention through static analysis where possible.

### Semantic Versioning Enforcement

API compatibility matters: compiler warns on incompatible public API changes, deprecation support for gradual migration, version bounds on dependencies.

---

## The Meta-Argument: AI Can Build Languages

A secondary thesis: **LLMs can help create new programming languages.**

Critics argue that AI has ossified the language landscape—models only know languages in their training data. But the opposite may be true:

1. **Ecosystem costs are lower**: AI can generate IDE plugins, docs, examples, linters
2. **Bootstrapping is faster**: A working compiler can be built in months, not years
3. **Quality examples**: AI can generate diverse, idiomatic code for training
4. **Rapid iteration**: Design feedback is fast when AI can refactor the compiler

This creates a potential flywheel: build language with AI assistance → generate high-quality examples → train models on this code → improved models generate better code → community grows.

---

## Summary

An AI-first programming language prioritizes:

- **Automated Correctness**: Static types, soundness, contracts, mandatory lints, built-in testing
- **Limited State Space**: Immutability, fixed shapes, no dynamic behavior, explicit over implicit
- **Consistency**: Canonical formatting, rich syntax, familiar patterns, comprehensive stdlib
- **Practicality**: GC, fast compilation, sandboxed execution, deterministic builds

The goal is to move as much verification as possible from human review to automated tooling, enabling AI agents to iterate quickly while producing code that humans can trust.

---

## Appendix: Zena's Alignment

Zena was designed with many of these principles in mind:

| Principle | Zena Implementation |
|-----------|---------------------|
| Static typing | Full static type system |
| Sound types | Non-nullable by default, checked casts, no implicit coercion |
| Immutability | Records/tuples immutable, `let` for immutable bindings |
| GC | WASM-GC backend, no manual memory management |
| Familiar syntax | TypeScript-like with Rust-inspired pattern matching |
| Rich syntax | Pattern matching, destructuring, template literals |
| WASM output | Primary compilation target |
| Fast feedback | Designed for quick incremental compilation |

See [Language Reference](../language-reference.md) for details.
