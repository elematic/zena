# Records across calls

Records passed to and returned from functions, methods and
constructors: as arguments, results, `super(...)` arguments, `var`s
updated through calls, and bindings passed on.

These are plain execution tests. Every one passes with or without
argument explosion (`docs/design/argument-explosion.md`), the
optimization that passes a record as its fields. Each test is aimed at
a boundary that optimization creates (a call that reaches the
exploded copy of a function or the original, a literal or a heap
record, a dispatched or a direct call, evaluation order, field
presence), so a mistake in it shows up here as a wrong result.

What shows that the optimization actually happens is the WAT tests in
`packages/zena-compiler/zena/test/zir-backend_test.zena`. While changing
`packages/zena-compiler/zena/lib/codegen/ir/explode.zena`, run this set
with:

```bash
npm run test:execution -w @zena-lang/zena-compiler -- across-calls
```
