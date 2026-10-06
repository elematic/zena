# Lazy Body Checking

Every compile used to check every body of every file it loaded, and most
of those bodies are never reached. `export let main = (): i32 => 42`
emits one function; checking it visited about 476 bodies across 48
files, because the prelude reaches most of the standard library through
barrel modules: `zena:collections` re-exports from `map.zena`,
`hash-map.zena`, `set.zena` and `hash-set.zena`, and `zena:core` from
twenty-three more.

Two rules decide what gets checked, and they answer different
questions.

**Reachability decides cost.** A body nothing reaches is never checked.

**Locality decides diagnostics.** A file in the local project is checked
in full whether or not anything reaches it, because a typo in a function
nobody calls yet still has to be reported. A dependency is checked only
where reached.

## The local project

The local project is the entry point and everything it reaches by
relative import (`./`, `../`). A package specifier (`zena:core`,
`wit-parser:parser`) leaves the project, and everything beyond one is a
dependency. `checkCompilation` computes the set as a breadth-first
search from the entry over `SourceFile.imports`, which maps specifier to
resolved path.

For the compiler's own build that makes every file under
`packages/zena-compiler/zena/` local, since `cli/main.zena` reaches them
all through `../lib/...`. The standard library it imports as `zena:` is a
dependency.

## Signatures everywhere, bodies on demand

A dependency module is registered in full. Phase 0 and Phase 1 are
unchanged: symbols, classes, interfaces, enums, mixins, type aliases and
`declare function` all register, so every signature an importer resolves
against exists. So do the parts of Phase 2 that are not function bodies:
type aliases, interface constructor bodies, a top-level `let` holding
something other than a function, a class's field initializers (an
unannotated field gets its type from its initializer, and struct layout
needs it), and the class-level rules that mutate the class — a resource
class with owner fields has its `:dispose` synthesized there.

What waits is the part that costs:

- a `function` declaration's body,
- the body of an arrow bound by a top-level `let`,
- each `class` member body, one method or accessor at a time.

`finishModule` records those on a `DeferredModule` instead of checking
them, and hangs it off the module's `SemanticModel` as
`deferredBodies`. The interface it implements, `DeferredBodies`, is
declared in `semantic-model.zena` with two methods — `checkGlobalBody`,
which a symbol id names, and `checkBodyOfNode`, which a node id names —
so reachability can ask for a body without importing the checker, which
imports the semantic model.

A function with a return annotation also has its signature resolved
eagerly, through the same `lazyResolveFunction` that serves forward
references within a module. That is cheap (it resolves annotations and
checks nothing) and it means codegen can read a wasm signature off the
arrow before anything reaches the body. A function with an inferred
return type cannot be resolved that way — inferring the return type is
checking the body — so it waits, and the first reference to it resolves
it.

A deferred module's `CheckerContext` outlives its check, held by
`SharedCheckerState.moduleContexts`, because the deferred bodies are
checked in it and because an importer asks it for a signature the
deferred body never bound (`resolveInProgressFunction`, which already
reached into another module's context for import cycles). A module that
defers nothing is not held: that would keep the flow-analysis state of
the whole local project alive for the length of the compile.

## Checking from the reachability walk

`ReachabilityVisitor` reads types the checker produced — `getNodeType` in
forty places, plus `getInterfaceAdaptation` and `getRecordAdaptation` —
and it resolves dynamic dispatch against the set of instantiated classes
rather than only following constructor calls. So reachability cannot run
before checking. But it needs the checked model of the function it is
walking, not of the whole program, which is what makes the two fuse into
one worklist: dequeue a function, check its body if it is not checked
yet, walk it, enqueue what it reaches.

The checker is asked for a body at six call sites, each one just before
something reads node types that only a body check writes:

- `processQueues`, both branches — a symbol referrer before
  `globalDeclarations` and the symbol's dependency record, a node
  referrer before `discoverNodeTypes` and the node's dependency record.
- `markFunctionReached` — a reached function is a lowered function, and
  lowering reads the node types of its body. A function can be reached
  without ever being dequeued: a vtable slot, a trampoline's target.
- `discoverFunctionDeclaration` and `discoverVariableDeclaration` in the
  visitor, which a use site reaches on demand as well as the queue walk.
- `Specializer.instantiateGenericFunction`, which reads the generic
  arrow's checked type to build the specialization's signature.

Each call is a no-op for a body already checked and for an id that names
nothing the module deferred, so the hot loop pays one null field read on
a model that defers nothing, which is every local module.

One index had to stop depending on a checked body: reachability decided
whether a global was a generic function by asking whether its checked
type carried type parameters, and that index is built before the walk.
It reads the type parameters off the `FunctionExpression` instead. The
two agree — the checked signature's type parameters are the written
ones.

## What this gives up

Diagnostics in a dependency body. A reached dependency body is checked
during codegen, after the driver has already reported the compilation's
diagnostics, so an error in one lands in the model and is not printed; an
unreached one is never checked at all. That is the policy above — a
dependency is already checked on its own terms, and its diagnostics are
not this compilation's business — but it means a type error in standard
library source is invisible to a program that merely uses it.

`ZENA_CHECK_ALL_BODIES=1` turns the whole thing off: every body of every
loaded module is checked when its module is, and dependency diagnostics
are reported again. Use it when working on the standard library, or to
tell a compiler bug apart from a deferral bug.

## Measurements

`examples/hello-world.zena`, built by the self-hosted compiler under
`zena-run`:

| phase   | eager   | deferred |
| ------- | ------- | -------- |
| check   | 1081 ms | 84 ms    |
| codegen | 777 ms  | 289 ms   |
| total   | 1944 ms | 458 ms   |

The compiler building itself, where nearly every file is local: check
5935 ms → 4492 ms, total 34.7 s → 33.3 s, since codegen dominates
there. This is a win for people compiling small files against a large
dependency, and the emitted module is the same either way — the
compiler's own build is byte-identical with and without deferral, and
`test:fixpoint` still holds (the compiler that the compiler builds,
built once more, is byte for byte the same).

For a small program the type section is permuted relative to an eager
build: fewer semantic types exist when reachability interns them, so
they intern in a different order. The modules are otherwise identical,
and each is deterministic on its own.
