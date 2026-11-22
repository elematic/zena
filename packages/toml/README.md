# `zena-lang:toml`

A TOML 1.0 parser and data model written in Zena.

## Usage

```zena
import {parseToml} from 'zena-lang:toml';

let doc = parseToml('
[package]
name = "demo"
version = "0.1.0"
');
let name = doc.getTable('package')?.getString('name');
```

## Exports

- `zena-lang:toml` (`main`) — Re-exports `parseToml` and all value/error types.
- `zena-lang:toml/value` — `TomlValue` (`TomlString`, `TomlInt`, `TomlFloat`, `TomlBool`, `TomlDateTime`, `TomlArray`, `TomlTable`) and `TomlParseError`.
- `zena-lang:toml/parser` — `parseToml(input: String): TomlTable`.

## License

MIT
