// Writes tokens.json: service-auth tokens signed with Node's crypto, an
// ECDSA implementation independent of zena:crypto, for service-auth_test.
//
//   node packages/atproto/zena/test/fixtures/service-auth/generate.mjs
//
// Each key is new, so running it again changes every token.
import {generateKeyPairSync, sign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ORDERS = {
  'P-256': 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
};

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const part = (object) => b64url(Buffer.from(JSON.stringify(object)));
const toHex = (n) => n.toString(16).padStart(64, '0');

/** The 64-byte r || s signature with s in the low half, and its high-S twin. */
const signBoth = (privateKey, curve, data) => {
  const signature = sign('sha256', data, {key: privateKey, dsaEncoding: 'ieee-p1363'});
  const n = ORDERS[curve];
  const r = signature.subarray(0, 32);
  let s = BigInt('0x' + signature.subarray(32).toString('hex'));
  const low = s > n / 2n ? n - s : s;
  const high = n - low;
  return {
    low: Buffer.concat([r, Buffer.from(toHex(low), 'hex')]),
    high: Buffer.concat([r, Buffer.from(toHex(high), 'hex')]),
  };
};

const NOW = 1792800000;
const cases = [];
for (const [curve, alg, nodeCurve] of [
  ['P-256', 'ES256', 'prime256v1'],
  ['secp256k1', 'ES256K', 'secp256k1'],
]) {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: nodeCurve});
  const jwk = publicKey.export({format: 'jwk'});
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const compressed = Buffer.concat([Buffer.from([y[y.length - 1] & 1 ? 3 : 2]), x]);
  const header = part({typ: 'JWT', alg});
  const payload = part({
    iss: 'did:plc:alicealicealicealicealic',
    aud: 'did:web:pkg.zena-lang.dev',
    exp: NOW + 60,
    iat: NOW,
    lxm: 'dev.zena-lang.host.publish',
    jti: '9f2c4e7a1b3d5f60',
  });
  const input = `${header}.${payload}`;
  const {low, high} = signBoth(privateKey, curve, Buffer.from(input));
  cases.push({
    curve,
    publicKeyHex: compressed.toString('hex'),
    token: `${input}.${b64url(low)}`,
    highSToken: `${input}.${b64url(high)}`,
  });
}

const out = join(dirname(fileURLToPath(import.meta.url)), 'tokens.json');
writeFileSync(out, JSON.stringify({now: NOW, cases}, null, 2) + '\n');
