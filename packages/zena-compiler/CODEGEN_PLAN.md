# Self-Hosted Compiler Codegen Plan

This document tracks the implementation status of code generation features in the self-hosted Zena compiler. For architecture and design, see [self-hosted-compiler.md](../../docs/design/self-hosted-compiler.md).

## Recently Completed

- **Functions & Variables:**
  - Simple functions, function calls.
  - Dead Code Elimination (DCE) to elide unused functions.
  - Local and global variables.
  - Assignment expressions, chained assignments.
  - Optimizing assignment statements to only leave values on the stack when needed.
  - Default parameters (including referencing earlier params).
- **Control Flow:**
  - `if` statements and expressions.
  - Basic `while` and `for` loops (without iteration/pattern matching).
  - `break` and `continue`.
  - Control flow codegen and strict reachability analysis.
- **Expressions & Operators:**
  - Most binary operators.
- **Testing:**
  - Initial setup of portable execution tests in `tests/language/execution/`.
  - Execution in CI using `runList` in `run-execution-tests.ts`.

## Up Next (In suggested order)

These represent the next major milestones for the codegen phase.

### 1. Variables and Operators

- [x] Compound assignments (`+=`, `-=`, etc.)
- [x] More operators (e.g. unary operators, string concatenation deferred until classes)

### 2. Records and Tuples

- [ ] Structural compatibility and canonicalization for Records.
- [ ] `.` operator (Record member access).
- [ ] Tuples.
- [ ] Inline tuples and multi-valued returns.

### 3. Functions

- [ ] Function Overloads.
- [x] External functions.
- [x] Various compiler intrinsics.
  - [x] `@intrinsic` decorator discovery.
  - [x] Intrinsic codegen (e.g. `memory.size`, `memory.grow`, `i32.load`, etc.).
  - [ ] `__array_*` and `__byte_array_*` intrinsics.

### 4. Classes (Iterative approach)

- [ ] Basic classes with public/private fields.
- [ ] Field mutability (`var` vs `let`).
- [ ] Methods and basic `this` support.
- [ ] Virtual dispatch (vtables).
- [ ] `final` and `sealed` classes.
- [ ] Case classes.

### 5. Pattern Matching & Iteration

- [ ] Iteration (`for`/`in` loops over iterables/iterators).
- [ ] Destructuring in variable declarations.
- [ ] `if let` and `while let`.
- [ ] `for let`.
- [ ] `match()` expressions (including exhaustiveness and varying branches).

### 6. The Long Tail

- [ ] Pipelines (`|>`).
- [ ] Casts (`as`) and type tests (`is`).
- [ ] Error handling and exceptions.
- [ ] Enums (if not covered under case classes).
- [ ] Mixins.
- [ ] Type closures / Reified Generics (if applicable).

## Ongoing Maintenance

- [ ] Continually port bootstrap compiler unit tests to portable execution tests.
- [ ] Keep `runList` in `packages/zena-compiler/test-files/run-execution-tests.ts` updated with newly passing tests.
- [ ] Expand reachability and data flow analyses as more control flow constructs are added.
