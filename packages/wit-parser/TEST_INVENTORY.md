# WIT Parser Test Inventory

**Source**: [bytecodealliance/wasm-tools](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-parser/tests/ui/)  
**Generated**: 2026-02-11  
**Status**: Porting in progress

## Porting Progress

| Category      | Ported | Total   | Status   |
| ------------- | ------ | ------- | -------- |
| Success Tests | 2      | 85      | 🚧       |
| Error Tests   | 1      | 116     | 🚧       |
| **TOTAL**     | **3**  | **201** | **1.5%** |

### Ported Tests

**Success tests:**

- [x] `empty.wit` - Empty package (minimal)
- [x] `types.wit` - All primitive and composite types

**Error tests:**

- [x] `parse-fail/bad-list.wit` - Invalid list syntax

---

## Summary

| Category                  | Success Tests | Error Tests | Total   |
| ------------------------- | ------------- | ----------- | ------- |
| Basic Types & Primitives  | 5             | 5           | 10      |
| Functions                 | 2             | 3           | 5       |
| Resources                 | 9             | 18          | 27      |
| Async/Streams/Futures     | 4             | 9           | 13      |
| Packages & Versioning     | 16            | 17          | 33      |
| Worlds                    | 14            | 7           | 21      |
| Use/Include               | 10            | 19          | 29      |
| Multi-file/Multi-package  | 9             | 7           | 16      |
| Feature Gates & Stability | 7             | 9           | 16      |
| Misc/Edge Cases           | 9             | 22          | 31      |
| **TOTAL**                 | **85**        | **116**     | **201** |

---

## Success Tests (.wit + .wit.json)

Tests that should parse successfully and produce expected JSON output.

### Basic Types & Primitives (5 tests)

| File                | Description                                                                                          | Priority |
| ------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| `types.wit`         | All primitive and composite types (lists, options, results, tuples, records, variants, enums, flags) | HIGH     |
| `maps.wit`          | Map type support                                                                                     | MEDIUM   |
| `empty.wit`         | Empty package                                                                                        | LOW      |
| `comments.wit`      | Comment handling, doc comments                                                                       | MEDIUM   |
| `type-then-eof.wit` | Type followed by EOF                                                                                 | LOW      |

### Functions (2 tests)

| File            | Description                                   | Priority |
| --------------- | --------------------------------------------- | -------- |
| `functions.wit` | Function signatures, parameters, return types | HIGH     |
| `random.wit`    | Random interface (simple function example)    | LOW      |

### Resources (9 tests)

| File                                 | Description                                                  | Priority |
| ------------------------------------ | ------------------------------------------------------------ | -------- |
| `resources.wit`                      | Resource types, methods, constructors, fallible constructors | HIGH     |
| `resources1.wit`                     | Basic resource variant                                       | HIGH     |
| `resources-empty.wit`                | Empty resource type                                          | MEDIUM   |
| `resources-multiple.wit`             | Multiple resources in one interface                          | MEDIUM   |
| `resources-return-own.wit`           | Returning own handles                                        | MEDIUM   |
| `resources-multiple-returns-own.wit` | Multiple returns with own                                    | MEDIUM   |
| `cross-package-resource/`            | Resources across packages (directory)                        | MEDIUM   |
| `name-both-resource-and-type/`       | Resource and type with same name (directory)                 | LOW      |
| `with-resource-as.wit`               | Renaming resources with methods                              | MEDIUM   |

### Async, Streams & Futures (4 tests)

| File                      | Description             | Priority |
| ------------------------- | ----------------------- | -------- |
| `async.wit`               | Async function keyword  | HIGH     |
| `streams-and-futures.wit` | Stream and future types | HIGH     |
| `error-context.wit`       | Error context types     | MEDIUM   |
| `wasi.wit`                | WASI interface example  | MEDIUM   |

### Packages & Versioning (16 tests)

