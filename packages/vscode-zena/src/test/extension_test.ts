/**
 * End-to-end tests for the packaged `vscode-zena` extension.
 *
 * Packages the extension into a `.vsix`, extracts it into a temporary
 * directory outside the monorepo (with no `node_modules` or `packages/stdlib`
 * on disk), loads the bundled CommonJS entrypoint against an in-memory
 * `vscode` host stub using `vscode-vfs://` URIs, and exercises activation,
 * diagnostics, lint quick-fixes, formatting, hover, completions, document
 * symbols, workspace Go-to-Definition, and `zena-stdlib:` virtual stdlib
 * documents.
 */

import {suite, test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, posix, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';

/** Extracts a standard `.vsix` (ZIP) archive using Node's built-in `zlib`. */
function extractZip(zipPath: string, destDir: string): void {
  const buf = readFileSync(zipPath);
  // Locate End of Central Directory record (0x06054b50) from the end of file.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, `Invalid ZIP archive (missing EOCD): ${zipPath}`);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < totalEntries; n++) {
    assert.strictEqual(buf.readUInt32LE(cdOffset), 0x02014b50);
    const method = buf.readUInt16LE(cdOffset + 10);
    const compressedSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const entryName = buf
      .subarray(cdOffset + 46, cdOffset + 46 + nameLen)
      .toString('utf8');
    cdOffset += 46 + nameLen + extraLen + commentLen;

    const outPath = resolve(destDir, entryName);
    assert.ok(
      outPath === destDir || outPath.startsWith(destDir + '/'),
      `Unsafe ZIP path: ${entryName}`,
    );
    if (entryName.endsWith('/')) {
      mkdirSync(outPath, {recursive: true});
      continue;
    }

    assert.strictEqual(buf.readUInt32LE(localHeaderOffset), 0x04034b50);
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawData = buf.subarray(dataStart, dataStart + compressedSize);
    const content =
      method === 0
        ? rawData
        : method === 8
          ? inflateRawSync(rawData)
          : assert.fail(`Unsupported ZIP compression method ${method}`);

    mkdirSync(dirname(outPath), {recursive: true});
    writeFileSync(outPath, content);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = existsSync(join(__dirname, '..', 'package.json'))
  ? resolve(__dirname, '..')
  : resolve(__dirname, '..', '..');
const vsceBin = resolve(pkgRoot, '../../node_modules/.bin/vsce');

class MockPosition {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
  translate(lineDelta = 0, characterDelta = 0): MockPosition {
    return new MockPosition(
      this.line + lineDelta,
      this.character + characterDelta,
    );
  }
  isEqual(other: MockPosition): boolean {
    return this.line === other.line && this.character === other.character;
  }
}

class MockRange {
  readonly start: MockPosition;
  readonly end: MockPosition;
  constructor(
    startOrLine: MockPosition | number,
    endOrChar: MockPosition | number,
    endLine?: number,
    endChar?: number,
  ) {
    if (typeof startOrLine === 'number') {
      this.start = new MockPosition(startOrLine, endOrChar as number);
      this.end = new MockPosition(endLine!, endChar!);
    } else {
      this.start = startOrLine;
      this.end = endOrChar as MockPosition;
    }
  }
  contains(other: MockPosition | MockRange): boolean {
    const start = other instanceof MockRange ? other.start : other;
    const end = other instanceof MockRange ? other.end : other;
    const afterStart =
      start.line > this.start.line ||
      (start.line === this.start.line &&
        start.character >= this.start.character);
    const beforeEnd =
      end.line < this.end.line ||
      (end.line === this.end.line && end.character <= this.end.character);
    return afterStart && beforeEnd;
  }
  intersection(other: MockRange): MockRange | undefined {
    const start =
      this.start.line > other.start.line ||
      (this.start.line === other.start.line &&
        this.start.character > other.start.character)
        ? this.start
        : other.start;
    const end =
      this.end.line < other.end.line ||
      (this.end.line === other.end.line &&
        this.end.character < other.end.character)
        ? this.end
        : other.end;
    if (
      start.line > end.line ||
      (start.line === end.line && start.character > end.character)
    ) {
      return undefined;
    }
    return new MockRange(start, end);
  }
}

class MockUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  constructor(scheme: string, authority: string, path: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
  }
  get fsPath(): string {
    return this.path;
  }
  with(change: {scheme?: string; authority?: string; path?: string}): MockUri {
    return new MockUri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
    );
  }
  toString(): string {
    return this.authority
      ? `${this.scheme}://${this.authority}${this.path}`
      : `${this.scheme}:${this.path}`;
  }
  static file(p: string): MockUri {
    return new MockUri('file', '', p.startsWith('/') ? p : '/' + p);
  }
  static from(components: {
    scheme: string;
    authority?: string;
    path?: string;
  }): MockUri {
    return new MockUri(
      components.scheme,
      components.authority ?? '',
      components.path ?? '',
    );
  }
  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return base.with({path: posix.join(base.path, ...segments)});
  }
  static parse(value: string): MockUri {
    const url = new URL(value);
    return new MockUri(url.protocol.replace(/:$/, ''), url.host, url.pathname);
  }
}

class MockTextDocument {
  readonly uri: MockUri;
  readonly languageId: string;
  #text: string;

  constructor(uri: MockUri, text: string, languageId = 'zena') {
    this.uri = uri;
    this.#text = text;
    this.languageId = languageId;
  }

  getText(): string {
    return this.#text;
  }

  setText(text: string): void {
    this.#text = text;
  }

