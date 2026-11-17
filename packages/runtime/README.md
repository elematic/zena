# `@zena-lang/runtime`

JavaScript host runtime for [Zena](https://zena-lang.dev) WebAssembly-GC modules (`--target js` and `--target zena-js`).

Provides host imports (`stringImports`, `numberImports`, `urlImports`, `randomImports`, `createConsoleImports`), async host completion handles (`createHostAsync`, `createPromiseHost`), string marshalling helpers, and `instantiate` / `run` helpers with `ZenaException` stack formatting.

## Installation

```sh
npm install @zena-lang/runtime
```

## Usage

```ts
import {instantiate, run} from '@zena-lang/runtime';

const {instance} = await instantiate(wasmBytes);
const exitCode = await run(instance);
```

## License

MIT
