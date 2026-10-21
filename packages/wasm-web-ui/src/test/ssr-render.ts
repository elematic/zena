/**
 * The server side of the rendering tests: `ssr/render.zena` run through
 * `zena-cli` on the `zena-cli` target, split into the sections it
 * prints. Shared by `ssr_test.ts` and `hydrate_test.ts`.
 */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const harnessUrl = new URL('../src/test/ssr/render.zena', import.meta.url);
const cliUrl = new URL('../../../target/release/zena-cli', import.meta.url);

/** Everything `render.zena` prints, by section: the cases, then the counter element's markup. */
export const renderWithZena = (): string[] => {
  const stdout = execFileSync(
    fileURLToPath(cliUrl),
    ['run', fileURLToPath(harnessUrl), '--invoke', 'main'],
    {encoding: 'utf8'},
  );
  // `--invoke` prints the entry's return value after the output.
  const lines = stdout.trimEnd().split('\n');
  if (lines.at(-1) === '0') {
    lines.pop();
  }
  return lines.join('\n').split('\n---\n');
};
