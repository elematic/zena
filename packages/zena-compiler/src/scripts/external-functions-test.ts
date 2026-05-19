import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {strict as assert} from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');

test('external function import and call from Node.js', async () => {
  const zenaFile = join(pkgDir, 'test-files', 'external-functions.zena');
  const wasmFile = join(pkgDir, 'test', 'external-functions.wasm');

  execSync(`mkdir -p "${dirname(wasmFile)}"`);

  execSync(
    `"${join(repoRoot, 'target', 'release', 'zena-cli')}" build "${zenaFile}" -o "${wasmFile}"`,
    {stdio: 'pipe', cwd: repoRoot},
  );

  const wasmBits = readFileSync(wasmFile);

  // Provide the imported function here
  let callCount = 0;
  const importObject = {
    env: {
      getAnswer: (n: number) => {
        callCount++;
        return n * 2;
      },
    },
  };

  const wasmModule = await WebAssembly.instantiate(wasmBits, importObject);

  const main = wasmModule.instance.exports.main as Function;
  const result = main();

  assert.equal(result, 84);
  assert.equal(callCount, 1);
});
