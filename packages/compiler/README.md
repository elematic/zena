# `compiler`

The Zena compiler, written in Zena. It parses, type-checks, and compiles Zena source code to WebAssembly (Wasm GC) and WebAssembly Text (WAT).

## Usage

### Parsing a Single File

Use `compiler/parser` to parse Zena source text into an AST (`Module`):

```zena
import { parse } from 'compiler/parser';

let ast = parse('export let answer = 42;', 'example.zena');
```

### Loading and Checking a Program

Use `compiler` (`createCompiler` and `checkCompilation`) with a `CompilerHost` to resolve imports across a module graph and type-check a program:

```zena
import {
  createCompiler, checkCompilation, buildStdlibConfig
} from 'compiler';
import { FsCompilerHost } from 'compiler/fs-host';

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

Use `compiler/compile-file` to compile an entry file on disk to a `.wasm` or `.wat` output file:

```zena
import { compileFile } from 'compiler/compile-file';

let ok = await compileFile({
  entry: 'src/main.zena',
  outPath: 'out/main.wasm',
  stdlibRoot: '/stdlib',
});
```

## Libraries

- `compiler` / `compiler/compiler` — compiler entry point (`Compiler`, `createCompiler`, `checkCompilation`, `ProgramCheckResult`)
- `compiler/compile-file` — end-to-end file compilation (`compileFile`, `CompileFileOptions`)
- `compiler/tokenizer` — lexer and token definitions (`tokenize`, `Token`, `TokenType`)
- `compiler/parser` — recursive-descent parser (`parse`, `Parser`)
- `compiler/ast` — AST node definitions (`Node`, `Module`, `Statement`, `Expression`, `TypeAnnotation`)
- `compiler/visitor` — AST traversal helpers (`walk`, `Visitor`)
- `compiler/scope` — lexical scope and symbol resolution (`ScopeBuilder`, `ScopeResult`, `Symbol`)
- `compiler/checker` — static type checker (`checkModule`, `CheckResult`)
- `compiler/semantic-model` — semantic queries over a checked module (`SemanticModel`)
- `compiler/types` — compiler type representations (`Type`, `ClassType`, `FunctionType`, `typeToString`)
- `compiler/diagnostics` — compiler diagnostics and source spans (`Diagnostic`, `DiagnosticCode`, `DiagnosticSeverity`, `SourceSpan`)
- `compiler/package-manifest` — `zena-package.json` manifest and workspace loader (`loadWorkspace`, `loadPackageMap`)
- `compiler/module-resolver` — package and relative module specifier resolution (`ModuleResolver`, `PackageConfig`)
- `compiler/library-loader` — module graph loader (`LibraryLoader`, `CompilerHost`, `SourceFile`)
- `compiler/codegen/binary-generator` — WebAssembly GC binary emitter (`BinaryGenerator`)
- `compiler/codegen/wat-generator` — WebAssembly Text (WAT) emitter (`WatGenerator`)

## License

MIT