| File                                       | Description                                 | Priority |
| ------------------------------------------ | ------------------------------------------- | -------- |
| `package-syntax1.wit`                      | Basic package syntax                        | HIGH     |
| `package-syntax3.wit`                      | Package syntax variant                      | HIGH     |
| `package-syntax4.wit`                      | Package syntax variant                      | HIGH     |
| `version-syntax.wit`                       | Version syntax (semver)                     | HIGH     |
| `versions/`                                | Version handling (directory)                | HIGH     |
| `packages-single-nested.wit`               | Single nested package                       | MEDIUM   |
| `packages-multiple-nested.wit`             | Multiple nested packages                    | MEDIUM   |
| `packages-nested-with-semver.wit`          | Nested packages with semver                 | MEDIUM   |
| `packages-nested-internal-references.wit`  | Internal references in nested packages      | MEDIUM   |
| `packages-nested-colliding-decl-names.wit` | Colliding declaration names                 | MEDIUM   |
| `foreign-deps/`                            | Foreign dependencies (directory)            | HIGH     |
| `foreign-deps-union/`                      | Foreign deps union (directory)              | MEDIUM   |
| `foreign-interface-dep-gated.wit`          | Gated foreign interface deps                | MEDIUM   |
| `foreign-world-dep-gated.wit`              | Gated foreign world deps                    | MEDIUM   |
| `kinds-of-deps/`                           | Different kinds of dependencies (directory) | MEDIUM   |
| `diamond1/`                                | Diamond dependency pattern (directory)      | MEDIUM   |

### Worlds (14 tests)

| File                            | Description                        | Priority |
| ------------------------------- | ---------------------------------- | -------- |
| `worlds-with-types.wit`         | World declarations with types      | HIGH     |
| `world-diamond.wit`             | Diamond pattern in worlds          | MEDIUM   |
| `world-iface-no-collide.wit`    | World and interface no collision   | MEDIUM   |
| `world-implicit-import1.wit`    | Implicit imports                   | MEDIUM   |
| `world-implicit-import2.wit`    | Implicit imports variant           | MEDIUM   |
| `world-implicit-import3.wit`    | Implicit imports variant           | MEDIUM   |
| `world-same-fields4.wit`        | Same fields in world               | LOW      |
| `world-top-level-funcs.wit`     | Top-level functions in worlds      | MEDIUM   |
| `world-top-level-resources.wit` | Top-level resources in worlds      | MEDIUM   |
| `worlds-union-dedup.wit`        | World union deduplication          | LOW      |
| `same-name-import-export.wit`   | Same name for import/export        | MEDIUM   |
| `import-export-overlap1.wit`    | Import/export overlap              | MEDIUM   |
| `import-export-overlap2.wit`    | Import/export overlap variant      | MEDIUM   |
| `disambiguate-diamond/`         | Diamond disambiguation (directory) | MEDIUM   |

### Use & Include (10 tests)

| File                              | Description                          | Priority |
| --------------------------------- | ------------------------------------ | -------- |
| `use.wit`                         | Basic use statements                 | HIGH     |
| `use-chain.wit`                   | Chained use statements               | MEDIUM   |
| `shared-types.wit`                | Shared types via use                 | MEDIUM   |
| `include-reps.wit`                | Include with reps                    | MEDIUM   |
| `kebab-name-include-with.wit`     | Include with kebab names             | MEDIUM   |
| `gated-include.wit`               | Feature-gated include                | MEDIUM   |
| `gated-use.wit`                   | Feature-gated use                    | MEDIUM   |
| `multi-package-gated-include.wit` | Multi-package gated include          | MEDIUM   |
| `complex-include/`                | Complex include patterns (directory) | MEDIUM   |
| `many-names/`                     | Many names (directory)               | LOW      |

### Multi-file & Multi-package (9 tests)

| File                             | Description                             | Priority |
| -------------------------------- | --------------------------------------- | -------- |
| `multi-file/`                    | Multiple files in package (directory)   | HIGH     |
| `multi-file-multi-package/`      | Multi-file, multi-package (directory)   | HIGH     |
| `multi-package-deps/`            | Multi-package dependencies (directory)  | HIGH     |
| `multi-package-shared-deps/`     | Shared deps across packages (directory) | MEDIUM   |
| `multi-package-transitive-deps/` | Transitive dependencies (directory)     | MEDIUM   |
| `ignore-files-deps/`             | Ignoring certain files (directory)      | LOW      |
| `simple-wasm-text.wat`           | WASM text format input                  | LOW      |
| `union-fuzz-1.wit`               | Fuzzer-generated union test             | LOW      |
| `union-fuzz-2.wit`               | Fuzzer-generated union test             | LOW      |

### Feature Gates & Stability (7 tests)

| File                          | Description                      | Priority |
| ----------------------------- | -------------------------------- | -------- |
| `feature-gates.wit`           | @since and @unstable annotations | HIGH     |
| `feature-types.wit`           | Feature-gated types              | MEDIUM   |
| `since-and-unstable.wit`      | @since and @unstable usage       | MEDIUM   |
| `unstable-resource.wit`       | Unstable resource import         | MEDIUM   |
| `stress-export-elaborate.wit` | Stress test for exports          | LOW      |

