---
title: 'Built-in Decorators'
description: 'Compiler-recognized decorators for WebAssembly intrinsics, host imports, and component bindings in Zena.'
---

Decorators annotate declarations using `@name` or `@name(...)` syntax. In the current
version of Zena, all decorators are built-in compiler intrinsics. They tell the compiler
how to lower low-level declarations directly into WebAssembly instructions or import
definitions.

A `declare function` statement requires either an `@intrinsic` or an `@external`
decorator. Any declaration that omits both or uses an unknown decorator produces a
compile-time error.

## @intrinsic

The `@intrinsic` decorator binds a declaration directly to a WebAssembly opcode, a
WebAssembly GC operation, or a compiler-synthesized routine. The compiler generates
the operation inline at the call site, bypassing standard function call overhead.

The decorator takes exactly one string argument:

```zena
@intrinsic('name')
```

The compiler checks the string against its internal table of known intrinsics. If the
name is unrecognized, compilation fails.

### WebAssembly linear memory opcodes

The standard library uses `@intrinsic` on `declare function` statements to expose
raw WebAssembly 1.0 memory instructions:

```zena
@intrinsic('memory.size')
declare function memorySize(): i32;

@intrinsic('memory.grow')
declare function memoryGrow(deltaPages: i32): i32;

@intrinsic('i32.load')
declare function loadI32(byteOffset: i32): i32;

@intrinsic('f64.store')
declare function storeF64(byteOffset: i32, value: f64): void;
```

When code calls `loadI32(offset)`, the compiler emits the WebAssembly `i32.load`
instruction directly.

### Low-level math instructions

Single-instruction WebAssembly operations map directly to intrinsics where the name
matches the opcode:

```zena
@intrinsic('i32.clz')
declare function countLeadingZeros(val: i32): i32;

@intrinsic('f64.abs')
declare function absF64(val: f64): f64;
```

### WebAssembly GC array operations

Zena represents built-in array types using WebAssembly GC `array` types. Extension
classes on built-in types use `@intrinsic` on declared methods and properties to emit
the underlying GC array instructions:

```zena
extension class FixedArrayOps<T> on FixedArray<T> {
  @intrinsic('array.len')
  declare length: i32;

  @intrinsic('array.get')
  declare get(index: i32): T;

  @intrinsic('array.set')
  declare set(index: i32, value: T): void;
}
```

The compiler lowers calls to `.length` directly to `array.len`, `.get(i)` to `array.get`,
and `.set(i, v)` to `array.set`.

### Compiler type operators

The compiler uses `@intrinsic` on bodyless `declare type` statements to register built-in
type operators:

```zena
@intrinsic('type.awaited')
declare type Awaited<T>;
```

The type checker intercepts references to `Awaited<T>` and unwraps nested `Promise` or
`Future` types during semantic analysis.

### Complex runtime intrinsics

Some intrinsics synthesize multi-instruction sequences or dynamic dispatches:

- `@intrinsic('eq')`: Generates value comparisons. For primitives, it emits direct
  equality instructions (`i32.eq`, `f64.eq`). For strings, it calls string equality.
  For reference types with an overloaded `operator ==`, it dispatches through the
  vtable, falling back to `ref.eq`.
- `@intrinsic('hash')`: Dispatches to `hashCode()` on reference objects or hashes
  primitive values directly.

## @external

The `@external` decorator binds a `declare function` to an external host import or
a WebAssembly Component Model dependency.

### Two-argument imports

When targeting a core WebAssembly module (`--target js` or `--target
freestanding`), `@external` takes two arguments: the module name and the
exported field name:

```zena
@external('console', 'log')
declare function printI32(value: i32): void;

@external('env', 'readTimestamp')
declare function readTimestamp(): i64;
```

During code generation, the compiler records these in the WebAssembly Import section:

```wat
(import "console" "log" (func (param i32)))
(import "env" "readTimestamp" (func (result i64)))
```

### Three-argument component imports

When compiling to a WebAssembly Component Model target (`--target component`
or `--target zena-cli`), the module name names a WIT interface, and
`@external` accepts an optional third argument containing comma-separated
canonical options:

```zena
@external(
  'wasi:clocks/monotonic-clock@0.3.0',
  'now',
)
declare function monotonicNow(): u64;

@external(
  'wasi:http/outgoing-handler@0.3.0',
  'handle',
  'async',
)
declare function handleRequest(req: Request): Response;
```

The options string supports the following settings:

- `'async'`: Instructs the compiler to emit canonical `async` lifting and lowering for
  the imported function, integrating with the component's asynchronous ABI.
- Canonical type descriptors: Specifies the typed canonical builtin operated on by the
  import, such as `'stream<u8>'`, `'future:<interface>#<payload>'`,
  `'resource:<interface>#<name>'`, or `'return:<interface>#<type>'`.

For example, binding a byte stream write in the component model specifies the WIT type
in the options argument:

```zena
@external('canon', 'stream.write', 'stream<u8>')
declare function writeStreamBytes(stream: i32, data: FixedArray<u8>): i32;
```

## Status of @pure

The `@pure` decorator was proposed in early design documents for accessor declarations.
The original plan was to annotate custom getters and setters where the setter has no
side effects beyond writing to an internal backing field. This would allow the compiler
to eliminate write-only property assignments during dead-code elimination.

In the current compiler, `@pure` is not implemented.

In Zena's SSA-based ZIR optimizer:

- Plain field assignments and reads are side-effect-free by default and require no
  annotations. The optimizer automatically strips write-only field operations.
- The dead-code elimination (`dce`), global value numbering (`gvn`), and loop-invariant
  code motion (`licm`) passes analyze purity at the individual instruction level.
  Primitive arithmetic, memory loads without intervening stores, and pure allocations
  are eliminated when their results are unused.

If cross-function or cross-module purity annotations are needed for user-defined methods,
they will be designed alongside user-defined decorators.

## Future user-defined decorators

In dynamic languages like JavaScript, decorators are functions executed at runtime that
can mutate objects, install arbitrary properties, and swap out prototypes.

In Zena, all classes compile to fixed-layout WebAssembly GC structs with static vtables.
Instance layout cannot change at runtime, and methods cannot be dynamically monkey-patched.
User-defined decorators in Zena will therefore be compile-time abstractions:

1. **Metadata annotations**: Annotate classes, fields, or methods with compile-time
   constants. The compiler records this metadata into custom WebAssembly sections or
   static registries accessible through reflection.
2. **Method interceptors**: Wrap methods at compile time. The compiler rewrites the
   method body into a wrapper that calls the decorator logic before or after the
   original implementation, avoiding dynamic reflection overhead.
3. **Macro code generation**: Synthesize boilerplate declarations during compilation,
   such as JSON serializers, builders, or equality operators.

Until the user-defined decorator system is implemented, only `@intrinsic` and `@external`
are recognized by the compiler.
