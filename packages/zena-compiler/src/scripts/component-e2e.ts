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

import {execFileSync, spawn, spawnSync} from 'node:child_process';
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
  /** A declared world to compile against: [witFile, worldName]. */
  wit?: [string, string];
  /**
   * Serve `[port, body]` on 127.0.0.1 while the invocations run: a
   * local HTTP server for a fixture whose imports reach the network.
   * A child process, because the runner's own event loop is blocked
   * inside spawnSync while wasmtime runs.
   */
  serve?: [number, string];
  /**
   * Run the component under `wasmtime serve` on 127.0.0.1:port
   * instead of invoking exports: fetch `path` from it and compare the
   * response body to `body`. For a wasi:http service world.
   */
  serveRequest?: [number, string, string];
  /**
   * How many requests to fire at once under `serveRequest`: request
   * `i` asks for `path/i` and expects `body/i`. Default 1.
   */
  serveConcurrent?: number;
  /**
   * Fixtures, built earlier in the list, whose exports satisfy this
   * one's imports: the invocations run the composition of this
   * component with them, wired by `wasm-tools compose`, so a value
   * that crosses between two Zena components is what is tested.
   */
  compose?: string[];
  /** Preopen a scratch directory for the run: `--dir`, for a fixture
   * that imports wasi:filesystem. */
  preopen?: boolean;
  invocations: Invocation[];
}

/** Wait until 127.0.0.1:`port` accepts a connection, or give up. */
const waitForPort = (port: number): boolean => {
  const probe =
    `require('node:net').connect(${port}, '127.0.0.1')` +
    `.on('connect', () => process.exit(0))` +
    `.on('error', () => process.exit(1));`;
  for (let tries = 0; tries < 100; tries++) {
    if (spawnSync('node', ['-e', probe]).status === 0) {
      return true;
    }
    spawnSync('node', ['-e', 'setTimeout(() => {}, 100);']);
  }
  return false;
};

