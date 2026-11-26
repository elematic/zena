# Isolated Functions

## Status

Proposal. This document builds on purity inference
([pure-functions.md](./pure-functions.md)), macro module restrictions
([macros.md](./macros.md)), sendable worker closures
([concurrency.md](./concurrency.md)), and ZenaFX window components
([zenafx-styles.md](./zenafx-styles.md)). Purity inference in
`packages/compiler/src/lib/analysis/purity.zena` is implemented; multi-artifact
extraction, capture checking, and virtual-context lifting are not.

## Overview

A ZenaFX widget often needs a style rule whose condition depends on live window
state and a local parameter from the widget:

```zena
let Card = (minWidth: f32) => @ui Box {
  style: Style {
    When((node) => node.hovered && !node.disabled && node.use(panelWidth) >= minWidth) {
      background: (node) => lighten(node.use(accent), 0.2)
    }
  }
};
```

In ZenaFX, the application component runs on its own thread and may be blocked
on I/O or application logic while the window thread handles pointer hover,
resizing, layout, and painting. The window thread never waits for the
application thread and cannot call into the application's WebAssembly instance.
To run the condition in `When` and the `lighten` call during a frame, the
compiler has to extract those two functions into a separate WebAssembly
component that the host instantiates on the window thread.

Three other features in Zena have the same shape:

- **Worker tasks** ([concurrency.md](./concurrency.md)): a closure spawned on a
  background thread or separate WebAssembly worker instance, receiving
  serialized copies of closed-over data.
- **Compile-time macros** ([macros.md](./macros.md)): a function that runs in
  the compiler's WebAssembly instance during compilation, reading AST values
  with no access to the filesystem or network.
- **GPU shaders**: a numeric function compiled to WGSL or SPIR-V to run on a
  GPU with uniform and buffer inputs.

Each case writes a function in an ordinary Zena module and executes it in a
different isolation context. An **isolated function** is a function the
compiler verifies against a target context's rules and extracts, together with
its transitive callees, into an artifact built for that context.

## Three requirements

Purity checking in [pure-functions.md](./pure-functions.md) verifies what a
function reads and writes within a single WebAssembly instance. Moving a
function to another instance or execution environment adds two further checks:
a capture boundary and a target profile.

### Purity grade

An isolated function must satisfy the purity grade required by its target
context, using the grades from [pure-functions.md](./pure-functions.md):

- **`pure`**: reads only immutable paths of its inputs and writes only to fresh
  allocations. Results depend solely on inputs, so the host can cache results,
  reorder calls, or run multiple instances in parallel. ZenaFX window-thread
  functions and GPU shaders require `pure`.
