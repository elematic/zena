# SIMD

WebAssembly's fixed-width SIMD extension adds a 128-bit vector value type
and 236 instructions over it. Zena exposes both, in two layers under one
import:

- `v128` is a primitive type, and `zena:simd` declares one function per
  wasm instruction, each lowered to that instruction and nothing else.
- **Shaped types** — `I32x4`, `F32x4` and four siblings — give those bits
  a lane width and a lane type, with elementwise operators and named
  lanes. They are erased views of the same `v128`, not wrappers.

Most code should reach for a shaped type and drop to the instruction
layer where the shapes do not reach. Mixing the two in one expression is
free.

## The v128 type

`v128` is a value primitive alongside `i32` and `f64`. It has no literal
syntax, no operators, and no conversions.

That is not a gap to fill later. A `v128` is 128 bits with no
interpretation attached — the same register is four floats to
`f32x4.add` and sixteen bytes to `i8x16.shuffle`, and the type does not
record which. So there is nothing for `+` to mean, and nothing for a cast
to preserve. `v128 as i32` is rejected rather than defined as a
truncation or a reinterpretation, and building a vector goes through
`v128Const` or a splat, which say what the bits are.

What `v128` does have is ordinary value semantics. It lives in locals,
parameters, returns, class fields, array elements and module-level
bindings, and passes through them unchanged. Wasm GC accepts `v128` as a
struct field and array element type, so a generic instantiated at `v128`
stores one directly: `Array<v128>` is a wasm array of vectors,
`Box<v128>` a struct with a `v128` field, and `HashMap<String, v128>`
holds them in its entries.

`v128` is not a subtype of `anyref` — it is not a reference type at the
wasm level at all. This constrains it no more than it constrains `i32`,
because Zena never converts a primitive to a reference implicitly:
`Box<T>` is an ordinary class, and constructing one is visible in the
source. So `Box<v128>` works for the same reason `Box<i32>` does, and
neither is boxing in the wasm sense.

## The instruction surface

`zena:simd` declares all 236 fixed-width instructions. Names are
mechanical transliterations of the wasm names, so the specification reads
as documentation for the module:

| wasm                   | Zena                   |
| ---------------------- | ---------------------- |
| `i32x4.add`            | `i32x4Add`             |
| `v128.load8x8_s`       | `v128Load8x8S`         |
| `i8x16.extract_lane_u` | `i8x16ExtractLaneU`    |
| `f64x2.promote_low_f32x4` | `f64x2PromoteLowF32x4` |

The rule: split on `.` and `_`, keep the first segment, capitalize the
rest.

```zena
import {i32x4Splat, i32x4Add, i32x4ExtractLane} from 'zena:simd';

let sums = i32x4Add(i32x4Splat(5), i32x4Splat(3));
let lane0 = i32x4ExtractLane(sums, 0);  // 8
```

Each declaration is `@intrinsic`, so a call lowers to the one
instruction. There is no wrapper function to inline away and no
allocation.

### Immediates

Some instructions encode an operand *in the instruction* rather than
reading it off the stack. Those arguments must be literals:

- the lane index of `extract_lane`, `replace_lane`, and the `_lane`
  memory forms;
- the four words of `v128Const`;
- the sixteen lane selectors of `i8x16Shuffle`.

A non-literal there fails the compile. Zena has no compile-time constant
parameters to express the requirement in a signature, so it is checked
during lowering, and the failure names the instruction and the bound:

```
zir unsupported: i32x4.extract_lane: lane index must be an integer in 0..3, got 9
```

These messages carry the enclosing function's name but not a source
location, which is the main rough edge in this area.

Lowering rejects the non-literal case rather than compiling it a slower
way. A computed lane index is not a slower version of the same program —
it is a different one (a spill to memory, or a branch over sixteen
instructions), and which one it should be is the author's choice.

### Memory arguments

The load and store instructions take an address and nothing else. The
alignment hint is the instruction's natural alignment and the offset is
zero, both chosen by the compiler.

Wasm alignment is a hint: it never changes what a load returns, only how
well an engine can compile it. Exposing it would add an argument that
cannot affect a program's meaning.

```zena
import {v128Load, v128Store, i32x4Add} from 'zena:simd';
import {defaultAllocator} from 'zena:memory';

// `ptr` and `ptr + 16` hold two vectors; add them into the first.
let addInPlace = (ptr: i32): void => {
  v128Store(ptr, i32x4Add(v128Load(ptr), v128Load(ptr + 16)));
};
```

### Relaxed SIMD

