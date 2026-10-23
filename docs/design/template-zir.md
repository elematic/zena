# Template ZIR

Status: **In progress.** Tracks #410. Expands [ir.md](ir.md) §8
("Generics: specialize the IR, not the AST") with measurements and a
design that lands in steps. The first step, methods of generic classes
copied from templates learned from two representatives, is implemented
in `codegen/ir/template.zena`.

## Overview

The compiler monomorphizes generic code. Reachability (RTA) decides which
instantiations exist, and every instantiation gets its own
`WasmFunction`: `GrowableArray<String>.push` and
`GrowableArray<Diagnostic>.push` are two functions, and lowering walks
the same `push` AST once for each, under that instantiation's
substitution.

Template ZIR lowers a generic source function once and makes each
instantiation's body by copying the instruction arrays and substituting
the body's two indirection tables, `typeTable` and `refTable` (ir.md §4).

ir.md gave compile time as the reason, and it is no longer a large one
(Measurements, below). The reasons that remain are architectural:

- **Per-file caching** (ir.md §13). A per-file artifact cannot hold a
  monomorphized body, because the type arguments are only known for the
  whole program. It can hold a template.
- **Discovery from IR** (ir.md §2.2). An instantiation's dependencies
  are its template's references pushed through the substitution, so
  discovery could read templates instead of walking the AST again for
  each instantiation. RTA discovery is 39% of a self-compile today.
- **One optimization of a generic body.** Cleanup that does not depend
  on the type arguments runs once per template.
- **A test oracle.** A specialized body and a directly lowered body of
  the same instantiation must be equal. Comparing them checks both.

## Measurements

`ZENA_ZIR_STATS=1` reports these (`codegen/template-stats.zena`). The
numbers are from an idle machine with `ZENA_GC_RESERVE_MB=1536`. The
bodies lowered from one source function in one role form a **group**;
its bodies after the first are **repeats**.

| workload                                             | compile | repeat lowering + cleanup |
| ---------------------------------------------------- | ------- | ------------------------- |
| `packages/stdlib/tests/assert/assert_test.zena`      | 0.46 s  | 4 ms                      |
| `packages/zena-compiler/zena/test/checker_test.zena` | 2.7 s   | 0.22 s                    |
| compiler self-compile, `-O1`                         | 13.1 s  | 0.86 s                    |

ir.md §14 gave a 47 s cold compile of `assert_test.zena` as the reason
for this milestone; that case is gone. Without the GC reserve,
`checker_test.zena` takes 8.4 s, so garbage collection is the larger
lever for that file.

Of the 17,809 repeat bodies in the self-compile, 16,426 (92%) have the
same opcodes, operands, type ids and ref indices as the first body of
their group. Only the contents of the two tables differ. The rest first
part from their group's first body at one of a few operations:

| where the streams part                                             | count | example                                                                         |
| ------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------- |
| `call` → `ref.is_null`, `ref.eq`, `i32.eq`, `i32.and`, `array.len` | ~520  | `HashMap<String, X>` hashes and compares keys by call, `HashMap<i32, X>` inline |
| `ref.as_non_null` → `array.set`, `ret`, `struct.get`               | ~410  | a reference element read from nullable storage is asserted, an `i32` is not     |
| `ref.null` → `const.i32`                                           | 62    | the zero value of `T`                                                           |
| `struct.get` → `param`                                             | 4     | `Completer<void>` has no value to store                                         |
| `array.get` → `array.get_u`                                        | 7     | a `u8` element is packed                                                        |

## What lowering decides from the type arguments

Lowering decides three kinds of things from the substitution.

1. **The representation of a type argument.** A number kind (and, in
   storage, the packed width), a reference to a class struct, an
   interface fat pointer, a record or tuple struct, zero width (`void`),
   nullability. These change opcodes, arity, null assertions and zero
   values.
2. **Operations dispatched on a type argument's class.** Equality,
   hashing, string conversion, `is` and `as`.
