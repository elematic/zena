# The terminal package (For AI Agents)

`packages/terminal` is the package `zena-lang:terminal`: what a
command-line program needs to print well and to ask questions. Zebra and
`zena` both print with it, so a change to how output looks belongs here,
once, rather than in either program.

## Layout

- `src/colors.zena`: `shouldUseColor`, the `Colors` palette, `stripAnsi`
  and `visibleLength`.
- `src/layout.zena`: `RailLayout`, Clack's rail and step markers, log
  blocks and boxed notes.
- `src/animation.zena`: `Spinner`, and `shouldAnimate`.
- `src/keys.zena`: `KeyDecoder`, from the bytes a terminal sends to
  `Key`s; the `KeyInput` a prompt reads, as `TerminalKeys` (stdin in raw
  mode, through `zena:host/terminal`) and `ScriptedKeys` (for tests).
- `src/prompts.zena`: `Prompts` and its five questions. Each question is
  a private class that draws itself in a `PromptState` and answers a
  key; `Prompts.#loop` opens the keys, draws, and after each key moves
  the cursor up over the previous frame (`rowsAbove`) and draws again.
- `src/output.zena`: `Output`, which prints a command's progress with the
  layout and the spinner: steps on stdout, warnings and failures on
  stderr, and a spinner while it waits (`waitFor`), advanced by a timer.
- `examples/prompts.zena`: one of each prompt, to try in a terminal.
- `test/terminal_test.zena`: colors, layout and animation;
  `test/keys_test.zena` and `test/prompts_test.zena`: decoding, and each
  prompt answered with `ScriptedKeys`, comparing the frames drawn
  without color; `test/output_test.zena`: `Output`, writing into strings.

## Rules

- **Follow Clack.** The look is [Clack](https://github.com/bombshell-dev/clack)'s:
  its markers, its rail and its spinner frames. Add to it in the same style
  rather than inventing another.
- **Plain output when it is not a terminal.** Color and animation are off
  when stdout is not a terminal, in CI, with `TERM=dumb` and with
  `NO_COLOR`; `FORCE_COLOR` turns color on. Every function takes the
  decision as a parameter with that default, so tests pass it explicitly
  rather than depending on how the runner's stdio is attached.
- **Measure what is visible.** Pad and align with `visibleLength`, which
  skips escape sequences and counts code points, never with `length`.
  It counts a wide character (CJK, most emoji) as one column, so a frame
  holding them is redrawn a row short where it wraps.
- **Raw mode lasts one prompt.** A prompt opens its keys when it starts
  and closes them when it is answered, so between prompts Ctrl+C ends
  the program and typed text echoes. The host restores the terminal if
  the program ends in between; a prompt must still close its keys on
  every way out (`Prompts.#answer`'s `finally`).
- **Test prompts through `ScriptedKeys`** and `new Colors(false)`, and
  compare frames. A real terminal is only needed to check raw mode
  itself, which `zena-runtime`'s Rust tests do on a pseudo-terminal.
