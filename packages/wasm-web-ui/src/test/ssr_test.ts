/**
 * The elements library's server renderer against Lit's: the same
 * templates (`ssr/elements.zena`) rendered by `@lit-labs/ssr` from the
 * js-target module's results, and by `renderResult` from the `zena-cli`
 * build of the same file (`ssr/render.zena`). Hydration reads the
 * markers Lit writes, so the Zena renderer has to write the same ones.
 */
import './dom.js';
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from './compile-zena.js';
import {renderWithZena} from './ssr-render.js';

const {instantiateModule} = await import('./instantiate.js');
const {TemplateHost} = await import('../index.js');
const {render} = await import('@lit-labs/ssr');
const {collectResult} = await import('@lit-labs/ssr/lib/render-result.js');

const elementsUrl = new URL('../src/test/ssr/elements.zena', import.meta.url);
const cases = ['attributes', 'list', 'nested', 'counterView'] as const;

/** The cases rendered by `@lit-labs/ssr` from the js-target module. */
const renderWithLit = async (): Promise<string[]> => {
  const source = readFileSync(elementsUrl, 'utf8');
  const {instance} = await instantiateModule(compile(source));
  const host = new TemplateHost(instance.exports);
  const exports = instance.exports as unknown as Record<
    string,
    (...args: number[]) => object
  >;
  const outputs: string[] = [];
  for (const name of cases) {
    const ref = name === 'counterView' ? exports[name]!(7) : exports[name]!();
    outputs.push(await collectResult(render(host.result(ref))));
  }
  return outputs;
};

suite('wasm-web-ui: server rendering', () => {
  test('the Zena renderer writes what @lit-labs/ssr writes', async () => {
    const lit = await renderWithLit();
    const zena = renderWithZena();
    assert.equal(zena.length, cases.length + 1);
    cases.forEach((name, i) => {
      assert.equal(zena[i], lit[i], `case ${name}`);
    });
  });
});
