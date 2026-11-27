# Isolated Functions

## Status

Proposal. This document builds on purity inference
([pure-functions.md](./pure-functions.md)), macro module restrictions
([macros.md](./macros.md)), sendable worker closures
([concurrency.md](./concurrency.md)), and ZenaFX window components
([zenafx-styles.md](./zenafx-styles.md)). Purity inference in
`packages/compiler/src/lib/analysis/purity.zena` is implemented; isolated
function types, capture checking, and multi-artifact extraction are not.

## Overview

A ZenaFX widget often needs a style rule whose condition depends on live window
state and a local parameter from the widget:

```zena
let Card = (minWidth: f32) => @ui Box {
  style: Style {
    When((node) => node.hovered && !node.fact(disabled) && node.use(panelWidth) >= minWidth) {
      background: (node) => lighten(node.use(accent), 0.2)
    }
  }
};
```

In ZenaFX, an app or widget component runs on its own thread and may be blocked
on I/O or application logic while the window thread handles pointer hover,
resizing, layout, and painting. The window thread never waits for a widget
component and cannot call into that component's WebAssembly instance. To run
the condition in `When` and the `lighten` call during a frame, the compiler
extracts those two functions into a separate WebAssembly component that the
platform component instantiates and calls on the window thread.

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
  allocations. Results depend solely on inputs, so the caller can cache
  results, reorder calls, or run multiple instances in parallel. ZenaFX
  window-thread functions and GPU shaders require `pure`.
