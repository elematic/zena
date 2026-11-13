import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const resultsUrl = process.env.ACTIONS_RESULTS_URL ?? '';
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN ?? '';

if (resultsUrl === '' || runtimeToken === '') {
  process.stdout.write(
    '::notice::ACTIONS_RESULTS_URL or ACTIONS_RUNTIME_TOKEN is not set; leaving Zebra on the local disk cache.\n',
  );
  process.exit(0);
}

const secret = randomBytes(16).toString('hex');
process.stdout.write(`::add-mask::${secret}\n`);

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
const child = spawn(process.execPath, [serverPath], {
  detached: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const startup = await new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const newline = stdout.indexOf('\n');
    if (newline >= 0) {
      resolve(JSON.parse(stdout.slice(0, newline)));
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', reject);
  child.on('exit', (code) => {
    reject(
      new Error(
        `custodian exited before reporting its port (code ${String(code)}): ${stderr}`,
      ),
    );
  });
  child.stdin.end(
    JSON.stringify({url: resultsUrl, token: runtimeToken, secret}),
  );
});

child.stdout.destroy();
child.stderr.destroy();
child.unref();

const custodianUrl = `http://127.0.0.1:${String(startup.port)}/v1/${secret}`;
if (process.env.GITHUB_ENV) {
  appendFileSync(
    process.env.GITHUB_ENV,
    `ZEBRA_CACHE=github\nZEBRA_GITHUB_CUSTODIAN_URL=${custodianUrl}\n`,
  );
}
if (process.env.GITHUB_STATE) {
  appendFileSync(process.env.GITHUB_STATE, `pid=${String(child.pid)}\n`);
}
