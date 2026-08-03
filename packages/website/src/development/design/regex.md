---
title: 'Regular expressions'
description: 'A regex engine in Zena.'
---

Regular expressions are challenging in WebAssembly because the binary must ship
the entire regex engine, and the engine can't use a JIT like the fastest engines
today do.

Zena's `zena:regex` library is implemented as a plain library with no special
language support for now. In the near future the compiler may add an
optimization pass to compile statically known regular expressions both for
performance and so that the regex engine's parser and compiler have a chance to
be dead code eliminated.

`zena:regex` must be imported to be used, it is not imported in the prelude.

```zena
import {Regex, regex} from 'zena:regex';

let re = regex`^[a-z]+$`;

if (re.test(input)) {
  // ...
}
```

## Engine size

WebAssembly provides no host regex engine to call. Some hosts, like JavaScript,
may have a regex engine available, and WASI could conceivably add an engine one
day, but standard Wasm does not have one. So as a baseline, Zena must have a
regex library.

That makes engine size a priority, and future size optimizations, like
pre-compiling patterns to eliminate the parser and compiler, important.

We also want to leave the door open for using a host's regex engine if
available, but that would require `zena:regex` to be a virtual library, a
compiler flag to swap the implementation, and careful analysis and possibly
shims to ensure the same behavior across engines.

## No JIT in Wasm

The fastest engines compile a pattern to machine code at runtime: V8's
Irregexp, PCRE2's JIT. A Wasm module cannot generate code into itself, so
`zena:regex` interprets a pattern that it compiled to data.

## Linear-time matching

We want to avoid ReDoS attacks, and catastrophic backtracking in general.

We choose a Thompson NFA simulation — a Pike VM tracking a set of live
threads, the design used by RE2 and Go's `regexp`. Matching is O(n·m) in the
length of the input and the size of the pattern.

Backtracking is faster on typical patterns and unboundedly slow on bad ones.
`(a+)+$` against a non-matching string takes exponential time in a backtracking
engine. For programs that may run untrusted input this is not acceptable.

The downside of a Thompson-style NFA engine is that backreferences and
lookaround are unsupported. Both require backtracking.

## Patterns as strings

A pattern is a string or a tagged template. The tag is preferred because tagged
templates receive the raw text, so backslashes are not doubled:

```zena
let a = new Regex('\\d+');
let b = regex`\d+`;
```

Zena has no `/pattern/` literal like JavaScript does. Deciding whether `/`
starts a pattern or divides two numbers requires parser context in the lexer,
which is a complication that JavaScript tooling has to pay for. Zena keeps
lexing separate from parsing.

One downside is that malformed patterns passed to `new Regex()` are caught at
runtime.

In a `regex` template it can conceivably be caught at compile time: the compiler
can recognize the stdlib tag, parse the pattern, and report at the template.
This is technically independent of compile-time specialization, but would likely
be done with it.

## Compile-time specialization

The `regex` tag carries the pattern in the expression:

```zena
let re = regex`\d+`;
```

The easiest form of ahead-of-time pattern compilation would use the existing
matcher and not require the pattern parser and compiler, which could be
eliminated if there are no `new Regex()` calls in the program.

A more aggressive approach would generate matching code for the pattern, in the
manner of re2c or Ragel, which emit a state machine in the target language at
build time. The risk there is size - converting an NFA to a DFA can blow up
exponentially in states, which is why RE2 builds its DFA lazily behind a bounded
cache. Emitting one ahead of time could cost more code than the interpreter it
replaces.

We prefer the tagged form for AOT compilation. `new Regex(pattern)` takes a
`String`, so specializing it requires proving the argument is constant at each
call site - a feature Zena doesn't have yet. A tagged template applies a known
function to literal text, so no analysis is needed.

Not implemented.

→ Working document:
[`docs/design/regex.md`](https://github.com/elematic/zena/blob/main/docs/design/regex.md)
