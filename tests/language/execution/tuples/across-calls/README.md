# Tuples across calls

Boxed tuples passed to and returned from functions, methods and
constructors: the tuple counterparts of
[`records/across-calls`](../../records/across-calls/README.md).

These are plain execution tests. Every one passes with or without
argument explosion (`docs/design/argument-explosion.md`), which passes
a tuple as its elements. Each test is aimed at a boundary that
optimization creates (a call that reaches the exploded copy of a
function or the original, a literal or a heap tuple, a dispatched or a
direct call, evaluation order), so a mistake in it shows up here as a
wrong result.

What shows that the optimization actually happens is the WAT tests in
`packages/zena-compiler/zena/test/zir-backend_test.zena`. While changing
`packages/zena-compiler/zena/lib/codegen/ir/explode.zena`, run this set
with:

```bash
npm run test:execution -w @zena-lang/zena-compiler -- across-calls
```
