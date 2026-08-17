# SIMD

WebAssembly's fixed-width SIMD extension adds a 128-bit vector value type
and 236 instructions over it. Zena exposes both: `v128` is a primitive
type, and `zena:simd` declares one function per instruction, each lowered
to that instruction and nothing else.

This covers the type and the instruction surface. Vector types with an
element type (`f32x4`, `i32x4`) and elementwise operators are not part of
it; see "Future work".

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

## Testing

Three execution tests, under `tests/language/execution/simd/`:

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

`tests/language/semantics/type-system/v128.zena` covers the rejections:
casts in both directions, arithmetic, and a numeric literal in a `v128`
slot.

## Future work

- **Shaped vector types.** `f32x4`, `i32x4` and friends, giving the bits
  an interpretation the type system can see.
- **Operators.** `+`, `-` and `*` as elementwise operations on the shaped
  types, following the numpy and Rust convention, with dot and cross
  products as named methods. These belong to the shaped types, not to
  `v128`, which has no element width to be elementwise over.
- **A source location on immediate errors**, which needs the checker to
  know which intrinsic arguments are immediates.
- **Relaxed SIMD**, if the non-determinism is worth taking on.
