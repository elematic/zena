/**
 * `zena:url` on the js target, where `URL` wraps the host's own `URL`
 * through the `zena:host:url` imports (`urlImports`; stdlib
 * `url/url-js.zena`).
 *
 * The parser is the host's, so what these check is the wrapper: that
 * `URL.parse` and every `with*` method give the URL that JavaScript's `URL`
 * gives for the same parse or setter. The inputs are the vendored WPT
 * corpora in packages/stdlib/tests/url/wpt/, which the Zena parser is tested
 * against on the other targets.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {instantiate} from '../index.js';
import {compile} from './compile-zena.js';

const wptDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'stdlib',
  'tests',
  'url',
  'wpt',
);
const readWpt = (name: string) =>
  JSON.parse(readFileSync(join(wptDir, name), 'utf8'));

const source = `
  import { URL, URLSearchParams, fileURLToPath, pathToFileURL, URLPattern, URLPatternInit } from 'zena:url';

  let describe = (u: URL | null): String => {
    if (u == null) { return '!'; }
    let v = u as URL;
    return \`\${v.href}|\${v.protocol}|\${v.username}|\${v.password}|\${v.host()}|\` +
        \`\${v.hostname}|\${v.port}|\${v.pathname}|\${v.search}|\${v.hash}|\${v.origin()}\`;
  };

  export let parse = (input: String): String => describe(URL.parse(input));
  export let parseWithBase = (input: String, base: String): String =>
    describe(URL.parse(input, base));

  export let set = (href: String, component: String, value: String): String => {
    let parsed = URL.parse(href);
    if (parsed == null) { return '!'; }
    let u = parsed as URL;
    if (component == 'protocol') { return describe(u.withProtocol(value)); }
    if (component == 'username') { return describe(u.withUsername(value)); }
    if (component == 'password') { return describe(u.withPassword(value)); }
    if (component == 'host') { return describe(u.withHost(value)); }
    if (component == 'hostname') { return describe(u.withHostname(value)); }
    if (component == 'port') { return describe(u.withPort(value)); }
    if (component == 'pathname') { return describe(u.withPathname(value)); }
    if (component == 'search') { return describe(u.withSearch(value)); }
    if (component == 'hash') { return describe(u.withHash(value)); }
    return describe(u.withHref(value));
  };

  export let equalAndHash = (a: String, b: String): boolean => {
    let x = URL.parse(a) as URL;
    let y = URL.parse(b) as URL;
    return x == y && x.hashCode() == y.hashCode();
  };

  export let param = (href: String, name: String): String => {
    let u = URL.parse(href) as URL;
    return u.searchParams().get(name) ?? '!';
  };

  export let withParam = (href: String, name: String, value: String): String => {
    let u = URL.parse(href) as URL;
    let params = u.searchParams();
    params.set(name, value);
    return u.withSearchParams(params).href;
  };

  export let toPath = (url: String): String => fileURLToPath(url);
  export let toFileURL = (path: String): String => pathToFileURL(path);

  export let pattern = (pathname: String, baseURL: String): String => {
    let init = new URLPatternInit();
    init.pathname = pathname;
    init.baseURL = baseURL;
    let p = new URLPattern(init);
    return \`\${p.protocol}|\${p.hostname}|\${p.port}|\${p.pathname}\`;
  };
`;

/** What `describe` returns for a JavaScript `URL`. */
const describe = (u: URL | null): string =>
  u === null
    ? '!'
    : [
        u.href,
        u.protocol,
        u.username,
        u.password,
        u.host,
        u.hostname,
        u.port,
        u.pathname,
        u.search,
        u.hash,
        u.origin,
      ].join('|');

const parseJs = (input: string, base?: string): URL | null => {
  try {
    return new URL(input, base);
  } catch {
    return null;
  }
};

const setJs = (href: string, component: string, value: string) => {
  const u = parseJs(href);
  if (u === null) return '!';
  if (component === 'href') return describe(parseJs(value));
  (u as unknown as Record<string, string>)[component] = value;
  return describe(u);
};

let compiled: {wasm: Uint8Array; e: Record<string, Function>} | undefined;
const zena = async () => {
  if (compiled === undefined) {
    const wasm = compile(source, 'js');
    const res = await instantiate(wasm);
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    compiled = {wasm, e: instance.exports as Record<string, Function>};
  }
  return compiled;
};

suite('Runtime - zena:url on the js target', () => {
  test('URL comes from zena:host:url, without the Zena parser', async () => {
    const {wasm} = await zena();
    const module = new (WebAssembly.Module as any)(wasm, {
      builtins: ['js-string'],
      importedStringConstants: '_',
    }) as WebAssembly.Module;
    const imported = WebAssembly.Module.imports(module)
      .filter((i) => i.module === 'zena:host:url')
      .map((i) => i.name)
      .sort();
    assert.deepEqual(imported, ['get', 'parse', 'parseWithBase', 'with']);
  });

  test('URL.parse matches JavaScript over urltestdata.json', async () => {
    const {e} = await zena();
    let checked = 0;
    for (const c of readWpt('urltestdata.json')) {
      if (typeof c !== 'object') continue;
      const want = describe(
        c.base === null ? parseJs(c.input) : parseJs(c.input, c.base),
      );
      const got =
        c.base === null ? e.parse(c.input) : e.parseWithBase(c.input, c.base);
      assert.equal(got, want, `parse(${JSON.stringify(c.input)}, ${c.base})`);
      checked += 1;
    }
    assert.ok(checked > 800, `checked ${checked}`);
  });

  test('with* methods match JavaScript setters over setters_tests.json', async () => {
    const {e} = await zena();
    let checked = 0;
    const tests = readWpt('setters_tests.json');
    for (const component of Object.keys(tests)) {
      if (component === 'comment') continue;
      for (const c of tests[component]) {
        const want = setJs(c.href, component, c.new_value);
        const got = e.set(c.href, component, c.new_value);
        assert.equal(
          got,
          want,
          `${component} = ${JSON.stringify(c.new_value)} on ${c.href}`,
        );
        checked += 1;
      }
    }
    assert.ok(checked > 200, `checked ${checked}`);
  });

  test('equality, search params, file URLs and patterns', async () => {
    const {e} = await zena();
    assert.equal(
      e.equalAndHash('https://EXAMPLE.com:443/a/../b', 'https://example.com/b'),
      1,
    );
    assert.equal(e.param('https://x.test/?q=caf%C3%A9&n=1', 'n'), '1');
    assert.equal(
      e.withParam('https://x.test/p?a=1#f', 'b', 'two words'),
      'https://x.test/p?a=1&b=two+words#f',
    );
    assert.equal(e.toPath('file:///tmp/a%20b.txt'), '/tmp/a b.txt');
    assert.equal(e.toFileURL('/tmp/a b.txt'), 'file:///tmp/a%20b.txt');
    assert.equal(
      e.pattern('/books/:id', 'https://example.com'),
      'https|example.com||/books/:id',
    );
  });
});
