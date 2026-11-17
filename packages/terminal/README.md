# zena-lang:terminal

Output for command-line programs written in Zena: colors that follow
`NO_COLOR` and `FORCE_COLOR`, the layout of [Clack](https://github.com/bombshell-dev/clack)
(a rail down the left with a marker for each step), and Clack's spinner.
Zebra and `zena` print with it.

```zena
import {RailLayout, StepKind} from 'terminal/layout';

let rail = new RailLayout();
console.log(rail.intro('zena pkg add'));
console.log(rail.step(StepKind.Success, 'Resolved zena-lang:wit-parser', '0.0.1-preview.1'));
console.log(rail.outro('Done'));
```

## Libraries

- `terminal/colors` — whether to use color (`shouldUseColor`: `NO_COLOR`,
  `FORCE_COLOR`, `TERM=dumb`, and whether stdout is a terminal), the
  `Colors` palette, `stripAnsi`, and `visibleLength`, the columns a string
  takes once its escape sequences are left out.
- `terminal/layout` — `RailLayout`: the rail (`┌`, `│`, `└`), steps with
  Clack's markers (`◇`, `◆`, `○`, `▲`, `■`), indented blocks of a
  command's output, and boxed notes.
- `terminal/animation` — `Spinner`: Clack's four-frame spinner on the last
  line of an interactive terminal, with lines printed above it, and plain
  lines when output is piped or in CI.

## License

MIT
