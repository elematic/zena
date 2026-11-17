# The terminal package (For AI Agents)

`packages/terminal` is the package `zena-lang:terminal`: what a
command-line program needs to print well. Zebra and `zena` both print with
it, so a change to how output looks belongs here, once, rather than in
either program.

## Layout

- `src/colors.zena`: `shouldUseColor`, the `Colors` palette, `stripAnsi`
  and `visibleLength`.
- `src/layout.zena`: `RailLayout`, Clack's rail and step markers, log
  blocks and boxed notes.
- `src/animation.zena`: `Spinner`, and `shouldAnimate`.
- `src/output.zena`: `Output`, which prints a command's progress with the
  other three: steps on stdout, warnings and failures on stderr, and a
  spinner while it waits (`waitFor`), advanced by a timer.
- `test/terminal_test.zena`: colors, layout and animation;
  `test/output_test.zena`: `Output`, writing into strings.

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
