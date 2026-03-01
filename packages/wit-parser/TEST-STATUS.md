# WIT Parser Test Status

**Last Updated**: 2026-02-26  
**Summary**: 158/210 passing (75%)

## Overview

- ✅ **All 130 error tests pass** (parse-fail/\*)
- ✅ **28 success tests pass** (produce correct JSON)
- ❌ **52 success tests fail** (JSON mismatch - categorized below)
- ⏭️ **1 test skipped** (kinds-of-deps)

## Recent Fixes

- Fixed bare resource name handling in function params (e.g., `a: r1` → `own<r1>`)
- Fixed user-defined type references (e.g., `t1` → type index instead of string)
- Added `getParamTypeRef()` for proper function type resolution
- Fixed type alias embedding (e.g., `type t = stream<u8>` embeds stream kind directly)

## Passing Success Tests (28)

| Test                               | Notes  |
| ---------------------------------- | ------ |
| async.wit                          | ✅     |
| empty.wit                          | ✅     |
| error-context.wit                  | ✅ NEW |
| functions.wit                      | ✅     |
| import-export-overlap1.wit         | ✅     |
| package-syntax1.wit                | ✅     |
| package-syntax3.wit                | ✅     |
| package-syntax4.wit                | ✅     |
| random.wit                         | ✅     |
| resources-empty.wit                | ✅     |
| resources-multiple-returns-own.wit | ✅ NEW |
| resources-multiple.wit             | ✅     |
| resources-return-own.wit           | ✅     |
| resources1.wit                     | ✅ NEW |
| same-name-import-export.wit        | ✅     |
| type-then-eof.wit                  | ✅     |
| union-fuzz-1.wit                   | ✅     |
| wasi.wit                           | ✅     |
| world-top-level-funcs.wit          | ✅     |
| comments.wit                       | ✅ NEW |

## Failing Success Tests by Category

### Category 1: Multi-file/Package Resolution (22 tests)

These tests involve multiple files or packages that need `use` statement resolution.

| Test                            | Error                          | Reason                  |
| ------------------------------- | ------------------------------ | ----------------------- |
| complex-include                 | interfaces: expected 6, got 2  | Multi-file package      |
| cross-package-resource          | interfaces: expected 2, got 1  | Cross-package reference |
| diamond1                        | interfaces: expected 2, got 1  | Multi-file package      |
| disambiguate-diamond            | interfaces: expected 4, got 2  | Multi-file package      |
| foreign-deps                    | interfaces: expected 13, got 1 | Foreign package deps    |
| foreign-deps-union              | interfaces: expected 13, got 1 | Foreign package deps    |
| foreign-interface-dep-gated.wit | packages: expected 3, got 1    | Foreign package deps    |
| foreign-world-dep-gated.wit     | packages: expected 3, got 1    | Foreign package deps    |
| ignore-files-deps               | packages: expected 2, got 1    | Multi-file package      |
| many-names                      | interfaces: expected 2, got 1  | Multi-file package      |
| multi-file                      | interfaces[1].name mismatch    | Multi-file ordering     |
| multi-file-multi-package        | interfaces: expected 8, got 0  | Multi-file + multi-pkg  |
| multi-package-deps              | interfaces: expected 4, got 2  | Multi-package deps      |
| multi-package-gated-include.wit | interfaces: expected 4, got 0  | Multi-pkg + gating      |
| multi-package-shared-deps       | interfaces: expected 5, got 2  | Multi-package deps      |
| multi-package-transitive-deps   | interfaces: expected 3, got 1  | Transitive deps         |
| name-both-resource-and-type     | interfaces: expected 2, got 1  | Multi-file package      |
| version-syntax.wit              | packages: expected 10, got 1   | Multi-package           |
| versions                        | interfaces: expected 3, got 1  | Multi-file + versions   |

### Category 2: Use Statement Resolution (7 tests)

Single-file tests that need `use` statement type resolution.

| Test                        | Error                         | Reason         |
| --------------------------- | ----------------------------- | -------------- |
| gated-use.wit               | interfaces: expected 2, got 1 | use + gating   |
| import-export-overlap2.wit  | interfaces: expected 1, got 0 | use statement  |
| shared-types.wit            | interfaces: expected 2, got 0 | use statement  |
| use-chain.wit               | types.foo missing             | use chain      |
| use.wit                     | interfaces[0].name mismatch   | use reordering |
| stress-export-elaborate.wit | types.t1 missing              | use + export   |
| unstable-resource.wit       | interfaces: expected 2, got 1 | use + gating   |

