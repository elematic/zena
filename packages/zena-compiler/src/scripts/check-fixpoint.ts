/**
 * The self-hosted compiler must reproduce itself byte for byte.
 *
 * A, B and C are all the same program — the self-hosted compiler, built from
 * the current source. They differ only in *which compiler built them*:
 *
 *   A  built by the seed (today the bootstrap compiler; after retirement, a
 *      checked-in cli.wasm)
 *   B  built by A
 *   C  built by B
 *
 * **The invariant is B ≡ C.** A and B differ, because the seed's codegen is
 * not the self-hosted compiler's; that is expected and not checked. B and C,
 * though, are produced by compilers built from the same source, so they must
 * emit identical bytes. A difference means the compiler miscompiles itself.
 *
 * That is a blind spot for the rest of the suite, which exercises the
 * compiler's output on other programs rather than on itself.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');

const entry = join('zena', 'cli', 'main.zena');
const stageBRel = join('zena', 'out', 'cli-self.wasm');
const stageCRel = join('zena', 'out', 'cli-self2.wasm');
const stageB = join(pkgDir, stageBRel);
const stageC = join(pkgDir, stageCRel);

/**
 * Which compiler `zena-cli` uses, defined in packages/zena-cli/src/main.rs —
 * a path to a .wasm, defaulting to zena/out/cli.wasm (stage A).
 */
const COMPILER_ENV = 'ZENA_COMPILER_WASM';

const build = (out: string, compiler: string | null) =>
  execFileSync(zenaCli, ['-g', 'build', entry, '-o', out], {
    cwd: pkgDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      ...(compiler === null ? {} : {[COMPILER_ENV]: compiler}),
      ZENA_GC_RESERVE_MB: process.env.ZENA_GC_RESERVE_MB ?? '1536',
    },
  });

try {
  statSync(stageB);
} catch {
  console.error(`✗ stage B is missing: ${stageB}`);
  console.error(
    '  run `npm run build:self-hosted -w @zena-lang/zena-compiler`',
  );
  process.exit(1);
}

// This whole check rests on zena-cli honouring COMPILER_ENV. If it ever stops
// doing so, stage C would be built by the default compiler — which is stage A,
// whose output *is* stage B — and the comparison below would pass while
// testing nothing. Prove the variable still takes effect before relying on it:
// point it somewhere that does not exist and require the build to fail.
try {
  build(stageC, join('zena', 'out', 'definitely-not-a-compiler.wasm'));
  console.error(`✗ ${COMPILER_ENV} is being ignored by zena-cli.`);
  console.error(
    '  A build with a nonexistent compiler path succeeded, so stage C',
  );
  console.error(
    '  would be built by the default compiler and this check would',
  );
  console.error(
    '  compare stage B against itself. See packages/zena-cli/src/main.rs.',
  );
  process.exit(1);
} catch {
  // Expected: zena-cli rejects a compiler path that does not exist.
}

console.log('Building stage C (stage B building the compiler)...');
try {
  build(stageC, stageBRel);
} catch (e) {
  const err = e as {stdout?: unknown; stderr?: unknown};
  console.error(
    '✗ stage C failed to build — stage B cannot build the compiler',
  );
  for (const stream of [err.stdout, err.stderr]) {
    if (stream != null && String(stream).trim() !== '') {
      console.error(String(stream).replace(/^/gm, '  '));
    }
  }
  process.exit(1);
}

const b = readFileSync(stageB);
const c = readFileSync(stageC);

if (b.equals(c)) {
  console.log('✔ fixpoint holds: stage B ≡ stage C');
  process.exit(0);
}

console.error('✗ FIXPOINT BROKEN: stage B ≢ stage C');
console.error('');
console.error(
  '  Stage B and stage C are built from the same source by compilers',
);
console.error(
  '  that are themselves built from the same source, so they should be',
);
console.error(
  '  identical. A difference means the compiler miscompiles itself.',
);
console.error('');
console.error(`  stage B  ${stageB}`);
console.error(`  stage C  ${stageC}`);

if (b.length === c.length) {
  let first = -1;
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== c[i]) {
      first = i;
      break;
    }
  }
  console.error(`  same length; first differing byte at offset ${first}`);
} else {
  console.error(`  lengths differ by ${Math.abs(b.length - c.length)} bytes`);
}
console.error('');
console.error(
  '  To investigate: `wasm-tools objdump` both to find which section',
);
console.error('  moved, then `wasm-tools print` and diff.');
process.exit(1);
