# ZIR: the wasm backend (`codegen/ir/`)

ZIR is a CFG+SSA mid-level IR. It is the compiler's **only** backend:
every reached function compiles AST → ZIR → wasm bytes. A lowering
bail (`ZirUnsupported`) is a compiler bug and fails the compile — never
a silent fallback.

Design doc: [`docs/design/ir.md`](../../../../../../docs/design/ir.md)
(section numbers below refer to it). Upstream of this directory,
[`../reachability/`](../reachability/CONTEXT.md) (RTA) decides _what
exists_ — reached functions, generic instantiations, vtables — and
populates the `WasmModule` model; ZIR only compiles what RTA reached.

## Per-function pipeline

Driven by `module-generator.zena` for each `wasm.functions` entry:

```
lowerFunction(wasm, func)   → IrBody        (lowering.zena)
runGvn(body, new IrCfg(body))               (gvn.zena, cfg.zena)
verifyIr(body)              → throws on any error (verifier.zena)
emitZirFunction(...)        → wasm bytes    (emit.zena)
```

## File map

| File                    | Role                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ir.zena`               | Instruction set (`IrOp`), `IrBody` flat-array encoding, operand decoding. `appendValueOperands` and `rewriteValueOperands` are branch-for-branch mirrors — **keep them in sync** when adding ops.                                                                                                    |
| `builder.zena`          | `IrBuilder`: append-only construction API used by all lowering code.                                                                                                                                                                                                                                 |
| `cfg.zena`              | CFG + dominator tree (RPO) over an `IrBody`.                                                                                                                                                                                                                                                         |
| `lowering.zena`         | `FunctionLowerer` — the core: SSA environment, expression/statement dispatch, calls, member access, constructors. Ends with the exported **recursion seams** (below).                                                                                                                                |
| `lowering-context.zena` | `LoweringContext` (`cx`) — the one shared state object every lowering module receives. `cx.host` is the `FunctionLowerer` coordinating the current function.                                                                                                                                         |
| `control-flow.zena`     | if/while/for/for-in/try/match statement shapes, let-conditions.                                                                                                                                                                                                                                      |
| `patterns.zena`         | Pattern test/bind machinery (tuples, records, or-patterns, destructuring).                                                                                                                                                                                                                           |
| `operators.zena`        | Binary/unary/compound operators, operator-method dispatch.                                                                                                                                                                                                                                           |
| `equality.zena`         | `==`/`hashCode`: case-class synthesizers, erased eq diamond, eq/hash intrinsics.                                                                                                                                                                                                                     |
| `templates.zena`        | Template literals and tagged templates.                                                                                                                                                                                                                                                              |
| `intrinsics.zena`       | One function per `@intrinsic`; `lowerIntrinsic` is a pure router.                                                                                                                                                                                                                                    |
| `scaffold.zena`         | Helpers synthesized without an AST (string creation/hashing, wasi write).                                                                                                                                                                                                                            |
| `generators.zena`       | The generator split pass (generators.md §5): presplit-lowers `gen` bodies, synthesizes frame structs + `next()` + `Iterator<T>` vtable globals between RTA and layout, rewrites bodies into dispatcher-loop state machines.                                                                          |
| `async.zena`            | The async split pass (async.md §3): the same treatment for `async` bodies — frame structs + `step()` + `Resumable` vtable globals, an eager ramp, a `try_br` failure-capture region, and the async-`main` export wrapper. Shares generators.zena's raw-IrBody helpers, liveness, and edge rerouting. |
| `gvn.zena`              | Dominator-scoped value numbering; string keys + id-order walk keep it deterministic.                                                                                                                                                                                                                 |
| `verifier.zena`         | Structural/type checks on `IrBody`; failures are loud compile errors.                                                                                                                                                                                                                                |
| `emit.zena`             | SSA destruction: stack scheduling (`#pushValue` discipline), block-param copy coalescing, domtree stackifier, terminator streaming.                                                                                                                                                                  |
| `printer.zena`          | ZIR-as-WAT-comments dump for debugging and snapshots.                                                                                                                                                                                                                                                |

## The import cycle (deliberate)

This directory is a real module cycle: the per-construct modules import
`lowerExpr`/`lowerExprRaw`/`lowerStmt`/`varDecl`/`throwStmt`/
`multiSource`/`optionalHit` as top-level fully-annotated functions from
`lowering.zena` (the "Recursion seams" section at the end of that
file), and `lowering-context.zena` imports `FunctionLowerer` back. The
language's cycle rules (`docs/design/import-cycles.md`) allow this:
nominal types and fully-annotated functions cross back edges freely;
module-level **values** do not. When adding a new emission module,
follow the same pattern — import the seams, take `cx` as the first
parameter.

## Invariants that bite

- **SSA via block params, not phis.** The environment maps each
  variable symbol to its current value id; joins introduce block
  parameters for variables assigned in the joined regions; loop headers
  carry params for everything assigned anywhere in the loop (pre-scan).
