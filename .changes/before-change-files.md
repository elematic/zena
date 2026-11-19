## compiler

### Added

- The compiler reads `zena-lock.json` at `lockfileVersion` 1 (`LOCKFILE_VERSION`), and refuses another version, or none.

## package-manager

### Added

- Lockfiles record `lockfileVersion` (`LOCKFILE_VERSION`, 1), and `readPins` refuses another version, or none.

## terminal

### Added

- `terminal/colors`, `terminal/layout` and `terminal/animation`: colors that follow `NO_COLOR` and `FORCE_COLOR`, Clack's rail and step markers, and its spinner.
- `terminal/prompts`: prompts that the user answers with the keyboard (`text`, `password`, `confirm`, `select` and `multiselect`), which throw `PromptCancelled` on Escape or Ctrl+C and `PromptUnavailable` where there is no terminal.
- `terminal/keys`: the keys a terminal in raw mode sends (`KeyDecoder`), read from stdin by `TerminalKeys`, or given in advance by `ScriptedKeys` for tests.
- `isTerminalStdin` in `terminal/colors`.
- `terminal/output`: `Output`, which prints a command's progress on the rail, with a spinner while it waits.

## cli

### Added

- Programs that `zena run` and `zena-run` start can put the terminal in raw mode and read keys as they are pressed (`zena:host/terminal`), which `zena-lang:terminal`'s prompts do. The terminal is put back when the program ends, however it ends.
- `zena pkg add`, `zena pkg update` and `zena pkg fetch` print their steps down a line on the left of the terminal, in color, with a spinner while they wait on the network. Warnings (`▲`) and errors (`■`) go to stderr.
- `zena pkg add` without a version takes a package's latest stable release, or its latest pre-release when it has no stable one, and says so. When it can add nothing, it says whether the package has no releases or every release is retracted.
- `zena-lock.json` records `"lockfileVersion": 1`, the version of its format, and `zena` reads only that version. A lockfile of a newer version asks for a newer `zena`.
