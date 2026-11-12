# `zena-compiler`

The Zena compiler, written in Zena. It parses, type-checks, and compiles Zena source code to WebAssembly (Wasm GC) and WebAssembly Text (WAT).

## Usage

### Parsing a Single File

Use `zena-compiler/parser` to parse Zena source text into an AST (`Module`):

```zena
import { parse } from 'zena-compiler/parser';

let ast = parse('export let answer = 42;', 'example.zena');
```

### Loading and Checking a Program

Use `zena-compiler` (`createCompiler` and `checkCompilation`) with a `CompilerHost` to resolve imports across a module graph and type-check a program:

```zena
import {
  createCompiler, checkCompilation, buildStdlibConfig
} from 'zena-compiler';
import { FsCompilerHost } from 'zena-compiler/fs-host';

let stdlibRoot = '/stdlib';
let host = new FsCompilerHost(stdlibRoot);
let packages = buildStdlibConfig(stdlibRoot, 'host');
let compiler = createCompiler(host, {
  stdlibRoot,
  packages,
});

let result = await compiler.compile({
  entry: '/workspace/main.zena',
  target: 'host',
});
let checked = checkCompilation(result);
```

### Compiling a File to WebAssembly

Use `zena-compiler/compile-file` to compile an entry file on disk to a `.wasm` or `.wat` output file:

```zena
import { compileFile } from 'zena-compiler/compile-file';

let ok = await compileFile({
  entry: 'src/main.zena',
  outPath: 'out/main.wasm',
  stdlibRoot: '/stdlib',
});
```

## Libraries

- `zena-compiler` / `zena-compiler/compiler` — compiler entry point (`Compiler`, `createCompiler`, `checkCompilation`, `ProgramCheckResult`)
- `zena-compiler/compile-file` — end-to-end file compilation (`compileFile`, `CompileFileOptions`)
- `zena-compiler/tokenizer` — lexer and token definitions (`tokenize`, `Token`, `TokenType`)
- `zena-compiler/parser` — recursive-descent parser (`parse`, `Parser`)
- `zena-compiler/ast` — AST node definitions (`Node`, `Module`, `Statement`, `Expression`, `TypeAnnotation`)
- `zena-compiler/visitor` — AST traversal helpers (`walk`, `Visitor`)
- `zena-compiler/scope` — lexical scope and symbol resolution (`ScopeBuilder`, `ScopeResult`, `Symbol`)
- `zena-compiler/checker` — static type checker (`checkModule`, `CheckResult`)
- `zena-compiler/semantic-model` — semantic queries over a checked module (`SemanticModel`)
- `zena-compiler/types` — compiler type representations (`Type`, `ClassType`, `FunctionType`, `typeToString`)
- `zena-compiler/diagnostics` — compiler diagnostics and source spans (`Diagnostic`, `DiagnosticCode`, `DiagnosticSeverity`, `SourceSpan`)
- `zena-compiler/package-manifest` — `zena-package.json` manifest and workspace loader (`loadWorkspace`, `loadPackageMap`)
- `zena-compiler/module-resolver` — package and relative module specifier resolution (`ModuleResolver`, `PackageConfig`)
- `zena-compiler/library-loader` — module graph loader (`LibraryLoader`, `CompilerHost`, `SourceFile`)
- `zena-compiler/codegen/binary-generator` — WebAssembly GC binary emitter (`BinaryGenerator`)
- `zena-compiler/codegen/wat-generator` — WebAssembly Text (WAT) emitter (`WatGenerator`)

## License

MIT
