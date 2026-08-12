#!/usr/bin/env node
/**
 * Build the component fixtures with `--target component`, validate them,
 * and run them.
 *
 * The unit suite asserts the emitted bytes' structure; this asserts that
 * the structure is *right*, which only a validator and a runtime can
 * say. Both are needed: a component that validates but wraps the wrong
 * module passes one and fails the other.
 *
 * Needs `wasm-tools` and `wasmtime` on PATH. Both are in the dev shell
 * and in the `zena-tests` derivation `nix flake check` builds, so this
 * runs in CI rather than being quietly skipped — a skipped component
 * test would leave `--target component` unexercised end to end.
 */

import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
const outDir = join(pkgDir, 'zena', 'out', 'component');
const fixtures = join(pkgDir, 'test-files', 'component');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const NC = '\x1b[0m';

// On macOS with Nix, tool binaries land in HOST_PATH rather than PATH.
if (process.env.HOST_PATH) {
  process.env.PATH = `${process.env.HOST_PATH}:${process.env.PATH ?? ''}`;
}

const env = {
  ...process.env,
  ZENA_COMPILER_WASM: 'packages/zena-compiler/zena/out/cli-self.wasm',
};

interface Invocation {
  /** The component export to call, and its arguments, in wasmtime syntax. */
  invoke: string;
  /** The exact line wasmtime must print. */
  expect: string;
}

interface Fixture {
  name: string;
  /** WASI features wasmtime needs to supply the imports. */
  wasi: string[];
  invocations: Invocation[];
}

const FIXTURES: Fixture[] = [
  {
    name: 'scalars',
    wasi: [],
    invocations: [
      {invoke: 'main()', expect: '0'},
      // u8 and u16 in, u32 out — all three are a core i32, so this is
      // the case that would pass even with the component types wrong.
      {invoke: 'add-narrow(200, 1000)', expect: '1200'},
      {invoke: 'negate(false)', expect: 'true'},
      {invoke: 'scale(21.5)', expect: '43'},
      // Above i64::MAX: proof the boundary type is really unsigned.
      {
        invoke: 'next-big(9223372036854775807)',
        expect: '9223372036854775808',
      },
      {invoke: 'no-result(5)', expect: '()'},
    ],
  },
  {
    name: 'clock',
    wasi: ['p3=y'],
    // A real monotonic reading, so the value is not predictable; that it
    // returns at all means the host satisfied a p3 import, which a core
    // module cannot even declare.
    invocations: [{invoke: 'main()', expect: '*'}],
  },
];

mkdirSync(outDir, {recursive: true});

let failed = false;
const fail = (message: string): void => {
  console.error(`  ${RED}✗${NC} ${message}`);
  failed = true;
};

for (const fixture of FIXTURES) {
  const source = join(fixtures, `${fixture.name}.zena`);
  const out = join(outDir, `${fixture.name}.wasm`);
  console.log(`${fixture.name}.zena`);

  try {
    execFileSync(
      zenaCli,
      ['build', source, '--target', 'component', '-o', out],
      {
        stdio: 'pipe',
        cwd: repoRoot,
        env,
      },
    );
  } catch (e) {
    const err = e as {stdout?: Buffer; stderr?: Buffer};
    fail(
      `failed to build:\n${err.stdout?.toString() ?? ''}${
        err.stderr?.toString() ?? ''
      }`,
    );
    continue;
  }

  const validate = spawnSync(
    'wasm-tools',
    ['validate', '--features', 'all', out],
    {
      encoding: 'utf8',
    },
  );
  if (validate.error) {
    fail(`wasm-tools not runnable: ${validate.error.message}`);
    continue;
  }
  if (validate.status !== 0) {
    fail(`does not validate as a component:\n${validate.stderr}`);
    continue;
  }
  console.log(`  ${GREEN}✓${NC} validates`);

  for (const {invoke, expect} of fixture.invocations) {
    const args = ['run', '-W', 'gc=y,function-references=y'];
    for (const feature of fixture.wasi) {
      args.push('-S', feature);
    }
    args.push('--invoke', invoke, out);
    const run = spawnSync('wasmtime', args, {encoding: 'utf8'});
    if (run.error) {
      fail(`wasmtime not runnable: ${run.error.message}`);
      break;
    }
    if (run.status !== 0) {
      fail(`${invoke} exited ${run.status}:\n${run.stderr}`);
      continue;
    }
    const actual = run.stdout.trim().split('\n').at(-1) ?? '';
    if (expect !== '*' && actual !== expect) {
      fail(`${invoke} returned ${actual}, expected ${expect}`);
      continue;
    }
    console.log(`  ${GREEN}✓${NC} ${invoke} => ${actual}`);
  }
}

if (failed) {
  console.error(`\n${RED}Component end-to-end tests failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}Component end-to-end tests passed${NC}`);