Not included. Relaxed SIMD instructions are permitted to give different
results on different engines, and they are off by default in the engines
Zena targets (including the wasmtime embedded in `zena-cli`). Adding them
means deciding what a Zena program is allowed to assume about its own
arithmetic, which is a separate decision from exposing the deterministic
set.

## Shaped vector types

A `v128` says nothing about what its bits mean. The shaped types attach
that meaning to the type rather than to each call:

```zena
import {F32x4} from 'zena:simd';

let lerp = (a: F32x4, b: F32x4, t: F32x4): F32x4 => a + (b - a) * t;
let mid = lerp(F32x4.splat(0.0), F32x4.splat(10.0), F32x4.splat(0.5));
mid.x; // 5.0
```

Six ship: `I8x16`, `I16x8`, `I32x4`, `I64x2`, `F32x4`, `F64x2`.

### Erasure, not wrapping

Each is an `extension class on v128`. Extension classes are erased, so a
shaped type IS a `v128` at runtime: `v as v128` moves no data, every
method is one wasm instruction, and nothing allocates. The whole of

```zena
let a = I32x4.splat(20);
let b = I32x4.splat(22);
return (a + b).x;
```

compiles to three calls whose bodies are `i32x4.splat`, `i32x4.add` and
`i32x4.extract_lane 0`, over `v128` parameters throughout. There is no
struct in the module. `codegen-wat_test.zena` asserts the absence, since
a snapshot would show a regression that started boxing them as just
another diff.

The methods are real calls rather than inlined instructions — Zena has no
inliner — but they are leaf functions of one instruction each, which is
the shape an engine inlines.

### Elementwise operators

`+`, `-` and `*` are elementwise, following numpy and Rust: `a * b`
multiplies lane i by lane i. It is not a dot product and there is no
matrix reading. Operations that combine lanes are named methods, so a
line of arithmetic never hides a reduction.

Two operators are absent rather than emulated:

- **`/` on integer shapes.** Wasm SIMD divides floats only. An integer
  `/` would have to unpack the lanes and divide them one at a time, and
  an operator that quietly costs a dozen instructions is the kind of
  hidden price this language avoids elsewhere.
- **`*` on `I8x16`.** Wasm has no `i8x16.mul`. Widening, multiplying and
  narrowing back is a different operation with different overflow
  behaviour, so it does not get to be spelled `*`.

`==` is absent too, and for a different reason. Wasm's lane comparisons
produce a MASK — all-ones or all-zeros per lane — while Zena's `==` must
return `boolean` and carries the equality contract that `HashSet` keys
depend on. One operator cannot be both, so the masks stay named
functions (`i32x4Eq` and friends) until the boolean form is designed.

Negation is `v.neg()`, not `-v`: Zena dispatches only binary operators to
operator methods, and unary `-` on a non-numeric type is an error.

### Named lanes

Lane indices are wasm immediates and so must be literals, which an index
operator cannot express — `v[i]` takes a runtime value. Shapes with four
or fewer lanes therefore name them:

```zena
let p = F32x4.splat(0.0).withX(1.0).withY(2.0);
p.x + p.y; // 3.0
```

`x`, `y`, `z`, `w` for the four-lane shapes and `x`, `y` for the
two-lane ones, each with a matching `withX`/`withY`/… that returns a
copy. `I8x16` and `I16x8` get none: at eight or sixteen lanes there is no
set of names that beats an index, so lane access there goes through
`i8x16ExtractLaneS` and friends.

### Signed shapes only

`u8x16`, `u16x8`, `u32x4` and `u64x2` are not here yet. Signedness does
not change `+`, `-` or `*` — those are bit-identical on two's-complement
lanes — so an unsigned view would today differ from its signed twin in
name only. They arrive with the surface that actually distinguishes them:
comparisons, `min`/`max`, and the shifts.

## Implementation

### One table

`packages/zena-compiler/zena/lib/simd.zena` holds every instruction's
opcode, operand shape, result type and natural alignment. Two consumers
read it: `isValidIntrinsic`, which decides whether an `@intrinsic` name
is real, and the ZIR lowering router. A name that type-checks is
therefore a name that lowers — there is no second list to fall out of
step with the first.

The table was read back out of an assembled module rather than
transcribed. One function per instruction was assembled with
`wasm-tools`, and the opcode and memarg alignment taken from the
disassembly of the result.

### ZIR

ZIR has eleven SIMD ops, one per operand shape, not 236:

