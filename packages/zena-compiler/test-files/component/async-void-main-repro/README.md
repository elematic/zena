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

## Probable cause

`synthesizeExportWrapper` in
[wit-module-synth.zena](../../../zena/lib/wit-module-synth.zena) builds
the entry wrapper that declares each async export's typed return, and
its own documentation says it returns "Null when the program needs
neither". Two rules combine to make a void async `main` need neither:

- World-level async exports get a `<name>_export` wrapper, but `main` is
  skipped, because "the world's async `main` is the entry: the component
  lifts the program's async main on its own, with its typed return
  declared by the entry wrapper (lib/component-entry.zena), and a second
  wrapper here would export the name twice".
- That entry wrapper covers "`main`'s own wrapper **when it returns a
  scalar**".

A void `main` is neither, so no wrapper is produced, no module is
generated to hold a declaration, and emission falls back to the raw
`main$asyncEntry`. The scalar case works because the entry wrapper
exists; the two-export case works because the other export forces a
wrapper module into being, which incidentally gives `main` somewhere to
be declared.

## The loose end

`compose-consumer.zena` has exactly the failing shape —
`export async function main(): Future<void>` against `compose.wit`'s
`world consumer { ... export main: async func(); }` — and it passes
`npm run test:component`, which was re-run against this tree to confirm.

The difference is somewhere in that world's imports:

```wit
world consumer {
  import wasi:clocks/monotonic-clock@0.3.0;  // in provider; consumer has stdio
  import wasi:cli/stdout@0.3.0;
  import wasi:cli/stderr@0.3.0;
  import oracle;                             // ask: async func(n: s32) -> future<s32>
  export main: async func();
}
```

Importing `wasi:cli/stdout` alone is not enough — that case fails. The
remaining candidate is `oracle`, an async import returning `future<s32>`,
which makes the compiler emit `future.new`/`future.read` canon builtins
and the helpers around them. If those land in the same synthesized
module the entry wrapper would use, that would explain why `main` gets a
declaration there and not here. Worth confirming before fixing, because
it decides whether the fix belongs in `synthesizeExportWrapper` (always
produce the wrapper when the world declares an async `main`) or in the
emitter (derive a signature for a synthesized entry instead of demanding
an AST node).

## Fixtures

- `fails.wit` / `fails.zena` — the minimal failing case.
- `works.wit` / `works.zena` — the same thing plus one more async
  export, which compiles.

Neither is registered in `component-e2e.ts`, so nothing runs them. Add
the failing pair as a case once it compiles.