3. **Facts about the specialization in the module.** A private field's
   name carries the key of the specialization's class
   (`GrowableArray_s3141_Diagnostic_s9392::#length`). Whether a read of
   a public field is a `struct.get` or a virtual getter call depends on
   whether some subclass of that specialization overrides the accessor
   (`accessorOverriddenBySubclass`). Whether a call is direct or through
   the vtable depends likewise (`memberProvidedBySubclass`). Both walk
   the transitive subclasses RTA registered for that specialization:
   `this.size` is a field read in `HashMap<i32, Node>` and a virtual
   getter in `HashMap<String, Type>`, which `OrderedHashMap` extends.

The third kind is why a template cannot simply be "the body lowered with
symbolic types": lowering consults RTA's per-specialization results, and
those differ between instantiations of the same body. Each such decision
is either checked for the instantiation being specialized or deferred to
specialization time.

## Design

### Families

A **candidate** is a non-static method of a generic class
specialization, written in the class, that is not a constructor, a
generator or async function, a closure, an explosion core or forwarder,
a mixin method, or one of the roles lowering synthesizes
(`notCandidate`). A **family** is the candidates lowered from one
method node whose type arguments agree on their **pins**:

| type argument                                       | pin                               | varies within a family? |
| --------------------------------------------------- | --------------------------------- | ----------------------- |
| a class type (not `String`, not an extension class) | `C`                               | yes                     |
| an interface type                                   | `I`                               | yes                     |
| a union, record or tuple whose value is a reference | `R` and the key of that reference | yes                     |
| anything else (numbers, `void`, `String`, ...)      | the argument's specialization key | no                      |

So `GrowableArray<Diagnostic>` and `GrowableArray<Node>` share a family,
and so do the 517 `Future<Some<X> | None>` that lower `Some<X> | None`
to the same reference type; `GrowableArray<i32>` is a family of its own.
A family with fewer than three members is lowered directly.

### Learning a template from two representatives

A family's first two members, its **representatives**, are lowered in
template mode, and their bodies are used as they are. In template mode
the builder appends one type-table entry per `internType` call instead
of interning, so both bodies name their types by call order and their
tables line up entry for entry.

The two bodies must agree in everything but their tables' contents:
opcodes, operands, blocks, constants, try regions, and the answers to
the per-specialization queries (below). When they do not, the family
has no template (`representatives differ: <op> vs <op>` in the stats).

Then, position by position:

- An entry that is the same in both is the same in every member.
- An entry that differs is learned as a **recipe**: what kind of thing
  it is (a class struct, a class or interface vtable struct, an
  interface struct, an array or signature or anonymous struct over
  other types, a method by class key and name, a vtable or singleton
  or class-interface global, a field by owner and name), and the
  specialization keys that name it, generalized into **key patterns**.

Specialization keys join their type arguments' keys with `_`
(`GrowableArray_s3141_Diagnostic_s9392`), so a key derived from a type
argument contains that argument's key. A pattern is the first
representative's key with a hole wherever the argument's key appears,
checked by filling the holes with the second representative's keys and
getting its key back. A key the body names literally that happens to
contain the first representative's argument is told apart by the
second, whose argument differs there. Arguments the two representatives
share never become holes, and a later member must share them too.

Both representatives must resolve every recipe back to their own entry
before the template is kept.

### Per-specialization queries

`LoweringContext.accessorOverriddenBySubclass`,
`memberProvidedBySubclass` and `vtableSlotIndex` answer the third kind
of decision, and every lowering path that asks goes through them. In
template mode each call is recorded with its class key, names and
answer. The two representatives must agree on the answers; their keys
are generalized like the tables' keys. A later member re-runs each query
on its own specialization and is lowered directly when an answer
differs.

### The gate

Template mode abandons a family where lowering dispatches on a type
argument's class rather than its representation: a type test or cast
whose operand or target mentions a type parameter, a `match` on one, a
template literal interpolating one, `==` or `!=` with one, and a call to
a generic function that mentions one (`hash`, `equals`). The family is
then lowered directly (`families without a template` in the stats).

### Specialization

For a later member of a family with a template:

