#!/usr/bin/env node
/**
 * Round-trip the component encoder through `wasm-tools`.
 *
 * For each fixture in test-files/encoder/, `dev/encode-wit.zena` encodes
 * the named world as a types-only component; the bytes must validate,
 * and `wasm-tools component wit` must print them back as the golden
 * beside the fixture. Only correct type and import sections survive
 * that trip — an off-by-one index or a missing export fails validation,
 * and a wrong type shape prints as the wrong WIT.
 *
 * Goldens are checked in; regenerate with UPDATE_WIT_GOLDENS=1. A
 * `*.error.wit` fixture asserts the encoder *refuses*, with the message
 * fragment listed below.
 */

import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {dirname, join, basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
const fixtureDir = join(pkgDir, 'test-files', 'encoder');
const outDir = join(pkgDir, '.encoder-out');
const driver = 'packages/wit-parser/dev/encode-wit.zena';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const NC = '\x1b[0m';

// On macOS with Nix, tool binaries land in HOST_PATH rather than PATH.
if (process.env.HOST_PATH) {
  process.env.PATH = `${process.env.HOST_PATH}:${process.env.PATH ?? ''}`;
}

/** The world each fixture's encoding is asked for. */
const WORLDS = {
  'shapes.wit': 'shapes',
  'resources.wit': 'store',
  'uses.wit': 'web',
  'wide.wit': 'wide',
  'world-funcs.wit': 'tools',
};

/** What each *.error.wit fixture's failure must mention. */
const ERRORS = {
  'futures.error.wit': 'future and stream',
};

mkdirSync(outDir, {recursive: true});

let failed = false;
const fail = (message) => {
  console.error(`  ${RED}✗${NC} ${message}`);
  failed = true;
};
const ok = (message) => {
  console.log(`  ${GREEN}✓${NC} ${message}`);
};

const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.wit') && !f.endsWith('.golden.wit'))
  .sort();

for (const fixture of fixtures) {
  console.log(fixture);
  const source = join(
    'packages',
    'wit-parser',
    'test-files',
    'encoder',
    fixture,
  );
  const isError = fixture.endsWith('.error.wit');
  const world = isError
    ? readFileSync(join(fixtureDir, fixture), 'utf8').match(
        /^world ([a-z-]+)/m,
      )?.[1]
    : WORLDS[fixture];
  if (!world) {
    fail('no world known for this fixture — add it to WORLDS');
    continue;
  }
  // The guest resolves paths through the `.` preopen, so it gets the
  // repo-relative spelling; wasm-tools runs on the host and gets the
  // absolute one.
  const outRel = join(
    'packages',
    'wit-parser',
    '.encoder-out',
    `${basename(fixture, '.wit')}.wasm`,
  );
  const out = join(repoRoot, outRel);

  const run = spawnSync(
    zenaCli,
    ['run', '--dir', '.', driver, source, world, outRel],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      // The binary bakes in the checkout it was built from; a worktree's
      // build still resolves the right root, but say so explicitly.
      env: {...process.env, ZENA_REPO_ROOT: repoRoot},
    },
  );
  if (run.error) {
    fail(`could not run zena-cli: ${run.error.message}`);
    continue;
  }

  if (isError) {
    const expected = ERRORS[fixture];
    const output = `${run.stdout}\n${run.stderr}`;
    if (run.status === 0) {
      fail(`encoded successfully, but must refuse (${expected})`);
    } else if (!output.includes(expected)) {
      fail(`refused without mentioning '${expected}':\n${output}`);
    } else {
      ok(`refused, mentioning '${expected}'`);
    }
    continue;
  }

  if (run.status !== 0) {
    fail(`encoding exited ${run.status}:\n${run.stdout}${run.stderr}`);
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
  ok('validates');

  let printed;
  try {
    printed = execFileSync('wasm-tools', ['component', 'wit', out], {
      encoding: 'utf8',
    });
  } catch (e) {
    fail(`wasm-tools component wit failed:\n${e.stderr ?? e.message}`);
    continue;
  }

  const goldenPath = join(
    fixtureDir,
    `${basename(fixture, '.wit')}.golden.wit`,
  );
  if (process.env.UPDATE_WIT_GOLDENS) {
    writeFileSync(goldenPath, printed);
    ok(`golden updated`);
    continue;
  }
  let golden;
  try {
    golden = readFileSync(goldenPath, 'utf8');
  } catch {
    fail(`no golden at ${goldenPath}; run with UPDATE_WIT_GOLDENS=1`);
    continue;
  }
  if (printed !== golden) {
    fail(
      `round-tripped WIT differs from the golden:\n--- golden\n${golden}\n--- got\n${printed}`,
    );
  } else {
    ok('round-trips to the golden WIT');
  }
}

if (failed) {
  console.error(`\n${RED}Encoder round-trip tests failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}Encoder round-trip tests passed${NC}`);
