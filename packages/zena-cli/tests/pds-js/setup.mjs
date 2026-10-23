// Prepares pds.js, at the revision docs/design/pds.md pins, for
// `pds-js_test.zena`, and prints `{"dir": ..., "node": ...}`: the checkout,
// and the Node.js to run its server with.
//
//   node packages/zena-cli/tests/pds-js/setup.mjs
//
// The checkout is kept in the cache, `$ZENA_CACHE_DIR/pds.js/<revision>`
// (default `~/.cache/zena`), or is the one `PDS_JS_DIR` names. Fetching it
// needs the network, git and pnpm, which `npx` provides. pnpm runs only
// the build scripts pds.js allows (`onlyBuiltDependencies`), which here is
// better-sqlite3's.
//
// better-sqlite3 12.6, which pds.js locks, does not compile against
// Node.js 26, so the server runs on Node.js 24: `PDS_JS_NODE` if set, else
// `nodejs_24` from nixpkgs.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

const PDS_JS_REVISION = '1bdeef0fc968552e825ece84d0a4893cc073b0d9';
const PDS_JS_REPOSITORY = 'https://tangled.org/chadtmiller.com/pds.js';
const PNPM = 'pnpm@10.7.0';

const cacheDir = () =>
  process.env.ZENA_CACHE_DIR ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'zena');

// Progress goes to stderr; stdout carries only the result.
const run = (command, args, options = {}) =>
  execFileSync(command, args, {stdio: ['ignore', 2, 2], ...options});

const findNode = () => {
  if (process.env.PDS_JS_NODE) {
    return process.env.PDS_JS_NODE;
  }
  return execFileSync('nix', ['shell', 'nixpkgs#nodejs_24', '-c', 'sh', '-c', 'command -v node'], {
    stdio: ['ignore', 'pipe', 2],
    encoding: 'utf8',
  }).trim();
};

const node = findNode();
let dir = process.env.PDS_JS_DIR;
if (!dir) {
  dir = join(cacheDir(), 'pds.js', PDS_JS_REVISION);
  if (!existsSync(join(dir, '.ready'))) {
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dirname(dir), {recursive: true});
      run('git', ['clone', '-q', PDS_JS_REPOSITORY, dir]);
    }
    run('git', ['checkout', '-q', PDS_JS_REVISION], {cwd: dir});
    // pnpm, and the native build it runs, with Node.js 24 first on PATH.
    const env = {...process.env, PATH: `${dirname(node)}:${process.env.PATH}`};
    run('npx', ['-y', PNPM, 'install', '--frozen-lockfile', '--filter', '@pdsjs/node...'],
        {cwd: dir, env});
    run('npx', ['-y', PNPM, 'rebuild', '--filter', '@pdsjs/storage-sqlite',
      '--filter', '@pdsjs/node', 'better-sqlite3'], {cwd: dir, env});
    writeFileSync(join(dir, '.ready'), '');
  }
}
process.stdout.write(`${JSON.stringify({dir, node})}\n`);
