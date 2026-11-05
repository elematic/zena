---
title: 'Working with AI Agents'
description: 'How Zena’s sound type system, runtime contracts, fast compiler, and unified CLI support autonomous coding agents and human code review.'
---

AI coding agents change where engineering effort goes: generating code is cheap,
and verifying that generated code is actually right becomes the bottleneck. Code
also makes repeated round-trips through models—what an agent commits today
becomes the surrounding context future sessions imitate tomorrow.

Zena is designed around that reality. Its syntax stays close to TypeScript so
models can write it immediately, while its compiler, contracts, formatter, and
linter shift correctness checks from human eyes onto fast, deterministic tools.
(Zena's own self-hosted compiler and standard library are built using this exact
workflow; see [Built with AI](/development/built-with-ai/).)

## Why Zena is designed for agent feedback loops

Several language choices work together when an agent writes, compiles, and
iterates on Zena code:

- **Familiar syntax with strict semantics**: Models already know TypeScript-style
  declarations, arrow functions, generics, and `import`/`export` syntax from
  training data. Removing JavaScript's silent coercions, `any`, truthiness, and
  unbound `this` catches plausible-looking mistakes at compile time instead of
  letting them slip through review.
- **Small, inspectable state space**: Local bindings (`let`) and class fields are
  immutable by default, records and tuples are immutable values, and classes have
  fixed field layouts with `#private` encapsulation. A human reviewing a diff can
  tell what a function can mutate from its types alone.
- **Sub-second feedback**: Agents run the compiler and test runner dozens of
  times per task. Fast compilation keeps the inner edit-check-test loop tight so
  agents fix errors in place rather than guessing.
- **Capability-sandboxed execution**: Compiled Zena modules run inside
  WebAssembly (via `zena run` on Wasmtime or in the browser) with no ambient
  filesystem, network, or subprocess access unless explicitly granted on the
  command line. Running agent-generated tests does not expose the host machine by
  default.

## Contracts and machine-checked intent

The hardest agent mistakes to spot in code review are semantic bugs in code that
type-checks cleanly—off-by-one bounds, inverted comparisons, or methods that
update one field while forgetting another. [Contracts](/guide/contracts/) turn
those domain assumptions into executable specifications attached directly to
function signatures and loops:

```zena
import {div} from 'zena:math';

function splitAmount(total: i32, parts: i32): FixedArray<i32>
  requires (total >= 0)
  requires (parts > 0)
  ensures (result.length == parts)
{
  let base = div(total, parts);
  let remainder = total % parts;
  let shares = new FixedArray<i32>(parts, base);

  var distributed = base * parts;
  for (var i = 0; i < remainder; i += 1)
    invariant (0 <= i && i <= remainder)
    invariant (distributed == base * parts + i)
  {
    shares[i] += 1;
    distributed += 1;
  }
  return shares;
}
```

Contracts improve human-agent collaboration in four concrete ways:

1. **Review the signature, test the body**: A human can write—or review—the
   parameter types, `requires`, and `ensures` clauses on a function in a few
   lines while delegating the implementation and edge-case tests to an agent.
2. **Immediate fault localization**: Unmarked `requires`, `ensures`, and
   `invariant` clauses run in every build, and `debug` clauses run under
   `zena test` and `--debug` (`-g`) builds. When generated code breaks an
   assumption during `zena test`, it throws a `ContractError` naming the exact
   clause that failed (for example,
   `ensures (this.count == old(this.count) + 1) does not hold`) at the boundary
   where the bug occurred, rather than corrupting state that surfaces much later.
3. **Thorough test-time checks with `debug`**: Agents run `zena test`
   continuously, so marking expensive $O(n)$ checks with `debug requires`,
   `debug ensures`, or `debug invariant` (such as `debug requires (isSorted(items))`)
   catches subtle algorithmic bugs during agent iteration while emitting zero
   code in ordinary production builds.
4. **Flow-sensitive narrowing**: Conditions in unmarked `requires` clauses
   narrow nullable unions and sealed variants in the body (`debug requires`
   does not narrow, since ordinary builds omit it), preventing agents from
   sprinkling redundant null checks inside functions whose callers already
   satisfy the precondition.

### Where contracts are headed

Contracts continue expanding along two tracks:

