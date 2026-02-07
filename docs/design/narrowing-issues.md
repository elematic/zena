# Discovered Issues: Narrowing, Destructuring, and Exhaustiveness

This document tracks issues discovered during the implementation of tuple union
narrowing.

## Match Expression Issues

### 1. Exhaustiveness Checking Doesn't Understand Tuple Literal Patterns

**Priority:** High

The exhaustiveness checker doesn't recognize that tuple patterns with literals
cover their respective union members.

```zena
let getResult = (): (true, i32) | (false, never) => { ... };

return match (getResult()) {
  case (true, value): value * 2
  case (false, _): 0  // Error: Non-exhaustive match
};
```

**Expected:** The two cases should cover the union completely. **Actual:**
Reports "Non-exhaustive match. Remaining type: UnboxedTuple"

**Location:** `subtractType()` in checker doesn't handle tuple patterns with
literals.

### 2. Variable Binding in Unboxed Tuple Patterns (Match Cases)

**Priority:** High

Variables bound in unboxed tuple patterns within match cases are not accessible
in the case body.

```zena
return match (data()) {
  case (true, true, x): x + 5  // Error: Unknown identifier: x
  case _: 0
};
```

**Expected:** `x` should be bound to the third element. **Actual:** Codegen
error "Unknown identifier: x"

**Location:** `generateMatchExpression()` in codegen/expressions.ts doesn't
handle `UnboxedTuplePattern` for variable binding.

---

## If-Let / While-Let Issues

### 3. Boxed Tuples Not Supported in If-Let/While-Let

**Priority:** Medium

Codegen only supports unboxed tuple patterns `(a, b)`, not boxed tuple patterns
`[a, b]`.

```zena
let getData = (): [true, i32] | [false, string] => { ... };

if (let [true, value] = getData()) {  // Error: only supports unboxed tuple patterns
  return value * 2;
}
```

**Expected:** Should work with boxed tuples. **Actual:** "if (let ...) only
supports unboxed tuple patterns, got TuplePattern"

**Location:** `generateIfLetStatement()` in codegen/statements.ts

### 4. If-Let with Local Variables Has Type Mismatch

**Priority:** Medium

Using a local variable in if-let produces WASM type errors, while calling a
function directly works.

```zena
let result = getResult(true);
if (let (true, value) = result) {  // WASM Error: expected anyref, found i32
  return value;
}

// But this works:
if (let (true, value) = getResult(true)) {
  return value;
}
```

**Location:** `generateIfLetStatement()` or `generateLetPatternCondition()` in
codegen

---

## Narrowing Limitations

### 5. Record Union Narrowing Not Implemented

**Priority:** Medium

Record patterns don't narrow unions based on literal field values (discriminated
unions).

```zena
type Result = { kind: "success", value: i32 } | { kind: "error", message: string };

let r: Result = ...;
if (let { kind: "success", value } = r) {
  // value should be i32, but narrowing doesn't filter based on kind literal
}
```

**Current behavior:** Checks if all properties exist, creates union of property
types without filtering.

**Location:** `checkMatchPattern()` for `RecordPattern` in
checker/expressions.ts

### 6. Class Union Narrowing Not Implemented

**Priority:** Low

Similar to records, class patterns don't narrow unions based on literal field
values.

```zena
class Success { kind: "success"; value: i32; }
class Error { kind: "error"; message: string; }

let r: Success | Error = ...;
// No way to narrow based on kind field value
```

---

## Parser Issues

### 7. Function Type Returning Union of Tuples

**Priority:** Low

Parser can't handle function types that return unions of tuples.

```zena
let makeIterator = (): (() => (true, i32) | (false, never)) => { ... };
// Error: Expected type annotation or '=>'
```

**Workaround:** Use a class or interface instead of a function type.

**Location:** `#parseParenthesizedType()` in parser.ts

---

## Summary Table

| Issue                                       | Area    | Priority | Blocking?      |
| ------------------------------------------- | ------- | -------- | -------------- |
| #1 Exhaustiveness + tuple literals          | Checker | High     | Yes, for match |
| #2 Variable binding in match tuple patterns | Codegen | High     | Yes, for match |
| #3 Boxed tuples in if-let                   | Codegen | Medium   | Partial        |
| #4 If-let with local variables              | Codegen | Medium   | Partial        |
| #5 Record union narrowing                   | Checker | Medium   | No             |
| #6 Class union narrowing                    | Checker | Low      | No             |
| #7 Function type with tuple union return    | Parser  | Low      | No             |

## Related Work

The tuple narrowing implementation (completed) added:

- `narrowTupleUnionByLiteralPatterns()` - filters tuple union members based on
  literal patterns
- `getLiteralPatternType()` - extracts literal type from pattern
- `isTypeCompatibleWithLiteral()` - checks type compatibility with literal

This infrastructure could be extended for #5 and #6 (record/class narrowing).
