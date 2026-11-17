# zena-lang:terminal

Output for command-line programs written in Zena. A command's output hangs
off a line down the left edge of the terminal: the line opens with the
command's title, each step gets a marker that says how it went, the output
of other programs is indented under the step that ran them, and the line
closes with a summary. A spinner shows work in progress, and boxed notes
call out what to do next. Zebra and `zena` print with it.

```
┌  zena pkg add
│
◇  Resolved zena-lang:wit-parser 0.0.1-preview.1
│
▲  zena-lang:markdown has no stable release: using 0.0.1-preview.1
│
◇  Fetched 2 packages in 120ms
│  zena-lang:wit-parser 0.0.1-preview.1
│  zena-lang:markdown 0.0.1-preview.1
│
◇  Next ────────────────────────────────────────╮
│                                               │
│  import {parse} from 'zena-lang:wit-parser';  │
│                                               │
├───────────────────────────────────────────────╯
│
└  Added 2 packages
```

In a terminal the line and the box are gray, each marker has its own color
(`◇` green, `◆` cyan, `▲` yellow, `■` red), and the text after a step's
message is dimmed. `examples/layout.zena` prints the output above:
`zena run packages/terminal/examples/layout.zena`.

```zena
import {RailLayout, StepKind} from 'terminal/layout';

let rail = new RailLayout();
console.log(rail.intro('zena pkg add'));
console.log(rail.bar());
console.log(rail.step(StepKind.Success, 'Resolved zena-lang:wit-parser', '0.0.1-preview.1'));
console.log(rail.bar());
console.log(rail.outro('Added 2 packages'));
```

## Libraries

- `terminal/layout` — `RailLayout`: the line down the left (`┌`, `│`,
  `└`), steps with their markers (`◇` done, `◆` active, `○` idle, `▲`
  warning, `■` failed), indented blocks of another program's output, and
  boxed notes.
- `terminal/animation` — `Spinner`: a spinner (`◒`, `◐`, `◓`, `◑`) on the
  last line of the terminal, with lines printed above it.
- `terminal/colors` — the `Colors` palette, whether to use color
  (`shouldUseColor`), and `visibleLength`, the columns a string takes once
  its escape sequences are left out, for lining up colored text.

## Color and animation

Color is on when stdout is a terminal, and off when it is a pipe or a
file, so output saved to a file has no escape sequences in it. Three
environment variables change that, as they do for many command-line
programs, and the first of them that is set decides: `NO_COLOR` turns
color off, `FORCE_COLOR` turns it on (and `FORCE_COLOR=0` off), and
`TERM=dumb`, set for a terminal that cannot show color, turns it off.

The spinner draws only in a terminal, and not when `CI` is set or `TERM`
is `dumb`. Elsewhere it draws nothing, and the lines printed through it
(`writeLine`) are printed as they come.

Every function that makes one of these choices takes it as a parameter,
with the environment's answer as the default, so tests can pass it.

## Acknowledgements

The layout, its markers and the spinner follow
[Clack](https://github.com/bombshell-dev/clack), a JavaScript library for
command-line programs.

## License

MIT
