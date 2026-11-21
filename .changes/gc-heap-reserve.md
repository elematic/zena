## cli

### Changed

- `zena` compiles with a 192 MiB reserve of garbage-collected heap, where it had none: building a small program takes about half the time it did, and so does compiling a package's tests. `ZENA_GC_RESERVE_MB` sets another size, and `0` turns the reserve off. A program that `zena run` starts still gets no reserve unless the variable is set.
- A reserve no longer makes its pages resident up front, so a large `ZENA_GC_RESERVE_MB` costs a small compile neither time nor memory.
