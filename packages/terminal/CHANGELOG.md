# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `terminal/colors`, `terminal/layout` and `terminal/animation`, which were `zebra/colors`, `zebra/layout` and `zebra/animation`.
- `terminal/prompts`: prompts that the user answers with the keyboard (`text`, `password`, `confirm`, `select` and `multiselect`), which throw `PromptCancelled` on Escape or Ctrl+C and `PromptUnavailable` where there is no terminal.
- `terminal/keys`: the keys a terminal in raw mode sends (`KeyDecoder`), read from stdin by `TerminalKeys`, or given in advance by `ScriptedKeys` for tests.
- `isTerminalStdin` in `terminal/colors`.