1. Re-run the queries; a different answer declines.
2. Resolve the recipes with the member's argument keys, looking entities
   up in RTA's tables (`classInfos`, `classMethodMap`,
   `classInterfaceVTables`, and `WasmModule.findArray`, `findSignature`
   and `findStruct`, which never create a type after layout); a missing
   one declines.
3. Copy the instruction arrays, blocks and side tables, replay the type
   log through value interning, and install the resolved refs.
4. Run the same per-function cleanup as on a lowered body.

A declined member is lowered directly.

### Exactness

A specialized body equals the body direct lowering produces for the
same function, array for array and entry for entry, so the emitted
module is byte-identical with templates on or off (`ZENA_TEMPLATES=0`
turns them off).

The type table needs care. The builder interns `ValType`s by value, so
when `T` is `String` and the body also names `String`, both land at one
index; for `T = Node` they are two. Replaying the type log interns each
resolved entry in call order, as the builder does while lowering, and
rewrites every type operand (`typeId`, `ref_test`/`ref_cast` targets,
`br_on_cast` targets) to the resulting index. `refTable` is not interned,
so its indices are the same in every member.

### What checks it

- **Both representatives** must lower to the same arrays and query
  answers, and resolve every recipe to their own entries.
- **Check mode** (`ZENA_TEMPLATE_CHECK=1`) lowers every specialized
  member directly too and fails the compile on any difference.
  `build:self-hosted`, which the fixpoint gate builds, sets it, and so
  does the portable execution runner, so the compiler's own 6,000
  specialized bodies and every execution test check each change.

What these cannot catch is a decision outside the gate and the three
queries that depends on a type argument, gets the same answer for both
representatives, and a different one for a later member that nothing in
the test corpus specializes. The pins keep the representation fixed
within a family, which is where the measured divergences came from.

### Toward templates without a representative

Caching templates per file and discovering from IR need a template that
exists before any instantiation is known. The recipes are already
symbolic: key patterns over the type arguments. Two things still need
representatives:

- **Learning which entries vary.** Lowering with symbolic type
  arguments would record each entry's derivation as it makes it.
- **Decisions.** The queries and the gated constructs become IR
  operations that specialization resolves: a member read that is a
  field read or a virtual getter call, equality, hashing and casts on a
  type parameter. This is ir.md §8's `generic.op`; each one is also a
  gate removed.

### Interprocedural type propagation (#421)

Independent of this design. Propagation runs per instantiation either
way, and its precision comes from monomorphization, which templates
keep. A flow graph or escape summary per template would only cover
bodies before simplify and inlining make them diverge, and saves a
linear graph-building step. Sharing one emitted body across reference
instantiations (#428) would merge their class sets and make #421 more
valuable.

## Results

Compiler self-compile at `-O1`, three runs each, idle machine:

| templates | lowering and per-function cleanup | module                          |
| --------- | --------------------------------- | ------------------------------- |
| off       | 2.40 s                            |                                 |
| on        | 2.33 s                            | byte-identical, `-O1` and `-O2` |

56 templates; 6,135 bodies specialized from them, in 47 ms. Of the
self-compile's repeats, 10,903 (772 ms) belong to candidate families.
The rest are not candidates: methods of extension classes such as
`FixedArray<T>` (2,516, 105 ms), constructors (2,769, 61 ms), closures
(1,219) and other functions (965).

The gate stops 91 families, among them the largest:

| family                                | members | gate         |
| ------------------------------------- | ------- | ------------ |
| `Future<T>.#propagate`, `.:adoptFrom` | 517     | equality     |
| `Future<T>.:valueOrThrow`             | 517     | cast         |
| `GrowableArray<T>.#grow`              | 178     | cast         |
| `GrowableArray<T>.contains`           | 178     | equality     |
| `HashMap<K, V>.get`, `[]`, `delete`   | 63      | generic call |

## Plan

1. Methods of generic classes, learned from two representatives, with
   the gate and the three queries. Done.
2. Deferred operations for equality, hashing and casts on type
   parameters, which lifts the gate for the families above.
3. More candidates: constructors, extension classes, closures, and
   generic functions and methods.
4. Measure how much of discovery is repeated per instantiation, and
   decide on discovery from templates.