### Category 3: Type Index Ordering (8 tests)

Type indices don't match wasm-tools ordering (may need resolver pass).

| Test                          | Error                            | Reason                          |
| ----------------------------- | -------------------------------- | ------------------------------- |
| comments.wit                  | types.bar: expected 1, got 2     | Type index order                |
| maps.wit                      | docs.contents space mismatch     | Comment format (+ type indices) |
| resources.wit                 | result: expected 20, got 8       | Type index order                |
| resources1.wit                | type mismatch (number vs string) | Type ref format                 |
| streams-and-futures.wit       | type: expected 15, got 21        | Type index order                |
| types.wit                     | types.bar: expected 55, got 69   | Type index order                |
| world-top-level-resources.wit | type: expected 7, got 2          | Type index order                |
| error-context.wit             | type mismatch (number vs string) | Type ref format                 |

### Category 4: World Import/Export Resolution (7 tests)

World interface references not fully resolved.

| Test                        | Error                         | Reason                |
| --------------------------- | ----------------------------- | --------------------- |
| include-reps.wit            | exports.interface-1 missing   | World interface ref   |
| kebab-name-include-with.wit | imports.a missing             | World include with    |
| world-diamond.wit           | result type mismatch          | World type resolution |
| world-implicit-import1.wit  | interfaces: expected 3, got 1 | Implicit imports      |
| world-implicit-import2.wit  | types: expected 2, got 1      | Implicit imports      |
| world-implicit-import3.wit  | types: expected 2, got 1      | Implicit imports      |
| world-same-fields4.wit      | interfaces: expected 3, got 1 | World fields          |
| worlds-union-dedup.wit      | imports.interface-0 missing   | World interface ref   |
| worlds-with-types.wit       | types: expected 6, got 1      | World type resolution |

### Category 5: Nested Packages (5 tests)

Nested package syntax parsing or resolution.

| Test                                     | Error                         | Reason          |
| ---------------------------------------- | ----------------------------- | --------------- |
| packages-multiple-nested.wit             | interfaces: expected 5, got 1 | Nested packages |
| packages-nested-colliding-decl-names.wit | interfaces: expected 4, got 0 | Nested packages |
| packages-nested-internal-references.wit  | interfaces: expected 2, got 0 | Nested packages |
| packages-nested-with-semver.wit          | interfaces: expected 4, got 0 | Nested packages |
| packages-single-nested.wit               | interfaces: expected 2, got 0 | Nested packages |

### Category 6: Feature Gating (4 tests)

@since/@unstable attribute handling.

| Test                   | Error                          | Reason            |
| ---------------------- | ------------------------------ | ----------------- |
| feature-gates.wit      | interfaces: expected 6, got 10 | Feature filtering |
| feature-types.wit      | my-unstable: unexpected key    | Feature filtering |
| gated-include.wit      | stability missing              | Stability field   |
| since-and-unstable.wit | interfaces: expected 8, got 7  | Feature filtering |

### Category 7: Other (3 tests)

| Test                       | Error                    | Reason                    |
| -------------------------- | ------------------------ | ------------------------- |
| union-fuzz-2.wit           | types: expected 1, got 0 | Top-level type resolution |
| with-resource-as.wit       | types: expected 8, got 1 | with...as resolution      |
| world-iface-no-collide.wit | types: expected 2, got 1 | World type resolution     |

## Priority Order for Fixes

1. **Type Index Ordering** - Affects 8 tests, needed for resolver
2. **Use Statement Resolution** - Affects 7+ tests, core feature
3. **World Interface References** - Affects 7+ tests
4. **Feature Gating** - Affects 4 tests, needs filter pass
5. **Nested Packages** - Affects 5 tests
6. **Multi-file Resolution** - Affects 22 tests, largest category

## Notes

- All tests parse successfully (no crashes)
- Error detection tests (130) all pass correctly
- The failures are JSON structure mismatches, not parse failures
- Many failures are due to missing resolver/linker pass that wasm-tools performs