---

## Error Tests (parse-fail/)

Tests that should produce specific error messages. Files have `.wit` input and `.wit.result` expected error output.

### Syntax Errors (22 tests)

| File                          | Description                    |
| ----------------------------- | ------------------------------ |
| `alias-no-type.wit`           | Alias without type             |
| `bad-list.wit`                | Invalid list syntax            |
| `bad-list2.wit`               | Invalid fixed-length list      |
| `bad-list3.wit`               | Invalid fixed-length list      |
| `bad-list4.wit`               | Invalid fixed-length list      |
| `bad-function.wit`            | Invalid function syntax        |
| `bad-function2.wit`           | Invalid function syntax        |
| `bad-include1.wit`            | Invalid include syntax         |
| `bad-include2.wit`            | Invalid include syntax         |
| `bad-include3.wit`            | Invalid include syntax         |
| `dangling-type.wit`           | Dangling type reference        |
| `invalid-toplevel.wit`        | Invalid top-level construct    |
| `invalid-type-reference.wit`  | Invalid type reference         |
| `invalid-type-reference2.wit` | Invalid type reference         |
| `keyword.wit`                 | Keyword as identifier          |
| `missing-package.wit`         | Missing package declaration    |
| `empty-enum.wit`              | Empty enum (not allowed)       |
| `empty-variant1.wit`          | Empty variant (not allowed)    |
| `old-float-types.wit`         | Old float type syntax          |
| `unterminated-string.wit`     | Unterminated string literal    |
| `map-invalid-key.wit`         | Invalid map key type           |
| `very-large-column.wit`       | Very long line error rendering |

### Resource Errors (18 tests)

| File                           | Description                                  |
| ------------------------------ | -------------------------------------------- |
| `bad-resource1.wit`            | Invalid resource syntax                      |
| `bad-resource2.wit`            | Invalid resource syntax                      |
| `bad-resource3.wit`            | Invalid resource syntax                      |
| `bad-resource4.wit`            | Invalid resource syntax                      |
| `bad-resource5.wit`            | Invalid resource syntax                      |
| `bad-resource6.wit`            | Invalid resource syntax                      |
| `bad-resource7.wit`            | Invalid resource syntax                      |
| `bad-resource8.wit`            | Invalid resource syntax                      |
| `bad-resource9.wit`            | Invalid static function                      |
| `bad-resource10.wit`           | Invalid resource syntax                      |
| `bad-resource11.wit`           | Invalid resource syntax                      |
| `bad-resource12.wit`           | Invalid resource syntax                      |
| `bad-resource13.wit`           | Invalid resource syntax                      |
| `bad-resource14.wit`           | Invalid resource syntax                      |
| `bad-resource15/`              | Invalid resource (directory)                 |
| `bad-resource16.wit`           | Invalid fallible constructor                 |
| `bad-resource17.wit`           | Invalid fallible constructor                 |
| `type-and-resource-same-name/` | Type and resource name collision (directory) |

### Return Borrow Errors (10 tests)

| File                                    | Description                     |
| --------------------------------------- | ------------------------------- |
| `resources-return-borrow.wit`           | Disallowed return of borrow     |
| `resources-multiple-returns-borrow.wit` | Multiple returns with borrow    |
| `return-borrow1.wit`                    | Return borrow error             |
| `return-borrow2.wit`                    | Return borrow error             |
| `return-borrow3.wit`                    | Return borrow error             |
| `return-borrow4.wit`                    | Return borrow error             |
| `return-borrow5.wit`                    | Return borrow error             |
| `return-borrow6.wit`                    | Return borrow error             |
| `return-borrow7.wit`                    | Return borrow error             |
| `return-borrow8/`                       | Return borrow error (directory) |

### Package Errors (17 tests)

