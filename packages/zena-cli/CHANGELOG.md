# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `zena pkg add` without a version takes a package's latest pre-release when it has no stable release, and says so. When it can add nothing, it says whether the package has no releases or every release is retracted.
- `zena-lock.json` records `"lockfileVersion": 1`, the version of its format, and `zena` reads only that version. Delete a lockfile an earlier `zena` wrote, which has no `lockfileVersion`, and run `zena pkg update` to write it again; a lockfile of a newer version asks for a newer `zena`.

## [0.0.1-preview.1] - 2026-11-12

### Added

- Standalone `zena` command bundling the CLI module and standard library for macOS (Apple Silicon), Linux (x86_64 and ARM64), and Windows (x86_64).
- Commands for compiling (`build`), running (`run`), testing (`test`), formatting (`fmt`), linting (`lint`), API documentation (`doc`), benchmarking (`bench`), language server (`lsp`), precompiling (`precompile`), and package management (`pkg`).
