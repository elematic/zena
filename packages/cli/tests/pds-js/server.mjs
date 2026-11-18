// Starts pds.js's Node server with one account, alice.test, and a small
// server beside it that plays the PLC directory and a DNS-over-HTTPS
// resolver for that account. pds.js does not consult the PLC directory to
// adopt an identity, so the account's DID is made up and its document is
// served from what the server knows.
//
//   node server.mjs <pds.js checkout> <directory>
//
// It keeps its data in `<directory>/data`, writes the account, an app
// password for it and the two servers' origins to
// `<directory>/pds-js.json`, and serves until it is killed.
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {mkdirSync, renameSync, writeFileSync} from 'node:fs';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const HANDLE = 'alice.test';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const base58btc = (bytes) => {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
};

/** A new P-256 key: its private scalar in hex, and its public multikey. */
const newKey = () => {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const d = Buffer.from(privateKey.export({format: 'jwk'}).d, 'base64url');
  const {x, y} = publicKey.export({format: 'jwk'});
  const yBytes = Buffer.from(y, 'base64url');
  const compressed = Buffer.concat([
    Buffer.from([yBytes[yBytes.length - 1] & 1 ? 3 : 2]),
    Buffer.from(x, 'base64url'),
  ]);
  // The P-256 multicodec, 0x1200, as a varint.
  const multikey = `z${base58btc(Buffer.concat([Buffer.from([0x80, 0x24]), compressed]))}`;
  return {privateKeyHex: d.toString('hex'), multikey};
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });

const randomDid = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `did:plc:${Array.from(randomBytes(24), (b) => alphabet[b % 32]).join('')}`;
};

const json = async (response) => {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.url}: HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
};

const main = async (pdsJsDir, outDir) => {
  const {createServer} = await import(
    pathToFileURL(join(pdsJsDir, 'packages/node/src/index.js')).href
  );
  const did = randomDid();
  const key = newKey();
  const pdsPort = await freePort();
  const pdsOrigin = `http://127.0.0.1:${pdsPort}`;

  const identity = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://identity');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === `/plc/${did}`) {
      res.end(JSON.stringify({
        id: did,
        alsoKnownAs: [`at://${HANDLE}`],
        verificationMethod: [
          {id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: key.multikey},
        ],
        service: [
          {id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pdsOrigin},
        ],
      }));
    } else if (url.pathname === '/dns-query' && url.searchParams.get('name') === `_atproto.${HANDLE}`) {
      res.end(JSON.stringify({
        Status: 0,
        Answer: [{name: `_atproto.${HANDLE}.`, type: 16, data: `"did=${did}"`}],
      }));
    } else if (url.pathname === '/dns-query') {
      res.end('{"Status":3}');
    } else {
      res.statusCode = 404;
      res.end('{"error":"NotFound"}');
    }
  });
  await new Promise((resolve) => identity.listen(0, '127.0.0.1', resolve));
  const identityOrigin = `http://127.0.0.1:${identity.address().port}`;

  const dataDir = join(outDir, 'data');
  mkdirSync(dataDir, {recursive: true});
  const password = randomBytes(12).toString('hex');
  const pds = await createServer({
    port: pdsPort,
    dbPath: join(dataDir, 'pds.db'),
    blobsDir: join(dataDir, 'blobs'),
    jwtSecret: randomBytes(16).toString('hex'),
    hostname: `127.0.0.1:${pdsPort}`,
    password,
    plcUrl: `${identityOrigin}/plc`,
  });
  await pds.listen();

  await json(await fetch(`${pdsOrigin}/init?did=${did}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({did, privateKey: key.privateKeyHex, handle: HANDLE, password}),
  }));
  const session = await json(await fetch(`${pdsOrigin}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({identifier: did, password}),
  }));
  const appPassword = await json(await fetch(`${pdsOrigin}/xrpc/com.atproto.server.createAppPassword`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${session.accessJwt}`},
    body: JSON.stringify({name: 'zena tests'}),
  }));

  const details = JSON.stringify({
    did,
    handle: HANDLE,
    appPassword: appPassword.password,
    pdsOrigin,
    plcDirectory: `${identityOrigin}/plc`,
    dnsOverHttps: `${identityOrigin}/dns-query`,
  });
  // Written whole, so a reader never sees half of it.
  writeFileSync(join(outDir, 'pds-js.json.partial'), details);
  renameSync(join(outDir, 'pds-js.json.partial'), join(outDir, 'pds-js.json'));
};

main(process.argv[2], process.argv[3]).catch((error) => {
  console.error(error);
  process.exit(1);
});