| File                                          | Description                           |
| --------------------------------------------- | ------------------------------------- |
| `bad-pkg1/`                                   | Invalid package (directory)           |
| `bad-pkg2/`                                   | Invalid package (directory)           |
| `bad-pkg3/`                                   | Invalid package (directory)           |
| `bad-pkg4/`                                   | Invalid package (directory)           |
| `bad-pkg5/`                                   | Invalid package (directory)           |
| `bad-pkg6/`                                   | Invalid package (directory)           |
| `conflicting-package/`                        | Conflicting package names (directory) |
| `pkg-cycle/`                                  | Package cycle (directory)             |
| `pkg-cycle2/`                                 | Package cycle (directory)             |
| `missing-main-declaration-initial-main.wit`   | Missing main declaration              |
| `missing-main-declaration-initial-nested.wit` | Missing main in nested                |
| `multiple-package-docs/`                      | Multiple package docs (directory)     |
| `multiple-packages-no-scope-blocks.wit`       | Multiple packages without scope       |
| `multiple-package-inline-cycle.wit`           | Inline package cycle                  |
| `nested-packages-colliding-names.wit`         | Nested package name collision         |
| `nested-packages-with-error.wit`              | Nested packages with error            |
| `very-nested-packages.wit`                    | Very deeply nested packages           |

### Duplicate/Conflict Errors (10 tests)

| File                              | Description                     |
| --------------------------------- | ------------------------------- |
| `duplicate-functions.wit`         | Duplicate function names        |
| `duplicate-function-params.wit`   | Duplicate parameter names       |
| `duplicate-interface.wit`         | Duplicate interface             |
| `duplicate-interface2/`           | Duplicate interface (directory) |
| `duplicate-type.wit`              | Duplicate type name             |
| `import-twice.wit`                | Import same thing twice         |
| `export-twice.wit`                | Export same thing twice         |
| `use-conflict.wit`                | Use statement conflict          |
| `use-conflict2.wit`               | Use statement conflict          |
| `use-conflict3.wit`               | Use statement conflict          |
| `case-insensitive-duplicates.wit` | Case-insensitive name collision |

### Import/Export Errors (7 tests)

| File                     | Description                 |
| ------------------------ | --------------------------- |
| `import-and-export1.wit` | Import/export conflict      |
| `import-and-export2.wit` | Import/export conflict      |
| `import-and-export3.wit` | Import/export conflict      |
| `import-and-export4.wit` | Import/export conflict      |
| `import-and-export5.wit` | Import/export conflict      |
| `unknown-interface.wit`  | Unknown interface reference |
| `undefined-typed.wit`    | Undefined type              |

### Unresolved Reference Errors (19 tests)

| File                        | Description                          |
| --------------------------- | ------------------------------------ |
| `unresolved-use1.wit`       | Unresolved use                       |
| `unresolved-use2.wit`       | Unresolved use                       |
| `unresolved-use3.wit`       | Unresolved use                       |
| `unresolved-use7.wit`       | Unresolved use                       |
| `unresolved-use8.wit`       | Unresolved use                       |
| `unresolved-use9.wit`       | Unresolved use                       |
| `unresolved-use10/`         | Unresolved use (directory)           |
| `unresolved-interface1.wit` | Unresolved interface                 |
| `unresolved-interface2.wit` | Unresolved interface                 |
| `unresolved-interface3.wit` | Unresolved interface                 |
| `unresolved-interface4.wit` | Unresolved interface                 |
| `no-access-to-sibling-use/` | No access to sibling use (directory) |
| `use-shadow1.wit`           | Use shadowing error                  |
| `use-cycle1.wit`            | Use cycle                            |
| `use-cycle4.wit`            | Use cycle                            |
| `cycle.wit`                 | Type cycle                           |
| `cycle2.wit`                | Type cycle                           |
| `cycle3.wit`                | Type cycle                           |
| `cycle4.wit`                | Type cycle                           |
| `cycle5.wit`                | Type cycle                           |

### World Errors (7 tests)

| File                        | Description                      |
| --------------------------- | -------------------------------- |
| `bad-world-type1.wit`       | Invalid world type               |
| `world-interface-clash.wit` | World/interface name clash       |
| `world-same-fields2.wit`    | Same fields in world             |
| `world-same-fields3.wit`    | Same fields in world             |
| `world-top-level-func.wit`  | Invalid top-level func in world  |
| `world-top-level-func2.wit` | Invalid top-level func in world  |
| `use-world/`                | Invalid use of world (directory) |

### Include Errors (9 tests)