- **`effect-free`**: reads and writes nothing outside its parameters and fresh
  allocations, while allowing mutation of arguments handed to it. Macros
  require `effect-free` (see
  [macros.md](./macros.md#25-toward-capabilities-and-isolated-libraries)).
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
   or a `PropertyKey` handle in the `Card` example above, or a `Frozen<Config>`
   record passed to a worker). At the point where the isolated function value
   is constructed, the enclosing component evaluates the captured values and
   attaches them to the function handle.
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
  and return values across the context boundary.
- **Allowed imports and features**: which WIT imports, standard library
  modules, and language constructs (such as GC allocation or recursion) the
  target supports.
- **Runtime limits**: fuel, timeout, or memory bounds enforced by the caller.
- **Output artifact**: the compiled format the compiler emits for that target.

## Type representation

An extracted function is not an ordinary local WebAssembly funcref in the
enclosing component. Its body lives in the target artifact (the companion
window component, worker module, or shader), and at runtime in the enclosing
component the value is a compiled handle carrying its export index and
evaluated captures (for example `{ fnId: u32, captures: FixedArray<Value> }`).

The type system represents this with a compiler-known parameterized type,
`Isolated<Target, Fn>`. Libraries define domain aliases over it so APIs such as
`Rule`, `When`, and style properties statically reject ordinary closures:

```zena
// ZenaFX library aliases
export type ConditionFn = Isolated<Window, (node: StyleNode) => boolean>;
export type StyleValueFn<T> = Isolated<Window, (node: StyleNode) => T>;

export class Rule {
  static new [Builder.construct](
    target: Tag | Condition | ConditionFn,
    body: RuleBody,
  ): Rule { ... }
}

export class When {
  static new [Builder.construct](
    cond: FlagKey | Condition | ConditionFn,
    body: StyleBody,
  ): When { ... }
}
```

The same type constructor applies to other targets:

```zena
// Worker tasks
export function map<T: Sendable, R: Sendable>(
  items: FixedArray<T>,
  fn: Isolated<Worker, (item: T) => R>,
): FixedArray<R>

// GPU shaders
export function createFragmentShader(
  fn: Isolated<FragmentShader, (input: FragmentInput) => Vec4>,
): FragmentShaderModule
```

### Assignability and construction rules

1. **Ordinary closures are rejected.** A plain function value
   `f: (StyleNode) => boolean` is not assignable to
   `Isolated<Window, (node: StyleNode) => boolean>`. Passing an unverified
   closure to `Rule(f)` or `When(f)` is a compile-time type error.
2. **Contextual typing on function literals.** An arrow function written
   directly at a site expecting `Isolated<Target, Fn>` — such as
   `When((node) => node.hovered)` or
   `let wide: ConditionFn = (node) => node.use(panelWidth) >= 600.0` — is
   checked against `Target`'s purity, capture, and profile rules and lowered to
   the target handle.
3. **Explicit isolation markers.** When a function is created without a
   contextual type (for example inside a factory or bound to an unannotated
   local), an explicit marker such as `@cond` or `isolated<Window>` produces a
   value of type `ConditionFn` (or `Isolated<Target, Fn>`) directly:

   ```zena
   let wide = @cond (node) => node.use(panelWidth) >= 600.0;
   Rule(wide) { axis: Axis.Row }
   ```

4. **Pure helper functions stay ordinary functions.** A reusable helper such as
   `let isWide = (node: StyleNode) => node.use(panelWidth) >= 600.0;` has the
   ordinary type `(StyleNode) => boolean`. It can be called inside any
   `ConditionFn` lambda (`When((n) => n.hovered && isWide(n))`), where the
   compiler includes `isWide` in the extracted call graph. Because `StyleNode`
   has no public constructor, application code cannot construct a `StyleNode`
   to call `isWide` outside a window function.
5. **Combining handles.** Two already-extracted `ConditionFn` handles can still
   be combined at runtime with the `Condition` combinators (`all([wide,
active])`, `not(wide)`) without recompiling them.

## Target contexts

| Context                 | Purity grade                                  | Captures                                                                                  | Allowed types and imports                                                                                                 | Output artifact                                                             |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ZenaFX window component | `pure`                                        | Immutable ZenaFX values (`flag`, `number`, `length`, `color`, `keyword`, `text`, key IDs) | Pure Zena + `zenafx:window/eval` (`style-node` resource) and layout measurement imports; no scene mutation, I/O, or clock | Companion WebAssembly component instantiated on the window thread           |
| Worker task             | `effect-free` (or explicit capability params) | `Sendable` / `Frozen<T>` / transferred `Own<T>` values                                    | Pure stdlib + worker-allowed host capabilities (channels, timers, etc.)                                                   | Companion WebAssembly module/component or shared worker entry table         |
| Compile-time macro      | `effect-free`                                 | Compile-time constants only                                                               | Pure stdlib + `zena:macro` AST utilities; no `zena:fs` or `zena:net`                                                      | WebAssembly module loaded by the compiler (or direct call once self-hosted) |
| GPU shader              | `pure`                                        | Uniform primitives, vectors, matrices, buffer bindings                                    | Fixed-width numerics, vectors, matrices; no GC allocations, no recursion, no strings                                      | WGSL / SPIR-V shader module                                                 |

### ZenaFX window-thread functions

ZenaFX uses a window component for three frame-time tasks: condition
predicates, style value computations, and custom layout algorithms
([zenafx-styles.md](./zenafx-styles.md#window-components)). All three run on
the window thread with direct synchronous calls from the platform component and
a per-call fuel limit.

Condition predicates and style value computations read node facts and inherited
properties through a borrowed `style-node` WIT resource and return a ZenaFX
value (`bool` for a condition, or the property's value type for a declaration).
Predicates written in Zena express checks that a fixed WIT condition grammar
cannot, including modulo (`node.index % 2 == 0`), aspect ratio
(`node.width / node.height > 1.5`), and comparing two live facts
(`node.scrollY >= node.scrollRangeY - 500.0`). Color and layout libraries
export one ordinary pure function (`lighten(color: Color, amount: f32): Color`)
instead of maintaining a second `Value`-building overload.

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
fields, and vertex or fragment attributes map to shader stage input bindings.

## Context resources and runtime dependency tracking

A ZenaFX window component uses a single static WIT world rather than custom
per-function flat signatures:

```wit
interface window-eval {
  resource style-node {
    hovered: func() -> bool;
    focused: func() -> bool;
    pressed: func() -> bool;
    index: func() -> u32;
    width: func() -> f32;
    height: func() -> f32;
    scroll-x: func() -> f32;
    scroll-y: func() -> f32;
    scroll-range-x: func() -> f32;
    scroll-range-y: func() -> f32;
    fact: func(key: u32) -> option<value>;
    %use: func(key: u32) -> option<value>;
  }
}

world window-component {
  import window-eval;

  export eval-predicate: func(
    id: u32,
    node: borrow<style-node>,
    captures: list<value>,
  ) -> bool;

  export eval-value: func(
    id: u32,
    node: borrow<style-node>,
    captures: list<value>,
  ) -> value;
}
```

Passing `borrow<style-node>` as a WIT resource has four consequences:

- **Language-agnostic contract.** Widgets written in Rust, C++, Go, or any
  other WebAssembly language can implement `window-component` directly with no
  custom compiler analysis, parameter lifting, or macro rewriting.
- **Zero-copy handle and strict encapsulation.** `borrow<style-node>` crosses
  WIT as a single `i32` handle in both today's linear-memory ABI and future GC
  Component Model ABIs. The resource exposes only the current node's facts and
  inherited properties — with no `parent()` or `children()` methods — so a
  predicate or style function cannot walk the tree or inspect another widget's
  interior.
- **No compiler body rewriting.** Helper functions such as
  `isWide(node: StyleNode)` compile as ordinary functions inside the window
  component without inlining or signature specialization.
- **Exact runtime dependency recording.** While `eval-predicate` or
  `eval-value` executes, each getter called on `borrow<style-node>` returns the
  value and records that key in the platform component's read-set for that
  evaluation.

### Dependency subscriptions and bounded memoization

Because window-component functions are `pure` and deterministic, every call
that receives the same result from its first getter read will request the exact
same second getter. The platform component uses that property in two ways:

1. **Per-node invalidation subscriptions.** After evaluating `(node, fn_id,
captures)`, the platform component stores the recorded read-set on the node
   (a `u16` bitmask for built-in host states plus a small list of custom
   fact/property keys). On subsequent mutations, only predicates whose recorded
   read-set includes the changed key re-evaluate. When a predicate re-runs and
   takes a different branch, its recorded read-set replaces the previous one —
   so `node.hovered && node.use(panelWidth) >= 600.0` does not subscribe to
   `panelWidth` while `hovered` is `false`, subscribes when hovered, and
   unsubscribes on mouse-out.
2. **Bounded read-check trie memoization.** Per `(fn_id, captures)`, the
   platform component caches observed read traces (for example: check `hovered`
   → if `false`, return `false` without entering WebAssembly; if `true`, check
   `use(panelWidth)` → if `720.0`, return `true`). Across a thousand list rows
   sharing an inherited `panelWidth`, row 0 misses the cache and populates the
   entry, and rows 1–999 hit the cache directly in the platform component.
   Continuous floats such as `width` and `scrollY` use a small per-frame or LRU
   cap at their trie node so dragging a scrollbar or resizing a window never
   accumulates unbounded float entries.

GPU shaders are the one target that still requires static binding maps rather
than runtime recording, because graphics hardware pipelines fix vertex and
uniform layouts ahead of draw time.

## Compilation model

### Call-graph extraction

For each isolated function discovered during type checking, the compiler:

1. Verifies the target profile's purity grade on the function and its
   transitive callees using `analysis/purity.zena`.
2. Checks every free variable against the target's capture rules and collects
   serializable runtime captures (including key IDs for `node.fact(key)` and
   `node.use(prop)` when those keys are runtime handles).
3. Validates that all parameter types, capture types, return types, and
   reachable imports satisfy the target profile.
4. Marks the entry function and its reachable callees for emission into the
   target artifact, wiring it into the target's dispatch export (such as
   `eval-predicate` / `eval-value` in `window-component`).

### Multi-artifact emission and deduplication

When a compilation contains isolated functions for a target profile, the
compiler emits the companion artifact alongside the main output (for example, a
ZenaFX window component alongside the widget component).

Two sites with structurally identical bodies — such as two widgets both writing
`When((n) => n.hovered && !n.fact(disabled))` — share one entry ID in the
companion artifact. Parameterized predicates such as
`(n) => n.use(panelWidth) >= minWidth` share one entry ID parameterized by the
`captures` list, so creating cards with different thresholds adds no extra
WebAssembly functions.

## Alternatives considered

- **Flat-parameter lifting and compiler read masks.** Scanning each Zena lambda
  and its pure helpers to lift every `node` field read into a flat scalar
  parameter list (or emitting a static `u16` built-in read mask alongside a
  `builtin-facts` record) avoids per-field WIT getter calls on cache misses.
  Flat parameter lifting requires dynamic WIT signature reflection or
  untyped `list<value>` unpacking plus body rewriting and helper specialization
  in the compiler; even a read-only `builtin_mask` depends on custom compiler
  analysis that non-Zena guest languages do not have. Passing
  `borrow<style-node>` as a WIT resource keeps one static WIT interface that
  every language can implement directly, while memoization ensures cache hits
  never enter WebAssembly at all.
- **Growing the WIT condition and expression grammar.** Adding `remainder`,
  arithmetic between two facts, `calc()`, and `color-mix()` to the wire
  protocol requires extending the WIT schema, the platform component evaluator,
  and every guest binding each time a new operation is needed. Compiled
  window-component functions let authors write standard expressions using the
  same runtime mechanism already planned for custom style functions and
  layouts.
- **A `@cond` macro that serializes Zena ASTs to WIT conditions.** Translating
  `hovered && !disabled && panelWidth >= 600.0` in a macro removes builder
  boilerplate for the operations the WIT grammar supports. It still hits the
  ceiling of that fixed grammar, cannot inspect helper functions across
  modules, and requires separate mechanisms for style value functions, workers,
  and shaders.
- **Opaque callbacks receiving a live scene node handle.** Passing a full scene
  node handle with parent/child navigation into an app component lets
  predicates walk outside their widget's scope, prevents dependency tracking,
  and blocks frames when the app thread is busy. A `borrow<style-node>`
  resource running in a window component exposes only the current node's facts
  and inherited properties on the window thread and records every read.
- **Shared-everything WebAssembly threads calling the widget instance.**
  Shared-everything threads would avoid instantiating a separate window
  component once supported by WebAssembly runtimes. Even then, a frame-time
  function still cannot block on application locks or mutate application state,
  so the purity, capture, and `style-node` rules remain identical. The
  extraction backend can target a shared instance later without changing source
  code.

## Open questions

- **Function type syntax.** Whether isolated function types use a parameterized
  type constructor (`Isolated<Window, (node: StyleNode) => boolean>`) with
  library aliases (`ConditionFn`), or a function-type modifier
  (`window (node: StyleNode) => boolean`, `sendable (x: T) => R`), or both.
- **Explicit annotation syntax.** Whether standalone isolated functions outside
  a contextual type site use a single modifier (`isolated<Window>`) or
  context-specific markers (`@cond`, `macro`, `sendable`, `shader`) backed by
  the same compiler pass.
- **Companion artifact packaging.** How a ZenaFX widget component bundles its
  generated window component: as a sidecar `.wasm` asset, embedded as a custom
  section in the widget component, or composed into a single Component Model
  package.
- **Capture serialization.** Host-facing targets (`window`, `shader`) pass
  captures through the target's fixed ABI (WIT `list<value>` or uniform
  buffers), while Zena-to-Zena worker tasks can use a generated binary
  serializer ([concurrency.md](./concurrency.md#generated-binary-serialization)).
  Whether both share a single `Serializable` trait check in the type checker is
  open.
- **Higher-order pure functions.** Accepting a pure function value as a
  parameter inside an isolated function depends on `pure` function types
  ([pure-functions.md](./pure-functions.md#open-questions)).
- **Getter call cost under uncached resize/scroll.** Measuring
  `borrow<style-node>` getter overhead on cache misses during continuous resize
  or scroll will tell us whether declarative `range` tests (with interval-table
  skipping) should remain the recommended fast path for simple numeric
  breakpoints.
