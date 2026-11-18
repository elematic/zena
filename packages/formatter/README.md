# `formatter`

A code formatter for Zena source code, built on a Wadler/Prettier-style document intermediate representation (`Doc`).

## Usage

### Formatting Zena Source

```zena
import { format } from 'formatter';

let formatted = format('export function add(a:i32,b:i32):i32{return a+b;}');
```

### Building Custom Documents

You can also construct and print `Doc` trees directly using `formatter/doc` and `formatter/doc-printer`:

```zena
import { group, concat, text, line } from 'formatter/doc';
import { printDocToString, PrintOptions } from 'formatter/doc-printer';

let doc = group(concat([text('a,'), line, text('b')]));
let rendered = printDocToString(doc, new PrintOptions(80));
```

## Libraries

- `formatter` / `formatter/printer` — Zena AST printer (`format`, `printModuleToDoc`)
- `formatter/doc` — document IR builders (`Doc`, `text`, `concat`, `group`, `indent`, `line`, `softline`, `hardline`, `ifBreak`, `join`, `fill`, `lineSuffix`)
- `formatter/doc-printer` — line-breaking document renderer (`printDocToString`, `PrintOptions`)

## License

MIT
