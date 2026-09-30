/**
 * Tests for `zena lsp`, the language server in the zena command: the real
 * `zena-cli` process, spoken to over its stdin and stdout the way an
 * editor does.
 *
 * `server_test.zena` covers the server's parts in Zena; this covers what
 * only the process has: reading framed messages from stdin, writing them
 * to stdout with nothing else mixed in, and exiting when told to.
 */

import {suite, test} from 'node:test';
import assert from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const zenaCli = resolve(__dirname, '../../../target/release/zena-cli');

type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {code: number; message: string};
};

const frame = (message: object): Buffer => {
  const body = Buffer.from(JSON.stringify({jsonrpc: '2.0', ...message}));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
};

/** Takes stdout apart into messages; fails on anything unframed. */
const unframe = (out: Buffer): Message[] => {
  const messages: Message[] = [];
  let rest = out;
  while (rest.length > 0) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    assert.ok(headerEnd > 0, `unframed output: ${rest.toString()}`);
    const header = rest.subarray(0, headerEnd).toString();
    const match = /Content-Length: (\d+)/i.exec(header);
    assert.ok(match, `no Content-Length in ${header}`);
    const length = Number(match[1]);
    const body = rest.subarray(headerEnd + 4, headerEnd + 4 + length);
    messages.push(JSON.parse(body.toString()) as Message);
    rest = rest.subarray(headerEnd + 4 + length);
  }
  return messages;
};

/** Runs `zena-cli lsp` on a whole session's input and reads its output. */
const session = (messages: object[]) => {
  const run = spawnSync(zenaCli, ['lsp'], {
    input: Buffer.concat(messages.map(frame)),
    timeout: 120_000,
  });
  return {status: run.status, messages: unframe(run.stdout), stderr: run.stderr.toString()};
};

suite('zena lsp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zena-lsp-'));
  const path = join(dir, 'main.zena');
  const text = [
    '/** Adds one. */',
    'let addOne = (a: i32): i32 => a + 1;',
    '',
    'export let main = (): i32 => {',
    "  let value = 'é'.length + addOne(41);",
    "  let wrong: String = 'é' + 1;",
    '  return value;',
    '};',
    '',
  ].join('\n');
  writeFileSync(path, text);
  const uri = `file://${path}`;

  test('answers a session and exits with status 0', () => {
    const {status, messages, stderr} = session([
      {id: 1, method: 'initialize', params: {capabilities: {}}},
      {method: 'initialized', params: {}},
      {
        method: 'textDocument/didOpen',
        params: {textDocument: {uri, languageId: 'zena', version: 1, text}},
      },
      // The start of `addOne` in `addOne(41)`: UTF-16 character 27, byte
      // 28, since 'é' is one unit and two bytes. Read as a byte offset,
      // 27 is the space before it, and there would be nothing to hover.
      {
        id: 2,
        method: 'textDocument/hover',
        params: {textDocument: {uri}, position: {line: 4, character: 27}},
      },
      {
        id: 3,
        method: 'textDocument/definition',
        params: {textDocument: {uri}, position: {line: 4, character: 27}},
      },
      {id: 4, method: 'shutdown'},
      {method: 'exit'},
    ]);
    assert.strictEqual(status, 0, stderr);

    const byId = new Map(messages.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
    const init = byId.get(1)?.result as {capabilities: Record<string, unknown>};
    assert.strictEqual(init.capabilities.hoverProvider, true);

    const published = messages.find((m) => m.method === 'textDocument/publishDiagnostics');
    assert.ok(published, 'no diagnostics were published');
    const diagnostics = published.params!.diagnostics as {range: {start: {line: number}}}[];
    assert.ok(diagnostics.length >= 1);
    assert.strictEqual(diagnostics[0].range.start.line, 5);

    const hover = byId.get(2)?.result as {contents: {value: string}};
    assert.match(hover.contents.value, /addOne/);
    assert.match(hover.contents.value, /Adds one\./);

    const definition = byId.get(3)?.result as {uri: string; range: {start: {line: number; character: number}}};
    assert.strictEqual(definition.uri, uri);
    assert.deepStrictEqual(definition.range.start, {line: 1, character: 4});

    assert.strictEqual(byId.get(4)?.result, null);
  });

  test('ends when its input ends', () => {
    const {status, messages} = session([
      {id: 1, method: 'initialize', params: {capabilities: {}}},
    ]);
    assert.strictEqual(status, 0);
    assert.strictEqual(messages.length, 1);
  });
});
