import {createServer} from 'node:http';

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const config = JSON.parse(await readStdin());
const expectedPath = `/v1/${config.secret}`;
const responseBody = JSON.stringify({
  ACTIONS_RESULTS_URL: config.url,
  ACTIONS_RUNTIME_TOKEN: config.token,
});

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === expectedPath) {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(responseBody)),
      'cache-control': 'no-store',
    });
    res.end(responseBody);
    return;
  }
  res.writeHead(404, {'content-type': 'text/plain'});
  res.end('not found');
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({port})}\n`);
});
