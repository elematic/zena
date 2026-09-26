# A declared world whose only export is a void `async main`

Compiling a program against a world whose sole export is
`main: async func()` — no result — fails:

```
The component target cannot export 'main$asyncEntry': it has no
declaration to read a signature from.
```

Found while starting ZenaFX ([zenafx-ui.md](../../../../../docs/design/zenafx-ui.md)),
where every milestone-1 program has that shape. Nothing about ZenaFX is
needed to reproduce it; the fixtures here import nothing at all.

## Reproducing

Both commands run from the repository root. `--wit` is repo-relative
while the source path is relative to `packages/zena-cli`, which is what
`component-e2e.ts` does too.

```bash
# fails
npm run zena -w @zena-lang/zena-cli -- build \
  ../../packages/zena-compiler/test-files/component/async-void-main-repro/fails.zena \
  -o /tmp/fails.wasm --target component \
  --wit packages/zena-compiler/test-files/component/async-void-main-repro/fails.wit \
  --world app

# succeeds — identical, plus a second async export
npm run zena -w @zena-lang/zena-cli -- build \
  ../../packages/zena-compiler/test-files/component/async-void-main-repro/works.zena \
  -o /tmp/works.wasm --target component \
  --wit packages/zena-compiler/test-files/component/async-void-main-repro/works.wit \
  --world app
```

Verified on `zena-3` at 138cd478, against a compiler built from that
tree.

## What changes the outcome

Each row is otherwise the failing case.

| World's exports | Zena `main` returns | Result |
| --- | --- | --- |
| `main: async func()` | `Future<void>` | **fails** |
| `main: async func() -> u32` | `Future<u32>` | compiles |
| `main: async func()` plus `ping: async func() -> u32` | `Future<void>` | compiles |
| `main: func()` (not async) | `void` | compiles |

Adding imports does not help: a world importing `wasi:cli/stdout` and
exporting only a void async `main` fails the same way, and so does one
importing `zenafx:ui/scene`. The output path is irrelevant — `/dev/null`
and a real file both fail.

## Where it throws

`declaredTypeOf` in
[component-shape.zena](../../../zena/lib/codegen/component-shape.zena),
around line 98:

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

The component entry is never built, so nothing claims the `main` export
and two separate sites then try to lift `main$asyncEntry` as if it were
an ordinary function.

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

**`poll` is null in the failing case.** Confirmed by instrumenting that
branch and rebuilding: a program with an async `main` reaches it and
returns without building the entry.

`zena:wasi` is linked — `getTargetRuntimeModules` in
[prelude.zena](../../../zena/lib/prelude.zena) returns `["zena:wasi"]`
for every component build, whether or not the program names it. But
being linked is not being *in the function map*: as the comment on the
next gate puts it, "the checkable traversal registers functions it only
type-walked". Nothing in a program whose only asynchrony is its own
`main` ever type-walks `componentPoll`, so the lookup returns null.

With the entry unbuilt, `wasm.componentEntryFunc` stays null, and both
guards that would have skipped `main` fail open:

- `prepareComponentExports` in component-adapters.zena —
  `if (wasm.componentEntryFunc != null && coreName == 'main') continue;`
- the export loop in
  [component-shape.zena](../../../zena/lib/codegen/component-shape.zena) —
  `if (entry != null && coreName == "main") continue;`

Whichever runs first calls `declaredTypeOf` on the wrapper and throws.

That also explains every row of the table. A scalar result routes through
`entryWrapperRun`, and the wrapper module it lives in type-walks the
driver. A second async export does the same through
`prepareAsyncExports`. And `compose-consumer.zena` — which has exactly
the failing signature and passes `npm run test:component` — awaits
`oracle`'s `ask: async func(n: s32) -> future<s32>`, an async import,
which is precisely what type-walks the driver.

## Where the fix belongs

Not in `prepareComponentEntry`: by the time it runs, the driver's
functions are already absent from the map, and there is nothing to
mark reached. Rooting them is a reachability decision, so the condition
belongs wherever the component target roots its runtime modules — the
driver should be rooted when the program has an async `main`, the same
way it is rooted today by an async import.

An attempt to fix it inside `prepareComponentEntry` is recorded here as
a dead end: detecting the async main wrapper there and calling
`pass.markFunctionReached(poll)` does not help, because the early return
above it fires first on `poll == null`.

The alternative — teaching the two export loops to derive a component
signature for `main$asyncEntry` without an AST node — avoids linking the
driver into a program that cannot suspend, at the cost of a second way
to compute an export's signature. The wrapper's shape is known: no
parameters, and a result that is the `Future`'s payload, so for
`Future<void>` the component export is `func()`.

## Fixtures

- `fails.wit` / `fails.zena` — the minimal failing case.
- `works.wit` / `works.zena` — the same thing plus one more async
  export, which compiles.

Neither is registered in `component-e2e.ts`, so nothing runs them. Add
the failing pair as a case once it compiles.