| op                                     | operands            | immediates          |
| -------------------------------------- | ------------------- | ------------------- |
| `simd_unary`                           | 1                   | opcode              |
| `simd_binary`                          | 2                   | opcode              |
| `simd_ternary`                         | 3                   | opcode              |
| `simd_extract_lane`                    | 1                   | opcode, lane        |
| `simd_replace_lane`                    | 2                   | opcode, lane        |
| `simd_const`                           | 0                   | opcode, 16 bytes    |
| `simd_shuffle`                         | 2                   | opcode, 16 selectors |
| `simd_load` / `simd_store`             | 1 / 2               | opcode, alignment   |
| `simd_load_lane` / `simd_store_lane`   | 2                   | opcode, alignment, lane |

The wasm opcode rides as an immediate, so the instruction stays a number
from lowering to emission. Enum cases for all 236 would have tripled
`IrOp` and added 236 arms to every match over it while distinguishing
nothing the backend acts on. The result type is the instruction's own, in
the instruction's `typeId`, so `i32x4.add` and `i32x4.bitmask` share
`simd_unary`'s sibling shapes without needing separate ops.

`WasmEmitter` gains five hooks on the same principle — `emitSimd`,
`emitSimdLane`, `emitSimdMem`, `emitSimdMemLane`, `emitSimdBytes` — one
per immediate layout. The binary emitter writes the `0xFD` prefix and
encodes the opcode as a ULEB128: over half the vector opcodes exceed 127,
so a single byte would silently truncate `i32x4.add` (0xAE) into a
different instruction rather than fail.

### Zero values

A `v128` global or a `v128` field of a singleton struct needs a constant
initializer, and wasm has no `v128` equivalent of `i32.const 0` — the
only vector constant is the 16-byte `v128.const`. `ModuleGenerator`
emits one with sixteen zero bytes.

### What the shapes needed from the compiler

Two changes, both narrow.

`isValidCast` rejected every `v128` conversion except `v128`-to-`v128`,
which is right for numerics and wrong for a shaped view: `I32x4` is the
same bits with an interpretation, so the conversion is exactly the
"primitive to an extension class on that primitive" case the checker
already allowed for numbers and booleans. `isV128View` decides it now,
and the rule is stated as itself rather than by enumerating lane types.

Member reads on a receiver with no struct behind it bailed with `member
receiver kind`. Extension classes over wasm arrays already had a path
for this — extensions have no fields and no vtable, so the target is
always a getter called with the underlying value — and that path is now
shared with primitive receivers, which is what makes `v.x` compile.
Methods and statics already worked; only property getters were missing.

## Testing

Execution tests under `tests/language/execution/simd/`:

- `all-instructions.zena` calls every one of the 236 instructions once.
  It proves coverage rather than arithmetic: the module only runs if all
  of them lower without a bail and the bytes pass wasmtime's validator,
  which checks each opcode's operand types and immediate widths. Its
  expected value is a checksum of the run.
- `semantics.zena` asserts what a validator cannot: which argument
  reaches which wasm operand, where a lane immediate lands, and which end
  of a vector is lane zero. A swapped operand pair or an off-by-one lane
  validates and runs, so these are hand-computed.
- `aggregates.zena` covers `v128` in fields, arrays and globals.
- `shapes.zena` covers the shaped types: elementwise arithmetic, named
  lanes and their `with` copies, `neg`/`abs`/`min`/`max`/`sqrt`, the
  conversions to and from bare `v128`, and load/store round-trips.

`tests/language/semantics/type-system/v128.zena` covers the rejections:
casts in both directions, arithmetic, and a numeric literal in a `v128`
slot. `codegen-wat_test.zena` asserts the two emission properties — the
WAT spelling of each SIMD immediate layout, and that a shaped type
allocates nothing.

## Future work

- **Unsigned shapes** (`U8x16` and siblings), together with the
  comparison, `min`/`max` and shift surface that distinguishes them from
  the signed ones.
- **Boolean lane comparisons.** Deciding what `==` on a shaped type
  should mean, given that wasm's answer is a mask and Zena's `==` must
  be a `boolean` that respects the equality contract.
- **Reductions and products.** `dot`, `cross`, horizontal sums — named
  methods, never operators.
- **Unary operator overloading**, which would turn `v.neg()` into `-v`.
  This is a language feature rather than a SIMD one: unary `-` currently
  requires a numeric type and never dispatches to an operator method.
- **A source location on immediate errors**, which needs the checker to
  know which intrinsic arguments are immediates.
- **Relaxed SIMD**, if the non-determinism is worth taking on.
