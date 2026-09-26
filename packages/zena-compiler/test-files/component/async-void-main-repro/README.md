# A declared world whose only export is a void `async main`

**Fixed.** The regression test is
[`async-void-main.zena`](../async-void-main.zena), registered in
`component-e2e.ts`. This directory is the diagnosis that got there, kept
because the chain is long and the two fixtures are what separate the arms
of it.

Compiling a program against a world whose sole export is
`main: async func()` — no result — used to fail:

```
The component target cannot export 'main$asyncEntry': it has no
declaration to read a signature from.
```

Found while starting ZenaFX ([zenafx-ui.md](../../../../../docs/design/zenafx-ui.md)),
where every milestone-1 program has that shape. Nothing about ZenaFX is
needed to reproduce it; the fixtures here import nothing at all.

## Reproducing

Both paths are relative to `packages/zena-cli`, which is where the
`zena` script runs, and is what `component-e2e.ts` does too.

```bash
# used to fail; now builds
npm run zena -w @zena-lang/zena-cli -- build \
  ../zena-compiler/test-files/component/async-void-main-repro/fails.zena \
  -o /tmp/fails.wasm --target component \
  --wit ../zena-compiler/test-files/component/async-void-main-repro/fails.wit \
  --world app

# the control — identical, plus a second async export
npm run zena -w @zena-lang/zena-cli -- build \
  ../zena-compiler/test-files/component/async-void-main-repro/works.zena \
  -o /tmp/works.wasm --target component \
  --wit ../zena-compiler/test-files/component/async-void-main-repro/works.wit \
  --world app
```

## What changed the outcome

Each row is otherwise the failing case.

| World's exports                                       | Zena `main` returns | Result     |
| ----------------------------------------------------- | ------------------- | ---------- |
| `main: async func()`                                  | `Future<void>`      | **failed** |
| `main: async func() -> u32`                           | `Future<u32>`       | compiled   |
| `main: async func()` plus `ping: async func() -> u32` | `Future<void>`      | compiled   |
| `main: func()` (not async)                            | `void`              | compiled   |

Adding imports did not help: a world importing `wasi:cli/stdout` and
exporting only a void async `main` failed the same way, and so did one
importing `zenafx:ui/scene`. The output path was irrelevant — `/dev/null`
and a real file both failed.

## Where it threw

`declaredTypeOf` in
[component-shape.zena](../../../zena/lib/codegen/component-shape.zena):

```zena
export let declaredTypeOf = (func: WasmFunction, what: String): FunctionType => {
  let {node} = func;
  if (node == null) {
    throw new Error(
      "The component target cannot " + what + " '" + nameOf(func) +
        "': it has no declaration to read a signature from."
    );
  }
```

`main$asyncEntry` is synthesized by the async split pass, so it has no
AST node and `declaredTypeOf` cannot read a signature off it. The
emitter should not have been asked to export it directly.

## Root cause

The component entry was never built, so nothing claimed the `main`
export and two separate sites then tried to lift `main$asyncEntry` as if
it were an ordinary function.

`prepareComponentEntry` in
[component-adapters.zena](../../../zena/lib/codegen/ir/component-adapters.zena)
opens with:

```zena
let poll = wasm.getStdlibFunc(driverModule, 'componentPoll');
let resume = wasm.getStdlibFunc(driverModule, 'componentResume');
let begin = wasm.getStdlibFunc(driverModule, 'beginTask');
if (poll == null || resume == null || begin == null) {
  return;
}
```

**`poll` was null in the failing case.** Confirmed by instrumenting that
branch and rebuilding: a program with an async `main` reached it and
returned without building the entry.

`zena:wasi` is linked — `getTargetRuntimeModules` in
[prelude.zena](../../../zena/lib/prelude.zena) returns `["zena:wasi"]`
for every component build, whether or not the program names it. But
being linked is not being _in the function map_: as the comment on the
next gate puts it, "the checkable traversal registers functions it only
type-walked". Nothing in a program whose only asynchrony is its own
`main` ever type-walks `componentPoll`, so the lookup returned null.

With the entry unbuilt, `wasm.componentEntryFunc` stayed null, and both
guards that would have skipped `main` failed open:

- `prepareComponentExports` in component-adapters.zena —
  `if (wasm.componentEntryFunc != null && coreName == 'main') continue;`
- the export loop in
  [component-shape.zena](../../../zena/lib/codegen/component-shape.zena) —
  `if (entry != null && coreName == "main") continue;`

Whichever ran first called `declaredTypeOf` on the wrapper and threw.

That also explains every row of the table. A scalar result routes through
`entryWrapperRun`, and the wrapper module it lives in type-walks the
driver. A second async export does the same through
`prepareAsyncExports`. And `compose-consumer.zena` — which has exactly
the failing signature and passes `npm run test:component` — awaits
`oracle`'s `ask: async func(n: s32) -> future<s32>`, an async import,
which is precisely what type-walks the driver.

## The fix

Rooting the driver is a reachability decision, so the condition went
where the component target roots its runtime modules:
`#rootComponentAsyncDriver` in
[analysis.zena](../../../zena/lib/codegen/reachability/analysis.zena)
now counts an `async main` as a third door, alongside the awaited async
import and the entry wrapper module.

Two approaches were tried and discarded:

- Detecting the async main wrapper inside `prepareComponentEntry` and
  calling `pass.markFunctionReached(poll)`. It cannot work: the early
  return above it fires first on `poll == null`, and by then the
  driver's functions are already absent from the map.
- Teaching the two export loops to derive a component signature for
  `main$asyncEntry` without an AST node. This avoids linking the driver
  into a program that cannot suspend, at the cost of a second way to
  compute an export's signature. The wrapper's shape is known — no
  parameters, and a result that is the `Future`'s payload — so it is
  workable, just worse.

## Fixtures

- `fails.wit` / `fails.zena` — the minimal case, promoted to
  `../async-void-main.{wit,zena}` and run by `component-e2e.ts`.
- `works.wit` / `works.zena` — the same thing plus one more async
  export, which compiled throughout. Nothing runs these two; they are
  here to be diffed against each other.
