## atproto

### Added

- `atproto/oauth`: signing in with atproto OAuth as a public client. `startAuthorization` pushes the authorization request with PKCE and a DPoP key made for the session, `finishAuthorization` trades the code for tokens, and `OAuthSession` signs every request to the PDS, follows the servers' nonces, refreshes its token when the PDS says it is no longer valid, revokes it, and is kept as JSON.
- `atproto/dpop`: DPoP (RFC 9449) keys, ES256 proofs and their verification, and JWK thumbprints.
- `XrpcClient.signer`, a `RequestSigner` that authorizes each request on its own and can have it sent again.
- `AccountSession`, which `Session` and `OAuthSession` implement, and which `getServiceAuth` takes.

## package-manager

### Added

- `testing/fake-oauth`: an authorization server for the fake PDS, which signs in with OAuth without a browser. The fake PDS takes DPoP-bound tokens for `getServiceAuth` and `putRecord`, as far as their scope allows.
