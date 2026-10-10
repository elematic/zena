# `component-runtime/`

Not libraries. `memory.zena` here is a compilation **entry point**: the
compiler builds it on its own for the `freestanding` target and embeds
the result as a component's first core module, the one that owns linear
memory and the allocator. It is in neither standard library manifest, so
nothing can `import` it, and it has a directory of its own so that
reading `wasi/` — where it used to sit beside `zena:wasi`'s own files —
does not suggest it is part of that library.

See `memory.zena`'s own docstring,
`packages/zena-compiler/zena/lib/codegen/component-runtime.zena`, and
`docs/design/component-emission.md` §1.3.
