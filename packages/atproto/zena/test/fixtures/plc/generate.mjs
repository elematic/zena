// Writes operations.json: did:plc genesis operations built, signed and
// hashed by pds.js (its own DAG-CBOR and WebCrypto P-256), for plc_test.
//
//   PDS_JS_DIR=<pds.js checkout> node packages/atproto/zena/test/fixtures/plc/generate.mjs
//
// packages/zena-cli/tests/pds-js/setup.mjs prepares a checkout and prints
// its directory. The signatures are random, so running this again changes
// every operation and DID.
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const pdsJs = process.env.PDS_JS_DIR;
if (!pdsJs) throw new Error('set PDS_JS_DIR to a pds.js checkout');
const load = (path) => import(pathToFileURL(join(pdsJs, path)).href);
const {base32Encode, bytesToHex, generateKeyPair, importPrivateKey} = await load('packages/core/src/crypto.js');
const {buildPlcOperation, publicKeyToDidKey, signPlcOperationObject} = await load('packages/core/src/plc.js');
const {cborEncodeDagCbor} = await load('packages/core/src/repo.js');

const cases = [];
for (const handle of ['router.acme.pkg.zena-lang.dev', 'alice.example.com']) {
  const signing = await generateKeyPair();
  const rotation = await generateKeyPair();
  const operation = buildPlcOperation({
    didKey: publicKeyToDidKey(signing.publicKey),
    handle,
    pdsEndpoint: 'https://pkg.zena-lang.dev',
    rotationKeys: [publicKeyToDidKey(rotation.publicKey), publicKeyToDidKey(signing.publicKey)],
  });
  const signed = await signPlcOperationObject(operation, await importPrivateKey(rotation.privateKey));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', cborEncodeDagCbor(signed)));
  cases.push({
    did: `did:plc:${base32Encode(hash.slice(0, 15))}`,
    rotationPrivateKeyHex: bytesToHex(rotation.privateKey),
    operation: signed,
  });
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'operations.json');
writeFileSync(out, `${JSON.stringify({cases}, null, 2)}\n`);