/** Start a one-body HTTP server child and block until it accepts. */
const startServer = (port: number, body: string) => {
  const script =
    `require('node:http').createServer((req, res) => {` +
    `res.writeHead(200, {'content-type': 'text/plain'});` +
    `res.end(${JSON.stringify(body)});` +
    `}).listen(${port}, '127.0.0.1');`;
  const child = spawn('node', ['-e', script], {stdio: 'ignore'});
  const probe =
    `require('node:net').connect(${port}, '127.0.0.1')` +
    `.on('connect', () => process.exit(0))` +
    `.on('error', () => process.exit(1));`;
  for (let tries = 0; tries < 100; tries++) {
    if (spawnSync('node', ['-e', probe]).status === 0) {
      return child;
    }
    spawnSync('node', ['-e', 'setTimeout(() => {}, 100);']);
  }
  child.kill();
  throw new Error(`local server on port ${port} never accepted`);
};

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
    name: 'declared',
    wasi: ['p3=y'],
    wit: ['declared.wit', 'app'],
    // A program compiled against a declared world: the world is the
    // authority (disagreements are compile errors, unit-tested), the
    // component's import surface is the world's, and the wasi WIT the
    // compiler carries satisfies the world's stdio imports without
    // vendoring.
    invocations: [
      {
        invoke: 'main()',
        expect: '0',
        expectOutput: ['declared world says hello'],
      },
      {invoke: 'shout()', expect: '"FROM A DECLARED WORLD"'},
    ],
  },
  {
    name: 'print',
    wasi: ['p3=y'],
    // The first component that prints: `zena:console` over p3
    // `wasi:cli/stdout`, the guest-created `stream<u8>` registered
    // through `write-via-stream` and written with the synchronous
    // `stream.write` builtin, the bytes staged in the runtime memory
    // module's pages. Two stdout lines, because the second proves the
    // delegated free list survived the first; the stderr line proves
    // the two streams are distinct.
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
        invoke: 'main()',
        expect: '()',
        expectOutput: ['before the sleep', 'after the sleep'],
        minWallMs: 40,
      },
    ],
  },
  {
    name: 'rand',
    wasi: ['p3=y'],
    // A marshaling WIT-typed import against real p3 WASI: the
    // `list<u8>` result of `get-random-bytes` is spilled through a
    // return area and lifted by the synthesized wrapper; the printed
    // length proves the lift ran, whatever the bytes were.
    invocations: [
      {
        invoke: 'main()',
        expect: '0',
        expectOutput: ['8'],
      },
    ],
  },
  {
    name: 'pipe',
    wasi: ['p3=y'],
    // A canonical byte stream round trip inside one guest: a
    // `Stream<u8>` lowered to a fresh canonical pair, its readable
    // end lifted back, and the bytes verified after crossing the
    // async `stream.read`/`stream.write` builtins with the driver's
    // event dispatch resuming the blocked pumps. A small read buffer
    // and two writes force partial drains on both sides.
    invocations: [
      {
        invoke: 'main()',
        expect: '()',
        expectOutput: ['round trip ok'],
      },
    ],
  },
  {
    name: 'webget',
    wasi: ['p3=y', 'http=y'],
    // Real p3 wasi:http: the synthesized types/client modules carry a
    // whole GET — Fields and Request resources, a lowered trailers
    // future, bare-result setters, `client.send`, and a response body
    // that is a canonical stream read to EOF — against a local node
    // server the runner starts for the duration.
    serve: [18923, 'hello from the host'],
    invocations: [
      {
        invoke: 'main()',
        expect: '()',
        expectOutput: ['200', 'content-type: text/plain', 'body ok'],
      },
    ],
  },
  {
    name: 'promise',
    wasi: ['p3=y'],
    // A canonical future round trip inside one guest: `future.new`,
    // an async-lowered read parked on the driver, the write resuming
    // it through a FUTURE_READ event, and both ends dropped. The
    // printed value crossed linear memory.
    invocations: [
      {
        invoke: 'main()',
        expect: '()',
        expectOutput: ['42'],
      },
    ],
  },
  {
    name: 'http-service',
    wasi: ['p3=y', 'http=y'],
    wit: ['http-service.wit', 'http-service'],
    // The wasi:http service world: `wasi:http/handler@0.3.0` exported
    // as an instance whose `handle` the program implements, driven by
    // `wasmtime serve`. The request handle lifts into `Request`, the
    // `Outcome<Response, ErrorCode>` lowers into a typed
    // `task.return`, and the body streams out through a canonical
    // stream after the response has been returned.
    serveRequest: [18924, '/greet', 'hello from zena at /greet'],
    serveConcurrent: 4,
    invocations: [],
  },
  {
    name: 'service',
    wasi: ['p3=y'],
    wit: ['service.wit', 'service'],
    // A declared world's async exports with rich types: no main, each
    // export lifted with the callback through the wrapper the compiler
    // writes, its value returned through a `task.return` typed by the
    // WIT — a `result<string, string>` both ways, a string in and out,
    // a scalar — with the lift's and the return's memory options
    // agreeing.
    invocations: [
      {invoke: 'describe(1)', expect: 'ok("one")'},
      {invoke: 'describe(9)', expect: 'err("too big")'},
      {invoke: 'shout("hi")', expect: '"hi!"'},
      {invoke: 'count(41)', expect: '42'},
    ],
  },
  {
    name: 'fs-probe',
    wasi: ['p3=y'],
    preopen: true,
    // Async methods on an imported resource, against real
    // wasi:filesystem: the preopened directory's `get-type` and
    // `stat` are `async func` on the `descriptor` resource; the type
    // comes back as the `descriptor-type` variant's `directory` case.
    invocations: [
      {invoke: 'main()', expect: '0', expectOutput: ['directory true']},
    ],
  },
  {
    name: 'greeter',
    wasi: ['p3=y'],
    wit: ['greeter.wit', 'provider'],
    // Synchronous functions in an exported interface, beside an async
    // one. `count` and `shout` are lifted directly; `describe` and
    // `locate` go through the compiler-written wrapper, `describe`'s
    // `result<string, string>` coming back through a return area the
    // host reads and then releases with `post-return`.
    invocations: [
      {invoke: 'test:greeter/greeter.count@1.0.0(41)', expect: '42'},
      {invoke: 'test:greeter/greeter.shout@1.0.0("hi")', expect: '"hi!"'},
      {invoke: 'test:greeter/greeter.describe@1.0.0(1)', expect: 'ok("one")'},
      {
        invoke: 'test:greeter/greeter.describe@1.0.0(9)',
        expect: 'err("too big")',
      },
      {invoke: 'test:greeter/greeter.locate@1.0.0("two")', expect: 'some(2)'},
      {invoke: 'test:greeter/greeter.locate@1.0.0("nine")', expect: 'none'},
      {invoke: 'test:greeter/greeter.ask@1.0.0(21)', expect: '42'},
    ],
  },
  {
    name: 'params',
    wasi: ['p3=y'],
    wit: ['params.wit', 'provider'],
    // Rich parameters on wrapped exports: lists, tuples, options and
    // results lifted out of the lift's flat core values by the
    // compiler-written wrapper, nested (`list<tuple<u32, string>>`),
    // on an async export too, and `many`, whose seventeen core values
    // the host spills into memory for the wrapper to lift from and
    // free.
    invocations: [
      {invoke: 'total([1, 2, 3])', expect: '6'},
      {invoke: 'window((7, "a"))', expect: '"7:a"'},
      {invoke: 'maybe-name(some("x"))', expect: '"some x"'},
      {invoke: 'maybe-name(none)', expect: '"none"'},
      {invoke: 'check(ok(5))', expect: '"ok 5"'},
      {invoke: 'check(err("bad"))', expect: '"err bad"'},
      {invoke: 'labels([(1, "a"), (2, "b")])', expect: '["1:a", "2:b"]'},
      {invoke: 'tally([4, 5])', expect: '9'},
      {
        invoke:
          'many(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, "z")',
        expect: '"136 z"',
      },
    ],
  },
  {
    name: 'geo-provider',
    wasi: ['p3=y'],
    wit: ['wit-pkg/geo.wit', 'provider'],
    // A Zena provider of the geo fixture's `survey` interface, whose
    // records, variants and enum the interface declares itself: the
    // encoder writes them at component level and the exported
    // instance exports them under their names. Built and validated
    // here; run composed, below.
    invocations: [],
  },
  {
    name: 'geo-wit',
    wasi: ['p3=y'],
    wit: ['wit-pkg/geo.wit', 'consumer'],
    compose: ['geo-provider'],
    // The whole type matrix across a composed boundary with both
    // sides generated: the consumer's `main` calls twelve of the
    // provider's functions with records, variants, enums, options,
    // lists, tuples and results going both ways, and sums what comes
    // back.
    invocations: [{invoke: 'main()', expect: '49'}],
  },
  {
    name: 'compose-provider',
    wasi: ['p3=y'],
    wit: ['compose.wit', 'provider'],
    // The provider half of a composition: it exports the `oracle`
    // interface, whose `ask` answers with a `future<s32>` — the
    // program's `Future<i32>`, lowered by the compiler-written wrapper
    // into a canonical future a background task writes after a
    // sleep. Built and validated here; run composed, below.
    invocations: [],
  },
  {
    name: 'compose-consumer',
    wasi: ['p3=y'],
    wit: ['compose.wit', 'consumer'],
    compose: ['compose-provider'],
    // Two Zena components composed: the consumer imports `oracle`
    // from the provider and awaits the future `ask` returns — a lifted
    // `future<s32>` whose read starts on that await, settled by the
    // other component's task in the other instance. The one place a
    // runtime await of a WIT future is exercised.
    invocations: [
      {
        invoke: 'main()',
        expect: '()',
        expectOutput: ['asked', 'answer 42'],
        minWallMs: 40,
      },
    ],
  },
  {
    name: 'exit-value',
    wasi: ['p3=y'],
    // An async main with a value: the entry is lifted `async func() ->
    // u32`, and the value reaches the host through a typed
    // `task.return` issued from the callback re-entry after the timer
    // fires — not from the call that started main.
    invocations: [{invoke: 'main()', expect: '42'}],
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
    // The entry is lifted async with a callback, still under the name
    // `main`. It returns nothing: the guest hands control back to the
    // host while the timer runs.
    invocations: [
      {
        invoke: 'main()',
        expect: '()',
        minWallMs: 900,
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

  const buildArgs = ['build', source, '--target', 'component', '-o', out];
  if (fixture.wit) {
    // Repo-relative: the compiler resolves the path through its `.`
    // preopen, and zena-cli relativizes only the source file.
    buildArgs.push(
      '--wit',
      join(
        'packages',
        'zena-compiler',
        'test-files',
        'component',
        fixture.wit[0],
      ),
    );
    buildArgs.push('--world', fixture.wit[1]);
  }
  try {
    execFileSync(zenaCli, buildArgs, {
      stdio: 'pipe',
      cwd: repoRoot,
      env,
    });
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

  // What the invocations run: the component itself, or its composition
  // with the fixtures it imports from.
  let runnable = out;
  if (fixture.compose) {
    runnable = join(outDir, `${fixture.name}.composed.wasm`);
    const args = ['compose', out, '-o', runnable];
    for (const dep of fixture.compose) {
      args.push('-d', join(outDir, `${dep}.wasm`));
    }
    // `wasm-tools compose` prints a deprecation notice in favour of
    // `wac`, which the dev shell does not carry; the notice is on
    // stderr and the status says whether the composition happened.
    const composed = spawnSync('wasm-tools', args, {encoding: 'utf8'});
    if (composed.status !== 0) {
      fail(
        `does not compose with ${fixture.compose.join(', ')}:\n${composed.stderr}`,
      );
      continue;
    }
    console.log(`  ${GREEN}✓${NC} composes with ${fixture.compose.join(', ')}`);
  }

  if (fixture.serveRequest) {
    // A service: wasmtime serves it, and the runner is its client.
    const [port, path, body] = fixture.serveRequest;
    const flags = ['-W', 'gc=y,function-references=y,exceptions=y'];
    for (const feature of fixture.wasi) {
      flags.push('-S', feature);
    }
    const served = spawn(
      'wasmtime',
      ['serve', ...flags, '--addr', `127.0.0.1:${port}`, out],
      {stdio: ['ignore', 'ignore', 'pipe']},
    );
    let servedErr = '';
    served.stderr?.on('data', (chunk) => {
      servedErr += chunk.toString();
    });
    if (!waitForPort(port)) {
      served.kill();
      fail(`wasmtime serve never accepted on port ${port}:\n${servedErr}`);
      continue;
    }
    // Through node's own fetch: the CI sandbox has node and nothing
    // else on the path. The requests overlap, so a service whose
    // handler suspends has several tasks in flight in one instance —
    // wasmtime serves a p3 component with up to 128 concurrent calls
    // per instance, and a driver that mixed up two tasks would answer
    // the wrong one or deadlock. They are staggered a little rather
    // than fired together: requests that arrive at the same instant
    // can each get an instance of their own before the first is in
    // the reuse pool, which would test nothing.
    const concurrent = fixture.serveConcurrent ?? 1;
    const client =
      `const urls = Array.from({length: ${concurrent}}, (_, i) => ` +
      `'http://127.0.0.1:${port}${path}' + (${concurrent} > 1 ? '/' + i : ''));` +
      `const pause = (ms) => new Promise((r) => setTimeout(r, ms));` +
      `Promise.all(urls.map((u, i) => pause(i * 20).then(() => ` +
      `fetch(u, {signal: AbortSignal.timeout(10000)})).then((r) => r.text())))` +
      `.then((ts) => process.stdout.write(ts.join('\\n')))` +
      `.catch((e) => { process.stderr.write(String(e)); process.exit(1); });`;
    const fetched = spawnSync('node', ['-e', client], {encoding: 'utf8'});
    served.kill();
    if (fetched.status !== 0) {
      fail(
        `GET ${path} failed: ${fetched.stderr ?? fetched.error}\n${servedErr}`,
      );
      continue;
    }
    const expected = Array.from({length: concurrent}, (_, i) =>
      concurrent > 1 ? `${body}/${i}` : body,
    ).join('\n');
    if (fetched.stdout !== expected) {
      fail(
        `GET ${path} returned '${fetched.stdout}', expected '${expected}'\n${servedErr}`,
      );
      continue;
    }
    console.log(
      `  ${GREEN}✓${NC} GET ${path}${concurrent > 1 ? ` x${concurrent} concurrent` : ''} => '${body}'`,
    );
    continue;
  }

  let server: ReturnType<typeof spawn> | null = null;
  if (fixture.serve) {
    try {
      server = startServer(fixture.serve[0], fixture.serve[1]);
    } catch (e) {
      fail((e as Error).message);
      continue;
    }
  }

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
    if (fixture.preopen) {
      flags.push('--dir', outDir);
    }
    // Through `time -p` (POSIX, so the format is fixed) rather than
    // spawnSync directly: Node reports no CPU time for a child, and CPU
    // time is what tells a timer apart from a spin.
    const command = `time -p wasmtime run ${flags.join(' ')} --invoke '${invoke}' '${runnable}'`;
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

  if (server !== null) {
    server.kill();
  }
}

if (failed) {
  console.error(`\n${RED}Component end-to-end tests failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}Component end-to-end tests passed${NC}`);
