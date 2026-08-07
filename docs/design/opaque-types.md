# Opaque Types

## The problem

`distinct type` gives a type its own identity in the checker, which is enough
to stop `Meters` being passed where `Seconds` is expected. It is not enough to
make a type *trustworthy*, because anyone can write the cast:

```zena
distinct type Token = i32;

// In some other file, five layers away from the validation:
let t = 0 as Token;
```

So a distinct type documents an intent that the type system will not enforce.
Any invariant the declaring code establishes — this token was issued, this
index is in bounds, this string was escaped — can be sidestepped by a cast at
the use site, and the compiler will not say a word.

`opaque type` closes that gap. It is a distinct type that can only be cast
*to* inside the file that declares it, which makes that file the sole source
of values, and therefore the only place its invariants have to be checked.

```zena
// tokens.zena
export opaque type Token = i32;

export let mint = (raw: i32): Token => {
  if (raw <= 0) { throw new Error('token must be positive'); }
  return raw as Token;
};
```

Every `Token` in the program came out of `mint`, so `raw > 0` holds for all of
them — a property the checker now underwrites rather than merely documents.

## Why a file, and not a module or a package

The declaring *file* is the boundary because it is the unit a reader can hold
in their head. Reviewing whether a `Token`'s invariant holds means reading one
file top to bottom and finding every `as Token` in it. A package-level boundary
would spread the audit over an unbounded number of files; a
one-declaration-per-type boundary would make the common case — a smart
constructor plus a handful of combinators that rebuild the value — impossible
to write.

This matches the granularity Zena already uses for private class fields, which
are lexical to their declaration rather than scoped to a module.

## `opaque` implies `distinct`

Opacity is a restriction layered on top of a distinct type, not an alternative
to one. `TypeAliasDeclaration.isOpaque` and `TypeAliasType.isOpaque` always
come with `isDistinct` set, so every pass that cares only about nominal
identity — assignability, erasure, codegen, incremental-compile signature
equality — keeps reading `isDistinct` and needed no new cases. The only pass
that reads `isOpaque` is the cast check.

That also means an opaque type costs nothing at runtime: like every distinct
type it is erased before codegen, and casts across it compile to nothing.

## What counts as forging

The restriction has to be on casts that *manufacture* a value, not on every
cast whose target mentions the type. Rejecting the latter would make ordinary
code illegal:

```zena
let unwrap = (t: Token | null): Token => t as Token;
```

Narrowing a nullable opaque value happens at every call site that handles one,
and the value it produces already existed — nothing was forged. So the rule is:

> A cast `e as T` in file F is rejected when `T` mentions an opaque alias
> declared outside F, **unless** the source type and `T` already overlap —
> that is, unless one is assignable to the other.

Both directions of assignability are needed, and each covers a real case:

| Cast | Source → target | Target → source | Verdict |
|---|---|---|---|
| `42 as Token` | no | no | rejected — a forge |
| `t as Token` where `t: Token` | yes | yes | allowed — redundant |
| `t as Token` where `t: Token \| null` | no | yes | allowed — narrowing |

A cast where neither type is assignable to the other is precisely a
reinterpretation of an unrelated representation, which is exactly what forging
is.

## The check is not limited to the head of the type

Distinct types are erased, so `Array<i32>` and `Array<Token>` have identical
runtime representations and this forges just as effectively as `0 as Token`:

```zena
let ints = [1, 2, 3];
let forged = ints as Array<Token>;
```

`findForeignOpaque` therefore walks every position of the cast target that a
cast could reinterpret: element types, tuple elements, union members, record
fields, function parameters and return types, and type arguments of classes,
interfaces, mixins, and aliases.

It also follows an alias's `target`, so wrapping the opaque type in another
alias is not an escape hatch:

```zena
distinct type Tokens = Array<Token>;
let forged = ints as Tokens;   // still rejected
```

The walk is bounded by a depth counter rather than a visited set. Recursive
aliases and self-referential generic instantiations would otherwise not
terminate, and exhausting the budget reports "no opaque type found", which errs
toward accepting a cast rather than rejecting valid code.

## Casting out is allowed

`t as i32` is legal anywhere. The guarantee is that every value of the type
came from the declaring file, so that file's invariants hold; reading the
underlying value does not violate it. Restricting reads would also make the
type useless without a hand-written accessor for every operation, and would
still not hide anything — the representation is written in the declaration,
which is public.

If you want the representation itself hidden, a `class` with private fields is
the tool for that. `opaque` is about unforgeability, not encapsulation.

## Known limitation: casts through type parameters

A cast whose target is a bare type parameter is not checked at all, so a
generic helper still launders values:

```zena
let launder = <T>(x: i32): T => x as T;
let forged = launder<Token>(0);   // not rejected
```

This is a pre-existing hole in `isValidCast` that opaque types inherit rather
than introduce — the same trick forges any distinct type or class — and it caps
what opacity can promise until it is closed. Tracked in
[BUGS.md](../../BUGS.md).

## Implementation

| Concern | Location |
|---|---|
| `opaque` keyword | `tokenizer.zena` (`TokenType.Opaque`), usable as an identifier elsewhere |
| Parsing (`opaque` only before `type`) | `parser.zena` `#parseTypeAliasDeclaration` |
| AST flag | `ast.zena` `TypeAliasDeclaration.isOpaque` |
| Type flag + declaring module | `types.zena` `TypeAliasType.isOpaque`, `.declaringModule` |
| Cast check | `checker.zena` `findForeignOpaque`, `checkOpaqueCast` |
| Diagnostic | `diagnostics.zena` `DiagnosticCode.OpaqueTypeCast` |

`declaringModule` is set once, where the alias is materialized from its
declaration, out of `Symbol.modulePath` — the same canonical string space as
`CheckerContext.filePath`, so the comparison is an exact string equality.
Because import symbols carry an `ImportSpecifier` declaration rather than a
`TypeAliasDeclaration`, the symbol reaching that arm is always the declaring
one, and importing modules reuse the same `TypeAliasType` object rather than
minting a second identity.

## Tests

- `tests/language/syntax/types/aliases/opaque.zena`, `opaque-generic.zena` —
  parsing; the snapshots pin that `opaque` sets both flags.
- `tests/language/syntax/identifiers/keyword-like.zena` — `opaque` still works
  as an ordinary identifier.
- `tests/language/semantics/type-system/opaque-types/basic.zena` —
  unrestricted within the declaring file, still distinct.
- `.../opaque-types/cross-file/main.zena` — the five forging routes, each
  rejected.
- `.../opaque-types/cross-file/allowed.zena` — everything that must stay
  legal. Kept in a separate file on purpose: the portable-semantics runner only
  reports *unexpected* errors for files that declare no `@error` directive, so
  a file mixing legal and illegal casts would hide a regression that made valid
  code fail.
- `tests/language/execution/operators/as/opaque.zena` — erasure; the value
  survives a round trip through the opaque type.