| File                               | Description                                 |
| ---------------------------------- | ------------------------------------------- |
| `include-cycle.wit`                | Include cycle                               |
| `include-foreign/`                 | Foreign include (directory)                 |
| `include-with-id.wit`              | Include with ID error                       |
| `include-with-on-id.wit`           | Include with on ID error                    |
| `kebab-name-include.wit`           | Kebab name include error                    |
| `kebab-name-include-not-found.wit` | Kebab include not found                     |
| `use-and-include-world/`           | Use and include world (directory)           |
| `non-existance-world-include/`     | Non-existent world include (directory)      |
| `multi-package-deps-share-nest/`   | Multi-package deps share nested (directory) |

### Feature Gate Errors (9 tests)

| File                  | Description          |
| --------------------- | -------------------- |
| `bad-gate1.wit`       | Invalid feature gate |
| `bad-gate2.wit`       | Invalid feature gate |
| `bad-gate3.wit`       | Invalid feature gate |
| `bad-gate4.wit`       | Invalid feature gate |
| `bad-gate5.wit`       | Invalid feature gate |
| `bad-since1.wit`      | Invalid @since       |
| `bad-since3.wit`      | Invalid @since       |
| `bad-deprecated1.wit` | Invalid @deprecated  |
| `bad-deprecated2.wit` | Invalid @deprecated  |
| `bad-deprecated3.wit` | Invalid @deprecated  |
| `bad-deprecated4.wit` | Invalid @deprecated  |

### Async Errors (9 tests)

| File                   | Description            |
| ---------------------- | ---------------------- |
| `async.wit`            | Old async syntax       |
| `async1.wit`           | Old async syntax       |
| `async-bad1.wit`       | Invalid async usage    |
| `async-bad2.wit`       | Invalid async usage    |
| `async-bad-world.wit`  | Invalid async in world |
| `async-bad-world2.wit` | Invalid async in world |
| `async-bad-world3.wit` | Invalid async in world |
| `async-bad-world4.wit` | Invalid async in world |

### Multi-file Errors (1 test)

| File                            | Description                                 |
| ------------------------------- | ------------------------------------------- |
| `multi-file-missing-delimiter/` | Missing delimiter in multi-file (directory) |

---

## Directory Tests

These tests use directories containing multiple `.wit` files instead of a single file.

### Success Directories (17)

```
complex-include/
cross-package-resource/
diamond1/
disambiguate-diamond/
foreign-deps/
foreign-deps-union/
ignore-files-deps/
kinds-of-deps/
many-names/
multi-file/
multi-file-multi-package/
multi-package-deps/
multi-package-shared-deps/
multi-package-transitive-deps/
name-both-resource-and-type/
versions/
```

### Error Directories (24)

```
bad-pkg1/
bad-pkg2/
bad-pkg3/
bad-pkg4/
bad-pkg5/
bad-pkg6/
bad-resource15/
conflicting-package/
duplicate-interface2/
include-foreign/
multi-file-missing-delimiter/
multi-package-deps-share-nest/
multiple-package-docs/
no-access-to-sibling-use/
non-existance-world-include/
pkg-cycle/
pkg-cycle2/
return-borrow8/
type-and-resource-same-name/
unresolved-use10/
use-and-include-world/
use-world/
```

---

## Porting Plan

### Phase 1: Core Types (Priority: HIGH) - 10 tests

Port first to establish the basic parser:

1. `empty.wit` - Minimal valid package
2. `types.wit` - All primitive and composite types
3. `functions.wit` - Function signatures
4. `resources.wit` - Resource types
5. `package-syntax1.wit` - Basic package syntax
6. `use.wit` - Basic use statements
7. `worlds-with-types.wit` - World declarations
8. `async.wit` - Async functions
9. `feature-gates.wit` - Stability annotations
10. `multi-file/` - Multi-file packages

### Phase 2: Advanced Features (Priority: MEDIUM) - 30 tests

Remaining success tests for full coverage.

### Phase 3: Error Cases (Priority: MEDIUM) - 116 tests

All parse-fail tests for error handling validation.

---

## Notes

### File Formats

- **Success tests**: `.wit` file + `.wit.json` expected output
- **Error tests**: `.wit` file + `.wit.result` expected error message
- **Directory tests**: Folder with multiple `.wit` files + single `.wit.json` or `.wit.result`

### Special Cases

- `simple-wasm-text.wat` - WASM text format input (tests WASM-encoded WIT)
- `wasi.wit` - Real-world WASI interface definitions
- `union-fuzz-*.wit` - Fuzzer-generated edge cases

### Test Runner Requirements

1. Support both single-file and directory tests
2. Parse JSON output for comparison
3. Match error messages for parse-fail tests
4. Handle `.wat` (WASM text) input files