- **Broader callable coverage**: Clauses on generators, bodyless interface and
  abstract methods, and `ensures` on `async` functions and `inline` returns are
  currently rejected by the compiler while their lowering is completed.
- **Static verification**: Longer term, Zena plans to pair contracts and loop
  invariants with SMT-backed verification (`@verify` and `ghost` clauses) so an
  agent can propose both implementation code and loop invariants while the
  compiler proves the postconditions hold for all inputs.

## Diagnostics agents can act on

Agents self-correct reliably when error messages pinpoint the exact location,
state what was expected versus found, and avoid cascading noise:

- **Source-spanned compiler errors**: Type mismatches, missing `match` arms,
  uninitialized fields, and unsupported contract positions report exact file,
  line, and column spans with concrete types.
- **Exhaustiveness as a worklist**: When adding a variant to a `sealed class`,
  the compiler flags every `match` expression across the workspace that needs a
  new `case` arm, giving an agent an exact checklist of call sites to update.
- **Type-checked lint autofixes**: `zena lint` reports idiomatic improvements
  (such as converting non-capturing top-level arrows to `function` declarations,
  tightening `var` to `let`, or simplifying nullable expressions to `??`/`?.`),
  and `zena lint --fix` type-checks every rewrite before keeping it.
- **Debug mode (`-g` / `--debug`)**: Building or running with `-g` (`zena -g build`
  or `zena -g run`) compiles `debug` contract clauses and emits the WebAssembly
  name section so traps and uncaught `ContractError` exceptions report class and
  function names instead of raw Wasm function indices (`zena test` enables
  `debug` contract clauses automatically).

## Tooling hooks

A single `zena` binary provides the commands an agent or editor integration needs
without assembling third-party plugins:

| Command                                 | Purpose in an agent workflow                                                                                      |
| :-------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| `zena test [paths...]`                  | Compile and run `*_test.zena` suites in parallel; filter to a single area with `-f <substring>`.                  |
| `zena build <entry.zena> -o <out.wasm>` | Type-check and compile a module or WASI component (`-g` for debug symbol names).                                  |
| `zena run <file.zena>`                  | Compile through the cache and execute immediately under Wasmtime; grant host directories explicitly with `--dir`. |
| `zena fmt --check` / `zena fmt -w`      | Enforce canonical formatting so generated diffs stay minimal and consistent across sessions.                      |
| `zena lint` / `zena lint --fix`         | Flag non-idiomatic patterns and apply verified rewrites automatically.                                            |
| `zena doc <path> -o api.json`           | Extract a package's public signatures and doc comments as structured JSON for agent context.                      |
| `zena lsp`                              | Run the Zena language server over stdio for IDE diagnostics, hover types, and quick fixes.                        |

## Practical tips

- **Give agents a short Zena cheat sheet in `AGENTS.md` or `CLAUDE.md`**: Note
  the handful of differences from TypeScript up front—`let` vs `var`, `String`
  with a capital `S`, `function` for top-level non-closure declarations, `/`
  returning a float (`div(a, b)` from `zena:math` for integer division), and
  `sealed class` + `match` instead of discriminated object unions. The
  [Quick Reference](/reference/quick-reference/) is structured for both human and
  agent lookup.
- **Specify boundaries with types and contracts first**: Write the public types,
  `distinct type` wrappers, and `requires`/`ensures` clauses before asking an
  agent to fill in an algorithm. The clauses document edge cases (`amount > 0`,
  `low <= high`) and catch bad implementations on the first `zena test` run.
- **Write a failing test before fixing a bug**: Have the agent reproduce each bug
  in a `*_test.zena` file (including `ContractError` checks where preconditions
  apply), observe the failure with `zena test -f <name>`, and then implement the
  fix.
- **Keep formatting and linting in the loop**: Run `zena fmt -w` and
  `zena lint --fix` before reviewing diffs so human review focuses on behavior,
  contracts, and architecture rather than style churn.

## Next

- [Contracts](/guide/contracts/) — preconditions, postconditions, `old()`, and loop invariants
- [Correctness and Safety](/guide/correctness/) — how sound types and contracts prevent bug classes
- [Built with AI](/development/built-with-ai/) — lessons from building Zena itself with coding agents
- [Quick Reference](/reference/quick-reference/) — compact syntax summary ideal for agent context