- **One non-SSA construct: mutable variables** (`var_get`/`var_set`,
  ir.md §5.1.1), each pinned to its own wasm local. They exist because
  a handler edge leaves from anywhere in a protected region and so can
  carry only entry-live values, which is not enough for locals the
  `try` body assigns. Every site that stores a new SSA value for a
  symbol into `env` must call `noteVarWrite` — a missed one leaves the
  handler reading a stale value, and nothing else will catch it.
- **Determinism is a hard gate.** Stage-2 byte parity (below) fails on
  any iteration-order- or identity-dependent output. No wall-clock, no
  randomness, no hash-order-dependent emission.
  - It only gates output as a function of _input_, though: both stages
    are separate processes, each compiling one module, so it cannot see
    output that depends on what the **process** did earlier. `WasmType`
    and `WasmFunction` hash by a uid from a counter, so that counter
    ordered every hash container keyed by one — and left running across
    modules it made the fourth module in a process compile differently
    from the first, and often fail outright. `ModuleGenerator.compile`
    restarts it per module; `multi-entrypoint-codegen_test.zena` guards
    it. Any new process-global in codegen needs the same treatment, and
    a `^var ` at module scope under `codegen/` is the smell.
- **Every operand load in emit goes through `#pushValue`** (except the
  copy-semantics `#copyArgs`). It enforces the stack schedule and
  throws on violations — those asserts catch real bugs; don't bypass
  them with raw `emitLocalGet`.
- **Bail messages name their pool.** Keep the `[in <function>]` suffix
  and the reason wording stable; `ZENA_ZIR_STATS=1` prints a histogram
  of bail reasons, and diagnosis relies on tagging a bail with the
  function/type names, rerunning, then reverting the tag.

## Verification workflow

Run from `packages/zena-compiler/`. When editing anything under
`zena/`, wireit's staleness tracking and zena-cli's compile cache can
both serve stale results: `rm -rf .wireit ../../.zena/cache` first.

```bash
npm test                       # unit + syntax + semantics + execution + interop + fixpoint
npm run test:execution -- classes            # filter one category
ZENA_ZIR_STATS=1 npm run build:self-hosted   # self-compile; expect 0 bails
UPDATE_SNAPSHOTS=1 npm run test:unit         # regenerate zir WAT snapshots
```

Snapshot tests fail on _any_ emission change — regenerate and eyeball
the diff rather than fighting them.

**That is exactly why a snapshot alone cannot guard a property.** The
regression and the innocent reformat produce the same failure, and
regenerating accepts both. When emission has to keep a property —
"this function does not allocate", "this shape still compiles to a
protected region" — assert the property too, with
`zena/test/wat-invariants.zena`:

```zena
assertNoAllocation(wat, '$main', 'a try-assigned local is mirrored into a wasm local');
assertFunctionUses(wat, '$main', usesTry, 'the fixture should compile a try region');
assertFunctionOmits(wat, '$name', ops, why);
```

They scope to one function (a module-wide `contains` proves close to
nothing, since reachability drags in the stdlib) and name the property
in the failure. Pair them with a snapshot: the snapshot shows you what
changed, the invariant tells you whether it mattered. Write the
invariant so you have SEEN it fail — force the old lowering back, watch
the message, revert.

The final gate for backend changes is **stage-2 byte parity**: the
compiler compiled by itself must byte-match the compiler that compiled
it:

```bash
npm run build:self-hosted   # writes zena/out/cli-self.wasm
ZENA_GC_RESERVE_MB=1536 ZENA_COMPILER_WASM=zena/out/cli-self.wasm \
  ../../target/release/zena-cli build zena/cli/main.zena -o zena/out/cli-self2.wasm
cmp zena/out/cli-self.wasm zena/out/cli-self2.wasm
```

Note: compiler-source refactors change the self-compile _input_, so
self-compile output is not a parity signal for them — byte-compare a
fixed input program instead.

## Debugging traps

- `ZENA_EMIT_WAT=1` writes a `.wat` dump next to the output (huge; a
  second full generator pass — leave off otherwise).
- Build with `-g` (`npm run zena -w @zena-lang/zena-cli -- -g build ...`)
  for a name section; then map a trap PC with `wasm-tools print
--print-offsets` and read the surrounding WAT against the source.
- Suspected miscompile in the self-compile: add a temporary index-range
  env filter in module-generator's function loop and bisect — a culprit
  function falls out in ~15 iterations.
- Standalone lib-module builds (`zena-cli build zena/lib/X.zena`) are a
  fast trap probe — they exercise imports.
- `ZENA_TEST_PARALLELISM=N` caps execution-test wasmtime fan-out (the
  default can exhaust machine memory).

## Zena-authoring gotchas (recur constantly in this directory)

- `new X(args).method()` does not parse — bind to a local first.
- i32 `/` promotes to f64; use `>> 1` / `& 31` for integer halving and
  masking.
- A trailing `this.#bail(...)` in an i32-returning function fails the
  missing-return check — write `return this.#bailValue(...)`.
- The ~30-arm `Expression` match trips Z2022 exhaustiveness false
  positives when several arms are added at once — the dispatch wildcard
  uses an if-chain for this reason.
- Enums cast with `as i32` when emitting bytes (`Opcode.return_ as i32`).
