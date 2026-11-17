# zena-lang:terminal

Output and questions for command-line programs written in Zena. A
command's output hangs off a line down the left edge of the terminal: the
line opens with the command's title, each step gets a marker that says how
it went, the output of other programs is indented under the step that ran
them, and the line closes with a summary. A spinner shows work in
progress, boxed notes call out what to do next, and prompts ask questions
that the user answers with the keyboard. Zebra and `zena` print with it.

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

A prompt asks on the same line. While it waits, it shows the choices,
with the one under the cursor filled in:

```
│
◆  What kind of package is it?
│  ○ Library
│  ● Command (run with zena run)
│  ○ Both
└
```

Once answered, it leaves the question and the answer:

```
│
◇  What kind of package is it?
│  Command
```

```zena
import {Choice, Prompts} from 'terminal/prompts';

export async function main(): Future<i32> {
  let prompts = new Prompts();
  if (!prompts.interactive) {
    console.error('There is no terminal to ask in: pass --kind.');
    return 1;
  }
  let kind = await prompts.select<String>('What kind of package is it?', [
    new Choice<String>('library', 'Library'),
    new Choice<String>('command', 'Command', 'run with zena run'),
    new Choice<String>('both', 'Both'),
  ]);
  return 0;
}
```

`examples/prompts.zena` asks one question of each kind:
`zena run packages/terminal/examples/prompts.zena`.

## Libraries

- `terminal/layout` — `RailLayout`: the line down the left (`┌`, `│`,
  `└`), steps with their markers (`◇` done, `◆` active, `○` idle, `▲`
  warning, `■` failed), indented blocks of another program's output, and
  boxed notes.
- `terminal/animation` — `Spinner`: a spinner (`◒`, `◐`, `◓`, `◑`) on the
  last line of the terminal, with lines printed above it.
- `terminal/prompts` — `Prompts`: `text`, `password`, `confirm`, `select`
  and `multiselect`.
- `terminal/keys` — the keys pressed in the terminal (`TerminalKeys`), and
  keys given in advance for testing prompts (`ScriptedKeys`).
- `terminal/colors` — the `Colors` palette, whether to use color
  (`shouldUseColor`), and `visibleLength`, the columns a string takes once
  its escape sequences are left out, for lining up colored text.

## Prompts

The arrow keys move the cursor in a list (and so do `h`, `j`, `k` and `l`),
space ticks a choice in a `multiselect`, `y` and `n` answer a `confirm`,
and Enter answers. Escape and Ctrl+C cancel a prompt, which then throws
`PromptCancelled`.

A prompt needs a terminal on stdin and on stdout. Where there is none,
such as in CI or when input is piped, `Prompts.interactive` is false and a
prompt throws `PromptUnavailable`. So a command checks `interactive`
before it asks, and takes the answer from a flag instead.

While a prompt asks, the terminal sends each key as it is pressed and
does not echo it. Between prompts it behaves as usual. The prompts run on
the `zena-component` target, under `zena run`, `zena-run` or another host
built on `zena-runtime`, which puts the terminal back however the program
ends.

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

The layout, its markers, the spinner and the prompts follow
[Clack](https://github.com/bombshell-dev/clack), a JavaScript library for
command-line programs.

## License

MIT
