# Reachability Analysis & Codegen Specialization (RTA)

This directory implements the whole-program reachability analysis and monomorphization/specialization pass for the Zena self-hosted compiler.

## Design Overview

In WebAssembly GC, having concrete struct and vtable definitions is required before code generation. To minimize the compiled code size and Wasm type section complexity, Zena utilizes a whole-program reachability analysis that performs **Rapid Type Analysis (RTA)**.

Instead of generating structures and function signatures for every class/interface or generic overload, the reachability pass starts at entry point roots (e.g. `main` or exports) and iteratively traverses reached functions and types. As new instantiations (`new Point()`) and dynamic dispatches are encountered, the pass resolves implementing virtual method overloads and queues them for traversal.

## Component Subsystems

To keep the codebase maintainable and maintain low AST traversal overhead, the reachability analysis is broken down into four cooperating modules:

```mermaid
graph TD
    Analysis["ReachabilityAnalysis (analysis.zena)"]
    Visitor["ReachabilityVisitor & TypeLowerer (visitor.zena)"]
    Specializer["Specializer (specialization.zena)"]
    CHA["ClassHierarchyAnalysis (hierarchy.zena)"]

    Analysis -->|Delegates AST walks| Visitor
    Analysis -->|Triggers specialization| Specializer
    Analysis -->|Queries class hierarchies| CHA
    Specializer -->|Queries subclass implementations| CHA
    Visitor -->|Discovers types / registers methods| Specializer
```

### 1. Central Coordinator: `ReachabilityAnalysis` (`analysis.zena`)

- Main entry point that manages RTA traversal queues (`reachableQueue`, `checkableQueue`).
- Configures and instantiates the helper subsystems in its constructor.
- Coordinates the overall compilation passes:
  - Pre-registers declared types to handle circular definitions.
  - Walks traversed functions iteratively until no new reachable symbols/methods are found.
  - Performs structural linker steps like linking base class vtables and resolving property getters/setters.

### 2. AST Visitor & Type Lowerer: `ReachabilityVisitor` & `TypeLowerer` (`visitor.zena`)

- **`ReachabilityVisitor`**: Traverses reached function and method bodies, discovering global dependencies, closures, and interface usage, and queues any newly referenced virtual members.
- **`TypeLowerer`**: Resolves structural types (`RecordType`, `TupleType`, etc.), array classes, and class/interface types to concrete WebAssembly types.

### 3. Monomorphizer: `Specializer` (`specialization.zena`)

- Performs generic class and interface specialization.
- Maintains lists of instantiated classes. When a generic class is instantiated, it generates specialized vtables, structs, and physical methods corresponding to that concrete type argument combination.
- Instantiates specialized generic function signatures.

### 4. Class Hierarchy Analysis: `ClassHierarchyAnalysis` (`hierarchy.zena`)

- Manages caches for subclass relationships (`isSubclassOf`).
- Resolves dynamic overrides, locating the concrete `MethodDefinition`, `AccessorDeclaration`, or `FieldDefinition` that implements a virtual slot on a subclass.
- Collects implementing interfaces transitively.

## An Erasure Is Not a Specialization

A type parameter lowers to `anyref`, so `Store<K, V>` named from inside
generic code is discovered as `Store<anyref, anyref>` — which
`isConcrete` accepts, because anyref is a type (and a real one:
`let x: anyref = "hi"`). It must not become a specialization. Every
value the mention stands for is some real specialization, discovered on
its own, while believing in the erasure makes it a fan-out target for
every reached member of the generic class and, once instantiated, gives
it a class vtable global whose slots force-reach an erased body of every
method — none of which lower when the class uses `hash`/`eq`, which
dispatch on their operand's type.

The mentions that fabricate one are plumbing, not code that runs:
`#linkSuperAndVT` naming a subclass template's supertype, and the walk
of a generic class's own template naming its field types.
`mentionsTypeParameter` (in `type-mapping.zena`) is what asks whether a
mention was erased; the erased class's struct is still registered,
because erased signatures and fields refer to it.

## A Generic Method Exists Only Per Specialization

A method's OWN type parameters are a separate axis from its class's.
`registerGenericMethodUse` mints `map_spec_i32` per call site; the
unspecialized registration — the body at the method's erasure — is not
a function, so:

- it gets no class-vtable slot (a slot is one `ref.func` of one
  signature, and a generic method has no single signature), and
- the member referrer in `processQueues` does not reach it
  (`isGenericAtErasure`).

Emitting it anyway put one dead body per specialization of the class in
every module (80 `Array<X>.map` in the compiler's own, referenced by
nothing), and those bodies' `new Array<R>` were the only thing that ever
made an erasure look constructible — which is why the rule above can be
flat. It is also what `zir unsupported: method not found` found where a
specialization should have been. See §15 of
`docs/design/binary-size.md`.

## Code Generation Pipeline Integration

The reachability pass is run in [module-generator.zena](../module-generator.zena):

```zena
let pass = new ReachabilityAnalysis(this.program, wasm, this.target);
pass.run();
```

After `pass.run()`, the `WasmModule` contains exactly the functions, struct layouts, and vtable allocations that are actually reached during execution, drastically reducing the Wasm module size.
