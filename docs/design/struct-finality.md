# Struct type finality

A wasm GC struct or array type is declared in one of two subtype forms:
`sub final`, which forbids any other type from declaring it as a
supertype, or the open `sub`, which permits it. Zena declares a type
open when some other type in the emitted module declares it as a
supertype, and final otherwise.

## The cost of a cast

Wasmtime compiles `ref.test` and `ref.cast` against a concrete struct
type to a load of the object's type index out of its header followed by
a comparison with the target type's index. When the two are equal the
test has passed and the comparison is the whole answer. When they
differ, the answer is whether the object's type is a *sub*type of the
target, and wasmtime cannot answer that in JIT code — it has no access
to the type registry's supertype arrays — so it calls the `is_subtype`
libcall, which leaves JIT code, re-enters the Rust runtime and takes
the store. Both halves are in
`wasmtime-internal-cranelift`, `func_environ::gc::is_subtype`.

Against a final target the second half is unreachable. A final type is
the supertype of nothing, so `a <: b` holds exactly when `a == b`, and
wasmtime emits the comparison with no branch and no libcall. Its own
comment on that branch:

> When `b` is final the equality check above is already a complete
> subtype check [...] we can avoid emitting the slow-path `is_subtype`
> libcall and its control flow entirely

So the cost falls on tests that _fail_, and on casts to a class that
has subclasses. A `match` over a sealed hierarchy compiles to one
`ref.test` per arm, of which all but one fail, so every arm tried
before the matching one was a call into the runtime.

The compiler is the program this hits hardest, because it is written as
matches over AST and type hierarchies. A sampling profile of it
compiling `packages/zena-compiler/zena/test/portable_semantics.zena`
attributed 49% of the whole compile to `is_subtype_cached` reached
through the `is_subtype` libcall ([#175](https://github.com/elematic/zena/issues/175)).

## The rule

A type is open when some `WasmStruct.superStruct` or
`WasmArray.superArray` among `wasm.types` points at it. Subtyping in
wasm is by declaration, so a type that no declaration names cannot have
a subtype, and declaring it final takes nothing away.

`ModuleGenerator.compile` computes this immediately before emitting the
type section, rather than in `WasmModule.layout()`, because
`pruneTypes` runs in between and can delete the last subtype a type
had. Both emitters take the answer as a parameter
(`emitStructTypeStart`, `emitArrayType`).

## Declaring a supertype and being one

An immutable array of references always declares a supertype — the
array of its element's supertype, up to `(array anyref)`, which is what
makes `ImmutableArray<Cat>` a wasm subtype of `ImmutableArray<Animal>`
(`docs/design/array-mutability.md`). That is a separate question from
whether anything declares _it_ as a supertype, and the array of the
most derived element type in a chain is final. The widening still
works: it needs the `Cat` array to name the `Animal` array as its
supertype, and it needs the `Animal` array to be open, which it is
because the `Cat` array names it.

An array of scalars is a different case and is always final. Covariance
is only sound for immutable reference elements, so
`WasmModule.#immutableArraySuper` returns null for anything else: a
mutable array declares no supertype, and neither does `(array i32)` or
any other array of values. Nothing can name one as a supertype either,
because nothing would be a subtype of it, so `(array i32)` is final in
every module.

In the compiler's own module 2 immutable arrays declare a supertype and
1 array is one, so 290 of the 291 array types are final.

## The WAT emitter's subtype clause

A bare `(type (;1;) (array i32))` already means `sub final` with no
supertype, so `WatEmitter` writes the `(sub ...)` clause only when it
carries something the bare form does not — that the type is open, or
what it extends:

|       | no supertype         | extends `$S`                  |
| ----- | -------------------- | ----------------------------- |
| final | `(struct ...)`       | `(sub final $S (struct ...))` |
| open  | `(sub (struct ...))` | `(sub $S (struct ...))`       |

This matches what `wasm-tools print` emits, so a dump and a
disassembly of the same module read the same. The bug it fixes is the
bottom-left cell: an open struct with no supertype used to print bare,
which reads as final, while `BinaryEmitter` declared every struct
open — so the text said the opposite of the bytes for the one property
that decides whether a cast against the type is inline.

## Measurements

The compiler's own module, `packages/zena-compiler/zena/out/cli-self.wasm`:

|                | before | after |
| -------------- | ------ | ----- |
| struct types   | 5,827  | 5,827 |
| array types    | 291    | 291   |
| declared final | 288    | 5,773 |
| declared open  | 5,828  | 343   |

Of its 18,192 `ref.test`/`ref.cast` sites, 16,785 target a struct that
nothing extends. The 343 types still open are 342 structs that another
struct declares as a supertype, plus the one array above.

That compiler compiling `portable_semantics.zena`, `--time`:

| phase              | before   | after    |
| ------------------ | -------- | -------- |
| Check              | 1,399 ms | 523 ms   |
| Codegen            | 7,319 ms | 3,324 ms |
| — Discovery queues | 3,801 ms | 1,380 ms |
| — Discovery layout | 1,150 ms | 462 ms   |
| — Emit code        | 324 ms   | 316 ms   |
| Total              | 9,080 ms | 4,153 ms |

Emit code is the control: it writes bytes into buffers and tests no
types, and it did not move. Everything that walks an AST or a type
graph is between two and three times faster.