  positionAt(offset: number): MockPosition {
    const clamped = Math.max(0, Math.min(offset, this.#text.length));
    let line = 0;
    let col = 0;
    for (let i = 0; i < clamped; i++) {
      if (this.#text[i] === '\n') {
        line++;
        col = 0;
      } else {
        col++;
      }
    }
    return new MockPosition(line, col);
  }

  offsetAt(position: MockPosition): number {
    let line = 0;
    let i = 0;
    while (i < this.#text.length && line < position.line) {
      if (this.#text[i] === '\n') {
        line++;
      }
      i++;
    }
    return Math.min(this.#text.length, i + position.character);
  }

  getWordRangeAtPosition(position: MockPosition): MockRange | undefined {
    const lines = this.#text.split('\n');
    const lineText = lines[position.line] ?? '';
    const wordRe = /[A-Za-z0-9_$#]+/g;
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(lineText)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return new MockRange(
          new MockPosition(position.line, start),
          new MockPosition(position.line, end),
        );
      }
    }
    return undefined;
  }
}

suite('packaged vscode-zena extension (.vsix)', () => {
  let tempDir = '';
  let extDir = '';
  let vsixPath = '';

  const vfsFiles = new Map<string, Uint8Array>();
  const textDocuments: MockTextDocument[] = [];
  const diagnosticsByUri = new Map<string, any[]>();
  const contentProviders = new Map<string, any>();
  const commands = new Map<string, (...args: any[]) => any>();
  const outputLines: string[] = [];
  const errorMessages: string[] = [];

  let definitionProvider: any;
  let hoverProvider: any;
  let formattingProvider: any;
  let symbolProvider: any;
  let codeActionsProvider: any;
  let completionProvider: any;
  let changeDocListener:
    ((e: {document: MockTextDocument}) => void) | undefined;
  let closeDocListener: ((doc: MockTextDocument) => void) | undefined;
  let configChangeListener:
    | ((e: {
        affectsConfiguration: (section: string) => boolean;
      }) => Promise<void> | void)
    | undefined;
  let activeEditor: {document: MockTextDocument} | undefined;
  let configuredTarget = 'zena-component';

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'vscode-zena-vsix-'));
    vsixPath = join(tempDir, 'vscode-zena-test.vsix');

    execFileSync(
      vsceBin,
      ['package', '--no-dependencies', '--pre-release', '-o', vsixPath],
      {cwd: pkgRoot, stdio: 'pipe'},
    );

    const extractDir = join(tempDir, 'extracted');
    extractZip(vsixPath, extractDir);
    extDir = join(extractDir, 'extension');

    // Populate extension files in our mock workspace.fs so reading `dist/lsp.wasm`
    // goes through `vscode.workspace.fs.readFile(Uri.joinPath(extensionUri, ...))`
    // exactly as it does in both Desktop and Web VS Code.
    const loadDirIntoVfs = (diskDir: string, uriBase: MockUri) => {
      for (const entry of readdirSync(diskDir, {withFileTypes: true})) {
        const full = join(diskDir, entry.name);
        const childUri = MockUri.joinPath(uriBase, entry.name);
        if (entry.isDirectory()) {
          loadDirIntoVfs(full, childUri);
        } else {
          vfsFiles.set(childUri.toString(), new Uint8Array(readFileSync(full)));
        }
      }
    };
    const extensionUri = MockUri.from({
      scheme: 'vscode-vfs',
      authority: 'extension-host',
      path: '/vscode-zena',
    });
    loadDirIntoVfs(extDir, extensionUri);

    const vscodeMock = {
      Position: MockPosition,
      Range: MockRange,
      Uri: MockUri,
      DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3,
      },
      Diagnostic: class {
        range: MockRange;
        message: string;
        severity: number;
        source?: string;
        code?: string;
        constructor(range: MockRange, message: string, severity = 0) {
          this.range = range;
          this.message = message;
          this.severity = severity;
        }
      },
      StatusBarAlignment: {Left: 1, Right: 2},
      ThemeColor: class {
        id: string;
        constructor(id: string) {
          this.id = id;
        }
      },
      CodeActionKind: {
        QuickFix: {
          value: 'quickfix',
          append: (s: string) => ({value: `quickfix.${s}`}),
        },
        SourceFixAll: {
          value: 'source.fixAll',
          append: (s: string) => ({value: `source.fixAll.${s}`}),
        },
      },
      CodeAction: class {
        title: string;
        kind: any;
        edit?: any;
        diagnostics?: any[];
        constructor(title: string, kind?: any) {
          this.title = title;
          this.kind = kind;
        }
      },
      WorkspaceEdit: class {
        edits: Array<{uri: MockUri; range: MockRange; newText: string}> = [];
        replace(uri: MockUri, range: MockRange, newText: string) {
          this.edits.push({uri, range, newText});
        }
      },
      TextEdit: {
        replace: (range: MockRange, newText: string) => ({range, newText}),
      },
      MarkdownString: class {
        value = '';
        appendCodeblock(code: string, lang = '') {
          this.value += `\`\`\`${lang}\n${code}\n\`\`\`\n`;
          return this;
        }
        appendMarkdown(md: string) {
          this.value += md;
          return this;
        }
      },
      Hover: class {
        contents: any;
        range?: MockRange;
        constructor(contents: any, range?: MockRange) {
          this.contents = contents;
          this.range = range;
        }
      },
      DocumentSymbol: class {
        name: string;
        detail: string;
        kind: number;
        range: MockRange;
        selectionRange: MockRange;
        children: any[] = [];
        constructor(
          name: string,
          detail: string,
          kind: number,
          range: MockRange,
          selectionRange: MockRange,
        ) {
          this.name = name;
          this.detail = detail;
          this.kind = kind;
          this.range = range;
          this.selectionRange = selectionRange;
        }
      },
      SymbolKind: {
        File: 0,
        Module: 1,
        Namespace: 2,
        Package: 3,
        Class: 4,
        Method: 5,
        Property: 6,
        Field: 7,
        Constructor: 8,
        Enum: 9,
        Interface: 10,
        Function: 11,
        Variable: 12,
        Constant: 13,
        String: 14,
        Number: 15,
        Boolean: 16,
        Array: 17,
        Object: 18,
        Key: 19,
        Null: 20,
        EnumMember: 21,
        Struct: 22,
        Event: 23,
        Operator: 24,
        TypeParameter: 25,
      },
      CompletionItem: class {
        label: string;
        kind?: number;
        detail?: string;
        documentation?: any;
        constructor(label: string, kind?: number) {
          this.label = label;
          this.kind = kind;
        }
      },
      CompletionItemKind: {
        Text: 0,
        Method: 1,
        Function: 2,
        Constructor: 3,
        Field: 4,
        Variable: 5,
        Class: 6,
        Interface: 7,
        Module: 8,
        Property: 9,
        Unit: 10,
        Value: 11,
        Enum: 12,
        Keyword: 13,
      },
      window: {
        get activeTextEditor() {
          return activeEditor;
        },
        createOutputChannel: () => ({
          appendLine: (line: string) => outputLines.push(line),
          show: () => {},
          dispose: () => {},
        }),
        createStatusBarItem: () => ({
          text: '',
          tooltip: '',
          command: '',
          backgroundColor: undefined,
          show: () => {},
          hide: () => {},
          dispose: () => {},
        }),
        onDidChangeActiveTextEditor: () => ({dispose: () => {}}),
        showErrorMessage: (msg: string) => {
          errorMessages.push(msg);
        },
        showInformationMessage: () => {},
      },
      workspace: {
        workspaceFolders: [
          {
            name: 'demo',
            index: 0,
            uri: MockUri.from({
              scheme: 'vscode-vfs',
              authority: 'github',
              path: '/owner/repo',
            }),
          },
        ],
        get textDocuments() {
          return textDocuments;
        },
        fs: {
          readFile: async (uri: MockUri): Promise<Uint8Array> => {
            if (uri.scheme === 'file') {
              return new Uint8Array(readFileSync(uri.fsPath));
            }
            const bytes = vfsFiles.get(uri.toString());
            if (!bytes) {
              throw new Error(`FileNotFound: ${uri.toString()}`);
            }
            return bytes;
          },
          readDirectory: async (
            uri: MockUri,
          ): Promise<Array<[string, number]>> => {
            if (uri.scheme === 'file') {
              return readdirSync(uri.fsPath, {withFileTypes: true}).map((e) => [
                e.name,
                e.isDirectory() ? 2 : 1,
              ]);
            }
            const base = uri.toString().replace(/\/+$/, '') + '/';
            const entries = new Map<string, number>();
            for (const key of vfsFiles.keys()) {
              if (key.startsWith(base)) {
                const rest = key.slice(base.length);
                const slash = rest.indexOf('/');
                if (slash < 0) {
                  entries.set(rest, 1);
                } else {
                  entries.set(rest.slice(0, slash), 2);
                }
              }
            }
            if (entries.size === 0) {
              throw new Error(`FileNotFound: ${uri.toString()}`);
            }
            return [...entries.entries()].sort((a, b) =>
              a[0].localeCompare(b[0]),
            );
          },
        },
        getConfiguration: (section?: string) => ({
          get: <T>(key: string, defaultValue?: T): T => {
            if (section === 'zena' && key === 'target') {
              return configuredTarget as unknown as T;
            }
            return defaultValue as T;
          },
        }),
        onDidChangeConfiguration: (cb: any) => {
          configChangeListener = cb;
          return {dispose: () => {}};
        },
        registerTextDocumentContentProvider: (
          scheme: string,
          provider: any,
        ) => {
          contentProviders.set(scheme, provider);
          return {dispose: () => contentProviders.delete(scheme)};
        },
        onDidChangeTextDocument: (cb: any) => {
          changeDocListener = cb;
          return {dispose: () => {}};
        },
        onDidCloseTextDocument: (cb: any) => {
          closeDocListener = cb;
          return {dispose: () => {}};
        },
        onDidOpenTextDocument: () => ({dispose: () => {}}),
        applyEdit: async (edit: any) => {
          for (const item of edit.edits) {
            const doc = textDocuments.find(
              (d) => d.uri.toString() === item.uri.toString(),
            );
            if (doc) {
              const text = doc.getText();
              const start = doc.offsetAt(item.range.start);
              const end = doc.offsetAt(item.range.end);
              doc.setText(
                text.slice(0, start) + item.newText + text.slice(end),
              );
            }
          }
          return true;
        },
      },
      commands: {
        registerCommand: (id: string, fn: (...args: any[]) => any) => {
          commands.set(id, fn);
          return {dispose: () => commands.delete(id)};
        },
      },
      languages: {
        createDiagnosticCollection: () => ({
          set: (uri: MockUri, diags: any[]) => {
            diagnosticsByUri.set(uri.toString(), diags);
          },
          get: (uri: MockUri) => diagnosticsByUri.get(uri.toString()),
          delete: (uri: MockUri) => diagnosticsByUri.delete(uri.toString()),
          clear: () => diagnosticsByUri.clear(),
          dispose: () => {},
        }),
        registerDefinitionProvider: (_selector: any, provider: any) => {
          definitionProvider = provider;
          return {dispose: () => {}};
        },
        registerHoverProvider: (_selector: any, provider: any) => {
          hoverProvider = provider;
          return {dispose: () => {}};
        },
        registerDocumentFormattingEditProvider: (
          _selector: any,
          provider: any,
        ) => {
          formattingProvider = provider;
          return {dispose: () => {}};
        },
        registerDocumentSymbolProvider: (_selector: any, provider: any) => {
          symbolProvider = provider;
          return {dispose: () => {}};
        },
        registerCodeActionsProvider: (_selector: any, provider: any) => {
          codeActionsProvider = provider;
          return {dispose: () => {}};
        },
        registerCompletionItemProvider: (_selector: any, provider: any) => {
          completionProvider = provider;
          return {dispose: () => {}};
        },
      },
    };

