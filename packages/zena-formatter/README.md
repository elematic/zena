# `zena-formatter`

A code formatter for Zena source code, built on a Wadler/Prettier-style document intermediate representation (`Doc`).

## Usage

### Formatting Zena Source

```zena
import { format } from 'zena-formatter';

let formatted = format('export function add(a:i32,b:i32):i32{return a+b;}');
```

### Building Custom Documents

You can also construct and print `Doc` trees directly using `zena-formatter/doc` and `zena-formatter/doc-printer`:

```zena
import { group, concat, text, line } from 'zena-formatter/doc';
import { printDocToString, PrintOptions } from 'zena-formatter/doc-printer';

let doc = group(concat([text('a,'), line, text('b')]));
let rendered = printDocToString(doc, new PrintOptions(80));
```

## Libraries

- `zena-formatter` / `zena-formatter/printer` — Zena AST printer (`format`, `printModuleToDoc`)
- `zena-formatter/doc` — document IR builders (`Doc`, `text`, `concat`, `group`, `indent`, `line`, `softline`, `hardline`, `ifBreak`, `join`, `fill`, `lineSuffix`)
- `zena-formatter/doc-printer` — line-breaking document renderer (`printDocToString`, `PrintOptions`)

## License

MIT
