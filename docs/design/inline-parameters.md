# Inline Parameters and Locals

Stages 3 and 4 of #371. `inline` on a function result already means the
value is returned unboxed: an inline tuple as one wasm result per slot
(multi-return-values.md). This extends the modifier to parameters and to
`let` locals, with the same meaning. A value of an inline type is never
put in a heap object.

```zena
type Span = (i32, i32);

function width(s: inline Span): i32 {
  let (start, end) = s;
  return end - start;
}

function clamp(s: inline Span, limit: i32): inline Span {
  let (start, end) = s;
  return (start, if (end > limit) limit else end);
}

let w = width((3, 9));          // passed as two i32s
let c = width(clamp((0, 50), 10)); // forwarded as slots, nothing boxed
```

## What may be inline

An `inline` parameter or local has one of these types, as an inline
result does:

- a tuple, or an alias of one;
- a union of tuples with a discriminant (the rule from #481);
- a closed record, or an alias of one, also as an element of an inline
  tuple, unless it has optional fields there. A record whose fields
  are not known (existential, or spreading a row parameter) cannot be
  inline.

Allowed positions in this round:

- a parameter of a function declaration, of an arrow bound by a
  top-level `let`, of a method, of a constructor, and of an interface
  method signature;
- a `let` local, written `let q: inline Span = ...`, or initialized from
  another inline binding (`let q = s` keeps `q` inline), directly or
  from an arm of an `if` or `match` (`let q = if (c) s else t`).

Not in this round, each an error that says so:

- a `var` local, which would need its slots carried through joins;
- `inline? T` on a parameter;
- a function type with an inline parameter, a closure with one, and
  using a function that has one as a value. Converting between
  `(s: inline Span) => R` and `(s: Span) => R` needs an adapter, and
  adapters across a change of representation are #543;
- an exported function, whose parameters the host passes;
- an `async` or generator function, whose parameters move into a frame.

## The rule

An inline binding is only read or passed on. Each use of one is one of:

- **a read:** destructuring (`let (a, b) = s`), a pattern (`if let`,
  `match`), an index with a literal (`s[0]`), a field read (`r.x`);
- **a forward:** an argument for an `inline` parameter, the initializer
  of a `let`, which is then inline too, a returned value when the
  function's result is inline, or an arm of an `if` or `match` in one of
  these positions;
- **a discard:** an expression statement.

Anything else would box the value, and is an error at that use: storing
it in a field or an array element, passing it for a parameter that is
not inline, capturing it in a nested function, converting it with `as`,
returning it from a function whose result is boxed. `==`, `!=` and `is`
are errors too in this round: each lowers by reading the value whole,
which would box it, and comparing or testing slot by slot is not
implemented. A pattern tests an inline union's members without boxing. A boxed value may
still be passed for an inline parameter, which reads it into slots
without allocating.

The checker enforces this with one walk over each body that declares an
inline binding (`checkInlineBindingUses`), after the body is checked.
The walk classifies each reference to an inline binding by its parent
node, and reports a reference inside a nested function as a capture.
Assignability is not the place for it: `isAssignableTo` converts
between a tuple and its inline form without seeing the expression, and
a call's inline result may still be boxed where it is stored.

Inline-ness is part of a method's signature. An override, and a class
method that implements an interface's, keeps the inline-ness of each
parameter it overrides.

## Lowering tuples and unions

An inline tuple parameter is its `InlineLayout` slots, as wasm
parameters, the same slots an inline result of that type returns.

- **Signatures:** `mapParamTypeToWasmParams` expands an inline parameter
  to its slots. Every parameter list goes through it.
- **The body** binds the parameter's symbol to the `MultiValues` of its
  slot parameters (`LoweringContext.inlineBindings`). Every reader that
  takes a multi-value source (patterns, destructuring, literal index
  reads, returns, arguments for inline parameters) takes it from
  there, so nothing is boxed. An inline `let` binds its symbol to its
  initializer's `MultiValues` the same way.
- **Calls:** each argument loop asks the callee's parameter type how
  wide its argument is. An argument for an inline parameter is lowered
  as a multi-value source and converted to the parameter's layout
  (`#convertInlineSlots`): a tuple literal writes its slots, an inline
  result or binding forwards its own, and a boxed tuple is read field by
  field. The arity gates count wasm values, not arguments.
- **`if` and `match`:** an inline `if` or `match` in a `let` or as an
  argument is lowered into the slots it fills. `#lowerIntoSlots` asks
  for that (`LoweringContext.resultSlots`), each arm is lowered into the
  slots, and the merge takes one block parameter per slot
  (`MergeState.slots`). A returned one instead returns from each arm
  (`returnInlineTail`). An arm block that opens a release region is not
  supported yet: the region carries one value out, and the arm has
  several.

## Lowering records

An inline record parameter is its fields in `dispatch.fields` order,
the order argument explosion uses (argument-explosion.md), with a
presence word for each optional field. Explosion adds a core beside a
function and keeps the function as a forwarder, because it has to serve
callers that hold the record boxed. An inline parameter needs no
forwarder: every caller passes the fields, so the function's own
signature takes them, and explosion skips the function.

- **The type:** `InlineRecordType` wraps the record, as
  `InlineTupleType` wraps a tuple. Assignability converts between the
  two forms, and an expression that names an inline record binding has
  the record's type, so member reads, patterns and overloads see a
  record. Only the binding's declared type keeps the wrapper, which is
  what `inlineBindingTypeOf` reads for `let q = p`.
- **The body** binds the parameter as explosion's core does, to a
  record rebuilt from its fields and recorded in `explodedRecords`.
  Every read answers from the fields, so dead code elimination deletes
  the record. An inline record `let` binds its initializer's fields
  the same way.
- **Calls:** an argument for an inline record parameter is lowered as
  fields (`#recordArgFields`): a record literal writes them, a record
  held as fields (an inline binding, or an exploded one) passes its
  own, an `if` or `match` merges its arms' fields (`MergeState.fields`),
  and a boxed record is read through its dispatch.
- **Results:** an inline record result is the fields as wasm results
  (`mapReturnTypeToWasmResults`), the convention of explosion's
  field-returning core, so the function's returns take that core's
  path: `#explodedResult` answers with the record's dispatch, and
  `#returnFields` lowers each return, merging an `if` or `match` arm by
  arm (`MergeState.fields`). A call holds the fields as the record it
  reads (`explodedRecords`), whatever kind of call it is, and builds the
  record only where a use stores it. The callee's signature says the
  result is inline: the call expression has the record's type, as a
  reference to an inline binding does.
- **Expected types:** an inline record slot expects its record, so a
  literal for it adapts to the record, and the slot is not an erased one
  for `==` (`noteRecordErasure`).

## Nested inline records

An inline record inside an inline tuple is its fields, as the tuple's
slots, the way a nested inline tuple is its elements (#515).
`nestedInlineTuple` answers for an inline record with the tuple of its
fields' types in name order (`recordFieldsTuple`), which is the order
its dispatch keeps them, so layouts, paths and conversions treat it as
a nested tuple: field `k` of the record at position `p` is the leaf
`p.k`. The places that read or write the element whole ask
`nestedInlineRecord` first:

- **Writing:** a tuple literal's element at the position is lowered as
  the record's fields (`#writeRecordLeaves`, through `#recordArgFields`).
- **Reading:** a name or a pattern bound to it, and an index with a
  literal, get a record built from the leaves and held as them
  (`boxInlineRecordAt`), so field reads take the leaves.
- **Boxing:** the boxed form of the tuple holds the boxed record
  (`boxedTupleOf`, `#buildBoxedAt`), and reading a boxed tuple into the
  inline form reads the record's fields through its dispatch
  (`#boxedLeaf`).

A tuple literal passes an inline binding on when its element's position
is inline (`tupleElementUse`), for a nested inline tuple too.

A nested inline record with optional fields is an error, since its
presence words have no position in a tuple of the fields' types.

## Nested inline unions

An inline union inside an inline tuple is distributed (#811):
`inline (A, B | C)` lays out as `inline (A, B) | (A, C)`. `inlineLayoutOf`
expands each member as written (`distributeInlineUnions`) and lays out
the expanded members as before, so slots stay keyed by path and wasm
type and the members share them. `InlineLayout.written` keeps, for each
member, the member as written, which is what its boxed form is built
as: `(A, B | C)` boxes to a tuple holding the boxed union.

A nested union keeps its own literal, at `p.0`, so a layout tells its
members apart by every path where they all have a literal and do not
all agree (`discriminantPaths`). `memberTest` compares the slots there
with a member's literals; boxing (`#boxInline`) and reading a position
whose slot depends on the member (`joinInlinePosition`) branch on it.
Matching a pattern or literal against the members
(`inlineMembersMatching`, `inlineMembersLike`) reaches into nested
tuples, so `(n, (true, v))` picks the members whose nested union is
`(true, _)`.

A position where the members put different tuples is a union position
(`isUnionAt`). Reading it whole gathers its slots into the nested
union's own layout and boxes that (`boxInlineUnionAt`). Writing a value
there lowers it into the nested union's slots and moves each to the
outer slot of the members that put the same member there
(`#writeNestedUnion`, `#moveNestedSlots`). Converting a boxed tuple
whose element is a boxed union unboxes the union and moves its slots
the same way (`#convertInlineSlots`).

Two nested unions of `n` and `m` members give `n * m` members. That
costs compile time only: the slots are shared.

An inline union as an inline field of an inline record is still an
error: the record's leaves are built per field, with no member to
choose between.

## Inline fields of inline records

A field of an inline record may be inline itself (#371's depth rule:
shallow, chosen per level): `inline {pos: inline Vec, id: i32}` is three
values. `inline` on a field is allowed only in the record an `inline`
applies to (`CheckerContext.inlineRecordFields`), as on an element only
inside an inline tuple. The record's boxed form boxes the field
(`boxedFormOf`, codegen's `boxedFieldType`), so its dispatch is the
boxed record's (`recordWasmFields`).

Such a record is not passed as its dispatch's fields, since an inline
field is several values. It is laid out as the tuple of its fields
(`inlineRecordFieldsLayout`, through `recordFieldsTuple`), flattened,
so its slots are its leaves:

- **Writing** a record lowers it leaf by leaf (`#recordExprLeaves`): a
  literal's properties in written order, an inline field's value into
  that field's leaves, and any other record read field by field
  (`#recordValueLeaves`), an inline field's boxed value read on into its
  leaves.
- **Reading:** a parameter, a `let` and a call's result are a record
  built from the leaves and held as them (`#heldRecordFromLeaves`), with
  an inline record field held the same way and an inline tuple field a
  boxed tuple built from its leaves. `s.pos.x` reads through both and
  takes the leaf; dead code elimination deletes what nothing stores. A
  field read gives the field's boxed form (`#fieldReadValType`), and a
  name a pattern binds to an inline field holds it boxed.

An inline field cannot be optional, since an inline value has no absent
form, nor a union, nor a record with optional fields, for the reasons a
nested one cannot.