    const Module = createRequire(import.meta.url)('node:module') as any;
    const origLoad = Module._load;
    Module._load = function (request: string, parent: any, isMain: boolean) {
      if (request === 'vscode') {
        return vscodeMock;
      }
      return origLoad.call(this, request, parent, isMain);
    };

    try {
      const manifest = JSON.parse(
        readFileSync(join(extDir, 'package.json'), 'utf8'),
      );
      const req = createRequire(join(extDir, 'package.json'));
      const entrypoint = req(manifest.main);
      await entrypoint.activate({
        extensionPath: extDir,
        extensionUri,
        subscriptions: [],
      });
    } finally {
      Module._load = origLoad;
    }
  });

  after(() => {
    if (tempDir) {
      rmSync(tempDir, {recursive: true, force: true});
    }
  });

  test('packages a self-contained web+desktop VSIX with no node:* imports', () => {
    const manifest = JSON.parse(
      readFileSync(join(extDir, 'package.json'), 'utf8'),
    );
    assert.ok(manifest.main, 'manifest declares main');
    assert.strictEqual(
      manifest.browser,
      manifest.main,
      'manifest declares matching browser entrypoint for vscode.dev',
    );
    assert.strictEqual(manifest.dependencies, undefined);
    const extEntries = readdirSync(extDir).map((e) => e.toLowerCase());
    assert.ok(
      extEntries.some((e) => e.startsWith('license')),
      'ships LICENSE',
    );
    assert.ok(extEntries.includes('changelog.md'), 'ships CHANGELOG.md');
    assert.ok(
      !existsSync(join(extDir, 'src')),
      'excludes TypeScript sources from VSIX',
    );

    const vsixManifest = readFileSync(
      join(extDir, '..', 'extension.vsixmanifest'),
      'utf8',
    );
    assert.match(
      vsixManifest,
      /Microsoft\.VisualStudio\.Code\.PreRelease/,
      'marks --pre-release property in VSIX manifest',
    );

    const bundleSource = readFileSync(join(extDir, manifest.main), 'utf8');
    assert.doesNotMatch(
      bundleSource,
      /require\(["']node:/,
      'bundle must not require node:* built-ins so it runs in Web Workers',
    );

    assert.deepStrictEqual(
      errorMessages,
      [],
      `extension activated without errors (logs: ${outputLines.join('\n')})`,
    );
  });

  test('checks stdlib and virtual workspace imports and reports type errors', async () => {
    const mathUri = MockUri.from({
      scheme: 'vscode-vfs',
      authority: 'github',
      path: '/owner/repo/math.zena',
    });
    vfsFiles.set(
      mathUri.toString(),
      new TextEncoder().encode(
        'export let add = (a: i32, b: i32): i32 => a + b;\n',
      ),
    );

    const mainUri = MockUri.from({
      scheme: 'vscode-vfs',
      authority: 'github',
      path: '/owner/repo/main.zena',
    });
    const validDoc = new MockTextDocument(
      mainUri,
      [
        "import { GrowableArray } from 'zena:core';",
        "import { add } from './math.zena';",
        'export let run = (): i32 => {',
        '  let items = new GrowableArray<i32>();',
        '  items.push(add(20, 22));',
        '  return items.length;',
        '};',
        '',
      ].join('\n'),
    );
    textDocuments.push(validDoc);
    changeDocListener!({document: validDoc});

    // Wait for async checkDocument to settle.
    await new Promise((r) => setTimeout(r, 150));

    const validDiags = (diagnosticsByUri.get(mainUri.toString()) ?? []).filter(
      (d) => d.severity === 0,
    );
    assert.deepStrictEqual(validDiags, []);

    // Introduce a type error and verify diagnostics update.
    validDoc.setText('export let broken: i32 = "not an i32";\n');
    changeDocListener!({document: validDoc});
    await new Promise((r) => setTimeout(r, 200));

    const brokenDiags = diagnosticsByUri.get(mainUri.toString()) ?? [];
    assert.ok(
      brokenDiags.some(
        (d) => d.severity === 0 && /not assignable/i.test(d.message),
      ),
      `expected type mismatch error, got ${JSON.stringify(brokenDiags)}`,
    );

    closeDocListener!(validDoc);
    textDocuments.pop();
  });

  test('provides hover, completions, formatting, symbols, and stdlib virtual definitions', async () => {
    const docUri = MockUri.from({
      scheme: 'vscode-vfs',
      authority: 'github',
      path: '/owner/repo/features.zena',
    });
    // Include a multi-byte UTF-8 comment ("—") before declarations to test
    // UTF-8 byte -> UTF-16 code-unit offset conversion.
    const source = [
      '// Multi-byte header — café 🚀',
      "import { GrowableArray } from 'zena:core';",
      '/** Adds one to `n`. */',
      'export function increment(n: i32): i32 {',
      '  let list = new GrowableArray<i32>();',
      '  list.push(n);',
      '  return n + 1;',
      '}',
      '',
    ].join('\n');
    const doc = new MockTextDocument(docUri, source);
    textDocuments.push(doc);
    activeEditor = {document: doc};
    changeDocListener!({document: doc});
    await new Promise((r) => setTimeout(r, 150));

    // 1. Hover over `increment` declaration
    const hoverPos = new MockPosition(
      3,
      source.split('\n')[3].indexOf('increment') + 2,
    );
    const hover = await hoverProvider.provideHover(doc, hoverPos);
    assert.ok(hover, 'expected hover result');
    assert.match(hover.contents.value, /\(n: i32\) => i32/);

    // 2. Document symbols (0-based VS Code SymbolKind + accurate UTF-16 ranges)
    const symbols = await symbolProvider.provideDocumentSymbols(doc);
    const fnSym = symbols.find((s: any) => s.name === 'increment');
    assert.ok(fnSym, `expected increment symbol in ${JSON.stringify(symbols)}`);
    assert.strictEqual(
      fnSym.kind,
      11, // vscode.SymbolKind.Function (0-based, whereas LSP Function is 12)
      'maps 1-based LSP SymbolKind to 0-based vscode.SymbolKind',
    );
    assert.strictEqual(fnSym.selectionRange.start.line, 3);
    assert.strictEqual(
      fnSym.selectionRange.start.character,
      source.split('\n')[3].indexOf('increment'),
    );

    // 3. Completions after `list.`
    const pushLine = 5;
    const dotCol = source.split('\n')[pushLine].indexOf('push');
    const completions = await completionProvider.provideCompletionItems(
      doc,
      new MockPosition(pushLine, dotCol),
    );
    assert.ok(
      Array.isArray(completions) &&
        completions.some((item: any) => item.label === 'push'),
      `expected push method completion, got ${JSON.stringify(completions)}`,
    );

    // 4. Go to Definition on `GrowableArray` opens `zena-stdlib:` virtual doc
    const importLine = 1;
    const gaCol = source.split('\n')[importLine].indexOf('GrowableArray') + 2;
    const defLinks = await definitionProvider.provideDefinition(
      doc,
      new MockPosition(importLine, gaCol),
    );
    assert.ok(
      Array.isArray(defLinks) && defLinks.length > 0,
      'expected definition link for GrowableArray',
    );
    const targetUri: MockUri = defLinks[0].targetUri;
    assert.strictEqual(targetUri.scheme, 'zena-stdlib');
    const stdlibProvider = contentProviders.get('zena-stdlib');
    assert.ok(stdlibProvider, 'registered zena-stdlib content provider');
    const stdlibText =
      await stdlibProvider.provideTextDocumentContent(targetUri);
    assert.ok(
      typeof stdlibText === 'string' &&
        stdlibText.includes('class GrowableArray'),
      `expected GrowableArray definition in ${targetUri.toString()}`,
    );

    // 5. Formatting
    const messyDoc = new MockTextDocument(
      MockUri.from({
        scheme: 'vscode-vfs',
        authority: 'github',
        path: '/owner/repo/messy.zena',
      }),
      'export let   answer:i32=42;\n',
    );
    const edits =
      await formattingProvider.provideDocumentFormattingEdits(messyDoc);
    assert.strictEqual(edits.length, 1);
    assert.strictEqual(edits[0].newText.trim(), 'export let answer: i32 = 42;');

    closeDocListener!(doc);
    textDocuments.pop();
  });

  test('surfaces zena-lint warnings and applies quick-fixes', async () => {
    const lintUri = MockUri.from({
      scheme: 'vscode-vfs',
      authority: 'github',
      path: '/owner/repo/lintable.zena',
    });
    const lintDoc = new MockTextDocument(
      lintUri,
      '// Multi-byte header — café 🚀\nexport var answer: i32 = 42;\n',
    );
    textDocuments.push(lintDoc);
    activeEditor = {document: lintDoc};
    changeDocListener!({document: lintDoc});
    await new Promise((r) => setTimeout(r, 150));

    const diags = diagnosticsByUri.get(lintUri.toString()) ?? [];
    const lintDiag = diags.find(
      (d) => d.source === 'zena-lint' && d.code === 'prefer-let',
    );
    assert.ok(
      lintDiag,
      `expected prefer-let diagnostic, got ${JSON.stringify(diags)}`,
    );
    assert.strictEqual(lintDiag.severity, 1); // Warning

    const actions = codeActionsProvider.provideCodeActions(
      lintDoc,
      lintDiag.range,
    );
    assert.ok(
      actions.some((a: any) => a.kind?.value === 'quickfix'),
      `expected quickfix action, got ${JSON.stringify(actions)}`,
    );
    assert.ok(
      actions.some((a: any) => a.kind?.value === 'source.fixAll.zena'),
      `expected source.fixAll.zena action, got ${JSON.stringify(actions)}`,
    );

    const fixLintCmd = commands.get('zena.fixLint');
    assert.ok(fixLintCmd, 'registered zena.fixLint command');
    await fixLintCmd();
    assert.strictEqual(
      lintDoc.getText(),
      '// Multi-byte header — café 🚀\nexport let answer = 42;\n',
    );

    closeDocListener!(lintDoc);
    textDocuments.pop();
  });

  test('defaults to zena-component: String resolves to core/string.zena with zenadocs and zena:fetch works', async () => {
    const uri = MockUri.from({
      scheme: 'vscode-vfs',
      authority: 'github',
      path: '/owner/repo/component_target.zena',
    });
    const src = [
      "import { fetch } from 'zena:fetch';",
      'export function greet(name: String): String {',
      '  let _f = fetch;',
      '  return name;',
      '}',
      '',
    ].join('\n');
    const doc = new MockTextDocument(uri, src);
    textDocuments.push(doc);
    changeDocListener!({document: doc});
    await new Promise((r) => setTimeout(r, 250));

    const errors = (diagnosticsByUri.get(uri.toString()) ?? []).filter(
      (d) => d.severity === 0,
    );
    assert.deepStrictEqual(
      errors,
      [],
      `expected zero errors for zena:fetch on zena-component, got ${JSON.stringify(errors)}`,
    );

    const strCol = src.split('\n')[1].indexOf('String') + 2;
    const hover = await hoverProvider.provideHover(
      doc,
      new MockPosition(1, strCol),
    );
    assert.ok(hover, 'expected hover on String');
    assert.match(
      hover.contents.value,
      /immutable sequence of characters/i,
      'String hover includes zenadocs',
    );

    const defs = await definitionProvider.provideDefinition(
      doc,
      new MockPosition(1, strCol),
    );
    assert.ok(
      Array.isArray(defs) && defs.length > 0,
      'expected String definition',
    );
    assert.strictEqual(defs[0].targetUri.scheme, 'zena-stdlib');
    assert.strictEqual(
      defs[0].targetUri.path,
      '/stdlib/core/string.zena',
      'String resolves to unsuffixed core/string.zena rather than string-js.zena',
    );

    closeDocListener!(doc);
    textDocuments.pop();
  });

  test('resolves workspace packages, cached zena-lock.json dependencies, and monorepo stdlib files', async () => {
    const enc = new TextEncoder();
    const putVfs = (path: string, text: string) => {
      vfsFiles.set(
        MockUri.from({
          scheme: 'vscode-vfs',
          authority: 'github',
          path,
        }).toString(),
        enc.encode(text),
      );
    };

    const cid = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaa';
    putVfs(
      '/owner/repo/zena-package.json',
      JSON.stringify({
        workspace: {packages: ['packages/*']},
      }),
    );
    putVfs(
      '/owner/repo/zena-lock.json',
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'did:plc:extpkg@1.0.0': {
            source: cid,
            dependencies: {},
          },
        },
        workspace: {
          'packages/app': {
            'ext-pkg': 'did:plc:extpkg@1.0.0',
          },
        },
      }),
    );
    putVfs(
      `/owner/repo/.zena/packages/sources/${cid}/zena-package.json`,
      JSON.stringify({
        name: 'ext-pkg',
        version: '1.0.0',
        exports: {util: {}},
      }),
    );
    putVfs(
      `/owner/repo/.zena/packages/sources/${cid}/src/util.zena`,
      '/** Helper from cached dependency. */\nexport function cachedHelper(): i32 { return 7; }\n',
    );
    putVfs(
      '/owner/repo/packages/protobuf/zena-package.json',
      JSON.stringify({
        name: 'protobuf',
        version: '0.0.1',
        exports: {runtime: {}},
      }),
    );
    putVfs(
      '/owner/repo/packages/protobuf/src/runtime.zena',
      '/** Credentials from workspace package. */\nexport class Credentials {}\n',
    );
    putVfs(
      '/owner/repo/packages/app/zena-package.json',
      JSON.stringify({
        name: 'app',
        version: '0.0.1',
        dependencies: {
          protobuf: {path: '../protobuf'},
          'ext-pkg': {did: 'did:plc:extpkg', version: '^1.0.0'},
        },
      }),
    );

    assert.ok(configChangeListener, 'registered onDidChangeConfiguration');
    await configChangeListener({
      affectsConfiguration: (s) => s === 'zena.target',
    });

    const appUri = MockUri.from({
      scheme: 'vscode-vfs',
      authority: 'github',
      path: '/owner/repo/packages/app/src/dns.zena',
    });
    const appSrc = [
      "import { Credentials } from 'protobuf/runtime';",
      "import { cachedHelper } from 'ext-pkg/util';",
      'export function check(c: Credentials, s: String): i32 {',
      '  let _ = (c, s);',
      '  return cachedHelper();',
      '}',
      '',
    ].join('\n');
    const appDoc = new MockTextDocument(appUri, appSrc);
    textDocuments.push(appDoc);
    activeEditor = {document: appDoc};
    changeDocListener!({document: appDoc});
    await new Promise((r) => setTimeout(r, 250));

    const appErrors = (diagnosticsByUri.get(appUri.toString()) ?? []).filter(
      (d) => d.severity === 0,
    );
    assert.deepStrictEqual(
      appErrors,
      [],
      `expected zero errors for workspace + cached deps, got ${JSON.stringify(appErrors)}`,
    );

    const credCol = appSrc.split('\n')[0].indexOf('Credentials') + 2;
    const credDefs = await definitionProvider.provideDefinition(
      appDoc,
      new MockPosition(0, credCol),
    );
    assert.ok(Array.isArray(credDefs) && credDefs.length > 0);
    assert.strictEqual(credDefs[0].targetUri.scheme, 'vscode-vfs');
    assert.strictEqual(
      credDefs[0].targetUri.path,
      '/owner/repo/packages/protobuf/src/runtime.zena',
    );

    const helperCol = appSrc.split('\n')[1].indexOf('cachedHelper') + 2;
    const helperDefs = await definitionProvider.provideDefinition(
      appDoc,
      new MockPosition(1, helperCol),
    );
    assert.ok(Array.isArray(helperDefs) && helperDefs.length > 0);
    assert.strictEqual(helperDefs[0].targetUri.scheme, 'vscode-vfs');
    assert.strictEqual(
      helperDefs[0].targetUri.path,
      `/owner/repo/.zena/packages/sources/${cid}/src/util.zena`,
    );

    // Populate real stdlib in `/owner/repo/packages/stdlib/zena` to simulate the Zena monorepo
    const realStdlibDir = resolve(pkgRoot, '../stdlib/zena');
    const copyStdlibToVfs = (dir: string, relBase: string) => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          copyStdlibToVfs(full, rel);
        } else if (
          entry.name.endsWith('.zena') ||
          entry.name.endsWith('.wit')
        ) {
          vfsFiles.set(
            MockUri.from({
              scheme: 'vscode-vfs',
              authority: 'github',
              path: `/owner/repo/packages/stdlib/zena/${rel}`,
            }).toString(),
            new Uint8Array(readFileSync(full)),
          );
        }
      }
    };
    copyStdlibToVfs(realStdlibDir, '');

    await configChangeListener({
      affectsConfiguration: (s) => s === 'zena.target',
    });
    await new Promise((r) => setTimeout(r, 250));

    // In the monorepo, Go to Definition on `String` opens the real workspace file!
    const strCol = appSrc.split('\n')[2].indexOf('String') + 2;
    const strDefs = await definitionProvider.provideDefinition(
      appDoc,
      new MockPosition(2, strCol),
    );
    assert.ok(Array.isArray(strDefs) && strDefs.length > 0);
    assert.strictEqual(strDefs[0].targetUri.scheme, 'vscode-vfs');
    assert.strictEqual(
      strDefs[0].targetUri.path,
      '/owner/repo/packages/stdlib/zena/core/string.zena',
    );

    closeDocListener!(appDoc);
    textDocuments.pop();
  });

  test('runs compiler in a worker_threads worker on Desktop file:// hosts and opens real dist/stdlib files', async () => {
    const desktopWorkspaceDir = join(tempDir, 'standalone-project');
    mkdirSync(desktopWorkspaceDir, {recursive: true});
    writeFileSync(
      join(desktopWorkspaceDir, 'zena-package.json'),
      JSON.stringify({name: 'standalone-app', version: '0.1.0'}, null, 2),
    );
    const desktopMainPath = join(desktopWorkspaceDir, 'main.zena');
    const desktopSrc = [
      'export function greet(name: String): String {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
    ].join('\n');
    writeFileSync(desktopMainPath, desktopSrc);

    const desktopLogs: string[] = [];
    const desktopDiags = new Map<string, any[]>();
    const desktopDocs: MockTextDocument[] = [];
    let desktopDefProvider: any;
    let desktopHoverProvider: any;
    let desktopFormatProvider: any;

    const desktopDoc = new MockTextDocument(
      MockUri.file(desktopMainPath),
      desktopSrc,
    );
    desktopDocs.push(desktopDoc);

    const desktopVscodeMock = {
      Uri: MockUri,
      Position: MockPosition,
      Range: MockRange,
      Diagnostic: class {
        range: MockRange;
        message: string;
        severity: number;
        source?: string;
        code?: string;
        constructor(range: MockRange, message: string, severity = 0) {
          this.range = range;
          this.message = message;
          this.severity = severity;
        }
      },
      DiagnosticSeverity: {Error: 0, Warning: 1, Information: 2, Hint: 3},
      StatusBarAlignment: {Left: 1, Right: 2},
      ThemeColor: class {
        id: string;
        constructor(id: string) {
          this.id = id;
        }
      },
      MarkdownString: class {
        value = '';
        appendCodeblock(code: string, lang = '') {
          this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
          return this;
        }
        appendMarkdown(md: string) {
          this.value += md;
          return this;
        }
      },
      Hover: class {
        contents: any;
        range?: MockRange;
        constructor(contents: any, range?: MockRange) {
          this.contents = contents;
          this.range = range;
        }
      },
      CompletionItem: class {
        label: string;
        kind: number;
        constructor(label: string, kind: number) {
          this.label = label;
          this.kind = kind;
        }
      },
      CompletionItemKind: {
        Method: 1,
        Function: 2,
        Variable: 5,
        Class: 6,
        Keyword: 13,
      },
      SymbolKind: {
        Class: 4,
        Method: 5,
        Property: 6,
        Constructor: 8,
        Enum: 9,
        Interface: 10,
        Function: 11,
        Variable: 12,
        EnumMember: 21,
      },
      DocumentSymbol: class {
        name: string;
        children: any[] = [];
        constructor(name: string) {
          this.name = name;
        }
      },
      CodeAction: class {
        title: string;
        constructor(title: string) {
          this.title = title;
        }
      },
      CodeActionKind: {
        QuickFix: {value: 'quickfix', append: (s: string) => ({value: s})},
        SourceFixAll: {
          value: 'source.fixAll',
          append: (s: string) => ({value: s}),
        },
      },
      WorkspaceEdit: class {
        replace() {}
      },
      TextEdit: {
        replace: (range: MockRange, newText: string) => ({range, newText}),
      },
      window: {
        activeTextEditor: {document: desktopDoc},
        createOutputChannel: () => ({
          appendLine: (line: string) => desktopLogs.push(line),
          show: () => {},
          dispose: () => {},
        }),
        createStatusBarItem: () => ({
          text: '',
          tooltip: '',
          command: undefined,
          backgroundColor: undefined,
          show: () => {},
          hide: () => {},
          dispose: () => {},
        }),
        onDidChangeActiveTextEditor: () => ({dispose: () => {}}),
        showErrorMessage: (msg: string) => desktopLogs.push(`ERR: ${msg}`),
        showInformationMessage: () => {},
      },
      workspace: {
        textDocuments: desktopDocs,
        workspaceFolders: [
          {
            uri: MockUri.file(desktopWorkspaceDir),
            name: 'standalone',
            index: 0,
          },
        ],
        fs: {
          readFile: async (uri: MockUri) =>
            new Uint8Array(readFileSync(uri.fsPath)),
          readDirectory: async (
            uri: MockUri,
          ): Promise<Array<[string, number]>> =>
            readdirSync(uri.fsPath, {withFileTypes: true}).map((e) => [
              e.name,
              e.isDirectory() ? 2 : 1,
            ]),
        },
        getConfiguration: () => ({
          get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
        }),
        onDidChangeConfiguration: () => ({dispose: () => {}}),
        registerTextDocumentContentProvider: () => ({dispose: () => {}}),
        onDidChangeTextDocument: () => ({dispose: () => {}}),
        onDidCloseTextDocument: () => ({dispose: () => {}}),
        onDidOpenTextDocument: () => ({dispose: () => {}}),
        applyEdit: async () => true,
      },
      commands: {
        registerCommand: () => ({dispose: () => {}}),
      },
      languages: {
        createDiagnosticCollection: () => ({
          set: (uri: MockUri, diags: any[]) =>
            desktopDiags.set(uri.toString(), diags),
          get: (uri: MockUri) => desktopDiags.get(uri.toString()),
          delete: (uri: MockUri) => desktopDiags.delete(uri.toString()),
          clear: () => desktopDiags.clear(),
          dispose: () => {},
        }),
        registerDefinitionProvider: (_s: any, p: any) => {
          desktopDefProvider = p;
          return {dispose: () => {}};
        },
        registerHoverProvider: (_s: any, p: any) => {
          desktopHoverProvider = p;
          return {dispose: () => {}};
        },
        registerDocumentFormattingEditProvider: (_s: any, p: any) => {
          desktopFormatProvider = p;
          return {dispose: () => {}};
        },
        registerDocumentSymbolProvider: () => ({dispose: () => {}}),
        registerCodeActionsProvider: () => ({dispose: () => {}}),
        registerCompletionItemProvider: () => ({dispose: () => {}}),
      },
    };

    const Module = createRequire(import.meta.url)('node:module') as any;
    const origLoad = Module._load;
    const manifest = JSON.parse(
      readFileSync(join(extDir, 'package.json'), 'utf8'),
    );
    const req = createRequire(join(extDir, 'package.json'));
    const resolvedEntry = req.resolve(manifest.main);
    delete req.cache[resolvedEntry];

    let desktopEntry: any;
    Module._load = function (request: string, parent: any, isMain: boolean) {
      if (request === 'vscode') {
        return desktopVscodeMock;
      }
      return origLoad.call(this, request, parent, isMain);
    };
    try {
      desktopEntry = req(manifest.main);
    } finally {
      Module._load = origLoad;
    }

    try {
      await desktopEntry.activate({
        extensionPath: extDir,
        extensionUri: MockUri.file(extDir),
        subscriptions: [],
      });

      assert.ok(
        desktopLogs.some((l) =>
          l.includes('Zena language service loaded (worker thread)'),
        ),
        `expected worker thread initialization, got logs:\n${desktopLogs.join('\n')}`,
      );

      // Wait for initial active editor check to finish on the worker thread.
      await new Promise((r) => setTimeout(r, 250));
      const errs = (desktopDiags.get(desktopDoc.uri.toString()) ?? []).filter(
        (d) => d.severity === 0,
      );
      assert.deepStrictEqual(errs, []);

      // Go to Definition on `String` opens real `<extDir>/dist/stdlib/core/string.zena`!
      const strCol = desktopSrc.indexOf('String') + 2;
      const defs = await desktopDefProvider.provideDefinition(
        desktopDoc,
        new MockPosition(0, strCol),
      );
      assert.ok(Array.isArray(defs) && defs.length > 0);
      assert.strictEqual(defs[0].targetUri.scheme, 'file');
      assert.strictEqual(
        defs[0].targetUri.fsPath,
        join(extDir, 'dist', 'stdlib', 'core', 'string.zena'),
      );

      // Hover on `String` returns zenadocs from the worker thread.
      const hover = await desktopHoverProvider.provideHover(
        desktopDoc,
        new MockPosition(0, strCol),
      );
      assert.ok(hover);
      assert.match(hover.contents.value, /immutable sequence of characters/i);

      // Formatting works asynchronously through the worker thread.
      const unformatted = new MockTextDocument(
        MockUri.file(join(desktopWorkspaceDir, 'messy.zena')),
        'export let   x:i32=1;\n',
      );
      const edits =
        await desktopFormatProvider.provideDocumentFormattingEdits(unformatted);
      assert.strictEqual(edits.length, 1);
      assert.strictEqual(edits[0].newText.trim(), 'export let x: i32 = 1;');

      // Concurrent cold-start burst of hover + definition + cancelled hover
      // shares a single check and returns valid results for all active calls.
      let helperReads = 0;
      const helperPath = join(desktopWorkspaceDir, 'helper.zena');
      writeFileSync(
        helperPath,
        '/** Multiplies `n` by two. */\nexport function twice(n: i32): i32 { return n * 2; }\n',
      );
      const origReadFile = desktopVscodeMock.workspace.fs.readFile;
      desktopVscodeMock.workspace.fs.readFile = async (uri: MockUri) => {
        if (uri.fsPath === helperPath) helperReads++;
        return origReadFile(uri);
      };

      const burstSrc = [
        "import { twice } from './helper.zena';",
        'export function compute(v: i32): i32 {',
        '  return twice(v);',
        '}',
        '',
      ].join('\n');
      const burstDoc = new MockTextDocument(
        MockUri.file(join(desktopWorkspaceDir, 'burst.zena')),
        burstSrc,
      );
      desktopDocs.push(burstDoc);
      const twiceCol = burstSrc.split('\n')[2].indexOf('twice') + 2;
      const cancelledToken = {isCancellationRequested: false};
      const burstPromises = [
        desktopHoverProvider.provideHover(
          burstDoc,
          new MockPosition(2, twiceCol),
          cancelledToken,
        ),
        desktopHoverProvider.provideHover(
          burstDoc,
          new MockPosition(2, twiceCol),
        ),
        desktopHoverProvider.provideHover(
          burstDoc,
          new MockPosition(2, twiceCol),
        ),
        desktopDefProvider.provideDefinition(
          burstDoc,
          new MockPosition(2, twiceCol),
        ),
        desktopDefProvider.provideDefinition(
          burstDoc,
          new MockPosition(2, twiceCol),
        ),
      ];
      cancelledToken.isCancellationRequested = true;

      const [cancelledHover, h1, h2, d1, d2] = await Promise.all(burstPromises);
      assert.strictEqual(
        cancelledHover,
        null,
        'cancelled hover token short-circuits cleanly',
      );
      assert.ok(h1 && /Multiplies `n` by two/.test(h1.contents.value));
      assert.ok(h2 && /Multiplies `n` by two/.test(h2.contents.value));
      assert.ok(Array.isArray(d1) && d1[0].targetUri.fsPath === helperPath);
      assert.ok(Array.isArray(d2) && d2[0].targetUri.fsPath === helperPath);
      assert.strictEqual(
        helperReads,
        1,
        `expected concurrent cold-start burst to check/read helper.zena only once, got ${helperReads}`,
      );
    } finally {
      await desktopEntry.deactivate();
    }
  });
});
