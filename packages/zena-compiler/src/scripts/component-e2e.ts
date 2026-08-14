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
  /** Lines the program itself must have printed, in order, before it. */
  expectOutput?: string[];
  /** Milliseconds the call must take at least. */
  minWallMs?: number;
  /**
   * The most CPU the call may burn, as a fraction of its wall time.
   *
   * This is the assertion the timer fixture exists for. A regression
   * from a real timer back to a blocking or spinning wait keeps the wall
   * time and shows up only as a test that eats a core, so wall time
   * alone would not notice it.
   */
  maxCpuFraction?: number;
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
    name: 'strings',
    wasi: [],
    // The first type that is not a flat scalar: bytes in linear memory,
    // lifted through the canonical options and a synthesized wrapper.
    // `main()` is here to prove the scalar path still works alongside.
    invocations: [
      {invoke: 'main()', expect: '0'},
      // Host writes, guest reads.
      {invoke: 'measure("hello")', expect: '5'},
      // Guest writes, host reads — a literal, so the bytes come out of
      // the shared string segment rather than being built.
      {invoke: 'shout()', expect: '"HELLO FROM A COMPONENT"'},
      // Both directions, with an allocation between them.
      {invoke: 'greet("world")', expect: '"hello, world"'},
      // Length zero: the pointer half of the pair is never dereferenced.
      {invoke: 'nothing()', expect: '""'},
      // An empty string *argument* is the dangerous one. The host lowers
      // it through `realloc(0, 0, 1, 0)`, which returns `align` — an
      // aligned address that was never allocated. Releasing the argument
      // buffer on `ptr != 0` rather than `len > 0` would hand that to
      // `free`, which would walk into a block header that is not there;
      // `greet` then allocates for its result out of the corrupted list.
      {invoke: 'greet("")', expect: '"hello, "'},
      {invoke: 'measure("")', expect: '0'},
    ],
  },
  {
    name: 'print',
    wasi: [],
    // The first component that prints: `zena:console` over p2
    // `wasi:cli/stdout` and `wasi:io/streams`, with the write's
    // lowering carrying the canonical memory options and the bytes
    // landing in the runtime memory module's pages. Two stdout lines,
    // because the second proves the delegated free list survived the
    // first; the stderr line proves the two streams are distinct.
    invocations: [
      {
        invoke: 'main()',
        expect: '0',
        expectOutput: [
          'hello from a component',
          'the free list survived the first write',
        ],
      },
    ],
  },
  {
    name: 'timer-print',
    wasi: ['p3=y'],
    // Both WASI generations in one component: the sleep is a p3
    // async-lowered import, the prints are p2 stdio, and the second
    // line is written after the host re-entered through the async
    // callback — the combination 1.4 verified by hand, as a regression
    // test.
    invocations: [
      {
        invoke: 'run()',
        expect: '()',
        expectOutput: ['before the sleep', 'after the sleep'],
        minWallMs: 40,
      },
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
  {
    name: 'timer',
    wasi: ['p3=y'],
    // The entry is lifted async with a callback, so `run` is the
    // component's name for it rather than `main`. It returns nothing:
    // the guest hands control back to the host while the timer runs.
    invocations: [
      {
        invoke: 'run()',
        expect: '()',
        minWallMs: 250,
        maxCpuFraction: 0.5,
      },
    ],
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

  for (const {
    invoke,
    expect,
    expectOutput,
    minWallMs,
    maxCpuFraction,
  } of fixture.invocations) {
    const flags = ['-W', 'gc=y,function-references=y,exceptions=y'];
    for (const feature of fixture.wasi) {
      flags.push('-S', feature);
    }
    // Through `time -p` (POSIX, so the format is fixed) rather than
    // spawnSync directly: Node reports no CPU time for a child, and CPU
    // time is what tells a timer apart from a spin.
    const command = `time -p wasmtime run ${flags.join(' ')} --invoke '${invoke}' '${out}'`;
    const run = spawnSync('bash', ['-c', command], {encoding: 'utf8'});
    if (run.error) {
      fail(`could not run wasmtime: ${run.error.message}`);
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
    if (expectOutput) {
      const lines = run.stdout.split('\n');
      let from = 0;
      let missing = false;
      for (const wanted of expectOutput) {
        const found = lines.indexOf(wanted, from);
        if (found < 0) {
          fail(`${invoke} did not print '${wanted}':\n${run.stdout}`);
          missing = true;
          break;
        }
        from = found + 1;
      }
      if (missing) {
        continue;
      }
    }

    const timed = (name: string): number => {
      const match = run.stderr.match(new RegExp(`^${name} +([0-9.]+)$`, 'm'));
      if (!match) {
        throw new Error(`no '${name}' line in \n${run.stderr}`);
      }
      return Number(match[1]) * 1000;
    };
    let timing = '';
    if (minWallMs !== undefined || maxCpuFraction !== undefined) {
      const wall = timed('real');
      const cpu = timed('user') + timed('sys');
      timing = ` (${wall.toFixed(0)}ms wall, ${cpu.toFixed(0)}ms cpu)`;
      if (minWallMs !== undefined && wall < minWallMs) {
        fail(
          `${invoke} took ${wall}ms, expected at least ${minWallMs}ms — ` +
            `it did not wait`,
        );
        continue;
      }
      if (maxCpuFraction !== undefined && cpu > wall * maxCpuFraction) {
        fail(
          `${invoke} burned ${cpu}ms of CPU over ${wall}ms of wall time — ` +
            `the guest waited by running rather than by yielding to the host`,
        );
        continue;
      }
    }
    console.log(`  ${GREEN}✓${NC} ${invoke} => ${actual}${timing}`);
  }
}

if (failed) {
  console.error(`\n${RED}Component end-to-end tests failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}Component end-to-end tests passed${NC}`);
