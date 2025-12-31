import {run} from 'node:test';
import {spec} from 'node:test/reporters';
import {glob} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When compiled, this file is at test/run.js, so tests are in the same directory
const testDir = __dirname;

// Get test files from command line args or default to all test files
const args = process.argv.slice(2);
let files: string[];

if (args.length > 0) {
  // Use provided file patterns
  files = args.map((f) => (f.startsWith('/') ? f : join(process.cwd(), f)));
} else {
  // Find all test files
  const pattern = join(testDir, '**/*_test.js');
  files = [];
  for await (const file of glob(pattern)) {
    files.push(file);
  }
}

const stream = run({
  files,
  // Pass experimental flags to test worker subprocesses
  execArgv: ['--enable-source-maps', '--experimental-wasm-exnref'],
});

stream.compose(spec).pipe(process.stdout);

// Only fail on actual test failures, not TODO tests
stream.on('test:fail', (event) => {
  // TODO tests have todo: true, actual failures don't
  if (!event.todo) {
    process.exitCode = 1;
  }
});