- **`effect-free`**: reads and writes nothing outside its parameters and fresh
  allocations, while allowing mutation of arguments handed to it. Macros
  require `effect-free` (see [macros.md](./macros.md#25-toward-capabilities-and-isolated-libraries)).
  Worker tasks require `effect-free` unless the worker target passes explicit
  capability handles (such as a channel) as parameters.

The existing call-graph purity analysis infers these grades across unmarked
helper functions, so an isolated function can call standard library math,
color, and collection helpers without requiring annotations on every callee.

### Capture boundary

A function extracted into another instance cannot hold live heap references to
objects, mutable locals, or host handles in the enclosing instance. Every free
variable referenced inside an isolated function falls into one of three
categories:

1. **Compile-time constants**: immutable module `let` bindings of primitives,
   `String`, records, tuples, or pure constant expressions. The compiler emits
   these directly in the extracted artifact with zero runtime transfer cost.
2. **Serializable value captures**: runtime values from an enclosing scope that
   belong to the target's transferable value types (for example, `minWidth: f32`
   in the `Card` example above, or a `Frozen<Config>` record passed to a
   worker). At the point where the isolated function value is constructed, the
   enclosing component evaluates the captured values and attaches them to the
   function handle.
3. **Disallowed captures**: `var` locals, references to classes with mutable
   fields, closures over mutable state, or ambient capability handles. Reading
   or writing one inside an isolated function is a compile-time error naming
   the captured binding and why it cannot cross the boundary.

```zena
var count = 0;
let threshold = 600.0;

// OK: `threshold` is an immutable f32 capture.
let ok = When((node) => node.use(panelWidth) >= threshold) {
  axis: Axis.Row
};

// Error: `count` is a mutable local and cannot be captured by a window function.
let bad = When((node) => node.index > count) {
  axis: Axis.Row
};
```

### Target profile

Each execution context defines a profile that constrains the extracted body and
every function it calls:

- **Allowed value types**: the types that may appear in parameters, captures,
  and return values across the host boundary.
- **Allowed imports and features**: which host imports, standard library
  modules, and language constructs (such as GC allocation or recursion) the
  target supports.
- **Runtime limits**: fuel, timeout, or memory bounds enforced by the host.
- **Output artifact**: the compiled format the compiler emits for that target.

## Target contexts

| Context                 | Purity grade                                  | Captures                                                                         | Allowed types and imports                                                                                    | Output artifact                                                             |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| ZenaFX window component | `pure`                                        | Immutable ZenaFX values (`flag`, `number`, `length`, `color`, `keyword`, `text`) | Pure Zena + ZenaFX value types (plus layout measurement imports for custom layouts); no scene, I/O, or clock | Companion WebAssembly component instantiated on the window thread           |
| Worker task             | `effect-free` (or explicit capability params) | `Sendable` / `Frozen<T>` / transferred `Own<T>` values                           | Pure stdlib + worker-allowed host capabilities (channels, timers, etc.)                                      | Companion WebAssembly module/component or shared worker entry table         |
| Compile-time macro      | `effect-free`                                 | Compile-time constants only                                                      | Pure stdlib + `zena:macro` AST utilities; no `zena:fs` or `zena:net`                                         | WebAssembly module loaded by the compiler (or direct call once self-hosted) |
| GPU shader              | `pure`                                        | Uniform primitives, vectors, matrices, buffer bindings                           | Fixed-width numerics, vectors, matrices; no GC allocations, no recursion, no strings                         | WGSL / SPIR-V shader module                                                 |

### ZenaFX window-thread functions

ZenaFX uses a window component for three frame-time tasks: condition
predicates, style value computations, and custom layout algorithms
([zenafx-styles.md](./zenafx-styles.md#window-components)). All three run on
the window thread with direct synchronous calls and a per-call fuel limit.

Condition predicates and style value computations take flat ZenaFX values and
return a ZenaFX value (`flag` for a condition, or the property's value type for
a declaration). Predicates written in Zena can express checks that a fixed WIT
expression grammar cannot, including modulo (`node.index % 2 == 0`), aspect
ratio (`node.width / node.height > 1.5`), and comparing two live facts
(`node.scrollY >= node.scrollRangeY - 500.0`).

### Worker tasks

In [concurrency.md](./concurrency.md#sendable-closures), parallel workers run
closures in separate threads or WebAssembly worker instances. Under the worker
polyfill, the main instance cannot share its GC heap with a worker, so
`parallel.map(items, (item) => transform(item, config))` extracts the lambda
and `transform` into a worker entry point, serializes `config` and `items`, and
dispatches `(fn_id, captures, args)` to the worker. When WebAssembly
shared-everything threads arrive, the same capture and purity rules hold while
the compiler can switch from serialized transfer to direct sharing of
`Frozen<T>` values.

### Compile-time macros

In [macros.md](./macros.md#24-macro-module-restrictions), a macro is an
effect-free function over AST nodes restricted to pure standard library imports
and `zena:macro`. During bootstrap, the compiler extracts macro functions into
a separate WebAssembly module and passes serialized ASTs across the boundary.
Once the compiler is self-hosted, the import and purity checks remain identical
while the extraction step collapses into a direct call inside the compiler's
own WebAssembly instance.

### GPU shaders

Shaders sit at the strictest end of the same pipeline. A shader function must
be `pure`, must allocate no GC heap objects, and must contain no unbounded
recursion. Captured immutable parameters from host code become uniform buffer
fields, and vertex or fragment attributes are lifted from a virtual input
parameter into shader stage bindings.

## Virtual context parameters and input lifting

Passing every host input as an explicit parameter works on the wire, but is
verbose in source code:

```zena
// Verbose: every key is listed once as metadata and once as a parameter.
When([hovered, disabled, panelWidth], (h, d, w) => h && !d && w >= minWidth) {
  background: Call([accent], (c) => lighten(c, 0.2))
}
```

The author repeats every dependency twice and keeps the parameter positions in
sync with the key list by hand.

To avoid that repetition while preserving the host's dependency tracking,
host-driven targets expose a **virtual context parameter** — a compile-time
view type such as `StyleNode` in ZenaFX (or `FragmentInput` in a shader):

```zena
When((node) => node.hovered && !node.disabled && node.use(panelWidth) >= minWidth) {
  background: (node) => lighten(node.use(accent), 0.2)
}
```

`StyleNode` exposes built-in host facts as properties (`node.hovered`,
`node.focused`, `node.pressed`, `node.index`, `node.width`, `node.height`,
`node.scrollY`) and keyed lookups as methods (`node.fact(key)`,
`node.use(prop)`). `StyleNode` exists only during type checking and extraction;
it has no runtime representation in the window component and never crosses the
WebAssembly boundary.

### Input lifting

When extracting an isolated function that takes a virtual context parameter,
the compiler performs **input lifting** (scalar replacement across the module
boundary):

1. Walk the isolated function and any pure helper functions to which it passes
   `node`, collecting every property read and keyed lookup on `node`.
2. Deduplicate the accessed host keys into an ordered list of input
   descriptors: `[fact(hovered), fact(disabled), use(panelWidth)]`.
3. Collect serializable captures from the enclosing scope: `[minWidth]`.
4. Emit a flat export in the window component whose parameters are the lifted
   scalar values and captures:

```zena
// Generated export in the window component:
export function __cond_1(
  p0: boolean,
  p1: boolean,
  p2: f32,
  c0: f32,
): boolean {
  return p0 && !p1 && p2 >= c0;
}
```

5. Replace the lambda in the application component with a call descriptor
   holding the export ID and the flat argument list (using the `call` record
   from [zenafx-styles.md](./zenafx-styles.md#calling-a-function-from-a-declaration)):

```zena
// Lowered expression in the application component:
CondCall(1, [
  Value.fact(hovered),
  Value.fact(disabled),
  Value.use(panelWidth),
  Value.number(minWidth),
])
```

The same lifting applies to `background: (node) => lighten(node.use(accent), 0.2)`:
the compiler extracts `(c: Color) => lighten(c, 0.2)` along with `lighten`'s
pure body into the window component, and emits
`Value.call(2, [Value.use(accent)])`. Color and layout libraries export one
ordinary pure function (`lighten(color: Color, amount: f32): Color`) instead of
maintaining a second AST-building overload for `Value` expressions.

### Host invariants preserved by lifting

Because `StyleNode` is erased before emission and replaced by flat arguments,
the host keeps three invariants:

- **Input-keyed invalidation**: the host receives the exact list of keys
  (`[hovered, disabled, panelWidth]`), indexes the condition under those keys,
  and re-evaluates it only when one of those inputs changes.
- **Result memoization**: the host caches `(fn_id, argument_values) -> result`.
  If a thousand list rows share a condition reading an inherited `panelWidth`,
  a resize invokes `__cond_1` once per distinct `(hovered, disabled,
panelWidth, minWidth)` tuple rather than once per row.
- **No tree walking**: the window component receives primitive values and never
  a scene node handle, so a predicate or style function cannot inspect sibling
  nodes or reach into another widget's interior.

### Restrictions on virtual context parameters

Static input extraction requires that the set of keys read from `node` be
enumerable when the rule is built in the application component:

- `node` cannot escape: it cannot be returned, stored in an object or array, or
  passed to an opaque function value.
- Key expressions in `node.fact(k)` and `node.use(k)` may be dynamic values
  from the enclosing application scope (such as a `PropertyKey` parameter
  passed into a reusable widget), because the application component evaluates
  `k` when building the `Value.use(k)` descriptor.
- Key expressions cannot depend on runtime values read from `node`. For
  example, `node.use(keys[node.index])` is rejected at compile time because
  the host cannot know which keys to subscribe to without running the function.
  A conditional branch over two enclosing keys
  (`node.hovered ? node.use(a) : node.use(b)`) is valid: both `a` and `b` are
  lifted as inputs, and the extracted function selects between them.

### Compiler lifting vs. a syntactic macro

A syntactic macro inspecting `When((node) => ...)` can implement input lifting
for a single inline lambda by walking the lambda's AST for member accesses on
`node`. That approach breaks down as soon as a developer factors a shared check
into a helper function:

```zena
let isInteractive = (n: StyleNode) => n.hovered && !n.disabled;
let isWide = (n: StyleNode) => n.use(panelWidth) >= 600.0;

When((n) => isInteractive(n) && isWide(n)) {
  color: accent
}
```

A syntactic macro sees only the call expression `isInteractive(n) && isWide(n)`
and has no access to the bodies of `isInteractive` or `isWide`, especially when
they are imported from another module.

Performing input lifting in the compiler's isolated-function pass after type
checking handles helper functions naturally. That pass already walks the
transitive call graph of the isolated function to verify purity and collect
callees for extraction, so it inspects `isInteractive` and `isWide`, gathers
their `StyleNode` reads (`[hovered, disabled, panelWidth]`), and specializes or
inlines them into the flat export.

The same compiler pass applies to shader virtual contexts (`FragmentInput`,
`VertexInput`), where helper functions frequently read fields from the stage
input struct.

## Compilation model

### Call-graph extraction

For each isolated function discovered during type checking, the compiler:

1. Verifies the target profile's purity grade on the function and its
   transitive callees using `analysis/purity.zena`.
2. Checks every free variable against the target's capture rules.
3. Lifts any virtual context parameter accesses into flat parameters and builds
   the input descriptor list.
4. Validates that all parameter types, capture types, return types, and
   reachable imports satisfy the target profile.
5. Marks the lifted entry function and its reachable callees for emission into
   the target artifact.

### Multi-artifact emission and deduplication

When a compilation contains isolated functions for a target profile, the
compiler emits the companion artifact alongside the main output (for example, a
ZenaFX window component alongside the application component).

Two sites that lift to structurally identical flat bodies — such as two
widgets both writing `When((n) => n.hovered && !n.disabled)` — share one export
in the companion artifact. Parameterized predicates such as
`(n) => n.use(panelWidth) >= minWidth` share one export parameterized by the
captured `minWidth` argument, so creating cards with different thresholds adds
no extra Wasm functions.

### Static bound hints for continuous inputs

In [zenafx-styles.md](./zenafx-styles.md#evaluation), numeric conditions on
width or scroll position use an interval table so that dragging a window from
801 to 802 pixels performs two float comparisons in the host and skips
evaluating any condition whose threshold was not crossed.

A compiled window-component predicate runs directly on the window thread, with
no IPC or thread hop, but calling it on every pixel of a resize still crosses
the host-to-Wasm boundary. When a lifted predicate compares a single numeric
input against a constant or captured threshold (such as `p0 >= c0` or a boolean
combination of such comparisons), the compiler can attach static interval bounds
to the `CondCall` descriptor, or lower the predicate directly to the host's
built-in `range` test when it fits. More complex predicates
(`node.width / node.height > 1.5`, `node.scrollY >= node.scrollRangeY - 500.0`)
run the window-component export whenever their declared numeric inputs change.

## Surface syntax

Most isolated functions appear as arguments to APIs whose parameter types
require a specific target context:

- `When((node) => ...)` expects an isolated window predicate.
- Style property values such as `background: (node) => ...` expect an isolated
  window value function.
- `parallel.map(items, (item) => ...)` expects an isolated worker function.

At these call sites, the author writes an ordinary arrow function. Contextual
typing selects the target profile, validates purity and captures, and emits the
extracted handle.

For standalone declarations — reusable helper functions, exported window
functions, or worker tasks assigned to a variable before being passed to
`spawn` — an explicit annotation checks the rules at the definition site rather
than waiting for a call site. The exact surface spelling is left open below.

## Alternatives considered

- **Growing the WIT condition and expression grammar.** Adding `remainder`,
  arithmetic between two facts, `calc()`, and `color-mix()` to the host wire
  protocol requires extending the WIT schema, the host evaluator, and every
  guest binding each time a new operation is needed. Compiled window-component
  functions let authors write standard Zena expressions using the same runtime
  mechanism already planned for custom style functions and layouts.
- **A `@cond` macro that serializes Zena ASTs to WIT conditions.** Translating
  `hovered && !disabled && panelWidth >= 600.0` in a macro removes builder
  boilerplate for the operations the WIT grammar supports. It still hits the
  ceiling of that fixed grammar, cannot inspect helper functions across
  modules, and requires separate mechanisms for style value functions, workers,
  and shaders.
- **Opaque callbacks receiving a live node handle.** Passing a runtime scene
  node into a predicate avoids input lifting, but prevents the host from
  indexing dependencies, prevents memoization across nodes with equal inputs,
  and allows predicates to walk outside their widget's scope. Virtual context
  lifting keeps the single-`node` authoring syntax while erasing the handle at
  compile time.
- **Shared-everything WebAssembly threads calling the application instance.**
  Shared-everything threads would avoid instantiating a separate window
  component once supported by WebAssembly runtimes. Even then, a frame-time
  function still cannot block on application locks or mutate application state,
  so the purity, capture, and input-lifting rules remain identical. The
  extraction backend can target a shared instance later without changing source
  code.

## Open questions

- **Explicit annotation syntax.** Whether standalone isolated functions use a
  single modifier parameterized by profile (`isolated<Window>`,
  `isolated<Worker>`) or context-specific keywords (`macro`, `sendable`,
  `shader`) that share the same compiler pass.
- **Companion artifact packaging.** How a ZenaFX application bundles its
  generated window component: as a sidecar `.wasm` asset, embedded as a custom
  section in the main component, or composed into a single Component Model
  package.
- **Capture serialization.** Host-facing targets (`window`, `shader`) pass
  captures through the target's fixed ABI (WIT values or uniform buffers),
  while Zena-to-Zena worker tasks can use a generated binary serializer
  ([concurrency.md](./concurrency.md#generated-binary-serialization)). Whether
  both share a single `Serializable` trait check in the type checker is open.
- **Static bound extraction vs. direct call cost.** Measuring the cost of a
  same-thread host-to-Wasm call during window resize will show whether static
  interval-bound extraction is worth building for simple comparisons or whether
  direct calls with memoization are already fast enough.
- **Higher-order pure functions.** Accepting a pure function value as a
  parameter inside an isolated function depends on `pure` function types
  ([pure-functions.md](./pure-functions.md#open-questions)).
- **Non-Zena guests.** A ZenaFX host still accepts window components compiled
  from Rust or any other language using the same flat-argument `call` ABI;
  virtual-context lifting and automatic extraction are conveniences provided by
  the Zena compiler.
